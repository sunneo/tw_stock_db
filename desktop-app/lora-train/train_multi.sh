#!/usr/bin/env bash
# 四顆 LoRA 整批可接續（DESIGN.lora-training.md §16）：重跑同一指令，已完成的顆跳過，做到一半的顆從最新 checkpoint 續訓。
# 環境變數：LORA_CORES（預設 0-7）、LORA_THREADS（預設 8）、LORA_SAVE_STEPS（預設 5）、WAIT_PID（先等這個行程結束）。
cd "$(dirname "$0")"
export LORA_THREADS=${LORA_THREADS:-8} LORA_SEQ=${LORA_SEQ:-768}
CORES=${LORA_CORES:-0-7}; SAVE=${LORA_SAVE_STEPS:-5}
if [ -n "${WAIT_PID:-}" ]; then while kill -0 "$WAIT_PID" 2>/dev/null; do sleep 60; done; fi
for g in ${@:-decompose toolcall plan colu}; do
  dir=out/multi/$g/adapter
  if [ -f "$dir/adapter_model.safetensors" ]; then echo "[skip] $g 已完成"; continue; fi
  resume=""; last=$(ls -d "$dir"/checkpoint-* 2>/dev/null | sort -V | tail -1)
  if [ -n "$last" ]; then resume="--resume_from_checkpoint $last"; echo "[resume] $g 從 $last"; fi
  taskset -c "$CORES" nice -n 10 .venv/bin/python train_lora.py --model_name_or_path models/Qwen3-0.6B --train_file data/multi/$g.jsonl \
    --output_dir "$dir" --lora_r 4 --lora_alpha 8 --learning_rate 2e-4 --num_train_epochs 1 --val_fraction 0 \
    --save_steps "$SAVE" --logging_steps 10 $resume >> out/multi/$g.log 2>&1 && echo "[done] $g" || echo "[fail] $g"
done
