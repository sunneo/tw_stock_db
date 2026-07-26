"""
匯出「單一交易日」的增量資料成小型 CSV，供每日推送到 GitHub 用（取代整個 303MB 的
tw_stock.db，避免每天推送就把 Git LFS 免費額度用光）。

輸出到 <out_dir>/：
    stocks.csv               當天股票基本清單（全量，檔案小，方便單日目錄自成一份可用資料）
    daily_prices.csv         當天的個股OHLCV
    technical_indicators.csv 當天的技術指標
    market_index.csv         當天的大盤/櫃買指數
"""
import os
import sqlite3

import pandas as pd


def export_delta(db_path: str, trade_date: str, out_dir: str):
    conn = sqlite3.connect(db_path)
    try:
        tables = {
            "stocks.csv": "SELECT stock_code, stock_name, market, sector_id, is_active FROM stocks",
            "daily_prices.csv": "SELECT * FROM daily_prices WHERE trade_date = ?",
            "technical_indicators.csv": "SELECT * FROM technical_indicators WHERE trade_date = ?",
            "market_index.csv": "SELECT * FROM market_index WHERE trade_date = ?",
        }
        os.makedirs(out_dir, exist_ok=True)
        for filename, sql in tables.items():
            params = () if "stocks" in filename else (trade_date,)
            df = pd.read_sql(sql, conn, params=params)
            df.to_csv(os.path.join(out_dir, filename), index=False)
            print(f"  {filename}: {len(df)} 筆")
    finally:
        conn.close()
