// Background worker. Schedules around the next due RetryQueue row instead of
// polling every minute, so idle workers do not keep poking Supavisor.
// Handles RESOLVE_TWEET, FETCH_ENGAGEMENT (10m/1h/6h/24h/48h/72h), EVOLVE_PERSONA, and 6h reweight.
import { prisma } from './db.js';
import { logger } from './logger.js';
import { extractFingerprintHex } from './fingerprint.js';
import { computeOutcomeScore } from './outcomeScorer.js';
import { reweightFeedback } from './feedbackWeighter.js';
import { evolvePersona } from './personaEvolver.js';

const CONNECTION_ERROR_MARKERS = [
  'P1001',
  'P1002',
  'P1008',
  "Can't reach database",
  'connection pool',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'socket hang up',
];

function isConnectionError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return CONNECTION_ERROR_MARKERS.some((m) => message.includes(m));
}

interface TickResult {
  ok: boolean;
  connectionError: boolean;
  nextDelayMs: number;
  err?: string;
}

let consecutiveDbFailures = 0;
// Use native fetch in Node 20+

// In-memory queue to prevent overlapping polls
const activePolls = new Set<string>();

const DEFAULT_NITTER_INSTANCES = [
  'nitter.net',
  'xcancel.com',
  'nitter.privacyredirect.com',
  'nitter.privacydev.net',
  'nitter.poast.org',
  'nitter.space',
  'nitter.tiekoetter.com',
  'lightbrd.com',
] as const;

const SCRAPER_COOLDOWN_MS = 30 * 60 * 1000;
const scraperCooldownUntil = new Map<string, number>();

function getJitterDelay(baseDelayMs: number) {
  return baseDelayMs + Math.floor(Math.random() * 2000);
}

function normalizeNitterHost(rawHost: string): string | null {
  const trimmed = rawHost.trim();
  if (!trimmed) return null;

  try {
    const parsed = trimmed.includes('://')
      ? new URL(trimmed)
      : new URL(`https://${trimmed}`);
    return parsed.host.toLowerCase();
  } catch {
    return null;
  }
}

function getNitterInstances(): string[] {
  const configured = process.env.NITTER_INSTANCES?.split(',')
    .map(normalizeNitterHost)
    .filter((host): host is string => Boolean(host));
  const hosts = configured && configured.length > 0
    ? configured
    : [...DEFAULT_NITTER_INSTANCES];
  return [...new Set(hosts)];
}

function shuffle<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const current = copy[i];
    copy[i] = copy[j] as T;
    copy[j] = current as T;
  }
  return copy;
}

function isSourceCoolingDown(sourceKey: string): boolean {
  const until = scraperCooldownUntil.get(sourceKey);
  if (!until) return false;
  if (until <= Date.now()) {
    scraperCooldownUntil.delete(sourceKey);
    return false;
  }
  return true;
}

function coolDownSource(sourceKey: string): void {
  scraperCooldownUntil.set(sourceKey, Date.now() + SCRAPER_COOLDOWN_MS);
}

function escapeHTML(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildDraftTelegramText(tweet: {
  original_topic: string;
  edited_topic: string | null;
  time_of_day: string;
  score: number;
}, draft: string, statusLine: string): string {
  return [
    '<b>New X Post Draft</b>',
    '',
    `<b>Topic:</b> ${escapeHTML(tweet.edited_topic || tweet.original_topic)}`,
    '',
    '<b>Draft:</b>',
    `<pre><code>${escapeHTML(draft)}</code></pre>`,
    '',
    `<b>Time:</b> ${escapeHTML(tweet.time_of_day)}`,
    `<b>Score:</b> ${tweet.score || 0}/10`,
    '',
    `<b>Status:</b> ${escapeHTML(statusLine)}`,
    '',
  ].join('\n');
}

async function updateTelegramFinalStatus(
  chatId: string | null,
  messageId: number | null,
  tweetId: string,
  text: string,
): Promise<void> {
  if (!chatId || !messageId) return;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return;

  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [] },
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      logger.warn({ tweetId, status: res.status, body }, 'Telegram final status update returned non-OK');
    }
  } catch (err) {
    logger.warn({ tweetId, err: (err as Error).message }, 'Failed to update Telegram final status');
  }
}

export async function resolveTweetAfterPost(tweetId: string, username: string, attempt: number = 1) {
  if (activePolls.has(tweetId)) return;
  activePolls.add(tweetId);

  try {
    const tweet = await prisma.tweet.findUnique({
      where: { id: tweetId },
      include: { versions: { orderBy: { version: 'desc' }, take: 1 } }
    });
    if (!tweet) return;
    // Skip if already resolved (live_url set on real Nitter match) or already
    // marked failed. Do NOT skip on `posted=true` alone — the manual `✅ Posted`
    // button sets `posted=true` optimistically before resolution runs, so that
    // guard would silently drop every manual-confirm task and never revert the
    // Telegram button on a real failure.
    if (tweet.live_url) return;
    if (tweet.status === 'RESOLVE_FAILED') return;
    if (!tweet.fingerprint) throw new Error("No fingerprint found for tweet");

    logger.info({ tweetId, username, attempt }, "Polling for posted tweet");

    const expectedDraft = tweet.versions[0]?.content || "";
    const found = await pollTimelineForFingerprint(username, tweet.fingerprint, expectedDraft, tweet.created_at);

    if (found) {
      const confirmedTweet = await prisma.tweet.update({
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
      await updateTelegramFinalStatus(
        confirmedTweet.telegram_chat_id,
        confirmedTweet.telegram_message_id,
        tweetId,
        buildDraftTelegramText(tweet, expectedDraft, "✅ Marked as Posted")
      );

      // First engagement fetch: 10 minutes after POSTED_CONFIRMED
      const firstFetchTime = new Date(Date.now() + 10 * 60 * 1000);
      await enqueueRetry("FETCH_ENGAGEMENT", { tweetId, username }, 1, firstFetchTime, 6);

    } else {
      if (attempt === 1) {
        const shortRetryDelay = getJitterDelay(7 * 60 * 1000);
        const later = new Date(Date.now() + shortRetryDelay);
        await enqueueRetry("RESOLVE_TWEET", { tweetId, username }, attempt + 1, later);
        logger.info({ tweetId, nextAttemptAt: later }, "Tweet not found yet. Scheduling short retry.");
      } else if (attempt === 2) {
        const fallbackDelay = getJitterDelay(45 * 60 * 1000); // 45-47 mins
        const later = new Date(Date.now() + fallbackDelay);
        await enqueueRetry("RESOLVE_TWEET", { tweetId, username }, attempt + 1, later);
        logger.info({ tweetId, nextAttemptAt: later }, "Tweet not found yet. Scheduling ONE final delayed retry.");
      } else {
        const failedTweet = await prisma.tweet.update({
          where: { id: tweetId },
          data: { status: 'RESOLVE_FAILED', posted: false, posted_at: null }
        });
        logger.error({ tweetId }, "Tweet not found after all retries. Marked RESOLVE_FAILED — fingerprint destroyed or tweet never posted.");
        await updateTelegramFinalStatus(
          failedTweet.telegram_chat_id,
          failedTweet.telegram_message_id,
          tweetId,
          buildDraftTelegramText(tweet, expectedDraft, "↩️ Not Posted")
        );
      }
    }
  } catch (error: any) {
    const message = error instanceof Error ? error.message : String(error);
    const logFn = isConnectionError(error) ? logger.warn.bind(logger) : logger.error.bind(logger);
    logFn({ tweetId, err: message }, "Error during tweet resolution");
    throw error;
  } finally {
    activePolls.delete(tweetId);
  }
}

type ScrapeSource = {
  name: string;
  url: string;
  key: string;
  kind: 'nitter' | 'twitter';
};

async function pollTimelineForFingerprint(
  username: string,
  fp: string,
  expectedDraft: string,
  createdAfter: Date,
): Promise<{ tweetId: string, url: string } | null> {
  const baseHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache'
  };

  const nitterSources = shuffle(getNitterInstances())
    .filter(host => !isSourceCoolingDown(host))
    .map((host): ScrapeSource => ({
      name: `Nitter RSS (${host})`,
      url: `https://${host}/${username}/rss`,
      key: host,
      kind: 'nitter',
    }));

  const sources: ScrapeSource[] = [
    ...nitterSources,
    { name: 'Twitter Native', url: `https://twitter.com/${username}`, key: 'twitter.com', kind: 'twitter' }
  ];
  const failures: Array<{ source: string; status?: number; err?: string; len?: number }> = [];
  const checkedSources: string[] = [];
  const noMatchSources: string[] = [];

  for (const source of sources) {
    checkedSources.push(source.name);
    try {
      const headers = source.kind === 'nitter'
        ? {
          ...baseHeaders,
          'Accept': 'application/rss+xml, application/xml, text/xml, text/html;q=0.8',
          'Referer': `https://${source.key}/${username}`,
        }
        : {
          ...baseHeaders,
          'Accept': 'text/html,application/json',
        };

      const res = await fetch(source.url, {
        headers,
        signal: AbortSignal.timeout(8000)
      });

      if (!res.ok) {
        failures.push({ source: source.name, status: res.status });
        if (source.kind === 'nitter' && (res.status === 403 || res.status === 429 || res.status >= 500)) {
          coolDownSource(source.key);
        }
        logger.debug({ source: source.name, status: res.status }, "Scraping source returned error status");
        continue;
      }

      const text = await res.text();
      if (!text || text.length < 200) {
        failures.push({ source: source.name, len: text?.length });
        logger.debug({ source: source.name, len: text?.length }, "Empty or suspicious response from source");
        continue;
      }

      if (looksLikeChallengePage(text)) {
        failures.push({ source: source.name, err: "bot challenge page" });
        if (source.kind === 'nitter') coolDownSource(source.key);
        logger.debug({ source: source.name }, "Scraping source returned bot challenge page");
        continue;
      }

      const result = checkHtmlForFingerprint(text, fp, username, expectedDraft, createdAfter);
      if (result) return result;
      noMatchSources.push(source.name);
    } catch (err: any) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ source: source.name, err: message });
      if (source.kind === 'nitter') coolDownSource(source.key);
      logger.debug({ source: source.name, err: message }, "Scraping source fetch failed");
    }
  }

  logger.warn({ username, sourceCount: sources.length, checkedSources, noMatchSources, failures }, "Tweet fingerprint not found in scraping sources");
  return null;
}

function looksLikeChallengePage(content: string): boolean {
  const lower = content.slice(0, 5000).toLowerCase();
  return lower.includes('anubis') ||
    lower.includes('checking your browser') ||
    lower.includes('just a moment') ||
    lower.includes('enable javascript') ||
    lower.includes('requires javascript');
}

function normalizeScrapedContent(content: string): string {
  return content
    .replace(/&#8203;|&#x200b;/gi, '\u200B')
    .replace(/&#8204;|&#x200c;/gi, '\u200C')
    .replace(/\\u200b/gi, '\u200B')
    .replace(/\\u200c/gi, '\u200C');
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function decodeJsonString(value: string): string {
  try {
    return JSON.parse(`"${value.replace(/"/g, '\\"')}"`);
  } catch {
    return value
      .replace(/\\"/g, '"')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\\//g, '/');
  }
}

function stripInvisible(value: string): string {
  return value.replace(/[\u200B\u200C]/g, '');
}

function normalizeVisibleText(value: string): string {
  return stripInvisible(decodeHtmlEntities(value))
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[^\p{L}\p{N}%]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function visibleTextMatches(candidateText: string, expectedDraft: string): boolean {
  const candidate = normalizeVisibleText(candidateText);
  const expected = normalizeVisibleText(expectedDraft);
  if (candidate.length < 40 || expected.length < 40) return false;

  const expectedPrefix = expected.slice(0, Math.min(120, expected.length));
  if (candidate.includes(expectedPrefix) || expected.includes(candidate.slice(0, Math.min(120, candidate.length)))) {
    return true;
  }

  const candidateTokens = new Set(candidate.split(' ').filter((token) => token.length > 2));
  const expectedTokens = new Set(expected.split(' ').filter((token) => token.length > 2));
  if (candidateTokens.size === 0 || expectedTokens.size === 0) return false;

  let overlap = 0;
  for (const token of candidateTokens) {
    if (expectedTokens.has(token)) overlap++;
  }

  return overlap / Math.min(candidateTokens.size, expectedTokens.size) >= 0.82;
}

function hexToInvisibleSuffix(fingerprint: string): string {
  const INVISIBLE_MAP: Record<string, string> = { '0': '\u200B', '1': '\u200C' };
  let invisibleSuffix = '';
  for (let i = 0; i < fingerprint.length; i++) {
    const hexDigit = fingerprint.charAt(i);
    const binary = parseInt(hexDigit, 16).toString(2).padStart(4, '0');
    for (let j = 0; j < binary.length; j++) {
      invisibleSuffix += INVISIBLE_MAP[binary.charAt(j)];
    }
  }
  return invisibleSuffix;
}

function containsFingerprintRun(content: string, fingerprint: string): boolean {
  const invisibleRunRegex = /[\u200B\u200C]{32,}/g;
  const target = fingerprint.toLowerCase();
  for (const match of content.matchAll(invisibleRunRegex)) {
    const run = match[0];
    for (let offset = 0; offset <= run.length - 32; offset++) {
      const hex = extractFingerprintHex(run.slice(offset, offset + 32));
      if (hex?.toLowerCase() === target) return true;
    }
  }
  return false;
}

function containsTolerantFingerprintRun(content: string, fingerprint: string, expectedDraft: string): boolean {
  const invisibleRunRegex = /[\u200B\u200C]{28,31}/g;
  const target = fingerprint.toLowerCase();
  for (const match of content.matchAll(invisibleRunRegex)) {
    const run = match[0];
    const hex = extractFingerprintHex(run);
    if (!hex || hex.length < 7 || !target.startsWith(hex.toLowerCase())) continue;

    const snippet = content.substring(Math.max(0, match.index - 700), match.index + run.length + 700);
    if (visibleTextMatches(snippet, expectedDraft)) return true;
  }
  return false;
}

type ScrapedTweetCandidate = {
  tweetId: string;
  text: string;
  createdAt: Date | null;
};

function parseCandidateDate(value: string | undefined): Date | null {
  if (!value) return null;
  const decoded = decodeHtmlEntities(decodeJsonString(value));
  const parsed = new Date(decoded);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isRecentCandidate(candidate: ScrapedTweetCandidate, createdAfter: Date): boolean {
  const candidateTime = candidate.createdAt?.getTime() ?? parseTweetSnowflakeTime(candidate.tweetId);
  if (candidateTime === null) return false;
  const lowerBound = createdAfter.getTime() - 10 * 60 * 1000;
  const upperBound = Date.now() + 10 * 60 * 1000;
  return candidateTime >= lowerBound && candidateTime <= upperBound;
}

function parseTweetSnowflakeTime(tweetId: string): number | null {
  try {
    const id = BigInt(tweetId);
    const twitterEpochMs = 1288834974657n;
    const timestampMs = (id >> 22n) + twitterEpochMs;
    const asNumber = Number(timestampMs);
    return Number.isFinite(asNumber) ? asNumber : null;
  } catch {
    return null;
  }
}

function extractTweetCandidates(content: string, username: string): ScrapedTweetCandidate[] {
  const candidates = new Map<string, ScrapedTweetCandidate>();
  const normalized = normalizeScrapedContent(content);

  const xJsonPattern = /"(?:full_text|text)"\s*:\s*"((?:\\.|[^"\\])*)"[\s\S]{0,1200}?"id_str"\s*:\s*"(\d+)"[\s\S]{0,1200}?"created_at"\s*:\s*"((?:\\.|[^"\\])*)"/g;
  for (const match of normalized.matchAll(xJsonPattern)) {
    const rawText = match[1];
    const tweetId = match[2];
    if (!rawText || !tweetId) continue;
    const text = decodeHtmlEntities(decodeJsonString(rawText));
    candidates.set(tweetId, {
      tweetId,
      text,
      createdAt: parseCandidateDate(match[3]),
    });
  }

  const xJsonDateAfterPattern = /"created_at"\s*:\s*"((?:\\.|[^"\\])*)"[\s\S]{0,1200}?"(?:full_text|text)"\s*:\s*"((?:\\.|[^"\\])*)"[\s\S]{0,1200}?"id_str"\s*:\s*"(\d+)"/g;
  for (const match of normalized.matchAll(xJsonDateAfterPattern)) {
    const rawText = match[2];
    const tweetId = match[3];
    if (!rawText || !tweetId) continue;
    const text = decodeHtmlEntities(decodeJsonString(rawText));
    candidates.set(tweetId, {
      tweetId,
      text,
      createdAt: parseCandidateDate(match[1]),
    });
  }

  const looseTextIdPattern = /"(?:full_text|text)"\s*:\s*"((?:\\.|[^"\\])*)"[\s\S]{0,1200}?"id_str"\s*:\s*"(\d+)"/g;
  for (const match of normalized.matchAll(looseTextIdPattern)) {
    const rawText = match[1];
    const tweetId = match[2];
    if (!rawText || !tweetId || candidates.has(tweetId)) continue;
    const text = decodeHtmlEntities(decodeJsonString(rawText));
    const start = match.index ?? 0;
    const context = normalized.substring(Math.max(0, start - 1200), start + match[0].length + 1200);
    const createdAtMatch = context.match(/"created_at"\s*:\s*"((?:\\.|[^"\\])*)"/);
    candidates.set(tweetId, {
      tweetId,
      text,
      createdAt: parseCandidateDate(createdAtMatch?.[1]),
    });
  }

  const itemPattern = /<item\b[\s\S]*?<\/item>/gi;
  for (const itemMatch of normalized.matchAll(itemPattern)) {
    const item = itemMatch[0];
    const link = item.match(new RegExp(`https?://[^<"]+/${username}/status/(\\d+)`, 'i'));
    const title = item.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>|<title>([\s\S]*?)<\/title>/i);
    if (!link || !title) continue;
    const pubDate = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/i);
    const tweetId = link[1];
    if (!tweetId) continue;
    candidates.set(tweetId, {
      tweetId,
      text: decodeHtmlEntities(title[1] || title[2] || ''),
      createdAt: parseCandidateDate(pubDate?.[1]),
    });
  }

  return [...candidates.values()];
}

function findVisibleTextCandidate(
  content: string,
  username: string,
  expectedDraft: string,
  createdAfter: Date,
): ScrapedTweetCandidate | null {
  for (const candidate of extractTweetCandidates(content, username)) {
    if (!isRecentCandidate(candidate, createdAfter)) continue;
    if (visibleTextMatches(candidate.text, expectedDraft)) return candidate;
  }
  return null;
}

function checkHtmlForFingerprint(
  content: string,
  fingerprint: string,
  username: string,
  expectedDraft: string,
  createdAfter: Date,
) {
    // A primitive check:
    // Since fingerprint zeroes/ones map to \u200B and \u200C, let's rebuild the invisible string to search exactly.
    const normalizedContent = normalizeScrapedContent(content);
    const invisibleSuffix = hexToInvisibleSuffix(fingerprint);

    if (normalizedContent.indexOf(invisibleSuffix) !== -1 || containsFingerprintRun(normalizedContent, fingerprint)) {
        // Match found! We need the tweet ID.
        // We can do a rudimentary regex around the invisible match to find status ID.
        // E.g. searching for `status/1234567890` nearby.
        const matchIndex = normalizedContent.indexOf(invisibleSuffix);
        const snippetStart = matchIndex === -1 ? 0 : Math.max(0, matchIndex - 1000);
        const snippetEnd = matchIndex === -1 ? normalizedContent.length : matchIndex + 1000;
        const snippet = normalizedContent.substring(snippetStart, snippetEnd);
        
        // Find /status/12345...
        const statusRegex = new RegExp(`/${username}/status/(\\d+)`, 'i');
        const m = snippet.match(statusRegex);
        if (m && m[1]) {
            return {
                tweetId: m[1],
                url: `https://twitter.com/${username}/status/${m[1]}`
            };
        }

        const candidate = findVisibleTextCandidate(normalizedContent, username, expectedDraft, createdAfter);
        if (candidate) {
          return {
            tweetId: candidate.tweetId,
            url: `https://twitter.com/${username}/status/${candidate.tweetId}`
          };
        }
    }

    if (expectedDraft && containsTolerantFingerprintRun(normalizedContent, fingerprint, expectedDraft)) {
      const candidate = findVisibleTextCandidate(normalizedContent, username, expectedDraft, createdAfter);
      if (candidate) {
        logger.info({ tweetId: candidate.tweetId, fingerprint }, "Resolved tweet via tolerant fingerprint match");
        return {
          tweetId: candidate.tweetId,
          url: `https://twitter.com/${username}/status/${candidate.tweetId}`
        };
      }
    }

    if (expectedDraft) {
      const candidate = findVisibleTextCandidate(normalizedContent, username, expectedDraft, createdAfter);
      if (candidate) {
        logger.info({ tweetId: candidate.tweetId }, "Resolved tweet via visible-text fallback");
        return {
          tweetId: candidate.tweetId,
          url: `https://twitter.com/${username}/status/${candidate.tweetId}`
        };
      }
    }
    return null;
}

function retryPayloadTweetId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const tweetId = (payload as { tweetId?: unknown }).tweetId;
  return typeof tweetId === 'string' ? tweetId : null;
}

export async function enqueueRetry(taskType: string, payload: any, attempt: number, processAfter?: Date, maxRetries: number = 5) {
  const task = await prisma.retryQueue.create({
    data: {
      task_type: taskType,
      payload: payload,
      attempts: attempt,
      max_retries: maxRetries,
      process_after: processAfter || new Date()
    }
  });

  if (workerStarted) {
    scheduleWorkerTick(getDelayUntil(task.process_after));
  }

  return task;
}

export async function enqueueResolveTweetIfNeeded(
  payload: { tweetId: string; username?: string | undefined },
  processAfter: Date,
) {
  const pendingResolveTasks = await prisma.retryQueue.findMany({
    where: {
      task_type: 'RESOLVE_TWEET',
      status: 'PENDING',
    },
    select: {
      id: true,
      payload: true,
      attempts: true,
      process_after: true,
    },
    orderBy: [{ process_after: 'asc' }, { created_at: 'asc' }],
  });

  const existing = pendingResolveTasks.find(
    (task) => retryPayloadTweetId(task.payload) === payload.tweetId,
  );

  if (existing) {
    if (workerStarted) {
      scheduleWorkerTick(getDelayUntil(existing.process_after));
    }
    return { created: false, task: existing };
  }

  const task = await enqueueRetry('RESOLVE_TWEET', payload, 1, processAfter);
  return { created: true, task };
}

// Track last reweight time in-memory (6h gate). Start the clock at boot so
// feedback reweighting never competes with startup or first queue discovery.
let lastReweightAt = Date.now();
let workerStarted = false;
let workerTickRunning = false;
let workerTimer: NodeJS.Timeout | null = null;
let requestedWorkerDelayMs: number | null = null;
let workerDelayMs = 15 * 60_000;

const WORKER_TASK_BATCH_SIZE = 3;
const MIN_WORKER_DELAY_MS = 1_000;
const IDLE_RECHECK_MS = 15 * 60_000;
const CONNECTION_ERROR_BASE_WAIT_MS = 2 * 60_000;
const CONNECTION_ERROR_MAX_WAIT_MS = 15 * 60_000;
const FEEDBACK_REWEIGHT_INTERVAL_MS = 6 * 60 * 60_000;

function clampWorkerDelay(delayMs: number): number {
  if (!Number.isFinite(delayMs)) return IDLE_RECHECK_MS;
  return Math.max(MIN_WORKER_DELAY_MS, Math.min(delayMs, IDLE_RECHECK_MS));
}

function getDelayUntil(processAfter: Date): number {
  return clampWorkerDelay(processAfter.getTime() - Date.now());
}

function scheduleWorkerTick(delayMs: number): void {
  if (!workerStarted) return;

  const nextDelayMs = clampWorkerDelay(delayMs);
  if (workerTickRunning) {
    requestedWorkerDelayMs = Math.min(requestedWorkerDelayMs ?? nextDelayMs, nextDelayMs);
    return;
  }

  if (workerTimer) clearTimeout(workerTimer);
  workerDelayMs = nextDelayMs;
  workerTimer = setTimeout(() => {
    workerTimer = null;
    void scheduledWorkerTick();
  }, nextDelayMs);
}

function consumeRequestedWorkerDelay(fallbackDelayMs: number): number {
  const requested = requestedWorkerDelayMs;
  requestedWorkerDelayMs = null;
  return requested === null ? fallbackDelayMs : Math.min(fallbackDelayMs, requested);
}

async function getNextPendingTaskDelay(): Promise<number> {
  const nextTask = await prisma.retryQueue.findFirst({
    where: { status: 'PENDING' },
    select: { process_after: true },
    orderBy: [{ process_after: 'asc' }, { created_at: 'asc' }]
  });

  return nextTask ? getDelayUntil(nextTask.process_after) : IDLE_RECHECK_MS;
}

async function processWorkerTick(): Promise<TickResult> {
  try {
    const pendingTasks = await prisma.retryQueue.findMany({
      where: { status: 'PENDING' },
      take: WORKER_TASK_BATCH_SIZE,
      orderBy: [{ process_after: 'asc' }, { created_at: 'asc' }]
    });

    const now = Date.now();
    const dueTasks = pendingTasks.filter((task) => task.process_after.getTime() <= now);

    if (dueTasks.length === 0) {
      if (now - lastReweightAt >= FEEDBACK_REWEIGHT_INTERVAL_MS) {
        try {
          await reweightFeedback();
          lastReweightAt = Date.now();
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error({ err: message }, "Scheduled reweightFeedback failed");
        }
      }

      const nextTask = pendingTasks[0];
      return {
        ok: true,
        connectionError: false,
        nextDelayMs: nextTask ? getDelayUntil(nextTask.process_after) : IDLE_RECHECK_MS
      };
    }

    for (const task of dueTasks) {
      await new Promise(r => setTimeout(r, 200)); // Timeout for Stability
      const payload = task.payload as any;

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
        const connectionError = isConnectionError(e);
        const logFn = connectionError ? logger.warn.bind(logger) : logger.error.bind(logger);
        logFn({ id: task.id, taskType: task.task_type, connectionError, err: message }, "Task processing failed");
        if (connectionError) {
          await prisma.retryQueue.update({
            where: { id: task.id },
            data: {
              status: 'PENDING',
              last_error: message,
              process_after: new Date(Date.now() + CONNECTION_ERROR_BASE_WAIT_MS)
            }
          });
        } else if (task.attempts >= task.max_retries) {
          await prisma.retryQueue.update({ where: { id: task.id }, data: { status: 'FAILED', last_error: message } });
        } else {
          await prisma.retryQueue.update({ where: { id: task.id }, data: { status: 'PENDING', attempts: task.attempts + 1 } });
        }
      }
    }

    const nextDelayMs =
      dueTasks.length === WORKER_TASK_BATCH_SIZE
        ? MIN_WORKER_DELAY_MS
        : await getNextPendingTaskDelay();

    return { ok: true, connectionError: false, nextDelayMs };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      connectionError: isConnectionError(e),
      nextDelayMs: CONNECTION_ERROR_BASE_WAIT_MS,
      err: message
    };
  }
}

async function scheduledWorkerTick() {
  if (workerTickRunning) {
    scheduleWorkerTick(workerDelayMs);
    return;
  }

  workerTickRunning = true;
  const result = await processWorkerTick();
  workerTickRunning = false;

  if (result.ok) {
    consecutiveDbFailures = 0;
    scheduleWorkerTick(consumeRequestedWorkerDelay(result.nextDelayMs));
    return;
  }

  if (result.connectionError) {
    consecutiveDbFailures++;
    const retryInMs = Math.min(
      CONNECTION_ERROR_BASE_WAIT_MS * 2 ** Math.max(consecutiveDbFailures - 1, 0),
      CONNECTION_ERROR_MAX_WAIT_MS
    );

    if (consecutiveDbFailures >= 5) {
      logger.error(
        { consecutiveDbFailures, err: result.err, retryInMs },
        'CRITICAL: DB unreachable for 5 consecutive worker checks - check Supabase Network Bans and DATABASE_URL stability params'
      );
      consecutiveDbFailures = 0;
    } else if (consecutiveDbFailures >= 3) {
      logger.warn(
        { consecutiveDbFailures, err: result.err, retryInMs },
        'Worker DB unavailable; backing off'
      );
    }

    scheduleWorkerTick(consumeRequestedWorkerDelay(retryInMs));
    return;
  }

  logger.error({ err: result.err, retryInMs: workerDelayMs }, "Worker loop error");
  scheduleWorkerTick(consumeRequestedWorkerDelay(workerDelayMs));
}

// Background scheduler
export function runWorker(): boolean {
  if (workerStarted) return false;
  workerStarted = true;
  logger.info({ idleRecheckMs: IDLE_RECHECK_MS }, "Worker scheduler started");
  scheduleWorkerTick(MIN_WORKER_DELAY_MS);
  return true;
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
        const replies = Number(data?.conversation_count || 0);

        // Every fetch should INSERT a new row
        await prisma.engagement.create({
          data: {
            tweet_id: tweetId,
            likes,
            retweets,
            replies,
            fetched_at: new Date()
          }
        });

        logger.info({ tweetId, likes, retweets, replies, attempt }, "Engagement tracking snapshot stored");

        // Schedule additional fetches (10m -> 1h -> 6h -> 24h -> 48h -> 72h)
        let nextFetchDelay = 0;
        if (attempt === 1) nextFetchDelay = 50 * 60 * 1000; // 10m + 50m = 1h
        else if (attempt === 2) nextFetchDelay = 5 * 60 * 60 * 1000; // 1h + 5h = 6h
        else if (attempt === 3) nextFetchDelay = 18 * 60 * 60 * 1000; // 6h + 18h = 24h
        else if (attempt === 4) nextFetchDelay = 24 * 60 * 60 * 1000; // 24h + 24h = 48h (Day 2)
        else if (attempt === 5) nextFetchDelay = 24 * 60 * 60 * 1000; // 48h + 24h = 72h (Day 3)

        if (attempt === 6) {
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
          await enqueueRetry("FETCH_ENGAGEMENT", { tweetId, username }, attempt + 1, nextFetchDate, 6);
          logger.info({ tweetId, nextFetchDate }, "Scheduled next engagement fetch.");
        }

      } else {
        logger.warn({ tweetId, status: res.status, attempt }, "Failed to fetch engagement from source");
        throw new Error(`Source returned status ${res.status}`);
      }
    } catch (error: any) {
      const message = error instanceof Error ? error.message : String(error);
      const logFn = isConnectionError(error) ? logger.warn.bind(logger) : logger.error.bind(logger);
      logFn({ tweetId, err: message, attempt }, "Engagement fetch failed.");
      throw error;
    }
}
