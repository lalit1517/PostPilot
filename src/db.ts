// Single-connection Prisma client (connection_limit=1). Middleware retries once on transient
// connect errors without $disconnect — engine reconnects on next() call.
import 'dotenv/config';
import { Prisma, PrismaClient } from '@prisma/client';
import { logger } from './logger.js';

export const prisma = new PrismaClient({
  log: [
    { level: 'error', emit: 'event' },
    { level: 'warn', emit: 'event' },
  ],
});

prisma.$on('error', (e: Prisma.LogEvent) => {
  // Keep this as a diagnostic signal if it ever shows up — but with
  // connection_limit=1 + pool_timeout=60 it should be extremely rare.
  if (e.message?.includes('connection pool')) {
    logger.warn({ msg: e.message }, 'Prisma connection-pool event');
  }
});

const RECONNECT_ERROR_CODES = new Set([
  'P1001', // Can't reach database (stale socket, Supavisor dropped us)
  'P1002', // DB timed out
  'P1008', // Operations timed out
  'P1017', // Server closed connection
]);

function isReconnectableError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError && RECONNECT_ERROR_CODES.has(err.code)) {
    return true;
  }
  if (err instanceof Prisma.PrismaClientInitializationError) {
    if (err.errorCode && RECONNECT_ERROR_CODES.has(err.errorCode)) return true;
    if (err.message?.includes("Can't reach database")) return true;
  }
  if (err instanceof Error) {
    if (err.message?.includes("Can't reach database")) return true;
    if (err.message?.includes('Server has closed the connection')) return true;
    if (err.message?.includes('ECONNREFUSED')) return true;
    if (err.message?.includes('ETIMEDOUT')) return true;
  }
  return false;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const RETRY_DELAY_MS = 1500;

prisma.$use(async (params, next) => {
  try {
    return await next(params);
  } catch (err: unknown) {
    if (!isReconnectableError(err)) throw err;
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      { model: params.model, action: params.action, delayMs: RETRY_DELAY_MS, err: message },
      'DB transient error; retrying query once'
    );
    await sleep(RETRY_DELAY_MS);
    // No $disconnect/$connect — on a 1-slot pool that nukes the only
    // connection. The engine reconnects transparently on this next() call.
    return await next(params);
  }
});

/**
 * Warm-up probe callers can run before a burst of parallel queries (like
 * contextLoader's Promise.all). Runs a single SELECT 1; if it fails, one
 * retry — same pattern as the middleware. Ensures the cold socket is live
 * before fan-out so the first real query doesn't eat the reconnect penalty.
 */
export async function ensureDbReady(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message }, 'ensureDbReady: initial probe failed, retrying once');
    await sleep(RETRY_DELAY_MS);
    try {
      await prisma.$queryRaw`SELECT 1`;
      return true;
    } catch (retryErr: unknown) {
      const rm = retryErr instanceof Error ? retryErr.message : String(retryErr);
      logger.error({ err: rm }, 'ensureDbReady: DB unreachable after retry');
      return false;
    }
  }
}
