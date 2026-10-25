'use strict';

const fs = require('fs');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const DAILY_LIMIT = 10;
const DEFAULT_DELAY = { minMs: 400, maxMs: 850 };
const ANNOUNCEMENT = /^\s*(?:\[[^\]\r\n]{1,24}\]\s*)?\u65b0\u73a9\u5bb6\s*([A-Za-z0-9_]{1,16})\s*\u52a0\u5165\u4e86[^\r\n]{1,120}?[!\uff01]/;
const LABEL = '\u70b9\u51fb\u6b22\u8fce';

function localDay(time) {
  const date = new Date(time);
  if (!Number.isFinite(date.getTime())) throw new Error('\u672c\u5730\u65e5\u671f\u65e0\u6548');
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0')
    + '-' + String(date.getDate()).padStart(2, '0');
}

function welcomeCandidate(message) {
  if (!message || message.type !== 'system' || message.origin === 'player') return null;
  const announcement = ANNOUNCEMENT.exec(String(message.text || ''));
  if (!announcement) return null;
  const parts = Array.isArray(message.segments) ? message.segments : [];
  const candidates = new Map();
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index], click = part.click;
    if (!click || !click.id || click.action !== 'run_command' || typeof click.value !== 'string'
      || !/^\/[^\s/]/.test(click.value) || click.value.length > 2048 || /[\x00-\x1f\x7f]/.test(click.value)) continue;
    let label = String(part.text || '');
    while (index + 1 < parts.length && parts[index + 1].click
      && parts[index + 1].click.action === click.action && parts[index + 1].click.value === click.value) {
      label += String(parts[++index].text || '');
    }
    if (label.includes(LABEL)) candidates.set(click.value, { ...click, newcomer: announcement[1] });
  }
  return candidates.size === 1 ? [...candidates.values()][0] : null;
}

class WelcomeBudget {
  constructor(file, { now = Date.now } = {}) { this.file = file; this.now = now; }

  read(day) {
    if (!fs.existsSync(this.file)) return { version: 1, day, count: 0, keys: [] };
    const state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (!state || state.version !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(state.day)
      || !Number.isInteger(state.count) || state.count < 0 || state.count > DAILY_LIMIT
      || !Array.isArray(state.keys) || state.keys.length !== state.count
      || new Set(state.keys).size !== state.keys.length || state.keys.some((key) => !/^[a-f0-9]{64}$/.test(key))) {
      throw new Error('\u6bcf\u65e5\u6b22\u8fce\u8ba1\u6570\u635f\u574f\uff0c\u5df2\u505c\u6b62\u81ea\u52a8\u6b22\u8fce');
    }
    if (day < state.day) throw new Error('\u672c\u5730\u65e5\u671f\u56de\u9000\uff0c\u5df2\u505c\u6b62\u81ea\u52a8\u6b22\u8fce');
    return day > state.day ? { version: 1, day, count: 0, keys: [] } : state;
  }

  reserve(key) {
    const day = localDay(this.now());
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const lock = this.file + '.lock';
    // A short exclusive transaction prevents two app instances sharing an eleventh slot.
    let descriptor;
    try { descriptor = fs.openSync(lock, 'wx'); }
    catch (e) {
      if (e.code === 'EEXIST') throw new Error('\u6b22\u8fce\u8ba1\u6570\u9501\u88ab\u5360\u7528\uff0c\u672c\u6761\u672a\u81ea\u52a8\u6b22\u8fce');
      throw e;
    }
    try {
      const state = this.read(day);
      if (state.keys.includes(key)) return { status: 'duplicate', day, count: state.count };
      if (state.count >= DAILY_LIMIT) return { status: 'limited', day, count: state.count };
      state.count++; state.keys.push(key);
      fs.writeFileSync(this.file + '.tmp', JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(this.file + '.tmp', this.file);
      // Persist before dispatch. A crash or uncertain send never refunds an allowance.
      return { status: 'reserved', day, count: state.count };
    } finally {
      fs.closeSync(descriptor);
      fs.unlinkSync(lock);
    }
  }
}

class WelcomeAutomation {
  constructor({ actions, budget, onRecord = () => {}, onTrace = () => {}, onAction = () => {}, now = Date.now,
    setTimer = setTimeout, clearTimer = clearTimeout, random = Math.random }) {
    Object.assign(this, { actions, budget, onRecord, onTrace, onAction, now, setTimer, clearTimer, random });
    this.notices = new Set(); this.noticeDay = ''; this.scheduled = new Map();
  }

  cancelScheduled() {
    for (const entry of this.scheduled.values()) {
      this.clearTimer(entry.timer); entry.resolve(false);
    }
    this.scheduled.clear();
  }

  cancelCommand(value, session) {
    for (const [id, entry] of this.scheduled) {
      if (entry.value !== value || entry.session !== session) continue;
      this.clearTimer(entry.timer); this.scheduled.delete(id); entry.resolve(false);
    }
  }

  record(status, detail, extra = {}) {
    const record = { status, detail, t: this.now(), ...extra };
    this.onTrace(record);
    if (status !== 'detected' && !extra.traceOnly) this.onRecord(record);
  }

  notice(status, detail) {
    const day = localDay(this.now());
    if (day !== this.noticeDay) { this.noticeDay = day; this.notices.clear(); }
    if (this.notices.has(status)) return;
    this.notices.add(status); this.record(status, detail);
  }

  async handle(message, client, { enabled, serverKey = '', delay, delayEnabled = true, isCurrent = () => true } = {}) {
    const candidate = welcomeCandidate(message);
    if (!candidate) return null;
    const trace = { traceId: message.messageId || randomUUID(), messageId: message.messageId,
      session: message.session, serverKey, account: client && client.username };
    const report = (status, detail, extra = {}) => this.record(status, detail, { ...trace, ...extra });
    if (!enabled || !client || client.state !== 'play' || message.session !== this.actions.session) {
      report('skipped', '功能关闭、已暂停或连接会话不可用', { traceOnly: true }); return null;
    }
    report('detected', '已识别服务器提供的欢迎入口');
    const action = this.actions.actions.get(candidate.id);
    if (!action || action.action !== candidate.action || action.value !== candidate.value) return null;
    const time = this.now();
    const day = localDay(time);
    const key = createHash('sha256').update(JSON.stringify([serverKey.toLowerCase(), candidate.newcomer.toLowerCase()])).digest('hex');
    if ([...this.scheduled.values()].some((entry) => entry.key === key && entry.session === message.session)) {
      return { status: 'duplicate' };
    }
    let allowance;
    try {
      const state = this.budget.read(day);
      if (state.keys.includes(key)) allowance = { status: 'duplicate', count: state.count };
      else if (state.count >= DAILY_LIMIT) allowance = { status: 'limited', count: state.count };
    } catch (e) {
      report('failed', '欢迎计数无法读取，未发送', { traceOnly: true });
      this.notice('error', '\u81ea\u52a8\u6b22\u8fce\u672a\u6267\u884c\uff0c\u8ba1\u6570\u65e0\u6cd5\u4fdd\u5b58\uff1a' + e.message);
      return { status: 'failed' };
    }
    const markUsed = () => {
      this.actions.invalidateCommand(candidate.value);
      this.onAction({ session: message.session, action: candidate.action, value: candidate.value,
        used: true, source: 'welcome', count: allowance.count });
    };
    if (allowance && allowance.status === 'duplicate') { markUsed(); report('duplicate', '今日已处理该玩家，不重复发送'); return { status: 'duplicate' }; }
    const limited = () => {
      // Once the daily cap is reached, invalidate every still-visible welcome
      // action in this connection. Otherwise an old button can still dispatch
      // a welcome command manually and look like an automatic overrun.
      if (this.actions && typeof this.actions.invalidateWhere === 'function') {
        this.actions.invalidateWhere((action) => action && action.action === 'run_command'
          && /^\/welcome(?:\s|$)/i.test(action.value || ''));
      } else this.actions.invalidateCommand(candidate.value);
      this.onAction({ session: message.session, action: candidate.action, value: candidate.value,
        used: true, source: 'welcome', limited: true, count: allowance.count });
      this.notice('limited', '\u4eca\u65e5\u81ea\u52a8\u6b22\u8fce\u5df2\u8fbe 10/10\uff0c\u540e\u7eed\u6b22\u8fce\u5165\u53e3\u4e0d\u518d\u81ea\u52a8\u70b9\u51fb');
      report('limited', '今日欢迎额度已用完（10/10）', { traceOnly: true });
      return { status: 'limited' };
    };
    if (allowance && allowance.status === 'limited') return limited();
    const range = delayEnabled ? (validDelay(delay) ? delay : DEFAULT_DELAY) : { minMs: 0, maxMs: 0 };
    const sample = range.maxMs > range.minMs ? Math.min(0.999999999, Math.max(0, Number(this.random()) || 0)) : 0;
    const waitMs = range.minMs + Math.floor(sample * (range.maxMs - range.minMs + 1));
    const cancelled = () => {
      report('cancelled', '欢迎等待已取消或过期，本条不再自动发送');
      return { status: 'cancelled' };
    };
    if (waitMs > 0) {
      report('scheduled', '已识别欢迎入口，随机等待 ' + (waitMs / 1000).toFixed(3) + ' 秒后发送');
      const proceed = await new Promise((resolve) => {
        const entry = { key, session: message.session, value: candidate.value, resolve, timer: null };
        this.scheduled.set(candidate.id, entry);
        entry.timer = this.setTimer(() => {
          if (this.scheduled.get(candidate.id) !== entry) return;
          resolve(true);
        }, waitMs);
      });
      const active = this.scheduled.has(candidate.id);
      this.scheduled.delete(candidate.id);
      if (!proceed || !active || this.now() < time || this.now() > time + waitMs + 2000
        || localDay(this.now()) !== day) return cancelled();
    }
    if (!isCurrent() || client.automationBlocked || client.state !== 'play' || message.session !== this.actions.session
      || !this.actions.actions.has(candidate.id)) return cancelled();
    // Reserve synchronously immediately before dispatch, not while a cancellable
    // timer is waiting. Parallel timers still share the locked daily limit.
    try {
      allowance = this.budget.reserve(key);
    } catch (e) {
      report('failed', '欢迎计数无法保存，未发送', { traceOnly: true });
      this.notice('error', '自动欢迎未执行，计数无法保存：' + e.message);
      return { status: 'failed' };
    }
    if (allowance.status === 'duplicate') { markUsed(); report('duplicate', '今日已处理，不重复发送'); return { status: 'duplicate' }; }
    if (allowance.status === 'limited') return limited();
    try {
      const result = await this.actions.activate(candidate.id, client, undefined, { automatic: true });
      markUsed();
      const detail = '\u4eca\u65e5\u81ea\u52a8\u6b22\u8fce ' + allowance.count + '/10\uff1a' + candidate.newcomer;
      report(result.ok ? 'sent' : 'failed', detail + (result.ok
        ? '\uff0c\u5df2\u53d1\u9001\u670d\u52a1\u5668\u6b22\u8fce\u6307\u4ee4\uff08\u7ed3\u679c\u4ee5\u670d\u52a1\u5668\u4e3a\u51c6\uff09'
        : '\uff0c\u672a\u786e\u8ba4\u53d1\u9001\uff1a' + result.error), { count: allowance.count });
      return { status: result.ok ? 'sent' : 'failed', count: allowance.count };
    } catch (e) {
      markUsed();
      report('failed', '\u4eca\u65e5\u81ea\u52a8\u6b22\u8fce ' + allowance.count + '/10\uff0c\u53d1\u9001\u5931\u8d25\uff1a' + e.message);
      return { status: 'failed', count: allowance.count };
    }
  }
}

function validDelay(value) {
  return !!value && Number.isInteger(value.minMs) && Number.isInteger(value.maxMs)
    && value.minMs >= 0 && value.maxMs >= value.minMs && value.maxMs <= 30000;
}

module.exports = { WelcomeAutomation, WelcomeBudget, welcomeCandidate, localDay, DAILY_LIMIT,
  validWelcomeDelay: validDelay, normalizeWelcomeDelay: (value) => validDelay(value)
    ? { minMs: value.minMs, maxMs: value.maxMs } : { ...DEFAULT_DELAY } };
