/*
 * CHANGES (DB stability fixes):
 * - Keepalive interval (3min `SELECT 1`) prevents Supavisor from killing idle TCP conns.
 * - stopKeepalive() exported for graceful shutdown.
 * - $use middleware catches P1001/P1002/P1008 + "Can't reach database", waits 2s,
 *   calls $connect() once, then re-throws. One auto-reconnect per failed query.
 * - See DATABASE_URL guidance comment below for required URL params.
 */
import 'dotenv/config';
import { Prisma, PrismaClient } from '@prisma/client';
import { logger } from './logger.js';

/*
 * REQUIRED DATABASE_URL PARAMS (set manually in .env, do NOT hardcode):
 *
 *   connect_timeout=15
 *     Avoids boot-time P1001 when Supavisor is slow to respond on cold start.
 *
 *   tcp_keepalives_idle=60
 *     Sends OS-level TCP keepalive packets every 60s. Prevents Supabase from
 *     silently killing the idle connection at the network layer (~5min idle kill).
 *
 *   tcp_keepalives_interval=10
 *   tcp_keepalives_count=5
 *     If a keepalive probe fails, retry every 10s up to 5 times before declaring
 *     the connection dead.
 *
 *   connection_limit=7
 *     NOT 20. Supabase free/pro tier has limited real server connections; a
 *     Prisma pool of 20 can fully saturate the upstream. 7 leaves headroom for
 *     concurrent worker + API server processes.
 *
 *   DIRECT_URL on port 5432 must use username `postgres.PROJECT_REF` (Supavisor
 *   format), not bare `postgres`. Wrong username = P1001 at boot during schema
 *   validation.
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

const RECONNECT_ERROR_CODES = new Set(['P1001', 'P1002', 'P1008']);

function isReconnectableError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError && RECONNECT_ERROR_CODES.has(err.code)) {
    return true;
  }
  if (err instanceof Prisma.PrismaClientInitializationError) {
    if (err.errorCode && RECONNECT_ERROR_CODES.has(err.errorCode)) return true;
    if (err.message?.includes("Can't reach database")) return true;
  }
  if (err instanceof Error && err.message?.includes("Can't reach database")) return true;
  return false;
}

prisma.$use(async (params, next) => {
  try {
    return await next(params);
  } catch (err: unknown) {
    if (!isReconnectableError(err)) throw err;
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ model: params.model, action: params.action, err: message }, 'DB unreachable; retrying once after 2s');
    await new Promise((r) => setTimeout(r, 2000));
    try {
      await prisma.$connect();
    } catch (connectErr: unknown) {
      const cm = connectErr instanceof Error ? connectErr.message : String(connectErr);
      logger.warn({ err: cm }, 'Reconnect attempt failed');
    }
    throw err;
  }
});

const KEEPALIVE_INTERVAL_MS = 3 * 60_000;
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
  if (typeof keepaliveTimer.unref === 'function') keepaliveTimer.unref();
}

export function stopKeepalive(): void {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
}
