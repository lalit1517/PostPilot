# PostPilot — Grafana Analytics Setup

Three pre-built dashboards. One command to provision everything. No manual clicking.

## What you get

| Dashboard | Panels | Purpose |
|---|---|---|
| Tweet Performance | 11 | Lifecycle table, status breakdown, outcome scores, engagement curves, posting slot heatmap, topic leaderboard |
| System Health | 14 | LLM budget gauges, worker queue, resolution funnel, failed/pending task tables |
| Learning Loop | 15 | Quality trends, Pearson r, feedback, sentiment, persona evolution, topic blacklist |

All panels query your Supabase DB directly — zero data retention limits, full history.

---

## Prerequisites

- Node.js 20+
- [Grafana Cloud](https://grafana.com/products/cloud/) free account (sign up takes 2 minutes)
- PostPilot `.env` configured with `GRAFANA_DATABASE_URL` or `DATABASE_URL`

---

## Step 1 — Sign up for Grafana Cloud

Go to https://grafana.com/products/cloud/ → **Start for free**.

Create an org. Your stack URL will look like `https://yourorg.grafana.net`. Note it down.

---

## Step 2 — Create a service account API key

1. In Grafana UI: **Administration → Service Accounts → Add service account**
2. Name: `postpilot-provisioner` — Role: **Editor**
3. Click the account → **Add service account token** → copy the token (starts with `glsa_`)

---

## Step 3 — Allow Grafana to reach Supabase

Grafana Cloud sends queries to your Supabase DB from fixed IP ranges.

**Option A (quick):** In Supabase → **Settings → Database → Connection pooling** — temporarily set "Allow all IPs", run provision, then restrict.

**Option B (proper):** Add Grafana Cloud IP ranges to Supabase's network allowlist.
Grafana's IP list: https://grafana.com/docs/grafana-cloud/account-management/network-security/

---

## Step 4 — Add env vars to `.env`

```env
GRAFANA_URL=https://yourorg.grafana.net
GRAFANA_API_KEY=glsa_xxxxxxxxxxxxxxxxxxxx
```

---

## Step 5 — Run the provisioning script

```bash
node grafana/provision.js
```

Expected output:

```
🚀 PostPilot Grafana Provisioner

✅ Data source created (uid: abc123)
✅ Imported: tweet-performance.json → https://yourorg.grafana.net/d/postpilot-tweet-performance/...
✅ Imported: system-health.json → https://yourorg.grafana.net/d/postpilot-system-health/...
✅ Imported: learning-loop.json → https://yourorg.grafana.net/d/postpilot-learning-loop/...

✅ Provisioning complete.
   Dashboards: https://yourorg.grafana.net/dashboards
```

The script is **idempotent** — safe to run again after dashboard updates.

---

## Step 6 — Set up Telegram alerts (optional but recommended)

Alerts fire when LLM budget hits 80% or worker tasks fail.

### Create the contact point

1. Grafana → **Alerting → Contact points → Add contact point**
2. Type: **Telegram**
3. Bot token: your `TELEGRAM_BOT_TOKEN` value
4. Chat ID: your Telegram chat ID (get it from [@userinfobot](https://t.me/userinfobot) — send `/start`)
5. **Test** → **Save**

### Alert 1 — LLM Budget Warning (80% of daily limit)

1. Grafana → **Alerting → Alert rules → New alert rule**
2. Data source: `PostPilot Supabase`
3. Query:
   ```sql
   SELECT COUNT(*) AS value FROM "LlmCallLog" WHERE called_at > NOW() - INTERVAL '24 hours'
   ```
4. Condition: `IS ABOVE 16`
5. Evaluation: every `1m`, pending period `0s`
6. Message:
   ```
   ⚠️ PostPilot LLM budget at {{ $values.A.Value }}/20 daily calls. Generation may be rate-limited soon.
   ```
7. Contact point: the Telegram contact point you created above

### Alert 2 — Worker Task Failure

1. New alert rule, same data source
2. Query:
   ```sql
   SELECT COUNT(*) AS value FROM "RetryQueue" WHERE status = 'FAILED' AND updated_at > NOW() - INTERVAL '10 minutes'
   ```
3. Condition: `IS ABOVE 0`
4. Evaluation: every `1m`, pending period `0s`
5. Message:
   ```
   🚨 PostPilot worker failure: {{ $values.A.Value }} task(s) failed in the last 10 minutes. Check: /api/admin/failed-tasks
   ```
6. Contact point: Telegram

---

## Re-provisioning after dashboard changes

Edited a dashboard JSON in `grafana/dashboards/`? Just re-run:

```bash
node grafana/provision.js
```

It overwrites existing dashboards with the updated JSON. Data source is skipped if already exists.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `Missing required env var: GRAFANA_URL` | Add `GRAFANA_URL` to `.env` |
| `401 Unauthorized` from Grafana API | Check `GRAFANA_API_KEY` — must be a service account token with Editor role |
| Data source created but panels show "no data" | Supabase is blocking Grafana IPs — see Step 3 |
| `password authentication failed` | Verify `GRAFANA_DATABASE_URL` uses the Supabase session pooler URL (port 5432) |
| `relation "Tweet" does not exist` | Prisma table names are double-quoted and case-sensitive — ensure the SQL in panels uses `"Tweet"` not `tweet` |
