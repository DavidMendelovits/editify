/*
 * The engine harnesses' adapter wiring (decision D24). Each harness is compiled with
 * -D EDITIFY_TEST_ADAPTERS, so the composition root's EDITIFY_ADAPTERS override is in the
 * binary, and run once per adapter set: the default (the modern set on a macOS 26 host) and
 * EDITIFY_ADAPTERS=legacy (the iOS 18 set). Every run reports the adapters it built
 * (`adapterReport()` in parity/render-golden/HarnessMedia.swift) and the tests assert the names.
 */

/** Flags every harness build passes. Release app builds never set this condition. */
export const ADAPTER_FLAGS = ['-D', 'EDITIFY_TEST_ADAPTERS'];

/** The composition root's selection plus both VideoComposition adapters (paths under ios/, no extension). */
export const ADAPTER_SOURCES = [
  'Core/EditifyCore', 'Core/Ports/VideoComposition', 'Engine/AdapterSelection',
  'Engine/Adapters/ConfigurationVideoComposition', 'Engine/Adapters/MutableVideoComposition',
];

export interface AdapterReport { set: 'modern' | 'legacy'; videoComposition: 'configuration' | 'mutable'; overrideCompiled: boolean }

export interface AdapterRun { set: AdapterReport['set']; env: NodeJS.ProcessEnv; expected: AdapterReport }

/** Both sets, default first. `env` is the whole environment for the harness process. */
export const ADAPTER_RUNS: AdapterRun[] = [
  { set: 'modern', env: withoutOverride(), expected: { set: 'modern', videoComposition: 'configuration', overrideCompiled: true } },
  { set: 'legacy', env: { ...withoutOverride(), EDITIFY_ADAPTERS: 'legacy' }, expected: { set: 'legacy', videoComposition: 'mutable', overrideCompiled: true } },
];

function withoutOverride(): NodeJS.ProcessEnv {
  const { EDITIFY_ADAPTERS: _ignored, ...rest } = process.env;
  return rest;
}
