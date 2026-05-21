// ─────────────────────────────────────────────────────────
// whatsapp.js — Baileys Connection Manager
// يدير اتصال واتساب، QR Code، وإرسال الرسائل
// ─────────────────────────────────────────────────────────
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  delay,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const { updateSessionStatus, saveQrCode, clearQrCode } = require('./sessionStore');
const { enqueue } = require('./rateLimiter');

// ── Constants ────────────────────────────────────────────
const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');
const logger = pino({ level: 'silent' });

// ── State ─────────────────────────────────────────────────
let sock = null;
let currentQrRaw = null;      // الـ QR الخام من Baileys
let currentQrBase64 = null;   // الـ QR كـ base64 image جاهز للعرض
let connectionStatus = 'disconnected';
let reconnectAttempts = 0;
const MAX_RECONNECT = 10;

/**
 * بدء الاتصال بواتساب
 */
async function connect() {
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  let version;
  try {
    const result = await fetchLatestBaileysVersion();
    version = result.version;
  } catch (e) {
    version = [2, 3000, 1023456789];
  }

  console.log(`[WhatsApp] Connecting with Baileys v${version.join('.')}`);
  connectionStatus = 'connecting';

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    browser: ['واصلة إكسبريس', 'Chrome', '120.0.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
  });

  // ── Events ─────────────────────────────────────────────

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // ── QR Code جديد ──────────────────────────────────────
    if (qr) {
      currentQrRaw = qr;
      connectionStatus = 'connecting';
      console.log('[WhatsApp] QR Code received — scan it!');

      // حوّل لـ base64 واحفظه في الذاكرة فوراً
      try {
        currentQrBase64 = await qrcode.toDataURL(qr, {
          width: 300,
          margin: 2,
          color: { dark: '#000000', light: '#ffffff' },
        });
        console.log('[WhatsApp] QR base64 ready, length:', currentQrBase64.length);
        // حاول تحفظه في Supabase (اختياري)
        saveQrCode(currentQrBase64).catch(() => {});
      } catch (e) {
        console.error('[WhatsApp] QR generate error:', e.message);
      }
    }

    // ── اتصل ──────────────────────────────────────────────
    if (connection === 'open') {
      currentQrRaw = null;
      currentQrBase64 = null;
      connectionStatus = 'connected';
      reconnectAttempts = 0;
      const phoneNumber = sock.user?.id?.split(':')[0] || null;
      console.log(`[WhatsApp] ✅ Connected! Phone: ${phoneNumber}`);
      clearQrCode(phoneNumber).catch(() => {});
    }

    // ── انقطع ─────────────────────────────────────────────
    if (connection === 'close') {
      currentQrRaw = null;
      currentQrBase64 = null;
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut && code !== 401;

      console.log(`[WhatsApp] Disconnected. Code: ${code}. Reconnect: ${shouldReconnect}`);

      if (code === DisconnectReason.loggedOut || code === 401) {
        connectionStatus = 'disconnected';
        updateSessionStatus('disconnected').catch(() => {});
        if (fs.existsSync(AUTH_DIR)) {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        }
        console.log('[WhatsApp] Logged out. Auth cleared. Will reconnect for new QR...');
        setTimeout(connect, 3000);
        return;
      }

      if (shouldReconnect && reconnectAttempts < MAX_RECONNECT) {
        reconnectAttempts++;
        connectionStatus = 'connecting';
        updateSessionStatus('connecting').catch(() => {});
        const waitMs = Math.min(reconnectAttempts * 3000, 15000);
        console.log(`[WhatsApp] Reconnecting in ${waitMs / 1000}s (attempt ${reconnectAttempts})...`);
        setTimeout(connect, waitMs);
      } else {
        connectionStatus = 'disconnected';
        updateSessionStatus('disconnected').catch(() => {});
      }
    }
  });

  // حفظ بيانات الـ session
  sock.ev.on('creds.update', saveCreds);
}

/**
 * إرسال رسالة نصية لجروب
 */
async function sendGroupMessage(groupJid, text) {
  if (!sock || connectionStatus !== 'connected') {
    throw new Error('WhatsApp غير متصل. من فضلك امسح الـ QR Code أولاً.');
  }

  if (!groupJid.endsWith('@g.us')) {
    throw new Error(`group_jid غير صحيح: ${groupJid} (يجب أن ينتهي بـ @g.us)`);
  }

  return enqueue(async () => {
    try {
      await sock.sendPresenceUpdate('composing', groupJid);
      await delay(800 + Math.random() * 700);
    } catch (_) {}

    const result = await sock.sendMessage(groupJid, { text });

    try {
      await sock.sendPresenceUpdate('paused', groupJid);
    } catch (_) {}

    return result;
  });
}

/**
 * جلب قائمة الجروبات المشترك فيها
 */
async function getGroups() {
  if (!sock || connectionStatus !== 'connected') return [];
  try {
    const groups = await sock.groupFetchAllParticipating();
    return Object.entries(groups).map(([jid, meta]) => ({
      jid,
      subject: meta.subject,
      participantsCount: meta.participants?.length || 0,
    }));
  } catch (e) {
    console.error('[WhatsApp] getGroups error:', e.message);
    return [];
  }
}

/**
 * قطع الاتصال بشكل نظيف
 */
async function disconnect() {
  if (sock) {
    try { await sock.logout(); } catch (_) {}
    sock = null;
    connectionStatus = 'disconnected';
    currentQrRaw = null;
    currentQrBase64 = null;
    updateSessionStatus('disconnected').catch(() => {});
  }
}

/**
 * الحالة الحالية
 */
function getStatus() {
  return {
    status: connectionStatus,
    hasQr: currentQrBase64 !== null,
    reconnectAttempts,
  };
}

/**
 * QR Code الحالي كـ base64 — محفوظ مسبقاً في الذاكرة
 */
async function getQrBase64() {
  return currentQrBase64;
}

module.exports = {
  connect,
  sendGroupMessage,
  getGroups,
  disconnect,
  getStatus,
  getCurrentQrBase64: getQrBase64,
};
