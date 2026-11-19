# Build context is the PARENT directory (the workspace that holds identra-server/ and
# identra-sdk/), so every COPY path starts with one of them. What may enter the context is
# allow-listed in Dockerfile.dockerignore (next to this file).
#   docker build -f identra-server/Dockerfile --target prod ..      (from identra-server/)
FROM node:24-alpine AS base

WORKDIR /app

RUN apk add --no-cache openssl libc6-compat

# The Identra SDK, ALREADY BUILT on the host (run `npm run build` in identra-sdk first): only
# the manifests and the dist/ of sdk-core and sdk-server enter the image, never its sources,
# tests or test PKI. package.json has `file:../identra-sdk/packages/...`, i.e. /identra-sdk.
# Production dependencies of those two packages only, without install scripts: the one
# script in their tree is the optional native addon of cbor-x, which the SDK never loads
# (identra-sdk/README.md).
COPY identra-sdk/package.json identra-sdk/package-lock.json /identra-sdk/
COPY identra-sdk/packages/core/package.json /identra-sdk/packages/core/
COPY identra-sdk/packages/server/package.json /identra-sdk/packages/server/
COPY identra-sdk/packages/app/package.json /identra-sdk/packages/app/
COPY identra-sdk/packages/client/package.json /identra-sdk/packages/client/
RUN cd /identra-sdk && npm ci --omit=dev --ignore-scripts -w packages/core -w packages/server
COPY identra-sdk/packages/core/dist /identra-sdk/packages/core/dist
COPY identra-sdk/packages/server/dist /identra-sdk/packages/server/dist

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
# Source maps and the incremental-build cache are for developers, not for the image.
RUN npm run build && find dist \( -name '*.js.map' -o -name '*.tsbuildinfo' \) -delete
RUN npm prune --omit=dev

FROM node:24-alpine AS prod

WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache openssl libc6-compat

# node_modules/@identra/* are symlinks to /identra-sdk/packages/*.
COPY --from=build /identra-sdk /identra-sdk
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
