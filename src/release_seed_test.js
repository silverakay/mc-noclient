'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { seedReleaseData } = require('./release_seed');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-release-seed-'));
const source = path.join(root, 'seed');
const dataDir = path.join(root, 'profile');
const authFile = path.join(root, 'auth', 'accounts.json');
const options = { source, dataDir, authFile };
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };

assert.equal(seedReleaseData(options).status, 'absent');
write(path.join(source, 'app-data', 'config.json'), JSON.stringify({ servers: [], autoLogin: false }));
write(path.join(source, 'app-data', 'records', 'chat', 'fixture.jsonl'), 'OFFLINE_CHAT');
write(path.join(source, 'auth', 'accounts.json'), 'FAKE_ACCOUNT');
assert.equal(seedReleaseData({ ...options, disabled: true }).status, 'disabled');
assert.equal(fs.existsSync(dataDir), false);
assert.equal(fs.existsSync(authFile), false);
fs.mkdirSync(dataDir);
assert.equal(seedReleaseData(options).status, 'seeded');
assert.equal(fs.readFileSync(authFile, 'utf8'), 'FAKE_ACCOUNT');
assert.equal(fs.readFileSync(path.join(dataDir, 'records', 'chat', 'fixture.jsonl'), 'utf8'), 'OFFLINE_CHAT');
fs.unlinkSync(authFile);
assert.equal(seedReleaseData(options).status, 'existing');
assert.equal(fs.existsSync(authFile), false, 'Logging out must not re-import an account');
fs.unlinkSync(path.join(dataDir, 'config.json'));
assert.equal(seedReleaseData(options).status, 'existing', 'The seed marker prevents repeated restoration');

const existing = { ...options, dataDir: path.join(root, 'existing') };
write(path.join(existing.dataDir, 'config.json'), 'EXISTING_CONFIG');
assert.equal(seedReleaseData(existing).status, 'existing');
assert.equal(fs.readFileSync(path.join(existing.dataDir, 'config.json'), 'utf8'), 'EXISTING_CONFIG');
assert.equal(fs.existsSync(authFile), false, 'Existing users must not receive a private account');
write(authFile, 'EXISTING_ACCOUNT');
assert.equal(seedReleaseData({ ...options, dataDir: path.join(root, 'another') }).status, 'seeded');
assert.equal(fs.readFileSync(authFile, 'utf8'), 'EXISTING_ACCOUNT');
console.log('PASS release seeds: isolated selftests, existing directories, first import, no overwrite and no account resurrection');
