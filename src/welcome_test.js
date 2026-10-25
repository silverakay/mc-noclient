'use strict';

// Local files and fake command sink only. No Minecraft connections or chat sends.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ChatActions } = require('./chat_actions');
const { componentToRuns, componentToText } = require('./chat_component');
const { WelcomeAutomation, WelcomeBudget, welcomeCandidate, localDay } = require('./welcome');
const configstore = require('./configstore');
const { mainHarness } = require('./connection_lifecycle_test');
let pass = 0, fail = 0;

function fixture({ file, time = new Date(2026, 9, 9, 12).getTime() } = {}) {
  const dir = file ? path.dirname(file) : fs.mkdtempSync(path.join(os.tmpdir(), 'mc-welcome-'));
  file ||= path.join(dir, 'welcome-daily.json');
  const actions = new ChatActions(), commands = [], records = [], updates = [];
  const client = { state: 'play', username: 'Tester', command: (command) => { commands.push(command); return true; },
    say() { throw new Error('Chat sends forbidden'); } };
  const budget = new WelcomeBudget(file, { now: () => time });
  const auto = new WelcomeAutomation({ actions, budget, now: () => time,
    onRecord: (record) => records.push(record), onAction: (action) => updates.push(action) });
  const node = (name = 'Newcomer', options = {}) => ({ text: options.prefix === undefined
    ? '\u65b0\u73a9\u5bb6' + name + '\u52a0\u5165\u4e86\u8292\u679c\u5c0f\u9547\uff01' : options.prefix,
  extra: [{ text: options.label || '[ \ufffd\ufffd \u70b9\u51fb\u6b22\u8fce \ufffd\ufffd ]',
    click_event: options.event === undefined ? { action: 'run_command', command: '/welcome ' + name } : options.event }] });
  const message = (name, options = {}) => {
    const component = node(name, options);
    return { text: componentToText(component), type: options.type || 'system', session: actions.session,
      segments: actions.register(componentToRuns(component)) };
  };
  return { auto, actions, client, commands, records, updates, file, dir, node, message,
    run: (message, enabled = true, serverKey = 'example.invalid:25565') => auto.handle(message, client, {
      enabled, serverKey, delayEnabled: false }),
    at: (next) => { time = next; }, now: () => time };
}
async function test(name, fn) {
  try { await fn(); pass++; console.log('PASS ' + name); }
  catch (e) { fail++; console.error('FAIL ' + name + '\n' + e.stack); }
}

async function run() {
  await test('Garbled decorative symbols do not block the literal welcome click', async () => {
    const h = fixture(); assert.ok(welcomeCandidate(h.message('sw_wD')));
    assert.equal((await h.run(h.message('sw_wD'))).status, 'sent');
    assert.deepEqual(h.commands, ['welcome sw_wD']); assert.equal(h.records[0].count, 1);
    assert.match(h.records[0].detail, /1\/10/); assert.ok(!h.records.some((record) => record.status === 'confirmed'));
  });
  await test('Welcome uses a configurable random delay before dispatch', async () => {
    const h = fixture(); const timers = [];
    h.auto.setTimer = (fn, delay) => { timers.push({ fn, delay }); return timers.length; };
    h.auto.clearTimer = () => {}; h.auto.random = () => 0.5;
    const pending = h.auto.handle(h.message('Delayed'), h.client, { enabled: true,
      serverKey: 'example.invalid:25565', delay: { minMs: 1000, maxMs: 2000 }, delayEnabled: true });
    await Promise.resolve();
    assert.equal(h.commands.length, 0); assert.equal(timers[0].delay, 1500);
    timers[0].fn();
    assert.equal((await pending).status, 'sent'); assert.deepEqual(h.commands, ['welcome Delayed']);
    assert.ok(h.records.some((record) => record.status === 'scheduled' && /1\.500/.test(record.detail)));
  });
  await test('Cancelling a pending welcome delay never sends the command', async () => {
    const h = fixture(); const timers = [];
    h.auto.setTimer = (fn, delay) => { timers.push({ fn, delay }); return timers.length; };
    h.auto.clearTimer = () => {}; const pending = h.auto.handle(h.message('Cancelled'), h.client, {
      enabled: true, serverKey: 'example.invalid:25565', delay: { minMs: 1000, maxMs: 1000 } });
    await Promise.resolve(); h.auto.cancelScheduled();
    assert.equal((await pending).status, 'cancelled'); assert.equal(h.commands.length, 0);
  });
  await test('Ten distinct newcomers run; the eleventh and all later ones never run', async () => {
    const h = fixture(); for (let i = 1; i <= 10; i++) assert.equal((await h.run(h.message('Player' + i))).status, 'sent');
    for (let i = 11; i <= 15; i++) assert.equal((await h.run(h.message('Player' + i))).status, 'limited');
    assert.equal(h.commands.length, 10); assert.equal(JSON.parse(fs.readFileSync(h.file)).count, 10);
    assert.equal(h.records.filter((record) => record.status === 'limited').length, 1, 'Cap notice must not flood logs');
  });
  await test('Daily cap invalidates visible welcome actions so they cannot dispatch after 10/10', async () => {
    const h = fixture();
    for (let i = 1; i <= 10; i++) await h.run(h.message('Cap' + i));
    const late = h.message('LatePlayer');
    assert.equal((await h.run(late)).status, 'limited');
    assert.equal(h.actions.actions.size, 0);
    assert.equal((await h.actions.activate(late.segments.at(-1).click.id, h.client)).ok, false);
    assert.equal(h.updates.at(-1).limited, true);
  });
  await test('Budget survives application restart and cannot be reset by another server', async () => {
    const first = fixture(); for (let i = 0; i < 9; i++) await first.run(first.message('P' + i));
    const second = fixture({ file: first.file, time: first.now() });
    assert.equal((await second.run(second.message('Last'), true, 'other.invalid:25565')).count, 10);
    assert.equal((await first.run(first.message('Eleventh'))).status, 'limited'); assert.equal(second.commands.length, 1);
  });
  await test('Local midnight resets the budget while a clock rollback never does', async () => {
    const h = fixture(); for (let i = 0; i < 10; i++) await h.run(h.message('P' + i));
    h.at(new Date(2026, 9, 10, 0, 0, 0).getTime());
    assert.equal((await h.run(h.message('Tomorrow'))).count, 1);
    h.at(new Date(2026, 9, 9, 23, 59, 0).getTime());
    assert.equal((await h.run(h.message('Rollback'))).status, 'failed'); assert.equal(h.commands.length, 11);
    assert.equal(localDay(new Date(2026, 9, 10).getTime()), '2026-10-10');
  });
  await test('Repeated broadcasts, new action IDs and reconnect sessions welcome a person only once per day', async () => {
    const h = fixture(); await h.run(h.message('Newcomer'));
    assert.equal((await h.run(h.message('newcomer'))).status, 'duplicate'); h.actions.reset();
    assert.equal((await h.run(h.message('Newcomer'))).status, 'duplicate'); assert.equal(h.commands.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(h.file)).count, 1); assert.equal(h.updates.at(-1).used, true);
  });
  await test('Parallel message callbacks cannot reserve an eleventh action', async () => {
    const h = fixture(); await Promise.all(Array.from({ length: 20 }, (_, index) => h.run(h.message('Concurrent' + index))));
    assert.equal(h.commands.length, 10); assert.equal(JSON.parse(fs.readFileSync(h.file)).count, 10);
  });
  await test('Split text styles with one server command retain the welcome label', async () => {
    const h = fixture(); const node = { text: '\u65b0\u73a9\u5bb6Split\u52a0\u5165\u4e86\u8292\u679c\u5c0f\u9547!',
      extra: [{ text: '[\u70b9\u51fb', click_event: { action: 'run_command', command: '/welcome Split' },
        extra: [{ text: '\u6b22\u8fce]', bold: true }] }, { text: ' \ufffd' }] };
    const message = { text: componentToText(node), type: 'system', session: h.actions.session,
      segments: h.actions.register(componentToRuns(node)) };
    assert.equal((await h.run(message)).status, 'sent'); assert.equal(h.commands[0], 'welcome Split');
  });
  for (const options of [
    { type: 'player' }, { type: 'mine' }, { type: 'actionbar' }, { event: null },
    { label: '[\u70b9\u51fb\u7b7e\u5230]' }, { prefix: '\u666e\u901a\u901a\u77e5' },
    { prefix: '\u65b0\u73a9\u5bb6TooLongPlayerName123\u52a0\u5165\u4e86\u8292\u679c\u5c0f\u9547!' },
    { event: { action: 'open_url', url: 'https://example.invalid/' } },
    { event: { action: 'copy_to_clipboard', value: '/welcome' } },
    { event: { action: 'suggest_command', command: '/welcome suggested' } },
    { event: { action: 'run_command', command: '/one\n/two' } },
  ]) await test('Unrelated/player/unsafe/suggest-only welcome cannot send: ' + JSON.stringify(options), async () => {
    const h = fixture(); await h.run(h.message('Newcomer', options)); assert.equal(h.commands.length, 0);
    assert.equal(fs.existsSync(h.file), false);
  });
  await test('Ambiguous welcome commands are not guessed', async () => {
    const h = fixture(), node = h.node('Ambiguous');
    node.extra.push({ text: '[\u70b9\u51fb\u6b22\u8fce]', click_event: { action: 'run_command', command: '/other' } });
    const message = { text: componentToText(node), type: 'system', session: h.actions.session,
      segments: h.actions.register(componentToRuns(node)) };
    assert.equal(await h.run(message), null); assert.equal(h.commands.length, 0);
  });
  await test('Disabled, stale or disconnected sessions cannot consume the budget', async () => {
    const h = fixture(); await h.run(h.message('Disabled'), false); const stale = h.message('Stale');
    h.actions.reset(); await h.run(stale);
    for (const state of ['login', 'config', 'closed']) { h.client.state = state; await h.run(h.message('Offline')); }
    assert.equal(h.commands.length, 0); assert.equal(fs.existsSync(h.file), false);
  });
  await test('An unregistered action cannot reserve an allowance', async () => {
    const h = fixture(), message = h.message('Newcomer'); message.segments.at(-1).click.id = 'forged';
    assert.equal(await h.run(message), null); assert.equal(fs.existsSync(h.file), false);
  });
  await test('Corrupt counters fail closed and remain untouched', async () => {
    const h = fixture(); fs.writeFileSync(h.file, '{broken');
    assert.equal((await h.run(h.message('NoCounter'))).status, 'failed'); assert.equal(h.commands.length, 0);
    assert.equal(fs.readFileSync(h.file, 'utf8'), '{broken'); assert.equal(fs.existsSync(h.file + '.lock'), false);
  });
  await test('Counter write failure or another process lock prevents command dispatch', async () => {
    const h = fixture(); fs.mkdirSync(h.file + '.tmp');
    assert.equal((await h.run(h.message('NoWrite'))).status, 'failed'); assert.equal(h.commands.length, 0);
    assert.equal(fs.existsSync(h.file + '.lock'), false);
    fs.writeFileSync(h.file + '.lock', 'another instance');
    assert.equal((await h.run(h.message('Locked'))).status, 'failed'); assert.equal(h.commands.length, 0);
    assert.equal(fs.readFileSync(h.file + '.lock', 'utf8'), 'another instance');
  });
  await test('Send failure still consumes one attempt and never retries the same newcomer', async () => {
    const h = fixture(); h.client.command = () => false;
    assert.equal((await h.run(h.message('Failed'))).status, 'failed');
    assert.equal((await h.run(h.message('Failed'))).status, 'duplicate');
    assert.equal(JSON.parse(fs.readFileSync(h.file)).count, 1); assert.equal(h.records[0].status, 'failed');
    h.client.command = () => { throw new Error('fixture error'); };
    assert.equal((await h.run(h.message('Throws'))).status, 'failed'); assert.equal(JSON.parse(fs.readFileSync(h.file)).count, 2);
  });
  await test('Welcome settings default on, persist off and do not reset the budget', () => {
    const h = fixture(), file = path.join(h.dir, 'config.json');
    assert.equal(configstore.normalize({}).automation.autoWelcome, true);
    const config = configstore.normalize({ automation: { autoWelcome: false, autoClaimRedPackets: true } });
    configstore.save(file, config); assert.equal(configstore.load(file, []).cfg.automation.autoWelcome, false);
    assert.equal(configstore.normalize({ automation: { autoWelcome: 'bad' } }).automation.autoWelcome, true);
  });
  await test('Main IPC automatically welcomes with chat hidden, emits audit, and respects its switch', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-welcome-main-'));
    const config = configstore.normalize({ servers: [], autoLogin: false, behavior: { showChat: false } });
    const h = mainHarness({ dataDir: dir, config }); await h.connect(); const client = h.clients[0]; client.state = 'play';
    client.opts.onEvent('join'); const fixtureBuilder = fixture(); const node = fixtureBuilder.node('MainPlayer');
    const meta = { type: 'system', origin: 'system', segments: componentToRuns(node) };
    client.opts.onChat(componentToText(node), meta); client.opts.onChat(componentToText(node), meta);
    await new Promise(setImmediate); assert.equal(h.business(), 1);
    assert.ok(h.logs.some((log) => log.level === 'automation' && /1\/10/.test(log.text)));
    assert.ok(h.statuses.some((status) => status.automationAction && status.automationAction.source === 'welcome'));
    assert.equal(h.logs.some((log) => log.text === componentToText(node)), false);
    h.configure({ ...config, automation: { ...config.automation, autoWelcome: false } });
    const disabled = fixtureBuilder.node('DisabledMain'); client.opts.onChat(componentToText(disabled),
      { type: 'system', segments: componentToRuns(disabled) }); await new Promise(setImmediate);
    assert.equal(h.business(), 1); h.disconnect(); client.opts.onChat(componentToText(node), meta);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'welcome-daily.json'))).count, 1);
  });
  console.log('=== ' + pass + ' welcome tests passed / ' + fail + ' failed ==='); process.exitCode = fail ? 1 : 0;
}
run().catch((e) => { console.error(e); process.exitCode = 1; });
