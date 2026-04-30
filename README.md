# 🚀 PostPilot

PostPilot is a professional-grade, autonomous AI agent for X (Twitter). Powered by LangGraph, it manages a complete content lifecycle—from drafting and invisible fingerprinting to 72-hour engagement tracking and outcome-driven persona evolution—all within a single self-learning loop. The system integrates a Human-in-the-Loop (HITL) safety gate via Telegram, ensuring 100% human verification before any content is published.

## 📑 Table of Contents

- [Core Innovations](#core-innovations)
- [Tech Stack](#tech-stack)
- [Architecture](#architecture)
- [Self-Learning Pipeline](#self-learning-pipeline)
- [AI Agent (LangGraph)](#ai-agent-langgraph)
- [Background Workers](#background-workers)
- [API Reference](#api-reference)
- [Database Schema](#database-schema)
- [Customizing the Owner Profile](#customizing-the-owner-profile)
- [Setup](#setup)
  - [Prerequisites](#prerequisites)
  - [1. Install dependencies](#1-install-dependencies)
  - [2. Configure environment](#2-configure-environment)
  - [3. Set up the database](#3-set-up-the-database)
  - [4. Set up Telegram bot](#4-set-up-telegram-bot)
  - [5. Configure Cloudflare Worker Cron](#5-configure-cloudflare-worker-cron)
- [Database Stability](#database-stability)
- [Safety & Policy Compliance](#safety--policy-compliance)
- [Hard Constraints](#hard-constraints)
- [Analytics (Grafana)](#analytics-grafana)

<a id="core-innovations"></a>

## 💡 Core Innovations


- **Layered Tweet Resolution**: Programmatic tweet-resolution using zero-width Unicode fingerprints, tolerant truncated-fingerprint matching, and same-author visible-text fallback. This links live tweets to specific LLM versions without requiring the expensive official X API. 🔒

- **LangGraph Orchestration**: Built on a Directed Acyclic Graph (DAG) rather than a simple prompt. Features a **Dual-Layer Diversity Gate** (text trigram + topic-agnostic structural fingerprint), a **Format Rotation System** that forces LRU archetype variety with FORMAT-prefixed fingerprints (survives restarts via heuristic backfill), a **Topic Coherence Gate** that validates draft-topic alignment without an extra LLM call, a **Two-Layer Trend Relevance Filter** (regex hard-exclude + domain keyword scoring), **Hard Prompt Prohibitions** extracted from persona AVOID sections, and a **Conditional Auto-Refiner** that triggers on low scores OR coherence mismatches.

- **Autonomous Persona Evolution**: A true closed-loop self-learning system. It analyzes its own top-performing tweets every 22 hours, extracts new stylistic patterns, and automatically updates its system prompt to align with audience resonance. 🧪

- **Free-Tier Monolith Architecture**: High-density engineering designed specifically for resource-constrained environments. Consolidates the Express API and a multi-task Background Worker into a single process that fits perfectly within Render's Free Tier.

- **Scientific Quality Analysis**: Includes advanced analytics like **Pearson Correlation** tracking between LLM-assigned quality scores and real-world engagement, allowing for data-backed calibration of the agent's intelligence. 📈


<a id="tech-stack"></a>

## 🛠️ Tech Stack

| Layer | Technology |
| :--- | :--- |
| Runtime | Node.js 20+ / TypeScript |
| Framework | Express 5 |
| AI Engine | LangGraph + Google Gemini (via @langchain/google-genai) |
| Database | PostgreSQL via Prisma ORM (Supabase) |
| Scheduling | Cloudflare Worker Cron |
| Notifications | Telegram Bot API |
| Logging | Pino |
| Infrastructure | Render (Compute) + UptimeRobot (Keep-alive) |


<a id="architecture"></a>

## 🏗️ Architecture

```
Cloudflare Cron           Telegram (notifications)
     |                         ^
     v                         |
  Express API  ──────>  LangGraph Agent  ──────>  Gemini LLM
     |                         |
     v                         v
  RetryQueue  ──────>  Background Workers
     |                    |         |
     v                    v         v
  Supabase DB       Nitter/X     Engagement
  (PostgreSQL)      Scraper      Tracker
```


**Three layers:**

1. **Orchestration** — Cloudflare Worker Cron triggers `/api/cron/generate` at 09:00, 13:30, and 22:00 IST. PostPilot sends Telegram draft notifications directly with inline buttons (post, edit, feedback).

2. **Intelligence** — LangGraph StateGraph with 7 nodes (contextLoader, personaAdapter, contentGenerator, diversityGate, qualityScorer, coherenceGate, autoRefiner). Gemini 2.5 Flash primary, with fallback chain.

3. **Persistence** — PostgreSQL via Prisma ORM on Supabase. RetryQueue manages async tasks (tweet resolution, engagement tracking, persona evolution) using due-task scheduling instead of fixed idle polling.


<a id="self-learning-pipeline"></a>

## 🔄 Self-Learning Pipeline

PostPilot improves its own writing over time without manual tuning.

```
Generation (3 LLM calls max)
  -> contextLoader pulls slot-aware exemplars (top tweets at THIS time-of-day)
  -> qualityScorer persists quality_score (1.0-10.0, 1 dp) to TweetVersion
  -> Engagement tracked at 10m, 1h, 6h, 24h, 48h, 72h (likes + retweets + replies)
  -> At 72h: computeOutcomeScore() -> TweetOutcome record
       (log-scaled raw = log1p(likes + retweets×3 + replies×5), min-max vs 30d window)
  -> reweightFeedback() -> updates Feedback.weighted_score
  -> If 5+ high-tier tweets since last evolution -> enqueue EVOLVE_PERSONA
  -> evolvePersona() (1 LLM call, 22h cooldown) -> new PersonaProfile
  -> Next generation picks up: slot-aware exemplars + weighted feedback + learned persona
```


### Modules



| Module | File | LLM Calls | Purpose |
| :--- | :--- | :--- | :--- |
| Outcome Scorer | `src/outcomeScorer.ts` | 0 | Normalizes peak engagement (0-100) with **log-scaled** min-max vs 30-day window. Raw formula: `log1p(peak_likes + peak_retweets × 3 + peak_replies × 5)` — replies weighted highest (hardest engagement to earn), log scaling kills outlier tyranny so one viral tweet doesn't crush every other score to zero. Persists `topic`, `time_of_day`, `day_of_week`, `peak_replies` for analytics. Tiers: top 20% = high, bottom 30% = low. |
| Feedback Weighter | `src/feedbackWeighter.ts` | 0 | Weights feedback by nearby tweet outcomes (±3 day window), recency decay `1 / (1 + days_since)`, and sentiment multiplier from `feedbackSentiment`. |
| Feedback Sentiment | `src/feedbackSentiment.ts` | 0 | Regex/keyword classifier: `positive \| negative \| stylistic \| neutral`. Multipliers 1.2 / 1.3 / 1.0 / 0.8. |
| Draft Diversity | `src/draftDiversity.ts` | 0 | Dual-layer check against last 20 drafts: (1) trigram Jaccard ≥ 0.65, (2) structural fingerprint match against last 5 drafts. Topic-agnostic opening classifier + arc tokens. Emits a `DiversityReport` on every rejection. Ships an in-memory **format map** (LRU 30) and a boot-time **heuristic backfill** (`guessFormatFromContent`) so FORMAT-prefixed fingerprints survive Render restarts. |
| Draft Formats | `src/draftFormats.ts` | 0 | 8 archetypes, each with `openingTemplate`, `bannedOpenings`, `bannedPhrases?`, `exampleFirstSentence`. `getNextFormatWithMeta()` exposes which formats were considered + unused count for logging. Pure and deterministic. |
| Trend Relevance | `src/trendRelevance.ts` | 0 | Two-layer filter on Trends24 output. Layer 1: regex hard-exclude (non-ASCII, politics/sports/entertainment/crypto/horoscope, <4 chars, pure numbers). Layer 2: word-boundary keyword overlap against `OWNER_PROFILE.domainKeywords` — score 0 → reject. Replaced the old naive substring filter. |
| Topic Coherence | `src/topicCoherence.ts` | 0 | Pure-string gate that passes on (a) topic keyword overlap with draft OR (b) on-domain pivot (≥2 domain keywords). Feeds the `coherenceGate` graph node. |
| Topic Memory | `src/topicMemory.ts` | 0 | In-memory 48h topic cooldown + per-topic coherence failure counter. Supplied topics still on cooldown are cleared before generation and folded into the blacklist, so a fresh topic is selected. Final accepted topics are recorded after both the direct path and `autoRefiner`. Survives DB outages; DB is long-term authoritative. 3-strike rule auto-blacklists a topic. |
| Trends | `src/trends.ts` | 0 | Scrapes Trends24 global trends, 30-min cache, stale fallback on fetch error. Tracks `consecutiveZeroFetches` — on 3 consecutive zero parses logs CRITICAL (regex may have drifted) and nulls the cache to retry fresh. |
| Analytics | `src/analytics.ts` | 0 | `getEngagementPattern()` (slot × day pivot), `getTopicPerformance()` (topic leaderboard), `getQualityOutcomeCorrelation()` (Pearson r). |
| Persona Evolver | `src/personaEvolver.ts` | 1/day | Analyzes top 10 high-tier tweets, extracts TONE/STRUCTURE/STRONG_TOPICS/AVOID/SIGNATURE_PHRASES. Runs a **Structure Diversity Audit**: flags any opening or narrative arc shared by 3+ top posts under AVOID (`OVERUSED_STRUCTURE`, `OVERUSED_ARC`, `OVERUSED_PHRASE`). Voice constraint reads from `OWNER_PROFILE.voiceSeed`. **Persona drift detection**: word-overlap vs. previous profile > 0.85 logs a WARN ("high-tier tweets may be too homogeneous"). 22h cooldown gate. |
| Rate Guard | `src/rateGuard.ts` | 0 | Tracks calls in `LlmCallLog`. Blocks at 5 RPM or 19 RPD (current app-side setting). On block, returns `nextAvailableAt` ISO timestamp so logs carry actionable info. `getRateStatus()` exposes current consumption. Prunes entries older than 48h. Keep the constants aligned with the active Google AI tier/model quota. |


<a id="ai-agent-langgraph"></a>

## 🧠 AI Agent (LangGraph)

**Pipeline:** `START -> contextLoader -> personaAdapter -> contentGenerator -> diversityGate -> qualityScorer -> coherenceGate -> [autoRefiner if score < 8 OR coherence failed] -> finalTopicMemory -> END`

**Re-roll edge:** `diversityGate -> personaAdapter` (capped at 1 re-roll). On rejection, a **different format archetype** is selected via `getNextFormatWithMeta()` and the rejected fingerprint + draft are persisted to state. `contentGenerator` then injects a `[STRUCTURAL RE-ROLL]` block naming the exact fingerprint and draft the model must NOT reproduce. The reroll routes through `personaAdapter` so the new format + prohibitions bake into the prompt before the retry. `afterDiversityGate` only routes back while `rejectedFingerprint` is still set; accepted drafts clear that marker and advance to `qualityScorer`, preventing repeated generate calls from tripping the 5 RPM guard.

**Rate-limit short-circuit edge:** `contentGenerator -> END` when `rateLimited === true`. Skips diversityGate, qualityScorer, coherenceGate, autoRefiner, fingerprint injection, and draft notification. Tweet is marked `GENERATION_RATE_LIMITED` and a Telegram warning is sent instead.

| Node | LLM Call | Behavior |
| :--- | :--- | :--- |
| `contextLoader` | No | Sequential DB fetch: **slot-aware exemplars** (top 5 tweets from `TweetOutcome` filtered by `time_of_day = currentSlot` ordered by `outcome_score`, with global fallback to top-5 by raw likes when slot has <3 samples — logs `exemplarSource: 'slot_filtered' \| 'global_fallback'` + `slotSampleCount` so the agent learns morning-style for morning posts and night-style for night posts), weighted feedback (fallback to unweighted if < 3), active PersonaProfile, `computeLengthTarget()`, `computeTopicBlacklist()` (merges DB bottom-20% with in-memory cooldown — logs `blacklistSource: 'db+memory' \| 'memory_only'`), last 15 FORMAT-prefixed structural fingerprints. Trends24 pulled in parallel (non-DB) and filtered via `filterRelevantTrends()` — regex hard-exclusion + domain keyword scoring. When zero trends survive, sets `topicFree: true` on state. Extracts `OVERUSED_STRUCTURE/ARC/PHRASE` entries from the learned persona's AVOID section into `hardProhibitions`. Selects the next `FormatArchetype` via `getNextFormatWithMeta()` and logs `{ selectedFormat, recentFormatsConsidered, unusedFormatsCount }` — rotation is verifiable from logs. |
| `personaAdapter` | No | Builds the prompt top-down: (1) `---HARD PROHIBITIONS---` block (overused structures/arcs/phrases from persona AVOID — stated as structural violations that cause rejection), (2) `---FORMAT DIRECTIVE (MANDATORY)---` block with the archetype's `openingTemplate`, `bannedOpenings`, `bannedPhrases?`, and `exampleFirstSentence`, ending in "Violation makes the draft invalid, the quality scorer will reject it", (3) `OWNER_IDENTITY` from `src/config/ownerProfile.ts`, (4) learned persona, few-shot exemplars, trending hint, topic-free banner (when applicable), length target, topic blacklist, tone-by-time-of-day, feedback guidelines, recency/casing rules, and the `VOICE ANTI-PATTERNS` guardrail. |
| `contentGenerator` | Yes | Generates `TOPIC\|DRAFT`. Rate-guarded via `canCallLLM()` (returns `nextAvailableAt` timestamp on block). Cold-start fallback: when no topic + `topicFree`, picks from `OWNER_PROFILE.coldStartTopics`. Structural re-roll: when `state.rejectedFingerprint` is set, injects a block naming the exact fingerprint + draft the model must NOT reproduce. Output passed through `finalizeDraft()`. Calls `registerDraftFormat(tweetId, formatName)` so future fingerprint reads attach the FORMAT: prefix. On rate-limit, sets `rateLimited: true` and the graph short-circuits to `END`. |
| `diversityGate` | No | Runs `checkDraftDiversity()` against the last 20 drafts. Dual check: (1) trigram Jaccard ≥ 0.65, (2) structural fingerprint match against last 5. On duplicate, picks a **new format** for the re-roll and persists `rejectedFingerprint` + `rejectedDraft`; routes via `personaAdapter` → `contentGenerator`. Second duplicate accepted. Accepted drafts push `FORMAT:<name>\|OPEN:<kind>\|<arc tokens>` to the in-memory ring buffer and clear the reject-state; this cleared marker is what lets `afterDiversityGate` proceed to scoring after a successful re-roll. Counts the draft's own fingerprint against recent history → `structuralRepetitionCount` state field consumed by the scorer. This graph node is the diversity enforcement point; the older server-side warning-only duplicate check was removed. |
| `qualityScorer` | Yes | Prompt now opens with a `---STRUCTURAL CONTEXT FOR SCORING---` block naming the draft's fingerprint, its count in recent history, and explicit penalty rules (-1 at 2+ matches, -2 at 4+). Scores **1.0-10.0 with one decimal of precision** (e.g. 7.4, 8.2, 9.7) via `parseScore()` — model is instructed to differentiate similar drafts via the decimal and parser defensively rounds to 1 dp. Voice-authenticity criteria enforced. Runs `parseCritiqueHints()` → fixed hint vocabulary (`too_long`, `weak_hook`, `vague_claim`, `low_energy`, `cliche`, `too_jargon`, `weak_ending`, `poor_flow`, `needs_emotion`, `low_quality`, `wrong_voice`, plus `topic_drift` added by coherenceGate). Persists `quality_score` to TweetVersion. |
| `coherenceGate` | No | Pure-string check via `checkTopicCoherence()`. Passes when topic is empty, or draft shares a topic keyword, or draft has ≥2 domain keywords (on-domain pivot). On mismatch: increments per-topic failure counter, degrades a high score to 6 to force a refiner pass, appends `topic_drift` to hints. At 3 strikes, auto-blacklists the topic via `recordTopicUsed`. |
| `autoRefiner` | Conditional | Runs when score < 8 OR coherence failed. Reuses `state.personaParameters` (carries HARD PROHIBITIONS + FORMAT DIRECTIVE at top) and tells the model it MUST still obey those constraints on rewrite. Maps hints → `HINT_DIRECTIVES` (e.g. `topic_drift` → "TOPIC GROUNDING — draft must explicitly reference topic X, if irrelevant, acknowledge and pivot"). Output gated by `isSuspiciousDraft()`; rejection keeps original. |
| `finalTopicMemory` | No | Records the final accepted topic into the 48h in-memory cooldown after either the direct high-score path or the `autoRefiner` path. This prevents refiner-produced drafts from skipping topic memory and repeating yesterday's topic today. |


**Owner Identity (`OWNER_PROFILE`)**: **Single source of truth at [`src/config/ownerProfile.ts`](src/config/ownerProfile.ts)**. Every file that needs owner context imports from there. No env-var overrides by design — one file, one source, zero ambiguity. `.env` is only for secrets + infra. To clone PostPilot for a different persona: edit this file, commit, deploy. See [Customizing the Owner Profile](#customizing-the-owner-profile) for the per-field guide.

**Draft safety helpers** (pure computation, zero extra LLM calls):

- `finalizeDraft(raw)` — trims to the last full sentence when the LLM truncates mid-thought.

- `parseScore(raw)` — extracts score from free-form LLM output. Falls back to `7` (neutral) on parse failure, never `0`.

- `isSuspiciousDraft(draft)` — rejects empty, `<40` chars, `>280` chars, missing terminator, preamble leak, markdown artifacts.

- `parseCritiqueHints(critique, draft, score)` — maps free-form critique → fixed hint vocabulary for `autoRefiner`.

- `computeLengthTarget()` — derives `{min, max}` length window from last 20 high-tier `TweetOutcome` rows (avg±stdev). Returns `null` if <5 samples.

- `computeTopicBlacklist()` — merges DB bottom-20% topics with the in-memory cooldown list from `topicMemory.ts`. On DB failure, returns memory-only instead of `[]`. Logs `blacklistSource`.

- `extractAvoidItems(profileText)` — parses `OVERUSED_STRUCTURE:` / `OVERUSED_ARC:` / `OVERUSED_PHRASE:` from the persona AVOID section into structured hard prohibitions.

- `extractStructuralFingerprint(text)` — topic-agnostic shape fingerprint (`OPEN:<kind>|CONTRAST|LESSON|SELF_DEPRECATE|PUNCHLINE_END`). Structural regex only, no hardcoded topics.

- `getNextFormatWithMeta(recentFingerprints)` — pure, deterministic LRU archetype selector over 8 archetypes. Returns `{ selected, unusedCount, consideredRecentFormats }` so rotation is loggable.

- `composeFingerprint(formatName, observed)` / `pushFingerprintToBuffer(fp)` / `registerDraftFormat(tweetId, name)` / `getRecentStructuralFingerprints(n)` — fingerprint plumbing. Ring buffer in-memory; on restart, a boot-time `backfillFormatMap()` scans recent `TweetVersion` rows and calls `guessFormatFromContent()` heuristically so FORMAT-prefixed fingerprints survive Render restarts without a schema migration.

- `checkTopicCoherence(draft, topic)` — pure-string coherence check. Passes on topic keyword overlap OR on-domain pivot (≥2 domain keywords in draft).

- `recordTopicUsed(topic)` / `isTopicOnCooldown(topic)` / `getInMemoryBlacklist()` / `incrementCoherenceFailure(topic)` — in-memory 48h cooldown + 3-strike coherence counter. Supplied topics that are still on cooldown are cleared and added to the blacklist before generation picks a fresh topic. Final accepted topics are recorded after either the direct pass or `autoRefiner`.

- `filterRelevantTrends(trends)` — two-layer trend filter. Returns `{ relevant, excluded }` with per-trend rejection reason.

**Models:** `gemini-2.5-flash` (primary, `thinkingBudget: 1024`) -> `gemini-3.1-flash-lite-preview` -> `gemini-3-flash-preview` -> `gemini-2.5-flash-lite` (fallbacks)

**Config:** Temperature 0.7, max 2048 output tokens, topP 0.9, 2-minute timeout per call.


<a id="background-workers"></a>

## 👷 Background Workers

The `RetryQueue` table manages three async task types. The worker schedules itself around the earliest pending `process_after` instead of polling the database on a fixed idle loop; if no task exists, it performs a 15-minute reconciliation check. New tasks created through `enqueueRetry()` wake the in-process scheduler immediately.

### 🔘 Telegram Buttons — What Each Does

When a draft arrives in Telegram, you get four buttons. Here's exactly what each one does:


**🚀 Open in X** — the primary posting path. Tapping it:

1. Hits `/api/post-intent` on the server (logs the click, idempotently enqueues `RESOLVE_TWEET` with a 10-min delay; repeated clicks reuse the existing pending resolver task)

2. Redirects your browser to X's compose box, pre-filled with the draft + invisible fingerprint

3. You post it manually on X

4. 10 minutes later, `RESOLVE_TWEET` fires automatically. On success, it marks the tweet `POSTED_CONFIRMED`, edits the Telegram message text to show `Status: ✅ Marked as Posted`, removes callback buttons, and starts engagement tracking.

PostPilot stores the Telegram `chat_id` + `message_id` as soon as the draft message is sent, because URL buttons do not send callback metadata when tapped. That stored message reference is what lets the worker update the original Telegram message after automatic resolution.


**✅ Posted** — manual override only. Use this when:

- You destroyed the fingerprint (edited the tweet end on X before posting)

- Nitter and Twitter timeline both failed to find the tweet

- You posted but the auto-detection silently failed

Tapping it immediately sets `posted=true`, `status=POSTED_CONFIRMED`, idempotently enqueues `RESOLVE_TWEET`, persists the Telegram `chat_id` + `message_id` on the Tweet row, edits the Telegram message text to show `Status: ☑️ Post Confirmed - resolver running`, and removes the **Posted** callback row while keeping **Open in X**, **Edit Topic**, and **Feedback** visible. Repeated clicks reuse the existing pending resolver task. This is an optimistic user confirmation, not final resolver proof.

If `RESOLVE_TWEET` still finds nothing after all retries (~62 min total: 10 min initial delay + ~7 min short retry + ~45 min final retry), the worker:

1. Marks the tweet `RESOLVE_FAILED` and resets `posted=false`, `posted_at=null`.
2. Edits the original Telegram message via `editMessageText`, showing `Status: ↩️ Not Posted` and removing the keyboard so no final-state callback can be tapped.

If the resolver finds the tweet, it shows `Status: ✅ Marked as Posted` and removes callback buttons. Telegram inline buttons with `callback_data` always send a webhook POST when tapped, so final status is represented in message text rather than a fake disabled button.

> The worker resolution guard skips on `live_url` set or `status === 'RESOLVE_FAILED'` — NOT on `posted=true`. The manual click sets `posted=true` optimistically; gating on it would silently drop every manual-confirm task before it polls. Earlier versions had this bug — the button never changed back even after hours.

This covers two common cases: you clicked ✅ Posted but never actually posted, or the tweet got deleted/unpublished before the worker could confirm it. No manual cleanup needed — the Telegram message self-corrects after resolver success or final failure.

> **You almost never need the Posted button.** Open in X handles everything automatically through the layered resolver. Posted is the escape hatch for when you want to optimistically confirm that you posted.


**✏️ Edit Topic / 💬 Feedback** — open secure HMAC-signed web forms. Submit triggers a full regeneration with the new topic or feedback injected into the pipeline.


There is no final Telegram "undo" action after resolver success or failure. Corrections should be handled in the database or by generating a new draft.

### RESOLVE_TWEET



Detects posted tweets via a layered resolver: exact invisible fingerprint match first, tolerant truncated-fingerprint match second, and visible-text fallback last.

1. Triggered 10 minutes after the signed X intent redirect or manual Posted confirmation.

2. Polls a shuffled Nitter source list (override with `NITTER_INSTANCES`; built-in default includes `nitter.net`, `xcancel.com`, `nitter.privacyredirect.com`, `nitter.privacydev.net`, `nitter.poast.org`, `nitter.space`, `nitter.tiekoetter.com`, `lightbrd.com`) and falls back to the native Twitter timeline with browser-like headers. Hosts that return `403`, `429`, `5xx`, or fetch failures are cooled down for 30 minutes.

3. Primary match: looks for the exact 8-char hex fingerprint embedded as invisible Unicode (`U+200B`/`U+200C`). Fingerprint generation pre-checks the DB to avoid `@unique` collisions.

4. Secondary match: accepts a 28-31 zero-width-character run only when it decodes to a strong prefix of the stored fingerprint **and** nearby visible text matches the stored draft. This handles mobile/X clients that trim a trailing zero-width character.

5. Fallback match: extracts same-author tweet candidates from X/Nitter responses and compares normalized visible text against the stored `TweetVersion.content`. Candidates must be recent; when `created_at` is missing, the worker derives the timestamp from the X snowflake ID.

6. On match: marks tweet as `POSTED_CONFIRMED`, updates the Telegram message text to `Status: ✅ Marked as Posted`, removes callback buttons, and schedules the first engagement fetch.

7. On miss: schedules one short retry at ~7 minutes, then one final delayed retry at ~45 minutes. If all attempts miss, sets status to `RESOLVE_FAILED`, resets `posted=false`, `posted_at=null`, updates the Telegram message text to `Status: ↩️ Not Posted`, and removes callback buttons — prevents the tweet from silently appearing as posted when it wasn't confirmed.

**Editing tweets before posting:** The invisible fingerprint is appended after a trailing space at the very end of the draft — i.e. `[tweet text] [invisible chars]`. It is safe to edit visible text, but changing the final text heavily can weaken the visible-text fallback. The resolver can tolerate some trailing zero-width truncation, but deleting through the invisible suffix, select-all retyping, or posting a substantially different draft can still force `RESOLVE_FAILED`.

### FETCH_ENGAGEMENT

Time-series engagement tracking at fixed intervals.

| Attempt | Time After Post | Action |
| :--- | :--- | :--- |
| 1 | 10 min | First snapshot |
| 2 | 1 hour | Second snapshot |
| 3 | 6 hours | Third snapshot |
| 4 | 24 hours | Fourth snapshot |
| 5 | 48 hours | Fifth snapshot |
| 6 | 72 hours | Final snapshot + outcome scoring |

At attempt 6 (final):

- Calls `computeOutcomeScore()` to create `TweetOutcome` record

- Calls `reweightFeedback()` to update all feedback weights

- Checks if 5+ new high-tier tweets exist since last persona evolution — if so, enqueues `EVOLVE_PERSONA`

**Cooldown:** 5-minute minimum between snapshots. Anti-bot jitter on all requests (0-2000ms).

#### Customizing Tracking Intervals
PostPilot tracks engagement over 72 hours by default (6 snapshots). You can change this duration by editing `src/worker.ts`:

*   **Total Tracking Days**: To track for longer (e.g., 7 days):

    1.  In `fetchTweetEngagement`, add more `else if (attempt === X)` blocks to define the delays for additional days.

    2.  Update the **finalization block** (`if (attempt === 6)`) to match your new final attempt number (e.g., `if (attempt === 10)`).


    ```typescript
    // src/worker.ts (~line 405)
    if (attempt === 1) nextFetchDelay = 50 * 60 * 1000;          // Day 0: 10m -> 1h
    else if (attempt === 2) nextFetchDelay = 5 * 60 * 60 * 1000;  // Day 0: 1h -> 6h
    else if (attempt === 3) nextFetchDelay = 18 * 60 * 60 * 1000; // Day 0 -> Day 1 (24h)
    else if (attempt >= 4 && attempt < 10) {
      nextFetchDelay = 24 * 60 * 60 * 1000;                       // Day 2, 3, 4, 5, 6, 7
    }
    ```

*   **Important**: If you increase the number of attempts beyond 6, you must also update the `maxRetries` argument passed to `enqueueRetry` for `FETCH_ENGAGEMENT` (currently `6`, in two locations around lines 115 and 438) to ensure the database doesn't mark the task as failed before it finishes the cycle.

### EVOLVE_PERSONA

Calls `evolvePersona()` — 1 LLM call with 22-hour cooldown. Deactivates previous profiles, creates new active `PersonaProfile`.

### Scheduled: Feedback Reweight



`reweightFeedback()` runs at 72h completion and via a 6-hour in-memory timestamp gate in the worker. The gate starts at process boot so feedback reweighting does not compete with startup queue discovery.

<a id="api-reference"></a>

## 🔌 API Reference

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/` | Health check |
| `POST` | `/api/generate` | Protected async tweet generation. Returns `202` with `tweet_id` immediately. |
| `POST` | `/api/cron/generate` | Protected Cloudflare Cron entrypoint. Idempotent per `scheduled_slot_key`; duplicate retries return the existing tweet. |
| `GET` | `/api/status?id=` | Protected generation status and latest draft lookup |
| `GET` | `/api/analytics?id=` | Protected engagement time-series for a tweet |
| `GET` | `/api/post-intent?id=&username=&intent=&token=` | Signed redirect tracker — logs click-through, enqueues resolution, redirects to X |
| `GET` | `/api/view-edit?id=&token=` | HTML form for topic editing |
| `GET` | `/api/view-feedback?id=&token=` | HTML form for feedback submission |
| `POST` | `/api/edit` | Update topic + trigger regeneration |
| `POST` | `/api/feedback` | Submit feedback + trigger regeneration |
| `POST` | `/api/telegram/webhook` | Telegram bot callback handler for active buttons such as manual posted confirmation |
| `GET` | `/api/admin/rate-status` | Current RPM/RPD consumption and remaining budget from `LlmCallLog` |
| `GET` | `/api/admin/failed-tasks?limit=N` | Dead letter queue — inspect `RetryQueue` rows with `status = FAILED` |
| `GET` | `/api/admin/engagement-pattern` | Aggregates `TweetOutcome` by `time_of_day`, `day_of_week`, and the time × day pivot |
| `GET` | `/api/admin/topic-performance?limit=N` | Top-performing topics ranked by avg outcome score |
| `GET` | `/api/admin/quality-correlation` | Pearson r between LLM `quality_score` and real `outcome_score` |

**Security:** Edit/feedback URLs are signed with HMAC-SHA256 (8-char prefix). Verified via timing-safe comparison.

<a id="database-schema"></a>

## 🗄️ Database Schema

8 models on PostgreSQL (Supabase), managed by Prisma ORM.

| Model | Purpose |
| :--- | :--- |
| `Tweet` | Master record — topic, status (`PENDING`, `GENERATING`, `APPROVED`, `POSTED_CONFIRMED`, `RESOLVE_FAILED`, `GENERATION_RATE_LIMITED`, `ERROR`), fingerprint, `scheduled_slot_key` (unique UTC day/slot idempotency key for Cloudflare retries), live_url, posted_at, `telegram_chat_id` + `telegram_message_id` (persisted when the draft is sent to Telegram, and refreshed on manual ✅ Posted clicks, so the worker can edit the original message with final `Status: ✅ Marked as Posted` or `Status: ↩️ Not Posted` text) |
| `TweetVersion` | Versioned drafts with `quality_score` (set by qualityScorer) |
| `Feedback` | User feedback with `weighted_score` (computed by feedbackWeighter) |
| `Engagement` | Time-series snapshots — `likes`, `retweets`, `replies` at each interval. **`impressions` is always 0** — Twitter's free/public syndication endpoint doesn't expose impression counts. Column is unused today; kept as a future hook for when an X API key (paid Basic tier) is wired in, since that endpoint does return impressions. Surfaced via `/api/analytics` timeline as passthrough only — no consumer reads a non-zero value. |
| `TweetOutcome` | Normalized 0-100 outcome score, tier (high/medium/low), peak metrics (`peak_likes`, `peak_retweets`, `peak_replies`), `quality_score` copy, `topic`, `time_of_day`, `day_of_week`. One per tweet, computed at 72h. Indexed on tier/time/day. |
| `PersonaProfile` | Versioned persona documents with auto-increment version and `is_active` flag |
| `LlmCallLog` | Rate limiting ledger with `called_at` index, pruned to 48h window |
| `RetryQueue` | Task queue — RESOLVE_TWEET, FETCH_ENGAGEMENT, EVOLVE_PERSONA. Indexed on `(status, process_after, created_at)` for due-task lookup. |




<a id="customizing-the-owner-profile"></a>

## 👤 Customizing the Owner Profile

All persona configuration lives in **one file**: [`src/config/ownerProfile.ts`](src/config/ownerProfile.ts). Edit the fields, commit, deploy. There are no env-var overrides for these values by design — one file, one source, zero ambiguity. `.env` stays for secrets and infra only (DB URL, API keys, Telegram token).

| Field | Used by | What it does |
| :--- | :--- | :--- |
| `username` | worker scraping, fingerprint resolution | Your X handle (without @). Must match the `X_USERNAME` in `.env`. |
| `identity` | `personaAdapter` prompt | One-line "you are…" statement at the top of the persona block. |
| `domains` | `personaAdapter` prompt | High-level topic descriptions injected into the persona. |
| `domainKeywords` | `trendRelevance.ts`, `topicCoherence.ts` | **Flat lowercase keyword list.** Drives the trend relevance filter (word-boundary match — score 0 → reject) and the coherence gate (≥2 matches in the draft = on-domain pivot). Add broadly — "ai" won't match "brain" because the filter uses word boundaries. |
| `moods` / `tones` / `language` | persona prompt | Style flavor lists. |
| `experienceVoice` | persona prompt | One-line experience anchor. |
| `cities` / `hobbies` / `slangs` | persona prompt | Personality flavor. Slangs are sparingly applied (1 per tweet max). |
| `avoid` | persona prompt | Hard topic bans. The agent never tweets about these. |
| `voiceSeed` | `personaEvolver.ts` | Voice anchor used when the LLM evolves the persona — replaces the old hardcoded "GenZ Indian dev" string. |
| `preferredLength` | length target seed | `'short' \| 'medium' \| 'long'`. Soft hint until enough outcome data exists for `computeLengthTarget()` to derive a real range. |
| `tweetLanguages` | `trendRelevance.ts` | ISO 639-1 codes. When `'en'` is in the list, non-ASCII trends are dropped (the fix for the Turkish-holiday-passes-as-relevant bug). |
| `coldStartTopics` | `contentGenerator` cold-start fallback | See below. |

### When `coldStartTopics` are used

The agent normally pulls a topic from one of three places: the trending list (Trends24), a topic supplied to `/api/generate`, or your historical persona data. `coldStartTopics` is the **safety net** — used only when **all three fail at the same time**:

- Trends24 returns 0 items OR every trend gets dropped by `filterRelevantTrends` (e.g. all trends are non-English / sports / politics)
- AND no `topic` was supplied to the generation request
- AND `state.topicFree` is set to `true` by `contextLoader`

In that case, `contentGenerator` calls `pickColdStartTopic(recentTopics, blacklist)` which:

1. Filters the pool to topics not in `recentTopics` AND not on the in-memory cooldown blacklist
2. Picks one at random from the eligible subset (or the full pool if everything is on cooldown)
3. Logs `{ coldStartTopic }` so you can see which one fired
4. Hands the topic to the LLM as a normal generation input

**What to put in the list:** evergreen topics you'd genuinely tweet about with no news hook. Opinions you've held for months, observations you've made ten times, the stuff you'd mention at a meetup without prep. Avoid anything that goes stale (specific product launches, version numbers, "just released" framing). The default list is dev-flavored — replace it with your own when cloning.

If the list is empty, the LLM gets a generic "generate a topic from your domains" prompt and rolls the dice. Keeping the list populated prevents the random-content failure mode.

<a id="setup"></a>

## ⚙️ Setup

<a id="prerequisites"></a>

### Prerequisites



- Node.js 20+

- PostgreSQL database (Supabase recommended)

- [Google AI Studio API key](https://aistudio.google.com/app/apikey)

- Telegram bot (for notifications)

- Cloudflare account (for free Worker Cron scheduling)

<a id="1-install-dependencies"></a>

### 1. Install dependencies



```bash
npm install
```


<a id="2-configure-environment"></a>

### 2. Configure environment

> **Persona configuration lives in [`src/config/ownerProfile.ts`](src/config/ownerProfile.ts), NOT in `.env`.** See [Customizing the Owner Profile](#customizing-the-owner-profile). `.env` is only for secrets and infra.

Create `.env` in the project root (use `.env.example` as a template):

```env
DATABASE_URL=postgresql://postgres.[ref]:[PASSWORD]@aws-1-ap-south-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=5&pool_timeout=60&connect_timeout=30&tcp_keepalives_idle=60&tcp_keepalives_interval=10&tcp_keepalives_count=5
                                       # Supabase transaction pooler (port 6543) for Prisma runtime.
                                       # Stability params (ALL required, see src/db.ts comment block):
                                       #   connection_limit=5            — small pool for API ingress, worker tasks, callbacks, and background reads
                                       #   pool_timeout=60                — wait up to 60s for a slot during a slow DB/network window
                                       #   connect_timeout=30             — Supabase-recommended; absorbs cross-region Supavisor handshake jitter without false P1001
                                       #   tcp_keepalives_idle=60         — OS-level TCP keepalive every 60s
                                       #   tcp_keepalives_interval=10     — probe retry every 10s if idle
                                       #   tcp_keepalives_count=5         — 5 failed probes = dead socket
DIRECT_URL=postgresql://postgres.[ref]:[PASSWORD]@aws-1-ap-south-1.pooler.supabase.com:5432/postgres
                                       # Supabase session pooler (port 5432) for Prisma migrations; no pgbouncer query param.
                                       # Username MUST be `postgres.PROJECT_REF` (Supavisor format), not bare `postgres`.
GOOGLE_API_KEY=...                     # Get from https://aistudio.google.com/app/apikey
                                       # Choose models (Gemini 1.5/2.0/Flash) based on their specific RPM/RPD limits.
X_USERNAME=your_handle                 # X handle for tweet resolution scraping
NITTER_INSTANCES=nitter.net,xcancel.com,nitter.privacyredirect.com,nitter.privacydev.net,nitter.poast.org,nitter.space,nitter.tiekoetter.com,lightbrd.com
BASE_URL=https://your-domain.com       # Deployment root URL
HMAC_SECRET=...                        # 64-char hex for URL signing (see below)
TELEGRAM_BOT_TOKEN=...                 # From @BotFather
TELEGRAM_CHAT_ID=...                   # Numeric chat ID from @userinfobot — used for bot-initiated alerts (RESOLVE_FAILED, rate-limit warnings)
TELEGRAM_WEBHOOK_SECRET=...            # Secret token for Telegram webhook verification (see below)
INTERNAL_API_KEY=...                   # API key protecting admin + generate endpoints (see below)
PORT=3000                              # Express server port

GRAFANA_URL=https://yourorg.grafana.net  # Grafana Cloud stack URL (for dashboard provisioning)

GRAFANA_API_KEY=...                    # Grafana service account token with Admin role (see grafana/README.md)

GRAFANA_DATABASE_URL=postgresql://postgres.[ref]:[PASSWORD]@aws-1-ap-south-1.pooler.supabase.com:5432/postgres
                                       # Supabase session pooler (port 5432) for Grafana
```

Generate `HMAC_SECRET` and `TELEGRAM_WEBHOOK_SECRET` (64-char hex). Run this command **separately for each variable** and paste two different values; do not reuse the same secret for both:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Generate `INTERNAL_API_KEY` (base64, URL-safe):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

`INTERNAL_API_KEY` is required in the `X-API-Key` header for `/api/generate`, `/api/cron/generate`, `/api/status`, `/api/analytics`, `/api/status/:id/timeline`, and `/api/admin/*` requests.

**Register the Telegram webhook** — without this, active callback buttons such as ✅ Posted never reach the server and Telegram buttons can appear stuck. Paste into a browser address bar (or `curl`), replacing `<TOKEN>` / `<BASE_URL>` / `<TELEGRAM_WEBHOOK_SECRET>` with your values:

```
https://api.telegram.org/bot<TOKEN>/setWebhook?url=<BASE_URL>/api/telegram/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>
```

Expect `{"ok":true,"result":true,"description":"Webhook was set"}`. Verify anytime with `https://api.telegram.org/bot<TOKEN>/getWebhookInfo`. The `secret_token` is checked on every incoming callback — mismatch returns `403` and the button click is rejected.

<a id="3-set-up-the-database"></a>

### 3. Set up the database



```bash
npx prisma migrate deploy
npx prisma generate
```

<a id="4-set-up-telegram-bot"></a>

### 4. Set up Telegram bot



1.  **Generate Access Token**:
    *   Message [@BotFather](https://t.me/BotFather) and send `/newbot`.
    *   Follow instructions to set a **Name** (display) and **Username** (must end in `bot`, e.g., `PostPilot_bot`).
    *   Copy the **API Token** provided.

2.  **Get Chat ID**: Message [@userinfobot](https://t.me/userinfobot) and send `/start` to get your numeric Chat ID.

3.  **Add to Environment**: Paste the token as `TELEGRAM_BOT_TOKEN` and the numeric Chat ID as `TELEGRAM_CHAT_ID` in your `.env` or Render variables. `TELEGRAM_CHAT_ID` is used for bot-initiated alerts (e.g. `RESOLVE_FAILED`, rate-limit warnings) that originate from the server rather than as a reply to a user message.

<a id="5-configure-cloudflare-worker-cron"></a>

### 5. Configure Cloudflare Worker Cron

PostPilot uses **Cloudflare Worker Cron** for scheduling.

The Worker calls the protected `POST /api/cron/generate` endpoint on your Render app. PostPilot stores a unique `scheduled_slot_key` per UTC day/slot, so Cloudflare retries and Render cold-start repeats do not create duplicate scheduled drafts. Finished drafts are sent directly from PostPilot to Telegram.

The included schedule is:

| Local time | UTC cron | Slot |
|---|---|---|
| 09:00 IST | `30 3 * * *` | `morning` |
| 13:30 IST | `0 8 * * *` | `afternoon` |
| 22:00 IST | `30 16 * * *` | `night` |

#### One-time Worker setup

From the repo root, enter the Worker folder and create the local Wrangler config.

Windows PowerShell:

```powershell
cd E:\PostPilot\cloudflare
Copy-Item wrangler.toml.example wrangler.toml
```

macOS/Linux:

```bash
cd /path/to/PostPilot/cloudflare
cp wrangler.toml.example wrangler.toml
```

`cloudflare/wrangler.toml` is local deploy config. Keep it untracked; commit `cloudflare/wrangler.toml.example` instead. Because this Worker is deployed with Wrangler, treat `cloudflare/wrangler.toml` as the source of truth for the real deployed schedule and observability settings; dashboard changes should be copied back into `wrangler.toml` and `wrangler.toml.example` before the next deploy.

Log in to Cloudflare.

Windows PowerShell:

```powershell
npx.cmd wrangler login
```

macOS/Linux:

```bash
npx wrangler login
```

If PowerShell blocks `npx` with an execution-policy error, use `npx.cmd` as shown above, or use `cmd /c npx ...`.

#### Worker secrets

Set these Cloudflare Worker secrets. They are stored in Cloudflare, not in `wrangler.toml`.

Windows PowerShell:

```powershell
npx.cmd wrangler secret put POSTPILOT_BASE_URL
npx.cmd wrangler secret put POSTPILOT_INTERNAL_API_KEY
npx.cmd wrangler secret put POSTPILOT_MANUAL_TRIGGER_TOKEN
```

macOS/Linux:

```bash
npx wrangler secret put POSTPILOT_BASE_URL
npx wrangler secret put POSTPILOT_INTERNAL_API_KEY
npx wrangler secret put POSTPILOT_MANUAL_TRIGGER_TOKEN
```

On Windows PowerShell, if copy-paste behaves oddly in the interactive secret prompt, type the value manually. This matters especially for `POSTPILOT_BASE_URL`; a bad paste can store corrupted text and the Worker will later fail with an invalid URL. You can also avoid the interactive prompt by piping the value.

Windows PowerShell:

```powershell
"https://your-app.onrender.com" | npx.cmd wrangler secret put POSTPILOT_BASE_URL
"your-render-internal-api-key" | npx.cmd wrangler secret put POSTPILOT_INTERNAL_API_KEY
"your-manual-trigger-token" | npx.cmd wrangler secret put POSTPILOT_MANUAL_TRIGGER_TOKEN
```

macOS/Linux:

```bash
printf '%s' 'https://your-app.onrender.com' | npx wrangler secret put POSTPILOT_BASE_URL
printf '%s' 'your-render-internal-api-key' | npx wrangler secret put POSTPILOT_INTERNAL_API_KEY
printf '%s' 'your-manual-trigger-token' | npx wrangler secret put POSTPILOT_MANUAL_TRIGGER_TOKEN
```

Secret values:

| Secret | Value |
|---|---|
| `POSTPILOT_BASE_URL` | Your Render app URL, e.g. `https://your-app.onrender.com` |
| `POSTPILOT_INTERNAL_API_KEY` | Same value as Render's `INTERNAL_API_KEY` |
| `POSTPILOT_MANUAL_TRIGGER_TOKEN` | Any long random string used in manual trigger URLs |

Generate a manual trigger token:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Verify the secrets exist:

Windows PowerShell:

```powershell
npx.cmd wrangler secret list
```

macOS/Linux:

```bash
npx wrangler secret list
```

You should see:

```text
POSTPILOT_BASE_URL
POSTPILOT_INTERNAL_API_KEY
POSTPILOT_MANUAL_TRIGGER_TOKEN
```

#### Deploy the Worker

Windows PowerShell:

```powershell
npx.cmd wrangler deploy
```

macOS/Linux:

```bash
npx wrangler deploy
```

Successful deploy output shows the Worker URL and cron triggers, for example:

```text
https://postpilot-cron.<your-subdomain>.workers.dev
schedule: 30 3 * * *
schedule: 0 8 * * *
schedule: 30 16 * * *
```

The first deploy may ask you to register a `workers.dev` subdomain. Choose any unique name. That public Worker URL is normal; it does not expose your secrets.

Optional: if you do not want a public Worker route except for cron/manual paths, add this to `cloudflare/wrangler.toml` and redeploy:

```toml
workers_dev = false
preview_urls = false
```

Do not disable `workers_dev` if you want browser-based manual trigger URLs.

#### Manual generation

The Worker also provides simple protected browser/bookmark URLs for manual generation:

```text
https://<worker-url>/manual/<POSTPILOT_MANUAL_TRIGGER_TOKEN>/morning
https://<worker-url>/manual/<POSTPILOT_MANUAL_TRIGGER_TOKEN>/afternoon
https://<worker-url>/manual/<POSTPILOT_MANUAL_TRIGGER_TOKEN>/night
```

During the first `wrangler deploy`, Cloudflare may ask you to choose a `workers.dev` subdomain. Put that chosen subdomain where this guide shows `example-user`. For example, if Cloudflare gives you `https://postpilot-cron.example-user.workers.dev`, the bookmark formats are:

```text
Morning: https://postpilot-cron.example-user.workers.dev/manual/<POSTPILOT_MANUAL_TRIGGER_TOKEN>/morning
Lunch:   https://postpilot-cron.example-user.workers.dev/manual/<POSTPILOT_MANUAL_TRIGGER_TOKEN>/afternoon
Dinner:  https://postpilot-cron.example-user.workers.dev/manual/<POSTPILOT_MANUAL_TRIGGER_TOKEN>/night
```

Example using a placeholder token:

```text
https://postpilot-cron.example-user.workers.dev/manual/YOUR_ACTUAL_TOKEN/night
```

Optional topic override:

```text
https://<worker-url>/manual/<POSTPILOT_MANUAL_TRIGGER_TOKEN>/night?topic=why%20dev%20tools%20should%20feel%20faster
```

Expected browser response is the PostPilot `/api/generate` JSON response:

```json
{
  "success": true,
  "message": "Generation started in background",
  "tweet_id": "...",
  "status": "GENERATING",
  "checkStatusUrl": "..."
}
```

The manual URL waits until PostPilot accepts the request, then the finished draft arrives in Telegram. Replace `<POSTPILOT_MANUAL_TRIGGER_TOKEN>` with the real token value; do not use the literal placeholder text.

Manual calls intentionally use `/api/generate`, so every click creates a new draft. Scheduled calls use `/api/cron/generate`, which is idempotent per scheduled slot.

#### Logs and debugging

Workers Logs are enabled in `cloudflare/wrangler.toml` and `cloudflare/wrangler.toml.example`:

```toml
[observability]
enabled = true
head_sampling_rate = 1

[observability.logs]
enabled = true
invocation_logs = true
```

After deploy, you can inspect persisted Worker logs in the Cloudflare dashboard:

```text
Workers & Pages -> postpilot-cron -> Observability
```

For live debugging, use the dashboard live logs view:

```text
Workers & Pages -> postpilot-cron -> Logs -> Live
```

or stream the same Worker with Wrangler:

Windows PowerShell:

```powershell
npx.cmd wrangler tail
```

macOS/Linux:

```bash
npx wrangler tail
```

To confirm whether a scheduled cron actually fired, use Cloudflare's cron event history:

```text
Workers & Pages -> postpilot-cron -> Settings -> Trigger Events -> View events
```

Cron Events should show invocations for:

```text
30 3 * * *
0 8 * * *
30 16 * * *
```

Useful log lines:

```text
PostPilot cron trigger accepted
PostPilot manual trigger accepted
PostPilot manual trigger failed
```

If a manual trigger returns `Unauthorized`, your URL token does not match `POSTPILOT_MANUAL_TRIGGER_TOKEN`. If the Worker logs `HTTP 401`, `POSTPILOT_INTERNAL_API_KEY` does not match Render's `INTERNAL_API_KEY`.

Do not manage the production schedule only from the Cloudflare dashboard. Wrangler deploys replace the active Worker configuration with the local `cloudflare/wrangler.toml` settings, so schedule, observability, and route changes must live in `wrangler.toml` first, then be mirrored into `wrangler.toml.example` for future setup safety.

#### Changing schedule or timezone

Cloudflare cron expressions are evaluated in **UTC**, not local time. Convert your desired local time to UTC before editing `cloudflare/wrangler.toml`.

For IST, subtract 5 hours 30 minutes:

```text
09:00 IST -> 03:30 UTC -> 30 3 * * *
13:30 IST -> 08:00 UTC -> 0 8 * * *
22:00 IST -> 16:30 UTC -> 30 16 * * *
```

Update these files when changing the schedule:

1. `cloudflare/wrangler.toml`

```toml
[triggers]
crons = ["30 3 * * *", "0 8 * * *", "30 16 * * *"]
```

2. `cloudflare/wrangler.toml.example`

Keep the same `[triggers]` schedule in the committed example so future local setup does not drop a slot.

3. `cloudflare/postpilot-cron-worker.js`

```js
const SCHEDULE_TO_SLOT = {
  '30 3 * * *': 'morning',
  '0 8 * * *': 'afternoon',
  '30 16 * * *': 'night',
};
```

Then redeploy the Worker.

Windows PowerShell:

```powershell
npx.cmd wrangler deploy
```

macOS/Linux:

```bash
npx wrangler deploy
```

Keep UptimeRobot pointed at your Render root URL every 5 minutes:

```text
https://<your-app-name>.onrender.com/
```

Do not point UptimeRobot at `/api/cron/generate`, `/api/generate`, or any database health endpoint.

> [!IMPORTANT]
> With a baseline of 3 LLM calls per tweet (up to 4 if a diversity re-roll is triggered), three scheduled posts consume roughly 9-12 calls/day. One additional call is reserved daily for persona evolution. Keep `src/rateGuard.ts` aligned with the real provider quota before increasing this schedule.

### Increasing RPM / RPD Limits

Defaults are set in [`src/rateGuard.ts`](src/rateGuard.ts) and must match your active Google AI tier/model quota. Current app-side settings are 5 RPM / 19 RPD:

```typescript
// src/rateGuard.ts
const RPM_LIMIT = 5;      // bump to your tier's RPM
const RPD_LIMIT = 19;     // bump to your tier's RPD
```

When exhausted, the graph short-circuits at [`contentGenerator`](src/agent.ts), marks the tweet `GENERATION_RATE_LIMITED`, and sends a Telegram warning instead of a junk draft. Note: the guard counts all models in one bucket; actual per-model 429s are handled by the LangChain fallback chain.


<a id="database-stability"></a>

## 🛡️ Database Stability

PostPilot runs in **small-pool mode** (`connection_limit=5`) with **explicit sequential query loading** in `contextLoader` and due-task worker scheduling. The workload is ~3 generations/day, but real overlap still happens when `/api/generate`, worker resolution, Telegram callbacks, status/admin checks, and background agent reads land in the same minute.

**How it works** (see [`src/db.ts`](src/db.ts), [`src/agent.ts`](src/agent.ts) `contextLoader`):

1. **Connection-string params** — `connection_limit=5`, `pool_timeout=60`, `connect_timeout=30`, `tcp_keepalives_*`. All required; see the `.env` example in [Configure environment](#2-configure-environment).
2. **Retry-once middleware** — on `P1001 / P1002 / P1008 / P1017` or `"Can't reach database" / "Server has closed" / ECONNREFUSED / ETIMEDOUT`, waits 1.5s and retries the query once. The Prisma engine reconnects transparently on the retry call — no manual `$disconnect()` (which would nuke the only connection and block every other caller).
3. **`ensureDbReady()`** — probes with one retry before `contextLoader`'s query sequence, so a cold socket reconnects on one probe rather than on the first real query.
4. **Sequential loading in `contextLoader`** — the DB-touching reads run as explicit `await`s instead of `Promise.all`. Even with a small pool, unbounded fake parallelism can occupy every slot during a slow DB/network window. Explicit sequencing bounds any single-query stall to that one query. The non-DB `getTrendingTopics()` scrape still overlaps the DB sequence — it doesn't touch the socket.
5. **Due-task worker scheduling** — `src/worker.ts` sleeps until the earliest pending `RetryQueue.process_after`, with a 15-minute idle reconciliation cap. `enqueueRetry()` wakes the scheduler immediately for newly queued work. The hot lookup is backed by `@@index([status, process_after, created_at])`.

`canCallLLM()` also fails **open** on DB error so a transient blip never blocks generation.

**Wall-clock impact:** `contextLoader` runs ~400–500ms total (was ~350ms in serialized-Promise.all mode, ~80ms on a real pool). Invisible against the Cloudflare Worker retry window.

**Log-level discipline:** middleware retries log at `WARN` (normal recovery, not an alarm). The worker's per-tick connection failures also log at `WARN`. The only `ERROR`/`CRITICAL` line is the one inside `scheduledWorkerTick` that fires after **5 consecutive** connection failures — i.e. "DB has been unreachable for ~5 minutes, something is actually wrong." That's the one line worth paging on. See [Worker & Logging](#-background-workers).

### Keeping logs quiet

Supavisor on free tier drops idle sockets after ~5 min. The middleware in `src/db.ts` reconnects transparently on the next real query, logging a single `WARN`. A prior `/health/db` keepalive endpoint was removed: during cross-region network flaps it competed with real work for the single pool slot (45s hangs), made UptimeRobot report the service DOWN during recoverable blips, and added more noise than it saved.

The worker no longer polls every 60s while idle. It sleeps until the next due `RetryQueue` task, or at most 15 minutes when the queue is empty. Single connection failures stay quiet; WARN logs start after 3 consecutive worker DB failures and CRITICAL logs remain reserved for 5 consecutive failures.

Migration `20260427000000_add_retry_queue_due_index` has been applied to Supabase. Verification surface: `prisma migrate status` should report `Database schema is up to date!`, and Postgres should have `RetryQueue_status_process_after_created_at_idx`.

> If Render still has `connection_limit=1` or `connection_limit=3`, update only that query parameter to `connection_limit=5` and redeploy. Keep `pool_timeout=60`, `connect_timeout=30`, `pgbouncer=true`, and the TCP keepalive params unchanged.

### Troubleshooting: `P1001` on port **5432** during deploy

If your first Render deploy fails with:

```
Error: P1001: Can't reach database server at `aws-1-ap-south-1.pooler.supabase.com:5432`
```

That's `DIRECT_URL` (port 5432, session pooler) during `prisma migrate deploy` at boot — **not** `DATABASE_URL`. Usually a Supabase cold-start blip, not a config problem.

**Fix in order:**

1. **Retry the deploy.** Render dashboard → *Manual Deploy → Deploy latest commit*. ~95% of the time it goes through on the second try.
2. **If it fails again, bump `connect_timeout` on `DIRECT_URL` to 30s:**
   ```env
   DIRECT_URL=postgresql://postgres.[ref]:[PASSWORD]@aws-1-ap-south-1.pooler.supabase.com:5432/postgres?connect_timeout=30
   ```
3. **If it still fails,** check Supabase dashboard → Project → Settings → Database. Free-tier projects pause after ~7 days idle; hit *Restore* and redeploy.

Runtime is unaffected — `DIRECT_URL` is only used during `prisma migrate deploy` at startup.

<a id="analytics-grafana"></a>

## 📊 Analytics (Grafana)

PostPilot ships three pre-built Grafana dashboards that replace the need to open Supabase for any day-to-day monitoring.

| Dashboard | What it shows |
|---|---|
| Tweet Performance | Lifecycle, engagement curves, outcome scores, topic leaderboard |
| System Health | LLM budget gauges, worker queue, resolution funnel, failed tasks |
| Learning Loop | Quality trends, Pearson r, feedback, persona evolution, topic blacklist |

### 1. Sign up for Grafana Cloud

Go to [grafana.com](https://grafana.com/products/cloud/) → **Start for free**. Your stack URL will be `https://<your-org>.grafana.net`.

### 2. Get your API key

1. Grafana UI → **Administration → Users and access → Service accounts**
2. **Add service account** — name: `postpilot`, role: **Admin** (Admin is required for data source creation on Grafana Cloud)
3. Click the account → **Add service account token** → Generate → copy the token (starts with `glsa_`)

### 3. Add to `.env`

```env
GRAFANA_URL=https://<your-org>.grafana.net
GRAFANA_API_KEY=glsa_...
```

### 4. Run the provision script

```bash
node grafana/provision.js
```

Output example:
```
✅ Data source created (uid: abc123)
✅ Imported: tweet-performance.json → https://<your-org>.grafana.net/d/postpilot-tweet-performance/...
✅ Imported: system-health.json → https://<your-org>.grafana.net/d/postpilot-system-health/...
✅ Imported: learning-loop.json → https://<your-org>.grafana.net/d/postpilot-learning-loop/...
```

Open the printed URLs or go to `https://<your-org>.grafana.net/dashboards` to see all three dashboards.

The script is idempotent — safe to re-run after dashboard changes.

Optional Telegram alerts for LLM budget (≥80%) and worker failures — see [grafana/README.md](grafana/README.md).

## 🚢 Deployment

PostPilot is optimized for the **Render Free Tier**, utilizing a monolith architecture to keep the server and background worker running in a single process.

### Render (Recommended Free Tier)

1. **Create Web Service**: Connect your GitHub repository to Render.
2. **Build Command**: `npm run build` (runs `prisma generate`).
3. **Start Command**: `npm start` (runs migrations, then starts the server + in-process worker).
4. **Dashboard Release Command**: run `npm run release` when you want to apply migrations and dashboard changes without starting the web service.
5. **Environment Variables**:
   - `DATABASE_URL`: Transaction Pooler (Port 6543) + full stability params — see the `.env` example in [Configure environment](#2-configure-environment). Key value: `connection_limit=5` + `pool_timeout=60` and all five `tcp_keepalives_*` / `connect_timeout` params are required. See [Database Stability](#database-stability) for why small-pool mode.

   - `DIRECT_URL`: Session Pooler (Port 5432) for migrations; no `pgbouncer=true` query param. Username must be `postgres.PROJECT_REF`.

   - `BASE_URL`: Your Render dashboard URL (e.g., `https://<your-app-name>.onrender.com`).

   - Add all other keys listed in the [Setup](#setup) section.

### 24/7 Keep-Alive (UptimeRobot)

Render's free tier sleeps after 15 minutes of inactivity. A single monitor keeps it awake:

1. Create a free account at [UptimeRobot.com](https://uptimerobot.com/).
2. Click **+ Add New Monitor**.
3. **Monitor Type**: `HTTP(s)`
4. **Friendly Name**: `PostPilot-Live`
5. **URL**: `https://<your-app-name>.onrender.com/`
6. **Monitoring Interval**: Every `5 minutes`.
7. Click **Create Monitor**.

> Do **not** add a second monitor against `/health/db` — that endpoint was removed. During cross-region Supavisor flaps it held the single Prisma slot for 45s and made UptimeRobot report the service as DOWN during recoverable blips.

### Railway (Alternative)

If you prefer Railway, you can deploy as a single service using `npm start` or as two separate services using `npm start` (API) and `npm run worker` (Worker). Ensure you set both `DATABASE_URL` and `DIRECT_URL`.

## 💻 CLI Commands

| Command | Description |
| :--- | :--- |
| `npm run dev` | Start API server in watch mode (nodemon) |
| `npm start` | Run migrations, then start API server and in-process worker |
| `npm run worker` | Start only the background task processor |
| `npm run migrate` | Apply pending migrations to database |
| `npm run provision:grafana` | Provision Grafana datasource and dashboards |
| `npm run release` | Run migrations, then provision Grafana |
| `npx prisma migrate dev --name <name>` | Create and apply a new migration |
| `npx prisma generate` | Regenerate Prisma client types |

<a id="safety--policy-compliance"></a>

## 🛡️ Safety & Policy Compliance

PostPilot is designed as a **Stealth Agent**. Unlike traditional bots that risk account suspension through aggressive API automation, PostPilot prioritizes long-term account safety via four key strategies:

- **Human-in-the-Loop (HITL)**: AI drafts, you post. No account credentials ever handed to an automated script — you stay a regular user in X's eyes.

- **Layered Resolution**: Zero-width Unicode (`U+200B`/`U+200C`) fingerprints, tolerant truncated-fingerprint matching, and visible-text fallback link drafts to engagement without using the Official X API or visible tracking IDs.

- **Decoupled Scraping**: Tracking via Nitter + public Syndication API. Your account is never used to scrape, so tracking rate-limits never touch your handle.

- **Content Diversity Gate**: Dual-layer check (trigram Jaccard + FORMAT-prefixed structural fingerprint) plus LRU rotation across 8 format archetypes with hard banned-opening lists. Survives Render restarts via heuristic format-map backfill (no schema migration). Protects against shadowbans and same-shape pattern decay.

<a id="hard-constraints"></a>

## ⚖️ Hard Constraints

- **Max 3 LLM calls** per tweet generation in the happy path (contentGenerator, qualityScorer, autoRefiner-conditional). Worst case 4 with a diversity re-roll (single extra `contentGenerator` call).

- **Max 1 LLM call/day** for persona evolution (offline, via EVOLVE_PERSONA task).

- **Google AI Studio limits:** current app-side guard is 5 RPM / 19 RPD in `src/rateGuard.ts`. Keep those constants aligned with the actual quota for the active Google AI tier/model. When exhausted, the agent graph **short-circuits** at `contentGenerator` — no garbage fallback draft is shipped to Telegram; the tweet is marked `GENERATION_RATE_LIMITED` and a Telegram warning is sent instead. See [Increasing RPM / RPD Limits](#increasing-rpm--rpd-limits).

- **Data-Driven Analysis**: The analytical heavy-lifting—scoring engagement, weighting feedback, and tracking trends—is handled via pure math (zero LLM calls). This maximizes budget efficiency by reserving LLM power for the final **Persona Evolution** step, where data is synthesized into new personality traits.

- **LangGraph pipeline shape:** `contextLoader → personaAdapter → contentGenerator → diversityGate → qualityScorer → coherenceGate → [autoRefiner if score<8 OR coherence failed] → finalTopicMemory → END`. Re-roll edge: `diversityGate → personaAdapter → contentGenerator` (capped at 1; new format archetype + rejected fingerprint injected into the retry prompt). The route back is keyed to active `rejectedFingerprint` state, not `rerollCount` alone, so a passed re-roll cannot loop and burn the 5 RPM budget.


