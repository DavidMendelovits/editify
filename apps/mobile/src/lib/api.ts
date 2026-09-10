import type { AssetDissection, AssetMetadata, LibrarySound, NewProject, Operation, Project } from '@editify/shared';
import type { AgentTraceStep } from './agent';
import type { EditPreset } from './presets';

export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3001').replace(/\/$/, '');

/**
 * The server's shared password (`EDITIFY_TOKEN`), when it has one. Left unset
 * for the web build: that client is served from the API's own origin, so the
 * browser's Basic prompt supplies credentials and nothing has to be baked into
 * a static bundle.
 */
const FALLBACK_TOKEN = process.env.EXPO_PUBLIC_API_TOKEN ?? '';
let accessToken: string = FALLBACK_TOKEN;

/** Keeps every API and media request on the current Supabase session. */
export function setAccessToken(token?: string | null): void {
  accessToken = token || FALLBACK_TOKEN;
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

/** Plain `fetch` against the API for callers outside `api` — same credentials. */
export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API_URL}${path}`, { ...init, headers: { ...authHeaders(), ...init?.headers } });
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

export type AgentProviderId = 'claude-cli' | 'codex-cli' | 'anthropic' | 'openai' | 'mock';

export interface ProviderOption {
  id: AgentProviderId;
  label: string;
  available: boolean;
  /** How it runs, or what is missing — shown under the option. */
  detail: string;
}

export interface ProviderStatus {
  active: AgentProviderId;
  /** Present when the saved choice is no longer usable and something else is running. */
  requested?: AgentProviderId;
  options: ProviderOption[];
}

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

export interface StyleProfile {
  id: string;
  assetIds: string[];
  metrics: StyleMetric[];
  styleDoc: string;
  createdAt: string;
}

export type StyleRunStatus = 'idle' | 'processing' | 'error';

/**
 * `GET /style-profile` flattened: the server answers 200 with the profile (plus
 * the run state) or 404 with just the run state, and analysis runs in the
 * background, so the screen polls this while `status` is 'processing'.
 */
export interface StyleState { status: StyleRunStatus; error?: string; profile: StyleProfile | null }

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
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...init?.headers },
  });
  if (!response.ok) {
    throw new Error(describeFailure(response.status, await response.text()));
  }
  return await response.json() as T;
}

/**
 * `request` for endpoints where "not there" is an ordinary answer: a 404 becomes
 * `null` instead of an error. Covers assets with no insights yet and the preset
 * routes before the server ships them.
 */
async function requestOptional<T>(path: string): Promise<T | null> {
  const response = await fetch(`${API_URL}${path}`, { headers: { 'Content-Type': 'application/json', ...authHeaders() } });
  if (response.status === 404) return null;
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body ? `${response.status}: ${body}` : `Request failed with ${response.status}`);
  }
  return await response.json() as T;
}

export const api = {
  getAgentProvider: () => request<ProviderStatus>('/agent/provider'),
  setAgentProvider: (provider: AgentProviderId) => request<ProviderStatus>('/agent/provider', {
    method: 'PUT', body: JSON.stringify({ provider }),
  }),
  listProjects: () => request<Project[]>('/projects'),
  createProject: (input: NewProject) => request<Project>('/projects', { method: 'POST', body: JSON.stringify(input) }),
  getProject: (id: string) => request<Project>(`/projects/${id}`),
  /** Answers 204 with no body, so it cannot go through `request`'s JSON parse. */
  deleteProject: async (id: string): Promise<void> => {
    const response = await fetch(`${API_URL}/projects/${id}`, { method: 'DELETE', headers: authHeaders() });
    if (!response.ok) throw new Error(describeFailure(response.status, await response.text()));
  },
  applyOps: (id: string, ops: Operation[], baseVersion: number) => request<Project>(`/projects/${id}/ops`, {
    method: 'POST', body: JSON.stringify({ ops, baseVersion }),
  }),
  getAsset: (id: string) => request<AssetMetadata>(`/assets/${id}`),
  /** This project's media, or every asset on the server when `projectId` is omitted. Newest first. */
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
  render: (id: string, resolution: RenderRecord['resolution'], hdr: 'sdr' | 'hdr' = 'sdr') => request<RenderRecord>(`/projects/${id}/render`, {
    method: 'POST', body: JSON.stringify({ resolution, hdr }),
  }),
  getRender: (id: string) => request<RenderRecord>(`/renders/${id}`),
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
    const response = await fetch(`${API_URL}/style-profile`, { headers: { 'Content-Type': 'application/json', ...authHeaders() } });
    if (!response.ok && response.status !== 404) throw new Error(describeFailure(response.status, await response.text()));
    const body = await response.json() as StyleProfile & { status: StyleRunStatus; error?: string };
    return {
      status: body.status,
      ...(body.status === 'error' && body.error ? { error: body.error } : {}),
      profile: response.status === 404 ? null : body,
    };
  },
  /** 202 — the scan runs in the background; poll `getStyle` for the result. */
  analyzeStyle: (assetIds: string[]) => request<{ status: StyleRunStatus }>('/style-profile/analyze', {
    method: 'POST', body: JSON.stringify({ assetIds }),
  }),
};

/** `file` is the web pickers' real `File`; native callers only ever have a `uri`. */
export async function uploadAsset(asset: { uri: string; name: string; mimeType?: string; projectId?: string; file?: File }): Promise<AssetMetadata> {
  const form = new FormData();
  if (asset.file) {
    // Hand the picked File straight over so the browser streams it off disk —
    // reading the blob: URI instead buffers the whole clip into memory first.
    form.append('file', asset.file, asset.name);
  } else if (typeof File !== 'undefined' && asset.uri.startsWith('blob:')) {
    const blob = await fetch(asset.uri).then(async (response) => await response.blob());
    form.append('file', new File([blob], asset.name, { type: asset.mimeType ?? blob.type }));
  } else {
    form.append('file', {
      uri: asset.uri,
      name: asset.name,
      type: asset.mimeType ?? 'application/octet-stream',
    } as unknown as Blob);
  }
  const query = asset.projectId ? `?projectId=${encodeURIComponent(asset.projectId)}` : '';
  const response = await fetch(`${API_URL}/assets${query}`, { method: 'POST', body: form, headers: authHeaders() });
  if (!response.ok) throw new Error(await response.text());
  return await response.json() as AssetMetadata;
}
