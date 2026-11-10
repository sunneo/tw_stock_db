#!/usr/bin/env bash
# Build ONE file to copy to the other machine: scripts + data (no model, no venv, no outputs).
#   bash lora-train/portable/make_bundle.sh [out.tar.gz]     default: lora-train/portable/lora-bundle.tar.gz (+ .sha256). Not in git.
set -euo pipefail
LORA="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; OUT="${1:-$LORA/portable/lora-bundle.tar.gz}"; mkdir -p "$(dirname "$OUT")"
N="$(basename "$LORA")"
( cd "$(dirname "$LORA")" && tar -czf "$OUT" \
  $N/lora_common.py $N/train_lora.py $N/train_dpo.py $N/eval_run.py $N/eval_adapter.py $N/merge_and_export.py $N/requirements.txt $N/schema.md \
  $N/portable/run_all.sh $N/portable/config.env $N/portable/estimate.py $N/portable/requirements.txt $N/portable/make_bundle.sh \
  $N/data/train.jsonl $N/data/heldout.jsonl )
sha256sum "$OUT" | tee "$OUT.sha256"; ls -la "$OUT"
