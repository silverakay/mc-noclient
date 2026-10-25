'use strict';
/*
 * autojoin.js —— 主程序
 *
 * 两种用法：
 *   node src/autojoin.js            交互菜单
 *   node src/autojoin.js --config config.json    读配置直接跑（供双击启动）
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { MCClient, pingServer, MC_VERSION, PROTOCOL_VERSION } = require('./client');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const LOG_DIR = path.join(ROOT, 'logs');

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[36m', gray: '\x1b[90m', magenta: '\x1b[35m',
};

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

let logStream = null;
function log(line) {
  const text = line.replace(/\x1b\[\d+m/g, '');
  process.stdout.write(`${C.gray}${ts()}${C.reset} ${line}\n`);
  if (logStream) logStream.write(`[${ts()}] ${text}\n`);
}

function defaultConfig() {
  return {
    _说明: '改这里就行。servers 可以写多个，工具会逐个尝试。',
    username: 'Steve',
    autoJoin: true,
    servers: [
      { name: '本机测试服', host: '127.0.0.1', port: 25565, note: '先在本地开个服务器验证' },
    ],
    behavior: {
      keepAlive: true,
      showChat: true,
      greet: '',
      commands: [],
      reconnect: false,
      reconnectDelaySec: 10,
    },
  };
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig(), null, 2), 'utf8');
    log(`${C.yellow}未找到 config.json，已生成默认配置${C.reset}`);
  }
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    log(`${C.red}config.json 格式错误：${e.message}${C.reset}`);
    process.exit(1);
  }
}

/* ---------------- 连接一个服务器并保持 ---------------- */
async function joinAndHold(server, cfg) {
  const bh = cfg.behavior || {};
  const client = new MCClient({
    host: server.host,
    port: server.port || 25565,
    username: cfg.username,
    log: (m) => log(formatMod(m)),
    onChat: (text, meta) => {
      if (!bh.showChat) return;
      const tag = meta.type === 'player' ? `${C.blue}[聊天]${C.reset}` : `${C.magenta}[系统]${C.reset}`;
      log(`${tag} ${text}`);
    },
    onEvent: (ev, data) => {
      if (ev === 'join') {
        log(`${C.green}✔ 已进入服务器 —— 现在可以关掉这个窗口吗？不可以，保持运行才能挂机${C.reset}`);
        setTimeout(() => {
          if (bh.greet) { client.say(bh.greet); log(`${C.dim}→ 打招呼: ${bh.greet}${C.reset}`); }
          for (const c of (bh.commands || [])) { client.command(c); log(`${C.dim}→ 执行: /${c}${C.reset}`); }
          client.sendClientSettings();
        }, 1500);
      }
    },
  });

  try {
    await client.connect();
  } catch (e) {
    log(`${C.red}连接失败：${e.message}${C.reset}`);
    return null;
  }

  // 等待进入 play 或断开
  await new Promise((resolve) => {
    const check = setInterval(() => {
      if (client.state === 'closed') { done(); }
      else if (client.state === 'play' && client.alive) { done(); }
    }, 300);
    // ❗兜底超时也要能取消，否则它会让 Node 进程多挂 20 秒（CLI 退出时明显）
    const guard = setTimeout(done, 20000);
    let settled = false;
    function done() {
      if (settled) return;
      settled = true;
      clearInterval(check);
      clearTimeout(guard);
      resolve();
    }
  });

  client.ready = client.state === 'play';
  return client;
}

function formatMod(m) {
  if (m.startsWith('[') && m.includes('错误')) return `${C.red}${m}${C.reset}`;
  if (m.includes('成功')) return `${C.green}${m}${C.reset}`;
  return m;
}

/* ---------------- 状态查询 ---------------- */
function stripColor(s) { return String(s || '').replace(/§./g, ''); }

async function doPing(host, port) {
  log(`正在查询 ${host}:${port} ...`);
  try {
    const r = await pingServer(host, port);
    const desc = r.description;
    let motd = '';
    if (typeof desc === 'string') motd = desc;
    else if (desc && typeof desc === 'object') motd = flatten(desc);
    console.log('');
    console.log(`${C.bold}${C.green}  ┌─ 服务器响应 ──────────────────────${C.reset}`);
    console.log(`  │ 地址   ${r.__host}`);
    console.log(`  │ MOTD   ${stripColor(motd).replace(/\n/g, '\n  │        ')}`);
    console.log(`  │ 版本   ${r.version && r.version.name} (协议 ${r.version && r.version.protocol})`);
    if (r.players) {
      console.log(`  │ 人数   ${C.bold}${r.players.online}${C.reset} / ${r.players.max}`);
      if (r.players.sample && r.players.sample.length) {
        console.log(`  │ 在线   ${r.players.sample.map((p) => stripColor(p.name)).slice(0, 12).join(', ')}`);
      }
    }
    console.log(`  │ 延迟   ${r.__latency} ms`);
    const modOk = r.version && r.version.protocol === PROTOCOL_VERSION;
    console.log(`  │ 兼容   ${modOk ? C.green + '✔ 与本工具(26.2)匹配' : C.yellow + '⚠ 协议号不同，登录可能失败' + C.reset}`);
    console.log(`${C.bold}${C.green}  └───────────────────────────────────${C.reset}`);
    console.log('');
    return r;
  } catch (e) {
    log(`${C.red}查询失败：${e.message}${C.reset}`);
    return null;
  }
}

function flatten(comp) {
  if (!comp) return '';
  if (typeof comp === 'string') return comp;
  let out = comp.text || '';
  if (comp.extra) out += comp.extra.map(flatten).join('');
  return out;
}

/* ---------------- 交互菜单 ---------------- */
async function interactive() {
  const cfg = loadConfig();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((r) => rl.question(q, r));

  for (;;) {
    console.log('');
    console.log(`${C.bold}${C.blue}  ╔══════════════════════════════════════╗${C.reset}`);
    console.log(`${C.bold}${C.blue}  ║   MC 免客户端登录器 · 26.2 协议版    ║${C.reset}`);
    console.log(`${C.bold}${C.blue}  ╚══════════════════════════════════════╝${C.reset}`);
    console.log(`${C.dim}  不启动游戏，直接以玩家身份连上服务器${C.reset}`);
    console.log('');
    cfg.servers.forEach((s, i) => {
      console.log(`   ${C.bold}${i + 1}${C.reset}) ${s.name || s.host}   ${C.gray}${s.host}:${s.port || 25565}${C.reset}`);
    });
    console.log(`   ${C.bold}n${C.reset}) 添加服务器`);
    console.log(`   ${C.bold}p${C.reset}) 只查询状态（不登录）`);
    console.log(`   ${C.bold}u${C.reset}) 改用户名（当前：${cfg.username}）`);
    console.log(`   ${C.bold}q${C.reset}) 退出`);
    console.log('');

    const ans = (await ask('  请选择 > ')).trim().toLowerCase();

    if (ans === 'q') { rl.close(); return; }
    if (ans === 'n') {
      const host = (await ask('  服务器地址 > ')).trim();
      if (!host) continue;
      const port = parseInt((await ask('  端口（默认25565）> ')).trim() || '25565', 10);
      const name = (await ask('  给它起个名字 > ')).trim() || host;
      cfg.servers.push({ name, host, port });
      saveConfig(cfg);
      continue;
    }
    if (ans === 'u') {
      const u = (await ask('  新的用户名（≤16字符）> ')).trim();
      if (u) { cfg.username = u.slice(0, 16); saveConfig(cfg); log(`用户名已改为 ${cfg.username}`); }
      continue;
    }
    if (ans === 'p') {
      const s = await pickServer(cfg, ask);
      if (s) await doPing(s.host, s.port || 25565);
      continue;
    }

    const idx = parseInt(ans, 10) - 1;
    if (idx >= 0 && idx < cfg.servers.length) {
      const s = cfg.servers[idx];
      const op = (await ask(`  1=查询状态  2=登录并保持  > `)).trim();
      if (op === '1') { await doPing(s.host, s.port || 25565); continue; }
      rl.close();
      await runSession(s, cfg);
      return;
    }
  }
}

async function pickServer(cfg, ask) {
  if (cfg.servers.length === 0) { log('还没有配置服务器'); return null; }
  if (cfg.servers.length === 1) return cfg.servers[0];
  cfg.servers.forEach((s, i) => console.log(`   ${i + 1}) ${s.name} (${s.host})`));
  const i = parseInt((await ask('  选哪个 > ')).trim(), 10) - 1;
  return cfg.servers[i] || null;
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

/* ---------------- 会话模式（登录并挂住） ---------------- */
async function runSession(server, cfg) {
  if (!logStream) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    logStream = fs.createWriteStream(
      path.join(LOG_DIR, `session-${new Date().toISOString().slice(0, 10)}.log`),
      { flags: 'a' }
    );
  }
  log(`${C.bold}目标：${server.name || server.host} (${server.host}:${server.port || 25565})${C.reset}`);
  log(`${C.dim}用户名：${cfg.username} · 协议：MC ${MC_VERSION} (${PROTOCOL_VERSION})${C.reset}`);
  log(`${C.dim}按 Ctrl+C 结束会话${C.reset}`);
  console.log('');

  let client = await joinAndHold(server, cfg);
  if (!client || !client.ready) {
    log(`${C.red}未能进入服务器。${C.reset}`);
    if (client) client.close();
    return;
  }

  // 状态行
  const statusTimer = setInterval(() => {
    if (!client || client.state === 'closed') return;
    process.stdout.write(`\r${C.gray}   状态：在线 ${client.uptimeText()} · 收 ${(client.stats.received / 1024).toFixed(1)}KB · 聊天 ${client.stats.chats} 条${C.reset}   `);
  }, 2000);

  // 命令行输入
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on('line', (line) => {
      const t = line.trim();
      if (!t) return;
      process.stdout.write('\r' + ' '.repeat(80) + '\r');
      if (t.startsWith('/')) client.command(t.slice(1));
      else client.say(t);
      log(`${C.dim}→ ${t}${C.reset}`);
    });
  }

  await new Promise((resolve) => {
    const onClose = () => resolve();
    client.onEvent = ((orig) => (ev, d) => {
      if (ev === 'close' || ev === 'kick') { setTimeout(onClose, 200); }
    })(client.onEvent);

    process.on('SIGINT', () => {
      clearInterval(statusTimer);
      log(`\n${C.yellow}结束连接...${C.reset}`);
      client.close();
      resolve();
    });
  });

  clearInterval(statusTimer);
  process.stdout.write('\r' + ' '.repeat(80) + '\r');
  log('会话已结束。');
}

/* ---------------- 入口 ---------------- */
(async () => {
  const argv = process.argv.slice(2);
  const cfgIdx = argv.indexOf('--config');
  const cfg = loadConfig();

  if (cfgIdx >= 0) {
    // 双击启动模式：直接跑配置里的第一个服务器
    const s = cfg.servers[0];
    if (!s) { log(`${C.red}config.json 里没有配置任何服务器${C.reset}`); process.exit(1); }
    await runSession(s, cfg);
    if (!cfg.behavior || !cfg.behavior.reconnect) process.exit(0);
    // 断线重连
    for (;;) {
      await new Promise((r) => setTimeout(r, (cfg.behavior.reconnectDelaySec || 10) * 1000));
      log(`${C.dim}尝试重连...${C.reset}`);
      await runSession(s, cfg);
    }
  }

  if (argv.includes('--ping')) {
    const s = cfg.servers[0];
    if (s) await doPing(s.host, s.port || 25565);
    process.exit(0);
  }

  await interactive();
})();
