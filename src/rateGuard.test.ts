import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({
  prisma: {
    llmCallLog: {
      count: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
    $transaction: vi.fn(async (ops: any[]) => Promise.all(ops)),
  }
}));

import { canCallLLM, recordLLMCall } from './rateGuard.js';
import { prisma } from './db.js';

beforeEach(() => vi.clearAllMocks());

describe('canCallLLM', () => {
  it('allows call when under both limits', async () => {
    (prisma.llmCallLog.count as any)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(10);
    const result = await canCallLLM();
    expect(result.allowed).toBe(true);
  });

  it('blocks when RPM >= 5', async () => {
    (prisma.llmCallLog.count as any)
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(10);
    const result = await canCallLLM();
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('RPM');
  });

  it('blocks when RPD >= 19', async () => {
    (prisma.llmCallLog.count as any)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(19);
    const result = await canCallLLM();
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('RPD');
  });
});
