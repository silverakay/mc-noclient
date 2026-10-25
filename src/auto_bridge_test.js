'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');
const { BridgeClient, pairing } = require('./client_bridge');
const { mainHarness } = require('./connection_lifecycle_test');
const { normalize } = require('./configstore');
const { isDuplicateLoginReason } = require('./reconnect');

const pause = () => new Promise(setImmediate);
function deferred() {
  let resolve;
  return { promise: new Promise((done) => { resolve = done; }), resolve: (value) => resolve(value) };
}
function clock() {
  let now = 0, id = 0;
  const tasks = new Map();
  return {
    now: () => now, tasks,
    set: (fn, delay) => { tasks.set(++id, { fn, at: now + delay }); return id; },
    clear: (key) => tasks.delete(key),
    jump: (ms) => { now += ms; },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...tasks].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        tasks.delete(next[0]); now = next[1].at; await next[1].fn(); await pause();
      }
      now = end;
    },
  };
}

function fixture(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-auto-bridge-'));
  const file = path.join(dir, 'bridge-pairing.json');
  if (!options.missing) pairing(file);
  if (options.damaged) fs.writeFileSync(file, '{');
  const c = clock(), servers = [];
  class FakeDate extends Date { static now() { return c.now(); } }
  class LocalBridge extends EventEmitter {
    constructor() { super(); this.peer = null; this.stops = 0; servers.push(this); }
    async start(config) {
      this.config = config;
      if (options.startError) throw new Error(options.startError);
      if (options.start) await options.start(this);
    }
    async stop() { this.stops++; if (this.peer) this.peer.close(); this.peer = null; }
    attach() {
      const socket = { destroyed: false, destroy: () => {
        if (socket.destroyed) return;
        socket.destroyed = true; this.peer = null; this.emit('detached', peer);
      } };
      const frames = [];
      const peer = new BridgeClient(socket, (frame) => { frames.push(frame); return true; });
      this.peer = peer; this.emit('attached', peer);
      let seq = 0;
      const state = (value = {}) => peer.receive({ kind: 'state', seq: ++seq, online: true,
        session: randomUUID(), username: 'Tester', host: 'example.invalid', port: 25565, ...value });
      return { peer, state, frames };
    }
  }
  let logins = 0;
  const h = mainHarness({ dataDir: dir, BridgeServer: LocalBridge, Date: FakeDate,
    setTimeout: c.set, clearTimeout: c.clear, saveFailure: options.saveFailure,
    connect: options.connect,
    config: normalize({ autoLogin: false, servers: [], reconnect: { enabled: options.reconnect !== false },
      behavior: { greet: 'MUST_NOT_SEND', commands: ['MUST_NOT_SEND'] } }),
    login: async () => { logins++; return { profile: { name: 'Tester', id: '0'.repeat(32) }, accessToken: 'FIXTURE' }; },
  });
  const kick = (reason = 'multiplayer.disconnect.duplicate_login', event = 'kick') => {
    h.clients.at(-1).opts.onEvent(event, reason);
  };
  return { ...h, c, servers, file, dir, kick, logins: () => logins };
}
async function connected(h, premium = false) {
  assert.equal((await h.connect(premium)).ok, true);
  const client = h.clients.at(-1); client.state = 'play'; client.opts.onEvent('join');
  return client;
}

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('PASS ' + name); }
  catch (e) { failed++; console.error('FAIL ' + name + '\n' + e.stack); }
}
async function run() {
  await test('Duplicate classification is shared by retry stopping and automatic handoff', () => {
    for (const reason of ['multiplayer.disconnect.duplicate_login', 'Already connected',
      'You logged in from another location', '\u4f60\u5df2\u5728\u5f02\u5730\u767b\u5f55', '\u8d26\u53f7\u5df2\u5728\u7ebf']) {
      assert.equal(isDuplicateLoginReason(reason), true);
    }
    for (const reason of ['ECONNRESET', 'Server maintenance', 'You are banned', 'Invalid session']) {
      assert.equal(isDuplicateLoginReason(reason), false);
    }
  });
  await test('Duplicate kick switches and saves bridge mode without a second login or greeting', async () => {
    const h = fixture(); const old = await connected(h, true);
    const saved = fs.readFileSync(h.file, 'utf8');
    h.kick(); await pause();
    const state = await h.invoke('bridge:status');
    assert.equal(state.mode, 'bridge'); assert.equal(state.listening, true); assert.equal(state.detecting, true);
    assert.equal(old.state, 'closed'); assert.equal(h.logins(), 1); assert.equal(h.servers.length, 1);
    assert.equal((await h.invoke('config:get')).connectionMode, 'bridge');
    assert.equal(fs.readFileSync(h.file, 'utf8'), saved, 'Existing token must not rotate');
    assert.equal((await h.connect(true)).ok, false); assert.equal(h.logins(), 1);
    const mod = h.servers[0].attach(); mod.state({ username: 'tEsTeR' });
    await h.c.advance(600000);
    assert.equal((await h.invoke('bridge:status')).online, true);
    assert.equal((await h.invoke('bridge:status')).detecting, false);
    assert.equal(h.clients.length, 1); assert.equal(h.business(), 0); assert.equal(mod.frames.length, 0);
    await h.disconnect();
  });
  await test('Absent game stops exactly at 30 seconds and never falls back to independent login', async () => {
    const h = fixture(); await connected(h); h.kick(); await pause();
    await h.c.advance(29999); assert.equal((await h.invoke('bridge:status')).listening, true);
    await h.c.advance(1);
    assert.equal((await h.invoke('bridge:status')).listening, false);
    assert.equal((await h.invoke('bridge:status')).mode, 'bridge');
    assert.equal(h.servers[0].stops, 1); assert.equal(h.statuses.at(-1).state, 'idle');
    await h.c.advance(600000); assert.equal(h.clients.length, 1); assert.equal(h.business(), 0);
    assert.ok(h.logs.some((l) => /30 \u79d2.*\u5df2\u505c\u6b62/.test(l.text)));
  });
  await test('A paired Mod on the menu is not a successful online detection', async () => {
    const h = fixture(); await connected(h); h.kick(); await pause();
    const mod = h.servers[0].attach(); mod.state({ online: false });
    assert.equal((await h.invoke('bridge:status')).paired, true);
    assert.equal((await h.invoke('bridge:status')).online, false);
    await h.c.advance(30000);
    assert.equal((await h.invoke('bridge:status')).listening, false); assert.equal(mod.peer.socket.destroyed, true);
  });
  await test('An offline paired game can finish joining within the original detection window', async () => {
    const h = fixture(); await connected(h); h.kick(); await pause();
    const mod = h.servers[0].attach(); mod.state({ online: false });
    await h.c.advance(10000); mod.state(); await h.c.advance(10000);
    assert.equal((await h.invoke('bridge:status')).online, true); await h.disconnect();
  });
  await test('A different local account cannot take over the kicked account', async () => {
    const h = fixture(); await connected(h); h.kick(); await pause();
    const wrong = h.servers[0].attach(); wrong.state({ username: 'OtherPlayer' });
    assert.equal(wrong.peer.socket.destroyed, true); assert.equal((await h.invoke('bridge:status')).online, false);
    const correct = h.servers[0].attach(); correct.state();
    assert.equal((await h.invoke('bridge:status')).online, true); await h.disconnect();
  });
  await test('State received after deadline cannot win a delayed timer race', async () => {
    const h = fixture(); await connected(h); h.kick(); await pause();
    const mod = h.servers[0].attach(); h.c.jump(30000); mod.state(); await pause();
    assert.equal((await h.invoke('bridge:status')).online, false);
    assert.equal((await h.invoke('bridge:status')).listening, false);
    assert.equal(h.statuses.some((p) => p.connectionMode === 'bridge' && p.connected === true), false);
  });
  for (const option of ['missing', 'damaged']) await test(option + ' pairing stops without creating or repairing credentials', async () => {
    const h = fixture({ [option]: true }); await connected(h); h.kick(); await pause();
    assert.equal((await h.invoke('bridge:status')).listening, false);
    assert.equal(h.servers[0].config, undefined);
    if (option === 'missing') assert.equal(fs.existsSync(h.file), false);
    else assert.equal(fs.readFileSync(h.file, 'utf8'), '{');
    await h.c.advance(60000); assert.equal(h.clients.length, 1); assert.equal(h.business(), 0);
  });
  await test('Mode save failure stops recovery and never opens a local bridge', async () => {
    const h = fixture({ saveFailure: 'Disk full' }); await connected(h); h.kick(); await pause();
    assert.equal(h.servers.length, 0); await h.c.advance(600000); assert.equal(h.clients.length, 1);
    assert.ok(h.logs.some((l) => /Disk full/.test(l.text)));
  });
  await test('An occupied bridge port fails closed and clears the detection timer', async () => {
    const h = fixture({ startError: 'EADDRINUSE' }); await connected(h); h.kick(); await pause();
    assert.equal((await h.invoke('bridge:status')).listening, false);
    assert.equal([...h.c.tasks.values()].some((t) => t.at === 30000), false);
    await h.c.advance(600000); assert.equal(h.clients.length, 1);
  });
  await test('Ordinary disconnect, maintenance and bans do not automatically select bridge mode', async () => {
    for (const [event, reason] of [['close', 'multiplayer.disconnect.duplicate_login'],
      ['close', 'ECONNRESET'], ['kick', 'Maintenance 10 minutes'], ['kick', 'You are banned']]) {
      const h = fixture(); await connected(h); h.kick(reason, event); await pause();
      assert.equal(h.servers.length, 0, reason); assert.equal((await h.invoke('bridge:status')).mode, 'standalone');
      await h.disconnect();
    }
  });
  for (const method of ['disconnect', 'logout', 'quit']) await test(method + ' cancels automatic detection and stale callbacks', async () => {
    const h = fixture(); const old = await connected(h); h.kick(); await pause();
    const timer = [...h.c.tasks.values()].find((t) => t.at === 30000).fn;
    const mod = h.servers[0].attach(); await h[method](); await pause();
    const count = h.statuses.length; mod.state(); old.opts.onEvent('kick', 'duplicate_login'); await timer();
    await h.c.advance(600000);
    assert.equal(h.statuses.length, count); assert.equal((await h.invoke('bridge:status')).listening, false);
    assert.equal(h.clients.length, 1); assert.equal(h.business(), 0);
  });
  await test('Switching back to independent mode cancels detection but does not reconnect by itself', async () => {
    const h = fixture(); await connected(h); h.kick(); await pause();
    assert.equal((await h.invoke('client:mode', 'standalone')).ok, true);
    await h.c.advance(600000); assert.equal(h.clients.length, 1);
    assert.equal((await h.invoke('bridge:status')).listening, false);
  });
  await test('A stale detection timeout cannot stop a new manually started bridge', async () => {
    const h = fixture(); await connected(h); h.kick(); await pause();
    const timer = [...h.c.tasks.values()].find((t) => t.at === 30000).fn;
    await h.disconnect(); assert.equal((await h.invoke('bridge:start')).ok, true);
    await timer(); await h.c.advance(600000);
    assert.equal((await h.invoke('bridge:status')).listening, true);
    assert.equal((await h.invoke('bridge:status')).detecting, false); await h.disconnect();
  });
  await test('Cancelling a pending listener permits a new one without stale startup status', async () => {
    const request = deferred(); let calls = 0;
    const h = fixture({ start: () => ++calls === 1 ? request.promise : Promise.resolve() });
    await connected(h); h.kick(); await pause(); await h.disconnect();
    assert.equal((await h.invoke('bridge:start')).ok, true);
    const count = h.statuses.length; request.resolve(); await pause();
    assert.equal(h.statuses.length, count); assert.equal((await h.invoke('bridge:status')).listening, true);
    await h.disconnect();
  });
  await test('Pending listener has the same bounded detection deadline', async () => {
    const request = deferred(); const h = fixture({ start: () => request.promise });
    await connected(h); h.kick(); await pause(); await h.c.advance(30000);
    assert.equal((await h.invoke('bridge:status')).listening, false);
    request.resolve(); await pause(); assert.equal(h.statuses.at(-1).state, 'idle');
  });
  await test('A duplicate rejection during in-flight TCP setup cannot revive the old client', async () => {
    const request = deferred(); const h = fixture({ connect: () => request.promise });
    const connecting = h.connect(); h.kick(); await pause();
    const mod = h.servers[0].attach(); mod.state(); request.resolve();
    assert.equal((await connecting).ok, false); assert.equal((await h.invoke('bridge:status')).online, true);
    assert.equal(h.clients.length, 1); await h.disconnect();
  });
  await test('Automatic handoff is independent of network-reconnect settings', async () => {
    const h = fixture({ reconnect: false }); await connected(h); h.kick(); await pause();
    assert.equal((await h.invoke('bridge:status')).detecting, true); await h.disconnect();
  });
  await test('Duplicate kick during network recovery cancels the running retry epoch', async () => {
    const h = fixture(); const old = await connected(h);
    old.opts.onEvent('close', 'ECONNRESET'); await h.c.advance(5000);
    assert.equal(h.clients.length, 2); h.kick(); await pause();
    const mod = h.servers[0].attach(); mod.state(); await h.c.advance(600000);
    assert.equal(h.clients.length, 2); assert.equal((await h.invoke('bridge:status')).online, true);
    assert.equal(h.statuses.filter((p) => p.reconnect).at(-1).reconnect.phase, 'idle');
    await h.disconnect();
  });
  await test('A runtime local listener fault stops initial detection without a server reconnect', async () => {
    const h = fixture(); await connected(h); h.kick(); await pause();
    h.servers[0].emit('fault', new Error('Local listener failed')); await pause();
    assert.equal((await h.invoke('bridge:status')).listening, false);
    await h.c.advance(600000); assert.equal(h.clients.length, 1);
  });
  console.log('=== Result: ' + passed + ' passed / ' + failed + ' failed ===');
  process.exitCode = failed ? 1 : 0;
}
run().catch((e) => { console.error(e); process.exitCode = 1; });
