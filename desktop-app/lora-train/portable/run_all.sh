#!/usr/bin/env bash
# Portable run: venv -> base model -> data -> SFT -> eval -> DPO -> eval -> one result archive. Resumable per stage; logs in $WORK/logs.
#   tar xzf lora-bundle.tar.gz && bash lora-train/portable/run_all.sh
#   STAGES="sft eval_sft pack" ./run_all.sh   only these     (see config.env for every knob)
# eval_run.py compares base vs tuned in ONE pass (identical rows), so there is no separate base-eval stage.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; LORA="$(cd "$HERE/.." && pwd)"; cd "$LORA"
source "$HERE/config.env"; export LORA_THREADS LORA_BATCH LORA_SEQ LORA_EVAL_EVERY LORA_EVAL_BATCH SFT_EPOCHS DPO_MAX DPO_EPOCHS
mkdir -p "$WORK"/{logs,done,res,adapters}; PY="$WORK/venv/bin/python"; BASE="${BASE_DIR:-$WORK/base}"
log() { echo "[$(date '+%F %T')] $*" | tee -a "$WORK/logs/run_all.log"; }
has() { [[ " $STAGES " == *" $1 "* ]]; }
stage() { local n="$1"; shift; has "$n" || return 0; [[ -f "$WORK/done/$n" ]] && { log "skip $n (done)"; return 0; }; log "== $n"; local t0=$SECONDS; "$@" > >(tee -a "$WORK/logs/$n.log") 2>&1; touch "$WORK/done/$n"; log "== $n finished in $(( (SECONDS - t0) / 60 )) min"; }
log "machine: $(nproc) cores, $(free -g | awk '/Mem:/{print $2}') GB RAM, threads=$LORA_THREADS; WORK=$WORK"
[[ $(free -g | awk '/Mem:/{print $7}') -lt 16 ]] && log "WARNING: < 16 GB available RAM; use LORA_BATCH=1 LORA_SEQ=768 or the run may be killed"
s_setup() { python3 -m venv "$WORK/venv"; "$WORK/venv/bin/pip" install -q -U pip; "$WORK/venv/bin/pip" install -q torch==2.15.0 --index-url https://download.pytorch.org/whl/cpu; "$WORK/venv/bin/pip" install -q -r "$HERE/requirements.txt"; "$PY" -c "import torch,transformers,peft;print(torch.__version__,transformers.__version__,peft.__version__)"; }
s_base() { if [[ -n "$BASE_DIR" ]]; then echo "using $BASE_DIR"; else "$PY" -c "from huggingface_hub import snapshot_download as d; d('Qwen/Qwen3-0.6B', local_dir='$WORK/base')"; fi; ls -la "$BASE"; }   # ~1.2 GB from huggingface.co (Apache-2.0)
s_data() { [[ -f "$TRAIN_FILE" && -f "$EVAL_FILE" ]] || { echo "missing $TRAIN_FILE / $EVAL_FILE in $LORA"; exit 1; }; sha256sum "$TRAIN_FILE" "$EVAL_FILE"; wc -l "$TRAIN_FILE" "$EVAL_FILE"; "$PY" "$HERE/estimate.py" "$TRAIN_FILE" "$EVAL_FILE" "$BASE"; }
s_sft() { "$PY" train_lora.py --model_name_or_path "$BASE" --train_file "$TRAIN_FILE" --output_dir "$WORK/adapters/sft" --num_train_epochs "$SFT_EPOCHS" --per_device_train_batch_size "$LORA_BATCH" --gradient_accumulation_steps "$SFT_ACCUM" --learning_rate "$SFT_LR" --max_seq_len "$LORA_SEQ" --logging_steps 5; }
s_eval_sft() { "$PY" eval_run.py --base "$BASE" --adapter_dir "$WORK/adapters/sft" --eval_file "$EVAL_FILE" --json_out "$WORK/res/eval_sft.json" | tee "$WORK/res/eval_sft.txt"; }
s_dpo() {
  if ! grep -q '"rejected"' "$TRAIN_FILE"; then echo "no rejected rows in $TRAIN_FILE: skipping DPO (dpo adapter = sft adapter)"; mkdir -p "$WORK/adapters/dpo"; cp -r "$WORK/adapters/sft/." "$WORK/adapters/dpo/"; return; fi
  LORA_BATCH="$LORA_DPO_BATCH" "$PY" train_dpo.py --base "$BASE" --adapter_dir "$WORK/adapters/sft" --train_file "$TRAIN_FILE" --output_dir "$WORK/adapters/dpo" --epochs "$DPO_EPOCHS" --lr "$DPO_LR" --beta "$DPO_BETA" --max_pairs "$DPO_MAX"
}
s_eval_dpo() { "$PY" eval_run.py --base "$BASE" --adapter_dir "$WORK/adapters/dpo" --eval_file "$EVAL_FILE" --json_out "$WORK/res/eval_dpo.json" | tee "$WORK/res/eval_dpo.txt"; }
s_pack() { cp "$HERE/config.env" "$WORK/res/"; sha256sum "$TRAIN_FILE" "$EVAL_FILE" > "$WORK/res/data.sha256"; local out="$WORK/lora-results-$(hostname)-$(date +%Y%m%d-%H%M).tar.gz"; tar -C "$WORK" -czf "$out" adapters res logs; sha256sum "$out"; ls -la "$out"; echo "copy back: $out"; }
stage setup s_setup; stage base s_base; stage data s_data; stage sft s_sft; stage eval_sft s_eval_sft; stage dpo s_dpo; stage eval_dpo s_eval_dpo; stage pack s_pack
log "all requested stages done"
