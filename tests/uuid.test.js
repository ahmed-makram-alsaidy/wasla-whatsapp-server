// node --test tests/uuid.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { validateCompanyId, isUuid } = require('../uuid.js');

const GOOD = '3f2b0c1e-1111-4222-8333-444455556666';

test('accepts canonical uuid (case-insensitive, trimmed)', () => {
  assert.equal(validateCompanyId(` ${GOOD.toUpperCase()} `), GOOD);
  assert.ok(isUuid(GOOD));
});

test('rejects every archaeology attack payload', () => {
  const bad = [
    null, undefined, 42, {},
    '', '   ',
    '../escaped', '..\\escaped_win', 'a/../../escaped',
    '%2e%2e/enc2', '..%5Cescaped_encoded',
    '/etc/passwd', 'C:\\evil\\path',
    'not-a-uuid',
    GOOD + '-extra',                       // oversized / shape attack
    GOOD.slice(0, 35),                     // short
    'gfffffff-1111-4222-8333-444455556666',// non-hex
    '11111111-1111-0111-8111-111111111111' // version nibble 0
  ];
  for (const v of bad) {
    assert.equal(validateCompanyId(v), null, JSON.stringify(v));
  }
});

test('rejects embedded separators and unicode tricks', () => {
  const tricky = [
    GOOD.replace(/-/g, '\u2212'),          // unicode minus look-alike fails hex anyway
    `${GOOD}\u0000`,
    `${GOOD}/../..`,
  ];
  for (const v of tricky) assert.equal(validateCompanyId(v), null);
});
