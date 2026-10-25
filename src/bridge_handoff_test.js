'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');
const { normalizeBridgeFallback, bridgeFallbackAllowed } = require('./bridge_handoff');
const { BridgeClient, BridgeServer } = require('./client_bridge');
const { normalize } = require('./configstore');
const profiles = require('./server_profiles');
const { mainHarness } = require('./connection_lifecycle_test');
const net = require('net');
const { once } = require('events');

const pause = () => new Promise(setImmediate);
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
const directories = [];
process.on('exit', () => { for (const dir of directories) fs.rmSync(dir, { recursive: true, force: true }); });
async function fixture(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mango-handoff-')); directories.push(dir);
  const servers = [], renewals = [];
  const accounts = [{ uuid: 'first-uuid', name: 'Tester' }, { uuid: 'second-uuid', name: 'OtherUser' }];
  let active = accounts[1];
  const auth = { peekCachedAccount: () => active,
    peekCachedAccounts: () => ({ accounts, active }),
    async login(request) {
      renewals.push(request);
      if (options.login) return options.login(request);
      const account = accounts.find((item) => item.uuid === request.accountUuid);
      if (!account) throw new Error('Missing original account');
      return { profile: { id: account.uuid, name: account.name }, accessToken: 'FIXTURE' };
    }, removeCachedAccount(uuid) { const index = accounts.findIndex((item) => item.uuid === uuid); if (index >= 0) accounts.splice(index, 1); } };
  class LocalBridge extends EventEmitter {
    constructor() { super(); this.peer = null; servers.push(this); }
    async start() {}
    async stop() { this.peer?.close(); this.peer = null; if (options.stop) await options.stop(); }
    attach() {
      let seq = 0;
      const frames = [], socket = { destroyed: false, destroy: () => {
        if (socket.destroyed) return; socket.destroyed = true; this.emit('detached', peer);
      } };
      const peer = new BridgeClient(socket, (frame) => { frames.push(frame); return true; }, {
        disconnectEnabled: options.disconnectEnabled !== false,
        offlineStateEnabled: options.offlineStateEnabled !== false, requestTimeout: options.timeout || 100 });
      this.peer = peer; this.emit('attached', peer);
      const state = (data = {}) => peer.receive({ kind: 'state', seq: ++seq, online: true, session: randomUUID(),
        host: 'example.invalid', port: 25565, username: 'Tester', ...data });
      state();
      const offline = (data = {}) => state({ online: false, gameDisconnected: true,
        offlineSession: peer.bridgeTarget?.session, ...data });
      return { peer, frames, state, offline,
        players: () => peer.receive({ kind: 'players', seq: ++seq, session: peer.session, players: [{ name: 'Target' }] }),
        result: (ok = true) => peer.receive({ kind: 'result', seq: ++seq, session: peer.session,
          id: frames.at(-1).id, ok, error: ok ? undefined : 'Game rejected disconnect' }) };
    }
  }
  const config = normalize({ connectionMode: 'bridge', autoLogin: false,
    servers: [{ host: 'example.invalid', port: 25565 }],
    bridgeFallback: options.mode,
    bridgeExit: { enabled: true, player: 'Target' },
    automation: { autoClaimRedPackets: false, autoWelcome: false },
    behavior: { greet: 'MUST_NOT_SEND', commands: ['MUST_NOT_SEND'] } });
  const h = mainHarness({ config, auth, dataDir: dir, BridgeServer: LocalBridge,
    saveFailure: options.saveFailure, connect: options.connect });
  await h.invoke('config:get'); assert.equal((await h.invoke('bridge:start')).ok, true);
  return { ...h, servers, mod: servers[0].attach(), renewals, accounts,
    changeActive: () => { active = accounts[1]; } };
}

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
async function confirmExit(h) { h.mod.players(); await pause(); h.mod.result(); await pause(); }
async function dispose(h) { await h.disconnect(); h.quit(); }

async function run() {
  await test('Scope defaults to bridge exit only and malformed options fail closed', () => {
    assert.equal(normalizeBridgeFallback(), 'exit');
    for (const value of [null, true, 'yes', {}, []]) assert.equal(normalizeBridgeFallback(value), 'off');
    assert.equal(bridgeFallbackAllowed(undefined, 'exit'), true);
    assert.equal(bridgeFallbackAllowed(undefined, 'offline'), false);
    assert.equal(bridgeFallbackAllowed('off', 'exit'), false);
    assert.equal(bridgeFallbackAllowed('offline', 'offline'), true);
  });
  await test('Scope persists separately for each server and normalizes idempotently', () => {
    const config = normalize({ servers: [{ host: 'example.invalid' }], bridgeFallback: 'offline' });
    assert.equal(profiles.effectiveConfig(config, 'example.invalid:25565').bridgeFallback, 'offline');
    assert.equal(profiles.effectiveConfig(config, 'new.invalid:25565').bridgeFallback, 'exit');
    const next = profiles.effectiveConfig(config, 'example.invalid:25565'); next.bridgeFallback = 'off';
    const saved = normalize(profiles.saveProfile(next, 'example.invalid:25565'));
    assert.equal(profiles.effectiveConfig(saved, 'example.invalid:25565').bridgeFallback, 'off');
    assert.deepEqual(normalize(structuredClone(saved)), saved);
  });
  await test('Confirmed bridge exit switches mode and connects the same cached account to the original server once', async () => {
    const h = await fixture();
    try {
      await confirmExit(h);
      assert.equal(h.clients.length, 1); assert.equal(h.renewals.length, 1);
      const request = h.renewals[0]; assert.equal(request.accountUuid, 'first-uuid');
      assert.equal(request.silentOnly, true); assert.equal(request.updateActive, false);
      const client = h.clients[0];
      assert.equal(client.opts.host, 'example.invalid'); assert.equal(client.opts.port, 25565);
      assert.equal(client.opts.profileId, 'first-uuid'); assert.equal(client.opts.username, 'Tester');
      assert.equal((await h.invoke('bridge:status')).mode, 'standalone');
      assert.equal((await h.invoke('bridge:status')).listening, false);
      assert.equal((await h.invoke('config:get')).connectionMode, 'standalone');
      client.state = 'play'; client.opts.onEvent('join');
      for (const timer of [...h.timers]) timer(); await pause();
      assert.equal(h.business(), 0); assert.equal(h.clients.length, 1);
    } finally { await dispose(h); }
  });
  await test('Explicit disabled scope keeps the original stop-without-login behavior', async () => {
    const h = await fixture({ mode: 'off' });
    try { await confirmExit(h); assert.equal(h.clients.length, 0); assert.equal(h.renewals.length, 0);
      assert.equal((await h.invoke('bridge:status')).mode, 'bridge');
    } finally { await dispose(h); }
  });
  await test('Exit-only scope never logs in after an ordinary offline state or a bridge socket loss', async () => {
    for (const detach of [false, true]) {
      const h = await fixture();
      try {
        if (detach) h.mod.peer.close(); else h.mod.offline();
        await pause(); assert.equal(h.clients.length, 0); assert.equal(h.renewals.length, 0);
        assert.equal((await h.invoke('bridge:status')).listening, true);
      } finally { await dispose(h); }
    }
  });
  await test('Offline scope waits through configuration and uses only a confirmed exact game session', async () => {
    const h = await fixture({ mode: 'offline' });
    try {
      h.mod.offline({ gameDisconnected: false }); await pause(); assert.equal(h.clients.length, 0);
      h.mod.offline({ offlineSession: randomUUID() }); await pause(); assert.equal(h.clients.length, 0);
      h.mod.offline(); h.mod.offline(); await pause();
      assert.equal(h.clients.length, 1); assert.equal(h.renewals.length, 1);
      assert.equal((await h.invoke('bridge:status')).mode, 'standalone');
    } finally { await dispose(h); }
  });
  await test('Offline scope cannot interpret a missing capability or a detached socket as game logout', async () => {
    for (const oldMod of [false, true]) {
      const h = await fixture({ mode: 'offline', offlineStateEnabled: !oldMod });
      try {
        if (oldMod) h.mod.offline(); else h.mod.peer.close();
        await pause(); assert.equal(h.clients.length, 0); assert.equal(h.renewals.length, 0);
      } finally { await dispose(h); }
    }
  });
  await test('Offline scope still handles bridge-exit completion', async () => {
    const h = await fixture({ mode: 'offline' });
    try { await confirmExit(h); assert.equal(h.clients.length, 1); assert.equal(h.renewals.length, 1); }
    finally { await dispose(h); }
  });
  await test('Missing capability, failed dispatch, expired request and changed sessions never trigger login', async () => {
    for (const kind of ['unsupported', 'rejected', 'timeout', 'new-session', 'unconfirmed-offline']) {
      const h = await fixture({ disconnectEnabled: kind !== 'unsupported', timeout: 15 });
      try {
        h.mod.players(); await pause();
        if (kind === 'rejected') h.mod.result(false);
        if (kind === 'new-session') h.mod.state();
        if (kind === 'unconfirmed-offline') h.mod.offline({ gameDisconnected: false });
        if (kind === 'timeout') await new Promise((resolve) => setTimeout(resolve, 25));
        await pause(); assert.equal(h.renewals.length, 0, kind); assert.equal(h.clients.length, 0, kind);
      } finally { await dispose(h); }
    }
  });
  await test('Confirmed offline evidence resolves a pending game exit before its execution result', async () => {
    const h = await fixture();
    try { h.mod.players(); await pause(); h.mod.offline(); await pause();
      assert.equal(h.clients.length, 1); assert.equal(h.mod.frames.length, 1);
    } finally { await dispose(h); }
  });
  await test('A new game session arriving immediately after the exit result prevents standalone takeover', async () => {
    const h = await fixture();
    try {
      h.mod.players(); await pause(); h.mod.result(); h.mod.state(); await pause();
      assert.equal(h.clients.length, 0); assert.equal(h.renewals.length, 0);
    } finally { await dispose(h); }
  });
  await test('Absent original credentials never fall back to another cached account', async () => {
    const h = await fixture();
    try {
      h.accounts.splice(0, 1); await confirmExit(h);
      assert.equal(h.clients.length, 0); assert.equal(h.renewals.length, 0);
      assert.ok(h.logs.some((log) => log.text.includes('独立接管未启动')));
    } finally { await dispose(h); }
  });
  await test('Shared active-account changes cannot redirect the handoff', async () => {
    const h = await fixture();
    try { h.changeActive(); await confirmExit(h); assert.equal(h.renewals[0].accountUuid, 'first-uuid'); }
    finally { await dispose(h); }
  });
  await test('Incorrect renewed UUID and a temporary renewal failure create no connection or retry', async () => {
    for (const mismatch of [false, true]) {
      const h = await fixture({ login: async () => {
        if (!mismatch) throw Object.assign(new Error('Temporary auth error'), { temporary: true });
        return { profile: { id: 'second-uuid', name: 'OtherUser' }, accessToken: 'FIXTURE' };
      } });
      try { await confirmExit(h); assert.equal(h.clients.length, 0); assert.equal(h.renewals.length, 1); }
      finally { await dispose(h); }
    }
  });
  await test('Paused automation and configuration write failure leave the game offline without login', async () => {
    for (const failure of ['pause', 'save']) {
      let saveFailure = false;
      const h = await fixture({ saveFailure: () => saveFailure ? 'Disk full' : null });
      try {
        const cfg = await h.invoke('config:get');
        if (failure === 'pause') h.configure({ ...cfg, automation: { ...cfg.automation, paused: true } });
        else saveFailure = true;
        await confirmExit(h); assert.equal(h.clients.length, 0); assert.equal(h.renewals.length, 0);
        if (failure === 'save') assert.ok(h.logs.some((log) => log.text.includes('模式保存失败')));
      } finally { await dispose(h); }
    }
  });
  await test('Logout, process quit and suspension cancel a pending exit handoff', async () => {
    for (const action of ['logout', 'quit', 'suspend']) {
      const h = await fixture();
      try { h.mod.players(); await pause(); await h[action]();
        if (h.mod.peer.state === 'play') h.mod.result(); await pause();
        assert.equal(h.clients.length, 0); assert.equal(h.renewals.length, 0);
      } finally { await dispose(h); }
    }
  });
  await test('Disconnect, server switch or scope disable while listener shutdown waits cancels handoff', async () => {
    for (const action of ['disconnect', 'off', 'server']) {
      const gate = deferred(); let stops = 0;
      const h = await fixture({ stop: () => ++stops === 1 ? gate.promise : undefined });
      try {
        h.mod.offline(); // Exit-only mode keeps waiting; trigger a real exit in a fresh session.
        h.mod.state(); h.mod.players(); await pause(); h.mod.result(); await pause();
        if (action === 'disconnect') await h.disconnect();
        else if (action === 'server') assert.equal(h.invoke('profile:select', { host: 'other.invalid', port: 25565 }).ok, true);
        else { const cfg = await h.invoke('config:get'); h.configure({ ...cfg, bridgeFallback: 'off' }); }
        gate.resolve(); await pause(); assert.equal(h.clients.length, 0); assert.equal(h.renewals.length, 0);
      } finally { gate.resolve(); await dispose(h); }
    }
  });
  await test('Manual cancellation during credential renewal prevents a late standalone connection', async () => {
    const gate = deferred(); const h = await fixture({ login: () => gate.promise });
    try {
      h.mod.players(); await pause(); h.mod.result(); await pause(); assert.equal(h.renewals.length, 1);
      await h.disconnect();
      gate.resolve({ profile: { id: 'first-uuid', name: 'Tester' }, accessToken: 'FIXTURE' });
      await pause(); assert.equal(h.clients.length, 0);
    } finally { await dispose(h); }
  });
  await test('Disabling handoff, pausing automation or suspending during renewal prevents late login', async () => {
    for (const action of ['off', 'pause', 'suspend']) {
      const gate = deferred(), h = await fixture({ login: () => gate.promise });
      try {
        h.mod.players(); await pause(); h.mod.result(); await pause(); assert.equal(h.renewals.length, 1);
        if (action === 'suspend') h.suspend();
        else {
          const cfg = await h.invoke('config:get');
          h.configure(action === 'off' ? { ...cfg, bridgeFallback: 'off' }
            : { ...cfg, automation: { ...cfg.automation, paused: true } });
        }
        gate.resolve({ profile: { id: 'first-uuid', name: 'Tester' }, accessToken: 'FIXTURE' });
        await pause(); assert.equal(h.clients.length, 0, action);
      } finally { gate.resolve({ profile: { id: 'first-uuid', name: 'Tester' }, accessToken: 'FIXTURE' }); await dispose(h); }
    }
  });
  await test('Invalid configuration scope is rejected by settings IPC', async () => {
    const h = await fixture();
    try { const cfg = await h.invoke('config:get'); assert.equal(h.configure({ ...cfg, bridgeFallback: true }).ok, false); }
    finally { await dispose(h); }
  });
  await test('Offline capability negotiation accepts only a real boolean', async () => {
    for (const value of [true, false, 'true', 1]) {
      const server = new BridgeServer(); const port = await server.start({ port: 0, token: 'a'.repeat(64) });
      const socket = net.createConnection({ host: '127.0.0.1', port });
      try {
        await once(socket, 'connect'); const attached = once(server, 'attached');
        socket.write(JSON.stringify({ kind: 'hello', version: 1, token: 'a'.repeat(64), features: { offlineState: value } }) + '\n');
        const [peer] = await attached; assert.equal(peer.offlineStateEnabled, value === true);
      } finally { socket.destroy(); await server.stop(); }
    }
  });
  console.log('=== ' + passed + ' bridge handoff tests passed ===');
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
