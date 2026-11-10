#!/usr/bin/env bash
# Progressive LoRA training, start to finish (Linux/macOS/Git-Bash). Usage: ./train.sh [--name r3] [--epochs 2] [--stages sft,eval_sft,pack] [--force]
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
command -v node >/dev/null || { echo "node is required"; exit 1; }
if [ -x .venv/Scripts/python.exe ]; then PY=.venv/Scripts/python.exe; elif [ -x .venv/bin/python ]; then PY=.venv/bin/python; else
  echo "[setup] creating .venv (CPU torch; first run downloads ~300 MB)"; python3 -m venv .venv 2>/dev/null || python -m venv .venv
  PY=$([ -x .venv/Scripts/python.exe ] && echo .venv/Scripts/python.exe || echo .venv/bin/python)
  "$PY" -m pip install -q -U pip; "$PY" -m pip install -q torch --index-url https://download.pytorch.org/whl/cpu; "$PY" -m pip install -q -r requirements.txt
fi
exec "$PY" train.py "$@"
