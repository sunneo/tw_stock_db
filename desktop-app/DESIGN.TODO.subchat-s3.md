# 子對話 S3（開出真正的子對話）：定位與決定

> 範圍：只做 `DESIGN.TODO.chat-subsessions.md` 第 10.2 節的 S3。S4–S7 不做（不做狀態冒泡、不做拉回舊話題、不做遠端統一、不做批次刪除）。
> 行號以現在的主檔為準（`renderer/src/floating-assistant.js`，編輯來源；`renderer/floating-assistant.js` 是建置產物，不改）。
> 找不到的項目明說。

## 步驟 1：定位（每項附行號）

### 1.1 `executeChat` 對 `this._activeCtx` 的依賴

- `executeChat` 本體：主檔 102503 起。在它的範圍（102503–約 103400）內，**沒有直接寫 `this._activeCtx`**；唯一出現的是 103203 的註解。
- 它透過 `_chatRunner(ctx)` 拿到的代理物件執行，所以 `this._ctx` 會回傳該對話的 ctx（79479–79497，代理的 `get` 攔截 `_ctx`）。
- 畫面相關函式都先判斷 `this._chatIsVisible()`（79474，等於 `this._ctx === this._activeCtx`）：
  - `_setRespondingState`（94987）：背景時不碰 `#ai-response-indicator`（94989）。
  - `_renderMessageHistory`（106715–106717）：背景時只存檔並打未讀標記，不重畫。
- 直接讀 `_activeCtx` 的地方（不在 executeChat 內，但 executeChat 會經過）：`_chatCtxLoad`（79647–79649，暫時借用）、`_chatCtxPrune`（79657）、`_chatActivate`（79664–79673）。這些是切換對話用的，executeChat 不呼叫它們。
- **風險（未處理，回報用）**：executeChat 內若有人新增 `this.xxx` 且該欄位不在 `FA_CHAT_CTX_KEYS`（51009 起），寫入會落在實例上（＝目前顯示的對話）。這是 S2 已寫明的既有風險，S3 不改清單。
- 代理的 `get` 會把 `executeChat`／`_log` 等 bind 過的函式換回原型版本（79488–79491 附近）。S3 新增的方法必須是原型方法（不要在建構子裡 bind），代理才拿得到正確的 `this`。

### 1.2 `executeChat` 的執行順序（與 S3 有關的行）

| 行 | 內容 |
|---|---|
| 102504–102507 | 已在回應中則 `_addSteeringMessage` 並 return |
| 102556 | `this._setRespondingState(true)`（在話題偵測之前就設為回應中） |
| 102637 | S2 的 `if (this.advancedSettings.topicShiftCheck === true) this._localTopicCheck(userText);` |
| 102638 | `if (this.stopRequested) return;` |
| 102664 | `this.messages.push({ role: "user", content: userText });` |
| 102665 | `this._renderMessageHistory();` |
| 102697 | `finally` 內 `this._setRespondingState(false, '', ...)` |
| 102725 | `_loopFetch`（模型呼叫） |

- 因為 102556 已經把 `isResponding` 設為 true，S3 的分支若在 102638 之後 return，**必須自己呼叫 `this._setRespondingState(false, '', 'completed')`**，否則父對話會卡在回應中。
- 決定：S3 的分支插在 102637 之後、102638 之前。

### 1.3 `_localTopicCheck`（S2 產物）

- 定義：95935；內部寫 `this._lastTopicShift`（95935–95960 之間）與 `topicData.fingerprint`、`topicData.pastTopics`。
- `_lastTopicShift = { isShifted, score, matchedTopicId, reason, at }`。

### 1.4 `_chatRunner` 與 `_chatCtxNew`

- `_chatCtxNew(id)`：79456–79468。新 ctx 欄位包含 `messages`、`topicData: { currentTopic: '無（新對話開始）' }`、`isResponding`、`runner: null` 等。
- `_chatRunner(ctx)`：79479–79497。Proxy；`FA_CHAT_CTX_KEYS`（51009 起）的鍵讀寫落在 ctx；其餘落在實例。`topicData` 在 `FA_CHAT_CTX_KEYS` 內（51012 起）。
- `_chatCtxPrune`（79655–79661）：背景且沒在跑、沒未讀、沒等待的 ctx 會從 `_chatCtxs` 移除（內容已存檔）。子對話 ctx 跑完後會被這樣移除，之後由 `_chatCtxLoad`（79639）重讀，所以 S3 不需要額外保留記憶體。

### 1.5 建立對話 `_chatNew`（S1 已擴充）

- 定義：79702。簽章 `_chatNew(groupId = null, opts = null)`。
- `opts.parentId` → `forChild`（79705）：跳過「空對話不重複建立」（79711 起）。
- 寫入索引：建立 `entry` 在 79721，`parentId` 在 79722，`nodeName` 在 79723。
- **問題**：79729 `this._chatActivate(ctx)` 會把畫面切到新對話。S3 的決定是「不自動切換」，所以 `_chatNew` 需要新增 `opts.noActivate`（S3 會加，預設不傳行為不變）。
- 設計：不另寫 `_chatNewChild`，改用既有的 `_chatNew(groupId, { parentId, nodeName, noActivate: true })`。

### 1.6 `_chatSwitch`（連結卡片點擊的目標）

- 定義：79690–79699。條件：`_chatListReady`、不是目前對話、沒在切換中。流程：`_flushChatWrite` → `_chatCtxLoad(id)` → `_chatActivate(ctx)` → `_saveChatIndex`。
- 作用：把畫面切到指定對話（沒有 ctx 則從存檔讀）。連結卡片的點擊會呼叫它。

### 1.7 進度卡片的建立、存檔與還原

- 建立：`_createProgressWidget(title)`：78104 起。訊息是 `{ role: 'tool', content: '' }`（78111），`_progressWidget` 是非可列舉屬性（78113），推入 `this.messages`（78114）。
- 存檔：`_persistChatHistory`（106391 起）。進度卡片的狀態另存一份（106464–106470），重新載入後以 `_progressWidget` 還原（106570）。
- 顯示型別的參考模式：`_pushDisplayToolMessage(note, prop, value)`（53907–53911）用 `_buildToolResultMessage('display', …)`（78592）建立 `role:'tool'` 的訊息，`prop` 是非可列舉屬性。
- **決定**：連結卡片沿用 `_pushDisplayToolMessage` 的 `role:'tool'`＋`display` 結構，但把連結資料放在**可列舉**的 `_subchatLink` 欄位（`{ childId, title }`）。理由：非可列舉屬性不會被 `JSON.stringify` 存檔，重新載入後連結會消失；可列舉欄位會隨 `messages` 一起存檔。（待確認：送給模型的 API 組裝是否會把這個欄位帶出去。步驟 4 的評估要驗證。）

### 1.8 遠端與 `rg_dispatch.js` 的位置（修正設計文件的錯誤行號）

- `remote/rg_dispatch.js:822` 是「把遠端訊息送進**既有**對話」的 `executeChat` 呼叫（S1 已指出，設計文件原寫的「建立」是錯的）。S3 不碰遠端。
- 主檔的 `_chatRunner(ctx)` 用法範例：53474–53476（建立 ctx 後 `this._chatRunner(ctx)`）、53714（對指定 ctx 呼叫 `executeChat`）。S3 沿用這個寫法：`this._chatRunner(childCtx).executeChat(newText)`。

### 1.9 索引與存檔

- `_chatIndex`、`_chatEntry(id)`：79511。
- `_saveChatIndex()`：79506。
- `_chatMarkUnread(ctx)`：79500（背景對話有新內容時打未讀標記）。

### 1.10 找不到的項目

- 「子對話完成時的狀態更新」：沒有既有 hook。S3 的做法：在建立子對話時，對子對話 `executeChat` 回傳的 Promise 掛 `.then`／`.catch`，更新索引的 `status`，再 `_renderChatList()`。不改 executeChat 本體的 `finally`。
- `_getFinalSystemPrompt()`：76024（子對話建立時用來補 system prompt，因為 executeChat 只在 `messages.length === 0` 時才建立）。

## 決定（S3 內）

1. **觸發條件**：`advancedSettings.topicShiftCheck === true` 且 `_lastTopicShift.isShifted === true` 且 `matchedTopicId` 為空，且目前對話本身**不是**子對話（索引沒有 `parentId`，防止子對話再開子對話）。`matchedTopicId` 有值時照舊在父對話處理，留給 S5。
2. **插入點**：102637 之後、102638 之前。
3. **父對話**：使用者訊息照常推入 `this.messages`（102664 的寫法）並重繪；不呼叫父對話模型；推入一則連結卡片；`_setRespondingState(false)`。
4. **子對話建立**：`_chatNew(null, { parentId, nodeName: '', noActivate: true })`。子對話標題＝`buildHandoff` 產生的標題（新訊息前 20 字）。`status = 'running'`，`summary` 寫交接摘要。
5. **子對話的 ctx**：用 `_chatRunner(childCtx)`。先設定 `messages = [最終 system prompt, 交接 system 訊息]`，`topicData.fingerprint = fingerprintOf(newText)`（以新訊息初始化，避免子對話再判轉移）。之後 `executeChat(newText)` 會推入使用者訊息並呼叫子對話自己的模型。
6. **子對話 executeChat 不再開子對話**：由「目前對話有 `parentId` 就不開」的條件擋住（見上）。
7. **狀態**：`running` → `done`（executeChat 的 Promise resolve）或 `failed`（reject）。`waiting_user` 與冒泡屬 S4，不做。
8. **不自動切換畫面**：`noActivate` 讓 `_chatNew` 不呼叫 `_chatActivate`。

## 驗證計畫

- 步驟 2：`node renderer/src/chat/handoff.test.js`。
- 步驟 3：`scripts/eval/subchat_open.eval.js`（假模型，真 Electron）。先在修前證明：索引沒有子對話、父模型呼叫數不對。
- 步驟 4：點擊卡片、存檔還原、側欄樹狀。
- 步驟 5：開關關閉回歸；`topic_local.eval.js`、`chat_tree.eval.js`、`chat_tree_index.eval.js`、`read_ledger.eval.js` 重跑。

## 步驟 2–5 結果

- 步驟 2（`2b62a0f4`）：`renderer/src/chat/handoff.js` 與 `handoff.test.js`，`node renderer/src/chat/handoff.test.js` 12 項全過。
- 步驟 3（`bb025243`）：
  - 嵌入：`scripts/embed-code-ui.js` 新增 SUBCHATHANDOFF 區塊，主檔加 `SUBCHATHANDOFF-BEGIN`／`END` 標記，`scripts/build-web-lazy.js` 的 EXCLUDE 加入 `SUBCHATHANDOFF`（與 TOPICLOCAL 相同，留在網頁版核心）。
  - `_chatNew`（主檔約 79705）新增 `opts.title`、`opts.status`／`summary`／`fingerprint`（只在 `parentId` 時寫入）、`opts.noActivate`（不切換畫面），並改為回傳新對話 id。
  - `_subchatOpenFor(userText)`（主檔約 95974 起）：由 `executeChat` 在推入使用者訊息之後呼叫（主檔約 102716）。`_lastTopicShift` 加入 `FA_CHAT_CTX_KEYS`，讓父子各自一份。
  - 連結卡片：`_buildToolResultMessage('display', …)`，`_subchatLink` 為可列舉屬性；`_renderSingleMessageInner` 最前面加分支（約 107046 起）。
  - 評估 `scripts/eval/subchat_open.eval.js`（換埠 17962）：修前 `onOneChild`、`onChildCalledModel`、`onParentCallsFirstTwoOnly` 等 9 項不成立（父對話三則都呼叫模型）；修後 18 項全過（`allPass: true`），`loadedWorkdirImpl` 修前 false、修後 true。
- 步驟 4（`68bb3452`）：`scripts/eval/subchat_link.eval.js`（換埠 17963）14 項全過：停留父對話、點「打開」切到子對話、切回後按鈕還在、JSON 往返保留連結、從存檔重讀後按鈕仍在且可點、側欄樹狀預設收合、點開關出現子對話列、點開關不切換。
- 步驟 5：開關關閉的回歸由 `subchat_open.eval.js` 的關閉段證明（沒有子對話、沒有連結卡片、每則一次父對話呼叫）。既有評估：
  - `topic_local.eval.js`：`allPass: true`（13 項）。
  - `chat_tree.eval.js`：全部判準為 true（其中 `shape_after_delete` 是字串記錄，不是判準）。
  - `chat_tree_index.eval.js`：各欄位符合預期，沒有 false。
  - `read_ledger.eval.js`：**沒有內建的通過／失敗判準**，只印出修前修後的數值。數值與設計方向一致（例如 C_stubborn `warned: true`，修後 D／E 的 `reminders_in_request` 為 0），但這是人工判讀，不是機器判定，回報時不算通過。

## 驗證範圍（誠實列出）

- 真桌面版驗證過：送出流程的父子模型呼叫歸屬、子對話索引欄位（`parentId`、`title`、`status`）、子對話訊息（交接 system、使用者訊息、回覆）、父對話不呼叫模型、連結卡片的點擊與存檔重讀、側欄樹狀、關閉時的回歸、修前修後對照。
- 只有 node 測試：`handoff.js` 的標題與交接規則（12 項）。
- 沒驗證：
  - 連結卡片（`role:'tool'` 的 display 訊息）在父對話**下一則**送出時，是否被送進模型請求。`_buildToolResultMessage` 會補 `tool_call_id`（主檔約 78637），但沒有 assistant 的 `tool_calls` 前導，不確定模型端是否接受。既有的 `_pushDisplayToolMessage` 走同一條路，屬既有行為，本次沒有單獨測。
  - 真實的遠端需求、拉回舊話題（S5）、狀態冒泡（S4）都沒碰。
  - 真實模型的回覆品質與交接摘要的內容品質。

## 風險（給 S4–S5 接手者）

1. **`executeChat` 對 `this._activeCtx`**：executeChat 本體沒有直接寫 `_activeCtx`，所有畫面路徑都先看 `_chatIsVisible()`。但 executeChat 可達的方法若新增了寫入、且欄位不在 `FA_CHAT_CTX_KEYS`，會寫到實例上（＝目前顯示的對話）。S3 只新增 `_lastTopicShift` 進清單，其餘沒有審查。
2. **子對話 status 只有 done／failed**：`finish` 以 executeChat 的 Promise 結束為準。executeChat 內部模型失敗（`_otAllModelsFailed`）時仍會 resolve，所以會標成 done。S4 的 `waiting_user` 與冒泡要改成讀真正的結果。
3. **應用程式中途關閉**：子對話的 `status` 可能停在 `running`，沒有重啟後的修復。
4. **`_lastTopicShift` 只在父對話的執行中被讀**：`_subchatOpenFor` 在同步區段內讀取，所以父子並行不會誤讀；但若將來有人在 await 之後才讀，會讀到子對話寫的值。
5. **`_chatNew` 的 `forChild` 路徑跳過空對話檢查**：同一個父對話連續三則新話題，會開三個子對話（沒有去重）。這是預期（每個新話題一個子對話），但 S5 拉回時要用指紋比對，避免重複。

## 教訓

1. **背景執行的呼叫會被記到前一輪**：`subchat_open.eval.js` 第一次跑，`onParentCallsFirstTwoOnly` 失敗。原因是子對話的模型呼叫在父對話 `executeChat` 回傳前就發出，所以被記到父對話第三則那一列。修正是只數「不帶交接內文」的呼叫（父對話），子對話的呼叫另外用 `onChildCalledModel` 證明。這是記錄歸屬的修正，不是放寬判準；修前版本仍然 `onChild*` 全不成立。下次：評估要判斷「是誰的呼叫」時，用請求內容的特徵分辨，不要用時間順序。
2. **`_chatNew` 預設會切換畫面**：要 `noActivate` 才能留在父對話。也因此 `_chatNew` 改成回傳 id，之後呼叫方不必再找「最後一筆」。
3. **狀態欄位要進 `FA_CHAT_CTX_KEYS`**：`_lastTopicShift` 原本不在清單內，父子共用同一份。S2 的教訓（新增狀態要查所有重設點）在這次又適用：`_clearChatHistory` 要不要清 `_lastTopicShift`，目前沒有處理（它只在下一則訊息前被重新寫入，風險低，但要記住）。
4. 寫入主檔後跑 `scripts/embed-code-ui.js` 會重寫所有嵌入區塊；提交前用 `git diff --stat` 確認只有自己的變更（本次確認過，只有 `renderer/src/floating-assistant.js` 的 81 行與嵌入一行）。
5. 建置前先把 `renderer/floating-assistant*.js`、`update-manifest.json`、`web-lazy/`、`test-reports/` 備份到 scratchpad；修前對照時把備份的建置換進去跑評估，之後把新建置放回（先用 `cp` 另存一份當作新建置）。
