'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { HistoryStore, DAY_MS, RETENTION_DAYS, dayKey } = require('./history_store');

let pass = 0;
function t(name, fn) { fn(); pass++; console.log('  PASS ' + name); }

console.log('\n=== 聊天/日志/缓存归档与 7 天清理 ===\n');
const roots = [];
function tmp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mango-history-')); roots.push(dir); return dir; }
process.on('exit', () => roots.forEach((dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }));

t('创建独立 chat/logs/cache 子目录并批量写入聊天与日志', () => {
  const root = tmp();
  const store = new HistoryStore({ root });
  const now = Date.now();
  store.appendChat({ text: 'hello', type: 'player', sender: 'Tester', t: now });
  store.appendLog('chat', '[Tester] hello', now + 1);
  store.writeCache('diagnostics.json', { ok: true });
  store.flushSync();
  for (const kind of ['chat', 'logs', 'cache']) assert.ok(fs.existsSync(path.join(root, kind)));
  assert.match(fs.readFileSync(path.join(root, 'chat', `${dayKey(now)}.jsonl`), 'utf8'), /hello/);
  assert.ok(fs.existsSync(path.join(root, 'cache', 'diagnostics.json')));
  store.close();
});

t('聊天归档保留受限的点击动作与连接会话，不保存运行时点击 ID', () => {
  const root = tmp(); const store = new HistoryStore({ root }); const now = Date.now();
  store.appendChat({ messageId: 'message-1', session: 'session-1', text: '出售',
    segments: [{ text: '出售', click: { action: 'run_command', command: '/shop buy' } }], t: now });
  store.flushSync();
  const result = store.read('chat', { limit: 1 });
  assert.equal(result.records[0].messageId, 'message-1');
  assert.equal(result.records[0].session, 'session-1');
  assert.deepEqual(result.records[0].segments[0].click, { action: 'run_command', value: '/shop buy' });
  assert.equal('id' in result.records[0].segments[0].click, false);
  store.close();
});

t('读取历史只返回最近一批且不会把全部历史留在内存', () => {
  const root = tmp(); const store = new HistoryStore({ root });
  const base = Date.now();
  for (let i = 0; i < 20; i++) store.appendChat({ text: String(i), t: base + i });
  store.flushSync();
  const result = store.read('chat', { limit: 4 });
  assert.deepStrictEqual(result.records.map((item) => item.text), ['16', '17', '18', '19']);
  assert.equal(result.hasMore, true);
  store.close();
});

t('超过 7 天的归档文件自动删除，7 天内保留', () => {
  const root = tmp(); const now = Date.now(); const store = new HistoryStore({ root, now: () => now });
  const oldFile = path.join(root, 'logs', 'old.jsonl');
  const freshFile = path.join(root, 'logs', 'fresh.jsonl');
  fs.writeFileSync(oldFile, '{}\n'); fs.writeFileSync(freshFile, '{}\n');
  fs.utimesSync(oldFile, new Date(now - (RETENTION_DAYS + 1) * DAY_MS), new Date(now - (RETENTION_DAYS + 1) * DAY_MS));
  fs.utimesSync(freshFile, new Date(now - DAY_MS), new Date(now - DAY_MS));
  store.prune();
  assert.equal(fs.existsSync(oldFile), false);
  assert.equal(fs.existsSync(freshFile), true);
  store.close();
});

console.log(`=== Result: ${pass} passed / 0 failed ===`);
