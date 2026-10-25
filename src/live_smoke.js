'use strict';
/*
 * live_smoke.js —— 真实微软端点的在线冒烟测试（**可选**）
 *
 * 为什么单独拆出来、且默认不跑：
 *   它依赖外网。网络抖动 / 微软限流 / 公司网络策略都会造成假失败，
 *   把它塞进常规自检会污染"代码是否正确"这个信号。
 *
 * 用法：
 *   node src/live_smoke.js
 *   或  MC_LIVE_SMOKE=1 node src/run_all_tests.js
 *
 * 它验证的是「当前 client_id 在真实端点上确实能用设备代码流」——
 * 这正是当初授权码流栽跟头的地方，值得单独盯住。
 *
 * 绝不做的事：不会真的完成授权（需要用户交互），只验证到
 * 「拿到 device_code + 轮询返回 authorization_pending」为止。
 */

const Module = require('module');
const origLoad = Module._load;
Module._load = function (req) {
  if (req === 'electron') return { shell: { openExternal: async () => {} } };
  return origLoad.apply(this, arguments);
};

const { CLIENT_ID } = require('./auth');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  [PASS] ' + name); }
  else { fail++; console.log('  [FAIL] ' + name + (extra ? '  → ' + extra : '')); }
}

const DEVICE_URL = 'https://login.live.com/oauth20_connect.srf';
const TOKEN_URL = 'https://login.live.com/oauth20_token.srf';
const SCOPE = 'XboxLive.signin offline_access';

(async () => {
  console.log('\n[在线] 真实微软端点冒烟测试');
  console.log(`  client_id = ${CLIENT_ID}`);

  // ---- 1. 申请设备代码 ----
  let dc = null;
  try {
    const res = await fetch(DEVICE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID, scope: SCOPE, response_type: 'device_code',
      }).toString(),
      signal: AbortSignal.timeout(20000),
    });
    dc = await res.json();
    check('设备代码端点可达且返回 200', res.status === 200, 'status=' + res.status);
  } catch (e) {
    check('设备代码端点可达', false, e.message);
    console.log('\n  ⚠️ 网络不可达，后续用例跳过（这不代表代码有问题）');
    console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
    process.exit(fail === 0 ? 0 : 1);
    return;
  }

  check('返回了 user_code', !!(dc && dc.user_code), JSON.stringify(dc).slice(0, 160));
  check('返回了 verification_uri', !!(dc && dc.verification_uri));
  check('返回了 device_code', !!(dc && dc.device_code));
  check('expires_in 在合理范围（>0）', Number(dc.expires_in) > 0, 'expires_in=' + dc.expires_in);
  check('verification_uri 是 https 的微软域名',
    /^https:\/\/[^/]*microsoft\.com/.test(dc.verification_uri || ''), dc.verification_uri);

  if (!dc.device_code) { console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`); process.exit(1); }

  // ---- 2. 轮询一次，期望 authorization_pending ----
  try {
    const res = await fetch(`${TOKEN_URL}?client_id=${encodeURIComponent(CLIENT_ID)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        device_code: dc.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }).toString(),
      signal: AbortSignal.timeout(20000),
    });
    const j = await res.json();
    // 用户没授权 → 必须是 authorization_pending；如果直接给了 token 也算通过
    const ok = j.error === 'authorization_pending' || !!j.access_token;
    check('轮询返回 authorization_pending（链路通了，只差用户授权）',
      ok, JSON.stringify(j).slice(0, 200));
    if (j.error && j.error !== 'authorization_pending') {
      console.log(`  ⚠️ 非预期错误码：${j.error} — ${String(j.error_description).slice(0, 140)}`);
    }
  } catch (e) {
    check('轮询端点可达', false, e.message);
  }

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('[致命] ' + e.stack); process.exit(2); });
