# 話題偵測與子對話：唯讀調查與設計草案

> 狀態：調查結果（步驟 1–4 有事實依據）＋設計草案（步驟 5，**草案不是結論**）。
> 本文件不改任何程式。行號以 `renderer/src/floating-assistant.js` 為準（以下簡稱「主檔」），工作目錄 `desktop-app/`。
> 「真桌面版量測」＝ `scripts/eval/send_latency.eval.js` 在真 Electron 內跑的結果；「讀程式」＝只看原始碼推測；「沒查」＝未確認。

---

## 0. 摘要（一頁看完）

1. **每則訊息都等的那一步是 `_checkTopicTransition`**（話題過渡判斷）。它在 `executeChat` 裡 `await` 一次主模型呼叫（主檔 102549），而且是**在使用者訊息寫進對話之前**就等。第 3 則訊息起（對話訊息數 ≥ 3，見 95873）每一則都會呼叫一次模型；若判成話題轉移，還會再多一次摘要呼叫（95964）。
2. 「engagement／RAG 話題」的殘留已經不在送出路徑上：RAG 的 `ragSystem.query` 不在送出前呼叫（主檔 102563–102564 的註解與程式確認）。意圖過濾（`_routeTaskIntent`）也不在送出路徑上，它只在模型呼叫 `delegate_to_subagent` 之後才跑（104400–104414）。
3. 子對話目前是「**沒有獨立對話記錄的委派**」：`_runSubAgentTask` 用函式內的區域訊息陣列，結果當成工具結果回到父對話；進度卡片是父對話裡一則 `role:'tool'` 訊息（78104–78106）。沒有子對話的 ID、父子欄位、獨立 UI。
4. 對話清單（側欄）已存在且有索引（`_chatIndex`，79557–79577），但**索引裡沒有 parent／child 欄位**，全專案 grep `parentId|parent_id|parentSession|childSessions` 只命中無關的動畫與 3D 程式碼。
5. 真桌面版量測：假模型立即回覆，第 2 則（換話題）比第 1 則多出一次話題判斷＋一次摘要呼叫，耗時 39.2ms（假模型幾乎零延遲，真實環境的代價＝真實模型往返時間）。第 3 則（拉回）也有一次話題判斷呼叫（17.3ms）。

---

## 1. 步驟 1：送出到第一次呼叫主模型之前的前置步驟

入口：`executeChat(userText)`，主檔 **102415**。被呼叫處：`_chatRunner(ctx).executeChat`（遠端 102415 附近的其他入口見 `remote/rg_dispatch.js:822`、主檔 100133 的送出按鈕路徑）。

| # | 步驟 | 函式／行號 | 呼叫模型？ | 網路？ | 可否關閉／設定開關 | 備註（量測＝真桌面版，讀＝讀程式） |
|---|---|---|---|---|---|---|
| 1 | 還在回應中？變成「插話」(steering)，直接 return | 102416–102419 | 否 | 否 | 無 | 量測／讀：正在回應時送出不走以下步驟 |
| 2 | 重設本輪旗標（寫入證據、帳本、意圖、工具紀錄等） | 102437–102445 | 否 | 否 | 無 | 讀 |
| 3 | 取得主力模型設定 `_getInitialFallbackConfig` | 77194（呼叫 102446） | 否 | 否 | 無 | 量測：0.0–0.3ms |
| 4 | 更新標題的模型名、`_setRespondingState(true)` | 102449–102468 | 否 | 否 | 無 | 讀 |
| 5 | **原生工具呼叫探測** `_ensureNativeToolSupportProbed` | 102475–102477（定義 77695–77716） | 只有快取沒命中且不在內建表時才會打一次探測請求 | 首次可能 | `advancedSettings.toolCallMode`：`native`／`text` 會跳過；內建表 `PRESET_MODEL_TOOLCALL_SUPPORT`（48779）命中就不打網路；結果存 localStorage | 量測：第 1–3 則都只花 0.3ms、沒見探測請求（快取或內建表命中；本次未驗證是哪一種） |
| 6 | **話題過渡判斷** `_checkTopicTransition` | 102549（定義 95871–約 96010） | **是，阻塞式**：訊息數 ≥ 3 時每則一次（95912）；判成轉移再一次摘要呼叫（95964） | 是 | **沒有設定開關**（沒查到；只能在評估檔覆寫） | 量測（見第 2 節）：第 2 則 39.2ms（判斷 ＋摘要），第 3 則 17.3ms。注意：在使用者訊息 push 進 `this.messages` 之前（102576），所以訊息在畫面上要等它回來才出現（讀） |
| 7 | 話題判斷失敗就靜默 return（非 ok、解析不了 JSON 都 return） | 95927、95932 | — | — | — | 讀 |
| 8 | 停止旗標檢查 | 102550 | 否 | 否 | — | 讀 |
| 9 | 外部 `contextProvider` 注入 `[Live Context]` | 102522–102532 | 否（同步） | 取決於外部 | 由宿主提供 | 讀；沒查 provider 內容 |
| 10 | 過濾掉舊的 `[Hermes 歷史記憶喚醒]` 訊息 | 102562 | 否 | 否 | 無 | 讀：只是過濾，不查 RAG |
| 11 | RAG 查詢 | 送出路徑上**沒有**（102563–102564 註解：2026-10-15 起 RAG 不再自動插入） | — | — | `advancedSettings.ragEnabled` 只影響其他路徑（59525、66427、99449、81906） | 讀（grep 102549–102583 之間無 `ragSystem.query`） |
| 12 | 命令歷史寫 localStorage | 102567–102571 | 否 | 否 | 無 | 讀 |
| 13 | 超長貼上文字截斷 `_truncateToolResultForContext` | 102575 | 否 | 否 | 無 | 讀 |
| 14 | 寫入使用者訊息、重新繪製 | 102576–102577 | 否 | 否 | — | 讀 |
| 15 | 進入主迴圈 `_loopFetch` → 原生分流 `_shouldUseNativeToolCalls` | 102583；102637–102646 | — | — | — | 讀 |
| 16 | 每一輪送出前修配對 `_sanitizeToolCallPairing` | 103265 | 否 | 否 | 無 | 讀 |
| 17 | **第一次主模型呼叫** `FaLlm.fetch` | 103279 | **是（主模型）** | 是 | — | 量測：第 1 則 21.4ms 後出現；第 2 則第一個呼叫是話題判斷（0.7ms），主模型在 44.8ms；第 3 則主模型在 20.3ms |
| 18 | 工具清單根層過濾 `_getRootToolNames` → `_intentFilter` | 74735；過濾本體 75596–75611 | 否（純本地詞彙比對） | 否 | `multiSubAgentMode === 'intent'` 才啟用（75595） | 讀；**沒查**是否逐行由 `_getRootToolNames` 內呼叫 `_intentFilter`（只看到函式本體與開關） |
| 19 | 意圖路由 `_routeTaskIntent` ／ `_intentRouteLocal` | 75629–75645 | 路由失敗才走 `_routeTaskToDomains`（會呼叫模型） | — | `multiSubAgentMode === 'intent'` | **不在送出路徑上**：只在 `_delegateToSubagentAutoOnce` 裡（104412–104414），也就是模型已經呼叫 `delegate_to_subagent` 之後 |
| 20 | 能力反思（「叫用 RAG 之後的能力反思」） | 75654 註解；75696 | 沒找到呼叫點 | — | — | 只找到註解，**判定不在送出路徑上**（沒有呼叫點，只靠 grep 判斷） |
| 21 | 歷史壓縮 `pruneContext` | 只在 400／413 之後的反應式路徑（102534–102543 註解） | 是（但不是送出前） | 是 | — | 讀；**沒查**完整呼叫點清單 |
| 22 | 離線訓練器、離線退路 | 102585 之後，只在第一個模型失敗之後 | 否（送出前） | — | `offlineAutoFallback` | 讀 |
| 23 | 記憶（Hermes）、Memory、摘要以外的分類器 | **沒查** | — | — | — | 只查了 `_routeTaskIntent／_intentRouteLocal／_loopFetch(Native)／executeChat／_checkTopicTransition`、RAG 查詢點、`classify／detect／judge` 等名稱中的一部分 |

**結論**：送出前真正會**阻塞、呼叫模型**的只有第 5（首次探測）與第 6（話題判斷）。第 6 是每則訊息都會發生的那一個。

---

## 2. 量測結果（真桌面版）

檔案：`scripts/eval/send_latency.eval.js`（新增，見 commit）。執行：`node scripts/eval/run_eval.js scripts/eval/send_latency.eval.js`。輸出：`[eval-file] result`。
`loadedScripts` 指向工作目錄 `renderer/floating-assistant.js` 與 `renderer/bootstrap.js`。

| 訊息 | 內容 | 話題判斷（阻塞） | 摘要呼叫 | 主模型第一次呼叫（自送出起算） | 全部耗時 | 模型呼叫序列 |
|---|---|---|---|---|---|---|
| 1 | 幫我畫一張貓的圖 | 0.3ms（訊息數 < 3，直接 return，**沒打模型**） | 無 | 21.4ms | 36.7ms | 主模型 |
| 2 | 幫我創作一首音樂（換話題） | 39.2ms（**打模型**，判成轉移） | 有（8.4ms 起） | 44.8ms | 48.0ms | 判斷 → 摘要 → 主模型 |
| 3 | 再畫一張狗（拉回） | 17.3ms（**打模型**，判成沒轉移） | 無 | 20.3ms | 40.1ms | 判斷 → 主模型 |

所有 `err` 皆為 `null`。假模型延遲約 0，所以上表的毫秒數只反映**本機的呼叫鏈開銷**；真實環境每一次模型呼叫會多出真實往返時間。以第 2 則為例，真實環境會等 **兩次**模型往返（判斷＋摘要）才看到使用者訊息，之後才等主模型。

量測說明：
- 只在評估檔裡包裝（`wrapAsync`／`wrapSync`），沒有改來源。
- `_ensureNativeToolSupportProbed` 量到 0.3ms，沒看到探測請求；本次沒分辨是快取命中還是內建表命中。
- 假模型用 `body.messages[0].content` 的特徵字串分辨三種呼叫（判斷、摘要、主模型），這是評估檔內的做法，不代表來源的結構。

---

## 3. 步驟 3：現有「子對話」機制盤點

| 機制 | 位置 | 資料結構 | 存在哪 | 獨立對話記錄／UI？ | 狀態表示 | 等待使用者時怎麼冒泡 | 結果怎麼回主對話 | 能否被使用者打開來看 |
|---|---|---|---|---|---|---|---|---|
| `delegate_to_subagent`（工具） | 主檔 `_delegateToSubagentAuto` 104400；`_delegateToSubagentAutoOnce` 104407；`_delegateToSubagentDomain` 103751／`Inner` 103755 | 工具參數＋`domain`；領域定義在 `this.domains`（`register_domain`） | 記憶體（`this.domains`） | 否：沒有獨立記錄 | 進度卡片（見下） | **沒查清楚**子 agent 能否叫出 `ask_user_card`（工具登記在 61059，不知是否在子 agent 允許清單內） | `subResult` 當成工具結果（104451–104458） | 只能看父對話裡的進度卡片 |
| `_runSubAgentTask` | 主檔 104572（迴圈本體約 104600 以後） | 函式內區域變數（訊息陣列、重試計數、`groupIndex` 等，104596–104609） | 記憶體，函式結束即丟 | 否 | 回傳 `{ text, … }`（呼叫端讀 `.text`，見 105311） | 沒查 | 回傳值 | 否 |
| 進度卡片 `_createSubagentProgressWidget` → `_createProgressWidget` | 主檔 103707–103710；78096–78109 | `{ role:'tool', content:'' }` 並以非列舉屬性 `_progressWidget` 夾帶狀態（title／pct／status／done／error／trace）（78103–78105） | **父對話的 `this.messages`**（78106） | 只是父對話的一則訊息 | `done`／`error`／`status` 欄位 | 不冒泡（它本身就在父對話裡） | 不適用 | 會在畫面上顯示；只有 `showInternalTrace` 為真或 `force` 時才建立（103708） |
| 批次子任務 `runBatchSubAgents` | 主檔 105273 起 | 項目陣列＋併發數（上限 8，105276–105278） | 記憶體 | 否（78456 註解：子任務有自己獨立、用完即丟的訊息陣列） | 沒查完整 | 沒查 | 回傳結果陣列（沒查確切結構） | 否 |
| 技能包／deck 委派（domain 的 `skill_` 前綴） | 主檔 103772–103807 | 同上，`isSkillDomain` 有額外的 Python 橋接深度（103778） | 記憶體 | 否 | 同上 | 沒查 | 同上 | 否 |
| 遠端需求（別台機器交過來的需求） | `remote/rg_dispatch.js:822`；主檔 53458–53463 | 不是子 agent：**會在側欄新增一個對話**（第一則訊息記來源） | 對話索引（第 4 節） | **是**（側欄一個新對話；嵌入式網頁版則把內容包成可展開的框，53463） | 對話的 `running`（53564） | — | 回到那個對話 | 是 |
| 範本 `ask_user_for_input`／表單 | 主檔 78215–78221（說明區） | 表單 `{title, description, choices, fields}` | 畫面 | 不適用 | 等使用者回答 | 直接跳表單（host 端） | 回答當作工具結果 | — |

**對照子對話的需求**（使用者要的是「真的開子對話、可監控、完成或需要使用者回應時往父對話冒泡」）：現有機制**沒有**子對話的 ID、沒有獨立記錄、沒有狀態欄位（只有進度卡片的 `done`／`error`）、沒有「等待使用者」的冒泡路徑（沒查到子 agent 的等待機制）。

---

## 4. 步驟 4：對話（session）本身

| 項目 | 位置 | 內容 |
|---|---|---|
| 索引讀取、建立預設對話 | `_chatListInit` 79553–79577 | `idx = { version:1, currentId, sidebarCollapsed, groups:[], chats:[…] }`（79558） |
| 索引的對話欄位 | 79568 建立時：`{ id, title, groupId, createdAt, updatedAt }`；79687／79697：`touched`（79684 註解）；53564：`shared`；79857：`remote`（`{ fromName, at }`） | **沒有 `parentId`／`childIds`／`kind` 之類欄位** |
| 群組 | `idx.groups`（79574）、`_chatNew(groupId)`（79679） | 群組只是分類，不是父子關係 |
| 新對話 | `_chatNew` 79679；「空對話不重複建立」規則 79683–79697 | 目前對話若沒用過（`!touched` 且沒有內容）就不再建立 |
| 切換對話 | `_chatSwitch` 79668 | 會把舊 ctx 存起來、載入新 ctx |
| 對話 ctx 容器 | `this._chatCtxs = new Map()`（56303）；`this._activeCtx` | 每個對話一個 ctx 物件（messages、archivedDisplayBlocks、topicData、isResponding 等，見 53678、53564） |
| 存放後端 | `_chatBackend()` 79409–79431 | 有 `window.desktopAPI.chats` 就用 `kind:'files'`（api.readIndex／read／write／delete）；否則 `FileCache('FloatingAssistantChats_<suffix>')`（79420）以 `chat-index` 與 `chat:<id>` 為鍵（79426–79427）。**沒查 `FileCache` 底層是否為 IndexedDB**（有 IndexedDB 的程式碼但不確定是不是它） |
| 每個對話的存檔內容 | `_persistChatHistory` 約 106430–106445 | `messages`、`archivedDisplayBlocks`、`topicData`、`terminalMap`、`progressMap`、圖片與推理的 map |
| 載入（非清單模式） | `_loadPersistedChatHistory` 106448 起；`localStorage` 鍵 `floating_ai_chat_history`（56354） | 清單模式（`options.chatList`，56300）時不從 localStorage 載入（106451） |
| 側欄清單呈現 | 79857（列項目、`cl-title`）、79864（依建立時間排序，不因點擊跳動） | 側欄只讀索引 |
| 遠端／分享對話的唯讀狀態 | 53564（`shared`）、53678（回傳 `running`） | `running: !!ctx.isResponding` |

**結論**：對話與對話之間目前是**平的清單**（只有群組），沒有 parent／child。若要做子對話，需要在索引加欄位（例如 `parentId`、`fromTurn`、`status`），並在 `_chatCtxs` 旁邊維持「父→子」關係。

---

## 5. 步驟 5：設計草案（意見，不是結論）

### 5.1 (a) 不要每則訊息都等（偵測改成本地、非阻塞）

- **要改的現有函式**：
  - `executeChat` 102549 的 `await this._checkTopicTransition(userText);` → 改成同步的本地判斷（不 await 模型），或把判斷移到送出之後、與主模型**並行**。
  - `_checkTopicTransition` 95871–約 96010：把「呼叫模型判斷」拆出來；本地版本只做關鍵詞／詞向量相似度，回傳 `{ isShifted, score, matchedTopicId }`。模型判斷改成背景的「校正」，不擋送出。
- **需要新增的資料**：每個對話存一個輕量的「話題指紋」（例如關鍵詞集合或向量，存在索引或對話存檔裡）；`topicData` 已存在（`currentTopic`），可以擴充（`topicData` 出現在 106430 附近的存檔）。
- **風險**：
  - 本地判斷的準確度會低於模型，誤判時的代價要定（誤判成轉移會開出多餘的子對話；漏判會延續舊對話）。
  - 目前 95901 有「判斷有疑慮時一律 isShifted:false」的規則，本地版本要沿用同樣的保守方向或另訂。
  - 「畫圖」與「創作音樂」都是短句，關鍵詞判斷可能失準（使用者實測過的同一類誤判，見 95882–95890 的註解）。
- **要先問使用者的決定**：見第 6 節的問題 1、2。

### 5.2 (b) 話題拉回來要能接回舊的子對話，不當全新話題

- **要改的現有函式**：`_checkTopicTransition` 的 `this.topicData.currentTopic = result.newTopicSummary || newUserPrompt;`（95999）目前只記一個「當前話題」字串，且話題轉移時會把整批 `messages` 換成摘要（95991–95994）＋把舊內容存入 `archivedDisplayBlocks`（95989）。這正是「拉回來也當全新話題」的成因：舊內容只剩摘要，沒有指回原來的記錄。
- **需要新增的資料**：
  - 每個子對話（或話題段）有 `topicId`、`fingerprint`（第 5.1 節的指紋）、`lastActiveAt`。
  - 話題段之間的指向（例如 `archivedDisplayBlocks[i]` 加上 `topicId`），讓拉回時能找到對應的段落。
- **風險**：舊段落要不要完整載入回模型的上下文（token 成本）；摘要與原文的一致性。
- **要先問使用者的決定**：問題 3。

### 5.3 (c) 偵測到新議題時，真正開出子對話（準備交接 → 建立 → 送出 → 監控 → 冒泡）

建議的流程（草案）：

1. **交接內文**：從父對話取「必要的上下文」（第 5.2 節的段落摘要＋使用者的新問題）。可重用現有 `pruneContext` 的摘要規格（95955–95961 的摘要要求：原始意圖、已呼叫的工具與結果、缺什麼）。
2. **建立子對話**：呼叫 `_chatNew`（79679）的變體，新增一筆索引，並寫入 `parentId`（新欄位）。
3. **送出**：在子對話的 ctx 上呼叫 `executeChat`（已有 `_chatRunner(ctx)` 模式，見 rg_dispatch.js:822，可以沿用「對指定 ctx 執行」的做法）。
4. **監控**：父對話需要知道子對話的狀態。草案的狀態欄位：`status ∈ {running, done, waiting_user, failed}`，由子對話的 `isResponding`（53678 已有 `running`）與結束原因推導。
5. **冒泡**：子對話轉 `done` 或 `waiting_user` 時，父對話寫一則 `role:'tool'` 或新的「子對話狀態」訊息（沿用 78104–78106 的 `_progressWidget` 模式即可，不需要新 UI），並在父對話同步顯示。
6. **接回**：使用者說「回到剛才那個」時，依第 5.2 節的指紋找回子對話，`_chatSwitch`（79668）。

- **要改的現有函式**：`_chatNew` 79679、`_chatSwitch` 79668、`_chatListInit` 79553（索引欄位）、`_delegateToSubagentAuto`（104400）與 `_runSubAgentTask`（104572）只需要在「要不要開子對話」的判斷點接上，不必改動它們內部的迴圈。
- **需要新增的資料**：索引欄位 `parentId`、`status`、`topicId`、`fingerprint`；ctx 上的 `childIds`（或由索引反查）。
- **風險**：
  - 子對話的 `executeChat` 會把 `_checkTopicTransition` 也跑一遍（新對話訊息數少，應該只 return，但要確認）。
  - 併發：父子同時 `isResponding` 時，`executeChat` 的插話規則（102416）會把新訊息變成插話，要定義子對話如何接收。
  - 遠端需求也是「新對話」（53458–53463），要避免兩套機制互相覆蓋。
  - 巢狀子對話的深度與成本（每一層都是一整套模型呼叫）。
- **要先問使用者的決定**：問題 4–6。

---

## 6. 要先問使用者的決定（問題清單，**不要自己決定**）

1. **偵測方式**：本地關鍵詞、詞向量（需要哪個模型或資料）、還是「本地先判、模型背景校正」三擇一？誤判的偏好是寧可多開還是寧可少開？
2. **既有的保守規則**（95901「有疑慮就不轉移」）要保留嗎？
3. **拉回的舊話題**：要整段載回模型上下文，還是只載摘要？摘要由誰產生（模型或本地）？
4. **子對話的可見性**：子對話要不要顯示在側欄（和現有對話平級），還是收在父對話底下？
5. **子對話的接收**：使用者在子對話進行中又打字，是插話給子對話，還是問父對話？
6. **遠端需求**（53458）與子對話要不要統一成同一種「子對話」？

---

## 7. 沒查、需要接手者補查的項目

- `_getRootToolNames`（74735）內是否逐行呼叫 `_intentFilter`（只確認函式本體與開關）。
- `pruneContext` 完整呼叫點清單；「記憶」（Hermes）與離線訓練器有沒有送出前的呼叫。
- 子 agent 能否叫出 `ask_user_card`（61059 登記、允許清單是否包含）；子 agent 等待使用者的完整路徑。
- `FileCache`（79420 使用）底層是 IndexedDB 還是其他。
- `runBatchSubAgents` 的回傳結構（105273–105311 之後）。
- 量測沒涵蓋：真實網路延遲、探測請求在第一次真的發生時的耗時、離線模式、`toolCallMode` 為 `text` 時的路徑。

---

## 8. 教訓

- 本次一開始用「分類器」「engagement」等詞在 grep 找步驟，找不到；改用 `executeChat` 的入口往下追才找到 `_checkTopicTransition`。下次先從入口的 `await` 清單往下讀，不要先猜名字。
- 步驟 1 的表有幾列只做了 grep 沒有讀完整函式（列 18、20、21）。已在表內標成「沒查」或「只看到註解」，不要當成已驗證。

---

## 9. 本次改動範圍

- 新增：`scripts/eval/send_latency.eval.js`（評估檔，只包裝、不改來源）。
- 新增：本文件 `DESIGN.TODO.chat-subsessions.md`。
- 未改任何 `renderer/`、`web-lazy/`、`update-manifest.json`、`test-reports/` 或其他檔案。

---

## 10. 使用者的決定（2026-11-04，逐字；以本節為準，取代第 5、6 節的草案選項）

使用者原話（回答第 6 節六個問題）：
1. 「選速度快的方式，誤判寧可多開」
2. 「不用保留」（既有的「有疑慮就不轉移」保守規則不保留）
3. 「如果有開subsession，這還要嗎，建議只有摘要」（有子對話後，拉回舊話題只載摘要）
4. 「預設收在父對話底下」
5. 「問父對話，當他有出現子對話了，可以透過父對話跟子對話溝通，也可以插給子對話，父對話要有一個像是連結的可以點過去子對話。可以在所有對話@對話名稱 來讓父對話知道這是指誰。因為我們有remote，標記對話名稱時，要包含節點名稱」
6. 「統一」（遠端需求與子對話統一成同一種子對話）

原始構想（同日）：「我覺得可以設計成start subsession，準備交接內文，產生子對話，把訊息丟過去，並檢查子對話的狀態，如果子對話完成或者有跳出等待的，就往parent傳遞，parent同步送出來」；「這些話題我的設計是在chat底下設計subsession，但看來應該要真正地做到發出新的子對話，監控子對話會比較好，而且目前會變成監測到新議題，就把舊的縮起來」。

### 10.1 由決定推出的設計（管理層的解讀；有疑問的標「待確認」）

- 偵測：本地、非阻塞、不呼叫模型（關鍵詞或字元片段相似度），結果同步得出；偏向「判成新話題」（誤判寧可多開子對話）。第 1 節表中第 6 步的 `await _checkTopicTransition` 改為本地判斷，不再阻塞送出。
- 開關：沿用 `advancedSettings.topicShiftCheck`（預設 false，commit `6e01d052`），語意改為「偵測到新話題時開子對話」；關閉時完全不偵測。（待確認：使用者是否希望新功能預設開啟。使用者先前說「預設不檢查話題更動」，所以先保持預設關閉。）
- 拉回舊話題：只載摘要，不載整段；本地比對舊子對話的指紋，找得到就把訊息送進那個子對話（不當全新話題）。
- 子對話：真的新對話（有 id、`parentId`、`status`、`topicId`、指紋、摘要），在側欄預設收在父對話底下；父對話裡有可點的連結卡片，點了切到子對話。
- 狀態與冒泡：`status ∈ {running, done, waiting_user, failed}`；子對話完成或需要使用者回應（問題、權限、確認對話框）時，父對話同步顯示並可直接回應。
- 溝通：使用者在父對話打字，預設由父對話處理；子對話存在時，可以透過父對話轉達，也可以直接插給子對話。
- `@對話名稱`：在任何對話輸入 `@` 加對話名稱，讓父對話知道指的是哪個對話。因為有遠端，名稱要含節點名稱（例如 `節點名/對話名`）；需要自動完成與歧義處理（同名時要求更完整的名稱）。
- 統一：遠端需求（`remote/rg_dispatch.js:822`、主檔 53458）改成同一種子對話，帶來源節點名稱。

### 10.2 實作階段（每階段一個 Haiku 工作階段，一次只有一個寫檔者，每階段先寫失敗的測試再修）

| 階段 | 內容 | 驗收（真桌面版評估） |
|---|---|---|
| S1 | 資料模型：索引欄位 `parentId`、`status`、`topicId`、`fingerprint`、`summary`、`nodeName`；對話名稱解析與 `@` 解析的純函式（含節點名稱、同名歧義）；側欄「收在父對話底下」的樹狀呈現 | 手動建立父子對話後側欄樹狀顯示、收合；`@節點/名稱` 解析測試 |
| S2 | 本地快速話題偵測（純函式，不呼叫模型，偏向判新話題），取代 `await _checkTopicTransition`；接上 `topicShiftCheck` | 送出延遲量測：判斷耗時趨近 0、不呼叫模型；換話題與拉回案例 |
| S3 | 開子對話：本地產生交接摘要、`_chatNew` 變體寫入 `parentId`、在子對話 ctx 上 `executeChat`、父對話出現可點連結卡片 | 換話題後側欄出現子對話，連結點擊切換 |
| S4 | 狀態監控與冒泡：`status` 推導、完成或等待時父對話顯示，並可在父對話回應；插話規則（父子同時回應中） | 假模型讓子對話等使用者回答，父對話出現並可回應 |
| S5 | 拉回舊話題：指紋比對現有子對話，找到就送進該子對話（只帶摘要）；`@對話名稱` 輸入與自動完成 | 換話題後拉回，訊息進原子對話 |
| S6 | 統一遠端需求為子對話（帶節點名稱），移除重複機制 | 遠端需求進來後側欄樹狀顯示 |

注意：每一階段完成後都要確認 `topicShiftCheck` 關閉時行為不變（回歸）；全部階段完成並驗證前，管理層不請使用者發布子對話功能。
