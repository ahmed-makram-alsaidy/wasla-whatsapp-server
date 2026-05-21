// ─────────────────────────────────────────────────────────
// sessionStore.js — حفظ جلسة Baileys في Supabase
// يضمن إن الـ session ما تنضيعش لو الـ server restart
// ─────────────────────────────────────────────────────────
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const SESSION_NAME = process.env.SESSION_NAME || 'wasla_main';

/**
 * تحديث حالة الـ session في Supabase
 */
async function updateSessionStatus(status, extra = {}) {
  try {
    const { error } = await supabase
      .from('whatsapp_baileys_sessions')
      .update({
        status,
        last_seen_at: new Date().toISOString(),
        ...extra,
      })
      .eq('session_name', SESSION_NAME);

    if (error) console.error('[SessionStore] updateStatus error:', error.message);
  } catch (e) {
    console.error('[SessionStore] updateStatus exception:', e.message);
  }
}

/**
 * حفظ QR Code في DB لعرضه في الواجهة
 */
async function saveQrCode(qrBase64) {
  try {
    const { error } = await supabase
      .from('whatsapp_baileys_sessions')
      .update({
        qr_code: qrBase64,
        status: 'connecting',
        updated_at: new Date().toISOString(),
      })
      .eq('session_name', SESSION_NAME);

    if (error) console.error('[SessionStore] saveQR error:', error.message);
  } catch (e) {
    console.error('[SessionStore] saveQR exception:', e.message);
  }
}

/**
 * مسح QR بعد الاتصال
 */
async function clearQrCode(phoneNumber) {
  try {
    const { error } = await supabase
      .from('whatsapp_baileys_sessions')
      .update({
        qr_code: null,
        status: 'connected',
        phone_number: phoneNumber,
        last_seen_at: new Date().toISOString(),
      })
      .eq('session_name', SESSION_NAME);

    if (error) console.error('[SessionStore] clearQR error:', error.message);
  } catch (e) {
    console.error('[SessionStore] clearQR exception:', e.message);
  }
}

/**
 * تسجيل رسالة جروب في سجل الرسائل
 */
async function logGroupMessage({ groupJid, groupName, merchantId, shipmentId, trackingNumber, messageText, status, errorText }) {
  try {
    await supabase.from('whatsapp_group_message_log').insert({
      group_jid: groupJid,
      group_name: groupName,
      merchant_id: merchantId || null,
      shipment_id: shipmentId || null,
      tracking_number: trackingNumber || null,
      message_text: messageText,
      status,
      error_text: errorText || null,
      sent_at: status === 'sent' ? new Date().toISOString() : null,
    });
  } catch (e) {
    console.error('[SessionStore] logMessage exception:', e.message);
  }
}

/**
 * تحديث حالة رسالة في notification_outbox
 */
async function markOutboxMessage(outboxId, status, errorText = null) {
  try {
    const updates = {
      status,
      updated_at: new Date().toISOString(),
    };
    if (status === 'sent') updates.sent_at = new Date().toISOString();
    if (errorText) updates.last_error = errorText;

    await supabase
      .from('notification_outbox')
      .update(updates)
      .eq('id', outboxId);
  } catch (e) {
    console.error('[SessionStore] markOutbox exception:', e.message);
  }
}

module.exports = {
  updateSessionStatus,
  saveQrCode,
  clearQrCode,
  logGroupMessage,
  markOutboxMessage,
};
