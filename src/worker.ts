import { prisma } from './db.js';
import { logger } from './logger.js';
import { extractFingerprintHex } from './fingerprint.js';
// Use native fetch in Node 20+

// In-memory queue to prevent overlapping polls
const activePolls = new Set<string>();

export async function resolveTweetAfterPost(tweetId: string, username: string, attempt: number = 1) {
  if (activePolls.has(tweetId)) return;
  activePolls.add(tweetId);

  try {
    const tweet = await prisma.tweet.findUnique({ where: { id: tweetId } });
    if (!tweet || tweet.posted) return;
    if (!tweet.fingerprint) throw new Error("No fingerprint found for tweet");

    logger.info({ tweetId, username, attempt }, "Polling for posted tweet");

    const maxRetries = 5;
    const found = await pollTimelineForFingerprint(username, tweet.fingerprint);

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
      logger.info({ tweetId, foundUrl: found.url }, "Tweet successfully detected!");

      // Enqueue Engagement Fetcher
      await prisma.retryQueue.create({
        data: {
          task_type: "FETCH_ENGAGEMENT",
          payload: { tweetId, username },
          max_retries: 3
        }
      });

    } else {
      if (attempt < maxRetries) {
        // Enqueue retry with exponential backoff (simplified here to delay in processor)
        await enqueueRetry("RESOLVE_TWEET", { tweetId, username }, attempt + 1);
        logger.info({ tweetId, attempt }, "Tweet not found yet. Retrying later.");
      } else {
        await prisma.tweet.update({
          where: { id: tweetId },
          data: { status: 'ERROR' }
        });
        logger.error({ tweetId }, "Failed to find tweet after max retries.");
      }
    }
  } catch (error: any) {
    logger.error({ tweetId, err: error.message }, "Error during tweet resolution");
  } finally {
    activePolls.delete(tweetId);
  }
}

async function pollTimelineForFingerprint(username: string, fp: string): Promise<{ tweetId: string, url: string } | null> {
  // Use public syndication endpoint or scraping. The syndication endpoint is somewhat rate-limited but usually works.
  try {
    const url = `https://syndication.twitter.com/srv/timeline-profile/screen-name/${username}`;
    // The modern syndication endpoint returns HTML inside a JSON if using the older widget, or just raw HTML.
    // Let's use a known public endpoint or Nitter as fallback.
    // Actually, `https://cdn.syndication.twimg.com/widgets/timelines/profile?screen_name=` doesn't work easily without a script token anymore.
    // We will simulate a parser. Because this depends on Twitter's fragile DOM, we just do a simple fetch and regex.
    const res = await fetch(`https://nitter.net/${username}/rss`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10000)
    });
    
    // Nitter frequently goes down, another option:
    // https://rsshub.app/twitter/user/xyz
    // Let's just create a generic parser that checks the body.
    if (!res.ok) {
        // Fallback to searching regular Twitter page (very likely blocked, but we try)
        const fallbackRes = await fetch(`https://twitter.com/${username}`, {
            headers: { 'User-Agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)' }
        });
        const html = await fallbackRes.text();
        const extracted = checkHtmlForFingerprint(html, fp, username);
        if (extracted) return extracted;
        return null;
    }

    const text = await res.text();
    const extracted = checkHtmlForFingerprint(text, fp, username);
    return extracted;
  } catch (err: any) {
    logger.warn({ err: err.message }, "Timeline polling failed");
    return null;
  }
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

export async function enqueueRetry(taskType: string, payload: any, attempt: number) {
  await prisma.retryQueue.create({
    data: {
      task_type: taskType,
      payload: payload,
      attempts: attempt,
      max_retries: 5
    }
  });
}

// Background scheduler
export async function runWorker() {
  setInterval(async () => {
    try {
      const tasks = await prisma.retryQueue.findMany({
        where: { status: 'PENDING' },
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
            await fetchTweetEngagement(payload.tweetId);
          }
          await prisma.retryQueue.update({ where: { id: task.id }, data: { status: 'COMPLETED' } });
        } catch (e: any) {
          logger.error({ id: task.id, err: e.message }, "Task processing failed");
          if (task.attempts >= task.max_retries) {
            await prisma.retryQueue.update({ where: { id: task.id }, data: { status: 'FAILED', last_error: e.message } });
          } else {
             // Reset back to PENDING for the next round (in a real system, you'd add a processing delay)
            await prisma.retryQueue.update({ where: { id: task.id }, data: { status: 'PENDING', attempts: task.attempts + 1 } });
          }
        }
      }
    } catch (e: any) {
      logger.error({ err: e.message }, "Worker loop error");
    }
  }, 10000);
}

export async function fetchTweetEngagement(tweetId: string) {
   const tweet = await prisma.tweet.findUnique({ where: { id: tweetId } });
   if (!tweet || !tweet.x_tweet_id) return;
   
   logger.info({ tweetId }, "Fetching engagement...");
   
   // This is difficult without API, but some alternatives exist:
   // Syndication API provides metrics sometimes:
   try {
     const res = await fetch(`https://cdn.syndication.twimg.com/tweet-result?id=${tweet.x_tweet_id}`);
     if (res.ok) {
       const data = await res.json();
       const likes = data?.favorite_count || 0;
       const retweets = (data?.retweet_count || 0) + (data?.quote_count || 0);

       await prisma.engagement.upsert({
         where: { tweet_id: tweetId },
         update: { likes, retweets, fetched_at: new Date() },
         create: {
           tweet_id: tweetId,
           likes,
           retweets,
           fetched_at: new Date()
         }
       });
       logger.info({ tweetId, likes, retweets }, "Engagement stored.");
     } else {
       throw new Error(`Failed to fetch engagement for ${tweet.x_tweet_id}`);
     }
   } catch (error: any) {
     logger.warn({ err: error.message }, "Engagement fetch failed.");
     throw error;
   }
}
