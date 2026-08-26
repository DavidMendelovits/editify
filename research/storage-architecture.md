# Storage architecture — media at scale

Working notes from a planning conversation (Aug 17, 2026). Nothing here is implemented yet.
Written as a handoff: assume the reader knows the codebase but not this conversation.

## The problem

A single project is ~50 clips ≈ 10 GB of 4K source. Today every byte of that lands
on the server and stays there forever. Two hard constraints came out of the discussion:

- **4K export is a product requirement**, not a nice-to-have. Any plan that discards
  originals at import is dead on arrival.
- **Editing sessions span days or weeks.** A project sits half-finished. Whatever holds
  the originals has to still hold them next Tuesday.

## Current state (measured, not assumed)

| Fact | Where |
|---|---|
| SQLite, originals, proxies, renders all on one Fly volume | `fly.toml` `[[mounts]]`, `server/src/config.ts:6` |
| Renders use `asset.originalPath` — originals required at export | `server/src/media/render.ts:123,145` |
| Proxy is 540p CRF 27, 96k AAC, 1s GOP | `server/src/media/process.ts` `createProxyAndThumbnail` |
| Proxy/thumbnail/transcription run in background, import doesn't wait | `server/src/routes/assets.ts` `queueAssetWork` |
| **No deletion logic anywhere** — every asset and render ever created is still on disk | grep of `asset-store.ts`, `routes/assets.ts` |
| Local `server/data`: 115 MB assets, 66 MB renders | `du -sh` |
| Client uploads strictly one at a time, by explicit design | `apps/mobile/src/lib/pick.ts` `uploadAll` |
| Web upload buffers each file into memory before sending | `apps/mobile/src/lib/api.ts:267` |
| App already runs on web: 11 `Platform.OS` branches, zero `.web.tsx` overrides | `grep Platform.OS` |
| Every dependency has a web implementation | `apps/mobile/package.json` |

### The wall

Fly volumes are **$0.15/GB/month** with a **hard 500 GB cap** — growable, never
shrinkable, pinned to one machine. At 10 GB/project that is **50 projects and the
volume is full.** Not expensive — full. Same bytes on R2: $0.015/GB, no ceiling,
**$0 egress**.

This is the binding constraint. It arrives long before the money does.

## The decision

**The server stops being where video lives and becomes where the *edit* lives.**

- **Server holds:** EDL, transcripts, agent state, 540p proxies, filmstrips.
  ~300 MB/project — and it is exactly what the AI features need (transcription wants
  audio, `createFilmstrip` at `routes/assets.ts:420` wants proxy pixels, the agent
  wants the transcript). Keep all of it; it is ~3% of the cost and 100% of the product.
- **Devices hold:** the originals. Durably, across a month-long session.
- **Server sees an original only during a render**, and only the ranges the EDL uses.

### Why native devices can hold them and browsers can't

| Platform | Durable across a reload/relaunch? |
|---|---|
| iOS / Android | Yes — Photos library, referenced by `localIdentifier` |
| macOS / Windows desktop | Yes — file path (+ security-scoped bookmark if sandboxed) |
| Browser | **No** — handle dies on refresh. Chrome/Edge can persist via File System Access + IndexedDB; Safari and Firefox re-prompt |

The browser is the exception, not the model. That is what makes "keep originals on
device" viable as a general rule — and it means the web tier is the one that still
has to upload.

### The lever nobody expected

`render.ts` is 277 lines that build one argument array and shell out **exactly once**
(`runProcess('ffmpeg', args)`, line 275). The whole 1,250-line media pipeline — ASS
captions, transitions, ducking, callouts, emoji — is *TypeScript that composes an
ffmpeg command line.* It never assumed it was on a server.

**It runs unchanged anywhere ffmpeg exists.** That single fact decides the tiering:

| Tier | Renders where | Server stores |
|---|---|---|
| Desktop (Tauri/Electron + bundled ffmpeg) | Locally, reusing `render.ts` verbatim | Proxies only |
| iOS / Android | Upload used ranges → server renders → delete after 7d | Proxies + transient spike |
| Browser | Upload originals, or cap tier at 1080p | The one tier that costs money |

Desktop is also *faster*: a `shared-cpu-4x` Fly machine encoding 4K x264 runs well
under realtime; an M-series Mac on VideoToolbox runs many times realtime. The device
beats the server at this decisively, and costs nothing.

Net effect: **10 GB/project → ~0.3 GB steady state**, spikes only at export.

## Why the current 43-video web upload is slow

Three independent causes. Only the third is the storage problem.

**1. Uploads are strictly serial — `pick.ts` `uploadAll`.** The comment justifies it:
"each file costs an ffprobe, a proxy transcode and a thumbnail server-side, so a
parallel burst only makes every clip slower." **That reasoning is now stale.**
`queueAssetWork` moved proxy/thumbnail/transcription to the background; the import
request now only does a multipart-to-disk write plus one ffprobe. The network transfer
— the actually slow part for 43 large files — is being serialized to protect against a
cost that no longer blocks the response. Fix: bounded concurrency, 3–4 in flight.
Roughly a 10-line change and almost certainly the single biggest win.

**2. Nothing caps background ffmpeg concurrency.** Every import immediately spawns an
encode with no limit, so 43 imports mean 43 parallel ffmpeg processes on 4 shared
vCPUs, each crawling, plus transcription behind them. The old serial-upload design was
masking this. **Parallelising uploads without also adding a server-side semaphore just
moves the thrash.** These two fixes are a pair — ship them together.

**3. The bytes themselves.** ~200 MB/clip when ~6 MB would do. This is the one the
architecture change addresses (~33x), and it is the slowest to build.

Also worth fixing while in there:

- `api.ts:267` — the web path does `fetch(blob:) → .blob() → new File([blob])`, fully
  buffering each file in memory before the request starts. `DocumentPicker` on web
  exposes `asset.file` (a real `File`); passing it straight to `FormData` lets the
  browser stream from disk instead.
- `pick.ts` `pickFromFiles` passes `copyToCacheDirectory: true`, which copies every
  file into the cache dir before upload — doubled disk I/O and device storage, times 43.
- No upload resumability. A dropped connection loses that file. It degrades gracefully
  (`failed[]` is tracked and reported), so this is a papercut, not a bug.
- `app/style.tsx:24` caps its picker at `slice(0, 10)`. If 43 files are going through
  the style screen, 33 are being silently dropped — worth confirming which path the
  43-file import actually used.

## Plan, in order

**Phase 0 — make today's upload fast (hours, no architecture change)**
1. Bounded-concurrency uploads in `pick.ts` `uploadAll` (3–4 in flight), and delete the
   now-stale serial-by-design comment.
2. Semaphore around `queueAssetWork` (2 concurrent encodes) so 43 imports don't thrash.
3. Pass the web `File` through directly in `api.ts` instead of re-buffering.

**Phase 1 — stop the bleeding (hours)**
4. Retention sweep for renders: delete after 7–30 days, regenerate from the EDL on
   demand. Renders are already >1/3 of local data and are pure derivative output.

**Phase 2 — the actual fix (the real work)**
5. Import uploads proxy + audio only; originals stay on the device. Shared by every tier.
6. Export uploads only the EDL's used ranges (+1s handles), renders 4K, deletes after
   a week. `render.ts` itself is untouched — only *when* originals arrive and *how long*
   they stay changes. This is deliberately much smaller than porting the filtergraph.
7. Move blobs to R2, leave SQLite on the Fly volume (it's 1 MB and happy there).
   Removes the 500 GB ceiling, cuts per-GB 10x, zero egress on every preview scrub.

**Phase 3 — the pro tier**
8. Tauri (or Electron) shell around the existing web build, bundling ffmpeg. Desktop
   stops uploading anything at all and renders 4K locally. Mostly packaging work,
   because `render.ts` ports for free.

Phases 0–1 are same-day. Phase 2 fixes the cost curve on hardware you already have.
Phase 3 is the "native app that holds its own footage" product story.

## Options considered and rejected

- **1080p mezzanine, discard originals at import.** Would have been ~10x, one-line
  ffmpeg change. Rejected: incompatible with 4K as a product claim.
- **ffmpeg.wasm in the browser.** Software-only, 5–10x slower than realtime, wasm32
  caps usable memory near 2 GB — a 12 GB source is dead on arrival. It is the
  obvious-looking answer and it is wrong.
- **ffmpeg-kit on mobile.** Retired January 2025, binaries pulled, no clear successor
  fork. Do not build on it.
- **`react-native-macos`.** Lags upstream RN; would be a third platform surface to
  maintain. The web build already works — wrap that instead.
- **Tracking originals on-device for the *browser* tier.** Possible via File System
  Access + IndexedDB, but Chrome/Edge only. The inconsistency costs more than it saves.
- **S3.** $0.09/GB egress against a workload where every preview scrub pulls bytes.
  R2's zero egress is the whole reason to prefer it here.

## Gotchas to bank now

- **Mac App Store + sandboxing:** re-opening a user's file after relaunch needs
  security-scoped bookmarks, not a plain path. Ugly to retrofit.
- **iCloud-offloaded `PHAsset`s** need an explicit download and fail silently if
  unhandled. Same class of problem. `pick.ts` `describePickerError` already handles the
  sibling case (Photos error 3164) — extend that thinking.
- **HEVC decode in browsers** (if the WebCodecs client-side proxy path is ever built):
  fine on Safari and Chrome-non-Windows, ~81% Chrome on Windows, ~56% Edge, effectively
  absent in Firefox — and an iPhone HEVC `.mov` is the single most common input. The
  server path must stay as fallback. Use [mediabunny](https://github.com/Vanilagy/mediabunny),
  not ffmpeg.wasm. H.264 *encode* is 99.72%, so writing the proxy is not the problem;
  decoding the input is.
- **Keep proxies H.264**, not HEVC, for playback compatibility.
- **Fly volumes can grow but never shrink.** Don't over-provision to buy time.
- Proxy sizes above are estimates from the current CRF-27 settings, not measurements.
  Worth confirming against a real clip before quoting them anywhere.

## Sources

- [Fly.io volume pricing & 500 GB cap](https://fly.io/docs/about/pricing/)
- [R2 vs S3 vs B2, 2026](https://devopsboys.com/blog/cloudflare-r2-vs-aws-s3-vs-backblaze-b2-2026)
- [WebCodecs codec support, 1M+ devices](https://webcodecsfundamentals.org/datasets/codec-analysis-2026/)
- [mediabunny](https://github.com/Vanilagy/mediabunny)
- [FFmpegKit retirement](https://www.itpathsolutions.com/ffmpegkit-shutdown-what-to-do-next)
- [Descript proxy/optimized assets](https://help.descript.com/hc/en-us/articles/12792882150029-How-Descript-Uses-Optimized-Assets-Proxy-Files-to-Improve-Editing-Performance)
