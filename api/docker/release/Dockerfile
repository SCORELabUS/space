# syntax=docker/dockerfile:1.7
# Public release image of the SPACE API (published to GHCR by .github/workflows/publish-image.yml).
# Unlike docker/production, it has no proxy settings, so it builds anywhere.

# ---- Build stage: install dependencies and compile TypeScript ----
FROM node:21.1-slim AS build
WORKDIR /usr/src/server

RUN npm install -g pnpm@10.9.0

COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=space-api-pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# The compiled output is flat (dist/index.js), so the sources are copied to ./src.
COPY tsconfig.json ./
COPY src/main ./src
RUN pnpm run build \
    # Rewrites the relative imports of the ESM output
    && pnpm exec tsc-alias --project ./tsconfig.json --resolve-full-paths

# ---- Runtime stage ----
FROM node:21.1-slim
WORKDIR /usr/src/server

ENV NODE_ENV=production

# node_modules keeps the dev dependencies on purpose: the API imports some of them at runtime (e.g. dotenv).
COPY --from=build /usr/src/server/node_modules ./node_modules
COPY --from=build /usr/src/server/dist ./dist
COPY package.json ./

# Pricing files are stored under ./public/static. Mount a volume here to persist them.
RUN mkdir -p public/static/pricings && chown -R node:node /usr/src/server/public
USER node

EXPOSE 3000
CMD ["node", "dist/index.js"]
