import type { BookmarkNodeLite, ChangeInfo, MoveInfo, RemoveInfo } from '../chrome/bookmarksApi.js';
import { handleChanged, handleCreated, handleMoved, handleRemoved } from './capture.js';
import { META } from './context.js';
import type { EngineEnv } from './context.js';
import { ensureInitialized } from './initial.js';
import { flush } from './uploader.js';

export interface SyncStatus {
  configured: boolean;
  initialized: boolean;
  queueDepth: number;
  mappingCount: number;
  cursor: number;
  lastSyncAt: number | undefined;
  lastError: string | undefined;
}

const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 15 * 60_000;

/**
 * The extension's sync brain. Every entry point runs on one FIFO mutex: event
 * handlers stay in browser-delivery order and never interleave with an upload
 * or pull at an await point. All state lives in the injected stores — a
 * service-worker death loses nothing but an in-flight step, and every step is
 * idempotent to retry.
 */
export class SyncEngine {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private ctx: EngineEnv) {}

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private handle(name: string, fn: () => Promise<void>): Promise<void> {
    return this.run(fn).catch((error) => this.ctx.log(`${name} handler failed`, error));
  }

  handleCreated(id: string, node: BookmarkNodeLite): Promise<void> {
    return this.handle('onCreated', () => handleCreated(this.ctx, id, node));
  }
  handleChanged(id: string, changeInfo: ChangeInfo): Promise<void> {
    return this.handle('onChanged', () => handleChanged(this.ctx, id, changeInfo));
  }
  handleMoved(id: string, moveInfo: MoveInfo): Promise<void> {
    return this.handle('onMoved', () => handleMoved(this.ctx, id, moveInfo));
  }
  handleRemoved(id: string, removeInfo: RemoveInfo): Promise<void> {
    return this.handle('onRemoved', () => handleRemoved(this.ctx, id, removeInfo));
  }

  /**
   * One full cycle: initialize if needed, then upload the queue. Failures set
   * exponential backoff (respected by periodic alarms, overridden by `force`)
   * and are surfaced via status().
   */
  sync(options?: { force?: boolean }): Promise<void> {
    return this.run(async () => {
      const meta = this.ctx.stores.meta;
      if (!options?.force) {
        const nextAttemptAt = (await meta.get<number>(META.nextAttemptAt)) ?? 0;
        if (this.ctx.now() < nextAttemptAt) return;
      }
      try {
        if (!(await ensureInitialized(this.ctx))) return;
        await flush(this.ctx);
        await meta.set(META.lastSyncAt, this.ctx.now());
        await meta.remove(META.lastError);
        await meta.remove(META.failureCount);
        await meta.remove(META.nextAttemptAt);
      } catch (error) {
        const failures = ((await meta.get<number>(META.failureCount)) ?? 0) + 1;
        await meta.set(META.failureCount, failures);
        await meta.set(
          META.nextAttemptAt,
          this.ctx.now() + Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS),
        );
        await meta.set(META.lastError, String(error));
        this.ctx.log('sync failed', error);
      }
    });
  }

  /** Resolves once everything currently queued on the mutex has run. */
  idle(): Promise<void> {
    return this.run(() => Promise.resolve());
  }

  /** Point-in-time snapshot for the options page; reads outside the mutex. */
  async status(): Promise<SyncStatus> {
    const meta = this.ctx.stores.meta;
    return {
      configured: (await this.ctx.getApi()) !== null,
      initialized: (await meta.get<boolean>(META.initialized)) === true,
      queueDepth: await this.ctx.stores.queue.size(),
      mappingCount: await this.ctx.stores.mappings.size(),
      cursor: (await meta.get<number>(META.cursor)) ?? 0,
      lastSyncAt: await meta.get<number>(META.lastSyncAt),
      lastError: await meta.get<string>(META.lastError),
    };
  }
}
