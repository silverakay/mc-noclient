'use strict';

const net = require('net');
const fs = require('fs');
const { EventEmitter } = require('events');
const { randomBytes, randomInt, randomUUID, timingSafeEqual } = require('crypto');
const { clickAction, componentToRuns } = require('./chat_component');
const { validateObservation } = require('./outbound_monitor');
const { navigationAllowed } = require('./daily_purchase');
const { BridgeDiscovery, validUsername } = require('./bridge_discovery');
const { withFileLock } = require('./file_lock');

const MAX_FRAME = 512 * 1024;
const SESSION = /^[a-f0-9-]{36}$/i;
const plain = (s, max) => typeof s === 'string' && s.length <= max && !/[\x00-\x1f\x7f]/.test(s);

function pairing(file, { create = true } = {}) {
  // Serialize readers too: another first-launch process may still be writing the file.
  const value = withFileLock(file, () => {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!create) throw new Error('No saved bridge pairing file');
    const created = { version: 1, host: '127.0.0.1', port: randomInt(38000, 58000), token: randomBytes(32).toString('hex') };
    fs.writeFileSync(file, JSON.stringify(created, null, 2), { flag: 'wx', mode: 0o600 });
    return created;
  });
  if (!value || value.version !== 1 || value.host !== '127.0.0.1'
    || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535
    || !/^[a-f0-9]{64}$/.test(value.token)) throw new Error('Invalid bridge pairing file');
  return value;
}

function sameToken(a, b) {
  return typeof a === 'string' && /^[a-f0-9]{64}$/.test(a)
    && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

class BridgeClient extends EventEmitter {
  constructor(socket, send, { requestTimeout = 5000, now = Date.now, monitorEnabled = false, purchaseMenusEnabled = false, disconnectEnabled = false, offlineStateEnabled = false } = {}) {
    super();
    Object.assign(this, { socket, send, requestTimeout, now });
    this.link = randomUUID();
    this.state = 'idle'; this.session = null; this.host = ''; this.port = 25565;
    this.username = ''; this.remoteActions = new Map(); this.requests = new Map();
    this.stats = { received: 0, sent: 0, chats: 0 }; this.sequence = 0;
    this.automationBlocked = false;
    this.monitorEnabled = monitorEnabled === true;
    this.purchaseMenusEnabled = purchaseMenusEnabled === true;
    this.disconnectEnabled = disconnectEnabled === true;
    this.offlineStateEnabled = offlineStateEnabled === true;
    this.players = [];
    // Menu capability permits manual reads, not unsolicited in-game actions.
    this.autoPurchaseEnabled = false;
    this.features = { menu: null };
    this.observationWindow = 0; this.observationCount = 0;
  }

  clearRequests(reason, offlineSession = null) {
    for (const item of this.requests.values()) {
      clearTimeout(item.timer);
      item.resolve(offlineSession && item.control === 'disconnect' && item.session === offlineSession
        ? { ok: true, disconnected: true } : { ok: false, error: reason });
    }
    this.requests.clear(); this.remoteActions.clear();
  }

  receive(frame) {
    if (!frame || !Number.isSafeInteger(frame.seq) || frame.seq <= this.sequence) throw new Error('Invalid bridge sequence');
    this.sequence = frame.seq;
    if (frame.kind === 'state') {
      if (frame.online !== true) {
        this.features.menu = null;
        this.players = [];
        const offlineSession = this.offlineStateEnabled && frame.gameDisconnected === true
          && SESSION.test(frame.offlineSession || '') ? frame.offlineSession : null;
        this.clearRequests('Game connection closed', offlineSession);
        this.state = 'idle'; this.session = null;
        this.emit('state', frame); return;
      }
      if (!SESSION.test(frame.session || '') || !plain(frame.host, 255) || !frame.host
        || /[\s/\\]/.test(frame.host) || !Number.isInteger(frame.port) || frame.port < 1 || frame.port > 65535
        || !/^[A-Za-z0-9_]{1,16}$/.test(frame.username || '')) throw new Error('Invalid game session');
      const changed = this.session !== frame.session;
      if (!changed && (this.host !== frame.host || this.port !== frame.port || this.username !== frame.username)) {
        throw new Error('Game identity changed without a new session');
      }
      if (changed) { this.features.menu = null; this.players = []; this.clearRequests('Game session changed'); this.observationWindow = 0; this.observationCount = 0; }
      Object.assign(this, { session: frame.session, host: frame.host, port: frame.port,
        username: frame.username, automationBlocked: frame.automationBlocked === true, state: 'play' });
      if (changed) this.joinedAt = Date.now();
      this.emit('state', { ...frame, changed }); return;
    }
    if (frame.kind === 'heartbeat') { this.send({ kind: 'heartbeat' }); return; }
    if (this.state !== 'play' || frame.session !== this.session) return;
    if (frame.kind === 'purchase_menu') {
      if (!this.purchaseMenusEnabled) throw new Error('Purchase menus not negotiated');
      const menu = frame.menu;
      if (menu !== null) {
        if (!menu || !Number.isInteger(menu.id) || menu.id < 1 || !SESSION.test(menu.token || '')
          || !Number.isSafeInteger(menu.revision) || menu.revision < 0 || !plain(menu.title, 2048)
          || !Number.isInteger(menu.expectedSlots) || menu.expectedSlots < 0 || menu.expectedSlots > 54
          || !Array.isArray(menu.slots) || menu.slots.length > 54
          || !['waiting', 'ready'].includes(menu.status)) throw new Error('Invalid purchase menu');
        for (const item of [...menu.slots, menu.cursor]) {
          if (item == null) continue;
          if (!plain(item.name, 2048) || !plain(item.identifier, 256) || !Number.isInteger(item.count)
            || item.count < 1 || item.count > 9999 || !Array.isArray(item.lore) || item.lore.length > 24
            || item.lore.some((line) => !plain(line, 2048))) throw new Error('Invalid purchase item');
        }
      }
      this.features.menu = menu;
      this.emit('purchaseMenu', menu); return;
    }
    if (frame.kind === 'observation') {
      if (!this.monitorEnabled) throw new Error('Observation capability not negotiated');
      const event = validateObservation(frame.event);
      // Older mods still send menu traffic; ignore it before the command-log budget.
      if (event.type !== 'command') return;
      const now = this.now();
      if (now - this.observationWindow >= 1000 || now < this.observationWindow) {
        this.observationWindow = now; this.observationCount = 0;
      }
      if (++this.observationCount <= 21) this.emit('observation', event);
      return;
    }
    if (frame.kind === 'result') {
      const item = this.requests.get(frame.id);
      if (!item) return;
      this.requests.delete(frame.id); clearTimeout(item.timer);
      item.resolve({ ok: frame.ok === true, error: plain(frame.error, 256) ? frame.error : 'Game did not confirm dispatch' });
      return;
    }
    if (frame.kind === 'players') {
      if (!Array.isArray(frame.players) || frame.players.length > 4096) throw new Error('Invalid player list');
      this.players = frame.players.filter((p) => p && /^[A-Za-z0-9_]{1,16}$/.test(p.name || ''))
        .map((p) => ({ name: p.name, uuid: plain(p.uuid, 64) ? p.uuid : '',
          latency: Number.isInteger(p.latency) && p.latency >= 0 ? p.latency : null }));
      this.emit('players', this.players);
      return;
    }
    if (frame.kind !== 'chat') throw new Error('Unknown bridge frame');
    if (!['system', 'player', 'actionbar'].includes(frame.source)
      || !Array.isArray(frame.runs) || frame.runs.length > 2048) throw new Error('Invalid bridge chat');
    let length = 0;
    const segments = frame.runs.flatMap((run) => {
      if (!run || typeof run.text !== 'string' || /[\0]/.test(run.text)) throw new Error('Invalid chat segment');
      length += run.text.length;
      if (length > 65536) throw new Error('Oversized bridge chat');
      const part = { text: run.text };
      if (/^#[a-f0-9]{6}$/i.test(run.color || '')) part.color = run.color;
      for (const flag of ['bold', 'italic', 'underlined', 'strikethrough']) if (run[flag] === true) part[flag] = true;
      if (plain(run.hover, 2048)) part.hover = run.hover;
      const click = clickAction(run.click);
      // Player and actionbar messages never register executable server actions.
      if (click && frame.source === 'system') {
        if (click.action !== 'run_command') part.click = click;
        else if (SESSION.test(run.click.remoteId || '')) {
          part.click = { ...click, remoteId: run.click.remoteId };
          this.remoteActions.set(run.click.remoteId, { value: click.value, session: this.session, t: Date.now() });
        }
      }
      const { click: action, hover, ...display } = part;
      return componentToRuns(display, { noEvents: true }).map((piece) => ({ ...piece,
        ...(action ? { click: action } : {}), ...(hover ? { hover } : {}) }));
    });
    if (segments.length > 2048) throw new Error('Too many normalized chat segments');
    while (this.remoteActions.size > 4096) this.remoteActions.delete(this.remoteActions.keys().next().value);
    this.stats.chats++;
    const sourcePlayer = this.players.find((p) => p.uuid && p.uuid.toLowerCase() === String(frame.sender || '').toLowerCase());
    const sender = /^[A-Za-z0-9_]{1,16}$/.test(frame.sender || '') ? frame.sender : sourcePlayer?.name || null;
    this.emit('chat', segments.map((r) => r.text).join(''), { segments, type: frame.source,
      origin: frame.source === 'player' ? 'player' : 'server', sender,
      uuid: SESSION.test(frame.sender || '') ? frame.sender : null });
  }

  request(payload) {
    if (this.state !== 'play' || this.socket.destroyed) return Promise.resolve({ ok: false, error: 'Game is not online' });
    if (this.requests.size >= 32) return Promise.resolve({ ok: false, error: 'Too many pending bridge requests' });
    const now = this.now();
    const expiresAt = payload.expiresAt === undefined ? now + this.requestTimeout
      : Math.min(payload.expiresAt, now + this.requestTimeout);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) {
      return Promise.resolve({ ok: false, error: 'Command dispatch deadline expired' });
    }
    const id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.requests.delete(id);
        resolve({ ok: false, error: 'Game dispatch not confirmed; no retry' });
      }, this.requestTimeout);
      this.requests.set(id, { resolve, timer, session: this.session, control: payload.control });
      if (!this.send({ kind: 'execute', id, session: this.session, link: this.link,
        ...payload, expiresAt })) {
        this.requests.delete(id); clearTimeout(timer);
        resolve({ ok: false, error: 'Bridge connection closed' });
      }
    });
  }

  activateAction(action, { automatic = false } = {}) {
    const entry = this.remoteActions.get(action.remoteId);
    if (!entry || entry.session !== this.session || entry.value !== action.value || Date.now() - entry.t > 120000) {
      return Promise.resolve({ ok: false, error: 'Server action expired' });
    }
    for (const [id, candidate] of this.remoteActions) if (candidate.value === entry.value) this.remoteActions.delete(id);
    return this.request({ actionId: action.remoteId, automatic });
  }

  say(value) { return this.request({ manual: 'chat', value }); }
  getPlayers() { return this.players; }
  disconnectGame(player) {
    if (!this.disconnectEnabled) return Promise.resolve({ ok: false, error: '桥接 Mod 不支持游戏下线，请更新至 1.5.0' });
    if (!/^[A-Za-z0-9_]{1,16}$/.test(player || '')) return Promise.resolve({ ok: false, error: '下线目标 ID 无效' });
    return this.request({ control: 'disconnect', player });
  }
  openServerMenu() {
    if (!this.purchaseMenusEnabled || this.features.menu) return Promise.resolve({ ok: false, error: '桥接菜单能力不可用或已有界面打开' });
    this.purchaseOpening = true;
    return this.request({ purchase: 'open', automatic: true }).finally(() => { this.purchaseOpening = false; });
  }
  cancelServerMenuOpen() {
    if (!this.purchaseOpening) return;
    this.purchaseOpening = false;
    this.request({ purchase: 'cancelOpen', automatic: true }).catch(() => {});
  }
  clickMenu(request) {
    const menu = this.features.menu;
    if (!this.purchaseMenusEnabled || !menu || menu.cursor || menu.pending || request.button !== 0
      || request.id !== menu.id || request.token !== menu.token || request.revision !== menu.revision
      || !navigationAllowed(menu, request.slot)) return Promise.resolve({ ok: false, error: '收购导航菜单已失效' });
    menu.pending = { slot: request.slot };
    return this.request({ purchase: 'navigate', menu: request, automatic: true });
  }
  closeMenu(id, token) {
    const menu = this.features.menu;
    if (!this.purchaseMenusEnabled || !menu || menu.id !== id || menu.token !== token || menu.cursor) return Promise.resolve({ ok: false, error: '菜单已失效' });
    return this.request({ purchase: 'close', menu: { id, token, revision: menu.revision }, automatic: true });
  }
  command(value, { expiresAt } = {}) { return this.request({ manual: 'command', value, expiresAt }); }
  uptimeText() {
    const s = Math.max(0, Math.floor((Date.now() - this.joinedAt) / 1000));
    return Math.floor(s / 3600) + ':' + String(Math.floor(s / 60) % 60).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }
  close() {
    if (this.state === 'closed') return;
    this.state = 'closed'; this.session = null;
    this.players = [];
    this.clearRequests('Bridge connection closed'); this.socket.destroy();
  }
}

class BridgeServer extends EventEmitter {
  constructor(options = {}) {
    super(); this.options = options; this.sockets = new Set(); this.peer = null; this.server = null;
    this.expectedUsername = options.username || '';
    if (this.expectedUsername && !validUsername(this.expectedUsername)) throw new Error('Invalid bridge account');
    this.discovery = null; this.discoveryTimer = null;
    this.generation = 0;
  }

  async start(config) {
    const generation = this.generation;
    try { return await this.listen(config); }
    catch (error) {
      if (error.code !== 'EADDRINUSE' || !this.options.discoveryDirectory || generation !== this.generation) throw error;
      // Keep the exported legacy port/token intact; new mods discover this listener.
      return this.listen({ ...config, port: 0 });
    }
  }

  async listen(config) {
    if (this.server) throw new Error('Bridge already listening');
    const server = net.createServer((socket) => this.accept(socket, config));
    this.server = server;
    try {
      await new Promise((resolve, reject) => {
        const closed = () => reject(new Error('Bridge startup cancelled'));
        server.once('close', closed);
        server.once('error', reject);
        server.listen(config.port, '127.0.0.1', () => {
          server.removeListener('close', closed); server.removeListener('error', reject);
          if (this.server !== server) reject(new Error('Bridge startup cancelled'));
          else resolve();
        });
      });
      server.on('error', (e) => this.emit('fault', e));
      if (this.options.discoveryDirectory) {
        this.discovery = new BridgeDiscovery(this.options.discoveryDirectory, config);
        this.publishDiscovery();
        this.discoveryTimer = setInterval(() => {
          try { this.publishDiscovery(); } catch (error) { this.emit('fault', error); }
        }, 5000);
        this.discoveryTimer.unref();
      }
      return server.address().port;
    } catch (e) {
      if (this.server === server) this.server = null;
      server.close(); this.closeDiscovery(); throw e;
    }
  }

  publishDiscovery() {
    if (this.discovery && this.server?.listening)
      this.discovery.publish(this.server.address().port, this.expectedUsername, !!this.peer);
  }

  closeDiscovery() {
    clearInterval(this.discoveryTimer); this.discoveryTimer = null;
    const discovery = this.discovery; this.discovery = null;
    if (discovery) discovery.close();
  }

  accept(socket, config) {
    if (socket.remoteAddress !== '127.0.0.1' || this.sockets.size >= 8) { socket.destroy(); return; }
    this.sockets.add(socket); socket.setNoDelay(true);
    let buffer = Buffer.alloc(0), peer = null, count = 0, since = Date.now();
    const timeout = setTimeout(() => socket.destroy(), 3000);
    socket.setTimeout(15000, () => socket.destroy());
    const send = (data) => {
      if (socket.destroyed || socket.writableLength > MAX_FRAME * 2) { socket.destroy(); return false; }
      const line = JSON.stringify(data) + '\n';
      if (Buffer.byteLength(line) > MAX_FRAME) return false;
      if (peer) peer.stats.sent += Buffer.byteLength(line);
      socket.write(line); return true;
    };
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(timeout); this.sockets.delete(socket);
      if (peer) peer.close();
      if (this.peer === peer && peer) {
        this.peer = null;
        try { this.publishDiscovery(); } catch (error) { this.emit('fault', error); }
        this.emit('detached', peer);
      }
    });
    socket.on('data', (chunk) => {
      if (peer) peer.stats.received += chunk.length;
      if (Date.now() - since > 1000) { since = Date.now(); count = 0; }
      buffer = Buffer.concat([buffer, chunk]);
      let end;
      try {
        while ((end = buffer.indexOf(10)) >= 0) {
          if (end > MAX_FRAME || ++count > 200) throw new Error('Bridge limits exceeded');
          const frame = JSON.parse(buffer.subarray(0, end).toString('utf8'));
          buffer = buffer.subarray(end + 1);
          if (!peer) {
            if (!frame || frame.kind !== 'hello' || frame.version !== 1 || !sameToken(frame.token, config.token)
              || this.peer) throw new Error('Pairing rejected');
            if (frame.username !== undefined && (!validUsername(frame.username)
              || this.expectedUsername && frame.username.toLowerCase() !== this.expectedUsername.toLowerCase()))
              throw new Error('Bridge account mismatch');
            clearTimeout(timeout);
            const monitorEnabled = frame.features?.outboundMonitor === true;
            const purchaseMenusEnabled = frame.features?.purchaseMenus === true;
            const disconnectEnabled = frame.features?.disconnectGame === true;
            const offlineStateEnabled = frame.features?.offlineState === true;
            peer = new BridgeClient(socket, send, { ...this.options, monitorEnabled, purchaseMenusEnabled, disconnectEnabled, offlineStateEnabled }); this.peer = peer;
            if (frame.username) this.expectedUsername = frame.username;
            this.publishDiscovery();
            send({ kind: 'welcome', version: 1, link: peer.link,
              features: { outboundMonitor: monitorEnabled, purchaseMenus: purchaseMenusEnabled, disconnectGame: disconnectEnabled,
                offlineState: offlineStateEnabled } }); this.emit('attached', peer);
          } else {
            if (frame.kind === 'state' && frame.online === true) {
              if (this.expectedUsername && (!validUsername(frame.username)
                || frame.username.toLowerCase() !== this.expectedUsername.toLowerCase())) throw new Error('Bridge account mismatch');
              peer.receive(frame);
              if (!this.expectedUsername) { this.expectedUsername = peer.username; this.publishDiscovery(); }
            } else peer.receive(frame);
          }
        }
        if (buffer.length > MAX_FRAME) throw new Error('Oversized bridge frame');
      } catch (_) { socket.destroy(); }
    });
  }

  async stop() {
    this.generation++;
    const server = this.server; this.server = null;
    let discoveryError;
    try { this.closeDiscovery(); } catch (error) { discoveryError = error; }
    for (const socket of this.sockets) socket.destroy();
    if (this.peer) this.peer.close();
    this.peer = null;
    if (server) await new Promise((resolve) => server.close(resolve));
    if (discoveryError) throw discoveryError;
  }
}

module.exports = { BridgeServer, BridgeClient, pairing, MAX_FRAME };
