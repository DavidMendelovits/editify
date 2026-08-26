# Build stage: full workspace install, then the Expo web client.
FROM node:20-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/mobile/package.json apps/mobile/
COPY packages/shared/package.json packages/shared/
COPY server/package.json server/
RUN npm ci
COPY . .
# Empty API URL => same-origin requests, since Fastify serves this bundle itself.
RUN cd apps/mobile && EXPO_PUBLIC_API_URL="" npx expo export --platform web --output-dir dist

# Runtime: ffmpeg plus the server, its deps, and the built client.
FROM node:20-bookworm-slim
# python3 + faster-whisper back `scripts/transcribe.py`, which the server spawns
# for every transcription. Without them the spawn fails with ENOENT and imports
# silently land with no captions.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates python3 python3-pip \
  && rm -rf /var/lib/apt/lists/*
# Debian marks its python as externally managed; this image has no other consumer.
RUN pip3 install --no-cache-dir --break-system-packages faster-whisper==1.2.1
# Bake the weights in rather than fetching them on first use: the download would
# otherwise happen inside a user's import, on a machine that may have no cache.
ENV HF_HOME=/opt/whisper-cache \
    WHISPER_MODEL=base
RUN python3 -c "from faster_whisper import WhisperModel; WhisperModel('base', device='cpu', compute_type='int8')"
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/tsconfig.base.json ./tsconfig.base.json
COPY --from=build /app/packages ./packages
COPY --from=build /app/server ./server
COPY --from=build /app/apps/mobile/dist ./apps/mobile/dist
ENV NODE_ENV=production \
    PORT=3001 \
    EDITIFY_DATA_DIR=/data \
    EDITIFY_WEB_DIR=/app/apps/mobile/dist
EXPOSE 3001
CMD ["npm", "run", "start", "-w", "@editify/server"]
