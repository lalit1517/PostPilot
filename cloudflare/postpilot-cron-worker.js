const SCHEDULE_TO_SLOT = {
  '30 3 * * *': 'morning',
  '0 8 * * *': 'afternoon',
  '30 16 * * *': 'night',
};

const VALID_SLOTS = new Set(['morning', 'afternoon', 'night']);

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

async function triggerManualGeneration(env, slot, topic) {
  const baseUrl = normalizeBaseUrl(env.POSTPILOT_BASE_URL);
  const apiKey = env.POSTPILOT_INTERNAL_API_KEY;
  if (!apiKey) throw new Error('POSTPILOT_INTERNAL_API_KEY is required');

  const body = JSON.stringify({
    source: 'cloudflare-manual',
    time_of_day: slot,
    ...(topic ? { topic } : {}),
  });

  await warmApp(baseUrl);
  await sleep(10_000);

  let lastError = null;
  const delays = [0, 10_000, 30_000];
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt] > 0) await sleep(delays[attempt]);
    try {
      const response = await fetchWithTimeout(`${baseUrl}/api/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
        body,
      }, 45_000);

      const text = await response.text();
      if (response.ok) {
        return new Response(text, {
          status: response.status,
          headers: {
            'content-type': response.headers.get('content-type') || 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          },
        });
      }
      lastError = new Error(`HTTP ${response.status}: ${text}`);
    } catch (err) {
      lastError = err;
    }
    console.warn('PostPilot manual trigger attempt failed', {
      attempt: attempt + 1,
      slot,
      error: String(lastError),
    });
  }

  throw lastError || new Error('PostPilot manual trigger failed');
}

async function handleManualRequest(request, env, ctx) {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);
  const [, token, slot] = parts;

  if (request.method !== 'GET' && request.method !== 'POST') {
    return new Response('Method not allowed\n', { status: 405 });
  }

  if (!env.POSTPILOT_MANUAL_TRIGGER_TOKEN) {
    return new Response('Manual trigger token is not configured\n', { status: 500 });
  }

  if (!token || token !== env.POSTPILOT_MANUAL_TRIGGER_TOKEN) {
    return new Response('Unauthorized\n', { status: 401 });
  }

  if (!VALID_SLOTS.has(slot)) {
    return new Response('Invalid slot. Use morning, afternoon, or night.\n', { status: 400 });
  }

  const topic = url.searchParams.get('topic')?.trim() || undefined;
  ctx.waitUntil(
    triggerManualGeneration(env, slot, topic)
      .then(async (response) => {
        const body = await response.text();
        console.log('PostPilot manual trigger accepted', {
          status: response.status,
          slot,
          body,
        });
      })
      .catch((err) => {
        console.error('PostPilot manual trigger failed', err);
      })
  );

  return new Response(`Manual ${slot} generation queued.\nCheck Telegram for the draft.\n`, {
    status: 202,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(triggerGeneration(env, controller));
  },

  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith('/manual/')) {
        return await handleManualRequest(request, env, ctx);
      }

      return new Response('PostPilot cron worker is active.\n', {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    } catch (err) {
      console.error('PostPilot worker request failed', err);
      return new Response(`Worker request failed: ${String(err)}\n`, {
        status: 500,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
        },
      });
    }
  },
};
