import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssetStore } from '../src/db/asset-store.js';
import { createDatabase, type EditifyDatabase } from '../src/db/database.js';
import {
  configureMutationJournal,
  hasMutationJournal,
  iterateMutationsAfter,
  journaledTables,
  latestMutationId,
  readMutationsAfter,
} from '../src/db/mutation-journal.js';
import { ProjectStore } from '../src/db/project-store.js';
import { RenderStore } from '../src/db/render-store.js';
import { SettingsStore } from '../src/db/settings-store.js';

const triggers = (database: EditifyDatabase): string[] =>
  (database.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string }>).map((row) => row.name);

const asset = (id: string) => ({
  id, originalName: `${id}.mp4`, mimeType: 'video/mp4', duration: 1, width: 10, height: 10, fps: 30, hasAudio: false,
  originalPath: '/x', proxyPath: '/x', thumbnailPath: '/x', originalUrl: '', proxyUrl: '', thumbnailUrl: '', filmstripUrl: '',
  createdAt: new Date(0).toISOString(),
});

let database: EditifyDatabase | undefined;
afterEach(() => {
  database?.close();
  database = undefined;
  vi.unstubAllEnvs();
});

describe('mutations journal', () => {
  it('is absent with the flag off: no table, no trigger', () => {
    database = createDatabase(':memory:');
    new ProjectStore(database).create({ title: 'a', format: '9:16', fps: 30 }, 'alice');
    expect(hasMutationJournal(database)).toBe(false);
    expect(triggers(database)).toEqual([]);
    expect(readMutationsAfter(database, 0)).toEqual([]);
    expect(latestMutationId(database)).toBe(0);
  });

  it('is what MUTATION_JOURNAL=1 in the environment turns on, covering every table', () => {
    vi.stubEnv('MUTATION_JOURNAL', '1');
    database = createDatabase(':memory:');
    expect(hasMutationJournal(database)).toBe(true);
    const tables = journaledTables(database);
    expect(tables).toContain('projects');
    expect(tables).not.toContain('mutations');
    expect(tables.some((table) => table.startsWith('sqlite_'))).toBe(false);
    expect(triggers(database)).toHaveLength(tables.length * 3);
  });

  it('captures insert, update and delete with the key, the op and the row, in id order', () => {
    database = createDatabase(':memory:', { journal: true });
    const projects = new ProjectStore(database);
    const project = projects.create({ title: 'first', format: '9:16', fps: 30 }, 'alice');
    database.prepare('UPDATE projects SET title = ? WHERE id = ?').run('renamed', project.id);
    const settings = new SettingsStore(database);
    settings.set('k', 'v1');
    settings.set('k', 'v2');
    database.prepare('DELETE FROM projects WHERE id = ?').run(project.id);

    const journal = readMutationsAfter(database, 0);
    expect(journal.map((entry) => entry.id)).toEqual([...journal.map((entry) => entry.id)].sort((a, b) => a - b));
    expect(new Set(journal.map((entry) => entry.id)).size).toBe(journal.length);

    const forProject = journal.filter((entry) => entry.table === 'projects');
    expect(forProject.map((entry) => entry.op)).toEqual(['insert', 'update', 'delete']);
    expect(forProject.every((entry) => entry.pk.id === project.id)).toBe(true);
    expect(forProject[0]?.row).toMatchObject({ id: project.id, title: 'first', user_id: 'alice' });
    expect(forProject[1]?.row).toMatchObject({ title: 'renamed' });
    // A delete carries the row as it was.
    expect(forProject[2]?.row).toMatchObject({ id: project.id, title: 'renamed', user_id: 'alice' });
    expect(typeof forProject[0]?.row.doc_json).toBe('string');
    expect(forProject[0]?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(journal.filter((entry) => entry.table === 'settings').map((entry) => [entry.op, entry.row.value]))
      .toEqual([['insert', 'v1'], ['update', 'v2']]);
  });

  it('journals cascaded deletes and composite keys', () => {
    database = createDatabase(':memory:', { journal: true });
    const project = new ProjectStore(database).create({ title: 'p', format: '9:16', fps: 30 }, 'alice');
    const assets = new AssetStore(database);
    assets.insert(asset('clip'), 'alice');
    assets.link(project.id, 'clip');
    new RenderStore(database).create(project.id, '720p');
    const mark = latestMutationId(database);

    database.prepare('DELETE FROM projects WHERE id = ?').run(project.id);
    const deleted = readMutationsAfter(database, mark);
    expect(deleted.every((entry) => entry.op === 'delete')).toBe(true);
    expect(deleted.map((entry) => entry.table).sort()).toEqual(['project_assets', 'projects', 'renders']);
    expect(deleted.find((entry) => entry.table === 'project_assets')?.pk).toEqual({ project_id: project.id, asset_id: 'clip' });
  });

  it('records an update under the key the row had before it', () => {
    database = createDatabase(':memory:', { journal: true });
    new SettingsStore(database).set('old-key', 'v');
    database.prepare('UPDATE settings SET key = ? WHERE key = ?').run('new-key', 'old-key');
    const [, update] = readMutationsAfter(database, 0);
    expect(update).toMatchObject({ op: 'update', pk: { key: 'old-key' }, row: { key: 'new-key', value: 'v' } });
  });

  it('reads past an id in pages, for the importer', () => {
    database = createDatabase(':memory:', { journal: true });
    const settings = new SettingsStore(database);
    for (let index = 0; index < 7; index += 1) settings.set(`k${index}`, String(index));
    const all = readMutationsAfter(database, 0);
    expect(all).toHaveLength(7);
    const cut = all[2]?.id ?? 0;
    expect(readMutationsAfter(database, cut).map((entry) => entry.row.key)).toEqual(['k3', 'k4', 'k5', 'k6']);
    expect(readMutationsAfter(database, cut, 2).map((entry) => entry.row.key)).toEqual(['k3', 'k4']);
    expect([...iterateMutationsAfter(database, cut, 2)].map((entry) => entry.row.key)).toEqual(['k3', 'k4', 'k5', 'k6']);
    expect(latestMutationId(database)).toBe(all.at(-1)?.id);
    expect(readMutationsAfter(database, latestMutationId(database))).toEqual([]);
  });

  it('rebuilds triggers with new columns, and turning the flag off drops them but keeps the rows', () => {
    database = createDatabase(':memory:', { journal: true });
    database.exec('ALTER TABLE settings ADD COLUMN note TEXT');
    configureMutationJournal(database, true);
    database.prepare("INSERT INTO settings (key, value, note) VALUES ('a', '1', 'hi')").run();
    expect(readMutationsAfter(database, 0).at(-1)?.row).toEqual({ key: 'a', value: '1', note: 'hi' });

    const kept = latestMutationId(database);
    configureMutationJournal(database, false);
    expect(triggers(database)).toEqual([]);
    new SettingsStore(database).set('b', '2');
    expect(latestMutationId(database)).toBe(kept);
  });
});
