'use strict';

const { randomUUID } = require('crypto');
const { clickAction } = require('./chat_component');

class ChatActions {
  constructor() { this.reset(); }

  reset() {
    this.session = randomUUID();
    this.actions = new Map();
  }

  register(segments = []) {
    return segments.map((segment) => {
      const { click, ...display } = segment;
      const action = clickAction(click);
      if (!action) return display;
      const id = randomUUID();
      this.actions.set(id, typeof click.remoteId === 'string' ? { ...action, remoteId: click.remoteId } : action);
      while (this.actions.size > 4096) this.actions.delete(this.actions.keys().next().value);
      return { ...display, click: { ...action, id } };
    });
  }

  invalidateCommand(value) {
    for (const [id, action] of this.actions) {
      if (action.action === 'run_command' && action.value === value) this.actions.delete(id);
    }
  }

  invalidateWhere(predicate) {
    if (typeof predicate !== 'function') return;
    for (const [id, action] of this.actions) {
      if (predicate(action)) this.actions.delete(id);
    }
  }

  async activate(id, client, openUrl, options = {}) {
    const action = this.actions.get(id);
    if (!action) return { ok: false, error: '\u8fd9\u6761\u6d88\u606f\u5df2\u5931\u6548' };
    if (!client || client.state !== 'play') return { ok: false, error: '\u8bf7\u5148\u8fde\u63a5\u670d\u52a1\u5668' };
    switch (action.action) {
      case 'run_command': {
        const command = action.value.replace(/^\//, '');
        if (!command.trim()) return { ok: false, error: '\u6307\u4ee4\u4e3a\u7a7a' };
        // Consume before dispatch: rapid duplicate clicks must not send twice.
        this.actions.delete(id);
        const response = action.remoteId
          ? typeof client.activateAction === 'function' && await client.activateAction(action, options)
          : await client.command(command);
        const ok = response === true || !!response && response.ok === true;
        return ok ? { ok: true, action: action.action, value: action.value }
          : { ok: false, error: response && response.error || '\u6307\u4ee4\u672a\u53d1\u9001\uff0c\u8fde\u63a5\u5df2\u65ad\u5f00' };
      }
      case 'suggest_command':
      case 'copy_to_clipboard':
        return { ok: true, action: action.action, value: action.value };
      case 'open_url':
        return { ok: await openUrl(action.value), action: action.action };
      default:
        return { ok: false, error: '\u4e0d\u652f\u6301\u8fd9\u79cd\u70b9\u51fb\u52a8\u4f5c' };
    }
  }
}

module.exports = { ChatActions };
