// Run: node --test scripts/check-fly-drift.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { drift } from './check-fly-drift.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => `scripts/fixtures/fly-drift/${name}`;
const read = (name) => readFileSync(path.join(here, '..', fixture(name)), 'utf8');
const cli = (...args) => spawnSync(process.execPath, [path.join(here, 'check-fly-drift.mjs'), ...args], { encoding: 'utf8' });

test('allowed differences pass: app, PUBLIC_BASE_URL, LINE, mount source, 1.1-only DATABASE_SCHEMA', () => {
  assert.deepEqual(drift(read('fly.toml'), read('allowed.v11.toml')), []);
  const run = cli(fixture('fly.toml'), fixture('allowed.v11.toml'));
  assert.equal(run.status, 0, run.stderr);
});

test('drift fails and names each offending line', () => {
  const found = drift(read('fly.toml'), read('drifted.v11.toml')).map((d) => `${d.side}:${d.line} ${d.text}`);
  assert.deepEqual(found, [
    'base:7 [env] PORT = "3001"',
    'line:7 [env] PORT = "3002"',
    'line:17 [env] RENDER_PLAN = "1"',
    'base:40 [vm] memory = "4gb"',
    'line:43 [vm] memory = "8gb"',
  ]);
  const run = cli(fixture('fly.toml'), fixture('drifted.v11.toml'));
  assert.equal(run.status, 1);
  assert.match(run.stderr, /only in scripts\/fixtures\/fly-drift\/drifted\.v11\.toml: \[vm\] memory = "8gb"/);
});

test('an allowed key outside its section is drift', () => {
  const base = 'app = "a"\n[env]\n  PORT = "1"\n';
  assert.deepEqual(drift(base, 'app = "b"\n[env]\n  PORT = "1"\n'), []);
  assert.equal(drift(base, 'app = "b"\n[env]\n  PORT = "1"\n  source = "x"\n').length, 1);
  assert.equal(drift('[build]\n  app = "a"\n', '[build]\n  app = "b"\n').length, 2);
});

test('DATABASE_SCHEMA may only be in the 1.1 file', () => {
  const v11 = 'app = "b"\n[env]\n  DATABASE_SCHEMA = "v11"\n';
  assert.deepEqual(drift('app = "a"\n[env]\n', v11), []);
  assert.equal(drift('app = "a"\n[env]\n  DATABASE_SCHEMA = "v11"\n', v11).length, 1);
});

test('a missing allowed key is still drift', () => {
  assert.equal(drift('app = "a"\n[env]\n  LINE = "1.0"\n', 'app = "b"\n[env]\n').length, 1);
});

test('comments and blank lines are ignored', () => {
  assert.deepEqual(drift('# one\napp = "a"\n\n[env]\n  X = "1"\n', 'app = "b"\n[env]\n  # two\n  X = "1"\n'), []);
});

test('passes when the 1.1 file is absent (main)', () => {
  const run = cli(fixture('fly.toml'), fixture('missing.v11.toml'));
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /absent/);
});
