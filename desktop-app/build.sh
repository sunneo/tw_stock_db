#!/usr/bin/env bash
# FloatingAssistant桌面版 - Linux/跨平台打包腳本
# 預設打包Linux AppImage（單一可執行檔，不需要安裝，加上執行權限就能跑）。
# 用法：
#   ./build.sh            # 打包 Linux AppImage
#   ./build.sh win        # 打包 Windows portable exe（跨平台編譯需要wine，
#                          # 建議直接在Windows上用build.ps1，比較不會踩雷）
#   SKIP_INSTALL=1 ./build.sh   # 跳過npm install
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

echo "== 同步 floating-assistant.js（canonical來源：../web/floating-assistant.js）=="
cp ../web/floating-assistant.js renderer/floating-assistant.js

if [[ "${SKIP_INSTALL:-0}" != "1" ]]; then
  echo "== npm install =="
  npm install
fi

TARGET="${1:-linux}"
case "$TARGET" in
  linux)
    echo "== electron-builder 打包 Linux AppImage =="
    npx electron-builder --linux AppImage
    ;;
  win)
    echo "== electron-builder 打包 Windows portable exe（跨平台編譯，需要系統已裝wine）=="
    npx electron-builder --win portable
    ;;
  *)
    echo "未知的目標平台：$TARGET（可用 linux 或 win）" >&2
    exit 1
    ;;
esac

echo ""
echo "完成！輸出在 dist/ 目錄底下。"
