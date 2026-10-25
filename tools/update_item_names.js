'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const javaBin = process.env.MC_JAVA_BIN || path.join(process.env.APPDATA, '.minecraft', 'runtime', 'java-runtime-epsilon', 'bin');
const jar = path.join(root, 'testserver', 'versions', '26.2', 'server-26.2.jar');
function jarFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? jarFiles(file) : entry.name.endsWith('.jar') ? [file] : [];
  });
}
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-item-export-'));
const output = execFileSync(path.join(javaBin, 'java.exe'), ['--class-path',
  [jar, ...jarFiles(path.join(root, 'testserver', 'libraries'))].join(path.delimiter),
  path.join(__dirname, 'OfficialChatCodecCheck.java'), 'items'],
{ cwd: temporary, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
const entries = [...output.matchAll(/^ITEM (\d+) (\S+) (\S+)$/gm)];
assert.equal(entries.length, 1537, 'Wrong 26.2 item registry');
const items = Object.fromEntries(entries.map(([, id, name, translation]) => [id, { name, translation }]));
fs.writeFileSync(path.join(root, 'src/data/items-26.2.json'), JSON.stringify(items));
console.log('Exported 1537 official 26.2 item names; no server startup or network connection');
