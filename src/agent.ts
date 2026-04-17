import 'dotenv/config';
import { StateGraph, START, END, Annotation } from "@langchain/langgraph";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { prisma } from "./db.js";
import { logger } from "./logger.js";
import { canCallLLM, recordLLMCall } from "./rateGuard.js";
import { getTrendingTopics } from "./trends.js";

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
  previousDraft: Annotation<string>({ reducer: (x, y) => y ?? x, default: () => "" }),
  currentFeedback: Annotation<string>({ reducer: (x, y) => y ?? x, default: () => "" }),
  iterationCount: Annotation<number>({ reducer: (x, y) => y ?? x, default: () => 0 }),
});

// ✅ FIX 1: Temperature lowered to 1.3 (safe, still creative)
// ✅ FIX 2: Increased timeout signal to 90s per call
const baseConfig = {
  apiKey: process.env.GOOGLE_API_KEY as string,
  temperature: 0.7,
  maxOutputTokens: 1024,
  topP: 0.9,
  maxRetries: 5,
};

const CALL_TIMEOUT = 120_000;

// Disable Gemini 2.5 thinking so full output budget goes to actual content (prevents mid-sentence truncation)
const THINKING_OFF = { thinkingConfig: { thinkingBudget: 0 } } as const;

export const llm = new ChatGoogleGenerativeAI({
  ...baseConfig,
  model: "gemini-2.5-flash",
  ...THINKING_OFF,
}).withFallbacks([
  new ChatGoogleGenerativeAI({
    ...baseConfig,
    model: "gemini-3-flash-preview",
  }),
  new ChatGoogleGenerativeAI({
    ...baseConfig,
    model: "gemini-3.1-flash-lite-preview",
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

async function contextLoader(state: typeof AgentState.State) {
  const start = Date.now();
  logger.info("Running contextLoader...");

  const [topTweetsQuery, weightedFeedbackQuery, unweightedFeedbackQuery, recentTopicsQuery, activeProfile, trendingTopics] = await Promise.all([
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
    getTrendingTopics()
  ]);

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

  logger.info({ duration: `${Date.now() - start}ms`, hasPersona: !!learnedPersona, trendCount: trendingTopics.length }, "Finished contextLoader");
  return { context, recentFeedback, recentTopics, trendingTopics, learnedPersona, iterationCount: state.iterationCount || 0 };
}

async function personaAdapter(state: typeof AgentState.State) {
  logger.info("Running personaAdapter");
  let toneInstruction = "Be insightful.";
  if (state.timeOfDay === 'morning') toneInstruction = "Create content that delivers a deep, valuable insight. Be intellectual but concise.";
  if (state.timeOfDay === 'afternoon') toneInstruction = "Make the content bold, punchy, or a strong hot take to spark conversation.";
  if (state.timeOfDay === 'night') toneInstruction = "Adopt a personal, reflective, or storytelling tone suitable for winding down the day.";

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

  const personaParameters = `You are a builder crafting content for X.
${learnedPersonaBlock}${trendingBlock}Tone: ${toneInstruction}
AVOID these recent topics exactly: ${state.recentTopics.join(', ')}.${recentFeedbackBlock}
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
Example: AI Ethics|Why we need to talk about data bias. We must act now.

Constraints: Plain text only, under 280 characters, no markdown, no hashtags, no emojis. 
Ensure the last sentence is COMPLETED. DO NOT leave it hanging.`;

  try {
    const { allowed, reason } = await canCallLLM();
    if (!allowed) {
      logger.warn({ reason }, "LLM rate limit reached in contentGenerator, using fallback");
      return {
        topic: state.topic || "General Update",
        draft: "Consistently building and shipping every day. Progress is the only metric that matters.",
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
      draft: "Consistently building and shipping every day. Progress is the only metric that matters.",
      iterationCount: 1
    };
  }
}

async function qualityScorer(state: typeof AgentState.State) {
  logger.info("Running qualityScorer (LLM Call 2)");
  const prompt = `${state.personaParameters}\n\nScore the following tweet on a scale of 1 to 10 for clarity, engagement, and adherence to constraints. Also provide a one-sentence critique.\nTweet:\n${state.draft}\n\nOutput format: SCORE|CRITIQUE (e.g., 8|Good but needs a stronger hook)`;

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

  return { score, critique };
}

async function autoRefiner(state: typeof AgentState.State) {
  logger.info({ score: state.score }, "Running autoRefiner (LLM Call 3)");
  const prompt = `${state.personaParameters}\n\nYour previous draft was scored ${state.score}/10 with this critique: "${state.critique}".\nRewrite it to be significantly better while keeping it plain text.\nOriginal: ${state.draft}\n\nSTRICT: Ensure the new version is a full, finished tweet that ends with a period. No incomplete sentences. No intro text. Just the tweet.`;

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
  .addNode("qualityScorer", qualityScorer)
  .addNode("autoRefiner", autoRefiner)

  .addEdge(START, "contextLoader")
  .addEdge("contextLoader", "personaAdapter")
  .addEdge("personaAdapter", "contentGenerator")
  .addEdge("contentGenerator", "qualityScorer")
  .addConditionalEdges("qualityScorer", shouldRefine) // ✅ Conditional skip
  .addEdge("autoRefiner", END);

export const agentGraph = workflow.compile();