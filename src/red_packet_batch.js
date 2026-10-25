'use strict';

const PREFIX = /^\s*[\[\u3010]\u7ea2\u5305[\]\u3011]\s*/;
const PACKET_START = /^(?:\u73a9\u5bb6\s+)?(\S+)\s+\u53d1\u9001\u4e86(?:\s*\u4e00\u4e2a)?\s+(.+?\u7ea2\u5305)(?:\s|$)/;
const PACKET_CLAIM = /^(\S+?)\s*\u9886\u53d6\u4e86\s*(\S+?)\s*\u53d1\u9001\u7684\s*(.+?)(?:\uff0c|,|\s|$)/;
const AMOUNT = /\u91d1\u989d\s*[\uff1a:]\s*(.+?)(?=\s*\u91d1\u5e01|$)/;

function parseRedPacket(text, type, origin) {
  if (typeof text !== 'string' || !PREFIX.test(text) || type === 'player' || type === 'mine' || origin === 'player') return null;
  const body = text.replace(PREFIX, '').trim();
  const start = body.match(PACKET_START);
  if (start) return { kind: 'start', publisher: start[1], packetType: start[2], body };
  const claim = body.match(PACKET_CLAIM);
  if (claim) return {
    kind: 'claim', claimant: claim[1], publisher: claim[2], body,
    amount: (body.match(AMOUNT) || [])[1] || '',
  };
  return null;
}

class RedPacketClaimBatch {
  constructor({ onRecord = () => {}, onFlush = () => {}, now = Date.now,
    setTimer = setTimeout, clearTimer = clearTimeout, windowMs = 10000 } = {}) {
    Object.assign(this, { onRecord, onFlush, now, setTimer, clearTimer, windowMs });
    this.batches = new Map();
    this.latest = new Map();
    this.nextId = 0;
  }

  record(detail, extra = {}) { this.onRecord({ status: 'observed', detail, t: this.now(), ...extra }); }

  reset() {
    for (const batch of this.batches.values()) this.clearTimer(batch.timer);
    this.batches.clear();
    this.latest.clear();
  }

  key(serverKey, session, publisher) { return [serverKey, session, publisher].join('|'); }

  flush(key, reason = 'timeout') {
    const batch = this.batches.get(key);
    if (!batch) return;
    this.batches.delete(key);
    if (this.latest.get(batch.group) === key) this.latest.delete(batch.group);
    this.clearTimer(batch.timer);
    const lines = batch.claims.map((claim) => claim.text);
    this.record(`${batch.publisher} 红包 10 秒内记录 ${batch.claims.length} 人领取`
      + (lines.length ? '\n' + lines.join('\n') : ''), {
      publisher: batch.publisher, count: batch.claims.length, reason,
    });
    this.onFlush(batch.claims.map((claim) => ({ ...claim })));
  }

  handle({ text, type = 'system', origin = null, meta = null, serverKey = '', session = '' } = {}) {
    const parsed = parseRedPacket(text, type, origin);
    if (!parsed) return { suppress: false };
    if (parsed.kind === 'start') {
      const group = this.key(serverKey, session, parsed.publisher);
      const key = group + '|' + (++this.nextId);
      const batch = {
        key, group, serverKey, session, publisher: parsed.publisher,
        packetType: parsed.packetType, claims: [], claimants: new Set(), timer: null,
        expiresAt: this.now() + this.windowMs,
      };
      batch.timer = this.setTimer(() => this.flush(key), this.windowMs);
      this.batches.set(key, batch);
      this.latest.set(group, key);
      this.record(`发现 ${parsed.publisher} 发送的${parsed.packetType}，开始收集 10 秒内领取记录`, {
        publisher: parsed.publisher, packetType: parsed.packetType,
      });
      return { suppress: false, publisher: parsed.publisher };
    }

    const key = this.latest.get(this.key(serverKey, session, parsed.publisher));
    const batch = this.batches.get(key);
    if (!batch) return { suppress: false };
    if (this.now() >= batch.expiresAt) {
      this.flush(key);
      return { suppress: false };
    }
    if (!batch.claimants.has(parsed.claimant.toLowerCase())) {
      batch.claimants.add(parsed.claimant.toLowerCase());
      batch.claims.push({
        text: String(text), meta: meta ? { ...meta } : null,
        t: this.now(), claimant: parsed.claimant, publisher: parsed.publisher,
        amount: parsed.amount,
      });
    }
    return { suppress: true, publisher: parsed.publisher, claimant: parsed.claimant };
  }
}

module.exports = { RedPacketClaimBatch, parseRedPacket };
