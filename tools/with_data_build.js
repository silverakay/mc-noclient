'use strict';

const fs = require('fs');
const path = require('path');
const pkg = require('../package.json');
const root = path.join(__dirname, '..');

if (!fs.existsSync(path.join(root, 'release-data', 'auth', 'accounts.json'))
  || !fs.existsSync(path.join(root, 'release-data', 'app-data', 'config.json'))) {
  throw new Error('Private build requires an explicitly staged release-data snapshot');
}

// The normal build never includes this private snapshot.
module.exports = { ...pkg.build, files: [...pkg.build.files, 'release-data/**/*'] };
