'use strict';

const path = require('path');
const fs = require('fs');
const PRODUCT_NAME = '\u8292\u679c\u7aef\u8f85\u52a9';
const LEGACY_DATA_NAME = 'MC\u514d\u5ba2\u6237\u7aef\u767b\u5f55\u5668';

function configureDataPath(app, argv = process.argv) {
  const index = argv.findIndex((arg) => arg === '--user-data-dir' || arg.startsWith('--user-data-dir='));
  const explicit = index >= 0;
  const explicitPath = explicit && (argv[index] === '--user-data-dir' ? argv[index + 1] : argv[index].slice('--user-data-dir='.length));
  if (argv.includes('--selftest-ui') && explicit && (!explicitPath || !path.isAbsolute(explicitPath))) {
    throw new Error('UI selftest requires an explicit isolated data directory');
  }
  if (argv.includes('--selftest-ui') && !explicit) {
    const rootArg = argv.find((arg) => arg.startsWith('--selftest-app-data='));
    const root = rootArg && rootArg.slice('--selftest-app-data='.length);
    if (!root || !path.isAbsolute(root)) throw new Error('UI selftest requires an explicit isolated data directory');
    // Windows known-folder paths do not follow an APPDATA environment override.
    fs.mkdirSync(root, { recursive: true });
    app.setPath('appData', root);
  }
  if (!explicit) {
    const directory = path.join(app.getPath('appData'), LEGACY_DATA_NAME);
    fs.mkdirSync(directory, { recursive: true });
    app.setPath('userData', directory);
    if (argv.includes('--selftest-ui')) app.setPath('sessionData', directory);
  }
  return app.getPath('userData');
}

module.exports = { PRODUCT_NAME, LEGACY_DATA_NAME, configureDataPath };
