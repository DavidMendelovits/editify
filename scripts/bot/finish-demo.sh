#!/usr/bin/env bash
# Turn a raw agent-browser take into a small mp4 + contact sheet, upload it, print the public link.
# Usage: finish-demo.sh <take.webm> <issue-N-slug>
# Upload order: rclone remote "gdrive:" (Google Drive) -> GitHub release "demos" (always works with gh auth).
# The video is NOT committed to the repo either way.
set -euo pipefail
TAKE=$1; NAME=$2
OUT=$(mktemp -d)/"$NAME"; mkdir -p "$OUT"
dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$TAKE" 2>/dev/null || echo 0)
if (( ${dur%.*} < 5 )); then
  echo "take is ${dur}s — that's a dead recording (stale daemon or record stop before anything happened). Re-record with a NEW file name after 'agent-browser close --all'." >&2
  exit 1
fi
ffmpeg -loglevel error -y -i "$TAKE" -vf "scale=1120:-2,fps=12" -c:v libx264 -preset slow -crf 32 -pix_fmt yuv420p -movflags +faststart "$OUT/$NAME.mp4"
ffmpeg -loglevel error -y -i "$OUT/$NAME.mp4" -vf "fps=1/8,scale=460:-2,tile=4x5" -frames:v 1 "$OUT/$NAME-contact.png"
echo "MP4   $OUT/$NAME.mp4 ($(du -h "$OUT/$NAME.mp4" | cut -f1))"
echo "SHEET $OUT/$NAME-contact.png   <- look at this before linking the video"

if command -v rclone >/dev/null && rclone listremotes 2>/dev/null | grep -qx 'gdrive:'; then
  rclone copy "$OUT" "gdrive:editify-demos/" -q
  echo "LINK  $(rclone link "gdrive:editify-demos/$NAME.mp4")"
  echo "SHEET-LINK $(rclone link "gdrive:editify-demos/$NAME-contact.png")"
  exit 0
fi
# ponytail: fallback = release assets. Stable URL, no repo bloat, no extra auth. Add Drive with: rclone config (remote name gdrive)
gh release view demos >/dev/null 2>&1 || gh release create demos --title "Bot demo recordings" --notes "Screen recordings attached to bot PRs." --prerelease >/dev/null
gh release upload demos "$OUT/$NAME.mp4" "$OUT/$NAME-contact.png" --clobber >/dev/null
assets=$(gh release view demos --json assets)
echo "LINK  $(jq -r ".assets[] | select(.name==\"$NAME.mp4\") | .url" <<<"$assets")"
echo "SHEET-LINK $(jq -r ".assets[] | select(.name==\"$NAME-contact.png\") | .url" <<<"$assets")"
echo "(Drive not configured — used GitHub release. One-time: rclone config, remote name 'gdrive', type drive)"
