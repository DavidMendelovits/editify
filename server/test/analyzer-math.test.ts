import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/*
 * Plan 7A: the analyzer arithmetic the phone runs (AnalysisMath.swift: energy
 * cells, onset peaks, laughter merging, face-box padding, crop placement,
 * proxy size) checked on macOS by its own smoke runner. Linux skips, except
 * where REQUIRE_SWIFT=1 (the macOS CI `engine` job): there a missing toolchain fails.
 */
const engine = resolve(fileURLToPath(import.meta.url), '../../../apps/mobile/modules/editify-engine');
const hasSwift = process.platform === 'darwin' && spawnSync('xcrun', ['--find', 'swiftc']).status === 0;
const required = process.env.REQUIRE_SWIFT === '1';
let dir: string | undefined;

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

it.runIf(required)('has swiftc where REQUIRE_SWIFT=1', () => {
  expect(hasSwift).toBe(true);
});

describe.skipIf(!hasSwift)('AnalysisMath.swift smoke checks', () => {
  it('passes every check', () => {
    dir = mkdtempSync(join(tmpdir(), 'editify-analyzer-math-'));
    const binary = join(dir, 'analyzer-math');
    execFileSync('xcrun', ['swiftc', '-O', join(engine, 'ios/Core/AnalysisMath.swift'), join(engine, 'parity/analyzer-math/main.swift'), '-o', binary]);
    const run = spawnSync(binary, { encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(run.stdout.trim()).toBe('ok');
  }, 120000);
});
