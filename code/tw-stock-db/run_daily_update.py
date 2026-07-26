"""
每日更新的主流程：依序執行
1. 更新股票基本清單（可以不用每天跑，但跑了也無妨，量小）
2. 抓取大盤指數最近資料
3. 抓取全部個股最近5天的OHLCV（增量更新，含補漏）
4. 重算最近有更新資料的股票的技術指標
5. 產生每日文字報告 reports/latest.md（供分享給其他 Claude 對話讀取）
6. 同步資料到 GitHub sunneo/tw_stock_db（每日增量 + 每月一次完整快照）

建議排程：每個交易日收盤後（例如台灣時間 14:30 之後）執行一次。
用法：
    python run_daily_update.py
"""
import subprocess
import sys
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def run_step(description: str, args: list[str]):
    print(f"\n{'='*50}\n{description}\n{'='*50}")
    result = subprocess.run([sys.executable] + args, cwd=BASE_DIR)
    if result.returncode != 0:
        print(f"⚠️  步驟失敗：{description}（結束代碼 {result.returncode}），繼續下一步")


def main():
    run_step("Step 0: 初始化資料庫（如果尚未建立）",
              ["db/init_db.py"])
    run_step("Step 1: 更新股票基本清單",
              ["scrapers/get_stock_list.py"])
    run_step("Step 2: 抓取大盤指數",
              ["scrapers/fetch_market_index.py", "--period", "5d"])
    run_step("Step 3: 抓取個股日K（增量，近5天）",
              ["scrapers/fetch_daily_prices.py", "--period", "5d"])
    run_step("Step 4: 計算技術指標（近期有更新的股票）",
              ["analysis/compute_indicators.py"])
    run_step("Step 5: 產生每日報告（reports/latest.md）",
              ["analysis/generate_daily_report.py"])
    run_step("Step 6: 同步資料到 GitHub（sunneo/tw_stock_db）",
              ["sync/sync_to_github.py"])
    print("\n每日更新流程完成。")


if __name__ == "__main__":
    main()
