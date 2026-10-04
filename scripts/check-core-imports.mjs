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
export const ALLOWED = new Set(['Foundation', 'CoreMedia', 'CoreGraphics', 'CoreText', 'CoreImage', 'ImageIO', 'Accelerate', 'CryptoKit', 'Darwin']);

// One import declaration: `import X`, `import X.Y`, `import struct X.Y`, with any attributes
// (`@preconcurrency`, `@_exported`, `@testable`) and an access level (`public import X`,
// `internal import X`, Swift 6 / SE-0409).
const IMPORT = /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|package|internal|fileprivate|private)\s+)?import\s+(?:(?:typealias|struct|class|enum|protocol|let|var|func)\s+)?([A-Za-z_][\w]*)/;

/**
 * Every module a Swift source imports, with its 1-based line. Statements are split on `;`, so
 * `import Foundation; import AVFoundation` reports both; anything after `//` is ignored.
 */
export function importedModules(source) {
  return source.split('\n').flatMap((line, index) => line.replace(/\/\/.*$/, '').split(';').flatMap((statement) => {
    const module = IMPORT.exec(statement)?.[1];
    return module ? [{ line: index + 1, module }] : [];
  }));
}

function swiftFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return swiftFiles(path);
    return name.endsWith('.swift') ? [path] : [];
  });
}

function main() {
  const core = process.argv[2] ?? join(repo, 'apps/mobile/modules/editify-engine/ios/Core');
  const files = swiftFiles(core);
  if (!files.length) {
    console.error(`no Swift files under ${core}`);
    process.exit(1);
  }

  const problems = [];
  for (const file of files) {
    for (const { line, module } of importedModules(readFileSync(file, 'utf8'))) {
      if (!ALLOWED.has(module)) problems.push(`${relative(repo, file)}:${line}: imports ${module}`);
    }
  }

  if (problems.length) {
    console.error(`EditifyCore may import only ${[...ALLOWED].join(', ')}.`);
    console.error('Move the code that needs these into an EditifyEngine adapter behind a port:');
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log(`EditifyCore imports OK (${files.length} files).`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
