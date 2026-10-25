'use strict';

const assert = require('assert/strict');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { once } = require('events');
const { randomUUID } = require('crypto');
const { BridgeServer, BridgeClient, pairing, MAX_FRAME } = require('./client_bridge');
const { ChatActions } = require('./chat_actions');
const { RedPacketAutomation } = require('./red_packet');
const { mainHarness } = require('./connection_lifecycle_test');
const { normalize } = require('./configstore');

const pause = () => new Promise(setImmediate);
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Offline fixture timed out')), 2000);
  })]); } finally { clearTimeout(timer); }
}
const session = () => ({ kind: 'state', seq: 1, online: true, session: randomUUID(),
  host: 'example.invalid', port: 25565, username: 'Tester' });
const prefix = '[\u7ea2\u5305]\u73a9\u5bb6 Sender \u53d1\u9001\u4e86\u4e00\u4e2a\u62fc\u624b\u6c14\u7ea2\u5305 ';
const runs = (value = '/fixture claim') => [{ text: prefix }, { text: '\u3010\u70b9\u51fb\u9886\u53d6\u3011',
  click: { action: 'run_command', value, remoteId: randomUUID() } }];
let passed = 0, failed = 0;
async function test(label, fn) {
  try { await fn(); passed++; console.log('PASS ' + label); }
  catch (e) { failed++; console.error('FAIL ' + label + '\n' + e.stack); }
}
function fixture(options = {}) {
  const sent = [];
  const socket = { destroyed: false, destroy() { this.destroyed = true; } };
  const peer = new BridgeClient(socket, (frame) => { sent.push(frame); return true; }, options);
  const state = session(); peer.receive(state);
  return { peer, sent, state, chat(source = 'system', parts = runs(), seq = 2) {
    const messages = [];
    const listener = (text, meta) => messages.push({ text, ...meta }); peer.on('chat', listener);
    peer.receive({ kind: 'chat', seq, session: peer.session, source, runs: parts });
    peer.removeListener('chat', listener); return messages[0];
  } };
}
async function modSocket(port, token) {
  const socket = net.createConnection({ host: '127.0.0.1', port });
  socket.on('error', () => {});
  let buffer = '', frames = [], waiters = [];
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const value = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      if (waiters.length) waiters.shift()(value); else frames.push(value);
    }
  });
  await once(socket, 'connect');
  socket.write(JSON.stringify({ kind: 'hello', version: 1, token }) + '\n');
  return { socket, send: (frame) => socket.write(JSON.stringify(frame) + '\n'),
    queued: () => frames.length,
    next: () => frames.length ? Promise.resolve(frames.shift()) : new Promise((resolve) => waiters.push(resolve)) };
}

async function run() {
  await test('Pairing is random, persistent, loopback-only and fails closed on damage', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbridge-pair-test-'));
    const file = path.join(dir, 'pairing.json');
    const first = pairing(file); assert.equal(first.host, '127.0.0.1');
    assert.deepEqual(pairing(file), first); assert.notEqual(pairing(path.join(dir, 'other.json')).token, first.token);
    fs.writeFileSync(file, JSON.stringify({ ...first, host: '0.0.0.0' })); assert.throws(() => pairing(file));
    fs.writeFileSync(file, '{'); assert.throws(() => pairing(file));
  });
  for (const source of ['player', 'actionbar']) await test('No executable clicks from ' + source, () => {
    const f = fixture(), message = f.chat(source);
    assert.equal(message.segments.some((p) => p.click), false); assert.equal(f.peer.remoteActions.size, 0); f.peer.close();
  });
  await test('Server rich text retains styles and opaque registered action ids', () => {
    const f = fixture(); const parts = runs(); parts[1].color = '#fFaA00'; parts[1].bold = true;
    const message = f.chat('system', parts);
    assert.equal(message.segments[1].bold, true); assert.equal(message.segments[1].color, '#fFaA00');
    assert.equal(f.peer.remoteActions.get(parts[1].click.remoteId).value, '/fixture claim'); f.peer.close();
  });
  await test('Legacy section colors are normalized without losing the registered server action', () => {
    const f = fixture(), parts = runs(); parts[0].text = '\u00a76' + parts[0].text;
    parts[1].text = '\u00a7l' + parts[1].text;
    const message = f.chat('system', parts);
    assert.ok(message.text.startsWith('[\u7ea2\u5305]')); assert.equal(message.text.includes('\u00a7'), false);
    assert.equal(message.segments[1].bold, true); assert.equal(message.segments[1].click.remoteId, parts[1].click.remoteId);
    f.peer.close();
  });
  await test('Action dispatch is consumed before await and waits for the game acknowledgement', async () => {
    const f = fixture(), registry = new ChatActions();
    const message = f.chat(); const part = registry.register(message.segments)[1];
    const pending = registry.activate(part.click.id, f.peer);
    assert.equal(f.sent.length, 1); assert.equal((await registry.activate(part.click.id, f.peer)).ok, false);
    assert.equal(f.sent[0].value, undefined, 'Never forwards a substituted command for registered actions');
    f.peer.receive({ kind: 'result', seq: 3, session: f.peer.session, id: f.sent[0].id, ok: true });
    assert.equal((await pending).ok, true); f.peer.close();
  });
  await test('Unknown, mismatched and duplicate remote actions never dispatch', async () => {
    const f = fixture(), parts = runs(); f.chat('system', parts);
    assert.equal((await f.peer.activateAction({ value: '/wrong', remoteId: parts[1].click.remoteId })).ok, false);
    assert.equal((await f.peer.activateAction({ value: '/fixture claim', remoteId: randomUUID() })).ok, false);
    assert.equal(f.sent.length, 0); f.peer.close();
  });
  await test('Missing game acknowledgement times out without retry or receipt claim', async () => {
    const f = fixture({ requestTimeout: 10 }); f.chat();
    const [remoteId, entry] = [...f.peer.remoteActions][0];
    const result = await f.peer.activateAction({ remoteId, value: entry.value }, { automatic: true });
    assert.equal(result.ok, false); assert.match(result.error, /no retry/); assert.equal(f.sent.length, 1);
    assert.equal((await f.peer.activateAction({ remoteId, value: entry.value })).ok, false); f.peer.close();
  });
  await test('Game reconfiguration invalidates commands and pending acknowledgements', async () => {
    const f = fixture(); f.chat(); const [remoteId, entry] = [...f.peer.remoteActions][0];
    const pending = f.peer.activateAction({ remoteId, value: entry.value });
    f.peer.receive({ ...session(), seq: 3 });
    assert.equal((await pending).ok, false); assert.equal(f.peer.remoteActions.size, 0);
    assert.equal((await f.peer.activateAction({ remoteId, value: entry.value })).ok, false); f.peer.close();
  });
  await test('Game disconnect drops pending requests and stale chat cannot register actions', async () => {
    const f = fixture(); const pending = f.peer.command('fixture manual'); const old = f.peer.session;
    f.peer.receive({ kind: 'state', seq: 2, online: false });
    assert.equal((await pending).ok, false);
    f.peer.receive({ kind: 'chat', seq: 3, session: old, source: 'system', runs: runs() });
    assert.equal(f.peer.remoteActions.size, 0); f.peer.close();
  });
  await test('Session identities cannot mutate or accept out-of-order frames', () => {
    const f = fixture(); assert.throws(() => f.peer.receive({ ...f.state, seq: 2, host: 'other.invalid' }));
    assert.throws(() => f.peer.receive({ kind: 'heartbeat', seq: 2 })); f.peer.close();
  });
  await test('Password suggestions only fill input and never create network requests', async () => {
    const f = fixture(), registry = new ChatActions();
    const message = f.chat('system', [{ text: prefix }, { text: '\u8f93\u5165\u53e3\u4ee4\u9886\u53d6',
      click: { action: 'suggest_command', value: '/fixture password ' } }]);
    message.segments = registry.register(message.segments); message.session = registry.session;
    const auto = new RedPacketAutomation({ actions: registry });
    assert.equal((await auto.handle(message, f.peer, { enabled: true })).status, 'suggested');
    assert.equal(f.sent.length, 0); f.peer.close();
  });
  await test('Malformed, unknown-source and oversized chat is rejected', () => {
    const f = fixture(); assert.throws(() => f.chat('not-server'));
    assert.throws(() => f.chat('system', [{ text: 'a'.repeat(65537) }], 3));
    assert.throws(() => f.chat('system', [{ text: '\0' }], 4)); f.peer.close();
  });
  await test('Authenticated TCP supports split UTF-8 frames, heartbeat and dispatch replies', async () => {
    const server = new BridgeServer();
    const port = await server.start({ port: 0, token: 'a'.repeat(64) });
    let mod;
    try {
      const attached = once(server, 'attached'); mod = await modSocket(port, 'a'.repeat(64));
      const welcome = await mod.next(); const [peer] = await attached;
      assert.equal(welcome.link, peer.link);
      const joined = once(peer, 'state'), state = session(); mod.send(state); await joined;
      const chat = once(peer, 'chat');
      const bytes = Buffer.from(JSON.stringify({ kind: 'chat', seq: 2, session: state.session, source: 'system', runs: runs() }) + '\n');
      const split = bytes.indexOf(Buffer.from('\u7ea2')) + 1;
      mod.socket.write(bytes.subarray(0, split)); mod.socket.write(bytes.subarray(split));
      assert.match((await chat)[0], /\u7ea2\u5305/);
      mod.send({ kind: 'heartbeat', seq: 3 }); assert.equal((await mod.next()).kind, 'heartbeat');
      const pending = peer.command('fixture only'); const execute = await mod.next();
      mod.send({ kind: 'result', seq: 4, session: state.session, id: execute.id, ok: true });
      assert.equal((await pending).ok, true);
    } finally { if (mod) mod.socket.destroy(); await server.stop(); }
  });
  await test('TCP rejects wrong token, oversized unauthenticated frames and second peer', async () => {
    const server = new BridgeServer(); const port = await server.start({ port: 0, token: 'a'.repeat(64) });
    const sockets = [];
    try {
      const wrong = await modSocket(port, 'b'.repeat(64)); sockets.push(wrong.socket); await once(wrong.socket, 'close');
      assert.equal(server.peer, null);
      const good = await modSocket(port, 'a'.repeat(64)); sockets.push(good.socket); await good.next();
      const second = await modSocket(port, 'a'.repeat(64)); sockets.push(second.socket); await once(second.socket, 'close');
      assert.ok(server.peer); good.socket.destroy(); await pause();
      const huge = net.createConnection({ host: '127.0.0.1', port }); sockets.push(huge); huge.on('error', () => {});
      await once(huge, 'connect'); huge.write('x'.repeat(MAX_FRAME + 1)); await once(huge, 'close');
    } finally { for (const socket of sockets) socket.destroy(); await server.stop(); }
  });
  await test('Main bridge mode works without software account auth and forbids second login', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbridge-main-test-'));
    let logins = 0;
    const h = mainHarness({ dataDir: dir, config: normalize({ autoLogin: false, servers: [] }),
      login: () => { logins++; throw new Error('Account login forbidden'); } });
    let mod;
    try {
      assert.equal((await h.invoke('client:mode', 'bridge')).ok, true);
      assert.equal((await h.invoke('bridge:start')).ok, true);
      assert.equal((await h.connect(true)).ok, false); assert.equal(logins, 0); assert.equal(h.clients.length, 0);
      const config = pairing(path.join(dir, 'bridge-pairing.json')); mod = await modSocket(config.port, config.token); await mod.next();
      mod.send(session()); await pause(); await pause();
      assert.equal(h.clients.length, 0); assert.equal(h.business(), 0);
      assert.equal((await h.invoke('bridge:status')).online, true);
      await h.disconnect();
      assert.equal((await h.invoke('bridge:status')).listening, false);
    } finally { if (mod) mod.socket.destroy(); await h.disconnect(); h.quit(); }
  });
  await test('Switching to bridge cancels pending software authentication and old retry timers', async () => {
    let release; const login = new Promise((resolve) => { release = resolve; });
    const h = mainHarness({ login: () => login });
    const old = h.connect(true); await h.invoke('client:mode', 'bridge');
    release({ profile: { name: 'Tester', id: '0'.repeat(32) }, accessToken: 'FIXTURE' });
    assert.equal((await old).ok, false); for (const timer of h.timers) timer();
    assert.equal(h.clients.length, 0); h.quit();
  });
  await test('A bridge listen cancelled before startup settles and cannot leak a local listener', async () => {
    const server = new BridgeServer();
    const starting = server.start({ port: 0, token: 'a'.repeat(64) });
    const result = starting.then(() => true, () => false);
    await server.stop(); assert.equal(await result, false); assert.equal(server.server, null);
  });
  await test('Saved bridge mode is restored and forbids premium connect before UI selection', async () => {
    const h = mainHarness({ config: normalize({ connectionMode: 'bridge', autoLogin: false, servers: [] }),
      login: () => { throw new Error('Auth forbidden'); } });
    assert.equal((await h.connect(true)).ok, false); assert.equal(h.clients.length, 0);
    assert.equal((await h.invoke('bridge:status')).mode, 'bridge'); h.quit();
  });
  await test('Main startup cancelled by disconnect is bounded and does not revive bridge mode', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbridge-cancel-test-'));
    const h = mainHarness({ dataDir: dir, config: normalize({ autoLogin: false, servers: [] }) });
    await h.invoke('client:mode', 'bridge');
    const starting = h.invoke('bridge:start'); await h.disconnect();
    assert.equal((await starting).ok, false); assert.equal((await h.invoke('bridge:status')).listening, false); h.quit();
  });
  await test('Complete main automation flow shares dedupe and daily budget across independent/game connections', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbridge-automation-test-'));
    pairing(path.join(dir, 'bridge-pairing.json'));
    const h = mainHarness({ dataDir: dir, config: normalize({ autoLogin: false, servers: [],
      behavior: { greet: 'MUST_NOT_SEND', commands: ['MUST_NOT_SEND'] } }) });
    let mod;
    const welcomeRuns = (name) => [{ text: '\u65b0\u73a9\u5bb6' + name + '\u52a0\u5165\u4e86\u8292\u679c\u5c0f\u9547\uff01' },
      { text: '[\u70b9\u51fb\u6b22\u8fce]', click: { action: 'run_command', value: '/fixture welcome ' + name, remoteId: randomUUID() } }];
    try {
      await h.connect(); const standalone = h.clients[0]; standalone.state = 'play'; standalone.username = 'Tester';
      standalone.opts.onEvent('join');
      for (const parts of [runs('/fixture prior'), welcomeRuns('First')]) {
        standalone.opts.onChat(parts.map((p) => p.text).join(''), { type: 'system',
          segments: parts.map((p) => ({ ...p, click: p.click && { action: p.click.action, value: p.click.value } })) });
      }
      await pause(); assert.equal(h.business(), 2);
      standalone.opts.onEvent('kick', 'multiplayer.disconnect.duplicate_login');
      const deadline = Date.now() + 2000;
      while (!(await h.invoke('bridge:status')).listening && Date.now() < deadline) await pause();
      assert.equal((await h.invoke('bridge:status')).listening, true);
      const config = pairing(path.join(dir, 'bridge-pairing.json'));
      mod = await modSocket(config.port, config.token); await bounded(mod.next());
      const state = session(); mod.send(state); await pause(); await pause();
      let seq = 1;
      const chat = async (parts, source = 'system') => {
        const before = h.chats.length;
        mod.send({ kind: 'chat', seq: ++seq, session: state.session, source, runs: parts });
        await bounded((async () => { while (h.chats.length === before) await new Promise((resolve) => setTimeout(resolve, 5)); })());
      };
      const ack = (frame, ok = true) => mod.send({ kind: 'result', seq: ++seq, session: state.session, id: frame.id, ok });
      await chat(runs('/fixture prior')); await chat(welcomeRuns('First')); await pause();
      assert.equal(mod.queued(), 0, 'Mode changes must not replay prior automatic actions');
      await chat(runs('/fixture next'));
      const claim = await bounded(mod.next()); assert.equal(claim.automatic, true);
      assert.ok(claim.actionId); assert.equal(claim.value, undefined); ack(claim); await pause(); await pause();
      assert.equal(h.logs.some((l) => /\u670d\u52a1\u5668\u786e\u8ba4\u9886\u53d6/.test(l.text)), false);
      await chat([{ text: '[\u7ea2\u5305]\u4f60\u9886\u53d6\u6210\u529f' }]);
      assert.ok(h.logs.some((l) => /\u670d\u52a1\u5668\u786e\u8ba4\u9886\u53d6/.test(l.text)));
      await chat(runs('/fixture next')); await chat(runs('/fixture forged'), 'player'); await pause();
      assert.equal(mod.queued(), 0, 'Duplicate or player chat cannot claim');
      await chat(welcomeRuns('Second')); const welcome = await bounded(mod.next()); ack(welcome); await pause();
      const accountFiles = require('./account_profiles').accountStateFiles(dir, 'player:tester');
      assert.equal(JSON.parse(fs.readFileSync(accountFiles.welcome)).count, 2);
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'welcome-daily.json'))).count, 1,
        'Legacy quota is copied once and remains untouched after account isolation');
      mod.send({ ...state, seq: ++seq, automationBlocked: true }); await chat(runs('/fixture blocked')); await pause();
      assert.equal(mod.queued(), 0, 'Conflicting helper blocks automatic actions');
      mod.send({ ...state, seq: ++seq, automationBlocked: false });
      const manual = h.invoke('client:say', '/fixture manual');
      const execute = await bounded(mod.next()); assert.equal(execute.manual, 'command'); assert.equal(execute.value, 'fixture manual');
      ack(execute); assert.equal((await manual).ok, true);
      assert.equal(h.clients.length, 1, 'Game bridge must never instantiate another MCClient');
      const stale = h.chats.find((m) => m.text.includes('Second')).segments.find((p) => p.click).click.id;
      await h.disconnect(); assert.equal((await h.invoke('client:chatAction', stale)).ok, false);
    } finally { if (mod) mod.socket.destroy(); await h.disconnect(); h.quit(); }
  });
  console.log('=== ' + passed + ' bridge tests passed / ' + failed + ' failed ===');
  process.exitCode = failed ? 1 : 0;
}
run().catch((e) => { console.error(e); process.exitCode = 1; });
