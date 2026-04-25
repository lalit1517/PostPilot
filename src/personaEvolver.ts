import { prisma } from './db.js';
import { logger } from './logger.js';
import { llm } from './agent.js';
import { canCallLLM, recordLLMCall } from './rateGuard.js';
import { OWNER_PROFILE } from './config/ownerProfile.js';

// Simple word-overlap score between two persona profile texts. Used to flag
// when persona evolution produces a near-identical profile (high-tier tweets
// are too homogeneous).
function profileOverlapRatio(a: string, b: string): number {
  const tokenize = (s: string) => new Set(
    s.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3),
  );
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

export async function evolvePersona(): Promise<void> {
  const latestProfile = await prisma.personaProfile.findFirst({
    orderBy: { created_at: 'desc' },
  });

  if (latestProfile) {
    const hoursSinceLastEvolution =
      (Date.now() - latestProfile.created_at.getTime()) / (60 * 60_000);
    if (hoursSinceLastEvolution < 22) {
      logger.warn(
        { hoursSince: hoursSinceLastEvolution.toFixed(1) },
        'Persona evolution skipped: last evolution too recent',
      );
      return;
    }
  }

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60_000);
  const highTierOutcomes = await prisma.tweetOutcome.findMany({
    where: {
      tier: 'high',
      computed_at: { gte: thirtyDaysAgo },
    },
    orderBy: { outcome_score: 'desc' },
    take: 10,
    include: {
      tweet: {
        include: {
          versions: {
            orderBy: { version: 'desc' },
            take: 1,
            select: { content: true, quality_score: true },
          },
        },
      },
    },
  });

  if (highTierOutcomes.length === 0) {
    logger.info('No high-tier tweets found for persona evolution');
    return;
  }

  const currentProfile = latestProfile?.is_active ? latestProfile : null;

  const highTierTweets = highTierOutcomes.map((o) => ({
    content: o.tweet.versions[0]?.content ?? '',
    outcome: { outcome_score: o.outcome_score },
  }));

  const prompt = `You are analyzing high-performing social media posts to extract reusable style patterns.

CURRENT PERSONA (v${currentProfile?.version ?? 0}):
${currentProfile?.profile_text ?? 'No prior persona. Start fresh.'}

TOP PERFORMING POSTS (sorted by outcome score, highest first):
${highTierTweets.map((t, i) => `${i + 1}. [Score: ${t.outcome.outcome_score.toFixed(1)}] "${t.content}"`).join('\n')}

STRUCTURE DIVERSITY AUDIT:
Count how many of the above posts share the same opening pattern (e.g. "spent X hours/minutes", "just shipped", "everyone says"). If more than 2 out of 10 share the same opening, explicitly list that pattern under the AVOID section of the persona, labeled as "OVERUSED_STRUCTURE: [pattern]". The goal is high engagement AND structural variety. Do not encode structural habits that appear in 3+ posts — those are ruts, not style.
Also audit narrative arcs: if 3+ posts share the same arc (e.g. "struggle -> realization -> quip", "setup -> contrast -> lesson", "rant -> self-deprecation"), list that arc under AVOID as "OVERUSED_ARC: [description]" too.

TASK: Produce an updated persona profile document for a builder on X.
Extract: (1) sentence structures that recur in top posts, (2) vocabulary patterns, (3) topic angles that performed well, (4) what to avoid based on low performers.

CRITICAL VOICE CONSTRAINT: ${OWNER_PROFILE.voiceSeed}
Stay true to this voice. Do not drift toward formal or literary language.
If you notice the top posts using formal/literary language, DO NOT copy that pattern — flag it under AVOID instead.
The SIGNATURE_PHRASES section must only contain phrases a real person in this persona would say, not a novelist.
Never include words like "indeed", "thus", "upon", "whilst", "amidst", "behold", "henceforth" in the profile.
No metaphors about journeys, battles, or nature. No philosophical framing.

CRITICAL: The SIGNATURE_PHRASES section must ONLY include sentence-level constructions that appear in FEWER than 3 of the top posts. Anything appearing in 3+ posts is a crutch, not a signature. List it under AVOID instead, labeled as "OVERUSED_PHRASE: [phrase]".

Output ONLY the persona document. Plain text. Under 400 words. No preamble.
Structure it with these exact section headers on their own lines:
TONE:
STRUCTURE:
STRONG_TOPICS:
AVOID:
SIGNATURE_PHRASES:`;

  const { allowed, reason } = await canCallLLM();
  if (!allowed) {
    logger.warn({ reason }, 'LLM rate limit reached, skipping persona evolution');
    return;
  }

  await recordLLMCall('gemini-2.5-flash', 'evolve');

  try {
    const res = await llm.invoke(prompt, { signal: AbortSignal.timeout(120_000) });
    const profileText = (res.content as string).trim();

    if (currentProfile?.profile_text) {
      const overlap = profileOverlapRatio(profileText, currentProfile.profile_text);
      if (overlap > 0.85) {
        logger.warn(
          { overlap: overlap.toFixed(2), previousVersion: currentProfile.version },
          'Persona evolution produced near-identical profile — high-tier tweets may be too homogeneous. Post more diverse content to diversify evolution inputs.',
        );
      }
    }

    await prisma.personaProfile.updateMany({
      where: { is_active: true },
      data: { is_active: false },
    });

    const newProfile = await prisma.personaProfile.create({
      data: {
        profile_text: profileText,
        based_on_tweets: highTierOutcomes.length,
        is_active: true,
      },
    });

    logger.info(
      { version: newProfile.version, basedOnTweets: highTierOutcomes.length },
      'Persona evolved successfully',
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, 'Persona evolution LLM call failed');
  }
}
