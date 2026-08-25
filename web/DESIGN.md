# floating-assistant.js — 設計文件

這份文件記錄「為什麼」`floating-assistant.js`（下稱「這個元件」）長成現在
這個樣子，尤其是三個核心、彼此相關的設計主軸：**怎麼省 token**、**怎麼
判斷一個模型/端點支不支援原生 tool-calling**、以及**工具參數的型別資訊
（`parametersSchema`）扮演什麼角色**。其餘子系統（Graph-RAG 記憶、批次
子任務、自訂工具、持久化等）放在後半段。

如果你要找「怎麼用」，看 [README.md](README.md)。

## 設計哲學

這個元件被設計成**可攜、宿主無關**：不認識任何特定專案的業務概念（股票、
持股診斷…都是靠 `register_openai_tool()` 從外部掛進來的），沒有 build
流程（單一 `.js` 檔案直接用 `<script>` 載入），也不假設宿主頁面的任何
慣例（主題偵測、markdown 匯出行為都可以被 `options` 覆寫）——這個檔案
已經實際被複製到至少一個其他專案重用過，每次因此發現「原來這裡偷偷假設
了宿主頁面的某個慣例」都會被修成可覆寫的掛鉤，而不是留著。

對話迴圈本身刻意設計成兩條平行、幾乎對稱的路徑：`_loopFetch`（文字式
`[CALL: name(args)]` 協定，串流）跟 `_loopFetchNative`（原生 `tools`/
`tool_calls`，非串流）。兩條路徑同時存在，是因為現實中能連到的端點/模型
組合，原生 tool-calling 的支援程度落差很大（見下一節）；元件本身不賭
「大家都支援原生協定」，而是兩條路都做到堪用，並且**自動判斷**該走哪一條。

---

## 一、Native vs. 文字式工具呼叫偵測

### 問題

OpenAI 相容 API 的 `tools`/`tool_calls` 欄位理論上是標準化的，但實務上：

- 有些端點/模型完全不支援（傳了 `tools` 欄位要嘛被忽略、要嘛整個請求被拒絕）。
- 有些「支援」，但品質不穩定（例如某些較小的模型一次只能呼叫一個工具，
  或者原生 `tool_calls` 陣列裡的巢狀參數處理有問題——見下一節的
  `parametersSchema`）。
- 同一個模型名稱在不同端點（NVIDIA 官方 API vs. 透過自架 proxy）背後可能
  是不同的實際部署，支援度也可能不同。

如果每次都用固定的「模型名稱 pattern」去猜（例如「名字裡有 `gpt` 就當作
支援」），換一個新模型、或同一個模型的端點行為變了，就會一直猜錯。

### 解法：實測探測 + 快取，而不是猜

`_probeNativeToolSupport(apiKey, apiUrl, apiModel)` 送一個極小的請求：

```js
{
  messages: [
    { role: 'system', content: 'You are a capability test harness.' },
    { role: 'user', content: 'You MUST call the "ping" function now with no arguments. Do not respond with any text, only call the function.' },
  ],
  tools: [{ type: 'function', function: { name: 'ping', description: '...', parameters: {...} } }],
  tool_choice: 'auto',
  max_tokens: 4096,
}
```

檢查回應的 `choices[0].message.tool_calls` 是不是真的有東西——**不是**看
端點回不回 200、也不是看模型名稱，是看它有沒有真的照著原生協定吐出
`tool_calls`。任何錯誤（網路、逾時、端點拒絕 `tools` 欄位）都當作「不
支援」，安全退回文字式協定，不會讓對話整個卡死。

`_ensureNativeToolSupportProbed(apiKey, apiUrl, apiModel)` 是快取入口：
同一個 `apiUrl+apiModel` 組合只會真的探測一次，結果存進
`localStorage['floating_ai_native_tool_support_cache_v2']`（記憶體+
localStorage 雙層）。內建的常用模型（`PRESET_MODEL_TOOLCALL_SUPPORT`）
已經預先探測建表，命中就直接用，省下每個使用者自己重複探測一次的網路
成本；不在表裡的模型（含使用者自訂模型）才會即時探測。

`_shouldUseNativeToolCalls(apiModel)` 是實際決策點，三態：

- `advancedSettings.toolCallMode === 'native'` / `'text'`：使用者手動鎖定，
  不查快取也不探測。
- `'auto'`（預設）：先查記憶體/localStorage 快取，沒有才查
  `PRESET_MODEL_TOOLCALL_SUPPORT`，都沒有才即時探測、拿到結果後才寫入
  快取。

### 曾經踩過的坑：探測本身的 false negative

`_probeNativeToolSupport()` 原本是 `max_tokens: 50` + 15 秒逾時。這對一般
模型夠用，但對**推理模型**（例如 `nvidia/nemotron-3-super-120b-a12b`）
不夠——這類模型會先在獨立的 `reasoning_content` 欄位吐一大段思考過程，
才輪到輸出真正的 `tool_calls`；50 tokens 幾乎必定在思考階段就被截斷，
探測永遠看不到 `tool_calls`，於是「探測預算不夠」被誤判成「這個模型不
支援原生 tool_calls」，被永久寫死在 `PRESET_MODEL_TOOLCALL_SUPPORT` 裡
（`nvidia/nemotron-3-super-120b-a12b: false`）。

使用者拿 NVIDIA 官方文件的範例證實這個模型確實支援原生 `tool_calls` 後，
才發現是探測本身的 bug，不是模型真的不支援。修法：

1. 探測放寬到 `max_tokens: 4096` + 45 秒逾時，給思考過程足夠空間。
2. 把當時因此被誤判的模型從 `PRESET_MODEL_TOOLCALL_SUPPORT` 移除，讓它
   改用修好的探測邏輯即時重測。
3. `NATIVE_TOOL_SUPPORT_CACHE_KEY` 版本號往上加一層（`_v2`），讓所有已經
   把錯誤結果寫進自己 localStorage 的使用者，下次都會重新探測一次，不用
   手動清瀏覽器資料。

**設計教訓**：探測邏輯本身的資源預算（token/時間）跟被探測對象的真實
行為特性（推理模型的思考開銷）必須匹配，否則探測結果的可信度比不探測
還糟——因為它會被永久快取、被當作「已知事實」對待。

---

## 二、省 token 的設計

省 token 不是單一機制，是好幾層各自處理不同來源的浪費：

### 1. 文字式協定的工具清單精簡（「skill 系統」）

不支援原生 tool-calling 的模型，走文字式 `[CALL:...]` 協定時，過去的
做法是把**每個已註冊工具的完整說明（含參數 JSON）**都攤平寫進 system
prompt——這個專案曾經量到，38 個工具的完整清單佔了約 **11,450 字元**
（`export_document`、`render_stock_chart` 兩個工具的描述加起來就佔了
近 4,000 字），加上其餘的規則文字，單這個 system prompt 就逼近 17,000
字元（粗估 9,000–11,000 tokens），每一輪對話都要重送一次。

現在 `_getFinalSystemPrompt()` 只列**工具名稱＋極短摘要**
（`_summarizeToolDescription()`，取描述開頭到第一個標點或約 36 字，
先到先切），量到的結果是同樣 38 個工具的清單從 11,450 字元降到約
1,750 字元（省下約 85%）。模型要呼叫一個不熟悉的工具之前，改成先呼叫
內建的 `get_tool_details({"names": [...]})` 查出完整的參數規格——這正是
一般 agent 工具鏈裡「先搜尋工具、再看完整 schema」的兩段式模式（跟
Claude Code 自己的 deferred-tool `ToolSearch` 機制是同一個精神）。

這個精簡**只影響文字式協定路徑**：原生 tool_calls 模式本來就是透過 API
的 `tools` 參數把完整、結構化的 schema 傳給模型，不會受這裡影響，模型
也不需要呼叫 `get_tool_details`（結構化 schema 裡本來就看得到完整參數）。

### 2. 推理過程（`reasoning_content`）不進 API context

NVIDIA 推理模型系列（跟 DeepSeek-R1 同慣例）會把內部思考過程放在獨立的
`reasoning_content`/`delta.reasoning_content` 欄位，跟真正要顯示的
`content` 分開。這段思考動輒 6,000–8,000 字，遠大於工具結果本身——如果
跟舊版一樣把它接成 `<think>...</think>` 直接混進 `msg.content`，因為
`content` 同時是「畫面要顯示的」跟「下一輪要送回 API 的」同一個欄位，
等於是把模型自己的內部草稿永久疊進對話歷史，context 只會越滾越大。

現在的做法：`reasoning_content` 只存進訊息物件的**非可枚舉屬性**
`_reasoningDisplay`（`Object.defineProperty(..., {enumerable: false})`），
畫面上用「🧠 思考過程」摺疊區塊顯示，但 `JSON.stringify`/送進 API 的
request body 不會撿到它——`msg.content` 保持乾淨，只有真正的答案文字。

同樣的「非可枚舉屬性 = 只給畫面用、不送進 API」手法，也用在
`_displayDataUrl`（AI 產生的圖片）、`_downloadFile`（檔案下載參照）、
`_benchmarkReport`、`_suggestionChips` 上——這些全部不會讓後續對話的
context 變大，持久化時才另外拆進獨立的 side-map（見「持久化層」一節）。

### 3. 批次任務用一次性子對話，不塞進主對話

「對一份清單裡每一項各自做獨立判斷」這種任務（例如逐檔股票篩選/打分），
如果每一項都在主對話裡呼叫一次工具，context 會隨清單長度線性膨脹。
`runBatchSubAgents(items, instruction, concurrency)` 改成幫每一項開一個
**用完即丟、平行執行**的獨立子對話（`_runSubAgentTask`，有自己的本地
`messages` 陣列，完全不碰 `this.messages`），只把每一項的精簡結論
（`{item, verdict}`）流回主對話，過程中的工具呼叫/中間推理都不會累積
進使用者看到的對話歷史。

### 4. 上下文超限時用 LLM 摘要壓縮，而不是暴力截斷

`pruneContext(reason)` 只在真的收到 400/413（上下文超限）時才觸發，
不是靠不準的 token 估算主動觸發（舊版做法量測後發現估算不準，還要多花
一次摘要請求，已經拿掉）。壓縮策略是請模型**自己**把目前對話總結成一段
摘要，且明確要求摘要要保留：(1) 原始意圖、(2) 已經呼叫過哪些工具、帶
什麼參數、結果是什麼、(3) 目前進度到哪個階段——這個要求很具體，是因為
量到的真實失敗模式：摘要太模糊時，模型會誤以為任務還沒開始，把已經做過
的工具呼叫整個重做一遍，重新塞滿 context、再次觸發壓縮，形成無窮迴圈。

原始訊息不會真的消失，只是從「要送進 API 的內容」移到
`archivedDisplayBlocks`（畫面上維持原樣顯示，例行壓縮甚至不會讓使用者
感覺到；只有「話題轉移」這種語意上真的值得標記的壓縮才會包成一張可摺疊
的「已封存對話」卡片）。

### 5. 取樣參數「不送 = 安全預設值」

`_buildSamplingParamsBody()` 只送使用者手動設定過、且沒被目標端點拒絕過
的取樣參數——省下的不是 token 本身，而是省下「送一個端點不支援、觸發
400/413、又要走一次 pruneContext」這整條路徑的浪費。

---

## 三、額外參數：`parametersSchema`

### 這是什麼

`register_openai_tool(name, description, callback, parametersSchema)` 的
第 4 個參數，**選填**，格式是標準 JSON Schema（例如
`{type:'object', properties:{indicators:{type:'array', items:{}}}, additionalProperties:true}`）。
只有原生 tool_calls 模式會用到它；沒提供時退回舊行為（見下方「沒有它會
發生什麼事」）。

### 為什麼需要它

`_buildNativeToolsSchema()` 把每個已註冊工具轉成 API 的 `tools` 陣列項目
時，`function.parameters` 這個欄位過去一律是：

```js
{ type: 'object', properties: {}, additionalProperties: true }
```

也就是完全不透露任何一個參數的型別。模型只能從**自然語言描述**（塞在
`description` 字串裡的那段「參數：{...}」JSON 範例文字）去猜每個參數
「大概」長什麼樣子，但 API 層面的 schema 沒有明講「這個參數是陣列」
「那個參數是物件」。

實測發生過的真實案例：`render_stock_chart` 的 `markers`/`lines`/
`indicators`/`range` 這些「應該是陣列/物件」的參數，模型（原生 tool_calls
模式下的 `nvidia/nemotron-3-super-120b-a12b`）自己決定用 JSON 字串包一層
送出來：

```json
{"indicators": "[\"macd\", \"rsi\"]"}
```

而不是預期的：

```json
{"indicators": ["macd", "rsi"]}
```

工具 handler 裡任何 `Array.isArray(params.indicators)` 這類檢查全部
判定為 false，靜靜退回空陣列——圖表畫出來完全沒有任何標記/副圖，模型卻
因為自己的工具呼叫「表面上成功了」（沒有拋錯），在最終回覆裡自信地宣稱
「已包含 MACD/RSI 副圖」。這個 bug 特別陰險的地方：它只在**原生**
tool_calls 模式下發生——文字式 `[CALL:...]` 協定的 system prompt 裡有
明確的、模型可以照抄的 JSON 範例（`[CALL: diagnose_stock({"code": "2330"})]`），
不受這裡 schema 缺失的影響，所以文字模式從來沒暴露過這個問題。這正是
「把 nemotron-120b 從文字模式切到原生模式後才冒出來的新 bug」——修好
native tool-call 偵測反而**揭露**了一個原本被文字協定意外掩蓋掉的 schema
缺陷，不是新引入的問題。

### 兩層修法

1. **正本清源：給 schema 真正的型別。** `index.html` 的
   `registerAiCapabilities()` 從每個工具既有的自由文字參數說明（人類/AI
   都看得懂的中文描述，例如「選填陣列，要在主圖下方…」）用簡單關鍵字
   推斷型別（`_inferJsonSchemaTypeForParam()`：文字含「陣列」→
   `type:'array'`、含「物件」→ `type:'object'`、其餘→ `type:'string'`），
   組成 `_buildParamsJsonSchema()` 回傳的 schema，當作第 4 個參數傳給
   `register_openai_tool()`。這樣模型從 schema 本身就能看出「這裡該填
   原生陣列」，不必只靠自然語言猜。
2. **事後兜底：`aiToolHandler` 的防禦性重新解析。** 即使 schema 給對了，
   不同模型/端點的實際遵從度仍有落差，`aiToolHandler`（`index.html`）在
   `JSON.parse(rawArgs)` 拿到頂層物件之後，會再逐欄位檢查：如果某個值
   是「看起來像 JSON」的字串（開頭是 `[` 或 `{`），就再 `JSON.parse` 一次
   換成真正的陣列/物件（`_reparseJsonLikeStringFields()`）；解析失敗
   （代表它本來就只是一般字串，例如股票代號）就保留原樣，不會誤傷。

兩層加在一起：正確的 schema 大幅降低模型犯這個錯的機率，事後兜底則確保
即使某個模型/端點仍然選擇字串化，功能也不會靜默失效。

### 向下相容

第 4 個參數是選填的——`register_openai_tool(name, description, callback)`
這種舊式 3 參數呼叫完全不受影響，`_buildNativeToolsSchema()` 找不到
`parametersSchema` 時退回原本的 opaque schema，跟修改前行為一致。目前
只有 `index.html` 的 `AI_CAPABILITIES` 工具、以及元件自帶的
`get_tool_details`（`names` 參數）有提供這個 schema；其餘內建工具
（`rag_*`、`add_ai_function` 等）跟使用者自訂工具（`advancedSettings.customTools`）
目前還是走 opaque schema——理論上這個問題也可能發生在它們身上，只是
還沒有實測案例證實，算是已知、尚未處理的技術債。

---

## 四、其他子系統

### Graph-RAG 長期記憶

`IndexedDBRAGSystem` 底層是 `SimpleEmbeddingEngine`——**純 TF-IDF，不是
真正的向量 embedding**：`tokenize()` 依非文字/非中日韓字元切詞，
`updateIDF()` 對目前所有已存節點重算一次全域 IDF，`embed()` 產生稀疏
TF-IDF 向量，`cosineSimilarity()` 做餘弦相似度比對。一個「知識節點」是
`{id, content, dependencies:[], preConditions:[], tags}`——`dependencies`
是明確的前置節點 id 清單（有向圖的邊），不是向量空間裡的鄰近關係。

`query(text, topK=3)` 先用 TF-IDF 找出分數最高的 `topK` 個直接命中節點，
再遞迴展開每個命中節點的 `dependencies` 鏈（`_resolveDependencyChain()`，
有 `visited` 集合防止循環），把整條前置知識鏈一起帶回來——回傳結果裡
`isPrerequisite: true` 標記的是「因為依賴鏈被拉進來，不是關鍵字命中」的
節點。`rag_chunk_document` 讓模型自己把一篇長文/大型程式碼拆成一組帶
`dependencies` 關係的節點再批次寫入，是這個記憶系統設計上省 token 的
入口：需要引用長文時，只拉進真正相關的切片＋其前置知識，不用整篇塞回
context。

跟 LRU 淘汰共用同一套規則的還有 `FileCache`（下載檔案的二進位快取）：
用 `Blob` 估算位元組數，超過上限時依 `lastAccessed` 由舊到新刪到 95%
容量以下。

### 批次子任務引擎

見前面「省 token」一節第 3 點。設計上刻意域無關（floating-assistant.js
不認識「股票」），`index.html` 把它包成 `batch_analyze_stocks` 這個
AI_CAPABILITIES 工具，是應用層的事。系統提示詞會教模型「這只適合逐項
獨立判斷（篩選/打分），不適合需要跨項目比較的任務」，讓模型自己決定
要不要用，元件本身沒有額外的防呆機制擋住誤用。

### 自訂工具、AI 自建函式、斜線指令——都沒有沙箱

`register_slash_command()` 註冊的指令**不經過模型**，使用者打出來就在
本地直接執行（`_submitChatInput()` 攔截在送進 `executeChat()` 之前）——
跟 `register_openai_tool()`（模型自己決定要不要呼叫）是完全不同層級的
機制，不要混用。

`advancedSettings.customTools`（使用者用內建編輯器寫的工具）跟
`add_ai_function`/`call_ai_function`（AI 在對話中自己定義、之後可以自己
呼叫的函式）兩者都是透過 `new Function(...)` 在頁面本身的全域環境（有
`window`/DOM/`fetch`）直接執行程式碼——`_validateCustomScript()` 目前是
永遠回傳 `true` 的空殼，沒有做任何實際檢查或沙箱隔離。**只在你信任會
使用這兩個功能的使用者/AI 輸出的情境下啟用它們。**

### `.skill`（zip）匯入匯出

用途是「把一份配置好的助理人設＋自訂工具打包成可攜檔案，在不同安裝/
專案之間分享」——`_exportSkillZip()` 只打包 `SKILL.md`
（= `advancedSettings.rulesMd`，等同自訂系統提示詞規則）跟每個自訂工具
一個 `tools/<name>.js`。**不含** Graph-RAG 節點、對話歷史、AI 自建函式、
或任何 API 金鑰/設定——這些被視為「跟這台裝置/這個使用者綁定」的本機
狀態，不適合打包分享。JSZip 只在使用者真的按下匯入/匯出按鈕時才動態
注入 CDN script，不用這個功能的人不用背這個依賴。

### 持久化層：訊息主體與附帶資料分開存

`this.messages`（實際會送進 API 的陣列）刻意保持精簡；任何「畫面要顯示
但不該送進 API」的資料（AI 產生的圖片、推理過程、檔案下載參照、
benchmark 報告卡片、建議操作 chip）都用非可枚舉屬性掛在對應的訊息物件
上。`_persistChatHistory()` 存檔時，把這些非可枚舉屬性拆進獨立的
side-map（`imageMap`/`reasoningMap`/`fileMap`/`benchmarkReportMap`/
`chipsMap`，用訊息在陣列裡的 index 當 key），跟 `messages`/
`archivedDisplayBlocks` 一起存進同一個 `localStorage` JSON blob；
`_loadPersistedChatHistory()` 讀檔時反向操作，把每個 map 的值重新掛回
對應訊息物件上的同一個非可枚舉屬性。

`fileMap` 本身只存 `{id, filename, mimeType, sizeBytes}` 這種輕量參照，
真正的檔案位元組留在獨立的 IndexedDB `FileCache` 裡——因為 localStorage
容量通常只有 5–10MB，一個 PPTX/PDF 就可能超過，不能真的把二進位內容塞
進同一份 JSON。

### 取樣參數黑名單、模型自動 fallback、`/benchmark-model`

- `_detectRejectedSamplingParam()`/`_disableRejectedSamplingParam()`：
  400/413 不一定代表「上下文太長」，有些端點是直接拒絕某個取樣參數本身
  （例如某些端點不接受 `frequency_penalty`）——如果把這種錯誤誤判成
  「要壓縮上下文」，會陷入「壓縮→還是 400→再壓縮」的無窮迴圈，因為真正
  的成因（參數被拒絕）從來沒被移除。偵測到之後永久記住「這個參數以後
  都不要送」，是單一全域設定（不分端點/模型），使用者可以在設定面板
  手動恢復。
- `_nextAutoFallbackModel(status, currentModel)`：只在使用者**沒有**手動
  指定模型名稱、且遇到 404 時才啟動，依 `PRESET_MODEL_OPTIONS`（依「參數
  量＋穩定度」排序）依序往下試。切換到不同模型會觸發那個模型自己的
  native/text 探測（快取以模型名稱為 key，不會假設沿用前一個模型的判定
  結果）。
- `/benchmark-model`：跑三題測試（回應速度 15%、單一工具呼叫 30%、完整
  多步驟流程跑兩次取平均 55%）幫一個模型/端點打分（≥80 建議加入／≥50
  可用但不穩定／其餘不建議），這個專案內建模型清單的 fallback 順序跟
  `PRESET_MODEL_TOOLCALL_SUPPORT` 表，實務上就是靠這個指令實測出來的。

### 主題系統

`_isLightTheme()` 預設讀 `<html data-theme> !== 'dark'`，但如果宿主頁面
提供 `options.isLightTheme()` 就優先用它（包一層 try/catch，丟例外時退回
預設偵測）——這個 hook 的存在本身就是「這個元件曾經被複製到用不同主題
慣例的專案」的直接證據。`_getThemePalette()` 回傳寫死的淺色/深色兩組
顏色 token 物件，沒有 CSS 變數層——每個渲染呼叫點各自從這裡拿顏色。
`<html data-theme>` 的變化預設用 `MutationObserver` 自動偵測；宿主頁面
用別的主題切換訊號時，必須自己在切換時呼叫公開方法 `refreshTheme()`。
