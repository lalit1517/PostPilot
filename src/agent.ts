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

// Config for all models 
const baseConfig = {
  apiKey: process.env.GOOGLE_API_KEY as string,
  temperature: 1.8,
  maxOutputTokens: 300,
  topP: 0.95,
};

// Initialize the primary model with fallbacks
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

async function contextLoader(state: typeof AgentState.State) {
  logger.info("Running contextLoader");
  const topTweetsQuery = await prisma.engagement.findMany({
    orderBy: { likes: 'desc' },
    take: 5,
    include: { tweet: { include: { versions: { orderBy: { version: 'desc' }, take: 1 } } } }
  });
  const context = topTweetsQuery.map(t => t.tweet.versions[0]?.content).filter(Boolean) as string[];

  const recentFeedbackQuery = await prisma.feedback.findMany({
    orderBy: { created_at: 'desc' },
    take: 5
  });
  const recentFeedback = recentFeedbackQuery.map(f => f.feedback_text);

  const recentTopicsQuery = await prisma.tweet.findMany({
    orderBy: { created_at: 'desc' },
    take: 10,
    select: { original_topic: true, edited_topic: true }
  });
  const recentTopics = recentTopicsQuery.map(t => t.edited_topic || t.original_topic);

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
Output MUST be plain text. No markdown, no bolding (**), no hashtags.`;

  return { personaParameters };
}

async function contentGenerator(state: typeof AgentState.State) {
  logger.info({ topic: state.topic }, "Running contentGenerator (LLM Call 1)");
  
  const prompt = `${state.personaParameters}
${state.topic ? `Topic: ${state.topic}` : 'Generate a trending topic and a tweet.'}
Target: Generate both a Topic and a Draft.
Output Format: TOPIC|DRAFT
Example: AI Ethics|Why we need to talk about data bias...

Constraints: Plain text only, no markdown, no emojis.`;

  const res = await llm.invoke(prompt);
  const parts = (res.content as string).split('|');
  const topic = (parts[0] || 'Topic').trim();
  const draft = parts.slice(1).join('|').trim();
  
  return { topic, draft, iterationCount: 1 };
}

async function qualityScorer(state: typeof AgentState.State) {
  logger.info("Running qualityScorer (LLM Call 2)");
  const prompt = `${state.personaParameters}\n\nScore the following tweet on a scale of 1 to 10 for clarity, engagement, and adherence to constraints. Also provide a one-sentence critique.\nTweet:\n${state.draft}\n\nOutput format: SCORE|CRITIQUE (e.g., 8|Good but needs a stronger hook)`;
  
  const res = await llm.invoke(prompt);
  const parts = (res.content as string).split('|');
  const score = parseFloat(parts[0] || '0') || 0;
  const critique = parts[1] || '';
  
  return { score, critique };
}

async function autoRefiner(state: typeof AgentState.State) {
  // Only runs if score is low. Max calls for init gen = 3.
  if (state.score >= 8) return { draft: state.draft };

  logger.info({ score: state.score }, "Running autoRefiner (LLM Call 3)");
  const prompt = `${state.personaParameters}\n\nYour previous draft was scored ${state.score}/10 with this critique: "${state.critique}".\nRewrite it to be significantly better while keeping it plain text.\nOriginal: ${state.draft}`;
  
  const res = await llm.invoke(prompt);
  return { draft: res.content as string, iterationCount: 2 };
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
  .addEdge("qualityScorer", "autoRefiner")
  .addEdge("autoRefiner", END);

export const agentGraph = workflow.compile();
