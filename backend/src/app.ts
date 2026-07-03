import { createRequire } from 'node:module';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { HealthResponse } from '@nodefav/shared';
import { syncRoutes } from './api/syncRoutes.js';
import type { Db } from './database/db.js';
import { DEFAULT_RETENTION_DAYS } from './jobs/retention.js';
import { createVersionBus } from './sync/events.js';

// Resolves to backend/package.json both from src/ (dev, tests) and dist/ (runtime).
const pkg = createRequire(import.meta.url)('../package.json') as { version: string };

export interface AppOptions {
  db: Db;
  syncToken: string;
  retentionDays?: number;
  logger?: boolean;
}

export function buildApp({
  db,
  syncToken,
  retentionDays = DEFAULT_RETENTION_DAYS,
  logger = true,
}: AppOptions): FastifyInstance {
  const app = Fastify({ logger });

  app.get('/health', (): HealthResponse => {
    return {
      status: 'ok',
      version: pkg.version,
      gitSha: process.env.GIT_SHA ?? 'unknown',
    };
  });

  const bus = createVersionBus();
  app.register((instance) => syncRoutes(instance, { db, syncToken, retentionDays, bus }), {
    prefix: '/api',
  });

  return app;
}
