import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chatResponseSchema } from '@editify/shared';
import { AgentService } from '../src/agent/service.js';
import { MockToolProvider } from '../src/agent/providers.js';
import { AssetStore } from '../src/db/asset-store.js';
import { createDatabase, type EditifyDatabase } from '../src/db/database.js';
import { ProjectStore } from '../src/db/project-store.js';

describe('mock agent loop', () => {
  let database: EditifyDatabase;
  let projects: ProjectStore;
  let assets: AssetStore;

  beforeEach(() => {
    database = createDatabase(':memory:');
    projects = new ProjectStore(database);
    assets = new AssetStore(database);
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
    }

    const response = await new AgentService(new MockToolProvider()).edit({
      projectId: project.id,
      projects,
      assets,
      styleDoc: null,
      currentVersion: project.version,
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
