'use strict';
/*
 * ui_consistency_test.js —— 界面「三件套」引用一致性检查（静态，不启动 GUI）
 *
 * 为什么需要它：
 *   本机沙箱里 Electron GUI 起不来 / 拿不到 stdout，`--selftest-ui` 会挂住，
 *   于是「renderer.js 引用了一个 HTML 里不存在的 id」这类错误，
 *   要等用户手点才发现（表现为某个按钮点了没反应，且控制台报 null）。
 *
 *   这个测试纯静态解析三个文件，把这类失配在**提交前**就抓出来：
 *     index.html  ←→  renderer.js   （DOM id）
 *     preload.js  ←→  renderer.js   （window.api 方法）
 *     三个文件里用到的 CSS class 是否在 style.css 里定义
 *
 * 它不是 GUI 自检的替代品（不能验证真实渲染），但覆盖了最容易出错的"接线"部分。
 */

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  \x1b[32m[PASS]\x1b[0m ${name}`); pass++; }
  catch (e) { console.log(`  \x1b[31m[FAIL]\x1b[0m ${name}\n         ${e.message}`); fail++; }
}

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'app', 'renderer', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'app', 'renderer', 'style.css'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'app', 'renderer', 'renderer.js'), 'utf8')
  + fs.readFileSync(path.join(ROOT, 'app', 'renderer', 'attention.js'), 'utf8');
const preload = fs.readFileSync(path.join(ROOT, 'app', 'preload.js'), 'utf8');

console.log('\n=== 界面接线一致性（静态检查）===\n');

/* ---------- A. DOM id ---------- */
console.log('[A] renderer.js 引用的 DOM id 都存在于 index.html');

const htmlIds = new Set();
for (const m of html.matchAll(/\bid="([^"]+)"/g)) htmlIds.add(m[1]);

const jsIds = new Set();
for (const m of js.matchAll(/\$\('([^']+)'\)/g)) jsIds.add(m[1]);
// getElementById 也一并收集
for (const m of js.matchAll(/getElementById\('([^']+)'\)/g)) jsIds.add(m[1]);

t(`收集到 ${jsIds.size} 个被引用的 id、${htmlIds.size} 个已定义的 id`, () => {
  if (jsIds.size < 10) throw new Error('引用数量异常少，正则可能没匹配上');
  if (htmlIds.size < 10) throw new Error('定义数量异常少，正则可能没匹配上');
});

t('❗不存在"JS 引用了但 HTML 没有"的 id', () => {
  const missing = [...jsIds].filter((id) => !htmlIds.has(id));
  if (missing.length) {
    throw new Error('以下 id 被 renderer.js 引用但 HTML 里没有：\n         ' +
      missing.join('\n         '));
  }
});

t('❗不存在"HTML 定义了但 JS 从没用"的 id（提示可能有死元素）', () => {
  // 少数 id 是纯 CSS 钩子或运行时动态生成的，允许白名单
  const allow = new Set([
    'toast',          // 由 toast() 动态操作 class，通过 $('toast') 访问过
    'modal-add',      // 同上
    'settings-title', // aria-labelledby target
    'settings-save',  // Native form submit; the handler belongs to settings-form
    'attention-actions-tab', 'attention-messages-tab',
    'attention-actions', 'attention-messages',
    'notify-mentions', 'notify-players', 'notify-connection', 'notify-desktop', 'notify-preview', 'notify-quiet',
  ]);
  const unused = [...htmlIds].filter((id) => !jsIds.has(id) && !allow.has(id));
  if (unused.length) {
    throw new Error('以下 id 在 HTML 里定义了但 JS 从未引用：\n         ' +
      unused.join('\n         '));
  }
});

/* ---------- B. preload ↔ renderer 的 API 接线 ---------- */
console.log('\n[B] renderer.js 用到的 window.api.* 都在 preload 里暴露');

const preloadApis = new Set();
for (const m of preload.matchAll(/^\s{2}([A-Za-z_$][\w$]*)\s*:/gm)) preloadApis.add(m[1]);

const usedApis = new Set();
for (const m of js.matchAll(/window\.api\.([A-Za-z_$][\w$]*)/g)) usedApis.add(m[1]);

t(`preload 暴露 ${preloadApis.size} 个方法、renderer 使用 ${usedApis.size} 个`, () => {
  if (preloadApis.size < 8) throw new Error('preload 方法数量异常少');
  if (usedApis.size < 5) throw new Error('renderer 调用数量异常少');
});

t('❗renderer 调用的每个 api 方法都真实存在', () => {
  const missing = [...usedApis].filter((a) => !preloadApis.has(a));
  if (missing.length) {
    throw new Error('以下方法被 renderer 调用但 preload 没暴露：\n         ' +
      missing.join('\n         '));
  }
});

t('❗preload 没有暴露"没人用"的方法（宽松白名单）', () => {
  const allow = new Set([]);
  const unused = [...preloadApis].filter((a) => !usedApis.has(a) && !allow.has(a));
  if (unused.length) {
    throw new Error('以下方法 preload 暴露了但 renderer 没用：\n         ' +
      unused.join('\n         '));
  }
});

/* ---------- C. 关键 class 在 CSS 里有定义 ---------- */
console.log('\n[C] 动态生成的 class 在 style.css 里都有样式');

const cssClasses = new Set();
for (const m of css.matchAll(/\.([a-z][\w-]*)/gi)) cssClasses.add(m[1]);

/** 从 JS 里挑出"拼进 className / classList"的类名 */
const usedClasses = new Set();
for (const m of js.matchAll(/className\s*=\s*'([^']+)'/g)) {
  for (const c of m[1].split(/\s+/)) if (c && !c.includes('$')) usedClasses.add(c);
}
for (const m of js.matchAll(/classList\.(?:add|toggle|remove)\('([^']+)'/g)) {
  usedClasses.add(m[1]);
}

t(`收集到 ${usedClasses.size} 个动态 class、${cssClasses.size} 个 CSS class`, () => {
  if (usedClasses.size < 5) throw new Error('动态 class 数量异常少');
});

t('❗动态用到的 class 都在 CSS 里定义（否则样式静默失效）', () => {
  // 允许的白名单：语义类，样式由组合选择器给出，或确实无需样式
  const allow = new Set(['hidden', 'log-line']);   // hidden 有全局定义；log-line 是基类
  const missing = [...usedClasses].filter((c) => !cssClasses.has(c) && !allow.has(c));
  if (missing.length) {
    throw new Error('以下 class 被 JS 使用但 CSS 里没有定义：\n         ' +
      missing.join('\n         '));
  }
});

/* ---------- D. 聊天页签的关键不变量 ---------- */
console.log('\n[D] 聊天 / 日志页签结构');

t('HTML 里存在聊天页与日志页两套容器', () => {
  if (!/id="chat-view"/.test(html)) throw new Error('缺 chat-view');
  if (!/id="log-view"/.test(html)) throw new Error('缺 log-view');
  if (!/id="tab-chat"/.test(html)) throw new Error('缺 tab-chat');
  if (!/id="tab-log"/.test(html)) throw new Error('缺 tab-log');
});

t('日志容器初始带 hidden（默认显示聊天页）', () => {
  const m = html.match(/id="log-view"[^>]*class="([^"]*)"|class="([^"]*)"[^>]*id="log-view"/);
  const cls = m ? (m[1] || m[2] || '') : '';
  if (!cls.includes('hidden')) {
    throw new Error('log-view 初始应带 hidden，实际 class=' + JSON.stringify(cls));
  }
});

t('聊天页签初始带 active', () => {
  const m = html.match(/id="tab-chat"[^>]*class="([^"]*)"|class="([^"]*)"[^>]*id="tab-chat"/);
  const cls = m ? (m[1] || m[2] || '') : '';
  if (!cls.includes('active')) {
    throw new Error('tab-chat 初始应带 active，实际 class=' + JSON.stringify(cls));
  }
});

t('❗renderer 启动时会统一页签状态（避免 HTML/JS 两份真相失配）', () => {
  if (!/switchTab\('chat'\)/.test(js)) {
    throw new Error("init 里应调用 switchTab('chat') 统一初始状态");
  }
});

t('聊天容器有 CSS 样式（.chat-view / .chat-line）', () => {
  if (!/\.chat-view/.test(css)) throw new Error('缺 .chat-view 样式');
  if (!/\.chat-line/.test(css)) throw new Error('缺 .chat-line 样式');
});

t('未读气泡 .badge 有样式', () => {
  if (!/\.badge/.test(css)) throw new Error('缺 .badge 样式');
});

/* ---------- E. 安全：renderer 不得直接使用 Node ---------- */
console.log('\n[E] 渲染进程安全性');

t('❗renderer.js 里没有 require(...)（contextIsolation 下不应有 Node 权限）', () => {
  if (/\brequire\s*\(/.test(js)) throw new Error('renderer.js 出现了 require()');
});

t('❗renderer.js 里没有 nodeIntegration 相关的 process/__dirname 直用', () => {
  if (/\bprocess\.(env|argv|execPath)/.test(js)) {
    throw new Error('renderer.js 直接访问了 process.*，应通过 preload 桥接');
  }
});

/* ---------- F. main.js 自检探针引用的 id 也要存在 ---------- */
console.log('\n[F] --selftest-ui 探针引用的 id');

const mainSrc = fs.readFileSync(path.join(ROOT, 'app', 'main.js'), 'utf8');

t('❗探针里列出的每个 id 都在 HTML 中存在', () => {
  // 抓 runUiSelftest 里那个 ids 数组
  const m = mainSrc.match(/const ids\s*=\s*\[([\s\S]*?)\];/);
  if (!m) throw new Error('没找到 --selftest-ui 的 ids 数组，结构可能变了');
  const probeIds = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  if (probeIds.length < 10) throw new Error('探针 id 数量异常少：' + probeIds.length);
  const missing = probeIds.filter((id) => !htmlIds.has(id));
  if (missing.length) {
    throw new Error('探针引用了 HTML 中不存在的 id（会让自检永远失败）：\n         ' +
      missing.join('\n         '));
  }
});

t('探针覆盖了本轮新增的关键节点', () => {
  const m = mainSrc.match(/const ids\s*=\s*\[([\s\S]*?)\];/);
  const probeIds = new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
  for (const must of ['chat-view', 'tab-chat', 'tab-log', 'mon-cpu', 'mon-mem']) {
    if (!probeIds.has(must)) throw new Error('探针缺少关键节点: ' + must);
  }
});

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
process.exit(fail === 0 ? 0 : 1);
