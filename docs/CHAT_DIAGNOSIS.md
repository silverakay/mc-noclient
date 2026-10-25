# 玩家聊天缺失：已知事实与取证边界

更新时间：2026-10-09，版本 2.4.7。新增协议兼容流程的离线验证不代表目标服聊天已恢复，见文末实现记录。

## 13:10 后台复核：不是 ESC 停止任务

用户明确：ESC 只停止界面操作，任务继续；用户正在使用电脑，若必须操作界面需提前说明。
本轮后台排查未切换窗口、移动鼠标、发送键盘输入、重启应用或连接目标服务器。
运行中的便携版主进程仍是 12:47:37 启动的 PID 24724，没有被测试替换。

此前从用户运行日志窗口读到的这一次会话计数为：

| 路径 | 收到包 | 正文输出 | 解析失败 |
| --- | ---: | ---: | ---: |
| 玩家 | 0 | 0 | 0 |
| 系统 | 114 | 114 | 0 |
| 无档案 | 0 | 0 | 0 |
| 快捷栏 | 10 | 0 | 0 |

传送包/回执 1/1，正文回退 0，坐标已是正常数值，不是旧版的负零。
这些是当时的窗口快照，不是本轮新采集的完整聊天或实时最新计数。
当前会话仍在线，应用只在断开时保存 `chat-diagnostics-last.json`，所以文件尚不存在。
没有为了生成文件强制断开，也没有从进程内存提取账号或数据。

### 新增独立证据

`tools/official_chat_codec_check.js` 使用本机已下载的官方 26.2 server jar 与自带依赖：

- `javap` 读取 `GameProtocols` 实际注册顺序，确认 player_chat=0x41、system_chat=0x79、disguised_chat=0x21、player_position=0x48。
  这一步没有使用项目的 protocol.json 作为正确性来源。
- 将生产 `sendClientSettings()` 的字节交给官方 `ClientInformation` 构造器解码，实际得到 FULL、zh_cn、文本过滤关闭，且没有剩余字节。
- 官方 `ClientboundPlayerChatPacket.STREAM_CODEC` 生成无签名、带签名字段、修饰正文、内联聊天类型四种完整负载，交给生产接收器。
  四种均得到发送者和预期正文，接收/输出 1/1、解析失败 0、正文回退 0。
  签名内容是合成字段测试值，不是有效账号签名；这不是目标服真实玩家发言，也不验证密码学签名。
- 官方 `ServerPlayer.sendChatMessage` / `acceptsChatMessages` 的发送门槛是 FULL；
  `ServerGamePacketListenerImpl.sendPlayerChatMessage` 没有接收者必须先提供聊天公钥的判断。
  未回聊天 ACK 会在累计过多待确认签名消息后踢出，不解释这次从第一条开始接收为零。
  目标服插件/代理可能有自己的限制，不能套用原版代码断言它们没有限制。

执行：`node tools/official_chat_codec_check.js`。默认读取本机 Minecraft 的 java-runtime-epsilon；可用 `MC_JAVA_BIN` 指向另一个兼容 Java bin 目录。
Java 程序只调用编解码器和注册表初始化，不调用服务端 main、不打开游戏窗口、不使用凭据、不建 Minecraft 连接。
初始化日志位于独立系统临时目录，不覆盖 testserver 世界、日志或真实应用数据。
本轮官方交叉核对全部通过，另重新运行现有 19 个离线套件，全部通过；测试进程已退出。

目前更准确的结论：已排除上述标准协议编号、设置字节和四种常见负载格式错误。
标准 player 路径接收为零，继续反复改正文解析器不能为这一会话产生从未到达该路径的消息。
仍需同一时间确有自然玩家发言的对照，以及该会话的其他包/消息证据，才能区分服务器不转发、插件改用其他路径、或下层收包问题。
不能据此声称核心根因已确定；本轮不发新的“聊天已修复”安装包，版本和现有便携包保持 2.4.6。

### “无档案消息”的含义

这是协议中的 disguised/profileless 聊天包，不带标准玩家聊天中的 UUID 和签名链档案，而带显示名、正文、聊天类型等信息。
它不是“没有微软账号”“没买正版”或“账号档案损坏”。服务端命令、NPC 和插件可能使用它，也可能把玩家发言改写为这类包。
因此“系统/无档案”是传输来源分类，不保证内容没有玩家发言。

## 开源实现交叉比较（2026-10-09）

用户问“是否没有办法、其他软件/版本能否借鉴”。结论不是无解：有现成实现可供比较，
但没有查到针对这个目标服务器与这次会话的已验证通用补丁。
本轮网络访问仅为读取公开 GitHub 源码与 issue；未建目标 Minecraft 连接，未操作用户界面。

### 固定核对来源

通过 GitHub Contents / Git Blob API 读取项目自身源码，避免把第三方摘要当作协议依据。
以下 SHA 是文件 blob，不是 release/commit；核对的是读取时 master 分支，不保证相同功能已进入发布版。

- MCC：`MCCTeam/Minecraft-Console-Client`，`MinecraftClient/Protocol/Handlers/Protocol18.cs`，blob `e0508513b75b8f911582390ad2173e57b917bb44`。
  86-87 行定义 26.1=775 / 26.2=776；1003-1004 行在 JoinGame 处理后发送 PlayerLoaded。
  1348-1361 行处理 ProfilelessChatMessage；4979-4984、5014-5020 行累积确认并发送消息 ACK；
  5366-5374 行发送客户端 brand；6618-6639 行在有有效 key pair 且 online mode 时发送玩家聊天会话。
- node-minecraft-protocol：`PrismarineJS/node-minecraft-protocol`，`src/client/chat.js`，blob `e23f25fccbb4e1f70959dbc63948c658ef28ef62`。
  143-151 行把 profileless 聊天作为未验证 playerChat 事件输出，162-166 行输出 systemChat；
  195-209 行输出玩家正文与 verified 标记，227-232 行处理累积消息确认。
- 同项目 `src/client/play.js`，blob `221f14c4a0addcac7bae8f61f67d2e12e9f0fcbd`。
  14-28 行在满足 profileKeys / encrypted session 条件后上传聊天会话；
  55-74 行配置阶段发送 settings，83-85 行完成配置状态切换。
- 同项目 `src/client/pluginChannels.js`，blob `671eb452f31e6b5fcd57d715f1009d010160c65f`：
  保留 custom_payload 的通道分发和按注册 parser 解码，不把未知负载猜成聊天文本。
- 同项目 `src/version.js`，blob `3aff3da9243fc5a52a9a58bf9c756eacdaf78ed3`：
  读取时 defaultVersion 是 26.1，supportedVersions 列表最后为 26.1，未列 26.2。
  所以不能声称这一读取版本已支持 26.2，也不能不经适配就替换本项目协议层。
- Mineflayer：`PrismarineJS/mineflayer`，`lib/plugins/game.js`，blob `a6ef6935ba085f58e7428db7f5050d54c2839167`。
  92-98 行注册 brand 通道并载入配置 registry，100-115 行在 login 后发送客户端 brand。

复核入口（URL 仅用于源码追溯）：
`https://api.github.com/repos/MCCTeam/Minecraft-Console-Client/git/blobs/e0508513b75b8f911582390ad2173e57b917bb44`
`https://api.github.com/repos/PrismarineJS/node-minecraft-protocol/git/blobs/e23f25fccbb4e1f70959dbc63948c658ef28ef62`
`https://api.github.com/repos/PrismarineJS/node-minecraft-protocol/git/blobs/221f14c4a0addcac7bae8f61f67d2e12e9f0fcbd`
`https://api.github.com/repos/PrismarineJS/node-minecraft-protocol/git/blobs/3aff3da9243fc5a52a9a58bf9c756eacdaf78ed3`

### 可推进的路径与不能承诺的事

| 差异 | 本项目当前情况 | 能解决什么 / 取证限制 |
| --- | --- | --- |
| PlayerLoaded 入服/重生回执 | 未实现 | 可补齐入服就绪流程；原版聊天发送门槛不直接依赖它，目标插件是否依赖未知 |
| brand 与插件通道分发 | 配置 payload 只读通道名后忽略，Play payload 无专门分发 | 可识别服务端品牌和实际扩展通道；没有通道格式证据前不能猜读其正文或冒充原版客户端 |
| 聊天会话/安全档案 | 未获取/上报有效 profile key | 可兼容需要安全档案的服务端；需真实证书与会话时序，不能伪造；未证明与零接收有关 |
| 消息 ACK 与 last-seen 状态 | 未实现 | 能处理实际收到签名消息后的累计确认；不是第一条消息接收为零的已证实修复点 |
| profileless 显示分类 | 输出为 system，保留发送者/正文 | 和某些库的 playerChat 事件命名不同；调整分类不等于新增接收，这次该路径也为零 |

优先路线是按 26.2 对齐入服就绪/插件通道流程，并让诊断能在连接期间保存，
然后在用户正常使用的一次自然会话里比较真实消息通道；不反复试登、不发测试消息。
若继续保留手写协议层带来过高维护成本，可评估引入经过 26.2 适配的成熟引擎，保留现有界面/红包/在线记录。
这次用户是在询问可行性，本轮只研究和记录，不擅自换引擎、增添真实账号证书请求或发布“已经修复”版本。

## 不能再混淆的验收结论

目标服务器的玩家聊天缺失尚未确诊，也尚未实服验证恢复。
`dist/live-receive-2.4.5.json` 记录了 2026-10-09 11:11:16 至 11:13:26 的唯一被动连接：
成功进服、自然收到 5 条系统通知、聊天发送 0 次、业务指令 0 次。
报告没有记录原始 player_chat 包是否到达。因此它只证明系统通知链路可用，不能证明玩家聊天链路可用。

用户 11:25 至 11:27 的样本也是签到和进出服通知，没有玩家发言样本。
此前本地抓包回归主要来自服务端 say/tellraw；带签名玩家包是离线构造夹具，不是该目标服的真实玩家包。
把这些测试通过说成“目标服玩家聊天已经修复”属于验收结论过早。

## 本轮实际确认并修正的错误

- 同步坐标负载应为 teleportId(varint)、三个坐标、三个速度分量、yaw/pitch、flags(u32)。
  旧实现从 flags 开始读，少读一个速度分量，并从包尾猜测 teleportId，可能回错传送确认。
  已按项目固定 26.2 协议定义修正，多字节 ID、相对坐标和相对旋转以独立 Buffer 编码夹具验证。
- start_configuration 之前没有发 configuration_acknowledged，已补上 Play 上行 0x10 空包回执。

这些都是可复现的协议错误，但没有目标服的对照证据证明它们就是聊天缺失的直接原因。
本机原版 26.2 server.jar 的 ServerPlayer.acceptsChatMessages 检查的是聊天可见性 FULL；
不能声称原版会因为传送尚未确认而直接禁止所有入站玩家聊天。
当前客户端上报的 chatMode 是 0（全部），显示层默认选择全部消息，不因未验证聊天签名而主动丢弃正文。

## 新的接收诊断

运行日志顶部显示四条接收路径：玩家聊天、系统消息、无档案消息、快捷栏。
每条路径记录收到包数、正文输出数和解析失败数。可选尾字段失败但正文可用另外计为“正文回退”。
同时记录所有 Play 包 ID 的频次、坐标包和回执数量；不保存原始加密流、签名、令牌或聊天正文到诊断。
主动或意外断开后，最近一次快照写入应用数据目录 `chat-diagnostics-last.json`。

- player.received > 0 且 errors > 0：确有玩家包进入解析器，再根据错误和实际版本定位字段问题。
- player.received > 0 且 emitted > 0：正文已输出，接下来查显示开关、类别过滤和实际 IPC 接收。
- player.received = 0：这一连接期间没有进入该路径的标准玩家包；不能仅凭零值断言服务器无人说话。
  插件可能将玩家发言重写为 system/profileless 包，扩展通道也不能凭计数猜解。

不要通过猜测指令、发送测试聊天或短时间重复连接来补证据。
本轮未再次连接 mc.example.invalid，也未发送任何实服消息或命令。

## 在线记录边界

只从新版本实际收到的完整 `[+] 玩家名` / `[-] 玩家名` 服务器通知记账。
原文、接收时间、服务器和本次观察会话写入 `presence.jsonl`，与聊天界面 800 行限制无关。
隐藏、清空聊天、关闭聊天显示不会清除这些持久化记录。
玩家查询只读本地文件，不触发状态查询、登录、聊天或命令。

只累计同一次连续观察内的上线到下线区间。首次看到下线、未看到下线、监控中断、软件崩溃的区间均标记时间未知。
记录的是基于通知的观察时间，不是服务器权威总在线时长；不能补回旧版未保存的历史或软件未连接期间的活动。
界面展示最近 200 个区间，累计值仍覆盖全部记录，原始文件不按此上限删除。
# 2.4.7 Implementation Update (2026-10-09)

This version adds PlayerLoaded after the first valid position acknowledgement,
signed-message ACK offsets, duplicate-signature handling, and the last-seen
window for manual unsigned chat. The local official 26.2 validator accepts the
ACK/window fixtures, including consecutive duplicate signatures. It does not
upload a profile public key or claim account-signed chat support.

Custom payloads in configuration/play now record channel metadata (counts,
lengths and brand), never raw private payload or credentials. Diagnostics are
atomically saved every 10 seconds while connected and again at disconnect.
Unknown plugin channel schemas are not decoded by guessing their content.

No target connection or business test command was made for these changes.
These protocol improvements are **not** proof that the missing target-server
player chat is fixed, nor evidence that any one omitted handshake was its cause.
The earlier evidence and limitations below remain applicable.
