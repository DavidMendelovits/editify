import { createReadStream, statSync } from 'node:fs';
import { basename } from 'node:path';
import { Readable } from 'node:stream';
import { parseAnalyzerOutput, type VideoAnalyzer, type VideoAnalysisInput } from '../analyzer.js';
import type { AnalyzerOutput } from '../observation.js';

type FetchLike = typeof fetch;

export interface GeminiAnalyzerOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  /** How long to wait for the Files API to finish processing an upload. */
  processingTimeoutMs?: number;
  pollIntervalMs?: number;
}

const PROMPT = `You are an editing analyst. Watch this short-form video and describe its editing pattern as JSON.
Report only what you can see or hear. Keep every string under 120 characters.
Fields: summary (one or two sentences), pacing {averageShotSeconds, cutCount, rhythm: fast-punch|balanced|slow-burn, notes},
hook {durationSeconds, technique, notes}, captions {present, position: top|center|bottom, style, animation, notes},
transitions {dominant, frequency: rare|occasional|constant, notes}, audio {music, soundEffects, voice, notes},
visuals {colorGrade, framing, punchIns, bRoll, notes}, text {overlays, emoji, notes}, tags (up to 8 short labels).`;

/** Gemini's structured-output schema: an OpenAPI subset, so it is written by hand. */
const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING' },
    pacing: { type: 'OBJECT', properties: {
      averageShotSeconds: { type: 'NUMBER' }, cutCount: { type: 'INTEGER' },
      rhythm: { type: 'STRING', enum: ['fast-punch', 'balanced', 'slow-burn'] }, notes: { type: 'STRING' },
    } },
    hook: { type: 'OBJECT', properties: { durationSeconds: { type: 'NUMBER' }, technique: { type: 'STRING' }, notes: { type: 'STRING' } } },
    captions: { type: 'OBJECT', properties: {
      present: { type: 'BOOLEAN' }, position: { type: 'STRING', enum: ['top', 'center', 'bottom'] },
      style: { type: 'STRING' }, animation: { type: 'STRING' }, notes: { type: 'STRING' },
    } },
    transitions: { type: 'OBJECT', properties: {
      dominant: { type: 'STRING' }, frequency: { type: 'STRING', enum: ['rare', 'occasional', 'constant'] }, notes: { type: 'STRING' },
    } },
    audio: { type: 'OBJECT', properties: { music: { type: 'STRING' }, soundEffects: { type: 'STRING' }, voice: { type: 'STRING' }, notes: { type: 'STRING' } } },
    visuals: { type: 'OBJECT', properties: {
      colorGrade: { type: 'STRING' }, framing: { type: 'STRING' }, punchIns: { type: 'BOOLEAN' }, bRoll: { type: 'STRING' }, notes: { type: 'STRING' },
    } },
    text: { type: 'OBJECT', properties: { overlays: { type: 'STRING' }, emoji: { type: 'BOOLEAN' }, notes: { type: 'STRING' } } },
    tags: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['summary', 'tags'],
};

interface GeminiFile { name: string; uri: string; state?: string; mimeType?: string; error?: { message?: string } }

/**
 * Gemini as the watching analyzer, mirroring the prototype's n8n steps: upload
 * the file, wait until it is processed, ask for structured JSON, then delete
 * the upload. Native video understanding means one call covers picture and
 * sound. `fetchImpl` is injectable so the exchange can be tested offline.
 */
export class GeminiVideoAnalyzer implements VideoAnalyzer {
  readonly id = 'gemini';
  readonly label = 'Gemini video understanding';
  readonly version: string;
  readonly watches = true;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly processingTimeoutMs: number;
  private readonly pollIntervalMs: number;

  constructor(private readonly options: GeminiAnalyzerOptions) {
    this.model = options.model ?? 'gemini-3.6-flash';
    this.version = `2:${this.model}`;
    this.baseUrl = (options.baseUrl ?? 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.processingTimeoutMs = options.processingTimeoutMs ?? 5 * 60 * 1000;
    this.pollIntervalMs = options.pollIntervalMs ?? 3000;
  }

  availability(): { available: boolean; detail: string } {
    return this.options.apiKey
      ? { available: true, detail: `Uploads each video to Gemini (${this.model})` }
      : { available: false, detail: 'GEMINI_API_KEY is not set' };
  }

  async analyzeVideo(input: VideoAnalysisInput, signal?: AbortSignal): Promise<AnalyzerOutput> {
    const file = await this.upload(input, signal);
    try {
      const ready = await this.waitUntilActive(file, signal);
      const raw = await this.generate(ready, input, signal);
      return { ...parseAnalyzerOutput(raw), watched: true, raw };
    } finally {
      await this.remove(file).catch(() => undefined);
    }
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}${path.includes('?') ? '&' : '?'}key=${encodeURIComponent(this.options.apiKey)}`;
  }

  private async upload(input: VideoAnalysisInput, signal?: AbortSignal): Promise<GeminiFile> {
    const size = statSync(input.path).size;
    const start = await this.fetchImpl(this.url('/upload/v1beta/files'), {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(size),
        'X-Goog-Upload-Header-Content-Type': input.mimeType,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ file: { display_name: basename(input.path) } }),
      ...(signal ? { signal } : {}),
    });
    if (!start.ok) throw new Error(`Gemini upload start failed (${start.status}): ${await start.text()}`);
    const uploadUrl = start.headers.get('x-goog-upload-url');
    if (!uploadUrl) throw new Error('Gemini upload start returned no upload url');
    const finish = await this.fetchImpl(uploadUrl, {
      method: 'POST',
      headers: {
        'Content-Length': String(size),
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize',
      },
      body: Readable.toWeb(createReadStream(input.path)) as unknown as BodyInit,
      // Node's fetch needs this to stream a request body.
      duplex: 'half',
      ...(signal ? { signal } : {}),
    } as RequestInit);
    if (!finish.ok) throw new Error(`Gemini upload failed (${finish.status}): ${await finish.text()}`);
    const { file } = await finish.json() as { file?: GeminiFile };
    if (!file?.name || !file.uri) throw new Error('Gemini upload returned no file');
    return file;
  }

  private async waitUntilActive(file: GeminiFile, signal?: AbortSignal): Promise<GeminiFile> {
    const deadline = Date.now() + this.processingTimeoutMs;
    let current = file;
    while ((current.state ?? 'PROCESSING') === 'PROCESSING') {
      if (Date.now() > deadline) throw new Error(`Gemini did not finish processing ${file.name} in time`);
      await sleep(this.pollIntervalMs, signal);
      const response = await this.fetchImpl(this.url(`/v1beta/${current.name}`), signal ? { signal } : {});
      if (!response.ok) throw new Error(`Gemini file poll failed (${response.status}): ${await response.text()}`);
      current = await response.json() as GeminiFile;
    }
    if (current.state === 'FAILED') throw new Error(`Gemini could not process the video: ${current.error?.message ?? 'unknown error'}`);
    return current;
  }

  private async generate(file: GeminiFile, input: VideoAnalysisInput, signal?: AbortSignal): Promise<unknown> {
    const response = await this.fetchImpl(this.url(`/v1beta/models/${this.model}:generateContent`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [
          { file_data: { mime_type: file.mimeType ?? input.mimeType, file_uri: file.uri } },
          { text: `${PROMPT}\nffmpeg measured: ${JSON.stringify(input.metrics)}` },
        ] }],
        generationConfig: { response_mime_type: 'application/json', response_schema: RESPONSE_SCHEMA, temperature: 0.2 },
      }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw new Error(`Gemini generateContent failed (${response.status}): ${await response.text()}`);
    const json = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text = json.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? '';
    if (!text.trim()) throw new Error('Gemini returned no content');
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`Gemini returned non-JSON content: ${text.slice(0, 200)}`);
    }
  }

  private async remove(file: GeminiFile): Promise<void> {
    await this.fetchImpl(this.url(`/v1beta/${file.name}`), { method: 'DELETE' });
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error('aborted')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
