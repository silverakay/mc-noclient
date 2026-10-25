'use strict';
/*
 * auth.js —— 微软正版账号认证链（Microsoft / Xbox Live / Minecraft）
 *
 * 完整链路（官方规定，无法绕过）：
 *   1. 向微软申请「设备代码」，同时拿到一个短代码和验证网址
 *   2. 用户在浏览器打开验证网址、输入短代码、确认授权
 *   3. 程序轮询换取 Microsoft access_token + refresh_token
 *   4. Microsoft token → Xbox Live token (XBL)
 *   5. XBL token → XSTS token（scope 必须是 rps.tokens）
 *   6. XSTS token → Minecraft access_token
 *   7. Minecraft token → 正版档案（UUID / 名字 / 皮肤）
 *
 * 「不需要输密码」的正确含义：
 *   - 不用输 Minecraft 密码 —— 因为走的是微软账号体系
 *   - 但必须授权一次微软账号
 *   - 之后 refresh_token 缓存在本地，可以免交互刷新
 *
 * ============================================================================
 * ⚠️ 为什么用「设备代码流」而不是「授权码流」—— 一段很贵的踩坑记录
 * ============================================================================
 *
 * 本程序最初用的是**授权码流（authorization code + PKCE）**，靠本地 http 服务器
 * 接收 `redirect_uri` 回调来拿授权码。这条路在 2026 年**已经走不通了**，实测结论：
 *
 * 1) `login.microsoftonline.com/consumers/oauth2/v2.0/authorize` 对**任何**请求
 *    都先返回 302，跳到 `login.live.com/oauth20_authorize.srf`。
 *    第一跳的 302 **看起来像成功**，其实真正的校验发生在第二跳 —— 极易误判。
 *
 * 2) 第二跳才是校验者。用合法 PKCE challenge 实测，所有 localhost 回调地址
 *    在该端点上**一律被拒**：
 *
 *       http://localhost/auth-response          → invalid_request ❌
 *       http://localhost:25580/auth-response    → invalid_request ❌
 *       http://localhost:8080/auth-response     → invalid_request ❌
 *       http://127.0.0.1/auth-response          → invalid_request ❌
 *       https://localhost/auth-response         → invalid_request ❌
 *       http://localhost/auth-response/         → invalid_request ❌
 *
 *    而换成微软自己的 `https://login.live.com/oauth20_desktop.srf` 就**能过**：
 *
 *       https://login.live.com/oauth20_desktop.srf  → 到达登录页 ✅
 *
 *    → 说明公开 client_id 注册的回调**只有 desktop.srf 这一个**，压根没注册任何
 *      localhost 地址。所以无论端口怎么写都不可能过。
 *
 * 3) 更狠的是，`redirect_uri` 甚至不是真正的病根 —— 设备代码接口直接给出了答案：
 *
 *       POST /consumers/oauth2/v2.0/devicecode
 *       → AADSTS700016: Application with identifier '00000000402b5328'
 *         was not found in the directory '9188040d-...'
 *
 *    → 这个公开 client_id 在 `microsoftonline.com` 目录里**根本不存在**，
 *      它是 `login.live.com` 体系下的老式应用，两个端点不是同一套注册表。
 *
 * 4) 而 `login.live.com` 自己的设备代码接口**完全正常**：
 *
 *       POST https://login.live.com/oauth20_connect.srf
 *       → 200 { user_code: '9MJSF8EB', verification_uri: 'https://www.microsoft.com/link', ... }
 *
 *       POST https://login.live.com/oauth20_token.srf （用户未授权时）
 *       → 400 { error: 'authorization_pending' }   ← 预期内，证明链路是通的
 *
 * 结论：**改用设备代码流**。它：
 *   - 根本不需要 redirect_uri → 整整一类回调问题彻底消失
 *   - 用同一个 client_id `00000000402b5328` 就能跑通（实测）
 *   - 与 PrismarineJS/prismarine-auth 的 `live` flow 完全一致：
 *       deviceCodeRequest: https://login.live.com/oauth20_connect.srf
 *       tokenRequest:      https://login.live.com/oauth20_token.srf
 *   - 用户体验也不差：浏览器打开 microsoft.com/link，输入短码，点允许
 *
 * 代价：设备码有有效期（通常 15 分钟），过期需重新申请；轮询有最小间隔（通常 5 秒）。
 * 两者本文件都已正确处理。
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const { shell } = require('electron');
const { withFileLock } = require('./file_lock');

/* ------------------------------------------------------------------
 * 客户端 ID 说明
 * `00000000402b5328` 是公开的老式 Microsoft 账号应用 ID，注册在 login.live.com
 * 体系下（不是 microsoftonline.com 目录）。它**支持设备代码流**（本文件实测通过），
 * 但**不支持**自定义 redirect_uri 的授权码流。
 *
 * 想换成自己的：去 Azure 门户注册应用，勾选「个人 Microsoft 账户」，
 * 把下面的值替换掉即可 —— 注意换完之后要**重新实测**设备代码流是否可用，
 * 不是所有应用类型都开启了设备代码流（enabledForConsumers + mobile 标记）。
 * ------------------------------------------------------------------ */
const CLIENT_ID = '00000000402b5328';
const SCOPE = 'XboxLive.signin offline_access';

/* 设备代码流端点（login.live.com 体系，与 prismarine-auth 的 live flow 一致） */
const LIVE_DEVICE_CODE_URL = 'https://login.live.com/oauth20_connect.srf';
const LIVE_TOKEN_URL = 'https://login.live.com/oauth20_token.srf';

const TOKEN_CACHE = path.join(
  process.env.APPDATA || process.env.HOME || '.',
  '.mc-noclient',
  'accounts.json'
);

/* ---------------- 工具 ---------------- */

/** 带超时的 fetch —— 没有它，一次网络抖动就会让界面永久卡在"等待中" */
async function fetchWithTimeout(url, opts = {}, timeoutMs = 20000) {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } catch (e) {
    if (e && e.name === 'AbortError') {
      const err = new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒无响应）：${new URL(url).host}`, { cause: e });
      err.temporary = true;
      throw err;
    }
    const code = e && e.cause && e.cause.code;
    const err = new Error('网络请求失败：' + new URL(url).host + '：' + (code || (e && e.message)), { cause: e });
    err.temporary = true;
    throw err;
  } finally {
    clearTimeout(to);
  }
}

async function postJson(url, body, headers = {}) {
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
    err.status = res.status;
    err.body = data;
    err.temporary = res.status === 429 || res.status >= 500;
    throw err;
  }
  return data;
}

async function postForm(url, params) {
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
    err.status = res.status;
    err.body = data;
    err.temporary = res.status === 429 || res.status >= 500;
    throw err;
  }
  return data;
}

async function getJson(url, token) {
  const res = await fetchWithTimeout(url, {
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** 把 token 端点的错误体翻译成人话（设备代码流有固定几个错误码） */
function translateTokenError(body, fallbackMsg) {
  const code = body && body.error;
  const desc = (body && body.error_description) || '';
  const map = {
    authorization_pending: '用户还没有在浏览器里完成授权，继续等待…',
    authorization_declined: '你拒绝了本次授权。如果想重新登录，请再点一次登录。',
    bad_verification_code: '设备代码无效或已被使用，请重新发起登录。',
    expired_token: '设备代码已过期（超过 15 分钟未完成授权），请重新发起登录。',
    slow_down: '轮询过于频繁，正在自动放慢……',
  };
  if (map[code]) return map[code];
  // AADSTS700016 这类说明 client_id 用错了端点
  if (/AADSTS700016/.test(desc)) {
    return '这个应用 ID 在当前登录端点不存在（client_id 与端点不匹配），请联系开发者更换。';
  }
  return fallbackMsg + (code ? `（${code}）` : '');
}

/* ---------------- 1. 设备代码流 ---------------- */

/**
 * 走设备代码流拿到微软 token
 *
 * 流程：
 *   1) POST /oauth20_connect.srf 拿 { device_code, user_code, verification_uri, interval, expires_in }
 *   2) 打开浏览器让用户输入 user_code 并授权
 *   3) 按 interval 轮询 /oauth20_token.srf，直到拿到 token 或超时
 *
 * @param {function} log 进度回调
 * @returns {Promise<{access_token, refresh_token, expires_in}>}
 */
async function microsoftOAuthLogin(log = () => {}) {
  /* ---- 1) 申请设备代码 ---- */
  log('正在向微软申请登录代码…');
  const dc = await postForm(LIVE_DEVICE_CODE_URL, {
    client_id: CLIENT_ID,
    scope: SCOPE,
    response_type: 'device_code',
  });

  const deviceCode = dc.device_code;
  const userCode = dc.user_code;
  const verifyUri = dc.verification_uri || 'https://www.microsoft.com/link';
  const intervalSec = Number(dc.interval) || 5;
  const expiresInSec = Number(dc.expires_in) || 900;

  if (!deviceCode || !userCode) {
    throw new Error('微软没有返回设备代码，无法继续登录。请稍后重试。');
  }

  /* ---- 2) 引导用户去授权 ---- */
  log('');
  log('════════ 请在浏览器中完成授权 ════════');
  log(`  1. 打开网址：${verifyUri}`);
  log(`  2. 输入代码：${userCode}`);
  log(`  3. 用你的微软账号登录并点「允许」`);
  log(`  （代码 ${Math.round(expiresInSec / 60)} 分钟内有效）`);
  log('═════════════════════════════════════');
  log('');

  try {
    await shell.openExternal(verifyUri);
    log('已自动打开浏览器。若没弹出，请手动访问上面的网址。');
  } catch (e) {
    log(`无法自动打开浏览器（${e && e.message}），请手动访问：${verifyUri}`);
  }

  /* ---- 3) 轮询换 token ---- */
  const deadline = Date.now() + expiresInSec * 1000 - 3000; // 留 3 秒余量
  let waitSec = intervalSec;
  let pollCount = 0;

  for (;;) {
    if (Date.now() >= deadline) {
      throw new Error('设备代码已过期（授权超时）。请重新点击登录。');
    }
    await sleep(waitSec * 1000);
    pollCount++;

    let data;
    let res;
    try {
      res = await fetchWithTimeout(
        `${LIVE_TOKEN_URL}?client_id=${encodeURIComponent(CLIENT_ID)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: CLIENT_ID,
            device_code: deviceCode,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          }).toString(),
        },
        20000
      );
      const text = await res.text();
      try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
    } catch (e) {
      // 网络抖动不应打断整个流程，继续轮询
      log(`轮询失败（${e.message.slice(0, 60)}），${waitSec} 秒后重试…`);
      continue;
    }

    // 成功
    if (res.ok && data && data.access_token) {
      log('授权成功，已获取微软令牌。');
      return data;
    }

    const code = data && data.error;

    // 用户还没授权 —— 正常，继续等
    if (code === 'authorization_pending') {
      if (pollCount % 4 === 1) log(`仍在等待你完成授权…（已等待 ${Math.round(pollCount * waitSec)} 秒）`);
      continue;
    }

    // 要求放慢 —— 按微软要求加倍间隔
    if (code === 'slow_down') {
      waitSec = Math.min(waitSec + intervalSec, 30);
      log(`微软要求放慢轮询，间隔调整为 ${waitSec} 秒`);
      continue;
    }

    // 其他都是硬错误，直接抛出人话
    throw new Error(translateTokenError(data, `换取微软令牌失败：HTTP ${res.status}`));
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 用 refresh_token 静默刷新（免交互，这是"不输密码"的关键）
 *
 * ❗注意：refresh 走的是 login.live.com 的 token 端点，**不需要 redirect_uri**
 *   （这也是相比授权码流的又一好处）。
 */
async function refreshMicrosoftToken(refreshToken) {
  if (!refreshToken) throw new Error('没有可用的 refresh_token');
  return postForm(LIVE_TOKEN_URL, {
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
    scope: SCOPE,
  });
}

/** 微软 token → Xbox Live */
async function xboxLiveAuth(msAccessToken, log = () => {}) {
  log('正在通过 Xbox Live 认证…');
  const r = await postJson('https://user.auth.xboxlive.com/user/authenticate', {
    Properties: {
      AuthMethod: 'RPS',
      SiteName: 'user.auth.xboxlive.com',
      RpsTicket: `d=${msAccessToken}`,      // d= 前缀表示微软直接 token
    },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT',
  });
  return r.Token;
}

/** Xbox Live token → XSTS（relying party 必须是 rp://api.minecraftservices.com/） */
async function xstsAuth(xblToken, log = () => {}) {
  log('正在获取 XSTS 授权…');
  let r;
  try {
    r = await postJson('https://xsts.auth.xboxlive.com/xsts/authorize', {
      Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
      RelyingParty: 'rp://api.minecraftservices.com/',
      TokenType: 'JWT',
    });
  } catch (e) {
    // ❗XSTS 的 401 是最常见的"正版登录失败"来源，必须翻译成人话
    const xerr = e.body && e.body.XErr;
    if (xerr) {
      const map = {
        2148916227: '这个账号因违反 Xbox 社区准则被封禁，无法使用。',
        2148916229: '账号当前受限，且监护人未授予在线游戏权限。',
        2148916233: '这个微软账号还没有创建 Xbox 档案。请先到 xbox.com 登录一次完成初始化。',
        2148916234: '账号还没有接受 Xbox 服务条款，请先登录 xbox.com 接受。',
        2148916235: '该账号所在地区不允许使用 Xbox Live。',
        2148916236: '该账号需要先完成年龄验证（登录 login.live.com 提供证明）。',
        2148916237: '该账号的游戏时长已达上限，被限制登录。',
        2148916238: '这是未成年账号，必须由家长账号加入「Microsoft 家庭」后才能使用。',
      };
      const msg = map[xerr] || `Xbox 授权被拒绝（XErr=${xerr}）`;
      throw new Error(msg);
    }
    throw e;
  }
  const uhs = r && r.DisplayClaims && r.DisplayClaims.xui && r.DisplayClaims.xui[0]
    ? r.DisplayClaims.xui[0].uhs : null;
  if (!uhs) {
    throw new Error('XSTS 返回内容异常：缺少 DisplayClaims.xui[0].uhs');
  }
  return { token: r.Token, uhs };
}

/** XSTS → Minecraft access_token */
async function minecraftAuth(xstsToken, uhs, log = () => {}) {
  log('正在换取 Minecraft 令牌…');
  const r = await postJson(
    'https://api.minecraftservices.com/authentication/login_with_xbox',
    { identityToken: `XBL3.0 x=${uhs};${xstsToken}` }
  );
  return r.access_token;
}

/** 拿正版档案（UUID / 名字）。没有游戏所有权时这里会 404 */
async function fetchProfile(mcToken, log = () => {}) {
  log('正在读取正版档案…');
  try {
    const p = await getJson('https://api.minecraftservices.com/minecraft/profile', mcToken);
    return p;
  } catch (e) {
    if (e.status === 404) {
      throw new Error('这个微软账号没有 Minecraft: Java 版的所有权（档案不存在）');
    }
    if (e.status === 401) {
      throw new Error('Minecraft 令牌无效或已过期');
    }
    throw e;
  }
}

/* ---------------- 2. 缓存管理 ---------------- */

function loadCache() {
  try {
    if (!fs.existsSync(TOKEN_CACHE)) return null;
    const raw = JSON.parse(fs.readFileSync(TOKEN_CACHE, 'utf8'));
    return normalizeCache(raw);
  } catch (e) { return null; }
}

/*
 * v2 stores all locally authorized accounts in one file. Keep the selected
 * account mirrored at the top level for compatibility with older callers.
 */
function normalizeCache(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const source = Array.isArray(raw.accounts) ? raw.accounts : [raw];
  const accounts = [];
  const seen = new Set();
  for (const item of source) {
    if (!item || typeof item !== 'object' || !item.msRefreshToken || !item.uuid) continue;
    const uuid = String(item.uuid);
    if (seen.has(uuid)) continue;
    seen.add(uuid);
    accounts.push({
      msRefreshToken: String(item.msRefreshToken),
      name: String(item.name || uuid),
      uuid,
      savedAt: item.savedAt || null,
      lastUsedAt: item.lastUsedAt || null,
    });
  }
  if (!accounts.length) return null;
  const requested = raw.activeUuid && String(raw.activeUuid);
  const active = accounts.find((item) => item.uuid === requested) || accounts[0];
  return {
    version: 2,
    activeUuid: active.uuid,
    accounts,
    msRefreshToken: active.msRefreshToken,
    name: active.name,
    uuid: active.uuid,
    savedAt: active.savedAt,
  };
}

function publicAccount(item) {
  return item ? { name: item.name, uuid: item.uuid, savedAt: item.savedAt, lastUsedAt: item.lastUsedAt } : null;
}

function saveAccountsCache(accounts, activeUuid) {
  const normalized = normalizeCache({ accounts, activeUuid });
  if (!normalized) return false;
  return saveCache(normalized);
}

function markCachedAccountActive(uuid) {
  return withFileLock(TOKEN_CACHE, () => {
    const cache = loadCache();
    if (!cache || !cache.accounts.some((item) => item.uuid === String(uuid))) return false;
    return saveAccountsCache(cache.accounts, String(uuid));
  });
}

function saveCache(obj) {
  try {
    fs.mkdirSync(path.dirname(TOKEN_CACHE), { recursive: true });
    // ❗原子写：直接覆盖原文件时若中途崩溃/断电，会留下半个 JSON，
    //   下次启动 loadCache 解析失败 → 凭据凭空丢失，只能重新授权。
    const tmp = TOKEN_CACHE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, TOKEN_CACHE);
    // Windows 上 mode 未必生效，尽量再收一次权限（失败不影响功能）
    try { fs.chmodSync(TOKEN_CACHE, 0o600); } catch (e) {}
    return true;
  } catch (e) {
    try { fs.unlinkSync(TOKEN_CACHE + '.tmp'); } catch (e2) {}
    return false;
  }
}

function clearCache() {
  try { if (fs.existsSync(TOKEN_CACHE)) fs.unlinkSync(TOKEN_CACHE); return true; }
  catch (e) { return false; }
}

function peekCachedAccounts() {
  const cache = loadCache();
  if (!cache) return { activeUuid: null, active: null, accounts: [] };
  const active = cache.accounts.find((item) => item.uuid === cache.activeUuid) || cache.accounts[0];
  return { activeUuid: active ? active.uuid : null, active: publicAccount(active), accounts: cache.accounts.map(publicAccount) };
}

function removeCachedAccount(uuid) {
  return withFileLock(TOKEN_CACHE, () => {
    const cache = loadCache();
    if (!cache) return peekCachedAccounts();
    const target = String(uuid || cache.activeUuid);
    const accounts = cache.accounts.filter((item) => item.uuid !== target);
    if (accounts.length) {
      const activeUuid = cache.activeUuid === target ? accounts[0].uuid : cache.activeUuid;
      saveAccountsCache(accounts, activeUuid);
    } else {
      clearCache();
    }
    return peekCachedAccounts();
  });
}

/* ---------------- 3. 对外主入口 ---------------- */

/**
 * 登录微软账号，返回可用于进服的完整凭据
 * @param {object} opts
 * @param {boolean} [opts.forceInteractive] 忽略缓存，强制重新授权
 * @param {boolean} [opts.silentOnly] 只允许用缓存静默续期；缓存不可用则直接抛错，**不走设备代码流**
 *                                   （自动登录/后台续期必须用它，否则会静默卡在"等待用户授权"）
 * @param {function} [opts.log]
 * @returns {Promise<{accessToken, profile:{id,name,skins}, msRefreshToken}>}
 */
async function login(opts = {}) {
  const log = opts.log || (() => {});
  const account = {};

  let msToken;
  let refreshToken = null;
  let selectedUuid = opts.accountUuid ? String(opts.accountUuid) : null;

  // 先尝试用缓存的 refresh_token 静默续期
  if (!opts.forceInteractive) {
    const cache = loadCache();
    const cachedAccount = cache && cache.accounts.find((item) => item.uuid === (selectedUuid || cache.activeUuid));
    if (cachedAccount && cachedAccount.msRefreshToken) {
      selectedUuid = cachedAccount.uuid;
      log('发现已保存的账号，正在尝试免密登录…');
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            msToken = await refreshMicrosoftToken(cachedAccount.msRefreshToken);
            break;
          } catch (e) {
            if (!e.temporary || attempt === 1) throw e;
            log('免密续期遇到临时网络错误，1 秒后重试一次…');
            await sleep(1000);
          }
        }
        refreshToken = msToken.refresh_token || cachedAccount.msRefreshToken;
        log('免密登录成功（使用了本地保存的凭据）');
      } catch (e) {
        const code = e.body && e.body.error;
        if (!['invalid_grant', 'interaction_required', 'login_required'].includes(code)) {
          log('免密续期未完成，已保留本地凭据：' + e.message.slice(0, 160));
          throw e;
        }
        log('本地凭据已失效，需要重新授权：' + (e && e.message ? e.message.slice(0, 120) : e));
        msToken = null;
      }
    } else if (opts.silentOnly) {
      // 连缓存都没有 —— 静默模式下没有可用的起点
      throw new Error('本地没有保存的账号凭据，需要手动登录一次');
    }
  }

  // 静默失败或强制交互 → 走设备代码流
  if (!msToken) {
    if (opts.silentOnly) {
      // ❗关键分支：静默模式下**绝不能**进入设备代码流 ——
      //   那会让调用方（启动自动登录 / 连接前续期）挂起 15 分钟等用户去浏览器操作，
      //   而用户根本不知道自己在等什么。直接抛错让上层降级到"提示手动登录"。
      throw new Error('本地凭据已失效，需要重新授权（自动登录已跳过）');
    }
    msToken = await microsoftOAuthLogin(log);
    if (!msToken.refresh_token) {
      // 理论上 offline_access 一定回 refresh_token；没有的话缓存就等于失效，
      // 别把 undefined 存进去覆盖掉原来还能用的凭据。
      log('警告：本次授权没有返回 refresh_token，无法保存免密凭据');
    } else {
      refreshToken = msToken.refresh_token;
    }
  }

  const xbl = await xboxLiveAuth(msToken.access_token, log);
  const xsts = await xstsAuth(xbl, log);
  const mcToken = await minecraftAuth(xsts.token, xsts.uhs, log);
  const profile = await fetchProfile(mcToken, log);
  if (!opts.forceInteractive && selectedUuid && profile.id !== selectedUuid) {
    throw new Error('账号身份不一致，需要重新授权原账号；不会切换到其他账号');
  }

  account.accessToken = mcToken;
  account.profile = { id: profile.id, name: profile.name, skins: profile.skins || [] };
  account.msRefreshToken = refreshToken || null;

  if (refreshToken) {
    const ok = withFileLock(TOKEN_CACHE, () => {
      const cache = loadCache();
      const previous = cache ? cache.accounts : [];
      // Removal in another window must not be undone by an in-flight renewal.
      if (!opts.forceInteractive && selectedUuid && !previous.some((item) => item.uuid === selectedUuid))
        throw new Error('原账号凭据已移除，需要手动登录原账号');
      const next = previous.filter((item) => item.uuid !== account.profile.id);
      next.unshift({
        msRefreshToken: refreshToken,
        name: account.profile.name,
        uuid: account.profile.id,
        savedAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
      });
      return saveAccountsCache(next, opts.updateActive === false && cache ? cache.activeUuid : account.profile.id);
    });
    if (!ok) log('警告：凭据写入本地失败，下次启动需要重新授权');
  } else if (selectedUuid && opts.updateActive !== false) {
    if (!markCachedAccountActive(selectedUuid)) log('警告：当前账号选择未能写入本地');
  }

  log(`正版档案已加载：${account.profile.name} (${account.profile.id})`);
  return account;
}

/** 只读缓存里的账号信息（不联网） */
function peekCachedAccount() {
  return peekCachedAccounts().active;
}

module.exports = {
  login,
  peekCachedAccount,
  peekCachedAccounts,
  removeCachedAccount,
  clearCache,
  loadCache,
  CLIENT_ID,
  TOKEN_CACHE,
  // 导出内部函数便于测试
  _internal: { translateTokenError, refreshMicrosoftToken, LIVE_TOKEN_URL, LIVE_DEVICE_CODE_URL },
};
