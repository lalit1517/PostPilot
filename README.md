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
  - [5. Configure n8n](#5-configure-n8n)
- [Database Stability](#database-stability)
- [Safety & Policy Compliance](#safety--policy-compliance)
- [Hard Constraints](#hard-constraints)
- [Analytics (Grafana)](#analytics-grafana)

## 💡 Core Innovations


- **Invisible Fingerprinting**: Programmatic tweet-resolution using zero-width Unicode characters. This "watermarks" every draft, allowing the background worker to link live tweets to specific LLM versions without requiring the expensive official X API. 🔒

- **LangGraph Orchestration**: Built on a Directed Acyclic Graph (DAG) rather than a simple prompt. Features a **Dual-Layer Diversity Gate** (text trigram + topic-agnostic structural fingerprint), a **Format Rotation System** that forces LRU archetype variety with FORMAT-prefixed fingerprints (survives restarts via heuristic backfill), a **Topic Coherence Gate** that validates draft-topic alignment without an extra LLM call, a **Two-Layer Trend Relevance Filter** (regex hard-exclude + domain keyword scoring), **Hard Prompt Prohibitions** extracted from persona AVOID sections, and a **Conditional Auto-Refiner** that triggers on low scores OR coherence mismatches.

- **Autonomous Persona Evolution**: A true closed-loop self-learning system. It analyzes its own top-performing tweets every 22 hours, extracts new stylistic patterns, and automatically updates its system prompt to align with audience resonance. 🧪

- **Free-Tier Monolith Architecture**: High-density engineering designed specifically for resource-constrained environments. Consolidates the Express API and a multi-task Background Worker into a single process that fits perfectly within Render's Free Tier.

- **Scientific Quality Analysis**: Includes advanced analytics like **Pearson Correlation** tracking between LLM-assigned quality scores and real-world engagement, allowing for data-backed calibration of the agent's intelligence. 📈


## 🛠️ Tech Stack

| Layer | Technology |
| :--- | :--- |
| Runtime | Node.js 20+ / TypeScript |
| Framework | Express 5 |
| AI Engine | LangGraph + Google Gemini (via @langchain/google-genai) |
| Database | PostgreSQL via Prisma ORM (Supabase) |
| Scheduling | n8n |
| Notifications | Telegram Bot API |
| Logging | Pino |
| Infrastructure | Render (Compute) + UptimeRobot (Keep-alive) |


## 🏗️ Architecture

```
n8n (scheduler)           Telegram (notifications)
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

1. **Orchestration** — n8n triggers generation at 08:00, 14:00, 20:00 UTC. Telegram delivers drafts with inline buttons (post, edit, feedback).

2. **Intelligence** — LangGraph StateGraph with 7 nodes (contextLoader, personaAdapter, contentGenerator, diversityGate, qualityScorer, coherenceGate, autoRefiner). Gemini 2.5 Flash primary, with fallback chain.

3. **Persistence** — PostgreSQL via Prisma ORM on Supabase. RetryQueue manages async tasks (tweet resolution, engagement tracking, persona evolution).


## 🔄 Self-Learning Pipeline

PostPilot improves its own writing over time without manual tuning.

```
Generation (3 LLM calls max)
  -> qualityScorer persists quality_score to TweetVersion
  -> Engagement tracked at 10m, 1h, 6h, 24h, 48h, 72h
  -> At 72h: computeOutcomeScore() -> TweetOutcome record
  -> reweightFeedback() -> updates Feedback.weighted_score
  -> If 5+ high-tier tweets since last evolution -> enqueue EVOLVE_PERSONA
  -> evolvePersona() (1 LLM call, 22h cooldown) -> new PersonaProfile
  -> Next generation picks up: weighted feedback + learned persona
```


### Modules



| Module | File | LLM Calls | Purpose |
| :--- | :--- | :--- | :--- |
| Outcome Scorer | `src/outcomeScorer.ts` | 0 | Normalizes peak engagement (0-100) with min-max scaling vs 30-day window. Persists `topic`, `time_of_day`, `day_of_week` for analytics. Tiers: top 20% = high, bottom 30% = low. |
| Feedback Weighter | `src/feedbackWeighter.ts` | 0 | Weights feedback by nearby tweet outcomes (±3 day window), recency decay `1 / (1 + days_since)`, and sentiment multiplier from `feedbackSentiment`. |
| Feedback Sentiment | `src/feedbackSentiment.ts` | 0 | Regex/keyword classifier: `positive \| negative \| stylistic \| neutral`. Multipliers 1.2 / 1.3 / 1.0 / 0.8. |
| Draft Diversity | `src/draftDiversity.ts` | 0 | Dual-layer check against last 20 drafts: (1) trigram Jaccard ≥ 0.65, (2) structural fingerprint match against last 5 drafts. Topic-agnostic opening classifier + arc tokens. Emits a `DiversityReport` on every rejection. Ships an in-memory **format map** (LRU 30) and a boot-time **heuristic backfill** (`guessFormatFromContent`) so FORMAT-prefixed fingerprints survive Render restarts. |
| Draft Formats | `src/draftFormats.ts` | 0 | 8 archetypes, each with `openingTemplate`, `bannedOpenings`, `bannedPhrases?`, `exampleFirstSentence`. `getNextFormatWithMeta()` exposes which formats were considered + unused count for logging. Pure and deterministic. |
| Trend Relevance | `src/trendRelevance.ts` | 0 | Two-layer filter on Trends24 output. Layer 1: regex hard-exclude (non-ASCII, politics/sports/entertainment/crypto/horoscope, <4 chars, pure numbers). Layer 2: word-boundary keyword overlap against `OWNER_PROFILE.domainKeywords` — score 0 → reject. Replaced the old naive substring filter. |
| Topic Coherence | `src/topicCoherence.ts` | 0 | Pure-string gate that passes on (a) topic keyword overlap with draft OR (b) on-domain pivot (≥2 domain keywords). Feeds the `coherenceGate` graph node. |
| Topic Memory | `src/topicMemory.ts` | 0 | In-memory 48h topic cooldown + per-topic coherence failure counter. Survives DB outages; DB is long-term authoritative. 3-strike rule auto-blacklists a topic. |
| Trends | `src/trends.ts` | 0 | Scrapes Trends24 global trends, 30-min cache, stale fallback on fetch error. Tracks `consecutiveZeroFetches` — on 3 consecutive zero parses logs CRITICAL (regex may have drifted) and nulls the cache to retry fresh. |
| Analytics | `src/analytics.ts` | 0 | `getEngagementPattern()` (slot × day pivot), `getTopicPerformance()` (topic leaderboard), `getQualityOutcomeCorrelation()` (Pearson r). |
| Persona Evolver | `src/personaEvolver.ts` | 1/day | Analyzes top 10 high-tier tweets, extracts TONE/STRUCTURE/STRONG_TOPICS/AVOID/SIGNATURE_PHRASES. Runs a **Structure Diversity Audit**: flags any opening or narrative arc shared by 3+ top posts under AVOID (`OVERUSED_STRUCTURE`, `OVERUSED_ARC`, `OVERUSED_PHRASE`). Voice constraint reads from `OWNER_PROFILE.voiceSeed`. **Persona drift detection**: word-overlap vs. previous profile > 0.85 logs a WARN ("high-tier tweets may be too homogeneous"). 22h cooldown gate. |
| Rate Guard | `src/rateGuard.ts` | 0 | Tracks calls in `LlmCallLog`. Blocks at 5 RPM or 19 RPD. On block, returns `nextAvailableAt` ISO timestamp so logs carry actionable info. `getRateStatus()` exposes current consumption. Prunes entries older than 48h. |


## 🧠 AI Agent (LangGraph)

**Pipeline:** `START -> contextLoader -> personaAdapter -> contentGenerator -> diversityGate -> qualityScorer -> coherenceGate -> [autoRefiner if score < 8 OR coherence failed] -> END`

**Re-roll edge:** `diversityGate -> personaAdapter` (capped at 1 re-roll). On rejection, a **different format archetype** is selected via `getNextFormatWithMeta()` and the rejected fingerprint + draft are persisted to state. `contentGenerator` then injects a `[STRUCTURAL RE-ROLL]` block naming the exact fingerprint and draft the model must NOT reproduce. The reroll routes through `personaAdapter` so the new format + prohibitions bake into the prompt before the retry.

**Rate-limit short-circuit edge:** `contentGenerator -> END` when `rateLimited === true`. Skips diversityGate, qualityScorer, coherenceGate, autoRefiner, and the n8n webhook. Tweet is marked `GENERATION_RATE_LIMITED` and a Telegram warning is sent instead.

| Node | LLM Call | Behavior |
| :--- | :--- | :--- |
| `contextLoader` | No | Sequential DB fetch: top 5 tweets, weighted feedback (fallback to unweighted if < 3), active PersonaProfile, `computeLengthTarget()`, `computeTopicBlacklist()` (merges DB bottom-20% with in-memory cooldown — logs `blacklistSource: 'db+memory' \| 'memory_only'`), last 15 FORMAT-prefixed structural fingerprints. Trends24 pulled in parallel (non-DB) and filtered via `filterRelevantTrends()` — regex hard-exclusion + domain keyword scoring. When zero trends survive, sets `topicFree: true` on state. Extracts `OVERUSED_STRUCTURE/ARC/PHRASE` entries from the learned persona's AVOID section into `hardProhibitions`. Selects the next `FormatArchetype` via `getNextFormatWithMeta()` and logs `{ selectedFormat, recentFormatsConsidered, unusedFormatsCount }` — rotation is verifiable from logs. |
| `personaAdapter` | No | Builds the prompt top-down: (1) `---HARD PROHIBITIONS---` block (overused structures/arcs/phrases from persona AVOID — stated as structural violations that cause rejection), (2) `---FORMAT DIRECTIVE (MANDATORY)---` block with the archetype's `openingTemplate`, `bannedOpenings`, `bannedPhrases?`, and `exampleFirstSentence`, ending in "Violation makes the draft invalid, the quality scorer will reject it", (3) `OWNER_IDENTITY` from `src/config/ownerProfile.ts`, (4) learned persona, few-shot exemplars, trending hint, topic-free banner (when applicable), length target, topic blacklist, tone-by-time-of-day, feedback guidelines, recency/casing rules, and the `VOICE ANTI-PATTERNS` guardrail. |
| `contentGenerator` | Yes | Generates `TOPIC\|DRAFT`. Rate-guarded via `canCallLLM()` (returns `nextAvailableAt` timestamp on block). Cold-start fallback: when no topic + `topicFree`, picks from `OWNER_PROFILE.coldStartTopics`. Structural re-roll: when `state.rejectedFingerprint` is set, injects a block naming the exact fingerprint + draft the model must NOT reproduce. Output passed through `finalizeDraft()`. Calls `registerDraftFormat(tweetId, formatName)` so future fingerprint reads attach the FORMAT: prefix. On rate-limit, sets `rateLimited: true` and the graph short-circuits to `END`. |
| `diversityGate` | No | Runs `checkDraftDiversity()` against the last 20 drafts. Dual check: (1) trigram Jaccard ≥ 0.65, (2) structural fingerprint match against last 5. On duplicate, picks a **new format** for the re-roll and persists `rejectedFingerprint` + `rejectedDraft`; routes via `personaAdapter` → `contentGenerator`. Second duplicate accepted. Accepted drafts push `FORMAT:<name>\|OPEN:<kind>\|<arc tokens>` to the in-memory ring buffer and clear the reject-state. Counts the draft's own fingerprint against recent history → `structuralRepetitionCount` state field consumed by the scorer. |
| `qualityScorer` | Yes | Prompt now opens with a `---STRUCTURAL CONTEXT FOR SCORING---` block naming the draft's fingerprint, its count in recent history, and explicit penalty rules (-1 at 2+ matches, -2 at 4+). Scores 1-10 via `parseScore()` with voice-authenticity criteria. Runs `parseCritiqueHints()` → fixed hint vocabulary (`too_long`, `weak_hook`, `vague_claim`, `low_energy`, `cliche`, `too_jargon`, `weak_ending`, `poor_flow`, `needs_emotion`, `low_quality`, `wrong_voice`, plus `topic_drift` added by coherenceGate). Persists `quality_score` to TweetVersion. |
| `coherenceGate` | No | Pure-string check via `checkTopicCoherence()`. Passes when topic is empty, or draft shares a topic keyword, or draft has ≥2 domain keywords (on-domain pivot). On mismatch: increments per-topic failure counter, degrades a high score to 6 to force a refiner pass, appends `topic_drift` to hints. At 3 strikes, auto-blacklists the topic via `recordTopicUsed`. |
| `autoRefiner` | Conditional | Runs when score < 8 OR coherence failed. Reuses `state.personaParameters` (carries HARD PROHIBITIONS + FORMAT DIRECTIVE at top) and tells the model it MUST still obey those constraints on rewrite. Maps hints → `HINT_DIRECTIVES` (e.g. `topic_drift` → "TOPIC GROUNDING — draft must explicitly reference topic X, if irrelevant, acknowledge and pivot"). Output gated by `isSuspiciousDraft()`; rejection keeps original. |


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

- `recordTopicUsed(topic)` / `isTopicOnCooldown(topic)` / `getInMemoryBlacklist()` / `incrementCoherenceFailure(topic)` — in-memory 48h cooldown + 3-strike coherence counter.

- `filterRelevantTrends(trends)` — two-layer trend filter. Returns `{ relevant, excluded }` with per-trend rejection reason.

**Models:** `gemini-2.5-flash` (primary, `thinkingBudget: 1024`) -> `gemini-3.1-flash-lite-preview` -> `gemini-3-flash-preview` -> `gemini-2.5-flash-lite` (fallbacks)

**Config:** Temperature 0.7, max 2048 output tokens, topP 0.9, 2-minute timeout per call.


## 👷 Background Workers

The `RetryQueue` table manages three async task types processed every 10 seconds.

### 🔘 Telegram Buttons — What Each Does

When a draft arrives in Telegram, you get four buttons. Here's exactly what each one does:


**🚀 Open in X** — the primary posting path. Tapping it:

1. Hits `/api/post-intent` on the server (logs the click, enqueues `RESOLVE_TWEET` with a 10-min delay)

2. Redirects your browser to X's compose box, pre-filled with the draft + invisible fingerprint

3. You post it manually on X

4. 10 minutes later, `RESOLVE_TWEET` fires automatically and matches the fingerprint → marks `POSTED_CONFIRMED` → starts engagement tracking


**✅ Posted** — manual override only. Use this when:

- You destroyed the fingerprint (edited the tweet end on X before posting)

- Nitter and Twitter timeline both failed to find the tweet

- You posted but the auto-detection silently failed

Tapping it immediately sets `posted=true`, `status=POSTED_CONFIRMED`, enqueues `RESOLVE_TWEET`, persists the Telegram `chat_id` + `message_id` on the Tweet row, and **mutates the button label to "✅ Marked as Posted"** in the same Telegram message.

If `RESOLVE_TWEET` still finds nothing after all retries (~55 min total: 10 min initial + 45 min fallback), the worker:

1. Marks the tweet `RESOLVE_FAILED` and resets `posted=false`, `posted_at=null`.
2. Edits the original Telegram message via `editMessageReplyMarkup`, replacing the button with **"↩️ Not Posted (resolution failed)"**.

This covers two common cases: you clicked ✅ Posted but never actually posted, or the tweet got deleted/unpublished before the worker could confirm it. No manual cleanup needed — the Telegram message self-corrects.

> **You almost never need the Posted button.** Open in X handles everything automatically via fingerprint. Posted is the escape hatch for when things go wrong.


**✏️ Edit Topic / 💬 Feedback** — open secure HMAC-signed web forms. Submit triggers a full regeneration with the new topic or feedback injected into the pipeline.


**📋 Copy** — sends the raw draft text to your Telegram chat for manual copy-paste.

### RESOLVE_TWEET



Detects posted tweets via invisible fingerprint matching.

1. Triggered 10 minutes after user confirms posting (via Telegram button or intent link redirect).

2. Polls 4 Nitter instances (`nitter.net`, `nitter.privacydev.net`, `nitter.poast.org`, `nitter.space`) and falls back to the native Twitter timeline with browser-like headers.

3. Matches the 8-char hex fingerprint embedded as invisible Unicode (`U+200B`/`U+200C`). Fingerprint generation pre-checks the DB to avoid `@unique` collisions.

4. On match: marks tweet as `POSTED_CONFIRMED`, schedules first engagement fetch.

5. On miss: one delayed retry at ~45 minutes, then sets status to `RESOLVE_FAILED` and resets `posted=false`, `posted_at=null` — prevents the tweet from silently appearing as posted when it wasn't confirmed.

**Editing tweets before posting:** The invisible fingerprint is appended after a trailing space at the very end of the draft — i.e. `[tweet text] [invisible chars]`. It is safe to edit any visible part of the tweet in X's compose box, including adding, changing, or removing text and punctuation. The fingerprint is only destroyed if you delete characters past the last visible character (i.e. backspace through the trailing space into the invisible suffix), or select-all and retype. When in doubt: edit the middle, leave the end alone.

### FETCH_ENGAGEMENT

Time-series engagement tracking at fixed intervals.

| Attempt | Time After Post | Action |
| :--- | :--- | :--- |
| 1 | 10 min | First snapshot |
| 2 | 1 hour | Second snapshot |
| 3 | 6 hours | Third snapshot |
| 4 | 24 hours | Fourth snapshot |
| 5 | 48 hours | Final snapshot + outcome scoring |

At attempt 5 (final):

- Calls `computeOutcomeScore()` to create `TweetOutcome` record

- Calls `reweightFeedback()` to update all feedback weights

- Checks if 5+ new high-tier tweets exist since last persona evolution — if so, enqueues `EVOLVE_PERSONA`

**Cooldown:** 5-minute minimum between snapshots. Anti-bot jitter on all requests (0-2000ms).

#### Customizing Tracking Intervals
PostPilot tracks engagement over 48–72 hours by default. You can change this duration by editing `src/worker.ts`:

*   **Total Tracking Days**: To track for longer (e.g., 7 days):

    1.  In `fetchTweetEngagement`, add more `else if (attempt === X)` blocks to define the delays for Days 3, 4, 5, 6, and 7.

    2.  Update the **finalization block** (`if (attempt === 5)`) to match your new final attempt number (e.g., `if (attempt === 10)`).


    ```typescript
    // src/worker.ts (~line 288)
    if (attempt === 1) nextFetchDelay = 50 * 60 * 1000;         // Day 0: 10m -> 1h
    else if (attempt === 2) nextFetchDelay = 5 * 60 * 60 * 1000;  // Day 0: 1h -> 6h
    else if (attempt === 3) nextFetchDelay = 18 * 60 * 60 * 1000; // Day 0 -> Day 1 (24h)
    else if (attempt >= 4 && attempt < 10) {
      nextFetchDelay = 24 * 60 * 60 * 1000;                      // Day 2, 3, 4, 5, 6, 7
    }
    ```

*   **Important**: If you increase the number of attempts beyond 5, you must also update the `max_retries` value in the `enqueueRetry` call (around line 171) to ensure the database doesn't mark the task as failed before it finishes the 7-day cycle.

### EVOLVE_PERSONA

Calls `evolvePersona()` — 1 LLM call with 22-hour cooldown. Deactivates previous profiles, creates new active `PersonaProfile`.

### Scheduled: Feedback Reweight



`reweightFeedback()` runs independently every 6 hours via in-memory timestamp gate in the worker loop.

## 🔌 API Reference

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/` | Health check |
| `POST` | `/api/generate` | Start async tweet generation. Returns `202` with `tweet_id` immediately. |
| `GET` | `/api/status?id=` | Poll generation status and latest draft |
| `GET` | `/api/analytics?id=` | Full engagement time-series for a tweet |
| `GET` | `/api/post-intent?id=&username=&intent=` | Redirect tracker — logs click-through, enqueues resolution, redirects to X |
| `GET` | `/api/view-edit?id=&token=` | HTML form for topic editing |
| `GET` | `/api/view-feedback?id=&token=` | HTML form for feedback submission |
| `POST` | `/api/edit` | Update topic + trigger regeneration |
| `POST` | `/api/feedback` | Submit feedback + trigger regeneration |
| `POST` | `/api/telegram/webhook` | Telegram bot callback handler (posted confirmation, copy tweet) |
| `GET` | `/api/admin/rate-status` | Current RPM/RPD consumption and remaining budget from `LlmCallLog` |
| `GET` | `/api/admin/failed-tasks?limit=N` | Dead letter queue — inspect `RetryQueue` rows with `status = FAILED` |
| `GET` | `/api/admin/engagement-pattern` | Aggregates `TweetOutcome` by `time_of_day`, `day_of_week`, and the time × day pivot |
| `GET` | `/api/admin/topic-performance?limit=N` | Top-performing topics ranked by avg outcome score |
| `GET` | `/api/admin/quality-correlation` | Pearson r between LLM `quality_score` and real `outcome_score` |

**Security:** Edit/feedback URLs are signed with HMAC-SHA256 (8-char prefix). Verified via timing-safe comparison.

## 🗄️ Database Schema

8 models on PostgreSQL (Supabase), managed by Prisma ORM.

| Model | Purpose |
| :--- | :--- |
| `Tweet` | Master record — topic, status (`PENDING`, `GENERATING`, `APPROVED`, `POSTED_CONFIRMED`, `RESOLVE_FAILED`, `GENERATION_RATE_LIMITED`, `ERROR`), fingerprint, live_url, posted_at, `telegram_chat_id` + `telegram_message_id` (persisted on ✅ Posted click so worker can revert the button to "↩️ Not Posted" on `RESOLVE_FAILED`) |
| `TweetVersion` | Versioned drafts with `quality_score` (set by qualityScorer) |
| `Feedback` | User feedback with `weighted_score` (computed by feedbackWeighter) |
| `Engagement` | Time-series snapshots — likes, retweets, impressions at each interval |
| `TweetOutcome` | Normalized 0-100 outcome score, tier (high/medium/low), peak metrics, `topic`, `time_of_day`, `day_of_week`. One per tweet, computed at 72h. Indexed on tier/time/day. |
| `PersonaProfile` | Versioned persona documents with auto-increment version and `is_active` flag |
| `LlmCallLog` | Rate limiting ledger with `called_at` index, pruned to 48h window |
| `RetryQueue` | Task queue — RESOLVE_TWEET, FETCH_ENGAGEMENT, EVOLVE_PERSONA |




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
| `trendKeywords` | legacy, kept for back-compat | Older broader list. Real relevance filter uses `domainKeywords`. |
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

## ⚙️ Setup

### Prerequisites



- Node.js 20+

- PostgreSQL database (Supabase recommended)

- [Google AI Studio API key](https://aistudio.google.com/app/apikey)

- Telegram bot (for notifications)

- n8n instance (for scheduling)

### 1. Install dependencies



```bash
npm install
```


### 2. Configure environment

> **Persona configuration lives in [`src/config/ownerProfile.ts`](src/config/ownerProfile.ts), NOT in `.env`.** See [Customizing the Owner Profile](#customizing-the-owner-profile). `.env` is only for secrets and infra.

Create `.env` in the project root (use `.env.example` as a template):

```env
DATABASE_URL=postgresql://postgres.[ref]:[PASSWORD]@aws-1-ap-south-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1&pool_timeout=60&connect_timeout=15&tcp_keepalives_idle=60&tcp_keepalives_interval=10&tcp_keepalives_count=5
                                       # Supabase transaction pooler (port 6543) for Prisma runtime.
                                       # Stability params (ALL required, see src/db.ts comment block):
                                       #   connection_limit=1            — single serialized socket; eliminates pool-state bugs for this workload (3 tweets/day, no concurrency)
                                       #   pool_timeout=60                — wait up to 60s for the single slot (covers contextLoader's Promise.all(9) queueing end-to-end)
                                       #   connect_timeout=15             — boot-time guard against Supavisor cold-start P1001
                                       #   tcp_keepalives_idle=60         — OS-level TCP keepalive every 60s
                                       #   tcp_keepalives_interval=10     — probe retry every 10s if idle
                                       #   tcp_keepalives_count=5         — 5 failed probes = dead socket
DIRECT_URL=postgresql://postgres.[ref]:[PASSWORD]@aws-1-ap-south-1.pooler.supabase.com:5432/postgres
                                       # Supabase session pooler (port 5432) for Prisma migrations; no pgbouncer query param.
                                       # Username MUST be `postgres.PROJECT_REF` (Supavisor format), not bare `postgres`.
GOOGLE_API_KEY=...                     # Get from https://aistudio.google.com/app/apikey
                                       # Choose models (Gemini 1.5/2.0/Flash) based on their specific RPM/RPD limits.
X_USERNAME=your_handle                 # X handle for tweet resolution scraping
BASE_URL=https://your-domain.com       # Deployment root URL
HMAC_SECRET=...                        # 64-char hex for URL signing (see below)
TELEGRAM_BOT_TOKEN=...                 # From @BotFather
TELEGRAM_CHAT_ID=...                   # Numeric chat ID from @userinfobot — used for bot-initiated alerts (RESOLVE_FAILED, rate-limit warnings)
TELEGRAM_WEBHOOK_SECRET=...            # Secret token for Telegram webhook verification (see below)
N8N_WEBHOOK_URL=https://...            # n8n webhook URL for draft-ready callbacks
INTERNAL_API_KEY=...                   # API key protecting admin + generate endpoints (see below)
PORT=3000                              # Express server port

GRAFANA_URL=https://yourorg.grafana.net  # Grafana Cloud stack URL (for dashboard provisioning)

GRAFANA_API_KEY=...                    # Grafana service account token with Admin role (see grafana/README.md)

GRAFANA_DATABASE_URL=postgresql://postgres.[ref]:[PASSWORD]@aws-1-ap-south-1.pooler.supabase.com:5432/postgres
                                       # Supabase session pooler (port 5432) for Grafana
```

Generate `HMAC_SECRET` and `TELEGRAM_WEBHOOK_SECRET` (64-char hex):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Generate `INTERNAL_API_KEY` (base64, URL-safe):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

`INTERNAL_API_KEY` is required in the `X-API-Key` header for all `/api/admin/*`, `/api/generate`, and `/api/retries/process` requests.

**Register the Telegram webhook** — without this, button clicks (✅ Posted, 📋 Copy) never reach the server and nothing happens. Paste into a browser address bar (or `curl`), replacing `<TOKEN>` / `<BASE_URL>` / `<TELEGRAM_WEBHOOK_SECRET>` with your values:

```
https://api.telegram.org/bot<TOKEN>/setWebhook?url=<BASE_URL>/api/telegram/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>
```

Expect `{"ok":true,"result":true,"description":"Webhook was set"}`. Verify anytime with `https://api.telegram.org/bot<TOKEN>/getWebhookInfo`. The `secret_token` is checked on every incoming callback — mismatch returns `403` and the button click is rejected.

### 3. Set up the database



```bash
npx prisma migrate deploy
npx prisma generate
```

### 4. Set up Telegram bot



1.  **Generate Access Token**:
    *   Message [@BotFather](https://t.me/BotFather) and send `/newbot`.
    *   Follow instructions to set a **Name** (display) and **Username** (must end in `bot`, e.g., `PostPilot_bot`).
    *   Copy the **API Token** provided.

2.  **Get Chat ID**: Message [@userinfobot](https://t.me/userinfobot) and send `/start` to get your numeric Chat ID.

3.  **Add to Environment**: Paste the token as `TELEGRAM_BOT_TOKEN` and the numeric Chat ID as `TELEGRAM_CHAT_ID` in your `.env` or Render variables. `TELEGRAM_CHAT_ID` is used for bot-initiated alerts (e.g. `RESOLVE_FAILED`, rate-limit warnings) that originate from the server rather than as a reply to a user message.

### 5. Configure n8n



#### Importing Workflows
1.  **Create Workflows**: In n8n, create two new empty workflows.

2.  **Import Files**:
    *   Open Workflow 1 → **Three Dots (Top Right)** → **Import from File** → Select `workflows.json`.
    *   Open Workflow 2 → **Three Dots (Top Right)** → **Import from File** → Select `workflows-error.json`.

3.  **Set Credentials**: In both workflows, open all **Telegram** nodes and click **Select Credential**. Create a new credential, paste your `TELEGRAM_BOT_TOKEN` as the Access Token, and verify it.

#### Linking the Error Handler
1.  **Setup Error Workflow**: Open the workflow you imported from `workflows-error.json`. Test it, and then click **Publish** (top right).

2.  **Link and Publish Main**:
    *   Open your main workflow (`workflows.json`).
    *   Click **Three Dots (Top Right)** → **Settings**.
    *   In the **Error Workflow** dropdown, select the error workflow you just published.
    *   **Click Publish** (top right) in the main workflow.

3.  **Why?**: This ensures the schedules and webhooks are active, and if any node fails, a detailed alert is sent to your Telegram immediately.



#### Manual Node Configuration
If you are using the provided `workflows.json`, you must perform these manual steps in the n8n UI after importing:

1.  **Timing**: In the **CRON (Generate)** node, set your preferred schedule for tweet generation.


> [!IMPORTANT]
> **Recommended**
> Set only **3 timings per day** (e.g., Morning, Afternoon, Night). 
>
> **Why?**
> With a baseline of 3 LLM calls per tweet (up to 4 if a **Diversity Re-roll** is triggered), three scheduled posts consume roughly 9–11 calls. One additional call is reserved daily for **Persona Evolution**. The remaining ~40% of your daily budget (**20 calls per day**) serves as a **Safety Buffer** for manual interactions like **Edit Topic** or **Feedback**, ensuring you never get locked out during a critical edit.

*   > **Scaling**: If you want more frequent posts, you must increase the safety gate in `src/rateGuard.ts` — see [Increasing RPM / RPD Limits](#increasing-rpm--rpd-limits) below.

*   > **API Limits**: Always check the "RPM" and "RPD" limits provided by your specific AI tier (Google AI Studio, OpenAI, etc.) before increasing these values.

### Increasing RPM / RPD Limits

Defaults match the Gemini free tier (5 RPM / 19 RPD with 1-call buffer). Bump the two constants at the top of [`src/rateGuard.ts`](src/rateGuard.ts) to match your tier:

```typescript
// src/rateGuard.ts:15-16
const RPM_LIMIT = 5;      // bump to your tier's RPM
const RPD_LIMIT = 19;     // bump to your tier's RPD (leave 1-call buffer)
```

When exhausted, the graph short-circuits at [`contentGenerator`](src/agent.ts) (skips diversity/scorer/refiner/webhook), marks the tweet `GENERATION_RATE_LIMITED`, and sends a Telegram warning instead of a junk draft. Note: the guard counts all models in one bucket; actual per-model 429s are handled by the LangChain fallback chain.


2.  **Telegram Buttons**: Pre-baked in `workflows.json` — imports as 4 rows (one button each): `🚀 Open in X`, `✏️ Edit Topic`, `💬 Feedback`, `✅ Posted`. No manual setup needed. If the Reply Markup shows empty after import, the Telegram node `typeVersion` mismatched — re-import or set **Reply Markup** to `Inline Keyboard` and re-save.

3.  **Telegram Settings**: Parse Mode pre-set to `HTML` in `workflows.json`.

4.  **Telegram Text**: Set the **Text** field to the following (Expression):
    ```html
    🚀 <b>New X Post Draft - {{ $json.body.topic }}</b>
    ---
    <b>Draft:</b>
    <pre><code>{{ $json.body.htmlDraft || $json.body.draft }}</code></pre>

    <b>Time:</b> {{ $json.body.time_of_day || 'Not set' }}
    <b>Score:</b> {{ $json.body.score || 0 }}/10
    ---
    ```

5.  **Webhook Integration**:

    *   Open the **Webhook (Tweet Ready)** node in n8n.
    *   Switch to the **Production** tab and copy the **Production URL**.
    *   In your server's environment variables (Render/`.env`), set `N8N_WEBHOOK_URL` to this copied URL.

6.  **API Credentials**:

    *   In both the **Generate Tweet** and **Process Retries** nodes (HTTP Request), locate the URL and Header fields.
    *   Replace `{{ $env.BASE_URL }}` with your actual domain (e.g., `https://you.onrender.com`).
    *   Replace `{{ $env.INTERNAL_API_KEY }}` with your `INTERNAL_API_KEY`.
    *   In the **Telegram (Notification)** node of `workflows.json` **and** the **Telegram (Error Alert)** node of `workflows-error.json`, replace `{{ $env.TELEGRAM_CHAT_ID }}` in the **Chat ID** field with your numeric chat ID from [@userinfobot](https://t.me/userinfobot).


> [!NOTE]
> Because the n8n free/desktop plan does not support global Environment Variables, you must paste these values manually into the nodes.

## 🛡️ Database Stability

PostPilot runs in **single-connection mode** (`connection_limit=1`) with **explicit sequential query loading** in `contextLoader`. The workload is ~3 generations/day with zero concurrent requests — a real pool would add state-drift bugs without any throughput benefit.

**How it works** (see [`src/db.ts`](src/db.ts), [`src/agent.ts`](src/agent.ts) `contextLoader`):

1. **Connection-string params** — `connection_limit=1`, `pool_timeout=60`, `connect_timeout=15`, `tcp_keepalives_*`. All required; see the `.env` example in [Configure environment](#2-configure-environment).
2. **Retry-once middleware** — on `P1001 / P1002 / P1008 / P1017` or `"Can't reach database" / "Server has closed" / ECONNREFUSED / ETIMEDOUT`, waits 1.5s and retries the query once. The Prisma engine reconnects transparently on the retry call — no manual `$disconnect()` (which would nuke the only connection and block every other caller).
3. **`ensureDbReady()`** — probes with one retry before `contextLoader`'s query sequence, so a cold socket reconnects on one probe rather than on the first real query.
4. **Sequential loading in `contextLoader`** — the 8 DB-touching reads run as explicit `await`s instead of `Promise.all`. On a 1-slot pool `Promise.all` is a lie (queries serialize anyway), and when one query stalls, a fake-parallel fan-out blocks every subsequent request (e.g. `/api/generate`'s `tweet.create()`) with `P2024`. Explicit sequencing bounds any single-query stall to that one query. The non-DB `getTrendingTopics()` scrape still overlaps the DB sequence — it doesn't touch the socket.

`canCallLLM()` also fails **open** on DB error so a transient blip never blocks generation.

**Wall-clock impact:** `contextLoader` runs ~400–500ms total (was ~350ms in serialized-Promise.all mode, ~80ms on a real pool). Invisible against the n8n 120s timeout.

**Log-level discipline:** middleware retries log at `WARN` (normal recovery, not an alarm). The worker's per-tick connection failures also log at `WARN`. The only `ERROR`/`CRITICAL` line is the one inside `scheduledWorkerTick` that fires after **5 consecutive** connection failures — i.e. "DB has been unreachable for ~5 minutes, something is actually wrong." That's the one line worth paging on. See [Worker & Logging](#-background-workers).

### Keeping logs quiet

Supavisor on free tier drops idle sockets after ~5 min. The middleware in `src/db.ts` reconnects transparently on the next real query, logging a single `WARN`. A prior `/health/db` keepalive endpoint was removed: during cross-region network flaps it competed with real work for the single pool slot (45s hangs), made UptimeRobot report the service DOWN during recoverable blips, and added more noise than it saved.

Worker loop ticks every **60s** (not 10s). Most ticks do nothing (no pending tasks), so 6× fewer ticks = 6× fewer chances to hit a dead socket. `RESOLVE_TWEET` already has a 10-min initial delay baked in, so 60s tick latency is invisible.

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
4. **Dashboard Release Command**: run `npm run release:grafana` when you want to apply migrations and dashboard changes without starting the web service.
5. **Environment Variables**:
   - `DATABASE_URL`: Transaction Pooler (Port 6543) + full stability params — see the `.env` example in [Configure environment](#2-configure-environment). Key value: `connection_limit=1` + `pool_timeout=60` and all five `tcp_keepalives_*` / `connect_timeout` params are required. See [Database Stability](#database-stability) for why single-connection mode.

   - `DIRECT_URL`: Session Pooler (Port 5432) for migrations; no `pgbouncer=true` query param. Username must be `postgres.PROJECT_REF`.

   - `BASE_URL`: Your Render dashboard URL (e.g., `https://<your-app-name>.onrender.com`).

   - Add all other keys listed in the [Setup](#setup) section.

> [!TIP]
> **Pro Tip**: If your n8n workflow uses the `workflows.json` export, ensure the **HTTP Request** nodes have a timeout set to **120 seconds** (120000ms). This gives Render enough time to "wake up" your service from a cold start if the keep-alive pinger hasn't triggered recently.

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
| `npm run release` | Run migrations |
| `npm run release:grafana` | Run migrations, then provision Grafana |
| `npx prisma migrate dev --name <name>` | Create and apply a new migration |
| `npx prisma generate` | Regenerate Prisma client types |

## 🛡️ Safety & Policy Compliance

PostPilot is designed as a **Stealth Agent**. Unlike traditional bots that risk account suspension through aggressive API automation, PostPilot prioritizes long-term account safety via four key strategies:

- **Human-in-the-Loop (HITL)**: AI drafts, you post. No account credentials ever handed to an automated script — you stay a regular user in X's eyes.

- **Invisible Fingerprinting**: Zero-width Unicode (`U+200B`/`U+200C`) links drafts to engagement without using the Official X API or visible tracking IDs.

- **Decoupled Scraping**: Tracking via Nitter + public Syndication API. Your account is never used to scrape, so tracking rate-limits never touch your handle.

- **Content Diversity Gate**: Dual-layer check (trigram Jaccard + FORMAT-prefixed structural fingerprint) plus LRU rotation across 8 format archetypes with hard banned-opening lists. Survives Render restarts via heuristic format-map backfill (no schema migration). Protects against shadowbans and same-shape pattern decay.

## ⚖️ Hard Constraints

- **Max 3 LLM calls** per tweet generation in the happy path (contentGenerator, qualityScorer, autoRefiner-conditional). Worst case 4 with a diversity re-roll (single extra `contentGenerator` call).

- **Max 1 LLM call/day** for persona evolution (offline, via EVOLVE_PERSONA task).

- **Google AI Studio free tier:** 5 RPM, 20 RPD (rate-guarded at 5 / 19 in `src/rateGuard.ts` with a 1-call buffer). When exhausted, the agent graph **short-circuits** at `contentGenerator` — no garbage fallback draft is shipped to Telegram; the tweet is marked `GENERATION_RATE_LIMITED` and a Telegram warning is sent instead. See [Increasing RPM / RPD Limits](#increasing-rpm--rpd-limits).

- **Data-Driven Analysis**: The analytical heavy-lifting—scoring engagement, weighting feedback, and tracking trends—is handled via pure math (zero LLM calls). This maximizes budget efficiency by reserving LLM power for the final **Persona Evolution** step, where data is synthesized into new personality traits.

- **LangGraph pipeline shape:** `contextLoader → personaAdapter → contentGenerator → diversityGate → qualityScorer → coherenceGate → [autoRefiner if score<8 OR coherence failed] → END`. Re-roll edge: `diversityGate → personaAdapter → contentGenerator` (capped at 1; new format archetype + rejected fingerprint injected into the retry prompt).


