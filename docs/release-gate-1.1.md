# Release gate for 1.1 builds

Pass this before every 1.1 TestFlight or ad hoc build from `release/1.1` (plan tasks T11 and T19, decisions C10, C16, C24). It takes about an hour, most of it builds and exports. Everything runs on simulators against local servers: no step touches production auth, the production API, or a physical phone.

Record the commit, the date and pass/fail per section in the build's PR or release notes. Evidence (screenshots, recordings) goes to `$GATE_DIR/evidence`, never into git.

## 1. CI is green on the commit

All jobs in `ci.yml` pass on the release/1.1 push for the commit you build: `check`, `plan-render-runtime`, `changes`, `engine`, `app`, then `deploy` (editify-v11 + post-deploy smoke) and `preview` (EAS OTA or build on `preview-1.1`).

- Known flakes, both in the `engine` job: "Native preview (PlanPlayer, OV10)" and "Renderer golden frames". Rerun the failed jobs once (`gh run rerun <run-id> --failed`). A second failure is real.
- A red flake is not harmless: `deploy` and `preview` need `engine`, so they are skipped. After a green rerun, check that `deploy` and `preview` actually ran for this commit, and rerun them if they show as skipped.

## 2. Simulator E2E flows

Scripts live in `apps/mobile/e2e/release-gate/`. The `.ad` files are agent-device replays; the shell scripts build apps, run the local servers and the cutover import.

### Setup (once per gate)

```
export GATE_DIR=~/editify-gate                # data dirs, logs, apps (keeps the stored 1.0 build between gates), evidence
export V11_WT=<a checkout of release/1.1 at the commit you build>
export V10_WT=<a checkout of the 1.0 line, e.g. origin/main>   # for the stored 1.0 build and server
G=$V11_WT/apps/mobile/e2e/release-gate
mkdir -p $GATE_DIR/evidence

# Apps: the 1.1 build every gate; the stored 1.0 build only when the 1.0 binary changed.
$G/build-app.sh "$V11_WT" v11 3163            # -> $GATE_DIR/apps/Editify-v11-<sha>.app
$G/build-app.sh "$V10_WT" v10 3161            # -> $GATE_DIR/apps/Editify-v10-<sha>.app
APP_11=$(ls -d $GATE_DIR/apps/Editify-v11-*.app); APP_10=$(ls -d $GATE_DIR/apps/Editify-v10-*.app)

# Servers: fake Supabase auth :3164, 1.0 :3161, 1.1 :3163 (RENDER_PLAN=1, TEST_SERVER=1, LINE=1.1).
$G/servers.sh auth && $G/servers.sh v10 && $G/servers.sh v11

# Simulators: an iOS 18.0 one, an iOS 26.5 one, and an iOS 18.0 one for the upgrade.
S18=$(xcrun simctl create "gate iOS18" "iPhone 16" com.apple.CoreSimulator.SimRuntime.iOS-18-0)
S26=$(xcrun simctl create "gate iOS26" "iPhone 17" com.apple.CoreSimulator.SimRuntime.iOS-26-5)
U18=$(xcrun simctl create "gate upgrade iOS18" "iPhone 16" com.apple.CoreSimulator.SimRuntime.iOS-18-0)
for u in $S18 $S26 $U18; do xcrun simctl boot $u; xcrun simctl addmedia $u <a ~1 min speech clip>.mp4; done
```

`build-app.sh` fails unless the bundle carries `http://localhost:3164` and the API port and no `*.supabase.co` or `editify-v11.fly.dev` URL. It already handles the build gotchas: shell `EXPO_PUBLIC_*` is ignored by local Release builds (it writes `ios/.xcode.env.local`), a shared Metro cache bakes stale URLs (fresh TMPDIR + `--reset-cache`), `EXUpdatesEnabled` NO, `EDITIFY_SKIP_POSTHOG_UPLOAD=1`, ad hoc signing (`CODE_SIGN_IDENTITY=-`).

Run the flows with `agent-device test`, not `replay`: a replay is one daemon request with a 90 s client limit, and a timed-out request kills the runner under any other flow in flight. `test` has no limit of its own, so give it `--timeout` and wrap it in a hard one; pin every command to one simulator and run the flows one at a time, c and d before a and b (a and b add projects for the same user, and a half-done one carries the label c2 taps).

```
ad() { local t=$1; shift; perl -e 'alarm shift; exec @ARGV' $t agent-device "$@"; }
gate() { local f=$1 udid=$2; shift 2; ad 1000 test $G/$f --platform ios --udid $udid --timeout 900000 \
  --artifacts-dir $GATE_DIR/runs/${f%.ad} --report-junit $GATE_DIR/runs/${f%.ad}/junit.xml -e EVIDENCE=$GATE_DIR/evidence "$@"; }
CLIP="Video, fifty-three seconds, January 15, 12:00 PM"   # the picker label: check with `agent-device snapshot -i` in the picker
```

If a step times out twice, mark that flow FAILED with its last screenshot and go on.

### a. iOS 18.0: speech words, edit, on-device export

```
gate a-ios18-words-export.ad $S18 -e APP_11=$APP_11 -e "CLIP_LABEL=$CLIP"
plutil -p "$(xcrun simctl get_app_container $S18 com.editify.app data)/Library/Preferences/com.editify.app.plist" | grep transcriber
grep -a -o 'w-sf[0-9]' $APP_11/Editify
```

Pass: sign in; import; the words run comes back not asked and the speech pre-prompt shows; continue, then Allow on the system alert; `editify.transcriber.lastRan` is `sfspeech` and the build's SFSpeech words version is `w-sf2`; the edit lands (2 clips); 720p on-device export in the foreground ends in SAVED TO PHOTOS (`ffprobe` the newest file in the sim's `data/Media/DCIM` shows 720x1280).

### b. iOS 26.5: export, then finish on server

```
gate b-ios26-export-finish-on-server.ad $S26 -e APP_11=$APP_11 -e "CLIP_LABEL=$CLIP"
grep '\[render\] rendered from the plan' $GATE_DIR/server-v11.log
```

Speech engines don't run on the 26.5 simulator, so words are skipped (the pre-prompt gets "not now"). Pass: sign in, import, edit, a 720p on-device export saved to Photos; a 1080p export backgrounded mid-run shows "Export stopped: Editify went to the background" with "finish on server"; tapping it ends in DONE, and the 1.1 server log has `[render] rendered from the plan` (RENDER_PLAN=1).

### c. Upgrade in place (C10)

```
gate c1-upgrade-v10-setup.ad $U18 -e APP_10=$APP_10 -e "CLIP_LABEL=$CLIP"
$G/cutover-local.sh                     # snapshot, import --user gate@editify.test, dry-run: 0 diffs
xcrun simctl terminate $U18 com.editify.app; xcrun simctl install $U18 $APP_11   # over 1.0, no uninstall
gate c2-upgrade-v11-check.ad $U18
```

Pass: 1.0 is signed in with a project; the single-user cutover import between the local 1.0 and 1.1 data dirs (RUNBOOK section 2 with `--source-dir`) ends with `0 diff(s)`; after installing 1.1 over 1.0 the app is still signed in, shows no update gate (1.1 server minVersion 1.0.0), and the 1.0 project is listed and opens.

### d. Update gate on 1.0 (C16)

```
$G/servers.sh v10 MIN_APP_VERSION=1.1.0
gate d-gate-v10-update.ad $U18 -e APP_10=$APP_10
$G/servers.sh v10                        # back to minVersion 1.0.0
```

Pass: the 1.0 build shows "Update Editify" with "Update on the App Store".

### Cleanup

`$G/servers.sh stop`, `xcrun simctl delete $S18 $S26 $U18`, and delete `$GATE_DIR/dd-*` (2 to 3 GB each).

## 3. Cutover tooling dry run on local fixtures

```
cd $V11_WT/server && npx vitest run test/cutover.test.ts test/cutover-agent.test.ts
```

Plus flow c above (a real 1.0 server's data through `snapshot`, `import --user`, `dry-run --user`). Exit codes: 0 ok, 1 dry-run diff, 2 error, 3 import failures (`cutover.ts failures`), 4 not enough space.

## 4. Deploy smoke

The `deploy` job's "Smoke the deployed app" step passed for this commit (`scripts/deploy-smoke.sh`: `/health` names `line=1.1` and the commit, `/client-config` serves the gate, unauthenticated `/projects` is 401, the smoke user's `/projects` is 200). To rerun by hand: `URL=https://editify-v11.fly.dev APP=editify-v11 CONFIG=fly.v11.toml LINE=1.1 COMMIT=<sha> ./scripts/deploy-smoke.sh`. A warning that SMOKE_EMAIL is unset means the authenticated checks were skipped: fix that before a build goes to testers.

## 5. Flags and secrets on editify-v11

Check names only (`fly secrets list -a editify-v11`), never print values.

| Name | Where | Expected for TestFlight / ad hoc | Expected for App Store submission |
|---|---|---|---|
| `TEST_SERVER` | `[env]` in fly.v11.toml, a secret overrides | `1` (TestFlight banner on) | secret `TEST_SERVER=0` before submitting (C8) |
| `RENDER_PLAN` | `[env]` | `1` (finish on server uses the plan render); rollback `fly secrets set RENDER_PLAN=0` | `1` |
| `NATIVE_PREVIEW` | server env, remote kill switch for the native preview | unset (on); `0` turns it off on builds with `EXPO_PUBLIC_NATIVE_PREVIEW=1` | unset |
| `EXPO_PUBLIC_NATIVE_PREVIEW` | eas.json `preview-1.1` only | `1` on preview-1.1, absent on production-1.1 (eas-profiles test) | absent |
| `SUPABASE_SERVICE_ROLE_KEY` | secret | set (account deletion, cutover `--user` lookups) | set |
| `GITHUB_TOKEN` | secret | set (feedback reports file issues) | set |

The smoke's secrets check runs with `STRICT_SECRETS=0` while editify-v11 is provisioned, so a missing one only warns: read the deploy log.

## 6. EAS device registration (ad hoc builds)

Ad hoc (`preview-1.1`, internal distribution) builds only install on devices in the provisioning profile. Before the build: `cd apps/mobile && eas device:list`, register new testers with `eas device:create`, then build (`eas build --profile preview-1.1 --platform ios`). A device registered after the build needs a new build; an OTA does not add it. TestFlight builds (`production-1.1`) don't need this.

## 7. Not verified on a real phone

Simulators can't cover these. Each is open until it has been checked on a physical device (or crash data), and a build note should say so:

- iOS 26 speech: SpeechAnalyzer words (`w-sa1`) and the trigger-based re-run. The 26.5 simulator runs no speech engine.
- Background GPU export on iOS 26 (continued processing): the simulator stops the export when the app leaves the foreground, so only the "finish on server" path is gated here.
- A12 RAM tiers: the tier thresholds (export route, 540p proxy, 720p preview, chunked decode) are unmeasured on an A12 phone.
- Capability lab gates S1, S4 and S5.
- 4K HLG originals over 2 GB: import, proxy and export.
