'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ChatActions } = require('./chat_actions');
const { RedPacketAutomation, normalizeClaimTrigger } = require('./red_packet');
const { parseRedPacket } = require('./red_packet_batch');
const { normalize, save, load } = require('./configstore');
const { mainHarness } = require('./connection_lifecycle_test');
const tick = () => new Promise(setImmediate);
const countOptions = { delayEnabled: false, afterClaims: { enabled: true, count: 2 }, delay: { minMs: 2500, maxMs: 2600 } };

function fixture(count = 2) {
  let now = 1000, seq = 0, randomCalls = 0;
  const timers = new Map(), commands = [], records = [];
  const actions = new ChatActions();
  const client = { state: 'play', username: 'Tester', command: (value) => { commands.push(value); return true; } };
  const auto = new RedPacketAutomation({ actions, now: () => now, random: () => { randomCalls++; return 0.5; },
    setTimer: (fn, ms) => { timers.set(++seq, { fn, ms }); return seq; }, clearTimer: (id) => timers.delete(id),
    onRecord: (record) => records.push(record) });
  const start = (publisher = 'Sender', value = '/fixture claim', kind = 'run_command') => ({ type: 'system', origin: 'server',
    session: actions.session, text: '[红包]玩家 ' + publisher + ' 发送了一个 拼手气红包 【点击领取】',
    segments: actions.register([{ text: '【点击领取】', click: { action: kind, value } }]) });
  const claim = (claimant, publisher = 'Sender', extra = {}) => ({ type: 'system', origin: 'server', session: actions.session,
    text: '[红包]' + claimant + '领取了' + publisher + '发送的红包，金额：100 金币', segments: [], ...extra });
  const run = (message, options = {}) => auto.handle(message, client,
    { enabled: true, serverKey: 'example.invalid:25565', ...countOptions, afterClaims: { enabled: true, count }, ...options });
  const fire = (ms) => {
    const found = [...timers.entries()].find(([, timer]) => timer.ms === ms); assert.ok(found, 'Expected timer ' + ms);
    const [id, timer] = found; timers.delete(id); now += ms; timer.fn(); return timer;
  };
  return { auto, actions, client, timers, commands, records, start, claim, run, fire,
    jump: (ms) => { now += ms; }, randomCalls: () => randomCalls };
}

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('PASS ' + name); }
  catch (e) { failed++; console.error('FAIL ' + name, e.stack); }
}
async function run() {
  await test('Old configs retain random delay; count defaults to two and is disabled', () => {
    assert.deepEqual(normalizeClaimTrigger(), { claimDelayEnabled: true, claimAfter: { enabled: false, count: 2 } });
    const cfg = normalize({ automation: { claimDelay: { minMs: 2500, maxMs: 2600 } } });
    assert.deepEqual(cfg.automation.claimDelay, { minMs: 2500, maxMs: 2600 }); assert.equal(cfg.automation.claimDelayEnabled, true);
    assert.equal(cfg.automation.claimAfter.enabled, false);
  });
  await test('Conflicting persisted modes resolve to count; invalid thresholds never enable it', () => {
    assert.equal(normalizeClaimTrigger({ claimDelayEnabled: true, claimAfter: { enabled: true, count: 3 } }).claimDelayEnabled, false);
    for (const count of [0, -1, 1001, 1.5, '2', NaN, Infinity]) {
      assert.equal(normalizeClaimTrigger({ claimAfter: { enabled: true, count } }).claimAfter.enabled, false);
    }
    assert.equal(normalizeClaimTrigger({ claimAfter: { enabled: 'yes', count: 2 } }).claimAfter.enabled, false);
  });
  await test('Count settings survive atomic save/reload independently of inactive delay values', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-count-config-'));
    const file = path.join(dir, 'config.json'); const cfg = normalize({ automation: { ...countOptions,
      claimDelay: { minMs: 2500, maxMs: 2600 }, claimDelayEnabled: false, claimAfter: { enabled: true, count: 3 } } });
    assert.equal(save(file, cfg).ok, true); assert.deepEqual(load(file).cfg.automation, cfg.automation);
  });
  await test('Compact and spaced server claim broadcasts both parse into the same identities', () => {
    for (const text of ['[红包]First领取了Sender发送的红包，金额：100 金币',
      '[红包] First 领取了 Sender 发送的 口令红包，金额：100 金币']) {
      const parsed = parseRedPacket(text, 'system', 'server');
      assert.equal(parsed.claimant, 'First'); assert.equal(parsed.publisher, 'Sender'); assert.equal(parsed.amount.trim(), '100');
    }
  });
  await test('Second different claimant sends immediately without sampling random or firing a delay timer', async () => {
    const h = fixture(), pending = h.run(h.start()); assert.equal(h.commands.length, 0);
    assert.equal([...h.timers.values()][0].ms, 10000);
    await h.run(h.claim('First')); assert.equal(h.commands.length, 0);
    h.jump(800); await h.run(h.claim('Second')); assert.equal((await pending).status, 'sent');
    assert.deepEqual(h.commands, ['fixture claim']); assert.equal(h.randomCalls(), 0);
    assert.equal(h.auto.scheduled.size, 0); assert.equal([...h.timers.values()][0].ms, 30000); h.auto.resetPending();
  });
  for (const count of [1, 3, 20]) await test('Configured threshold ' + count + ' triggers exactly once', async () => {
    const h = fixture(count), pending = h.run(h.start());
    for (let i = 1; i < count; i++) { await h.run(h.claim('Claimant_' + i)); assert.equal(h.commands.length, 0); }
    await h.run(h.claim('Claimant_' + count)); assert.equal((await pending).status, 'sent');
    await h.run(h.claim('Extra')); assert.equal(h.commands.length, 1); h.auto.resetPending();
  });
  await test('Duplicate and differently cased claimants never advance the threshold twice', async () => {
    const h = fixture(), pending = h.run(h.start());
    await h.run(h.claim('First')); await h.run(h.claim('FIRST')); await h.run(h.claim('First'));
    assert.equal(h.commands.length, 0); await h.run(h.claim('Second')); await pending;
    assert.equal(h.commands.length, 1); h.auto.resetPending();
  });
  await test('Duplicate announcements do not clear already counted claimants or create another wait', async () => {
    const h = fixture(), pending = h.run(h.start()); await h.run(h.claim('First'));
    assert.equal((await h.run(h.start())).status, 'duplicate'); assert.equal(h.auto.scheduled.size, 1);
    await h.run(h.claim('Second')); await pending; assert.equal(h.commands.length, 1); h.auto.resetPending();
  });
  await test('Other sender, server, session and spoofed player claims never trigger', async () => {
    const h = fixture(), pending = h.run(h.start());
    await h.run(h.claim('First', 'Other')); await h.run(h.claim('Second', 'Sender'), { serverKey: 'other.invalid:25565' });
    await h.run(h.claim('Third', 'Sender', { session: 'old-session' }));
    await h.run(h.claim('Fourth', 'Sender', { type: 'player', origin: 'player' }));
    await h.run(h.claim('Fifth', 'Sender', { origin: 'player' })); assert.equal(h.commands.length, 0);
    await h.run(h.claim('Sixth')); await h.run(h.claim('Seventh')); await pending;
    assert.equal(h.commands.length, 1); h.auto.resetPending();
  });
  await test('Concurrent senders count only their own claims', async () => {
    const h = fixture(), one = h.run(h.start('Sender', '/fixture one')), two = h.run(h.start('Other', '/fixture two'));
    await h.run(h.claim('First', 'Sender')); await h.run(h.claim('First', 'Other'));
    assert.equal(h.commands.length, 0); await h.run(h.claim('Second', 'Other')); await two;
    assert.deepEqual(h.commands, ['fixture two']); await h.run(h.claim('Second', 'Sender')); await one;
    assert.deepEqual(h.commands, ['fixture two', 'fixture one']); h.auto.resetPending();
  });
  await test('A newer packet from the same sender cancels the old wait and resets counting', async () => {
    const h = fixture(), one = h.run(h.start('Sender', '/fixture one')); await h.run(h.claim('First'));
    const two = h.run(h.start('Sender', '/fixture two')); assert.equal((await one).status, 'cancelled');
    await h.run(h.claim('Second')); assert.equal(h.commands.length, 0);
    await h.run(h.claim('Third')); await two; assert.deepEqual(h.commands, ['fixture two']); h.auto.resetPending();
  });
  await test('New announcement without a trusted executable action invalidates the older count wait', async () => {
    const h = fixture(), pending = h.run(h.start()); await h.run(h.claim('First'));
    await h.run({ ...h.start(), segments: [] }); assert.equal((await pending).status, 'cancelled');
    await h.run(h.claim('Second')); assert.equal(h.commands.length, 0); h.auto.resetPending();
  });
  await test('Own natural claim cancels waiting rather than submitting another claim', async () => {
    const h = fixture(), pending = h.run(h.start()); await h.run(h.claim('Tester'));
    assert.equal((await pending).status, 'cancelled'); assert.equal(h.commands.length, 0); assert.equal(h.timers.size, 0);
  });
  await test('Unreached threshold expires after ten seconds without random fallback or retry', async () => {
    const h = fixture(), pending = h.run(h.start()); await h.run(h.claim('First')); h.fire(10000);
    assert.equal((await pending).status, 'cancelled'); await h.run(h.claim('Second'));
    assert.equal(h.commands.length, 0); assert.equal(h.randomCalls(), 0); assert.equal(h.timers.size, 0);
  });
  await test('Delayed expiry callback cannot extend the window, and stale callbacks cannot dispatch', async () => {
    const h = fixture(), pending = h.run(h.start()), stale = [...h.timers.values()][0].fn;
    await h.run(h.claim('First')); h.jump(10000); await h.run(h.claim('Second')); stale();
    assert.equal((await pending).status, 'cancelled'); assert.equal(h.commands.length, 0);
  });
  for (const [label, mutate] of [
    ['reset', h => h.auto.resetPending()], ['manual action', h => h.auto.cancelCommand('/fixture claim', h.actions.session)],
    ['settings change', h => h.auto.cancelScheduled()]]) await test(label + ' cancels a count wait', async () => {
      const h = fixture(), pending = h.run(h.start()), stale = [...h.timers.values()][0].fn;
      mutate(h); stale(); assert.equal((await pending).status, 'cancelled'); assert.equal(h.commands.length, 0);
    });
  for (const [label, mutate] of [
    ['closed connection', h => { h.client.state = 'closed'; }], ['new session', h => h.actions.reset()],
    ['helper conflict', h => { h.client.automationBlocked = true; }],
    ['invalidated action', h => h.actions.actions.clear()]]) await test(label + ' is rechecked before count dispatch', async () => {
      const h = fixture(), pending = h.run(h.start()); await h.run(h.claim('First'));
      const trigger = h.run(h.claim('Second')); mutate(h); await trigger;
      assert.equal((await pending).status, 'cancelled'); assert.equal(h.commands.length, 0); h.auto.resetPending();
    });
  await test('Current policy and stale dispatch time are rechecked after reaching the count', async () => {
    const h = fixture(); let current = true; const pending = h.run(h.start(), { isCurrent: () => current });
    await h.run(h.claim('First')); const trigger = h.run(h.claim('Second')); current = false; await trigger;
    assert.equal((await pending).status, 'cancelled'); assert.equal(h.commands.length, 0); h.auto.resetPending();
    const second = h.run(h.start('Sender', '/fixture late')); await h.run(h.claim('First'));
    const late = h.run(h.claim('Second')); h.jump(2001); await late;
    assert.equal((await second).status, 'cancelled'); assert.equal(h.commands.length, 0); h.auto.resetPending();
  });
  await test('Manual duplicate action immediately after the threshold cancels the resolved automatic wait', async () => {
    const h = fixture(), first = h.start(), pending = h.run(first), duplicate = h.start();
    await h.run(duplicate); await h.run(h.claim('First'));
    const threshold = h.run(h.claim('Second'));
    h.auto.cancelCommand('/fixture claim', h.actions.session);
    const manual = h.actions.activate(duplicate.segments[0].click.id, h.client);
    await threshold; assert.equal((await pending).status, 'cancelled'); assert.equal((await manual).ok, true);
    assert.equal(h.commands.length, 1); h.auto.resetPending();
  });
  await test('A delivered but cleared expiry callback cannot cancel an already triggered count', async () => {
    const h = fixture(), pending = h.run(h.start()), stale = [...h.timers.values()][0].fn;
    await h.run(h.claim('First')); const threshold = h.run(h.claim('Second')); stale();
    await threshold; assert.equal((await pending).status, 'sent'); assert.equal(h.commands.length, 1); h.auto.resetPending();
  });
  await test('Both modes disabled means original entry executes immediately; suggestions remain fill-only', async () => {
    const h = fixture(); await h.run(h.start(), { delayEnabled: false, afterClaims: { enabled: false, count: 2 } });
    assert.equal(h.commands.length, 1); assert.equal(h.randomCalls(), 0); h.auto.resetPending();
    const result = await h.run(h.start('Sender', '/fixture password ', 'suggest_command'));
    assert.equal(result.status, 'suggested'); assert.equal(h.commands.length, 1); assert.equal(h.auto.scheduled.size, 0);
  });
  await test('Count mode still enforces ten new red-packet entries per minute', async () => {
    const h = fixture(), pending = [];
    for (let i = 0; i < 10; i++) pending.push(h.run(h.start('Sender_' + i, '/fixture ' + i)));
    assert.equal((await h.run(h.start('Other', '/fixture limited'))).status, 'limited');
    assert.equal(h.auto.scheduled.size, 10); h.auto.resetPending(); await Promise.all(pending); assert.equal(h.commands.length, 0);
  });
  await test('Bridge dispatch preserves remote action ID and automatic safeguards', async () => {
    const h = fixture(), message = h.start(); let calls = 0;
    h.actions.actions.get(message.segments[0].click.id).remoteId = 'fixture-remote';
    h.client.activateAction = async (action, options) => {
      calls++; assert.equal(action.remoteId, 'fixture-remote'); assert.equal(options.automatic, true); return { ok: true };
    };
    const pending = h.run(message); await h.run(h.claim('First')); assert.equal(calls, 0);
    await h.run(h.claim('Second')); assert.equal((await pending).status, 'sent'); assert.equal(calls, 1); h.auto.resetPending();
  });
  await test('Missing sender is skipped instead of guessing a packet or applying random delay', async () => {
    const h = fixture(), message = h.start(); message.text = '[红包]【点击领取】';
    assert.equal((await h.run(message)).status, 'skipped'); assert.equal(h.commands.length, 0); assert.equal(h.timers.size, 0);
  });
  await test('Main raw chat triggers on second claim before delayed logs and keeps claims out of chat', async () => {
    const timers = new Map(); let seq = 0;
    const h = mainHarness({ config: normalize({ autoLogin: false, servers: [], automation: { autoClaimRedPackets: true,
      claimDelayEnabled: false, claimAfter: { enabled: true, count: 2 } } }),
      setTimeout: (fn, ms) => { timers.set(++seq, { fn, ms }); return seq; }, clearTimeout: id => timers.delete(id) });
    await h.connect(); const client = h.clients[0]; client.state = 'play'; client.opts.onEvent('join');
    const start = '[红包]玩家 Sender 发送了一个 拼手气红包 【点击领取】';
    client.opts.onChat(start, { type: 'system', origin: 'server', segments: [{ text: '【点击领取】', click: { action: 'run_command', value: '/fixture main-count' } }] });
    client.opts.onChat('[红包]First领取了Sender发送的红包，金额：100 金币', { type: 'system', origin: 'server' });
    assert.equal(h.business(), 0);
    client.opts.onChat('[红包]Second领取了Sender发送的红包，金额：100 金币', { type: 'system', origin: 'server' });
    await tick(); assert.equal(h.business(), 1);
    assert.equal(h.chats.some((m) => m.text.includes('First领取了')), false);
    assert.equal(h.logs.some((m) => m.text.includes('First领取了')), false);
    assert.ok(h.logs.some((m) => m.text.includes('已观察到 2 位不同玩家')));
    assert.equal(h.logs.some((m) => m.text.includes('随机等待')), false); h.quit();
  });
  await test('Main validates count settings and cancels old waits when changing mode, count or master switch', async () => {
    for (const next of [{ claimDelayEnabled: true, claimAfter: { enabled: false, count: 2 } },
      { claimDelayEnabled: false, claimAfter: { enabled: true, count: 3 } }, { autoClaimRedPackets: false }]) {
      const h = mainHarness({ config: normalize({ autoLogin: false, servers: [], automation: {
        claimDelayEnabled: false, claimAfter: { enabled: true, count: 2 } } }) });
      await h.connect(); const client = h.clients[0]; client.state = 'play'; client.opts.onEvent('join');
      client.opts.onChat('[红包]玩家 Sender 发送了一个 拼手气红包 【点击领取】', { type: 'system', segments: [
        { text: '【点击领取】', click: { action: 'run_command', value: '/fixture changed' } }] });
      assert.equal(h.configure({ automation: { claimAfter: { enabled: true, count: 0 } } }).ok, false);
      assert.equal(h.configure({ automation: { claimDelayEnabled: 'yes' } }).ok, false);
      assert.equal(h.configure({ automation: { claimDelayEnabled: true, claimAfter: { enabled: true, count: 2 } } }).ok, false);
      assert.equal(h.configure({ automation: next }).ok, true);
      for (const name of ['First', 'Second', 'Third']) client.opts.onChat('[红包]' + name + '领取了Sender发送的红包，金额：100 金币', { type: 'system' });
      await tick(); assert.equal(h.business(), 0); h.quit();
    }
  });
  console.log('=== Result: ' + passed + ' passed / ' + failed + ' failed ==='); process.exitCode = failed ? 1 : 0;
}
run().catch((e) => { console.error(e); process.exitCode = 1; });
