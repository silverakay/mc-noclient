'use strict';
/*
 * configstore.js —— 配置的读 / 写 / 迁移（可独立测试）
 *
 * 为什么单独拎出来：
 *   原来这套逻辑内联在 app/main.js 里，而 main.js 依赖 Electron 的 app 对象，
 *   纯 Node 跑不起来 → **没法写测试** → "便携版丢配置"这种 bug 只能靠用户发现。
 *   现在把纯逻辑抽出来，路径由调用方注入，Node 下也能完整测试。
 *
 * ❗核心教训（v2.2.1 修的 bug）：
 *   旧版把配置放在 exe 同级目录。便携版(portable)运行时会把自身解压到
 *   **随机临时目录**再启动，于是配置写进临时目录、退出即随临时目录销毁，
 *   下次启动路径又变了 → 用户看到"我加的服务器每次都没了"。
 *   正解：放到用户级固定目录（%APPDATA%\<productName>），三种运行形态共用。
 */

const fs = require('fs');
const path = require('path');
const { normalizeReconnect } = require('./reconnect');
const { normalizeMidnight } = require('./midnight_command');
const { normalizeClaimDelay, normalizeClaimTrigger } = require('./red_packet');
const { normalizeWelcomeDelay } = require('./welcome');
const { normalizeChatBlocklist } = require('./chat_filter');
const { upgradeProfiles } = require('./server_profiles');
const { validAccountKey, saveAccount } = require('./account_profiles');
const { withFileLock } = require('./file_lock');
const { normalizeBridgeFallback } = require('./bridge_handoff');

const LOG_LIMITS = new Set([200, 400, 800]);
const DEFAULT_MONITORED_PLAYERS = ['Nan_Koi'];

function normalizeMonitoredPlayers(value) {
  if (!Array.isArray(value)) return DEFAULT_MONITORED_PLAYERS.slice();
  const seen = new Set();
  return value.filter((name) => typeof name === 'string' && /^[A-Za-z0-9_]{1,16}$/.test(name))
    .map((name) => name.trim())
    .filter((name) => {
      const key = name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }).slice(0, 64);
}

function normalizeHistoryPath(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && path.isAbsolute(text) && text.length <= 1024 ? path.resolve(text) : '';
}

function defaultConfig() {
  return {
    username: 'Steve',
    servers: [
      { name: '本地测试服', host: '127.0.0.1', port: 25565 },
    ],
    behavior: { showChat: true, greet: '', commands: [] },
    // 启动时自动登录账号（免密续期）。服务器仍由用户手动点「连接」。
    autoLogin: true,
    connectionMode: 'standalone',
    bridgeFallback: 'exit',
    closeBehavior: 'quit',
    reconnect: normalizeReconnect(),
    display: { autoScroll: true, showMonitor: true, hidePresence: true, logLimit: 800, chatBlocklist: [] },
    storage: { path: '', retentionDays: 7 },
    monitoredPlayers: [],
    automation: { autoClaimRedPackets: true, autoWelcome: true, paused: false, welcomeDelayEnabled: true,
      welcomeDelay: normalizeWelcomeDelay(), claimDelay: normalizeClaimDelay(), ...normalizeClaimTrigger() },
    midnightCommand: normalizeMidnight(),
    shortcuts: [],
    profileVersion: 1,
    serverProfiles: {},
  };
}

/** 把外部读到的对象规范化，手改坏了也不至于崩 */
function normalize(parsed, nested = false) {
  const out = (parsed && typeof parsed === 'object') ? parsed : {};
  if (!Array.isArray(out.servers)) out.servers = [];
  if (typeof out.username !== 'string' || !out.username) out.username = 'Steve';
  if (!out.behavior || typeof out.behavior !== 'object') out.behavior = {};

  // ❗autoLogin 默认开：老配置文件里没有这个字段时应当继承"新用户默认开启"的行为，
  //   否则用户升级后功能像是没生效。只有显式写成 false 才关闭。
  if (typeof out.autoLogin !== 'boolean') out.autoLogin = true;
  out.connectionMode = out.connectionMode === 'bridge' ? 'bridge' : 'standalone';
  out.bridgeFallback = normalizeBridgeFallback(out.bridgeFallback);
  out.closeBehavior = out.closeBehavior === 'background' ? 'background' : 'quit';
  out.reconnect = normalizeReconnect(out.reconnect);
  out.midnightCommand = normalizeMidnight(out.midnightCommand);
  const display = out.display && typeof out.display === 'object' ? out.display : {};
  out.display = {
    autoScroll: typeof display.autoScroll === 'boolean' ? display.autoScroll : true,
    showMonitor: typeof display.showMonitor === 'boolean' ? display.showMonitor : true,
    hidePresence: typeof display.hidePresence === 'boolean' ? display.hidePresence : true,
    logLimit: LOG_LIMITS.has(Number(display.logLimit)) ? Number(display.logLimit) : 800,
    chatBlocklist: normalizeChatBlocklist(display.chatBlocklist),
  };
  const storage = out.storage && typeof out.storage === 'object' ? out.storage : {};
  out.storage = { path: normalizeHistoryPath(storage.path), retentionDays: 7 };
  out.monitoredPlayers = normalizeMonitoredPlayers(out.monitoredPlayers);
  const automation = out.automation && typeof out.automation === 'object' ? out.automation : {};
  out.automation = { autoClaimRedPackets: typeof automation.autoClaimRedPackets === 'boolean'
    ? automation.autoClaimRedPackets : true,
    autoWelcome: typeof automation.autoWelcome === 'boolean' ? automation.autoWelcome : true,
    paused: automation.paused === true,
    welcomeDelayEnabled: automation.welcomeDelayEnabled !== false,
    welcomeDelay: normalizeWelcomeDelay(automation.welcomeDelay),
    claimDelay: normalizeClaimDelay(automation.claimDelay), ...normalizeClaimTrigger(automation) };
  out.shortcuts = (Array.isArray(out.shortcuts) ? out.shortcuts : []).slice(0, 30)
    .filter((entry) => entry && typeof entry.name === 'string' && typeof entry.command === 'string'
      && entry.name.trim() && entry.name.trim().length <= 24 && entry.command.startsWith('/')
      && entry.command.length <= 2048 && !/[\x00-\x1f\x7f]/.test(entry.name + entry.command))
    .map((entry) => ({ name: entry.name.trim(), command: entry.command }));

  // 清理历史遗留字段：v2.3.0 曾用 lastServer 实现"自动连接上次的服务器"，
  // 该功能已按用户要求移除。留着这个字段会让配置文件看起来像还有自动连接行为。
  if ('lastServer' in out) delete out.lastServer;
  // 自动钓鱼控制已从登录器移除，旧配置字段不再继续保存。
  if ('fishing' in out) delete out.fishing;
  // Read errors are transient UI metadata, not saved settings.
  if ('__loadError' in out) delete out.__loadError;

  delete out.__accountKey;
  const accounts = out.accountConfigs;
  delete out.accountConfigs;
  if (!nested && accounts && typeof accounts === 'object' && !Array.isArray(accounts)) {
    out.accountConfigs = {};
    for (const [key, value] of Object.entries(accounts).slice(0, 256)) {
      if (validAccountKey(key) && value && typeof value === 'object' && !Array.isArray(value))
        out.accountConfigs[key] = normalize({ ...value }, true);
    }
  }
  return upgradeProfiles(out);
}

/**
 * 首次运行时，把旧位置的配置搬过来。
 * 只读不删源文件 —— 用户的东西不擅自动。
 * @returns {string|null} 成功则返回迁移来源路径，否则 null
 */
function migrateLegacyConfig(configPath, legacyPaths) {
  if (fs.existsSync(configPath)) return null;
  for (const old of (legacyPaths || [])) {
    try {
      if (!fs.existsSync(old) || old === configPath) continue;
      const parsed = JSON.parse(fs.readFileSync(old, 'utf8'));
      if (!parsed || typeof parsed !== 'object') continue;
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(normalize(parsed), null, 2), 'utf8');
      return old;
    } catch (e) {
      // 某个旧位置坏了就试下一个，迁移失败不能阻塞启动
    }
  }
  return null;
}

/**
 * 读配置。
 * @returns {{cfg: object, migratedFrom: string|null, error: string|null}}
 */
function load(configPath, legacyPaths) {
  let migratedFrom = null;
  try {
    if (!fs.existsSync(configPath)) {
      withFileLock(configPath, () => {
        if (!fs.existsSync(configPath)) migratedFrom = migrateLegacyConfig(configPath, legacyPaths);
        if (!fs.existsSync(configPath)) fs.writeFileSync(configPath, JSON.stringify(defaultConfig(), null, 2), 'utf8');
      });
    }
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return { cfg: normalize(parsed), migratedFrom, error: null };
  } catch (e) {
    // ❗不静默吞错：把原因带回界面，否则用户只看到"服务器没了"却不知为何
    return { cfg: defaultConfig(), migratedFrom, error: e.message };
  }
}

/**
 * 写配置（原子写：先 .tmp 再 rename）。
 * @returns {{ok: boolean, error?: string, path: string}}
 */
function save(configPath, cfg, accountKey) {
  try {
    return withFileLock(configPath, () => {
      const root = accountKey !== undefined && fs.existsSync(configPath)
        ? normalize(JSON.parse(fs.readFileSync(configPath, 'utf8'))) : defaultConfig();
      const next = accountKey === undefined ? cfg : saveAccount(root, cfg, accountKey);
      const tmp = configPath + '.tmp';
      try {
        fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
        fs.renameSync(tmp, configPath);
      } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
      return { ok: true, path: configPath };
    });
  } catch (e) {
    return { ok: false, error: e.message, path: configPath };
  }
}

module.exports = { defaultConfig, normalize, normalizeMonitoredPlayers, normalizeHistoryPath,
  LOG_LIMITS, migrateLegacyConfig, load, save };
