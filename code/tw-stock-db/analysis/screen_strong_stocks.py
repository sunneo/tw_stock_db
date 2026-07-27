"""
挑選「強勢股」（N檔），支援兩套獨立判斷原則：

  --method current   目前原則（型態訊號評分，見 signals.py 開頭說明）
  --method xq        XQ原則（RS值/相對強度動能排行，見 signals.py 開頭說明）

用法：
    python analysis/screen_strong_stocks.py --method current --top 30
    python analysis/screen_strong_stocks.py --method xq --top 30
    python analysis/screen_strong_stocks.py --method xq --top 30 --rs-threshold 95
    python analysis/screen_strong_stocks.py --method current --top 30 --format json --out strong_stocks.json
    python analysis/screen_strong_stocks.py --method current --top 30 --format csv --out strong_stocks.csv

輸出格式（--format）：table（預設，印到終端機）、json、csv、md。
指定 --out 存檔；沒指定時 json/csv/md 會印到 stdout（方便直接被其他程式/Claude讀取）。

設計動機：這支腳本取代「每次都靠 Claude 手動下 SQL + 人工判斷」的做法，
把「強勢股」的判斷邏輯固定成程式碼，跑一次幾秒鐘就有結果，不用每次對話重新分析
全市場、也不會因為不同次分析邏輯有微妙差異而結果不一致。
"""
import argparse
import json
import os
import sys

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from config import get_connection
from analysis.signals import (
    load_recent_snapshot,
    get_latest_trade_date,
    compute_pattern_signals,
    xq_strong_stock_filter,
)


def screen_current(conn, top_n: int, min_score: int) -> pd.DataFrame:
    df = load_recent_snapshot(conn, lookback_days=20)
    scored = compute_pattern_signals(df)
    if scored.empty:
        return scored
    strong = scored[scored["bull_score"] >= min_score].copy()
    strong["signal_text"] = strong["bull_signals"].apply("、".join)
    strong = strong.sort_values(
        ["bull_score", "vol_ratio"], ascending=[False, False]
    ).head(top_n)
    return strong


def screen_xq(conn, top_n: int, rs_threshold: int, min_vol_ratio: float,
              near_high_pct: float) -> pd.DataFrame:
    df = load_recent_snapshot(conn, lookback_days=100)
    strong = xq_strong_stock_filter(
        df, rs_threshold=rs_threshold, min_vol_ratio=min_vol_ratio,
        near_high_pct=near_high_pct,
    )
    return strong.head(top_n)


CURRENT_COLS = [
    ("stock_code", "代碼"), ("stock_name", "名稱"), ("sector_name", "產業"),
    ("market", "市場"), ("close", "收盤價"), ("bull_score", "綜合分數"),
    ("signal_text", "型態訊號"), ("kd_k", "KD_K"), ("kd_d", "KD_D"),
    ("rs_rating", "RS值"), ("bias20", "20日乖離率(%)"),
    ("chg5", "近5日漲跌幅(%)"), ("vol_ratio", "量比"),
]

XQ_COLS = [
    ("stock_code", "代碼"), ("stock_name", "名稱"), ("sector_name", "產業"),
    ("market", "市場"), ("close", "收盤價"), ("rs_rating", "RS值"),
    ("dist_from_high60_pct", "距60日高點(%)"), ("vol_ratio", "量比"),
    ("ma20", "MA20"), ("ma60", "MA60"),
]


def format_output(df: pd.DataFrame, cols, fmt: str, title: str) -> str:
    if df.empty:
        return f"（{title}：無符合條件的股票）"

    display = pd.DataFrame({label: df[col].round(2) if df[col].dtype != object else df[col]
                             for col, label in cols})

    if fmt == "table":
        return f"{title}\n" + display.to_string(index=False)
    if fmt == "csv":
        return display.to_csv(index=False)
    if fmt == "md":
        header = "| " + " | ".join(display.columns) + " |"
        sep = "|" + "---|" * len(display.columns)
        rows = [
            "| " + " | ".join(str(v) for v in row) + " |"
            for row in display.itertuples(index=False)
        ]
        return "\n".join([f"# {title}", "", header, sep] + rows)
    if fmt == "json":
        return json.dumps(
            {"title": title, "count": len(display), "data": display.to_dict(orient="records")},
            ensure_ascii=False, indent=2,
        )
    raise ValueError(f"不支援的格式：{fmt}")


def main():
    parser = argparse.ArgumentParser(description="挑選強勢股（N檔）")
    parser.add_argument("--method", choices=["current", "xq"], default="current",
                         help="current=目前原則(型態訊號評分)，xq=XQ原則(RS值動能)")
    parser.add_argument("--top", type=int, default=30, help="挑選檔數，預設30")
    parser.add_argument("--min-score", type=int, default=2,
                         help="[current] 綜合分數門檻，預設2（至少比對到2個型態訊號）")
    parser.add_argument("--rs-threshold", type=int, default=90,
                         help="[xq] RS值門檻，預設90（約當前10%%最強）")
    parser.add_argument("--min-vol-ratio", type=float, default=0.8,
                         help="[xq] 量比門檻(今日量/5日均量)，預設0.8")
    parser.add_argument("--near-high-pct", type=float, default=15.0,
                         help="[xq] 距60日高點百分比門檻，預設15")
    parser.add_argument("--format", choices=["table", "json", "csv", "md"], default="table")
    parser.add_argument("--out", type=str, default=None, help="輸出檔案路徑，不指定則印到stdout")
    args = parser.parse_args()

    conn = get_connection()
    try:
        latest_date = get_latest_trade_date(conn)
        if args.method == "current":
            df = screen_current(conn, args.top, args.min_score)
            cols = CURRENT_COLS
            title = f"強勢股（目前原則，{latest_date}）"
        else:
            df = screen_xq(conn, args.top, args.rs_threshold, args.min_vol_ratio,
                            args.near_high_pct)
            cols = XQ_COLS
            title = f"強勢股（XQ原則，RS值>={args.rs_threshold}，{latest_date}）"

        output = format_output(df, cols, args.format, title)
    finally:
        conn.close()

    if args.out:
        with open(args.out, "w", encoding="utf-8-sig" if args.format == "csv" else "utf-8") as f:
            f.write(output)
        print(f"已輸出 {len(df)} 檔股票至 {args.out}")
    else:
        print(output)


if __name__ == "__main__":
    main()
