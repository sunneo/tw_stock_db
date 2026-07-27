"""
產生「鎖股名單」（做多/做空鎖股清單），支援兩套判斷原則：

  --method current   目前原則：型態訊號評分（見 signals.py），做多/做空雙向，
                      對應既有「鎖股名單.json/csv」的欄位格式與評分邏輯。
  --method xq        XQ原則：RS值動能排行（見 signals.py），只挑做多方向
                      （RS值本質上是動能排行榜，不適合套同一套邏輯挑放空標的），
                      用來產生「下週鎖股名單（XQ原則）」。

用法：
    python analysis/generate_watchlist.py --method current --out 鎖股名單.json
    python analysis/generate_watchlist.py --method current --out 鎖股名單.csv --format csv
    python analysis/generate_watchlist.py --method xq --out 下週鎖股名單_XQ.json --top 20

輸出格式跟既有 鎖股名單.json / 鎖股名單.csv 相容（watchlist.py 可直接讀取「代碼」欄），
可以直接餵給 update_watchlist.py / capture_intraday.py --watchlist 等下游腳本。

設計動機：把「鎖股名單」的產生固定成程式碼，一次執行幾秒鐘出結果，取代過去每次
都要靠 Claude 手動下 SQL＋人工判斷型態訊號、再手刻 JSON 的做法（省時間也省 token）。
"""
import argparse
import csv
import json
import os
import sys

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from config import get_connection
from analysis.signals import load_recent_snapshot, compute_pattern_signals, xq_strong_stock_filter

DISCLAIMER = "技術面框架推演，非投資建議"


def _row_from_current(r: pd.Series, direction: str) -> dict:
    signals = r["bull_signals"] if direction == "做多" else r["bear_signals"]
    score = r["bull_score"] if direction == "做多" else r["bear_score"]
    return {
        "資料日期": r["trade_date"], "direction": direction,
        "代碼": r["stock_code"], "名稱": r["stock_name"], "產業": r["sector_name"],
        "市場": r["market"], "收盤價": round(r["close"], 2), "綜合分數": int(score),
        "型態訊號": "、".join(signals),
        "KD_K": round(r["kd_k"], 1) if pd.notna(r["kd_k"]) else None,
        "KD_D": round(r["kd_d"], 1) if pd.notna(r["kd_d"]) else None,
        "20日乖離率(%)": round(r["bias20"], 2) if pd.notna(r["bias20"]) else None,
        "近5日漲跌幅(%)": round(r["chg5"], 2) if r["chg5"] is not None else None,
        "量比": round(r["vol_ratio"], 2) if r["vol_ratio"] is not None else None,
    }


def build_current(conn, top_n: int, min_score: int) -> list:
    df = load_recent_snapshot(conn, lookback_days=20)
    scored = compute_pattern_signals(df)
    if scored.empty:
        return []
    long_side = scored[scored["bull_score"] >= min_score].sort_values(
        ["bull_score", "vol_ratio"], ascending=[False, False]).head(top_n)
    short_side = scored[scored["bear_score"] >= min_score].sort_values(
        ["bear_score", "vol_ratio"], ascending=[False, False]).head(top_n)
    rows = [_row_from_current(r, "做多") for _, r in long_side.iterrows()]
    rows += [_row_from_current(r, "做空") for _, r in short_side.iterrows()]
    return rows


def _row_from_xq(r: pd.Series) -> dict:
    signal_text = (
        f"XQ強勢股：RS值{int(r['rs_rating'])}、站穩季線、"
        f"量比{r['vol_ratio']:.2f}、距60日高點{r['dist_from_high60_pct']:.1f}%"
    )
    return {
        "資料日期": r["trade_date"], "direction": "做多",
        "代碼": r["stock_code"], "名稱": r["stock_name"], "產業": r["sector_name"],
        "市場": r["market"], "收盤價": round(r["close"], 2),
        "綜合分數": int(r["rs_rating"]), "型態訊號": signal_text,
        "RS值": int(r["rs_rating"]),
        "距60日高點(%)": round(r["dist_from_high60_pct"], 2),
        "量比": round(r["vol_ratio"], 2),
    }


def build_xq(conn, top_n: int, rs_threshold: int, min_vol_ratio: float,
             near_high_pct: float) -> list:
    df = load_recent_snapshot(conn, lookback_days=100)
    strong = xq_strong_stock_filter(
        df, rs_threshold=rs_threshold, min_vol_ratio=min_vol_ratio,
        near_high_pct=near_high_pct,
    ).head(top_n)
    return [_row_from_xq(r) for _, r in strong.iterrows()]


def write_json(rows: list, path: str, method: str):
    trade_date = rows[0]["資料日期"] if rows else None
    long_n = sum(1 for r in rows if r["direction"] == "做多")
    short_n = sum(1 for r in rows if r["direction"] == "做空")
    payload = {
        "資料日期": trade_date,
        "方法": "XQ原則(RS值動能)" if method == "xq" else "目前原則(型態訊號評分)",
        "說明": DISCLAIMER,
        "做多筆數": long_n, "做空筆數": short_n,
        "鎖股名單": rows,
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)


def write_csv(rows: list, path: str):
    if not rows:
        with open(path, "w", encoding="utf-8-sig") as f:
            f.write("")
        return
    fieldnames = list(rows[0].keys())
    for r in rows:
        for k in r:
            if k not in fieldnames:
                fieldnames.append(k)
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def main():
    parser = argparse.ArgumentParser(description="產生鎖股名單（做多/做空）")
    parser.add_argument("--method", choices=["current", "xq"], default="current",
                         help="current=目前原則(型態訊號評分,雙向)，xq=XQ原則(RS值動能,只做多)")
    parser.add_argument("--top", type=int, default=15, help="每個方向最多挑幾檔，預設15")
    parser.add_argument("--min-score", type=int, default=3,
                         help="[current] 綜合分數門檻，預設3")
    parser.add_argument("--rs-threshold", type=int, default=90, help="[xq] RS值門檻，預設90")
    parser.add_argument("--min-vol-ratio", type=float, default=0.8, help="[xq] 量比門檻，預設0.8")
    parser.add_argument("--near-high-pct", type=float, default=15.0,
                         help="[xq] 距60日高點百分比門檻，預設15")
    parser.add_argument("--format", choices=["json", "csv"], default="json")
    parser.add_argument("--out", type=str, required=True, help="輸出檔案路徑")
    args = parser.parse_args()

    conn = get_connection()
    try:
        if args.method == "current":
            rows = build_current(conn, args.top, args.min_score)
        else:
            rows = build_xq(conn, args.top, args.rs_threshold, args.min_vol_ratio,
                             args.near_high_pct)
    finally:
        conn.close()

    if args.format == "json":
        write_json(rows, args.out, args.method)
    else:
        write_csv(rows, args.out)
    print(f"已產生鎖股名單（{args.method}原則）：{len(rows)} 檔 -> {args.out}")


if __name__ == "__main__":
    main()
