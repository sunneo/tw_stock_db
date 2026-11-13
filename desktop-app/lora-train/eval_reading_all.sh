#!/usr/bin/env bash
# 閱讀理解評量（DESIGN.lora-training.md §27.9.4）：基底與 reading 微調，同一批留出題。
cd "$(dirname "$0")"
thr() { if [ "$(date +%H)" -lt 8 ]; then echo 4; else echo 12; fi; }
[ -f out/eval/rc_base.json ] || LORA_THREADS=$(thr) nice -n 19 .venv/bin/python eval_reading.py --eval_file data/reading_heldout.jsonl --per_stage 60 --out out/eval/rc_base.json > out/eval/rc_base.log 2>&1
[ -f out/eval/rc_tuned.json ] || LORA_THREADS=$(thr) nice -n 19 .venv/bin/python eval_reading.py --adapter_dir out/multi/reading --eval_file data/reading_heldout.jsonl --per_stage 60 --out out/eval/rc_tuned.json > out/eval/rc_tuned.log 2>&1
echo "[eval-reading-done] $(date +%F_%T)"
