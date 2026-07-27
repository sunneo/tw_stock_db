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
    只抓單一個股（--code 可搭配上面任何一種期間參數）：
        python scrapers/fetch_daily_prices.py --code 2330 --period 2y
    只抓「鎖股清單」裡的個股（.json 或 .csv，見 watchlist.py 說明支援的格式）：
        python scrapers/fetch_daily_prices.py --watchlist my_watchlist.json --period 2y

    --code / --watchlist 指定的代碼如果不在 stocks 資料表裡（例如剛上市的新股），
    會自動嘗試用 Yahoo Finance 判斷是上市(.TW)還是上櫃(.TWO)，並自動註冊進 stocks 資料表。

    抓取用多執行緒平行進行（預設平行度 = CPU核心數，網路I/O是瓶頸，用執行緒足夠，
    不需要多程序），可用 --workers 覆蓋。寫入資料庫的動作固定在主執行緒序列化執行，
    避免 SQLite 多執行緒寫入衝突。
"""
import sys
import os
import sqlite3
import time
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed

import yfinance as yf
import pandas as pd
from tqdm import tqdm

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from config import DB_PATH, REQUEST_DELAY_SEC, MAX_RETRIES, get_connection
from watchlist import load_watchlist


def get_stock_universe(conn) -> list[tuple[str, str]]:
    """從 stocks 表取得所有 active 股票的 (代碼, 市場) 清單。"""
    cur = conn.cursor()
    cur.execute("SELECT stock_code, market FROM stocks WHERE is_active = 1")
    return cur.fetchall()


def resolve_and_register_stock(conn, stock_code: str) -> str:
    """
    取得單一股票代碼對應的市場別。若該代碼已在 stocks 表中，直接回傳其市場別；
    否則嘗試用 Yahoo Finance 探測是上市(.TW)還是上櫃(.TWO)，並自動註冊進 stocks 表
    （方便抓剛上市、股票清單還沒更新到的新代碼）。
    """
    cur = conn.cursor()
    cur.execute("SELECT market FROM stocks WHERE stock_code = ?", (stock_code,))
    row = cur.fetchone()
    if row:
        return row[0]

    print(f"{stock_code} 不在 stocks 資料表裡，嘗試用 Yahoo Finance 判斷市場別...")
    for market, suffix in [("TWSE", ".TW"), ("TPEx", ".TWO")]:
        probe = yf.Ticker(f"{stock_code}{suffix}").history(period="5d", auto_adjust=False)
        if not probe.empty:
            stock_name = stock_code
            try:
                info_name = yf.Ticker(f"{stock_code}{suffix}").info.get("longName")
                if info_name:
                    stock_name = info_name
            except Exception:
                pass
            cur.execute(
                """
                INSERT INTO stocks (stock_code, stock_name, market, is_active)
                VALUES (?, ?, ?, 1)
                ON CONFLICT(stock_code) DO UPDATE SET
                    market = excluded.market, is_active = 1, updated_at = datetime('now')
                """,
                (stock_code, stock_name, market),
            )
            conn.commit()
            print(f"{stock_code} 判斷為 {market}（{stock_name}），已自動註冊進 stocks 資料表")
            return market

    raise ValueError(f"找不到股票代號 {stock_code} 的資料（上市/上櫃都沒抓到），請確認代碼是否正確")


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


def _fetch_with_retry(stock_code: str, market: str, period=None, start=None, end=None):
    """在 worker 執行緒裡跑：只做網路抓取，不碰 DB 連線（sqlite3 連線不能跨執行緒共用）。"""
    ticker = to_yahoo_ticker(stock_code, market)
    attempt = 0
    last_err = None
    while attempt < MAX_RETRIES:
        try:
            hist = fetch_one(ticker, period=period, start=start, end=end)
            time.sleep(REQUEST_DELAY_SEC)
            return stock_code, hist, None
        except Exception as e:
            attempt += 1
            last_err = e
            time.sleep(1)
    return stock_code, None, last_err


def run(period=None, start=None, end=None, stock_code=None, watchlist=None, workers=None):
    conn = get_connection()

    if stock_code:
        market = resolve_and_register_stock(conn, stock_code)
        universe = [(stock_code, market)]
    elif watchlist:
        codes = load_watchlist(watchlist)
        universe = [(code, resolve_and_register_stock(conn, code)) for code in codes]
    else:
        universe = get_stock_universe(conn)
        if not universe:
            print("stocks 資料表是空的，請先執行 scrapers/get_stock_list.py")
            return

    workers = workers or os.cpu_count() or 4
    print(f"開始抓取 {len(universe)} 檔股票的日K資料（平行度 {workers}）...")
    success, failed = 0, 0

    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = [
            executor.submit(_fetch_with_retry, code, market, period, start, end)
            for code, market in universe
        ]
        for future in tqdm(as_completed(futures), total=len(futures)):
            stock_code, hist, err = future.result()
            if err is not None:
                log_fetch(conn, stock_code, "failed", str(err))
                failed += 1
            else:
                n = save_prices(conn, stock_code, hist)
                if n == 0:
                    log_fetch(conn, stock_code, "no_data")
                else:
                    log_fetch(conn, stock_code, "success", f"{n} rows")
                    success += 1

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
    parser.add_argument("--code", type=str, default=None, help="只抓單一股票代碼，例如 2330")
    parser.add_argument("--watchlist", type=str, default=None,
                         help="鎖股清單檔案路徑（.json 或 .csv），只抓清單內的股票")
    parser.add_argument("--workers", type=int, default=None,
                         help="平行抓取的執行緒數，預設為 CPU 核心數")
    args = parser.parse_args()

    if not args.period and not (args.start and args.end):
        args.period = "5d"  # 預設：每日增量更新模式

    run(period=args.period, start=args.start, end=args.end,
        stock_code=args.code, watchlist=args.watchlist, workers=args.workers)


if __name__ == "__main__":
    main()
