# 台股資料庫與爬蟲（Phase 2）

搭配 `stock-pattern-analysis` Skill 使用的資料層。負責抓取全上市櫃（約1700檔）個股的日K
資料，計算技術指標，存入 SQLite 資料庫，供後續報表（週走圖、持股診斷、盤後分析）使用。

## 目錄結構

```
tw-stock-db/
├── config.py                      # 共用設定（DB路徑、參數）
├── requirements.txt
├── run_daily_update.py            # 每日更新主流程（一鍵跑完整套）
├── db/
│   ├── schema.sql                 # 資料表定義
│   └── init_db.py                 # 建立資料庫
├── scrapers/
│   ├── get_stock_list.py          # 抓取全部股票代碼/名稱清單
│   ├── fetch_daily_prices.py      # 抓取個股日K（Yahoo Finance）
│   └── fetch_market_index.py      # 抓取加權指數/櫃買指數
└── analysis/
    └── compute_indicators.py      # 計算 MA/KD/MACD/RSI/布林/乖離/均線排列
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

`fetch_daily_prices.py --period 2y` 會逐檔呼叫 Yahoo Finance，1700檔 × 0.5秒延遲，
粗估至少需要 15-20 分鐘以上，實際依網路狀況與 Yahoo 回應速度而定。如果中途失敗的股票，
可以查詢 `fetch_log` 資料表找出 `status='failed'` 的代碼，針對性重跑。

## 每日更新（排程用）

```bash
python run_daily_update.py
```

這個腳本會依序執行：更新股票清單 → 抓大盤指數 → 抓個股近5天OHLCV（增量+補漏）→
重算技術指標 → 產生每日文字報告。建議排程在**台灣時間每個交易日下午 2:30 之後**執行
（此時當日收盤資料在 Yahoo Finance 上通常已經可以抓到）。

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

## 資料表用途對照 SKILL 方法論

- `daily_prices`：原始OHLCV，用於型態辨識（頭肩底、W底等）與量價關係判斷。
- `technical_indicators.ma_alignment`：對應「四線多排/空排」判斷。
- `technical_indicators.kd_k/kd_d`, `macd_dif/macd_macd/macd_osc`, `rsi6/rsi12`：
  對應選股守則09-11指標系列，用於背離判斷。
- `technical_indicators.bb_upper/bb_mid/bb_lower`：對應布林通道操作邏輯。
- `technical_indicators.bias20`：對應乖離率判斷（葛蘭碧第4/8買賣點）。
- `market_index`：大盤指數資料，用於「大盤決定積極度」原則的環境判斷。

## 已知限制

- 資料來源為 Yahoo Finance（`yfinance` 套件），對應 `tw.stock.yahoo.com` 同一資料源；
  法人買賣超、融資融券等籌碼面資料**尚未納入**（依你的指示，先只做價量資料，之後如需要
  可以再擴充證交所/櫃買中心的官方籌碼資料源）。
- 股票清單抓取依賴證交所 ISIN 查詢頁面的表格結構，若該頁面改版，`get_stock_list.py`
  的解析邏輯可能需要調整。
- 這是提供你在自己電腦/伺服器上執行的程式碼；Claude 這邊的容器環境重啟就會清空，
  無法用來長期存放你的資料庫或常駐跑排程。
