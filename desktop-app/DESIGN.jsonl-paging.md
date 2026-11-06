# 超大回應轉 JSONL、分頁器、讀取帳本、VLM 拆解續傳（已實作部分）

使用者原話（2026-11-05）：「缺口要補，以及先把超大回應的轉 jsonl，因為像是請 vlm 去看一張圖拆解，他可能回應 6000-8000 個物件，結果斷掉。但如果用 jsonl，就很好持續傳達」。
還沒做的（檢視器 `.jsonl`／`.ndjson`／`.jsonc`、離線種類表、離線小模型調校）仍在 `DESIGN.TODO.md` 的「JSONL 分頁器與檢視器」一節。

## 一、格式（給模型看的一頁）

第一行是 meta：`{"_page":{...}}`，其後每行一筆記錄（單行 JSON，內容的換行已跳脫）。meta 欄位：

| 欄位 | 意思 |
|---|---|
| `source` | 內容代號（`bc_N`，暫存在 `_bigStore`） |
| `page`、`from`、`to`、`returned` | 第幾頁；這一頁涵蓋第 `from` 到 `to`（半開、0 起算）；實際回了幾筆 |
| `total`、`total_exact` | 總筆數；是不是確切值 |
| `has_more`、`next_cursor`、`done`、`read_records` | 還有沒有下一頁；下一頁的 cursor（不透明，原樣帶回）；最後一頁才有 `done:true` |
| `limit` | 這一頁的筆數 |
| `digest` | 這一頁內容的短雜湊 |
| `head`、`head_omitted` | 大陣列以外的欄位，只在第一頁，太大就不放（`head_omitted:true`） |
| `continue` | 一句可以直接照做的續讀呼叫：`big_content({"id":…,"action":"page","cursor":…})` |
| `record_part` | 單筆比一頁還大時分段：該頁只有 `{"_part":{record,part,of,text}}` 一行，把 `text` 依序接起來才是那一筆 |
| `hint` | 中文提示（沒讀完就不要下結論） |

cursor 格式 `c1:<來源>:<第幾筆>:<第幾段>:<第幾頁>`，解碼時驗證版本、來源、範圍，亂填回明確錯誤，不亂讀。

大小一律跟 `contextWindowTokens` 按比例（`_pagerBudgetChars()`：自動代理 25%、一般 15%、每 token 估 3 字元、乘 0.9），**沒有字元下限**，一頁至少 1 筆（或 1 段）。不知道窗口大小才退回工具結果預算。

## 二、模組與接線

| 位置 | 做什麼 |
|---|---|
| `renderer/src/agent/jsonl_pager.js`（純函式、UMD、`new Function` 載入，嵌入常數 `FA_JSONL_PAGER_SRC`；網頁版延遲載入清單排除 `JSONLPAGER`，因為同步使用） | `toRecords`（陣列／含占大宗陣列的物件／JSONL 文字 → 一行一筆）、`page`、`encodeCursor`／`decodeCursor`、`parsePage`、`parseLines`、模型輸出續傳的 `streamPrompt`／`continuePrompt`／`absorb`／`runStream` |
| `_truncateToolResultForContext`（總截斷） | 超過預算且是記錄清單 → 暫存後回**第 1 頁**（原本只放開頭＋概要）；不是記錄清單才走原本截斷。同時把這一頁記進讀取帳本 |
| `big_content` | 新增 `page` 動作（`cursor`）；`read` 補 `has_more`；`info` 加 `records`、`shape`、`can_page`；`json` 動作遇 JSONL 文字逐行解析 |
| `_visionChat(cfg, messages, maxTokens, {meta, timeoutMs})` | 可回傳 `{content, finishReason, ms}`；空回覆的錯誤訊息附 finish_reason 與耗時 |
| `_visionJsonlStream`、`_bigStashRecords`、`interpret_image` 的 `output:'jsonl'` | VLM 拆解（見第四節） |
| `renderer/src/agent/read_ledger.js` | 覆蓋範圍（見第三節） |

內部呼叫者（`_faOtFollowAll`、python 橋、各工具自己的 `has_more`／`next_offset`）完全沒動：分頁格式只套在「給模型看的最後一步」，所以不要求重裝、舊欄位都在。文字類工具（網頁、PDF、程式碼）維持字元／行分頁，不轉 JSONL。

## 三、讀取帳本的四個缺口（已補）

| 缺口 | 怎麼補 |
|---|---|
| 只記「下一個位置」，跳到最後一頁就把整個來源清掉 | 帶 `_page` 的結果改記**已讀區間**（`covered`，合併相鄰與重疊）與缺口（`gaps`）；整份從 0 連續覆蓋到 `total` 且收到 `done` 才算讀完；身分用 `meta.source`，不分哪個工具回第一頁；讀完的來源記在 `completed`，之後重讀其中一頁不會又變成「沒讀完」 |
| 總截斷看不到（帳本是在截斷之前記的） | 截斷產生第 1 頁時直接記一筆；`big_content page` 與 `interpret_image` 回的 JSONL 頁，由 `_noteReadLedger` 解析第一行 meta 後記 |
| `big_content read` 沒有 `has_more` | 補上 `has_more`、`next_offset` |
| 提醒 3 次就放行 | 記錄清單的缺口提醒到 5 次，提醒文字附每個缺口的 **cursor**，可直接照做；提醒用完仍放行，但**警語由程式附在答案前面**（寫明「只讀了 a／total 筆，沒讀到第 x～y 筆」），不靠模型自己說 |

新欄位都是選用的：舊 entry（沒有 `unit`／`covered`）照舊邏輯運作，舊測試全過。

## 四、VLM 拆解圖片「斷掉」：在哪一層斷、怎麼處理

**調查（讀程式確認，加上假伺服器實證）**：`interpret_image` → `_interpretImageOnline` → `_visionChat`。

1. `_visionChat` 的輸出上限寫死 `max_tokens` 2048（多圖 3072），逾時 60 秒；一個物件約 15～25 token，6000～8000 個物件需要十幾萬 token，**不可能一次寫完**。
2. `_visionChat` 只回字串，**不看 `finish_reason`**：被 `length` 攔腰截斷也當成功。實證（假伺服器，`max_tokens` 2048）：回傳 6144 字元、最後一行是 `{"id":245,"label`——半行，呼叫端完全不知道被截斷。
3. 就算沒被截斷，結果是一大段文字塞進 `description`，超過工具結果預算又被總截斷成「開頭＋概要」，後面的物件看不到。
4. 沒有用真的線上視覺模型量到實際斷在哪（需要使用者的金鑰）；上面是程式路徑與假伺服器的實證。

**處理**：

- `interpret_image` 加 `output:'jsonl'`；問題裡有「拆解」「分解」「所有物件」「列出…物件」「bbox」「segment」等字也自動用。只用線上視覺模型（離線模型寫不出這麼多）。
- 每一輪要求「一行一個 JSON 物件、有連續 `id`、最後一行 `{"_end":true}`」；`absorb` 只收**完整的一行**，被截斷（`finish_reason:'length'`，或沒有行尾換行又不是 `stop`）就丟掉最後的半行；
- `runStream` 用「已經收到 N 筆（最後一筆 id 是 X，內容…），請從 id X+1 接著輸出」續傳，累積到 `_end`、`finish_reason:'stop'`，或達上限（輪數 400、筆數 100000、20 分鐘、使用者停止）；
- 依 `id` 去重（續傳時模型重複前面幾筆）；連續兩輪沒有新增就停（`stalled`）；壞行保留成 `{"_bad_line":n,"error":…,"raw":…}`，不丟、不讓整份失敗；
- 暫時性失敗（429、5xx、逾時）每輪重試 3 次；一直失敗就停在 `error`，已收到的保留，`complete:false` 並附最後一個真實錯誤；每輪 4096 token，遇 HTTP 400 退回 2048；單輪逾時 180 秒；
- 結果放進暫存（`_bigStashRecords`），tool result 就是第 1 頁（`head` 帶 `complete`、`stop_reason`、`rounds`、`bad_lines`、`duplicates_dropped`、`last_error`、沒讀完時的 `note`），AI 用 `big_content page` 一頁頁讀完，帳本追蹤覆蓋範圍。

`complete` 只有模型真的說完才是 `true`；達上限或出錯都是 `false`，並要求 AI 如實告訴使用者「只拿到部分」。

## 五、測試

| 測試 | 內容 |
|---|---|
| `renderer/src/agent/jsonl_pager.test.js`（16） | 陣列／物件含大陣列／巢狀／非記錄清單回 null／JSONL 壞行／單筆過大分段逐字相等／窗口 2048 到 1000000／cursor 竄改與別的來源／重複讀／8000 個物件逐頁讀完相等 |
| `renderer/src/agent/jsonl_stream.test.js`（12） | 8000 個物件每輪截斷自動接著寫、截斷剛好在行尾、壞行、程式碼區塊與行尾逗號、重複前幾筆去重、429 重試、一直失敗不報完成、沒寫 `_end`、一直重複就停、輪數／筆數／使用者停止、半行剛好是合法物件 |
| `renderer/src/agent/read_ledger.test.js`（20） | 原有 12 個全過＋覆蓋範圍：逐頁讀完、跳到最後一頁缺口仍在、反向／亂序／重複、不同工具同來源、兩個來源互不影響、單筆分段、提醒附 cursor、失敗結果不改帳本 |
| `scripts/jsonl-paging.test.js`（12） | 用真的函式原始碼：8000 個物件總截斷後逐頁讀完相等、窗口越小頁越多、非記錄清單退回舊截斷、JSONL 文字、cursor 錯誤、單筆過大、VLM 拆解 8000 個物件、中途一直失敗、`finishReason`、帳本閘門 |
| `scripts/eval/jsonl-paging.eval.js`（真 Electron＋假 LLM） | 4000 個物件的大回應：順從的模型 3 頁讀完不加警語；偷懶的模型被擋、提醒後讀完放行；固執的模型被提醒 5 次後，答案前面有程式附的警語（「只讀了 1740／4000 筆，沒讀到第 1741～4000 筆」）；跳到最後一頁被擋、依提醒裡的 cursor 補讀 |

執行：`node scripts/eval/run_eval.js scripts/eval/jsonl-paging.eval.js 17951`（換埠，不搶使用者的 17923）。

## 六、還沒做（待改善，仍在 DESIGN.TODO.md）

- ~~檢視器 `.jsonl`／`.ndjson`／`.jsonc` 與離線「打開」種類表~~：**2026-11-05 已做**（見下）。
- ~~一次問答最多讀幾頁的預估、離線小模型（4096 token）的 `fraction` 調校、`knowledge_ask`／`repo_*` 帶 `_page` 與 `offset`~~：**2026-11-06 已做**（第十節）。
- 用真的線上視覺模型量一次實際回多少物件、斷在第幾輪（需要使用者的金鑰與一張複雜的圖，列真人驗證）。

## 七、各種大回應的覆蓋現況（2026-11-05 稽核）

所有工具結果最後都經 `_formatToolResult`，超過預算就進 `_truncateToolResultForContext`；所以下面每一種都有「讀得完」的路：

| 回應形狀 | 處理 | 帳本 |
|---|---|---|
| 記錄清單（頂層陣列、含占大宗陣列的物件、JSONL 文字） | 第 1 頁 JSONL＋`big_content page` | 覆蓋區間，缺口由程式算 |
| id→物件對照表、很多欄位的大物件（`entries`，一個欄位一行 `{key,value}`；單一欄位太大自動分段） | 同上 | 同上 |
| 大文字（終端機輸出、網頁、記錄檔） | 開頭＋概要＋暫存，`big_content read`（有 `has_more`）、`grep`、`json`、`js` | `has_more` 型：`read` 到最後一段才放行；`grep`／`json`／`js` 視為有目的的取用 |
| 自己有分頁的工具（`parse_uploaded_file`、`fetch_web_page`、`browser_get_page_text`、`article_section`、`repo_*`、`coding_read_file`、`knowledge_detail`） | 原本的 `has_more`＋`next_offset`／`next_start_line`／`next_line` | 原本的「下一個位置」型 |
| `interpret_image`（一般描述） | 單次最多 2048 token；輸出被截斷時答案尾端附警語（原本完全不知道） | — |
| `interpret_image`（拆解、列出所有物件） | `output:'jsonl'`＋自動續傳（第四節） | 覆蓋區間 |
| `knowledge_ask`（只有 `limit`，沒有 `offset`） | 命中很多、超過預算時走總截斷的 `hits` 陣列分頁 | 覆蓋區間 |

仍然只有「下一個位置」而沒有覆蓋範圍的是第四列那些自帶分頁的文字工具（跳頁讀仍會清掉缺口）；這些是文字不是記錄，要補得改各工具回應加 `_page`，列待改善。

## 八、檢視器支援 JSONL／NDJSON／JSONC（2026-11-05 已實作）

使用者原話：「json的檢視器，要支援階層view, source view, 以及table view (轉table,類似excel)，也要支援jsonl, jsonc格式。要可以匯出json, xlsx, sqlite3」。

- `dataview/data_core.js`：新格式 `jsonl`（`ndjson` 同義）、`jsonc`。`detectFormat` 自動判斷（前兩行都是單行物件→jsonl；嚴格 JSON 失敗但去掉註解／尾逗號後成功→jsonc）。`stripJsonc` 保留換行位置、字串內的 `//`、`/*` 不算註解；`parseJsonl` 壞行不讓整份失敗，保留成 `{_bad_line,error,raw}` 並回 `badLines`；`.json` 嚴格解析失敗而 JSONC 成功時回 `asJsonc`（不悄悄重試，畫面加提示）；`countComments`；BOM 處理；jsonc 上色含跨行區塊註解。
- `dataview/data_ui.js`：標題 JSONL／JSONC；頂端提示（含 N 則註解、共 N 行 M 行壞行、以 JSONC 解析）；Export 加「JSONL（一行一筆）」，JSONL 來源匯出**原始行**不重新序列化。Source／階層 Viewer／表格（JSONL 的物件陣列直接成一張表）／匯出 JSON、XLSX、SQLite3 沿用既有流程。
- `floating-assistant.js`：對話區塊 `jsonl`、`ndjson`、`jsonc` 開檢視器；`/view` 開 `.jsonl`、`.ndjson`、`.jsonc`；離線種類表 `exts`／`nouns` 同步。
- 測試：`data_core.test.js` 56 項全過（新增 jsonc／jsonl／壞行／上色／fallback）；`dataquery_core` 31、`jsonl-paging` 13 全過。

**2026-11-06 補**：JSONL 超大檔的批次視窗與真瀏覽器實測見第十節；Electron 內嵌的對話區塊沒有另外實測（同一份 `data_ui.js`，在真瀏覽器頁面載入實測）。

## 九、讓任意窗口的模型都讀得完／做得完：多層 JSONL、攤平與還原（2026-11-05）

使用者原話：「讀取網頁內文，讀取網頁我也建議用paginator或複合結構，因為內文可能超長，要有使用參照文件跟jsonl的方式」「當處理參照文件，就可以是一般文件的paginator，結構則是用多層jsonl的方式設計」「要可以把原本超深的結構攤平成jsonl」「我覺得程式結構ast node也請參考這方式」「因為不完整的節點會有錯誤的解讀」「uml design與midi音樂設計也是」「我希望可以藉由這個形式來讓任意窗口的模型都能達成」「我們也可以對於uml-design的遞迴深入，保有原有的結構，但是提供一個flatten-jsonl converter，這個convert出來的結構可以正確對應回去」。

### 已實作

| 項目 | 做法 | 位置 |
|---|---|---|
| 長網頁三層 | 第 0 層章節索引（一章一行，`parent`、`blocks`、`doc:{offset,chars}`、`blocks_cursor`）→ 第 1 層區塊記錄（`t`＝h／p／li／table／code／quote，`sec`、`links`）→ 第 2 層參照文件（原文 Markdown 存 `file_id`，用一般分頁 `parse_uploaded_file`／`article_section` 的 offset 讀）。`fetch_web_page` 內文超過一頁預算就回第 0 層第 1 頁（`output:'text'` 可關） | `renderer/src/agent/web_blocks.js`、`_webPageLayers` |
| 超深結構攤平 | `flatten`：一個節點一行 `{path(JSON Pointer),depth,type,value｜keys｜length}`；`unflatten` 逐字還原（含鍵順序、`~`／`/` 跳脫）；`toRecords` 在「沒有占大宗陣列、深度 ≥ 5」時自動用（shape `flat`） | `jsonl_pager.js` |
| 收合與往下鑽 | `flatten(v,{maxDepth})` 更深的容器收成 `{collapsed:true,size}`（先看全貌）；`expand(v,path,{levels})` 再展開一層，行的 path 是完整路徑，接在先前的行後面一起 `unflattenInfo`，沒展開的列在 `collapsedPaths` | 同上 |
| 程式結構（AST） | `flattenAst`：一個節點一行 `{id,parent,field,index,type,path(類型鏈),depth,props,children,size}`，先序，位置資訊留在 `props`；`toRecords` 對有 `type`／`kind` 的巢狀樹自動使用（shape `ast`） | 同上 |
| 不完整節點 | 分頁切在樹中間時，頁面 meta 附 `incomplete:[{id,type,missing:[a,b]}]`＋`incomplete_note`（子節點還在後面的頁，先不要下結論），後面的頁附 `starts_inside`（每個節點有 `path` 類型鏈與 `parent`） | `page()` |
| UML design | 模型結構完全不改；新增 `FaDesign.modelToJsonl(model,{levels})`／`modelExpand(model,path)`／`modelFromJsonl(lines)`，還原後的模型與原本逐字相等，驗證結果相同，`collapsedPaths` 為空才算讀完 | `renderer/src/uml/design_core.js` |
| 缺陷修正 | `undefined`／函式欄位不輸出（跟 `JSON.stringify` 一致），否則 UML 模型的 `default` 欄位還原後多出 `null` | `flatten` |

### 第二批（同日）：工具接線、MIDI、瀏覽器頁面文字

| 項目 | 做法 | 位置 |
|---|---|---|
| UML／任何深層 JSON 往下鑽 | `big_content` 新增 `tree`（`levels` 層，預設 2；更深的收成 `collapsed` 一行）與 `expand`（`path`＋`levels`，預設 1）；結果是新的暫存，用 `page` 讀，每行 path 是完整 JSON Pointer，各次的行可接在一起還原。`uml_design` 結果太大被暫存時，模型用這兩個動作先看全貌再往下鑽 | `floating-assistant.js` `big_content` |
| MIDI 多層 JSONL | `FaMidi.toJsonl(song,{levels})`：第 0 層 `song`／`track` 行、第 1 層每軌每小節一行（音域與音符數）、第 2 層一個音符一行（`t,d,n,v` 是原值，`bar,beat,name` 是推導）；`expandNotes(song,track,bar)` 只取某軌／某小節；`fromJsonl` 還原並回報 `missing`（宣告的音符數比拿到的多的軌）。工具 `midi_song_jsonl`：`read` 回第一頁、`write` 把 JSONL 還原成曲子並開編輯器，小窗口模型可以一軌一軌寫 | `renderer/src/music/midi_core.js` |
| 瀏覽器頁面文字 | `browser_get_page_text` 沒指定 offset、頁面文字超過一頁預算（或 `output:'jsonl'`）時，讀完整頁（上限 300 萬字元）回章節索引；沒有標題的純文字依一頁預算 80% 切成「第 n 段」，`doc.offset／doc.chars` 對應頁面文字的偏移，原文再用 `browser_get_page_text` 的 offset 讀（頁面沒變動時才對得上）；`output:'text'` 維持舊行為 | `_bcPlan` 的 `bcTool`、`web_blocks.js`（`starts`、`chunkChars`） |

| UML write 方向 | `uml_edit` 新增 `model_jsonl_read`（`levels`、`path` 往下鑽）與 `model_jsonl`（整份模型的 JSONL 行，必須全部展開；還有 `collapsed` 沒展開就退回並列出路徑；還原後取代模型並重建專案） | `_umlEdit` |

**實機驗證（真 Electron，`scripts/eval/layers-jsonl.eval.js`，2026-11-05）**：`big_content tree／expand` 收合後逐一展開還原相等；`midi_song_jsonl` 讀第 0 層、某軌某小節、`write` 還原；網頁三層索引 31 章、每章有 `blocks_cursor`；`uml_edit` 讀全貌／往下鑽／整份換回（逐字相等、changes 0）／沒展開完被退回。`jsonl-paging.eval.js` 四種模型情境照舊通過。

### 還沒做（待改善）

- ~~`browser_get_page_text` 的新分支沒有用真的 Chrome 擴充功能實測~~：**2026-11-06 用真 Chrome 156 實測並修了一個真 bug**（第十節）。擴充功能連線本身（配對、`chrome.scripting`）還是沒有端對端跑過。
- `midi_song_jsonl read` 的 `song` 參數用的是 midi 工具既有的拍為單位格式，只有 `song_id`／`file_id` 走 tick 格式；要讀已存的曲子請給 `song_id`。
- ~~MIDI 的 `compose_tree` 作曲樹沒動~~：**2026-11-06 已做**（第十節 `midi_compose_tree`）。

## 十、第三批（2026-11-06）：小窗口、頁數預估、真瀏覽器實測

使用者原話（2026-11-06）：「JSONL 分頁的舊待改善：`knowledge_ask`／`repo_*` 帶 `_page`、頁數預估接 `fitToBudget`、離線小模型（4096）調校、超大檔行索引」「`browser_get_page_text` 長頁面章節索引，用真的 Chrome 擴充功能實測」「MIDI `compose_tree` 攤平，以及 UML／MIDI 的『小窗口分段寫』」。

| 項目 | 做法 | 位置 |
|---|---|---|
| 頁數預估 | 頁面 meta 多一個 `pages_left`（照這頁讀到的筆數估後面還有幾頁）；帳本每個來源記讀過幾頁，`estimate()` 算「約還要幾頁」，提醒文字帶上；代理迴圈提醒時傳入「上下文還剩幾 token、一頁約幾 token」，放不下就明說「別一頁頁全讀，先用 `big_content` 的 grep／json，或把已讀的重點寫成一小段摘要」（舊頁本來就會被 `fitMessages` 換成 placeholder，所以摘要是模型自己留的）。注意：`fitToBudget` 在這個 repo 裡叫 `fitMessages`（`vlm_core.js`） | `jsonl_pager.js`、`read_ledger.js`、`vlm_core.js` |
| 小窗口調校（4096） | 以前一頁預算用「3 字元＝1 token」估，中文 JSON 大約 1 字 1 token，會低估 3 倍：實測 4096 窗口一頁吃掉 21%（目標 13.5%）。現在 `page()` 可給 `maxTokens`＋`tokensOf`（宿主的 token 估計），整頁、單筆分段、head 判斷都用 token 算；沒給就照舊用字元。FA 的 `_pagerBudgetOpts()` 知道窗口大小就走 token。真 Electron：4096／8192／32768 窗口的一頁分別是預算的 95%、94%、97%，`pages_left` 分別 18、8、1 | `jsonl_pager.js`、`floating-assistant.js` |
| `knowledge_ask` | 新增 `offset`（往後翻排名），回傳帶 `_page`（`blocking:false`、`next_offset`）。排名搜尋的翻頁是選擇性的，所以帳本看到 `blocking:false` 不記、不逼模型翻完 | `knowledge_host.js`、`read_ledger.js` |
| `repo_*` | `repo_map` 的清單（`find`／`explore`／`tree`…）本來就有 `offset`／`next_offset`，現在經 `_repoApplyBudget` 也帶 `_page`（`unit:record`，缺口提示用 `offset：N` 而不是 cursor）；`repo_ask` 的 `search` 新增 `offset`＋`_page`（`blocking:false`）。`repo_read_doc`（字元 offset 的文字）、`repo_sql`、`repo_wiki` 沒動 | `floating-assistant.js`、`read_ledger.js` |
| 超大 JSONL 檢視 | `FaDataCore.parseJsonlWindow(lines,from,size)`：只解析一批（預設 2 萬筆，行號是整份的行號、壞行保留）。超過 5 萬行的 JSONL，Viewer／表格一次只載入一批，工具列出現 ◂ 上一批／下一批 ▸（有堆疊，可退回）；Source 本來就是虛擬捲動，另外把「最長行」改成只算一次（以前每次捲動都掃全部行）；匯出 JSON／CSV／XLSX／SQLite 才解析整份，JSONL 匯出用原始行 | `data_core.js`、`data_ui.js` |
| 網頁文字 | `WebBlocks.readAll(call,args,{chunk})`：一段段向擴充功能要、接成全文；欄位 `total_chars` 與 `total_length` 都認 | `web_blocks.js` |
| 作曲樹 JSONL | `FaComposeTree.toJsonl(tree,{ask,pendingOnly})`：第 0 層 `tree` 行（規格、`pending` 節點清單）＋一個節點一行（`id,parent,depth,label,value,source,tries,decided`；沒決定的可帶 `ask`＝單獨就答得出來的一題）；`fromJsonl` 還原（規格與每個節點逐項相同，組出的曲子也相同；壞值列在 `problems`，缺的補範本）；`setNode(tree,id,value,'ai')` 標 ai。工具 `midi_compose_tree`：`start`／`read`／`set`／`assemble`，一次寫一個節點，程式馬上核對（不合格退回並附該節點的題目），任何時候 `assemble` 都做得出曲子（沒決定的用範本） | `compose_tree.js`、`floating-assistant.js` |
| UML 小窗口分段寫 | `FaUmlEdit.nextUnit(model)`：程式從目前模型決定「下一格」（參與者與使用案例 → 類別 → 每個空類別的成員 → 每個太短的使用案例 → 沒接上的類別），附焦點標頭（目標、已定的、這格做什麼）、兄弟已用的命名風格、答法範例；`uml_edit({next:true})` 只回這一格，`uml_edit({ops,queue:true})` 套完自動附下一格，直到 `done`。從空白照範例答，4 格就做出驗證通過的模型 | `uml_edit_core.js`、`floating-assistant.js` |

### 用真 Chrome 實測抓到的 bug

`browser_get_page_text` 的長頁面分支原本判斷 `first.total_chars > 預算`，但真的擴充功能（`browser-control-extension/background.js` 的 `pageTextExtractor`）回的是 **`total_length`**，沒有 `total_chars`。所以長頁面**永遠不會走分層**，只有明確給 `output:'jsonl'` 才會。純函式測試與假擴充功能都測不出來（假資料是照我自己的猜測寫的）。
- 做法：用 Playwright＋系統 Chrome 156 載入長頁面，執行擴充功能原始碼裡真的 `pageTextExtractor`，把輸出存成 `renderer/src/agent/fixtures/chrome_page_text.json`；測試回放它（`web_blocks.test.js` 27 項）。
- 沒有做的：擴充功能的連線層（配對碼、`chrome.scripting.executeScript` 注入）沒有端對端跑過；擴充功能的 `get_page_text` 不回 `title`／`url`，所以分層索引的標題目前是空的（要補得另外呼叫取分頁資訊）。擴充功能原始碼不在這個 repo（在網頁版專案），所以改它不在這次範圍。

### 真 Electron 實測

`scripts/eval/small-window.eval.js`：`midi_compose_tree` 從 start 到 assemble（錯的和弦被擋並附題目、10 個節點逐個寫完、組出曲子沒警告）；`uml_edit` 從空白 4 格做完；4096／8192／32768 窗口的頁預算與 `pages_left`；`knowledge_ask` 的 `offset`／`_page`。`jsonl-paging.eval.js`、`layers-jsonl.eval.js` 重跑通過（沒有退步）。

### 一個陷阱

`scripts/embed-code-ui.js` 會把 `renderer/src/` 下各模組整份蓋回 `floating-assistant.js` 的嵌入區塊——**直接在 `floating-assistant.js` 裡改嵌入區塊的程式，下次嵌入就會被蓋掉**（這次 `knowledge_ask` 與代理迴圈提醒各被蓋掉一次，是真 Electron 評估發現的）。改之前先 `grep -rl` 看這段程式的來源檔（`knowledge_host.js`、`vlm_core.js`…）。

### 還沒做

- 真 Chrome 擴充功能的端對端（連線層）；擴充功能回 `title`／`url`。
- `repo_read_doc`／`repo_sql` 的 `_page`；`repo_ask` 的 `ask` 動作（非清單）沒有翻頁。
- 4096 窗口的 `fraction`（15%／自動代理 25%）沒有再調，只是改成不低估；沒有用真的 4096 小模型跑完整問答量「一次問答讀幾頁」。
- JSONL 檢視器在 Electron 對話區塊裡的實際畫面（這次是在真瀏覽器頁面載入同一份 `data_ui.js` 實測：15 萬行、批次前後翻、Source 捲到 14 萬行、匯出整份 JSON 17 MB）。
