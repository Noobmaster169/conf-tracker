# syntax=docker/dockerfile:1
# The backend API image, built on the box from the clone by deploy/auto-deploy.sh:
#   docker build -t conf-tracker-api backend
# Runs TypeScript directly through tsx, so there is no build step to drift from the source.

FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@11.20.0 --activate

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Dev dependencies stay in on purpose: tsx is one of them.
RUN pnpm install --frozen-lockfile

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
# Frames (src/frames): ffmpeg reads the stream, yt-dlp resolves it. yt-dlp is pinned to what speech runs on the box
# (YouTube breaks old ones: bump it when frame grabs start failing with "yt-dlp exited"). It needs python3; its
# JS-challenge solver runs on this image's node.
ARG YTDLP_VERSION=2026.08.19
RUN apk add --no-cache ffmpeg python3 bash \
  && wget -qO /usr/local/bin/yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp" \
  && chmod 755 /usr/local/bin/yt-dlp
RUN addgroup -g 1001 -S nodejs && adduser -u 1001 -S api -G nodejs
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY db ./db
USER api
EXPOSE 8094
ENV PORT=8094
# Migrations gate startup: new code never serves against an old schema, and a failed
# migration keeps the old container running instead of rolling out a broken one.
CMD ["sh", "-c", "node db/migrate.mjs && node --import tsx src/index.ts"]
