#!/usr/bin/env bash
# 訓練（rebuild_r4.sh）全部完成後：逐顆評量（eval_r4.sh）並打包成 .fatrain（package_r4.sh）。
# 依序執行，不與訓練同時跑（執行緒上限）。已完成的步驟會跳過。
cd "$(dirname "$0")"
while pgrep -f "^bash rebuild_r4[.]sh" >/dev/null 2>&1; do sleep 60; done
for g in decompose_v2 toolcall plan colu; do
  [ -f out/multi/$g/DONE ] || { echo "[missing] $g 沒有 DONE"; continue; }
  bash eval_r4.sh $g
  case $g in
    decompose_v2) bash package_r4.sh $g decompose-r4-v2 decompose '拆|分解|拆題|切割|函式|functions|UML|子問題' ;;
    toolcall)     bash package_r4.sh $g toolcall-r4 toolcall '工具|呼叫|tool|function call|參數' ;;
    plan)         bash package_r4.sh $g plan-r4 plan '計畫|規劃|plan|審查|驗證' ;;
    colu)         bash package_r4.sh $g colu-r4 colu '選單|字母|選哪|CoLU|colu' ;;
  esac
done
echo "[finish-all] $(date +%F_%T)"
