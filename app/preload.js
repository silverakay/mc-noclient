'use strict';
/*
 * preload.js —— 安全桥接层
 * 只暴露必要的 API 给渲染进程，不开 nodeIntegration
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 配置
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (cfg) => ipcRenderer.invoke('config:save', cfg),
  selectProfile: (target) => ipcRenderer.invoke('profile:select', target),
  getAttention: (request) => ipcRenderer.invoke('attention:get', request),
  readAttention: (request) => ipcRenderer.invoke('attention:read', request),
  pauseAutomation: () => ipcRenderer.invoke('attention:pause'),
  getSourceMessage: (request) => ipcRenderer.invoke('attention:source', request),
  getConfigPath: () => ipcRenderer.invoke('config:path'),
  getHistoryPath: () => ipcRenderer.invoke('history:path'),
  chooseHistoryPath: () => ipcRenderer.invoke('history:choose-path'),
  revealHistory: () => ipcRenderer.invoke('history:reveal'),
  getChatHistory: (request) => ipcRenderer.invoke('history:chat', request),

  // 账号
  peekAccount: () => ipcRenderer.invoke('account:peek'),
  loginAccount: (options) => ipcRenderer.invoke('account:login', options),
  switchAccount: (uuid) => ipcRenderer.invoke('account:switch', uuid),
  logoutAccount: () => ipcRenderer.invoke('account:logout'),

  // 服务器
  pingServer: (host, port) => ipcRenderer.invoke('server:ping', { host, port }),

  // 连接
  connect: (opts) => ipcRenderer.invoke('client:connect', opts),
  disconnect: () => ipcRenderer.invoke('client:disconnect'),
  setConnectionMode: (mode) => ipcRenderer.invoke('client:mode', mode),
  getBridgeStatus: () => ipcRenderer.invoke('bridge:status'),
  startBridge: () => ipcRenderer.invoke('bridge:start'),
  exportBridgePairing: () => ipcRenderer.invoke('bridge:export'),
  say: (text) => ipcRenderer.invoke('client:say', text),
  chatAction: (id) => ipcRenderer.invoke('client:chatAction', id),
  getOnline: () => ipcRenderer.invoke('presence:online'),
  getDailyPurchase: () => ipcRenderer.invoke('purchase:get'),
  retryDailyPurchase: () => ipcRenderer.invoke('purchase:retry'),
  completeCommand: (text) => ipcRenderer.invoke('client:complete', text),
  closeMenu: (id, token) => ipcRenderer.invoke('client:closeMenu', token ? { id, token } : id),
  clickMenu: (request) => ipcRenderer.invoke('client:clickMenu', request),

  // 事件订阅
  onLog: (cb) => ipcRenderer.on('log', (_e, d) => cb(d)),
  onStatus: (cb) => ipcRenderer.on('status', (_e, d) => cb(d)),
  onChat: (cb) => ipcRenderer.on('chat', (_e, d) => cb(d)),
  onAttention: (cb) => ipcRenderer.on('attention', (_e, d) => cb(d)),

  // 资源监控
  getMetrics: () => ipcRenderer.invoke('metrics:get'),
  onMetrics: (cb) => ipcRenderer.on('metrics', (_e, d) => cb(d)),

  revealData: () => ipcRenderer.invoke('app:revealData'),
  createDiagnosticReport: () => ipcRenderer.invoke('app:diagnosticReport'),
  reloadRenderer: () => ipcRenderer.invoke('app:reloadRenderer'),

  // 用系统浏览器打开一个网址（设备代码流的验证页）
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
});
