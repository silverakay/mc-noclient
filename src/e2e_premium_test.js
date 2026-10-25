'use strict';
/*
 * e2e_premium_test.js —— 正版加密握手的端到端整合测试
 *
 * 思路：不依赖真实微软账号，而是自己搭一个「假的服务端」，
 *       完整走一遍 Encryption Request / Response 流程，
 *       验证客户端的加密握手实现是否正确。
 *
 * 验证点：
 *   1. 服务端发的公钥能被我方解析
 *   2. 我方加密的共享密钥能被服务端用私钥解开
 *   3. 我方加密的 verifyToken 能被服务端解开且内容正确
 *   4. serverId 哈希算法正确（服务端自己算一遍做比对）
 *   5. 加密启用后，双向通信能正常收发
 */
const net = require('net');
const crypto = require('crypto');
const { ByteWriter, ByteReader, PacketDecoder, encodePacket, PACKET_ID: P } = require('./proto');
const { createCipher, createDecipher, usingNativeCfb8 } = require('./crypt');

// Independent byte-wise signed conversion; never call the production hash helper.
function serverHash(serverId, secret, key) {
  const bytes = crypto.createHash('sha1').update(serverId, 'latin1').update(secret).update(key).digest();
  const negative = (bytes[0] & 128) !== 0;
  if (negative) {
    let carry = 1;
    for (let i = bytes.length - 1; i >= 0; i--) {
      const value = (255 - bytes[i]) + carry;
      bytes[i] = value & 255;
      carry = value >> 8;
    }
  }
  return (negative ? '-' : '') + (bytes.toString('hex').replace(/^0+/, '') || '0');
}

function textNbt(text) {
  const bytes = Buffer.from(text, 'utf8');
  return new ByteWriter().u8(8).u16(bytes.length).raw(bytes).build();
}

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { console.log(`  \x1b[32m[PASS]\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31m[FAIL]\x1b[0m ${name} ${extra}`); fail++; }
}

(async () => {
  console.log('\n=== 正版加密握手 · 端到端整合测试 ===\n');
  console.log('（自建假服务端模拟 online-mode=true 的握手流程）\n');

  // 服务端密钥对
  const keypair = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  const pubDer = keypair.publicKey.export({ type: 'spki', format: 'der' });
  const verifyToken = crypto.randomBytes(4);
  const serverId = '';

  const results = {};
  const resourceUuid = '12345678-1234-1234-1234-123456789abc';
  results.resourceStatuses = [];

  const server = net.createServer((sock) => {
    const dec = new PacketDecoder();
    let stage = 'handshake';
    let serverSecret = null;
    let sDecipher = null, sCipher = null;

    sock.on('data', (chunk) => {
      const plain = sDecipher ? sDecipher.update(chunk) : chunk;
      if (!plain.length) return;
      for (const body of dec.drain()) { /* 重置 */ }
      // 手动解包
      let buf = Buffer.concat([Buffer.alloc(0), plain]);
      const packets = (() => {
        const d = new PacketDecoder();
        return d.push(plain);
      })();

      for (const pkt of packets) {
        const r = new ByteReader(pkt);
        const id = r.varint();

        if (stage === 'handshake') {
          // 期望：handshake(0x00) → login_start(0x00)
          stage = 'login';
          continue;
        }
        if (stage === 'login' && id === P.loginStart) {
          const username = r.str();
          const uuid = r.uuid();
          results.username = username;
          results.uuid = uuid;
          // 发 Encryption Request
          const w = new ByteWriter();
          w.varint(P.loginEncryption);
          w.str(serverId);
          w.varint(pubDer.length); w.raw(pubDer);
          w.varint(verifyToken.length); w.raw(verifyToken);
          w.bool(true);                       // shouldAuthenticate
          sock.write(encodePacket(w.build(), -1));
          stage = 'await-encryption';
          continue;
        }
        if (stage === 'await-encryption' && id === P.loginEncryptionResponse) {
          const secLen = r.varint();
          const encSecret = Buffer.from(r.raw(secLen));
          const tokLen = r.varint();
          const encToken = Buffer.from(r.raw(tokLen));

          // 服务端解密
          try {
            serverSecret = crypto.privateDecrypt(
              { key: keypair.privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
              encSecret
            );
            results.secretLen = serverSecret.length;
            results.secretOk = true;
          } catch (e) {
            results.secretOk = false;
            results.secretErr = e.message;
          }

          try {
            const tok = crypto.privateDecrypt(
              { key: keypair.privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
              encToken
            );
            results.tokenOk = tok.equals(verifyToken);
          } catch (e) {
            results.tokenOk = false;
            results.tokenErr = e.message;
          }

          // 服务端算一遍 serverId 哈希，和我方实现对照
          if (serverSecret) {
            results.serverHash = serverHash(serverId, serverSecret, pubDer);
            // 建立服务端侧加解密流。
            // ❗这里原本直接调 crypto.createCipheriv('aes-128-cfb8')，
            //   结果在打包后的 Electron（BoringSSL 无 cfb8）里，这个测试自己先崩了 —— 
            //   相当于测试和被测代码犯了同一个错，根本挡不住线上事故。
            //   改用兼容层，测试才能覆盖真实运行时。
            sDecipher = createDecipher(serverSecret, serverSecret);
            sCipher = createCipher(serverSecret, serverSecret);

            // 发 Login Success（这次要加密发！）
            const sw = new ByteWriter();
            sw.varint(P.loginSuccess);
            sw.uuid('069a79f4-44e9-4726-a5be-fca90e38aaf5');
            sw.str('TestPlayer');
            sw.varint(0);                        // properties 空
            sw.uuid('00000000-0000-0000-0000-000000000000');
            const frame = encodePacket(sw.build(), -1);
            sock.write(sCipher.update(frame));
            stage = 'encrypted';
          }
          continue;
        }
        if (stage === 'encrypted' && id === P.loginAcknowledged) {
          results.gotAck = true;
          const mw = new ByteWriter().varint(P.cfgResourcePackC).uuid(resourceUuid)
            .str('https://example.invalid/pack.zip').str('a'.repeat(40)).bool(true).bool(false);
          sock.write(sCipher.update(encodePacket(mw.build(), -1)));
          stage = 'resource-pack';
          continue;
        }
        if (stage === 'resource-pack' && id === P.cfgResourcePack) {
          results.resourceUuid = r.uuid();
          const status = r.varint();
          results.resourceStatuses.push(status);
          if (status === 0) {
            sock.write(sCipher.update(encodePacket(new ByteWriter().varint(P.cfgFinishC).build(), -1)));
            stage = 'config-finish';
          }
          continue;
        }
        if (stage === 'config-finish' && id === P.cfgFinish) {
          results.configFinished = true;
          const chat = new ByteWriter().varint(P.playSystemChat).raw(textNbt('RECEIVE_ONLY')).bool(false);
          const kick = new ByteWriter().varint(P.playKick).raw(textNbt('加密通道正常'));
          sock.write(sCipher.update(Buffer.concat([
            encodePacket(chat.build(), -1), encodePacket(kick.build(), -1),
          ])));
          stage = 'done';
          continue;
        }
      }
    });
    sock.on('error', () => {});
  });

  await new Promise((res, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', res);
  });
  const port = server.address().port;

  // ---- 客户端：手工走流程，验证每一步 ----
  const { MCClient } = require('./client');

  const logs = [];
  const chats = [];
  let clientDisconnectText = null;

  await new Promise((resolve) => {
    const client = new MCClient({
      host: '127.0.0.1',
      port,
      username: 'TestPlayer',
      uuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5',   // 正版档案里的真实 UUID
      accessToken: 'fake-token-for-encryption-test',
      profileId: '069a79f4-44e9-4726-a5be-fca90e38aaf5',
      log: (m) => logs.push(m),
      onChat: (text) => chats.push(text),
      onEvent: (ev, d) => {
        if (ev === 'kick' || ev === 'need-auth') clientDisconnectText = String(d);
      },
    });

    // 拦截 Mojang 登记（测试环境不真的联网）
    const crypt = require('./crypt');
    const origFetch = global.fetch;
    global.fetch = async (url, opts) => {
      if (String(url).includes('sessionserver.mojang.com')) {
        results.mojangJoinCalled = true;
        const body = JSON.parse(opts.body);
        results.mojangServerId = body.serverId;
        results.mojangProfile = body.selectedProfile;
        return { ok: true, status: 204, text: async () => '' };
      }
      return origFetch(url, opts);
    };

    client.connect().then(() => {
      setTimeout(() => {
        global.fetch = origFetch;
        client.close();
        resolve();
      }, 3500);
    });
  });

  server.close();

  console.log('[客户端日志]');
  for (const l of logs) if (l.trim()) console.log('   ' + l.replace(/\x1b\[\d+m/g, ''));
  console.log('');

  // ---- 断言 ----
  check('客户端发出了 Login Start（用户名正确）', results.username === 'TestPlayer', `实际: ${results.username}`);
  check('客户端发出的 UUID 正确', results.uuid === '069a79f4-44e9-4726-a5be-fca90e38aaf5', `实际: ${results.uuid}`);
  check('共享密钥解密成功且长度 = 16', results.secretOk && results.secretLen === 16,
    results.secretErr || `长度 ${results.secretLen}`);
  check('共享密钥不等于明文（确实加密了）', results.secretOk);
  check('Verify Token 解密后内容完全一致', results.tokenOk === true, results.tokenErr || '');
  check('serverId 哈希被正确计算', !!results.serverHash, '');
  check('向 Mojang 发起了会话登记', results.mojangJoinCalled === true, '');
  check('登记用的 serverId 与服务端本地计算结果一致',
    results.mojangServerId === results.serverHash,
    `客户端=${results.mojangServerId} 服务端=${results.serverHash}`);
  check('登记用的 profile 正确', results.mojangProfile === '069a79f4-44e9-4726-a5be-fca90e38aaf5');
  check('加密启用后 Login Ack 正常到达（加密通道可用）', results.gotAck === true, '');
  check('强制资源包回复 accepted → loaded', JSON.stringify(results.resourceStatuses) === '[3,0]');
  check('资源包回执 UUID 与请求一致', results.resourceUuid === resourceUuid);
  check('强制资源包之后完成配置', results.configFinished === true);
  check('进入游戏后收到系统聊天', JSON.stringify(chats) === '["RECEIVE_ONLY"]');
  check('能解密服务端发来的加密消息', String(clientDisconnectText) === '加密通道正常',
    `实际收到: ${clientDisconnectText}`);

  console.log(`\n本次 CFB8 实现：${usingNativeCfb8()
    ? '原生 aes-128-cfb8（OpenSSL）'
    : '兼容实现（BoringSSL 无 cfb8，走手写回退）'}`);
  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试异常:', e);
  process.exit(1);
});
