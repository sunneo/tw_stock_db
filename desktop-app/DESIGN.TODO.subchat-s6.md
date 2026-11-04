# 子對話 S6：遠端需求統一成子對話

> 範圍：只做 `DESIGN.TODO.chat-subsessions.md` 第 10.2 節的 S6。**S7（批次刪除）不做。**
> `ask_user_card` 的根層級歸類（`d12293d1`，S4b）沒有改、沒有依賴。
> 行號以 2026-11-04 的來源為準：主檔 `renderer/src/floating-assistant.js`（編輯來源；`renderer/floating-assistant*.js` 是建置產物，不提交）與 `renderer/src/remote/rg_dispatch.js`。

## 使用者的決定（照 `chat-subsessions.md` 第 10 節，逐字）

- 第 6 點：「統一」（遠端需求與子對話統一成同一種子對話）。
- 第 5 點：「因為我們有remote，標記對話名稱時，要包含節點名稱」。

管理層的設計決定（本階段依此實作）：遠端需求沒有「發出它的本機父對話」，所以建立**虛擬的收件對話**當父對話，每個來源節點一個，標題「遠端需求 · 〈節點名〉」，索引欄位 `kind:'remote-inbox'`、`nodeName`。

## 步驟 1：定位（本文件）

### 1.1 行號對照

`rg_dispatch.js` 與主檔內嵌的同一段程式行號差 **52898**（例如 `rg_dispatch.js:580` ↔ 主檔 `53478`，已 Grep 驗證；`rg_dispatch.js:533` ↔ 主檔 `53431`）。以下以主檔為準，括號內是 `rg_dispatch.js` 行號。

**注意**：舊的交接文字寫「`remote/rg_dispatch.js:822` 是遠端需求建立對話」，**不對**。`rg_dispatch.js:822` 其實是「分享對話的接著對話」`_rgOnChatSay` 裡的 `executeChat('[來自 … 的遠端訊息]…')`（主檔 53720）。真正建立遠端需求對話的是 `rg_dispatch.js:580–581`（主檔 53478–53479）。

### 1.2 建立遠端需求對話的全部路徑

| # | 位置 | 做什麼 | 寫入的欄位 | 備註 |
|---|---|---|---|---|
| A | 主檔 `_rgRunTask` 約 53431（rg 533） | `job.chatCtx = await this._rgCreateRemoteChat(job)`，之後 `_setRespondingState(true, '⏳ 遠端需求…')` | — | 這是「收到需求」的入口；`job.sub` 為真（子任務）直接不建對話（53474） |
| B | 主檔 `_rgCreateRemoteChat` 53473–53486（rg 575–588） | **唯一建立路徑**：`_chatNewId('c')`、`_chatIndex.chats.push({…})`，`_chatCtxNew` + `_chatCtxs.set`，寫第一則記錄，再 `user` 訊息＝需求原文，`_persistChatHistory`，`_renderChatList`，`_saveChatIndex`，`_rgPushChats` | 索引：`id, title('來自 〈來源〉：…'), groupId:null, createdAt, updatedAt, touched:true, shared:true, nodeName:job.fromName, remote:{fromName, fromId, taskId, at, fp}` | **不經過 `_chatNew`**：直接 push 索引，所以沒有 `parentId`、`status`、`topicId`、`fingerprint`、`summary` 欄位（只有 S1 補齊 null） |
| C | 主檔 53476（rg 578） | 嵌入式網頁版（`!this._chatListEnabled` 等）：不建對話，`job.chatInline = true`，結果回來用 `_rgRecordInline` 包成可展開的 `<details>` 框記在目前對話 | — | 這條路徑**保持不變**（沒有對話清單，不能有收件對話） |
| D | 主檔 `_rgRecordInline` 53520–53531 | 同上 C，把整份結果包成 `<details>` | — | 不動 |
| E | 主檔 `_rgChatRecord` 53487–53501（rg 589–603） | 結果回來寫進 `job.chatCtx` 那個對話（完成／停止／失敗） | 會更新 `en.updatedAt` | 這裡的 `run._setRespondingState(false, '', 'completed'|'stopped')` 會決定 `status` 的終態，S6 要把它改成同時更新子對話的 `status` |
| F | 主檔 `_rgLoadPending` 53542–53551 | 重新載入後接續等待中的任務：`p.chatId` 有效就用那個對話的 ctx | — | 子對話化後 `chatId` 會是子對話 id，行為相同 |

**沒有其他地方建立遠端對話**（Grep `_chatIndex\.chats\.push` 與 `_chatNewId\(` 全檔）：只有 `_chatNew`（79800）、`_chatListInit` 補預設對話（79667、79676）、清單空白補一個（79846–79847）、群組（79877）、以及 B。

### 1.3 讀取 `remote` 欄位的地方（Grep `\.remote\b`、`fromName`，精準搜尋）

| 位置 | 讀什麼 | 依賴「遠端對話是一般根對話」？ |
|---|---|---|
| 主檔 79972 `_renderChatList`／`chatEl` | `c.remote ? '🌐 '` 前綴、`t.title` tooltip 讀 `c.remote.fromName`、`c.remote.at` | **是**：顯示的前綴與 tooltip 直接讀 `c.remote`。子對話化後，子對話列要保留「🌐」與來源，但父層（收件對話）不應有 `remote`。要改成依 `nodeName` 或子對話 `remote` 判斷 |
| 主檔 80112 右鍵選單 | `entry.remote` → 文字「📡 取消分享（遠端需求對話）」 | 是（只影響文字） |
| 主檔 100545 `row.textContent = it.label + (it.remote ? '（遠端）' : '')` | `@` 自動完成的候選列（`it` 來自 `listMentionCandidates`，不是 `c.remote`） | 不是讀 `c.remote`，是讀 `chat_tree` 的 `remote` 布林（`candidateOf`，`chat_tree.js:177`） |
| 主檔 `chat_tree.js:148` `isRemoteChat` | 讀 **`nodeName`**，不讀 `remote` | 不依賴 `remote`；但會把 `nodeName ≠ selfNodeName` 的對話當遠端（`selfNodeName` 目前沒有被傳入，見 1.5） |
| 主檔 `_rgSharedList` 53574–53577 | 只挑 `c.shared` 的對話送給群組（`chats` 訊息）；遠端需求對話 `shared:true`，所以會被分享出去 | 是：收件對話若不設 `shared`，就不會被分享；子對話要分享與否要想清楚（見 1.6） |
| 主檔 `_rgOnChatSay` rg 804 | 接著對話要求 `en.shared` | 同上 |
| 主檔 `_chatNew` 79806 | `opts.nodeName` 寫入索引（S1 已有） | 已存在，S6 直接沿用 |
| `renderer/src/chat/chat_tree.test.js:11,18` | 測試 `remote:{fromName:'X'}` → 遷移後 `nodeName` 為 null | 測試固定了「舊格式 `remote` 不會自動變 `nodeName`」，S6 要改這個行為時要同步改測試（見步驟 2） |

### 1.4 依賴「遠端對話是一般根對話」的地方（清單）

1. **側欄**：`flattenTree` 把沒有 `parentId` 的當根（`chat_tree.js` 107–135）。舊遠端對話（有 `remote`、沒有 `parentId`）目前全部是根，會平鋪在側欄。S6 要在載入時遷移（`migrateRemoteChats`，步驟 2）。
2. **`_renderChatList` 的 sig**（79953）只看 `c.parentId`，遷移後要重算（會自動，因為 sig 含 `parentId`）。
3. **`@` 解析**：`resolveMention` 的 `isRemoteChat` 讀 `nodeName`。舊遠端對話有 `remote` 但沒有 `nodeName` 時，**不會**被當遠端（`nodeName` 為 null）。所以 `migrateRemoteChats` 要用 `remote.fromName` 補 `nodeName`（使用者的決定與步驟 2 都要求這個）。
4. **`_subchatChildCandidates`**（96052）：只找 `c.parentId === 目前對話`。遠端子對話掛在收件對話底下，所以當收件對話是「目前對話」時候選是子對話，但收件對話**不呼叫模型**（管理層決定），不會走到話題判斷。
5. **`_subchatToolTarget`**（74802–74807）：`e.nodeName` 有值 → 回「遠端對話不能用這個工具（遠端子對話之後的版本才支援）」。S6 要決定：遠端子對話是否允許 `chat_send_to_child`。**建議保留拒絕**（遠端子對話的訊息要經過群組傳輸，不在 S6 範圍）；寫進步驟 4 的已知缺口。
6. **`_rgCreateRemoteChat` 的 `touched:true`、`shared:true`**：收件對話與子對話是否要 `shared`，見 1.6。
7. **`_chatCtxPrune`**（79736）、`_chatActivate`（79745）：收件對話沒有 ctx 也能被切換嗎？`_chatSwitch` 會 `_chatCtxLoad(id)`，收件對話有 id 就能建 ctx，但它沒有訊息；步驟 3 要讓收件對話開啟時只顯示說明卡片與子對話連結卡片（不是空白）。
8. **`_chatDelete`**（79820）：刪父對話時子對話目前怎麼處理（S1–S5 已有行為，沒改）。收件對話被刪會孤立子對話（S1 規則：孤兒提升為根，`chat_tree.js` 14）。這是已知行為，S6 不改。
9. **`_rgPushChats`／群組分享**：群組其他成員看到的是 `shared` 對話清單（53574）。收件對話不應該出現在別人的清單裡（它沒有內容）。**建議：收件對話 `shared:false`，子對話 `shared:true`**（與目前「每個遠端需求對話都 shared」的行為一致）。待確認項：子對話的 `parentId` 會不會讓別人端的清單顯示錯，見步驟 3 的檢查。

### 1.5 `selfNodeName` 的來源（先查清楚，不確定的明說）

`chat_tree.js` 的 `isRemoteChat(c, selfNodeName)` 需要「本機節點名」。Grep 主檔 `resolveMention(` 與 `listMentionCandidates(` 的呼叫點：`_mentionPrepare`（100504 附近）與 `_mentionMenuInit`（100529 附近）。**沒查**這兩處傳進去的 `selfNodeName` 是哪個值（是 `rg.room.self.name` 還是空字串）。若是空字串，`isRemoteChat` 會把所有 `nodeName` 非空的對話都當遠端，這對本機對話（沒有 `nodeName`）沒有影響。**步驟 4 要先查這個值**。

### 1.6 嵌入的網頁版與 `_chatListEnabled`

主檔 53476 的判斷 `!this._chatListEnabled || !this._chatIndex || !this._chatListReady`：沒有對話清單（嵌入網頁版）時走 C／D 的 `<details>` 路徑。**S6 不改這條路徑**，所以嵌入網頁版的行為不變（符合使用者「不要動」的範圍）。是否能在評估裡跑到這條路徑：**沒驗證**，若要驗證要用沒有對話清單的建置，列為步驟 3 的缺口。

## 2. 現在的資料流（摘要）

```
rg_dispatch 收到 task(sub=false)
  → _rgRunTask（主檔 ~53431）
     → _rgCreateRemoteChat（主檔 53473）
          push 索引 {nodeName, remote:{…}, shared:true}   ← 平的根對話
          _chatCtxNew + user 訊息（需求原文）
     → 執行（_runSubAgentTask 或 _rgRunSlash）
  → _rgChatRecord（主檔 53487）
     → 寫結果、_setRespondingState(false, …, 'completed'|'stopped')
```

## 3. S6 的目標資料流（管理層決定）

```
rg 收到 task(sub=false, fromName=N)
  → 找或建「收件對話」：索引 {kind:'remote-inbox', nodeName:N, title:'遠端需求 · N', parentId:null, shared:false}
  → _chatNew(null, {parentId: 收件id, nodeName: N, status:'running', …})   ← 子對話
  → 第一則訊息＝來源記錄＋需求原文（與現在相同）
  → 執行、_rgChatRecord 寫結果，status 照 S4 狀態模型更新（done／failed）
  → 等使用者回應時，連結卡片冒泡到收件對話（沿用 S4／S4b 的 _subchatAnswer）
```

## 4. 路徑清單與驗證方式

| 路徑 | S6 怎麼處理 | 能否在評估跑 | 備註 |
|---|---|---|---|
| A、B（建立） | 改成收件對話＋子對話 | 能（假 LLM 不需要真的遠端；要模擬 `_rgCreateRemoteChat` 的呼叫） | 步驟 3 評估 |
| C、D（嵌入網頁版） | **不改** | **沒驗證**（需要沒有對話清單的建置，本次不做） | 列為缺口 |
| E（結果回寫） | 加上子對話 `status` 更新 | 能（評估檢查 `status`） | 步驟 3 |
| F（重新載入接續） | 不改（`chatId` 指向子對話即可） | 沒驗證 | 列為缺口 |
| 遷移（舊 `remote` 欄位） | 新增 `migrateRemoteChats` | 能（純函式 node 測試＋評估的舊格式索引） | 步驟 2、3 |

## 5. 步驟 2：純函式（已完成）

- 模組：`renderer/src/chat/remote_inbox.js`（UMD，同 `chat_tree.js`）。測試：`renderer/src/chat/remote_inbox.test.js`，16 項，`node renderer/src/chat/remote_inbox.test.js` 全過。
- 函式：`inboxIdFor`、`findInbox`、`makeInboxEntry`、`ensureInbox`（只建一次，回傳新陣列不改原陣列）、`attachRemoteChild`（回傳 `parentId`、`nodeName`、已確保存在的 `chats`、`created`）、`migrateRemoteChats`（只處理有 `remote` 欄位、沒有 `parentId` 的對話；節點名先用 `nodeName`，沒有才用 `remote.fromName`；只補 `parentId` 與缺的 `nodeName`；冪等）。
- 既有 `chat_tree.test.js` 仍全過（22 項）。`chat_tree.test.js:18` 測的是 `normalizeChatEntry` 不改 `nodeName`，本步驟沒改那個函式，所以不衝突。
- **尚未嵌入主檔**（`scripts/embed-code-ui.js` 還沒加 `REMOTEINBOX-BEGIN/END`，主檔還沒有 `FA_REMOTE_INBOX_SRC`）。這是步驟 3 的事。
- 收件對話索引欄位：`kind:'remote-inbox'`、`nodeName`、`parentId:null`、`shared:false`、`status:null`、`touched:true`。

### 步驟 2 的教訓

- **還沒到 30% 就回報「需要接手」，錯在把「這一輪做不完」當成交接理由。** 下次怎麼做：未到 30% 一律繼續做完全部步驟；交接只在上下文真的到 30% 時才做。

- 測試裡每次呼叫都建新的 id 產生器，同一次測試內會得到重複 id（`in1`），測試就紅了。同一個測試的多次呼叫要共用一個產生器。

## 6. 步驟 3 起的待辦（交接用）

1. `scripts/embed-code-ui.js`：加 `embed('renderer/src/chat/remote_inbox.js', 'REMOTEINBOX-BEGIN', 'REMOTEINBOX-END', 'FA_REMOTE_INBOX_SRC')`（參照 `chat_tree.js` 66–67 行的寫法）；`scripts/build-web-lazy.js` 的 EXCLUDE 要查（`chat_tree` 的 `CHATTREE` 是否已在 EXCLUDE，照它的做法）。
2. 主檔：在 `_chatTreeMod()`（79527）旁加 `_remoteInboxMod()`（同 79528 的 `new Function` 寫法）。
3. 改 `_rgCreateRemoteChat`（主檔 53473–53486）：用 `ensureInbox` 找或建收件對話（建立要 `this._chatIndex.chats` 寫回並存檔），再用 `_chatNew`（79783）的 `opts.parentId`／`opts.nodeName`／`opts.status`／`opts.summary`／`opts.fingerprint`（已存在，79802–79806）或同等的 push 建子對話；第一則訊息與來源記錄保持原樣；子對話的 `remote` 欄位保留（側欄前綴 79972 讀它）。注意 `_chatNew` 會 `_chatActivate`，遠端收到需求時**不能**切走使用者的畫面，要用 `noActivate:true`。
4. 載入索引時（`_chatListInit` 79673–79674 之後）呼叫 `migrateRemoteChats`，寫入 `idx.chats`。
5. `FA_CHAT_CTX_KEYS`（51009 起）：S6 目前沒有新增 ctx 狀態欄位，若新增要進去並查重設點。
6. 評估：`scripts/eval/subchat_remote.eval.js`（新檔），參照 `scripts/eval/subchat_pullback.eval.js` 的寫法（真 Electron、換埠、假 LLM）。先證明修前不成立（修前：遠端需求是根對話、沒有收件對話）。

## 6.5 步驟 3：接進建立路徑（已完成，真桌面版驗證過）

改動（照 6 節待辦）：

- `scripts/embed-code-ui.js`：新增 `embed('renderer/src/chat/remote_inbox.js', 'REMOTEINBOX-BEGIN', 'REMOTEINBOX-END', 'FA_REMOTE_INBOX_SRC')`。主檔 `renderer/src/floating-assistant.js` 在 `SUBCHATSTATUS-END` 後面放了標記區塊（先放空字串，嵌入後自動填入）。
- `scripts/build-web-lazy.js`：EXCLUDE 加 `REMOTEINBOX`（與 `CHATTREE` 相同，留在網頁版核心，因為遠端需求邏輯在核心）。
- `renderer/src/floating-assistant.js`：
  - `_remoteInboxMod()`（`_chatTreeMod` 旁，用 `new Function` 載入 `FA_REMOTE_INBOX_SRC`）。
  - `_chatListInit`：`normalizeChats` 之後呼叫 `migrateRemoteChats`（載入時遷移舊索引，之後由 `_saveChatIndex` 寫回）。
- `renderer/src/remote/rg_dispatch.js`（來源；主檔的 REMOTE 區塊由 `embed-code-ui.js` 內嵌）：
  - `_rgCreateRemoteChat`：`ensureInbox` 找或建來源節點的收件對話（只建一次，不切換畫面、不呼叫模型）；子對話寫入 `parentId`、`nodeName`、`status:null`，之後 `_subchatSetStatus(id,'start')`。第一則訊息與來源記錄不變。
  - `_rgChatRecord`：結果回寫時，子對話狀態 done→`finish`，failed／rejected→`error`（原因＝錯誤字串），stopped→`error`（原因「已停止」）。
- `scripts/eval/subchat_remote.eval.js`（新檔）：模擬兩個節點各一需求再加一個，以及舊格式索引遷移。

建置：`node scripts/embed-code-ui.js && node build-assistant.js`（後者會連帶跑 `build-web-lazy`，產生的 `web-lazy/*`、`renderer/floating-assistant*.js`、`update-manifest.json` 都**沒有提交**）。建置前的備份在 scratchpad `bak/`。

### 評估結果（真桌面版，換埠 17966 修後／17967 修前，假 LLM）

- 修後：`allPass: true`，20 項全過。事實：收件對話 2 個（B機、C機）；B機 2 個子對話（標題「來自 B機：寫一首詩」「來自 B機：寫一首短歌」）、C機 1 個；子對話 `status` 全為 `done`；建立時 `currentId` 不變；沒有模型呼叫；側欄收件對話列 `childCount:2`、收合時子對話不出現在扁平清單；舊格式 `D機` 遠端對話遷移後 `parentId` 指向 D機收件對話、`remote` 欄位不變。
- 修前（建置前的 `renderer/floating-assistant.js` 備份）：`allPass: false`，多數判準失敗（`hasRemoteInboxMod`、`inboxOnePerNode`、`noRootRemoteChats`、`sidebarDomHasInbox`、`migrateOldRemoteUnderInbox`、`loadedWorkdirImpl` 等）。
- **空真注意**：修前 `childNodeName`、`childStatusDone` 為真，原因是修前沒有任何子對話，`every` 在空陣列上為真。這兩項在修前沒有證明力，修後的結果才是有效證據。

### 步驟 3 沒有驗證的

- 沒有真的遠端節點對真的需求（用 `_rgCreateRemoteChat`／`_rgChatRecord` 模擬 `_rgRunTask` 的兩個呼叫）。
- 沒有經過 `_rgRunTask` 的完整流程（排隊、閘門、執行）。
- 嵌入式網頁版路徑（沒有對話清單，走 `_rgRecordInline`）沒有驗證，行為理論上未變（程式未改），但沒有證據。
- 收件對話被點開時的畫面（目前會顯示一般空對話的建議卡片）是步驟 4 的工作，尚未處理。

## 6.6 步驟 4：冒泡與 `@`（已完成，真桌面版驗證過）

改動：

- `renderer/src/remote/rg_dispatch.js`：`_rgCreateRemoteChat` 建立子對話後，呼叫 `_remoteInboxLink(inboxId, childId, title)`（連結卡片進收件對話）。
- `renderer/src/floating-assistant.js`：
  - `_remoteInboxLink`（`_remoteInboxMod` 旁）：收件對話第一次建立時放一則說明卡片；每個子對話放一張 `_subchatLink` 連結卡片（沿用 S3 的形狀）。收件對話 ctx 用 `_chatCtxLoad` 載入，存檔後若目前正在看就重畫。
  - `executeChat` 開頭守衛：目前對話是 `kind:'remote-inbox'` 就只提示「這是遠端需求的收件對話，不能在這裡直接對話…」，**不送出、不呼叫模型**。
- 子對話等待使用者（表單）的冒泡沿用 S4：`_subchatAskForm` 以 `isChild`（`parentId`）判斷，遠端子對話因為有 `parentId` 自動走這條路，不需要新程式。
- `@`：`_mentionPrepare` 已經用 `resolveMention(chats, tok, '')`，遠端子對話（有 `nodeName`）以 `節點名/對話名` 比對，S6 不需要改解析。

評估：`scripts/eval/subchat_remote_bubble.eval.js`（新檔，換埠 17968 修後、17969 修前，假 LLM）。

- 修後：`allPass: true`，13 項全過。事實：子對話 `waiting_user`；收件對話的連結卡片 `canAnswer: true`、`pending: 'form'`；打字回答被拒（只有選項）；按選項回答後子對話離開等待、pending 清除；`@[B機/來自 B機：畫一張貓]` 解析到子對話且提示含 `id=…,節點=B機`；只寫對話名的 `@[…]` 要求補節點名；收件對話打字不呼叫模型，顯示提示；收件對話畫面有連結卡片 DOM。
- 修前（建置前備份）：`allPass: false`。失敗：`childWaitingUser`、`inboxHasLinkCard`、`inboxCardCanAnswer`、`loadedWorkdirImpl`、`inboxShowsLinkDom`、`inboxNoModelCall`、`inboxNoticeShown`（修前沒有收件對話，這些都不成立）。
- **不是 S6 新能力的判準**：`typedRejectedForChoiceOnly`、`answerResolvedForm`、`childLeftWaiting`、`pendingCleared`、`mentionAutocompleteFindsRemoteChild`、`mentionResolvesRemoteChild`、`mentionBareNeedsNode` 在修前也通過。原因：這些是 S4 與 S1 既有的行為，修前的遠端需求對話本來就有 `nodeName`、本來就能被 `@` 解析、表單本來就能在任何對話 ctx 上等待。所以它們證明的是「S6 之後沒有壞掉」，不是「S6 做好了」。

### 步驟 4 沒有驗證的（缺口）

- 權限框（`fap`）與「問題卡片」（`ask_user_card` 的文字問題）在遠端子對話上的冒泡：評估只跑了表單（`choices`）。權限框與問題卡片的程式路徑與表單共用 `_subchatLinkInfo`，但沒有實際跑過。
- 收件對話的連結卡片數量很多時的捲動與收合：沒有驗證。
- 標題格式：遠端子對話標題仍是「來自 B機：〈需求前 22 字〉」（與 S6 前相同）。因為標題含空白與冒號，`@` 必須用方括號 `@[B機/來自 B機：…]`，手打不方便。**這是已知的可用性缺口**，改標題格式要先問使用者（會改變側欄顯示），本步驟沒改。
- `@` 候選會包含收件對話本身（`B機/遠端需求 · B機`）。收件對話不接受直接對話，所以這個候選送出後會被守衛擋下。是否要從候選移除，本步驟沒改，列為缺口。
- 遠端子對話的 `chat_send_to_child`（父對話工具）仍然拒絕遠端子對話（S5 規則，`_subchatToolTarget` 的「遠端對話不能用這個工具」）。是否支援遠端子對話的工具，留給之後，列為缺口。

## 6.7 步驟 5：回歸（已完成）

真桌面版，建置為步驟 4 之後的工作目錄（`8bfc3a8e`）。預設 `topicShiftCheck` 為 false（評估檔沒有改它）。

| 評估 | 結果 | 說明 |
|---|---|---|
| `topic_local` | allPass true | |
| `chat_tree` | 21 個布林全為 true，0 個 false | 沒有 `allPass` 欄位，人工判讀 |
| `chat_tree_index` | 全部 true（修正判準後，見下） | 第一次跑 `new_fields_filled` 為 false，原因見下 |
| `read_ledger` | 沒有內建判準，人工判讀 | 見下 |
| `subchat_open`、`subchat_link`、`subchat_card_request`、`subchat_bubble`、`subchat_send`、`subchat_tools`、`subchat_form`、`subchat_fap`、`subchat_reload`、`subchat_pullback`、`chat_mention`、`subchat_tools_ai` | allPass true | |
| `subchat_remote`（S6 步驟 3） | allPass true | |
| `subchat_remote_bubble`（S6 步驟 4） | allPass true | |
| `tool-budget` | `ok: false`，1 筆 `domain_too_many_tools:skill_54f871ce-e55a-4b2a-a8b6-a67609186012` | 與 S5 文件記錄的違規 ID 相同，數量沒有增加（S5 的基準也是 1 筆）。S6 沒有新增工具 |

### 修改判準的一處（S6 有意改變，不是放寬）

`chat_tree_index.eval.js` 的 `new_fields_filled`：原本要求舊索引的所有新欄位（含遠端的 `c_old2`）都是 null。S6 的遷移（`migrateRemoteChats`，載入時執行）會把舊遠端對話收進收件對話底下，`parentId` 與 `nodeName` 因此不再是 null，這是管理層決定的行為。

- 使用者看得到的結果：舊遠端對話在側欄收進來源節點的收件對話底下（`B機`），`remote` 欄位與標題不變。
- 改了什麼判準：本機舊對話仍要求所有新欄位為 null；遠端舊對話改為要求 `status`、`topicId`、`fingerprint`、`summary` 為 null，另外新增 `remote_migrated_to_inbox`（`parentId` 指向 `kind:'remote-inbox'`、`nodeName` 為 `B機`）。
- 修改後：`new_fields_filled`、`remote_migrated_to_inbox` 都為 true，其餘（`existing_fields_kept`、`remote_kept`、`persisted_*`、`child_new_chat`）不變且全為 true。

### `read_ledger`（人工判讀，照實寫）

- 輸出中有 12 個 false：10 個 `warned:false`、2 個 `has_more:false`（`parsed_has_more`、`last_page_has_more`）。
- 判讀：`warned:false` 與 `has_more:false` 是「沒有警告」「沒有下一頁」的正常值。
- **數字對不上**：S5 文件記的是 3 個 false，這次是 12 個。`read_ledger.js` 與 `read_ledger.eval.js` 在 S6 沒有改動（`git diff` 沒有這兩個檔），所以這不是 S6 造成的；但我沒有重跑 S5 的建置來做逐項比對，所以「不是 S6 造成的」是依檔案沒有改動推論，不是量測結果。

### 步驟 5 的範圍與缺口

- 所有評估都是真桌面版、假 LLM。
- 「`topicShiftCheck` 關閉時行為不變」：評估檔沒有改開關，等於在預設（關閉）下跑。沒有另外用開啟狀態跑一次作為對照。
- 嵌入式網頁版（沒有對話清單）路徑：沒有評估覆蓋（步驟 3 已列為缺口）。
- 真實遠端節點與真實需求：沒有驗證（所有遠端需求都是用 `_rgCreateRemoteChat` / `_rgChatRecord` 模擬）。

## 7. 沒驗證、目前的缺口

- 步驟 1 的行號是讀程式與 Grep 驗證，沒有真桌面版驗證。
- 步驟 2 只有 node 測試，沒有真桌面版驗證。
- 尚未做步驟 3–5 的任何程式修改（只有步驟 1 文件與步驟 2 純函式）。
