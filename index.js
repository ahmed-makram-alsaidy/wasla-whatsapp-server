// ─────────────────────────────────────────────────────────
// index.js — Multi-Tenant WhatsApp API Server
// كل شركة (company_id) لها endpoints مستقلة
//
// PRODUCTION AUTHORIZATION LAW (closure phase):
//  - Every company-sensitive route requires x-api-key.
//  - Fail CLOSED: missing BAILEYS_API_KEY at boot is a fatal error.
//  - Header-only transport; ?apiKey= removed (no WASLA caller uses it).
//  - companyId must be a strict UUID everywhere (filesystem safety).
//  - /health is minimal public; detailed diagnostics behind /diag (auth).
//  - CORS is opt-in via ALLOWED_ORIGINS (server-to-server by default).
// ─────────────────────────────────────────────────────────
require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
const wa = require('./whatsapp');
const { validateCompanyId } = require('./uuid');
const { logGroupMessage, markOutboxMessage } = require('./sessionStore');
const { getStats } = require('./rateLimiter');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.BAILEYS_API_KEY;
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

if (!API_KEY) {
  console.error('FATAL: BAILEYS_API_KEY is not set. Refusing to start (fail-closed).');
  process.exit(1);
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // compare against self to burn equivalent time, then fail
    crypto.timingSafeEqual(bb, bb);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

// ── CORS: minimal, opt-in browser support only ─────────────
app.use((req, res, next) => {
  if (ALLOWED_ORIGINS.length > 0) {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  } else if (req.method === 'OPTIONS') {
    // No browser callers configured → no preflight support.
    return res.sendStatus(204);
  }
  next();
});

// ── Auth Middleware — header-only, fail-closed, timing-safe ─
function requireApiKey(req, res, next) {
  const provided = req.headers['x-api-key'];
  if (!provided || !timingSafeEqual(provided, API_KEY)) {
    return res.status(401).json({ error: 'Unauthorized — Invalid API Key' });
  }
  next();
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ── Company UUID gate — every /company/:companyId route ────
function requireValidCompanyId(req, res, next) {
  const id = validateCompanyId(req.params.companyId);
  if (!id) {
    return res.status(400).json({ error: 'companyId must be a valid UUID' });
  }
  req.companyId = id;
  next();
}

const companyRouter = express.Router({ mergeParams: true });
companyRouter.use(requireValidCompanyId);
companyRouter.use(requireApiKey);

// ══════════════════════════════════════════════════════════
// GLOBAL ROUTES
// ══════════════════════════════════════════════════════════

// GET /health — minimal public probe. No tenant data.
app.get('/health', (req, res) => {
  res.json({ ok: true, version: '2.1.0', uptime: Math.floor(process.uptime()) });
});

// GET /diag — authenticated diagnostics (sessions + limiter lanes)
app.get('/diag', requireApiKey, (req, res) => {
  res.json({
    ok: true,
    server: 'wasla-whatsapp-server',
    version: '2.1.0',
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
// All authenticated + UUID-gated.
// ══════════════════════════════════════════════════════════

// GET /company/:companyId/status
companyRouter.get('/status', (req, res) => {
  res.json(wa.getStatus(req.companyId));
});

// GET /company/:companyId/qr — QR Code كـ JSON
companyRouter.get('/qr', async (req, res) => {
  const status = wa.getStatus(req.companyId);

  if (status.status === 'connected') {
    return res.json({ connected: true, state: 'connected', status: 'connected', qr: null, qrCode: null, phoneNumber: status.phoneNumber });
  }

  const qrBase64 = wa.getQrBase64(req.companyId);
  if (!qrBase64) {
    return res.json({
      connected: false, state: status.status, status: status.status, qr: null, qrCode: null,
      message: 'QR غير متاح بعد. انتظر 15 ثانية وحاول مجدداً.',
    });
  }
  res.json({ connected: false, state: 'connecting', status: 'connecting', qr: qrBase64, qrCode: qrBase64 });
});

// GET /company/:companyId/qr-scan — صفحة HTML للمسح (operator tool, auth'd)
companyRouter.get('/qr-scan', (req, res) => {
  const companyId = req.companyId;
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
    const apiKey = new URLSearchParams(location.search.slice(1)).get('k') || '';
    async function refresh() {
      try {
        const r = await fetch('/company/' + companyId + '/qr', { headers: { 'x-api-key': apiKey } });
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
companyRouter.post('/connect', async (req, res) => {
  log(`[${req.companyId}] Connect request`);
  try {
    await wa.connect(req.companyId);
    res.json({ ok: true, message: 'جاري بدء الاتصال...', companyId: req.companyId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /company/:companyId/disconnect — قطع session
companyRouter.post('/disconnect', async (req, res) => {
  log(`[${req.companyId}] Disconnect request`);
  try {
    await wa.disconnect(req.companyId);
    res.json({ ok: true, message: 'تم قطع الاتصال', companyId: req.companyId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /company/:companyId/pairing-code
companyRouter.post('/pairing-code', async (req, res) => {
  const phoneNumber =
    req.body.phone ||
    req.body.phoneNumber ||
    req.body.number ||
    req.body.whatsapp_number;

  if (!phoneNumber) {
    return res.status(400).json({ error: 'phone number is required' });
  }

  try {
    const result = await wa.requestPairingCode(req.companyId, phoneNumber);
    res.json({ ok: true, companyId: req.companyId, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /company/:companyId/groups — جروبات الشركة
companyRouter.get('/groups', async (req, res) => {
  try {
    const groups = await wa.getGroups(req.companyId);
    res.json({ companyId: req.companyId, groups });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /company/:companyId/group-participants?group_jid=...
companyRouter.get('/group-participants', async (req, res) => {
  const groupJid = req.query.group_jid || req.query.groupJid;
  if (!groupJid) return res.status(400).json({ error: 'group_jid is required' });
  try {
    const participants = await wa.getGroupParticipants(req.companyId, String(groupJid));
    res.json({ ok: true, companyId: req.companyId, group_jid: String(groupJid), participants });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /company/:companyId/group-participants/add
// body: { group_jid, phone } — idempotent merchant add-to-group.
companyRouter.post('/group-participants/add', async (req, res) => {
  const { group_jid, phone } = req.body || {};
  if (!group_jid || !phone) {
    return res.status(400).json({ error: 'group_jid and phone are required' });
  }
  log(`[${req.companyId}] Add participant ${String(phone).slice(-4)} to ${String(group_jid).slice(0, 8)}…`);
  try {
    const result = await wa.addGroupParticipant(req.companyId, group_jid, phone);
    res.json(result.ok ? result : { ...result }, { status: result.ok ? 200 : 409 });
  } catch (err) {
    res.status(err.message.includes('غير متصل') ? 409 : 500).json({ ok: false, error: err.message });
  }
});

// POST /company/:companyId/send-group — إرسال رسالة من session الشركة
companyRouter.post('/send-group', async (req, res) => {
  const { group_jid, message, outbox_id, merchant_id, shipment_id, tracking_number, group_name } = req.body;

  if (!group_jid || !message) {
    return res.status(400).json({ error: 'group_jid و message مطلوبان' });
  }

  log(`[${req.companyId}] Sending to group ${group_jid}`);

  try {
    await wa.sendGroupMessage(req.companyId, group_jid, message);

    await logGroupMessage({
      companyId: req.companyId,
      groupJid: group_jid,
      groupName: group_name,
      merchantId: merchant_id,
      shipmentId: shipment_id,
      trackingNumber: tracking_number,
      messageText: message,
      status: 'sent',
    });

    if (outbox_id) await markOutboxMessage(outbox_id, 'sent');

    log(`[${req.companyId}] ✅ Sent to ${group_jid}`);
    res.json({ ok: true, companyId: req.companyId, group_jid });
  } catch (err) {
    log(`[${req.companyId}] ❌ Failed: ${err.message}`);

    await logGroupMessage({
      companyId: req.companyId,
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

// POST /company/:companyId/send-message — direct send (invoice DMs etc.)
companyRouter.post('/send-message', async (req, res) => {
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
    const result = await wa.sendDirectMessage(req.companyId, recipient, message);
    res.json({
      ok: true,
      companyId: req.companyId,
      to: recipient,
      messageId: result?.key?.id || null,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.use('/company/:companyId', companyRouter);

// ══════════════════════════════════════════════════════════
// LEGACY ROUTES (backward compat — بدون companyId)
// Compatibility surface for older Edge Function fallbacks ONLY.
// PLATFORM_COMPANY_ID never becomes tenant authority: every legacy
// route is authenticated and maps to one operator-designated session.
// ══════════════════════════════════════════════════════════
const DEFAULT_COMPANY = process.env.PLATFORM_COMPANY_ID || 'platform';

app.get('/status', requireApiKey, (req, res) => res.json(wa.getStatus(DEFAULT_COMPANY)));
app.get('/qr', requireApiKey, async (req, res) => {
  const status = wa.getStatus(DEFAULT_COMPANY);
  if (status.status === 'connected') return res.json({ connected: true, state: 'connected', status: 'connected', qr: null, qrCode: null, phoneNumber: status.phoneNumber });
  const qr = wa.getQrBase64(DEFAULT_COMPANY);
  res.json({ connected: false, state: qr ? 'connecting' : status.status, status: qr ? 'connecting' : status.status, qr: qr || null, qrCode: qr || null });
});
app.get('/qr-scan', requireApiKey, (req, res) => res.redirect(`/company/${DEFAULT_COMPANY}/qr-scan`));
app.get('/groups', requireApiKey, async (req, res) => {
  const groups = await wa.getGroups(DEFAULT_COMPANY);
  res.json({ groups });
});
app.post('/send-group', requireApiKey, async (req, res) => {
  const { group_jid, message, outbox_id } = req.body;
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
const server = app.listen(PORT, async () => {
  log(`🚀 Wasla WhatsApp Server v2.1 (Multi-Tenant, fail-closed) on port ${PORT}`);

  // استعد الـ sessions من الـ auth directories المحفوظة
  try {
    await wa.restoreActiveSessions();
  } catch (err) {
    log(`⚠️ Session restore error: ${err.message}`);
  }
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal} received — graceful shutdown`);
  // Stop accepting new HTTP work.
  server.close(() => log('HTTP server closed'));
  // Bounded drain window for in-flight sends; queued-but-unstarted work is
  // left unclaimed so the outbox lease law retries it safely.
  const drainMs = parseInt(process.env.SHUTDOWN_DRAIN_MS || '8000', 10);
  const timer = setTimeout(() => log('Drain window elapsed'), drainMs);
  await new Promise(r => setTimeout(r, Math.min(drainMs, 1500)));
  clearTimeout(timer);
  try {
    await wa.gracefulCloseAll();
  } catch (e) {
    log(`socket close error: ${e.message}`);
  }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Test harness hooks — active only when bound to an ephemeral port.
if (process.env.PORT === '0' && typeof server.address === 'function') {
  const setHooks = () => {
    const addr = server.address();
    if (addr && typeof addr === 'object') {
      global.__waslaTestPort = addr.port;
      global.__waslaGracefulShutdown = shutdown;
    } else {
      setTimeout(setHooks, 25);
    }
  };
  setHooks();
}
module.exports = app;
