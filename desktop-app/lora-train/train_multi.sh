#!/usr/bin/env bash
# 四顆 LoRA 整批可接續（DESIGN.lora-training.md §16）：重跑同一指令，已完成的顆跳過，做到一半的顆從最新 checkpoint 續訓。
# 完成判定（§32.1）：只看每一段的 log——有 "[done]" 且沒有 "[paused]" 才算完成。
#   （暫停時 train_lora.py 仍會把目前權重寫到 output_dir 根目錄，所以不能用 adapter_model.safetensors 判定完成。）
# 環境變數：LORA_CORES（預設 0-7）、LORA_THREADS（預設 8）、LORA_SAVE_STEPS（預設 5）、WAIT_PID（先等這個行程結束）、
#           TRAIN_PY（預設 .venv/bin/python；測試用）、TRAIN_DATA_DIR（預設 data/multi）、TRAIN_OUT_ROOT（預設 out/multi）。
cd "$(dirname "$0")"
export LORA_THREADS=${LORA_THREADS:-8} LORA_SEQ=${LORA_SEQ:-768}
CORES=${LORA_CORES:-0-7}; SAVE=${LORA_SAVE_STEPS:-5}
PY=${TRAIN_PY:-.venv/bin/python}; DATA=${TRAIN_DATA_DIR:-data/multi}; ROOT_OUT=${TRAIN_OUT_ROOT:-out/multi}

# 回傳 0＝這一顆已完成（最後一段 log 有 [done] 且沒有 [paused]）
is_complete() {
  local log="$1"
  [ -f "$log" ] && grep -q '^\[done\]' "$log" && ! grep -q '^\[paused\]' "$log"
}

if [ -n "${WAIT_PID:-}" ]; then while kill -0 "$WAIT_PID" 2>/dev/null; do sleep 60; done; fi
for g in ${@:-decompose toolcall plan colu}; do
  dir=$ROOT_OUT/$g/adapter
  mkdir -p "$dir"
  seg=$(( $(ls "$dir"/seg-*.log 2>/dev/null | wc -l) ))
  if [ "$seg" -gt 0 ] && is_complete "$dir/seg-$seg.log"; then echo "[skip] $g 已完成"; continue; fi
  resume=""; last=$(ls -d "$dir"/checkpoint-* 2>/dev/null | sort -V | tail -1)
  if [ -n "$last" ]; then resume="--resume_from_checkpoint $last"; echo "[resume] $g 從 $last"; fi
  seg=$((seg + 1)); log="$dir/seg-$seg.log"
  taskset -c "$CORES" nice -n 10 "$PY" train_lora.py --model_name_or_path models/Qwen3-0.6B --train_file "$DATA/$g.jsonl" \
    --output_dir "$dir" --lora_r 4 --lora_alpha 8 --learning_rate 2e-4 --num_train_epochs 1 --val_fraction 0 \
    --save_steps "$SAVE" --logging_steps 10 $resume > "$log" 2>&1
  rc=$?
  if is_complete "$log"; then echo "[done] $g"
  elif grep -q '^\[paused\]' "$log"; then echo "[paused] $g（seg $seg，下次重跑從 checkpoint 續訓）"
  else echo "[fail] $g rc=$rc（見 $log）"; fi
done
