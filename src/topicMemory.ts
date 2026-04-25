// In-memory topic cooldown + coherence failure counter.
// Survives DB outages; lost on restart (DB is long-term authoritative).

interface TopicEntry {
  topic: string;
  usedAt: number;
}

const TOPIC_COOLDOWN_MS = 48 * 60 * 60_000;
const MAX_TOPIC_MEMORY = 50;

const recentTopics: TopicEntry[] = [];
const coherenceFailureCounter = new Map<string, number>();

function normalizeTopic(topic: string): string {
  return topic.trim().toLowerCase();
}

function evictExpired(now: number): void {
  const cutoff = now - TOPIC_COOLDOWN_MS;
  while (recentTopics.length > 0) {
    const head = recentTopics[0];
    if (!head || head.usedAt >= cutoff) break;
    recentTopics.shift();
  }
  while (recentTopics.length > MAX_TOPIC_MEMORY) {
    recentTopics.shift();
  }
}

export function recordTopicUsed(topic: string): void {
  const normalized = normalizeTopic(topic);
  if (!normalized) return;
  const now = Date.now();
  evictExpired(now);
  const existing = recentTopics.findIndex((e) => e.topic === normalized);
  if (existing >= 0) {
    recentTopics.splice(existing, 1);
  }
  recentTopics.push({ topic: normalized, usedAt: now });
}

export function isTopicOnCooldown(topic: string): boolean {
  const normalized = normalizeTopic(topic);
  if (!normalized) return false;
  evictExpired(Date.now());
  return recentTopics.some((e) => e.topic === normalized);
}

export function getInMemoryBlacklist(): string[] {
  evictExpired(Date.now());
  return recentTopics.map((e) => e.topic);
}

/** @internal Test helper. Resets cooldown list + coherence counter. */
export function clearTopicMemory(): void {
  recentTopics.length = 0;
  coherenceFailureCounter.clear();
}

/**
 * Tracks coherence failures per topic. Returns the new count.
 * Caller should blacklist the topic when count >= 3.
 */
export function incrementCoherenceFailure(topic: string): number {
  const normalized = normalizeTopic(topic);
  if (!normalized) return 0;
  const next = (coherenceFailureCounter.get(normalized) ?? 0) + 1;
  coherenceFailureCounter.set(normalized, next);
  return next;
}

export function resetCoherenceFailure(topic: string): void {
  const normalized = normalizeTopic(topic);
  if (!normalized) return;
  coherenceFailureCounter.delete(normalized);
}
