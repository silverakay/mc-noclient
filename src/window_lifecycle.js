'use strict';

class WindowLifecycle {
  constructor({ app, Tray, Menu, icon, getBehavior, onError = () => {} }) {
    Object.assign(this, { app, Tray, Menu, icon, getBehavior, onError });
    this.tray = null;
    this.window = null;
    this.quitting = false;
    app.on('before-quit', () => { this.quitting = true; this.destroyTray(); });
  }

  attach(window) {
    this.window = window;
    window.on('close', (event) => {
      if (this.quitting || this.getBehavior() !== 'background') return;
      try {
        this.ensureTray();
        event.preventDefault(); window.hide();
      } catch (error) { this.onError(error); }
    });
    window.on('closed', () => { if (this.window === window) this.window = null; });
  }

  restore() {
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show(); window.focus();
  }

  ensureTray() {
    if (this.tray) return;
    const tray = new this.Tray(this.icon);
    try {
      tray.setToolTip('\u8292\u679c\u7aef\u8f85\u52a9');
      tray.setContextMenu(this.Menu.buildFromTemplate([
        { label: '\u663e\u793a\u4e3b\u7a97\u53e3', click: () => this.restore() },
        { type: 'separator' },
        { label: '\u9000\u51fa\u7a0b\u5e8f', click: () => this.quit() },
      ]));
      tray.on('click', () => this.restore());
      tray.on('double-click', () => this.restore());
      this.tray = tray;
    } catch (error) { tray.destroy(); throw error; }
  }

  quit() { this.quitting = true; this.app.quit(); }
  destroyTray() { if (this.tray) { this.tray.destroy(); this.tray = null; } }
}

module.exports = { WindowLifecycle };
