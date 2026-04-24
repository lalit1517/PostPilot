/*
 * Single-connection Prisma client.
 *
 * WHY THIS SHAPE:
 *   This project serves ~3 generations/day with no real concurrency. A real
 *   connection pool (size >1) was the source of weeks of P1001 / P2024 storms
 *   on Supabase Supavisor (port 6543): zombie sockets, middleware $disconnect
 *   nuking in-flight queries, keepalive competing with real traffic.
 *
 *   With DATABASE_URL connection_limit=1 + pool_timeout=60, Prisma serializes
 *   all queries onto one socket. Supavisor may drop the socket after ~5 min
 *   idle; the next real query auto-reconnects in ~1s (Prisma engine handles
 *   it). No keepalive, no health-check pings — nothing to compete with real
 *   work for the single slot.
 *
 *   Middleware retries ONCE on transient connect errors. It does NOT call
 *   $disconnect()/$connect() — on a 1-slot pool that tears down the only
 *   connection and any concurrent caller times out with P2024. The Prisma
 *   engine reconnects on the next next(params) call on its own.
 *
 *   P2024 is intentionally NOT in the retry set: on a 1-slot pool it means
 *   "caller queued and legitimately waited too long," which retry won't fix.
 */
import 'dotenv/config';
import { Prisma, PrismaClient } from '@prisma/client';
import { logger } from './logger.js';

/*
 * REQUIRED DATABASE_URL PARAMS (set in .env):
 *
 *   connection_limit=1           One socket. Serializes queries; eliminates
 *                                pool-state bugs for this workload.
 *   pool_timeout=60              Max queue wait per query. 60s is safely
 *                                above Promise.all(9) fan-out worst case.
 *   connect_timeout=15           Boot-time Supavisor cold-start guard.
 *   tcp_keepalives_idle=60       OS-level TCP keepalive every 60s.
 *   tcp_keepalives_interval=10   Probe retry every 10s.
 *   tcp_keepalives_count=5       5 failed probes = dead socket.
 *
 *   DIRECT_URL on port 5432 username MUST be `postgres.PROJECT_REF`
 *   (Supavisor format), not bare `postgres`.
 */

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
