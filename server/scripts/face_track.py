#!/usr/bin/env python3
"""Track the speaker's face so captions and cards can stay off it.

    face_track.py <mediaPath> <modelPath> [samplesPerSecond]

Runs OpenCV's YuNet detector on a quarter-size copy of every Nth frame and
prints JSON: {"fps", "width", "height", "samples": [[t, top, bottom, left, right] | [t, null]]}.
Times are source seconds; the box is normalized to the decoded (rotation
applied) frame and grown to cover hair and chin, since the raw detector box
stops at the brow and the mouth line. When several faces are in frame the
largest wins; frames with no face are null.

Adapted from kurbaitaev/ghost-editor scripts/face_track.py (MIT).
"""

import json
import os
import sys
import urllib.request
from contextlib import redirect_stdout

MODEL_URL = "https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx"
# Detect on a quarter-size frame: fast, and plenty for a talking head.
DOWNSCALE = 4


def rounded(value):
    return round(float(value), 4)


def ensure_model(path):
    if os.path.exists(path):
        return
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    pending = f"{path}.{os.getpid()}.tmp"
    urllib.request.urlretrieve(MODEL_URL, pending)
    os.replace(pending, path)


def main():
    if len(sys.argv) not in (3, 4):
        raise ValueError("usage: face_track.py <mediaPath> <modelPath> [samplesPerSecond]")
    media_path, model_path = sys.argv[1], sys.argv[2]
    rate = float(sys.argv[3]) if len(sys.argv) == 4 else 5.0
    with redirect_stdout(sys.stderr):
        import cv2

        ensure_model(model_path)
        capture = cv2.VideoCapture(media_path)
        if not capture.isOpened():
            raise RuntimeError("could not open the video")
        fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
        step = max(1, round(fps / rate))
        width = height = 0
        detector = None
        samples = []
        index = 0
        while True:
            # grab() skips the colour conversion; only sampled frames are decoded fully.
            if not capture.grab():
                break
            if index % step == 0:
                ok, frame = capture.retrieve()
                if not ok:
                    break
                if detector is None:
                    height, width = frame.shape[:2]
                    detector = cv2.FaceDetectorYN.create(
                        model_path, "", (width // DOWNSCALE, height // DOWNSCALE), 0.6)
                small = cv2.resize(frame, (width // DOWNSCALE, height // DOWNSCALE))
                _, faces = detector.detect(small)
                t = round(index / fps, 3)
                if faces is None or len(faces) == 0:
                    samples.append([t, None])
                else:
                    x, y, w, h = max(faces, key=lambda face: face[2] * face[3])[:4]
                    # Grow the box: hair above the brow, chin below the mouth line.
                    top = (y - 0.35 * h) * DOWNSCALE / height
                    bottom = (y + 1.12 * h) * DOWNSCALE / height
                    left = (x - 0.08 * w) * DOWNSCALE / width
                    right = (x + 1.08 * w) * DOWNSCALE / width
                    samples.append([t, rounded(max(0, top)), rounded(min(1, bottom)),
                                    rounded(max(0, left)), rounded(min(1, right))])
            index += 1
        capture.release()

    output = {"fps": rate, "width": width, "height": height, "samples": samples}
    sys.stdout.write(json.dumps(output, separators=(",", ":")))
    sys.stdout.write("\n")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        sys.stderr.write(f"face tracking failed: {error}\n")
        sys.exit(1)
