import { execFile, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADAPTER_FLAGS, ADAPTER_RUNS } from './helpers/engine-adapters.js';

/*
 * Decision D24: the adapters harness (apps/mobile/modules/editify-engine/parity/adapters). The
 * composition root's choice (AdapterSelection) and the policies behind the ports, against stubs:
 * export admission with a stub scheduler; the Transcriber chain (fallthrough, the four speech
 * permission states, the C25 one-re-run-per-trigger rule with a failing model install); the
 * SFSpeech chunk plan, merge (rebase + overlap dedupe) and retry/timeout/cancel policy (C4);
 * TranscriptAssembler against the schema the SpeechAnalyzer path always produced (D10); and the
 * decoder's PTS origin (D19) on a clip it synthesizes. Built twice:
 *
 *   -D EDITIFY_TEST_ADAPTERS ──▶ run with no override  ┐ every check ok; the process runs the
 *                            └─▶ run with EDITIFY_ADAPTERS=legacy ┘ set it was asked for
 *   no flag (as Release) ──────▶ run with EDITIFY_ADAPTERS=legacy: the override is not compiled in
 *
 * Needs swiftc (macOS); elsewhere it skips, except where REQUIRE_SWIFT=1.
 */
const engine = resolve(fileURLToPath(import.meta.url), '../../../apps/mobile/modules/editify-engine');
const swiftAvailable = process.platform === 'darwin' && spawnSync('xcrun', ['--find', 'swiftc']).status === 0;
const required = process.env.REQUIRE_SWIFT === '1';
const run = promisify(execFile);

/** Core's ports and policies plus the Engine files free of UIKit, Photos and BackgroundTasks. */
const SOURCES = [
  'Core/EditifyCore', 'Core/Ports/DevicePorts', 'Core/Ports/SpeechPorts', 'Core/ExportAdmission', 'Core/Analysis', 'Core/AnalysisSupport',
  'Core/AnalysisMath', 'Core/AudioSync', 'Core/TranscriptAssembler', 'Core/SpeechChunks', 'Core/TranscriberChain',
  'Engine/AudioDecode', 'Engine/AdapterSelection', 'Engine/Adapters/ForegroundExecution',
].map((name) => join(engine, 'ios', `${name}.swift`));
const HARNESS = ['main.swift', 'SpeechChecks.swift'].map((name) => join(engine, 'parity/adapters', name));

interface Check { name: string; ok: boolean; detail?: string }
interface Report { compiled: { overrideCompiled: boolean }; checks: Check[] }

let dir: string | undefined;
const flagged = {} as Record<'modern' | 'legacy', Report>;
let unflagged: Report;

async function build(output: string, flags: string[]): Promise<void> {
  await run('xcrun', ['swiftc', '-O', '-swift-version', '5', ...flags, ...SOURCES, ...HARNESS, '-o', output], { maxBuffer: 16 << 20 });
}

async function report(binary: string, env: NodeJS.ProcessEnv): Promise<Report> {
  return JSON.parse((await run(binary, [], { encoding: 'utf8', env, maxBuffer: 16 << 20 })).stdout) as Report;
}

beforeAll(async () => {
  if (!swiftAvailable) return;
  dir = mkdtempSync(join(tmpdir(), 'editify-adapters-'));
  const withFlag = join(dir, 'adapters-test');
  const withoutFlag = join(dir, 'adapters-release');
  await Promise.all([build(withFlag, ADAPTER_FLAGS), build(withoutFlag, [])]);
  for (const { set, env } of ADAPTER_RUNS) flagged[set] = await report(withFlag, env);
  unflagged = await report(withoutFlag, ADAPTER_RUNS[1]!.env);
}, 300000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const failures = (value: Report): Check[] => value.checks.filter((check) => !check.ok);
const names = (value: Report): string[] => value.checks.map((check) => check.name);

describe('engine adapters: harness availability', () => {
  it.runIf(required)('has swiftc where REQUIRE_SWIFT=1', () => {
    expect(swiftAvailable).toBe(true);
  });
});

describe.skipIf(!swiftAvailable)('engine adapters (composition root and port policies on macOS)', () => {
  it.each(ADAPTER_RUNS)('passes every check with the $set set', ({ set }) => {
    expect(flagged[set].compiled.overrideCompiled).toBe(true);
    expect(failures(flagged[set])).toEqual([]);
    expect(names(flagged[set])).toContain('selection: this process (macOS 26+) runs the expected set');
  });

  it('selects modern on 26, legacy on 18 and under the override', () => {
    for (const name of ['selection: 26 picks the modern set', 'selection: 18 picks the legacy set', 'selection: the legacy override on 26 picks the legacy set',
      'override: read from the environment', 'override: read from a launch argument', 'override: read from simctl\'s -KEY value form']) {
      expect(names(flagged.modern), name).toContain(name);
    }
  });

  it('has no override without -D EDITIFY_TEST_ADAPTERS, even with EDITIFY_ADAPTERS=legacy set', () => {
    expect(unflagged.compiled.overrideCompiled).toBe(false);
    expect(names(unflagged)).toContain('override: absent without -D EDITIFY_TEST_ADAPTERS');
    expect(failures(unflagged)).toEqual([]);
  });

  it('admits a background export only with the entitlement and the gpu resource (stub scheduler)', () => {
    const admission = flagged.modern.checks.filter((check) => check.name.startsWith('admission: '));
    expect(admission.map((check) => check.name)).toEqual([
      'admission: entitlement + gpu resource → background',
      'admission: no entitlement → foreground, nothing registered',
      'admission: no gpu resource → foreground, nothing registered',
      'admission: a refused submit → foreground, the job\'s state reverted',
      'admission: an identifier registered before → foreground',
      'admission: ForegroundExecution → foreground with the keep-open notice',
    ]);
  });

  const group = (prefix: string): string[] => names(flagged.modern).filter((name) => name.startsWith(prefix));

  it('falls through the Transcriber chain: SpeechAnalyzer, SFSpeech, then unavailable (D20)', () => {
    expect(group('chain: ')).toHaveLength(7);
    expect(names(flagged.modern)).toContain('chain: a failed model download falls through to SFSpeech (not unavailable)');
  });

  it('handles the four speech permission states (D21)', () => {
    expect(group('auth ')).toEqual([
      'auth notDetermined: asks once on the first words run, then transcribes',
      'auth denied: unavailable, speech-off reason + Settings code, nothing transcribed',
      'auth restricted: unavailable, speech-off reason + Settings code, nothing transcribed',
      'auth authorized: transcribes without asking',
    ]);
  });

  it('re-runs a fallback transcript once per trigger and never loops on a failing model install (C25)', () => {
    expect(group('C25: ')).toEqual([
      'C25: after an OS update, a fallback result re-runs once; a failing model install doesn\'t loop',
      'C25: a model install re-runs once, and the best adapter\'s result then stays',
    ]);
  });

  it('chunks, merges and retries SFSpeech requests (D18, C4)', () => {
    expect(group('chunks: ').length + group('merge: ').length + group('phrases: ').length).toBe(7);
    expect(group('retry: ').length + group('timeout: ').length + group('cancel: ').length).toBe(5);
  });

  it('assembles the transcript schema exactly as before, the same from both adapters (D10)', () => {
    expect(group('assembler')).toHaveLength(3);
  });

  it('keeps the decoder\'s presentation-time origin: words at absolute times (D19)', () => {
    expect(group('decoder')).toEqual([
      'decoder: a whole-file read starts at 0 (the empty edit decodes as silence)',
      'decoder: a read starting 1.5 s in reports positions from 1.5 s, not 0 (D19)',
      'decoder fixture: words at absolute times (2.0 s, 3.25 s) through chunking and rebase',
    ]);
  });
});
