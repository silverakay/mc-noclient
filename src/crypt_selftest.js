'use strict';
/*
 * crypt_selftest.js —— 正版加密握手离线自测
 * 重点验证 serverId 哈希（算法错了就登不进正版服）
 */
const assert = require('assert');
const crypto = require('crypto');
const {
  computeServerHash, generateSharedSecret, rsaEncrypt,
  parsePublicKey, EncryptedSocket,
  createCipher, createDecipher,
} = require('./crypt');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  \x1b[32m[PASS]\x1b[0m ${name}`); pass++; }
  catch (e) { console.log(`  \x1b[31m[FAIL]\x1b[0m ${name}\n         ${e.message}`); fail++; }
}

console.log('\n=== 正版加密握手 · 离线自测 ===\n');

console.log('[serverId 哈希]');
// Fixed vectors use signed two's-complement magnitudes, not the production helper.
for (const [n, expected] of [
  [0, '-ed197035ab31468b3b0a5cf170045514a26d454'],
  [1, '2c98a7047159c6e82322a7ca45417893ddf5a254'],
  [36, '26cd362d1f09df3a0d9c08ed1d8ad70cbed50b'],
  [180, '-89390639559ae5c9b12ee5065692c335158e57'],
]) {
  t('Java signed hash vector ' + n + ' (including leading zeros)', () => {
    const secret = Buffer.alloc(16);
    secret.writeUInt32BE(n, 12);
    assert.strictEqual(computeServerHash('', secret, Buffer.alloc(64, 0xab)), expected);
  });
}
t('serverId 非空时参与计算', () => {
  const secret = Buffer.from('0123456789abcdef', 'latin1');
  const der = Buffer.from('ab'.repeat(64), 'hex');
  const a = computeServerHash('', secret, der);
  const b = computeServerHash('myid', secret, der);
  assert.notStrictEqual(a, b, 'serverId 不同应该产生不同哈希');
});
t('结果是不补前导零的有符号十六进制', () => {
  const h = computeServerHash('', Buffer.alloc(16), Buffer.alloc(64));
  assert.match(h, /^-?[1-9a-f][0-9a-f]{0,39}$/);
});

console.log('\n[共享密钥 / RSA]');
t('共享密钥长度 = 16 字节（AES-128）', () => {
  assert.strictEqual(generateSharedSecret().length, 16);
});
t('每次生成的密钥都不同', () => {
  assert.notDeepStrictEqual(generateSharedSecret(), generateSharedSecret());
});
t('RSA 加密→解密可还原（模拟服务端视角）', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const parsed = parsePublicKey(der);
  const secret = generateSharedSecret();
  const enc = rsaEncrypt(parsed, secret);
  const dec = crypto.privateDecrypt(
    { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
    enc
  );
  assert.deepStrictEqual(dec, secret, '服务端解密后应拿到相同的共享密钥');
});
t('能解析 DER 格式公钥', () => {
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  const der = publicKey.export({ type: 'spki', format: 'der' });
  assert.doesNotThrow(() => parsePublicKey(der));
});
t('Verify Token 加密往返', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  const parsed = parsePublicKey(publicKey.export({ type: 'spki', format: 'der' }));
  const token = crypto.randomBytes(4);
  const enc = rsaEncrypt(parsed, token);
  const dec = crypto.privateDecrypt(
    { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
    enc
  );
  assert.deepStrictEqual(dec, token);
});

console.log('\n[AES-128-CFB8 双向加密流]');
t('客户端加密 → 服务端解密', () => {
  const secret = generateSharedSecret();
  // 客户端侧：cipher 加密出站
  // ❗用兼容层而不是直接 createCipheriv('aes-128-cfb8')：
  //   打包后的 Electron 走 BoringSSL，没有 cfb8，直接调会崩 ——
  //   那样这个自检就永远跑不到 BoringSSL 场景，等于没测。
  const cCipher = createCipher(secret, secret);
  // 服务端侧：decipher 解密入站
  const sDecipher = createDecipher(secret, secret);
  const msg = Buffer.from('这是一条加密的聊天消息 hello world');
  const enc = cCipher.update(msg);
  assert.notDeepStrictEqual(enc, msg, '密文应该和明文不同');
  assert.deepStrictEqual(sDecipher.update(enc), msg, '解密后应还原');
});
t('分块传输也能正确解密（TCP 粘包场景）', () => {
  const secret = generateSharedSecret();
  const cCipher = createCipher(secret, secret);
  const sDecipher = createDecipher(secret, secret);
  const a = Buffer.from('第一段数据');
  const b = Buffer.from('第二段数据');
  const ea = cCipher.update(a);
  const eb = cCipher.update(b);
  // 服务端分两次收到
  const ra = sDecipher.update(ea);
  const rb = sDecipher.update(eb);
  assert.deepStrictEqual(Buffer.concat([ra, rb]), Buffer.concat([a, b]));
});
t('CFB8 是流密码，可逐字节加解密', () => {
  const secret = generateSharedSecret();
  const c = createCipher(secret, secret);
  const d = createDecipher(secret, secret);
  const data = Buffer.from('abcdefghij');
  let out = Buffer.alloc(0);
  for (const byte of data) {
    out = Buffer.concat([out, d.update(c.update(Buffer.from([byte])))]);
  }
  assert.deepStrictEqual(out, data);
});
t('EncryptedSocket 包装器开关正常', () => {
  const secret = generateSharedSecret();
  const sock = new EncryptedSocket({}, secret);
  const data = Buffer.from('test data');
  assert.deepStrictEqual(sock.decrypt(sock.encrypt(data)), data);
  sock.enabled = false;
  assert.deepStrictEqual(sock.encrypt(data), data, '关闭后应原样通过');
});

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
process.exit(fail === 0 ? 0 : 1);
