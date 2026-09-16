# FloatingAssistant desktop build script (Windows).
# Produces dist\win-unpacked\, a folder containing FloatingAssistantApp.exe
# (the Electron app itself, plain default GUI subsystem, unmodified) and
# FloatingAssistant.exe (a small PyInstaller-built console-subsystem
# launcher - the file users actually run, for both GUI and `-p` use).
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
    [switch]$SkipInstall
)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "== Syncing floating-assistant.js (canonical source: ..\web\floating-assistant.js) ==" -ForegroundColor Cyan
Copy-Item -Path "..\web\floating-assistant.js" -Destination "renderer\floating-assistant.js" -Force

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

if (-not $SkipInstall) {
    Write-Host "== npm install ==" -ForegroundColor Cyan
    npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
}

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
Write-Host "== electron-builder: packaging Windows app folder ==" -ForegroundColor Cyan
npx electron-builder --win dir --x64
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "electron-builder failed. If the error mentions 'Cannot create symbolic link' while" -ForegroundColor Yellow
    Write-Host "extracting winCodeSign, that's a Windows permissions issue, not a project bug:" -ForegroundColor Yellow
    Write-Host "enable Developer Mode (Settings > Privacy & security > For developers) and retry," -ForegroundColor Yellow
    Write-Host "or run this script from an elevated (Administrator) PowerShell." -ForegroundColor Yellow
    throw "electron-builder packaging failed"
}

# tw_stock_db客製: 2026-09-16使用者要求「單一執行檔」——build
# launcher/launcher.py成一個獨立、真正是console subsystem的.exe
# （PyInstaller自己的bootloader，不是事後改PE header的byte patch），並用
# --add-data把整個dist\win-unpacked\（剛剛electron-builder產生的完整
# Electron app）打包進這支.exe裡面，PyInstaller的--onefile bootloader
# 會在每次執行時自動解壓縮到一個暫存資料夾再執行——使用者最後只會拿到、
# 只需要執行**這一個檔案**（見launcher/launcher.py開頭的完整說明，包含
# 這個做法「每次啟動都要重新解壓縮~250MB」的已知取捨）。
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
    #
    # --add-data "..\dist\win-unpacked;app" embeds the whole Electron app
    # folder under an "app" subfolder inside the bundle (Windows --add-data
    # syntax is SRC;DEST); launcher.py looks for
    # sys._MEIPASS\app\FloatingAssistantApp.exe at runtime.
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"
    python -m PyInstaller --onefile --console --name FloatingAssistant --add-data "..\dist\win-unpacked;app" --distpath dist --workpath build --specpath . launcher.py 2>&1 | ForEach-Object { Write-Host $_ }
    $ErrorActionPreference = $prevEap
    if ($LASTEXITCODE -ne 0) { throw "PyInstaller build failed" }
} finally {
    Pop-Location
}
Copy-Item -Path "launcher\dist\FloatingAssistant.exe" -Destination "dist\FloatingAssistant.exe" -Force

Write-Host ""
Write-Host "Done. dist\FloatingAssistant.exe is the single file to distribute -" -ForegroundColor Green
Write-Host "double-click it for the GUI, or run it with -p from a terminal for CLI mode." -ForegroundColor Green
Write-Host "(dist\win-unpacked\ is an intermediate build artifact, embedded inside that" -ForegroundColor Green
Write-Host ".exe - you don't need to distribute it separately.)" -ForegroundColor Green
