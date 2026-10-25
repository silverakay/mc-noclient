'use strict';

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');

function validAccountKey(key) {
  return typeof key === 'string' && /^[A-Za-z0-9_:-]{1,80}$/.test(key)
    && !['__proto__', 'prototype', 'constructor'].includes(key);
}

function settingsOnly(config) {
  const result = structuredClone(config);
  for (const key of Object.keys(result)) if (key === 'accountConfigs' || key.startsWith('__')) delete result[key];
  return result;
}

function effectiveAccount(config, key) {
  const stored = key && Object.hasOwn(config.accountConfigs || {}, key) ? config.accountConfigs[key] : config;
  const result = settingsOnly(stored);
  if (config.__loadError) result.__loadError = config.__loadError;
  return { ...result, __accountKey: key || '' };
}

function saveAccount(root, settings, key) {
  if (!key) return { ...settingsOnly(settings), accountConfigs: root.accountConfigs || {} };
  if (!validAccountKey(key)) throw new Error('Invalid account settings key');
  return { ...root, accountConfigs: { ...(root.accountConfigs || {}), [key]: settingsOnly(settings) } };
}

function accountStateFiles(directory, key) {
  const root = key ? path.join(directory, 'account-state', createHash('sha256').update(key).digest('hex')) : directory;
  const files = { welcome: path.join(root, 'welcome-daily.json'), midnight: path.join(root, 'midnight-command.json') };
  if (!key) return files;
  fs.mkdirSync(root, { recursive: true });
  for (const file of Object.values(files)) {
    const legacy = path.join(directory, path.basename(file));
    if (!fs.existsSync(file) && fs.existsSync(legacy)) {
      try { fs.copyFileSync(legacy, file, fs.constants.COPYFILE_EXCL); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
  }
  return files;
}

module.exports = { validAccountKey, effectiveAccount, saveAccount, accountStateFiles };
