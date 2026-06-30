// ─────────────────────────────────────────────────────────
// whatsapp.js — Multi-Session Baileys Manager
// كل شركة (company_id) عندها session مستقلة
// ─────────────────────────────────────────────────────────
const {
  default: makeWASocket,
  Browsers,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  delay,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const { updateCompanySessionStatus, saveCompanyQrCode, clearCompanyQrCode, logGroupMessage, markOutboxMessage } = require('./sessionStore');
const { enqueue } = require('./rateLimiter');

const logger = pino({ level: 'silent' });
const BASE_AUTH_DIR = path.join(__dirname, 'auth_sessions');
const MAX_RECONNECT = 10;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Sessions Map ─────────────────────────────────────────
// key: companyId, value: SessionState
const sessions = new Map();

function getSessionState(companyId) {
  if (!sessions.has(companyId)) {
    sessions.set(companyId, {
      sock: null,
      status: 'disconnected',  // disconnected | connecting | connected
      qrBase64: null,
      phoneNumber: null,
      reconnectAttempts: 0,
    });
  }
  return sessions.get(companyId);
}

function getAuthDir(companyId) {
  const dir = path.join(BASE_AUTH_DIR, companyId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function normalizePhoneNumber(value) {
  let digits = String(value || '').replace(/[^\d]/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0')) digits = `2${digits}`;
  if (!digits) throw new Error('phone number is required');
  return digits;
}

// ─────────────────────────────────────────────────────────
// connect — بدء session لشركة معينة
// ─────────────────────────────────────────────────────────
async function connect(companyId) {
  const authDir = getAuthDir(companyId);
  const state = getSessionState(companyId);

  // لو متصل بالفعل
  if (state.status === 'connected' && state.sock) {
    console.log(`[WA:${companyId}] Already connected.`);
    return;
  }

  const { state: authState, saveCreds } = await useMultiFileAuthState(authDir);

  let version;
  try {
    const result = await fetchLatestBaileysVersion();
    version = result.version;
  } catch {
    version = [2, 3000, 1023456789];
  }

  console.log(`[WA:${companyId}] Connecting with Baileys v${version.join('.')}`);
  state.status = 'connecting';

  const sock = makeWASocket({
    version,
    auth: authState,
    logger,
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
  });

  state.sock = sock;
  sessions.set(companyId, state);

  // ── Events ──────────────────────────────────────────────
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    const s = getSessionState(companyId);

    // ── QR Code ─────────────────────────────────────────
    if (qr) {
      s.status = 'connecting';
      s.reconnectAttempts = 0;
      console.log(`[WA:${companyId}] QR received`);
      try {
        s.qrBase64 = await qrcode.toDataURL(qr, {
          width: 300, margin: 2,
          color: { dark: '#000000', light: '#ffffff' },
        });
        saveCompanyQrCode(companyId, s.qrBase64).catch(() => {});
      } catch (e) {
        console.error(`[WA:${companyId}] QR error:`, e.message);
      }
    }

    // ── Connected ────────────────────────────────────────
    if (connection === 'open') {
      s.qrBase64 = null;
      s.status = 'connected';
      s.reconnectAttempts = 0;
      s.phoneNumber = sock.user?.id?.split(':')[0] || null;
      console.log(`[WA:${companyId}] ✅ Connected! Phone: ${s.phoneNumber}`);
      clearCompanyQrCode(companyId, s.phoneNumber).catch(() => {});
      updateCompanySessionStatus(companyId, 'connected', s.phoneNumber).catch(() => {});
    }

    // ── Disconnected ─────────────────────────────────────
    if (connection === 'close') {
      s.qrBase64 = null;
      const code = lastDisconnect?.error?.output?.statusCode;
      const restartRequired = code === DisconnectReason.restartRequired;
      const qrTimedOut = code === DisconnectReason.timedOut && s.status === 'connecting';
      const resetSession =
        code === DisconnectReason.loggedOut ||
        code === DisconnectReason.badSession ||
        code === DisconnectReason.multideviceMismatch ||
        code === 401 ||
        code === 500 ||
        code === 411;

      console.log(`[WA:${companyId}] Disconnected. Code: ${code}`);

      if (restartRequired) {
        s.status = 'connecting';
        s.sock = null;
        s.reconnectAttempts = 0;
        updateCompanySessionStatus(companyId, 'connecting', null).catch(() => {});
        console.log(`[WA:${companyId}] Restart required after pairing. Reconnecting now...`);
        setTimeout(() => connect(companyId), 1000);
        return;
      }

      if (qrTimedOut) {
        s.status = 'connecting';
        s.sock = null;
        s.reconnectAttempts = 0;
        updateCompanySessionStatus(companyId, 'connecting', null).catch(() => {});
        console.log(`[WA:${companyId}] QR timed out. Regenerating QR...`);
        setTimeout(() => connect(companyId), 1500);
        return;
      }

      if (resetSession) {
        s.status = 'disconnected';
        s.phoneNumber = null;
        s.sock = null;
        updateCompanySessionStatus(companyId, 'disconnected', null).catch(() => {});
        // امسح الـ auth عشان يطلب QR جديد
        const authDir = getAuthDir(companyId);
        if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
        console.log(`[WA:${companyId}] Session reset. Auth cleared.`);
        setTimeout(() => connect(companyId), 3000);
        return;
      }

      if (s.reconnectAttempts < MAX_RECONNECT) {
        s.reconnectAttempts++;
        s.status = 'connecting';
        updateCompanySessionStatus(companyId, 'connecting', null).catch(() => {});
        const waitMs = Math.min(s.reconnectAttempts * 3000, 15000);
        console.log(`[WA:${companyId}] Reconnecting in ${waitMs / 1000}s...`);
        setTimeout(() => connect(companyId), waitMs);
      } else {
        s.status = 'disconnected';
        s.sock = null;
        updateCompanySessionStatus(companyId, 'disconnected', null).catch(() => {});
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

// ─────────────────────────────────────────────────────────
// disconnect — قطع session شركة
// ─────────────────────────────────────────────────────────
async function disconnect(companyId) {
  const s = getSessionState(companyId);
  if (s.sock) {
    try { await s.sock.logout(); } catch (_) {}
    s.sock = null;
  }
  s.status = 'disconnected';
  s.qrBase64 = null;
  s.phoneNumber = null;
  s.reconnectAttempts = 0;
  updateCompanySessionStatus(companyId, 'disconnected', null).catch(() => {});
  console.log(`[WA:${companyId}] Disconnected.`);
}

async function requestPairingCode(companyId, phoneNumber) {
  const normalizedPhone = normalizePhoneNumber(phoneNumber);
  let s = getSessionState(companyId);

  if (s.status === 'connected') {
    throw new Error(`WhatsApp company ${companyId} is already connected.`);
  }

  if (!s.sock) {
    await connect(companyId);
  }

  for (let i = 0; i < 20; i++) {
    s = getSessionState(companyId);
    if (s.sock) break;
    await sleep(500);
  }

  if (!s.sock) {
    throw new Error('WhatsApp socket is not ready yet. Try again in a few seconds.');
  }

  const code = await s.sock.requestPairingCode(normalizedPhone);
  console.log(`[WA:${companyId}] Pairing code requested for ${normalizedPhone}`);
  return { code, phoneNumber: normalizedPhone };
}

// ─────────────────────────────────────────────────────────
// getStatus — حالة session شركة
// ─────────────────────────────────────────────────────────
function getStatus(companyId) {
  const s = getSessionState(companyId);
  return {
    companyId,
    status: s.status,
    hasQr: s.qrBase64 !== null,
    phoneNumber: s.phoneNumber,
    reconnectAttempts: s.reconnectAttempts,
  };
}

// ─────────────────────────────────────────────────────────
// getQrBase64 — QR Code لشركة معينة
// ─────────────────────────────────────────────────────────
function getQrBase64(companyId) {
  return getSessionState(companyId).qrBase64;
}

// ─────────────────────────────────────────────────────────
// getGroups — جروبات شركة معينة
// ─────────────────────────────────────────────────────────
async function getGroups(companyId) {
  const s = getSessionState(companyId);
  if (!s.sock || s.status !== 'connected') return [];
  try {
    const groups = await s.sock.groupFetchAllParticipating();
    return Object.entries(groups).map(([jid, meta]) => ({
      jid,
      subject: meta.subject,
      participantsCount: meta.participants?.length || 0,
    }));
  } catch (e) {
    console.error(`[WA:${companyId}] getGroups error:`, e.message);
    return [];
  }
}

// ─────────────────────────────────────────────────────────
// sendGroupMessage — إرسال رسالة من session شركة معينة
// ─────────────────────────────────────────────────────────
async function sendGroupMessage(companyId, groupJid, text) {
  const s = getSessionState(companyId);

  if (!s.sock || s.status !== 'connected') {
    throw new Error(`واتساب شركة ${companyId} غير متصل. من فضلك امسح الـ QR أولاً.`);
  }

  if (!groupJid.endsWith('@g.us')) {
    throw new Error(`group_jid غير صحيح: ${groupJid}`);
  }

  return enqueue(async () => {
    try {
      await s.sock.sendPresenceUpdate('composing', groupJid);
      await delay(800 + Math.random() * 700);
    } catch (_) {}

    const result = await s.sock.sendMessage(groupJid, { text });

    try {
      await s.sock.sendPresenceUpdate('paused', groupJid);
    } catch (_) {}

    return result;
  });
}

// ─────────────────────────────────────────────────────────
// getAllSessionsStatus — قائمة كل الـ sessions
// ─────────────────────────────────────────────────────────
function normalizeDirectJid(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('recipient phone is required');
  if (raw.endsWith('@g.us')) throw new Error('group JID is not valid for direct messages');
  if (raw.endsWith('@s.whatsapp.net')) return raw;

  let digits = raw.replace(/[^\d]/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0')) digits = `2${digits}`;
  if (!digits) throw new Error(`invalid recipient phone: ${value}`);

  return `${digits}@s.whatsapp.net`;
}

async function sendDirectMessage(companyId, recipient, text) {
  const s = getSessionState(companyId);

  if (!s.sock || s.status !== 'connected') {
    throw new Error(`WhatsApp company ${companyId} is not connected. Scan the QR code first.`);
  }

  const message = String(text || '').trim();
  if (!message) throw new Error('message is required');

  const jid = normalizeDirectJid(recipient);

  return enqueue(async () => {
    try {
      await s.sock.sendPresenceUpdate('composing', jid);
      await delay(500 + Math.random() * 500);
    } catch (_) {}

    const result = await s.sock.sendMessage(jid, { text: message });

    try {
      await s.sock.sendPresenceUpdate('paused', jid);
    } catch (_) {}

    return result;
  });
}

function getAllSessionsStatus() {
  const result = [];
  for (const [companyId] of sessions) {
    result.push(getStatus(companyId));
  }
  return result;
}

// ─────────────────────────────────────────────────────────
// restoreActiveSessions — استعادة sessions محفوظة عند بدء السيرفر
// ─────────────────────────────────────────────────────────
async function restoreActiveSessions() {
  if (!fs.existsSync(BASE_AUTH_DIR)) return;
  const companies = fs.readdirSync(BASE_AUTH_DIR);
  console.log(`[WA] Restoring ${companies.length} sessions...`);
  for (const companyId of companies) {
    const authDir = path.join(BASE_AUTH_DIR, companyId);
    if (fs.statSync(authDir).isDirectory()) {
      console.log(`[WA] Restoring session for: ${companyId}`);
      connect(companyId).catch(e => console.error(`[WA:${companyId}] Restore error:`, e.message));
    }
  }
}

module.exports = {
  connect,
  disconnect,
  requestPairingCode,
  getStatus,
  getQrBase64,
  getGroups,
  sendGroupMessage,
  sendDirectMessage,
  getAllSessionsStatus,
  restoreActiveSessions,
  // Legacy exports (single session → default company)
  logGroupMessage,
  markOutboxMessage,
};
