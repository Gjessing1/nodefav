/**
 * Realtime change feed (Phase 6): a fetch-streamed SSE connection to
 * `GET /api/events`. The server pushes `version` events; when one carries a
 * server version past our cursor, the background debounce-triggers a normal
 * sync cycle — the feed itself never applies anything.
 *
 * This is latency sugar on top of polling, not a replacement: the periodic
 * alarm keeps running and remains the fallback whenever the stream is down or
 * the service worker was killed. Reconnection uses exponential backoff; a
 * watchdog aborts stalled connections (the server heartbeats every 25s, so a
 * quiet minute and a half means the socket is half-open, e.g. after a network
 * change).
 */

export type RealtimeState = 'off' | 'connecting' | 'connected';

export interface RealtimeConfig {
  serverUrl: string;
  token: string;
}

export interface RealtimeEnv {
  /** Null while the extension is unconfigured — the client then stays off. */
  getConfig(): Promise<RealtimeConfig | null>;
  /** Called for every `version` event received (including the one on connect). */
  onVersion(serverVersion: number): void;
  /**
   * Called periodically while connected. The background wires this to a cheap
   * extension-API call (`chrome.runtime.getPlatformInfo`), which resets the
   * MV3 service-worker idle timer so an active stream keeps its worker alive.
   */
  keepalive(): void;
  log(message: string, detail?: unknown): void;
  fetchFn?: typeof fetch;
  /** Timing overrides for tests. */
  minReconnectMs?: number;
  maxReconnectMs?: number;
  keepaliveMs?: number;
  stallMs?: number;
}

const MIN_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 60_000;
const KEEPALIVE_MS = 20_000;
const STALL_MS = 90_000;

/**
 * Incremental parser for a text/event-stream body. Feed it decoded chunks;
 * it invokes `onEvent` once per complete event (comments and unknown fields
 * are ignored, per the SSE spec subset we need).
 */
export function createSseParser(
  onEvent: (event: string, data: string) => void,
): (chunk: string) => void {
  let buffer = '';
  let eventType = 'message';
  let dataLines: string[] = [];

  const handleLine = (line: string): void => {
    if (line === '') {
      if (dataLines.length > 0) onEvent(eventType, dataLines.join('\n'));
      eventType = 'message';
      dataLines = [];
      return;
    }
    if (line.startsWith(':')) return; // comment / heartbeat
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventType = value;
    else if (field === 'data') dataLines.push(value);
  };

  return (chunk) => {
    buffer += chunk;
    let start = 0;
    for (let i = 0; i < buffer.length; i++) {
      const ch = buffer[i];
      if (ch !== '\n' && ch !== '\r') continue;
      // A trailing CR might be half of a CRLF split across chunks — wait.
      if (ch === '\r' && i === buffer.length - 1) break;
      handleLine(buffer.slice(start, i));
      if (ch === '\r' && buffer[i + 1] === '\n') i++;
      start = i + 1;
    }
    buffer = buffer.slice(start);
  };
}

export class RealtimeClient {
  private currentState: RealtimeState = 'off';
  private running = false;
  /** Bumped by disconnect/restart so an abandoned loop notices and exits. */
  private generation = 0;
  private controller: AbortController | undefined;
  private failures = 0;

  constructor(private env: RealtimeEnv) {}

  get state(): RealtimeState {
    return this.currentState;
  }

  /** Starts the connection loop if it isn't already running. Idempotent —
   * safe to call from every service-worker wake-up. */
  ensureConnected(): void {
    if (this.running) return;
    this.running = true;
    this.generation++;
    void this.loop(this.generation);
  }

  /** Drops the current connection (if any) and reconnects with fresh config. */
  restart(): void {
    this.disconnect();
    this.ensureConnected();
  }

  disconnect(): void {
    this.running = false;
    this.generation++;
    this.controller?.abort();
    this.currentState = 'off';
  }

  private async loop(generation: number): Promise<void> {
    while (this.running && generation === this.generation) {
      const config = await this.env.getConfig();
      if (generation !== this.generation) return;
      if (config === null) {
        // Unconfigured: stop entirely; a config change restarts us.
        this.running = false;
        this.currentState = 'off';
        return;
      }
      try {
        await this.connectOnce(config);
      } catch (error) {
        if (generation === this.generation) this.env.log('realtime stream failed', error);
      }
      if (!this.running || generation !== this.generation) return;
      this.currentState = 'connecting';
      this.failures = Math.min(this.failures + 1, 10);
      const min = this.env.minReconnectMs ?? MIN_RECONNECT_MS;
      const max = this.env.maxReconnectMs ?? MAX_RECONNECT_MS;
      const delay = Math.min(min * 2 ** (this.failures - 1), max);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  /** One connection lifetime: resolves when the server closes the stream,
   * throws on connect failure or abort. */
  private async connectOnce(config: RealtimeConfig): Promise<void> {
    this.currentState = 'connecting';
    const controller = new AbortController();
    this.controller = controller;
    const fetchFn = this.env.fetchFn ?? fetch;
    const base = config.serverUrl.replace(/\/+$/, '');
    const response = await fetchFn(`${base}/api/events`, {
      headers: { Authorization: `Bearer ${config.token}` },
      signal: controller.signal,
    });
    if (!response.ok || response.body === null) {
      throw new Error(`GET /api/events → ${response.status}`);
    }
    this.currentState = 'connected';
    this.failures = 0;

    const parse = createSseParser((event, data) => {
      if (event !== 'version') return;
      try {
        const { serverVersion } = JSON.parse(data) as { serverVersion?: unknown };
        if (typeof serverVersion === 'number') this.env.onVersion(serverVersion);
      } catch {
        this.env.log('unparseable realtime event', data);
      }
    });

    let lastActivity = Date.now();
    const watchdog = setInterval(() => {
      this.env.keepalive();
      if (Date.now() - lastActivity > (this.env.stallMs ?? STALL_MS)) controller.abort();
    }, this.env.keepaliveMs ?? KEEPALIVE_MS);

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        lastActivity = Date.now();
        parse(decoder.decode(value, { stream: true }));
      }
    } finally {
      clearInterval(watchdog);
    }
  }
}
