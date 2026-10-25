'use strict';

// Local official 26.2 bytecode/codecs only. No server start, world or login.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { MCClient } = require('../src/client');
const { getCodec } = require('../src/server_features');
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
const frames = [];
for (const stateId of [7, -1]) {
  for (const button of [0, 1]) {
    const client = new MCClient(); client.state = 'play'; client.socket = { destroyed: false };
    client.send = (id, write) => {
      assert.equal(id, P.playWindowClick);
      const w = new ByteWriter(); write(w); frames.push(w.build().toString('base64'));
    };
    client.features.openMenu(getCodec().createPacketBuffer('packet_open_window', { windowId: 300,
      inventoryType: 2, windowTitle: { type: 'string', value: 'Official menu fixture' } }));
    client.features.windowItems(getCodec().createPacketBuffer('packet_window_items', {
      windowId: 300, stateId, items: Array.from({ length: 63 }, () => ({ itemCount: 0 })), carriedItem: { itemCount: 0 },
    }));
    const menu = client.features.menu;
    assert.equal(client.clickMenu({ id: menu.id, token: menu.token, revision: menu.revision, slot: 15, button }).ok, true);
    client.features.clearClick();
  }
}
const classpath = [jar, ...jars(path.join(root, 'testserver/libraries'))].join(path.delimiter);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-official-menu-click-'));
const output = execFileSync(path.join(javaBin, 'java.exe'), ['--class-path', classpath,
  path.join(__dirname, 'OfficialMenuClickCheck.java'), ...frames],
{ cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
assert.ok(output.includes('MENU_STATE_MINUS_ONE_RETAINED'));
assert.equal((output.match(/MENU_CLICK_VALID/g) || []).length, 4);
for (const line of output.split(/\r?\n/)) if (line.includes('MENU_')) console.log(line);
console.log('PASS production click bytes round-trip with official 26.2 codecs; vanilla retains and echoes state -1');
