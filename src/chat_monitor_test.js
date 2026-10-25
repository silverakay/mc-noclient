'use strict';

const assert = require('assert/strict');
const { extractVisibleSender, findMonitoredPlayer, relatedMonitoredPlayers } = require('./chat_monitor');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS ' + name); }

test('extracts the account name from common server chat prefixes', () => {
  assert.equal(extractVisibleSender('[生存]mangoOvO: @Raiwil'), 'mangoOvO');
  assert.equal(extractVisibleSender('[生存][称号[♟] 成员]Fivebucks2233: 你好'), 'Fivebucks2233');
});

test('prefers the protocol sender when available', () => {
  assert.equal(findMonitoredPlayer('Nan_Koi 被邀请', { sender: 'Alice' }, [], ['Alice']), 'Alice');
});

test('monitors system_chat messages whose visible prefix contains the player', () => {
  assert.equal(findMonitoredPlayer('[生存]mangoOvO: @Raiwil', { type: 'system' }, [], ['mangoOvO']), 'mangoOvO');
});

test('uses the player-list display name when the account name is decorated', () => {
  const players = [{ name: 'Nan_Koi', displayName: '[VIP]芒果玩家' }];
  assert.equal(findMonitoredPlayer('[生存][VIP]芒果玩家: 你好', {}, players, ['Nan_Koi']), 'Nan_Koi');
});

test('keeps compatibility with bare-name plugin messages', () => {
  assert.equal(findMonitoredPlayer('Nan_Koi 完成了任务', {}, [], ['Nan_Koi']), 'Nan_Koi');
});

test('runtime monitor retains direct speech, mentions, at-mentions and ban broadcasts without conflating senders', () => {
  for (const text of ['mango0v0: hi', 'Alice: @mango0v0 hi', 'Alice: mango0v0 is here', 'Steve 被 mango0v0 封禁']) {
    assert.deepEqual(relatedMonitoredPlayers(text, {}, [], ['mango0v0']), ['mango0v0']);
  }
  assert.equal(findMonitoredPlayer('Alice: @mango0v0 hi', { sender: 'Alice' }, [], ['mango0v0']), null);
  assert.equal(findMonitoredPlayer('mango0v0: hi', { sender: 'Alice' }, [], ['mango0v0']), null);
  for (const text of ['Alice: @mango0v01 hi', 'xmango0v0: hi', 'mangoOvO: hi']) {
    assert.deepEqual(relatedMonitoredPlayers(text, {}, [], ['mango0v0']), []);
  }
});

console.log(`=== ${passed} chat monitor tests passed ===`);
