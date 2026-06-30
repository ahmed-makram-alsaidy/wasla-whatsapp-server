// ─────────────────────────────────────────────────────────
// index.js — Multi-Tenant WhatsApp API Server
// كل شركة (company_id) لها endpoints مستقلة
// ─────────────────────────────────────────────────────────
require('dotenv').config();

const express = require('express');
const wa = require('./whatsapp');
const { logGroupMessage, markOutboxMessage } = require('./sessionStore');
const { getStats } = require('./rateLimiter');

const app = express();
app.use(express.json());

// ── CORS — اسمح لأي origin يكلم السيرفر ───────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.BAILEYS_API_KEY;

// ── Auth Middleware ────────────────────────────────────────
function requireApiKey(req, res, next) {
  if (!API_KEY) return next();
  const provided = req.headers['x-api-key'] || req.query.apiKey;
  if (provided !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized — Invalid API Key' });
  }
  next();
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ══════════════════════════════════════════════════════════
// GLOBAL ROUTES
// ══════════════════════════════════════════════════════════

// GET /health — صحة السيرفر
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    server: 'wasla-whatsapp-server',
    version: '2.0.0',
    mode: 'multi-tenant',
    sessions: wa.getAllSessionsStatus(),
    rateLimiter: getStats(),
    uptime: Math.floor(process.uptime()),
  });
});

// GET /sessions — كل الـ sessions النشطة
app.get('/sessions', requireApiKey, (req, res) => {
  res.json({ sessions: wa.getAllSessionsStatus() });
});

// ══════════════════════════════════════════════════════════
// PER-COMPANY ROUTES  /company/:companyId/...
// ══════════════════════════════════════════════════════════

// GET /company/:companyId/status
app.get('/company/:companyId/status', (req, res) => {
  const { companyId } = req.params;
  res.json(wa.getStatus(companyId));
});

// GET /company/:companyId/qr — QR Code كـ JSON
app.get('/company/:companyId/qr', async (req, res) => {
  const { companyId } = req.params;
  const status = wa.getStatus(companyId);

  if (status.status === 'connected') {
    return res.json({ connected: true, state: 'connected', status: 'connected', qr: null, qrCode: null, phoneNumber: status.phoneNumber });
  }

  const qrBase64 = wa.getQrBase64(companyId);
  if (!qrBase64) {
    return res.json({
      connected: false, state: status.status, status: status.status, qr: null, qrCode: null,
      message: 'QR غير متاح بعد. انتظر 15 ثانية وحاول مجدداً.',
    });
  }
  res.json({ connected: false, state: 'connecting', status: 'connecting', qr: qrBase64, qrCode: qrBase64 });
});

// GET /company/:companyId/qr-scan — صفحة HTML للمسح
app.get('/company/:companyId/qr-scan', (req, res) => {
  const { companyId } = req.params;
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
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 16px; padding: 40px; text-align: center; max-width: 440px; width: 90%; }
    h1 { font-size: 20px; margin-bottom: 6px; color: #58a6ff; }
    .company { font-size: 12px; color: #8b949e; margin-bottom: 20px; background: #21262d; padding: 4px 12px; border-radius: 20px; display: inline-block; }
    #qr-img { width: 240px; height: 240px; border-radius: 12px; background: white; padding: 12px; margin: 0 auto 20px; display: block; }
    .status { padding: 10px 20px; border-radius: 20px; font-size: 13px; display: inline-block; margin-bottom: 16px; }
    .connecting { background: #1f2937; color: #f59e0b; border: 1px solid #f59e0b44; }
    .connected { background: #1f2937; color: #22c55e; border: 1px solid #22c55e44; }
    .waiting { background: #1f2937; color: #8b949e; border: 1px solid #30363d; }
    .steps { text-align: right; font-size: 13px; color: #8b949e; line-height: 2; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>📱 ربط واتساب — واصلة إكسبريس</h1>
    <div class="company">Company ID: ${companyId}</div>
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
    const companyId = '${companyId}';
    async function refresh() {
      try {
        const r = await fetch('/company/' + companyId + '/qr');
        const d = await r.json();
        const badge = document.getElementById('status-badge');
        const img = document.getElementById('qr-img');
        const msg = document.getElementById('msg');
        if (d.connected) {
          badge.className = 'status connected';
          badge.textContent = '✅ متصل بنجاح! رقم: ' + (d.phoneNumber || '');
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

// POST /company/:companyId/connect — بدء session
app.post('/company/:companyId/connect', async (req, res) => {
  const { companyId } = req.params;
  log(`[${companyId}] Connect request`);
  try {
    await wa.connect(companyId);
    res.json({ ok: true, message: 'جاري بدء الاتصال...', companyId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /company/:companyId/disconnect — قطع session
app.post('/company/:companyId/disconnect', async (req, res) => {
  const { companyId } = req.params;
  log(`[${companyId}] Disconnect request`);
  try {
    await wa.disconnect(companyId);
    res.json({ ok: true, message: 'تم قطع الاتصال', companyId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /company/:companyId/groups — جروبات الشركة
app.post('/company/:companyId/pairing-code', requireApiKey, async (req, res) => {
  const { companyId } = req.params;
  const phoneNumber =
    req.body.phone ||
    req.body.phoneNumber ||
    req.body.number ||
    req.body.whatsapp_number ||
    req.query.phone;

  if (!phoneNumber) {
    return res.status(400).json({ error: 'phone number is required' });
  }

  try {
    const result = await wa.requestPairingCode(companyId, phoneNumber);
    res.json({ ok: true, companyId, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/company/:companyId/groups', async (req, res) => {
  const { companyId } = req.params;
  try {
    const groups = await wa.getGroups(companyId);
    res.json({ companyId, groups });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /company/:companyId/send-group — إرسال رسالة من session الشركة
app.post('/company/:companyId/send-group', requireApiKey, async (req, res) => {
  const { companyId } = req.params;
  const { group_jid, message, outbox_id, merchant_id, shipment_id, tracking_number, group_name } = req.body;

  if (!group_jid || !message) {
    return res.status(400).json({ error: 'group_jid و message مطلوبان' });
  }

  log(`[${companyId}] Sending to group ${group_jid}`);

  try {
    await wa.sendGroupMessage(companyId, group_jid, message);

    await logGroupMessage({
      companyId,
      groupJid: group_jid,
      groupName: group_name,
      merchantId: merchant_id,
      shipmentId: shipment_id,
      trackingNumber: tracking_number,
      messageText: message,
      status: 'sent',
    });

    if (outbox_id) await markOutboxMessage(outbox_id, 'sent');

    log(`[${companyId}] ✅ Sent to ${group_jid}`);
    res.json({ ok: true, companyId, group_jid });
  } catch (err) {
    log(`[${companyId}] ❌ Failed: ${err.message}`);

    await logGroupMessage({
      companyId,
      groupJid: group_jid,
      groupName: group_name,
      merchantId: merchant_id,
      shipmentId: shipment_id,
      trackingNumber: tracking_number,
      messageText: message,
      status: 'failed',
      errorText: err.message,
    });

    if (outbox_id) await markOutboxMessage(outbox_id, 'failed', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════
// LEGACY ROUTES (backward compat — بدون companyId)
// للـ Edge Functions القديمة — بيستخدموا PLATFORM_COMPANY_ID
// ══════════════════════════════════════════════════════════
app.post('/company/:companyId/send-message', requireApiKey, async (req, res) => {
  const { companyId } = req.params;
  const recipient =
    req.body.to ||
    req.body.phone ||
    req.body.number ||
    req.body.recipient_phone ||
    req.body.recipient ||
    req.body.whatsapp_number;
  const message = req.body.message || req.body.text || req.body.body;

  if (!recipient || !message) {
    return res.status(400).json({ error: 'recipient and message are required' });
  }

  try {
    const result = await wa.sendDirectMessage(companyId, recipient, message);
    res.json({
      ok: true,
      companyId,
      to: recipient,
      messageId: result?.key?.id || null,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

const DEFAULT_COMPANY = process.env.PLATFORM_COMPANY_ID || 'platform';

app.get('/status', (req, res) => res.json(wa.getStatus(DEFAULT_COMPANY)));
app.get('/qr', async (req, res) => {
  const status = wa.getStatus(DEFAULT_COMPANY);
  if (status.status === 'connected') return res.json({ connected: true, state: 'connected', status: 'connected', qr: null, qrCode: null, phoneNumber: status.phoneNumber });
  const qr = wa.getQrBase64(DEFAULT_COMPANY);
  res.json({ connected: false, state: qr ? 'connecting' : status.status, status: qr ? 'connecting' : status.status, qr: qr || null, qrCode: qr || null });
});
app.get('/qr-scan', (req, res) => res.redirect(`/company/${DEFAULT_COMPANY}/qr-scan`));
app.get('/groups', requireApiKey, async (req, res) => {
  const groups = await wa.getGroups(DEFAULT_COMPANY);
  res.json({ groups });
});
app.post('/send-group', requireApiKey, async (req, res) => {
  req.params = { companyId: DEFAULT_COMPANY };
  // Re-route to per-company handler
  const { group_jid, message, outbox_id, merchant_id, shipment_id, tracking_number, group_name } = req.body;
  if (!group_jid || !message) return res.status(400).json({ error: 'group_jid و message مطلوبان' });
  try {
    await wa.sendGroupMessage(DEFAULT_COMPANY, group_jid, message);
    if (outbox_id) await markOutboxMessage(outbox_id, 'sent');
    res.json({ ok: true, group_jid });
  } catch (err) {
    if (outbox_id) await markOutboxMessage(outbox_id, 'failed', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.post('/send-message', requireApiKey, async (req, res) => {
  const recipient =
    req.body.to ||
    req.body.phone ||
    req.body.number ||
    req.body.recipient_phone ||
    req.body.recipient ||
    req.body.whatsapp_number;
  const message = req.body.message || req.body.text || req.body.body;

  if (!recipient || !message) {
    return res.status(400).json({ error: 'recipient and message are required' });
  }

  try {
    const result = await wa.sendDirectMessage(DEFAULT_COMPANY, recipient, message);
    res.json({
      ok: true,
      to: recipient,
      messageId: result?.key?.id || null,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.post('/disconnect', requireApiKey, async (req, res) => {
  await wa.disconnect(DEFAULT_COMPANY);
  res.json({ ok: true });
});
app.post('/reconnect', requireApiKey, async (req, res) => {
  await wa.connect(DEFAULT_COMPANY);
  res.json({ ok: true });
});

// ── 404 ───────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

// ── Start ─────────────────────────────────────────────────
app.listen(PORT, async () => {
  log(`🚀 Wasla WhatsApp Server v2.0 (Multi-Tenant) running on port ${PORT}`);

  // استعد الـ sessions من الـ auth directories المحفوظة
  try {
    await wa.restoreActiveSessions();
  } catch (err) {
    log(`⚠️ Session restore error: ${err.message}`);
  }
});

process.on('SIGTERM', async () => {
  log('SIGTERM received — shutting down gracefully');
  process.exit(0);
});
