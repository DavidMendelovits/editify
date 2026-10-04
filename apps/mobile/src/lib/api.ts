import type {
  AssetAvailability, AssetAvailabilityResponse, AssetDissection, AssetMetadata, LibrarySound, NewProject, Operation, Project, RenderQa,
  RenderSnapshot, SyncAudioResult,
} from '@editify/shared';
import { track } from './event-log';
import type { AgentTraceStep } from './agent';
import type { EditPreset } from './presets';

export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3001').replace(/\/$/, '');

/**
 * True when the API is the dev server on this machine. The server's drop folder
 * and the CLI-backed agents only exist there, so the UI that exposes them is
 * hidden against the hosted backend rather than showing a dead control.
 */
export const IS_LOCAL_API = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(API_URL);

/**
 * The server's shared password (`EDITIFY_TOKEN`), when it has one. Left unset
 * for the web build: that client is served from the API's own origin, so the
 * browser's Basic prompt supplies credentials and nothing has to be baked into
 * a static bundle.
 */
const FALLBACK_TOKEN = process.env.EXPO_PUBLIC_API_TOKEN ?? '';
let accessToken: string = FALLBACK_TOKEN;

const tokenListeners = new Set<() => void>();

/** Keeps every API and media request on the current Supabase session. */
export function setAccessToken(token?: string | null): void {
  const next = token || FALLBACK_TOKEN;
  if (next === accessToken) return;
  accessToken = next;
  for (const listener of tokenListeners) listener();
}

/**
 * Called when the token changes (a refresh, a sign-in): anything holding a media URL minted
 * with the old one (its `k=` query) should mint it again.
 */
export function onAccessTokenChange(listener: () => void): () => void {
  tokenListeners.add(listener);
  return () => { tokenListeners.delete(listener); };
}

function authHeaders(): Record<string, string> {
  return accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
}

/**
 * Media loads go through video/image/audio players that cannot set headers, so
 * the token rides along in the query string instead.
 */
export function mediaUrl(path: string): string {
  if (!accessToken) return `${API_URL}${path}`;
  return `${API_URL}${path}${path.includes('?') ? '&' : '?'}k=${encodeURIComponent(accessToken)}`;
}

/** Anything slower than this is worth a line in the log even when it succeeded. */
const SLOW_REQUEST_MS = 2500;
/**
 * The one endpoint that must never be logged. A failed report would log its own
 * failure, which marks the buffer unsent, which schedules another report: an
 * offline client would sit in a retry loop feeding on its own error lines.
 */
const UNLOGGED = '/telemetry';

/**
 * Every API call the app makes, timed and logged when it goes wrong. A report
 * filed after "it just spins" is unreadable without this: the event log now
 * carries the endpoint, the status, and how long it took.
 */
async function timedFetch(path: string, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? 'GET';
  const logged = !path.startsWith(UNLOGGED);
  const started = Date.now();
  try {
    const response = await fetch(`${API_URL}${path}`, init);
    const elapsed = Date.now() - started;
    if (!logged) return response;
    if (!response.ok) track('api_error', `${method} ${path} → ${response.status} in ${elapsed}ms`);
    else if (elapsed > SLOW_REQUEST_MS) track('api_slow', `${method} ${path} → ${response.status} in ${elapsed}ms`);
    return response;
  } catch (error) {
    // A transport failure never reaches a status code, and it is exactly the
    // case a user describes as the app hanging.
    if (logged) {
      track('api_offline', `${method} ${path} failed after ${Date.now() - started}ms: ${error instanceof Error ? error.message : String(error)}`);
    }
    throw error;
  }
}

/** Plain `fetch` against the API for callers outside `api` — same credentials. */
export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return timedFetch(path, { ...init, headers: { ...authHeaders(), ...init?.headers } });
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  ops?: Operation[];
  /** Agent tool-loop steps, persisted with assistant messages. */
  trace?: AgentTraceStep[];
  /** Checkpoint for this turn's edits — the handle Revert uses. */
  runId?: string;
  /** Server-derived: the turn's operations are no longer standing. */
  reverted?: boolean;
  createdAt: string;
}

export interface ChatResponse { reply: string; trace: AgentTraceStep[]; opsApplied: Operation[]; doc: Project; runId?: string }

/** `POST /projects/:id/chat/improve` — `improved: null` when there was nothing to improve. */
export interface PromptImprovement { improved: string | null; changes?: string[] }

/** `GET /projects/:id/chat/live` — steps of the turn currently running, if any. */
export interface ChatLive { running: boolean; steps: AgentTraceStep[] }

/** An entry from `GET /assets/importable` — a file sitting in MEDIA_IMPORT_DIR. */
export interface ImportableFile { name: string; size: number; alreadyImported: boolean }

export interface RenderRecord {
  id: string;
  projectId: string;
  resolution: '720p' | '1080p' | '4k';
  hdr?: 'sdr' | 'hdr';
  status: 'queued' | 'processing' | 'done' | 'error';
  outputUrl?: string;
  error?: string;
  /** Post-render check: loudness, dead air, sound levels against the voice. */
  qa?: RenderQa;
  contactSheetUrl?: string;
  /** The phone's snapshot this render takes (plan OV1), when it was sent one. */
  snapshot?: { revision: number; hash: string };
}

export interface StyleMetric {
  assetId: string;
  duration: number;
  cutCount: number;
  cutDensity: number;
  averageShotLength: number;
  loudnessLufs: number | null;
  width: number;
  height: number;
  format: string;
}

/**
 * The analyzers' per-video row and the folded template, mirrored loosely from
 * `server/src/style/observation.ts`: the screen only reads a few fields, so the
 * sections stay open-ended here.
 */
export interface VideoObservation {
  assetId: string;
  analyzer: string;
  watched: boolean;
  durationSeconds: number;
  format: '9:16' | '16:9' | '1:1';
  summary: string;
  tags: string[];
  [section: string]: unknown;
}

export interface StyleTemplate {
  videoCount: number;
  watchedCount: number;
  analyzers: string[];
  format: '9:16' | '16:9' | '1:1';
  pacing: { averageShotSeconds: number | null; cutDensity: number | null; rhythm: string | null };
  hook: { durationSeconds: number | null; technique: string | null };
  captions: { presentRatio: number | null; position: string | null; style: string | null; animation: string | null };
  transitions: { dominant: string | null; frequency: string | null };
  audio: { loudnessLufs: number | null; music: string | null; soundEffects: string | null; voice: string | null };
  visuals: { colorGrade: string | null; framing: string | null; punchIns: boolean | null; bRoll: string | null };
  text: { overlays: string | null; emoji: boolean | null };
  tags: Array<{ tag: string; count: number }>;
}

export interface StyleProfile {
  id: string;
  /** Every style is named; older profiles predating names fall back on the server. */
  name: string;
  assetIds: string[];
  metrics: StyleMetric[];
  styleDoc: string;
  createdAt: string;
  /** Which analyzer watched the clips; 'ffmpeg' means measured only. */
  analyzer: string;
  observations: VideoObservation[];
  /** Null on profiles saved before analyzers existed. */
  template: StyleTemplate | null;
}

export type StyleRunStatus = 'idle' | 'processing' | 'error';

export interface StyleAnalyzerOption { id: string; label: string; available: boolean; detail: string; watches: boolean }
export interface StyleAnalyzerStatus { active: string; requested?: string; options: StyleAnalyzerOption[] }

/**
 * `GET /style-profile` flattened: the server answers 200 with the profile (plus
 * the run state) or 404 with just the run state, and analysis runs in the
 * background, so the screen polls this while `status` is 'processing'.
 */
export interface StyleProgress { stage: 'measuring' | 'watching' | 'aggregating' | 'distilling'; done: number; total: number }
export interface StyleState { status: StyleRunStatus; error?: string; progress?: StyleProgress; profile: StyleProfile | null }

/**
 * Local mirror of `assetInsightsSchema` (SPEC-TRANSCRIPT.md §B1) — kept here so
 * the panel does not depend on `@editify/shared` re-exporting it. All times are
 * source-time seconds; `score` is 0–1.
 */
export interface InsightHook { start: number; end: number; text: string; reason: string }
export interface InsightHighlight { start: number; end: number; text: string; score: number; label: string }
export interface AssetInsights {
  assetId: string;
  hook: InsightHook | null;
  highlights: InsightHighlight[];
  summary: string;
  generatedAt: string;
}

/**
 * `GET /assets/:id/waveform` — RMS cells across the whole source, one every
 * `cellSeconds`. `rmsDb` is empty when the asset carries no audio, so the
 * caller draws nothing rather than handling an error.
 */
export interface WaveformEnvelope { cellSeconds: number; rmsDb: number[] }

/**
 * `GET /assets/:id/filmstrip.jpg` — 20 frames tiled 20x1, left→right across
 * `[0, duration]` (SPEC-WAVE3 §B). Built here rather than read off the asset
 * metadata so the timeline can render before the server exposes `filmstripUrl`;
 * the UI falls back to `thumb.jpg` when the request 404s.
 */
export function assetFilmstripUrl(assetId: string): string {
  return mediaUrl(`/assets/${assetId}/filmstrip.jpg`);
}

/** `GET /assets/:id/thumb.jpg` — poster frame, used on project cards. */
export function assetThumbUrl(assetId: string): string {
  return mediaUrl(`/assets/${assetId}/thumb.jpg`);
}

/**
 * `GET /assets/:id/proxy.mp4`, built client-side. The server's `proxyUrl`
 * field is minted from its own PUBLIC_BASE_URL (localhost by default), which a
 * phone cannot reach — every media URL must come from `API_URL` instead.
 */
export function assetProxyUrl(assetId: string): string {
  return mediaUrl(`/assets/${assetId}/proxy.mp4`);
}

/** `GET /assets/:id/original` — sticker images and sound files play from the source. */
export function assetOriginalUrl(assetId: string): string {
  return mediaUrl(`/assets/${assetId}/original`);
}

/** Rebase any server-minted absolute URL (render outputs) onto `API_URL`. */
export function rebaseServerUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return mediaUrl(`${parsed.pathname}${parsed.search}`);
  } catch {
    return url.startsWith('/') ? mediaUrl(url) : url;
  }
}

/** Raw JSON error bodies are illegible in the UI; surface the message inside. */
/** A refused request: the readable message, with the status and the server's `code` when it sent one. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

function failure(status: number, body: string): ApiError {
  let code: string | undefined;
  try {
    const parsed = JSON.parse(body) as { code?: unknown };
    if (typeof parsed.code === 'string') code = parsed.code;
  } catch { /* not JSON */ }
  return new ApiError(describeFailure(status, body), status, code);
}

function describeFailure(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: string };
    if (parsed.error) {
      return status === 409 && parsed.error.startsWith('Version conflict')
        ? 'The project changed underneath this edit. Try again.'
        : parsed.error;
    }
  } catch { /* not JSON — fall through to the raw body */ }
  return body ? `${status}: ${body}` : `Request failed with ${status}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await timedFetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...init?.headers },
  });
  if (!response.ok) {
    throw failure(response.status, await response.text());
  }
  return await response.json() as T;
}

/**
 * `request` for endpoints where "not there" is an ordinary answer: a 404 becomes
 * `null` instead of an error. Covers assets with no insights yet and the preset
 * routes before the server ships them.
 */
async function requestOptional<T>(path: string): Promise<T | null> {
  const response = await timedFetch(path, { headers: { 'Content-Type': 'application/json', ...authHeaders() } });
  if (response.status === 404) return null;
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body ? `${response.status}: ${body}` : `Request failed with ${response.status}`);
  }
  return await response.json() as T;
}

export const api = {
  listProjects: () => request<Project[]>('/projects'),
  createProject: (input: NewProject) => request<Project>('/projects', { method: 'POST', body: JSON.stringify(input) }),
  getProject: (id: string) => request<Project>(`/projects/${id}`),
  /** Answers 204 with no body, so it cannot go through `request`'s JSON parse. */
  deleteProject: async (id: string): Promise<void> => {
    const response = await timedFetch(`/projects/${id}`, { method: 'DELETE', headers: authHeaders() });
    if (!response.ok) throw new Error(describeFailure(response.status, await response.text()));
  },
  /**
   * App Store guideline 5.1.1(v). Erases the caller's rows, media and login;
   * answers 204 with no body, so it cannot go through `request`'s JSON parse.
   */
  deleteAccount: async (): Promise<void> => {
    const response = await timedFetch('/account', { method: 'DELETE', headers: authHeaders() });
    if (!response.ok) throw new Error(describeFailure(response.status, await response.text()));
  },
  applyOps: (id: string, ops: Operation[], baseVersion: number) => request<Project>(`/projects/${id}/ops`, {
    method: 'POST', body: JSON.stringify({ ops, baseVersion }),
  }),
  /** History steps go through the same /ops endpoint, so they queue behind ordinary edits. */
  undo: (id: string, baseVersion: number) => request<Project>(`/projects/${id}/ops`, {
    method: 'POST', body: JSON.stringify({ ops: [{ type: 'undo', params: {} }], baseVersion }),
  }),
  redo: (id: string, baseVersion: number) => request<Project>(`/projects/${id}/ops`, {
    method: 'POST', body: JSON.stringify({ ops: [{ type: 'redo', params: {} }], baseVersion }),
  }),
  /** Whether the editor's undo/redo controls have anything to offer. */
  getHistory: (id: string) => request<{ canUndo: boolean; canRedo: boolean }>(`/projects/${id}/history`),
  getAsset: (id: string) => request<AssetMetadata>(`/assets/${id}`),
  /** This project's media, or every asset the user can see when `projectId` is omitted. Newest first. */
  listAssets: (projectId?: string) => request<AssetMetadata[]>(projectId ? `/assets?projectId=${encodeURIComponent(projectId)}` : '/assets'),
  /** Adopts an asset from another project into this one. */
  linkAsset: (projectId: string, assetId: string) => request<AssetMetadata>(`/assets/${assetId}/link`, {
    method: 'POST', body: JSON.stringify({ projectId }),
  }),
  setAssetLabel: (id: string, label: string) => request<AssetMetadata>(`/assets/${id}`, {
    method: 'PATCH', body: JSON.stringify({ label }),
  }),
  listImportable: () => request<ImportableFile[]>('/assets/importable'),
  importAsset: (name: string, projectId?: string) => request<AssetMetadata>('/assets/import', {
    method: 'POST', body: JSON.stringify(projectId ? { name, projectId } : { name }),
  }),
  chat: (id: string, message: string) => request<ChatResponse>(`/projects/${id}/chat`, {
    method: 'POST', body: JSON.stringify({ message }),
  }),
  /** Rule-based rewrite of a casual message; `improved: null` means send as typed. */
  improvePrompt: (id: string, message: string, previous?: string) =>
    request<PromptImprovement>(`/projects/${id}/chat/improve`, {
      method: 'POST', body: JSON.stringify(previous ? { message, previous } : { message }),
    }),
  getChat: (id: string) => request<ChatMessage[]>(`/projects/${id}/chat`),
  /** Undo a whole agent turn in one step. */
  revertRun: (id: string, runId: string) => request<Project>(`/projects/${id}/runs/${runId}/revert`, { method: 'POST', body: '{}' }),
  getChatLive: (id: string) => request<ChatLive>(`/projects/${id}/chat/live`),
  /** With `snapshot` (renderSnapshot of the screen's document), the server renders exactly that (OV1). */
  render: (
    id: string, resolution: RenderRecord['resolution'], hdr: 'sdr' | 'hdr' = 'sdr', loudness: 'normalize' | 'off' = 'normalize', snapshot?: RenderSnapshot,
  ) => request<RenderRecord>(`/projects/${id}/render`, {
    method: 'POST', body: JSON.stringify({ resolution, hdr, loudness, ...(snapshot ? { snapshot } : {}) }),
  }),
  /** Which originals the server holds, for the server fallback (OV1). */
  assetAvailability: async (id: string, assetIds: string[]): Promise<Record<string, AssetAvailability>> => {
    const { assets } = await request<AssetAvailabilityResponse>(`/projects/${id}/assets/availability`, {
      method: 'POST', body: JSON.stringify({ assetIds }),
    });
    return Object.fromEntries(assets.map((entry) => [entry.id, entry.status]));
  },
  getRender: (id: string) => request<RenderRecord>(`/renders/${id}`),
  /** Measures where an audio clip lines up under the video; never edits. Apply `ops` to commit. */
  syncAudio: (id: string, audioClipId: string, videoClipId?: string) => request<SyncAudioResult>(
    `/projects/${id}/sync?audioClipId=${encodeURIComponent(audioClipId)}${videoClipId ? `&videoClipId=${encodeURIComponent(videoClipId)}` : ''}`,
  ),
  /** `null` while the server-side preset routes are still landing (SPEC-WAVE2 §D). */
  listPresets: () => requestOptional<EditPreset[]>('/presets'),
  /** `null` when the asset has no transcript to analyse yet. */
  getInsights: (assetId: string) => requestOptional<AssetInsights>(`/assets/${assetId}/insights`),
  /** Built-in SFX/music library; entries carry assetIds ready for add_clip. */
  listSounds: () => request<LibrarySound[]>('/sounds'),
  /** ffmpeg dissection of a source video — computed on first request, then cached. */
  dissect: (assetId: string) => request<AssetDissection>(`/assets/${assetId}/dissect`),
  /** Source-wide RMS envelope for the bars drawn inside timeline clips. */
  getWaveform: (assetId: string) => request<WaveformEnvelope>(`/assets/${assetId}/waveform`),
  /** 404 is an ordinary answer — no profile yet — and both codes carry the run state. */
  getStyle: async (): Promise<StyleState> => {
    const response = await timedFetch('/style-profile', { headers: { 'Content-Type': 'application/json', ...authHeaders() } });
    if (!response.ok && response.status !== 404) throw new Error(describeFailure(response.status, await response.text()));
    const body = await response.json() as StyleProfile & { status: StyleRunStatus; error?: string; progress?: StyleProgress };
    return {
      status: body.status,
      ...(body.status === 'error' && body.error ? { error: body.error } : {}),
      ...(body.status === 'processing' && body.progress ? { progress: body.progress } : {}),
      profile: response.status === 404 ? null : body,
    };
  },
  /** 202 — the scan runs in the background; poll `getStyle` for the result. */
  analyzeStyle: (assetIds: string[], options: { name?: string; analyzer?: string; refresh?: boolean } = {}) =>
    request<{ status: StyleRunStatus }>('/style-profile/analyze', {
      method: 'POST', body: JSON.stringify({ assetIds, ...options }),
    }),
  /** Which video analyzer the next "learn my style" run uses, and what else is available. */
  getStyleAnalyzer: () => request<StyleAnalyzerStatus>('/style/analyzer'),
  selectStyleAnalyzer: (analyzer: string) => request<StyleAnalyzerStatus>('/style/analyzer', {
    method: 'PUT', body: JSON.stringify({ analyzer }),
  }),
  /** Every saved style, newest first, plus which one briefs the agent. */
  listStyles: () => request<{ profiles: StyleProfile[]; selectedId: string | null }>('/style-profiles'),
  selectStyle: (id: string) => request<StyleProfile>(`/style-profiles/${id}/select`, { method: 'POST' }),
  renameStyle: (id: string, name: string) => request<StyleProfile>(`/style-profiles/${id}`, {
    method: 'PATCH', body: JSON.stringify({ name }),
  }),
  updateStyleDoc: (id: string, styleDoc: string) => request<StyleProfile>(`/style-profiles/${id}`, {
    method: 'PATCH', body: JSON.stringify({ styleDoc }),
  }),
  duplicateStyle: (id: string) => request<StyleProfile>(`/style-profiles/${id}/duplicate`, { method: 'POST' }),
  deleteStyle: (id: string) => request<{ ok: true; selectedId: string | null }>(`/style-profiles/${id}`, { method: 'DELETE' }),
};

/** Bytes sent so far and the size being sent. Native uploads report as they go; web reports nothing. */
export type UploadBytes = (sent: number, expected: number) => void;

/** `file` is the web pickers' real `File`; native callers only ever have a `uri`. */
export async function uploadAsset(
  asset: { uri: string; name: string; mimeType?: string; projectId?: string; file?: File },
  onBytes?: UploadBytes,
): Promise<AssetMetadata> {
  const isBrowserFile = Boolean(asset.file) || (typeof File !== 'undefined' && asset.uri.startsWith('blob:'));
  if (!isBrowserFile) return await uploadNativeFile(asset, onBytes);
  const form = new FormData();
  if (asset.file) {
    // Hand the picked File straight over so the browser streams it off disk —
    // reading the blob: URI instead buffers the whole clip into memory first.
    form.append('file', asset.file, asset.name);
  } else {
    const blob = await fetch(asset.uri).then(async (response) => await response.blob());
    form.append('file', new File([blob], asset.name, { type: asset.mimeType ?? blob.type }));
  }
  const query = asset.projectId ? `?projectId=${encodeURIComponent(asset.projectId)}` : '';
  const response = await timedFetch(`/assets${query}`, { method: 'POST', body: form, headers: authHeaders() });
  if (!response.ok) throw new Error(await response.text());
  return await response.json() as AssetMetadata;
}

/**
 * React Native's FormData reads the whole file into memory on iOS, so a phone
 * video past a gigabyte or two got the app killed mid-import with no crash
 * report. A binary upload streams the file from disk as the raw request body
 * (POST /assets/raw), and a background session keeps it going if the app is
 * backgrounded.
 */
async function uploadNativeFile(
  asset: { uri: string; name: string; mimeType?: string; projectId?: string },
  onBytes?: UploadBytes,
  target: { path: string; method: 'POST' | 'PUT' } = { path: '/assets/raw', method: 'POST' },
  signal?: AbortSignal,
): Promise<AssetMetadata> {
  // ponytail: SDK 54's File has no upload yet, and the legacy module's .ts source
  // fails this app's exactOptionalPropertyTypes, so the members used are typed here.
  // Swap for `new File(uri).createUploadTask()` once the SDK ships it.
  const { createUploadTask, FileSystemUploadType } = require('expo-file-system/legacy') as {
    createUploadTask: (url: string, fileUri: string, options: {
      httpMethod: 'POST' | 'PUT'; uploadType: number; headers: Record<string, string>;
    }, callback?: (progress: { totalBytesSent: number; totalBytesExpectedToSend: number }) => void) => {
      uploadAsync: () => Promise<{ status: number; body: string } | null | undefined>;
      cancelAsync: () => Promise<void>;
    };
    FileSystemUploadType: { BINARY_CONTENT: number };
  };
  const query = new URLSearchParams({ name: asset.name, ...(asset.projectId ? { projectId: asset.projectId } : {}) });
  const started = Date.now();
  const task = createUploadTask(`${API_URL}${target.path}?${query.toString()}`, asset.uri, {
    httpMethod: target.method,
    uploadType: FileSystemUploadType.BINARY_CONTENT,
    headers: { ...authHeaders(), 'Content-Type': asset.mimeType ?? 'application/octet-stream' },
  }, onBytes ? (progress) => onBytes(progress.totalBytesSent, progress.totalBytesExpectedToSend) : undefined);
  if (signal?.aborted) throw new Error('Upload was cancelled');
  const cancel = (): void => { void task.cancelAsync().catch(() => undefined); };
  signal?.addEventListener('abort', cancel, { once: true });
  let result: { status: number; body: string } | null | undefined;
  try {
    result = await task.uploadAsync();
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
  if (!result || signal?.aborted) throw new Error('Upload was cancelled');
  if (result.status < 200 || result.status >= 300) {
    track('api_error', `${target.method} ${target.path} → ${result.status} in ${Date.now() - started}ms`);
    throw failure(result.status, result.body);
  }
  return JSON.parse(result.body) as AssetMetadata;
}

/**
 * Puts a missing original back on the server under its own asset id (PUT
 * /assets/:id/original, plan OV1), streamed from disk like an import. Native only:
 * the web has no local originals to send.
 */
export async function uploadOriginal(
  assetId: string,
  projectId: string,
  file: { uri: string; name: string; mimeType?: string },
  onBytes?: UploadBytes,
  signal?: AbortSignal,
): Promise<AssetMetadata> {
  return await uploadNativeFile({ ...file, projectId }, onBytes, { path: `/assets/${encodeURIComponent(assetId)}/original`, method: 'PUT' }, signal);
}
