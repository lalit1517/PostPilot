# 🚀 PostPilot

PostPilot is a professional-grade autonomous AI agent for X (Twitter).
LangGraph manages drafting, invisible fingerprinting, 72-hour engagement tracking, and persona evolution.
Telegram provides the Human-in-the-Loop (HITL) safety gate, so every post still needs human approval before publication.

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
  - [Owner profile builder prompt](#owner-profile-builder-prompt)
  - [How topics are selected](#how-topics-are-selected)
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
- [Contributing](#contributing)

<a id="core-innovations"></a>

## 💡 Core Innovations


- **Layered Tweet Resolution**: Links live tweets to draft versions with zero-width fingerprints, tolerant truncated-fingerprint matching, and same-author visible-text fallback. No official X API is required. 🔒

- **LangGraph Orchestration**: Uses a real DAG instead of one prompt, combining topic planning, diversity, format rotation, coherence, trend relevance, grounding, prohibitions, and refinement.

- **Autonomous Persona Evolution**: A closed-loop learner. Every 22 hours, it studies recent high-tier tweets, extracts useful style patterns, and updates the active persona prompt. 🧪

- **Free-Tier Monolith Architecture**: Built for constrained hosting. The Express API and multi-task background worker run in one Render-friendly process.

- **Scientific Quality Analysis**: Tracks Pearson correlation between LLM quality scores and real engagement, so scoring can be calibrated from outcome data. 📈


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
  Supabase DB       Public Data     Engagement
  (PostgreSQL)      Ingestion      Tracker
```


**Three layers:**

1. **Orchestration** — Cloudflare Worker Cron triggers `/api/cron/generate` at 09:00, 13:30, and 22:00 IST. PostPilot sends Telegram draft notifications directly with inline buttons (post, edit, feedback).

2. **Intelligence** — LangGraph StateGraph with 9 nodes (contextLoader, personaAdapter, contentGenerator, diversityGate, qualityScorer, coherenceGate, autoRefiner, postRefinerGate, finalTopicMemory). Gemini 2.5 Flash primary, with fallback chain.

3. **Persistence** — PostgreSQL via Prisma ORM on Supabase. RetryQueue manages async tasks (tweet resolution, engagement tracking, persona evolution) using due-task scheduling instead of fixed idle polling.


<a id="self-learning-pipeline"></a>

## 🔄 Self-Learning Pipeline

PostPilot improves its own writing over time without manual tuning.

```
Generation (2-3 LLM calls typical)
  -> contextLoader pulls slot-aware exemplars (top tweets at THIS time-of-day)
  -> qualityScorer returns quality_score (1.0-10.0, 1 dp); server persists it to the new TweetVersion
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
| Outcome Scorer | `src/outcomeScorer.ts` | 0 | Computes 0-100 outcome scores from peak likes, retweets, and replies using log-scaled 30-day min-max normalization. Persists topic/time metadata and assigns high/medium/low tiers. |
| Feedback Weighter | `src/feedbackWeighter.ts` | 0 | Converts raw feedback into weighted guidance using nearby outcomes, recency decay, and sentiment multiplier. |
| Feedback Sentiment | `src/feedbackSentiment.ts` | 0 | Regex classifier for `positive`, `negative`, `stylistic`, and `neutral` feedback with fixed multipliers. |
| Draft Diversity | `src/draftDiversity.ts` | 0 | Rejects near-duplicates with trigram similarity plus recent structural fingerprints; keeps FORMAT-prefixed history via in-memory map and boot backfill. |
| Draft Formats | `src/draftFormats.ts` | 0 | Defines 8 deterministic writing archetypes with opening templates, banned openings, examples, and LRU rotation metadata. |
| Topic Planner | `src/topicPlanner.ts` | 0 | Profile-first router that enforces tech/culture mix, chooses a bucket, avoids recent/blacklisted topics, and returns the structured topic plan used in prompts/logs. |
| Trend Relevance | `src/trendRelevance.ts` | 0 | Classifies Trends24 candidates: allows profile-matched tech/culture trends, rejects banned lanes, and records rejection reasons. |
| Topic Coherence | `src/topicCoherence.ts` | 0 | Pure string gate for topic overlap or allowed domain pivot; explicit user topics disable pivot and require direct overlap. |
| Topic Memory | `src/topicMemory.ts` | 0 | In-memory 48h cooldown plus coherence-failure counter; explicit user topics are never silently substituted, and final topics are recorded after any accepted path. |
| Trends | `src/trends.ts` | 0 | Fetches/caches Trends24 for 30 minutes, falls back safely, and logs CRITICAL after repeated zero parses. |
| Analytics | `src/analytics.ts` | 0 | Exposes slot/day engagement patterns, topic performance, and quality-vs-outcome correlation. |
| Persona Evolver | `src/personaEvolver.ts` | 1/day | Evolves the learned persona from recent high-tier tweets, including structure-diversity flags and drift warnings; 22h cooldown. |
| Rate Guard | `src/rateGuard.ts` | 0 | Tracks LLM calls, enforces 5 RPM / 19 RPD app-side limits, returns `nextAvailableAt`, exposes status, and prunes old logs. |


<a id="ai-agent-langgraph"></a>

## 🧠 AI Agent (LangGraph)

**Pipeline:** `START -> contextLoader -> personaAdapter -> contentGenerator -> diversityGate -> qualityScorer -> coherenceGate -> [autoRefiner -> postRefinerGate if needed] -> finalTopicMemory -> END`

**Re-roll edge:** `diversityGate -> personaAdapter` is capped at one retry.
A rejected draft gets a new format, and its rejected fingerprint/text are saved to state.
The retry prompt names the exact structure to avoid.
Accepted drafts clear `rejectedFingerprint` and move to `qualityScorer`, so the graph cannot loop into the 5 RPM guard.

**Rate-limit short-circuit edge:** when `rateLimited === true`, `contentGenerator -> END`.
The graph skips later gates, fingerprinting, and draft notification.
The tweet becomes `GENERATION_RATE_LIMITED`, and Telegram receives a warning.

**Provider-failure short-circuit edge:** when `generationFailed === true`, `contentGenerator -> END`.
Gemini/provider failures mark the tweet `ERROR` and send a Telegram warning; no fallback draft is scored, fingerprinted, persisted, or sent.

| Node | LLM Call | Behavior |
| :--- | :--- | :--- |
| `contextLoader` | No | Loads exemplars, weighted feedback, persona, length/blacklist data, recent fingerprints/topics, and classified trends. Builds a structured topic plan; automatic topics respect cooldown while explicit user topics set `forceTopic`. |
| `personaAdapter` | No | Builds the full prompt: prohibitions, format directive, owner identity, persona/examples, topic plan, visible post budget, blacklist, tone, feedback rules, and anti-patterns. |
| `contentGenerator` | Yes | Generates `TOPIC\|DRAFT`, optionally uses Google Search for current/named topics, applies revision/re-roll instructions, finalizes text, registers format, and short-circuits on rate limit. |
| `diversityGate` | No | Enforces trigram + structural diversity against recent drafts. On first duplicate, changes format and re-routes through `personaAdapter`; accepted drafts clear reject state and update fingerprint memory. |
| `qualityScorer` | Yes | Scores 1.0-10.0 with one decimal, applies structural and revision penalties, parses fixed critique hints, and returns the score for `server.ts` to persist. Accepted refined drafts keep this pre-refine score and label it in the critique instead of spending another scorer call. |
| `coherenceGate` | No | Checks feedback compliance and topic coherence without LLM. User-supplied topics require direct overlap; failures lower high scores and add `topic_drift` / `feedback_drift` for refinement. |
| `autoRefiner` | Conditional | Rewrites when score is low, coherence/revision fails, or draft is too long. Reuses prompt constraints; suspicious rewrites are rejected, and fitted drafts are revalidated before topic memory. |
| `postRefinerGate` | No | Re-runs revision and topic checks on refined drafts. Valid drafts continue; one failed validation can retry refinement, then fails closed. |
| `finalTopicMemory` | No | Records the accepted final topic into the 48h cooldown after the direct path or a validated refined path. |


**Owner Identity (`OWNER_PROFILE`)**: [`src/config/ownerProfile.ts`](src/config/ownerProfile.ts) is the runtime contract.
The repo ships a public-safe [`ownerProfile.example.json`](ownerProfile.example.json).
Runtime prefers `ownerProfile.private.json`, then falls back to the example.
Upload the private file to Render as a Secret File so personal persona data stays out of Git.

**Draft safety helpers** (pure computation, zero extra LLM calls):

- `finalizeDraft(raw)` — trims to the last full sentence when the LLM truncates mid-thought.

- `parseScore(raw)` — extracts score from free-form LLM output. Falls back to `7` (neutral) on parse failure, never `0`.

- `isSuspiciousDraft(draft)` — rejects empty, `<40` chars, drafts over the configured visible X post budget, missing terminator, preamble leak, markdown artifacts.

- `parseCritiqueHints(critique, draft, score)` — maps free-form critique → fixed hint vocabulary for `autoRefiner`.

- `computeLengthTarget()` — derives `{min, max}` length window from last 20 high-tier `TweetOutcome` rows (avg±stdev). Returns `null` if <5 samples.

- `computeTopicBlacklist()` — merges DB bottom-20% topics with the in-memory cooldown list from `topicMemory.ts`. On DB failure, returns memory-only instead of `[]`. Logs `blacklistSource`.

- `extractAvoidItems(profileText)` — parses `OVERUSED_STRUCTURE:` / `OVERUSED_ARC:` / `OVERUSED_PHRASE:` from the persona AVOID section into structured hard prohibitions.

- `extractStructuralFingerprint(text)` — topic-agnostic shape fingerprint (`OPEN:<kind>|CONTRAST|LESSON|SELF_DEPRECATE|PUNCHLINE_END`). Structural regex only, no hardcoded topics.

- `getNextFormatWithMeta(recentFingerprints)` — pure, deterministic LRU archetype selector over 8 archetypes. Returns `{ selected, unusedCount, consideredRecentFormats }` so rotation is loggable.

- Fingerprint helpers keep recent FORMAT-prefixed shape history in memory. Boot backfill scans recent `TweetVersion` rows and guesses formats after Render restarts.

- `checkTopicCoherence(draft, topic, { allowDomainPivot })` — pure-string coherence. It passes on topic keyword overlap, or on-domain pivot when allowed. Explicit user topics disable the pivot.

- Topic memory helpers enforce a 48h cooldown plus a 3-strike coherence counter. Automatic topics respect cooldown. Explicit user topics set `forceTopic`. Final topics are recorded after direct and refined paths.

- `planTopic(input)` — profile-first planner. It enforces the tech/culture mix, chooses a weighted bucket, and returns the structured topic plan used by prompts and logs.

- `classifyTrends(trends)` / `filterRelevantTrends(trends)` — trend classification. `classifyTrends()` is the current structured API; `filterRelevantTrends()` remains as a compatibility wrapper.

**Models:** `gemini-2.5-flash` (primary, `thinkingBudget: 1024`) -> `gemini-3.1-flash-lite-preview` -> `gemini-3-flash-preview` -> `gemini-2.5-flash-lite` (fallbacks)

**Config:** Temperature 0.7, max 2048 output tokens, topP 0.9, 2-minute timeout per call.


<a id="background-workers"></a>

## 👷 Background Workers

The `RetryQueue` table manages three async task types.
The worker sleeps until the earliest pending `process_after` instead of polling on a fixed loop.
If the queue is empty, it reconciles every 15 minutes.
New `enqueueRetry()` tasks wake it immediately.

### 🔘 Telegram Buttons — What Each Does

When a draft arrives in Telegram, you get four buttons. Here's exactly what each one does:


**🚀 Open in X** — the primary posting path. Tapping it:

1. Hits `/api/post-intent` on the server (logs the click, idempotently enqueues `RESOLVE_TWEET` with a 10-min delay; repeated clicks reuse the existing pending resolver task)

2. Redirects your browser to X's compose box, pre-filled with the draft + invisible fingerprint

3. You post it manually on X

4. 10 minutes later, `RESOLVE_TWEET` runs. On success, it marks the tweet `POSTED_CONFIRMED`, edits Telegram to `Status: ✅ Marked as Posted`, removes buttons, and starts engagement tracking.

PostPilot stores `chat_id` + `message_id` when the draft is sent. URL buttons do not send callback metadata, so this stored reference lets the worker update the original Telegram message later.


**✅ Posted** — manual override only. Use this when:

- You destroyed the fingerprint (edited the tweet end on X before posting)

- Nitter and Twitter timeline both failed to find the tweet

- You posted but the auto-detection silently failed

Tapping it immediately sets `posted=true`, `status=POSTED_CONFIRMED`, idempotently enqueues `RESOLVE_TWEET`, persists the Telegram `chat_id` + `message_id` on the Tweet row, edits the Telegram message text to show `Status: ☑️ Post Confirmed - resolver running`, and removes the **Posted** callback row while keeping **Open in X**, **Edit Topic**, and **Feedback** visible. Repeated clicks reuse the existing pending resolver task. This is an optimistic user confirmation, not final resolver proof.

If `RESOLVE_TWEET` still finds nothing after all retries (~62 min total: 10 min initial delay + ~7 min short retry + ~45 min final retry), the worker:

1. Marks the tweet `RESOLVE_FAILED` and resets `posted=false`, `posted_at=null`.
2. Edits the original Telegram message via `editMessageText`, showing `Status: ↩️ Not Posted` and removing the keyboard so no final-state callback can be tapped.

If the resolver finds the tweet, it shows `Status: ✅ Marked as Posted` and removes callback buttons.
Telegram `callback_data` buttons always POST when tapped, so final status lives in message text rather than fake disabled buttons.

> The worker resolution guard skips on `live_url` set or `status === 'RESOLVE_FAILED'`, not on `posted=true`.
> Manual confirmation sets `posted=true` optimistically; gating on it would drop every manual-confirm task before polling.

This covers two common cases: you clicked ✅ Posted but never posted, or the tweet disappeared before confirmation. Telegram self-corrects after resolver success or final failure.

> **You almost never need the Posted button.** Open in X handles everything automatically through the layered resolver. Posted is the escape hatch for when you want to optimistically confirm that you posted.


**✏️ Edit Topic / 💬 Feedback** — open secure HMAC-signed web forms. Submit triggers a full regeneration with the new topic or feedback injected into the pipeline.


There is no final Telegram "undo" action after resolver success or failure. Corrections should be handled in the database or by generating a new draft.

### RESOLVE_TWEET



Detects posted tweets via a layered resolver: exact invisible fingerprint match first, tolerant truncated-fingerprint match second, and visible-text fallback last.

1. Triggered 10 minutes after the signed X intent redirect or manual Posted confirmation.

2. Queries rotating public sources from `NITTER_INSTANCES` or the built-in default list. Then it falls back to the native Twitter timeline with browser-like headers. Failed/rate-limited hosts cool down for 30 minutes.

3. Primary match: looks for the exact 8-char hex fingerprint embedded as invisible Unicode (`U+200B`/`U+200C`). Fingerprint generation pre-checks the DB to avoid `@unique` collisions.

4. Secondary match: accepts a 28-31 zero-width run only when it decodes to a strong fingerprint prefix and nearby visible text matches the draft. This handles clients that trim a trailing zero-width character.

5. Fallback match: compares recent same-author candidates against normalized `TweetVersion.content`. If `created_at` is missing, the worker derives time from the X snowflake ID.

6. On match: marks tweet as `POSTED_CONFIRMED`, updates the Telegram message text to `Status: ✅ Marked as Posted`, removes callback buttons, and schedules the first engagement fetch.

7. On miss: schedules a short retry at ~7 minutes, then a final retry at ~45 minutes. If all attempts miss, it sets `RESOLVE_FAILED`, resets posted fields, edits Telegram, and removes buttons.

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

*   **Important**: If attempts go beyond 6, also update the `maxRetries` passed to `enqueueRetry` for `FETCH_ENGAGEMENT` (currently `6`). Otherwise the database can mark the task failed before the cycle finishes.

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
| `TweetVersion` | Versioned drafts with `quality_score` (returned by qualityScorer and persisted by server when the version is created; accepted refined drafts label pre-refine scores in `critique`) |
| `Feedback` | User feedback with `weighted_score` (computed by feedbackWeighter) |
| `Engagement` | Time-series snapshots — `likes`, `retweets`, `replies` at each interval. **`impressions` is always 0** — Twitter's free/public syndication endpoint doesn't expose impression counts. Column is unused today; kept as a future hook for when an X API key (paid Basic tier) is wired in, since that endpoint does return impressions. Surfaced via `/api/analytics` timeline as passthrough only — no consumer reads a non-zero value. |
| `TweetOutcome` | Normalized 0-100 outcome score, tier (high/medium/low), peak metrics (`peak_likes`, `peak_retweets`, `peak_replies`), `quality_score` copy, `topic`, `time_of_day`, `day_of_week`. One per tweet, computed at 72h. Indexed on tier/time/day. |
| `PersonaProfile` | Versioned persona documents with auto-increment version and `is_active` flag |
| `LlmCallLog` | Rate limiting ledger with `called_at` index, pruned to 48h window |
| `RetryQueue` | Task queue — RESOLVE_TWEET, FETCH_ENGAGEMENT, EVOLVE_PERSONA. Indexed on `(status, process_after, created_at)` for due-task lookup. |




<a id="customizing-the-owner-profile"></a>

## 👤 Customizing the Owner Profile

The public repo ships with a safe example profile in [`ownerProfile.example.json`](ownerProfile.example.json). Do not put personal values in that tracked file.

Runtime priority is simple:

1. Load Render Secret File path `/etc/secrets/ownerProfile.private.json`.
2. Load local private profile from `ownerProfile.private.json`.
3. If no private profile exists, fall back to `ownerProfile.example.json`.

Local setup:

```powershell
Copy-Item ownerProfile.example.json ownerProfile.private.json
```

Then edit `ownerProfile.private.json` with your real username, identity, domains, voice, topic mix, evergreen tech topics, personal topics, and culture interests. This file is ignored by Git.

### Owner profile builder prompt

You can use [`prompts/owner-profile-builder.md`](prompts/owner-profile-builder.md) with the LLM you talk to regularly, such as ChatGPT, Claude, or Gemini, to help build or enrich your private owner profile.

Use **patch mode** first unless you are creating a profile from scratch. It asks the LLM for additions only, which makes review safer than replacing the whole file.

Important guardrails:

- Do not paste API keys, tokens, passwords, client names, private employer details, exact addresses, or sensitive personal data.
- Review every generated value before adding it to `ownerProfile.private.json`.
- Delete anything that exaggerates your seniority, success, authority, interests, or personality.
- Prefer concrete everyday topic seeds over broad personal branding.

On Render, the recommended setup is a **Secret File**:

1. Open the Render service -> **Environment** -> **Secret Files**.
2. Add a file named `ownerProfile.private.json`.
3. Paste the contents of your local `ownerProfile.private.json`.
4. Save and deploy. Render exposes it at `/etc/secrets/ownerProfile.private.json`.

| Field | Used by | What it does |
| :--- | :--- | :--- |
| `username` | worker scraping, fingerprint resolution | Your X handle (without @). Must match the `X_USERNAME` in `.env`. |
| `identity` | `personaAdapter` prompt | One-line "you are…" statement at the top of the persona block. |
| `domains` | `personaAdapter` prompt | High-level topic descriptions injected into the persona. |
| `domainKeywords` | `trendRelevance.ts`, `topicCoherence.ts` | **Flat lowercase keyword list.** Drives tech trend classification and the coherence gate (>=2 matches in the draft = on-domain pivot). Add broadly; "ai" will not match "brain" because the trend classifier uses word boundaries. |
| `moods` / `tones` / `language` | persona prompt | Style flavor lists. |
| `experienceVoice` | persona prompt | One-line experience anchor. |
| `cities` / `hobbies` / `slangs` | persona prompt | Personality flavor. Slangs are sparingly applied (1 per tweet max). |
| `avoid` | persona prompt | Hard topic bans. The agent never tweets about these. |
| `voiceSeed` | `personaEvolver.ts` | Voice anchor used when the LLM evolves the persona, so the profile can be supplied by the runtime owner configuration instead of a hardcoded voice. |
| `preferredLength` | length target seed | `'short' \| 'medium' \| 'long'`. Soft hint until enough outcome data exists for `computeLengthTarget()` to derive a real range. |
| `tweetLanguages` | `trendRelevance.ts` | ISO 639-1 codes. When `'en'` is in the list, non-ASCII trends are rejected unless they match a configured culture interest. |
| `domains` | `topicPlanner.ts`, prompts | Tech-domain seed pool plus prompt boundary. These now compete as the `domains` bucket inside the tech lane instead of only acting as prompt context. |
| `topicMix` | `topicPlanner.ts` | Lane ratio, e.g. `{ "tech": 80, "culture": 20 }`. The planner checks the last 20 DB topics and chooses the underrepresented lane when needed. |
| `evergreenTechTopics` | `topicPlanner.ts` | Tech/AI/dev topic bucket. Old profiles that only have `coldStartTopics` automatically use that list as `evergreenTechTopics`. |
| `personalTopics` | `topicPlanner.ts` | Personal/culture bucket for hobbies, cities, life observations, and personality topics. Missing values fall back to `hobbies`. |
| `cultureTopics` | `topicPlanner.ts` | Profile-approved culture/product/startup/music topic bucket. |
| `cultureInterests` | `trendRelevance.ts`, `topicPlanner.ts` | Bucketed allowlists for artists, companies, people, products, startups, songs, and hobbies. Trends matching these can enter the culture lane; random entertainment still stays blocked. These fields also compete as direct profile topic buckets when the culture lane is selected. |
| `coldStartTopics` | legacy profile compatibility | Kept for older private profiles. New topic selection uses `evergreenTechTopics` through `topicPlanner.ts`; `pickColdStartTopic()` and `topicFree` fallback are no longer the generation path. |

### How topics are selected

The agent now chooses topics through `src/topicPlanner.ts` before generation. The planner always returns a structured topic plan:

```ts
{
  topic: string;
  lane: "tech" | "culture";
  source: "user_supplied" | "trend" | "domain" | "evergreen_tech" | "personal" | "culture" | "culture_interest" | "profile_fallback";
  topicBucket: "user_supplied" | "trend" | "domains" | "evergreen_tech" | "personal" | "culture_topics" | "artists" | "companies" | "people" | "products" | "startups" | "songs" | "hobbies" | "profile_fallback";
  topicAngle: string;
  needsNewsContext: boolean;
  reason: string;
}
```

Selection order:

1. Respect a supplied `/api/generate` or manual `?topic=` unless it is inside the 48h cooldown.
2. Classify Trends24 items as candidate freshness signals; trends do not control fallback behavior.
3. Count the last 20 DB topics by inferred lane and enforce `topicMix`.
4. Count recent profile buckets and apply a recency penalty so one bucket (for example `evergreen_tech`) does not monopolize selection.
5. Pick from the selected lane's eligible profile/trend buckets while avoiding recent and blacklisted topics.
6. Pass the selected topic, bucket, and angle to `contentGenerator`.

`needsNewsContext=true` enables Gemini Google Search retrieval for generation.
It is used for trends and named entities like companies, products, tech CEOs, artists, startups, and songs.
Evergreen tech and personal topics stay ungrounded.

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

> **The committed owner profile is a public example.** Copy `ownerProfile.example.json` to ignored `ownerProfile.private.json` for local use.
> Upload that private file to Render. See [Customizing the Owner Profile](#customizing-the-owner-profile).

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
                                       # Must match username in the runtime owner profile.
X_POST_CHAR_LIMIT=280                  # Full X composer limit. Keep 280 for free/non-Premium standard posts; use a higher value only for Premium longer-post accounts.
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

**Choosing `X_POST_CHAR_LIMIT`:**

- This single setting controls tweet length.
- Set it to the full X composer limit for the account, not the visible prompt budget.
- Use `280` for free/non-Premium standard posting.
- Use a higher value such as `25000` only for Premium longer-post accounts that intentionally want long drafts.
- PostPilot subtracts hidden fingerprint overhead automatically. With `X_POST_CHAR_LIMIT=280`, the visible target is 247 characters because 33 characters are reserved for tracking.
- Drafts are fitted to the visible budget before scoring/coherence. If the server safety trim still fires before adding the fingerprint, it re-runs scoring/coherence before saving the draft.

Generate `HMAC_SECRET` and `TELEGRAM_WEBHOOK_SECRET` (64-char hex). Run this command **separately for each variable** and paste two different values; do not reuse the same secret for both:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Generate `INTERNAL_API_KEY` (base64, URL-safe):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

`INTERNAL_API_KEY` is required in the `X-API-Key` header for `/api/generate`, `/api/cron/generate`, `/api/status`, `/api/analytics`, `/api/status/:id/timeline`, and `/api/admin/*` requests.

**Register the Telegram webhook** — without this, active callback buttons such as ✅ Posted never reach the server.
Paste the URL into a browser or `curl`, replacing `<TOKEN>`, `<BASE_URL>`, and `<TELEGRAM_WEBHOOK_SECRET>`.

```
https://api.telegram.org/bot<TOKEN>/setWebhook?url=<BASE_URL>/api/telegram/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>
```

Expect `{"ok":true,"result":true,"description":"Webhook was set"}`. Verify with `https://api.telegram.org/bot<TOKEN>/getWebhookInfo`. Every callback checks `secret_token`; mismatch returns `403`.

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

3.  **Add to Environment**: Paste the token as `TELEGRAM_BOT_TOKEN` and the numeric chat ID as `TELEGRAM_CHAT_ID`. `TELEGRAM_CHAT_ID` is used for bot-initiated alerts like `RESOLVE_FAILED` and rate-limit warnings.

<a id="5-configure-cloudflare-worker-cron"></a>

### 5. Configure Cloudflare Worker Cron

PostPilot uses **Cloudflare Worker Cron** for scheduling.

The Worker calls protected `POST /api/cron/generate` on Render.
PostPilot stores a unique `scheduled_slot_key` per UTC day/slot, so retries and cold-start repeats do not create duplicate drafts.
Finished drafts go directly to Telegram.

The cron Worker posts directly to `/api/cron/generate` and lets the app handle async generation.
It does **not** run a blocking warm-up GET or fixed pre-generation sleep.
UptimeRobot already warms `/` every 5 minutes, and Worker-side warm-ups can hide cron delivery failures.

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

`cloudflare/wrangler.toml` is local deploy config. Keep it untracked; commit `cloudflare/wrangler.toml.example` instead.
Wrangler deploys from the local file, so copy dashboard schedule/observability changes back into `wrangler.toml` and the example before the next deploy.

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

On Windows PowerShell, type secrets manually if copy-paste behaves oddly in the prompt. This matters for `POSTPILOT_BASE_URL`; a bad paste can store a corrupt URL. You can also pipe the value to avoid the prompt.

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

During the first `wrangler deploy`, Cloudflare may ask for a `workers.dev` subdomain. Use that chosen subdomain wherever this guide shows `example-user`. For example:

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
PostPilot cron trigger started
PostPilot cron trigger accepted
PostPilot manual trigger accepted
PostPilot manual trigger failed
```

If a manual trigger returns `Unauthorized`, your URL token does not match `POSTPILOT_MANUAL_TRIGGER_TOKEN`. If the Worker logs `HTTP 401`, `POSTPILOT_INTERNAL_API_KEY` does not match Render's `INTERNAL_API_KEY`.

Do not manage the production schedule only from the Cloudflare dashboard.
Wrangler deploys replace active Worker config from local `cloudflare/wrangler.toml`.
Keep schedule, observability, and route changes there first, then mirror them into the example.

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
> Baseline cost is 3 LLM calls per tweet, or up to 4 with a diversity re-roll.
> Three scheduled posts use roughly 9-12 calls/day. One more call is reserved for persona evolution.
> Keep `src/rateGuard.ts` aligned with the real quota before increasing the schedule.

### Increasing RPM / RPD Limits

Defaults are set in [`src/rateGuard.ts`](src/rateGuard.ts) and must match your active Google AI tier/model quota. Current app-side settings are 5 RPM / 19 RPD:

```typescript
// src/rateGuard.ts
const RPM_LIMIT = 5;      // bump to your tier's RPM
const RPD_LIMIT = 19;     // bump to your tier's RPD
```

When exhausted, the graph short-circuits at [`contentGenerator`](src/agent.ts).
It marks the tweet `GENERATION_RATE_LIMITED` and sends a Telegram warning instead of a junk draft.
When Gemini/provider invocation fails before returning a draft, the graph also short-circuits at `contentGenerator`; `server.ts` marks the tweet `ERROR`, sends a Telegram warning, and skips fallback-draft scoring/delivery.
The guard counts all models in one bucket; LangChain fallbacks handle provider-side per-model 429s.


<a id="database-stability"></a>

## 🛡️ Database Stability

PostPilot runs in **small-pool mode** (`connection_limit=5`).
`contextLoader` uses explicit sequential DB reads, and the worker schedules around due tasks.
The workload is small, but generation, resolver work, Telegram callbacks, admin/status checks, and agent reads can still overlap.

**How it works** (see [`src/db.ts`](src/db.ts), [`src/agent.ts`](src/agent.ts) `contextLoader`):

1. **Connection-string params** — `connection_limit=5`, `pool_timeout=60`, `connect_timeout=30`, `tcp_keepalives_*`. All required; see the `.env` example in [Configure environment](#2-configure-environment).
2. **Retry-once middleware** — on reconnectable Prisma/network errors, waits 1.5s and retries once. Prisma reconnects on the retry call. Do not call `$disconnect()` here; it can tear down the shared pool.
3. **`ensureDbReady()`** — probes with one retry before `contextLoader`'s query sequence, so a cold socket reconnects on one probe rather than on the first real query.
4. **Sequential loading in `contextLoader`** — DB reads use explicit `await`s instead of `Promise.all`. This keeps slow windows from occupying every pool slot. Trends still overlaps because it does not use the socket.
5. **Due-task worker scheduling** — `src/worker.ts` sleeps until the earliest pending `RetryQueue.process_after`. Idle reconciliation is capped at 15 minutes, and `enqueueRetry()` wakes it immediately.

`canCallLLM()` also fails **open** on DB error so a transient blip never blocks generation.

**Wall-clock impact:** `contextLoader` runs ~400–500ms total (was ~350ms in serialized-Promise.all mode, ~80ms on a real pool). Invisible against the Cloudflare Worker retry window.

**Log-level discipline:** middleware retries log at `WARN`, which means normal recovery.
Worker connection failures also start at `WARN`.
The `ERROR`/`CRITICAL` path only fires after **5 consecutive** worker failures, meaning the DB has been unreachable for about 5 minutes.
That is the line worth paging on. See [Worker & Logging](#-background-workers).

### Keeping logs quiet

Supavisor on free tier drops idle sockets after about 5 minutes.
`src/db.ts` reconnects on the next real query and logs one `WARN`.
The old `/health/db` keepalive was removed because it competed with real work and made recoverable blips look like downtime.

The worker no longer polls every 60s while idle. It sleeps until the next due task, or at most 15 minutes when empty. Single connection failures stay quiet; WARN starts after 3 consecutive failures and CRITICAL after 5.

Migration `20260427000000_add_retry_queue_due_index` has been applied to Supabase. Verify with `prisma migrate status`; Postgres should also have `RetryQueue_status_process_after_created_at_idx`.

> If Render still has `connection_limit=1` or `connection_limit=3`, update only that query parameter to `connection_limit=5` and redeploy.
> Keep `pool_timeout=60`, `connect_timeout=30`, `pgbouncer=true`, and the TCP keepalive params unchanged.

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
   - `DATABASE_URL`: Transaction Pooler on port 6543 with full stability params. Required values include `connection_limit=5`, `pool_timeout=60`, all five `tcp_keepalives_*` params, and `connect_timeout`.

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

> Do **not** add a second monitor against `/health/db`; that endpoint was removed. During Supavisor flaps it held a Prisma slot for 45s and made recoverable blips look like downtime.

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

PostPilot is designed as a **Safety-First Autonomous Agent**. It avoids aggressive API automation and prioritizes long-term account safety through four strategies:

- **Human-in-the-Loop (HITL)**: AI drafts, you post. No account credentials ever handed to an automated script — you stay a regular user in X's eyes.

- **Layered Resolution**: Zero-width fingerprints, truncated-fingerprint matching, and visible-text fallback link drafts to engagement without the Official X API or visible tracking IDs.

- **Decoupled Data Collection**: Tracking via publicly available data sources and syndication endpoints. Your account is never used to scrape, so tracking rate-limits never touch your handle.

- **Content Diversity Gate**: Trigram similarity, FORMAT-prefixed structural fingerprints, and LRU rotation protect against same-shape repetition. Heuristic backfill survives Render restarts without a schema migration.

<a id="hard-constraints"></a>

## ⚖️ Hard Constraints

- **Typical 2-3 LLM calls** per tweet generation (contentGenerator, qualityScorer, autoRefiner when needed). Worst case is usually 4 with a diversity re-roll; a failed post-refiner validation can use one extra refiner call. A rare server safety trim can add one scorer call before persistence.

- **Max 1 LLM call/day** for persona evolution (offline, via EVOLVE_PERSONA task).

- **Google AI Studio limits:** the app-side guard is 5 RPM / 19 RPD in `src/rateGuard.ts`. Keep these constants aligned with the active Google tier/model. When exhausted, the graph stops at `contentGenerator`.

- **Data-Driven Analysis**: Engagement scoring, feedback weighting, and trend tracking use pure math. LLM budget is reserved for draft generation and persona evolution.

- **LangGraph pipeline shape:** `contextLoader -> personaAdapter -> contentGenerator -> diversityGate -> qualityScorer -> coherenceGate -> autoRefiner? -> postRefinerGate? -> finalTopicMemory -> END`.
  Re-rolls go through `diversityGate -> personaAdapter -> contentGenerator`, capped at one retry.

<a id="contributing"></a>

## Contributing

Contributions, feature ideas, and bug reports are welcome. Open an issue for bugs, setup friction, feature requests, or automation-flow questions. For bugs, include expected vs actual behavior and safe logs.

If you want to build a feature, please open an issue first so the approach can stay aligned with PostPilot's safety, rate-limit, and human-in-the-loop posting model.

If PostPilot is useful to you, please star the repo so more builders can find it. ⭐
