import type pg from 'pg';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A user id, or an email looked up in Supabase auth (Postgres first, then the admin API). */
export async function resolveUser(value: string, pool: pg.Pool | undefined, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (UUID.test(value)) return value.toLowerCase();
  if (!value.includes('@')) throw new Error(`--user takes a user id or an email, not "${value}"`);
  if (pool) {
    const { rows } = await pool.query<{ id: string }>('SELECT id::text AS id FROM auth.users WHERE lower(email) = lower($1)', [value]);
    if (rows.length === 1 && rows[0]) return rows[0].id;
    if (rows.length > 1) throw new Error(`More than one auth user has the email ${value}`);
  }
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error(`No user with the email ${value} found, and SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set to ask the admin API`);
  for (let page = 1; page <= 100; page += 1) {
    const response = await fetch(`${url}/auth/v1/admin/users?page=${page}&per_page=1000`, { headers: { apikey: key, authorization: `Bearer ${key}` } });
    if (!response.ok) throw new Error(`Supabase admin user list failed (${response.status})`);
    const { users } = await response.json() as { users: Array<{ id: string; email?: string }> };
    const match = users.find((user) => user.email?.toLowerCase() === value.toLowerCase());
    if (match) return match.id;
    if (users.length < 1000) break;
  }
  throw new Error(`No Supabase user has the email ${value}`);
}
