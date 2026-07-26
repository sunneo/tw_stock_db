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

### `db-snapshot` 分支 — 完整資料庫（每月覆蓋一次）

```
tw_stock.db   (Git LFS，約300MB+，SQLite，含近2年歷史)
```

`tw_stock.db` 超過 GitHub 100MB 單檔上限，必須用 Git LFS；而 LFS 免費額度只有
每月 1GB 儲存 + 1GB 頻寬，若每天整包推送會在幾天內用光。因此這個分支**只在每月
第一次執行每日更新時**用 orphan commit + force push 整個覆蓋，永遠只保留最新一份
快照、不留歷史，讓 LFS 用量維持在最小。

**要拿完整 SQLite 資料庫（含2年歷史、方便直接查詢）**，用淺層 clone 取最新快照即可：

```bash
git clone --branch db-snapshot --single-branch --depth 1 https://github.com/sunneo/tw_stock_db.git
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
- 需要完整歷史（例如算長天期均線、回測） → clone `db-snapshot` 分支拿 `tw_stock.db`，
  用 sqlite3 直接查詢。
- 只需要「今天市場摘要 + 篩股結果的文字報告」 → 上游 tw-stock-db 專案本機也會產生
  `reports/latest.md`（純文字/Markdown，非本 repo 內容，需另外取得）。

## 已知限制

- 資料源為 Yahoo Finance，法人買賣超/融資融券等籌碼面資料尚未納入。
- `db-snapshot` 分支每月被 force push 覆蓋，**不要**依賴它的 commit 歷史；
  只信任該分支目前最新的那個 commit。
- 兩支股票（如 6174、8111）因公司名稱含 Big5/CP950 都無法解碼的罕見字，
  `stock_name` 會顯示亂碼字元，屬 TWSE 資料源本身限制。
