#!/usr/bin/env bash
# 四顆 r4 的評量（基底 vs 微調，同一批留出列，DESIGN.lora-training.md §27.8）。
# 用法：bash eval_r4.sh <adapter 名稱>…；已有結果（out/eval/<R>.json）就跳過。
cd "$(dirname "$0")"
PY=.venv/bin/python
thr() { if [ "$(date +%H)" -lt 8 ]; then echo 4; else echo 12; fi; }
mkdir -p out/eval
for g in "$@"; do
  case "$g" in
    decompose_v2) R=decompose-r4-v2; MAX=360 ;;
    toolcall)     R=toolcall-r4;     MAX=110 ;;
    plan)         R=plan-r4;         MAX=360 ;;
    colu)         R=colu-r4;         MAX=110 ;;
  esac
  if [ -f out/eval/$R.json ]; then echo "[skip] $R 已評量"; continue; fi
  echo "[eval-start] $R threads=$(thr) $(date +%F_%T)"
  LORA_THREADS=$(thr) LORA_EVAL_BATCH=8 nice -n 19 $PY eval_run.py --adapter_dir out/multi/$g \
    --eval_file data/eval_$R.jsonl --max_new $MAX --json_out out/eval/$R.json > out/eval/$R.log 2>&1
  echo "[eval-end] $R rc=$? $(date +%F_%T)"
done
