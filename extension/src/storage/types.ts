import type {
  EchoAction,
  EchoInput,
  EchoRecord,
  EchoProbe,
  Mapping,
  QueuedOp,
  QueuedOpInput,
} from '../sync/types.js';

/** Small key-value store: deviceId, sync cursor, initialized flag, status fields. */
export interface MetaStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

/** Durable FIFO of captured edits awaiting upload. */
export interface QueueStore {
  enqueue(op: QueuedOpInput): Promise<QueuedOp>;
  /** The oldest `limit` items, in qid order. */
  peek(limit: number): Promise<QueuedOp[]>;
  remove(qids: number[]): Promise<void>;
  size(): Promise<number>;
}

export interface MappingStore {
  get(browserId: string): Promise<Mapping | undefined>;
  getByUuid(uuid: string): Promise<Mapping | undefined>;
  put(mapping: Mapping): Promise<void>;
  setUuid(browserId: string, uuid: string): Promise<void>;
  /** Removes the mapping and everything reachable through parentBrowserId. */
  removeSubtree(browserId: string): Promise<void>;
  all(): Promise<Mapping[]>;
  size(): Promise<number>;
}

export interface EchoStore {
  add(echo: EchoInput): Promise<EchoRecord>;
  /** Oldest record matching the probe (see `echoMatches`), removed atomically. */
  consume(probe: EchoProbe): Promise<EchoRecord | undefined>;
  /** Oldest record for a uuid+action — crash-retry detection on remote creates. */
  findByUuid(uuid: string, action: EchoAction): Promise<EchoRecord | undefined>;
  remove(id: number): Promise<void>;
  purgeOlderThan(cutoff: number): Promise<number>;
  size(): Promise<number>;
}

export interface SyncStores {
  meta: MetaStore;
  queue: QueueStore;
  mappings: MappingStore;
  echoes: EchoStore;
}
