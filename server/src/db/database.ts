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
  `);
}
