'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const pkg = require('../package.json');
const lock = require('../package-lock.json');
const match = /^(\d+)\.(\d+)\.0$/.exec(pkg.version);
assert.ok(match, 'Application releases must use major.minor.0');
assert.equal(lock.version, pkg.version);
assert.equal(lock.packages[''].version, pkg.version);
const html = fs.readFileSync(path.join(root, 'app/renderer/index.html'), 'utf8');
assert.ok(html.includes('<span class="ver">V' + match[1] + '.' + match[2] + ' '),
  'Visible major.minor version must match package metadata');
assert.equal(pkg.build.forceCodeSigning, false, 'User explicitly requested unsigned releases');
assert.ok(pkg.build.portable.artifactName.includes('未签名'));
assert.deepEqual(pkg.build.win.signtoolOptions.signingHashAlgorithms, ['sha256']);
console.log('PASS internal version, lockfile, visible version and explicitly unsigned release labels');
