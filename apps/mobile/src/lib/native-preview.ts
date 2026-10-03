/**
 * The native preview's plan feed (plan P5, D1, OV10). Pure logic: the registry, the
 * builder and the native view are passed in, so every branch runs in vitest.
 *
 *   flag (EXPO_PUBLIC_NATIVE_PREVIEW=1) + iOS + the engine's view ─▶ previewRoute 'native'
 *     (anything else, or a native failure, ─▶ 'rn': PreviewPlayer.tsx as before)
 *
 *   project + assets + stage ─▶ previewPlanSize (stage pixels, even, <= 1080 x 1920)
 *     ─▶ resolvePreviewMedia: each plan asset through resolveMedia('preview'):
 *          local / file ─▶ the 1080p proxy when ready, else the original (+ device geometry)
 *          anything else ─▶ the user's server copy (proxy.mp4 for video, the original otherwise)
 *     ─▶ PlanFeeder: buildPreviewPlan (target 'preview', selfCheck off, revision = project
 *          version, buildSeq + 1 per send) ─▶ send(plan, media) ─▶ native setPlan
 *        a burst of edits: the first sends at once, the rest coalesce into one send per window
 *        a handle drag: patchOverlayPlacement on the last plan (the overlay's box only, a
 *          parameter-only update native swaps in place); project rebuilds wait for release
 *
 *   native onError ─▶ MediaRecovery: 'mediaExpired' re-resolves the media (fresh token) and
 *     sends a forced plan; anything else, or a second failure, falls back to PreviewPlayer
 */
import {
  buildRenderPlan, planOverlayLayout,
  type AssetMetadata, type Clip, type OverlayPlacement, type PlanAssetRef, type Project, type RenderPlan,
} from '@editify/shared';
import { assetInfoOf, type GeometryMap } from './device-export';
import { mediaGeometry, mediaKindOf, resolveMedia, type MediaDeps, type MediaGeometry } from './local-media';

// ─── Routing ───

/**
 * The `nativePreview` flag: EXPO_PUBLIC_NATIVE_PREVIEW=1 in the build's environment. Default
 * off until P7's phone numbers pass. Read with a literal `process.env.EXPO_PUBLIC_...` so
 * Expo inlines it.
 */
export const NATIVE_PREVIEW_FLAG = process.env.EXPO_PUBLIC_NATIVE_PREVIEW === '1';

export type PreviewRoute = 'native' | 'rn';

export interface PreviewRouteInput {
  platform: string;
  flag: boolean;
  /** The engine's EditifyPlayerView is in this build. */
  hasView: boolean;
  /** The native preview gave up for this screen (no plan, a source it can't open). */
  fellBack: boolean;
}

/** iOS with the flag and the view, until it falls back: the native preview. Web and everything else: PreviewPlayer. */
export function previewRoute({ platform, flag, hasView, fellBack }: PreviewRouteInput): PreviewRoute {
  return platform === 'ios' && flag && hasView && !fellBack ? 'native' : 'rn';
}

// ─── The plan ───

/** A preview never renders more than this (either orientation); EditifyPlayerView caps it too. */
export const PREVIEW_MAX_LONG = 1920;
export const PREVIEW_MAX_SHORT = 1080;

const ASPECT: Record<Project['format'], number> = { '9:16': 9 / 16, '1:1': 1, '16:9': 16 / 9 };
const even = (value: number): number => Math.max(2, Math.round(value / 2) * 2);

/**
 * The preview plan's output size: the stage in pixels at the project's aspect, even, and no
 * larger than 1080 x 1920. Null until the stage has a size.
 */
export function previewPlanSize(format: Project['format'], stage: { width: number; height: number }, pixelRatio: number): { w: number; h: number } | null {
  if (!(stage.width > 0) || !(stage.height > 0) || !(pixelRatio > 0)) return null;
  const aspect = ASPECT[format];
  const width = Math.min(stage.width, stage.height * aspect) * pixelRatio;
  const height = width / aspect;
  const cap = Math.min(1, PREVIEW_MAX_LONG / Math.max(width, height), PREVIEW_MAX_SHORT / Math.min(width, height));
  // The height follows the rounded width, so the plan keeps the project's aspect exactly where it can.
  const w = even(width * cap);
  return { w, h: even(w / aspect) };
}

export interface PlanOrder { revision: number; buildSeq: number }

/** The builder's view of each clip asset: the server record, with this phone's geometry when known. */
export function previewAssetInfo(assets: Readonly<Record<string, AssetMetadata | undefined>>, geometry: GeometryMap): (id: string) => ReturnType<typeof assetInfoOf> | undefined {
  return (id) => {
    const asset = assets[id];
    return asset ? assetInfoOf(asset, geometry[id]) : undefined;
  };
}

/**
 * The preview plan, or null when the project can't become one yet (an asset still loading, a
 * fractional frame rate). Preview target: SDR, no loudness pass, and no self-check (native
 * enforces the caps on every plan it receives).
 */
export function buildPreviewPlan(
  project: Project, assets: Readonly<Record<string, AssetMetadata | undefined>>, size: { w: number; h: number }, geometry: GeometryMap, order: PlanOrder,
): RenderPlan | null {
  try {
    return buildRenderPlan(project, { kind: 'preview', size, color: 'sdr', loudness: false },
      { revision: order.revision, buildSeq: order.buildSeq, assetInfo: previewAssetInfo(assets, geometry), selfCheck: false });
  } catch {
    return null;
  }
}

/**
 * The last plan with one overlay moved, resized or turned: its box and payload exactly as the
 * next full build will lay them out (planOverlayLayout), nothing else touched, so native swaps
 * it in place. Null when the plan has no such overlay.
 */
export function patchOverlayPlacement(
  plan: RenderPlan, clip: Clip, placement: OverlayPlacement, info: ReturnType<typeof assetInfoOf> | undefined, buildSeq: number,
): RenderPlan | null {
  const index = plan.overlays.findIndex((overlay) => overlay.id === clip.id);
  if (index < 0) return null;
  let layout: ReturnType<typeof planOverlayLayout>;
  try {
    layout = planOverlayLayout({ ...clip, overlay: placement }, plan.size.w, plan.size.h, info);
  } catch {
    return null;
  }
  if (!layout) return null;
  const overlays = plan.overlays.slice();
  overlays[index] = { ...overlays[index]!, ...layout };
  return { ...plan, buildSeq, overlays };
}

// ─── Media ───

export interface PreviewMedia {
  /** Asset id → what native opens: a proxy or original on this phone, or the user's server URL. */
  media: Record<string, string>;
  geometry: GeometryMap;
  /** Ids that resolved to this phone (the lease and proxy-ready events care about these). */
  local: string[];
  /** Ids playing from the server copy. */
  remote: string[];
}

export interface ServerUrls {
  /** `GET /assets/:id/proxy.mp4` with the media token. */
  proxy: (assetId: string) => string;
  /** `GET /assets/:id/original` with the media token. */
  original: (assetId: string) => string;
}

/**
 * Where each plan asset plays from (the media ladder, purpose 'preview'): the 1080p proxy
 * when it is ready, the local original or app copy otherwise, and for anything not on this
 * phone (no row, iCloud, changed in Photos, evicted) the user's server copy.
 */
export async function resolvePreviewMedia(refs: readonly PlanAssetRef[], deps: MediaDeps, server: ServerUrls): Promise<PreviewMedia> {
  const media: Record<string, string> = {};
  const geometry: Record<string, MediaGeometry> = {};
  const local: string[] = [];
  const remote: string[] = [];
  for (const ref of refs) {
    const resolved = await resolveMedia(ref, deps, { purpose: 'preview' });
    if (resolved.state === 'local' || resolved.state === 'file') {
      media[ref.id] = resolved.proxyUri ?? resolved.ref;
      local.push(ref.id);
      if (ref.kind !== 'audio') {
        // The original's stored size and rotation lay the clip out; a proxy has the same aspect.
        const found = await mediaGeometry(resolved, deps);
        if (found) geometry[ref.id] = found;
      }
    } else {
      media[ref.id] = ref.kind === 'video' ? server.proxy(ref.id) : server.original(ref.id);
      remote.push(ref.id);
    }
  }
  return { media, geometry, local, remote };
}

/** No registry on this device: everything plays from the user's server copies. */
export function serverPreviewMedia(refs: readonly PlanAssetRef[], server: ServerUrls): PreviewMedia {
  const media: Record<string, string> = {};
  for (const ref of refs) media[ref.id] = ref.kind === 'video' ? server.proxy(ref.id) : server.original(ref.id);
  return { media, geometry: {}, local: [], remote: refs.map((ref) => ref.id) };
}

/**
 * Every asset the project's clips name, with the kind its plan ref will carry (the asset's
 * own media kind), to lease and resolve before a plan exists. Null while any of them is
 * still loading. A superset of the plan's refs is fine: the media map may hold extras.
 */
export function projectAssetRefs(project: Project, assets: Readonly<Record<string, AssetMetadata | undefined>>): PlanAssetRef[] | null {
  const refs = new Map<string, PlanAssetRef>();
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (!clip.assetId || refs.has(clip.assetId)) continue;
      const asset = assets[clip.assetId];
      if (!asset) return null;
      refs.set(clip.assetId, { id: clip.assetId, kind: mediaKindOf(asset.mimeType, asset.originalName) });
    }
  }
  return [...refs.values()];
}

// ─── The feed ───

export interface FeedInput {
  project: Project;
  assets: Readonly<Record<string, AssetMetadata | undefined>>;
  size: { w: number; h: number };
  media: Record<string, string>;
  geometry: GeometryMap;
}

export interface PlanFeederOptions {
  /** Hands a plan to the native view (setPlan). */
  send: (plan: RenderPlan, media: Record<string, string>) => void;
  /** The project couldn't become a plan. */
  onUnbuildable?: () => void;
  /** Coalescing window for project edits, ms (default 50: a stepper burst sends twice, not ten times). */
  debounceMs?: number;
  build?: typeof buildPreviewPlan;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Turns project changes and handle drags into ordered plans for one native player. buildSeq
 * starts at 1 per feeder: a feeder lives exactly as long as its player view, and native
 * resets its ordering per player instance (render-plan-schema ORDERING).
 */
export class PlanFeeder {
  private seq = 0;
  private input: FeedInput | undefined;
  private current: RenderPlan | undefined;
  private timer: unknown;
  private dirty = false;
  private dragging: string | undefined;
  private disposed = false;
  /** What the last full build sent (a drag clears it: native then holds a patched plan). */
  private signature: string | undefined;
  private readonly options: Required<Omit<PlanFeederOptions, 'onUnbuildable'>> & Pick<PlanFeederOptions, 'onUnbuildable'>;

  constructor(options: PlanFeederOptions) {
    this.options = {
      debounceMs: 50,
      build: buildPreviewPlan,
      setTimer: (run, ms) => setTimeout(run, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      ...options,
    };
  }

  /** The plan most recently sent. */
  get plan(): RenderPlan | undefined { return this.current; }
  get buildSeq(): number { return this.seq; }
  get isDragging(): boolean { return this.dragging !== undefined; }

  /**
   * The project, its assets, the size or the media changed. `force`: send this input's plan even
   * when it matches what native already has (media resolved again after native asked for it:
   * native retries on that plan, whatever its URLs).
   */
  update(input: FeedInput, force = false): void {
    if (this.disposed) return;
    this.input = input;
    if (force) this.signature = undefined;
    if (this.dragging !== undefined || this.timer !== undefined) {
      this.dirty = true;
      return;
    }
    this.flush();
    this.arm();
  }

  /**
   * A handle moved: the last plan with that overlay re-laid out, sent at once (a
   * parameter-only update). Project rebuilds wait until endDrag. Returns the plan sent.
   */
  drag(clip: Clip, placement: OverlayPlacement): RenderPlan | undefined {
    if (this.disposed || !this.current || !this.input) return undefined;
    this.dragging = clip.id;
    const info = clip.assetId ? this.infoOf(clip.assetId) : undefined;
    const patched = patchOverlayPlacement(this.current, clip, placement, info, this.seq + 1);
    if (!patched) return undefined;
    this.seq += 1;
    this.current = patched;
    this.signature = undefined;
    // Native now holds a position the project may never get (a cancelled drag): the project's
    // plan goes again when the drag ends.
    this.dirty = true;
    this.options.send(patched, this.input.media);
    return patched;
  }

  /**
   * The drag ended. Committed (a set_overlay is being painted): the project's plan follows
   * after the coalescing window, so the painted placement is what it sends. Not committed
   * (cancelled, a tap, back where it started): the project's plan goes now, taking native back
   * off the dragged position.
   */
  endDrag(committed: boolean): void {
    if (this.dragging === undefined) return;
    this.dragging = undefined;
    if (!this.dirty) return;
    if (this.timer !== undefined) this.options.clearTimer(this.timer);
    this.timer = undefined;
    if (committed) {
      this.arm();
      return;
    }
    this.flush();
    this.arm();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) this.options.clearTimer(this.timer);
    this.timer = undefined;
  }

  private infoOf(assetId: string): ReturnType<typeof assetInfoOf> | undefined {
    const input = this.input;
    return input ? previewAssetInfo(input.assets, input.geometry)(assetId) : undefined;
  }

  private flush(): void {
    this.dirty = false;
    const input = this.input;
    if (!input) return;
    const plan = this.options.build(input.project, input.assets, input.size, input.geometry, { revision: input.project.version, buildSeq: this.seq + 1 });
    if (!plan) {
      this.options.onUnbuildable?.();
      return;
    }
    // The same pixels and sources as what native has (a server confirming a painted edit, an
    // asset poll): nothing to send, and no needless swap on the playing item.
    const signature = JSON.stringify([{ ...plan, revision: 0, buildSeq: 0 }, input.media]);
    if (signature === this.signature) return;
    this.signature = signature;
    this.seq += 1;
    this.current = plan;
    this.options.send(plan, input.media);
  }

  /** The coalescing window: changes inside it send once, when it closes. */
  private arm(): void {
    this.timer = this.options.setTimer(() => {
      this.timer = undefined;
      if (this.disposed || !this.dirty || this.dragging !== undefined) return;
      this.flush();
      this.arm();
    }, this.options.debounceMs);
  }
}

// ─── Native failures ───

export interface MediaRecoveryOptions {
  /** Refresh the auth token if it expired, resolve the media again, and send a plan with it (forced). */
  reresolve: () => void;
  /** Give up on the native preview: the editor falls back to PreviewPlayer. */
  fallback: (reason: string) => void;
  /** How long native may take to apply a plan after a re-resolve before this gives up, ms (default 15 s). */
  timeoutMs?: number;
  /** Another expiry this soon after a recovery began falls back instead of looping, ms (default 30 s). */
  minIntervalMs?: number;
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * What a native error means. `mediaExpired` (an item playing the user's server copies failed,
 * most often an expired `k=` token after the app was in the background): resolve the media
 * again instead of falling back; native rebuilds on the plan that follows, and reports a
 * plain error if that fails too. Anything else, an expiry while a recovery is under way or
 * soon after one, or a recovery whose plan never lands: fall back to PreviewPlayer.
 *
 *   onError(mediaExpired) ─▶ reresolve() ─▶ onPlan(update | rebuild) ─▶ done
 *                                       └─▶ no plan within timeoutMs ─▶ fallback
 *   onError(anything else) ─▶ fallback
 */
export class MediaRecovery {
  private recovering = false;
  private startedAt: number | undefined;
  private timer: unknown;
  private disposed = false;
  private readonly options: Required<MediaRecoveryOptions>;

  constructor(options: MediaRecoveryOptions) {
    this.options = {
      timeoutMs: 15_000,
      minIntervalMs: 30_000,
      now: () => Date.now(),
      setTimer: (run, ms) => setTimeout(run, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      ...options,
    };
  }

  get isRecovering(): boolean { return this.recovering; }

  /** A native onError. `hasRemote`: the media in use includes the user's server copies. */
  onError(event: { message: string; code?: string }, hasRemote: boolean): void {
    if (this.disposed) return;
    const now = this.options.now();
    const recent = this.startedAt !== undefined && now - this.startedAt < this.options.minIntervalMs;
    if (event.code === 'mediaExpired' && hasRemote && !this.recovering && !recent) {
      this.recovering = true;
      this.startedAt = now;
      this.timer = this.options.setTimer(() => {
        this.timer = undefined;
        if (this.disposed || !this.recovering) return;
        this.recovering = false;
        this.options.fallback(`native: media expired, and no plan with new media landed (${event.message})`);
      }, this.options.timeoutMs);
      this.options.reresolve();
      return;
    }
    this.stop();
    this.options.fallback(`native: ${event.message}`);
  }

  /** A native onPlan: a plan applied after a re-resolve ends the recovery (native retries on it). */
  onPlan(mode: string): void {
    if (this.recovering && mode !== 'failed') this.stop();
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }

  private stop(): void {
    this.recovering = false;
    if (this.timer !== undefined) this.options.clearTimer(this.timer);
    this.timer = undefined;
  }
}

// ─── The plan the handles draw from ───

/**
 * The last plan sent, as a tiny external store: a drag sends 60 plans a second, and only the
 * handles (which draw from it) should re-render for each, not the whole preview.
 */
export interface PlanStore {
  get: () => RenderPlan | undefined;
  set: (plan: RenderPlan) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createPlanStore(): PlanStore {
  let current: RenderPlan | undefined;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set: (plan) => {
      current = plan;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

/** `scheme://host[:port]` of a URL (RN's URL class has no `origin`), or null. */
export function urlOrigin(url: string): string | null {
  return /^(https?:\/\/[^/?#]+)/i.exec(url)?.[1] ?? null;
}

// ─── Logging ───

/** Text safe to log or send as telemetry: any media token (a `k=` query, see api.ts mediaUrl) blanked. */
export function redactMediaToken(text: string): string {
  return text.replace(/([?&]k=)[^&\s"')]*/g, '$1[redacted]');
}

// ─── The clock ───

/**
 * Whether a native time event moves the playhead. While playing, the native player is the
 * clock (its time events replace usePlayback's rAF loop). While paused the playhead is the
 * user's (taps, scrubs): native only follows it, so its seek landings never pull it back.
 */
export function followsNativeTime(event: { playing: boolean }, hostPlaying: boolean): boolean {
  return event.playing && hostPlaying;
}

/** A playhead change the native player didn't report: the user moved it, so native must seek. */
export function isExternalSeek(playhead: number, lastReported: number | undefined): boolean {
  return lastReported === undefined || Math.abs(playhead - lastReported) > 1e-6;
}
