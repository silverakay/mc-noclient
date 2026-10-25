'use strict';
/*
 * proto.js —— Minecraft Java 版网络协议的底层读写原语
 * 目标版本：26.2（协议号 776）
 *
 * 只实现「够用」的部分：VarInt、字符串、UUID、以及带压缩的包封包/解包。
 * 无第三方依赖。
 */

class ByteWriter {
  constructor() { this.chunks = []; this.len = 0; }
  buf(b) { this.chunks.push(b); this.len += b.length; return this; }
  u8(v) { const b = Buffer.allocUnsafe(1); b.writeUInt8(v & 0xff); return this.buf(b); }
  i8(v) { const b = Buffer.allocUnsafe(1); b.writeInt8(v); return this.buf(b); }
  u16(v) { const b = Buffer.allocUnsafe(2); b.writeUInt16BE(v & 0xffff); return this.buf(b); }
  i16(v) { const b = Buffer.allocUnsafe(2); b.writeInt16BE(v); return this.buf(b); }
  i32(v) { const b = Buffer.allocUnsafe(4); b.writeInt32BE(v); return this.buf(b); }
  i64(v) { const b = Buffer.allocUnsafe(8); b.writeBigInt64BE(BigInt(v)); return this.buf(b); }
  f32(v) { const b = Buffer.allocUnsafe(4); b.writeFloatBE(v); return this.buf(b); }
  f64(v) { const b = Buffer.allocUnsafe(8); b.writeDoubleBE(v); return this.buf(b); }
  bool(v) { return this.u8(v ? 1 : 0); }

  varint(v) {
    v = v >>> 0;                       // 负数的补码形式
    const out = [];
    for (;;) {
      if ((v & ~0x7f) === 0) { out.push(v); break; }
      out.push((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    return this.buf(Buffer.from(out));
  }

  str(s) {
    const b = Buffer.from(String(s), 'utf8');
    this.varint(b.length);
    return this.buf(b);
  }

  raw(b) { return this.buf(Buffer.from(b)); }

  uuid(u) {                            // 16 字节，网络字节序
    const hex = String(u).replace(/-/g, '');
    return this.buf(Buffer.from(hex, 'hex'));
  }

  build() { return Buffer.concat(this.chunks, this.len); }
}

class ByteReader {
  constructor(buf) { this.buf = buf; this.p = 0; }
  get remaining() { return this.buf.length - this.p; }
  u8() { return this.buf.readUInt8(this.p++); }
  i8() { return this.buf.readInt8(this.p++); }
  u16() { const v = this.buf.readUInt16BE(this.p); this.p += 2; return v; }
  i16() { const v = this.buf.readInt16BE(this.p); this.p += 2; return v; }
  i32() { const v = this.buf.readInt32BE(this.p); this.p += 4; return v; }
  i64() { const v = this.buf.readBigInt64BE(this.p); this.p += 8; return v; }
  f32() { const v = this.buf.readFloatBE(this.p); this.p += 4; return v; }
  f64() { const v = this.buf.readDoubleBE(this.p); this.p += 8; return v; }
  bool() { return this.u8() !== 0; }
  raw(n) { const v = this.buf.subarray(this.p, this.p + n); this.p += n; return v; }

  varint() {
    let result = 0, shift = 0;
    for (;;) {
      const b = this.u8();
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift > 35) throw new Error('VarInt 过长');
    }
    return result | 0;
  }

  str() {
    const len = this.varint();
    if (len < 0 || len > this.remaining) throw new Error('字符串长度非法: ' + len);
    return this.raw(len).toString('utf8');
  }

  uuid() {
    const b = this.raw(16);
    const h = b.toString('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
}

/* ============================================================
 * 包封包 / 解包（26.2 规则）
 * 有压缩时：外层 = VarInt(解压后长度) + [zlib 数据]
 *           长度 0 表示「未压缩直发」，后面直接跟包体
 * ============================================================ */

const zlib = require('zlib');

/** 把一个包体（含 packetId 的 VarInt）封成要写入 socket 的字节流 */
function encodePacket(payload, threshold) {
  if (threshold >= 0) {
    if (payload.length >= threshold) {
      const compressed = zlib.deflateSync(payload);
      const w = new ByteWriter();
      w.varint(payload.length);      // 解压后长度
      w.raw(compressed);
      const body = w.build();
      const out = new ByteWriter();
      out.varint(body.length);
      out.raw(body);
      return out.build();
    }
    // 小包不压缩：长度填 0，后面跟原始包体
    const out = new ByteWriter();
    out.varint(payload.length + 1);  // 1 = 那个 0 长度字节
    out.varint(0);
    out.raw(payload);
    return out.build();
  }
  const out = new ByteWriter();
  out.varint(payload.length);
  out.raw(payload);
  return out.build();
}

/* ---- 流式解包器：TCP 会粘包/半包，必须靠缓冲区累积 ---- */
class PacketDecoder {
  constructor() { this.buf = Buffer.alloc(0); this.threshold = -1; }

  /**
   * 喂入新数据并尽量解出所有完整包。
   *
   * ❗关键：压缩阈值（threshold）是「服务端的 Set Compression 包」中途才告知的。
   *   如果一次性把整个 chunk 解完，那么排在 Set Compression 之后的那些
   *   「已经按压缩格式封装」的包，会被用旧的 threshold=-1 去解 —— 得到垃圾。
   *   因此必须支持「边解边回调」：每解出一个包就立刻交给上层处理，
   *   上层更新 threshold 后，剩余字节才会用新阈值继续解。
   *
   * @param {Buffer} chunk
   * @param {(body: Buffer) => void} [onPacket] 若提供，则按序即时回调；
   *        返回空数组，调用方不必再遍历。
   */
  push(chunk, onPacket) {
    this.buf = Buffer.concat([this.buf, chunk]);
    return this.drain(onPacket);
  }

  /** 兼容旧调用：返回本次能解析出的所有包体（不带即时回调） */
  drain(onPacket) {
    const out = [];
    for (;;) {
      const frame = this.tryReadFrame();
      if (!frame) break;
      if (onPacket) onPacket(frame);
      else out.push(frame);
    }
    return out;
  }

  tryReadFrame() {
    const len = tryReadVarInt(this.buf, 0);
    if (!len) return null;
    if (len.value < 0 || len.value > 8 * 1024 * 1024) throw new Error('包长度非法: ' + len.value);
    const total = len.size + len.value;
    if (this.buf.length < total) return null;             // 还没收全

    const body = this.buf.subarray(len.size, total);
    this.buf = this.buf.subarray(total);

    if (this.threshold >= 0) {
      const r = new ByteReader(body);
      const uncompressedLen = r.varint();
      if (uncompressedLen === 0) {
        return Buffer.from(body.subarray(r.p));            // 未压缩直发
      }
      let inflated;
      try {
        inflated = zlib.inflateSync(body.subarray(r.p));
      } catch (e) {
        // 损坏的压缩数据：不要抛穿整个 drain 循环（否则缓冲区状态会与
        // 已消费的帧错位）。抛一个带标记的错误，交给上层决定是否断开。
        const err = new Error('解压失败（数据损坏或阈值不同步）: ' + e.message);
        err.code = 'BAD_ZLIB';
        throw err;
      }
      if (inflated.length !== uncompressedLen) {
        // 长度不符：记录但不中断，交给上层按内容判断
        const err = new Error(
          `解压后长度不符: 声明 ${uncompressedLen} 实际 ${inflated.length}`);
        err.code = 'LEN_MISMATCH';
        // 仍然返回数据 —— 有些服务端会算错，内容通常还是可用的
        err.partial = inflated;
        this.lastWarn = err;
        return inflated;
      }
      return inflated;
    }
    return Buffer.from(body);
  }
}

/** 尝试读一个 VarInt；不足则返回 null */
function tryReadVarInt(buf, offset) {
  let result = 0, shift = 0, i = offset;
  for (;;) {
    if (i >= buf.length) return null;
    const b = buf[i++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 35) return null;
  }
  return { value: result | 0, size: i - offset };
}

/* ============================================================
 * 26.2 包 ID 表（从官方协议定义提取，仅列本项目用到的）
 * ============================================================ */

const PACKET_ID = {
  // 握手 → 登录
  handshake:          0x00,
  // 状态查询
  statusRequest:      0x00,
  statusPing:         0x01,

  // 登录阶段：客户端 → 服务端
  loginStart:         0x00,
  loginEncryptionResponse: 0x01,   // 正版验证的应答包
  loginAcknowledged:  0x03,
  loginCookieResponse: 0x04,
  // 登录阶段：服务端 → 客户端
  loginDisconnect:    0x00,
  loginEncryption:    0x01,   // 出现 == 正版验证服，本工具无法登录
  loginSuccess:       0x02,
  loginCompress:      0x03,
  loginPluginRequest: 0x04,
  loginCookieRequest: 0x05,

  // 配置阶段：客户端 → 服务端
  cfgSettings:        0x00,
  cfgCookieResponse:  0x01,
  cfgCustomPayload:   0x02,
  cfgFinish:          0x03,
  cfgKeepAlive:       0x04,
  cfgPong:            0x05,
  cfgResourcePack:    0x06,
  cfgSelectKnown:     0x07,
  cfgAcceptConduct:   0x09,
  // 配置阶段：服务端 → 客户端
  cfgCookieRequest:   0x00,
  cfgCustomPayloadC:  0x01,
  cfgDisconnect:      0x02,
  cfgFinishC:         0x03,
  cfgKeepAliveC:      0x04,
  cfgPing:            0x05,
  cfgResetChat:       0x06,
  cfgRegistryData:    0x07,
  cfgRemoveResourcePackC: 0x08,
  cfgResourcePackC:   0x09,
  cfgStoreCookie:     0x0a,
  cfgTransfer:        0x0b,
  cfgFeatureFlags:    0x0c,
  cfgTags:            0x0d,
  cfgSelectKnownC:    0x0e,
  cfgCustomReportDetails: 0x0f,
  cfgServerLinks:     0x10,
  cfgClearDialog:     0x11,
  cfgShowDialog:      0x12,
  cfgCodeOfConduct:   0x13,

  // Play 阶段：客户端 → 服务端
  playTeleportConfirm: 0x00,
  playChatAck:         0x06,
  playChatCommand:     0x07,
  playChatMessage:     0x09,
  playClientCommand:   0x0c,
  playSettings:        0x0e,
  playTabComplete:     0x0f,
  playConfigurationAcknowledged: 0x10,
  playWindowClick:     0x12,
  playCloseWindow:     0x13,
  playCustomPayload:   0x16,
  playKeepAlive:       0x1c,
  playPosition:        0x1e,
  playPositionLook:    0x1f,
  playFlying:          0x21,
  playPlayerAction:    0x29,
  playPlayerInput:     0x2b,
  playPlayerLoaded:    0x2c,
  playPong:            0x2d,
  playResourcePack:    0x31,
  // Play 阶段：服务端 → 客户端
  playTabCompleteC:    0x0f,
  playCloseWindowC:    0x11,
  playWindowItemsC:    0x12,
  playSetSlotC:        0x14,
  playSetCursorC:      0x60,
  playCustomPayloadC:  0x18,
  playKeepAliveC:      0x2c,
  playLogin:           0x31,
  playKick:            0x20,
  playOpenWindowC:     0x3b,
  playPlayerRemoveC:   0x45,
  playPlayerInfoC:     0x46,
  playRespawnC:        0x52,
  playSystemChat:      0x79,
  playPlayerChat:      0x41,
  /* ❗profileless_chat(0x21) 是「没有档案的聊天」：服务端控制台 /say、
     NPC、部分插件广播走这个包。实测 26.2 服务端 `say` 命令发的就是它，
     不处理的话这类消息一条都收不到。
     （与上行 playFlying 同号，但方向不同，互不影响） */
  playProfilelessChat: 0x21,
  playActionBar:       0x57,
  playPositionC:       0x48,
  playRemoveResourcePackC: 0x50,
  playResourcePackC:    0x51,
  playStartConfig:     0x76,
  playPingC:           0x3d,
};

const PROTOCOL_VERSION = 776;   // MC 26.2
const MC_VERSION = '26.2';

module.exports = {
  ByteWriter, ByteReader, PacketDecoder,
  encodePacket, tryReadVarInt,
  PACKET_ID, PROTOCOL_VERSION, MC_VERSION,
};
