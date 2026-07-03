import type { BookmarkNode, BookmarkType } from './sync.js';

/**
 * The reconciliation checksum covers exactly the state a client can rebuild
 * from its native tree + mapping shadow. Root-level nodes are excluded: their
 * titles are browser-localized and their position is fixed natively, so they
 * can never be repaired and would only produce permanent false drift. The
 * server tells clients which uuids are root-level (`GetChecksumResponse.rootUuids`).
 */
export interface ChecksumEntry {
  uuid: string;
  parentUuid: string | null;
  type: BookmarkType;
  title: string;
  url: string | null;
  sortOrder: string;
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/**
 * Order-independent tree checksum: one canonical line per entry, sorted, then
 * FNV-1a-64 over the concatenation. Not cryptographic — it only needs to make
 * accidental drift visible.
 */
export function treeChecksum(entries: ChecksumEntry[]): string {
  const lines = entries
    .map((e) =>
      [e.uuid, e.parentUuid ?? '', e.type, e.title, e.url ?? '', e.sortOrder].join('\u001f'),
    )
    .sort();
  let hash = FNV_OFFSET;
  for (const line of lines) {
    for (let i = 0; i < line.length; i += 1) {
      hash = ((hash ^ BigInt(line.charCodeAt(i))) * FNV_PRIME) & MASK_64;
    }
    hash = ((hash ^ 10n) * FNV_PRIME) & MASK_64; // '\n' terminator per line
  }
  return hash.toString(16).padStart(16, '0');
}

/** Checksum entries for a served tree — every node below the root level. */
export function checksumEntriesFromTree(roots: BookmarkNode[]): ChecksumEntry[] {
  const entries: ChecksumEntry[] = [];
  const walk = (node: BookmarkNode): void => {
    if (node.parentUuid !== null) {
      entries.push({
        uuid: node.uuid,
        parentUuid: node.parentUuid,
        type: node.type,
        title: node.title,
        url: node.url,
        sortOrder: node.sortOrder,
      });
    }
    for (const child of node.children ?? []) walk(child);
  };
  for (const root of roots) walk(root);
  return entries;
}
