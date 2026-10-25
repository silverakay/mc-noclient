'use strict';

// Isolated real renderer, synthetic messages and fake IPC. All HTTP requests are forbidden.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');
const { chromium, _electron } = require('playwright');
const root = path.join(__dirname, '..');
const version = require('../package.json').version;
const baseline = path.join(root, 'dist-2.4.12/win-unpacked/resources/app.asar');
const compare = process.argv.includes('--compare');
const electronRuntime = process.argv.includes('--electron');
const suffix = electronRuntime ? '-electron' : '';
const stats = [];
const settled = (page) => page.evaluate(() => new Promise((resolve) => {
  let count = 0;
  const tick = () => ++count === 5 ? resolve() : requestAnimationFrame(tick);
  requestAnimationFrame(tick);
}));

async function makePage(browser, old = false) {
  const page = await browser.newPage({ viewport: { width: 1060, height: 720 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.route(/^https?:/, (route) => route.abort());
  if (old) await page.route(/\/(renderer\.js|style\.css)$/, (route) => {
    const file = route.request().url().split('/').pop();
    return route.fulfill({ body: require('@electron/asar').extractFile(baseline, path.normalize('app/renderer/' + file)),
      contentType: file.endsWith('.css') ? 'text/css' : 'application/javascript' });
  });
  await page.addInitScript(() => {
    window.fixture = { listeners: {}, queries: 0, sends: 0, actions: 0, holdAction: false, actionResult: { ok: true, action: 'run_command', value: '/fixture' } };
    const f = window.fixture;
    window.api = {
      getConfig: async () => ({ servers: [], username: 'Tester', autoLogin: false,
        behavior: { showChat: true }, display: { autoScroll: true, showMonitor: false, hidePresence: true } }),
      peekAccount: async () => null, getMetrics: async () => null,
      getOnline: async () => ({ known: false, players: [] }),
      onChat: (fn) => { f.listeners.chat = fn; }, onLog: (fn) => { f.listeners.log = fn; },
      onStatus: (fn) => { f.listeners.status = fn; }, onMetrics: (fn) => { f.listeners.metrics = fn; },
      say: async () => { f.sends++; throw new Error('Forbidden network action'); },
      chatAction: async () => {
        f.actions++;
        if (f.holdAction) await new Promise((resolve) => { f.releaseAction = resolve; });
        return f.actionResult;
      },
    };
    window.fillMessages = (count, parts, actions = false) => {
      for (let i = 0; i < count; i++) f.listeners.chat({ text: 'FIXTURE_' + i, type: 'system', session: 'fixture',
        segments: Array.from({ length: parts }, (_, j) => ({ text: 'FIXTURE_' + i + '_' + j + ' ',
          color: j % 2 ? '#2dd4bf' : '#60a5fa', bold: j % 3 === 0,
          ...(actions && j === parts - 1 ? { click: { id: 'id_' + i, action: 'run_command', value: '/fixture ' + i } } : {}) })) });
    };
  });
  await page.goto(pathToFileURL(path.join(root, 'app/renderer/index.html')).href);
  await page.waitForFunction(() => typeof window.fixture.listeners.chat === 'function');
  await settled(page);
  return { page, errors };
}

async function measure(browser, old = false) {
  const { page, errors } = await makePage(browser, old);
  try {
    await page.evaluate(() => {
      document.getElementById('tab-log').click();
      window.fillMessages(800, 64);
      for (let i = 0; i < 800; i++) window.fixture.listeners.log({ level: 'net', text: 'LOG_' + i + ' ' + 'wrapped fixture '.repeat(12) });
    });
    await settled(page);
    const cdp = await page.context().newCDPSession(page); await cdp.send('Performance.enable');
    const timings = await page.evaluate(async () => {
      const values = [];
      for (let i = 0; i < 4; i++) for (const tab of ['chat', 'log', 'presence']) {
        const start = performance.now(); document.getElementById('tab-' + tab).click();
        const handler = performance.now() - start;
        await new Promise((resolve) => { let n = 0; const tick = () => ++n === 5 ? resolve() : requestAnimationFrame(tick); requestAnimationFrame(tick); });
        values.push({ tab, handlerMs: handler, settledMs: performance.now() - start });
      }
      return values;
    });
    await page.evaluate(() => document.getElementById('tab-chat').click()); await settled(page);
    const before = (await cdp.send('Performance.getMetrics')).metrics;
    const burst = await page.evaluate(() => { const t = performance.now(); window.fillMessages(40, 12); return performance.now() - t; });
    const after = (await cdp.send('Performance.getMetrics')).metrics;
    const delta = (name) => after.find((m) => m.name === name).value - before.find((m) => m.name === name).value;
    await settled(page);
    const result = { version: old ? '2.4.12 baseline' : version,
      chatSwitchMaxMs: +Math.max(...timings.filter((t) => t.tab === 'chat').map((t) => t.handlerMs)).toFixed(2),
      chatSwitchAverageMs: +(timings.filter((t) => t.tab === 'chat').reduce((n, t) => n + t.handlerMs, 0) / 4).toFixed(2),
      chatSettledAverageMs: +(timings.filter((t) => t.tab === 'chat').reduce((n, t) => n + t.settledMs, 0) / 4).toFixed(2),
      burst40Ms: +burst.toFixed(2), burstLayouts: delta('LayoutCount'),
      burstLayoutMs: +(delta('LayoutDuration') * 1000).toFixed(2) };
    if (!old) {
      assert.ok(result.burstLayouts <= 3, 'Burst layout must be batched, not repeated for all 40 messages');
      assert.equal(await page.locator('.chat-line').count(), 800, 'History cap unchanged');
    }
    assert.deepEqual(errors, []); return result;
  } finally { await page.close(); }
}

async function behaviors(browser) {
  const { page, errors } = await makePage(browser);
  try {
    await page.evaluate(() => {
      window.fixture.listeners.status({ connected: true, state: 'play', chatSession: 'fixture', target: { host: 'example.invalid', port: 25565 } });
      document.getElementById('tab-log').click(); window.fillMessages(805, 64, true);
    });
    await settled(page);
    await page.waitForFunction(() => document.querySelectorAll('#chat-view .chat-line').length === 800);
    assert.equal(await page.locator('.chat-line').count(), 800);
    assert.ok((await page.locator('#chat-badge').innerText()).includes('99'));
    for (const size of [{ width: 1060, height: 720 }, { width: 860, height: 600 }]) {
      await page.setViewportSize(size); await page.locator('#tab-chat').click(); await settled(page);
      const tail = await page.locator('#chat-view').evaluate((view) => {
        const tail = view.lastElementChild.getBoundingClientRect(), box = view.getBoundingClientRect();
        return { bottomGap: box.bottom - tail.bottom, visible: tail.bottom > box.top && tail.top < box.bottom,
          remaining: view.scrollHeight - view.clientHeight - view.scrollTop };
      });
      assert.equal(tail.visible, true, 'Latest rich-text row visible after estimated heights settle');
      assert.ok(tail.remaining < 2, 'No gap below the latest message: ' + JSON.stringify(tail));
      assert.equal(await page.evaluate(() => scrollX), 0, 'Following a message never pans the application horizontally');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Long messages fit the window');
      await page.screenshot({ path: path.join(root, 'dist', 'ui-tabs-performance-' + version + suffix + '-' + size.width + '.png') });
      await page.locator('#tab-log').click(); await settled(page);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
    await page.locator('#tab-chat').click(); await settled(page);
    await page.locator('#chat-view').evaluate((view) => { view.scrollTop = 0; }); await settled(page);
    await page.setViewportSize({ width: 1060, height: 720 }); await settled(page);
    assert.equal(await page.locator('#chat-view').evaluate((view) => view.scrollTop), 0, 'Resizing preserves history-reading position');
    await page.locator('#tab-log').click(); await page.locator('#tab-presence').click(); await page.locator('#tab-chat').click(); await settled(page);
    assert.equal(await page.locator('#chat-view').evaluate((view) => view.scrollTop), 0, 'Tab switch preserves history-reading position');
    assert.match(await page.locator('.chat-line').first().innerText(), /FIXTURE_5_/);
    await page.evaluate(() => { cfg.display.autoScroll = false; applyDisplaySettings(); });
    await page.locator('#tab-log').click(); await page.evaluate(() => window.fillMessages(10, 12));
    await page.locator('#tab-chat').click(); await settled(page);
    assert.equal(await page.locator('#chat-view').evaluate((view) => view.scrollTop), 0, 'Disabled autoscroll also applies to switching');
    await page.evaluate(() => {
      const view = document.getElementById('chat-view'); window.fixture.actionMutations = 0;
      window.fixture.actionObserver = new MutationObserver(() => {});
      window.fixture.actionObserver.observe(view, { subtree: true, attributes: true, attributeFilter: ['disabled'] });
      for (let i = 0; i < 100; i++) window.fixture.listeners.status({ state: 'play', uptime: '1:00:00', chats: i });
      window.fixture.actionMutations = window.fixture.actionObserver.takeRecords().length;
      window.fixture.actionObserver.disconnect();
    });
    assert.equal(await page.evaluate(() => window.fixture.actionMutations), 0, 'Unchanged status does not rewrite historical actions');
    const button = page.locator('.chat-action').first();
    await button.scrollIntoViewIfNeeded(); await settled(page);
    await page.evaluate(() => { window.fixture.holdAction = true; });
    await button.click(); assert.equal(await button.isDisabled(), true);
    await page.evaluate(() => window.fixture.releaseAction());
    await page.waitForFunction(() => document.querySelector('.chat-action').dataset.pending === 'false');
    assert.equal(await button.isDisabled(), true, 'Successful manual action stays consumed');
    assert.equal(await page.evaluate(() => window.fixture.actions), 1);
    const value = await page.locator('.chat-action').nth(1).getAttribute('data-action-value');
    await page.evaluate((value) => window.fixture.listeners.status({ automationAction: { session: 'fixture', value, used: true } }), value);
    assert.equal(await page.locator('.chat-action').nth(1).isDisabled(), true);
    await page.evaluate(() => window.fixture.listeners.status({ connected: false, state: 'idle' }));
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('.chat-action')].every((b) => b.disabled)), true);
    await page.evaluate(() => window.fixture.listeners.status({ connected: true, state: 'play', chatSession: 'new-fixture' }));
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('.chat-action')].every((b) => b.disabled)), true, 'Stale session never re-enabled');
    await page.locator('#btn-clear').click(); assert.equal(await page.locator('.chat-line').count(), 0);
    assert.equal(await page.locator('#chat-empty').count(), 1);
    console.log('PASS history cap, deferred-layout tail/scroll, view switching, autoscroll setting, actions, stale sessions and clearing');

    await page.evaluate(() => {
      const players = Array.from({ length: 512 }, (_, i) => ({ name: 'Fixture' + i, latency: 5, observedSince: 100000 }));
      window.fixture.players = players;
      window.fixture.listeners.status({ connected: true, state: 'play', target: { host: 'example.invalid', port: 25565 },
        players: { known: true, server: 'example.invalid:25565', players } });
    });
    await page.locator('#tab-presence').click(); await settled(page);
    const roster = await page.evaluate(() => {
      const list = document.getElementById('online-players');
      const original = [...list.children];
      const observer = new MutationObserver(() => {}); observer.observe(list, { childList: true });
      const players = window.fixture.players.map((p) => ({ ...p, latency: 6 }));
      window.fixture.listeners.status({ players: { known: true, server: 'example.invalid:25565', players } });
      const mutations = observer.takeRecords(); observer.disconnect();
      return { count: list.children.length, preserved: original.every((node, i) => node === list.children[i]), mutations: mutations.length,
        latencyUpdated: [...list.querySelectorAll('small')].every((el) => el.textContent === '6 ms') };
    });
    assert.deepEqual(roster, { count: 512, preserved: true, mutations: 0, latencyUpdated: true });
    await page.evaluate(() => {
      const list = document.getElementById('online-players'); window.fixture.keptPlayer = list.children[4];
      const players = [window.fixture.players[4], window.fixture.players[2], { name: 'NewFixture', latency: 1, observedSince: 200000 }];
      window.fixture.listeners.status({ players: { known: true, server: 'example.invalid:25565', players } });
    });
    assert.equal(await page.evaluate(() => window.fixture.keptPlayer === document.getElementById('online-players').firstElementChild), true);
    assert.deepEqual(await page.locator('.online-player span').allTextContents(), ['Fixture4', 'Fixture2', 'NewFixture']);
    await page.locator('#presence-name').fill('new'); assert.equal(await page.locator('.online-player').count(), 1);
    await page.locator('.online-player').click(); assert.equal(await page.locator('#presence-name').inputValue(), 'NewFixture');
    await page.evaluate(() => window.fixture.listeners.status({ state: 'idle', connected: false }));
    assert.equal(await page.locator('.online-player').count(), 0);
    assert.equal(await page.evaluate(() => window.fixture.sends), 0);
    assert.deepEqual(errors, []);
    console.log('PASS roster node reuse, latency patching, additions/removals/order, search and disconnect; no Minecraft traffic');
  } finally { await page.close(); }
}

async function readingPositions(browser) {
  for (const size of [{ width: 1060, height: 720 }, { width: 860, height: 600 }]) {
    const { page, errors } = await makePage(browser);
    try {
      await page.setViewportSize(size);
      await page.evaluate(() => {
        window.fillMessages(800, 6);
        for (let i = 0; i < 800; i++) window.fixture.listeners.log({ level: 'net', text: 'READ_LOG_' + i + ' ' + 'wrapped fixture '.repeat(12) });
      });
      await settled(page);
      await page.waitForFunction(() => document.querySelectorAll('#chat-view .chat-line').length === 800);
      for (const name of ['chat', 'log']) {
        await page.locator('#tab-' + name).click(); await settled(page);
        const view = page.locator('#' + name + '-view'), box = await view.boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.wheel(0, -600); await settled(page);
        const anchor = await view.evaluate((view) => {
          const box = view.getBoundingClientRect();
          window.fixture.readingLine = [...view.children].find((line) => {
            const rect = line.getBoundingClientRect(); return rect.top >= box.top && rect.bottom <= box.bottom;
          });
          return { text: window.fixture.readingLine.textContent, top: window.fixture.readingLine.getBoundingClientRect().top,
            remaining: view.scrollHeight - view.clientHeight - view.scrollTop };
        });
        assert.ok(anchor.remaining > 200, name + ': wheel must genuinely move into history');
        const send = () => page.evaluate((name) => {
          if (name === 'chat') window.fillMessages(40, 6);
          else for (let i = 0; i < 40; i++) window.fixture.listeners.log({ level: 'net', text: 'NEW_LOG_' + i });
        }, name);
        const verify = async (stage) => {
          const reading = await view.evaluate((view) => ({
            text: window.fixture.readingLine.textContent, connected: window.fixture.readingLine.isConnected,
            top: window.fixture.readingLine.getBoundingClientRect().top,
            remaining: view.scrollHeight - view.clientHeight - view.scrollTop,
          }));
          assert.equal(reading.connected, true, name + ': retained reading row remains in capped history');
          assert.equal(reading.text, anchor.text);
          assert.ok(Math.abs(reading.top - anchor.top) < 2, name + ' preserves anchor after ' + stage + ': ' + JSON.stringify(reading));
          assert.ok(reading.remaining > 200, name + ': new arrivals must not jump to bottom');
        };
        await send(); await settled(page); await verify('visible arrivals with 800-row eviction');
        await page.locator('#tab-presence').click(); await send();
        await page.locator('#tab-' + name).click(); await settled(page); await verify('hidden arrivals and tab switching');
        await page.evaluate(() => { applyDisplaySettings(); resizeMessageViews(); });
        await settled(page); await verify('settings reapplication and resize handling');
        await page.screenshot({ path: path.join(root, 'dist', 'ui-history-reading-' + version + suffix + '-' + name + '-' + size.width + '.png') });

        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.wheel(0, 100000); await settled(page);
        assert.equal(await page.evaluate((name) => viewScrolls[name].pinned, name), true, name + ': returning to bottom resumes following');
        await send(); await settled(page);
        assert.ok(await view.evaluate((view) => view.scrollHeight - view.clientHeight - view.scrollTop < 2), name + ': resumed following reaches newest row');
      }
      assert.equal(await page.evaluate(() => window.fixture.sends), 0);
      assert.deepEqual(errors, []);
      console.log('PASS chat/log history anchors, visible/hidden arrivals at the 800-row cap, settings and manual resume (' + size.width + ')');
    } finally { await page.close(); }
  }
}

async function run() {
  let browser;
  if (electronRuntime) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-tabs-perf-electron-'));
    const env = { ...process.env, APPDATA: dir, LOCALAPPDATA: dir }; delete env.ELECTRON_RUN_AS_NODE;
    const app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'),
      args: [path.join(root, 'tools/renderer_perf_host.js'), '--user-data-dir=' + path.join(dir, 'profile')], env });
    let first = true;
    browser = {
      async newPage() {
        if (first) { first = false; return app.firstWindow(); }
        const window = app.waitForEvent('window');
        await app.evaluate(({ BrowserWindow }) => {
          const win = new BrowserWindow({ width: 1060, height: 720, useContentSize: true, show: false,
            webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen: true } });
          win.loadURL('about:blank');
        });
        return window;
      },
      close: () => app.close(),
    };
  } else browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    if (compare) { assert.ok(fs.existsSync(baseline), 'Preserved 2.4.12 baseline package required'); stats.push(await measure(browser, true)); }
    stats.push(await measure(browser)); await behaviors(browser); await readingPositions(browser);
    console.log(JSON.stringify(stats, null, 2));
    if (compare) assert.ok(stats[1].chatSwitchAverageMs < stats[0].chatSwitchAverageMs * 0.5, 'Rich-text switching must materially improve');
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dist', 'tab-performance-' + version + suffix + '.json'), JSON.stringify(stats, null, 2));
    console.log('PASS tab performance and functional regressions');
  } finally { await browser.close(); }
}
run().catch((e) => { console.error(e); process.exitCode = 1; });
