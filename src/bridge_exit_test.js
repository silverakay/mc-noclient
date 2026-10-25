'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { once, EventEmitter } = require('events');
const { randomUUID } = require('crypto');
const { BridgeExitGuard, normalizeBridgeExit } = require('./bridge_exit');
const { BridgeClient, BridgeServer } = require('./client_bridge');
const { normalize } = require('./configstore');
const { mainHarness } = require('./connection_lifecycle_test');

let passed = 0;
const roots = [];
const pause = () => new Promise(setImmediate);
const tmp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mango-exit-')); roots.push(dir); return dir; };
process.on('exit', () => { for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true }); });
async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name); }

async function fixture(options = {}) {
  const servers = [];
  class LocalBridge extends EventEmitter {
    constructor() { super(); servers.push(this); this.stops = 0; this.peer = null; }
    async start() {}
    async stop() { this.stops++; if (this.peer) this.peer.close(); this.peer = null; }
    attach() {
      const frames = [];
      let peer, seq = 0;
      const socket = { destroyed: false, destroy: () => {
        if (socket.destroyed) return;
        socket.destroyed = true; this.emit('detached', peer);
      } };
      peer = new BridgeClient(socket, (frame) => { frames.push(frame); return true; }, {
        disconnectEnabled: options.supported !== false, offlineStateEnabled: true, requestTimeout: options.timeout || 200 });
      this.peer = peer; this.emit('attached', peer);
      const state = (extra = {}) => peer.receive({ kind: 'state', seq: ++seq, online: true, session: randomUUID(),
        host: 'example.invalid', port: 25565, username: 'Tester', ...extra });
      const players = (names) => peer.receive({ kind: 'players', seq: ++seq, session: peer.session,
        players: names.map((name) => ({ name, latency: 5 })) });
      const chat = (text) => peer.receive({ kind: 'chat', seq: ++seq, session: peer.session, source: 'system', runs: [{ text }] });
      const result = (ok = true) => peer.receive({ kind: 'result', seq: ++seq, session: peer.session,
        id: frames.at(-1).id, ok, error: ok ? undefined : 'Selected player is no longer online' });
      state();
      return { peer, frames, state, players, chat, result };
    }
  }
  const config = normalize({ connectionMode: 'bridge', autoLogin: false, servers: [{ host: 'example.invalid', port: 25565 }],
    automation: { autoClaimRedPackets: false, autoWelcome: false }, monitoredPlayers: ['mango0v0'],
    bridgeFallback: 'off',
    bridgeExit: { enabled: options.enabled !== false, ...(options.players ? { players: options.players } : { player: 'mango0v0' }) } });
  if (options.accountConfigs) config.accountConfigs = options.accountConfigs;
  const h = mainHarness({ config, dataDir: tmp(), BridgeServer: LocalBridge, auth: options.auth });
  await h.invoke('config:get'); assert.equal((await h.invoke('bridge:start')).ok, true);
  return { ...h, servers, mod: servers[0].attach() };
}

async function run() {
  await test('Rules default off and require a real account ID; 0 and O are never conflated', () => {
    assert.deepEqual(normalizeBridgeExit(), { enabled: false, players: [] });
    assert.deepEqual(normalizeBridgeExit({ enabled: true, player: ' mango0v0 ' }), { enabled: true, players: ['mango0v0'] });
    for (const player of ['@mango0v0', 'mango0v0\nOther', '中文', 'TooLongPlayerName123']) {
      assert.equal(normalizeBridgeExit({ enabled: true, player }).enabled, false);
    }
  });
  await test('Multiple targets deduplicate by exact case-insensitive ID, migrate old rules and stay bounded', () => {
    assert.deepEqual(normalizeBridgeExit({ enabled: true, players: [' Alice ', 'ALICE', 'Bob', '@bad', 'mango0v0', 'mangoOvO'] }),
      { enabled: true, players: ['Alice', 'Bob', 'mango0v0', 'mangoOvO'] });
    assert.deepEqual(normalizeBridgeExit({ enabled: true, player: 'Legacy', players: [] }), { enabled: false, players: [] });
    assert.equal(normalizeBridgeExit({ players: Array.from({ length: 30 }, (_, i) => 'Player' + i) }).players.length, 16);
  });
  await test('Any of three targets can trigger once; two online targets do not duplicate the request', async () => {
    const h = await fixture({ players: ['Alice', 'Bob', 'Carol'] });
    try {
      h.mod.players(['Other', 'bOB', 'Carol']); await pause();
      assert.equal(h.mod.frames.length, 1); assert.equal(h.mod.frames[0].player, 'bOB');
      h.mod.result(); await pause(); assert.equal((await h.invoke('bridge:status')).listening, false);
    } finally { h.quit(); }
  });
  await test('Game bridge uses the actual game account settings, not the other selected cached account', async () => {
    const accounts = [{ uuid: 'first-uuid', name: 'OtherUser' }, { uuid: 'second-uuid', name: 'Tester' }];
    const auth = { peekCachedAccount: () => accounts[0], peekCachedAccounts: () => ({ accounts, activeUuid: 'first-uuid', active: accounts[0] }) };
    const h = await fixture({ auth, accountConfigs: {
      'first-uuid': normalize({ connectionMode: 'bridge', servers: [{ host: 'example.invalid' }], bridgeExit: { enabled: true, players: ['Alice'] } }),
      'second-uuid': normalize({ connectionMode: 'bridge', servers: [{ host: 'example.invalid' }], bridgeExit: { enabled: true, players: ['Bob', 'Carol'] } }),
    } });
    try {
      assert.equal((await h.invoke('config:get')).__accountKey, 'second-uuid');
      h.mod.players(['Alice']); await pause(); assert.equal(h.mod.frames.length, 0);
      h.mod.players(['Carol']); await pause(); assert.equal(h.mod.frames.length, 1);
      assert.equal(h.mod.frames[0].player, 'Carol'); h.mod.result(); await pause();
    } finally { h.quit(); }
  });
  await test('A current online snapshot triggers exactly once per game session, including an already-online target', async () => {
    const calls = [], peer = { state: 'play', session: 'a', players: [{ name: 'MaNgO0v0' }] };
    const guard = new BridgeExitGuard({ trigger: (p, name) => calls.push(name) });
    const policy = { enabled: true, player: 'mango0v0' };
    assert.equal(guard.observe(peer, policy), true); assert.equal(guard.observe(peer, policy), false); await pause();
    assert.deepEqual(calls, ['MaNgO0v0']);
    peer.session = 'b'; assert.equal(guard.observe(peer, policy), true); await pause(); assert.equal(calls.length, 2);
  });
  await test('Missing evidence, disabled rules, substrings, lookalikes and a stale queued session cannot disconnect', async () => {
    let calls = 0; const guard = new BridgeExitGuard({ trigger: () => calls++ });
    const peer = { state: 'play', session: 'a', players: [{ name: 'xmango0v0' }, { name: 'mangoOvO' }] };
    const policy = { enabled: true, player: 'mango0v0' };
    assert.equal(guard.observe(peer, policy), false);
    peer.players = [{ name: 'mango0v0' }]; assert.equal(guard.observe(peer, { ...policy, enabled: false }), false);
    assert.equal(guard.observe(peer, policy), true); peer.session = 'new-session'; await pause(); assert.equal(calls, 0);
  });
  await test('Bridge request requires capability and preserves target, session, link and deadline without commands', async () => {
    const frames = [], socket = { destroyed: false, destroy() { this.destroyed = true; } };
    const peer = new BridgeClient(socket, (f) => { frames.push(f); return true; });
    peer.receive({ kind: 'state', seq: 1, online: true, session: randomUUID(), host: 'example.invalid', port: 25565, username: 'Tester' });
    assert.equal((await peer.disconnectGame('mango0v0')).ok, false); assert.equal(frames.length, 0);
    peer.disconnectEnabled = true; peer.offlineStateEnabled = true;
    const pending = peer.disconnectGame('mango0v0');
    assert.equal(frames[0].control, 'disconnect'); assert.equal(frames[0].player, 'mango0v0');
    assert.equal(frames[0].session, peer.session); assert.equal(frames[0].link, peer.link);
    assert.equal(frames[0].manual, undefined); assert.ok(frames[0].expiresAt > Date.now());
    peer.receive({ kind: 'state', seq: 2, online: false, gameDisconnected: true, offlineSession: peer.session });
    assert.equal((await pending).disconnected, true); peer.close();
  });
  await test('Player UUID senders from older mods resolve to the real account name rather than a guessed body prefix', () => {
    const peer = new BridgeClient({ destroyed: false, destroy() {} }, () => true);
    const session = randomUUID(), uuid = randomUUID(); let captured;
    peer.on('chat', (text, meta) => { captured = meta; });
    peer.receive({ kind: 'state', seq: 1, online: true, session, host: 'example.invalid', port: 25565, username: 'Tester' });
    peer.receive({ kind: 'players', seq: 2, session, players: [{ name: 'mango0v0', uuid }] });
    peer.receive({ kind: 'chat', seq: 3, session, source: 'player', sender: uuid, runs: [{ text: 'decorated nickname: hi' }] });
    assert.equal(captured.sender, 'mango0v0'); assert.equal(captured.uuid, uuid); peer.close();
  });
  await test('Disconnect negotiation is strict and old mods remain unsupported', async () => {
    const bridge = new BridgeServer(); await bridge.start({ port: 0, token: 'a'.repeat(64) });
    const socket = net.createConnection({ host: '127.0.0.1', port: bridge.server.address().port });
    try {
      await once(socket, 'connect');
      const attached = once(bridge, 'attached');
      socket.write(JSON.stringify({ kind: 'hello', version: 1, token: 'a'.repeat(64), features: { disconnectGame: 'true' } }) + '\n');
      const [peer] = await attached; assert.equal(peer.disconnectEnabled, false);
    } finally { socket.destroy(); await bridge.stop(); }
  });
  await test('Live bridge exits once and stops its listener and reconnect controller after a game acknowledgement', async () => {
    const h = await fixture();
    try {
      h.mod.players(['Tester', 'mango0v0']); h.mod.players(['mango0v0']); await pause();
      assert.equal(h.mod.frames.length, 1); assert.equal(h.mod.frames[0].control, 'disconnect');
      assert.equal((await h.invoke('bridge:status')).exiting, true);
      assert.equal((await h.invoke('client:say', 'must not send')).ok, false);
      h.mod.result(); await pause();
      const status = await h.invoke('bridge:status'); assert.equal(status.listening, false); assert.equal(status.online, false);
      assert.equal(h.servers[0].stops, 1); assert.equal(h.clients.length, 0); assert.equal(h.business(), 0);
      for (const fn of h.timers) fn(); await pause();
      assert.equal(h.servers.length, 1); assert.equal(h.clients.length, 0);
      assert.ok(h.logs.some((r) => r.text === '游戏已执行下线，不自动重连'));
      assert.equal((await h.invoke('bridge:start')).ok, true, 'Explicit manual restart is still allowed');
    } finally { h.quit(); }
  });
  await test('A natural offline state confirms the goal even when it arrives before the execute result', async () => {
    const h = await fixture();
    try {
      h.mod.players(['mango0v0']); await pause();
      h.mod.state({ online: false, gameDisconnected: true, offlineSession: h.mod.peer.session }); await pause();
      assert.equal((await h.invoke('bridge:status')).listening, false);
      assert.ok(h.logs.some((r) => r.text === '游戏已执行下线，不自动重连'));
    } finally { h.quit(); }
  });
  await test('A missing capability, rejected stale list or timeout never claims the game exited and never retries', async () => {
    for (const options of [{ supported: false }, { rejected: true }, { timeout: 15 }]) {
      const h = await fixture(options);
      try {
        h.mod.players(['mango0v0']); await pause();
        if (options.rejected) h.mod.result(false);
        if (options.timeout) await new Promise((resolve) => setTimeout(resolve, 25));
        await pause();
        assert.equal((await h.invoke('bridge:status')).listening, false);
        assert.ok(h.logs.some((r) => r.level === 'error' && r.text.includes('下线未确认')));
        assert.equal(h.logs.some((r) => r.text === '游戏已执行下线，不自动重连'), false);
        assert.equal(h.mod.frames.length, options.supported === false ? 0 : 1);
        for (const fn of h.timers) fn(); await pause(); assert.equal(h.servers.length, 1);
      } finally { h.quit(); }
    }
  });
  await test('Merely mentioning, at-mentioning, banning or announcing a name cannot cause logout', async () => {
    const h = await fixture();
    try {
      for (const text of ['mango0v0: hello', 'Alice: @mango0v0 hi', 'Steve 被 mango0v0 封禁', '[+] mango0v0']) h.mod.chat(text);
      await pause(); assert.equal(h.mod.frames.length, 0); assert.equal((await h.invoke('bridge:status')).online, true);
      assert.equal(h.logs.filter((r) => r.level === 'chat').length, 4);
    } finally { h.quit(); }
  });
  await test('Enabling on a current snapshot acts immediately, but a changed or disabled policy cancels a queued trigger', async () => {
    const h = await fixture({ enabled: false });
    try {
      h.mod.players(['mango0v0']); await pause(); assert.equal(h.mod.frames.length, 0);
      const cfg = await h.invoke('config:get');
      assert.equal(h.configure({ ...cfg, bridgeExit: { enabled: true, player: 'mango0v0' } }).ok, true);
      await pause(); assert.equal(h.mod.frames.length, 1); h.mod.result(); await pause();
    } finally { h.quit(); }
    const other = await fixture();
    try {
      other.mod.players(['mango0v0']);
      // The settings save occurs before the queued trigger's microtask.
      const cfg = normalize({ connectionMode: 'bridge', servers: [{ host: 'example.invalid', port: 25565 }],
        bridgeExit: { enabled: false, player: 'mango0v0' } });
      assert.equal(other.configure(cfg).ok, true); await pause(); assert.equal(other.mod.frames.length, 0);
    } finally { other.quit(); }
  });
  await test('Changing game sessions during a pending request drops it without replay into the new game', async () => {
    const h = await fixture();
    try {
      h.mod.players(['mango0v0']); await pause(); h.mod.state(); await pause();
      assert.equal(h.mod.frames.length, 1); assert.equal((await h.invoke('bridge:status')).listening, false);
      assert.equal(h.logs.some((r) => r.text === '游戏已执行下线，不自动重连'), false);
    } finally { h.quit(); }
  });
  console.log('=== ' + passed + ' bridge exit tests passed ===');
}
run().catch((e) => { console.error(e); process.exitCode = 1; });
