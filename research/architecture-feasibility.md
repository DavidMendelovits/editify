# Editify architecture feasibility review

Reviews `research/storage-architecture.md` against the actual codebase and a solo-founder constraint.

## Verdict

The consultant's *direction* is right — keep originals off the cloud by default, run AI on derivatives, render where the bytes are — but roughly half of its proposal is machinery you should not build, and it never answers the actual question.

Two corrections to the founder's framing, both load-bearing:

1. **Moving 4K to a server is not "incredibly expensive" in dollars.** Ingress is free, a 10-minute 4K render costs $0.05–$0.40 of cloud compute, and 40 GB in R2 is $0.60/month. It's expensive in *time and reliability* — a 4 GB upload is ~30 minutes on a typical home uplink and the current single-POST upload can't survive a network blip.
2. **The cost line that will actually dominate is the LLM agent loop**, which neither the founder nor the consultant is pricing.

The desktop question has a clean answer: the web target already exists in the codebase (`react-native-web` + `expo start --web` are wired up), the server is ordinary Node+ffmpeg, and an Electron shell around those two is days of work — with "browser pointed at localhost" shippable this week as the stopgap. Native AVFoundation/Media3 conform engines are the one genuinely expensive item in the consultant's plan, and should not be started this year.

---

## 1. Feasibility triage of the consultant's plan

### Actually feasible for a solo founder (do these)

- **`asset_representations` schema + `RepresentationResolver` (Stage 1).** Real and cheap. The `assets` table hard-codes three non-null absolute paths (`server/src/db/database.ts:41`, `asset-store.ts:5`), and every service reads `asset.originalPath` directly (`transcript-service.ts:76-90`, `style-service.ts:45-46`, `render.ts:63`). Making services ask for "a representation of kind X" is a 1–3 day refactor and it's the seam everything else hangs off. The single load-bearing schema change in the whole report.
- **Analysis-on-derivatives (Stage 2).** Almost free. `insight-service.ts` is transcript-only and explicitly told "do not claim visual knowledge"; caption generation (`ass.ts`) is pure project-JSON; scene/loudness analysis (`process.ts:117-141`) would work on the proxy. Only Whisper and energy analysis touch original bytes, and they only need mono 16 kHz audio.
- **Resumable/multipart uploads with a real size limit.** The 2 GiB cap at `routes/assets.ts:99` and the single `fetch(FormData)` in `apps/mobile/src/lib/api.ts:164-179` are genuine production blockers. Correction to the consultant: the server does *not* buffer uploads in memory — it streams to disk via `pipeline()` — but a 4 GB single-shot POST from a phone is still doomed for reliability reasons.
- **R2 for whatever does go to the cloud.** Verified: $0.015/GB-month, zero egress, Class A $4.50/M, Class B $0.36/M.
- **The op-log conflict story ("no CRDT yet").** `baseVersion` + `operation_log` already exists and is a fine foundation.

### Feasible but far more work than it sounds

- **Cloud render fallback (Stage 4).** The renderer reuses as-is, but "ephemeral worker" smuggles in auth, users, ownership, a job queue that isn't an in-process array (`render-queue.ts` is a single serial in-memory queue that loses all jobs on restart), per-tenant storage keys, TTL enforcement, and billing. A month, not a stage.
- **iOS AVFoundation conform.** See breakdown below. Timeline math is mappable; captions are not "a custom compositor," they're the project.
- **Presigned uploads + device presence + capability flags as a *system*.** Each piece is simple; together they imply a cloud control plane with auth, sync, and eight representation states. Build the two states you need (`available`, `missing`), not eight.

### Consultant-brain / don't attempt (this year)

- **Android Media3 conform with capability gating + device farm.** Zero users and an iOS-only Expo app. Designing for a Samsung QA lab that doesn't exist.
- **Golden-file cross-platform render tests.** Infrastructure for keeping *three renderers* honest. Have one renderer (ffmpeg) as long as humanly possible.
- **Device-presence heartbeat protocol.** A protocol for phantom users. A `last_seen_at` column is 90% of the value.
- **Shared `RenderPlan` IR.** You already have this. `Project` in `packages/shared/src/index.ts` — clips with `in/out/start/speed/volume/transform`, plus `captionStyleSchema` with word timings — *is* the render plan; `render.ts` and `ass.ts` are compilers from it. A second IR is abstraction for renderers that don't exist.
- The report's own "do not build" list (P2P streaming, CRDT, WASM ffmpeg, dedup, GOP-range upload) — agreed, plus move Stages 5–6 into it.

### The crux: can AVFoundation/Media3 reproduce `render.ts`?

| ffmpeg operation (render.ts) | AVFoundation equivalent | Difficulty |
|---|---|---|
| `color` background + `anullsrc` bed | `AVMutableVideoComposition.backgroundColor` or background track | Trivial |
| `trim`/`atrim` + placement (`setpts=PTS+start/TB`, `adelay`) | `AVMutableComposition.insertTimeRange` | Easy — what AVComposition is *for* |
| Scale-to-cover + center-weighted pan crop | Affine transform + `cropRectangle` in layer instructions | Moderate — even-rounding quirk (`Math.round(width*scale/2)*2`) and crop formula must be re-derived; expect off-by-a-pixel diffs |
| Speed (`setpts/speed`, `atempoChain` 0.1–8×) | `scaleTimeRange` + `audioTimePitchAlgorithm(.timeDomain)` | Moderate — works, but audio *sounds different* from chained `atempo` |
| Volume + 8 ms hsin edge fades + `amix` | `AVAudioMix` volume ramps | Easy — linear vs hsin over 8 ms is inaudible |
| Stacked `overlay`, iteration-order z-order, `eof_action=pass` | Multiple composition tracks + custom compositor | Moderate |
| fps conform (`fps=project.fps`) | `frameDuration` | Trivial |
| **ASS caption burn-in** (`subtitles=` + libass) | Core Animation tool / custom compositor — or bundled libass | **Hard** |
| libx264 CRF 18 + AAC 192k | VideoToolbox H.264 (bitrate-targeted, no CRF) | Easy to ship, impossible to bit-match |

**The ASS burn-in is the problem.** `ass.ts` emits per-event styles with `ScaledBorderAndShadow`, configurable stroke px, `\pos()` anchoring with `anchorPct`, alignment-lane overlap trimming, and — the killer — **karaoke `{\k}` word-by-word highlight timing** driven by `clip.style.words`. Reproducing this in `AVVideoCompositionCoreAnimationTool` means rebuilding libass's line-breaking (WrapStyle 0), CoreText font metrics that don't match libass's, stroke rendering that visibly differs, and per-word color keyframe animations. That's not a subtask of "iOS conform" — it's the majority of it, and it will never be pixel-identical.

Two honest outs: (a) **compile libass for iOS** (ISC-licensed, builds for iOS; render subtitle bitmaps into a custom compositor) — faithful, but you maintain a native C dependency; (b) accept "same design, different renderer" and drive both from `captionStyleSchema`.

One point in your favor the consultant undersold: his demand that "the shared source of truth must be the caption model, not the .ass file" is **already true in the codebase** — `.ass` is generated per-render from `Project`. The seam exists; only the second renderer doesn't.

Bottom line: 4–8 weeks of focused iOS work for a competent solo dev *who already knows AVFoundation*, dominated by captions, ending in output that's close-but-not-identical.

---

## 2. The desktop question

Verified status of each option (as of Aug 2026):

- **`@expo/electron-adapter`: dead.** v0.0.55, last published ~5 years ago; depended on Expo's Webpack support, deprecated at SDK 50. Do not touch.
- **react-native-macos: alive but not your path.** Microsoft actively maintains it (0.81.9 on npm, published weeks ago, tracking your RN 0.81.x). But it's a *react-native* fork — Expo SDK modules (`expo-video`, `expo-image-picker`, `expo-router`) have no macOS support story, so you'd rewrite your media layer anyway.
- **Expo web target: already in your project.** `package.json` has `react-native-web ~0.21`, `react-dom 19.1.0`, and a `web` script. Expo SDK 54's Metro static export produces a plain web bundle. The consultant's report walks straight past this asset.
- **Tauri v2: real** (stable Oct 2 2024; v2.10.x current; mobile stable) with first-class sidecar support. But your "sidecar" is *Node* + *Python Whisper* + *ffmpeg*, so Tauri's small-binary story evaporates immediately. Not worth the pivot today; a fine v2 shell swap later since the architecture (webview → localhost HTTP) is identical.
- **Electron + Fastify sidecar: nearly everything survives.** The client already talks to the server exclusively over HTTP (`api.ts`), so an Electron main process that spawns `node server` on a loopback port with a random token, then loads the Expo web export, changes almost nothing.

Expected friction, honestly:
- Editor touch/drag interactions (`useHorizontalDrag`, `Timeline`) need mouse/pointer-event testing under react-native-web.
- `expo-video` on web is functional but less battle-tested than native — `PreviewPlayer` is the component to smoke-test first.
- **Packaging Whisper**: bundling Python + faster-whisper is misery; swap the desktop transcription path to a `whisper.cpp` binary (MIT, single executable + ~150 MB base model) behind the same `TranscriptionRunner` interface.
- **ffmpeg licensing**: `-c:v libx264` makes any *bundled* ffmpeg GPL. Clean answer: ship ffmpeg as a separate spawned executable and comply with GPL for that binary (offer its source) — which `runProcess('ffmpeg', …)` already does naturally — or ship an LGPL build using `h264_videotoolbox` and give up CRF.
- App size lands ~250–400 MB. Unremarkable for a video editor.

- **Server-as-local-install + browser at localhost: yes, and do it first.** Not even ugly — it's exactly how you develop today. `EDITIFY_DATA_DIR`/`MEDIA_IMPORT_DIR` already parameterize storage. Wrap in one `npx editify` command. Cost: about a day.

**Recommendation:** Desktop is the best move and Electron-around-Expo-web with the existing server as sidecar is the way — but sequence it:

1. This week: ship `npx editify` + browser-at-localhost and dogfood the editor under react-native-web. Surfaces 100% of the RNW/`expo-video` risk at 5% of the cost.
2. If the web build holds up, Electron packaging is mostly `electron-builder` config.
3. Keep Tauri in your back pocket as a shell swap, not a rewrite.

This also *dissolves* the 4K fear for the desktop segment: on desktop the original never moves anywhere — full-fat ffmpeg renders locally, identical output to today's server, zero conform-parity work, zero cloud bytes.

---

## 3. Where the compute actually has to live — the real cost ranking

**Storage/egress (consultant's numbers: mostly right).** Spot-checked: R2 $0.015/GB-mo + free egress ✅; S3 $0.023 + ~$0.09/GB egress ✅; B2 ~$6.95/TB-mo with free egress to 3× storage ✅. His $0.09–$1.04/user/month for the proxy-working-set model is credible. One 2026 caveat he predates: **Hetzner repriced dedicated-vCPU instances up 2–2.7× in June 2026** (DRAM shock).

**Transcode/render CPU — smaller than you fear.** ffmpeg x264 `medium` at 4K30 runs roughly 10–30 fps on a modern 16-vCPU instance (*estimate — no clean published benchmark found for this exact config*). A 10-min 4K export is 15–40 min on a c7i.4xlarge (~$0.71/hr): **$0.20–$0.45 per export**, a third on spot. GPU changes it more: g4dn.xlarge ($0.526/hr, T4) does 2–3 simultaneous 4K30 NVENC streams, so one export is ~4–5 min: **~$0.04–$0.06 per export**, at worse quality-per-bit than x264 CRF 18. Meanwhile the user's own M-series Mac or iPhone renders 4K H.264 in hardware faster than real time for free.

So on-device rendering is *right*, but because it's free-and-instant, not because cloud rendering would bankrupt you. A cloud-render escape hatch at ~$0.05–0.40/export is a fine paid feature, not a death spiral.

**AI inference — the line nobody priced, and probably your biggest.**
- *Whisper*: today faster-whisper (base, int8, CPU) locally — free but slow, and currently inline in the upload request. Hosted: OpenAI Whisper $0.006/min ⇒ **$0.06 per 10-min clip**. Rounding error either way.
- *The agent tool loop*: `providers.ts:92` defaults to `claude-sonnet-5` ($3/$15 per MTok). The loop runs up to 24 iterations (`loop.ts:11`), resending the growing conversation each turn with the full tool registry, and `agent/tools.ts` is 744 lines of tool definitions. A realistic multi-edit chat easily accumulates 200–500K cumulative input tokens **with no prompt caching** (`cache_control` appears zero times in `providers.ts`): **$0.50–$1.50 per substantive agent session**. Ten sessions a month is $5–15 of inference versus $0.09–$1.04 of storage.

**Ranking for a real active user:** 1) LLM agent loop ($1–15/mo), 2) transcode *if* cloud-rendered ($0.05–0.45/export, avoidable entirely on desktop/iOS), 3) Whisper (~$0.06–0.60/mo), 4) storage/egress on R2 ($0.10–1/mo).

You are optimizing line 4. The consultant half-noticed ("AI and transcoding may dominate") and then spent 700 lines on storage anyway.

---

## 4. What a solo founder should actually build, in order

Your current architecture is fine for the next 6–12 months of finding a product. Change these things, in this order:

1. **Week 1 — desktop stopgap + the smallest killer experiment.** `npx editify` launcher, browser at localhost, dogfood the editor via react-native-web.
2. **Week 2–3 — Stage 1 lite.** `asset_representations` (or even just nullable path columns + a resolver function), point Whisper/scenes/loudness at proxy+extracted-audio, record timestamp drift on test clips. De-risks the entire "cloud sees only derivatives" economics with zero cloud infrastructure.
3. **Week 3–4 — Electron packaging** of what you validated in week 1 (incl. whisper.cpp swap and ffmpeg-as-spawned-binary licensing posture). You now have a shippable desktop product where originals never leave the machine — local-master architecture achieved with ~0% of the consultant's machinery.
4. **When (and only when) mobile-imported footage needs AI**: presigned multipart upload of *proxy + analysis audio only* (~92 MB per 10-min clip) to R2, plus minimal auth. Mobile *export* waits.
5. **Deferred indefinitely:** AVFoundation conform, Media3/Android, heartbeats, golden corpus, CRDT, web-as-product.

**The smallest experiment that validates or kills local-master:** take your longest 4K iPhone test clip; (a) generate proxy + 16 kHz mono audio on a laptop, (b) run Whisper + scene/loudness on those derivatives and diff word timestamps and scene cuts against the original-based run, (c) render the same project via today's `render.ts` from the original, locally. If (b) shows sub-100 ms timestamp agreement — it will; Whisper doesn't care about 16 kHz mono, that's literally its native input format — then "AI on derivatives + render where the original lives" is proven end-to-end. Cost: one or two days and $0 of cloud.

---

## 5. What breaks first at 100 real users tomorrow

1. **Hour zero — no auth.** Every asset, project, chat, and `/assets/:id/original` is world-readable and world-writable; `POST /projects/:id/chat` lets anyone on the internet spend your Anthropic key.
2. **Hour zero — uploads.** The 2 GiB cap rejects long 4K clips outright; anything large rides one non-resumable `fetch(FormData)` from a phone that will background-kill it.
3. **Hours — upload path CPU serialization.** `POST /assets` synchronously runs ffprobe → proxy transcode → thumbnail → *inline Whisper transcription* before responding (`routes/assets.ts:117`). Five concurrent 10-min uploads pin every core and stack multi-minute latencies; Fastify will look "down."
4. **Same day — the render queue.** In-process array, one render at a time, no persistence: a restart mid-render orphans `processing` rows forever, and ten queued 4K renders means the tenth user waits hours. `renders/` and `assets/` grow unboundedly on one disk.
5. **Days — LLM spend and rate limits.** 24-iteration uncached agent loops across 100 users hits rate limits at peak and produces a surprising first invoice.
6. **Weeks — SQLite is *not* on this list.** better-sqlite3 in WAL mode outlives every problem above at 100 users. The consultant's relational-database migration is not urgent.

The fixes for 1–4 are the same work regardless of which storage architecture wins — the strongest argument that the architecture debate is not what's actually between you and 100 users.

---

## Sources

[react-native-macos (npm)](https://www.npmjs.com/package/react-native-macos) · [microsoft/react-native-macos](https://github.com/microsoft/react-native-macos) · [@expo/electron-adapter (npm)](https://www.npmjs.com/package/@expo/electron-adapter) · [Expo: Webpack deprecated](https://blog.expo.dev/webpack-support-in-expo-cli-is-now-deprecated-e9831d7eb631) · [Tauri 2.0 stable](https://v2.tauri.app/blog/tauri-20/) · [Cloudflare R2 pricing](https://egresscost.com/cloudflare/) · [Backblaze B2 pricing](https://www.backblaze.com/cloud-storage/pricing) · [Hetzner June 2026 price increases](https://northflank.com/blog/hetzner-cloud-server-price-increases) · [g4dn.xlarge pricing](https://instances.vantage.sh/aws/ec2/g4dn.xlarge) · [NVIDIA Turing H.264 encoding](https://developer.nvidia.com/blog/turing-h264-video-encoding-speed-and-quality/) · [Whisper API pricing](https://tokenmix.ai/blog/whisper-api-pricing) · [x264 preset benchmarks](https://write.corbpie.com/ffmpeg-preset-comparison-x264-2019-encode-speed-and-file-size/)

*4K x264-medium throughput on server CPUs is an estimate — no clean published benchmark found.*
