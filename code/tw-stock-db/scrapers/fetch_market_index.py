"""
抓取加權指數(TAIEX)、櫃買指數(TPEx)，以及美股觀察指標（費城半導體SOX、標普500、
那斯達克綜合、道瓊工業指數）的每日資料，寫入 market_index 資料表。
用於大盤環境判斷（四線多排/空排、是否跌破月線季線等），美股三個指標則用於判讀
隔夜美股情緒對台股開盤與電子/半導體類股的領先影響（見 SKILL_claude_desktop_home.md
「美股觀察指標與台股連動判讀」一節）。

用法：
    python scrapers/fetch_market_index.py --period 2y
"""
import sys
import os
import sqlite3
import argparse

import yfinance as yf
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from config import DB_PATH, get_connection

INDEX_TICKERS = {
    "TAIEX": "^TWII",    # 台灣加權指數
    "TPEx": "^TWOII",    # 櫃買指數
    "SOX": "^SOX",       # 費城半導體指數（與台股半導體供應鏈連動性最高的美股領先指標）
    "SPX": "^GSPC",      # 標普500（美股大盤整體風險偏好，risk-on/risk-off參考）
    "NASDAQ": "^IXIC",   # 那斯達克綜合指數（美股科技股/AI概念股風險偏好）
    "DJI": "^DJI",       # 道瓊工業指數（傳產/景氣循環股權重高，反映傳統經濟面風險偏好）
}


def fetch_and_save(index_code: str, ticker: str, period: str = None, start=None, end=None):
    t = yf.Ticker(ticker)
    if start and end:
        hist = t.history(start=start, end=end, auto_adjust=False)
    else:
        hist = t.history(period=period or "5d", auto_adjust=False)

    if hist.empty:
        print(f"{index_code}: 無資料")
        return

    conn = get_connection()
    cur = conn.cursor()
    rows = []
    for idx, row in hist.iterrows():
        trade_date = idx.strftime("%Y-%m-%d")
        rows.append((
            index_code, trade_date,
            float(row["Open"]) if pd.notna(row["Open"]) else None,
            float(row["High"]) if pd.notna(row["High"]) else None,
            float(row["Low"]) if pd.notna(row["Low"]) else None,
            float(row["Close"]) if pd.notna(row["Close"]) else None,
            int(row["Volume"]) if pd.notna(row["Volume"]) else None,
        ))
    cur.executemany(
        """
        INSERT INTO market_index (index_code, trade_date, open, high, low, close, volume)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(index_code, trade_date) DO UPDATE SET
            open=excluded.open, high=excluded.high, low=excluded.low,
            close=excluded.close, volume=excluded.volume
        """,
        rows,
    )
    conn.commit()
    conn.close()
    print(f"{index_code}: 已寫入 {len(rows)} 筆")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--period", type=str, default=None)
    parser.add_argument("--start", type=str, default=None)
    parser.add_argument("--end", type=str, default=None)
    args = parser.parse_args()
    if not args.period and not (args.start and args.end):
        args.period = "5d"

    for code, ticker in INDEX_TICKERS.items():
        fetch_and_save(code, ticker, period=args.period, start=args.start, end=args.end)


if __name__ == "__main__":
    main()
