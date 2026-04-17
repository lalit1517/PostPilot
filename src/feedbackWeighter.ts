import { prisma } from './db.js';
import { logger } from './logger.js';
import { classifyFeedback, sentimentWeight } from './feedbackSentiment.js';

export async function reweightFeedback(): Promise<void> {
  const feedbacks = await prisma.feedback.findMany({
    select: { id: true, created_at: true, feedback_text: true },
  });

  if (feedbacks.length === 0) {
    logger.info('No feedback rows to reweight');
    return;
  }

  let updated = 0;

  for (const fb of feedbacks) {
    const threeDaysMs = 3 * 24 * 60 * 60_000;
    const windowStart = new Date(fb.created_at.getTime() - threeDaysMs);
    const windowEnd = new Date(fb.created_at.getTime() + threeDaysMs);

    const nearbyOutcomes = await prisma.tweetOutcome.findMany({
      where: {
        tweet: {
          created_at: { gte: windowStart, lte: windowEnd },
        },
      },
      select: { outcome_score: true },
    });

    if (nearbyOutcomes.length === 0) continue;

    const avgOutcomeScore =
      nearbyOutcomes.reduce((sum, o) => sum + o.outcome_score, 0) / nearbyOutcomes.length;

    const daysSinceFeedback =
      (Date.now() - fb.created_at.getTime()) / (24 * 60 * 60_000);
    const recencyWeight = 1 / (1 + daysSinceFeedback);

    const { sentiment } = classifyFeedback(fb.feedback_text);
    const sentimentMultiplier = sentimentWeight(sentiment);

    const weightedScore = recencyWeight * sentimentMultiplier * avgOutcomeScore;

    await prisma.feedback.update({
      where: { id: fb.id },
      data: { weighted_score: weightedScore },
    });

    updated++;
  }

  logger.info({ updated, total: feedbacks.length }, 'Feedback reweighting complete');
}
