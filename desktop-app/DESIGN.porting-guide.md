# 移植指南：AIDoc／專案索引、離線訓練器、Python API 轉接層 → 另一個 AI 專案

> 目的：這三個能力之後要搬到另一個 AI 專案時，知道**哪些可以直接拿走、哪些綁在這個助理的內部、搬過去要補什麼**。
> 現況（誠實說明）：三者都寫在同一支 `renderer/src/floating-assistant.js`（約 5 萬行）裡，是這個類別的方法，**還沒有拆成獨立套件**。這份文件把邊界、依賴、順序整理清楚；真正要搬時，建議照第 6 節的做法先抽出「主機介面」。數字（行數、方法數）是 2026-10-03 量的，會隨開發變動。

## 1. 總覽

| 能力 | 規模 | 可直接搬走的部分 | 綁在助理內部的部分 | 搬移難度 |
|---|---|---|---|---|
| Python API 轉接層 | 約 240 行主機端＋獨立 Python 套件 | `renderer/src/pybridge/**/*.py` 完全獨立；桌面版檔案信箱協定 | `_pyBridge*` 要接工具呼叫、領域委派、模型設定 | 低 |
| 程式行為分析（FaBeh2） | 約 1 萬行、獨立分段檔 | `renderer/src/behavior/engine_1..5_*.js`＋兩份 JSON，**不依賴助理**，只要給它剖析器 | 嵌入腳本、`_behExplain` 的轉接與使用者定義存取 | 低 |
| AIDoc／專案索引 | 約 86 個方法（約 2200 行）＋約 20 個頂層純函式＋兩份 HTML 範本 | 索引資料模型、倒排索引、問答（純函式）、匯出範本、檢視器範本 | 檔案系統存取、儲存、背景工作、進度卡片、設定頁、AI 子任務、假伺服器的視窗 | 中 |
| 離線訓練器 | 約 65 個方法（約 1400 行）＋約 10 個頂層純函式＋沙盒 worker | 規則／語意比對、狀態機執行器、蒸餾、worker 原始碼（純函式） | 工具登記表、對話歷史、RAG、設定頁、老師子任務 | 中高 |

建議搬移順序：**行為分析 → Python 轉接層 → AIDoc → 離線訓練器**（越後面越依賴對話、工具登記表與子任務）。

## 2. 主機介面（搬過去的專案要提供什麼）

三個能力共用同一組「主機能力」。搬移時不要一個個改呼叫，**先在新專案寫一個主機轉接物件**，把下面這些映射好：

| 主機能力 | 本專案的實作（名稱） | 用在哪 | 新專案需要提供 |
|---|---|---|---|
| 工具登記 | `register_openai_tool(name, desc, schema, cb)`、`this.tools` | 三者都用：AI 要能呼叫 `repo_map`／`repo_ask`／`explain_code`／`behavior_define`、離線訓練器的 `offline_trainer` 等 | 一個「註冊函式＋JSON Schema＋回呼」的工具登記表 |
| 斜線指令 | `register_slash_command(cmd, hint, desc, handler, argChoices)` | `/aidoc`、`/offline-trainer-by-ai` | 指令登記；沒有就改成選單或函式 |
| 子任務 AI | `_runSubAgentTask(prompt, {allowedToolNames, onProgress, onTrace, …})` | AIDoc 深入探討與檢視器問答；離線訓練器的 AI 老師 | 一個「給任務與可用工具，跑到完成回傳文字」的代理執行器 |
| 鍵值／大型物件儲存 | `FileCache`（IndexedDB，`repoMapCache`、`repoWikiCache`、離線訓練器的 `_otDb`） | 索引地圖、程式碼庫快取、百科頁、sql.js 資源、tree-sitter 資源 | `get/put/delete/getAll`＋Blob，容量上限可設定 |
| 檔案存取 | 桌面：`desktopAPI.rawfs`、`desktopAPI.roots`；網頁：fap（File System Access 授權資料夾）`fileAccessPoints` | AIDoc 讀專案檔、存 `.floating-assistant/index/` | 一個 `readText/listDir/writeText` 介面，路徑格式自訂（本專案：絕對路徑或 `fap:<名稱>/…`） |
| 進度顯示 | `_createProgressWidget(title)` → `{update, finish(status, actions), fail}` | 索引、深入探討、訓練 | 任何進度元件；`finish` 的 `actions` 是完成後的操作按鈕 |
| 訊息／歷史 | `_pushAssistantMessage`、`_persistChatHistory`、`_renderMessageHistory` | 完成通知、斜線指令回覆 | 把一段文字顯示給使用者 |
| 向使用者確認 | `requestUserForm({title, description, …})` | 建立索引前確認、風險工具離線執行前確認 | 一個「問使用者」的函式 |
| 設定與設定頁 | `advancedSettings`、`_saveAdvancedSettings`、`registerAdvancedSettingsTab(tab, id, title, root)` | 專案索引上限、離線模式、轉接層開關 | 設定存取；設定頁可略（改用設定檔） |
| 沙盒 iframe／假伺服器 | `__faMockShim`＋`_sandboxBuildDoc/_sandboxOpenIframe` | AIDoc 檢視器（iframe 內的 fetch／WebSocket 由主頁回應） | 網頁環境；非網頁環境改成真的本機 HTTP 伺服器，檢視器範本不用改 |
| 模型呼叫 | `_getApiConfig`、聊天迴圈 | Python 轉接層的 `openai` 轉接、AI 老師 | 一個 `chat(messages) → text` |
| 使用者資料夾 | `_faUserDataDir`、`desktopAPI` | Python 轉接層的檔案信箱、技能包檔案落地 | 一個可寫的資料夾 |

## 3. Python API 轉接層

**要搬的檔案**
- `renderer/src/pybridge/fa_bridge.py`（轉接層核心）、`fa_run.py`（桌面版啟動器）、`openai/__init__.py`、`playwright/__init__.py`、`playwright/sync_api.py`——**純 Python，無任何助理依賴**，直接複製。
- 主機端：`_pyBridgeBase/_pyBridgeInstall/_pyBridgeInstallPyodide/_pyBridgeWrap/_pyBridgeServe/_pyBridgeDispatch`（9 個方法，約 240 行）。
- 桌面版把 `python x.py` 改寫成 `python fa_run.py --rpc <信箱> -- x.py` 的邏輯在 `renderer/bootstrap.js`（`run_command` 包裝）。

**搬過去要補的**
1. `_pyBridgeDispatch` 的 op 對應到新專案的能力：`playwright.*` → 新專案的瀏覽器控制工具；`openai.chat` → 新專案目前的模型；`tool`／`domain` → 新專案的工具登記表與委派。這是唯一需要改的地方，op 名稱與請求格式（`{op, args}`）保持不動，Python 端就不用改。
2. 檔案信箱協定：`<資料夾>/pybridge/rpc/<runId>/req-*.json → res-*.json`；主機在腳本執行期間輪詢。新專案要有「在腳本跑的同時處理請求」的迴圈（本專案是 `run_command` 執行期間並行輪詢）。
3. 網頁版（Pyodide）：另一條傳輸，註冊 JS 模組 `_fa_pybridge`，Python 用 `asyncio.run` 呼叫；新專案若沒有 Pyodide 可整段略過。
4. 啟用範圍：只在執行技能包期間生效（`_pyBridgeDepth` 計數）。新專案要決定自己的「什麼時候要轉接」。

**驗證**：沿用 `DESIGN.python-api-bridge.md` 的做法——用一支原封不動、會用 `connect_over_cdp` 的腳本，在沒有真瀏覽器的環境下以假的工具回應執行成功。

## 4. 程式行為分析（FaBeh2，AIDoc 的行為說明基底）

最容易搬，因為已經獨立：
- 程式：`renderer/src/behavior/engine_1_core.js` 到 `engine_5_api.js`，接成同一個函式範圍（`const FaBeh2 = (function(){ … })()`，組裝方式見 `scripts/embed-code-ui.js` 的 `embedBeh2`，或直接照 `scratchpad/beh2_test.js` 的做法用 Node 組裝）。
- 資料：`behavior_patterns.json`、`api_semantics.json`（細節見 `DESIGN.behavior-analyzer.md` 第 10 節）。
- 唯一的外部需求：**剖析器**。`FaBeh2.create(data, host, user)` 的 `host` 提供 `loadTreeSitter()`（回傳 web-tree-sitter 0.20.8 的 `Parser`）與 `loadLanguageWasm(名稱)`（回傳 wasm 位元組）。Node 或瀏覽器都能用；不傳 `host` 時仍可用純文字功能（組語／IR 文字、位元組碼、文字重排與摘要）。
- 使用者／AI 補的定義：`user = {categories, api, idioms, notes}`，由新專案自己保存（本專案存 `localStorage['fa_behavior_user_defs_v1']`，`behavior_define` 工具讀寫）。
- 搬過去只要寫兩個工具：`explain_code`（呼叫 `create(...).explain(path, text, {fn, notes})`）與 `behavior_define`（改使用者定義）。

## 5. AIDoc／專案索引

### 5.1 可直接搬走（純函式，不碰檔案系統）
- 資料模型與轉換：`_faRepoExtract`（單檔分析：定義、註解、依賴、呼叫）、`_faRepoResolveCandidates`（依賴解析）、`_faRepoParseManifest`、`_faCodeFromMap`（地圖→緊湊陣列）。
- 倒排索引與問答：`_faCodeIndex`、`_faCodeSearch`、`_faCodeAsk`（意圖判斷＋重排＋帶「說明」回答）。
- 語言判斷與路徑小工具：`_faRepoLang/_faRepoExt/_faRepoJoin/_faRepoHash/_faRepoTokens`。
- 兩份範本：`code-ui.template.html`（匯出頁）、`aidoc-viewer.template.html`（互動檢視器，**只靠 `fetch`／`WebSocket` 與後端溝通**，後端換成真伺服器照樣能用，路由見 `DESIGN.project-index.md` 第 8 節）。
- 匯出：SQLite（sql.js）與 JS 問答頁的建構邏輯（`_codeBuildSqlite` 等），只依賴 sql.js 資源取得函式。

### 5.2 要重新接的（綁在助理內部）
外部依賴統計（`this.*`，依出現次數）：路徑與鎖（`_repoMapKey`、`_repoJobs`、`_repoMapJoinPath`、`_repoMapLocks`）、儲存（`repoMapCache`、`repoWikiCache`、`_codeStores`）、設定（`advancedSettings`）、使用者確認（`requestUserForm`）、對話與進度（`_pushAssistantMessage`、`_createProgressWidget`、`_renderMessageHistory`）、檔案存取（`fileAccessPoints`、`desktopAPI.rawfs`）、AI 子任務（`_runSubAgentTask`）、沙盒視窗（`_sandboxBuildDoc`、`_sandboxOpenIframe`）。
這些全部對應到第 2 節的主機介面；**索引邏輯本身不直接碰 DOM 或模型**，都經由這些入口，所以只要提供介面，不必改邏輯。

### 5.3 搬移步驟
1. 先搬純函式與資料模型，用一個小專案（本專案的 `tw_stock_db_code` 或任何 repo）在 Node 跑 `_faRepoExtract → _faCodeFromMap → _faCodeIndex → _faCodeAsk`，確認離線問答能回答「某函式做什麼／在哪定義／誰用到」。
2. 接儲存與檔案存取：實作 `readText/listDir`，把 `_repoMapIo(key)` 這一層換掉（它是檔案系統唯一入口，桌面與 fap 都從這裡走）。
3. 接背景工作：`_repoIndexStart` 的分階段（列目錄→逐批分析→建倒排索引）、鎖、可停止可接續。保持「進度存起來、可接續」的行為，這是大專案的關鍵。
4. 接 AI：工具 `repo_map`、`repo_ask` 與子任務（深入探討、檢視器問答）；`FA_DIVE_PROTOCOL` 是給子任務的流程提示，原樣帶走。
5. 接檢視器：假伺服器 `_aidocServer(key)` 的 `handle(d, reply)` 是單一函式（方法、路徑、本文 → 回應），可以直接掛到任何 HTTP 框架；WebSocket 推送用 `srv.push(obj)`。
6. 最後才接設定頁與入口按鈕。

### 5.4 資料相容
- 索引檔：`.floating-assistant/index/{meta,notes,map}.json`、單檔 `fa-project-notes`（`format`／版本欄位）。新專案沿用同一格式，兩邊的說明就能互相合併（較新的 `at` 勝出）。
- 版面偏好：`fa_aidoc_view_prefs_v1`（見 `DESIGN.project-index.md` 第 11 節）；換儲存位置時只要保持 `GET／POST /api/prefs` 的介面。

## 6. 離線訓練器

### 6.1 可直接搬走
- 比對與執行：`_faOtSlots/_faOtFill/_faOtMatchRule/_faOtTpl`（槽位填充、規則、樣板）、`_faOtFsmRun`（狀態機執行器，有步數上限防迴圈）、`_faOtDistill`（蒸餾：把成功的對話整理成規則／狀態機／語意 pattern）、`_faOtGenFormatter`、`_faOtParseItems`（批次項目解析）。
- 背景 worker：`_faOtWorkerSource`（把整理工作丟到 Web Worker 的原始碼字串）；JS 工具的沙盒見 `DESIGN.sandbox-worker.md`。
- 語意比對：雜湊嵌入（`_faSemEmbed`、`_faSemCos`）與同義詞群組 `FA_SEM_GROUPS`、動詞同義 `FA_OT_VERBS`——純函式與常數。
- 功能清冊：`desktop-app/features/ai-features.yaml` 是離線訓練器「依清冊長出 pattern」的來源，格式與建置檢查在 `build-assistant.js`。

### 6.2 要重新接的
外部依賴：領域／知識儲存（`_otDb`、`_otSaveDomain`、`_otCol`）、工具登記表（`this.tools`——離線時要能真的執行工具）、RAG（`ragSystem`）、對話與進度、設定頁、老師子任務（`_otTeachers`、`_runSubAgentTask`、`_otTeacherAllowedTools`）、風險工具確認（`FA_OT_RISKY_TOOL`）。

### 6.3 搬移時要保留的原則（見 `DESIGN.offline-trainer.md`）
1. 只學 function call，不存回答或查詢結果。
2. 先讓離線訓練器試，做不到才交給 AI；AI 成功後離線訓練器必須被擴充。
3. 只有「所有模型都沒辦法回應」才自動切離線模式。
4. 會改動東西的工具離線執行前一律向使用者確認。

### 6.4 搬移順序
語意比對與規則執行器（純函式，可在 Node 單測）→ 狀態機 → 儲存介面 → 工具登記表對接 → 蒸餾與 worker → AI 老師 → 設定頁。

## 7. 建議的拆分做法（真的要搬時）

1. **在這個專案先抽出主機介面**：新增一個 `FaHost` 物件，集中第 2 節的主機能力（`tools`、`storage`、`fs`、`progress`、`say`、`confirm`、`settings`、`agent`、`model`）。把三個能力內部的 `this.*` 逐步改成 `host.*`。每改一個能力就跑一次原有的真實 Electron 驗證，避免越改越爛。
2. 純函式分段成獨立檔（像行為分析那樣 `engine_N`），由 `scripts/embed-code-ui.js` 嵌入；新專案直接引用同一批檔案，兩邊共用同一份程式。
3. 資料檔（JSON／範本）放在 `renderer/src/` 下，兩邊共用；格式變動要升版本欄位。
4. 新專案先接「行為分析」與「Python 轉接層」（最小風險），跑通後再接 AIDoc，最後離線訓練器。

## 8. 搬移前的檢查清單

- [ ] 新專案有工具登記表、子任務執行器、鍵值儲存、檔案讀寫四件事（沒有就先補）。
- [ ] 決定路徑格式（本專案：絕對路徑或 `fap:<名稱>/…`）。
- [ ] 決定檢視器的後端：假伺服器（網頁）或真的 HTTP 伺服器。
- [ ] tree-sitter 資源的來源（CDN＋快取，或打包進去）。
- [ ] 使用者／AI 補的定義的保存位置（`behavior_define`）。
- [ ] 驗證方式：真實環境（Electron 或新專案的實際執行環境），而不是只跑單元測試。本專案的驗證腳本在 session 暫存區，沒有放進版本庫；搬移時建議把幾支最有代表性的（行為分析三個範例、`/aidoc index→view`、Python 轉接層的 `redmine_capture.py` 假環境測試）整理成 `tests/`。

## 9. 已知阻礙（先說清楚）

- 主檔過大，`this.*` 互相纏繞：抽 `FaHost` 的過程會碰到大量方法，工作量以週計，不是幾小時。
- AIDoc 的 AI 佇列、檢視器問答依賴 `_runSubAgentTask` 的行為細節（工具白名單、文字化工具呼叫的解析 `_parseDescribedToolCall`、重複呼叫去重），換成別的代理執行器時要確認這些行為都在。
- 離線訓練器的 JS 工具沙盒依賴 Web Worker 與 `ctx.call` 橋接，換環境（例如 Node）要換實作。
- 網頁版的檔案存取（fap）是 File System Access API 專屬；新專案若不是瀏覽器，只需要實作 `readText/listDir`。
