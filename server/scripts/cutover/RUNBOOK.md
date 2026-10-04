# 1.0 to 1.1 cutover runbook

The importer for release/1.1 plan tasks T9 and T16 (decisions D14, D15, C3, C6, C8, C11, C18, C19, C20, C21, C22). Every step that touches production is a command for a human to run. Nothing in this repo runs against editify-dm or editify-v11 by itself.

```
 editify-dm (1.0, prod)                          editify-v11 (1.1)
 /data: editify.db + assets/ renders/ sounds/... /data: editify.db + the same tree
 ───────────────────────────────────────         ──────────────────────────────────────────────
 source-agent.mjs serve                          cutover.ts (importer.ts)
   bound to fly-local-6pn:7373 ◀──── 6PN ──────    http://editify-dm.internal:7373, CUTOVER_TOKEN
   read-only: du, manifest (sha256),
   files, backup API snapshots

 BEFORE LAUNCH
   MUTATION_JOURNAL=1 on editify-dm (C19; off in production until set) ─▶ measure, size editify_v11_data at 1.5x (C11)
   beta: snapshot ─▶ import --user <email> (tag beta_copy, C8/C18) ─▶ dry-run --user <email>
   submit 1.1: TEST_SERVER=0 secret on editify-v11 (hides the TestFlight banner from App Review)
 LAUNCH
   snapshot (J = newest journal id in it) ─▶ copy --all (verified, space-checked) ─▶ import --all
     (per user, one transaction: beta_copy rows out, 1.0 rows in, only if all their files verified)
   ─▶ dry-run --all = 0 diffs ─▶ backup-1.1 + fly volume snapshot + pg_dump v11 (C22)
   ─▶ release 1.1 on the App Store
   ─▶ drain 1.0 ─▶ restart writable (WAL checkpoint) ─▶ READ_ONLY=1 on editify-dm (C20)
   ─▶ delta (fresh snapshot, new media copied, journal id > J replayed) ─▶ dry-run --all = 0 diffs
   ─▶ /client-config minVersion=1.1.0 on editify-dm (C16/C17)
   ─▶ drop TEST_SERVER from fly.v11.toml when it folds into fly.toml (C14)
 AFTER: recovery is forward (C22). Un-freezing 1.0 is only a pre-release no-go.
```

## Where each kind of 1.0 data lands in 1.1

1.1 still reads projects, media and everything else from its own SQLite (`/data/editify.db` on editify-v11), through the same stores as 1.0; the mobile 1.1 app calls `/projects`, not `/sync`. The 1.1 SQLite schema is 1.0's plus two nullable render columns (`snapshot_json`, `snapshot_hash`), so every 1.0 table maps one to one.

| 1.0 store | 1.1 destination | Scope |
|---|---|---|
| `projects`, `operation_log`, `project_assets`, `renders`, `chat_messages` | same tables, v11 SQLite | the project's `user_id` |
| `assets`, `transcripts`, `insights`, `dissections`, `waveforms`, `face_tracks`, `video_observations` | same tables, v11 SQLite | the asset's `user_id` |
| `style_profiles`, `reports` | same tables, v11 SQLite | `user_id` |
| `settings` | same table | `key:<userId>` is that user's, other keys are global |
| `webhook_events` | same table | global (deleted users' events) |
| NULL-owner rows (pre-auth projects and assets, the `sound-*` library, orphan observations) | same tables | the shared scope, full cutover only |
| media: `assets/<id>/` (original, proxy, thumb, filmstrip), `renders/<id>/` (output, captions, contact sheet) | `/data/assets`, `/data/renders` on editify_v11_data | with their rows |
| media: `sounds/`, `emoji/`, `callouts/`, `luts/`, `models/`, `user-insights.md` | same paths | shared scope |
| `mutations` (the C19 journal) | not copied; the delta replays it | |

Paths: `original_path`, `proxy_path`, `thumbnail_path`, `output_path`, and any quoted absolute path inside JSON columns, are rewritten from `--source-root` to the 1.1 root. On Fly both are `/data`, so in production the rewrite is a no-op; a local rehearsal exercises it.

Bookkeeping lives in the v11 SQLite next to the data: `import_failures` (user, asset, path, reason), `import_ledger` (every root row imported, owner, tag `beta_copy` or `cutover`), `import_users`, `import_files` (every verified file with size and sha256), `import_state` (snapshot, J, delta progress).

## Why the importer runs inside the editify-v11 app machine

A Fly volume attaches to one machine. `editify_v11_data` is attached to the running editify-v11 machine, so a separate one-off machine could not write to it. The importer therefore runs as a second process in that machine over `fly ssh console`, and pulls from editify-dm over 6PN. It writes to the live 1.1 SQLite with a 15 s busy timeout; each user's import is one short transaction, but run the bulk import when 1.1 traffic is low (before the App Store release it is only testers).

## 0. Once, before any import

All commands from the repo root on your laptop, logged in with `fly auth login`.

1. 1.0 must run a build with the mutations journal (T15) and have it switched on. Check:

   ```
   fly ssh console -a editify-dm -C "mkdir -p /data/cutover"
   fly ssh sftp put server/scripts/cutover/source-agent.mjs /data/cutover/source-agent.mjs -a editify-dm
   fly ssh console -a editify-dm -C "node /data/cutover/source-agent.mjs status --db /data/editify.db"
   ```

   It prints `{"journal":true,"triggers":48,"journalId":N,...}` when the journal is on. If `journal` is false:

   ```
   fly secrets set MUTATION_JOURNAL=1 -a editify-dm
   ```

   (restarts editify-dm; the triggers install at boot). Re-run `status`.

   editify-dm runs without it today, so this is the step that makes the delta possible: only writes made while the journal is on can be replayed. It must be on, with all its triggers, before the launch-day snapshot (3.1) and stay on until the freeze. `import --all` refuses a snapshot with no journal or a missing trigger, and the delta refuses if the journal's triggers are gone from its own snapshot (it was switched off in between). Never unset MUTATION_JOURNAL on editify-dm during the cutover.

   The agent goes under `/data/cutover/` so it survives restarts; the agent and the importer never treat `cutover/` as media. Re-upload it if this file changes.

2. A shared token for the agent, set on both apps without printing it:

   ```
   TOKEN=$(openssl rand -hex 32)
   fly secrets set CUTOVER_TOKEN="$TOKEN" -a editify-v11
   fly secrets set CUTOVER_TOKEN="$TOKEN" --stage -a editify-dm
   unset TOKEN
   ```

   editify-v11 restarts now. On editify-dm the staged secret applies at its next restart (step 1's restart, or `fly machine restart <id> -a editify-dm` at a quiet moment). `fly ssh console` sessions see app secrets in their environment.

3. `--user <email>` lookups use `DATABASE_URL` (auth.users) when editify-v11 has it, else `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (the admin API). Postgres sync tables are not copied: 1.0 has no `/sync`, so `public.sync_*` never holds rows.

## 1. Measure and size the volume (C11)

Start the agent in one terminal and leave it running (it stops when the session ends; re-run it after any editify-dm restart):

```
fly ssh console -a editify-dm -C "node /data/cutover/source-agent.mjs serve --root /data --db /data/editify.db --host fly-local-6pn --port 7373 --work-dir /data/cutover"
```

In another terminal:

```
fly ssh console -a editify-dm -C "node /data/cutover/source-agent.mjs measure --root /data"
fly ssh console -a editify-v11 -C "sh -c 'cd /app/server && npx tsx scripts/cutover/cutover.ts measure'"
```

`--work-dir /data/cutover` keeps the agent's hash cache and its database snapshots on the 1.0 volume, so the cache survives the restarts below (otherwise the read-only window would re-hash every file). Each snapshot takes the database's size there; remove old ones with `fly ssh console -a editify-dm -C "sh -c 'rm -f /data/cutover/snapshots/*.db'"` when done.

The second prints du per directory on editify-dm, the free space on editify-v11, and the 1.5x size for editify_v11_data. Extend if needed:

```
fly volumes list -a editify-v11
fly volumes extend <volume id> -s <GB> -a editify-v11
```

Every copy also checks space first and exits 4 (nothing copied) when free space is under 1.2x the bytes still to copy.

Optional, hours ahead: hash the whole 1.0 volume once so later manifests are instant (the cache is keyed by size and mtime):

```
fly ssh console -a editify-dm -C "node /data/cutover/source-agent.mjs manifest --root /data --work-dir /data/cutover"
```

## 2. Beta copies (C8, C18)

Before each 1.1 submission (the review account) and for testers on request. With the agent running:

```
fly ssh console -a editify-v11 -C "sh -c 'cd /app/server && npx tsx scripts/cutover/cutover.ts snapshot'"
fly ssh console -a editify-v11 -C "sh -c 'cd /app/server && npx tsx scripts/cutover/cutover.ts import --user appreview@editify.app'"
fly ssh console -a editify-v11 -C "sh -c 'cd /app/server && npx tsx scripts/cutover/cutover.ts dry-run --user appreview@editify.app'"
```

The import is tagged `beta_copy`. Re-importing a user replaces their beta copy. The full cutover replaces every beta copy in the same transaction that imports the user's real rows, which drops whatever testers changed on 1.1 under the copied projects (C18). Projects a tester created on 1.1 from scratch are not copies and stay. Once the launch-day `import --all` has completed, `--user` imports are refused (they would turn real data back into a beta copy).

## 3. Launch day

Long commands: run them under nohup and tail the log, so a dropped session does not matter. Every step up to the App Store release (3.6) is safe to re-run. After it, only `delta`, `dry-run`, `copy`, `failures` and `status` are: see "After the release" below.

```
fly ssh console -a editify-v11 -C "sh -c 'cd /app/server && nohup npx tsx scripts/cutover/cutover.ts copy --all > /data/cutover/copy.log 2>&1 &'"
fly ssh console -a editify-v11 -C "tail -f /data/cutover/copy.log"
```

1. Agent running (section 1). Bulk snapshot; it records J, the newest journal id inside the copy:

   ```
   fly ssh console -a editify-v11 -C "sh -c 'cd /app/server && npx tsx scripts/cutover/cutover.ts snapshot'"
   ```

2. Bulk media copy (C3, C21): originals, proxies, renders and the shared trees, each file downloaded, fsynced, read back and checked for size + sha256 against the hash taken on editify-dm. Re-runs skip verified files.

   ```
   ... cutover.ts copy --all
   ```

3. Bulk import of rows up to J. A user's rows commit in one transaction only if every one of their files verified; otherwise the user goes to `import_failures` and is skipped. Exit 3 means some failed:

   ```
   ... cutover.ts import --all
   ... cutover.ts failures
   ```

   Fix the cause (usually re-run: a transient copy failure retries), then `import --all` again. It retries only failed and not-yet-imported users. `--force` re-imports everyone from the same snapshot. Both are for before the release only.

4. Dry run. Per user: every table's rows (1.0 columns, paths rewritten) and every media file's sha256, 1.0 against 1.1. Exit 1 on any diff; `--json` for the detail, `--quick` trusts the copy's recorded hashes instead of re-reading every file.

   ```
   ... cutover.ts dry-run --all
   ```

5. Forward-recovery prep (C22), right before the App Store release:

   ```
   ... cutover.ts backup-1.1
   fly volumes list -a editify-v11
   fly volumes snapshots create <editify_v11_data volume id>
   fly volumes snapshots list <editify_v11_data volume id>
   pg_dump "$V11_DB_URL" --schema=v11 --format=custom --file v11-$(date +%Y%m%dT%H%M).dump
   ```

   `$V11_DB_URL` is the direct Supabase connection string (db.<ref>.supabase.co:5432, from the dashboard); keep it out of shell history and logs. Keep the dump and note the snapshot id.

6. Release 1.1 on the App Store (manual release in App Store Connect).

7. Freeze 1.0 (C20), as `server/src/drain.ts` describes:

   ```
   fly ssh console -a editify-dm -C "node /app/server/dist/drain.js"
   fly machine list -a editify-dm
   fly machine restart <machine id> -a editify-dm
   fly secrets set READ_ONLY=1 -a editify-dm
   ```

   The plain restart, while still writable, lets the shutdown handler checkpoint the WAL into editify.db; a READ_ONLY=1 connection cannot. The agent's snapshots use the backup API, so they are complete either way, but the freeze should start from a checkpointed file. Each restart ends the agent's ssh session: start it again (section 1) once READ_ONLY=1 has applied.

   Do steps 6 and 7 back to back. Between them both servers take writes: a 1.0 write after J is replayed by the delta over whatever a 1.1 user did to the same row since the release (1.0 wins), and a project a 1.1 user deleted comes back if 1.0 changed it in that window.

8. Delta (C19): a fresh snapshot of the frozen database, a copy of any media that changed, then every journal entry after J replayed in one transaction (insert and update upsert the row, delete deletes it; cascaded deletes are journaled too). It refuses to run while any import failure is outstanding.

   ```
   ... cutover.ts delta
   ... cutover.ts dry-run --all
   ```

   The dry run must show 0 diffs. Run it immediately: once 1.1 users write, their changes are 1.1's and show up as diffs against frozen 1.0.

   Exit 3 means some file did not verify and nothing was replayed: `failures` lists them (reasons start with `delta:`). Re-run `delta`; it clears its own failures, copies again and replays. Do not run `import --all` to clear them.

9. Gate 1.0: set `/client-config` minVersion to 1.1.0 on editify-dm (T14, C16/C17). Then the C14 follow-ups (merge release/1.1 into main).

   editify-v11 must not call itself a test server from here on. `TEST_SERVER = "1"` in fly.v11.toml makes `/client-config` send `testServer: true`, and 1.1 TestFlight builds (and App Review installs, which also carry a sandbox receipt) show the "separate test server" banner while it does. Before submitting 1.1 for review, `fly secrets set TEST_SERVER=0 -a editify-v11` (a secret overrides `[env]`); when fly.v11.toml folds into fly.toml (C14), leave TEST_SERVER out. `curl -s https://editify-v11.fly.dev/client-config` must not contain `testServer`.

`cutover.ts status` prints the current snapshot, J and how far the delta replayed.

## After the release

From step 6 on, 1.1 users write under the projects the import put there: chats, edits, renders and their files. An import rewrites an imported project's children from the 1.0 snapshot, so a re-import after the release (a new `snapshot` then `import --all`, or `--force`) deletes all of that, render files included. Once the delta has started the importer refuses every import; between steps 6 and 8 nothing stops it but this runbook, so do not run `snapshot` or `import` in that window. A gap the delta cannot close is forward recovery (below), not a re-import.

## Go / no-go and recovery

- Before step 6 (release): anything wrong, unset the freeze if it was set (`fly secrets unset READ_ONLY -a editify-dm`) and stay on 1.0. The 1.1 import can be redone from scratch: it is idempotent and replaces earlier copies.
- After step 6, recovery is forward (C22):
  - App bugs: `fly releases rollback -a editify-v11` and an OTA fix on the production-1.1 channel.
  - Data damage: restore the volume from the step 5 snapshot (`fly volumes create editify_v11_data --snapshot-id <id> -a editify-v11`, then point the machine at it) and `pg_restore --schema=v11` the dump. Rows written to 1.1 after the snapshot are then lost unless editify-v11 itself ran with `MUTATION_JOURNAL=1`; consider setting it on editify-v11 at release so its own journal can be replayed onto the restored copy with the same replay the delta uses (not automated here).

## Local rehearsal (no production access)

Two data directories on a laptop, the importer reading the 1.0 one directly:

```
cd server
npx tsx scripts/cutover/cutover.ts snapshot --source-dir /path/to/v10-data --source-root /data --dest-root /path/to/v11-data
npx tsx scripts/cutover/cutover.ts import --all --source-dir /path/to/v10-data --source-root /data --dest-root /path/to/v11-data
npx tsx scripts/cutover/cutover.ts dry-run --all --source-dir /path/to/v10-data --source-root /data --dest-root /path/to/v11-data
```

`--source-root` is where the 1.0 rows' absolute paths start (`/data` for a copy of the production volume), so the rewrite to the local 1.1 directory is exercised. A copy taken while editify-dm still ran without the journal needs `import --all --without-journal`; the delta then refuses, as it should. The test suite (`server/test/cutover.test.ts`, `cutover-agent.test.ts`) runs the same flow on a fixture, including the HTTP agent on a loopback port.

The rehearsal on a production copy (plan Verification 4) needs production data: take a snapshot through the agent (section 1, then `snapshot` with `--dest-root` on a scratch volume) or a `fly volumes snapshots create` of editify_data restored to a scratch app, and run sections 3.1 to 3.4 and 3.8 against it, timing the read-only window.

## Exit codes

`0` ok, `1` dry-run diff, `2` error (message on stderr), `3` import failures recorded (see `failures`), `4` not enough space on editify_v11_data.
