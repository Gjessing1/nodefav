import { createRequire } from 'node:module';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { HealthResponse } from '@nodefav/shared';

// Resolves to backend/package.json both from src/ (dev, tests) and dist/ (runtime).
const pkg = createRequire(import.meta.url)('../package.json') as { version: string };

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: true });

  app.get('/health', (): HealthResponse => {
    return {
      status: 'ok',
      version: pkg.version,
      gitSha: process.env.GIT_SHA ?? 'unknown',
    };
  });

  return app;
}
