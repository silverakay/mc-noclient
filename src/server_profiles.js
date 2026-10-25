'use strict';

const { normalizeClaimDelay, normalizeClaimTrigger } = require('./red_packet');
const { normalizeWelcomeDelay } = require('./welcome');
const { normalizeMidnight } = require('./midnight_command');
const { normalizeChatBlocklist } = require('./chat_filter');
const { normalizeBridgeExit } = require('./bridge_exit');
const { normalizeBridgeFallback } = require('./bridge_handoff');

function serverKey(target) {
  if (!target || typeof target.host !== 'string') return '';
  const host = target.host.trim().toLowerCase().replace(/\.$/, '');
  const port = Number(target.port || 25565);
  return host && host.length <= 255 && !/[\s\x00-\x1f]/.test(host)
    && Number.isInteger(port) && port > 0 && port <= 65535 ? host + ':' + port : '';
}

function normalizeNotifications(value = {}) {
  const v = value && typeof value === 'object' ? value : {};
  const time = (s, fallback) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s || '') ? s : fallback;
  return { mentions: v.mentions === true, players: v.players === true, connection: v.connection === true,
    desktop: v.desktop === true, preview: v.preview === true, quiet: v.quiet === true,
    quietStart: time(v.quietStart, '23:00'), quietEnd: time(v.quietEnd, '08:00') };
}

function profile(value = {}, legacy = false) {
  const a = value.automation || {}, d = value.display || {}, b = value.behavior || {};
  return {
    automation: { autoClaimRedPackets: a.autoClaimRedPackets === true,
      autoWelcome: a.autoWelcome === true, paused: a.paused === true,
      welcomeDelayEnabled: a.welcomeDelayEnabled !== false, welcomeDelay: normalizeWelcomeDelay(a.welcomeDelay),
      claimDelay: normalizeClaimDelay(a.claimDelay), ...normalizeClaimTrigger(a) },
    midnightCommand: normalizeMidnight(value.midnightCommand),
    monitoredPlayers: [...new Set((Array.isArray(value.monitoredPlayers) ? value.monitoredPlayers : [])
      .filter((v) => typeof v === 'string' && /^[A-Za-z0-9_]{1,16}$/.test(v)))].slice(0, 64),
    shortcuts: (Array.isArray(value.shortcuts) ? value.shortcuts : []).filter((s) => s && typeof s.name === 'string'
      && s.name.trim() && s.name.length <= 24 && typeof s.command === 'string' && /^\/[^\s/]/.test(s.command)
      && s.command.length <= 2048 && !/[\x00-\x1f\x7f]/.test(s.command + s.name))
      .slice(0, 30).map((s) => ({ name: s.name.trim(), command: s.command })),
    display: { chatBlocklist: normalizeChatBlocklist(d.chatBlocklist), hidePresence: d.hidePresence !== false },
    behavior: { showChat: b.showChat !== false, greet: legacy && typeof b.greet === 'string' ? b.greet : '',
      commands: legacy && Array.isArray(b.commands) ? b.commands.slice(0, 30) : [] },
    notifications: normalizeNotifications(value.notifications),
    bridgeExit: normalizeBridgeExit(value.bridgeExit),
    bridgeFallback: normalizeBridgeFallback(value.bridgeFallback),
    autoPurchase: value.autoPurchase === true || legacy && value.autoPurchase !== false,
  };
}

function upgradeProfiles(config) {
  const migrated = config.profileVersion !== 1;
  const entries = config.serverProfiles && typeof config.serverProfiles === 'object' ? config.serverProfiles : {};
  const result = {};
  for (const [key, value] of Object.entries(entries).slice(0, 256)) {
    if (key.length <= 270 && key !== '__proto__' && key !== 'constructor' && key !== 'prototype') result[key] = profile(value, true);
  }
  if (migrated) for (const server of (config.servers || []).slice(0, 256)) {
    const key = serverKey(server);
    if (key && !Object.hasOwn(result, key)) result[key] = profile(config, true);
  }
  config.profileVersion = 1;
  config.serverProfiles = result;
  config.profileMigrationNotice = config.profileMigrationNotice === true || migrated && Object.keys(result).length > 0;
  delete config.__profileKey;
  return config;
}

function effectiveConfig(config, key) {
  if (config.profileVersion !== 1) return config;
  const stored = config.serverProfiles && Object.hasOwn(config.serverProfiles, key) ? config.serverProfiles[key] : null;
  const p = profile(stored || {}, !!stored);
  return { ...config, ...p, behavior: { ...config.behavior, ...p.behavior },
    display: { ...config.display, ...p.display }, __profileKey: key || '' };
}

function saveProfile(config, key) {
  if (!key) return config;
  return { ...config, serverProfiles: { ...(config.serverProfiles || {}), [key]: profile(config, true) } };
}

module.exports = { serverKey, profile, upgradeProfiles, effectiveConfig, saveProfile, normalizeNotifications };
