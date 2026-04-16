import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import { prisma } from './db.js';
import { logger } from './logger.js';
import { agentGraph } from './agent.js';
import { generateFingerprint, appendFingerprint } from './fingerprint.js';
import { runWorker, enqueueRetry } from './worker.js';

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

const CALL_TIMEOUT = 300_000; // Increased to 5 minutes for stable generation

function escapeHTML(str: string) {
  return str.replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function verifyToken(id: string, token: string) {
  try {
    if (!token) return false;
    const expected = generateToken(id).substring(0, token.length);
    if (token.length < 8 || expected.length !== token.length) return false;
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token));
  } catch (err) {
    return false;
  }
}

// Add helper for background processing
async function processGenerationInBackground(tweetId: string, time_of_day: string, topic?: string, callbackUrl?: string, previousDraft?: string, currentFeedback?: string) {
  try {
    const startAgent = Date.now();
    logger.info({ tweetId }, 'Starting background generation...');

    // Full quality run - no short-circuiting!
    const finalState = await agentGraph.invoke({
      tweetId,
      timeOfDay: time_of_day,
      topic: topic ?? "",
      previousDraft: previousDraft ?? "",
      currentFeedback: currentFeedback ?? "",
      iterationCount: 0
    }) as any;

    let tweetDraft = finalState.draft;
    const finalTopic = finalState.topic;

    if (!tweetDraft) throw new Error("Agent failed to generate draft");

    const currentTweet = await prisma.tweet.findUnique({ where: { id: tweetId } });

    // Fingerprint injection
    let fp = currentTweet?.fingerprint;
    let invisibleSuffix = '';
    if (!fp) {
      const generated = generateFingerprint();
      fp = generated.hex;
      invisibleSuffix = generated.invisible;
    } else {
      // Reconstruct invisible characters if fingerprint was already created
      // Wait, let's just generate the suffix from existing Hex
      const INVISIBLE_MAP: Record<string, string> = { '0': '\u200B', '1': '\u200C' };
      for (let i = 0; i < fp.length; i++) {
        const hexDigit = fp.charAt(i);
        const binary = parseInt(hexDigit, 16).toString(2).padStart(4, '0');
        for (let j = 0; j < binary.length; j++) {
          invisibleSuffix += INVISIBLE_MAP[binary.charAt(j)];
        }
      }
    }

    tweetDraft = appendFingerprint(tweetDraft, invisibleSuffix);

    // Generate Intent URL and Tracking Redirect
    const encodedTweet = encodeURIComponent(tweetDraft);
    const rawIntentUrl = `https://twitter.com/intent/tweet?text=${encodedTweet}`;
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
    // When defining intent URL, pass a generic username or rely on user specifying it. Since we don't know the exact username, we might prompt them, or pass 'self'. Let's default to a known env var if possible, otherwise rely on the frontend catching it.
    // The user's prompt suggests we pass username to resolving worker. We'll use a dummy placeholder or an env var.
    const username = process.env.X_USERNAME; // Update this to match user
    const trackerUrl = `${baseUrl}/api/post-intent?id=${tweetId}&username=${username}&intent=${encodeURIComponent(rawIntentUrl)}`;

    const approveToken = generateToken(tweetId);

    const updateData: any = {
      score: finalState.score || 0,
      status: 'APPROVED',
      intent_url: trackerUrl,
      fingerprint: fp,
      versions: {
        create: {
          content: tweetDraft,
          version: 1,
          critique: finalState.critique
        }
      }
    };

    // ONLY overwrite original_topic if it was left blank originally
    if (currentTweet?.original_topic === "AI Generating...") {
      updateData.original_topic = topic || finalTopic || "AI Generated";
    }

    // Update the record with final results
    const updatedTweet = await prisma.tweet.update({
      where: { id: tweetId },
      data: updateData
    });

    const payload = {
      success: true,
      tweet_id: tweetId,
      draft: tweetDraft,
      topic: updatedTweet.original_topic,
      time_of_day,
      score: updatedTweet.score,
      intentUrl: trackerUrl,
      editUrl: `${baseUrl}/api/view-edit?id=${tweetId}&token=${approveToken}`,
      feedbackUrl: `${baseUrl}/api/view-feedback?id=${tweetId}&token=${approveToken}`,
      token: approveToken,
      htmlDraft: escapeHTML(tweetDraft),
      duration: `${Date.now() - startAgent}ms`
    };

    logger.info({ tweetId, draftLen: payload.draft.length, intentUrl: payload.intentUrl }, 'Background generation finished. Prepared payload.');
    console.log('[DIAGNOSTIC] Final Payload:', JSON.stringify(payload, null, 2));

    // If a callback URL exists (from n8n), send the results there
    if (callbackUrl) {
      logger.info({ callbackUrl }, 'Sending result to webhook...');
      try {
        await fetch(callbackUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        logger.info('Webhook delivered successfully');
      } catch (webhookErr: any) {
        logger.error({ err: webhookErr.message }, 'Failed to deliver webhook');
      }
    }
  } catch (err: any) {
    logger.error({ tweetId, err: err.message }, 'Background generation failed');
    await prisma.tweet.update({
      where: { id: tweetId },
      data: { status: 'ERROR' }
    });
  }
}

app.post('/api/generate', async (req, res) => {
  try {
    const { time_of_day = 'morning', topic, callbackUrl } = req.body || {};
    logger.info({ time_of_day, topic }, 'Generate request received (Async Mode)');

    // 1. Create the database record IMMEDIATELY in 'GENERATING' state
    const tweet = await prisma.tweet.create({
      data: {
        original_topic: topic || "AI Generating...",
        time_of_day,
        status: 'GENERATING',
      }
    });

    // 2. Start the process in the background (DO NOT AWAIT)
    processGenerationInBackground(tweet.id, time_of_day, topic, callbackUrl)
      .catch(err => logger.error({ err }, 'Fatal background error'));

    // 3. Respond to the client instantly
    res.status(202).json({
      success: true,
      message: "Generation started in background",
      tweet_id: tweet.id,
      status: 'GENERATING',
      checkStatusUrl: `${process.env.BASE_URL || 'http://localhost:3000'}/api/status?id=${tweet.id}`
    });

  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed to initiate generation');
    res.status(500).json({ error: err.message });
  }
});

// Added Status Endpoint for Polling
app.get('/api/status', async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: "Missing ID" });

  const tweet = await prisma.tweet.findUnique({
    where: { id: String(id) },
    include: {
      versions: { orderBy: { version: 'desc' }, take: 1 },
      engagements: { orderBy: { fetched_at: 'desc' }, take: 1 }
    }
  });

  if (!tweet) return res.status(404).json({ error: "Job not found" });

  res.json({
    id: tweet.id,
    status: tweet.status,
    draft: tweet.versions[0]?.content,
    score: tweet.score,
    engagement: tweet.engagements[0] || null
  });
});

app.get('/api/analytics', async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: "Missing ID" });

  const history = await prisma.engagement.findMany({
    where: { tweet_id: String(id) },
    orderBy: { fetched_at: 'asc' }
  });

  res.json({
    tweetId: id,
    snapshotCount: history.length,
    history
  });
});

// HTML UI for Topic Editing
app.get('/api/view-edit', (req, res) => {
  const { id, token } = req.query;
  if (!id || !token) return res.status(400).send("Missing id or token");

  res.send(`
    <!DOCTYPE html>
    <html>
    <head><title>Edit Topic</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
    <body style="font-family: sans-serif; padding: 2rem; max-width: 600px; margin: auto;">
      <h2>Edit Topic</h2>
      <form id="editForm">
        <input type="hidden" name="id" value="${escapeHTML(String(id))}">
        <input type="hidden" name="token" value="${escapeHTML(String(token))}">
        <label style="display:block; margin-bottom: 0.5rem;">New Topic:</label>
        <textarea name="new_topic" rows="4" style="width: 100%; margin-bottom: 1rem; padding: 0.5rem;" required></textarea>
        <br>
        <button type="submit" style="background:#0F1419; color:white; padding: 0.75rem 1.5rem; border:none; border-radius: 99px; cursor:pointer;">Update Topic</button>
      </form>
      <script>
        document.getElementById('editForm').addEventListener('submit', async (e) => {
          e.preventDefault();
          const formData = new FormData(e.target);
          const data = Object.fromEntries(formData.entries());
          e.submitter.innerText = 'Sending...';
          e.submitter.style.opacity = '0.5';
          try {
            const res = await fetch('/api/edit', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(data)
            });
            const result = await res.json();
            if (result.success) {
              alert(result.message || 'Success! You can now regenerate the draft.');
              e.target.reset();
            } else {
              alert('Error: ' + result.error);
            }
          } catch (err) {
            alert('Failed to submit. Please check your connection.');
          }
          e.submitter.innerText = 'Update Topic';
          e.submitter.style.opacity = '1';
        });
      </script>
    </body>
    </html>
  `);
});

// HTML UI for Feedback
app.get('/api/view-feedback', (req, res) => {
  const { id, token } = req.query;
  if (!id || !token) return res.status(400).send("Missing id or token");

  res.send(`
    <!DOCTYPE html>
    <html>
    <head><title>Provide Feedback</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
    <body style="font-family: sans-serif; padding: 2rem; max-width: 600px; margin: auto;">
      <h2>Provide Feedback</h2>
      <form id="feedbackForm">
        <input type="hidden" name="id" value="${escapeHTML(String(id))}">
        <input type="hidden" name="token" value="${escapeHTML(String(token))}">
        <label style="display:block; margin-bottom: 0.5rem;">Feedback (e.g. "Too formal, make it funnier"):</label>
        <textarea name="feedback" rows="4" style="width: 100%; margin-bottom: 1rem; padding: 0.5rem;" required></textarea>
        <br>
        <button type="submit" style="background:#0F1419; color:white; padding: 0.75rem 1.5rem; border:none; border-radius: 99px; cursor:pointer;">Submit Feedback</button>
      </form>
      <script>
        document.getElementById('feedbackForm').addEventListener('submit', async (e) => {
          e.preventDefault();
          const formData = new FormData(e.target);
          const data = Object.fromEntries(formData.entries());
          e.submitter.innerText = 'Sending...';
          e.submitter.style.opacity = '0.5';
          try {
            const res = await fetch('/api/feedback', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(data)
            });
            const result = await res.json();
            if (result.success) {
              alert('Feedback submitted successfully!');
              e.target.reset();
            } else {
              alert('Error: ' + result.error);
            }
          } catch (err) {
            alert('Failed to submit. Please check your connection.');
          }
          e.submitter.innerText = 'Submit Feedback';
          e.submitter.style.opacity = '1';
        });
      </script>
    </body>
    </html>
  `);
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

    if (action === 'pc' || action === 'posted_confirmed') {
      await prisma.tweet.update({
        where: { id: tweetId },
        data: {
          status: 'POSTED_CONFIRMED',
          posted: true,
          posted_at: new Date()
        }
      });

      // Queuing 10m delayed resolution
      const username = process.env.X_USERNAME;
      const processAfter = new Date(Date.now() + 10 * 60 * 1000);
      try {
        await enqueueRetry("RESOLVE_TWEET", { tweetId, username }, 1, processAfter);
        logger.info({ tweetId, username, processAfter }, "Manual confirmation. Queued detector.");
      } catch (e) {
        logger.error("Failed to enqueue resolution");
      }

      await sendTelegramMessage(chatId, `✅ Marked as Posted!\nVerification polling started (10m delay).\nTweet ID: \`${tweetId}\``);
    } else if (action === 'ct' || action === 'copy_tweet') {
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

  const currentTweet = await prisma.tweet.findUnique({ where: { id } });
  if (!currentTweet) return res.status(404).json({ error: "Tweet not found" });

  const newOriginal = currentTweet.edited_topic ? currentTweet.edited_topic : currentTweet.original_topic;

  const updatedTweet = await prisma.tweet.update({
    where: { id },
    data: {
      original_topic: newOriginal,
      edited_topic: new_topic
    }
  });

  logger.info({ tweet_id: id, new_topic }, 'Topic edited, requesting immediate regeneration');

  const webhookUrl = process.env.N8N_WEBHOOK_URL || 'https://lalitkumar1517.app.n8n.cloud/webhook/tweet-ready';
  processGenerationInBackground(id, updatedTweet.time_of_day, new_topic, webhookUrl)
    .catch(err => logger.error({ err }, 'Regeneration background error'));

  res.json({ success: true, message: "Regenerating! You'll receive a new Telegram message shortly." });
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

  const tweet = await prisma.tweet.findUnique({
    where: { id },
    include: { versions: { orderBy: { version: 'desc' }, take: 1 } }
  });

  logger.info({ tweet_id: id }, 'Feedback received, requesting immediate regeneration');

  if (tweet) {
    const webhookUrl = process.env.N8N_WEBHOOK_URL || 'https://lalitkumar1517.app.n8n.cloud/webhook/tweet-ready';
    const topicToUse = tweet.edited_topic || tweet.original_topic;
    const oldDraft = tweet.versions[0]?.content || "";

    processGenerationInBackground(id, tweet.time_of_day, topicToUse, webhookUrl, oldDraft, feedback)
      .catch(err => logger.error({ err }, 'Regeneration background error'));
  }

  res.json({ success: true, message: "Feedback received! Regenerating tweet. You'll receive a new Telegram message shortly." });
});

app.post('/api/retries/process', async (req, res) => {
  logger.info("Manual processing of retry queue requested");
  res.json({ success: true, message: "Queue is processed by background worker automatically" });
});

app.get('/api/post-intent', async (req, res) => {
  const { id, username, intent } = req.query;
  if (!id || !username || !intent) {
    return res.status(400).send("Missing parameters");
  }

  // Enqueue detection task
  try {
    const tweetId = String(id);
    const user = String(username);

    const processAfter = new Date(Date.now() + 10 * 60 * 1000);
    await enqueueRetry("RESOLVE_TWEET", { tweetId, username: user }, 1, processAfter);
    logger.info({ tweetId, username: user, processAfter }, "Intercepted post intent. Queued detection polling.");
  } catch (err: any) {
    logger.error({ err: err.message }, "Error enqueuing resolution task");
  }

  // Redirect to real Twitter intent URL
  res.redirect(String(intent));
});

// Start the background worker process
runWorker();

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
