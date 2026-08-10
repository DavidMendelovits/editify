# Transcript-first cutting — actionable constants (distilled)

Distilled from a deep-research pass on Descript (patents + help center), auto-editor (Nim
source), jumpcutter/unsilence, ffmpeg silencedetect/silenceremove, forced-alignment
benchmarks, and Rubin et al. UIST 2013 ("Content-Based Tools for Editing Audio Stories").
Full citations live in the session transcript; key primary sources inline.

## Alignment error budget
- Whisper native timestamps are quantized to 20ms and DTW word timing has ~34–110ms mean
  boundary error (benchmarks disagree 3×; treat the range as honest). wav2vec2/MFA-grade
  forced alignment reaches ~20–35ms. faster-whisper = Whisper DTW class.
- Consequence: treat any word boundary as ±1 video frame at 30fps AT BEST. Never cut
  exactly on a raw word timestamp.

## Cut placement rules (adopt in remove_words / remove_silence)
1. **Snap into the inter-word energy valley**: search ±100–250ms around the nominal
   boundary for the local RMS minimum; cut there. Prefer clause/sentence boundaries —
   valleys there are hundreds of ms wide, so aligner error is inaudible.
2. **Pad outward 30–100ms** from word spans (Silero VAD ships speech_pad_ms=30;
   auto-editor --margin 0.2s is the editorial-grade value).
3. **Anti-stutter floors** (auto-editor --smooth defaults): never remove a gap < 200ms
   (mincut), never keep an island < 100ms (minclip). Iterate to fixed point.
4. **Breaths**: a breath lives in the gap BEFORE the incoming phrase's first word.
   Cutting at the aligned word start amputates it → "sucked-in" splice. Extend the IN
   point back through the breath or cut before it entirely. UIST rule: breath = pause
   segment with aligner confidence above threshold and duration > 100ms.
5. **floor(IN), ceil(OUT)** when quantizing to frames, exclusive out points, rational
   time math (OTIO convention) — can only include more audio than the word span, never
   clip a phoneme.

## Render smoothing (adopt in render.ts)
- **5–20ms constant-power audio crossfade at every splice** (UIST 2013 uses 5ms:
  "ensure the cut remains inaudible"; jumpcutter independently uses a 400-sample ≈ 9ms
  linear envelope). Optionally snap splice to a rising zero crossing (Audacity Z).
- Video: hard cut by default. Dissolve only when the removed span exceeds ~1s
  (auto-editor --transition MIN-CUT default 1s: "dissolving across a tiny silence trim
  reads as a stutter"). J/L offsets (audio and video cut at different times) are the
  canonical invisibility trick — future work.
- Never `-ss … -c copy` for word-level cuts (keyframe slop up to ~10s with x264
  keyint=250). We re-encode everything today, which is correct; smart-cut (re-encode
  only boundary GOPs, copy interior — auto-editor smartRenderPlan) is the future
  optimization once renders get long.

## Reference defaults worth mirroring
| Tool | Parameter | Value |
|---|---|---|
| auto-editor | silence threshold | 0.04 peak fraction (−28dBFS) |
| auto-editor | margin / mincut / minclip | 0.2s / 0.2s / 0.1s |
| unsilence | level / min-silence / stretch | −35dB / 0.5s / 0.25s |
| Silero VAD | speech pad / min silence | 30ms / 100ms |
| UIST 2013 | crossfade / default inserted pause | 5ms / 250ms (room-tone filled) |
| ffmpeg silenceremove | window | 20ms RMS |
| Descript "Avoid harsh cuts" | skips fillers that can't be cut cleanly | (mechanism, no constants) |

## Descript architecture notes (for the product roadmap)
- Transcript IS the document; the timeline is a view. Word↔media binding is per-word with
  draggable boundaries; ASR and alignment are SEPARATE stages ("Correct text" re-aligns
  without re-transcribing).
- Filler removal is a rule engine over POS-tagged tokens (spaCy-style), one rule per
  filler, returning index intervals — not a string dictionary. Context rules ("i mean"
  is not filler in "if you know what i mean").
- Deleted ranges become reviewable strikethrough ("Ignore") rather than destructive
  deletes — AI edits land as ignored text so the human can audit. Good pattern for
  Editify: agent cuts could be soft-deletes surfaced in UI.
- Room-tone synthesis fills gap clips (analyze first 30s of file, shape noise to match)
  so silence trims don't sound dead.
