'use strict';

const { createHash, randomUUID } = require('crypto');
const { parseRedPacket } = require('./red_packet_batch');
const CLAIM_COUNT_WINDOW_MS = 10000;
const PREFIX = /^\s*[\[\u3010]\u7ea2\u5305[\]\u3011]/;
const CLAIM = /\u70b9\u51fb\u9886\u53d6|\u8f93\u5165\u53e3\u4ee4\u9886\u53d6|\u9886\u53d6\u7ea2\u5305|\u62a2\u7ea2\u5305/;

function validClaimDelay(value) {
  return !!value && Number.isInteger(value.minMs) && Number.isInteger(value.maxMs)
    && value.minMs >= 0 && value.maxMs >= value.minMs && value.maxMs <= 30000;
}

function normalizeClaimDelay(value) {
  return validClaimDelay(value) ? { minMs: value.minMs, maxMs: value.maxMs } : { minMs: 400, maxMs: 850 };
}

function validClaimAfter(value) {
  return !!value && typeof value.enabled === 'boolean' && Number.isInteger(value.count)
    && value.count >= 1 && value.count <= 1000;
}

function normalizeClaimTrigger(value = {}) {
  const input = value && typeof value === 'object' ? value : {};
  const after = input.claimAfter;
  const claimAfter = validClaimAfter(after) ? { enabled: after.enabled, count: after.count } : { enabled: false, count: 2 };
  return { claimAfter, claimDelayEnabled: claimAfter.enabled ? false : input.claimDelayEnabled !== false };
}

function chatCategory(text, type) {
  if (type === 'player' || type === 'mine') return 'player';
  if (PREFIX.test(text)) return 'redpacket';
  return type === 'actionbar' ? 'actionbar' : 'system';
}

function claimCandidate(message) {
  if (!message || !PREFIX.test(message.text) || message.type === 'player' || message.type === 'mine'
    || message.origin === 'player') return null;
  const parts = Array.isArray(message.segments) ? message.segments : [];
  // Only the final visible action in a server announcement can claim a packet.
  const end = parts.findLastIndex((part) => String(part.text || '').trim());
  if (end < 0) return null;
  const last = parts[end], click = last.click;
  if (!click || !click.id || !['run_command', 'suggest_command'].includes(click.action)
    || typeof click.value !== 'string' || !/^\/[^\s/]/.test(click.value) || /[\r\n\0]/.test(click.value)) return null;
  let label = '';
  for (let i = end; i >= 0; i--) {
    const part = parts[i];
    if (!part.click || part.click.action !== click.action || part.click.value !== click.value) break;
    label = String(part.text || '') + label;
  }
  if (!CLAIM.test(label)) return null;
  const publisher = (message.text.match(/^\s*[\[\u3010]\u7ea2\u5305[\]\u3011]\s*\u73a9\u5bb6\s+(\S+)\s+\u53d1\u9001/) || [])[1] || '';
  return { ...click, publisher };
}

class RedPacketAutomation {
  constructor({ actions, onRecord = () => {}, onTrace = () => {}, onAction = () => {}, now = Date.now,
    setTimer = setTimeout, clearTimer = clearTimeout, random = Math.random }) {
    Object.assign(this, { actions, onRecord, onTrace, onAction, now, setTimer, clearTimer, random });
    this.seen = new Map();
    this.rate = [];
    this.pending = new Map();
    this.scheduled = new Map();
  }

  record(status, detail, extra = {}) {
    const record = { status, detail, t: this.now(), ...extra };
    this.onTrace(record);
    if (status !== 'detected' && !extra.traceOnly) this.onRecord(record);
  }

  resetPending() {
    this.cancelScheduled();
    for (const entry of this.pending.values()) this.clearTimer(entry.timer);
    this.pending.clear();
  }

  cancelScheduled() {
    for (const entry of this.scheduled.values()) {
      this.clearTimer(entry.timer); entry.resolve(false);
      if (entry.trace) this.record('cancelled', '等待已取消，不补发', entry.trace);
    }
    this.scheduled.clear();
  }

  cancelCommand(value, session) {
    for (const [id, entry] of this.scheduled) {
      if (entry.value !== value || entry.session !== session) continue;
      this.clearTimer(entry.timer); this.scheduled.delete(id); entry.resolve(false);
      if (entry.trace) this.record('cancelled', '已手动处理，不重复发送', entry.trace);
    }
  }

  observeClaims(parsed, candidate, message, client, serverKey) {
    const time = this.now();
    for (const [id, entry] of this.scheduled) {
      if (entry.mode !== 'count' || entry.client !== client || entry.serverKey !== serverKey
        || entry.session !== message.session || entry.publisher.toLowerCase() !== parsed.publisher.toLowerCase()) continue;
      const cancel = (detail) => {
        this.clearTimer(entry.timer); this.scheduled.delete(id); entry.resolve(false);
        this.record('cancelled', detail, entry.trace);
      };
      if (parsed.kind === 'start') {
        // Broadcasts have no packet ID: a new entry from the same sender supersedes the old wait.
        if (!candidate || candidate.value !== entry.value) cancel('同一发送者出现新红包，取消上一批人数等待');
        continue;
      }
      if (time < entry.createdAt || time >= entry.expiresAt) {
        cancel('10 秒内未达到指定领取人数，已跳过，不补发'); continue;
      }
      const claimant = parsed.claimant.toLowerCase();
      if (claimant === String(client.username || '').toLowerCase()) {
        cancel('已观察到本账号领取，取消人数等待'); continue;
      }
      if (entry.triggered) continue;
      if (entry.claimants.has(claimant)) continue;
      entry.claimants.add(claimant);
      if (entry.claimants.size < entry.count) continue;
      this.clearTimer(entry.timer); entry.triggered = true;
      entry.dispatchBy = time + 2000;
      this.record('triggered', '已观察到 ' + entry.count + ' 位不同玩家领取，立即领取', entry.trace);
      entry.resolve(true);
    }
  }

  feedback(message, client, serverKey) {
    if (!PREFIX.test(message.text) || message.type === 'player' || message.origin === 'player') return;
    const own = client && client.username;
    const body = message.text.replace(PREFIX, '').trim();
    const personal = /^(\u4f60|\u60a8)(?=\s|\u5df2|\u6210\u529f|\u9886\u53d6|\u62a2)/.test(body)
      || !!own && (body.startsWith(own + ' ') || body.startsWith(own + '\u9886\u53d6'));
    const success = personal && /\u9886\u53d6\u4e86|\u9886\u53d6\u6210\u529f|\u6210\u529f\u9886\u53d6|\u62a2\u5230/.test(body);
    const failed = /\u7ea2\u5305.*(\u5df2\u88ab\u62a2\u5b8c|\u5df2\u8fc7\u671f|\u4e0d\u5b58\u5728)|\u53e3\u4ee4\u9519\u8bef|\u4f60.*\u5df2\u7ecf\u9886\u53d6/.test(body);
    if (!success && !failed) return;
    const publisher = (body.match(/\u9886\u53d6\u4e86\s+(\S+)\s+\u53d1\u9001/) || [])[1];
    const entry = [...this.pending.values()].find((item) => item.serverKey === serverKey
      && item.session === message.session && (!publisher || !item.publisher || publisher === item.publisher));
    if (!entry) return;
    this.clearTimer(entry.timer);
    this.pending.delete(entry.id);
    const amount = (body.match(/\u91d1\u989d[\uff1a:]\s*([^\uff0c\u3002!\uff01]{1,60})/) || [])[1];
    this.record(success ? 'confirmed' : 'rejected', success
      ? '\u670d\u52a1\u5668\u786e\u8ba4\u9886\u53d6' + (amount ? '\uff0c\u91d1\u989d\uff1a' + amount.trim() : '')
      : '\u670d\u52a1\u5668\u8fd4\u56de\u672a\u9886\u53d6\uff1a' + body.slice(0, 120), { id: entry.id, ...entry.trace });
  }

  async handle(message, client, { enabled, serverKey = '', delay, delayEnabled = true, afterClaims, isCurrent = () => true } = {}) {
    this.feedback(message, client, serverKey);
    const candidate = claimCandidate(message);
    const trace = { traceId: message.messageId || randomUUID(), messageId: message.messageId,
      session: message.session, serverKey, account: client && client.username };
    const report = (status, detail, extra = {}) => this.record(status, detail, { ...trace, ...extra });
    if (candidate && (!enabled || !client || client.state !== 'play' || message.session !== this.actions.session)) {
      report('skipped', '功能关闭、已暂停或连接会话不可用', { traceOnly: true }); return null;
    }
    if (!enabled || !client || client.state !== 'play' || message.session !== this.actions.session) return null;
    const trigger = normalizeClaimTrigger({ claimDelayEnabled: delayEnabled, claimAfter: afterClaims });
    const parsed = trigger.claimAfter.enabled ? parseRedPacket(message.text, message.type, message.origin) : null;
    if (parsed) this.observeClaims(parsed, candidate, message, client, serverKey);
    if (!candidate) return null;
    report('detected', '已识别服务器提供的红包入口');
    const time = this.now();
    for (const [key, item] of this.seen) if (time - item.t > 120000) this.seen.delete(key);
    const key = createHash('sha256').update(JSON.stringify([serverKey, message.text, candidate.action, candidate.value])).digest('hex');
    const prior = this.seen.get(key);
    if (prior) {
      report('duplicate', '已观察到重复入口，不重复提交', { traceOnly: true });
      if (prior.sent) {
        this.actions.invalidateCommand(candidate.value);
        this.onAction({ session: message.session, action: 'run_command', value: candidate.value, used: true });
      }
      return { status: 'duplicate' };
    }
    const seen = { t: time, sent: false };
    this.seen.set(key, seen);
    while (this.seen.size > 1024) this.seen.delete(this.seen.keys().next().value);
    this.rate = this.rate.filter((t) => time - t < 60000);
    if (this.rate.length >= 10) {
      report('limited', '\u7ea2\u5305\u6d88\u606f\u8fc7\u4e8e\u9891\u7e41\uff0c\u672c\u6761\u4e0d\u81ea\u52a8\u70b9\u51fb');
      return { status: 'limited' };
    }
    this.rate.push(time);
    if (candidate.action === 'run_command') {
      if (trigger.claimAfter.enabled) {
        if (!candidate.publisher || !parsed || parsed.kind !== 'start') {
          report('skipped', '无法可靠关联红包发送者，本条不按人数自动领取'); return { status: 'skipped' };
        }
        if ([...this.scheduled.values()].some((entry) => entry.mode === 'count' && entry.client === client
          && entry.serverKey === serverKey && entry.session === message.session && entry.value === candidate.value)) {
          return { status: 'duplicate' };
        }
        const entry = { mode: 'count', value: candidate.value, session: message.session, serverKey, client,
          publisher: candidate.publisher, count: trigger.claimAfter.count, claimants: new Set(),
          createdAt: time, expiresAt: time + CLAIM_COUNT_WINDOW_MS, dispatchBy: 0, resolve: null, timer: null, trace };
        report('waiting-count', '已识别红包，等待第 ' + entry.count + ' 位不同玩家领取后立即领取（不使用随机延迟）');
        const proceed = await new Promise((resolve) => {
          entry.resolve = resolve; this.scheduled.set(candidate.id, entry);
          entry.timer = this.setTimer(() => {
            if (this.scheduled.get(candidate.id) !== entry || entry.triggered) return;
            this.scheduled.delete(candidate.id); resolve(false);
            report('skipped', '10 秒内未达到指定领取人数，已跳过，不补发');
          }, CLAIM_COUNT_WINDOW_MS);
        });
        const stillWaiting = this.scheduled.get(candidate.id) === entry;
        if (stillWaiting) this.scheduled.delete(candidate.id);
        if (!proceed || !stillWaiting || this.now() > entry.dispatchBy || this.now() < entry.createdAt) {
          report('cancelled', '人数等待结束或会话已变化，不补发'); return { status: 'cancelled' };
        }
      }
      const range = trigger.claimAfter.enabled || !trigger.claimDelayEnabled ? { minMs: 0, maxMs: 0 } : normalizeClaimDelay(delay);
      const sample = range.maxMs > range.minMs ? Math.min(0.999999999, Math.max(0, Number(this.random()) || 0)) : 0;
      const waitMs = range.minMs + Math.floor(sample * (range.maxMs - range.minMs + 1));
      if (waitMs > 0) {
        report('scheduled', '已识别红包，随机等待 ' + (waitMs / 1000).toFixed(3) + ' 秒后领取');
        const deadline = time + waitMs + 2000;
        const proceed = await new Promise((resolve) => {
          const entry = { value: candidate.value, session: message.session, resolve, timer: null, trace };
          this.scheduled.set(candidate.id, entry);
          entry.timer = this.setTimer(() => {
            if (this.scheduled.get(candidate.id) !== entry) return;
            this.scheduled.delete(candidate.id); resolve(true);
          }, waitMs);
        });
        if (!proceed || this.now() > deadline) { report('cancelled', '等待已取消或过期，不补发'); return { status: 'cancelled' }; }
      }
      if (client.state !== 'play' || message.session !== this.actions.session || client.automationBlocked
        || !isCurrent() || !this.actions.actions.has(candidate.id)) {
        report('cancelled', '连接、配置或入口已变化，不补发'); return { status: 'cancelled' };
      }
    }
    let entry = null;
    if (candidate.action === 'run_command') {
      const id = randomUUID();
      entry = { id, serverKey, session: message.session, publisher: candidate.publisher, timer: null, trace };
      this.pending.set(id, entry);
    }
    const forget = () => {
      if (entry) { this.clearTimer(entry.timer); this.pending.delete(entry.id); }
    };
    try {
      // ChatActions consumes commands synchronously before its first await.
      const result = await this.actions.activate(candidate.id, client, undefined, { automatic: true });
      if (!result.ok) {
        forget();
        report('failed', '\u81ea\u52a8\u70b9\u51fb\u672a\u5b8c\u6210\uff1a' + result.error);
        return { status: 'failed' };
      }
      if (result.action === 'suggest_command') {
        report('suggested', '\u5df2\u70b9\u51fb\u53e3\u4ee4\u5165\u53e3\uff1b\u4ec5\u586b\u5165\u8f93\u5165\u6846\uff0c\u4ecd\u9700\u786e\u8ba4\u53e3\u4ee4\u540e\u624b\u52a8\u53d1\u9001');
        this.onAction({ session: message.session, action: result.action, value: result.value });
        return { status: 'suggested' };
      }
      seen.sent = true;
      this.actions.invalidateCommand(candidate.value);
      this.onAction({ session: message.session, action: result.action, value: result.value, used: true });
      report('sent', '\u5df2\u81ea\u52a8\u53d1\u9001\u9886\u53d6\u6307\u4ee4\uff0c\u7b49\u5f85\u670d\u52a1\u5668\u786e\u8ba4', { command: result.value });
      if (client.state !== 'play' || message.session !== this.actions.session) { forget(); return { status: 'sent' }; }
      if (!this.pending.has(entry.id)) return { status: 'sent' };
      entry.timer = this.setTimer(() => {
        this.pending.delete(entry.id);
        report('unconfirmed', '\u9886\u53d6\u6307\u4ee4\u5df2\u53d1\u9001\uff0c30\u79d2\u5185\u672a\u6536\u5230\u786e\u8ba4\uff0c\u4e0d\u80fd\u786e\u5b9a\u662f\u5426\u5230\u8d26', { id: entry.id });
      }, 30000);
      return { status: 'sent' };
    } catch (e) {
      forget();
      report('failed', '\u81ea\u52a8\u70b9\u51fb\u5931\u8d25\uff1a' + e.message);
      return { status: 'failed' };
    }
  }
}

module.exports = { RedPacketAutomation, chatCategory, claimCandidate, normalizeClaimDelay, validClaimDelay,
  normalizeClaimTrigger, validClaimAfter };
