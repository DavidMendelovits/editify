# Transcriber score for 1.1 (T10)

How the iOS 18 transcriber (SFSpeech on-device, chunked) compares with the iOS 26 one
(SpeechAnalyzer) on the stand-up set. This score decides the "Server Whisper fallback for
iOS 18" TODO.

## Setup

- **Media:** the 212.65 s voice memo of the stand-up set. It's club audio, with crowd noise and
  laughter.
- **Host:** macOS 27.0 (26A428), Apple Silicon.
- **How the engines ran:** `apps/mobile/modules/editify-engine/parity/transcriber-score` compiles
  Core plus the real adapter files (`SpeechAnalyzerTranscriber.swift`, `SFSpeechTranscriber.swift`)
  and runs them on the file. Each engine's output goes through `TranscriptAssembler`, so it's
  exactly what the app stores.
- **The engines:**
  - `speech-analyzer` is the iOS 26 path.
  - `sfspeech` is the iOS 18 path: 50 s chunks with 2 s overlap, then merge, then phrases.
  - `sfspeech-single` is one on-device request over the whole file, for comparison.
- **Reference:** faster-whisper large-v3 (int8, CPU) through `server/scripts/transcribe.py`. It took
  11 min 9 s and gave 569 scored words. **This is a model reference. Nobody has hand-corrected it.**
  Where the reference and SpeechAnalyzer disagree, either one can be wrong.
- **Scoring (`server/scripts/score-transcribers.ts`):**
  - Normalization: lowercase, punctuation and apostrophes stripped, digits spelled out, and
    fillers (um, uh, hmm) dropped. Multi-word SFSpeech items are split, and their time is shared
    evenly between the words.
  - Alignment: Levenshtein against the reference.
  - Timestamp error: the start-time error of words that match exactly.
  - Seam errors: errors within 2 s of each chunk cut (49, 97, 145, 193 s).

## Bug found and fixed: SFSpeech kept only the last utterance

A recognition request reports each utterance as its own result, with
`speechRecognitionMetadata`, after every pause. The `isFinal` result repeats only the last
utterance. The T6 adapter read only the `isFinal` result, so each 50 s chunk kept just its last
few seconds.

| Version | WER | Words heard |
|---|---|---|
| Before the fix | 91.2% | 55 of 569 |
| After the fix | 51.7% | 305 of 569 |

The fix: the adapter keeps every result that carries metadata, and the new pure
`SpeechChunks.joinUtterances` joins them. A result that starts at or before a kept utterance
replaces it, which also covers a recognizer that reports cumulatively. Two checks for this are
in the adapters harness.

Because the output changed, the words version moves from `w-sf1` to `w-sf2`. The probe that found
this ran on macOS. The iOS 18 recognizer is expected to behave the same way, but the D11 iOS 18.0
simulator run should confirm it. The fix is safe either way.

## Results (after the fix)

| Engine | WER | Sub | Del | Ins | Words | Start err p50 | Start err p95 | Segments | Mean segment | Words per segment | Runtime |
|---|---|---|---|---|---|---|---|---|---|---|---|
| speech-analyzer | 14.6% | 42 | 12 | 29 | 586 | 100 ms | 340 ms | 65 | 2.4 s | 9.0 | 3.1-4.6 s |
| sfspeech (chunked) | 51.7% | 26 | 266 | 2 | 305 | 263 ms | 4380 ms | 31 | 4.1 s | 9.8 | 15.4-19.7 s |
| sfspeech-single | 52.2% | 25 | 272 | 0 | 297 | 740 ms | 5780 ms | 32 | 3.1 s | 9.3 | 14.7-14.9 s |

- **Run-to-run spread (3 runs):** SpeechAnalyzer gave the same result every time. Chunked
  SFSpeech had WER 51.5% to 52.0% and start error p95 from 4.4 s to 9.9 s.
- **Reference runtime:** large-v3 on CPU took 669 s, about 3.1x real time.

Errors within 2 s of each chunk cut, shown as deletions/insertions/substitutions (doubles):

| Engine | 49 s | 97 s | 145 s | 193 s | Total |
|---|---|---|---|---|---|
| speech-analyzer | 0/3/3 (0) | 0/0/0 (0) | 0/0/2 (0) | 0/0/0 (0) | 0/3/5 (0) |
| sfspeech (chunked) | 4/0/0 (0) | 4/0/1 (0) | 17/0/1 (0) | 9/0/0 (0) | 34/0/2 (0) |
| sfspeech-single | 4/0/0 (0) | 1/0/1 (0) | 18/0/0 (0) | 1/0/0 (0) | 24/0/1 (0) |

## What the numbers say

1. **SFSpeech on-device drops almost half the words on club audio.** Deletions make up 266 of its
   294 errors. A single request does no better (52.2%), so chunking doesn't cause this. The
   recognizer just doesn't hear speech over the crowd. A probe with
   `SFSpeechURLRecognitionRequest`, `taskHint .unspecified` and punctuation off heard the same
   words as the buffer request. So the way the adapter feeds audio isn't the cause either.
2. **Chunking costs a little at the seams but never doubles a word.** Within 2 s of the cuts,
   chunked runs lose about 10 more words than the single request, mostly at 193 s (the last
   chunk is only 20 s) and at 97 s. The merge never doubled a word.
3. **SFSpeech timestamps drift inside long utterances.** Words in a 10 s or longer utterance get
   compressed toward its start. Start error p95 is 4.4 s chunked and 5.8 s single, against 340 ms
   for SpeechAnalyzer. Karaoke captions and cut-on-word edits would visibly miss.
4. **Captions:** SFSpeech produces fewer, longer segments than SpeechAnalyzer (31 vs 65, 4.1 s
   vs 2.4 s mean). That's mostly because it heard fewer words. SFSpeech put no commas and only 17 sentence
   marks on its words, against 61 commas and 69 sentence marks from SpeechAnalyzer. So
   `SpeechChunks.phrases` mostly splits on pauses and the 12 s cap.
5. **Runtime isn't a concern.** All three engines run far faster than real time on this Mac.

## Recommendation: promote "Server Whisper fallback for iOS 18"

The rule was to promote if SFSpeech's WER is more than 1.5x SpeechAnalyzer's, or its timestamp
p95 is over 500 ms. Both are true:

| Measure | SFSpeech | SpeechAnalyzer | Threshold | Promote? |
|---|---|---|---|---|
| WER | 51.7% | 14.6% | Over 1.5x (3.5x here) | Yes |
| Start error p95 | 4380 ms | 340 ms | Over 500 ms | Yes |

A hand-corrected reference would most likely lower SpeechAnalyzer's WER. It can't explain away
SFSpeech dropping 266 words.

The fix above is worth shipping regardless of what happens to the TODO: without it, an iOS 18
transcript is close to empty.

## Caveats

- There is only one recording, and it's noisy club audio. Quiet, close-mic speech will score
  better on both engines.
- The engines ran on macOS 27, not on an iOS 18 device. The D11 iOS 18.0 simulator gate should
  repeat the SFSpeech row.
- On macOS the speech permission stayed `notDetermined` (the harness runs with `--no-ask`). On-device
  recognition ran anyway.
- The reference hasn't been hand-corrected. The 10 places where the reference and SpeechAnalyzer
  disagree most are at 26.3, 28.0, 47.1, 70.4, 132.5, 138.9, 142.0, 180.4, 183.9 and 208.9 s. They're
  listed in `server/data/transcriber-score/<media>.score.json` after a run. The transcript text
  isn't committed.

## Rerun

```
cd server
HF_HOME=/some/scratch npx tsx scripts/score-transcribers.ts --no-ask --reference-model large-v3
# or score against a hand-corrected file: --reference corrected.json  ({"words":[{"w","s","e"}]})
# extra transcripts: --hypothesis name=transcript.json ; rerun the engines: --fresh
```
