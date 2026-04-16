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
2. **Intelligence** — LangGraph StateGraph with 5 nodes (contextLoader, personaAdapter, contentGenerator, qualityScorer, autoRefiner). Gemini 2.5 Flash primary, with fallback chain.
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
| Outcome Scorer | `src/outcomeScorer.ts` | 0 | Normalizes peak engagement (0-100) using min-max scaling against 30-day window. Tiers: top 20% = high, bottom 30% = low. |
| Feedback Weighter | `src/feedbackWeighter.ts` | 0 | Weights user feedback by nearby tweet outcomes (+-3 day window) with recency decay: `1 / (1 + days_since)`. |
| Persona Evolver | `src/personaEvolver.ts` | 1/day | Analyzes top 10 high-tier tweets, extracts TONE/STRUCTURE/STRONG_TOPICS/AVOID/SIGNATURE_PHRASES. 22h cooldown gate. |
| Rate Guard | `src/rateGuard.ts` | 0 | Tracks calls in `LlmCallLog`. Blocks at 5 RPM or 19 RPD. Prunes entries older than 48h. |

## AI Agent (LangGraph)

**Pipeline:** `START -> contextLoader -> personaAdapter -> contentGenerator -> qualityScorer -> [autoRefiner if score < 8] -> END`

| Node | LLM Call | Behavior |
| :--- | :--- | :--- |
| `contextLoader` | No | Fetches top 5 tweets by likes, weighted feedback (fallback to unweighted if < 3), active PersonaProfile. All queries parallel. |
| `personaAdapter` | No | Sets tone by time of day (insightful/punchy/reflective). Prepends learned persona profile when available. |
| `contentGenerator` | Yes | Generates `TOPIC\|DRAFT`. Rate-guarded. Falls back to static draft if rate-limited. |
| `qualityScorer` | Yes | Scores 1-10 for clarity/engagement. Persists `quality_score` to TweetVersion. |
| `autoRefiner` | Conditional | Rewrites draft if score < 8. Skipped entirely if score >= 8 (saves 1 LLM call). |

**Models:** `gemini-2.5-flash` (primary) -> `gemini-3-flash-preview` -> `gemini-3.1-flash-lite-preview` (fallbacks)

**Config:** Temperature 0.7, max 500 output tokens, topP 0.9, 2-minute timeout per call.

## Background Workers

The `RetryQueue` table manages three async task types processed every 10 seconds.

### RESOLVE_TWEET

Detects posted tweets via invisible fingerprint matching.

1. Triggered 10 minutes after user confirms posting (via Telegram button or intent link redirect).
2. Polls Nitter RSS and Twitter timeline with browser-like headers.
3. Matches the 8-char hex fingerprint embedded as invisible Unicode (`U+200B`/`U+200C`).
4. On match: marks tweet as `POSTED_CONFIRMED`, schedules first engagement fetch.
5. On miss: one delayed retry at ~45 minutes, then marks `ERROR`.

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

**Security:** Edit/feedback URLs are signed with HMAC-SHA256 (8-char prefix). Verified via timing-safe comparison.

## Database Schema

8 models on PostgreSQL (Supabase), managed by Prisma ORM.

| Model | Purpose |
| :--- | :--- |
| `Tweet` | Master record — topic, status, fingerprint, live_url, posted_at |
| `TweetVersion` | Versioned drafts with `quality_score` (set by qualityScorer) |
| `Feedback` | User feedback with `weighted_score` (computed by feedbackWeighter) |
| `Engagement` | Time-series snapshots — likes, retweets, impressions at each interval |
| `TweetOutcome` | Normalized 0-100 outcome score, tier (high/medium/low), peak metrics. One per tweet, computed at 72h. |
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

- **Max 3 LLM calls** per tweet generation (contentGenerator, qualityScorer, autoRefiner-conditional).
- **Max 1 LLM call/day** for persona evolution (offline, via EVOLVE_PERSONA task).
- **Google AI Studio free tier:** 5 RPM, 20 RPD — all calls rate-guarded via `src/rateGuard.ts`.
- **All self-learning logic is pure computation** — outcomeScorer, feedbackWeighter, and scoring math use zero LLM calls.
- **LangGraph node structure is fixed** — nodes and edges in the graph must not be rewritten.

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
| Validation | Zod |
