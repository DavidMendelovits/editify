import { mediaSlots, type MediaSlots, type SlotOptions } from './media-slots.js';

export type MediaJobKind = 'probe' | 'proxy' | 'thumbnail' | 'transcribe' | 'faces' | 'energy' | 'waveform' | 'sync' | 'render';

export interface MediaJobIds {
  assetId?: string;
  projectId?: string;
  renderId?: string;
}

/**
 * The one line every background media job logs when it finishes, so a slow
 * import or render can be read off the logs:
 * `{ msg: 'media job', job, assetId?, projectId?, renderId?, ms, waitMs, ok }`.
 * `ms` is the job's own wall time; `waitMs` is how long it queued for its turn
 * (a media slot, or the sync service's own one-at-a-time queue), 0 if none.
 */
export interface MediaJobLine extends MediaJobIds {
  job: MediaJobKind;
  ms: number;
  waitMs: number;
  ok: boolean;
}

/** The slice of a pino logger this needs; `app.log` fits. */
export interface MediaJobLogger {
  info(fields: object, msg: string): void;
}

let logger: MediaJobLogger | undefined;

/**
 * Services are built without a request in hand, so the app hands its logger
 * over once here. Unset (scripts, most tests), the lines are dropped.
 */
export function setMediaJobLogger(next: MediaJobLogger | undefined): void {
  logger = next;
}

function logJob(line: MediaJobLine): void {
  const { job, assetId, projectId, renderId, ms, waitMs, ok } = line;
  logger?.info({
    job,
    ...(assetId === undefined ? {} : { assetId }),
    ...(projectId === undefined ? {} : { projectId }),
    ...(renderId === undefined ? {} : { renderId }),
    ms,
    waitMs,
    ok,
  }, 'media job');
}

/** Runs `work` and logs how long it took and whether it threw. */
export async function timeMediaJob<T>(job: MediaJobKind, ids: MediaJobIds, work: () => Promise<T>, waitMs = 0): Promise<T> {
  const startedAt = performance.now();
  let ok = false;
  try {
    const result = await work();
    ok = true;
    return result;
  } finally {
    logJob({ job, ...ids, ms: Math.round(performance.now() - startedAt), waitMs: Math.round(waitMs), ok });
  }
}

/**
 * `timeMediaJob` inside a media slot, with the time spent queued for that slot
 * as `waitMs`. A chain that already holds a slot runs straight away (waitMs 0).
 */
export function slotMediaJob<T>(
  job: MediaJobKind,
  ids: MediaJobIds,
  label: string,
  work: () => Promise<T>,
  options: SlotOptions & { slots?: MediaSlots } = {},
): Promise<T> {
  const queuedAt = performance.now();
  const { slots = mediaSlots, ...slotOptions } = options;
  return slots.run(label, () => timeMediaJob(job, ids, work, performance.now() - queuedAt), slotOptions);
}
