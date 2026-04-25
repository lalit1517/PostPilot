// Outcome analytics — engagement pattern, topic leaderboard, quality↔outcome Pearson r.
// Pure DB aggregation, zero LLM cost. Powers /api/admin/* dashboards.
import { prisma } from './db.js';
import { logger } from './logger.js';

interface SlotStats {
  slot: string;
  count: number;
  avg_outcome_score: number;
  avg_peak_likes: number;
  avg_peak_retweets: number;
  high_tier_ratio: number;
}

interface PivotCell {
  time_of_day: string;
  day_of_week: string;
  count: number;
  avg_outcome_score: number;
  high_tier_ratio: number;
}

interface EngagementPattern {
  by_time_of_day: SlotStats[];
  by_day_of_week: SlotStats[];
  by_slot_and_day: PivotCell[];
  total_scored: number;
}

interface Row {
  time_of_day: string | null;
  day_of_week: string | null;
  outcome_score: number;
  peak_likes: number;
  peak_retweets: number;
  tier: string;
}

function aggregate(rows: Row[], key: 'time_of_day' | 'day_of_week'): SlotStats[] {
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const v = r[key];
    if (!v) continue;
    const bucket = groups.get(v) ?? [];
    bucket.push(r);
    groups.set(v, bucket);
  }

  const result: SlotStats[] = [];
  for (const [slot, list] of groups) {
    const count = list.length;
    const avgOutcome = list.reduce((s, r) => s + r.outcome_score, 0) / count;
    const avgLikes = list.reduce((s, r) => s + r.peak_likes, 0) / count;
    const avgRetweets = list.reduce((s, r) => s + r.peak_retweets, 0) / count;
    const highCount = list.filter(r => r.tier === 'high').length;
    result.push({
      slot,
      count,
      avg_outcome_score: Number(avgOutcome.toFixed(2)),
      avg_peak_likes: Number(avgLikes.toFixed(2)),
      avg_peak_retweets: Number(avgRetweets.toFixed(2)),
      high_tier_ratio: Number((highCount / count).toFixed(3))
    });
  }

  result.sort((a, b) => b.avg_outcome_score - a.avg_outcome_score);
  return result;
}

export async function getEngagementPattern(): Promise<EngagementPattern> {
  const rows: Row[] = await prisma.tweetOutcome.findMany({
    select: {
      time_of_day: true,
      day_of_week: true,
      outcome_score: true,
      peak_likes: true,
      peak_retweets: true,
      tier: true
    }
  });

  const byTime = aggregate(rows, 'time_of_day');
  const byDay = aggregate(rows, 'day_of_week');

  const pivot = new Map<string, Row[]>();
  for (const r of rows) {
    if (!r.time_of_day || !r.day_of_week) continue;
    const key = `${r.time_of_day}|${r.day_of_week}`;
    const bucket = pivot.get(key) ?? [];
    bucket.push(r);
    pivot.set(key, bucket);
  }

  const cells: PivotCell[] = [];
  for (const [key, list] of pivot) {
    const [tod, dow] = key.split('|');
    const count = list.length;
    const avgOutcome = list.reduce((s, r) => s + r.outcome_score, 0) / count;
    const highCount = list.filter(r => r.tier === 'high').length;
    cells.push({
      time_of_day: tod ?? '',
      day_of_week: dow ?? '',
      count,
      avg_outcome_score: Number(avgOutcome.toFixed(2)),
      high_tier_ratio: Number((highCount / count).toFixed(3))
    });
  }
  cells.sort((a, b) => b.avg_outcome_score - a.avg_outcome_score);

  return {
    by_time_of_day: byTime,
    by_day_of_week: byDay,
    by_slot_and_day: cells,
    total_scored: rows.length
  };
}

interface TopicStats {
  topic: string;
  count: number;
  avg_outcome_score: number;
  high_tier_count: number;
  top_tweet_id: string | null;
}

export async function getTopicPerformance(limit = 20): Promise<TopicStats[]> {
  const outcomes = await prisma.tweetOutcome.findMany({
    where: { topic: { not: null } },
    select: {
      topic: true,
      outcome_score: true,
      tier: true,
      tweet_id: true
    },
    orderBy: { computed_at: 'desc' }
  });

  const groups = new Map<string, typeof outcomes>();
  for (const o of outcomes) {
    const key = (o.topic as string).toLowerCase().trim();
    const bucket = groups.get(key) ?? [];
    bucket.push(o);
    groups.set(key, bucket);
  }

  const result: TopicStats[] = [];
  for (const [topic, rows] of groups) {
    const count = rows.length;
    const avgOutcome = rows.reduce((s, r) => s + r.outcome_score, 0) / count;
    const highCount = rows.filter(r => r.tier === 'high').length;
    const topRow = rows.slice().sort((a, b) => b.outcome_score - a.outcome_score)[0];

    result.push({
      topic,
      count,
      avg_outcome_score: Number(avgOutcome.toFixed(2)),
      high_tier_count: highCount,
      top_tweet_id: topRow?.tweet_id ?? null
    });
  }

  result.sort((a, b) => b.avg_outcome_score - a.avg_outcome_score);
  return result.slice(0, limit);
}

interface CorrelationResult {
  n: number;
  pearson_r: number | null;
  interpretation: string;
  avg_quality: number | null;
  avg_outcome: number | null;
}

function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 2) return null;

  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;

  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = (xs[i] as number) - meanX;
    const dy = (ys[i] as number) - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }

  const den = Math.sqrt(denX * denY);
  if (den === 0) return null;
  return num / den;
}

export async function getQualityOutcomeCorrelation(): Promise<CorrelationResult> {
  const rows = await prisma.tweetOutcome.findMany({
    where: { quality_score: { not: null } },
    select: { quality_score: true, outcome_score: true }
  });

  const xs: number[] = [];
  const ys: number[] = [];
  for (const r of rows) {
    if (r.quality_score !== null) {
      xs.push(r.quality_score);
      ys.push(r.outcome_score);
    }
  }

  const r = pearson(xs, ys);
  let interpretation = 'insufficient data';
  if (r !== null) {
    const abs = Math.abs(r);
    if (abs < 0.1) interpretation = 'no correlation — LLM quality score does not predict real engagement';
    else if (abs < 0.3) interpretation = 'weak correlation';
    else if (abs < 0.5) interpretation = 'moderate correlation';
    else if (abs < 0.7) interpretation = 'strong correlation';
    else interpretation = 'very strong correlation';
    if (r < 0) interpretation += ' (negative — inverse relationship)';
  }

  const avgQuality = xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  const avgOutcome = ys.length > 0 ? ys.reduce((a, b) => a + b, 0) / ys.length : null;

  logger.info({ n: xs.length, pearson_r: r }, 'Quality-outcome correlation computed');

  return {
    n: xs.length,
    pearson_r: r === null ? null : Number(r.toFixed(4)),
    interpretation,
    avg_quality: avgQuality === null ? null : Number(avgQuality.toFixed(2)),
    avg_outcome: avgOutcome === null ? null : Number(avgOutcome.toFixed(2))
  };
}
