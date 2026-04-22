import 'dotenv/config';
import { StateGraph, START, END, Annotation } from "@langchain/langgraph";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { prisma } from "./db.js";
import { logger } from "./logger.js";
import { canCallLLM, recordLLMCall } from "./rateGuard.js";
import { getTrendingTopics } from "./trends.js";
import {
  checkDraftDiversity,
  composeFingerprint,
  extractStructuralFingerprint,
  getRecentStructuralFingerprints,
  pushFingerprintToBuffer,
} from "./draftDiversity.js";
import { getNextFormat } from "./draftFormats.js";
import type { FormatArchetype } from "./draftFormats.js";
import { getTopicPerformance } from "./analytics.js";

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
  iterationCount: Annotation<number>({ reducer: (x, y) => y ?? x, default: () => 0 }),
  lengthTarget: Annotation<{ min: number; max: number } | null>({ reducer: (x, y) => y ?? x, default: () => null }),
  topicBlacklist: Annotation<string[]>({ reducer: (x, y) => y ?? x, default: () => [] }),
  rerollCount: Annotation<number>({ reducer: (x, y) => y ?? x, default: () => 0 }),
  formatArchetype: Annotation<FormatArchetype | null>({ reducer: (x, y) => y ?? x, default: () => null }),
  recentFingerprints: Annotation<string[]>({ reducer: (x, y) => y ?? x, default: () => [] }),
});

// ✅ FIX 1: Temperature lowered to 1.3 (safe, still creative)
// ✅ FIX 2: Increased timeout signal to 90s per call
const baseConfig = {
  apiKey: process.env.GOOGLE_API_KEY as string,
  temperature: 0.7,
  maxOutputTokens: 2048,
  topP: 0.9,
  maxRetries: 5,
};

const CALL_TIMEOUT = 120_000;

const OWNER_PROFILE = {
  identity: "Lalit Kumar, 23-year-old FullStack AI Engineer, 2 years of real shipping experience. GenZ dev. Not a tutorial guy.",
  domains: [
    "AI/LLM — agents, LangGraph, RAG, prompt engineering, Gemini, OpenAI, Anthropic",
    "Frontend — React, Next.js, TypeScript, Tailwind, UI/UX, component design",
    "FullStack — Node.js, APIs, Prisma, Supabase, PostgreSQL, system design",
    "Dev culture — shipping, indie hacking, build-in-public, side projects, developer productivity",
    "Sarcasm/humor — tech hype, over-engineering, tutorial hell, AI bros, imposter syndrome, bad code reviews",
  ],
  moods: [
    "curious and caffeinated",
    "frustrated-but-still-shipping",
    "late-night-coder energy",
    "quietly proud after a bug fix",
    "mildly unhinged about a new AI tool",
    "done with hype, just building",
  ],
  tones: [
    "punchy and direct",
    "dry humor with a straight face",
    "self-aware and slightly self-deprecating",
    "opinionated but not arrogant",
    "GenZ brevity — says a lot in few words",
  ],
  language: [
    "Plain English by default",
    "No jargon without payoff — earn the technical term",
    "Short sentences. No filler. No corporate speak.",
  ],
  experienceVoice: "2 years in, knows enough to be dangerous. Has opinions. Has scars from prod bugs. Not pretending to be a 10x guru.",
  cities: ["Jaipur", "Bangalore", "Delhi"],
  hobbies: [
    "building side projects at 2am",
    "trying every new AI tool that drops",
    "chai",
    "doom-scrolling dev Twitter then building something inspired by it",
    "debugging things that 'should just work'",
  ],
  slangs: [
    "hehe", "lol", "lmao", "ngl", "tbh", "fr fr", "no cap", "bro",
    "bruh", "lowkey", "highkey", "based", "W", "L",
    "it's giving", "not gonna lie", "the audacity",
  ],
  avoid: [
    "politics", "sports", "entertainment gossip", "finance/crypto hype",
    "motivational fluff without substance", "topics unrelated to tech/AI/dev",
  ],
  trendKeywords: [
    "ai", "llm", "gpt", "claude", "gemini", "openai", "anthropic", "machine learning", "ml",
    "react", "nextjs", "typescript", "javascript", "frontend", "tailwind", "css", "ui", "ux",
    "fullstack", "full stack", "web dev", "developer", "programming", "coding", "software", "engineer",
    "node", "api", "backend", "database", "prisma", "supabase", "postgres",
    "startup", "saas", "product", "indie hacker", "build in public", "ship", "side project",
    "tech", "devtools", "open source", "github", "cursor", "vscode",
    "jaipur", "bangalore", "delhi",
    "chai", "debugging", "2am", "imposter syndrome", "tutorial hell",
  ],
};

// Let Gemini 2.5 reason through voice constraints before generating (separate token pool from maxOutputTokens)
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

// Trim a possibly-truncated LLM draft to the last full sentence.
// Drops dangling fragments like "If everyone is" to prevent fake-period masking.
function finalizeDraft(raw: string): string {
  let s = (raw ?? "").trim();
  if (!s) return "";

  // Already ends clean
  if (/[.!?]["')\]]?$/.test(s)) return s;

  // Walk back to the last sentence terminator
  const match = s.match(/^(.*[.!?])["')\]]?\s*\S*$/s);
  if (match && match[1]) {
    const trimmed = match[1].trim();
    // Only accept the trim if it keeps enough content (>=40 chars). Otherwise the whole reply is one broken sentence.
    if (trimmed.length >= 40) return trimmed;
  }

  // No terminator anywhere and draft is short → append a period rather than return empty
  return s + ".";
}

// Heuristic: detect broken/suspicious draft output. Returns reason string when suspicious, null when OK.
// Catches truncation, garbage, and length pathologies without needing an LLM rescore.
function isSuspiciousDraft(draft: string): string | null {
  const s = (draft ?? "").trim();
  if (!s) return "empty";
  if (s.length < 40) return `too_short(${s.length})`;
  if (s.length > 280) return `too_long(${s.length})`;
  if (!/[.!?]["')\]]?$/.test(s)) return "no_terminator";
  // Reject obvious preamble leaks
  if (/^(here'?s|here is|draft:|tweet:|topic:)/i.test(s)) return "preamble_leak";
  // Reject markdown artifacts
  if (/[*_`#]/.test(s)) return "markdown_artifact";
  return null;
}

// Extract numeric score robustly from free-form LLM output. Defaults to 7 (neutral) on parse failure, never 0.
function parseScore(raw: string): number {
  const match = (raw ?? "").match(/\d+(\.\d+)?/);
  if (!match) return 7;
  const n = parseFloat(match[0]);
  if (!Number.isFinite(n)) return 7;
  return Math.max(1, Math.min(10, n));
}

// Parse free-form critique text into discrete actionable hints for autoRefiner.
// Maps common critique patterns to a fixed hint vocabulary.
function parseCritiqueHints(critique: string, draft: string, score: number): string[] {
  const hints: string[] = [];
  const c = (critique ?? "").toLowerCase();
  const d = (draft ?? "").trim();

  // Length-based hints (derived from the draft itself, not just critique text)
  if (d.length > 260) hints.push("too_long");
  if (d.length < 80) hints.push("too_short");

  // Critique-text pattern matching
  if (/\b(hook|opener|opening|first line|grab)\b/.test(c)) hints.push("weak_hook");
  if (/\b(vague|generic|bland|unclear|ambiguous|specific)\b/.test(c)) hints.push("vague_claim");
  if (/\b(boring|dull|flat|unengaging|dry|no voice)\b/.test(c)) hints.push("low_energy");
  if (/\b(cliche|cliché|trite|overused|tired|been said)\b/.test(c)) hints.push("cliche");
  if (/\b(jargon|technical|complex|simpler|simplify)\b/.test(c)) hints.push("too_jargon");
  if (/\b(ending|conclusion|closing|final|ends)\b/.test(c)) hints.push("weak_ending");
  if (/\b(structure|flow|awkward|choppy|disjointed)\b/.test(c)) hints.push("poor_flow");
  if (/\b(emotion|feel|personal|relate|human)\b/.test(c)) hints.push("needs_emotion");

  // Voice violation detection — catches literary/philosophical/Shakespearean output
  if (/\b(formal|literary|philosophical|eloquent|profound|poetic|metaphor|shakespear|grandiose|flowery|verbose)\b/.test(c)) hints.push("wrong_voice");

  // Score-based fallback hints when critique is empty/unhelpful
  if (hints.length === 0 && score < 7) hints.push("low_quality");

  return hints;
}

// Compute sweet-spot length range from top-tier TweetOutcome records.
// Returns null if not enough data (<5 high-tier outcomes).
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

    // Keep only the latest version per tweet
    const seen = new Set<string>();
    const lengths: number[] = [];
    for (const v of versions) {
      if (seen.has(v.tweet_id)) continue;
      seen.add(v.tweet_id);
      lengths.push(v.content.length);
    }
    if (lengths.length < 5) return null;

    const avg = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    const variance = lengths.reduce((s, l) => s + (l - avg) ** 2, 0) / lengths.length;
    const stdev = Math.sqrt(variance);
    const min = Math.max(60, Math.floor(avg - stdev));
    const max = Math.min(280, Math.ceil(avg + stdev));
    return { min, max };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "computeLengthTarget failed");
    return null;
  }
}

// Fetch bottom-20% topics by avg_outcome_score for AVOID list.
async function computeTopicBlacklist(): Promise<string[]> {
  try {
    const topics = await getTopicPerformance(50);
    if (topics.length < 10) return [];
    const bottomSize = Math.max(1, Math.floor(topics.length * 0.2));
    return topics.slice(-bottomSize).map(t => t.topic);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "computeTopicBlacklist failed");
    return [];
  }
}

async function contextLoader(state: typeof AgentState.State) {
  const start = Date.now();
  logger.info("Running contextLoader...");

  const [topTweetsQuery, weightedFeedbackQuery, unweightedFeedbackQuery, recentTopicsQuery, activeProfile, trendingTopics, lengthTarget, topicBlacklist, recentFingerprints] = await Promise.all([
    prisma.engagement.findMany({
      orderBy: { likes: 'desc' },
      take: 5,
      include: { tweet: { include: { versions: { orderBy: { version: 'desc' }, take: 1 } } } }
    }),
    prisma.feedback.findMany({
      orderBy: { weighted_score: 'desc' },
      take: 5,
      where: { weighted_score: { not: null } }
    }),
    prisma.feedback.findMany({
      orderBy: { created_at: 'desc' },
      take: 5
    }),
    prisma.tweet.findMany({
      orderBy: { created_at: 'desc' },
      take: 10,
      select: { original_topic: true, edited_topic: true }
    }),
    prisma.personaProfile.findFirst({
      where: { is_active: true },
      orderBy: { version: 'desc' }
    }),
    getTrendingTopics(),
    computeLengthTarget(),
    computeTopicBlacklist(),
    getRecentStructuralFingerprints(15),
  ]);

  const formatArchetype = getNextFormat(recentFingerprints);

  // Use weighted feedback if 3+ exist, otherwise fallback to unweighted
  const feedbackSource = weightedFeedbackQuery.length >= 3
    ? weightedFeedbackQuery
    : [...weightedFeedbackQuery, ...unweightedFeedbackQuery].slice(0, 5);

  const context = topTweetsQuery
    .map(t => t.tweet.versions[0]?.content)
    .filter(Boolean) as string[];
  const recentFeedback = feedbackSource.map(f => `[Feedback from ${f.created_at.toISOString().split('T')[0]}]: ${f.feedback_text}`);
  const recentTopics = recentTopicsQuery.map(t => t.edited_topic || t.original_topic);
  const learnedPersona = activeProfile?.profile_text ?? "";

  const filteredTrends = trendingTopics.filter(t =>
    OWNER_PROFILE.trendKeywords.some(kw => t.toLowerCase().includes(kw))
  );
  const relevantTrends = filteredTrends.length > 0 ? filteredTrends.slice(0, 10) : trendingTopics.slice(0, 5);

  logger.info({
    duration: `${Date.now() - start}ms`,
    hasPersona: !!learnedPersona,
    trendCount: trendingTopics.length,
    relevantTrendCount: relevantTrends.length,
    lengthTarget,
    blacklistCount: topicBlacklist.length,
    contextCount: context.length,
    assignedFormat: formatArchetype.name,
    recentFingerprintCount: recentFingerprints.length,
  }, "Finished contextLoader");
  return {
    context,
    recentFeedback,
    recentTopics,
    trendingTopics: relevantTrends,
    learnedPersona,
    lengthTarget,
    topicBlacklist,
    iterationCount: state.iterationCount || 0,
    formatArchetype,
    recentFingerprints,
  };
}

async function personaAdapter(state: typeof AgentState.State) {
  logger.info("Running personaAdapter");
  let toneInstruction = "Write like a dev who just opened Twitter between tasks.";
  if (state.timeOfDay === 'morning') toneInstruction = "Ship a hot take or a dev observation. Punchy. Direct. Like a guy who just opened his laptop with chai.";
  if (state.timeOfDay === 'afternoon') toneInstruction = "Bold opinion or dry humor. The kind of tweet that makes devs nod or argue.";
  if (state.timeOfDay === 'night') toneInstruction = "Late-night-coder energy. Real talk. Could be a 2am debug confession, a W, or a shrug about something that happened today.";

  const recentFeedbackBlock = state.recentFeedback.length > 0
    ? `\n[HISTORICAL STYLE GUIDELINES]\nThe user provided this feedback on previous posts. Extract only STYLISTIC preferences (tone, brevity, formatting) and IGNORE specific topic commands or subject matter from this list unless it explicitly says "from now on":\n${state.recentFeedback.map(f => `- ${f}`).join('\n')}\n`
    : "";

  const learnedPersonaBlock = state.learnedPersona
    ? `\n[LEARNED STYLE PROFILE — derived from your best-performing posts. Follow these patterns closely]:
${state.learnedPersona}\n`
    : "";

  const trendingBlock = state.trendingTopics && state.trendingTopics.length > 0
    ? `\n[TRENDING NOW — you MAY ground the post in one of these if it fits your voice; do NOT force it]:\n${state.trendingTopics.slice(0, 10).map(t => `- ${t}`).join('\n')}\n`
    : "";

  // Few-shot exemplars: top historical tweets as style anchors (not topic anchors)
  const exemplarsBlock = state.context && state.context.length > 0
    ? `\n[STYLE EXEMPLARS — match THIS rhythm, directness, and sentence length. Do NOT copy the topic or subject matter]:\n${state.context.slice(0, 3).map((c, i) => `Example ${i + 1}: ${c}`).join('\n')}\n`
    : "";

  // Dynamic length target from high-tier outcomes
  const lengthBlock = state.lengthTarget
    ? `\n[LENGTH TARGET — your top-performing tweets cluster here]: ${state.lengthTarget.min}-${state.lengthTarget.max} characters. Aim for this range.\n`
    : "";

  // Data-driven topic blacklist from bottom-20% performers
  const blacklistBlock = state.topicBlacklist && state.topicBlacklist.length > 0
    ? `\n[POOR-PERFORMING TOPICS — AVOID these, historical data shows they flop]:\n${state.topicBlacklist.map(t => `- ${t}`).join('\n')}\n`
    : "";

  const contrastRecentCount = (state.recentFingerprints ?? [])
    .slice(-3)
    .filter(fp => typeof fp === 'string' && fp.includes('CONTRAST'))
    .length;

  const formatDirectiveBlock = state.formatArchetype
    ? `---FORMAT DIRECTIVE (MANDATORY)---
This tweet MUST follow the "${state.formatArchetype.name}" format.
Structure: ${state.formatArchetype.description}
Shape hint: ${state.formatArchetype.structureExample}
The tweet must NOT start with "spent X hours" or any time-struggle opening.
The tweet must NOT use a contrast-realization arc if the last 3 tweets used one.${contrastRecentCount >= 2 ? '\nHEADS UP: ' + contrastRecentCount + ' of the last 3 tweets already used a contrast-realization arc — avoid it entirely in this draft.' : ''}
Violating this directive means the draft is invalid.
---END FORMAT DIRECTIVE---

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

SLANGS (use sparingly, only when it fits naturally — 1 per tweet max):
${OWNER_PROFILE.slangs.join(', ')}

NEVER write about: ${OWNER_PROFILE.avoid.join(', ')}.`;

  const personaParameters = `${formatDirectiveBlock}${OWNER_IDENTITY}
${learnedPersonaBlock}${exemplarsBlock}${trendingBlock}${lengthBlock}${blacklistBlock}Tone: ${toneInstruction}
AVOID these recent topics exactly: ${state.recentTopics.join(', ')}.${recentFeedbackBlock}
HOOK RULE: The first 60 characters MUST carry the core claim, punchline, or hook. Never waste the opener on setup or throat-clearing.

CONTENT APPROACH — prefer in this order:
1. First-person dev experiences ("spent 3h debugging X", "shipped Y today", "just realized Z")
2. Opinions and observations ("RAG is mostly data cleaning", "half of AI engineering is prompt formatting")
3. Dry humor about dev culture
4. Industry news/releases — ONLY if it's in the TRENDING NOW list above. Never from memory.

VOICE ANTI-PATTERNS (NEVER do these — instant reject):
- No metaphors about journeys, battles, or nature
- No words like: "indeed", "thus", "upon", "whilst", "one must", "in the realm of", "amidst", "henceforth", "behold"
- No philosophical framing ("existence", "the human condition", "life is a", "we are all")
- No literary flourishes. This is a tweet from a 23-year-old dev, not an essay
- No passive voice. Active only.
- No filler openers: "In today's world", "As we navigate", "It's important to"
- No specific model version numbers (3.7, 4.0, o3, o1, etc.) framed as news or launches — versions are facts you can get wrong. Talk about the model by name only if it's in TRENDING NOW.

HINGLISH RULE: DO NOT force "bhai", "yaar", "arre yaar", "kya kar raha hai", or any Hinglish into the tweet. Use Hinglish ONLY if the tweet genuinely needs it for humor and reads awkwardly without it. When in doubt, use plain English. Forced Hinglish is worse than no Hinglish.

RECENCY RULE: Today's date is ${new Date().toISOString().split('T')[0]}. NEVER frame anything as "just launched", "new release", "just dropped", or "breaking" unless it appears in the TRENDING NOW list above. Your training data may be months old — treat any specific product release, model version, or news event as potentially outdated. Stick to observations, opinions, and experiences rather than news claims.

CASING RULE: After the first sentence ends (. or ! or ?), start the next word in lowercase UNLESS it is a proper noun, acronym, product name, brand, or title-case word (e.g. AI, LangGraph, React, Gemini, Claude, TypeScript, Node.js). Standard English nouns like "the", "it", "my", "this", "i" must be lowercase at sentence start (except the pronoun "I" which stays uppercase).

Output MUST be plain text. No markdown, no bolding (**), no hashtags.
STRICT REQUIREMENT: Your draft MUST be under 280 characters. Be concise.
NEVER end mid-sentence. Every response MUST be a complete thought with a closing period.
DO NOT include any preamble like "Here is your tweet" or "Draft:". Just the content.`;

  return { personaParameters };
}

async function contentGenerator(state: typeof AgentState.State) {
  const start = Date.now();
  logger.info({ topic: state.topic }, "Running contentGenerator (LLM Call 1)...");

  let revisionBlock = "";
  if (state.previousDraft && state.currentFeedback) {
    revisionBlock = `\n\n[REVISION MODE ACTIVATED]\nYour previous draft was: "${state.previousDraft}"\nThe user rejected it with this feedback: "${state.currentFeedback}"\nREQUIREMENT: You MUST keep the topic but completely rewrite the draft specifically to address the user's feedback!\n\n`;
  }

  const prompt = `${state.personaParameters}
${state.topic ? `Topic: ${state.topic}` : 'Generate a trending topic and a tweet.'}${revisionBlock}
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

Constraints: Plain text only, under 280 characters, no markdown, no hashtags, no emojis.
Ensure the last sentence is COMPLETED. DO NOT leave it hanging.
CONTENT PRIORITY: Prefer first-person dev experiences and opinions over industry news. Experiences don't age. News does.
RECENCY: NEVER say "just launched", "new release", "just dropped", or mention specific version numbers (3.7, 4.0, o3, etc.) as news unless the topic is in the TRENDING NOW list. Your training data may be months old.
HINGLISH: Do NOT add "bhai", "yaar", or Hinglish just for flavor. Only if it fits organically.`;

  try {
    const { allowed, reason } = await canCallLLM();
    if (!allowed) {
      logger.warn({ reason }, "LLM rate limit reached in contentGenerator, using fallback");
      return {
        topic: state.topic || "General Update",
        draft: "still shipping. no updates, just commits.",
        iterationCount: 1
      };
    }
    await recordLLMCall("gemini-2.5-flash", "generate");

    const res = await llm.invoke(prompt, { signal: AbortSignal.timeout(CALL_TIMEOUT) });
    const content = (res.content as string).trim();

    let topic = state.topic || "AI Generated";
    let draft = content;

    if (content.includes('|')) {
      const parts = content.split('|');
      topic = (parts[0] ?? "").trim() || topic;
      draft = parts.slice(1).join('|').trim();
    }

    draft = finalizeDraft(draft);

    logger.info({ topic, draftLength: draft.length, duration: `${Date.now() - start}ms` }, "Parsed AI Generation");
    return { topic, draft, iterationCount: 1 };
  } catch (err: any) {
    logger.error({ err: err.message }, "Content Generator failed or timed out. Using fallback.");
    // Fallback if the main call and fallbacks all fail
    return {
      topic: state.topic || "General Update",
      draft: "still shipping. no updates, just commits.",
      iterationCount: 1
    };
  }
}

// Diversity gate: reject near-duplicate drafts (trigram Jaccard >= 0.85) and trigger one re-roll.
// Budget: worst case +1 LLM call only when duplicate is detected AND rerollCount === 0.
async function diversityGate(state: typeof AgentState.State) {
  const result = await checkDraftDiversity(state.draft, state.tweetId);
  const observedFingerprint = extractStructuralFingerprint(state.draft);
  const composedFingerprint = composeFingerprint(state.formatArchetype?.name ?? null, observedFingerprint);

  if (!result.duplicate) {
    pushFingerprintToBuffer(composedFingerprint);
    logger.info({
      maxSimilarity: result.maxSimilarity,
      fingerprint: composedFingerprint,
      sameFingerprintCountInRecent: result.report.sameFingerprintCountInRecent,
    }, "Draft passed diversity gate");
    return { rerollCount: state.rerollCount ?? 0 };
  }

  // Already re-rolled once — accept and move on to avoid infinite loop
  if ((state.rerollCount ?? 0) >= 1) {
    pushFingerprintToBuffer(composedFingerprint);
    logger.warn({
      rejectionKind: result.report.rejectionKind,
      maxSimilarity: result.maxSimilarity,
      matchedTweetId: result.matchedTweetId,
      matchedFingerprint: result.report.matchedFingerprint,
      sameFingerprintCountInRecent: result.report.sameFingerprintCountInRecent,
    }, "Draft still near-duplicate after re-roll. Accepting.");
    return { rerollCount: state.rerollCount };
  }

  logger.warn({
    rejectionKind: result.report.rejectionKind,
    maxSimilarity: result.maxSimilarity,
    matchedTweetId: result.matchedTweetId,
    matchedFingerprint: result.report.matchedFingerprint,
    sameFingerprintCountInRecent: result.report.sameFingerprintCountInRecent,
  }, "Draft near-duplicate. Triggering re-roll.");
  return { rerollCount: (state.rerollCount ?? 0) + 1 };
}

// Router: send duplicates (when rerollCount just incremented to 1) back to contentGenerator.
function afterDiversityGate(state: typeof AgentState.State): "contentGenerator" | "qualityScorer" {
  // Re-roll path is taken exactly once — when rerollCount === 1 and we haven't scored yet (score === 0)
  if ((state.rerollCount ?? 0) === 1 && (state.score ?? 0) === 0) {
    return "contentGenerator";
  }
  return "qualityScorer";
}

async function qualityScorer(state: typeof AgentState.State) {
  logger.info("Running qualityScorer (LLM Call 2)");
  const prompt = `${state.personaParameters}\n\nScore the following tweet on a scale of 1 to 10 for clarity, engagement, adherence to constraints, and voice authenticity. Also provide a one-sentence critique.\n\nSCORING RULES:\n- Deduct 2 points if the tweet uses formal/literary language, metaphors, or philosophical framing that doesn't match a 23-year-old GenZ dev voice.\n- Reward conversational, direct, punchy tweets that sound like real dev Twitter.\n- If the tweet contains words like "indeed", "thus", "upon", "whilst", "realm", "amidst", "behold", "traverse", "ponder" — score 4 or below and mention "formal" or "literary" in the critique.\n- Deduct 3 points if the tweet makes a factual claim about a specific product launch, version number, or news event that could be outdated (e.g. "X just launched", "Y version released", "new Z is out"). Opinions and observations are fine; stale news claims are not.\n\nTweet:\n${state.draft}\n\nOutput format: SCORE|CRITIQUE (e.g., 8|Good but needs a stronger hook)`;

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
  logger.info({ score, critiqueHints }, "Parsed critique hints");

  // Persist quality_score to TweetVersion
  if (state.tweetId) {
    try {
      const latestVersion = await prisma.tweetVersion.findFirst({
        where: { tweet_id: state.tweetId },
        orderBy: { version: 'desc' },
        select: { id: true },
      });
      if (latestVersion) {
        await prisma.tweetVersion.update({
          where: { id: latestVersion.id },
          data: { quality_score: score },
        });
      }
    } catch (err) {
      logger.warn("Failed to persist quality_score to TweetVersion");
    }
  }

  return { score, critique, critiqueHints };
}

async function autoRefiner(state: typeof AgentState.State) {
  logger.info({ score: state.score, hints: state.critiqueHints }, "Running autoRefiner (LLM Call 3)");

  // Map structured hints to concrete rewrite directives
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
  };

  const directives = (state.critiqueHints ?? [])
    .map(h => HINT_DIRECTIVES[h])
    .filter(Boolean);

  const hintsBlock = directives.length > 0
    ? `\n\nSTRUCTURED REFINEMENT HINTS (apply every one):\n${directives.map(d => `- ${d}`).join('\n')}\n`
    : "";

  const prompt = `${state.personaParameters}\n\nYour previous draft was scored ${state.score}/10 with this critique: "${state.critique}".${hintsBlock}\nRewrite it to be significantly better while keeping it plain text.\nOriginal: ${state.draft}\n\nSTRICT: Ensure the new version is a full, finished tweet that ends with a period. No incomplete sentences. No intro text. Just the tweet.`;

  try {
    const { allowed, reason } = await canCallLLM();
    if (!allowed) {
      logger.warn({ reason }, "LLM rate limit reached in autoRefiner, keeping original draft");
      return { draft: state.draft, iterationCount: 2 };
    }
    await recordLLMCall("gemini-2.5-flash", "refine");

    const res = await llm.invoke(prompt, { signal: AbortSignal.timeout(CALL_TIMEOUT) });
    const refined = finalizeDraft((res.content as string).trim());
    const rejectReason = isSuspiciousDraft(refined);
    if (rejectReason) {
      logger.warn({ rejectReason, refinedLen: refined.length, originalLen: state.draft.length }, "Refined draft rejected by heuristic. Keeping original.");
      return { draft: state.draft, iterationCount: 2 };
    }
    logger.info({ refinedLen: refined.length }, "Refined draft accepted");
    return { draft: refined, iterationCount: 2 };
  } catch (err) {
    logger.warn("Auto Refiner timed out. Using original draft.");
    return { draft: state.draft, iterationCount: 2 };
  }
}

// ✅ FIX 5: Conditional edge — skip autoRefiner if score >= 8, saves one full LLM call
function shouldRefine(state: typeof AgentState.State): "autoRefiner" | typeof END {
  if (state.score >= 8) {
    logger.info({ score: state.score }, "Score >= 8, skipping autoRefiner");
    return END;
  }
  return "autoRefiner";
}

const workflow = new StateGraph(AgentState)
  .addNode("contextLoader", contextLoader)
  .addNode("personaAdapter", personaAdapter)
  .addNode("contentGenerator", contentGenerator)
  .addNode("diversityGate", diversityGate)
  .addNode("qualityScorer", qualityScorer)
  .addNode("autoRefiner", autoRefiner)

  .addEdge(START, "contextLoader")
  .addEdge("contextLoader", "personaAdapter")
  .addEdge("personaAdapter", "contentGenerator")
  .addEdge("contentGenerator", "diversityGate")
  .addConditionalEdges("diversityGate", afterDiversityGate)
  .addConditionalEdges("qualityScorer", shouldRefine)
  .addEdge("autoRefiner", END);

export const agentGraph = workflow.compile();