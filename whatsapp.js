// ─────────────────────────────────────────────────────────
// whatsapp.js — Multi-Session Baileys Manager
// كل شركة (company_id) عندها session مستقلة
//
// Closure hardening:
//  - AUTH_SESSIONS_DIR configurable; every company dir resolved and asserted
//    to remain a child of the base dir (defense in depth behind UUID law).
//  - Auth wipe ONLY on evidence of invalid credentials (loggedOut /
//    badSession / multideviceMismatch / 401). Transient provider errors such
//    as 500/411/timeouts are retried WITHOUT destroying valid sessions.
//  - restoreActiveSessions runs sequentially with jitter (no connect storm).
//  - graceful close for shutdown.
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
const { validateCompanyId } = require('./uuid');
const { updateCompanySessionStatus, saveCompanyQrCode, clearCompanyQrCode, logGroupMessage, markOutboxMessage } = require('./sessionStore');
const { enqueue } = require('./rateLimiter');

const logger = pino({ level: 'silent' });
const BASE_AUTH_DIR = process.env.AUTH_SESSIONS_DIR
  ? path.resolve(process.env.AUTH_SESSIONS_DIR)
  : path.join(__dirname, 'auth_sessions');
const MAX_RECONNECT = 10;
const RESTORE_JITTER_MS = parseInt(process.env.RESTORE_JITTER_MS || '1500', 10);

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
  const id = validateCompanyId(companyId);
  if (!id) {
    throw new Error('invalid companyId: expected UUID');
  }
  const dir = path.join(BASE_AUTH_DIR, id);
  const resolved = path.resolve(dir);
  // Defense in depth: resolved dir must stay inside BASE_AUTH_DIR.
  if (resolved !== BASE_AUTH_DIR && !resolved.startsWith(BASE_AUTH_DIR + path.sep)) {
    throw new Error('invalid companyId: escaped auth root');
  }
  if (!fs.existsSync(resolved)) fs.mkdirSync(resolved, { recursive: true });
  return resolved;
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
      // Wipe only on credential-invalidating evidence. Provider/transient
      // failures (500/411/etc.) must NOT destroy a linked session.
      const resetSession =
        code === DisconnectReason.loggedOut ||
        code === DisconnectReason.badSession ||
        code === DisconnectReason.multideviceMismatch ||
        code === 401;

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
// Group membership helpers (merchant add-to-group closure)
// ─────────────────────────────────────────────────────────

/**
 * Returns metadata.participants array for a group owned by this session.
 * Each entry: { id: 'phone@s.whatsapp.net', admin?: string|null, ... }
 */
async function getGroupParticipants(companyId, groupJid) {
  const s = getSessionState(companyId);
  if (!s.sock || s.status !== 'connected') {
    throw new Error(`WhatsApp company ${companyId} is not connected.`);
  }
  assertGroupJid(groupJid);
  const meta = await s.sock.groupMetadata(groupJid);
  return (meta.participants || []).map(p => ({
    id: p.id,
    isAdmin: !!p.admin,
  }));
}

function assertGroupJid(groupJid) {
  const raw = String(groupJid || '').trim();
  if (!/^\d+@g\.us$/.test(raw)) {
    throw new Error(`group_jid غير صحيح: ${raw}`);
  }
  return raw;
}

/**
 * Idempotently add one participant to a group via this company's session.
 * Returns a truthful outcome instead of throwing for expected states.
 */
async function addGroupParticipant(companyId, groupJid, phone) {
  const s = getSessionState(companyId);
  if (!s.sock || s.status !== 'connected') {
    throw new Error(`واتساب شركة ${companyId} غير متصل. من فضلك امسح الـ QR أولاً.`);
  }

  const jid = assertGroupJid(groupJid);
  const digits = normalizePhoneNumber(phone);
  const userJid = `${digits}@s.whatsapp.net`;

  // Already a participant? → idempotent success without touching WhatsApp.
  try {
    const participants = await getGroupParticipants(companyId, jid);
    if (participants.some(p => p.id === userJid)) {
      return { ok: true, result: 'already_participant', userJid, groupJid: jid };
    }
  } catch (e) {
    // Metadata failure must not be hidden as "added".
    return {
      ok: false,
      result: 'metadata_unavailable',
      error: e.message,
      userJid,
      groupJid: jid,
    };
  }

  try {
    const res = await s.sock.groupParticipantsUpdate(jid, [userJid], 'add');
    const first = Array.isArray(res) ? res[0] : null;
    // Baileys returns per-participant status objects:
    // { key: { user }, status: '200' | '403' | '408' | '409' | ... , message? }
    const status = String(first?.status ?? '');

    if (status === '200') {
      return { ok: true, result: 'added', userJid, groupJid: jid };
    }
    if (status === '302' || status === '409' || status === '500') {
      // 302: participant privacy requires invite; treat as pending invite sent
      // 409: conflict / already in group per server view
      // 500: server accepted but not confirmed
      return {
        ok: false,
        result: status === '409' ? 'already_participant' : 'invite_pending',
        baileysStatus: status,
        message: first?.message?.attrs?.add_reason || first?.message || null,
        userJid,
        groupJid: jid,
      };
    }
    if (status === '403') {
      // Bot lacks admin rights or blocked — actionable for staff UI.
      return {
        ok: false,
        result: 'bot_not_admin_or_blocked',
        baileysStatus: status,
        message: typeof first?.message === 'string'
          ? first.message
          : (first?.message?.attrs?.add_reason || null),
        userJid,
        groupJid: jid,
      };
    }
    if (status === '404') {
      return { ok: false, result: 'phone_not_on_whatsapp', baileysStatus: status, userJid, groupJid: jid };
    }
    if (status === '408') {
      return { ok: false, result: 'invite_sent_awaiting_accept', baileysStatus: status, userJid, groupJid: jid };
    }
    return { ok: false, result: 'unknown_status', baileysStatus: status || null, userJid, groupJid: jid };
  } catch (e) {
    return { ok: false, result: 'error', error: e.message, userJid, groupJid: jid };
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

  const jid = assertGroupJid(groupJid);

  return enqueue(companyId, async () => {
    try {
      await s.sock.sendPresenceUpdate('composing', jid);
      await delay(800 + Math.random() * 700);
    } catch (_) {}

    const result = await s.sock.sendMessage(jid, { text });

    try {
      await s.sock.sendPresenceUpdate('paused', jid);
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

  return enqueue(companyId, async () => {
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
// Sequential + jitter to avoid a connection storm on boot.
// ─────────────────────────────────────────────────────────
async function restoreActiveSessions() {
  if (!fs.existsSync(BASE_AUTH_DIR)) return;
  const companies = fs.readdirSync(BASE_AUTH_DIR);
  console.log(`[WA] Restoring ${companies.length} sessions sequentially...`);
  let restored = 0;
  for (const companyId of companies) {
    const authDir = path.join(BASE_AUTH_DIR, companyId);
    if (fs.statSync(authDir).isDirectory()) {
      console.log(`[WA] Restoring session for: ${companyId}`);
      try {
        await connect(companyId);
        restored++;
      } catch (e) {
        console.error(`[WA:${companyId}] Restore error:`, e.message);
      }
      const jitter = Math.floor(Math.random() * RESTORE_JITTER_MS);
      await sleep(jitter);
    }
  }
  console.log(`[WA] Restore complete: ${restored}/${companies.length}`);
}

// ─────────────────────────────────────────────────────────
// gracefulCloseAll — stop sending, end sockets without logout.
// Preserves auth material so restart re-links silently.
// ─────────────────────────────────────────────────────────
async function gracefulCloseAll() {
  for (const [, s] of sessions) {
    if (s.sock) {
      try { s.sock.ev.removeAllListeners('connection.update'); } catch (_) {}
      try { s.sock.end(undefined); } catch (_) {}
      s.sock = null;
    }
    s.status = 'disconnected';
  }
}

module.exports = {
  connect,
  disconnect,
  requestPairingCode,
  getStatus,
  getQrBase64,
  getGroups,
  getGroupParticipants,
  addGroupParticipant,
  sendGroupMessage,
  sendDirectMessage,
  getAllSessionsStatus,
  restoreActiveSessions,
  gracefulCloseAll,
  validateCompanyId,
  BASE_AUTH_DIR,
  // Legacy exports (single session → default company)
  logGroupMessage,
  markOutboxMessage,
};
