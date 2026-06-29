FROM node:22-alpine AS base

WORKDIR /app

RUN apk add --no-cache openssl libc6-compat

COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

FROM base AS dev

COPY prisma ./prisma
RUN npx prisma generate
COPY . .

EXPOSE 4000
CMD ["npm", "run", "start:dev"]

FROM base AS build

COPY prisma ./prisma
RUN npx prisma generate
COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-alpine AS prod

WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache openssl libc6-compat

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package*.json ./

EXPOSE 4000
CMD ["npm", "run", "start:prod"]
