import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chatResponseSchema } from '@editify/shared';
import { AgentService } from '../src/agent/service.js';
import { MockToolProvider } from '../src/agent/providers.js';
import { AssetStore } from '../src/db/asset-store.js';
import { createDatabase, type EditifyDatabase } from '../src/db/database.js';
import { InsightStore } from '../src/db/insight-store.js';
import { ProjectStore } from '../src/db/project-store.js';
import { TranscriptStore } from '../src/db/transcript-store.js';
import { InsightService } from '../src/services/insight-service.js';
import { TranscriptService } from '../src/services/transcript-service.js';

describe('mock agent loop', () => {
  let database: EditifyDatabase;
  let projects: ProjectStore;
  let assets: AssetStore;
  let transcriptStore: TranscriptStore;
  let transcripts: TranscriptService;
  let insights: InsightService;

  beforeEach(() => {
    database = createDatabase(':memory:');
    projects = new ProjectStore(database);
    assets = new AssetStore(database);
    transcriptStore = new TranscriptStore(database);
    transcripts = new TranscriptService(transcriptStore, async () => {
      throw new Error('Whisper must not run in unit tests');
    });
    insights = new InsightService(new InsightStore(database), transcripts, new MockToolProvider());
  });

  afterEach(() => database.close());

  it('builds a punchy vertical cut with bold captions through live tools', async () => {
    const project = projects.create({ title: 'Agent test', format: '16:9', fps: 30 });
    for (const [index, duration] of [6, 3.5].entries()) {
      assets.insert({
        id: `asset-${index + 1}`,
        originalName: `source-${index + 1}.mp4`,
        mimeType: 'video/mp4',
        duration,
        width: 1920,
        height: 1080,
        fps: 30,
        hasAudio: true,
        originalPath: `/tmp/source-${index + 1}.mp4`,
        proxyPath: `/tmp/proxy-${index + 1}.mp4`,
        thumbnailPath: `/tmp/thumb-${index + 1}.jpg`,
        originalUrl: '',
        proxyUrl: '',
        thumbnailUrl: '',
        createdAt: new Date(0).toISOString(),
      });
      transcriptStore.put(`asset-${index + 1}`, {
        language: 'en',
        durationProcessedSeconds: duration,
        words: [
          { w: 'Did', s: 0.2, e: 0.4 }, { w: 'you', s: 0.4, e: 0.6 },
          { w: 'hear', s: 0.6, e: 0.9 }, { w: 'that?', s: 0.9, e: 1.2 },
          { w: 'Amazing!', s: 1.3, e: 1.8 },
        ],
        segments: [
          { text: 'Did you hear that?', s: 0.2, e: 1.2 },
          { text: 'Amazing!', s: 1.3, e: 1.8 },
        ],
      });
    }

    const response = await new AgentService(new MockToolProvider()).edit({
      projectId: project.id,
      projects,
      assets,
      styleDoc: null,
      currentVersion: project.version,
      transcripts,
      insights,
    }, 'build a punchy vertical cut with bold captions');

    expect(chatResponseSchema.safeParse(response).success).toBe(true);
    expect(response.trace.length).toBeGreaterThan(0);
    expect(response.reply).toEqual(expect.any(String));
    expect(response.doc.tracks.find((track) => track.kind === 'video')?.clips.length).toBeGreaterThanOrEqual(2);
    expect(response.doc.tracks.find((track) => track.kind === 'caption')?.clips.length).toBeGreaterThanOrEqual(2);
    expect(response.doc.format).toBe('9:16');
    expect(response.doc.version).toBeGreaterThan(project.version);
    expect(response.opsApplied.length).toBeGreaterThan(0);
    expect(response.opsApplied.at(-1)?.type).toBe('set_format');
    expect(response.trace.every((step) => step.ok)).toBe(true);
  });
});
