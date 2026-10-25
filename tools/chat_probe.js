'use strict';
/*
 * chat_probe.js —— 用**真实 26.2 服务端**取证：聊天包到底长什么样
 *
 * 严格遵循「只收不发」：
 *   - 本脚本**绝不**调用 client.say() / command()，不对服务器发任何聊天。
 *   - 消息来源一律是**服务端自己发出的**（通过服务端控制台 say 命令触发广播）。
 *     这正是"服务器发送的信息"，不会触发任何防挂机/禁言机制。
 *
 * 目的：核对 src/client.js 的聊天解析是否与 26.2 真实协议一致。
 *   现有解析是「猜」出来的字段顺序，且被空 catch 包着 —— 错位就静默丢消息。
 *   这里直接把收到的原始包 dump 出来，与官方 protocol.json 逐字段对照。
 *
 * 用法：node src/chat_probe.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const JAVA = 'C:\\Users\\<用户名>\\AppData\\Roaming\\.minecraft\\runtime\\java-runtime-epsilon\\bin\\java.exe';
const SERVER_DIR = path.join(__dirname, '..', 'testserver');
const PORT = 25611;

const { MCClient } = require('../src/client');
const { ByteReader } = require('../src/proto');
const auth = require('../src/auth');

const VERBOSE = process.env.MC_PROBE_VERBOSE === '1';

/* ============ 1. 启动测试服 ============ */
console.log('\n=== 聊天包取证（只收不发）===\n');
console.log('[1/4] 启动本地 26.2 测试服…');

const server = spawn(JAVA, ['-Xmx1G', '-jar', 'server.jar', 'nogui'], {
  cwd: SERVER_DIR,
  stdio: ['pipe', 'pipe', 'pipe'],
});

let serverReady = false;
const serverLog = [];
server.stdout.on('data', (d) => {
  const s = d.toString();
  serverLog.push(s);
  if (!serverReady && /Done \([\d.]+s\)!/.test(s)) {
    serverReady = true;
    onServerReady();
  }
});
server.stderr.on('data', (d) => serverLog.push(d.toString()));

/** 向服务端控制台发命令（服务端的行为，不是我们聊天） */
function consoleCmd(cmd) {
  try { server.stdin.write(cmd + '\n'); } catch (e) {}
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* ============ 2. 连接客户端（只收） ============ */
const captured = [];        // { id, hex, len }
const chatCalls = [];       // onChat 回调记录
const playIds = new Set();

let client = null;

async function onServerReady() {
  console.log('[2/4] 服务端就绪，用正版凭据连接…');

  let account;
  try {
    account = await auth.login({ silentOnly: true, log: () => {} });
  } catch (e) {
    console.log('  无法静默登录：' + e.message);
    finish(2);
    return;
  }
  console.log(`  以 ${account.profile.name} 连接 ${PORT} 端口`);

  client = new MCClient({
    host: '127.0.0.1',
    port: PORT,
    username: account.profile.name,
    accessToken: account.accessToken,
    profileId: account.profile.id,
    uuid: account.profile.id,
    log: (m) => { if (VERBOSE) console.log('    [net] ' + m); },
    onChat: (text, meta) => {
      chatCalls.push({ text, meta });
      console.log(`  [客户端收到] type=${meta.type} text=${JSON.stringify(text)}`);
    },
    onEvent: (ev, data) => {
      if (VERBOSE) console.log(`    [事件] ${ev}` + (data ? ' ' + JSON.stringify(data).slice(0, 200) : ''));
      if (ev === 'join') {
        console.log('  ✔ 已进服，开始取证');
        startProbe();
      }
      if (ev === 'kick') {
        console.log('  ✘ 被踢/断开：' + JSON.stringify(data));
      }
    },
  });

  // 挂钩子：把收到的每个 play 包都 dump 出来
  const origHandle = client.handlePacket.bind(client);
  client.handlePacket = function (body) {
    try {
      const r = new ByteReader(body);
      const id = r.varint();
      if (this.state === 'play') {
        playIds.add(id);
        // 只关心聊天相关 + 未知包
        if (id === 0x79 || id === 0x41 || id === 0x21) {
          captured.push({ id, hex: body.toString('hex'), len: body.length });
        }
      }
    } catch (e) {}
    return origHandle(body);
  };

  try {
    await client.connect();
  } catch (e) {
    console.log('  连接失败: ' + e.message);
    finish(2);
  }
}

/* ============ 3. 从服务端触发消息（服务端 → 客户端） ============ */
async function startProbe() {
  await sleep(2500);

  console.log('[3/4] 从**服务端控制台**触发消息（客户端不发送任何内容）…');

  // 服务端控制台 say → 广播给所有玩家。这是纯「服务端发出的消息」
  consoleCmd('say PROBE_SERVER_SAY_1');
  await sleep(1500);

  consoleCmd('say 中文测试 PROBE_2');
  await sleep(1500);

  // tellraw 带样式的富文本（测 NBT 组件解析）
  consoleCmd('tellraw @a {"text":"PROBE_TELLRAW","color":"gold"}');
  await sleep(1500);

  // 带 extra 的复合组件
  consoleCmd('tellraw @a {"text":"A_","extra":[{"text":"B_"},{"text":"C"}]}');
  await sleep(2000);

  finish(0);
}

/* ============ 4. 汇总 ============ */
function finish(code) {
  console.log('\n[4/4] 结果汇总');
  console.log('='.repeat(62));

  console.log(`\n客户端 onChat 回调次数: ${chatCalls.length}`);
  for (const c of chatCalls) {
    console.log(`  [${c.meta.type}] ${JSON.stringify(c.text)}`);
  }

  console.log(`\n捕获到的聊天类原始包: ${captured.length} 个`);
  for (const p of captured) {
    const name = p.id === 0x79 ? 'system_chat'
               : p.id === 0x41 ? 'player_chat'
               : p.id === 0x21 ? 'profileless_chat'
               : '?';
    console.log(`\n  --- 0x${p.id.toString(16)} ${name} (${p.len} 字节) ---`);
    // 前 160 字节足够看清结构
    const hex = p.hex.slice(0, 320);
    console.log('  ' + (hex.match(/.{1,64}/g) || []).join('\n  '));
    if (p.hex.length > 320) console.log('  …（截断）');
  }

  console.log('\n' + '='.repeat(62));
  const hasMsg = chatCalls.length > 0;
  const hasProbe = chatCalls.some((c) => /PROBE/.test(c.text || ''));
  console.log(hasMsg ? '✅ 收到了聊天消息' : '❌ 一条聊天都没收到');
  console.log(hasProbe ? '✅ 收到了服务端广播的探测消息' : '⚠️  没收到探测消息');
  console.log('='.repeat(62) + '\n');

  try { if (client) client.close(); } catch (e) {}
  try { consoleCmd('stop'); } catch (e) {}
  setTimeout(() => {
    try { server.kill(); } catch (e) {}
    process.exit(hasMsg ? 0 : 1);
  }, 1200);
}

// 总超时
setTimeout(() => {
  console.log('\n[超时] 强制收尾');
  finish(0);
}, 90000);
