# 台股技能移植設計（tradermonty/claude-trading-skills → 網頁版／桌面版 AI）

來源：https://github.com/tradermonty/claude-trading-skills （MIT License，Copyright (c) 2026 TraderMonty）
狀態：第一批（6 個技能）已實裝並有單元測試；尚未在真的網頁版與真的桌面版執行。

免責聲明：本文件與所有台股技能只做教學與資料整理，不構成投資建議。

---

## 一、調查結論

### 1. 網頁版 AI 怎麼載入與使用技能

- 內建技能定義在 `renderer/src/floating-assistant.js` 的 `BUILTIN_SKILLS` 常數（約第 74175 行起）。每一筆有 `id`、`name`、`personaPrompt`（技能正文，格式是 SKILL.md 的 frontmatter＋Markdown）與 `builtinToolNames`（它能用的工具名稱）。
- `_ensureBuiltinSkillBundles()`（約第 108294 行）在每次啟動時，把 `BUILTIN_SKILLS` 寫進 `advancedSettings.skillBundles`：不存在就新增（預設啟用），已存在就刷新名稱、正文與工具清單，但保留使用者自己設定的啟用狀態。內建技能不能被刪除。
- `_syncSkillBundleDomains()` 把每個技能包登記成一個 domain（名稱 `skill_<id>`），工具清單包含 `builtinToolNames`、使用者掛上的自訂工具、以及附檔的讀取工具 `read_skill_file__<id>`。子任務用 `delegate_to_subagent`（參數 `domain`）委派進去。
- 附檔（參考資料、腳本）存在 `skillFileCache`，AI 用 `read_skill_file__<id>` 分段讀取；匯入設定時不帶檔案本體，換機器後會變成「內容遺失」（程式已有處理）。
- 技能包可以含 `scripts/`，由 `skill_run_script` 在 Pyodide 裡執行。
- 另一條路：`renderer/src/floating-assistant.js` 內的 `FA_IDR_SKILL_FILES` 是由 `scripts/embed-code-ui.js` 從 `desktop-app/skills/<名稱>/` 產生的嵌入區塊（現有的 `image-decompose-redraw` 就是這樣做）。**這是建置產物，不能手改；要改來源模組再重新嵌入。** 本次沒有執行建置，所以沒有重新產生嵌入區塊。
- `desktop-app/skills/` 目前只有 `image-decompose-redraw` 與 `weak-model-harness` 兩個資料夾。`desktop-app/.claude/skills/` 不存在。repo 根目錄的 `SKILL.md`（stock-pattern-analysis）是給 Claude Code 讀的技能，網頁版 AI 不會自動載入它。
- **網頁版與桌面版共用同一份 renderer 原始碼**，所以 `BUILTIN_SKILLS` 的登記兩邊都會生效。

### 2. 網頁版能執行什麼程式

- Python：`python_execute` 工具，用 Pyodide（CPython 編譯成 wasm）在瀏覽器沙盒內執行，額外套件可用 micropip 安裝。桌面版也有同名工具。
- JavaScript：有 `big_content` 工具的 `js` 動作（函式本體，可用 `text`、`data`），用來處理已載入的大段內容。它不是通用的執行環境。
- 沒有直接讓 AI 呼叫任意 JavaScript 模組的工具。所以本批的 JavaScript 運算核心（`tw_trading_calc.js`）**目前不能被網頁版 AI 直接呼叫**，這是已知缺口，見第五節。

### 3. 網頁版能拿到哪些台股資料

樣本位置：`daily/2026-09-01/`（抽樣讀取，未遞迴掃全部）。

| 資料 | 檔案 | 欄位（節錄） |
|---|---|---|
| 日線 OHLCV | `daily/<日期>/daily_prices.csv` | stock_code, trade_date, open, high, low, close, volume |
| 加權與國外指數 | `daily/<日期>/market_index.csv` | index_code（TAIEX、TPEx、DJI、NASDAQ、SPX、SOX）, trade_date, open, high, low, close, volume |
| 股票基本表 | `daily/<日期>/stocks.csv` | stock_code, stock_name, market（TWSE／TPEx）, sector_id, is_active |
| 技術指標 | `daily/<日期>/technical_indicators.csv` | ma5, ma10, ma20, ma60, vol_ma5, kd_k, kd_d, macd_*, rsi6, rsi12, bb_*, bias20, ma_alignment（多排／空排等）, rs_rating |
| 盤中快照 | `daily/<日期>/intraday_quotes.csv` | stock_code, snapshot_at, price, open, high, low, volume, series_json |
| 三大法人（個股） | `daily-chip/<日期>/institutional_by_stock.csv` | stock_code, trade_date, foreign_net, foreign_dealer_net, trust_net, dealer_net, total_net |
| 股權（保管） | `daily-chip/<日期>/mandatory_custody.csv` | stock_code, data_date, custody_common, custody_special, custody_total, issued_shares_k |
| 其他 | `watchlist/`、`reports/` | 自選與報告，本批未使用 |

- 網頁版把這些 CSV 匯入瀏覽器內的 SQLite（`web/index.html` 有 `daily_prices`、`technical_indicators`、`market_index` 等資料表）。
- **樣本限制**：`daily/` 目前只有 14 個交易日（2026-09-01 至 09-14）。因此 60 日均線、VCP（需要 40 根以上）可能算不出來。程式會照實回報資料不足，不會硬算。
- **未驗證**：網頁版 AI 是否有「查詢 SQLite」的工具，我只查了工具名稱與註冊字串，沒有找到。本批技能假設 AI 會透過上傳檔案或 `fap_read_file` 取得 CSV 內容，這點要在真網頁版確認。
- 沒有融資融券、沒有外資期貨與選擇權部位、沒有財報與 EPS 欄位。這些決定了哪些技能不能做（見分類表）。

---

## 二、74 個技能分類

分類定義：
- **A**：台股可直接改寫（用我們現有的日線、指數、技術指標、三大法人資料）。
- **B**：需要外部資料或付費 API（FMP、Alpaca、Finviz、新聞搜尋、財報、總經序列）。改寫後要改成手動輸入或我們的資料，本批不做。
- **C**：美股或其他市場專屬，不適用（選擇權、美股稅務、期貨 COT、加密貨幣、外匯、MT5 等）。
- **M**：開發或導覽工具，與台股分析無關，不移植。

| # | 技能 | 分類 | 理由 |
|---|---|---|---|
| 1 | backtest-expert | A | 回測方法論，可用我們日線套用；原版只是指引 |
| 2 | breadth-chart-analyst | A | 原版看 S&P 圖表，改為讀我們的廣度表，併入 tw-breadth |
| 3 | breakout-trade-planner | A | 依 VCP 結果與部位試算產生進場計畫，不需外部資料 |
| 4 | canslim-screener | B | 需要 EPS、營收成長等基本面，我們沒有 |
| 5 | contrarian-setup-gate | B | 依賴 COT 擁擠度與新聞反應，台股沒有對應資料 |
| 6 | cot-contrarian-detector | C | CFTC 期貨持倉資料，美國市場專屬 |
| 7 | crypto-regime-analyzer | C | 加密貨幣專屬 |
| 8 | data-quality-checker | A | 檢查我們 CSV 的缺漏與異常，純本地運算 |
| 9 | dividend-growth-pullback-screener | B | 需要股利歷史與殖利率，我們沒有 |
| 10 | downtrend-duration-analyzer | A | 用加權指數算下跌持續天數，可改寫；需要較長的歷史 |
| 11 | drawdown-circuit-breaker | A | 依交易日誌算日虧損與連續虧損，純本地運算（下一批） |
| 12 | dual-axis-skill-reviewer | M | 技能品質審查工具，與台股無關 |
| 13 | earnings-calendar | B | 美股財報行事曆，FMP API |
| 14 | earnings-trade-analyzer | B | 需要財報與盤後跳空資料，FMP |
| 15 | economic-calendar-fetcher | B | 總經行事曆，FMP API |
| 16 | edge-candidate-agent | B | 依美股 EOD 觀察產生研究票，需要外部資料與多代理流程 |
| 17 | edge-concept-synthesizer | B | 依 edge 管線輸出，上游是 B 類 |
| 18 | edge-hint-extractor | B | 依新聞與日觀察，需要新聞資料 |
| 19 | edge-pipeline-orchestrator | B | 多代理管線編排，依賴多個 B 類技能 |
| 20 | edge-signal-aggregator | B | 彙整多個技能的訊號，上游不完整 |
| 21 | edge-strategy-designer | B | 把概念轉成策略草稿，屬研究流程 |
| 22 | edge-strategy-reviewer | B | 審查策略草稿，屬研究流程 |
| 23 | exposure-coach | A | 整合廣度與分數產生部位上限，純計算（下一批） |
| 24 | finviz-screener | B | 外部 Finviz 網址與美股篩選器 |
| 25 | ftd-detector | A | 已實裝：用加權指數判斷反彈與跟進日 |
| 26 | futures-position-sizer | C | 美國期貨合約規格表，台股無對應 |
| 27 | fxmacrodata-calendar | C | 外匯總經行事曆 |
| 28 | ibd-distribution-day-monitor | A | 已實裝：用加權指數計算出貨日 |
| 29 | institutional-flow-tracker | A | 原版是 13F 美股機構持股；改寫為我們的三大法人買賣超（daily-chip） |
| 30 | kanchi-dividend-review-monitor | B | 股利持股檢視，需要股利與財務資料 |
| 31 | kanchi-dividend-sop | B | 美股股利操作流程，台股股利資料缺 |
| 32 | kanchi-dividend-us-tax-accounting | C | 美國股利稅務 |
| 33 | macro-regime-detector | B | 需要跨資產與總經序列，我們沒有 |
| 34 | manifoldbt-backtester | B | 依賴外部 Rust 回測引擎，需先評估是否改用 JavaScript 回測 |
| 35 | market-breadth-analyzer | A | 已實裝：我們自己的股票池算廣度，不用原版的美股 CSV |
| 36 | market-environment-analysis | B | 需要網路搜尋與圖表輸入 |
| 37 | market-news-analyst | B | 需要新聞搜尋 |
| 38 | market-top-detector | A | 用加權指數出貨日、廣度惡化、族群輪動判斷，可改寫（下一批） |
| 39 | mt5-robot-tester | C | MetaTrader 5 外匯 EA |
| 40 | news-reaction-failure-analyzer | B | 需要新聞與 COT |
| 41 | options-strategy-advisor | C | 選擇權策略，台股選擇權資料不在我們的資料內 |
| 42 | pair-trade-screener | A | 用我們的日線算配對價差；原版用 FMP 價量，可改寫（下一批） |
| 43 | parabolic-short-trade-planner | B | 需要盤中 5 分鐘資料與融券，我們沒有 |
| 44 | pead-screener | B | 財報後漂移，需要財報資料 |
| 45 | portfolio-manager | B | 依賴 Alpaca 券商帳戶 |
| 46 | position-sizer | A | 已實裝：1 張＝1000 股、手續費、證交稅 |
| 47 | pre-trade-discipline-gate | A | 交易前檢查表，純邏輯（下一批） |
| 48 | residual-edge-analyzer | A | 用我們的策略報酬序列做回歸，可改寫（下一批） |
| 49 | scenario-analyzer | B | 依新聞標題推演情境 |
| 50 | sector-analyst | A | 用 stocks.sector_id 與日報酬看族群輪動，可改寫（下一批） |
| 51 | signal-postmortem | A | 用我們的日線算事後 MFE／MAE，純本地運算（下一批） |
| 52 | skill-designer | M | 設計新技能的工具，與台股無關 |
| 53 | skill-idea-miner | M | 從 Claude Code 對話紀錄挖技能點子，與台股無關 |
| 54 | skill-integration-tester | M | 檢查多技能工作流程，與台股無關 |
| 55 | stanley-druckenmiller-investment | B | 整合 8 個上游技能的輸出，上游多為 B 類 |
| 56 | stockbee-20pct-study | B | 依事件目錄與催化劑分類，需要新聞資料 |
| 57 | stockbee-episodic-pivot-analyzer | B | 依財報、併購、新聞等事件，需要事件資料 |
| 58 | stockbee-exhaustion-hammer-screener | A | 純 OHLCV 形態（錘子線、下跌量縮），可改寫台股（下一批） |
| 59 | stockbee-momentum-burst-screener | A | 純 OHLCV 形態（4% 突破、量能放大），可改寫台股（下一批） |
| 60 | stockbee-setup-fluency-trainer | A | 依上一項的候選股做事後統計，可改寫（下一批） |
| 61 | strategy-pivot-designer | A | 回測停滯時的策略轉向流程，方法論，不依賴資料源（下一批） |
| 62 | technical-analyst | A | 週K技術分析，與 stock-pattern-analysis 重疊，改寫時要引用而不是重複 |
| 63 | theme-detector | B | 題材偵測需要新聞與主題資料 |
| 64 | trade-hypothesis-ideator | A | 從日線與交易日誌產生可證偽假設，可改寫（下一批） |
| 65 | trade-performance-coach | A | 依交易日誌檢討紀律與執行，純本地運算（下一批） |
| 66 | trader-memory-core | A | 交易日誌與投資論點生命週期，本地 JSON 即可（下一批） |
| 67 | trading-skills-navigator | M | 原版的技能導覽，依賴其他技能的 API 設定檔，不移植 |
| 68 | uptrend-analyzer | A | 已實裝：依均線多排比例看族群上升趨勢 |
| 69 | us-market-bubble-detector | C | 美股泡沫指標，依 Minsky 框架與美國資料 |
| 70 | us-stock-analysis | C | 美股個股分析 |
| 71 | us-undervalued-growth-screener | C | 美股小中型成長股篩選 |
| 72 | value-dividend-screener | B | 美股價值與殖利率篩選，台股版需要本益比與殖利率資料 |
| 73 | vcp-screener | A | 已實裝：波動收縮型態粗篩（原版用 S&P 500 與 FMP） |
| 74 | weekly-performance-digest | A | 依已平倉交易做週報，純本地運算（下一批） |

統計：A 29 個（本批實裝 6 個）、B 30 個、C 10 個、M 5 個，合計 74。

---

## 三、第一批實裝（6 個）

挑選理由：先做大盤判斷（廣度、趨勢、反彈、出貨）與兩個最常用的風控與型態工具。這些都只需要我們現有的資料欄位，而且直接回答使用者的兩個問題：「今天大盤廣度如何」「這檔有沒有 VCP」。

| 本站技能模式 | 原技能 | 內容 |
|---|---|---|
| 市場廣度（tw-breadth） | market-breadth-analyzer | 我們股票池的上漲家數、站上 20／60 日線比例、0-100 綜合分數 |
| 上升趨勢比例（tw-uptrend） | uptrend-analyzer | 依 sector_id 統計多排比例與平均相對強度 |
| 跟進日（tw-ftd） | ftd-detector | 修正低點、反彈第幾日、量增大漲的跟進日、反彈失敗狀態 |
| 出貨日（tw-distribution） | ibd-distribution-day-monitor | 近 25 日跌幅 ≥ 0.2% 且量增的出貨日數與等級 |
| 波動收縮型態（tw-vcp） | vcp-screener | 轉折點、三段收縮遞減、量縮的粗篩 |
| 部位試算（tw-position） | position-sizer | 依風險百分比算股數，整張或零股，含手續費與證交稅 |

### 實裝檔案

- `desktop-app/skills/tw-trading/scripts/tw_trading_calc.js`：純函式運算核心，UMD 格式（Node 與瀏覽器都能載入）。
- `desktop-app/skills/tw-trading/scripts/tw_trading_calc.test.js`：20 項單元測試，使用小型假資料，不依賴網路。
- `desktop-app/skills/tw-trading/scripts/tw_trading_register.test.js`：登記檢查，從真正的 `floating-assistant.js` 取出 `BUILTIN_SKILLS` 求值，確認登記存在，並且 `personaPrompt` 與 `SKILL.md` 完全一致。
- `desktop-app/skills/tw-trading/SKILL.md`：Claude 格式技能正文（六個模式、台股規則、資料缺口）。
- `desktop-app/skills/tw-trading/THIRD-PARTY-NOTICE.md`：原作者版權聲明、MIT 授權全文、來源連結。
- 2026-11-24 更正：**不內建**。`BUILTIN_SKILLS` 沒有這個技能（`_ensureBuiltinSkillBundles` 會清掉 v568 已裝進設定的 `builtin-skill-tw-trading`）；只有台股網頁（網頁倉庫 `web/index.html` 的 `registerTwTradingDomain`）在背景載入 `skills/tw-trading/SKILL.md`，用 `register_domain("tw_trading")` 帶進它自己的 AI。

### 與原作者的差異（改寫說明）

- 原技能用美股資料（S&P 500、FMP、CSV 公開網址）；本版全部改用本站資料欄位，不連外網。
- 數值改為台股慣例：漲跌幅 10%、加權指數（TAIEX）、1 張＝1000 股、手續費 0.1425%（最低 20 元）、股票證交稅 0.3%、ETF 0.1%。
- 門檻（跟進日 1.5%、出貨日 0.2% 與 25 日、VCP 深度 10%、量縮 0.8 倍）是依原技能與 IBD 常見設定調整的台股版預設值，全部可由參數覆寫，不是原作者數字的照抄。
- 廣度綜合分數是我們自己的定義（三分量等權），不是原作者的六分量模型，因為原模型需要的資料我們沒有。
- VCP 的收縮偵測是簡化版（左右各 3 根K的轉折點），不是原作者的完整規則。

### 與 stock-pattern-analysis 的分工

- 本工具包給「數字」：廣度、趨勢比例、反彈狀態、出貨日數、收縮深度、部位大小。
- 型態判讀（頭肩底、W 底、四線多排）與進出場紀律仍以 stock-pattern-analysis 為準。兩者結論衝突時，要寫出衝突，不要硬合併。
- `SKILL.md` 已加入引用說明。

---

## 四、註冊與載入

1. 技能正文（`SKILL.md`）→ 由一次性腳本登記進 `BUILTIN_SKILLS`。啟動時 `_ensureBuiltinSkillBundles` 寫進使用者的技能包清單，之後出現在 Skill 分頁，標「🏛️內建」，可以啟用或停用。
2. 工具：`builtinToolNames` = `list_uploaded_files`、`list_file_access_points`、`fap_list_files`、`fap_read_file`、`python_execute`。AI 用 Python（Pyodide）依正文的公式計算。
3. 觸發：正文的 `description` 寫了常見問法（「大盤廣度」「大盤反彈」「出貨日」「VCP」「部位」），AI 會依描述決定是否載入。
4. 檢查：`tw_trading_register.test.js` 驗證登記與正文一致、工具名稱在原始碼中存在。

---

## 五、已知缺口與取捨（需要使用者或後續批次決定）

1. **網頁版 AI 不能直接執行 `tw_trading_calc.js`。** 目前的做法是：正文用 Python 公式描述，AI 自己用 `python_execute` 實作。這跟 JavaScript 核心的結果可能不一致，**沒有驗證**。建議的後續做法：把 `tw_trading_calc.js` 註冊成一個工具（例如 `tw_trading_calc`，參數為技能名稱與資料列），由工具內部執行；這需要把檔案放進 renderer 的載入流程，屬於較大的改動，本批不做。
2. **資料來源需要使用者提供或上傳。** 我沒有找到網頁版 AI 直接查詢 SQLite 的工具，所以 AI 要靠上傳 CSV 或 `fap_read_file`。需要在真網頁版確認。
3. **資料量不足。** `daily/` 樣本只有 14 個交易日，60 日均線與 VCP 在目前的樣本上會算不出來。這是資料量的問題，不是程式問題。
4. **`BUILTIN_SKILLS` 與 `SKILL.md` 是兩份文字。** 目前由一次性腳本與測試保持一致；之後改 `SKILL.md` 要重新登記並重跑登記測試。理想做法是比照 `image-decompose-redraw` 的嵌入流程，但那需要執行建置，本批沒有做。
5. **沒有在真網頁版與真桌面版執行。** 只跑了 Node 單元測試與登記檢查。
6. **FTD 與出貨日的參數是台股版預設值**，還沒用歷史資料校準。

---

## 六、後續批次建議（依分類表）

- 下一批 A 類（需要交易日誌，最有價值）：drawdown-circuit-breaker、trader-memory-core、signal-postmortem、pre-trade-discipline-gate、exposure-coach、market-top-detector。
- 再下一批 A 類：stockbee 三個形態篩選器、pair-trade-screener、sector-analyst、institutional-flow-tracker（三大法人版）、downtrend-duration-analyzer、technical-analyst（併入型態學）。
- B 類要先決定資料來源（例如是否要補財報或融資融券資料），否則不做。
- C 類不做。M 類不做。
