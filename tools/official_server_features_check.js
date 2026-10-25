'use strict';

// Direct comparison against the local official 26.2 jar. No server or account.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { MCClient } = require('../src/client');
const { ByteReader, ByteWriter, PACKET_ID: P } = require('../src/proto');
const { ServerFeatures } = require('../src/server_features');
const root = path.resolve(__dirname, '..');
const javaBin = process.env.MC_JAVA_BIN || path.join(process.env.APPDATA, '.minecraft', 'runtime', 'java-runtime-epsilon', 'bin');
const jar = path.join(root, 'testserver', 'versions', '26.2', 'server-26.2.jar');
function jarFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? jarFiles(file) : entry.name.endsWith('.jar') ? [file] : [];
  });
}
const registration = execFileSync(path.join(javaBin, 'javap.exe'), ['-classpath', jar, '-c', '-p',
  'net.minecraft.network.protocol.game.GameProtocols'], { encoding: 'utf8', windowsHide: true });
for (const [direction, expected] of [
  ['CLIENTBOUND', { COMMAND_SUGGESTIONS: P.playTabCompleteC, CONTAINER_CLOSE: P.playCloseWindowC,
    CONTAINER_SET_CONTENT: P.playWindowItemsC, CONTAINER_SET_SLOT: P.playSetSlotC, CUSTOM_PAYLOAD: P.playCustomPayloadC,
    OPEN_SCREEN: P.playOpenWindowC, PLAYER_INFO_REMOVE: P.playPlayerRemoveC, PLAYER_INFO_UPDATE: P.playPlayerInfoC,
    RESPAWN: P.playRespawnC }],
  ['SERVERBOUND', { CHAT_ACK: P.playChatAck, COMMAND_SUGGESTION: P.playTabComplete,
    CONTAINER_CLOSE: P.playCloseWindow, CUSTOM_PAYLOAD: P.playCustomPayload, PLAYER_LOADED: P.playPlayerLoaded }],
]) {
  const names = [...registration.matchAll(new RegExp('Field [^;\\n]+\\.(' + direction + '_[A-Z0-9_]+):Lnet/minecraft/network/protocol/PacketType;', 'g'))].map((match) => match[1]);
  for (const [name, id] of Object.entries(expected)) {
    assert.equal(names.indexOf(direction + '_' + name), id, name);
    console.log('PASS official ID ' + direction + '_' + name + ' 0x' + id.toString(16));
  }
}
const client = new MCClient(); client.state = 'play';
const sent = [];
client.send = (id, build) => {
  const w = new ByteWriter(); if (build) build(w); sent.push({ id, data: w.build() });
};
for (let i = 1; i <= 68; i++) {
  const w = new ByteWriter(); w.varint(i); w.uuid('00000000-0000-0000-0000-000000000001'); w.varint(i); w.bool(true);
  const signature = Buffer.alloc(256); signature.writeInt32BE(i); w.buf(signature); w.str('offline fixture');
  client.onPlayPacket(P.playPlayerChat, new ByteReader(w.build()));
  if (i <= 65) client.onPlayPacket(P.playPlayerChat, new ByteReader(w.build()));
}
client.say('offline codec fixture');
assert.equal(sent.length, 2);
const classpath = [jar, ...jarFiles(path.join(root, 'testserver', 'libraries'))].join(path.delimiter);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-official-features-'));
const output = execFileSync(path.join(javaBin, 'java.exe'), ['--class-path', classpath,
  path.join(__dirname, 'OfficialChatCodecCheck.java'), 'features', sent[0].data.toString('base64'), sent[1].data.toString('base64')],
{ cwd: temporary, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
assert.ok(output.includes('FEATURE_ACK_VALID 65 20')); console.log('PASS official ACK and last-seen validator');
const packets = Object.fromEntries([...output.matchAll(/^FEATURE_PACKET ([\w-]+) ([A-Za-z0-9+/=]+)$/gm)]
  .map(([, name, data]) => [name, Buffer.from(data, 'base64')]));
const features = new ServerFeatures(); features.playerInfo(packets.players);
assert.equal(features.getPlayers()[0].name, 'CodecPlayer');
assert.equal(features.getPlayers()[0].priority, 300); assert.equal(features.getPlayers()[0].displayName, 'Codec display');
features.openMenu(packets.menu); features.windowItems(packets.contents);
assert.equal(features.menu.id, 300); assert.equal(features.menu.title, 'Codec menu');
assert.equal(features.menu.slots.length, 45); assert.equal(features.menu.slots[0].name, 'Codec item');
assert.equal(features.menu.slots[0].count, 3); assert.deepEqual(features.menu.slots[0].lore, ['Codec lore']);
assert.equal(features.menu.slots[0].identifier, 'minecraft:diamond');
features.setSlot(packets.slot); assert.equal(features.menu.slots[1].identifier, 'minecraft:stone');
console.log('PASS official player list, menu, item components and slot update -> production receiver');
client._lastCompletionAt = 0;
const pending = client.completeCommand('/he');
client._completion.id = 1; client.handleCompletion(new ByteReader(packets.completion));
pending.then((result) => {
  assert.deepEqual(result.matches, [{ text: 'help', tooltip: 'Codec tip' }]);
  console.log('PASS official completion range/text/tooltip -> production receiver');
  console.log('PASS offline official server-features check; no target connections or business sends');
}).catch((e) => { console.error(e); process.exitCode = 1; });
