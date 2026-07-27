"""
計算技術指標並寫入 technical_indicators 資料表。
指標定義對應 SKILL 內 references/ 的方法論（均線、KD、MACD、RSI、布林通道、乖離率、均線排列）。

用法：
    全部股票重算（例如 schema 改版或想重跑全部歷史）：
        python analysis/compute_indicators.py --all
    只算最近有更新價格資料的股票（每日增量後執行）：
        python analysis/compute_indicators.py
    只算單一股票（例如搭配 fetch_daily_prices.py --code 抓完單支股票後）：
        python analysis/compute_indicators.py --code 2330
    只算「鎖股清單」裡的股票（.json 或 .csv，見 watchlist.py 說明支援的格式）：
        python analysis/compute_indicators.py --watchlist my_watchlist.json
"""
import sys
import os
import sqlite3
import argparse

import pandas as pd
import numpy as np
from tqdm import tqdm

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from config import DB_PATH, MA_PERIODS, KD_PERIOD, RSI_PERIODS, BB_PERIOD, BB_STD, BIAS_PERIOD, get_connection
from watchlist import load_watchlist


def compute_kd(df: pd.DataFrame, period: int = 9) -> pd.DataFrame:
    low_n = df["low"].rolling(period).min()
    high_n = df["high"].rolling(period).max()
    rsv = (df["close"] - low_n) / (high_n - low_n) * 100
    rsv = rsv.fillna(50)
    k = rsv.ewm(alpha=1/3, adjust=False).mean()
    d = k.ewm(alpha=1/3, adjust=False).mean()
    return k, d


def compute_macd(df: pd.DataFrame) -> pd.DataFrame:
    ema12 = df["close"].ewm(span=12, adjust=False).mean()
    ema26 = df["close"].ewm(span=26, adjust=False).mean()
    dif = ema12 - ema26
    macd = dif.ewm(span=9, adjust=False).mean()
    osc = dif - macd
    return dif, macd, osc


def compute_rsi(df: pd.DataFrame, period: int) -> pd.Series:
    delta = df["close"].diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(alpha=1/period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1/period, adjust=False).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    rsi = 100 - (100 / (1 + rs))
    return rsi.fillna(50)


def compute_ma_alignment(row) -> str:
    """判斷5/10/20/60四線排列狀態：多排、空排、或交叉混雜。"""
    vals = [row.get("ma5"), row.get("ma10"), row.get("ma20"), row.get("ma60")]
    if any(pd.isna(v) for v in vals):
        return None
    ma5, ma10, ma20, ma60 = vals
    if ma5 > ma10 > ma20 > ma60:
        return "多排"
    if ma5 < ma10 < ma20 < ma60:
        return "空排"
    return "交叉混雜"


def compute_for_stock(conn, stock_code: str):
    df = pd.read_sql(
        "SELECT trade_date, open, high, low, close, volume FROM daily_prices "
        "WHERE stock_code = ? ORDER BY trade_date",
        conn, params=(stock_code,),
    )
    if len(df) < 5:
        return 0

    for p in MA_PERIODS:
        df[f"ma{p}"] = df["close"].rolling(p).mean()
    df["vol_ma5"] = df["volume"].rolling(5).mean()

    df["kd_k"], df["kd_d"] = compute_kd(df, KD_PERIOD)
    df["macd_dif"], df["macd_macd"], df["macd_osc"] = compute_macd(df)
    for p in RSI_PERIODS:
        df[f"rsi{p}"] = compute_rsi(df, p)

    bb_mid = df["close"].rolling(BB_PERIOD).mean()
    bb_std = df["close"].rolling(BB_PERIOD).std()
    df["bb_upper"] = bb_mid + BB_STD * bb_std
    df["bb_mid"] = bb_mid
    df["bb_lower"] = bb_mid - BB_STD * bb_std

    ma_bias_base = df["close"].rolling(BIAS_PERIOD).mean()
    df["bias20"] = (df["close"] - ma_bias_base) / ma_bias_base * 100

    df["ma_alignment"] = df.apply(compute_ma_alignment, axis=1)

    cols = [
        "trade_date", "ma5", "ma10", "ma20", "ma60", "vol_ma5",
        "kd_k", "kd_d", "macd_dif", "macd_macd", "macd_osc",
        "rsi6", "rsi12", "bb_upper", "bb_mid", "bb_lower", "bias20", "ma_alignment",
    ]
    out = df[cols].copy()
    out.insert(0, "stock_code", stock_code)
    out = out.replace({np.nan: None})

    cur = conn.cursor()
    cur.executemany(
        f"""
        INSERT INTO technical_indicators
            (stock_code, trade_date, ma5, ma10, ma20, ma60, vol_ma5,
             kd_k, kd_d, macd_dif, macd_macd, macd_osc,
             rsi6, rsi12, bb_upper, bb_mid, bb_lower, bias20, ma_alignment)
        VALUES ({",".join(["?"] * 19)})
        ON CONFLICT(stock_code, trade_date) DO UPDATE SET
            ma5=excluded.ma5, ma10=excluded.ma10, ma20=excluded.ma20, ma60=excluded.ma60,
            vol_ma5=excluded.vol_ma5, kd_k=excluded.kd_k, kd_d=excluded.kd_d,
            macd_dif=excluded.macd_dif, macd_macd=excluded.macd_macd, macd_osc=excluded.macd_osc,
            rsi6=excluded.rsi6, rsi12=excluded.rsi12,
            bb_upper=excluded.bb_upper, bb_mid=excluded.bb_mid, bb_lower=excluded.bb_lower,
            bias20=excluded.bias20, ma_alignment=excluded.ma_alignment
        """,
        out.values.tolist(),
    )
    return len(out)


def run(all_stocks: bool = False, stock_code: str = None, watchlist: str = None):
    conn = get_connection()
    cur = conn.cursor()
    if stock_code:
        codes = [stock_code]
    elif watchlist:
        codes = load_watchlist(watchlist)
    elif all_stocks:
        cur.execute("SELECT stock_code FROM stocks WHERE is_active = 1")
        codes = [r[0] for r in cur.fetchall()]
    else:
        # 只算最近7天內有新價格資料的股票（每日增量情境）
        cur.execute(
            "SELECT DISTINCT stock_code FROM daily_prices "
            "WHERE trade_date >= date('now', '-7 day')"
        )
        codes = [r[0] for r in cur.fetchall()]

    print(f"計算 {len(codes)} 檔股票的技術指標...")
    for code in tqdm(codes):
        compute_for_stock(conn, code)
    conn.commit()
    conn.close()
    print("技術指標計算完成。")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--all", action="store_true", help="重算全部股票（含完整歷史）")
    parser.add_argument("--code", type=str, default=None, help="只算單一股票代碼，例如 2330")
    parser.add_argument("--watchlist", type=str, default=None,
                         help="鎖股清單檔案路徑（.json 或 .csv），只算清單內的股票")
    args = parser.parse_args()
    run(all_stocks=args.all, stock_code=args.code, watchlist=args.watchlist)


if __name__ == "__main__":
    main()
