'use strict';
/*
 * status.js —— 批量状态面板：一次看所有服务器的在线情况
 * 用法：node src/status.js
 */
const fs = require('fs');
const path = require('path');
const { pingServer, PROTOCOL_VERSION } = require('./client');

const ROOT = path.resolve(__dirname, '..');
const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[36m', gray: '\x1b[90m',
};

function stripColor(s) { return String(s || '').replace(/§./g, ''); }
function flatten(comp) {
  if (!comp) return '';
  if (typeof comp === 'string') return comp;
  let out = comp.text || '';
  if (comp.extra) out += comp.extra.map(flatten).join('');
  return out;
}
function bar(online, max, width = 20) {
  if (!max) return '';
  const ratio = Math.min(1, online / max);
  const filled = Math.round(ratio * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}
function pad(s, n) {
  const w = [...String(s)].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return String(s) + ' '.repeat(Math.max(0, n - w));
}

(async () => {
  const cfgPath = path.join(ROOT, 'config.json');
  if (!fs.existsSync(cfgPath)) { console.log('没有 config.json'); process.exit(1); }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch (e) {
    // config.json 写坏了要给一句看得懂的话，而不是甩一个 JSON 解析堆栈
    console.log(`${C.red}config.json 解析失败：${e.message}${C.reset}`);
    console.log(`${C.gray}请检查文件是否为合法 JSON（常见问题：多余逗号、中文引号）${C.reset}`);
    process.exit(1);
  }
  const servers = (cfg && cfg.servers) || [];
  if (!servers.length) { console.log('config.json 里没有服务器'); process.exit(1); }

  console.log('');
  console.log(`${C.bold}${C.blue}  服务器状态总览${C.reset}  ${C.gray}${new Date().toLocaleString('zh-CN')}${C.reset}`);
  console.log(`${C.gray}  ${'─'.repeat(72)}${C.reset}`);

  const results = await Promise.all(servers.map(async (s) => {
    try {
      const r = await pingServer(s.host, s.port || 25565, 8000);
      return { s, r, err: null };
    } catch (e) {
      return { s, r: null, err: e.message };
    }
  }));

  for (const { s, r, err } of results) {
    const name = s.name || s.host;
    if (err) {
      console.log(`  ${C.red}●${C.reset} ${C.bold}${pad(name, 16)}${C.reset} ${C.gray}${s.host}:${s.port || 25565}${C.reset}`);
      console.log(`      ${C.red}离线 / 无法连接：${err}${C.reset}`);
    } else {
      const online = r.players ? r.players.online : 0;
      const max = r.players ? r.players.max : 0;
      const motd = stripColor(flatten(r.description)).split('\n')[0];
      const protoOk = r.version && r.version.protocol === PROTOCOL_VERSION;
      console.log(`  ${C.green}●${C.reset} ${C.bold}${pad(name, 16)}${C.reset} ${C.gray}${r.__host}${C.reset}`);
      console.log(`      ${C.green}${bar(online, max)}${C.reset} ${C.bold}${online}${C.reset}/${max} 人   ${C.gray}${r.__latency}ms${C.reset}   ${protoOk ? C.green + '✔ 26.2' : C.yellow + '⚠ 协议 ' + (r.version && r.version.protocol) + ''}${C.reset}`);
      console.log(`      ${C.dim}${motd}${C.reset}`);
      if (r.players && r.players.sample && r.players.sample.length) {
        const names = r.players.sample.map((p) => stripColor(p.name)).slice(0, 10).join(', ');
        console.log(`      ${C.blue}在线玩家：${names}${C.reset}`);
      }
    }
    console.log('');
  }
  console.log(`${C.gray}  ${'─'.repeat(72)}${C.reset}`);
  console.log(`${C.dim}  提示：状态查询是只读的，不会登录，不会在服务器留下记录${C.reset}`);
  console.log('');
})().catch((e) => {
  console.error(`${C.red}状态查询出错：${(e && e.message) || e}${C.reset}`);
  process.exit(1);
});
