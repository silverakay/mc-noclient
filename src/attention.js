'use strict';

const { randomUUID } = require('crypto');
const { cleanText, extractVisibleSender } = require('./chat_monitor');
const { normalizeNotifications } = require('./server_profiles');

function messageReasons(message, username, players, policy) {
  const p = normalizeNotifications(policy), reasons = [];
  if (!message || message.type === 'mine' || message.type === 'actionbar') return reasons;
  const text = cleanText(message.text);
  const sender = message.sender || extractVisibleSender(text);
  if (sender && sender.toLowerCase() === String(username || '').toLowerCase()) return reasons;
  if (p.players && sender && (players || []).some((name) => name.toLowerCase() === sender.toLowerCase())) reasons.push('指定玩家发言');
  const own = String(username || '');
  if (p.mentions && /^[A-Za-z0-9_]{1,16}$/.test(own)) {
    const body = text.replace(/^[\s\S]*?([A-Za-z0-9_]{1,16})\s*:\s*/, '');
    if (new RegExp('(^|[^A-Za-z0-9_])@?' + own + '(?![A-Za-z0-9_])', 'i').test(body)) reasons.push('提到我');
  }
  return reasons;
}

function quietNow(policy, time) {
  const p = normalizeNotifications(policy);
  if (!p.quiet) return false;
  const d = new Date(time), minute = d.getHours() * 60 + d.getMinutes();
  const parse = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  const start = parse(p.quietStart), end = parse(p.quietEnd);
  return start === end || (start < end ? minute >= start && minute < end : minute >= start || minute < end);
}

class Attention {
  constructor({ now = Date.now, persist = () => {} } = {}) {
    this.now = now; this.persist = persist; this.actions = new Map(); this.items = [];
    this.awaySince = null; this.summary = null; this.counts = this.emptyCounts(); this.unread = 0;
    this.revision = 0; this.notificationStatus = '系统通知未验证'; this.truncated = false;
  }
  emptyCounts() { return { messages: 0, disconnects: 0, gaps: 0, actions: 0 }; }
  away() { if (this.awaySince === null) { this.awaySince = this.now(); this.counts = this.emptyCounts(); } }
  returned() {
    if (this.awaySince === null) return;
    this.summary = { from: this.awaySince, to: this.now(), ...this.counts };
    this.awaySince = null; this.revision++;
  }
  event(kind, detail, context = {}) {
    const event = { id: randomUUID(), kind, detail: String(detail || '').slice(0, 500), ...context, t: this.now() };
    this.persist(event);
    if (this.awaySince !== null && kind === 'disconnect') this.counts.disconnects++;
    if (this.awaySince !== null && kind === 'gap') this.counts.gaps++;
    this.revision++;
    return event;
  }
  important(message, reasons) {
    if (!reasons.length) return;
    const item = { id: message.messageId || randomUUID(), t: message.t || this.now(), text: String(message.text || '').slice(0, 1000),
      messageId: message.messageId, serverKey: message.serverKey, account: message.account, reasons, read: false };
    if (this.items.some((v) => v.id === item.id)) return;
    this.items.push(item); if (this.items.length > 100) { if (!this.items.shift().read) this.unread--; this.truncated = true; }
    this.unread++;
    if (this.awaySince !== null) this.counts.messages++;
    this.event('important', reasons.join('、'), { messageId: item.messageId, serverKey: item.serverKey, account: item.account });
  }
  ingest(feature, record) {
    const id = record.traceId || record.id;
    if (!id) return;
    let action = this.actions.get(id);
    if (!action) {
      action = { id, feature, messageId: record.messageId, serverKey: record.serverKey, account: record.account,
        session: record.session, startedAt: this.now(), transitions: [] };
      this.actions.set(id, action);
      if (this.awaySince !== null) this.counts.actions++;
    }
    action.status = record.status; action.detail = String(record.detail || '').slice(0, 500); action.t = this.now();
    action.transitions.push({ status: action.status, detail: action.detail, t: action.t });
    if (action.transitions.length > 16) action.transitions.shift();
    while (this.actions.size > 300) { this.actions.delete(this.actions.keys().next().value); this.truncated = true; }
    this.event('action', action.detail, { traceId: id, feature, status: action.status, messageId: action.messageId,
      serverKey: action.serverKey, account: action.account });
  }
  cancel(session, detail) {
    for (const a of this.actions.values()) {
      if (a.session === session && ['detected', 'scheduled', 'waiting-count', 'triggered', 'sent'].includes(a.status))
        this.ingest(a.feature, { ...a, traceId: a.id, status: a.status === 'sent' ? 'unconfirmed' : 'cancelled', detail });
    }
  }
  markRead(key = '', ids = null) {
    const selected = ids ? new Set(ids) : null;
    let changed = false;
    for (const item of this.items) {
      if (!item.read && (!key || item.serverKey === key) && (!selected || selected.has(item.id))) {
        item.read = true; this.unread--; changed = true;
      }
    }
    if (changed) this.revision++;
    return changed;
  }
  snapshot(key = '', details = true) {
    return { revision: this.revision, unread: this.unread, summary: this.summary, truncated: this.truncated,
      notificationStatus: this.notificationStatus,
      items: details ? this.items.filter((v) => !key || v.serverKey === key).slice(-100).reverse() : [],
      actions: details ? [...this.actions.values()].filter((v) => !key || v.serverKey === key).slice(-100).reverse() : [] };
  }
}

module.exports = { Attention, messageReasons, quietNow };
