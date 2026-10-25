'use strict';

const { ProtoDefCompiler } = require('protodef').Compiler;
const nbt = require('prismarine-nbt');
const { componentToText } = require('./chat_component');
const { randomUUID } = require('crypto');
let codec;
function getCodec() {
  if (codec) return codec;
  const schema = JSON.parse(JSON.stringify(require('./data/protocol-26.2.json')));
  // Official 26.2 Action ordinal: LIST_ORDER=6, HAT=7; listed is a boolean.
  const info = schema.play.toClient.types.packet_player_info[1];
  info[0].type[1].flags.splice(6, 2, 'update_list_order', 'update_hat');
  const listed = info[1].type[1].type[1].find((field) => field.name === 'listed');
  listed.type[1].fields.true = 'bool';
  const compiler = new ProtoDefCompiler();
  compiler.addTypes(require('./vendor/protocol-datatypes/compiler-minecraft'));
  compiler.addProtocol(schema, ['play', 'toClient']);
  nbt.addTypesToCompiler('big', compiler);
  codec = compiler.compileProtoDefSync();
  return codec;
}

function decode(type, bytes) {
  if (bytes.length > 2 * 1024 * 1024) throw new Error('服务端扩展数据过大');
  const packet = getCodec().parsePacketBuffer(type, bytes);
  if (packet.metadata.size !== bytes.length) throw new Error('服务端数据字段长度不一致');
  return packet.data;
}

function text(node, options) {
  try { return componentToText(node ? nbt.simplify(node) : null, options).slice(0, 2048); }
  catch (_) { return ''; }
}

function slotSummary(slot) {
  if (!slot || !slot.itemCount) return null;
  const components = slot.components || [];
  const named = components.find((part) => part.type === 'custom_name')
    || components.find((part) => part.type === 'item_name');
  const lore = components.find((part) => part.type === 'lore');
  const definition = require('./data/items-26.2.json')[slot.itemId];
  const customName = named && text(named.data);
  const rawName = named && text(named.data, { translate: false });
  return { itemId: slot.itemId, count: slot.itemCount,
    name: customName || definition && componentToText({ translate: definition.translation })
      || '物品 #' + slot.itemId,
    ...(rawName && rawName !== customName ? { rawName } : {}),
    identifier: definition && definition.name || '',
    lore: lore && Array.isArray(lore.data) ? lore.data.slice(0, 24).map(text) : [] };
}

const MENU_SLOTS = { 0: 9, 1: 18, 2: 27, 3: 36, 4: 45, 5: 54, 6: 9, 7: 9 };
// Plugin menus may send -1 in slot/content updates. Vanilla stores that value
// in the open container and echoes it in the signed VarInt on the next click.
function validMenuStateId(value) {
  return Number.isInteger(value) && value >= -1 && value <= 0x7fffffff;
}
class ServerFeatures {
  constructor({ onPlayers = () => {}, onMenu = () => {}, now = Date.now,
    setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.onPlayers = onPlayers;
    this.onMenu = onMenu;
    this.now = now;
    this.setTimer = setTimer; this.clearTimer = clearTimer;
    this.clickTimer = null; this.lastClickAt = -Infinity;
    this.players = new Map();
    this.menu = null;
  }

  playerInfo(bytes) {
    const packet = decode('packet_player_info', bytes);
    if (packet.data.length > 4096) throw new Error('玩家列表过大');
    const next = new Map(this.players);
    for (const entry of packet.data) {
      const previous = next.get(entry.uuid) || { uuid: entry.uuid, listed: false, firstSeen: this.now() };
      const player = { ...previous };
      if (packet.action.add_player) player.name = entry.player.name;
      if (packet.action.update_listed) player.listed = entry.listed;
      if (packet.action.update_latency) player.latency = entry.latency;
      if (packet.action.update_display_name) player.displayName = text(entry.displayName);
      if (packet.action.update_list_order) player.priority = entry.listPriority;
      if (player.name && /^[A-Za-z0-9_]{1,16}$/.test(player.name)) next.set(entry.uuid, player);
    }
    if (next.size > 4096) throw new Error('玩家缓存过大');
    this.players = next;
    this.onPlayers(this.getPlayers());
  }

  playerRemove(bytes) {
    const packet = decode('packet_player_remove', bytes);
    for (const uuid of packet.players) this.players.delete(uuid);
    this.onPlayers(this.getPlayers());
  }

  getPlayers() {
    return [...this.players.values()].filter((player) => player.listed).map((player) => ({ ...player }))
      .sort((a, b) => (b.priority || 0) - (a.priority || 0) || a.name.localeCompare(b.name));
  }

  openMenu(bytes) {
    const packet = decode('packet_open_window', bytes);
    if (!Number.isInteger(packet.windowId) || packet.windowId < 1) throw new Error('菜单编号无效');
    this.clearClick();
    this.menu = { id: packet.windowId, token: randomUUID(), type: packet.inventoryType,
      title: text(packet.windowTitle) || '服务器菜单',
      expectedSlots: MENU_SLOTS[packet.inventoryType] || null, slots: [], status: 'waiting', error: '', revision: 0,
      cursor: null, cursorKnown: false, pending: null, pendingTimedOut: false };
    this.menu.diagnostics = { fullPackets: 0, slotPackets: 0, ignoredSlotPackets: 0 };
    this.emitMenu();
  }

  windowItems(bytes) {
    const packet = decode('packet_window_items', bytes);
    if (!this.menu) return;
    this.menu.diagnostics.lastContentWindowId = packet.windowId;
    if (packet.windowId !== this.menu.id) return;
    if (packet.items.length > 512) throw new Error('菜单格子过多');
    const slots = packet.items.map(slotSummary), cursor = slotSummary(packet.carriedItem);
    this.clearClick();
    this.menu.slots = slots;
    this.menu.diagnostics.fullPackets++;
    this.menu.cursor = cursor; this.menu.cursorKnown = true;
    this.menu.stateId = packet.stateId;
    this.menu.status = 'ready'; this.menu.error = ''; this.menu.revision++;
    this.emitMenu();
  }

  setSlot(bytes) {
    const packet = decode('packet_set_slot', bytes);
    if (!this.menu || packet.windowId !== this.menu.id) return;
    this.menu.diagnostics.slotPackets++;
    if (packet.slot < 0 || packet.slot >= this.menu.slots.length) { this.menu.diagnostics.ignoredSlotPackets++; return; }
    const item = slotSummary(packet.item);
    if (this.menu.pending && this.menu.pending.slot === packet.slot) this.clearClick();
    this.menu.slots[packet.slot] = item;
    this.menu.stateId = packet.stateId;
    this.menu.revision++;
    this.emitMenu();
  }

  closeMenu(bytes) {
    const packet = decode('packet_close_window', bytes);
    if (this.menu && this.menu.id === packet.windowId) this.dismissMenu();
  }

  setCursor(bytes) {
    const packet = decode('packet_set_cursor_item', bytes);
    if (!this.menu) return;
    const cursor = slotSummary(packet.contents);
    this.clearClick();
    this.menu.cursor = cursor; this.menu.cursorKnown = true;
    this.menu.revision++;
    this.emitMenu();
  }

  canClick() {
    const menu = this.menu;
    return !!menu && menu.status === 'ready' && validMenuStateId(menu.stateId)
      && menu.type >= 0 && menu.type <= 6 && !!menu.expectedSlots
      && menu.slots.length >= menu.expectedSlots && menu.cursorKnown && !menu.cursor && !menu.pending;
  }

  beginClick(request) {
    const menu = this.menu;
    if (!request || !menu || request.id !== menu.id || request.token !== menu.token
      || request.revision !== menu.revision) return { ok: false, error: '菜单已更新或失效，请按当前菜单重新操作' };
    if (!Number.isInteger(request.slot) || request.slot < 0 || request.slot >= menu.expectedSlots
      || ![0, 1].includes(request.button)) return { ok: false, error: '只支持菜单区域内的普通左键或右键点击' };
    if (!this.canClick()) return { ok: false, error: menu.cursor
      ? '光标持有物品，已暂停菜单点击；关闭菜单后由服务器处理物品'
      : menu.pending ? '上一次点击仍在等待菜单刷新，不会重复提交' : '此菜单尚未就绪或暂不支持点击' };
    const now = this.now();
    if (now - this.lastClickAt < 300) return { ok: false, error: '操作过快，请稍后再试' };
    this.lastClickAt = now;
    menu.pending = { slot: request.slot }; menu.pendingTimedOut = false;
    const token = menu.token, pending = menu.pending;
    this.clickTimer = this.setTimer(() => {
      this.clickTimer = null;
      if (this.menu && this.menu.token === token && this.menu.pending === pending) {
        this.menu.pendingTimedOut = true; this.emitMenu();
      }
    }, 5000);
    if (this.clickTimer && this.clickTimer.unref) this.clickTimer.unref();
    this.emitMenu();
    return { ok: true, id: menu.id, stateId: menu.stateId, slot: request.slot, button: request.button };
  }

  clearClick() {
    if (this.clickTimer !== null) this.clearTimer(this.clickTimer);
    this.clickTimer = null;
    if (this.menu) { this.menu.pending = null; this.menu.pendingTimedOut = false; }
  }

  dismissMenu() {
    const hadMenu = !!this.menu;
    this.clearClick(); this.menu = null;
    if (hadMenu) this.onMenu(null);
  }

  menuFailure(error) {
    this.clearClick();
    if (this.menu) { this.menu.error = '物品内容未能解析：' + error.message; this.menu.status = 'error'; this.emitMenu(); }
  }

  emitMenu() { this.onMenu(this.menu ? JSON.parse(JSON.stringify({ ...this.menu, interactive: this.canClick() })) : null); }
  reset() {
    this.players.clear(); this.onPlayers([]);
    if (this.menu) this.dismissMenu(); else this.onMenu(null);
  }
}

module.exports = { ServerFeatures, decode, getCodec, slotSummary, text, validMenuStateId };
