import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { buildInfo } from '../src/config.js';
import { createDatabase } from '../src/db/database.js';

/*
 * /health names the server line and build (plan D17, C13): the 1.1 E2E and
 * CI's post-deploy smoke assert line=1.1 and the deployed commit on it.
 */
const KEYS = ['LINE', 'GIT_SHA', 'FLY_IMAGE_REF', 'EDITIFY_TOKEN'] as const;
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('buildInfo', () => {
  it('reads LINE and GIT_SHA', () => {
    expect(buildInfo({ LINE: '1.1', GIT_SHA: 'abc123' })).toEqual({ line: '1.1', commit: 'abc123' });
  });

  it("falls back to Fly's image ref, then unknown, and to line dev", () => {
    expect(buildInfo({ FLY_IMAGE_REF: 'registry.fly.io/editify-v11:deployment-01' }))
      .toEqual({ line: 'dev', commit: 'registry.fly.io/editify-v11:deployment-01' });
    // An empty build arg (no --build-arg passed) is not a commit.
    expect(buildInfo({ GIT_SHA: '' })).toEqual({ line: 'dev', commit: 'unknown' });
  });
});

describe('GET /health', () => {
  it('answers without credentials with ok, line, commit and whether sync is on', async () => {
    process.env.LINE = '1.1';
    process.env.GIT_SHA = 'deadbeef';
    // A shared token makes every other route demand credentials.
    process.env.EDITIFY_TOKEN = 'health-test-token';
    const app = await buildApp({ database: createDatabase(':memory:'), databaseUrl: null });
    try {
      const health = await app.inject({ url: '/health' });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toMatchObject({ ok: true, line: '1.1', commit: 'deadbeef', sync: false });
      expect((await app.inject({ url: '/projects' })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
