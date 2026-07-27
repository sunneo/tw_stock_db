"""
每日更新的主流程：依序執行
1. 更新股票基本清單（可以不用每天跑，但跑了也無妨，量小）
2. 抓取大盤指數最近資料
3. 抓取全部個股最近5天的OHLCV（增量更新，含補漏）
4. 重算最近有更新資料的股票的技術指標（含 RS值/相對強度排名）
5. 產生每日文字報告 reports/latest.md（供分享給其他 Claude 對話讀取）
6. 同步資料到 GitHub sunneo/tw_stock_db（每日增量 + 每月一次完整快照）

以及兩組可選的額外流程（依 flag 觸發，預設不執行，避免每天都跑成本較高的全市場篩選）：

--weekly：額外產生「週報」四份輸出到 reports/weekly/{今天日期}/：
    strong_stocks_current.md   強勢股（目前原則，型態訊號評分）
    strong_stocks_xq.md        強勢股（XQ原則，RS值動能）
    watchlist_current.json/.csv 鎖股名單（目前原則，做多+做空）
    watchlist_xq.json           下週鎖股名單（XQ原則，RS值動能，做多）

--holdings <鎖股清單檔案>：額外針對指定的持股/鎖股清單跑一次持股分析，
    輸出到 reports/holdings/{今天日期}.md（自動帶 --compare-new 做每日追蹤複查）。

建議排程：
    每個交易日收盤後（例如台灣時間 14:30 之後）執行一次基本流程：
        python run_daily_update.py
    每週想重新篩選全市場、產生正式週報時，加上 --weekly：
        python run_daily_update.py --weekly
    手上有在追蹤的鎖股清單，想順便更新持股分析時：
        python run_daily_update.py --holdings 鎖股名單.json
"""
import argparse
import subprocess
import sys
import os
from datetime import date

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WEEKLY_DIR = os.path.join(BASE_DIR, "reports", "weekly")
HOLDINGS_DIR = os.path.join(BASE_DIR, "reports", "holdings")


def run_step(description: str, args: list) -> bool:
    print(f"\n{'='*50}\n{description}\n{'='*50}")
    result = subprocess.run([sys.executable] + args, cwd=BASE_DIR)
    ok = result.returncode == 0
    if not ok:
        print(f"[警告] 步驟失敗：{description}（結束代碼 {result.returncode}），繼續下一步")
    return ok


def run_weekly_outputs():
    today = date.today().isoformat()
    out_dir = os.path.join(WEEKLY_DIR, today)
    os.makedirs(out_dir, exist_ok=True)

    run_step("Step 7a: 強勢股（目前原則）",
              ["analysis/screen_strong_stocks.py", "--method", "current", "--top", "30",
               "--format", "md", "--out", os.path.join(out_dir, "strong_stocks_current.md")])
    run_step("Step 7b: 強勢股（XQ原則，RS值動能）",
              ["analysis/screen_strong_stocks.py", "--method", "xq", "--top", "30",
               "--format", "md", "--out", os.path.join(out_dir, "strong_stocks_xq.md")])
    run_step("Step 7c: 鎖股名單（目前原則，做多+做空）",
              ["analysis/generate_watchlist.py", "--method", "current",
               "--out", os.path.join(out_dir, "watchlist_current.json")])
    run_step("Step 7d: 鎖股名單（目前原則，CSV）",
              ["analysis/generate_watchlist.py", "--method", "current", "--format", "csv",
               "--out", os.path.join(out_dir, "watchlist_current.csv")])
    run_step("Step 7e: 下週鎖股名單（XQ原則，RS值動能）",
              ["analysis/generate_watchlist.py", "--method", "xq",
               "--out", os.path.join(out_dir, "watchlist_xq.json")])
    print(f"\n週報已產生於 {out_dir}")


def run_holdings_output(holdings_path: str):
    today = date.today().isoformat()
    os.makedirs(HOLDINGS_DIR, exist_ok=True)
    out_path = os.path.join(HOLDINGS_DIR, f"{today}.md")
    run_step(f"Step 8: 持股分析（{holdings_path}）",
              ["analysis/generate_holdings_report.py", holdings_path,
               "--compare-new", "--out", out_path])


def main():
    parser = argparse.ArgumentParser(description="每日更新主流程")
    parser.add_argument("--weekly", action="store_true",
                         help="額外產生週報：強勢股(目前/XQ原則) + 鎖股名單(目前/XQ原則)")
    parser.add_argument("--holdings", type=str, default=None,
                         help="額外針對指定的持股/鎖股清單跑一次持股分析報告")
    args = parser.parse_args()

    run_step("Step 0: 初始化資料庫（如果尚未建立）",
              ["db/init_db.py"])
    run_step("Step 1: 更新股票基本清單",
              ["scrapers/get_stock_list.py"])
    run_step("Step 2: 抓取大盤指數",
              ["scrapers/fetch_market_index.py", "--period", "1d"])
    run_step("Step 3: 抓取個股日K（增量，近1天）",
              ["scrapers/fetch_daily_prices.py", "--period", "1d"])
    run_step("Step 4: 計算技術指標（近期有更新的股票，含RS值排名）",
              ["analysis/compute_indicators.py"])
    run_step("Step 5: 產生每日報告（reports/latest.md）",
              ["analysis/generate_daily_report.py"])
    run_step("Step 6: 同步資料到 GitHub（sunneo/tw_stock_db）",
              ["sync/sync_to_github.py"])

    if args.weekly:
        run_weekly_outputs()
    if args.holdings:
        run_holdings_output(args.holdings)

    print("\n每日更新流程完成。")


if __name__ == "__main__":
    main()
