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
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*
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
