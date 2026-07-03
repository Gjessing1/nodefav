import type { SyncOp } from '@nodefav/shared';

const MAX_BATCH_SIZE = 1000;

/**
 * Structural validation of an uploaded op batch. Shape errors are client bugs
 * and fail the whole request (400); referential problems (unknown uuid, bad
 * parent) are legitimate races and surface later as per-op `rejected` results.
 */
export function validateOpsBody(body: unknown): { ops: SyncOp[] } | { error: string } {
  if (
    typeof body !== 'object' ||
    body === null ||
    !Array.isArray((body as { ops?: unknown }).ops)
  ) {
    return { error: 'body must be an object with an "ops" array' };
  }
  const raw = (body as { ops: unknown[] }).ops;
  if (raw.length > MAX_BATCH_SIZE) {
    return { error: `batch exceeds ${MAX_BATCH_SIZE} ops` };
  }

  const ops: SyncOp[] = [];
  for (const [i, value] of raw.entries()) {
    const result = validateOp(value);
    if (typeof result === 'string') return { error: `ops[${i}]: ${result}` };
    ops.push(result);
  }
  return { ops };
}

function validateOp(value: unknown): SyncOp | string {
  if (typeof value !== 'object' || value === null) return 'op must be an object';
  const op = value as Record<string, unknown>;

  if (typeof op.opId !== 'string' || op.opId.length === 0) return 'opId must be a non-empty string';
  if (typeof op.deviceId !== 'string' || op.deviceId.length === 0)
    return 'deviceId must be a non-empty string';
  if (typeof op.timestamp !== 'number' || !Number.isFinite(op.timestamp) || op.timestamp < 0)
    return 'timestamp must be a non-negative number';

  const uuid = () =>
    typeof op.uuid === 'string' && op.uuid.length > 0 ? null : 'uuid must be a non-empty string';
  const parentUuid = () =>
    op.parentUuid === null || (typeof op.parentUuid === 'string' && op.parentUuid.length > 0)
      ? null
      : 'parentUuid must be a non-empty string or null';
  const sortOrder = () =>
    typeof op.sortOrder === 'string' && op.sortOrder.length > 0
      ? null
      : 'sortOrder must be a non-empty string';

  switch (op.type) {
    case 'create': {
      if (op.uuid !== undefined) return 'uuid is server-assigned and must not be sent on create';
      if (op.nodeType !== 'bookmark' && op.nodeType !== 'folder')
        return 'nodeType must be "bookmark" or "folder"';
      if (typeof op.title !== 'string') return 'title must be a string';
      if (op.nodeType === 'bookmark' && (typeof op.url !== 'string' || op.url.length === 0))
        return 'bookmarks require a url';
      if (op.nodeType === 'folder' && op.url !== undefined) return 'folders must not have a url';
      return parentUuid() ?? sortOrder() ?? (value as SyncOp);
    }
    case 'update': {
      if (op.title === undefined && op.url === undefined) return 'update must set title and/or url';
      if (op.title !== undefined && typeof op.title !== 'string') return 'title must be a string';
      if (op.url !== undefined && typeof op.url !== 'string') return 'url must be a string';
      return uuid() ?? (value as SyncOp);
    }
    case 'move':
      return uuid() ?? parentUuid() ?? sortOrder() ?? (value as SyncOp);
    case 'delete':
      return uuid() ?? (value as SyncOp);
    default:
      return 'type must be one of create, update, move, delete';
  }
}
