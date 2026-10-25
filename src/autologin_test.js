'use strict';
/*
 * autologin_test.js —— 「启动自动登录」的静默模式自检
 *
 * 背景：用户要求「每次打开软件直接默认执行一次登录即可」。
 *       实现方式是在启动时调 auth.login({ silentOnly: true })。
 *
 * ❗这个 silentOnly 开关必须严格测试，因为它的失败模式非常隐蔽：
 *
 *   不加这个开关时，一旦本地凭据失效，login() 会掉进**设备代码流** ——
 *   而那意味着：申请一个 8 位短码、自动打开浏览器、然后循环轮询最多 15 分钟。
 *   用户看到的现象是「软件卡住了」，而他根本不知道自己在等什么。
 *
 *   所以本测试的核心断言是两条**否定式**检查：
 *     ① 静默模式下，设备代码端点**一次都不能被调用**
 *     ② 静默模式下，**绝不能**自动打开浏览器
 *
 * 全部离线：用本地 HTTP 服务器冒充微软 / Xbox / Minecraft 的全部端点。
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

let pass = 0, fail = 0;
const failed = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  \x1b[32m[PASS]\x1b[0m ' + name); }
  else { fail++; failed.push(name); console.log('  \x1b[31m[FAIL]\x1b[0m ' + name + (extra ? '\n         ' + extra : '')); }
}

/* ---------- 隔离：把凭据缓存指到临时目录，别碰用户真实凭据 ---------- */
const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'autologin-'));
process.env.APPDATA = tmpAppData;          // TOKEN_CACHE = %APPDATA%\.mc-noclient\accounts.json
const CACHE_DIR = path.join(tmpAppData, '.mc-noclient');
const CACHE_FILE = path.join(CACHE_DIR, 'accounts.json');
function clearCache() { try { fs.rmSync(CACHE_DIR, { recursive: true, force: true }); } catch (e) {} }
function writeCache(obj) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(obj), 'utf8');
}

/* ---------- stub 掉 electron（auth.js 依赖 shell.openExternal） ---------- */
let openExternalCalls = [];
const origLoad = Module._load;
Module._load = function (req) {
  if (req === 'electron') {
    return { shell: { openExternal: async (u) => { openExternalCalls.push(u); } } };
  }
  return origLoad.apply(this, arguments);
};

/* ---------- 本地假服务器：记录每个端点被调用了几次 ---------- */
let server = null;
let baseUrl = '';
const hits = {};                 // path → 次数
let routes = {};                 // path → (req, res, body) => void

function startServer() {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const u = new URL(req.url, baseUrl);
      const p = u.pathname;
      hits[p] = (hits[p] || 0) + 1;
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const h = routes[p];
        if (h) h(req, res, body);
        else { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{}'); }
      });
    });
    let attempts = 0;
    server.once('error', reject);
    // Windows can allocate a port forbidden by fetch; rebind before auth testing.
    const listen = () => server.listen(0, '127.0.0.1', async () => {
      baseUrl = 'http://127.0.0.1:' + server.address().port;
      try {
        const response = await fetch(baseUrl + '/_probe', { signal: AbortSignal.timeout(2000) });
        await response.arrayBuffer();
        resolve();
      } catch (e) {
        if (e.cause && e.cause.message === 'bad port' && ++attempts < 20) server.close(listen);
        else { server.close(); reject(e); }
      }
    });
    listen();
  });
}
function stopServer() { return new Promise((r) => server ? server.close(r) : r()); }

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

/**
 * 改写 auth.js 源码里的全部端点为本地地址后重新加载。
 * （端点是 const，没法从外部改；这样加载出来的模块行为与线上完全一致，
 *   只是把域名换成了 127.0.0.1，可以精确观察"哪个端点被调用了"。）
 */
function loadAuthLocal() {
  let src = fs.readFileSync(path.join(__dirname, 'auth.js'), 'utf8');
  const rep = [
    [/https:\/\/login\.live\.com\/oauth20_connect\.srf/g, baseUrl + '/devicecode'],
    [/https:\/\/login\.live\.com\/oauth20_token\.srf/g, baseUrl + '/token'],
    [/https:\/\/user\.auth\.xboxlive\.com\/user\/authenticate/g, baseUrl + '/xbl'],
    [/https:\/\/xsts\.auth\.xboxlive\.com\/xsts\/authorize/g, baseUrl + '/xsts'],
    [/https:\/\/api\.minecraftservices\.com\/authentication\/login_with_xbox/g, baseUrl + '/mcauth'],
    [/https:\/\/api\.minecraftservices\.com\/minecraft\/profile/g, baseUrl + '/profile'],
  ];
  for (const [re, to] of rep) src = src.replace(re, to);
  const tmp = path.join(__dirname, '_autologin_tmp_' + Date.now() + '.js');
  fs.writeFileSync(tmp, src, 'utf8');
  delete require.cache[require.resolve(tmp)];
  const mod = require(tmp);
  return { mod, tmp };
}

function resetHits() { for (const k of Object.keys(hits)) delete hits[k]; }
function hit(p) { return hits[p] || 0; }

/* ---------- 各端点的标准成功响应 ---------- */
function setupHappyRoutes() {
  routes = {
    // 设备代码端点：**在静默模式下它一次都不该被调用**
    '/devicecode': (req, res) => json(res, 200, {
      device_code: 'DC_SHOULD_NOT_BE_USED',
      user_code: 'AAAA-BBBB',
      verification_uri: 'https://www.microsoft.com/link',
      interval: 1,
      expires_in: 900,
    }),
    '/token': (req, res, body) => {
      const params = new URLSearchParams(body);
      if (params.get('grant_type') === 'refresh_token') {
        json(res, 200, { access_token: 'MS_AT', refresh_token: 'MS_RT_NEW', expires_in: 3600 });
      } else {
        json(res, 200, { access_token: 'MS_AT_FROM_DEVICECODE', refresh_token: 'MS_RT', expires_in: 3600 });
      }
    },
    '/xbl': (req, res) => json(res, 200, { Token: 'XBL_TOKEN', DisplayClaims: { xui: [{ uhs: 'UHS' }] } }),
    '/xsts': (req, res) => json(res, 200, { Token: 'XSTS_TOKEN', DisplayClaims: { xui: [{ uhs: 'UHS' }] } }),
    '/mcauth': (req, res) => json(res, 200, { access_token: 'MC_AT' }),
    '/profile': (req, res) => json(res, 200, { id: 'uuid-1234', name: 'Nan_Koi', skins: [] }),
  };
}

(async () => {
  await startServer();
  const { mod: auth, tmp: tmpAuth } = loadAuthLocal();
  setupHappyRoutes();

  console.log('\n=== 启动自动登录 · 静默模式自检 ===\n');

  /* ================= A. 没有缓存 ================= */
  console.log('[A] 静默模式 + 本地无凭据');
  {
    clearCache();
    resetHits();
    openExternalCalls = [];

    let err = null;
    try {
      await auth.login({ silentOnly: true, log: () => {} });
    } catch (e) { err = e; }

    check('应当抛错（而不是去申请设备代码）', !!err, err ? '' : '居然成功了？');
    check('错误信息说明需要手动登录', !!err && /手动|重新授权/.test(err.message),
      err && err.message);
    check('❗设备代码端点一次都没被调用', hit('/devicecode') === 0,
      '被调用了 ' + hit('/devicecode') + ' 次 —— 这会让用户干等 15 分钟');
    check('❗没有自动打开浏览器', openExternalCalls.length === 0,
      '打开了 ' + JSON.stringify(openExternalCalls));
    check('没有触及 XBL 阶段（说明确实在入口就停下了）', hit('/xbl') === 0);
  }

  /* ================= B. 缓存存在但已失效 ================= */
  console.log('\n[B] 静默模式 + 凭据已失效（refresh_token 被拒）');
  {
    clearCache();
    writeCache({ msRefreshToken: 'EXPIRED_RT', name: 'Nan_Koi', uuid: 'uuid-1234' });
    resetHits();
    openExternalCalls = [];

    // 让 refresh 返回 invalid_grant
    routes['/token'] = (req, res) => json(res, 400, {
      error: 'invalid_grant',
      error_description: 'The user could not be authenticated or the grant is expired.',
    });

    let err = null;
    try {
      await auth.login({ silentOnly: true, log: () => {} });
    } catch (e) { err = e; }

    check('应当抛错', !!err);
    check('❗设备代码端点一次都没被调用', hit('/devicecode') === 0,
      '被调用了 ' + hit('/devicecode') + ' 次');
    check('❗没有自动打开浏览器', openExternalCalls.length === 0);
    check('尝试过 refresh_token 端点（说明确实走了续期路径）', hit('/token') >= 1);
    check('没有进入 XBL 阶段', hit('/xbl') === 0);
  }

  /* ================= C. 缓存有效：静默登录应当成功 ================= */
  console.log('\n[C] 静默模式 + 凭据有效（应当免密登录成功）');
  {
    clearCache();
    writeCache({ msRefreshToken: 'GOOD_RT', name: 'Nan_Koi', uuid: 'uuid-1234' });
    resetHits();
    openExternalCalls = [];
    setupHappyRoutes();

    let account = null, err = null;
    try {
      account = await auth.login({ silentOnly: true, log: () => {} });
    } catch (e) { err = e; }

    check('登录成功且无异常', !err && !!account, err ? err.message : '');
    check('拿到了 accessToken', !!(account && account.accessToken));
    check('拿到了正版档案名字', !!(account && account.profile && account.profile.name === 'Nan_Koi'),
      account && account.profile && account.profile.name);
    check('❗设备代码端点一次都没被调用', hit('/devicecode') === 0);
    check('❗没有自动打开浏览器', openExternalCalls.length === 0);
    check('走了 refresh 而不是全新授权', hit('/token') >= 1 && hit('/devicecode') === 0);
    check('XBL / XSTS / MC 链路都被走到', hit('/xbl') >= 1 && hit('/xsts') >= 1 && hit('/mcauth') >= 1);
    check('新 refresh_token 被写回缓存', (() => {
      const c = auth.loadCache();
      return c && c.msRefreshToken === 'MS_RT_NEW';
    })(), JSON.stringify(auth.loadCache()));
    check('档案名字被写回缓存', (auth.loadCache() || {}).name === 'Nan_Koi');
  }

  /* ================= D. 对照组：非静默模式确实会走设备代码流 ================= */
  console.log('\n[D] 对照组：非静默模式（silentOnly 未开启）应当走设备代码流');
  {
    clearCache();
    resetHits();
    openExternalCalls = [];
    setupHappyRoutes();

    let account = null, err = null;
    try {
      account = await auth.login({ log: () => {} });      // 不加 silentOnly
    } catch (e) { err = e; }

    check('设备代码端点**被**调用了（证明对照组有效）', hit('/devicecode') >= 1,
      '调用次数=' + hit('/devicecode'));
    check('自动打开了浏览器（非静默模式的预期行为）', openExternalCalls.length >= 1,
      JSON.stringify(openExternalCalls));
    check('最终登录成功', !err && !!account, err ? err.message : '');
    check('用的是设备代码流拿到的 token', !!(account && account.accessToken === 'MC_AT'));
  }

  /* ================= E. 边界：缓存文件损坏 ================= */
  console.log('\n[E] 静默模式 + 缓存文件损坏（非法 JSON）');
  {
    clearCache();
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, '{ 这不是 JSON ][', 'utf8');
    resetHits();
    openExternalCalls = [];

    let err = null;
    try {
      await auth.login({ silentOnly: true, log: () => {} });
    } catch (e) { err = e; }

    check('抛错而不是崩掉', !!err);
    check('❗设备代码端点一次都没被调用', hit('/devicecode') === 0);
    check('❗没有自动打开浏览器', openExternalCalls.length === 0);
  }

  /* ================= F. 边界：缓存里没有 refresh_token ================= */
  console.log('\n[F] 静默模式 + 缓存缺 refresh_token');
  {
    clearCache();
    writeCache({ name: 'Nan_Koi', uuid: 'uuid-1234' });     // 没有 msRefreshToken
    resetHits();
    openExternalCalls = [];

    let err = null;
    try {
      await auth.login({ silentOnly: true, log: () => {} });
    } catch (e) { err = e; }

    check('抛错', !!err);
    check('❗设备代码端点一次都没被调用', hit('/devicecode') === 0);
    check('❗没有自动打开浏览器', openExternalCalls.length === 0);
  }

  /* ================= G. 自动登录**不得**顺带自动连接服务器 ================= */
  console.log('\n[G] 自动登录只登录账号，不自动连接服务器');
  {
    // 用户明确要求：「不用自动连上次的那台服务器，只需要自动免密登录账号即可」。
    // 用一个源码级断言守住这条边界 —— 以后谁把自动连接加回来，这里会立刻报警。
    //
    // 只看 runAutoLogin 函数体：主进程里 doConnect 当然还存在（手动点「连接」要用），
    // 关键是**自动登录流程不能调它**。
    const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'main.js'), 'utf8');
    const m = mainSrc.match(/async function runAutoLogin\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
    check('能定位到 runAutoLogin 函数体', !!m,
      '没找到 —— 函数被改名或删掉了吗？请同步更新本测试');

    if (m) {
      const body = m[1];
      check('❗自动登录流程里没有调用 doConnect（不自动连接）',
        !/\bdoConnect\s*\(/.test(body),
        'runAutoLogin 里出现了 doConnect 调用');
      check('❗自动登录流程里没有引用 lastServer',
        !/lastServer/.test(body),
        'runAutoLogin 里引用了 lastServer');
      check('确实读取了 autoLogin 开关（功能本身还在）',
        /cfg\.autoLogin/.test(body));
      check('确实走 ensureAccount 登录（核心能力还在，v2.4.1 起收敛并发）',
        /ensureAccount\s*\(/.test(body));
    }

    // ❗关键：silentOnly 现在收敛进了 ensureAccount()，而不是散落在各调用点。
    //   保证"自动登录 / 连接前续期"永远走静默模式、且全进程同一时刻只有一条授权链。
    const ensureSrc = mainSrc.match(/function ensureAccount\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
    check('能找到 ensureAccount 函数', !!ensureSrc,
      '没找到 —— 并发登录收敛函数被改名或删掉了吗？');
    if (ensureSrc) {
      const b = ensureSrc[1];
      check('ensureAccount 内部用 silentOnly 登录（绝不弹设备码）',
        /silentOnly\s*:\s*true/.test(b),
        'ensureAccount 里没有 silentOnly: true');
      check('ensureAccount 用共享 Promise 收敛并发（loginPromise）',
        /loginPromise/.test(b),
        'ensureAccount 里没有共享 Promise 收敛');
    }

    // 顺带确认配置层不再保留 lastServer 字段
    const storeSrc = fs.readFileSync(path.join(__dirname, 'configstore.js'), 'utf8');
    check('配置默认值里不再有 lastServer',
      !/lastServer\s*:\s*null/.test(storeSrc));
    check('配置层会清理历史遗留的 lastServer',
      /delete\s+out\.lastServer/.test(storeSrc));
  }

  console.log('\n[H] 临时网络错误不能误报凭据失效');
  for (const silentOnly of [true, false]) {
    clearCache();
    writeCache({ msRefreshToken: 'KEEP_RT', name: 'Nan_Koi', uuid: 'uuid-1234' });
    resetHits();
    openExternalCalls = [];
    setupHappyRoutes();
    routes['/token'] = (req, res) => json(res, 503, { error: 'temporarily_unavailable' });
    const logs = [];
    let err = null;
    try { await auth.login({ silentOnly, log: (m) => logs.push(m) }); }
    catch (e) { err = e; }
    check('网络错误只重试一次 (' + silentOnly + ')', !!err && hit('/token') === 2);
    check('不误报凭据失效 (' + silentOnly + ')',
      !!err && !/凭据已失效|需要重新授权/.test(err.message + logs.join('')));
    check('网络错误不打开授权浏览器 (' + silentOnly + ')',
      hit('/devicecode') === 0 && openExternalCalls.length === 0);
    check('网络错误保留原 refresh_token (' + silentOnly + ')',
      auth.loadCache().msRefreshToken === 'KEEP_RT');
  }

  console.log('\n[I] 一次临时失败后恢复，继续免密登录');
  {
    resetHits();
    openExternalCalls = [];
    setupHappyRoutes();
    const happyToken = routes['/token'];
    routes['/token'] = (req, res, body) => {
      if (hit('/token') === 1) json(res, 503, { error: 'temporarily_unavailable' });
      else happyToken(req, res, body);
    };
    const account = await auth.login({ silentOnly: true });
    check('网络恢复后自动完成正版档案读取', account.profile.name === 'Nan_Koi');
    check('恢复过程只有两次 refresh 请求', hit('/token') === 2);
    check('恢复过程没有设备代码授权', hit('/devicecode') === 0 && openExternalCalls.length === 0);
  }

  /* ================= 清理 ================= */
  clearCache();
  try { fs.unlinkSync(tmpAuth); } catch (e) {}
  try { fs.rmSync(tmpAppData, { recursive: true, force: true }); } catch (e) {}
  await stopServer();

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
  if (failed.length) { console.log('未通过：'); failed.forEach((f) => console.log('  - ' + f)); console.log(''); }
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试自身异常：', e);
  process.exit(1);
});
