"""
持股分析：讀取一份「鎖股名單」（通常是 generate_watchlist.py 或先前對話產生的
鎖股名單.json/csv），比對資料庫最新資料，逐檔算出目前狀態、累積漲跌、是否觸及
停損/停利、目前型態訊號是否延續或反轉，並給出續抱/減碼/出場建議。

用法：
    python analysis/generate_holdings_report.py 鎖股名單.json --out reports/holdings/latest.md
    python analysis/generate_holdings_report.py 鎖股名單.json --out report.md --compare-new

--compare-new：額外做「每日追蹤複查」三分類比較（存活／跌出名單／新進榜），
    對應 SKILL.md「每日節奏」段落描述的複查流程：不用每次重新篩選全市場，
    只比較這份清單目前的存活狀況，以及「目前原則」新符合門檻、但還不在清單裡的股票。

停損/停利判斷依據（對應 entry_exit_rules.md）：
    1. 百分比停損：累積虧損達 7% 一律出場（不分做多/做空）
    2. 趨勢停損：均線排列轉向（做多轉空排 / 做空轉多排），不論盈虧出場
    3. K線停損：跌破（做多）／突破（做空）持有期間最低/最高點

輸入清單格式盡量比照 generate_watchlist.py 的輸出（含 代碼/名稱/direction/資料日期/
收盤價），也接受只有代碼清單的簡化格式（此時無法算進場漲跌，只呈現目前狀態）。
"""
import argparse
import csv
import json
import os
import sys

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from config import get_connection
from analysis.signals import load_recent_snapshot, get_latest_trade_date, compute_pattern_signals

PCT_STOP_LOSS = -7.0  # 百分比停損門檻（%），對應 entry_exit_rules.md 5-7%停損取上限


def _to_float(v):
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def load_holdings(path: str) -> list:
    if not os.path.exists(path):
        raise FileNotFoundError(f"找不到持股清單檔案：{path}")
    ext = os.path.splitext(path)[1].lower()
    if ext == ".json":
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        rows = data.get("鎖股名單") or data.get("stocks") or [] if isinstance(data, dict) else data
    elif ext == ".csv":
        with open(path, encoding="utf-8-sig", newline="") as f:
            rows = list(csv.DictReader(f))
    else:
        raise ValueError(f"不支援的格式：{ext}（只支援 .json / .csv）")

    holdings = []
    for item in rows:
        if isinstance(item, str):
            holdings.append({"代碼": item, "名稱": None, "direction": "做多",
                              "資料日期": None, "收盤價": None})
            continue
        code = item.get("代碼") or item.get("code") or item.get("stock_code")
        if not code:
            continue
        holdings.append({
            "代碼": str(code).strip(),
            "名稱": item.get("名稱"),
            "direction": item.get("direction") or "做多",
            "資料日期": item.get("資料日期"),
            "收盤價": _to_float(item.get("收盤價")),
        })
    if not holdings:
        raise ValueError(f"持股清單是空的：{path}")
    return holdings


def _lookup_close(conn, code: str, on_or_before: str):
    cur = conn.cursor()
    cur.execute(
        "SELECT close FROM daily_prices WHERE stock_code = ? AND trade_date <= ? "
        "ORDER BY trade_date DESC LIMIT 1",
        (code, on_or_before),
    )
    row = cur.fetchone()
    return row[0] if row else None


def _lookup_extreme(conn, code: str, since_date: str, direction: str):
    cur = conn.cursor()
    col = "MIN(low)" if direction == "做多" else "MAX(high)"
    cur.execute(
        f"SELECT {col} FROM daily_prices WHERE stock_code = ? AND trade_date >= ?",
        (code, since_date),
    )
    row = cur.fetchone()
    return row[0] if row and row[0] is not None else None


def analyze_holding(conn, h: dict, scored: pd.DataFrame) -> dict:
    code = h["代碼"]
    direction = h.get("direction") or "做多"
    entry_date = h.get("資料日期")
    entry_price = h.get("收盤價")

    match = scored[scored["stock_code"] == code]
    if match.empty:
        return {**h, "狀態": "查無最新技術指標資料（可能已下市、剛掛牌不滿20天，或代碼有誤）"}
    cur = match.iloc[0]

    if entry_price is None and entry_date:
        entry_price = _lookup_close(conn, code, entry_date)

    pnl_pct = None
    if entry_price:
        raw = (cur["close"] / entry_price - 1) * 100
        pnl_pct = raw if direction == "做多" else -raw

    kline_stop = False
    if entry_date:
        extreme = _lookup_extreme(conn, code, entry_date, direction)
        if extreme is not None:
            kline_stop = cur["close"] < extreme if direction == "做多" else cur["close"] > extreme

    trend_stop = (
        (direction == "做多" and cur["ma_alignment"] == "空排")
        or (direction == "做空" and cur["ma_alignment"] == "多排")
    )
    pct_stop = pnl_pct is not None and pnl_pct <= PCT_STOP_LOSS

    same_score = cur["bull_score"] if direction == "做多" else cur["bear_score"]
    oppo_score = cur["bear_score"] if direction == "做多" else cur["bull_score"]
    same_signals = cur["bull_signals"] if direction == "做多" else cur["bear_signals"]
    oppo_signals = cur["bear_signals"] if direction == "做多" else cur["bull_signals"]

    if pct_stop:
        action = f"出場（觸及{abs(PCT_STOP_LOSS):.0f}%百分比停損）"
    elif trend_stop:
        action = "出場（均線排列轉向，趨勢停損）"
    elif kline_stop:
        side = "跌破" if direction == "做多" else "突破"
        action = f"出場（{side}持有期間關鍵K線價位）"
    elif oppo_score >= 3:
        action = "減碼觀察（出現多個反向訊號）"
    elif same_score >= 2:
        action = "續抱"
    else:
        action = "續抱（訊號轉弱，觀察中）"

    return {
        **h,
        "收盤價": round(entry_price, 2) if entry_price is not None else None,
        "目前價": round(cur["close"], 2),
        "累積漲跌(%)": round(pnl_pct, 2) if pnl_pct is not None else None,
        "目前型態訊號": "、".join(same_signals) or "（無）",
        "反向訊號": "、".join(oppo_signals) or "（無）",
        "均線排列": cur["ma_alignment"],
        "RS值": cur["rs_rating"],
        "建議": action,
    }


def build_new_candidates(scored: pd.DataFrame, min_score: int, top_n: int) -> list:
    strong = scored[scored["bull_score"] >= min_score].sort_values(
        ["bull_score", "vol_ratio"], ascending=[False, False]).head(top_n)
    return strong["stock_code"].tolist()


def build_report(conn, holdings_path: str, compare_new: bool, min_score: int, top_new: int) -> str:
    latest_date = get_latest_trade_date(conn)
    df = load_recent_snapshot(conn, lookback_days=20)
    scored = compute_pattern_signals(df)
    holdings = load_holdings(holdings_path)
    results = [analyze_holding(conn, h, scored) for h in holdings]

    lines = [
        f"# 持股分析報告 — {latest_date}", "",
        f"清單來源：`{holdings_path}`，共 {len(holdings)} 檔。資料截至 {latest_date}。", "",
        "| 代碼 | 名稱 | 方向 | 進場日 | 進場價 | 目前價 | 累積漲跌(%) | 建議 |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for r in results:
        lines.append(
            f"| {r.get('代碼','')} | {r.get('名稱') or ''} | {r.get('direction','')} | "
            f"{r.get('資料日期') or ''} | {r.get('收盤價', '') if r.get('收盤價') is not None else ''} | "
            f"{r.get('目前價', '')} | {r.get('累積漲跌(%)', '')} | {r.get('建議', r.get('狀態',''))} |"
        )
    lines.append("")

    exits = [r for r in results if str(r.get("建議", "")).startswith("出場")]
    if exits:
        lines.append("## 觸及停損/停利警示")
        for r in exits:
            lines.append(
                f"- **{r['代碼']} {r.get('名稱') or ''}**：{r['建議']}"
                f"（目前型態訊號：{r.get('目前型態訊號','')}；反向訊號：{r.get('反向訊號','')}）"
            )
        lines.append("")

    lines.append("## 個股詳情")
    for r in results:
        lines.append(f"### {r.get('代碼')} {r.get('名稱') or ''}（{r.get('direction')}）")
        if r.get("狀態"):
            lines.append(f"- {r['狀態']}")
        else:
            lines.append(
                f"- 進場：{r.get('資料日期') or '未知'} @ {r.get('收盤價')}；"
                f"目前：{r.get('目前價')}（累積 {r.get('累積漲跌(%)')}%）"
            )
            lines.append(f"- 均線排列：{r.get('均線排列')}；RS值：{r.get('RS值')}")
            lines.append(f"- 目前型態訊號：{r.get('目前型態訊號')}")
            lines.append(f"- 反向訊號：{r.get('反向訊號')}")
            lines.append(f"- **建議：{r.get('建議')}**")
        lines.append("")

    if compare_new:
        holding_codes = {h["代碼"] for h in holdings}
        new_codes = build_new_candidates(scored, min_score, top_new)
        new_in = [c for c in new_codes if c not in holding_codes]
        dropped = [
            f"{r['代碼']}({r.get('名稱') or ''})"
            for r in results
            if str(r.get("建議", "")).startswith("出場") or r.get("狀態")
        ]
        survived = len(holdings) - len(dropped)
        lines.append("## 每日追蹤複查（存活／跌出名單／新進榜）")
        lines.append(f"- 存活：{survived} / {len(holdings)} 檔")
        lines.append(f"- 跌出名單（觸及停損／查無資料）：{'、'.join(dropped) or '無'}")
        lines.append(f"- 新進榜（目前原則新符合門檻，尚未在清單內，最多列{top_new}檔）：" +
                      ("、".join(new_in) or "無"))
        lines.append("")

    lines.append("---")
    lines.append("本報告為技術指標條件篩選結果，僅供研究參考，不構成投資建議。")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="持股分析報告")
    parser.add_argument("watchlist", type=str, help="鎖股/持股清單檔案路徑（.json 或 .csv）")
    parser.add_argument("--out", type=str, default=None, help="輸出檔案路徑，不指定則印到stdout")
    parser.add_argument("--compare-new", action="store_true",
                         help="額外做每日追蹤複查（存活/跌出名單/新進榜三分類比較）")
    parser.add_argument("--min-score", type=int, default=3,
                         help="[--compare-new] 新進榜門檻的綜合分數，預設3")
    parser.add_argument("--top-new", type=int, default=10,
                         help="[--compare-new] 新進榜最多列幾檔，預設10")
    args = parser.parse_args()

    conn = get_connection()
    try:
        report = build_report(conn, args.watchlist, args.compare_new, args.min_score, args.top_new)
    finally:
        conn.close()

    if args.out:
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(report)
        print(f"持股分析報告已產生：{args.out}")
    else:
        print(report)


if __name__ == "__main__":
    main()
