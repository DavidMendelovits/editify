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
