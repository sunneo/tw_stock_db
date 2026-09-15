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

# tw_stock_db客製: 2026-09-15使用者要求——內建一把預設/免費額度金鑰，讓
# 新使用者不用先申請/填自己的NVAPI_KEY才能用，使用者自己填的值永遠優先
# 覆蓋（見main.js getSecrets()的說明）。金鑰值只從建置當下的環境變數讀
# （FA_BUILTIN_NVAPI_KEY/FA_BUILTIN_OPENROUTER_KEY，例如CI secrets），不
# 寫死在任何原始碼裡；沒設定這兩個環境變數時寫出一份空物件，行為等同
# 完全沒有這個機制，不影響既有使用者。用node -e而不是shell字串拼接寫
# JSON，避免金鑰值裡剛好帶雙引號/反斜線等特殊字元時手刻escape出錯。
echo "== 產生 builtin-secrets.json（來源：建置環境的 FA_BUILTIN_NVAPI_KEY / FA_BUILTIN_OPENROUTER_KEY）=="
node -e '
  const fs = require("fs");
  const out = {
    NVAPI_KEY: process.env.FA_BUILTIN_NVAPI_KEY || "",
    OPENROUTER_API_KEY: process.env.FA_BUILTIN_OPENROUTER_KEY || "",
  };
  fs.writeFileSync("builtin-secrets.json", JSON.stringify(out, null, 2) + "\n");
  console.log(out.NVAPI_KEY || out.OPENROUTER_API_KEY ? "已寫入內建金鑰。" : "沒有設定 FA_BUILTIN_*，寫出空的 builtin-secrets.json（不影響既有行為）。");
'

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
