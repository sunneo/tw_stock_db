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

- 檢視器 `.jsonl`／`.ndjson`／`.jsonc` 與離線「打開」種類表。
- 一次問答最多讀幾頁的預估（要跟 `fitToBudget` 的 placeholder 銜接），離線小模型（4096 token）的 `fraction` 調校。
- `knowledge_ask`、`repo_*` 清單類工具帶 `_page` meta 與 `offset`（目前只有總截斷會轉 JSONL）。
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
