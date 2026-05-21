// ─────────────────────────────────────────────────────────
// whatsapp.js — Baileys Connection Manager
// يدير اتصال واتساب، QR Code، وإرسال الرسائل
// ─────────────────────────────────────────────────────────
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeInMemoryStore,
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
const SESSION_NAME = process.env.SESSION_NAME || 'wasla_main';
const logger = pino({ level: 'silent' }); // Baileys internal logs silent

// ── State ─────────────────────────────────────────────────
let sock = null;
let currentQr = null;
let connectionStatus = 'disconnected'; // connecting | connected | disconnected | banned
let reconnectAttempts = 0;
const MAX_RECONNECT = 5;

// Store يحتفظ بالـ cache في الذاكرة
const store = makeInMemoryStore({ logger });

/**
 * بدء الاتصال بواتساب
 */
async function connect() {
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  console.log(`[WhatsApp] Connecting with Baileys v${version.join('.')}`);

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: true,
    browser: ['واصلة إكسبريس', 'Chrome', '120.0.0'],
    markOnlineOnConnect: false, // لا نظهر online دايماً (anti-ban)
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
  });

  store.bind(sock.ev);

  // ── Events ─────────────────────────────────────────────

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // QR Code جديد
    if (qr) {
      currentQr = qr;
      connectionStatus = 'connecting';
      console.log('[WhatsApp] QR Code received — scan it!');

      try {
        const qrBase64 = await qrcode.toDataURL(qr, { width: 300 });
        await saveQrCode(qrBase64);
      } catch (e) {
        console.error('[WhatsApp] QR to base64 failed:', e.message);
      }
    }

    // اتصل
    if (connection === 'open') {
      currentQr = null;
      connectionStatus = 'connected';
      reconnectAttempts = 0;
      const phoneNumber = sock.user?.id?.split(':')[0] || null;
      console.log(`[WhatsApp] ✅ Connected! Phone: ${phoneNumber}`);
      await clearQrCode(phoneNumber);
    }

    // انقطع
    if (connection === 'close') {
      currentQr = null;
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut && code !== 401;

      console.log(`[WhatsApp] Disconnected. Code: ${code}. Reconnect: ${shouldReconnect}`);

      if (code === DisconnectReason.loggedOut || code === 401) {
        connectionStatus = 'disconnected';
        await updateSessionStatus('disconnected');
        // امسح الـ auth للسماح بـ QR جديد
        if (fs.existsSync(AUTH_DIR)) {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        }
        console.log('[WhatsApp] Logged out. Auth cleared. Scan QR again.');
        return;
      }

      if (shouldReconnect && reconnectAttempts < MAX_RECONNECT) {
        reconnectAttempts++;
        connectionStatus = 'connecting';
        await updateSessionStatus('connecting');
        const waitMs = Math.min(reconnectAttempts * 5000, 30000);
        console.log(`[WhatsApp] Reconnecting in ${waitMs / 1000}s (attempt ${reconnectAttempts})...`);
        setTimeout(connect, waitMs);
      } else {
        connectionStatus = 'disconnected';
        await updateSessionStatus('disconnected');
      }
    }
  });

  // حفظ بيانات الـ session
  sock.ev.on('creds.update', saveCreds);
}

/**
 * إرسال رسالة نصية لجروب
 * @param {string} groupJid - معرف الجروب مثل 120363xxx@g.us
 * @param {string} text     - نص الرسالة
 */
async function sendGroupMessage(groupJid, text) {
  if (!sock || connectionStatus !== 'connected') {
    throw new Error('WhatsApp غير متصل. من فضلك امسح الـ QR Code أولاً.');
  }

  if (!groupJid.endsWith('@g.us')) {
    throw new Error(`group_jid غير صحيح: ${groupJid} (يجب أن ينتهي بـ @g.us)`);
  }

  // استخدام queue للـ rate limiting
  return enqueue(async () => {
    // typing indicator للإيحاء بسلوك بشري
    try {
      await sock.sendPresenceUpdate('composing', groupJid);
      await delay(800 + Math.random() * 700);
    } catch (_) {
      // تجاهل لو الجروب ما عندوش هذه الخاصية
    }

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
  if (!sock || connectionStatus !== 'connected') {
    return [];
  }

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
    await sock.logout();
    sock = null;
    connectionStatus = 'disconnected';
    currentQr = null;
    await updateSessionStatus('disconnected');
  }
}

/**
 * الحالة الحالية
 */
function getStatus() {
  return {
    status: connectionStatus,
    hasQr: currentQr !== null,
    reconnectAttempts,
  };
}

/**
 * QR Code الحالي كـ base64
 */
async function getCurrentQrBase64() {
  if (!currentQr) return null;
  try {
    return await qrcode.toDataURL(currentQr, { width: 300 });
  } catch {
    return null;
  }
}

module.exports = {
  connect,
  sendGroupMessage,
  getGroups,
  disconnect,
  getStatus,
  getCurrentQrBase64,
};
