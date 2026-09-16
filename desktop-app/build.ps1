# FloatingAssistant desktop build script (Windows).
# Produces a single portable GUI executable via electron-builder's
# "portable" target - no installer, just run the .exe.
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
Write-Host "== electron-builder: packaging Windows portable executable ==" -ForegroundColor Cyan
npx electron-builder --win portable --x64
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "electron-builder failed. If the error mentions 'Cannot create symbolic link' while" -ForegroundColor Yellow
    Write-Host "extracting winCodeSign, that's a Windows permissions issue, not a project bug:" -ForegroundColor Yellow
    Write-Host "enable Developer Mode (Settings > Privacy & security > For developers) and retry," -ForegroundColor Yellow
    Write-Host "or run this script from an elevated (Administrator) PowerShell." -ForegroundColor Yellow
    throw "electron-builder packaging failed"
}

Write-Host ""
Write-Host "Done. The executable is in dist\ (single .exe, no installation needed)." -ForegroundColor Green
