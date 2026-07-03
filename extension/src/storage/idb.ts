import type {
  EchoAction,
  EchoInput,
  EchoProbe,
  EchoRecord,
  Mapping,
  QueuedOp,
  QueuedOpInput,
} from '../sync/types.js';
import { collectSubtree, echoMatches } from './logic.js';
import type { EchoStore, MappingStore, MetaStore, QueueStore, SyncStores } from './types.js';

const DB_NAME = 'nodefav';
const DB_VERSION = 1;

/**
 * IndexedDB-backed implementation of the storage interfaces (provisional
 * decision, validated in Phase 2). One database, four object stores; every
 * store method is one transaction. Crash windows between related writes are
 * tolerated by the sync logic being idempotent, not by multi-store atomicity.
 */
export function idbStores(): SyncStores {
  const db = new Connection();
  return {
    meta: new IdbMeta(db),
    queue: new IdbQueue(db),
    mappings: new IdbMappings(db),
    echoes: new IdbEchoes(db),
  };
}

class Connection {
  private promise: Promise<IDBDatabase> | undefined;

  open(): Promise<IDBDatabase> {
    this.promise ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('meta');
        db.createObjectStore('queue', { keyPath: 'qid', autoIncrement: true });
        const mappings = db.createObjectStore('mappings', { keyPath: 'browserId' });
        mappings.createIndex('uuid', 'uuid');
        db.createObjectStore('echoes', { keyPath: 'id', autoIncrement: true });
      };
      request.onsuccess = () => {
        // If the browser closes the connection (e.g. profile cleanup), reopen lazily.
        request.result.onclose = () => (this.promise = undefined);
        resolve(request.result);
      };
      request.onerror = () => reject(request.error ?? new Error('indexedDB open failed'));
    });
    return this.promise;
  }

  /** Runs `fn` inside a transaction on one store; resolves when it commits. */
  async run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => T): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const result = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error ?? new Error('indexedDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('indexedDB transaction aborted'));
    });
  }
}

/** Wraps a request whose result is needed inside the transaction callback. */
function req<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('indexedDB request failed'));
  });
}

class IdbMeta implements MetaStore {
  constructor(private db: Connection) {}

  async get<T>(key: string): Promise<T | undefined> {
    const db = await this.db.open();
    return req(db.transaction('meta').objectStore('meta').get(key)) as Promise<T | undefined>;
  }
  async set(key: string, value: unknown): Promise<void> {
    await this.db.run('meta', 'readwrite', (s) => s.put(value, key));
  }
  async remove(key: string): Promise<void> {
    await this.db.run('meta', 'readwrite', (s) => s.delete(key));
  }
}

class IdbQueue implements QueueStore {
  constructor(private db: Connection) {}

  async enqueue(op: QueuedOpInput): Promise<QueuedOp> {
    const db = await this.db.open();
    const tx = db.transaction('queue', 'readwrite');
    const qid = (await req(tx.objectStore('queue').add(op))) as number;
    return { ...op, qid };
  }
  async peek(limit: number): Promise<QueuedOp[]> {
    const db = await this.db.open();
    return req(db.transaction('queue').objectStore('queue').getAll(undefined, limit));
  }
  async remove(qids: number[]): Promise<void> {
    await this.db.run('queue', 'readwrite', (s) => {
      for (const qid of qids) s.delete(qid);
    });
  }
  async size(): Promise<number> {
    const db = await this.db.open();
    return req(db.transaction('queue').objectStore('queue').count());
  }
}

class IdbMappings implements MappingStore {
  constructor(private db: Connection) {}

  async get(browserId: string): Promise<Mapping | undefined> {
    const db = await this.db.open();
    return req(db.transaction('mappings').objectStore('mappings').get(browserId));
  }
  async getByUuid(uuid: string): Promise<Mapping | undefined> {
    const db = await this.db.open();
    return req(db.transaction('mappings').objectStore('mappings').index('uuid').get(uuid));
  }
  async put(mapping: Mapping): Promise<void> {
    await this.db.run('mappings', 'readwrite', (s) => s.put(mapping));
  }
  async setUuid(browserId: string, uuid: string): Promise<void> {
    const db = await this.db.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('mappings', 'readwrite');
      const store = tx.objectStore('mappings');
      const get = store.get(browserId);
      get.onsuccess = () => {
        const mapping = get.result as Mapping | undefined;
        if (mapping) store.put({ ...mapping, uuid });
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('indexedDB transaction failed'));
    });
  }
  async removeSubtree(browserId: string): Promise<void> {
    const everything = await this.all();
    const ids = collectSubtree(everything, browserId);
    await this.db.run('mappings', 'readwrite', (s) => {
      for (const id of ids) s.delete(id);
    });
  }
  async all(): Promise<Mapping[]> {
    const db = await this.db.open();
    return req(db.transaction('mappings').objectStore('mappings').getAll());
  }
  async size(): Promise<number> {
    const db = await this.db.open();
    return req(db.transaction('mappings').objectStore('mappings').count());
  }
}

class IdbEchoes implements EchoStore {
  constructor(private db: Connection) {}

  async add(echo: EchoInput): Promise<EchoRecord> {
    const db = await this.db.open();
    const record = { ...echo, createdAt: Date.now() };
    const tx = db.transaction('echoes', 'readwrite');
    const id = (await req(tx.objectStore('echoes').add(record))) as number;
    return { ...record, id };
  }
  async consume(probe: EchoProbe): Promise<EchoRecord | undefined> {
    const db = await this.db.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('echoes', 'readwrite');
      const store = tx.objectStore('echoes');
      const getAll = store.getAll();
      let matched: EchoRecord | undefined;
      getAll.onsuccess = () => {
        // The echo store stays small; a full scan keeps matching in one place.
        matched = (getAll.result as EchoRecord[]).find((r) => echoMatches(r, probe));
        if (matched) store.delete(matched.id);
      };
      tx.oncomplete = () => resolve(matched);
      tx.onerror = () => reject(tx.error ?? new Error('indexedDB transaction failed'));
    });
  }
  async findByUuid(uuid: string, action: EchoAction): Promise<EchoRecord | undefined> {
    const all = await this.allRecords();
    return all.find((r) => r.uuid === uuid && r.action === action);
  }
  async remove(id: number): Promise<void> {
    await this.db.run('echoes', 'readwrite', (s) => s.delete(id));
  }
  async purgeOlderThan(cutoff: number): Promise<number> {
    const stale = (await this.allRecords()).filter((r) => r.createdAt < cutoff);
    await this.db.run('echoes', 'readwrite', (s) => {
      for (const r of stale) s.delete(r.id);
    });
    return stale.length;
  }
  async size(): Promise<number> {
    const db = await this.db.open();
    return req(db.transaction('echoes').objectStore('echoes').count());
  }
  private async allRecords(): Promise<EchoRecord[]> {
    const db = await this.db.open();
    return req(db.transaction('echoes').objectStore('echoes').getAll());
  }
}
