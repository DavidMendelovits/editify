#!/usr/bin/env bash
# Turn a raw agent-browser take into a small mp4 + contact sheet, upload it, print the public link.
# Usage: finish-demo.sh <take.webm> <issue-N-slug>
# Uploads to Google Drive via the rclone remote "gdrive:" — the only allowed destination. Nothing ever goes to GitHub.
set -euo pipefail
TAKE=$1; NAME=$2
OUT=$(mktemp -d)/"$NAME"; mkdir -p "$OUT"
dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$TAKE" 2>/dev/null || echo 0)
if (( ${dur%.*} < 8 )); then
  echo "take is ${dur}s — that's a dead recording (stale daemon or record stop before anything happened). Re-record with a NEW file name after 'agent-browser close --all'." >&2
  exit 1
fi
ffmpeg -loglevel error -y -i "$TAKE" -vf "scale=1120:-2,fps=12" -c:v libx264 -preset slow -crf 32 -pix_fmt yuv420p -movflags +faststart "$OUT/$NAME.mp4"
ffmpeg -loglevel error -y -i "$OUT/$NAME.mp4" -vf "fps=1/8,scale=460:-2,tile=4x5" -frames:v 1 "$OUT/$NAME-contact.png"
echo "MP4   $OUT/$NAME.mp4 ($(du -h "$OUT/$NAME.mp4" | cut -f1))"
echo "SHEET $OUT/$NAME-contact.png   <- look at this before linking the video"

# Google Drive is the ONLY destination. Never GitHub: not committed, not a release asset, not an attachment.
if ! command -v rclone >/dev/null || ! rclone listremotes 2>/dev/null | grep -qx 'gdrive:'; then
  echo "rclone remote 'gdrive:' is not configured — cannot upload. Do NOT commit the video or attach it to GitHub; open the PR as draft and say the demo could not be uploaded." >&2
  exit 1
fi
rclone copy "$OUT" "gdrive:editify-demos/" -q
echo "LINK  $(rclone link "gdrive:editify-demos/$NAME.mp4")"
echo "SHEET-LINK $(rclone link "gdrive:editify-demos/$NAME-contact.png")"
