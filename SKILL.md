# tw_stock_db — 台股歷史資料與技術指標

這個 repo 是 [tw-stock-db](https://github.com/sunneo/tw_stock_db) 爬蟲/資料庫系統的資料輸出，
搭配 `stock-pattern-analysis` Skill（型態學/技術分析選股方法論）使用。目的是讓其他 Claude
對話（或任何人）不需要重新爬 Yahoo Finance / TWSE，就能直接取得台股全上市櫃（約1985檔）
的日K與技術指標資料。

## 分支結構

本 repo 用兩個分支，分別對應不同的更新頻率與大小考量：

### `main` 分支 — 逐日增量資料（每個交易日更新一次）

```
daily/
├── 2026-07-24/
│   ├── stocks.csv                 當天股票基本清單（代碼/名稱/市場別，全量）
│   ├── daily_prices.csv           當天全部個股的OHLCV
│   ├── technical_indicators.csv   當天全部個股的技術指標
│   └── market_index.csv           當天大盤(TAIEX)/櫃買(TPEx)指數
├── 2026-07-25/
│   └── ...
```

每個資料夾只有數百KB，一般 commit，**保留完整逐日歷史**，可以回溯任何一天的資料。
這是預設的資料存取管道——大部分情況下只需要這個分支。

### `db-snapshot` 分支 — 完整資料庫（每月覆蓋一次，切割檔、不用 Git LFS）

```
tw_stock.db.manifest.json    切割清單 + 原始檔大小 + sha256（供合併後驗證）
tw_stock.db.part000          64MB
tw_stock.db.part001          64MB
tw_stock.db.part002          64MB
tw_stock.db.part003          64MB
tw_stock.db.part004          剩餘不足64MB的部分
merge_db.py                  合併腳本（純 Python 標準函式庫，單獨下載也能跑）
```

`tw_stock.db` 約300MB+，超過 GitHub 100MB 單檔上限。原本用 Git LFS，但 LFS 免費
額度只有每月 1GB 儲存 + 1GB 頻寬，每月整包推送很快會超額；改成**切割成每份 64MB
以內的 part 檔**，一般 git commit 就能推送，不需要 LFS、沒有額外額度限制。

這個分支**只在每月第一次執行每日更新時**用 orphan commit + force push 整個覆蓋，
永遠只保留最新一份快照、不留歷史。

**要拿完整 SQLite 資料庫（含2年歷史、方便直接查詢）**：

```bash
git clone --branch db-snapshot --single-branch --depth 1 https://github.com/sunneo/tw_stock_db.git
cd tw_stock_db
python merge_db.py     # 合併 part 檔回 tw_stock.db，並自動核對 sha256 checksum
```

不想跑 Python 的話，Linux/macOS 也可以直接：

```bash
cat tw_stock.db.part* > tw_stock.db
```

Windows cmd（part 檔名要照順序用 `+` 串接，不能用萬用字元，實際檔名以該次
`tw_stock.db.manifest.json` 裡的 `parts` 清單為準）：

```cmd
copy /b tw_stock.db.part000+tw_stock.db.part001+tw_stock.db.part002+tw_stock.db.part003+tw_stock.db.part004 tw_stock.db
```

## 資料表結構（tw_stock.db / CSV 欄位對照）

- `stocks`：`stock_code`(代碼) / `stock_name`(名稱) / `market`(TWSE上市/TPEx上櫃) / `sector_id` / `is_active`
- `daily_prices`：`stock_code` / `trade_date` / `open` / `high` / `low` / `close` / `volume`（成交股數，/1000換算成張）
- `technical_indicators`：`ma5/10/20/60`（均線）、`kd_k/kd_d`、`macd_dif/macd_macd/macd_osc`、
  `rsi6/rsi12`、`bb_upper/bb_mid/bb_lower`（布林通道）、`bias20`（20日乖離率）、
  `ma_alignment`（'多排'/'空排'/'交叉混雜'，5/10/20/60四線排列狀態）
- `market_index`：`index_code`('TAIEX'/'TPEx') / `trade_date` / OHLCV

## 更新方式

資料來源機器每個交易日收盤後（台灣時間約14:30後）跑一次
[`run_daily_update.py`](https://github.com/sunneo/tw_stock_db)（見上游 tw-stock-db 專案），
流程最後會呼叫 `sync/sync_to_github.py` 自動完成上述兩種同步。

## 給其他 Claude 對話的使用建議

- 只需要「最近幾天」的資料做分析 → 直接讀 `main` 分支 `daily/<日期>/*.csv`，不用 clone 整個 repo。
- 需要完整歷史（例如算長天期均線、回測） → clone `db-snapshot` 分支，跑
  `python merge_db.py` 合併出 `tw_stock.db`，用 sqlite3 直接查詢。
- 只需要「今天市場摘要 + 篩股結果的文字報告」 → 上游 tw-stock-db 專案本機也會產生
  `reports/latest.md`（純文字/Markdown，非本 repo 內容，需另外取得）。

## 已知限制

- 資料源為 Yahoo Finance，法人買賣超/融資融券等籌碼面資料尚未納入。
- `db-snapshot` 分支每月被 force push 覆蓋，**不要**依賴它的 commit 歷史；
  只信任該分支目前最新的那個 commit。
- 合併 part 檔前務必確認全部檔案都下載完整（`merge_db.py` 會核對 sha256，
  合併失敗代表某個 part 檔案不完整或損毀，需要重新下載）。
- 兩支股票（如 6174、8111）因公司名稱含 Big5/CP950 都無法解碼的罕見字，
  `stock_name` 會顯示亂碼字元，屬 TWSE 資料源本身限制。
