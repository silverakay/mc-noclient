'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { randomUUID } = require('crypto');
const { MidnightCommand, normalizeMidnight, nextMidnight, reserveDay } = require('./midnight_command');
const { BridgeClient } = require('./client_bridge');
const { mainHarness } = require('./connection_lifecycle_test');
const store = require('./configstore');

const boundary = () => new Date(2026, 9, 10, 0, 0, 0, 0).getTime();
function clock(time = boundary() - 100) {
  let now = time, id = 0;
  const tasks = new Map();
  return { now: () => now, tasks,
    set: (fn, delay) => { const key = ++id; tasks.set(key, { fn, at: now + delay }); return key; },
    clear: (key) => tasks.delete(key),
    jump: (time) => { now = time; },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const first = [...tasks].sort((a, b) => a[1].at - b[1].at)[0];
        if (!first || first[1].at > end) break;
        tasks.delete(first[0]); now = first[1].at; await first[1].fn();
      }
      now = end;
    },
    late(time) {
      const first = [...tasks].sort((a, b) => a[1].at - b[1].at)[0];
      tasks.delete(first[0]); now = time; return first[1].fn();
    },
  };
}
function fixture(options = {}) {
  const c = clock(options.time), calls = [], records = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-midnight-test-'));
  const file = path.join(dir, 'midnight-command.json');
  let client = { state: 'play', command: (value) => { calls.push({ value, time: c.now() }); return true; } };
  const scheduler = new MidnightCommand({ file, getClient: () => client, now: c.now,
    setTimer: c.set, clearTimer: c.clear, onRecord: (record) => records.push(record) });
  scheduler.configure({ enabled: true, command: '/fixture midnight' }); scheduler.start();
  return { c, calls, records, file, scheduler, client, setClient: (next) => { client = next; } };
}

let passed = 0, failed = 0;
async function test(label, fn) {
  try { await fn(); passed++; console.log('PASS ' + label); }
  catch (e) { failed++; console.error('FAIL ' + label + '\n' + e.stack); }
}
async function run() {
  await test('Opt-in setting validates one slash command and preserves arguments', () => {
    assert.deepEqual(normalizeMidnight(), { enabled: false, command: '' });
    assert.deepEqual(normalizeMidnight({ enabled: true, command: ' /fixture one two ' }),
      { enabled: true, command: '/fixture one two' });
    assert.deepEqual(normalizeMidnight({ enabled: false, command: '/fixture saved' }),
      { enabled: false, command: '/fixture saved' });
    for (const command of ['', 'fixture', '/', '//fixture', '/ fixture', '/a\n/b', '/a\0', '/' + 'x'.repeat(2048)]) {
      assert.equal(normalizeMidnight({ enabled: true, command }).enabled, false, JSON.stringify(command));
    }
  });
  await test('Local midnight fires once, never early, and removes only the leading slash', async () => {
    const f = fixture(); await f.c.advance(99); assert.equal(f.calls.length, 0);
    await f.c.advance(1); assert.deepEqual(f.calls, [{ value: 'fixture midnight', time: boundary() }]);
    await f.c.advance(1000); assert.equal(f.calls.length, 1);
    assert.equal(f.records.at(-1).status, 'sent'); assert.equal(f.c.tasks.size, 1); f.scheduler.stop();
  });
  await test('Each new local day schedules a single fresh attempt', async () => {
    const f = fixture(); await f.c.advance(100); await f.c.advance(nextMidnight(boundary()) - boundary());
    assert.equal(f.calls.length, 2); f.scheduler.stop();
  });
  await test('Starting within the midnight second never catches up', async () => {
    const f = fixture({ time: boundary() + 250 }); await f.c.advance(1000);
    assert.equal(f.calls.length, 0); f.scheduler.stop();
  });
  await test('Late timer beyond midnight second skips without catch-up', async () => {
    const f = fixture(); await f.c.late(boundary() + 1000);
    assert.equal(f.calls.length, 0); assert.equal(f.records.at(-1).status, 'skipped');
    await f.c.advance(60000); assert.equal(f.calls.length, 0); f.scheduler.stop();
  });
  await test('Normal sub-second timer latency stays within 00:00:00', async () => {
    const f = fixture(); await f.c.late(boundary() + 100);
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].time, boundary() + 100); f.scheduler.stop();
  });
  for (const state of ['login', 'config', 'closed']) await test('Not online at midnight: ' + state, async () => {
    const f = fixture(); f.client.state = state; await f.c.advance(100);
    f.client.state = 'play'; await f.c.advance(1000);
    assert.equal(f.calls.length, 0); assert.equal(f.records.at(-1).status, 'skipped'); f.scheduler.stop();
  });
  await test('Missing client or blocked automation cannot dispatch', async () => {
    for (const client of [null, { state: 'play', automationBlocked: true }]) {
      const f = fixture(); f.setClient(client); await f.c.advance(100);
      assert.equal(f.calls.length, 0); assert.equal(f.records.at(-1).status, 'skipped'); f.scheduler.stop();
    }
  });
  await test('Disable cancels pending callbacks; editing selects only the latest command', async () => {
    const f = fixture(), stale = [...f.c.tasks.values()][0].fn;
    f.scheduler.configure({ enabled: false, command: '/fixture midnight' });
    await f.c.advance(100); await stale(); assert.equal(f.calls.length, 0); assert.equal(f.c.tasks.size, 0);
    f.c.jump(boundary() - 100); f.scheduler.configure({ enabled: true, command: '/fixture updated args' });
    await f.c.advance(100); assert.equal(f.calls[0].value, 'fixture updated args'); f.scheduler.stop();
  });
  await test('Identical settings reload does not move the scheduled boundary', async () => {
    const f = fixture(); await f.c.advance(50);
    f.scheduler.configure({ enabled: true, command: '/fixture midnight' });
    await f.c.advance(50); assert.equal(f.calls.length, 1); f.scheduler.stop();
  });
  await test('Sleep and resume skip the missed boundary; quit clears timers', async () => {
    const f = fixture(), stale = [...f.c.tasks.values()][0].fn;
    f.scheduler.stop(); f.c.jump(boundary() + 300); f.scheduler.start(); await stale(); await f.c.advance(1000);
    assert.equal(f.calls.length, 0); f.scheduler.stop(); assert.equal(f.c.tasks.size, 0);
  });
  await test('Daily reservation precedes dispatch and survives restart and clock rollback', async () => {
    const f = fixture(); f.client.command = () => {
      assert.equal(JSON.parse(fs.readFileSync(f.file)).day, '2026-10-10'); f.calls.push('sent'); return true;
    };
    await f.c.advance(100); f.scheduler.stop(); f.c.jump(boundary() - 100); f.scheduler.start();
    await f.c.advance(100); assert.equal(f.calls.length, 1);
    assert.equal(reserveDay(f.file, '2026-10-09'), false); f.scheduler.stop();
  });
  await test('Two local instances share one daily reservation', async () => {
    const f = fixture(); const second = new MidnightCommand({ file: f.file, getClient: () => f.client,
      now: f.c.now, setTimer: f.c.set, clearTimer: f.c.clear });
    second.configure({ enabled: true, command: '/fixture second' }); second.start();
    await f.c.advance(100); assert.equal(f.calls.length, 1); f.scheduler.stop(); second.stop();
  });
  await test('Corrupt record, occupied lock or unavailable storage fails closed', async () => {
    for (const problem of ['corrupt', 'locked', 'unwritable']) {
      const f = fixture();
      if (problem === 'corrupt') fs.writeFileSync(f.file, '{');
      if (problem === 'locked') fs.writeFileSync(f.file + '.lock', 'fixture');
      if (problem === 'unwritable') { fs.writeFileSync(f.file, 'fixture'); f.scheduler.file = path.join(f.file, 'child'); }
      await f.c.advance(100); assert.equal(f.calls.length, 0); assert.equal(f.records.at(-1).status, 'failed'); f.scheduler.stop();
    }
  });
  for (const response of [false, { ok: false, error: 'fixture timeout' }, new Error('fixture failure')]) {
    await test('Failed or uncertain send is not retried: ' + String(response.error || response), async () => {
      const f = fixture(); let sends = 0;
      f.client.command = async () => { sends++; if (response instanceof Error) throw response; return response; };
      await f.c.advance(100); assert.equal(f.records.at(-1).status, 'failed');
      f.c.jump(boundary() - 100); f.scheduler.start(); await f.c.advance(100);
      assert.equal(sends, 1); f.scheduler.stop();
    });
  }
  await test('Bridge mode uses existing manual command request and awaits game dispatch only', async () => {
    const f = fixture(), frames = [];
    const peer = new BridgeClient({ destroyed: false, destroy() {} }, (frame) => { frames.push(frame); return true; }, { now: f.c.now });
    const session = randomUUID();
    peer.receive({ kind: 'state', seq: 1, online: true, session, host: 'fixture.invalid', port: 25565, username: 'Tester' });
    f.setClient(peer); const pending = f.c.advance(100);
    assert.equal(frames.length, 1); assert.equal(frames[0].manual, 'command'); assert.equal(frames[0].value, 'fixture midnight');
    assert.equal(frames[0].expiresAt, boundary() + 999, 'Game must reject a queued command after the midnight second');
    assert.equal(f.records.length, 0, 'Do not claim dispatch before the mod replies');
    peer.receive({ kind: 'result', seq: 2, session, id: frames[0].id, ok: true }); await pending;
    assert.equal(f.records.at(-1).status, 'sent'); peer.close(); f.scheduler.stop();
  });
  await test('Bridge rejects expired deadlines and bounds long deadlines without changing ordinary commands', async () => {
    const frames = [], now = 10000;
    const peer = new BridgeClient({ destroyed: false, destroy() {} }, (frame) => { frames.push(frame); return true; }, { now: () => now });
    const session = randomUUID();
    peer.receive({ kind: 'state', seq: 1, online: true, session, host: 'fixture.invalid', port: 25565, username: 'Tester' });
    assert.equal((await peer.command('fixture expired', { expiresAt: now })).ok, false);
    assert.equal((await peer.command('fixture invalid', { expiresAt: NaN })).ok, false);
    assert.equal(frames.length, 0);
    let seq = 1;
    for (const options of [{ expiresAt: now + 999999 }, undefined]) {
      const pending = peer.command('fixture bounded', options);
      const frame = frames.at(-1); assert.equal(frame.expiresAt, now + 5000);
      peer.receive({ kind: 'result', seq: ++seq, session, id: frame.id, ok: true });
      assert.equal((await pending).ok, true);
    }
    peer.close();
  });
  await test('Real main IPC saves and applies midnight policy without connecting or sending immediately', async () => {
    const c = clock(); class FakeDate extends Date { static now() { return c.now(); } }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-midnight-main-'));
    const config = store.normalize({ autoLogin: false, servers: [{ host: 'example.invalid', port: 25565 }], behavior: { greet: '', commands: [] },
      midnightCommand: { enabled: true, command: '/fixture main' } });
    const commands = [];
    const h = mainHarness({ config, dataDir: dir, Date: FakeDate, setTimeout: c.set, clearTimeout: c.clear,
      command: (value) => { commands.push(value); return true; } });
    try {
      assert.equal(h.configure({ ...config, midnightCommand: { enabled: true, command: 'bad' } }).ok, false);
      assert.equal(h.configure(config).ok, true); h.startMidnight(); assert.equal(h.clients.length, 0);
      await h.connect(); h.clients[0].state = 'play';
      await c.advance(100); assert.deepEqual(commands, ['fixture main']);
      assert.ok(h.logs.some((l) => l.level === 'automation' && l.text.includes('\u96f6\u70b9\u547d\u4ee4')));
      h.quit(); assert.equal(c.tasks.size, 0);
    } finally { h.quit(); }
  });
  await test('Next midnight follows local DST dates instead of a fixed 24-hour delay', () => {
    const script = `const assert = require('assert/strict'); const {nextMidnight}=require(${JSON.stringify(path.join(__dirname, 'midnight_command.js'))});
      for (const [month,day,hours] of [[2,8,23],[10,1,25]]) {
        const start=new Date(2026,month,day,0,0,0).getTime();
        assert.equal((nextMidnight(start)-start)/3600000,hours);
        assert.equal(new Date(nextMidnight(start)).getHours(),0);
      }`;
    const result = spawnSync(process.execPath, ['-e', script], { cwd: os.tmpdir(),
      env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  });
  console.log('=== ' + passed + ' midnight tests passed / ' + failed + ' failed ===');
  process.exitCode = failed ? 1 : 0;
}
run().catch((e) => { console.error(e); process.exitCode = 1; });
