'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-multi-account-'));
process.env.APPDATA = appData;
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return { shell: { openExternal: async () => {} } };
  return originalLoad.apply(this, arguments);
};

const auth = require('./auth');
const cacheDir = path.dirname(auth.TOKEN_CACHE);
const write = (value) => {
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(auth.TOKEN_CACHE, JSON.stringify(value), 'utf8');
};

console.log('\n=== 多账号缓存自检 ===\n');

write({ msRefreshToken: 'OLD_TOKEN', name: 'OldUser', uuid: 'old-uuid', savedAt: '2026-01-01' });
let state = auth.peekCachedAccounts();
assert.strictEqual(state.accounts.length, 1);
assert.strictEqual(state.active.name, 'OldUser');
assert.strictEqual(auth.loadCache().msRefreshToken, 'OLD_TOKEN');
console.log('[PASS] 旧版单账号缓存可迁移读取');

write({
  version: 2,
  activeUuid: 'new-uuid',
  accounts: [
    { msRefreshToken: 'OLD_TOKEN', name: 'OldUser', uuid: 'old-uuid' },
    { msRefreshToken: 'NEW_TOKEN', name: 'NewUser', uuid: 'new-uuid' },
  ],
});
state = auth.peekCachedAccounts();
assert.deepStrictEqual(state.accounts.map((item) => item.name), ['OldUser', 'NewUser']);
assert.strictEqual(state.active.name, 'NewUser');
console.log('[PASS] 多账号列表与当前账号可读取');

auth.removeCachedAccount('new-uuid');
state = auth.peekCachedAccounts();
assert.strictEqual(state.accounts.length, 1);
assert.strictEqual(state.active.name, 'OldUser');
assert.strictEqual(auth.loadCache().msRefreshToken, 'OLD_TOKEN');
console.log('[PASS] 移除单个账号不会清空其他账号');

async function authenticationIsolation() {
  const originalFetch = global.fetch;
  let profileUuid = 'old-uuid', refreshUsed = null, requests = 0, removeDuringProfile = false;
  const seed = () => write({ version: 2, activeUuid: 'new-uuid', accounts: [
    { uuid: 'old-uuid', name: 'OldUser', msRefreshToken: 'OLD_TOKEN' },
    { uuid: 'new-uuid', name: 'NewUser', msRefreshToken: 'NEW_TOKEN' },
  ] });
  global.fetch = async (url, options = {}) => {
    requests++;
    let body;
    if (String(url).includes('oauth20_token')) {
      refreshUsed = new URLSearchParams(options.body).get('refresh_token');
      body = { access_token: 'MS_FIXTURE', refresh_token: 'ROTATED_OLD' };
    } else if (String(url).includes('user.auth.xboxlive')) body = { Token: 'XBL_FIXTURE' };
    else if (String(url).includes('xsts.auth.xboxlive')) body = { Token: 'XSTS_FIXTURE', DisplayClaims: { xui: [{ uhs: 'UHS_FIXTURE' }] } };
    else if (String(url).includes('login_with_xbox')) body = { access_token: 'MC_FIXTURE' };
    else if (String(url).includes('/minecraft/profile')) {
      if (removeDuringProfile) auth.removeCachedAccount('old-uuid');
      body = { id: profileUuid, name: profileUuid === 'old-uuid' ? 'OldUser' : 'NewUser', skins: [] };
    } else throw new Error('Unexpected network endpoint in fixture');
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    seed();
    const acc = await auth.login({ silentOnly: true, accountUuid: 'old-uuid', updateActive: false });
    assert.strictEqual(acc.profile.id, 'old-uuid'); assert.strictEqual(refreshUsed, 'OLD_TOKEN');
    assert.strictEqual(auth.peekCachedAccounts().activeUuid, 'new-uuid');
    assert.strictEqual(auth.loadCache().accounts.find((a) => a.uuid === 'new-uuid').msRefreshToken, 'NEW_TOKEN');
    assert.strictEqual(auth.loadCache().accounts.find((a) => a.uuid === 'old-uuid').msRefreshToken, 'ROTATED_OLD');
    console.log('[PASS] 指定原账号续期仅更新自己的令牌，不改另一窗口默认选择');

    seed(); const before = fs.readFileSync(auth.TOKEN_CACHE, 'utf8'); profileUuid = 'new-uuid';
    await assert.rejects(auth.login({ silentOnly: true, accountUuid: 'old-uuid', updateActive: false }), /身份不一致/);
    assert.strictEqual(fs.readFileSync(auth.TOKEN_CACHE, 'utf8'), before);
    console.log('[PASS] 续期返回不同身份时拒绝，保留全部原缓存');

    const count = requests;
    await assert.rejects(auth.login({ silentOnly: true, accountUuid: 'missing-uuid' }), /手动登录/);
    assert.strictEqual(requests, count);
    console.log('[PASS] 原账号不存在时不发任何其他账号认证请求');

    seed(); profileUuid = 'old-uuid'; removeDuringProfile = true;
    await assert.rejects(auth.login({ silentOnly: true, accountUuid: 'old-uuid', updateActive: false }), /凭据已移除/);
    assert.deepStrictEqual(auth.peekCachedAccounts().accounts.map((a) => a.uuid), ['new-uuid']);
    console.log('[PASS] 续期期间被另一窗口移除的凭据不会被迟到结果恢复');
    console.log('\n=== 结果：7 通过 / 0 失败 ===\n');
  } finally { global.fetch = originalFetch; }
}
authenticationIsolation().catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => fs.rmSync(appData, { recursive: true, force: true }));
