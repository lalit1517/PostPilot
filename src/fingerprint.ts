// Handles the generation and extraction of invisible fingerprints for content attribution.
// Encodes unique 32-bit identifiers into zero-width sequences to track text content sources.

import * as crypto from 'crypto';
import { prisma } from './db.js';

// Mapping used:
// '0' -> \u200B (Zero Width Space)
// '1' -> \u200C (Zero Width Non-Joiner)
const INVISIBLE_MAP: Record<string, string> = {
  '0': '\u200B',
  '1': '\u200C'
};

const REVERSE_MAP: Record<string, string> = {
  '\u200B': '0',
  '\u200C': '1'
};

function hexToInvisible(hex: string): string {
  let invisible = '';
  for (let i = 0; i < hex.length; i++) {
    const hexDigit = hex.charAt(i);
    const binary = parseInt(hexDigit, 16).toString(2).padStart(4, '0');
    for (let j = 0; j < binary.length; j++) {
      invisible += INVISIBLE_MAP[binary.charAt(j)];
    }
  }
  return invisible;
}

/**
 * Generates an invisible fingerprint from a random 4-byte hex string (32 bits).
 * Returns an object with:
 *   - hex: the original hex string
 *   - invisible: the invisible string to append to the tweet
 */
export function generateFingerprint(): { hex: string, invisible: string } {
  const hex = crypto.randomBytes(4).toString('hex');
  return { hex, invisible: hexToInvisible(hex) };
}

/**
 * Generates a fingerprint guaranteed to be unique in the Tweet table.
 * Retries up to `maxAttempts` times on collision before throwing.
 */
export async function generateUniqueFingerprint(maxAttempts = 5): Promise<{ hex: string, invisible: string }> {
  for (let i = 0; i < maxAttempts; i++) {
    const hex = crypto.randomBytes(4).toString('hex');
    const existing = await prisma.tweet.findUnique({
      where: { fingerprint: hex },
      select: { id: true }
    });
    if (!existing) {
      return { hex, invisible: hexToInvisible(hex) };
    }
  }
  throw new Error(`generateUniqueFingerprint: failed after ${maxAttempts} attempts`);
}

/**
 * Appends the invisible fingerprint to the tweet content.
 */
export function appendFingerprint(content: string, invisibleFingerprint: string): string {
  // Append after a regular space to make sure it doesn't mess with final characters
  return content.trim() + ' ' + invisibleFingerprint;
}

/**
 * Extracts the invisible fingerprint from a tweet string (if any),
 * returning the original hex value. Returns null if not found.
 */
export function extractFingerprintHex(tweetContent: string): string | null {
  const invisibleChars = Object.keys(REVERSE_MAP);
  let binaryStr = '';

  for (let i = 0; i < tweetContent.length; i++) {
    const char = tweetContent.charAt(i);
    if (invisibleChars.includes(char)) {
      binaryStr += REVERSE_MAP[char];
    }
  }

  if (binaryStr.length === 0) return null;

  // Ensure it's a multiple of 4
  if (binaryStr.length % 4 !== 0) {
    // Attempt to slice it or pad it? Usually a match will be exactly 32 bits if not tampered
    // Let's just try to parse what we can
    const remainder = binaryStr.length % 4;
    binaryStr = binaryStr.slice(0, binaryStr.length - remainder);
  }

  let hexStr = '';
  for (let i = 0; i < binaryStr.length; i += 4) {
    const nibble = binaryStr.substring(i, i + 4);
    hexStr += parseInt(nibble, 2).toString(16);
  }

  return hexStr !== '' ? hexStr : null;
}
