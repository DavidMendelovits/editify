# Editify storage and rendering architecture decision

## Here’s the answer

Adopt a **local-master, cloud-working-set architecture**: the importing device owns the full-quality original, while the cloud canonically stores projects, transcripts, AI results, and compact editing derivatives. The cloud AI analyzes a standardized low-bitrate proxy plus mono 16 kHz audio; the final full-resolution conform runs on a device or desktop sidecar that can read the original. Upload an original only when the user explicitly enables **Cloud Masters** or requests a cloud render or remote export, and treat non-pinned uploads as encrypted, resumable staging with a short TTL. Cross-device editing remains available from proxies, but full-quality export is honestly blocked until a device with the original is online, the media is relinked, or a cloud master exists. Evolve the current server by separating logical assets from physical representations before adding native renderers or serious web editing—the comedy belongs in the marketing, not in pretending a sleeping iPhone can supply 4 GB of video.

---

## Decision

The architecture should be called:

> **Local Master / Cloud Working Set, with compute following the required representation.**

This is not a vague “hybrid.” It is a specific product contract:

- The original master is canonically owned by a user device or user-controlled library.
- The cloud receives an intentionally reduced **AI working set**: proxy video, analysis audio, thumbnails, waveform, transcript, insights, and timeline.
- AI editing works entirely against that working set.
- High-quality conform executes wherever all required originals are available.
- Full originals enter Editify’s cloud only through an explicit, quota-bearing Cloud Master feature or temporary cloud-render staging.
- Cross-device proxy editing is seamless; cross-device full-resolution export is conditional.

The tension cannot be eliminated. Either the full bytes move to the compute, or the full-resolution compute moves to the bytes. Editify should do the latter by default.

---

## 1. What the current code actually implies

Today a logical asset and its three local files are effectively one object:

- `StoredAsset` requires `originalPath`, `proxyPath`, and `thumbnailPath`.
- Those are absolute server filesystem paths.
- Public URLs are reconstructed from `PUBLIC_BASE_URL`.
- There is no way to express “original exists on iPhone, proxy exists in R2, thumbnail was evicted.”

That coupling is visible in [asset-store.ts](/Users/davidmendelovits/space/editify/server/src/db/asset-store.ts:5) and the non-null path columns in [database.ts](/Users/davidmendelovits/space/editify/server/src/db/database.ts:41).

The upload route also has two immediate production blockers:

1. It accepts one ordinary multipart stream through Fastify.
2. It hard-limits that stream to 2 GiB—already smaller than the example 4 GB iPhone clip.

See [assets.ts](/Users/davidmendelovits/space/editify/server/src/routes/assets.ts:98). The Expo client likewise creates one `FormData` request, with no upload ledger, multipart resumption, background transfer integration, or checksum protocol in [api.ts](/Users/davidmendelovits/space/editify/apps/mobile/src/lib/api.ts:164).

Media dependencies are:

- Proxy and thumbnail generation read the original in [process.ts](/Users/davidmendelovits/space/editify/server/src/media/process.ts:60).
- Whisper and energy analysis read `asset.originalPath` in [transcript-service.ts](/Users/davidmendelovits/space/editify/server/src/services/transcript-service.ts:72).
- Scene and loudness analysis read the original in [style-service.ts](/Users/davidmendelovits/space/editify/server/src/services/style-service.ts:40).
- Final rendering adds every `asset.originalPath` as an ffmpeg input in [render.ts](/Users/davidmendelovits/space/editify/server/src/media/render.ts:57).

One useful correction: the current “insight” model is not visual. It explicitly consumes only transcript words and says not to claim visual knowledge in [insight-service.ts](/Users/davidmendelovits/space/editify/server/src/services/insight-service.ts:100). Scene detection is visual analysis, but it is local ffmpeg analysis rather than LLM vision. Caption-to-ASS generation also does not require source pixels; only the final subtitle burn-in does.

This is good news: most current AI functions can be moved away from originals with little or no loss.

---

## 2. Canonical storage tiers

“Canonical” here means the copy Editify relies upon during that artifact’s normal lifecycle. Derived artifacts remain regenerable from an accessible original.

| Artifact | Canonical location | Typical size and cost | If missing | Lifecycle |
|---|---|---:|---|---|
| Original master | Importing device: Photos/MediaStore/user filesystem. Optional pinned Cloud Master. | Example: 4 GB per 10-minute 4K clip. S3: about $0.092/month; R2: $0.060; B2: $0.028. | Proxy editing continues, but full-quality export and derivative regeneration are unavailable. | User-controlled indefinitely. Temporary cloud render copy: delete after 7 days. Pinned copy: quota-bearing until unpinned/project deletion. |
| Edit/analysis proxy | Cloud object storage, with local device cache. | Target about 90 MB per ten minutes at 1.2 Mb/s video. S3: $0.0021/month; R2: $0.00135. | Remote preview, cross-device editing, and visual analysis stop. Existing timeline remains intact. | Retain while any referencing project is active, then 90-day inactivity TTL. Regenerate when an original is available. |
| Thumbnail and filmstrip | Cloud object storage/CDN. | Roughly 0.2–2 MB per asset; effectively fractions of a cent. | Library and timeline lose visual context but remain structurally usable. | Retain with project metadata; eagerly cache, freely regenerate. |
| Analysis audio | Cloud object storage during analysis; device cache optional. | Ten-minute mono 16 kHz, 16-bit PCM is exactly 19.2 MB. At 32 kb/s AAC/Opus it is 2.4 MB; FLAC lies between and is content-dependent. | New transcription, loudness, or silence reanalysis stops; existing transcript and energy data still work. | Retain 30 days after successful analysis, then delete unless explicitly needed for reanalysis. |
| Waveform/energy data | Cloud database or small object, with local replica. | Current 50 ms cells produce 12,000 values for ten minutes; normally well under 0.5 MB even as JSON. | Waveform UI and silence tools degrade; media remains playable. | Retain with transcript/project. Regenerate from analysis audio or original. |
| Transcript JSON and insights | Cloud database/object store; local offline cache. | Usually hundreds of KB to a few MB. Negligible storage cost. | Transcript editing, captions, text-based AI edits, and silence-aware operations degrade. | Retain with the project; soft-delete for 30 days after project deletion. |
| Timeline/project JSON and operation log | Cloud database is authoritative; every active device maintains a local replica. | KB to low MB. Negligible storage cost but irreplaceable user state. | The edit is lost even if media survives. | Retain until explicit deletion, with backups and a recovery window. |
| Final export | Device after the user saves it. Cloud object only for download/share or explicit retention. | Assume 0.5–2 GB for a ten-minute output depending on resolution/bitrate. A 1 GB export costs $0.023/month on S3 or $0.015 on R2. | A cloud link fails, but the export can be rerendered if originals remain available. | Cloud default 30 days; share links have explicit expiry. “Keep in cloud” consumes quota. |

The current proxy uses 540-pixel-bounded H.264 at CRF 27 with 96 kb/s AAC, so its size is variable rather than contractually bounded. Production should define a maximum dimension and target bitrate in addition to a quality setting.

### Ten-minute analysis upload math

For a standardized analysis bundle:

```text
Proxy video:
1.2 Mb/s × 600 seconds ÷ 8 = 90 MB

Mono analysis audio:
16,000 samples/s × 2 bytes × 600 = 19.2 MB uncompressed
or
32 kb/s × 600 ÷ 8 = 2.4 MB compressed

Total:
109.2 MB with PCM audio
92.4 MB with 32 kb/s compressed audio
```

Compared with a 4,000 MB original:

- PCM bundle: **36.6× smaller**, a 97.3% reduction.
- Compressed bundle: **43.3× smaller**, a 97.7% reduction.

I recommend lossless mono FLAC for the analysis audio initially. Its upper bound is the 19.2 MB PCM payload, it avoids questions about codec artifacts around silence thresholds, and the difference is trivial beside the proxy. If field measurements show no meaningful silence/transcription regression, move to 32–48 kb/s Opus or AAC.

Future visual LLM analysis should sample proxy frames, not originals. Even 600 one-frame-per-second JPEGs at 50–150 KB each would be approximately 30–90 MB. Full resolution is justified only for quality judgments such as focus, stabilization, HDR, or detailed reframing—not hooks, shot boundaries, subject presence, or composition.

---

## 3. Cost per active user

Use an explicit workload instead of “storage is cheap,” the traditional opening act before a terrifying invoice.

Assume one active user per month:

- Imports ten 10-minute 4K clips: **40 GB of originals**.
- Stores approximately 1 GB of proxies, analysis audio, images, and metadata.
- Retains five 1 GB cloud exports: **5 GB**.
- Streams/downloads **10 GB** of cloud data.
- Request charges, AI inference, and render compute are excluded.

Current reference pricing:

- AWS S3 Standard is approximately $0.023/GB-month, with internet egress commonly modeled at $0.09/GB after account-level allowances. [AWS S3 pricing](https://aws.amazon.com/s3/pricing/)
- Cloudflare R2 Standard is $0.015/GB-month and direct egress is free. [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- Backblaze B2 is currently $0.00695/GB-month; egress is free up to three times average monthly storage, then $0.01/GB. It is not literally unlimited zero-egress. [B2 pricing](https://www.backblaze.com/cloud-storage/transaction-pricing)

### Recommended default: local originals, 6 GB cloud working set

| Provider | Storage | Assumed 10 GB egress | Approximate monthly total |
|---|---:|---:|---:|
| S3 | 6 × $0.023 = **$0.14** | 10 × $0.09 = **$0.90** | **$1.04/user** |
| R2 | 6 × $0.015 = **$0.09** | **$0** | **$0.09/user**, plus operations |
| B2 | 6 × $0.00695 = **$0.04** | Within 18 GB free allowance | **$0.04/user**, plus applicable transactions |

### Default cloud masters: 46 GB retained and 50 GB downloaded

| Provider | Storage | Assumed 50 GB egress | Approximate monthly total |
|---|---:|---:|---:|
| S3 | **$1.06** | **$4.50** | **$5.56/user** |
| R2 | **$0.69** | **$0** | **$0.69/user**, plus operations |
| B2 | **$0.32** | Within 138 GB free allowance | **$0.32/user** |

Those figures are deceptively polite because they represent only one month’s retained originals. If each user adds 40 GB monthly and nothing expires, month twelve contains roughly 480 GB per user: $11.04/month on S3 or $7.20/month on R2 before egress, compute, backups, support, and AI.

Temporary staging is different. Forty GB retained for seven days contributes only:

```text
40 GB × 7 / 30 = 9.33 GB-month
```

That costs about $0.21 on S3, $0.14 on R2, or $0.065 on B2, before any transfer and compute costs.

### Pricing implication

Use an S3-compatible storage interface and choose **R2 Standard initially** for cloud proxies, exports, and temporary masters because its zero-egress model gives the most predictable consumer-product economics.

A reasonable product boundary is:

- Base subscription around **$12–15/month**, including AI usage and approximately 25 GB of cloud working-set/export storage.
- No “unlimited cloud masters.”
- Optional **Cloud Masters** around **$5 per 100 GB-month**, with cloud-render minutes separately quotaed if compute becomes significant.
- Clear retention controls and storage meters in the app.

Storage is not likely to dominate the base product; AI and transcoding may. Permanent originals plus repeated server renders are where storage and bandwidth become material.

---

## 4. Server-side AI without server-side originals

### Transcription and silence analysis

Whisper only needs audio. Change `TranscriptService` to accept a representation requirement such as `ANALYSIS_AUDIO`, not `asset.originalPath`.

The device should produce:

- Mono 16 kHz FLAC or PCM.
- Stable source timestamps.
- A checksum and source duration.
- Optional precomputed RMS/peak cells.

The server can run Whisper and energy analysis against that object. Once transcription and waveform generation succeed, the audio can expire after 30 days. Transcript words and energy cells remain available for every timeline operation.

### Visual and style analysis

Current transcript insights already need no pixels. Current scene detection and future vision features can consume the proxy.

Potential differences caused by proxy encoding—missed scene changes, tone mapping, or different frame timing—must be measured against a test corpus, but they do not justify routine 4K uploads. Generate the proxy with:

- Constant, documented orientation.
- Source-time-preserving timestamps.
- CFR normalization only if the mapping back to source time is recorded.
- SDR tone mapping metadata when the original is HDR.
- No trimming or dropped time ranges.

The key invariant is:

> Every AI timestamp is expressed in the original asset’s source-time coordinate system.

That lets the server edit a timeline using proxies and the device conform precisely against originals.

### Edit on proxy, conform on device

For the current filter graph, this is feasible, but it is not “just run ffmpeg everywhere.”

The graph currently performs:

- Source trimming and sequencing.
- Scaling, cropping, and placement.
- Speed changes and audio time scaling.
- Volume, edge fades, delay, and mixing.
- Caption burn-in from ASS.
- H.264/AAC output.

#### iOS

AVFoundation is capable of composition, video compositing, audio mixing, and export. `AVAssetExportSession` supports a video composition and audio mix, while more involved output can use `AVAssetReader`/`AVAssetWriter`. [Apple AVAssetExportSession](https://developer.apple.com/documentation/avfoundation/avassetexportsession)

The present feature set is implementable using:

- `AVMutableComposition`
- `AVMutableVideoComposition`
- `AVAudioMix`
- Core Animation or a custom compositor for captions
- `AVAssetExportSession` or Reader/Writer when greater codec control is needed

ASS itself is not an AVFoundation rendering format. The shared source of truth must be caption text, timing, position, font, stroke, and karaoke state—not the generated `.ass` file. The server and iOS renderer should each compile that model into their native rendering mechanism.

Shipping mobile ffmpeg is possible, but I would not make it the primary iOS strategy. A libx264-based graph can miss hardware acceleration, inflate binary size, introduce licensing/patent review, and behave differently from the native Photos/HDR pipeline.

#### Android

Use Jetpack Media3 Transformer rather than treating every Android phone as a tiny Linux server. Transformer supports trimming, cropping, effects, speed changes, multi-asset compositions, overlays, audio mixing, and export, and is built on MediaCodec/OpenGL. [Media3 Transformer](https://developer.android.com/media/media3/transformer), [Composition API](https://developer.android.com/media/media3/transformer/composition)

The limits are real:

- Output codecs and dimensions depend on the device’s encoders; Android exposes codec capability queries precisely because support varies. [MediaCodecList](https://developer.android.com/reference/android/media/MediaCodecList)
- Transformer’s format support is bounded by platform decoding and encoding capabilities. HDR editing needs Android 13 plus appropriate encoder support; otherwise tone mapping may be required. [Supported formats](https://developer.android.com/media/media3/transformer/supported-formats)
- Google explicitly notes that 8K exports can fail even on devices able to capture 8K because decoder, encoder, or RAM limits may be exceeded. [Transformer troubleshooting](https://developer.android.com/media/media3/transformer/troubleshooting)
- Caption appearance, font metrics, hardware encoders, HDR conversion, and audio time stretching will not be bit-identical to server ffmpeg.

Therefore Android needs capability checks and a cloud-render fallback. “4K available” must be a runtime capability result, not a button permanently painted on the screen.

#### Web

Web should initially be a **proxy editor, reviewer, and export downloader**, not a trusted local-master renderer.

OPFS is useful as a cache, but it is origin-scoped, quota-controlled, deleted when site data is cleared, and best-effort by default. [MDN OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system), [storage quotas](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)

A browser can hold a user-selected file handle or copy media into OPFS, but that is not a dependable cross-browser canonical home for multi-gigabyte originals. Full web export should require Cloud Masters or a connected desktop sidecar. Do not build ffmpeg/WASM conform merely to claim a checkbox called “web.”

### When uploading originals is actually right

Original upload is the correct path when:

- The user explicitly wants backup or seamless editing/export on every device.
- A desktop or mobile device lacks the required codec, memory, HDR, or output capability.
- The user wants to export from web.
- A team or collaborator must render without the importing device.
- The source device is low on storage or likely to lose access to an external provider.
- A long or complex render would be unreasonable on mobile.

In those cases, upload directly to object storage with multipart resumption and run the existing ffmpeg renderer in an ephemeral worker. A normal cloud render gets a seven-day source TTL. Cloud Masters remain until the user unpins them or exceeds their paid quota.

---

## 5. Device canonical plus cloud cache: consistency contract

This is workable only if Editify does not pretend that every operation is always available.

### What syncs everywhere

- Project document and operation log.
- Asset identity and technical metadata.
- Proxy, thumbnail, filmstrip, transcript, waveform, and insights.
- Presence information describing where originals are believed to exist.
- Final export metadata and cloud download links where applicable.

### What stays device-private

- Filesystem paths.
- Security-scoped bookmarks.
- Photo library identifiers.
- Android content URIs and persisted permissions.
- Local cache paths.

The cloud should know that `asset A` has an original available on `device iPhone-123`; it does not need to know `/private/var/...` or the raw PhotoKit locator.

### iPhone edit, desktop open

The desktop downloads the cloud project and proxy, so editing can continue immediately. The asset inspector reports:

```text
Editing proxy: available
Original master: available on David’s iPhone
Full-resolution export on this Mac: unavailable
```

The available choices are:

1. Bring the iPhone online and upload a temporary or pinned Cloud Master.
2. Relink the desktop to the same original file.
3. Render a proxy-quality draft.
4. Wait.

If the iPhone is asleep, Editify does not have the original. A push notification is not a reliable remote filesystem protocol. Do not block ordinary timeline editing, but do block full-resolution export with a precise list of missing asset IDs.

### Timeline conflicts

The current `baseVersion` and operation log are a good foundation. Keep the cloud project as authoritative and maintain an offline queue of operation batches with stable IDs.

On reconnect:

- If the base version still matches, apply the batch.
- Otherwise fetch the latest project and replay operations that still reference valid clips.
- Surface a conflict when both sides changed or deleted the same clip.
- Never last-write-win the entire project JSON.

This does not require a CRDT yet. The existing operation model provides a much smaller and more understandable conflict surface.

---

## 6. Cross-platform reality

### iOS

A `PHAsset` is metadata; Apple explicitly says its underlying media may not be stored locally. [PHAsset documentation](https://developer.apple.com/documentation/photos/phasset) With Optimize Storage, retrieving the video may initiate an iCloud download, and `PHVideoRequestOptions.isNetworkAccessAllowed` defaults to false. [Apple network access documentation](https://developer.apple.com/documentation/photos/phvideorequestoptions/isnetworkaccessallowed)

Therefore:

- Store a durable local PhotoKit locator when available.
- Expect materialization from iCloud before proxy generation or final render.
- Show download progress and disk-space requirements.
- Preflight every referenced original before starting a render.
- Offer an optional “Keep original available in Editify” app-managed copy, understanding that it duplicates storage.
- Treat a PHPicker-produced temporary representation as import material, not a permanent path.

The current Expo picker immediately turns its URI into an upload and the document picker requests `copyToCacheDirectory: true` in [pick.ts](/Users/davidmendelovits/space/editify/apps/mobile/src/lib/pick.ts:14). A production implementation needs native PhotoKit-aware persistence and materialization rather than assuming that URI remains valid forever.

For background transfers, native background `URLSession` can continue while the app is suspended, but only file-backed upload tasks survive app exit; Apple also notes that iOS copies a background-upload file to a temporary location. [Apple background transfer documentation](https://developer.apple.com/documentation/foundation/downloading-files-in-the-background), [upload task documentation](https://developer.apple.com/documentation/foundation/urlsessionuploadtask)

That means:

- Generate derivatives into durable app storage before starting the task.
- Use native background upload sessions, not JavaScript `fetch`.
- Support server-side resumable/multipart sessions.
- Check free disk because a large Cloud Master upload may temporarily require another local copy.

### Android

Use:

- Android Photo Picker or MediaStore for gallery video.
- Storage Access Framework for documents and external/cloud providers.
- Persist URI permissions where the provider allows it.
- Copy into app-managed storage when durable permission is unavailable.

Android 10+ uses scoped storage by default, and files outside app-specific storage must be accessed through MediaStore, SAF, or permitted content URIs. [Android storage overview](https://developer.android.com/training/data-storage/), [shared media guidance](https://developer.android.com/training/data-storage/shared/media)

Android’s renderer should be native Media3 Transformer with:

- Runtime decoder/encoder capability checks.
- An explicit supported export matrix.
- SDR fallback for unsupported HDR.
- Cloud render for unsupported codecs, 4K failures, insufficient storage, or insufficient memory.
- A device farm covering Samsung, Pixel, and lower-end hardware—not merely one heroic emulator.

### Desktop

Desktop is the strongest local-master experience:

- Direct filesystem access.
- Reliable resumable networking.
- Plenty of temporary disk.
- Native ffmpeg and ffprobe.
- No mobile suspension.
- Easy local relinking.

Package the current Fastify/media code as a **local sidecar**, but separate it into:

- Local control API.
- Storage-provider adapters.
- Media worker.
- Sync client.
- Cloud AI/control-plane client.

Electron or Tauri can start the sidecar on loopback with a random per-install authentication token. The UI can continue talking HTTP, preserving much of today’s client/server boundary.

`MEDIA_IMPORT_DIR` already points toward this story. It makes sense as a developer convenience and later as a desktop “watch/import this folder” feature. It should never become a cloud-server route that browses server directories. The current default in [config.ts](/Users/davidmendelovits/space/editify/server/src/config.ts:11) should remain part of the local adapter only.

### Web

For the foreseeable staged product:

- Web can edit against cloud proxies.
- Web can run transcript and agent operations.
- Web can review/share/download exports.
- Web can request a cloud render only when Cloud Masters or temporary originals are available.
- Web cannot promise offline full-resolution projects.

That is a useful product, not an apology.

---

## 7. Schema and API changes

### Separate logical assets from representations

Replace path-bearing `assets` rows with something conceptually like:

```sql
assets
  id
  owner_id
  original_name
  content_fingerprint
  byte_size
  mime_type
  duration
  width
  height
  fps
  rotation
  color_space
  has_audio
  created_at
  deleted_at

asset_representations
  id
  asset_id
  kind                 -- original, edit_proxy, analysis_audio, thumbnail,
                       -- filmstrip, waveform, export
  generation           -- derivative recipe/version
  location_type        -- device, local_sidecar, object_store
  device_id            -- nullable
  storage_key          -- nullable; never an absolute remote server path
  status               -- declared, materializing, uploading, processing,
                       -- available, missing, evicted, failed
  mime_type
  byte_size
  sha256
  width
  height
  bitrate
  created_at
  last_verified_at
  expires_at
  error_code
```

Device-specific locators belong in the device’s local database:

```sql
device_asset_locators
  asset_id
  locator_type         -- phasset, content_uri, security_bookmark, filesystem
  encrypted_locator
  permission_state
  last_verified_at
```

Do not put iOS PhotoKit identifiers, Android URI permissions, or arbitrary local paths in the cloud database.

A fingerprint should include at least byte length plus a streaming cryptographic hash. A fast partial fingerprint is useful for initial UI, but it is not sufficient to relink a master silently.

### Representation transitions

```text
REGISTERED
    |
    +--> original/device: MATERIALIZING --> AVAILABLE --> MISSING
    |
    +--> proxy/device: GENERATING --> AVAILABLE
                             |
                             v
                      UPLOADING --> proxy/cloud AVAILABLE
                                             |
                                             v
                                      AI PROCESSING --> READY / FAILED

original/device AVAILABLE
    |
    +--> original/cloud: UPLOADING --> STAGED --> EXPIRED
                                      |
                                      +--> PINNED --> UNPINNED --> EXPIRED
```

Overall asset readiness should be computed, not stored as one overloaded status:

```json
{
  "canPreview": true,
  "canRunTranscriptAI": true,
  "canRunVisualAI": true,
  "canRenderOnThisDevice": false,
  "canRenderInCloud": false,
  "missingForMaster": ["asset-123"],
  "originalLocations": [
    { "deviceId": "iphone-abc", "availability": "last_seen_available" }
  ]
}
```

### API surface

Keep `POST /assets` only as a compatibility/local-sidecar endpoint. The production control plane becomes:

```text
POST /v1/assets
  Register logical metadata and fingerprint.
  Returns asset plus required derivative recipe.

POST /v1/assets/:id/representations/upload-sessions
  Body: kind, size, MIME type, sha256, generation.
  Returns multipart/resumable session and presigned part URLs.

POST /v1/upload-sessions/:id/complete
  Commits uploaded parts and verifies checksum.

DELETE /v1/upload-sessions/:id
  Aborts an incomplete upload.

POST /v1/assets/:id/analysis
  Queues transcript, energy, scene, or vision jobs based on available representations.

GET /v1/assets/:id?include=representations,capabilities
  Returns metadata, signed derivative URLs, availability, and actionable blockers.

PUT /v1/assets/:id/device-presence
  Device heartbeat: available, materializing, missing, permission_lost.
  Never sends the raw local locator.

POST /v1/projects/:id/render-plans
  Returns local/cloud eligibility and exact required representations.

POST /v1/projects/:id/renders
  Starts a cloud render only after all required cloud originals are available.
```

Media bytes should upload directly to object storage. Fastify should issue and finalize upload sessions, not proxy a 4 GB request through application memory and disk.

URLs in `AssetMetadata` should no longer be permanent fields constructed from `PUBLIC_BASE_URL`. Return short-lived signed URLs or stable API resource identifiers. Byte-range support remains necessary for proxy playback.

Before exposing any of this remotely, add:

- Users and organizations.
- Asset/project ownership.
- Authentication.
- Per-tenant authorization on every representation and render.
- Quotas, audit records, and deletion workflows.
- Encryption at rest and scoped object keys.

The present unauthenticated `/assets/:id/original` route must not survive a cloud deployment.

---

## 8. Staged path without a rewrite

### Stage 1: introduce representations locally

Do this while keeping SQLite, local files, existing routes, and ffmpeg behavior.

- Add `asset_representations`.
- Migrate current path columns into three local representations.
- Introduce a `RepresentationResolver` used by transcript, style, proxy, and render jobs.
- Make each job request a kind and quality instead of reading `originalPath`.
- Keep `POST /assets` working through a `LocalFilesystemStorage` adapter.
- Add checksums, byte sizes, generation recipes, and nullable/evictable states.
- Add a shared `RenderPlan` IR derived from the project timeline.

This is the smallest change that creates the correct seam.

### Stage 2: prove analysis from derivatives

- Generate a bounded proxy and mono analysis audio.
- Run Whisper, energy, and scene analysis only against those derivatives.
- Compare results against originals using the existing test clips plus iPhone HDR/VFR, Android, low-light, silence, and long-form samples.
- Record exact timestamp drift and establish tolerances.
- Stop making cloud AI code depend on original availability.

This validates the central economic assumption before cloud infrastructure grows legs and demands a pension.

### Stage 3: add the cloud control plane

- Add auth, users, ownership, and project sync.
- Move authoritative project JSON, operation log, transcript, and insights to a managed relational database.
- Add R2 through an S3-compatible storage adapter.
- Add presigned multipart/resumable derivative uploads.
- Add lifecycle rules and quota reporting.
- Keep the working local server as the desktop/development sidecar.

Do not upload originals by default.

### Stage 4: ship cloud-render fallback

- Reuse the current ffmpeg renderer in an ephemeral worker.
- Upload required originals only after an explicit render plan identifies them.
- Use resumable direct uploads.
- Delete temporary originals seven days after the render.
- Retain exports 30 days unless pinned.
- Expose Cloud Masters as a paid setting.

This gets standalone mobile and web export working before every native renderer reaches parity.

### Stage 5: native conform

- Implement iOS AVFoundation conform for the current operation catalog.
- Implement Android Media3 conform with capability gating.
- Use a golden project corpus to compare timing, crop, audio, captions, rotation, color, and HDR behavior against ffmpeg.
- Keep cloud render as fallback and as the consistent collaboration path.
- Package the local sidecar for desktop, where the existing ffmpeg renderer should remain the primary renderer.

### Stage 6: broaden web only if evidence supports it

Treat the web as proxy-first until usage proves that browser-local originals are worth the complexity.

### Do not build yet

- Peer-to-peer phone-to-desktop original streaming.
- A CRDT timeline.
- ffmpeg/WASM full-quality browser rendering.
- Cross-user media deduplication.
- Range-aware “upload only used GOPs” conform.
- Automatic permanent original backup.
- Glacier/archive tiering.
- A distributed render scheduler beyond one ordinary queue and worker type.
- One universal renderer abstraction that hides platform capabilities.

Share a common `RenderPlan`, validation suite, and timing model; do not pretend AVFoundation, Media3, and ffmpeg are the same engine.

---

## 9. Named risks

### 1. Storage and egress runaway

Permanent originals accumulate; exports and proxy scrubbing create bandwidth. A handful of viral public links can make S3 egress more expensive than storage.

Mitigation:

- R2 Standard for working media.
- Hard per-user quotas.
- Seven-day temporary-master TTL.
- Thirty-day export TTL.
- Signed URLs and rate limits.
- Budget alarms and per-user byte accounting from day one.
- No “unlimited.”

### 2. iCloud and provider placeholders

The user may select a 4K clip whose bytes are not actually on the phone. Export can fail hours later unless materialization is detected upfront.

Mitigation:

- Explicit `MATERIALIZING` state.
- Network-access-enabled PhotoKit request with progress.
- Disk-space preflight.
- Preflight every required original before render.
- Optional “Keep available offline” copy.
- Actionable relink flow.

### 3. Mobile background upload termination

The current JavaScript `fetch(FormData)` request is not a production large-file uploader. It can be suspended, killed, or restarted from zero.

Mitigation:

- Native background file uploads.
- Durable upload-session ledger.
- Multipart/resumable protocol and idempotent completion.
- Checksum verification.
- Upload from a durable app file, not a picker’s transient URI.
- Pause on cellular unless the user opts in.

### 4. Render nondeterminism

Server libx264/ASS, AVFoundation/VideoToolbox, and Android MediaCodec/OpenGL will differ in font metrics, audio stretching, encoder output, frame rounding, HDR, color range, and rotation handling.

Mitigation:

- Shared `RenderPlan` and rational timestamps.
- Bundled fonts and a shared caption layout specification.
- Golden audiovisual tests across platforms.
- Pixel/audio tolerances rather than byte equality.
- Display the renderer used in export diagnostics.
- Cloud ffmpeg fallback for reproducible delivery.

### 5. Offline and multi-device conflict

Timeline edits can merge; original availability cannot. A desktop may possess the newest timeline while only a sleeping phone has the source media.

Mitigation:

- Cloud-authoritative versioned operation log.
- Replay/rebase rather than whole-document last-write-wins.
- Per-device original-presence records.
- Proxy-quality drafts.
- Precise export blockers.
- No promise of background device-to-device source transfer.

---

## Final recommendation

Build Editify as a local-first editor whose cloud intelligence operates on a deliberately compact working set. Make “Can edit,” “Can analyze,” and “Can export master” separate capabilities, because they require different representations and will often have different answers. Desktop should package today’s server/media stack as a local sidecar; iOS and Android should progressively gain native conform engines; web should remain proxy-first and use cloud render when originals have been explicitly staged. Cloud Masters should be an optional paid storage feature, not an invisible consequence of importing media. That gives the founder the useful magic—AI editing anywhere—without requiring Editify to become everyone’s involuntary 4K video backup company.
