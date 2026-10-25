'use strict';
/*
 * audit_test.js —— 对抗性审查测试
 *
 * 目的：主动构造异常/边界输入，验证客户端不会崩溃、不会静默出错。
 * 覆盖审查中怀疑的点：
 *   A. 压缩 + 加密 同时启用时的顺序（vanilla 登录流程：Set Compression 在 Encryption Request 之前）
 *   B. 畸形压缩包（zlib 解压抛异常）是否会拖垮整个连接
 *   C. VarInt 越界 / 字符串长度越界
 *   D. NBT 畸形数据
 *   E. 超大包长度保护
 *   F. _decipher / _cipher 在构造期是否已定义
 *   G. pingServer 的 SRV 解析与超时
 *   H. 重复 close() 是否安全
 */
const net = require('net');
const zlib = require('zlib');
const crypto = require('crypto');
const {
  ByteWriter, ByteReader, PacketDecoder, encodePacket, tryReadVarInt, PACKET_ID: P,
} = require('./proto');
const { MCClient, pingServer } = require('./client');
const { createCipher, createDecipher } = require('./crypt');
const { decodeComponent, readRoot } = require('./nbt');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { console.log(`  \x1b[32m[PASS]\x1b[0m ${name}`); pass++; }
  else {
    console.log(`  \x1b[31m[FAIL]\x1b[0m ${name} ${extra}`);
    fail++; failures.push(name + ' ' + extra);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('\n=== 对抗性审查测试 ===\n');

  /* ============ A. 压缩 + 明文小包 ============ */
  console.log('[A] 包编解码边界');
  {
    // threshold=256 时，小包应走「长度0 + 原样」
    const small = Buffer.from([0x00, 0x01, 0x02]);
    const framed = encodePacket(small, 256);
    const dec = new PacketDecoder();
    dec.threshold = 256;
    const out = dec.push(framed);
    check('压缩模式下小包能正确回环', out.length === 1 && out[0].equals(small),
      `得到 ${out.length} 个包`);

    // 大包应走 zlib
    const big = Buffer.alloc(400, 0x41);
    big[0] = 0x10;
    const framed2 = encodePacket(big, 256);
    const dec2 = new PacketDecoder();
    dec2.threshold = 256;
    const out2 = dec2.push(framed2);
    check('压缩模式下大包能正确回环', out2.length === 1 && out2[0].equals(big));

    // 多包粘在一起（同一 chunk）
    const both = Buffer.concat([
      encodePacket(Buffer.from([0x01, 0xaa]), 256),
      encodePacket(Buffer.from([0x02, 0xbb]), 256),
    ]);
    const dec3 = new PacketDecoder();
    dec3.threshold = 256;
    const out3 = dec3.push(both);
    check('同一 chunk 内的多个包都被解出', out3.length === 2,
      `得到 ${out3.length} 个`);

    // 半包：分两次喂
    const one = encodePacket(Buffer.from([0x03, 0xcc, 0xdd]), 256);
    const dec4 = new PacketDecoder();
    dec4.threshold = 256;
    const a = dec4.push(one.subarray(0, 2));
    const b = dec4.push(one.subarray(2));
    check('半包能靠缓冲区续上', a.length === 0 && b.length === 1,
      `第一段 ${a.length} 第二段 ${b.length}`);
  }

  /* ============ B. 畸形压缩数据 ============ */
  console.log('\n[B] 畸形压缩包不应拖垮连接');
  {
    // 构造一个声明「解压后 100 字节」但 zlib 数据是垃圾的帧
    const w = new ByteWriter();
    w.varint(100);                                  // 解压后长度
    w.raw(Buffer.from([0xde, 0xad, 0xbe, 0xef]));   // 非法 zlib
    const body = w.build();
    const frame = new ByteWriter();
    frame.varint(body.length); frame.raw(body);

    const dec = new PacketDecoder();
    dec.threshold = 256;
    let threw = false;
    try { dec.push(frame.build()); } catch (e) { threw = true; }
    check('畸形 zlib 数据会抛错（由上层捕获）', threw,
      '若不抛错说明吞掉了损坏数据');
  }

  /* ============ C. VarInt / 字符串越界 ============ */
  console.log('\n[C] VarInt 与字符串边界');
  {
    // 5 字节全 0x80（永不终止）—— 应返回 null 而不是死循环
    const bad = Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x80]);
    check('超长 VarInt 返回 null（不死循环）', tryReadVarInt(bad, 0) === null);

    // 负长度字符串
    const r = new ByteReader(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x0f]));
    let threw = false;
    try { const len = r.varint(); if (len < 0) throw new Error('neg'); } catch (e) { threw = true; }
    check('负 VarInt 能被识别', threw);

    // 字符串长度超过缓冲区
    const r2 = new ByteReader(Buffer.from([0x7f]));   // 声称 127 字节，实际 0
    let threw2 = false;
    try { r2.str(); } catch (e) { threw2 = true; }
    check('字符串越界抛错（不静默读脏数据）', threw2);

    // 超大包长度保护
    const dec = new PacketDecoder();
    const huge = new ByteWriter();
    huge.varint(9 * 1024 * 1024);                     // > 8MB 上限
    huge.raw(Buffer.alloc(4));
    let threw3 = false;
    try { dec.push(huge.build()); } catch (e) { threw3 = true; }
    check('超大包长度被拒绝', threw3);
  }

  /* ============ D. NBT 畸形 ============ */
  console.log('\n[D] NBT 解析健壮性');
  {
    check('空 buffer 不崩溃', decodeComponent(Buffer.alloc(0)) === null);
    check('只有 END tag 返回 null/空', (() => {
      const v = decodeComponent(Buffer.from([0x00]));
      return v === '' || v === null;
    })(), '得到: ' + JSON.stringify(decodeComponent(Buffer.from([0x00]))));

    // ❗网络 NBT 是匿名格式（无根名），构造测试数据也必须遵守 ——
    //   以前这里写成 [0x0a, 0x00, 0x00, ...]（带空根名），
    //   于是测试和实现犯了同一个错：测试全绿，真机全崩。
    // 正确：compound(0a) → 字段 tag 08(String) → 名长 0001 → 名 "a" → 值长 00ff（越界）
    let threw = false;
    let msg = '';
    try { readRoot(Buffer.from([0x0a, 0x08, 0x00, 0x01, 0x61, 0x00, 0xff])); }
    catch (e) { threw = true; msg = e.message; }
    check('NBT 越界抛错而非返回垃圾', threw, threw ? msg : '（未抛错，返回了垃圾数据）');

    // 字符串长度超界（另一条路径：raw() 的边界守卫）
    // 匿名 NBT 根就是 TAG_String：08 → 长度 fffe（远超剩余）
    let threwS = false;
    try { readRoot(Buffer.from([0x08, 0xff, 0xfe])); } catch (e) { threwS = true; }
    check('NBT 根字符串长度越界抛错', threwS);

    // 深层嵌套不应栈溢出（构造 60 层 compound，匿名格式）
    let deep = Buffer.from([0x00]);
    for (let i = 0; i < 60; i++) {
      deep = Buffer.concat([Buffer.from([0x0a, 0x00, 0x01, 0x61]), deep, Buffer.from([0x00])]);
    }
    deep = Buffer.concat([Buffer.from([0x0a]), deep]);
    let ok = true;
    try { decodeComponent(deep); } catch (e) { ok = false; }
    check('深层嵌套不抛异常', ok);
  }

  /* ============ E. 客户端构造期字段完整性 ============ */
  console.log('\n[E] 客户端对象字段完整性');
  {
    const c = new MCClient({ host: '127.0.0.1', port: 1, username: 'X' });
    check('_decipher 在构造期已定义', c._decipher !== undefined,
      `实际 = ${typeof c._decipher}`);
    check('_cipher 在构造期已定义', c._cipher !== undefined,
      `实际 = ${typeof c._cipher}`);
    check('offlineUUID 为 36 字符', c.uuid.length === 36, c.uuid);
    check('离线 UUID 版本位 = 3', c.uuid[14] === '3', c.uuid);
    // 重复 close 不应抛
    let threw = false;
    try { c.close(); c.close(); c.close(); } catch (e) { threw = true; }
    check('重复 close() 安全', !threw);
    // 未连接时 say/command 返回 false
    check('未连接时 say() 返回 false', c.say('hi') === false);
    check('未连接时 command() 返回 false', c.command('list') === false);
  }

  /* ============ F. 真实握手：压缩先于加密 ============ */
  console.log('\n[F] 压缩先设 + 随后加密（vanilla 真实顺序）');
  {
    const PORT = 25677;
    const keypair = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
    const pubDer = keypair.publicKey.export({ type: 'spki', format: 'der' });
    const verifyToken = crypto.randomBytes(4);
    const THRESHOLD = 64;
    let gotAck = false;
    let secretOk = false;

    const server = net.createServer((sock) => {
      let dec = new PacketDecoder();
      let stage = 'hs';
      let sDec = null, sEnc = null;

      sock.on('data', (chunk) => {
        const plain = sDec ? sDec.update(chunk) : chunk;
        if (!plain.length) return;
        let packets;
        try { packets = dec.push(plain); } catch (e) { return; }
        for (const pkt of packets) {
          const r = new ByteReader(pkt);
          const id = r.varint();
          if (stage === 'hs') { stage = 'login'; continue; }
          if (stage === 'login' && id === P.loginStart) {
            // ① 先 Set Compression（vanilla 顺序）
            const cw = new ByteWriter();
            cw.varint(P.loginCompress); cw.varint(THRESHOLD);
            sock.write(encodePacket(cw.build(), -1));
            dec.threshold = THRESHOLD;
            // ② 再 Encryption Request
            const w = new ByteWriter();
            w.varint(P.loginEncryption);
            w.str(''); w.varint(pubDer.length); w.raw(pubDer);
            w.varint(verifyToken.length); w.raw(verifyToken); w.bool(true);
            sock.write(encodePacket(w.build(), THRESHOLD));
            stage = 'enc';
            continue;
          }
          if (stage === 'enc' && id === P.loginEncryptionResponse) {
            const sl = r.varint(); const es = Buffer.from(r.raw(sl));
            const tl = r.varint(); const et = Buffer.from(r.raw(tl));
            let secret;
            try {
              secret = crypto.privateDecrypt({ key: keypair.privateKey, padding: crypto.constants.RSA_PKCS1_PADDING }, es);
              secretOk = secret.length === 16;
            } catch (e) { secretOk = false; }
            if (secret) {
              sDec = createDecipher(secret, secret);
              sEnc = createCipher(secret, secret);
              const sw = new ByteWriter();
              sw.varint(P.loginSuccess);
              sw.uuid('069a79f4-44e9-4726-a5be-fca90e38aaf5');
              sw.str('CompTest'); sw.varint(0);
              sw.uuid('00000000-0000-0000-0000-000000000000');
              sock.write(sEnc.update(encodePacket(sw.build(), THRESHOLD)));
              stage = 'done';
            }
            continue;
          }
          if (stage === 'done' && id === P.loginAcknowledged) {
            gotAck = true;
            continue;
          }
        }
      });
      sock.on('error', () => {});
    });
    await new Promise((res) => server.listen(PORT, '127.0.0.1', res));

    const origFetch = global.fetch;
    global.fetch = async () => ({ ok: true, status: 204, text: async () => '' });

    await new Promise((resolve) => {
      const c = new MCClient({
        host: '127.0.0.1', port: PORT, username: 'CompTest',
        uuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5',
        accessToken: 'fake', profileId: '069a79f4-44e9-4726-a5be-fca90e38aaf5',
      });
      c.connect().then(() => setTimeout(() => { c.close(); resolve(); }, 1800));
    });
    global.fetch = origFetch;
    server.close();

    check('压缩已设置后再加密：共享密钥成功解出', secretOk);
    check('压缩已设置后再加密：Login Ack 正常', gotAck,
      '若失败说明加密后的包未按 threshold 压缩');
  }

  /* ============ G. pingServer 超时 ============ */
  console.log('\n[G] pingServer 健壮性');
  {
    let threw = false, msg = '';
    try {
      await pingServer('127.0.0.1', 1, 1200);       // 1 号端口基本不会开
    } catch (e) { threw = true; msg = e.message; }
    check('连不上的服务器会 reject（不挂起）', threw, msg);
  }

  /* ============ H. 加密包与压缩的组合 ============ */
  console.log('\n[H] 加密封帧正确性');
  {
    const secret = crypto.randomBytes(16);
    const enc = createCipher(secret, secret);
    const dec = createDecipher(secret, secret);
    // 压缩后的帧整体加密，分块传输也要能还原
    const payload = Buffer.alloc(300, 0x5a); payload[0] = 0x33;
    const frame = encodePacket(payload, 128);
    const cipherText = Buffer.concat([
      enc.update(frame.subarray(0, 10)),
      enc.update(frame.subarray(10, 40)),
      enc.update(frame.subarray(40)),
    ]);
    const plain = Buffer.concat([
      dec.update(cipherText.subarray(0, 7)),
      dec.update(cipherText.subarray(7)),
    ]);
    check('分块加密后能完整还原压缩帧', plain.equals(frame));
    const d = new PacketDecoder(); d.threshold = 128;
    const out = d.push(plain);
    check('还原后能解出原始包', out.length === 1 && out[0].equals(payload));
  }

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  if (fail) { console.log('\n失败项:'); for (const f of failures) console.log('  - ' + f); }
  console.log('');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
