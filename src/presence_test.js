'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { PresenceStore, parsePresence } = require('./presence');
const { mainHarness } = require('./connection_lifecycle_test');
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-presence-test-'));
  const file = path.join(directory, 'presence.jsonl');
  let time = 0;
  const errors = [];
  const store = new PresenceStore(file, { now: () => time, onError: (e) => errors.push(e) });
  return { store, file, directory, errors, at: (t) => { time = t; },
    query: (name = 'MJWENS') => store.query({ host: 'example.invalid', port: 25565, name }) };
}
async function run() {
  await test('Recognizes the exact pasted join/leave format, preserving case', () => {
    assert.deepEqual(parsePresence('[+] Nan_Koi'), { kind: 'join', name: 'Nan_Koi' });
    assert.deepEqual(parsePresence('[-] MJWENS'), { kind: 'leave', name: 'MJWENS' });
    assert.equal(parsePresence('\u00a7a[+] xingye').name, 'xingye');
  });
  await test('Never treats player-spoof messages, rewards or ordinary text as presence', () => {
    for (const text of ['[+] P hello', '[红包]玩家 P 发送', '[+] P has joined', '[+] bad-name']) assert.equal(parsePresence(text), null);
    assert.equal(parsePresence('[+] Tester', 'player'), null);
    assert.equal(parsePresence('[+] Tester', 'actionbar'), null);
  });
  await test('Continuous join-to-leave intervals produce an exact observed duration', () => {
    const f = fixture(); f.store.start('example.invalid', 25565);
    f.at(1000); f.store.record('[+] MJWENS', 'system'); f.at(61000); f.store.record('[-] MJWENS', 'system');
    assert.equal(f.query().totalMs, 60000); assert.equal(f.query().complete, 1);
    assert.equal(f.query().eventCount, 2); assert.equal(f.query().rows[0].status, 'complete');
  });
  await test('A leave seen before its join cannot invent an online start time', () => {
    const f = fixture(); f.store.start('example.invalid'); f.at(1000); f.store.record('[-] MJWENS', 'system');
    assert.equal(f.query().totalMs, 0); assert.equal(f.query().rows[0].start, null);
    assert.equal(f.query().rows[0].status, 'unknown-start');
  });
  await test('An open interval reports unobserved logout, not a complete duration', () => {
    const f = fixture(); f.store.start('example.invalid'); f.at(1000); f.store.record('[+] MJWENS', 'system');
    f.at(61000); assert.equal(f.query().rows[0].status, 'observed-online'); assert.equal(f.query().totalMs, 0);
  });
  await test('Observer disconnect ends observation, never counts time across a gap', () => {
    const f = fixture(); f.store.start('example.invalid'); f.at(1000); f.store.record('[+] MJWENS', 'system');
    f.at(2000); f.store.end(); f.at(999000); f.store.start('example.invalid'); f.store.record('[-] MJWENS', 'system');
    assert.equal(f.query().totalMs, 0); assert.equal(f.query().rows.length, 2);
    assert.equal(f.query().rows[1].status, 'interrupted');
  });
  await test('Duplicate joins retain their events without restarting an interval', () => {
    const f = fixture(); f.store.start('example.invalid'); f.at(1000); f.store.record('[+] MJWENS', 'system');
    f.at(2000); f.store.record('[+] MJWENS', 'system'); f.at(61000); f.store.record('[-] MJWENS', 'system');
    assert.equal(f.query().totalMs, 60000); assert.equal(f.query().eventCount, 3);
  });
  await test('Records survive restart and an abnormal exit cannot claim ongoing presence', () => {
    const f = fixture(); f.store.start('example.invalid'); f.at(1000); f.store.record('[+] MJWENS', 'system');
    const restarted = new PresenceStore(f.file);
    const result = restarted.query({ host: 'example.invalid', name: 'MJWENS' });
    assert.equal(result.rows[0].status, 'interrupted'); assert.equal(result.totalMs, 0);
    assert.match(fs.readFileSync(f.file, 'utf8'), /\[\+\] MJWENS/);
  });
  await test('Closed intervals persist and queries ignore name/host case', () => {
    const f = fixture(); f.store.start('EXAMPLE.INVALID'); f.at(1000); f.store.record('[+] MJWENS', 'system');
    f.at(61000); f.store.record('[-] MJWENS', 'system'); f.store.end();
    const restarted = new PresenceStore(f.file);
    assert.equal(restarted.query({ host: 'example.invalid', name: 'mjwens' }).totalMs, 60000);
  });
  await test('Different servers and ports never combine sessions', () => {
    const f = fixture(); f.store.start('example.invalid', 25566); f.store.record('[+] MJWENS', 'system');
    assert.equal(f.query().eventCount, 0); f.store.start('other.invalid'); f.store.record('[-] MJWENS', 'system');
    assert.equal(f.query().eventCount, 0);
  });
  await test('Player names must match exactly, not as substrings', () => {
    const f = fixture(); f.store.start('example.invalid'); f.store.record('[+] MJWENS_2', 'system');
    assert.equal(f.query().eventCount, 0); assert.equal(f.query('MJWENS_2').eventCount, 1);
  });
  await test('Query validation rejects nonstrings, invalid ports and hostile names', () => {
    const f = fixture();
    for (const query of [null, {}, { host: 'h', name: '../bad' }, { host: 'h', name: 1 }, { host: 'h', name: 'P', port: -1 }]) {
      assert.equal(f.store.query(query).ok, false);
    }
  });
  await test('Corrupt final lines are skipped, retained and isolated before new appends', () => {
    const f = fixture(); f.store.start('example.invalid'); f.at(1000); f.store.record('[+] MJWENS', 'system');
    fs.appendFileSync(f.file, '{"kind":');
    const restarted = new PresenceStore(f.file); restarted.start('example.invalid'); restarted.record('[-] MJWENS', 'system');
    const result = new PresenceStore(f.file).query({ host: 'example.invalid', name: 'MJWENS' });
    assert.equal(result.eventCount, 2); assert.equal(result.totalMs, 0); assert.ok(result.warning);
    assert.match(fs.readFileSync(f.file, 'utf8'), /\{"kind":/);
  });
  await test('Write failures are visible and retained events retry on the next append', () => {
    const f = fixture(); fs.mkdirSync(f.file); f.store.start('example.invalid');
    assert.ok(f.errors.length >= 1); assert.ok(f.query().warning);
    fs.rmdirSync(f.file); f.store.record('[+] MJWENS', 'system');
    assert.equal(f.store.pending.length, 0); assert.equal(f.store.lastError, '');
    assert.equal(fs.readFileSync(f.file, 'utf8').trim().split(/\n+/).length, 2);
  });
  await test('UI result limit retains full totals and all events on disk', () => {
    const f = fixture(); f.store.start('example.invalid');
    for (let i = 0; i < 205; i++) {
      f.at(i * 2000); f.store.record('[+] MJWENS', 'system');
      f.at(i * 2000 + 1000); f.store.record('[-] MJWENS', 'system');
    }
    const result = f.query(); assert.equal(result.rows.length, 200); assert.equal(result.totalRows, 205);
    assert.equal(result.totalMs, 205000); assert.equal(result.eventCount, 410);
  });
  await test('History can be disabled while the in-memory online list remains available', () => {
    const f = fixture();
    const store = new PresenceStore(f.file, { now: () => 1000, persistHistory: false });
    store.start('example.invalid'); store.record('[+] MJWENS', 'system');
    store.updatePlayers([{ name: 'Tester', latency: 12 }]);
    assert.equal(store.getOnline().known, true);
    assert.deepEqual(store.getOnline().players.map((p) => p.name), ['Tester']);
    assert.equal(fs.existsSync(f.file), false);
  });
  await test('Main process records even with chat display disabled and emits presence category only', async () => {
    const f = fixture(); const h = mainHarness({ presence: f.store, config: { behavior: { showChat: false } } });
    await h.connect(); const c = h.clients[0]; c.state = 'play'; c.opts.onEvent('join');
    f.at(1000); c.opts.onChat('[+] MJWENS', { type: 'system' });
    f.at(61000); c.opts.onChat('[-] MJWENS', { type: 'system' });
    assert.equal(f.query().totalMs, 60000); assert.equal(h.chats[0].category, 'presence');
    assert.equal(h.logs.filter((item) => item.text.includes('MJWENS')).length, 0);
    h.disconnect(); c.opts.onChat('[+] MJWENS', { type: 'system' });
    assert.equal(f.query().eventCount, 2); assert.equal(h.business(), 0);
  });
  console.log('=== ' + passed + ' presence tests passed ===');
}
run().catch((e) => { console.error(e); process.exitCode = 1; });
