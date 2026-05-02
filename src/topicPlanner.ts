import { OWNER_PROFILE } from './config/ownerProfile.js';
import { classifyTrend, classifyTrends, type TopicLane, type TrendCategory } from './trendRelevance.js';

export type TopicSource =
  | 'user_supplied'
  | 'trend'
  | 'evergreen_tech'
  | 'personal'
  | 'culture'
  | 'profile_fallback';

export interface TopicPlan {
  topic: string;
  lane: TopicLane;
  source: TopicSource;
  topicAngle: string;
  needsNewsContext: boolean;
  reason: string;
  trendHints: string[];
  acceptedTrendCount: number;
  rejectedTrendCount: number;
  recentLaneCounts: Record<TopicLane, number>;
}

export interface PlanTopicInput {
  requestedTopic: string;
  trendingTopics: string[];
  recentTopics: string[];
  topicBlacklist: string[];
}

interface TopicCandidate {
  topic: string;
  lane: TopicLane;
  source: TopicSource;
  topicAngle: string;
  needsNewsContext: boolean;
  reason: string;
  trendCategory?: TrendCategory;
}

const TOPIC_MIX_WINDOW = 20;

function normalizeTopic(topic: string): string {
  return topic.trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[#@]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactText(s: string): string {
  return normalizeText(s).replace(/[^a-z0-9]+/g, '');
}

function matchesPhrase(text: string, phrase: string): boolean {
  const normalizedText = normalizeText(text);
  const normalizedPhrase = normalizeText(phrase);
  if (!normalizedPhrase || normalizedPhrase.length < 3) return false;
  if (normalizedText.includes(normalizedPhrase)) return true;

  const compactPhrase = compactText(phrase);
  return compactPhrase.length >= 4 && compactText(text).includes(compactPhrase);
}

function exactTopicSet(topics: readonly string[]): Set<string> {
  return new Set(topics.map(normalizeTopic).filter(Boolean));
}

function isBlockedTopic(topic: string, recentSet: Set<string>, blacklistSet: Set<string>): boolean {
  const normalized = normalizeTopic(topic);
  return recentSet.has(normalized) || blacklistSet.has(normalized);
}

function containsCultureInterest(topic: string): boolean {
  const interests = OWNER_PROFILE.cultureInterests;
  return (Object.values(interests) as string[][]).some((values) =>
    values.some((value: string) => matchesPhrase(topic, value)),
  );
}

function containsPersonalTopic(topic: string): boolean {
  return OWNER_PROFILE.personalTopics.some((value) => matchesPhrase(topic, value)) ||
    OWNER_PROFILE.cultureTopics.some((value) => matchesPhrase(topic, value));
}

export function inferTopicLane(topic: string): TopicLane {
  if (containsCultureInterest(topic) || containsPersonalTopic(topic)) return 'culture';

  const trendClassification = classifyTrend(topic);
  if (trendClassification.allowed && trendClassification.lane) return trendClassification.lane;

  return 'tech';
}

function countRecentLanes(recentTopics: readonly string[]): Record<TopicLane, number> {
  const counts: Record<TopicLane, number> = { tech: 0, culture: 0 };
  for (const topic of recentTopics.slice(0, TOPIC_MIX_WINDOW)) {
    const normalized = normalizeTopic(topic);
    if (!normalized || normalized === 'ai generating...' || normalized === 'ai generated') continue;
    counts[inferTopicLane(topic)] += 1;
  }
  return counts;
}

function chooseLane(
  counts: Record<TopicLane, number>,
  recentCount: number,
  candidates: readonly TopicCandidate[],
): TopicLane {
  const hasTech = candidates.some((candidate) => candidate.lane === 'tech');
  const hasCulture = candidates.some((candidate) => candidate.lane === 'culture');
  if (!hasCulture) return 'tech';
  if (!hasTech) return 'culture';

  const mix = OWNER_PROFILE.topicMix;
  const totalWeight = mix.tech + mix.culture;
  const nextTotal = Math.min(TOPIC_MIX_WINDOW, Math.max(1, recentCount + 1));
  const expectedTech = Math.round((nextTotal * mix.tech) / totalWeight);
  const expectedCulture = nextTotal - expectedTech;
  const techDeficit = expectedTech - counts.tech;
  const cultureDeficit = expectedCulture - counts.culture;

  if (cultureDeficit > techDeficit && cultureDeficit > 0) return 'culture';
  if (techDeficit > 0) return 'tech';

  return Math.random() < mix.culture / totalWeight ? 'culture' : 'tech';
}

function pickCandidate(candidates: readonly TopicCandidate[], lane: TopicLane): TopicCandidate {
  const laneCandidates = candidates.filter((candidate) => candidate.lane === lane);
  const source = laneCandidates.length > 0 ? laneCandidates : candidates;
  const idx = Math.floor(Math.random() * source.length);
  return source[idx] ?? source[0] ?? {
    topic: OWNER_PROFILE.domains[0] ?? 'software engineering',
    lane: 'tech',
    source: 'profile_fallback',
    topicAngle: 'Turn one owner-profile domain into a practical, personal observation.',
    needsNewsContext: false,
    reason: 'fallback_no_candidates',
  };
}

function trendAngle(category: TrendCategory, lane: TopicLane): string {
  if (lane === 'culture') {
    if (category === 'artist' || category === 'music') {
      return 'Use this as a culture/personality hook and connect it to dev life, taste, focus, or late-night shipping. Do not write fandom news or gossip.';
    }
    if (category === 'company' || category === 'product' || category === 'startup' || category === 'person') {
      return 'Use this as tech-culture commentary: product taste, founder behavior, launch energy, or builder/operator humor. Avoid stock-price or gossip framing.';
    }
    return 'Use this as a personal-life hook through the owner voice, with a light technical or builder-adjacent turn.';
  }

  if (category === 'ai') {
    return 'Turn the AI trend into a practical dev/product observation. Prefer grounded, current facts only if search confirms them.';
  }
  if (category === 'startup' || category === 'product' || category === 'company') {
    return 'Turn the product/startup signal into a practical builder observation, not hype.';
  }
  return 'Turn the trend into a concrete dev, AI, SaaS, or backend observation in the owner voice.';
}

function addTopicCandidates(
  candidates: TopicCandidate[],
  topics: readonly string[],
  lane: TopicLane,
  source: TopicSource,
  topicAngle: string,
  needsNewsContext: boolean,
  reason: string,
): void {
  for (const topic of topics) {
    const trimmed = topic.trim();
    if (!trimmed) continue;
    candidates.push({ topic: trimmed, lane, source, topicAngle, needsNewsContext, reason });
  }
}

function addCultureInterestCandidates(candidates: TopicCandidate[]): void {
  const interests = OWNER_PROFILE.cultureInterests;
  const newsLikeFields = new Set(['artists', 'companies', 'people', 'products', 'startups', 'songs']);
  for (const [field, values] of Object.entries(interests)) {
    for (const value of values) {
      const topic = value.trim();
      if (!topic) continue;
      candidates.push({
        topic,
        lane: 'culture',
        source: 'culture',
        topicAngle: newsLikeFields.has(field)
          ? 'Use this named interest as a culture hook through dev/product/personality humor. Ground current claims if search is enabled; avoid gossip.'
          : 'Use this personal interest as a first-person observation through the owner voice.',
        needsNewsContext: newsLikeFields.has(field),
        reason: `owner_profile_culture_interest:${field}`,
      });
    }
  }
}

function buildCandidates(trendingTopics: readonly string[]): {
  candidates: TopicCandidate[];
  trendHints: string[];
  acceptedTrendCount: number;
  rejectedTrendCount: number;
} {
  const candidates: TopicCandidate[] = [];
  const classified = classifyTrends(trendingTopics);

  for (const trend of classified.accepted) {
    if (!trend.lane) continue;
    candidates.push({
      topic: trend.trend,
      lane: trend.lane,
      source: 'trend',
      topicAngle: trendAngle(trend.category, trend.lane),
      needsNewsContext: trend.needsNewsContext,
      reason: `trend:${trend.category}:${trend.reason}`,
      trendCategory: trend.category,
    });
  }

  addTopicCandidates(
    candidates,
    OWNER_PROFILE.evergreenTechTopics,
    'tech',
    'evergreen_tech',
    'Use this evergreen tech/dev topic as a concrete first-person or operator-style observation.',
    false,
    'owner_profile_evergreen_tech',
  );
  addTopicCandidates(
    candidates,
    OWNER_PROFILE.personalTopics,
    'culture',
    'personal',
    'Use this personal topic through humor, daily-life observation, or builder personality. Keep it in the owner voice.',
    false,
    'owner_profile_personal',
  );
  addTopicCandidates(
    candidates,
    OWNER_PROFILE.cultureTopics,
    'culture',
    'culture',
    'Use this culture topic as a profile-approved hook, not as generic entertainment commentary.',
    false,
    'owner_profile_culture_topic',
  );
  addCultureInterestCandidates(candidates);

  return {
    candidates,
    trendHints: classified.accepted.map((trend) => trend.trend).slice(0, 10),
    acceptedTrendCount: classified.accepted.length,
    rejectedTrendCount: classified.rejected.length,
  };
}

export function planTopic(input: PlanTopicInput): TopicPlan {
  const recentSet = exactTopicSet(input.recentTopics);
  const blacklistSet = exactTopicSet(input.topicBlacklist);
  const recentLaneCounts = countRecentLanes(input.recentTopics);
  const requestedTopic = input.requestedTopic.trim();
  const trendData = buildCandidates(input.trendingTopics);

  if (requestedTopic && !isBlockedTopic(requestedTopic, recentSet, blacklistSet)) {
    const classified = classifyTrend(requestedTopic);
    const lane = inferTopicLane(requestedTopic);
    return {
      topic: requestedTopic,
      lane,
      source: 'user_supplied',
      topicAngle: lane === 'culture'
        ? 'User supplied this topic. Keep the draft grounded in the topic while making it sound like the owner.'
        : 'User supplied this topic. Keep the draft grounded in the topic with a practical tech/dev angle.',
      needsNewsContext: classified.needsNewsContext,
      reason: 'explicit_generation_topic',
      trendHints: trendData.trendHints,
      acceptedTrendCount: trendData.acceptedTrendCount,
      rejectedTrendCount: trendData.rejectedTrendCount,
      recentLaneCounts,
    };
  }

  const allCandidates = trendData.candidates;
  const eligible = allCandidates.filter((candidate) => !isBlockedTopic(candidate.topic, recentSet, blacklistSet));
  const candidates = eligible.length > 0 ? eligible : allCandidates;
  const recentCount = Math.min(
    TOPIC_MIX_WINDOW,
    input.recentTopics.filter((topic) => {
      const normalized = normalizeTopic(topic);
      return normalized && normalized !== 'ai generating...' && normalized !== 'ai generated';
    }).length,
  );
  const lane = chooseLane(recentLaneCounts, recentCount, candidates);
  const selected = pickCandidate(candidates, lane);

  return {
    topic: selected.topic,
    lane: selected.lane,
    source: selected.source,
    topicAngle: selected.topicAngle,
    needsNewsContext: selected.needsNewsContext,
    reason: selected.reason,
    trendHints: trendData.trendHints,
    acceptedTrendCount: trendData.acceptedTrendCount,
    rejectedTrendCount: trendData.rejectedTrendCount,
    recentLaneCounts,
  };
}
