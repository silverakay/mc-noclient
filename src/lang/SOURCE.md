# Bundled Chat Language

`zh_cn.json` is the unmodified Simplified Chinese language asset from the
official Minecraft Java 26.2 asset index. It is used locally; no language
download occurs while connecting or receiving chat.

- Asset index: 32
- Index SHA-1: `72b2ca7f98a3af7c84ac7c47a3292faea80280c5`
- Language asset SHA-1: `3c1a6e6c941c547d2ec8b6990c8201d6585e3d59`
- Official index host: `piston-meta.mojang.com`
- Official asset host: `resources.download.minecraft.net`

Regenerate with `node tools/update_chat_language.js`. The tool verifies the
index and language hashes before writing the bundled asset.

Custom plugin translations use their supplied fallback when available.
Literal server text, including English, is preserved rather than guessed.
