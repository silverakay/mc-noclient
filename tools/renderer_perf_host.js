'use strict';

// Test-only hidden Electron host. No application main, credentials or real server configuration.
const { app, BrowserWindow } = require('electron');
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1060, height: 720, useContentSize: true, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen: true } });
  win.loadURL('about:blank');
});
app.on('window-all-closed', () => {});
