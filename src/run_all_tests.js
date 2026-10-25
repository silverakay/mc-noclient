'use strict';
/*
 * run_all_tests.js —— 一键跑完全部测试套件
 *
 * 用法：node src/run_all_tests.js
 *
 * 包含：
 *   selftest          —— 协议编解码基础自检
 *   crypt_selftest    —— 加密握手自检
 *   cfb8_test         —— AES-128-CFB8 跨运行时兼容层（BoringSSL 无 cfb8）
 *   e2e_premium_test  —— 正版流程端到端（本地假服务端）
 *   audit_test        —— 对抗性审查（协议/压缩/加密边界）
 *   audit_test2       —— 对抗性审查第二轮（认证/数组/流状态）
 *   devicecode_test   —— 微软设备代码流登录
 *   autologin_test    —— 启动自动登录的静默模式（保证不会掉进设备代码流）
 *   chat_test         —— 聊天解析（用真实服务端抓包做回归，防 NBT 根格式漂移）
 *   ui_consistency_test —— 界面接线一致性（DOM id / preload API / CSS class，静态检查）
 *   monitor_test      —— CPU / 内存监控（差分口径 + Electron 进程明细）
 *   configstore_test  —— 配置持久化（路径稳定 / 旧配置迁移 / 写失败可感知）
 *   live_smoke        —— 在线冒烟（仅当设置 MC_LIVE_SMOKE=1 时运行）
 */

const path = require('path');
const { spawnSync } = require('child_process');

const SUITES = [
  ['attention_test.js', 'V6 按服安全配置、精准提醒、摘要、动作轨迹、有界历史与自动已读'],
  ['bridge_exit_test.js', '桥接指定玩家在线下线、能力协商、会话校验与停止重连'],
  ['daily_purchase_background_test.js', '独立连接后台采集、持续菜单刷新、失败不弹窗和手动菜单隔离'],
  ['menu_key_sequence_test.js', 'Shift+F 跨 tick 潜行、延迟菜单派发和中途取消'],
  ['unsigned_build_test.js', '明确标注的未签名测试构建与正式签名隔离'],
  ['daily_purchase_test.js', '每日收购、跨天去重、菜单保护与独立/桥接动作（离线模拟）'],
  ['selftest.js', '协议编解码自检'],
  ['crypt_selftest.js', '加密握手自检'],
  ['cfb8_test.js', 'AES-128-CFB8 跨运行时兼容层'],
  ['e2e_premium_test.js', '正版流程端到端'],
  ['audit_test.js', '对抗性审查（协议/压缩/加密）'],
  ['audit_test2.js', '对抗性审查（认证/数组/流状态）'],
  ['devicecode_test.js', '微软设备代码流登录'],
  ['autologin_test.js', '启动自动登录（静默模式）'],
  ['multi_account_test.js', '多账号缓存与移除（离线模拟）'],
  ['account_isolation_test.js', '账号配置独立存储、双开并发保存与原账号重连锁定'],
  ['chat_test.js', '聊天解析（真实抓包回归）'],
  ['chat_component_test.js', '中文聊天组件与手动点击（离线模拟）'],
  ['chat_monitor_test.js', '独立连接玩家聊天监测判定（离线模拟）'],
  ['chat_filter_test.js', '聊天显示屏蔽规则（离线模拟）'],
  ['red_packet_test.js', '红包自动点击、回执和消息分流（离线模拟）'],
  ['red_packet_batch_test.js', '红包领取广播十秒聚合（离线模拟）'],
  ['red_packet_delay_test.js', '红包随机延迟、取消和手动领取竞态（虚拟时间）'],
  ['red_packet_count_test.js', '红包不同领取人数触发与互斥模式（虚拟时间）'],
  ['welcome_test.js', '每日十次欢迎、持久化限额与安全识别（离线模拟）'],
  ['welcome_delay_test.js', '自动欢迎随机延迟、去重和取消（虚拟时间）'],
  ['release_seed_test.js', '私有发布首次数据导入与隔离（离线夹具）'],
  ['release_version_test.js', '小版本号一致性与正式发布签名要求（静态检查）'],
  ['midnight_command_test.js', '本地午夜自定义命令、跳过错过时刻和每日去重（虚拟时间）'],
  ['client_bridge_test.js', '认证本地桥接、游戏会话、异步发送和互斥登录（离线模拟）'],
  ['bridge_multi_instance_test.js', '双进程桥接端口发现、账号隔离、并行接管与独立停止（本地回环）'],
  ['bridge_handoff_test.js', '桥接下线后独立接管、明确离线证据、原账号锁定与取消（离线模拟）'],
  ['outbound_monitor_test.js', '游戏出站指令脱敏、旧菜单静默与限流（离线模拟）'],
  ['auto_bridge_test.js', '异地登录自动交接、限时检测和停止（离线模拟）'],
  ['receive_diagnostics_test.js', '接收取证与传送回执（独立字节夹具）'],
  ['presence_test.js', '进出服记录持久化与在线时段（离线模拟）'],
  ['server_features_test.js', '玩家列表、只读菜单、补全、就绪与聊天确认（离线模拟）'],
  ['menu_click_test.js', '菜单普通点击、会话失效、重复拦截及权威刷新（离线模拟）'],
  ['ui_consistency_test.js', '界面接线一致性（DOM / API / CSS）'],
  ['connection_ui_test.js', '连接 / 断开按钮行为（离线模拟）'],
  ['renderer_performance_test.js', '页签滚动合并、迟到帧取消和聊天按钮增量状态（离线模拟）'],
  ['connection_lifecycle_test.js', '断开与异步认证取消（离线模拟）'],
  ['window_lifecycle_test.js', '后台托盘、明确退出和改名数据路径（离线模拟）'],
  ['reconnect_test.js', '异常断线自动重连（虚拟时钟与模拟 IPC）'],
  ['monitor_test.js', 'CPU / 内存监控'],
  ['configstore_test.js', '配置持久化（服务器列表保存）'],
  ['history_store_test.js', '聊天、日志与缓存归档及 7 天清理'],
];

// 在线冒烟是可选的（依赖外网，网络抖动会造成假失败）
if (process.env.MC_LIVE_SMOKE === '1') {
  SUITES.push(['live_smoke.js', '在线冒烟（真实微软端点）']);
}

let totalPass = 0, totalFail = 0, failedSuites = [];

for (const [file, label] of SUITES) {
  const full = path.join(__dirname, file);
  process.stdout.write(`\n${'='.repeat(60)}\n${label}  (${file})\n${'='.repeat(60)}\n`);
  const r = spawnSync(process.execPath, [full], { stdio: 'inherit' });
  // 从子进程输出里抓 "=== 结果：N 通过 / M 失败 ===" 不好做（已是 inherit），
  // 所以直接用退出码判断整体成败，并在末尾重跑一次拿数字太浪费 —— 改为让
  // 子进程把结果写进环境不可能，故这里只按退出码汇总。
  if (r.status !== 0) failedSuites.push(label + ' (' + file + ')');
}

console.log(`\n${'='.repeat(60)}`);
if (failedSuites.length === 0) {
  console.log('✅ 全部测试套件通过');
} else {
  console.log('❌ 以下套件未通过：');
  for (const s of failedSuites) console.log('   - ' + s);
}
console.log('='.repeat(60) + '\n');

process.exit(failedSuites.length === 0 ? 0 : 1);
