import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { databasePath } from '../config.js';

export type EditifyDatabase = Database.Database;

export function createDatabase(path = databasePath): EditifyDatabase {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const database = new Database(path);
  database.pragma('foreign_keys = ON');
  if (path !== ':memory:') database.pragma('journal_mode = WAL');
  migrate(database);
  return database;
}

function migrate(database: EditifyDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      doc_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS operation_log (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      op_json TEXT NOT NULL,
      before_doc_json TEXT NOT NULL,
      after_doc_json TEXT NOT NULL,
      undone INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS operation_log_project_idx
      ON operation_log(project_id, created_at DESC, sequence DESC);

    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      duration REAL NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      fps REAL NOT NULL,
      has_audio INTEGER NOT NULL,
      original_path TEXT NOT NULL,
      proxy_path TEXT NOT NULL,
      thumbnail_path TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    -- Which assets belong to which project. An asset can be linked to several
    -- projects (pull a clip from another shoot), but a project only ever sees
    -- its own links, so imports never leak between projects.
    CREATE TABLE IF NOT EXISTS project_assets (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, asset_id)
    );

    CREATE TABLE IF NOT EXISTS transcripts (
      asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
      language TEXT NOT NULL,
      words TEXT NOT NULL,
      segments TEXT NOT NULL,
      energy_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS insights (
      asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
      json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS renders (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      resolution TEXT NOT NULL,
      status TEXT NOT NULL,
      output_path TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      ops_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS style_profiles (
      id TEXT PRIMARY KEY,
      asset_ids_json TEXT NOT NULL,
      metrics_json TEXT NOT NULL,
      style_doc TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS video_observations (
      asset_id TEXT NOT NULL,
      analyzer TEXT NOT NULL,
      analyzer_version TEXT NOT NULL,
      observation_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (asset_id, analyzer, analyzer_version)
    );

    CREATE TABLE IF NOT EXISTS dissections (
      asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
      dissection_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    -- Client session logs, errors, and feedback. Durable even when the report
    -- never reaches GitHub, so nothing a user sent is lost; the fingerprint is
    -- the hashed error message repeat crashes are deduped on.
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      user_id TEXT,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      fingerprint TEXT,
      issue_number INTEGER,
      issue_url TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS reports_fingerprint_idx ON reports(fingerprint);

    -- 50ms RMS envelope per asset, for the waveform drawn inside timeline
    -- clips. Only ever populated for assets with no transcript energy to
    -- borrow, so it is a cache and never the primary copy.
    CREATE TABLE IF NOT EXISTS waveforms (
      asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
      waveform_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    -- Where the speaker's face sits over time, per source video, so captions
    -- can be placed off it. A cache: re-running the tracker rebuilds it.
    CREATE TABLE IF NOT EXISTS face_tracks (
      asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
      track_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  const transcriptColumns = database.prepare('PRAGMA table_info(transcripts)').all() as Array<{ name: string }>;
  if (!transcriptColumns.some((column) => column.name === 'energy_json')) {
    database.exec('ALTER TABLE transcripts ADD COLUMN energy_json TEXT');
  }

  // User scoping: NULL user_id means shared/global (pre-auth rows, the built-in
  // sound library) and stays visible to everyone; owned rows only to their owner.
  const projectColumns = database.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>;
  if (!projectColumns.some((column) => column.name === 'user_id')) {
    database.exec('ALTER TABLE projects ADD COLUMN user_id TEXT');
  }

  const assetColumns = database.prepare('PRAGMA table_info(assets)').all() as Array<{ name: string }>;
  if (!assetColumns.some((column) => column.name === 'label')) {
    database.exec('ALTER TABLE assets ADD COLUMN label TEXT');
  }
  // Imports respond before their proxy exists; anything already on disk is ready.
  if (!assetColumns.some((column) => column.name === 'status')) {
    database.exec("ALTER TABLE assets ADD COLUMN status TEXT NOT NULL DEFAULT 'ready'");
  }
  if (!assetColumns.some((column) => column.name === 'user_id')) {
    database.exec('ALTER TABLE assets ADD COLUMN user_id TEXT');
  }

  // Named style profiles: pre-existing rows have no name and fall back to a
  // date label in the service. The selected one lives in `settings`.
  const styleColumns = database.prepare('PRAGMA table_info(style_profiles)').all() as Array<{ name: string }>;
  if (!styleColumns.some((column) => column.name === 'name')) {
    database.exec('ALTER TABLE style_profiles ADD COLUMN name TEXT');
  }
  // Pluggable video analysis: which analyzer watched, its per-video rows, and
  // the folded template. Older profiles have none and read back as ffmpeg-only.
  for (const column of ['analyzer', 'observations_json', 'template_json']) {
    if (!styleColumns.some((existing) => existing.name === column)) {
      database.exec(`ALTER TABLE style_profiles ADD COLUMN ${column} TEXT`);
    }
  }

  // One agent turn is one run: every row it logs shares a run_id, so the whole
  // turn can be reverted as a unit. Client edits leave it NULL.
  // The state a report was sent from: project doc, recent ops, asset probes.
  // Stored beside the report so `npm run repro` works even when the bundle was
  // too large to inline on the issue.
  const reportColumns = database.prepare('PRAGMA table_info(reports)').all() as Array<{ name: string }>;
  if (!reportColumns.some((column) => column.name === 'repro_json')) {
    database.exec('ALTER TABLE reports ADD COLUMN repro_json TEXT');
  }

  // Post-render QA (loudness, dead air, mix levels) rides on the render row.
  const renderColumns = database.prepare('PRAGMA table_info(renders)').all() as Array<{ name: string }>;
  if (!renderColumns.some((column) => column.name === 'qa_json')) {
    database.exec('ALTER TABLE renders ADD COLUMN qa_json TEXT');
  }

  const operationLogColumns = database.prepare('PRAGMA table_info(operation_log)').all() as Array<{ name: string }>;
  if (!operationLogColumns.some((column) => column.name === 'run_id')) {
    database.exec('ALTER TABLE operation_log ADD COLUMN run_id TEXT');
  }
  database.exec('CREATE INDEX IF NOT EXISTS operation_log_run_idx ON operation_log(run_id)');

  // An undo row records the batch it retracted, so redo can put exactly that
  // batch back even when several undos are stacked. NULL on every other row.
  if (!operationLogColumns.some((column) => column.name === 'undo_target_batch_id')) {
    database.exec('ALTER TABLE operation_log ADD COLUMN undo_target_batch_id TEXT');
  }

  // Which project version a render exported, so a file can be matched to the
  // edit it shows. Written when the render starts; older rows stay NULL.
  if (!renderColumns.some((column) => column.name === 'project_version')) {
    database.exec('ALTER TABLE renders ADD COLUMN project_version INTEGER');
  }

  backfillProjectAssets(database);
}

/**
 * Projects that predate `project_assets` have no links, which would show them an
 * empty media library. Seed each one from the assets its timeline already uses.
 */
function backfillProjectAssets(database: EditifyDatabase): void {
  if ((database.prepare('SELECT COUNT(*) AS count FROM project_assets').get() as { count: number }).count > 0) return;
  const projects = database.prepare('SELECT id, doc_json FROM projects').all() as Array<{ id: string; doc_json: string }>;
  const known = new Set((database.prepare('SELECT id FROM assets').all() as Array<{ id: string }>).map((row) => row.id));
  const link = database.prepare('INSERT OR IGNORE INTO project_assets (project_id, asset_id, created_at) VALUES (?, ?, ?)');
  const now = new Date().toISOString();
  for (const project of projects) {
    // Read the ids straight out of the stored document — no schema import needed.
    for (const assetId of new Set([...project.doc_json.matchAll(/"assetId":"([^"]+)"/g)].map((match) => match[1]))) {
      if (assetId && known.has(assetId)) link.run(project.id, assetId, now);
    }
  }
}
