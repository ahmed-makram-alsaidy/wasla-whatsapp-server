// ─────────────────────────────────────────────────────────
// index.js — Express API Server
// الـ main entry point للـ Baileys WhatsApp Server
// ─────────────────────────────────────────────────────────
require('dotenv').config();

const express = require('express');
const wa = require('./whatsapp');
const { logGroupMessage, markOutboxMessage } = require('./sessionStore');
const { getStats } = require('./rateLimiter');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.BAILEYS_API_KEY;

// ── Middleware: API Key Auth ───────────────────────────────
function requireApiKey(req, res, next) {
  if (!API_KEY) return next(); // لو مفيش key محدد، اسمح بكل شيء (dev mode)

  const provided = req.headers['x-api-key'] || req.query.apiKey;
  if (provided !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized — Invalid API Key' });
  }
  next();
}

// ── Logging ───────────────────────────────────────────────
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ────────────────────────────────────────────────────────────
// Routes
// ────────────────────────────────────────────────────────────

/**
 * GET /health
 * فحص الـ server وحالة الاتصال
 */
app.get('/health', (req, res) => {
  const status = wa.getStatus();
  res.json({
    ok: true,
    server: 'wasla-whatsapp-server',
    version: '1.0.0',
    whatsapp: status,
    rateLimiter: getStats(),
    uptime: Math.floor(process.uptime()),
  });
});

/**
 * GET /status
 * حالة الاتصال بالتفصيل
 */
app.get('/status', requireApiKey, (req, res) => {
  res.json(wa.getStatus());
});

/**
 * GET /qr
 * الحصول على QR Code كـ base64 لعرضه في الواجهة
 */
app.get('/qr', requireApiKey, async (req, res) => {
  const { status } = wa.getStatus();

  if (status === 'connected') {
    return res.json({ connected: true, qr: null });
  }

  const qrBase64 = await wa.getCurrentQrBase64();

  if (!qrBase64) {
    return res.json({
      connected: false,
      qr: null,
      message: 'QR غير متاح بعد. انتظر 10 ثواني وحاول مجدداً.',
    });
  }

  res.json({ connected: false, qr: qrBase64 });
});

/**
 * GET /groups
 * قائمة الجروبات المشترك فيها
 */
app.get('/groups', requireApiKey, async (req, res) => {
  try {
    const groups = await wa.getGroups();
    res.json({ groups });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /send-group
 * إرسال رسالة لجروب
 *
 * Body:
 * {
 *   group_jid: "120363xxx@g.us",
 *   message: "نص الرسالة",
 *   outbox_id: "uuid (اختياري — لتحديث notification_outbox)",
 *   merchant_id: "uuid (اختياري)",
 *   shipment_id: "uuid (اختياري)",
 *   tracking_number: "string (اختياري)",
 *   group_name: "string (اختياري)"
 * }
 */
app.post('/send-group', requireApiKey, async (req, res) => {
  const { group_jid, message, outbox_id, merchant_id, shipment_id, tracking_number, group_name } = req.body;

  if (!group_jid || !message) {
    return res.status(400).json({ error: 'group_jid و message مطلوبان' });
  }

  log(`Sending to group ${group_jid} (${group_name || '—'})`);

  try {
    await wa.sendGroupMessage(group_jid, message);

    // سجل في message_log
    await logGroupMessage({
      groupJid: group_jid,
      groupName: group_name,
      merchantId: merchant_id,
      shipmentId: shipment_id,
      trackingNumber: tracking_number,
      messageText: message,
      status: 'sent',
    });

    // حدّث notification_outbox لو فيه outbox_id
    if (outbox_id) {
      await markOutboxMessage(outbox_id, 'sent');
    }

    log(`✅ Sent to ${group_jid}`);
    res.json({ ok: true, group_jid, message: 'تم الإرسال' });
  } catch (err) {
    log(`❌ Failed to send to ${group_jid}: ${err.message}`);

    // سجل الفشل
    await logGroupMessage({
      groupJid: group_jid,
      groupName: group_name,
      merchantId: merchant_id,
      shipmentId: shipment_id,
      trackingNumber: tracking_number,
      messageText: message,
      status: 'failed',
      errorText: err.message,
    });

    if (outbox_id) {
      await markOutboxMessage(outbox_id, 'failed', err.message);
    }

    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /disconnect
 * قطع الاتصال بشكل نظيف (تسجيل خروج)
 */
app.post('/disconnect', requireApiKey, async (req, res) => {
  try {
    await wa.disconnect();
    res.json({ ok: true, message: 'تم قطع الاتصال وتسجيل الخروج' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /reconnect
 * إعادة الاتصال
 */
app.post('/reconnect', requireApiKey, async (req, res) => {
  try {
    await wa.connect();
    res.json({ ok: true, message: 'جاري إعادة الاتصال...' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 404 Handler ───────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

// ── Start ─────────────────────────────────────────────────
app.listen(PORT, async () => {
  log(`🚀 Wasla WhatsApp Server running on port ${PORT}`);

  // ابدأ الاتصال بواتساب
  try {
    await wa.connect();
  } catch (err) {
    log(`⚠️ Initial connect failed: ${err.message}`);
  }
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  log('SIGTERM received — shutting down gracefully');
  process.exit(0);
});
