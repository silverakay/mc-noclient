'use strict';

const assert = require('assert/strict');
const { EventEmitter } = require('events');
const { WindowLifecycle } = require('./window_lifecycle');
const { configureDataPath, LEGACY_DATA_NAME } = require('./app_identity');
const path = require('path');
const fs = require('fs');
const os = require('os');

function fixture(behavior = 'background', fail = false) {
  const app = new EventEmitter(), window = new EventEmitter();
  let quits = 0, errors = 0, hidden = 0, shown = 0, focused = 0, restored = 0;
  app.quit = () => { quits++; app.emit('before-quit'); };
  Object.assign(window, { hide: () => { hidden++; }, show: () => { shown++; }, focus: () => { focused++; },
    isDestroyed: () => false, isMinimized: () => true, restore: () => { restored++; } });
  const trays = [];
  class Tray extends EventEmitter {
    constructor() { super(); if (fail) throw new Error('Fixture tray failure'); trays.push(this); }
    setToolTip(value) { this.tip = value; }
    setContextMenu(menu) { this.menu = menu; }
    destroy() { this.destroyed = true; }
  }
  const life = new WindowLifecycle({ app, Tray, Menu: { buildFromTemplate: value => value }, icon: 'fixture.ico',
    getBehavior: () => behavior, onError: () => { errors++; } });
  life.attach(window);
  const close = () => { let prevented = false; window.emit('close', { preventDefault() { prevented = true; } }); return prevented; };
  return { app, window, life, trays, close, setBehavior: value => { behavior = value; },
    counts: () => ({ quits, errors, hidden, shown, focused, restored }) };
}

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS ' + name); }
test('Quit mode lets the native close proceed without creating a tray', () => {
  const h = fixture('quit'); assert.equal(h.close(), false); assert.equal(h.trays.length, 0);
});
test('Background close hides without destroying the window or quitting and reuses one tray', () => {
  const h = fixture(); assert.equal(h.close(), true); assert.equal(h.close(), true);
  assert.equal(h.trays.length, 1); assert.equal(h.counts().quits, 0); assert.equal(h.counts().hidden, 2);
});
test('Tray click and show menu restore the same window', () => {
  const h = fixture(); h.close(); h.trays[0].emit('click'); h.trays[0].menu[0].click();
  assert.equal(h.counts().shown, 2); assert.equal(h.counts().focused, 2); assert.equal(h.counts().restored, 2);
});
test('Tray quit is definitive even if background behavior remains enabled', () => {
  const h = fixture(); h.close(); h.trays[0].menu[2].click();
  assert.equal(h.counts().quits, 1); assert.equal(h.close(), false); assert.equal(h.trays[0].destroyed, true);
});
test('Native app quit and switching back to quit never trap the user in background', () => {
  const h = fixture(); h.close(); h.setBehavior('quit'); assert.equal(h.close(), false);
  h.app.emit('before-quit'); assert.equal(h.trays[0].destroyed, true);
});
test('Tray initialization failure does not hide an unreachable running application', () => {
  const h = fixture('background', true); assert.equal(h.close(), false);
  assert.equal(h.counts().hidden, 0); assert.equal(h.counts().errors, 1);
});
test('Restoring a destroyed window is harmless', () => {
  const h = fixture(); h.window.isDestroyed = () => true; h.life.restore(); assert.equal(h.counts().shown, 0);
});
test('Renaming retains the old fixed data directory, with explicit isolated paths honored', () => {
  const paths = { appData: fs.mkdtempSync(path.join(os.tmpdir(), 'mango-identity-')), userData: path.resolve('fixture-new-name') };
  const app = { getPath: key => paths[key], setPath: (key, value) => { paths[key] = value; } };
  assert.equal(configureDataPath(app, []), path.join(paths.appData, LEGACY_DATA_NAME));
  paths.userData = path.resolve('fixture-isolated');
  assert.equal(configureDataPath(app, ['--user-data-dir=fixture-isolated']), path.resolve('fixture-isolated'));
});
test('UI selftest cannot use real known-folder paths implicitly', () => {
  const paths = { appData: path.resolve('must-not-touch-appdata'), userData: path.resolve('must-not-touch-profile') };
  let changes = 0;
  const app = { getPath: key => paths[key], setPath: () => { changes++; } };
  assert.throws(() => configureDataPath(app, ['--selftest-ui']), /explicit isolated/);
  assert.throws(() => configureDataPath(app, ['--selftest-ui', '--user-data-dir']), /explicit isolated/);
  assert.throws(() => configureDataPath(app, ['--selftest-ui', '--user-data-dir=relative']), /explicit isolated/);
  assert.equal(changes, 0);
});
test('Implicit-path UI selftest overrides known folders and session storage before loading config', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mango-identity-ui-'));
  const paths = { appData: path.resolve('must-not-touch-appdata'), userData: path.resolve('must-not-touch-profile') };
  const app = { getPath: key => paths[key], setPath: (key, value) => { paths[key] = value; } };
  assert.equal(configureDataPath(app, ['--selftest-ui', '--selftest-app-data=' + root]), path.join(root, LEGACY_DATA_NAME));
  assert.equal(paths.appData, root);
  assert.equal(paths.sessionData, paths.userData);
});
console.log('=== Result: ' + passed + ' passed / 0 failed ===');
