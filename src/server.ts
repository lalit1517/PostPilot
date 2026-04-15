import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import { prisma } from './db.js';
import { logger } from './logger.js';
import { agentGraph } from './agent.js';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health Check Endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'PostPilot Agent'
  });
});

const HMAC_SECRET = process.env.HMAC_SECRET as string;
if (!HMAC_SECRET) {
  throw new Error("Missing HMAC_SECRET in environment variables");
}

function generateToken(id: string) {
  return crypto.createHmac('sha256', HMAC_SECRET).update(id).digest('hex');
}

function verifyToken(id: string, token: string) {
  try {
    const expected = generateToken(id);
    if (!token || expected.length !== token.length) return false;
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token));
  } catch (err) {
    return false;
  }
}

app.post('/api/generate', async (req, res) => {
  try {
    const { time_of_day = 'morning', topic } = req.body || {};
    logger.info({ time_of_day, topic }, 'Generate request received');

    const startAgent = Date.now();
    // Run LangGraph Agent
    const finalState = await agentGraph.invoke({
      timeOfDay: time_of_day,
      topic: topic,
      iterationCount: 0
    });
    logger.info({ agentDuration: `${Date.now() - startAgent}ms` }, 'Agent workflow completed');

    const tweetDraft = finalState.draft;
    const finalTopic = finalState.topic;

    // Create Base Tweet
    const tweet = await prisma.tweet.create({
      data: {
        original_topic: topic || finalTopic || "AI Generated",
        time_of_day,
        score: finalState.score || 0,
        status: 'PENDING',
        versions: {
          create: {
            content: tweetDraft,
            version: 1,
            critique: finalState.critique
          }
        }
      }
    });

    const approveToken = generateToken(tweet.id);
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
    
    // Generate Intent URL
    const encodedTweet = encodeURIComponent(tweetDraft);
    const intentUrl = `https://twitter.com/intent/tweet?text=${encodedTweet}`;
    
    // Update tweet with intent_url
    await prisma.tweet.update({
      where: { id: tweet.id },
      data: { intent_url: intentUrl }
    });

    res.json({
      success: true,
      tweet_id: tweet.id,
      draft: tweetDraft,
      time_of_day,
      score: tweet.score,
      intentUrl,
      editUrl: `${baseUrl}/api/view-edit?id=${tweet.id}&token=${approveToken}`,
      feedbackUrl: `${baseUrl}/api/view-feedback?id=${tweet.id}&token=${approveToken}`,
      token: approveToken
    });
  } catch (err: any) {
    logger.error({ err: err.message, stack: err.stack }, 'Failed to generate tweet');
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/telegram/webhook', async (req, res) => {
  const { callback_query, message } = req.body;
  
  // Basic validation (Telegram sends bot token in the URL if set up that way,
  // but for simplicity we rely on ID/Token inside callback_data)
  
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

    if (action === 'posted_confirmed') {
      await prisma.tweet.update({
        where: { id: tweetId },
        data: { 
          status: 'POSTED_CONFIRMED',
          posted: true,
          posted_at: new Date()
        }
      });
      
      await sendTelegramMessage(chatId, `✅ Marked as Posted!\nTweet ID: \`${tweetId}\``);
    } else if (action === 'copy_tweet') {
      const content = tweet.versions[0]?.content || "No content found";
      await sendTelegramMessage(chatId, `📋 **Copy & Paste this:**\n\n\`${content}\``);
    }

    // Answer callback to remove loading state in Telegram
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callback_query.id })
    });
  }

  res.sendStatus(200);
});

async function sendTelegramMessage(chatId: number | string, text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: 'Markdown'
    })
  });
}

app.post('/api/edit', async (req, res) => {
  const { id, new_topic, token } = req.body;
  if (!verifyToken(id, token)) return res.status(403).json({ error: "Unauthorized" });

  await prisma.tweet.update({
    where: { id },
    data: { edited_topic: new_topic }
  });

  logger.info({ tweet_id: id, new_topic }, 'Topic edited, requesting regeneration');
  // Trigger regeneration flow here or return success and let client requery
  res.json({ success: true, message: "Topic updated. Regenerate draft to apply effects." });
});

app.post('/api/feedback', async (req, res) => {
  const { id, feedback, token } = req.body;
  if (!verifyToken(id, token)) return res.status(403).json({ error: "Unauthorized" });

  await prisma.feedback.create({
    data: {
      tweet_id: id,
      feedback_text: feedback
    }
  });

  logger.info({ tweet_id: id }, 'Feedback received');
  res.json({ success: true });
});

app.post('/api/retries/process', async (req, res) => {
  logger.info("Processing generic retry queue (X API posting disabled)");
  // This can be repurposed for email retries or other background tasks
  res.json({ success: true, processed: 0 });
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 [STARTUP] Server is live on port ${PORT}`);
  console.log(`📍 [URL] ${process.env.BASE_URL || 'http://localhost:3000'}`);
  
  if (!process.env.BASE_URL) {
    console.warn(`⚠️ [WARNING] BASE_URL is NOT set. Links will default to localhost.`);
  } else {
    console.log(`✅ [CONFIG] BASE_URL is set to: ${process.env.BASE_URL}`);
  }

  logger.info({ PORT, BASE_URL: process.env.BASE_URL }, "Server started with diagnostics");
});

// Prevent silent exit in some environments
process.on('uncaughtException', (err) => {
  logger.error({ err: err.message, stack: err.stack }, 'Uncaught Exception');
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason }, 'Unhandled Rejection');
});
