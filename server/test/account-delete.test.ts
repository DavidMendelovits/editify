import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { AssetStore } from '../src/db/asset-store.js';
import { ChatStore } from '../src/db/chat-store.js';
import { createDatabase } from '../src/db/database.js';
import { ProjectStore } from '../src/db/project-store.js';
import { RenderStore } from '../src/db/render-store.js';
import { deleteUserData } from '../src/services/account-service.js';

// Ids are distinctive because the delete also unlinks `assets/<id>` on disk.
const media = (id: string) => ({
  id, originalName: `${id}.mp4`, mimeType: 'video/mp4', duration: 1, width: 10, height: 10,
  fps: 30, hasAudio: false, originalPath: '/x', proxyPath: '/x', thumbnailPath: '/x',
  originalUrl: '', proxyUrl: '', thumbnailUrl: '', filmstripUrl: '', createdAt: new Date().toISOString(),
});

describe('DELETE /account', () => {
  it('removes only the caller\'s rows, leaving other users and the shared scope intact', async () => {
    const database = createDatabase(':memory:');
    const projects = new ProjectStore(database);
    const assets = new AssetStore(database);
    const renders = new RenderStore(database);
    const chats = new ChatStore(database);

    const mine = projects.create({ title: 'mine', format: '9:16', fps: 30 }, 'account-alice');
    const theirs = projects.create({ title: 'theirs', format: '9:16', fps: 30 }, 'account-bob');
    const shared = projects.create({ title: 'shared', format: '9:16', fps: 30 });
    assets.insert(media('account-alice-clip'), 'account-alice');
    assets.insert(media('account-bob-clip'), 'account-bob');
    assets.insert(media('account-shared-clip'));
    renders.create(mine.id, '720p');
    chats.add(mine.id, 'user', 'cut this');
    // `video_observations` has no foreign key, so it only goes if we take it.
    database.prepare(`
      INSERT INTO video_observations (asset_id, analyzer, analyzer_version, observation_json, created_at)
      VALUES (?, 'ffmpeg', '1', '{}', ?)
    `).run('account-alice-clip', new Date().toISOString());
    const report = database.prepare(
      'INSERT INTO reports (id, session_id, user_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    report.run('r-alice', 's', 'account-alice', 'crash', '{}', new Date().toISOString());
    report.run('r-bob', 's', 'account-bob', 'crash', '{}', new Date().toISOString());

    const counts = await deleteUserData(database, 'account-alice');
    expect(counts).toEqual({ projects: 1, assets: 1, reports: 1 });

    // Alice is gone, everyone else is untouched.
    expect(projects.list().map((project) => project.id).sort()).toEqual([theirs.id, shared.id].sort());
    expect(assets.list().map((asset) => asset.id).sort()).toEqual(['account-bob-clip', 'account-shared-clip']);
    expect(assets.get('account-alice-clip')).toBeUndefined();

    // Cascades and the hand-cleared table.
    const count = (sql: string, ...values: string[]) =>
      (database.prepare(sql).get(...values) as { count: number }).count;
    expect(count('SELECT COUNT(*) AS count FROM renders WHERE project_id = ?', mine.id)).toBe(0);
    expect(count('SELECT COUNT(*) AS count FROM chat_messages WHERE project_id = ?', mine.id)).toBe(0);
    expect(count('SELECT COUNT(*) AS count FROM video_observations')).toBe(0);
    expect(count('SELECT COUNT(*) AS count FROM reports WHERE user_id = ?', 'account-bob')).toBe(1);

    // Deleting twice is not an error; the second pass finds nothing.
    expect(await deleteUserData(database, 'account-alice')).toEqual({ projects: 0, assets: 0, reports: 0 });
    database.close();
  });

  it('answers without a signed-in user instead of crashing on a missing service key', async () => {
    const app = await buildApp({ database: createDatabase(':memory:') });
    const response = await app.inject({ method: 'DELETE', url: '/account' });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
