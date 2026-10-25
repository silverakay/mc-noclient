'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app/renderer/index.html'), 'utf8');
const CONNECT = '\u8fde\u63a5';
const DISCONNECT = '\u65ad\u5f00';
const CONNECTING = '\u8fde\u63a5\u4e2d...';
const DISCONNECTING = '\u65ad\u5f00\u4e2d...';

function element() {
  const classes = new Set();
  return {
    textContent: '', innerHTML: '', value: '', checked: false, disabled: false,
    style: {}, dataset: {}, children: [], listeners: {},
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      toggle: (name, on) => on ? classes.add(name) : classes.delete(name),
      contains: (name) => classes.has(name),
    },
    addEventListener(event, handler) { this.listeners[event] = handler; },
    appendChild(child) { this.children.push(child); },
    replaceChildren(...children) { this.children = children; },
    setAttribute() {},
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); },
    remove() {},
    get childElementCount() { return this.children.length; },
    get firstChild() { return this.children[0]; },
  };
}

// Execute the complete renderer with an IPC/DOM stub; no network is available.
async function harness(overrides = {}) {
  const nodes = new Map([...html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)]
    .map((m) => {
      const node = element();
      node.disabled = /\sdisabled(?:\s|=|>)/.test(m[0]);
      node.checked = /\schecked(?:\s|=|>)/.test(m[0]);
      return [m[1], node];
    }));
  const callbacks = {};
  const calls = { connect: 0, disconnect: 0, say: 0 };
  const api = {
    getConfig: async () => ({ servers: [], username: 'Tester', autoLogin: false }),
    peekAccount: async () => ({ name: 'Tester', uuid: '0'.repeat(32) }),
    getMetrics: async () => null,
    onStatus: (fn) => { callbacks.status = fn; },
    onLog: (fn) => { callbacks.log = fn; },
    onChat: (fn) => { callbacks.chat = fn; },
    onMetrics: (fn) => { callbacks.metrics = fn; },
    connect: async (...args) => {
      calls.connect++;
      return overrides.connect ? overrides.connect(...args) : { ok: true };
    },
    disconnect: async () => {
      calls.disconnect++;
      return overrides.disconnect ? overrides.disconnect() : { ok: true };
    },
    say: () => { calls.say++; throw new Error('Tests must not send messages'); },
    chatAction: overrides.chatAction || (() => { throw new Error('Unexpected action'); }),
    pingServer: () => { throw new Error('Tests must not query servers'); },
  };
  const context = vm.createContext({
    window: { api, addEventListener() {} },
    document: {
      getElementById: (id) => nodes.get(id) || null,
      createElement: element,
      addEventListener() {},
    },
    setTimeout: () => 1,
    clearTimeout() {},
    ...(overrides.requestAnimationFrame ? { requestAnimationFrame: overrides.requestAnimationFrame,
      cancelAnimationFrame: overrides.cancelAnimationFrame } : {}),
    console,
  });
  vm.runInContext(source, context, { filename: 'renderer.js' });
  await new Promise(setImmediate);
  assert.equal(typeof callbacks.status, 'function', 'Renderer startup completed');
  vm.runInContext("cfg.servers = [{ host: 'example.invalid', port: 25565 }]; selected = 0; updateConnPanel();", context);
  return {
    calls,
    node: (id) => nodes.get(id),
    status: (p) => callbacks.status(p),
    eval: (code) => vm.runInContext(code, context),
    click: (id = 'btn-connect', force = false) => {
      const node = nodes.get(id);
      if (node.disabled && !force) return Promise.resolve();
      return Promise.resolve(node.listeners.click({ target: node }));
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log('  [PASS] ' + name);
  } catch (e) {
    fail++;
    console.error('  [FAIL] ' + name + '\n         ' + e.message);
  }
}

async function run() {
  console.log('\n=== Connection button behavioral regressions (offline) ===\n');

  await test('Automatic bridge detection changes the existing panel and is cancellable without login', async () => {
    const h = await harness();
    h.status({ connectionMode: 'bridge', connected: false, state: 'bridge-wait',
      bridge: { listening: true, paired: false, online: false, detecting: true } });
    assert.equal(h.node('mode-bridge').checked, true);
    assert.equal(h.node('btn-connect').textContent, '\u505c\u6b62\u68c0\u6d4b');
    assert.match(h.node('conn-meta').textContent, /30 \u79d2/);
    assert.equal(h.node('inp-send').disabled, true);
    await h.click(); assert.equal(h.calls.disconnect, 1); assert.equal(h.calls.connect, 0);
    h.status({ state: 'idle', connected: false, bridge: { listening: false, paired: false, online: false } });
    assert.equal(h.node('btn-connect').textContent, '\u542f\u52a8\u6865\u63a5');
  });
  await test('Late independent connect failure cannot overwrite an already online bridge session', async () => {
    const request = deferred(); const h = await harness({ connect: () => request.promise });
    const connecting = h.click();
    h.status({ connectionMode: 'bridge', event: 'join', connected: true, state: 'play', chatSession: 'fixture',
      target: { host: 'example.invalid', port: 25565 }, bridge: { listening: true, paired: true, online: true } });
    request.resolve({ ok: false, error: 'duplicate_login' }); await connecting;
    assert.equal(h.node('btn-connect').textContent, '\u65ad\u5f00\u6865\u63a5');
    assert.equal(h.node('inp-send').disabled, false); assert.equal(h.calls.connect, 1);
    await h.click(); assert.equal(h.calls.disconnect, 1); assert.equal(h.calls.connect, 1);
  });

  await test('Maintenance wait retains the target, disables sending and can be stopped without a new login', async () => {
    const h = await harness();
    h.status({ reconnect: { phase: 'maintenance', maintenance: true, attempt: 0, maxAttempts: 10,
      retryAt: Date.now() + 600000, target: { host: 'example.invalid', port: 25565 } } });
    assert.equal(h.node('btn-connect').textContent, '\u505c\u6b62\u91cd\u8fde');
    assert.equal(h.node('st-state').textContent, '\u7b49\u5f85\u7ef4\u62a4');
    assert.match(h.node('conn-meta').textContent, /\u7ef4\u62a4\u7b49\u5f85/);
    assert.equal(h.node('inp-send').disabled, true);
    h.eval("cfg.servers = []; selected = -1; updateConnPanel();");
    assert.equal(h.node('btn-connect').disabled, false);
    assert.equal(h.node('conn-host').textContent, 'example.invalid');
    await h.click(); assert.equal(h.calls.disconnect, 1); assert.equal(h.calls.connect, 0); assert.equal(h.calls.say, 0);
  });
  await test('Maintenance recovery probe is cancellable and never presents a fictitious normal attempt number', async () => {
    const h = await harness(); h.status({ reconnect: { phase: 'connecting', maintenance: true, attempt: 0,
      maxAttempts: 10, target: { host: 'example.invalid', port: 25565 } } });
    assert.equal(h.node('btn-connect').textContent, '\u53d6\u6d88\u91cd\u8fde');
    assert.equal(h.node('st-state').textContent, '\u68c0\u67e5\u6062\u590d');
    assert.doesNotMatch(h.node('conn-meta').textContent, /\u7b2c 0 \u6b21/);
    await h.click(); assert.equal(h.calls.disconnect, 1); assert.equal(h.calls.connect, 0);
  });

  await test('TCP success before join: Disconnect closes, never reconnects', async () => {
    const h = await harness();
    await h.click();
    assert.equal(h.node('btn-connect').textContent, DISCONNECT);
    await h.click();
    assert.equal(h.calls.connect, 1);
    assert.equal(h.calls.disconnect, 1);
    assert.equal(h.node('btn-connect').textContent, CONNECT);
    assert.equal(h.node('inp-send').disabled, true);
  });

  for (const state of ['login', 'config', 'play']) {
    await test('Disconnect works in ' + state + ' state', async () => {
      const h = await harness();
      await h.click();
      h.status({ state });
      assert.equal(h.node('btn-connect').textContent, DISCONNECT);
      assert.equal(h.node('btn-send').disabled, state !== 'play');
      await h.click();
      assert.equal(h.calls.connect, 1);
      assert.equal(h.calls.disconnect, 1);
      assert.equal(h.node('btn-connect').textContent, CONNECT);
    });
  }

  await test('Sending remains disabled until join and after reconfiguration', async () => {
    const h = await harness();
    await h.click();
    assert.equal(h.node('inp-send').disabled, true);
    h.status({ event: 'join' });
    assert.equal(h.node('inp-send').disabled, false);
    h.status({ event: 'reconfig' });
    assert.equal(h.node('inp-send').disabled, true);
    assert.equal(h.calls.say, 0);
  });

  for (const patch of [{ event: 'kick' }, { event: 'close' },
    { event: 'need-auth' }, { connected: false, state: 'idle' },
    { state: 'closed' }, { account: null, connected: false, state: 'idle' }]) {
    await test('Terminal status resets the button: ' + JSON.stringify(patch), async () => {
      const h = await harness();
      await h.click();
      h.status(patch);
      assert.equal(h.node('btn-connect').textContent, CONNECT);
      assert.equal(h.node('btn-send').disabled, true);
      await h.click();
      assert.equal(h.calls.connect, patch.account === null ? 1 : 2);
      assert.equal(h.calls.disconnect, 0);
    });
  }

  await test('A late TCP result cannot revive an already closed connection', async () => {
    const request = deferred();
    const h = await harness({ connect: () => request.promise });
    const pending = h.click();
    h.status({ event: 'kick' });
    request.resolve({ ok: true });
    await pending;
    assert.equal(h.node('btn-connect').textContent, CONNECT);
    assert.equal(h.node('btn-send').disabled, true);
  });

  await test('Selecting a server during pending connect cannot enable double clicks', async () => {
    const request = deferred();
    const h = await harness({ connect: () => request.promise });
    const pending = h.click();
    h.eval('updateConnPanel()');
    assert.equal(h.node('btn-connect').disabled, true);
    assert.equal(h.node('btn-connect').textContent, CONNECTING);
    await h.click('btn-connect', true);
    assert.equal(h.calls.connect, 1);
    request.resolve({ ok: true });
    await pending;
    assert.equal(h.node('btn-connect').textContent, DISCONNECT);
  });

  await test('Removing the selected server does not prevent disconnecting', async () => {
    const h = await harness();
    await h.click();
    h.eval('cfg.servers = []; selected = -1; updateConnPanel()');
    assert.equal(h.node('btn-connect').disabled, false);
    assert.equal(h.node('btn-connect').textContent, DISCONNECT);
    await h.click();
    assert.equal(h.calls.disconnect, 1);
    assert.equal(h.node('btn-connect').disabled, true);
  });

  await test('Pending disconnect blocks duplicates and sends, then resets', async () => {
    const request = deferred();
    const h = await harness({ disconnect: () => request.promise });
    await h.click();
    h.status({ event: 'join' });
    const pending = h.click();
    assert.equal(h.node('btn-connect').disabled, true);
    assert.equal(h.node('btn-connect').textContent, DISCONNECTING);
    assert.equal(h.node('btn-send').disabled, true);
    await h.click('btn-connect', true);
    assert.equal(h.calls.disconnect, 1);
    request.resolve({ ok: true });
    await pending;
    assert.equal(h.node('btn-connect').textContent, CONNECT);
    assert.equal(h.node('btn-connect').disabled, false);
  });

  for (const kind of ['reply', 'exception']) {
    await test('Disconnect ' + kind + ' failure preserves the Disconnect action', async () => {
      const h = await harness({ disconnect: () => {
        if (kind === 'exception') throw new Error('IPC unavailable');
        return { ok: false, error: 'IPC unavailable' };
      } });
      await h.click();
      h.status({ event: 'join' });
      await h.click();
      assert.equal(h.node('btn-connect').textContent, DISCONNECT);
      assert.equal(h.node('btn-connect').disabled, false);
      assert.equal(h.node('btn-send').disabled, false);
      assert.equal(h.calls.connect, 1);
      assert.match(h.node('toast').textContent, /IPC unavailable/);
    });
  }

  await test('Connection failure restores Connect and keeps sending disabled', async () => {
    const h = await harness({ connect: () => ({ ok: false, error: 'refused' }) });
    await h.click();
    assert.equal(h.node('btn-connect').textContent, CONNECT);
    assert.equal(h.node('btn-connect').disabled, false);
    assert.equal(h.node('btn-send').disabled, true);
  });

  console.log('\n=== Result: ' + pass + ' passed / ' + fail + ' failed ===\n');
  process.exitCode = fail ? 1 : 0;
}

if (require.main === module) run().catch((e) => { console.error(e); process.exitCode = 1; });
module.exports = { harness };
