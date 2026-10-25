'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { DailyPurchase, parseShop, navigationAllowed } = require('./daily_purchase');
const { MCClient } = require('./client');
const { ByteWriter, ByteReader, PACKET_ID: P } = require('./proto');
const { BridgeClient } = require('./client_bridge');

const item = (name = '韭葱（金星）', price = '14', sold = 0, limit = 16) => ({ name,
  identifier: 'minecraft:paper', count: 1, lore: ['§6卖价: ' + price + '金币 ↑', '玩家出售限量: ' + sold + '/' + limit] });
function menu(name, slots = {}) {
  return { id: 119, token: randomUUID(), revision: 1, title: '《' + name + '》',
    expectedSlots: 54, slots: Array.from({ length: 54 }, (_, i) => slots[i] || null),
    status: 'ready', interactive: true, cursor: null };
}
function priceMenu(name, value = item()) {
  return menu(name, Object.fromEntries([11, 12, 13, 14, 15, 20, 21, 22, 23, 24, 29, 30, 31, 32, 33]
    .map((slot) => [slot, value])));
}
function fixture(directory, bridge = false) {
  let time = new Date(2026, 9, 22, 12).getTime(), seq = 0, active = true;
  const tasks = new Map(), calls = [], snapshots = [], records = [];
  const client = bridge ? new BridgeClient({ destroyed: false, destroy() {} }, () => true,
    { purchaseMenusEnabled: true }) : {};
  Object.assign(client, { state: 'play', host: 'example.invalid', port: 25565, username: 'Tester', features: { menu: null },
    openServerMenu: () => { calls.push('open'); return { ok: true }; },
    clickMenu: (request) => { calls.push(request.slot); return { ok: true }; },
    closeMenu: () => { calls.push('close'); client.features.menu = null; return true; } });
  const collector = new DailyPurchase({ directory: directory || fs.mkdtempSync(path.join(os.tmpdir(), 'mc-purchase-')),
    getClient: () => active ? client : null, now: () => time,
    setTimer: (fn, delay) => { tasks.set(++seq, { fn, at: time + delay }); return seq; }, clearTimer: (id) => tasks.delete(id),
    onChange: (snapshot) => snapshots.push(snapshot), onRecord: (record) => records.push(record) });
  async function advance(ms) {
    const end = time + ms;
    for (;;) {
      const next = [...tasks].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      tasks.delete(next[0]); time = next[1].at; await next[1].fn(); await Promise.resolve();
    }
    time = end; await Promise.resolve();
  }
  async function emit(value) { client.features.menu = value; collector.onMenu(value); await advance(700); }
  async function finish(price = '14') {
    const previousCount = collector.snapshot().count;
    await emit(menu('芒果小镇主菜单', { 23: item('小镇商店') }));
    await emit(menu('系统商店', { 29: item('系统收购') }));
    await emit(priceMenu('每日随机收购商店', item('黑曜石', '25', 30, 30)));
    assert.equal(collector.snapshot().count, previousCount, 'Only one shop must not replace a previous full result');
    await advance(700);
    await emit(menu('芒果小镇主菜单', { 23: item('小镇商店') }));
    await emit(menu('系统商店', { 33: item('星露谷收购') }));
    await emit(menu('星露谷收购商店', { 20: item('农作物收购'), 24: item('钓鱼收购') }));
    await emit(priceMenu('星露谷每日随机收购商店', item('韭葱（金星）', price)));
  }
  collector.connected(client);
  return { collector, client, calls, tasks, snapshots, records, advance, emit, finish,
    offline: () => { active = false; collector.disconnected(); },
    nextDay: () => { time += 86400000; } };
}
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
async function run() {
  await test('Lore parser keeps quality, decimal currency, sold-out quotas, trends and excludes inventory', () => {
    const source = menu('每日随机收购商店', { 11: item('黑曜石', '1,025.5', 30, 30) });
    source.slots.push(item('Inventory', '999999'));
    const shop = parseShop(source);
    assert.equal(shop.items.length, 1); assert.equal(shop.items[0].price, 1025.5);
    assert.equal(shop.items[0].unit, '金币'); assert.equal(shop.items[0].remaining, 0);
    assert.equal(shop.items[0].trend, 'up');
    assert.equal(parseShop(menu('星露谷每日随机收购商店', { 11: item() })).items[0].quality, '金星');
    assert.equal(parseShop(menu('鱼店收购-请放入特殊鱼')), null);
    assert.throws(() => parseShop(menu('每日随机收购商店', { 11: { ...item(), lore: ['卖价: 2金币'] } })), /限量/);
  });
  await test('New online day collects exactly two read-only shops and persists only on full completion', async () => {
    const f = fixture(); f.collector.tick(); assert.deepEqual(f.calls, []);
    await f.advance(15000); f.collector.tick(); f.collector.tick(); assert.deepEqual(f.calls, ['open']);
    await f.finish(); assert.equal(f.collector.snapshot().count, 1);
    assert.deepEqual(f.calls, ['open', 23, 29, 'close', 'open', 23, 33, 20, 'close']);
    assert.equal(f.tasks.size, 0); f.collector.tick(); assert.equal(f.calls.length, 9);
    const g = fixture(f.collector.directory); await g.advance(15000); g.collector.tick();
    assert.equal(g.collector.snapshot().count, 1); assert.deepEqual(g.calls, []);
    g.nextDay(); g.collector.tick(); assert.equal(g.collector.snapshot().count, 0); assert.deepEqual(g.calls, ['open']); g.offline();
  });
  await test('Bridge never automatically opens menus after joining, sign-in, reconnecting or a new day', async () => {
    const f = fixture(undefined, true);
    await f.advance(60000); f.collector.tick(); f.collector.tick();
    assert.deepEqual(f.calls, []); assert.equal(f.collector.snapshot().status, 'pending');
    f.collector.afterSignIn(); await f.advance(2500); f.collector.tick();
    assert.deepEqual(f.calls, []);
    f.collector.disconnected(); f.collector.connected(f.client);
    await f.advance(60000); f.collector.tick(); assert.deepEqual(f.calls, []);
    f.nextDay(); f.collector.tick(); assert.deepEqual(f.calls, []);
    assert.equal(f.collector.snapshot().autoCount, 0); assert.equal(f.tasks.size, 0); f.offline();
  });
  await test('Bridge manual acquisition remains repeatable without scheduling an automatic follow-up', async () => {
    const f = fixture(undefined, true);
    for (let i = 1; i <= 2; i++) {
      assert.equal(f.collector.retry().ok, true); await f.finish(String(14 + i));
      assert.equal(f.collector.snapshot().manualCount, i); assert.equal(f.collector.snapshot().autoCount, 0);
      const calls = [...f.calls]; await f.advance(60000); f.collector.tick(); assert.deepEqual(f.calls, calls);
    }
    const restarted = fixture(f.collector.directory, true);
    await restarted.advance(60000); restarted.collector.tick(); assert.deepEqual(restarted.calls, []);
    assert.equal(restarted.collector.snapshot().manualCount, 2);
    restarted.nextDay(); restarted.collector.tick(); assert.deepEqual(restarted.calls, []);
    assert.equal(restarted.collector.snapshot().manualCount, 0);
    assert.equal(restarted.collector.retry().ok, true); await restarted.finish('99');
    assert.equal(restarted.collector.snapshot().shops.crops.items[0].price, 99);
    assert.equal(restarted.collector.snapshot().manualCount, 1); restarted.offline(); f.offline();
  });
  await test('Crop keys and namespaced IDs resolve without guessing unknown names or changing prices', () => {
    const source = menu('星露谷每日随机收购商店', {
      11: item('§6item.customcrops.gigantic_pineapple', '113', 1, 1),
      12: item('item.customcrops.virelo_silver_star', '39'),
      13: item('customcrops:cabbage_golden_star', '23'),
      14: item('item.customcrops.unknown_crop', '5'),
      15: item('服务器自定义名称', '1'),
    });
    const original = structuredClone(source), result = parseShop(source).items;
    assert.deepEqual(source, original, 'Menu input must not be mutated');
    assert.deepEqual(result.map((entry) => entry.name), ['巨型菠萝', '幽碧兰（银星）', '卷心菜（金星）',
      'item.customcrops.unknown_crop', '服务器自定义名称']);
    assert.deepEqual(result.map((entry) => entry.quality), ['无星', '银星', '金星', '无星', '无星']);
    assert.deepEqual(result.slice(0, 3).map((entry) => entry.rawName), ['item.customcrops.gigantic_pineapple',
      'item.customcrops.virelo_silver_star', 'customcrops:cabbage_golden_star']);
    assert.equal(result[0].price, 113); assert.equal(result[0].remaining, 0);
    assert.ok(result.every((entry) => entry.identifier === 'minecraft:paper'));
    assert.equal(result[3].rawName, undefined);
  });
  await test('Old snapshots localize on read without recollection, disk writes, counter or timestamp changes', async () => {
    for (const legacyCounters of [false, true]) {
      const f = fixture(); await f.advance(15000); f.collector.tick(); await f.finish();
      const file = f.collector.file(f.collector.context, f.collector.snapshot().day);
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      saved.manualCount = 4;
      if (legacyCounters) { delete saved.autoCount; delete saved.manualCount; delete saved.source; }
      saved.shops.crops.items[0] = { ...saved.shops.crops.items[0], name: 'item.customcrops.virelo_silver_star', quality: '无星' };
      saved.shops.crops.items[1] = { ...saved.shops.crops.items[1], name: 'customcrops:cabbage_golden_star', quality: '无星' };
      saved.shops.crops.items[2] = { ...saved.shops.crops.items[2], name: 'item.customcrops.unknown_crop' };
      fs.writeFileSync(file, JSON.stringify(saved));
      const contents = fs.readFileSync(file, 'utf8');
      const g = fixture(f.collector.directory), snapshot = g.collector.snapshot();
      assert.equal(snapshot.shops.crops.items[0].name, '幽碧兰（银星）');
      assert.equal(snapshot.shops.crops.items[0].quality, '银星');
      assert.equal(snapshot.shops.crops.items[0].rawName, 'item.customcrops.virelo_silver_star');
      assert.equal(snapshot.shops.crops.items[1].name, '卷心菜（金星）');
      assert.equal(snapshot.shops.crops.items[1].quality, '金星');
      assert.deepEqual(snapshot.shops.crops.items[2], saved.shops.crops.items[2]);
      assert.deepEqual(snapshot.shops.system, saved.shops.system);
      assert.deepEqual({ ...snapshot.shops.crops.items[0], name: saved.shops.crops.items[0].name, quality: '无星', rawName: undefined },
        { ...saved.shops.crops.items[0], rawName: undefined });
      assert.equal(snapshot.collectedAt, saved.collectedAt); assert.equal(snapshot.autoCount, 1);
      assert.equal(snapshot.manualCount, legacyCounters ? 0 : 4); assert.equal(snapshot.count, 1);
      await g.advance(15000); g.collector.tick(); assert.deepEqual(g.calls, []);
      assert.equal(fs.readFileSync(file, 'utf8'), contents); g.offline(); f.offline();
    }
  });
  await test('User/sign-in menus and sign-in dispatch defer startup without being closed', async () => {
    const f = fixture(); await f.advance(15000); f.client.features.menu = menu('签到菜单'); f.collector.tick();
    assert.deepEqual(f.calls, []); f.client.features.menu = null; f.collector.afterSignIn();
    f.collector.tick(); assert.deepEqual(f.calls, []); await f.advance(2500); f.collector.tick();
    assert.deepEqual(f.calls, ['open']); f.offline();
  });
  await test('Unexpected navigation, occupied cursor, timeout, pause and late disconnect never count as success', async () => {
    for (const reason of ['menu', 'cursor', 'timeout', 'pause', 'disconnect']) {
      const f = fixture(); f.collector.retry();
      if (reason === 'menu') await f.emit(menu('系统商店', { 23: item('出售全部') }));
      if (reason === 'cursor') await f.emit({ ...menu('芒果小镇主菜单'), cursor: item() });
      if (reason === 'timeout') await f.advance(12000);
      if (reason === 'pause') { f.collector.enabled = () => false; f.collector.tick(); }
      if (reason === 'disconnect') f.offline();
      const expected = reason === 'menu' ? ['open', 'close'] : ['open'];
      assert.equal(f.collector.snapshot().count, 0, reason); assert.deepEqual(f.calls, expected, reason);
      assert.equal(f.tasks.size, 0); f.collector.tick(); assert.deepEqual(f.calls, expected);
    }
  });
  await test('Account/server changes isolate quota and disk failures never mark completion', async () => {
    const f = fixture(); f.collector.retry(); await f.finish();
    f.client.username = 'Other'; f.collector.connected(f.client); assert.equal(f.collector.snapshot().count, 0);
    const g = fixture(); fs.writeFileSync(path.join(g.collector.directory, 'blocked'), 'x');
    g.collector.directory = path.join(g.collector.directory, 'blocked'); g.collector.retry(); await g.finish();
    assert.equal(g.collector.snapshot().count, 0); assert.equal(g.collector.snapshot().status, 'error');
  });
  await test('Navigation whitelist cannot enter fish or click sellable purchase slots', () => {
    assert.equal(navigationAllowed(menu('系统商店', { 29: item('系统收购') }), 29), true);
    assert.equal(navigationAllowed(menu('系统商店', { 29: item('出售全部') }), 29), false);
    assert.equal(navigationAllowed(menu('星露谷收购商店', { 24: item('钓鱼收购') }), 24), false);
    assert.equal(navigationAllowed(menu('每日随机收购商店', { 11: item() }), 11), false);
  });
  await test('Partial price snapshots wait for full authoritative data and never complete a day', async () => {
    const f = fixture(); f.collector.retry();
    await f.emit(menu('芒果小镇主菜单', { 23: item('小镇商店') }));
    await f.emit(menu('系统商店', { 29: item('系统收购') }));
    await f.emit(menu('每日随机收购商店', { 11: item() }));
    assert.equal(f.collector.snapshot().count, 0); assert.deepEqual(f.calls, ['open', 23, 29]);
    await f.advance(12000); assert.equal(f.collector.snapshot().status, 'error'); assert.equal(f.tasks.size, 0);
  });
  await test('Standalone Shift+F emits delayed 26.2 input/action bytes and releases sneak on failure', async () => {
    const c = new MCClient(), frames = []; c.state = 'play'; c.socket = { destroyed: false };
    c.send = (id, fn) => { const w = new ByteWriter(); fn(w); frames.push({ id, bytes: w.build() }); };
    const pending = c.openServerMenu();
    assert.equal(frames.length, 1, 'Swap must not be sent in the same turn as sneak');
    assert.equal((await pending).ok, true);
    assert.deepEqual(frames.map((f) => f.id), [0x2b, 0x29, 0x2b]);
    assert.equal(frames[0].bytes[0], 32); assert.equal(frames[2].bytes[0], 0);
    const r = new ByteReader(frames[1].bytes); assert.equal(r.varint(), 6); assert.equal(r.i64(), 0n);
    assert.equal(r.i8(), 0); assert.equal(r.varint(), 0); assert.equal(r.remaining, 0);
    c.send = (id) => { frames.push({ id }); if (id === P.playPlayerAction) throw new Error('fixture'); };
    assert.equal((await c.openServerMenu()).ok, false); assert.equal(frames.at(-1).id, P.playPlayerInput);
  });
  await test('Real-time navigation follows unique labels even when old slot 23 is a guild button', async () => {
    const f = fixture(); f.collector.retry();
    await f.emit(menu('芒果小镇主菜单', { 23: item('公会功能'), 25: item('小镇商店') }));
    await f.emit(menu('系统商店', { 29: item('公会功能'), 31: item('系统收购') }));
    assert.deepEqual(f.calls, ['open', 25, 31]);
    assert.ok(f.records.some((line) => line.includes('实际格号 25'))); f.offline();
    const g = fixture(); g.collector.retry();
    await g.emit(menu('芒果小镇主菜单', { 23: item('小镇商店'), 25: item('小镇商店') }));
    assert.deepEqual(g.calls, ['open', 'close']); assert.equal(g.collector.snapshot().status, 'error');
  });
  await test('Guild menu is rejected even before slots are ready; timeout reports actual title', async () => {
    const f = fixture(); f.collector.retry();
    await f.emit({ ...menu('公会功能菜单'), status: 'waiting', interactive: false });
    assert.equal(f.collector.snapshot().status, 'error'); assert.match(f.collector.snapshot().error, /公会功能菜单/);
    assert.deepEqual(f.calls, ['open']); assert.equal(f.tasks.size, 0);
    const g = fixture(); g.collector.retry();
    await g.emit({ ...menu('Chest'), status: 'waiting', interactive: false });
    await g.advance(12000); assert.match(g.collector.snapshot().error, /芒果小镇主菜单.*Chest/);
  });
  await test('Bridge negotiation gates menus and rejects fish, stale tokens and sell clicks', async () => {
    const frames = [], session = randomUUID();
    const peer = new BridgeClient({ destroyed: false, destroy() {} }, (f) => { frames.push(f); return true; }, { purchaseMenusEnabled: true });
    assert.equal(peer.autoPurchaseEnabled, false, 'Bridge menu capability must not enable automatic acquisition');
    peer.receive({ kind: 'state', seq: 1, online: true, session, host: 'example.invalid', port: 25565, username: 'Tester' });
    peer.receive({ kind: 'purchase_menu', seq: 2, session, menu: menu('系统商店', { 29: item('系统收购') }) });
    assert.equal((await peer.clickMenu({ ...peer.features.menu, slot: 24, button: 0 })).ok, false);
    const m = peer.features.menu, pending = peer.clickMenu({ id: m.id, token: m.token, revision: m.revision, slot: 29, button: 0 });
    const request = frames.at(-1); assert.equal(request.purchase, 'navigate');
    peer.receive({ kind: 'result', seq: 3, session, id: request.id, ok: true }); assert.equal((await pending).ok, true);
    peer.close();
    const legacy = new BridgeClient({ destroyed: false, destroy() {} }, () => true);
    assert.equal(legacy.autoPurchaseEnabled, false);
    assert.equal((await legacy.openServerMenu()).ok, false); legacy.close();
  });
  await test('Working bridge flow retains its original settle delay and collects both shops', async () => {
    const f = fixture(undefined, true); f.collector.retry();
    await f.finish();
    assert.equal(f.collector.snapshot().count, 1);
    assert.deepEqual(f.calls, ['open', 23, 29, 'close', 'open', 23, 33, 20, 'close']);
    assert.equal(f.records.some((line) => line.startsWith('后台菜单')), false);
  });
  await test('Manual refresh remains unlimited after automatic completion, updates prices, and never resets automatic quota', async () => {
    const f = fixture(); await f.advance(15000); f.collector.tick(); await f.finish();
    assert.equal(f.collector.snapshot().autoCount, 1); assert.equal(f.collector.snapshot().manualCount, 0);
    for (let i = 1; i <= 8; i++) {
      assert.equal(f.collector.retry().ok, true); assert.equal(f.collector.snapshot().status, 'collecting');
      const before = f.calls.length;
      f.collector.retry(); f.collector.tick(); assert.equal(f.calls.length, before, 'No overlapping manual or automatic run');
      await f.finish(String(14 + i));
      assert.equal(f.collector.snapshot().manualCount, i); assert.equal(f.collector.snapshot().autoCount, 1);
      assert.equal(f.collector.snapshot().shops.crops.items[0].price, 14 + i);
      const completed = f.calls.length; f.collector.tick(); assert.equal(f.calls.length, completed);
    }
    const restarted = fixture(f.collector.directory); await restarted.advance(15000); restarted.collector.tick();
    assert.deepEqual(restarted.calls, []); assert.equal(restarted.collector.snapshot().autoCount, 1);
    assert.equal(restarted.collector.snapshot().manualCount, 8);
    restarted.collector.retry(); await restarted.finish('99');
    assert.equal(restarted.collector.snapshot().manualCount, 9);
    assert.equal(restarted.collector.snapshot().shops.crops.items[0].price, 99);
  });
  await test('Manual collection does not consume the independent daily automatic allowance; the next day resets both counters', async () => {
    const f = fixture(); f.collector.retry(); await f.finish();
    assert.equal(f.collector.snapshot().autoCount, 0); assert.equal(f.collector.snapshot().manualCount, 1);
    await f.advance(15000); f.collector.tick(); assert.equal(f.collector.snapshot().source, 'automatic');
    await f.finish(); assert.equal(f.collector.snapshot().autoCount, 1); assert.equal(f.collector.snapshot().manualCount, 1);
    f.nextDay(); f.collector.tick(); assert.equal(f.collector.snapshot().autoCount, 0);
    assert.equal(f.collector.snapshot().manualCount, 0); await f.finish();
    assert.equal(f.collector.snapshot().autoCount, 1); assert.equal(f.collector.snapshot().manualCount, 0);
  });
  await test('Legacy completed records retain automatic quota but permit new manual acquisition without deleting data', async () => {
    const f = fixture(); f.collector.retry(); await f.finish();
    const file = f.collector.file(f.collector.context, f.collector.snapshot().day);
    const legacy = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete legacy.autoCount; delete legacy.manualCount; delete legacy.source;
    fs.writeFileSync(file, JSON.stringify(legacy));
    const g = fixture(f.collector.directory);
    assert.equal(g.collector.snapshot().autoCount, 1); assert.equal(g.collector.snapshot().manualCount, 0);
    await g.advance(15000); g.collector.tick(); assert.deepEqual(g.calls, []);
    assert.equal(g.collector.retry().ok, true); await g.finish('38');
    assert.equal(g.collector.snapshot().autoCount, 1); assert.equal(g.collector.snapshot().manualCount, 1);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).shops.crops.items[0].price, 38);
  });
  await test('Failed manual refresh preserves the previous snapshot, file and counters, and can be retried again', async () => {
    const f = fixture(); await f.advance(15000); f.collector.tick(); await f.finish();
    const file = f.collector.file(f.collector.context, f.collector.snapshot().day);
    const saved = fs.readFileSync(file, 'utf8'), original = f.collector.snapshot();
    f.collector.retry(); await f.advance(12000);
    assert.equal(f.collector.snapshot().status, 'error'); assert.equal(f.collector.snapshot().autoCount, 1);
    assert.equal(f.collector.snapshot().manualCount, 0); assert.deepEqual(f.collector.snapshot().shops, original.shops);
    assert.equal(fs.readFileSync(file, 'utf8'), saved);
    f.collector.retry();
    const rename = fs.renameSync;
    try {
      fs.renameSync = (from, to) => { if (to === file) throw new Error('fixture disk failure'); return rename(from, to); };
      await f.finish('77');
    } finally { fs.renameSync = rename; }
    assert.equal(f.collector.snapshot().status, 'error'); assert.equal(f.collector.snapshot().manualCount, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), saved);
    assert.deepEqual(f.collector.snapshot().shops, original.shops);
    f.collector.retry(); await f.finish('80'); assert.equal(f.collector.snapshot().manualCount, 1);
    assert.equal(f.collector.snapshot().autoCount, 1); assert.equal(f.collector.snapshot().shops.crops.items[0].price, 80);
  });
  await test('Existing automatic records survive switching to bridge mode and still allow manual refresh', async () => {
    const previous = fixture(); await previous.advance(15000); previous.collector.tick(); await previous.finish();
    const f = fixture(previous.collector.directory, true);
    const file = f.collector.file(f.collector.context, f.collector.snapshot().day), saved = fs.readFileSync(file, 'utf8');
    await f.advance(15000); f.collector.tick(); assert.deepEqual(f.calls, []);
    assert.equal(fs.readFileSync(file, 'utf8'), saved);
    for (let i = 1; i <= 2; i++) {
      f.collector.retry(); await f.finish();
      assert.equal(f.collector.snapshot().autoCount, 1); assert.equal(f.collector.snapshot().manualCount, i);
    }
    f.offline(); previous.offline();
  });
  console.log('=== ' + passed + ' daily purchase tests passed ===');
}
run().catch((e) => { console.error(e); process.exitCode = 1; });
