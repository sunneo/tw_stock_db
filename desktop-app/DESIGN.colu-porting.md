# CoLU 移植包：要讓另一個 AI（例如 Redmine AI）有同樣的設計，該準備什麼

> 對象：想把這個助理 2026-10-15 到 2026-10-18 做出來的「弱模型思考外殼」搬到另一個 AI 專案（以 Redmine AI 為例）的人，或接手的 AI。
> 先講結論：**設計文件已經有了（見第一節）；原始碼也大部分是獨立的純函式模組**，可以直接複製。要補的是宿主介面（模型怎麼呼叫、工具怎麼登記、怎麼問使用者）與詞彙。
> 通用的移植規則另見 [DESIGN.porting-guide.md](DESIGN.porting-guide.md)；這份只管這一批。

---

## 一、已經有的設計文件（照這個順序給對方讀）

| 順序 | 文件 | 內容 | 給對方的理由 |
|---|---|---|---|
| 1 | [DESIGN.colu.md](DESIGN.colu.md) | CoLU 總覽：目標、六條原則、全貌流程、元件表、模型體檢、決策紀錄 | 先懂「為什麼這樣設計」 |
| 2 | [DESIGN.unit-catalog.md](DESIGN.unit-catalog.md) 第二、十一、二十、二十八～三十九節 | 單元與型別、接線矩陣、執行格式、分歧才問、反思、達成路線、瀏覽器計畫 | 核心機制的細節與實測 |
| 3 | [DESIGN.uml-framework.md](DESIGN.uml-framework.md) | UML 拆解（一次一小題）、設計抉擇、編修、LLVM→wasm、終端機工具 | 「用 UML 補弱模型推理」的做法 |
| 4 | [DESIGN.reflection.md](DESIGN.reflection.md)、[DESIGN.tool-reflection.md](DESIGN.tool-reflection.md) | 探索時的反思、工具呼叫的反思與別名 | 弱模型不會自己想到的事，由程式在對的時間點觸發 |
| 5 | [DESIGN.data-viewers.md](DESIGN.data-viewers.md) 第八節 | 資料的離線精準查詢 | 口語問題 → 穩定的查詢 |
| 6 | 本文 | 搬什麼、補什麼、怎麼驗收 | |

## 二、這批設計共同的「形狀」（對方要照這個形狀寫新模組）

每個模組都是同一套做法，之後會抽成「弱模型的思考外殼」（現在先不抽，等穩定）：

1. **資料先結構化**：把世界變成程式讀得懂的結構（單元與型別、UML 模型、表格與欄位、動作表、IR 模組）。
2. **程式把選項縮成封閉小題**：選單用「字母」，一次 2～4 個選項（決策表縮小；11 個選項小模型選不出來，實測過）。
3. **模型只挑字母或填格式固定的空**，用 `jsonStep`（驗證、退回重來、最多重試）。
4. **程式檢查放行**：型別、狀態、值是否存在、名稱是否合法；不合格就退回並說明原因。
5. **選不出來就用程式的預設**（選項本來都是合法的）；決定記進「我做了什麼假設」。
6. **執行並驗證**；失敗就重新觀察、重新計畫（有次數上限）；暫時性錯誤自動重試一次。
7. **有副作用的步驟一律先問使用者**（不論手動或自動模式）。
8. **全部可以用假模型測試**（模型是注入的函式），所以搬過去不需要真的模型就能驗收。

## 三、可以直接複製的程式（純函式、UMD，沒有 DOM）

路徑都在 `renderer/src/` 底下。**每個 `.js` 旁邊都有 `.test.js`，用 `node 檔名.test.js` 直接跑**（Node 16 以上），括號是目前的通過數。

### A. 地基（一定要帶）

| 檔案 | 行數 | 相依 | 做什麼 |
|---|---:|---|---|
| `recipe/recipe_core.js`（72） | 288 | 無 | `jsonStep`（強制 JSON、驗證、退回重來）、`chooseTool`、決策記錄；**所有模組的模型介面都走它** |
| `recipe/plan_core.js`（57） | 301 | recipe | 計畫步驟與驗證 |

### B. CoLU 本體（工具／API → 單元 → 接線）

| 檔案 | 行數 | 相依 | 做什麼 |
|---|---:|---|---|
| `catalog/catalog_core.js`（82） | 240 | 無 | 單元描述、型別語法與驗證 |
| `catalog/matrix_core.js`（53） | 114 | catalog | 位元壓縮的型別接線矩陣 |
| `catalog/relu_core.js`（20） | 101 | catalog, matrix | ReLU 形式（可選，概念一致用） |
| `catalog/select_core.js`（54） | 107 | 無 | 詞比對檢索（中英） |
| `catalog/embed_core.js`（24） | 45 | 無 | 嵌入重排介面（模型選配） |
| `catalog/ir_core.js`（56） | 149 | catalog | 可檢查、可執行的呼叫程式與直譯器 |
| `catalog/bind_core.js`（38） | 174 | catalog, matrix, select, ir, embed | 需求（UML 使用案例）→ 單元接線，0 次模型呼叫 |
| `catalog/feedback_core.js`（22）、`rank_train.js`（11） | 69、43 | 無 | 採用／退回回饋累積、排名模型訓練 |

### C. 探索、反思、分歧

| 檔案 | 行數 | 相依 | 做什麼 |
|---|---:|---|---|
| `catalog/card_core.js`（33）、`discover_core.js`（50） | 158、192 | card, select | 缺口 → 搜尋 → README 卡片 → 排名 → 計畫（搜尋來源由宿主注入） |
| `catalog/reflect_core.js`（40） | 120 | 無 | 打錯字、可能是新需求 |
| `catalog/branch_core.js`（40） | 98 | 無 | 分歧才問、不要再問 |
| `tools/cap_reflect.js`（45） | 95 | 無 | **工具呼叫的反思**：偵測「我沒有某某工具」、搜尋全部工具、別名 |
| `tools/tts_intent.js`（48）、`tools/translate_core.js`（87） | 45、139 | 無 | 「動作明確的需求由程式直接做」的兩個範例（語音、翻譯） |
| `catalog/route_core.js`（41） | 151 | recipe | **達成路線**：缺口分類、依環境選程式語言、外部動作三條路、手動／自動閘門 |
| `catalog/colu_bench_core.js`（42）、`uml/uml_bench_core.js`（37） | 136、141 | catalog, matrix / uml | 模型體檢（接線題、UML 拆解題、大問題） |

### D. UML 設計與工具

| 檔案 | 行數 | 相依 | 做什麼 |
|---|---:|---|---|
| `uml/uml_core.js`（76） | 524 | recipe | UML 模型、DSL、一次一小題的拆解、切塊與合併（大問題） |
| `uml/design_core.js`（54） | 574 | recipe, uml, glue | 設計抉擇、framework、rework |
| `uml/glue_core.js` | 623 | uml | 骨架之後接到真正的 library |
| `uml/uml_edit_core.js`（48） | 245 | recipe, uml, design | 反思的結論 → 補或刪 UML 的編修 |
| `uml/llvm_core.js`（103） | 607 | uml | UML → LLVM IR → wasm；IR 解析／檢查／連結器／執行（不需要 clang） |
| `browser/bcplan_core.js`（70） | 272 | recipe, uml | 瀏覽器控制的穩定生成（先計畫、檢查、才執行） |
| `dataview/dataquery_core.js`（31） | 442 | recipe | 資料的離線精準查詢（JSON／表格 → 計畫 → 執行 → SQL） |

**不要帶的**：`data_ui.js`（DOM 畫面）、`floating-assistant.js`（宿主，5 萬行，只當參考）、`main-ext.js`／`browser-control-server.js`（Electron 專用）、`vendor-models` 分支（翻譯模型，需要的話另外評估）。

## 四、宿主要提供的介面（對方的專案要寫的膠水）

1. **`generate({ messages, maxTokens, prefill })` → 文字**：呼叫它的模型。要支援 `prefill`（把回答的開頭先塞進去，例如 `{"choice":`）更好；不支援的話把 prefill 當成提示的一部分。模型換了、離線或線上都不影響核心。
2. **工具登記與呼叫**：把它的工具（Redmine 的 REST API 操作）描述成單元（名稱、參數型別、回傳型別、副作用）。參考 `catalog_core.js` 的單元格式與 `floating-assistant.js` 裡 `_unitCatalogBuild`。
3. **問使用者**：`askBranchChoice`（選項卡片＋可打字補充＋「照推薦的做」）與 `requestUserForm`（同意／不要）。核心只需要「問一個封閉題、拿回答案」。
4. **儲存**：別名檔、回饋、體檢結果、物件檔。核心不碰儲存，宿主決定放哪。
5. **搜尋來源**（選配）：缺口探索要搜尋 GitHub 之類；Redmine AI 可以換成搜尋自己的 wiki、議題、文件。

宿主裡對應的實作（找得到就能照抄）：`_unitCatalogDiscover`、`_unitCatalogReflect`、`_unitCatalogAskBranches`、`askBranchChoice`、`_umlModel`（挑模型）、`_umlDesign`、`_umlEdit`、`_routePlan`、`_bcPlanRun`、`_dataViewAsk`、`_noToolClaimNudge`（工具反思的觸發點）、`_runTtsIntent`、`_umlToWasm`、`_llvmExecute`。

## 五、Redmine AI 的對應（建議，我沒有看過它的原始碼）

| 這裡的 | 在 Redmine 的對應 |
|---|---|
| 單元 | Redmine REST API 的操作：列專案、列議題（可篩選）、建立／更新／刪除議題、時間記錄、wiki、版本、使用者 |
| 型別接線 | `project_id`、`issue_id`、`user_id`、`status_id`、`tracker_id`、`version_id`、日期…；「列專案」的輸出 `project_id` 接得上「列議題」的輸入 → **模型不用記 id 怎麼來的** |
| 副作用 | 建立、更新、刪除、指派、關閉議題＝有副作用，**一律先問**；查詢類不用問 |
| 資料查詢（`dataquery_core`） | 議題清單天生是「陣列裡的物件，裡面又有陣列」（journals、attachments、custom_fields）→ 正好是它的強項：口語問題 → 計畫 → 在已抓回來的資料上執行，不必每次重打 API |
| 工具反思 | 模型說「我不能查工時」→ 程式搜尋全部工具，找到 time_entries 就退回請它用；別名放「使用者怎麼稱呼」（「報工」「登時數」） |
| 達成路線 | 找不到工具時：能用 API 組出來就組；不行就給範本，**不假裝做到** |
| 瀏覽器控制 | 可能用不到 |
| LLVM／wasm | 通常用不到；除非要在沙盒裡跑小程式 |

**詞彙要換**：`dataquery_core.js` 的 `GLOSSARY`（中文→英文欄位字）、`route_core.js` 與 `cap_reflect.js` 的關鍵字表、`reflect_core.js` 的詞庫目前是中文為主、混 SPDX 與一般表格用語；Redmine 的欄位（subject、assigned_to、fixed_version、estimated_hours…）要補進去。

## 六、搬的順序（每一步都能獨立驗收）

1. 複製 A（recipe）→ 跑測試 → 接上自己的 `generate`，用 `jsonStep` 做一個小題（選字母）驗證模型介面。
2. 複製 B（catalog、matrix、ir、bind）→ 把 Redmine API 描述成單元 → 接線測試（0 次模型呼叫）。
3. 複製 `branch_core`、`reflect_core`、`cap_reflect` → 接上「問使用者」與「模型說沒有工具」的觸發點。
4. 複製 `route_core` → 接上手動／自動模式與副作用確認。
5. 複製 `dataquery_core` → 把議題清單丟進去，用自己的 20 題驗收（照 `dataquery_core.test.js` 的題庫格式出題，**不要只用調過的題目**，要有沒調過的）。
6. 需要時再帶 UML 與 `uml_edit`、`llvm`。
7. 用 `colu_bench_core`／`uml_bench_core` 對它的模型做體檢，決定哪些模型要走哪一層輔助。

## 七、驗收清單

- [ ] 每個搬過去的模組，原本的 `.test.js` 在新環境全過（通過數與第三節括號一致）。
- [ ] 模型介面：關掉真模型、用假模型也能跑完整流程（`generate` 回固定字串）。
- [ ] 弱模型實測：用它最小的模型跑「接線題」與一組自己的題目，**記下失敗的種類**（格式錯、選錯、空白、逾時）；選不出來時要退回程式預設，不能卡住。
- [ ] 副作用：建立／更新／刪除在自動模式也會先問；使用者說「不要」就一步都不做。
- [ ] 沒有把使用者沒同意的事當成同意（打字補充不算同意）。
- [ ] 失敗訊息帶具體原因（HTTP 狀態、逾時、哪個欄位不存在），不要只有「失敗」。

## 八、已知的坑（先講清楚）

1. **關鍵字表偏中文**：英文專案要補英文說法；詞彙不換，選單縮小與意圖偵測會偏掉。
2. **小模型的能力有限**：實測 0.6B 模型選字母在小選單（2～3 個）可以，11 個選項選不出來；所以決策表（`suggest`）是程式的知識，搬的時候不要拿掉。
3. **沒有用真的 LLVM 驗證 `.ll`**：只在自己的檢查器與 WebAssembly 上驗證過。
4. **題庫容易高估**：自己寫的題庫（42 題全對）比沒調過的 20 題（約 16～17 題對）高；驗收一定要加沒調過的。
5. **單元抽取只做過 Python 與 JavaScript**；REST API 要自己寫一份「OpenAPI → 單元」的轉換（`catalog_core.js` 的單元格式很簡單，這步不難，但是新工）。
6. 宿主是 Electron／瀏覽器環境：`lli`／終端機相關的指令用到宿主的同步 builtin 機制，Redmine AI 沒有就不要帶。

## 九、可以直接貼給對方 AI 的提示

> 你要把「CoLU 弱模型思考外殼」搬進這個專案。先讀 `DESIGN.colu-porting.md`，再依第六節的順序做。規則：(1) 核心模組（`renderer/src/` 底下的 `*_core.js`、`tts_intent.js`、`cap_reflect.js`）原樣複製，不要改寫；要改只改詞彙與宿主膠水。(2) 模型一律透過注入的 `generate` 與 `jsonStep`；不要在核心裡直接呼叫任何模型。(3) 每搬一個模組就跑它的 `.test.js`，通過數要跟文件一致。(4) 選單用字母、一次最多 4 個選項、選不出來用程式預設。(5) 有副作用的 API（建立、更新、刪除）永遠先問使用者。(6) 先回報你看到的宿主介面（模型怎麼呼叫、工具怎麼登記、怎麼問使用者、資料存哪），再開始寫膠水。

## 十、對方要先回答的問題（我才知道膠水怎麼寫）

1. Redmine AI 用什麼語言與執行環境？（Ruby 外掛、獨立的 Node／Python 服務、還是瀏覽器端？）核心是 JavaScript，非 JS 環境要嘛包一層 Node，要嘛移植。
2. 它怎麼呼叫模型？（雲端 API、本機模型？支援 JSON 模式或 prefill 嗎？）
3. 它的工具怎麼登記？（有沒有 function calling？還是自己解析文字？）
4. 怎麼問使用者？（聊天介面能不能放選項卡片？）
5. 資料存哪？（資料庫、檔案、Redmine 的自訂欄位？）
6. 是否離線？（決定要不要嵌入模型、要不要小模型體檢。）
