export interface FormatArchetype {
  name: string;
  description: string;
  structureExample: string;
}

export const FORMAT_ARCHETYPES: readonly FormatArchetype[] = [
  {
    name: 'HOT_TAKE',
    description: 'Lead with a sharp, opinionated claim. One assertion, one or two lines of backing. No story arc, no setup.',
    structureExample: '[bold claim]. [one line of reason or consequence].',
  },
  {
    name: 'QUESTION_HOOK',
    description: 'Open with a direct question aimed at the reader. Follow with a short stance or a reframing, not an answer.',
    structureExample: '[question aimed at reader]? [short reframe or stance].',
  },
  {
    name: 'STORY_LESSON',
    description: 'Micro-narrative in 2-3 beats ending in a takeaway. No time-struggle opener ("spent X hours" is banned here).',
    structureExample: '[action/scene]. [turn]. [takeaway without moralizing].',
  },
  {
    name: 'CONTRARIAN_FACT',
    description: 'State a common belief, then flip it with a concrete counter-observation. No self-deprecation, no joke ending.',
    structureExample: 'everyone says [X]. actually [counter-observation with detail].',
  },
  {
    name: 'NUMBERED_INSIGHT',
    description: 'Lead with a specific number or metric, then unpack what it implies. Data first, commentary second.',
    structureExample: '[specific number + what it measures]. [implication in plain words].',
  },
  {
    name: 'PERSONAL_WIN',
    description: 'Report a concrete shipped result or milestone without a struggle framing. Celebratory or flat, not self-pitying.',
    structureExample: '[shipped thing + what it does]. [one line of context, not a lesson].',
  },
  {
    name: 'RANT',
    description: 'Escalating frustration about a dev-culture pattern. No realization arc, no redemption ending. Stays annoyed.',
    structureExample: '[frustration trigger]. [escalation]. [final blunt line, no lesson].',
  },
  {
    name: 'OBSERVATION',
    description: 'Noticing-something-out-loud energy. No struggle, no lesson, no punchline. Just the noticed thing, sharply phrased.',
    structureExample: '[thing noticed about dev/tech/tool]. [why it is interesting or weird].',
  },
] as const;

const FORMAT_NAME_SET: ReadonlySet<string> = new Set(FORMAT_ARCHETYPES.map((f) => f.name));

const RECENT_WINDOW = 4;

function lastIndexOfFormat(fingerprints: readonly string[], formatName: string): number {
  for (let i = fingerprints.length - 1; i >= 0; i--) {
    const fp = fingerprints[i];
    if (typeof fp === 'string' && fp.startsWith(`FORMAT:${formatName}`)) {
      return i;
    }
  }
  return -1;
}

function hashString(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Returns the least-recently-used archetype that has not been used in the last
 * RECENT_WINDOW fingerprints. Pure and deterministic for the same inputs.
 * Falls back to a hash-seeded deterministic pick across all archetypes when
 * every format has been used within the recent window.
 */
export function getNextFormat(recentFingerprints: readonly string[]): FormatArchetype {
  const fingerprints = recentFingerprints.filter(
    (fp): fp is string => typeof fp === 'string' && fp.length > 0,
  );

  const lastIndexInWindow = new Map<string, number>();
  const windowStart = Math.max(0, fingerprints.length - RECENT_WINDOW);
  for (let i = windowStart; i < fingerprints.length; i++) {
    for (const archetype of FORMAT_ARCHETYPES) {
      const fp = fingerprints[i];
      if (fp !== undefined && fp.startsWith(`FORMAT:${archetype.name}`)) {
        lastIndexInWindow.set(archetype.name, i);
      }
    }
  }

  const unused = FORMAT_ARCHETYPES.filter((a) => !lastIndexInWindow.has(a.name));

  if (unused.length > 0) {
    const ranked = [...unused].sort((a, b) => {
      const aLast = lastIndexOfFormat(fingerprints, a.name);
      const bLast = lastIndexOfFormat(fingerprints, b.name);
      if (aLast !== bLast) return aLast - bLast;
      return a.name.localeCompare(b.name);
    });
    const pick = ranked[0];
    if (pick) return pick;
  }

  const seed = fingerprints.length > 0
    ? hashString(fingerprints.join('|'))
    : 0;
  const idx = seed % FORMAT_ARCHETYPES.length;
  const fallback = FORMAT_ARCHETYPES[idx] ?? FORMAT_ARCHETYPES[0];
  if (!fallback) {
    throw new Error('FORMAT_ARCHETYPES is empty');
  }
  return fallback;
}

export function isKnownFormat(name: string): boolean {
  return FORMAT_NAME_SET.has(name);
}
