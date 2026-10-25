'use strict';

const fs = require('fs');
const path = require('path');
const { createHash, randomUUID } = require('crypto');

const discoveryDirectory = (directory) => path.join(directory, 'bridge-listeners');
const pairingId = (token) => createHash('sha256').update(token, 'utf8').digest('hex');
const validUsername = (name) => typeof name === 'string' && /^[A-Za-z0-9_]{1,16}$/.test(name);

class BridgeDiscovery {
  constructor(directory, config, { now = Date.now } = {}) {
    this.directory = directory;
    this.file = path.join(directory, randomUUID() + '.json');
    this.pairingId = pairingId(config.token);
    this.now = now;
    if (fs.existsSync(directory)) {
      for (const name of fs.readdirSync(directory)) {
        if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
        const file = path.join(directory, name);
        try {
          if (fs.statSync(file).size > 4096) continue;
          const record = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (record.pairingId !== this.pairingId || !Number.isSafeInteger(record.expiresAt)
            || record.expiresAt > this.now() || !Number.isSafeInteger(record.pid) || record.pid < 1) continue;
          try { process.kill(record.pid, 0); }
          catch (error) { if (error.code === 'ESRCH') fs.unlinkSync(file); }
        } catch (_) { /* Stale discovery records never require removing another process's files. */ }
      }
    }
  }

  publish(port, username, busy) {
    fs.mkdirSync(this.directory, { recursive: true });
    const temporary = this.file + '.tmp';
    try {
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, pairingId: this.pairingId,
        port, username: username || '', busy: busy === true, pid: process.pid, expiresAt: this.now() + 20000 }), { mode: 0o600 });
      fs.renameSync(temporary, this.file);
    } finally {
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }

  close() {
    try { fs.unlinkSync(this.file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

module.exports = { BridgeDiscovery, discoveryDirectory, pairingId, validUsername };
