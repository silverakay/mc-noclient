# 游戏客户端在线时保留自动领取：可行性

> 本文是开发前的历史取证。2026-10-09 续接轮已实现 2.4.9 软件桥接及 26.2 Fabric Mod，完成离线验证，**仍未安装或实机验证**。当前状态、安装配对与限制以 `CLIENT_BRIDGE_SETUP.md` 为准；下文“尚未实现”描述的是取证当时。

核对日期：2026-10-09。这里只是设计与源码取证，**桥接模式尚未实现或安装**。

## 用户实际目标

用户通过 PCL 启动 Minecraft 并登录同一服务器后，独立登录器会被同账号登录挤下线。
目标不是另开账号或再次登录把游戏挤掉，而是在游戏在线期间继续自动点击红包领取，保留手动指令、聊天监控与日志。

当前软件依赖自己的服务器连接。一旦被挤下线，它不能继续接收这条连接的消息或执行领取。
2.4.8 会在收到明确的 duplicate_login / “你已在异地登录”等原因时停止恢复，避免双方互相挤下线。
没有理由的普通网络断线仍按原策略重连；无法只凭断线推断用户是否登录了游戏。

## 可行路线

在用户实际游戏版本和 Mod 加载器对应的环境中开发一个本地桥接 Mod。
Mod 从游戏的聊天回调读取原始富文本（包含点击命令和来源类型），通过本机通信传给软件。
软件沿用红包识别、去重和领取审计；需要执行时由 Mod 在游戏主线程通过当前连接发送原始命令。
软件只作为控制与日志界面，不进行第二次账号登录。手动指令也走同一游戏连接。

这属于基于接口的可实现方案，不是已完成的兼容性承诺。需确认用户实际 Minecraft 版本、Fabric/Forge/NeoForge 环境与服务器自动化规则，再开发和测试。
原版客户端需要安装对应 Mod 加载器及桥接 Mod；不能宣称现有 EXE 直接调用 PCL 即可实现。

## 已核对的主源证据

GitHub API 读取 Fabric API 的 **26.2 分支**：

- `fabric-message-api-v1/src/client/java/net/fabricmc/fabric/api/client/message/v1/ClientReceiveMessageEvents.java`
  blob `4445befca43ad1d79c8d4a57b27fc74827d96e40`。
  `CHAT` 与 `GAME` 回调分别提供玩家消息与服务器消息，参数保留 `Component`；不是只有渲染后的字符串。
- `fabric-message-api-v1/src/client/java/net/fabricmc/fabric/mixin/client/message/ClientPacketListenerMixin.java`
  blob `4a24de184e59cc978e169a30d9c838ea2f2bb582`。
  明确针对 `ClientPacketListener.sendChat` 与 `sendCommand` 注入事件。
- PCL 启动实现 `Plain Craft Launcher 2/Modules/Minecraft/ModLaunch.vb`
  blob `71bedf71f23f8250b48bed95dbf98b02a6af4f92`，API 由旧 Hex-Dragon/PCL2 重定向到 Meloong-Git/PCL。
  它提供进程启动与启动日志管理，不能据此认定存在供外部程序使用的游戏聊天双向接口。
  本轮没有穷尽所有 PCL 文件，因此“不走 PCL 的接口、直接桥接游戏”是设计选择，不是声称证明 PCL 永远无接口。

复核入口：

`https://api.github.com/repos/FabricMC/fabric-api/contents/fabric-message-api-v1/src/client/java/net/fabricmc/fabric/api/client/message/v1/ClientReceiveMessageEvents.java?ref=26.2`

`https://api.github.com/repos/FabricMC/fabric-api/contents/fabric-message-api-v1/src/client/java/net/fabricmc/fabric/mixin/client/message/ClientPacketListenerMixin.java?ref=26.2`

## 不建议的替代方案

仅读取 `latest.log` 可用于部分聊天文本观察，但普通日志不能保证保存点击命令、原始组件和完整来源信息，也没有发送指令的通道。
仅看到“点击领取”文字不能恢复服务器隐藏的点击动作，所以不能用日志文本猜红包命令。
屏幕识别或模拟鼠标会干扰用户操作，且不能可靠区分动作、会话与重复消息，不作为本项目桥接策略。

## 后续实现边界

- 本地端口只监听回环地址，配随机配对令牌、会话绑定，不对局域网开放。
- 自动动作只接受当前游戏会话内登记的服务器原始点击命令，不能让其他玩家通过聊天文本注入任意命令。
- Mod 与独立客户端使用互斥连接模式；不在游戏接管后继续同账号自动重连。
- 欢迎每日限额、红包去重与日志应在两个模式间共享，不因切换模式重置。
- 游戏断线、切换服务器、Mod 关闭时立即失效动作，不排队在下次会话重放。
- 发送动作和服务器确认仍分开，不能把发出命令当作已到账。

本轮未读取用户游戏配置、未安装 Mod、未操作 PCL、未关闭运行中的应用、未连接目标服。
