import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import { parseAnalyzerOutput, type VideoAnalyzer, type VideoAnalysisInput } from '../analyzer.js';
import type { AnalyzerOutput } from '../observation.js';

export interface WebhookAnalyzerOptions {
  url: string;
  /** Sent as `Authorization: Bearer ...` when set. */
  token?: string;
  label?: string;
  version?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Any HTTP service as the watching analyzer. It receives one multipart POST per
 * video with a `video` file part and an `input` JSON part (asset id, duration,
 * dimensions, the ffmpeg metrics) and answers with a JSON body in the analyzer
 * output shape; anything it leaves out stays empty. Build the service in any
 * language, host it anywhere, and point EDITIFY_STYLE_ANALYZER_URL at it.
 */
export class WebhookVideoAnalyzer implements VideoAnalyzer {
  readonly id = 'webhook';
  readonly label: string;
  readonly version: string;
  readonly watches = true;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: WebhookAnalyzerOptions) {
    this.label = options.label ?? 'External analysis service';
    this.version = options.version ?? `1:${options.url}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  availability(): { available: boolean; detail: string } {
    return this.options.url
      ? { available: true, detail: `Posts each video to ${this.options.url}` }
      : { available: false, detail: 'EDITIFY_STYLE_ANALYZER_URL is not set' };
  }

  async analyzeVideo(input: VideoAnalysisInput, signal?: AbortSignal): Promise<AnalyzerOutput> {
    const form = new FormData();
    const { path, ...meta } = input;
    form.append('input', JSON.stringify(meta));
    form.append('video', await openAsBlob(path, { type: input.mimeType }), basename(path));
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 10 * 60 * 1000);
    const response = await this.fetchImpl(this.options.url, {
      method: 'POST',
      headers: this.options.token ? { authorization: `Bearer ${this.options.token}` } : {},
      body: form,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) throw new Error(`Style analysis service failed (${response.status}): ${await response.text()}`);
    const raw = await response.json() as unknown;
    return { watched: true, ...parseAnalyzerOutput(raw), raw };
  }
}
