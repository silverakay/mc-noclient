# 2.4.1

2026-10-08，MC 26.2 / 协议 776。

## 修复：连接正版服被拒 `multiplayer.disconnect.unverified_username`

**症状**：已能连上服务器、完成加密握手、也向 Mojang 登记成功，但服务端反查后仍拒绝，提示 `multiplayer.disconnect.unverified_username`。

**根因**：`src/crypt.js` 的 `computeServerHash` 计算 SHA-1 签名时，只对无符号十六进制结果添加负号，没有按 Java `BigInteger` 的 **160 位二进制补码**转换，也没有正确去掉前导零。

在随机 shared secret 下，约半数结果会算错 —— 这解释了为什么是"概率性"失败，以及为什么 session join 成功并不代表服务端反查也会通过。

**修复**：

```js
BigInt.asIntN(160, BigInt('0x' + digest)).toString(16)
```

**验证**：使用独立固定向量和服务端独立的字节级补码计算，不再复用生产函数作为预期值；512 个独立对照通过。

**限制**：网络故障、服务端反查异常等仍可能造成其他登录失败，不能承诺所有拒绝都由这一问题导致。

## 配套

- 强制资源包不再一律 declined：`src/client.js` 增加 `acknowledgeResourcePack`，在配置和 Play 阶段按顺序回 accepted / successfully_loaded；`src/proto.js` 补齐相应包 ID。这是无界面客户端的协议兼容确认，**没有实际下载、渲染或应用资源包**。
- 点击断开却重连：`app/renderer/renderer.js` 区分 `connected` / `connectionActive` / `connectionBusy`，断开分支先于服务器选择检查；`app/main.js` 增加 `connectionGeneration`，过期回调不再创建或恢复客户端。
- 网络错误不再误报为凭据失效：`src/auth.js` 区分临时网络/超时/429/5xx 与真正的 OAuth 授权失效；仅 `invalid_grant` / `interaction_required` / `login_required` 等明确授权错误才重新授权。

## 产物

- 便携版：`MC免客户端登录器-便携版-2.4.1.exe`（2026-10-08 16:23）
- 安装版：`MC免客户端登录器-安装版-2.4.1.exe`（2026-10-08 16:23）

另有 `dist-disconnect-fix/` 为同期断开修复的验证产物，仅含 2.4.1 版本，不是独立发布。

## 边界

未对目标实服重新验证登录、资源包配置、自然聊天接收和主动断开。离线通过不能替代实服结果。
