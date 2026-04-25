// 72h outcome scorer. Log-scaled min-max of (likes + retweets×3 + replies×5) over 30d window.
// Log scaling kills outlier tyranny — one viral tweet at 1000 likes no longer crushes
// every other tweet's score to near-zero. Replies weighted highest (hardest engagement to earn).
// Tiers: top 20% high, bottom 30% low, else medium.
// Persists topic + time_of_day + day_of_week.
import { prisma } from './db.js';
import { logger } from './logger.js';

function rawEngagement(likes: number, retweets: number, replies: number): number {
  return Math.log1p(likes + retweets * 3 + replies * 5);
}

export async function computeOutcomeScore(tweetId: string): Promise<void> {
  const engagements = await prisma.engagement.findMany({
    where: { tweet_id: tweetId },
    orderBy: { fetched_at: 'asc' },
  });

  if (engagements.length === 0) {
    logger.warn({ tweetId }, 'No engagements found, skipping outcome scoring');
    return;
  }

  const peakLikes = Math.max(...engagements.map((e) => e.likes));
  const peakRetweets = Math.max(...engagements.map((e) => e.retweets));
  const peakReplies = Math.max(...engagements.map((e) => e.replies));
  const raw = rawEngagement(peakLikes, peakRetweets, peakReplies);

  // Fetch last 30 days of outcomes for min-max normalization
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60_000);
  const recentOutcomes = await prisma.tweetOutcome.findMany({
    where: { computed_at: { gte: thirtyDaysAgo } },
    select: { outcome_score: true },
  });

  // For first tweet or single tweet, score = 50 (midpoint)
  let outcomeScore: number;
  if (recentOutcomes.length === 0) {
    outcomeScore = 50;
  } else {
    // Recompute log-scaled raws from historical peaks for fair comparison
    const allRaws = await prisma.tweetOutcome.findMany({
      where: { computed_at: { gte: thirtyDaysAgo } },
      select: { peak_likes: true, peak_retweets: true, peak_replies: true },
    });

    const rawScores = allRaws.map((o) => rawEngagement(o.peak_likes, o.peak_retweets, o.peak_replies));
    rawScores.push(raw);

    const minRaw = Math.min(...rawScores);
    const maxRaw = Math.max(...rawScores);

    outcomeScore = maxRaw === minRaw ? 50 : ((raw - minRaw) / (maxRaw - minRaw)) * 100;
  }

  // Determine tier based on percentile rank among recent outcomes
  const allScores = recentOutcomes
    .map((o) => o.outcome_score)
    .concat(outcomeScore)
    .sort((a, b) => a - b);

  const rank = allScores.indexOf(outcomeScore);
  const percentile = allScores.length === 1 ? 0.5 : rank / (allScores.length - 1);

  let tier: string;
  if (percentile >= 0.8) {
    tier = 'high';
  } else if (percentile <= 0.3) {
    tier = 'low';
  } else {
    tier = 'medium';
  }

  // Copy quality_score from the most recent TweetVersion
  const latestVersion = await prisma.tweetVersion.findFirst({
    where: { tweet_id: tweetId },
    orderBy: { version: 'desc' },
    select: { quality_score: true },
  });

  const tweet = await prisma.tweet.findUnique({
    where: { id: tweetId },
    select: { original_topic: true, edited_topic: true, time_of_day: true, posted_at: true, created_at: true },
  });
  const topic = tweet?.edited_topic || tweet?.original_topic || null;
  const timeOfDay = tweet?.time_of_day || null;
  const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const refDate = tweet?.posted_at ?? tweet?.created_at ?? null;
  const dayOfWeek = refDate ? DAY_NAMES[refDate.getUTCDay()] ?? null : null;

  await prisma.tweetOutcome.upsert({
    where: { tweet_id: tweetId },
    create: {
      tweet_id: tweetId,
      outcome_score: outcomeScore,
      tier,
      peak_likes: peakLikes,
      peak_retweets: peakRetweets,
      peak_replies: peakReplies,
      quality_score: latestVersion?.quality_score ?? null,
      topic,
      time_of_day: timeOfDay,
      day_of_week: dayOfWeek,
      computed_at: new Date(),
    },
    update: {
      outcome_score: outcomeScore,
      tier,
      peak_likes: peakLikes,
      peak_retweets: peakRetweets,
      peak_replies: peakReplies,
      quality_score: latestVersion?.quality_score ?? null,
      topic,
      time_of_day: timeOfDay,
      day_of_week: dayOfWeek,
      computed_at: new Date(),
    },
  });

  logger.info(
    { tweetId, outcomeScore: outcomeScore.toFixed(1), tier, peakLikes, peakRetweets, peakReplies },
    'Outcome score computed',
  );
}
