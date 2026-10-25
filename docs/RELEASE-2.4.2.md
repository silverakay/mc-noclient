# 2.4.2

2026-10-08，MC 26.2 / 协议 776。

## 修复：网络 NBT 匿名格式导致聊天全部收不到

**症状**：连上服务器后一条聊天都收不到（`onChat` 回调次数为 0），但网络日志一切正常。

**根因**：`protocol.json` 中聊天字段类型是 **`anonymousNbt`** —— 网络 NBT **没有根名**。而 `src/nbt.js` 的 `readRoot()` 却去读一个根名字，把 `08 00` 当成长度 `0x0800 = 2048` → 越界抛错 → 被 `decodeComponent` 的空 `catch` 吞掉 → 返回 null → 聊天静默消失。

**最难受的地方**：原来的 NBT 测试**自己构造带根名的数据**，于是测试和实现犯了同一个错 —— 测试全绿，真机上所有 NBT 全解不出来。这类"自证式测试"是最危险的。

**修复**：`readRoot()` 不再读根名（网络 NBT 直接就是 `[type][payload]`）。修复后同一条抓包立刻能解析，`onChat` 回调从 0 次变成 4 次，中文与 `extra` 拼接全部正确。

## 顺带修掉的两处聊天缺陷

| 包 | 官方定义 | 旧代码 | 后果 |
|---|---|---|---|
| `player_chat` (0x41) | `signature: option[buffer 256]` | 只读了 bool，**没跳过 256 字节** | 签名存在时正文错位 → 消息丢失 |
| `profileless_chat` (0x21) | 独立包 | **完全没处理** | 控制台 `/say`、NPC、插件广播一条都收不到 |

另外 `loginDisconnect` 的 reason 类型是 **string**（不是 NBT，与 configuration/play 阶段不同），旧代码按 NBT 解析，被拒时看不到原因，已一并修正。

## 配套

- 新增 `src/ui_consistency_test.js`：纯静态解析 renderer / HTML / preload / CSS，抓出"引用了不存在的 id""调用了未暴露的方法""动态 class 未定义"这类接线失配，比 GUI 自检快得多且能在提交前拦住问题。
- 修复配置持久化：配置统一写入用户级固定目录 `app.getPath('userData')`，修复便携版每次运行写到随机 `%TEMP%` 目录导致"添加的服务器重开就消失"；保存改为原子写 + 结果回传，失败不再静默吞掉。

## 产物

- 便携版：`MC免客户端登录器-便携版-2.4.2.exe`（2026-10-08 23:52:05）
- 安装版：`MC免客户端登录器-安装版-2.4.2.exe`（2026-10-08 23:52:11）
- 解包运行目录：`dist/win-unpacked`（须保留整个目录，不能只取内部 exe）

## 验证

- 14 个离线套件全部通过。
- 新增 `src/connection_ui_test.js` 18 项断开按钮行为检查；`src/connection_lifecycle_test.js` 7 项异步认证/DNS/TCP/握手取消检查。
- Playwright 使用本机 Edge 对真实 renderer 做模拟 IPC 测试：connect 1 次、disconnect 1 次、say 0 次，无页面错误。
- 打包完整性与解包版、便携版实际启动均通过。

## 边界

尚未验证 2.4.2 在目标实服的登录、资源包配置、自然聊天接收和主动断开。
