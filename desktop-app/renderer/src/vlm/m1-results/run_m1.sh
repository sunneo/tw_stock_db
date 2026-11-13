#!/bin/bash
export NODE_PATH=/home/hungfu.lee/fa-work/ort122/node_modules
B=/home/hungfu.lee/Downloads/SRC/tw_stock_db/.claude/worktrees/vlm-studio/desktop-app/renderer/src/vlm
M=/home/hungfu.lee/fa-work/vlm-studio/florence2
cd /home/hungfu.lee/fa-work/vlm-studio/m1
P=/home/hungfu.lee/fa-work/venv/bin/python
i=0
for img in 000051 000101 000150; do
  $P -W ignore $B/staged_vlm_prep.py $M /home/hungfu.lee/fa-work/vlm-studio/data1/images/$img.png img_$img >/dev/null
  for rep in 1 2; do
    for mode in resident staged; do
      node $B/staged_vlm_bench.js --mode $mode --model-dir $M --input img_$img/input.json --out img_$img/${mode}_$rep.json 2>&1 | tail -1 >> run_m1.log
    done
  done
done
echo M1_DONE >> run_m1.log
