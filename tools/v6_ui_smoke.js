'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright');

async function run() {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'mango-v6-ui-'));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1060, height: 720 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.route(/^https?:/, (route) => route.abort());
  await page.addInitScript(() => {
    const config = { servers: [], username: 'Tester', autoLogin: false, __profileKey: 'fixture.invalid:25565', __accountKey: 'first-uuid',
      behavior: { showChat: true }, display: { autoScroll: true, showMonitor: false, hidePresence: true },
      automation: { autoClaimRedPackets: false, autoWelcome: false, paused: false }, notifications: { mentions: true } };
    const data = { revision: 1, profileKey: config.__profileKey, unread: 1, notificationStatus: '系统通知未验证',
      availability: { connected: true, paused: false, claim: false, welcome: false },
      summary: { from: Date.now() - 47 * 60000, to: Date.now(), messages: 1, disconnects: 1, gaps: 1, actions: 1 },
      items: [{ id: 'source-1', messageId: 'source-1', text: 'Alice: @Tester 你好', t: Date.now(), reasons: ['提到我'], read: false }],
      actions: [{ id: 'a', feature: '红包', status: 'skipped', detail: '10 秒内未达到指定领取人数，已跳过，不补发',
        t: Date.now(), messageId: 'source-1', transitions: [{ t: Date.now(), status: 'detected', detail: '发现入口' },
          { t: Date.now(), status: 'waiting-count', detail: '等待第 2 位玩家' }, { t: Date.now(), status: 'skipped', detail: '人数不足，不补发' }] }] };
    window.fixture = { callbacks: {}, data, config, sends: 0, save: null, reads: 0 };
    const f = window.fixture;
    window.api = {
      getConfig: async () => config, saveConfig: async (next) => { Object.assign(config, next); f.save = next; return { ok: true }; },
      peekAccount: async () => null, getMetrics: async () => null, getOnline: async () => ({ known: false, players: [] }),
      getAttention: async () => data, getChatHistory: async () => ({ records: [], hasMore: false }),
      getBridgeStatus: async () => ({ mode: 'standalone', listening: false }),
      getDailyPurchase: async () => ({ status: 'pending' }),
      onStatus: (fn) => { f.callbacks.status = fn; }, onChat: (fn) => { f.callbacks.chat = fn; },
      onLog: (fn) => { f.callbacks.log = fn; }, onMetrics: () => {},
      readAttention: async ({ profileKey, ids }) => {
        if (profileKey !== data.profileKey) throw new Error('Wrong auto-read server');
        f.reads++;
        for (const item of data.items) if (ids.includes(item.id) && !item.read) { item.read = true; data.unread--; }
        data.revision++; return { ok: true };
      },
      pauseAutomation: async () => { data.availability.paused = !data.availability.paused;
        config.automation.paused = data.availability.paused; data.revision++; return { ok: true }; },
      getSourceMessage: async () => ({ records: [{ messageId: 'source-1', t: Date.now(), text: 'Alice: @Tester 你好', segments: [] }] }),
      say: () => { f.sends++; throw new Error('Network actions forbidden'); },
    };
  });
  try {
    await page.goto(pathToFileURL(path.join(__dirname, '../app/renderer/index.html')).href);
    await page.waitForFunction(() => typeof window.fixture.callbacks.chat === 'function');
    await page.locator('#tab-attention').click();
    await page.locator('#attention-summary').filter({ hasText: '47 分钟' }).waitFor();
    await page.waitForFunction(() => window.fixture.data.unread === 0);
    assert.equal(await page.locator('#attention-read').count(), 0);
    assert.equal(await page.locator('#attention-rehearsal-tab').count(), 0);
    assert.equal(await page.locator('#attention-migration').count(), 0);
    await page.locator('.attention-row summary').click();
    assert.ok((await page.locator('#attention-actions').innerText()).includes('人数不足'));
    for (const [width, height] of [[1060, 720], [860, 600]]) {
      await page.setViewportSize({ width, height });
      if (!process.argv.includes('--no-screenshots')) await page.screenshot({ path: path.join(output, `attention-${width}.png`) });
      const clipped = await page.evaluate(() => [...document.querySelectorAll('button')].filter((e) => {
        const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (r.left < 0 || r.right > innerWidth + 1);
      }).map((e) => e.id));
      assert.deepEqual(clipped, []);
    }
    await page.locator('#attention-pause').check();
    await page.waitForFunction(() => window.fixture.data.availability.paused);
    await page.locator('#attention-messages-tab').click();
    await page.locator('#attention-message-list .attention-source').click();
    await page.locator('.source-highlight').waitFor();
    assert.equal(await page.locator('.source-highlight button').count(), 0);
    await page.locator('#tab-attention').click();
    await page.evaluate(async () => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      window.fixture.data.items.push({ id: 'source-2', messageId: 'source-2', t: Date.now(), text: 'new message', reasons: ['提到我'], read: false });
      window.fixture.data.unread = 1; window.fixture.data.revision++;
      await window.AttentionUI.refresh();
    });
    assert.equal(await page.evaluate(() => window.fixture.data.unread), 1, 'Hidden attention must not auto-read');
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction(() => window.fixture.data.unread === 0);
    await page.evaluate(() => window.fixture.callbacks.status({ state: 'play', connected: true, chatSession: 'fixture',
      target: { host: 'fixture.invalid', port: 25565 }, players: { known: true, server: 'fixture.invalid:25565',
        players: [{ name: 'mango0v0' }, { name: 'Alice' }, { name: 'LongestName12345' }, { name: 'Bob' }] } }));
    await page.locator('#btn-settings').click(); await page.locator('#chk-bridge-exit').check();
    assert.equal(await page.locator('#sel-bridge-fallback').inputValue(), 'exit');
    await page.locator('#sel-bridge-fallback').selectOption('offline');
    await page.locator('#bridge-exit-players input[value="mango0v0"]').check();
    await page.locator('#bridge-exit-player').fill('Ali');
    assert.equal(await page.locator('#bridge-exit-players input').count(), 1);
    await page.locator('#bridge-exit-players input[value="Alice"]').check();
    await page.locator('#bridge-exit-player').fill('OfflinePlayer');
    await page.locator('#bridge-exit-player').press('Enter');
    await page.locator('#bridge-exit-player').fill('ALICE');
    await page.locator('#bridge-exit-add').click();
    assert.equal(await page.locator('#bridge-exit-selected .bridge-target-chip').count(), 3, 'No case-variant duplicates');
    await page.getByRole('button', { name: '移除 OfflinePlayer', exact: true }).click();
    await page.locator('#bridge-exit-player').fill('OfflinePlayer'); await page.locator('#bridge-exit-add').click();
    await page.locator('#bridge-exit-player').fill('@bad'); await page.locator('#bridge-exit-add').click();
    assert.ok((await page.locator('#bridge-exit-error').innerText()).includes('玩家 ID'));
    await page.locator('#bridge-exit-player').fill('');
    for (const [width, height] of [[1060, 720], [860, 600]]) {
      await page.setViewportSize({ width, height });
      await page.locator('#sel-bridge-fallback').scrollIntoViewIfNeeded();
      if (!process.argv.includes('--no-screenshots')) await page.screenshot({ path: path.join(output, `settings-${width}.png`) });
      assert.equal(await page.evaluate(() => {
        const body = document.querySelector('.settings-body'); return body.scrollWidth > body.clientWidth;
      }), false, 'Settings must not overflow horizontally');
    }
    await page.locator('#settings-save').click(); await page.waitForFunction(() => window.fixture.save !== null);
    assert.equal(await page.evaluate(() => window.fixture.save.bridgeExit.enabled), true);
    assert.deepEqual(await page.evaluate(() => window.fixture.save.bridgeExit.players), ['mango0v0', 'Alice', 'OfflinePlayer']);
    assert.equal(await page.evaluate(() => window.fixture.save.__accountKey), 'first-uuid');
    assert.equal(await page.evaluate(() => window.fixture.save.bridgeFallback), 'offline');
    for (const mode of ['off', 'exit']) {
      await page.locator('#btn-settings').click();
      await page.locator('#sel-bridge-fallback').selectOption(mode);
      await page.locator('#settings-save').click();
      await page.waitForFunction((expected) => window.fixture.save.bridgeFallback === expected, mode);
    }
    await page.locator('#btn-settings').click();
    assert.equal(await page.locator('#sel-bridge-fallback').inputValue(), 'exit');
    await page.evaluate(() => {
      window.fixture.config.__accountKey = 'second-uuid';
      window.fixture.callbacks.status({ profileChanged: true });
    });
    await page.locator('#settings-save').click();
    assert.ok((await page.locator('#settings-error').innerText()).includes('账号或服务器已切换'));
    await page.locator('#settings-close').click();
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      window.beforeHidden = document.querySelectorAll('.chat-line').length;
      for (let i = 0; i < 1800; i++) window.fixture.callbacks.chat({ text: 'background ' + i, type: 'system' });
    });
    assert.equal(await page.locator('.chat-line').count(), await page.evaluate(() => window.beforeHidden));
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction(() => document.querySelectorAll('.chat-line').length === 800);
    assert.equal(await page.evaluate(() => window.fixture.sends), 0);
    assert.deepEqual(errors, []);
    console.log('PASS layouts, multi-target search/select/remove, duplicate/invalid IDs, account-stale form, auto-read visibility, source safety and hidden render budget');
    console.log(output);
  } finally { await browser.close(); }
}
run().catch((e) => { console.error(e); process.exitCode = 1; });
