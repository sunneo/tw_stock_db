"""
匯出「單一交易日」的增量資料成小型 CSV，供每日推送到 GitHub 用（取代整個 303MB 的
tw_stock.db，避免每天推送就把 Git LFS 免費額度用光）。

輸出到 <out_dir>/：
    stocks.csv               當天股票基本清單（全量，檔案小，方便單日目錄自成一份可用資料）
    daily_prices.csv         當天的個股OHLCV
    technical_indicators.csv 當天的技術指標
    market_index.csv         當天的大盤/櫃買指數
    intraday_quotes.csv      當天的盤中快照（只在有擷取過時才產生這個檔案）
"""
import os
import sqlite3

import pandas as pd


def export_delta(db_path: str, trade_date: str, out_dir: str):
    conn = sqlite3.connect(db_path, timeout=30)
    try:
        tables = {
            "stocks.csv": ("SELECT stock_code, stock_name, market, sector_id, is_active FROM stocks", ()),
            "daily_prices.csv": ("SELECT * FROM daily_prices WHERE trade_date = ?", (trade_date,)),
            "technical_indicators.csv": ("SELECT * FROM technical_indicators WHERE trade_date = ?", (trade_date,)),
            "market_index.csv": ("SELECT * FROM market_index WHERE trade_date = ?", (trade_date,)),
        }
        os.makedirs(out_dir, exist_ok=True)
        for filename, (sql, params) in tables.items():
            df = pd.read_sql(sql, conn, params=params)
            df.to_csv(os.path.join(out_dir, filename), index=False)
            print(f"  {filename}: {len(df)} 筆")

        # 盤中快照是選擇性的（只有當天真的有跑過 capture_intraday.py 才會有資料），
        # 沒有資料就不產生這個檔案，避免每天都提交一個空的 CSV
        intraday_df = pd.read_sql(
            "SELECT * FROM intraday_quotes WHERE snapshot_at LIKE ? ORDER BY snapshot_at",
            conn, params=(f"{trade_date}%",),
        )
        if not intraday_df.empty:
            intraday_df.to_csv(os.path.join(out_dir, "intraday_quotes.csv"), index=False)
            print(f"  intraday_quotes.csv: {len(intraday_df)} 筆")
    finally:
        conn.close()
