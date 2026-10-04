#!/usr/bin/env python3
"""Transcribe one media file with faster-whisper and emit machine-readable JSON."""

import json
import os
import sys
from contextlib import redirect_stdout


def rounded(value):
    return round(float(value or 0), 2)


def main():
    if len(sys.argv) not in (2, 3):
        raise ValueError("usage: transcribe.py <mediaPath> [modelSize]")

    media_path = sys.argv[1]
    model_size = sys.argv[2] if len(sys.argv) == 3 else "base"
    words = []
    segments = []
    duration_processed = 0.0
    with redirect_stdout(sys.stderr):
        from faster_whisper import WhisperModel

        # 0 lets CTranslate2 pick (4 threads). The server passes fewer for an
        # import's background run so the preview encode next to it keeps the cores.
        cpu_threads = int(os.environ.get("WHISPER_CPU_THREADS") or 0)
        model = WhisperModel(model_size, device="cpu", compute_type="int8", cpu_threads=cpu_threads)
        segment_stream, info = model.transcribe(media_path, word_timestamps=True)
        for segment in segment_stream:
            text = (segment.text or "").strip()
            start = rounded(segment.start)
            end = rounded(segment.end)
            duration_processed = max(duration_processed, end)
            if text:
                segments.append({"text": text, "s": start, "e": end})
            for word in segment.words or []:
                token = (word.word or "").strip()
                if not token:
                    continue
                word_start = rounded(word.start)
                word_end = rounded(word.end)
                duration_processed = max(duration_processed, word_end)
                words.append({"w": token, "s": word_start, "e": word_end})

    output = {
        "language": str(info.language or "unknown"),
        "durationProcessedSeconds": rounded(duration_processed),
        "words": words,
        "segments": segments,
    }
    sys.stdout.write(json.dumps(output, ensure_ascii=False, separators=(",", ":")))
    sys.stdout.write("\n")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        sys.stderr.write(f"transcription failed: {error}\n")
        sys.exit(1)
