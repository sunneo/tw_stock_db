# Progressive LoRA training, start to finish (PowerShell). Usage: .\train.ps1 [--name r3] [--epochs 2] [--stages sft,eval_sft,pack] [--force]
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node is required' }
$py = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path $py)) {
  Write-Host '[setup] creating .venv (CPU torch; first run downloads ~300 MB)'
  python -m venv .venv
  & $py -m pip install -q -U pip
  & $py -m pip install -q torch --index-url https://download.pytorch.org/whl/cpu
  & $py -m pip install -q -r requirements.txt
}
& $py train.py @args
exit $LASTEXITCODE
