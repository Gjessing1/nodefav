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

/**
 * In-memory implementation of the storage interfaces. Used by the test suite,
 * where "durable" means "survives a simulated service-worker death" — tests
 * keep the store instances and re-create the engine around them.
 */
export function memoryStores(): SyncStores {
  return {
    meta: new MemoryMeta(),
    queue: new MemoryQueue(),
    mappings: new MemoryMappings(),
    echoes: new MemoryEchoes(),
  };
}

class MemoryMeta implements MetaStore {
  private data = new Map<string, unknown>();

  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.data.get(key) as T | undefined);
  }
  set(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
    return Promise.resolve();
  }
  remove(key: string): Promise<void> {
    this.data.delete(key);
    return Promise.resolve();
  }
}

class MemoryQueue implements QueueStore {
  private items: QueuedOp[] = [];
  private nextQid = 1;

  enqueue(op: QueuedOpInput): Promise<QueuedOp> {
    const item = { ...op, qid: this.nextQid++ };
    this.items.push(item);
    return Promise.resolve(item);
  }
  peek(limit: number): Promise<QueuedOp[]> {
    return Promise.resolve(this.items.slice(0, limit).map((i) => ({ ...i })));
  }
  remove(qids: number[]): Promise<void> {
    const gone = new Set(qids);
    this.items = this.items.filter((i) => !gone.has(i.qid));
    return Promise.resolve();
  }
  size(): Promise<number> {
    return Promise.resolve(this.items.length);
  }
}

class MemoryMappings implements MappingStore {
  private byBrowserId = new Map<string, Mapping>();

  get(browserId: string): Promise<Mapping | undefined> {
    const m = this.byBrowserId.get(browserId);
    return Promise.resolve(m ? { ...m } : undefined);
  }
  getByUuid(uuid: string): Promise<Mapping | undefined> {
    for (const m of this.byBrowserId.values()) {
      if (m.uuid === uuid) return Promise.resolve({ ...m });
    }
    return Promise.resolve(undefined);
  }
  put(mapping: Mapping): Promise<void> {
    this.byBrowserId.set(mapping.browserId, { ...mapping });
    return Promise.resolve();
  }
  async setUuid(browserId: string, uuid: string): Promise<void> {
    const m = this.byBrowserId.get(browserId);
    if (m) m.uuid = uuid;
    return Promise.resolve();
  }
  removeSubtree(browserId: string): Promise<void> {
    for (const id of collectSubtree([...this.byBrowserId.values()], browserId)) {
      this.byBrowserId.delete(id);
    }
    return Promise.resolve();
  }
  all(): Promise<Mapping[]> {
    return Promise.resolve([...this.byBrowserId.values()].map((m) => ({ ...m })));
  }
  size(): Promise<number> {
    return Promise.resolve(this.byBrowserId.size);
  }
}

class MemoryEchoes implements EchoStore {
  private records: EchoRecord[] = [];
  private nextId = 1;

  add(echo: EchoInput): Promise<EchoRecord> {
    const record = { ...echo, id: this.nextId++, createdAt: Date.now() };
    this.records.push(record);
    return Promise.resolve({ ...record });
  }
  consume(probe: EchoProbe): Promise<EchoRecord | undefined> {
    const index = this.records.findIndex((r) => echoMatches(r, probe));
    if (index === -1) return Promise.resolve(undefined);
    const [record] = this.records.splice(index, 1);
    return Promise.resolve(record);
  }
  findByUuid(uuid: string, action: EchoAction): Promise<EchoRecord | undefined> {
    const record = this.records.find((r) => r.uuid === uuid && r.action === action);
    return Promise.resolve(record ? { ...record } : undefined);
  }
  remove(id: number): Promise<void> {
    this.records = this.records.filter((r) => r.id !== id);
    return Promise.resolve();
  }
  purgeOlderThan(cutoff: number): Promise<number> {
    const before = this.records.length;
    this.records = this.records.filter((r) => r.createdAt >= cutoff);
    return Promise.resolve(before - this.records.length);
  }
  size(): Promise<number> {
    return Promise.resolve(this.records.length);
  }
}
