import { prisma } from './db.js';
import { logger } from './logger.js';

const SIMILARITY_THRESHOLD = 0.85;
const RECENT_DRAFT_COUNT = 10;

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function trigrams(text: string): Set<string> {
  const normalized = normalize(text);
  const grams = new Set<string>();
  if (normalized.length < 3) {
    if (normalized.length > 0) grams.add(normalized);
    return grams;
  }
  for (let i = 0; i <= normalized.length - 3; i++) {
    grams.add(normalized.slice(i, i + 3));
  }
  return grams;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const g of a) {
    if (b.has(g)) inter++;
  }
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export interface DiversityResult {
  duplicate: boolean;
  maxSimilarity: number;
  matchedTweetId: string | null;
}

/**
 * Checks whether `draft` is too similar (>= 0.85) to any of the last N drafts.
 * Returns duplicate=true if a near-duplicate exists. No LLM calls.
 */
export async function checkDraftDiversity(draft: string, excludeTweetId?: string): Promise<DiversityResult> {
  try {
    const where = excludeTweetId ? { tweet_id: { not: excludeTweetId } } : {};
    const recent = await prisma.tweetVersion.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: RECENT_DRAFT_COUNT,
      select: { content: true, tweet_id: true }
    });

    if (recent.length === 0) {
      return { duplicate: false, maxSimilarity: 0, matchedTweetId: null };
    }

    const target = trigrams(draft);
    let maxSim = 0;
    let matchedTweetId: string | null = null;

    for (const row of recent) {
      const sim = jaccard(target, trigrams(row.content));
      if (sim > maxSim) {
        maxSim = sim;
        matchedTweetId = row.tweet_id;
      }
    }

    return {
      duplicate: maxSim >= SIMILARITY_THRESHOLD,
      maxSimilarity: maxSim,
      matchedTweetId
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message }, 'Draft diversity check failed; allowing draft');
    return { duplicate: false, maxSimilarity: 0, matchedTweetId: null };
  }
}
