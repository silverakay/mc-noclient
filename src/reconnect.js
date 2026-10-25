'use strict';

function normalizeReconnect(value) {
  const input = value && typeof value === 'object' ? value : {};
  const integer = (n, fallback, min, max) => Number.isInteger(n)
    ? Math.min(max, Math.max(min, n)) : fallback;
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : true,
    delaySeconds: integer(input.delaySeconds, 5, 3, 60),
    maxAttempts: integer(input.maxAttempts, 10, 0, 1000),
  };
}

function isDuplicateLoginReason(reason) {
  return /(duplicate[ ._-]?login|logged in from another location|already (?:logged in|connected)|\u5f02\u5730\u767b\u5f55|\u522b\u5904\u767b\u5f55|\u5176\u4ed6\u5730\u65b9.*\u767b\u5f55|\u8d26\u53f7.*(?:\u5df2\u5728\u7ebf|\u91cd\u590d\u767b\u5f55))/i.test(String(reason || ''));
}

function isRetryableReason(reason) {
  if (isDuplicateLoginReason(reason)) return false;
  return !/(banned|ban[ -]?list|whitelist|not.whitelisted|unverified_username|invalid.session|invalid.public.key|expired.public.key|incompatible|outdated.(client|server)|\u5c01\u7981|\u5c01\u53f7|\u767d\u540d\u5355|\u51ed\u636e.*\u5931\u6548|\u9700\u8981.*\u6388\u6743|\u624b\u52a8\u767b\u5f55|\u5c1a\u672a\u767b\u5f55|\u65e0\u6cd5\u9a8c\u8bc1|\u9a8c\u8bc1.*\u5931\u8d25|\u65e0\u6548.*\u4f1a\u8bdd|\u5ba2\u6237\u7aef.*(\u8fc7\u65e7|\u4e0d\u517c\u5bb9)|\u516c\u94a5.*\u8fc7\u671f|\u65e0\u6548.*\u516c\u94a5)/i.test(String(reason || ''));
}

const MAINTENANCE_CHECK_MS = 5 * 60 * 1000;

function maintenanceWait(reason) {
  const text = String(reason || '').replace(/\u00a7[0-9a-fk-orx]/gi, '');
  if (!/(\u7ef4\u62a4|\u7dad\u8b77|\u68c0\u4fee|\u6aa2\u4fee|\bmaintenance\b)/i.test(text)
    || /(\u7ef4\u62a4|\u7dad\u8b77|\u68c0\u4fee|\u6aa2\u4fee)(?:\u5df2|\u5df2\u7ecf)?(?:\u7ed3\u675f|\u5b8c\u6210)|maintenance\s+(?:is\s+)?(?:over|finished|complete)/i.test(text)) return null;
  let duration = 0;
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*(\u5c0f\u65f6|\u5c0f\u6642|hours?|hrs?|h\b|\u5206\u949f|\u5206\u9418|minutes?|mins?|m\b|\u79d2(?:\u949f|\u9418)?|seconds?|secs?|s\b)/gi)) {
    const unit = match[2].toLowerCase();
    const multiplier = /^(h|\u5c0f)/.test(unit) ? 3600000 : /^(m|\u5206)/.test(unit) ? 60000 : 1000;
    duration += Number(match[1]) * multiplier;
  }
  return duration > 0 && Number.isFinite(duration)
    ? Math.min(24 * 60 * 60 * 1000, Math.ceil(duration)) : MAINTENANCE_CHECK_MS;
}

class ReconnectController {
  constructor({ connect, getSettings, onChange, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now }) {
    this.connect = connect;
    this.getSettings = getSettings;
    this.onChange = onChange;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.now = now;
    this.epoch = 0;
    this.timer = null;
    this.target = null;
    this.armed = false;
    this.attempt = 0;
    this.phase = 'idle';
    this.running = null;
    this.pendingFailure = null;
    this.maintenance = null;
  }

  notify(reason = '', retryAt = null) {
    this.onChange({ phase: this.phase, attempt: this.attempt,
      maxAttempts: normalizeReconnect(this.getSettings()).maxAttempts, reason, retryAt,
      maintenance: this.maintenance !== null,
      target: this.target ? { host: this.target.host, port: this.target.port } : null });
  }

  cancel(reason = '') {
    this.epoch++;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.running = null;
    this.pendingFailure = null;
    this.maintenance = null;
    this.phase = 'idle';
    this.notify(reason);
  }

  stop(reason = '') {
    this.target = null;
    this.armed = false;
    this.attempt = 0;
    this.cancel(reason);
  }

  start(target) {
    this.stop();
    this.target = { host: target.host, port: target.port || 25565,
      username: target.username, usePremium: !!target.usePremium };
    if (target.usePremium && target.accountUuid) this.target.accountUuid = String(target.accountUuid);
  }

  bindAccount(uuid) {
    if (!this.target || !this.target.usePremium || !uuid) return false;
    if (this.target.accountUuid && this.target.accountUuid !== uuid) return false;
    this.target.accountUuid = uuid;
    return true;
  }

  joined() {
    if (!this.target) return;
    this.armed = true;
    this.attempt = 0;
    this.pendingFailure = null;
    this.maintenance = null;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.phase = 'connected';
    this.notify();
  }

  lost(reason = '', retryable = true) {
    if (!retryable || !isRetryableReason(reason)) { this.stop(reason); return false; }
    const maintenance = maintenanceWait(reason);
    if (!this.target || !normalizeReconnect(this.getSettings()).enabled || (!this.armed && maintenance === null)) return false;
    // An explicit maintenance rejection also permits waiting after a manual first login.
    if (maintenance !== null) this.armed = true;
    if (this.running === this.epoch) {
      if (!this.pendingFailure || maintenanceWait(this.pendingFailure.reason) === null) {
        this.pendingFailure = { reason: reason || '\u8fde\u63a5\u4e2d\u65ad', at: this.now() };
      }
      return true;
    }
    if (this.timer !== null) {
      if (this.phase === 'maintenance' || maintenance === null) return true;
      this.clearTimer(this.timer); this.timer = null;
    }
    return this.schedule(reason);
  }

  schedule(reason, observedAt = this.now(), retryable) {
    const settings = normalizeReconnect(this.getSettings());
    if (!this.target || !this.armed || !settings.enabled) return false;
    // Auth can explicitly classify a wrapped login error as a temporary failure.
    if (retryable === false || (retryable !== true && !isRetryableReason(reason))) { this.stop(reason); return false; }
    const maintenance = maintenanceWait(reason);
    if (maintenance !== null) {
      this.maintenance = { until: observedAt + maintenance };
      this.attempt = 0;
    } else if (this.maintenance) this.maintenance.until = this.now() + MAINTENANCE_CHECK_MS;
    if (!this.maintenance && settings.maxAttempts > 0 && this.attempt >= settings.maxAttempts) {
      this.stop('\u5df2\u8fbe\u81ea\u52a8\u91cd\u8fde\u6b21\u6570\u4e0a\u9650');
      return false;
    }
    const epoch = this.epoch;
    const delay = this.maintenance ? Math.max(0, this.maintenance.until - this.now())
      : Math.min(60, settings.delaySeconds * 2 ** Math.min(this.attempt, 5)) * 1000;
    this.phase = this.maintenance ? 'maintenance' : 'waiting';
    this.notify(reason, this.now() + delay);
    this.timer = this.setTimer(async () => {
      if (epoch !== this.epoch) return;
      this.timer = null;
      this.running = epoch;
      this.pendingFailure = null;
      if (!this.maintenance) this.attempt++;
      this.phase = 'connecting';
      this.notify(reason);
      let result;
      try { result = await this.connect({ ...this.target }); }
      catch (e) { result = { ok: false, error: e.message, retryable: isRetryableReason(e.message) }; }
      if (epoch !== this.epoch) return;
      this.running = null;
      if (result && result.retryable === false) { this.stop(result.error); return; }
      const returned = !result || !result.ok ? { reason: (result && result.error) || '\u91cd\u8fde\u5931\u8d25', at: this.now() } : null;
      const failure = returned && maintenanceWait(returned.reason) !== null
        && (!this.pendingFailure || maintenanceWait(this.pendingFailure.reason) === null)
        ? returned : this.pendingFailure || returned;
      this.pendingFailure = null;
      if (failure) this.schedule(failure.reason, failure.at, result && result.retryable);
    }, delay);
    return true;
  }

  updatePolicy() {
    const cancelAttempt = this.phase === 'connecting';
    if (!normalizeReconnect(this.getSettings()).enabled) {
      this.cancel('\u81ea\u52a8\u91cd\u8fde\u5df2\u5173\u95ed');
      return cancelAttempt;
    }
    if (this.phase === 'waiting') {
      this.cancel();
      this.schedule('');
    }
    return false;
  }
}

module.exports = { ReconnectController, normalizeReconnect, isRetryableReason, isDuplicateLoginReason, maintenanceWait, MAINTENANCE_CHECK_MS };
