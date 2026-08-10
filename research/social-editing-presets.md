# Social Editing Presets — how skilled editors cut short-form, as machine-executable parameters

Research date: 2026-08. Every number below is either (a) sourced, or (b) derived from a sourced
number with the derivation shown. `// why:` comments in the JSON carry the grounding.
Targets Editify's timeline schema: `Clip {in,out,speed,volume,transform{scale,x,y}}`,
caption clips with `style {font,size,color,position,emphasis}`.

---

## 1. Findings

### 1.1 The hook (first 1–3 seconds)
- ~71% of viewers decide whether to keep watching inside the first 3s; 70–85% retention at 3s →
  ~2.2x the views, and below ~60% distribution effectively stops. ([TTS Vibes](https://insights.ttsvibes.com/tiktok-first-3-seconds-hook-retention-rate/), [Dynamoi](https://dynamoi.com/learn/tiktok-music-promotion/what-is-the-3-second-rule-on-tiktok))
- The hook is *found, not filmed*. Opus Clip's product is a "virality score" ranking candidate
  clips on **hook strength, pacing and topic signals**, re-ordering source so the best moment opens.
  ([Presenc](https://presenc.ai/research/how-creators-use-opus-clip-2026), [AI Tool Radar](https://aitoolradar.io/guides/opus-clip))
- ffmpeg-only proxy for hook strength: short-term LUFS (ebur128) + speech density + scene-change
  rate over a sliding 2s window — the same primitives SPEC.md §Style profiles already uses.

### 1.2 Pacing / shot length
- Consensus: **a visual change every 2–3s**; **static shots over ~5s hurt retention** unless the
  creator is large. ([VidPros](https://vidpros.com/video-clip-length/)) Long-form retention editors
  phrase it as **one pattern interrupt every 10–15s minimum**; past ~12–15s of an unchanged frame a
  measurable share scroll. ([AIR Media-Tech](https://air.io/en/youtube-hacks/advanced-retention-editing-cutting-patterns-that-keep-viewers-past-minute-8), [Joyspace](https://joyspace.ai/pattern-interrupt-reset-attention-span))
  → 2–3s target, 5s hard cap, 12s "definitely broken".
- The widely-quoted "cuts every 0.5–1s → 3.3x completion" is vendor marketing with no methodology —
  do **not** default to it; sub-1s shots also fight caption legibility (§3).
- Durations: 21–34s highest completion, 24–38s "viral" band, 60–90s deep dive. Speech: 140–160 wpm.
  ([Quso](https://quso.ai/blog/best-video-length-for-tiktok), [Stack Influence](https://stackinfluence.com/blog/best-tiktok-video-lengths-for-creators-in-2026), [VidPros](https://vidpros.com/video-clip-length/))

### 1.3 Silence removal / jump cuts — what the tools actually default to
`auto-editor` is the closest thing to a published spec, and its defaults are the de-facto standard
that Descript/AutoCut-style products approximate:
- `--edit audio:threshold=0.04` — 4% of peak amplitude; documented as a default most users never
  change.
- `--margin 0.2s` — 0.2s of silence kept on **both** sides of every kept segment so cuts don't clip
  breath/consonant onsets. The single most important parameter for sounding human, not machine-gunned.
- `--smooth "0.2s,0.1s"` → **min-cut 0.2s, min-clip 0.1s**: silences under 0.2s aren't cut at all,
  kept segments under 0.1s are dropped. Prevents stutter.
  ([README](https://github.com/WyattBlue/auto-editor/blob/master/README.md), [options](https://auto-editor.com/options))
- Descript adds two ideas worth copying: **Remove filler words** with an *Avoid harsh cuts* toggle
  (skips any filler it can't excise without clipping a neighbour), and **Shorten word gaps**, which
  *retimes* rather than deletes — "gaps longer than X → set to Y". No published default; the
  commonly recommended safe setting is **gaps > 0.5s → 0.25s**. ([Descript: filler words](https://help.descript.com/hc/en-us/articles/10164806394509-Filler-words), [shorten word gaps](https://help.descript.com/hc/en-us/articles/10164807277453-Shorten-word-gaps), [Setuproll](https://setuproll.com/how-to/ve-2-remove-gaps-and-dead-air))
  **Word-gap shortening ≠ silence removal** — it preserves rhythm, so it is far safer for comedy,
  where the pause *is* the joke.

### 1.4 Punch-in (digital zoom) and reframing
- "Zoom jump cut" / "punching in": cut at a break in dialogue, return at a slightly larger scale,
  cut back out. Editors are explicit it should land on *meaning* — "your most important tips,
  clever one-liners, or the punch line of your joke" — not on a timer.
  ([Katie Steckly](https://www.tiktok.com/@katiesteckly/video/7354004424777288965), [Adobe: jump cuts](https://www.adobe.com/creativecloud/video/post-production/cuts-in-film/jump-cut.html))
  Because `transform.scale` is pure digital zoom, stay inside the resolution budget: ~1.15x on a
  1080p source cropped to 9:16 before softness shows; 1.25x is the ceiling for 4K.
- Premiere's Auto Reframe exposes one meaningful knob — motion tracking **slower / default /
  faster** — plus keyframable "Adjust Framing"; "slower" suits locked-off talking-head cameras.
  ([Filmora](https://filmora.wondershare.com/advanced-editing-tips/auto-reframe-premiere-pro.html), [Hollyland](https://store.hollyland.com/blogs/creator-hub/use-auto-reframe-in-premiere-pro))
  Opus Clip's equivalent tracks the **active speaker**; Editify v1's honest substitute is a static
  face-biased crop (center-x, y biased so eyes sit near the upper third).

### 1.5 Captions
- Chunking: **3–7 words per line, 1–3s on screen (2–3s sweet spot)**, breaking at natural speech
  pauses; hard cap 8–12 words before splitting a sentence. Mobile reading speed ~200–250 wpm ≈
  3–4 words/sec. ([OpusClip](https://www.opus.pro/blog/tiktok-caption-subtitle-best-practices))
- Broadcast's harder constraint: Netflix caps **17 characters/second**, min event **5/6 s
  (0.833s)**, max **7s**, min gap **2 frames**.
  ([Netflix Timed Text](https://partnerhelp.netflixstudios.com/hc/en-us/articles/360051554394-Timed-Text-Style-Guide-Subtitle-Timing-Guidelines), [3Play](https://www.3playmedia.com/blog/netflix-captioning-specs/))
- Style consensus: bold/semibold sans-serif, white fill + black outline (or inverse), emphasis
  colour used **sparingly** on key words, word-by-word highlight ("Hormozi style") to pace
  attention. Placement per CapCut: centred, **40–60% up from the bottom**, never over faces;
  OpusClip says avoid the bottom 25% and top 15% entirely.
  ([CapCut](https://www.capcut.com/resource/caption-style), [OpusClip](https://www.opus.pro/blog/tiktok-caption-subtitle-best-practices))

### 1.6 Safe areas (the numbers that must be right)
On a 1080×1920 canvas:

| Platform | top | bottom | left | right (icon rail) | source |
|---|---|---|---|---|---|
| TikTok | 108 px | 320 px | 60 px | 120 px | [Ignite Social](https://www.ignitesocialmedia.com/content-creation/what-are-the-safe-zones-for-tiktoks-and-instagram-reels/) |
| TikTok (conservative / ads) | 140–200 px | 400–484 px | 60 px | 120–180 px | [Zeely](https://zeely.ai/blog/tiktok-safe-zones/), [Kreatli](https://kreatli.com/guides/tiktok-safe-zone) |
| Instagram / FB Reels | 220 px | 420 px | 35 px | 35–70 px (safe box 1010 wide) | [Ignite Social](https://www.ignitesocialmedia.com/content-creation/what-are-the-safe-zones-for-tiktoks-and-instagram-reels/) |
| YouTube Shorts | 180 px | 390 px (≈400 expanded) | 60 px | 120 px | [Pod2Reels](https://www.pod2reels.com/blog/youtube-shorts-safe-zone-guide), [Hopper HQ](https://www.hopperhq.com/blog/youtube-shorts-dimensions/) |

**Cross-platform intersection used as Editify's default** (max of each column):
top **220 px = 11.5%**, bottom **420 px = 21.9%**, left **60 px = 5.6%**, right **180 px = 16.7%**.
TikTok's caption block grows with caption length (a 3-line caption eats 250+ px) and ad CTAs add
~50 px, which is why the conservative bottom number, not the 320 px one, is the default.

### 1.7 Comedy-specific
- **Cut away *after* the punchline, not before.** Scripted comedy cuts off the speaker post-punch
  because holding "would just feel weird"; reaction shots are what make the joke land.
  ([Descript](https://www.descript.com/blog/article/learn-how-to-edit-a-comedy-clip-and-make-your-jokes-land), [PremiumBeat](https://www.premiumbeat.com/blog/how-to-edit-comedy-scenes-for-maximum-laughs/))
- **Pacing carries comedy more than the line does** — tighten the setup ruthlessly, then *protect*
  the pause before the punch. The opposite of blanket silence removal.
- **Never let the caption reveal the punchline.** A subtitle even a fraction early means "you read
  the punchline before the actor delivers it, and the surprise disappears before it happens";
  in-video captions on comedians' posts routinely spoil timing that took years to build.
  ([OpenSubtitles](https://blog.opensubtitles.com/opensubtitles/web/why-subtitle-timing-can-make-or-break-a-joke-the-hidden-craft-of-translating-comedy-for-the-screen), [HN](https://news.ycombinator.com/item?id=32882712))
- **Cut on the laugh, not through it** — put the outgoing cut at the laugh's peak so the next beat
  starts on rising energy.

### 1.8 Loop-friendly endings
- A loop ending makes the last frame visually/narratively continuous with the first, producing
  rewatch signals without a conscious decision; audio continuity is the most common failure point.
  Highest completion clusters at **20–25s**. ([Virvid](https://virvid.ai/blog/looping-structure-shorts-retention-2026), [SMMNut](https://smmnut.com/blog/tiktok-loop-content-strategy-2025/))
- Machine version: **hard cut on the last stressed syllable** (no trailing silence, no fade),
  optionally matching the final `transform` to the first clip's.

---

## 2. Presets

Shared conventions: all `*Pct` values are fractions of frame height/width (format-independent).
`safeAreaBottomPct: 22` = captions' bottom edge sits ≥22% of frame height above the bottom.

```json
{
  "name": "talking_head_punchy",
  "description": "Straight-to-camera micro-influencer take. Silence-trimmed jump cuts plus alternating punch-in so a single angle reads as multi-cam.",
  "targetContent": ["talking_head", "advice", "rant"],
  "targetDurationSec": [21, 34],            // why: highest-completion band (Quso/StackInfluence)
  "maxShotSeconds": 5.0,                     // why: >5s static shots measurably hurt retention (VidPros)
  "targetCutsPerMinute": 24,                 // why: 1 visual change per ~2.5s, midpoint of the 2-3s rule
  "shotLengthDistribution": { "p10": 1.2, "p50": 2.5, "p90": 4.5 },
  "hook": {
    "strategy": "pull_highest_energy_window_to_front",
    "windowSec": 2.0,                        // why: decision happens inside 3s; leave 1s of runway
    "score": "0.5*shortTermLUFS + 0.3*speechDensity + 0.2*sceneChangeRate",
    "requireSentenceBoundary": true,         // why: a hook that starts mid-word reads as broken
    "maxSearchFraction": 0.6                 // only mine the first 60% for the hook; keep an ending
  },
  "silenceTrim": {
    "enabled": true,
    "thresholdPeakFraction": 0.04,           // why: auto-editor default --edit audio:threshold=0.04
    "minSilenceSeconds": 0.20,               // why: auto-editor min-cut (--smooth 0.2s,0.1s)
    "padSeconds": 0.20,                      // why: auto-editor --margin default, both sides
    "minKeptClipSeconds": 0.10,              // why: auto-editor min-clip; below this it stutters
    "removeFillerWords": true,
    "fillerList": ["um", "uh", "like", "you know", "so", "basically"],
    "avoidHarshCuts": true                   // why: Descript skips fillers it can't cut cleanly
  },
  "speed": { "base": 1.0, "ramps": [] },     // why: no source gives a defensible global speed-up for speech
  "captions": {
    "wordsPerChunk": { "min": 3, "target": 4, "max": 7 },  // why: OpusClip 3-7 words/line
    "chunkDurationSec": { "min": 0.83, "target": 2.0, "max": 3.0 }, // why: Netflix 5/6s floor, OpusClip 1-3s
    "maxCharsPerSecond": 17,                 // why: Netflix adult reading-speed cap
    "position": "center",
    "verticalAnchorPct": 62,                 // why: CapCut "40-60% up from bottom"; 62 clears Reels' 420px
    "safeAreaBottomPct": 22,                 // why: max bottom overlay across platforms = 420/1920
    "safeAreaTopPct": 12, "safeAreaRightPct": 17,  // why: Reels 220/1920; TikTok icon rail 180/1080
    "fontSizePct": 7.2, "fontWeight": 800,   // why: see §2 font derivation; ~138px cap-line on 1920
    "uppercase": false,                      // why: no source supports all-caps; it costs ~10% read speed
    "fill": "#FFFFFF", "strokePx": 6, "strokeColor": "#000000", // strongest universal contrast
    "emphasisColor": "#FACC15",
    "emphasisMode": "active_word_highlight", // why: word-by-word "Hormozi style" pacing
    "emphasisMaxPerChunk": 1                 // why: OpusClip - emphasis "used sparingly"
  },
  "punchIn": {
    "enabled": true,
    "alternateScalePct": 112,                // why: <=1.15x stays sharp on a 1080p source after 9:16 crop
    "everyNCuts": 2,                          // alternate wide/tight so no two neighbours match
    "minHoldSeconds": 1.5,                   // why: below this the zoom reads as a glitch
    "yOffsetPct": -4                          // bias up so eyes land near upper third
  },
  "ending": { "type": "hard_cut_on_last_stressed_syllable", "trailingSilenceSec": 0.0 }
}
```

```json
{
  "name": "standup_clip",
  "description": "Stand-up set to social clip. Tightens the setup, PROTECTS the pause before the punch, cuts on the laugh peak, and never lets the caption arrive early.",
  "targetContent": ["standup", "crowd_work"],
  "targetDurationSec": [15, 45],
  "maxShotSeconds": 6.0,                     // why: stand-up tolerates longer holds; the face IS the content
  "targetCutsPerMinute": 12,
  "shotLengthDistribution": { "p10": 2.0, "p50": 4.5, "p90": 6.0 },
  "hook": {
    "strategy": "open_on_setup_line_preceding_biggest_laugh",
    "detectLaugh": "audioEnergyRise > 6dB sustained >0.8s with low speech-confidence",
    "leadInSec": 1.0,                        // start 1s before the setup sentence begins
    "fallback": "pull_highest_energy_window_to_front"
  },
  "silenceTrim": {
    "enabled": true,
    "thresholdPeakFraction": 0.04,
    "minSilenceSeconds": 0.60,               // why: 3x auto-editor default - long pauses are the joke
    "padSeconds": 0.30,
    "minKeptClipSeconds": 0.10,
    "removeFillerWords": false,              // why: fillers carry persona/delivery in stand-up
    "protectRegions": [
      { "type": "pre_punchline", "beforeSec": 1.2, "policy": "never_trim" },  // the comic pause
      { "type": "laugh", "policy": "trim_to_peak_plus_0.4s" }                 // cut ON the laugh, not through it
    ]
  },
  "speed": { "base": 1.0, "ramps": [] },
  "captions": {
    "wordsPerChunk": { "min": 2, "target": 3, "max": 5 },  // smaller chunks = less lookahead spoilage
    "chunkDurationSec": { "min": 0.83, "target": 1.6, "max": 3.0 },
    "maxCharsPerSecond": 17,
    "position": "center",
    "verticalAnchorPct": 65,
    "safeAreaBottomPct": 22, "safeAreaTopPct": 12, "safeAreaRightPct": 17,
    "fontSizePct": 6.5, "fontWeight": 800, "uppercase": false,
    "fill": "#FFFFFF", "strokePx": 6, "strokeColor": "#000000",
    "emphasisColor": "#FACC15", "emphasisMode": "active_word_highlight",
    "punchlineHandling": {
      "mode": "reveal_word_by_word_at_utterance",   // why: an early caption kills the surprise
      "leadInMaxMs": 0,                              // NEVER show a punchline word before it is spoken
      "splitAtPunchlineBoundary": true,              // punchline never shares a chunk with its setup
      "holdAfterSec": 0.6                            // let it sit through the laugh onset
    }
  },
  "punchIn": {
    "enabled": true,
    "alternateScalePct": 110,
    "everyNCuts": 3,
    "trigger": "on_punchline",                // why: editors punch in on the one-liner, not on a timer
    "minHoldSeconds": 2.0
  },
  "ending": { "type": "hard_cut_on_laugh_peak", "trailingSilenceSec": 0.0, "cutAfterPunchline": true }
}
```

```json
{
  "name": "sketch_multicam",
  "description": "Scripted sketch with multiple angles/characters. Cut for performance, not for silence; reaction shots after every punch.",
  "targetContent": ["sketch", "skit", "character_bit"],
  "targetDurationSec": [20, 60],
  "maxShotSeconds": 4.0,
  "targetCutsPerMinute": 30,                 // why: ~2s/shot; dialogue exchange drives the cut rate
  "shotLengthDistribution": { "p10": 0.8, "p50": 2.0, "p90": 3.8 },
  "hook": {
    "strategy": "cold_open_on_first_line_of_conflict",
    "skipEstablishingShots": true,           // why: 3s budget; an establishing shot spends it all
    "windowSec": 2.0
  },
  "silenceTrim": {
    "enabled": true,
    "thresholdPeakFraction": 0.04,
    "minSilenceSeconds": 0.35,
    "padSeconds": 0.25,
    "minKeptClipSeconds": 0.15,
    "removeFillerWords": false,              // scripted: fillers are performance
    "protectRegions": [{ "type": "beat_pause", "policy": "never_trim" }]
  },
  "speed": { "base": 1.0, "ramps": [] },
  "reactionShot": {
    "enabled": true,
    "insertAfter": "punchline",              // why: "reaction shots help jokes land" (Descript)
    "durationSec": { "min": 0.5, "target": 0.9, "max": 1.5 },
    "sourcePreference": "non_speaking_face_track"
  },
  "captions": {
    "wordsPerChunk": { "min": 2, "target": 4, "max": 6 },
    "chunkDurationSec": { "min": 0.83, "target": 1.8, "max": 3.0 },
    "maxCharsPerSecond": 17,
    "position": "center", "verticalAnchorPct": 60,
    "safeAreaBottomPct": 22, "safeAreaTopPct": 12, "safeAreaRightPct": 17,
    "fontSizePct": 6.5, "fontWeight": 800, "uppercase": false,
    "fill": "#FFFFFF", "strokePx": 6, "strokeColor": "#000000",
    "emphasisColor": "#FACC15", "emphasisMode": "active_word_highlight",
    "speakerColorCoding": true,              // distinct fill per speaker; outline stays black
    "punchlineHandling": { "mode": "reveal_word_by_word_at_utterance", "leadInMaxMs": 0 }
  },
  "punchIn": { "enabled": false },           // why: real angle changes already provide the variety
  "ending": { "type": "hard_cut_on_reaction", "trailingSilenceSec": 0.0 }
}
```

```json
{
  "name": "vlog_montage",
  "description": "Day-in-the-life / BTS. Music-led, loose sync, pattern interrupt on a clock so the retention curve stays flat.",
  "targetContent": ["vlog", "bts", "process"],
  "targetDurationSec": [20, 40],
  "maxShotSeconds": 3.0,                     // why: no talking-head anchor, so the 2-3s rule binds harder
  "targetCutsPerMinute": 32,
  "shotLengthDistribution": { "p10": 0.9, "p50": 1.9, "p90": 3.0 },
  "hook": {
    "strategy": "highest_motion_2s_to_front",
    "score": "0.6*sceneChangeRate + 0.4*shortTermLUFS",
    "windowSec": 2.0
  },
  "silenceTrim": {
    "enabled": true,
    "thresholdPeakFraction": 0.04,
    "minSilenceSeconds": 0.30,
    "padSeconds": 0.15,
    "minKeptClipSeconds": 0.10,
    "removeFillerWords": true, "avoidHarshCuts": true
  },
  "speed": {
    "base": 1.0,
    "ramps": [
      { "on": "non_speech_action_clip", "speed": 2.0, "maxSourceSec": 6 },   // travel/process beats compressed
      { "on": "hero_moment", "speed": 0.5, "durationSec": 0.6 }              // one slow-mo accent max
    ],
    "maxRampsPerVideo": 2                    // why: speed ramps are an accent; more reads as a template
  },
  "patternInterrupt": {
    "maxSecondsWithoutChange": 12,           // why: drop-off begins past ~12-15s of an unchanged frame
    "targetIntervalSec": 8,
    "kinds": ["cut", "punch_in", "text_pop", "speed_ramp"]
  },
  "captions": {
    "wordsPerChunk": { "min": 2, "target": 3, "max": 5 },
    "chunkDurationSec": { "min": 0.83, "target": 1.5, "max": 2.5 },
    "maxCharsPerSecond": 17,
    "position": "center", "verticalAnchorPct": 58,
    "safeAreaBottomPct": 22, "safeAreaTopPct": 12, "safeAreaRightPct": 17,
    "fontSizePct": 6.0, "fontWeight": 700,
    "uppercase": true,                       // short 3-word bursts; caps cost little at this length
    "fill": "#FFFFFF", "strokePx": 5, "strokeColor": "#000000", "emphasisColor": "#EC4899",
    "emphasisMode": "active_word_highlight"
  },
  "punchIn": { "enabled": true, "alternateScalePct": 108, "everyNCuts": 4, "minHoldSeconds": 1.2 },
  "ending": { "type": "loop_back", "matchFirstFrameTransform": true, "audioCrossfadeMs": 0 }
}
```

```json
{
  "name": "podcast_clip_loop",
  "description": "Long-form interview to 9:16 clip, Opus-Clip style: mine the best self-contained moment, static face-biased crop, loop-friendly close.",
  "targetContent": ["podcast", "interview", "long_form_excerpt"],
  "targetDurationSec": [20, 25],             // why: highest completion + best loop odds (Virvid)
  "maxShotSeconds": 5.0,
  "targetCutsPerMinute": 14,
  "shotLengthDistribution": { "p10": 2.0, "p50": 4.0, "p90": 5.0 },
  "hook": {
    "strategy": "score_candidate_windows_then_open_on_winner",
    "candidateLengthSec": [20, 60],
    "score": "hookStrength + pacing + selfContainment",   // Opus Clip's stated virality inputs
    "requireSentenceBoundary": true,
    "windowSec": 2.0
  },
  "reframe": {
    "mode": "static_face_biased_crop",       // why: no speaker tracking in v1; Premiere's "slower" analogue
    "eyeLinePct": 38,                        // eyes near upper third
    "motionTracking": "slower"               // why: locked-off podcast cameras
  },
  "silenceTrim": {
    "enabled": true,
    "thresholdPeakFraction": 0.04,
    "minSilenceSeconds": 0.25,
    "padSeconds": 0.20,
    "minKeptClipSeconds": 0.10,
    "removeFillerWords": true, "avoidHarshCuts": true,
    "shortenWordGaps": { "enabled": true, "longerThanSec": 0.5, "targetSec": 0.25 }  // Descript-style retime
  },
  "speed": { "base": 1.0, "ramps": [] },
  "captions": {
    "wordsPerChunk": { "min": 3, "target": 4, "max": 7 },
    "chunkDurationSec": { "min": 0.83, "target": 2.0, "max": 3.0 },
    "maxCharsPerSecond": 17,
    "position": "center", "verticalAnchorPct": 60,
    "safeAreaBottomPct": 22, "safeAreaTopPct": 12, "safeAreaRightPct": 17,
    "fontSizePct": 6.5, "fontWeight": 800, "uppercase": false,
    "fill": "#FFFFFF", "strokePx": 6, "strokeColor": "#000000", "emphasisMaxPerChunk": 1,
    "emphasisColor": "#8B5CF6", "emphasisMode": "keyword_highlight"  // Opus "Keyword Highlight"
  },
  "punchIn": { "enabled": true, "alternateScalePct": 112, "everyNCuts": 2, "minHoldSeconds": 2.0 },
  "ending": { "type": "loop_back", "matchFirstFrameTransform": true, "trailingSilenceSec": 0.0 }
}
```

**Font size derivation (`fontSizePct`).** No vendor publishes a px value for a 1080-wide render
(CapCut's "37–42 px" is a desktop-preview number). Derive: a 4-word chunk ≈22 chars spanning ~80%
of usable width (1080 − 60 − 180 = 840 → 672 px) gives 30.5 px advance/glyph; at ≈0.58 em advance
for a bold sans, em ≈ 53 px **for a single line**. Short-form captions render 1–2 lines at ~2.5x
that visual weight to survive a thumb-sized viewport → ~125–140 px ≈ **6.5–7.2% of 1920**. Treat as
a target and auto-shrink to fit the safe box.

---

## 3. Caption timing rules — word-level ASR → caption clips

Input `[{word, start, end}]` → caption clips `{start, out, text, style, emphasisWordIndex}`.

**R1 — Segment first.** Split at terminal punctuation and at any inter-word gap ≥ **0.60s**; a chunk
never spans a sentence boundary. *(0.60s = 3x auto-editor's 0.2s min-cut — a real rhetorical break.)*

**R2 — Greedy chunk inside a sentence.** Accumulate words while all hold: `wordCount ≤
wordsPerChunk.max` (3–7, OpusClip); `duration ≤ chunkDurationSec.max` (3.0s); `chars/duration ≤ 17`
(Netflix CPS); and the next word doesn't cross a comma/clause boundary once `wordCount ≥ target`.

**R3 — Min duration 0.833s** (Netflix 5/6s). If shorter: extend `out` into the following gap (never
past the next chunk's first word); if still short, merge with whichever neighbour has headroom,
allowing `wordsPerChunk.max + 1` rather than emitting a sub-0.833s flash.

**R4 — Max duration 3.0s** on screen (7s is the broadcast ceiling but reads as dead air here). If
trailing silence would exceed it, end at `lastWord.end + 0.25s` and leave the screen clean.

**R5 — Gap merging.** Consecutive chunks separated by < **0.15s**: close the gap by extending the
earlier chunk's `out` (flicker is worse than a long hold). Otherwise keep ≥ **2 frames** (0.067s
@30fps) of separation (Netflix).

**R6 — Lead-in / lead-out.** `start = firstWord.start − 0.08s` (clamped ≥ previous `out`);
`out = lastWord.end + 0.20s`. *(0.08s pre-roll compensates ASR onset lag; 0.20s matches
auto-editor's `--margin` so captions and cuts share one padding constant.)*
**Exception: `isPunchline` chunks get `leadInMs = 0`.**

**R7 — Punchline protection.**
1. Flag the punchline: the utterance immediately preceding a detected laugh (energy rise >6 dB
   sustained >0.8s with low speech confidence), or the final clause the agent marks.
2. Force a chunk boundary at its first word — the punchline never shares a chunk with its setup,
   and the setup chunk's `out` must not extend past the punchline's first word `start`.
3. Reveal word-by-word at utterance (`leadInMs = 0`). No word appears before it is spoken.
4. If it exceeds `wordsPerChunk.max`, split so the **final** chunk holds the reveal word(s) alone —
   the last 1–3 words carry the surprise.
5. Hold `+0.6s` past `lastWord.end` (through the laugh onset), then hard cut.

**R8 — Emphasis.** `active_word_highlight`: one caption clip whose emphasis index advances at each
word's `start`, highlight window `[word.start, nextWord.start)`. `keyword_highlight`: at most **one**
word per chunk (highest TF-IDF vs the transcript, stopwords excluded), held for the whole chunk.

**R9 — Layout & safe area.** Caption block's **bottom** edge at `(1 − safeAreaBottomPct/100) ×
frameHeight` (22% → y ≤ 1498 px on 1920); **right** edge clears `safeAreaRightPct` (17% → x ≤ 897 px
on 1080). Max 2 lines; on overflow reduce `fontSizePct` in 5% steps (floor 4.5%) before reducing
`wordsPerChunk`.

**R10 — Never over a face.** If the caption box overlaps a detected face bbox by >20%, move up to
`verticalAnchorPct + 8`, then down toward the safe-area floor; never onto the icon rail.

**R11 — Cut alignment.** A chunk must not straddle a hard cut by more than 0.15s; if it does, split
at the cut and re-apply R3 to both halves.
