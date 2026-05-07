// LLM rate guard (RPM/RPD). Fails OPEN on DB error — Gemini 429 handles overrun.
// One findMany(24h) + 5s cache + in-memory window counts.
import { prisma } from './db.js';
import { logger } from './logger.js';

const RPM_LIMIT = 5;
const RPD_LIMIT = 19;
const CACHE_TTL_MS = 5_000;

interface LogRow {
  called_at: Date;
}

let cache: { rows: LogRow[]; fetchedAt: number } | null = null;

async function getRecentLogs(): Promise<LogRow[]> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.rows;
  }
  const oneDayAgo = new Date(now - 24 * 60 * 60_000);
  const rows = await prisma.llmCallLog.findMany({
    where: { called_at: { gte: oneDayAgo } },
    select: { called_at: true },
  });
  cache = { rows, fetchedAt: now };
  return rows;
}

function invalidateCache(): void {
  cache = null;
}

function countWindows(rows: LogRow[], now: number): { rpm: number; rpd: number } {
  const oneMinuteAgo = now - 60_000;
  let rpm = 0;
  for (const r of rows) {
    if (r.called_at.getTime() >= oneMinuteAgo) rpm++;
  }
  return { rpm, rpd: rows.length };
}

function nextAvailableFromRows(rows: LogRow[], now: number): { rpmAvailableAt: Date; rpdAvailableAt: Date } {
  const oneMinuteAgo = now - 60_000;
  const oneDayAgo = now - 24 * 60 * 60_000;
  // RPM window frees up when the oldest call in the last minute ages out.
  const rpmRows = rows.filter((r) => r.called_at.getTime() >= oneMinuteAgo);
  const rpmOldest = rpmRows.reduce<number>(
    (min, r) => Math.min(min, r.called_at.getTime()),
    now,
  );
  const rpmAvailableAt = new Date(rpmOldest + 60_000);

  const rpdOldest = rows.reduce<number>(
    (min, r) => (r.called_at.getTime() >= oneDayAgo ? Math.min(min, r.called_at.getTime()) : min),
    now,
  );
  const rpdAvailableAt = new Date(rpdOldest + 24 * 60 * 60_000);
  return { rpmAvailableAt, rpdAvailableAt };
}

export async function canCallLLM(): Promise<{ allowed: boolean; reason?: string; nextAvailableAt?: string }> {
  try {
    const rows = await getRecentLogs();
    const now = Date.now();
    const { rpm, rpd } = countWindows(rows, now);

    if (rpm >= RPM_LIMIT) {
      const { rpmAvailableAt } = nextAvailableFromRows(rows, now);
      return {
        allowed: false,
        reason: `RPM limit reached (${rpm}/${RPM_LIMIT}). Next slot ~${rpmAvailableAt.toISOString()}`,
        nextAvailableAt: rpmAvailableAt.toISOString(),
      };
    }
    if (rpd >= RPD_LIMIT) {
      const { rpdAvailableAt } = nextAvailableFromRows(rows, now);
      return {
        allowed: false,
        reason: `RPD limit reached (${rpd}/${RPD_LIMIT}). Next slot ~${rpdAvailableAt.toISOString()}`,
        nextAvailableAt: rpdAvailableAt.toISOString(),
      };
    }
    return { allowed: true };
  } catch (err: unknown) {
    // Fail OPEN on DB error — a transient P1001 must not block generation.
    // Gemini itself returns 429 if we actually exceed its limits.
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message }, 'canCallLLM: DB unavailable, failing open');
    return { allowed: true };
  }
}

export interface RateStatus {
  rpm: { used: number; limit: number; remaining: number };
  rpd: { used: number; limit: number; remaining: number };
  window: { minute_start: string; day_start: string };
}

export async function getRateStatus(): Promise<RateStatus> {
  const now = Date.now();
  const oneMinuteAgo = new Date(now - 60_000);
  const oneDayAgo = new Date(now - 24 * 60 * 60_000);

  try {
    const rows = await getRecentLogs();
    const { rpm, rpd } = countWindows(rows, now);
    return {
      rpm: { used: rpm, limit: RPM_LIMIT, remaining: Math.max(0, RPM_LIMIT - rpm) },
      rpd: { used: rpd, limit: RPD_LIMIT, remaining: Math.max(0, RPD_LIMIT - rpd) },
      window: { minute_start: oneMinuteAgo.toISOString(), day_start: oneDayAgo.toISOString() },
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message }, 'getRateStatus: DB unavailable, returning zeroed status');
    return {
      rpm: { used: 0, limit: RPM_LIMIT, remaining: RPM_LIMIT },
      rpd: { used: 0, limit: RPD_LIMIT, remaining: RPD_LIMIT },
      window: { minute_start: oneMinuteAgo.toISOString(), day_start: oneDayAgo.toISOString() },
    };
  }
}

export async function recordLLMCall(model: string, callType: string): Promise<void> {
  const cutoff = new Date(Date.now() - 48 * 60 * 60_000);
  try {
    await prisma.$transaction([
      prisma.llmCallLog.create({ data: { model, call_type: callType } }),
      prisma.llmCallLog.deleteMany({ where: { called_at: { lt: cutoff } } }),
    ]);
    invalidateCache();
    logger.info({ model, callType }, 'LLM call recorded');
  } catch (err: unknown) {
    // Don't throw — a failed log write must not block the LLM call that just succeeded.
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ model, callType, err: message }, 'recordLLMCall: DB write failed (non-fatal)');
  }
}
