'use strict';
/*
 * monitor.js —— CPU / 内存占用监控
 *
 * 设计取舍
 * --------
 * 不引入 systeminformation 之类的第三方库：
 *   - 它会带来几十 MB 依赖，且含原生模块，打包后极易出问题；
 *   - 我们其实只需要「本软件自身占用」（用户的原话：「看看这个软件占用了多少」），
 *     Electron 自己的 app.getAppMetrics() 就能给出**按进程拆分**的精确数据，
 *     比 os 层面的整体读数更贴合需求。
 *
 * 双运行环境：
 *   - Electron 主进程：走 app.getAppMetrics()，能看到 Browser / Renderer / GPU /
 *     Utility(网络) 各进程，还能拿到进程级 CPU。
 *   - 纯 Node（自检、CLI）：app 不存在，退化用 process.memoryUsage() + os 采样，
 *     保证同一套代码在两种环境都能跑、都能被测试。
 *
 * CPU 的两种口径：
 *   - 进程 CPU%  = 该进程 CPU 时间增量 / 墙上时间增量 / 核心数 × 100
 *     （与任务管理器一致：满一个核心 ≈ 100%/核心数 ... 这里采用「占整机百分比」口径）
 *   - 系统 CPU%  = os.cpus() 各核 idle/total 的增量算出的整体占用
 */

const os = require('os');

const CLAMP_MIN = 0;
const CLAMP_MAX = 9999;         // 防止时间戳回拨等异常导致天文数字

function clampPct(v) {
  if (!Number.isFinite(v) || v < CLAMP_MIN) return CLAMP_MIN;
  if (v > CLAMP_MAX) return CLAMP_MAX;
  return v;
}

/** 上一次采样快照，用于算增量 */
let _prev = null;
let _peaks = { cpuPct: 0, memPct: 0, memBytes: 0 };

/** 读取系统级 CPU 累计时间（所有核求和） */
function readSystemCpuTimes() {
  let idle = 0, total = 0;
  const cpus = os.cpus() || [];
  for (const c of cpus) {
    const t = c.times || {};
    idle += t.idle || 0;
    total += (t.user || 0) + (t.nice || 0) + (t.sys || 0) + (t.idle || 0) + (t.irq || 0);
  }
  return { idle, total, cores: cpus.length || 1 };
}

/**
 * 采样一次。
 * @param {object} opts
 *   - getAppMetrics: () => Array   Electron 的 app.getAppMetrics 绑定，可为 null
 *   - now: () => number            取时间（毫秒），便于测试注入
 *   - hrtime: () => [sec, ns]      高精度时间，便于测试注入
 * @returns 结构化指标对象
 */
function sample(opts = {}) {
  const now = (opts.now || Date.now)();
  const hr = (opts.hrtime || process.hrtime)();
  const perfNow = hr[0] * 1000 + hr[1] / 1e6;      // 单调毫秒，避免墙钟跳变
  const sys = readSystemCpuTimes();
  const mem = process.memoryUsage();

  // 本进程（主进程 / 纯 Node）自身的累计 CPU 时间，单位微秒
  const selfCpu = process.cpuUsage();

  const cur = {
    perfNow,
    wallNow: now,
    selfCpu,
    sysIdle: sys.idle,
    sysTotal: sys.total,
    cores: sys.cores,
  };

  let selfCpuPct = 0;
  let sysCpuPct = 0;

  if (_prev) {
    const dt = Math.max(1, cur.perfNow - _prev.perfNow);          // 毫秒
    const dSelf = (selfCpu.user - _prev.selfCpu.user) + (selfCpu.system - _prev.selfCpu.system); // 微秒
    // 占整机百分比：微秒→毫秒要先 /1000，再除以 dt 得到「核数」倍数，最后 /cores ×100
    selfCpuPct = clampPct((dSelf / 1000) / dt / cur.cores * 100);

    const dIdle = cur.sysIdle - _prev.sysIdle;
    const dTotal = cur.sysTotal - _prev.sysTotal;
    if (dTotal > 0) sysCpuPct = clampPct((1 - dIdle / dTotal) * 100);
  }

  _prev = cur;

  const totalMem = os.totalmem();
  const freeMem = os.freemem();

  // Electron 细分进程信息
  let processes = null;
  if (typeof opts.getAppMetrics === 'function') {
    try {
      const list = opts.getAppMetrics() || [];
      processes = list.map((m) => {
        const cpu = m.cpu || {};
        // ❗memory 是 metric 的**顶层**字段（与 cpu 平级），不是 cpu.memory。
        //   写错会静默得到 0 字节，界面上表现为"所有子进程内存都是 0"。
        const mi = m.memory || {};
        return {
          pid: m.pid,
          type: m.type,                                   // Browser / Tab / GPU / Utility
          name: m.name || m.serviceName || m.type,
          // Electron 给的是「占总 CPU 百分比」的瞬时值，直接用
          cpu: clampPct(Number.isFinite(cpu.percentCPUUsage) ? cpu.percentCPUUsage : 0),
          mem: (mi.workingSetSize || 0) * 1024,            // KB → B
          kind: m.type === 'Browser' ? '主进程'
              : m.type === 'Tab' ? '界面进程'
              : m.type === 'GPU' ? 'GPU 进程'
              : m.type === 'Utility' ? '工具进程'
              : (m.type || '进程'),
        };
      });
    } catch (e) {
      processes = null;   // 某些 Electron 版本/metrics 不可用时静默降级
    }
  }

  let appMem = mem.rss;
  let appCpu = selfCpuPct;
  if (processes && processes.length) {
    // 应用进程 RSS 之和（≈ 整个软件占用）
    appMem = processes.reduce((s, p) => s + p.mem, 0) || mem.rss;
    appCpu = processes.reduce((s, p) => s + p.cpu, 0);
  }
  const appCpuPct = clampPct(appCpu);
  const appMemPct = totalMem > 0 ? clampPct(appMem / totalMem * 100) : 0;
  _peaks.cpuPct = Math.max(_peaks.cpuPct, appCpuPct);
  _peaks.memPct = Math.max(_peaks.memPct, appMemPct);
  _peaks.memBytes = Math.max(_peaks.memBytes, appMem);

  return {
    t: now,
    app: {
      // 整个软件
      memBytes: appMem,
      cpuPct: appCpuPct,
      memPct: appMemPct,
      peakCpuPct: _peaks.cpuPct,
      peakMemPct: _peaks.memPct,
      peakMemBytes: _peaks.memBytes,
      // 明细
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
      rss: mem.rss,
      // 主进程单独口径（即使有进程明细也保留，便于对照）
      mainMem: mem.rss,
      mainCpuPct: selfCpuPct,
    },
    system: {
      cpuPct: sysCpuPct,
      cores: cur.cores,
      totalMem,
      freeMem,
      usedMem: totalMem - freeMem,
      memPct: totalMem > 0 ? clampPct((1 - freeMem / totalMem) * 100) : 0,
      loadavg: os.loadavg ? os.loadavg() : [0, 0, 0],
    },
    processes,
  };
}

/** 重置内部快照（测试用 / 长时间不用后再采样，防止首次读数虚高） */
function reset({ preservePeaks = false } = {}) {
  _prev = null;
  if (!preservePeaks) _peaks = { cpuPct: 0, memPct: 0, memBytes: 0 };
}

/** 字节 → 人类可读 */
function fmtBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)) + ' ' + u[i];
}

/** 百分比 → 字符串（保留 1 位，极小值显示 0.0） */
function fmtPct(n) {
  if (!Number.isFinite(n)) return '0.0%';
  return n.toFixed(1) + '%';
}

module.exports = { sample, reset, fmtBytes, fmtPct };
