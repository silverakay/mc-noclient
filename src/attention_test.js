'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Attention, messageReasons, quietNow } = require('./attention');
const profiles = require('./server_profiles');
const configstore = require('./configstore');
const { HistoryStore } = require('./history_store');
const { ChatActions } = require('./chat_actions');
const { RedPacketAutomation } = require('./red_packet');
const { WelcomeAutomation } = require('./welcome');
const { mainHarness } = require('./connection_lifecycle_test');
const { harness } = require('./connection_ui_test');

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
const roots = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mango-v6-')); roots.push(d); return d; };
process.on('exit', () => { for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true }); });
async function run() {
  await test('New servers never inherit sending, shortcuts, midnight or automatic purchase', () => {
    const cfg = configstore.normalize({ servers: [{ host: 'OLD.EXAMPLE.', port: 25565 }], automation: {
      autoWelcome: true, autoClaimRedPackets: true }, shortcuts: [{ name: 'test', command: '/test' }],
      midnightCommand: { enabled: true, command: '/test' } });
    const old = profiles.effectiveConfig(cfg, 'old.example:25565'), fresh = profiles.effectiveConfig(cfg, 'new.example:25565');
    assert.equal(old.automation.autoWelcome, true); assert.equal(old.autoPurchase, true);
    assert.equal(fresh.automation.autoWelcome, false); assert.equal(fresh.automation.autoClaimRedPackets, false);
    assert.equal(fresh.midnightCommand.enabled, false); assert.equal(fresh.autoPurchase, false);
    assert.deepEqual(fresh.shortcuts, []); assert.equal(cfg.profileMigrationNotice, true);
  });
  await test('Saved profiles are isolated, normalize idempotently and reject invalid notification times', () => {
    const cfg = configstore.normalize(configstore.defaultConfig());
    const a = profiles.effectiveConfig(cfg, 'a:25565'); a.automation.autoWelcome = true;
    a.notifications = { mentions: true, quietStart: 'invalid', quietEnd: '99:99' };
    const saved = configstore.normalize(profiles.saveProfile(a, 'a:25565'));
    assert.equal(profiles.effectiveConfig(saved, 'a:25565').automation.autoWelcome, true);
    assert.equal(profiles.effectiveConfig(saved, 'b:25565').automation.autoWelcome, false);
    assert.deepEqual(configstore.normalize(structuredClone(saved)), saved);
    assert.equal(saved.serverProfiles['a:25565'].notifications.quietStart, '23:00');
  });
  await test('Explicit senders cannot become monitored senders through body substrings', () => {
    const p = { players: true, mentions: true };
    assert.deepEqual(messageReasons({ text: 'Alice: Nan_Koi is offline', sender: 'Alice' }, 'Steve', ['Nan_Koi'], p), []);
    assert.deepEqual(messageReasons({ text: 'Alice: @Steve hello', sender: 'Alice' }, 'Steve', [], p), ['提到我']);
    assert.deepEqual(messageReasons({ text: 'Alice: Steve123', sender: 'Alice' }, 'Steve', [], p), []);
    assert.deepEqual(messageReasons({ text: '[Town]Nan_Koi: hello' }, 'Steve', ['Nan_Koi'], p), ['指定玩家发言']);
    assert.deepEqual(messageReasons({ text: 'Steve: @Steve', sender: 'Steve' }, 'Steve', [], p), []);
  });
  await test('Quiet hours cover midnight, boundaries and an explicitly full-day interval', () => {
    const p = { quiet: true, quietStart: '23:00', quietEnd: '08:00' };
    assert.equal(quietNow(p, new Date(2026, 9, 24, 23).getTime()), true);
    assert.equal(quietNow(p, new Date(2026, 9, 24, 7, 59).getTime()), true);
    assert.equal(quietNow(p, new Date(2026, 9, 24, 8).getTime()), false);
    assert.equal(quietNow({ ...p, quietEnd: '23:00' }, Date.now()), true);
  });
  await test('Action timelines correlate and bound data without counting transitions as new actions', () => {
    let now = 1000; const service = new Attention({ now: () => now }); service.away();
    for (const status of ['detected', 'scheduled', 'sent', 'unconfirmed']) service.ingest('红包', {
      traceId: 'one', status, detail: status, session: 's', serverKey: 'a' });
    service.event('disconnect', 'lost'); service.event('gap', 'sleep'); now += 60000;
    service.important({ messageId: 'message', text: 'hi', serverKey: 'a' }, ['提到我']); service.returned();
    assert.equal(service.snapshot('a').actions.length, 1); assert.equal(service.summary.actions, 1);
    assert.equal(service.summary.messages, 1); assert.equal(service.summary.disconnects, 1); assert.equal(service.summary.gaps, 1);
    service.markRead(); assert.equal(service.unread, 0);
    for (let i = 0; i < 500; i++) service.ingest('欢迎', { traceId: String(i), status: 'skipped', detail: 'off' });
    assert.equal(service.actions.size, 300); assert.equal(service.truncated, true);
  });
  await test('Session cancellation never mislabels an uncertain send as a cancelled unsent action', () => {
    const service = new Attention();
    service.ingest('红包', { traceId: 'a', status: 'sent', session: 's' });
    service.ingest('欢迎', { traceId: 'b', status: 'scheduled', session: 's' });
    service.cancel('s', 'disconnect');
    assert.equal(service.actions.get('a').status, 'unconfirmed'); assert.equal(service.actions.get('b').status, 'cancelled');
  });
  await test('History cursor preserves every message sharing the same timestamp and server/account metadata', () => {
    const store = new HistoryStore({ root: tmp() }), time = Date.now();
    try {
      for (let i = 0; i < 150; i++) store.appendChat({ messageId: String(i), text: '中文 ' + i, t: time, serverKey: 'a', account: 'Tester' });
      let cursor, ids = [];
      for (let i = 0; i < 20; i++) {
        const r = store.read('chat', { cursor, limit: 17, serverKey: 'a', account: 'Tester' });
        ids.push(...r.records.map((v) => v.messageId)); cursor = r.cursor; if (!r.hasMore) break;
      }
      assert.equal(ids.length, 150); assert.equal(new Set(ids).size, 150);
      assert.equal(store.read('chat', { serverKey: 'other' }).records.length, 0);
    } finally { store.close(); }
  });
  await test('History disk errors retain a bounded buffer without recursive error logging', () => {
    const store = new HistoryStore({ root: tmp() }); const oldAppend = fs.appendFileSync;
    try {
      fs.appendFileSync = () => { throw new Error('disk full'); };
      for (let i = 0; i < 60; i++) store.appendChat({ text: 'x'.repeat(65536) });
      assert.ok(store.pendingBytes <= 2 * 1024 * 1024);
    } finally { fs.appendFileSync = oldAppend; store.close(); }
  });
  await test('Detected disabled candidates explain their skip without sending or spending budget', async () => {
    const actions = new ChatActions(), records = []; let sent = 0;
    const client = { state: 'play', username: 'Tester', command: () => { sent++; } };
    const message = { messageId: 'm', session: actions.session, type: 'system', text: '[红包]玩家 Sender 发送了红包 【点击领取】',
      segments: actions.register([{ text: '点击领取', click: { action: 'run_command', value: '/claim' } }]) };
    const packets = new RedPacketAutomation({ actions, onTrace: (r) => records.push(r) });
    await packets.handle(message, client, { enabled: false });
    assert.equal(sent, 0); assert.equal(records[0].traceId, 'm'); assert.equal(records[0].status, 'skipped');
  });
  await test('Production IPC keeps fresh profiles safe, blocks stale saves and removes rehearsal', async () => {
    const h = mainHarness({ dataDir: tmp(), safeProfile: true, config: configstore.normalize(configstore.defaultConfig()) });
    try {
      const select = await h.invoke('profile:select', { host: 'example.invalid', port: 25565 });
      assert.equal(select.config.automation.autoWelcome, false);
      const stale = await h.configure({ ...select.config, __profileKey: 'other:25565' }); assert.equal(stale.ok, false);
      assert.throws(() => h.invoke('attention:rehearse', {})); assert.equal(h.business(), 0);
      assert.equal((await h.invoke('attention:get')).profileKey, 'example.invalid:25565');
    } finally { h.quit(); }
  });
  await test('Auto-read only clears displayed IDs in the current server, leaving racing arrivals unread', () => {
    const service = new Attention();
    service.important({ messageId: 'a', serverKey: 'one', text: 'one' }, ['提到我']);
    service.important({ messageId: 'b', serverKey: 'two', text: 'two' }, ['提到我']);
    const displayed = service.snapshot('one').items.map((item) => item.id);
    service.important({ messageId: 'c', serverKey: 'one', text: 'new' }, ['提到我']);
    assert.equal(service.markRead('one', displayed), true); assert.equal(service.unread, 2);
    const revision = service.revision;
    assert.equal(service.markRead('one', displayed), false); assert.equal(service.revision, revision);
    assert.equal(service.snapshot('two').items[0].read, false);
  });
  await test('Auto-read IPC rejects hidden windows and a stale server scope', async () => {
    for (const focused of [true, false]) {
      const h = mainHarness({ focused, dataDir: tmp(), safeProfile: true, config: configstore.normalize(configstore.defaultConfig()) });
      try {
        await h.invoke('profile:select', { host: 'example.invalid', port: 25565 });
        assert.equal((await h.invoke('attention:read', { profileKey: 'other:25565', ids: [] })).ok, false);
        assert.equal((await h.invoke('attention:read', { profileKey: 'example.invalid:25565', ids: [] })).ok, focused);
      } finally { h.quit(); }
    }
  });
  await test('Suspend cancels live waits and resume closes the old session without sending or reconnecting', async () => {
    const timers = new Map(); let seq = 0;
    const h = mainHarness({ dataDir: tmp(), config: { servers: [], automation: { autoClaimRedPackets: true, autoWelcome: true } },
      claimDelay: { minMs: 1000, maxMs: 1000 }, setTimeout: (fn) => { timers.set(++seq, fn); return seq; },
      clearTimeout: (id) => timers.delete(id) });
    try {
      await h.connect(); const client = h.clients[0]; client.state = 'play'; client.opts.onEvent('join');
      client.opts.onChat('[红包]玩家 Sender 发送了红包 点击领取', { type: 'system', segments: [
        { text: '点击领取', click: { action: 'run_command', value: '/claim' } }] });
      h.suspend(); await h.resume();
      for (const fn of [...timers.values()]) fn(); await new Promise(setImmediate);
      assert.equal(h.business(), 0); assert.equal(h.clients.length, 1); assert.equal(client.state, 'closed');
      const snapshot = await h.invoke('attention:get'); assert.equal(snapshot.availability.connected, false);
      assert.ok(snapshot.actions.every((a) => a.status === 'cancelled' || a.status === 'unconfirmed'));
    } finally { h.quit(); }
  });
  await test('A settings dialog opened for another server cannot silently save its fields into a new profile', async () => {
    const h = await harness();
    await h.eval("cfg.__profileKey = 'a:25565'; populateSettings(); cfg.__profileKey = 'b:25565'; saveSettings({ preventDefault() {} });");
    assert.match(h.node('settings-error').textContent, /服务器已切换/);
  });
  console.log('=== ' + passed + ' V6 attention tests passed ===');
}
run().catch((e) => { console.error(e); process.exitCode = 1; });
