// ─────────────────────────────────────────────────────────
// rateLimiter.js — حماية من الحظر + per-company fairness
//
// Closure law:
//  - ONE global throughput ceiling (RATE_LIMIT_PER_MIN, default 20) to keep
//    WhatsApp accounts safe.
//  - PER-COMPANY FIFO queues drained round-robin, so a large Company A
//    backlog can never indefinitely starve Company B.
//  - Human-like jitter preserved (MIN_DELAY_MS..MAX_DELAY_MS).
// ─────────────────────────────────────────────────────────
const NodeCache = require('node-cache');

// Window counter: نعد الرسائل كل 60 ثانية
const windowCache = new NodeCache({ stdTTL: 60, checkperiod: 10 });

const RATE_LIMIT = parseInt(process.env.RATE_LIMIT_PER_MIN || '20');
const MIN_DELAY_MS = parseInt(process.env.MIN_DELAY_MS || '1000');
const MAX_DELAY_MS = parseInt(process.env.MAX_DELAY_MS || '3000');

// Per-company queues: Map<companyId, Array<{job, resolve, reject}>>
const companyQueues = new Map();

let isProcessing = false;

function getQueue(companyId) {
  const key = String(companyId || 'default');
  let q = companyQueues.get(key);
  if (!q) {
    q = [];
    companyQueues.set(key, q);
  }
  return q;
}

/**
 * Add a send job to the company's own queue.
 * Round-robin across companies happens in processQueue().
 */
function enqueue(companyId, job) {
  if (typeof companyId === 'function') {
    // legacy single-arg call shape → route through default lane
    job = companyId;
    companyId = 'default';
  }
  return new Promise((resolve, reject) => {
    getQueue(companyId).push({ job, resolve, reject });
    processQueue();
  });
}

/** Companies with pending work right now. */
function pendingCompanies() {
  const out = [];
  for (const [key, q] of companyQueues) {
    if (q.length > 0) out.push(key);
  }
  return out;
}

async function processQueue() {
  if (isProcessing) return;
  isProcessing = true;

  try {
    while (pendingCompanies().length > 0) {
      const count = windowCache.get('count') || 0;
      if (count >= RATE_LIMIT) {
        console.warn(`[RateLimiter] Reached ${RATE_LIMIT}/min limit. Waiting...`);
        await sleep(5000);
        continue;
      }

      // Round-robin: take exactly one job per non-empty queue this pass.
      const lanes = pendingCompanies();
      for (const key of lanes) {
        const q = getQueue(key);
        const item = q.shift();
        if (!item) continue;

        try {
          await sleep(randomBetween(MIN_DELAY_MS, MAX_DELAY_MS));
          const result = await item.job();
          windowCache.set('count', (windowCache.get('count') || 0) + 1);
          item.resolve(result);
        } catch (err) {
          item.reject(err);
        }
      }
    }
  } finally {
    isProcessing = false;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * فحص هل ممكن نبعت دلوقتي؟
 */
function canSend() {
  const count = windowCache.get('count') || 0;
  return count < RATE_LIMIT;
}

/**
 * إحصائيات — per-lane depth, never message contents.
 */
function getStats() {
  const lanes = {};
  for (const [key, q] of companyQueues) {
    lanes[key] = q.length;
  }
  return {
    queued: Object.values(lanes).reduce((a, b) => a + b, 0),
    lanes,
    sentThisMinute: windowCache.get('count') || 0,
    rateLimit: RATE_LIMIT,
    isProcessing,
  };
}

module.exports = { enqueue, canSend, getStats };
