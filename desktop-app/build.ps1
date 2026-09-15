# FloatingAssistant桌面版 - Windows打包腳本
# 產生單一GUI執行檔（electron-builder的portable target），不需要安裝、
# 雙擊就能跑。用法：
#   .\build.ps1            # 完整流程：同步引擎 + npm install + 打包
#   .\build.ps1 -SkipInstall  # 跳過npm install（node_modules已存在時可加速）
param(
    [switch]$SkipInstall
)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "== 同步 floating-assistant.js（canonical來源：..\web\floating-assistant.js）==" -ForegroundColor Cyan
Copy-Item -Path "..\web\floating-assistant.js" -Destination "renderer\floating-assistant.js" -Force

if (-not $SkipInstall) {
    Write-Host "== npm install ==" -ForegroundColor Cyan
    npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install 失敗" }
}

Write-Host "== electron-builder 打包 Windows portable 執行檔 ==" -ForegroundColor Cyan
npx electron-builder --win portable
if ($LASTEXITCODE -ne 0) { throw "electron-builder 打包失敗" }

Write-Host ""
Write-Host "完成！執行檔在 dist\ 目錄底下（*.exe，單一檔案、免安裝）。" -ForegroundColor Green
