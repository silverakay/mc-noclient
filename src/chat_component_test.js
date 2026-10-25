'use strict';

const assert = require('assert/strict');
const { componentToRuns: runs, componentToText: text, clickAction } = require('./chat_component');
const { ChatActions } = require('./chat_actions');
const { MCClient } = require('./client');
const { ByteReader, ByteWriter, PACKET_ID: P } = require('./proto');
let passed = 0, failed = 0;

async function test(name, fn) {
  try { await fn(); passed++; console.log('  [PASS] ' + name); }
  catch (e) { failed++; console.error('  [FAIL] ' + name + ': ' + e.message); }
}

// Synthetic packet fixtures, not live server captures.
function nbt(value) {
  const type = typeof value === 'string' ? 8 : Array.isArray(value) ? 9
    : typeof value === 'boolean' ? 1 : 10;
  const w = new ByteWriter();
  const string = (s) => { const b = Buffer.from(s); w.u16(b.length); w.raw(b); };
  function payload(v, t) {
    if (t === 8) string(v);
    else if (t === 1) w.u8(v ? 1 : 0);
    else if (t === 9) {
      const childType = typeof v[0] === 'string' ? 8 : 10;
      w.u8(childType); w.i32(v.length);
      for (const child of v) payload(child, childType);
    } else {
      for (const [key, child] of Object.entries(v)) {
        const childType = typeof child === 'string' ? 8 : Array.isArray(child) ? 9
          : typeof child === 'boolean' ? 1 : 10;
        w.u8(childType); string(key); payload(child, childType);
      }
      w.u8(0);
    }
  }
  w.u8(type); payload(value, type);
  return w.build();
}

const clickable = { text: 'Claim', color: 'gold', bold: true,
  click_event: { action: 'run_command', command: '/redpacket claim fixture' },
  hover_event: { action: 'show_text', value: { text: 'Click to claim' } } };

async function run() {
  await test('Pasted mob death translates nested entity names', () => {
    assert.equal(text({ translate: 'death.attack.mob', with: ['Loveff',
      { translate: 'entity.minecraft.enderman' }] }), 'Loveff\u88ab\u672b\u5f71\u4eba\u6740\u6b7b\u4e86');
  });
  await test('Pasted lava death becomes Chinese', () => {
    assert.equal(text({ translate: 'death.attack.lava', with: ['Ctiy_one'] }),
      'Ctiy_one\u8bd5\u56fe\u5728\u7194\u5ca9\u91cc\u6e38\u6cf3');
  });
  const advancements = {
    'adventure.sleep_in_bed': '\u751c\u871c\u7684\u68a6',
    'nether.get_wither_skull': '\u60ca\u609a\u6050\u6016\u9ab7\u9ac5\u5934',
    'nether.summon_wither': '\u51cb\u96f6\u5c71\u5e84',
    'adventure.kill_a_mob': '\u602a\u7269\u730e\u4eba',
    'story.mine_stone': '\u77f3\u5668\u65f6\u4ee3',
    'story.enter_the_nether': '\u52c7\u5f80\u76f4\u4e0b',
    'story.lava_bucket': '\u70ed\u817e\u817e\u7684',
  };
  for (const [key, title] of Object.entries(advancements)) {
    await test('Pasted advancement: ' + key, () => {
      assert.equal(text({ translate: 'chat.type.advancement.task', with: ['Player',
        { translate: 'chat.square_brackets', with: [{ translate: 'advancements.' + key + '.title' }] }] }),
      'Player\u53d6\u5f97\u4e86\u8fdb\u5ea6[' + title + ']');
    });
  }
  await test('Positional substitutions and escaped percent preserve component clicks', () => {
    const parts = runs({ translate: 'plugin.unknown', fallback: '%2$s / %1$s / %%', with: ['A', clickable] });
    assert.equal(parts.map((p) => p.text).join(''), 'Claim / A / %');
    assert.equal(parts[0].click.value, '/redpacket claim fixture');
  });
  await test('Unknown plugin translation preserves key and parameters', () => {
    assert.equal(text({ translate: 'plugin.unknown', with: ['Player', 'content'] }), 'plugin.unknown Player content');
  });
  await test('Custom crop translations include giant, silver/gold and nested styled names', () => {
    assert.equal(text({ translate: 'item.customcrops.gigantic_pineapple' }), '巨型菠萝');
    assert.equal(text({ translate: 'item.customcrops.virelo_silver_star' }), '幽碧兰（银星）');
    assert.equal(text({ translate: 'item.customcrops.cabbage_golden_star' }), '卷心菜（金星）');
    const part = runs({ text: '', color: 'gold', extra: [
      { translate: 'item.customcrops.leek_golden_star', click_event: clickable.click_event },
    ] })[0];
    assert.equal(part.text, '韭葱（金星）'); assert.equal(part.color, '#ffaa00');
    assert.equal(part.click.value, '/redpacket claim fixture');
    assert.equal(text({ translate: 'item.customcrops.unknown_crop', fallback: '服务器作物' }), '服务器作物');
    assert.equal(text({ translate: 'item.customcrops.unknown_crop' }), 'item.customcrops.unknown_crop');
    assert.equal(text('item.customcrops.gigantic_pineapple'), 'item.customcrops.gigantic_pineapple',
      'Literal chat text must not be rewritten');
  });
  await test('Every bundled crop translation resolves and original translation keys remain available', () => {
    const language = require('./lang/customcrops_zh_cn.json');
    assert.equal(Object.keys(language).length, 105);
    for (const [key, name] of Object.entries(language)) {
      assert.match(key, /^item\.customcrops\.[a-z0-9_]+$/); assert.match(name, /[\u3400-\u9fff]/);
      assert.equal(text({ translate: key }), name);
      assert.equal(text({ translate: key }, { translate: false }), key);
    }
  });
  await test('Plain English plugin messages remain unchanged', () => {
    assert.equal(text('You have received x1 key(s).'), 'You have received x1 key(s).');
  });
  await test('Modern and legacy click formats are both recognized', () => {
    assert.equal(runs(clickable)[0].click.action, 'run_command');
    assert.equal(runs({ text: 'Input', clickEvent: { action: 'suggest_command', value: '/claim ' } })[0].click.value, '/claim ');
  });
  await test('Extras inherit their parent, not their preceding sibling', () => {
    const parts = runs({ text: 'Prefix ', extra: [clickable, { text: ' plain' }] });
    assert.equal(parts[1].click.action, 'run_command');
    assert.equal(parts[2].click, undefined);
  });
  await test('Parent click inherits; explicit child cancellation works', () => {
    const parts = runs({ ...clickable, extra: [{ text: ' child' }, { text: ' plain', click_event: null }] });
    assert.equal(parts[1].click.action, 'run_command');
    assert.equal(parts[2].click, null);
  });
  await test('NBT boolean flags and section formatting render as styles', () => {
    const parts = runs({ text: '\u00a7aGreen\u00a7lBold\u00a7rNormal', bold: 0 });
    assert.equal(parts.map((p) => p.text).join(''), 'GreenBoldNormal');
    assert.equal(parts[0].color, '#55ff55');
    assert.equal(parts[1].bold, true);
    assert.equal(parts[2].bold, false);
  });
  await test('Hover translation and color are retained', () => {
    const part = runs({ ...clickable, hover_event: { action: 'show_text', value: { translate: 'entity.minecraft.enderman' } } })[0];
    assert.equal(part.hover, '\u672b\u5f71\u4eba');
    assert.equal(part.color, '#ffaa00');
  });
  await test('Unsafe actions and control characters are not clickable', () => {
    for (const event of [{ action: 'open_file', value: 'C:/test' },
      { action: 'open_url', url: 'javascript:alert(1)' }, { action: 'open_url', url: 'file:///C:/test' },
      { action: 'run_command', command: '/one\n/two' }]) assert.equal(clickAction(event), null);
  });
  await test('Cyclic and oversized components are bounded', () => {
    const cycle = { text: 'x' }; cycle.extra = [cycle];
    assert.ok(text(cycle).length < 100);
    assert.equal(text('x'.repeat(100000)).length, 65536);
  });

  const chats = [], sends = [];
  const client = new MCClient({ onChat: (body, meta) => chats.push({ body, meta }) });
  client.state = 'play';
  client.send = (...args) => sends.push(args);
  client.say = client.command = () => { throw new Error('Reception must not send'); };
  await test('System packet preserves clickable body without sending', () => {
    const reader = new ByteReader(Buffer.concat([nbt({ text: '[Packet] ', extra: [clickable] }), Buffer.from([0])]));
    client.onPlayPacket(P.playSystemChat, reader);
    assert.equal(reader.remaining, 0);
    assert.equal(chats.at(-1).meta.segments[1].click.value, '/redpacket claim fixture');
    assert.equal(sends.length, 0);
  });
  await test('Profileless packet and action bar preserve clicks', () => {
    const w = new ByteWriter().raw(nbt(clickable)).varint(5).raw(nbt('Server')).bool(false);
    client.onPlayPacket(P.playProfilelessChat, new ByteReader(w.build()));
    assert.equal(chats.at(-1).meta.segments[0].click.action, 'run_command');
    client.onPlayPacket(P.playActionBar, new ByteReader(nbt(clickable)));
    assert.equal(chats.at(-1).meta.type, 'actionbar');
    assert.equal(sends.length, 0);
  });
  await test('Signed player chat uses decorated unsigned content and correct sender', () => {
    const w = new ByteWriter().varint(1).raw(Buffer.alloc(16)).varint(0).bool(true)
      .raw(Buffer.alloc(256)).str('plain').i64(0n).i64(0n).varint(0).bool(true)
      .raw(nbt(clickable)).varint(0).varint(5).raw(nbt('Player')).bool(false);
    client.onPlayPacket(P.playPlayerChat, new ByteReader(w.build()));
    assert.equal(chats.at(-1).body, 'Claim');
    assert.equal(chats.at(-1).meta.sender, 'Player');
    assert.equal(chats.at(-1).meta.type, 'player');
    assert.equal(sends.length, 0);
  });
  const actions = new ChatActions(), commands = [];
  const fake = { state: 'play', command: (cmd) => { commands.push(cmd); return true; } };
  const register = (event) => actions.register(runs({ text: 'Click', click_event: event }))[0].click.id;
  await test('Registration never runs commands; manual activation runs once', async () => {
    const id = register(clickable.click_event);
    assert.equal(commands.length, 0);
    assert.equal((await actions.activate(id, fake)).ok, true);
    assert.deepEqual(commands, ['redpacket claim fixture']);
    assert.equal((await actions.activate(id, fake)).ok, false);
  });
  await test('Suggest and copy return data without command dispatch', async () => {
    for (const action of ['suggest_command', 'copy_to_clipboard']) {
      const id = register({ action, command: '/claim ', value: '/claim ' });
      const result = await actions.activate(id, fake);
      assert.equal(result.action, action);
      assert.equal(result.value, '/claim ');
    }
    assert.equal(commands.length, 1);
  });
  await test('Disconnect/reset and forged IDs cannot execute old commands', async () => {
    const id = register(clickable.click_event);
    actions.reset();
    assert.equal((await actions.activate(id, fake)).ok, false);
    assert.equal((await actions.activate('/redpacket claim forged', fake)).ok, false);
    assert.equal(commands.length, 1);
  });
  await test('Login/config/closed states reject clicks without consuming them', async () => {
    const id = register(clickable.click_event);
    for (const state of ['login', 'config', 'closed']) {
      assert.equal((await actions.activate(id, { ...fake, state })).ok, false);
    }
    assert.equal(commands.length, 1);
  });
  await test('URL requires the caller confirmation path, not command dispatch', async () => {
    const id = register({ action: 'open_url', url: 'https://example.invalid/' });
    let prompts = 0;
    const result = await actions.activate(id, fake, async () => { prompts++; return false; });
    assert.equal(result.ok, false);
    assert.equal(prompts, 1);
    assert.equal(commands.length, 1);
  });
  await test('Action registry has a fixed memory bound', () => {
    for (let i = 0; i < 4200; i++) register(clickable.click_event);
    assert.equal(actions.actions.size, 4096);
  });
  client.close();
  console.log('\nResult: ' + passed + ' passed / ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
}
run().catch((e) => { console.error(e); process.exitCode = 1; });
