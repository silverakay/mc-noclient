'use strict';
const assert = require('assert/strict');
const { MenuKeySequence } = require('./menu_key_sequence');
function fixture() {
  let now = 0, seq = 0, valid = true, menu = false, sneak = false;
  const tasks = new Map(), events = [];
  function setTimer(fn, delay) { const id = ++seq; tasks.set(id, { fn, at: now + delay }); return id; }
  const keys = new MenuKeySequence({ isCurrent: () => valid, hasMenu: () => menu,
    input: (value) => { sneak = value; events.push([now, value ? 'press' : 'release']); },
    swap: () => {
      events.push([now, 'swap']);
      // A server plugin can evaluate the swap on the next server tick.
      setTimer(() => events.push([now, sneak ? 'town-menu' : 'guild-menu']), 50);
    }, setTimer, clearTimer: (id) => tasks.delete(id) });
  function advance(ms) {
    const end = now + ms;
    for (;;) {
      const next = [...tasks].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      tasks.delete(next[0]); now = next[1].at; next[1].fn();
    }
    now = end;
  }
  return { keys, tasks, events, advance, disconnect: () => { valid = false; keys.cancel(); },
    showMenu: () => { menu = true; } };
}
async function run() {
  const f = fixture(), pending = f.keys.open();
  assert.deepEqual(f.events, [[0, 'press']]);
  f.advance(199); assert.equal(f.events.length, 1);
  f.advance(51); assert.deepEqual(f.events, [[0, 'press'], [200, 'swap'], [250, 'town-menu']]);
  f.advance(100); assert.equal((await pending).ok, true);
  assert.deepEqual(f.events.at(-1), [350, 'release']); assert.equal(f.tasks.size, 0);
  console.log('PASS phased Shift+F keeps sneak through delayed server menu dispatch');
  for (const kind of ['cancel', 'disconnect', 'screen']) {
    const g = fixture(), active = g.keys.open();
    assert.equal((await g.keys.open()).ok, false, 'No parallel key sequence');
    if (kind === 'cancel') g.keys.cancel();
    if (kind === 'disconnect') g.disconnect();
    if (kind === 'screen') g.showMenu();
    g.advance(1000); assert.equal((await active).ok, false);
    assert.equal(g.events.some((event) => event[1] === 'swap'), false); assert.equal(g.tasks.size, 0);
  }
  console.log('PASS cancellation, disconnect, intervening menu and duplicate start never dispatch a late swap');
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
