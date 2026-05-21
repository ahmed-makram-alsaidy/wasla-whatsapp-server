// ─────────────────────────────────────────────────────────
// sessionStore.js — Multi-Tenant Supabase Session Store
// كل شركة (company_id) عندها record مستقل
// ─────────────────────────────────────────────────────────
const { createClient } = require('@supabase/supabase-js');

let _supabase = null;
function getSupabase() {
  if (!_supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) {
      console.warn('[SessionStore] SUPABASE_URL or SUPABASE_SERVICE_KEY not set — DB disabled');
      return null;
    }
    _supabase = createClient(url, key);
  }
  return _supabase;
}

// ─────────────────────────────────────────────────────────
// Per-Company Session Status
// ─────────────────────────────────────────────────────────

async function updateCompanySessionStatus(companyId, status, phoneNumber = null) {
  const db = getSupabase();
  if (!db) return;
  try {
    const { error } = await db
      .from('whatsapp_sessions')
      .upsert({
        company_id: companyId,
        status,
        phone_number: phoneNumber,
        updated_at: new Date().toISOString(),
        ...(status === 'connected' ? { connected_at: new Date().toISOString() } : {}),
      }, { onConflict: 'company_id' });
    if (error) console.error(`[SessionStore:${companyId}] updateStatus error:`, error.message);
  } catch (e) {
    console.error(`[SessionStore:${companyId}] updateStatus exception:`, e.message);
  }
}

async function saveCompanyQrCode(companyId, qrBase64) {
  const db = getSupabase();
  if (!db) return;
  try {
    const { error } = await db
      .from('whatsapp_sessions')
      .upsert({
        company_id: companyId,
        qr_code: qrBase64,
        status: 'connecting',
        updated_at: new Date().toISOString(),
      }, { onConflict: 'company_id' });
    if (error) console.error(`[SessionStore:${companyId}] saveQR error:`, error.message);
  } catch (e) {
    console.error(`[SessionStore:${companyId}] saveQR exception:`, e.message);
  }
}

async function clearCompanyQrCode(companyId, phoneNumber) {
  const db = getSupabase();
  if (!db) return;
  try {
    const { error } = await db
      .from('whatsapp_sessions')
      .upsert({
        company_id: companyId,
        qr_code: null,
        status: 'connected',
        phone_number: phoneNumber,
        connected_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'company_id' });
    if (error) console.error(`[SessionStore:${companyId}] clearQR error:`, error.message);
  } catch (e) {
    console.error(`[SessionStore:${companyId}] clearQR exception:`, e.message);
  }
}

// جلب حالة session شركة من Supabase
async function getCompanySession(companyId) {
  const db = getSupabase();
  if (!db) return null;
  try {
    const { data, error } = await db
      .from('whatsapp_sessions')
      .select('*')
      .eq('company_id', companyId)
      .maybeSingle();
    if (error) return null;
    return data;
  } catch {
    return null;
  }
}

// جلب كل الشركات التي عندها sessions نشطة
async function getActiveCompanySessions() {
  const db = getSupabase();
  if (!db) return [];
  try {
    const { data, error } = await db
      .from('whatsapp_sessions')
      .select('company_id, status, phone_number')
      .neq('status', 'disconnected');
    if (error) return [];
    return data || [];
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────
// Message Logging
// ─────────────────────────────────────────────────────────
async function logGroupMessage({ companyId, groupJid, groupName, merchantId, shipmentId, trackingNumber, messageText, status, errorText }) {
  const db = getSupabase();
  if (!db) return;
  try {
    await db.from('whatsapp_group_message_log').insert({
      company_id: companyId || null,
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

async function markOutboxMessage(outboxId, status, errorText = null) {
  const db = getSupabase();
  if (!db) return;
  try {
    const updates = { status, updated_at: new Date().toISOString() };
    if (status === 'sent') updates.sent_at = new Date().toISOString();
    if (errorText) updates.last_error = errorText;
    await db.from('notification_outbox').update(updates).eq('id', outboxId);
  } catch (e) {
    console.error('[SessionStore] markOutbox exception:', e.message);
  }
}

module.exports = {
  updateCompanySessionStatus,
  saveCompanyQrCode,
  clearCompanyQrCode,
  getCompanySession,
  getActiveCompanySessions,
  logGroupMessage,
  markOutboxMessage,
};
