'use strict';

const fs = require('fs');
const path = require('path');
const { localDay } = require('./welcome');

function normalizeMidnight(settings) {
  const value = settings && typeof settings === 'object' ? settings : {};
  const command = typeof value.command === 'string' ? value.command.trim() : '';
  const valid = /^\/[^\s/]/.test(command) && command.length <= 2048
    && !/[\x00-\x1f\x7f]/.test(value.command);
  return { enabled: value.enabled === true && valid, command: valid ? command : '' };
}

function nextMidnight(time) {
  const date = new Date(time);
  date.setHours(24, 0, 0, 0);
  return date.getTime();
}

function reserveDay(file, day) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = file + '.lock';
  const descriptor = fs.openSync(lock, 'wx');
  try {
    if (fs.existsSync(file)) {
      const state = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!state || state.version !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(state.day)) {
        throw new Error('Invalid midnight command record');
      }
      if (day <= state.day) return false;
    }
    // Reserve before sending: failed or uncertain dispatch must never be retried.
    fs.writeFileSync(file + '.tmp', JSON.stringify({ version: 1, day }), 'utf8');
    fs.renameSync(file + '.tmp', file);
    return true;
  } finally {
    fs.closeSync(descriptor);
    fs.unlinkSync(lock);
  }
}

class MidnightCommand {
  constructor({ file, getClient, onRecord = () => {}, onDispatch = () => {}, now = Date.now,
    setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { file, getClient, onRecord, onDispatch, now, setTimer, clearTimer });
    this.settings = normalizeMidnight();
    this.running = false; this.timer = null; this.generation = 0;
  }

  configure(settings) {
    const next = normalizeMidnight(settings);
    if (next.enabled === this.settings.enabled && next.command === this.settings.command) return;
    this.settings = next;
    this.cancel();
    if (this.running) this.arm();
  }

  cancel() {
    this.generation++;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  start() { this.cancel(); this.running = true; this.arm(); }
  stop() { this.running = false; this.cancel(); }

  arm() {
    if (!this.running || !this.settings.enabled) return;
    const now = this.now(), due = nextMidnight(now), generation = this.generation;
    // Recheck local wall time every minute, then aim directly at the boundary.
    this.timer = this.setTimer(() => {
      if (!this.running || generation !== this.generation) return;
      this.timer = null;
      const current = this.now();
      this.arm();
      if (current >= due) return this.fire(due);
    }, Math.min(60000, Math.max(1, due - now)));
  }

  record(status, detail) { this.onRecord({ status, detail, t: this.now() }); }

  isDue(due) {
    const time = this.now(), date = new Date(time);
    return time >= due && time - due < 1000
      && date.getHours() === 0 && date.getMinutes() === 0 && date.getSeconds() === 0;
  }

  async fire(due) {
    if (!this.isDue(due)) {
      this.record('skipped', '\u5df2\u9519\u8fc7\u672c\u5730 00:00:00\uff0c\u672c\u6b21\u4e0d\u8865\u53d1');
      return;
    }
    const client = this.getClient();
    if (!client || client.state !== 'play' || client.automationBlocked) {
      this.record('skipped', '\u672c\u5730 00:00:00 \u65f6\u672a\u5728\u7ebf\u6216\u81ea\u52a8\u52a8\u4f5c\u4e0d\u53ef\u7528\uff0c\u672c\u6b21\u8df3\u8fc7');
      return;
    }
    const command = this.settings.command;
    try {
      if (!reserveDay(this.file, localDay(due))) {
        this.record('skipped', '\u8be5\u672c\u5730\u65e5\u671f\u5df2\u5904\u7406\u6216\u65e5\u671f\u56de\u9000\uff0c\u4e0d\u91cd\u590d\u53d1\u9001');
        return;
      }
    } catch (e) {
      this.record('failed', '\u65e0\u6cd5\u4fdd\u5b58\u6bcf\u65e5\u53d1\u9001\u8bb0\u5f55\uff0c\u672c\u6b21\u672a\u53d1\u9001\uff1a' + e.message);
      return;
    }
    if (!this.isDue(due) || this.getClient() !== client || client.state !== 'play') {
      this.record('skipped', '\u5df2\u9519\u8fc7\u65f6\u523b\u6216\u8fde\u63a5\u6539\u53d8\uff0c\u672c\u6b21\u4e0d\u8865\u53d1');
      return;
    }
    try {
      this.onDispatch(true);
      const response = await client.command(command.slice(1), { expiresAt: due + 999 });
      const ok = response === true || !!response && response.ok === true;
      this.record(ok ? 'sent' : 'failed', ok
        ? '\u5df2\u53d1\u9001\u81ea\u5b9a\u4e49\u547d\u4ee4\uff08\u6267\u884c\u7ed3\u679c\u4ee5\u670d\u52a1\u5668\u4e3a\u51c6\uff09'
        : '\u547d\u4ee4\u53d1\u9001\u672a\u786e\u8ba4\uff0c\u4e0d\u91cd\u8bd5\uff1a' + (response && response.error || '\u8fde\u63a5\u4e0d\u53ef\u7528'));
    } catch (e) {
      this.record('failed', '\u547d\u4ee4\u53d1\u9001\u5931\u8d25\uff0c\u4e0d\u91cd\u8bd5\uff1a' + e.message);
    } finally {
      this.onDispatch(false);
    }
  }
}

module.exports = { MidnightCommand, normalizeMidnight, nextMidnight, reserveDay };
