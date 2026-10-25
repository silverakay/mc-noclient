'use strict';

const assert = require('assert/strict');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { once } = require('events');
const { randomUUID } = require('crypto');
const { validateObservation, formatObservation } = require('./outbound_monitor');
const { BridgeClient, BridgeServer, pairing } = require('./client_bridge');
const { mainHarness } = require('./connection_lifecycle_test');
const { normalize } = require('./configstore');
const NL = String.fromCharCode(10);
const command = (extra = {}) => ({ type: 'command', at: Date.now(), origin: 'game', command: '/fixture workbench',
  signed: false, redacted: false, truncated: false, ...extra });
const state = () => ({ kind: 'state', seq: 1, online: true, session: randomUUID(), host: 'example.invalid', port: 25565, username: 'Tester' });
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('PASS ' + name); }
  catch (e) { failed++; console.error('FAIL ' + name, e.stack); }
}
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Offline monitor fixture timed out')), 2500);
  })]); } finally { clearTimeout(timer); }
}
function fixture(options = {}) {
  const sent = [], observed = [], chats = [];
  const peer = new BridgeClient({ destroyed: false, destroy() { this.destroyed = true; } }, (f) => { sent.push(f); return true; },
    { monitorEnabled: true, ...options });
  peer.on('observation', (e) => observed.push(e)); peer.on('chat', (...args) => chats.push(args)); peer.receive(state());
  const send = (event, session = peer.session) => peer.receive({ kind: 'observation', seq: peer.sequence + 1, session, event });
  return { peer, sent, observed, chats, send };
}
async function modSocket(port, token, features) {
  const socket = net.createConnection({ host: '127.0.0.1', port }); socket.on('error', () => {});
  let buffer = '', frames = [], waiters = [];
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8'); let end;
    while ((end = buffer.indexOf(NL)) >= 0) {
      const frame = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      if (waiters.length) waiters.shift()(frame); else frames.push(frame);
    }
  });
  await bounded(once(socket, 'connect'));
  socket.write(JSON.stringify({ kind: 'hello', version: 1, token, ...(features ? { features } : {}) }) + NL);
  return { socket, send: (frame) => socket.write(JSON.stringify(frame) + NL), queued: () => frames.length,
    next: () => bounded(frames.length ? Promise.resolve(frames.shift()) : new Promise((resolve) => waiters.push(resolve))) };
}

async function run() {
  await test('Exact real command is retained without generating executable actions or chat', () => {
    const f = fixture(); f.send(command());
    assert.equal(f.observed[0].command, '/fixture workbench'); assert.match(formatObservation(f.observed[0]), /提交出站/);
    assert.equal(f.sent.length, 0); assert.equal(f.chats.length, 0); assert.equal(f.peer.remoteActions.size, 0); f.peer.close();
  });
  await test('Signed command path and bridge origin remain distinct', () => {
    const f = fixture(); f.send(command({ signed: true, origin: 'bridge' }));
    assert.equal(f.observed[0].signed, true); assert.match(formatObservation(f.observed[0]), /辅助软件/); f.peer.close();
  });
  await test('Login/register/namespaced password commands are independently redacted before desktop logs', () => {
    for (const root of ['login', 'L', 'register', 'authme:login', 'AUTHME:REGISTER', 'changepassword', 'otp', 'email']) {
      const event = validateObservation(command({ command: '/' + root + ' PRIVATE_TEST_SECRET' }));
      assert.equal(event.command, '/' + root); assert.equal(event.redacted, true);
      assert.equal(JSON.stringify(event).includes('PRIVATE_TEST_SECRET'), false);
      assert.equal(formatObservation(event).includes('PRIVATE_TEST_SECRET'), false);
    }
  });
  await test('Oversized and masked commands never produce a partial reusable command', () => {
    assert.throws(() => validateObservation(command({ command: '/fixture ' + 'x'.repeat(2048) })));
    const event = validateObservation(command({ truncated: true, command: '/fixture accidental-parameters' }));
    assert.equal(event.command, '/fixture'); assert.match(formatObservation(event), /过长参数未记录/);
    assert.equal(validateObservation(command({ redacted: true })).command, '/fixture');
  });
  await test('Legacy menu clicks and screens are ignored without guessing commands or producing logs', () => {
    const f = fixture();
    f.send({ type: 'menu_click', at: Date.now(), origin: 'game', containerId: 3, title: '功能菜单', slot: 10,
      button: 0, input: 'PICKUP', item: '便携工作台', context: true });
    f.send({ type: 'screen_open', at: Date.now(), containerId: 4, title: '工作台', menu: 'minecraft:crafting' });
    assert.equal(f.observed.length, 0); assert.equal(f.peer.observationCount, 0);
    assert.equal(f.sent.length, 0); assert.equal(f.chats.length, 0); f.peer.close();
  });
  await test('Legacy click formatting returns no log even without item context', () => {
    const event = validateObservation({ type: 'menu_click', at: Date.now(), origin: 'game', containerId: 0, title: '',
      slot: -999, button: 1, input: 'PICKUP', item: '', context: false });
    assert.equal(formatObservation(event), null);
  });
  await test('Legacy main/offhand use, menu buttons and screens cannot format into visible logs', () => {
    for (const hand of ['MAIN_HAND', 'OFF_HAND']) {
      const event = validateObservation({ type: 'item_use', at: Date.now(), origin: 'game', hand, target: 'block', item: '菜单道具', rawPayload: 'DO_NOT_KEEP' });
      assert.equal('rawPayload' in event, false); assert.equal(formatObservation(event), null);
    }
    assert.equal(formatObservation(validateObservation({ type: 'menu_button', at: Date.now(), origin: 'game',
      containerId: 2, title: '选择', button: 1 })), null);
    assert.equal(formatObservation(validateObservation({ type: 'screen_open', at: Date.now(),
      containerId: 2, title: '钓鱼', menu: 'minecraft:generic_9x3' })), null);
    assert.equal(formatObservation(validateObservation({ type: 'overflow', at: Date.now(), count: 30 })), null);
  });
  await test('Legacy fishing noise never consumes the real-command budget or interrupts chat and requests', async () => {
    const f = fixture({ now: () => 1000 });
    for (let i = 0; i < 1000; i++) f.send({ type: 'item_use', at: Date.now(), origin: 'game',
      hand: i % 2 ? 'MAIN_HAND' : 'OFF_HAND', target: i % 3 ? 'air' : 'block', item: '大师级钓鱼竿' });
    f.send({ type: 'overflow', at: Date.now(), count: 999 });
    assert.equal(f.observed.length, 0); assert.equal(f.peer.observationCount, 0);
    f.send(command()); assert.equal(f.observed.length, 1); assert.equal(f.peer.observationCount, 1);
    const pending = f.peer.command('fixture manual');
    f.peer.receive({ kind: 'result', seq: f.peer.sequence + 1, session: f.peer.session, id: f.sent[0].id, ok: true });
    assert.equal((await pending).ok, true);
    f.peer.receive({ kind: 'chat', seq: f.peer.sequence + 1, session: f.peer.session, source: 'system', runs: [{ text: 'normal chat' }] });
    assert.equal(f.chats.length, 1); f.peer.close();
  });
  await test('Unknown types, control characters, bad fields, payloads and extreme sizes fail closed', () => {
    for (const event of [null, command({ type: 'custom_payload' }), command({ at: NaN }), command({ command: '/fixture' + NL + 'injection' }),
      command({ origin: 'server' }), command({ signed: 'yes' }), command({ command: '//fixture' }),
      { type: 'screen_open', at: Date.now(), containerId: -1, title: '', menu: 'minecraft:crafting' },
      { type: 'screen_open', at: Date.now(), containerId: 1, title: 'x'.repeat(257), menu: 'minecraft:crafting' },
      { type: 'item_use', at: Date.now(), origin: 'game', hand: 'HEAD', target: 'air', item: '' }]) {
      assert.throws(() => validateObservation(event));
    }
  });
  await test('Monitoring must be explicitly negotiated; old peer keeps basic chat support', () => {
    const f = fixture({ monitorEnabled: false }); assert.throws(() => f.send(command()), /not negotiated/);
    f.peer.receive({ kind: 'chat', seq: f.peer.sequence + 1, session: f.peer.session, source: 'system', runs: [{ text: 'normal' }] });
    assert.equal(f.chats.length, 1); assert.equal(f.observed.length, 0); f.peer.close();
  });
  await test('Stale observations are discarded after changing server or disconnecting', () => {
    const f = fixture(), old = f.peer.session; f.peer.receive({ ...state(), seq: 2 }); f.send(command(), old);
    assert.equal(f.observed.length, 0); f.peer.receive({ kind: 'state', seq: 4, online: false }); f.send(command(), old);
    assert.equal(f.observed.length, 0); f.peer.close();
  });
  await test('Flood cannot grow log traffic beyond 21 observations per second or block requests', async () => {
    let now = 1000; const f = fixture({ now: () => now });
    for (let i = 0; i < 200; i++) f.send(command()); assert.equal(f.observed.length, 21);
    const pending = f.peer.command('fixture manual');
    f.peer.receive({ kind: 'result', seq: f.peer.sequence + 1, session: f.peer.session, id: f.sent[0].id, ok: true });
    assert.equal((await pending).ok, true);
    now += 1000; f.send({ type: 'overflow', at: Date.now(), count: 50 }); assert.equal(f.observed.length, 21);
    f.send(command()); assert.equal(f.observed.length, 22); f.peer.close();
  });
  for (const capable of [false, true]) await test('Authenticated TCP negotiates monitor=' + capable + ' without changing protocol version', async () => {
    const server = new BridgeServer(); const port = await server.start({ port: 0, token: 'a'.repeat(64) }); let mod;
    try {
      const attached = once(server, 'attached'); mod = await modSocket(port, 'a'.repeat(64), capable ? { outboundMonitor: true } : undefined);
      const welcome = await mod.next(); const [peer] = await bounded(attached);
      assert.equal(welcome.version, 1); assert.equal(welcome.features.outboundMonitor, capable); assert.equal(peer.monitorEnabled, capable);
      const joined = once(peer, 'state'), s = state(); mod.send(s); await bounded(joined);
      if (capable) {
        const seen = once(peer, 'observation'); mod.send({ kind: 'observation', seq: 2, session: s.session, event: command() });
        assert.equal((await bounded(seen))[0].command, '/fixture workbench');
      } else {
        const chat = once(peer, 'chat'); mod.send({ kind: 'chat', seq: 2, session: s.session, source: 'system', runs: [{ text: 'legacy chat' }] });
        assert.equal((await bounded(chat))[0], 'legacy chat');
      }
    } finally { if (mod) mod.socket.destroy(); await server.stop(); }
  });
  await test('Main integration puts observations only in runtime logs and never logs in or dispatches', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-outbound-main-test-'));
    const h = mainHarness({ dataDir: dir, config: normalize({ autoLogin: false, servers: [] }),
      login: () => { throw new Error('Auth forbidden'); } }); let mod;
    try {
      await h.invoke('client:mode', 'bridge'); assert.equal((await h.invoke('bridge:start')).ok, true);
      const config = pairing(path.join(dir, 'bridge-pairing.json'));
      mod = await modSocket(config.port, config.token, { outboundMonitor: true }); await mod.next();
      const s = state(); mod.send(s);
      mod.send({ kind: 'observation', seq: 2, session: s.session, event: {
        type: 'menu_click', at: Date.now(), origin: 'game', containerId: 30, title: '仓库菜单',
        slot: 33, button: 0, input: 'PICKUP', item: '钓鱼', context: true } });
      mod.send({ kind: 'observation', seq: 3, session: s.session, event: {
        type: 'screen_open', at: Date.now(), containerId: 31, title: '钓鱼', menu: 'minecraft:generic_9x3' } });
      mod.send({ kind: 'observation', seq: 4, session: s.session, event: {
        type: 'item_use', at: Date.now(), origin: 'game', hand: 'MAIN_HAND', target: 'air', item: '大师级钓鱼竿' } });
      mod.send({ kind: 'observation', seq: 5, session: s.session, event: command() });
      mod.send({ kind: 'observation', seq: 6, session: s.session, event: command({ command: '/login PRIVATE_TEST_SECRET' }) });
      mod.send({ kind: 'chat', seq: 7, session: s.session, source: 'system', runs: [{ text: 'hello Nan_Koi' }] });
      const end = Date.now() + 2000;
      while (!h.logs.some((r) => r.text.includes('hello Nan_Koi')) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(h.logs.some((r) => r.text.includes('[游戏指令]') && r.text.includes('/fixture workbench')));
      assert.ok(h.logs.some((r) => r.text.includes('敏感参数已隐藏')));
      assert.ok(h.logs.some((r) => r.text.includes('游戏出站指令监测已启用')));
      assert.ok(h.logs.some((r) => r.text.includes('hello Nan_Koi')));
      assert.equal(h.logs.some((r) => /\[菜单监测\]|\[服务器界面\]|大师级钓鱼竿|仓库菜单/.test(r.text)), false);
      assert.equal(JSON.stringify(h.logs).includes('PRIVATE_TEST_SECRET'), false);
      assert.equal(h.chats.some((r) => r.text.includes('/fixture workbench')), false);
      assert.equal(h.clients.length, 0); assert.equal(h.business(), 0); assert.equal(mod.queued(), 0);
    } finally { if (mod) mod.socket.destroy(); await h.disconnect(); h.quit(); }
  });
  console.log('=== 结果：' + passed + ' 通过 / ' + failed + ' 失败 ==='); process.exitCode = failed ? 1 : 0;
}
run().catch((e) => { console.error(e); process.exitCode = 1; });
