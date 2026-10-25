'use strict';

const assert = require('assert/strict');
const { MCClient } = require('./client');
const { ByteReader, ByteWriter, PACKET_ID: P } = require('./proto');
const schema = require('../docs/protocol-26.2.json');
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS ' + name); }
function fixture() {
  const chats = [], sent = [], logs = [];
  const client = new MCClient({ onChat: (text, meta) => chats.push({ text, meta }), log: (m) => logs.push(m) });
  client.state = 'play';
  client.send = (id, build) => {
    const writer = new ByteWriter(); if (build) build(writer);
    sent.push({ id, data: writer.build() });
  };
  client.say = client.command = () => { throw new Error('Business sending forbidden'); };
  return { client, chats, sent, logs };
}

// Independent Buffer writer: does not use the production ByteWriter to encode positions.
function position(id, values, flags) {
  const bytes = id < 128 ? Buffer.from([id]) : Buffer.from([(id & 127) | 128, id >> 7]);
  const data = Buffer.alloc(60);
  for (let i = 0; i < 6; i++) data.writeDoubleBE(values[i], i * 8);
  data.writeFloatBE(values[6], 48); data.writeFloatBE(values[7], 52); data.writeUInt32BE(flags, 56);
  return new ByteReader(Buffer.concat([bytes, data]));
}

test('Position schema starts with teleportId and ends with a u32 flags field', () => {
  assert.deepEqual(schema.play.toClient.types.packet_position[1].map((f) => f.name),
    ['teleportId', 'x', 'y', 'z', 'dx', 'dy', 'dz', 'yaw', 'pitch', 'flags']);
  assert.equal(schema.play.toClient.types.PositionUpdateRelatives[1].type, 'u32');
});
test('Multi-byte teleport id and all three velocity fields are consumed correctly', () => {
  const { client, sent } = fixture();
  const reader = position(300, [123.5, 80, -50.25, 0.25, 0.5, -0.75, 90, -30], 0);
  client.onPlayPacket(P.playPositionC, reader);
  assert.equal(reader.remaining, 0);
  assert.deepEqual(client.playerPos, { x: 123.5, y: 80, z: -50.25, yaw: 90, pitch: -30 });
  assert.equal(sent[0].id, P.playTeleportConfirm);
  assert.equal(new ByteReader(sent[0].data).varint(), 300);
  assert.equal(sent[1].id, P.playPositionLook);
  const movement = new ByteReader(sent[1].data);
  assert.deepEqual([movement.f64(), movement.f64(), movement.f64(), movement.f32(), movement.f32(), movement.u8()],
    [123.5, 80, -50.25, 90, -30, 0]);
  assert.equal(movement.remaining, 0);
});
test('Relative updates accumulate only flagged coordinates and rotations', () => {
  const { client } = fixture();
  client.playerPos = { x: 100, y: 70, z: -20, yaw: 90, pitch: 10 };
  client.onPlayPacket(P.playPositionC, position(1, [2, 64, 3, 0, 0, 0, 30, 5], 1 | 4 | 8));
  assert.deepEqual(client.playerPos, { x: 102, y: 64, z: -17, yaw: 120, pitch: 5 });
});
test('Malformed positions are counted and do not send a guessed confirmation', () => {
  const { client, sent } = fixture();
  client.onPlayPacket(P.playPositionC, new ByteReader(Buffer.from([1, 2])));
  assert.equal(sent.length, 0);
  assert.equal(client.getChatDiagnostics().positionErrors, 1);
});
test('All four incoming chat packet paths count malformed payloads before parsing', () => {
  const { client } = fixture();
  for (const id of [P.playPlayerChat, P.playSystemChat, P.playProfilelessChat, P.playActionBar]) {
    client.onPlayPacket(id, new ByteReader(Buffer.alloc(0)));
  }
  const d = client.getChatDiagnostics();
  for (const kind of ['player', 'system', 'profileless', 'actionbar']) {
    assert.equal(d.received[kind], 1); assert.equal(d.errors[kind], 1); assert.equal(d.emitted[kind], 0);
  }
});
test('System packet receipt cannot be reported as a player packet receipt', () => {
  const { client, chats, sent } = fixture();
  client.handlePacket(Buffer.from('7908000568656c6c6f00', 'hex'));
  assert.equal(chats[0].text, 'hello');
  const d = client.getChatDiagnostics();
  assert.equal(d.received.system, 1); assert.equal(d.emitted.system, 1);
  assert.equal(d.received.player, 0); assert.equal(sent.length, 0);
});
test('Signed player body reaches UI even when optional decoration is malformed', () => {
  const { client, chats } = fixture();
  const data = Buffer.concat([Buffer.from('4101000000000000000000000000000000010001', 'hex'),
    Buffer.alloc(256, 0xcd), Buffer.from('0568656c6c6f', 'hex')]);
  client.handlePacket(data);
  assert.equal(chats[0].text, 'hello'); assert.equal(chats[0].meta.type, 'player');
  const d = client.getChatDiagnostics();
  assert.equal(d.received.player, 1); assert.equal(d.emitted.player, 1);
  assert.equal(d.errors.player, 0); assert.equal(d.detailFallbacks, 1);
});
test('Unknown play packet IDs are counted without recording payloads', () => {
  const { client } = fixture(); client.handlePacket(Buffer.from([0x18, 1, 2, 3]));
  const d = client.getChatDiagnostics(); assert.equal(d.playPackets[0x18], 1);
  assert.ok(!JSON.stringify(d).includes('accessToken'));
  d.received.player = 100; assert.equal(client.getChatDiagnostics().received.player, 0);
});
test('Reconfiguration acknowledges play before switching back to configuration', () => {
  const { client, sent } = fixture(); client.onPlayPacket(P.playStartConfig, new ByteReader(Buffer.alloc(0)));
  assert.equal(client.state, 'config'); assert.equal(sent[0].id, 0x10); assert.equal(sent[0].data.length, 0);
});
console.log('=== ' + passed + ' receive/teleport tests passed ===');
