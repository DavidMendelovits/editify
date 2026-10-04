// Fails the build when an EditifyCore source imports a framework outside Core's allowlist
// (decision D4): Core is the domain and the port protocols; AVFoundation, Speech,
// SoundAnalysis, Vision, BackgroundTasks, Photos, UIKit, Metal, VideoToolbox and
// ExpoModulesCore belong to the EditifyEngine adapters.
//
//   node scripts/check-core-imports.mjs [core dir]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const core = process.argv[2] ?? join(repo, 'apps/mobile/modules/editify-engine/ios/Core');

const ALLOWED = new Set(['Foundation', 'CoreMedia', 'CoreGraphics', 'CoreText', 'CoreImage', 'ImageIO', 'Accelerate', 'CryptoKit', 'Darwin']);

// `import X`, `import X.Y`, `import struct X.Y`, with any attributes (`@preconcurrency`, `@_exported`, `@testable`).
const IMPORT = /^\s*(?:@\w+(?:\([^)]*\))?\s+)*import\s+(?:(?:typealias|struct|class|enum|protocol|let|var|func)\s+)?([A-Za-z_][\w]*)/;

function swiftFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return swiftFiles(path);
    return name.endsWith('.swift') ? [path] : [];
  });
}

const files = swiftFiles(core);
if (!files.length) {
  console.error(`no Swift files under ${core}`);
  process.exit(1);
}

const problems = [];
for (const file of files) {
  readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
    const module = IMPORT.exec(line)?.[1];
    if (module && !ALLOWED.has(module)) problems.push(`${relative(repo, file)}:${index + 1}: imports ${module}`);
  });
}

if (problems.length) {
  console.error(`EditifyCore may import only ${[...ALLOWED].join(', ')}.`);
  console.error('Move the code that needs these into an EditifyEngine adapter behind a port:');
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`EditifyCore imports OK (${files.length} files).`);
