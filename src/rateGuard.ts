import { prisma } from './db.js';
import { logger } from './logger.js';

export async function canCallLLM(): Promise<{ allowed: boolean; reason?: string }> {
  const now = new Date();
  const oneMinuteAgo = new Date(now.getTime() - 60_000);
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60_000);

  const [rpmCount, rpdCount] = await Promise.all([
    prisma.llmCallLog.count({ where: { called_at: { gte: oneMinuteAgo } } }),
    prisma.llmCallLog.count({ where: { called_at: { gte: oneDayAgo } } }),
  ]);

  if (rpmCount >= 5) {
    return { allowed: false, reason: `RPM limit reached (${rpmCount}/5)` };
  }
  if (rpdCount >= 19) {
    return { allowed: false, reason: `RPD limit reached (${rpdCount}/19)` };
  }
  return { allowed: true };
}

export interface RateStatus {
  rpm: { used: number; limit: number; remaining: number };
  rpd: { used: number; limit: number; remaining: number };
  window: { minute_start: string; day_start: string };
}

export async function getRateStatus(): Promise<RateStatus> {
  const now = new Date();
  const oneMinuteAgo = new Date(now.getTime() - 60_000);
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60_000);

  const [rpmCount, rpdCount] = await Promise.all([
    prisma.llmCallLog.count({ where: { called_at: { gte: oneMinuteAgo } } }),
    prisma.llmCallLog.count({ where: { called_at: { gte: oneDayAgo } } }),
  ]);

  const RPM_LIMIT = 5;
  const RPD_LIMIT = 19;

  return {
    rpm: { used: rpmCount, limit: RPM_LIMIT, remaining: Math.max(0, RPM_LIMIT - rpmCount) },
    rpd: { used: rpdCount, limit: RPD_LIMIT, remaining: Math.max(0, RPD_LIMIT - rpdCount) },
    window: { minute_start: oneMinuteAgo.toISOString(), day_start: oneDayAgo.toISOString() }
  };
}

export async function recordLLMCall(model: string, callType: string): Promise<void> {
  const cutoff = new Date(Date.now() - 48 * 60 * 60_000);
  await prisma.$transaction([
    prisma.llmCallLog.create({ data: { model, call_type: callType } }),
    prisma.llmCallLog.deleteMany({ where: { called_at: { lt: cutoff } } }),
  ]);
  logger.info({ model, callType }, 'LLM call recorded');
}
