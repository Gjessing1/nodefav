import { checksumEntriesFromTree, treeChecksum } from '@nodefav/shared';
import type {
  BookmarkNode,
  GetBookmarksResponse,
  GetChecksumResponse,
  GetOpsResponse,
  OpResult,
  PostOpsResponse,
  RemoteOp,
  SyncOp,
} from '@nodefav/shared';
import type { SyncApi } from '../api/client.js';

interface ServerNode {
  uuid: string;
  parentUuid: string | null;
  type: 'bookmark' | 'folder';
  title: string;
  url: string | null;
  sortOrder: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  version: number;
}

/**
 * LWW field groups, mirroring the backend: updates (title/url) compete with
 * creates + updates, moves (parent/order) with creates + moves. An op loses
 * only to a strictly newer already-applied op in its group.
 */
const LWW_GROUPS = {
  update: ['create', 'update'],
  move: ['create', 'move'],
} as const;

/**
 * In-memory stand-in for the backend sync API: op log with a monotonic seq,
 * opId dedup, server-assigned uuids, soft-delete cascade, and the backend's
 * LWW staleness semantics — the two-profile matrix relies on parity here.
 */
export class FakeSyncServer implements SyncApi {
  offline = false;
  postOpsCalls = 0;
  private log: RemoteOp[] = [];
  private resultsByOpId = new Map<string, OpResult>();
  private nodes = new Map<string, ServerNode>();
  private nextUuid = 1;

  opCount(): number {
    return this.log.length;
  }

  postOps(ops: SyncOp[]): Promise<PostOpsResponse> {
    if (this.offline) return Promise.reject(new Error('network down'));
    this.postOpsCalls += 1;
    const results = ops.map((op) => this.applyOne(op));
    return Promise.resolve({ results, serverVersion: this.log.length });
  }

  getOps(since: number, limit: number): Promise<GetOpsResponse> {
    if (this.offline) return Promise.reject(new Error('network down'));
    const ops = this.log.filter((op) => op.seq > since).slice(0, limit);
    return Promise.resolve({ ops, serverVersion: this.log.length });
  }

  getBookmarks(): Promise<GetBookmarksResponse> {
    if (this.offline) return Promise.reject(new Error('network down'));
    const live = [...this.nodes.values()].filter((n) => n.deletedAt === null);
    const build = (parentUuid: string | null): BookmarkNode[] =>
      live
        .filter((n) => n.parentUuid === parentUuid)
        .sort((a, b) =>
          a.sortOrder < b.sortOrder ? -1 : a.sortOrder > b.sortOrder ? 1 : a.uuid < b.uuid ? -1 : 1,
        )
        .map((n) => ({
          uuid: n.uuid,
          parentUuid: n.parentUuid,
          type: n.type,
          title: n.title,
          url: n.url,
          sortOrder: n.sortOrder,
          createdAt: n.createdAt,
          updatedAt: n.updatedAt,
          version: n.version,
          ...(n.type === 'folder' ? { children: build(n.uuid) } : {}),
        }));
    return Promise.resolve({ roots: build(null), serverVersion: this.log.length });
  }

  async getChecksum(): Promise<GetChecksumResponse> {
    const { roots, serverVersion } = await this.getBookmarks();
    const entries = checksumEntriesFromTree(roots);
    return {
      checksum: treeChecksum(entries),
      count: entries.length,
      rootUuids: roots.map((root) => root.uuid).sort(),
      serverVersion,
    };
  }

  private applyOne(op: SyncOp): OpResult {
    const prior = this.resultsByOpId.get(op.opId);
    if (prior) return { ...prior, status: 'duplicate' };

    const result = this.apply(op);
    if (result.status === 'applied') this.resultsByOpId.set(op.opId, result);
    return result;
  }

  private apply(op: SyncOp): OpResult {
    const rejected = (error: string): OpResult => ({ opId: op.opId, status: 'rejected', error });

    switch (op.type) {
      case 'create': {
        if (op.parentUuid !== null && !this.liveFolder(op.parentUuid)) {
          return rejected(`bad parent ${op.parentUuid}`);
        }
        const uuid = `srv-${this.nextUuid++}`;
        this.nodes.set(uuid, {
          uuid,
          parentUuid: op.parentUuid,
          type: op.nodeType,
          title: op.title,
          url: op.nodeType === 'bookmark' ? (op.url ?? null) : null,
          sortOrder: op.sortOrder,
          createdAt: op.timestamp,
          updatedAt: op.timestamp,
          deletedAt: null,
          version: 0,
        });
        return this.logOp(op, uuid);
      }
      case 'update': {
        const node = this.nodes.get(op.uuid);
        if (!node) return rejected(`unknown ${op.uuid}`);
        if (this.isStale(op.uuid, 'update', op.timestamp)) {
          return { opId: op.opId, status: 'stale', uuid: op.uuid };
        }
        if (op.title !== undefined) node.title = op.title;
        if (op.url !== undefined && node.type === 'bookmark') node.url = op.url;
        node.updatedAt = op.timestamp;
        return this.logOp(op, op.uuid);
      }
      case 'move': {
        const node = this.nodes.get(op.uuid);
        if (!node) return rejected(`unknown ${op.uuid}`);
        if (op.parentUuid !== null && !this.liveFolder(op.parentUuid)) {
          return rejected(`bad parent ${op.parentUuid}`);
        }
        if (this.isStale(op.uuid, 'move', op.timestamp)) {
          return { opId: op.opId, status: 'stale', uuid: op.uuid };
        }
        node.parentUuid = op.parentUuid;
        node.sortOrder = op.sortOrder;
        node.updatedAt = op.timestamp;
        return this.logOp(op, op.uuid);
      }
      case 'delete': {
        const node = this.nodes.get(op.uuid);
        if (!node) return rejected(`unknown ${op.uuid}`);
        const frontier = [op.uuid];
        while (frontier.length > 0) {
          const uuid = frontier.pop() as string;
          const n = this.nodes.get(uuid) as ServerNode;
          if (n.deletedAt === null) {
            n.deletedAt = op.timestamp;
            frontier.push(
              ...[...this.nodes.values()]
                .filter((c) => c.parentUuid === uuid && c.deletedAt === null)
                .map((c) => c.uuid),
            );
          }
        }
        return this.logOp(op, op.uuid);
      }
    }
  }

  private logOp(op: SyncOp, uuid: string): OpResult {
    const seq = this.log.length + 1;
    this.log.push({ ...op, uuid, seq });
    const node = this.nodes.get(uuid);
    if (node) node.version = seq;
    return { opId: op.opId, status: 'applied', uuid, seq };
  }

  private isStale(uuid: string, group: keyof typeof LWW_GROUPS, timestamp: number): boolean {
    const types: readonly string[] = LWW_GROUPS[group];
    return this.log.some(
      (logged) =>
        logged.uuid === uuid && types.includes(logged.type) && logged.timestamp > timestamp,
    );
  }

  private liveFolder(uuid: string): boolean {
    const node = this.nodes.get(uuid);
    return node !== undefined && node.type === 'folder' && node.deletedAt === null;
  }
}
