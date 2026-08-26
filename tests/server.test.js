// node --test tests/server.test.js
// Dependency-free: uses node:test + global fetch against a live local boot.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.PORT = '0'; // ephemeral
process.env.BAILEYS_API_KEY = 'test-key-123';
process.env.AUTH_SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-auth-'));
process.env.ALLOWED_ORIGINS = '';
delete process.env.SUPABASE_URL;      // DB disabled in tests
delete process.env.SUPABASE_SERVICE_KEY;
delete process.env.PLATFORM_COMPANY_ID;

const serverModule = require('../index.js');

let baseUrl;
before(async () => {
  // index.js starts listening on PORT=0; discover the actual port.
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (global.__waslaTestPort) break;
  }
  const port = global.__waslaTestPort || 3001;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (global.__waslaGracefulShutdown) await global.__waslaGracefulShutdown('SIGTERM_TEST');
  fs.rmSync(process.env.AUTH_SESSIONS_DIR, { recursive: true, force: true });
});

const UUID_A = '11111111-1111-4111-8111-111111111111';
const H = { 'x-api-key': 'test-key-123' };

test('health is public and minimal', async () => {
  const r = await fetch(`${baseUrl}/health`);
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(j).sort(), ['ok', 'uptime', 'version']);
});

test('fail-closed: no key → 401 on every sensitive route', async () => {
  const routes = [
    ['GET', `/company/${UUID_A}/status`],
    ['GET', `/company/${UUID_A}/qr`],
    ['GET', `/company/${UUID_A}/qr-scan`],
    ['POST', `/company/${UUID_A}/connect`],
    ['POST', `/company/${UUID_A}/disconnect`],
    ['POST', `/company/${UUID_A}/pairing-code`, JSON.stringify({ phone: '201000000000' })],
    ['GET', `/company/${UUID_A}/groups`],
    ['GET', `/company/${UUID_A}/group-participants?group_jid=1@g.us`],
    ['POST', `/company/${UUID_A}/group-participants/add`, JSON.stringify({ group_jid: '1@g.us', phone: '201000000000' })],
    ['POST', `/company/${UUID_A}/send-group`, JSON.stringify({ group_jid: '1@g.us', message: 'x' })],
    ['POST', `/company/${UUID_A}/send-message`, JSON.stringify({ to: '201000000000', message: 'x' })],
    ['GET', '/status'],
    ['GET', '/qr'],
    ['GET', '/groups'],
    ['POST', '/disconnect'],
    ['POST', '/reconnect'],
    ['GET', '/diag'],
    ['GET', '/sessions'],
  ];
  for (const [method, p, body] of routes) {
    const r = await fetch(baseUrl + p, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    assert.equal(r.status, 401, `${method} ${p} must reject without key`);
  }
});

test('wrong key rejected; correct key accepted for read-only status', async () => {
  let r = await fetch(`${baseUrl}/company/${UUID_A}/status`, { headers: { 'x-api-key': 'nope' } });
  assert.equal(r.status, 401);
  r = await fetch(`${baseUrl}/company/${UUID_A}/status`, { headers: H });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.companyId, UUID_A);
});

test('?apiKey= query transport removed', async () => {
  const r = await fetch(`${baseUrl}/company/${UUID_A}/status?apiKey=test-key-123`);
  assert.equal(r.status, 401);
});

// ── Path traversal / companyId validation regressions ─────
test('traversal & malformed companyIds → 400, zero filesystem writes', async () => {
  const payloads = [
    '..%2Fescaped',
    '%2e%2e%2fescaped',
    'a%2F..%2F..%2Fescaped',
    '..%5Cescaped',
    'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/../../escape',
    'not-a-uuid',
    '3f2b0c1e111122223333444455556666',           // no dashes
    '3F2B0C1E-1111-2222-3333-444455556666X',      // bad char
    '11111111-1111-1111-1111-111111111111-extra', // oversized shape
    encodeURIComponent('../../etc/passwd'),
    encodeURIComponent('C:\\evil\\path'),
  ];
  for (const raw of payloads) {
    const r = await fetch(`${baseUrl}/company/${raw}/status`, { headers: H });
    assert.ok(
      r.status === 400 || r.status === 404,
      `${raw} must be safely rejected (got ${r.status})`
    );
    if (!raw.includes('/') && !raw.includes('%2F') && !raw.includes('%2f')) {
      assert.equal(r.status, 400, `${raw} single-segment must be a strict 400`);
    }
  }
  // nothing escaped the auth root
  const entries = fs.readdirSync(process.env.AUTH_SESSIONS_DIR);
  assert.deepEqual(entries.filter(e => !e.startsWith(UUID_A)), []);
});
