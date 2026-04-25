export interface FormatArchetype {
  name: string;
  description: string;
  structureExample: string;
  /** First-sentence shape instruction. Hard requirement the model must follow. */
  openingTemplate: string;
  /** Openings that make the draft INVALID. Lowercased substrings matched loosely. */
  bannedOpenings: string[];
  /** Optional extra banned phrases anywhere in the draft. */
  bannedPhrases?: string[];
  /** Short natural-language first-sentence example the model can imitate. */
  exampleFirstSentence: string;
}

export const FORMAT_ARCHETYPES: readonly FormatArchetype[] = [
  {
    name: 'HOT_TAKE',
    description:
      'Lead with a sharp, opinionated claim. One assertion, one or two lines of backing. No story arc, no setup.',
    structureExample: '[bold claim]. [one line of reason or consequence].',
    openingTemplate:
      "Start with a sharp factual claim. First word must NOT be 'Everyone', 'I', 'Just', or a time reference.",
    bannedOpenings: ['everyone says', 'spent', 'just ', 'hot take:', 'i spent', 'i wasted'],
    exampleFirstSentence: 'TypeScript strict mode is a debugging tool disguised as a type system.',
  },
  {
    name: 'QUESTION_HOOK',
    description:
      'Open with a direct question aimed at the reader. Follow with a short stance or a reframing, not an answer.',
    structureExample: '[question aimed at reader]? [short reframe or stance].',
    openingTemplate:
      "First character of the tweet MUST be a question word (Why/What/How/When/Is/Are/Can/Should) and the first sentence MUST end with '?'",
    bannedOpenings: ['everyone says', 'spent', 'i spent'],
    exampleFirstSentence: 'why does every AI agent framework reinvent retry loops?',
  },
  {
    name: 'STORY_LESSON',
    description:
      'Micro-narrative in 2-3 beats ending in a takeaway. No time-struggle opener ("spent X hours" is banned here).',
    structureExample: '[action/scene]. [turn]. [takeaway without moralizing].',
    openingTemplate:
      "Start with a specific action verb in past tense (shipped/broke/noticed/discovered/tried/built/fixed). NOT 'spent'.",
    bannedOpenings: ['spent ', 'wasted ', 'used ', 'burned ', 'killed ', 'sunk ', 'everyone says'],
    exampleFirstSentence: 'shipped a full agent pipeline today and the bug was a trailing space.',
  },
  {
    name: 'CONTRARIAN_FACT',
    description:
      'State a widely-held technical belief as a plain fact, then immediately flip it with a specific counter-observation. The belief must be stated directly — NOT attributed to "everyone" or "people". Lead with the misconception itself, not a crowd attribution. No self-deprecation, no struggle arc, no lesson ending.',
    structureExample:
      '[misconception stated as bare fact]. actually [specific counter-observation with a concrete detail or number]. [optional: one-line implication].',
    openingTemplate:
      "State a specific technical misconception without attributing it to 'everyone'. Start with the misconception itself, not 'everyone says X'.",
    bannedOpenings: [
      'everyone says',
      'everyone thinks',
      'everyone believes',
      'everybody says',
      'everybody thinks',
      'people say',
      'folks say',
      'most devs',
      'devs think',
      'the industry',
    ],
    bannedPhrases: ['everyone says', 'everybody says'],
    exampleFirstSentence:
      'TypeScript adds zero runtime safety. all the actual validation is still your job at the boundary.',
  },
  {
    name: 'NUMBERED_INSIGHT',
    description:
      'Lead with a specific number or metric, then unpack what it implies. Data first, commentary second.',
    structureExample: '[specific number + what it measures]. [implication in plain words].',
    openingTemplate:
      "First token MUST be a number (e.g., '90%', '3x', '47ms', '12 months'). Hard requirement.",
    bannedOpenings: ['everyone says', 'spent ', 'i spent'],
    exampleFirstSentence: '90% of my LLM bug reports are actually prompt bugs.',
  },
  {
    name: 'PERSONAL_WIN',
    description:
      'Report a concrete shipped result or milestone without a struggle framing. Celebratory or flat, not self-pitying.',
    structureExample: '[shipped thing + what it does]. [one line of context, not a lesson].',
    openingTemplate:
      "Start with a shipped artifact. 'built X', 'launched X', 'shipped X', 'just hit X'. Positive framing only.",
    bannedOpenings: ['everyone says', 'spent ', 'wasted', 'debugging', 'fighting', 'struggling'],
    exampleFirstSentence: 'shipped a tiny CLI that formats my prompt files on save.',
  },
  {
    name: 'RANT',
    description:
      'Escalating frustration about a dev-culture pattern. No realization arc, no redemption ending. Stays annoyed.',
    structureExample: '[frustration trigger]. [escalation]. [final blunt line, no lesson].',
    openingTemplate:
      "Start mid-frustration with 'why does', 'how is', 'can we talk about', 'nobody told me', 'the fact that'. Escalate. Do NOT resolve.",
    bannedOpenings: ['everyone says', 'spent '],
    exampleFirstSentence:
      'why does every AI tool ship a "chat with your docs" demo before fixing rate limits.',
  },
  {
    name: 'OBSERVATION',
    description:
      'Noticing-something-out-loud energy. No struggle, no lesson, no punchline. Just the noticed thing, sharply phrased.',
    structureExample: '[thing noticed about dev/tech/tool]. [why it is interesting or weird].',
    openingTemplate:
      "Start with 'noticed', 'realizing', 'turns out' as an observation clause, not a struggle opener.",
    bannedOpenings: ['everyone says', 'spent ', 'just '],
    exampleFirstSentence:
      'noticed the best AI dev tools are the ones that do one thing and shut up.',
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

export interface FormatSelection {
  selected: FormatArchetype;
  unusedCount: number;
  consideredRecentFormats: string[];
}

/**
 * Returns the least-recently-used archetype that has not been used in the last
 * RECENT_WINDOW fingerprints. Pure and deterministic for the same inputs.
 */
export function getNextFormatWithMeta(
  recentFingerprints: readonly string[],
): FormatSelection {
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

  const consideredRecentFormats = Array.from(lastIndexInWindow.keys());
  const unused = FORMAT_ARCHETYPES.filter((a) => !lastIndexInWindow.has(a.name));

  if (unused.length > 0) {
    const ranked = [...unused].sort((a, b) => {
      const aLast = lastIndexOfFormat(fingerprints, a.name);
      const bLast = lastIndexOfFormat(fingerprints, b.name);
      if (aLast !== bLast) return aLast - bLast;
      return a.name.localeCompare(b.name);
    });
    const pick = ranked[0];
    if (pick) {
      return { selected: pick, unusedCount: unused.length, consideredRecentFormats };
    }
  }

  const seed = fingerprints.length > 0 ? hashString(fingerprints.join('|')) : 0;
  const idx = seed % FORMAT_ARCHETYPES.length;
  const fallback = FORMAT_ARCHETYPES[idx] ?? FORMAT_ARCHETYPES[0];
  if (!fallback) {
    throw new Error('FORMAT_ARCHETYPES is empty');
  }
  return { selected: fallback, unusedCount: 0, consideredRecentFormats };
}

export function isKnownFormat(name: string): boolean {
  return FORMAT_NAME_SET.has(name);
}

export function getArchetypeByName(name: string): FormatArchetype | null {
  return FORMAT_ARCHETYPES.find((a) => a.name === name) ?? null;
}

/**
 * Heuristic format detector — used to backfill the fingerprint map on boot
 * from raw TweetVersion content (Map is lost on restart).
 *
 * Matches archetype opening patterns against draft content. Returns null when
 * no archetype clearly fits — caller stores a FORMAT-less fingerprint in that
 * case, which is correct (we don't know what format it was).
 */
export function guessFormatFromContent(content: string): FormatArchetype | null {
  const trimmed = content.trim().toLowerCase();
  const firstWords = trimmed.split(/\s+/).slice(0, 6).join(' ');
  const firstChar = trimmed.charAt(0);

  if (/^(why|what|how|when|where|is|are|can|should|would|could|do|does)\b/.test(firstWords) &&
      /\?/.test(trimmed.slice(0, 140))) {
    return getArchetypeByName('QUESTION_HOOK');
  }
  if (/^\d+(\.\d+)?%?(x|ms|s|m|h|d)?\b/.test(firstWords) ||
      /^[\d]+ (of|out of|percent|times|years|months)\b/.test(firstWords)) {
    return getArchetypeByName('NUMBERED_INSIGHT');
  }
  if (/^(spent|wasted|used|burned|killed|sunk) /.test(firstWords)) {
    return getArchetypeByName('STORY_LESSON');
  }
  if (/^(shipped|built|launched|just hit|just shipped|released|finished) /.test(firstWords)) {
    return getArchetypeByName('PERSONAL_WIN');
  }
  if (/^(everyone|everybody|people say|folks say|most devs|devs think|the industry)/.test(firstWords)) {
    return getArchetypeByName('CONTRARIAN_FACT');
  }
  if (/^(why does|how is|can we talk about|nobody told me|the fact that)/.test(firstWords)) {
    return getArchetypeByName('RANT');
  }
  if (/^(noticed|realizing|realized|turns out)/.test(firstWords)) {
    return getArchetypeByName('OBSERVATION');
  }
  if (firstChar && /[a-z]/.test(firstChar)) {
    return getArchetypeByName('HOT_TAKE');
  }
  return null;
}
