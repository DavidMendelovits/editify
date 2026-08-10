import type { AssetMetadata, NewProject, Operation, Project } from '@editify/shared';
import type { AgentTraceStep } from './agent';

export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3001').replace(/\/$/, '');

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  ops?: Operation[];
  /** Agent tool-loop steps, persisted with assistant messages. */
  trace?: AgentTraceStep[];
  createdAt: string;
}

export interface ChatResponse { reply: string; trace: AgentTraceStep[]; opsApplied: Operation[]; doc: Project }

/** An entry from `GET /assets/importable` — a file sitting in MEDIA_IMPORT_DIR. */
export interface ImportableFile { name: string; size: number; alreadyImported: boolean }

export interface RenderRecord {
  id: string;
  projectId: string;
  resolution: '720p' | '1080p' | '4k';
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
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
  applyOps: (id: string, ops: Operation[], baseVersion: number) => request<Project>(`/projects/${id}/ops`, {
    method: 'POST', body: JSON.stringify({ ops, baseVersion }),
  }),
  getAsset: (id: string) => request<AssetMetadata>(`/assets/${id}`),
  listImportable: () => request<ImportableFile[]>('/assets/importable'),
  importAsset: (name: string) => request<AssetMetadata>('/assets/import', {
    method: 'POST', body: JSON.stringify({ name }),
  }),
  chat: (id: string, message: string) => request<ChatResponse>(`/projects/${id}/chat`, {
    method: 'POST', body: JSON.stringify({ message }),
  }),
  getChat: (id: string) => request<ChatMessage[]>(`/projects/${id}/chat`),
  render: (id: string, resolution: RenderRecord['resolution']) => request<RenderRecord>(`/projects/${id}/render`, {
    method: 'POST', body: JSON.stringify({ resolution }),
  }),
  getRender: (id: string) => request<RenderRecord>(`/renders/${id}`),
  getStyle: () => request<StyleProfile>('/style-profile'),
  analyzeStyle: (assetIds: string[]) => request<StyleProfile>('/style-profile/analyze', {
    method: 'POST', body: JSON.stringify({ assetIds }),
  }),
};

export async function uploadAsset(asset: { uri: string; name: string; mimeType?: string }): Promise<AssetMetadata> {
  const form = new FormData();
  if (typeof File !== 'undefined' && asset.uri.startsWith('blob:')) {
    const blob = await fetch(asset.uri).then(async (response) => await response.blob());
    form.append('file', new File([blob], asset.name, { type: asset.mimeType ?? blob.type }));
  } else {
    form.append('file', {
      uri: asset.uri,
      name: asset.name,
      type: asset.mimeType ?? 'application/octet-stream',
    } as unknown as Blob);
  }
  const response = await fetch(`${API_URL}/assets`, { method: 'POST', body: form });
  if (!response.ok) throw new Error(await response.text());
  return await response.json() as AssetMetadata;
}
