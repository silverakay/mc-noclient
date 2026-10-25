#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""重建「源码整合包」目录与 zip。

用法（在工程根目录）：
    python tools/pack_source.py            # 重建 release-source/芒果端辅助-<版本>-源码 并打 zip
    python tools/pack_source.py --no-zip   # 只重建目录

包含规则：app/、src/、tools/、mods/client-bridge/src/、docs/、build/icon.ico、
根目录四个 bat、config.json、package.json、package-lock.json、.gitignore、AGENTS.md，
外加由 docs/source-pack/ 模板生成的 README.md、CHANGELOG.md、LICENSE、使用说明.md、
docs/项目完整说明.md。

剔除规则：发布目录、backups/、node_modules/、testserver/、logs/、release-data/、
HANDOFF*、*.jar、*.exe、*.dll、*.pak、截图、src/_*_tmp_*.js。
"""

import argparse
import json
import re
import shutil
import sys
import zipfile
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PACK_NAME = "芒果端辅助-{ver}-源码"
ZIP_NAME = "芒果端辅助-{ver}-源码整合包.zip"

ROOT_FILES = [
    "1_打开菜单.bat",
    "2_直接登录_按config.bat",
    "3_查看所有服状态.bat",
    "4_运行自检.bat",
    "AGENTS.md",
    ".gitignore",
    "config.json",
    "package.json",
    "package-lock.json",
]

# 目录级整体复制（不含依赖与产物）
TREES = ["app", "src", "tools", "docs", "mods/client-bridge/src"]

SKIP_DIR_NAMES = {"node_modules", ".git", ".workbuddy", "__pycache__", ".gradle", "build", "releases"}
SKIP_FILE_NAMES = {
    "ui_selftest.json", "ui_selftest.png", "proto_tmp.json",
    "Thumbs.db", "Desktop.ini", ".DS_Store",
}
SKIP_SUFFIXES = (".log", ".png", ".jpg", ".jpeg", ".blockmap", ".map", ".jar", ".exe", ".dll", ".pak", ".bin")
SKIP_PATTERNS = [
    re.compile(r"^_.*_tmp_.*\.js$"),
    re.compile(r"_tmp_"),
    re.compile(r"^HANDOFF-HISTORY-.*\.md$"),
]

MIT = """MIT License

Copyright (c) 2026 BaiXu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""

SUITE_COUNT = None


def read_json(rel):
    with (ROOT / rel).open(encoding="utf-8") as fh:
        return json.load(fh)


def count_suites():
    text = (ROOT / "src/run_all_tests.js").read_text(encoding="utf-8")
    start = text.index("const SUITES = [")
    body = text[start:text.index("];", start)]
    return len(re.findall(r"^\s*\['", body, flags=re.M))


def newest_manual(docs):
    best = None
    for item in docs.glob("使用手册-V*.md"):
        m = re.search(r"使用手册-V(\d+(?:\.\d+)*)\.md$", item.name)
        if not m:
            continue
        key = tuple(int(x) for x in m.group(1).split("."))
        if best is None or key > best[0]:
            best = (key, item)
    return best[1] if best else None


def should_skip_file(path: Path):
    name = path.name
    if name in SKIP_FILE_NAMES:
        return True
    if name.endswith(SKIP_SUFFIXES):
        return True
    return any(p.search(name) for p in SKIP_PATTERNS)


def copy_tree(src: Path, dst: Path):
    copied = 0
    for item in src.rglob("*"):
        rel = item.relative_to(src)
        if any(part in SKIP_DIR_NAMES for part in rel.parts[:-1]):
            continue
        if item.is_dir():
            continue
        if should_skip_file(item):
            continue
        target = dst / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(item, target)
        copied += 1
    return copied


def render(text, mapping):
    for key, value in mapping.items():
        text = text.replace("{{%s}}" % key, str(value))
    return text


def build_stage(version, mod_version, today):
    stage = ROOT / "release-source" / PACK_NAME.format(ver=version)
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True)

    count = 0
    for rel in ROOT_FILES:
        src = ROOT / rel
        if not src.exists():
            print("  ! 缺少 %s，跳过" % rel)
            continue
        shutil.copy2(src, stage / rel)
        count += 1

    for rel in TREES:
        src = ROOT / rel
        if not src.exists():
            print("  ! 缺少 %s，跳过" % rel)
            continue
        count += copy_tree(src, stage / rel)

    # 打包图标（build/ 目录只取这一个文件）
    icon = ROOT / "build/icon.ico"
    if icon.exists():
        (stage / "build").mkdir(exist_ok=True)
        shutil.copy2(icon, stage / "build/icon.ico")
        count += 1

    mapping = {
        "APP_VERSION": version,
        "MOD_VERSION": mod_version,
        "DATE": today,
        "SUITE_COUNT": SUITE_COUNT,
    }

    # 入口 README / CHANGELOG / LICENSE
    for name, template in (("README.md", "README.md"), ("CHANGELOG.md", "CHANGELOG.md")):
        text = (ROOT / "docs/source-pack" / template).read_text(encoding="utf-8")
        (stage / name).write_text(render(text, mapping), encoding="utf-8", newline="\n")
        count += 1
    (stage / "LICENSE").write_text(MIT, encoding="utf-8", newline="\n")
    count += 1

    # 使用说明 = 最新一版手册，顶部补一句版本差
    manual = newest_manual(ROOT / "docs")
    if manual:
        m = re.search(r"使用手册-(V[\d.]+)\.md$", manual.name)
        tag = m.group(1) if m else "V?"
        header = (
            "> 本手册对应 %s 的界面。比手册更新的界面与功能变更（双开独立端口、按游戏账号配对、"
            "桥接下线后独立接管）见 `docs/RELEASE-6.3.md` 与 `docs/RELEASE-6.4.md`。\n\n"
            % tag
        )
        body = manual.read_text(encoding="utf-8")
        (stage / "使用说明.md").write_text(header + body, encoding="utf-8", newline="\n")
        count += 1

    # 根 README 作为完整说明保留
    root_readme = ROOT / "README.md"
    if root_readme.exists():
        shutil.copy2(root_readme, stage / "docs/项目完整说明.md")
        count += 1

    return stage, count


def make_zip(stage: Path, version: str) -> Path:
    target = ROOT / ZIP_NAME.format(ver=version)
    if target.exists():
        target.unlink()
    files = sorted(p for p in stage.rglob("*") if p.is_file())
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for item in files:
            arc = PACK_NAME.format(ver=version) + "/" + item.relative_to(stage).as_posix()
            zf.write(item, arc)
    return target


def main():
    global SUITE_COUNT
    parser = argparse.ArgumentParser(description="重建源码整合包")
    parser.add_argument("--no-zip", action="store_true", help="只重建目录，不生成 zip")
    args = parser.parse_args()

    version = read_json("package.json")["version"]
    mod_version = read_json("mods/client-bridge/src/main/resources/fabric.mod.json")["version"]
    SUITE_COUNT = count_suites()
    today = date.today().isoformat()

    stage, count = build_stage(version, mod_version, today)
    size = sum(p.stat().st_size for p in stage.rglob("*") if p.is_file())
    print("目录  : %s" % stage)
    print("文件  : %d 个 / %.1f MB" % (count, size / 1024 / 1024))
    print("版本  : 应用 %s · 桥接 Mod %s · 离线套件 %d" % (version, mod_version, SUITE_COUNT))

    if args.no_zip:
        return 0
    target = make_zip(stage, version)
    print("zip   : %s（%.2f MB）" % (target, target.stat().st_size / 1024 / 1024))
    return 0


if __name__ == "__main__":
    sys.exit(main())
