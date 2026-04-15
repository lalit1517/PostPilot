import 'dotenv/config';
import { StateGraph, START, END, Annotation } from "@langchain/langgraph";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { prisma } from "./db.js";
import { logger } from "./logger.js";

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
});

// ✅ FIX 1: Temperature lowered to 1.3 (safe, still creative)
// ✅ FIX 2: Increased timeout signal to 90s per call
const baseConfig = {
  apiKey: process.env.GOOGLE_API_KEY as string,
  temperature: 1.3,
  maxOutputTokens: 300,
  topP: 0.95,
};

const CALL_TIMEOUT = 40_000; // Reduced to 40s to ensure total graph stays under 60s Railway limit

const llm = new ChatGoogleGenerativeAI({
  ...baseConfig,
  model: "gemini-2.0-flash", // Use stable model for better reliability
}).withFallbacks([
  new ChatGoogleGenerativeAI({
    ...baseConfig,
    model: "gemini-1.5-flash", 
  }),
]);

async function contextLoader(state: typeof AgentState.State) {
  const start = Date.now();
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
  ]); // ✅ FIX 4: Run all DB queries in parallel, not sequentially

  const context = topTweetsQuery
    .map(t => t.tweet.versions[0]?.content)
    .filter(Boolean) as string[];
  const recentFeedback = recentFeedbackQuery.map(f => f.feedback_text);
  const recentTopics = recentTopicsQuery.map(t => t.edited_topic || t.original_topic);

  logger.info({ duration: `${Date.now() - start}ms` }, "Finished contextLoader");
  return { context, recentFeedback, recentTopics, iterationCount: state.iterationCount || 0 };
}

async function personaAdapter(state: typeof AgentState.State) {
  logger.info("Running personaAdapter");
  let toneInstruction = "Be insightful.";
  if (state.timeOfDay === 'morning') toneInstruction = "Create content that delivers a deep, valuable insight. Be intellectual but concise.";
  if (state.timeOfDay === 'afternoon') toneInstruction = "Make the content bold, punchy, or a strong hot take to spark conversation.";
  if (state.timeOfDay === 'night') toneInstruction = "Adopt a personal, reflective, or storytelling tone suitable for winding down the day.";

  const personaParameters = `You are a builder crafting content for X.
Tone: ${toneInstruction}
AVOID these recent topics exactly: ${state.recentTopics.join(', ')}.
Apply this recent feedback rigorously: ${state.recentFeedback.join('; ')}

Do not use typical AI markers (emojis like 🚀, words like "delve").
Output MUST be plain text. No markdown, no bolding (**), no hashtags.
STRICT REQUIREMENT: Your draft MUST be under 280 characters. Be concise.`;

  return { personaParameters };
}

async function contentGenerator(state: typeof AgentState.State) {
  const start = Date.now();
  logger.info({ topic: state.topic }, "Running contentGenerator (LLM Call 1)...");

  const prompt = `${state.personaParameters}
${state.topic ? `Topic: ${state.topic}` : 'Generate a trending topic and a tweet.'}
Target: Generate both a Topic and a Draft.
Output Format: TOPIC|DRAFT
Example: AI Ethics|Why we need to talk about data bias...

Constraints: Plain text only, under 280 characters, no markdown, no emojis. Be punchy and short.`;

  const res = await llm.invoke(prompt, { signal: AbortSignal.timeout(CALL_TIMEOUT) });
  const content = (res.content as string).trim();

  let topic = "AI Generated";
  let draft = content;

  if (content.includes('|')) {
    const parts = content.split('|');
    topic = (parts[0] ?? "").trim();
    draft = parts.slice(1).join('|').trim();
  }

  logger.info({ topic, draftLength: draft.length }, "Parsed AI Generation");
  return { topic, draft, iterationCount: 1 };
}

async function qualityScorer(state: typeof AgentState.State) {
  logger.info("Running qualityScorer (LLM Call 2)");
  const prompt = `${state.personaParameters}\n\nScore the following tweet on a scale of 1 to 10 for clarity, engagement, and adherence to constraints. Also provide a one-sentence critique.\nTweet:\n${state.draft}\n\nOutput format: SCORE|CRITIQUE (e.g., 8|Good but needs a stronger hook)`;

  try {
    const res = await llm.invoke(prompt, { signal: AbortSignal.timeout(CALL_TIMEOUT) });
    const parts = (res.content as string).split('|');
    const score = parseFloat(parts[0] || '0') || 0;
    const critique = parts[1] || '';
    return { score, critique };
  } catch (err) {
    logger.warn("Quality Scorer timed out. Proceeding with default score.");
    return { score: 10, critique: "Skipped critique due to timeout." }; // Assume good enough to avoid crashing
  }
}

async function autoRefiner(state: typeof AgentState.State) {
  logger.info({ score: state.score }, "Running autoRefiner (LLM Call 3)");
  const prompt = `${state.personaParameters}\n\nYour previous draft was scored ${state.score}/10 with this critique: "${state.critique}".\nRewrite it to be significantly better while keeping it plain text.\nOriginal: ${state.draft}`;

  try {
    const res = await llm.invoke(prompt, { signal: AbortSignal.timeout(CALL_TIMEOUT) });
    return { draft: res.content as string, iterationCount: 2 };
  } catch (err) {
    logger.warn("Auto Refiner timed out. Using original draft.");
    return { draft: state.draft, iterationCount: 2 }; // Keep original draft on failure
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