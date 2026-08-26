import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Project } from '@editify/shared';
import { AgentService } from '../src/agent/service.js';
import { MockToolProvider, type ToolProvider } from '../src/agent/providers.js';
import { AssetStore } from '../src/db/asset-store.js';
import { ChatStore } from '../src/db/chat-store.js';
import { createDatabase, type EditifyDatabase } from '../src/db/database.js';
import { InsightStore } from '../src/db/insight-store.js';
import { ProjectStore } from '../src/db/project-store.js';
import { TranscriptStore } from '../src/db/transcript-store.js';
import { registerChatRoutes } from '../src/routes/chat.js';
import { DissectService } from '../src/services/dissect-service.js';
import { InsightService } from '../src/services/insight-service.js';
import { StyleService } from '../src/services/style-service.js';
import { TranscriptService } from '../src/services/transcript-service.js';

/** Applies one real edit on its first turn, then dies before it can finish. */
function crashingProvider(): ToolProvider {
  let turn = 0;
  return {
    name: 'mock',
    async runTurn() {
      turn += 1;
      if (turn === 1) {
        return { text: 'Lowering the volume first.', toolCalls: [{ id: 't1', name: 'set_volume', input: { clipId: 'clip-a', volume: 0.5 } }] };
      }
      throw new Error('provider connection dropped');
    },
    async completeText() { return ''; },
  };
}

describe('a crashed agent turn stays revertable', () => {
  let database: EditifyDatabase;
  let projects: ProjectStore;
  let chats: ChatStore;
  let app: FastifyInstance;
  let projectId: string;

  beforeEach(() => {
    database = createDatabase(':memory:');
    projects = new ProjectStore(database);
    const assets = new AssetStore(database);
    chats = new ChatStore(database);
    const transcripts = new TranscriptService(new TranscriptStore(database), async () => {
      throw new Error('Whisper must not run in unit tests');
    }, async () => {
      throw new Error('ffmpeg must not run in unit tests');
    });
    const insights = new InsightService(new InsightStore(database), transcripts, async () => new MockToolProvider());
    const agent = new AgentService(async () => crashingProvider());
    const styles = new StyleService(database, assets, agent);
    const dissections = new DissectService(database);

    assets.insert({
      id: 'asset-1', originalName: 'clip.mp4', mimeType: 'video/mp4', duration: 3,
      width: 1080, height: 1920, fps: 30, hasAudio: true,
      originalPath: '/not/read.mp4', proxyPath: '/not/read-proxy.mp4', thumbnailPath: '/not/read.jpg',
      originalUrl: '', proxyUrl: '', thumbnailUrl: '', filmstripUrl: '', createdAt: new Date(0).toISOString(),
    });
    projectId = projects.insert({
      id: 'crash-project', title: 'Crash', format: '9:16', fps: 30, duration: 3, version: 0,
      tracks: [{ id: 'video-main', kind: 'video', clips: [
        { id: 'clip-a', assetId: 'asset-1', start: 0, in: 0, out: 3 },
      ] }],
    }).id;

    app = Fastify({ logger: false });
    registerChatRoutes(app, projects, assets, chats, agent, styles, transcripts, insights, dissections);
  });

  afterEach(async () => {
    await app.close();
    database.close();
  });

  it('records the applied ops on the error message so Revert renders, and revert_run restores the doc', async () => {
    const before = projects.get(projectId) as Project;

    const response = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/chat`,
      payload: { message: 'quieter please' },
    });
    expect(response.statusCode).toBe(500);

    // The edit landed before the crash.
    const after = projects.get(projectId) as Project;
    expect(after.tracks[0]?.clips[0]?.volume).toBe(0.5);
    expect(after.version).toBe(before.version + 1);

    // The error message is honest, and carries the applied ops + runId that
    // the mobile Revert button keys on (message.ops?.length && message.runId).
    const messages = chats.list(projectId);
    const errorMessage = messages.at(-1);
    expect(errorMessage?.role).toBe('assistant');
    expect(errorMessage?.content).toContain('hit an error mid-turn');
    expect(errorMessage?.content).toContain('provider connection dropped');
    expect(errorMessage?.content).not.toMatch(/\bdone\b/i);
    expect(errorMessage?.ops).toHaveLength(1);
    expect(errorMessage?.ops?.[0]?.type).toBe('set_volume');
    expect(errorMessage?.runId).toBeDefined();
    expect(errorMessage?.trace?.length).toBeGreaterThan(0);

    // Reverting that runId restores the pre-run document.
    const reverted = projects.applyOperations(
      projectId,
      [{ type: 'revert_run', params: { runId: errorMessage?.runId as string } }],
      after.version,
    );
    expect(reverted.tracks[0]?.clips[0]?.volume).toBe(before.tracks[0]?.clips[0]?.volume);

    // The chat listing now derives reverted: true for the crashed turn.
    const listing = await app.inject({ url: `/projects/${projectId}/chat` });
    const listed = (listing.json() as Array<{ runId?: string; reverted?: boolean }>).at(-1);
    expect(listed?.runId).toBe(errorMessage?.runId);
    expect(listed?.reverted).toBe(true);
  });

  it('records no ops when the crash happens before any edit', async () => {
    // Reuse the harness but crash on the very first turn.
    const agent = new AgentService(async () => ({
      name: 'mock',
      async runTurn() { throw new Error('boom before edits'); },
      async completeText() { return ''; },
    }));
    const bare = Fastify({ logger: false });
    const assets = new AssetStore(database);
    const transcripts = new TranscriptService(new TranscriptStore(database), async () => {
      throw new Error('Whisper must not run in unit tests');
    }, async () => {
      throw new Error('ffmpeg must not run in unit tests');
    });
    const insights = new InsightService(new InsightStore(database), transcripts, async () => new MockToolProvider());
    registerChatRoutes(bare, projects, assets, chats, agent, new StyleService(database, assets, agent), transcripts, insights, new DissectService(database));

    const response = await bare.inject({
      method: 'POST',
      url: `/projects/${projectId}/chat`,
      payload: { message: 'do nothing' },
    });
    expect(response.statusCode).toBe(500);
    const errorMessage = chats.list(projectId).at(-1);
    expect(errorMessage?.content).toContain('boom before edits');
    expect(errorMessage?.ops).toHaveLength(0);
    await bare.close();
  });
});
