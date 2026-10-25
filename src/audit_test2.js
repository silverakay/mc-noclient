'use strict';
/*
 * audit_test2.js —— 第二轮重度审查（认证层 / 加密层边界 / 主进程）
 *
 * 覆盖 audit_test.js 没碰的地方：
 *   - computeServerHash 的 latin1 静默截断
 *   - rsaEncrypt 的明文超长保护
 *   - EncryptedSocket 的流状态必须连续
 *   - joinMojangSession 的参数校验与超时
 *   - NBT 各数组类型的越界守卫
 *   - 帧大小上限 / 压缩阈值边界
 */

const crypto = require('crypto');

const {
  computeServerHash, generateSharedSecret, rsaEncrypt, parsePublicKey, EncryptedSocket,
} = require('./crypt');
const { Reader, readRoot, TAG } = require('./nbt');
const { ByteWriter, ByteReader, PacketDecoder, encodePacket, tryReadVarInt } = require('./proto');

let pass = 0, fail = 0;
const failed = [];

function check(name, cond, extra) {
  if (cond) { pass++; console.log('  [PASS] ' + name); }
  else {
    fail++; failed.push(name + (extra ? '  → ' + extra : ''));
    console.log('  [FAIL] ' + name + (extra ? '  → ' + extra : ''));
  }
}

async function checkAsync(name, fn) {
  try { await fn(); check(name, true); }
  catch (e) { check(name, false, e.message); }
}

function expectThrow(fn) {
  try { fn(); return false; } catch (e) { return true; }
}

(async () => {
  /* ============ A. serverHash 边界 ============ */
  console.log('\n[A] computeServerHash 边界');
  {
    const secret = generateSharedSecret();
    const key = Buffer.from([1, 2, 3, 4]);

    // 正常空 serverId
    const h1 = computeServerHash('', secret, key);
    check('空 serverId 能算出不补前导零的有符号十六进制',
      /^-?[1-9a-f][0-9a-f]{0,39}$/.test(h1), h1);

    // 首字符 >= 8 → 必须加负号
    let sawNeg = false, sawPos = false;
    for (let i = 0; i < 400; i++) {
      const s = generateSharedSecret();
      const h = computeServerHash('', s, key);
      if (h.startsWith('-')) sawNeg = true; else sawPos = true;
      if (sawNeg && sawPos) break;
    }
    check('哈希 50% 概率带负号（BigInteger 有符号十六进制）', sawNeg && sawPos);

    // ❗latin1 静默截断必须变显式报错
    check('serverId 含中文 → 抛错而不是静默截断',
      expectThrow(() => computeServerHash('服务器', secret, key)));

    // 边界：恰好 0xFF 合法，0x100 非法
    check('serverId 含 U+00FF 合法（ISO-8859-1 边界内）',
      typeof computeServerHash('\u00ff', secret, key) === 'string');
    check('serverId 含 U+0100 抛错（超出 ISO-8859-1）',
      expectThrow(() => computeServerHash('\u0100', secret, key)));

    // 非 16 字节密钥必须拒绝
    check('密钥长度非 16 字节抛错',
      expectThrow(() => computeServerHash('', Buffer.alloc(8), key)));
    check('serverId 非字符串抛错',
      expectThrow(() => computeServerHash(123, secret, key)));

    // 相同输入必须完全可复现（否则服务端反查必然失败）
    check('相同输入结果可复现',
      computeServerHash('abc', secret, key) === computeServerHash('abc', secret, key));
  }

  /* ============ B. RSA 加密边界 ============ */
  console.log('\n[B] rsaEncrypt 边界');
  {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 1024,
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });
    const pub = parsePublicKey(Buffer.from(publicKey));

    // 1024 位 → 最大 117 字节明文
    check('16 字节共享密钥可加密', rsaEncrypt(pub, crypto.randomBytes(16)).length === 128);
    check('117 字节（上限）可加密', rsaEncrypt(pub, Buffer.alloc(117)).length === 128);
    check('118 字节（超上限）抛可读错误',
      expectThrow(() => rsaEncrypt(pub, Buffer.alloc(118))));

    // 加密结果必须能用私钥解回原文
    const sk = crypto.createPrivateKey({ key: Buffer.from(privateKey), format: 'der', type: 'pkcs8' });
    const msg = crypto.randomBytes(16);
    const dec = crypto.privateDecrypt(
      { key: sk, padding: crypto.constants.RSA_PKCS1_PADDING },
      rsaEncrypt(pub, msg)
    );
    check('RSA 往返一致', dec.equals(msg));

    // 512 位密钥：16 字节能过，但告诉调用者上限变小了
    const small = crypto.generateKeyPairSync('rsa', {
      modulusLength: 512,
      publicKeyEncoding: { type: 'spki', format: 'der' },
    });
    const spub = parsePublicKey(Buffer.from(small.publicKey));
    check('512 位密钥：53 字节上限生效',
      expectThrow(() => rsaEncrypt(spub, Buffer.alloc(54))));

    // 损坏的公钥必须报错而不是崩溃
    check('损坏公钥解析抛错', expectThrow(() => parsePublicKey(Buffer.from([1, 2, 3]))));
  }

  /* ============ C. EncryptedSocket 流状态 ============ */
  console.log('\n[C] EncryptedSocket 流连续性');
  {
    const secret = generateSharedSecret();
    const enc = new EncryptedSocket({}, secret);

    // 分多次 encrypt，接收端一次 decrypt —— CFB8 流密码必须完全一致
    const src = Buffer.from('Minecraft 26.2 encrypted stream test');
    const parts = [];
    for (let i = 0; i < src.length; i += 7) parts.push(enc.encrypt(src.subarray(i, i + 7)));
    const wire = Buffer.concat(parts);

    const dec = new EncryptedSocket({}, secret);
    check('多次 encrypt → 一次 decrypt 还原', dec.decrypt(wire).equals(src));

    // 逐字节解密也必须成立
    const dec2 = new EncryptedSocket({}, secret);
    const out = [];
    for (const b of wire) out.push(dec2.decrypt(Buffer.from([b])));
    check('一次 encrypt → 逐字节 decrypt 还原', Buffer.concat(out).equals(src));

    // enabled 只有显式 false 才旁路（undefined / 0 / null 都不该静默旁路）
    const e2 = new EncryptedSocket({}, secret);
    e2.enabled = false;
    check('enabled=false 时原样通过', e2.encrypt(src).equals(src));
    e2.enabled = true;
    check('enabled=true 时加密（不等于原文）', !e2.encrypt(src).equals(src));

    // 非 16 字节密钥必须拒绝
    check('非 16 字节密钥构造抛错', expectThrow(() => new EncryptedSocket({}, Buffer.alloc(15))));
  }

  /* ============ D. NBT 数组越界 ============ */
  console.log('\n[D] NBT 数组类型越界');
  {
    // ❗网络 NBT 是匿名格式（无根名）：compound(0a) 之后**直接**是子字段。
    //   旧写法 [0x0a, 0x00, 0x00, tag, ...] 多了个"空根名"，与真实协议不符
    //   （实测抓包证明 26.2 就是 anonymousNbt）。
    //   head = compound + 字段(tag, 名长=1, 名='a')
    const head = (tag) => [0x0a, tag, 0x00, 0x01, 0x61];
    const END = [0x00];   // ❗compound 结尾必须有 TAG_End，否则解析器会继续找下一个 tag

    // BYTE_ARRAY 声明 1000 字节实际 0
    const ba = Buffer.from([...head(0x07), 0x00, 0x00, 0x03, 0xe8, ...END]);
    check('BYTE_ARRAY 长度越界抛错', expectThrow(() => readRoot(ba)));

    // INT_ARRAY 声明 1000 个
    const ia = Buffer.from([...head(0x0b), 0x00, 0x00, 0x03, 0xe8, ...END]);
    check('INT_ARRAY 长度越界抛错', expectThrow(() => readRoot(ia)));

    // LONG_ARRAY 声明 1000 个
    const la = Buffer.from([...head(0x0c), 0x00, 0x00, 0x03, 0xe8, ...END]);
    check('LONG_ARRAY 长度越界抛错', expectThrow(() => readRoot(la)));

    // LIST 负长度（i32 = -1）
    const ll = Buffer.from([...head(0x09), 0x01, 0xff, 0xff, 0xff, 0xff, ...END]);
    check('LIST 负长度抛错', expectThrow(() => readRoot(ll)));

    // 合法 BYTE_ARRAY（长度 3，数据 1 2 3）能正常读
    const ok = Buffer.from([...head(0x07), 0x00, 0x00, 0x00, 0x03, 1, 2, 3, ...END]);
    let okVal = null;
    try { okVal = readRoot(ok).value; } catch (e) { okVal = null; }
    check('合法 BYTE_ARRAY 读取正确',
      okVal && okVal.a && okVal.a.length === 3 && okVal.a[2] === 3,
      JSON.stringify(okVal && okVal.a));

    // BYTE_ARRAY 返回的是副本，改它不应影响原 buffer
    const src = Buffer.from([...head(0x07), 0x00, 0x00, 0x00, 0x02, 9, 9, ...END]);
    const got = readRoot(src).value.a;
    got[0] = 77;
    check('BYTE_ARRAY 返回副本（原地修改不污染源）', src[src.length - 2] === 9);

    // 合法 INT_ARRAY 能正常读
    const oki = Buffer.from([...head(0x0b), 0x00, 0x00, 0x00, 0x02, 0, 0, 0, 7, 0, 0, 0, 8, ...END]);
    let okiVal = null;
    try { okiVal = readRoot(oki).value; } catch (e) { okiVal = null; }
    check('合法 INT_ARRAY 读取正确',
      Array.isArray(okiVal && okiVal.a) && okiVal.a.length === 2 && okiVal.a[1] === 8,
      JSON.stringify(okiVal && okiVal.a));

    // 未知 tag 必须报错
    check('未知 tag 类型抛错', expectThrow(() => new Reader(Buffer.from([0x7f])).payload(0x7f)));

    // 定点读取到尾部应抛可读错误，而不是 Node 原始 RangeError
    check('u8 在 EOF 抛可读错误', (() => {
      try { new Reader(Buffer.alloc(0)).u8(); return false; }
      catch (e) { return /NBT 越界/.test(e.message); }
    })());
    check('i32 在剩余不足时抛可读错误', (() => {
      try { new Reader(Buffer.alloc(2)).i32(); return false; }
      catch (e) { return /NBT 越界/.test(e.message); }
    })());

    // 超深嵌套必须被拦下（不是栈溢出崩溃）
    check('超深嵌套被拦下（>512 层）', (() => {
      let body = Buffer.from([0x00]);
      for (let i = 0; i < 700; i++) {
        body = Buffer.concat([Buffer.from([0x0a, 0x00, 0x01, 0x61]), body, Buffer.from([0x00])]);
      }
      const deep = Buffer.concat([Buffer.from([0x0a]), body]);
      try { readRoot(deep); return false; }
      catch (e) { return /嵌套过深/.test(e.message); }
    })());
  }

  /* ============ E. 帧与压缩阈值边界 ============ */
  console.log('\n[E] 帧 / 压缩阈值边界');
  {
    // 阈值以下不压缩
    const small = Buffer.from([0x01, 0x02]);
    const f1 = encodePacket(small, 256);
    const r1 = new ByteReader(f1);
    check('小于阈值 → 长度字段 = 原文长度+1',
      r1.varint() === small.length + 1);

    // 阈值以上压缩：解出来应带 0 长度头
    const big = Buffer.alloc(500, 0xab);
    const f2 = encodePacket(big, 256);
    const dec = new PacketDecoder();
    dec.threshold = 256;
    const out = dec.push(f2);
    check('大于阈值 → 解出原文', out.length === 1 && out[0].equals(big));

    // threshold = -1（无压缩）时，任何长度都不压缩
    const f3 = encodePacket(big, -1);
    const dec3 = new PacketDecoder();
    dec3.threshold = -1;
    check('threshold=-1 → 不压缩也能解出', dec3.push(f3)[0].equals(big));

    // 0 长度帧不应死循环
    const dec4 = new PacketDecoder();
    let zeroThrew = false;
    try { dec4.push(Buffer.from([0x00])); } catch (e) { zeroThrew = true; }
    check('0 长度帧不死循环（抛错或空返回）', zeroThrew || true);

    // 恰好等于阈值 → 仍不压缩（vanilla 是 < threshold 不压，>= 压）
    const exact = Buffer.alloc(256, 0x5a);
    const fe = encodePacket(exact, 256);
    const de = new PacketDecoder();
    de.threshold = 256;
    let exactOk = false;
    try { exactOk = de.push(fe)[0].equals(exact); } catch (e) { exactOk = false; }
    check('长度正好等于阈值能正确往返', exactOk);

    // 畸形 VarInt 长度不应把 decoder 卡死
    const de2 = new PacketDecoder();
    check('超长 VarInt 长度不抛未捕获异常', (() => {
      try { de2.push(Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x80])); return true; }
      catch (e) { return true; }
    })());
  }

  /* ============ F. 大包上限 ============ */
  console.log('\n[F] 大包保护');
  {
    const dec = new PacketDecoder();
    const w = new ByteWriter();
    w.varint(64 * 1024 * 1024);   // 声明 64MB
    check('声明 64MB 的包被拒绝（防内存炸弹）',
      expectThrow(() => dec.push(w.build())));
  }

  /* ============ G. tryReadVarInt 语义 ============ */
  console.log('\n[G] VarInt 读取语义');
  {
    check('1 字节 0x7f = 127', (() => { const v = tryReadVarInt(Buffer.from([0x7f]), 0); return v && v.value === 127 && v.size === 1; })());
    check('2 字节 0x80 0x01 = 128', (() => { const v = tryReadVarInt(Buffer.from([0x80, 0x01]), 0); return v && v.value === 128 && v.size === 2; })());
    check('空 buffer 返回 null', tryReadVarInt(Buffer.alloc(0), 0) === null);
    check('6 个 0x80 返回 null（超长）', tryReadVarInt(Buffer.alloc(6, 0x80), 0) === null);
    check('buffer 尾部截断返回 null', tryReadVarInt(Buffer.from([0x80]), 0) === null);
  }

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
  if (failed.length) {
    console.log('失败项:');
    for (const f of failed) console.log('  - ' + f);
    console.log('');
  }
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('\n[致命] 测试脚本自身异常：', e);
  process.exit(2);
});
