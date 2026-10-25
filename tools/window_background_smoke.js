'use strict';

// Isolated hidden/offscreen Electron window; no app main, credentials, config or Minecraft connection.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const root = path.join(__dirname, '..');

if (!process.versions.electron) {
  const { spawnSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mango-background-smoke-'));
  const report = path.join(dir, 'report.json');
  const source = process.argv[2] ? path.resolve(process.argv[2], 'win-unpacked/resources/app.asar') : root;
  const env = { ...process.env, APPDATA: dir, LOCALAPPDATA: dir, MANGO_BACKGROUND_REPORT: report };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnSync(path.join(root, 'node_modules/electron/dist/electron.exe'), [__filename, source,
    '--user-data-dir=' + path.join(dir, 'profile')], { env, windowsHide: true, encoding: 'utf8', timeout: 20000 });
  assert.equal(child.status, 0, child.stderr || String(child.error));
  const result = JSON.parse(fs.readFileSync(report, 'utf8'));
  assert.equal(result.ok, true, JSON.stringify(result));
  console.log('PASS real Electron hidden close/background, continuing timer, same-window restore and final tray quit');
  console.log(report);
} else {
  const { app, BrowserWindow, Tray, Menu } = require('electron');
  const { WindowLifecycle } = require(path.join(process.argv[2], 'src/window_lifecycle.js'));
  let life, tick;
  const fail = (error) => {
    if (tick) clearInterval(tick); if (life) life.destroyTray();
    fs.writeFileSync(process.env.MANGO_BACKGROUND_REPORT, JSON.stringify({ ok: false, error: error.stack })); app.exit(1);
  };
  app.on('window-all-closed', () => {});
  app.whenReady().then(async () => {
    const window = new BrowserWindow({ show: false, webPreferences: { offscreen: true, sandbox: true } });
    life = new WindowLifecycle({ app, Tray, Menu, icon: path.join(root, 'app/icon.ico'), getBehavior: () => 'background' });
    life.attach(window);
    let ticks = 0, shown = 0, focused = 0;
    tick = setInterval(() => { ticks++; }, 10);
    window.close();
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(window.isDestroyed(), false); assert.equal(window.isVisible(), false); assert.ok(life.tray);
    assert.ok(ticks >= 1, 'Background close must not stop main-process timers');
    // Stub display methods so verification never raises a visible user window.
    window.show = () => { shown++; }; window.focus = () => { focused++; };
    life.restore(); assert.equal(shown, 1); assert.equal(focused, 1);
    app.once('will-quit', () => {
      try {
        assert.equal(life.tray, null); assert.equal(life.quitting, true); assert.equal(window.isDestroyed(), true);
        fs.writeFileSync(process.env.MANGO_BACKGROUND_REPORT, JSON.stringify({ ok: true, ticks, shown, focused }));
      } catch (error) { fail(error); }
      clearInterval(tick);
    });
    life.quit();
  }).catch(fail);
}
