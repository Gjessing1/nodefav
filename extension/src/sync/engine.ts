import type { BookmarkNodeLite, ChangeInfo, MoveInfo, RemoveInfo } from '../chrome/bookmarksApi.js';
import { handleChanged, handleCreated, handleMoved, handleRemoved } from './capture.js';
import { META } from './context.js';
import type { EngineEnv } from './context.js';
import { applyInitialChoice, ensureInitialized, reconcileRoots } from './initial.js';
import type { InitialChoice } from './initial.js';
import { pull } from './puller.js';
import { reconcile } from './reconcile.js';
import { flush } from './uploader.js';

export interface SyncStatus {
  configured: boolean;
  initialized: boolean;
  /** True while first-sync setup waits for a keep-local/keep-cloud/merge choice. */
  pendingInitialChoice: boolean;
  queueDepth: number;
  mappingCount: number;
  cursor: number;
  lastSyncAt: number | undefined;
  lastError: string | undefined;
  lastReconcileAt: number | undefined;
  /** Summary of the drift the last reconciliation found; undefined while clean. */
  lastDrift: string | undefined;
}

const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 15 * 60_000;

/** Drift detection is a backstop — rare and cheap, not a sync mechanism. */
const RECONCILE_INTERVAL_MS = 6 * 60 * 60_000;

/**
 * How long an unconsumed expected-echo record may live. Echoes normally arrive
 * within the same event-loop turn; even a service-worker death only delays one
 * until the next worker starts. A record this old belongs to an event the
 * browser will never deliver (e.g. a failed native mutation) and would only
 * risk swallowing a genuine future edit.
 */
const ECHO_TTL_MS = 10 * 60_000;

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
   * One full cycle: initialize if needed, upload the queue, then pull and apply
   * remote operations. Once caught up, root reconciliation may enqueue creates
   * for cloud-unknown browser roots — flushed in the same cycle. Failures set
   * exponential backoff (respected by periodic alarms, overridden by `force`)
   * and are surfaced via status().
   */
  sync(options?: { force?: boolean; reconcile?: boolean }): Promise<void> {
    return this.run(() =>
      this.cycle(options?.force === true, undefined, options?.reconcile === true),
    );
  }

  /**
   * Applies the user's first-sync decision (options page), then runs a full
   * forced cycle so the outcome uploads/materializes immediately.
   */
  resolveInitialChoice(choice: InitialChoice): Promise<void> {
    return this.run(() => this.cycle(true, choice, false));
  }

  private async cycle(
    force: boolean,
    choice: InitialChoice | undefined,
    reconcileRequested: boolean,
  ): Promise<void> {
    const meta = this.ctx.stores.meta;
    if (!force) {
      const nextAttemptAt = (await meta.get<number>(META.nextAttemptAt)) ?? 0;
      if (this.ctx.now() < nextAttemptAt) return;
    }
    try {
      if (choice !== undefined) await applyInitialChoice(this.ctx, choice);
      if (!(await ensureInitialized(this.ctx))) return;
      await flush(this.ctx);
      if (await pull(this.ctx)) {
        await reconcileRoots(this.ctx);
        await flush(this.ctx);
        await this.maybeReconcile(reconcileRequested);
      }
      const purged = await this.ctx.stores.echoes.purgeOlderThan(this.ctx.now() - ECHO_TTL_MS);
      if (purged > 0) this.ctx.log(`purged ${purged} expired echo record(s)`);
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
  }

  /**
   * Drift-detection backstop, on its RECONCILE_INTERVAL_MS clock (or forced
   * from the options page). Missed-upload drift flushes + pulls, then verifies
   * with a second pass. Skips don't advance the clock, so a busy cycle simply
   * retries on the next one.
   */
  private async maybeReconcile(requested: boolean): Promise<void> {
    const meta = this.ctx.stores.meta;
    const last = (await meta.get<number>(META.lastReconcileAt)) ?? 0;
    if (!requested && this.ctx.now() - last < RECONCILE_INTERVAL_MS) return;

    let queued = 0;
    let outcome = await reconcile(this.ctx);
    if (outcome.status === 'uploads-queued') {
      queued = outcome.queued;
      await flush(this.ctx);
      if (await pull(this.ctx)) outcome = await reconcile(this.ctx);
    }
    if (outcome.status === 'skipped') {
      this.ctx.log(`reconcile skipped: ${outcome.reason}`);
      if (queued === 0) return;
    }
    await meta.set(META.lastReconcileAt, this.ctx.now());

    const drift: string[] = [];
    if (queued > 0) drift.push(`re-uploaded ${queued} unsynced local subtree(s)`);
    if (outcome.status === 'repaired') {
      drift.push(
        `repaired ${outcome.repaired} drifted item(s)` +
          (outcome.residualDrift ? ' — residual drift, will retry' : ''),
      );
    }
    if (drift.length === 0) {
      await meta.remove(META.lastDrift);
    } else {
      const summary = `${drift.join('; ')} (${new Date(this.ctx.now()).toISOString()})`;
      await meta.set(META.lastDrift, summary);
      this.ctx.log(`reconcile: ${summary}`);
    }
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
      pendingInitialChoice: (await meta.get<boolean>(META.pendingChoice)) === true,
      queueDepth: await this.ctx.stores.queue.size(),
      mappingCount: await this.ctx.stores.mappings.size(),
      cursor: (await meta.get<number>(META.cursor)) ?? 0,
      lastSyncAt: await meta.get<number>(META.lastSyncAt),
      lastError: await meta.get<string>(META.lastError),
      lastReconcileAt: await meta.get<number>(META.lastReconcileAt),
      lastDrift: await meta.get<string>(META.lastDrift),
    };
  }
}
