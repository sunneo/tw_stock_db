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
# 覆蓋（見main.js getSecrets()的說明）。金鑰值正常從建置當下的環境變數讀
# （FA_BUILTIN_NVAPI_KEY/FA_BUILTIN_OPENROUTER_KEY，例如CI secrets），不
# 寫死在任何原始碼裡。用node -e而不是shell字串拼接寫JSON，避免金鑰值裡
# 剛好帶雙引號/反斜線等特殊字元時手刻escape出錯。
#
# 2026-09-16使用者實測回報：透過`cmd /c "set X=Y && ... && powershell -File
# build.ps1"`這種巢狀shell一次性指令設定環境變數，在他的Windows機器上沒有
# 正確傳遞到build.ps1（那邊也做了同樣這處改動）——沒有查到確切根因（可能是
# cmd/powershell巢狀呼叫某個環節遺失環境變數，也可能是別的原因），但使用者
# 明確要求要有一條「直接填、保證有效」的路，不要繼續卡在環境變數傳遞的除錯。
# 所以：兩個環境變數都沒設定、且builtin-secrets.json已經存在（例如使用者
# 手動編輯過）時，直接保留現有檔案不覆寫——這樣使用者可以直接打開這個檔案
# 手動填入NVAPI_KEY/OPENROUTER_API_KEY，之後build不設環境變數也不會被清空。
# 設定環境變數仍然可用、仍然優先（每次都會重新產生檔案），給CI這類情境用。
echo "== 產生 builtin-secrets.json（來源：建置環境的 FA_BUILTIN_NVAPI_KEY / FA_BUILTIN_OPENROUTER_KEY，或手動編輯過的既有檔案）=="
if [[ -n "${FA_BUILTIN_NVAPI_KEY:-}" || -n "${FA_BUILTIN_OPENROUTER_KEY:-}" ]]; then
  node -e '
    const fs = require("fs");
    const out = {
      NVAPI_KEY: process.env.FA_BUILTIN_NVAPI_KEY || "",
      OPENROUTER_API_KEY: process.env.FA_BUILTIN_OPENROUTER_KEY || "",
    };
    fs.writeFileSync("builtin-secrets.json", JSON.stringify(out, null, 2) + "\n");
    console.log("已用環境變數寫入 builtin-secrets.json。");
  '
elif [[ -f "builtin-secrets.json" ]]; then
  echo "環境變數未設定，保留現有 builtin-secrets.json 不覆寫（例如你手動編輯過的內建金鑰）。"
else
  printf '{"NVAPI_KEY":"","OPENROUTER_API_KEY":""}\n' > builtin-secrets.json
  echo "沒有設定環境變數、也沒有既有檔案，寫出空的 builtin-secrets.json（可以直接手動編輯這個檔案填入金鑰，之後build不設環境變數也會保留）。"
fi

if [[ "${SKIP_INSTALL:-0}" != "1" ]]; then
  echo "== npm install =="
  npm install
fi

# tw_stock_db客製: 2026-09-16——電腦上Windows桌面版build.ps1遇到的真實案例
# ——electron-builder的CLI用「--win/--linux <target>」這種寫法時，沒有明講
# arch旗標的話會退回讀「目前跑這支script的Node process自己的process.arch」，
# 不是package.json裡build.win/linux.target設定的arch陣列（那組設定在這種
# 呼叫方式下形同沒用）。跑這支script的Node剛好是32位元組建時，會悄悄打包
# 成ia32版本，而新版Electron早就不再發布Windows/Linux的32位元組建，載到
# 一半才用一個看起來毫不相干的404錯誤失敗。明確加上--x64繞過process.arch
# 偵測，不管跑這支script的Node本身是32/64位元都一律打包x64。
TARGET="${1:-linux}"
case "$TARGET" in
  linux)
    echo "== electron-builder 打包 Linux AppImage =="
    npx electron-builder --linux AppImage --x64
    ;;
  win)
    echo "== electron-builder 打包 Windows portable exe（跨平台編譯，需要系統已裝wine）=="
    npx electron-builder --win portable --x64
    ;;
  *)
    echo "未知的目標平台：$TARGET（可用 linux 或 win）" >&2
    exit 1
    ;;
esac

echo ""
echo "完成！輸出在 dist/ 目錄底下。"
