// node --test tests/rateLimiter.test.js
const { test } = require('node:test');
const assert = require('node:assert');

process.env.MIN_DELAY_MS = '0';
process.env.MAX_DELAY_MS = '1';
const { enqueue, getStats } = require('../rateLimiter.js');
const { setTimeout: sleep } = require('timers/promises');

test('per-company lanes drain round-robin (no starvation)', async () => {
  const order = [];
  const mk = (co, n) => Array.from({ length: n }, (_, i) =>
    enqueue(co, async () => { order.push(`${co}-${i}`); return `${co}-${i}`; }));

  // A floods with 6 jobs, B has 2 — B must be served within the first pass.
  const aJobs = mk('A', 6);
  const bJobs = mk('B', 2);
  await Promise.all([...aJobs, ...bJobs]);

  const bPos = [order.indexOf('B-0'), order.indexOf('B-1')];
  assert.ok(bPos[0] < 4, `B-0 served at ${bPos[0]}, expected round-robin early`);
  assert.ok(bPos[1] < 5, `B-1 served at ${bPos[1]}, expected round-robin early`);
});

test('stats expose lane depths only', () => {
  const s = getStats();
  assert.equal(typeof s.queued, 'number');
  assert.ok(s.lanes && typeof s.lanes === 'object');
});
