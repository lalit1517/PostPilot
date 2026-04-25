import { prisma } from './db.js';
import { logger } from './logger.js';
import { guessFormatFromContent, isKnownFormat } from './draftFormats.js';

export const SIMILARITY_THRESHOLD = 0.65;
export const RECENT_DRAFT_COUNT = 20;
const STRUCTURAL_WINDOW = 5;
const FINGERPRINT_BUFFER_SIZE = 15;
const FORMAT_MAP_SIZE = 30;

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[​-‍﻿]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function trigrams(text: string): Set<string> {
  const normalized = normalize(text);
  const grams = new Set<string>();
  if (normalized.length < 3) {
    if (normalized.length > 0) grams.add(normalized);
    return grams;
  }
  for (let i = 0; i <= normalized.length - 3; i++) {
    grams.add(normalized.slice(i, i + 3));
  }
  return grams;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const g of a) {
    if (b.has(g)) inter++;
  }
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function classifyOpening(text: string): string {
  const clean = normalize(text);
  const firstWords = clean.split(' ').slice(0, 6).join(' ');

  if (/^(spent|wasted|used|burned|killed|sunk) \d+ ?(hour|hours|hr|hrs|minute|minutes|min|mins|day|days|week|weeks)\b/.test(firstWords)) {
    return 'TIME_STRUGGLE_OPEN';
  }
  if (/^(spent|wasted|used|burned) (a|an|the|my|all) .{0,30}?(hour|minute|day|week|afternoon|morning|night|evening)/.test(firstWords)) {
    return 'TIME_STRUGGLE_OPEN';
  }
  if (/^(why|what|how|when|where|who|is|are|can|should|would|could|do|does|did) \b/.test(firstWords) && /\?/.test(text.slice(0, 120))) {
    return 'QUESTION_OPEN';
  }
  if (/^(hot take|unpopular opinion|controversial|real talk|honest take|nobody talks about|nobody wants to admit)\b/.test(firstWords)) {
    return 'TAKE_OPEN';
  }
  if (/^(just|finally|today i|this morning|last night|yesterday|tonight)\b/.test(firstWords)) {
    return 'TEMPORAL_MARKER_OPEN';
  }
  if (/^\d+(\.\d+)?%?\b/.test(firstWords) || /^\d+ (of|out of|percent|times|years)\b/.test(firstWords)) {
    return 'NUMBER_OPEN';
  }
  if (/^(everyone|everybody|people|devs|nobody|no one) (says|thinks|believes|keeps|always|assumes|ignores|wants)\b/.test(firstWords)) {
    return 'CROWD_CLAIM_OPEN';
  }
  if (/^(you|your)\b/.test(firstWords)) {
    return 'SECOND_PERSON_OPEN';
  }
  if (/^(i|im|i'?m|ive|i've|i'?ve)\b/.test(firstWords)) {
    return 'FIRST_PERSON_OPEN';
  }
  if (/^(the|a|an) \w+ (is|are|was|were) /.test(firstWords)) {
    return 'DECLARATION_OPEN';
  }
  return 'GENERIC_OPEN';
}

function detectContrast(text: string): boolean {
  const lower = normalize(text);
  return /\b(but|however|turns out|turned out|only to|realized|realised|actually|except|in the end|surprisingly|plot twist)\b/.test(lower);
}

function detectLessonEnding(text: string): boolean {
  const clean = text.trim();
  const tail = clean.slice(Math.max(0, clean.length - 140)).toLowerCase();
  return /\b(lesson|takeaway|moral|the trick|the secret|turns out|so yeah|anyway|tldr|tl;dr|learned|reminder|morale of|moral of)\b/.test(tail);
}

function detectSelfDeprecation(text: string): boolean {
  const lower = normalize(text);
  return /\b(i'?m fine|im fine|im an idiot|i'?m an idiot|im dumb|i'?m dumb|lol i|im cooked|i'?m cooked|im washed|send help|it's fine|its fine|help me|why am i|why did i|i hate myself|classic me|typical|of course i did|rookie move|rookie mistake)\b/.test(lower);
}

function detectPunchlineEnding(text: string): boolean {
  const clean = text.trim();
  const lastSentenceMatch = clean.match(/([^.!?]+[.!?])\s*$/);
  if (!lastSentenceMatch) return false;
  const last = lastSentenceMatch[1];
  if (!last) return false;
  const lastLower = last.toLowerCase();
  return /\b(lol|lmao|lmfao|haha|ngl|fr|fr fr|no cap|im fine|its fine|help)\b/.test(lastLower) ||
    last.length < 30;
}

export function extractStructuralFingerprint(text: string): string {
  const opening = classifyOpening(text);
  const tokens: string[] = [`OPEN:${opening}`];
  if (detectContrast(text)) tokens.push('CONTRAST');
  if (detectLessonEnding(text)) tokens.push('LESSON');
  if (detectSelfDeprecation(text)) tokens.push('SELF_DEPRECATE');
  if (detectPunchlineEnding(text)) tokens.push('PUNCHLINE_END');
  return tokens.join('|');
}

export function composeFingerprint(formatName: string | null, observed: string): string {
  if (!formatName) return observed;
  return `FORMAT:${formatName}|${observed}`;
}

// Ring buffer of FORMAT-prefixed fingerprints. Fast path for format rotation.
// Lost on restart — DB fallback + format-map backfill cover that case.
const fingerprintBuffer: string[] = [];

export function pushFingerprintToBuffer(fingerprint: string): void {
  if (!fingerprint) return;
  fingerprintBuffer.push(fingerprint);
  while (fingerprintBuffer.length > FINGERPRINT_BUFFER_SIZE) {
    fingerprintBuffer.shift();
  }
}

/** @internal Test helper. Resets the in-process fingerprint ring buffer. */
export function clearFingerprintBuffer(): void {
  fingerprintBuffer.length = 0;
}

/*
 * Format-name map. Keyed by tweetId (preferred) or content hash (fallback).
 * Used to attach FORMAT: prefix when reading historical fingerprints from
 * TweetVersion — the schema does not persist format_name, so we remember it
 * in-process and heuristically backfill on restart.
 */
interface FormatMapEntry {
  formatName: string;
  registeredAt: number;
}

const formatMap = new Map<string, FormatMapEntry>();
let backfillDone = false;

export function registerDraftFormat(key: string, formatName: string): void {
  if (!key || !formatName) return;
  if (!isKnownFormat(formatName)) {
    logger.warn({ key, formatName }, 'registerDraftFormat: unknown format name; skipping');
    return;
  }
  if (formatMap.has(key)) formatMap.delete(key);
  formatMap.set(key, { formatName, registeredAt: Date.now() });
  while (formatMap.size > FORMAT_MAP_SIZE) {
    const oldestKey = formatMap.keys().next().value;
    if (!oldestKey) break;
    formatMap.delete(oldestKey);
  }
}

export function getRegisteredFormat(key: string): string | null {
  return formatMap.get(key)?.formatName ?? null;
}

/** @internal Test helper. Resets the format map + backfill flag. */
export function clearFormatMap(): void {
  formatMap.clear();
  backfillDone = false;
}

/**
 * Best-effort restoration of the format map after a restart by pattern-matching
 * recent draft content. Runs once per process. Silently no-ops on DB error.
 */
async function backfillFormatMap(): Promise<void> {
  if (backfillDone) return;
  backfillDone = true;
  try {
    const recent = await prisma.tweetVersion.findMany({
      orderBy: { created_at: 'desc' },
      take: FORMAT_MAP_SIZE,
      select: { tweet_id: true, content: true },
    });
    let recovered = 0;
    for (const row of recent) {
      if (formatMap.has(row.tweet_id)) continue;
      const guess = guessFormatFromContent(row.content);
      if (guess) {
        formatMap.set(row.tweet_id, {
          formatName: guess.name,
          registeredAt: Date.now(),
        });
        recovered++;
      }
    }
    logger.info(
      { recovered, scanned: recent.length },
      'draftDiversity: format map backfilled from TweetVersion',
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message }, 'draftDiversity: format map backfill failed');
  }
}

export interface DiversityReport {
  rejectionKind: 'text_similarity' | 'structural_fingerprint' | null;
  matchedFingerprint: string | null;
  sameFingerprintCountInRecent: number;
  recentConsidered: number;
}

export interface DiversityResult {
  duplicate: boolean;
  maxSimilarity: number;
  matchedTweetId: string | null;
  report: DiversityReport;
}

export async function checkDraftDiversity(
  draft: string,
  excludeTweetId?: string,
): Promise<DiversityResult> {
  const emptyReport: DiversityReport = {
    rejectionKind: null,
    matchedFingerprint: null,
    sameFingerprintCountInRecent: 0,
    recentConsidered: 0,
  };

  try {
    const where = excludeTweetId ? { tweet_id: { not: excludeTweetId } } : {};
    const recent = await prisma.tweetVersion.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: RECENT_DRAFT_COUNT,
      select: { content: true, tweet_id: true },
    });

    if (recent.length === 0) {
      return { duplicate: false, maxSimilarity: 0, matchedTweetId: null, report: emptyReport };
    }

    const target = trigrams(draft);
    const draftFingerprint = extractStructuralFingerprint(draft);

    let maxSim = 0;
    let matchedTweetId: string | null = null;

    const structuralFingerprints: string[] = recent.map((r) => extractStructuralFingerprint(r.content));

    for (let i = 0; i < recent.length; i++) {
      const row = recent[i];
      if (!row) continue;
      const sim = jaccard(target, trigrams(row.content));
      if (sim > maxSim) {
        maxSim = sim;
        matchedTweetId = row.tweet_id;
      }
    }

    const sameFingerprintCount = structuralFingerprints.filter((fp) => fp === draftFingerprint).length;

    const recentStructural = structuralFingerprints.slice(0, STRUCTURAL_WINDOW);
    const structuralDuplicate = recentStructural.includes(draftFingerprint);

    if (structuralDuplicate) {
      const report: DiversityReport = {
        rejectionKind: 'structural_fingerprint',
        matchedFingerprint: draftFingerprint,
        sameFingerprintCountInRecent: sameFingerprintCount,
        recentConsidered: recent.length,
      };
      logger.warn(
        {
          rejectionKind: report.rejectionKind,
          matchedFingerprint: report.matchedFingerprint,
          sameFingerprintCountInRecent: report.sameFingerprintCountInRecent,
          recentConsidered: report.recentConsidered,
          maxTextSimilarity: maxSim,
        },
        'DiversityReport: structural fingerprint match',
      );
      return {
        duplicate: true,
        maxSimilarity: maxSim,
        matchedTweetId,
        report,
      };
    }

    const textDuplicate = maxSim >= SIMILARITY_THRESHOLD;
    if (textDuplicate) {
      const report: DiversityReport = {
        rejectionKind: 'text_similarity',
        matchedFingerprint: draftFingerprint,
        sameFingerprintCountInRecent: sameFingerprintCount,
        recentConsidered: recent.length,
      };
      logger.warn(
        {
          rejectionKind: report.rejectionKind,
          maxSimilarity: maxSim,
          matchedTweetId,
          sameFingerprintCountInRecent: report.sameFingerprintCountInRecent,
          recentConsidered: report.recentConsidered,
        },
        'DiversityReport: text similarity over threshold',
      );
      return { duplicate: true, maxSimilarity: maxSim, matchedTweetId, report };
    }

    return {
      duplicate: false,
      maxSimilarity: maxSim,
      matchedTweetId,
      report: {
        rejectionKind: null,
        matchedFingerprint: draftFingerprint,
        sameFingerprintCountInRecent: sameFingerprintCount,
        recentConsidered: recent.length,
      },
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message }, 'Draft diversity check failed; allowing draft');
    return { duplicate: false, maxSimilarity: 0, matchedTweetId: null, report: emptyReport };
  }
}

/**
 * Return FORMAT-prefixed fingerprints for the last N tweets.
 * Merges in-memory ring buffer (fast path) with DB rows joined against the
 * format map (slow path). Format names come from the in-process registry;
 * rows missing a registration get a content-pattern guess so rotation still
 * works after a restart.
 */
export async function getRecentStructuralFingerprints(
  limit = FINGERPRINT_BUFFER_SIZE,
): Promise<string[]> {
  await backfillFormatMap();
  try {
    const recent = await prisma.tweetVersion.findMany({
      orderBy: { created_at: 'desc' },
      take: limit,
      select: { tweet_id: true, content: true },
    });

    const dbFingerprints = recent
      .map((r) => {
        const observed = extractStructuralFingerprint(r.content);
        const registered = getRegisteredFormat(r.tweet_id);
        if (registered) return composeFingerprint(registered, observed);
        const guess = guessFormatFromContent(r.content);
        return composeFingerprint(guess?.name ?? null, observed);
      })
      .reverse();

    const combined: string[] = [...dbFingerprints];
    for (const fp of fingerprintBuffer) {
      if (!combined.includes(fp)) combined.push(fp);
    }
    return combined.slice(-limit);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message }, 'getRecentStructuralFingerprints failed');
    return [...fingerprintBuffer].slice(-limit);
  }
}
