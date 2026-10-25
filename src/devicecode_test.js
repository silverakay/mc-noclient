'use strict';
/*
 * devicecode_test.js —— 设备代码流（device code flow）逻辑测试
 *
 * 背景：授权码流（redirect_uri 回调）对公开 client_id 已经彻底不可用 ——
 *       微软的 login.live.com 端点拒绝一切 localhost 回调，只认它自己注册的
 *       https://login.live.com/oauth20_desktop.srf，而那个地址收不到本机回调。
 *
 *       改用设备代码流：不需要 redirect_uri，用户到 microsoft.com/link 输短码。
 *       端点与 PrismarineJS/prismarine-auth 的 live flow 一致：
 *         device code → https://login.live.com/oauth20_connect.srf
 *         token       → https://login.live.com/oauth20_token.srf
 *
 * 本测试验证（全部离线，用本地 HTTP 服务器模拟微软）：
 *   1. 申请设备代码：请求体字段正确、正确解析 user_code/verification_uri
 *   2. 缺少 device_code 时报可读错误
 *   3. 轮询逻辑：authorization_pending 时继续等，直到拿到 token
 *   4. slow_down 时自动放慢间隔
 *   5. expired_token → 报"设备代码已过期"
 *   6. authorization_declined → 报"你拒绝了授权"
 *   7. 错误文案翻译：AADSTS700016 有专门提示
 *   8. 超时保护：设备码过期前会主动结束而不是死循环
 *
 * 注意：这些测试**不依赖外网**，用本地服务器覆盖端点常量。
 *       真实连通性由单独的在线冒烟脚本负责（不放进常规自检，避免网络抖动误报）。
 */

const http = require('http');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

/* ❗凭据隔离（必须放在 require('./auth') **之前**）：
 *   auth.js 在模块加载时就用 %APPDATA%\.mc-noclient\accounts.json 算好了 TOKEN_CACHE。
 *   不隔离的话，只要本测试走到"登录成功"分支，就会把**用户真实的 refresh_token
 *   覆盖成测试用的假 token** —— 用户下次打开软件就得重新走一遍设备代码授权。
 *   （当前用例在 Xbox 阶段就抛错、还没到写缓存，所以暂时没出事；
 *     但这是颗地雷：以后补一个"全链路成功"的用例就会踩爆。）
 */
const REAL_APPDATA = process.env.APPDATA;
process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'devicecode-'));

// auth.js 依赖 electron，这里 stub 掉
const origLoad = Module._load;
Module._load = function (req) {
  if (req === 'electron') return { shell: { openExternal: async () => {} } };
  return origLoad.apply(this, arguments);
};

const auth = require('./auth');

/** 测试结束时清理临时凭据目录，恢复 APPDATA */
function cleanupAuthIsolation() {
  try { fs.rmSync(process.env.APPDATA, { recursive: true, force: true }); } catch (e) {}
  if (REAL_APPDATA !== undefined) process.env.APPDATA = REAL_APPDATA;
}

let pass = 0, fail = 0;
const failed = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  [PASS] ' + name); }
  else { fail++; failed.push(name); console.log('  [FAIL] ' + name + (extra ? '  → ' + extra : '')); }
}

/* ---------- 用本地服务器冒充微软 token / devicecode 端点 ---------- */

let server = null;
let baseUrl = '';
let handler = null;

function startServer() {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        if (handler) handler(req, res, body);
        else { res.writeHead(404); res.end(); }
      });
    });
    let attempts = 0;
    server.once('error', reject);
    // Windows can allocate a port forbidden by fetch; rebind before auth testing.
    const listen = () => server.listen(0, '127.0.0.1', async () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
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

/* 覆盖端点常量为本地地址 —— 通过改写模块内部变量实现
 * （常量为 const，直接改不动；因此用「重写 source 后重新 require」的方式） */

/** ❗记录所有生成过的临时文件：成功/失败路径都要能清干净，
 *  否则会在 src/ 里留下 _auth_tmp_*.js 残渣（曾经真的漏过）。 */
const TMP_FILES = [];
function cleanupTmpFiles() {
  for (const f of TMP_FILES) {
    try { fs.unlinkSync(f); } catch (e) {}
  }
  TMP_FILES.length = 0;
}

function loadAuthWithEndpoints(deviceUrl, tokenUrl) {
  const src = fs.readFileSync(path.join(__dirname, 'auth.js'), 'utf8')
    .replace(/const LIVE_DEVICE_CODE_URL = '.*?';/, `const LIVE_DEVICE_CODE_URL = ${JSON.stringify(deviceUrl)};`)
    .replace(/const LIVE_TOKEN_URL = '.*?';/, `const LIVE_TOKEN_URL = ${JSON.stringify(tokenUrl)};`);
  const tmp = path.join(__dirname, '_auth_tmp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.js');
  fs.writeFileSync(tmp, src, 'utf8');
  TMP_FILES.push(tmp);
  delete require.cache[require.resolve(tmp)];
  const mod = require(tmp);
  return { mod, tmp };
}

(async () => {
  await startServer();
  const deviceUrl = baseUrl + '/connect';
  const tokenUrl = baseUrl + '/token';

  const { mod, tmp } = loadAuthWithEndpoints(deviceUrl, tokenUrl);
  const internal = mod._internal;

  /* ---------- A. 错误文案翻译（纯函数，先测） ---------- */
  console.log('\n[A] 设备代码流错误文案翻译');
  {
    check('authorization_pending → 提示继续等待',
      /继续等待|还没有/.test(internal.translateTokenError({ error: 'authorization_pending' }, '')));
    check('authorization_declined → 提示用户拒绝',
      /拒绝/.test(internal.translateTokenError({ error: 'authorization_declined' }, '')));
    check('expired_token → 提示已过期',
      /过期/.test(internal.translateTokenError({ error: 'expired_token' }, '')));
    check('bad_verification_code → 提示无效',
      /无效/.test(internal.translateTokenError({ error: 'bad_verification_code' }, '')));
    check('slow_down → 提示放慢',
      /放慢/.test(internal.translateTokenError({ error: 'slow_down' }, '')));
    check('AADSTS700016 → 提示 client_id 与端点不匹配',
      /client_id|应用 ID/.test(internal.translateTokenError(
        { error: 'unauthorized_client', error_description: 'AADSTS700016: Application with identifier ...' }, '')));
    check('未知错误 → 保留原始错误码',
      /（weird_error）/.test(internal.translateTokenError({ error: 'weird_error' }, '失败')));
  }

  /* ---------- B. 申请设备代码 ---------- */
  console.log('\n[B] 申请设备代码');
  {
    let sawBody = null;
    handler = (req, res, body) => {
      sawBody = new URLSearchParams(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        device_code: 'DC_ABC',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://www.microsoft.com/link',
        interval: 0,          // 测试里设 0，避免真等
        expires_in: 900,
      }));
    };

    // 直接调用内部的 login 太重（会走完 XBL/XSTS），改为验证 login 的第一步行为：
    // 用一个能观测请求体的最小驱动 —— 调用 mod.login 会继续往下走，
    // 所以这里只验证「设备码请求的字段」和「解析结果」，用 handler 记录。
    const logs = [];
    let got = null;
    const realHandler = handler;
    handler = (req, res, body) => {
      const p = new URLSearchParams(body);
      if (req.url === '/connect') { got = p; realHandler(req, res, body); return; }
      // token 端点：直接报 declined，结束流程
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'authorization_declined', error_description: 'x' }));
    };

    let err = null;
    try {
      await mod.login({ forceInteractive: true, log: (m) => logs.push(m) });
    } catch (e) { err = e; }

    check('向 /connect 发的是 client_id + scope + response_type=device_code',
      got && got.get('client_id') === '00000000402b5328'
      && got.get('scope') === 'XboxLive.signin offline_access'
      && got.get('response_type') === 'device_code',
      got ? got.toString() : '(没收到请求)');

    check('日志里向用户展示了 user_code',
      logs.some((l) => l.includes('ABCD-EFGH')), JSON.stringify(logs.slice(0, 12)));
    check('日志里向用户展示了验证网址',
      logs.some((l) => l.includes('microsoft.com/link')));
    check('用户拒绝时抛出可读错误',
      err && /拒绝/.test(err.message), err && err.message);
  }

  /* ---------- C. 轮询：pending → 成功 ---------- */
  console.log('\n[C] 轮询逻辑：先 pending 再成功');
  {
    let tokenCalls = 0;
    const logs = [];
    handler = (req, res, body) => {
      if (req.url.startsWith('/connect')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          device_code: 'DC_1', user_code: 'CODE-1111',
          verification_uri: 'https://www.microsoft.com/link',
          interval: 0, expires_in: 900,
        }));
        return;
      }
      tokenCalls++;
      if (tokenCalls < 3) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'authorization_pending' }));
      } else {
        // 后续会走 XBL/XSTS，那些域名我们不覆盖 → 会失败。
        // 所以到这一步就说明「轮询确实取到了 token」，记下来即可。
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'MS_TOKEN', refresh_token: 'RT', expires_in: 3600 }));
      }
    };

    let err = null;
    try { await mod.login({ forceInteractive: true, log: (m) => logs.push(m) }); }
    catch (e) { err = e; }

    check('pending 时持续轮询（调用了 ≥3 次 token 端点）', tokenCalls >= 3, 'calls=' + tokenCalls);
    check('拿到 token 后继续走到 Xbox Live 阶段（说明 token 被正确接收）',
      logs.some((l) => /Xbox Live/.test(l)) || (err && !/拒绝|过期|无效/.test(err.message)),
      'logs=' + JSON.stringify(logs.slice(0, 14)));
  }

  /* ---------- D. slow_down 自动放慢 ---------- */
  console.log('\n[D] slow_down 时自动放慢间隔');
  {
    let tokenCalls = 0;
    const logs = [];
    handler = (req, res, body) => {
      if (req.url.startsWith('/connect')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // interval 设 0 让测试快跑
        res.end(JSON.stringify({
          device_code: 'DC_2', user_code: 'CODE-2222',
          verification_uri: 'https://www.microsoft.com/link',
          interval: 0, expires_in: 900,
        }));
        return;
      }
      tokenCalls++;
      if (tokenCalls === 1) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'slow_down' }));
        return;
      }
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'authorization_declined' }));
    };

    try { await mod.login({ forceInteractive: true, log: (m) => logs.push(m) }); } catch (e) {}
    check('收到 slow_down 后打日志说明放慢', logs.some((l) => /放慢/.test(l)),
      JSON.stringify(logs));
  }

  /* ---------- E. 超时保护：设备码过期即结束 ---------- */
  console.log('\n[E] 设备代码过期时的超时保护');
  {
    const logs = [];
    handler = (req, res, body) => {
      if (req.url.startsWith('/connect')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // expires_in 设 1 秒，interval 0 → 应很快判定过期
        res.end(JSON.stringify({
          device_code: 'DC_3', user_code: 'CODE-3333',
          verification_uri: 'https://www.microsoft.com/link',
          interval: 0, expires_in: 1,
        }));
        return;
      }
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'authorization_pending' }));
    };

    const t0 = Date.now();
    let err = null;
    try { await mod.login({ forceInteractive: true, log: (m) => logs.push(m) }); }
    catch (e) { err = e; }
    const elapsed = Date.now() - t0;

    check('设备码过期后主动结束（不无限轮询）', err && /过期|超时/.test(err.message),
      err && err.message);
    check('结束得足够快（< 15 秒，不会卡住界面）', elapsed < 15000, elapsed + 'ms');
  }

  /* ---------- F. 设备码申请失败的处理 ---------- */
  console.log('\n[F] 设备码申请异常处理');
  {
    handler = (req, res, body) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({})); // 没有 device_code
    };
    let err = null;
    try { await mod.login({ forceInteractive: true, log: () => {} }); } catch (e) { err = e; }
    check('返回体缺 device_code 时抛可读错误', err && /设备代码/.test(err.message),
      err && err.message);

    handler = (req, res, body) => {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('boom');
    };
    err = null;
    try { await mod.login({ forceInteractive: true, log: () => {} }); } catch (e) { err = e; }
    check('端点 500 时抛出带状态码的错误', err && /500/.test(err.message), err && err.message);
  }

  /* ---------- G. 免密刷新走 token 端点且不需要 redirect_uri ---------- */
  console.log('\n[G] refresh_token 静默刷新');
  {
    let sawBody = null;
    handler = (req, res, body) => {
      sawBody = new URLSearchParams(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'NEW', refresh_token: 'RT2', expires_in: 3600 }));
    };
    const r = await internal.refreshMicrosoftToken('OLD_RT');
    check('refresh 请求带 grant_type=refresh_token',
      sawBody && sawBody.get('grant_type') === 'refresh_token', sawBody && sawBody.toString());
    check('refresh 请求带原 refresh_token',
      sawBody && sawBody.get('refresh_token') === 'OLD_RT');
    check('refresh 请求**不含** redirect_uri（设备代码流不需要）',
      sawBody && !sawBody.has('redirect_uri'));
    check('能正确拿到新 token', r && r.access_token === 'NEW');

    let threw = false;
    try { await internal.refreshMicrosoftToken(null); } catch (e) { threw = true; }
    check('没有 refresh_token 时抛错', threw);
  }

  await stopServer();
  cleanupTmpFiles();               // 清掉所有临时模块
  cleanupAuthIsolation();          // 删掉临时凭据目录并恢复 APPDATA

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
  if (failed.length) { console.log('失败项:'); for (const f of failed) console.log('  - ' + f); console.log(''); }
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('[致命] ' + e.stack);
  try { cleanupTmpFiles(); } catch (e3) {}     // ❗失败路径同样要清理
  try { cleanupAuthIsolation(); } catch (e2) {}
  process.exit(2);
});
