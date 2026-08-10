#!/usr/bin/env bash
#
# 一键发布 PaperMirror:构建 → 推送 → 创建 GitHub Release(带 xpi + updates.json)→ 标为 latest。
# 直接本地发布,绕开可能失败的 GitHub Actions。老版本随后即可自动更新到这一版。
#
# 用法:在仓库根目录执行
#     bash publish.sh
#
# 依赖:node/npm(构建)、git(推送)、gh GitHub CLI 且已登录(创建 Release)。
# 若 gh 未登录,脚本会停下并告诉你运行一次 `gh auth login`。
#
set -euo pipefail
cd "$(dirname "$0")"

VER="$(node -p "require('./manifest.json').version")"
TAG="v${VER}"
XPI="dist/zotero-bilingual-reader-${VER}.xpi"

echo "==> PaperMirror 发布 ${TAG}"

# 版本一致性检查
PKG_VER="$(node -p "require('./package.json').version")"
if [ "${PKG_VER}" != "${VER}" ]; then
	echo "!! package.json (${PKG_VER}) 与 manifest.json (${VER}) 版本不一致,请先统一。" >&2
	exit 1
fi

# 1) 构建 xpi + updates.json
echo "==> 安装依赖并构建"
npm ci
if [ "${SKIP_TESTS:-0}" != "1" ]; then
	npm test
fi
npm run package
node scripts/gen-updates.mjs "${VER}"
node scripts/release-notes.mjs "${VER}" || true
[ -f "${XPI}" ] || { echo "!! 构建失败:找不到 ${XPI}" >&2; exit 1; }
[ -f updates.json ] || { echo "!! 构建失败:找不到 updates.json" >&2; exit 1; }

# 2) 推送分支
echo "==> 推送 Beta 与 main"
git push origin Beta
git push origin main

# 3) 创建 / 更新 GitHub Release
if ! command -v gh >/dev/null 2>&1; then
	echo "!! 未找到 gh(GitHub CLI)。代码已推送、附件已构建好。"
	echo "   请安装:brew install gh  然后 gh auth login,再重跑本脚本;"
	echo "   或到 GitHub Releases 手动新建 ${TAG},上传 ${XPI} 和 updates.json,勾 Set as latest。"
	exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
	echo "!! gh 未登录。请运行一次:gh auth login  然后重跑本脚本。"
	echo "   (代码已推送、附件已构建好,登录后重跑即可发布。)"
	exit 1
fi

NOTES_ARG=(--notes "PaperMirror ${TAG}")
[ -f release-notes.md ] && NOTES_ARG=(--notes-file release-notes.md)

if gh release view "${TAG}" >/dev/null 2>&1; then
	echo "==> Release ${TAG} 已存在,更新附件并标为 latest"
	gh release upload "${TAG}" "${XPI}" updates.json --clobber
	gh release edit "${TAG}" --latest >/dev/null
else
	echo "==> 创建 Release ${TAG}"
	gh release create "${TAG}" "${XPI}" updates.json --title "${TAG}" "${NOTES_ARG[@]}" --latest
fi

echo "==> 完成:${TAG} 已发布并标为 latest。老版本现在可自动更新到 ${VER}。"
echo "    验证:浏览器打开 https://github.com/wandonwe/PaperMirror-for-Zotero/releases/latest/download/updates.json"
echo "    应看到 version: ${VER}。"
