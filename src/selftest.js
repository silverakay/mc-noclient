'use strict';
/*
 * selftest.js —— 离线自测（不需要服务器、不联网）
 * 验证：VarInt / 字符串 / UUID / NBT / 封包解包 / 离线UUID
 */
const assert = require('assert');
const zlib = require('zlib');
const {
  ByteWriter, ByteReader, PacketDecoder, encodePacket,
  PACKET_ID: P, PROTOCOL_VERSION,
} = require('./proto');
const { readRoot, decodeComponent } = require('./nbt');
const { offlineUUID } = require('./client');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  \x1b[32m[PASS]\x1b[0m ${name}`); pass++; }
  catch (e) { console.log(`  \x1b[31m[FAIL]\x1b[0m ${name}\n         ${e.message}`); fail++; }
}

console.log('\n=== MC 免客户端登录器 · 离线自测 ===\n');

console.log('[VarInt]');
t('0 → 00', () => assert.deepStrictEqual([...new ByteWriter().varint(0).build()], [0x00]));
t('127 → 7f', () => assert.deepStrictEqual([...new ByteWriter().varint(127).build()], [0x7f]));
t('128 → 80 01', () => assert.deepStrictEqual([...new ByteWriter().varint(128).build()], [0x80, 0x01]));
t('25565 → dd c7 01', () => assert.deepStrictEqual([...new ByteWriter().varint(25565).build()], [0xdd, 0xc7, 0x01]));
t('776 → 88 06', () => assert.deepStrictEqual([...new ByteWriter().varint(776).build()], [0x88, 0x06]));
t('往返 776', () => {
  const b = new ByteWriter().varint(776).build();
  assert.strictEqual(new ByteReader(b).varint(), 776);
});
t('往返 -1（补码）', () => {
  const b = new ByteWriter().varint(-1).build();
  assert.strictEqual(new ByteReader(b).varint(), -1);
});

console.log('\n[字符串 / UUID]');
t('中文往返', () => {
  const b = new ByteWriter().str('你好 MC 26.2').build();
  assert.strictEqual(new ByteReader(b).str(), '你好 MC 26.2');
});
t('UUID 往返', () => {
  const u = '069a79f4-44e9-4726-a5be-fca90e38aaf5';
  const b = new ByteWriter().uuid(u).build();
  assert.strictEqual(b.length, 16);
  assert.strictEqual(new ByteReader(b).uuid(), u);
});

console.log('\n[离线 UUID]');
t('Notch 的离线 UUID 与原版一致', () => {
  // 原版算法：MD5("OfflinePlayer:Notch")，版本位改 3
  assert.strictEqual(offlineUUID('Notch'), 'b50ad385-829d-3141-a216-7e7d7539ba7f');
});
t('同名稳定', () => assert.strictEqual(offlineUUID('BaiXu'), offlineUUID('BaiXu')));
t('异名不同', () => assert.notStrictEqual(offlineUUID('a'), offlineUUID('b')));

console.log('\n[NBT]');
/* ❗网络 NBT 是**匿名格式**：compound(0x0a) 之后直接是子字段，**没有根名**。
 *   （标准 NBT 文件格式才有 [name长度u16][name]，那是存档用的、不是网络用的。）
 *   以前这里写成 [10, 0, 0]（带空根名），测试和实现犯了同一个错 ——
 *   测试全绿、真机上所有聊天/NBT 全解不出来。 */
t('解析 {text:"hi"}', () => {
  const buf = Buffer.concat([
    Buffer.from([10]),
    Buffer.from([8, 0, 4]), Buffer.from('text', 'utf8'),
    Buffer.from([0, 2]), Buffer.from('hi', 'utf8'),
    Buffer.from([0]),
  ]);
  const { value } = readRoot(buf);
  assert.strictEqual(value.text, 'hi');
  assert.strictEqual(decodeComponent(buf), 'hi');
});
t('解析 extra 数组', () => {
  // {text:"A:", extra:[{text:"BC"}]}
  const buf = Buffer.concat([
    Buffer.from([10]),
    Buffer.from([8, 0, 4]), Buffer.from('text', 'utf8'),
    Buffer.from([0, 2]), Buffer.from('A:', 'utf8'),
    Buffer.from([9, 0, 5]), Buffer.from('extra', 'utf8'),
    Buffer.from([10]),                        // LIST 元素类型 = Compound(10)
    Buffer.from([0, 0, 0, 1]),                // 元素个数 = 1（i32 大端）
    Buffer.from([8, 0, 4]), Buffer.from('text', 'utf8'),
    Buffer.from([0, 2]), Buffer.from('BC', 'utf8'),
    Buffer.from([0]),                         // 内部 compound 结束
    Buffer.from([0]),                         // 根 compound 结束
  ]);
  const { value } = readRoot(buf);
  assert.strictEqual(value.text, 'A:');
  assert.strictEqual(value.extra[0].text, 'BC');
  assert.strictEqual(decodeComponent(buf), 'A:BC');
});
t('translate + with', () => {
  // {translate:"chat.type.text", with:["Bob","hey"]}
  const buf = Buffer.concat([
    Buffer.from([10]),
    Buffer.from([8, 0, 9]), Buffer.from('translate', 'utf8'),
    Buffer.from([0, 14]), Buffer.from('chat.type.text', 'utf8'),
    Buffer.from([9, 0, 4]), Buffer.from('with', 'utf8'),
    Buffer.from([8]),                         // LIST 元素类型 = String(8)
    Buffer.from([0, 0, 0, 2]),                // 元素个数 = 2
    Buffer.from([0, 3]), Buffer.from('Bob', 'utf8'),
    Buffer.from([0, 3]), Buffer.from('hey', 'utf8'),
    Buffer.from([0]),
  ]);
  assert.strictEqual(decodeComponent(buf), '<Bob> hey');
});

console.log('\n[封包 / 解包]');
t('无压缩往返', () => {
  const payload = new ByteWriter().varint(0x31).str('hello').build();
  const frame = encodePacket(payload, -1);
  const dec = new PacketDecoder();
  const out = dec.push(frame);
  assert.strictEqual(out.length, 1);
  assert.deepStrictEqual(out[0], payload);
});
t('有压缩·大包往返', () => {
  const big = 'A'.repeat(2000);
  const payload = new ByteWriter().varint(0x79).str(big).build();
  const frame = encodePacket(payload, 256);
  const dec = new PacketDecoder();
  dec.threshold = 256;
  const out = dec.push(frame);
  assert.strictEqual(out.length, 1);
  assert.deepStrictEqual(out[0], payload);
});
t('有压缩·小包走未压缩分支', () => {
  const payload = new ByteWriter().varint(0x2c).i64(123n).build();
  const frame = encodePacket(payload, 256);
  const dec = new PacketDecoder();
  dec.threshold = 256;
  const out = dec.push(frame);
  assert.strictEqual(out.length, 1);
  assert.deepStrictEqual(out[0], payload);
});
t('半包（分两次喂）', () => {
  const payload = new ByteWriter().varint(0x2c).i64(42n).build();
  const frame = encodePacket(payload, -1);
  const dec = new PacketDecoder();
  assert.strictEqual(dec.push(frame.subarray(0, 3)).length, 0);
  const out = dec.push(frame.subarray(3));
  assert.strictEqual(out.length, 1);
  assert.deepStrictEqual(out[0], payload);
});
t('粘包（一坨里两个包）', () => {
  const a = encodePacket(new ByteWriter().varint(1).build(), -1);
  const b = encodePacket(new ByteWriter().varint(2).build(), -1);
  const dec = new PacketDecoder();
  const out = dec.push(Buffer.concat([a, b]));
  assert.strictEqual(out.length, 2);
});

console.log('\n[包 ID 表一致性]');
t('协议号 = 776', () => assert.strictEqual(PROTOCOL_VERSION, 776));
t('握手 0x00 / 登录 0x00 / 进入配置 0x03', () => {
  assert.strictEqual(P.handshake, 0x00);
  assert.strictEqual(P.loginStart, 0x00);
  assert.strictEqual(P.loginAcknowledged, 0x03);
});
t('配置阶段完成 = 0x03', () => assert.strictEqual(P.cfgFinish, 0x03));
t('Play 保活 0x2c / 命令 0x07', () => {
  assert.strictEqual(P.playKeepAliveC, 0x2c);
  assert.strictEqual(P.playChatCommand, 0x07);
});

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
process.exit(fail === 0 ? 0 : 1);
