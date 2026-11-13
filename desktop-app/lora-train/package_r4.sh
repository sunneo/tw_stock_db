#!/usr/bin/env bash
# 打包成工作室可匯入的 .fatrain（DESIGN.lora-training.md §27.8）：
# PEFT adapter → 槽版 lora.bin（make_lora_onnx.py pack，layout 來自 lora-slot-build.js）→ pack_adapter.js（描述檔＋卡片）→ build-lora-asset.js（.fatrain）。
# 用法：bash package_r4.sh <adapter 名稱> <R> <id 同 R> <domains> <triggers>
cd "$(dirname "$0")"
PY=.venv/bin/python
ROOT=$(cd .. && pwd)
g=$1; R=$2; DOM=$3; TRIG=$4
OUT=/home/hungfu.lee/fa-work/assets
mkdir -p "$OUT"
# 評量 → 描述檔格式（adapter＝微調通過數，base＝基底通過數）
$PY -c "
import json,sys
e=json.load(open('out/eval/$R.json'))
g={k:{'adapter':v['tuned'],'base':v['base'],'n':v['n']} for k,v in e['groups'].items()}
json.dump({'groups':g},open('out/eval/$R.groups.json','w'),ensure_ascii=False,indent=1)
print('groups',len(g))
" || exit 1
rm -rf "out/release/$R"
node pack_adapter.js "out/multi/$g" "$R" "out/eval/$R.groups.json" --id "$R" --version 1.0.0 --name "$R" \
  --domains "$DOM" --triggers "$TRIG" --pf 1 --card "cards/$R.json" || exit 1
# 描述檔的 prompt_format_version 要是數字 1（app 的 LORA_ENV 是數字）
node -e "const f='out/release/$R/lora.descriptor.json';const d=require(''+require('path').resolve(f));d.prompt_format_version=1;require('fs').writeFileSync(f,JSON.stringify(d,null,2));"
# 槽版 lora.bin（rank 16 槽，alpha/r 折進 B）
cp -f /home/hungfu.lee/fa-work/slot-base/layout.json out/slot-layout.json
$PY make_lora_onnx.py pack "out/multi/$g" out/slot-layout.json "out/release/$R/lora.bin" || exit 1
# .fatrain
( cd "$ROOT" && node scripts/build-lora-asset.js "lora-train/out/release/$R" "lora-train/out/release/$R/lora.bin" "$OUT" ) || exit 1
echo "[packaged] $R -> $OUT"
