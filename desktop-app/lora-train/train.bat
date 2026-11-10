@echo off
rem Progressive LoRA training, start to finish (Windows cmd). Usage: train.bat [--name r3] [--epochs 2] [--stages sft,eval_sft,pack] [--force]
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (echo node is required & exit /b 1)
if not exist ".venv\Scripts\python.exe" (
  echo [setup] creating .venv ^(CPU torch; first run downloads ~300 MB^)
  python -m venv .venv || exit /b 1
  .venv\Scripts\python.exe -m pip install -q -U pip || exit /b 1
  .venv\Scripts\python.exe -m pip install -q torch --index-url https://download.pytorch.org/whl/cpu || exit /b 1
  .venv\Scripts\python.exe -m pip install -q -r requirements.txt || exit /b 1
)
.venv\Scripts\python.exe train.py %*
exit /b %ERRORLEVEL%
