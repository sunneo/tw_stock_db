# 把佔 C: 的大資料夾搬到 E:，原位置留 junction（Android 資料夾就是這樣做的）。
# 用法（在「Claude 完全關閉」之後，用獨立的 PowerShell 視窗執行；不需要系統管理員）：
#   powershell -ExecutionPolicy Bypass -File move-to-e.ps1            # 預設只預覽（不動任何檔案）
#   powershell -ExecutionPolicy Bypass -File move-to-e.ps1 -Apply     # 真的搬
#   加 -Only 1,2 可以只做第幾項（編號見預覽輸出）
# 做法：robocopy 複製 → 比對檔案數與大小 → 原資料夾改名成 .old → 建 junction → 驗證。
# 不會刪除 .old；確認 Claude 與桌面版都正常後，自己手動刪。
param([switch]$Apply, [int[]]$Only)
$ErrorActionPreference = 'Stop'
$u = $env:USERPROFILE
$items = @(
    @{ Src = "$u\.claude";                                  Dst = 'E:\AppLocal\dot-claude' },
    @{ Src = "$u\AppData\Roaming\floating-assistant-desktop"; Dst = 'E:\AppLocal\floating-assistant-desktop' },
    @{ Src = "$u\AppData\Local\Claude-Data";                Dst = 'E:\AppLocal\Claude-Data' }
)

function Get-DirStat($p) {
    $m = Get-ChildItem -LiteralPath $p -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum
    [pscustomobject]@{ Count = [int]$m.Count; Bytes = [int64]$m.Sum }
}

# 1. 先決條件
$vol = Get-Volume -DriveLetter E -ErrorAction SilentlyContinue
if (-not $vol) { throw 'E: 磁碟不存在。' }
if ($vol.FileSystem -ne 'NTFS') { throw "E: 是 $($vol.FileSystem)，junction 需要 NTFS。" }
Write-Host ("E: 剩餘 {0:N1} GB（NTFS）" -f ($vol.SizeRemaining / 1GB))

$busy = Get-CimInstance Win32_Process | Where-Object {
    $_.ProcessId -ne $PID -and (
        $_.Name -match '^(claude|Claude|FloatingAssistantApp|chrome-native-host|windows-mcp|uv)\.exe$' -or
        ($_.ExecutablePath -and $_.ExecutablePath -like "*\Claude-Data\*"))
}
if ($busy) {
    Write-Host '下列行程還在用這些資料夾，請先把 Claude（含系統匣圖示）與桌面版完全關閉：' -ForegroundColor Yellow
    $busy | Group-Object Name | ForEach-Object { Write-Host ("  {0} x{1}" -f $_.Name, $_.Count) }
    if ($Apply) { throw '有行程還在跑，沒有動任何檔案。' }
}

# 2. 逐項處理
$n = 0
foreach ($it in $items) {
    $n++
    if ($Only -and ($Only -notcontains $n)) { continue }
    $src = $it.Src; $dst = $it.Dst
    Write-Host "`n[$n] $src -> $dst"
    if (-not (Test-Path -LiteralPath $src)) { Write-Host '  來源不存在，略過。'; continue }
    $si = Get-Item -LiteralPath $src -Force
    if ($si.Attributes -band [IO.FileAttributes]::ReparsePoint) { Write-Host "  已經是 junction（$($si.Target)），略過。"; continue }
    $before = Get-DirStat $src
    Write-Host ("  大小 {0:N2} GB、{1} 個檔案" -f ($before.Bytes / 1GB), $before.Count)
    if (Test-Path -LiteralPath $dst) { throw "  目的地已存在：$dst。請先確認內容再處理，沒有動任何東西。" }
    if (-not $Apply) { Write-Host '  （預覽）會複製、改名成 .old、建 junction。'; continue }

    New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
    robocopy $src $dst /E /COPYALL /DCOPY:DAT /XJ /R:1 /W:1 /NFL /NDL /NP /NJH | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "  robocopy 失敗（結束碼 $LASTEXITCODE），原資料夾沒動。" }
    $after = Get-DirStat $dst
    if ($after.Count -ne $before.Count -or $after.Bytes -ne $before.Bytes) {
        throw ("  複製後不一致：來源 {0} 檔 {1} 位元組、目的 {2} 檔 {3} 位元組。原資料夾沒動，請手動檢查 {4}" -f $before.Count, $before.Bytes, $after.Count, $after.Bytes, $dst)
    }
    $old = "$src.old"
    if (Test-Path -LiteralPath $old) { throw "  $old 已存在，請先處理。" }
    Rename-Item -LiteralPath $src -NewName (Split-Path $old -Leaf)
    cmd /c mklink /J "`"$src`"" "`"$dst`"" | Out-Null
    $ji = Get-Item -LiteralPath $src -Force
    if (-not ($ji.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        Rename-Item -LiteralPath $old -NewName (Split-Path $src -Leaf)
        throw '  junction 建立失敗，已把原資料夾改回來。'
    }
    Write-Host "  完成：$src 現在是 junction，指向 $dst；舊資料留在 $old（確認正常後再手動刪除）。" -ForegroundColor Green
}
if (-not $Apply) { Write-Host "`n以上只是預覽。確認 Claude 已完全關閉後，加 -Apply 再執行一次。" }
