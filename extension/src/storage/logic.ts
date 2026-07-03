import type { EchoProbe, EchoRecord, Mapping } from '../sync/types.js';

/**
 * An echo record matches a browser event when every identifying field the
 * record *defines* equals the probe's value. Records deliberately carry only
 * what was known when the remote op was applied (a create has no browserId; an
 * update carries only the fields it changed), while probes carry everything the
 * event exposes — so record ⊆ probe is the right direction.
 */
export function echoMatches(record: EchoRecord, probe: EchoProbe): boolean {
  if (record.action !== probe.action) return false;
  for (const field of ['browserId', 'parentBrowserId', 'title', 'url'] as const) {
    if (record[field] !== undefined && record[field] !== probe[field]) return false;
  }
  return true;
}

/** browserIds of `rootBrowserId` and everything under it, per the mapping shadow. */
export function collectSubtree(mappings: Mapping[], rootBrowserId: string): string[] {
  const childrenOf = new Map<string, string[]>();
  for (const m of mappings) {
    const siblings = childrenOf.get(m.parentBrowserId);
    if (siblings) siblings.push(m.browserId);
    else childrenOf.set(m.parentBrowserId, [m.browserId]);
  }
  const result: string[] = [];
  const frontier = [rootBrowserId];
  while (frontier.length > 0) {
    const id = frontier.pop() as string;
    result.push(id);
    frontier.push(...(childrenOf.get(id) ?? []));
  }
  return result;
}
