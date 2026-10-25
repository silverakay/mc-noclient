'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ChatActions } = require('./chat_actions');
const { WelcomeAutomation, WelcomeBudget, normalizeWelcomeDelay } = require('./welcome');
const { mainHarness } = require('./connection_lifecycle_test');
const { normalize } = require('./configstore');

function fixture(random = 0) {
  let time = new Date(2026, 9, 21, 12).getTime(), seq = 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-welcome-delay-'));
  const file = path.join(dir, 'welcome.json');
  const actions = new ChatActions(), timers = new Map(), commands = [];
  const client = { state: 'play', command: (value) => { commands.push(value); return true; } };
  const budget = new WelcomeBudget(file, { now: () => time });
  const auto = new WelcomeAutomation({ actions, budget, now: () => time, random: () => random,
    setTimer: (fn, ms) => { timers.set(++seq, { fn, ms }); return seq; }, clearTimer: (id) => timers.delete(id) });
  const message = (name = 'Newbie') => ({ text: '新玩家' + name + '加入了测试服！', type: 'system', session: actions.session,
    segments: actions.register([{ text: '[点击欢迎]', click: { action: 'run_command', value: '/welcome ' + name } }]) });
  const fire = () => { const [id, timer] = timers.entries().next().value; timers.delete(id); time += timer.ms; timer.fn(); };
  return { dir, file, auto, timers, client, actions, commands, message, fire,
    run: (m = message(), extra = {}) => auto.handle(m, client, { enabled: true, serverKey: 'fixture.invalid', ...extra }),
    jump: (ms) => { time += ms; } };
}

let pass = 0;
async function test(name, fn) { await fn(); pass++; console.log('PASS ' + name); }

async function run() {
  await test('Welcome delay defaults and invalid ranges are bounded independently of red packets', () => {
    for (const value of [undefined, null, {}, { minMs: -1, maxMs: 100 }, { minMs: 1, maxMs: 30001 },
      { minMs: 500, maxMs: 400 }, { minMs: '400', maxMs: 850 }, { minMs: 0.1, maxMs: 1 }]) {
      assert.deepEqual(normalizeWelcomeDelay(value), { minMs: 400, maxMs: 850 });
    }
  });
  for (const [sample, expected] of [[0, 400], [0.5, 625], [0.999999, 850]]) {
    await test('Welcome random sample ' + sample + ' waits ' + expected + ' ms', async () => {
      const h = fixture(sample), pending = h.run();
      assert.equal([...h.timers.values()][0].ms, expected);
      assert.equal(fs.existsSync(h.file), false, 'Waiting must not consume the daily allowance');
      h.fire(); assert.equal((await pending).status, 'sent'); assert.equal(h.commands.length, 1);
    });
  }
  await test('Duplicate broadcasts do not invalidate the first delayed welcome', async () => {
    const h = fixture(), pending = h.run();
    assert.equal((await h.run()).status, 'duplicate'); assert.equal(h.timers.size, 1);
    h.fire(); assert.equal((await pending).status, 'sent'); assert.equal(h.commands.length, 1);
  });
  await test('Twenty concurrently pending newcomers still dispatch at most ten commands', async () => {
    const h = fixture(), pending = Array.from({ length: 20 }, (_, i) => h.run(h.message('Player' + i)));
    for (const [id, timer] of [...h.timers]) { h.timers.delete(id); timer.fn(); }
    await Promise.all(pending);
    assert.equal(h.commands.length, 10); assert.equal(JSON.parse(fs.readFileSync(h.file)).count, 10);
  });
  for (const [name, change] of [
    ['disconnect', (h) => { h.client.state = 'closed'; }], ['session switch', (h) => h.actions.reset()],
    ['automation conflict', (h) => { h.client.automationBlocked = true; }],
    ['sleep', (h) => h.jump(10000)], ['clock rollback', (h) => h.jump(-10000)],
    ['next local day', (h) => h.jump(86400000)],
  ]) await test('Delayed welcome is skipped after ' + name, async () => {
    const h = fixture(), pending = h.run(); change(h); h.fire();
    assert.equal((await pending).status, 'cancelled'); assert.equal(h.commands.length, 0);
    assert.equal(fs.existsSync(h.file), false);
  });
  await test('Manual click on a duplicate ID cancels the delayed welcome', async () => {
    const h = fixture(), pending = h.run(), duplicate = h.message();
    await h.run(duplicate); h.auto.cancelCommand('/welcome Newbie', h.actions.session);
    assert.equal((await h.actions.activate(duplicate.segments[0].click.id, h.client)).ok, true);
    assert.equal((await pending).status, 'cancelled'); assert.equal(h.commands.length, 1); assert.equal(h.timers.size, 0);
  });
  await test('Cancellation after a timer has fired but before its continuation still prevents dispatch', async () => {
    const h = fixture(), pending = h.run(); h.fire(); h.auto.cancelScheduled();
    assert.equal((await pending).status, 'cancelled'); assert.equal(h.commands.length, 0);
  });
  await test('A stale timer callback cannot revive a cancelled welcome', async () => {
    const h = fixture(), pending = h.run(), callback = [...h.timers.values()][0].fn;
    h.auto.cancelScheduled(); callback(); assert.equal((await pending).status, 'cancelled');
    assert.equal(h.timers.size, 0); assert.equal(h.commands.length, 0);
  });
  await test('Zero delay and an explicitly disabled delay dispatch immediately', async () => {
    const h = fixture();
    await h.run(h.message('Zero'), { delay: { minMs: 0, maxMs: 0 } });
    await h.run(h.message('Disabled'), { delayEnabled: false });
    assert.equal(h.commands.length, 2); assert.equal(h.timers.size, 0);
  });
  await test('Main IPC validates welcome settings and cancels waits on policy changes and disconnect', async () => {
    const timers = new Map(); let seq = 0;
    const config = normalize({ servers: [], autoLogin: false });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-welcome-ipc-delay-'));
    const h = mainHarness({ config, dataDir: dir, welcomeDelay: { minMs: 1000, maxMs: 1000 },
      setTimeout: (fn, ms) => { timers.set(++seq, { fn, ms }); return seq; }, clearTimeout: (id) => timers.delete(id) });
    await h.connect(); const client = h.clients[0]; client.state = 'play'; client.opts.onEvent('join');
    const chat = (name) => client.opts.onChat('新玩家' + name + '加入了测试服！', { type: 'system', origin: 'system',
      segments: [{ text: '[点击欢迎]', click: { action: 'run_command', value: '/welcome ' + name } }] });
    chat('Main'); assert.ok([...timers.values()].some((timer) => timer.ms === 1000));
    const invalid = await h.configure({ ...config, automation: { ...config.automation, welcomeDelayEnabled: 'bad' } });
    assert.equal(invalid.ok, false);
    const invalidRange = await h.configure({ ...config, automation: { ...config.automation, welcomeDelay: { minMs: 2000, maxMs: 1000 } } });
    assert.equal(invalidRange.ok, false);
    await h.configure({ ...config, automation: { ...config.automation, welcomeDelay: { minMs: 2000, maxMs: 2000 } } });
    await new Promise(setImmediate); assert.equal(h.business(), 0);
    assert.equal([...timers.values()].some((timer) => timer.ms === 1000), false);
    chat('Another'); assert.ok([...timers.values()].some((timer) => timer.ms === 2000));
    h.disconnect(); await new Promise(setImmediate);
    assert.equal([...timers.values()].some((timer) => timer.ms === 2000), false); assert.equal(h.business(), 0);
  });
  console.log('=== ' + pass + ' welcome delay tests passed ===');
}
run().catch((error) => { console.error(error.stack); process.exitCode = 1; });
