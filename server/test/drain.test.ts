import { describe, expect, it } from 'vitest';
import type { PendingJobs } from '../src/app.js';
import { readHealthJobs, waitForDrain } from '../src/services/drain.js';

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

describe('readHealthJobs', () => {
  const hangs = ((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  })) as unknown as typeof fetch;

  it('reads the job counts from /health', async () => {
    const fetcher = (async () => new Response(JSON.stringify({ ok: true, jobs: idle }))) as unknown as typeof fetch;
    expect(await readHealthJobs('http://drain.test/health', { fetcher })).toEqual(idle);
  });

  it('gives up on a hung server after its timeout instead of waiting forever', async () => {
    const started = Date.now();
    await expect(readHealthJobs('http://drain.test/health', { fetcher: hangs, timeoutMs: 30 }))
      .rejects.toThrow('did not answer within 30ms');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('counts a timed-out read as not idle, so a hung server is never reported drained', async () => {
    const result = await waitForDrain(
      async () => await readHealthJobs('http://drain.test/health', { fetcher: hangs, timeoutMs: 5 }),
      { timeoutMs: 3000, intervalMs: 1000, ...clock() },
    );
    expect(result).toEqual({ drained: false, waitedMs: 3000, last: undefined });
  });

  it('rejects an error status and a server without job counts', async () => {
    const down = (async () => new Response('no', { status: 503 })) as unknown as typeof fetch;
    const old = (async () => new Response(JSON.stringify({ ok: true }))) as unknown as typeof fetch;
    await expect(readHealthJobs('http://drain.test/health', { fetcher: down })).rejects.toThrow('answered 503');
    await expect(readHealthJobs('http://drain.test/health', { fetcher: old })).rejects.toThrow('no job counts');
  });
});
