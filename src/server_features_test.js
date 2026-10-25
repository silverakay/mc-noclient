'use strict';

// Offline fixtures only. Completion requests and ACKs go into an in-memory sink.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MCClient } = require('./client');
const { ServerFeatures, getCodec } = require('./server_features');
const { ByteReader, ByteWriter, PACKET_ID: P } = require('./proto');
const { PresenceStore } = require('./presence');
const { normalize } = require('./configstore');
const { mainHarness } = require('./connection_lifecycle_test');
const uuid = '00000000-0000-0000-0000-000000000001';
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
function buffer(build) { const w = new ByteWriter(); build(w); return w.build(); }
function fixture() {
  const sent = [], events = [];
  const client = new MCClient({ onEvent: (name, data) => events.push({ name, data }) });
  client.state = 'play';
  client.send = (id, build) => sent.push({ id, data: build ? buffer(build) : Buffer.alloc(0) });
  return { client, sent, events };
}
function player(flags = 0x09, name = 'Tester', listed = true) {
  return buffer((w) => {
    w.u8(flags); w.varint(1); w.uuid(uuid);
    if (flags & 1) { w.str(name); w.varint(0); }
    if (flags & 8) w.bool(listed);
    if (flags & 16) w.varint(42);
    if (flags & 64) w.varint(300);
    if (flags & 128) w.bool(true);
  });
}
function encoded(type, data) { return getCodec().createPacketBuffer(type, data); }
function completion(id, start = 1, length = 2, matches = ['help', 'hello']) {
  return new ByteReader(buffer((w) => {
    w.varint(id); w.varint(start); w.varint(length); w.varint(matches.length);
    for (const match of matches) { w.str(match); w.bool(false); }
  }));
}
function signed(index) {
  return new ByteReader(buffer((w) => {
    w.varint(index); w.uuid(uuid); w.varint(index); w.bool(true);
    const signature = Buffer.alloc(256); signature.writeInt32BE(index); w.buf(signature); w.str('fixture');
  }));
}

async function run() {
  await test('Player list uses listed flag, LIST_ORDER bit 6 and HAT bit 7', () => {
    const f = new ServerFeatures(); f.playerInfo(player(0xd9));
    assert.equal(f.getPlayers()[0].name, 'Tester'); assert.equal(f.getPlayers()[0].priority, 300);
    assert.equal(f.getPlayers()[0].latency, 42);
    f.playerInfo(player(8, '', false)); assert.equal(f.getPlayers().length, 0);
    f.playerInfo(player(8)); assert.equal(f.getPlayers()[0].name, 'Tester');
    f.playerRemove(buffer((w) => { w.varint(1); w.uuid(uuid); })); assert.equal(f.getPlayers().length, 0);
  });
  await test('Truncated list updates do not partially replace the last valid list', () => {
    const f = new ServerFeatures(); f.playerInfo(player());
    assert.throws(() => f.playerInfo(player().subarray(0, 20)));
    assert.equal(f.getPlayers()[0].name, 'Tester');
  });
  await test('Container preview decodes title, named item/count/lore and ignores stale ids', () => {
    const f = new ServerFeatures();
    f.openMenu(encoded('packet_open_window', { windowId: 300, inventoryType: 0,
      windowTitle: { type: 'string', value: 'Fixture menu' } }));
    const item = { itemCount: 3, itemId: 1, addedComponentCount: 2, removedComponentCount: 0,
      components: [{ type: 'custom_name', data: { type: 'string', value: 'Fixture item' } },
        { type: 'lore', data: [{ type: 'string', value: 'Fixture lore' }] }], removeComponents: [] };
    const content = (id) => encoded('packet_window_items', { windowId: id, stateId: 1,
      items: [item, { itemCount: 0 }], carriedItem: { itemCount: 0 } });
    f.windowItems(content(299)); assert.equal(f.menu.status, 'waiting');
    f.windowItems(content(300)); assert.equal(f.menu.slots[0].name, 'Fixture item');
    assert.equal(f.menu.slots[0].count, 3); assert.deepEqual(f.menu.slots[0].lore, ['Fixture lore']);
    f.closeMenu(buffer((w) => w.varint(299))); assert.ok(f.menu);
    f.closeMenu(buffer((w) => w.varint(300))); assert.equal(f.menu, null);
  });
  await test('Malformed menu data surfaces an error without dropping the connection', () => {
    const { client, events } = fixture();
    client.onPlayPacket(P.playOpenWindowC, new ByteReader(encoded('packet_open_window', {
      windowId: 1, inventoryType: 0, windowTitle: { type: 'string', value: 'Fixture' } })));
    client.onPlayPacket(P.playWindowItemsC, new ByteReader(Buffer.from([1])));
    assert.equal(client.state, 'play'); assert.equal(events.at(-1).data.status, 'error');
    assert.equal(client.getChatDiagnostics().featureErrors['菜单'], 1);
  });
  await test('Real NBT item_name and custom_name packets localize nested crops and keep raw keys', () => {
    const f = new ServerFeatures();
    f.openMenu(encoded('packet_open_window', { windowId: 119, inventoryType: 5,
      windowTitle: { type: 'string', value: '星露谷每日随机收购商店' } }));
    const language = Object.entries(require('./lang/customcrops_zh_cn.json'));
    const items = language.map(([key], i) => ({ itemCount: 1, itemId: 1,
      addedComponentCount: 2, removedComponentCount: 0, removeComponents: [], components: [
        { type: i % 2 ? 'item_name' : 'custom_name', data: { type: 'compound', value: {
          text: { type: 'string', value: '' }, extra: { type: 'list', value: { type: 'compound', value: [
            { translate: { type: 'string', value: key } },
          ] } },
        } } }, { type: 'lore', data: [{ type: 'string', value: '卖价: 14金币' },
          { type: 'string', value: '玩家出售限量: 0/16' }] },
      ] }));
    f.windowItems(encoded('packet_window_items', { windowId: 119, stateId: -1, items, carriedItem: { itemCount: 0 } }));
    language.forEach(([key, name], i) => {
      assert.equal(f.menu.slots[i].name, name); assert.equal(f.menu.slots[i].rawName, key);
      assert.equal(f.menu.slots[i].identifier, 'minecraft:stone');
      assert.deepEqual(f.menu.slots[i].lore, ['卖价: 14金币', '玩家出售限量: 0/16']);
    });
    const preferred = structuredClone(items[0]);
    preferred.addedComponentCount++;
    preferred.components.push({ type: 'item_name', data: { type: 'string', value: 'Do not use this name' } });
    f.windowItems(encoded('packet_window_items', { windowId: 119, stateId: -1,
      items: [preferred], carriedItem: { itemCount: 0 } }));
    assert.equal(f.menu.slots[0].name, language[0][1], 'custom_name still takes precedence');
  });
  await test('Closing a menu emits only close-container, not an inventory click', () => {
    const { client, sent } = fixture(); client.features.menu = { id: 300 };
    assert.equal(client.closeMenu(299), false); assert.equal(client.closeMenu(300), true);
    assert.equal(client.closeMenu(300), false); assert.equal(sent.length, 1);
    assert.equal(sent[0].id, P.playCloseWindow); assert.equal(new ByteReader(sent[0].data).varint(), 300);
  });
  await test('Server command completion requests do not send chat or business commands', async () => {
    const { client, sent } = fixture();
    client.say = client.command = () => { throw new Error('Business sending forbidden'); };
    const request = client.completeCommand('/he');
    const reader = new ByteReader(sent[0].data); const id = reader.varint(); assert.equal(reader.str(), '/he');
    client.handleCompletion(completion(id - 1)); assert.ok(client._completion);
    client.handleCompletion(completion(id, 1, 2, ['help', 'help', 'hello']));
    assert.deepEqual((await request).matches.map((match) => match.text), ['help', 'hello']);
    assert.equal(sent.length, 1); assert.equal(sent[0].id, P.playTabComplete);
  });
  await test('Bad completion ranges and disconnect invalidate pending requests', async () => {
    const { client } = fixture(); const request = client.completeCommand('/he');
    client.handleCompletion(completion(1, 99)); assert.equal((await request).ok, false);
    client._lastCompletionAt = 0; const pending = client.completeCommand('/he');
    client.close(); assert.equal((await pending).ok, false);
    assert.equal((await client.completeCommand('/he')).ok, false);
  });
  await test('Ready receipt is sent once per world; no fake chat session key is uploaded', () => {
    const { client, sent } = fixture(); client.sendLoaded(); client.sendLoaded();
    assert.deepEqual(sent.map((message) => message.id), [P.playPlayerLoaded]);
    client.onPlayPacket(P.playRespawnC, new ByteReader(Buffer.alloc(0))); client.sendLoaded();
    assert.equal(sent.length, 2); assert.equal(client.getChatDiagnostics().loadedReplies, 2);
  });
  await test('Plugin diagnostics retain channel metadata, not private payload', () => {
    const { client } = fixture();
    client.handleCustomPayload(new ByteReader(buffer((w) => { w.str('plugin:chat'); w.str('SECRET_PAYLOAD'); })));
    const diagnostic = client.getChatDiagnostics(); assert.equal(diagnostic.pluginChannels['plugin:chat'].packets, 1);
    assert.ok(!JSON.stringify(diagnostic).includes('SECRET_PAYLOAD'));
  });
  await test('Signed ACK offset ignores consecutive duplicate signatures', () => {
    const { client, sent } = fixture();
    for (let i = 1; i <= 65; i++) { client.onPlayPacket(P.playPlayerChat, signed(i)); client.onPlayPacket(P.playPlayerChat, signed(i)); }
    assert.equal(sent.length, 1); assert.equal(sent[0].id, P.playChatAck);
    assert.equal(new ByteReader(sent[0].data).varint(), 65);
    assert.equal(client._lastSeen.filter(Boolean).length, 20);
  });
  await test('Manual unsigned chat includes the current 20-message acknowledgement window', () => {
    const { client, sent } = fixture(); client.onPlayPacket(P.playPlayerChat, signed(1));
    client.say('offline fixture'); const r = new ByteReader(sent[0].data);
    r.str(); r.i64(); r.i64(); assert.equal(r.bool(), false); assert.equal(r.varint(), 1);
    assert.equal(r.raw(3).toString('hex'), '000008'); assert.equal(r.u8(), 0); assert.equal(r.remaining, 0);
    assert.equal(client._signedPending, 0);
  });
  await test('List observations preserve unknown login time and do not count removal as a full logout', () => {
    let now = 1000;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-feature-presence-'));
    const store = new PresenceStore(path.join(dir, 'presence.jsonl'), { now: () => now });
    store.start('example.invalid'); store.updatePlayers([{ name: 'Tester', uuid }]); now = 61000;
    let result = store.query({ host: 'example.invalid', name: 'Tester' });
    assert.equal(result.totalMs, 0); assert.equal(result.rows[0].startKnown, false);
    assert.equal(result.rows[0].observedDuration, 60000);
    store.updatePlayers([]); result = store.query({ host: 'example.invalid', name: 'Tester' });
    assert.equal(result.rows[0].status, 'observed-only'); assert.equal(result.observedMs, 60000);
    assert.equal(result.totalMs, 0); store.end(); assert.equal(store.getOnline().known, false);
  });
  await test('Join notifications before TAB-list updates retain known start and duplicate joins do not reset it', () => {
    let now = 1000;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-feature-presence-'));
    const store = new PresenceStore(path.join(dir, 'presence.jsonl'), { now: () => now });
    store.start('example.invalid'); store.record('[+] Tester', 'system'); now = 2000;
    store.updatePlayers([{ name: 'Tester' }]); store.record('[+] Tester', 'system');
    assert.equal(store.getOnline().players[0].observedSince, 1000);
    now = 61000; store.record('[-] Tester', 'system');
    assert.equal(store.query({ host: 'example.invalid', name: 'Tester' }).totalMs, 60000);
  });
  await test('Shortcut config drops invalid values, caps count, and keeps valid user commands', () => {
    const good = { name: 'Fixture', command: '/user chosen' };
    const result = normalize({ shortcuts: [good, { name: 'bad', command: 'hello' },
      { name: 'bad', command: '/x\n/y' }] });
    assert.deepEqual(result.shortcuts, [good]); assert.equal(normalize({ shortcuts: Array(99).fill(good) }).shortcuts.length, 30);
  });
  await test('Main IPC exposes lists and rejects unsupported/stale menu/completion requests', async () => {
    const h = mainHarness(); assert.equal(h.invoke('presence:online').known, false);
    assert.equal((await h.invoke('client:complete', '/he')).ok, false);
    await h.connect(); const c = h.clients[0]; c.state = 'play';
    c.completeCommand = async (text) => ({ ok: true, text }); c.closeMenu = (id) => id === 300;
    assert.equal((await h.invoke('client:complete', '/he')).text, '/he');
    assert.equal(h.invoke('client:closeMenu', 300).ok, true);
    assert.equal(h.invoke('client:closeMenu', '300').ok, false);
    h.disconnect(); const before = h.statuses.length; c.opts.onEvent('players', [{ name: 'Stale' }]);
    assert.equal(h.statuses.length, before); assert.equal(h.business(), 0);
  });
  await test('Nan_Koi chat is retained in the runtime log without duplicating normal chat output', async () => {
    const h = mainHarness(); await h.connect(); const c = h.clients[0]; c.state = 'play';
    c.opts.onChat('hello Nan_Koi', { type: 'player' });
    c.opts.onChat('ordinary message', { type: 'player' });
    assert.equal(h.logs.filter((item) => item.level === 'chat' && item.text.includes('Nan_Koi')).length, 1);
    assert.equal(h.logs.filter((item) => item.text.includes('ordinary message')).length, 0);
    assert.equal(h.chats.length, 2);
  });
  await test('Player monitoring follows the configured player list instead of a hard-coded name', async () => {
    const h = mainHarness(); await h.connect(); const c = h.clients[0]; c.state = 'play';
    await h.configure({ monitoredPlayers: ['Alice'], servers: [], behavior: {}, automation: {} });
    c.opts.onChat('hello from Alice', { type: 'player', sender: 'Alice' });
    c.opts.onChat('hello from Nan_Koi', { type: 'player', sender: 'Nan_Koi' });
    assert.equal(h.logs.filter((item) => item.level === 'chat' && item.text.includes('[Alice]')).length, 1);
    assert.equal(h.logs.filter((item) => item.level === 'chat' && item.text.includes('[Nan_Koi]')).length, 0);
  });
  await test('Main batches all packet claims into one delayed runtime-log entry, never back into chat', async () => {
    const h = mainHarness(); await h.connect(); const c = h.clients[0]; c.state = 'play';
    c.opts.onChat('[红包]玩家 terr1es 发送了一个 口令红包 【输入口令领取】', { type: 'system' });
    const flush = h.timers[h.timers.length - 1];
    for (let i = 0; i < 25; i++) {
      const name = i === 0 ? 'Nan_Koi' : 'Tester' + i;
      c.opts.onChat(`[红包]${name} 领取了 terr1es 发送的 口令红包，金额：25 金币`, { type: 'system' });
    }
    assert.equal(h.chats.length, 1);
    assert.equal(h.logs.filter((item) => item.text.includes('领取了 terr1es')).length, 0);
    flush();
    const results = h.logs.filter((item) => item.text.includes('领取了 terr1es'));
    assert.equal(results.length, 1); assert.equal(results[0].text.split('\n').length, 26);
    assert.match(results[0].text, /Nan_Koi 领取了 terr1es/);
    assert.equal(h.chats.length, 1); assert.equal(h.business(), 0);
  });
  console.log('=== ' + passed + ' server feature tests passed ===');
}
run().catch((e) => { console.error(e); process.exitCode = 1; });
