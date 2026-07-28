# 台股資料庫與爬蟲（Phase 2）

搭配 `stock-pattern-analysis` Skill 使用的資料層。負責抓取全上市櫃（約1700檔）個股的日K
資料，計算技術指標，存入 SQLite 資料庫，供後續報表（週走圖、持股診斷、盤後分析）使用。

## 目錄結構

```
tw-stock-db/
├── config.py                      # 共用設定（DB路徑、參數、DB連線）
├── watchlist.py                   # 讀取鎖股清單（.json/.csv），多支腳本共用
├── requirements.txt
├── run_daily_update.py            # 每日更新主流程（一鍵跑完整套：全市場）
├── update_stock.py                # 只更新單一股票（抓OHLCV+算指標）
├── update_watchlist.py            # 只更新鎖股清單裡的股票（抓OHLCV+算指標+同步GitHub）
├── capture_intraday.py            # 盤中擷取（例如中午跑一次，見下方說明）
├── db/
│   ├── schema.sql                 # 資料表定義
│   └── init_db.py                 # 建立資料庫
├── scrapers/
│   ├── get_stock_list.py          # 抓取全部股票代碼/名稱清單
│   ├── fetch_daily_prices.py      # 抓取個股日K（Yahoo Finance，平行抓取）
│   ├── fetch_intraday_quotes.py   # 抓盤中即時快照（平行抓取）
│   └── fetch_market_index.py      # 抓取加權指數/櫃買指數 + 美股觀察指標(SOX/SPX/NASDAQ/DJI)
├── analysis/
│   ├── compute_indicators.py      # 計算 MA/KD/MACD/RSI/布林/乖離/均線排列/RS值(相對強度)
│   ├── generate_daily_report.py   # 產生每日文字報告
│   ├── signals.py                 # 共用訊號評分邏輯（型態訊號評分＋XQ原則RS值篩選）
│   ├── screen_strong_stocks.py    # 強勢股(N檔)篩選：--method current|xq
│   ├── generate_watchlist.py      # 產生鎖股名單：--method current|xq
│   └── generate_holdings_report.py # 持股分析報告（P/L、停損停利、續抱/減碼/出場建議）
└── sync/
    └── sync_to_github.py          # 同步到 GitHub（sunneo/tw_stock_db）
```

## 安裝

```bash
cd tw-stock-db
python -m venv venv
source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

## 初次建置（首次執行，抓歷史資料）

```bash
python db/init_db.py
python scrapers/get_stock_list.py
python scrapers/fetch_market_index.py --period 2y
python scrapers/fetch_daily_prices.py --period 2y     # 約1700檔，會需要一段時間
python analysis/compute_indicators.py --all
```

`fetch_daily_prices.py` 用多執行緒平行抓取（預設平行度 = CPU核心數，可用 `--workers`
覆蓋），比逐檔序列抓取快上數倍；每個執行緒仍保留 `REQUEST_DELAY_SEC` 的請求間隔，
避免對 Yahoo Finance 太密集。DB 寫入固定在主執行緒序列化執行，避免 SQLite 併發寫入問題。
如果中途失敗的股票，可以查詢 `fetch_log` 資料表找出 `status='failed'` 的代碼，針對性重跑。

## 只更新單一股票

不用跑全市場的每日更新，只想抓/補某一支股票的資料時：

```bash
python update_stock.py 2330                  # 預設抓最近5天（增量）
python update_stock.py 2330 --period 2y      # 抓完整2年歷史
python update_stock.py 2330 --start 2024-01-01 --end 2024-12-31
```

會依序抓該股票的OHLCV、寫入 `daily_prices`，然後只重算這支股票的技術指標
（`technical_indicators`）。如果代碼還不在 `stocks` 資料表裡（例如剛上市的新股、
或被 `get_stock_list.py` 過濾掉的ETF），會自動用 Yahoo Finance 判斷是上市(.TW)
還是上櫃(.TWO)，並自動註冊進 `stocks` 表，不需要手動維護清單。

底層也可以分開單獨呼叫：

```bash
python scrapers/fetch_daily_prices.py --code 2330 --period 2y
python analysis/compute_indicators.py --code 2330
```

## 更新「鎖股清單」裡的股票

鎖股清單是 `stock-pattern-analysis` Skill 選股結果的清單檔案（例如週選股報表匯出的
`鎖股名單.json` / `鎖股名單.csv`），只想針對這份清單裡的股票抓資料、算指標、同步到
GitHub，不用跑全市場：

```bash
python update_watchlist.py 鎖股名單.json
python update_watchlist.py 鎖股名單.csv --period 2y
python update_watchlist.py 鎖股名單.json --no-sync     # 只更新DB，不推到GitHub
```

會平行抓取清單內所有股票的OHLCV（平行度同樣預設為CPU核心數）、只重算這些股票的
技術指標、最後同步到 GitHub（見下方「同步到 GitHub」）。

**支援的清單格式**（見 [watchlist.py](watchlist.py) 完整說明）：

- JSON：`["2330", "2317"]`、`[{"code": "2330"}]`，或 Skill 選股結果原生格式
  `{"鎖股名單": [{"代碼": "2330", "名稱": "台積電", ...}, ...]}`
- CSV：有 header 且欄名包含 `code` / `stock_code` / `代碼` / `股票代碼` 其中之一，
  或沒有 header 時每行第一欄當代碼。

底層也可以分開單獨呼叫（跟 `--code` 用法一致，只是換成 `--watchlist`）：

```bash
python scrapers/fetch_daily_prices.py --watchlist 鎖股名單.json --period 2y
python analysis/compute_indicators.py --watchlist 鎖股名單.json
```

## 盤中擷取（例如每天中午跑一次）

`daily_prices` 只在收盤後才有完整意義的OHLCV；如果想在**交易時間內**（例如中午
12:00）就看一下鎖股清單目前半場表現，不用等到收盤，用 `capture_intraday.py`：

```bash
python capture_intraday.py --watchlist 鎖股名單.json
python capture_intraday.py --code 2330
python capture_intraday.py --all              # 全市場，量大，建議只在真的需要時用
python capture_intraday.py --watchlist 鎖股名單.json --no-sync
```

資料來源是 Yahoo Finance 當天的1分鐘K棒（`period=1d, interval=1m`），彙整出「當日
截至擷取當下」的開盤/最高/最低/最新成交價/累計成交量，寫入獨立的 `intraday_quotes`
資料表（跟 `daily_prices` 分開存放，兩者不會互相污染，也**不會**觸發技術指標重算）。
盤前或非交易日執行會抓不到資料（記錄為 `no_data`，不算失敗）。

會同步匯出到 GitHub 的 `daily/<今天日期>/intraday_quotes.csv`（只有真的擷取過才會
產生這個檔案）。

**Windows工作排程器設定**（跟每日更新分開排一個新工作）：
1. 觸發條件：每天，時間設 12:00，僅限週一至週五
2. 動作：啟動程式 `C:\path\to\venv\Scripts\python.exe`，
   引數 `capture_intraday.py --watchlist 鎖股名單.json`，
   啟動位置設為 `C:\path\to\tw-stock-db`

## 每日更新（排程用）

```bash
python run_daily_update.py
python run_daily_update.py --weekly                             # + 週報（強勢股/鎖股名單，目前+XQ原則）
python run_daily_update.py --holdings 鎖股名單.json                # + 持股分析報告
python run_daily_update.py --weekly --holdings 鎖股名單.json
```

基本流程會依序執行：更新股票清單 → 抓大盤指數 → 抓個股近5天OHLCV（增量+補漏）→
重算技術指標(含RS值) → 產生每日文字報告 → 同步到 GitHub。建議排程在**台灣時間每個
交易日下午 2:30 之後**執行（此時當日收盤資料在 Yahoo Finance 上通常已經可以抓到）。

`--weekly` / `--holdings` 是額外的可選流程（見上方「強勢股/鎖股名單/持股分析」段落），
預設不執行，避免每天都跑成本較高的全市場篩選；適合排一個**每週**額外執行 `--weekly`
的排程，或想更新持股追蹤時手動加 `--holdings`。

### 每日報告（供分享給其他 Claude 對話）

每次 `run_daily_update.py` 跑完，最後一步會產生：

- `reports/latest.md`：**固定路徑**，每次覆蓋，內容為大盤環境摘要 + 幾種技術訊號
  （四線多排+KD黃金交叉、MACD翻多、RSI低檔黃金交叉、貼近布林下軌反彈、均線轉空排警示、
  乖離率過熱警示）篩選出的個股清單。
- `reports/daily/YYYY-MM-DD.md`：當日存檔，不覆蓋，方便回顧歷史。

這是純文字/Markdown 檔，不需要重新查資料庫；只要開一個新的 Claude 對話、工作目錄指到
這個專案，就可以直接請它讀取 `reports/latest.md` 取得最新收盤後的市場摘要。也可以單獨執行：

```bash
python analysis/generate_daily_report.py
```

訊號篩選條件都定義在 [analysis/generate_daily_report.py](analysis/generate_daily_report.py) 裡，
可依需求調整門檻或新增訊號。

### 同步到 GitHub（sunneo/tw_stock_db）

`run_daily_update.py` 最後一步會呼叫 [sync/sync_to_github.py](sync/sync_to_github.py)，
把資料推到獨立的 [sunneo/tw_stock_db](https://github.com/sunneo/tw_stock_db) repo，讓其他
機器/其他 Claude 對話不需要重新爬資料就能取得：

- **每天**：把當天新增的資料匯出成小型 CSV（[sync/export_daily_delta.py](sync/export_daily_delta.py)），
  推到 `main` 分支的 `daily/YYYY-MM-DD/`，一般 commit，保留逐日歷史。
- **每月第一次執行時**：把完整 `tw_stock.db`（300MB+，超過 GitHub 100MB 單檔上限）用
  [sync/db_parts.py](sync/db_parts.py) 切成每份 64MB 以內的 part 檔（**不用 Git LFS**，
  避免 LFS 免費額度——每月1GB儲存/頻寬——被吃光），推到 `db-snapshot` 分支，用
  orphan commit + force push 整個覆蓋，只保留最新一份快照。合併回完整 db 的方法
  （`merge_db.py`，附帶 sha256 checksum 驗證）寫在該分支的 README.md 與
  [sunneo/tw_stock_db 的 SKILL.md](https://github.com/sunneo/tw_stock_db/blob/main/SKILL.md) 裡。

需要在本機先手動 clone 好兩個獨立的 working copy（各自固定在自己的分支，避免每月
覆蓋 db-snapshot 時動到 main 分支的逐日歷史）：

```bash
git clone https://github.com/sunneo/tw_stock_db.git <GITHUB_SYNC_MAIN_REPO路徑>
git clone https://github.com/sunneo/tw_stock_db.git <GITHUB_SYNC_SNAPSHOT_REPO路徑>
```

路徑設定在 [config.py](config.py) 的 `GITHUB_SYNC_MAIN_REPO` / `GITHUB_SYNC_SNAPSHOT_REPO`，
上次成功推送的月份記錄在 `.sync_state.json`（已加入 .gitignore，不會被提交）。

### 排程設定範例

**macOS / Linux（cron）：**
```bash
crontab -e
# 加入以下這行（週一到週五下午2:30執行）：
30 14 * * 1-5 cd /path/to/tw-stock-db && /path/to/venv/bin/python run_daily_update.py >> logs/update.log 2>&1
```

**Windows（工作排程器 Task Scheduler）：**
1. 開啟「工作排程器」→「建立基本工作」
2. 觸發條件：每天，時間設 14:30，僅限週一至週五（可用「進階設定」中的重複選項模擬）
3. 動作：啟動程式 `C:\path\to\venv\Scripts\python.exe`，引數 `run_daily_update.py`，
   啟動位置設為 `C:\path\to\tw-stock-db`

Claude 本身無法在背景常駐執行排程任務，這一段需要使用者自行在自己的電腦或伺服器上設定。

## 強勢股 / 鎖股名單 / 持股分析（常用工作流程）

這三支腳本把「選股/鎖股/持股追蹤」的判斷邏輯固定成程式碼，跑一次幾秒鐘就有結果，
取代過去每次都要靠 Claude 手動下 SQL＋人工判斷再手刻 JSON 的做法（省時間也省 token）。
共用的評分邏輯在 [analysis/signals.py](analysis/signals.py)，分成兩套獨立原則：

- **`--method current`（目前原則）**：對應 SKILL.md 方法論（朱家紅老師／林穎老師型態學），
  比對 KD黃金/死亡交叉、MACD多空、紅柱/綠柱由縮轉長、放量紅/黑K、回後買上漲/彈後空下跌
  這5組型態訊號，比對到幾個就是「綜合分數」，做多/做空由哪邊分數高決定。
- **`--method xq`（XQ原則）**：以 `technical_indicators.rs_rating`（RS值/相對強度，
  1-99分，仿XQ全球贏家／IBD RS Rating，近3/6/9/12個月漲幅加權排名，見
  `compute_indicators.py` 的 `update_rs_ratings()`）為核心，篩選條件是
  RS值高、站穩季線、量能未萎縮、貼近波段高點，只挑做多方向。

```bash
# 強勢股（N檔）
python analysis/screen_strong_stocks.py --method current --top 30
python analysis/screen_strong_stocks.py --method xq --top 30

# 鎖股名單（做多+做空）／下週鎖股名單（XQ原則）
python analysis/generate_watchlist.py --method current --out 鎖股名單.json
python analysis/generate_watchlist.py --method xq --out 下週鎖股名單_XQ.json

# 持股分析（讀取既有鎖股清單，算P/L、停損停利、續抱/減碼/出場建議）
python analysis/generate_holdings_report.py 鎖股名單.json --out report.md --compare-new
```

三支腳本都支援 `--format table|json|csv|md`（screen_strong_stocks.py）或
`--format json|csv`（generate_watchlist.py），詳細參數見各檔案開頭的 docstring。

`run_daily_update.py` 也整合了這些流程：`--weekly` 一次產生四份週報（強勢股/鎖股名單
的目前原則+XQ原則）到 `reports/weekly/{日期}/`；`--holdings <檔案>` 額外產生持股分析
報告到 `reports/holdings/{日期}.md`（自動帶 `--compare-new`）。

## 資料表用途對照 SKILL 方法論

- `daily_prices`：原始OHLCV，用於型態辨識（頭肩底、W底等）與量價關係判斷。
- `technical_indicators.ma_alignment`：對應「四線多排/空排」判斷。
- `technical_indicators.rs_rating`：RS值（相對強度，1-99），對應「XQ原則」強勢股篩選，
  見上方「強勢股/鎖股名單/持股分析」段落。
- `technical_indicators.kd_k/kd_d`, `macd_dif/macd_macd/macd_osc`, `rsi6/rsi12`：
  對應選股守則09-11指標系列，用於背離判斷。
- `technical_indicators.bb_upper/bb_mid/bb_lower`：對應布林通道操作邏輯。
- `technical_indicators.bias20`：對應乖離率判斷（葛蘭碧第4/8買賣點）。
- `market_index`：大盤指數資料，用於「大盤決定積極度」原則的環境判斷。`index_code` 包含
  `TAIEX`/`TPEx`（台股）與 `SOX`/`SPX`/`NASDAQ`/`DJI`（美股觀察指標：費城半導體/標普500/
  那斯達克綜合/道瓊工業指數），美股連動判讀規則見 `SKILL_claude_desktop_home.md`
  「美股觀察指標與台股連動判讀」。

## 已知限制

- 資料來源為 Yahoo Finance（`yfinance` 套件），對應 `tw.stock.yahoo.com` 同一資料源；
  法人買賣超、融資融券等籌碼面資料**尚未納入**（依你的指示，先只做價量資料，之後如需要
  可以再擴充證交所/櫃買中心的官方籌碼資料源）。
- 股票清單抓取依賴證交所 ISIN 查詢頁面的表格結構，若該頁面改版，`get_stock_list.py`
  的解析邏輯可能需要調整。
- 這是提供你在自己電腦/伺服器上執行的程式碼；Claude 這邊的容器環境重啟就會清空，
  無法用來長期存放你的資料庫或常駐跑排程。
