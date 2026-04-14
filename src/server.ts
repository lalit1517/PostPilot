import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import { prisma } from './db.js';
import { logger } from './logger.js';
import { postToX } from './x-api.js';
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

    // Run LangGraph Agent
    const finalState = await agentGraph.invoke({
      timeOfDay: time_of_day,
      topic: topic,
      iterationCount: 0
    });

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
    const approveUrl = `${process.env.BASE_URL || 'http://localhost:3000'}/api/confirm-approve?id=${tweet.id}&token=${approveToken}`;

    res.json({
      success: true,
      tweet_id: tweet.id,
      draft: tweetDraft,
      approveUrl,
    });
  } catch (err: any) {
    logger.error({ err: err.message, stack: err.stack }, 'Failed to generate tweet');
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/confirm-approve', (req, res) => {
  const { id, token } = req.query as { id: string; token: string };
  if (!id || !token || !verifyToken(id, token)) {
    return res.status(403).send('Invalid or expired link.');
  }

  res.send(`
    <html>
    <head>
      <title>Confirm X Post</title>
      <style>body { font-family: sans-serif; padding: 40px; text-align: center; background: #fdfdfd; }</style>
    </head>
    <body>
      <h2>Are you sure you want to approve this post?</h2>
      <p>This action will immediately post the drafted content to X.</p>
      <form action="/api/approve" method="POST">
        <input type="hidden" name="id" value="${id}" />
        <input type="hidden" name="token" value="${token}" />
        <button type="submit" style="padding: 15px 30px; font-size: 16px; background: #1DA1F2; color: white; border: none; border-radius: 8px; cursor: pointer;">
          Yes, Post to X
        </button>
      </form>
    </body>
    </html>
  `);
});

app.post('/api/approve', async (req, res) => {
  const { id, token } = req.body;
  if (!verifyToken(id, token)) return res.status(403).json({ error: "Unauthorized" });

  const tweet = await prisma.tweet.findUnique({ where: { id } });
  if (!tweet) return res.status(404).json({ error: "Tweet not found" });

  // Idempotency check
  if (tweet.posted || tweet.status === 'POSTED') {
    logger.warn({ tweet_id: id }, 'Duplicate post attempt prevented');
    return res.json({ message: "Tweet already posted." });
  }

  const latestVersion = await prisma.tweetVersion.findFirst({
    where: { tweet_id: id },
    orderBy: { version: 'desc' }
  });

  if (!latestVersion) return res.status(500).json({ error: "Draft content missing" });

  try {
    const xId = await postToX(latestVersion.content);
    await prisma.tweet.update({
      where: { id },
      data: { posted: true, x_tweet_id: xId, status: 'POSTED' }
    });
    res.json({ success: true, url: `https://x.com/user/status/${xId}` });
  } catch (error: any) {
    logger.error({ tweet_id: id, err: error.message }, 'Failed to post directly, moving to retry queue');
    
    await prisma.retryQueue.create({
      data: {
        task_type: 'POST_TO_X',
        payload: { tweet_id: id, content: latestVersion.content }
      }
    });

    await prisma.tweet.update({
      where: { id },
      data: { status: 'ERROR' }
    });

    res.status(500).json({ error: "X API failure. Queued for background retry." });
  }
});

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
  logger.info("Processing retry queue");
  const pendingTasks = await prisma.retryQueue.findMany({
    where: { status: 'PENDING', attempts: { lt: 3 } },
    take: 10
  });

  for (const task of pendingTasks) {
    if (task.task_type === 'POST_TO_X') {
      const payload: any = task.payload;
      try {
        const xId = await postToX(payload.content);
        await prisma.retryQueue.update({
          where: { id: task.id },
          data: { status: 'COMPLETED' }
        });
        await prisma.tweet.update({
          where: { id: payload.tweet_id },
          data: { posted: true, x_tweet_id: xId, status: 'POSTED' }
        });
      } catch (err: any) {
        await prisma.retryQueue.update({
          where: { id: task.id },
          data: { 
            attempts: task.attempts + 1,
            last_error: err.message,
            status: task.attempts + 1 >= task.max_retries ? 'FAILED' : 'PENDING'
          }
        });
      }
    }
  }

  res.json({ success: true, processed: pendingTasks.length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 [STARTUP] Server is live on port ${PORT}`);
  console.log(`📍 [URL] https://postpilot-production-c051.up.railway.app/`);
  logger.info(`Server started on port ${PORT}`);
});

// Prevent silent exit in some environments
process.on('uncaughtException', (err) => {
  logger.error({ err: err.message, stack: err.stack }, 'Uncaught Exception');
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason }, 'Unhandled Rejection');
});
