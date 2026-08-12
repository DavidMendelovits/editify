import type { EditifyDatabase } from './database.js';

/** Key/value scratch space for server-side preferences that must survive a restart. */
export class SettingsStore {
  constructor(private readonly database: EditifyDatabase) {}

  get(key: string): string | undefined {
    const row = this.database.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  set(key: string, value: string): void {
    this.database.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }
}
