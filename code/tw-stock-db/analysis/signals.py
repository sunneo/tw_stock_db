"""
共用的訊號/評分邏輯，給 screen_strong_stocks.py / generate_watchlist.py /
generate_holdings_report.py 三支腳本共用，避免各自重複實作同一套判斷邏輯。

分成兩套獨立的「強勢股」判斷原則：

1. 「目前原則」（method="current"）：對應 SKILL.md 方法論摘要（朱家紅老師型態直播班／
   林穎老師型態圖形班），逐股比對 KD黃金/死亡交叉、MACD多空排列、紅柱/綠柱由縮轉長、
   放量紅/黑K、回後買上漲/彈後空下跌 這5組型態訊號，比對到幾個訊號就是「綜合分數」，
   做多/做空方向由 bull_score / bear_score 何者較高決定。這套邏輯重現了既有
   `鎖股名單.json`（人工產生的範例）背後的評分方式，最高分5分（5組訊號都比對到）。

2. 「XQ原則」（method="xq"）：對應 XQ全球贏家／IBD 常見的「RS值（相對強度）」動能選股法。
   核心指標是 technical_indicators.rs_rating（見 compute_indicators.py 的
   update_rs_ratings()：近3/6/9/12個月漲幅加權排名，1-99分，越高代表動能相對全市場越強）。
   XQ官方選股中心（sysjust-xq/XQStrategy repo）本身是一套泛用的選股「條件」腳本庫
   （依成交量/價格/籌碼/財務等分類的上百個 .xs 條件檔案），並沒有單一「強勢股」標準公式；
   這裡採用業界最常見、也最貼近RS值精神的組合：RS值排名前列 + 站穩季線（中期均線多頭）+
   量能未萎縮 + 價格貼近波段高點，做為「XQ原則強勢股」的具體判斷依據，見
   xq_strong_stock_filter() 的 docstring。若你有更貼近原意的具體門檻，直接調整
   這支檔案的常數/條件即可，不需要動其他腳本。
"""
import pandas as pd
import numpy as np


def get_latest_trade_date(conn) -> str:
    cur = conn.cursor()
    cur.execute("SELECT MAX(trade_date) FROM daily_prices")
    row = cur.fetchone()
    return row[0] if row else None


def load_recent_snapshot(conn, lookback_days: int = 20, codes: list = None) -> pd.DataFrame:
    """
    讀取「最近 lookback_days 天」全市場（或指定 codes）的 daily_prices + technical_indicators
    + stocks/sectors 合併資料，按 stock_code, trade_date 排序。

    lookback_days 建議依用途調整：
      - method="current" 的型態訊號比對，只需要看最近幾天（預設20天綽綽有餘）。
      - method="xq" 的「貼近60日高點」判斷，需要至少約90天（60個交易日 * 1.5緩衝）。
    """
    query = """
        SELECT dp.stock_code, s.stock_name, s.market, sec.sector_name,
               dp.trade_date, dp.open, dp.high, dp.low, dp.close, dp.volume,
               ti.ma5, ti.ma10, ti.ma20, ti.ma60, ti.vol_ma5,
               ti.kd_k, ti.kd_d, ti.macd_dif, ti.macd_macd, ti.macd_osc,
               ti.rsi6, ti.rsi12, ti.bb_upper, ti.bb_mid, ti.bb_lower,
               ti.bias20, ti.ma_alignment, ti.rs_rating
        FROM daily_prices dp
        JOIN stocks s ON s.stock_code = dp.stock_code
        LEFT JOIN sectors sec ON sec.sector_id = s.sector_id
        LEFT JOIN technical_indicators ti
            ON ti.stock_code = dp.stock_code AND ti.trade_date = dp.trade_date
        WHERE dp.trade_date >= (SELECT date(MAX(trade_date), ?) FROM daily_prices)
          AND s.is_active = 1
    """
    params = [f"-{lookback_days} day"]
    if codes:
        placeholders = ",".join("?" * len(codes))
        query += f" AND dp.stock_code IN ({placeholders})"
        params += list(codes)
    query += " ORDER BY dp.stock_code, dp.trade_date"
    return pd.read_sql(query, conn, params=params)


# ---------- 方法一：目前原則（型態訊號評分） ----------

def _score_group(g: pd.DataFrame):
    g = g.sort_values("trade_date").reset_index(drop=True)
    if len(g) < 3:
        return None
    t, y, z = g.iloc[-1], g.iloc[-2], g.iloc[-3]
    if pd.isna(t.kd_k) or pd.isna(t.macd_osc) or pd.isna(t.ma5) or pd.isna(t.vol_ma5):
        return None  # 技術指標還沒算出來（例如新股掛牌不滿20天），跳過

    bull, bear = [], []

    if t.kd_k > t.kd_d and y.kd_k <= y.kd_d and t.kd_d < 80:
        bull.append("KD黃金交叉")
    if t.kd_k < t.kd_d and y.kd_k >= y.kd_d and t.kd_d > 20:
        bear.append("KD死亡交叉")

    if t.macd_dif > t.macd_macd and t.macd_dif > 0:
        bull.append("MACD多頭")
    if t.macd_dif < t.macd_macd and t.macd_dif < 0:
        bear.append("MACD空頭")

    if t.macd_osc > 0 and t.macd_osc > y.macd_osc and y.macd_osc <= z.macd_osc:
        bull.append("紅柱由縮轉長")
    if t.macd_osc < 0 and t.macd_osc < y.macd_osc and y.macd_osc >= z.macd_osc:
        bear.append("綠柱由縮轉長")

    if t.vol_ma5 > 0 and t.volume > t.vol_ma5 * 1.2 and t.close > t.open:
        bull.append("放量紅K")
    if t.vol_ma5 > 0 and t.volume > t.vol_ma5 * 1.2 and t.close < t.open:
        bear.append("放量黑K")

    recent = g.iloc[max(0, len(g) - 6):-1]  # 今天以前最近5天（不含今天）
    if len(recent) >= 3:
        recent_low, recent_high = recent["low"].min(), recent["high"].max()
        if t.close > t.open and t.close >= t.ma5 and y.close < y.ma5 and t.low >= recent_low:
            bull.append("回後買上漲")
        if t.close < t.open and t.close <= t.ma5 and y.close > y.ma5 and t.high <= recent_high:
            bear.append("彈後空下跌")

    chg5 = None
    if len(g) >= 6:
        base = g.iloc[-6]["close"]
        if base:
            chg5 = (t.close / base - 1) * 100
    vol_ratio = (t.volume / t.vol_ma5) if t.vol_ma5 else None

    return {
        "stock_code": t.stock_code, "stock_name": t.stock_name, "market": t.market,
        "sector_name": t.sector_name, "trade_date": t.trade_date, "close": t.close,
        "open": t.open, "kd_k": t.kd_k, "kd_d": t.kd_d, "bias20": t.bias20,
        "rs_rating": t.rs_rating, "ma_alignment": t.ma_alignment,
        "chg5": chg5, "vol_ratio": vol_ratio,
        "bull_signals": bull, "bear_signals": bear,
        "bull_score": len(bull), "bear_score": len(bear),
    }


def compute_pattern_signals(df: pd.DataFrame) -> pd.DataFrame:
    """
    輸入 load_recent_snapshot() 的結果，回傳每檔股票「最新一天」的型態訊號評分表。
    欄位：stock_code/stock_name/market/sector_name/trade_date/close/...
          bull_signals(list)/bear_signals(list)/bull_score/bear_score
    """
    rows = [r for r in (_score_group(g) for _, g in df.groupby("stock_code")) if r is not None]
    if not rows:
        return pd.DataFrame()
    return pd.DataFrame(rows)


# ---------- 方法二：XQ原則（RS值動能） ----------

def xq_strong_stock_filter(df: pd.DataFrame, rs_threshold: int = 90,
                            min_vol_ratio: float = 0.8,
                            near_high_pct: float = 15.0) -> pd.DataFrame:
    """
    XQ原則強勢股篩選，取「最新一個交易日」的快照，條件（見本檔案開頭說明的方法論來源）：
      1. RS值 >= rs_threshold（相對全市場動能排名前列，預設90＝約當前10%最強）
      2. 站穩中期均線：收盤價 >= MA60，且 MA20 >= MA60（中期趨勢向上，非曇花一現）
      3. 量能未明顯萎縮：今日成交量 >= 5日均量 * min_vol_ratio（避免選到強勢但沒人要的量縮股）
      4. 價格貼近近60個交易日高點：收盤價距離高點在 near_high_pct % 以內
         （代表籌碼安定、隨時可能創新高，而非已經噴出一大段的末端）

    輸入的 df 建議用 load_recent_snapshot(conn, lookback_days=100) 抓夠算60日高點的資料。
    回傳依 rs_rating 由高到低排序。
    """
    if df.empty:
        return df
    latest_date = df["trade_date"].max()

    high60 = (
        df.sort_values("trade_date")
        .groupby("stock_code")["high"]
        .apply(lambda s: s.tail(60).max())
        .rename("high60")
    )
    latest = df[df["trade_date"] == latest_date].merge(high60, on="stock_code")
    latest = latest.dropna(subset=["rs_rating", "ma20", "ma60", "vol_ma5"])
    latest["dist_from_high60_pct"] = (latest["high60"] - latest["close"]) / latest["high60"] * 100
    latest["vol_ratio"] = latest["volume"] / latest["vol_ma5"]

    cond = (
        (latest["rs_rating"] >= rs_threshold)
        & (latest["close"] >= latest["ma60"])
        & (latest["ma20"] >= latest["ma60"])
        & (latest["vol_ratio"] >= min_vol_ratio)
        & (latest["dist_from_high60_pct"] <= near_high_pct)
    )
    return latest[cond].sort_values("rs_rating", ascending=False)
