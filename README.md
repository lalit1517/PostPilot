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
- [Setup](#setup)
  - [Prerequisites](#prerequisites)
  - [1. Install dependencies](#1-install-dependencies)
  - [2. Configure environment](#2-configure-environment)
  - [3. Set up the database](#3-set-up-the-database)
  - [4. Set up Telegram bot](#4-set-up-telegram-bot)
  - [5. Configure n8n](#5-configure-n8n)
- [Safety & Policy Compliance](#safety--policy-compliance)
- [Hard Constraints](#hard-constraints)
- [Analytics (Grafana)](#analytics-grafana)

## 💡 Core Innovations


- **Invisible Fingerprinting**: Programmatic tweet-resolution using zero-width Unicode characters. This "watermarks" every draft, allowing the background worker to link live tweets to specific LLM versions without requiring the expensive official X API. 🔒

- **LangGraph Orchestration**: Built on a Directed Acyclic Graph (DAG) rather than a simple prompt. Features a **Diversity Gate** to prevent content repetition and a **Conditional Auto-Refiner** that triggers only when quality scores are low.

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

2. **Intelligence** — LangGraph StateGraph with 6 nodes (contextLoader, personaAdapter, contentGenerator, diversityGate, qualityScorer, autoRefiner). Gemini 2.5 Flash primary, with fallback chain.

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
| Draft Diversity | `src/draftDiversity.ts` | 0 | Trigram Jaccard similarity against last 10 drafts. Threshold 0.85. Consumed by the `diversityGate` node — triggers one re-roll on duplicate. |
| Trends | `src/trends.ts` | 0 | Scrapes Trends24 global trends, 30-min cache, stale fallback on fetch error. Fed into `contextLoader`. |
| Analytics | `src/analytics.ts` | 0 | `getEngagementPattern()` (slot × day pivot), `getTopicPerformance()` (topic leaderboard), `getQualityOutcomeCorrelation()` (Pearson r). |
| Persona Evolver | `src/personaEvolver.ts` | 1/day | Analyzes top 10 high-tier tweets, extracts TONE/STRUCTURE/STRONG_TOPICS/AVOID/SIGNATURE_PHRASES. 22h cooldown gate. |
| Rate Guard | `src/rateGuard.ts` | 0 | Tracks calls in `LlmCallLog`. Blocks at 5 RPM or 19 RPD. `getRateStatus()` exposes current consumption. Prunes entries older than 48h. |


## 🧠 AI Agent (LangGraph)

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
| `Tweet` | Master record — topic, status (`PENDING`, `GENERATING`, `APPROVED`, `POSTED_CONFIRMED`, `RESOLVE_FAILED`, `ERROR`), fingerprint, live_url, posted_at |
| `TweetVersion` | Versioned drafts with `quality_score` (set by qualityScorer) |
| `Feedback` | User feedback with `weighted_score` (computed by feedbackWeighter) |
| `Engagement` | Time-series snapshots — likes, retweets, impressions at each interval |
| `TweetOutcome` | Normalized 0-100 outcome score, tier (high/medium/low), peak metrics, `topic`, `time_of_day`, `day_of_week`. One per tweet, computed at 72h. Indexed on tier/time/day. |
| `PersonaProfile` | Versioned persona documents with auto-increment version and `is_active` flag |
| `LlmCallLog` | Rate limiting ledger with `called_at` index, pruned to 48h window |
| `RetryQueue` | Task queue — RESOLVE_TWEET, FETCH_ENGAGEMENT, EVOLVE_PERSONA |




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



Create `.env` in the project root:

```env
DATABASE_URL=postgresql://postgres.[ref]:[PASSWORD]@aws-1-ap-south-1.pooler.supabase.com:6543/postgres?pgbouncer=true
                                       # Supabase transaction pooler (port 6543) + pgbouncer=true for Prisma compatibility
DIRECT_URL=postgresql://postgres.[ref]:[PASSWORD]@aws-1-ap-south-1.pooler.supabase.com:5432/postgres
                                       # Supabase direct connection (port 5432) — required for Prisma migrations
GOOGLE_API_KEY=...                     # Get from https://aistudio.google.com/app/apikey
                                       # Choose models (Gemini 1.5/2.0/Flash) based on their specific RPM/RPD limits.
X_USERNAME=your_handle                 # X handle for tweet resolution scraping
BASE_URL=https://your-domain.com       # Deployment root URL
HMAC_SECRET=...                        # 64-char hex for URL signing (see below)
TELEGRAM_BOT_TOKEN=...                 # From @BotFather
TELEGRAM_CHAT_ID=...                   # Your Telegram chat ID (get from @userinfobot)
TELEGRAM_WEBHOOK_SECRET=...            # Secret token for Telegram webhook verification (see below)
N8N_WEBHOOK_URL=https://...            # n8n webhook URL for draft-ready callbacks
INTERNAL_API_KEY=...                   # API key protecting admin + generate endpoints (see below)
PORT=3000                              # Express server port

GRAFANA_URL=https://yourorg.grafana.net  # Grafana Cloud stack URL (for dashboard provisioning)

GRAFANA_API_KEY=...                    # Grafana service account token with Admin role (see grafana/README.md)

GRAFANA_DATABASE_URL=postgresql://postgres.[ref]:[PASSWORD]@aws-1-ap-south-1.pooler.supabase.com:5432/postgres
                                       # Supabase session pooler (port 5432) for Grafana — stable for long-running analytical queries
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

`TELEGRAM_WEBHOOK_SECRET` must be passed as `secret_token` when registering your webhook with Telegram:

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=<BASE_URL>/api/telegram/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

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

3.  **Add to Environment**: Paste the token as `TELEGRAM_BOT_TOKEN` in your `.env` or Render variables.

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

*   > **Scaling**: If you want more frequent posts, you must increase the safety gate in `src/rateGuard.ts` (look for `rpdCount >= 19`).

*   > **API Limits**: Always check the "RPM" and "RPD" limits provided by your specific AI tier (Google AI Studio, OpenAI, etc.) before increasing these values.


2.  **Telegram Buttons**: In the **Telegram** node, add the following 4 buttons under the **Reply Markup** section:


    *   `🚀 Open in X` — URL: `{{ $json.body.intentUrl }}` (Expression)


    *   `✏️ Edit Topic` — URL: `{{ $json.body.editUrl }}` (Expression)

    *   `💬 Feedback` — URL: `{{ $json.body.feedbackUrl }}` (Expression)

    *   `✅ Posted` — Callback Data: `{{ "pc:" + $json.body.tweet_id + ":" + $json.body.token.substring(0,8) }}` (Expression)

3.  **Telegram Settings**: In the same node, set **Reply Markup** to `Inline Keyboard` and **Parse Mode** to `HTML`.

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


> [!NOTE]
> Because the n8n free/desktop plan does not support global Environment Variables, you must paste these values manually into the nodes.

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
3. **Start Command**: `npm start` (automatically runs migrations, provisions Grafana, and starts the server + worker).
4. **Environment Variables**:
   - `DATABASE_URL`: Transaction Pooler (Port 6543) + `?pgbouncer=true&connection_limit=20&pool_timeout=20`.

   - `DIRECT_URL`: Direct Connection (Port 5432) — **Required** for migrations.

   - `BASE_URL`: Your Render dashboard URL (e.g., `https://<your-app-name>.onrender.com`).

   - Add all other keys listed in the [Setup](#setup) section.

> [!TIP]
> **Pro Tip**: If your n8n workflow uses the `workflows.json` export, ensure the **HTTP Request** nodes have a timeout set to **120 seconds** (120000ms). This gives Render enough time to "wake up" your service from a cold start if the keep-alive pinger hasn't triggered recently.

### 24/7 Keep-Alive (UptimeRobot)



Render's free tier sleeps after 15 minutes of inactivity. To keep PostPilot running 24/7 without "cold starts," we recommend using **[UptimeRobot](https://uptimerobot.com/)** (Free).

1. Create a free account at [UptimeRobot.com](https://uptimerobot.com/).
2. Click **+ Add New Monitor**.
3. **Monitor Type**: `HTTP(s)`
4. **Friendly Name**: `PostPilot-Live`
5. **URL**: `https://<your-app-name>.onrender.com`
6. **Monitoring Interval**: Every `5 minutes`.
7. Click **Create Monitor**.

This ensures your database connection pool stays active and your background workers never pause.

### Railway (Alternative)



If you prefer Railway, you can deploy as a single service using `npm start` or as two separate services using `npm start` (API) and `npm run worker` (Worker). Ensure you set both `DATABASE_URL` and `DIRECT_URL`.

## 💻 CLI Commands

| Command | Description |
| :--- | :--- |
| `npm run dev` | Start API server in watch mode (nodemon) |
| `npm start` | Start API server (production) |
| `npm run worker` | Start background task processor |
| `npx prisma migrate deploy` | Apply pending migrations to database |
| `npx prisma migrate dev --name <name>` | Create and apply a new migration |
| `npx prisma generate` | Regenerate Prisma client types |

## 🛡️ Safety & Policy Compliance

PostPilot is designed as a **Stealth Agent**. Unlike traditional bots that risk account suspension through aggressive API automation, PostPilot prioritizes long-term account safety via four key strategies:

- **Human-in-the-Loop (HITL)**: By separating *intelligence* (AI drafting) from *action* (manual posting), you remain a "regular user" in the eyes of X. You never hand over your account credentials to an automated script for posting.

- **Invisible Fingerprinting**: We use zero-width Unicode characters (`U+200B`/`U+200C`) to link drafts to real-world engagement. This allows the system to learn from performance without using the Official X API and without cluttering your tweets with visible tracking IDs.

- **Decoupled Scraping**: Tracking is performed via **Nitter** (external proxies) and the public **Syndication API**. Your account is never used for data scraping, ensuring that if a tracking endpoint is rate-limited, your X handle remains unaffected.

- **Content Diversity Gate**: The integrated Jaccard similarity check ensures that you never accidentally post repetitive or "spammy" content, protecting your account from shadowbans and reputation decay.

## ⚖️ Hard Constraints

- **Max 3 LLM calls** per tweet generation in the happy path (contentGenerator, qualityScorer, autoRefiner-conditional). Worst case 4 with a diversity re-roll (single extra `contentGenerator` call).

- **Max 1 LLM call/day** for persona evolution (offline, via EVOLVE_PERSONA task).

- **Google AI Studio free tier:** 5 RPM, 20 RPD — all calls rate-guarded via `src/rateGuard.ts`.

- **Data-Driven Analysis**: The analytical heavy-lifting—scoring engagement, weighting feedback, and tracking trends—is handled via pure math (zero LLM calls). This maximizes budget efficiency by reserving LLM power for the final **Persona Evolution** step, where data is synthesized into new personality traits.

- **LangGraph pipeline shape:** `contextLoader → personaAdapter → contentGenerator → diversityGate → qualityScorer → [autoRefiner] → END`. Re-roll edge: `diversityGate → contentGenerator` (capped at 1).


