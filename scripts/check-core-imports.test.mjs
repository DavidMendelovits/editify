// Run: node --test scripts/check-core-imports.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importedModules } from './check-core-imports.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const modules = (source) => importedModules(source).map(({ line, module }) => `${line}:${module}`);

/** Runs the lint on a throwaway Core directory holding one file with `source`. */
function lint(source) {
  const dir = mkdtempSync(path.join(tmpdir(), 'core-imports-'));
  writeFileSync(path.join(dir, 'Core.swift'), source);
  return spawnSync(process.execPath, [path.join(here, 'check-core-imports.mjs'), dir], { encoding: 'utf8' });
}

test('plain, attributed and kind imports', () => {
  assert.deepEqual(modules('import Foundation\n@preconcurrency import AVFoundation\nimport struct CoreMedia.CMTime\n@_exported import CoreImage'),
    ['1:Foundation', '2:AVFoundation', '3:CoreMedia', '4:CoreImage']);
});

test('access-level imports (SE-0409) are read, alone and after attributes', () => {
  assert.deepEqual(modules([
    'public import Foundation', 'package import UIKit', 'internal import Speech', 'fileprivate import Vision', 'private import Photos',
    '@preconcurrency internal import AVFoundation', 'public import struct CoreMedia.CMTime',
  ].join('\n')), ['1:Foundation', '2:UIKit', '3:Speech', '4:Vision', '5:Photos', '6:AVFoundation', '7:CoreMedia']);
});

test('several imports on one line split on ;', () => {
  assert.deepEqual(modules('import Foundation; import AVFoundation;internal import Metal'), ['1:Foundation', '1:AVFoundation', '1:Metal']);
});

test('comments and non-import declarations are not imports', () => {
  assert.deepEqual(modules('// import UIKit\nimport Foundation // import Metal\nlet important = 1\npublic struct Imported {}'), ['2:Foundation']);
});

test('the CLI fails on a disallowed access-level or same-line import and names the line', () => {
  const accessLevel = lint('import Foundation\ninternal import AVFoundation\n');
  assert.equal(accessLevel.status, 1);
  assert.match(accessLevel.stderr, /Core\.swift:2: imports AVFoundation/);
  const sameLine = lint('import Foundation; import AVFoundation\n');
  assert.equal(sameLine.status, 1);
  assert.match(sameLine.stderr, /Core\.swift:1: imports AVFoundation/);
  const ok = lint('public import Foundation; import CoreMedia\n');
  assert.equal(ok.status, 0, ok.stderr);
});

test('the real Core passes', () => {
  const run = spawnSync(process.execPath, [path.join(here, 'check-core-imports.mjs')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
});
