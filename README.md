# nodefav

Cross-browser bookmark synchronization built around the browser's **native bookmark
experience**. You keep using the Bookmark Bar, Ctrl+D and the built-in bookmark
manager — a Manifest V3 extension acts as an invisible sync layer, and a self-hosted
cloud backend is the source of truth with a richer bookmark model (history, soft
deletes, metadata).

Targets all Chromium browsers: Chrome, Edge, Brave, Vivaldi, Opera.

## Stack

- TypeScript everywhere (ESM, strict), npm-workspaces monorepo: `extension/`, `backend/`, `shared/`
- Extension: Manifest V3, Chromium Bookmarks API, service worker, operation-based sync with a durable offline queue
- Backend: Node.js 24, Fastify, SQLite + Drizzle ORM, REST
- Shipped as a Docker image, built and deployed by Forgejo Actions

## Status

Early — foundation phase. Detailed planning docs are maintained locally and are not
part of this repository.
