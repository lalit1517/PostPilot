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

    let found: { tweetId: string, url: string } | null = null;
    let failedFetches = 0;

    // Up to 5 requests (3-5 seconds apart)
    for (let tryNum = 1; tryNum <= 5; tryNum++) {
      try {
        found = await pollTimelineForFingerprint(username, tweet.fingerprint);
        if (found) break; // Stop immediately if match found
      } catch (err: any) {
        failedFetches++;
      }
      
      // Delay between retries: 3-5 seconds
      if (tryNum < 5 && !found) {
        await new Promise(r => setTimeout(r, 4000));
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
      if (failedFetches >= 3 && attempt < 3) {
        // High failure rate (e.g. rate limit), retry later (30-60 mins)
        const later = new Date(Date.now() + 45 * 60 * 1000);
        await enqueueRetry("RESOLVE_TWEET", { tweetId, username }, attempt + 1, later);
        logger.info({ tweetId }, "Scraping failed consistently, retrying later.");
      } else {
        // Not found after retries
        await prisma.tweet.update({
          where: { id: tweetId },
          data: { status: 'ERROR' }
        });
        logger.error({ tweetId }, "Tweet not found after max requests.");
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
    // Only fetch when needed, with strict headers
    const headers = { 
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/json',
      'Accept-Language': 'en-US,en;q=0.9'
    };

    const res = await fetch(`https://nitter.net/${username}/rss`, {
      headers,
      signal: AbortSignal.timeout(6000) // Timeout 5-8s as requested
    });
    
    if (!res.ok) {
        // Fallback to searching regular Twitter page (very likely blocked, but we try)
        const fallbackRes = await fetch(`https://twitter.com/${username}`, {
            headers,
            signal: AbortSignal.timeout(6000)
        });
        const html = await fallbackRes.text();
        return checkHtmlForFingerprint(html, fp, username);
    }

    const text = await res.text();
    return checkHtmlForFingerprint(text, fp, username);
  } catch (err: any) {
    logger.warn({ err: err.message }, "Timeline polling attempt failed");
    throw err;
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

// Background scheduler
export async function runWorker() {
  setInterval(async () => {
    try {
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
     const res = await fetch(`https://cdn.syndication.twimg.com/tweet-result?id=${tweet.x_tweet_id}`);
     if (res.ok) {
       const data = await res.json();
       const likes = data?.favorite_count || 0;
       const retweets = (data?.retweet_count || 0) + (data?.quote_count || 0);

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
       else if (attempt === 5) nextFetchDelay = 24 * 60 * 60 * 1000; // 48h + 24h = 72h (Day 3)

       if (nextFetchDelay > 0) {
         const nextFetchDate = new Date(Date.now() + nextFetchDelay);
         await enqueueRetry("FETCH_ENGAGEMENT", { tweetId, username }, attempt + 1, nextFetchDate);
         logger.info({ tweetId, nextFetchDate }, "Scheduled next engagement fetch.");
       }

     } else {
       throw new Error(`Failed to fetch engagement for ${tweet.x_tweet_id}`);
     }
   } catch (error: any) {
     logger.warn({ err: error.message }, "Engagement fetch failed.");
     throw error;
   }
}
