"""
計算技術指標並寫入 technical_indicators 資料表。
指標定義對應 SKILL 內 references/ 的方法論（均線、KD、MACD、RSI、布林通道、乖離率、均線排列）。

也負責計算 rs_rating（RS值/相對強度評分，1-99，仿 XQ全球贏家／IBD RS Rating）：
先算每檔股票近3/6/9/12個月漲幅加權(40/20/20/20)的原始動能分數，再對「當天全市場」
做百分位排名。因為RS本質上是跨股票排名，跟其他逐股計算的指標不同，每次跑完
per-stock指標之後，會再對這次有更新到的交易日做一次全市場排名（見 update_rs_ratings()）。
給 analysis/screen_strong_stocks.py --method xq（XQ原則強勢股）使用。

用法：
    全部股票重算（例如 schema 改版或想重跑全部歷史）：
        python analysis/compute_indicators.py --all
    只算最近有更新價格資料的股票（每日增量後執行）：
        python analysis/compute_indicators.py
    只算單一股票（例如搭配 fetch_daily_prices.py --code 抓完單支股票後）：
        python analysis/compute_indicators.py --code 2330
    只算「鎖股清單」裡的股票（.json 或 .csv，見 watchlist.py 說明支援的格式）：
        python analysis/compute_indicators.py --watchlist my_watchlist.json
    跳過RS值排名（只想快速算其他指標時）：
        python analysis/compute_indicators.py --skip-rs
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


def compute_rs_raw_scores(conn, min_date: str = None) -> pd.DataFrame:
    """
    計算「RS原始動能分數」（尚未百分位排名）：仿IBD/XQ RS Rating的作法，
    以近3/6/9/12個月（63/126/189/252個交易日）漲幅，用40/20/20/20加權平均。
    回傳 long-format DataFrame：columns = [trade_date, stock_code, rs_raw]。
    min_date：只需要算「這個日期之後」要用的排名時，可以限制讀取範圍節省時間，
    但仍會自動往前多抓約400天當作回看窗口（否則近12個月報酬率算不出來）。
    """
    query = "SELECT stock_code, trade_date, close FROM daily_prices"
    params = ()
    if min_date:
        lookback_start = (pd.Timestamp(min_date) - pd.Timedelta(days=400)).strftime("%Y-%m-%d")
        query += " WHERE trade_date >= ?"
        params = (lookback_start,)
    df = pd.read_sql(query, conn, params=params)
    if df.empty:
        return pd.DataFrame(columns=["trade_date", "stock_code", "rs_raw"])

    pivot = df.pivot(index="trade_date", columns="stock_code", values="close").sort_index()
    r3 = pivot.pct_change(63, fill_method=None)
    r6 = pivot.pct_change(126, fill_method=None)
    r9 = pivot.pct_change(189, fill_method=None)
    r12 = pivot.pct_change(252, fill_method=None)
    raw = 0.4 * r3 + 0.2 * r6 + 0.2 * r9 + 0.2 * r12

    long_df = raw.stack().rename("rs_raw").reset_index()
    long_df.columns = ["trade_date", "stock_code", "rs_raw"]
    return long_df


def update_rs_ratings(conn, trade_dates) -> int:
    """
    對指定的 trade_dates（通常是這次有更新資料的交易日），用「當天全市場」的
    rs_raw 做百分位排名，換算成 1-99 的 RS值，寫回 technical_indicators.rs_rating。
    排名基準一律是全市場（不受這次只算單一股票/鎖股清單影響），因為RS本來就是
    跟大盤所有股票比較出來的相對強度，縮小樣本會失去意義。
    """
    trade_dates = sorted(set(trade_dates))
    if not trade_dates:
        return 0

    raw_long = compute_rs_raw_scores(conn, min_date=trade_dates[0])
    raw_long = raw_long[raw_long["trade_date"].isin(trade_dates)]
    raw_long = raw_long.dropna(subset=["rs_raw"])
    if raw_long.empty:
        return 0

    raw_long["rs_rating"] = (
        raw_long.groupby("trade_date")["rs_raw"].rank(pct=True) * 98 + 1
    ).round().astype(int)

    cur = conn.cursor()
    cur.executemany(
        "UPDATE technical_indicators SET rs_rating = ? WHERE stock_code = ? AND trade_date = ?",
        raw_long[["rs_rating", "stock_code", "trade_date"]].values.tolist(),
    )
    conn.commit()
    return len(raw_long)


def compute_for_stock(conn, stock_code: str):
    df = pd.read_sql(
        "SELECT trade_date, open, high, low, close, volume FROM daily_prices "
        "WHERE stock_code = ? ORDER BY trade_date",
        conn, params=(stock_code,),
    )
    if len(df) < 5:
        return 0, set()

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
    return len(out), set(out["trade_date"])


def run(all_stocks: bool = False, stock_code: str = None, watchlist: str = None,
        skip_rs: bool = False):
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
    touched_dates = set()
    for code in tqdm(codes):
        _, dates = compute_for_stock(conn, code)
        touched_dates |= dates
    conn.commit()

    if not skip_rs and touched_dates:
        if all_stocks:
            rs_dates = touched_dates  # --all：全歷史重建，逐日都要重新排名
        else:
            # 增量/單檔/鎖股清單模式：compute_for_stock 每次都會重算該股全部歷史，
            # touched_dates 可能涵蓋整段歷史，但RS排名只需要「最近」這幾天有意義
            # （更早的日期在之前的每日更新已經排過名了），限制在近15天內節省時間。
            cutoff = (pd.Timestamp(max(touched_dates)) - pd.Timedelta(days=15)).strftime("%Y-%m-%d")
            rs_dates = {d for d in touched_dates if d >= cutoff}
        print(f"計算 RS值（相對強度，對照 {len(rs_dates)} 個交易日的全市場排名）...")
        n = update_rs_ratings(conn, rs_dates)
        print(f"RS值已更新 {n} 筆。")

    conn.close()
    print("技術指標計算完成。")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--all", action="store_true", help="重算全部股票（含完整歷史）")
    parser.add_argument("--code", type=str, default=None, help="只算單一股票代碼，例如 2330")
    parser.add_argument("--watchlist", type=str, default=None,
                         help="鎖股清單檔案路徑（.json 或 .csv），只算清單內的股票")
    parser.add_argument("--skip-rs", action="store_true",
                         help="跳過RS值（相對強度）排名計算，只算其他技術指標（較快）")
    args = parser.parse_args()
    run(all_stocks=args.all, stock_code=args.code, watchlist=args.watchlist,
        skip_rs=args.skip_rs)


if __name__ == "__main__":
    main()
