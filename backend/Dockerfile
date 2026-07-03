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
# Quality gate baked into the image build: format, lint, types and unit tests. If any
# fail the build fails, so nothing gets tagged or pushed.
RUN npm run format:check && npm run lint && npm run typecheck && npm test
RUN npm run build -w @nodefav/backend
# Drop dev dependencies so the runtime image ships only production deps.
RUN npm prune --omit=dev --workspaces --include-workspace-root

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
