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

浮動視窗（可拖曳、縮放、雙擊標題列或按鈕最大化，關閉會結束背景伺服器；內部版面與視窗位置大小有偏好記憶，見第 11 節），裡面是 sandbox iframe（`allow-scripts allow-forms allow-modals`，沒有 same-origin）。

**假伺服器**：iframe 內注入 `__faMockShim`，把 `fetch`／`WebSocket` 對 `mock.local` 的請求以 `postMessage` 送回主頁面，由 `_aidocServer(key)` 回應（設定 `block:true`，其他外部網址一律擋下，不走任何外部流量）。

| 路由 | 用途 |
|---|---|
| `GET /api/info /jobs /pages /page /tree /symbols /notes /search /file /symbol /source` | 瀏覽、搜尋、看原始碼 |
| `POST /api/ask {q,ctx,ai}` | 離線問答立刻回；`ai:true` 另排進 AI 佇列 |
| `POST /api/dive {path}` | 排進佇列，請 AI 讀檔後補說明 |
| `POST /api/note {path,symbol,note}` | 使用者自己補說明（`by:user`） |
| `GET／POST /api/prefs` | 版面偏好讀寫、`{reset:true}` 還原（見第 11 節） |
| `GET /api/explain?path=&fn=` | 行為說明（`DESIGN.behavior-analyzer.md`） |
| `WS /ws` | 推送：`info`、`jobs`（索引／深入進度）、`ai_queue`、`ai_start`、`ai_progress`、`ai_answer`、`notes_changed` |

**AI 佇列**：一次只跑一個（子任務 `_runSubAgentTask`，工具限定 repo_map／repo_ask／讀檔類），依序回答；回答帶「是否補了說明」，補了就推 `notes_changed` 讓畫面更新。畫面上每個檔案／定義都有「問 AI」「請 AI 補說明」，回答中的路徑與名稱自動變成可點連結（點進去就是下一個查詢）。

## 9. 指令一覽

`/aidoc view｜explain｜index｜status｜stop｜ask｜wiki｜export｜list｜dive｜save｜load｜bundle｜import`；不是子指令時，像路徑就當 `index`，否則當 `ask`。

## 10. 已知限制與注意

- 地圖大小與檔案數有上限；超過需手動調高後接續。
- 檢視器的 AI 佇列在視窗關閉時清空；進行中的那一個仍會跑完。
- 沒有「誰呼叫誰」資料的舊地圖需 `reanalyze` 重新分析。
- 測試注意：自動化測試要先覆寫 `fa.requestUserForm`，否則建立索引的確認對話會一直等使用者。

## 11. 檢視器的版面與偏好（2026-10-03）

### 11.1 版面

- 檢視器分三塊：左（瀏覽：頁面／檔案／定義／說明＋搜尋）、中（內容）、右（問答與 AI 佇列、通訊紀錄）。
- **左／中／右都可以拖曳調整**：左、中之間與中、右之間各有一條分隔線（5px，滑過會變色）；拖曳時寬度有上下限（左 120 起、右 200 起，且中間至少留約 260px）；**雙擊分隔線還原該塊預設大小**。
- **左右可隱藏**：標題列的 ◧（左）、◨（右）切換，隱藏時分隔線一併隱藏，按鈕變暗表示目前是隱藏狀態。
- **右邊可停靠**：標題列的下拉選單「右邊在右／右邊改到左／右邊改到下」。停靠到下方時，右邊變成橫條，分隔線改成上下拖曳（高度存 `chatH`，0 表示預設 38%）。
- 小視窗（寬度小於 640px）自動改成上下堆疊，分隔線隱藏。

### 11.2 偏好與還原

- 偏好存在**主程式**的 `localStorage['fa_aidoc_view_prefs_v1']`（iframe 是沒有 same-origin 的沙盒，自己沒有儲存空間），內容：
  - `layout`：`{ dock, navW, chatW, chatH, navHidden, chatHidden }`（全域，不分專案）。
  - `win`：視窗的 `{ left, top, width, height }`（拖曳結束與縮放後 0.4 秒存；最大化時不存，以免記住全螢幕尺寸）。
- 路由：`GET /api/prefs` 回傳 `layout`；`POST /api/prefs {layout}` 保存（伺服器端會把每個欄位夾在合理範圍、`dock` 只接受 right／left／bottom）；`POST /api/prefs {reset:true}` 清掉 `layout` 與 `win`，並透過 `srv.hooks.resetWin` 讓視窗回到預設位置與大小（先取消最大化）。
- 開啟檢視器時：視窗位置大小先套用（夾在目前螢幕範圍內，避免換螢幕後視窗跑到畫面外），再由檢視器載入 `layout` 後才渲染內容，避免版面閃一下。
- **「還原版面」按鈕**（標題列）：同時還原檢視器內部版面與視窗位置大小。

## 12. 入口（2026-10-03）

- **斜線指令自動完成**：`/aidoc` 的提示文字與候選第一個就是 `view`，其後 `explain`、`index`、`status`、`stop`、`ask`、`wiki`、`export sqlite|qa`、`list`、`dive`、`save`、`load`、`bundle`、`import`（別名 `/deepwiki`、`/ai-repo-doc` 同步）。
- **設定 → AI → 專案索引**：已建立完畢（`index_built`）且沒有在跑的專案，列上會出現「📖 開啟檢視器」按鈕；還在建立或只有部分索引的專案不顯示。
- **索引完成的進度卡片**：卡片底部多一顆「📖 開啟檢視器」（進度卡片的 `finish(status, actions)` 可帶操作按鈕，完成且沒失敗才顯示）；完成訊息也會提示 `/aidoc view`。
- 行為說明：檢視器檔案頁的「行為說明（可折疊）」與 `/aidoc explain`，見 `DESIGN.behavior-analyzer.md`。

## 13. 設定的上限（2026-10-03）

「檔案數上限」「索引大小上限（MB）」輸入多少就保存多少：只要是 1 以上的整數都接受；不是數字或小於 1 才還原預設。（先前超過 2,000,000 檔或 2,000 MB 會被靜默改回預設，已移除。）

## 14. 文件型檔案（pdf／xlsx／docx／pptx／csv／壓縮檔，2026-10-04）

專案裡的文件也進索引、也能深入探討。

### 14.1 哪些檔案算
`_faRepoDocKind(path)`：`pdf`、`xlsx`、`docx`、`pptx`、`csv`（含 `tsv`）、`zip`、`tar`、`tgz`（含 `.tar.gz`）。這些檔案的 `lang` 記成 `doc:<種類>`（例如 `doc:pdf`），所以原本依 `lang` 判斷「要不要分析」的地方（待分析清單、統計、依名稱搜尋）自動包含它們；排序上文件排在原始碼之後。

### 14.2 建立索引時記什麼
`_repoMapAnalyzeDoc`：讀二進位內容（`io.readBlob`：桌面版走 `rawfs.readFile(path,'base64')`，fap 走 `getFile()`），用 `_repoDocText` 取出全文，但**地圖只存摘要與標題，不存全文**：

| 種類 | `doc`（一句摘要） | `symbols`（可被搜尋的名字） |
|---|---|---|
| pdf／pptx | 頁數＋第一段文字 | 標題（「第一章」「1.2 …」「一、」「全大寫短標題」）；`lines` 是全文行數 |
| docx | 第一段文字 | 標題 |
| xlsx | 幾個工作表、各幾列 | 工作表名稱（`sheet`） |
| csv | 列數、欄位名稱 | 欄位名稱（`column`） |
| zip／tar／tgz | 項目數與前幾個名稱 | 項目名稱（`entry`，前 150 個） |

超過 40 MB 的檔案不分析，只記「檔案太大」；讀取失敗只記原因，不中斷整個索引。pdf 若幾乎沒有文字（掃描件）會在摘要註明，**不做 OCR**。

### 14.3 讀全文：`repo_read_doc`
新工具 `repo_read_doc({root, path, entry?, offset?, max_chars?})`，分段回傳全文：pdf 每頁前有 `[第N頁]`、xlsx 每個工作表前有 `[工作表 名稱（N 列）]`、pptx 每張前有 `[投影片 N]`；壓縮檔不給 `entry` 只列項目，給 `entry` 讀裡面的文字檔。回傳含 `total_chars`、`has_more`、`next_offset`。同一份文件最近 4 份的解析結果會暫存（以專案、路徑、檔案大小為鍵），分段讀不會重複解析。xlsx 最多取前 5000 列。

### 14.4 深入探討與檢視器
- 深入探討的目標清單（`_repoDiveTargets`）把文件算進去，而且**不套用「少於 10 行就略過」**（文件的行數沒有意義）。
- 深入探討的子任務工具白名單與提示（`FA_DIVE_PROTOCOL`）加了文件規則：改用 `repo_read_doc`；說明要寫「這份文件是什麼、主要章節／工作表／欄位、關鍵數字或結論」，pdf 要註明內容在第幾頁；掃描件只能寫「沒有文字層」，不編造。
- 檢視器：檔案頁「看程式碼」對文件顯示全文；問答佇列的工具白名單也加了 `repo_read_doc`。
- `repo_ask` 的離線問答會搜到文件的標題、工作表、欄位與摘要。

### 14.5 限制
- 不做 OCR（掃描 PDF 沒有文字層就讀不到）；PDF 內的圖片與圖表不解析（要看圖用 `parse_uploaded_file` 的 `interpret_images`，目前不接進索引）。
- xlsx 不處理公式與樣式，只取儲存格的值；docx 不保留表格結構與樣式。
- 舊版（`.doc`、`.xls`、`.ppt`、`.rar`、`.7z`）不支援。
- 文件型檔案沒有依賴與呼叫關係，只會出現在搜尋、說明與百科。
- 已經建立過索引的專案要「重新分析」（`reanalyze`）或在檔案變動後的接續索引時，文件才會補進來。

## 檢視器：檔案:行號 內嵌展開（2026-10）

檢視器裡（百科頁、定義頁、右邊問答的回答）出現 `路徑:行號` 或 `路徑:起-迄`（用反引號包或一般文字都可以）會變成虛線連結；點一下，在那段文字正下方（回答、段落的中間）嵌入一張卡片，再點一次或按 ✕ 收起來。卡片內容：所屬定義（函式／類別）與它的行範圍、說明（優先 AI／使用者補的說明，其次原始碼註解）、簽名、被哪些檔案使用，以及像 diff 的程式碼視窗——只顯示指定的行範圍加前後 3 行，並捲到命中行（高亮），視窗上下各有「展開上面／下面 20 行」與「到檔案開頭／結尾」，按下去再讀、連續展開，往上展開時保持畫面位置。按鈕：開啟整個檔案、開啟定義頁、行為說明（呼叫 `/api/explain`）、請 AI 解釋這一段。路徑只寫尾段（例如 `a.js:12`）時，在索引裡只對到一個檔案才算數，對到多個會列出候選。伺服器端：`GET /api/locate?path&line[&to]`，展開用既有的 `/api/source`。

### 說明的表格與資料夾（2026-10）

- 說明（檔案、定義、資料夾）原本存入時會把所有空白（含換行）壓成一個空格、並截在 500 字，所以 AI 說明裡的表格、清單存起來就變成一行亂碼。現在保留換行（每行內多餘空白才合併）、上限 2000 字；檢視器顯示說明時，有換行或表格就用 Markdown 轉成表格（表頭用 th、沒有外框的 `a | b` 也認得、`\|` 是欄內的直線）。編輯說明改成多行文字框（原本 prompt 只有一行，編輯會把表格再壓平）。
- 概觀頁「頂層目錄」的資料夾名稱以前被當成定義名稱，點下去顯示找不到。現在資料夾連結（`dir:`）會開資料夾頁（子資料夾、檔案、資料夾的說明）；舊式的名稱連結找不到定義時，若是索引裡的資料夾也會退回顯示資料夾頁。

### 說明編輯器與多行說明（2026-10）

單行說明太克難：檢視器的「編輯說明」改成 Markdown 編輯器（`mdEditor`）——工具列（標題、粗體、行內碼、程式碼區塊、清單、編號清單、表格、引用）、左右即時預覽（窄視窗上下堆疊）、字數計數（上限 2000）、Tab 縮排、Ctrl+Enter 存檔、Esc 取消。檔案說明與定義說明（定義頁每個定義有「編輯／補這個定義的說明」）都用它。AI 深入探討與問答補說明的提示也改成允許多行 Markdown：檔案說明第一行一句話講用途，接著用清單或表格整理重點（主要函式、輸入輸出、副作用與限制），函式說明可以多行、可用表格。

## 15. 索引寫進專案資料夾的 SQLite（桌面版，2026-10-08）

### 15.1 為什麼

舊做法把整張地圖（每個檔案的定義、匯入、呼叫名稱）放在記憶體，存檔時 `JSON.stringify(map)` 成一個字串寫進 IndexedDB，載入時整個 `JSON.parse` 回來；問答索引再另外把全部定義轉成陣列、建倒排索引。專案一大（Linux／OpenBMC 這種，標頭檔裡有數百萬個 `#define`）就出現三種爆法：單一字串超過上限、IndexedDB 單筆過大（`FileCache` 的 LRU 配額 48 MB 還會把超過配額的地圖整筆淘汰）、頁面記憶體吃到上限。每檔 400 個定義、每資料夾 400 筆、tier 精簡等上限，都是為了壓住記憶體而犧牲完整度。

### 15.2 做法（照 DESIGN.sqlite-fap.md／project-index 的設計）

- 索引就是專案資料夾裡的 SQLite 檔：`<專案>/.floating-assistant/index/index.sqlite3`，旁邊自帶 `.gitignore`（內容 `*`）。建索引時寫到 `index.sqlite3.building`，完成才取代舊檔（舊索引在新的完成前一直有效）。
- 引擎是主程序的 `node:sqlite`（`sqlite-engine.js`，SQLite 3.53、含 FTS5），預設 `PRAGMA cache_size=-65536`（64 MB）；記憶體用量由 cache_size 決定，與資料庫大小無關。桌面版的絕對路徑專案才走這條（`_idxEligible`）；網頁版的 fap 專案維持原本的記憶體索引（需要 sqlite-wasm 與寫回式 VFS，見 DESIGN.sqlite-fap.md，尚未移植）。設定 `repoIndexSql`：`auto`（預設）／`off`。
- 建索引（`renderer/src/sql/index_core.js` 的 `builder`）：每分析一個檔案就 `addFile`，每個時間片 `flush`（一個交易、多列 INSERT）；完成階段解析匯入目標、算計數、名稱對定義的呼叫關係（與舊引擎一致：同名定義 ≤ 8 個、不在自己的檔案）、建索引、全文表。**不設上限**：每個定義（含每個巨集）、簽名 140 字、呼叫名稱 400 個、資料夾列表不限筆數、單檔 4 MB。
- 記憶體只留「瘦身的檔案記錄」：`{lang, lines, hash, doc, imports, nsyms, sql:1}`，定義與呼叫名稱都在資料庫。要用定義的地方（annotate 驗證名稱、explore、百科的重點檔）才從資料庫取（`_repoSymsOf`、`_repoWikiHydrate`）。
- 資料表：`files`（含 refs／used 計數）、`symbols`（含 used_by）、`imports`（只留解析成功的邊）、`uses`、`meta`，以及 FTS5 `sym_fts`（不含巨集）與 `file_fts`；全文表放的是**舊引擎倒排索引用的同一套語意詞元**（名稱拆字、說明、中英概念詞），查詢用同一個函式處理問題。
- 問答：不重寫引擎。問題進來時用 SQL 取出「問題點名的定義與檔案＋全文召回的候選＋引擎要談論它們所需的一切（這些檔案的全部定義、匯入的雙向鄰居、呼叫者與被呼叫者）」，組成只屬於這個問題的小型資料庫，交給原本的 `_faCodeAsk`／`_faCodeSearch`（`_idxMini`）。與記憶體引擎的對照：同一個專案 6 題，統計完全相同、意圖全同、回答逐字相同。
- 檢視器：`_aidocSqlRoute` 以 SQL 實作 info／概觀／樹／符號／說明／搜尋／檔案／定義／定位／問答；source、dive、note、prefs、jobs、explain 沿用原路由。
- 說明（notes）仍在地圖裡（小），問答時合併進小型資料庫。
- 接上：地圖不在（換電腦、瀏覽器資料被清掉）但專案資料夾裡有 `index.sqlite3` → `/aidoc load` 或 `index_start` 直接接上（`_idxAttach` 從資料庫重建瘦身記錄與資料夾列表），不重建。
- 引擎行為：每個連線一個子行程（取消、逾時＝砍行程，SQLite 自動回滾）；渲染行程重新載入時自動收掉它開的連線；同一個檔案只允許一個可寫連線。

### 15.3 實測

- 21,600 檔的合成專案（標頭檔每個 450 個 `#define`）：頁面 JS 記憶體全程約 32 MB；整個應用程式的處理程序記憶體建索引中暫時升到約 1.2 GB（子行程的 V8 垃圾回收延遲），建完回到約 450–650 MB；約 4 分鐘；問答 0.6–0.75 秒；測試在 `scripts/sqlite-index.itest.js`（4 項，2 萬檔／300 萬符號寫入約 50–80 秒、檔案約 200 MB、精確巨集查詢 1 ms）。

### 15.4 限制

- 只有桌面版的絕對路徑專案；網頁版 fap 專案仍是舊的記憶體索引。
- 建索引中途停止或失敗：SQLite 模式不接續（下次從頭分析，已分析的檔案記錄會被清掉重來）。
- 百科（`repo_wiki`）的索引檔案清單仍整份在記憶體；SQLite 模式只幫最重要的 2000 個檔案取回定義（非巨集、每檔 60 個）。
- HTML 匯出（sqlite_html／qa_html）仍吃整份記憶體資料庫，SQLite 模式暫不支援。
- 問答的小型資料庫是近似：被引用次數用 SQL 取出的呼叫者數量算（最多取到上限），個別排序可能與整份索引略有差異。
- `/aidoc save --map`／`load` 的 JSON 分享格式沿用；SQLite 索引本身就放在專案資料夾，不需要另外分享。

### 15.5 記憶體後端（網頁版與 `repoIndexSql=off`）的修正（2026-10-08）

網頁版沒有 SQLite 索引，仍用記憶體地圖，所以修掉三個一定會撞到的地方：① 名為 `constructor`／`toString` 的符號撞上 `Object.prototype`（`.push is not a function`，索引直接失敗）——以名稱為鍵的表改成沒有原型的物件；② 地圖存檔不再 `JSON.stringify` 整張地圖：序列化後約 6 MB 以上就把 `files`、`dirs` 切成每塊約 3 MB 的小記錄（`kind=repo_map_part`），最後才寫主記錄，載入時逐塊接回來（21,600 檔：73 塊，主記錄 320 位元組，載入約 8 秒）；`repoMapCache` 的配額從 48 MB 提高到 512 MB（舊配額會把超過它的地圖整筆淘汰）；③ 問答索引超過 30 萬個定義時不再整份 `JSON.stringify` 存起來（需要時從地圖重建）。**這些只是不讓它壞掉，沒有改變「整張地圖在記憶體」的事實**：21,600 檔的合成專案在記憶體後端建索引，整個應用程式的處理程序記憶體峰值約 2.3–2.9 GB（SQLite 後端是 1.7 GB 且與專案大小無關）。
