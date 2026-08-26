// ─────────────────────────────────────────────────────────
// uuid.js — canonical company identity validation
// WASLA company IDs are Postgres uuid v4 strings.
// One validator for every route/filesystem/DB boundary.
// Rejects traversal, slashes, encoded tricks, oversized values,
// non-UUID shapes. Never "sanitizes" into another ID.
// ─────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MAX_LEN = 64;

/**
 * Returns the normalized lowercase UUID string, or null when invalid.
 * Anything that is not a strict RFC-4122-style UUID is rejected.
 */
function validateCompanyId(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw.length > MAX_LEN || raw.length !== 36) return null;
  // explicit hostile-pattern short-circuit (defense in depth; UUID_RE alone
  // already rejects these)
  if (/[/\\%.\u0000-\u001f]/.test(raw)) return null;
  if (!UUID_RE.test(raw)) return null;
  return raw.toLowerCase();
}

function isUuid(value) {
  return validateCompanyId(value) !== null;
}

module.exports = { validateCompanyId, isUuid };
