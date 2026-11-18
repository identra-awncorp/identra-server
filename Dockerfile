# Build context is the PARENT directory (the workspace that holds identra-server/ and, later,
# identra-sdk/), so every COPY path starts with identra-server/. What may enter the context
# is allow-listed in Dockerfile.dockerignore (next to this file).
#   docker build -f identra-server/Dockerfile --target prod ..      (from identra-server/)
FROM node:24-alpine AS base

WORKDIR /app

RUN apk add --no-cache openssl libc6-compat

# ---------------------------------------------------------------------------------------
# TODO(identra-sdk): once the server depends on the SDK, copy and build it here, BEFORE
# `npm ci`, so a `file:../identra-sdk/...` dependency in package.json resolves to
# /identra-sdk. Also allow `identra-sdk/` in Dockerfile.dockerignore. Sketch:
#   COPY identra-sdk/ /identra-sdk/
#   RUN cd /identra-sdk && npm ci && npm run build
# ---------------------------------------------------------------------------------------

COPY identra-server/package*.json ./
RUN npm ci

FROM base AS dev

COPY identra-server/prisma ./prisma
RUN npx prisma generate
COPY identra-server/ .

EXPOSE 4000
CMD ["npm", "run", "start:dev"]

FROM base AS build

COPY identra-server/prisma ./prisma
RUN npx prisma generate
COPY identra-server/ .
RUN npm run build
RUN npm prune --omit=dev

FROM node:24-alpine AS prod

WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache openssl libc6-compat

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Only schema.prisma and migrations/ (Dockerfile.dockerignore). Without prisma.config.ts the
# Prisma CLI uses its defaults (prisma/schema.prisma, prisma/migrations), the same paths.
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package*.json ./

# The official image's unprivileged user (uid 1000). Files above stay root-owned (read-only).
USER node

EXPOSE 4000
CMD ["node", "dist/src/main.js"]
