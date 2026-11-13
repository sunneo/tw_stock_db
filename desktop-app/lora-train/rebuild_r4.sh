#!/usr/bin/env bash
# 四顆 r4 從零重建的訓練控制器（DESIGN.lora-training.md §27.8）。
# 可重跑：已完成的顆（out/multi/<name>/DONE）跳過；做到一半的顆從最新 checkpoint 續訓。
# 執行緒與優先序（共用伺服器）：一律 nice -n 19；08:00 以前最多 4 個執行緒，08:00 以後 12 個。
# 時段改變時，控制器建立 STOP 檔（train_lora.py 存檢查點後停），然後以新執行緒數從 checkpoint 續訓。
# 用法：bash rebuild_r4.sh [decompose_v2 toolcall plan colu]
cd "$(dirname "$0")"
PY=.venv/bin/python
ALL="decompose_v2 toolcall plan colu"
WANT=${@:-$ALL}

thr() { if [ "$(date +%H)" -lt 8 ]; then echo 4; else echo 12; fi; }

# 每顆的訓練資料（由 build_r4_data.sh 產生）
dataset() {
  case "$1" in
    decompose_v2) echo data/multi/decompose_v2.jsonl ;;
    toolcall)     echo data/multi/toolcall.jsonl ;;
    plan)         echo data/multi/plan.jsonl ;;
    colu)         echo data/multi/colu.jsonl ;;
  esac
}

train_one() {
  local name=$1 train_file=$2 dir=out/multi/$1
  mkdir -p "$dir"
  while [ ! -f "$dir/DONE" ]; do
    local t last res="" seg
    t=$(thr)
    last=$(ls -d "$dir"/checkpoint-* 2>/dev/null | sort -V | tail -1)
    [ -n "$last" ] && res="--resume_from_checkpoint $last"
    seg=$(( $(ls "$dir"/seg-*.log 2>/dev/null | wc -l) + 1 ))
    echo "[start] $name seg=$seg threads=$t resume=${last:-none} $(date +%F_%T)"
    LORA_THREADS=$t LORA_SEQ=768 nice -n 19 $PY train_lora.py \
      --model_name_or_path models/Qwen3-0.6B --train_file "$train_file" --output_dir "$dir" \
      --lora_r 4 --lora_alpha 8 --learning_rate 2e-4 --num_train_epochs 1 --val_fraction 0 \
      --per_device_train_batch_size 1 --gradient_accumulation_steps 8 \
      --save_steps 10 --logging_steps 10 --stop_file "$dir/STOP" $res > "$dir/seg-$seg.log" 2>&1 &
    local pid=$!
    while kill -0 "$pid" 2>/dev/null; do
      sleep 60
      if [ "$(thr)" != "$t" ]; then touch "$dir/STOP"; fi
    done
    wait "$pid"
    rm -f "$dir/STOP"
    if grep -q '^\[paused\]' "$dir/seg-$seg.log"; then
      echo "[paused] $name seg=$seg（時段換執行緒，續訓）"
      continue
    fi
    if grep -q '^\[done\]' "$dir/seg-$seg.log"; then
      touch "$dir/DONE"; echo "[done] $name $(date +%F_%T)"; return 0
    fi
    echo "[fail] $name seg=$seg，見 $dir/seg-$seg.log"; return 1
  done
  echo "[skip] $name 已完成"
}

for g in $WANT; do
  train_one "$g" "$(dataset "$g")" || { echo "[stop] 停在 $g"; exit 1; }
done
echo "[all-done] $WANT $(date +%F_%T)"
