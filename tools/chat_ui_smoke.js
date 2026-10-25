'use strict';

// Actual renderer, fake IPC and command sink; never connects to a Minecraft server.
const assert = require('assert/strict');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright');
const { componentToRuns, componentToText } = require('../src/chat_component');
const { ChatActions } = require('../src/chat_actions');
const { parseShop } = require('../src/daily_purchase');
const version = require('../package.json').version;
const root = path.join(__dirname, '..');
const registry = new ChatActions();
const commands = [], actionCalls = [], sayCalls = [];
const configSaves = [];
let savedConfig = {
  servers: [
    { name: '\u79bb\u7ebf\u6d4b\u8bd5\u670d', host: 'example.invalid', port: 25565 },
    { name: '\u5907\u7528\u6d4b\u8bd5\u670d', host: 'backup.invalid', port: 25565 },
  ],
  username: 'Tester', autoLogin: false,
  behavior: { showChat: true, greet: 'FIXTURE_ONLY', commands: ['FIXTURE_ONLY'] },
  reconnect: { enabled: true, delaySeconds: 5, maxAttempts: 10 },
  display: { autoScroll: true, showMonitor: true },
  shortcuts: [{ name: 'Fixture command', command: '/fixture chosen' }],
};
const client = { state: 'play', command: (value) => { commands.push(value); return true; } };

function fixture(node, type = 'system', sender = null) {
  return { text: componentToText(node), segments: registry.register(componentToRuns(node)),
    type, sender, session: registry.session, t: Date.now() };
}

async function run() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1060, height: 720 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.route(/^https?:/, (route) => route.abort());
    await page.exposeFunction('mockAction', async (id) => {
      actionCalls.push(id);
      return registry.activate(id, client, async () => false);
    });
    await page.exposeFunction('mockSay', async (value) => {
      sayCalls.push(value);
      return { ok: false, error: 'Offline fixture: not sent' };
    });
    await page.exposeFunction('mockConfig', () => savedConfig);
    await page.exposeFunction('mockSave', (config) => {
      savedConfig = structuredClone(config);
      configSaves.push(savedConfig);
      return { ok: true };
    });
    await page.addInitScript(() => {
      window.listeners = {};
      window.fixture = { saveFailure: false, holdSave: false, releaseSave: null,
        saveAttempts: 0, connects: 0, disconnects: 0 };
      window.api = {
        getConfig: () => window.mockConfig(),
        saveConfig: async (config) => {
          window.fixture.saveAttempts++;
          if (window.fixture.holdSave) await new Promise((resolve) => { window.fixture.releaseSave = resolve; });
          if (window.fixture.saveFailure) return { ok: false, error: 'Offline fixture: disk full' };
          return window.mockSave(config);
        },
        pingServer: async () => ({ ok: false, error: '\u79bb\u7ebf\u9884\u89c8' }),
        connect: async () => { window.fixture.connects++; return { ok: true }; },
        disconnect: async () => { window.fixture.disconnects++; return { ok: true }; },
        getBridgeStatus: async () => ({ mode: 'standalone', listening: false, paired: false, online: false }),
        setConnectionMode: async (mode) => {
          if (window.fixture.modeFailure) return { ok: false, error: 'Offline mode failure' };
          (window.fixture.modes ||= []).push(mode);
          window.listeners.status({ connectionMode: mode, connected: false, state: 'idle',
            bridge: { listening: false, paired: false, online: false } });
          return { ok: true };
        },
        startBridge: async () => {
          window.fixture.bridgeStarts = (window.fixture.bridgeStarts || 0) + 1;
          window.listeners.status({ connectionMode: 'bridge', state: 'bridge-wait',
            bridge: { listening: true, paired: false, online: false } });
          return { ok: true };
        },
        exportBridgePairing: async () => { window.fixture.exports = (window.fixture.exports || 0) + 1; return { ok: true }; },
        peekAccount: async () => null,
        getMetrics: async () => ({ app: { cpuPct: 2, peakCpuPct: 35, memPct: 1.5, peakMemPct: 2.3,
          memBytes: 240 * 1024 * 1024, peakMemBytes: 368 * 1024 * 1024 }, processes: [] }),
        onStatus: (fn) => { window.listeners.status = fn; },
        onChat: (fn) => { window.listeners.chat = fn; },
        onLog: (fn) => { window.listeners.log = fn; },
        onMetrics: (fn) => { window.listeners.metrics = fn; },
        say: (value) => window.mockSay(value),
        chatAction: (id) => window.mockAction(id),
        getOnline: async () => ({ known: false, players: [] }),
        retryDailyPurchase: async () => {
          window.fixture.purchaseRetries = (window.fixture.purchaseRetries || 0) + 1;
          window.listeners.status({ dailyPurchase: { day: '2026-10-22', count: 0, status: 'collecting', shops: null } });
          return { ok: true };
        },
        completeCommand: async (text) => {
          window.fixture.completionText = text;
          if (window.fixture.holdCompletion) await new Promise((resolve) => { window.fixture.releaseCompletion = resolve; });
          return { ok: true, start: 1, length: text.length - 1,
            matches: [{ text: 'help', tooltip: 'Fixture tip' }, { text: 'hello', tooltip: '' }] };
        },
        closeMenu: async (id) => { (window.fixture.menuCloses ||= []).push(id); return { ok: true }; },
        clickMenu: async (request) => {
          (window.fixture.menuClicks ||= []).push(request);
          if (window.fixture.holdMenuClick) await new Promise((resolve) => { window.fixture.releaseMenuClick = resolve; });
          if (window.fixture.menuClickFailure) return { ok: false, error: 'Offline fixture: stale menu' };
          const menu = window.fixture.menu;
          if (menu && menu.token === request.token) {
            window.fixture.menu = { ...menu, interactive: false, pending: { slot: request.slot } };
            window.listeners.status({ menu: window.fixture.menu });
          }
          return { ok: true };
        },
      };
    });
    await page.goto(pathToFileURL(path.join(root, 'app/renderer/index.html')).href);
    await page.waitForFunction(() => typeof window.listeners.chat === 'function');
    await page.waitForFunction(() => document.getElementById('mon-cpu').textContent.includes('35.0%'));
    assert.equal(await page.title(), '\u8292\u679c\u7aef\u8f85\u52a9');
    assert.equal(await page.locator('canvas, #inp-username, #chk-premium').count(), 0);
    assert.equal(await page.locator('.col-left #monitor-panel').count(), 1);
    assert.equal(await page.locator('#mon-cpu').innerText(), '2.0% / 35.0%');
    assert.equal(await page.locator('#mon-mem').innerText(), '1.5% / 2.3%');
    await page.locator('#tab-log').click(); assert.equal(await page.locator('#monitor-panel').isVisible(), true);
    await page.locator('#tab-presence').click(); assert.equal(await page.locator('#monitor-panel').isVisible(), true);
    await page.locator('#tab-chat').click();
    await page.waitForFunction(() => [...document.querySelectorAll('.settings-icon, .close-icon')]
      .every((image) => image.complete && image.naturalWidth === 24));
    await page.evaluate((session) => {
      window.listeners.status({ event: 'join', chatSession: session });
      document.getElementById('conn-host').textContent = '\u79bb\u7ebf\u6d88\u606f\u9884\u89c8';
      document.getElementById('conn-meta').textContent = '\u6a21\u62df\u6d88\u606f \u00b7 \u672a\u8fde\u63a5\u670d\u52a1\u5668';
      document.getElementById('st-state').textContent = '\u79bb\u7ebf\u9884\u89c8';
      document.getElementById('toast').classList.add('hidden');
    }, registry.session);
    const messages = [
      fixture({ translate: 'death.attack.mob', with: ['Loveff', { translate: 'entity.minecraft.enderman' }] }),
      fixture({ translate: 'chat.type.advancement.task', with: ['Ctiy_one',
        { translate: 'chat.square_brackets', with: [{ translate: 'advancements.adventure.sleep_in_bed.title' }] }] }),
      fixture({ text: '\u606d\u559c\u73a9\u5bb6Loveff\u5df2\u83b7\u5f97\u4eca\u5929\u5168\u90e8\u5728\u7ebf\u5956\u52b1\uff01', color: 'green' }),
      fixture({ text: '[\u7ea2\u5305]\u73a9\u5bb6 shiyuejiu109 \u53d1\u9001\u4e86\u4e00\u4e2a \u62fc\u624b\u6c14\u7ea2\u5305 ', color: 'gold', extra: [{
        text: '\u3010\u70b9\u51fb\u9886\u53d6\u3011', bold: true, color: 'yellow',
        click_event: { action: 'run_command', command: '/fixture claim packet' },
        hover_event: { action: 'show_text', value: { text: '\u9886\u53d6\u7ea2\u5305' } },
      }] }),
      fixture({ text: '[\u7ea2\u5305]\u73a9\u5bb6 shiyuejiu109 \u53d1\u9001\u4e86\u4e00\u4e2a \u53e3\u4ee4\u7ea2\u5305 ', color: 'gold', extra: [{
        text: '\u3010\u8f93\u5165\u53e3\u4ee4\u9886\u53d6\u3011', color: 'green',
        click_event: { action: 'suggest_command', command: '/fixture password ' },
      }] }),
      fixture({ text: '\u4eca\u5929\u516c\u4f1a\u8fd8\u6ca1\u6709\u7b7e\u5230\uff0c', color: 'white', extra: [{
        text: '[\u70b9\u51fb\u7b7e\u5230]', color: 'aqua',
        clickEvent: { action: 'run_command', value: '/fixture signin' },
      }] }),
      fixture({ text: 'Player chat fixture', color: 'white' }, 'player', 'ExamplePlayer'),
      fixture({ text: '<img src=x onerror=alert(1)>', color: 'gray' }),
    ];
    for (const message of messages) await page.evaluate((data) => window.listeners.chat(data), message);
    await page.evaluate(() => new Promise((resolve) => {
      let frames = 0;
      const tick = () => ++frames === 5 ? resolve() : requestAnimationFrame(tick);
      requestAnimationFrame(tick);
    }));
    assert.equal(actionCalls.length, 0, 'Receiving messages must not activate clicks');
    assert.equal(commands.length, 0);
    assert.equal(sayCalls.length, 0);
    assert.equal(await page.locator('#chat-view img').count(), 0, 'Remote text must not be HTML');
    assert.match(await page.locator('#chat-view').innerText(), /\u672b\u5f71\u4eba/);
    await page.locator('#chat-filter').selectOption('redpacket');
    assert.equal(await page.locator('.chat-line:not(.hidden)').count(), 2);
    await page.locator('#chat-filter').selectOption('player');
    assert.equal(await page.locator('.chat-line:not(.hidden)').count(), 1);
    await page.locator('#chat-filter').selectOption('all');
    const presenceMessage = { ...fixture({ text: '[+] MJWENS' }), category: 'presence' };
    await page.evaluate((data) => window.listeners.chat(data), presenceMessage);
    assert.equal(await page.locator('.chat-line[data-category="presence"]').isVisible(), false);
    await page.locator('#chat-filter').selectOption('presence');
    assert.equal(await page.locator('.chat-line:not(.hidden)').count(), 1);
    await page.locator('#chat-filter').selectOption('all');
    assert.equal(await page.locator('.chat-line[data-category="presence"]').isVisible(), false);
    await page.evaluate(() => {
      window.listeners.log({ level: 'system', text: 'DUPLICATE_CHAT_MUST_NOT_APPEAR' });
      window.listeners.log({ level: 'automation', text: '\u7ea2\u5305\u9886\u53d6\u6307\u4ee4\u5df2\u53d1\u9001\uff0c\u7b49\u5f85\u786e\u8ba4' });
      window.listeners.log({ level: 'auth', text: '\u79bb\u7ebf\u8d26\u53f7\u9884\u89c8' });
      window.listeners.log({ level: 'error', text: '\u79bb\u7ebf\u9519\u8bef\u9884\u89c8' });
      window.listeners.log({ level: 'chat', text: '[Nan_Koi] hello Nan_Koi' });
    });
    assert.equal(await page.locator('#log-view').textContent().then((text) => text.includes('DUPLICATE_CHAT')), false);
    await page.locator('#tab-log').click();
    await page.locator('#log-filter').selectOption('automation');
    assert.equal(await page.locator('.log-line:not(.hidden)').count(), 1);
    assert.equal(await page.locator('#chat-filter').isVisible(), false);
    await page.locator('#log-filter').selectOption('error');
    assert.equal(await page.locator('.log-line:not(.hidden)').count(), 1);
    await page.locator('#log-filter').selectOption('chat');
    assert.equal(await page.locator('.log-line:not(.hidden)').count(), 1);
    assert.match(await page.locator('.log-line:not(.hidden)').textContent(), /hello Nan_Koi/);
    await page.locator('#log-filter').selectOption('all');
    await page.evaluate(() => {
      window.listeners.log({ level: 'net', text: '[游戏指令] 15:02:04 游戏提交出站：/fixture workbench' });
    });
    await page.locator('#log-filter').selectOption('connection');
    assert.match(await page.locator('#log-view').textContent(), /游戏提交出站：\/fixture workbench/);
    assert.equal(await page.locator('#chat-view').textContent().then((text) => text.includes('fixture workbench')), false);
    await page.locator('#log-filter').selectOption('all');
    await page.evaluate(() => window.listeners.status({ chatDiagnostics: {
      received: { player: 0, system: 6, profileless: 0, actionbar: 0 },
      emitted: { player: 0, system: 6, profileless: 0, actionbar: 0 },
      errors: { player: 0, system: 0, profileless: 0, actionbar: 0 },
      teleports: 1, teleportReplies: 1, detailFallbacks: 0,
    } }));
    assert.match(await page.locator('#chat-diagnostics').innerText(), /\u73a9\u5bb6\u804a\u5929.*0/);
    await page.locator('#tab-presence').click();
    assert.equal(await page.locator('#send-bar').isVisible(), false);
    assert.equal(await page.locator('#btn-clear').isVisible(), false);
    await page.evaluate(() => window.listeners.status({ players: { known: true, server: 'example.invalid:25565',
      players: [{ name: 'MJWENS', latency: 42, observedSince: Date.now() },
        { name: 'ExamplePlayer', latency: 24, observedSince: Date.now() }] } }));
    await page.locator('#presence-name').fill('');
    assert.equal(await page.locator('.online-player').count(), 2);
    await page.locator('#presence-name').fill('Example');
    assert.equal(await page.locator('.online-player').count(), 1);
    await page.locator('.online-player').click();
    assert.equal(await page.locator('#presence-name').inputValue(), 'ExamplePlayer');
    await page.locator('#presence-name').fill('');
    for (const size of [{ width: 1060, height: 720 }, { width: 860, height: 600 }]) {
      await page.setViewportSize(size);
      await page.screenshot({ path: path.join(root, 'dist', 'ui-presence-' + version + '-' + size.width + '.png') });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.equal(await page.locator('.online-players').evaluate((el) => el.scrollWidth > el.clientWidth + 1), false);
      assert.ok(await page.locator('.online-players').evaluate((el) => el.clientHeight >= 100), 'Online player list needs room for visible players');
    }
    assert.equal(await page.locator('#presence-query').count(), 0);
    assert.equal(await page.locator('.presence-results').count(), 0);
    await page.locator('#tab-chat').click();

    await page.locator('#tab-purchase').click();
    assert.equal(await page.locator('#send-bar').isVisible(), false);
    assert.equal(await page.locator('#btn-clear').isVisible(), false);
    assert.equal(await page.locator('#purchase-retry').isDisabled(), false);
    await page.evaluate(() => window.listeners.status({ dailyPurchase: {
      day: '2026-10-22', context: 'example.invalid:25565/Tester', count: 0, status: 'collecting', shops: null,
    } }));
    assert.equal(await page.locator('#purchase-retry').isDisabled(), true);
    assert.match(await page.locator('#purchase-empty').innerText(), /正在读取/);
    await page.evaluate(() => window.listeners.status({ dailyPurchase: {
      day: '2026-10-22', count: 0, status: 'error', error: '菜单响应超时', shops: null,
    } }));
    await page.locator('#purchase-retry').click();
    assert.equal(await page.evaluate(() => window.fixture.purchaseRetries), 1);
    assert.equal(await page.locator('#purchase-retry').isDisabled(), true);
    const cropIds = ['gigantic_pineapple', 'virelo_silver_star', 'cabbage_golden_star', 'green_bean_golden_star',
      'eggplant_golden_star', 'leek_golden_star', 'corn_silver_star', 'pineapple_silver_star', 'onion_silver_star',
      'lettuce', 'cucumber', 'onion', 'leek', 'corn', 'pineapple'];
    const prices = [113, 39, 23, 18, 17, 14, 11, 7, 7, 1, 1, 1, 1, 1, 1];
    const slots = Array(54).fill(null);
    cropIds.forEach((id, i) => { slots[i] = { name: 'item.customcrops.' + id, identifier: 'minecraft:paper',
      lore: ['卖价: ' + prices[i] + '金币 ' + (i < 8 ? '↑' : i < 10 ? '' : '↓'),
        '玩家出售限量: ' + (i === 0 ? '1/1' : '0/200')] }; });
    const cropItems = parseShop({ title: '星露谷每日随机收购商店', status: 'ready', expectedSlots: 54, slots }).items;
    await page.evaluate((items) => {
      window.listeners.status({ dailyPurchase: { day: '2026-10-22', context: 'example.invalid:25565/Tester',
        count: 1, autoCount: 1, manualCount: 2, status: 'complete', collectedAt: Date.now(), shops: {
          system: { items: [{ ...items[0], name: '<img src=x onerror=alert(1)>黑曜石', price: 25 }] }, crops: { items },
        } } });
    }, cropItems);
    assert.equal(await page.locator('.purchase-table tbody tr').count(), 16);
    const cropNames = await page.locator('.purchase-section').last().locator('tbody td:first-child').allTextContents();
    assert.ok(cropNames.includes('巨型菠萝')); assert.ok(cropNames.includes('幽碧兰（银星）'));
    assert.equal(cropNames.some((name) => name.includes('item.customcrops.')), false);
    const pineappleTip = await page.locator('.purchase-section').last().locator('tbody td:first-child').first().getAttribute('title');
    assert.match(pineappleTip, /item\.customcrops\.gigantic_pineapple/); assert.match(pineappleTip, /minecraft:paper/);
    const firstRow = await page.locator('.purchase-table tbody tr').first().elementHandle();
    await page.evaluate(() => window.listeners.status({ state: 'play', uptime: '0:00:10' }));
    assert.equal(await firstRow.evaluate((el) => el.isConnected), true, 'Status polling must not rebuild the purchase tables');
    assert.equal(await page.locator('#purchase-shops img').count(), 0);
    assert.equal(await page.locator('#purchase-retry').isEnabled(), true);
    assert.equal(await page.locator('#purchase-retry').innerText(), '重新获取');
    assert.match(await page.locator('#purchase-meta').innerText(), /今日自动 1\/1.*手动成功 2 次/);
    await page.evaluate(() => { window.fixture.purchaseComplete = structuredClone(purchaseSnapshot); });
    for (const size of [{ width: 1060, height: 720 }, { width: 860, height: 600 }]) {
      await page.setViewportSize(size);
      await page.screenshot({ path: path.join(root, 'dist', 'ui-purchase-' + version + '-' + size.width + '.png') });
      assert.equal(await page.locator('#purchase-view').evaluate((el) => el.scrollWidth > el.clientWidth + 1), false);
      assert.equal(await page.locator('.tabs').evaluate((el) => el.scrollWidth > el.clientWidth + 1), false);
      assert.equal(await page.locator('.purchase-table-wrap').last().evaluate((el) => el.scrollWidth > el.clientWidth + 1), false);
    }
    for (let count = 3; count <= 4; count++) {
      await page.locator('#purchase-retry').click();
      assert.equal(await page.locator('#purchase-retry').isDisabled(), true);
      await page.evaluate((manualCount) => window.listeners.status({ dailyPurchase: {
        ...window.fixture.purchaseComplete, manualCount,
      } }), count);
      assert.equal(await page.locator('#purchase-retry').isEnabled(), true);
      assert.match(await page.locator('#purchase-meta').innerText(), new RegExp('手动成功 ' + count + ' 次'));
    }
    assert.equal(await page.evaluate(() => window.fixture.purchaseRetries), 3);
    await page.evaluate(() => window.listeners.status({ dailyPurchase: {
      ...window.fixture.purchaseComplete, status: 'error', error: '手动刷新超时，保留上次快照',
    } }));
    assert.equal(await page.locator('#purchase-empty').isVisible(), true);
    assert.match(await page.locator('#purchase-empty').innerText(), /保留上次快照/);
    assert.equal(await page.locator('.purchase-table tbody tr').count(), 16);
    assert.equal(await page.locator('#purchase-retry').isEnabled(), true);
    await page.locator('#tab-chat').click();

    await page.locator('#shortcut-select').selectOption('0');
    assert.equal(await page.locator('#inp-send').inputValue(), '/fixture chosen');
    assert.equal(sayCalls.length, 0, 'Shortcuts fill only');
    await page.locator('#inp-send').fill('/he');
    await page.locator('#inp-send').press('Tab');
    await page.waitForFunction(() => document.getElementById('inp-send').value === '/help');
    assert.equal(await page.locator('.completion-option').count(), 2);
    await page.locator('#inp-send').press('Tab');
    assert.equal(await page.locator('#inp-send').inputValue(), '/hello');
    await page.locator('#inp-send').press('Enter');
    assert.equal(await page.locator('#completion-list').isVisible(), false);
    assert.equal(sayCalls.length, 0, 'Enter accepts an open completion without sending');
    await page.locator('#inp-send').fill('/he');
    await page.evaluate(() => { window.fixture.holdCompletion = true; });
    await page.locator('#inp-send').press('Tab');
    await page.waitForFunction(() => typeof window.fixture.releaseCompletion === 'function');
    await page.locator('#inp-send').fill('/do-not-overwrite');
    await page.evaluate(() => { window.fixture.holdCompletion = false; window.fixture.releaseCompletion(); });
    assert.equal(await page.locator('#inp-send').inputValue(), '/do-not-overwrite');
    await page.evaluate(() => {
      window.fixture.menu = { id: 300, token: '00000000-0000-0000-0000-000000000300', revision: 1,
      title: '\u516c\u4f1a\u7b7e\u5230', interactive: true, pending: null,
      expectedSlots: 27, status: 'ready', slots: Array.from({ length: 63 }, (_, i) => i === 0 ? {
        name: '\u670d\u52a1\u5668\u81ea\u5b9a\u4e49\u7269\u54c1\u540d\u79f0\u957f\u6587\u672c', count: 3,
        identifier: 'minecraft:diamond', lore: ['Fixture lore'],
      } : i === 11 || i === 15 ? {
        name: i === 15 ? '[\u91d1\u5e01\u7b7e\u5230]' : '[\u70b9\u5238\u7b7e\u5230]', count: 1,
        identifier: 'minecraft:gold_ingot', lore: ['Fixture lore'],
      } : i < 27 ? { name: '[\u5206\u5272\u677f]', count: 1, identifier: 'minecraft:glass_pane', lore: [] } : null) };
      window.listeners.status({ menu: window.fixture.menu });
    });
    assert.equal(await page.locator('#server-menu-dialog').evaluate((el) => el.open), true);
    assert.equal(await page.locator('#server-menu-grid .menu-slot').count(), 27);
    assert.equal(await page.locator('#server-menu-grid button:enabled').count(), 27);
    assert.equal(await page.locator('#server-inventory-grid button').count(), 0, 'Inventory stays read-only');
    assert.match(await page.locator('#server-menu-grid .menu-slot').first().getAttribute('title'), /Fixture lore/);
    for (const size of [{ width: 1060, height: 720 }, { width: 860, height: 600 }]) {
      await page.setViewportSize(size);
      await page.screenshot({ path: path.join(root, 'dist', 'ui-menu-' + version + '-' + size.width + '.png') });
      assert.equal(await page.locator('#server-menu-dialog').evaluate((el) => el.scrollWidth > el.clientWidth + 1), false);
    }
    const gold = page.locator('#server-menu-grid [data-slot="15"]');
    await gold.click({ modifiers: ['Shift'] });
    assert.equal(await page.evaluate(() => (window.fixture.menuClicks || []).length), 0);
    await gold.click();
    await page.waitForFunction(() => window.fixture.menuClicks && window.fixture.menuClicks.length === 1);
    const firstClick = await page.evaluate(() => window.fixture.menuClicks[0]);
    assert.deepEqual(firstClick, { id: 300, token: '00000000-0000-0000-0000-000000000300', revision: 1, slot: 15, button: 0 });
    await page.waitForFunction(() => document.querySelectorAll('#server-menu-grid button:enabled').length === 0);
    await gold.evaluate((button) => button.click());
    assert.equal(await page.evaluate(() => window.fixture.menuClicks.length), 1, 'Pending click never duplicates');
    assert.match(await page.locator('#server-menu-status').innerText(), /\u7b49\u5f85\u670d\u52a1\u5668/);
    await page.evaluate(() => {
      window.fixture.menu = { ...window.fixture.menu, revision: 2, pending: null, interactive: true };
      window.listeners.status({ menu: window.fixture.menu });
    });
    await gold.click({ button: 'right' });
    await page.waitForFunction(() => window.fixture.menuClicks.length === 2);
    assert.equal(await page.evaluate(() => window.fixture.menuClicks[1].button), 1);
    await page.evaluate(() => {
      window.fixture.menu = { ...window.fixture.menu, pendingTimedOut: true };
      window.listeners.status({ menu: window.fixture.menu });
    });
    assert.match(await page.locator('#server-menu-status').innerText(), /\u7ed3\u679c\u672a\u77e5/);
    assert.equal(await page.locator('#server-menu-grid button:enabled').count(), 0);
    await page.evaluate(() => {
      window.fixture.menu = { ...window.fixture.menu, revision: 3, pending: null, pendingTimedOut: false,
        interactive: false, cursor: { name: 'Fixture carried item', count: 1 } };
      window.listeners.status({ menu: window.fixture.menu });
    });
    assert.match(await page.locator('#server-menu-status').innerText(), /Fixture carried item/);
    assert.equal(await page.locator('#server-menu-grid button:enabled').count(), 0);
    await page.evaluate(() => {
      window.fixture.menuClickFailure = true;
      window.fixture.menu = { ...window.fixture.menu, revision: 4, cursor: null, interactive: true };
      window.listeners.status({ menu: window.fixture.menu });
    });
    await gold.click();
    await page.waitForFunction(() => document.getElementById('toast').textContent.includes('stale menu'));
    assert.match(await page.locator('#server-menu-status').innerText(), /stale menu/);
    assert.equal(await gold.isEnabled(), true);
    await page.evaluate(() => { window.fixture.menuClickFailure = false; window.fixture.holdMenuClick = true; });
    await gold.click();
    await page.waitForFunction(() => typeof window.fixture.releaseMenuClick === 'function');
    await page.evaluate(() => {
      window.fixture.menu = { ...window.fixture.menu, token: '00000000-0000-0000-0000-000000000301',
        revision: 1, title: 'New menu', interactive: true, pending: null };
      window.listeners.status({ menu: window.fixture.menu });
      window.fixture.holdMenuClick = false; window.fixture.releaseMenuClick();
    });
    await page.waitForFunction(() => document.getElementById('server-menu-title').textContent === 'New menu');
    assert.equal(await gold.isEnabled(), true, 'Late old IPC must not disable a replacement menu');
    await gold.focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.fixture.menuClicks.length === 5);
    assert.equal(await page.evaluate(() => window.fixture.menuClicks[4].token), '00000000-0000-0000-0000-000000000301');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('server-menu-dialog').open);
    assert.deepEqual(await page.evaluate(() => window.fixture.menuCloses), [300]);
    assert.equal(sayCalls.length, 0); assert.equal(commands.length, 0);

    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    for (const size of [{ width: 1060, height: 720 }, { width: 860, height: 600 }]) {
      await page.setViewportSize(size);
      await page.screenshot({ path: path.join(root, 'dist', 'ui-chat-' + version + '-' + size.width + '.png') });
      const overflow = await page.evaluate(() => {
        const view = document.getElementById('chat-view');
        return { page: document.documentElement.scrollWidth > innerWidth,
          chat: view.scrollWidth > view.clientWidth + 1 };
      });
      assert.deepEqual(overflow, { page: false, chat: false });
    }
    const claim = page.getByRole('button', { name: '\u3010\u70b9\u51fb\u9886\u53d6\u3011', exact: true });
    assert.match(await claim.getAttribute('title'), /fixture claim packet/);
    await claim.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.chat-action').disabled);
    assert.deepEqual(commands, ['fixture claim packet']);
    await claim.evaluate((button) => button.click());
    assert.equal(commands.length, 1, 'Used button must not dispatch again');

    const suggest = page.getByRole('button', { name: '\u3010\u8f93\u5165\u53e3\u4ee4\u9886\u53d6\u3011', exact: true });
    await suggest.click();
    await page.waitForFunction(() => document.getElementById('inp-send').value === '/fixture password ');
    assert.equal(sayCalls.length, 0, 'Suggest must not auto-send');
    assert.equal(commands.length, 1);
    await page.evaluate((session) => {
      window.listeners.status({ redPacketAction: { session, action: 'suggest_command', value: '/fixture do-not-overwrite ' } });
    }, registry.session);
    assert.equal(await page.locator('#inp-send').inputValue(), '/fixture password ', 'Auto suggestion must preserve typed content');

    // A deliberately failed fake IPC must not clear input or show a sent echo.
    const before = await page.locator('.chat-line').count();
    await page.locator('#btn-send').click();
    await page.waitForFunction(() => document.getElementById('toast').textContent.includes('not sent'));
    assert.equal(await page.locator('#inp-send').inputValue(), '/fixture password ');
    assert.equal(await page.locator('.chat-line').count(), before);
    assert.equal(sayCalls.length, 1);

    await page.evaluate(() => window.listeners.status({ event: 'close' }));
    assert.equal(await suggest.isDisabled(), true);
    registry.reset();
    await page.evaluate((session) => window.listeners.status({ event: 'join', chatSession: session }), registry.session);
    assert.equal(await suggest.isDisabled(), true, 'Old clicks stay disabled after a new join');

    await page.evaluate(() => window.listeners.status({ reconnect: { phase: 'waiting',
      attempt: 0, maxAttempts: 10, retryAt: Date.now() + 30000,
      target: { host: 'example.invalid', port: 25565 } } }));
    assert.equal(await page.locator('#btn-connect').innerText(), '\u505c\u6b62\u91cd\u8fde');
    assert.equal(await page.locator('#btn-send').isDisabled(), true);
    await page.locator('.server-item').nth(1).click();
    assert.equal(await page.locator('#conn-host').innerText(), '\u79bb\u7ebf\u6d4b\u8bd5\u670d');
    assert.match(await page.locator('#conn-meta').innerText(), /\u81ea\u52a8\u91cd\u8fde/);
    for (const size of [{ width: 1060, height: 720 }, { width: 860, height: 600 }]) {
      await page.setViewportSize(size);
      await page.screenshot({ path: path.join(root, 'dist', 'ui-reconnect-' + version + '-' + size.width + '.png') });
    }
    await page.locator('#btn-connect').click();
    assert.equal(await page.locator('#btn-connect').innerText(), '\u8fde\u63a5');
    assert.equal(await page.locator('#st-state').innerText(), '\u7a7a\u95f2');
    await page.evaluate(() => window.listeners.status({ reconnect: { phase: 'connecting',
      attempt: 1, maxAttempts: 10, target: { host: 'example.invalid', port: 25565 } } }));
    assert.equal(await page.locator('#btn-connect').innerText(), '\u53d6\u6d88\u91cd\u8fde');
    await page.locator('#btn-connect').click();
    assert.deepEqual(await page.evaluate(() => ({ connects: window.fixture.connects, disconnects: window.fixture.disconnects })),
      { connects: 0, disconnects: 2 });
    assert.deepEqual(commands, ['fixture claim packet'], 'Retry UI must not dispatch any business command');
    assert.equal(sayCalls.length, 1, 'Retry UI must not send a message');
    await page.evaluate(() => window.listeners.status({ reconnect: { phase: 'maintenance', maintenance: true,
      attempt: 0, maxAttempts: 10, retryAt: Date.now() + 600000, target: { host: 'example.invalid', port: 25565 } } }));
    assert.equal(await page.locator('#btn-connect').innerText(), '\u505c\u6b62\u91cd\u8fde');
    assert.equal(await page.locator('#st-state').innerText(), '\u7b49\u5f85\u7ef4\u62a4');
    assert.equal(await page.locator('#inp-send').isDisabled(), true);
    await page.locator('.server-item').nth(1).click();
    assert.equal(await page.locator('#conn-host').innerText(), '\u79bb\u7ebf\u6d4b\u8bd5\u670d');
    for (const size of [{ width: 1060, height: 720 }, { width: 860, height: 600 }]) {
      await page.setViewportSize(size);
      await page.screenshot({ path: path.join(root, 'dist', 'ui-maintenance-' + version + '-' + size.width + '.png') });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.equal(await page.locator('#conn-meta').evaluate((el) => el.scrollWidth > el.clientWidth + 1), false);
      assert.equal(await page.locator('#conn-meta').evaluate((el) => el.clientHeight > parseFloat(getComputedStyle(el).lineHeight) + 1), false);
    }
    await page.locator('#btn-connect').click();
    assert.equal(await page.locator('#st-state').innerText(), '\u7a7a\u95f2');
    await page.evaluate(() => window.listeners.status({ reconnect: { phase: 'connecting', maintenance: true,
      attempt: 0, maxAttempts: 10, target: { host: 'example.invalid', port: 25565 } } }));
    assert.equal(await page.locator('#st-state').innerText(), '\u68c0\u67e5\u6062\u590d');
    await page.locator('#btn-connect').click();
    assert.equal(await page.evaluate(() => window.fixture.connects), 0);
    assert.equal(commands.length, 1); assert.equal(sayCalls.length, 1);
    await page.evaluate((session) => {
      window.listeners.status({ event: 'join', chatSession: session });
    }, registry.session);
    const autoMessage = fixture({ text: '[\u7ea2\u5305]\u73a9\u5bb6 Sender \u53d1\u9001\u4e86\u7ea2\u5305 ', extra: [{
      text: '\u3010\u81ea\u52a8\u9886\u53d6\u9884\u89c8\u3011', click_event: { action: 'run_command', command: '/fixture automatic' },
    }] });
    await page.evaluate((data) => window.listeners.chat(data), autoMessage);
    const autoButton = page.getByRole('button', { name: '\u3010\u81ea\u52a8\u9886\u53d6\u9884\u89c8\u3011', exact: true });
    assert.equal(await autoButton.isEnabled(), true);
    await page.evaluate((session) => window.listeners.status({ redPacketAction: { session,
      action: 'run_command', value: '/fixture automatic', used: true } }), registry.session);
    assert.equal(await autoButton.isDisabled(), true, 'An automatic main-process action disables its manual button');
    assert.equal(commands.length, 1, 'Renderer must not send the already executed action again');
    const welcomeMessage = fixture({ text: '\u65b0\u73a9\u5bb6sw_wD\u52a0\u5165\u4e86\u8292\u679c\u5c0f\u9547\uff01', extra: [{
      text: '[ \ufffd\ufffd \u70b9\u51fb\u6b22\u8fce \ufffd\ufffd ]',
      click_event: { action: 'run_command', command: '/fixture welcome sw_wD' },
    }] });
    await page.evaluate((data) => window.listeners.chat(data), welcomeMessage);
    const welcomeButton = page.getByRole('button', { name: '[ \ufffd\ufffd \u70b9\u51fb\u6b22\u8fce \ufffd\ufffd ]', exact: true });
    assert.equal(await welcomeButton.isEnabled(), true);
    await page.evaluate((session) => window.listeners.status({ automationAction: { session,
      action: 'run_command', value: '/fixture welcome sw_wD', used: true, source: 'welcome', count: 1 } }), registry.session);
    assert.equal(await welcomeButton.isDisabled(), true);
    assert.match(await welcomeButton.getAttribute('title'), /\u81ea\u52a8\u6b22\u8fce/);
    assert.equal(commands.length, 1, 'Renderer does not resend an automatically handled welcome');

    const dialog = page.locator('#settings-dialog');
    await page.locator('#btn-settings').click();
    assert.equal(await dialog.evaluate((el) => el.open), true);
    assert.equal(await page.evaluate(() => {
      document.getElementById('btn-login').focus();
      return document.getElementById('settings-dialog').contains(document.activeElement);
    }), true, 'Background controls must be inert while the native modal is open');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.getElementById('settings-dialog').contains(document.activeElement)), true);
    await page.locator('#chk-reconnect').uncheck();
    assert.equal(await page.locator('#inp-reconnect-delay').isDisabled(), true);
    await page.keyboard.press('Escape');
    assert.equal(await dialog.evaluate((el) => el.open), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'btn-settings');
    assert.equal(configSaves.length, 0, 'Cancel must discard the draft');
    await page.locator('#btn-settings').click();
    assert.equal(await page.locator('#chk-reconnect').isChecked(), true);
    assert.equal(await page.locator('#chk-midnight').isChecked(), false);
    assert.equal(await page.locator('#sel-close-behavior').inputValue(), 'quit');
    assert.equal(await page.locator('#inp-claim-delay-min').inputValue(), '0.4');
    assert.equal(await page.locator('#inp-claim-delay-max').inputValue(), '0.85');
    assert.equal(await page.locator('#inp-welcome-delay-min').inputValue(), '0.4');
    assert.equal(await page.locator('#inp-welcome-delay-max').inputValue(), '0.85');
    await page.locator('#chk-welcome-delay').uncheck();
    assert.equal(await page.locator('#inp-welcome-delay-min').isDisabled(), true);
    await page.locator('#chk-welcome-delay').check();
    await page.locator('#inp-welcome-delay-min').fill('1.9');
    await page.locator('#settings-save').click();
    assert.equal(await page.evaluate(() => window.fixture.saveAttempts), 0, 'Inverted welcome delay must not save');
    await page.locator('#inp-welcome-delay-min').fill('1.2');
    await page.locator('#inp-welcome-delay-max').fill('2.3');
    assert.equal(await page.locator('#chk-claim-after').isChecked(), false);
    assert.equal(await page.locator('#chk-claim-delay').isChecked(), true);
    assert.equal(await page.locator('#inp-claim-after-count').inputValue(), '2');
    assert.equal(await page.locator('#inp-claim-after-count').isDisabled(), true);
    await page.locator('#inp-claim-delay-min').fill('0.9');
    await page.locator('#settings-save').click();
    assert.equal(await page.evaluate(() => window.fixture.saveAttempts), 0, 'Inverted delay must not save');
    await page.locator('#inp-claim-delay-min').fill('0.12');
    await page.locator('#inp-claim-delay-max').fill('0.15');
    await page.locator('#sel-close-behavior').selectOption('background');
    assert.equal(await page.locator('#inp-midnight-command').isDisabled(), true);
    await page.locator('#inp-reconnect-delay').fill('1');
    await page.locator('#settings-save').click();
    assert.equal(await page.evaluate(() => window.fixture.saveAttempts), 0, 'Invalid range must not save');
    await page.locator('#inp-reconnect-delay').fill('7');
    await page.locator('#chk-midnight').check();
    assert.equal(await page.locator('#inp-midnight-command').isEnabled(), true);
    await page.locator('#settings-save').click();
    assert.equal(await page.evaluate(() => window.fixture.saveAttempts), 0, 'Enabled midnight command requires content');
    await page.locator('#inp-midnight-command').fill('fixture invalid');
    await page.locator('#settings-save').click();
    assert.equal(await page.evaluate(() => window.fixture.saveAttempts), 0, 'Midnight command requires a slash');
    await page.locator('#inp-midnight-command').fill('/fixture midnight args');
    await page.locator('#settings-shortcuts').fill('Invalid line');
    await page.locator('#settings-save').click();
    assert.equal(await page.evaluate(() => window.fixture.saveAttempts), 0, 'Malformed shortcut must not save');
    await page.locator('#settings-shortcuts').fill('Custom | /fixture custom\nSecond | /fixture second');
    await page.locator('#inp-reconnect-attempts').fill('0');
    await page.locator('#chk-autologin').check();
    await page.locator('#chk-showchat').uncheck();
    await page.locator('#chk-autoscroll').uncheck();
    await page.locator('#chk-showmonitor').uncheck();
    assert.equal(await page.locator('#chk-hidepresence').isChecked(), true);
    await page.locator('#chk-hidepresence').uncheck();
    assert.equal(await page.locator('#chk-autoclaim').isChecked(), true);
    await page.locator('#chk-autoclaim').uncheck();
    assert.equal(await page.locator('#chk-autowelcome').isChecked(), true);
    await page.locator('#chk-autowelcome').uncheck();
    await page.evaluate(() => { window.fixture.holdSave = true; });
    await page.locator('#settings-save').click();
    await page.waitForFunction(() => typeof window.fixture.releaseSave === 'function');
    assert.equal(await page.locator('#settings-close').isDisabled(), true);
    assert.equal(await page.locator('#sel-close-behavior').isDisabled(), true);
    await page.keyboard.press('Escape');
    assert.equal(await dialog.evaluate((el) => el.open), true, 'Do not discard during a pending save');
    await page.evaluate(() => { window.fixture.holdSave = false; window.fixture.releaseSave(); });
    await page.waitForFunction(() => !document.getElementById('settings-dialog').open);
    assert.equal(configSaves.length, 1);
    assert.deepEqual(savedConfig.reconnect, { enabled: true, delaySeconds: 7, maxAttempts: 0 });
    assert.deepEqual(savedConfig.automation, { autoClaimRedPackets: false, autoWelcome: false, paused: false,
      welcomeDelay: { minMs: 1200, maxMs: 2300 }, welcomeDelayEnabled: true,
      claimDelay: { minMs: 120, maxMs: 150 }, claimDelayEnabled: true, claimAfter: { enabled: false, count: 2 } });
    assert.equal(savedConfig.closeBehavior, 'background');
    assert.deepEqual(savedConfig.midnightCommand, { enabled: true, command: '/fixture midnight args' });
    assert.deepEqual(savedConfig.shortcuts, [{ name: 'Custom', command: '/fixture custom' }, { name: 'Second', command: '/fixture second' }]);
    assert.deepEqual(savedConfig.behavior, { showChat: false, greet: 'FIXTURE_ONLY', commands: ['FIXTURE_ONLY'] });
    assert.equal(await page.locator('#monitor-panel').isVisible(), false);
    await page.locator('#tab-chat').click();
    assert.equal(await page.locator('.chat-line[data-category="presence"]').isVisible(), true);
    const filteredCount = await page.locator('.chat-line').count();
    await page.evaluate((data) => window.listeners.chat(data), fixture({ text: 'HIDDEN_FIXTURE' }));
    assert.equal(await page.locator('.chat-line').count(), filteredCount);

    await page.locator('#btn-settings').click();
    await page.locator('#inp-midnight-command').scrollIntoViewIfNeeded();
    for (const size of [{ width: 1060, height: 720 }, { width: 860, height: 600 }]) {
      await page.setViewportSize(size);
      await page.screenshot({ path: path.join(root, 'dist', 'ui-settings-' + version + '-' + size.width + '.png') });
      const fit = await dialog.evaluate((el) => {
        const r = el.getBoundingClientRect(), save = document.getElementById('settings-save').getBoundingClientRect();
        return { fits: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
          overflow: el.scrollWidth > el.clientWidth + 1, saveFits: save.bottom <= r.bottom };
      });
      assert.deepEqual(fit, { fits: true, overflow: false, saveFits: true });
    }
    await page.locator('#chk-showmonitor').check();
    await page.evaluate(() => { window.fixture.saveFailure = true; });
    await page.locator('#settings-save').click();
    await page.waitForFunction(() => document.getElementById('settings-error').textContent.includes('disk full'));
    assert.equal(await dialog.evaluate((el) => el.open), true);
    assert.equal(await page.locator('#chk-showmonitor').isChecked(), true, 'Keep the failed draft editable');
    assert.equal(await page.locator('#settings-save').isEnabled(), true);
    assert.equal(await page.locator('#monitor-panel').isVisible(), false, 'Failed draft must not change active settings');
    assert.equal(savedConfig.display.showMonitor, false);
    await page.locator('#settings-cancel').click();
    await page.reload();
    await page.waitForFunction(() => typeof window.listeners.chat === 'function');
    await page.locator('#btn-settings').click();
    assert.equal(await page.locator('#inp-reconnect-delay').inputValue(), '7');
    assert.equal(await page.locator('#sel-close-behavior').inputValue(), 'background');
    assert.equal(await page.locator('#inp-claim-delay-min').inputValue(), '0.12');
    assert.equal(await page.locator('#inp-claim-delay-max').inputValue(), '0.15');
    assert.equal(await page.locator('#inp-welcome-delay-min').inputValue(), '1.2');
    assert.equal(await page.locator('#inp-welcome-delay-max').inputValue(), '2.3');
    await page.locator('#chk-claim-after').check();
    assert.equal(await page.locator('#chk-claim-delay').isChecked(), false);
    assert.equal(await page.locator('#inp-claim-delay-min').isDisabled(), true);
    assert.equal(await page.locator('#inp-claim-delay-max').isDisabled(), true);
    assert.equal(await page.locator('#inp-claim-after-count').isEnabled(), true);
    const countSaveAttempts = await page.evaluate(() => window.fixture.saveAttempts);
    await page.locator('#inp-claim-after-count').fill('0');
    await page.locator('#settings-save').click();
    assert.equal(await page.evaluate(() => window.fixture.saveAttempts), countSaveAttempts, 'Invalid claimant count must not save');
    await page.locator('#inp-claim-after-count').fill('3');
    for (const size of [{ width: 1060, height: 720 }, { width: 860, height: 600 }]) {
      await page.setViewportSize(size);
      await page.locator('#chk-claim-after').evaluate(el => el.closest('fieldset').scrollIntoView({ block: 'start' }));
      await page.screenshot({ path: path.join(root, 'dist', 'ui-settings-count-' + version + '-' + size.width + '.png') });
      const fits = await dialog.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight
          && el.scrollWidth <= el.clientWidth + 1 && [...el.querySelectorAll('.setting-row')].every(row => row.scrollWidth <= row.clientWidth + 1);
      });
      assert.equal(fits, true, 'Count controls must fit the minimum window');
    }
    await page.locator('#settings-save').click();
    await page.waitForFunction(() => !document.getElementById('settings-dialog').open);
    assert.deepEqual(savedConfig.automation.claimAfter, { enabled: true, count: 3 });
    assert.equal(savedConfig.automation.claimDelayEnabled, false);
    assert.deepEqual(savedConfig.automation.claimDelay, { minMs: 120, maxMs: 150 });
    await page.reload();
    await page.waitForFunction(() => typeof window.listeners.chat === 'function');
    await page.locator('#btn-settings').click();
    assert.equal(await page.locator('#chk-claim-after').isChecked(), true);
    assert.equal(await page.locator('#chk-claim-delay').isChecked(), false);
    assert.equal(await page.locator('#inp-claim-after-count').inputValue(), '3');
    await page.locator('#chk-claim-delay').check();
    assert.equal(await page.locator('#chk-claim-after').isChecked(), false);
    assert.equal(await page.locator('#inp-claim-after-count').isDisabled(), true);
    assert.equal(await page.locator('#inp-claim-delay-min').isEnabled(), true);
    await page.locator('#settings-save').click();
    await page.waitForFunction(() => !document.getElementById('settings-dialog').open);
    assert.deepEqual(savedConfig.automation.claimAfter, { enabled: false, count: 3 });
    assert.equal(savedConfig.automation.claimDelayEnabled, true);
    await page.locator('#btn-settings').click();
    assert.equal(await page.locator('#inp-reconnect-attempts').inputValue(), '0');
    assert.equal(await page.locator('#chk-autologin').isChecked(), true);
    assert.equal(await page.locator('#chk-showmonitor').isChecked(), false);
    assert.equal(await page.locator('#chk-autoscroll').isChecked(), false);
    assert.equal(await page.locator('#chk-autoclaim').isChecked(), false);
    assert.equal(await page.locator('#chk-autowelcome').isChecked(), false);
    assert.equal(await page.locator('#chk-midnight').isChecked(), true);
    assert.equal(await page.locator('#inp-midnight-command').inputValue(), '/fixture midnight args');
    assert.equal(await page.locator('#chk-hidepresence').isChecked(), false);
    assert.equal(await page.locator('#settings-shortcuts').inputValue(), 'Custom | /fixture custom\nSecond | /fixture second');
    await page.locator('#chk-showchat').check();
    await page.locator('#chk-reconnect').uncheck();
    await page.locator('#chk-midnight').uncheck();
    assert.equal(await page.locator('#inp-midnight-command').isDisabled(), true);
    await page.locator('#settings-save').click();
    await page.waitForFunction(() => !document.getElementById('settings-dialog').open);
    assert.deepEqual(savedConfig.reconnect, { enabled: false, delaySeconds: 7, maxAttempts: 0 });
    assert.deepEqual(savedConfig.midnightCommand, { enabled: false, command: '/fixture midnight args' });
    for (let i = 0; i < 80; i++) await page.evaluate((data) => window.listeners.chat(data), fixture({ text: 'SCROLL_FIXTURE ' + i }));
    await page.locator('#chat-view').evaluate((el) => { el.scrollTop = 0; });
    await page.evaluate((data) => window.listeners.chat(data), fixture({ text: 'SCROLL_FIXTURE_LAST' }));
    assert.equal(await page.locator('#chat-view').evaluate((el) => el.scrollTop), 0);
    await page.locator('#mode-bridge').click();
    await page.waitForFunction(() => document.getElementById('btn-connect').textContent === '\u542f\u52a8\u6865\u63a5');
    assert.equal(await page.locator('#premium-switch').count(), 0);
    assert.equal(await page.locator('#btn-bridge-export').isVisible(), true);
    assert.equal(await page.locator('#btn-connect').isEnabled(), true);
    await page.locator('#btn-bridge-export').click(); assert.equal(await page.evaluate(() => window.fixture.exports), 1);
    await page.locator('#btn-connect').click();
    assert.equal(await page.locator('#btn-connect').innerText(), '\u65ad\u5f00\u6865\u63a5');
    assert.equal(await page.locator('#inp-send').isDisabled(), true);
    assert.equal(await page.locator('#conn-host').innerText(), '\u6e38\u620f\u5ba2\u6237\u7aef');
    await page.evaluate((session) => window.listeners.status({ connectionMode: 'bridge', event: 'join',
      connected: true, state: 'play', chatSession: session, target: { host: 'game.invalid', port: 25565 },
      bridge: { listening: true, paired: true, online: true } }), registry.session);
    assert.equal(await page.locator('#inp-send').isEnabled(), true);
    assert.equal(await page.locator('#st-auth').innerText(), '\u6e38\u620f\u8fde\u63a5');
    for (const size of [{ width: 1060, height: 720 }, { width: 860, height: 600 }]) {
      await page.setViewportSize(size);
      await page.screenshot({ path: path.join(root, 'dist', 'ui-bridge-' + version + '-' + size.width + '.png') });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
    await page.evaluate(() => window.listeners.status({ connected: false, state: 'bridge-wait',
      bridge: { listening: true, paired: false, online: false } }));
    assert.equal(await page.locator('#btn-connect').innerText(), '\u65ad\u5f00\u6865\u63a5');
    assert.equal(await page.locator('#inp-send').isDisabled(), true);
    await page.locator('#btn-connect').click();
    assert.equal(await page.locator('#btn-connect').innerText(), '\u542f\u52a8\u6865\u63a5');
    await page.evaluate(() => window.listeners.status({ connectionMode: 'standalone', connected: false, state: 'idle',
      bridge: { listening: false, paired: false, online: false } }));
    await page.evaluate(() => window.listeners.status({ connectionMode: 'bridge', connected: false, state: 'bridge-wait',
      bridge: { listening: true, paired: false, online: false, detecting: true } }));
    assert.equal(await page.locator('#mode-bridge').isChecked(), true);
    assert.equal(await page.locator('#btn-connect').innerText(), '\u505c\u6b62\u68c0\u6d4b');
    assert.equal(await page.locator('#inp-send').isDisabled(), true);
    for (const size of [{ width: 1060, height: 720 }, { width: 860, height: 600 }]) {
      await page.setViewportSize(size);
      assert.equal(await page.locator('#conn-meta').evaluate((el) => el.scrollWidth <= el.clientWidth), true);
      assert.equal(await page.locator('#btn-connect').evaluate((el) => el.scrollWidth <= el.clientWidth), true);
      await page.screenshot({ path: path.join(root, 'dist', 'ui-auto-bridge-' + version + '-' + size.width + '.png') });
    }
    await page.evaluate(() => window.listeners.status({ connected: false, state: 'bridge-wait',
      bridge: { listening: true, paired: true, online: false, detecting: true } }));
    assert.equal(await page.locator('#conn-meta').innerText(), '\u5df2\u914d\u5bf9 \u00b7 \u7b49\u5f85\u540c\u8d26\u53f7\u8fdb\u670d');
    await page.evaluate(() => window.listeners.status({ connected: false, state: 'idle',
      bridge: { listening: false, paired: false, online: false, detecting: false } }));
    assert.equal(await page.locator('#btn-connect').innerText(), '\u542f\u52a8\u6865\u63a5');
    assert.equal(await page.locator('#conn-meta').innerText(), '\u672c\u5730\u6865\u63a5\u672a\u542f\u52a8');
    await page.evaluate(() => { window.fixture.modeFailure = true; });
    await page.locator('#mode-standalone').click();
    await page.waitForFunction(() => document.getElementById('toast').textContent.includes('mode failure'));
    assert.equal(await page.locator('#mode-bridge').isChecked(), true, 'Failed mode save preserves bridge mode');
    assert.equal(await page.evaluate(() => window.fixture.connects), 0, 'Bridge UI must never independently log in');
    assert.equal(await page.evaluate(() => window.fixture.bridgeStarts), 1);
    assert.deepEqual(errors, []);
    console.log('PASS bridge UI: mode, pairing export, wait/join/detach/stop, failed-mode rollback and zero independent login');
    console.log('PASS automatic handoff UI: status-driven mode switch, bounded detection, offline paired state, timeout stop and label fit');
    console.log('PASS renderer: Chinese, rich styles, keyboard click, single dispatch, suggest-only, stale-session, IPC error and literal HTML');
    console.log('PASS settings: focus, cancel, validity, pending/failed save, persistence, live display, no auto-scroll');
    console.log('PASS welcome: automatic-used action display, separate switch save/reload, no renderer command sends');
    console.log('PASS midnight settings: default off, validity, persistence, retained command when disabled and no immediate send');
    console.log('PASS claim-count settings: mutual exclusion in both directions, count bounds, persistence and desktop/minimum-window fit');
    console.log('PASS message categories, no duplicate chat logs, auto-used buttons and non-overwriting password suggestion');
    console.log('PASS presence: online list/search/click and display persistence; history query removed');
    console.log('PASS online list/search, completion, shortcuts and menu left/right/keyboard clicks, pending/timeout/cursor/error/replacement/ESC');
    console.log('PASS retry UI: sticky target, stop waiting/cancel connecting, zero connect or business-send calls');
    console.log('PASS maintenance UI: countdown, sticky target, stop/cancel, disabled sending and desktop/minimum-window fit');
    console.log('PASS chat/retry/settings screenshot/overflow at 1060x720 and 860x600; no Minecraft connection');
  } finally { await browser.close(); }
}

run().catch((e) => { console.error(e); process.exitCode = 1; });
