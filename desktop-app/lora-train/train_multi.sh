#!/usr/bin/env bash
# 依序訓練四顆 rank 4 的 LoRA（nice、LORA_THREADS=8）；每顆輸出 out/multi/<id>/，可單顆重跑：./train_multi.sh decompose
cd "$(dirname "$0")"; export LORA_THREADS=${LORA_THREADS:-8}
for g in ${@:-decompose plan colu toolcall}; do
  [ -f out/multi/$g/adapter/adapter_model.safetensors ] && { echo "[skip] $g 已完成"; continue; }
  nice -n 10 .venv/bin/python train_lora.py --model_name_or_path models/Qwen3-0.6B --train_file data/multi/$g.jsonl \
    --output_dir out/multi/$g/adapter --lora_r 4 --lora_alpha 8 --learning_rate 2e-4 --num_train_epochs 2 --val_fraction 0.03 \
    --save_steps 100 --logging_steps 10 > out/multi/$g.log 2>&1 && echo "[done] $g" || echo "[fail] $g"
done
