import { prisma } from './db.js';
import { logger } from './logger.js';
import { computeOutcomeScore } from './outcomeScorer.js';
import { reweightFeedback } from './feedbackWeighter.js';
import { evolvePersona } from './personaEvolver.js';
// Use native fetch in Node 20+

// In-memory queue to prevent overlapping polls
const activePolls = new Set<string>();

function getJitterDelay(baseDelayMs: number) {
  return baseDelayMs + Math.floor(Math.random() * 2000);
}

export async function resolveTweetAfterPost(tweetId: string, username: string, attempt: number = 1) {
  if (activePolls.has(tweetId)) return;
  activePolls.add(tweetId);

  try {
    const tweet = await prisma.tweet.findUnique({ where: { id: tweetId } });
    if (!tweet || tweet.posted) return;
    if (!tweet.fingerprint) throw new Error("No fingerprint found for tweet");

    logger.info({ tweetId, username, attempt }, "Polling for posted tweet");

    let found: { tweetId: string, url: string } | null = null;
    let failedFetches = 0;

    // Up to 5 requests in this execution
    for (let tryNum = 1; tryNum <= 5; tryNum++) {
      try {
        found = await pollTimelineForFingerprint(username, tweet.fingerprint);
        if (found) break;
      } catch (err: any) {
        failedFetches++;
        logger.warn({ tweetId, tryNum, err: err.message }, "Single poll attempt failed");
      }

      if (tryNum < 5 && !found) {
        await new Promise(r => setTimeout(r, getJitterDelay(4000)));
      }
    }

    if (found) {
      await prisma.tweet.update({
        where: { id: tweetId },
        data: {
          x_tweet_id: found.tweetId,
          live_url: found.url,
          posted: true,
          status: 'POSTED_CONFIRMED',
          posted_at: new Date()
        }
      });
      logger.info({ tweetId, foundUrl: found.url }, "Tweet detected and confirmed");

      // First engagement fetch: 10 minutes after POSTED_CONFIRMED
      const firstFetchTime = new Date(Date.now() + 10 * 60 * 1000);
      await enqueueRetry("FETCH_ENGAGEMENT", { tweetId, username }, 1, firstFetchTime);

    } else {
      // Re-schedule ONE additional retry (delayed) before marking as error
      if (attempt < 2) {
        const fallbackDelay = getJitterDelay(45 * 60 * 1000); // 45-47 mins
        const later = new Date(Date.now() + fallbackDelay);
        await enqueueRetry("RESOLVE_TWEET", { tweetId, username }, attempt + 1, later);
        logger.info({ tweetId, nextAttemptAt: later }, "Tweet not found yet. Scheduling ONE final delayed retry.");
      } else {
        await prisma.tweet.update({
          where: { id: tweetId },
          data: { status: 'RESOLVE_FAILED', posted: false, posted_at: null }
        });
        logger.error({ tweetId }, "Tweet not found after all retries. Marked RESOLVE_FAILED — fingerprint destroyed or tweet never posted.");
        const chatId = process.env.TELEGRAM_CHAT_ID;
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        if (chatId && botToken) {
          await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: `❌ Tweet not found after all retries — marked as *Not Posted*.\n\nTweet ID: \`${tweetId}\`\n\nFingerprint may have been destroyed or tweet was never posted.`,
              parse_mode: 'Markdown'
            })
          }).catch(err => logger.warn({ err: (err as Error).message }, 'Failed to send RESOLVE_FAILED Telegram notification'));
        }
      }
    }
  } catch (error: any) {
    logger.error({ tweetId, err: error.message }, "Error during tweet resolution");
  } finally {
    activePolls.delete(tweetId);
  }
}

const NITTER_INSTANCES = [
  'nitter.net',
  'nitter.privacydev.net',
  'nitter.poast.org',
  'nitter.space'
];

async function pollTimelineForFingerprint(username: string, fp: string): Promise<{ tweetId: string, url: string } | null> {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache'
  };

  const sources = [
    ...NITTER_INSTANCES.map(host => ({ name: `Nitter RSS (${host})`, url: `https://${host}/${username}/rss` })),
    { name: 'Twitter Native', url: `https://twitter.com/${username}` }
  ];

  for (const source of sources) {
    try {
      const res = await fetch(source.url, {
        headers,
        signal: AbortSignal.timeout(8000)
      });

      if (!res.ok) {
        logger.warn({ source: source.name, status: res.status }, "Scraping source returned error status");
        continue;
      }

      const text = await res.text();
      if (!text || text.length < 200) {
        logger.warn({ source: source.name, len: text?.length }, "Empty or suspicious response from source");
        continue;
      }

      const result = checkHtmlForFingerprint(text, fp, username);
      if (result) return result;
    } catch (err: any) {
      logger.warn({ source: source.name, err: err.message }, "Scraping source fetch failed");
    }
  }

  return null;
}

function checkHtmlForFingerprint(content: string, fingerprint: string, username: string) {
  // A primitive check:
  // Since fingerprint zeroes/ones map to \u200B and \u200C, let's rebuild the invisible string to search exactly.
  const INVISIBLE_MAP: Record<string, string> = { '0': '\u200B', '1': '\u200C' };
  let invisibleSuffix = '';
  for (let i = 0; i < fingerprint.length; i++) {
    const hexDigit = fingerprint.charAt(i);
    const binary = parseInt(hexDigit, 16).toString(2).padStart(4, '0');
    for (let j = 0; j < binary.length; j++) {
      invisibleSuffix += INVISIBLE_MAP[binary.charAt(j)];
    }
  }

  if (content.indexOf(invisibleSuffix) !== -1) {
    // Match found! We need the tweet ID.
    // We can do a rudimentary regex around the invisible match to find status ID.
    // E.g. searching for `status/1234567890` nearby.
    const matchIndex = content.indexOf(invisibleSuffix);
    const snippet = content.substring(Math.max(0, matchIndex - 1000), matchIndex + 1000);

    // Find /status/12345...
    const statusRegex = new RegExp(`/${username}/status/(\\d+)`, 'i');
    const m = snippet.match(statusRegex);
    if (m && m[1]) {
      return {
        tweetId: m[1],
        url: `https://twitter.com/${username}/status/${m[1]}`
      };
    }
  }
  return null;
}

export async function enqueueRetry(taskType: string, payload: any, attempt: number, processAfter?: Date) {
  await prisma.retryQueue.create({
    data: {
      task_type: taskType,
      payload: payload,
      attempts: attempt,
      max_retries: 5,
      process_after: processAfter || new Date()
    }
  });
}

// Track last reweight time in-memory (6h gate)
let lastReweightAt = 0;

// Background scheduler
export async function runWorker() {
  setInterval(async () => {
    try {
      // 6-hour feedback reweight check
      const sixHoursMs = 6 * 60 * 60_000;
      if (Date.now() - lastReweightAt >= sixHoursMs) {
        try {
          await reweightFeedback();
          lastReweightAt = Date.now();
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error({ err: message }, "Scheduled reweightFeedback failed");
        }
      }

      const tasks = await prisma.retryQueue.findMany({
        where: {
          status: 'PENDING',
          process_after: { lte: new Date() }
        },
        take: 10,
        orderBy: { created_at: 'asc' }
      });

      for (const task of tasks) {
        const payload = task.payload as any;

        await prisma.retryQueue.update({ where: { id: task.id }, data: { status: 'PROCESSING' } });

        try {
          if (task.task_type === "RESOLVE_TWEET") {
            await resolveTweetAfterPost(payload.tweetId, payload.username, task.attempts);
          } else if (task.task_type === "FETCH_ENGAGEMENT") {
            await fetchTweetEngagement(payload.tweetId, task.attempts, payload.username);
          } else if (task.task_type === "EVOLVE_PERSONA") {
            await evolvePersona();
          }
          await prisma.retryQueue.update({ where: { id: task.id }, data: { status: 'COMPLETED' } });
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          logger.error({ id: task.id, err: message }, "Task processing failed");
          if (task.attempts >= task.max_retries) {
            await prisma.retryQueue.update({ where: { id: task.id }, data: { status: 'FAILED', last_error: message } });
          } else {
            await prisma.retryQueue.update({ where: { id: task.id }, data: { status: 'PENDING', attempts: task.attempts + 1 } });
          }
        }
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      logger.error({ err: message }, "Worker loop error");
    }
  }, 10000);
}

export async function fetchTweetEngagement(tweetId: string, attempt: number, username: string) {
  const tweet = await prisma.tweet.findUnique({ where: { id: tweetId } });
  if (!tweet || !tweet.x_tweet_id) return;

  // Avoid duplicates: Check if we have a record within the last 5 minutes
  const recentEngagement = await prisma.engagement.findFirst({
    where: {
      tweet_id: tweetId,
      fetched_at: { gte: new Date(Date.now() - 5 * 60 * 1000) }
    }
  });

  if (recentEngagement) {
    logger.info({ tweetId }, "Skipping engagement fetch: minimum gap not met");
    return;
  }

  logger.info({ tweetId, attempt }, "Fetching tracking engagement...");

  try {
    const res = await fetch(`https://cdn.syndication.twimg.com/tweet-result?id=${tweet.x_tweet_id}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(7000)
    });

    if (res.ok) {
      const data = await res.json();

      // Validate response structure before parsing
      if (!data || typeof data !== 'object') {
        throw new Error("Engagement source returned invalid object");
      }

      const likes = Number(data?.favorite_count || 0);
      const retweets = Number((data?.retweet_count || 0) + (data?.quote_count || 0));

      // Every fetch should INSERT a new row
      await prisma.engagement.create({
        data: {
          tweet_id: tweetId,
          likes,
          retweets,
          fetched_at: new Date()
        }
      });

      logger.info({ tweetId, likes, retweets, attempt }, "Engagement tracking snapshot stored");

      // Schedule additional fetches (10m -> 1h -> 6h -> 24h -> 48h -> 72h)
      let nextFetchDelay = 0;
      if (attempt === 1) nextFetchDelay = 50 * 60 * 1000; // 10m + 50m = 1h
      else if (attempt === 2) nextFetchDelay = 5 * 60 * 60 * 1000; // 1h + 5h = 6h
      else if (attempt === 3) nextFetchDelay = 18 * 60 * 60 * 1000; // 6h + 18h = 24h
      else if (attempt === 4) nextFetchDelay = 24 * 60 * 60 * 1000; // 24h + 24h = 48h (Day 2)

      if (attempt === 5) {
        // Final snapshot (72h) — close the engagement loop
        try {
          await computeOutcomeScore(tweetId);
          await reweightFeedback();

          // Check if 5+ new high-tier tweets exist since last persona evolution
          const lastEvolution = await prisma.personaProfile.findFirst({
            orderBy: { created_at: 'desc' },
            select: { created_at: true },
          });
          const sinceDate = lastEvolution?.created_at ?? new Date(0);
          const highTierCount = await prisma.tweetOutcome.count({
            where: { tier: 'high', computed_at: { gt: sinceDate } },
          });

          if (highTierCount >= 5) {
            await enqueueRetry("EVOLVE_PERSONA", {}, 1);
            logger.info({ highTierCount }, "Enqueued EVOLVE_PERSONA task");
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error({ tweetId, err: message }, "Post-engagement scoring/evolution failed");
        }
      } else if (nextFetchDelay > 0) {
        const jitteredNextDelay = getJitterDelay(nextFetchDelay);
        const nextFetchDate = new Date(Date.now() + jitteredNextDelay);
        await enqueueRetry("FETCH_ENGAGEMENT", { tweetId, username }, attempt + 1, nextFetchDate);
        logger.info({ tweetId, nextFetchDate }, "Scheduled next engagement fetch.");
      }

    } else {
      logger.warn({ tweetId, status: res.status, attempt }, "Failed to fetch engagement from source");
      throw new Error(`Source returned status ${res.status}`);
    }
  } catch (error: any) {
    logger.error({ tweetId, err: error.message, attempt }, "Engagement fetch failed.");
    throw error;
  }
}
