"""
把台股資料同步到 GitHub（sunneo/tw_stock_db），供其他 Claude 對話 clone/讀取。

因為 tw_stock.db 高達 300MB+，超過 GitHub 100MB 單檔上限（需要 Git LFS），
而 LFS 免費額度只有每月 1GB 儲存 + 1GB 頻寬，若每天都整包推送完整 db 會在
幾天內就用光額度。因此拆成兩條路：

1. 每天：只匯出「當天」新增的資料（daily_prices/technical_indicators/market_index
   當日筆數 + 全量 stocks 清單），檔案僅數百KB，推到 main 分支，用一般 commit
   （保留逐日歷史，方便回溯任何一天的資料）。

2. 每月第一次執行時：把完整 tw_stock.db 複製到獨立的 db-snapshot 分支，
   用 orphan commit + force push 整個覆蓋掉該分支的歷史，讓這個分支永遠
   只有「一個」commit、只保留最新一份快照，避免 Git LFS 儲存額度被歷史版本
   越疊越多吃光。

兩個分支各自對應一個獨立的本地 clone（見 config.py 的 GITHUB_SYNC_MAIN_REPO /
GITHUB_SYNC_SNAPSHOT_REPO），這樣每月覆蓋 db-snapshot 分支時，不會動到
main 分支的逐日歷史工作目錄。

用法：
    python sync/sync_to_github.py
"""
import os
import sys
import json
import shutil
import subprocess

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from config import (
    DB_PATH,
    GITHUB_SYNC_MAIN_REPO,
    GITHUB_SYNC_SNAPSHOT_REPO,
    SYNC_STATE_PATH,
)
from sync.export_daily_delta import export_delta

import sqlite3


def run(args, cwd, check=True):
    print(f"$ {' '.join(args)}  (cwd={cwd})")
    result = subprocess.run(args, cwd=cwd, capture_output=True, text=True)
    if result.stdout.strip():
        print(result.stdout)
    if result.returncode != 0:
        print(result.stderr)
        if check:
            raise RuntimeError(f"指令失敗：{' '.join(args)}")
    return result


def get_latest_trade_date() -> str:
    conn = sqlite3.connect(DB_PATH)
    try:
        cur = conn.cursor()
        cur.execute("SELECT MAX(trade_date) FROM technical_indicators")
        (date_str,) = cur.fetchone()
        if not date_str:
            raise RuntimeError("technical_indicators 是空的，請先跑過每日更新流程")
        return date_str
    finally:
        conn.close()


def load_state() -> dict:
    if os.path.exists(SYNC_STATE_PATH):
        with open(SYNC_STATE_PATH, encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_state(state: dict):
    with open(SYNC_STATE_PATH, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)


def sync_daily_delta(trade_date: str):
    repo = GITHUB_SYNC_MAIN_REPO
    if not os.path.isdir(os.path.join(repo, ".git")):
        raise RuntimeError(f"{repo} 不是 git repo，請先手動 clone 一次 main 分支")

    run(["git", "checkout", "main"], repo)
    run(["git", "pull", "--ff-only", "origin", "main"], repo)

    out_dir = os.path.join(repo, "daily", trade_date)
    print(f"匯出 {trade_date} 的增量資料到 {out_dir} ...")
    export_delta(DB_PATH, trade_date, out_dir)

    run(["git", "add", f"daily/{trade_date}"], repo)
    diff = run(["git", "diff", "--cached", "--quiet"], repo, check=False)
    if diff.returncode == 0:
        print(f"{trade_date} 沒有資料變化，略過 commit/push")
        return

    run(["git", "commit", "-m", f"daily update {trade_date}"], repo)
    run(["git", "push", "origin", "main"], repo)
    print(f"已推送 {trade_date} 的每日增量資料到 main 分支")


def sync_full_snapshot(month_label: str):
    repo = GITHUB_SYNC_SNAPSHOT_REPO
    if not os.path.isdir(os.path.join(repo, ".git")):
        raise RuntimeError(f"{repo} 不是 git repo，請先手動 clone 一次")

    db_dest = os.path.join(repo, "tw_stock.db")
    print(f"複製完整 tw_stock.db 到 {db_dest} ...")
    shutil.copy2(DB_PATH, db_dest)

    gitattributes = os.path.join(repo, ".gitattributes")
    with open(gitattributes, "w", encoding="utf-8") as f:
        f.write("*.db filter=lfs diff=lfs merge=lfs -text\n")

    readme = os.path.join(repo, "README.md")
    with open(readme, "w", encoding="utf-8") as f:
        f.write(
            "# tw_stock.db 完整快照\n\n"
            f"本分支（db-snapshot）只保留**最新一份**完整資料庫快照，"
            f"每月由排程腳本 force push 覆蓋，歷史不保留（避免 Git LFS 額度被吃光）。\n\n"
            f"最後更新：{month_label}\n\n"
            "逐日增量資料與完整說明請見 main 分支的 SKILL.md。\n"
        )

    tmp_branch = "tmp-snapshot"
    run(["git", "checkout", "--orphan", tmp_branch], repo)
    run(["git", "rm", "-rf", "--cached", "."], repo, check=False)
    run(["git", "add", "tw_stock.db", ".gitattributes", "README.md"], repo)
    run(["git", "commit", "-m", f"Full snapshot {month_label}"], repo)
    run(["git", "branch", "-D", "db-snapshot"], repo, check=False)
    run(["git", "branch", "-m", tmp_branch, "db-snapshot"], repo)
    run(["git", "push", "--force", "origin", "db-snapshot:db-snapshot"], repo)
    print(f"已用 force push 覆蓋 db-snapshot 分支（{month_label} 快照）")


def main():
    trade_date = get_latest_trade_date()
    month_label = trade_date[:7]  # YYYY-MM

    sync_daily_delta(trade_date)

    state = load_state()
    if state.get("last_full_push_month") != month_label:
        sync_full_snapshot(month_label)
        state["last_full_push_month"] = month_label
        save_state(state)
    else:
        print(f"本月（{month_label}）已推送過完整快照，略過")


if __name__ == "__main__":
    main()
