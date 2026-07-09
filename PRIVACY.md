# Privacy Policy — nodefav

_Last updated: 2026-07-09_

nodefav is a browser extension and self-hosted backend for synchronizing
browser bookmarks. This policy describes what data the extension handles and
how.

## What the extension does

nodefav synchronizes your browser's native bookmarks (folders, titles, URLs,
order) with a nodefav backend server that **you** deploy and control. The
extension does not talk to any server operated by the developer — it only
talks to the server URL you configure yourself.

## Data collected

- **Bookmarks**: titles, URLs, folder structure and ordering, read from the
  Chromium Bookmarks API and sent to your configured backend so it can be
  synchronized across your browsers and devices.
- **Configuration**: the backend server URL and access token you enter in the
  extension's options page, stored locally via `chrome.storage.local`.
- **Sync metadata**: internal bookkeeping needed for synchronization, such as
  the mapping between local bookmark IDs and cloud UUIDs, operation IDs, and
  timestamps.

nodefav does not collect analytics, telemetry, crash reports, or browsing
history, and does not track activity on any website. It has no content
scripts and does not read or modify page content.

## Where data goes

All bookmark and configuration data is sent only to the backend server URL
you configure — a server you host and control. The developer of nodefav does
not operate a shared or default backend, does not receive this data, and has
no access to it. No data is sold or shared with third parties, and no remote
code is loaded or executed by the extension.

## Data retention and deletion

Deleted bookmarks are soft-deleted and kept in your backend for a
configurable retention window (see your backend's `NODEFAV_RETENTION_DAYS`
setting) before permanent removal, so accidental deletions can be undone.
You control retention and can delete data at any time by removing it from
your backend's database.

## Permissions

- `bookmarks` — read and write your browser's bookmark tree to keep it in
  sync with your backend.
- `storage` — store your backend URL, access token, and sync state locally.
- `alarms` — schedule periodic background sync and drift checks, since
  Manifest V3 service workers cannot rely on timers across restarts.
- Host permissions (`http://*/*`, `https://*/*`) — make authenticated
  requests to whichever backend URL you configure; since you can self-host at
  any domain or private address, the extension cannot be restricted to a
  fixed host.

## Contact

Questions about this policy can be sent to larsgjessing@gmail.com.
