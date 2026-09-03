# Render does not detect Bun, so every service declares its runtime explicitly.
# Build context is the repo root, like the other services, but this one copies
# only its own directory: apps/idp is not a workspace member and carries its
# own lockfile (see apps/idp/package.json for why).
FROM oven/bun:1.3.14-alpine

WORKDIR /app

# Manifest and lockfile first, so a source-only change reuses the install layer.
COPY apps/idp/package.json apps/idp/bun.lock ./
RUN bun install --frozen-lockfile --production

COPY apps/idp/src ./src
COPY apps/idp/scripts ./scripts

ENV NODE_ENV=production
EXPOSE 8080
CMD ["bun", "src/index.ts"]
