# syntax=docker/dockerfile:1.7
# Public release image of the SPACE frontend (published to GHCR by .github/workflows/publish-image.yml).
# Unlike docker/production, it has no proxy settings, so it builds anywhere.

# ---- Build stage ----
FROM node:22-slim AS build
WORKDIR /usr/src/client

RUN npm install -g pnpm@10.9.0

COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=space-client-pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY src ./src
COPY public ./public
COPY tsconfig.json tsconfig.app.json tsconfig.node.json vite.config.ts index.html ./

# Vite inlines these values at build time. Override them with --build-arg if needed.
# The default API URL is relative: serve the client and proxy /api and /static to the SPACE API
# from the same origin, or rebuild with an absolute URL such as https://space.example.com/api/v1.
ARG VITE_ENVIRONMENT=production
ARG VITE_BASE_PATH=/
ARG VITE_SPACE_BASE_URL=/api/v1
ARG SPHERE_PUBLIC_URL=https://sphere.score.us.es
ENV VITE_ENVIRONMENT=$VITE_ENVIRONMENT \
    BASE_PATH=$VITE_BASE_PATH \
    VITE_SPACE_BASE_URL=$VITE_SPACE_BASE_URL \
    SPHERE_PUBLIC_URL=$SPHERE_PUBLIC_URL

RUN pnpm run build

# ---- Runtime stage: static assets only ----
FROM nginx:1.27.3-alpine
COPY docker/release/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /usr/src/client/dist /usr/share/nginx/html
EXPOSE 80
