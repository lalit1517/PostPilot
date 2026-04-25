// Standalone worker bootstrap (used by `npm run worker`). The monolith path runs runWorker()
// from server.ts; this entry exists only for split-process deploys. Probes DB before starting.
import 'dotenv/config';
import { prisma } from './db.js';
import { logger } from './logger.js';
import { runWorker } from './worker.js';

async function main() {
  await prisma.$queryRaw`SELECT 1`;
  runWorker();
}

async function shutdown(signal: string) {
  logger.info({ signal }, "Worker shutting down");
  await prisma.$disconnect();
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

main().catch(async (err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  logger.error({ err: message }, "Worker failed to start");
  await prisma.$disconnect();
  process.exit(1);
});
