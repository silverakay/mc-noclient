'use strict';
/*
 * main.js —— Electron 主进程
 *
 * 职责：
 *   - 创建窗口
 *   - 承载协议客户端（网络逻辑跑在主进程，通过 IPC 给界面发日志）
 *   - 处理微软账号登录（需要 shell.openExternal 打开浏览器）
 *   - 读写配置
 */

const { app, BrowserWindow, ipcMain, shell, dialog, powerMonitor, Tray, Menu, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');

const { MCClient, pingServer, MC_VERSION, PROTOCOL_VERSION } = require('../src/client');
const auth = require('../src/auth');
const monitor = require('../src/monitor');
const configstore = require('../src/configstore');
const profiles = require('../src/server_profiles');
const { effectiveAccount, accountStateFiles } = require('../src/account_profiles');
const { Attention, messageReasons, quietNow } = require('../src/attention');
const { BridgeExitGuard, normalizeBridgeExit, MAX_EXIT_PLAYERS } = require('../src/bridge_exit');
const { bridgeFallbackAllowed, standaloneBridgeTarget } = require('../src/bridge_handoff');
const { ChatActions } = require('../src/chat_actions');
const { componentToRuns } = require('../src/chat_component');
const { RedPacketClaimBatch } = require('../src/red_packet_batch');
const { ReconnectController, normalizeReconnect, isRetryableReason, isDuplicateLoginReason } = require('../src/reconnect');
const { BridgeServer, pairing } = require('../src/client_bridge');
const { discoveryDirectory } = require('../src/bridge_discovery');
const { formatObservation } = require('../src/outbound_monitor');
const { MidnightCommand } = require('../src/midnight_command');
const { DailyPurchase } = require('../src/daily_purchase');
const chatActions = new ChatActions();
const { RedPacketAutomation, chatCategory, validClaimDelay, validClaimAfter, normalizeClaimTrigger } = require('../src/red_packet');
const { PRODUCT_NAME, configureDataPath } = require('../src/app_identity');
const { WindowLifecycle } = require('../src/window_lifecycle');
const { PresenceStore, parsePresence } = require('../src/presence');
const { WelcomeAutomation, WelcomeBudget, validWelcomeDelay } = require('../src/welcome');
const { HistoryStore } = require('../src/history_store');
const { relatedMonitoredPlayers } = require('../src/chat_monitor');
const { seedReleaseData } = require('../src/release_seed');
const redPackets = new RedPacketAutomation({ actions: chatActions,
  setTimer: setTimeout, clearTimer: clearTimeout, now: Date.now,
  onRecord: (record) => pushLog('automation', '[红包自动领取] ' + record.detail),
  onTrace: (record) => { attention.ingest('红包', record); scheduleAttention(); },
  onAction: (action) => pushStatus({ redPacketAction: action }),
});
const redPacketBatch = new RedPacketClaimBatch({
  setTimer: setTimeout, clearTimer: clearTimeout, now: Date.now,
  onRecord: (record) => pushLog('automation', '[红包监控] ' + record.detail),
});

// 打包后 __dirname 在 asar 里，用户配置要写到 exe 同级的 data 目录
// 开发/源码运行时，与 CLI 版共用项目根目录的 config.json，避免"改了一个没生效"
// 注意：若环境变量 ELECTRON_RUN_AS_NODE=1，electron 会退化成纯 Node，
// 此时 app 为 undefined，需要显式提示（而不是抛 TypeError）。
if (!app || typeof app.isPackaged !== 'boolean') {
  console.error('[致命] 未运行在 Electron 环境中。请确认没有设置环境变量 ELECTRON_RUN_AS_NODE=1。');
  process.exit(1);
}

// 这是纯 2D 工具界面，不使用 Canvas/WebGL。关闭硬件加速可以移除独立 GPU
// 进程，降低常驻内存约 40–60 MB；网络、桥接和渲染功能不受影响。命令行
// 开关放在 API 调用前，确保 Electron 33 的 GPU 进程也不会先被拉起。
if (app.commandLine && typeof app.commandLine.appendSwitch === 'function') {
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('in-process-gpu');
}
if (typeof app.disableHardwareAcceleration === 'function') app.disableHardwareAcceleration();
const ROOT_DIR = path.join(__dirname, '..');

/* ---------------- 配置存放位置（v2.2.1 修正） ----------------
 *
 * ❗旧版把它放在 exe 同级目录，导致**便携版每次开都丢配置**：
 *   便携版(portable)运行时会把自身解压到一个**随机临时目录**再启动，
 *   process.execPath 指向那个临时目录 → 配置写进临时目录 →
 *   退出后临时目录被清理 → 下次启动路径变了，用户看到的就是"我加的服务器没了"。
 *
 * 现在统一放到 Electron 的 userData（%APPDATA%\<productName>）：
 *   - 开发、安装版、便携版**三种形态都是同一个固定路径**
 *   - 与 Cloud 同步/杀软清理临时目录无关，不会被系统清掉
 *   - 与 auth.js 的账号缓存（%APPDATA%\.mc-noclient）同属用户级数据，语义一致
 */
const DATA_DIR = configureDataPath(app);
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const DEFAULT_HISTORY_DIR = path.join(DATA_DIR, 'records');

seedReleaseData({ source: path.join(ROOT_DIR, 'release-data'), dataDir: DATA_DIR,
  authFile: auth && auth.TOKEN_CACHE, disabled: !app.isPackaged || process.argv.includes('--selftest-ui') });
const historyStore = new HistoryStore({
  fallbackRoot: DEFAULT_HISTORY_DIR,
  onError: (message) => {
    if (mainWindow && !mainWindow.isDestroyed()) pushLog('error', message);
    else console.error('[历史记录] ' + message);
  },
});
const attention = new Attention({ persist: (event) => historyStore.append('events', event) });
let attentionTimer = null, notifyTimer = null, notifyBatch = null;
let profileKey = '', baseConfig = null, suspended = false, recoveredFromMaintenance = false;
function contextInfo() {
  return { serverKey: profileKey, account: client && client.username || '', session: chatActions.session };
}
function scheduleAttention() {
  if (attentionTimer !== null) return;
  const generation = connectionGeneration;
  attentionTimer = setTimeout(() => {
    attentionTimer = null;
    if (generation === connectionGeneration && mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('attention', { revision: attention.revision });
  }, 250);
  attentionTimer?.unref?.();
}
function notifyImportant(text, policy, context) {
  if (!policy?.desktop || quietNow(policy, Date.now()) || mainWindow?.isFocused?.()) return;
  if (notifyBatch && notifyBatch.key !== context.serverKey) { clearTimeout(notifyTimer); notifyBatch = null; }
  if (!notifyBatch) notifyBatch = { key: context.serverKey, policy, count: 0, text: '' };
  notifyBatch.count++; notifyBatch.text = policy.preview ? String(text).slice(0, 160) : '有与你相关的新消息';
  if (notifyTimer !== null && notifyBatch.count > 1) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null; const batch = notifyBatch; notifyBatch = null;
    if (!batch || quietNow(batch.policy, Date.now()) || mainWindow?.isFocused?.()) return;
    try {
      if (!Notification?.isSupported()) throw new Error('当前系统不支持通知');
      const notification = new Notification({ title: PRODUCT_NAME, body: batch.count > 1
        ? batch.count + ' 条重要提醒' : batch.text, silent: true });
      notification.on('click', () => windowLifecycle.restore());
      notification.on('failed', () => { attention.notificationStatus = '系统通知失败，请查看关注页'; attention.revision++; scheduleAttention(); });
      notification.show(); attention.notificationStatus = '已提交系统，展示结果由 Windows 决定'; attention.revision++; scheduleAttention();
    } catch (e) { attention.notificationStatus = '系统通知不可用，应用内提醒保留'; attention.revision++; scheduleAttention(); }
  }, 3000);
  notifyTimer?.unref?.();
}
function selectProfile(key) {
  if (!baseConfig) return;
  const changed = profileKey !== key;
  if (changed) {
    attention.cancel(chatActions.session, '服务器配置已切换，旧动作不补发');
    welcomes.cancelScheduled(); redPackets.resetPending();
    if (notifyTimer !== null) clearTimeout(notifyTimer);
    notifyTimer = null; notifyBatch = null;
  }
  profileKey = key || '';
  runtimeConfig = profiles.effectiveConfig(baseConfig, profileKey);
  midnight.configure(runtimeConfig.__loadError ? null : runtimeConfig.midnightCommand);
  if (runtimeConfig.automation?.paused || suspended) midnight.stop(); else midnight.start();
  if (changed) pushStatus({ profileKey, profileChanged: true });
}
const presence = new PresenceStore(path.join(DATA_DIR, 'presence.jsonl'), {
  persistHistory: false,
  onError: (message) => pushLog('error', message),
});
const welcomes = new WelcomeAutomation({ actions: chatActions,
  budget: new WelcomeBudget(path.join(DATA_DIR, 'welcome-daily.json')),
  setTimer: setTimeout, clearTimer: clearTimeout, now: Date.now,
  onRecord: (record) => pushLog('automation', '[\u81ea\u52a8\u6b22\u8fce] ' + record.detail),
  onTrace: (record) => { attention.ingest('欢迎', record); scheduleAttention(); },
  onAction: (action) => pushStatus({ automationAction: action }),
});

// 旧位置（exe 同级 / 项目根）：仅用于首次迁移，迁移后不再写入
const LEGACY_CONFIG_PATHS = app.isPackaged ? [] : [
  path.join(path.dirname(process.execPath), 'data', 'config.json'),  // 旧便携版/安装版
  path.join(path.dirname(process.execPath), 'config.json'),          // 更早的版本
  path.join(ROOT_DIR, 'config.json'),                                // 开发模式项目根
];

let mainWindow = null;
let client = null;              // 当前活动的协议客户端
let account = null;             // 已登录的微软账号 { accessToken, profile }
let selectedAccountUuid = null; // Process-local selection; shared cache is only a startup preference.
let accountEpoch = 0;
let pollTimer = null;           // 状态轮询定时器（必须显式管理，否则旧连接会留下幽灵轮询）
let monTimer = null;            // 资源监控定时器（同理，退出时必须清）
let monitorInitialized = false;
let connectBusy = false;        // 连接流程互斥锁：防止连点"连接"并发建连
let connectionGeneration = 0;   // 断开后，未完成的认证/建连结果不能恢复连接
let loginBusy = false;          // 授权流程互斥锁：防止重复发起设备代码授权（会浪费代码并互相干扰）
let loginPromise = null;        // 共享登录 Promise：见 ensureAccount
let runtimeConfig = null;
let connectionDeadline = null;
let diagnosticsSavedAt = 0;
let connectionMode = 'standalone';
let bridge = null;
let bridgeStarting = false;
let bridgeExitPending = null;
let bridgeExitStopped = false;
let bridgeStandaloneAttempt = null;
const bridgeExitGuard = new BridgeExitGuard({ trigger: (peer, player) => exitForOnlinePlayer(peer, player),
  onError: (e) => pushLog('error', '玩家上线下线处理失败：' + e.message) });
const windowLifecycle = new WindowLifecycle({ app, Tray, Menu, icon: path.join(__dirname, 'icon.ico'),
  getBehavior: () => runtimeConfig && !runtimeConfig.__loadError ? runtimeConfig.closeBehavior : 'quit',
  onError: (error) => pushLog('error', '后台托盘创建失败，将结束程序：' + error.message) });
const AUTO_BRIDGE_DETECTION_MS = 30000;
const dailyPurchase = new DailyPurchase({
  directory: path.join(DATA_DIR, 'daily-purchase'), getClient: () => client,
  enabled: () => !!runtimeConfig && !runtimeConfig.__loadError && !runtimeConfig.automation?.paused && !suspended,
  now: Date.now, setTimer: setTimeout, clearTimer: clearTimeout,
  onChange: (snapshot) => pushStatus({ dailyPurchase: snapshot }),
  onRecord: (message) => pushLog('automation', '[每日收购] ' + message),
  onTrace: (record) => { attention.ingest('每日收购', record); scheduleAttention(); },
});
const midnight = new MidnightCommand({
  file: path.join(DATA_DIR, 'midnight-command.json'),
  onDispatch: (pending) => { dailyPurchase.signInPending = pending; if (pending) dailyPurchase.afterSignIn(); },
  getClient: () => client,
  now: Date.now, setTimer: setTimeout, clearTimer: clearTimeout,
  onRecord: (record) => {
    attention.ingest('零点命令', { ...record, ...contextInfo(), traceId: 'midnight/' + new Date().toDateString() + '/' + profileKey }); scheduleAttention();
    pushLog('automation', '[\u96f6\u70b9\u547d\u4ee4] ' + record.detail);
    if (record.status === 'sent') dailyPurchase.afterSignIn();
  },
});
const reconnect = new ReconnectController({
  setTimer: setTimeout, clearTimer: clearTimeout,
  now: Date.now,
  connect: (opts) => doConnect(opts, true),
  getSettings: () => runtimeConfig && !runtimeConfig.__loadError
    ? runtimeConfig.reconnect : { enabled: false },
  onChange: (state) => {
    if (state.phase === 'maintenance') recoveredFromMaintenance = true;
    if (state.phase === 'idle' && state.reason && runtimeConfig?.notifications?.connection) {
      attention.important({ ...contextInfo(), messageId: randomUUID(), text: state.reason }, ['连接恢复失败']);
      notifyImportant(state.reason, runtimeConfig.notifications, contextInfo()); scheduleAttention();
    }
    if (state.phase === 'maintenance') {
      const seconds = Math.max(0, Math.ceil((state.retryAt - Date.now()) / 1000));
      pushLog('net', `进入维护等待，已暂停自动重连；${seconds} 秒后检查恢复（维护等待不消耗重连次数）`);
    } else if (state.phase === 'waiting') {
      const seconds = Math.max(0, Math.ceil((state.retryAt - Date.now()) / 1000));
      pushLog('net', `连接意外断开，${seconds} 秒后自动重连（下一次为第 ${state.attempt + 1} 次）`);
    } else if (state.phase === 'connecting') {
      pushLog('net', state.maintenance ? `维护等待结束，正在检查服务器是否恢复 ${state.target.host}:${state.target.port}`
        : `正在自动重连 ${state.target.host}:${state.target.port}（第 ${state.attempt} 次）`);
    } else if (state.reason) pushLog('net', state.reason);
    pushStatus({ reconnect: state });
  },
});

/* ---------------- 登录互斥：全进程同一时刻只允许一条授权链 ----------------
 *
 * ❗真机事故（2026-10-08，接 mc.example.invalid 被拒 multiplayer.disconnect.unverified_username）：
 *   「启动自动登录」和「点连接时的静默续期」都会走完整的 微软→XBL→XSTS→MC 授权链。
 *   若启动后立刻点连接，两条链**并发**（9 秒内连发两套完整授权）——
 *   微软侧会话串扰，服务端 hasJoined 校验失败，表现为"能连上但被拒"。
 *
 *   对比：v2.1.1 能进，是因为当时只有「点连接」这一条链。
 *
 * 修法：用一个共享 Promise 收敛 —— 任何路径要登录时都调 ensureAccount()：
 *   已登录 → 直接用；正在登录 → 并发调用方 await 同一个 Promise 共享结果，不再各开一条。
 */
function currentAccountUuid() {
  if (selectedAccountUuid === null) selectedAccountUuid = auth.peekCachedAccount()?.uuid || '';
  return selectedAccountUuid;
}

function ensureAccount(log, uuid) {
  if (uuid === undefined) uuid = currentAccountUuid();
  if (account && (!uuid || account.profile.id === uuid)) return Promise.resolve(account);
  if (!loginPromise) {
    const epoch = accountEpoch;
    loginPromise = auth.login({ silentOnly: true, accountUuid: uuid || undefined, updateActive: false, log })
      .then((acc) => {
        if (epoch !== accountEpoch || uuid && acc.profile.id !== uuid)
          throw new Error('账号已切换或身份不一致，需要手动登录原账号');
        account = acc;
        if (selectedAccountUuid !== acc.profile.id) {
          selectedAccountUuid = acc.profile.id;
          loadConfig();
          pushStatus({ profileChanged: true });
        }
        return acc;
      })
      .finally(() => { loginPromise = null; });
  }
  return loginPromise.then((acc) => {
    if (uuid && acc.profile.id !== uuid) throw new Error('账号身份不一致，需要手动登录原账号');
    return acc;
  });
}

function localCachedAccounts() {
  const saved = typeof auth.peekCachedAccounts === 'function' ? auth.peekCachedAccounts()
    : { accounts: [], active: auth.peekCachedAccount() };
  const uuid = currentAccountUuid();
  return { accounts: saved.accounts, activeUuid: uuid || null,
    active: saved.accounts.find((item) => item.uuid === uuid) || (saved.active?.uuid === uuid ? saved.active : null) };
}

function activateAccount(acc) {
  account = acc;
  selectedAccountUuid = acc.profile.id;
  accountEpoch++;
  reconnect.stop();
  loadConfig();
  connectionMode = runtimeConfig.connectionMode;
  pushStatus({ ...accountStatusPayload(), profileChanged: true, connectionMode, bridge: bridgeStatus() });
}

function accountStatusPayload() {
  const saved = localCachedAccounts();
  return {
    account: account ? { name: account.profile.name, uuid: account.profile.id, premium: true } : null,
    accounts: saved.accounts,
    activeUuid: saved.activeUuid,
  };
}

/* ---------------- 配置读写 ----------------
 * 纯逻辑在 src/configstore.js（可独立测试）；这里只做薄薄的适配层。
 */

function loadConfig() {
  const r = configstore.load(CONFIG_PATH, LEGACY_CONFIG_PATHS);
  if (r.migratedFrom) console.log('[配置] 已从旧位置迁移：' + r.migratedFrom);
  if (r.error) {
    // ❗不静默吞错：把原因带到界面，否则用户只看到"服务器没了"却不知为何
    console.error('[配置] 读取失败：' + r.error + '（' + CONFIG_PATH + '）');
    r.cfg.__loadError = r.error;
  }
  baseConfig = effectiveAccount(r.cfg, currentAccountUuid());
  if (runtimeConfig === null) connectionMode = baseConfig.connectionMode || 'standalone';
  runtimeConfig = profiles.effectiveConfig(baseConfig, profileKey);
  historyStore.configure(runtimeConfig.storage && runtimeConfig.storage.path);
  try {
    const state = accountStateFiles(DATA_DIR, currentAccountUuid());
    midnight.file = state.midnight; welcomes.budget.file = state.welcome;
  } catch (error) {
    runtimeConfig.__loadError = '账号动作记录无法读取：' + error.message;
    baseConfig.__loadError = runtimeConfig.__loadError;
    console.error('[配置] ' + runtimeConfig.__loadError);
  }
  midnight.configure(runtimeConfig.__loadError ? null : runtimeConfig.midnightCommand);
  if (runtimeConfig.automation?.paused || suspended) midnight.stop();
  return runtimeConfig;
}

function saveConfig(cfg) {
  if (cfg?.bridgeFallback !== undefined && !['off', 'exit', 'offline'].includes(cfg.bridgeFallback))
    return { ok: false, error: '桥接下线后接管设置无效' };
  if (cfg?.__accountKey !== undefined && cfg.__accountKey !== currentAccountUuid())
    return { ok: false, error: '账号已切换，请重新打开设置' };
  if (cfg?.bridgeExit?.enabled === true && !normalizeBridgeExit(cfg.bridgeExit).enabled)
    return { ok: false, error: '下线目标须为 1–16 位英文、数字或下划线玩家 ID' };
  if (Array.isArray(cfg?.bridgeExit?.players) && (cfg.bridgeExit.players.length > MAX_EXIT_PLAYERS
    || cfg.bridgeExit.players.some((name) => typeof name !== 'string' || !/^[A-Za-z0-9_]{1,16}$/.test(name.trim()))))
    return { ok: false, error: '下线目标最多 16 位，每位须为有效玩家 ID' };
  if (cfg?.__profileKey !== undefined && cfg.__profileKey !== profileKey) return { ok: false, error: '服务器已切换，请重新打开设置' };
  if (cfg && cfg.automation) {
    const automation = cfg.automation;
    if (automation.claimAfter !== undefined && !validClaimAfter(automation.claimAfter))
      return { ok: false, error: '红包触发人数须为 1–1000 的整数，开关须为布尔值' };
    if (automation.claimDelayEnabled !== undefined && typeof automation.claimDelayEnabled !== 'boolean')
      return { ok: false, error: '随机延迟开关无效' };
    if (automation.claimAfter && automation.claimAfter.enabled && automation.claimDelayEnabled === true)
      return { ok: false, error: '按人数领取与随机延迟不能同时开启' };
  }
  if (cfg && cfg.automation && cfg.automation.claimDelay !== undefined && !validClaimDelay(cfg.automation.claimDelay)) {
    return { ok: false, error: '红包延迟范围须为 0–30 秒，最小值不能大于最大值' };
  }
  if (cfg && cfg.automation && cfg.automation.welcomeDelay !== undefined
    && !validWelcomeDelay(cfg.automation.welcomeDelay)) {
    return { ok: false, error: '欢迎延迟范围须为 0–30 秒，最小值不能大于最大值' };
  }
  if (cfg && cfg.automation && cfg.automation.welcomeDelayEnabled !== undefined
    && typeof cfg.automation.welcomeDelayEnabled !== 'boolean') {
    return { ok: false, error: '欢迎随机延迟开关无效' };
  }
  const midnightRequested = !!cfg && !!cfg.midnightCommand && cfg.midnightCommand.enabled === true;
  const normalized = configstore.normalize(profiles.saveProfile(cfg, profileKey));
  if (midnightRequested && !normalized.midnightCommand.enabled) {
    return { ok: false, error: '\u96f6\u70b9\u547d\u4ee4\u987b\u4ee5 / \u5f00\u5934\uff0c\u4e0d\u80fd\u6362\u884c\u4e14\u4e0d\u8d85\u8fc7 2048 \u5b57' };
  }
  const r = configstore.save(CONFIG_PATH, normalized, currentAccountUuid());
  if (!r.ok) console.error('[配置] 写入失败：' + r.error + '（' + CONFIG_PATH + '）');
  else {
    const changed = JSON.stringify(normalizeReconnect(runtimeConfig && runtimeConfig.reconnect))
      !== JSON.stringify(normalized.reconnect);
    const claimDelayChanged = JSON.stringify(runtimeConfig && runtimeConfig.automation && runtimeConfig.automation.claimDelay)
      !== JSON.stringify(normalized.automation.claimDelay)
      || JSON.stringify(normalizeClaimTrigger(runtimeConfig && runtimeConfig.automation || {}))
        !== JSON.stringify(normalizeClaimTrigger(normalized.automation));
    const welcomeDelayChanged = JSON.stringify(runtimeConfig && runtimeConfig.automation && runtimeConfig.automation.welcomeDelay)
      !== JSON.stringify(normalized.automation.welcomeDelay)
      || (runtimeConfig && runtimeConfig.automation && runtimeConfig.automation.welcomeDelayEnabled !== false)
        !== (normalized.automation.welcomeDelayEnabled !== false);
    baseConfig = { ...normalized, __accountKey: currentAccountUuid() };
    runtimeConfig = profiles.effectiveConfig(baseConfig, profileKey);
    if (bridgeStandaloneAttempt && (!bridgeFallbackAllowed(runtimeConfig.bridgeFallback, bridgeStandaloneAttempt.cause)
      || runtimeConfig.automation?.paused)) {
      reconnect.stop(); teardownClient();
    }
    if (notifyTimer !== null) clearTimeout(notifyTimer);
    notifyTimer = null; notifyBatch = null;
    historyStore.configure(normalized.storage && normalized.storage.path);
    midnight.configure(runtimeConfig.midnightCommand);
    if (runtimeConfig.automation.paused || suspended) { midnight.stop(); if (dailyPurchase.run) dailyPurchase.fail('自动化已暂停'); }
    else midnight.start();
    if (!normalized.automation.autoClaimRedPackets || normalized.automation.paused) redPackets.resetPending();
    else if (claimDelayChanged) redPackets.cancelScheduled();
    if (welcomeDelayChanged || !normalized.automation.autoWelcome || normalized.automation.paused) welcomes.cancelScheduled();
    if (normalized.automation.paused) attention.cancel(chatActions.session, '自动化已暂停；已提交动作的结果仍未知');
    if (client && connectionMode === 'standalone' && runtimeConfig.profileVersion === 1) {
      client.autoPurchaseEnabled = runtimeConfig.autoPurchase === true;
      if (!client.autoPurchaseEnabled && dailyPurchase.run?.source === 'automatic') dailyPurchase.fail('当前服务器已关闭自动获取');
    }
    scheduleAttention();
    if (connectionMode === 'bridge' && client) bridgeExitGuard.observe(client, runtimeConfig.bridgeExit);
    if (changed && reconnect.updatePolicy()) {
      teardownClient();
      pushStatus({ connected: false, state: 'idle' });
    }
  }
  return r;
}

/* ---------------- 窗口 ---------------- */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1060,
    height: 720,
    minWidth: 860,
    minHeight: 600,
    backgroundColor: '#0b0f14',
    title: PRODUCT_NAME + ' · ' + app.getVersion(),
    autoHideMenuBar: true,
    show: !process.argv.includes('--selftest-ui'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  windowLifecycle.attach(mainWindow);
  for (const event of ['blur', 'hide', 'minimize']) mainWindow.on(event, () => { attention.away(); stopMonitor(); });
  mainWindow.on('focus', () => { attention.returned(); startMonitor(); scheduleAttention(); });

  // 把渲染进程里的报错回报到主进程，方便自检
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    console.log(`[renderer] did-fail-load ${code} ${desc}`);
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  return mainWindow;
}

/* ---------------- UI 自检模式（--selftest-ui） ----------------
 * 无头验证界面能否正常加载：
 *   1. 等待页面加载完成
 *   2. 注入脚本检查关键 DOM 节点与全局函数是否就绪
 *   3. 截图存盘
 *   4. 打印结果并退出
 */
async function runUiSelftest() {
  // 整个自检包一层：任何一步抛错都写进文件，便于无输出环境下定位
  try {
    return await _runUiSelftestInner();
  } catch (e) {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(path.join(DATA_DIR, 'ui_selftest.json'),
        JSON.stringify({ ok: false, error: String(e && e.stack || e), at: new Date().toISOString() }, null, 2), 'utf8');
    } catch (e2) { /* ignore */ }
    app.exit(1);
  }
}

async function _runUiSelftestInner() {
  const win = createWindow();
  // did-finish-load 在无显示环境下可能一直不来 —— 加超时兜底，
  // 超时后仍尝试 executeJavaScript（此时 DOM 大概率已就绪），
  // 避免自检在无头机器上无限挂住。
  await new Promise((res) => {
    let done = false;
    const fin = () => { if (!done) { done = true; res(); } };
    win.webContents.once('did-finish-load', fin);
    setTimeout(fin, 8000);
  });

  // 等渲染进程里的异步 init() 跑完
  await new Promise((r) => setTimeout(r, 1500));

  const probe = await win.webContents.executeJavaScript(`(() => {
    const ids = ['btn-login','server-list','btn-connect','log-view','st-state','st-auth',
                 'device-code','dc-code','dc-uri','dc-copy','dc-open',
                 'mon-cpu','mon-mem','btn-mon-detail','mon-detail',
                 'sel-close-behavior','inp-claim-delay-min','inp-claim-delay-max',
                 'chk-autologin','chat-view','tab-chat','tab-log','chat-badge',
                 'btn-settings','settings-dialog','settings-form','chk-reconnect',
                 'inp-reconnect-delay','inp-reconnect-attempts','chk-showmonitor',
                 'chk-autoclaim','chk-autowelcome','chk-welcome-delay','inp-welcome-delay-min','inp-welcome-delay-max',
                 'chat-filter','log-filter','chk-hidepresence',
                 'chk-midnight','inp-midnight-command',
                 'tab-presence','presence-view','presence-name',
                 'presence-summary','chat-diagnostics', 'online-players', 'online-count',
                 'shortcut-select', 'settings-shortcuts', 'completion-list', 'server-menu-dialog', 'server-menu-grid'];
    const missing = ids.filter(i => !document.getElementById(i));
    const logLines = document.querySelectorAll('#log-view .log-line').length;
    const serverItems = document.querySelectorAll('#server-list .server-item').length;
    // 监控面板：等主进程推第一拍后再看有没有数字（init 里主动 getMetrics 拉过一次）
    const cpuTxt = (document.getElementById('mon-cpu')||{}).textContent || '';
    const memTxt = (document.getElementById('mon-mem')||{}).textContent || '';
    return {
      missing,
      logLines,
      serverItems,
      title: document.title,
      hasApi: typeof window.api === 'object',
      hasOpenExternal: typeof (window.api && window.api.openExternal) === 'function',
      hasOnMetrics: typeof (window.api && window.api.onMetrics) === 'function',
      connectText: (document.getElementById('btn-connect')||{}).textContent,
      bg: getComputedStyle(document.body).backgroundColor,
      accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
      offlineInputAbsent: !document.getElementById('inp-username'),
      dcHiddenInitially: document.getElementById('device-code').classList.contains('hidden'),
      // 聊天页应默认激活，日志页默认隐藏
      chatTabActive: document.getElementById('tab-chat').classList.contains('active'),
      logViewHidden: document.getElementById('log-view').classList.contains('hidden'),
      chatViewVisible: !document.getElementById('chat-view').classList.contains('hidden'),
      chatEmptyTip: !!document.getElementById('chat-empty'),
      hasOnChat: typeof (window.api && window.api.onChat) === 'function',
      monDetailHidden: document.getElementById('mon-detail').classList.contains('hidden'),
      cpuText: cpuTxt,
      memText: memTxt,
      monCpuOk: /%$/.test(cpuTxt) && cpuTxt !== '—',
      monMemOk: /%$/.test(memTxt) && memTxt.includes('/'),
      curvesAbsent: document.querySelectorAll('canvas').length === 0,
      monitorOnLeft: document.getElementById('monitor-panel').closest('.col-left') !== null,
      settingsInitiallyClosed: !document.getElementById('settings-dialog').open,
    };
  })()`);

  const settingsProbe = await win.webContents.executeJavaScript(`(() => {
    document.getElementById('btn-settings').click();
    const panel = document.getElementById('settings-dialog');
    const out = { opened: panel.open,
      delay: document.getElementById('inp-reconnect-delay').value,
      attempts: document.getElementById('inp-reconnect-attempts').value,
      monitorChecked: document.getElementById('chk-showmonitor').checked,
      closeBehavior: document.getElementById('sel-close-behavior').value,
      claimMin: document.getElementById('inp-claim-delay-min').value,
      claimMax: document.getElementById('inp-claim-delay-max').value,
      welcomeMin: document.getElementById('inp-welcome-delay-min').value,
      welcomeMax: document.getElementById('inp-welcome-delay-max').value,
      saveVisible: document.getElementById('settings-save').getBoundingClientRect().height > 0 };
    document.getElementById('settings-cancel').click();
    out.cancelClosed = !panel.open;
    return out;
  })()`);

  const presenceProbe = await win.webContents.executeJavaScript(`(async () => {
    document.getElementById('tab-presence').click();
    const out = { opened: !document.getElementById('presence-view').classList.contains('hidden'),
      noSendBar: document.getElementById('send-bar').classList.contains('hidden'),
      hideByDefault: document.getElementById('chk-hidepresence').checked,
      listUnknown: !(await window.api.getOnline()).known,
      completionRejected: !(await window.api.completeCommand('/fixture')).ok,
      staleMenuRejected: !(await window.api.closeMenu(300)).ok };
    document.getElementById('tab-chat').click();
    return out;
  })()`);

  // 探针二：伪造一条 auth 日志，验证设备代码提示条会被正确点亮
  const dcProbe = await win.webContents.executeJavaScript(`(() => {
    const out = { shown: false, code: null, uri: null };
    try {
      // 主进程会 send('log', ...)，渲染进程里正则解析那段文本。
      // 这里不起真实 IPC，而是直接用同一套正则校验 auth.js 的输出格式，
      // 确保「登录日志 → 提示条」这条链路的解析规则不会静默失配。
      const DC_LINE = /输入代码[：:]\\s*([A-Z0-9-]{4,20})/;
      const DC_URI_LINE = /打开网址[：:]\\s*(https?:\\/\\/\\S+)/;
      const sample = ['════════ 请在浏览器中完成授权 ════════',
                      '  1. 打开网址：https://www.microsoft.com/link',
                      '  2. 输入代码：ABCD-EFGH',
                      '  3. 用你的微软账号登录并点「允许」'].join('\\n');
      const mc = sample.match(DC_LINE);
      const mu = sample.match(DC_URI_LINE);
      out.code = mc ? mc[1] : null;
      out.uri = mu ? mu[1] : null;
      out.shown = !!out.code && !!out.uri;
    } catch (e) { out.error = String(e); }
    return out;
  })()`);

  // Exercise the packaged IPC path with a disabled offline click fixture.
  const segments = componentToRuns({
    translate: 'death.attack.mob', with: ['Tester', { translate: 'entity.minecraft.enderman' }],
    extra: [{ text: ' [离线点击检查]', color: 'gold',
      click_event: { action: 'run_command', command: '/fixture never-send' } }],
  });
  pushChat(segments.map((part) => part.text).join(''), { segments });
  const richChat = await win.webContents.executeJavaScript(`new Promise((resolve) => {
    setTimeout(() => {
      const buttons = [...document.querySelectorAll('#chat-view .chat-action')];
      resolve({ hasApi: typeof window.api.chatAction === 'function',
        text: document.getElementById('chat-view').textContent,
        buttons: buttons.length, allDisabled: buttons.every((button) => button.disabled) });
    }, 100);
  })`);
  const img = await win.webContents.capturePage();
  // 打包后 __dirname 在 asar 里不可写，统一落到 DATA_DIR
  const shot = path.join(DATA_DIR, 'ui_selftest.png');
  fs.mkdirSync(path.dirname(shot), { recursive: true });
  fs.writeFileSync(shot, img.toPNG());

  console.log('UI_SELFTEST=' + JSON.stringify({ ...probe, deviceCode: dcProbe, screenshot: shot }, null, 2));
  const ok = probe.missing.length === 0
    && probe.hasApi
    && probe.hasOpenExternal
    && probe.hasOnMetrics
    && probe.hasOnChat
    && probe.dcHiddenInitially
    && probe.monDetailHidden
    && probe.monCpuOk
    && probe.monMemOk
    && probe.curvesAbsent && probe.monitorOnLeft && probe.offlineInputAbsent
    && probe.title === PRODUCT_NAME
    && probe.chatTabActive
    && probe.logViewHidden
    && probe.chatViewVisible
    && probe.settingsInitiallyClosed
    && settingsProbe.opened && settingsProbe.cancelClosed && settingsProbe.saveVisible
    && settingsProbe.delay === '5' && settingsProbe.attempts === '10' && settingsProbe.monitorChecked
    && settingsProbe.closeBehavior === 'quit' && settingsProbe.claimMin === '0.4' && settingsProbe.claimMax === '0.85'
    && settingsProbe.welcomeMin === '0.4' && settingsProbe.welcomeMax === '0.85'
    && dcProbe.shown
    && presenceProbe.opened && presenceProbe.noSendBar
    && presenceProbe.hideByDefault && presenceProbe.listUnknown
    && presenceProbe.completionRejected && presenceProbe.staleMenuRejected
    && richChat.hasApi && richChat.buttons === 1 && richChat.allDisabled
    && richChat.text.includes('末影人');

  // ❗Windows 下 Electron GUI 进程的 stdout 常常拿不到（管道不接），
  //   所以结果同时落一份文件，自检/CI 都从文件读，不依赖 stdout。
  try {
    const report = { ok, probe, deviceCode: dcProbe, settings: settingsProbe, presence: presenceProbe, richChat, screenshot: shot, at: new Date().toISOString() };
    fs.writeFileSync(path.join(DATA_DIR, 'ui_selftest.json'), JSON.stringify(report, null, 2), 'utf8');
  } catch (e) { /* 落盘失败不影响退出码 */ }

  app.exit(ok ? 0 : 1);
}

/** 统一往界面推日志 */
function pushLog(level, text) {
  const timestamp = Date.now();
  historyStore.appendLog(level, text, timestamp);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('log', { level, text, t: timestamp });
  }
}

/** 往界面推一条聊天（与运行日志分开，界面有独立聊天页签） */
function pushChat(text, meta, { emit = true } = {}) {
  const data = {
    messageId: randomUUID(),
    text: String(text == null ? '' : text),
    type: (meta && meta.type) || 'system',
    category: parsePresence(text, (meta && meta.type) || 'system') ? 'presence'
      : chatCategory(String(text || ''), meta && meta.type),
    sender: (meta && meta.sender) || null,
    uuid: (meta && meta.uuid) || null,
    origin: (meta && meta.origin) || null,
    segments: chatActions.register((meta && meta.segments) || []),
    session: chatActions.session,
    serverKey: profileKey,
    account: client && client.username || '',
    t: Date.now(),
  };
  historyStore.appendChat(data);
  if (emit && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('chat', data);
  }
  return data;
}

function pushStatus(patch) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('status', patch);
  }
}

/* ---------------- 资源监控（CPU / 内存） ----------------
 * 监控跑在主进程，每 1 秒采样一次并推给界面。
 * ❗必须显式停表：否则窗口关了定时器还在跑，进程无法退出。
 */
function startMonitor() {
  if (monTimer) return;
  // 首次采样只作基线（CPU 需要两次采样做差分），不推给界面避免出现 0.0% 抖动
  monitor.reset({ preservePeaks: monitorInitialized }); monitorInitialized = true;
  monitor.sample({ getAppMetrics: () => app.getAppMetrics() });
  monTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) { stopMonitor(); return; }
    try {
      const m = monitor.sample({ getAppMetrics: () => app.getAppMetrics() });
      mainWindow.webContents.send('metrics', m);
    } catch (e) {
      // 采样失败不应拖垮整个应用，静默跳过这一拍
    }
  }, 1000);
}

function stopMonitor() {
  if (monTimer) { clearInterval(monTimer); monTimer = null; }
}

/** 停掉状态轮询（换连接 / 断线 / 关窗时都要调，否则定时器泄漏） */
function stopPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function stopConnectionDeadline() {
  if (connectionDeadline !== null) clearTimeout(connectionDeadline);
  connectionDeadline = null;
}

function saveDiagnostics(c, force = false) {
  if (!c || typeof c.getChatDiagnostics !== 'function' || (!force && Date.now() - diagnosticsSavedAt < 10000)) return;
  diagnosticsSavedAt = Date.now();
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    historyStore.writeCache('chat-diagnostics-last.json', { version: app.getVersion(), host: c.host, port: c.port,
      t: Date.now(), state: c.state, diagnostics: c.getChatDiagnostics() });
  } catch (e) { if (force) pushLog('error', '聊天诊断保存失败：' + e.message); }
}

/** 彻底拆掉当前客户端（先停轮询，再关 socket，最后清引用） */
function teardownClient() {
  connectionGeneration++;
  attention.cancel(chatActions.session, '连接会话已结束，旧动作不补发'); scheduleAttention();
  dailyPurchase.disconnected();
  chatActions.reset();
  welcomes.cancelScheduled();
  redPackets.resetPending();
  redPacketBatch.reset();
  stopPoll();
  stopConnectionDeadline();
  const c = client;
  client = null;
  presence.end();
  pushStatus({ players: presence.getOnline(), menu: null });
  if (c && typeof c.getChatDiagnostics === 'function') {
    const diagnostics = c.getChatDiagnostics();
    pushStatus({ chatDiagnostics: diagnostics });
    saveDiagnostics(c, true);
  }
  if (c) { try { c.close(); } catch (e) {} }
}

function unexpectedDisconnect(self, reason, retryable, kicked = false) {
  if (client !== self) return;
  attention.event('disconnect', '连接中断', contextInfo()); scheduleAttention();
  const handoff = kicked && connectionMode === 'standalone' && isDuplicateLoginReason(reason);
  const username = self.username;
  teardownClient();
  pushStatus({ event: 'close', connected: false, state: 'idle' });
  if (handoff) { startAutomaticBridge(username); return; }
  reconnect.lost(reason, retryable);
}

function handleChat(self, text, meta, target = self) {
  if (client !== self) return;
  if (meta?.type !== 'player' && meta?.origin !== 'player' && /(?:签到成功|已经签到|今日已签到|今天已签到)/.test(text)) {
    dailyPurchase.afterSignIn();
  }
  const presenceEvent = presence.record(text, (meta && meta.type) || 'system');
  if (presenceEvent) pushStatus({ players: presence.getOnline() });
  const serverKey = target.host.toLowerCase() + ':' + target.port;
  const batch = redPacketBatch.handle({ text, type: meta && meta.type, origin: meta && meta.origin,
    meta, serverKey, session: chatActions.session });
  // Batched claims, including Nan_Koi's, are already retained in the delayed log block.
  let players = [];
  try { players = self && typeof self.getPlayers === 'function' ? self.getPlayers() : []; } catch (_) {}
  const monitored = relatedMonitoredPlayers(text, meta, players,
    runtimeConfig && Array.isArray(runtimeConfig.monitoredPlayers)
      ? runtimeConfig.monitoredPlayers : ['Nan_Koi']);
  if (!batch.suppress && monitored.length) pushLog('chat', '[' + monitored.join('、') + '] ' + String(text));
  const message = pushChat(text, meta, { emit: !batch.suppress });
  const reasons = messageReasons(message, self.username, runtimeConfig?.monitoredPlayers, runtimeConfig?.notifications);
  if (reasons.length) {
    attention.important(message, reasons); notifyImportant(message.text, runtimeConfig.notifications, contextInfo()); scheduleAttention();
  }
  const safe = !!runtimeConfig && !runtimeConfig.__loadError
    && !(runtimeConfig.automation && runtimeConfig.automation.paused) && !self.automationBlocked && !suspended;
  const claimPolicy = JSON.stringify([runtimeConfig && runtimeConfig.automation && runtimeConfig.automation.claimDelay,
    normalizeClaimTrigger(runtimeConfig && runtimeConfig.automation || {})]);
  redPackets.handle(message, self, { enabled: safe
    && (!runtimeConfig.automation || runtimeConfig.automation.autoClaimRedPackets !== false), serverKey,
    delay: runtimeConfig && runtimeConfig.automation && runtimeConfig.automation.claimDelay,
    delayEnabled: !runtimeConfig || !runtimeConfig.automation || runtimeConfig.automation.claimDelayEnabled !== false,
    afterClaims: runtimeConfig && runtimeConfig.automation && runtimeConfig.automation.claimAfter,
    isCurrent: () => client === self && !!runtimeConfig && !runtimeConfig.__loadError
      && (!runtimeConfig.automation || runtimeConfig.automation.autoClaimRedPackets !== false)
      && !(runtimeConfig.automation && runtimeConfig.automation.paused) && !self.automationBlocked && !suspended
      && claimPolicy === JSON.stringify([runtimeConfig.automation && runtimeConfig.automation.claimDelay,
        normalizeClaimTrigger(runtimeConfig.automation || {})]) })
    .catch((e) => pushLog('error', '红包处理异常：' + e.message));
  welcomes.handle(message, self, { enabled: safe
    && runtimeConfig.automation && runtimeConfig.automation.autoWelcome === true, serverKey,
    delay: runtimeConfig && runtimeConfig.automation && runtimeConfig.automation.welcomeDelay,
    delayEnabled: !runtimeConfig || !runtimeConfig.automation || runtimeConfig.automation.welcomeDelayEnabled !== false,
    isCurrent: () => client === self && !!runtimeConfig && !runtimeConfig.__loadError
      && runtimeConfig.automation && runtimeConfig.automation.autoWelcome === true
      && !(runtimeConfig.automation && runtimeConfig.automation.paused) && !self.automationBlocked && !suspended })
    .catch((e) => pushLog('error', '自动欢迎异常：' + e.message));
}

function bridgeStatus() {
  return { mode: connectionMode, listening: !!bridge && !bridgeStarting,
    starting: !!bridge && bridgeStarting, detecting: !!bridge && !!bridge.handoff,
    paired: !!bridge && !!bridge.peer, online: !!client && client.state === 'play' && connectionMode === 'bridge',
    exiting: !!bridgeExitPending, disconnectSupported: !!client?.disconnectEnabled };
}

async function exitForOnlinePlayer(peer, player) {
  const rule = normalizeBridgeExit(runtimeConfig?.bridgeExit);
  if (connectionMode !== 'bridge' || client !== peer || peer.state !== 'play' || !bridge || bridgeExitPending
    || !rule.enabled || !rule.players.some((name) => name.toLowerCase() === player.toLowerCase())) return false;
  const own = bridge, session = peer.session, generation = connectionGeneration;
  const context = { host: peer.host, port: peer.port, username: peer.username,
    accountUuid: currentAccountUuid(), session };
  const pending = { peer, session, own };
  let confirmed = false;
  bridgeExitPending = pending; bridgeExitStopped = true;
  reconnect.stop(); clearBridgeDetection(own); stopPoll(); midnight.stop();
  attention.cancel(chatActions.session, '目标玩家在线，停止等待动作');
  welcomes.cancelScheduled(); redPackets.resetPending(); redPacketBatch.reset(); dailyPurchase.disconnected();
  peer.automationBlocked = true;
  pushStatus({ bridgeExitPending: true, bridge: bridgeStatus() });
  pushLog('automation', '检测到 ' + player + ' 在线，执行游戏下线；停止桥接与重连');
  try {
    const response = await peer.disconnectGame(player);
    confirmed = response?.ok === true;
    pushLog(response?.ok ? 'automation' : 'error', response?.ok
      ? bridgeFallbackAllowed(runtimeConfig?.bridgeFallback, 'exit') ? '游戏已执行下线，准备独立连接接管' : '游戏已执行下线，不自动重连'
      : '游戏下线未确认：' + (response?.error || '未知结果') + '；辅助已停止，不重试或重连');
  } catch (e) { pushLog('error', '游戏下线未确认：' + e.message + '；辅助已停止，不重试或重连'); }
  finally {
    if (bridgeExitPending === pending) { bridgeExitPending = null; pushStatus({ bridgeExitPending: false }); }
    if (bridge === own && connectionGeneration === generation) {
      const sameGame = peer.state === 'idle' || peer.state === 'play' && peer.session === session;
      teardownClient();
      const stoppedGeneration = connectionGeneration;
      await stopBridge();
      if (stoppedGeneration !== connectionGeneration || bridge || connectionMode !== 'bridge') return;
      pushStatus({ bridgeExitPending: false, connected: false, state: 'idle', bridge: bridgeStatus() });
      if (confirmed && sameGame) await connectAfterBridge(context, 'exit', stoppedGeneration);
    }
    scheduleAttention();
  }
  return true;
}

async function connectAfterBridge(context, cause, generation) {
  if (generation !== connectionGeneration || bridge || client || connectionMode !== 'bridge'
    || currentAccountUuid() !== context.accountUuid || profileKey !== profiles.serverKey(context)
    || suspended || loginBusy || connectBusy) return;
  const cfg = loadConfig();
  if (!bridgeFallbackAllowed(cfg.bridgeFallback, cause)) return;
  if (cfg.__loadError || cfg.automation?.paused) {
    pushLog('error', '独立接管已跳过：自动化已暂停或配置读取失败'); return;
  }
  let target;
  try { target = standaloneBridgeTarget(context, localCachedAccounts().accounts); }
  catch (e) { pushLog('error', '独立接管未启动：' + e.message); return; }
  const saved = saveConfig({ ...cfg, connectionMode: 'standalone' });
  if (!saved.ok) { pushLog('error', '独立接管未启动，模式保存失败：' + saved.error); return; }
  connectionMode = 'standalone';
  reconnect.start(target);
  const retryTarget = reconnect.target;
  pushStatus({ connectionMode, bridge: bridgeStatus(), connected: false, state: 'idle', chatSession: null });
  pushLog('net', '游戏下线已确认，使用同一账号独立连接原服务器；不补发入服问候或预设指令');
  const attempt = { cause };
  bridgeStandaloneAttempt = attempt;
  let result;
  try { result = await doConnect(target, true); }
  finally { if (bridgeStandaloneAttempt === attempt) bridgeStandaloneAttempt = null; }
  if (!result.ok && reconnect.target === retryTarget) {
    if (!reconnect.armed) reconnect.stop();
    pushLog('error', '独立接管未完成：' + result.error);
    if (!client) pushStatus({ connected: false, state: 'idle', connectionMode, bridge: bridgeStatus() });
  }
}

async function handoffOfflineBridge(own, context) {
  if (bridge !== own || connectionMode !== 'bridge' || own.standalonePending || bridgeExitPending) return;
  own.standalonePending = true;
  bridgeExitStopped = true;
  reconnect.stop(); teardownClient();
  const generation = connectionGeneration;
  await stopBridge();
  if (generation !== connectionGeneration || bridge || connectionMode !== 'bridge') return;
  pushStatus({ connected: false, state: 'idle', connectionMode, bridge: bridgeStatus(), chatSession: null });
  await connectAfterBridge(context, 'offline', generation);
}

function clearBridgeDetection(own) {
  if (!own || !own.handoff) return;
  clearTimeout(own.handoff.timer);
  own.handoff = null;
}

async function stopBridge() {
  const old = bridge; bridge = null;
  bridgeStarting = false;
  clearBridgeDetection(old);
  if (old) await old.stop();
}

async function failAutomaticBridge(own, reason) {
  if (bridge !== own || !own.handoff) return;
  teardownClient();
  const generation = connectionGeneration;
  await stopBridge();
  if (generation !== connectionGeneration || bridge) return;
  pushLog('error', reason + '；自动桥接已停止，不再独立重连');
  pushStatus({ connectionMode, connected: false, state: 'idle', bridge: bridgeStatus(), chatSession: null });
}

function startAutomaticBridge(username) {
  if (bridgeExitStopped || bridgeExitPending) return;
  reconnect.stop('异地登录，停止独立重连');
  if (!/^[A-Za-z0-9_]{1,16}$/.test(username || '')) {
    pushLog('error', '无法确认被踢账号，自动桥接未启动'); return;
  }
  const cfg = runtimeConfig || loadConfig();
  const saved = cfg.__loadError ? { ok: false, error: '配置读取失败' }
    : saveConfig({ ...cfg, connectionMode: 'bridge' });
  if (!saved.ok) { pushLog('error', '自动桥接未启动，模式保存失败：' + saved.error); return; }
  connectionMode = 'bridge';
  pushStatus({ connectionMode, connected: false, state: 'idle', bridge: bridgeStatus(), chatDiagnostics: null });
  pushLog('net', '检测到异地登录踢出，自动转为游戏桥接；最多检测本地游戏 30 秒');
  startBridge({ username }).then((result) => {
    if (!result.ok && !result.canceled) pushLog('error', result.error + '；自动桥接已停止，不再独立重连');
  }).catch((e) => pushLog('error', '自动桥接异常：' + e.message));
}

ipcMain.handle('bridge:status', () => bridgeStatus());
ipcMain.handle('client:mode', async (_e, mode) => {
  if (bridgeExitPending) return { ok: false, error: '正在执行游戏下线' };
  if (!['standalone', 'bridge'].includes(mode)) return { ok: false, error: '连接模式无效' };
  if (bridgeStarting) return { ok: false, error: '桥接正在启动，请稍候' };
  const cfg = runtimeConfig || loadConfig();
  if (cfg.__loadError) return { ok: false, error: '配置读取失败，无法保存连接模式' };
  const saved = saveConfig({ ...cfg, connectionMode: mode });
  if (!saved.ok) return { ok: false, error: '模式保存失败：' + saved.error };
  connectionMode = mode;
  reconnect.stop(); teardownClient(); await stopBridge();
  pushStatus({ connectionMode, bridge: bridgeStatus(), connected: false, state: 'idle', chatDiagnostics: null });
  return { ok: true };
});
ipcMain.handle('bridge:export', async () => {
  try {
    const value = pairing(path.join(DATA_DIR, 'bridge-pairing.json'));
    const result = await dialog.showSaveDialog(mainWindow, { title: '导出游戏桥接配对文件',
      defaultPath: 'mc-noclient-bridge.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(result.filePath, JSON.stringify({ ...value,
      discoveryDirectory: discoveryDirectory(DATA_DIR) }, null, 2), { mode: 0o600 });
    return { ok: true };
  } catch (e) { return { ok: false, error: '配对导出失败：' + e.message }; }
});
async function startBridge(automaticTarget = null) {
  if (bridgeExitPending || automaticTarget && bridgeExitStopped) return { ok: false, error: '已停止自动桥接，请手动启动' };
  if (connectionMode !== 'bridge') return { ok: false, error: '请先选择游戏桥接模式' };
  if (bridgeStarting || bridge) return { ok: false, error: '桥接已在运行或启动中' };
  if (!automaticTarget) bridgeExitStopped = false;
  bridgeStarting = true;
  reconnect.stop(); teardownClient();
  const own = new BridgeServer({ discoveryDirectory: discoveryDirectory(DATA_DIR),
    username: automaticTarget?.username || '' }); bridge = own;
  const generation = connectionGeneration;
  if (automaticTarget) {
    own.handoff = { username: automaticTarget.username, expiresAt: Date.now() + AUTO_BRIDGE_DETECTION_MS,
      timer: setTimeout(() => failAutomaticBridge(own, '30 秒内未检测到同一账号已进服的本地游戏 Mod'), AUTO_BRIDGE_DETECTION_MS) };
    pushStatus({ connectionMode, state: 'bridge-wait', bridge: bridgeStatus() });
  }
  own.on('fault', (e) => {
    if (bridge !== own || connectionMode !== 'bridge') return;
    pushLog('error', '本地桥接异常：' + e.message);
    if (own.handoff) failAutomaticBridge(own, '本地桥接监听失败');
  });
  own.on('attached', (peer) => {
    if (bridge !== own || connectionMode !== 'bridge') { peer.close(); return; }
    pushLog('net', '游戏桥接已配对，等待游戏连接');
    peer.on('state', (data) => {
      if (bridge !== own || connectionMode !== 'bridge') return;
      if (bridgeExitPending?.peer === peer) return;
      if (own.handoff && Date.now() >= own.handoff.expiresAt) {
        failAutomaticBridge(own, '本地游戏检测已超时'); return;
      }
      if (!data.online) {
        if (client === peer) { attention.event('disconnect', '游戏退出服务器，桥接等待', contextInfo()); attention.cancel(chatActions.session, '游戏会话结束，旧动作不补发'); scheduleAttention(); }
        dailyPurchase.disconnected();
        if (client === peer) { client = null; stopPoll(); chatActions.reset(); welcomes.cancelScheduled(); redPackets.resetPending(); redPacketBatch.reset(); presence.end(); }
        pushStatus({ connected: false, state: 'bridge-wait', bridge: bridgeStatus(),
          chatSession: null, players: presence.getOnline(), menu: null });
        const context = peer.bridgeTarget;
        if (!own.handoff && peer.offlineStateEnabled && data.gameDisconnected === true
          && context && data.offlineSession === context.session && runtimeConfig?.bridgeFallback === 'offline')
          handoffOfflineBridge(own, context).catch((e) => pushLog('error', '独立接管失败：' + e.message));
        return;
      }
      if (own.handoff) {
        if (peer.username.toLowerCase() !== own.handoff.username.toLowerCase()) {
          pushLog('net', '本地游戏账号与被踢账号不同，继续等待匹配的游戏 Mod');
          peer.close(); return;
        }
        clearBridgeDetection(own);
      }
      if (data.changed) {
        attention.cancel(chatActions.session, '游戏会话变化，旧动作不补发'); scheduleAttention();
        const saved = localCachedAccounts();
        const identity = saved.accounts.find((item) => item.name.toLowerCase() === peer.username.toLowerCase());
        const key = identity?.uuid || 'player:' + peer.username.toLowerCase();
        if (currentAccountUuid() !== key) {
          selectedAccountUuid = key; account = null; accountEpoch++;
          loadConfig();
          pushStatus({ ...accountStatusPayload(), profileChanged: true });
        }
        selectProfile(profiles.serverKey(peer));
        chatActions.reset(); welcomes.cancelScheduled(); redPackets.resetPending(); redPacketBatch.reset(); presence.end();
        client = peer; presence.start(peer.host, peer.port); stopPoll();
        peer.bridgeTarget = { host: peer.host, port: peer.port, username: peer.username,
          accountUuid: currentAccountUuid(), session: peer.session };
        dailyPurchase.connected(peer);
        pollTimer = setInterval(() => {
          if (client !== peer || peer.state !== 'play') return;
          dailyPurchase.tick();
          pushStatus({ state: 'play', uptime: peer.uptimeText(),
            recv: (peer.stats.received / 1024).toFixed(1), sent: (peer.stats.sent / 1024).toFixed(1), chats: peer.stats.chats });
        }, 1000);
        pushStatus({ event: 'join', connected: true, state: 'play', chatSession: chatActions.session,
          connectionMode, bridge: bridgeStatus(), target: { host: peer.host, port: peer.port },
          chatDiagnostics: null, menu: null });
        pushLog('net', '已接管游戏聊天通道；未另行登录服务器');
        pushLog('net', peer.monitorEnabled ? '游戏出站指令监测已启用；仅记录实际指令，不自动重放'
          : '当前桥接 Mod 未提供指令监测；更新桥接 Mod 后可启用，现有聊天桥接不受影响');
      }
      if (data.automationBlocked) pushLog('error', '检测到旧红包助手启用或配置异常，本会话自动动作已暂停');
      if (runtimeConfig?.bridgeExit?.enabled && !peer.disconnectEnabled)
        pushLog('error', '玩家上线下线需要桥接 Mod 1.5.0；当前 Mod 不支持游戏下线');
      if (data.changed && runtimeConfig?.bridgeFallback === 'offline' && !peer.offlineStateEnabled)
        pushLog('error', '普通游戏下线后的独立接管需要桥接 Mod 1.7.0；当前版本不报告明确离线状态');
    });
    peer.on('chat', (text, meta) => handleChat(peer, text, meta));
    peer.on('purchaseMenu', (menu) => {
      if (client === peer && peer.state === 'play') dailyPurchase.onMenu(menu);
    });
    peer.on('observation', (event) => {
      if (client !== peer || peer.state !== 'play' || bridge !== own || connectionMode !== 'bridge') return;
      const text = formatObservation(event);
      if (text) pushLog('net', text);
    });
    peer.on('players', (players) => {
      if (client !== peer || peer.state !== 'play') return;
      presence.updatePlayers(players); pushStatus({ players: presence.getOnline() });
      bridgeExitGuard.observe(peer, runtimeConfig?.bridgeExit);
    });
    pushStatus({ state: 'bridge-wait', bridge: bridgeStatus() });
  });
  own.on('detached', (peer) => {
    if (bridge !== own || connectionMode !== 'bridge') return;
    if (bridgeExitPending?.peer === peer) return;
    attention.event('disconnect', '游戏桥接断开', contextInfo()); attention.cancel(chatActions.session, '游戏桥接断开，旧动作不补发'); scheduleAttention();
    dailyPurchase.disconnected();
    if (client === peer) { client = null; stopPoll(); chatActions.reset(); welcomes.cancelScheduled(); redPackets.resetPending(); redPacketBatch.reset(); presence.end(); }
    pushLog('net', '游戏桥接断开；不登录服务器，等待本地重新配对');
    pushStatus({ connected: false, state: 'bridge-wait', bridge: bridgeStatus(), players: presence.getOnline(), menu: null });
  });
  try {
    loadConfig();
    const config = pairing(path.join(DATA_DIR, 'bridge-pairing.json'), { create: !automaticTarget });
    const port = await own.start(config);
    if (generation !== connectionGeneration || bridge !== own || connectionMode !== 'bridge') {
      await own.stop(); return { ok: false, canceled: true, error: '桥接启动已取消' };
    }
    bridgeStarting = false;
    pushStatus({ state: client && client.state === 'play' ? 'play' : 'bridge-wait', connectionMode, bridge: bridgeStatus(), chatDiagnostics: null });
    pushLog('net', '本地桥接已启动，等待游戏 Mod；不会执行入服问候或预设业务指令');
    if (Number.isInteger(port) && port !== config.port)
      pushLog('net', '已使用独立桥接端口，不影响其他窗口；多开需 Mod 1.6.0 并从 V6.3 重新导出一次配对');
    return { ok: true };
  } catch (e) {
    const current = generation === connectionGeneration && bridge === own;
    clearBridgeDetection(own);
    if (bridge === own) { bridge = null; bridgeStarting = false; }
    await own.stop();
    if (!current || generation !== connectionGeneration || bridge) return { ok: false, canceled: true, error: '桥接启动已取消' };
    pushStatus({ connected: false, state: 'idle', connectionMode, bridge: bridgeStatus() });
    return { ok: false, error: '桥接启动失败（检查配对文件或本地端口占用）：' + e.message };
  } finally { if (bridge === own) bridgeStarting = false; }
}
ipcMain.handle('bridge:start', () => startBridge());

/* ---------------- IPC：配置 ---------------- */

ipcMain.handle('config:get', () => loadConfig());
ipcMain.handle('config:save', (_e, cfg) => saveConfig(cfg));
ipcMain.handle('profile:select', (_e, target) => {
  if (client || connectBusy || reconnect.phase !== 'idle') return { ok: false, error: '连接或重连期间不能切换配置' };
  if (!baseConfig) loadConfig();
  selectProfile(profiles.serverKey(target));
  return { ok: true, config: runtimeConfig };
});
ipcMain.handle('attention:get', (_e, request = {}) => ({ ...attention.snapshot(profileKey, request.details !== false), profileKey,
  availability: { connected: client?.state === 'play', paused: !!runtimeConfig?.automation?.paused,
    suspended, claim: !!runtimeConfig?.automation?.autoClaimRedPackets,
    welcome: !!runtimeConfig?.automation?.autoWelcome, autoPurchase: runtimeConfig?.autoPurchase === true,
    bridge: connectionMode === 'bridge' } }));
ipcMain.handle('attention:read', (_e, request = {}) => {
  if (request.profileKey !== profileKey || !Array.isArray(request.ids) || request.ids.length > 100
    || request.ids.some((id) => typeof id !== 'string' || id.length > 64)) return { ok: false };
  if (mainWindow?.isFocused && !mainWindow.isFocused()) return { ok: false };
  if (attention.markRead(profileKey, request.ids)) scheduleAttention();
  return { ok: true };
});
ipcMain.handle('attention:pause', () => {
  const cfg = loadConfig();
  return saveConfig({ ...cfg, automation: { ...cfg.automation, paused: !cfg.automation?.paused } });
});
ipcMain.handle('attention:source', (_e, request = {}) => {
  if (typeof request.messageId !== 'string' || request.messageId.length > 64) return { records: [] };
  const result = historyStore.read('chat', { messageId: request.messageId, limit: 1, cursor: request.cursor });
  result.records = result.records.map((r) => ({ ...r, segments: [] }));
  return result;
});
// 界面上的「数据目录」按钮 / 排查用：告诉界面配置到底存在哪
ipcMain.handle('config:path', () => CONFIG_PATH);
ipcMain.handle('history:path', () => historyStore.path());
ipcMain.handle('history:chat', (_e, request = {}) => {
  const before = Number.isFinite(request.before) ? request.before : Infinity;
  const limit = Math.max(1, Math.min(400, Number.isInteger(request.limit) ? request.limit : 400));
  const result = historyStore.read('chat', { before, limit, cursor: request.cursor });
  // Archived messages keep only the server-provided action data. Re-register
  // actions for the current connection so renderer reloads do not turn live
  // clickable messages into plain text; old connection sessions stay inert.
  result.records = result.records.map((record) => {
    if (!record || record.session !== chatActions.session || !Array.isArray(record.segments)
      || !record.segments.some((part) => part && part.click)) {
      return { ...record, segments: [] };
    }
    return { ...record, segments: chatActions.register(record.segments) };
  });
  return result;
});
ipcMain.handle('history:choose-path', async () => {
  if (!dialog || typeof dialog.showOpenDialog !== 'function') return { ok: false, error: '当前环境不支持选择目录' };
  const result = await dialog.showOpenDialog(mainWindow, { title: '选择聊天、日志与缓存目录', properties: ['openDirectory', 'createDirectory'] });
  if (result.canceled || !result.filePaths || !result.filePaths[0]) return { ok: false, canceled: true };
  return { ok: true, path: path.resolve(result.filePaths[0]) };
});
ipcMain.handle('history:reveal', () => {
  shell.openPath(historyStore.path());
  return historyStore.path();
});
ipcMain.handle('app:diagnosticReport', () => {
  const cfg = runtimeConfig || loadConfig();
  const report = {
    version: app.getVersion(), generatedAt: new Date().toISOString(), platform: process.platform,
    arch: process.arch, node: process.versions.node, electron: process.versions.electron,
    dataPath: DATA_DIR, historyPath: historyStore.path(), connectionMode,
    config: { servers: (cfg.servers || []).map((server) => ({ name: server.name, host: server.host, port: server.port })),
      display: cfg.display, storage: cfg.storage, monitoredPlayers: cfg.monitoredPlayers,
      automation: { autoClaimRedPackets: cfg.automation && cfg.automation.autoClaimRedPackets,
        autoWelcome: cfg.automation && cfg.automation.autoWelcome,
        paused: cfg.automation && cfg.automation.paused } },
    bridge: bridgeStatus(),
    client: client ? { state: client.state, host: client.host, port: client.port,
      diagnostics: typeof client.getChatDiagnostics === 'function' ? client.getChatDiagnostics() : null } : null,
  };
  const file = 'diagnostic-report-' + Date.now() + '.json';
  historyStore.writeCache(file, report);
  return { ok: true, path: path.join(historyStore.path(), 'cache', file) };
});
ipcMain.handle('app:reloadRenderer', () => {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) mainWindow.webContents.reload();
  return { ok: true };
});
ipcMain.handle('presence:online', () => presence.getOnline());
ipcMain.handle('purchase:get', () => { if (client?.state === 'play') dailyPurchase.load(client); return dailyPurchase.snapshot(); });
ipcMain.handle('purchase:retry', () => dailyPurchase.retry());
ipcMain.handle('client:complete', (_e, text) => client && client.state === 'play'
  && typeof client.completeCommand === 'function' ? client.completeCommand(text) : { ok: false, error: '未连接服务器' });
ipcMain.handle('client:closeMenu', (_e, request) => {
  if (dailyPurchase.run) return { ok: false, error: '正在采集每日收购' };
  const id = request && typeof request === 'object' ? request.id : request;
  if (!Number.isInteger(id) || !client || typeof client.closeMenu !== 'function') return { ok: false, error: '菜单已失效' };
  if (request && typeof request === 'object' && (!client.features || !client.features.menu
    || request.token !== client.features.menu.token)) return { ok: false, error: '菜单已失效' };
  return { ok: client.closeMenu(id) };
});
ipcMain.handle('client:clickMenu', (_e, request) => {
  if (dailyPurchase.run) return { ok: false, error: '正在采集每日收购' };
  if (connectionMode !== 'standalone' || !client || client.state !== 'play'
    || typeof client.clickMenu !== 'function') return { ok: false, error: '当前连接不支持菜单点击' };
  if (!request || typeof request !== 'object' || !Number.isInteger(request.id) || request.id < 1
    || typeof request.token !== 'string' || !/^[a-f0-9-]{36}$/.test(request.token)
    || !Number.isSafeInteger(request.revision) || request.revision < 0
    || !Number.isInteger(request.slot) || request.slot < 0 || request.slot >= 54
    || ![0, 1].includes(request.button)) return { ok: false, error: '菜单点击参数无效' };
  try { return client.clickMenu(request); }
  catch (e) { return { ok: false, error: '菜单点击未确认，不会自动重试' }; }
});

/* ---------------- IPC：资源监控 ---------------- */

// 界面刚加载时先主动拉一次，避免等满 1 秒才有数字
ipcMain.handle('metrics:get', () => {
  try {
    return monitor.sample({ getAppMetrics: () => app.getAppMetrics() });
  } catch (e) {
    return null;
  }
});

/* ---------------- IPC：账号 ---------------- */

ipcMain.handle('account:peek', () => localCachedAccounts());

ipcMain.handle('account:login', async (_e, request) => {
  const options = typeof request === 'boolean' ? { forceInteractive: request } : (request || {});
  if (client || connectBusy || bridge || reconnect.phase !== 'idle') {
    return { ok: false, error: '当前仍连接着服务器，请先断开后再添加或重新授权账号' };
  }
  // 防重入：用户连点会同时申请多个设备代码，界面上的代码会来回跳，体验很糟
  if (loginBusy || loginPromise) {
    return { ok: false, error: '授权流程正在进行中，请在浏览器里完成当前这次授权' };
  }
  loginBusy = true;
  const epoch = accountEpoch;
  try {
    const next = await auth.login({
      forceInteractive: !!options.forceInteractive,
      accountUuid: options.accountUuid || currentAccountUuid() || undefined,
      log: (m) => pushLog('auth', m),
    });
    if (epoch !== accountEpoch) return { ok: false, error: '登录已取消' };
    activateAccount(next);
    return { ok: true, profile: account.profile };
  } catch (e) {
    pushLog('error', '登录失败：' + e.message);
    return { ok: false, error: e.message };
  } finally {
    loginBusy = false;
  }
});

ipcMain.handle('account:switch', async (_e, uuid) => {
  if (client || connectBusy || bridge || reconnect.phase !== 'idle') return { ok: false, error: '请先断开连接、桥接或停止重连，再切换账号' };
  if (loginBusy || loginPromise) return { ok: false, error: '账号授权或切换正在进行中，请稍候' };
  const target = String(uuid || '');
  const saved = auth.peekCachedAccounts();
  if (!saved.accounts.some((item) => item.uuid === target)) {
    return { ok: false, error: '没有找到这个本地账号' };
  }
  loginBusy = true;
  const epoch = accountEpoch;
  try {
    const next = await auth.login({
      silentOnly: true,
      accountUuid: target,
      log: (m) => pushLog('auth', m),
    });
    if (epoch !== accountEpoch) return { ok: false, error: '账号切换已取消' };
    activateAccount(next);
    return { ok: true, profile: account.profile };
  } catch (e) {
    pushLog('error', '切换账号失败：' + e.message);
    return { ok: false, error: e.message };
  } finally {
    loginBusy = false;
  }
});

ipcMain.handle('account:logout', () => {
  const uuid = currentAccountUuid();
  if (uuid && typeof auth.removeCachedAccount === 'function') auth.removeCachedAccount(uuid);
  else if (uuid) auth.clearCache();
  accountEpoch++;
  account = null;
  selectedAccountUuid = '';
  reconnect.stop();
  // 退出账号后若正连着正版服，连接其实已经无效了，一并断开更诚实
  teardownClient();
  stopBridge();
  loadConfig();
  connectionMode = runtimeConfig.connectionMode;
  pushStatus({ ...accountStatusPayload(), profileChanged: true, connectionMode, connected: false, state: 'idle', bridge: bridgeStatus() });
  return { ok: true };
});

/* ---------------- IPC：服务器查询 ---------------- */

ipcMain.handle('server:ping', async (_e, { host, port }) => {
  if (process.argv.includes('--selftest-ui')) return { ok: false, error: 'UI selftest does not query servers' };
  try {
    const r = await pingServer(host, port || 25565, 8000);
    return { ok: true, data: r };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

/* ---------------- IPC：连接控制 ---------------- */

/* ---------------- 连接核心（手点 / 启动自动登录 共用同一套逻辑） ----------------
 *
 * 抽成独立函数的原因：启动自动登录和用户点「连接」必须走**完全一样**的路径，
 * 否则两条路会各自演化、其中一条悄悄坏掉（这是以前踩过的坑）。
 * 主进程内部直接调用它，不再走 IPC 绕一圈。
 */
async function doConnect({ host, port, username, usePremium, accountUuid }, automatic = false) {
  if (!runtimeConfig) loadConfig();
  if (loginBusy) return { ok: false, error: '账号授权或切换正在进行中，请稍候', retryable: false };
  if (automatic && usePremium && (!accountUuid || accountUuid !== currentAccountUuid()))
    return { ok: false, error: '重连账号已失效，需要手动登录原账号', retryable: false };
  if (connectionMode === 'bridge') return { ok: false, error: '游戏桥接模式禁止独立登录', retryable: false };
  // ❗互斥：没有这个锁，用户在"连接中"连点两次会让两个 MCClient 同时握手，
  //   后一个覆盖 client 变量，前一个 socket 变成没人管的野连接（持续占用服务器名额）。
  if (connectBusy) {
    return { ok: false, error: '上一次连接还在进行中，请稍候' };
  }
  connectBusy = true;

  try {
    teardownClient();

    const generation = connectionGeneration;

    loadConfig();
    selectProfile(profiles.serverKey({ host, port }));
    const cfg = runtimeConfig;
    const bh = cfg.behavior || {};

    // 正版模式但没有登录账号 → 静默续期（走共享 Promise，与启动自动登录收敛成一条链）
    if (usePremium && automatic) account = null;
    if (usePremium && !account) {
      pushLog('auth', '正版模式需要账号，正在尝试用本地凭据免密续期…');
      try {
        const renewed = await ensureAccount((m) => pushLog('auth', m), accountUuid || currentAccountUuid());
        if (generation !== connectionGeneration) return { ok: false, error: '连接已取消', retryable: false };
        account = renewed;
        pushStatus(accountStatusPayload());
      } catch (e) {
        pushLog('error', '请先登录微软账号，再连接正版验证服');
        return { ok: false, error: '尚未登录微软账号：' + e.message,
          retryable: !!e.temporary || isRetryableReason(e.message) };
      }
    }

    if (generation !== connectionGeneration) return { ok: false, error: '连接已取消', retryable: false };
    if (usePremium && (!account || accountUuid && account.profile.id !== accountUuid
      || !reconnect.bindAccount(account.profile.id)))
      return { ok: false, error: '重连账号身份不一致，需要手动登录原账号', retryable: false };

    // 局部变量持有本次连接，回调里一律引用它 ——
    // 避免"用户又点了另一个服"时旧连接的回调误操作新 client
    let self = null;
    let failure = null;
    const isCurrent = () => client !== null && client === self;

    const opts = {
      host,
      port: port || 25565,
      username: usePremium && account ? account.profile.name : username,
      log: (m) => { if (isCurrent()) pushLog('net', m); },
      onChat: (text, meta) => {
        if (!isCurrent()) return;
        handleChat(self, text, meta, { host, port: port || 25565 });
      },
      onEvent: (ev, data, details = {}) => {
        if (!isCurrent()) return;      // 已被新连接替换的旧连接，事件一律丢弃
        if (ev === 'players') { presence.updatePlayers(data); pushStatus({ players: presence.getOnline() }); return; }
        if (ev === 'menu') { if (!dailyPurchase.onMenu(data)) pushStatus({ menu: data }); return; }
        if (ev === 'close' || ev === 'kick') {
          const reason = typeof data === 'string' ? data : (data && data.reason) || '网络连接已关闭';
          const retryable = details.retryable !== false && !(data && data.retryable === false)
            && isRetryableReason(reason);
          failure = { ok: false, error: reason, retryable };
          unexpectedDisconnect(self, reason, retryable, ev === 'kick');
          return;
        }
        if (ev === 'need-auth' || (ev === 'error' && details.retryable === false)) {
          failure = { ok: false, error: data || '需要登录账号', retryable: false };
          reconnect.stop(failure.error);
          teardownClient();
          pushStatus({ event: ev, connected: false, state: 'idle' });
          return;
        }
        if (ev === 'reconfig') {
          attention.cancel(chatActions.session, '服务器重新配置，旧动作不补发'); scheduleAttention();
          dailyPurchase.disconnected(); chatActions.reset(); welcomes.cancelScheduled(); redPackets.resetPending(); redPacketBatch.reset(); presence.end(); pushStatus({ players: presence.getOnline(), menu: null });
        }
        pushStatus({ event: ev, chatSession: chatActions.session, target: { host, port: port || 25565 } });
        if (ev === 'join') {
          self.autoPurchaseEnabled = cfg.profileVersion === 1 ? cfg.autoPurchase === true : self.autoPurchaseEnabled;
          attention.event('connected', '连接已恢复或进入服务器', contextInfo());
          if (recoveredFromMaintenance && runtimeConfig?.notifications?.connection) {
            attention.important({ ...contextInfo(), messageId: randomUUID(), text: '维护等待结束，连接已恢复' }, ['维护结束']);
            notifyImportant('维护等待结束，连接已恢复', runtimeConfig.notifications, contextInfo());
          }
          recoveredFromMaintenance = false; scheduleAttention();
          dailyPurchase.connected(self);
          presence.start(host, port || 25565);
          diagnosticsSavedAt = 0;
          stopConnectionDeadline();
          reconnect.joined();
          pushStatus({ connected: true, state: 'play' });
          setTimeout(() => {
            if (!isCurrent() || self.state !== 'play') return;
            // Automatic recovery must not repeat greetings or business commands.
            if (!automatic) {
              if (bh.greet) self.say(bh.greet);
              for (const c of (bh.commands || [])) self.command(c);
            }
            self.sendClientSettings();
          }, 1500);
        }
      },
    };

    if (usePremium && account) {
      opts.accessToken = account.accessToken;
      opts.profileId = account.profile.id;
      opts.uuid = account.profile.id;          // 正版必须用真实 UUID
    }

    self = new MCClient(opts);
    client = self;
    pushStatus({ state: 'login', target: { host, port: port || 25565 },
      chatDiagnostics: typeof self.getChatDiagnostics === 'function' ? self.getChatDiagnostics() : null });
    connectionDeadline = setTimeout(() => {
      if (!isCurrent() || self.state === 'play') return;
      failure = { ok: false, error: '登录或配置阶段超时', retryable: true };
      pushLog('error', failure.error);
      unexpectedDisconnect(self, failure.error, true);
    }, 45000);

    try {
      await self.connect();
    } catch (e) {
      if (failure) return failure;
      if (generation !== connectionGeneration) return { ok: false, error: '连接已取消', retryable: false };
      pushLog('error', '连接失败：' + e.message);
      if (client === self) teardownClient();
      return { ok: false, error: e.message, retryable: isRetryableReason(e.message) };
    }

    if (generation !== connectionGeneration || client !== self || self.state === 'closed') {
      self.close();
      return failure || { ok: false, error: '连接已取消或已关闭', retryable: false };
    }

    // 启动状态轮询，把在线时长等信息推给界面
    stopPoll();
    pollTimer = setInterval(() => {
      if (!client || client.state === 'closed') {
        if (client) unexpectedDisconnect(client, '网络连接已关闭', true);
        else stopPoll();
        return;
      }
      saveDiagnostics(client);
      dailyPurchase.tick();
      pushStatus({
        state: client.state,
        uptime: client.uptimeText(),
        recv: (client.stats.received / 1024).toFixed(1),
        sent: (client.stats.sent / 1024).toFixed(1),
        chats: client.stats.chats,
        encrypted: client.encrypted,
        premium: client.isPremium,
        chatDiagnostics: typeof client.getChatDiagnostics === 'function' ? client.getChatDiagnostics() : null,
      });
    }, 1000);

    return { ok: true };
  } finally {
    connectBusy = false;
  }
}

ipcMain.handle('client:connect', async (_e, opts) => {
  if (bridgeExitPending) return { ok: false, error: '正在执行游戏下线' };
  if (!runtimeConfig) loadConfig();
  if (connectionMode === 'bridge') return { ok: false, error: '游戏桥接模式禁止独立登录' };
  if (connectBusy) return { ok: false, error: '上一次连接还在进行中，请稍候' };
  const target = { ...opts, accountUuid: opts.usePremium ? currentAccountUuid() || undefined : undefined };
  reconnect.start(target);
  const result = await doConnect(target);
  if (!result.ok && !reconnect.armed) reconnect.stop();
  return result;
});

ipcMain.handle('client:disconnect', async () => {
  if (bridgeExitPending) return { ok: false, error: '正在执行游戏下线，请等待结果' };
  reconnect.stop();
  teardownClient();
  if (bridge) await stopBridge();
  pushStatus({ connected: false, state: 'idle' });
  return { ok: true };
});

ipcMain.handle('client:say', async (_e, text) => {
  if (bridgeExitPending) return { ok: false, error: '正在执行游戏下线' };
  if (!client || client.state !== 'play') return { ok: false, error: '未连接' };
  if (typeof text !== 'string' || !text.trim() || text.length > 32767 || /[\r\n\0]/.test(text)) {
    return { ok: false, error: '消息内容无效' };
  }
  const response = await (text.startsWith('/') ? client.command(text.slice(1)) : client.say(text));
  const ok = response === true || !!response && response.ok === true;
  if (!ok) return { ok: false, error: response && response.error || '消息未发送，连接已断开' };
  if (text.startsWith('/') && (text === runtimeConfig?.midnightCommand?.command || /^\/(?:signin|sign|qd|checkin)(?:\s|$)/i.test(text))) dailyPurchase.afterSignIn();
  return { ok: true };
});

ipcMain.handle('client:chatAction', async (_e, id) => {
  if (bridgeExitPending) return { ok: false, error: '正在执行游戏下线' };
  try {
    const action = chatActions.actions.get(id);
    if (action && action.action === 'run_command') {
      redPackets.cancelCommand(action.value, chatActions.session);
      welcomes.cancelCommand(action.value, chatActions.session);
    }
    return await chatActions.activate(id, client, async (url) => {
      const result = await dialog.showMessageBox(mainWindow, {
        type: 'question', title: '打开服务器提供的链接', message: '是否在浏览器中打开此链接？',
        detail: url, buttons: ['取消', '打开'], defaultId: 0, cancelId: 0,
      });
      if (result.response !== 1) return false;
      await shell.openExternal(url);
      return true;
    });
  } catch (e) {
    return { ok: false, error: '点击未完成：' + e.message };
  }
});

ipcMain.handle('app:revealData', () => {
  shell.openPath(DATA_DIR);
  return DATA_DIR;
});

// 用系统浏览器打开网址（设备代码提示条上的「重新打开」按钮用）
ipcMain.handle('app:openExternal', async (_e, url) => {
  // 只允许 http/https，防止渲染进程被注入后拿它去开本地文件/自定义协议
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { ok: false, error: '只允许打开 http/https 链接' };
    }
    await shell.openExternal(u.toString());
    return { ok: true };
  } catch (e) {
    return { ok: false, error: '网址无效：' + (e && e.message) };
  }
});

/* ---------------- 生命周期 ---------------- */

/* ---------------- 启动自动登录 ----------------
 *
 * 用户要求：「自动免密登录账号即可」——**只登录账号，不自动连接服务器**。
 * 服务器仍然由用户手动点「连接」决定，程序不替他做这个决定。
 *
 * 语义：
 *   1. 静默续期微软账号（只用本地 refresh_token，**不走设备代码流**）
 *      —— 缓存失效就跳过并提示手动登录，而不是弹一个要等 15 分钟的授权码
 *   2. 没有账号 → 什么都不做，只打一行日志，界面照常可用
 *
 * ❗时机很关键：必须等渲染进程 **did-finish-load** 之后再跑。
 *   否则日志/状态推送发生在界面挂载监听器之前，用户看不到任何过程，
 *   会以为"软件卡住了"。
 */
async function runAutoLogin() {
  const cfg = loadConfig();
  if (connectionMode === 'bridge') return;
  if (!cfg.autoLogin) {
    pushLog('net', '启动自动登录已关闭（可在设置中打开）');
    return;
  }

  const cached = localCachedAccounts().active;
  if (!cached) {
    pushLog('auth', '未发现已保存的账号，跳过自动登录；需要时点「登录微软账号」');
    return;
  }

  pushLog('auth', `启动自动登录：正在用本地凭据为 ${cached.name} 免密续期…`);
  try {
    // ❗走共享 Promise：用户此时若立刻点连接，doConnect 会 await 同一条链，
    //   不会并发开第二条授权链（否则微软侧会话串扰 → unverified_username）。
    account = await ensureAccount((m) => pushLog('auth', m));
    pushStatus(accountStatusPayload());
    pushLog('ok', `自动登录成功：${account.profile.name}（选好服务器后点「连接」即可）`);
  } catch (e) {
    // 续期失败不算致命错误 —— 缓存可能过期了，提示用户手动登录即可
    pushLog('auth', '自动登录未完成：' + e.message);
    pushLog('auth', '点「登录微软账号」可手动完成一次授权，之后就能继续自动登录');
  }
}

function handleSystemSuspend() {
  suspended = true; attention.away(); attention.event('gap', '系统休眠，期间未观察服务器', contextInfo());
  if (bridgeStandaloneAttempt) { reconnect.stop(); teardownClient(); }
  attention.cancel(chatActions.session, '系统休眠，旧动作不补发');
  welcomes.cancelScheduled(); redPackets.resetPending(); dailyPurchase.disconnected(); midnight.stop(); scheduleAttention();
}
async function handleSystemResume() {
  suspended = false; attention.event('resume', '系统恢复，连接需要重新校验', contextInfo());
  reconnect.stop(); teardownClient(); await stopBridge();
  const resumed = loadConfig(); if (!resumed.automation?.paused) midnight.start();
  pushStatus({ connected: false, state: 'idle', bridge: bridgeStatus() }); scheduleAttention();
}

app.whenReady().then(() => {
  if (process.argv.includes('--selftest-ui')) {
    runUiSelftest().catch((e) => {
      console.error('UI_SELFTEST_FAIL', e && e.message);
      app.exit(1);
    });
    return;
  }
  const win = createWindow();
  if (process.platform === 'win32' && typeof app.setAppUserModelId === 'function') app.setAppUserModelId('xyz.baixur.mc-noclient');
  startMonitor();
  loadConfig();
  if (!runtimeConfig || !runtimeConfig.automation || !runtimeConfig.automation.paused) midnight.start();
  if (powerMonitor) {
    powerMonitor.on('suspend', handleSystemSuspend);
    powerMonitor.on('resume', () => handleSystemResume().catch((e) => pushLog('error', '恢复连接状态失败：' + e.message)));
  }
  // 等界面真正加载完再自动登录，否则过程日志用户看不到
  win.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      runAutoLogin().catch((e) => pushLog('error', '自动登录异常：' + (e && e.message)));
    }, 800);          // 让渲染进程先跑完 init()、挂好监听器
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) { createWindow(); startMonitor(); }
    else windowLifecycle.restore();
  });
});

app.on('window-all-closed', () => {
  reconnect.stop();
  teardownClient();
  stopBridge();
  stopMonitor();
  midnight.stop();
  if (process.platform !== 'darwin') app.quit();
});

// 兜底：无论从哪条路退出，都别留下野 socket 和定时器
app.on('before-quit', () => {
  reconnect.stop(); teardownClient(); stopBridge(); stopMonitor(); midnight.stop();
  if (attentionTimer !== null) clearTimeout(attentionTimer);
  if (notifyTimer !== null) clearTimeout(notifyTimer);
  historyStore.close();
});
