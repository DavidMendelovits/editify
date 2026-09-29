import type { EditifyDatabase } from './database.js';

/** A user's own copy of a setting is stored as `key:userId`. */
export function userKey(key: string, userId: string): string {
  return `${key}:${userId}`;
}

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

  /** A user's preference, falling back to the global one. No user reads the global key. */
  getFor(key: string, userId?: string): string | undefined {
    return (userId === undefined ? undefined : this.get(userKey(key, userId))) ?? this.get(key);
  }

  /** Writes the user's own copy; without a user it writes the global default. */
  setFor(key: string, value: string, userId?: string): void {
    this.set(userId === undefined ? key : userKey(key, userId), value);
  }
}
