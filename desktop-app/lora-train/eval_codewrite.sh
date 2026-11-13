#!/usr/bin/env bash
# code-write（codewrite-r4）評量：基底 vs 微調，eval_gen.py 產生（貪婪、不開思考）＋ score_gen.js 判題（DESIGN.lora-training.md §27.9）。
# 題型：fn_template/code_write_fn（判題器 AC）、fn_template/code_split（拆題）、fn_template/code_write（整份程式）。
cd "$(dirname "$0")"
PY=.venv/bin/python
thr() { if [ "$(date +%H)" -lt 8 ]; then echo 4; else echo 12; fi; }
ST=fn_template/code_write_fn,fn_template/code_split,fn_template/code_write
mkdir -p out/eval
[ -f out/eval/codewrite_base.json ] || LORA_THREADS=$(thr) nice -n 19 $PY eval_gen.py --out out/eval/codewrite_base.json --eval_file data/heldout.jsonl --stages $ST --per_stage 60 > out/eval/codewrite_base.log 2>&1
[ -f out/eval/codewrite_tuned.json ] || LORA_THREADS=$(thr) nice -n 19 $PY eval_gen.py --out out/eval/codewrite_tuned.json --adapter_dir out/multi/codewrite --eval_file data/heldout.jsonl --stages $ST --per_stage 60 > out/eval/codewrite_tuned.log 2>&1
nice -n 19 node score_gen.js out/eval/codewrite_base.json out/eval/codewrite_tuned.json --eval_file data/heldout.jsonl > out/eval/codewrite_scored.txt 2>&1
echo "[eval-codewrite-done] $(date +%F_%T)"
