'use strict';

const fs = require('fs');
const path = require('path');

function unsignedConfig(pkg) {
  const config = structuredClone(pkg.build);
  config.forceCodeSigning = false;
  config.electronDist = path.join(__dirname, '..', 'node_modules', 'electron', 'dist');
  config.directories.output = 'dist-' + pkg.version + '-unsigned';
  config.portable.artifactName = pkg.productName + '-未签名便携版-${version}.exe';
  config.win.signtoolOptions = { signingHashAlgorithms: ['sha256'] };
  for (const key of ['certificateFile', 'certificatePassword', 'certificateSha1', 'certificateSubjectName',
    'sign', 'azureSignOptions']) delete config.win[key];
  delete config.cscLink;
  delete config.cscKeyPassword;
  return config;
}

function unsignedEnvironment(env) {
  const clean = { ...env };
  for (const key of Object.keys(clean)) {
    if (/^(?:WIN_)?CSC_/i.test(key)) delete clean[key];
  }
  clean.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  return clean;
}

async function main() {
  const root = path.join(__dirname, '..');
  const pkg = require('../package.json');
  const clean = unsignedEnvironment(process.env);
  for (const key of Object.keys(process.env)) if (!(key in clean)) delete process.env[key];
  Object.assign(process.env, clean);
  const { build, Platform, Arch } = require('electron-builder');
  const config = unsignedConfig(pkg);
  const outputIndex = process.argv.indexOf('--output');
  if (outputIndex !== -1) {
    const requested = process.argv[outputIndex + 1];
    if (!requested || !/^dist-[A-Za-z0-9.-]+$/.test(requested)) throw new Error('Output must be a dist-* directory name');
    config.directories.output = requested;
  }
  console.log('Explicit unsigned release; no publisher verification or Windows policy changes.');
  await build({ projectDir: root, config, targets: Platform.WINDOWS.createTarget(['portable'], Arch.x64), publish: 'never' });
  const note = [
    pkg.productName + ' V' + pkg.version.replace(/\.0$/, '') + ' - 未签名版本',
    '此包按用户明确要求生成，未使用代码签名证书，不代表发布者验证已通过。',
    '未修改 Windows 安全策略；若系统阻止启动，不应把打包成功当作启动成功。',
    '不附带账号凭据、桥接配对令牌或私人数据快照；保留本机已有数据。',
    '自动化、桥接与系统通知仍需目标环境验收；按用户要求取消强制签名。',
    '',
  ].join('\r\n');
  fs.writeFileSync(path.join(root, config.directories.output, 'UNSIGNED-BUILD.txt'), note, 'utf8');
}

module.exports = { unsignedConfig, unsignedEnvironment };
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
