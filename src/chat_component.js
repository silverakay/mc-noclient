'use strict';

const language = { ...require('./lang/zh_cn.json'), ...require('./lang/customcrops_zh_cn.json') };
const COLORS = {
  black: '#000000', dark_blue: '#0000aa', dark_green: '#00aa00',
  dark_aqua: '#00aaaa', dark_red: '#aa0000', dark_purple: '#aa00aa',
  gold: '#ffaa00', gray: '#aaaaaa', dark_gray: '#555555', blue: '#5555ff',
  green: '#55ff55', aqua: '#55ffff', red: '#ff5555', light_purple: '#ff55ff',
  yellow: '#ffff55', white: '#ffffff',
};
const LEGACY_COLORS = Object.values(COLORS);
const FLAGS = ['bold', 'italic', 'underlined', 'strikethrough'];
const ACTION_FIELDS = {
  run_command: 'command', suggest_command: 'command',
  open_url: 'url', copy_to_clipboard: 'value',
};
// 可点击文本会同时存在于动作表、IPC 数据和 DOM 属性中。正常服务器动作
// 远小于此值；给恶意/异常长的点击参数设上限，避免一条消息放大常驻内存。
const MAX_ACTION_VALUE_LENGTH = 4096;

function clickAction(event) {
  if (!event || typeof event !== 'object') return null;
  if (!Object.hasOwn(ACTION_FIELDS, event.action)) return null;
  const field = ACTION_FIELDS[event.action];
  const value = event[field] === undefined ? event.value : event[field];
  if (typeof value !== 'string' || !value || value.length > MAX_ACTION_VALUE_LENGTH || /[\r\n\0]/.test(value)) return null;
  if (event.action === 'open_url') {
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol)) return null;
    } catch (_) { return null; }
  }
  return { action: event.action, value };
}

function componentToRuns(node, options = {}) {
  const runs = [];
  let length = 0;
  let visits = 0;
  const limit = options.maxLength || 65536;

  function emit(text, style) {
    if (!text || length >= limit || runs.length >= 2048) return;
    const clipped = String(text).slice(0, limit - length);
    length += clipped.length;
    runs.push({ text: clipped, ...style });
  }

  function literal(value, inherited) {
    let style = { ...inherited };
    const text = String(value);
    const codes = /\u00a7([0-9a-fk-or])/gi;
    let start = 0;
    for (const match of text.matchAll(codes)) {
      emit(text.slice(start, match.index), style);
      const code = match[1].toLowerCase();
      const color = parseInt(code, 16);
      if (!Number.isNaN(color)) {
        style = { ...style, color: LEGACY_COLORS[color], bold: false,
          italic: false, underlined: false, strikethrough: false };
      } else if (code === 'r') {
        style = { ...inherited };
      } else {
        const flag = { l: 'bold', m: 'strikethrough', n: 'underlined', o: 'italic' }[code];
        if (flag) style[flag] = true;
      }
      start = match.index + match[0].length;
    }
    emit(text.slice(start), style);
  }

  function visit(value, inherited = {}, depth = 0) {
    if (value == null || depth > 64 || ++visits > 8192 || length >= limit) return;
    if (typeof value !== 'object') { literal(value, inherited); return; }
    if (Array.isArray(value)) {
      // In component lists the first component parents subsequent ones.
      const style = value[0] && typeof value[0] === 'object' && !Array.isArray(value[0])
        ? styleFor(value[0], inherited, depth) : inherited;
      value.forEach((part) => visit(part, style, depth + 1));
      return;
    }
    const style = styleFor(value, inherited, depth);
    if (value.text !== undefined) visit(value.text, style, depth + 1);
    else if (typeof value.translate === 'string') {
      const key = value.translate;
      const args = Array.isArray(value.with) ? value.with : [];
      const template = options.translate === false ? null : Object.hasOwn(language, key) ? language[key]
        : typeof value.fallback === 'string' ? value.fallback : null;
      if (template === null) {
        literal(key, style);
        for (const arg of args) { literal(' ', style); visit(arg, style, depth + 1); }
      } else {
        let start = 0, implicit = 0;
        for (const match of template.matchAll(/%(?:(\d+)\$)?([sd%])/g)) {
          literal(template.slice(start, match.index), style);
          if (match[2] === '%') literal('%', style);
          else {
            const index = match[1] ? Number(match[1]) - 1 : implicit++;
            if (index >= 0 && index < args.length) visit(args[index], style, depth + 1);
            else literal(match[0], style);
          }
          start = match.index + match[0].length;
        }
        literal(template.slice(start), style);
      }
    } else if (value.keybind) {
      literal(Object.hasOwn(language, value.keybind) ? language[value.keybind] : value.keybind, style);
    } else if (value.score && value.score.value !== undefined) {
      literal(value.score.value, style);
    } else if (value.type === 'text' && typeof value.value === 'string') {
      literal(value.value, style);
    }
    if (Array.isArray(value.extra)) {
      for (const child of value.extra) visit(child, style, depth + 1);
    } else if (value.extra) visit(value.extra, style, depth + 1);
  }

  function styleFor(value, inherited, depth) {
    const style = { ...inherited };
    if (typeof value.color === 'string') {
      const color = Object.hasOwn(COLORS, value.color) ? COLORS[value.color]
        : /^#[0-9a-f]{6}$/i.test(value.color) ? value.color : null;
      if (color) style.color = color;
      else if (value.color === 'reset') delete style.color;
    }
    for (const flag of FLAGS) {
      if (value[flag] !== undefined) style[flag] = value[flag] === true || value[flag] === 1;
    }
    if (!options.noEvents) {
      if (Object.hasOwn(value, 'click_event') || Object.hasOwn(value, 'clickEvent')) {
        style.click = clickAction(Object.hasOwn(value, 'click_event') ? value.click_event : value.clickEvent);
      }
      const hover = value.hover_event || value.hoverEvent;
      if (hover && hover.action === 'show_text' && depth < 16) {
        const content = hover.contents === undefined ? hover.value : hover.contents;
        style.hover = componentToRuns(content, { noEvents: true, maxLength: 2048 })
          .map((part) => part.text).join('');
      }
    }
    return style;
  }

  visit(node);
  return runs;
}

function componentToText(node, options = {}) {
  return componentToRuns(node, { ...options, noEvents: true }).map((run) => run.text).join('');
}

module.exports = { componentToRuns, componentToText, clickAction };
