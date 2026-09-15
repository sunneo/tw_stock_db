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
# getSecrets()). The key value is read only from this build machine's
# environment (FA_BUILTIN_NVAPI_KEY / FA_BUILTIN_OPENROUTER_KEY, e.g. CI
# secrets) - it is never hardcoded in source. If those env vars are unset,
# this writes an empty object, which is a no-op (same behavior as before
# this feature existed).
Write-Host "== Generating builtin-secrets.json (from FA_BUILTIN_NVAPI_KEY / FA_BUILTIN_OPENROUTER_KEY) ==" -ForegroundColor Cyan
$builtinSecrets = @{
    NVAPI_KEY         = if ($env:FA_BUILTIN_NVAPI_KEY) { $env:FA_BUILTIN_NVAPI_KEY } else { "" }
    OPENROUTER_API_KEY = if ($env:FA_BUILTIN_OPENROUTER_KEY) { $env:FA_BUILTIN_OPENROUTER_KEY } else { "" }
}
$builtinSecrets | ConvertTo-Json | Set-Content -Path "builtin-secrets.json" -Encoding utf8

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

Write-Host "== electron-builder: packaging Windows portable executable ==" -ForegroundColor Cyan
npx electron-builder --win portable
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
