import { logger } from './logger.js';

interface TrendCache {
  fetched_at: number;
  trends: string[];
}

let cache: TrendCache | null = null;
let consecutiveZeroFetches = 0;
const CACHE_TTL_MS = 30 * 60_000;
const FETCH_TIMEOUT_MS = 8_000;
const ZERO_FETCH_ALERT_THRESHOLD = 3;

const TRENDS24_URL = 'https://trends24.in/';

function parseTrends(html: string): string[] {
  const items: string[] = [];
  const liRegex = /<li[^>]*>\s*<a[^>]*>([^<]+)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = liRegex.exec(html)) !== null) {
    const raw = (m[1] ?? '').trim();
    if (!raw) continue;
    if (raw.startsWith('#')) {
      items.push(raw.slice(1));
    } else if (!/^\d+[KM]?$/i.test(raw)) {
      items.push(raw);
    }
  }
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const t of items) {
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(t);
    if (deduped.length >= 20) break;
  }
  return deduped;
}

export async function getTrendingTopics(): Promise<string[]> {
  if (cache && Date.now() - cache.fetched_at < CACHE_TTL_MS) {
    logger.info({ count: cache.trends.length, age_ms: Date.now() - cache.fetched_at }, 'Trends cache hit');
    return cache.trends;
  }

  try {
    const res = await fetch(TRENDS24_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      logger.warn({ status: res.status }, 'Trends24 fetch non-OK');
      return cache?.trends ?? [];
    }

    const html = await res.text();
    const trends = parseTrends(html);

    if (trends.length === 0) {
      consecutiveZeroFetches++;
      if (consecutiveZeroFetches >= ZERO_FETCH_ALERT_THRESHOLD) {
        logger.error(
          { consecutiveZeroFetches },
          'CRITICAL: Trends24 parser returning 0 items for N consecutive fetches — site layout may have changed, check trends.ts parseTrends() regex',
        );
        // Drop stale cache so next request retries fresh.
        cache = null;
      } else {
        logger.warn({ consecutiveZeroFetches }, 'Trends24 parsed zero items; layout may have changed');
      }
      return cache?.trends ?? [];
    }

    consecutiveZeroFetches = 0;
    cache = { fetched_at: Date.now(), trends };
    logger.info({ count: trends.length }, 'Trends24 refreshed');
    return trends;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message }, 'Trends fetch failed, serving stale/empty');
    return cache?.trends ?? [];
  }
}
