import { buildApp } from './app.js';
import { createDb } from './database/db.js';

const syncToken = process.env.NODEFAV_SYNC_TOKEN;
if (!syncToken) {
  console.error('NODEFAV_SYNC_TOKEN is required');
  process.exit(1);
}

const dataDir = process.env.NODEFAV_DATA_DIR ?? './data';
const db = createDb(dataDir);

const app = buildApp({ db, syncToken });

const port = Number(process.env.PORT ?? 3000);

try {
  await app.listen({ port, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
