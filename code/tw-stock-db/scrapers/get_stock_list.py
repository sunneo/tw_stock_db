"""
取得全部上市(TWSE)+上櫃(TPEx)股票代碼與名稱清單，寫入 stocks 資料表。

資料來源：證交所公開的 ISIN 基本資料查詢頁面（僅用於取得「代碼/名稱/市場別」
這類公開的公司基本資料，不涉及法人買賣超等籌碼資料）。

用法： python scrapers/get_stock_list.py
"""
import sys
import os
import sqlite3
import requests
import pandas as pd
from io import StringIO

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from config import DB_PATH

ISIN_URLS = {
    "TWSE": "https://isin.twse.com.tw/isin/C_public.jsp?strMode=2",  # 上市
    "TPEx": "https://isin.twse.com.tw/isin/C_public.jsp?strMode=4",  # 上櫃
}

HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}


def fetch_stock_list(market: str) -> pd.DataFrame:
    """抓取單一市場（TWSE 或 TPEx）的股票清單。"""
    url = ISIN_URLS[market]
    resp = requests.get(url, headers=HEADERS, timeout=30)
    resp.encoding = "big5"
    tables = pd.read_html(StringIO(resp.text))
    df = tables[0]
    df.columns = df.iloc[0]
    df = df.iloc[1:]

    # 該頁第一欄格式為 "代碼　名稱"，並混雜了ETF、權證、大盤指數等列，
    # 只保留4碼數字代碼、且欄位標記為「股票」的列（一般個股）。
    col0 = df.columns[0]
    records = []
    for _, row in df.iterrows():
        raw = str(row[col0]).strip()
        parts = raw.split("\u3000")  # 全形空白分隔
        if len(parts) != 2:
            continue
        code, name = parts[0].strip(), parts[1].strip()
        if not (len(code) == 4 and code.isdigit()):
            continue
        cfi_col = "CFICode" if "CFICode" in df.columns else None
        industry_col = "產業別" if "產業別" in df.columns else None
        records.append({
            "stock_code": code,
            "stock_name": name,
            "market": market,
            "sector_name": row[industry_col] if industry_col else None,
        })
    return pd.DataFrame(records)


def save_to_db(df: pd.DataFrame):
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    try:
        for _, row in df.iterrows():
            sector_id = None
            if row["sector_name"] and str(row["sector_name"]) != "nan":
                cur.execute(
                    "INSERT OR IGNORE INTO sectors (sector_name) VALUES (?)",
                    (row["sector_name"],),
                )
                cur.execute(
                    "SELECT sector_id FROM sectors WHERE sector_name = ?",
                    (row["sector_name"],),
                )
                result = cur.fetchone()
                sector_id = result[0] if result else None

            cur.execute(
                """
                INSERT INTO stocks (stock_code, stock_name, market, sector_id, is_active)
                VALUES (?, ?, ?, ?, 1)
                ON CONFLICT(stock_code) DO UPDATE SET
                    stock_name = excluded.stock_name,
                    market = excluded.market,
                    sector_id = excluded.sector_id,
                    is_active = 1,
                    updated_at = datetime('now')
                """,
                (row["stock_code"], row["stock_name"], row["market"], sector_id),
            )
        conn.commit()
        print(f"已寫入/更新 {len(df)} 檔股票基本資料")
    finally:
        conn.close()


def main():
    all_dfs = []
    for market in ISIN_URLS:
        print(f"抓取 {market} 股票清單...")
        df = fetch_stock_list(market)
        print(f"  {market}: {len(df)} 檔")
        all_dfs.append(df)
    full_df = pd.concat(all_dfs, ignore_index=True)
    save_to_db(full_df)


if __name__ == "__main__":
    main()
