import { describe, expect, it } from 'vitest';
import type { PendingJobs } from '../src/app.js';
import { waitForDrain } from '../src/services/drain.js';

const busy: PendingJobs = { renders: 1, imports: 0, media: 1 };
const idle: PendingJobs = { renders: 0, imports: 0, media: 0 };

/** A fake clock: `sleep` advances it, so the tests run instantly. */
function clock() {
  let time = 0;
  return { now: () => time, sleep: async (ms: number) => { time += ms; } };
}

describe('waitForDrain', () => {
  it('returns once the queue reads idle twice in a row', async () => {
    const readings = [busy, idle, busy, idle, idle];
    let reads = 0;
    const result = await waitForDrain(async () => readings[reads++] ?? idle, { timeoutMs: 60_000, intervalMs: 1000, ...clock() });
    expect(result).toEqual({ drained: true, waitedMs: 4000 });
    expect(reads).toBe(5);
  });

  it('gives up at the timeout and reports what is still running', async () => {
    const result = await waitForDrain(async () => busy, { timeoutMs: 5000, intervalMs: 1000, ...clock() });
    expect(result).toEqual({ drained: false, waitedMs: 5000, last: busy });
  });

  it('never counts an unreadable server as drained', async () => {
    let reads = 0;
    const result = await waitForDrain(async () => {
      reads += 1;
      if (reads % 2 === 0) throw new Error('connection refused');
      return idle;
    }, { timeoutMs: 10_000, intervalMs: 1000, ...clock() });
    expect(result.drained).toBe(false);
  });
});
