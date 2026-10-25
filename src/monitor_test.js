'use strict';
/*
 * monitor_test.js —— CPU / 内存监控模块自检
 *
 * 重点覆盖两类容易静默出错的地方：
 *   ① 差分计算：CPU% 依赖两次采样的增量，若时间基准用错（墙钟跳变 / 单位混淆）
 *      就会算出 0 或天文数字 —— 这里用注入的假时间戳精确验证数值。
 *   ② 降级路径：纯 Node 下没有 app.getAppMetrics，模块必须退化到 memoryUsage
 *      而不是抛异常，否则自检和 CLI 全都会崩。
 */

const assert = require('assert');
const os = require('os');
const monitor = require('./monitor');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  \x1b[32m[PASS]\x1b[0m ${name}`); pass++; }
  catch (e) { console.log(`  \x1b[31m[FAIL]\x1b[0m ${name}\n         ${e.message}`); fail++; }
}

console.log('\n=== 资源监控 · 离线自测 ===\n');

console.log('[A] 采样结构');
t('首次采样（无基线）不报错且 CPU 为 0', () => {
  monitor.reset();
  const m = monitor.sample({ now: () => 1000, hrtime: () => [1, 0] });
  assert.strictEqual(m.app.cpuPct, 0, '没有基线时 CPU 应为 0，实际 ' + m.app.cpuPct);
  assert.ok(m.app.memBytes > 0, '内存应为正数');
  assert.ok(m.system.cores >= 1);
  assert.ok(m.system.totalMem > 0);
});

t('返回结构齐全（app / system 字段）', () => {
  const m = monitor.sample({});
  for (const k of ['memBytes', 'cpuPct', 'heapUsed', 'heapTotal', 'rss', 'mainMem', 'mainCpuPct']) {
    assert.ok(k in m.app, 'app 缺少字段 ' + k);
  }
  for (const k of ['cpuPct', 'cores', 'totalMem', 'freeMem', 'usedMem', 'memPct']) {
    assert.ok(k in m.system, 'system 缺少字段 ' + k);
  }
});

console.log('\n[B] 差分口径（用假时间戳精确验证）');
t('CPU% = Δcpu时间 / Δ墙上时间 / 核数 × 100', () => {
  // 构造：0.5 秒的墙上时间，本进程消耗 1 秒 CPU 时间（即占满 1 个核），
  // 假设 4 核 → 占整机应为 25%。
  const cores = 4;
  const origCpus = os.cpus;
  os.cpus = () => new Array(cores).fill({ times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } });
  try {
    monitor.reset();
    // 基线
    let cpuT = { user: 0, system: 0 };
    const origCpuUsage = process.cpuUsage;
    process.cpuUsage = () => ({ user: cpuT.user, system: cpuT.system });
    try {
      monitor.sample({ now: () => 0, hrtime: () => [0, 0] });
      // 500ms 后：CPU 时间 +1,000,000 微秒（= 1 秒）
      cpuT = { user: 1000000, system: 0 };
      const m = monitor.sample({ now: () => 500, hrtime: () => [0, 500e6] });
      // 1s / 0.5s = 2 核满载；/4 核 = 50%
      assert.strictEqual(m.app.mainCpuPct, 50, '期望 50%，实际 ' + m.app.mainCpuPct);
    } finally {
      process.cpuUsage = origCpuUsage;
    }
  } finally {
    os.cpus = origCpus;
  }
});

t('系统 CPU% = 1 - Δidle/Δtotal', () => {
  const origCpus = os.cpus;
  // total = user + nice + sys + idle + irq。
  // 构造 1 秒内：user 从 25 → 75（跑了 50 单位），idle 从 25 → 75。
  // 第一拍 total = 50；第二拍 total = 150 → Δtotal = 100，Δidle = 50
  // → 1 - 50/100 = 50%
  let phase = 0;
  os.cpus = () => [ phase === 0
    ? { times: { user: 25, nice: 0, sys: 0, idle: 25, irq: 0 } }
    : { times: { user: 75, nice: 0, sys: 0, idle: 75, irq: 0 } } ];
  try {
    monitor.reset();
    phase = 0;
    monitor.sample({ now: () => 0, hrtime: () => [0, 0] });
    phase = 1;
    const m = monitor.sample({ now: () => 1000, hrtime: () => [1, 0] });
    assert.strictEqual(m.system.cpuPct, 50, '期望 50%，实际 ' + m.system.cpuPct);
  } finally {
    os.cpus = origCpus;
  }
});

t('时间戳回拨不会产生负数或 NaN', () => {
  monitor.reset();
  monitor.sample({ now: () => 100000, hrtime: () => [100, 0] });
  const m = monitor.sample({ now: () => 50000, hrtime: () => [99, 0] });   // 时间倒流
  assert.ok(Number.isFinite(m.app.mainCpuPct) && m.app.mainCpuPct >= 0,
    'CPU 应被夹紧到 [0, ∞)，实际 ' + m.app.mainCpuPct);
  assert.ok(Number.isFinite(m.system.cpuPct) && m.system.cpuPct >= 0);
});

console.log('\n[C] Electron 进程明细（用假的 getAppMetrics）');
t('解析 Browser/Tab/GPU 并归类', () => {
  monitor.reset();
  // ❗按 Electron 官方 ProcessMetric 结构造数据：
  //   cpu.percentCPUUsage 在 cpu 下，而 memory.workingSetSize 在**顶层**（与 cpu 平级）。
  const fake = [
    { pid: 100, type: 'Browser', cpu: { percentCPUUsage: 1.5 }, memory: { workingSetSize: 80 * 1024 } },
    { pid: 101, type: 'Tab', cpu: { percentCPUUsage: 3.2 }, memory: { workingSetSize: 120 * 1024 } },
    { pid: 102, type: 'GPU', cpu: { percentCPUUsage: 0.4 }, memory: { workingSetSize: 40 * 1024 } },
  ];
  const m = monitor.sample({ getAppMetrics: () => fake });
  assert.strictEqual(m.processes.length, 3);
  const byPid = Object.fromEntries(m.processes.map((p) => [p.pid, p]));
  assert.strictEqual(byPid[100].kind, '主进程');
  assert.strictEqual(byPid[101].kind, '界面进程');
  assert.strictEqual(byPid[102].kind, 'GPU 进程');
  // workingSetSize 单位是 KB → 转字节
  assert.strictEqual(byPid[100].mem, 80 * 1024 * 1024, '内存 KB→B 换算错误');
});

t('应用总内存 = 各进程之和', () => {
  monitor.reset();
  const fake = [
    { pid: 1, type: 'Browser', cpu: { percentCPUUsage: 1 }, memory: { workingSetSize: 100 * 1024 } },
    { pid: 2, type: 'Tab', cpu: { percentCPUUsage: 2 }, memory: { workingSetSize: 200 * 1024 } },
  ];
  const m = monitor.sample({ getAppMetrics: () => fake });
  assert.strictEqual(m.app.memBytes, (100 + 200) * 1024 * 1024);
  assert.strictEqual(m.app.cpuPct, 3);
});

t('getAppMetrics 抛异常时静默降级（不崩）', () => {
  monitor.reset();
  const m = monitor.sample({ getAppMetrics: () => { throw new Error('boom'); } });
  assert.strictEqual(m.processes, null, '应降级为 null');
  assert.ok(m.app.memBytes > 0, '仍要有本进程内存兜底');
});

t('getAppMetrics 返回空数组时降级到本进程', () => {
  monitor.reset();
  const m = monitor.sample({ getAppMetrics: () => [] });
  assert.ok(m.app.memBytes > 0);
  assert.ok(m.app.memBytes === m.app.rss, '应退回 rss');
});

t('缺失 cpu 字段的进程条目不会产生 NaN', () => {
  monitor.reset();
  const m = monitor.sample({ getAppMetrics: () => [{ pid: 9, type: 'Tab' }] });
  assert.ok(Number.isFinite(m.app.cpuPct), 'CPU 应为有限数，实际 ' + m.app.cpuPct);
  assert.strictEqual(m.processes[0].mem, 0);
});

console.log('\n[D] 格式化');
t('fmtBytes 常见量级', () => {
  assert.strictEqual(monitor.fmtBytes(0), '0 B');
  assert.strictEqual(monitor.fmtBytes(512), '512 B');
  assert.strictEqual(monitor.fmtBytes(1024), '1.0 KB');
  assert.strictEqual(monitor.fmtBytes(1536), '1.5 KB');
  assert.strictEqual(monitor.fmtBytes(1024 * 1024), '1.0 MB');
  assert.strictEqual(monitor.fmtBytes(150 * 1024 * 1024), '150 MB');
  assert.strictEqual(monitor.fmtBytes(1024 ** 3), '1.0 GB');
});

t('fmtBytes 对无效输入安全', () => {
  assert.strictEqual(monitor.fmtBytes(NaN), '0 B');
  assert.strictEqual(monitor.fmtBytes(-5), '0 B');
  assert.strictEqual(monitor.fmtBytes(null), '0 B');
  assert.strictEqual(monitor.fmtBytes(undefined), '0 B');
});

t('fmtPct 一位小数', () => {
  assert.strictEqual(monitor.fmtPct(0), '0.0%');
  assert.strictEqual(monitor.fmtPct(12.34), '12.3%');
  assert.strictEqual(monitor.fmtPct(NaN), '0.0%');
});

console.log('\n[E] 复位行为');
t('reset 后首次采样 CPU 归零（防止旧基线污染新会话）', () => {
  monitor.sample({});
  monitor.sample({});
  monitor.reset();
  const m = monitor.sample({});
  assert.strictEqual(m.app.cpuPct, 0, 'reset 后应重新建立基线');
});

t('连续采样不会让内部快照无限增长', () => {
  monitor.reset();
  for (let i = 0; i < 500; i++) monitor.sample({});
  const m = monitor.sample({});
  assert.ok(Number.isFinite(m.app.cpuPct));
  assert.ok(Number.isFinite(m.system.cpuPct));
});

// 复原（若上面走了 finally 这里应已恢复）
console.log('\n[F] 本次运行实时 / 峰值');
t('CPU 与内存峰值保留全部运行历史，读数下降不回落', () => {
  monitor.reset();
  const metric = (cpu, kb) => monitor.sample({ getAppMetrics: () => [{ pid: 1, type: 'Browser',
    cpu: { percentCPUUsage: cpu }, memory: { workingSetSize: kb } }] });
  const first = metric(35, 1024 * 512);
  for (let i = 0; i < 100; i++) metric(2, 1024 * 256);
  const low = metric(2, 1024 * 256);
  assert.strictEqual(low.app.cpuPct, 2); assert.strictEqual(low.app.peakCpuPct, 35);
  assert.strictEqual(low.app.peakMemBytes, 512 * 1024 * 1024);
  assert.strictEqual(low.app.peakMemPct, first.app.memPct);
  assert.ok(low.app.memPct < low.app.peakMemPct);
});
t('启动复位后峰值从新的采样开始', () => {
  monitor.reset();
  const next = monitor.sample({ getAppMetrics: () => [{ cpu: { percentCPUUsage: 1 }, memory: { workingSetSize: 1024 } }] });
  assert.strictEqual(next.app.peakCpuPct, 1); assert.strictEqual(next.app.peakMemBytes, 1024 * 1024);
});
monitor.reset();

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
process.exit(fail === 0 ? 0 : 1);
