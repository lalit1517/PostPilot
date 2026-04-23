/*
 * CHANGES (graceful shutdown):
 * - stopKeepalive() called before $disconnect() so the 3min interval doesn't
 *   fire against a closing client ("client already closed" error).
 */
import 'dotenv/config';
import { prisma, stopKeepalive } from './db.js';
import { logger } from './logger.js';
import { runWorker } from './worker.js';

async function main() {
  await prisma.$queryRaw`SELECT 1`;
  runWorker();
}

async function shutdown(signal: string) {
  logger.info({ signal }, "Worker shutting down");
  stopKeepalive();
  await prisma.$disconnect();
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

main().catch(async (err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  logger.error({ err: message }, "Worker failed to start");
  stopKeepalive();
  await prisma.$disconnect();
  process.exit(1);
});
