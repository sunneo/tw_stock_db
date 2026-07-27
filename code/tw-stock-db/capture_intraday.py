"""
盤中擷取：抓「目前這一刻」的即時快照（開高低、最新成交價、累計成交量），
寫入 intraday_quotes 資料表。適合排程在**交易時間內**（例如中午12:00）執行一次，
不用等到收盤就能看鎖股清單裡的股票半場表現。

跟 run_daily_update.py / update_stock.py / update_watchlist.py 不同：
這裡**不**更新 daily_prices、也**不**重算 technical_indicators（那些是收盤後才有
意義的完整OHLCV），只單純記錄盤中快照，兩者互不干擾。

用法：
    python capture_intraday.py --watchlist 鎖股名單.json
    python capture_intraday.py --code 2330
    python capture_intraday.py --all              # 全市場（量大，建議只在真的需要時用）
    python capture_intraday.py --watchlist 鎖股名單.json --no-sync   # 不推到 GitHub

排程建議（Windows工作排程器）：觸發條件設每天交易時間內的固定時間點（例如12:00），
僅限週一至週五；動作跟 run_daily_update.py 一樣是啟動 venv 的 python.exe，
引數改成 capture_intraday.py --watchlist <路徑>，啟動位置設為這個資料夾。
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
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--watchlist", type=str, help="鎖股清單檔案路徑（.json 或 .csv）")
    group.add_argument("--code", type=str, help="只抓單一股票代碼")
    group.add_argument("--all", action="store_true", help="抓全部 active 股票")
    parser.add_argument("--workers", type=int, default=None, help="平行抓取的執行緒數，預設為 CPU 核心數")
    parser.add_argument("--no-sync", action="store_true", help="只更新資料庫，不同步到 GitHub")
    args = parser.parse_args()

    fetch_args = ["scrapers/fetch_intraday_quotes.py"]
    if args.watchlist:
        fetch_args += ["--watchlist", args.watchlist]
    elif args.code:
        fetch_args += ["--code", args.code]
    else:
        fetch_args += ["--all"]
    if args.workers:
        fetch_args += ["--workers", str(args.workers)]

    ok = run_step("Step 1: 擷取盤中即時快照", fetch_args)
    if not ok:
        sys.exit(1)

    if not args.no_sync:
        run_step("Step 2: 同步資料到 GitHub（sunneo/tw_stock_db）",
                  ["sync/sync_to_github.py"])

    print("\n盤中擷取完成。")


if __name__ == "__main__":
    main()
