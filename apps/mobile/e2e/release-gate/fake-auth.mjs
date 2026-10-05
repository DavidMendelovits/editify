// Release gate only: a tiny local stand-in for Supabase auth (GoTrue), so gate builds sign in
// against local Editify servers and never touch production auth. ES256 JWTs + JWKS, one user
// (gate@editify.test / gate-local-pass, a local-only test login), and the admin user list the
// cutover importer's --user lookup calls. Run by servers.sh auth.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { exportJWK, generateKeyPair, importJWK, SignJWT } from 'jose';
import { join } from 'node:path';

const PORT = Number(process.env.PORT ?? 3164);
const BASE = `http://localhost:${PORT}`;
const USERS = new Map([['gate@editify.test', { id: '11111111-4141-4141-8141-141141141141', password: 'gate-local-pass' }]]);
// The key survives restarts (sessions stay valid across a fake-auth restart, e.g. mid upgrade E2E).
// It lives in the gate's scratch dir, never next to this file.
const KEYFILE = join(process.env.GATE_DIR ?? '.', 'fake-auth-key.json');
let privateKey, publicKey;
if (existsSync(KEYFILE)) { const k = JSON.parse(readFileSync(KEYFILE, 'utf8')); privateKey = await importJWK(k.priv, 'ES256'); publicKey = await importJWK(k.pub, 'ES256'); }
else { ({ privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true })); writeFileSync(KEYFILE, JSON.stringify({ priv: await exportJWK(privateKey), pub: await exportJWK(publicKey) })); }
const jwk = { ...(await exportJWK(publicKey)), alg: 'ES256', kid: 'gatelocal', use: 'sig' };
const refreshTokens = new Map();

function userObject(email, id) {
  const now = new Date().toISOString();
  return { id, aud: 'authenticated', role: 'authenticated', email, email_confirmed_at: now, confirmed_at: now,
    app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, identities: [], created_at: now, updated_at: now };
}

async function session(email, id) {
  const access = await new SignJWT({ role: 'authenticated', email, aud: 'authenticated' })
    .setProtectedHeader({ alg: 'ES256', kid: 'gatelocal' })
    .setIssuer(`${BASE}/auth/v1`).setSubject(id).setIssuedAt().setExpirationTime('12h').sign(privateKey);
  const refresh = randomUUID();
  refreshTokens.set(refresh, email);
  return { access_token: access, token_type: 'bearer', expires_in: 43200, expires_at: Math.floor(Date.now() / 1000) + 43200,
    refresh_token: refresh, user: userObject(email, id) };
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  console.log(req.method, url.pathname + url.search);
  if (req.method === 'OPTIONS') return send(res, 204);
  if (url.pathname === '/auth/v1/.well-known/jwks.json') return send(res, 200, { keys: [jwk] });
  if (url.pathname === '/auth/v1/token') {
    const grant = url.searchParams.get('grant_type');
    if (grant === 'password') {
      const user = USERS.get(body.email);
      if (!user || user.password !== body.password) return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials', code: 'invalid_credentials', msg: 'Invalid login credentials' });
      return send(res, 200, await session(body.email, user.id));
    }
    if (grant === 'refresh_token') {
      // Local only: any refresh token (including one minted before a restart) refreshes the one user.
      const email = refreshTokens.get(body.refresh_token) ?? [...USERS.keys()][0];
      return send(res, 200, await session(email, USERS.get(email).id));
    }
  }
  if (url.pathname === '/auth/v1/user') {
    const email = [...USERS.keys()][0];
    return send(res, 200, userObject(email, USERS.get(email).id));
  }
  if (url.pathname === '/auth/v1/admin/users') return send(res, 200, { users: [...USERS].map(([email, u]) => ({ id: u.id, email })) });
  if (url.pathname === '/auth/v1/logout') return send(res, 204);
  if (url.pathname === '/mint') {
    const email = [...USERS.keys()][0];
    return send(res, 200, await session(email, USERS.get(email).id));
  }
  return send(res, 404, { msg: 'not found' });
}).listen(PORT, () => console.log(`fake auth on ${BASE}`));
