import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolProvider } from '../src/agent/providers.js';
import { createDatabase } from '../src/db/database.js';
import { ReportStore } from '../src/db/report-store.js';
import { registerTelemetryRoutes } from '../src/routes/telemetry.js';
import { storeScreenshot } from '../src/services/report-media.js';
import { TelemetryService } from '../src/services/telemetry-service.js';

// No provider and no token: the report still has to survive somewhere.
const brokenProvider = async (): Promise<ToolProvider> => { throw new Error('no provider configured'); };

let insightsPath: string;

function serve() {
  insightsPath = join(mkdtempSync(join(tmpdir(), 'editify-telemetry-')), 'user-insights.md');
  const store = new ReportStore(createDatabase(':memory:'));
  const app = Fastify();
  registerTelemetryRoutes(app, new TelemetryService(store, brokenProvider, insightsPath));
  return app;
}

const base = { sessionId: 's1', platform: 'web', events: [{ at: new Date(0).toISOString(), type: 'app_open' }] };

beforeEach(() => { delete process.env.GITHUB_TOKEN; });
afterEach(() => { delete process.env.GITHUB_TOKEN; });

describe('POST /telemetry without GITHUB_TOKEN', () => {
  it('writes a session report to user-insights.md and files nothing', async () => {
    const response = await serve().inject({ method: 'POST', url: '/telemetry', payload: { ...base, kind: 'session' } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ issueNumber: null, issueUrl: null });
    expect(readFileSync(insightsPath, 'utf8')).toContain('Session s1');
  });

  it('writes the browser, the app state, and the event trail into the fallback', async () => {
    const now = Date.now();
    const response = await serve().inject({
      method: 'POST',
      url: '/telemetry',
      payload: {
        ...base,
        kind: 'feedback',
        feedback: 'Let me select more than one clip at a time.',
        events: [
          { at: new Date(now - 8000).toISOString(), type: 'project_open', detail: 'p1' },
          { at: new Date(now - 3000).toISOString(), type: 'edit', detail: 'trim_clip' },
          { at: new Date(now).toISOString(), type: 'feedback_open', detail: 'editor' },
        ],
        environment: {
          userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
          viewport: '1440x780',
          screen: '2560x1440',
          pixelRatio: 2,
          path: '/project/p1',
          language: 'en-GB',
          timezone: 'Europe/London',
          online: true,
          connection: '4g',
          cpuCores: 10,
          sessionSeconds: 754,
        },
        context: { screen: 'editor', projectId: 'p1', clipCount: 14, selectedClip: 'clip-3', playing: false },
      },
    });

    expect(response.statusCode).toBe(200);
    const written = readFileSync(insightsPath, 'utf8');
    // The browser is readable rather than a raw UA string.
    expect(written).toContain('Client: Chrome 141.0 on macOS 10.15');
    expect(written).toContain('Viewport: 1440x780 (screen 2560x1440) @2x');
    expect(written).toContain('Route: /project/p1');
    expect(written).toContain('In session: 12m 34s');
    // App state the editor published about itself.
    expect(written).toContain('clipCount: 14');
    expect(written).toContain('selectedClip: clip-3');
    // The trail, stamped against the moment the report was sent.
    expect(written).toContain('What led up to it.');
    expect(written).toMatch(/-8\.0s\s+project_open\s+p1/);
    expect(written).toMatch(/0\.0s\s+feedback_open\s+editor/);
  });

  it('says what it knows in the feasibility line when no provider answers', async () => {
    const response = await serve().inject({
      method: 'POST',
      url: '/telemetry',
      payload: {
        ...base,
        kind: 'feedback',
        feedback: 'Multi-select, please.',
        environment: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/128.0' },
        context: { screen: 'editor' },
      },
    });

    expect(response.statusCode).toBe(200);
    const written = readFileSync(insightsPath, 'utf8');
    expect(written).toContain('No LLM provider was reachable');
    expect(written).toContain('on the editor screen');
    expect(written).toContain('Firefox 128.0 on Windows 10.0');
    expect(written).toContain('The last thing logged was app_open');
  });

  it('falls back to the insights file for an error report instead of crashing', async () => {
    const response = await serve().inject({
      method: 'POST',
      url: '/telemetry',
      payload: { ...base, kind: 'error', error: { message: 'boom in the timeline' } },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().issueNumber).toBeNull();
    const written = readFileSync(insightsPath, 'utf8');
    expect(written).toContain('boom in the timeline');
    expect(written).toContain('GITHUB_TOKEN is unset');
  });
});

describe('screenshots', () => {
  const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  it('saves an attached screenshot and points the issue at the highlighted component', async () => {
    const response = await serve().inject({
      method: 'POST',
      url: '/telemetry',
      payload: {
        ...base,
        kind: 'feedback',
        feedback: 'This button does nothing.',
        screenshot: {
          data: pixel,
          width: 1512,
          height: 812,
          highlight: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
          highlightTarget: 'send feedback in header',
        },
      },
    });

    expect(response.statusCode).toBe(200);
    const saved = join(dirname(insightsPath), 'report-screenshots', `${response.json().reportId}.png`);
    expect(existsSync(saved)).toBe(true);
    const written = readFileSync(insightsPath, 'utf8');
    expect(written).toContain('**They highlighted** `send feedback in header`');
    // No token here, so the issue says where the image actually is.
    expect(written).toContain('Not uploaded');
  });

  it('refuses bytes that are not the image they claim to be', async () => {
    // Valid base64 behind a valid image prefix, but the bytes are a zip.
    const zip = `data:image/png;base64,${Buffer.from('PK\u0003\u0004 not an image at all').toString('base64')}`;
    const response = await serve().inject({
      method: 'POST',
      url: '/telemetry',
      payload: { ...base, kind: 'feedback', feedback: 'hi', screenshot: { data: zip, width: 10, height: 10 } },
    });

    expect(response.statusCode).toBe(200);
    const saved = join(dirname(insightsPath), 'report-screenshots', `${response.json().reportId}.png`);
    expect(existsSync(saved)).toBe(false);
    expect(readFileSync(insightsPath, 'utf8')).not.toContain('Screenshot');
  });

  it('keeps an anonymous screenshot local instead of committing it to the repository', async () => {
    // POST /telemetry accepts anonymous reports so a crash on the sign-in
    // screen can file. Pushing their images would let anyone who can reach the
    // endpoint write into the repository under our own token.
    process.env.GITHUB_TOKEN = 'test-token';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const directory = mkdtempSync(join(tmpdir(), 'editify-shots-'));

    const stored = await storeScreenshot(
      'report-1',
      { data: pixel, width: 1, height: 1 },
      'DavidMendelovits/editify',
      directory,
      false,
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(stored?.url).toBeUndefined();
    expect(existsSync(join(directory, 'report-1.png'))).toBe(true);
    fetchSpy.mockRestore();
  });

  it('rejects a payload that is not an image', async () => {
    const response = await serve().inject({
      method: 'POST',
      url: '/telemetry',
      payload: { ...base, kind: 'feedback', feedback: 'hi', screenshot: { data: 'https://example.com/x.png', width: 10, height: 10 } },
    });

    expect(response.statusCode).toBe(500);
  });
});
