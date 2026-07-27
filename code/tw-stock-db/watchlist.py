"""
讀取「鎖股清單」檔案（.json 或 .csv），回傳股票代碼清單。
給 scrapers/fetch_daily_prices.py、scrapers/fetch_intraday_quotes.py、
analysis/compute_indicators.py 的 --watchlist 參數共用。

支援格式：

    JSON（都可以）：
        ["2330", "2317", "00929"]
        [{"code": "2330"}, {"code": "2317", "name": "鴻海"}]
        {"stocks": ["2330", "2317"]}
        {"鎖股名單": [{"代碼": "2330", "名稱": "台積電", ...}, ...]}   <- stock-pattern-analysis
                                                                        Skill 選股結果的原生格式

    CSV：
        有 header 且欄名包含 code / stock_code / 代碼 / 股票代碼：
            代碼,名稱,...
            2330,台積電,...
        沒有 header：每行第一欄當代碼。

代碼順序保留、自動去重複、忽略空白列。
"""
import csv
import json
import os


def load_watchlist(path: str) -> list[str]:
    if not os.path.exists(path):
        raise FileNotFoundError(f"找不到鎖股清單檔案：{path}")

    ext = os.path.splitext(path)[1].lower()
    if ext == ".json":
        codes = _load_json(path)
    elif ext == ".csv":
        codes = _load_csv(path)
    else:
        raise ValueError(f"不支援的鎖股清單格式：{ext}（只支援 .json / .csv）")

    seen = set()
    unique_codes = []
    for code in codes:
        code = str(code).strip()
        if code and code not in seen:
            seen.add(code)
            unique_codes.append(code)

    if not unique_codes:
        raise ValueError(f"鎖股清單是空的：{path}")
    return unique_codes


def _load_json(path: str) -> list[str]:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)

    if isinstance(data, dict):
        data = (
            data.get("鎖股名單")
            or data.get("stocks")
            or data.get("codes")
            or []
        )

    codes = []
    for item in data:
        if isinstance(item, dict):
            code = item.get("code") or item.get("stock_code") or item.get("代碼") or item.get("股票代碼")
        else:
            code = item
        if code is not None:
            codes.append(str(code))
    return codes


def _load_csv(path: str) -> list[str]:
    with open(path, encoding="utf-8-sig", newline="") as f:
        reader = csv.reader(f)
        rows = [row for row in reader if row and row[0].strip()]

    if not rows:
        return []

    header = [h.strip().lower() for h in rows[0]]
    code_col_names = ("code", "stock_code", "代碼", "股票代碼")
    if any(h in code_col_names for h in header):
        code_idx = next(i for i, h in enumerate(header) if h in code_col_names)
        return [row[code_idx] for row in rows[1:]]

    # 沒有可辨識的 header，當作每行第一欄就是代碼（含第一行）
    return [row[0] for row in rows]
