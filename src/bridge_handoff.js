'use strict';

const MODES = ['off', 'exit', 'offline'];

function normalizeBridgeFallback(value) {
  return value === undefined ? 'exit' : MODES.includes(value) ? value : 'off';
}

function bridgeFallbackAllowed(value, cause) {
  const mode = normalizeBridgeFallback(value);
  return cause === 'exit' && mode !== 'off' || cause === 'offline' && mode === 'offline';
}

function standaloneBridgeTarget(context, accounts) {
  const matches = (Array.isArray(accounts) ? accounts : []).filter((item) => item && typeof item.name === 'string'
    && item.name.toLowerCase() === context.username.toLowerCase());
  if (matches.length !== 1 || !matches[0].uuid || matches[0].uuid !== context.accountUuid)
    throw new Error('未找到当前游戏账号的唯一本地凭据，请先手动登录该账号');
  return { host: context.host, port: context.port, username: context.username,
    usePremium: true, accountUuid: matches[0].uuid };
}

module.exports = { normalizeBridgeFallback, bridgeFallbackAllowed, standaloneBridgeTarget };
