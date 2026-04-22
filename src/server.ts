import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { prisma } from './db.js';
import { logger } from './logger.js';
import { agentGraph } from './agent.js';
import { generateUniqueFingerprint, appendFingerprint } from './fingerprint.js';
import { checkDraftDiversity } from './draftDiversity.js';
import { getRateStatus } from './rateGuard.js';
import { getEngagementPattern, getTopicPerformance, getQualityOutcomeCorrelation } from './analytics.js';
import { runWorker, enqueueRetry } from './worker.js';

const app = express();
app.set('trust proxy', 1); // Trust Render's proxy to get the correct user IP and protocol

// ── Request Logger ──────────────────────────────────────────────────────────
// Logs all incoming requests to help visualize pings (Render, GitHub, etc.)
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info({
      method: req.method,
      path: req.path,
      ip: req.ip,
      status: res.statusCode,
      duration: `${duration}ms`
    }, `[HTTP] ${req.method} ${req.path}`);
  });
  next();
});

// ── Security Middleware ──────────────────────────────────────────────────────
// Helmet: sets secure HTTP headers (X-Frame-Options, CSP, HSTS, etc.)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],  // inline scripts for edit/feedback forms
      styleSrc: ["'self'", "'unsafe-inline'"],
    }
  }
}));

// CORS: restrict origins to known callers
const ALLOWED_ORIGINS = [
  process.env.BASE_URL,
  process.env.N8N_WEBHOOK_URL,
].filter(Boolean) as string[];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (server-to-server, curl, n8n, Telegram)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.some(allowed => origin.startsWith(allowed))) {
      return callback(null, true);
    }
    callback(new Error('Blocked by CORS'));
  },
  methods: ['GET', 'POST'],
}));

// Rate Limiting: global baseline
const globalLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, slow down.' },
});
app.use(globalLimiter);

// Strict rate limiter for generation endpoint (expensive LLM calls)
const generateLimiter = rateLimit({
  windowMs: 60_000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Generation rate limit exceeded.' },
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── API Key Authentication Middleware ────────────────────────────────────────
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;
if (!INTERNAL_API_KEY) {
  throw new Error("Missing INTERNAL_API_KEY in environment variables");
}

function requireApiKey(req: express.Request, res: express.Response, next: express.NextFunction) {
  const key = req.headers['x-api-key'] as string | undefined;
  if (!key || key !== INTERNAL_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized — valid X-API-Key header required' });
  }
  next();
}

// ── URL Validation Helpers ───────────────────────────────────────────────────
const ALLOWED_CALLBACK_HOSTS = new Set([
  // Add your n8n host and any other trusted webhook receivers
  ...(process.env.N8N_WEBHOOK_URL ? [new URL(process.env.N8N_WEBHOOK_URL).host] : []),
]);

function isAllowedCallbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol)) return false;
    if (ALLOWED_CALLBACK_HOSTS.has(parsed.host)) return true;
    return false;
  } catch {
    return false;
  }
}

function isAllowedRedirect(url: string): boolean {
  try {
    const parsed = new URL(url);
    const allowed = ['twitter.com', 'x.com', 'www.twitter.com', 'www.x.com'];
    return allowed.includes(parsed.host) && parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// ── Telegram Webhook Verification ────────────────────────────────────────────
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';

function verifyTelegramWebhook(req: express.Request): boolean {
  // If a webhook secret is configured, verify the X-Telegram-Bot-Api-Secret-Token header
  if (!TELEGRAM_WEBHOOK_SECRET) return true;  // no secret configured — skip (legacy compat)
  const headerToken = req.headers['x-telegram-bot-api-secret-token'] as string | undefined;
  return headerToken === TELEGRAM_WEBHOOK_SECRET;
}

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
  // Validate callbackUrl early to prevent SSRF
  if (callbackUrl && !isAllowedCallbackUrl(callbackUrl)) {
    logger.warn({ callbackUrl }, 'Blocked disallowed callbackUrl (SSRF prevention)');
    callbackUrl = undefined;
  }
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

    const diversity = await checkDraftDiversity(tweetDraft, tweetId);
    if (diversity.duplicate) {
      logger.warn({ tweetId, similarity: diversity.maxSimilarity, matchedTweetId: diversity.matchedTweetId }, 'Draft too similar to recent tweets');
    }

    const currentTweet = await prisma.tweet.findUnique({ where: { id: tweetId } });

    // Fingerprint injection
    let fp = currentTweet?.fingerprint;
    let invisibleSuffix = '';
    if (!fp) {
      const generated = await generateUniqueFingerprint();
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
    // Diagnostic log — server-side only, never sent to client
    logger.info({ tweetId, draftLen: payload.draft.length }, 'Background generation payload ready');

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

app.post('/api/generate', requireApiKey, generateLimiter, async (req, res) => {
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
    res.status(500).json({ error: 'Internal server error' });
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

app.get('/api/status/:id/timeline', async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ success: false, error: "Missing ID" });

    const tweet = await prisma.tweet.findUnique({
      where: { id },
      include: {
        versions: { orderBy: { version: 'asc' } },
        feedbacks: { orderBy: { created_at: 'asc' } },
        engagements: { orderBy: { fetched_at: 'asc' } },
        outcome: true
      }
    });

    if (!tweet) return res.status(404).json({ success: false, error: "Tweet not found" });

    const tasks = await prisma.$queryRaw<Array<{
      id: string;
      task_type: string;
      status: string;
      attempts: number;
      max_retries: number;
      last_error: string | null;
      process_after: Date;
      created_at: Date;
      updated_at: Date;
    }>>`
      SELECT id, task_type, status, attempts, max_retries, last_error, process_after, created_at, updated_at
      FROM "RetryQueue"
      WHERE payload->>'tweetId' = ${id}
      ORDER BY created_at ASC
    `;

    const events: Array<{ kind: string; at: Date; detail: Record<string, unknown> }> = [];

    events.push({
      kind: 'CREATED',
      at: tweet.created_at,
      detail: { status: 'GENERATING', topic: tweet.original_topic, time_of_day: tweet.time_of_day }
    });

    for (const v of tweet.versions) {
      events.push({
        kind: 'VERSION',
        at: v.created_at,
        detail: { version: v.version, quality_score: v.quality_score, critique: v.critique, length: v.content.length }
      });
    }

    for (const f of tweet.feedbacks) {
      events.push({
        kind: 'FEEDBACK',
        at: f.created_at,
        detail: { weighted_score: f.weighted_score, text: f.feedback_text }
      });
    }

    if (tweet.posted_at) {
      events.push({
        kind: 'POSTED',
        at: tweet.posted_at,
        detail: { x_tweet_id: tweet.x_tweet_id, live_url: tweet.live_url }
      });
    }

    for (const e of tweet.engagements) {
      events.push({
        kind: 'ENGAGEMENT',
        at: e.fetched_at,
        detail: { likes: e.likes, retweets: e.retweets, impressions: e.impressions }
      });
    }

    if (tweet.outcome) {
      events.push({
        kind: 'OUTCOME',
        at: tweet.outcome.computed_at,
        detail: {
          outcome_score: tweet.outcome.outcome_score,
          tier: tweet.outcome.tier,
          peak_likes: tweet.outcome.peak_likes,
          peak_retweets: tweet.outcome.peak_retweets,
          quality_score: tweet.outcome.quality_score,
          topic: tweet.outcome.topic,
          time_of_day: tweet.outcome.time_of_day,
          day_of_week: tweet.outcome.day_of_week
        }
      });
    }

    for (const t of tasks) {
      events.push({
        kind: 'TASK',
        at: t.updated_at,
        detail: {
          task_id: t.id,
          task_type: t.task_type,
          status: t.status,
          attempts: t.attempts,
          max_retries: t.max_retries,
          last_error: t.last_error,
          process_after: t.process_after
        }
      });
    }

    events.sort((a, b) => a.at.getTime() - b.at.getTime());

    res.setHeader('Cache-Control', 'private, max-age=5');
    res.json({
      success: true,
      tweet: {
        id: tweet.id,
        status: tweet.status,
        original_topic: tweet.original_topic,
        edited_topic: tweet.edited_topic,
        time_of_day: tweet.time_of_day,
        score: tweet.score,
        posted: tweet.posted,
        posted_at: tweet.posted_at,
        x_tweet_id: tweet.x_tweet_id,
        live_url: tweet.live_url,
        fingerprint: tweet.fingerprint,
        created_at: tweet.created_at
      },
      counts: {
        versions: tweet.versions.length,
        feedbacks: tweet.feedbacks.length,
        engagements: tweet.engagements.length,
        tasks: tasks.length
      },
      outcome: tweet.outcome,
      timeline: events
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, 'Timeline lookup failed');
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
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
  // Verify the request actually came from Telegram
  if (!verifyTelegramWebhook(req)) {
    logger.warn('Telegram webhook request failed secret verification');
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { callback_query, message } = req.body;

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

      // Mutate the original Telegram message: replace buttons with "Marked as Posted" state
      const messageId = callback_query.message.message_id;
      const baseUrl = process.env.BASE_URL || '';
      const postedToken = generateToken(tweetId);
      const updatedKeyboard = {
        inline_keyboard: [
          [{ text: "🚀 Open in X", url: tweet.intent_url || 'https://twitter.com' }],
          [{ text: "✏️ Edit Topic", url: `${baseUrl}/api/view-edit?id=${tweetId}&token=${postedToken}` }],
          [{ text: "💬 Feedback", url: `${baseUrl}/api/view-feedback?id=${tweetId}&token=${postedToken}` }],
          [{ text: "✅ Marked as Posted", callback_data: "noop" }, { text: "📋 Copy", callback_data: `ct:${tweetId}:${token}` }],
        ],
      };
      const editMarkupRes = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/editMessageReplyMarkup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: updatedKeyboard }),
      }).catch(err => { logger.warn({ err: (err as Error).message }, 'editMessageReplyMarkup network error'); return null; });
      if (editMarkupRes && !editMarkupRes.ok) {
        const errBody = await editMarkupRes.text();
        logger.warn({ status: editMarkupRes.status, body: errBody }, 'editMessageReplyMarkup failed');
      }
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

  const webhookUrl = process.env.N8N_WEBHOOK_URL;
  if (!webhookUrl) {
    logger.warn('N8N_WEBHOOK_URL not configured, regeneration callback will be skipped');
  }
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
    const webhookUrl = process.env.N8N_WEBHOOK_URL;
    const topicToUse = tweet.edited_topic || tweet.original_topic;
    const oldDraft = tweet.versions[0]?.content || "";

    processGenerationInBackground(id, tweet.time_of_day, topicToUse, webhookUrl, oldDraft, feedback)
      .catch(err => logger.error({ err }, 'Regeneration background error'));
  }

  res.json({ success: true, message: "Feedback received! Regenerating tweet. You'll receive a new Telegram message shortly." });
});

app.get('/api/admin/rate-status', requireApiKey, async (_req, res) => {
  try {
    const status = await getRateStatus();
    res.json({ success: true, ...status });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, 'Rate status lookup failed');
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.get('/api/admin/failed-tasks', requireApiKey, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const tasks = await prisma.retryQueue.findMany({
      where: { status: 'FAILED' },
      orderBy: { updated_at: 'desc' },
      take: limit,
      select: {
        id: true,
        task_type: true,
        payload: true,
        attempts: true,
        max_retries: true,
        last_error: true,
        process_after: true,
        created_at: true,
        updated_at: true
      }
    });
    res.json({ success: true, count: tasks.length, tasks });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, 'Failed task lookup failed');
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.get('/api/admin/engagement-pattern', requireApiKey, async (_req, res) => {
  try {
    const data = await getEngagementPattern();
    res.json({ success: true, ...data });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, 'Engagement pattern lookup failed');
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.get('/api/admin/topic-performance', requireApiKey, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const data = await getTopicPerformance(limit);
    res.json({ success: true, count: data.length, topics: data });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, 'Topic performance lookup failed');
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.get('/api/admin/quality-correlation', requireApiKey, async (_req, res) => {
  try {
    const data = await getQualityOutcomeCorrelation();
    res.json({ success: true, ...data });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, 'Quality correlation lookup failed');
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.post('/api/retries/process', requireApiKey, async (req, res) => {
  logger.info("Manual processing of retry queue requested");
  res.json({ success: true, message: "Queue is processed by background worker automatically" });
});

app.get('/api/post-intent', async (req, res) => {
  const { id, username, intent } = req.query;
  if (!id || !username || !intent) {
    return res.status(400).send("Missing parameters");
  }

  const intentUrl = String(intent);

  // Open redirect prevention: only allow redirects to Twitter/X
  if (!isAllowedRedirect(intentUrl)) {
    logger.warn({ intent: intentUrl }, 'Blocked open redirect to non-Twitter URL');
    return res.status(400).json({ error: 'Invalid redirect target' });
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

  // Redirect to validated Twitter intent URL
  res.redirect(intentUrl);
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 [STARTUP] Server is live on port ${PORT}`);
  
  // Start the background worker process after the port is open
  runWorker();

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
