'use strict';
/*
 * cfb8_test.js —— AES-128-CFB8 跨运行时兼容层测试
 *
 * ============================================================================
 * 背景（真实事故，值得单独立一个套件盯着）
 * ============================================================================
 * Minecraft 加密握手固定用 AES-128-CFB8。但 `createCipheriv('aes-128-cfb8')`
 * **在不同运行时不一定可用**：
 *
 *   | 运行时                   | 底层加密库    | 有 cfb8? |
 *   |--------------------------|--------------|---------|
 *   | 系统 Node 22（开发/自检） | OpenSSL 3.5  | ✅ 有    |
 *   | 打包后的 Electron 33      | **BoringSSL** | ❌ 没有  |
 *
 * Electron 用 BoringSSL 并裁掉了 CFB8（实测只剩 28 个 cipher）。
 * 症状：命令行跑自检全绿，一打包成 exe，正版登录走到最后一步就报
 *       `Unknown cipher`（Mojang 登记都成功了，看起来像"验证逻辑"坏了，
 *        实际死在 createCipheriv 这一句）。
 *
 * 这个套件确保：
 *   1. 手写 Cfb8 与原生 aes-128-cfb8 **逐字节一致**（在原生可用的环境里对拍）
 *   2. 手写实现的分段调用语义与流式一致（TCP 分包不能破坏状态）
 *   3. key==iv==secret（MC 的实际用法）下也正确
 *   4. createCipher/createDecipher 工厂在两分支下都可用
 *   5. 大流量、超长流、边界输入都稳
 *
 * ⚠️ 注意：本套件在**有原生 cfb8 的环境**里只能验证"对拍一致"；
 *    要验证"BoringSSL 下真的能跑"，必须用打包后的 exe 跑（见 README 的
 *    `ELECTRON_RUN_AS_NODE=1 .../MC免客户端登录器.exe src/cfb8_test.js`）。
 *    本文件在检测到无原生 cfb8 时会自动跳过对拍、只验证自洽性。
 */

const crypto = require('crypto');
const { Cfb8, createCipher, createDecipher, usingNativeCfb8 } = require('./crypt');

let pass = 0, fail = 0;
const failed = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  [PASS] ' + name); }
  else { fail++; failed.push(name); console.log('  [FAIL] ' + name + (extra ? '  → ' + extra : '')); }
}

const hasNative = usingNativeCfb8();
console.log(`\n运行时：node=${process.versions.node} electron=${process.versions.electron || '-'} ` +
            `openssl=${process.versions.openssl}`);
console.log(`原生 aes-128-cfb8：${hasNative ? '可用（走对拍）' : '不可用（BoringSSL，走自洽）'}`);

const KEY = Buffer.from('0123456789abcdef');
const IV = Buffer.from('fedcba9876543210');

/* ---------- A. 与原生逐字节对拍 ---------- */
console.log('\n[A] 手写 Cfb8 vs 原生 aes-128-cfb8');
if (!hasNative) {
  console.log('  [SKIP] 本环境无原生 cfb8，无法对拍（BoringSSL 下属预期）');
} else {
  const lens = [1, 2, 3, 4, 15, 16, 17, 31, 32, 33, 64, 100, 255, 1000, 4096];
  for (const len of lens) {
    const plain = crypto.randomBytes(len);
    const nc = crypto.createCipheriv('aes-128-cfb8', KEY, IV);
    const nativeCt = Buffer.concat([nc.update(plain), nc.final()]);
    const handCt = new Cfb8(KEY, IV, false).update(plain);
    check(`len=${len} 密文逐字节一致`, handCt.equals(nativeCt),
      handCt.equals(nativeCt) ? '' :
        `\n      hand  =${handCt.toString('hex').slice(0, 48)}\n      native=${nativeCt.toString('hex').slice(0, 48)}`);
  }

  // 超长流（跨很多个 16 字节块）
  const big = crypto.randomBytes(70000);
  const nb = crypto.createCipheriv('aes-128-cfb8', KEY, IV);
  const nativeBig = Buffer.concat([nb.update(big), nb.final()]);
  check('70KB 超长流一致', new Cfb8(KEY, IV, false).update(big).equals(nativeBig));
}

/* ---------- B. 自洽性：加解密必须还原 ---------- */
console.log('\n[B] 加解密自洽性（不依赖原生）');
{
  const lens = [1, 16, 17, 100, 1000, 5000];
  for (const len of lens) {
    const plain = crypto.randomBytes(len);
    const ct = new Cfb8(KEY, IV, false).update(plain);
    const pt = new Cfb8(KEY, IV, true).update(ct);
    check(`len=${len} 解密还原`, pt.equals(plain));
    if (len > 1) check(`len=${len} 密文≠明文`, !ct.equals(plain));
  }
}

/* ---------- C. 分段语义（TCP 分包） ---------- */
console.log('\n[C] 分段调用等价于一次性调用（TCP 分包安全）');
{
  const plain = crypto.randomBytes(800);

  // 加密分段
  const oneShot = new Cfb8(KEY, IV, false).update(plain);
  const sizes = [1, 7, 16, 3, 100, 1, 200, 172];   // 含 1 字节这种极端分包
  const chunked = new Cfb8(KEY, IV, false);
  const parts = [];
  let off = 0;
  for (const s of sizes) { parts.push(chunked.update(plain.slice(off, off + s))); off += s; }
  parts.push(chunked.update(plain.slice(off)));
  const ct = Buffer.concat(parts);
  check('不规则分段加密 == 一次性加密', ct.equals(oneShot));

  // 解密分段
  const dec = new Cfb8(KEY, IV, true);
  const dp = [];
  let o2 = 0;
  for (const s of sizes) { dp.push(dec.update(ct.slice(o2, o2 + s))); o2 += s; }
  dp.push(dec.update(ct.slice(o2)));
  check('不规则分段解密 == 原文', Buffer.concat(dp).equals(plain));

  // 极端：逐字节喂
  const byteWise = new Cfb8(KEY, IV, false);
  const bytes = [];
  for (let i = 0; i < 260; i++) bytes.push(byteWise.update(plain.slice(i, i + 1)));
  check('逐字节喂 260 次 == 一次性', Buffer.concat(bytes).equals(oneShot.slice(0, 260)));
}

/* ---------- D. MC 实际用法：key == iv == secret ---------- */
console.log('\n[D] MC 实际用法（key 与 iv 都是共享密钥）');
{
  const secret = crypto.randomBytes(16);
  const plain = crypto.randomBytes(2048);
  const ct = new Cfb8(secret, secret, false).update(plain);
  check('key==iv==secret 加解密自洽',
    new Cfb8(secret, secret, true).update(ct).equals(plain));

  if (hasNative) {
    const n = crypto.createCipheriv('aes-128-cfb8', secret, secret);
    const ref = Buffer.concat([n.update(plain), n.final()]);
    check('key==iv==secret 下与原生一致', ct.equals(ref));

    // 分 1200 字节段（MC 一个 TCP 段常见量级）
    const h = new Cfb8(secret, secret, false);
    const segs = [];
    for (let i = 0; i < plain.length; i += 1200) segs.push(h.update(plain.slice(i, i + 1200)));
    check('分 1200 字节段仍与原生一致', Buffer.concat(segs).equals(ref));
  }
}

/* ---------- E. 边界输入 ---------- */
console.log('\n[E] 边界输入');
{
  check('空 Buffer 返回空', new Cfb8(KEY, IV, false).update(Buffer.alloc(0)).length === 0);
  check('null 输入返回空且不抛', new Cfb8(KEY, IV, false).update(null).length === 0);
  check('undefined 输入返回空且不抛', new Cfb8(KEY, IV, false).update(undefined).length === 0);
  check('单字节 0x00 可处理', new Cfb8(KEY, IV, false).update(Buffer.from([0])).length === 1);
  check('全 0xFF 大块可处理', new Cfb8(KEY, IV, false).update(Buffer.alloc(3000, 0xff)).length === 3000);

  let threw = false;
  try { new Cfb8(Buffer.alloc(15), IV, false); } catch (e) { threw = true; }
  check('密钥长度错误时抛错（15 字节）', threw);

  threw = false;
  try { new Cfb8(KEY, Buffer.alloc(8), false); } catch (e) { threw = true; }
  check('IV 长度错误时抛错（8 字节）', threw);

  threw = false;
  try { new Cfb8('not a buffer', IV, false); } catch (e) { threw = true; }
  check('非 Buffer 密钥抛错', threw);
}

/* ---------- F. 工厂函数 ---------- */
console.log('\n[F] createCipher / createDecipher 工厂');
{
  const secret = crypto.randomBytes(16);
  const plain = Buffer.from('工厂函数测试 factory test');

  let c = null, d = null;
  try { c = createCipher(secret, secret); } catch (e) {}
  check('createCipher 可创建（不抛 Unknown cipher）', !!c);

  try { d = createDecipher(secret, secret); } catch (e) {}
  check('createDecipher 可创建', !!d);

  if (c && d) {
    const ct = c.update(plain);
    check('工厂创建的流加解密自洽', d.update(ct).equals(plain));
  }

  // 工厂必须根据环境选对实现
  if (hasNative) {
    const inst = createCipher(secret, secret);
    check('原生可用时返回原生流（非 Cfb8 实例）', !(inst instanceof Cfb8));
  } else {
    const inst = createCipher(secret, secret);
    check('原生不可用时返回手写 Cfb8 实例', inst instanceof Cfb8);
  }
}

/* ---------- G. 两个流互相独立（加密/解密状态不能串） ---------- */
console.log('\n[G] 加密流与解密流状态互相独立');
{
  const secret = crypto.randomBytes(16);
  const a = new Cfb8(secret, secret, false);
  const b = new Cfb8(secret, secret, true);

  // 交替使用，互相不能污染对方状态
  const p1 = Buffer.from('AAAA');
  const p2 = Buffer.from('BBBBBBBB');
  const c1 = a.update(p1);
  const d1 = b.update(c1);
  const c2 = a.update(p2);
  const d2 = b.update(c2);

  check('交替调用后仍能正确还原', d1.equals(p1) && d2.equals(p2));

  // 与完全独立的两组流对比
  const a2 = new Cfb8(secret, secret, false);
  check('加密流状态未受解密流影响', a2.update(p1).equals(c1));
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
if (failed.length) { console.log('失败项:'); for (const f of failed) console.log('  - ' + f); console.log(''); }
process.exit(fail === 0 ? 0 : 1);
