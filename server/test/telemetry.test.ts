import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolProvider } from '../src/agent/providers.js';
import { createDatabase } from '../src/db/database.js';
import { ReportStore } from '../src/db/report-store.js';
import { registerTelemetryRoutes } from '../src/routes/telemetry.js';
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
