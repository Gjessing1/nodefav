import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Current bookmark tree — a materialized view of the op log. The cloud owns
 * these uuids; browser bookmark ids never appear here. Rows are soft-deleted
 * (`deletedAt`) and only purged by the Phase 5 retention job.
 */
export const bookmarks = sqliteTable(
  'bookmarks',
  {
    uuid: text('uuid').primaryKey(),
    /** Parent folder uuid; null = root level. */
    parentUuid: text('parent_uuid'),
    type: text('type', { enum: ['bookmark', 'folder'] }).notNull(),
    title: text('title').notNull(),
    url: text('url'),
    /** Fractional ordering key within the parent (provisional scheme, Phase 4). */
    sortOrder: text('sort_order').notNull(),
    /** Client timestamps (ms since epoch) — the LWW domain. */
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
    /** Server seq of the last op applied to this row. */
    version: integer('version').notNull(),
  },
  (table) => [index('bookmarks_parent_idx').on(table.parentUuid)],
);

/**
 * Append-only log of applied operations. `seq` doubles as the single monotonic
 * server version; stale/rejected ops are never logged.
 */
export const operations = sqliteTable(
  'operations',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    /** Client-generated op id — uniqueness gives idempotent uploads. */
    clientOpId: text('client_op_id').notNull(),
    deviceId: text('device_id').notNull(),
    type: text('type', { enum: ['create', 'update', 'move', 'delete'] }).notNull(),
    /** Target bookmark (server-assigned for creates). */
    bookmarkUuid: text('bookmark_uuid').notNull(),
    /** Normalized op JSON as served by GET /api/ops (without seq). */
    payload: text('payload').notNull(),
    /** Client wall-clock ms — LWW input. */
    clientTimestamp: integer('client_timestamp').notNull(),
    /** Server wall-clock ms when the op was applied. */
    appliedAt: integer('applied_at').notNull(),
  },
  (table) => [
    uniqueIndex('operations_client_op_id_idx').on(table.clientOpId),
    index('operations_bookmark_uuid_idx').on(table.bookmarkUuid),
  ],
);

/**
 * Cloud-side enrichment written by the Phase 6 background job — never synced
 * into native bookmark fields (metadata lives in the cloud only). One row per
 * checked bookmark; rows ride along on the bookmark's hard delete (purge).
 */
export const bookmarkMeta = sqliteTable('bookmark_meta', {
  uuid: text('uuid')
    .primaryKey()
    .references(() => bookmarks.uuid, { onDelete: 'cascade' }),
  /** Link health: ok, failing (recent errors), dead (persistent), skipped (non-http). */
  health: text('health', { enum: ['ok', 'failing', 'dead', 'skipped'] }).notNull(),
  /** HTTP status of the last attempt; null when the request itself failed. */
  httpStatus: integer('http_status'),
  pageTitle: text('page_title'),
  faviconUrl: text('favicon_url'),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  /** Last attempt (ms since epoch) — drives the recheck schedule. */
  checkedAt: integer('checked_at').notNull(),
  /** Last successful fetch, null if the URL never answered. */
  okAt: integer('ok_at'),
});

export type BookmarkRow = typeof bookmarks.$inferSelect;
export type OperationRow = typeof operations.$inferSelect;
export type BookmarkMetaRow = typeof bookmarkMeta.$inferSelect;
