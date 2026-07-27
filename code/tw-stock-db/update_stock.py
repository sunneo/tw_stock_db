"""
只更新「單一股票」的資料：抓OHLCV + 重算該股票的技術指標，不用跑全市場的每日更新。
適合用在：想立刻看某支股票的最新資料、補抓某支股票的歷史資料、或代碼還沒在
stocks 清單裡的新股（會自動判斷上市/上櫃並註冊進資料庫，見
scrapers/fetch_daily_prices.py 的 resolve_and_register_stock）。

用法：
    python update_stock.py 2330                  # 預設抓最近5天（增量）
    python update_stock.py 2330 --period 2y       # 抓完整2年歷史
    python update_stock.py 2330 --start 2024-01-01 --end 2024-12-31
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
    parser.add_argument("code", type=str, help="股票代碼，例如 2330")
    parser.add_argument("--period", type=str, default=None, help="例如 5d, 1mo, 2y（預設 5d）")
    parser.add_argument("--start", type=str, default=None, help="YYYY-MM-DD")
    parser.add_argument("--end", type=str, default=None, help="YYYY-MM-DD")
    args = parser.parse_args()

    fetch_args = ["scrapers/fetch_daily_prices.py", "--code", args.code]
    if args.start and args.end:
        fetch_args += ["--start", args.start, "--end", args.end]
    else:
        fetch_args += ["--period", args.period or "5d"]

    fetched_ok = run_step(f"Step 1: 抓取 {args.code} 的日K資料", fetch_args)
    if not fetched_ok:
        print(f"\n{args.code} 資料抓取失敗，略過技術指標計算。")
        sys.exit(1)

    run_step(f"Step 2: 計算 {args.code} 的技術指標",
              ["analysis/compute_indicators.py", "--code", args.code])
    print(f"\n{args.code} 更新完成。")


if __name__ == "__main__":
    main()
