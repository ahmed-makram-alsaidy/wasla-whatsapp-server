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
 * فحص الـ server وحالة الاتصال — Public
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
 * GET /status — Public
 */
app.get('/status', (req, res) => {
  res.json(wa.getStatus());
});

/**
 * GET /qr — Public (JSON)
 * الحصول على QR Code كـ base64
 */
app.get('/qr', async (req, res) => {
  const { status } = wa.getStatus();
  if (status === 'connected') {
    return res.json({ connected: true, qr: null });
  }
  const qrBase64 = await wa.getCurrentQrBase64();
  if (!qrBase64) {
    return res.json({ connected: false, qr: null, message: 'QR غير متاح بعد. انتظر 15 ثانية وحاول مجدداً.' });
  }
  res.json({ connected: false, qr: qrBase64 });
});

/**
 * GET /qr-scan — Public (HTML Page)
 * صفحة HTML لعرض QR وتتحدث كل 10 ثواني
 */
app.get('/qr-scan', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>واصلة — ربط واتساب</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, sans-serif; background: #0d1117; color: #e6edf3; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 16px; padding: 40px; text-align: center; max-width: 400px; width: 90%; }
    h1 { font-size: 22px; margin-bottom: 8px; color: #58a6ff; }
    p { color: #8b949e; font-size: 14px; margin-bottom: 24px; }
    #qr-img { width: 240px; height: 240px; border-radius: 12px; background: white; padding: 12px; margin: 0 auto 20px; display: block; }
    .status { padding: 10px 20px; border-radius: 20px; font-size: 13px; display: inline-block; margin-bottom: 16px; }
    .connecting { background: #1f2937; color: #f59e0b; border: 1px solid #f59e0b44; }
    .connected { background: #1f2937; color: #22c55e; border: 1px solid #22c55e44; }
    .waiting { background: #1f2937; color: #8b949e; border: 1px solid #30363d; }
    .steps { text-align: right; font-size: 13px; color: #8b949e; line-height: 2; }
  </style>
</head>
<body>
  <div class="card">
    <h1>📱 ربط واتساب — واصلة إكسبريس</h1>
    <p>امسح الـ QR من واتساب على هاتفك</p>
    <div id="status-badge" class="status waiting">⏳ جاري التحميل...</div>
    <br>
    <img id="qr-img" src="" alt="QR Code" style="display:none"/>
    <div id="msg" style="color:#8b949e;font-size:13px;margin:12px 0"></div>
    <div class="steps">
      <b style="color:#e6edf3">خطوات الربط:</b><br>
      1️⃣ افتح واتساب على هاتفك<br>
      2️⃣ اضغط ⋮ → الأجهزة المرتبطة<br>
      3️⃣ اضغط "ربط جهاز"<br>
      4️⃣ امسح الـ QR أعلاه
    </div>
  </div>
  <script>
    async function refresh() {
      try {
        const r = await fetch('/qr');
        const d = await r.json();
        const badge = document.getElementById('status-badge');
        const img = document.getElementById('qr-img');
        const msg = document.getElementById('msg');
        if (d.connected) {
          badge.className = 'status connected';
          badge.textContent = '✅ متصل بنجاح!';
          img.style.display = 'none';
          msg.textContent = 'واتساب متصل. يمكنك إغلاق هذه الصفحة.';
        } else if (d.qr) {
          badge.className = 'status connecting';
          badge.textContent = '📷 امسح الـ QR الآن';
          img.src = d.qr;
          img.style.display = 'block';
          msg.textContent = 'الـ QR يتجدد كل 60 ثانية';
        } else {
          badge.className = 'status waiting';
          badge.textContent = '⏳ جاري التوليد...';
          img.style.display = 'none';
          msg.textContent = d.message || '';
        }
      } catch(e) { console.error(e); }
    }
    refresh();
    setInterval(refresh, 10000);
  </script>
</body>
</html>`);
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
