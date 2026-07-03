# syntax=docker/dockerfile:1
# Multi-stage build for the nodefav backend. Mirrors maily's pattern: single install,
# quality gate baked into the build, slim runtime stage.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* tsconfig.base.json ./
COPY shared/package.json ./shared/
COPY backend/package.json ./backend/
COPY extension/package.json ./extension/
# Single, deterministic install for every workspace. --mount=type=cache persists npm's
# download cache across builds on the BuildKit daemon.
RUN --mount=type=cache,target=/root/.npm \
  npm ci --workspaces --include-workspace-root --no-audit --no-fund --prefer-offline
COPY . .
# Shared ships compiled JS (its types resolve straight from src): build it first so
# the runtime import in the backend and the tests in the gate can load it.
RUN npm run build -w @nodefav/shared
# Quality gate baked into the image build: format, lint, types and unit tests. If any
# fail the build fails, so nothing gets tagged or pushed.
RUN npm run format:check && npm run lint && npm run typecheck && npm test
RUN npm run build -w @nodefav/backend
# Built here (before the prune drops esbuild) so the extension-zip target below can
# package it; adds nothing to the runtime stage.
RUN npm run build -w @nodefav/extension
# Drop dev dependencies so the runtime image ships only production deps.
RUN npm prune --omit=dev --workspaces --include-workspace-root

# --- Extension release zip (CI-only targets; never part of the runtime image) ------
# Built via `docker build --target extension-zip --output type=local,dest=…`, which
# drops nodefav-extension.zip into the given directory. Basing this on the gated
# build stage means a zip can only exist for a commit that passed the quality gate.
FROM debian:bookworm-slim AS extension-packager
# Installed before any COPY so the apt layer stays cached across builds.
RUN apt-get update && apt-get install -y --no-install-recommends zip \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/extension/dist /ext
RUN cd /ext && zip -r -X /nodefav-extension.zip .

FROM scratch AS extension-zip
COPY --from=extension-packager /nodefav-extension.zip /

# Last stage = default target, so a plain `docker build` still yields the backend.
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# CI build-arg (.git is dockerignored so it can't be derived here); surfaced by /health.
ARG GIT_SHA=
ENV GIT_SHA=$GIT_SHA
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/shared ./shared
COPY --from=build /app/backend/package.json ./backend/
COPY --from=build /app/backend/dist ./backend/dist
# SQL migrations run on startup; the migrator resolves ../../drizzle from dist/.
COPY --from=build /app/backend/drizzle ./backend/drizzle
WORKDIR /app/backend
EXPOSE 3000
CMD ["node", "dist/index.js"]
