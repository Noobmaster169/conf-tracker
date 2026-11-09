# syntax=docker/dockerfile:1
# The backend API image, built on the box from the clone by deploy/auto-deploy.sh:
#   docker build -t yt-stream-api backend
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
RUN addgroup -g 1001 -S nodejs && adduser -u 1001 -S api -G nodejs
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY db ./db
USER api
EXPOSE 8092
ENV PORT=8092
# Migrations gate startup: new code never serves against an old schema, and a failed
# migration keeps the old container running instead of rolling out a broken one.
CMD ["sh", "-c", "node db/migrate.mjs && node --import tsx src/index.ts"]
