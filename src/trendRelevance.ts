// Two-layer trend filter: regex hard-exclusion + domain keyword overlap.
// Replaces the naive substring filter that leaked non-English/non-tech trends.

import { OWNER_PROFILE } from './config/ownerProfile.js';
import { logger } from './logger.js';

const HARD_EXCLUDE_PATTERNS: RegExp[] = [
  /^#?\d+\w?$/,
  /\b(?:election|president|prime minister|senate|parliament|congress|party|vote|voting|campaign)\b/i,
  /\b(?:football|cricket|nba|nfl|mlb|soccer|fifa|ipl|premier league|la liga|serie a|ufc|mma|olympic|olympics|worldcup|world cup)\b/i,
  /\b(?:bollywood|hollywood|kpop|k-pop|bts|taylor swift|beyonce|celebrity|actor|actress|film|movie|boxoffice|box office|oscars|grammy)\b/i,
  /\b(?:stock|nasdaq|nyse|dow jones|s&p 500|crypto|bitcoin|ethereum|altcoin|memecoin|nft)\b/i,
  /\b(?:horoscope|zodiac|astrology)\b/i,
];

function containsNonAscii(s: string): boolean {
  return /[^\x00-\x7F]/.test(s);
}

function inAllowedLanguage(s: string): boolean {
  const langs = OWNER_PROFILE.tweetLanguages;
  if (langs.length === 0) return true;
  if (langs.includes('en')) {
    return !containsNonAscii(s);
  }
  return true;
}

function passesHardExclusion(trend: string): boolean {
  const t = trend.trim();
  if (t.length < 4) return false;
  if (!inAllowedLanguage(t)) return false;
  for (const re of HARD_EXCLUDE_PATTERNS) {
    if (re.test(t)) return false;
  }
  return true;
}

function domainOverlapScore(trend: string): number {
  const lower = trend.toLowerCase();
  let score = 0;
  for (const kw of OWNER_PROFILE.domainKeywords) {
    if (!kw) continue;
    const boundary = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (boundary.test(lower)) score++;
  }
  return score;
}

export interface RelevanceResult {
  relevant: string[];
  excluded: Array<{ trend: string; reason: string }>;
}

export function filterRelevantTrends(trends: readonly string[]): RelevanceResult {
  const relevant: string[] = [];
  const excluded: Array<{ trend: string; reason: string }> = [];
  for (const t of trends) {
    if (!passesHardExclusion(t)) {
      excluded.push({ trend: t, reason: 'hard_exclude' });
      continue;
    }
    const score = domainOverlapScore(t);
    if (score === 0) {
      excluded.push({ trend: t, reason: 'no_domain_overlap' });
      continue;
    }
    relevant.push(t);
  }
  logger.info(
    { kept: relevant.length, excluded: excluded.length, examples: relevant.slice(0, 5) },
    'Trend relevance filter',
  );
  return { relevant, excluded };
}
