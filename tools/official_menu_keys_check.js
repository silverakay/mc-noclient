'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { MCClient } = require('../src/client');
const { ByteWriter, PACKET_ID: P } = require('../src/proto');
const root = path.join(__dirname, '..');
const javaBin = process.env.MC_JAVA_BIN || path.join(process.env.APPDATA, '.minecraft/runtime/java-runtime-epsilon/bin');
const jar = path.join(root, 'testserver/versions/26.2/server-26.2.jar');
function jars(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? jars(file) : file.endsWith('.jar') ? [file] : [];
  });
}
async function run() {
  const registration = execFileSync(path.join(javaBin, 'javap.exe'), ['-classpath', jar, '-c', '-p',
    'net.minecraft.network.protocol.game.GameProtocols'], { encoding: 'utf8', windowsHide: true });
  const names = [...registration.matchAll(/Field [^;\n]+\.(SERVERBOUND_[A-Z0-9_]+):Lnet\/minecraft\/network\/protocol\/PacketType;/g)]
    .map((match) => match[1]);
  assert.equal(names.indexOf('SERVERBOUND_PLAYER_INPUT'), P.playPlayerInput);
  assert.equal(names.indexOf('SERVERBOUND_PLAYER_ACTION'), P.playPlayerAction);
  const client = new MCClient(), frames = []; client.state = 'play'; client.socket = { destroyed: false };
  client.send = (id, write) => { const w = new ByteWriter(); write(w); frames.push(w.build().toString('base64')); };
  assert.equal((await client.openServerMenu()).ok, true);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-official-menu-keys-'));
  const classpath = [jar, ...jars(path.join(root, 'testserver/libraries'))].join(path.delimiter);
  const output = execFileSync(path.join(javaBin, 'java.exe'), ['--class-path', classpath,
    path.join(__dirname, 'OfficialMenuKeysCheck.java'), ...frames],
  { cwd: temporary, encoding: 'utf8', windowsHide: true, timeout: 120000 });
  process.stdout.write(output);
  assert.ok(output.includes('PASS official 26.2 codecs'));
  console.log('PASS official packet registration IDs and production phased key bytes');
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
