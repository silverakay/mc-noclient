# 芒果端辅助 3.0.1

发布日期：2026-10-13。

## 修改

- 自动桥接检测窗口从 15 秒延长至 30 秒。超时提示改为“30 秒内未检测到同一账号已进服的本地游戏 Mod；自动桥接已停止，不再独立重连”。
- 保持“同一账号、已进入服务器、客户端加载完成”才接管的安全条件不变。手动启动桥接仍可持续等待。
- 明确每个游戏实例都需要单独放置配对文件：实例目录/config/mc-noclient-bridge.json。只安装桥接 Mod 不会自动生成配对文件。

## 本次排查结论

- E:/minecraft-run/.minecraft/versions/Nan_Koi 已安装桥接 Mod 1.2.0，但缺少 config/mc-noclient-bridge.json，所以 Mod 不会连接桌面桥接端口。
- I:/minecraft-run/.minecraft/versions/26.2-Fabric 0.19.3 存在配对文件，因此 David 客户端可以桥接成功。
- 两个实例可使用同一份软件导出的配对文件，但不能把文件放错到其他实例目录。配对文件包含本地令牌，不要公开。

## 使用

1. 在软件切换“游戏桥接”，点击“导出配对”。
2. 将文件保存为 E:/minecraft-run/.minecraft/versions/Nan_Koi/config/mc-noclient-bridge.json。
3. 退出并重新启动 Nan_Koi，进入服务器后再启动桥接。
4. 使用 dist-3.0.1/芒果端辅助-便携版-3.0.1.exe。

本次没有直接修改 Nan_Koi 游戏目录或读取配对令牌。
