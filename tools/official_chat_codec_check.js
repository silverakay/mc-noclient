'use strict';

// Uses an already downloaded official server jar; never starts a Minecraft server.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { MCClient } = require('../src/client');
const { ByteWriter, PACKET_ID: P } = require('../src/proto');

const root = path.resolve(__dirname, '..');
const javaBin = process.env.MC_JAVA_BIN || path.join(process.env.APPDATA || '',
  '.minecraft', 'runtime', 'java-runtime-epsilon', 'bin');
const jar = path.join(root, 'testserver', 'versions', '26.2', 'server-26.2.jar');
function jarFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? jarFiles(file) : entry.name.endsWith('.jar') ? [file] : [];
  });
}
function run(exe, args, cwd) {
  return execFileSync(path.join(javaBin, exe + (process.platform === 'win32' ? '.exe' : '')),
    args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
}

const registration = run('javap', ['-classpath', jar, '-c', '-p',
  'net.minecraft.network.protocol.game.GameProtocols'], root);
const names = [...registration.matchAll(/Field [^;\n]+\.(CLIENTBOUND_[A-Z0-9_]+):Lnet\/minecraft\/network\/protocol\/PacketType;/g)]
  .map((match) => match[1]);
assert.equal(names[0], 'CLIENTBOUND_BUNDLE');
for (const [field, id] of [
  ['CLIENTBOUND_PLAYER_CHAT', P.playPlayerChat], ['CLIENTBOUND_SYSTEM_CHAT', P.playSystemChat],
  ['CLIENTBOUND_DISGUISED_CHAT', P.playProfilelessChat], ['CLIENTBOUND_PLAYER_POSITION', P.playPositionC],
]) {
  assert.equal(names.indexOf(field), id, 'Official registration ID for ' + field);
  console.log('PASS official ID ' + field + ' = 0x' + id.toString(16));
}

const settings = new MCClient();
settings.state = 'play';
let settingsBytes;
settings.send = (_id, build) => { const writer = new ByteWriter(); build(writer); settingsBytes = writer.build(); };
settings.sendClientSettings();

// Keep bootstrap-generated logs away from the user's app data and server world.
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-official-codec-'));
const classpath = [jar, ...jarFiles(path.join(root, 'testserver', 'libraries'))].join(path.delimiter);
const output = run('java', ['--class-path', classpath,
  path.join(__dirname, 'OfficialChatCodecCheck.java'), settingsBytes.toString('base64')], temporary);
assert.ok(output.includes('CODEC_SETTINGS FULL zh_cn unfiltered'));
console.log('PASS official decoder accepts FULL / zh_cn / no text filtering');
const samples = [...output.matchAll(/^CODEC_PACKET ([\w-]+) ([A-Za-z0-9+/=]+)$/gm)];
assert.equal(samples.length, 4);
for (const [, name, encoded] of samples) {
  const received = [];
  const client = new MCClient({ onChat: (text, meta) => received.push({ text, meta }) });
  client.state = 'play';
  client.send = client.say = client.command = () => { throw new Error('Network sending forbidden'); };
  client.handlePacket(Buffer.concat([Buffer.from([P.playPlayerChat]), Buffer.from(encoded, 'base64')]));
  assert.equal(received.length, 1, name);
  assert.equal(received[0].text, name === 'signed-decorated' ? 'codec-decorated' : 'codec-body', name);
  assert.equal(received[0].meta.type, 'player', name);
  assert.equal(received[0].meta.sender, 'CodecSender', name);
  const diagnostics = client.getChatDiagnostics();
  assert.equal(diagnostics.received.player, 1, name);
  assert.equal(diagnostics.emitted.player, 1, name);
  assert.equal(diagnostics.errors.player, 0, name);
  assert.equal(diagnostics.detailFallbacks, 0, name);
  console.log('PASS official encoder -> production receiver: ' + name);
}
console.log('PASS offline official codec check; no target connections or chat commands');
