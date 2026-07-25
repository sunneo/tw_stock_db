"""
批次抓取全部台股個股的每日OHLCV，寫入 daily_prices 資料表。

資料來源：Yahoo Finance（透過 yfinance 套件），對應 tw.stock.yahoo.com 同一資料源，
上市股票代碼會自動轉換為 {code}.TW，上櫃股票轉換為 {code}.TWO。

用法：
    首次建置歷史資料（例如抓近2年）：
        python scrapers/fetch_daily_prices.py --period 2y
    每日增量更新（抓最近5天，避免補漏）：
        python scrapers/fetch_daily_prices.py --period 5d
    指定日期區間：
        python scrapers/fetch_daily_prices.py --start 2024-01-01 --end 2024-12-31
"""
import sys
import os
import sqlite3
import time
import argparse
import sqlite3 as sql

import yfinance as yf
import pandas as pd
from tqdm import tqdm

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from config import DB_PATH, REQUEST_DELAY_SEC, MAX_RETRIES


def get_stock_universe(conn) -> list[tuple[str, str]]:
    """從 stocks 表取得所有 active 股票的 (代碼, 市場) 清單。"""
    cur = conn.cursor()
    cur.execute("SELECT stock_code, market FROM stocks WHERE is_active = 1")
    return cur.fetchall()


def to_yahoo_ticker(stock_code: str, market: str) -> str:
    suffix = ".TW" if market == "TWSE" else ".TWO"
    return f"{stock_code}{suffix}"


def fetch_one(ticker: str, period: str = None, start: str = None, end: str = None) -> pd.DataFrame:
    t = yf.Ticker(ticker)
    if start and end:
        hist = t.history(start=start, end=end, auto_adjust=False)
    else:
        hist = t.history(period=period or "5d", auto_adjust=False)
    return hist


def save_prices(conn, stock_code: str, hist: pd.DataFrame):
    if hist.empty:
        return 0
    cur = conn.cursor()
    rows = []
    for idx, row in hist.iterrows():
        trade_date = idx.strftime("%Y-%m-%d")
        rows.append((
            stock_code, trade_date,
            float(row["Open"]) if pd.notna(row["Open"]) else None,
            float(row["High"]) if pd.notna(row["High"]) else None,
            float(row["Low"]) if pd.notna(row["Low"]) else None,
            float(row["Close"]) if pd.notna(row["Close"]) else None,
            int(row["Volume"]) if pd.notna(row["Volume"]) else None,
        ))
    cur.executemany(
        """
        INSERT INTO daily_prices (stock_code, trade_date, open, high, low, close, volume)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(stock_code, trade_date) DO UPDATE SET
            open=excluded.open, high=excluded.high, low=excluded.low,
            close=excluded.close, volume=excluded.volume
        """,
        rows,
    )
    return len(rows)


def log_fetch(conn, stock_code: str, status: str, message: str = ""):
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO fetch_log (stock_code, status, message) VALUES (?, ?, ?)",
        (stock_code, status, message),
    )


def run(period=None, start=None, end=None):
    conn = sqlite3.connect(DB_PATH)
    universe = get_stock_universe(conn)
    if not universe:
        print("stocks 資料表是空的，請先執行 scrapers/get_stock_list.py")
        return

    print(f"開始抓取 {len(universe)} 檔股票的日K資料...")
    success, failed = 0, 0

    for stock_code, market in tqdm(universe):
        ticker = to_yahoo_ticker(stock_code, market)
        attempt = 0
        while attempt < MAX_RETRIES:
            try:
                hist = fetch_one(ticker, period=period, start=start, end=end)
                n = save_prices(conn, stock_code, hist)
                if n == 0:
                    log_fetch(conn, stock_code, "no_data")
                else:
                    log_fetch(conn, stock_code, "success", f"{n} rows")
                    success += 1
                break
            except Exception as e:
                attempt += 1
                if attempt >= MAX_RETRIES:
                    log_fetch(conn, stock_code, "failed", str(e))
                    failed += 1
                time.sleep(1)
        time.sleep(REQUEST_DELAY_SEC)

        # 每50檔提交一次，避免長時間交易未提交
        if (success + failed) % 50 == 0:
            conn.commit()

    conn.commit()
    conn.close()
    print(f"完成。成功 {success} 檔，失敗 {failed} 檔（詳見 fetch_log 資料表）")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--period", type=str, default=None, help="例如 5d, 1mo, 2y")
    parser.add_argument("--start", type=str, default=None, help="YYYY-MM-DD")
    parser.add_argument("--end", type=str, default=None, help="YYYY-MM-DD")
    args = parser.parse_args()

    if not args.period and not (args.start and args.end):
        args.period = "5d"  # 預設：每日增量更新模式

    run(period=args.period, start=args.start, end=args.end)


if __name__ == "__main__":
    main()
