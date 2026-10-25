'use strict';
/*
 * renderer.js —— 界面交互逻辑
 */

const $ = (id) => document.getElementById(id);

let cfg = null;
let selected = -1;          // 当前选中的服务器索引
let connected = false;       // 已进入游戏，可以发送聊天
let connectionActive = false; // 登录、同步和游戏阶段都可以断开
let connectionBusy = '';     // connect | disconnect | 空闲
let accountLoggedIn = false;
let savedAccounts = [];
let activeAccountUuid = null;
let accountSwitchBusy = false;
let chatSession = null;
let sending = false;
let reconnectState = { phase: 'idle' };
let reconnectCountdown = null;
let currentTarget = null;
let settingsSaving = false;
let settingsProfileKey;
let settingsAccountKey;
let bridgeExitPlayers = [];
let storagePathDraft = '';
let onlineSnapshot = { known: false, players: [] };
let onlineSnapshotVersion = 0;
let onlineRendered = null;
const onlinePlayerNodes = new Map();
let serverMenu = null;
let menuClickPending = null;
let menuClickError = '';
let purchaseSnapshot = null;
let purchaseRendered = null;
let purchaseRequestPending = false;
let completion = null;
let completionGeneration = 0;
let connectionMode = 'standalone';
let bridgeState = { listening: false, paired: false, online: false };
const chatFilter = window.McChatFilter;
const backgroundLogs = [];

function autoScrollEnabled() { return !cfg || !cfg.display || cfg.display.autoScroll !== false; }
function isReconnecting() { return ['waiting', 'connecting', 'maintenance'].includes(reconnectState.phase); }

const requestViewFrame = typeof requestAnimationFrame === 'function'
  ? (fn) => document.visibilityState === 'hidden' ? setTimeout(fn, 16) : requestAnimationFrame(fn)
  : (fn) => setTimeout(fn, 16);
const cancelViewFrame = (id) => {
  clearTimeout(id);
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
};
const viewScrolls = { chat: { frame: null, generation: 0, dirty: false, pinned: true, anchor: null }, log: { frame: null, generation: 0, dirty: false, pinned: true, anchor: null } };

function cancelViewScroll(name) {
  const state = viewScrolls[name];
  if (state.frame !== null) cancelViewFrame(state.frame);
  state.frame = null; state.generation++;
}

function scheduleViewScroll(name, pass = 0) {
  const state = viewScrolls[name];
  if (!state.dirty || !state.pinned || state.frame !== null || activeTab !== name || !autoScrollEnabled()) return;
  const generation = state.generation;
  state.frame = requestViewFrame(() => {
    if (generation !== state.generation) return;
    state.frame = null;
    if (activeTab !== name || !state.pinned || !autoScrollEnabled()) return;
    // Offscreen rows acquire real heights after layout; settle the tail in a bounded number of frames.
    const view = $(name + '-view');
    let tail = view.lastElementChild;
    while (tail && tail.classList.contains('hidden')) tail = tail.previousElementSibling;
    if (tail) tail.scrollIntoView({ block: 'end', inline: 'nearest', behavior: 'instant' });
    view.scrollTop = 1000000000;
    if (pass < 2) scheduleViewScroll(name, pass + 1);
    else { state.dirty = false; state.pinned = true; }
  });
}

function requestViewScroll(name) {
  const state = viewScrolls[name];
  // New content must not override the user's decision to read earlier messages.
  if (!state.pinned) return;
  state.dirty = true;
  scheduleViewScroll(name);
}

function rememberViewPosition(name) {
  const state = viewScrolls[name], view = $(name + '-view');
  state.anchor = null;
  if (state.pinned || typeof document.elementFromPoint !== 'function') return;
  const box = view.getBoundingClientRect();
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + Math.min(24, box.height / 2));
  const line = hit && hit.closest('.chat-line, .log-line');
  if (line && line.parentElement === view) state.anchor = { line, offset: line.getBoundingClientRect().top - box.top };
}

function restoreViewPosition(name, pass = 0) {
  const state = viewScrolls[name];
  if (!state.anchor || state.pinned || state.frame !== null || activeTab !== name) return;
  const generation = state.generation;
  state.frame = requestViewFrame(() => {
    if (generation !== state.generation) return;
    state.frame = null;
    const view = $(name + '-view'), anchor = state.anchor;
    if (!anchor || state.pinned || activeTab !== name) return;
    if (anchor.line.parentElement !== view) { state.anchor = null; return; }
    // Hidden views do not get native scroll anchoring when older rows are evicted.
    view.scrollTop += anchor.line.getBoundingClientRect().top - view.getBoundingClientRect().top - anchor.offset;
    if (pass < 2) restoreViewPosition(name, pass + 1);
    else state.anchor = null;
  });
}

function resizeMessageViews() {
  if (!autoScrollEnabled()) return;
  for (const name of ['chat', 'log']) {
    if (viewScrolls[name].pinned) requestViewScroll(name);
  }
}

/* ---------------- 日志 ---------------- */

function fmtTime(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function addLog(level, text, timestamp = Date.now()) {
  if (level === 'system') return;
  if (document.visibilityState === 'hidden') {
    backgroundLogs.push({ level, text, timestamp });
    while (backgroundLogs.length > 800) backgroundLogs.shift();
    return;
  }
  const view = $('log-view');
  const line = document.createElement('div');
  line.className = 'log-line ' + (level || 'net');
  line.dataset.category = level === 'auth' ? 'auth' : level === 'automation' ? 'automation'
    : level === 'chat' ? 'chat'
    : level === 'error' || /\[错误\]|\[网络错误\]|\[验证失败\]|\[被拒绝\]|\[被踢出\]/.test(text) ? 'error'
    : level === 'app' ? 'app' : 'connection';
  const filter = $('log-filter').value || 'all';
  line.classList.toggle('hidden', filter !== 'all' && filter !== line.dataset.category);
  const t = document.createElement('span');
  t.className = 'lt';
  t.textContent = fmtTime(timestamp);
  const m = document.createElement('span');
  m.className = 'lm';
  m.textContent = text;
  line.appendChild(t);
  line.appendChild(m);
  view.appendChild(line);

  // 日志界面按设置保留；磁盘归档不受这个显示上限影响。
  const limit = cfg && cfg.display && [200, 400, 800].includes(Number(cfg.display.logLimit))
    ? Number(cfg.display.logLimit) : 800;
  while (view.childElementCount > limit) view.removeChild(view.firstChild);

  requestViewScroll('log');
}

/* ---------------- Toast ---------------- */

let toastTimer = null;
function toast(msg, type = '') {
  const el = $('toast');
  el.textContent = msg;
  // ❗顺序很关键：先整体重设 className（会连带清掉 hidden），
  //   再显式移除 hidden。若反过来写，className 赋值会把 remove 的结果覆盖掉，
  //   第二次以后的提示就永远不显示了。
  el.className = 'toast ' + type;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
}

/* ---------------- 设备代码提示条 ----------------
 *
 * 设备代码流的用户体验是「看代码 → 去浏览器填」。代码容易漏看，
 * 所以这里把它做成醒目的大字提示条，并提供一键复制。
 *
 * 代码从哪里来：auth.js 会依次 log 出
 *   「  2. 输入代码：ABCD-EFGH」
 *   以及验证网址。这里解析这两行把提示条填上。
 */
const DC_LINE = /输入代码[：:]\s*([A-Z0-9-]{4,20})/;
const DC_URI_LINE = /打开网址[：:]\s*(https?:\/\/\S+)/;

function showDeviceCode(code, uri) {
  const box = $('device-code');
  if (code) {
    $('dc-code').textContent = code;
    if (uri) $('dc-uri').textContent = uri;
    box.classList.remove('hidden');
  } else {
    // 传 null 表示"清空并隐藏"，用于每轮登录开始前重置
    $('dc-code').textContent = '————';
    box.classList.add('hidden');
  }
}

function hideDeviceCode() {
  $('device-code').classList.add('hidden');
}

/** 尽力复制到剪贴板，返回是否成功（navigator.clipboard 在 file:// 下可能不可用） */
async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* 落到下面的兜底 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand && document.execCommand('copy');
    document.body.removeChild(ta);
    return !!ok;
  } catch (e) { return false; }
}

/* ---------------- 账号 ---------------- */

function renderSavedAccounts(accounts = savedAccounts, activeUuid = activeAccountUuid) {
  savedAccounts = Array.isArray(accounts) ? accounts.filter((item) => item && item.uuid) : [];
  activeAccountUuid = activeUuid || (savedAccounts[0] && savedAccounts[0].uuid) || null;
  const wrap = $('account-switcher');
  const select = $('account-select');
  if (!wrap || !select) return;
  select.innerHTML = '';
  for (const item of savedAccounts) {
    const option = document.createElement('option');
    option.value = item.uuid;
    option.textContent = item.name || item.uuid;
    select.appendChild(option);
  }
  if (activeAccountUuid) select.value = activeAccountUuid;
  wrap.classList.toggle('hidden', savedAccounts.length === 0);
  $('account-count').textContent = savedAccounts.length ? (savedAccounts.length + ' 个') : '';
  $('account-switcher-note').textContent = accountLoggedIn
    ? '切换会刷新当前账号的正版凭据'
    : '选择账号后点击「切换」即可免密登录';
  if ($('btn-login')) $('btn-login').textContent = savedAccounts.length ? '添加账号' : '登录微软账号';
}

function renderAccount(acc, accounts = savedAccounts, activeUuid = activeAccountUuid) {
  renderSavedAccounts(accounts, activeUuid || (acc && acc.uuid));
  if (acc) {
    accountLoggedIn = true;
    $('skin-avatar').textContent = acc.name.slice(0, 1).toUpperCase();
    $('skin-avatar').style.background = 'linear-gradient(145deg, #2dd4bf, #1a8f83)';
    $('skin-avatar').style.color = '#04211e';
    $('skin-name').textContent = acc.name;
    $('skin-uuid').textContent = acc.uuid || '';
    $('premium-tag').textContent = '已登录';
    $('premium-tag').className = 'tag ok';
    $('dot-account').className = 'dot on';
    $('text-account').textContent = acc.name;
    $('btn-login').textContent = '添加账号';
    $('btn-logout').classList.remove('hidden');
  } else {
    accountLoggedIn = false;
    $('skin-avatar').textContent = '?';
    $('skin-avatar').style.background = 'linear-gradient(145deg, #223046, #172030)';
    $('skin-avatar').style.color = '#5f6f80';
    $('skin-name').textContent = '—';
    $('skin-uuid').textContent = '登录后显示正版档案';
    $('premium-tag').textContent = '未登录';
    $('premium-tag').className = 'tag';
    $('dot-account').className = 'dot off';
    $('text-account').textContent = '未登录账号';
    $('btn-login').textContent = savedAccounts.length ? '添加账号' : '登录微软账号';
    $('btn-logout').classList.add('hidden');
  }
}

async function refreshAccountView(preferred = null) {
  try {
    const state = await window.api.peekAccount();
    renderAccount(preferred || state.active, state.accounts, state.activeUuid);
  } catch (e) {
    if (preferred) renderAccount(preferred);
  }
}

/* ---------------- 服务器列表 ---------------- */

function renderServers() {
  const list = $('server-list');
  list.innerHTML = '';
  if (!cfg.servers.length) {
    list.innerHTML = '<div class="empty-tip">还没有服务器<br>点右上角「+ 添加」</div>';
    selected = -1;
    updateConnPanel();
    return;
  }

  cfg.servers.forEach((s, i) => {
    const item = document.createElement('div');
    item.className = 'server-item' + (i === selected ? ' active' : '');
    item.innerHTML = `
      <span class="s-dot" data-dot="${i}"></span>
      <span class="s-main">
        <span class="s-name"></span>
        <span class="s-addr"></span>
      </span>
      <span class="s-del" data-del="${i}" title="删除">×</span>`;
    item.querySelector('.s-name').textContent = s.name || s.host;
    item.querySelector('.s-addr').textContent = `${s.host}:${s.port || 25565}`;

    // ❗不能用闭包里的 i —— 删完一项后重新 renderServers() 会重建整个列表，
    //   旧节点上的监听器若还持有老下标，删的就是错的服务器。
    //   改为点击时按"当前数组里这个对象的身份"重新定位。
    item.addEventListener('click', async (e) => {
      if (e.target.dataset.del !== undefined) return;
      const idx = cfg.servers.indexOf(s);
      if (idx < 0) return;
      selected = idx;
      try { await refreshSelectedProfile(); } catch (error) { toast(error.message, 'err'); }
      renderServers();
      updateConnPanel();
      autoPing(idx);
    });

    const del = item.querySelector('.s-del');
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      const idx = cfg.servers.indexOf(s);
      if (idx < 0) return;
      cfg.servers.splice(idx, 1);
      if (selected >= cfg.servers.length) selected = cfg.servers.length - 1;
      // 删掉的正好是当前选中项 → 选中态要跟着前移，否则面板显示的是别的服
      else if (selected > idx) selected -= 1;
      if (!await persistConfig()) return;
      try { await refreshSelectedProfile(); } catch (error) { toast(error.message, 'err'); }
      renderServers();
      updateConnPanel();
    });

    list.appendChild(item);
  });
}

/** 选中服务器后自动查一次状态 */
let pingSeq = 0;                    // ❗快速点多个服时，只认最后一次的结果
async function autoPing(i) {
  if (connectionMode === 'bridge') return;
  const s = cfg.servers[i];
  if (!s) return;
  const mySeq = ++pingSeq;
  if (!connectionActive && !isReconnecting()) $('conn-meta').textContent = '正在查询状态...';
  let r;
  try {
    r = await window.api.pingServer(s.host, s.port || 25565);
  } catch (e) {
    r = { ok: false, error: e && e.message ? e.message : '查询失败' };
  }
  // 期间用户又点了别的服 → 这次结果已经过期，丢掉，别覆盖新选中项的信息
  if (mySeq !== pingSeq || connectionMode === 'bridge') return;
  if (connectionActive || isReconnecting()) return;

  const dot = document.querySelector(`[data-dot="${i}"]`);
  if (r.ok) {
    if (dot) dot.classList.add('online');
    const d = r.data;
    const online = d.players ? d.players.online : 0;
    const max = d.players ? d.players.max : 0;
    const motd = stripColor(flattenMotd(d.description));
    $('conn-meta').textContent = `${online}/${max} 人 · ${d.__latency}ms · ${motd.split('\n')[0].slice(0, 40)}`;
    if (connected) return;
    detectPremium(d);
  } else {
    if (dot) dot.classList.remove('online');
    $('conn-meta').textContent = '无法连接：' + r.error;
  }
}

let profileSelectionGeneration = 0;
async function refreshSelectedProfile() {
  if (connectionActive || connectionBusy || isReconnecting() || !window.api.selectProfile || selected < 0) return;
  const generation = ++profileSelectionGeneration;
  const result = await window.api.selectProfile(cfg.servers[selected]);
  if (!result.ok) throw new Error(result.error);
  if (generation !== profileSelectionGeneration) return;
  cfg = result.config; renderShortcuts(); applyDisplaySettings(); window.AttentionUI?.refresh();
}

/** 从协议号判断是否是目标版本；正版与否要靠握手才能确定 */
function detectPremium(d) {
  const proto = d.version && d.version.protocol;
  if (proto && proto !== 776) {
    $('conn-meta').textContent += ` · 协议 ${proto}（非 26.2，可能不兼容）`;
  }
}

function stripColor(s) { return String(s || '').replace(/§./g, ''); }
function flattenMotd(comp) {
  if (!comp) return '';
  if (typeof comp === 'string') return comp;
  let out = comp.text || '';
  if (comp.extra) out += comp.extra.map(flattenMotd).join('');
  return out;
}

/* ---------------- 连接面板 ---------------- */

function updateConnPanel() {
  const s = cfg.servers[selected];
  const isBridge = connectionMode === 'bridge';
  $('conn-meta').classList.toggle('maintenance', isReconnecting() && reconnectState.maintenance === true);
  $('mode-standalone').checked = !isBridge;
  $('mode-bridge').checked = isBridge;
  $('mode-standalone').disabled = !!connectionBusy;
  $('mode-bridge').disabled = !!connectionBusy;
  $('btn-bridge-export').classList.toggle('hidden', !isBridge);
  $('btn-bridge-export').disabled = !!connectionBusy;
  const target = isBridge && !connected ? null
    : (connectionActive || isReconnecting()) ? currentTarget || reconnectState.target : null;
  if (target) {
    const entry = cfg.servers.find((server) => server.host === target.host && (server.port || 25565) === target.port);
    $('conn-host').textContent = entry ? entry.name || entry.host : target.host;
  } else if (isBridge) {
    $('conn-host').textContent = '游戏客户端';
    $('conn-meta').textContent = bridgeState.detecting ? (bridgeState.paired ? '已配对 · 等待同账号进服' : '检测本地游戏 · 最多 30 秒')
      : bridgeState.paired ? '已配对 · 游戏尚未连接服务器'
      : bridgeState.listening ? '等待游戏 Mod 配对' : '本地桥接未启动';
  } else if (!s) {
    $('conn-host').textContent = '未选择服务器';
    $('conn-meta').textContent = '在左侧选择一台服务器';
  } else {
    $('conn-host').textContent = s.name || s.host;
  }
  if (isBridge && connected && currentTarget) $('conn-meta').textContent = '游戏桥接 · ' + currentTarget.host + ':' + currentTarget.port;
  $('btn-connect').disabled = !!connectionBusy || (!isBridge && !connectionActive && !s);
  $('btn-connect').textContent = connectionBusy === 'connect' ? '连接中...'
    : connectionBusy === 'disconnect' ? '断开中...'
    : reconnectState.phase === 'waiting' || reconnectState.phase === 'maintenance' ? '停止重连'
    : reconnectState.phase === 'connecting' ? '取消重连'
    : connectionActive ? (isBridge ? bridgeState.detecting ? '停止检测' : '断开桥接' : '断开') : (isBridge ? '启动桥接' : '连接');
  $('inp-send').disabled = !connected || !!connectionBusy;
  $('btn-send').disabled = !connected || !!connectionBusy || sending;
  $('shortcut-select').disabled = !connected || !!connectionBusy;
  if (!connected) { clearCompletion(); renderServerMenu(null); }
  if (activeTab === 'presence') renderPresenceTarget();
  updateChatActions();
}

function renderReconnectState() {
  clearTimeout(reconnectCountdown);
  reconnectCountdown = null;
  if (!isReconnecting()) return;
  if (reconnectState.phase === 'maintenance') {
    const seconds = Math.max(0, Math.ceil((reconnectState.retryAt - Date.now()) / 1000));
    $('conn-meta').textContent = `维护等待 · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} 后检查`;
    $('st-state').textContent = '等待维护';
    reconnectCountdown = setTimeout(renderReconnectState, 1000);
    return;
  }
  if (reconnectState.phase === 'connecting' && reconnectState.maintenance) {
    $('conn-meta').textContent = '维护后检查恢复';
    $('st-state').textContent = '检查恢复';
    return;
  }
  const attempt = reconnectState.phase === 'waiting' ? reconnectState.attempt + 1 : reconnectState.attempt;
  const limit = reconnectState.maxAttempts || '不限';
  $('conn-meta').textContent = `自动重连 · 第 ${attempt} 次 / 上限 ${limit}`;
  if (reconnectState.phase === 'waiting') {
    const seconds = Math.max(0, Math.ceil((reconnectState.retryAt - Date.now()) / 1000));
    $('st-state').textContent = `${seconds} 秒后重连`;
    reconnectCountdown = setTimeout(renderReconnectState, 1000);
  } else $('st-state').textContent = '正在重连';
}

function updateStats(p) {
  if (p.state !== undefined) {
    const map = { idle: '空闲', login: '登录中', config: '同步中', play: '已进入游戏', closed: '已断开', 'bridge-wait': '等待游戏' };
    $('st-state').textContent = map[p.state] || p.state;
  }
  if (p.uptime !== undefined) $('st-uptime').textContent = p.uptime;
  if (p.recv !== undefined && p.sent !== undefined) {
    $('st-traffic').textContent = `${p.recv}/${p.sent}KB`;
  }
  if (p.premium !== undefined || p.encrypted !== undefined) {
    if (p.premium) $('st-auth').textContent = '正版已加密';
    else if (p.encrypted) $('st-auth').textContent = '已加密';
    else $('st-auth').textContent = '离线模式';
  }
}

/* ---------------- 资源监控 ---------------- */

let monDetailOpen = false;

function fmtBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)) + ' ' + u[i];
}

function fmtPct(n) {
  if (!Number.isFinite(n)) return '0.0%';
  return n.toFixed(1) + '%';
}

function renderMonitor(m) {
  if (!m) return;
  const cpu = m.app ? m.app.cpuPct : 0;
  const memB = m.app ? m.app.memBytes : 0;

  const memPct = m.app && Number.isFinite(m.app.memPct) ? m.app.memPct
    : m.system && m.system.totalMem > 0 ? memB / m.system.totalMem * 100 : 0;
  $('mon-cpu').textContent = fmtPct(cpu) + ' / ' + fmtPct(m.app && m.app.peakCpuPct || cpu);
  $('mon-mem').textContent = fmtPct(memPct) + ' / ' + fmtPct(m.app && m.app.peakMemPct || memPct);
  $('mon-mem').title = '实时 ' + fmtBytes(memB) + ' / 本次运行最高 ' + fmtBytes(m.app && m.app.peakMemBytes || memB);

  if (monDetailOpen) renderMonitorDetail(m);
}

function renderMonitorDetail(m) {
  const box = $('mon-detail-body');
  const list = (m && m.processes) || [];
  if (!list.length) {
    box.innerHTML = '<div class="mon-detail-empty">当前环境无法读取进程明细（仅 Electron 下可用）</div>';
    return;
  }
  // 按内存降序，最占资源的一眼看得到
  const sorted = list.slice().sort((a, b) => b.mem - a.mem);
  box.innerHTML = '';
  for (const p of sorted) {
    const row = document.createElement('div');
    row.className = 'mon-detail-row';
    const nm = document.createElement('span');
    nm.className = 'mt-name';
    nm.textContent = `${p.kind} #${p.pid}`;
    nm.title = p.name || '';
    const cpu = document.createElement('span');
    cpu.className = 'mt-cpu';
    cpu.textContent = fmtPct(p.cpu);
    const mem = document.createElement('span');
    mem.className = 'mt-mem';
    mem.textContent = fmtBytes(p.mem);
    row.appendChild(nm); row.appendChild(cpu); row.appendChild(mem);
    box.appendChild(row);
  }
}

/* ---------------- 配置持久化 ----------------
 *
 * ❗这里必须是"等一下再走"的：旧代码是 `window.api.saveConfig(cfg)` 直接调用、
 *  不等返回。写盘失败（磁盘满/权限/路径问题）时完全静默 ——
 *  用户加了服务器、界面也显示了，重启却没了，且不知道为什么。
 *  现在统一 await + 检查返回值，失败立刻弹提示。
 */
async function persistConfig(next = cfg) {
  let r;
  try {
    r = await window.api.saveConfig(next);
  } catch (e) {
    r = { ok: false, error: (e && e.message) || '未知错误' };
  }
  if (r && r.ok) return true;
  const msg = (r && r.error) || '未知错误';
  addLog('error', `配置保存失败：${msg}`);
  toast('保存失败：' + msg, 'err');
  return false;
}

function applyDisplaySettings() {
  $('monitor-panel').classList.toggle('hidden', !!cfg.display && cfg.display.showMonitor === false);
  if (chatView().querySelectorAll) {
    for (const line of chatView().querySelectorAll('.chat-line')) filterChatLine(line);
  }
  const logLimit = cfg && cfg.display && [200, 400, 800].includes(Number(cfg.display.logLimit))
    ? Number(cfg.display.logLimit) : 800;
  const log = $('log-view');
  while (log && log.childElementCount > logLimit) log.removeChild(log.firstChild);
  if (autoScrollEnabled() && ['chat', 'log'].includes(activeTab)) requestViewScroll(activeTab);
  else { cancelViewScroll('chat'); cancelViewScroll('log'); }
}

function updateReconnectFields() {
  const disabled = settingsSaving || !$('chk-reconnect').checked;
  $('inp-reconnect-delay').disabled = disabled;
  $('inp-reconnect-attempts').disabled = disabled;
}

function updateMidnightField() {
  $('inp-midnight-command').disabled = settingsSaving || !$('chk-midnight').checked;
  $('inp-midnight-command').required = $('chk-midnight').checked;
}

function updateClaimFields() {
  $('chk-claim-after').disabled = settingsSaving;
  $('chk-claim-delay').disabled = settingsSaving;
  $('inp-claim-after-count').disabled = settingsSaving || !$('chk-claim-after').checked;
  for (const id of ['inp-claim-delay-min', 'inp-claim-delay-max']) {
    $(id).disabled = settingsSaving || !$('chk-claim-delay').checked;
  }
}

function updateWelcomeFields() {
  const disabled = settingsSaving || !$('chk-welcome-delay').checked;
  $('inp-welcome-delay-min').disabled = disabled;
  $('inp-welcome-delay-max').disabled = disabled;
}

function renderBridgeTargets() {
  const selected = $('bridge-exit-selected'), candidates = $('bridge-exit-players');
  selected.replaceChildren(); candidates.replaceChildren();
  $('bridge-exit-count').textContent = bridgeExitPlayers.length + ' / 16';
  const names = new Set(bridgeExitPlayers.map((name) => name.toLowerCase()));
  const online = new Set((onlineSnapshot.known ? onlineSnapshot.players : []).map((p) => p.name.toLowerCase()));
  for (const name of bridgeExitPlayers) {
    const item = document.createElement('span'); item.className = 'bridge-target-chip';
    const label = document.createElement('span'); label.textContent = name; item.appendChild(label);
    if (online.has(name.toLowerCase())) {
      const status = document.createElement('span'); status.className = 'bridge-target-online'; status.textContent = '在线'; item.appendChild(status);
    }
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn-ghost icon-button';
    remove.title = '移除 ' + name; remove.setAttribute('aria-label', remove.title); remove.disabled = settingsSaving;
    const icon = document.createElement('img'); icon.src = 'icons/x.svg'; icon.alt = ''; icon.className = 'close-icon'; remove.appendChild(icon);
    remove.addEventListener('click', () => {
      bridgeExitPlayers = bridgeExitPlayers.filter((value) => value !== name); renderBridgeTargets(); $('bridge-exit-player').focus();
    });
    item.appendChild(remove); selected.appendChild(item);
  }
  if (!bridgeExitPlayers.length) {
    const empty = document.createElement('span'); empty.className = 'bridge-target-empty'; empty.textContent = '尚未选择目标'; selected.appendChild(empty);
  }
  const query = $('bridge-exit-player').value.trim().toLowerCase();
  const players = (onlineSnapshot.known ? onlineSnapshot.players : []).filter((p) => /^[A-Za-z0-9_]{1,16}$/.test(p.name)
    && p.name.toLowerCase().includes(query)).slice().sort((a, b) => a.name.localeCompare(b.name));
  for (const player of players.slice(0, 256)) {
    const row = document.createElement('label'); row.className = 'bridge-target-option';
    const box = document.createElement('input'); box.type = 'checkbox'; box.value = player.name; box.checked = names.has(player.name.toLowerCase());
    box.disabled = settingsSaving || !box.checked && bridgeExitPlayers.length >= 16;
    box.addEventListener('change', () => {
      if (box.checked) bridgeExitPlayers.push(player.name);
      else bridgeExitPlayers = bridgeExitPlayers.filter((name) => name.toLowerCase() !== player.name.toLowerCase());
      $('bridge-exit-error').textContent = ''; renderBridgeTargets();
      [...candidates.querySelectorAll('input')].find((input) => input.value === player.name)?.focus();
    });
    const label = document.createElement('span'); label.textContent = player.name;
    const status = document.createElement('span'); status.className = 'bridge-target-online'; status.textContent = '在线';
    row.append(box, label, status); candidates.appendChild(row);
  }
  if (!players.length) {
    const empty = document.createElement('p'); empty.className = 'bridge-target-empty';
    empty.textContent = onlineSnapshot.known ? '没有匹配的在线玩家' : '暂无在线名单'; candidates.appendChild(empty);
  }
  $('bridge-exit-add').disabled = settingsSaving || !query || bridgeExitPlayers.length >= 16;
}

function addBridgeTarget() {
  if (settingsSaving) return;
  const input = $('bridge-exit-player'), name = input.value.trim();
  if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) {
    $('bridge-exit-error').textContent = '玩家 ID 须为 1–16 位英文、数字或下划线'; input.focus(); return;
  }
  if (!bridgeExitPlayers.some((value) => value.toLowerCase() === name.toLowerCase())) {
    if (bridgeExitPlayers.length >= 16) { $('bridge-exit-error').textContent = '最多添加 16 位目标玩家'; return; }
    bridgeExitPlayers.push(name);
  }
  input.value = ''; $('bridge-exit-error').textContent = ''; renderBridgeTargets(); input.focus();
}

function populateSettings() {
  settingsProfileKey = cfg.__profileKey;
  settingsAccountKey = cfg.__accountKey;
  const identity = savedAccounts.find((item) => item.uuid === cfg.__accountKey);
  $('settings-profile').textContent = '账号：' + (identity?.name || cfg.__accountKey?.replace(/^player:/, '') || '未选择')
    + ' · 服务器：' + (cfg.__profileKey || '未选择服务器');
  $('chk-auto-purchase').checked = cfg.autoPurchase === true;
  $('chk-bridge-exit').checked = cfg.bridgeExit?.enabled === true;
  $('sel-bridge-fallback').value = ['off', 'exit', 'offline'].includes(cfg.bridgeFallback) ? cfg.bridgeFallback : 'exit';
  bridgeExitPlayers = [...(cfg.bridgeExit?.players || (cfg.bridgeExit?.player ? [cfg.bridgeExit.player] : []))];
  $('bridge-exit-player').value = ''; $('bridge-exit-error').textContent = ''; renderBridgeTargets();
  const notices = cfg.notifications || {};
  for (const key of ['mentions', 'players', 'connection', 'desktop', 'preview', 'quiet']) $('notify-' + key).checked = notices[key] === true;
  $('notify-start').value = notices.quietStart || '23:00';
  $('notify-end').value = notices.quietEnd || '08:00';
  const policy = cfg.reconnect || {};
  $('chk-reconnect').checked = policy.enabled !== false;
  $('inp-reconnect-delay').value = policy.delaySeconds || 5;
  $('inp-reconnect-attempts').value = policy.maxAttempts === undefined ? 10 : policy.maxAttempts;
  $('chk-autologin').checked = cfg.autoLogin !== false;
  $('chk-showchat').checked = !cfg.behavior || cfg.behavior.showChat !== false;
  $('chk-hidepresence').checked = !cfg.display || cfg.display.hidePresence !== false;
  $('chk-autoscroll').checked = autoScrollEnabled();
  $('chk-showmonitor').checked = !cfg.display || cfg.display.showMonitor !== false;
  $('sel-log-limit').value = String(cfg.display && [200, 400, 800].includes(Number(cfg.display.logLimit))
    ? Number(cfg.display.logLimit) : 800);
  $('settings-chat-blocklist').value = (cfg.display && Array.isArray(cfg.display.chatBlocklist)
    ? cfg.display.chatBlocklist : []).join('\n');
  $('chk-autoclaim').checked = !cfg.automation || cfg.automation.autoClaimRedPackets !== false;
  const claimAfter = cfg.automation && cfg.automation.claimAfter || { enabled: false, count: 2 };
  $('chk-claim-after').checked = claimAfter.enabled === true;
  $('inp-claim-after-count').value = claimAfter.count;
  $('chk-claim-delay').checked = !claimAfter.enabled && (!cfg.automation || cfg.automation.claimDelayEnabled !== false);
  const claimDelay = cfg.automation && cfg.automation.claimDelay || { minMs: 400, maxMs: 850 };
  $('inp-claim-delay-min').value = claimDelay.minMs / 1000;
  $('inp-claim-delay-max').value = claimDelay.maxMs / 1000;
  $('sel-close-behavior').value = cfg.closeBehavior === 'background' ? 'background' : 'quit';
  $('chk-autowelcome').checked = !cfg.automation || cfg.automation.autoWelcome !== false;
  const welcomeDelay = cfg.automation && cfg.automation.welcomeDelay || { minMs: 400, maxMs: 850 };
  $('chk-welcome-delay').checked = !cfg.automation || cfg.automation.welcomeDelayEnabled !== false;
  $('inp-welcome-delay-min').value = welcomeDelay.minMs / 1000;
  $('inp-welcome-delay-max').value = welcomeDelay.maxMs / 1000;
  $('chk-pause-automation').checked = !!(cfg.automation && cfg.automation.paused);
  $('chk-midnight').checked = !!cfg.midnightCommand && cfg.midnightCommand.enabled === true;
  $('inp-midnight-command').value = cfg.midnightCommand && cfg.midnightCommand.command || '';
  $('settings-shortcuts').value = (cfg.shortcuts || []).map((entry) => entry.name + ' | ' + entry.command).join('\n');
  storagePathDraft = cfg.storage && cfg.storage.path || '';
  renderHistoryPath();
  if (window.api.getHistoryPath) window.api.getHistoryPath().then((value) => {
    if (!storagePathDraft && (!cfg.storage || !cfg.storage.path)) $('history-path').textContent = value;
  }).catch(() => {});
  $('settings-error').textContent = '';
  updateReconnectFields();
  updateMidnightField();
  updateClaimFields();
  updateWelcomeFields();
}

function renderHistoryPath() {
  const value = storagePathDraft || '默认目录（应用数据/records）';
  $('history-path').textContent = value;
  $('history-path').title = value;
}

function closeSettings() {
  if (settingsSaving) return;
  $('settings-dialog').close();
  $('btn-settings').focus();
}

async function saveSettings(event) {
  event.preventDefault();
  if (settingsProfileKey !== cfg.__profileKey || settingsAccountKey !== cfg.__accountKey) {
    $('settings-error').textContent = '账号或服务器已切换，请关闭并重新打开设置'; return;
  }
  if (settingsSaving || !$('settings-form').reportValidity()) return;
  if ($('chk-bridge-exit').checked && !bridgeExitPlayers.length) {
    $('settings-error').textContent = '请至少选择一位下线目标玩家'; $('bridge-exit-player').focus(); return;
  }
  const enabled = $('chk-reconnect').checked;
  const delay = enabled ? Number($('inp-reconnect-delay').value) : (cfg.reconnect || {}).delaySeconds || 5;
  const attempts = enabled ? Number($('inp-reconnect-attempts').value)
    : (cfg.reconnect || {}).maxAttempts === undefined ? 10 : cfg.reconnect.maxAttempts;
  if (!Number.isInteger(delay) || delay < 3 || delay > 60 || !Number.isInteger(attempts) || attempts < 0 || attempts > 1000) {
    $('settings-error').textContent = '重连间隔须为 3–60 秒，重试上限须为 0–1000 的整数';
    return;
  }
  const shortcuts = [];
  const priorClaimDelay = cfg.automation && cfg.automation.claimDelay || { minMs: 400, maxMs: 850 };
  const draftClaimDelay = { minMs: Math.round(Number($('inp-claim-delay-min').value) * 1000),
    maxMs: Math.round(Number($('inp-claim-delay-max').value) * 1000) };
  const draftDelayValid = Number.isInteger(draftClaimDelay.minMs) && Number.isInteger(draftClaimDelay.maxMs)
    && draftClaimDelay.minMs >= 0 && draftClaimDelay.maxMs <= 30000 && draftClaimDelay.minMs <= draftClaimDelay.maxMs
    && $('inp-claim-delay-min').value !== '' && $('inp-claim-delay-max').value !== '';
  const claimDelay = $('inp-claim-delay-min').disabled && !draftDelayValid ? priorClaimDelay : draftClaimDelay;
  const priorWelcomeDelay = cfg.automation && cfg.automation.welcomeDelay || { minMs: 400, maxMs: 850 };
  const draftWelcomeDelay = { minMs: Math.round(Number($('inp-welcome-delay-min').value) * 1000),
    maxMs: Math.round(Number($('inp-welcome-delay-max').value) * 1000) };
  const welcomeDelayValid = Number.isInteger(draftWelcomeDelay.minMs) && Number.isInteger(draftWelcomeDelay.maxMs)
    && draftWelcomeDelay.minMs >= 0 && draftWelcomeDelay.maxMs <= 30000
    && draftWelcomeDelay.minMs <= draftWelcomeDelay.maxMs
    && $('inp-welcome-delay-min').value !== '' && $('inp-welcome-delay-max').value !== '';
  const welcomeDelay = $('inp-welcome-delay-min').disabled && !welcomeDelayValid ? priorWelcomeDelay : draftWelcomeDelay;
  const priorClaimAfter = cfg.automation && cfg.automation.claimAfter || { enabled: false, count: 2 };
  const draftCount = Number($('inp-claim-after-count').value);
  const claimAfter = { enabled: $('chk-claim-after').checked, count: $('inp-claim-after-count').disabled
    && (!Number.isInteger(draftCount) || draftCount < 1 || draftCount > 1000) ? priorClaimAfter.count : draftCount };
  const claimDelayEnabled = $('chk-claim-delay').checked && !claimAfter.enabled;
  if (!Number.isInteger(claimAfter.count) || claimAfter.count < 1 || claimAfter.count > 1000) {
    $('settings-error').textContent = '红包触发人数须为 1–1000 的整数';
    $('inp-claim-after-count').focus(); return;
  }
  if (!Number.isFinite(claimDelay.minMs) || !Number.isFinite(claimDelay.maxMs)
    || claimDelay.minMs < 0 || claimDelay.maxMs > 30000 || claimDelay.minMs > claimDelay.maxMs) {
    $('settings-error').textContent = '红包延迟须为 0–30 秒，最小值不能大于最大值';
    $('inp-claim-delay-min').focus(); return;
  }
  if (!Number.isFinite(welcomeDelay.minMs) || !Number.isFinite(welcomeDelay.maxMs)
    || welcomeDelay.minMs < 0 || welcomeDelay.maxMs > 30000 || welcomeDelay.minMs > welcomeDelay.maxMs) {
    $('settings-error').textContent = '欢迎延迟须为 0–30 秒，最小值不能大于最大值';
    $('inp-welcome-delay-min').focus(); return;
  }
  const midnightCommand = { enabled: $('chk-midnight').checked, command: $('inp-midnight-command').value.trim() };
  if (midnightCommand.enabled && (!/^\/[^\s/]/.test(midnightCommand.command)
    || midnightCommand.command.length > 2048 || /[\x00-\x1f\x7f]/.test(midnightCommand.command))) {
    $('settings-error').textContent = '零点命令须以 / 开头，不能换行且不超过 2048 字';
    $('inp-midnight-command').focus();
    return;
  }
  const chatBlocklist = [];
  const seenBlocklist = new Set();
  for (const raw of $('settings-chat-blocklist').value.split(/\r?\n/)) {
    const keyword = raw.trim();
    if (!keyword) continue;
    if (keyword.length > 64 || /[\x00-\x1f\x7f]/.test(keyword)) {
      $('settings-error').textContent = '聊天屏蔽关键词不能换行或超过 64 个字符';
      $('settings-chat-blocklist').focus();
      return;
    }
    const key = keyword.toLocaleLowerCase();
    if (seenBlocklist.has(key)) continue;
    seenBlocklist.add(key);
    if (chatBlocklist.length < 64) chatBlocklist.push(keyword);
  }
  for (const line of $('settings-shortcuts').value.split(/\r?\n/).filter((line) => line.trim())) {
    const divider = line.indexOf('|');
    const name = line.slice(0, divider).trim(), command = line.slice(divider + 1).trim();
    if (divider < 1 || !name || name.length > 24 || !command.startsWith('/') || command.length > 2048
      || /[\x00-\x1f\x7f]/.test(name + command) || shortcuts.length >= 30) {
      $('settings-error').textContent = '快捷指令格式：名称 | /命令；最多 30 条，名称不超过 24 字';
      return;
    }
    shortcuts.push({ name, command });
  }
  const next = { ...cfg, autoLogin: $('chk-autologin').checked,
    bridgeExit: { enabled: $('chk-bridge-exit').checked, players: bridgeExitPlayers.slice() },
    bridgeFallback: $('sel-bridge-fallback').value,
    autoPurchase: $('chk-auto-purchase').checked,
    notifications: { mentions: $('notify-mentions').checked, players: $('notify-players').checked,
      connection: $('notify-connection').checked, desktop: $('notify-desktop').checked,
      preview: $('notify-preview').checked, quiet: $('notify-quiet').checked,
      quietStart: $('notify-start').value, quietEnd: $('notify-end').value },
    closeBehavior: $('sel-close-behavior').value,
    shortcuts,
    midnightCommand,
    reconnect: { enabled, delaySeconds: delay, maxAttempts: attempts },
    behavior: { ...(cfg.behavior || {}), showChat: $('chk-showchat').checked },
    automation: { autoClaimRedPackets: $('chk-autoclaim').checked, autoWelcome: $('chk-autowelcome').checked,
      paused: $('chk-pause-automation').checked, welcomeDelay,
      welcomeDelayEnabled: $('chk-welcome-delay').checked, claimDelay, claimDelayEnabled, claimAfter },
    display: { autoScroll: $('chk-autoscroll').checked, showMonitor: $('chk-showmonitor').checked,
      hidePresence: $('chk-hidepresence').checked, logLimit: Number($('sel-log-limit').value), chatBlocklist },
    storage: { ...(cfg.storage || {}), path: storagePathDraft, retentionDays: 7 },
    monitoredPlayers: Array.isArray(cfg.monitoredPlayers) ? cfg.monitoredPlayers.slice() : ['Nan_Koi'] };
  settingsSaving = true;
  for (const control of $('settings-form').querySelectorAll('input, button, textarea, select')) control.disabled = true;
  try {
    if (!await persistConfig(next)) {
      $('settings-error').textContent = $('toast').textContent;
      return;
    }
    cfg = next;
    if (window.api.selectProfile) cfg = await window.api.getConfig();
    renderShortcuts();
    applyDisplaySettings();
    addLog('app', '设置已保存');
    toast('设置已保存', 'ok');
    $('settings-dialog').close();
    $('btn-settings').focus();
  } finally {
    settingsSaving = false;
    for (const control of $('settings-form').querySelectorAll('input, button, textarea, select')) control.disabled = false;
    updateReconnectFields();
    updateMidnightField();
    updateClaimFields();
    updateWelcomeFields();
    renderBridgeTargets();
  }
}

/* ---------------- 聊天视图 ----------------
 *
 * 与「运行日志」分成两个页签：
 *   - 运行日志：网络/握手/错误等**技术信息**（等宽字体）
 *   - 聊天：服务器发来的**内容**（玩家发言、服务端广播、快捷栏提示）
 *
 * 分开的原因：以前两者混在一起，服务器一广播就被网络日志冲上去，
 * 想看一眼谁说了话得往上翻半天。
 */

const CHAT_DOM_MAX = 800;      // 只限制 DOM 窗口；聊天记录本身写入 7 天归档，不设条数上限
let chatUnread = 0;            // 未读计数（在日志页时累积）
let activeTab = 'chat';
let chatHistoryHasMore = false;
let chatHistoryLoading = false;
let chatHistoryCursor = null;

function chatView() { return $('chat-view'); }

let chatActionState = null;
function updateChatAction(button) {
  const disabled = !connected || !!connectionBusy || button.dataset.used === 'true'
    || button.dataset.pending === 'true' || button.dataset.session !== chatSession;
  if (button.disabled !== disabled) button.disabled = disabled;
}

function updateChatActions() {
  if (chatActionState && chatActionState.connected === connected && chatActionState.busy === connectionBusy
    && chatActionState.session === chatSession) return;
  chatActionState = { connected, busy: connectionBusy, session: chatSession };
  const view = chatView();
  if (!view || !view.querySelectorAll) return;
  for (const button of view.querySelectorAll('.chat-action')) updateChatAction(button);
}

async function activateChatAction(button, click, session) {
  if (!connected || connectionBusy || session !== chatSession || button.disabled) return;
  button.dataset.pending = 'true';
  updateChatAction(button);
  try {
    const result = await window.api.chatAction(click.id);
    if (!result || !result.ok) {
      if (result && result.error) toast(result.error, 'err');
      return;
    }
    if (result.action === 'run_command') {
      button.dataset.used = 'true';
      addLog('net', '→ ' + result.value);
      toast('已发送点击指令', 'ok');
    } else if (session !== chatSession || !connected) {
      return;
    } else if (result.action === 'suggest_command') {
      $('inp-send').value = result.value;
      $('inp-send').focus();
      $('inp-send').setSelectionRange(result.value.length, result.value.length);
    } else if (result.action === 'copy_to_clipboard') {
      const ok = await copyText(result.value);
      toast(ok ? '已复制' : '复制失败', ok ? 'ok' : 'err');
    }
  } catch (e) {
    toast('点击未完成：' + (e.message || '未知错误'), 'err');
  } finally {
    button.dataset.pending = 'false';
    updateChatAction(button);
  }
}

function renderChatSegments(container, data) {
  const segments = Array.isArray(data.segments) && data.segments.length
    ? data.segments : [{ text: data.text || '' }];
  // 普通消息保留完整富文本和点击动作；异常复杂消息退化为一个纯文本节点。
  // 这样不会截断用户看到的正文，但避免一次广播创建数千个 DOM 节点。
  const segmentTextLength = segments.reduce((total, part) => total + String(part && part.text || '').length, 0);
  if (segments.length > 512 || segmentTextLength > 16384) {
    const plain = document.createElement('span');
    plain.textContent = String(data.text || segments.map((part) => part && part.text || '').join(''));
    container.appendChild(plain);
    return;
  }
  const labels = { run_command: '执行指令', suggest_command: '填入输入框',
    copy_to_clipboard: '复制', open_url: '打开链接' };
  for (const part of segments) {
    const click = part.click && part.click.id && Object.hasOwn(labels, part.click.action) ? part.click : null;
    const el = document.createElement(click ? 'button' : 'span');
    el.textContent = part.text;
    if (part.color && /^#[0-9a-f]{6}$/i.test(part.color)) el.style.color = part.color;
    if (part.bold) el.style.fontWeight = '700';
    if (part.italic) el.style.fontStyle = 'italic';
    const decorations = [];
    if (part.underlined) decorations.push('underline');
    if (part.strikethrough) decorations.push('line-through');
    if (decorations.length) el.style.textDecorationLine = decorations.join(' ');
    if (click) {
      el.type = 'button';
      el.className = 'chat-action';
      el.dataset.session = data.session || '';
      el.dataset.actionId = click.id;
      el.dataset.actionValue = click.value;
      el.dataset.actionKind = click.action;
      el.title = [part.hover, labels[click.action] + '：' + click.value].filter(Boolean).join('\n');
      el.disabled = !connected || !!connectionBusy || data.session !== chatSession;
    } else if (part.hover) {
      el.title = part.hover;
    }
    container.appendChild(el);
  }
}

function handleChatClick(event) {
  const button = event && event.target && typeof event.target.closest === 'function'
    ? event.target.closest('.chat-action') : null;
  if (!button || !chatView().contains(button)) return;
  activateChatAction(button, {
    id: button.dataset.actionId, action: button.dataset.actionKind, value: button.dataset.actionValue,
  }, button.dataset.session);
}

function renderChatLine(d) {
  const line = document.createElement('div');
  line.className = 'chat-line ' + (d.type || 'system');
  line._chatText = String(d.text == null ? '' : d.text);
  if (d.messageId) line.dataset.messageId = d.messageId;
  if (Number.isFinite(d.t)) line.dataset.t = String(d.t);
  line.dataset.category = d.category || (d.type === 'player' || d.type === 'mine' ? 'player'
    : /^\s*[\[【]红包[\]】]/.test(d.text) ? 'redpacket' : d.type === 'actionbar' ? 'actionbar' : 'system');
  filterChatLine(line);

  const t = document.createElement('span');
  t.className = 'ct';
  t.textContent = fmtTime(d.t || Date.now());
  line.appendChild(t);

  if (d.sender) {
    const s = document.createElement('span');
    s.className = 'cs';
    s.textContent = d.sender;
    line.appendChild(s);
  }

  const m = document.createElement('span');
  m.className = 'cm';
  renderChatSegments(m, d);
  line.appendChild(m);
  return line;
}

function appendChatMessages(messages) {
  const view = chatView();
  if (!view || !messages.length) return;
  const renderable = messages.filter((message) => !shouldSuppressChat(message && message.text));
  if (!renderable.length) return;

  // 首条消息到来时清掉"空状态"提示
  const empty = $('chat-empty');
  if (empty) empty.remove();

  const lines = renderable.map(renderChatLine);
  if (typeof document.createDocumentFragment === 'function') {
    const fragment = document.createDocumentFragment();
    for (const line of lines) fragment.appendChild(line);
    view.appendChild(fragment);
  } else {
    for (const line of lines) view.appendChild(line);
  }
  while (view.childElementCount > CHAT_DOM_MAX) {
    const first = view.firstElementChild || view.firstChild;
    if (!first) break;
    first.remove();
    chatHistoryHasMore = true;
  }
  updateOlderChatButton();

  requestViewScroll('chat');
  if (activeTab !== 'chat' || document.visibilityState === 'hidden'
    || typeof document.hasFocus === 'function' && !document.hasFocus() || !viewScrolls.chat.pinned) {
    const unread = lines.filter((line) => !line.classList.contains('hidden')).length;
    if (unread) setChatUnread(chatUnread + unread); // 在别的页签 → 记未读
  }
}

function addChat(d) { appendChatMessages([d]); }

function prependChatMessages(messages) {
  const view = chatView();
  if (!view || !messages.length) return;
  const renderable = messages.filter((message) => !shouldSuppressChat(message && message.text));
  if (!renderable.length) return;
  const beforeHeight = view.scrollHeight;
  const fragment = document.createDocumentFragment();
  for (const message of renderable) fragment.appendChild(renderChatLine(message));
  view.prepend(fragment);
  while (view.childElementCount > CHAT_DOM_MAX) {
    const last = view.lastElementChild;
    if (!last) break;
    last.remove();
  }
  view.scrollTop += view.scrollHeight - beforeHeight;
  updateOlderChatButton();
}

function updateOlderChatButton() {
  const button = $('btn-load-earlier');
  if (!button) return;
  // Keep the header width stable when history first crosses the DOM window;
  // visibility changes must not move a user's reading anchor.
  const visible = activeTab === 'chat' && chatHistoryHasMore;
  button.classList.remove('hidden');
  button.style.visibility = visible ? 'visible' : 'hidden';
  button.style.pointerEvents = visible ? 'auto' : 'none';
  button.tabIndex = visible ? 0 : -1;
  button.setAttribute('aria-hidden', String(!visible));
  button.disabled = chatHistoryLoading;
  button.textContent = chatHistoryLoading ? '加载中…' : '加载更早聊天';
}

async function loadOlderChat() {
  if (chatHistoryLoading || !chatHistoryHasMore || !window.api.getChatHistory) return;
  const first = chatView().querySelector('.chat-line[data-t]');
  const before = first ? Number(first.dataset.t) : Infinity;
  if (!Number.isFinite(before)) return;
  chatHistoryLoading = true; updateOlderChatButton();
  try {
    const result = await window.api.getChatHistory({ before: chatHistoryCursor ? undefined : before, limit: 400, cursor: chatHistoryCursor });
    chatHistoryCursor = result && result.cursor || null;
    const records = result && Array.isArray(result.records) ? result.records : [];
    if (records.length) prependChatMessages(records);
    chatHistoryHasMore = !!(result && result.hasMore);
  } catch (e) {
    toast('更早聊天加载失败：' + (e.message || '未知错误'), 'err');
  } finally {
    chatHistoryLoading = false; updateOlderChatButton();
  }
}

async function loadRecentChatHistory() {
  if (!window.api.getChatHistory) return;
  try {
    const result = await window.api.getChatHistory({ limit: CHAT_DOM_MAX });
    chatHistoryCursor = result && result.cursor || null;
    const records = result && Array.isArray(result.records) ? result.records : [];
    if (records.length) appendChatMessages(records);
    chatHistoryHasMore = !!(result && result.hasMore);
    updateOlderChatButton();
  } catch (_) { /* History is optional; a read failure must not block connection. */ }
}

const CHAT_RENDER_BATCH = 80;
const CHAT_QUEUE_MAX = CHAT_DOM_MAX * 2;
const CHAT_QUEUE_CHAR_MAX = 2 * 1024 * 1024;
let chatRenderQueue = [];
let chatRenderQueueChars = 0;
let chatRenderFrame = null;
let chatRenderFallback = null;
function flushChatQueue() {
  if (chatRenderFallback !== null) { clearTimeout(chatRenderFallback); chatRenderFallback = null; }
  chatRenderFrame = null;
  if (document.visibilityState === 'hidden') return;
  if (!chatRenderQueue.length) return;
  const batch = chatRenderQueue.splice(0, CHAT_RENDER_BATCH);
  chatRenderQueueChars -= batch.reduce((total, item) => total + String(item && item.text || '').length, 0);
  appendChatMessages(batch);
  if (chatRenderQueue.length) chatRenderFrame = requestViewFrame(flushChatQueue);
}
function queueChat(d) {
  if (shouldSuppressChat(d && d.text)) return;
  const size = String(d && d.text || '').length;
  while (chatRenderQueue.length >= CHAT_QUEUE_MAX
    || (chatRenderQueue.length > 0 && chatRenderQueueChars + size > CHAT_QUEUE_CHAR_MAX)) {
    const dropped = chatRenderQueue.shift();
    chatRenderQueueChars -= String(dropped && dropped.text || '').length;
  }
  chatRenderQueue.push(d);
  chatRenderQueueChars += size;
  if (document.visibilityState === 'hidden') return;
  if (chatRenderFrame === null) {
    chatRenderFrame = requestViewFrame(flushChatQueue);
    chatRenderFallback = setTimeout(() => {
      if (chatRenderFrame !== null) {
        cancelViewFrame(chatRenderFrame);
        flushChatQueue();
      }
    }, 32);
  }
}

function filterChatLine(line) {
  const filter = $('chat-filter').value || 'all';
  const blocked = shouldSuppressChat(line._chatText);
  const hiddenPresence = line.dataset.category === 'presence' && filter !== 'presence'
    && (!cfg || !cfg.display || cfg.display.hidePresence !== false);
  line.classList.toggle('hidden', blocked || hiddenPresence || (filter !== 'all' && filter !== line.dataset.category));
}

function shouldSuppressChat(text) {
  return !!(chatFilter && typeof chatFilter.shouldSuppressChat === 'function'
    && chatFilter.shouldSuppressChat(text, cfg && cfg.display && cfg.display.chatBlocklist));
}

function presenceTarget() {
  return connectionActive && currentTarget ? currentTarget : cfg && cfg.servers[selected];
}

function renderPresenceTarget() {
  const target = presenceTarget();
  const label = target ? target.host + ':' + (target.port || 25565) : '未选择服务器';
  if ($('presence-server').textContent !== label) {
    $('presence-name').value = '';
    $('presence-server').textContent = label;
  }
  renderOnlinePlayers();
}

function renderOnlinePlayers() {
  const target = presenceTarget();
  const key = target && target.host.trim().toLowerCase() + ':' + (target.port || 25565);
  const known = onlineSnapshot.known && onlineSnapshot.server === key;
  const players = known ? onlineSnapshot.players : [];
  const needle = $('presence-name').value.trim().toLowerCase();
  if (onlineRendered && onlineRendered.key === key && onlineRendered.known === known
    && onlineRendered.version === onlineSnapshotVersion && onlineRendered.needle === needle) return;
  if (!onlineRendered || onlineRendered.key !== key) {
    onlinePlayerNodes.clear(); $('online-players').replaceChildren();
  }
  onlineRendered = { key, known, version: onlineSnapshotVersion, needle };
  const matches = players.filter((player) => player.name.toLowerCase().includes(needle));
  $('online-count').textContent = known ? '服务器玩家列表 · ' + players.length + ' 人'
    + (needle ? ' · 匹配 ' + matches.length + ' 人' : '') : '尚未收到该服务器的玩家列表';
  $('presence-summary').textContent = !known ? '暂无在线名单'
    : needle ? '没有匹配的玩家' : '当前没有在线玩家';
  $('presence-summary').classList.toggle('hidden', matches.length > 0);
  const list = $('online-players');
  const retained = new Set();
  let cursor = list.firstElementChild;
  for (const player of matches) {
    const id = player.name.toLowerCase(); retained.add(id);
    let entry = onlinePlayerNodes.get(id);
    if (!entry) {
      const button = document.createElement('div');
      button.className = 'online-player'; button.tabIndex = 0; button.setAttribute('role', 'button');
      const name = document.createElement('span'), latency = document.createElement('small');
      const monitor = document.createElement('button');
      monitor.type = 'button'; monitor.className = 'player-monitor';
      button.append(name, latency, monitor);
      button.addEventListener('click', (event) => {
        if (event && event.target && event.target.closest && event.target.closest('.player-monitor')) return;
        $('presence-name').value = name.textContent;
        renderOnlinePlayers();
        $('presence-name').focus();
      });
      button.addEventListener('keydown', (event) => {
        if ((event.key === 'Enter' || event.key === ' ') && !event.target.closest('.player-monitor')) {
          event.preventDefault(); button.click();
        }
      });
      monitor.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleMonitoredPlayer(name.textContent);
      });
      entry = { button, name, latency, monitor }; onlinePlayerNodes.set(id, entry);
    }
    const { button, name, latency, monitor } = entry;
    if (name.textContent !== player.name) name.textContent = player.name;
    const latencyText = Number.isFinite(player.latency) ? player.latency + ' ms' : '';
    if (latency.textContent !== latencyText) latency.textContent = latencyText;
    const pressed = String(id === needle);
    if (entry.pressed !== pressed) { button.setAttribute('aria-pressed', pressed); entry.pressed = pressed; }
    const monitored = isMonitoredPlayer(player.name);
    const monitorPressed = String(monitored);
    if (monitor.getAttribute('aria-pressed') !== monitorPressed) monitor.setAttribute('aria-pressed', monitorPressed);
    const monitorText = monitored ? '取消监测' : '监测';
    if (monitor.textContent !== monitorText) monitor.textContent = monitorText;
    monitor.title = monitored ? '停止监测该玩家发言' : '监测该玩家发言';
    if (entry.displayName !== player.displayName || entry.latencyValue !== player.latency) {
      button.title = [player.displayName, Number.isFinite(player.latency) ? '延迟：' + player.latency + ' ms' : ''].filter(Boolean).join('\n');
      entry.displayName = player.displayName; entry.latencyValue = player.latency;
    }
    if (button === cursor) cursor = cursor.nextElementSibling;
    else list.insertBefore(button, cursor);
  }
  for (const [id, entry] of onlinePlayerNodes) if (!retained.has(id)) {
    entry.button.remove(); onlinePlayerNodes.delete(id);
  }
}

function isMonitoredPlayer(name) {
  const target = String(name || '').toLowerCase();
  return !!target && !!(cfg && Array.isArray(cfg.monitoredPlayers)
    && cfg.monitoredPlayers.some((item) => String(item).toLowerCase() === target));
}

async function toggleMonitoredPlayer(name) {
  const clean = String(name || '').trim();
  if (!/^[A-Za-z0-9_]{1,16}$/.test(clean) || !cfg) return;
  const current = Array.isArray(cfg.monitoredPlayers) ? cfg.monitoredPlayers.slice() : [];
  const index = current.findIndex((item) => String(item).toLowerCase() === clean.toLowerCase());
  if (index >= 0) current.splice(index, 1);
  else current.push(clean);
  cfg.monitoredPlayers = current;
  onlineRendered = null;
  renderOnlinePlayers();
  if (await persistConfig()) addLog('app', index >= 0 ? `已停止监测玩家：${clean}` : `已开始监测玩家：${clean}`);
}

function renderShortcuts() {
  const select = $('shortcut-select');
  select.replaceChildren();
  const empty = document.createElement('option'); empty.value = ''; empty.textContent = '快捷指令';
  select.appendChild(empty);
  for (const [index, entry] of (cfg.shortcuts || []).entries()) {
    const option = document.createElement('option'); option.value = String(index); option.textContent = entry.name;
    select.appendChild(option);
  }
}

function clearCompletion() {
  completionGeneration++; completion = null;
  $('completion-list').replaceChildren(); $('completion-list').classList.add('hidden');
}

function chooseCompletion(index, close = false) {
  if (!completion || !connected || completion.session !== chatSession) return clearCompletion();
  completion.index = (index + completion.matches.length) % completion.matches.length;
  const candidate = completion.matches[completion.index];
  const value = completion.base.slice(0, completion.start) + candidate.text
    + completion.base.slice(completion.start + completion.length);
  $('inp-send').value = value;
  const caret = completion.start + candidate.text.length;
  $('inp-send').focus(); $('inp-send').setSelectionRange(caret, caret);
  for (const [i, option] of [...$('completion-list').children].entries()) {
    option.setAttribute('aria-selected', String(i === completion.index));
    if (i === completion.index) option.scrollIntoView({ block: 'nearest' });
  }
  if (close) clearCompletion();
}

async function requestCompletion() {
  const input = $('inp-send');
  if (!connected || connectionBusy || !input.value.startsWith('/')) return;
  const base = input.value, cursor = input.selectionStart;
  const request = base.slice(0, cursor), session = chatSession;
  clearCompletion(); const generation = completionGeneration;
  try {
    const result = await window.api.completeCommand(request);
    if (generation !== completionGeneration || session !== chatSession || !connected || input.value !== base) return;
    if (!result || !result.ok || !result.matches || !result.matches.length) {
      toast(result && result.error || '服务器没有返回补全项'); return;
    }
    completion = { base, session, start: result.start, length: result.length, matches: result.matches, index: 0 };
    const list = $('completion-list');
    for (const [index, match] of result.matches.entries()) {
      const option = document.createElement('button'); option.type = 'button'; option.className = 'completion-option';
      option.setAttribute('role', 'option'); option.textContent = match.text; option.title = match.tooltip || match.text;
      option.addEventListener('click', () => chooseCompletion(index, true));
      list.appendChild(option);
    }
    list.classList.toggle('hidden', result.matches.length === 1);
    chooseCompletion(0, result.matches.length === 1);
  } catch (e) { if (generation === completionGeneration) toast('补全未完成：' + e.message, 'err'); }
}

function renderMenuSlots(container, slots, count, menu = null) {
  container.replaceChildren();
  for (let i = 0; i < count; i++) {
    const item = slots[i];
    const cell = document.createElement(menu ? 'button' : 'div'); cell.className = 'menu-slot';
    if (menu) {
      cell.type = 'button'; cell.dataset.slot = String(i);
      cell.disabled = menu.interactive !== true || !!menuClickPending;
      const activate = (event, button) => {
        if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
        submitMenuClick(menu, i, button);
      };
      cell.addEventListener('click', (event) => { if (event.button === 0) activate(event, 0); });
      cell.addEventListener('contextmenu', (event) => { event.preventDefault(); activate(event, 1); });
    }
    cell.classList.toggle('empty', !item);
    cell.setAttribute('aria-label', '格子 ' + (i + 1) + (item ? '：' + item.name + ' × ' + item.count : '：空'));
    if (item) {
      const name = document.createElement('span'); name.className = 'menu-item-name'; name.textContent = item.name;
      const count = document.createElement('span'); count.className = 'menu-item-count'; count.textContent = item.count;
      cell.title = [item.name, item.identifier, ...(item.lore || [])].filter(Boolean).join('\n'); cell.append(name, count);
    }
    container.appendChild(cell);
  }
}

function renderServerMenu(menu) {
  const previous = serverMenu;
  const focus = document.activeElement;
  const focusedSlot = focus && focus.dataset && focus.dataset.slot;
  if (!menu || !previous || menu.token !== previous.token) menuClickPending = null;
  if (!menu || !previous || menu.token !== previous.token || menu.revision !== previous.revision) menuClickError = '';
  serverMenu = menu;
  const dialog = $('server-menu-dialog');
  if (!menu || !connected) { if (dialog.open) dialog.close(); serverMenu = null; return; }
  $('server-menu-title').textContent = menu.title;
  $('server-menu-status').textContent = menu.status === 'error' ? menu.error
    : menu.status === 'waiting' ? '等待物品数据'
    : menu.cursor ? '光标持有：' + menu.cursor.name + ' × ' + menu.cursor.count + ' · 菜单点击已暂停'
    : menu.pendingTimedOut ? '未收到菜单刷新，点击结果未知；请关闭后重新打开，不会自动重试'
    : menu.pending || menuClickPending ? '点击已提交 · 等待服务器刷新菜单'
    : menuClickError ? menuClickError
    : menu.interactive ? '已就绪 · ' + menu.slots.filter(Boolean).length + ' 个非空格子'
    : '只读 · 此菜单暂不支持点击';
  $('server-menu-grid').setAttribute('aria-busy', String(!!menu.pending || !!menuClickPending));
  const count = menu.expectedSlots || menu.slots.length;
  renderMenuSlots($('server-menu-grid'), menu.slots, count, menu);
  const inventory = menu.expectedSlots ? menu.slots.slice(count) : [];
  $('server-inventory').classList.toggle('hidden', !inventory.length);
  renderMenuSlots($('server-inventory-grid'), inventory, inventory.length);
  if (!dialog.open) { dialog.showModal(); $('server-menu-close').focus(); }
  else if (previous && previous.token === menu.token && focusedSlot !== undefined) {
    const target = $('server-menu-grid').querySelector('[data-slot="' + focusedSlot + '"]');
    if (target && !target.disabled) target.focus({ preventScroll: true });
    else $('server-menu-close').focus({ preventScroll: true });
  }
}

async function submitMenuClick(menu, slot, button) {
  if (!connected || connectionBusy || menuClickPending || !serverMenu || !menu.interactive
    || menu.token !== serverMenu.token || menu.revision !== serverMenu.revision || serverMenu.pending) return;
  const request = { id: menu.id, token: menu.token, revision: menu.revision, slot, button };
  menuClickError = '';
  menuClickPending = request;
  renderServerMenu(serverMenu);
  try {
    const result = await window.api.clickMenu(request);
    if (serverMenu && serverMenu.token === request.token) {
      if (!result || !result.ok) {
        menuClickError = result && result.error || '菜单点击未确认，不会自动重试';
        toast(menuClickError, 'err');
      }
      else toast('菜单点击已提交，执行结果以服务器回复为准', 'ok');
    }
  } catch (e) {
    if (serverMenu && serverMenu.token === request.token) {
      menuClickError = '菜单点击未确认，不会自动重试';
      toast(menuClickError, 'err');
    }
  } finally {
    if (menuClickPending === request) {
      menuClickPending = null;
      if (serverMenu && serverMenu.token === request.token) renderServerMenu(serverMenu);
    }
  }
}

async function closeServerMenu() {
  if (!serverMenu) return;
  const id = serverMenu.id;
  const token = serverMenu.token;
  try {
    const result = await window.api.closeMenu(id, token);
    if (result && result.ok && serverMenu && serverMenu.token === token && serverMenu.id === id) renderServerMenu(null);
    else if (serverMenu && serverMenu.token === token && serverMenu.id === id) toast(result && result.error || '关闭菜单未完成', 'err');
  } catch (e) { toast('关闭菜单未完成：' + e.message, 'err'); }
}

function renderChatDiagnostics(d) {
  if (!d || !d.received) { $('chat-diagnostics').textContent = '尚无接收诊断'; return; }
  const labels = { player: '玩家聊天', system: '系统消息', profileless: '无档案消息', actionbar: '快捷栏' };
  $('chat-diagnostics').textContent = Object.entries(labels).map(([kind, label]) =>
    label + '：收到 ' + d.received[kind] + ' / 转交界面 ' + d.emitted[kind] + ' / 解析失败 ' + d.errors[kind]).join('\n')
    + '\n坐标确认：' + d.teleportReplies + '/' + d.teleports + ' · 正文回退：' + d.detailFallbacks
    + ' · 入服就绪：' + (d.loadedReplies || 0) + ' · 聊天确认：' + (d.chatAcks || 0)
    + '\n插件通道：' + (Object.entries(d.pluginChannels || {}).map(([name, info]) => name + ' (' + info.packets + ')').join('、') || '尚无数据');
}

function setChatUnread(n) {
  chatUnread = n;
  const b = $('chat-badge');
  if (!b) return;
  if (n > 0) {
    b.textContent = n > 99 ? '99+' : String(n);
    b.classList.remove('hidden');
  } else {
    b.classList.add('hidden');
  }
}

function renderDailyPurchase(snapshot = purchaseSnapshot) {
  purchaseSnapshot = snapshot;
  const state = snapshot || { count: 0, status: 'pending' };
  const collecting = state.status === 'collecting';
  const retry = $('purchase-retry');
  retry.disabled = !connected || collecting || purchaseRequestPending;
  retry.textContent = collecting ? '正在获取' : state.status === 'error' ? '重试获取' : state.shops ? '重新获取' : '获取收购价';
  const collected = state.collectedAt ? new Date(state.collectedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '';
  const autoCount = state.autoCount ?? state.count ?? 0;
  $('purchase-meta').textContent = [state.day, state.context, '今日自动 ' + autoCount + '/1',
    '手动成功 ' + (state.manualCount || 0) + ' 次',
    collected && collected + ' 采集快照'].filter(Boolean).join(' · ');
  $('purchase-empty').classList.toggle('hidden', !!state.shops && !collecting && !state.error);
  $('purchase-empty').textContent = collecting ? '正在读取系统收购与农作物收购…'
    : state.error || (connected ? '等待获取今日收购价' : '连接服务器后获取今日收购价');
  if (purchaseRendered === snapshot) return;
  purchaseRendered = snapshot;
  const container = $('purchase-shops'); container.replaceChildren();
  if (!state.shops) return;
  for (const [key, label] of [['system', '系统收购'], ['crops', '农作物收购']]) {
    const shop = state.shops[key]; if (!shop) continue;
    const section = document.createElement('section'); section.className = 'purchase-section';
    const heading = document.createElement('h3'); heading.textContent = label;
    const summary = document.createElement('p'); summary.className = 'purchase-summary';
    const totals = new Map();
    for (const item of shop.items) totals.set(item.unit, (totals.get(item.unit) || 0) + item.price * item.limit);
    summary.textContent = shop.items.length + ' 种 · 满额理论收益 ' + [...totals].map(([unit, value]) =>
      Number(value.toFixed(2)).toLocaleString('zh-CN') + ' ' + unit).join(' / ');
    const wrap = document.createElement('div'); wrap.className = 'purchase-table-wrap';
    const table = document.createElement('table'); table.className = 'purchase-table';
    const head = document.createElement('thead'), headings = document.createElement('tr');
    for (const name of ['物品', '单价', '趋势', '已卖/限量', '剩余', '状态']) {
      const th = document.createElement('th'); th.scope = 'col'; th.textContent = name; headings.appendChild(th);
    }
    head.appendChild(headings); table.appendChild(head);
    const body = document.createElement('tbody');
    for (const item of shop.items) {
      const row = document.createElement('tr'); row.classList.toggle('purchase-sold', item.remaining === 0);
      const values = [item.name, item.price.toLocaleString('zh-CN') + (item.unit ? ' ' + item.unit : ''),
        item.trend === 'up' ? '上涨' : item.trend === 'down' ? '下跌' : '持平',
        item.sold + '/' + item.limit, String(item.remaining), item.remaining === 0 ? '已卖满' : '可卖'];
      values.forEach((value, i) => {
        const cell = document.createElement('td'); cell.textContent = value;
        if (i === 0) cell.title = [item.rawName, item.identifier, ...(item.lore || [])].filter(Boolean).join('\n');
        if (i === 1) cell.className = 'purchase-price';
        if (i === 2) cell.className = ({ up: 'purchase-trend-up', down: 'purchase-trend-down' })[item.trend] || 'purchase-trend-flat';
        row.appendChild(cell);
      });
      body.appendChild(row);
    }
    table.appendChild(body); wrap.appendChild(table);
    section.appendChild(heading); section.appendChild(summary); section.appendChild(wrap); container.appendChild(section);
  }
}

function switchTab(name) {
  if (activeTab !== name && ['chat', 'log'].includes(activeTab)) rememberViewPosition(activeTab);
  cancelViewScroll('chat'); cancelViewScroll('log');
  clearCompletion();
  activeTab = name;
  const isChat = name === 'chat';
  $('tab-chat').classList.toggle('active', isChat);
  $('tab-log').classList.toggle('active', name === 'log');
  $('tab-presence').classList.toggle('active', name === 'presence');
  $('tab-purchase').classList.toggle('active', name === 'purchase');
  $('tab-attention').classList.toggle('active', name === 'attention');
  $('chat-view').classList.toggle('hidden', !isChat);
  $('log-view').classList.toggle('hidden', name !== 'log');
  $('presence-view').classList.toggle('hidden', name !== 'presence');
  $('purchase-view').classList.toggle('hidden', name !== 'purchase');
  $('attention-view').classList.toggle('hidden', name !== 'attention');
  $('chat-diagnostics').classList.toggle('hidden', name !== 'log');
  $('send-bar').classList.toggle('hidden', !['chat', 'log'].includes(name));
  $('btn-clear').classList.toggle('hidden', !['chat', 'log'].includes(name));
  $('chat-filter').classList.toggle('hidden', !isChat);
  $('log-filter').classList.toggle('hidden', name !== 'log');
  updateOlderChatButton();
  if (name === 'presence') renderPresenceTarget();
  if (isChat) {
    setChatUnread(0);
  }
  if (name === 'purchase') renderDailyPurchase();
  if (name === 'attention') window.AttentionUI?.refresh();
  if (['chat', 'log'].includes(name)) { restoreViewPosition(name); scheduleViewScroll(name); }
}

/* ---------------- 事件绑定 ---------------- */

function bind() {
  chatView().addEventListener('click', handleChatClick);
  for (const name of ['chat', 'log']) {
    const view = $(name + '-view');
    const stopFollowing = () => {
      cancelViewScroll(name); viewScrolls[name].dirty = false; viewScrolls[name].pinned = false; viewScrolls[name].anchor = null;
    };
    for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) view.addEventListener(event, stopFollowing, { passive: true });
    view.addEventListener('scroll', () => {
      const state = viewScrolls[name];
      if (activeTab === name && !state.dirty && state.frame === null) {
        state.pinned = view.scrollHeight - view.clientHeight - view.scrollTop < 2;
      }
      if (name === 'chat' && view.scrollTop < 32) loadOlderChat();
    }, { passive: true });
  }
  $('presence-name').addEventListener('input', renderOnlinePlayers);
  $('shortcut-select').addEventListener('change', () => {
    const entry = (cfg.shortcuts || [])[$('shortcut-select').value];
    $('shortcut-select').value = '';
    if (!entry || !connected) return;
    clearCompletion(); $('inp-send').value = entry.command; $('inp-send').focus();
    $('inp-send').setSelectionRange(entry.command.length, entry.command.length);
  });
  $('server-menu-close').addEventListener('click', closeServerMenu);
  $('server-menu-dialog').addEventListener('cancel', (e) => { e.preventDefault(); closeServerMenu(); });
  for (const name of ['chat', 'log']) {
    $(name + '-filter').addEventListener('change', () => {
      const value = $(name + '-filter').value;
      const view = $(name + '-view');
      for (const line of view.querySelectorAll('.' + name + '-line')) {
        if (name === 'chat') filterChatLine(line);
        else line.classList.toggle('hidden', value !== 'all' && line.dataset.category !== value);
      }
      requestViewScroll(name);
    });
  }
  $('btn-settings').addEventListener('click', () => {
    populateSettings();
    $('settings-dialog').showModal();
    $('settings-close').focus();
  });
  $('settings-close').addEventListener('click', closeSettings);
  $('settings-cancel').addEventListener('click', closeSettings);
  $('settings-dialog').addEventListener('cancel', (event) => { if (settingsSaving) event.preventDefault(); });
  $('settings-form').addEventListener('submit', saveSettings);
  $('bridge-exit-player').addEventListener('input', () => { $('bridge-exit-error').textContent = ''; renderBridgeTargets(); });
  $('bridge-exit-player').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); addBridgeTarget(); }
  });
  $('bridge-exit-add').addEventListener('click', addBridgeTarget);
  $('btn-data').addEventListener('click', async () => {
    const value = await window.api.revealData();
    addLog('app', '数据目录：' + value);
  });
  $('btn-diagnostic').addEventListener('click', async () => {
    const result = await window.api.createDiagnosticReport();
    if (result && result.ok) {
      addLog('app', '已生成脱敏诊断报告：' + result.path);
      toast('诊断报告已生成', 'ok');
    } else toast((result && result.error) || '诊断报告生成失败', 'err');
  });
  $('btn-reload-renderer').addEventListener('click', () => window.api.reloadRenderer());
  $('btn-load-earlier').addEventListener('click', loadOlderChat);
  $('btn-history-path').addEventListener('click', async () => {
    const result = await window.api.chooseHistoryPath();
    if (result && result.ok) { storagePathDraft = result.path; renderHistoryPath(); }
  });
  $('btn-history-open').addEventListener('click', async () => {
    const value = await window.api.revealHistory();
    addLog('app', '记录与缓存目录：' + value);
  });
  $('chk-reconnect').addEventListener('change', updateReconnectFields);
  $('chk-midnight').addEventListener('change', updateMidnightField);
  $('chk-autoclaim').addEventListener('change', updateClaimFields);
  $('chk-claim-after').addEventListener('change', () => {
    if ($('chk-claim-after').checked) $('chk-claim-delay').checked = false;
    updateClaimFields();
  });
  $('chk-claim-delay').addEventListener('change', () => {
    if ($('chk-claim-delay').checked) $('chk-claim-after').checked = false;
    updateClaimFields();
  });
  $('chk-welcome-delay').addEventListener('change', updateWelcomeFields);
  // 登录账号
  $('btn-login').addEventListener('click', async () => {
    $('btn-login').disabled = true;
    $('btn-login').textContent = '等待授权...';
    showDeviceCode(null);          // 先清空上一次的代码
    addLog('auth', '正在启动微软账号授权流程…');
    let r;
    try {
      r = await window.api.loginAccount({ forceInteractive: savedAccounts.length > 0 });
    } catch (e) {
      r = { ok: false, error: (e && e.message) || '未知错误' };
    }
    $('btn-login').disabled = false;
    hideDeviceCode();
    if (r && r.ok) {
      await refreshAccountView({ name: r.profile.name, uuid: r.profile.id });
      addLog('ok', '正版账号已就绪：' + r.profile.name);
      toast(savedAccounts.length > 1 ? '已添加并切换账号' : '账号登录成功', 'ok');
    } else {
      const msg = (r && r.error) || '未知错误';
      addLog('error', '登录失败：' + msg);
      toast('登录失败：' + msg, 'err');
      $('btn-login').textContent = '登录微软账号';
    }
  });

  // 强制重新授权
  $('btn-relogin').addEventListener('click', async () => {
    $('btn-relogin').disabled = true;
    showDeviceCode(null);
    addLog('auth', '强制重新授权，请按提示输入代码');
    let r;
    try {
      r = await window.api.loginAccount({ forceInteractive: true });
    } catch (e) {
      r = { ok: false, error: (e && e.message) || '未知错误' };
    }
    $('btn-relogin').disabled = false;
    hideDeviceCode();
    if (r && r.ok) {
      await refreshAccountView({ name: r.profile.name, uuid: r.profile.id });
      addLog('ok', '已切换到账号：' + r.profile.name);
      toast('已切换到 ' + r.profile.name, 'ok');
    } else {
      const msg = (r && r.error) || '未知错误';
      addLog('error', '授权失败：' + msg);
      toast('授权失败：' + msg, 'err');
    }
  });

  // 设备代码提示条：复制 / 重新打开
  $('dc-copy').addEventListener('click', () => {
    const code = $('dc-code').textContent.trim();
    if (!code || code === '————') return;
    copyText(code).then((ok) => toast(ok ? '代码已复制' : '复制失败，请手动选中复制', ok ? 'ok' : 'err'));
  });
  $('dc-open').addEventListener('click', () => {
    const uri = $('dc-uri').textContent.trim();
    if (uri && window.api.openExternal) window.api.openExternal(uri);
  });

  $('btn-account-switch').addEventListener('click', async () => {
    const uuid = $('account-select').value;
    if (!uuid || accountSwitchBusy) return;
    accountSwitchBusy = true;
    $('btn-account-switch').disabled = true;
    addLog('auth', '正在切换本地账号…');
    let r;
    try {
      r = await window.api.switchAccount(uuid);
    } catch (e) {
      r = { ok: false, error: (e && e.message) || '未知错误' };
    }
    accountSwitchBusy = false;
    $('btn-account-switch').disabled = false;
    if (r && r.ok) {
      await refreshAccountView({ name: r.profile.name, uuid: r.profile.id });
      addLog('ok', '已切换到账号：' + r.profile.name);
      toast('已切换到 ' + r.profile.name, 'ok');
    } else {
      const msg = (r && r.error) || '未知错误';
      addLog('error', '切换账号失败：' + msg);
      toast('切换失败：' + msg, 'err');
    }
  });

  // 退出账号
  $('btn-logout').addEventListener('click', async () => {
    await window.api.logoutAccount();
    const state = await window.api.peekAccount();
    renderAccount(null, state.accounts, state.activeUuid);
    addLog('auth', '已移除当前账号的本地凭据，其他账号仍保留');
    toast('已移除当前账号');
  });

  // 添加服务器
  $('btn-add').addEventListener('click', () => {
    $('modal-add').classList.remove('hidden');
    $('add-name').value = '';
    $('add-host').value = '';
    $('add-port').value = '25565';
    $('add-host').focus();
  });
  $('add-cancel').addEventListener('click', () => $('modal-add').classList.add('hidden'));
  $('add-ok').addEventListener('click', async () => {
    const host = $('add-host').value.trim();
    if (!host) { toast('请填写服务器地址', 'err'); return; }
    const port = parseInt($('add-port').value.trim() || '25565', 10);
    cfg.servers.push({
      name: $('add-name').value.trim() || host,
      host,
      port: isNaN(port) ? 25565 : port,
    });
    if (!await persistConfig()) return;
    $('modal-add').classList.add('hidden');
    selected = cfg.servers.length - 1;
    try { await refreshSelectedProfile(); } catch (e) { toast(e.message, 'err'); }
    renderServers();
    updateConnPanel();
    autoPing(selected);
  });

  for (const id of ['mode-standalone', 'mode-bridge']) {
    $(id).addEventListener('change', async () => {
      if (connectionBusy) return;
      const next = $(id).value;
      connectionBusy = 'mode'; updateConnPanel();
      try {
        const result = await window.api.setConnectionMode(next);
        if (!result.ok) toast(result.error || '模式切换失败', 'err');
        else { connectionMode = next; cfg.connectionMode = next; currentTarget = null; bridgeState = { listening: false, paired: false, online: false }; }
      } catch (e) { toast(e.message || '模式切换失败', 'err'); }
      finally { connectionBusy = ''; updateConnPanel(); }
    });
  }
  $('btn-bridge-export').addEventListener('click', async () => {
    try {
      const result = await window.api.exportBridgePairing();
      if (result.ok) toast('配对文件已导出', 'ok');
      else if (!result.canceled) toast(result.error || '配对导出失败', 'err');
    } catch (e) { toast(e.message || '配对导出失败', 'err'); }
  });

  // 连接 / 断开
  $('btn-connect').addEventListener('click', async () => {
    if (connectionBusy) return;

    if (connectionActive || isReconnecting()) {
      connectionBusy = 'disconnect';
      updateConnPanel();
      let r;
      try {
        r = await window.api.disconnect();
      } catch (e) {
        r = { ok: false, error: (e && e.message) || '未知错误' };
      }
      connectionBusy = '';
      if (r && r.ok) {
        connectionActive = false;
        connected = false;
        reconnectState = { phase: 'idle' };
        currentTarget = null;
        bridgeState = { listening: false, paired: false, online: false };
        renderReconnectState();
        updateStats({ state: 'idle' });
        addLog('app', '已主动断开连接');
        try { await refreshSelectedProfile(); } catch (e) { toast(e.message, 'err'); }
      } else {
        const msg = (r && r.error) || '未知错误';
        addLog('error', '断开失败：' + msg);
        toast('断开失败：' + msg, 'err');
      }
      updateConnPanel();
      return;
    }

    if (connectionMode === 'bridge') {
      connectionBusy = 'connect'; updateConnPanel();
      try {
        const result = await window.api.startBridge();
        if (!result.ok) toast(result.error || '桥接启动失败', 'err');
        else { bridgeState.listening = true; connectionActive = true; }
      } catch (e) { toast(e.message || '桥接启动失败', 'err'); }
      finally { connectionBusy = ''; updateConnPanel(); }
      return;
    }
    const s = cfg.servers[selected];
    if (!s) return;

    if (!accountLoggedIn) {
      toast('正版验证登录需要先登录微软账号', 'err');
      return;
    }

    connectionActive = true;
    connected = false;
    currentTarget = { host: s.host, port: s.port || 25565 };
    connectionBusy = 'connect';
    updateConnPanel();
    addLog('net', `正在连接 ${s.host}:${s.port || 25565}（正版验证模式）`);

    let r;
    try {
      r = await window.api.connect({
        host: s.host,
        port: s.port || 25565,
        usePremium: true,
      });
    } catch (e) {
      r = { ok: false, error: (e && e.message) || '未知错误' };
    }

    connectionBusy = '';
    if (connectionMode !== 'bridge' && (!r || !r.ok)) {
      connectionActive = isReconnecting();
      connected = false;
      addLog('error', '连接失败：' + ((r && r.error) || '未知错误'));
      toast('连接失败：' + ((r && r.error) || '未知错误'), 'err');
    }
    // TCP 成功不代表已进入游戏，也不能覆盖期间收到的断线状态。
    updateConnPanel();
  });

  // 发送消息：同时回显到「聊天」页签（自己发的消息也算聊天记录的一部分）
  const send = async () => {
    if (!connected || connectionBusy || sending) return;
    const v = $('inp-send').value.trim();
    if (!v) return;
    clearCompletion();
    sending = true;
    updateConnPanel();
    try {
      const result = await window.api.say(v);
      if (!result || !result.ok) {
        toast((result && result.error) || '消息未发送', 'err');
        return;
      }
      const isCmd = v.startsWith('/');
      if (isCmd) addLog('app', '已发送手动指令');
      if (!isCmd) {
        addChat({
          text: v,
          type: 'mine',
          sender: accountLoggedIn ? $('skin-name').textContent : (cfg && cfg.username) || '我',
          t: Date.now(),
        });
      }
      if ($('inp-send').value.trim() === v) $('inp-send').value = '';
    } catch (e) {
      toast('消息未发送：' + (e.message || '未知错误'), 'err');
    } finally {
      sending = false;
      updateConnPanel();
    }
  };
  $('btn-send').addEventListener('click', send);
  $('inp-send').addEventListener('input', clearCompletion);
  $('inp-send').addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'Tab' && $('inp-send').value.startsWith('/')) {
      e.preventDefault();
      if (completion) chooseCompletion(completion.index + (e.shiftKey ? -1 : 1));
      else requestCompletion();
    } else if (completion && ['ArrowDown', 'ArrowUp'].includes(e.key)) {
      e.preventDefault(); chooseCompletion(completion.index + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Escape') clearCompletion();
    else if (e.key === 'Enter') {
      e.preventDefault(); if (completion) chooseCompletion(completion.index, true); else send();
    }
  });

  // 页签切换
  $('tab-chat').addEventListener('click', () => switchTab('chat'));
  $('tab-log').addEventListener('click', () => switchTab('log'));
  $('tab-presence').addEventListener('click', () => switchTab('presence'));
  $('tab-purchase').addEventListener('click', () => switchTab('purchase'));
  $('purchase-retry').addEventListener('click', async () => {
    if (purchaseRequestPending || !connected) return;
    purchaseRequestPending = true; renderDailyPurchase();
    try {
      const result = await window.api.retryDailyPurchase();
      if (!result.ok) toast(result.error || '获取失败', 'err');
    } catch (_) { toast('获取请求未完成', 'err'); }
    finally { purchaseRequestPending = false; renderDailyPurchase(); }
  });

  // 清空：清当前所处的页签（用户看哪个就是想清哪个）
  $('btn-clear').addEventListener('click', () => {
    if (activeTab === 'chat') {
      chatRenderQueue = [];
      chatRenderQueueChars = 0;
      if (chatRenderFrame !== null) { cancelViewFrame(chatRenderFrame); chatRenderFrame = null; }
      if (chatRenderFallback !== null) { clearTimeout(chatRenderFallback); chatRenderFallback = null; }
      cancelViewScroll('chat'); viewScrolls.chat.dirty = false; viewScrolls.chat.pinned = true; viewScrolls.chat.anchor = null;
      const v = chatView();
      v.innerHTML = '';
      chatHistoryHasMore = false;
      chatHistoryLoading = false;
      updateOlderChatButton();
      setChatUnread(0);
      const tip = document.createElement('div');
      tip.className = 'chat-empty';
      tip.id = 'chat-empty';
      tip.textContent = '连接服务器后，这里显示服务器的聊天与广播';
      v.appendChild(tip);
    } else {
      cancelViewScroll('log'); viewScrolls.log.dirty = false; viewScrolls.log.pinned = true; viewScrolls.log.anchor = null;
      $('log-view').innerHTML = '';
    }
  });

  // 数据目录：同时告诉用户配置文件到底在哪（排查"保存没生效"最直观）
  $('btn-data').addEventListener('click', async () => {
    const p = await window.api.revealData();
    addLog('app', '数据目录：' + p);
    try {
      const cp = await window.api.getConfigPath();
      addLog('app', '配置文件：' + cp);
    } catch (e) {}
  });

  // 资源监控：展开/收起进程明细
  $('btn-mon-detail').addEventListener('click', async () => {
    monDetailOpen = !monDetailOpen;
    $('mon-detail').classList.toggle('hidden', !monDetailOpen);
    $('btn-mon-detail').textContent = monDetailOpen ? '收起' : '明细';
    $('btn-mon-detail').setAttribute('aria-expanded', String(monDetailOpen));
    if (monDetailOpen) {
      // 立刻拉一次，避免展开后空白等一秒
      try { renderMonitorDetail(await window.api.getMetrics()); } catch (e) {}
    }
  });

  // 主进程推送
  window.api.onLog((d) => {
    addLog(d.level, d.text, d.t);
    // 从授权日志里抽出设备代码与验证网址，弹到醒目提示条上
    if (d.level === 'auth' && typeof d.text === 'string') {
      const mc = d.text.match(DC_LINE);
      const mu = d.text.match(DC_URI_LINE);
      if (mc) showDeviceCode(mc[1], mu ? mu[1] : undefined);
      else if (mu) {
        // 网址先到（auth.js 先打网址再打代码）——先把网址存进去，代码到了再显示
        $('dc-uri').textContent = mu[1];
      }
    }
  });
  window.api.onStatus((p) => {
    if (p.bridgeExitPending !== undefined) connectionBusy = p.bridgeExitPending ? 'disconnect' : '';
    if (p.profileChanged && window.api.getConfig) window.api.getConfig().then((next) => {
      cfg = next; selected = Math.min(selected, (cfg.servers || []).length - 1);
      renderServers(); renderShortcuts(); applyDisplaySettings(); window.AttentionUI?.refresh();
    }).catch(() => {});
    if (p.connectionMode) connectionMode = p.connectionMode;
    if (p.connectionMode) cfg.connectionMode = p.connectionMode;
    if (p.bridge) bridgeState = p.bridge;
    if (p.chatDiagnostics !== undefined) renderChatDiagnostics(p.chatDiagnostics);
    const automatedAction = p.automationAction || p.redPacketAction;
    if (automatedAction && automatedAction.session === chatSession) {
      const action = automatedAction;
      if (action.used) {
        for (const button of chatView().querySelectorAll('.chat-action')) {
          if (button.dataset.session === action.session && button.dataset.actionKind === 'run_command'
            && button.dataset.actionValue === action.value) {
            button.dataset.used = 'true';
            button.title = action.source === 'welcome' ? '已处理自动欢迎入口；结果以服务器为准'
              : '已自动执行领取指令；到账以服务器确认为准';
            updateChatAction(button);
          }
        }
      } else if (action.action === 'suggest_command' && connected && !$('inp-send').value.trim()) {
        $('inp-send').value = action.value;
      }
    }
    if (p.target) currentTarget = p.target;
    if (p.account !== undefined || p.accounts !== undefined) {
      renderAccount(p.account, p.accounts, p.activeUuid);
    }
    if (p.connected === false || p.state === 'idle' || p.state === 'closed'
      || p.event === 'close' || p.event === 'kick' || p.event === 'need-auth') {
      connectionActive = false;
      connected = false;
      chatSession = null;
    } else if (p.event === 'join' || p.connected === true || p.state === 'play') {
      connectionActive = true;
      connected = true;
      if (p.chatSession) chatSession = p.chatSession;
    } else if (p.state === 'login' || p.state === 'config'
      || p.event === 'login' || p.event === 'reconfig') {
      connectionActive = true;
      connected = false;
      chatSession = null;
    }
    if (p.reconnect) {
      reconnectState = p.reconnect;
      if (isReconnecting()) {
        connectionActive = true;
        connected = false;
        chatSession = null;
        currentTarget = reconnectState.target || currentTarget;
      } else if (reconnectState.phase === 'idle' && !connected) {
        connectionActive = false;
        currentTarget = null;
        updateStats({ state: 'idle' });
      }
    }
    if (connectionMode === 'bridge' && (bridgeState.listening || bridgeState.starting)) connectionActive = true;
    if (p.players !== undefined) {
      onlineSnapshot = p.players; onlineSnapshotVersion++;
      if ($('settings-dialog').open && !settingsSaving) renderBridgeTargets();
    }
    if (!connected && (onlineSnapshot.known || onlineSnapshot.players.length)) {
      onlineSnapshot = { known: false, players: [] }; onlineSnapshotVersion++;
    }
    updateConnPanel();
    if (p.menu !== undefined) renderServerMenu(p.menu);
    else if (!connected && serverMenu) renderServerMenu(null);
    if (p.dailyPurchase !== undefined) renderDailyPurchase(p.dailyPurchase);
    else if (activeTab === 'purchase') renderDailyPurchase();
    if (p.event === 'join') {
      addLog('ok', '★ 已进入服务器');
      // 聊天页签插一条分隔线，便于区分"这次连接之后"的消息
      const s = cfg && cfg.servers.find((server) => currentTarget
        && server.host === currentTarget.host && (server.port || 25565) === currentTarget.port);
      addChat({
        text: s ? `—— 已进入 ${s.name || s.host} ——` : '—— 已进入服务器 ——',
        type: 'actionbar',
        t: Date.now(),
      });
      toast('已进入服务器', 'ok');
    }
    if (p.event === 'need-auth') {
      toast('这是正版验证服，请先登录微软账号', 'err');
    }
    updateStats(p);
    if (connectionMode === 'bridge') $('st-auth').textContent = connected ? '游戏连接' : '—';
    renderReconnectState();
  });

  // 资源监控：主进程每秒推一次
  window.api.onMetrics((m) => renderMonitor(m));

  // 聊天：主进程单独推送（与运行日志分流）
  window.api.onChat((d) => { if (!cfg.behavior || cfg.behavior.showChat !== false) queueChat(d); });
  if (window.api.onAttention) window.api.onAttention(() => {
    if (document.visibilityState !== 'hidden') window.AttentionUI?.refresh();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') {
      for (const line of backgroundLogs.splice(0)) addLog(line.level, line.text, line.timestamp);
      flushChatQueue(); window.AttentionUI?.refresh();
    }
  });

  // ESC 关弹窗
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $('modal-add').classList.add('hidden');
  });
}

/* ---------------- 启动 ---------------- */

(async () => {
  cfg = await window.api.getConfig();
  connectionMode = cfg.connectionMode === 'bridge' ? 'bridge' : 'standalone';
  // 主进程读配置失败时会在 cfg.__loadError 上带原因（而不是静默给默认值）
  if (cfg && cfg.__loadError) {
    addLog('error', '配置文件读取失败：' + cfg.__loadError);
    toast('配置读取失败，已用默认配置启动', 'err');
  }
  populateSettings();
  renderShortcuts();

  const cachedRaw = await window.api.peekAccount();
  const cached = cachedRaw && cachedRaw.active
    ? cachedRaw
    : cachedRaw && cachedRaw.name
      ? { active: cachedRaw, activeUuid: cachedRaw.uuid, accounts: [cachedRaw] }
      : { active: null, activeUuid: null, accounts: [] };
  if (cached.active) {
    renderAccount(cached.active, cached.accounts, cached.activeUuid);
    addLog('auth', '发现本地已保存的账号：' + cached.active.name + '（连接时会自动免密续期）');
  } else {
    renderAccount(null, cached.accounts, cached.activeUuid);
  }

  if (cfg.servers.length) selected = 0;
  if (selected >= 0 && window.api.selectProfile) {
    const profile = await window.api.selectProfile(cfg.servers[selected]);
    if (profile.ok) cfg = profile.config;
  }
  renderServers();
  updateConnPanel();
  if (selected >= 0) autoPing(selected);

  bind();
  await loadRecentChatHistory();
  if (typeof window.api.getBridgeStatus === 'function') {
    try {
      const initial = await window.api.getBridgeStatus();
      connectionMode = initial.mode || 'standalone'; bridgeState = initial;
      connectionActive = initial.listening || initial.online;
      updateConnPanel();
    } catch (_) { /* An unavailable bridge does not block independent connections. */ }
  }
  try { onlineSnapshot = await window.api.getOnline(); } catch (_) { /* List is optional until the server sends it. */ }
  if (window.api.getDailyPurchase) {
    try { renderDailyPurchase(await window.api.getDailyPurchase()); } catch (_) { renderDailyPurchase(); }
  }
  addLog('net', '就绪。选择服务器后点「连接」即可。');
  switchTab('chat');          // 统一初始页签状态（避免 HTML 与 JS 各写一份而失配）
  applyDisplaySettings();

  // 启动时先主动拉一次资源数据，避免等满一秒才出现数字
  try {
    const m0 = await window.api.getMetrics();
    if (m0) renderMonitor(m0);
  } catch (e) { /* 监控不影响主流程 */ }

  window.addEventListener('resize', resizeMessageViews);
})();
