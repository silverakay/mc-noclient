'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const pkg = require('../package.json');
const output = path.resolve(process.argv[2] || path.join(root, 'dist'));
const unpacked = path.join(output, 'win-unpacked');
const runtime = path.join(root, 'node_modules', 'electron', 'dist');
const required = [
  'ffmpeg.dll', 'd3dcompiler_47.dll', 'libEGL.dll', 'libGLESv2.dll',
  'icudtl.dat', 'resources.pak', 'chrome_100_percent.pak',
  'chrome_200_percent.pak', 'snapshot_blob.bin', 'v8_context_snapshot.bin',
  'vk_swiftshader.dll', 'vk_swiftshader_icd.json', 'vulkan-1.dll',
];

function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function launch(exe, implicitDataPath = false) {
  assert.ok(fs.existsSync(exe), 'Missing executable: ' + exe);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-package-smoke-'));
  const appData = path.join(sandbox, 'appdata');
  const temp = path.join(sandbox, 'temp');
  fs.mkdirSync(temp, { recursive: true });
  const config = {
    username: 'Tester', servers: [], autoLogin: false,
    behavior: { showChat: true, greet: '', commands: [] },
    reconnect: { enabled: false, delaySeconds: 5, maxAttempts: 10 },
    automation: { autoClaimRedPackets: false, autoWelcome: false },
    midnightCommand: { enabled: false, command: '' },
  };
  // Both Electron name variants get an empty config: no auth, ping or connection.
  const dataDirs = [...new Set([pkg.productName, pkg.name, require('../src/app_identity').LEGACY_DATA_NAME])]
    .map((name) => path.join(appData, name));
  for (const dir of dataDirs) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  }

  const env = { ...process.env, APPDATA: appData, TEMP: temp, TMP: temp };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = await new Promise((resolve, reject) => {
    const args = implicitDataPath
      ? ['--selftest-ui', '--selftest-app-data=' + appData]
      : ['--selftest-ui', '--user-data-dir=' + dataDirs[0]];
    const child = spawn(exe, args, {
      env, cwd: path.dirname(exe), windowsHide: true, stdio: 'ignore',
    });
    const timeout = setTimeout(() => {
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true, stdio: 'ignore',
        });
        killer.on('error', () => child.kill());
      } else child.kill();
      reject(new Error('Package startup timed out: ' + exe + '\nResults: ' + sandbox));
    }, 60000);
    child.once('error', (e) => { clearTimeout(timeout); reject(e); });
    child.once('exit', (code) => { clearTimeout(timeout); resolve(code); });
  });
  assert.equal(result, 0, 'Startup exit code for ' + exe + ' (results: ' + sandbox + ')');
  const reportPath = dataDirs.map((dir) => path.join(dir, 'ui_selftest.json'))
    .find((file) => fs.existsSync(file));
  assert.ok(reportPath, 'No UI report generated: ' + sandbox);
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  if (implicitDataPath) assert.equal(path.basename(path.dirname(reportPath)), require('../src/app_identity').LEGACY_DATA_NAME);
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(report.probe.serverItems, 0, 'Smoke test must not load saved servers');
  assert.equal(report.probe.offlineInputAbsent, true, 'Offline identity input must be removed');
  assert.equal(fs.existsSync(path.join(appData, '.mc-noclient', 'accounts.json')), false,
    'Selftests must not import private accounts');
  assert.equal(fs.existsSync(path.join(path.dirname(reportPath), 'bridge-pairing.json')), false,
    'Selftests must not import bridge credentials');
  assert.equal(fs.existsSync(path.join(path.dirname(reportPath), 'release-seeded.json')), false,
    'Selftests must not import bundled data');
  console.log('PASS startup: ' + path.basename(exe));
  console.log('UI report: ' + reportPath);
}

async function run() {
  if (process.platform !== 'win32') throw new Error('Windows package test only');
  for (const file of required) {
    assert.equal(hash(path.join(unpacked, file)), hash(path.join(runtime, file)),
      'Missing or mismatched Electron runtime file: ' + file);
  }
  assert.ok(fs.existsSync(path.join(unpacked, 'locales', 'zh-CN.pak')));
  const asar = require('@electron/asar');
  const archive = path.join(unpacked, 'resources', 'app.asar');
  const packagedFiles = asar.listPackage(archive);
  const withData = process.argv.includes('--with-data');
  assert.equal(packagedFiles.some((file) => /^[/\\]release-data[/\\]/.test(file)), withData,
    'Private data presence must match the release variant');
  if (withData) {
    for (const file of ['app-data/config.json', 'auth/accounts.json']) {
      assert.deepEqual(asar.extractFile(archive, path.join('release-data', file)),
        fs.readFileSync(path.join(root, 'release-data', file)), 'Private snapshot differs: ' + file);
    }
  }
  assert.deepEqual(asar.listPackage(archive).filter((file) => /[\\/]_.*_tmp_.*\.js$/.test(file)), [],
    'Generated test scripts must not be included in the release');
  const packagedMetadata = JSON.parse(asar.extractFile(archive, 'package.json'));
  for (const key of ['name', 'productName', 'version', 'main']) {
    assert.equal(packagedMetadata[key], pkg[key], 'Packaged metadata differs: ' + key);
  }
  for (const file of ['app/main.js', 'app/renderer/index.html',
    'app/renderer/renderer.js', 'app/renderer/style.css', 'app/preload.js',
    'src/auth.js', 'src/client.js', 'src/crypt.js', 'src/proto.js', 'src/nbt.js',
    'src/chat_component.js', 'src/chat_actions.js', 'src/red_packet_batch.js', 'src/outbound_monitor.js', 'src/lang/zh_cn.json', 'src/lang/customcrops_zh_cn.json',
    'src/reconnect.js', 'src/configstore.js', 'src/red_packet.js', 'src/presence.js', 'src/welcome.js', 'src/client_bridge.js', 'src/midnight_command.js',
    'src/app_identity.js', 'src/release_seed.js', 'src/history_store.js', 'src/chat_filter.js', 'src/chat_monitor.js', 'src/bridge_discovery.js', 'src/bridge_handoff.js',
    'src/window_lifecycle.js', 'src/daily_purchase.js', 'src/menu_key_sequence.js', 'src/monitor.js',
    'src/server_profiles.js', 'src/account_profiles.js', 'src/file_lock.js', 'src/attention.js', 'src/bridge_exit.js', 'app/renderer/attention.js', 'app/icon.ico', 'app/renderer/icons/settings.svg',
    'src/server_features.js', 'src/data/protocol-26.2.json', 'src/data/items-26.2.json',
    'src/vendor/protocol-datatypes/compiler-minecraft.js', 'src/vendor/protocol-datatypes/minecraft.js',
    'src/vendor/protocol-datatypes/lpVec3.js', 'src/vendor/protocol-datatypes/LICENSE',
    'app/renderer/icons/x.svg', 'app/renderer/icons/LICENSE.txt']) {
    assert.deepEqual(asar.extractFile(archive, path.normalize(file)),
      fs.readFileSync(path.join(root, file)), 'Packaged source differs: ' + file);
  }
  console.log('PASS runtime completeness and packaged sources');
  assert.equal(packagedFiles.some((file) => /[\\/]rehearsal\.js$/.test(file)), false, 'Offline rehearsal must not be packaged');
  for (const file of ['app/main.js', 'app/preload.js', 'app/renderer/index.html',
    'app/renderer/renderer.js', 'src/client_bridge.js']) {
    const source = asar.extractFile(archive, path.normalize(file)).toString('utf8');
    assert.doesNotMatch(source, /setFishing|revealFishingMod|fishing:set|chk-fishing|st-fishing|自动钓鱼|Auto-fishing/,
      'Removed auto-fishing controls remain in the packaged app: ' + file);
  }
  assert.equal(fs.existsSync(path.join(unpacked, 'resources', 'mods', 'auto-fish')), false,
    'Removed auto-fishing resources must not be bundled');
  console.log('PASS auto-fishing resources removed');
  const portableLabel = '-未签名便携版-';
  const portable = path.join(output, pkg.productName + portableLabel + pkg.version + '.exe');
  if (process.argv.includes('--portable-only')) {
    console.log('Portable-only startup scope: directory executable is not covered by this run');
    await launch(portable);
    await launch(portable, true);
  } else {
    await launch(path.join(unpacked, pkg.productName + '.exe'));
    await launch(portable);
    await launch(path.join(unpacked, pkg.productName + '.exe'), true);
  }
}

run().catch((e) => { console.error(e); process.exitCode = 1; });
