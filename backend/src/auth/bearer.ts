import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Static single-user bearer auth (provisional through Phase 1). Returns an
 * onRequest hook comparing `Authorization: Bearer <token>` against the
 * configured token, in constant time.
 */
export function bearerAuth(syncToken: string) {
  const expected = createHash('sha256').update(syncToken).digest();
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
    const actual = token ? createHash('sha256').update(token).digest() : undefined;
    if (!actual || !timingSafeEqual(expected, actual)) {
      await reply.code(401).send({ error: 'unauthorized' });
    }
  };
}
