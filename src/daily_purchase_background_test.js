'use strict';

// Real main-process routing, protocol decoder and click writer. No server,
// account, operating-system keystrokes or existing application data is used.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mainHarness } = require('./connection_lifecycle_test');
const { MCClient } = require('./client');
const { getCodec } = require('./server_features');
const { ByteWriter, ByteReader, PACKET_ID: P } = require('./proto');

const empty = { itemCount: 0 };
function stack(name, lore = []) {
  return { itemCount: 1, itemId: 1, addedComponentCount: lore.length ? 2 : 1, removedComponentCount: 0,
    components: [{ type: 'custom_name', data: { type: 'string', value: name } },
      ...(lore.length ? [{ type: 'lore', data: lore.map((line) => ({ type: 'string', value: line })) }] : [])], removeComponents: [] };
}
function translatedStack(key) {
  const result = stack('', ['卖价: 39金币 ↑', '玩家出售限量: 0/16']);
  result.components[0].data = { type: 'compound', value: { translate: { type: 'string', value: key } } };
  return result;
}
const product = stack('韭葱（金星）', ['卖价: 14金币 ↑', '玩家出售限量: 0/16']);
const priceSlots = [11, 12, 13, 14, 15, 20, 21, 22, 23, 24, 29, 30, 31, 32, 33];
const encode = (type, data) => getCodec().createPacketBuffer(type, data);
function clock() {
  let now = new Date(2026, 9, 22, 12).getTime(), id = 0;
  const tasks = new Map();
  return { now: () => now, tasks,
    set(fn, delay) { tasks.set(++id, { fn, at: now + delay }); return id; },
    clear(key) { tasks.delete(key); },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...tasks].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        tasks.delete(next[0]); now = next[1].at; await next[1].fn(); await Promise.resolve();
      }
      now = end; await Promise.resolve();
    } };
}
async function fixture() {
  const time = clock(), sent = [];
  class FakeDate extends Date { static now() { return time.now(); } }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-background-purchase-'));
  const h = mainHarness({ dataDir, Date: FakeDate, setTimeout: time.set, clearTimeout: time.clear,
    config: { autoLogin: false, behavior: { greet: '', commands: [] }, automation: { paused: false } } });
  await h.connect();
  const client = h.clients[0], callback = client.opts.onEvent;
  Object.assign(client, new MCClient({ host: 'example.invalid', port: 25565, username: 'Tester', onEvent: callback }));
  client.state = 'play'; client.socket = { destroyed: false, writable: true, destroy() { this.destroyed = true; } };
  client.send = (id, write) => { const w = new ByteWriter(); if (write) write(w); sent.push({ id, data: w.build() }); };
  client.openServerMenu = () => ({ ok: true });
  client.clickMenu = (request) => MCClient.prototype.clickMenu.call(client, request);
  client.closeMenu = (id) => MCClient.prototype.closeMenu.call(client, id);
  client.features.now = time.now; client.features.setTimer = time.set; client.features.clearTimer = time.clear;
  function open(title = '芒果小镇主菜单', id = 119, type = 5) {
    client.features.openMenu(encode('packet_open_window', { windowId: id, inventoryType: type,
      windowTitle: { type: 'string', value: title } }));
  }
  function content(items = { 23: stack('小镇商店') }, stateId = 7) {
    client.features.windowItems(encode('packet_window_items', { windowId: client.features.menu.id, stateId,
      items: Array.from({ length: 90 }, (_, slot) => items[slot] || empty), carriedItem: empty }));
  }
  function slot(index = 0, item = stack('刷新装饰'), stateId = 8) {
    client.features.setSlot(encode('packet_set_slot', { windowId: client.features.menu.id, stateId, slot: index, item }));
  }
  const clicks = () => sent.filter((frame) => frame.id === P.playWindowClick).map((frame) => {
    const r = new ByteReader(frame.data); return { id: r.varint(), stateId: r.varint(), slot: r.i16() };
  });
  const visible = () => h.statuses.filter((status) => status.menu);
  const snapshot = () => h.invoke('purchase:get');
  return { h, client, time, sent, open, content, slot, clicks, visible, snapshot,
    start: () => h.invoke('purchase:retry'), quit: () => h.quit() };
}
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
async function run() {
  await test('Continuous 100ms slot refreshes cannot postpone navigation; latest state is clicked once, no modal', async () => {
    const f = await fixture();
    try {
      await f.start(); f.open(); f.content();
      for (let i = 0; i < 6; i++) { await f.time.advance(100); f.slot(0, stack('装饰 ' + i), 8 + i); }
      assert.equal(f.clicks().length, 0);
      await f.time.advance(100);
      assert.deepEqual(f.clicks(), [{ id: 119, stateId: 13, slot: 23 }]);
      for (let i = 0; i < 12; i++) { f.slot(0, stack('继续刷新 ' + i), 14 + i); await f.time.advance(100); }
      assert.equal(f.clicks().length, 1, 'Do not click the old menu again while waiting for transition');
      assert.equal(f.visible().length, 0);
      assert.equal((await f.h.invoke('client:clickMenu', { id: 119 })).ok, false);
      assert.equal((await f.h.invoke('client:closeMenu', { id: 119 })).ok, false);
    } finally { f.quit(); }
  });
  await test('Both shops finish in background while decor updates continue; daily count persists and manual menus still display', async () => {
    const f = await fixture();
    try {
      await f.start();
      async function page(title, items) {
        f.open(title); f.content(items);
        for (let i = 0; i < 7; i++) { await f.time.advance(100); if (f.client.features.menu) f.slot(0, stack('刷新 ' + i), 10 + i); }
      }
      await page('芒果小镇主菜单', { 23: stack('小镇商店') });
      await page('系统商店', { 29: stack('系统收购') });
      await page('每日随机收购商店', Object.fromEntries(priceSlots.map((slot) => [slot, product])));
      assert.equal((await f.snapshot()).count, 0);
      await f.time.advance(700);
      await page('芒果小镇主菜单', { 23: stack('小镇商店') });
      await page('系统商店', { 33: stack('星露谷收购') });
      await page('星露谷收购商店', { 20: stack('农作物收购') });
      await page('星露谷每日随机收购商店', Object.fromEntries(priceSlots.map((slot) => [slot, product])));
      assert.equal((await f.snapshot()).count, 1);
      assert.deepEqual(f.clicks().map((click) => click.slot), [23, 29, 23, 33, 20]);
      assert.equal(f.visible().length, 0);
      f.open('手动签到菜单'); f.content({ 15: stack('金币签到') });
      assert.ok(f.visible().some((menu) => menu.menu.title === '手动签到菜单'));
    } finally { f.quit(); }
  });
  await test('Incomplete menus report readiness diagnostics and safely close without showing a failure modal', async () => {
    const f = await fixture();
    try {
      await f.start(); f.open(); f.slot(23, stack('小镇商店'));
      await f.time.advance(12000);
      const state = await f.snapshot();
      assert.equal(state.count, 0); assert.equal(state.status, 'error');
      assert.match(state.error, /状态=waiting/); assert.match(state.error, /光标=未确认/);
      assert.match(state.error, /整包=0/); assert.match(state.error, /忽略单格=1/);
      assert.equal(f.visible().length, 0);
      assert.equal(f.client.features.menu, null, 'Known auto-opened menu with no clicks is closed');
      assert.equal(f.sent.filter((frame) => frame.id === P.playCloseWindow).length, 1);
    } finally { f.quit(); }
  });
  await test('Occupied and unknown automatic menus stay hidden after failure, never close or click, new manual menus are unaffected', async () => {
    for (const kind of ['cursor', 'guild']) {
      const f = await fixture();
      try {
        await f.start(); f.open(kind === 'guild' ? '公会功能菜单' : '芒果小镇主菜单');
        if (kind === 'cursor') {
          f.client.features.windowItems(encode('packet_window_items', { windowId: 119, stateId: 7,
            items: Array(90).fill(empty), carriedItem: stack('持有物品') }));
        }
        assert.equal((await f.snapshot()).status, 'error');
        f.content(); f.slot(); await f.time.advance(1000);
        assert.equal(f.visible().length, 0); assert.equal(f.clicks().length, 0);
        assert.equal(f.sent.some((frame) => frame.id === P.playCloseWindow), false);
        f.open('手动菜单'); f.content(); assert.ok(f.visible().length > 0);
      } finally { f.quit(); }
    }
  });
  await test('A refreshed target is revalidated at execution time, not clicked using an old snapshot', async () => {
    const f = await fixture();
    try {
      await f.start(); f.open(); f.content();
      await f.time.advance(600); f.slot(23, stack('公会功能'));
      await f.time.advance(100);
      assert.equal(f.clicks().length, 0); assert.equal((await f.snapshot()).status, 'error');
      assert.equal(f.visible().length, 0);
    } finally { f.quit(); }
  });
  await test('Repeated container id and new token replace an obsolete scheduled snapshot without extra waiting', async () => {
    const f = await fixture();
    try {
      await f.start(); f.open(); f.content();
      await f.time.advance(400);
      f.open(); f.content({ 25: stack('小镇商店'), 23: stack('公会功能') }, 20);
      await f.time.advance(699); assert.equal(f.clicks().length, 0);
      await f.time.advance(1); assert.deepEqual(f.clicks(), [{ id: 119, stateId: 20, slot: 25 }]);
      assert.equal(f.visible().length, 0);
    } finally { f.quit(); }
  });
  await test('Main IPC starts real menu collection again after a saved success; duplicate requests remain single-flight', async () => {
    const f = await fixture();
    try {
      async function page(title, items) { f.open(title); f.content(items); await f.time.advance(700); }
      async function collect() {
        await page('芒果小镇主菜单', { 23: stack('小镇商店') });
        await page('系统商店', { 29: stack('系统收购') });
        await page('每日随机收购商店', Object.fromEntries(priceSlots.map((slot) => [slot, product])));
        await f.time.advance(700);
        await page('芒果小镇主菜单', { 23: stack('小镇商店') });
        await page('系统商店', { 33: stack('星露谷收购') });
        await page('星露谷收购商店', { 20: stack('农作物收购') });
        await page('星露谷每日随机收购商店', Object.fromEntries(priceSlots.map((slot) => [slot, product])));
      }
      for (let manualCount = 1; manualCount <= 3; manualCount++) {
        assert.equal((await f.start()).ok, true); assert.equal((await f.snapshot()).status, 'collecting');
        await f.start(); await collect();
        assert.equal((await f.snapshot()).manualCount, manualCount);
        assert.equal((await f.snapshot()).autoCount, 0);
        assert.equal(f.clicks().length, 5 * manualCount);
      }
      assert.equal(f.visible().length, 0);
    } finally { f.quit(); }
  });
  await test('Reported ready/5/-1/90/54 menu with 12 slot updates advances and collects both shops without a modal', async () => {
    const f = await fixture();
    try {
      await f.start(); f.open(); f.content();
      for (let i = 0; i < 12; i++) f.slot(0, stack('装饰 ' + i), -1);
      const root = f.client.features.menu;
      assert.equal(root.status, 'ready'); assert.equal(root.type, 5); assert.equal(root.stateId, -1);
      assert.equal(root.slots.length, 90); assert.equal(root.expectedSlots, 54);
      assert.equal(root.diagnostics.fullPackets, 1); assert.equal(root.diagnostics.slotPackets, 12);
      assert.equal(root.diagnostics.ignoredSlotPackets, 0); assert.equal(root.diagnostics.lastContentWindowId, 119);
      assert.equal(f.client.features.canClick(), true);
      await f.time.advance(700);
      assert.deepEqual(f.clicks(), [{ id: 119, stateId: -1, slot: 23 }]);
      async function page(title, items) { f.open(title); f.content(items, -1); await f.time.advance(700); }
      await page('系统商店', { 29: stack('系统收购') });
      await page('每日随机收购商店', Object.fromEntries(priceSlots.map((slot) => [slot, product])));
      await f.time.advance(700);
      await page('芒果小镇主菜单', { 23: stack('小镇商店') });
      await page('系统商店', { 33: stack('星露谷收购') });
      await page('星露谷收购商店', { 20: stack('农作物收购') });
      await page('星露谷每日随机收购商店', Object.fromEntries(priceSlots.map((slot) => [slot, product])));
      assert.equal((await f.snapshot()).manualCount, 1); assert.equal((await f.snapshot()).autoCount, 0);
      assert.deepEqual(f.clicks().map((click) => click.stateId), [-1, -1, -1, -1, -1]);
      assert.deepEqual(f.clicks().map((click) => click.slot), [23, 29, 23, 33, 20]);
      assert.equal(f.visible().length, 0);
    } finally { f.quit(); }
  });
  await test('Standalone translated crop packets reach saved snapshots and IPC as Chinese names and star quality', async () => {
    const f = await fixture();
    try {
      await f.start();
      async function page(title, items) { f.open(title); f.content(items, -1); await f.time.advance(700); }
      await page('芒果小镇主菜单', { 23: stack('小镇商店') });
      await page('系统商店', { 29: stack('系统收购') });
      await page('每日随机收购商店', Object.fromEntries(priceSlots.map((slot) => [slot, product])));
      await f.time.advance(700);
      await page('芒果小镇主菜单', { 23: stack('小镇商店') });
      await page('系统商店', { 33: stack('星露谷收购') });
      await page('星露谷收购商店', { 20: stack('农作物收购') });
      const keys = ['item.customcrops.gigantic_pineapple', 'item.customcrops.virelo_silver_star', 'item.customcrops.leek_golden_star'];
      await page('星露谷每日随机收购商店', Object.fromEntries(priceSlots.map((slot, i) => [slot, translatedStack(keys[i % 3])])));
      const state = await f.snapshot();
      assert.equal(state.status, 'complete'); assert.equal(state.manualCount, 1);
      assert.equal(state.shops.crops.items.length, 15);
      for (const [i, name] of ['巨型菠萝', '幽碧兰（银星）', '韭葱（金星）'].entries()) {
        const matches = state.shops.crops.items.filter((item) => item.name === name);
        assert.equal(matches.length, 5); assert.ok(matches.every((item) => item.rawName === keys[i]));
        assert.ok(matches.every((item) => item.quality === ['无星', '银星', '金星'][i]));
        assert.ok(matches.every((item) => item.price === 39 && item.limit === 16));
      }
      assert.deepEqual(f.clicks().map((click) => click.slot), [23, 29, 23, 33, 20]);
      assert.equal(f.visible().length, 0);
    } finally { f.quit(); }
  });
  console.log('=== ' + passed + ' background purchase integration tests passed ===');
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
