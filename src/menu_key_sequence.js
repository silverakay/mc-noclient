'use strict';

// Keep sneak active across server ticks, as in the successful MenuWatch script.
class MenuKeySequence {
  constructor({ isCurrent, hasMenu, input, swap, setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { isCurrent, hasMenu, input, swap, setTimer, clearTimer });
    this.pending = null;
  }
  open() {
    if (this.pending || !this.isCurrent() || this.hasMenu()) return Promise.resolve({ ok: false, error: '连接未就绪或已有菜单打开' });
    return new Promise((resolve) => {
      const own = { resolve, timer: null, pressed: false, phase: 'sneak' };
      this.pending = own;
      const later = (fn, delay) => { own.timer = this.setTimer(fn, delay); };
      try {
        own.pressed = true; this.input(true);
        later(() => {
          own.timer = null;
          if (this.pending !== own) return;
          if (!this.isCurrent() || this.hasMenu()) { this.cancel('连接或菜单已变化，未触发换副手'); return; }
          try {
            own.phase = 'swap'; this.swap();
            later(() => this.finish(own, { ok: true }), 150);
          } catch (error) { this.finish(own, { ok: false, error: error.message }); }
        }, 200);
      } catch (error) { this.finish(own, { ok: false, error: error.message }); }
    });
  }
  finish(own, result) {
    if (this.pending !== own) return;
    if (own.timer !== null) this.clearTimer(own.timer);
    this.pending = null;
    if (own.pressed && this.isCurrent()) {
      try { this.input(false); }
      catch (error) { result = { ok: false, error: '恢复潜行状态失败：' + error.message }; }
    }
    own.resolve(result);
  }
  cancel(error = '菜单快捷键动作已取消') {
    if (this.pending) this.finish(this.pending, { ok: false, error });
  }
}
module.exports = { MenuKeySequence };
