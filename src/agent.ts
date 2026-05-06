import 'dotenv/config';
import { StateGraph, START, END, Annotation } from "@langchain/langgraph";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { prisma, ensureDbReady } from "./db.js";
import { logger } from "./logger.js";
import { canCallLLM, recordLLMCall } from "./rateGuard.js";
import { getTrendingTopics } from "./trends.js";
import {
  checkDraftDiversity,
  composeFingerprint,
  extractStructuralFingerprint,
  getRecentStructuralFingerprints,
  pushFingerprintToBuffer,
  registerDraftFormat,
} from "./draftDiversity.js";
import { getNextFormatWithMeta } from "./draftFormats.js";
import type { FormatArchetype } from "./draftFormats.js";
import { getTopicPerformance } from "./analytics.js";
import { OWNER_PROFILE } from "./config/ownerProfile.js";
import { planTopic, type TopicPlan } from "./topicPlanner.js";
import {
  recordTopicUsed,
  isTopicOnCooldown,
  getInMemoryBlacklist,
  incrementCoherenceFailure,
  resetCoherenceFailure,
} from "./topicMemory.js";
import { checkTopicCoherence } from "./topicCoherence.js";
import { fitVisibleDraftToLimit, getVisibleDraftCharLimit } from "./postLimits.js";

const AgentState = Annotation.Root({
  tweetId: Annotation<string>({ reducer: (x, y) => y ?? x, default: () => "" }),
  topic: Annotation<string>({ reducer: (x, y) => y ?? x, default: () => "" }),
  timeOfDay: Annotation<string>({ reducer: (x, y) => y ?? x, default: () => "morning" }),
  context: Annotation<string[]>({ reducer: (x, y) => y ?? x, default: () => [] }),
  recentFeedback: Annotation<string[]>({ reducer: (x, y) => y ?? x, default: () => [] }),
  recentTopics: Annotation<string[]>({ reducer: (x, y) => y ?? x, default: () => [] }),
  trendingTopics: Annotation<string[]>({ reducer: (x, y) => y ?? x, default: () => [] }),
  learnedPersona: Annotation<string>({ reducer: (x, y) => y ?? x, default: () => "" }),
  personaParameters: Annotation<string>({ reducer: (x, y) => y ?? x, default: () => "" }),
  draft: Annotation<string>({ reducer: (x, y) => y ?? x, default: () => "" }),
  score: Annotation<number>({ reducer: (x, y) => y ?? x, default: () => 0 }),
  critique: Annotation<string>({ reducer: (x, y) => y ?? x, default: () => "" }),
  critiqueHints: Annotation<string[]>({ reducer: (x, y) => y ?? x, default: () => [] }),
  previousDraft: Annotation<string>({ reducer: (x, y) => y ?? x, default: () => "" }),
  currentFeedback: Annotation<string>({ reducer: (x, y) => y ?? x, default: () => "" }),
  forceTopic: Annotation<boolean>({ reducer: (x, y) => y ?? x, default: () => false }),
  iterationCount: Annotation<number>({ reducer: (x, y) => y ?? x, default: () => 0 }),
  lengthTarget: Annotation<{ min: number; max: number } | null>({ reducer: (x, y) => y ?? x, default: () => null }),
  topicBlacklist: Annotation<string[]>({ reducer: (x, y) => y ?? x, default: () => [] }),
  rerollCount: Annotation<number>({ reducer: (x, y) => y ?? x, default: () => 0 }),
  formatArchetype: Annotation<FormatArchetype | null>({ reducer: (x, y) => y ?? x, default: () => null }),
  recentFingerprints: Annotation<string[]>({ reducer: (x, y) => y ?? x, default: () => [] }),
  topicFree: Annotation<boolean>({ reducer: (x, y) => y ?? x, default: () => false }),
  topicPlan: Annotation<TopicPlan | null>({ reducer: (x, y) => y ?? x, default: () => null }),
  coherent: Annotation<boolean>({ reducer: (x, y) => y ?? x, default: () => true }),
  coherenceReason: Annotation<string>({ reducer: (x, y) => y ?? x, default: () => "" }),
  hardProhibitions: Annotation<string[]>({ reducer: (x, y) => y ?? x, default: () => [] }),
  personaAvoidItems: Annotation<string[]>({ reducer: (x, y) => y ?? x, default: () => [] }),
  structuralRepetitionCount: Annotation<number>({ reducer: (x, y) => y ?? x, default: () => 0 }),
  rejectedFingerprint: Annotation<string>({ reducer: (x, y) => y ?? x, default: () => "" }),
  rejectedDraft: Annotation<string>({ reducer: (x, y) => y ?? x, default: () => "" }),
  rateLimited: Annotation<boolean>({ reducer: (x, y) => y ?? x, default: () => false }),
  validationFailed: Annotation<boolean>({ reducer: (x, y) => y ?? x, default: () => false }),
});

const baseConfig = {
  apiKey: process.env.GOOGLE_API_KEY as string,
  temperature: 0.7,
  maxOutputTokens: 2048,
  topP: 0.9,
  maxRetries: 5,
};

const CALL_TIMEOUT = 120_000;

// Kept for back-compat with any legacy importer. Prefer ./config/ownerProfile.
export { OWNER_PROFILE };

const THINKING_CONFIG = { thinkingConfig: { thinkingBudget: 1024 } } as const;

export const llm = new ChatGoogleGenerativeAI({
  ...baseConfig,
  model: "gemini-2.5-flash",
  ...THINKING_CONFIG,
}).withFallbacks([
  new ChatGoogleGenerativeAI({
    ...baseConfig,
    model: "gemini-3.1-flash-lite-preview",
  }),
  new ChatGoogleGenerativeAI({
    ...baseConfig,
    model: "gemini-3-flash-preview",
  }),
  new ChatGoogleGenerativeAI({
    ...baseConfig,
    model: "gemini-2.5-flash-lite",
  }),
]);

const GOOGLE_SEARCH_RETRIEVAL_TOOLS = [{ googleSearchRetrieval: {} }] as const;

function finalizeDraft(raw: string): string {
  let s = (raw ?? "").trim();
  if (!s) return "";
  if (/[.!?]["')\]]?$/.test(s)) return s;
  const match = s.match(/^(.*[.!?])["')\]]?\s*\S*$/s);
  if (match && match[1]) {
    const trimmed = match[1].trim();
    if (trimmed.length >= 40) return trimmed;
  }
  return s + ".";
}

function stripInvisibleText(value: string): string {
  return (value ?? '').replace(/[\u200B\u200C]+/g, '').trim();
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsRevisionAnchor(draftLower: string, anchor: string): boolean {
  const normalized = anchor.toLowerCase();
  const escaped = escapeForRegex(normalized);
  return new RegExp(`(^|[^A-Za-z0-9_])${escaped}(?=$|[^A-Za-z0-9_])`, 'i').test(draftLower);
}

const GENERIC_REVISION_ANCHORS = new Set([
  'ai',
  'api',
  'db',
  'ui',
  'ux',
  'js',
  'ts',
  'llm',
]);

function fitDraftBeforeScoring(draft: string, visibleDraftLimit: number, stage: string, tweetId: string): string {
  const fitted = fitVisibleDraftToLimit(draft, visibleDraftLimit);
  if (fitted.changed) {
    logger.warn(
      {
        tweetId,
        stage,
        originalVisibleDraftLen: fitted.originalLength,
        fittedVisibleDraftLen: fitted.finalLength,
        visibleDraftLimit,
        fitFunction: "fitVisibleDraftToLimit",
        downstreamValidation: "diversityGate -> qualityScorer -> coherenceGate",
        postFingerprintFunction: "appendFingerprint",
      },
      "Draft exceeded visible budget; fitVisibleDraftToLimit applied before scoring/coherence and before appendFingerprint",
    );
  }

  return fitted.draft;
}

function isKnownOwnerDomainTerm(token: string): boolean {
  const normalized = token.toLowerCase();
  if (GENERIC_REVISION_ANCHORS.has(normalized)) return false;
  return OWNER_PROFILE.domainKeywords.some((kw) => kw.toLowerCase() === normalized);
}

function extractNamedAnchors(text: string): string[] {
  const cleaned = stripInvisibleText(text);
  const anchors = new Map<string, string>();
  const tokenPattern = /\b[A-Za-z][A-Za-z0-9]*(?:[.+#-][A-Za-z0-9]+)*\b/g;
  const matches = cleaned.match(tokenPattern) ?? [];

  for (const token of matches) {
    const normalized = token.toLowerCase();
    if (GENERIC_REVISION_ANCHORS.has(normalized)) continue;
    const hasIdentityShape =
      isKnownOwnerDomainTerm(token) ||
      /[A-Z]/.test(token.slice(1)) ||
      /^[A-Z][a-z]+(?:[A-Z][a-z0-9]+)+/.test(token) ||
      token.includes('.') ||
      token.includes('+') ||
      token.includes('#');
    if (!hasIdentityShape) continue;
    if (!anchors.has(normalized)) anchors.set(normalized, token);
  }

  return Array.from(anchors.values()).slice(0, 6);
}

function feedbackNamedAnchors(feedback: string, previousAnchors: string[]): string[] {
  const previousByLower = new Map(previousAnchors.map((anchor) => [anchor.toLowerCase(), anchor]));
  const anchors = new Map<string, string>();
  const tokens = stripInvisibleText(feedback).match(/\b[A-Za-z][A-Za-z0-9]*(?:[.+#-][A-Za-z0-9]+)*\b/g) ?? [];

  for (const token of tokens) {
    const normalized = token.toLowerCase();
    const previous = previousByLower.get(normalized);
    if (previous) {
      anchors.set(normalized, previous);
      continue;
    }

    const hasIdentityShape =
      isKnownOwnerDomainTerm(token) ||
      /[A-Z]/.test(token.slice(1)) ||
      /^[A-Z][a-z]+(?:[A-Z][a-z0-9]+)+/.test(token) ||
      token.includes('.') ||
      token.includes('+') ||
      token.includes('#');
    if (hasIdentityShape && !GENERIC_REVISION_ANCHORS.has(normalized)) {
      anchors.set(normalized, token);
    }
  }

  return Array.from(anchors.values()).slice(0, 6);
}

function buildRevisionContract(previousDraft: string, currentFeedback: string): string {
  const cleanPreviousDraft = stripInvisibleText(previousDraft);
  const cleanFeedback = stripInvisibleText(currentFeedback);
  if (!cleanPreviousDraft || !cleanFeedback) return '';

  const previousAnchors = extractNamedAnchors(cleanPreviousDraft);
  const explicitFeedbackAnchors = feedbackNamedAnchors(cleanFeedback, previousAnchors);
  const requiredAnchors = explicitFeedbackAnchors.length > 0
    ? explicitFeedbackAnchors
    : previousAnchors.slice(0, 4);

  return `\n\n[REVISION MODE ACTIVATED - HARD CONTRACT]
Previous draft:
"${cleanPreviousDraft}"

User feedback:
"${cleanFeedback}"

Revision rules:
- Treat the previous draft as the source of concrete context.
- Keep the same concrete subject, named tools, and stance target unless the feedback explicitly asks for a new topic.
- Apply the feedback as a hard requirement, not as a loose style hint.
- Rewrite the tweet, but do not pivot to a different example inside the same broad topic bucket.
${requiredAnchors.length > 0 ? `- Required subject anchors to preserve/include: ${requiredAnchors.join(', ')}.` : '- Preserve the previous draft subject even if there are no obvious named tools.'}
- If the feedback says not to attack or talk against a tool/person/company, make the sarcasm point toward hype/misuse/overstatement while still making that tool/person/company sound useful.
---END REVISION CONTRACT---\n`;
}

function checkRevisionCompliance(
  draft: string,
  previousDraft: string,
  currentFeedback: string,
): { compliant: boolean; reason: string; missingAnchors: string[] } {
  const cleanPreviousDraft = stripInvisibleText(previousDraft);
  const cleanFeedback = stripInvisibleText(currentFeedback);
  if (!cleanPreviousDraft || !cleanFeedback) {
    return { compliant: true, reason: 'not_revision_mode', missingAnchors: [] };
  }

  const previousAnchors = extractNamedAnchors(cleanPreviousDraft);
  const explicitFeedbackAnchors = feedbackNamedAnchors(cleanFeedback, previousAnchors);
  const requiredAnchors = explicitFeedbackAnchors.length > 0
    ? explicitFeedbackAnchors
    : previousAnchors.slice(0, 4);

  const draftLower = stripInvisibleText(draft).toLowerCase();
  const missingAnchors = requiredAnchors.filter((anchor) => {
    return !containsRevisionAnchor(draftLower, anchor);
  });

  if (missingAnchors.length > 0) {
    return {
      compliant: false,
      reason: 'missing_revision_subject_anchors',
      missingAnchors,
    };
  }

  const asksNotAgainst = /\b(?:do\s*not|don't|dont|never|avoid)\s+(?:talk\s+)?(?:against|negative|criticize|criticise|attack|bash)\b/i.test(cleanFeedback);
  if (asksNotAgainst) {
    const negativeFraming = /\b(?:useless|pointless|not\s+useful|adds?\s+complexity|complexity,\s*not|overkill|unnecessary|avoid\s+using|don't\s+need|dont\s+need|without\s+.+\s+is\s+better)\b/i.test(draftLower);
    if (negativeFraming) {
      return {
        compliant: false,
        reason: 'violates_do_not_talk_against_feedback',
        missingAnchors: [],
      };
    }
  }

  return { compliant: true, reason: 'revision_feedback_satisfied', missingAnchors: [] };
}

type DraftContextValidation =
  | { ok: true; reason: string; overlap: string[]; domainMatches: string[] }
  | {
      ok: false;
      kind: 'revision';
      reason: string;
      missingAnchors: string[];
    }
  | {
      ok: false;
      kind: 'topic';
      reason: string;
      topicKeywords: string[];
    };

function validateDraftContext(draft: string, state: typeof AgentState.State): DraftContextValidation {
  const revisionResult = checkRevisionCompliance(draft, state.previousDraft, state.currentFeedback);
  if (!revisionResult.compliant) {
    return {
      ok: false,
      kind: 'revision',
      reason: revisionResult.reason,
      missingAnchors: revisionResult.missingAnchors,
    };
  }

  const strictUserTopic = state.forceTopic || state.topicPlan?.source === 'user_supplied';
  const topicResult = checkTopicCoherence(draft, state.topic, {
    allowDomainPivot: !strictUserTopic,
  });
  if (!topicResult.coherent) {
    return {
      ok: false,
      kind: 'topic',
      reason: topicResult.reason,
      topicKeywords: topicResult.topicKeywords,
    };
  }

  return {
    ok: true,
    reason: topicResult.reason,
    overlap: topicResult.overlappingKeywords,
    domainMatches: topicResult.domainMatches,
  };
}

function isSuspiciousDraft(draft: string): string | null {
  const s = (draft ?? "").trim();
  const visibleLimit = getVisibleDraftCharLimit();
  if (!s) return "empty";
  if (s.length < 40) return `too_short(${s.length})`;
  if (s.length > visibleLimit) return `too_long(${s.length}/${visibleLimit})`;
  if (!/[.!?]["')\]]?$/.test(s)) return "no_terminator";
  if (/^(here'?s|here is|draft:|tweet:|topic:)/i.test(s)) return "preamble_leak";
  if (/[*_`#]/.test(s)) return "markdown_artifact";
  return null;
}

function parseScore(raw: string): number {
  const match = (raw ?? "").match(/\d+(\.\d+)?/);
  if (!match) return 7.0;
  const n = parseFloat(match[0]);
  if (!Number.isFinite(n)) return 7.0;
  const clamped = Math.max(1, Math.min(10, n));
  // Round to 1 decimal place (defensive — model may return 8.456)
  return Math.round(clamped * 10) / 10;
}

function parseCritiqueHints(critique: string, draft: string, score: number): string[] {
  const hints: string[] = [];
  const c = (critique ?? "").toLowerCase();
  const d = (draft ?? "").trim();
  const visibleLimit = getVisibleDraftCharLimit();

  if (d.length > visibleLimit) hints.push("too_long");
  if (d.length < 80) hints.push("too_short");

  if (/\b(hook|opener|opening|first line|grab)\b/.test(c)) hints.push("weak_hook");
  if (/\b(vague|generic|bland|unclear|ambiguous|specific)\b/.test(c)) hints.push("vague_claim");
  if (/\b(boring|dull|flat|unengaging|dry|no voice)\b/.test(c)) hints.push("low_energy");
  if (/\b(cliche|cliché|trite|overused|tired|been said)\b/.test(c)) hints.push("cliche");
  if (/\b(jargon|technical|complex|simpler|simplify)\b/.test(c)) hints.push("too_jargon");
  if (/\b(ending|conclusion|closing|final|ends)\b/.test(c)) hints.push("weak_ending");
  if (/\b(structure|flow|awkward|choppy|disjointed)\b/.test(c)) hints.push("poor_flow");
  if (/\b(emotion|feel|personal|relate|human)\b/.test(c)) hints.push("needs_emotion");

  if (/\b(formal|literary|philosophical|eloquent|profound|poetic|metaphor|shakespear|grandiose|flowery|verbose)\b/.test(c)) hints.push("wrong_voice");
  if (/\b(feedback|revision|previous draft|user asked|did not address|ignored request|missed the request)\b/.test(c)) hints.push("feedback_drift");

  if (hints.length === 0 && score < 7) hints.push("low_quality");

  return hints;
}

async function computeLengthTarget(): Promise<{ min: number; max: number } | null> {
  try {
    const highTier = await prisma.tweetOutcome.findMany({
      where: { tier: "high" },
      select: { tweet_id: true },
      orderBy: { computed_at: "desc" },
      take: 20,
    });
    if (highTier.length < 5) return null;

    const tweetIds = highTier.map(o => o.tweet_id);
    const versions = await prisma.tweetVersion.findMany({
      where: { tweet_id: { in: tweetIds } },
      select: { tweet_id: true, content: true, version: true },
      orderBy: { version: "desc" },
    });

    const seen = new Set<string>();
    const lengths: number[] = [];
    for (const v of versions) {
      if (seen.has(v.tweet_id)) continue;
      seen.add(v.tweet_id);
      lengths.push(stripInvisibleText(v.content).length);
    }
    if (lengths.length < 5) return null;

    const avg = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    const variance = lengths.reduce((s, l) => s + (l - avg) ** 2, 0) / lengths.length;
    const stdev = Math.sqrt(variance);
    const visibleLimit = getVisibleDraftCharLimit();
    const min = Math.max(60, Math.min(visibleLimit, Math.floor(avg - stdev)));
    const max = Math.min(visibleLimit, Math.ceil(avg + stdev));
    return { min, max };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "computeLengthTarget failed");
    return null;
  }
}

// Merges DB bottom-20% with in-memory cooldown list. On DB error, falls back to
// in-memory only so recently-used topics still get flagged.
async function computeTopicBlacklist(): Promise<{ list: string[]; source: string }> {
  const memory = getInMemoryBlacklist();
  try {
    const topics = await getTopicPerformance(50);
    if (topics.length < 10) {
      return { list: memory, source: memory.length ? 'memory_only' : 'empty' };
    }
    const bottomSize = Math.max(1, Math.floor(topics.length * 0.2));
    const dbList = topics.slice(-bottomSize).map(t => t.topic.toLowerCase());
    const merged = Array.from(new Set([...dbList, ...memory]));
    return { list: merged, source: 'db+memory' };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "computeTopicBlacklist DB failed; using memory only");
    return { list: memory, source: 'memory_only' };
  }
}

// Extract structured AVOID items from the persona profile text so they can be
// injected as HARD PROHIBITIONS (above persona text) instead of soft advisory
// bullets the model consistently ignores.
function extractAvoidItems(profileText: string): {
  overusedStructures: string[];
  overusedArcs: string[];
  overusedPhrases: string[];
} {
  const result = {
    overusedStructures: [] as string[],
    overusedArcs: [] as string[],
    overusedPhrases: [] as string[],
  };
  if (!profileText) return result;
  const lines = profileText.split(/\r?\n/);
  let inAvoidSection = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^AVOID\s*:/i.test(line)) {
      inAvoidSection = true;
      continue;
    }
    if (/^(TONE|STRUCTURE|STRONG_TOPICS|SIGNATURE_PHRASES)\s*:/i.test(line)) {
      inAvoidSection = false;
      continue;
    }
    if (!inAvoidSection) continue;
    const structMatch = line.match(/OVERUSED_STRUCTURE\s*:\s*(.+)$/i);
    if (structMatch?.[1]) {
      result.overusedStructures.push(structMatch[1].trim().replace(/^[-•]\s*/, ''));
      continue;
    }
    const arcMatch = line.match(/OVERUSED_ARC\s*:\s*(.+)$/i);
    if (arcMatch?.[1]) {
      result.overusedArcs.push(arcMatch[1].trim().replace(/^[-•]\s*/, ''));
      continue;
    }
    const phraseMatch = line.match(/OVERUSED_PHRASE\s*:\s*(.+)$/i);
    if (phraseMatch?.[1]) {
      result.overusedPhrases.push(phraseMatch[1].trim().replace(/^[-•]\s*/, ''));
    }
  }
  return result;
}

async function contextLoader(state: typeof AgentState.State) {
  const start = Date.now();
  logger.info("Running contextLoader...");

  const dbReady = await ensureDbReady();
  if (!dbReady) {
    logger.error("contextLoader: DB not ready after warm-up; aborting generation");
    throw new Error("DB unreachable — aborting generation");
  }

  const trendingTopicsPromise = getTrendingTopics();

  // Slot-aware exemplars: prefer top tweets posted at the same time-of-day slot.
  // Falls back to global top-by-likes when slot has <3 samples (avoids overfitting on tiny n).
  const SLOT_SAMPLE_THRESHOLD = 3;
  const currentSlot = state.timeOfDay;
  const slotOutcomes = await prisma.tweetOutcome.findMany({
    where: { time_of_day: currentSlot },
    orderBy: { outcome_score: 'desc' },
    take: 5,
    include: { tweet: { include: { versions: { orderBy: { version: 'desc' }, take: 1 } } } }
  });

  let topTweetsQuery: Array<{ tweet: { versions: Array<{ content: string }> } }>;
  let exemplarSource: 'slot_filtered' | 'global_fallback';
  if (slotOutcomes.length >= SLOT_SAMPLE_THRESHOLD) {
    topTweetsQuery = slotOutcomes;
    exemplarSource = 'slot_filtered';
  } else {
    topTweetsQuery = await prisma.engagement.findMany({
      orderBy: { likes: 'desc' },
      take: 5,
      include: { tweet: { include: { versions: { orderBy: { version: 'desc' }, take: 1 } } } }
    });
    exemplarSource = 'global_fallback';
  }
  const weightedFeedbackQuery = await prisma.feedback.findMany({
    orderBy: { weighted_score: 'desc' },
    take: 5,
    where: { weighted_score: { not: null } }
  });
  const unweightedFeedbackQuery = await prisma.feedback.findMany({
    orderBy: { created_at: 'desc' },
    take: 5
  });
  const recentTopicsQuery = await prisma.tweet.findMany({
    orderBy: { created_at: 'desc' },
    take: 20,
    select: { original_topic: true, edited_topic: true }
  });
  const activeProfile = await prisma.personaProfile.findFirst({
    where: { is_active: true },
    orderBy: { version: 'desc' }
  });
  const lengthTarget = await computeLengthTarget();
  const blacklistInfo = await computeTopicBlacklist();
  const recentFingerprints = await getRecentStructuralFingerprints(15);

  const trendingTopics = await trendingTopicsPromise;

  const { selected: formatArchetype, unusedCount, consideredRecentFormats } =
    getNextFormatWithMeta(recentFingerprints);

  const feedbackSource = weightedFeedbackQuery.length >= 3
    ? weightedFeedbackQuery
    : [...weightedFeedbackQuery, ...unweightedFeedbackQuery].slice(0, 5);

  const context = topTweetsQuery
    .map(t => t.tweet.versions[0]?.content)
    .filter(Boolean) as string[];
  const recentFeedback = feedbackSource.map(f => `[Feedback from ${f.created_at.toISOString().split('T')[0]}]: ${f.feedback_text}`);
  const recentTopics = recentTopicsQuery
    .map(t => t.edited_topic || t.original_topic)
    .filter((topic) => topic && topic !== "AI Generating..." && topic !== "AI Generated");
  const learnedPersona = activeProfile?.profile_text ?? "";

  // Automatic supplied topics still obey cooldown. Explicit user edits/feedback
  // keep their requested topic so Telegram never displays one topic while the
  // planner silently substitutes another.
  let resolvedTopic = (state.topic ?? '').trim();
  if (resolvedTopic && !state.forceTopic && isTopicOnCooldown(resolvedTopic)) {
    blacklistInfo.list = Array.from(new Set([...blacklistInfo.list, resolvedTopic.toLowerCase()]));
    logger.warn(
      { topic: resolvedTopic },
      "Requested topic is on cooldown; clearing it so generation picks a fresh topic",
    );
    resolvedTopic = '';
  }

  const topicPlan = planTopic({
    requestedTopic: resolvedTopic,
    trendingTopics,
    recentTopics,
    topicBlacklist: blacklistInfo.list,
    forceRequestedTopic: state.forceTopic,
  });
  resolvedTopic = topicPlan.topic;

  const avoidItems = extractAvoidItems(learnedPersona);
  const hardProhibitions: string[] = [
    ...avoidItems.overusedStructures,
    ...avoidItems.overusedArcs,
    ...avoidItems.overusedPhrases,
  ];

  logger.info({
    duration: `${Date.now() - start}ms`,
    hasPersona: !!learnedPersona,
    trendCount: trendingTopics.length,
    acceptedTrendCount: topicPlan.acceptedTrendCount,
    rejectedTrendCount: topicPlan.rejectedTrendCount,
    plannedTopic: topicPlan.topic,
    topicLane: topicPlan.lane,
    topicSource: topicPlan.source,
    topicBucket: topicPlan.topicBucket,
    topicReason: topicPlan.reason,
    topicNeedsNewsContext: topicPlan.needsNewsContext,
    recentLaneCounts: topicPlan.recentLaneCounts,
    recentBucketCounts: topicPlan.recentBucketCounts,
    topicFree: false,
    lengthTarget,
    blacklistCount: blacklistInfo.list.length,
    blacklistSource: blacklistInfo.source,
    contextCount: context.length,
    exemplarSource,
    slotSampleCount: slotOutcomes.length,
    currentSlot,
    selectedFormat: formatArchetype.name,
    recentFormatsConsidered: consideredRecentFormats,
    unusedFormatsCount: unusedCount,
    recentFingerprintCount: recentFingerprints.length,
    hardProhibitionCount: hardProhibitions.length,
  }, "Finished contextLoader");
  return {
    topic: resolvedTopic,
    context,
    recentFeedback,
    recentTopics,
    trendingTopics: topicPlan.trendHints.slice(0, 10),
    learnedPersona,
    lengthTarget,
    topicBlacklist: blacklistInfo.list,
    iterationCount: state.iterationCount || 0,
    formatArchetype,
    recentFingerprints,
    topicFree: false,
    topicPlan,
    hardProhibitions,
    personaAvoidItems: hardProhibitions,
  };
}

async function personaAdapter(state: typeof AgentState.State) {
  logger.info("Running personaAdapter");
  const visibleDraftLimit = getVisibleDraftCharLimit();
  let toneInstruction = "Write like a dev who just opened Twitter between tasks.";
  if (state.timeOfDay === 'morning') toneInstruction = "Ship a hot take or a dev observation. Punchy. Direct. Like a guy who just opened his laptop with chai.";
  if (state.timeOfDay === 'afternoon') toneInstruction = "Bold opinion or dry humor. The kind of tweet that makes devs nod or argue.";
  if (state.timeOfDay === 'night') toneInstruction = "Late-night-coder energy. Real talk. Could be a 2am debug confession, a W, or a shrug about something that happened today.";

  const hardProhibitionsBlock =
    state.hardProhibitions && state.hardProhibitions.length > 0
      ? `---HARD PROHIBITIONS (structural violations — THESE WILL CAUSE REJECTION)---
BANNED PATTERNS (from prior analysis of your own overused structures):
${state.hardProhibitions.map((p) => `- ${p}`).join('\n')}

If your draft contains ANY of the above, it is structurally invalid.
The diversity checker will reject it. Generate something different.
---END HARD PROHIBITIONS---

`
      : '';

  const recentFeedbackBlock = state.recentFeedback.length > 0
    ? `\n[HISTORICAL STYLE GUIDELINES]\nThe user provided this feedback on previous posts. Extract only STYLISTIC preferences (tone, brevity, formatting) and IGNORE specific topic commands or subject matter from this list unless it explicitly says "from now on":\n${state.recentFeedback.map(f => `- ${f}`).join('\n')}\n`
    : "";

  const learnedPersonaBlock = state.learnedPersona
    ? `\n[LEARNED STYLE PROFILE — derived from your best-performing posts. Follow these patterns closely]:
${state.learnedPersona}\n`
    : "";

  const trendingBlock = state.trendingTopics && state.trendingTopics.length > 0
    ? `\n[FRESHNESS HINTS FROM TRENDS24 - optional context only; the TOPIC PLAN below is the source of truth]:\n${state.trendingTopics.slice(0, 10).map(t => `- ${t}`).join('\n')}\n`
    : "";

  const exemplarsBlock = state.context && state.context.length > 0
    ? `\n[STYLE EXEMPLARS — match THIS rhythm, directness, and sentence length. Do NOT copy the topic or subject matter]:\n${state.context.slice(0, 3).map((c, i) => `Example ${i + 1}: ${c}`).join('\n')}\n`
    : "";

  const lengthBlock = state.lengthTarget
    ? `\n[LENGTH TARGET — your top-performing tweets cluster here]: ${state.lengthTarget.min}-${state.lengthTarget.max} characters. Aim for this range.\n`
    : "";

  const blacklistBlock = state.topicBlacklist && state.topicBlacklist.length > 0
    ? `\n[POOR-PERFORMING / RECENTLY-USED TOPICS — AVOID these]:\n${state.topicBlacklist.map(t => `- ${t}`).join('\n')}\n`
    : "";

  const contrastRecentCount = (state.recentFingerprints ?? [])
    .slice(-3)
    .filter(fp => typeof fp === 'string' && fp.includes('CONTRAST'))
    .length;

  const archetype = state.formatArchetype;
  const bannedList = archetype?.bannedOpenings?.join(', ') ?? '';
  const bannedPhrasesList = archetype?.bannedPhrases?.join(', ') ?? '';
  const formatDirectiveBlock = archetype
    ? `---FORMAT DIRECTIVE (MANDATORY)---
This tweet MUST follow the "${archetype.name}" format.
Structure: ${archetype.description}
Shape hint: ${archetype.structureExample}

OPENING TEMPLATE (hard requirement for the FIRST sentence):
${archetype.openingTemplate}

EXAMPLE FIRST SENTENCE (imitate the shape, not the topic):
"${archetype.exampleFirstSentence}"

BANNED OPENINGS — if the draft starts with any of these (case-insensitive), it is INVALID and must be rewritten before returning:
${bannedList || '(none)'}
${bannedPhrasesList ? `BANNED PHRASES anywhere in the draft: ${bannedPhrasesList}\n` : ''}
The tweet must NOT start with "spent X hours" or any time-struggle opening unless the archetype explicitly allows it.
The tweet must NOT use a contrast-realization arc if the last 3 tweets used one.${contrastRecentCount >= 2 ? '\nHEADS UP: ' + contrastRecentCount + ' of the last 3 tweets already used a contrast-realization arc — avoid it entirely in this draft.' : ''}

Violation of the FORMAT DIRECTIVE makes the entire draft invalid. The quality scorer will reject it.
---END FORMAT DIRECTIVE---

`
    : "";

  const topicPlanBlock = state.topicPlan
    ? `\n[TOPIC PLAN - mandatory]
Lane: ${state.topicPlan.lane}
Source: ${state.topicPlan.source}
Bucket: ${state.topicPlan.topicBucket}
Selected topic: ${state.topicPlan.topic}
Angle: ${state.topicPlan.topicAngle}
Reason: ${state.topicPlan.reason}
Current-news context needed: ${state.topicPlan.needsNewsContext ? 'yes' : 'no'}

Use the selected topic and angle. Do not replace this topic with a random trend or generic fallback.
${state.topicPlan.lane === 'culture' ? 'Culture/personal posts must still sound like the owner, not like generic entertainment commentary.' : 'Tech posts should stay practical, specific, and builder/dev oriented.'}
`
    : "";

  const OWNER_IDENTITY = `You are ${OWNER_PROFILE.identity}

DOMAINS (only write about these):
${OWNER_PROFILE.domains.map(d => `- ${d}`).join('\n')}

MOODS (pick one that fits the tone/time):
${OWNER_PROFILE.moods.map(m => `- ${m}`).join('\n')}

VOICE & TONE:
${OWNER_PROFILE.tones.map(t => `- ${t}`).join('\n')}

LANGUAGE STYLE:
${OWNER_PROFILE.language.map(l => `- ${l}`).join('\n')}

EXPERIENCE VOICE: ${OWNER_PROFILE.experienceVoice}

CITIES YOU VIBE WITH: ${OWNER_PROFILE.cities.join(', ')}

HOBBIES/PERSONALITY:
${OWNER_PROFILE.hobbies.map(h => `- ${h}`).join('\n')}

TOPIC MIX CONTRACT:
- ${OWNER_PROFILE.topicMix.tech}% tech / AI / dev / product-engineering lane
- ${OWNER_PROFILE.topicMix.culture}% culture / personal / named-interest lane

EVERGREEN TECH TOPICS:
${OWNER_PROFILE.evergreenTechTopics.map(t => `- ${t}`).join('\n')}

PERSONAL TOPICS:
${OWNER_PROFILE.personalTopics.map(t => `- ${t}`).join('\n')}

CULTURE TOPICS:
${OWNER_PROFILE.cultureTopics.length > 0 ? OWNER_PROFILE.cultureTopics.map(t => `- ${t}`).join('\n') : '- none configured'}

CULTURE INTERESTS:
Artists: ${OWNER_PROFILE.cultureInterests.artists.join(', ') || 'none configured'}
Companies: ${OWNER_PROFILE.cultureInterests.companies.join(', ') || 'none configured'}
People: ${OWNER_PROFILE.cultureInterests.people.join(', ') || 'none configured'}
Products: ${OWNER_PROFILE.cultureInterests.products.join(', ') || 'none configured'}
Startups: ${OWNER_PROFILE.cultureInterests.startups.join(', ') || 'none configured'}
Songs: ${OWNER_PROFILE.cultureInterests.songs.join(', ') || 'none configured'}
Hobbies: ${OWNER_PROFILE.cultureInterests.hobbies.join(', ') || 'none configured'}

SLANGS (use sparingly, only when it fits naturally — 1 per tweet max):
${OWNER_PROFILE.slangs.join(', ')}

NEVER write about: ${OWNER_PROFILE.avoid.join(', ')}.
Random entertainment gossip is still banned. Profile-listed culture interests are allowed only when the topic plan selects the culture lane.`;

  const personaParameters = `${hardProhibitionsBlock}${formatDirectiveBlock}${OWNER_IDENTITY}
${learnedPersonaBlock}${exemplarsBlock}${trendingBlock}${topicPlanBlock}${lengthBlock}${blacklistBlock}Tone: ${toneInstruction}
AVOID these recent topics exactly: ${state.recentTopics.join(', ')}.${recentFeedbackBlock}
HOOK RULE: The first 60 characters MUST carry the core claim, punchline, or hook. Never waste the opener on setup or throat-clearing.

CONTENT APPROACH — prefer in this order:
1. Follow the TOPIC PLAN exactly.
2. For tech lane: first-person dev experiences, opinions, or dry product/engineering observations.
3. For culture lane: personal/culture hooks filtered through dev life, product taste, music taste, hobbies, or founder/operator humor.
4. Industry news/releases — ONLY if the topic plan says current-news context is needed and search grounding confirms it. Never from memory.

VOICE ANTI-PATTERNS (NEVER do these — instant reject):
- No metaphors about journeys, battles, or nature
- No words like: "indeed", "thus", "upon", "whilst", "one must", "in the realm of", "amidst", "henceforth", "behold"
- No philosophical framing ("existence", "the human condition", "life is a", "we are all")
- No literary flourishes. This is a tweet from a 23-year-old dev, not an essay
- No passive voice. Active only.
- No filler openers: "In today's world", "As we navigate", "It's important to"
- No specific model version numbers (3.7, 4.0, o3, o1, etc.) framed as news or launches — versions are facts you can get wrong. Talk about the model by name only if the topic plan selected it and search grounding confirms it.

HINGLISH RULE: DO NOT force "bhai", "yaar", "arre yaar", "kya kar raha hai", or any Hinglish into the tweet. Use Hinglish ONLY if the tweet genuinely needs it for humor and reads awkwardly without it. When in doubt, use plain English. Forced Hinglish is worse than no Hinglish.

RECENCY RULE: Today's date is ${new Date().toISOString().split('T')[0]}. NEVER frame anything as "just launched", "new release", "just dropped", or "breaking" unless the topic plan says current-news context is needed and search grounding confirms it. Your training data may be months old — treat any specific product release, model version, or news event as potentially outdated. Stick to observations, opinions, and experiences rather than news claims.

CASING RULE: After the first sentence ends (. or ! or ?), start the next word in lowercase UNLESS it is a proper noun, acronym, product name, brand, or title-case word (e.g. AI, LangGraph, React, Gemini, Claude, TypeScript, Node.js). Standard English nouns like "the", "it", "my", "this", "i" must be lowercase at sentence start (except the pronoun "I" which stays uppercase).

Output MUST be plain text. No markdown, no bolding (**), no hashtags.
STRICT REQUIREMENT: Your visible draft MUST be under ${visibleDraftLimit} characters. The app appends hidden tracking characters after generation, so ${visibleDraftLimit} is the real visible writing budget for the configured X account limit. Be concise.
NEVER end mid-sentence. Every response MUST be a complete thought with a closing period.
DO NOT include any preamble like "Here is your tweet" or "Draft:". Just the content.`;

  return { personaParameters };
}

async function contentGenerator(state: typeof AgentState.State) {
  const start = Date.now();
  logger.info({ topic: state.topic, format: state.formatArchetype?.name }, "Running contentGenerator (LLM Call 1)...");

  const revisionBlock = buildRevisionContract(state.previousDraft, state.currentFeedback);

  // Re-roll context — diversity gate rejected the prior attempt. Tell the model
  // exactly which fingerprint + draft it must NOT reproduce, and force it into
  // the new format archetype already baked into personaParameters.
  let rerollBlock = "";
  if (state.rejectedFingerprint && state.rejectedDraft) {
    rerollBlock = `\n\n[STRUCTURAL RE-ROLL — the previous draft was rejected as structurally duplicate]\nYour previous draft: "${state.rejectedDraft}"\nIts structural fingerprint was: ${state.rejectedFingerprint}\nDO NOT produce a tweet with this structure. Use the NEW FORMAT DIRECTIVE at the top of this prompt — the archetype has been changed for this retry.\n\n`;
  }

  const effectiveTopic = state.topic;
  const topicAngleBlock = state.topicPlan
    ? `\nTopic lane: ${state.topicPlan.lane}\nTopic source: ${state.topicPlan.source}\nTopic bucket: ${state.topicPlan.topicBucket}\nTopic angle: ${state.topicPlan.topicAngle}\n`
    : '';
  const groundingBlock = state.topicPlan?.needsNewsContext
    ? `\n[GOOGLE SEARCH GROUNDING ENABLED]\nUse search only to avoid stale factual claims about the selected topic. Do not include URLs, citations, or search-result summaries in the tweet. If search does not confirm a specific news fact, write an evergreen observation about the topic instead.\n`
    : '';
  const visibleDraftLimit = getVisibleDraftCharLimit();

  const prompt = `${state.personaParameters}
${effectiveTopic ? `Topic: ${effectiveTopic}` : 'Generate a topic from the owner profile topic buckets and write a tweet.'}${topicAngleBlock}${groundingBlock}${revisionBlock}${rerollBlock}
Target: Generate both a Topic and a Draft.
Output Format: TOPIC|DRAFT

CRITICAL: DO NOT include the words "Topic:" or "Draft:" in the output. Just the data separated by "|".
LANGUAGE RULE: The TOPIC must ALWAYS be in English. If a trending topic is in Hindi, Hinglish, or any other language, translate it to English first.
Example: AI Ethics|Why we need to talk about data bias. We must act now.

STYLE EXAMPLES (match this energy, not the topic):
BAD (reject these styles):
- "In the realm of artificial intelligence, one must ponder the delicate balance..."
- "As we traverse the ever-evolving landscape of technology..."
GOOD (write like this):
- "spent 3 hours debugging a race condition. the fix was one await. I'm fine."
- "ngl RAG is 80% data cleaning. the 'AI' part takes 20 mins."
- "nobody talks about how much of AI engineering is just... prompt formatting"
- "built a full agent pipeline this week. most of the code is error handling lol."

Constraints: Plain text only, under ${visibleDraftLimit} visible characters, no markdown, no hashtags, no emojis.
Ensure the last sentence is COMPLETED. DO NOT leave it hanging.
CONTENT PRIORITY: Prefer first-person dev experiences and opinions over industry news. Experiences don't age. News does.
RECENCY: NEVER say "just launched", "new release", "just dropped", or mention specific version numbers (3.7, 4.0, o3, etc.) as news unless Google Search grounding is enabled for this topic and confirms the claim. Your training data may be months old.
HINGLISH: Do NOT add "bhai", "yaar", or Hinglish just for flavor. Only if it fits organically.`;

  try {
    const { allowed, reason } = await canCallLLM();
    if (!allowed) {
      logger.warn({ reason }, "LLM rate limit reached in contentGenerator, short-circuiting graph");
      return {
        topic: effectiveTopic || state.topic || "Rate Limited",
        draft: "",
        iterationCount: 1,
        rateLimited: true,
      };
    }
    await recordLLMCall("gemini-2.5-flash", "generate");

    const useGrounding = state.topicPlan?.needsNewsContext === true;
    logger.info(
      {
        topic: effectiveTopic,
        topicLane: state.topicPlan?.lane,
        topicSource: state.topicPlan?.source,
        googleSearchGrounding: useGrounding,
      },
      "Invoking content generator",
    );
    let res;
    try {
      res = await llm.invoke(prompt, {
        signal: AbortSignal.timeout(CALL_TIMEOUT),
        ...(useGrounding ? { tools: GOOGLE_SEARCH_RETRIEVAL_TOOLS } : {}),
      });
    } catch (groundingErr) {
      if (!useGrounding) throw groundingErr;

      const message = groundingErr instanceof Error ? groundingErr.message : String(groundingErr);
      logger.warn({ err: message, topic: effectiveTopic }, "Grounded generation failed; retrying without Google Search");
      const retryAllowance = await canCallLLM();
      if (!retryAllowance.allowed) {
        logger.warn({ reason: retryAllowance.reason }, "LLM rate limit reached before ungrounded retry");
        return {
          topic: effectiveTopic || state.topic || "Rate Limited",
          draft: "",
          iterationCount: 1,
          rateLimited: true,
        };
      }
      await recordLLMCall("gemini-2.5-flash", "generate_ungrounded_retry");
      res = await llm.invoke(prompt, { signal: AbortSignal.timeout(CALL_TIMEOUT) });
    }
    const content = (res.content as string).trim();

    let topic = effectiveTopic || state.topic || "AI Generated";
    let draft = content;

    if (content.includes('|')) {
      const parts = content.split('|');
      topic = effectiveTopic || (parts[0] ?? "").trim() || topic;
      draft = parts.slice(1).join('|').trim();
    }

    draft = fitDraftBeforeScoring(
      finalizeDraft(draft),
      visibleDraftLimit,
      "contentGenerator",
      state.tweetId,
    );

    // Register format for this tweetId so future fingerprint reads attach the
    // FORMAT: prefix. Keyed by tweetId since that's how TweetVersion rows are
    // identified on readback.
    if (state.tweetId && state.formatArchetype) {
      registerDraftFormat(state.tweetId, state.formatArchetype.name);
    }

    logger.info({ topic, draftLength: draft.length, duration: `${Date.now() - start}ms` }, "Parsed AI Generation");
    return { topic, draft, iterationCount: 1 };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, "Content Generator failed or timed out. Using fallback.");
    return {
      topic: effectiveTopic || state.topic || "General Update",
      draft: "still shipping. no updates, just commits.",
      iterationCount: 1
    };
  }
}

async function diversityGate(state: typeof AgentState.State) {
  const result = await checkDraftDiversity(state.draft, state.tweetId);
  const observedFingerprint = extractStructuralFingerprint(state.draft);
  const composedFingerprint = composeFingerprint(state.formatArchetype?.name ?? null, observedFingerprint);

  const recentSameFp = (state.recentFingerprints ?? []).filter((fp) => {
    if (typeof fp !== 'string') return false;
    const stripped = fp.replace(/^FORMAT:[^|]+\|/, '');
    return stripped === observedFingerprint;
  }).length;

  if (!result.duplicate) {
    pushFingerprintToBuffer(composedFingerprint);
    logger.info({
      maxSimilarity: result.maxSimilarity,
      fingerprint: composedFingerprint,
      sameFingerprintCountInRecent: result.report.sameFingerprintCountInRecent,
      recentSameStructuralCount: recentSameFp,
    }, "Draft passed diversity gate");
    return {
      rerollCount: state.rerollCount ?? 0,
      structuralRepetitionCount: recentSameFp,
      rejectedFingerprint: "",
      rejectedDraft: "",
    };
  }

  if ((state.rerollCount ?? 0) >= 1) {
    pushFingerprintToBuffer(composedFingerprint);
    logger.warn({
      rejectionKind: result.report.rejectionKind,
      maxSimilarity: result.maxSimilarity,
      matchedTweetId: result.matchedTweetId,
      matchedFingerprint: result.report.matchedFingerprint,
      sameFingerprintCountInRecent: result.report.sameFingerprintCountInRecent,
    }, "Draft still near-duplicate after re-roll. Accepting.");
    return { rerollCount: (state.rerollCount ?? 0) + 1, structuralRepetitionCount: recentSameFp };
  }

  // On first rejection, pick a different format for the retry. The previous
  // format clearly led the model back to the same shape.
  const { selected: newArchetype } = getNextFormatWithMeta([
    ...(state.recentFingerprints ?? []),
    composedFingerprint,
  ]);

  logger.warn({
    rejectionKind: result.report.rejectionKind,
    maxSimilarity: result.maxSimilarity,
    matchedTweetId: result.matchedTweetId,
    matchedFingerprint: result.report.matchedFingerprint,
    sameFingerprintCountInRecent: result.report.sameFingerprintCountInRecent,
    previousFormat: state.formatArchetype?.name,
    newFormat: newArchetype.name,
  }, "Draft near-duplicate. Triggering re-roll with NEW format.");
  return {
    rerollCount: (state.rerollCount ?? 0) + 1,
    formatArchetype: newArchetype,
    structuralRepetitionCount: recentSameFp,
    rejectedFingerprint: composedFingerprint,
    rejectedDraft: state.draft,
  };
}

function afterContentGenerator(state: typeof AgentState.State): "diversityGate" | typeof END {
  if (state.rateLimited) {
    logger.warn("Rate-limited; skipping diversityGate and qualityScorer");
    return END;
  }
  return "diversityGate";
}

const MAX_REROLLS = 1;
function afterDiversityGate(state: typeof AgentState.State): "personaAdapter" | "qualityScorer" {
  const rerolls = state.rerollCount ?? 0;
  if (state.rejectedFingerprint && rerolls > 0 && rerolls <= MAX_REROLLS) {
    // Route back through personaAdapter so the NEW format archetype gets baked
    // into personaParameters before contentGenerator re-runs.
    return "personaAdapter";
  }
  return "qualityScorer";
}

export async function qualityScorer(state: typeof AgentState.State) {
  logger.info("Running qualityScorer (LLM Call 2)");

  const repetitionCount = state.structuralRepetitionCount ?? 0;
  const structuralContextBlock = `
---STRUCTURAL CONTEXT FOR SCORING---
This draft uses structural pattern: ${extractStructuralFingerprint(state.draft)}
This same structural pattern has appeared ${repetitionCount} times in recent history.
If the count is >= 2, reduce your quality score by 1 point for structural repetition.
If the count is >= 4, reduce your quality score by 2 points.
A tweet that is high quality but uses an overused structure is less valuable than a slightly lower quality tweet with a novel structure.
---END STRUCTURAL CONTEXT---
`;

  const revisionScoringBlock = state.previousDraft && state.currentFeedback
    ? `
---REVISION COMPLIANCE FOR SCORING---
Previous draft:
"${stripInvisibleText(state.previousDraft)}"

User feedback:
"${stripInvisibleText(state.currentFeedback)}"

This is a feedback regeneration. Deduct 4 points if the tweet ignores the feedback or changes the concrete subject/example from the previous draft without being asked. If it misses named tools/entities from the feedback, say "feedback" in the critique.
---END REVISION COMPLIANCE---
`
    : '';

  const prompt = `${state.personaParameters}\n${structuralContextBlock}${revisionScoringBlock}\nScore the following tweet on a scale of 1.0 to 10.0 for clarity, engagement, adherence to constraints, feedback compliance, and voice authenticity. Also provide a one-sentence critique.\n\nSCORING PRECISION:\n- Use ONE decimal place (e.g., 7.4, 8.2, 9.7). Do NOT round to whole numbers.\n- Most tweets fall between 6.0 and 9.0. Reserve 9.5+ for genuinely standout drafts and below 5.0 for clearly broken ones.\n- Differentiate similar drafts with the decimal — a "good but predictable" tweet is 7.3, a "good with a sharp hook" is 8.1, etc.\n\nSCORING RULES:\n- Deduct 2 points if the tweet uses formal/literary language, metaphors, or philosophical framing that doesn't match the persona voice.\n- Reward conversational, direct, punchy tweets that sound like real dev Twitter.\n- If the tweet contains words like "indeed", "thus", "upon", "whilst", "realm", "amidst", "behold", "traverse", "ponder" — score 4.0 or below and mention "formal" or "literary" in the critique.\n- Deduct 3 points if the tweet makes a factual claim about a specific product launch, version number, or news event that could be outdated.\n- In revision mode, deduct 4 points if the tweet does not directly satisfy the user feedback or pivots away from the previous draft's concrete subject.
- Apply the STRUCTURAL CONTEXT penalty above.\n\nTweet:\n${state.draft}\n\nOutput format: SCORE|CRITIQUE (e.g., 8.2|Good but needs a stronger hook)`;

  let score = 10;
  let critique = "Skipped critique due to timeout.";

  try {
    const { allowed, reason } = await canCallLLM();
    if (!allowed) {
      logger.warn({ reason }, "LLM rate limit reached in qualityScorer, using default score");
    } else {
      await recordLLMCall("gemini-2.5-flash", "score");
      const res = await llm.invoke(prompt, { signal: AbortSignal.timeout(CALL_TIMEOUT) });
      const raw = (res.content as string).trim();
      const parts = raw.split('|');
      score = parseScore(parts[0] ?? raw);
      critique = (parts[1] ?? '').trim();
    }
  } catch (err) {
    logger.warn("Quality Scorer timed out. Proceeding with default score.");
  }

  const critiqueHints = parseCritiqueHints(critique, state.draft, score);
  logger.info({ score, critiqueHints, structuralRepetitionCount: repetitionCount }, "Parsed critique hints");

  return { score, critique, critiqueHints };
}

// Graph node — topic/content coherence check. Pure string, no LLM call.
export async function coherenceGate(state: typeof AgentState.State) {
  const validation = validateDraftContext(state.draft, state);
  if (!validation.ok && validation.kind === 'revision') {
    logger.warn({
      topic: state.topic,
      reason: validation.reason,
      missingAnchors: validation.missingAnchors,
      draftPreview: state.draft.slice(0, 80),
    }, "Revision compliance gate: draft did not satisfy feedback context");

    const nudgedScore = state.score >= 8 ? 6 : state.score;
    const nudgedHints = Array.from(new Set([...(state.critiqueHints ?? []), 'feedback_drift']));
    const critiqueSuffix = `Revision compliance failed: ${validation.reason}${validation.missingAnchors.length > 0 ? ` (${validation.missingAnchors.join(', ')})` : ''}.`;
    return {
      coherent: false,
      coherenceReason: validation.reason,
      score: nudgedScore,
      critique: [state.critique, critiqueSuffix].filter(Boolean).join(' '),
      critiqueHints: nudgedHints,
      validationFailed: false,
    };
  }

  if (validation.ok) {
    resetCoherenceFailure(state.topic);
    logger.info({
      reason: validation.reason,
      overlap: validation.overlap,
      domainMatches: validation.domainMatches,
    }, "Coherence gate passed");
    return { coherent: true, coherenceReason: validation.reason, validationFailed: false };
  }

  const failureCount = incrementCoherenceFailure(state.topic);
  logger.warn({
    topic: state.topic,
    draftPreview: state.draft.slice(0, 80),
    reason: validation.reason,
    topicKeywords: validation.topicKeywords,
    failureCount,
  }, "Coherence gate: topic-content mismatch");

  if (failureCount >= 3) {
    recordTopicUsed(state.topic);
    logger.warn({ topic: state.topic, failureCount }, "Topic hit 3 coherence failures; added to in-memory blacklist");
  }

  // Force a refiner pass if score was skipping it, by degrading the score.
  // Adds only one LLM call, only on mismatch.
  const nudgedScore = state.score >= 8 ? 6 : state.score;
  const nudgedHints = Array.from(new Set([...(state.critiqueHints ?? []), 'topic_drift']));
  return {
    coherent: false,
    coherenceReason: validation.reason,
    score: nudgedScore,
    critiqueHints: nudgedHints,
    validationFailed: false,
  };
}

async function autoRefiner(state: typeof AgentState.State) {
  logger.info({ score: state.score, hints: state.critiqueHints, coherent: state.coherent }, "Running autoRefiner (LLM Call 3)");

  const HINT_DIRECTIVES: Record<string, string> = {
    too_long: "SHORTEN — cut filler words, tighten every sentence.",
    too_short: "EXPAND — add one concrete detail or example.",
    weak_hook: "REWRITE THE OPENER — first 60 chars must land the core claim or punchline immediately.",
    vague_claim: "ADD SPECIFICITY — replace generic phrases with concrete names, numbers, or examples.",
    low_energy: "INJECT VOICE — add a sharper opinion, dry humor, or a GenZ slang if it fits.",
    cliche: "DE-CLICHE — strip any 'game changer', 'paradigm shift', 'at the end of the day' phrasing.",
    too_jargon: "SIMPLIFY — replace jargon with plain-English equivalent.",
    weak_ending: "STRENGTHEN THE CLOSE — end on a punchline, callback, or sharp assertion. No trailing fluff.",
    poor_flow: "SMOOTH THE FLOW — rewrite for one continuous thought, cut awkward transitions.",
    needs_emotion: "ADD HUMAN TEXTURE — make it feel like a real person typed it, not a corporate draft.",
    low_quality: "FULL REWRITE — keep the topic, rebuild from scratch with a stronger angle.",
    wrong_voice: "STRIP THE LITERARY VOICE — rewrite as a casual dev tweet. Short sentences. Real words. Zero metaphors.",
    topic_drift: `TOPIC GROUNDING — your draft must explicitly reference or connect to the topic: "${state.topic}". If the topic is not relevant to your domain, acknowledge it briefly and pivot to a related technical angle.`,
    feedback_drift: `REVISION GROUNDING — this rewrite must directly satisfy the user's feedback: "${stripInvisibleText(state.currentFeedback)}". Keep the previous draft's concrete subject/context: "${stripInvisibleText(state.previousDraft)}". Do not pivot to a different example inside the same broad topic.`,
  };

  const directives = (state.critiqueHints ?? [])
    .map(h => HINT_DIRECTIVES[h])
    .filter(Boolean);

  const hintsBlock = directives.length > 0
    ? `\n\nSTRUCTURED REFINEMENT HINTS (apply every one):\n${directives.map(d => `- ${d}`).join('\n')}\n`
    : "";

  // Re-include the FORMAT DIRECTIVE + HARD PROHIBITIONS in the refine prompt
  // by reusing state.personaParameters (which already has them at the top).
  const revisionRepairBlock = buildRevisionContract(state.previousDraft, state.currentFeedback);

  const prompt = `${state.personaParameters}${revisionRepairBlock}\n\nYour previous draft was scored ${state.score}/10 with this critique: "${state.critique}".${hintsBlock}\nRewrite it to be significantly better while keeping it plain text.\nIMPORTANT: You MUST still obey the FORMAT DIRECTIVE and HARD PROHIBITIONS at the top of the prompt. Do NOT fall back to the default "everyone says X, actually Y" shape.\nOriginal: ${state.draft}\n\nSTRICT: Ensure the new version is a full, finished tweet that ends with a period. No incomplete sentences. No intro text. Just the tweet.`;

  try {
    const { allowed, reason } = await canCallLLM();
    if (!allowed) {
      logger.warn({ reason }, "LLM rate limit reached in autoRefiner, keeping original draft");
      return { draft: state.draft, iterationCount: state.iterationCount + 1 };
    }
    await recordLLMCall("gemini-2.5-flash", "refine");

    const res = await llm.invoke(prompt, { signal: AbortSignal.timeout(CALL_TIMEOUT) });
    const refined = fitDraftBeforeScoring(
      finalizeDraft((res.content as string).trim()),
      getVisibleDraftCharLimit(),
      "autoRefiner",
      state.tweetId,
    );
    const rejectReason = isSuspiciousDraft(refined);
    if (rejectReason) {
      logger.warn({ rejectReason, refinedLen: refined.length, originalLen: state.draft.length }, "Refined draft rejected by heuristic. Keeping original.");
      return { draft: state.draft, iterationCount: state.iterationCount + 1 };
    }
    logger.info({ refinedLen: refined.length }, "Refined draft accepted");
    return { draft: refined, iterationCount: state.iterationCount + 1 };
  } catch (err) {
    logger.warn("Auto Refiner timed out. Using original draft.");
    return { draft: state.draft, iterationCount: state.iterationCount + 1 };
  }
}

function postRefinerGate(state: typeof AgentState.State) {
  const validation = validateDraftContext(state.draft, state);
  if (validation.ok) {
    resetCoherenceFailure(state.topic);
    logger.info({
      reason: validation.reason,
      overlap: validation.overlap,
      domainMatches: validation.domainMatches,
      iterationCount: state.iterationCount,
    }, "Post-refiner validation passed");
    return { coherent: true, coherenceReason: validation.reason, validationFailed: false };
  }

  const hint = validation.kind === 'revision' ? 'feedback_drift' : 'topic_drift';
  const nudgedHints = Array.from(new Set([...(state.critiqueHints ?? []), hint]));
  logger.warn({
    topic: state.topic,
    reason: validation.reason,
    validationKind: validation.kind,
    missingAnchors: validation.kind === 'revision' ? validation.missingAnchors : [],
    topicKeywords: validation.kind === 'topic' ? validation.topicKeywords : [],
    iterationCount: state.iterationCount,
    draftPreview: state.draft.slice(0, 80),
  }, "Post-refiner validation failed");

  return {
    coherent: false,
    coherenceReason: validation.reason,
    score: 6,
    critiqueHints: nudgedHints,
    validationFailed: state.iterationCount >= 2,
  };
}

function finalTopicMemory(state: typeof AgentState.State) {
  if (state.topic) {
    recordTopicUsed(state.topic);
    logger.info({ topic: state.topic }, "Recorded final topic in cooldown memory");
  }
  return {};
}

function shouldRefine(state: typeof AgentState.State): "autoRefiner" | "finalTopicMemory" {
  if (state.coherent === false) {
    logger.info("Coherence mismatch — forcing refiner pass for topic grounding");
    return "autoRefiner";
  }
  if ((state.critiqueHints ?? []).includes("too_long")) {
    logger.info("Draft exceeds visible post budget - forcing refiner pass for length");
    return "autoRefiner";
  }
  if (state.score >= 8) {
    logger.info({ score: state.score }, "Score >= 8, skipping autoRefiner");
    return "finalTopicMemory";
  }
  return "autoRefiner";
}

function afterPostRefinerGate(state: typeof AgentState.State): "autoRefiner" | "finalTopicMemory" | typeof END {
  if (state.validationFailed) {
    logger.warn({
      topic: state.topic,
      reason: state.coherenceReason,
      iterationCount: state.iterationCount,
    }, "Post-refiner validation failed after retry budget; ending without final topic memory");
    return END;
  }
  if (state.coherent === false) return "autoRefiner";
  return "finalTopicMemory";
}

const workflow = new StateGraph(AgentState)
  .addNode("contextLoader", contextLoader)
  .addNode("personaAdapter", personaAdapter)
  .addNode("contentGenerator", contentGenerator)
  .addNode("diversityGate", diversityGate)
  .addNode("qualityScorer", qualityScorer)
  .addNode("coherenceGate", coherenceGate)
  .addNode("autoRefiner", autoRefiner)
  .addNode("postRefinerGate", postRefinerGate)
  .addNode("finalTopicMemory", finalTopicMemory)

  .addEdge(START, "contextLoader")
  .addEdge("contextLoader", "personaAdapter")
  .addEdge("personaAdapter", "contentGenerator")
  .addConditionalEdges("contentGenerator", afterContentGenerator)
  .addConditionalEdges("diversityGate", afterDiversityGate)
  .addEdge("qualityScorer", "coherenceGate")
  .addConditionalEdges("coherenceGate", shouldRefine)
  .addEdge("autoRefiner", "postRefinerGate")
  .addConditionalEdges("postRefinerGate", afterPostRefinerGate)
  .addEdge("finalTopicMemory", END);

export const agentGraph = workflow.compile();
