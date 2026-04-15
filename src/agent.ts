import 'dotenv/config';
import { StateGraph, START, END, Annotation } from "@langchain/langgraph";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { prisma } from "./db.js";
import { logger } from "./logger.js";

/* ---------------- STATE ---------------- */

const AgentState = Annotation.Root({
  topic: Annotation<string>({ reducer: (x, y) => y ?? x, default: () => "" }),
  timeOfDay: Annotation<string>({ reducer: (x, y) => y ?? x, default: () => "morning" }),
  context: Annotation<string[]>({ reducer: (x, y) => y ?? x, default: () => [] }),
  recentFeedback: Annotation<string[]>({ reducer: (x, y) => y ?? x, default: () => [] }),
  recentTopics: Annotation<string[]>({ reducer: (x, y) => y ?? x, default: () => [] }),
  personaParameters: Annotation<string>({ reducer: (x, y) => y ?? x, default: () => "" }),
  draft: Annotation<string>({ reducer: (x, y) => y ?? x, default: () => "" }),
  score: Annotation<number>({ reducer: (x, y) => y ?? x, default: () => 0 }),
  critique: Annotation<string>({ reducer: (x, y) => y ?? x, default: () => "" }),
  iterationCount: Annotation<number>({ reducer: (x, y) => y ?? x, default: () => 0 }),
  deadline: Annotation<number>({
    reducer: (x, y) => y ?? x,
    default: () => 0
  }),
});

/* ---------------- CONFIG ---------------- */

// 🔥 TOTAL TIME BUDGET (IMPORTANT)
const TOTAL_TIMEOUT = 50_000;

// LLM config
const baseConfig = {
  apiKey: process.env.GOOGLE_API_KEY as string,
  temperature: 1.1,
  maxOutputTokens: 250,
};

// ✅ Fallback chain (kept as you wanted)
const llm = new ChatGoogleGenerativeAI({
  ...baseConfig,
  model: "gemini-3.1-flash-lite-preview",
}).withFallbacks([
  new ChatGoogleGenerativeAI({
    ...baseConfig,
    model: "gemini-3-flash-preview",
  }),
  new ChatGoogleGenerativeAI({
    ...baseConfig,
    model: "gemini-2.5-flash",
  }),
]);

/* ---------------- TIME HELPER ---------------- */

function getRemainingTime(state: typeof AgentState.State) {
  return Math.max(0, state.deadline - Date.now());
}

/* ---------------- NODES ---------------- */

async function contextLoader(state: typeof AgentState.State) {
  logger.info("Running contextLoader...");

  const [topTweetsQuery, recentFeedbackQuery, recentTopicsQuery] = await Promise.all([
    prisma.engagement.findMany({
      orderBy: { likes: 'desc' },
      take: 5,
      include: { tweet: { include: { versions: { orderBy: { version: 'desc' }, take: 1 } } } }
    }),
    prisma.feedback.findMany({
      orderBy: { created_at: 'desc' },
      take: 5
    }),
    prisma.tweet.findMany({
      orderBy: { created_at: 'desc' },
      take: 10,
      select: { original_topic: true, edited_topic: true }
    })
  ]);

  return {
    context: topTweetsQuery.map(t => t.tweet.versions[0]?.content).filter(Boolean),
    recentFeedback: recentFeedbackQuery.map(f => f.feedback_text),
    recentTopics: recentTopicsQuery.map(t => t.edited_topic || t.original_topic),
  };
}

async function personaAdapter(state: typeof AgentState.State) {
  let toneInstruction = "Be insightful.";
  if (state.timeOfDay === 'morning')
    toneInstruction = "Deep, valuable insight. Intellectual but concise.";
  if (state.timeOfDay === 'afternoon')
    toneInstruction = "Bold, punchy, hot take.";
  if (state.timeOfDay === 'night')
    toneInstruction = "Personal, reflective storytelling.";

  return {
    personaParameters: `You are a builder crafting content for X.
Tone: ${toneInstruction}
Avoid topics: ${state.recentTopics.join(', ')}
Apply feedback: ${state.recentFeedback.join('; ')}

Rules:
- Under 280 characters
- No emojis
- No hashtags
- Plain text only`
  };
}

/* ---------------- LLM STEPS (TIME-SAFE) ---------------- */

async function contentGenerator(state: typeof AgentState.State) {
  const remaining = getRemainingTime(state);

  if (remaining < 5000) {
    return {
      topic: "Fallback",
      draft: "Consistency compounds. Show up daily.",
      iterationCount: 1
    };
  }

  try {
    const res = await llm.invoke(
      `${state.personaParameters}\nGenerate: TOPIC|TWEET`,
      { signal: AbortSignal.timeout(Math.min(remaining, 20000)) }
    );

    const [topic, draft] = (res.content as string).split('|');

    return {
      topic: topic || "AI",
      draft: draft || res.content,
      iterationCount: 1
    };

  } catch {
    return {
      topic: "Fallback",
      draft: "Most people wait. Builders start.",
      iterationCount: 1
    };
  }
}

async function qualityScorer(state: typeof AgentState.State) {
  const remaining = getRemainingTime(state);

  if (remaining < 5000) {
    return { score: 6, critique: "Skipped due to time" };
  }

  try {
    const res = await llm.invoke(
      `Score this tweet:\n${state.draft}\nReturn: SCORE|CRITIQUE`,
      { signal: AbortSignal.timeout(Math.min(remaining, 15000)) }
    );

    const [score, critique] = (res.content as string).split('|');

    return {
      score: Number(score) || 6,
      critique: critique || ""
    };

  } catch {
    return { score: 6, critique: "Fallback scoring" };
  }
}

async function autoRefiner(state: typeof AgentState.State) {
  const remaining = getRemainingTime(state);

  if (remaining < 7000) {
    return { draft: state.draft };
  }

  try {
    const res = await llm.invoke(
      `Improve this tweet:\n${state.draft}`,
      { signal: AbortSignal.timeout(Math.min(remaining, 15000)) }
    );

    return { draft: res.content as string };

  } catch {
    return { draft: state.draft };
  }
}

/* ---------------- FLOW CONTROL ---------------- */

function shouldRefine(state: typeof AgentState.State): "autoRefiner" | typeof END {
  if (state.score >= 8) return END;
  return "autoRefiner";
}

/* ---------------- WORKFLOW ---------------- */

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
  .addConditionalEdges("qualityScorer", shouldRefine)
  .addEdge("autoRefiner", END);

export const agentGraph = workflow.compile();

/* ---------------- HELPER EXPORT ---------------- */

export function getAgentDeadline() {
  return Date.now() + TOTAL_TIMEOUT;
}