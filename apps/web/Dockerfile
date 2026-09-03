# Render does not detect Bun, so this service declares its runtime explicitly.
# Build context is the repo root — Bun workspaces need the root manifest and
# lockfile to link `packages/*`.
#
# Built with Bun (for workspace linking) and served on Node, because that is
# what Next.js's standalone server targets.

FROM oven/bun:1.3.14-alpine AS builder
WORKDIR /app

COPY package.json bun.lock tsconfig.base.json ./
# --frozen-lockfile resolves the whole workspace, so every member's manifest
# has to be present even though only apps/web gets built here.
COPY apps/hooks/package.json ./apps/hooks/
COPY apps/loan-mcp/package.json ./apps/loan-mcp/
COPY packages ./packages
COPY apps/web ./apps/web

RUN bun install --frozen-lockfile

ENV NEXT_TELEMETRY_DISABLED=1
RUN cd apps/web && bun run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# `output: "standalone"` with `outputFileTracingRoot` at the repo root emits a
# self-contained tree that mirrors the monorepo layout.
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static

EXPOSE 8080
CMD ["node", "apps/web/server.js"]
