# AIDoc（專案索引）設計文件

> 舊名 DeepWiki／`/deepwiki`（仍保留為別名）。斜線指令：`/aidoc`、`/ai-repo-doc`。
> 原始碼：`renderer/src/floating-assistant.js`（`_repoMap*`、`_codeStore*`、`_repoAskRun`、`_aidoc*`、`_repoIndex*`、`_riRegisterPane`）、範本 `renderer/src/code-ui.template.html`（匯出頁）與 `renderer/src/aidoc-viewer.template.html`（互動檢視器），嵌入腳本 `scripts/embed-code-ui.js`。

## 1. 目標

1. 對任意大小的專案（桌面版給絕對路徑、網頁版用已授權的 fap 資料夾）建立**完整索引**：檔案、定義（函式／類別）、註解、簽名、依賴、呼叫關係。
2. 讓人與 AI 都能快速問：「某函式做什麼」「在哪定義」「誰用到」「某功能的程式在哪」。
3. AI 的程式設計相關領域可以**用一個快速工具拿到整體定義與結構**，並在深入探討時把確認過的說明**寫回資料庫**；索引完、深入完，資料庫就是完善的。
4. 索引與說明可以**匯出、匯入、存成專案資料夾裡的檔案**，不同使用者拿同一份專案可以持續延伸。
5. 可匯出成單檔 HTML（內嵌 SQLite 可下 SQL，或純 JS 問答），以及在對話視窗內開**互動檢視器**。

## 2. 資料模型

| 層 | 位置 | 內容 |
|---|---|---|
| 地圖 map | IndexedDB `repoMapCache`，key `map:<root>` | `files{path→{lang,lines,doc,hash,symbols[],imports[],uses[]}}`、`dirs`、`manifests`、`glossary`、`notes`、`notes_meta`、`sym_notes`、`sym_notes_meta`、`notes_ver`、`index_built` |
| 程式碼庫 code store | 記憶體 `_codeStores`＋`repoWikiCache` | `_faCodeFromMap(map)` 轉成緊湊陣列：`files[path,lang,lines,doc,note]`、`syms[name,kind,fileIdx,line,doc,sig,note]`、`imps[i,j]`、`uses[i,symIdx]`，再建倒排索引 `_faCodeIndex`（`nameMap/post/impIn/impOut/usedBy/fileSyms`） |
| 百科頁 | `repoWikiCache` `wiki:<root>/index.json` | `/aidoc wiki` 產生的頁面（結構事實＋AI 撰寫） |

`notes_ver` 每次補說明遞增；`_codeStoreGet` 依 `fileCount＋notes_ver` 判斷快取是否過期。

## 3. 建立索引（背景工作）

- `_repoIndexStart(root)` 啟動背景工作；每個專案一把鎖 `_repoMapExclusive`，多個工作共享記憶體地圖 `_repoJobMaps`，避免互相覆蓋。
- 分階段：列目錄 → 逐批分析檔案（定義、依賴、呼叫）→ 建倒排索引。可停止（`/aidoc stop`）、可接續（從未分析的檔案續跑）。
- 規模階梯（5000／25000 檔）：超過就停下來並提示調高上限；上限在「設定 → AI → 專案索引」（檔案數、地圖大小 MB）。
- 進度顯示在對話進度卡片與設定頁（3 秒輪詢）。
- 選資料夾：`_repoPickFolder`。桌面版走 `desktopAPI.roots.browse` 直接取路徑；網頁版用 `showDirectoryPicker`，**選完自動授權成 fap**，重選同資料夾（`isSameEntry`）會重用既有 fap。

## 4. 問答

`_faCodeAsk(ix, question)`：從問題抽識別字與路徑，判斷意圖（定義在哪／做什麼／誰用到／相關／用途），再用倒排索引加重排取結果，回答帶「說明（AI 補的優先於註解）」、簽名、使用者清單，並附程式碼片段（`_repoAskRun` 讀原檔前後幾行）。完全離線、不需 AI。

AI 端工具：`repo_map`（結構、`annotate`、`dive_targets`、`save_index`…）與 `repo_ask`（問答／搜尋／統計）。程式設計相關領域（coding）會暴露這兩個工具，AI 先用 `repo_ask` 快速拿整體定義，再需要時深入。

## 5. AI 補說明（notes）

- `repo_map annotate`（`_repoAnnotate`）：寫入檔案說明與定義說明。驗證：說明太短退回、定義名稱必須存在於索引（寫錯會回傳相近名稱）、記錄 `by`（ai／user）、時間與檔案雜湊。
- 過期偵測：檔案雜湊變了，`notes_meta` 標記 stale，問答與檢視器會註明「可能過期」。
- `/aidoc dive`（`_aidocDive`）：`_repoDiveTargets` 依重要程度（被引用數、被使用數、定義數、入口檔名）排序還沒說明的檔案，逐檔交給子任務 AI（`FA_DIVE_PROTOCOL`：讀檔→確認→annotate→回報 JSON）。可停止、可接續（只挑還沒說明的檔案）。完成後自動存回專案資料夾（若設定開啟）。

## 6. 共享與持久化

- `/aidoc save [--map]`：存到專案資料夾 `.floating-assistant/index/{meta,notes,map}.json`（只存說明適合一起 commit；`--map` 連索引資料）。
- `/aidoc load`：從專案資料夾載入別人存的索引，**合併**：較新的 `at` 勝出、本機較新的保留；索引資料只補缺的檔案。
- `/aidoc bundle`／`/aidoc import --file`：單一索引檔（`fa-project-notes` 格式，檢查 `format`／版本）。
- 設定「索引自動存回專案資料夾」：否／只存說明／說明＋索引資料；索引完成與深入探討完成時觸發 `_repoIndexAutoSave`。

## 7. 匯出

- SQLite HTML：`_codeBuildSqlite` 建 SQLite（sql.js，資源第一次下載後存進快取，之後離線可用），資料 gzip＋base64 內嵌，頁面可下 SQL。
- 問答 HTML：純 JS，同一套 `_faCodeAsk`。
- 兩者共用範本 `code-ui.template.html`（`FA_CODEUI_HTML`），顯示 AI 補的說明。

## 8. 互動檢視器 `/aidoc view`

浮動視窗（可拖曳、縮放、雙擊標題列或按鈕最大化，關閉會結束背景伺服器），裡面是 sandbox iframe（`allow-scripts allow-forms allow-modals`，沒有 same-origin）。

**假伺服器**：iframe 內注入 `__faMockShim`，把 `fetch`／`WebSocket` 對 `mock.local` 的請求以 `postMessage` 送回主頁面，由 `_aidocServer(key)` 回應（設定 `block:true`，其他外部網址一律擋下，不走任何外部流量）。

| 路由 | 用途 |
|---|---|
| `GET /api/info /jobs /pages /page /tree /symbols /notes /search /file /symbol /source` | 瀏覽、搜尋、看原始碼 |
| `POST /api/ask {q,ctx,ai}` | 離線問答立刻回；`ai:true` 另排進 AI 佇列 |
| `POST /api/dive {path}` | 排進佇列，請 AI 讀檔後補說明 |
| `POST /api/note {path,symbol,note}` | 使用者自己補說明（`by:user`） |
| `WS /ws` | 推送：`info`、`jobs`（索引／深入進度）、`ai_queue`、`ai_start`、`ai_progress`、`ai_answer`、`notes_changed` |

**AI 佇列**：一次只跑一個（子任務 `_runSubAgentTask`，工具限定 repo_map／repo_ask／讀檔類），依序回答；回答帶「是否補了說明」，補了就推 `notes_changed` 讓畫面更新。畫面上每個檔案／定義都有「問 AI」「請 AI 補說明」，回答中的路徑與名稱自動變成可點連結（點進去就是下一個查詢）。

## 9. 指令一覽

`/aidoc index｜status｜stop｜ask｜wiki｜export｜list｜dive｜save｜load｜bundle｜import｜view`；不是子指令時，像路徑就當 `index`，否則當 `ask`。

## 10. 已知限制與注意

- 地圖大小與檔案數有上限；超過需手動調高後接續。
- 檢視器的 AI 佇列在視窗關閉時清空；進行中的那一個仍會跑完。
- 沒有「誰呼叫誰」資料的舊地圖需 `reanalyze` 重新分析。
- 測試注意：自動化測試要先覆寫 `fa.requestUserForm`，否則建立索引的確認對話會一直等使用者。
