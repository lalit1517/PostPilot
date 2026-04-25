// Regex/keyword feedback sentiment classifier. Zero LLM cost.
// Multipliers consumed by feedbackWeighter (positive 1.2, negative 1.3, stylistic 1.0, neutral 0.8).
export type FeedbackSentiment = 'positive' | 'negative' | 'stylistic' | 'neutral';

interface SentimentResult {
  sentiment: FeedbackSentiment;
  confidence: number;
  matched_terms: string[];
}

const POSITIVE_TERMS = [
  'great', 'good', 'love', 'loved', 'perfect', 'excellent', 'awesome',
  'nice', 'well done', 'keep it up', 'more of this', 'solid', 'brilliant',
  'amazing', 'fire', 'banger', 'spot on',
];

const NEGATIVE_TERMS = [
  'bad', 'terrible', 'awful', 'hate', 'boring', 'weak', 'flat',
  'stop', 'avoid', 'never', 'dont', "don't", 'wrong', 'off',
  'lame', 'cringe', 'garbage', 'trash', 'miss',
];

const STYLISTIC_TERMS = [
  'tone', 'style', 'shorter', 'longer', 'concise', 'verbose', 'formal',
  'casual', 'punchy', 'softer', 'harder', 'voice', 'cadence', 'rhythm',
  'format', 'structure', 'less', 'more', 'reduce', 'add', 'emoji',
  'hashtag', 'punctuation',
];

function countMatches(text: string, terms: string[]): string[] {
  const matched: string[] = [];
  for (const term of terms) {
    const pattern = new RegExp(`\\b${term.replace(/'/g, "['’]")}\\b`, 'i');
    if (pattern.test(text)) matched.push(term);
  }
  return matched;
}

export function classifyFeedback(rawText: string): SentimentResult {
  const text = (rawText || '').trim();
  if (!text) return { sentiment: 'neutral', confidence: 0, matched_terms: [] };

  const positive = countMatches(text, POSITIVE_TERMS);
  const negative = countMatches(text, NEGATIVE_TERMS);
  const stylistic = countMatches(text, STYLISTIC_TERMS);

  const scores: Array<{ kind: FeedbackSentiment; hits: number; terms: string[] }> = [
    { kind: 'negative', hits: negative.length, terms: negative },
    { kind: 'positive', hits: positive.length, terms: positive },
    { kind: 'stylistic', hits: stylistic.length, terms: stylistic },
  ];

  scores.sort((a, b) => b.hits - a.hits);
  const top = scores[0];

  if (!top || top.hits === 0) {
    return { sentiment: 'neutral', confidence: 0, matched_terms: [] };
  }

  const total = positive.length + negative.length + stylistic.length;
  const confidence = Number((top.hits / total).toFixed(2));

  return { sentiment: top.kind, confidence, matched_terms: top.terms };
}

export function sentimentWeight(sentiment: FeedbackSentiment): number {
  switch (sentiment) {
    case 'positive': return 1.2;
    case 'negative': return 1.3;
    case 'stylistic': return 1.0;
    case 'neutral': return 0.8;
  }
}
