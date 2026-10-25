'use strict';

const assert = require('assert/strict');
const { RedPacketClaimBatch, parseRedPacket } = require('./red_packet_batch');

const start = '[红包]玩家 terr1es 发送了一个 口令红包 【输入口令领取】';
const claim = (name, amount = 25) => `[红包]${name} 领取了 terr1es 发送的 口令红包，金额：${amount} 金币`;

function harness() {
  let now = 1000;
  const timers = new Map();
  let nextTimer = 0;
  const records = [];
  const flushed = [];
  const batch = new RedPacketClaimBatch({
    now: () => now,
    setTimer: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimer: (id) => timers.delete(id),
    onRecord: (record) => records.push(record),
    onFlush: (messages) => flushed.push(messages),
  });
  return { batch, timers, records, flushed, tick: (ms) => { now += ms; } };
}

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  [PASS] ' + name); }
  catch (e) { failed++; console.error('  [FAIL] ' + name + '\n         ' + e.stack); }
}

test('Parses the packet publisher, claimant and amount', () => {
  assert.deepEqual(parseRedPacket(start, 'system'), {
    kind: 'start', publisher: 'terr1es', packetType: '口令红包',
    body: '玩家 terr1es 发送了一个 口令红包 【输入口令领取】',
  });
  assert.equal(parseRedPacket(claim('terr1es'), 'system').claimant, 'terr1es');
  assert.equal(parseRedPacket(claim('terr1es'), 'system').amount, '25');
});

test('Holds claims for ten seconds, then flushes all recorded people', () => {
  const h = harness();
  assert.equal(h.batch.handle({ text: start, serverKey: 's', session: 'a' }).suppress, false);
  assert.equal(h.batch.handle({ text: claim('one'), serverKey: 's', session: 'a' }).suppress, true);
  assert.equal(h.batch.handle({ text: claim('two', 30), serverKey: 's', session: 'a' }).suppress, true);
  assert.equal(h.flushed.length, 0);
  assert.equal(h.records.length, 1, 'Only the publisher is logged before the deadline');
  const timer = [...h.timers.values()][0];
  assert.equal(timer.ms, 10000);
  timer.fn();
  assert.deepEqual(h.flushed[0].map((item) => item.claimant), ['one', 'two']);
  assert.match(h.records[1].detail, /one 领取了 terr1es 发送的/);
  assert.match(h.records[1].detail, /two 领取了 terr1es 发送的/);
});

test('Counts each claimant once without interpreting twenty as an upper limit', () => {
  const h = harness();
  h.batch.handle({ text: start, serverKey: 's', session: 'a' });
  for (let i = 0; i < 25; i++) h.batch.handle({ text: claim('user' + i), serverKey: 's', session: 'a' });
  h.batch.handle({ text: claim('user0', 99), serverKey: 's', session: 'a' });
  [...h.timers.values()][0].fn();
  assert.equal(h.flushed[0].length, 25);
  assert.equal(new Set(h.flushed[0].map((item) => item.claimant)).size, 25);
  assert.equal(h.records.length, 2);
});

test('Late callbacks do not extend the collection window past ten seconds', () => {
  const h = harness(); h.batch.handle({ text: start });
  h.batch.handle({ text: claim('early') }); h.tick(10000);
  assert.equal(h.batch.handle({ text: claim('late') }).suppress, false);
  assert.deepEqual(h.flushed[0].map((item) => item.claimant), ['early']);
});

test('Another packet from the same publisher does not flush the first packet early', () => {
  const h = harness(); h.batch.handle({ text: start });
  h.batch.handle({ text: claim('early') });
  const first = [...h.timers.values()][0].fn;
  h.tick(1000); h.batch.handle({ text: start }); h.batch.handle({ text: claim('later') });
  assert.equal(h.flushed.length, 0);
  first(); assert.deepEqual(h.flushed[0].map((item) => item.claimant), ['early']);
  [...h.timers.values()][0].fn();
  assert.deepEqual(h.flushed[1].map((item) => item.claimant), ['later']);
});

test('Does not suppress spoofed player messages or claims without a tracked packet', () => {
  const h = harness();
  assert.equal(h.batch.handle({ text: start, type: 'player', serverKey: 's', session: 'a' }).suppress, false);
  assert.equal(h.batch.handle({ text: claim('one'), serverKey: 's', session: 'a' }).suppress, false);
  assert.equal(h.records.length, 0);
});

test('Reset cancels pending batches without a late flush', () => {
  const h = harness();
  h.batch.handle({ text: start, serverKey: 's', session: 'a' });
  h.batch.handle({ text: claim('one'), serverKey: 's', session: 'a' });
  h.batch.reset();
  assert.equal(h.timers.size, 0);
  assert.equal(h.flushed.length, 0);
});

console.log(`\nResult: ${passed} passed / ${failed} failed`);
process.exitCode = failed ? 1 : 0;
