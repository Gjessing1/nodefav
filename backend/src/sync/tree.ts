import { isNull } from 'drizzle-orm';
import type { BookmarkNode } from '@nodefav/shared';
import type { Db } from '../database/db.js';
import { bookmarks } from '../database/schema.js';

/** Builds the current (non-deleted) bookmark tree, children sorted by sortOrder. */
export function buildTree(db: Db): BookmarkNode[] {
  const rows = db.select().from(bookmarks).where(isNull(bookmarks.deletedAt)).all();

  const nodes = new Map<string, BookmarkNode>();
  for (const row of rows) {
    nodes.set(row.uuid, {
      uuid: row.uuid,
      parentUuid: row.parentUuid,
      type: row.type,
      title: row.title,
      url: row.url,
      sortOrder: row.sortOrder,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      version: row.version,
      ...(row.type === 'folder' ? { children: [] } : {}),
    });
  }

  const roots: BookmarkNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentUuid === null ? undefined : nodes.get(node.parentUuid);
    if (parent?.children) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const bySortOrder = (a: BookmarkNode, b: BookmarkNode) =>
    a.sortOrder < b.sortOrder ? -1 : a.sortOrder > b.sortOrder ? 1 : a.uuid < b.uuid ? -1 : 1;
  roots.sort(bySortOrder);
  for (const node of nodes.values()) node.children?.sort(bySortOrder);

  return roots;
}
