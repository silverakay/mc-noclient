'use strict';

const assert = require('assert/strict');
const { ChatActions } = require('./chat_actions');
const { componentToRuns, componentToText } = require('./chat_component');
const { RedPacketAutomation, claimCandidate, chatCategory } = require('./red_packet');
const { mainHarness } = require('./connection_lifecycle_test');
const store = require('./configstore');
let passed = 0, failed = 0;
const prefix = '[\u7ea2\u5305]\u73a9\u5bb6 Sender \u53d1\u9001\u4e86\u4e00\u4e2a \u62fc\u624b\u6c14\u7ea2\u5305 ';
const claim = '\u3010\u70b9\u51fb\u9886\u53d6\u3011';
const password = '\u3010\u8f93\u5165\u53e3\u4ee4\u9886\u53d6\u3011';

function harness() {
  let time = 1000, seq = 0;
  const actions = new ChatActions(), commands = [], records = [], updates = [], timers = new Map();
  const client = { state: 'play', username: 'Tester', command: (value) => { commands.push(value); return true; },
    say() { throw new Error('Automation must never send chat'); } };
  const auto = new RedPacketAutomation({ actions, onRecord: (r) => records.push(r), onAction: (r) => updates.push(r),
    now: () => time, setTimer: (fn) => { timers.set(++seq, fn); return seq; }, clearTimer: (id) => timers.delete(id) });
  const message = (opts = {}) => {
    const node = { text: opts.prefix === undefined ? prefix : opts.prefix, extra: [{ text: opts.label || claim,
      click_event: opts.event === undefined ? { action: 'run_command', command: opts.command || '/packet claim fixture' } : opts.event }] };
    if (opts.trailing) node.extra.push({ text: opts.trailing });
    return { text: componentToText(node), type: opts.type || 'system', session: actions.session,
      segments: actions.register(componentToRuns(node)) };
  };
  const receive = (text, type = 'system') => ({ text, type, session: actions.session, segments: [] });
  return { actions, auto, client, commands, records, updates, timers, message, receive,
    tick: (ms) => { time += ms; }, run: (m, enabled = true, serverKey = 'example.invalid:25565') => auto.handle(m, client,
      { enabled, serverKey, delay: { minMs: 0, maxMs: 0 } }) };
}
async function test(name, fn) {
  try { await fn(); passed++; console.log('  [PASS] ' + name); }
  catch (e) { failed++; console.error('  [FAIL] ' + name + '\n         ' + e.stack); }
}
async function run() {
  await test('Categories separate player, server, actionbar and red-packet content', () => {
    assert.equal(chatCategory(prefix, 'system'), 'redpacket');
    assert.equal(chatCategory(prefix, 'player'), 'player');
    assert.equal(chatCategory('hi', 'system'), 'system');
    assert.equal(chatCategory('hi', 'actionbar'), 'actionbar');
  });
  await test('Automatically executes only the server-supplied final claim command', async () => {
    const h = harness(); const m = h.message(); assert.ok(claimCandidate(m));
    assert.equal((await h.run(m)).status, 'sent'); assert.deepEqual(h.commands, ['packet claim fixture']);
    assert.equal(h.records[0].status, 'sent'); assert.equal(h.records.some((r) => r.status === 'confirmed'), false);
    h.auto.resetPending();
  });
  await test('New-ID duplicate broadcasts execute once and expire all duplicate buttons', async () => {
    const h = harness(); const first = h.message(); await h.run(first);
    const duplicate = h.message(); assert.equal((await h.run(duplicate)).status, 'duplicate');
    assert.equal(h.commands.length, 1);
    for (const m of [first, duplicate]) assert.equal((await h.actions.activate(m.segments.at(-1).click.id, h.client)).ok, false);
    assert.equal(h.records.length, 1); h.auto.resetPending();
  });
  await test('Parallel replay cannot execute twice', async () => {
    const h = harness(); await Promise.all([h.run(h.message()), h.run(h.message())]);
    assert.equal(h.commands.length, 1); h.auto.resetPending();
  });
  await test('Disabling auto claim performs no action or log', async () => {
    const h = harness(); await h.run(h.message(), false); assert.equal(h.commands.length, 0); assert.equal(h.records.length, 0);
  });
  for (const type of ['player', 'mine']) await test('A player cannot trigger auto claim via a spoofed prefix: ' + type, async () => {
    const h = harness(); await h.run(h.message({ type })); assert.equal(h.commands.length, 0);
  });
  for (const opts of [{ prefix: 'Server notice ' }, { label: '\u3010\u7b7e\u5230\u3011' }, { trailing: 'Other content' },
    { event: { action: 'open_url', url: 'https://example.invalid/' } }, { event: { action: 'copy_to_clipboard', value: '/claim' } },
    { event: null }, { command: 'chat text' }, { command: '/one\n/two' }]) {
    await test('Unrelated/unsafe/missing action is never automated: ' + JSON.stringify(opts), async () => {
      const h = harness(); assert.equal(claimCandidate(h.message(opts)), null);
      await h.run(h.message(opts)); assert.equal(h.commands.length, 0); assert.equal(h.records.length, 0);
    });
  }
  await test('Split rich-text claim labels retain the same command', async () => {
    const h = harness(); const node = { text: prefix, extra: [{ text: '\u3010\u70b9\u51fb',
      clickEvent: { action: 'run_command', value: '/packet split' }, extra: [{ text: '\u9886\u53d6\u3011', bold: true }] }] };
    const m = { text: componentToText(node), type: 'system', session: h.actions.session, segments: h.actions.register(componentToRuns(node)) };
    await h.run(m); assert.deepEqual(h.commands, ['packet split']); h.auto.resetPending();
  });
  await test('Password suggest action only requests input fill, never command/chat sending', async () => {
    const h = harness(); const m = h.message({ label: password, event: { action: 'suggest_command', command: '/packet password ' } });
    assert.equal((await h.run(m)).status, 'suggested'); assert.equal(h.commands.length, 0);
    assert.equal(h.updates[0].action, 'suggest_command'); assert.equal(h.records[0].status, 'suggested');
  });
  await test('Stale sessions and non-play phases cannot auto claim', async () => {
    const h = harness(); const stale = h.message(); h.actions.reset(); await h.run(stale);
    for (const state of ['login', 'config', 'closed']) { h.client.state = state; await h.run(h.message()); }
    assert.equal(h.commands.length, 0);
  });
  await test('Disconnected send failure is recorded and never retried', async () => {
    const h = harness(); h.client.command = () => false; const m = h.message(); await h.run(m); await h.run(m);
    assert.equal(h.records.length, 1); assert.equal(h.records[0].status, 'failed'); assert.equal(h.timers.size, 0);
  });
  await test('Other players claiming never count as our reward', async () => {
    const h = harness(); await h.run(h.message());
    await h.run(h.receive('[\u7ea2\u5305]Other \u9886\u53d6\u4e86 Sender \u53d1\u9001\u7684 \u7ea2\u5305\uff0c\u91d1\u989d\uff1a500 \u91d1\u5e01'));
    assert.deepEqual(h.records.map((r) => r.status), ['sent']); assert.equal(h.timers.size, 1); h.auto.resetPending();
  });
  await test('Natural personal feedback confirms reward and cancels its timeout', async () => {
    const h = harness(); await h.run(h.message());
    await h.run(h.receive('[\u7ea2\u5305]Tester \u9886\u53d6\u4e86 Sender \u53d1\u9001\u7684 \u7ea2\u5305\uff0c\u91d1\u989d\uff1a503.31 \u91d1\u5e01'));
    assert.equal(h.records.at(-1).status, 'confirmed'); assert.match(h.records.at(-1).detail, /503.31/); assert.equal(h.timers.size, 0);
  });
  await test('Feedback from another sender/target cannot confirm pending claim', async () => {
    const h = harness(); await h.run(h.message());
    const feedback = h.receive('[\u7ea2\u5305]Tester \u9886\u53d6\u4e86 WrongSender \u53d1\u9001\u7684 \u7ea2\u5305');
    await h.run(feedback); assert.equal(h.records.at(-1).status, 'sent');
    await h.run(h.receive('[\u7ea2\u5305]Tester \u9886\u53d6\u4e86 Sender \u53d1\u9001\u7684 \u7ea2\u5305'), true, 'other.invalid');
    assert.equal(h.records.at(-1).status, 'sent'); h.auto.resetPending();
  });
  await test('Failure feedback is not a success', async () => {
    const h = harness(); await h.run(h.message()); await h.run(h.receive('[\u7ea2\u5305]\u7ea2\u5305\u5df2\u88ab\u62a2\u5b8c'));
    assert.equal(h.records.at(-1).status, 'rejected'); assert.equal(h.timers.size, 0);
  });
  await test('Absent feedback records unconfirmed, not received', async () => {
    const h = harness(); await h.run(h.message()); for (const fn of h.timers.values()) fn();
    assert.equal(h.records.at(-1).status, 'unconfirmed'); assert.equal(h.auto.pending.size, 0); h.auto.resetPending();
  });
  await test('Disconnect clears pending timers; replay after reconnect remains deduplicated', async () => {
    const h = harness(); await h.run(h.message()); h.auto.resetPending(); h.actions.reset();
    await h.run(h.message()); assert.equal(h.commands.length, 1); assert.equal(h.timers.size, 0);
  });
  await test('Flood guard limits auto commands to ten per minute', async () => {
    const h = harness(); for (let i = 0; i < 15; i++) await h.run(h.message({ command: '/packet claim ' + i }));
    assert.equal(h.commands.length, 10); assert.equal(h.records.filter((r) => r.status === 'limited').length, 5); h.auto.resetPending();
  });
  await test('Dedupe is bounded and expires rather than blocking generic claims forever', async () => {
    const h = harness(); await h.run(h.message()); h.tick(120001); await h.run(h.message());
    assert.equal(h.commands.length, 2); h.auto.resetPending();
  });
  await test('Real main IPC: automatic claim once, chat-only broadcasts, audit-only logs', async () => {
    const config = store.normalize({ servers: [], autoLogin: false, behavior: { showChat: true } });
    const h = mainHarness({ config }); await h.connect(); h.clients[0].state = 'play'; h.clients[0].username = 'Tester';
    h.clients[0].opts.onEvent('join');
    const node = { text: prefix, extra: [{ text: claim, click_event: { action: 'run_command', command: '/packet main' } }] };
    const meta = { type: 'system', segments: componentToRuns(node) };
    h.clients[0].opts.onChat(componentToText(node), meta); h.clients[0].opts.onChat(componentToText(node), meta);
    await new Promise(setImmediate);
    assert.equal(h.business(), 1); assert.equal(h.chats.length, 2);
    assert.ok(h.logs.some((log) => log.level === 'automation'));
    assert.equal(h.logs.some((log) => log.text === componentToText(node)), false);
    assert.ok(h.statuses.some((status) => status.redPacketAction && status.redPacketAction.used)); h.disconnect();
  });
  console.log('\nResult: ' + passed + ' passed / ' + failed + ' failed'); process.exitCode = failed ? 1 : 0;
}
run().catch((e) => { console.error(e); process.exitCode = 1; });
