#!/usr/bin/env bash
# 建立 LLM（從零開始）：0.6B 真規模的啟動腳本，給 GPU 機器用。這個環境只有 CPU，這裡不執行真規模。
# 設計與限制見 DESIGN.offline-training-studio.md「擴到 0.6B 真規模」。
#
# 用法：
#   PY=/path/to/python bash llm_scratch_realscale.sh preflight
#   PY=/path/to/python bash llm_scratch_realscale.sh prep     <語料資料夾> <工作資料夾>
#   PY=/path/to/python bash llm_scratch_realscale.sh pretrain <工作資料夾> <tokenizer.json>
#   PY=/path/to/python bash llm_scratch_realscale.sh export-hf <工作資料夾>
#
# 注意：
#   - tokenizer.json 應是公開的 Qwen 分詞器（詞彙 151936）。原生執行環境寫死的停止詞元 151645／151643 只存在於該詞彙表。
#   - 語料必須先取得使用者同意才能下載；本腳本只讀你給的資料夾，不下載任何東西。
#   - 學習率與步數是未經實驗的預設猜測，正式跑前要先做小規模掃描。
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PY="${PY:-python}"
S="$HERE/llm_scratch.py"
STAGE="${1:?用法見檔頭}"

# 0.6B 外形：與 Qwen3-0.6B 相同的層數、寬度、頭數（只能用 --layers 等覆寫，不改 preset）
SHAPE=(--preset small --layers 28 --heads 16 --kv-heads 8 --hidden 1024 --intermediate 3072)
# 約 120 億詞元：16 批次 × 2048 序列 = 每步 32768 詞元；12e9 / 32768 ≈ 366,211 步
BATCH=${BATCH:-16}
SEQ=${SEQ:-2048}
STEPS=${STEPS:-366211}
LR=${LR:-0.0003}

case "$STAGE" in
  preflight)
    "$PY" "$S" preflight
    ;;
  prep)
    CORPUS="${2:?缺語料資料夾}"; WORK="${3:?缺工作資料夾}"
    "$PY" "$S" prep --corpus "$CORPUS" --out "$WORK/data"
    ;;
  pretrain)
    WORK="${2:?缺工作資料夾}"; TOK="${3:?缺 tokenizer.json}"
    "$PY" "$S" pretrain --data "$WORK/data" --tok "$TOK" --out "$WORK/base" \
      "${SHAPE[@]}" --steps "$STEPS" --batch "$BATCH" --seq "$SEQ" --lr "$LR" \
      --device cuda --eval-every 2000 --log-every 100
    ;;
  export-hf)
    WORK="${2:?缺工作資料夾}"
    "$PY" "$S" export-hf --model "$WORK/base" --out "$WORK/hf"
    ;;
  *)
    echo "未知階段：$STAGE" >&2; exit 2
    ;;
esac
