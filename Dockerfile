# Build stage: full workspace install, then the Expo web client.
FROM node:20-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/mobile/package.json apps/mobile/
COPY packages/shared/package.json packages/shared/
COPY server/package.json server/
# npm ci runs patch-package (postinstall), which needs the patches.
COPY patches ./patches
RUN npm ci
COPY . .
# Compile before exporting: the web bundle resolves @editify/shared through its
# `default` export condition, which points at the built output.
RUN npm run build -w @editify/shared && npm run build -w @editify/server
# Empty API URL => same-origin requests, since Fastify serves this bundle itself.
RUN cd apps/mobile && EXPO_PUBLIC_API_URL="" npx expo export --platform web --output-dir dist

# Runtime: ffmpeg plus the server, its deps, and the built client.
FROM node:20-bookworm-slim
# python3 + faster-whisper back `scripts/transcribe.py`, which the server spawns
# for every transcription. Without them the spawn fails with ENOENT and imports
# silently land with no captions.
# fonts-symbola: libass's monochrome fallback for emoji stickers and captions
# (the image's DejaVu has no emoji, so they drew as missing-glyph boxes).
# fonts-noto-color-emoji + Pillow (below): the plan render's colour emoji
# stickers (server/src/media/emoji.ts), since neither libass nor this ffmpeg's
# drawtext draws colour glyphs.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg fonts-symbola fonts-noto-color-emoji ca-certificates python3 python3-pip \
  && rm -rf /var/lib/apt/lists/*
# Debian marks its python as externally managed; this image has no other consumer.
# OpenCV (headless: no GUI libs) backs `scripts/face_track.py`, which keeps
# captions off the speaker's face; without it captions only keep to the safe area.
# Pillow's wheel bundles HarfBuzz + raqm (emoji sequences shape into one glyph); raqm loads the system
# libfribidi, which ffmpeg's libass already pulls in.
RUN pip3 install --no-cache-dir --break-system-packages faster-whisper==1.2.1 opencv-python-headless==4.12.0.88 pillow==11.3.0
# Bake the weights in rather than fetching them on first use: the download would
# otherwise happen inside a user's import, on a machine that may have no cache.
ENV HF_HOME=/opt/whisper-cache \
    WHISPER_MODEL=base
RUN python3 -c "from faster_whisper import WhisperModel; WhisperModel('base', device='cpu', compute_type='int8')"
# Same for the face detector (YuNet, MIT): baked in, not fetched mid-import.
ENV FACE_MODEL_PATH=/opt/models/face_detection_yunet_2023mar.onnx
RUN mkdir -p /opt/models && python3 -c "import urllib.request; urllib.request.urlretrieve('https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx', '/opt/models/face_detection_yunet_2023mar.onnx')" \
  && python3 -c "import cv2; cv2.FaceDetectorYN.create('/opt/models/face_detection_yunet_2023mar.onnx', '', (320, 320))"
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/tsconfig.base.json ./tsconfig.base.json
COPY --from=build /app/packages ./packages
COPY --from=build /app/server ./server
# The public /privacy, /terms and /support pages are rendered from these
# markdown files at request time, so they have to exist in the image.
COPY --from=build /app/docs ./docs
COPY --from=build /app/apps/mobile/dist ./apps/mobile/dist
ENV NODE_ENV=production \
    PORT=3001 \
    EDITIFY_DATA_DIR=/data \
    EDITIFY_WEB_DIR=/app/apps/mobile/dist
# The commit /health reports (CI: `fly deploy --build-arg GIT_SHA=$GITHUB_SHA`).
# Last, so a new sha only rebuilds this layer. Unset, the server falls back to FLY_IMAGE_REF.
ARG GIT_SHA=""
ENV GIT_SHA=$GIT_SHA
EXPOSE 3001
# Straight to node: the npm wrapper and tsx transpiling cost ~600ms of boot,
# which delayed the port bind past fly-proxy's listening check.
CMD ["node", "server/dist/index.js"]
