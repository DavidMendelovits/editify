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
 *        └─ any other state ─▶ lease released ─▶ server render, naming the clips that
 *              aren't on this iPhone
 *
 * The lease pins the local copies for the whole run (the copy budget can't evict one
 * mid-export) and is released however the run ends, including a rejected start.
 *
 * TODO(T8): the server fallback still renders the server's copy of the project; it should
 * send a snapshot (revision + hash + plan), check the server has every original first, and
 * offer "upload clips X" when it doesn't (OV1).
 */
import {
  buildRenderPlan, exportPlanSize,
  type AssetMetadata, type PlanAssetInfo, type PlanAssetRef, type PlanResolution, type Project, type RenderPlan,
} from '@editify/shared';
import type { ExportProjectOptions, ExportStateEvent, ExportStateName, NativeExportStats } from '../../modules/editify-engine';
import { leaseMedia, mediaGeometry, mediaKindOf, resolveMedia, type MediaDeps, type MediaGeometry, type ResolvedMedia } from './local-media';

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
   */
  | { kind: 'server'; why: 'no-engine' | 'plan' | 'resolution' | 'missing'; missing: MissingClip[] };

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

/** One short line saying why a render goes to the server; null when there is nothing to say. */
export function serverRouteLine(route: ExportRoute): string | null {
  if (route.kind === 'server' && route.why === 'resolution') return '4K exports render on the server for now.';
  return missingClipsLine(route);
}

/** One short line for a server render caused by missing clips; null otherwise. */
export function missingClipsLine(route: ExportRoute): string | null {
  if (route.kind !== 'server' || route.why !== 'missing' || route.missing.length === 0) return null;
  const names = route.missing.map((clip) => clip.name);
  const listed = names.length <= 3 ? joinNames(names) : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
  return `Renders on the server: ${listed} ${names.length === 1 ? "isn't" : "aren't"} on this iPhone.`;
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
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
    const route = await routeExport(draft, args.deps, args.nameOf, args.resolution);
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
