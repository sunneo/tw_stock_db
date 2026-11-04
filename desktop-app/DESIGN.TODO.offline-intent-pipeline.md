# 離線模式：先理解、再切步驟、逐步核對（設計草案，待使用者確認）

狀態：只有設計，沒有實作。2026-11-05 由管理層撰寫；下面「事實」都是讀程式得到，沒有實機重跑。

## 1. 使用者原話（2026-11-05）

- 「他連開都沒開!」
- 「我們的uml design切割跟CoLU，甚至NLP與意圖過濾都沒辦法幫助離線模型嗎」
- 「為什麼我感覺一個請求送出去  這些都沒有做」
- 「yes, 請這麼做」（同意寫這份設計）
- 觸發案例：「瀏覽器打開 https://tw.yahoo.com 並找美國選舉新聞」。第一種畫面：離線訓練器命中規則 `core_rules / browser_open_read`，信心 0.931，直接執行「開分頁、讀文字、關分頁」，列出頁面前 15 則標題。第二種畫面：走離線食譜的 `fetch_web_page`，只回 632 字預覽。兩種都沒有找「美國選舉」，也沒有讓使用者看到瀏覽器。
- 較早的原則（讀取帳本，2026-11-04）：工具回傳 `has_more: true` 就記下，讀完才回答；沒讀完不可下結論。

## 2. 現況（事實，來源 `renderer/src/floating-assistant.js`）

離線模式一輪對話的順序（`_otPlan` 之後，約 67785 行起）：

1. `_otPlan(text)`：規則比對（字面、語意範例、重排），得到 `planned`／`cache`／`needs_input`／其他。
2. `planned`／`cache`：**直接** `_otExecute`。規則命中就做，中間沒有任何理解步驟。
3. `needs_input`：交給食譜補欄位（`_recipeAnswer`，CoLU 形狀）。
4. 其他（沒規則）：先食譜，再離線文字模型。

已經存在、但沒有進入這條路的零件：

- `FaNlu.understand`、`FaIntent.derive`：把句子切成事件，產生 `intents[]`，每個有 `action`、`theme`、`target`、`neg`、`missing`、`confidence`、`plan`（可行性、路線、步驟）。目前只在乾跑（`_otDryRun`，約 67753 行）看得到。
- 讀取帳本：只接進了線上原生工具迴圈的最終回答閘門；離線訓練器的 `steps`／`tool` 執行沒有。
- UML 設計切割：離線訓練器只有「設計片段」問答資料（`doms.uml_design`），沒有用它切使用者的句子。

規則的結構限制：一條規則 = 一個動作，沒有「目標」欄位。`browser_open_read` 的 `expr` 只認「瀏覽器打開＋網址」，句子後半「並找美國選舉新聞」沒有落腳處。

## 3. 設計：理解閘、步驟、核對

原則：規則仍然快，但**規則命中不等於可以直接執行**；先過一道「這句話還有沒有規則沒吃到的部分」。

### 3.1 理解閘（規則命中後、執行前）

1. 用 `FaNlu.understand` 加 `FaIntent.derive` 取得 `intents`（純程式，不需要模型，毫秒級）。
2. 切成「動作」（規則處理的部分）與「目標」（剩下的部分，例如找某主題、比較、摘要、取其中某項）。
3. 判斷：
   - 沒有剩餘目標 → 照舊直接執行（例如單純「截圖 https://…」）。
   - 有剩餘目標 → 動作交給規則，目標轉成「後置步驟」，加進步驟列。
   - 理解不了（`confidence` 低或 `missing` 非空）→ 退回現行行為，並在卡片註明「只做了動作，沒處理：<剩餘文字>」，不要假裝做完。
4. 使用者說「打開／開啟／前往」→ 視為要看見頁面：前景開啟並保留分頁（`active`、`keep_open`）；只說「讀一下／抓內容」才用背景加關閉。（這是子工作階段 offline-browser-fix 正在修的 A 項，理解閘只負責把「看見」這個意圖標出來。）

### 3.2 後置步驟（目標怎麼做）

目標種類與離線的做法（都不需要線上 AI）：

| 目標 | 做法 | 沒做到時怎麼說 |
| --- | --- | --- |
| 找某主題（找美國選舉新聞） | 關鍵字加同義詞擴充，從已讀全文篩行，附上頁面上的連結（有 `get_page_structure` 時） | 「頁面上沒有找到跟 XX 有關的標題」，列出已讀範圍 |
| 摘要／重點 | 現有 TextRank 摘要（`_faSummarize`） | 註明是機械摘要 |
| 比較、判斷、推理 | 小模型（qwen3-0.6b）加 CoLU 思考，用字母選擇題核對 | 模型沒載入就明說做不到，不硬答 |
| 站內搜尋 | 偵測搜尋框，填字送出，再讀結果頁 | 找不到搜尋框就回報 |

### 3.3 逐步核對（讀完才回答）

每個步驟有程式可檢查的完成條件，沒過就不能進下一步或下結論：

- 讀取步驟：`has_more` 為真就續讀（上限頁數，預設 5），讀完才進篩選；到上限仍未讀完，結論一律加「只讀了前 N 字」。這是讀取帳本在離線路徑的版本，優先沿用同一套記錄結構。
- 篩選步驟：命中數為 0 要明說；不能拿不相關結果充數。
- 最後一步：核對題「這個結果有沒有回答使用者的目標？」程式先判（命中數、已讀比例），不確定才問小模型（字母 A／B／C）。
- 卡片顯示「做了這些步驟」：開了哪個網址、讀了幾頁、篩出幾則、哪裡沒做到。

### 3.4 規則學習

- 「動作＋目標」切開後，規則本身不需要為每個目標寫一條。
- 線上 AI 成功的做法，沿用現有「自動學起來」，但學的是切開後的形狀（動作規則加目標類型），不是整句。

## 4. 不做什麼

- 不新增網路通道、不裝套件、不要求使用者重裝（熱更新規則）。
- 不改規則的比對方式與信心門檻；理解閘只加在命中之後。
- 不用線上 AI（離線模式的前提）。

## 5. 分階段（每階段一個寫檔者、提交前跑測試）

1. **子工作階段 offline-browser-fix 的四點**（進行中）：前景開頁、關鍵字找、續讀、步驟顯示。這是 3.2 與 3.3 的最小版。
2. **理解閘**：新增純函式模組（建議 `renderer/src/offline/intent_gate.js`，UMD，嵌入清單與熱更新清單都要加），輸入句子與命中規則，輸出「動作、剩餘目標、處理建議」。附單元測試，案例至少 30 句（含使用者這句、截圖、純打開、純搜尋、複合句）。
3. **後置步驟接進 `_otExecute`**：找主題、摘要兩種先做；比較推理放階段 5。
4. **核對與卡片**：最後核對題、「只做了動作」註記、讀取帳本記錄。
5. **小模型推理（qwen3-0.6b＋CoLU）**：只有前面都穩定才做，需要先量測離線小模型在這類核對題的正確率。
6. 真桌面版評估：用獨立使用者資料夾、換埠（不可用 17923）、重現使用者的原句，檢查「有開瀏覽器、有找、有顯示步驟」。

## 6. 使用者決定（2026-11-05，原話）

1. （這是舊共識，不是新決定：使用者 2026-11-05 說「AI自己開的要自己關閉 這個要求很早很早在設計browser extension就決定了」，見 consensus/browser-control.json）「打開瀏覽器的都要開分頁，至於是否保留，我建議是AI自己開的要自己關閉」→ 說「打開」一律在前景開分頁；AI 自己開的分頁，做完（回合結束）由 AI 自己關閉，不留。注意：階段 1（提交 6dc08f17）目前是「保留分頁」，要改成「前景開、做完自己關」。
2. 「找不到就站內搜尋，他這時要看看這是不是一個搜尋引擎入口，有沒有辦法搜尋」→ 篩不到關鍵字時，先判斷頁面是不是搜尋入口或有搜尋框，有就填字送出再讀結果頁（同樣續讀到讀完）；沒有搜尋框就明說做不到。
3. 「擴充」→ 同義詞用現有詞庫自動擴充（不夠再加小表）。
4. 「他有thinking，真的thinking無法理解，才問，並且自動加入記憶」→ 理解不了時先用小模型思考（CoLU＋Thinking，qwen3-0.6b）；思考後仍無法理解才問使用者；使用者回答後自動加入記憶（離線訓練器的學習與使用者記憶，下次同類說法直接懂）。

## 7. 驗收的程式檢查（共識檔建議條款）

- 必須：命中規則後有呼叫理解閘；剩餘目標不為空時一定有後置步驟或「沒處理」註記；`has_more` 未讀完時結論含警語。
- 禁止：新增 HTTP 或網路通道；在離線路徑呼叫線上 AI；在 repo 根目錄產生 `package.json`／`node_modules`。

## 8. 追加決定（2026-11-05，使用者原話）

5. 「離線模型統一要走harness迴圈」→ 離線路徑（規則命中的步驟、食譜、離線文字模型、後置步驟、核對）一律走同一個 harness 迴圈：程式負責路由、欄位、核對與預設退路，模型每次只答一題封閉題（一個字母或固定欄位的 JSON）；不再有「規則命中就直接執行」與「模型自由生成」兩條互不相通的路。理解閘、後置步驟、最後核對都是這個迴圈裡的步驟，沿用 `skills/weak-model-harness` 的做法與 `renderer/src/recipe/recipe_core.js`。實作前先在本文件寫出對照表：現有各離線路徑（規則直接執行、`steps`、`tool`、`fsm`、食譜、離線文字模型）如何收進同一迴圈。

## 9. 實機重現紀錄（2026-11-05，管理層，真 Electron、替身瀏覽器工具）

- 原句「瀏覽器打開 https://tw.yahoo.com 並找美國選舉新聞」：載入的是工作目錄版本；呼叫 `browser_create_tab`（`active:true, keep_open:true`）與 `browser_get_page_text`，**沒有呼叫 `browser_close`**，與決定 1 相反；卡片「動作」行寫 →browser_close、步驟行寫「保留分頁」，自相矛盾。
- 關鍵字篩選在替身資料下篩出 3 則。真擴充功能、第二種畫面（`fetch_web_page` 只回 632 字）都沒重現。

## 10. 對照表：現有離線路徑如何收進同一個 harness 迴圈（階段 1.5，2026-11-05，子工作階段）

事實來源：`_offlineRespond`、`_otExecute`、`_otExecFsm`、`_recipeAnswer`、`_offlineLlmAnswer`（`renderer/src/floating-assistant.js`）；實機重現見第 9 節與提交 8170e75d（階段 0，已實測「打開→前景開→讀→自己關」）。以下「收法」是設計，**尚未實作、未實機驗證**。

### 10.1 統一迴圈的形狀（每一輪都走這 6 站，程式路由、模型只答封閉題）

1. 理解：`FaNlu.understand` ＋ `FaIntent.derive` ＋ 階段 2 的理解閘，輸出「動作、剩餘目標、處理建議」（純程式）。
2. 路由：規則比對（`_otPlan`）、食譜挑工具（`_recipeAnswer` 的選單題）、都是「程式先判、不確定才問字母題」。
3. 補欄位：程式從網址／附件／引號補，補不到才讓模型填固定欄位 JSON，仍缺才問使用者（決定 4：先 CoLU＋Thinking 思考，仍不懂才問，答案自動記入記憶）。
4. 執行：動作步驟＋後置步驟（找主題、站內搜尋、摘要），每步記進同一份「步驟記錄」（trail）；自己開的分頁在回合結束前一定關閉（決定 1）。
5. 逐步核對：讀取步驟 `has_more` 續讀；篩選命中 0 要明說；程式可檢查的條件沒過不進下一步。
6. 最後核對與卡片：「結果有沒有回答目標」程式先判，不確定才問字母題；卡片列步驟與沒做到的部分；`has_more` 未讀完加警語。

### 10.2 各現有路徑的收法

| 現有路徑（入口） | 現在的行為 | 收進迴圈的做法 | 風險／注意 |
| --- | --- | --- | --- |
| 規則 `answer`／`qa`（`kind:'answer'`） | 命中就回固定文字 | 站 1 理解閘照跑；無剩餘目標就原樣回答（打招呼等），有剩餘目標才進後置步驟 | 打招呼類不可被拖慢，閘必須是毫秒級純函式 |
| 規則 `cache`（`kind:'cache'`） | 直接重放已存的工具呼叫 | 站 4 的一個步驟；站 5 檢查回傳 `ok` 與 `has_more` | 重放不經模型，核對只靠程式條件 |
| 規則 `steps`（如 `browser_open_read`、截圖） | `_otExecute` 依序跑，失敗後只跑 cleanup | 步驟列加上後置步驟（站 4）；`_faOtAdjustSteps` 已處理「打開→前景＋自己關」；站 5 沿用 `_faOtFollowAll` | 階段 0 已修；後置步驟必須插在 close 之前（讀完、篩完才關） |
| 規則 `tool`（單一工具，含 `risk:'confirm'`） | 呼叫一個工具 | 同 steps 的單步版；確認題維持原樣（先確認再執行） | 有副作用的工具不能因為理解閘而繞過確認 |
| 規則 `fsm`（`_otExecFsm`，狀態機） | 狀態機自己跑到結束 | 站 4 視為「一個大步驟」，狀態機內部不改；站 6 只核對結果；理解閘發現有剩餘目標時，狀態機結束後再接後置步驟 | 狀態機內部的 `needs_input` 提問要沿用，不另外加問 |
| 規則 `slash` | 觸發斜線指令，結果顯示在對話 | 直接放行（`silent`），閘只記錄、不後置 | 斜線指令是使用者明確指定，不做目標分析 |
| `needs_input` → 食譜（`_recipeAnswer` ＋ `forceTool`） | 食譜補欄位後執行 | 就是站 3＋4：食譜本來就是這個迴圈的雛形；改成呼叫同一個「步驟記錄」與「核對」函式，不再各自組卡片 | 食譜的 `fetch_web_page` 只回預覽（第 1 節第二種畫面）：接上 `_faOtFollowAll` 續讀（階段 1 已做） |
| 沒規則 → 食譜（`_recipeAnswer` 無 `forceTool`） | 程式／模型逐步挑工具、填欄位、執行 | 站 2：選單題維持；選出工具後走站 4～6 | 與規則路徑共用同一份後置步驟，避免兩套找主題 |
| 沒規則 → 離線文字模型（`_offlineLlmAnswer`） | 模型自由生成文字 | 退成站 6 之後的最後退路：只有「沒有任何工具能做」才用；輸出用 `FaRecipe.checkExtractive` 對來源核對，過不了就明說做不到，不硬答 | 模型沒載入時直接說明，不假裝回答 |
| 理解不了（`needs_input` 仍缺、或理解閘 `confidence` 低） | 現在直接回「缺少參數」或列相近規則 | 決定 4：先 CoLU＋Thinking（qwen3-0.6b）思考一次；仍不懂才問使用者；答案寫進離線訓練器的學習／使用者記憶 | 思考次數沿用 `coluThinkBudget` 上限，避免卡住；模型沒載入就跳過思考直接問 |

### 10.3 共用零件與實作順序建議

- 共用：同一個 `trail`（步驟記錄）、`_faOtFollowAll`（續讀）、`_otPageDigest`（篩選）、`FaRecipe` 的字母題／封閉 JSON 輔助函式、`coluThinkBudget`。
- 階段 2（理解閘模組）與階段 3（後置步驟）只動「規則命中的路徑」；其餘路徑（食譜、離線文字模型）改接同一函式建議放階段 4 之後，並每條路徑補一個測試。
- 疑點記錄：①理解閘依賴的 `FaNlu`／`FaIntent` 目前只做英文（`logmine/intent_core.js` 檔頭「只做英文」），中文句子要靠閘自己的小詞表切「動作＋目標」，不能期待 `FaIntent.derive` 直接給出中文目標；②規則結構沒有「目標」欄位，所以後置步驟要由閘輸出、不由規則攜帶。

- 共識備註（階段0）：「自己開的分頁自己關」是設計 browser extension 時就定案的舊共識（見 skills/weak-model-harness/references/consensus/browser-control.json），不是新決定；預設背景開，使用者說「打開」才切前景（active），是否保留（keep_open）只有使用者明說才保留。

## 11. 追加（2026-11-05，使用者原話）

- 「真的開網址才是瀏覽器吧」→ 使用者說「瀏覽器打開」就必須真的用瀏覽器控制開網址；離線食譜路線不可以用 `fetch_web_page`（只回預覽、沒開瀏覽器）頂替。第二張截圖就是這個錯：走了 `fetch_web_page`。驗收：句子含「瀏覽器／browser／用 chrome 開」時，步驟列一定有 `browser_create_tab`，且沒有 `fetch_web_page` 代替。
- 「關鍵字打開也太rough，我們也可以開音樂，開pdf, docx, xlsx, 3D model, 編輯器」→ 「打開」不是一個動作，是「動詞加目標種類」：理解閘要先判斷目標種類再選工具：網址→瀏覽器；音樂／音檔→音樂播放與編輯；pdf、docx、xlsx（含附件或檔案路徑）→對應檢視器；3D 模型→3D 場景編輯器；圖片、SVG、簡報等→對應編輯器。種類的判斷依據：網址、副檔名、附件、使用者說的名詞。目前規則 `browser_open_read` 只認「瀏覽器打開＋網址」，其他「打開」全落到別條規則或沒規則。階段 2 的理解閘案例要涵蓋這些種類（每種至少 3 句），並先查既有工具（midi_edit_open、各編輯器開啟工具、檢視器）與既有「開啟」規則，不要另造。
- 「也可以開deck」（2026-11-05）→ 目標種類再加：deck（簡報，`.pptx` 或本機簡報編輯器／deck 檢視器）→ 對應的簡報編輯器；理解閘案例也要涵蓋。

- 「也有開terminal」（2026-11-05）→ 目標種類再加：終端機。既有工具 terminal_create（可帶 initial_command 一次建立並執行）、terminal_list、terminal_run、terminal_get_text；理解閘用 terminal_create 的 initial_command，有風險的指令（rm、sudo、dd、curl|sh 等）走既有的確認機制（chosen.risk=confirm）。案例：「開一個終端機」「打開 terminal 跑 ls」「開終端機並執行 echo hello」。
- 「我們所有的種類麻煩都要cover到」「純文字viewer, json viewer, 就像是mime的對應」（2026-11-05）→ 種類表做成 MIME 對應（程式裡的 OPEN_TABLE，見 renderer/src/offline/intent_gate.js），並有覆蓋測試。既有的「依類型選檢視器」邏輯：遠端群組的 _rgViewKind／_rgFileKind（依副檔名與 mime 選專屬檢視器）、/view 斜線指令（資料檢視器：xlsx、csv、tsv、json、yaml、toml）、_openHtmlViewer、fa-widget 訊息；理解閘沿用 /view 與各 *_open 工具，沒有另造檢視器。

### 11.1 種類表（MIME 對應；由程式的 OPEN_TABLE 產生）

| 種類 | MIME 類型 | 副檔名 | 開啟工具／斜線指令 | 檢視器 |
| --- | --- | --- | --- | --- |
| url（網頁） | text/uri-list | — | browser_create_tab | 瀏覽器控制（AI Controlled 分頁群組） |
| terminal（終端機） | application/x-sh | — | terminal_create | WASM 沙盒終端機（busybox ash） |
| music（音樂（MIDI 編輯器）） | audio/midi、audio/x-midi | mid、midi | midi_edit_open、播放：midi_play、/edit-midi | MIDI 編輯器／播放卡片 |
| audio（音訊） | audio/mpeg、audio/wav、audio/flac、audio/ogg、audio/mp4、audio/* | mp3、wav、flac、ogg、m4a | （目前沒有專用的音訊播放器（只有 MIDI 播放）） | — |
| pdf（PDF） | application/pdf | pdf | parse_uploaded_file（目前沒有專用的 PDF 檢視器，只能讀出文字內容） | — |
| docx（Word 文件） | application/vnd.openxmlformats-officedocument.wordprocessingml.document、application/msword | docx、doc | edit_docx_open、/edit-docx、/edit-word | Word 文件編輯器 |
| xlsx（Excel 試算表） | application/vnd.openxmlformats-officedocument.spreadsheetml.sheet、application/vnd.ms-excel | xlsx、xls | edit_xlsx_open、/edit-xlsx、/edit-sheet | 試算表編輯器 |
| csv（CSV 表格） | text/csv | csv | edit_csv_open、/edit-csv | CSV 編輯器 |
| deck（簡報） | application/vnd.openxmlformats-officedocument.presentationml.presentation、application/vnd.ms-powerpoint、application/x-deck+yaml | pptx、ppt、deck.yaml | open_existing_presentation、pptx_to_deck、/edit-media-presentation、/media-open-presentation | 簡報播放器／簡報編輯器 |
| markdown（Markdown 編輯器） | text/markdown | md、markdown | edit_markdown_open、/edit-markdown、/edit-md | Markdown 編輯器 |
| text（純文字編輯器） | text/plain | txt、log | edit_text_open、/edit-text、/edit-txt | 純文字編輯器 |
| code（程式碼（文字編輯器）） | text/javascript、application/javascript、text/x-python、text/x-c、text/x-java、text/css | js、ts、py、c、cpp、h、java、go、rs、sh、css、rb、php | edit_text_open | 純文字編輯器 |
| html（網頁編輯器） | text/html | html、htm | webedit_open、/webedit、/edit-html | 網頁編輯器（預覽、HTML／CSS／JS） |
| data（資料檢視器（JSON／YAML／TOML）） | application/json、application/yaml、application/toml、text/tab-separated-values | json、jsonc、yaml、yml、toml、tsv | /view | 資料檢視器（_dataViewOpenFile） |
| svg（SVG 編輯器） | image/svg+xml | svg | edit_svg_open、/edit-svg | SVG 編輯器 |
| picture（圖片編輯器） | image/png、image/jpeg、image/gif、image/webp、image/* | png、jpg、jpeg、gif、webp | edit_picture_open、/edit-picture | 圖片編輯器 |
| video（影片編輯器） | video/mp4、video/quicktime、video/webm、video/* | mp4、mov、mkv、webm | edit_video_open、/edit-video | 影片編輯器 |
| model3d（3D 場景編輯器） | model/gltf+json、model/gltf-binary、model/stl、model/obj、application/x-3dscene+yaml | glb、gltf、obj、stl、fbx、3mf、3dscene.yaml | edit_3d_open、/edit-3d、/edit-3d-model、/view-3d-attachment | 3D 場景編輯器／檢視器 |
| viewerdoc（互動文件檢視器） | application/x-viewerdoc+yaml | viewerdoc.yaml、viewer.yaml | import_interactive_viewer_attachment、/import-viewer-attachment | 互動表單卡片 |
| worksheet（學習單編輯器） | — | — | worksheet_open | 學習單編輯器 |
| sqlite（SQLite 瀏覽器） | application/x-sqlite3、application/vnd.sqlite3 | sqlite、sqlite3、db | /sqlite-browser | SQLite 瀏覽器 |
| archive（壓縮檔） | application/zip、application/x-tar、application/gzip | zip、tar、gz、tgz | （目前沒有專用的壓縮檔檢視器（可以請終端機解開再看）） | — |

不適用（EXEMPT，覆蓋測試要求寫明原因）：playbook_state：程式設計流程的狀態機，不是開啟；render_interactive_viewer：AI 用 YAML 渲染表單給使用者看，是產生內容，不是依使用者說的種類開檔；get_interactive_viewer_yaml：讀取目前互動表單的 YAML（查詢）；get_viewer_state：查詢互動表單狀態（查詢）；set_viewer_state：修改互動表單狀態（AI 操作，不是使用者開啟）；terminal_list：列出終端機（查詢）；terminal_run：在已開的終端機執行指令（理解閘用 terminal_create 的 initial_command 一次做完）；terminal_get_text：讀終端機畫面（查詢）；terminal_cp_to：複製檔案進終端機（檔案操作）；terminal_cp_from：從終端機取出檔案（檔案操作）；/edit-file：依副檔名自動分派到各編輯器，等於理解閘本身的種類表；/edit-join：把兩個編輯器內容合併，不是開啟；/edit-game-2d：遊戲編輯器：沒有檔案種類可對應，使用者要明說「2D 遊戲編輯器」；先列為不適用；/edit-game-3d：遊戲編輯器：同上；/remote-open：開啟遠端機器的結果，屬於遠端群組流程。

覆蓋測試（scripts/offline-gate-open.test.js）自動掃出名稱含 open／viewer／editor／player／preview 的工具與開啟類斜線指令，每個都必須在種類表或 EXEMPT；新增工具沒登記就失敗。種類判斷順序：副檔名 → 網頁編輯器／終端機等具體說法 → 網址 → 瀏覽器字樣 → 名詞；都沒有才進語意推導與探索（第 13 節）。

## 12. 階段 2～4 實作註記（2026-11-05，子工作階段；提交 7e4de04c、c343b725、c0df5c82）

- 實作位置：`renderer/src/offline/intent_gate.js`（純函式；動作、目標種類、開啟工具、後置步驟、記憶、核對）；接線在 `floating-assistant.js` 的 `_otGateApply`／`_otGateResolve`／`_otGatePost`／`_otGateVerifyAsk` 與 `_otExecute` 的 steps 分支（後置步驟在關閉分頁之前跑）。
- 同義詞擴充很保守：只在「關鍵字整個等於詞庫某概念詞」或使用者自訂同義詞組命中時才擴充；詞庫（`FA_SEM_GROUPS`）是工具概念詞，不是新聞主題詞，亂擴充會拿無關標題充數。
- 離線記憶沿用 `set_synonyms` 的存法（離線訓練器 meta 表，key `gate_memory`）；`_otAddExample` 只能替既有規則加範例，表達不了「這句後半是摘要」，所以沒用它。
- 規則接手條件：規則是字面（regex）且信心 ≥0.8、或工具與理解閘的開啟工具相同，就尊重規則；語意勉強配到別的工具（例如「打開 合約.docx」→ merge_pdfs 0.66）才由閘接手。
- 沒做／只推測：①PDF 沒有專用檢視器，只能 `parse_uploaded_file` 讀文字；②「比較／判斷」「取第 N 則」後置步驟只記成「沒做到」（階段 5）；③離線小模型（qwen3-0.6b）實際回答品質沒量測，真桌面版的實測用「小模型沒載入」路徑（直接問使用者），小模型路徑只有注入假模型的單元測試；④真擴充功能沒接，實測用替身瀏覽器工具。
- 既有失敗（非本次造成，推測）：`midi_route.test.js` 解析來源的 `re:` 格式失敗、tray_dialog 輸出格式、computer-remote 兩項。

## 13. 語意推導、探索迴圈、反思（2026-11-05，使用者原則，子工作階段實作）

使用者原話：「這種應該都要進harness，做到內建規則……建立原則讓LLM在不清楚的時候要有能力查wiki。甚至反思。都是為了減少我們主動塞資料。所以最核心的探索，語意推導必須要做好」。（第 12 節是階段 2～4 的實作註記，這一節是接著的新原則。）

1. 種類表與規則是底線：核心是 `deriveTool`——把句子的雙字詞（找不到時退到單字）、同義詞組（`FA_SEM_GROUPS` 與使用者自訂）拿去對工具目錄（種類名稱、名詞、副檔名、工具說明），算分數排序；最高分夠高且明顯高於第二名，程式就直接決定（`pickDerived`）。
2. 不確定時的探索順序（內建在 `_otGateExplore`）：①工具目錄（程式）→ ②知識庫（`knowledge_ask`，查使用者自己放進去的文件；本版沒有另外接專案 wiki／`ref_lookup`）→ ③離線小模型（qwen3-0.6b＋CoLU Thinking）字母選擇題 → ④問使用者。每一步都在卡片上留下紀錄。
3. 反思（`_otGateReflect`）：執行後沒成功就換路線，上限 `FA_OT_GATE_MAX_REFLECT`＝2（寫死）；成功後把「整句→種類」寫進記憶（key 為 `s:` 加正規化句子），下次不用再探索。
4. 共識檔：`skills/weak-model-harness/references/consensus/offline-semantic.json`（must：探索、反思、覆蓋測試、knowledge_ask 等；forbid：為單一句子寫死規則）；`consensus_check.js` 對程式碼檢查通過。
5. 驗收（誠實回報，見 `scripts/offline-gate-open.test.js` 輸出）：第一組 20 句新說法（關鍵詞多半已在種類表的名詞裡）程式推導命中 20/20；第二組 10 句「關鍵詞不在表裡」（財報、名單、設計稿、會議紀錄、提案、績效表、教材、腳本、錄影…）**只靠程式推導命中 2/10**，其餘要靠探索第②～④步（知識庫、小模型字母題、問使用者）。沒命中的原因：這些詞不在任何種類的名詞、說明或同義詞組裡，雙字詞對不上，單字退路分數又太接近。要提高程式端命中率，要靠補同義詞組（使用者回答後可自動擴充）而不是補規則。
6. 沒做／推測：探索第②步沒用真的知識庫跑過（只有注入假資料的單元測試）；第③步只有假模型的單元測試；PDF、音訊、壓縮檔目前沒有檢視器，卡片會明說。
7. 實機發現（真 Electron，已裝 qwen3-0.6b，開 Thinking）：「把那份財報叫出來」（附一個沒副檔名的附件）探索③小模型選了「簡報」，**答錯**（該是試算表）；只有 1 筆樣本，不能當正確率，但足以說明 0.6b 的猜測不可靠。因此：小模型選的種類、反思換路線的結果**不自動寫進記憶**（只有使用者回答、或程式靠工具目錄／知識庫有把握的才記），卡片明說「猜的，沒有自動記住」。真正量測 0.6b 在這類題的正確率仍是階段 5 的待辦。
