import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { guardBundleScript, guardDsymScript, guardPostHogPhases, decodeShellScript, MARKER, SWITCH } = require('./with-posthog-upload-switch.js') as {
  guardBundleScript: (script: string) => string;
  guardDsymScript: (script: string) => string;
  guardPostHogPhases: (project: unknown) => string[];
  decodeShellScript: (value: string) => string;
  MARKER: string;
  SWITCH: string;
};

const POSTHOG = '`"$NODE_BINARY" --print "require(\'path\').join(require(\'path\').dirname(require.resolve(\'posthog-react-native\')), \'..\', \'tooling\', \'posthog-xcode.sh\')"`';
const RN = '`"$NODE_BINARY" --print "require(\'path\').dirname(require.resolve(\'react-native/package.json\')) + \'/scripts/react-native-xcode.sh\'"`';
/** The tail of the bundle phase as posthog-react-native/expo leaves it. */
const BUNDLE = `if [[ -f "$PODS_ROOT/../.xcode.env.local" ]]; then\n  source "$PODS_ROOT/../.xcode.env.local"\nfi\n\n${POSTHOG} ${RN}\n\n`;
const DSYM = '# Upload iOS dSYMs to PostHog so native crashes can be symbolicated.\nPODS_SCRIPT="${PODS_ROOT}/PostHog/build-tools/upload-symbols.sh"\n/bin/sh "$PODS_SCRIPT"';

describe('guardBundleScript', () => {
  it('runs the plain React Native script under the switch and the PostHog wrapper otherwise', () => {
    const guarded = guardBundleScript(BUNDLE);
    expect(guarded).toContain(MARKER);
    expect(guarded).toContain(`if [[ "\${${SWITCH}:-}" == "1" ]]; then\n  ${RN}\nelse\n  ${POSTHOG} ${RN}\nfi`);
    // Everything before the wrapper line is untouched.
    expect(guarded.startsWith('if [[ -f "$PODS_ROOT/../.xcode.env.local" ]]; then\n  source')).toBe(true);
  });

  it('is idempotent, and leaves a phase PostHog did not wrap alone', () => {
    const once = guardBundleScript(BUNDLE);
    expect(guardBundleScript(once)).toBe(once);
    const plain = `export PROJECT_ROOT="$PROJECT_DIR"/..\n${RN}\n`;
    expect(guardBundleScript(plain)).toBe(plain);
  });
});

describe('guardDsymScript', () => {
  it('exits before the upload under the switch', () => {
    const guarded = guardDsymScript(DSYM);
    expect(guarded.indexOf(`if [ "\${${SWITCH}:-}" = "1" ]; then`)).toBeLessThan(guarded.indexOf('upload-symbols.sh'));
    expect(guarded).toContain('  exit 0\nfi\n# Upload iOS dSYMs');
    expect(guardDsymScript(guarded)).toBe(guarded);
  });
});

describe('guardPostHogPhases', () => {
  it('guards both phases in a parsed project, reading quoted pbx strings with escapes or raw newlines', () => {
    const project = {
      hash: {
        project: {
          objects: {
            PBXShellScriptBuildPhase: {
              A: { name: '"Bundle React Native code and images"', shellScript: JSON.stringify(BUNDLE) },
              A_comment: 'Bundle React Native code and images',
              // How the PostHog plugin stores its own phase: literal newlines inside the quotes.
              B: { name: '"Upload PostHog Debug Symbols"', shellScript: `"${DSYM.replace(/"/g, '\\"')}"` },
              C: { name: '"[CP] Copy Pods Resources"', shellScript: '"\\"${PODS_ROOT}/x.sh\\"\\n"' },
            },
          },
        },
      },
    };
    const phases = project.hash.project.objects.PBXShellScriptBuildPhase;
    expect(guardPostHogPhases(project).sort()).toEqual(['Bundle React Native code and images', 'Upload PostHog Debug Symbols']);
    expect(decodeShellScript(phases.A.shellScript)).toBe(guardBundleScript(BUNDLE));
    expect(decodeShellScript(phases.B.shellScript)).toBe(guardDsymScript(DSYM));
    expect(phases.C.shellScript).toBe('"\\"${PODS_ROOT}/x.sh\\"\\n"');
  });
});
