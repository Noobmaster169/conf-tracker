# syntax=docker/dockerfile:1
# The live relay's image, built on a laptop by relay/ship.sh and imported straight into the VPS's k3s.
# Runs TypeScript through tsx, as backend/ does, so there is no build step to drift from the source.

FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@11.20.0 --activate

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -g 1001 -S nodejs && adduser -u 1001 -S relay -G nodejs
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
USER relay
EXPOSE 8080
ENV PORT=8080
CMD ["node", "--import", "tsx", "src/index.ts"]
