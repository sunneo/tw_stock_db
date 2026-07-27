"""
更新「鎖股清單」裡個股的資料：抓OHLCV（平行）+ 重算技術指標 + 同步到 GitHub。
清單檔案格式見 watchlist.py（支援 .json / .csv，包含 stock-pattern-analysis Skill
選股結果原生的「鎖股名單」/「代碼」格式）。

用法：
    python update_watchlist.py 鎖股名單.json
    python update_watchlist.py 鎖股名單.csv --period 2y
    python update_watchlist.py 鎖股名單.json --no-sync     # 只更新DB，不推到GitHub
"""
import argparse
import os
import subprocess
import sys

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def run_step(description: str, args: list[str]) -> bool:
    print(f"\n{'='*50}\n{description}\n{'='*50}")
    result = subprocess.run([sys.executable] + args, cwd=BASE_DIR)
    ok = result.returncode == 0
    if not ok:
        print(f"[警告] 步驟失敗：{description}（結束代碼 {result.returncode}）")
    return ok


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("watchlist", type=str, help="鎖股清單檔案路徑（.json 或 .csv）")
    parser.add_argument("--period", type=str, default=None, help="例如 5d, 1mo, 2y（預設 5d）")
    parser.add_argument("--start", type=str, default=None, help="YYYY-MM-DD")
    parser.add_argument("--end", type=str, default=None, help="YYYY-MM-DD")
    parser.add_argument("--workers", type=int, default=None, help="平行抓取的執行緒數，預設為 CPU 核心數")
    parser.add_argument("--no-sync", action="store_true", help="只更新資料庫，不同步到 GitHub")
    args = parser.parse_args()

    fetch_args = ["scrapers/fetch_daily_prices.py", "--watchlist", args.watchlist]
    if args.start and args.end:
        fetch_args += ["--start", args.start, "--end", args.end]
    else:
        fetch_args += ["--period", args.period or "5d"]
    if args.workers:
        fetch_args += ["--workers", str(args.workers)]

    fetched_ok = run_step(f"Step 1: 抓取鎖股清單（{args.watchlist}）的日K資料", fetch_args)
    if not fetched_ok:
        print("\n資料抓取失敗，略過後續步驟。")
        sys.exit(1)

    run_step("Step 2: 計算鎖股清單的技術指標",
              ["analysis/compute_indicators.py", "--watchlist", args.watchlist])

    if not args.no_sync:
        run_step("Step 3: 同步資料到 GitHub（sunneo/tw_stock_db）",
                  ["sync/sync_to_github.py"])

    print("\n鎖股清單更新完成。")


if __name__ == "__main__":
    main()
