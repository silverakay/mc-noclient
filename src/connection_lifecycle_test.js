'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { MCClient } = require('./client');
const { ByteReader, ByteWriter } = require('./proto');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function mainHarness(overrides = {}) {
  const handlers = {};
  const clients = [];
  const statuses = [];
  const logs = [], chats = [];
  const timers = [];
  const events = {};
  let config = overrides.config || { behavior: { greet: 'DO_NOT_SEND', commands: ['DO_NOT_SEND'] } };
  // Existing lifecycle fixtures use immediate actions; delay races have separate virtual-clock tests.
  config = { ...config, automation: { ...config.automation, claimDelay: overrides.claimDelay || { minMs: 0, maxMs: 0 },
    welcomeDelay: overrides.welcomeDelay || { minMs: 0, maxMs: 0 } } };
  // Existing action fixtures explicitly opt in on their synthetic server.
  if (config.profileVersion === 1 && !Object.keys(config.serverProfiles || {}).length && !overrides.safeProfile) {
    config.serverProfiles = { 'example.invalid:25565': require('./server_profiles').profile(config, true) };
  }
  let polls = 0;
  let sends = 0;
  let business = 0;
  class FakeClient {
    constructor(opts) { this.opts = opts; this.username = opts.username; this.state = 'login'; clients.push(this); }
    connect() { return overrides.connect ? overrides.connect(this) : Promise.resolve(); }
    close() { this.state = 'closed'; }
    say() { sends++; business++; return true; }
    command(value) { sends++; business++; return overrides.command ? overrides.command(value) : true; }
    sendClientSettings() { sends++; }
  }
  const electron = {
    app: { isPackaged: true, setPath() {}, getPath: () => overrides.dataDir || require('os').tmpdir(), whenReady: () => new Promise(() => {}),
      on(name, fn) { events[name] = fn; }, quit() {} },
    BrowserWindow: function () {},
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
    shell: {},
  };
  const context = vm.createContext({
    require: (name) => {
      if (name === 'electron') return electron;
      if (name === '../src/client') return { MCClient: FakeClient };
      if (name === '../src/client_bridge' && overrides.BridgeServer) return {
        ...require('./client_bridge'), BridgeServer: overrides.BridgeServer,
      };
      if (name === '../src/auth') return overrides.auth || { login: overrides.login, peekCachedAccount: () => null, clearCache() {} };
      if (name === '../src/monitor') return {};
      if (name === '../src/release_seed') return { seedReleaseData: () => ({ status: 'disabled' }) };
      if (name === '../src/presence') return {
        parsePresence: require('./presence').parsePresence,
        PresenceStore: overrides.presence ? class { constructor() { return overrides.presence; } }
          : class { start() {} end() {} record() {} updatePlayers() {}
            getOnline() { return { known: false, players: [] }; }
            query() { return { ok: true, rows: [] }; } },
      };
      if (name === '../src/configstore') return overrides.configStore || {
        load: () => ({ cfg: config }),
        normalize: require('./configstore').normalize,
        save: (_path, next, accountKey) => {
          const failure = typeof overrides.saveFailure === 'function' ? overrides.saveFailure() : overrides.saveFailure;
          if (failure) return { ok: false, error: failure };
          config = accountKey === undefined ? next : require('./account_profiles').saveAccount(config, next, accountKey);
          return { ok: true };
        },
      };
      return require(name);
    },
    __dirname: path.join(__dirname, '..', 'app'),
    process, console,
    setInterval: () => { polls++; return polls; },
    clearInterval() {},
    setTimeout: overrides.setTimeout || ((fn) => { timers.push(fn); return timers.length; }),
    clearTimeout: overrides.clearTimeout || (() => {}),
    Date: overrides.Date || Date,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../app/main.js'), 'utf8'), context);
  context.statuses = statuses;
  context.logs = logs; context.chats = chats;
  context.testWindowFocused = overrides.focused !== false;
  vm.runInContext("mainWindow = { isDestroyed: () => false, isFocused: () => testWindowFocused, webContents: { send: (channel, p) => { if (channel === 'status') statuses.push(p); else if (channel === 'log') logs.push(p); else if (channel === 'chat') chats.push(p); } } }", context);
  return {
    clients, statuses, timers, logs, chats,
    connect: (premium = false) => handlers['client:connect'](null, {
      host: 'example.invalid', port: 25565, username: 'Tester', usePremium: premium,
    }),
    disconnect: () => handlers['client:disconnect'](),
    logout: () => handlers['account:logout'](),
    quit: () => events['before-quit'](),
    configure: (cfg) => handlers['config:save'](null, cfg),
    invoke: (name, value) => handlers[name](null, value),
    startMidnight: () => vm.runInContext('midnight.start()', context),
    suspend: () => vm.runInContext('handleSystemSuspend()', context),
    resume: () => vm.runInContext('handleSystemResume()', context),
    polls: () => polls,
    sends: () => sends,
    business: () => business,
  };
}

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log('  [PASS] ' + name); }
  catch (e) { fail++; console.error('  [FAIL] ' + name + '\n         ' + e.stack); }
}

async function run() {
  await test('UI selftest blocks server status queries even if saved servers are present', async () => {
    const argv = process.argv;
    try {
      process.argv = [...argv, '--selftest-ui', '--user-data-dir=' + require('os').tmpdir()];
      const h = mainHarness();
      const result = await h.invoke('server:ping', { host: 'example.invalid', port: 25565 });
      assert.equal(result.ok, false);
      assert.equal(result.error, 'UI selftest does not query servers');
      assert.equal(h.clients.length, 0);
    } finally { process.argv = argv; }
  });
  await test('Disconnect during account renewal prevents creating a socket', async () => {
    const login = deferred();
    const h = mainHarness({ login: () => login.promise });
    const pending = h.connect(true);
    h.disconnect();
    login.resolve({ accessToken: 'FAKE', profile: { name: 'Tester', id: '0'.repeat(32) } });
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(h.clients.length, 0);
    assert.equal(h.polls(), 0);
  });

  await test('Disconnect during TCP setup cannot start a new poll or connection', async () => {
    const request = deferred();
    const h = mainHarness({ connect: () => request.promise });
    const pending = h.connect();
    h.disconnect();
    request.resolve();
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(h.clients.length, 1);
    assert.equal(h.clients[0].state, 'closed');
    assert.equal(h.polls(), 0);
  });

  await test('Closed client events and delayed greetings cannot revive or send', async () => {
    const h = mainHarness();
    assert.equal((await h.connect()).ok, true);
    const c = h.clients[0];
    c.opts.onEvent('join');
    h.disconnect();
    const before = h.statuses.length;
    c.opts.onEvent('join');
    for (const fn of h.timers) fn();
    assert.equal(h.statuses.length, before);
    assert.equal(h.sends(), 0);
    assert.equal(h.clients.length, 1);
    assert.equal(h.statuses.at(-1).connected, false);
  });

  await test('A manually requested new connection works after disconnect', async () => {
    const h = mainHarness();
    await h.connect();
    h.disconnect();
    await h.connect();
    assert.equal(h.clients.length, 2);
    assert.equal(h.clients[0].state, 'closed');
    assert.equal(h.clients[1].state, 'login');
  });

  await test('MCClient cancellation during SRV lookup creates no TCP connection', async () => {
    const request = deferred();
    const oldResolve = MCClient.resolveSrv;
    const oldConnect = net.createConnection;
    let sockets = 0;
    MCClient.resolveSrv = () => request.promise;
    net.createConnection = () => { sockets++; throw new Error('Network forbidden'); };
    try {
      const c = new MCClient({ host: 'example.invalid' });
      const pending = c.connect();
      c.close();
      request.resolve(null);
      await assert.rejects(pending, /连接已取消/);
      assert.equal(sockets, 0);
    } finally {
      MCClient.resolveSrv = oldResolve;
      net.createConnection = oldConnect;
    }
  });

  await test('MCClient cancellation before TCP connect rejects promptly', async () => {
    const oldConnect = net.createConnection;
    const socket = new EventEmitter();
    socket.setNoDelay = () => {};
    socket.destroy = () => { socket.destroyed = true; setImmediate(() => socket.emit('close')); };
    net.createConnection = () => socket;
    try {
      const c = new MCClient({ host: 'example.invalid', port: 25566 });
      const pending = c.connect();
      c.close();
      await assert.rejects(pending, /连接已取消/);
      assert.equal(c.state, 'closed');
    } finally { net.createConnection = oldConnect; }
  });

  await test('Late Mojang result after disconnect sends no encryption response', async () => {
    const request = deferred();
    const oldFetch = global.fetch;
    const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
    const der = publicKey.export({ type: 'spki', format: 'der' });
    const payload = new ByteWriter().str('').varint(der.length).raw(der)
      .varint(4).raw(Buffer.alloc(4)).bool(true).build();
    let writes = 0;
    const events = [];
    const c = new MCClient({ accessToken: 'FAKE', profileId: '0'.repeat(32),
      onEvent: (ev) => events.push(ev) });
    c.state = 'login';
    c.socket = { write: () => { writes++; }, destroy() { this.destroyed = true; } };
    global.fetch = () => request.promise;
    try {
      const pending = c.handleEncryptionRequest(new ByteReader(payload));
      c.close();
      request.resolve({ ok: true, status: 204, text: async () => '' });
      await pending;
      assert.equal(writes, 0);
      assert.equal(c.encrypted, false);
      assert.equal(c.state, 'closed');
      assert.deepEqual(events, []);
    } finally { global.fetch = oldFetch; c.close(); }
  });

  console.log('\n=== Result: ' + pass + ' passed / ' + fail + ' failed ===');
  process.exitCode = fail ? 1 : 0;
}

if (require.main === module) run().catch((e) => { console.error(e); process.exitCode = 1; });
module.exports = { mainHarness };
