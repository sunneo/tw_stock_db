# AIDoc（專案索引）設計文件

> 舊名 DeepWiki／`/deepwiki`（仍保留為別名）。斜線指令：`/aidoc`、`/ai-repo-doc`。
> 第 16～19 節（2026-10-14）：與另一套實作的落差對照、說明獨立存放、匯出頁讀寫、大索引分段匯出、工程紀律——**都是設計，尚未實作**。
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
- 引擎是主程序的 `node:sqlite`（`sqlite-engine.js`，SQLite 3.53、含 FTS5），預設 `PRAGMA cache_size=-65536`（64 MB）；記憶體用量由 cache_size 決定，與資料庫大小無關。桌面版的絕對路徑專案、以及網頁版的 `fap:` 專案（sqlite-wasm＋OPFS）都走這條（`_idxEligible`）；網頁版建庫在 OPFS，完成後串流複製進專案資料夾，查詢用唯讀 VFS 直接讀專案資料夾裡的檔案。索引沒有檔案數量與大小的預設上限（`repoIndexMaxFiles`／`repoIndexMaxMb` 預設 0＝不限）。設定 `repoIndexSql`：`auto`（預設）／`off`。
- 建索引（`renderer/src/sql/index_core.js` 的 `builder`）：每分析一個檔案就 `addFile`，每個時間片 `flush`（一個交易、多列 INSERT）；完成階段解析匯入目標、算計數、名稱對定義的呼叫關係（與舊引擎一致：同名定義 ≤ 8 個、不在自己的檔案）、建索引、全文表。**不設上限**：每個定義（含每個巨集）、簽名 140 字、呼叫名稱 400 個、資料夾列表不限筆數、單檔 4 MB。
- 記憶體只留「瘦身的檔案記錄」：`{lang, lines, hash, doc, imports, nsyms, sql:1}`，定義與呼叫名稱都在資料庫。要用定義的地方（annotate 驗證名稱、explore、百科的重點檔）才從資料庫取（`_repoSymsOf`、`_repoWikiHydrate`）。
- 資料表：`files`（含 refs／used 計數）、`symbols`（含 used_by）、`imports`（只留解析成功的邊）、`uses`、`meta`，以及 FTS5 `sym_fts`（不含巨集）與 `file_fts`；全文表放的是**舊引擎倒排索引用的同一套語意詞元**（名稱拆字、說明、中英概念詞），查詢用同一個函式處理問題。
- 問答：不重寫引擎。問題進來時用 SQL 取出「問題點名的定義與檔案＋全文召回的候選＋引擎要談論它們所需的一切（這些檔案的全部定義、匯入的雙向鄰居、呼叫者與被呼叫者）」，組成只屬於這個問題的小型資料庫，交給原本的 `_faCodeAsk`／`_faCodeSearch`（`_idxMini`）。與記憶體引擎的對照：同一個專案 6 題，統計完全相同、意圖全同、回答逐字相同。
- 檢視器：`_aidocSqlRoute` 以 SQL 實作 info／概觀／樹／符號／說明／搜尋／檔案／定義／定位／問答；source、dive、note、prefs、jobs、explain 沿用原路由。
- 說明（notes）仍在地圖裡（小），問答時合併進小型資料庫（獨立存成 `notes.sqlite3` 的設計見 §17.2）。
- 接上：地圖不在（換電腦、瀏覽器資料被清掉）但專案資料夾裡有 `index.sqlite3` → `/aidoc load` 或 `index_start` 直接接上（`_idxAttach` 從資料庫重建瘦身記錄與資料夾列表），不重建。
- 引擎行為：每個連線一個子行程（取消、逾時＝砍行程，SQLite 自動回滾）；渲染行程重新載入時自動收掉它開的連線；同一個檔案只允許一個可寫連線。

### 15.3 實測

- 21,600 檔的合成專案（標頭檔每個 450 個 `#define`）：頁面 JS 記憶體全程約 32 MB；整個應用程式的處理程序記憶體建索引中暫時升到約 1.2 GB（子行程的 V8 垃圾回收延遲），建完回到約 450–650 MB；約 4 分鐘；問答 0.6–0.75 秒；測試在 `scripts/sqlite-index.itest.js`（4 項，2 萬檔／300 萬符號寫入約 50–80 秒、檔案約 200 MB、精確巨集查詢 1 ms）。

### 15.4 限制

- 網頁版已實作（OPFS 建庫→複製進專案資料夾→唯讀 VFS 查詢），但只在 OPFS 當作 FAP 的情況下實測過（6000 檔），尚未用真實資料夾與 7 萬～50 萬檔規模實測；沒有 OPFS 的瀏覽器退回記憶體索引。
- 建索引中途停止或失敗：SQLite 模式不接續（下次從頭分析，已分析的檔案記錄會被清掉重來）。
- 百科（`repo_wiki`）的索引檔案清單仍整份在記憶體；SQLite 模式只幫最重要的 2000 個檔案取回定義（非巨集、每檔 60 個）。
- HTML 匯出（sqlite_html／qa_html）仍吃整份記憶體資料庫，SQLite 模式暫不支援（設計見 §17.3～§17.5）。
- 問答的小型資料庫是近似：被引用次數用 SQL 取出的呼叫者數量算（最多取到上限），個別排序可能與整份索引略有差異。
- `/aidoc save --map`／`load` 的 JSON 分享格式沿用；SQLite 索引本身就放在專案資料夾，不需要另外分享。

### 15.5 記憶體後端（網頁版與 `repoIndexSql=off`）的修正（2026-10-08）

網頁版沒有 SQLite 索引，仍用記憶體地圖，所以修掉三個一定會撞到的地方：① 名為 `constructor`／`toString` 的符號撞上 `Object.prototype`（`.push is not a function`，索引直接失敗）——以名稱為鍵的表改成沒有原型的物件；② 地圖存檔不再 `JSON.stringify` 整張地圖：序列化後約 6 MB 以上就把 `files`、`dirs` 切成每塊約 3 MB 的小記錄（`kind=repo_map_part`），最後才寫主記錄，載入時逐塊接回來（21,600 檔：73 塊，主記錄 320 位元組，載入約 8 秒）；`repoMapCache` 的配額從 48 MB 提高到 512 MB（舊配額會把超過它的地圖整筆淘汰）；③ 問答索引超過 30 萬個定義時不再整份 `JSON.stringify` 存起來（需要時從地圖重建）。**這些只是不讓它壞掉，沒有改變「整張地圖在記憶體」的事實**：21,600 檔的合成專案在記憶體後端建索引，整個應用程式的處理程序記憶體峰值約 2.3–2.9 GB（SQLite 後端是 1.7 GB 且與專案大小無關）。

## 16. 落差對照：另一套實作的設計與我們目前的差異（2026-10-14）

比對另一套專案索引實作（同樣是把索引寫進專案資料夾、取消記憶體上限、匯出離線頁）的設計文件後，把我們**還沒有、或做法不同**的部分整理成下表，§17～§19 補上對應設計。標「已有」的不用再做，只列出來避免重複討論。

| 主題 | 對照實作的做法 | 我們目前 | 處理 |
|---|---|---|---|
| 索引放哪 | 專案根的隱藏資料夾，自帶 `.gitignore`，建索引時略過自己 | 已有：`<專案>/.floating-assistant/index/`，自帶 `.gitignore`（`*`），`FA_REPOMAP_IGNORE_DIRS` 略過 | 已有 |
| 建庫與取代 | 先寫暫存、完成才取代舊檔 | 已有：`index.sqlite3.building` → 取代 | 已有 |
| 巨集／大量符號 | 一度用雜湊桶 TSV，後改成同一個 SQLite | 已有：全部寫進 SQLite `symbols`，沒有上限 | 已有（不需要雜湊桶） |
| 第一次寫入的同意 | 第一次建索引彈出頁內對話框，說明寫到哪、只寫隱藏資料夾；拒絕就退回有上限的記憶體索引並在回覆說明 | 桌面版直接寫（設定 `repoIndexAutoSave` 預設 `all`）；網頁版靠 fap 的讀寫授權對話框 | **補：§17.1** |
| 說明（notes）存放 | 一度放瀏覽器記錄＋`notes.json`；後來決定搬進獨立的小庫、索引庫維持唯讀 | 仍在地圖（瀏覽器記錄）裡，問答時合併進小型資料庫；沒有獨立檔案 | **補：§17.2** |
| 匯出頁 | 匯出頁自己授權專案資料夾，讀寫原始碼與資料庫，說明寫回去 | 匯出的 HTML 還是吃整份記憶體資料庫，SQLite 索引的專案**不支援匯出**（§15.4） | **補：§17.3、§17.4** |
| 大索引匯出 | 資料庫不進 HTML；分段複製成隱藏資料夾裡的檔案，頁面靠 fap 延遲載入 | 沒有 | **補：§17.5** |
| AI 說明的品質 | 單一函式解釋要附真的原始碼片段；授權條款樣板不當檔案用途；整包更新只餵結構化摘要 | 深入探討（`/aidoc dive`）已讓 AI 讀檔；但「摘要被當成原始碼餵回去」「授權樣板當用途」這兩類退化沒有防護 | **補：§17.6** |
| 原始碼檢視器 | 有 `檔案:行號` 就能開一個語法上色、指定行強調的視窗 | 檢視器內嵌展開已有（上一節「檔案:行號 內嵌展開」）；匯出頁沒有 | **補：§17.7**（沿用 `deck_code.js`） |
| 問答面板版面 | 預設常駐右側，可停靠右／下／上 | 互動檢視器已有（§11）；匯出頁沒有 | **補：§17.8** |
| 離線 Viewer 程式 | 另做一個極小的 Electron 包裝，只開本機靜態伺服器 | 桌面版本來就是 Electron；沒有「只開匯出頁」的獨立入口 | **補：§17.9**（先不做，列選項） |
| 事故教訓 | 子字串釘住整份原文、名稱撞 `Object.prototype`、暫存表沒主鍵變平方級、多語句 schema 遇到重複欄位整批中止、快取導致「改了沒效果」 | 名稱撞原型已修（§15.5）；其餘多數沒有明文規則 | **補：§18** |

## 17. 設計：索引的同意、說明獨立存放、匯出頁能讀寫

### 17.1 第一次寫進專案資料夾的同意（桌面版與網頁版一致）

原則：**索引寫在使用者專案裡，這件事要先講清楚；而且被拒絕時不能壞掉。**

- 第一次對某個專案建索引、且設定裡還沒有這個專案的寫入決定時，彈出頁內對話框（走 `requestUserForm`，不是瀏覽器原生對話框，桌面版也一致）。文字要包含三件事：寫到哪（`.floating-assistant/index/`，隱藏）、只會寫進這個隱藏資料夾不會動原始碼、會自帶 `.gitignore` 不會被 git 加入。按鈕：〔不儲存〕〔儲存到專案資料夾〕。
- 決定記在專案層級設定（`repoIndexDisk:{<root>: 'yes'|'no'}`），不是全域；`repoIndexAutoSave` 仍是「完成後要不要自動存說明／索引資料」這個**第二層**偏好，兩者不要混成一個開關。
- 選「儲存」：網頁版接著走現有 fap 讀寫授權；桌面版直接寫。之後每次索引回覆多一行 `💾 索引寫入「…」（不設上限）`。
- 選「不儲存」或授權被拒：退回記憶體後端，**維持舊的保護上限**（每檔最多保留的定義數、地圖大小上限），回覆明說 `⚠️ 不寫入專案資料夾：已啟用保護上限`，並在進度卡片上提供一個按鈕改選「儲存」。不允許「沒寫入卻假裝沒有上限」。
- 之後仍可在「設定 → AI → 專案索引」改這個專案的決定；改成「不儲存」不刪除既有檔案，只是不再更新，並提示可手動刪除資料夾。

### 17.2 說明（notes）獨立存成 `notes.sqlite3`

現況（§15.2、`DESIGN.sqlite.md` §6）：說明留在瀏覽器記錄的地圖裡、問答時合併。問題：①換瀏覽器／換電腦看不到說明（除非另外 `/aidoc save`）；②匯出頁若要「把說明寫回去」，必須有個**不會被重建索引覆蓋**的家；③索引庫要保持唯讀（重建時整檔取代）。

設計：同一資料夾再放一個小庫 `notes.sqlite3`，**重建索引絕不碰它**。

```
<專案>/.floating-assistant/index/
├── .gitignore            "*"
├── meta.json             格式、版本、時間、檔案數、符號數（讓人不開資料庫也能看）
├── index.sqlite3         唯讀；建索引時整檔取代
├── notes.sqlite3         讀寫；使用者與 AI 寫的說明
└── .export.parts/        匯出大索引用（§17.5），隨時可刪
```

`notes.sqlite3` 資料表：

| 表 | 欄位 | 說明 |
|---|---|---|
| `file_notes` | `path` PK, `note`, `author`, `ts`, `hash` | `hash`＝寫說明當時檔案內容的雜湊，用來標「可能過期」（沿用現有 `notes_meta` 的語意）；資料夾說明也存這張表（路徑以 `/` 結尾區分，不另開表） |
| `sym_notes` | `path`, `name`, `note`, `author`, `ts`, `hash`，PK(`path`,`name`) | 定義說明 |
| `glossary` | `term` PK, `definition`, `author`, `ts` | 名詞表 |
| `meta` | `k` PK, `v` | `schema_version`、`notes_ver` |

規則：
- 說明長度與換行規則沿用現有（保留換行、上限 2000 字）。
- **合併**：兩邊（瀏覽器記錄的地圖、`notes.sqlite3`）以 `at` 較新者勝；同一筆 `at` 相同以 `by:user` 優先。主程式開啟專案（`_idxAttach`／`/aidoc load`）時做一次合併，之後寫入同時寫兩處（瀏覽器記錄當快取，檔案是權威）。
- 權威來源是檔案：瀏覽器記錄被清掉後，下次接上專案就從 `notes.sqlite3` 還原，不需要 `/aidoc save`／`load`（這兩個指令保留給舊的 JSON 分享格式）。
- 引擎：桌面版走現有 `sqlite-engine.js`（可寫連線，一個檔案一個）；網頁版走寫回式 VFS（`wasm_vfs.js` 的第②層）。庫很小，網頁版直接「全讀進記憶體、改完全寫回」即可，不需要走髒頁溢出。
- 索引庫本身**不增加**說明欄位；問答時的小型資料庫仍由 `index.sqlite3` 查出結構、再合併 `notes.sqlite3` 的說明（現在是合併地圖裡的說明，來源換掉而已）。

### 17.3 單檔匯出支援 SQLite 索引（小專案）

目標：`index.sqlite3` 的專案也能 `sqlite_html`／`qa_html` 匯出，不再因為 `backend==='sqlite'` 被擋。

- 讀 `index.sqlite3` 全部位元組（只在**小於 §17.5 門檻**時走這條），用匯出頁已經內嵌的 sql.js 開啟。
- 匯出頁範本需要、但即時查詢庫沒有的相容表／視圖，在**匯出當下**於記憶體副本補上（`pages`、`glossary`、`v_symbols`／`v_imports`／`v_uses` 之類），並把 `notes.sqlite3` 的說明灌進對應欄位。**補 schema 時每一條 `ALTER`／`CREATE` 各自 `try/catch`**（不要一次多語句 `run()`）：資料庫可能已有同名欄位，多語句在第一個「duplicate column」就整批中止，產出一個看似成功、實際是空殼的匯出。
- 匯出頁開啟後的行為見 §17.4；這條路徑與舊的記憶體匯出共用同一份 `code-ui.template.html`，用 `TPL_BUILD`（§18）區分版本。

### 17.4 匯出頁自帶 File Access Point：讀寫原始碼與說明

對應 `DESIGN.TODO.project-index-html.md`「匯出的 HTML 要能自己讀寫、自己問答」。

- 匯出頁用 `showDirectoryPicker({mode:'readwrite'})` 取得專案資料夾；handle 存在**這個頁面自己的 IndexedDB**（`aidoc-export-fap`），下次開啟先用不需要手勢的 `queryPermission` 靜默檢查，狀態列顯示「尚未授權／已授權」。
- `ensureProjectRoot()` 需要使用者手勢，**必須在載入離線模型之前呼叫**——模型下載動輒數十秒，手勢早過期了。流程固定：點「問」或「AI 解釋」→ 先 `ensureProjectRoot()` → 再載模型。
- 能做的事：①讀真實原始碼（解釋、原始碼檢視器 §17.7）；②讀寫 `notes.sqlite3`（§17.2，用 sql.js 全讀全寫）；③讀 `index.sqlite3`（大索引走 §17.5）。**不會**寫 `index.sqlite3`。
- 專案不是磁碟索引（舊記憶體後端）時，說明只停在這次瀏覽階段，頁面要明說，不能假裝存了。
- 內建 AI 問答：頁面自己下載小模型（預設與主程式相同，Qwen3 0.6B；`DESIGN.offline-text.md`），模型放進專案隱藏資料夾 `.floating-assistant/models/` 並可載入瀏覽器 persistent storage（同一份快取，不重複下載）；靜默下載、用到才載入。要先確認：`file://` 開啟時能否抓 HuggingFace（CORS）、單檔大小（sqlite wasm＋模型載入器）、網頁版與桌面版授權流程差異。
- 問答分工（沿用離線食譜的思路，`DESIGN.offline-recipes.md`）：**結構由程式查**（SQL／全文表召回、符號、依賴、呼叫關係），小模型只負責措辭與選擇題；不要叫 0.6B 去硬讀整份原始碼。

### 17.5 大索引匯出：分段寫進資料夾，頁面延遲載入

事故型態（對照實作實測過）：把整個資料庫讀進記憶體、再用 sql.js 建第二份、轉成陣列、壓縮、塞進單一 HTML 字串——幾百 MB～GB 的資料同時有好幾份，WASM 記憶體先爆（分頁崩潰）。互動檢視器沒事，因為它從不把資料庫讀進記憶體。

設計：**資料庫不進 HTML**。

- 門檻 `PARTS_THRESHOLD`：`index.sqlite3` 大於 100 MB（建議值）改走分段匯出；以下維持 §17.3 單檔。
- 在 `.floating-assistant/index/.export.parts/` 建立隱藏資料夾，把 `index.sqlite3` **一段一段**（每次 8 MB 的 `File.slice` → `createWritable`，記憶體固定）複製成 `db-0000.part …`（每份 64 MB）；另寫 `notes.sqlite3` 的副本、`viewer.html`（頁面副本，整個資料夾可直接分享），**最後才寫 `manifest.json`**（各分段檔名／大小、`exportId`）——沒有 manifest 的資料夾就是沒匯出完，頁面要明說。每次匯出刪掉舊的 `.export.parts/` 再重建。
- 下載的頁面只有檢視器程式、sqlite-wasm、核心腳本與唯讀 VFS，**不含資料**（約 2 MB，跟專案大小無關）。
- 開啟：靜默檢查 handle 權限 → 沒授權就顯示「授權專案資料夾」按鈕 → 讀 `manifest.json`、驗證每段大小與 `exportId` → 把各分段的 `File` 串成**一個 `Blob`** 交給查詢 worker。
- 查詢 worker 以唯讀 VFS 開這個 Blob：`FileReaderSync.readAsArrayBuffer(blob.slice(a,b))` 在 worker 內是同步的，所以 SQLite 的同步 xRead 可直接讀，**不需要 SharedArrayBuffer／跨來源隔離**；只讀查詢碰到的頁面（256 KB 區塊 LRU）。可沿用 `wasm_vfs.js` 的第①層（`fapfile`）。
- 限制（要寫進頁面說明）：分段只是同一個檔案的位元組切片，任何一段遺失就開不起來（大小驗證會報錯）；第一次搜尋偏慢（冷快取）；沒有「AI 補充回答／深入探討」以外需要離線模型的功能時，仍給離線問答的結果。
- 他處以合成索引實測（623 MB／908 MB）：匯出約 2～3 秒、匯出時 JS 記憶體高峰約 50～63 MB、頁面 JS 記憶體約 5 MB、開啟 0.3 秒。**我們尚未重測**，上線前要用真的 `showDirectoryPicker` 資料夾與 7 萬檔以上的專案各測一次。

### 17.6 AI 說明的品質防護

目的：弱模型（Qwen3 0.6B）寫出的說明不要「看起來有內容、其實是翻譯識別字」。

1. **摘要不等於原始碼。** 單一函式「AI 解釋」的流程若是「模型呼叫 `read_file` → 回傳結構化摘要」，模型從頭到尾沒多讀到一行程式；沒有文件註解的函式就只剩名稱與簽名，模型只能把識別字拆開猜。規則：`read_file` 之後，必須從證據清單找出對應路徑，用 `extractSourceSpan(text, startLine, maxLines)` 取一段**有界的真原始碼**（大括號配平找函式結尾，找不到就在 `maxLines`＝80 行硬截斷；不處理字串／字元常值裡的大括號、不支援無大括號語言，但保證不會抓整個檔案）附在摘要後面。
2. **整檔／批次**仍只用結構化摘要（檔案說明＋最多 25 個非巨集符號的種類／簽名／說明），不塞原文——讓 0.6B 改寫一份已抽取好的清單可行，要它從頭讀沒看過的原始碼摘要通常不行。
3. **授權條款樣板不當檔案用途。** 檔案級 `doc` 若長得像授權條款開頭（`BOILERPLATE_RE`：license／copyright／SPDX／permission is hereby granted 等），餵模型前丟掉，改靠符號清單。
4. **批次更新「整包更新 AI 筆記」**：依「被最多檔案匯入」排序逐檔跑；每 5 檔才寫回一次（每檔都寫太慢）；可中途停止；有真正的進度條（成功失敗都更新）；寫入目標是 `notes.sqlite3`。
5. **資料夾說明**：資料夾名稱本身是連結（`folder:path`），點進去顯示子檔案／子資料夾數量與便宜的 AI 摘要——只用子檔案已有的說明與文件組成，不重新讀檔，存進 `folder_notes`。
6. 每一種說明都記 `by`（`ai`／`user`）、時間與當時檔案雜湊；使用者寫的不被 AI 覆蓋（沿用現有規則）。

### 17.7 匯出頁的原始碼檢視器

- 只要畫面上有 `路徑:行號`（符號詳細頁每個定義旁、檔案頁定義表每一列、問答卡片的「相關位置」），就能點開一個**覆蓋層**，不必先切分頁。
- 不另寫語法上色：直接沿用簡報的 `code` 視覺元件 `renderer/src/deck/deck_code.js`（純函式、不碰 DOM、不連網；`create({code, filename, start_line, highlight:[[a,b]]})` 已有語法上色、指定行強調、捲動與捲軸）。匯出時把它內嵌進頁面（跟其他內嵌資產同一種做法，`scripts/embed-code-ui.js`）。
- 讀檔走 §17.4 的 fap；**不需要先載入離線模型**（純讀檔＋畫圖）。滾輪、拖曳捲軸、Esc／點背景關閉、視窗縮放重繪都直接呼叫元件既有 API。
- 完全未在真實瀏覽器驗證過的項目：DPI 換算、捲軸手感、各視窗大小的版面、非 C 語言檔案的上色。

### 17.8 匯出頁版面

- 問答面板**預設常駐右側**（不是獨立分頁），可停靠右／下／上；拖曳分隔線調整、雙擊還原、大小存 `localStorage`——跟互動檢視器（§11）同一套操作與偏好格式。
- 停靠到下方／上方時，面板內層容器**不要留固定 `max-width`**（右側只有幾百像素寬看不出來，改到上下停靠才會只佔一半寬）。
- 切換停靠模式時要清掉會把主畫面藏起來的整頁模式 class，否則停靠看起來沒有效果。

### 17.9 離線 Viewer 程式（先不做，列選項）

桌面版已是 Electron，不需要另一個包裝程式才有 File System Access：Electron 的 renderer 就是 Chromium，只要用 `http://127.0.0.1:<固定port>` 而不是 `file://` 載入（安全情境），`showDirectoryPicker`、持久化 handle、真實讀寫都與一般瀏覽器分頁相同，不需要自訂 IPC 橋接。`local-proxy.js` 已有靜態檔案伺服器（`serveStaticFile`）。若將來要「只開匯出頁」的獨立入口：①在桌面版加一個「開啟匯出頁」選單，用同一支伺服器開使用者選的 HTML；②固定 port（瀏覽器快取、授權 handle 跟著 origin 走，port 變了授權就沒了）；③不隨主程式打包原始碼給終端使用者看。獨立安裝檔（Windows／Linux）不在這一輪範圍。

## 18. 工程紀律與事故教訓（寫成規則）

| 規則 | 原因（別人撞過的） | 我們目前 |
|---|---|---|
| 長期保存、由大文字切出來的字串，先脫離父字串（串接後 `charCodeAt` 強迫壓平；或整筆 `JSON.parse(JSON.stringify())` 複製一次） | V8 子字串會一直持有整個父字串；「只留 40 字元的名稱」其實把整個檔案釘在記憶體，緩衝數百萬行就崩潰 | SQLite 後端寫入是複製進引擎，不受影響；**記憶體後端（網頁版沒有 OPFS、`repoIndexSql=off`）沒有逐處檢查**，列入待查 |
| 以名稱為鍵的表一律 `Object.create(null)`，包含建庫程式自己用的 `seen = {}` | `constructor`／`toString`／`valueOf` 撞 `Object.prototype`，索引、搜尋、呼叫關係都壞 | 已修（§15.5）；建庫與完成階段的暫時表要補查 |
| 完成階段的暫存表要有主鍵（以查詢鍵為主鍵），並有規模測試 | 無主鍵時每個 `UPDATE … (SELECT … FROM 暫存表 WHERE …)` 掃整張表，平方級；10 列測不出來，200 萬符號卡好幾分鐘 | `index_core.js` 的完成階段待確認；`sqlite-index.itest.js` 已有 2 萬檔／300 萬符號，補一個「完成階段須在時限內」的斷言 |
| 寫庫失敗與存檔失敗都要把工作狀態結束並顯示錯誤，不可永遠顯示「進行中」 | 沒有 `.catch` 導致使用者以為還在跑 | 索引主流程已有；匯出、批次更新說明、分段複製各自要有 |
| 補 schema 的多語句，每條各自 `try/catch` | 多語句遇到第一個重複欄位就整批中止 → 看似成功的空殼 | 新設計（§17.3）明定 |
| 範本／核心這類「匯出時才 fetch」的資產用 `fetch(url,{cache:'no-store'})`，不要依賴 `?v=` | 版本號不涵蓋該資料夾，改了範本使用者還是拿舊的 | 匯出現行流程待查；新匯出一律 `no-store` |
| 匯出頁帶一個肉眼可見的建置標記（`TPL_BUILD`，手動遞增，顯示在頁面角落） | 「我改了沒效果」常常是拿到舊匯出檔，不是程式錯 | 新增 |
| 長時間「看不到效果」先查**哪個檔案被執行**（來源、部署位置、實際網址三處比對雜湊），再懷疑邏輯 | 曾經繞很久才發現執行的是舊 worker | 網頁版是從 GitHub 抓引擎再載入，查之前先看抓到的版本；桌面版看 `update-manifest.json` |
| 匯出頁與其範本以真實瀏覽器（含 headless Chromium）實際操作驗證，不只讀程式碼 | 讀程式碼看不出「停靠沒效果」「連結卡在一行」這類版面事故 | 新增驗證層（§19） |

## 19. 狀態、驗證與已知限制（本輪新增的設計）

**狀態（2026-10-14 第二次更新）**
- 已實作並驗證：§17.1 同意流程、§17.2 `notes.sqlite3`、§17.3 單檔匯出支援 SQLite 索引、§17.4 匯出頁自帶資料夾授權（讀原始碼、讀寫說明）＋**頁內「🧠 解釋」**（語法樹＋函式語意＋離線模型，見 §20）、§17.5 大索引分段匯出（見下）、§17.6 全部（授權條款樣板過濾、`extractSourceSpan`、批次更新、資料夾說明、使用者說明不被 AI 覆蓋）、§17.7 原始碼檢視器、§17.8 右側問答面板。
- §17.5 分段匯出的實測（合成專案 1,200 檔／21,600 定義，資料庫 7 MB，切成 8 份 1 MB）：匯出 0.17 秒；頁面 0.95 MB（含 sqlite-wasm 與解釋引擎，跟專案大小無關）；授權資料夾後開啟、檔案樹／符號搜尋／問答／SQL／寫說明都能用；刪改一份分段檔（大小不符）→ 頁面明確報錯；重新開啟時靜默沿用上次授權。**沒有測**：100 MB 以上、7 萬檔專案；真的 `showDirectoryPicker` 原生視窗（用 OPFS 取代）；網頁版（fap）的分段寫出路徑（程式有寫，沒執行過）。
- **尚未實作**：§17.9；模型檔存進專案 `.floating-assistant/models/`（現在只存瀏覽器快取，即 Cache API 的持久儲存）。
- 注意：匯出頁寫 `notes.sqlite3` 是「全讀全寫」，若桌面版同時開著同一個檔案並寫入，後寫的會蓋掉先寫的；目前不做鎖定。

建議的實作順序（每步可獨立上線、可各自回退）：
1. §17.2 `notes.sqlite3`（匯出頁與同意流程都依賴它）。
2. §17.1 同意與拒絕時的保護上限。
3. §17.3 小專案單檔匯出支援 SQLite 索引＋§17.8 版面。
4. §17.4 匯出頁自帶 fap＋§17.7 原始碼檢視器（不依賴離線模型）。
5. §17.6 說明品質防護（`extractSourceSpan`、`BOILERPLATE_RE`、批次、資料夾說明）。
6. §17.5 大索引分段匯出。
7. §17.4 的內建離線問答（要先解決 `file://` 抓模型的問題）。

驗證計畫：
- 純函式測試：`extractSourceSpan`（配平、截斷、找不到結尾）、`BOILERPLATE_RE`、`notes.sqlite3` 合併（`at` 規則、`by:user` 優先、雜湊過期標記）、補 schema 對「已有同名欄位」的容錯。
- 整合測試：沿用 `scripts/sqlite-index.itest.js` 的 fixture 建庫，加「重建索引後 `notes.sqlite3` 不變」「分段複製大小與雜湊一致」。
- 真實瀏覽器：用 headless Chromium＋OPFS 當專案資料夾跑完整匯出→開啟→授權→查詢→寫說明；再用真的 `showDirectoryPicker` 手動走一次。

已知限制：
- 分段匯出的資料庫要完整才能開；說明寫回 `notes.sqlite3` 需要寫入授權，沒有就只在這次瀏覽有效。
- 說明合併是以時間戳判斷，兩台機器時鐘差太多時會誤判；先接受，必要時改用單調遞增的 `notes_ver`。
- 他處實測的數字（匯出時間、記憶體、開啟時間）**不是我們的**，上線前必須重測，不得當成我們的效能宣稱。
- 匯出頁的內建離線問答、原始碼檢視器在別處也屬「未經真實瀏覽器完整驗證」，我們照搬時要把同樣的驗證缺口列為待辦。

## 20. 「檔案用途／函式做什麼」：語法樹＋基礎函式語意＋文字重排＋離線小模型（2026-10-14）

需求：說明要靠離線訓練器（Domain Resolver）的能力查出來，不是叫小模型硬讀原始碼；模型只負責措辭。

分層（`renderer/src/explain/code_explain.js`＝`FaExplain`，純函式；主程式與匯出頁共用同一份）：

| 層 | 做什麼 | 來源 |
|---|---|---|
| 事實 | 每個函式的註解、行為分類、呼叫了哪些標準函式（附白話語意）、專案內呼叫、被誰呼叫、複雜度；組合語言檔（`.S`／`.asm`）掃描指令類別 | `FaBeh2`（web-tree-sitter 語法樹＋`api_semantics`＋組語指令表） |
| 整理 | 依「註解 → 行為分類＋標準函式語意＋專案內呼叫」組出一句程式版說明（標「自動分析」）；檔案用途＝檔頭註解（濾掉授權樣板），否則彙整函式與行為；資料夾＝只用子檔案已有的說明 | `FaExplain.describeFn／describeFile／describeFolder` |
| 重排 | 事實太多放不進小模型上下文時，用文字重排＋語意向量（`FaBeh2.selectWithinBudget`／`summarizeBlocks`，有 `_faSemEmbed` 時用語意相似度圖＋PageRank＋多樣性）挑最相關的幾句；資料夾挑代表性的子檔案說明 | `FaExplain.buildMessages／describeFolder` |
| 措辭 | 離線文字模型（預設 Qwen3 0.6B）把挑出的事實寫成一句繁體中文；附有界的真原始碼（`extractSourceSpan`，函式 40 行）；一個示範問答（few-shot）固定格式與語言 | `FaExplain.buildMessages`＋`_llmGenerate`（桌面）／內嵌 worker（匯出頁） |
| 驗證 | 模型輸出不可用就退回程式版：空的、太長太短、複述名稱、簡體字（0.6B 常用簡體回答）、英文識別字不在事實裡（編造名稱）、拒答、重複 | `FaExplain.cleanModelNote` |

每筆說明都記來源：`comment`（原始碼註解）／`auto`（程式組出）／`model`（模型潤飾），使用者寫的不被 AI 覆蓋。

入口：
- 桌面：設定頁「🧠 離線更新說明」、`/aidoc notes [--limit N] [--no-model]`；依被引用多寡逐檔、每 5 檔寫回一次、可停止／接續；最後補資料夾說明（路徑以 `/` 結尾，存在 `file_notes`）。設定「離線更新說明」可選「只用程式」。
- 匯出頁：符號／檔案旁的「🧠 解釋」（先授權資料夾 → 讀原始碼 → 語法樹分析 → 可選模型潤飾 → 可編輯後存成說明）；資料夾名稱旁的「ⓘ」進資料夾頁、「🧠 產生資料夾說明」。tree-sitter 與模型從 CDN／HuggingFace 下載一次，存瀏覽器快取。

實測（桌面版 Electron，CPU，Qwen3 0.6B）：每則說明約 5 秒；**約一半的模型輸出被驗證擋下**（簡體、編造名稱、語意錯誤的在驗證下仍可能漏網，例如把 `abort()` 寫成「填充記憶體」），所以預設仍保留程式版說明做底、模型只在驗證通過時替換；使用者可在設定頁關掉模型。0.6B 的措辭品質有限，這是已知限制，不是調參能解決的。

## 21. 與 Redmine 外掛（redmine_ai_chat）的 CHANGES 對齊，以及 C# 索引補洞（2026-10-14）

對照另一邊 `redmine_ai_chat/CHANGES.md`＋`DESIGN.project-index.md` §12–§14，這邊補上的：

- **C# 抽取（這邊獨有的洞）**：正規表示式版 `_faRepoExtract` 對 C# 只抓類別，而且 Kotlin 的 `object` 關鍵字會把參數 `object sender` 當定義；沒有任何方法，所以 `InitializeComponent`、`OnPaint` 都「索引裡沒有」。現在抓 namespace／類別／結構／介面／列舉／record／方法（含建構子、override、單行、多行參數）／屬性，XML 文件註解拿掉標籤；抽取器版本 `sv=3`，舊索引的 C# 檔在「接續索引」時自動重新分析。限制：一行裡同時有類別與方法（`class A { void F() {} }`）只記類別。測試 `scripts/repo-extract.test.js`。
- **索引完成的判定**：讀不到／分析丟例外的檔案（`job.skipped`）不再重試、不擋住 `index_built`（以前 289／290 永遠「部分」，沒有「開啟檢視器」「離線更新說明」）；專案索引頁列出沒分析到的檔案與原因（`map.skipped_files`）。
- **檢視器導覽歷史**（aidoc 檢視器、單檔／分段匯出頁共用同一份邏輯）：◀ ▶（Alt+←／→、滑鼠上一頁／下一頁鍵）、🕘 清單（最新在上、標「目前」「下一個位置」、死路標 ⚠）、**每一筆記得捲動位置**、最多 200 筆。
- **完整名稱的符號連結**：`Namespace.Class.Method` 查不到時改用最後一段（`.`、`::`、`->`、`#` 之後）再查，並在頁首說明「用最後一段查到」；最後一段也沒有時，說明常見原因（繼承／覆寫／框架／沒建索引的函式庫）、列名字相同的其他定義、可回上一個位置。
- **說明（note）是 Markdown**：匯出頁的檔案說明、定義說明用 Markdown 渲染（表格不再是一排 `|---|`）；定義清單裡長的說明（> 220 字或含換行）收在第一行的 `<details>` 底下；單檔匯出頁第一次把定義說明列進定義表。
- **行為說明的泛用方法名**：Java／JavaScript／Python 的「接收者後面的單字泛用方法名」（`map.get`、`names.size`、`x.join`…）不分類——要名稱夠特別（有大寫或底線、長度 ≥ 9）或語言明列放行（`bare_ok`：Python 的 `cursor／execute／commit`、JS 的 `on／emit／then`、Java 的 `send／submit`）。以前 `map.get` 被當成並行、`names.size` 被當成檔案。語法樹裡 `ERROR` 區段（原始碼有語法錯誤或文法不認得新語法）的呼叫改用文字比對補，只補查得到分類的，標「（語法錯誤區段）」。
- **這邊已經有、不用補**：單一函式讀真原始碼（這邊的說明是語法樹事實＋敘事，不是只餵符號清單）、授權條款樣板不當說明（`BOILER_RE`）、`#p-ask` 沒有殘留的 `max-width`、分段匯出、原始碼檢視器、整包更新、問答停靠。
- **那邊有、這邊刻意沒有**：Electron 離線 Viewer App（這邊本身就是 Electron）；那邊沒有、這邊有的：`behavior_define`、`api_semantics`、`_faBehFold` 的正向路徑展開。
