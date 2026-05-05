const DEFAULT_X_POST_CHAR_LIMIT = 280;
const FINGERPRINT_HEX_CHARS = 8;
const BITS_PER_HEX_CHAR = 4;
const FINGERPRINT_SEPARATOR_CHARS = 1;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function getConfiguredXPostCharLimit(): number {
  return parsePositiveInt(process.env.X_POST_CHAR_LIMIT, DEFAULT_X_POST_CHAR_LIMIT);
}

export function getFingerprintCharBudget(invisibleFingerprintLength = FINGERPRINT_HEX_CHARS * BITS_PER_HEX_CHAR): number {
  return invisibleFingerprintLength > 0
    ? invisibleFingerprintLength + FINGERPRINT_SEPARATOR_CHARS
    : 0;
}

export function getVisibleDraftCharLimit(invisibleFingerprintLength = FINGERPRINT_HEX_CHARS * BITS_PER_HEX_CHAR): number {
  return Math.max(1, getConfiguredXPostCharLimit() - getFingerprintCharBudget(invisibleFingerprintLength));
}

export function getVisibleLength(text: string): number {
  return (text ?? '').replace(/[\u200B\u200C]+/g, '').trim().length;
}

export function getPostLength(text: string): number {
  return (text ?? '').trim().length;
}

export function fitVisibleDraftToLimit(
  text: string,
  limit = getVisibleDraftCharLimit(),
): { draft: string; changed: boolean; originalLength: number; finalLength: number } {
  const visible = (text ?? '').replace(/[\u200B\u200C]+/g, '').trim();
  const originalLength = visible.length;
  if (originalLength <= limit) {
    return { draft: visible, changed: false, originalLength, finalLength: originalLength };
  }

  let candidate = visible.slice(0, limit).trimEnd();
  const punctuationIndexes = ['.', '!', '?']
    .map((char) => candidate.lastIndexOf(char))
    .filter((index) => index >= 40);
  const lastSentenceEnd = punctuationIndexes.length > 0 ? Math.max(...punctuationIndexes) : -1;

  if (lastSentenceEnd >= 40) {
    candidate = candidate.slice(0, lastSentenceEnd + 1).trim();
  } else {
    const lastSpace = candidate.lastIndexOf(' ');
    if (lastSpace >= 40) {
      candidate = candidate.slice(0, lastSpace).trimEnd();
    }
    if (!/[.!?]["')\]]?$/.test(candidate)) {
      candidate = candidate.slice(0, Math.max(0, limit - 1)).trimEnd();
      candidate = `${candidate}.`;
    }
  }

  if (candidate.length > limit) {
    candidate = candidate.slice(0, limit).trimEnd();
  }

  return {
    draft: candidate,
    changed: true,
    originalLength,
    finalLength: candidate.length,
  };
}
