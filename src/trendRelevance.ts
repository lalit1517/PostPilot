// Trend classification for topic planning.
//
// Trends24 is a freshness signal, not the source of truth. This module
// classifies each trend, keeps profile-relevant candidates, and rejects
// off-profile noise with a reason that can be logged.

import { OWNER_PROFILE } from './config/ownerProfile.js';
import { logger } from './logger.js';

export type TopicLane = 'tech' | 'culture';

export type TrendCategory =
  | 'ai'
  | 'tech'
  | 'startup'
  | 'company'
  | 'product'
  | 'artist'
  | 'music'
  | 'person'
  | 'hobby'
  | 'politics'
  | 'sports'
  | 'finance'
  | 'crypto'
  | 'horoscope'
  | 'entertainment'
  | 'language'
  | 'unknown';

export interface TrendClassification {
  trend: string;
  category: TrendCategory;
  lane: TopicLane | null;
  allowed: boolean;
  reason: string;
  ownerMatches: string[];
  needsNewsContext: boolean;
}

export interface ClassifiedTrendsResult {
  accepted: TrendClassification[];
  rejected: TrendClassification[];
}

const POLITICS_RE = /\b(?:election|president|prime minister|senate|parliament|congress|party|vote|voting|campaign|minister|government|bjp|conservative|labour|democrat|republican)\b/i;
const SPORTS_RE = /\b(?:football|cricket|nba|nfl|mlb|soccer|fifa|ipl|premier league|la liga|serie a|ufc|mma|olympic|olympics|worldcup|world cup|match|finals?|t20|odi)\b/i;
const FINANCE_RE = /\b(?:stock|stocks|nasdaq|nyse|dow jones|s&p 500|sensex|nifty|earnings|shares?|market cap)\b/i;
const CRYPTO_RE = /\b(?:crypto|bitcoin|ethereum|altcoin|memecoin|nft|web3 token)\b/i;
const HOROSCOPE_RE = /\b(?:horoscope|zodiac|astrology)\b/i;
const GENERIC_ENTERTAINMENT_RE = /\b(?:bollywood|hollywood|kpop|k-pop|celebrity|actor|actress|film|movie|boxoffice|box office|oscars|grammy|trailer|netflix|prime video)\b/i;
const MUSIC_RE = /\b(?:song|songs|album|music|track|tour|concert|single|playlist|rapper|singer|artist)\b/i;
const STARTUP_RE = /\b(?:startup|startups|founder|founders|yc|y combinator|funding|seed round|series a|product hunt|launch)\b/i;
const PRODUCT_RE = /\b(?:product|products|app|apps|tool|tools|platform|beta|release|launched|launch)\b/i;
const AI_RE = /\b(?:ai|llm|gpt|openai|anthropic|claude|gemini|agent|agents|rag|prompt|model|models|embedding|vector)\b/i;

function containsNonAscii(s: string): boolean {
  return /[^\x00-\x7F]/.test(s);
}

function inAllowedLanguage(s: string, hasOwnerMatch: boolean): boolean {
  const langs = OWNER_PROFILE.tweetLanguages;
  if (langs.length === 0) return true;
  if (langs.includes('en')) {
    return !containsNonAscii(s) || hasOwnerMatch;
  }
  return true;
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

  const escaped = normalizedPhrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const boundary = new RegExp(`(?:^|\\b)${escaped}(?:\\b|$)`, 'i');
  if (boundary.test(normalizedText)) return true;

  const compactPhrase = compactText(phrase);
  if (compactPhrase.length < 4) return false;
  return compactText(text).includes(compactPhrase);
}

function matchesAny(text: string, values: readonly string[]): string[] {
  return values.filter((value) => matchesPhrase(text, value));
}

function domainMatches(text: string): string[] {
  const lower = text.toLowerCase();
  const matches: string[] = [];
  for (const kw of OWNER_PROFILE.domainKeywords) {
    if (!kw) continue;
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const boundary = new RegExp(`\\b${escaped}\\b`, 'i');
    if (boundary.test(lower)) matches.push(kw);
  }
  return matches;
}

function ownerInterestMatches(trend: string): Array<{ field: keyof typeof OWNER_PROFILE.cultureInterests; matches: string[] }> {
  const interests = OWNER_PROFILE.cultureInterests;
  return (Object.keys(interests) as Array<keyof typeof interests>)
    .map((field) => ({ field, matches: matchesAny(trend, interests[field]) }))
    .filter((entry) => entry.matches.length > 0);
}

function categoryForOwnerInterest(field: keyof typeof OWNER_PROFILE.cultureInterests): TrendCategory {
  if (field === 'artists') return 'artist';
  if (field === 'songs') return 'music';
  if (field === 'people') return 'person';
  if (field === 'companies') return 'company';
  if (field === 'products') return 'product';
  if (field === 'startups') return 'startup';
  return 'hobby';
}

export function classifyTrend(rawTrend: string): TrendClassification {
  const trend = rawTrend.trim();
  const ownerInterest = ownerInterestMatches(trend);
  const ownerMatches = ownerInterest.flatMap((entry) => entry.matches);
  const hasOwnerMatch = ownerMatches.length > 0;

  if (!trend || trend.length < 4) {
    return { trend, category: 'unknown', lane: null, allowed: false, reason: 'too_short', ownerMatches, needsNewsContext: false };
  }
  if (/^#?\d+\w?$/i.test(trend) || /^\d+[KM]?$/i.test(trend)) {
    return { trend, category: 'unknown', lane: null, allowed: false, reason: 'number_or_metric', ownerMatches, needsNewsContext: false };
  }

  if (POLITICS_RE.test(trend)) {
    return { trend, category: 'politics', lane: null, allowed: false, reason: 'hard_exclude_politics', ownerMatches, needsNewsContext: false };
  }
  if (SPORTS_RE.test(trend)) {
    return { trend, category: 'sports', lane: null, allowed: false, reason: 'hard_exclude_sports', ownerMatches, needsNewsContext: false };
  }
  if (CRYPTO_RE.test(trend)) {
    return { trend, category: 'crypto', lane: null, allowed: false, reason: 'hard_exclude_crypto', ownerMatches, needsNewsContext: false };
  }
  if (FINANCE_RE.test(trend)) {
    return { trend, category: 'finance', lane: null, allowed: false, reason: 'hard_exclude_finance', ownerMatches, needsNewsContext: false };
  }
  if (HOROSCOPE_RE.test(trend)) {
    return { trend, category: 'horoscope', lane: null, allowed: false, reason: 'hard_exclude_horoscope', ownerMatches, needsNewsContext: false };
  }
  if (!inAllowedLanguage(trend, hasOwnerMatch)) {
    return { trend, category: 'language', lane: null, allowed: false, reason: 'language_exclude', ownerMatches, needsNewsContext: false };
  }

  if (hasOwnerMatch) {
    const category = categoryForOwnerInterest(ownerInterest[0]?.field ?? 'hobbies');
    const needsNewsContext = category !== 'hobby';
    return {
      trend,
      category,
      lane: 'culture',
      allowed: true,
      reason: 'owner_culture_allowlist',
      ownerMatches,
      needsNewsContext,
    };
  }

  const domain = domainMatches(trend);
  if (domain.length > 0) {
    const category: TrendCategory = AI_RE.test(trend)
      ? 'ai'
      : STARTUP_RE.test(trend)
        ? 'startup'
        : PRODUCT_RE.test(trend)
          ? 'product'
          : 'tech';
    return {
      trend,
      category,
      lane: 'tech',
      allowed: true,
      reason: 'domain_keyword_match',
      ownerMatches: domain,
      needsNewsContext: true,
    };
  }

  if (GENERIC_ENTERTAINMENT_RE.test(trend) || MUSIC_RE.test(trend)) {
    return {
      trend,
      category: MUSIC_RE.test(trend) ? 'music' : 'entertainment',
      lane: null,
      allowed: false,
      reason: 'entertainment_not_in_profile',
      ownerMatches,
      needsNewsContext: false,
    };
  }

  return {
    trend,
    category: 'unknown',
    lane: null,
    allowed: false,
    reason: 'no_profile_match',
    ownerMatches,
    needsNewsContext: false,
  };
}

export function classifyTrends(trends: readonly string[]): ClassifiedTrendsResult {
  const classified = trends.map(classifyTrend);
  const accepted = classified.filter((trend) => trend.allowed);
  const rejected = classified.filter((trend) => !trend.allowed);

  logger.info(
    {
      accepted: accepted.length,
      rejected: rejected.length,
      acceptedExamples: accepted.slice(0, 5).map((item) => ({
        trend: item.trend,
        lane: item.lane,
        category: item.category,
        reason: item.reason,
      })),
    },
    'Trend classification',
  );

  return { accepted, rejected };
}

export interface RelevanceResult {
  relevant: string[];
  excluded: Array<{ trend: string; reason: string }>;
}

// Backward-compatible wrapper for old callers/docs. New code should use
// classifyTrends() so it can preserve lane/category/grounding metadata.
export function filterRelevantTrends(trends: readonly string[]): RelevanceResult {
  const result = classifyTrends(trends);
  return {
    relevant: result.accepted.map((trend) => trend.trend),
    excluded: result.rejected.map((trend) => ({ trend: trend.trend, reason: trend.reason })),
  };
}
