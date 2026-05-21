// ─────────────────────────────────────────────────────────
// rateLimiter.js — حماية من الحظر
// Max 20 رسالة/دقيقة، delay عشوائي بين الرسائل
// ─────────────────────────────────────────────────────────
const NodeCache = require('node-cache');

// Window counter: نعد الرسائل كل 60 ثانية
const windowCache = new NodeCache({ stdTTL: 60, checkperiod: 10 });

const RATE_LIMIT = parseInt(process.env.RATE_LIMIT_PER_MIN || '20');
const MIN_DELAY_MS = parseInt(process.env.MIN_DELAY_MS || '1000');
const MAX_DELAY_MS = parseInt(process.env.MAX_DELAY_MS || '3000');

// Queue للرسائل المعلقة
const messageQueue = [];
let isProcessing = false;

/**
 * إضافة رسالة للقائمة
 */
function enqueue(job) {
  return new Promise((resolve, reject) => {
    messageQueue.push({ job, resolve, reject });
    processQueue();
  });
}

/**
 * معالجة القائمة بالتسلسل مع rate limiting
 */
async function processQueue() {
  if (isProcessing || messageQueue.length === 0) return;
  isProcessing = true;

  while (messageQueue.length > 0) {
    const count = windowCache.get('count') || 0;

    if (count >= RATE_LIMIT) {
      console.warn(`[RateLimiter] Reached ${RATE_LIMIT}/min limit. Waiting...`);
      await sleep(5000);
      continue;
    }

    const { job, resolve, reject } = messageQueue.shift();

    try {
      // Delay عشوائي لمحاكاة سلوك بشري
      const delay = randomBetween(MIN_DELAY_MS, MAX_DELAY_MS);
      await sleep(delay);

      const result = await job();
      windowCache.set('count', count + 1);
      resolve(result);
    } catch (err) {
      reject(err);
    }
  }

  isProcessing = false;
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
 * إحصائيات
 */
function getStats() {
  return {
    queued: messageQueue.length,
    sentThisMinute: windowCache.get('count') || 0,
    rateLimit: RATE_LIMIT,
    isProcessing,
  };
}

module.exports = { enqueue, canSend, getStats };
