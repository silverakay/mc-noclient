'use strict';

(() => {
  const labels = { detected: '发现入口', scheduled: '等待延迟', 'waiting-count': '等待人数', triggered: '条件满足',
    sent: '已提交', submitted: '已提交', confirmed: '服务端确认', unconfirmed: '结果未知', rejected: '服务端拒绝',
    failed: '失败', cancelled: '已取消', skipped: '已跳过', limited: '达到限额', duplicate: '已去重',
    suggested: '等待手动确认', matched: '命中提醒', 'waiting-menu': '等待菜单回执' };
  let snapshot = null, pending = false, refreshQueued = false, view = 'actions', rendered = '', sourceCursor = null, sourceId = '';
  const node = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
  const empty = (target, text) => target.replaceChildren(node('p', text, 'attention-empty'));
  const fail = (e) => { $('attention-error').textContent = e?.message || String(e); };
  async function source(id) {
    try {
      if (sourceId !== id) { sourceCursor = null; sourceId = id; }
      if (!window.api.getSourceMessage) return;
      const result = await window.api.getSourceMessage({ messageId: id, cursor: sourceCursor });
      const record = result.records?.[0];
      if (!record) { sourceCursor = result.cursor; throw new Error(result.hasMore ? '尚未找到原消息，请再次点击继续查找' : '原消息已清理或不在保留范围'); }
      sourceCursor = null;
      switchTab('chat');
      let line = [...chatView().querySelectorAll('.chat-line')].find((n) => n.dataset.messageId === id);
      if (!line) { line = renderChatLine({ ...record, segments: [] }); chatView().appendChild(line); }
      while (chatView().childElementCount > CHAT_DOM_MAX) chatView().firstElementChild.remove();
      line.classList.remove('hidden'); line.classList.add('source-highlight');
      cancelViewScroll('chat'); viewScrolls.chat.pinned = false;
      line.scrollIntoView({ block: 'center' });
    } catch (e) { fail(e); toast(e.message, 'err'); }
  }
  function sourceButton(id) {
    const b = node('button', '查看原消息', 'attention-source'); b.type = 'button';
    b.addEventListener('click', () => source(id)); return b;
  }
  function render() {
    if (!snapshot) return;
    const a = snapshot.availability || {};
    $('attention-pause').checked = !!a.paused;
    $('attention-scope').textContent = snapshot.profileKey || '尚未选择服务器';
    const s = snapshot.summary;
    $('attention-summary').textContent = s ? '未查看 ' + Math.max(0, Math.round((s.to - s.from) / 60000))
      + ' 分钟 · 重要消息 ' + s.messages + ' 条 · 连接中断 ' + s.disconnects + ' 次 · 观察缺口 ' + s.gaps
      + ' 次 · 观察到动作 ' + s.actions + ' 项' : '本次运行尚无未查看摘要';
    $('attention-availability').textContent = [a.connected ? '已连接' : '未连接', a.paused ? '自动化暂停' : '自动化未暂停',
      '红包' + (a.claim ? '开' : '关'), '欢迎' + (a.welcome ? '开' : '关'),
      a.bridge ? '桥接不自动获取收购价' : '自动收购' + (a.autoPurchase ? '开' : '关')].join(' · ');
    const signature = snapshot.revision + '/' + snapshot.profileKey;
    if (signature === rendered) return; rendered = signature;
    const actions = $('attention-actions'); actions.replaceChildren();
    for (const action of snapshot.actions || []) {
      const row = node('details', undefined, 'attention-row');
      row.appendChild(node('summary', fmtTime(action.t) + ' · ' + action.feature + ' · ' + (labels[action.status] || action.status)));
      row.appendChild(node('p', action.detail));
      const ol = node('ol');
      for (const step of action.transitions) ol.appendChild(node('li', fmtTime(step.t) + ' ' + (labels[step.status] || step.status) + '：' + step.detail));
      row.appendChild(ol); if (action.messageId) row.appendChild(sourceButton(action.messageId)); actions.appendChild(row);
    }
    if (!actions.childElementCount) empty(actions, '本次运行尚未观察到可追踪动作');
    const messages = $('attention-message-list'); messages.replaceChildren();
    for (const item of snapshot.items || []) {
      const row = node('article', undefined, 'attention-row');
      row.appendChild(node('p', fmtTime(item.t) + ' · ' + item.reasons.join('、') + (item.read ? '' : ' · 未读')));
      row.appendChild(node('p', item.text)); if (item.messageId) row.appendChild(sourceButton(item.messageId)); messages.appendChild(row);
    }
    if (!messages.childElementCount) empty(messages, '暂无重要消息');
    if (snapshot.truncated) actions.appendChild(node('p', '达到显示预算，仅展示最近记录', 'attention-meta'));
  }
  async function refresh() {
    if (!window.api.getAttention) return;
    if (pending) { refreshQueued = true; return; }
    pending = true;
    try {
      const details = activeTab === 'attention';
      snapshot = await window.api.getAttention({ details });
      const visible = document.visibilityState !== 'hidden' && (typeof document.hasFocus !== 'function' || document.hasFocus());
      if (details && activeTab === 'attention' && visible && window.api.readAttention) {
        const ids = snapshot.items.filter((item) => !item.read).map((item) => item.id);
        if (ids.length) {
          const r = await window.api.readAttention({ profileKey: snapshot.profileKey, ids });
          if (r?.ok) snapshot = await window.api.getAttention({ details: true });
        }
      }
      const badge = $('attention-badge'); badge.textContent = snapshot.unread > 99 ? '99+' : String(snapshot.unread);
      badge.classList.toggle('hidden', !snapshot.unread);
      if (activeTab === 'attention' && details) render();
      else if (activeTab === 'attention') refreshQueued = true;
    } catch (e) { fail(e); }
    finally { pending = false; if (refreshQueued) { refreshQueued = false; void refresh(); } }
  }
  window.AttentionUI = { refresh, render };
  for (const name of ['actions', 'messages']) $('attention-' + name + '-tab').addEventListener('click', () => {
    view = name;
    for (const part of ['actions', 'messages']) {
      $('attention-' + part).classList.toggle('hidden', part !== view);
      $('attention-' + part + '-tab').classList.toggle('active', part === view);
    }
  });
  $('tab-attention').addEventListener('click', () => switchTab('attention'));
  window.addEventListener('focus', () => { if (activeTab === 'attention') void refresh(); });
  $('attention-pause').addEventListener('change', async () => {
    $('attention-pause').disabled = true;
    try {
      const r = await window.api.pauseAutomation(); if (!r.ok) throw new Error(r.error);
      cfg = await window.api.getConfig(); await refresh();
    } catch (e) { fail(e); } finally { $('attention-pause').disabled = false; }
  });
  void refresh();
})();
