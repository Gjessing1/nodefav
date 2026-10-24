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

## Chrome Web Store releases

Every push to `main` builds a versioned extension zip in Forgejo Packages and, once the
store secrets exist, submits it to the Chrome Web Store through the
[Chrome Web Store API v2](https://developer.chrome.com/docs/webstore/using-api):

- If the manifest version is newer than the store's published and in-review versions,
  the zip is uploaded and submitted for review. It goes live after approval, using the
  item's existing visibility settings.
- If an older version is still in review, that submission is cancelled and the newer
  one is submitted instead.
- Otherwise (same version, nothing to release) the step does nothing.

So a release is: increase `version` in `extension/src/manifest.json` and
`extension/package.json`, then push to `main`.

One-time setup:

1. Follow Google's [service account setup](https://developer.chrome.com/docs/webstore/service-accounts): enable the Chrome Web Store API in a Google Cloud project, create a service account with a JSON key, and add its email under **Account** in the Chrome Web Store Developer Dashboard. The publisher's Google account needs 2-step verification.
2. Add these Forgejo repository secrets: `CWS_SERVICE_ACCOUNT_JSON` (the complete JSON key), `CWS_PUBLISHER_ID` (Dashboard → Account → Publisher ID), and `CWS_EXTENSION_ID` (the item's ID).

Until those secrets exist the publish step skips without failing the build.
