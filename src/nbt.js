'use strict';
/*
 * nbt.js —— 极简 NBT 读取器（只读，够用就行）
 *
 * 用途：26.x 的聊天 / 踢出消息不再用 JSON，而是用 NBT 文本组件。
 *      所以必须能解析 NBT。
 * 参考：Minecraft 网络 NBT 格式（根节点是 tag-type + name 的匿名形式）
 */

const TAG = {
  END: 0, BYTE: 1, SHORT: 2, INT: 3, LONG: 4, FLOAT: 5,
  DOUBLE: 6, BYTE_ARRAY: 7, STRING: 8, LIST: 9,
  COMPOUND: 10, INT_ARRAY: 11, LONG_ARRAY: 12,
};
const { componentToText, componentToRuns } = require('./chat_component');

class Reader {
  constructor(buf, offset = 0) {
    this.buf = buf;
    this.p = offset;
  }
  /* 定点读取都要先确认剩余长度 —— 否则 Node 会抛原始 RangeError，
     上层看到的是 "offset is out of range" 这种无法定位的报错。 */
  _need(n) {
    if (this.p + n > this.buf.length) {
      throw new Error(`NBT 越界: ${n} 字节读取在偏移 ${this.p} 处超出（总长 ${this.buf.length}）`);
    }
  }
  u8() { this._need(1); return this.buf.readUInt8(this.p++); }
  i8() { this._need(1); return this.buf.readInt8(this.p++); }
  i16() { this._need(2); const v = this.buf.readInt16BE(this.p); this.p += 2; return v; }
  u16() { this._need(2); const v = this.buf.readUInt16BE(this.p); this.p += 2; return v; }
  i32() { this._need(4); const v = this.buf.readInt32BE(this.p); this.p += 4; return v; }
  i64() { this._need(8); const v = this.buf.readBigInt64BE(this.p); this.p += 8; return v; }
  f32() { this._need(4); const v = this.buf.readFloatBE(this.p); this.p += 4; return v; }
  f64() { this._need(8); const v = this.buf.readDoubleBE(this.p); this.p += 8; return v; }
  raw(n) {
    if (n < 0) throw new Error('NBT raw 长度为负: ' + n);
    this._need(n);
    const v = this.buf.subarray(this.p, this.p + n);
    this.p += n;
    return v;
  }
  str() {
    const len = this.u16();               // 无符号短整型长度
    return this.raw(len).toString('utf8');
  }
  payload(type, depth = 0) {
    // 防栈溢出：服务端可以构造任意深度的嵌套 compound/list 让客户端崩掉。
    // 真实的聊天/踢出消息嵌套极少超过 10 层。
    if (depth > 512) throw new Error('NBT 嵌套过深（>512 层），疑似恶意数据');
    switch (type) {
      case TAG.BYTE: return this.i8();
      case TAG.SHORT: return this.i16();
      case TAG.INT: return this.i32();
      case TAG.LONG: return this.i64();
      case TAG.FLOAT: return this.f32();
      case TAG.DOUBLE: return this.f64();
      case TAG.BYTE_ARRAY: { const n = this.i32(); return Buffer.from(this.raw(n)); }
      case TAG.STRING: return this.str();
      case TAG.LIST: {
        const itemType = this.u8();
        const n = this.i32();
        if (n < 0) throw new Error('NBT 列表长度为负: ' + n);
        // 防御：每个元素至少 1 字节，长度不可能超过剩余字节数
        if (n > this.buf.length - this.p) {
          throw new Error('NBT 列表长度越界: ' + n);
        }
        const out = [];
        for (let i = 0; i < n; i++) out.push(this.payload(itemType, depth + 1));
        return out;
      }
      case TAG.COMPOUND: {
        const out = {};
        for (;;) {
          const t = this.u8();
          if (t === TAG.END) break;
          const name = this.str();
          out[name] = this.payload(t, depth + 1);
        }
        return out;
      }
      case TAG.INT_ARRAY: {
        const n = this.i32();
        if (n < 0 || n > (this.buf.length - this.p) / 4) throw new Error('NBT int 数组长度越界: ' + n);
        const o = []; for (let i = 0; i < n; i++) o.push(this.i32()); return o;
      }
      case TAG.LONG_ARRAY: {
        const n = this.i32();
        if (n < 0 || n > (this.buf.length - this.p) / 8) throw new Error('NBT long 数组长度越界: ' + n);
        const o = []; for (let i = 0; i < n; i++) o.push(this.i64()); return o;
      }
      default: throw new Error('未知 NBT tag: ' + type);
    }
  }
}

/**
 * 读取根节点。
 *
 * ❗关键：26.x 的网络 NBT 是**匿名格式（anonymousNbt）—— 根节点没有名字**。
 *   标准 NBT（存档文件那种）结构是：[type][name长度u16][name][payload]，
 *   而网络 NBT 省掉了根名，直接是 [type][payload]。
 *
 *   这个差异极其隐蔽：多读一个「根名」不会立刻报错，而是把 payload 的前 2 字节
 *   当成名字长度。比如真实聊天包 `0a 08 0005 "color" ...`（0a=compound）：
 *     - 正确解析：跳过 0a → 第一个子标签 08(TAG_String) 名字 "color"
 *     - 错误解析：把 `08 00` 当名字长度 = 0x0800 = 2048 → 越界 → 抛错
 *   抛出的错被 decodeComponent 吞掉变成 null，表现为**聊天消息凭空消失**。
 *
 *   实测证据（真实 26.2 服务端 tellraw 广播）：
 *     79 0a 08 0005"color" 0004"gold" 08 0004"text" 000d"PROBE_TELLRAW" 00 00
 *   对照 protocol.json：packet_system_chat 的 content 类型就是 anonymousNbt。
 */
function readRoot(buf) {
  const r = new Reader(buf);
  const type = r.u8();
  if (type === TAG.END) return { value: null, bytesRead: 1 };
  const value = r.payload(type);      // 匿名 NBT：没有根名，直接读 payload
  return { value, bytesRead: r.p };
}

/** 一步到位：字节 → 纯文本 */
function decodeComponent(buf) {
  try {
    const { value } = readRoot(buf);
    return componentToText(value);
  } catch (e) {
    return null;
  }
}

module.exports = { TAG, Reader, readRoot, componentToText, componentToRuns, decodeComponent };
