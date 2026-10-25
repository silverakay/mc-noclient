'use strict';

const assert = require('assert/strict');
const { ReconnectController, normalizeReconnect, isRetryableReason, maintenanceWait, MAINTENANCE_CHECK_MS } = require('./reconnect');
const store = require('./configstore');
const { mainHarness } = require('./connection_lifecycle_test');
const { MCClient } = require('./client');
const { componentToText } = require('./chat_component');
let passed = 0, failed = 0;

function clock() {
  let now = 0, id = 0;
  const tasks = new Map();
  return {
    now: () => now,
    tasks,
    set: (fn, delay) => { const key = ++id; tasks.set(key, { fn, at: now + delay }); return key; },
    clear: (key) => tasks.delete(key),
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const entry = [...tasks].sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry || entry[1].at > end) break;
        tasks.delete(entry[0]); now = entry[1].at;
        await entry[1].fn();
      }
      now = end;
    },
    fireNext() {
      const entry = [...tasks].sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) return Promise.resolve();
      tasks.delete(entry[0]); now = entry[1].at;
      return Promise.resolve(entry[1].fn());
    },
  };
}
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
function controller(overrides = {}) {
  const c = clock(), calls = [], states = [];
  let settings = { enabled: true, delaySeconds: 5, maxAttempts: 3 };
  const policy = new ReconnectController({
    connect: async (target) => { calls.push(target); return overrides.connect ? overrides.connect(target) : { ok: false, error: 'ECONNRESET' }; },
    getSettings: () => settings, onChange: (state) => states.push(state),
    setTimer: c.set, clearTimer: c.clear, now: c.now,
  });
  const target = { host: 'example.invalid', port: 25565, username: 'Tester', usePremium: false };
  return { c, calls, states, policy, target, configure: (next) => { settings = next; return policy.updatePolicy(); } };
}
async function test(name, fn) {
  try { await fn(); passed++; console.log('  [PASS] ' + name); }
  catch (e) { failed++; console.error('  [FAIL] ' + name + '\n         ' + e.stack); }
}
function integration(overrides = {}) {
  const c = clock();
  class FakeDate extends Date { static now() { return c.now(); } }
  const config = store.normalize({ username: 'Tester', servers: [], autoLogin: false,
    behavior: { showChat: true, greet: '', commands: [] },
    reconnect: { enabled: true, delaySeconds: 5, maxAttempts: 3 } });
  const h = mainHarness({ config, setTimeout: c.set, clearTimeout: c.clear, Date: FakeDate, ...overrides });
  const join = (client) => { client.state = 'play'; client.opts.onEvent('join'); };
  const lost = (client, reason = 'ECONNRESET') => { client.state = 'closed'; client.opts.onEvent('close', { reason, retryable: true }); };
  return { ...h, c, config, join, lost };
}

async function run() {
  await test('Duplicate login in either raw or translated form is never a network retry', () => {
    for (const reason of ['multiplayer.disconnect.duplicate_login', '\u4f60\u5df2\u5728\u5f02\u5730\u767b\u5f55',
      'You logged in from another location', 'Already connected to this server', '\u8d26\u53f7\u5df2\u5728\u7ebf']) {
      assert.equal(isRetryableReason(reason), false, reason);
    }
    assert.equal(isRetryableReason('ECONNRESET'), true);
  });
  await test('Real main IPC: a login from the game client stops recovery instead of evicting it', async () => {
    const h = integration(); await h.connect(); const client = h.clients[0]; h.join(client);
    client.opts.onEvent('kick', '\u4f60\u5df2\u5728\u5f02\u5730\u767b\u5f55');
    await h.c.advance(120000); assert.equal(h.clients.length, 1);
    assert.equal(h.statuses.filter((status) => status.reconnect).at(-1).reconnect.phase, 'idle');
    assert.equal(h.business(), 0);
  });
  await test('Config defaults enable reconnection without startup auto-connect', () => {
    assert.deepEqual(store.defaultConfig().reconnect, { enabled: true, delaySeconds: 5, maxAttempts: 10 });
    assert.equal('lastServer' in store.defaultConfig(), false);
    assert.deepEqual(store.normalize({}).display, { autoScroll: true, showMonitor: true, hidePresence: true, logLimit: 800, chatBlocklist: [] });
  });
  await test('Malformed retry settings have bounded integer defaults', () => {
    assert.deepEqual(normalizeReconnect({ enabled: false, delaySeconds: -1, maxAttempts: 99999 }),
      { enabled: false, delaySeconds: 3, maxAttempts: 1000 });
    assert.equal(normalizeReconnect({ delaySeconds: NaN, maxAttempts: 2.2 }).delaySeconds, 5);
    assert.equal(normalizeReconnect({ delaySeconds: NaN, maxAttempts: 2.2 }).maxAttempts, 10);
  });
  await test('Initial connection failure does not start a retry loop', async () => {
    const h = controller(); h.policy.start(h.target); h.policy.lost('Initial failure');
    await h.c.advance(60000); assert.equal(h.calls.length, 0);
  });
  await test('Unexpected drop schedules one retry after the configured delay', async () => {
    const h = controller(); h.policy.start(h.target); h.policy.joined(); h.policy.lost('ECONNRESET');
    assert.equal(h.policy.phase, 'waiting');
    await h.c.advance(4999); assert.equal(h.calls.length, 0);
    await h.c.advance(1); assert.equal(h.calls.length, 1);
  });
  await test('Repeated close/error signals cannot stack retry timers', () => {
    const h = controller(); h.policy.start(h.target); h.policy.joined();
    for (let i = 0; i < 20; i++) h.policy.lost('ECONNRESET');
    assert.equal(h.c.tasks.size, 1);
  });
  await test('Retries back off and stop at the configured limit', async () => {
    const h = controller(); h.policy.start(h.target); h.policy.joined(); h.policy.lost();
    await h.c.advance(5000); assert.equal(h.states.at(-1).retryAt, 15000);
    await h.c.advance(10000); assert.equal(h.states.at(-1).retryAt, 35000);
    await h.c.advance(20000); assert.equal(h.calls.length, 3);
    assert.equal(h.c.tasks.size, 0); assert.equal(h.policy.target, null);
  });
  await test('Unlimited retries still cap their backoff at 60 seconds', async () => {
    const h = controller(); h.configure({ enabled: true, delaySeconds: 5, maxAttempts: 0 });
    h.policy.start(h.target); h.policy.joined(); h.policy.lost();
    for (let i = 0; i < 8; i++) await h.c.fireNext();
    assert.equal(h.calls.length, 8);
    assert.equal(h.states.at(-1).retryAt - h.c.now(), 60000);
  });
  await test('Manual stop cancels queued recovery permanently', async () => {
    const h = controller(); h.policy.start(h.target); h.policy.joined(); h.policy.lost(); h.policy.stop();
    await h.c.advance(600000); assert.equal(h.calls.length, 0); assert.equal(h.policy.armed, false);
  });
  await test('Stop while an asynchronous retry is running ignores its late failure', async () => {
    const request = deferred(); const h = controller({ connect: () => request.promise });
    h.policy.start(h.target); h.policy.joined(); h.policy.lost();
    const pending = h.c.fireNext(); h.policy.stop(); request.resolve({ ok: false, error: 'ECONNRESET' });
    await pending; assert.equal(h.c.tasks.size, 0); assert.equal(h.calls.length, 1);
  });
  await test('Early disconnect during retry settles into one subsequent timer', async () => {
    const request = deferred(); const h = controller({ connect: () => request.promise });
    h.policy.start(h.target); h.policy.joined(); h.policy.lost();
    const pending = h.c.fireNext(); h.policy.lost('Early TCP close'); request.resolve({ ok: true });
    await pending; assert.equal(h.c.tasks.size, 1); assert.equal(h.policy.phase, 'waiting');
  });
  await test('Successful join resets the retry count and clears pending failure', async () => {
    const h = controller({ connect: async () => { h.policy.joined(); return { ok: true }; } });
    h.policy.start(h.target); h.policy.joined(); h.policy.lost(); await h.c.fireNext();
    assert.equal(h.policy.attempt, 0); assert.equal(h.policy.phase, 'connected'); assert.equal(h.c.tasks.size, 0);
  });
  await test('Disabled policy never retries', async () => {
    const h = controller(); h.configure({ enabled: false }); h.policy.start(h.target); h.policy.joined(); h.policy.lost();
    await h.c.advance(60000); assert.equal(h.calls.length, 0);
  });
  await test('Disabling while waiting cancels; changing delay reschedules once', async () => {
    const h = controller(); h.policy.start(h.target); h.policy.joined(); h.policy.lost();
    h.configure({ enabled: true, delaySeconds: 10, maxAttempts: 3 });
    assert.equal(h.c.tasks.size, 1); assert.equal(h.states.at(-1).retryAt, 10000);
    h.configure({ enabled: false }); await h.c.advance(60000); assert.equal(h.calls.length, 0);
  });
  await test('Recovery target is immutable and contains no credentials', async () => {
    const h = controller(); const target = { ...h.target, accessToken: 'NOT_STORED' };
    h.policy.start(target); h.policy.joined(); target.host = 'another.invalid'; h.policy.lost(); await h.c.fireNext();
    assert.deepEqual(h.calls[0], h.target); assert.equal('accessToken' in h.calls[0], false);
  });
  for (const reason of ['You are banned', 'not.whitelisted', '\u4f60\u5df2\u88ab\u5c01\u7981', '\u51ed\u636e\u5df2\u5931\u6548\uff0c\u9700\u8981\u91cd\u65b0\u6388\u6743', 'multiplayer.disconnect.unverified_username']) {
    await test('Terminal rejection stops recovery: ' + reason, () => {
      assert.equal(isRetryableReason(reason), false);
      const h = controller(); h.policy.start(h.target); h.policy.joined(); h.policy.lost(reason, false);
      assert.equal(h.c.tasks.size, 0); assert.equal(h.policy.target, null);
    });
  }
  await test('Network and server-restart reasons remain retryable', () => {
    for (const reason of ['ECONNRESET', 'fetch failed', 'Server restarting', '\u7f51\u7edc\u63a5\u6536\u8d85\u65f6']) assert.equal(isRetryableReason(reason), true);
  });
  await test('Maintenance duration recognizes the actual quoted notice, colors, compound units and English', () => {
    for (const [text, wait] of [
      ['"\u7ef4\u62a4\u65f6\u95f4 10\u5206\u949f"', 600000],
      ['\u00a7c\u7ef4\u62a4\u65f6\u95f4\uff1a10 \u5206\u949f', 600000],
      ['\u670d\u52a1\u5668\u7ef4\u62a4 1 \u5c0f\u65f6 30 \u5206\u949f', 5400000],
      ['\u6b63\u5728\u68c0\u4fee\uff0c\u8bf7\u7b49\u5f85 30 \u79d2', 30000],
      ['Under maintenance for 10 minutes', 600000],
      ['Maintenance: 1.5 hours', 5400000],
      ['Maintenance 2h 5min 10sec', 7510000],
      ['\u7dad\u8b77\u4e2d 10 \u5206\u9418', 600000],
    ]) assert.equal(maintenanceWait(text), wait, text);
  });
  await test('Only explicit maintenance uses the bounded low-frequency fallback', () => {
    for (const text of ['\u670d\u52a1\u5668\u7ef4\u62a4\u4e2d', 'Maintenance', '\u7ef4\u62a4\u65f6\u95f4 0\u5206\u949f']) {
      assert.equal(maintenanceWait(text), MAINTENANCE_CHECK_MS, text);
    }
    assert.equal(maintenanceWait('Maintenance 999999 hours'), 86400000);
    for (const text of ['', 'ECONNREFUSED', 'Server restarting', 'Retry in 10 minutes', '\u7ef4\u62a4\u5df2\u7ecf\u7ed3\u675f', 'Maintenance is finished']) {
      assert.equal(maintenanceWait(text), null, text);
    }
  });
  await test('Ten-minute maintenance makes zero connections until its deadline', async () => {
    const h = controller(); h.policy.start(h.target); h.policy.joined(); h.policy.lost('\u7ef4\u62a4\u65f6\u95f4 10\u5206\u949f');
    assert.equal(h.policy.phase, 'maintenance'); assert.equal(h.states.at(-1).retryAt, 600000);
    assert.equal(h.policy.attempt, 0); await h.c.advance(599999); assert.equal(h.calls.length, 0);
    await h.c.advance(1); assert.equal(h.calls.length, 1); assert.equal(h.policy.attempt, 0);
    assert.equal(h.states.at(-1).retryAt, 900000); h.policy.stop();
  });
  await test('Manual first login rejected for maintenance waits, while ordinary first failure still stops', async () => {
    const h = controller(); h.policy.start(h.target); h.policy.lost('\u7ef4\u62a4\u65f6\u95f4 10\u5206\u949f');
    assert.equal(h.policy.armed, true); assert.equal(h.policy.phase, 'maintenance');
    await h.c.advance(599999); assert.equal(h.calls.length, 0); h.policy.stop();
  });
  await test('A maintenance notice replaces a short normal retry timer, duplicates do not extend it', async () => {
    const h = controller(); h.policy.start(h.target); h.policy.joined(); h.policy.lost('ECONNRESET');
    await h.c.advance(2000); h.policy.lost('\u7ef4\u62a4 10\u5206\u949f');
    assert.equal(h.states.at(-1).retryAt, 602000); await h.c.advance(3000);
    h.policy.lost('\u7ef4\u62a4 10\u5206\u949f'); h.policy.lost('ECONNRESET');
    assert.equal(h.c.tasks.size, 1); assert.equal(h.states.at(-1).retryAt, 602000);
    assert.equal(h.calls.length, 0); h.policy.stop();
  });
  await test('Maintenance arriving during the last normal attempt does not exhaust the retry limit', async () => {
    const h = controller({ connect: async () => ({ ok: false, error: '\u7ef4\u62a4\u65f6\u95f4 10\u5206\u949f' }) });
    h.configure({ enabled: true, delaySeconds: 5, maxAttempts: 1 });
    h.policy.start(h.target); h.policy.joined(); h.policy.lost(); await h.c.advance(5000);
    assert.equal(h.policy.phase, 'maintenance'); assert.equal(h.policy.attempt, 0);
    assert.equal(h.states.at(-1).retryAt, 605000); assert.equal(h.calls.length, 1); h.policy.stop();
  });
  await test('A delayed in-flight result preserves the maintenance receipt time and cannot overwrite it with a close', async () => {
    const request = deferred(), h = controller({ connect: () => request.promise });
    h.policy.start(h.target); h.policy.joined(); h.policy.lost(); const pending = h.c.fireNext();
    h.policy.lost('\u7ef4\u62a4 10\u5206\u949f'); h.policy.lost('ECONNRESET'); await h.c.advance(10000);
    request.resolve({ ok: false, error: 'ECONNRESET' }); await pending;
    assert.equal(h.policy.phase, 'maintenance'); assert.equal(h.states.at(-1).retryAt, 605000);
    assert.equal(h.c.tasks.size, 1); h.policy.stop();
  });
  await test('A returned maintenance notice takes priority over an earlier generic close event', async () => {
    const request = deferred(), h = controller({ connect: () => request.promise });
    h.policy.start(h.target); h.policy.joined(); h.policy.lost(); const pending = h.c.fireNext(); h.policy.lost('ECONNRESET');
    request.resolve({ ok: false, error: '\u7ef4\u62a4 10\u5206\u949f' }); await pending;
    assert.equal(h.policy.phase, 'maintenance'); assert.equal(h.states.at(-1).retryAt, 605000); h.policy.stop();
  });
  await test('Unknown maintenance and refused recovery checks stay five minutes apart without consuming attempts', async () => {
    const h = controller({ connect: async () => ({ ok: false, error: 'ECONNREFUSED' }) });
    h.configure({ enabled: true, delaySeconds: 5, maxAttempts: 1 });
    h.policy.start(h.target); h.policy.joined(); h.policy.lost('Maintenance');
    for (let i = 0; i < 12; i++) {
      await h.c.advance(MAINTENANCE_CHECK_MS - 1); assert.equal(h.calls.length, i);
      await h.c.advance(1); assert.equal(h.calls.length, i + 1); assert.equal(h.policy.attempt, 0);
    }
    assert.equal(h.policy.phase, 'maintenance'); h.policy.stop();
  });
  await test('A new maintenance duration replaces the fallback on the next recovery check', async () => {
    const h = controller({ connect: async () => ({ ok: false, error: '\u7ef4\u62a4 20\u5206\u949f' }) });
    h.policy.start(h.target); h.policy.joined(); h.policy.lost('Maintenance'); await h.c.advance(MAINTENANCE_CHECK_MS);
    assert.equal(h.states.at(-1).retryAt, MAINTENANCE_CHECK_MS + 1200000); h.policy.stop();
  });
  await test('Settings edits cannot shorten or extend a maintenance deadline; disabling cancels it', async () => {
    const h = controller(); h.policy.start(h.target); h.policy.joined(); h.policy.lost('\u7ef4\u62a4 10\u5206\u949f');
    await h.c.advance(30000); h.configure({ enabled: true, delaySeconds: 3, maxAttempts: 1 });
    assert.equal(h.states.at(-1).retryAt, 600000); assert.equal(h.c.tasks.size, 1);
    h.configure({ enabled: false }); await h.c.advance(900000); assert.equal(h.calls.length, 0);
    assert.equal(h.policy.maintenance, null);
  });
  await test('Disabled recovery and unrelated targets cannot start a maintenance wait', () => {
    const h = controller(); assert.equal(h.policy.lost('Maintenance'), false);
    h.configure({ enabled: false }); h.policy.start(h.target); assert.equal(h.policy.lost('Maintenance'), false);
    assert.equal(h.c.tasks.size, 0);
  });
  await test('Manual stop and target changes invalidate stale maintenance callbacks', async () => {
    const h = controller(); h.policy.start(h.target); h.policy.joined(); h.policy.lost('Maintenance');
    const old = [...h.c.tasks.values()][0].fn; h.policy.stop(); h.policy.start({ ...h.target, host: 'other.invalid' });
    await old(); await h.c.advance(900000); assert.equal(h.calls.length, 0); assert.equal(h.policy.maintenance, null);
  });
  await test('Ban and duplicate-login rejections override maintenance recovery immediately', async () => {
    for (const reason of ['Maintenance: You are banned', '\u7ef4\u62a4\u4e2d\uff0c\u4f60\u5df2\u5728\u5f02\u5730\u767b\u5f55']) {
      const h = controller(); h.policy.start(h.target); h.policy.joined(); h.policy.lost('Maintenance');
      h.policy.lost(reason); await h.c.advance(900000);
      assert.equal(h.policy.target, null); assert.equal(h.calls.length, 0);
    }
  });
  await test('Terminal rejection returned by a maintenance check stops future checks', async () => {
    const h = controller({ connect: async () => ({ ok: false, error: 'You are banned' }) });
    h.policy.start(h.target); h.policy.joined(); h.policy.lost('Maintenance');
    await h.c.advance(900000); assert.equal(h.calls.length, 1); assert.equal(h.policy.target, null);
  });
  await test('Joining ends maintenance mode; a later network drop uses the normal retry budget again', async () => {
    const h = controller({ connect: async () => { h.policy.joined(); return { ok: true }; } });
    h.policy.start(h.target); h.policy.joined(); h.policy.lost('Maintenance'); await h.c.advance(MAINTENANCE_CHECK_MS);
    assert.equal(h.policy.phase, 'connected'); assert.equal(h.policy.maintenance, null);
    h.policy.lost('ECONNRESET'); assert.equal(h.policy.phase, 'waiting');
    assert.equal(h.states.at(-1).retryAt, MAINTENANCE_CHECK_MS + 5000); h.policy.stop();
  });
  await test('Localized permanent rejections remain non-retryable after Chinese translation', () => {
    for (const key of ['outdated_client', 'outdated_server', 'incompatible', 'invalid_public_key_signature', 'expired_public_key']) {
      const text = componentToText({ translate: 'multiplayer.disconnect.' + key, with: ['26.2'] });
      assert.equal(isRetryableReason(text), false, key + ': ' + text);
    }
  });

  await test('Real main IPC: unexpected close reconnects to the same target', async () => {
    const h = integration(); await h.connect(); h.join(h.clients[0]); h.lost(h.clients[0]);
    assert.equal(h.statuses.at(-1).reconnect.phase, 'waiting');
    await h.c.advance(5000); assert.equal(h.clients.length, 2);
    assert.equal(h.clients[1].opts.host, 'example.invalid'); h.disconnect();
  });
  await test('Real main IPC: maintenance does not renew credentials or open connections during its ten-minute wait', async () => {
    let logins = 0;
    const h = integration({ login: async () => { logins++; return { accessToken: 'FAKE', profile: { name: 'Tester', id: '0'.repeat(32) } }; } });
    await h.connect(true); h.join(h.clients[0]); h.lost(h.clients[0], '"\u7ef4\u62a4\u65f6\u95f4 10\u5206\u949f"');
    assert.equal(h.statuses.at(-1).reconnect.phase, 'maintenance');
    await h.c.advance(599999); assert.equal(h.clients.length, 1); assert.equal(logins, 1);
    await h.c.advance(1); assert.equal(h.clients.length, 2); assert.equal(logins, 2);
    h.join(h.clients[1]); assert.equal(h.statuses.at(-1).state, 'play');
    await h.c.advance(1500); assert.equal(h.business(), 0); h.disconnect();
  });
  await test('Real main IPC: initial manual login rejected for maintenance retains the wait', async () => {
    const h = integration({ connect: async (client) => { client.opts.onEvent('kick', '\u7ef4\u62a4\u65f6\u95f4 10\u5206\u949f'); } });
    assert.equal((await h.connect()).ok, false); assert.equal(h.statuses.at(-1).reconnect.phase, 'maintenance');
    await h.c.advance(599999); assert.equal(h.clients.length, 1);
    await h.c.advance(1); assert.equal(h.clients.length, 2);
    assert.equal(h.statuses.at(-1).reconnect.retryAt, 1200000); h.disconnect();
  });
  await test('Real main IPC: refused port after maintenance keeps low-frequency recovery beyond the normal limit', async () => {
    let attempts = 0;
    const h = integration({ connect: async () => { if (++attempts > 1) throw new Error('connect ECONNREFUSED'); } });
    await h.connect(); h.join(h.clients[0]); h.lost(h.clients[0], '\u7ef4\u62a4 10\u5206\u949f');
    await h.c.advance(600000); assert.equal(h.clients.length, 2);
    await h.c.advance(4 * MAINTENANCE_CHECK_MS); assert.equal(h.clients.length, 6);
    assert.equal(h.statuses.at(-1).reconnect.phase, 'maintenance');
    assert.equal(h.statuses.at(-1).reconnect.attempt, 0); assert.equal(h.business(), 0); h.disconnect();
  });
  for (const action of ['disconnect', 'logout', 'quit']) await test('Real main IPC: ' + action + ' cancels maintenance wait', async () => {
    const h = integration(); await h.connect(); h.join(h.clients[0]); h.lost(h.clients[0], 'Maintenance');
    h[action](); await h.c.advance(900000); assert.equal(h.clients.length, 1);
  });
  await test('Real main IPC: bridge mode switch cancels maintenance instead of logging the game out', async () => {
    const h = integration(); await h.connect(); h.join(h.clients[0]); h.lost(h.clients[0], 'Maintenance');
    assert.equal((await h.invoke('client:mode', 'bridge')).ok, true);
    await h.c.advance(900000); assert.equal(h.clients.length, 1); h.quit();
  });
  await test('Real main IPC: disabling reconnect cancels maintenance but saving unrelated settings preserves its deadline', async () => {
    const h = integration(); await h.connect(); h.join(h.clients[0]); h.lost(h.clients[0], '\u7ef4\u62a4 10\u5206\u949f');
    await h.c.advance(30000); h.configure({ ...h.config, display: { showMonitor: false } });
    h.configure({ ...h.config, reconnect: { enabled: true, delaySeconds: 3, maxAttempts: 1 } });
    assert.equal(h.statuses.filter((p) => p.reconnect).at(-1).reconnect.retryAt, 600000);
    h.configure({ ...h.config, reconnect: { enabled: false } }); await h.c.advance(900000);
    assert.equal(h.clients.length, 1); h.quit();
  });
  for (const action of ['disconnect', 'logout', 'quit']) {
    await test('Real main IPC: ' + action + ' cancels queued retries', async () => {
      const h = integration(); await h.connect(); h.join(h.clients[0]); h.lost(h.clients[0]); h[action]();
      await h.c.advance(600000); assert.equal(h.clients.length, 1);
    });
  }
  await test('Real main IPC: disabled setting cancels queued retries immediately', async () => {
    const h = integration(); await h.connect(); h.join(h.clients[0]); h.lost(h.clients[0]);
    h.configure({ ...h.config, reconnect: { enabled: false } });
    await h.c.advance(60000); assert.equal(h.clients.length, 1);
  });
  await test('Real main IPC: display settings never postpone an existing retry', async () => {
    const h = integration(); await h.connect(); h.join(h.clients[0]); h.lost(h.clients[0]);
    await h.c.advance(2000); h.configure({ ...h.config, display: { autoScroll: false, showMonitor: false } });
    await h.c.advance(3000); assert.equal(h.clients.length, 2); h.disconnect();
  });
  await test('Real main IPC: disabling recovery leaves an already joined connection alive', async () => {
    const h = integration(); await h.connect(); h.join(h.clients[0]);
    h.configure({ ...h.config, reconnect: { enabled: false } });
    assert.equal(h.clients[0].state, 'play'); h.lost(h.clients[0]);
    await h.c.advance(60000); assert.equal(h.clients.length, 1);
  });
  await test('Real main IPC: temporary silent renewal failure retries without interactive login', async () => {
    let renewals = 0;
    const h = integration({ login: async (opts) => {
      assert.equal(opts.silentOnly, true);
      if (++renewals === 2) { const error = new Error('fetch failed'); error.temporary = true; throw error; }
      return { accessToken: 'FAKE', profile: { name: 'Tester', id: '0'.repeat(32) } };
    } });
    await h.connect(true); h.join(h.clients[0]); h.lost(h.clients[0]);
    await h.c.advance(5000); assert.equal(h.clients.length, 1);
    assert.equal(h.statuses.at(-1).reconnect.phase, 'waiting');
    await h.c.advance(10000); assert.equal(h.clients.length, 2); assert.equal(renewals, 3); h.disconnect();
  });
  await test('Real main IPC: expired credentials stop automatic renewal and future retries', async () => {
    let renewals = 0;
    const h = integration({ login: async () => {
      if (++renewals > 1) throw new Error('\u51ed\u636e\u5df2\u5931\u6548\uff0c\u9700\u8981\u91cd\u65b0\u6388\u6743');
      return { accessToken: 'FAKE', profile: { name: 'Tester', id: '0'.repeat(32) } };
    } });
    await h.connect(true); h.join(h.clients[0]); h.lost(h.clients[0]);
    await h.c.advance(600000); assert.equal(h.clients.length, 1); assert.equal(renewals, 2);
    assert.equal(h.statuses.at(-1).reconnect.phase, 'idle');
  });
  await test('Real main IPC: cancelling during automatic account renewal cannot create a socket', async () => {
    const request = deferred(); let renewals = 0;
    const h = integration({ login: () => ++renewals === 1
      ? Promise.resolve({ accessToken: 'FAKE', profile: { name: 'Tester', id: '0'.repeat(32) } }) : request.promise });
    await h.connect(true); h.join(h.clients[0]); h.lost(h.clients[0]); await h.c.advance(1500);
    const pending = h.c.fireNext(); h.disconnect();
    request.resolve({ accessToken: 'FAKE', profile: { name: 'Tester', id: '0'.repeat(32) } });
    await pending; await h.c.advance(600000); assert.equal(h.clients.length, 1);
  });
  await test('Real main IPC: disable during retry closes it and ignores late completion', async () => {
    const request = deferred(); let count = 0;
    const h = integration({ connect: () => ++count === 1 ? Promise.resolve() : request.promise });
    await h.connect(); h.join(h.clients[0]); h.lost(h.clients[0]); await h.c.advance(1500);
    const pending = h.c.fireNext();
    h.configure({ ...h.config, reconnect: { enabled: false } }); request.resolve(); await pending;
    assert.equal(h.clients[1].state, 'closed'); await h.c.advance(60000); assert.equal(h.clients.length, 2);
  });
  await test('Real main IPC: automatic join never repeats configured greetings or commands', async () => {
    const h = integration(); h.config.behavior.greet = 'DO_NOT_REPEAT'; h.config.behavior.commands = ['DO_NOT_REPEAT'];
    await h.connect(); h.join(h.clients[0]); h.lost(h.clients[0]); await h.c.advance(5000);
    h.join(h.clients[1]); await h.c.advance(1500); assert.equal(h.business(), 0); h.disconnect();
  });
  await test('Real main IPC: handshake timeout retries only after a prior successful join', async () => {
    const h = integration(); await h.connect(); h.join(h.clients[0]); h.lost(h.clients[0]); await h.c.advance(5000);
    await h.c.advance(45000); assert.equal(h.statuses.at(-1).reconnect.phase, 'waiting'); h.disconnect();
  });
  await test('Real main IPC: server restart retries but ban stops', async () => {
    const h = integration(); await h.connect(); h.join(h.clients[0]); h.clients[0].opts.onEvent('kick', 'Server restarting');
    await h.c.advance(5000); h.join(h.clients[1]); h.clients[1].opts.onEvent('kick', 'You are banned');
    await h.c.advance(600000); assert.equal(h.clients.length, 2); assert.equal(h.statuses.at(-1).reconnect.phase, 'idle');
  });
  await test('Receive silence timeout signals a retryable close, never a chat send', () => {
    const oldSet = global.setInterval, oldClear = global.clearInterval;
    let tick; const events = [];
    global.setInterval = (fn) => { tick = fn; return 1; }; global.clearInterval = () => {};
    const c = new MCClient({ onEvent: (name, data) => events.push({ name, data }) });
    try {
      c.state = 'play'; c.socket = { destroyed: false, destroy() { this.destroyed = true; } };
      c.send = () => { throw new Error('Silence timeout must not send'); };
      c.lastReceivedAt = Date.now() - 91000; c.startKeepAliveLoop(); tick();
      assert.equal(c.state, 'closed'); assert.equal(events[0].name, 'close'); assert.equal(events[0].data.retryable, true);
    } finally { c.close(); global.setInterval = oldSet; global.clearInterval = oldClear; }
  });
  console.log('\nResult: ' + passed + ' passed / ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
}
run().catch((e) => { console.error(e); process.exitCode = 1; });
