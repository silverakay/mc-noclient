'use strict';

const PRIVATE_COMMANDS = new Set(['login', 'l', 'register', 'reg', 'changepassword', 'changepass', 'cp',
  'password', 'passwd', 'setpassword', 'auth', 'authenticate', 'authme', '2fa', 'otp', 'pin', 'email', 'unregister']);
const text = (value, max = 256) => typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

function validateObservation(raw) {
  if (!raw || !integer(raw.at, 0, 8640000000000000)) throw new Error('Invalid observation time');
  const event = { type: raw.type, at: raw.at };
  if (raw.type === 'overflow') {
    if (!integer(raw.count, 1, 1000000)) throw new Error('Invalid observation count');
    return { ...event, count: raw.count };
  }
  if (raw.type !== 'screen_open') {
    if (!['game', 'bridge'].includes(raw.origin)) throw new Error('Invalid observation origin');
    event.origin = raw.origin;
  }
  if (raw.type === 'command') {
    if (!text(raw.command, 2048) || !/^\/[^/\s][^\r\n]*$/.test(raw.command)
      || typeof raw.signed !== 'boolean' || typeof raw.redacted !== 'boolean'
      || typeof raw.truncated !== 'boolean') throw new Error('Invalid observed command');
    const root = raw.command.split(' ')[0];
    if (root.length > 256) throw new Error('Invalid command name');
    const redacted = raw.redacted || PRIVATE_COMMANDS.has(root.slice(root.lastIndexOf(':') + 1).replace(/^\//, '').toLowerCase());
    return { ...event, command: redacted || raw.truncated ? root : raw.command,
      signed: raw.signed, redacted, truncated: raw.truncated };
  }
  if (raw.type === 'item_use') {
    if (!['MAIN_HAND', 'OFF_HAND'].includes(raw.hand) || !['air', 'block'].includes(raw.target)
      || !text(raw.item)) throw new Error('Invalid item observation');
    return { ...event, hand: raw.hand, target: raw.target, item: raw.item };
  }
  if (!integer(raw.containerId, 0, 2147483647) || !text(raw.title)) throw new Error('Invalid menu observation');
  Object.assign(event, { containerId: raw.containerId, title: raw.title });
  if (raw.type === 'menu_click') {
    if (!integer(raw.slot, -32768, 32767) || !integer(raw.button, -128, 127) || !text(raw.input, 64)
      || !/^[A-Z_]+$/.test(raw.input) || !text(raw.item) || typeof raw.context !== 'boolean') throw new Error('Invalid click observation');
    return { ...event, slot: raw.slot, button: raw.button, input: raw.input, item: raw.item, context: raw.context };
  }
  if (raw.type === 'menu_button') {
    if (!integer(raw.button, -2147483648, 2147483647)) throw new Error('Invalid button observation');
    return { ...event, button: raw.button };
  }
  if (raw.type === 'screen_open') {
    if (!text(raw.menu, 256) || !/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(raw.menu)) throw new Error('Invalid screen observation');
    return { ...event, menu: raw.menu };
  }
  throw new Error('Unknown observation type');
}

function formatObservation(event) {
  if (['menu_click', 'menu_button', 'item_use', 'screen_open', 'overflow'].includes(event.type)) return null;
  if (event.type !== 'command') throw new Error('Unknown observation type');
  const stamp = new Date(event.at).toLocaleTimeString('zh-CN', { hour12: false });
  const source = event.origin === 'bridge' ? '辅助软件' : '游戏';
  return '[游戏指令] ' + stamp + ' ' + source + '提交出站：' + event.command
    + (event.redacted ? ' [敏感参数已隐藏]' : '') + (event.truncated ? ' [过长参数未记录]' : '');
}

module.exports = { validateObservation, formatObservation };
