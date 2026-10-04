// posthog-react-native/expo adds two build phases that upload to PostHog: the JS bundle phase
// runs through posthog-xcode.sh (Hermes source maps, which needs posthog-cli and credentials),
// and "Upload PostHog Debug Symbols" uploads the dSYMs. A build with no PostHog credentials (the
// CI app build, plan D23) fails in both.
//
// This puts both behind a build-time switch: EDITIFY_SKIP_POSTHOG_UPLOAD=1 in the environment (or
// as an xcodebuild build setting) bundles the JS with React Native's own script and skips the
// dSYM upload. Unset, both phases run exactly as the PostHog plugin wrote them, so EAS builds keep
// uploading. Listed after posthog-react-native/expo in app.json; it runs as a finalized mod, after
// every xcodeproj mod, so the phases it guards are already written.
const { withFinalizedMod, IOSConfig } = require('expo/config-plugins');

const SWITCH = 'EDITIFY_SKIP_POSTHOG_UPLOAD';
const MARKER = '# editify: posthog upload switch';
const BUNDLE_PHASE = 'Bundle React Native code and images';
const DSYM_PHASE = 'Upload PostHog Debug Symbols';
// The PostHog wrapper's line: `<posthog-xcode.sh>` followed by the command it wraps.
const WRAPPED = /^([ \t]*)(`[^`\n]*posthog-xcode\.sh[^`\n]*`)[ \t]+([^\n]+)$/m;

/**
 * The bundle phase with the PostHog wrapper behind the switch. Already-guarded and unwrapped
 * scripts come back unchanged.
 * @param {string} script
 * @returns {string}
 */
function guardBundleScript(script) {
  if (script.includes(MARKER)) return script;
  const match = WRAPPED.exec(script);
  if (!match) return script;
  const [line, indent, , wrapped] = match;
  const guarded = [
    `${indent}${MARKER}: ${SWITCH}=1 bundles without uploading source maps (a build with no PostHog credentials).`,
    `${indent}if [[ "\${${SWITCH}:-}" == "1" ]]; then`,
    `${indent}  ${wrapped}`,
    `${indent}else`,
    `${indent}  ${line.trimStart()}`,
    `${indent}fi`,
  ].join('\n');
  return script.replace(line, guarded);
}

/**
 * The dSYM upload phase, exiting first when the switch is on.
 * @param {string} script
 * @returns {string}
 */
function guardDsymScript(script) {
  if (script.includes(MARKER)) return script;
  return [
    `${MARKER}: ${SWITCH}=1 skips the dSYM upload (a build with no PostHog credentials).`,
    `if [ "\${${SWITCH}:-}" = "1" ]; then`,
    `  echo "${SWITCH}=1: skipping the PostHog dSYM upload"`,
    '  exit 0',
    'fi',
    script,
  ].join('\n');
}

/**
 * A pbxproj shellScript value as the script text: quoted, with \" \\ \n \t escapes (the
 * PostHog plugin writes its dSYM phase with literal newlines inside the quotes, which this also reads).
 * @param {string} value
 * @returns {string}
 */
function decodeShellScript(value) {
  const inner = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
  return inner.replace(/\\(.)/gs, (_, c) => ({ n: '\n', t: '\t', r: '\r' })[c] ?? c);
}

/**
 * Guards the PostHog phases of a parsed Xcode project in place. Returns the phase names guarded.
 * @param {{ hash: { project: { objects: Record<string, Record<string, any>> } } }} project
 * @returns {string[]}
 */
function guardPostHogPhases(project) {
  const phases = project.hash.project.objects.PBXShellScriptBuildPhase ?? {};
  const guarded = [];
  for (const phase of Object.values(phases)) {
    if (typeof phase !== 'object' || typeof phase.shellScript !== 'string') continue;
    const name = String(phase.name ?? '').replace(/^"|"$/g, '');
    const transform = name === BUNDLE_PHASE ? guardBundleScript : name === DSYM_PHASE ? guardDsymScript : undefined;
    if (!transform) continue;
    const before = decodeShellScript(phase.shellScript);
    const after = transform(before);
    if (after.includes(MARKER)) guarded.push(name);
    if (after !== before) phase.shellScript = JSON.stringify(after);
  }
  return guarded;
}

/** @type {import('expo/config-plugins').ConfigPlugin} */
const withPostHogUploadSwitch = (config) =>
  withFinalizedMod(config, [
    'ios',
    async (config) => {
      const project = IOSConfig.XcodeUtils.getPbxproj(config.modRequest.projectRoot);
      const guarded = guardPostHogPhases(project);
      if (guarded.length < 2) {
        console.warn(`[with-posthog-upload-switch] guarded ${guarded.join(', ') || 'no phases'}; the PostHog phases changed shape, so ${SWITCH}=1 may not skip them.`);
      }
      require('node:fs').writeFileSync(IOSConfig.Paths.getPBXProjectPath(config.modRequest.projectRoot), project.writeSync());
      return config;
    },
  ]);

module.exports = withPostHogUploadSwitch;
module.exports.guardBundleScript = guardBundleScript;
module.exports.guardDsymScript = guardDsymScript;
module.exports.guardPostHogPhases = guardPostHogPhases;
module.exports.decodeShellScript = decodeShellScript;
module.exports.MARKER = MARKER;
module.exports.SWITCH = SWITCH;
