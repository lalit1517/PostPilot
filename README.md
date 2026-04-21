# PostPilot

Autonomous content agent for X (Twitter). Generates AI drafts, tracks engagement over 72 hours, and evolves its writing style from real performance data — fully closed-loop.

## Table of Contents

- [Architecture](#architecture)
- [Self-Learning Pipeline](#self-learning-pipeline)
- [AI Agent (LangGraph)](#ai-agent-langgraph)
- [Background Workers](#background-workers)
- [API Reference](#api-reference)
- [Database Schema](#database-schema)
- [Setup](#setup)
- [Deployment](#deployment)
- [CLI Commands](#cli-commands)
- [Hard Constraints](#hard-constraints)

## Architecture

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
2. **Intelligence** — LangGraph StateGraph with 6 nodes (contextLoader, personaAdapter, contentGenerator, diversityGate, qualityScorer, autoRefiner). Gemini 2.5 Flash primary, with fallback chain.
3. **Persistence** — PostgreSQL via Prisma ORM on Supabase. RetryQueue manages async tasks (tweet resolution, engagement tracking, persona evolution).

## Self-Learning Pipeline

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
| Draft Diversity | `src/draftDiversity.ts` | 0 | Trigram Jaccard similarity against last 10 drafts. Threshold 0.85. Consumed by the `diversityGate` node — triggers one re-roll on duplicate. |
| Trends | `src/trends.ts` | 0 | Scrapes Trends24 global trends, 30-min cache, stale fallback on fetch error. Fed into `contextLoader`. |
| Analytics | `src/analytics.ts` | 0 | `getEngagementPattern()` (slot × day pivot), `getTopicPerformance()` (topic leaderboard), `getQualityOutcomeCorrelation()` (Pearson r). |
| Persona Evolver | `src/personaEvolver.ts` | 1/day | Analyzes top 10 high-tier tweets, extracts TONE/STRUCTURE/STRONG_TOPICS/AVOID/SIGNATURE_PHRASES. 22h cooldown gate. |
| Rate Guard | `src/rateGuard.ts` | 0 | Tracks calls in `LlmCallLog`. Blocks at 5 RPM or 19 RPD. `getRateStatus()` exposes current consumption. Prunes entries older than 48h. |

## AI Agent (LangGraph)

**Pipeline:** `START -> contextLoader -> personaAdapter -> contentGenerator -> diversityGate -> qualityScorer -> [autoRefiner if score < 8] -> END`

Re-roll edge: `diversityGate -> contentGenerator` (max once when duplicate detected).

| Node | LLM Call | Behavior |
| :--- | :--- | :--- |
| `contextLoader` | No | Parallel fetch: top 5 tweets by likes, weighted feedback (fallback to unweighted if < 3), active PersonaProfile, Trends24 topics filtered via `OWNER_PROFILE.trendKeywords`, `computeLengthTarget()` (avg±stdev from high-tier outcomes), `computeTopicBlacklist()` (bottom-20% topics). |
| `personaAdapter` | No | Builds `OWNER_IDENTITY` from module-level `OWNER_PROFILE` (identity, domains, moods, tones, language, experienceVoice, cities, hobbies, slangs, avoid, trendKeywords). Injects few-shot exemplars (top 3 historical tweets), hook-first rule (first 60 chars = core claim), dynamic length target, topic blacklist, tone-by-time-of-day, learned persona, trend hint, recent-topics-to-avoid, feedback guidelines, and a `VOICE ANTI-PATTERNS` guardrail that bans literary/philosophical language, metaphors, passive voice, and filler openers. |
| `contentGenerator` | Yes | Generates `TOPIC\|DRAFT`. Rate-guarded. Output passed through `finalizeDraft()`. Static fallback if rate-limited. |
| `diversityGate` | No | Runs `checkDraftDiversity()` against the last 10 drafts (trigram Jaccard ≥ 0.85). On duplicate, routes back to `contentGenerator` for one re-roll. Second duplicate accepted. |
| `qualityScorer` | Yes | Scores 1-10 via `parseScore()` with explicit voice-authenticity criteria (deducts 2 points for literary/philosophical tone). Runs `parseCritiqueHints()` to convert free-form critique into a structured hint vocabulary (`too_long`, `weak_hook`, `vague_claim`, `low_energy`, `cliche`, `too_jargon`, `weak_ending`, `poor_flow`, `needs_emotion`, `low_quality`, `wrong_voice`). Persists `quality_score` to TweetVersion. |
| `autoRefiner` | Conditional | Rewrites if score < 8. Maps `critiqueHints` to concrete rewrite directives via `HINT_DIRECTIVES` (e.g. `weak_hook` → "REWRITE THE OPENER — first 60 chars must land the core claim"). Output gated by `isSuspiciousDraft()`; rejection keeps original. Skipped at score ≥ 8. |

**Owner Identity (`OWNER_PROFILE`)**: Single module-level object in `src/agent.ts`. Edit arrays (domains, moods, tones, language, hobbies, slangs, trendKeywords, avoid, cities, experienceVoice, identity) to reshape voice — trend filter and persona prompt both rebuild automatically.

**Draft safety helpers** (pure computation, zero extra LLM calls):

- `finalizeDraft(raw)` — trims to the last full sentence when the LLM truncates mid-thought.
- `parseScore(raw)` — extracts score from free-form LLM output. Falls back to `7` (neutral) on parse failure, never `0`.
- `isSuspiciousDraft(draft)` — rejects empty, `<40` chars, `>280` chars, missing terminator, preamble leak, markdown artifacts.
- `parseCritiqueHints(critique, draft, score)` — maps free-form critique → fixed hint vocabulary for `autoRefiner`.
- `computeLengthTarget()` — derives `{min, max}` length window from last 20 high-tier `TweetOutcome` rows (avg±stdev). Returns `null` if <5 samples.
- `computeTopicBlacklist()` — bottom-20% topics from `getTopicPerformance(50)`. Returns `[]` if <10 topic samples.

**Models:** `gemini-2.5-flash` (primary, `thinkingBudget: 1024`) -> `gemini-3.1-flash-lite-preview` -> `gemini-3-flash-preview` -> `gemini-2.5-flash-lite` (fallbacks)

**Config:** Temperature 0.7, max 2048 output tokens, topP 0.9, 2-minute timeout per call.

## Background Workers

The `RetryQueue` table manages three async task types processed every 10 seconds.

### Telegram Buttons — What Each Does

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

Tapping it immediately sets `posted=true`, `status=POSTED_CONFIRMED`, enqueues `RESOLVE_TWEET`, and **mutates the button label to "✅ Marked as Posted"** in the same Telegram message. If `RESOLVE_TWEET` still finds nothing after all retries, the tweet is reverted to `RESOLVE_FAILED` (not treated as posted).

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

### EVOLVE_PERSONA

Calls `evolvePersona()` — 1 LLM call with 22-hour cooldown. Deactivates previous profiles, creates new active `PersonaProfile`.

### Scheduled: Feedback Reweight

`reweightFeedback()` runs independently every 6 hours via in-memory timestamp gate in the worker loop.

## API Reference

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

## Database Schema

8 models on PostgreSQL (Supabase), managed by Prisma ORM.

| Model | Purpose |
| :--- | :--- |
| `Tweet` | Master record — topic, status (`PENDING`, `GENERATING`, `APPROVED`, `POSTED_CONFIRMED`, `RESOLVE_FAILED`, `ERROR`), fingerprint, live_url, posted_at |
| `TweetVersion` | Versioned drafts with `quality_score` (set by qualityScorer) |
| `Feedback` | User feedback with `weighted_score` (computed by feedbackWeighter) |
| `Engagement` | Time-series snapshots — likes, retweets, impressions at each interval |
| `TweetOutcome` | Normalized 0-100 outcome score, tier (high/medium/low), peak metrics, `topic`, `time_of_day`, `day_of_week`. One per tweet, computed at 72h. Indexed on tier/time/day. |
| `PersonaProfile` | Versioned persona documents with auto-increment version and `is_active` flag |
| `LlmCallLog` | Rate limiting ledger with `called_at` index, pruned to 48h window |
| `RetryQueue` | Task queue — RESOLVE_TWEET, FETCH_ENGAGEMENT, EVOLVE_PERSONA |

## Setup

### Prerequisites

- Node.js 20+
- PostgreSQL database (Supabase recommended)
- Google AI Studio API key
- Telegram bot (for notifications)
- n8n instance (for scheduling)

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Create `.env` in the project root:

```env
DATABASE_URL=postgresql://...          # Supabase transaction pooler connection string
GOOGLE_API_KEY=...                     # Google AI Studio API key
X_USERNAME=your_handle                 # X handle for tweet resolution scraping
BASE_URL=https://your-domain.com       # Deployment root URL
HMAC_SECRET=...                        # 64-char hex for URL signing (see below)
TELEGRAM_BOT_TOKEN=...                 # From @BotFather
PORT=3000                              # Express server port
```

Generate `HMAC_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3. Set up the database

```bash
npx prisma migrate deploy
npx prisma generate
```

### 4. Set up Telegram bot

1. Message [@BotFather](https://t.me/BotFather) — send `/newbot` to create a bot and get `TELEGRAM_BOT_TOKEN`.
2. Message [@userinfobot](https://t.me/userinfobot) — send `/start` to get your chat ID for n8n.

## Deployment

PostPilot requires two processes: the API server and the background worker.

### Railway (Recommended)

**Option A: Two services** (recommended)

1. Create two services from the same repo.
2. Service 1 (API): start command `npm start`
3. Service 2 (Worker): start command `npm run worker`

**Option B: Single service**

```bash
npm install concurrently
```

Update `package.json`:

```json
"start": "concurrently \"npm start\" \"npm run worker\""
```

## CLI Commands

| Command | Description |
| :--- | :--- |
| `npm run dev` | Start API server in watch mode (nodemon) |
| `npm start` | Start API server (production) |
| `npm run worker` | Start background task processor |
| `npx prisma migrate deploy` | Apply pending migrations to database |
| `npx prisma migrate dev --name <name>` | Create and apply a new migration |
| `npx prisma generate` | Regenerate Prisma client types |

## Hard Constraints

- **Max 3 LLM calls** per tweet generation in the happy path (contentGenerator, qualityScorer, autoRefiner-conditional). Worst case 4 with a diversity re-roll (single extra `contentGenerator` call).
- **Max 1 LLM call/day** for persona evolution (offline, via EVOLVE_PERSONA task).
- **Google AI Studio free tier:** 5 RPM, 20 RPD — all calls rate-guarded via `src/rateGuard.ts`.
- **All self-learning logic is pure computation** — outcomeScorer, feedbackWeighter, analytics, diversity, length-target, and topic-blacklist math use zero LLM calls.
- **LangGraph pipeline shape:** `contextLoader → personaAdapter → contentGenerator → diversityGate → qualityScorer → [autoRefiner] → END`. Re-roll edge: `diversityGate → contentGenerator` (capped at 1).

## Tech Stack

| Layer | Technology |
| :--- | :--- |
| Runtime | Node.js 20+ / TypeScript |
| Framework | Express 5 |
| AI Engine | LangGraph + Google Gemini (via @langchain/google-genai) |
| Database | PostgreSQL via Prisma ORM (Supabase) |
| Scheduling | n8n |
| Notifications | Telegram Bot API |
| Logging | Pino |
