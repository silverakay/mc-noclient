'use strict';

// Offline packet sinks and virtual timers only. No accounts or server connections.
const assert = require('assert/strict');
const { MCClient } = require('./client');
const { getCodec, validMenuStateId } = require('./server_features');
const { ByteReader, ByteWriter, PACKET_ID: P } = require('./proto');
const { mainHarness } = require('./connection_lifecycle_test');

const empty = { itemCount: 0 };
const item = { itemCount: 1, itemId: 1, addedComponentCount: 1, removedComponentCount: 0,
  components: [{ type: 'custom_name', data: { type: 'string', value: 'Menu action' } }], removeComponents: [] };
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
const encoded = (type, data) => getCodec().createPacketBuffer(type, data);

function fixture(type = 2) {
  const sent = [], menus = [], timers = new Map();
  let time = 1000, timerId = 0;
  const client = new MCClient({ onEvent: (name, data) => { if (name === 'menu') menus.push(data); } });
  client.state = 'play';
  client.socket = { destroyed: false, writable: true, destroy() { this.destroyed = true; } };
  client.send = (id, build) => {
    const writer = new ByteWriter(); if (build) build(writer);
    sent.push({ id, bytes: writer.build() });
  };
  client.say = client.command = () => { throw new Error('No chat or guessed command allowed'); };
  const features = client.features;
  features.now = () => time;
  features.setTimer = (fn) => { timers.set(++timerId, fn); return timerId; };
  features.clearTimer = (id) => timers.delete(id);
  const packet = (id, bytes) => client.onPlayPacket(id, new ByteReader(bytes));
  function open(id = 300, menuType = type) {
    packet(P.playOpenWindowC, encoded('packet_open_window', { windowId: id, inventoryType: menuType,
      windowTitle: { type: 'string', value: 'Fixture menu' } }));
  }
  function content(stateId = 7, carriedItem = empty, size = 63) {
    packet(P.playWindowItemsC, encoded('packet_window_items', { windowId: features.menu.id, stateId,
      items: Array.from({ length: size }, (_, i) => i === 15 ? item : empty), carriedItem }));
  }
  function slot(index = 15, stateId = 8, value = item, id = features.menu.id) {
    packet(P.playSetSlotC, encoded('packet_set_slot', { windowId: id, stateId, slot: index, item: value }));
  }
  function request(overrides = {}) {
    const menu = features.menu;
    return { id: menu.id, token: menu.token, revision: menu.revision, slot: 15, button: 0, ...overrides };
  }
  open(); content();
  return { client, features, sent, menus, timers, open, content, slot, packet, request,
    advance: (ms = 301) => { time += ms; }, timeout: () => { const list = [...timers.values()]; timers.clear(); list.forEach((fn) => fn()); } };
}

async function run() {
  await test('Opening and observing a ready menu never sends actions', () => {
    const f = fixture(); assert.equal(f.sent.length, 0);
    assert.equal(f.menus.at(-1).interactive, true); assert.equal(f.features.menu.stateId, 7);
  });
  await test('Left click encodes the real container/state/slot using 26.2 HashedStack format', () => {
    const f = fixture(); assert.equal(f.client.clickMenu(f.request()).ok, true);
    assert.equal(f.sent.length, 1); assert.equal(f.sent[0].id, 0x12);
    assert.equal(f.sent[0].bytes.toString('hex'), 'ac0207000f00000000');
    const r = new ByteReader(f.sent[0].bytes);
    assert.deepEqual([r.varint(), r.varint(), r.i16(), r.i8(), r.varint(), r.varint(), r.bool()],
      [300, 7, 15, 0, 0, 0, false]);
    assert.equal(r.remaining, 0);
    assert.equal(f.features.menu.slots[15].name, 'Menu action', 'Do not invent inventory changes');
    assert.equal(f.menus.at(-1).interactive, false); f.client.close();
  });
  await test('Right click sends ordinary PICKUP with button 1, not a command or quick-move', () => {
    const f = fixture(); assert.equal(f.client.clickMenu(f.request({ button: 1 })).ok, true);
    assert.equal(f.sent[0].bytes.toString('hex'), 'ac0207000f01000000'); f.client.close();
  });
  await test('Double click and IPC replay cannot submit the same menu state twice', () => {
    const f = fixture(), request = f.request();
    assert.equal(f.client.clickMenu(request).ok, true);
    assert.equal(f.client.clickMenu(request).ok, false); assert.equal(f.sent.length, 1); f.client.close();
  });
  await test('A full server refresh unlocks the new revision and rejects stale revisions', () => {
    const f = fixture(), old = f.request(); f.client.clickMenu(old); f.content(8); f.advance();
    assert.equal(f.client.clickMenu(old).ok, false);
    assert.equal(f.client.clickMenu(f.request()).ok, true);
    assert.equal(new ByteReader(f.sent[1].bytes).varint(), 300);
    assert.equal(f.sent[1].bytes[2], 8); f.client.close();
  });
  await test('Only a relevant slot refresh unlocks a pending click; unrelated updates do not', () => {
    const f = fixture(); f.client.clickMenu(f.request()); f.slot(1);
    assert.equal(f.menus.at(-1).interactive, false); assert.ok(f.features.menu.pending);
    f.slot(15, 9); assert.equal(f.menus.at(-1).interactive, true); assert.equal(f.timers.size, 0);
  });
  await test('No-refresh timeout stays locked and never retries or claims task success', () => {
    const f = fixture(); f.client.clickMenu(f.request()); f.timeout(); f.advance(6000);
    assert.equal(f.features.menu.pendingTimedOut, true); assert.equal(f.menus.at(-1).interactive, false);
    assert.equal(f.client.clickMenu(f.request()).ok, false); assert.equal(f.sent.length, 1);
    f.content(8); assert.equal(f.features.menu.pendingTimedOut, false); f.client.close();
  });
  await test('Reopening an identical window id gets a new token and invalidates old clicks', () => {
    const f = fixture(), old = f.request(); f.client.clickMenu(old); f.open(300); f.content(); f.advance();
    assert.notEqual(f.features.menu.token, old.token); assert.equal(f.timers.size, 0);
    assert.equal(f.client.clickMenu(old).ok, false); assert.equal(f.sent.length, 1);
    assert.equal(f.client.clickMenu(f.request()).ok, true); f.client.close();
  });
  await test('Waiting, partial and unrecognized menus remain read-only', () => {
    const f = fixture(); f.open(); assert.equal(f.client.clickMenu(f.request()).ok, false);
    f.content(7, empty, 10); assert.equal(f.client.clickMenu(f.request({ slot: 1 })).ok, false);
    for (const type of [7, 8, 12, 99]) {
      f.open(300, type); f.content(); assert.equal(f.client.clickMenu(f.request({ slot: 0 })).ok, false);
    }
    assert.equal(f.sent.length, 0);
  });
  await test('Full contents with a carried item block all menu clicks', () => {
    const f = fixture(); f.content(8, item);
    assert.equal(f.client.clickMenu(f.request()).ok, false); assert.equal(f.sent.length, 0);
    assert.equal(f.menus.at(-1).cursor.name, 'Menu action');
  });
  await test('Dedicated cursor correction is decoded and prevents an accidental second pickup', () => {
    const f = fixture(); f.client.clickMenu(f.request());
    f.packet(P.playSetCursorC, encoded('packet_set_cursor_item', { contents: item }));
    assert.equal(f.features.menu.cursor.name, 'Menu action'); assert.equal(f.menus.at(-1).interactive, false);
    f.advance(); assert.equal(f.client.clickMenu(f.request()).ok, false);
    f.packet(P.playSetCursorC, encoded('packet_set_cursor_item', { contents: empty }));
    assert.equal(f.menus.at(-1).interactive, true); f.client.close();
  });
  await test('Inventory slots, outside drops, invalid buttons and forged tokens never send', () => {
    const f = fixture();
    for (const changes of [{ slot: -999 }, { slot: -1 }, { slot: 27 }, { slot: 62 }, { slot: 1.2 },
      { button: 2 }, { button: '0' }, { button: 6 }, { revision: 0 }, { token: 'forged' }, { id: 301 }]) {
      assert.equal(f.client.clickMenu(f.request(changes)).ok, false, JSON.stringify(changes));
    }
    assert.equal(f.sent.length, 0);
  });
  await test('Rate limiting also applies after very fast full menu refreshes', () => {
    const f = fixture(); f.client.clickMenu(f.request()); f.content(8);
    assert.equal(f.client.clickMenu(f.request()).ok, false); f.advance();
    assert.equal(f.client.clickMenu(f.request()).ok, true); f.client.close();
  });
  await test('Stale inbound window packets cannot unlock a pending operation', () => {
    const f = fixture(); f.client.clickMenu(f.request()); f.slot(15, 8, item, 299);
    assert.ok(f.features.menu.pending); assert.equal(f.sent.length, 1); f.client.close();
  });
  await test('Decode failures fail closed without disconnecting or losing authoritative state', () => {
    const f = fixture(); f.client.clickMenu(f.request());
    f.packet(P.playWindowItemsC, Buffer.from([1]));
    assert.equal(f.features.menu.status, 'error'); assert.equal(f.features.menu.slots[15].name, 'Menu action');
    f.advance(); assert.equal(f.client.clickMenu(f.request()).ok, false);
    assert.equal(f.client.state, 'play'); assert.equal(f.timers.size, 0); f.client.close();
  });
  await test('Malformed cursor packets also disable clicks until a fresh full snapshot', () => {
    const f = fixture(); f.packet(P.playSetCursorC, Buffer.from([1]));
    assert.equal(f.client.clickMenu(f.request()).ok, false); f.content(8);
    assert.equal(f.menus.at(-1).interactive, true);
  });
  for (const end of ['close', 'respawn', 'reconfig', 'serverClose']) await test('Pending click invalidates on ' + end, () => {
    const f = fixture(), old = f.request(); f.client.clickMenu(old);
    if (end === 'close') f.client.close();
    if (end === 'respawn') f.packet(P.playRespawnC, Buffer.alloc(0));
    if (end === 'reconfig') f.packet(P.playStartConfig, Buffer.alloc(0));
    if (end === 'serverClose') { const w = new ByteWriter(); w.varint(300); f.packet(P.playCloseWindowC, w.build()); }
    assert.equal(f.features.menu, null); assert.equal(f.timers.size, 0);
    assert.equal(f.client.clickMenu(old).ok, false); f.client.close();
  });
  await test('Closed or unwritable sockets reject clicks before consuming the menu state', () => {
    const f = fixture(); f.client.socket.destroyed = true;
    assert.equal(f.client.clickMenu(f.request()).ok, false); assert.equal(f.features.menu.pending, null);
    f.client.socket.destroyed = false; f.client.socket.writable = false;
    assert.equal(f.client.clickMenu(f.request()).ok, false); assert.equal(f.sent.length, 0);
  });
  await test('Closing a connection without any menu emits no extra lifecycle event', () => {
    const events = [], client = new MCClient({ onEvent: (name) => events.push(name) });
    client.close(); client.close(); assert.deepEqual(events, []);
  });
  await test('Uncertain send fails closed and does not automatically replay', () => {
    const f = fixture(); f.client.send = () => { throw new Error('Fixture socket write failure'); };
    assert.equal(f.client.clickMenu(f.request()).ok, false); assert.equal(f.features.menu.status, 'error');
    f.advance(); assert.equal(f.client.clickMenu(f.request()).ok, false); f.client.close();
  });
  await test('Main IPC validates requests and keeps bridge/offline modes unsupported', async () => {
    const h = mainHarness(); assert.equal(h.invoke('client:clickMenu', {}).ok, false);
    await h.connect(); const c = h.clients[0]; c.state = 'play';
    const f = fixture(), request = f.request();
    let calls = 0;
    c.clickMenu = (r) => { calls++; assert.equal(r.token, request.token); return { ok: true }; };
    for (const bad of [null, 300, {}, { ...request, token: '' }, { ...request, revision: -1 },
      { ...request, slot: 54 }, { ...request, button: 2 }, { ...request, id: '300' }]) {
      assert.equal(h.invoke('client:clickMenu', bad).ok, false);
    }
    assert.equal(calls, 0); assert.equal(h.invoke('client:clickMenu', request).ok, true); assert.equal(calls, 1);
    c.clickMenu = () => { throw new Error('Fixture failure'); };
    assert.equal(h.invoke('client:clickMenu', request).ok, false);
    h.disconnect(); assert.equal(h.invoke('client:clickMenu', request).ok, false);
    assert.equal((await h.invoke('client:mode', 'bridge')).ok, true);
    assert.equal(h.invoke('client:clickMenu', request).ok, false); h.quit();
  });
  await test('Token-aware close rejects a reused window instead of closing a new menu', async () => {
    const h = mainHarness(); await h.connect(); const c = h.clients[0]; c.state = 'play';
    const f = fixture(), old = f.request(); c.features = f.features; let closes = 0;
    c.closeMenu = () => { closes++; return true; };
    f.open(); f.content();
    assert.equal(h.invoke('client:closeMenu', { id: 300, token: old.token }).ok, false);
    assert.equal(closes, 0);
    assert.equal(h.invoke('client:closeMenu', { id: 300, token: f.features.menu.token }).ok, true);
    h.disconnect(); h.quit();
  });
  await test('Server-supplied state -1 stays clickable and is echoed exactly, not replaced with zero or the old state', () => {
    for (const source of ['contents', 'slot']) {
      const f = fixture();
      if (source === 'contents') f.content(-1);
      else f.slot(15, -1);
      assert.equal(f.features.menu.stateId, -1); assert.equal(f.menus.at(-1).interactive, true);
      assert.equal(f.client.clickMenu(f.request()).ok, true);
      assert.equal(f.sent[0].bytes.toString('hex'), 'ac02ffffffff0f000f00000000');
      const r = new ByteReader(f.sent[0].bytes);
      assert.equal(r.varint(), 300); assert.equal(r.varint(), -1);
      assert.equal(f.client.clickMenu(f.request()).ok, false, 'Pending clicks stay blocked');
      f.client.close();
    }
  });
  await test('State -1 does not bypass cursor, readiness, revision, inventory or stale-window guards', () => {
    const f = fixture(), previous = f.request(); f.content(-1);
    assert.equal(f.client.clickMenu(previous).ok, false);
    assert.equal(f.client.clickMenu(f.request({ slot: 27 })).ok, false);
    f.content(-1, item); assert.equal(f.client.clickMenu(f.request()).ok, false);
    f.content(-1, empty, 10); assert.equal(f.client.clickMenu(f.request()).ok, false);
    f.open(); f.slot(15, -1); assert.equal(f.client.clickMenu(f.request()).ok, false);
    assert.equal(f.sent.length, 0); f.client.close();
  });
  await test('Only the supported sentinel and nonnegative signed-int32 states pass the state-id guard', () => {
    for (const value of [-1, 0, 7, 32767, 0x7fffffff]) assert.equal(validMenuStateId(value), true);
    for (const value of [undefined, null, NaN, Infinity, -2, -2147483648, 1.2, '7', 0x80000000, Number.MAX_SAFE_INTEGER]) {
      assert.equal(validMenuStateId(value), false, String(value));
    }
  });
  console.log('=== ' + passed + ' menu click tests passed ===');
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
