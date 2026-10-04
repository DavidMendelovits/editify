import type { PendingJobs } from '../app.js';

export interface DrainOptions {
  timeoutMs: number;
  intervalMs: number;
  /** Consecutive idle reads required, so a job queued right behind the last one is not missed. */
  idleReads?: number;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type DrainResult = { drained: true; waitedMs: number } | { drained: false; waitedMs: number; last: PendingJobs | undefined };

const idle = (jobs: PendingJobs): boolean => jobs.renders === 0 && jobs.imports === 0 && jobs.media === 0;

/**
 * Polls `readJobs` until nothing is queued or running, or the timeout passes.
 * A read that throws (the server restarting, say) counts as not drained.
 */
export async function waitForDrain(readJobs: () => Promise<PendingJobs>, options: DrainOptions): Promise<DrainResult> {
  const { timeoutMs, intervalMs, idleReads = 2, log = () => {}, now = Date.now } = options;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const started = now();
  let last: PendingJobs | undefined;
  let streak = 0;
  for (;;) {
    try {
      last = await readJobs();
      streak = idle(last) ? streak + 1 : 0;
      log(`renders=${last.renders} imports=${last.imports} media=${last.media}${streak ? ` (idle ${streak}/${idleReads})` : ''}`);
    } catch (error) {
      streak = 0;
      log(`could not read jobs: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (streak >= idleReads) return { drained: true, waitedMs: now() - started };
    if (now() - started + intervalMs > timeoutMs) return { drained: false, waitedMs: now() - started, last };
    await sleep(intervalMs);
  }
}

export interface HealthReadOptions {
  /** Per request. A hung server must not hold the drain past its own timeout. Default 5s. */
  timeoutMs?: number;
  fetcher?: typeof fetch;
}

/**
 * One read of `/health`'s job counts. Aborts after `timeoutMs` and throws, so
 * `waitForDrain` counts a server that stops answering as busy, never idle.
 */
export async function readHealthJobs(url: string, options: HealthReadOptions = {}): Promise<PendingJobs> {
  const { timeoutMs = 5_000, fetcher = fetch } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    const body = await response.json() as { jobs?: PendingJobs };
    if (!body.jobs) throw new Error(`${url} reports no job counts; is this server older than the drain support?`);
    return body.jobs;
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`${url} did not answer within ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
