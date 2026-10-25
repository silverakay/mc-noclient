'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { once } = require('events');
const { spawn, spawnSync } = require('child_process');
const { randomUUID } = require('crypto');
const { BridgeServer, pairing } = require('./client_bridge');
const { BridgeDiscovery, discoveryDirectory, pairingId } = require('./bridge_discovery');
const { mainHarness } = require('./connection_lifecycle_test');
const { normalize } = require('./configstore');

const pause = () => new Promise(setImmediate);
const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mcbridge-multi-'));
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Local multi-instance fixture timed out')), 5000);
  })]); } finally { clearTimeout(timer); }
}
async function until(predicate) {
  await bounded((async () => { while (!await predicate()) await new Promise((resolve) => setTimeout(resolve, 5)); })());
}
const records = (directory) => fs.readdirSync(directory).filter((name) => name.endsWith('.json'))
  .map((name) => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')));

async function mod(port, token, username) {
  const socket = net.createConnection({ host: '127.0.0.1', port });
  socket.on('error', () => {});
  const closed = once(socket, 'close');
  let buffer = '', frames = [], waiters = [];
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const frame = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      if (waiters.length) waiters.shift()(frame); else frames.push(frame);
    }
  });
  await bounded(once(socket, 'connect'));
  const send = (frame) => socket.write(JSON.stringify(frame) + '\n');
  send({ kind: 'hello', version: 1, token, ...(username ? { username } : {}) });
  return { socket, send, closed, frames,
    next: () => bounded(frames.length ? Promise.resolve(frames.shift()) : new Promise((resolve) => waiters.push(resolve))),
    state(name = username, seq = 1) {
      const state = { kind: 'state', seq, online: true, session: randomUUID(),
        host: 'example.invalid', port: 25565, username: name };
      send(state); return state;
    } };
}

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
}

async function run() {
  await test('Two listeners with the same pairing use separate ports without changing credentials', async () => {
    const dir = temporary(), directory = discoveryDirectory(dir), file = path.join(dir, 'bridge-pairing.json');
    const config = pairing(file), saved = fs.readFileSync(file);
    const first = new BridgeServer({ discoveryDirectory: directory, username: 'Alice' });
    const second = new BridgeServer({ discoveryDirectory: directory, username: 'Bob' });
    const sockets = [];
    try {
      const portA = await first.start(config), portB = await second.start(config);
      assert.notEqual(portA, portB); assert.deepEqual(fs.readFileSync(file), saved);
      const endpoints = records(directory); assert.equal(endpoints.length, 2);
      assert.ok(endpoints.every((record) => record.pairingId === pairingId(config.token) && !record.token));
      const a = await mod(portA, config.token, 'Alice'); sockets.push(a.socket); await a.next();
      const b = await mod(portB, config.token, 'Bob'); sockets.push(b.socket); await b.next();
      const stateA = a.state(), stateB = b.state();
      await until(() => first.peer.state === 'play' && second.peer.state === 'play');
      const requestA = first.peer.command('fixture Alice'), requestB = second.peer.command('fixture Bob');
      const executeA = await a.next(), executeB = await b.next();
      assert.equal(executeA.value, 'fixture Alice'); assert.equal(executeB.value, 'fixture Bob');
      assert.notEqual(executeA.link, executeB.link); assert.notEqual(executeA.session, executeB.session);
      a.send({ kind: 'result', seq: 2, session: stateA.session, id: executeA.id, ok: true });
      b.send({ kind: 'result', seq: 2, session: stateB.session, id: executeB.id, ok: true });
      assert.equal((await requestA).ok, true); assert.equal((await requestB).ok, true);
      await first.stop(); assert.equal(second.peer.state, 'play');
      assert.equal(records(directory).length, 1);
      b.send({ kind: 'heartbeat', seq: 3 }); assert.equal((await b.next()).kind, 'heartbeat');
    } finally { for (const socket of sockets) socket.destroy(); await first.stop(); await second.stop(); }
    assert.equal(records(directory).length, 0);
  });
  await test('An unrelated process occupying the old port is not authenticated or disturbed', async () => {
    const blocker = net.createServer(); await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    let connections = 0; blocker.on('connection', (socket) => { connections++; socket.destroy(); });
    const server = new BridgeServer({ discoveryDirectory: discoveryDirectory(temporary()) });
    try {
      const config = { port: blocker.address().port, token: 'a'.repeat(64) };
      const port = await server.start(config); assert.notEqual(port, config.port);
      assert.equal(connections, 0); assert.equal(blocker.listening, true);
    } finally { await server.stop(); await new Promise((resolve) => blocker.close(resolve)); }
  });
  await test('A claimed listener refuses other identities, including reconnects and legacy hello frames', async () => {
    const directory = discoveryDirectory(temporary()), server = new BridgeServer({ discoveryDirectory: directory });
    const sockets = [];
    try {
      const port = await server.start({ port: 0, token: 'a'.repeat(64) });
      const a = await mod(port, 'a'.repeat(64), 'Alice'); sockets.push(a.socket); await a.next(); a.state();
      await until(() => server.peer?.state === 'play');
      assert.equal(records(directory)[0].username, 'Alice'); assert.equal(records(directory)[0].busy, true);
      const duplicate = await mod(port, 'a'.repeat(64), 'Bob'); sockets.push(duplicate.socket); await bounded(duplicate.closed);
      assert.equal(server.peer.username, 'Alice'); assert.equal(a.socket.destroyed, false);
      a.socket.destroy(); await until(() => !server.peer);
      assert.equal(records(directory)[0].busy, false); assert.equal(records(directory)[0].username, 'Alice');
      const wrong = await mod(port, 'a'.repeat(64), 'Bob'); sockets.push(wrong.socket); await bounded(wrong.closed);
      assert.equal(server.peer, null);
      const legacy = await mod(port, 'a'.repeat(64)); sockets.push(legacy.socket); await legacy.next(); legacy.state('Bob');
      await bounded(legacy.closed); await until(() => !server.peer);
      const a2 = await mod(port, 'a'.repeat(64), 'aLiCe'); sockets.push(a2.socket); await a2.next(); a2.state();
      await until(() => server.peer?.state === 'play'); assert.equal(server.peer.username, 'aLiCe');
    } finally { for (const socket of sockets) socket.destroy(); await server.stop(); }
  });
  await test('An online state cannot substitute an identity different from its named hello', async () => {
    const server = new BridgeServer(); let game;
    try {
      const port = await server.start({ port: 0, token: 'a'.repeat(64) });
      game = await mod(port, 'a'.repeat(64), 'Alice'); await game.next();
      game.state('Bob'); await bounded(game.closed); await until(() => !server.peer);
      assert.equal(server.expectedUsername, 'Alice');
    } finally { game?.socket.destroy(); await server.stop(); }
  });
  await test('Atomic discovery publication expires, omits secrets, and removes only its own record', () => {
    const directory = discoveryDirectory(temporary()), config = { token: 'a'.repeat(64) };
    let now = 1000;
    const first = new BridgeDiscovery(directory, config, { now: () => now });
    const second = new BridgeDiscovery(directory, config, { now: () => now });
    first.publish(40001, 'Alice', false); second.publish(40002, 'Bob', true);
    assert.equal(records(directory)[0].expiresAt, 21000);
    now = 6000; first.publish(40001, 'Alice', true);
    const text = fs.readFileSync(first.file, 'utf8'); assert.equal(text.includes(config.token), false);
    assert.equal(JSON.parse(text).expiresAt, 26000);
    assert.equal(fs.readdirSync(directory).some((name) => name.endsWith('.tmp')), false);
    first.close(); assert.equal(fs.existsSync(second.file), true); second.close();
    first.publish(40001, '', false); now = 30000;
    const third = new BridgeDiscovery(directory, config, { now: () => now });
    assert.equal(fs.existsSync(first.file), true, 'Never remove a paused but living process record');
    const abandoned = JSON.parse(fs.readFileSync(first.file, 'utf8')); abandoned.pid = 2147483647;
    fs.writeFileSync(first.file, JSON.stringify(abandoned));
    const fourth = new BridgeDiscovery(directory, config, { now: () => now });
    assert.equal(fs.existsSync(first.file), false); third.close(); fourth.close();
  });
  await test('Discovery write failures release the TCP listener instead of leaking a hidden bridge', async () => {
    const file = path.join(temporary(), 'not-a-directory'); fs.writeFileSync(file, 'fixture');
    const server = new BridgeServer({ discoveryDirectory: file });
    await assert.rejects(server.start({ port: 0, token: 'a'.repeat(64) }));
    assert.equal(server.server, null); assert.equal(server.discoveryTimer, null); await server.stop();
  });
  await test('Stopping during startup cannot publish or resurrect a fallback listener', async () => {
    const directory = discoveryDirectory(temporary()), first = new BridgeServer();
    const port = await first.start({ port: 0, token: 'a'.repeat(64) });
    const second = new BridgeServer({ discoveryDirectory: directory });
    try {
      const starting = second.start({ port, token: 'a'.repeat(64) });
      const result = starting.then(() => true, () => false);
      await second.stop(); assert.equal(await result, false);
      assert.equal(second.server, null); assert.equal(second.discoveryTimer, null);
      assert.equal(fs.existsSync(directory), false);
    } finally { await first.stop(); await second.stop(); }
  });
  await test('Two real processes can start, publish and stop independently with a shared pairing file', async () => {
    const directory = temporary();
    const script = `const {BridgeServer,pairing}=require('./src/client_bridge');
      const {discoveryDirectory}=require('./src/bridge_discovery'); const path=require('path');
      let bridge; process.on('message',async msg=>{try {
        if(msg==='start'){const cfg=pairing(path.join(process.argv[1],'bridge-pairing.json'));
          bridge=new BridgeServer({discoveryDirectory:discoveryDirectory(process.argv[1])});
          process.send({port:await bridge.start(cfg)});}
        else {await bridge.stop();process.disconnect();}
      }catch(e){process.send({error:e.message});process.exitCode=1;process.disconnect();}});`;
    const children = [0, 1].map(() => spawn(process.execPath, ['-e', script, directory],
      { cwd: path.join(__dirname, '..'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }));
    const exits = children.map((child) => once(child, 'exit'));
    try {
      const messages = children.map((child) => bounded(once(child, 'message')));
      for (const child of children) child.send('start');
      const [[a], [b]] = await Promise.all(messages);
      assert.equal(a.error, undefined); assert.equal(b.error, undefined); assert.notEqual(a.port, b.port);
      assert.equal(records(discoveryDirectory(directory)).length, 2);
      children[0].send('stop'); assert.equal((await bounded(exits[0]))[0], 0);
      assert.equal(records(discoveryDirectory(directory)).length, 1);
      children[1].send('stop'); assert.equal((await bounded(exits[1]))[0], 0);
      assert.equal(records(discoveryDirectory(directory)).length, 0);
    } finally {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
      await Promise.all(exits);
    }
  });
  await test('Two actual main-process handoffs share credentials but never stop or replace the other account', async () => {
    const dir = temporary(); pairing(path.join(dir, 'bridge-pairing.json'));
    const windows = ['Alice', 'Bob'].map(() => mainHarness({ dataDir: dir,
      config: normalize({ autoLogin: false, servers: [] }) }));
    const sockets = [];
    try {
      for (const [index, name] of ['Alice', 'Bob'].entries()) {
        const h = windows[index];
        assert.equal((await h.invoke('client:connect', { host: 'example.invalid', port: 25565,
          username: name, usePremium: false })).ok, true);
        const client = h.clients[0]; client.state = 'play'; client.opts.onEvent('join');
        client.opts.onEvent('kick', 'multiplayer.disconnect.duplicate_login');
        await until(async () => (await h.invoke('bridge:status')).listening);
      }
      const config = pairing(path.join(dir, 'bridge-pairing.json'));
      for (const name of ['Alice', 'Bob']) {
        const endpoint = records(discoveryDirectory(dir)).find((entry) => entry.username === name);
        const game = await mod(endpoint.port, config.token, name); sockets.push(game.socket);
        await game.next(); game.state();
      }
      await until(async () => (await Promise.all(windows.map((h) => h.invoke('bridge:status')))).every((s) => s.online));
      assert.equal(windows.some((h) => h.logs.some((log) => /EADDRINUSE/.test(log.text))), false);
      assert.equal(windows.every((h) => h.clients.length === 1 && h.business() === 0), true);
      await windows[0].disconnect(); assert.equal((await windows[1].invoke('bridge:status')).online, true);
    } finally {
      for (const socket of sockets) socket.destroy();
      for (const h of windows) { await h.disconnect(); h.quit(); }
    }
  });
  if (process.env.MC_BRIDGE_JAVA_CP) await test('Packaged Java discovery reads live Node records for both accounts', async () => {
    const dir = temporary(), config = pairing(path.join(dir, 'bridge-pairing.json'));
    const directory = discoveryDirectory(dir), servers = ['Alice', 'Bob'].map((username) => new BridgeServer({ discoveryDirectory: directory, username }));
    const file = path.join(dir, 'export.json');
    fs.writeFileSync(file, JSON.stringify({ ...config, discoveryDirectory: directory }));
    try {
      for (const server of servers) await server.start(config);
      for (const [index, name] of ['Alice', 'Bob'].entries()) {
        const result = spawnSync(process.env.MC_BRIDGE_JAVA, ['-cp', process.env.MC_BRIDGE_JAVA_CP,
          'xyz.baixur.mcbridge.BridgeDiscoveryTest', '--ports', file, name], { encoding: 'utf8', windowsHide: true });
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), [servers[index].server.address().port]);
      }
    } finally { for (const server of servers) await server.stop(); }
  });
  console.log('=== ' + passed + ' multi-instance tests passed / ' + failed + ' failed ===');
  process.exitCode = failed ? 1 : 0;
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
