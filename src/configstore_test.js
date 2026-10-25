'use strict';
/*
 * configstore_test.js —— 配置持久化自检
 *
 * 回归目标是这个真实 bug：
 *   「添加服务器后，每次重新打开，添加的服务器就消失了」
 *
 * 它由两个独立缺陷叠加而成，两个都要有测试守住：
 *   ① 路径不稳定：旧版把配置写在 exe 同级目录，便携版每次解压到随机临时目录
 *      → 配置随临时目录销毁 → 表现为"服务器没了"。
 *   ② 保存静默失败：`catch(e){return false}` 把错误吞掉，界面无感。
 *
 * 因此测试重点是：换目录后配置还在、旧配置能迁移、写失败要能被感知。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('./configstore');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  \x1b[32m[PASS]\x1b[0m ${name}`); pass++; }
  catch (e) { console.log(`  \x1b[31m[FAIL]\x1b[0m ${name}\n         ${e.message}`); fail++; }
}

console.log('\n=== 配置持久化 · 离线自测 ===\n');

// 每个用例用独立的临时目录，互不干扰
const tmpRoots = [];
function mkTmp(label) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cfgs-' + label + '-'));
  tmpRoots.push(d);
  return d;
}
function cleanup() {
  for (const d of tmpRoots) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {}
  }
}
process.on('exit', cleanup);

console.log('[A] 基本读写');

t('首次 load 会落一份默认配置到磁盘', () => {
  const dir = mkTmp('basic');
  const p = path.join(dir, 'config.json');
  assert.ok(!fs.existsSync(p), '前置：文件不该存在');
  const r = store.load(p, []);
  assert.strictEqual(r.error, null);
  assert.ok(fs.existsSync(p), 'load 后应创建配置文件');
  assert.ok(Array.isArray(r.cfg.servers), 'servers 应为数组');
});

t('save 后 load 能读回同样的服务器列表', () => {
  const dir = mkTmp('rt');
  const p = path.join(dir, 'config.json');
  store.load(p, []);
  const cfg = {
    username: 'Nan_Koi',
    servers: [
      { name: '我的服', host: 'relay.example.invalid', port: 1591 },
      { name: '备用', host: 'play.example.com', port: 25565 },
    ],
    behavior: { showChat: true, greet: '', commands: [] },
  };
  const w = store.save(p, cfg);
  assert.strictEqual(w.ok, true, '写入应成功：' + JSON.stringify(w));
  const r = store.load(p, []);
  assert.strictEqual(r.cfg.servers.length, 2, '读回应为 2 个服务器');
  assert.strictEqual(r.cfg.servers[0].host, 'relay.example.invalid');
  assert.strictEqual(r.cfg.username, 'Nan_Koi');
});

t('save 返回结果里带路径（便于界面提示"存哪了"）', () => {
  const dir = mkTmp('path');
  const p = path.join(dir, 'config.json');
  const w = store.save(p, store.defaultConfig());
  assert.strictEqual(w.path, p);
});

console.log('\n[B] ❗核心回归：换运行目录后配置仍在');
t('模拟便携版：配置在固定目录时，换"exe 解压目录"不受影响', () => {
  // 便携版每次把 exe 解压到新的随机目录（tempA / tempB），
  // 但只要配置存在**用户级固定目录**，两次运行读到的是同一份。
  const userDir = mkTmp('userdata');        // 固定：类比 %APPDATA%\MC免客户端登录器
  const tempA = mkTmp('portableA');         // 第一次运行的解压目录
  const tempB = mkTmp('portableB');         // 第二次运行的解压目录

  const cfgPath = path.join(userDir, 'config.json');
  const legacyA = [path.join(tempA, 'data', 'config.json')];   // 旧逻辑会写这里
  const legacyB = [path.join(tempB, 'data', 'config.json')];

  // 第一次运行：读固定目录 → 加服务器 → 保存
  store.load(cfgPath, legacyA);
  const cfg = store.load(cfgPath, legacyA).cfg;
  cfg.servers.push({ name: '我的服', host: 'relay.example.invalid', port: 1591 });
  store.save(cfgPath, cfg);

  // 第二次运行：解压目录换成 tempB，仍从同一个固定目录读
  const r2 = store.load(cfgPath, legacyB);
  const hit = r2.cfg.servers.find((s) => s.host === 'relay.example.invalid');
  assert.ok(hit, '换解压目录后，之前加的服务器必须还在（这正是原 bug）');
  assert.strictEqual(hit.port, 1591);
});

t('反面对照：旧逻辑（写进随机目录）确实会"丢配置"', () => {
  // 这个用例不复现 bug，而是证明"路径不稳定 → 必然丢"，
  // 让回归测试本身也能解释清楚当初为什么出问题。
  const tempA = mkTmp('oldA');
  const tempB = mkTmp('oldB');
  const pathA = path.join(tempA, 'data', 'config.json');
  const pathB = path.join(tempB, 'data', 'config.json');

  const cfg = store.defaultConfig();
  cfg.servers.push({ name: '我的服', host: 'relay.example.invalid', port: 1591 });
  store.save(pathA, cfg);                       // 第一次运行写在 A

  const r = store.load(pathB, []);              // 第二次运行读 B（新目录）
  assert.strictEqual(r.cfg.servers.length, 1, 'B 目录里只有默认的 1 个服');
  assert.ok(!r.cfg.servers.find((s) => s.host === 'relay.example.invalid'),
    '写在 A 的服务器在 B 里读不到 —— 这就是原 bug 的机制');
});

console.log('\n[C] 旧配置迁移');
t('新位置为空时，自动从旧位置迁移', () => {
  const userDir = mkTmp('mig-user');
  const oldDir = mkTmp('mig-old');
  const cfgPath = path.join(userDir, 'config.json');
  const oldPath = path.join(oldDir, 'data', 'config.json');

  // 造一份旧配置
  fs.mkdirSync(path.dirname(oldPath), { recursive: true });
  fs.writeFileSync(oldPath, JSON.stringify({
    username: 'BaiXu',
    servers: [{ name: '老服', host: 'old.example.com', port: 25565 }],
    behavior: { showChat: true },
  }), 'utf8');

  const r = store.load(cfgPath, [oldPath]);
  assert.strictEqual(r.migratedFrom, oldPath, '应报告迁移来源');
  assert.strictEqual(r.cfg.servers[0].host, 'old.example.com', '应搬到旧配置内容');
  assert.strictEqual(r.cfg.username, 'BaiXu');
  assert.ok(fs.existsSync(cfgPath), '迁移后新位置应存在');
});

t('迁移后旧文件保留（只读不删，不擅动用户文件）', () => {
  const userDir = mkTmp('mig2-user');
  const oldDir = mkTmp('mig2-old');
  const cfgPath = path.join(userDir, 'config.json');
  const oldPath = path.join(oldDir, 'config.json');
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(oldPath, JSON.stringify(store.defaultConfig()), 'utf8');

  store.load(cfgPath, [oldPath]);
  assert.ok(fs.existsSync(oldPath), '旧文件必须还在（我们只读不删）');
});

t('新位置已有配置时不覆盖（迁移只在首次发生）', () => {
  const userDir = mkTmp('mig3-user');
  const oldDir = mkTmp('mig3-old');
  const cfgPath = path.join(userDir, 'config.json');
  const oldPath = path.join(oldDir, 'config.json');

  store.save(cfgPath, { username: 'NEW', servers: [], behavior: {} });
  fs.writeFileSync(oldPath, JSON.stringify({ username: 'OLD', servers: [], behavior: {} }), 'utf8');

  const r = store.load(cfgPath, [oldPath]);
  assert.strictEqual(r.migratedFrom, null, '不该迁移');
  assert.strictEqual(r.cfg.username, 'NEW', '必须保留新位置的配置');
});

t('多个旧位置：坏的第一个自动跳到下一个', () => {
  const userDir = mkTmp('mig4-user');
  const badDir = mkTmp('mig4-bad');
  const goodDir = mkTmp('mig4-good');
  const cfgPath = path.join(userDir, 'config.json');
  const badPath = path.join(badDir, 'config.json');
  const goodPath = path.join(goodDir, 'config.json');

  fs.writeFileSync(badPath, '{ 这不是合法 JSON', 'utf8');    // 坏的
  fs.writeFileSync(goodPath, JSON.stringify({
    username: 'GOOD', servers: [{ name: 'a', host: 'good.host', port: 1 }], behavior: {},
  }), 'utf8');

  const r = store.load(cfgPath, [badPath, goodPath]);
  assert.strictEqual(r.error, null, '坏的旧配置不应导致报错');
  assert.strictEqual(r.cfg.servers[0].host, 'good.host', '应跳到下一个可用旧位置');
});

console.log('\n[D] ❗核心回归：写失败必须可感知');
t('目标路径不可写时，save 返回 ok:false 且带原因', () => {
  // 用一个"父路径是文件"的路径制造写入失败（跨平台稳定）
  const dir = mkTmp('fail');
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'I am a file, not a dir', 'utf8');
  const badPath = path.join(blocker, 'sub', 'config.json');  // 父级是文件 → 建目录必失败

  const r = store.save(badPath, store.defaultConfig());
  assert.strictEqual(r.ok, false, '写入应失败');
  assert.ok(r.error && r.error.length > 0, '必须带上错误原因，不能静默');
});

t('load 遇到损坏的 JSON 返回可读错误，而不是抛异常', () => {
  const dir = mkTmp('badjson');
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, '{ 坏掉的配置 ][', 'utf8');

  let r;
  assert.doesNotThrow(() => { r = store.load(p, []); }, '不该抛异常');
  assert.ok(r.error, '应返回错误信息');
  assert.ok(Array.isArray(r.cfg.servers), '仍应给一份可用的默认配置保证能启动');
});

t('save 是原子的：失败时不留半个坏文件', () => {
  const dir = mkTmp('atomic');
  const p = path.join(dir, 'config.json');
  store.save(p, { username: 'A', servers: [], behavior: {} });
  const before = fs.readFileSync(p, 'utf8');

  // 再存一次，内容不同
  store.save(p, { username: 'B', servers: [], behavior: {} });
  const after = fs.readFileSync(p, 'utf8');

  // 两次都是合法 JSON（原子替换不会出现"半个文件"）
  assert.doesNotThrow(() => JSON.parse(before));
  assert.doesNotThrow(() => JSON.parse(after));
  assert.strictEqual(JSON.parse(after).username, 'B');
  assert.ok(!fs.existsSync(p + '.tmp'), '不应残留 .tmp 文件');
});

console.log('\n[E] 数据规范化（手改坏了也不能崩）');

t('servers 不是数组 → 修正为空数组', () => {
  assert.deepStrictEqual(store.normalize({ servers: 'oops' }).servers, []);
  assert.deepStrictEqual(store.normalize({ servers: null }).servers, []);
  assert.deepStrictEqual(store.normalize({}).servers, []);
});

t('username 为空/非字符串 → 回落 Steve', () => {
  assert.strictEqual(store.normalize({ username: '' }).username, 'Steve');
  assert.strictEqual(store.normalize({ username: 123 }).username, 'Steve');
  assert.strictEqual(store.normalize({}).username, 'Steve');
});

t('behavior 缺失/损坏 → 修正为对象', () => {
  assert.strictEqual(typeof store.normalize({}).behavior, 'object');
  assert.strictEqual(typeof store.normalize({ behavior: 'x' }).behavior, 'object');
  assert.strictEqual(typeof store.normalize({ behavior: null }).behavior, 'object');
});

t('normalize 保留合法数据不受影响', () => {
  const src = {
    username: 'Nan_Koi',
    servers: [{ name: 'a', host: 'h', port: 1 }],
    behavior: { showChat: false, greet: 'hi', commands: ['/spawn'] },
  };
  const out = store.normalize(JSON.parse(JSON.stringify(src)));
  // 原有字段必须原样保留（新增字段见 [F] 段）
  assert.strictEqual(out.username, src.username);
  assert.deepStrictEqual(out.servers, src.servers);
  assert.deepStrictEqual(out.behavior, src.behavior);
});

t('null / 非对象输入不崩', () => {
  assert.strictEqual(typeof store.normalize(null), 'object');
  assert.strictEqual(typeof store.normalize(undefined), 'object');
  assert.strictEqual(typeof store.normalize('string'), 'object');
});

console.log('\n[F] 启动自动登录（autoLogin）');
t('默认配置里 autoLogin 为 true（新装即开）', () => {
  assert.strictEqual(store.defaultConfig().autoLogin, true);
});

t('老配置缺 autoLogin 字段 → 补为 true（升级后功能不消失）', () => {
  // 老配置文件里没有这个字段。若归一化时不补 true，
  // 老用户升级后会"功能好像没生效"，属于静默失效。
  const out = store.normalize({ username: 'x', servers: [], behavior: {} });
  assert.strictEqual(out.autoLogin, true, '缺字段应默认开启');
});

t('显式 false 被尊重（用户主动关掉不该被覆盖）', () => {
  assert.strictEqual(store.normalize({ autoLogin: false }).autoLogin, false);
});

t('非法值（字符串/数字/null）→ 回落到 true', () => {
  assert.strictEqual(store.normalize({ autoLogin: 'yes' }).autoLogin, true);
  assert.strictEqual(store.normalize({ autoLogin: 0 }).autoLogin, true);
  assert.strictEqual(store.normalize({ autoLogin: null }).autoLogin, true);
});

t('autoLogin 能正确往返（存盘后读回不丢）', () => {
  const dir = mkTmp('al');
  const p = path.join(dir, 'config.json');
  store.load(p, []);
  const cfg = store.load(p, []).cfg;
  cfg.autoLogin = false;
  store.save(p, cfg);
  const back = store.load(p, []).cfg;
  assert.strictEqual(back.autoLogin, false, '关掉后重新打开应仍是关的');
});

console.log('\n[G] 移除"自动连接上次服务器"功能（v2.3.1）');
t('默认配置里不再有 lastServer 字段', () => {
  // v2.3.0 曾用 lastServer 实现自动连接，已按用户要求移除。
  // 若这里失败说明字段又在默认配置里冒出来了。
  assert.ok(!('lastServer' in store.defaultConfig()),
    'lastServer 不该再出现在默认配置里');
});

t('❗历史遗留的 lastServer 会被自动清理掉', () => {
  // 老配置文件里残留的 lastServer 必须删掉：
  // 留着它会让配置文件看起来"还支持自动连接"，而且是一段没人读的死数据。
  const out = store.normalize({
    username: 'x',
    lastServer: { name: '我的服', host: 'relay.example.invalid', port: 1591, usePremium: true },
  });
  assert.ok(!('lastServer' in out), 'lastServer 应被删除，实际仍在：' + JSON.stringify(out.lastServer));
});

t('各种形态的遗留 lastServer 都能被清掉（含脏数据）', () => {
  for (const bad of [
    { lastServer: null },
    { lastServer: undefined },
    { lastServer: {} },
    { lastServer: 'oops' },
    { lastServer: 123 },
    { lastServer: [] },
    { lastServer: { host: '' } },
  ]) {
    const out = store.normalize(JSON.parse(JSON.stringify(bad)));
    assert.ok(!('lastServer' in out),
      '应删除 lastServer，输入=' + JSON.stringify(bad));
  }
});

t('清理遗留字段的同时，其它字段不受影响', () => {
  const out = store.normalize({
    username: 'Nan_Koi',
    servers: [{ name: 'a', host: 'h', port: 1 }],
    behavior: { showChat: false },
    lastServer: { host: 'old.host', port: 1 },
    autoLogin: false,
  });
  assert.strictEqual(out.username, 'Nan_Koi');
  assert.strictEqual(out.servers.length, 1);
  assert.strictEqual(out.behavior.showChat, false);
  assert.strictEqual(out.autoLogin, false, 'autoLogin 的显式值不能被连带影响');
  assert.ok(!('lastServer' in out));
});

t('存盘后重新读回，lastServer 不会复活', () => {
  const dir = mkTmp('ls-gone');
  const p = path.join(dir, 'config.json');
  // 模拟一个老配置文件（含 lastServer）
  fs.writeFileSync(p, JSON.stringify({
    username: 'x', servers: [], behavior: {},
    lastServer: { host: 'old.host', port: 1591 },
  }), 'utf8');

  const first = store.load(p, []).cfg;
  assert.ok(!('lastServer' in first), '首次读取就该清掉');
  store.save(p, first);
  const back = store.load(p, []).cfg;
  assert.ok(!('lastServer' in back), '存盘再读也不该复活');
  // 磁盘上的原始 JSON 里也不该再出现这个键
  const rawOnDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.ok(!('lastServer' in rawOnDisk), '写回磁盘时也该清掉');
});

console.log('\n[H] 重连和显示设置');
t('全新默认配置没有个人监测名单，欢迎延迟可独立保存', () => {
  assert.deepStrictEqual(store.defaultConfig().monitoredPlayers, []);
  assert.deepStrictEqual(store.defaultConfig().automation.welcomeDelay, { minMs: 400, maxMs: 850 });
  const cfg = store.normalize({ automation: { welcomeDelay: { minMs: 1200, maxMs: 2300 }, welcomeDelayEnabled: false } });
  const p = path.join(mkTmp('welcome-delay'), 'config.json');
  assert.strictEqual(store.save(p, cfg).ok, true);
  const back = store.load(p, []).cfg;
  assert.deepStrictEqual(back.automation.welcomeDelay, { minMs: 1200, maxMs: 2300 });
  assert.strictEqual(back.automation.welcomeDelayEnabled, false);
  assert.deepStrictEqual(store.normalize({ automation: { welcomeDelay: { minMs: -1, maxMs: 2000 } } }).automation.welcomeDelay,
    { minMs: 400, maxMs: 850 });
});
t('零点命令默认关闭，有效命令开关和内容可保存，坏命令不启用', () => {
  assert.deepStrictEqual(store.defaultConfig().midnightCommand, { enabled: false, command: '' });
  const cfg = store.normalize({ midnightCommand: { enabled: true, command: '/fixture midnight args' } });
  const p = path.join(mkTmp('midnight'), 'config.json');
  assert.strictEqual(store.save(p, cfg).ok, true);
  assert.deepStrictEqual(store.load(p, []).cfg.midnightCommand, { enabled: true, command: '/fixture midnight args' });
  for (const value of [null, 'bad', { enabled: true, command: '' }, { enabled: true, command: '/a\n/b' }]) {
    assert.strictEqual(store.normalize({ midnightCommand: value }).midnightCommand.enabled, false);
  }
});
t('自动领取设置默认开启，显式关闭及存盘往返均保留', () => {
  assert.strictEqual(store.normalize({}).automation.autoClaimRedPackets, true);
  const cfg = store.normalize({ servers: [], automation: { autoClaimRedPackets: false } });
  const p = path.join(mkTmp('auto-claim'), 'config.json');
  assert.strictEqual(store.save(p, cfg).ok, true);
  assert.strictEqual(store.load(p, []).cfg.automation.autoClaimRedPackets, false);
  assert.strictEqual(store.normalize({ automation: 'bad' }).automation.autoClaimRedPackets, true);
});
t('旧配置升级补齐设置，但不恢复启动自动连接', () => {
  const cfg = store.normalize({ username: 'Tester', servers: [], behavior: { showChat: false } });
  assert.deepStrictEqual(cfg.reconnect, { enabled: true, delaySeconds: 5, maxAttempts: 10 });
  assert.deepStrictEqual(cfg.display, { autoScroll: true, showMonitor: true, hidePresence: true, logLimit: 800, chatBlocklist: [] });
  assert.deepStrictEqual(cfg.storage, { path: '', retentionDays: 7 });
  assert.deepStrictEqual(cfg.monitoredPlayers, ['Nan_Koi']);
  assert.strictEqual(cfg.behavior.showChat, false);
  assert.ok(!('lastServer' in cfg));
});
t('设置保存后重启仍然保留，包括关闭和不限次数', () => {
  const p = path.join(mkTmp('settings'), 'config.json');
  const cfg = store.normalize({ username: 'Tester', servers: [], autoLogin: false,
    behavior: { showChat: false, greet: 'legacy', commands: ['legacy'] },
    reconnect: { enabled: false, delaySeconds: 7, maxAttempts: 0 },
    display: { autoScroll: false, showMonitor: false } });
  assert.strictEqual(store.save(p, cfg).ok, true);
  const back = store.load(p, []).cfg;
  assert.deepStrictEqual(back, cfg);
});
t('损坏的设置修正为有效范围，显式关闭保持关闭', () => {
  const cfg = store.normalize({ reconnect: { enabled: false, delaySeconds: 300, maxAttempts: -1 },
    display: { autoScroll: 'no', showMonitor: false } });
  assert.deepStrictEqual(cfg.reconnect, { enabled: false, delaySeconds: 60, maxAttempts: 0 });
  assert.deepStrictEqual(cfg.display, { autoScroll: true, showMonitor: false, hidePresence: true, logLimit: 800, chatBlocklist: [] });
  for (const value of [null, 'invalid', 12, []]) {
    assert.deepStrictEqual(store.normalize({ reconnect: value }).reconnect, store.defaultConfig().reconnect);
  }
});
t('保存修复后的设置不会把临时读取错误留在配置里', () => {
  const p = path.join(mkTmp('settings-error'), 'config.json');
  const cfg = store.normalize({ servers: [], __loadError: 'old read error', reconnect: { enabled: true } });
  assert.ok(!('__loadError' in cfg));
  assert.strictEqual(store.save(p, cfg).ok, true);
  assert.ok(!('__loadError' in store.load(p, []).cfg));
});

t('进出服通知默认隐藏，显式显示在保存后仍保留', () => {
  assert.strictEqual(store.normalize({}).display.hidePresence, true);
  const cfg = store.normalize({ display: { hidePresence: false } });
  const p = path.join(mkTmp('presence-display'), 'config.json');
  assert.strictEqual(store.save(p, cfg).ok, true);
  assert.strictEqual(store.load(p, []).cfg.display.hidePresence, false);
});
t('聊天屏蔽关键词会规范化并在重启后保留', () => {
  const p = path.join(mkTmp('chat-blocklist'), 'config.json');
  const cfg = store.normalize({ display: { chatBlocklist: [' 市场 ', '市场', '红包'] } });
  assert.deepStrictEqual(cfg.display.chatBlocklist, ['市场', '红包']);
  assert.strictEqual(store.save(p, cfg).ok, true);
  assert.deepStrictEqual(store.load(p, []).cfg.display.chatBlocklist, ['市场', '红包']);
});
t('关闭行为默认退出，后台选项和红包自定义范围可持久化', () => {
  assert.strictEqual(store.defaultConfig().closeBehavior, 'quit');
  assert.strictEqual(store.normalize({ closeBehavior: 'bad' }).closeBehavior, 'quit');
  const cfg = store.normalize({ closeBehavior: 'background', automation: { claimDelay: { minMs: 120, maxMs: 150 } } });
  const p = path.join(mkTmp('mango-settings'), 'config.json');
  assert.strictEqual(store.save(p, cfg).ok, true);
  const back = store.load(p, []).cfg;
  assert.strictEqual(back.closeBehavior, 'background');
  assert.deepStrictEqual(back.automation.claimDelay, { minMs: 120, maxMs: 150 });
});
t('升级后删除旧钓鱼控制字段，保留服务器与消息设置', () => {
  assert.ok(!('fishing' in store.defaultConfig()));
  const cfg = store.normalize({ fishing: { managed: true, autoFish: true },
    servers: [{ name: 'saved', host: 'example.test', port: 25565 }],
    automation: { autoClaimRedPackets: false } });
  assert.ok(!('fishing' in cfg));
  assert.strictEqual(cfg.servers[0].host, 'example.test');
  assert.strictEqual(cfg.automation.autoClaimRedPackets, false);
  const p = path.join(mkTmp('removed-control'), 'config.json');
  assert.strictEqual(store.save(p, cfg).ok, true);
  assert.ok(!('fishing' in JSON.parse(fs.readFileSync(p, 'utf8'))));
  assert.ok(!('fishing' in store.load(p, []).cfg));
});

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
process.exit(fail === 0 ? 0 : 1);
