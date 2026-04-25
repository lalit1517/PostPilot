// Pure-string topic-content coherence check. Zero LLM cost.
// Passes on keyword overlap OR on-domain pivot (>=2 domain keywords in draft).

import { OWNER_PROFILE } from './config/ownerProfile.js';

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'of', 'to', 'in', 'on', 'at',
  'for', 'with', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'this', 'that', 'these', 'those', 'it', 'its', "it's", 'from', 'by',
  'you', 'your', 'we', 'our', 'i', 'my', 'me', 'they', 'them', 'their',
  'not', 'no', 'do', 'does', 'did', 'will', 'would', 'can', 'could',
  'should', 'has', 'have', 'had', 'just', 'about', 'into', 'over', 'up',
  'out', 'so', 'than', 'then', 'also', 'more', 'most', 'some', 'any',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

export interface CoherenceResult {
  coherent: boolean;
  reason: string;
  topicKeywords: string[];
  overlappingKeywords: string[];
  domainMatches: string[];
}

/**
 * Returns coherent=true when:
 *  1. topic is empty (topic-free mode), or
 *  2. draft shares at least one keyword (>3 chars, non-stopword) with topic, or
 *  3. draft has >=2 domain keywords — it's on-domain, even if the specific
 *     topic keyword was paraphrased.
 */
export function checkTopicCoherence(draft: string, topic: string | null | undefined): CoherenceResult {
  const topicStr = (topic ?? '').trim();
  if (!topicStr) {
    return {
      coherent: true,
      reason: 'topic_free_mode',
      topicKeywords: [],
      overlappingKeywords: [],
      domainMatches: [],
    };
  }

  const draftTokens = new Set(tokenize(draft));
  const topicTokens = tokenize(topicStr);
  const topicKeywords = Array.from(new Set(topicTokens));

  const overlapping = topicKeywords.filter((k) => draftTokens.has(k));

  if (overlapping.length > 0) {
    return {
      coherent: true,
      reason: 'direct_keyword_overlap',
      topicKeywords,
      overlappingKeywords: overlapping,
      domainMatches: [],
    };
  }

  const domainKw = OWNER_PROFILE.domainKeywords;
  const domainMatches: string[] = [];
  const draftLower = draft.toLowerCase();
  for (const kw of domainKw) {
    if (!kw) continue;
    const needle = kw.toLowerCase();
    if (needle.length < 3) continue;
    if (draftLower.includes(needle)) domainMatches.push(needle);
    if (domainMatches.length >= 3) break;
  }

  if (domainMatches.length >= 2) {
    return {
      coherent: true,
      reason: 'on_domain_pivot',
      topicKeywords,
      overlappingKeywords: [],
      domainMatches,
    };
  }

  return {
    coherent: false,
    reason: 'no_topic_or_domain_match',
    topicKeywords,
    overlappingKeywords: [],
    domainMatches,
  };
}
