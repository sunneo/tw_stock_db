#!/usr/bin/env bash
# 可接續訓練的實測（DESIGN.lora-training.md §16）：A 一次跑完；B 跑到第 4 步中途被 kill -9；C 從 B 的 checkpoint-3 續訓。
# 通過條件：A 與 B 的前 6 個 micro-batch 雜湊相同；C 的 micro-batch 雜湊等於 A 第 4–6 步；C 的 loss（第 4–6 步）等於 A。
set -u; cd "$(dirname "$0")"
T=out/test_resume; rm -rf $T; mkdir -p $T
head -n 48 data/multi/decompose.jsonl > data/multi/resume_test.jsonl
COMMON="--model_name_or_path models/Qwen3-0.6B --train_file data/multi/resume_test.jsonl --lora_r 4 --lora_alpha 8 --learning_rate 2e-4 \
  --per_device_train_batch_size 1 --gradient_accumulation_steps 2 --max_seq_len 256 --max_steps 6 --save_steps 3 --logging_steps 1 --val_fraction 0.0"
export LORA_THREADS=4 LORA_SEQ=256
run() { taskset -c 12-15 .venv/bin/python train_lora.py $COMMON --output_dir $T/$1 "${@:2}"; }
echo "[A] uninterrupted"; LORA_TRACE_FILE=$T/traceA.txt run A > $T/A.log 2>&1; echo "A exit $?"
echo "[B] run then kill -9 mid step 4"
LORA_TRACE_FILE=$T/traceB.txt run B > $T/B.log 2>&1 & PB=$!
while [ ! -d $T/B/checkpoint-3 ] || [ "$(wc -l < $T/traceB.txt 2>/dev/null || echo 0)" -lt 8 ]; do sleep 2; kill -0 $PB 2>/dev/null || break; done
pkill -9 -P $PB 2>/dev/null; kill -9 $PB 2>/dev/null; wait $PB 2>/dev/null; echo "B killed; trace lines $(wc -l < $T/traceB.txt)"; ls $T/B
echo "[C] resume from checkpoint-3"
LORA_TRACE_FILE=$T/traceC.txt run C --resume_from_checkpoint $T/B/checkpoint-3 > $T/C.log 2>&1; echo "C exit $?"
.venv/bin/python - <<PY
import json
T="$T"
a=open(T+"/traceA.txt").read().split(); b=open(T+"/traceB.txt").read().split(); c=open(T+"/traceC.txt").read().split()
print("A micro-batches", len(a), "B", len(b), "C", len(c), "(first 12 = training; trailing extra = prefetch, see DESIGN §16)")
print("B[:6]==A[:6]:", b[:6]==a[:6])
print("C[:6]==A[6:12] (steps 4-6, same micro-batches, no dup/no skip):", c[:6]==a[6:12])
def losses(p):
    st=json.load(open(p))
    return {h["step"]:round(h["loss"],6) for h in st["log_history"] if "loss" in h}
la=losses(T+"/A/checkpoint-6/trainer_state.json"); lc=losses(T+"/C/checkpoint-6/trainer_state.json")
print("A loss", la); print("C loss", lc)
print("loss steps 4-6 equal:", all(abs(la.get(s,-1)-lc.get(s,-2))<1e-4 for s in (4,5,6)))
PY
echo DONE
