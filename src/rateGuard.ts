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

export async function recordLLMCall(model: string, callType: string): Promise<void> {
  const cutoff = new Date(Date.now() - 48 * 60 * 60_000);
  await prisma.$transaction([
    prisma.llmCallLog.create({ data: { model, call_type: callType } }),
    prisma.llmCallLog.deleteMany({ where: { called_at: { lt: cutoff } } }),
  ]);
  logger.info({ model, callType }, 'LLM call recorded');
}
