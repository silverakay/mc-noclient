'use strict';

const fs = require('fs');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const { localDay } = require('./welcome');
const cropNames = require('./lang/customcrops_zh_cn.json');
const clean = (value) => String(value || '').replace(/\u00a7[0-9a-fk-orx]/gi, '').trim();
const title = (value) => clean(value).replace(/[《》<>\s]/g, '');
function itemQuality(name, lore) {
  const value = name + ' ' + lore.filter((line) => /品质/.test(line)).join(' ');
  return /金星/.test(value) ? '金星' : /银星/.test(value) ? '银星' : '无星';
}
function localizeItem(item) {
  const rawName = clean(item.name);
  const key = rawName.replace(/^customcrops:/, 'item.customcrops.');
  if (!Object.hasOwn(cropNames, key)) return item;
  const name = cropNames[key];
  const lore = (Array.isArray(item.lore) ? item.lore : String(item.lore || '').split(' ⏎ ')).map(clean);
  return { ...item, rawName: item.rawName || rawName, name, quality: itemQuality(name, lore) };
}
const NAVIGATION = {
  '芒果小镇主菜单': ['小镇商店'],
  '系统商店': ['系统收购', '星露谷收购'],
  '星露谷收购商店': ['农作物收购'],
};
const entryName = (value) => clean(value).replace(/[\[\]【】\s]/g, '');
function navigationSlot(menu, name) {
  if (!(NAVIGATION[title(menu?.title)] || []).includes(name)) return null;
  const matches = (menu.slots || []).slice(0, menu.expectedSlots).flatMap((item, slot) =>
    item && entryName(item.name) === name ? [slot] : []);
  return matches.length === 1 ? matches[0] : null;
}
const PRICE_SLOTS = [11, 12, 13, 14, 15, 20, 21, 22, 23, 24, 29, 30, 31, 32, 33];
function navigationAllowed(menu, slot) {
  if (!Number.isInteger(slot) || slot < 0 || slot >= menu?.expectedSlots) return false;
  const name = entryName(menu.slots?.[slot]?.name);
  return !!name && navigationSlot(menu, name) === slot;
}
function parseShop(menu) {
  if (!menu || menu.status !== 'ready' || !Number.isInteger(menu.expectedSlots)
    || menu.expectedSlots < 1 || menu.expectedSlots > 54 || menu.slots.length < menu.expectedSlots) return null;
  const kind = title(menu.title) === '每日随机收购商店' ? 'system'
    : title(menu.title) === '星露谷每日随机收购商店' ? 'crops' : null;
  if (!kind) return null;
  const items = [];
  for (const [slot, source] of menu.slots.slice(0, menu.expectedSlots).entries()) {
    if (!source) continue;
    const item = localizeItem(source);
    const lore = (Array.isArray(item.lore) ? item.lore : String(item.lore || '').split(' ⏎ ')).map(clean);
    const priceLine = lore.find((line) => /(?:卖价|收购价|单价)\s*[:：]/.test(line));
    if (!priceLine) continue;
    const price = /(?:卖价|(?:今日)?收购价|单价)\s*[:：]\s*([\d,]+(?:\.\d+)?)\s*([^\d\s↑↓▲▼-]*)/.exec(priceLine);
    const quotaLine = lore.find((line) => /(?:出售限量|已卖|已售)/.test(line));
    const quota = quotaLine && /(\d+)\s*\/\s*(\d+)/.exec(quotaLine);
    if (!price || !Number.isFinite(Number(price[1].replace(/,/g, '')))) throw new Error('收购单价格式无法识别');
    if (!quota || Number(quota[1]) > Number(quota[2])) throw new Error('收购限量格式无法识别');
    const name = clean(item.name), quality = itemQuality(name, lore);
    items.push({ slot, identifier: item.identifier || String(item.itemId || ''), name, quality,
      ...(item.rawName ? { rawName: item.rawName } : {}),
      price: Number(price[1].replace(/,/g, '')), unit: price[2] || '', sold: Number(quota[1]), limit: Number(quota[2]),
      remaining: Number(quota[2]) - Number(quota[1]),
      trend: /[↑▲]/.test(priceLine) ? 'up' : /[↓▼]/.test(priceLine) ? 'down' : 'flat', lore });
  }
  if (!items.length) throw new Error('收购菜单中没有完整价目数据');
  items.sort((a, b) => b.price - a.price || a.name.localeCompare(b.name, 'zh-CN'));
  return { kind, title: clean(menu.title), items };
}
function contextKey(client) {
  return client && client.host && client.username
    ? client.host.toLowerCase() + ':' + (client.port || 25565) + '/' + client.username.toLowerCase() : '';
}
class DailyPurchase {
  constructor({ directory, getClient, enabled = () => true, onChange = () => {}, onRecord = () => {}, onTrace = () => {},
    now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { directory, getClient, enabled, onChange, onRecord, now, setTimer, clearTimer });
    this.onTrace = onTrace;
    this.onRecord = (detail) => {
      onRecord(detail);
      if (this.trace) onTrace({ ...this.trace, detail, t: this.now(),
        status: this.error ? 'failed' : this.run ? 'waiting-menu' : this.record ? 'confirmed' : 'cancelled' });
    };
    this.context = ''; this.record = null; this.run = null; this.attempted = ''; this.error = '';
    this.timer = null; this.deadline = null; this.notBefore = 0;
    this.hiddenMenu = null;
  }
  file(key, day) { return path.join(this.directory, createHash('sha256').update(key).digest('hex'), day + '.json'); }
  read(key, day) {
    const file = this.file(key, day);
    if (!fs.existsSync(file)) return null;
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (record.version !== 1 || record.day !== day || record.context !== key || record.count !== 1
      || !record.shops?.system?.items?.length || !record.shops?.crops?.items?.length) throw new Error('每日收购记录损坏');
    // V5.4 and earlier did not distinguish the source. Preserve their daily
    // completion as the automatic quota, without blocking future manual reads.
    if (record.autoCount === undefined && record.manualCount === undefined) {
      record.autoCount = record.count; record.manualCount = 0;
    }
    if (![0, 1].includes(record.autoCount) || !Number.isSafeInteger(record.manualCount)
      || record.manualCount < 0) throw new Error('每日收购次数记录损坏');
    // Resolve old names in memory only: never rewrite prices, timestamps or quotas.
    for (const kind of ['system', 'crops']) record.shops[kind].items = record.shops[kind].items.map(localizeItem);
    return record;
  }
  snapshot() {
    const day = localDay(this.now()), record = this.record?.day === day ? this.record : null;
    return { day, count: record?.count || 0, autoCount: record?.autoCount || 0, manualCount: record?.manualCount || 0,
      source: this.run?.source || record?.source || null, context: this.context,
      status: this.run ? 'collecting' : this.error ? 'error' : record ? 'complete' : 'pending',
      error: this.error, collectedAt: record?.collectedAt || null, shops: record?.shops || null };
  }
  publish() { this.onChange(this.snapshot()); }
  load(client) {
    const key = contextKey(client), day = localDay(this.now()), scope = key + '/' + day;
    if (scope === this.scope) return;
    this.cancel(); this.scope = scope; this.context = key; this.record = null; this.error = ''; this.attempted = '';
    if (key) {
      try { this.record = this.read(key, day); }
      catch (e) { this.error = '读取收购记录失败：' + e.message; }
    }
    this.publish();
  }
  connected(client) { this.scope = ''; this.load(client); this.notBefore = this.now() + 15000; }
  afterSignIn() {
    if (this.run) this.fail('正在执行签到，采集已停止；签到完成后可重试');
    this.notBefore = this.now() + 2500; this.attempted = '';
  }
  tick() {
    const client = this.getClient();
    if (!client || client.state !== 'play') return;
    this.load(client);
    if (!this.enabled() || client.automationBlocked) { if (this.run) this.fail('自动化已暂停'); return; }
    if (client.autoPurchaseEnabled === false) return;
    if (this.run || this.record?.autoCount === 1 || this.error || this.signInPending
      || this.now() < this.notBefore || this.attempted === this.scope) return;
    if (client.features?.menu) return;
    this.start(client);
  }
  retry() {
    const client = this.getClient();
    if (!client || client.state !== 'play') return { ok: false, error: '连接服务器后才能获取收购价' };
    if (this.run) return { ok: true };
    this.scope = '';
    this.load(client);
    if (this.error) return { ok: false, error: this.error };
    if (this.signInPending) return { ok: false, error: '请等待签到指令提交完成' };
    if (!this.enabled() || client.automationBlocked) return { ok: false, error: '自动化已暂停' };
    if (client.features?.menu && this.hiddenMenu?.client === client
      && client.features.menu.token === this.hiddenMenu.token) this.closeBackgroundMenu(this.hiddenMenu);
    if (client.features?.menu) return { ok: false, error: '请先关闭当前服务器菜单；自动菜单状态不明时请断开并重新连接' };
    this.error = ''; this.start(client, 'manual'); return { ok: true };
  }
  start(client, source = 'automatic') {
    this.trace = { traceId: randomUUID(), serverKey: client.host.toLowerCase() + ':' + (client.port || 25565),
      account: client.username, session: client.session };
    if (source === 'automatic') this.attempted = this.scope;
    if (!this.context) { this.error = '无法确认当前服务器和账号'; this.publish(); return; }
    if (typeof client.openServerMenu !== 'function' || client.purchaseMenusEnabled === false) {
      this.error = '当前桥接 Mod 不支持每日收购，请更新配套桥接 Mod'; this.publish(); return;
    }
    this.run = { client, session: client.session, scope: this.scope, shops: {}, branch: 'system', step: 'root', owned: null,
      source, background: client.purchaseMenusEnabled !== true, clicks: 0, advancing: false, waitingFrom: null };
    this.publish(); this.onRecord((source === 'manual' ? '手动' : '自动') + '开始获取系统收购和农作物收购'); this.openRoot();
  }
  current(run) {
    return this.run === run && run.client === this.getClient() && run.client.state === 'play'
      && run.session === run.client.session && run.scope === this.scope && this.scope === contextKey(run.client) + '/' + localDay(this.now())
      && this.enabled() && !run.client.automationBlocked;
  }
  later(fn, ms) {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => { this.timer = null; fn(); }, ms); this.timer?.unref?.();
  }
  wait() {
    if (this.deadline !== null) this.clearTimer(this.deadline);
    this.deadline = this.setTimer(() => {
      this.deadline = null;
      const run = this.run;
      const titles = { root: '芒果小镇主菜单', store: '系统商店', category: '星露谷收购商店',
        prices: run?.branch === 'system' ? '每日随机收购商店' : '星露谷每日随机收购商店' };
      this.fail('等待《' + (titles[run?.step] || '收购菜单') + '》超时；实际界面：'
        + (run?.observed || '未收到菜单') + (run?.background ? '；' + this.menuDiagnostic(run) : '')
        + '；本次未记成功，可手动重试');
    }, 12000);
    this.deadline?.unref?.();
  }
  async openRoot() {
    const run = this.run;
    if (!run || !this.current(run)) { this.cancel(); return; }
    this.wait();
    this.onRecord('分阶段打开主菜单：按住 Shift → 等待潜行 → F → 松开 Shift');
    try {
      const result = await run.client.openServerMenu();
      if (this.run === run && !(result === true || result?.ok)) this.fail(result?.error || '服务器菜单未打开');
    } catch (e) { if (this.run === run) this.fail(e.message); }
  }
  onMenu(menu) {
    const run = this.run;
    if (!run) {
      if (!this.hiddenMenu) return false;
      const hidden = this.hiddenMenu;
      if (hidden.client !== this.getClient() || !menu || menu.token !== hidden.token) this.hiddenMenu = null;
      return hidden.client === this.getClient() && (!menu || menu.token === hidden.token);
    }
    if (!this.current(run)) { this.fail('连接、日期或自动化状态已变化'); return run.background; }
    if (run.background && menu) {
      this.hiddenMenu = { client: run.client, token: menu.token, id: menu.id,
        title: menu.title, clicks: run.clicks };
    }
    if (!menu) {
      if (run.background) this.hiddenMenu = null;
      if (this.timer !== null) this.clearTimer(this.timer);
      this.timer = null;
      return true;
    }
    const observed = clean(menu.title) || '无标题';
    if (run.observed !== observed) {
      run.observed = observed;
      this.onRecord('收到菜单《' + observed + '》（窗口 ' + menu.id + '，状态 ' + menu.status + '）');
    }
    if (/(?:公会|工会)/.test(observed)) {
      this.fail('实际打开了《' + observed + '》，不是收购导航菜单；已停止，未点击公会功能'); return run.background;
    }
    if (menu.cursor) { this.fail('光标持有物品，已停止采集'); return run.background; }
    run.owned = { id: menu.id, token: menu.token };
    if (menu.status === 'error') { this.fail(menu.error || '菜单无法解析'); return run.background; }
    if (run.background) {
      this.traceMenu(run, menu);
      if (run.waitingFrom === menu.token || run.advancing) return true;
      if (menu.status !== 'ready' || !menu.interactive || menu.pending) return true;
      if (this.timer !== null && run.scheduledToken !== menu.token) {
        this.clearTimer(this.timer); this.timer = null;
      }
      // Refreshes update the source state, not the deadline. At firing time use
      // the newest revision and validate the entry again before clicking.
      if (this.timer === null) {
        const token = menu.token;
        run.scheduledToken = token;
        this.later(() => {
          if (!this.current(run)) return;
          const live = this.liveMenu(run);
          if (!live || live.token !== token) return;
          return this.advance(run, live, live.token + ':' + live.revision);
        }, 700);
      }
      return true;
    }
    if (menu.status !== 'ready' || !menu.interactive || menu.pending) return true;
    const stamp = menu.token + ':' + menu.revision;
    if (stamp === run.lastStamp) return true;
    this.later(() => this.advance(run, menu, stamp), 700); return true;
  }
  async advance(run, menu, stamp) {
    if (!this.current(run)) { if (this.run === run) this.fail('采集已取消'); return; }
    const live = run.client.features?.menu;
    if (!live || live.token !== menu.token || live.revision !== menu.revision) return;
    if (run.background && (menu.status !== 'ready' || !menu.interactive || menu.pending
      || menu.cursor || run.waitingFrom === menu.token || run.advancing)) return;
    if (run.background) run.advancing = true;
    run.lastStamp = stamp;
    try {
      const steps = { root: ['芒果小镇主菜单', '小镇商店', 'store'],
        store: ['系统商店', run.branch === 'system' ? '系统收购' : '星露谷收购', run.branch === 'system' ? 'prices' : 'category'],
        category: ['星露谷收购商店', '农作物收购', 'prices'] };
      if (run.step !== 'prices') {
        const [expected, name, next] = steps[run.step];
        const slot = navigationSlot(menu, name);
        if (title(menu.title) !== expected || slot === null) throw new Error('预期《' + expected + '》内唯一的“' + name
          + '”，实际《' + clean(menu.title) + '》；入口缺失或不唯一，已停止');
        this.onRecord('导航：《' + clean(menu.title) + '》 → ' + name + '（实际格号 ' + slot + '）');
        if (run.background) { run.waitingFrom = menu.token; run.clicks++; }
        run.step = next; this.wait();
        const response = await run.client.clickMenu({ id: menu.id, token: menu.token, revision: menu.revision, slot, button: 0 });
        if (this.run === run && !response?.ok) throw new Error(response?.error || '菜单点击未确认');
        return;
      }
      const shop = parseShop(menu);
      if (!shop || shop.kind !== run.branch) throw new Error('收购菜单与预期不符，未记录完成');
      // These are the product positions in the verified server layout. Partial
      // incremental content must not turn a single priced item into a full day.
      if (!PRICE_SLOTS.every((slot) => shop.items.some((item) => item.slot === slot))) return;
      this.onRecord('已读取' + (shop.kind === 'system' ? '系统收购' : '农作物收购') + ' ' + shop.items.length + ' 项价格');
      run.shops[shop.kind] = shop;
      const closed = await run.client.closeMenu(menu.id, menu.token);
      if (!this.current(run)) return;
      if (!(closed === true || closed?.ok)) throw new Error('采集菜单未能关闭');
      run.owned = null;
      if (run.branch === 'system') {
        run.branch = 'crops'; run.step = 'root'; run.lastStamp = '';
        this.later(() => this.openRoot(), 700); return;
      }
      const record = { version: 1, context: this.context, day: localDay(this.now()), count: 1,
        autoCount: run.source === 'automatic' ? 1 : this.record?.autoCount || 0,
        manualCount: Math.min(Number.MAX_SAFE_INTEGER, (this.record?.manualCount || 0) + (run.source === 'manual' ? 1 : 0)),
        source: run.source, collectedAt: this.now(), shops: run.shops };
      const file = this.file(this.context, record.day);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temporary = file + '.' + randomUUID() + '.tmp';
      try { fs.writeFileSync(temporary, JSON.stringify(record), { encoding: 'utf8', flag: 'wx' }); fs.renameSync(temporary, file); }
      finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
      this.record = record; this.cancel(); this.error = ''; this.publish();
      this.onRecord('两类收购价已保存，今日自动 ' + record.autoCount + '/1，手动成功 ' + record.manualCount + ' 次');
    } catch (e) { if (this.run === run) this.fail(e.message); }
    finally {
      if (run.background) {
        run.advancing = false;
        const latest = this.run === run && this.liveMenu(run);
        if (latest && latest.token !== menu.token) this.onMenu(latest);
      }
    }
  }
  liveMenu(run) {
    const menu = run.client.features?.menu;
    if (!menu) return null;
    return { ...menu, interactive: typeof run.client.features.canClick === 'function'
      ? run.client.features.canClick() : menu.interactive };
  }
  menuDiagnostic(run) {
    const menu = this.liveMenu(run);
    if (!menu) return '尚无容器数据';
    const slots = menu.slots || [], diagnostics = menu.diagnostics || {};
    const names = { root: '小镇商店', store: run.branch === 'system' ? '系统收购' : '星露谷收购', category: '农作物收购' };
    const target = names[run.step];
    const matches = target ? slots.slice(0, menu.expectedSlots).filter((item) => item && entryName(item.name) === target).length : null;
    const parts = ['状态=' + menu.status, '类型=' + (menu.type ?? '未知'), '状态号=' + (menu.stateId ?? '未知'),
      '格子=' + slots.length + '/' + (menu.expectedSlots ?? '未知'),
      '光标=' + (menu.cursor ? '持有物品' : menu.cursorKnown === false ? '未确认' : '空'),
      '可点击=' + (menu.interactive ? '是' : '否'), '待确认=' + (menu.pending ? '是' : '否')];
    if (target) parts.push('入口“' + target + '”=' + matches + '处');
    if (run.waitingFrom === menu.token) parts.push('已点击，等待下一菜单');
    if (diagnostics.fullPackets !== undefined) {
      parts.push('整包=' + diagnostics.fullPackets, '单格=' + diagnostics.slotPackets,
        '忽略单格=' + diagnostics.ignoredSlotPackets);
      if (diagnostics.lastContentWindowId !== undefined) parts.push('最近整包窗口=' + diagnostics.lastContentWindowId);
    }
    return parts.join('，');
  }
  traceMenu(run, menu) {
    const diagnostic = this.menuDiagnostic(run);
    if (diagnostic === run.lastDiagnostic) return;
    if (run.lastDiagnosticAt !== undefined && this.now() - run.lastDiagnosticAt < 1000) return;
    run.lastDiagnostic = diagnostic; run.lastDiagnosticAt = this.now();
    this.onRecord('后台菜单《' + clean(menu.title) + '》：' + diagnostic);
  }
  closeBackgroundMenu(owner) {
    const client = owner?.client, menu = client?.features?.menu;
    if (!client || client !== this.getClient() || client.state !== 'play' || !menu
      || menu.token !== owner.token || menu.cursor || menu.pending) return false;
    const recognized = Object.hasOwn(NAVIGATION, title(menu.title))
      || ['每日随机收购商店', '星露谷每日随机收购商店'].includes(title(menu.title));
    // Unknown or occupied menus are never automatically dismissed. A menu we
    // only opened (no inventory click) can be closed without inventing its cursor.
    if (!recognized || (menu.cursorKnown !== true && owner.clicks !== 0)) return false;
    try {
      const result = client.closeMenu(menu.id, menu.token);
      if (result === true || result?.ok === true) return true;
    } catch (_) { /* Keep the menu hidden; never retry an uncertain close. */ }
    return false;
  }
  fail(message) {
    const run = this.run, hidden = this.hiddenMenu;
    this.cancel();
    if (run?.background && hidden) this.closeBackgroundMenu(hidden);
    this.error = message; this.publish(); this.onRecord('获取未完成：' + message);
  }
  cancel() {
    if (this.run?.client.cancelServerMenuOpen) this.run.client.cancelServerMenuOpen();
    if (this.timer !== null) this.clearTimer(this.timer);
    if (this.deadline !== null) this.clearTimer(this.deadline);
    this.timer = null; this.deadline = null; this.run = null;
  }
  disconnected() {
    if (this.run && this.trace) this.onTrace({ ...this.trace, status: 'cancelled', detail: '连接或系统状态变化，停止采集，不补发', t: this.now() });
    this.cancel(); this.trace = null; this.hiddenMenu = null; this.publish();
  }
}
module.exports = { DailyPurchase, parseShop, navigationAllowed, navigationSlot, contextKey, clean };
