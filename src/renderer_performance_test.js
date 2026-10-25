'use strict';

const assert = require('assert/strict');
const { harness } = require('./connection_ui_test');

async function fixture(overrides = {}) {
  const frames = new Map(); let id = 0, writes = 0;
  let scrolling = false;
  const positions = {};
  const h = await harness({ ...overrides,
    requestAnimationFrame: (fn) => { frames.set(++id, fn); return id; },
    cancelAnimationFrame: (key) => frames.delete(key),
  });
  const drain = () => {
    let count = 0;
    while (frames.size) {
      assert.ok(++count <= 8, 'Scrolling must settle, never loop indefinitely');
      const [key, fn] = frames.entries().next().value; frames.delete(key); fn();
    }
  };
  drain();
  for (const name of ['chat', 'log']) {
    const view = h.node(name + '-view');
    positions[name] = 0;
    view.clientHeight = 100;
    Object.defineProperty(view, 'scrollHeight', { get() {
      if (!scrolling) throw new Error('Synchronous layout read');
      return 1000;
    } });
    Object.defineProperty(view, 'scrollTop', { get: () => positions[name], set(value) { positions[name] = value; writes++; } });
  }
  const scroll = (name, distanceFromBottom) => {
    positions[name] = 900 - distanceFromBottom;
    scrolling = true;
    try { h.node(name + '-view').listeners.scroll(); } finally { scrolling = false; }
  };
  return { ...h, frames, drain, scroll, writes: () => writes };
}

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('PASS ' + name); }
  catch (e) { failed++; console.error('FAIL ' + name + '\n' + e.stack); }
}
async function run() {
  await test('Forty visible messages queue one frame and no immediate layout reads or scroll writes', async () => {
    const h = await fixture();
    h.eval("for (let i = 0; i < 40; i++) addChat({ text: 'fixture', type: 'system' });");
    assert.equal(h.frames.size, 1); assert.equal(h.writes(), 0);
    h.drain(); assert.equal(h.writes(), 3); assert.equal(h.frames.size, 0);
  });
  await test('Hidden logs do not scroll; entering the dirty view schedules one bounded update', async () => {
    const h = await fixture(); h.eval("for (let i = 0; i < 40; i++) addLog('net', 'fixture');");
    assert.equal(h.frames.size, 0); assert.equal(h.writes(), 0);
    await h.click('tab-log'); assert.equal(h.frames.size, 1); h.drain(); assert.equal(h.writes(), 3);
  });
  await test('Repeated clean view switches do not force bottom scrolling', async () => {
    const h = await fixture(); await h.click('tab-log'); h.drain();
    const before = h.writes();
    for (let i = 0; i < 10; i++) { await h.click('tab-presence'); await h.click('tab-chat'); await h.click('tab-log'); }
    assert.equal(h.frames.size, 0); assert.equal(h.writes(), before);
  });
  await test('Switching away invalidates even an already delivered scroll callback', async () => {
    const h = await fixture(); h.eval("addChat({ text: 'fixture' });");
    const stale = [...h.frames.values()][0]; await h.click('tab-presence'); stale();
    assert.equal(h.writes(), 0); assert.equal(h.frames.size, 0);
  });
  await test('Disabling autoscroll cancels pending work and applies to view switches', async () => {
    const h = await fixture(); h.eval("addChat({ text: 'fixture' });");
    const stale = [...h.frames.values()][0]; h.eval('cfg.display = { autoScroll: false }; applyDisplaySettings();');
    stale(); await h.click('tab-log'); h.eval("addLog('net', 'fixture');"); await h.click('tab-chat');
    assert.equal(h.frames.size, 0); assert.equal(h.writes(), 0);
  });
  await test('User scrolling cancels delayed tail correction instead of dragging history back down', async () => {
    const h = await fixture(); h.eval("addChat({ text: 'fixture' });");
    const stale = [...h.frames.values()][0]; h.node('chat-view').listeners.wheel(); stale();
    assert.equal(h.frames.size, 0); assert.equal(h.writes(), 0);
  });
  await test('New chat messages never restart following after the user scrolls up', async () => {
    const h = await fixture(); h.node('chat-view').listeners.wheel(); h.scroll('chat', 300);
    h.eval("for (let i = 0; i < 40; i++) addChat({ text: 'reading-history' });");
    h.drain(); assert.equal(h.frames.size, 0); assert.equal(h.writes(), 0);
    assert.equal(h.eval('viewScrolls.chat.pinned'), false);
  });
  await test('Hidden arrivals and tab switching preserve a paused log reading position independently of chat', async () => {
    const h = await fixture(); await h.click('tab-log'); h.node('log-view').listeners.pointerdown(); h.scroll('log', 300);
    await h.click('tab-chat'); h.eval("addLog('net', 'hidden-arrival'); addChat({ text: 'follow-chat' });");
    h.drain(); assert.equal(h.writes(), 3);
    await h.click('tab-log'); h.eval("addLog('net', 'visible-arrival');"); h.drain();
    assert.equal(h.writes(), 3); assert.equal(h.eval('viewScrolls.log.pinned'), false);
  });
  await test('Manually returning to the bottom resumes following subsequent messages', async () => {
    const h = await fixture(); h.node('chat-view').listeners.wheel(); h.scroll('chat', 300);
    h.eval("addChat({ text: 'paused' });"); assert.equal(h.frames.size, 0);
    h.scroll('chat', 0); assert.equal(h.eval('viewScrolls.chat.pinned'), true);
    h.eval("addChat({ text: 'follow-again' });"); h.drain(); assert.equal(h.writes(), 3);
  });
  await test('Saving unrelated display settings and resizing never resume paused following', async () => {
    const h = await fixture(); h.node('chat-view').listeners.touchstart(); h.scroll('chat', 300);
    h.eval("addChat({ text: 'paused' }); applyDisplaySettings(); resizeMessageViews();"); h.drain();
    assert.equal(h.writes(), 0); assert.equal(h.eval('viewScrolls.chat.pinned'), false);
  });
  await test('Clearing paused chat and logs resets following for the empty view, but respects disabled autoscroll', async () => {
    const h = await fixture(); h.node('chat-view').listeners.wheel(); h.scroll('chat', 300);
    await h.click('btn-clear'); h.eval("addChat({ text: 'after-clear' });"); h.drain(); assert.equal(h.writes(), 3);
    await h.click('tab-log'); h.node('log-view').listeners.wheel(); h.scroll('log', 300);
    await h.click('btn-clear'); h.eval("addLog('net', 'after-clear');"); h.drain(); assert.equal(h.writes(), 6);
    h.eval('cfg.display = { autoScroll: false }; applyDisplaySettings();');
    await h.click('btn-clear'); h.eval("addLog('net', 'disabled-after-clear');"); h.drain(); assert.equal(h.writes(), 6);
  });
  await test('Returning to hidden paused history restores the same row after older rows are evicted', async () => {
    const h = await fixture(), view = h.node('chat-view');
    view.getBoundingClientRect = () => ({ top: 100, left: 0, width: 200, height: 300 });
    const line = { parentElement: view, start: 800, closest() { return this; },
      getBoundingClientRect() { return { top: 100 + this.start - view.scrollTop }; } };
    view.readingLine = line;
    h.eval("document.elementFromPoint = () => $('chat-view').readingLine;");
    view.listeners.wheel(); h.scroll('chat', 300); const oldTop = line.getBoundingClientRect().top;
    await h.click('tab-log'); line.start = 400; h.eval("addChat({ text: 'hidden-arrival' });");
    await h.click('tab-chat'); h.drain();
    assert.equal(line.getBoundingClientRect().top, oldTop); assert.equal(view.scrollTop, 200);
    assert.equal(h.eval('viewScrolls.chat.pinned'), false);
  });
  await test('User interaction cancels even a delivered reading-anchor correction callback', async () => {
    const h = await fixture(), view = h.node('chat-view');
    view.getBoundingClientRect = () => ({ top: 100, left: 0, width: 200, height: 300 });
    view.readingLine = { parentElement: view, closest() { return this; }, getBoundingClientRect: () => ({ top: 120 }) };
    h.eval("document.elementFromPoint = () => $('chat-view').readingLine;");
    view.listeners.wheel(); h.scroll('chat', 300); await h.click('tab-log'); await h.click('tab-chat');
    const stale = [...h.frames.values()][0]; view.listeners.wheel(); stale(); h.drain();
    assert.equal(h.writes(), 0); assert.equal(h.eval('viewScrolls.chat.anchor'), null);
  });
  await test('Clearing a view invalidates pending frames and does not restore removed rows', async () => {
    const h = await fixture(); h.eval("addChat({ text: 'fixture' });");
    const stale = [...h.frames.values()][0]; await h.click('btn-clear'); stale();
    assert.equal(h.frames.size, 0); assert.equal(h.writes(), 0);
  });
  await test('Resizing follows a pinned tail, including a hidden view, but preserves user history reading', async () => {
    const h = await fixture(); h.eval('resizeMessageViews();');
    assert.equal(h.frames.size, 1); h.drain(); assert.equal(h.writes(), 3);
    await h.click('tab-log'); assert.equal(h.frames.size, 1); h.drain();
    h.node('log-view').listeners.wheel(); h.eval('resizeMessageViews();');
    assert.equal(h.frames.size, 0);
    await h.click('tab-chat'); h.drain(); h.node('chat-view').listeners.wheel();
    h.eval('resizeMessageViews();'); assert.equal(h.frames.size, 0);
    await h.click('tab-log'); assert.equal(h.frames.size, 0);
  });
  await test('Resizing never overrides disabled autoscroll', async () => {
    const h = await fixture(); h.eval('cfg.display = { autoScroll: false }; resizeMessageViews();');
    await h.click('tab-log'); assert.equal(h.frames.size, 0); assert.equal(h.writes(), 0);
  });
  await test('One hundred unchanged online status updates do not rescan historical action buttons', async () => {
    const h = await fixture(); let scans = 0;
    h.node('chat-view').querySelectorAll = () => { scans++; return []; };
    h.status({ connected: true, state: 'play', chatSession: 'fixture' }); scans = 0;
    for (let i = 0; i < 100; i++) h.status({ state: 'play', chats: i });
    assert.equal(scans, 0);
    h.status({ connected: false, state: 'idle' }); assert.equal(scans, 1);
  });
  await test('Manual pending, consumed and automatic-used buttons update immediately despite the status cache', async () => {
    let release; const h = await fixture({ chatAction: () => new Promise((resolve) => { release = resolve; }) });
    h.status({ connected: true, state: 'play', chatSession: 'fixture' });
    const button = { disabled: false, dataset: { session: 'fixture', actionKind: 'run_command', actionValue: '/fixture' } };
    h.node('chat-view').querySelectorAll = () => [button];
    h.node('chat-view').button = button;
    const action = h.eval("activateChatAction($('chat-view').button, { id: 'fixture' }, 'fixture')");
    assert.equal(button.disabled, true); assert.equal(button.dataset.pending, 'true');
    release({ ok: true, action: 'run_command', value: '/fixture' }); await action;
    assert.equal(button.disabled, true); assert.equal(button.dataset.used, 'true');
    button.dataset.used = 'false'; button.disabled = false;
    h.status({ automationAction: { session: 'fixture', value: '/fixture', used: true } });
    assert.equal(button.disabled, true);
  });
  await test('A new session invalidates old buttons once and never enables them on repeated ticks', async () => {
    const h = await fixture(); const button = { disabled: false, dataset: { session: 'old' } }; let scans = 0;
    h.node('chat-view').querySelectorAll = () => { scans++; return [button]; };
    h.status({ connected: true, state: 'play', chatSession: 'new' }); assert.equal(button.disabled, true);
    const before = scans; for (let i = 0; i < 100; i++) h.status({ state: 'play' });
    assert.equal(scans, before); assert.equal(button.disabled, true);
  });
  console.log('=== Result: ' + passed + ' passed / ' + failed + ' failed ===');
  process.exitCode = failed ? 1 : 0;
}
run().catch((e) => { console.error(e); process.exitCode = 1; });
