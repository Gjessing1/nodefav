/**
 * In-process pub/sub for server-version changes — the fan-out point behind
 * `GET /api/events` (SSE). Anything that appends to the op log publishes the
 * new server version; every open event stream forwards it to its client.
 * Single-process by design, like SQLite itself.
 */
export type VersionListener = (serverVersion: number) => void;

export interface VersionBus {
  publish(serverVersion: number): void;
  /** Registers a listener; returns its unsubscribe function. */
  subscribe(listener: VersionListener): () => void;
  /** Number of live subscriptions (surfaced in /api/stats). */
  size(): number;
}

export function createVersionBus(): VersionBus {
  const listeners = new Set<VersionListener>();
  return {
    publish(serverVersion) {
      for (const listener of listeners) listener(serverVersion);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    size() {
      return listeners.size;
    },
  };
}
