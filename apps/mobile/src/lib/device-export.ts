/**
 * On-device export routing and state (plan P4, 3A + OV1). Pure logic: the registry and
 * the native engine are passed in, so every branch runs in vitest.
 *
 *   project + assets ─▶ buildRenderPlan (target export: size from the resolution, colour from
 *                       the HDR choice, loudness from its toggle)
 *   press export ─▶ 4K? ─▶ server ("4K exports render on the server for now", until P7)
 *     ─▶ lease every plan asset ─▶ resolveMedia(purpose export) for each
 *        ├─ all 'local' / 'file' ─▶ their geometry (stored size + rotation, from the device:
 *        │     the server's records have no rotation) ─▶ plan rebuilt with it ─▶ native
 *        │     exportProject(plan, media refs) ─▶ exportState events ─▶ exportReducer
 *        │     ─▶ done / failed / cancelled ─▶ lease released
 *        └─ any other state ─▶ lease released ─▶ the server path below
 *
 *   server path (OV1) ─▶ POST /projects/:id/assets/availability for every asset the document names
 *     ├─ all present ─▶ 'ready': server render of the snapshot (renderSnapshot: revision + hash + document)
 *     ├─ some missing, each one on this iPhone (app copy, Photos original, iCloud) ─▶ 'upload':
 *     │     "Upload X and Y to export" ─▶ uploadMissing (only those, leased, temp files removed)
 *     │     ─▶ route again ─▶ 'ready'
 *     ├─ a missing one isn't here either (or changed in Photos), or another account's ─▶ 'blocked',
 *     │     named plainly ("X isn't on this iPhone or the server")
 *     └─ the check failed (offline) ─▶ 'unchecked': the render may still be asked for; the
 *           server checks the snapshot again and names what is missing
 *
 * The lease pins the local copies for the whole run (the copy budget can't evict one
 * mid-export) and is released however the run ends, including a rejected start.
 */
import {
  buildRenderPlan, exportPlanSize, projectAssetIds,
  type AssetAvailability, type AssetMetadata, type PlanAssetInfo, type PlanAssetRef, type PlanResolution, type Project, type RenderPlan,
} from '@editify/shared';
import type { ExportProjectOptions, ExportStateEvent, ExportStateName, NativeExportStats } from '../../modules/editify-engine';
import {
  downloadMedia, leaseMedia, mediaGeometry, mediaKindOf, resolveMedia, type MediaDeps, type MediaGeometry, type ResolvedMedia,
} from './local-media';
import type { ImportProgress } from './upload-progress';

/**
 * Resolutions the phone exports itself. 4K goes to the server until its memory is
 * measured on a phone (plan P7); add '4k' here to flip it.
 */
export const DEVICE_EXPORT_RESOLUTIONS: ReadonlySet<PlanResolution> = new Set<PlanResolution>(['720p', '1080p']);

/** Asset id → its geometry on this phone. */
export type GeometryMap = Readonly<Record<string, MediaGeometry>>;

// ─── The plan ───

/**
 * What the builder needs about one asset: the server's record, with the stored size and
 * rotation from this phone when known (the server keeps the coded size and no rotation,
 * so a portrait phone clip would otherwise be laid out landscape).
 */
export function assetInfoOf(asset: AssetMetadata, geometry?: MediaGeometry): PlanAssetInfo {
  const kind = mediaKindOf(asset.mimeType, asset.originalName);
  const info: PlanAssetInfo = {
    kind,
    width: geometry?.width ?? asset.width,
    height: geometry?.height ?? asset.height,
    duration: kind === 'image' ? 0 : asset.duration,
    hasAudio: asset.hasAudio,
    animated: asset.mimeType === 'image/gif' || /\.gif$/i.test(asset.originalName),
  };
  if (geometry && geometry.rotation !== 0) info.rotation = geometry.rotation;
  if (asset.fps > 0) info.fps = asset.fps;
  return info;
}

export interface ExportChoices {
  resolution: PlanResolution;
  hdr: 'sdr' | 'hdr';
  loudness: 'normalize' | 'off';
}

let buildSeq = 0;

/**
 * The export plan for the current project, or null when the project can't become one
 * (an asset the server doesn't list, a fractional frame rate): those go to the server.
 */
export function buildExportPlan(project: Project, assets: readonly AssetMetadata[], choices: ExportChoices, geometry: GeometryMap = {}): RenderPlan | null {
  const info = new Map(assets.map((asset) => [asset.id, assetInfoOf(asset, geometry[asset.id])]));
  buildSeq += 1;
  try {
    return buildRenderPlan(project, {
      kind: 'export',
      size: exportPlanSize(project.format, choices.resolution),
      color: choices.hdr === 'hdr' ? 'hlg' : 'sdr',
      loudness: choices.loudness === 'normalize',
    }, { revision: project.version, buildSeq, assetInfo: (id) => info.get(id) });
  } catch {
    return null;
  }
}

/** Every asset the plan draws or plays, once each, in plan order. */
export function planAssetRefs(plan: RenderPlan): PlanAssetRef[] {
  const refs = new Map<string, PlanAssetRef>();
  const add = (ref: PlanAssetRef): void => { if (!refs.has(ref.id)) refs.set(ref.id, ref); };
  for (const segment of plan.video.segments) for (const layer of segment.layers) add(layer.assetRef);
  for (const overlay of plan.overlays) if (overlay.media) add(overlay.media.assetRef);
  for (const entry of plan.audio) add(entry.assetRef);
  return [...refs.values()];
}

// ─── Routing ───

export interface MissingClip { assetId: string; name: string; reason: string }

export type ExportRoute =
  | { kind: 'device'; media: Record<string, string>; geometry: GeometryMap }
  /**
   * `no-engine`: web, Android, a build without the engine. `plan`: the project couldn't
   * become a plan. `resolution`: not a DEVICE_EXPORT_RESOLUTIONS one. `missing`: clips aren't here.
   * `server`: what the server holds, when it was asked (routeExport's `server` argument).
   */
  | { kind: 'server'; why: 'no-engine' | 'plan' | 'resolution' | 'missing'; missing: MissingClip[]; server?: ServerReadiness };

/** A clip the server is missing that this iPhone can upload. */
export interface UploadClip { assetId: string; kind: PlanAssetRef['kind']; name: string }

/** A clip no server render can have: not on the server, and not uploadable from here. */
export interface BlockedClip { assetId: string; name: string; reason: 'not-here' | 'changed' | 'absent' | 'forbidden' }

/** Whether a server render of the snapshot can run (OV1). */
export type ServerReadiness =
  | { state: 'ready' }
  | { state: 'upload'; clips: UploadClip[] }
  | { state: 'blocked'; clips: BlockedClip[] }
  /** The availability check itself failed (offline, server down); the render request rechecks. */
  | { state: 'unchecked'; error: string };

/** POST /projects/:id/assets/availability, as a status per id. */
export type AvailabilityCheck = (assetIds: string[]) => Promise<Record<string, AssetAvailability>>;

export interface ServerCheck {
  /** Every asset the document names (the server checks the whole snapshot, not only the plan's). */
  refs: PlanAssetRef[];
  check: AvailabilityCheck;
}

/** Every asset the project names, with its kind from the server's record ('video' when unknown). */
export function projectAssetRefs(project: Project, assets: readonly AssetMetadata[]): PlanAssetRef[] {
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  return projectAssetIds(project).map((id) => {
    const asset = byId.get(id);
    return { id, kind: asset ? mediaKindOf(asset.mimeType, asset.originalName) : 'video' };
  });
}

function missingReason(media: Exclude<ResolvedMedia, { state: 'local' | 'file' }>): string {
  switch (media.state) {
    case 'icloud': return 'in iCloud';
    case 'changed': return 'changed in Photos';
    case 'server':
      switch (media.reason) {
        case 'evicted': return 'removed to save space';
        case 'deleted': return 'deleted from Photos';
        case 'limited': case 'denied': return 'no Photos access';
        case 'no-space': return 'not kept, phone was full';
        default: return 'not on this iPhone';
      }
  }
}

/**
 * Where this plan can render: here when the resolution is one the phone exports and every
 * asset resolves to a local original or app copy (with its geometry read on the way).
 */
export async function routeExport(
  plan: RenderPlan | null, deps: MediaDeps | null, nameOf: (assetId: string) => string, resolution?: PlanResolution, server?: ServerCheck,
): Promise<ExportRoute> {
  const route = await routeLocally(plan, deps, nameOf, resolution);
  if (route.kind === 'device' || !server) return route;
  return { ...route, server: await serverReadiness(server, deps, nameOf) };
}

async function routeLocally(
  plan: RenderPlan | null, deps: MediaDeps | null, nameOf: (assetId: string) => string, resolution?: PlanResolution,
): Promise<ExportRoute> {
  if (!deps) return { kind: 'server', why: 'no-engine', missing: [] };
  if (resolution && !DEVICE_EXPORT_RESOLUTIONS.has(resolution)) return { kind: 'server', why: 'resolution', missing: [] };
  if (!plan) return { kind: 'server', why: 'plan', missing: [] };
  const media: Record<string, string> = {};
  const geometry: Record<string, MediaGeometry> = {};
  const missing: MissingClip[] = [];
  for (const ref of planAssetRefs(plan)) {
    const resolved = await resolveMedia(ref, deps, { purpose: 'export' });
    if (resolved.state === 'local' || resolved.state === 'file') {
      media[ref.id] = resolved.ref;
      if (ref.kind !== 'audio') {
        const found = await mediaGeometry(resolved, deps);
        if (found) geometry[ref.id] = found;
      }
    } else {
      missing.push({ assetId: ref.id, name: nameOf(ref.id), reason: missingReason(resolved) });
    }
  }
  return missing.length > 0 ? { kind: 'server', why: 'missing', missing } : { kind: 'device', media, geometry };
}

/**
 * What the server holds of the document's media. Missing originals this iPhone has (an app
 * copy, a Photos original that still matches, one in iCloud) can be uploaded; one that
 * isn't here either, changed in Photos, or belongs to another account blocks the render.
 */
export async function serverReadiness(server: ServerCheck, deps: MediaDeps | null, nameOf: (assetId: string) => string): Promise<ServerReadiness> {
  if (server.refs.length === 0) return { state: 'ready' };
  let statuses: Record<string, AssetAvailability>;
  try {
    statuses = await server.check(server.refs.map((ref) => ref.id));
  } catch (error) {
    return { state: 'unchecked', error: error instanceof Error ? error.message : String(error) };
  }
  const blocked: BlockedClip[] = [];
  const uploads: UploadClip[] = [];
  for (const ref of server.refs) {
    // An id the answer leaves out is treated as missing: the render would refuse it.
    const status = statuses[ref.id] ?? 'missing';
    if (status === 'present') continue;
    const name = nameOf(ref.id);
    if (status === 'forbidden' || status === 'absent') {
      // Absent: the server has no such asset, so an upload under its id has nothing to restore.
      blocked.push({ assetId: ref.id, name, reason: status });
      continue;
    }
    const local = deps ? await resolveMedia(ref, deps, { purpose: 'export' }) : null;
    if (local && (local.state === 'file' || local.state === 'local' || local.state === 'icloud')) uploads.push({ assetId: ref.id, kind: ref.kind, name });
    else blocked.push({ assetId: ref.id, name, reason: local?.state === 'changed' ? 'changed' : 'not-here' });
  }
  if (blocked.length > 0) return { state: 'blocked', clips: blocked };
  return uploads.length > 0 ? { state: 'upload', clips: uploads } : { state: 'ready' };
}

/** Whether the server render can be asked for now (ready, or the check couldn't run). */
export function serverRenderable(route: ExportRoute | undefined): boolean {
  if (!route || route.kind !== 'server') return false;
  return !route.server || route.server.state === 'ready' || route.server.state === 'unchecked';
}

/** One short line saying why a render goes to the server, or what it needs first; null when there is nothing to say. */
export function serverRouteLine(route: ExportRoute): string | null {
  if (route.kind === 'server' && route.server?.state === 'upload') return uploadLine(route.server.clips);
  if (route.kind === 'server' && route.server?.state === 'blocked') return blockedLine(route.server.clips);
  if (route.kind === 'server' && route.why === 'resolution') return '4K exports render on the server for now.';
  return missingClipsLine(route);
}

/** "Upload "a" and "b" to export." */
export function uploadLine(clips: readonly UploadClip[]): string {
  return `Upload ${listNames(clips.map((clip) => clip.name))} to export.`;
}

/** One sentence per reason: "X isn't on this iPhone or the server." */
export function blockedLine(clips: readonly BlockedClip[]): string {
  const sentence = (reason: BlockedClip['reason'], one: string, many: string): string | null => {
    const names = clips.filter((clip) => clip.reason === reason).map((clip) => clip.name);
    if (names.length === 0) return null;
    return `${listNames(names)} ${names.length === 1 ? one : many}.`;
  };
  return [
    sentence('not-here', "isn't on this iPhone or the server", "aren't on this iPhone or the server"),
    sentence('changed', "changed in Photos and isn't on the server", "changed in Photos and aren't on the server"),
    sentence('absent', "isn't on the server. Import it again to export", "aren't on the server. Import them again to export"),
    sentence('forbidden', 'belongs to another account', 'belong to another account'),
  ].filter((line) => line !== null).join(' ');
}

function listNames(names: string[]): string {
  return names.length <= 3 ? joinNames(names) : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

/** One short line for a server render caused by missing clips; null otherwise. */
export function missingClipsLine(route: ExportRoute): string | null {
  if (route.kind !== 'server' || route.why !== 'missing' || route.missing.length === 0) return null;
  const names = route.missing.map((clip) => clip.name);
  return `Renders on the server: ${listNames(names)} ${names.length === 1 ? "isn't" : "aren't"} on this iPhone.`;
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// ─── Uploading what the server is missing (OV1) ───

/** One original as this iPhone holds it: a file:// URI, its real file name and media type. */
export interface OriginalFile { assetId: string; uri: string; name: string; mimeType?: string }

/** Sends one original to PUT /assets/:id/original; aborting `signal` cancels the transfer. */
export type UploadOriginal = (file: OriginalFile, onBytes: (sent: number, expected: number) => void, signal?: AbortSignal) => Promise<void>;

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  mov: 'video/quicktime', mp4: 'video/mp4', m4v: 'video/x-m4v', webm: 'video/webm',
  m4a: 'audio/mp4', aac: 'audio/aac', mp3: 'audio/mpeg', wav: 'audio/wav', caf: 'audio/x-caf', aif: 'audio/aiff', aiff: 'audio/aiff',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', heic: 'image/heic', webp: 'image/webp',
};

/** The media type a file name's extension says, or undefined for one this table doesn't know. */
export function mimeTypeOf(name: string): string | undefined {
  const extension = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase();
  return extension ? MIME_BY_EXTENSION[extension] : undefined;
}

/** The name an app copy was imported under: its file name without the copy's "<uuid>-" prefix. */
export function copyFileName(uri: string): string {
  const base = decodeURIComponent(uri.slice(uri.lastIndexOf('/') + 1));
  return base.replace(/^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}-/, '') || base;
}

export interface UploadMissingArgs {
  clips: readonly UploadClip[];
  deps: MediaDeps;
  upload: UploadOriginal;
  onProgress?: (progress: ImportProgress) => void;
  signal?: AbortSignal;
}

export interface UploadMissingResult {
  uploaded: string[];
  failed: Array<{ assetId: string; name: string; error: string }>;
}

/**
 * Uploads only `clips`, one at a time, from what this iPhone holds: the app copy as it
 * is, a Photos original written to a temporary file first (removed afterwards, however
 * the upload ends), an iCloud one downloaded and checked first. Every clip stays leased
 * until the last upload ends, so the copy budget can't evict one mid-upload. One failure
 * doesn't stop the rest; aborting skips the clips not started.
 */
export async function uploadMissing(args: UploadMissingArgs): Promise<UploadMissingResult> {
  const { deps } = args;
  const lease = leaseMedia(deps, args.clips.map((clip) => clip.assetId));
  const result: UploadMissingResult = { uploaded: [], failed: [] };
  const sent = args.clips.map(() => 0);
  const sizes = args.clips.map(() => 0);
  let done = 0;
  const report = (): void => args.onProgress?.({
    done,
    total: args.clips.length,
    sentBytes: sent.reduce((sum, bytes) => sum + bytes, 0),
    totalBytes: sizes.every((size) => size > 0) ? sizes.reduce((sum, size) => sum + size, 0) : 0,
  });
  try {
    report();
    for (const [index, clip] of args.clips.entries()) {
      if (args.signal?.aborted) {
        result.failed.push({ assetId: clip.assetId, name: clip.name, error: 'Cancelled' });
        continue;
      }
      let temporary: string | undefined;
      try {
        let media: ResolvedMedia = await resolveMedia({ id: clip.assetId, kind: clip.kind }, deps, { purpose: 'export' });
        if (media.state === 'icloud') media = await downloadMedia(media, deps, args.signal ? { signal: args.signal } : {});
        let file: OriginalFile;
        if (media.state === 'file') {
          const name = copyFileName(media.ref);
          file = { assetId: clip.assetId, uri: media.ref, name, ...withMime(name) };
        } else if (media.state === 'local') {
          const written = await deps.native.exportOriginal(media.ref);
          temporary = written.uri;
          const name = written.name || copyFileName(written.uri);
          file = { assetId: clip.assetId, uri: written.uri, name, ...withMime(name) };
        } else {
          throw new Error(media.state === 'changed' ? 'It changed in Photos' : media.state === 'icloud' ? 'Waiting for iCloud' : 'It isn\'t on this iPhone');
        }
        await args.upload(file, (bytes, expected) => {
          sent[index] = bytes;
          if (expected > 0) sizes[index] = expected;
          report();
        }, args.signal);
        result.uploaded.push(clip.assetId);
      } catch (error) {
        result.failed.push({ assetId: clip.assetId, name: clip.name, error: error instanceof Error ? error.message : String(error) });
      } finally {
        if (temporary) {
          try { deps.native.removeFile(temporary); } catch { /* a temp file the system clears anyway */ }
        }
        done += 1;
        report();
      }
    }
  } finally {
    lease.release();
  }
  return result;
}

function withMime(name: string): { mimeType?: string } {
  const mimeType = mimeTypeOf(name);
  return mimeType ? { mimeType } : {};
}

// ─── State ───

export interface DeviceExportView {
  id?: string;
  state: ExportStateName | 'starting';
  progress: number;
  mode?: 'background' | 'foreground';
  notice?: string;
  error?: string;
  fileUri?: string;
  savedToPhotos?: boolean;
  stats?: NativeExportStats;
}

export const STARTING: DeviceExportView = { state: 'starting', progress: 0 };

export function isTerminal(state: DeviceExportView['state']): boolean {
  return state === 'done' || state === 'failed' || state === 'cancelled';
}

/**
 * Folds `exportState` events into what the screen shows. Events for another export and
 * anything after a terminal state are dropped; within one state progress never moves back
 * (events can arrive late), and a new state starts from its own progress.
 */
export function exportReducer(view: DeviceExportView, event: ExportStateEvent): DeviceExportView {
  if (view.id !== undefined && event.id !== view.id) return view;
  if (isTerminal(view.state)) return view;
  const progress = Number.isFinite(event.progress) ? Math.min(1, Math.max(0, event.progress)) : 0;
  const next: DeviceExportView = {
    ...view,
    id: event.id,
    state: event.state,
    progress: event.state === view.state ? Math.max(view.progress, progress) : progress,
  };
  if (event.mode) next.mode = event.mode;
  if (event.notice) next.notice = event.notice;
  if (event.state === 'done') {
    next.progress = 1;
    if (event.fileUri) next.fileUri = event.fileUri;
    next.savedToPhotos = event.savedToPhotos ?? false;
    if (event.stats) next.stats = event.stats;
  }
  if (event.state === 'failed') next.error = event.error ?? 'The export failed';
  return next;
}

/** A label per state, for the progress card. */
export function exportStateLabel(view: DeviceExportView): string {
  switch (view.state) {
    case 'starting': return 'Starting';
    case 'queued': return 'Waiting to start';
    case 'resolving': return 'Preparing clips';
    case 'measuring': return 'Measuring loudness';
    case 'writing': return `Rendering ${Math.round(view.progress * 100)}%`;
    case 'saving': return 'Saving to Photos';
    case 'done': return view.savedToPhotos ? 'Saved to Photos' : 'Ready to share';
    case 'failed': return 'Export failed';
    case 'cancelled': return 'Cancelled';
  }
}

// ─── Running it ───

/** The slice of the engine an export uses (EditifyEngine on iOS; a fake in tests). */
export interface ExportNative {
  exportProject(planJson: string, options: ExportProjectOptions): Promise<string>;
  cancelExport(id: string): void;
  addListener(event: 'exportState', listener: (event: ExportStateEvent) => void): { remove(): void };
}

export type DeviceExportOutcome =
  | { kind: 'device'; view: DeviceExportView }
  | { kind: 'server'; route: Extract<ExportRoute, { kind: 'server' }> };

export interface ExportOnDeviceArgs {
  /** Builds the plan with the device geometry found so far (empty for the draft that names the assets). */
  build: (geometry: GeometryMap) => RenderPlan | null;
  resolution?: PlanResolution;
  deps: MediaDeps;
  native: ExportNative;
  nameOf: (assetId: string) => string;
  destination?: 'photos' | 'file';
  onUpdate: (view: DeviceExportView) => void;
  /** Aborting cancels the export (queued or running). */
  signal?: AbortSignal;
  /** Asked when the route turns out to be the server's, so the outcome says what the server holds. */
  server?: ServerCheck;
}

/**
 * Leases the plan's media, resolves it, rebuilds the plan with the device's geometry, and
 * either runs the export here (resolving to its terminal view) or answers the server route
 * (a clip isn't on this phone, 4K, no plan). The lease is released on every path.
 */
export async function exportOnDevice(args: ExportOnDeviceArgs): Promise<DeviceExportOutcome> {
  const draft = args.build({});
  if (!draft) return { kind: 'server', route: { kind: 'server', why: 'plan', missing: [] } };
  const lease = leaseMedia(args.deps, planAssetRefs(draft).map((ref) => ref.id));
  try {
    const route = await routeExport(draft, args.deps, args.nameOf, args.resolution, args.server);
    if (route.kind === 'server') return { kind: 'server', route };
    // Same assets, now laid out with each one's real stored size and rotation. Never fall
    // back to the draft silently: it would lay rotated clips out sideways.
    const plan = Object.keys(route.geometry).length > 0 ? args.build(route.geometry) : draft;
    if (!plan || !sameAssets(draft, plan)) {
      console.warn('device export: the plan rebuilt with device geometry names other assets than its draft; rendering on the server');
      return { kind: 'server', route: { kind: 'server', why: 'plan', missing: [] } };
    }
    return { kind: 'device', view: await runNativeExport(args, plan, route.media) };
  } finally {
    lease.release();
  }
}

/** The same asset refs (id and kind), in any order. */
export function sameAssets(a: RenderPlan, b: RenderPlan): boolean {
  const key = (plan: RenderPlan): string => planAssetRefs(plan).map((ref) => `${ref.kind}:${ref.id}`).sort().join('\n');
  return key(a) === key(b);
}

async function runNativeExport(args: ExportOnDeviceArgs, plan: RenderPlan, media: Record<string, string>): Promise<DeviceExportView> {
  let view: DeviceExportView = STARTING;
  args.onUpdate(view);
  let id: string | undefined;
  // Events can land before exportProject answers the id: hold them until it does.
  const early: ExportStateEvent[] = [];
  let settle: (final: DeviceExportView) => void = () => undefined;
  const finished = new Promise<DeviceExportView>((resolve) => { settle = resolve; });
  const apply = (event: ExportStateEvent): void => {
    if (event.id !== id) return;
    const next = exportReducer(view, event);
    if (next === view) return;
    view = next;
    args.onUpdate(view);
    if (isTerminal(view.state)) settle(view);
  };
  const subscription = args.native.addListener('exportState', (event) => {
    if (id === undefined) early.push(event);
    else apply(event);
  });
  const abort = (): void => { if (id !== undefined) args.native.cancelExport(id); };
  args.signal?.addEventListener('abort', abort, { once: true });
  try {
    id = await args.native.exportProject(JSON.stringify(plan), { media, destination: args.destination ?? 'photos' });
    view = { ...view, id };
    for (const event of early.splice(0)) apply(event);
    if (args.signal?.aborted) args.native.cancelExport(id);
    return await finished;
  } catch (error) {
    view = { ...view, state: 'failed', progress: 0, error: error instanceof Error ? error.message : String(error) };
    args.onUpdate(view);
    return view;
  } finally {
    subscription.remove();
    args.signal?.removeEventListener('abort', abort);
  }
}
