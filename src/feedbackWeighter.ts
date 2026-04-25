// Reweights feedback by nearby tweet outcomes (±3d), recency decay, and sentiment multiplier.
// One outcome findMany + $transaction batch update; mutex guards concurrent runs.
import { prisma } from './db.js';
import { logger } from './logger.js';
import { classifyFeedback, sentimentWeight } from './feedbackSentiment.js';

let isReweighting = false;

const THREE_DAYS_MS = 3 * 24 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const MAX_FEEDBACKS = 100;

interface FeedbackUpdate {
  id: string;
  weightedScore: number;
}

export async function reweightFeedback(): Promise<void> {
  if (isReweighting) {
    logger.info('reweightFeedback skipped: already running');
    return;
  }
  isReweighting = true;

  try {
    let feedbacks = await prisma.feedback.findMany({
      select: { id: true, created_at: true, feedback_text: true },
      orderBy: { created_at: 'asc' },
    });

    if (feedbacks.length === 0) {
      logger.info('No feedback rows to reweight');
      return;
    }

    if (feedbacks.length > MAX_FEEDBACKS) {
      logger.warn({ total: feedbacks.length }, 'Feedback table large; capping reweight to 100 most recent');
      feedbacks = feedbacks.slice(-MAX_FEEDBACKS);
    }

    // ONE query for all outcomes in the expanded range.
    const first = feedbacks[0];
    const last = feedbacks[feedbacks.length - 1];
    if (!first || !last) return;
    const rangeStart = new Date(first.created_at.getTime() - THREE_DAYS_MS);
    const rangeEnd = new Date(last.created_at.getTime() + THREE_DAYS_MS);

    const allOutcomes = await prisma.tweetOutcome.findMany({
      where: {
        tweet: {
          created_at: { gte: rangeStart, lte: rangeEnd },
        },
      },
      select: {
        outcome_score: true,
        tweet: { select: { created_at: true } },
      },
    });

    const updates: FeedbackUpdate[] = [];

    for (const fb of feedbacks) {
      const windowStart = fb.created_at.getTime() - THREE_DAYS_MS;
      const windowEnd = fb.created_at.getTime() + THREE_DAYS_MS;

      const nearbyOutcomes = allOutcomes.filter((o) => {
        const t = o.tweet.created_at.getTime();
        return t >= windowStart && t <= windowEnd;
      });

      if (nearbyOutcomes.length === 0) continue;

      const avgOutcomeScore =
        nearbyOutcomes.reduce((sum, o) => sum + o.outcome_score, 0) / nearbyOutcomes.length;

      const daysSinceFeedback = (Date.now() - fb.created_at.getTime()) / DAY_MS;
      const recencyWeight = 1 / (1 + daysSinceFeedback);

      const { sentiment } = classifyFeedback(fb.feedback_text);
      const sentimentMultiplier = sentimentWeight(sentiment);

      const weightedScore = recencyWeight * sentimentMultiplier * avgOutcomeScore;
      updates.push({ id: fb.id, weightedScore });
    }

    if (updates.length > 0) {
      await prisma.$transaction(
        updates.map((u) =>
          prisma.feedback.update({
            where: { id: u.id },
            data: { weighted_score: u.weightedScore },
          })
        )
      );
    }

    logger.info({ updated: updates.length, total: feedbacks.length }, 'Feedback reweighting complete');
  } finally {
    isReweighting = false;
  }
}
