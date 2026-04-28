const SCHEDULE_TO_SLOT = {
  '30 3 * * *': 'morning',
  '0 8 * * *': 'afternoon',
  '30 16 * * *': 'night',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBaseUrl(value) {
  if (!value) throw new Error('POSTPILOT_BASE_URL is required');
  return value.replace(/\/+$/, '');
}

function inferSlot(date) {
  const hour = date.getUTCHours();
  if (hour < 12) return 'morning';
  if (hour < 18) return 'afternoon';
  return 'night';
}

function slotForSchedule(controller, date) {
  return SCHEDULE_TO_SLOT[controller.cron] || inferSlot(date);
}

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

async function fetchWithTimeout(url, init = {}, timeoutMs = 25_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('timeout'), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function warmApp(baseUrl) {
  try {
    await fetchWithTimeout(`${baseUrl}/`, { method: 'GET' }, 20_000);
  } catch (err) {
    console.warn('Warm-up request failed; generate request will still retry', err);
  }
}

async function triggerGeneration(env, controller) {
  const baseUrl = normalizeBaseUrl(env.POSTPILOT_BASE_URL);
  const apiKey = env.POSTPILOT_INTERNAL_API_KEY;
  if (!apiKey) throw new Error('POSTPILOT_INTERNAL_API_KEY is required');

  const scheduledAt = new Date(controller.scheduledTime || Date.now());
  const slot = slotForSchedule(controller, scheduledAt);
  const scheduledSlotKey = `${dateKey(scheduledAt)}-${slot}`;
  const body = JSON.stringify({
    source: 'cloudflare-cron',
    time_of_day: slot,
    scheduled_slot_key: scheduledSlotKey,
  });

  await warmApp(baseUrl);
  await sleep(20_000);

  let lastError = null;
  const delays = [0, 15_000, 60_000];
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt] > 0) await sleep(delays[attempt]);
    try {
      const response = await fetchWithTimeout(`${baseUrl}/api/cron/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
        body,
      }, 45_000);

      const text = await response.text();
      if (response.ok) {
        console.log('PostPilot cron trigger accepted', {
          status: response.status,
          slot,
          scheduledSlotKey,
          body: text,
        });
        return;
      }
      lastError = new Error(`HTTP ${response.status}: ${text}`);
    } catch (err) {
      lastError = err;
    }
    console.warn('PostPilot cron trigger attempt failed', {
      attempt: attempt + 1,
      slot,
      scheduledSlotKey,
      error: String(lastError),
    });
  }

  throw lastError || new Error('PostPilot cron trigger failed');
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(triggerGeneration(env, controller));
  },

  async fetch() {
    return new Response('PostPilot cron worker is active.\n', {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  },
};
