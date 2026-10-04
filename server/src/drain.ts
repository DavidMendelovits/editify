/**
 * Waits for this server's job queue to empty before the cutover freeze.
 *
 * READ_ONLY=1 restarts the machine into a mode that cannot finish, fail or
 * re-queue a render (see `read-only.ts`), so anything mid-encode at the flip
 * would be stranded as "processing" forever. The runbook:
 *
 *   1. Release 1.1 on the App Store, so new work lands on the v11 server.
 *   2. fly ssh console -a editify-dm -C "node /app/server/dist/drain.js"
 *      (locally: npm run drain -w @editify/server). Exits 0 once /health shows
 *      no queued or running renders, imports or media jobs on two reads in a
 *      row, or 1 at the timeout (DRAIN_TIMEOUT_MS, default 15 minutes).
 *   3. On exit 0: fly secrets set READ_ONLY=1 -a editify-dm.
 *      On exit 1: it prints what is still running. Wait and rerun, or accept
 *      that those jobs are lost.
 *
 * A job can still start between step 2 and step 3; the window is the few
 * seconds the secret takes to apply. DRAIN_URL overrides the health URL.
 */
import type { PendingJobs } from './app.js';
import { port } from './config.js';
import { waitForDrain } from './services/drain.js';

const url = process.env.DRAIN_URL ?? `http://127.0.0.1:${port}/health`;
const timeoutMs = Number(process.env.DRAIN_TIMEOUT_MS ?? 15 * 60_000);
const intervalMs = Number(process.env.DRAIN_INTERVAL_MS ?? 5_000);

const result = await waitForDrain(async () => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const body = await response.json() as { jobs?: PendingJobs };
  if (!body.jobs) throw new Error(`${url} reports no job counts; is this server older than the drain support?`);
  return body.jobs;
}, { timeoutMs, intervalMs, log: (line) => console.log(`[drain] ${line}`) });

if (result.drained) {
  console.log(`[drain] queue empty after ${Math.round(result.waitedMs / 1000)}s. Safe to set READ_ONLY=1.`);
} else {
  console.error(`[drain] still busy after ${Math.round(result.waitedMs / 1000)}s: ${JSON.stringify(result.last ?? 'no reading')}`);
  process.exitCode = 1;
}
