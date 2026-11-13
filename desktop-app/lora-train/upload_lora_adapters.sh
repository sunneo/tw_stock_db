#!/usr/bin/env bash
# 上傳內建 LoRA 到 lora-adapters 分支：只做 dry-run（DESIGN.lora-training.md §32.3）。
# 不 push、不建立分支、不改任何 git 狀態；只核對暫存目錄並印出總指揮要執行的指令。
# 用法：bash lora-train/upload_lora_adapters.sh <暫存目錄（build_builtin.js 的輸出）> [--apply]
#   --apply 會被拒絕：推送由總指揮核對大小後自己執行。
set -u
cd "$(dirname "$0")/.."
STAGE=${1:-}; MODE=${2:-}
[ -n "$STAGE" ] && [ -f "$STAGE/builtin.json" ] || { echo "用法：bash lora-train/upload_lora_adapters.sh <暫存目錄>（需含 builtin.json）"; exit 2; }
if [ "$MODE" = "--apply" ]; then echo "拒絕：本腳本只做 dry-run。推送請總指揮核對後自行執行（見下方指令）。"; exit 3; fi
bad=0
for d in "$STAGE"/*/; do
  id=$(basename "$d")
  if (cd "$d" && node join.js >/dev/null 2>&1); then
    echo "[ok] $id：分片可重組，sha256 核對通過"; rm -f "$d/$id.fatrain"
  else echo "[FAIL] $id：分片重組失敗"; bad=1; fi
done
echo "--- 暫存目錄大小 ---"; du -sh "$STAGE"; find "$STAGE" -type f | wc -l | xargs echo "檔案數："
if grep -q '<COMMIT>' "$STAGE/builtin.json"; then echo "[注意] builtin.json 的 base_url 還是 <COMMIT>：推送後要把它換成實際的 commit 再推第二次（或改用分支名）。"; fi
cat <<CMDS
--- 計畫中的指令（dry-run，未執行）---
  git fetch origin lora-adapters
  git worktree add /home/hungfu.lee/fa-work/lora-adapters-upload origin/lora-adapters   # 只在暫存的 worktree 操作，不動本分支
  cp -r "$STAGE"/* /home/hungfu.lee/fa-work/lora-adapters-upload/                      # builtin.json、各 <id>/ 資料夾
  git -C /home/hungfu.lee/fa-work/lora-adapters-upload add -A && git -C /home/hungfu.lee/fa-work/lora-adapters-upload commit -m "內建 LoRA 六顆（fa-lora-builtin v1）"
  git -C /home/hungfu.lee/fa-work/lora-adapters-upload push origin HEAD:lora-adapters   # 總指揮執行
  git worktree remove /home/hungfu.lee/fa-work/lora-adapters-upload
CMDS
exit $bad
