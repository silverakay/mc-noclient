'use strict';

const MAX_EXIT_PLAYERS = 16;

function normalizeBridgeExit(value) {
  const input = value && typeof value === 'object' ? value : {};
  const source = Array.isArray(input.players) ? input.players : [input.player];
  const players = [], seen = new Set();
  for (const raw of source.slice(0, 64)) {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (!/^[A-Za-z0-9_]{1,16}$/.test(name) || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase()); players.push(name);
    if (players.length === MAX_EXIT_PLAYERS) break;
  }
  return { enabled: input.enabled === true && players.length > 0, players };
}

class BridgeExitGuard {
  constructor({ trigger, onError = () => {} }) {
    this.trigger = trigger; this.onError = onError; this.attempted = new WeakMap();
  }

  observe(peer, policy) {
    const rule = normalizeBridgeExit(policy);
    if (!rule.enabled || !peer || peer.state !== 'play' || !peer.session || !Array.isArray(peer.players)) return false;
    const names = new Set(rule.players.map((name) => name.toLowerCase()));
    const target = peer.players.find((p) => p && typeof p.name === 'string' && names.has(p.name.toLowerCase()));
    if (!target) return false;
    const key = peer.session;
    if (this.attempted.get(peer) === key) return false;
    this.attempted.set(peer, key);
    Promise.resolve().then(() => {
      if (peer.state !== 'play' || peer.session !== key
        || !peer.players.some((p) => p.name.toLowerCase() === target.name.toLowerCase())) return false;
      return this.trigger(peer, target.name);
    }).then((accepted) => {
      if (accepted === false && this.attempted.get(peer) === key) this.attempted.delete(peer);
    }).catch(this.onError);
    return true;
  }
}

module.exports = { normalizeBridgeExit, BridgeExitGuard, MAX_EXIT_PLAYERS };
