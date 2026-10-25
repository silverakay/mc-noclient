'use strict';

const assert = require('assert/strict');
const { normalizeChatBlocklist, shouldSuppressChat } = require('./chat_filter');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS ' + name); }

test('默认屏蔽玩家入睡人数广播', () => {
  assert.equal(shouldSuppressChat('1/55名玩家已入睡'), true);
  assert.equal(shouldSuppressChat('1/54名玩家已入睡'), true);
  assert.equal(shouldSuppressChat('玩家聊天：大家晚安'), false);
});

test('自定义关键词按包含关系屏蔽且忽略大小写', () => {
  assert.equal(shouldSuppressChat('[公告]市场刷新', ['市场']), true);
  assert.equal(shouldSuppressChat('HELLO server', ['hello']), true);
  assert.equal(shouldSuppressChat('普通聊天', ['市场']), false);
});

test('关键词规范化会去空格、去重并限制非法内容', () => {
  assert.deepEqual(normalizeChatBlocklist([' 市场 ', '市场', '', 'a\n b', 'HELLO', 'hello']), ['市场', 'HELLO']);
});

console.log(`=== ${passed} chat filter tests passed ===`);
