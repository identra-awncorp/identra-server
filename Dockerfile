# Build context is the PARENT directory, laid out as on the VPS (deploy/README.md):
#   <context>/identra-sdk     the SDK sources (no node_modules, no dist: built here)
#   <context>/identra-server  this repository
# What may enter the context is allow-listed in Dockerfile.dockerignore (next to this file).
#   docker build -f identra-server/Dockerfile --target prod \
#     --build-arg IDENTRA_SERVER_REVISION=<sha> --build-arg IDENTRA_SDK_REVISION=<sha> -t identra-prod-api:<tag> .
#
# The base image is pinned by digest as well as by tag (refresh: deploy/README.md, "Base image").
ARG NODE_IMAGE=node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5

# --- The SDK, built from its sources. Install scripts are off: the one script in its tree is
# the optional native addon of cbor-x, which the SDK never loads (identra-sdk/README.md).
FROM ${NODE_IMAGE} AS sdk-build
WORKDIR /identra-sdk
COPY identra-sdk/package.json identra-sdk/package-lock.json identra-sdk/.npmrc identra-sdk/tsconfig.json identra-sdk/tsconfig.base.json ./
COPY identra-sdk/packages/core/package.json identra-sdk/packages/core/tsconfig.json packages/core/
COPY identra-sdk/packages/server/package.json identra-sdk/packages/server/tsconfig.json packages/server/
COPY identra-sdk/packages/app/package.json identra-sdk/packages/app/tsconfig.json packages/app/
COPY identra-sdk/packages/client/package.json identra-sdk/packages/client/tsconfig.json packages/client/
RUN npm ci --ignore-scripts
COPY identra-sdk/packages/core/src packages/core/src
COPY identra-sdk/packages/server/src packages/server/src
COPY identra-sdk/packages/app/src packages/app/src
COPY identra-sdk/packages/client/src packages/client/src
RUN npm run build && find packages/*/dist \( -name '*.map' -o -name '*.tsbuildinfo' \) -delete

# --- What the server needs of the SDK at run time: the manifests, the production dependencies
# of sdk-core and sdk-server only, and their dist/. package.json has
# `file:../identra-sdk/packages/...`, i.e. /identra-sdk.
FROM ${NODE_IMAGE} AS sdk
WORKDIR /identra-sdk
COPY identra-sdk/package.json identra-sdk/package-lock.json identra-sdk/.npmrc ./
COPY identra-sdk/packages/core/package.json packages/core/
COPY identra-sdk/packages/server/package.json packages/server/
COPY identra-sdk/packages/app/package.json packages/app/
COPY identra-sdk/packages/client/package.json packages/client/
RUN npm ci --omit=dev --ignore-scripts -w packages/core -w packages/server
COPY --from=sdk-build /identra-sdk/packages/core/dist packages/core/dist
COPY --from=sdk-build /identra-sdk/packages/server/dist packages/server/dist

FROM ${NODE_IMAGE} AS base
WORKDIR /app
RUN apk add --no-cache openssl libc6-compat
COPY --from=sdk /identra-sdk /identra-sdk
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

FROM ${NODE_IMAGE} AS prod
WORKDIR /app
RUN apk add --no-cache openssl libc6-compat

# node_modules/@identra/* are symlinks to /identra-sdk/packages/*. Everything below is owned by
# root and not writable by the user the container runs as.
COPY --from=sdk /identra-sdk /identra-sdk
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Only schema.prisma and migrations/ (Dockerfile.dockerignore). Without prisma.config.ts the
# Prisma CLI uses its defaults (prisma/schema.prisma, prisma/migrations), the same paths.
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package*.json ./

# The commits inside, last so they do not invalidate the layers above. Shown by GET /v1 and
# /v1/health as `build: { server, sdk }` (short SHAs; not secret).
ARG IDENTRA_SERVER_REVISION=unknown
ARG IDENTRA_SDK_REVISION=unknown
LABEL org.opencontainers.image.title="identra-server" \
      org.opencontainers.image.revision="${IDENTRA_SERVER_REVISION}" \
      vn.awncorp.identra.sdk-revision="${IDENTRA_SDK_REVISION}"
# Start-up needs no network: no Prisma update check or telemetry, no npm (the CLI is called directly).
ENV NODE_ENV=production \
    IDENTRA_SERVER_REVISION=${IDENTRA_SERVER_REVISION} \
    IDENTRA_SDK_REVISION=${IDENTRA_SDK_REVISION} \
    CHECKPOINT_DISABLE=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1

# A dedicated numeric user without a home directory or a shell entry (docker-compose.prod.yml
# runs it as 10001:10001 too); never uid 1000, usually the first human account of a host.
USER 10001:10001

EXPOSE 4000
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && exec node dist/src/main.js"]
