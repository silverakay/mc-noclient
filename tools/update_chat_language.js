'use strict';

// Pinned official 26.2 assets. Runtime chat rendering never downloads assets.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const INDEX_HASH = '72b2ca7f98a3af7c84ac7c47a3292faea80280c5';
const LANG_HASH = '3c1a6e6c941c547d2ec8b6990c8201d6585e3d59';

async function verified(url, sha1) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('Asset download failed: HTTP ' + response.status);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (crypto.createHash('sha1').update(bytes).digest('hex') !== sha1) {
    throw new Error('Asset SHA-1 mismatch');
  }
  return bytes;
}

async function run() {
  const index = JSON.parse(await verified(
    'https://piston-meta.mojang.com/v1/packages/' + INDEX_HASH + '/32.json', INDEX_HASH));
  if (index.objects['minecraft/lang/zh_cn.json'].hash !== LANG_HASH) {
    throw new Error('Unexpected language asset');
  }
  const bytes = await verified('https://resources.download.minecraft.net/' +
    LANG_HASH.slice(0, 2) + '/' + LANG_HASH, LANG_HASH);
  const data = JSON.parse(bytes);
  if (!data['death.attack.mob'] || !data['chat.type.advancement.task']) {
    throw new Error('Required chat translations missing');
  }
  const dir = path.join(__dirname, '..', 'src', 'lang');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'zh_cn.json'), bytes);
  console.log('Bundled official 26.2 zh_cn: ' + Object.keys(data).length + ' translations');
}

run().catch((e) => { console.error(e.message); process.exitCode = 1; });
