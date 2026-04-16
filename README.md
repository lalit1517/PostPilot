# PostPilot: The Ultimate Automated X Content Agent

PostPilot is a professional-grade, autonomous content ecosystem for X (formerly Twitter). It manages the entire lifecycle of your social presence: from AI-driven trend analysis and draft generation to human-in-the-loop approval, invisible fingerprint tracking, and longitudinal engagement analytics.

---

## 🏗 System Architecture

PostPilot operates as a distributed system across three core layers:
1.  **Orchestration (n8n)**: Handles scheduling and mobile notifications via Telegram.
2.  **Intelligence (LangGraph + Gemini)**: Processes high-level goals into creative drafts.
3.  **Persistence (Supabase + Prisma)**: Maintains time-series data and task queues.

---

## ⚙️ Configuration & Setup

### 1. Database Setup (Supabase)
1.  Create a project on [Supabase](https://supabase.com).
2.  **Prisma Connection**: 
    *   Set `DATABASE_URL` to your **Transaction Connection String** (Session mode).
    *   Set `DIRECT_URL` (if needed) for migrations.
3.  Initialize the schema:
    ```bash
    npx prisma db push
    npx prisma generate
    ```

### 2. Telegram Bot Setup
1.  **Create Bot**: Message [@BotFather](https://t.me/BotFather) on Telegram and send `/newbot`. Follow instructions to get your `TELEGRAM_BOT_TOKEN`.
2.  **Get Chat ID**: Message [@userinfobot](https://t.me/userinfobot) and send `/start`. It will return your unique ID. Use this in your n8n Telegram node.
3.  **Privacy**: If using a group, ensure the bot has permission to send messages.

---

## 🔑 Environment Variables Reference (.env)

| Variable | Source / Config | Purpose |
| :--- | :--- | :--- |
| `DATABASE_URL` | Supabase Settings > Database | Primary Postgres connection (use transaction pooler). |
| `GOOGLE_API_KEY` | [AI Studio](https://aistudio.google.com/) | API Key for Gemini 2.x/3.x models. |
| `X_USERNAME` | Your X Profile | The handle the worker will scrape for post confirmation. |
| `BASE_URL` | Railway / Ngrok | The root URL where your Express server is hosted. |
| `HMAC_SECRET` | Custom (see below) | A 64-char hex used to sign secure Edit/Feedback URLs. |
| `TELEGRAM_BOT_TOKEN` | @BotFather | Token used to send messages to the Telegram API. |
| `PORT` | Local: `3000` | The port the Express server listens on. |

### Generating your `HMAC_SECRET`
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## 🚀 Deployment (Railway)

To run PostPilot in production, you must have **both** the API server and the Background Worker running.

### Option A: Two Separate Services (Recommended)
1.  Create two services in your Railway project sourced from the same repo.
2.  **Service 1 (API)**: Set the start command to `npm start`.
3.  **Service 2 (Worker)**: Set the start command to `npm run worker`.

### Option B: Monolith (Concurrent)
If you want to save on Railway costs, install `concurrently` and update your `start` script:
```bash
npm install concurrently
```
Then update `package.json`:
`"start": "concurrently \"npm run start:api\" \"npm run worker\""`

---

## 🧠 AI Agent Logic (LangGraph)

PostPilot uses a custom **StateGraph** to ensure high-quality content generation:

*   **Models & Fallbacks**: 
    *   **Primary**: `gemini-2.5-flash`.
    *   **Fallbacks**: `gemini-3-flash-preview` and `gemini-3.1-flash-lite-preview`.
*   **Self-Correction Loop**: If the `qualityScorer` gives a score below 8, the `autoRefiner` node triggers a mandatory rewrite based on the critique.
*   **Optimization Fixes**: 
    *   **Parallel Loading**: `contextLoader` runs all DB queries in parallel to reduce latency.
    *   **Hallucination Prevention**: Temperature is locked at `0.7`.

---

## 🕵️‍♂️ Under the Hood: Tracking & Robustness

### Invisible Fingerprinting
PostPilot bypasses brittle ID-based tracking by injecting invisible markers into your tweet body:
*   **The Injection**: The hex is converted into a series of invisible Unicode characters (`U+200B` and `U+200C`).
*   **The Result**: You can edit the *visible* text on X, and PostPilot will still find the post as long as those trailing invisible characters remain.

### Background Worker Architecture (`src/worker.ts`)
The `RetryQueue` handles two critical tasks:
1.  **`RESOLVE_TWEET`**: Starts 10m after user confirmation. Multi-source search (Nitter + X Timeline).
2.  **`TRACK_ENGAGEMENT`**: Snapshots at **10m, 1h, 6h, 24h, 48h, 72h**. Stores in time-series format.
    *   **Jitter**: Every request adds a random 0-2000ms delay.

---

## ⌨️ CLI Commands

| Command | Action |
| :--- | :--- |
| `npm run dev` | Start the Express API server (Watch mode) |
| `npm run worker` | Start the background task processor |
| `npx prisma db push` | Sync schema with database (Supabase) |
| `npx prisma generate` | Update local TypeScript types |

---

## 🛡 Project Evolution & Critical Fixes

Prior key issues resolved:
*   **Prisma Type Mismatch**: Fixed `process_after` recognition via client regeneration.
*   **Bot Detection**: Implemented `getJitterDelay()` and browser-like headers.
*   **Atomic Updates**: Migrated engagement tracking from "upsert single row" to "insert history snapshots".

---

*Built with ❤️ for AI Builders.*
