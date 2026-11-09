# syntax=docker/dockerfile:1
# The dashboard as a container of the box's compose stack, next to the api it reads:
#   docker build -t yt-stream-web frontend
# Vercel stays the public frontend; this one is reached over an SSH tunnel to the box's loopback.
# The box's own Node is 18, below what Next 16 needs, hence the image.

FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@11.20.0 --activate

FROM base AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
# Nothing secret is read at build time: BACKEND_URL, API_SHARED_SECRET and ACCESS_PASSWORD are runtime env.
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN addgroup -g 1001 -S nodejs && adduser -u 1001 -S web -G nodejs
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/next.config.ts ./
COPY --from=build --chown=web:nodejs /app/.next ./.next
USER web
EXPOSE 3000
CMD ["node_modules/.bin/next", "start", "-p", "3000", "-H", "0.0.0.0"]
