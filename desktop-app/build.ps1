# FloatingAssistant desktop build script (Windows).
# Produces two things in dist\:
#   - A proper Windows installer ('FloatingAssistant Setup <version>.exe',
#     electron-builder's "nsis" target) - installs, uninstalls via
#     Windows' Add/Remove Programs, creates Desktop + Start Menu shortcuts.
#   - dist\win-unpacked\, the same app as a plain no-install folder.
# Both contain FloatingAssistantApp.exe (the Electron app itself, plain
# default GUI subsystem, unmodified) and FloatingAssistant.exe (a small
# PyInstaller-built console-subsystem launcher - run this one from a
# terminal for `-p`; shortcuts point at FloatingAssistantApp.exe directly
# since GUI use never needs the launcher).
#
# 2026-09-16 history (kept so this isn't re-litigated): three earlier
# designs all tried to make ONE Electron .exe handle both GUI and `-p`
# by having a GUI-subsystem process spawn or relaunch a console-subsystem
# one (a copied/PE-patched binary, relaunching via cmd.exe /c, or patching
# the app's own exe in place). All three failed identically on real
# hardware: a new, invisible console window flashed and vanished instead
# of showing output, because a GUI-subsystem process launched bare from
# PowerShell never receives a usable console handle in the first place -
# so it has nothing valid to relay to any child, regardless of what it
# spawns or how. The fix that actually works: don't make the Electron app
# solve this at all. FloatingAssistant.exe is a genuinely, separately
# compiled console-subsystem executable (PyInstaller's own bootloader, not
# a byte-patched Electron binary) - launched directly by the user's shell,
# it has a real console of its own, and relaying that to
# FloatingAssistantApp.exe (whether for -p or to open the GUI) works
# because the relaying process itself actually has something valid to
# relay. See launcher/launcher.py for the full explanation.
#
# Usage:
#   .\build.ps1              # full flow: sync engine + npm install + package
#   .\build.ps1 -SkipInstall # skip npm install (faster if node_modules is already good)
#
# Note: this file is kept plain-ASCII on purpose. Windows PowerShell 5.1
# reads .ps1 files without a BOM using the system's ANSI codepage, so
# non-ASCII (e.g. Chinese) text in string literals here can get misread
# and corrupt the script (seen once as a "string missing terminator"
# parse error). Comments/messages in other project files (JS/HTML) are
# fine since Node and Chromium are UTF-8-native.
param(
    [switch]$SkipInstall,
    # Local proxy transport: "http" (default, listens on 127.0.0.1) or "inprocess"
    # (no TCP port at all; same routes served inside the app via the fa-local://
    # protocol). Can also be set with the FA_PROXY_MODE environment variable.
    # NOTE: "inprocess" disables Browser Control (the Chrome extension needs a
    # local HTTP port). See main.js PROXY_MODE.
    [ValidateSet("", "http", "inprocess")]
    [string]$ProxyMode = ""
)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

# tw_stock_db客製: 2026-09-17使用者要求——renderer/floating-assistant.js
# 不再是build時從../web/複製過去的副本，這個desktop-app分支本身現在是
# floating-assistant.js唯一的canonical來源，main分支的web/index.html改成
# 執行時從這個分支的raw URL fetch這個檔案（見web/index.html的
# window.__floatingAssistantJsReady）。
#
# tw_stock_db客製: 2026-09-24使用者要求——「canonical來源」現在精確地說
# 是指renderer/src/floating-assistant.js（真正手動編輯/commit的原始碼），
# renderer/floating-assistant.js／renderer/floating-assistant.min.js是
# build-assistant.js壓縮出來的產出（內容一致）——桌面版index.html跟網頁版
# 的raw URL fetch路徑都刻意沒變，仍然不需要複製步驟，只是npm install之後
# 多了一次壓縮，見下面。

# Bakes in a default/free-tier key so first-time users don't need to supply
# their own before the app is usable; anything the user sets themselves
# (Advance Settings / secrets.json) always overrides it (see main.js
# getSecrets()). The key value normally comes from this build machine's
# environment (FA_BUILTIN_NVAPI_KEY / FA_BUILTIN_OPENROUTER_KEY, e.g. CI
# secrets) - it is never hardcoded in source.
#
# 2026-09-16 user-reported bug: propagating these env vars through a
# `cmd /c "set X=Y && ... && powershell -File build.ps1"` one-liner didn't
# reliably reach this script on their machine - the packaged app came out
# with no builtin key even though the vars looked correctly set on the
# command line. Root cause of THAT specific failure was never pinned down
# (could be env var propagation through the nested cmd/powershell hop, could
# be something else) - but rather than keep chasing it, the user explicitly
# asked for a direct, foolproof place to just type the key in. So: if
# neither env var is set AND builtin-secrets.json already exists (e.g. you
# hand-edited it), leave it alone instead of unconditionally overwriting it
# with an empty object. That gives a second, always-reliable path: open
# `builtin-secrets.json` in this folder, fill in NVAPI_KEY/OPENROUTER_API_KEY
# by hand, save, then build WITHOUT setting the env vars - your manual values
# survive the build. Setting the env vars still works and still takes
# precedence (regenerates the file every time), for anyone who prefers that
# route (e.g. CI).
Write-Host "== Generating builtin-secrets.json (from FA_BUILTIN_NVAPI_KEY / FA_BUILTIN_OPENROUTER_KEY, or a hand-edited file) ==" -ForegroundColor Cyan
if ($env:FA_BUILTIN_NVAPI_KEY -or $env:FA_BUILTIN_OPENROUTER_KEY) {
    $builtinSecrets = @{
        NVAPI_KEY         = if ($env:FA_BUILTIN_NVAPI_KEY) { $env:FA_BUILTIN_NVAPI_KEY } else { "" }
        OPENROUTER_API_KEY = if ($env:FA_BUILTIN_OPENROUTER_KEY) { $env:FA_BUILTIN_OPENROUTER_KEY } else { "" }
    }
    $builtinSecrets | ConvertTo-Json | Set-Content -Path "builtin-secrets.json" -Encoding utf8
    Write-Host "Wrote builtin-secrets.json from environment variables." -ForegroundColor Cyan
} elseif (Test-Path "builtin-secrets.json") {
    Write-Host "Env vars not set - keeping existing builtin-secrets.json as-is (e.g. a hand-edited key)." -ForegroundColor Cyan
} else {
    '{"NVAPI_KEY":"","OPENROUTER_API_KEY":""}' | Set-Content -Path "builtin-secrets.json" -Encoding utf8
    Write-Host "No env vars and no existing file - wrote an empty builtin-secrets.json (edit it by hand to bake in a key; future builds without the env vars will keep your edits)." -ForegroundColor Cyan
}

if (-not $ProxyMode) { $ProxyMode = if ($env:FA_PROXY_MODE) { $env:FA_PROXY_MODE.ToLower() } else { "http" } }
if ($ProxyMode -ne "http" -and $ProxyMode -ne "inprocess") { throw "ProxyMode must be http or inprocess (got: $ProxyMode)" }
Write-Host "== Local proxy mode: $ProxyMode (writing build-config.json) ==" -ForegroundColor Cyan
('{"proxyMode": "' + $ProxyMode + '"}') | Set-Content -Path "build-config.json" -Encoding utf8

if (-not $SkipInstall) {
    Write-Host "== npm install ==" -ForegroundColor Cyan
    npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
}

Write-Host "== Minifying renderer/src/floating-assistant.js -> renderer/floating-assistant.js / .min.js ==" -ForegroundColor Cyan
node build-assistant.js
if ($LASTEXITCODE -ne 0) { throw "build-assistant.js failed" }

# This app is unsigned by design (see README "known limitations"), so
# electron-builder never needs to discover a real signing identity.
# Setting this also skips some of electron-builder's mac-signing-related
# setup, which can otherwise still fire even for a Windows-only build.
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"

# --x64 is required here even though package.json's build.win.target
# already lists arch:["x64"] - electron-builder's CLI target parsing (when
# you pass --win <target> without an explicit arch flag) falls back to the
# CURRENT NODE PROCESS's own process.arch, not the config file's arch list.
# On a 32-bit Node.js install this silently packages for win32-ia32 instead
# of x64, and since Electron dropped 32-bit Windows builds entirely (recent
# versions don't publish an ia32 zip at all), that fails with a 404
# downloading electron-vX.X.X-win32-ia32.zip - a confusing error that looks
# unrelated to architecture at first glance. Passing --x64 explicitly
# bypasses process.arch detection entirely, regardless of which Node.js
# build (32-bit or 64-bit) is running this script.
# tw_stock_db客製: 2026-09-16——曾經嘗試用--add-data把整個dist\win-unpacked\
# 打包進launcher.exe裡面做成真正的單一檔案，實測`-p`確實work，但GUI模式
# 開出來是一片空白（devtools/console看得到Chromium的disk_cache/GPU cache
# 建立失敗錯誤——`Unable to create cache`/`Gpu Cache Creation failed`，
# 研判是PyInstaller onefile每次執行都解壓縮到一個新的暫存資料夾，這個
# 路徑下Chromium的cache/GPU shader cache寫入失敗，連帶讓畫面無法正確
# render；`-p`用的隱藏視窗不需要真的畫出東西，所以沒受影響、還能正確拿到
# AI回覆）。這個問題沒有進一步深究根因就先改回來——launcher.exe改成獨立
# build，用electron-builder的afterPack hook（build/afterPack.js）複製進
# electron-builder自己產生的app資料夾（不embed），這是唯一同時驗證過`-p`
# 跟GUI都正常的組合。
#
# launcher要在electron-builder之前先build好，afterPack hook才找得到來源
# 檔案去複製。
Write-Host "== Building FloatingAssistant.exe launcher (PyInstaller) ==" -ForegroundColor Cyan
$pythonCmd = Get-Command python -ErrorAction SilentlyContinue
if (-not $pythonCmd) {
    throw "python not found on PATH - required to build the launcher (pip install pyinstaller after installing Python)."
}
python -m PyInstaller --version *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host "PyInstaller not found - installing it now (pip install pyinstaller) ..." -ForegroundColor Cyan
    $prevEap2 = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"
    python -m pip install pyinstaller 2>&1 | ForEach-Object { Write-Host $_ }
    $ErrorActionPreference = $prevEap2
    if ($LASTEXITCODE -ne 0) { throw "pip install pyinstaller failed" }
}
Push-Location launcher
try {
    # PyInstaller writes normal INFO-level progress to stderr; with the
    # script-wide $ErrorActionPreference = "Stop", PowerShell 5.1 wraps
    # every stderr line from a native command into a NativeCommandError
    # and - worse - throws on it even though the build itself succeeds.
    # "SilentlyContinue" avoids both the throw and the misleading red
    # error-record noise; ForEach-Object { Write-Host $_ } re-prints each
    # line as plain text so real PyInstaller progress/errors are still
    # visible. $LASTEXITCODE is still checked below, same as every other
    # native call in this script - a genuine build failure is still caught.
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"
    python -m PyInstaller --onefile --console --name FloatingAssistant --distpath dist --workpath build --specpath . launcher.py 2>&1 | ForEach-Object { Write-Host $_ }
    $ErrorActionPreference = $prevEap
    if ($LASTEXITCODE -ne 0) { throw "PyInstaller build failed" }
} finally {
    Pop-Location
}

# tw_stock_db客製: 2026-09-16使用者要求——一個真正的Windows安裝包（可以
# 安裝、安裝後可以移除、在桌面跟開始功能表建立捷徑），用electron-builder
# 內建、成熟的「nsis」target（不是這次自己土炮的任何機制）。跟既有的
# 「dir」target（免安裝、直接執行的資料夾版本）在同一次呼叫裡一起產生
# ——CLI用`--win nsis dir --x64`（空白分隔多個target），不是分別呼叫兩次
# （electron-builder同一個platform+arch的多個target會共用同一次unpack，
# 只會觸發一次afterPack，不會把launcher複製兩次也不會重複打包整個app）。
# NSIS安裝精靈的捷徑會指向`FloatingAssistantApp.exe`（真正的GUI app本體，
# 未經修改，桌面/開始功能表雙擊本來就只需要GUI，不需要透過launcher）；
# `-p`需要的launcher仍然一起裝進安裝目錄，只是沒有快捷方式，習慣終端機
# 操作的使用者自己導覽到安裝目錄（或加進PATH）執行`FloatingAssistant.exe`。
Write-Host "== electron-builder: packaging Windows installer + app folder ==" -ForegroundColor Cyan
npx electron-builder --win nsis dir --x64
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "electron-builder failed. If the error mentions 'Cannot create symbolic link' while" -ForegroundColor Yellow
    Write-Host "extracting winCodeSign, that's a Windows permissions issue, not a project bug:" -ForegroundColor Yellow
    Write-Host "enable Developer Mode (Settings > Privacy & security > For developers) and retry," -ForegroundColor Yellow
    Write-Host "or run this script from an elevated (Administrator) PowerShell." -ForegroundColor Yellow
    throw "electron-builder packaging failed"
}

Write-Host ""
Write-Host "Done. Two outputs in dist\:" -ForegroundColor Green
Write-Host "  - 'FloatingAssistant Setup <version>.exe' - the installer. Run it, choose an" -ForegroundColor Green
Write-Host "    install directory, finish - creates Desktop + Start Menu shortcuts and an" -ForegroundColor Green
Write-Host "    uninstall entry in Windows' Add/Remove Programs. -p works from the install" -ForegroundColor Green
Write-Host "    directory's FloatingAssistant.exe (no shortcut for that, by design - it's a" -ForegroundColor Green
Write-Host "    terminal tool, not something you double-click)." -ForegroundColor Green
Write-Host "  - win-unpacked\ - the same app as a plain folder, no install needed. Run" -ForegroundColor Green
Write-Host "    FloatingAssistant.exe in there for everything (GUI or -p)." -ForegroundColor Green
