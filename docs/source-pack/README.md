# 芒果端辅助 {{APP_VERSION}} · 源码整合包

Minecraft **26.2（协议 776）** 的免客户端登录器，附带 Fabric 桥接 Mod（{{MOD_VERSION}}）。
不启动游戏也能用正版账号连上服务器；游戏正在运行时，可以改用桥接复用游戏里的连接。

本目录是 {{DATE}} 从原工程抽出的**当前有效源码**：只保留 {{APP_VERSION}} 的实现、配套文档与构建脚本，
去掉了历史发布目录、备份、依赖缓存、测试服务端、内部交接记录。完整操作步骤见同目录的 **使用说明.md**。

> 未签名版本。`build.forceCodeSigning` 保持 `false`，不宣称发布者验证，不安装证书、不改变 Windows 安全策略。

---

## 0. 先弄清三件事

### ① 它是什么、不是什么

| | 说明 |
|---|---|
| 是什么 | 用官方网络协议 + 官方微软 OAuth 实现的**协议客户端**，和真实客户端走同一条路径 |
| 不是什么 | 不注入游戏进程、不读游戏内存、不改游戏文件、不需要开游戏 |
| 代价 | 它不会移动、不会环顾，只回保活包 —— 有经验的管理员一眼能认出是挂机客户端 |

### ② 两种运行模式

| | 独立连接 | 游戏桥接 |
|---|---|---|
| 需要开游戏 | 不需要 | 需要，且已进入服务器 |
| 账号 | 软件内登录微软账号 | 复用游戏的正版连接，软件**不用**再登录 |
| 能做什么 | 聊天、发命令、收服务器消息、自动化 | 同上，且命令由游戏实际发出 |
| 同账号冲突 | 会与游戏互相挤下线 | 不冲突 |
| 适用场景 | 挂机、看聊天、脚本化 | 正常游玩时同时挂辅助 |

> 正在玩游戏时用桥接，不要再用独立模式登录同一账号。
> V6.4 起可在桥接下线成功后自动用同一账号改走独立连接（设置可关），这属于主动切换，不是"两边同时在线"。

### ③ 能连哪些服务器

| 服务器类型 | 能否连接 | 说明 |
|---|---|---|
| 自建 `online-mode=false` | 可以 | 离线模式 |
| 大部分整合包私服 | 可以 | 多为离线模式 |
| 正版验证 `online-mode=true` | 可以 | 登录一次微软账号，之后静默续期 |
| 大型公开服（Hypixel 等） | 能进但别用 | 反作弊会封号，且用的是你自己的真实账号 |

---

## 1. 三分钟跑起来

前置：Windows 10/11、**Node.js ≥ 18**（推荐 20 或 22）。

依赖只有 5 个：运行时 `prismarine-nbt`、`protodef`、`uuid-1345`，开发期 `electron`、`electron-builder`。

```bash
npm install          # 装 Electron、打包工具与 3 个运行时依赖
npm start            # 开发模式启动桌面端
```

`npm install` 要下载约 100 MB 的 Electron。国内网络慢就先设镜像：

```bat
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm install
```

打包成单文件便携版（走 `tools/unsigned_build.js`，固定未签名）：

```bash
npm run dist
```

产物为 `dist\芒果端辅助-未签名便携版-{{APP_VERSION}}.exe`，同目录另有 `win-unpacked\` 目录版。
注意：`win-unpacked` 里的 exe 不能单独拷走，它依赖同目录的 DLL 与资源。

命令行模式（**仅离线模式，不参与正版登录**）：

| 文件 | 作用 |
|---|---|
| `1_打开菜单.bat` | 交互菜单：选服、查状态、登录 |
| `2_直接登录_按config.bat` | 读 `config.json` 直接登录（挂机用） |
| `3_查看所有服状态.bat` | 批量查看在线人数 / 延迟 / MOTD |
| `4_运行自检.bat` | 跑全部离线测试 |

也可以直接调用：`node src/autojoin.js --config config.json`、`node src/autojoin.js --ping`。

---

## 2. 目录结构

```text
芒果端辅助-{{APP_VERSION}}-源码/
├── README.md                  本文件：项目总览 / 构建 / 测试
├── 使用说明.md                 面向使用者的完整操作手册
├── CHANGELOG.md              2.4.1 → {{APP_VERSION}} 版本索引
├── LICENSE                    MIT
├── AGENTS.md                  发布规则（版本号递增、未签名、隐私红线）
├── package.json               版本、依赖、electron-builder 配置
├── package-lock.json          锁定依赖（根版本与应用版本一致）
├── config.json                CLI 用配置（离线模式；桌面端不读这个文件）
├── 1_打开菜单.bat … 4_运行自检.bat
├── app/                       桌面端（Electron）
│   ├── main.js                主进程：窗口 / IPC / 配置 / 自动化编排 / 桥接与接管
│   ├── preload.js             contextBridge 白名单
│   ├── icon.ico
│   └── renderer/              界面
│       ├── index.html         结构（聊天、日志、关注、在线玩家、设置弹窗）
│       ├── style.css          深色科技风
│       ├── renderer.js        界面逻辑
│       └── icons/
├── src/                       协议层与业务模块（Node 运行时 + 3 个 npm 依赖）
│   ├── proto.js               VarInt / 包帧 / 压缩（含边解边处理）
│   ├── nbt.js                 网络 NBT（匿名根节点）
│   ├── crypt.js               RSA / AES-128-CFB8（含手写回退）/ 会话登记
│   ├── auth.js                微软设备代码流 → XBL → XSTS → Minecraft
│   ├── client.js              协议客户端：登录 / 加密 / 配置 / Play / 保活 / 聊天
│   ├── autojoin.js            CLI 主程序（离线模式）
│   ├── status.js              CLI 服务器状态查询
│   ├── configstore.js         配置读写（原子写、旧配置迁移）
│   ├── account_profiles.js    按账号隔离的配置存储
│   ├── server_profiles.js     按服务器隔离的自动化与提醒设置
│   ├── file_lock.js           跨进程读改写锁（双开不互相覆盖）
│   ├── history_store.js       聊天 / 日志 / 缓存归档（7 天与容量上限）
│   ├── presence.js            进出服记录
│   ├── server_features.js     玩家列表 / 只读容器 / 命令补全
│   ├── chat_component.js      富文本与中文语言表
│   ├── chat_actions.js        点击动作注册（会话级）
│   ├── chat_filter.js         聊天显示屏蔽关键词
│   ├── chat_monitor.js        指定玩家发言监测
│   ├── attention.js           关注页：按服提醒、摘要、已读
│   ├── red_packet.js          红包自动领取
│   ├── red_packet_batch.js    领取广播聚合
│   ├── daily_purchase.js      每日收购（菜单按键序列）
│   ├── menu_key_sequence.js   跨 tick 潜行与分阶段按键
│   ├── welcome.js             自动欢迎（每日额度 + 随机延迟）
│   ├── midnight_command.js    零点自定义命令
│   ├── reconnect.js           异常断线重连
│   ├── client_bridge.js       本地桥接服务（回环 + 令牌）
│   ├── bridge_discovery.js    双开实例发现与按游戏账号配对
│   ├── bridge_exit.js         桥接下线：指定玩家在线即退出
│   ├── bridge_handoff.js      桥接下线后独立接管
│   ├── outbound_monitor.js    桥接出站指令脱敏
│   ├── monitor.js             CPU / 内存采样
│   ├── app_identity.js        数据目录（沿用旧名，避免升级丢数据）
│   ├── window_lifecycle.js    托盘与关闭行为
│   ├── release_seed.js        私有含数据包首次导入（源码模式禁用）
│   ├── data/                  protocol-26.2.json、items-26.2.json
│   ├── lang/                  zh_cn.json（26.2 官方语言表）、customcrops_zh_cn.json
│   ├── vendor/                ProtoDef 数据类型 helper
│   └── *_test.js              {{SUITE_COUNT}} 个离线套件（见第 5 节）
├── mods/client-bridge/src/    Fabric 桥接 Mod 源码（Java 25，{{MOD_VERSION}}）
│   ├── main/java/xyz/baixur/mcbridge/
│   └── test/java/…
├── tools/                     构建、打包与自检脚本
├── docs/                      当前仍有效的技术文档与逐版发布说明
└── build/icon.ico             打包图标
```

---

## 3. 一条连接是怎么跑通的

```text
renderer.js ──IPC──> preload.js ──> main.js ──> src/client.js
                                                   │
                                    proto.js（帧/压缩）· nbt.js（聊天）
                                    crypt.js（RSA + CFB8）· auth.js（微软）
                                                   │
                                                 socket
                                                   │
        chat / state / players / observation 事件 <──┘
```

四个阶段，少一步就卡住：

```text
握手 → 登录（离线直通 / 正版走加密握手）→ 配置（Registry / Known Packs / Finish Configuration）→ Play（保活 + 聊天）
```

两点最容易踩：

- **`Set Compression` 与其后的包可能落在同一个 TCP 段**。解码必须"边解边处理"，
  否则后面的包会用旧的 `threshold=-1` 解析成一堆垃圾。
- **Electron 用 BoringSSL，没有 `aes-128-cfb8`**。`src/crypt.js` 内置了手写 CFB8 回退
  （基于 `aes-128-ecb`），所以"系统 Node 全绿、打包后未知加密算法"这个经典坑不会再出现。

正版登录走**设备代码流**，不需要 `redirect_uri`、不占本地端口：申请 8 位短码 → 浏览器打开
`microsoft.com/link` 输入 → 轮询换 token → XBL → XSTS → Minecraft profile。

桥接模式则是本地回环 socket：游戏里的 Mod 把真实连接借给辅助，命令由游戏发出，
所以不会出现同账号互挤。

---

## 4. 桥接 Mod

桌面端 {{APP_VERSION}} 配套 **Mod {{MOD_VERSION}}**。源码在本包 `mods/client-bridge/src/`，
编译脚本 `tools/build_client_bridge.ps1`：

```powershell
.\tools\build_client_bridge.ps1 `
  -InstancePath   '<游戏实例目录>\.minecraft\versions\26.2-Fabric 0.19.3' `
  -JavaHome       '<Java 25 主目录>' `
  -OutputDirectory 'dist-bridge'
```

脚本做的事：读实例 JSON 的 libraries 组 classpath → 解开 Fabric API 内嵌 jar →
`javac --release 25` 编译 → 打 jar → 用**最终 jar** 跑 9 组 Java 检查 → 打印 SHA-256。

前提条件（缺一不可）：

- Minecraft **26.2**，实例 JSON 的 `clientVersion` 必须是 `26.2`；
- **Java 25**（`--release 25`）；
- 实例 `mods` 下**恰好一个** `fabric-api-*+26.2.jar`；
- 官方 26.2 类库已在 `.minecraft\libraries` 里（脚本不联网下载）。

安装与配对（详细步骤见 `使用说明.md`）：

```text
<游戏实例目录>\
  mods\mc-noclient-bridge-{{MOD_VERSION}}+26.2.jar
  config\mc-noclient-bridge.json     ← 软件里「导出配对」得到，不能手改名
```

**只有 JAR 没有配对文件，桥接一定连不上。** 每个游戏实例都要各自放一份。
V6.3 起双开用独立端口 + 按游戏账号配对，V6.3 导出的配对可直接沿用到 {{APP_VERSION}}；
更早的固定端口配对要重新导出。

---

## 5. 测试

```bash
npm install                     # 先装依赖；只跑测试可 npm install --omit=dev，约 20 秒
node src/run_all_tests.js        # {{SUITE_COUNT}} 个离线套件，不联网
```

`--omit=dev` 能跑过 {{SUITE_COUNT}} 中的 46 个；`unsigned_build_test.js` 要检查
`node_modules\electron\dist\electron.exe`，所以必须完整安装。

或双击 `4_运行自检.bat`：先用系统 Node 跑一遍，再找 `dist\` 下打包后的 Electron 跑第二遍
（验证 BoringSSL 下的 CFB8 回退）。没有 dist 时会自动跳过第二遍。

`MC_LIVE_SMOKE=1` 会额外追加一个联网冒烟套件（真实微软端点），默认关闭。

| 类别 | 代表套件 |
|---|---|
| 协议 / 加密 | selftest、crypt_selftest、cfb8_test、audit_test、audit_test2 |
| 认证 | devicecode_test、autologin_test、multi_account_test、account_isolation_test |
| 聊天 | chat_test、chat_component_test、chat_filter_test、chat_monitor_test、attention_test |
| 自动化 | red_packet*、welcome*、midnight_command_test、daily_purchase*、menu_key_sequence_test |
| 连接与桥接 | client_bridge_test、bridge_multi_instance_test、bridge_exit_test、bridge_handoff_test、outbound_monitor_test、auto_bridge_test、reconnect_test |
| 界面接线 | ui_consistency_test、connection_ui_test、connection_lifecycle_test、renderer_performance_test、window_lifecycle_test |
| 存储 | configstore_test、history_store_test、presence_test |
| 发布约束 | release_version_test、release_seed_test、unsigned_build_test |

打包后自检：

```bash
node tools/package_smoke.js dist-{{APP_VERSION}}-unsigned --unsigned
```

检查运行库与包内源码一致、应用/锁文件/可见版本一致，并分别以隔离数据目录启动目录版与便携版。

`tools/v6_ui_smoke.js`、`tools/chat_ui_smoke.js`、`tools/tab_performance_test.js` 是界面冒烟脚本，
需要额外安装 `playwright`，不是源码运行的必需项。

---

## 6. 数据、凭据与隐私

| 路径 | 内容 | 敏感度 |
|---|---|---|
| `%APPDATA%\MC免客户端登录器\config.json` | 服务器列表、界面设置 | 中（含服务器地址） |
| `…\profiles\` | 按账号、按服务器的设置 | 中 |
| `…\records\chat\|logs\|cache\` | 聊天与日志归档，7 天 / 容量上限 | **高（聊天原文）** |
| `…\bridge-pairing.json` | 桥接本地令牌 | **高** |
| `…\presence.jsonl` | 进出服记录 | 中 |
| `%APPDATA%\.mc-noclient\accounts.json` | 微软 refresh_token | **极高，等同账号登录权限** |

数据目录名沿用 `MC免客户端登录器`（不是产品名"芒果端辅助"），这是**故意的**：
改名会让老用户升级后丢失账号、服务器与配对。

打包与分享前的硬性规则：

- `release-data/`、`accounts.json`、`bridge-pairing.json` 一律不进仓库、不进压缩包。
- 本包已按此规则裁剪，**不含任何个人数据**；`config.json` 只留本机测试服占位。
- 默认监测名单里保留了 `Nan_Koi`（旧配置的兼容默认值，可在设置或配置中改），
  对外发布前想清掉就改 `src/configstore.js` 与 `app/renderer/renderer.js` 的默认值。
- `app/main.js` 注释里留有历史事故的服务器域名，公开发布前可一并清理（不影响功能）。

重新打这个包：`python tools/pack_source.py`，它会按同一套包含/剔除规则重建目录与 zip。

---

## 7. 这个整合包做了什么取舍

**保留**：`app/`、`src/`（含语言表、协议 JSON、vendor）、`mods/client-bridge/src/`、`tools/`、
四个 bat、`config.json`、`package.json`、`package-lock.json`、`build/icon.ico`、`AGENTS.md`，
以及 `docs/` 下当前仍有效的技术文档与逐版发布说明。

**剔除**：

| 剔除项 | 原因 |
|---|---|
| `dist/`、`dist-3.0.0` … `dist-6.4.0-unsigned` 等全部发布目录 | 发布产物，每个约 68 MB，且与源码版本混杂 |
| `backups/`（700+ 个文件） | 历史快照 |
| `node_modules/`（7000+ 文件） | `npm install` 可重建 |
| `testserver/`、`mods/*.jar`、`mods/client-bridge/build/` | 本地测试服务端与编译中间产物，非源码 |
| `logs/`、`*.png`、`ui_selftest.json` | 运行产物 |
| `release-data/` | **含真实账号与配对凭据** |
| `HANDOFF.md`、`HANDOFF-NEXT.md`、`docs/HANDOFF-HISTORY-*` | 内部交接记忆，含账号名/服务器/流程 |
| `src/_*_tmp_*.js` | 编辑残留的临时文件 |
| 根目录 `README.md` | 已改写为 `docs/项目完整说明.md`，根目录放本文件作入口 |

`src/data/protocol-26.2.json` 与 `docs/protocol-26.2.json` 内容相同、各留一份：
前者是运行时读取的副本，后者供 `src/data/SOURCE.md` 溯源引用。

`tools/with_data_build.js` 与 `tools/reset_local_data.ps1` 保留了，它们是发布与清库流程的一部分：
前者只有在自备 `release-data/` 时才会产出含数据包，普通 `npm run dist` 不会带上它。

---

## 8. 已知限制（不要当成已解决）

- 独立连接**不模拟移动**，任何有经验的管理员都能看出是挂机客户端。
- 目标服的普通玩家聊天曾出现 `player/profileless 0` 接收，**根因未确诊**；
  系统消息与插件广播正常。取证结论见 `docs/CHAT_DIAGNOSIS.md`，不要把它当作已修复。
- 桥接 Mod 的实机 Mixin 加载与配对仍需在真实实例上验收；本轮源码检查不启动 Minecraft。
- 桥接下线后的独立接管依赖 Mod 上报的**真实离线证据**。游戏崩溃或直接断线没有离线报告时，
  软件不会猜状态、也不会自动登录。
- 只适配 **MC 26.2 / 协议 776**。换版本要改 `src/proto.js` 的 `PROTOCOL_VERSION` 与包 ID 表，
  包 ID 可从 `minecraft-data` 对应分支的 `protocol.json` 提取。
- CLI（`autojoin.js`）只支持离线模式，正版登录只在桌面端可用。
- 未签名：Windows SmartScreen 可能提示未知发布者，这是预期行为，不要靠关闭系统防护绕过。
- 机械 UI 检查仍报告既有的低对比度、小字号、发光阴影，未做全局无障碍修复。
- `docs/CLIENT_BRIDGE_SETUP.md` 部分章节写于 2.4.9，操作以 `使用说明.md` 为准。

---

## 9. 合规

技术上它是合法的协议客户端，但**服务器管理员看得见你**，服务端日志会如实记录上线。

1. 只在自己有权限的服务器上用（自建服 / 局域网 / 朋友私服）。
2. 挂机前先跟服主说一声。
3. 不要在公开服务器上用 —— 可能违反服务条款被封禁。
4. 正版模式下所有行为都记在你自己的账号头上，没有"小号背锅"。

---

## 10. 许可

MIT，见 `LICENSE`。
