'use strict';
/*
 * chat_test.js —— 聊天解析回归测试
 *
 * 本文件的核心价值在于：测试数据是**从真实 26.2 服务端抓下来的原始字节**，
 * 而不是手写构造的。这一区别至关重要 ——
 *
 *   ❗之前 nbt.js 的 readRoot() 假设「根节点有名字」，而 26.x 网络 NBT 是
 *     anonymousNbt（无根名）。原来的 NBT 测试**自己构造带根名的数据**，
 *     于是测试和实现犯了同一个错：测试全绿，真机上所有 NBT 全解不出来，
 *     聊天消息被空 catch 吞掉 → 表现为「看不到聊天」。
 *
 *   教训：解析类代码的测试，必须用**外部来源**的真实数据，否则只是自证。
 *
 * 抓包方法（只收不发，不会触发任何服务端风控）：
 *   本地起 26.2 服务端 → 客户端只连接不发言 → 从**服务端控制台**执行
 *   `say` / `tellraw` 命令广播 → 在客户端 onPlayPacket 处 dump 原始字节。
 */

const assert = require('assert');
const { ByteWriter, ByteReader, PACKET_ID: P } = require('./proto');
const { decodeComponent, componentToText, readRoot } = require('./nbt');
const { MCClient } = require('./client');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  \x1b[32m[PASS]\x1b[0m ${name}`); pass++; }
  catch (e) { console.log(`  \x1b[31m[FAIL]\x1b[0m ${name}\n         ${e.message}`); fail++; }
}

console.log('\n=== 聊天解析 · 真实抓包回归 ===\n');

/* ============================================================
 * A. NBT 根格式：匿名 NBT（无根名）
 * ============================================================ */
console.log('[A] NBT 根格式（anonymousNbt，无根名）');

t('❗真实 system_chat 的 NBT 能解析出文本', () => {
  // 真实抓包（服务端 tellraw {"text":"PROBE_TELLRAW","color":"gold"}）
  // 79 是包 ID，之后 0a 起是 NBT
  const nbt = Buffer.from(
    '0a080005636f6c6f720004676f6c6408000474657874000d50524f42455f54454c4c5241570000',
    'hex');
  const text = decodeComponent(nbt);
  assert.strictEqual(text, 'PROBE_TELLRAW',
    '实际得到: ' + JSON.stringify(text));
});

t('❗真实 profileless_chat 的 message NBT 能解析（中文）', () => {
  // 真实抓包（服务端 say 中文测试 PROBE_2）里的 message 部分
  const nbt = Buffer.from(
    '080014e4b8ade69687e6b58be8af952050524f42455f32',
    'hex');
  const text = decodeComponent(nbt);
  assert.strictEqual(text, '中文测试 PROBE_2', '实际得到: ' + JSON.stringify(text));
});

t('带 extra 的复合组件按顺序拼接', () => {
  // 真实抓包（tellraw {"text":"A_","extra":[{"text":"B_"},{"text":"C"}]}）
  const nbt = Buffer.from(
    '0a090005657874726108000000020002425f000143080004746578740002415f0000',
    'hex');
  const text = decodeComponent(nbt);
  assert.strictEqual(text, 'A_B_C', '实际得到: ' + JSON.stringify(text));
});

t('匿名 NBT 根如果是 compound，第一个字节就是子标签（不读根名）', () => {
  // 若错误地按「有根名」解析，0a 之后会读 u16 名字长度 = 0x0800 = 2048 → 越界
  const nbt = Buffer.from('0a080005636f6c6f720004676f6c640000', 'hex');
  const { value, bytesRead } = readRoot(nbt);
  assert.strictEqual(value.color, 'gold');
  assert.ok(bytesRead > 0 && bytesRead <= nbt.length);
});

t('TAG_String 根：直接是长度 u16 + 内容', () => {
  const nbt = Buffer.from('080014e4b8ade69687e6b58be8af952050524f42455f32', 'hex');
  const { value } = readRoot(nbt);
  assert.strictEqual(value, '中文测试 PROBE_2');
});

t('旧格式（带根名）仍能被容错：不抛异常即可', () => {
  // 标准 NBT 带空根名：0a 0000 <entries>
  const named = Buffer.from('0a0000080001610000', 'hex');
  let ok = true;
  try { readRoot(named); } catch (e) { ok = false; }
  assert.ok(ok, '解析带根名的 NBT 不应崩');
});

/* ============================================================
 * B. 真实包逐字段解析（按 protocol.json 结构）
 * ============================================================ */
console.log('\n[B] 真实包逐字段解析');

/** 模拟 client.js 里的 readNbtFrom：从 ByteReader 当前位置读匿名 NBT */
function readNbtFrom(r) {
  const { value, bytesRead } = readRoot(r.buf.subarray(r.p));
  r.p += bytesRead;
  return value;
}

t('❗system_chat：content(NBT) + isActionBar(bool) 两段都能读对', () => {
  // 去掉包 ID(79) 后的负载
  const payload = Buffer.from(
    '0a080005636f6c6f720004676f6c6408000474657874000d50524f42455f54454c4c5241570000',
    'hex');
  const r = new ByteReader(payload);
  const node = readNbtFrom(r);
  assert.strictEqual(componentToText(node), 'PROBE_TELLRAW');
  // 末尾应还剩 1 字节的 isActionBar
  assert.strictEqual(r.remaining, 1, 'NBT 之后应恰好剩 1 字节，实际 ' + r.remaining);
  assert.strictEqual(r.bool(), false, 'isActionBar 应为 false');
});

t('❗profileless_chat：message + type + name + target 四段都能走对', () => {
  // 真实抓包 0x21：21 08 0012"PROBE_SERVER_SAY_1" 05 08 0006"Server" 00
  const payload = Buffer.from(
    '08001250524f42455f5345525645525f5341595f310508000653657276657200',
    'hex');
  const r = new ByteReader(payload);

  const msgNode = readNbtFrom(r);
  assert.strictEqual(componentToText(msgNode), 'PROBE_SERVER_SAY_1', 'message 应为探测消息');

  const typeId = r.varint();                 // ChatTypesHolder：非 0 = 引用注册表
  assert.strictEqual(typeId, 5, 'type 应为 5，实际 ' + typeId);

  const nameNode = readNbtFrom(r);
  assert.strictEqual(componentToText(nameNode), 'Server', 'name 应为 Server');

  assert.strictEqual(r.remaining, 1, 'target 前应剩 1 字节');
  assert.strictEqual(r.bool(), false, 'target 应为「不存在」');
  assert.strictEqual(r.remaining, 0, '整包应恰好读完');
});

t('❗profileless_chat 中文消息（真实抓包第二条）', () => {
  const payload = Buffer.from(
    '080014e4b8ade69687e6b58be8af952050524f42455f320508000653657276657200',
    'hex');
  const r = new ByteReader(payload);
  assert.strictEqual(componentToText(readNbtFrom(r)), '中文测试 PROBE_2');
  assert.strictEqual(r.varint(), 5);
  assert.strictEqual(componentToText(readNbtFrom(r)), 'Server');
  assert.strictEqual(r.bool(), false);
  assert.strictEqual(r.remaining, 0, '整包应读完');
});

/* ============================================================
 * C. player_chat 的签名字段（旧代码在此处错位）
 * ============================================================ */
console.log('\n[C] player_chat 签名字段');

t('❗签名存在时，必须跳过 256 字节再读正文', () => {
  // 构造：globalIndex(1) senderUuid(16B) index(0) sig=真(256B) plainMessage
  const { ByteWriter } = require('./proto');
  const w = new ByteWriter();
  w.varint(1);                                  // globalIndex
  w.raw(Buffer.alloc(16, 0xab));                // senderUuid
  w.varint(0);                                  // index
  w.bool(true);                                 // 签名存在
  w.raw(Buffer.alloc(256, 0xcd));               // 256 字节签名
  w.str('hello world');                         // plainMessage
  const buf = w.build();

  const r = new ByteReader(buf);
  r.varint(); r.uuid(); r.varint();
  const hasSig = r.bool();
  assert.strictEqual(hasSig, true);
  if (hasSig) r.raw(256);
  const plain = r.str();
  assert.strictEqual(plain, 'hello world',
    '跳过签名后应正确读到正文，实际: ' + JSON.stringify(plain));
});

t('签名不存在时直接读正文', () => {
  const { ByteWriter } = require('./proto');
  const w = new ByteWriter();
  w.varint(1); w.raw(Buffer.alloc(16, 0xab)); w.varint(0);
  w.bool(false);
  w.str('no signature');
  const r = new ByteReader(w.build());
  r.varint(); r.uuid(); r.varint();
  const hasSig = r.bool();
  assert.strictEqual(hasSig, false);
  if (hasSig) r.raw(256);
  assert.strictEqual(r.str(), 'no signature');
});

/* ============================================================
 * D. 包 ID 与官方定义一致（防上游漂移）
 * ============================================================ */
console.log('\n[D] 聊天相关包 ID');

t('system_chat = 0x79（官方）', () => {
  assert.strictEqual(P.playSystemChat, 0x79);
});
t('player_chat = 0x41（官方）', () => {
  assert.strictEqual(P.playPlayerChat, 0x41);
});
t('❗profileless_chat = 0x21（官方，原先完全没处理）', () => {
  assert.strictEqual(P.playProfilelessChat, 0x21);
});
t('action_bar = 0x57（官方）', () => {
  assert.strictEqual(P.playActionBar, 0x57);
});

/* ============================================================
 * E. 边界与健壮性
 * ============================================================ */
console.log('\n[E] 边界与健壮性');

t('截断的 NBT 抛错而不是返回垃圾', () => {
  const truncated = Buffer.from('0a080005636f6c6f720004676f', 'hex');
  let threw = false;
  try { readRoot(truncated); } catch (e) { threw = true; }
  assert.ok(threw, '截断数据应抛错');
});

t('空 buffer 不崩', () => {
  assert.strictEqual(decodeComponent(Buffer.alloc(0)), null);
});

t('深层嵌套不栈溢出', () => {
  /* 匿名格式里，一个 compound 的**值**就是「若干字段 + 结尾 00」（类型字节在读字段时已消费）。
   * 所以第 0 层（空 compound）的值 = `00`；
   * 每包一层：`0a`(字段类型) + `0001`(名长) + `61`("a") + 内层值 + `00`(收尾) */
  let body = Buffer.from([0x00]);                 // 最内层：立刻结束
  for (let i = 0; i < 60; i++) {
    body = Buffer.concat([Buffer.from('0a000161', 'hex'), body, Buffer.from([0x00])]);
  }
  const deep = Buffer.concat([Buffer.from([0x0a]), body]);   // 根是 compound
  let ok = true;
  try { readRoot(deep); } catch (e) { ok = false; }
  assert.ok(ok, '深层嵌套不应抛异常');
});

t('ChatTypesHolder 非 0 引用：后面没有内联字节', () => {
  // 从真实包验证：05 之后紧跟的就是 name 的 08
  const payload = Buffer.from('08001250524f42455f5345525645525f5341595f310508000653657276657200', 'hex');
  const r = new ByteReader(payload);
  readNbtFrom(r);                     // message
  const before = r.remaining;
  const id = r.varint();
  assert.ok(id !== 0);
  assert.strictEqual(r.remaining, before - 1, '非 0 引用只占 1 字节');
});

/* ============================================================
 * F. 配置阶段兼容与只接收约束
 * ============================================================ */
console.log('\n[F] 配置阶段兼容与只接收约束');

t('配置阶段 Cookie 请求回空值，不发送业务数据', () => {
  const c = new MCClient({ log: () => {} });
  const sent = [];
  c.send = (id, build) => {
    const w = new ByteWriter();
    if (build) build(w);
    sent.push({ id, body: w.build() });
  };
  const request = new ByteReader(new ByteWriter().str('minecraft:test').build());
  c.onConfigPacket(P.cfgCookieRequest, request);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].id, P.cfgCookieResponse);
  const reply = new ByteReader(sent[0].body);
  assert.strictEqual(reply.str(), 'minecraft:test');
  assert.strictEqual(reply.bool(), false, 'Cookie 应返回 absent，而不是业务内容');
});

t('收到配置完成包后进入 Play', () => {
  const events = [];
  const c = new MCClient({ log: () => {}, onEvent: (ev) => events.push(ev) });
  c.send = () => {};
  c.state = 'config';
  c.onConfigPacket(P.cfgFinishC, new ByteReader(Buffer.alloc(0)));
  assert.strictEqual(c.state, 'play');
  assert.ok(events.includes('join'));
  c.close();
});

t('接收 system_chat 只触发 onChat，不调用发送接口', () => {
  const chats = [];
  let sends = 0;
  const c = new MCClient({ log: () => {}, onChat: (text) => chats.push(text) });
  c.send = () => { sends++; };
  c.state = 'play';
  const payload = Buffer.from(
    '0a080005636f6c6f720004676f6c6408000474657874000d50524f42455f54454c4c524157000000',
    'hex');
  c.onPlayPacket(P.playSystemChat, new ByteReader(payload));
  assert.deepStrictEqual(chats, ['PROBE_TELLRAW']);
  assert.strictEqual(sends, 0, '聊天接收路径不得发送聊天或命令');
});

for (const state of ['config', 'play']) {
  for (const forced of [false, true]) {
    t(state + ' resource pack: accepted then completed, no chat/commands', () => {
      const c = new MCClient({ log: () => {} });
      c.state = state;
      const sent = [];
      c.send = (id, build) => {
        const w = new ByteWriter();
        build(w);
        sent.push({ id, body: w.build() });
      };
      c.say = c.command = () => { throw new Error('No chat/commands allowed'); };
      const uuid = '12345678-1234-1234-1234-123456789abc';
      const request = new ByteWriter().uuid(uuid).str('https://example.invalid/pack.zip')
        .str('a'.repeat(40)).bool(forced).bool(true)
        .raw(Buffer.from('08000670726f6d7074', 'hex')).build();
      const r = new ByteReader(request);
      if (state === 'config') c.onConfigPacket(P.cfgResourcePackC, r);
      else c.onPlayPacket(P.playResourcePackC, r);
      assert.strictEqual(r.remaining, 0);
      assert.strictEqual(sent.length, 2);
      const statuses = sent.map((packet) => {
        assert.strictEqual(packet.id, state === 'config' ? P.cfgResourcePack : P.playResourcePack);
        const reply = new ByteReader(packet.body);
        assert.strictEqual(reply.uuid(), uuid);
        const status = reply.varint();
        assert.strictEqual(reply.remaining, 0);
        return status;
      });
      assert.deepStrictEqual(statuses, [3, 0]);
      assert.strictEqual(c.state, state);
      c.close();
    });
  }
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
process.exit(fail === 0 ? 0 : 1);
