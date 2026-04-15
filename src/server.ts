import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import { prisma } from './db.js';
import { logger } from './logger.js';
import { agentGraph } from './agent.js';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ---------------- HEALTH ---------------- */

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'PostPilot Agent'
  });
});

/* ---------------- SECURITY ---------------- */

const HMAC_SECRET = process.env.HMAC_SECRET as string;
if (!HMAC_SECRET) {
  throw new Error("Missing HMAC_SECRET in environment variables");
}

function generateToken(id: string) {
  return crypto.createHmac('sha256', HMAC_SECRET).update(id).digest('hex');
}

function verifyToken(id: string, token: string) {
  try {
    if (!token) return false;
    const expected = generateToken(id).substring(0, token.length);
    if (token.length < 16 || expected.length !== token.length) return false;
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token));
  } catch {
    return false;
  }
}

/* ---------------- GENERATE (FIXED) ---------------- */

app.post('/api/generate', async (req, res) => {
  try {
    const { time_of_day = 'morning', topic } = req.body || {};

    logger.info({ time_of_day, topic }, 'Generate request received');

    // ✅ CREATE JOB (DB)
    const tweet = await prisma.tweet.create({
      data: {
        original_topic: topic || "Processing",
        time_of_day,
        status: 'PROCESSING',
      }
    });

    // ✅ INSTANT RESPONSE
    res.json({
      success: true,
      jobId: tweet.id,
      status: 'PROCESSING'
    });

    // ✅ BACKGROUND EXECUTION
    setImmediate(() => {
      runAgent(tweet.id, time_of_day, topic)
        .catch(err => logger.error("Background job crash", err));
    });

  } catch (err: any) {
    logger.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/status', async (req, res) => {
  try {
    const { id } = req.query;

    const tweet = await prisma.tweet.findUnique({
      where: { id: String(id) },
      include: {
        versions: {
          orderBy: { version: 'desc' },
          take: 1
        }
      }
    });

    if (!tweet) {
      return res.status(404).json({ error: "Not found" });
    }

    res.json({
      status: tweet.status,
      tweet_id: tweet.id,
      draft: tweet.versions[0]?.content || null,
      score: tweet.score,
      intentUrl: tweet.intent_url
    });

  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/* ---------------- TELEGRAM ---------------- */

app.post('/api/telegram/webhook', async (req, res) => {
  const { callback_query } = req.body;

  if (callback_query) {
    const chatId = callback_query.message.chat.id;
    const [action, tweetId, token] = (callback_query.data || "").split(':');

    if (!tweetId || !token || !verifyToken(tweetId, token)) {
      return res.status(403).json({ error: "Invalid token" });
    }

    const tweet = await prisma.tweet.findUnique({
      where: { id: tweetId },
      include: { versions: { orderBy: { version: 'desc' }, take: 1 } }
    });

    if (!tweet) return res.status(404).json({ error: "Tweet not found" });

    if (action === 'pc' || action === 'posted_confirmed') {
      await prisma.tweet.update({
        where: { id: tweetId },
        data: {
          status: 'POSTED_CONFIRMED',
          posted: true,
          posted_at: new Date()
        }
      });

      await sendTelegramMessage(chatId, `Marked as Posted. Tweet ID: ${tweetId}`);
    }

    if (action === 'ct' || action === 'copy_tweet') {
      const content = tweet.versions[0]?.content || "No content found";
      await sendTelegramMessage(chatId, content);
    }

    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callback_query.id })
    });
  }

  res.sendStatus(200);
});

/* ---------------- TELEGRAM HELPER ---------------- */

async function sendTelegramMessage(chatId: number | string, text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
    })
  });
}

/* ---------------- EDIT ---------------- */

app.post('/api/edit', async (req, res) => {
  const { id, new_topic, token } = req.body;

  if (!verifyToken(id, token)) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  await prisma.tweet.update({
    where: { id },
    data: { edited_topic: new_topic }
  });

  res.json({ success: true });
});

/* ---------------- FEEDBACK ---------------- */

app.post('/api/feedback', async (req, res) => {
  const { id, feedback, token } = req.body;

  if (!verifyToken(id, token)) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  await prisma.feedback.create({
    data: {
      tweet_id: id,
      feedback_text: feedback
    }
  });

  res.json({ success: true });
});

/* ---------------- RETRIES ---------------- */

app.post('/api/retries/process', async (req, res) => {
  logger.info("Processing retry queue");
  res.json({ success: true, processed: 0 });
});

async function runAgent(id: string, timeOfDay: string, topic?: string) {
  try {
    logger.info(`Starting job ${id}`);

    const result: any = await agentGraph.invoke({
      timeOfDay,
      topic: topic ?? "",
      iterationCount: 0,
      deadline: Date.now() + 50000
    });

    // ✅ ADD THIS LINE HERE
    logger.info({ result }, "Agent output");

    // (optional but useful)
    logger.info({ draft: result?.draft, score: result?.score }, "Parsed output");

    // ✅ SAFETY GUARD
    if (!result || !result.draft) {
      throw new Error("Agent returned empty result");
    }

    const tweetDraft = result?.draft || "Fallback: Keep building.";
    const finalTopic = result?.topic || "AI Generated";

    const encodedTweet = encodeURIComponent(tweetDraft);
    const intentUrl = `https://twitter.com/intent/tweet?text=${encodedTweet}`;

    await prisma.tweet.update({
      where: { id },
      data: {
        original_topic: topic || finalTopic || "AI Generated",
        score: result.score || 0,
        status: 'PENDING',
        intent_url: intentUrl,
        versions: {
          create: {
            content: tweetDraft,
            version: 1,
            critique: result.critique || ""
          }
        }
      }
    });

    logger.info(`Job ${id} completed`);

  } catch (err: any) {
    logger.error({
      message: "Job failed",
      error: err?.message,
      stack: err?.stack
    });

    await prisma.tweet.update({
      where: { id },
      data: {
        status: 'ERROR'
      }
    });
  }
}

/* ---------------- START SERVER ---------------- */

const PORT = Number(process.env.PORT) || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  logger.info({ PORT }, "Server started");
});

/* ---------------- SAFETY ---------------- */

process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Uncaught Exception');
});

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled Rejection');
});