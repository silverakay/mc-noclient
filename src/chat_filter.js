'use strict';

(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.McChatFilter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const MAX_ITEMS = 64;
  const MAX_LENGTH = 64;
  const SLEEP_NOTICE = /\d+\s*\/\s*\d+\s*\u540d\u73a9\u5bb6\u5df2\u5165\u7761/;

  function normalizeChatBlocklist(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    return value
      .filter((item) => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item && item.length <= MAX_LENGTH && !/[\x00-\x1f\x7f]/.test(item))
      .filter((item) => {
        const key = item.toLocaleLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, MAX_ITEMS);
  }

  function shouldSuppressChat(text, blocklist = []) {
    const message = String(text == null ? '' : text);
    if (SLEEP_NOTICE.test(message)) return true;
    const normalized = normalizeChatBlocklist(blocklist);
    const lower = message.toLocaleLowerCase();
    return normalized.some((item) => lower.includes(item.toLocaleLowerCase()));
  }

  return { MAX_ITEMS, MAX_LENGTH, SLEEP_NOTICE, normalizeChatBlocklist, shouldSuppressChat };
});
