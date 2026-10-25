'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function parsePresence(text, type = 'system') {
  if (type !== 'system') return null;
  const match = String(text || '').replace(/\u00a7./g, '').trim()
    .match(/^\[([+-])\]\s*([A-Za-z0-9_]{1,16})\s*$/);
  return match ? { kind: match[1] === '+' ? 'join' : 'leave', name: match[2] } : null;
}

function serverKey(host, port = 25565) { return String(host).trim().toLowerCase() + ':' + port; }

class PresenceStore {
  constructor(file, { now = Date.now, onError = () => {}, persistHistory = true } = {}) {
    this.file = file;
    this.now = now;
    this.onError = onError;
    this.persistHistory = persistHistory !== false;
    this.events = null;
    this.pending = [];
    this.session = null;
    this.lastError = '';
    this.warning = '';
    this.online = new Map();
    this.listKnown = false;
  }

  load() {
    if (this.events) return;
    this.events = [];
    try {
      if (!fs.existsSync(this.file)) return;
      const lines = fs.readFileSync(this.file, 'utf8').split(/\r?\n/);
      const seen = new Set();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (!event || !['start', 'end', 'join', 'leave', 'seen', 'unlisted'].includes(event.kind)
            || typeof event.server !== 'string' || typeof event.session !== 'string'
            || !Number.isFinite(event.t)
            || (['join', 'leave', 'seen', 'unlisted'].includes(event.kind) && !/^[A-Za-z0-9_]{1,16}$/.test(event.name))) throw new Error('invalid');
          if (!event.id || !seen.has(event.id)) this.events.push(event);
          if (event.id) seen.add(event.id);
        } catch (_) { this.warning = '部分在线记录损坏，已跳过；原始文件未删除。'; }
      }
    } catch (e) { this.reportError(e); }
  }

  reportError(e) {
    const message = '在线记录保存或读取失败：' + e.message;
    if (message !== this.lastError) this.onError(message);
    this.lastError = message;
  }

  append(event) {
    if (!this.persistHistory) return;
    this.load();
    event.id = crypto.randomUUID();
    this.events.push(event);
    this.pending.push(event);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // A leading newline isolates a truncated last record after an abnormal exit.
      fs.appendFileSync(this.file, '\n' + this.pending.map((item) => JSON.stringify(item)).join('\n') + '\n', 'utf8');
      this.pending = [];
      this.lastError = '';
    } catch (e) { this.reportError(e); }
  }

  start(host, port) {
    this.end();
    this.session = { server: serverKey(host, port), session: crypto.randomUUID() };
    this.online.clear(); this.listKnown = false;
    this.append({ ...this.session, kind: 'start', t: this.now() });
  }

  end() {
    if (!this.session) return;
    this.append({ ...this.session, kind: 'end', t: this.now() });
    this.session = null;
    this.online.clear(); this.listKnown = false;
  }

  record(text, type) {
    const parsed = parsePresence(text, type);
    if (parsed && this.session) {
      this.append({ ...this.session, ...parsed, text: String(text), t: this.now() });
      const existing = this.online.get(parsed.name.toLowerCase());
      if (existing && parsed.kind === 'join' && !existing.startKnown) { existing.observedSince = this.now(); existing.startKnown = true; }
      if (!existing && parsed.kind === 'join') this.online.set(parsed.name.toLowerCase(),
        { name: parsed.name, observedSince: this.now(), startKnown: true });
      if (parsed.kind === 'leave') this.online.delete(parsed.name.toLowerCase());
    }
    return parsed;
  }

  updatePlayers(players) {
    if (!this.session || !Array.isArray(players)) return;
    const next = new Map();
    for (const player of players.slice(0, 4096)) {
      if (!player || !/^[A-Za-z0-9_]{1,16}$/.test(player.name)) continue;
      const key = player.name.toLowerCase();
      const prior = this.online.get(key);
      next.set(key, { name: player.name, uuid: player.uuid, latency: player.latency,
        displayName: player.displayName, observedSince: prior ? prior.observedSince : this.now(),
        startKnown: prior ? prior.startKnown : false });
      if (!prior) this.append({ ...this.session, kind: 'seen', name: player.name, uuid: player.uuid, t: this.now() });
    }
    for (const [key, player] of this.online) {
      if (!next.has(key)) this.append({ ...this.session, kind: 'unlisted', name: player.name, t: this.now() });
    }
    this.online = next; this.listKnown = true;
  }

  getOnline() {
    return { known: !!this.session && this.listKnown, server: this.session && this.session.server,
      players: [...this.online.values()].map((player) => ({ ...player })) };
  }

  query(input = {}) {
    const { host, port, name } = input && typeof input === 'object' ? input : {};
    if (typeof host !== 'string' || !host.trim() || host.length > 255
      || (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535))
      || typeof name !== 'string' || !/^[A-Za-z0-9_]{1,16}$/.test(name.trim())) {
      return { ok: false, error: '请选择服务器，并输入有效的玩家名。' };
    }
    this.load();
    const server = serverKey(host, port);
    const needle = name.trim().toLowerCase();
    const rows = [];
    let open = null, totalMs = 0, observedMs = 0, complete = 0, eventCount = 0;
    for (const event of this.events) {
      if (event.server !== server) continue;
      if (event.kind === 'end' || event.kind === 'start') {
        if (open) { rows.push({ ...open, end: event.kind === 'end' ? event.t : null, status: 'interrupted', duration: null }); open = null; }
        continue;
      }
      if (event.name.toLowerCase() !== needle) continue;
      eventCount++;
      if (open && open.session !== event.session) {
        rows.push({ ...open, end: null, status: 'interrupted', duration: null });
        open = null;
      }
      if (event.kind === 'join' || event.kind === 'seen') {
        // A duplicate notification is not a second login or a new duration.
        if (!open) open = { start: event.t, name: event.name, session: event.session, startKnown: event.kind === 'join' };
        else if (event.kind === 'join' && !open.startKnown) {
          rows.push({ ...open, end: event.t, status: 'observed-only', duration: Math.max(0, event.t - open.start) });
          observedMs += Math.max(0, event.t - open.start);
          open = { start: event.t, name: event.name, session: event.session, startKnown: true };
        }
      } else if (open) {
        const duration = Math.max(0, event.t - open.start);
        const exact = open.startKnown && event.kind === 'leave';
        rows.push({ ...open, end: event.t, status: exact ? 'complete' : 'observed-only', duration });
        if (exact) { totalMs += duration; complete++; }
        else observedMs += duration;
        open = null;
      } else rows.push({ start: null, end: event.t, name: event.name, status: 'unknown-start', duration: null });
    }
    if (open) rows.push({ ...open, end: null, status: this.session && open.session === this.session.session
      ? 'observed-online' : 'interrupted', duration: null,
      observedDuration: this.session && open.session === this.session.session ? Math.max(0, this.now() - open.start) : null });
    return { ok: true, server, name: name.trim(), totalMs, observedMs, complete, eventCount,
      totalRows: rows.length, rows: rows.reverse().slice(0, 200), warning: this.lastError || this.warning };
  }
}

module.exports = { PresenceStore, parsePresence, serverKey };
