/*
 * CHANGES (DB stability fixes v2):
 * - Keepalive runs every 90s (was 3min) and does NOT unref() — we want it to
 *   actively keep pool sockets warm on Render free tier during idle periods.
 * - Middleware now ACTUALLY retries the failed query after reconnect (v1 just
 *   reconnected then re-threw, so the user query still failed).
 * - Up to 2 reconnect+retry attempts per query with 1.5s + 3s waits. After
 *   that, re-throw so fallbacks can handle it.
 * - stopKeepalive() still exported for graceful shutdown.
 * - See DATABASE_URL guidance comment below for required URL params.
 */
import 'dotenv/config';
import { Prisma, PrismaClient } from '@prisma/client';
import { logger } from './logger.js';

/*
 * REQUIRED DATABASE_URL PARAMS (set manually in .env, do NOT hardcode):
 *
 *   connect_timeout=15           Boot-time P1001 guard on Supavisor cold start.
 *   tcp_keepalives_idle=60       OS-level TCP keepalive every 60s.
 *   tcp_keepalives_interval=10   Probe retry every 10s.
 *   tcp_keepalives_count=5       5 failed probes = dead.
 *   connection_limit=7           Supabase free/pro caps upstream conns; 7 is safe.
 *
 *   DIRECT_URL on port 5432 username MUST be `postgres.PROJECT_REF` (Supavisor
 *   format), not bare `postgres`.
 */

export const prisma = new PrismaClient({
  log: [
    { level: 'error', emit: 'event' },
    { level: 'warn', emit: 'event' },
  ],
});

prisma.$on('error', (e: Prisma.LogEvent) => {
  if (e.message?.includes('connection pool')) {
    logger.error('CRITICAL: Prisma connection pool exhausted. Set connection_limit=7 in DATABASE_URL.');
  }
});

const RECONNECT_ERROR_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017']);
const MAX_RETRY_ATTEMPTS = 2;
const RETRY_DELAYS_MS = [1500, 3000];

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

prisma.$use(async (params, next) => {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    try {
      return await next(params);
    } catch (err: unknown) {
      lastErr = err;
      if (!isReconnectableError(err) || attempt === MAX_RETRY_ATTEMPTS) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      const delay = RETRY_DELAYS_MS[attempt] ?? 3000;
      logger.warn(
        { model: params.model, action: params.action, attempt: attempt + 1, delayMs: delay, err: message },
        'DB unreachable; reconnecting and retrying query'
      );
      await sleep(delay);
      try {
        await prisma.$disconnect();
        await prisma.$connect();
      } catch (connectErr: unknown) {
        const cm = connectErr instanceof Error ? connectErr.message : String(connectErr);
        logger.warn({ err: cm }, 'Reconnect attempt failed; will retry query anyway');
      }
    }
  }
  throw lastErr;
});

const KEEPALIVE_INTERVAL_MS = 90_000;
let keepaliveTimer: NodeJS.Timeout | null = null;

if (process.env.NODE_ENV !== 'test') {
  keepaliveTimer = setInterval(() => {
    void (async () => {
      try {
        await prisma.$queryRaw`SELECT 1`;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ err: message }, 'DB keepalive ping failed');
      }
    })();
  }, KEEPALIVE_INTERVAL_MS);
  // Intentionally do NOT unref() — keepalive must run during idle to keep pool warm.
}

export function stopKeepalive(): void {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
}

/**
 * Warm-up check callers can run before a burst of parallel queries (like
 * contextLoader's Promise.all). Runs a single SELECT 1 with retry to ensure
 * the pool has at least one live connection before fan-out.
 */
export async function ensureDbReady(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message }, 'ensureDbReady: initial probe failed, trying reconnect');
    try {
      await prisma.$disconnect();
      await prisma.$connect();
      await prisma.$queryRaw`SELECT 1`;
      return true;
    } catch (retryErr: unknown) {
      const rm = retryErr instanceof Error ? retryErr.message : String(retryErr);
      logger.error({ err: rm }, 'ensureDbReady: DB unreachable after reconnect');
      return false;
    }
  }
}
