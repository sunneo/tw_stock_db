# 子對話 S4b：補完 S4 的缺口（進行中）

依據：`DESIGN.TODO.subchat-s4.md`（已知缺口 1～5）、`DESIGN.TODO.chat-subsessions.md` 第 10 節。
範圍：只做 S4b。不做 S5（拉回舊話題、`@` 輸入）、S6（遠端統一）、S7（批次刪除）。
位置說明：以下行號都是源頭 `renderer/src/floating-assistant.js`（已排版，行號有效）。建置產物 `renderer/floating-assistant.js` 是長行，不用行號。

## 步驟 1：子對話工具清單與父對話不同的根因（只調查，未改程式）

### 結論（靜態證據，步驟 2 會用評估實測）

`ask_user_card` 在父對話的根層級清單裡就**不存在**（預設模式 `full` 下）。子對話的清單與父對話一樣缺它，這不是子對話獨有的分歧。根因是它被歸類成「domain-gated」（需要透過領域委派才拿得到的工具），而不是根層級工具。

所以 S4 的「已知缺口 5」寫的「子對話送出的清單不含 ask_user_card」是事實，但不是子對話的錯，而是**父對話也沒有**。管理層要的「子對話與父對話一致」在這個根因下會是一致的，但子對話要問父對話使用者的能力，也因此沒有了。

### 程式依據

1. 預設模式：`multiSubAgentMode: 'full'`（`floating-assistant.js` 57646）。
2. 根層級清單：`_getRootToolNames()`（74749–74761）
   - `mode === 'off'` 才會列出全部內建工具。
   - 其他模式：`rootBuiltins = Object.keys(this.tools).filter(n => !this._domainGatedToolNames.has(n))`（74756）。domain-gated 的工具不進根層級。
   - 再加上 `_rootTaskHints()` 的專用工具（74758），以及 `intent` 模式的過濾（74759）。
3. 分類來源：`_domainGatedToolNames` 由 `registerOptional()` 填入（59429–59432）。`_registerBuiltinAiTools` 註解（59407–59428）寫明：「這批通用內建工具（共 23 個）用 registerOptional 註冊，讓 `_getRootToolNames()` 知道哪些工具要從根層級排除」。
4. `ask_user_card` 用 `registerOptional` 註冊：61073–61084。也就是說它屬於 gated 集合。
5. 專用工具提示（`FA_TASK_TOOL_HINTS`，47191 起）**沒有** `ask_user_card`（用 `grep` 全檔搜尋確認，只出現在 1041、14751、25205、61073、96064 行，其中 25205 是階段 `ph_design` 的工具列表，不是提示）。所以使用者說什麼都不會把它補進根層級。
6. 階段 `ph_design`（25205）與領域 `design` 的工具清單有它，所以只有委派到設計領域的子 agent 才拿得到。

### 子對話與父對話送出清單的路徑是同一條

- 送出的 `tools` 都是 `this._buildNativeToolsSchema(this._getRootToolNames())`（`_loopFetchNative` 的 103546；另一處 102222 是 benchmark，同一邏輯）。
- 子對話與父對話用同一個 `_getRootToolNames()`。差異只能來自「狀態」：
  - `_currentTurnUserText`、`messages`：在 `FA_CHAT_CTX_KEYS`（51017–51027），每個對話各一份。
  - `_intentPlanCache`、`_intentRecent`、`_intentExtra`、`_intentWiden`、`_intentMiss`、`_intentHidden`：**不在** `FA_CHAT_CTX_KEYS`，只在 `intent` 模式下有作用（75609 `_intentOn()`）。預設 `full` 模式下不生效。
- `_focusTools`（77765）只在領域子 agent 執行（104051），不在對話送出的路徑上，**不是**原因。
- `_domainGatedToolNames` 是 app 實例上的 Set，子對話與父對話讀到的一樣。

### 排除的其他可能（照實寫）

- 工具預算／聚焦（`FaToolBudget`、`_focusTools`）：只在領域子 agent 路徑，不影響對話請求。排除。
- 意圖過濾（`intent`）：預設不是 `intent` 模式，不是原因；但若使用者切到 `intent`，`ask_user_card` 會變成「根層級候選」，會不會留下要看它的詞彙分數（75619），步驟 2 不處理這個模式，只在文件註明。
- 新對話沒登記某些工具：不是。子對話與父對話用同一個 `this.tools`。
- ctx 沒帶設定：不是。`multiSubAgentMode` 是 app 層設定，不是 ctx 欄位。

### 還沒確定的（步驟 2 用評估確認）

- 「父對話在 `full` 模式下送出的清單真的不含 `ask_user_card`」是靜態推論，還沒實測。步驟 2 的評估會先跑修前版本，同一句話在父對話與子對話各抓一次 `tools`。
- `_domainGatedToolNames` 收錄的確切數目（註解寫 23 個，現在可能更多）：未查，不影響結論。

## 修正方向（給步驟 2，管理層決定：自己決定並寫理由）

選項比較：

- A. 在子對話的 ctx 上額外加入 `ask_user_card`（只改子對話）：會讓子對話與父對話不一致，違反管理層決定 (1)。不採用。
- B. 把 `ask_user_card` 從 gated 移到根層級（改成一般 `register_openai_tool`，不經 `registerOptional`）：父對話與子對話都會有它，符合「工具能力一致」。代價：根層級多一個工具的 schema 大約幾百 token。**採用此方案**。理由：`ask_user_card` 是對話層級的互動能力（問使用者），不是某個領域的專用工具，放在 gated 集合是分類錯誤。
- C. 只在 `ask_user_card` 加到提示表（`FA_TASK_TOOL_HINTS`）：靠關鍵字，不可靠。不採用。

## 步驟 2：修根因，工具清單一致（已驗證）

> **已由使用者決定取代（2026-11-04，「ask_user_card只在parent」）**：本段的「根層級註冊」改回 `registerOptional`（domain-gated），子對話永遠沒有 `ask_user_card`。細節與行號見 `DESIGN.TODO.subchat-s8.md` 步驟 F。

### 改了什麼（源頭 `renderer/src/floating-assistant.js`）

- `_registerBuiltinAiTools` 裡 `ask_user_card` 從 `registerOptional(...)` 改成 `this.register_openai_tool(...)`（約 61073 行，附註解）。它不再屬於 `_domainGatedToolNames`，所以 `_getRootToolNames()` 在 `full`／`router` 模式下會列出它。說明、參數、回傳格式都沒改。
- 選了方案 B（見上面「修正方向」）：A 只改子對話會造成不一致，C 靠關鍵字不可靠。
- 代價：根層級每一輪多一個工具的 schema（約幾百 token）。父對話行為會多一種能力：可以主動開互動卡片。步驟 6 要確認工具預算相關評估沒有變紅。

### 評估

`scripts/eval/subchat_tools.eval.js`，真桌面版，埠 17967，假 LLM 抓 `body.tools`。同一句「幫我畫一張貓的圖」：父對話（話題偵測關閉）與子對話（經 `_subchatSend`，閒置 → 新一輪）各抓一次請求。

| 檢查 | 修前 | 修後 |
|---|---|---|
| parentCaptured／childCaptured | true／true | true／true |
| sameNameSet（名稱集合完全相同） | true | true |
| parentHasAskCard | **false** | true |
| childHasAskCard | **false** | true |
| loadedWorkdirImpl | （修前沒有此項） | true |
| 工具數（父／子） | 9／9 | 10／10 |
| allPass | false | **true** |

修前的重點：父與子的名稱集合本來就相同，兩邊都缺 `ask_user_card`。所以管理層預期的「子對話與父對話不同」在這個根因下不成立，差異是**父子都缺**。修前失敗來自 `parentHasAskCard`、`childHasAskCard`。

### 建置注意

- 建置後的 `renderer/floating-assistant.js` 把單引號改成雙引號（`register_openai_tool("ask_user_card",`），而且行數與排版都不同。判準不能只找單引號字串；評估改成兩種引號都接受的 regex。
- 建置前已把 `renderer/floating-assistant*.js`、`update-manifest.json`、`web-lazy/core.js`、`web-lazy/manifest.json`、`test-reports/core-tests-latest.*`、`skills/image-decompose-redraw/data/parts_builtin.json` 備份到暫存資料夾（不提交）。

## 步驟 3：表單與下載選擇的冒泡與回答（已驗證）

### 種類判定（先查再改）

- 表單（`requestUserForm`）：模型工具執行中呼叫，**會卡住子對話**。要冒泡。
- 下載位置選擇（`_pickDownloadDir` → `_showUserFormDialog`，`_wireDesktopDownloadLink` 的點擊處理）：只有**使用者點了下載連結**才會呼叫；`_pickDownloadDir` 的呼叫者只有那個點擊處理（用 Grep 確認）。模型不等它，子對話不會因此停住，所以**不是等待，不冒泡**。畫面上的對話框是使用者自己點的那個對話，沒有「哪個子對話」的混淆。不改。

### 改了什麼（源頭 `renderer/src/floating-assistant.js`）

- `requestUserForm`：Configure 視窗開著時仍照舊（最上層對話框）；其餘情況若目前對話是子對話（`_chatEntry(id).parentId`），改走 `_subchatAskForm`。
- `_subchatAskForm(subId, options)`：等待記錄 `{kind:'form', options}` 存在 `_subchatPendingMap`（只在記憶體）；狀態送 `ask`（問題＝表單標題）→ `waiting_user`。
  - 子對話在畫面上：照常畫表單，同時父對話也能回答；先回答的一方算數，另一方的畫面會收掉。
  - 子對話不在畫面上：不靠使用者切回來，父對話連結卡片就能回答；切回來時才補顯示（若還沒被回答）。
  - 表單選項物件多一個 `isCancelled`：父對話已回答的表單，之後不再畫出來（見下方「踩到的坑」）。
- `_subchatAnswerForm(childId, payload)`：父對話回答。payload 種類與回傳形狀：
  - `{kind:'choice', answer}` → `{confirmed:true, answer}`（只接受表單裡的選項）。
  - `{kind:'supplement', text}` → `{confirmed:true, answer:null, skipped:true, supplement}`，**只在 `allowSupplement` 為真時接受**（與子對話自己的表單一致；執行、安裝、刪除這類同意表單不接受打字）。
  - `{kind:'values', values}` → `{confirmed:true, values}`（只給欄位表單）。
  - `{kind:'cancel'}` → `{confirmed:false}`。
- `_subchatAnswer(childId, text)`（S4 既有的卡片回答）：等待中是表單時，轉給 `_subchatAnswerForm` 的 supplement（被拒絕就回傳錯誤）。
- `_subchatLinkInfo` 多回傳 `pending`（`'form'`／`'card'`）與 `form`（選項）。`_subchatLinkDecorate`：等待中是表單時，改畫 `_subchatFormRow`（選項按鈕、欄位輸入＋送出、取消、允許補充時的文字輸入）。
- `_showUserForm`：`options.isCancelled()` 為真時直接結束、不畫（見踩到的坑）。只有子對話表單帶這個欄位，其他表單行為不變。
- 沒有新增 ctx 狀態欄位（`pendingForm`、`visibleWaiters`、`waitingForUser` 都是既有的），所以不用進 `FA_CHAT_CTX_KEYS`。

### 評估

`scripts/eval/subchat_form.eval.js`，真桌面版，埠 17968，假 LLM。子對話先建立（前三則），之後直接呼叫子對話的 `requestUserForm`。表單只會在執行中要求，所以每案例前先 `_subchatSetStatus(kid,'start')`（模擬一輪開始；`done` 是終態，`ask` 會被忽略）。

最終結果 `allPass: true`（19 項全過）：F1 背景選項表單（waiting_user、題目顯示、父對話連結卡片有選項、父對話選了「藍色」→ 子對話表單拿到「藍色」）；F2 欄位表單（values）；F3 不允許補充的表單：打字被表單路與卡片路都拒絕、仍在 waiting_user，之後按選項才答完；F4 允許補充：打字當成 supplement；F5 子對話在畫面上：表單顯示、父對話回答後表單被收掉；F6 子對話在畫面上、子對話先按：父對話等待取消，之後父對話回答被拒絕；F7 父對話回答後切回子對話，不再重新顯示；`loadedWorkdirImpl`。

修前（同一評估，用 HEAD 的源頭重建）：`f1_waitingUser: false`、`f1_parentLinkShowsForm: false`、`f1_resolvedChoice: false`、`f2_valuesResolved: false`、`f3_choiceResolves: false`、`f4_supplementAccepted: false`、`f5_formShownInChild: false`、`f5_parentAnswerResolves: false`、`f6_childAnswerResolves: false`、`loadedWorkdirImpl: false`，`allPass: false`。修前的「拒絕」判定（F3 打字、F6 晚到回答）為 true，是因為方法不存在而回傳錯誤，不是功能正確，所以不能算作通過的證據。

### 踩到的坑（照實寫）

1. 評估第一次全部失敗，原因是**評估**：子對話在 `done` 時送 `ask` 會被狀態機忽略（`sub_status.js` 的 `done` 是終態）。表單本來就只在執行中要求，所以評估要先模擬 `start`，不是程式錯。
2. 父對話回答後，表單又在子對話切回時重新出現（F5 之後 F6 之前）。原因：`_chatActivate` 離開有 `pendingForm` 的對話時，會把表單收起來並在 `visibleWaiters` 放一個重新顯示的等待者（`_chatActivate` 約 79681–79686 行）。父對話先回答時沒有取消那個等待者，切回來就畫出已結束的表單。修法：`isCancelled`（只影響子對話的表單）。這也是 F7 的由來。

### 還沒驗證（明說）

- F5 的「父對話先回答、子對話畫面上的表單收掉」是在子對話**被切走之後**的路徑（`_chatActivate` 收起表單 → 父對話回答 → 切回）也有驗證到（F5 之後接 F6／F7）；但「子對話在畫面上、父對話先回答」的直接路徑只驗證到「表單被收掉」（`f5_childFormRemoved`）。
- 欄位表單的 `widget` 與 `info` 種類不在這次範圍（`_showUserForm` 只支援 choices 與 fields，見源頭註解）。

## 步驟 4：FAP 資料夾授權框的冒泡與回答（已驗證）

### 種類與不可自動回答的原則

- `_checkFapPermission`（約 64405 行）＝模型工具要讀寫資料夾時，若沒有授權就跳出授權框（全域 modal，`_showFapPermissionDialog`），工具等使用者按「授權」或「拒絕」。**會卡住子對話**，要冒泡。
- **權限式問題**：這是安全閘門，**一律由使用者在父對話或權限框上明確按下**。程式不會替使用者同意：沒有自動授權、沒有逾時自動同意、父對話的文字輸入不接受（`_subchatAnswer` 對 `fap` 回傳錯誤）。
- 瀏覽器的 `requestPermission()` 需要使用者手勢，所以「授權」必須在點擊事件裡同步呼叫。父對話的按鈕與權限框的按鈕都呼叫同一組 `allow()`／`deny()`，`allow()` 第一個動作就是同步呼叫 `requestPermission()`。

### 改了什麼（源頭 `renderer/src/floating-assistant.js`）

- `_checkFapPermission`：子對話來的檢查（`this._ctx` 是子對話，`_chatEntry(id).parentId` 有值）→ 登記 `_subchatFapBubble`（等待記錄 `{kind:'fap', key, label, mode}` 存在 `_subchatPendingMap`，狀態 `ask`，問題文字「需要資料夾授權：<名稱>（讀寫／讀取）」）。等待結束（不論同意或拒絕）`clear()` 清掉等待記錄、狀態回 `answer`。
- `_showFapPermissionDialog(rec, mode, key, from)`：權限框加上「來自子對話：<標題>」（回答原本的「框上沒有對話名稱」缺口）；框註冊 `_fapPermCtl`（key → `{allow, deny}`），框關閉時移除。
- `_subchatAnswerFap(childId, allow)`：父對話按「授權／拒絕」→ 呼叫 `_fapPermCtl` 的 `allow()`／`deny()`。
- `_subchatFapRow(w, childId)`：連結卡片的按鈕列（授權、拒絕、說明「權限問題只能由你按按鈕決定」）。
- `_subchatLinkInfo` 的 `pending` 多一種 `'fap'`；`_subchatLinkDecorate` 對 `fap` 畫按鈕列；`_subchatAnswer` 對 `fap` 回傳錯誤（不接受文字）。
- 同一子對話同時只顯示一件等待：已有別的等待（卡片、表單）時，權限的等待不覆蓋它，權限框仍在畫面上可以按（照常等）。這是已知限制，見下。
- 沒有新增 ctx 狀態欄位（`_fapPermCtl` 與 `_subchatPending` 都在 app 實例上），所以不用進 `FA_CHAT_CTX_KEYS`。

### 評估

`scripts/eval/subchat_fap.eval.js`，真桌面版，埠 17969，假 handle（`queryPermission` 回 prompt、`requestPermission` 回 granted），不碰真的檔案系統。最終結果 `allPass: true`（19 項全過）：

- P1 子對話發起讀取授權：waiting_user；權限框有「來自子對話」；連結卡片有「授權」按鈕；父對話打字被拒絕；等 800ms 仍未回答（沒有自動回答）；父對話按「授權」→ 檢查結束、框消失、等待清除、狀態不再 waiting。
- P2 子對話發起讀寫授權，父對話按「拒絕」→ 檢查拋出含「拒絕」的錯誤、等待清除。
- P3 子對話發起授權，使用者直接在權限框按「授權」→ 檢查結束、連結卡片的等待也清除（兩條路一致）。
- P4 父對話自己發起授權：不冒泡（子對話狀態不變、沒有等待記錄）。
- `loadedWorkdirImpl`。

修前（HEAD 源頭重建）：`p1_waitingUser`、`p1_questionShown`、`p1_modalShownFromChild`、`p1_cardHasAllowButton`、`p1_answerOk`、`p1_resolvedOk`、`p1_modalGone`、`p2_denyOk`、`p2_deniedThrows`、`p3_waitingUser`、`p3_modalPathResolves`、`loadedWorkdirImpl` 都是 false，`allPass: false`。修前為 true 的 `p1_typingRejected`（方法不存在而出錯）、`p1_notAutoAnswered`（沒有回答）、`p4_parentNoBubble`（本來就不冒泡，是防回歸的判準）、`p1_bubbleCleared`、`p2_bubbleCleared`、`p3_bubbleClearedByModal`、`p1_notWaitingAfter`，不能算作修正的證據，只是確認沒有誤判。

### 已知限制（照實寫）

- 同一子對話同時有兩件等待（例如一張卡片加一個授權）時，連結卡片只顯示先到的那一件；另一件的框仍在畫面上可以按，但連結卡片上沒有它的按鈕。這種情況子對話的工具呼叫本來就很少同時發生，本次沒有測。
- 「重新整理後的權限等待」見步驟 5（記憶體等待消失）。

## 步驟 5：重新整理後的等待狀態（已驗證）

### 決定（自己決定，理由）

- 選項：(a) 標成 `failed`，原因寫清楚；(b) 保留可重新提問。**採 (a)**。理由：等待中的問題與執行中的一輪都只存在記憶體（卡片的 Promise、表單的 resolve、權限框的 DOM），重新載入後**無法**恢復，所以不可能真的繼續等；(b) 需要重新送出問題，等於替模型重做一次，且可能重複執行有副作用的工具。(a) 是終態但不復活，使用者要繼續，就在父對話的連結卡片傳訊息（`failed` 可由 `start` 離開，會開新一輪；步驟 5 的評估 R4 已驗證）。
- 執行中的一輪（`running`）同樣在重新整理後消失，索引仍寫著 `running`，連結卡片會永遠顯示「進行中」。這不在管理層列的缺口裡，但是同一個機制，照「限制都必須修正」的原則一起修：改成 `failed`，原因「頁面重新整理，這一輪被中斷」。**這是我自己擴大的範圍**，在此明說。

### 改了什麼（源頭 `renderer/src/floating-assistant.js`）

- `_chatListInit`：索引建好（`this._chatIndex = idx`）之後呼叫 `_subchatRecoverAfterReload(idx.chats)`，有修正才 `_saveChatIndex()`。失敗只寫 log，不影響載入。
- `_subchatRecoverAfterReload(chats)`（`_subchatSetStatus` 上方）：只處理有 `parentId` 的子對話；`waiting_user` → `failed`（原因「頁面重新整理，等待中的問題已失效」）；`running` → `failed`（原因「頁面重新整理，這一輪被中斷」）。`done`、`failed` 與根對話不動。回傳修正筆數。
- 連結卡片：載入後索引已是 `failed`，`_subchatLinkInfo` 顯示「失敗：…」，不再是「等你回應」。原本的「等你回應已失效」分支保留（只在同一次執行中出現「等待但記憶體沒有」的情況才會走到，不是重新整理後的主要路徑）。
- 沒有新增 ctx 狀態欄位，不用進 `FA_CHAT_CTX_KEYS`。

### 評估

`scripts/eval/subchat_reload.eval.js`，真桌面版，埠 17970，假 LLM。流程：子對話設成等待（或執行中）→ `await _saveChatIndex()` → 清掉記憶體等待 → 呼叫真正的 `_chatListInit`（開頁面時走的同一條路）→ 檢查。最終結果 `allPass: true`（9 項全過）：

- R1 `waiting_user` → 重新載入後 `failed`，原因正確；父對話連結卡片文字「失敗：頁面重新整理，等待中的問題已失效」，不含「等你回應」。
- R2 `running` → `failed`，原因「頁面重新整理，這一輪被中斷」。
- R3 修正函式不動 `done`、不動沒有父對話的項目（回傳 0）。
- R4 `failed` 的子對話仍可繼續：父對話傳「繼續」→ 模式 `turn` → 最後 `done`。
- `loadedWorkdirImpl`。

修前（HEAD 源頭重建，同一份評估）：`beforeR1: waiting_user` 重新載入後仍是 `waiting_user`，連結卡片顯示「等你回應已失效（重新整理後請到子對話處理）」，`r1_failedAfterReload`、`r1_reasonText`、`r1_linkShowsFailedNotWaiting`、`r1_notSavedAsWaiting`、`r2_failedRunning`、`r3_untouchedDoneAndRoot`、`loadedWorkdirImpl` 都 false，`allPass: false`。這正是管理層指出的「永遠顯示等你回應」的狀態（文字有「已失效」，但狀態本身仍停在 `waiting_user`，側欄也會持續標示等待）。`r4_*` 修前也通過，是防回歸的判準，不是修正證據。

### 評估過程踩到的坑

- 第一次評估（修前與修後）都失敗：`_saveChatIndex()` 回傳 Promise（寫入是非同步的），評估沒有 `await`，重新載入讀到的是舊索引（`done`）。這是**評估**的時序問題，改成 `await` 後重跑。修前的第一次結果因此混了時序問題，所以修前用同一份最新評估重跑一次，上面的數字是這一次的。
- 真實頁面的注意事項：索引存檔是非同步的。使用者在狀態剛改變的那一瞬間重新整理，可能讀到舊狀態（例如還是 `running`，或還是 `waiting_user` 但實際上已在 `done`）。這個小窗口本次沒有處理（不影響正常路徑，要處理的話需要存檔佇列，範圍超出 S4b），照實列為已知限制。

### 已知限制

- 存檔與重新整理之間的競態（見上）。
- 重新整理後，子對話的「卡片」（`_card` 訊息）會留在子對話的歷史裡變成唯讀（S4 已知，本次沒有改）。

## 步驟 6：回歸（已驗證）

真桌面版，工作目錄的最終建置（步驟 5 之後），評估 14 個並行（埠 18001 起）；其中兩個（fap、reload）並行時初始化競態失敗，單獨重跑後通過，以單獨結果為準。

| 評估 | 結果 | 說明 |
|---|---|---|
| `subchat_open` | `allPass: true` | 含開關關閉段（`offNoChild`、`offNoLinkCard`、`offEachTurnOneParentCall`） |
| `subchat_link` | `allPass: true` | 連結卡片、存檔重讀、側欄 |
| `subchat_card_request` | `allPass: true` | 連結卡片不進請求 |
| `subchat_bubble` | `allPass: true` | 卡片等待冒泡（S4 原判準） |
| `subchat_send` | `allPass: true` | 傳訊息（閒置 turn、回應中 steer） |
| `topic_local` | 全部 true | 開關關閉與開啟的呼叫數一致 |
| `chat_tree` | 全部 true | 含 `regression_no_children`、`regression_class_names` |
| `chat_tree_index` | 各欄位符合預期，沒有 false | 沒有內建 `allPass`，人工判讀 |
| `read_ledger` | 數值記錄完整 | **沒有內建判準，只做人工判讀**，沒有與 S3 記錄逐項比對，不算通過 |
| `tool-budget` | `ok: false`，違規 `domain_too_many_tools:skill_…` | **既有問題**：S4 的 commit（`17971890`）重建跑同一評估，也有同類違規（不同技能 ID）。與 S4b 的根層級變動無關（本步驟改的是 `ask_user_card` 的根層級歸類，不是領域工具數）。不在 S4b 範圍，列為既有問題 |
| `subchat_tools` | `allPass: true` | 步驟 2 |
| `subchat_form` | `allPass: true` | 步驟 3（19 項含 F7） |
| `subchat_fap` | `allPass: true`（單獨重跑） | 步驟 4；並行時失敗為初始化競態 |
| `subchat_reload` | `allPass: true`（單獨重跑） | 步驟 5；並行時失敗為初始化競態 |

結論：S4 既有判準全部維持；`subchat_open` 的開關關閉段顯示關閉時三則只在父對話、各一次父對話呼叫，行為不變。

## 總結：S4 缺口的處理結果

- 缺口 5（子對話工具清單不含 `ask_user_card`）：根因是 `ask_user_card` 被歸為 domain-gated，父對話在預設 `full` 模式也不送，子對話與父對話一致地缺它。修為根層級工具。
- 缺口 1（表單）：已冒泡並可在父對話回答（選項、欄位、允許補充的打字）。
- 缺口 2（FAP 權限框）：已冒泡，父對話按「授權／拒絕」才算數，不自動回答、文字不接受，權限框標示來自哪個子對話。
- 下載位置選擇：**沒有冒泡，不是缺口**。它只在使用者點了下載連結才開，模型不等它，子對話不會因此停住。
- 缺口 3（`askBranchChoice`）：S4 文件寫「沒查」。它走 `requestUserForm`，因此已隨表單的冒泡一起處理（表單路徑的 choices／allowSupplement 都適用），但沒有單獨的評估案例。
- 缺口 4（重新整理後）：`waiting_user` 與 `running` 改為 `failed`，原因寫明，父對話不再永遠顯示「等你回應」。

## 未驗證／限制（照實寫）

- 連結卡片上的按鈕**點擊路徑**（表單選項、授權按鈕）只在評估中以程式呼叫 `_subchatAnswerForm`／`_subchatAnswerFap`，或點權限框本身；卡片按鈕的實際點擊沒有單獨驗證，只驗證到按鈕存在、數量正確。
- 存檔與重新整理之間的競態（步驟 5）。
- 同一子對話同時兩件等待時，連結卡片只顯示先到的一件（步驟 4）。
- `read_ledger` 沒有與 S3 記錄逐項比對。
- `tool-budget` 的既有違規未修。

## 教訓

- 步驟 1：`ask_user_card` 被歸為 domain-gated 是分類錯誤，不是子對話的錯。之後遇到「子對話少了某工具」先確認父對話有沒有，不要直接在子對話加。
- 步驟 2：建置會改寫引號與排版，評估判準要用 regex 接受兩種引號，不要寫死單引號字串。一開始 `loadedWorkdirImpl` 因此誤判成 false，不是載入錯檔；修判準後重跑才通過。
