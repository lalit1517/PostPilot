/*
 * CHANGES (DB stability fixes v3 — pool exhaustion guard):
 * - Activity-aware keepalive: skips ping if a real query already succeeded
 *   within the keepalive interval. Prevents keepalive from competing for pool
 *   slots during active periods and from firing storms when Render CPU throttle
 *   resumes after idle.
 * - P2024 (pool timeout) now treated as reconnectable — middleware
 *   $disconnect + $connect to flush zombie sockets before retrying.
 * - Middleware retries reduced to 1 (was 2). During a real pool storm, more
 *   retries just grab more zombie slots. Fail fast, let upstream fallbacks or
 *   caller handle it.
 * - Keepalive runs on its own path that tolerates pool-timeout errors quietly —
 *   they're expected during CPU throttle wake-up.
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

const RECONNECT_ERROR_CODES = new Set([
  'P1001', // Can't reach database
  'P1002', // DB timed out
  'P1008', // Operations timed out
  'P1017', // Server closed connection
  'P2024', // Pool timeout — zombie connections occupying slots
]);
const MAX_RETRY_ATTEMPTS = 1;
const RETRY_DELAYS_MS = [1500];

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
    if (err.message?.includes('Timed out fetching a new connection')) return true;
    if (err.message?.includes('ECONNREFUSED')) return true;
    if (err.message?.includes('ETIMEDOUT')) return true;
  }
  return false;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Track last successful query timestamp. Used by keepalive to skip pings when
// real traffic is already keeping the pool warm.
let lastQuerySuccessAt = Date.now();

prisma.$use(async (params, next) => {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    try {
      const result = await next(params);
      lastQuerySuccessAt = Date.now();
      return result;
    } catch (err: unknown) {
      lastErr = err;
      if (!isReconnectableError(err) || attempt === MAX_RETRY_ATTEMPTS) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      const delay = RETRY_DELAYS_MS[attempt] ?? 1500;
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
const KEEPALIVE_SKIP_THRESHOLD_MS = 60_000;
let keepaliveTimer: NodeJS.Timeout | null = null;

async function runKeepalivePing(): Promise<void> {
  // Skip if real traffic already warmed the pool recently.
  if (Date.now() - lastQuerySuccessAt < KEEPALIVE_SKIP_THRESHOLD_MS) {
    return;
  }
  try {
    await prisma.$queryRaw`SELECT 1`;
    // $use middleware already updated lastQuerySuccessAt on success.
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // Pool exhaustion and post-throttle connect errors are expected on Render
    // free tier during wake-up — log at debug-ish warn, don't alarm.
    if (
      message.includes('Timed out fetching a new connection') ||
      message.includes("Can't reach database")
    ) {
      logger.warn({ err: message }, 'DB keepalive ping failed (expected during cold wake-up)');
      return;
    }
    logger.warn({ err: message }, 'DB keepalive ping failed');
  }
}

if (process.env.NODE_ENV !== 'test') {
  keepaliveTimer = setInterval(() => {
    void runKeepalivePing();
  }, KEEPALIVE_INTERVAL_MS);
  // Intentionally NOT unref() — keepalive must actively run during idle to
  // keep pool warm on Render free tier.
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
