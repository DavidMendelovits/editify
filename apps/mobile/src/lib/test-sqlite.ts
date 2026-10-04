/**
 * Test-only: a real SQLite engine behind the async slice of expo-sqlite the registry
 * uses, so migrations and queries run for real. better-sqlite3 rather than node:sqlite,
 * which needs Node 22.13+ (CI runs 20).
 */
import Database from 'better-sqlite3';
import type { SqlDb, SqlValue } from './local-media';

export function memoryDb(path = ':memory:'): SqlDb & { close(): void } {
  const db = new Database(path);
  return {
    execAsync: async (source) => { db.exec(source); },
    runAsync: async (source, ...params: SqlValue[]) => db.prepare(source).run(...params),
    getFirstAsync: async <T>(source: string, ...params: SqlValue[]) => (db.prepare(source).get(...params) as T | undefined) ?? null,
    getAllAsync: async <T>(source: string, ...params: SqlValue[]) => db.prepare(source).all(...params) as T[],
    withTransactionAsync: async (task) => {
      db.exec('BEGIN');
      try {
        await task();
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    close: () => db.close(),
  };
}
