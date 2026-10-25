'use strict';

const assert = require('assert/strict');
const { ChatActions } = require('./chat_actions');
const { RedPacketAutomation, normalizeClaimDelay } = require('./red_packet');
const { mainHarness } = require('./connection_lifecycle_test');
const { normalize } = require('./configstore');

function fixture(random = 0) {
  let now = 1000, seq = 0;
  const timers = new Map(), commands = [], records = [];
  const actions = new ChatActions();
  const client = { state: 'play', username: 'Tester', command: (value) => { commands.push(value); return true; } };
  const auto = new RedPacketAutomation({ actions, random: () => random, now: () => now,
    setTimer: (fn, ms) => { timers.set(++seq, { fn, ms }); return seq; }, clearTimer: (id) => timers.delete(id),
    onRecord: (record) => records.push(record) });
  const message = (value = '/fixture claim') => ({ type: 'system', session: actions.session,
    text: '[\u7ea2\u5305]\u73a9\u5bb6 Sender \u53d1\u9001\u4e86\u4e00\u4e2a\u7ea2\u5305 \u70b9\u51fb\u9886\u53d6',
    segments: actions.register([{ text: '\u70b9\u51fb\u9886\u53d6', click: { action: 'run_command', value } }]) });
  const fire = () => { const [id, timer] = timers.entries().next().value; timers.delete(id); now += timer.ms; timer.fn(); return timer; };
  return { auto, actions, client, commands, records, timers, message, fire, jump: (ms) => { now += ms; },
    run: (m = message(), options = {}) => auto.handle(m, client, { enabled: true, serverKey: 'example.invalid:25565', ...options }) };
}

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
}
async function run() {
  await test('Defaults and custom delay ranges normalize without accepting malformed or unbounded values', () => {
    assert.deepEqual(normalizeClaimDelay(), { minMs: 400, maxMs: 850 });
    for (const value of [null, {}, { minMs: 900, maxMs: 400 }, { minMs: -1, maxMs: 400 },
      { minMs: 400, maxMs: 30001 }, { minMs: '400', maxMs: 850 }, { minMs: 0.5, maxMs: 1 }]) {
      assert.deepEqual(normalizeClaimDelay(value), { minMs: 400, maxMs: 850 });
    }
    assert.deepEqual(normalizeClaimDelay({ minMs: 0, maxMs: 0 }), { minMs: 0, maxMs: 0 });
  });
  for (const [random, expected] of [[0, 400], [0.5, 625], [0.99999, 850]]) {
    await test('Default random sample ' + random + ' waits ' + expected + ' ms before one dispatch', async () => {
      const h = fixture(random), pending = h.run();
      assert.equal(h.commands.length, 0); assert.equal(h.auto.scheduled.size, 1);
      assert.equal([...h.timers.values()][0].ms, expected);
      h.fire(); assert.equal((await pending).status, 'sent');
      assert.deepEqual(h.commands, ['fixture claim']); assert.equal([...h.timers.values()][0].ms, 30000);
      h.auto.resetPending();
    });
  }
  await test('A custom equal range and zero delay both work', async () => {
    const h = fixture(); const pending = h.run(h.message(), { delay: { minMs: 1230, maxMs: 1230 } });
    assert.equal([...h.timers.values()][0].ms, 1230); h.fire(); await pending; h.auto.resetPending();
    await h.run(h.message('/fixture zero'), { delay: { minMs: 0, maxMs: 0 } });
    assert.deepEqual(h.commands, ['fixture claim', 'fixture zero']); h.auto.resetPending();
  });
  await test('Duplicates received during delay queue only one action', async () => {
    const h = fixture(); const pending = h.run();
    assert.equal((await h.run()).status, 'duplicate'); assert.equal(h.auto.scheduled.size, 1);
    h.fire(); await pending; assert.equal(h.commands.length, 1); h.auto.resetPending();
  });
  await test('Disconnect cancels the promise and a stale callback cannot dispatch', async () => {
    const h = fixture(), pending = h.run(), stale = [...h.timers.values()][0].fn;
    h.auto.resetPending(); stale();
    assert.equal((await pending).status, 'cancelled'); assert.equal(h.commands.length, 0); assert.equal(h.timers.size, 0);
  });
  for (const mutate of [h => h.actions.reset(), h => { h.client.state = 'closed'; }, h => { h.client.automationBlocked = true; }]) {
    await test('Session, state and conflicting helper are checked again after waiting', async () => {
      const h = fixture(), pending = h.run(); mutate(h); h.fire();
      assert.equal((await pending).status, 'cancelled'); assert.equal(h.commands.length, 0);
    });
  }
  await test('Current client and enabled-policy predicate is rechecked at dispatch', async () => {
    const h = fixture(); let current = true;
    const pending = h.run(h.message(), { isCurrent: () => current }); current = false; h.fire();
    assert.equal((await pending).status, 'cancelled'); assert.equal(h.commands.length, 0);
  });
  await test('Timers delayed by sleep do not send a stale claim on resume', async () => {
    const h = fixture(), pending = h.run(); h.jump(10000); h.fire();
    assert.equal((await pending).status, 'cancelled'); assert.equal(h.commands.length, 0);
  });
  await test('Manual claim through a different duplicate ID cancels the matching scheduled command', async () => {
    const h = fixture(), first = h.message(), pending = h.run(first), duplicate = h.message();
    await h.run(duplicate);
    h.auto.cancelCommand('/fixture claim', h.actions.session);
    assert.equal((await h.actions.activate(duplicate.segments[0].click.id, h.client)).ok, true);
    assert.equal((await pending).status, 'cancelled'); assert.equal(h.commands.length, 1); assert.equal(h.auto.scheduled.size, 0);
  });
  await test('Cancelling a specific manually clicked command leaves unrelated claims scheduled', async () => {
    const h = fixture(), first = h.run(), second = h.run(h.message('/fixture second'));
    h.auto.cancelCommand('/fixture claim', h.actions.session);
    assert.equal((await first).status, 'cancelled'); assert.equal(h.auto.scheduled.size, 1);
    h.fire(); await second; assert.deepEqual(h.commands, ['fixture second']); h.auto.resetPending();
  });
  await test('Changing delay cancels only waiting claims, retaining already-sent feedback timers', async () => {
    const h = fixture(), first = h.run(); h.fire(); await first;
    const second = h.run(h.message('/fixture second')); h.auto.cancelScheduled(); await second;
    assert.equal(h.auto.pending.size, 1); assert.equal(h.timers.size, 1); h.auto.resetPending();
  });
  await test('Main config defaults schedule 400-850 ms and disabling cancels without sending', async () => {
    const timers = new Map(); let seq = 0;
    const h = mainHarness({ config: normalize({ autoLogin: false, servers: [] }), claimDelay: { minMs: 400, maxMs: 850 },
      setTimeout: (fn, ms) => { timers.set(++seq, { fn, ms }); return seq; }, clearTimeout: (id) => timers.delete(id) });
    await h.connect(); const client = h.clients[0]; client.state = 'play'; client.opts.onEvent('join');
    const parts = [{ text: '[\u7ea2\u5305]\u70b9\u51fb\u9886\u53d6', click: { action: 'run_command', value: '/fixture main' } }];
    client.opts.onChat(parts[0].text, { type: 'system', segments: parts });
    assert.equal(h.business(), 0);
    assert.ok([...timers.values()].some(timer => timer.ms >= 400 && timer.ms <= 850));
    const queued = [...timers.values()].find(timer => timer.ms >= 400 && timer.ms <= 850);
    const result = h.configure({ autoLogin: false, servers: [], automation: { autoClaimRedPackets: false } });
    assert.equal(result.ok, true); queued.fn(); await new Promise(setImmediate); assert.equal(h.business(), 0);
    assert.equal(h.configure({ automation: { claimDelay: { minMs: 900, maxMs: 400 } } }).ok, false);
    h.quit();
  });
  await test('Main manual click cancels a queued duplicate-ID claim before dispatch', async () => {
    const timers = new Map(); let seq = 0;
    const h = mainHarness({ config: normalize({ autoLogin: false, servers: [] }), claimDelay: { minMs: 400, maxMs: 850 },
      setTimeout: (fn, ms) => { timers.set(++seq, { fn, ms }); return seq; }, clearTimeout: id => timers.delete(id) });
    await h.connect(); const client = h.clients[0]; client.state = 'play'; client.opts.onEvent('join');
    const parts = [{ text: '[\u7ea2\u5305]\u70b9\u51fb\u9886\u53d6', click: { action: 'run_command', value: '/fixture manual-race' } }];
    client.opts.onChat(parts[0].text, { type: 'system', segments: parts });
    const queued = [...timers.values()].find(timer => timer.ms >= 400 && timer.ms <= 850);
    client.opts.onChat(parts[0].text, { type: 'system', segments: parts });
    const id = h.chats.at(-1).segments[0].click.id;
    assert.equal((await h.invoke('client:chatAction', id)).ok, true);
    queued.fn(); await new Promise(setImmediate); assert.equal(h.business(), 1); h.quit();
  });
  await test('Bridge remote actions wait before dispatch and retain automatic validation options', async () => {
    const h = fixture(), message = h.message();
    const action = h.actions.actions.get(message.segments[0].click.id); action.remoteId = 'fixture-remote';
    let calls = 0;
    h.client.activateAction = async (value, options) => {
      calls++; assert.equal(value.remoteId, 'fixture-remote'); assert.equal(options.automatic, true); return { ok: true };
    };
    const pending = h.run(message); assert.equal(calls, 0); h.fire();
    assert.equal((await pending).status, 'sent'); assert.equal(calls, 1); assert.equal(h.commands.length, 0); h.auto.resetPending();
  });
  console.log('=== Result: ' + passed + ' passed / ' + failed + ' failed ==='); process.exitCode = failed ? 1 : 0;
}
run().catch(error => { console.error(error); process.exitCode = 1; });
