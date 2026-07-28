"""
每日更新完成後，產生一份文字報告（Markdown），彙整大盤環境與符合技術訊號的個股清單。

用途：這份報告是給「人」或「其他 Claude 對話」讀的靜態文字檔，不是給程式解析用的資料表。
其他 Claude Code 對話只要開在同一個專案目錄下，就可以直接讀取 reports/latest.md
取得「最新一次收盤後」的市場摘要，不需要重新查資料庫。

輸出：
    reports/latest.md          最新一份（每次執行覆蓋，供分享/共用）
    reports/daily/YYYY-MM-DD.md   當日存檔（保留歷史紀錄，不覆蓋）

用法：
    python analysis/generate_daily_report.py
"""
import os
import sys
import sqlite3

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from config import DB_PATH, get_connection

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPORTS_DIR = os.path.join(BASE_DIR, "reports")
DAILY_DIR = os.path.join(REPORTS_DIR, "daily")

TOP_N = 30  # 每個訊號清單最多列出幾檔（依成交量排序，避免報告過長）


def get_two_latest_dates(conn) -> tuple[str, str]:
    dates = pd.read_sql(
        "SELECT DISTINCT trade_date FROM technical_indicators ORDER BY trade_date DESC LIMIT 2",
        conn,
    )["trade_date"].tolist()
    if len(dates) < 2:
        raise RuntimeError("technical_indicators 資料不足兩個交易日，無法比對訊號")
    return dates[0], dates[1]  # today, prev


def load_indicator_snapshot(conn, trade_date: str) -> pd.DataFrame:
    return pd.read_sql(
        """
        SELECT ti.stock_code, s.stock_name, s.market,
               dp.close AS price_close, dp.volume AS price_volume,
               ti.ma5, ti.ma10, ti.ma20, ti.ma60, ti.vol_ma5,
               ti.kd_k, ti.kd_d, ti.macd_dif, ti.macd_macd, ti.macd_osc,
               ti.rsi6, ti.rsi12, ti.bb_upper, ti.bb_mid, ti.bb_lower,
               ti.bias20, ti.ma_alignment
        FROM technical_indicators ti
        JOIN stocks s ON s.stock_code = ti.stock_code
        JOIN daily_prices dp ON dp.stock_code = ti.stock_code AND dp.trade_date = ti.trade_date
        WHERE ti.trade_date = ?
        """,
        conn,
        params=(trade_date,),
    )


def _index_line(conn, index_code: str, label: str) -> str:
    df = pd.read_sql(
        "SELECT trade_date, close FROM market_index WHERE index_code = ? ORDER BY trade_date",
        conn, params=(index_code,),
    )
    if len(df) < 21:
        return f"- {label}：資料不足，略過"
    df["ma20"] = df["close"].rolling(20).mean()
    df["ma60"] = df["close"].rolling(60).mean() if len(df) >= 60 else None
    last, prev = df.iloc[-1], df.iloc[-6] if len(df) >= 6 else df.iloc[0]
    chg1 = (df.iloc[-1]["close"] / df.iloc[-2]["close"] - 1) * 100
    chg5 = (last["close"] / prev["close"] - 1) * 100
    pos_ma20 = "站上" if last["close"] >= last["ma20"] else "跌破"
    ma60_txt = ""
    if last["ma60"] is not None and pd.notna(last["ma60"]):
        pos_ma60 = "站上" if last["close"] >= last["ma60"] else "跌破"
        ma60_txt = f"，{pos_ma60}季線(MA60)"
    return (
        f"- {label}（{df.iloc[-1]['trade_date']}）：收 {last['close']:.2f}，"
        f"單日 {chg1:+.2f}%，近5日 {chg5:+.2f}%，{pos_ma20}月線(MA20){ma60_txt}"
    )


def market_summary(conn) -> str:
    lines = ["## 大盤環境", "", "### 台股"]
    for index_code, label in [("TAIEX", "加權指數"), ("TPEx", "櫃買指數")]:
        lines.append(_index_line(conn, index_code, label))
    lines.append("")
    lines.append("### 美股觀察指標（隔夜，領先參考用，見 SKILL 美股連動判讀規則）")
    for index_code, label in [("SOX", "費城半導體"), ("SPX", "標普500"), ("NASDAQ", "那斯達克綜合"), ("DJI", "道瓊工業指數")]:
        lines.append(_index_line(conn, index_code, label))
    lines.append("")
    return "\n".join(lines)


def build_signal_tables(today: pd.DataFrame, prev: pd.DataFrame) -> dict:
    merged = today.merge(prev, on="stock_code", suffixes=("_t", "_y"))

    signals = {}

    signals["四線多排 + KD黃金交叉"] = merged[
        (merged["ma_alignment_t"] == "多排")
        & (merged["kd_k_t"] > merged["kd_d_t"])
        & (merged["kd_k_y"] <= merged["kd_d_y"])
        & (merged["kd_d_t"] < 80)
    ]

    signals["MACD 由空翻多（柱狀圖轉正）"] = merged[
        (merged["macd_osc_y"] <= 0) & (merged["macd_osc_t"] > 0)
    ]

    signals["RSI 低檔黃金交叉（RSI6上穿RSI12，RSI12<50）"] = merged[
        (merged["rsi12_t"] < 50)
        & (merged["rsi6_y"] <= merged["rsi12_y"])
        & (merged["rsi6_t"] > merged["rsi12_t"])
    ]

    signals["貼近布林下軌反彈"] = merged[
        (merged["price_close_y"] <= merged["bb_lower_y"])
        & (merged["price_close_t"] > merged["bb_lower_t"])
    ]

    signals["均線由多排轉空排（跌破月線警示）"] = merged[
        (merged["ma_alignment_t"] == "空排") & (merged["ma_alignment_y"] == "多排")
    ]

    signals["乖離率過熱警示（BIAS20 > 15%）"] = merged[merged["bias20_t"] > 15]

    return signals


def render_signal_section(title: str, df: pd.DataFrame) -> str:
    lines = [f"## {title}", ""]
    if df.empty:
        lines.append("（今日無符合條件的個股）")
        lines.append("")
        return "\n".join(lines)

    ranked = df.sort_values("price_volume_t", ascending=False).head(TOP_N)
    lines.append(f"共 {len(df)} 檔符合，列出前 {min(TOP_N, len(df))} 檔（依成交量排序）：")
    lines.append("")
    lines.append("| 代碼 | 名稱 | 市場 | 收盤 | 成交量(張) |")
    lines.append("|---|---|---|---|---|")
    for _, row in ranked.iterrows():
        lines.append(
            f"| {row['stock_code']} | {row['stock_name_t']} | {row['market_t']} "
            f"| {row['price_close_t']:.2f} | {int(row['price_volume_t'] // 1000):,} |"
        )
    lines.append("")
    return "\n".join(lines)


def generate() -> str:
    conn = get_connection()
    try:
        today_date, prev_date = get_two_latest_dates(conn)
        today_df = load_indicator_snapshot(conn, today_date)
        prev_df = load_indicator_snapshot(conn, prev_date)
        signals = build_signal_tables(today_df, prev_df)

        parts = [
            f"# 台股每日技術面報告 — {today_date}",
            "",
            f"資料日期：{today_date}（對照前一交易日 {prev_date}）， "
            f"共 {len(today_df)} 檔個股納入計算。",
            "",
            market_summary(conn),
        ]
        for title, df in signals.items():
            parts.append(render_signal_section(title, df))

        parts.append("---")
        parts.append(
            "本報告為技術指標條件篩選結果，僅供研究參考，不構成投資建議。"
            "訊號定義見 analysis/generate_daily_report.py。"
        )
        return "\n".join(parts)
    finally:
        conn.close()


def main():
    os.makedirs(DAILY_DIR, exist_ok=True)
    report = generate()

    today_date = report.split("\n", 1)[0].split(" — ")[-1].strip()

    latest_path = os.path.join(REPORTS_DIR, "latest.md")
    with open(latest_path, "w", encoding="utf-8") as f:
        f.write(report)

    daily_path = os.path.join(DAILY_DIR, f"{today_date}.md")
    with open(daily_path, "w", encoding="utf-8") as f:
        f.write(report)

    print(f"報告已產生：{latest_path}")
    print(f"歷史存檔：{daily_path}")


if __name__ == "__main__":
    main()
