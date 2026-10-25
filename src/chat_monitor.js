'use strict';

function cleanText(value) {
  return String(value == null ? '' : value).replace(/\u00a7./g, '');
}

function normalized(value) {
  return cleanText(value).trim().toLowerCase();
}

/**
 * The server commonly sends player chat as system_chat, for example:
 *   [生存][称号]PlayerName: message
 * In that packet there is no protocol sender field, so recover the account
 * name from the visible prefix before falling back to legacy substring match.
 */
function extractVisibleSender(text) {
  const value = cleanText(text);
  const matches = [...value.matchAll(/(?:^|[\]\)}>])\s*([A-Za-z0-9_]{1,16})\s*:/g)];
  return matches.length ? matches[matches.length - 1][1] : null;
}

function visibleAliases(player) {
  if (!player || typeof player !== 'object') return [];
  return [player.name, player.displayName]
    .map((value) => cleanText(value).trim())
    .filter((value, index, all) => value && all.indexOf(value) === index);
}

/**
 * Return the configured monitored player that owns this message, if known.
 * The final substring fallback is retained for old servers that omit both a
 * sender prefix and a player-list display name.
 */
function findMonitoredPlayer(text, meta = {}, players = [], monitoredPlayers = []) {
  const configured = Array.isArray(monitoredPlayers)
    ? monitoredPlayers.filter((name) => typeof name === 'string' && name.trim())
    : [];
  if (!configured.length) return null;

  const byKey = new Map(configured.map((name) => [normalized(name), name.trim()]));
  const sender = normalized(meta && meta.sender);
  const visibleSender = normalized(extractVisibleSender(text));
  const actualSender = sender || visibleSender;
  if (actualSender && byKey.has(actualSender)) return byKey.get(actualSender);
  if (sender || visibleSender) return null;

  const message = normalized(text);
  for (const configuredName of configured) {
    const key = normalized(configuredName);
    const player = Array.isArray(players)
      ? players.find((entry) => normalized(entry && entry.name) === key)
      : null;
    if (!player) continue;
    for (const alias of visibleAliases(player)) {
      if (message.includes(normalized(alias))) return configuredName.trim();
    }
  }

  // Compatibility for old plugin formats that contain only a bare name.
  for (const configuredName of configured) {
    if (message.includes(normalized(configuredName))) return configuredName.trim();
  }
  return null;
}

function relatedMonitoredPlayers(text, meta = {}, players = [], monitoredPlayers = []) {
  const actual = findMonitoredPlayer(text, meta, players, monitoredPlayers);
  const message = cleanText(text).toLowerCase();
  const found = new Set(actual ? [actual] : []);
  for (const name of Array.isArray(monitoredPlayers) ? monitoredPlayers : []) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9_]{1,16}$/.test(name)) continue;
    const reference = new RegExp('(^|[^A-Za-z0-9_])@?' + name + '(?![A-Za-z0-9_])', 'i');
    if (reference.test(message)) found.add(name);
  }
  return [...found];
}

module.exports = { cleanText, extractVisibleSender, findMonitoredPlayer, relatedMonitoredPlayers, visibleAliases };
