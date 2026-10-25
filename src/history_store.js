'use strict';

/*
 * Chat, runtime logs and disposable diagnostics live outside the main config
 * directory. Files are split by local day so retention pruning never needs to
 * load a large history file into memory.
 */

const fs = require('fs');
const path = require('path');
const { clickAction } = require('./chat_component');

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 7;
const KINDS = new Set(['chat', 'logs', 'cache', 'events']);
const MAX_PENDING = 2 * 1024 * 1024;
const MAX_DISK = 128 * 1024 * 1024;

function dayKey(timestamp) {
  const d = new Date(Number.isFinite(timestamp) ? timestamp : Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function safeRoot(value, fallback) {
  const candidate = typeof value === 'string' ? value.trim() : '';
  return candidate && path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(fallback);
}

function compactChatSegments(segments) {
  if (!Array.isArray(segments)) return [];
  const out = [];
  let chars = 0;
  for (const part of segments.slice(0, 512)) {
    if (!part || typeof part !== 'object') continue;
    const text = String(part.text == null ? '' : part.text).slice(0, 16384 - chars);
    if (!text && !part.click) continue;
    chars += text.length;
    const item = { text };
    for (const key of ['color', 'bold', 'italic', 'underlined', 'strikethrough', 'hover']) {
      if (part[key] !== undefined) item[key] = part[key];
    }
    const action = clickAction(part.click);
    if (action) {
      item.click = { ...action };
      if (typeof part.click.remoteId === 'string' && part.click.remoteId.length <= 256
        && !/[\r\n\0]/.test(part.click.remoteId)) item.click.remoteId = part.click.remoteId;
    }
    out.push(item);
    if (chars >= 16384) break;
  }
  return out;
}

function compactChat(record) {
  return {
    messageId: typeof (record && record.messageId) === 'string' ? record.messageId : null,
    text: String(record && record.text != null ? record.text : ''),
    type: record && record.type || 'system',
    category: record && record.category || 'system',
    sender: record && record.sender || null,
    uuid: record && record.uuid || null,
    origin: record && record.origin || null,
    session: typeof (record && record.session) === 'string' ? record.session : null,
    serverKey: record && record.serverKey || '',
    account: record && record.account || '',
    segments: compactChatSegments(record && record.segments),
    t: Number.isFinite(record && record.t) ? record.t : Date.now(),
  };
}

class HistoryStore {
  constructor({ root, fallbackRoot, now = Date.now, onError = () => {} } = {}) {
    this.fallbackRoot = path.resolve(fallbackRoot || root || path.join(process.cwd(), 'records'));
    this.root = safeRoot(root, this.fallbackRoot);
    this.now = now;
    this.onError = onError;
    this.pending = new Map();
    this.flushTimer = null;
    this.flushBusy = false;
    this.pendingBytes = 0;
    this.retryAt = 0;
    this.reporting = false;
    this.pruneTimer = null;
    this.ensureRoot();
    this.prune();
    this.pruneTimer = setInterval(() => this.prune(), 60 * 60 * 1000);
    if (this.pruneTimer && typeof this.pruneTimer.unref === 'function') this.pruneTimer.unref();
  }

  path() { return this.root; }

  ensureRoot() {
    for (const kind of KINDS) fs.mkdirSync(path.join(this.root, kind), { recursive: true });
  }

  configure(root) {
    const next = safeRoot(root, this.fallbackRoot);
    if (next === this.root) {
      this.ensureRoot();
      this.prune();
      return this.root;
    }
    this.flushSync();
    this.root = next;
    this.ensureRoot();
    this.prune();
    return this.root;
  }

  append(kind, record, timestamp = Date.now()) {
    if (!KINDS.has(kind)) throw new Error('未知历史类型');
    const value = kind === 'chat' ? compactChat(record) : {
      ...(record && typeof record === 'object' ? record : { text: String(record || '') }),
      t: Number.isFinite(record && record.t) ? record.t : timestamp,
    };
    const file = path.join(this.root, kind, `${dayKey(value.t)}.jsonl`);
    const line = JSON.stringify(value) + '\n';
    const bytes = Buffer.byteLength(line);
    if (this.pendingBytes + bytes > MAX_PENDING) {
      this.report(new Error('待写记录达到 2 MiB 上限，已丢弃新记录；连接继续运行'));
      return;
    }
    this.pending.set(file, (this.pending.get(file) || '') + line);
    this.pendingBytes += bytes;
    if (this.pending.get(file).length >= 512 * 1024) this.flush();
    else this.scheduleFlush();
  }

  appendChat(record) { this.append('chat', record, record && record.t); }

  appendLog(level, text, timestamp = Date.now()) {
    this.append('logs', { level: String(level || 'net'), text: String(text == null ? '' : text), t: timestamp }, timestamp);
  }

  writeCache(name, value) {
    const fileName = String(name || '').replace(/[^A-Za-z0-9_.-]/g, '_');
    if (!fileName) return;
    try {
      const dir = path.join(this.root, 'cache');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, fileName);
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
      fs.renameSync(tmp, file);
    } catch (e) { this.report(e); }
  }

  scheduleFlush() {
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, Math.max(250, this.retryAt - Date.now()));
    if (this.flushTimer && typeof this.flushTimer.unref === 'function') this.flushTimer.unref();
  }

  flush() {
    if (this.flushBusy || !this.pending.size) return;
    if (Date.now() < this.retryAt) { this.scheduleFlush(); return; }
    this.flushBusy = true;
    const batch = this.pending;
    this.pending = new Map();
    this.pendingBytes = 0;
    try {
      for (const [file, text] of batch) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, text, 'utf8');
        this.diskBytes = (this.diskBytes || 0) + Buffer.byteLength(text);
        batch.delete(file);
      }
    } catch (e) {
      for (const [file, text] of batch) {
        this.pending.set(file, text + (this.pending.get(file) || ''));
        this.pendingBytes += Buffer.byteLength(text);
      }
      this.retryAt = Date.now() + 30000;
      this.report(e);
    } finally {
      this.flushBusy = false;
      if (this.diskBytes > MAX_DISK) this.prune();
      if (this.pending.size) this.scheduleFlush();
    }
  }

  flushSync() {
    if (this.flushTimer !== null) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (this.flushBusy) return;
    this.flush();
  }

  read(kind, { before = Infinity, limit = 400, cursor, serverKey, account, messageId } = {}) {
    if (!KINDS.has(kind)) return { records: [], hasMore: false };
    this.flushSync();
    const files = fs.readdirSync(path.join(this.root, kind), { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name))
      .map((entry) => entry.name).sort().reverse();
    const records = [];
    let hasMore = false;
    let nextCursor = null, scanned = 0;
    const cap = 4 * 1024 * 1024;
    const validCursor = cursor && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(cursor.file)
      && Number.isSafeInteger(cursor.offset) && cursor.offset >= 0 ? cursor : null;
    const accept = (line) => {
      try {
        const r = JSON.parse(line.toString('utf8'));
        if (Number.isFinite(r.t) && r.t < before && (!serverKey || r.serverKey === serverKey)
          && (!account || r.account === account) && (!messageId || r.messageId === messageId)) records.push(r);
      } catch (_) {}
    };
    outer: for (const name of files) {
      if (validCursor && name > validCursor.file) continue;
      const file = path.join(this.root, kind, name);
      let fd;
      try {
        fd = fs.openSync(file, 'r');
        let end = Math.min(fs.fstatSync(fd).size, validCursor && name === validCursor.file ? validCursor.offset : Infinity);
        let carry = Buffer.alloc(0), dropping = false;
        while (end > 0) {
          const start = Math.max(0, end - 65536), chunk = Buffer.alloc(end - start);
          fs.readSync(fd, chunk, 0, chunk.length, start); scanned += chunk.length;
          const data = Buffer.concat([chunk, carry]);
          let lineEnd = data.length;
          for (let i = data.length - 1; i >= 0; i--) {
            if (data[i] !== 10) continue;
            const line = data.subarray(i + 1, lineEnd); lineEnd = i;
            if (dropping) { dropping = false; continue; }
            if (!line.length) continue;
            accept(line);
            if (records.length >= Math.max(1, limit)) {
              nextCursor = { file: name, offset: start + i + 1 }; hasMore = true; break outer;
            }
          }
          carry = data.subarray(0, lineEnd);
          if (carry.length > 256 * 1024) { carry = Buffer.alloc(0); dropping = true; }
          end = start;
          if (end === 0 && carry.length && !dropping) accept(carry);
          if (scanned >= cap) { nextCursor = { file: name, offset: end + carry.length }; hasMore = true; break outer; }
        }
      } catch (e) { this.report(e); }
      finally { if (fd !== undefined) fs.closeSync(fd); }
    }
    records.sort((a, b) => (a.t || 0) - (b.t || 0));
    return { records, hasMore, cursor: nextCursor, scanLimited: scanned >= cap };
  }

  prune() {
    try {
      this.ensureRoot();
      const cutoff = this.now() - RETENTION_DAYS * DAY_MS;
      const retained = [];
      for (const kind of KINDS) {
        const dir = path.join(this.root, kind);
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isFile()) continue;
          const file = path.join(dir, entry.name);
          const stat = fs.statSync(file);
          if (stat.mtimeMs < cutoff) fs.rmSync(file, { force: true });
          else retained.push({ file, size: stat.size, t: stat.mtimeMs });
        }
      }
      let total = retained.reduce((n, f) => n + f.size, 0);
      for (const f of retained.sort((a, b) => a.t - b.t)) {
        if (total <= MAX_DISK) break;
        fs.rmSync(f.file, { force: true }); total -= f.size;
      }
      this.diskBytes = total;
    } catch (e) { this.report(e); }
  }

  close() {
    if (this.pruneTimer !== null) { clearInterval(this.pruneTimer); this.pruneTimer = null; }
    this.retryAt = 0;
    this.flushSync();
    if (this.flushTimer !== null) { clearTimeout(this.flushTimer); this.flushTimer = null; }
  }

  report(error) {
    if (this.reporting) return;
    this.reporting = true;
    try { this.onError('历史记录存储失败：' + (error && error.message || error)); } catch (e) {}
    finally { this.reporting = false; }
  }
}

module.exports = { HistoryStore, RETENTION_DAYS, DAY_MS, dayKey, safeRoot, compactChat, compactChatSegments };
