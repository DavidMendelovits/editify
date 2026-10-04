import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createDatabase, type EditifyDatabase } from '../../src/db/database.js';
import { configureMutationJournal } from '../../src/db/mutation-journal.js';

/*
 * A 1.0 volume in miniature: editify.db with the 1.0 schema (main's: renders
 * has no snapshot columns) and the mutations journal on, plus media files at
 * the paths the rows name. Two users, the shared scope, and the odd cases the
 * importer must carry: a link to the NULL-owner sound library, an orphan
 * observation, a global and a per-user setting, a file no row names.
 */

export const ALICE = '00000000-0000-4000-8000-00000000a11c';
export const BOB = '00000000-0000-4000-8000-000000000b0b';

export interface Fixture {
  base: string;
  sourceRoot: string;
  sourceDb: string;
  destRoot: string;
  destDb: string;
  /** The live 1.0 connection (WAL, journal on, autocheckpoint off so commits stay in the WAL). */
  source: EditifyDatabase;
}

const now = '2026-10-01T00:00:00.000Z';

export function writeMedia(root: string, rel: string, content: string | Buffer): string {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function doc(id: string, title: string, assetIds: string[]): string {
  return JSON.stringify({
    id, title, format: '9:16', fps: 30, duration: 4, version: 1,
    tracks: [
      { id: 'video-main', kind: 'video', clips: assetIds.map((assetId, index) => ({ id: `clip-${index}`, assetId, start: index * 2, in: 0, out: 2 })) },
      { id: 'audio-main', kind: 'audio', clips: [] },
      { id: 'overlays', kind: 'overlay', clips: [] },
      { id: 'captions', kind: 'caption', clips: [] },
    ],
  });
}

export function insertAsset(source: EditifyDatabase, root: string, id: string, user: string | null, extra: Record<string, string> = {}): void {
  const original = writeMedia(root, `assets/${id}/original.mov`, `original bytes of ${id} `.repeat(64));
  const proxy = writeMedia(root, `assets/${id}/proxy.mp4`, `proxy of ${id}`);
  const thumb = writeMedia(root, `assets/${id}/thumb.jpg`, `thumb of ${id}`);
  for (const [name, content] of Object.entries(extra)) writeMedia(root, `assets/${id}/${name}`, content);
  source.prepare(`
    INSERT INTO assets (id, original_name, mime_type, duration, width, height, fps, has_audio, original_path, proxy_path, thumbnail_path, created_at, label, status, user_id)
    VALUES (?, ?, 'video/quicktime', 2, 1080, 1920, 30, 1, ?, ?, ?, ?, NULL, 'ready', ?)
  `).run(id, `${id}.mov`, original, proxy, thumb, now, user);
}

export function insertProject(source: EditifyDatabase, id: string, user: string | null, title: string, assetIds: string[]): void {
  source.prepare('INSERT INTO projects (id, title, doc_json, created_at, updated_at, user_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, title, doc(id, title, assetIds), now, now, user);
  for (const assetId of assetIds) source.prepare('INSERT INTO project_assets (project_id, asset_id, created_at) VALUES (?, ?, ?)').run(id, assetId, now);
}

export function insertChat(source: EditifyDatabase, id: string, projectId: string, content: string): void {
  source.prepare("INSERT INTO chat_messages (id, project_id, role, content, ops_json, created_at) VALUES (?, ?, 'user', ?, NULL, ?)")
    .run(id, projectId, content, now);
}

export function insertRender(source: EditifyDatabase, root: string, id: string, projectId: string): void {
  const output = writeMedia(root, `renders/${id}/output.mp4`, `rendered master ${id} `.repeat(32));
  writeMedia(root, `renders/${id}/captions.ass`, `[Script Info] ${id}`);
  source.prepare(`
    INSERT INTO renders (id, project_id, resolution, status, output_path, error, created_at, updated_at, qa_json, project_version)
    VALUES (?, ?, '1080p', 'done', ?, NULL, ?, ?, '{"loudness":-14}', 1)
  `).run(id, projectId, output, now, now);
}

export function createFixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'editify-cutover-'));
  const sourceRoot = join(base, 'v10-data');
  const destRoot = join(base, 'v11-data');
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(destRoot, { recursive: true });
  const sourceDb = join(sourceRoot, 'editify.db');
  const destDb = join(destRoot, 'editify.db');

  // 1.0's schema is 1.1's minus the render snapshot columns (plan OV1, release/1.1 only).
  const source = createDatabase(sourceDb, { readonly: false, journal: false });
  source.exec('ALTER TABLE renders DROP COLUMN snapshot_json; ALTER TABLE renders DROP COLUMN snapshot_hash;');
  configureMutationJournal(source, true);
  source.pragma('wal_autocheckpoint = 0');

  // The shared scope: the sound library (NULL owner, outside assets/), pre-auth data, global rows.
  const whoosh = writeMedia(sourceRoot, 'sounds/whoosh-soft.m4a', 'whoosh audio');
  source.prepare(`
    INSERT INTO assets (id, original_name, mime_type, duration, width, height, fps, has_audio, original_path, proxy_path, thumbnail_path, created_at, label, status, user_id)
    VALUES ('sound-whoosh-soft', 'Soft whoosh', 'audio/mp4', 0.8, 0, 0, 0, 1, ?, ?, ?, ?, NULL, 'ready', NULL)
  `).run(whoosh, whoosh, whoosh, now);
  writeMedia(sourceRoot, 'emoji/1f600.png', 'emoji png');
  insertAsset(source, sourceRoot, 'asset-preauth', null);
  insertProject(source, 'project-preauth', null, 'Before sign-in', ['asset-preauth']);
  source.prepare("INSERT INTO settings (key, value) VALUES ('style.default', 'punchy')").run();
  source.prepare("INSERT INTO webhook_events (event_id, kind, user_id, processed_at, result_json) VALUES ('evt-1', 'user.deleted', '00000000-0000-4000-8000-0000000dead0', ?, '{}')").run(now);
  source.prepare("INSERT INTO video_observations (asset_id, analyzer, analyzer_version, observation_json, created_at) VALUES ('asset-gone', 'ffmpeg', '1', '{}', ?)").run(now);
  writeMedia(sourceRoot, 'assets/asset-nobody/original.mov', 'a file no row names');

  // Alice: a project with history, chat, a render, transcripts and analysis, a style profile, a report, a setting.
  insertAsset(source, sourceRoot, 'asset-a1', ALICE, { 'filmstrip.jpg': 'filmstrip' });
  insertProject(source, 'project-a1', ALICE, 'Alice set', ['asset-a1', 'sound-whoosh-soft']);
  source.prepare(`
    INSERT INTO operation_log (id, batch_id, project_id, sequence, op_json, before_doc_json, after_doc_json, undone, created_at, run_id, undo_target_batch_id)
    VALUES ('op-a1', 'batch-a1', 'project-a1', 0, '{"type":"trim"}', ?, ?, 0, ?, 'run-1', NULL)
  `).run(doc('project-a1', 'Alice set', ['asset-a1']), doc('project-a1', 'Alice set', ['asset-a1', 'sound-whoosh-soft']), now);
  insertChat(source, 'chat-a1', 'project-a1', 'tighten the intro');
  insertChat(source, 'chat-a2', 'project-a1', 'add a whoosh');
  insertRender(source, sourceRoot, 'render-a1', 'project-a1');
  source.prepare("INSERT INTO transcripts (asset_id, language, words, segments, energy_json, created_at) VALUES ('asset-a1', 'en', '[{\"w\":\"hi\",\"s\":0,\"e\":0.4}]', '[]', NULL, ?)").run(now);
  source.prepare("INSERT INTO insights (asset_id, json, created_at) VALUES ('asset-a1', '{\"faces\":1}', ?)").run(now);
  source.prepare("INSERT INTO dissections (asset_id, dissection_json, created_at) VALUES ('asset-a1', '{}', ?)").run(now);
  source.prepare("INSERT INTO waveforms (asset_id, waveform_json, created_at) VALUES ('asset-a1', '[1,2,3]', ?)").run(now);
  source.prepare("INSERT INTO face_tracks (asset_id, track_json, created_at) VALUES ('asset-a1', '[]', ?)").run(now);
  source.prepare("INSERT INTO video_observations (asset_id, analyzer, analyzer_version, observation_json, created_at) VALUES ('asset-a1', 'vision', '2', '{\"shots\":3}', ?)").run(now);
  source.prepare(`
    INSERT INTO style_profiles (id, asset_ids_json, metrics_json, style_doc, created_at, name, analyzer, observations_json, template_json, user_id)
    VALUES ('style-a1', '["asset-a1"]', '{}', 'fast cuts', ?, 'Mine', 'ffmpeg', NULL, NULL, ?)
  `).run(now, ALICE);
  source.prepare(`
    INSERT INTO reports (id, session_id, user_id, kind, payload_json, fingerprint, issue_number, issue_url, created_at, repro_json)
    VALUES ('report-a1', 'session-1', ?, 'feedback', ?, NULL, NULL, NULL, ?, NULL)
  `).run(ALICE, JSON.stringify({ text: 'love it', file: `${sourceRoot}/assets/asset-a1/original.mov` }), now);
  source.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(`captionStyle:${ALICE}`, 'bold');

  // Bob: a smaller footprint.
  insertAsset(source, sourceRoot, 'asset-b1', BOB);
  insertProject(source, 'project-b1', BOB, 'Bob set', ['asset-b1']);
  insertChat(source, 'chat-b1', 'project-b1', 'make it shorter');

  // 1.1's own database, as editify-v11 would have it.
  createDatabase(destDb, { readonly: false, journal: false }).close();
  return { base, sourceRoot, sourceDb, destRoot, destDb, source };
}
