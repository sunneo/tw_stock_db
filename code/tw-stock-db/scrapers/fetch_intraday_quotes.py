"""
擷取「盤中」即時快照（當天截至目前為止的開高低價、最新成交價、累計成交量），
寫入 intraday_quotes 資料表。跟 daily_prices（收盤後才算數的完整OHLCV）分開存放。

用途：例如每天中午(交易時間內)跑一次，看鎖股清單裡的股票半場表現如何，
不用等到收盤才知道。

資料來源：Yahoo Finance 1分鐘K棒（period=1d, interval=1m），取當天所有分鐘K的
開盤(第一根的Open)/最高/最低/成交量加總，最新成交價則是最後一根的收盤價。
盤前/非交易日執行會抓不到資料（no_data）。

用法：
    抓「鎖股清單」裡的股票（.json 或 .csv，見 watchlist.py）：
        python scrapers/fetch_intraday_quotes.py --watchlist my_watchlist.json
    抓單一股票：
        python scrapers/fetch_intraday_quotes.py --code 2330
    抓全部 active 股票：
        python scrapers/fetch_intraday_quotes.py --all

抓取用多執行緒平行進行（預設平行度 = CPU核心數），可用 --workers 覆蓋。
"""
import sys
import os
import sqlite3
import time
import argparse
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed

import yfinance as yf
import pandas as pd
from tqdm import tqdm

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from config import DB_PATH, REQUEST_DELAY_SEC, MAX_RETRIES, get_connection
from watchlist import load_watchlist
from scrapers.fetch_daily_prices import (
    get_stock_universe,
    resolve_and_register_stock,
    to_yahoo_ticker,
    log_fetch,
)


def fetch_intraday_snapshot(ticker: str) -> dict:
    t = yf.Ticker(ticker)
    hist = t.history(period="1d", interval="1m", auto_adjust=False)
    if hist.empty:
        return None
    hist = hist.dropna(subset=["Close"])
    if hist.empty:
        return None
    return {
        "price": float(hist["Close"].iloc[-1]),
        "open": float(hist["Open"].iloc[0]),
        "high": float(hist["High"].max()),
        "low": float(hist["Low"].min()),
        "volume": int(hist["Volume"].sum()) if hist["Volume"].notna().any() else None,
    }


def _fetch_with_retry(stock_code: str, market: str):
    ticker = to_yahoo_ticker(stock_code, market)
    attempt = 0
    last_err = None
    while attempt < MAX_RETRIES:
        try:
            snapshot = fetch_intraday_snapshot(ticker)
            time.sleep(REQUEST_DELAY_SEC)
            return stock_code, snapshot, None
        except Exception as e:
            attempt += 1
            last_err = e
            time.sleep(1)
    return stock_code, None, last_err


def save_snapshot(conn, stock_code: str, snapshot: dict, snapshot_at: str):
    cur = conn.cursor()
    cur.execute(
        """
        INSERT INTO intraday_quotes (stock_code, snapshot_at, price, open, high, low, volume)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(stock_code, snapshot_at) DO UPDATE SET
            price=excluded.price, open=excluded.open, high=excluded.high,
            low=excluded.low, volume=excluded.volume
        """,
        (stock_code, snapshot_at, snapshot["price"], snapshot["open"],
         snapshot["high"], snapshot["low"], snapshot["volume"]),
    )


def run(stock_code=None, watchlist=None, all_stocks=False, workers=None):
    conn = get_connection()

    if stock_code:
        market = resolve_and_register_stock(conn, stock_code)
        universe = [(stock_code, market)]
    elif watchlist:
        codes = load_watchlist(watchlist)
        universe = [(code, resolve_and_register_stock(conn, code)) for code in codes]
    elif all_stocks:
        universe = get_stock_universe(conn)
    else:
        raise ValueError("請指定 --code、--watchlist 或 --all 其中一種")

    if not universe:
        print("沒有股票需要擷取")
        return

    workers = workers or os.cpu_count() or 4
    snapshot_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"開始擷取 {len(universe)} 檔股票的盤中快照（{snapshot_at}，平行度 {workers}）...")
    success, no_data, failed = 0, 0, 0

    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = [executor.submit(_fetch_with_retry, code, market) for code, market in universe]
        for future in tqdm(as_completed(futures), total=len(futures)):
            code, snapshot, err = future.result()
            if err is not None:
                log_fetch(conn, code, "failed", str(err))
                failed += 1
            elif snapshot is None:
                log_fetch(conn, code, "no_data", "intraday: 無盤中資料（可能非交易時間）")
                no_data += 1
            else:
                save_snapshot(conn, code, snapshot, snapshot_at)
                log_fetch(conn, code, "success", f"intraday snapshot @ {snapshot_at}")
                success += 1

            if (success + failed + no_data) % 50 == 0:
                conn.commit()

    conn.commit()
    conn.close()
    print(f"完成。成功 {success} 檔，無資料 {no_data} 檔，失敗 {failed} 檔")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--code", type=str, default=None, help="只抓單一股票代碼，例如 2330")
    parser.add_argument("--watchlist", type=str, default=None,
                         help="鎖股清單檔案路徑（.json 或 .csv），只抓清單內的股票")
    parser.add_argument("--all", action="store_true", help="抓全部 active 股票")
    parser.add_argument("--workers", type=int, default=None,
                         help="平行抓取的執行緒數，預設為 CPU 核心數")
    args = parser.parse_args()
    run(stock_code=args.code, watchlist=args.watchlist, all_stocks=args.all, workers=args.workers)


if __name__ == "__main__":
    main()
