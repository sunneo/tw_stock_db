# 設計：離線模型平日任務——plan → 範本 → 接線（進行中，handoff 2）

> 狀態：**todo 2 進行中**。下面標「已驗證」的是讀程式碼確認過的事實；標「未驗證」的還沒有實跑，不可當結論。全部需求見 `docs/HANDOFF.plan-template.md` §3（追加需求 a～g）與 §5（逐字）。

## 0. 需求摘要（逐層歸約範式）

- 讀 log 能做好，是**逐層歸約（map-reduce）**：切段→每段各自讀摘要→往上合併→層層縮到放得進上下文。模型每次只看一小段，切分與下一段讀哪裡由程式決定。（見 `DESIGN.log-mining.md`）
- 網頁多篇摘要套同一範式：第 0 層＝程式取回的原始內容（清單→各篇內文）；第 1 層＝逐篇／逐段摘要；第 2 層＝合併總結。每層的單位、模型被問的封閉題、層間傳遞、停止條件、thinking 位置，待 todo 4 寫定。

## 1. 現況診斷（todo 2）

### 1.1 已驗證：「離線模式」的網頁路徑是規則式，不經模型

- `_otPageDigest(o, query)`（`renderer/src/floating-assistant.js` 約 93418 行）：有目標詞時，用 `_faOtWebFilter` 篩出含關鍵字的行，直接列出；沒有目標詞時，用 `_faSemSentences` + `_faSummarize`（TextRank）挑 6 句。**沒有任何模型呼叫**。結尾固定加一句「離線模式只能列出頁面上的文字，無法像AI一樣歸納說明」。
- `_otPretty(raw, query, budget)`（約 93444 行）：長文字同樣用 TextRank 摘錄，不經模型。
- 目標詞來源：`_faOtWebGoal(text, lex, groups)`（約 3501 行）與 `_faOtExpandTerms(kw, lex, groups)`（約 3572 行）。

→ 若使用者昨晚是在「離線模式」卡片的路徑裡，輸出會像「程式直接吐的清單」，這與使用者描述一致。**但哪一條路徑是昨晚實際走的，尚未確認**（見 §1.3）。

### 1.2 已驗證：「離線模型」的 plan／recipe 路徑有 trace 與 recipe 決策

- `FaRecipe.decide(trace, {stage:'run', tool, answer…})`（約 129690 行）在工具執行後寫 trace；`rtrail` 經 `_faOtTrailText` 轉成「📋 做了這些步驟」的文字。
- `_rgTrace(job, line)`（約 79775 行）：每個 job 的 trace 行最多 300 行，每秒批次送 `_rgAct({kind:'trace'})`，每批最多 15 行。這是 research job 的活動紀錄，**是否就是使用者開的 transcribe 畫面，未驗證**。

### 1.3 已驗證：「AI 只產生 plan／recipe 就結束」的真正原因（2026-11-17）

使用者的症狀（「AI只產生plan, recipe就結束了」）對應到的路徑是**離線模型（Qwen3）＋食譜開啟**，不是離線模式規則路徑。呼叫鏈：

1. `_offlineRoute`（約 93974 行）：規則路徑沒命中、`FaVlm.shouldUseOfflineLlm` 為真、`offlineRecipes` 開 → 先呼叫 `_recipeAnswer`。
2. `_recipeAnswer`（約 129617 行）：`offlineRecipePlans` 開且沒有 `forceTool` → 先呼叫 `_planAnswer`（多步計畫）；計畫沒命中才走單一工具食譜（程式以證據縮小候選、`autoPick`，不行才問模型選編號，再補欄位、執行一個工具、必要時 `recipePhrase` 讓模型說 1～2 句）。
3. `_planAnswer`（約 129505 行）：`FaPlan.matchGoals` 命中目標（例如 `web_summary`、`web_research`）→ `buildPlan` → `_planRun`。
4. `_planRun`（約 129474 行附近）：`FaPlan.advance(run, env)` 執行所有步驟；每步的進度寫進「離線計畫：…」進度卡片（`_createProgressWidget`，不是 `_rgTrace`）。
5. **結束點**：`_planFinish`（約 129495 行）。修正前，它把 `run.artifacts` 裡最後一個 `kind === target` 的 `value` 直接當答案（`body = f.value`），回傳 `planText + body`。**沒有任何模型呼叫讀取取回的內容**。所以輸出是「計畫列表＋程式取回的原文」，看起來就像「只產生 plan、recipe 就結束」。

→ 原因已確認：缺的是「讀＋總結」這一層，不是迴圈提前結束。`_planLocalSummarize`（約 129450 行）其實已經是逐段摘要＋檢查＋合併的逐層歸約實作，只是 `_planFinish` 沒有呼叫它。

### 1.4 已修（commit `6b93b201f`）

- `_planFinish` 增加第 6 個參數 `M`（`_planRun` 傳入 `ctx.M`）。摘要類目標（`target === 'summary'`：`web_summary`、`web_research`、`doc_summary`、`video_summary`）跑完、有取回內容時，改用 `_planLocalSummarize(finalValue, question, M)`。
- 結果標示：`method === 'model'` → 「（經 AI 逐段摘要並合併）」；`mixed` → 「部分段落由程式摘錄，其餘經 AI 摘要」；`extractive`（沒模型）→「⚠️ 這次沒有經過 AI（程式摘錄）」。
- 測試：`renderer/src/recipe/plan_readback.test.js` 8 passed（假模型收到取回內容；最終回答含模型摘要；沒模型時標示且不呼叫模型；非摘要目標輸出不變）。**注意：這是假模型＋假取回內容的單元測試，還不是真模型＋真網頁的實跑**。

### 1.5 未驗證（仍待做）

1. transcribe 為什麼看不到多輪：「離線計畫」進度卡片與 `_rgTrace`（研究工作的活動紀錄）是不同的顯示管道。使用者開著的 transcribe 讀的是哪一個，尚未確認。單一工具食譜路徑（`_recipeAnswer` 的 trace）是否有顯示，也未確認。
2. 「看今天有哪些黃仁勳新聞」尚未在真模型＋假網頁上實跑；目前 `web_research`／`web_summary` 的取清單與篩選（`_otPageDigest` 的 goal 篩選）還沒有接上來源登錄表與拆字。

## 2. 設計（尚未實作）

### 2.1 範本節點 ＝ 逐層歸約的一層

| 層 | 單位 | 誰做 | 模型被問什麼 | 停止條件 |
|---|---|---|---|---|
| 0 取回 | 清單 → 各篇網址與內文 | 程式（工具） | 無 | 取到 N 篇或清單用完 |
| 1 逐篇摘要 | 一篇（超長則再切段） | 模型（可 thinking） | 「這篇跟 K 有關嗎？一句重點」（封閉的是/否與固定欄位） | 每篇都有結果 |
| 2 合併 | 所有逐篇結果 | 模型＋程式計數 | 「依下列 N 則寫一段總結」 | 單次生成完成 |

- 範本每層完成後，**一定**把取回內容送模型讀＋摘要。沒經過模型的步驟在畫面上標「這次沒有經過 AI」。
- 驗收用例：「看今天有哪些黃仁勳新聞」：目標詞 黃仁勳，展開別名（Jensen Huang、輝達、NVIDIA…），篩出相關標題，逐篇讀內文，逐篇摘要，合併成「N 則，各一句重點」；沒有就明說沒有。

### 2.2 來源登錄表（資料層，待做）

- 依任務類型列進入點：新聞（台灣）Yahoo 新聞 `https://tw.news.yahoo.com/`、中央社、聯合新聞網、自由時報、公視、Google News 搜尋 RSS `https://news.google.com/rss/search?q=<關鍵字>&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`。
- 每筆欄位：名稱、進入點樣板（關鍵字槽）、取清單方式（RSS／列表頁／搜尋頁）、內文擷取方式、語言、可靠度、預設順序。
- 站名別名表（字串比對，不叫模型猜）：`yahoo`、`Yahoo新聞`、`雅虎`、`奇摩新聞` → `tw.news.yahoo.com`；`yahoo股市`、`奇摩股市` 要分開。沒抓到站名才退回預設來源或問封閉題（從選項選一個字母）。

### 2.3 拆字（純函式，待做）

- 使用者的話：去功能詞（今天、有哪些、幫我、請、新聞、看…）、抽目標詞、展開別名與近義（沿用 `_faOtWebGoal`／`_faOtExpandTerms`／`FA_SEM_LEX`）。
- 頁面文字：切成「標題＋連結」單位（沿用 `_otPageDigest` 的雜訊規則），再逐單位比對目標詞。

### 2.4 可觀測性（待做）

- 每步一行進 transcribe：輪次、階段、誰做的（程式／模型）、工具與主要參數、取回大小與前幾字、送模型的封閉題與回答摘要、耗時、失敗與退回原因。點開看詳細。
- 測試：假模型＋假工具跑完整範本，斷言步驟序列完整、順序正確、含輪次與誰做的。

## 3. 下一步

1. 完成 §1.3 三個未驗證項（實跑假網頁＋離線模型，記錄呼叫鏈）。
2. 依 §2 實作：來源登錄表、拆字、範本層、trace 行、測試。
3. 垂直切片實跑：「看今天有哪些黃仁勳新聞」與「去 yahoo 看黃仁勳的新聞」，結果寫回本文件。

## 4. 實跑結果（2026-11-17，真模型＋假網頁）

執行：`node scripts/eval/news_real_run.js`（真模型 qwen3-0.6b q8、純 JS CPU 參考引擎、貪婪解碼；網頁是固定假頁；流程是 `floating-assistant.js` 裡真的 `_newsDigestAnswer`／`_planLocalSummarize`，抽出方法本體執行）。

| 說法 | 結果 | 逐步（節錄） |
|---|---|---|
| 看今天有哪些黃仁勳新聞 | 2 則（Yahoo 新聞首頁）；標示「沒有經過 AI」 | 選來源（預設兩家）→拆字（黃仁勳＋近義）→取清單（Yahoo 3 則有連結；中央社無連結，明說讀不到內文）→篩選 2 則→讀第 1、2 篇→逐篇摘要（程式摘錄）→合併 |
| 去 yahoo 看黃仁勳的新聞 | 同上，只用 Yahoo（站名 yahoo → 新聞首頁） | 站名比對正確，只抓一個入口 |
| 看 yahoo 新聞有沒有颱風 | 「查了Yahoo 新聞（台灣），沒有找到跟「颱風」有關的新聞。我不拿不相關的標題充數。」 | 篩選 0 則，沒有讀任何內文 |

**誠實的結論（本次實跑揭露的問題）：**
1. **模型的逐篇摘要被檢查器退回，全部落到程式摘錄。** `checkExtractive` 拒絕了模型輸出（原因尚未查：要抓 `_planLocalSummarize` 裡 `M.gen` 的原始輸出再比對）。在修好之前，「經 AI 摘要」這條路徑在真模型上**沒有被證明**；畫面標示正確（「這次沒有經過 AI」），沒有假裝。
2. **速度：純 JS CPU 上一篇摘要約 300 秒**（貪婪解碼，最多 200 詞元）。使用者的機器有 GPU（WebGPU／原生），實際速度會快很多，但這次是 CPU 參考路徑，不代表產品速度。
3. 列表頁若沒有文章網址（中央社這次的假頁）就會明說讀不到內文，不瞎猜網址；真實網站的列表頁是否帶網址，還沒有用真的 `fetch_web_page` 驗證（它的回傳是檔案＋分頁，`_newsFetchText` 已處理，但沒有真網路實跑）。

**可觀測性（§2.4）的現況：** 每一步一行 `第 N 輪｜階段｜誰做｜細節`，寫進「新聞摘要」進度卡片（`_createProgressWidget`，會顯示在對話裡）；逐篇摘要那行含「問什麼、答什麼、耗時」。**尚未確認**使用者開著的 transcribe 是不是這張卡片；它是否就是 `transcribe`，還沒有查證。

**程式與測試（已提交）：** `renderer/src/recipe/web_news_core.js`（989435b1f）、`news_digest_core.js`（494591aa4）、`read-back`（6b93b201f）、接線（494591aa4，`_recipeAnswer` 先接手新聞類問題，`scripts/embed-news-digest.js` 只更新 NEWSDIGEST 區段）；測試 21＋23＋12＋8 全過（都是假模型＋假網頁）。
