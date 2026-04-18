import { prisma } from './db.js';
import { logger } from './logger.js';
import { llm } from './agent.js';
import { canCallLLM, recordLLMCall } from './rateGuard.js';

export async function evolvePersona(): Promise<void> {
  // Rate guard: check last evolution was 22+ hours ago
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

  // Fetch top 10 high-tier tweets from last 30 days
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

TASK: Produce an updated persona profile document for a builder on X.
Extract: (1) sentence structures that recur in top posts, (2) vocabulary patterns, (3) topic angles that performed well, (4) what to avoid based on low performers.

CRITICAL VOICE CONSTRAINT: The persona profile MUST sound like a GenZ Indian dev who tweets casually.
If you notice the top posts using formal/literary language, DO NOT copy that pattern — flag it under AVOID instead.
The SIGNATURE_PHRASES section must only contain phrases a real 23-year-old would say, not a novelist.
Never include words like "indeed", "thus", "upon", "whilst", "amidst", "behold", "henceforth" in the profile.
No metaphors about journeys, battles, or nature. No philosophical framing.

Output ONLY the persona document. Plain text. Under 400 words. No preamble.
Structure it with these exact section headers on their own lines:
TONE:
STRUCTURE:
STRONG_TOPICS:
AVOID:
SIGNATURE_PHRASES:`;

  // LLM rate guard check
  const { allowed, reason } = await canCallLLM();
  if (!allowed) {
    logger.warn({ reason }, 'LLM rate limit reached, skipping persona evolution');
    return;
  }

  await recordLLMCall('gemini-2.5-flash', 'evolve');

  try {
    const res = await llm.invoke(prompt, { signal: AbortSignal.timeout(120_000) });
    const profileText = (res.content as string).trim();

    // Deactivate all existing profiles
    await prisma.personaProfile.updateMany({
      where: { is_active: true },
      data: { is_active: false },
    });

    // Create new active profile
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
