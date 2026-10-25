'use strict';

const fs = require('fs');
const path = require('path');

function copyMissing(source, target) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error('Release data must not contain symbolic links');
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source)) copyMissing(path.join(source, entry), path.join(target, entry));
  } else if (stat.isFile()) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try { fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
}

function seedReleaseData({ source, dataDir, authFile, disabled = false }) {
  if (disabled) return { status: 'disabled' };
  if (!fs.existsSync(source)) return { status: 'absent' };
  const marker = path.join(dataDir, 'release-seeded.json');
  // An account removed by its owner must never be restored on the next launch.
  if (fs.existsSync(marker) || fs.existsSync(path.join(dataDir, 'config.json'))) return { status: 'existing' };
  const appData = path.join(source, 'app-data');
  if (!fs.existsSync(path.join(appData, 'config.json'))) throw new Error('Release data has no configuration');
  copyMissing(appData, dataDir);
  const account = path.join(source, 'auth', 'accounts.json');
  if (authFile && fs.existsSync(account)) copyMissing(account, authFile);
  fs.writeFileSync(marker, JSON.stringify({ version: 1 }), { flag: 'wx', mode: 0o600 });
  return { status: 'seeded' };
}

module.exports = { seedReleaseData };
