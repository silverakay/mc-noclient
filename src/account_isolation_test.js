'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const store = require('./configstore');
const { effectiveAccount, accountStateFiles } = require('./account_profiles');
const { WelcomeBudget } = require('./welcome');
const { reserveDay } = require('./midnight_command');
const profiles = require('./server_profiles');
const { mainHarness } = require('./connection_lifecycle_test');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mango-accounts-'));
const key = 'example.invalid:25565';
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
function clock(initial = 0) {
  let id = 0, now = initial; const tasks = new Map();
  return { now: () => now, set: (fn, ms) => { tasks.set(++id, { fn, at: now + ms }); return id; }, clear: (id) => tasks.delete(id),
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const task = [...tasks].sort((a, b) => a[1].at - b[1].at)[0];
        if (!task || task[1].at > end) break;
        tasks.delete(task[0]); now = task[1].at; await task[1].fn();
      }
      now = end;
    } };
}
function authFixture() {
  const accounts = [{ uuid: 'first-uuid', name: 'FirstUser' }, { uuid: 'second-uuid', name: 'SecondUser' }];
  let activeUuid = accounts[0].uuid, failure = null, mismatch = false;
  const calls = [];
  const auth = { peekCachedAccount: () => accounts.find((item) => item.uuid === activeUuid) || null,
    peekCachedAccounts: () => ({ activeUuid, active: auth.peekCachedAccount(), accounts: accounts.slice() }),
    async login(opts) {
      calls.push(opts);
      if (failure) { const e = failure; failure = null; throw e; }
      const selected = accounts.find((item) => item.uuid === (mismatch ? 'second-uuid' : opts.accountUuid || activeUuid));
      if (!selected) throw new Error('本地没有保存的账号凭据，需要手动登录一次');
      if (opts.updateActive !== false) activeUuid = selected.uuid;
      return { accessToken: 'FIXTURE', profile: { id: selected.uuid, name: selected.name } };
    }, removeCachedAccount(uuid) {
      const index = accounts.findIndex((item) => item.uuid === uuid); if (index >= 0) accounts.splice(index, 1);
      if (activeUuid === uuid) activeUuid = accounts[0]?.uuid || null;
    } };
  return { auth, calls, select: (uuid) => { activeUuid = uuid; }, fail: (e) => { failure = e; }, mismatch: () => { mismatch = true; } };
}

async function run() {
  await test('Legacy per-server settings become independent initial values without modifying the source', () => {
    const legacy = store.normalize({ servers: [{ host: 'example.invalid' }],
      automation: { autoWelcome: true }, bridgeExit: { enabled: true, player: 'Legacy' } });
    const before = JSON.stringify(legacy);
    const a = effectiveAccount(legacy, 'first-uuid'), b = effectiveAccount(legacy, 'second-uuid');
    assert.equal(JSON.stringify(legacy), before);
    a.serverProfiles[key].automation.autoWelcome = false;
    assert.equal(b.serverProfiles[key].automation.autoWelcome, true);
    assert.deepEqual(b.serverProfiles[key].bridgeExit.players, ['Legacy']);
  });
  await test('Stale windows save only their own account, including mode, reconnect and server actions', () => {
    const file = path.join(dir, 'settings.json'); store.load(file);
    const stale = store.load(file).cfg;
    let a = effectiveAccount(stale, 'first-uuid'), b = effectiveAccount(stale, 'second-uuid');
    a.connectionMode = 'bridge'; a.reconnect.enabled = false;
    a.bridgeExit = { enabled: true, players: ['Alice', 'Bob'] }; a.automation.autoWelcome = true;
    a = profiles.saveProfile(a, key);
    b.connectionMode = 'standalone'; b.reconnect.enabled = true;
    b.bridgeExit = { enabled: false, players: ['Carol'] }; b.automation.autoWelcome = false;
    b = profiles.saveProfile(b, key);
    assert.equal(store.save(file, a, 'first-uuid').ok, true);
    assert.equal(store.save(file, b, 'second-uuid').ok, true);
    const root = store.load(file).cfg;
    const first = profiles.effectiveConfig(effectiveAccount(root, 'first-uuid'), key);
    const second = profiles.effectiveConfig(effectiveAccount(root, 'second-uuid'), key);
    assert.equal(first.connectionMode, 'bridge'); assert.equal(first.reconnect.enabled, false);
    assert.equal(first.automation.autoWelcome, true); assert.deepEqual(first.bridgeExit.players, ['Alice', 'Bob']);
    assert.equal(second.connectionMode, 'standalone'); assert.equal(second.automation.autoWelcome, false);
    assert.deepEqual(second.bridgeExit.players, ['Carol']);
    assert.equal('accountConfigs' in first, false, 'Other account settings are not sent to the renderer');
  });
  await test('Two actual Node processes cannot lose each other\'s account updates', async () => {
    const file = path.join(dir, 'concurrent.json'); store.load(file);
    const script = `const s=require('./src/configstore'); for(let i=0;i<35;i++) { const r=s.save(process.argv[1],s.normalize({username:process.argv[2],counter:i}),process.argv[2]); if(!r.ok) throw Error(r.error); }`;
    const child = (uuid) => new Promise((resolve, reject) => {
      const p = spawn(process.execPath, ['-e', script, file, uuid], { cwd: path.join(__dirname, '..'), windowsHide: true });
      let error = ''; p.stderr.on('data', (chunk) => { error += chunk; }); p.on('error', reject);
      p.on('exit', (code) => code === 0 ? resolve() : reject(new Error(error)));
    });
    await Promise.all([child('first-uuid'), child('second-uuid')]);
    const root = store.load(file).cfg;
    assert.equal(root.accountConfigs['first-uuid'].counter, 34);
    assert.equal(root.accountConfigs['second-uuid'].counter, 34);
    assert.equal(fs.existsSync(file + '.lock'), false);
  });
  await test('Corrupt shared settings are not overwritten by an account save', () => {
    const file = path.join(dir, 'broken.json'); fs.writeFileSync(file, '{broken');
    assert.equal(store.save(file, store.defaultConfig(), 'first-uuid').ok, false);
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  });
  await test('Welcome budgets and midnight daily reservations are independent for different accounts', () => {
    const root = path.join(dir, 'action-state');
    const a = accountStateFiles(root, 'first-uuid'), b = accountStateFiles(root, 'second-uuid');
    const aBudget = new WelcomeBudget(a.welcome), bBudget = new WelcomeBudget(b.welcome);
    assert.equal(aBudget.reserve('same-welcome').status, 'reserved');
    assert.equal(bBudget.reserve('same-welcome').status, 'reserved');
    assert.equal(reserveDay(a.midnight, '2026-10-24'), true);
    assert.equal(reserveDay(b.midnight, '2026-10-24'), true);
    assert.equal(reserveDay(accountStateFiles(root, 'first-uuid').midnight, '2026-10-24'), false);
  });
  await test('Legacy action records are copied once without resetting spent quota or touching original files', () => {
    const root = path.join(dir, 'legacy-state'); fs.mkdirSync(root);
    const legacy = path.join(root, 'midnight-command.json'); reserveDay(legacy, '2026-10-24');
    const before = fs.readFileSync(legacy, 'utf8');
    const a = accountStateFiles(root, 'first-uuid');
    assert.equal(reserveDay(a.midnight, '2026-10-24'), false);
    reserveDay(a.midnight, '2026-10-25'); accountStateFiles(root, 'first-uuid');
    assert.equal(JSON.parse(fs.readFileSync(a.midnight)).day, '2026-10-25');
    assert.equal(fs.readFileSync(legacy, 'utf8'), before);
  });
  await test('Two real main schedulers can dispatch each account\'s midnight command on the same day', async () => {
    const f = authFixture(), c = clock(new Date(2026, 9, 24, 0, 0, 0).getTime() - 100);
    class FakeDate extends Date { static now() { return c.now(); } }
    const dataDir = path.join(dir, 'two-schedulers'), commands = [[], []];
    const config = store.normalize({ servers: [{ host: 'example.invalid' }], autoLogin: false,
      midnightCommand: { enabled: true, command: '/fixture account' } });
    const make = (index) => mainHarness({ config, auth: f.auth, dataDir, Date: FakeDate,
      setTimeout: c.set, clearTimeout: c.clear, command: (value) => { commands[index].push(value); return true; } });
    const a = make(0); await a.connect(true); a.clients[0].state = 'play'; a.clients[0].opts.onEvent('join');
    f.select('second-uuid'); const b = make(1); await b.connect(true); b.clients[0].state = 'play'; b.clients[0].opts.onEvent('join');
    await c.advance(100);
    assert.deepEqual(commands, [['fixture account'], ['fixture account']]); a.quit(); b.quit();
  });
  await test('Two main processes keep their own selected UUID even when the shared preference changes', async () => {
    const fixture = authFixture(), c = clock();
    const config = store.normalize({ autoLogin: false, reconnect: { delaySeconds: 3, maxAttempts: 3 } });
    const a = mainHarness({ config, auth: fixture.auth, setTimeout: c.set, clearTimeout: c.clear });
    await a.invoke('config:get'); await a.connect(true);
    const first = a.clients[0]; first.state = 'play'; first.opts.onEvent('join');
    fixture.select('second-uuid');
    const b = mainHarness({ config, auth: fixture.auth }); await b.connect(true);
    assert.equal(b.clients[0].opts.uuid, 'second-uuid');
    first.opts.onEvent('close', { reason: 'ECONNRESET', retryable: true });
    const error = new Error('fetch failed'); error.temporary = true; fixture.fail(error);
    await c.advance(3000); assert.equal(a.clients.length, 1);
    await c.advance(6000); assert.equal(a.clients.length, 2);
    assert.equal(a.clients[1].opts.uuid, 'first-uuid');
    assert.deepEqual(fixture.calls.map((opts) => opts.accountUuid), ['first-uuid', 'second-uuid', 'first-uuid', 'first-uuid']);
    assert.equal((await a.invoke('account:peek')).activeUuid, 'first-uuid');
    assert.equal((await b.invoke('account:peek')).activeUuid, 'second-uuid');
    a.quit(); b.quit();
  });
  await test('Wrong identity and removed credentials stop recovery without falling back', async () => {
    for (const scenario of ['mismatch', 'removed']) {
      const f = authFixture(), c = clock();
      const h = mainHarness({ config: store.normalize({ reconnect: { delaySeconds: 3 } }), auth: f.auth,
        setTimeout: c.set, clearTimeout: c.clear });
      await h.connect(true); const client = h.clients[0]; client.state = 'play'; client.opts.onEvent('join');
      client.opts.onEvent('close', { reason: 'ECONNRESET', retryable: true });
      if (scenario === 'mismatch') f.mismatch(); else f.auth.removeCachedAccount('first-uuid');
      await c.advance(120000);
      assert.equal(h.clients.length, 1); assert.equal(f.calls.length, 2);
      assert.equal(h.statuses.filter((s) => s.reconnect).at(-1).reconnect.phase, 'idle'); h.quit();
    }
  });
  await test('Switching accounts restores settings and rejects a settings form from the previous account', async () => {
    const f = authFixture(); const file = path.join(dir, 'main-settings.json');
    store.save(file, store.normalize({ autoLogin: false }));
    const configStore = { ...store, load: () => store.load(file), save: (_file, cfg, uuid) => store.save(file, cfg, uuid) };
    const h = mainHarness({ auth: f.auth, configStore });
    await h.invoke('profile:select', { host: 'example.invalid' });
    const first = await h.invoke('config:get');
    assert.equal(h.configure({ ...first, bridgeExit: { enabled: true, players: ['Alice', 'Bob'] } }).ok, true);
    assert.equal((await h.invoke('account:switch', 'second-uuid')).ok, true);
    assert.equal(h.configure(first).ok, false);
    const second = await h.invoke('config:get');
    assert.equal(second.bridgeExit.enabled, false);
    assert.equal(h.configure({ ...second, bridgeExit: { enabled: true, players: ['Carol'] } }).ok, true);
    await h.invoke('account:switch', 'first-uuid');
    assert.deepEqual((await h.invoke('config:get')).bridgeExit.players, ['Alice', 'Bob']); h.quit();
  });
  await test('Account switch is refused while reconnecting and logout cannot display another cached account', async () => {
    const f = authFixture(), c = clock();
    const h = mainHarness({ auth: f.auth, config: store.normalize({ reconnect: { delaySeconds: 3 } }), setTimeout: c.set, clearTimeout: c.clear });
    await h.connect(true); const client = h.clients[0]; client.state = 'play'; client.opts.onEvent('join');
    client.opts.onEvent('close', { reason: 'ECONNRESET', retryable: true });
    assert.equal((await h.invoke('account:switch', 'second-uuid')).ok, false);
    h.logout(); assert.equal((await h.invoke('account:peek')).active, null);
    await c.advance(120000); assert.equal(h.clients.length, 1); h.quit();
  });
  console.log('=== ' + passed + ' account isolation tests passed ===');
}
run().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
