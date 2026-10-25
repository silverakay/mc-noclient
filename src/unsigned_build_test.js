'use strict';

const assert = require('assert/strict');
const pkg = require('../package.json');
const { unsignedConfig, unsignedEnvironment } = require('../tools/unsigned_build');
const before = JSON.stringify(pkg);
const variant = unsignedConfig(pkg);
assert.equal(pkg.build.forceCodeSigning, false);
assert.equal(variant.forceCodeSigning, false);
assert.ok(require('fs').existsSync(require('path').join(variant.electronDist, 'electron.exe')));
assert.equal(variant.directories.output, 'dist-' + pkg.version + '-unsigned');
assert.ok(variant.portable.artifactName.includes('未签名便携版'));
assert.ok(variant.portable.artifactName.includes('${version}'));
assert.deepEqual(variant.files, pkg.build.files);
assert.ok(!variant.files.some((file) => file.includes('release-data')));
assert.equal(JSON.stringify(pkg), before, 'Unsigned profile must not mutate the production configuration');
const clean = unsignedEnvironment({ PATH: 'fixture-path', CSC_LINK: 'fixture-secret', WIN_CSC_LINK: 'fixture-secret',
  WIN_CSC_KEY_PASSWORD: 'fixture-secret', CSC_IDENTITY_AUTO_DISCOVERY: 'true' });
assert.deepEqual(clean, { PATH: 'fixture-path', CSC_IDENTITY_AUTO_DISCOVERY: 'false' });
assert.equal(pkg.scripts['dist:unsigned'], 'node tools/unsigned_build.js');
console.log('PASS explicit unsigned profile: marked artifacts, separate output and clean credentials');
