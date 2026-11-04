# 子對話 S4：狀態監控與冒泡（進行中）

依據：`DESIGN.TODO.chat-subsessions.md` 第 10.2 節的 S4；前置 `subchat-s1.md`、`subchat-s2.md`、`subchat-s3.md`。
範圍：只做 S4。不做 S5（拉回舊話題、`@` 輸入）、S6（遠端統一）、S7（批次刪除）。
開關：`advancedSettings.topicShiftCheck === true` 且有子對話時才會發生；開關關閉時行為與現在相同。

## 步驟 1：連結卡片是否進入模型請求（已驗證）

對應 S3 文件「沒驗證」的第一項。

### 結論

連結卡片（`role:'tool'` 的顯示訊息，`_subchatLink`）**不會**進入模型請求，不需要修。

### 程式依據

- 主檔 `renderer/floating-assistant.js` 只有 1196 行（長行），所以用字元位置（`String.indexOf`）定位，不用行號：
  - 連結卡片由 `_subchatOpenFor`（字元位置 8646537）建立：`_buildToolResultMessage("display", …, {})`，之後設 `h._subchatLink`（字元位置 8647633）。這則卡片沒有 `_card`／`_humanOnly` 旗標。
- 送出前的過濾是 `_sanitizeToolCallPairing`（字元位置 8138498；`_buildToolResultMessage` 在 8139355）：
  - 只保留 `role:'tool'` 且 `tool_call_id` 在「前一則 assistant 的 `tool_calls`」裡的訊息。
  - 卡片前面是使用者訊息或 assistant 的純文字，沒有 `tool_calls`，所以被 `continue` 丟掉。
  - 有 `_card`／`_humanOnly` 旗標的訊息會被略過（不影響這個判斷）。
- 呼叫端：`g=this._sanitizeToolCallPairing(0===m…` 位於字元位置 9034528，`messages:this._sanitizeToolCallPairing(F)` 位於 9084202。

### 評估

`scripts/eval/subchat_card_request.eval.js`，真桌面版（`run_eval.js`，埠 17964），假 LLM 抓請求 body。

前置：前三則開出子對話，父對話 `fa.messages` 有 1 張連結卡片（`preCardExists: true`）。

第四則「還有一句話」在父對話送出，請求摘要：

- 送進模型 7 則；介面 9 則（差 2 = 兩張連結卡片以外的顯示訊息，已由 `requestSmallerThanUi: true` 確認比介面少）。
- 角色序列：`assistant, user, assistant, user, assistant, user, user`。
- 沒有任何 `role:'tool'` 訊息，因此沒有孤兒 tool，也沒有「↳ 子對話」字樣（`noCardTextInRequest: true`、`noOrphanToolInRequest: true`）。
- 父對話送出沒有錯誤（`parentNoError: true`）。
- 全部 6 項 `allPass: true`。

### 評估的注意事項（不是產品缺陷，但要知道）

- 第四則**不能**在話題偵測開啟時送出：本地話題偵測（S2）會把「還有一句話」判成新話題，開出第三個子對話、父對話不呼叫模型（實測）。所以這一則在 `topicShiftCheck = false` 時送出。這仍是正確的測試情境（卡片在父對話訊息列表、父對話自己送模型請求）。
- 「本地話題偵測把不相關的一則判成新話題」是 S2 既有行為，不在 S4 範圍，記在這裡當作已知現象，之後交給管理層判斷。

### 修前失敗？

沒有：判準在現有程式下已成立，沒有做任何程式修改。

## 步驟 3：需要使用者回應的等待種類（只調查，未改程式）

定位方式：主檔只有 1196 行（長行），以下都是字元位置（`String.indexOf`），不是行號。

### 背景：子對話 ctx 與父對話的關係

- `FA_CHAT_CTX_KEYS` 定義在字元位置 5781995，包含 `messages`、`isResponding`、`_toolCallLog` 等，每個對話各一份。
- `_chatRunner(ctx)`（字元位置 8160987）回傳 Proxy：對這些欄位的讀寫導向 ctx 自己的那一份；`_ctx` 也指向 ctx。所以子對話的 `this.messages` 是子對話自己的訊息。
- `_chatIsVisible()`（字元位置 8160935）＝`this._ctx === this._activeCtx`，判斷這個對話現在是不是使用者看得到的那個。
- `_chatActivate`（約 8165854 之後）：切換對話時，若離開的對話有 `pendingForm`，會把表單從畫面移除、設 `waitingForUser`，並放進 `visibleWaiters`；切回來時才重新顯示（`visibleWaiters` 的 flush 在字元位置約 8166633）。

### 種類 1：`ask_user_card`（互動卡片，最常見）

- 實作：`askCard(e)`（字元位置 8108338）。把卡片訊息（`_card` 旗標）推進 `this.messages`（子對話的 ctx 下就是子對話自己的訊息），然後 `new Promise` 等使用者送出。
- 不可見時：`askCard` 只在 `!this._chatIsVisible()` 時設 `ctx.waitingForUser = true` 並重畫側欄（`_renderChatList`）。卡片本身只有在對話畫面渲染時才會出現（`_renderMessageHistory`）。
- 表現：子對話在背景時，卡片在子對話的訊息裡、使用者看不到；子對話的 `executeChat` 停在這個 Promise 上不會往下走（**卡住**）。只有側欄有一個 `waitingForUser` 標記，且要使用者自己點進子對話才看得到卡片。
- 呼叫端（字元位置）：`ask_user_card` 工具註冊 7199149 附近；`askCardFlow` 8109170；擴展回合的確認卡 7977318（有「不要／以後都不要問」選項，是權限式問題）；日誌學習確認卡 8873611。
- 這一種**沒有**冒泡機制，是 S4 要處理的主要對象。

### 種類 2：`requestUserForm` → `_showUserFormDialog`（表單／選擇框）

- `requestUserForm(e)`（字元位置 8124148）三段式：
  1. 進階設定的 modal 開著 → 直接 `_showUserFormDialog`（與對話無關，立即顯示）。
  2. 對話不可見 → 設 `waitingForUser`、重畫側欄，等 `visibleWaiters`（使用者切回來才顯示）。**卡住直到使用者切回子對話**。
  3. 可見 → `_requestUserFormNow`。
- `_showUserFormDialog`（字元位置 8130700）是 `document.body` 上的 modal 覆蓋層，點選項後 resolve。第 15 秒會 `r.remove()` 移除 DOM；**沒查**這時 Promise 是否會結束（如果不結束就是卡住，要另外確認）。
- 另一個直接呼叫者：下載位置選擇（字元位置 8128956），直接 `_showUserFormDialog`，不經 `requestUserForm`，所以**不論哪個對話**都會立即跳出來，且對話框上沒有對話名稱。

### 種類 3：FAP 檔案存取權限（`_checkFapPermission` → `_showFapPermissionDialog`）

- `_checkFapPermission`（字元位置 7356364）檢查 `queryPermission`，不足時呼叫 `_showFapPermissionDialog`（字元位置 7356715，modal 覆蓋層，`document.body`）。結果用 `_fapPermissionDialogPromises` 合併同一把資料夾的同時請求。
- 表現：**不論哪個對話**都立即跳出；子對話會等使用者在這個框上按下才繼續（框在畫面上，使用者找得到，所以不是無限卡住），但框上沒有對話名稱，使用者可能不知道是哪個子對話在要權限。
- 這一種不是「看不見而卡住」，而是「看得見但不知來源」。S4 可以先不改，只在文件列為已知缺口。

### 種類 4：`askBranchChoice`（分支選擇）

- 字元位置 8127324。**沒查**是否為 modal、是否受 `_chatIsVisible` 影響，以及在子對話中的表現。

### 沒找到的種類

- 模型工具呼叫的逐次核准（tool approval）：關鍵字 `tool_approval`、`needApproval`、`_confirmTool`、`_showConfirm` 在主檔都是 0 次；`approve` 只有 `approvePlan` 一次（與工具核准無關）。本次沒有找到模型工具呼叫的核准機制。
- `window.confirm(`：約 25 次，多為使用者在畫面上按「刪除」的確認（例如知識庫刪除，字元位置約 2614739 之後的 `window.confirm` 系列），不是模型發起。**沒逐一查**全部 60 次 `confirm(`（另有 `c.confirm(`、`t.confirm(` 各 1 次，沒查）。

### 小結（給步驟 4 用）

| 種類 | 子對話在背景時 | 會卡住子對話 | S4 要冒泡 |
|---|---|---|---|
| `ask_user_card`（`askCard`） | 卡片只在子對話，側欄標記 | 會 | **是（優先）** |
| `requestUserForm` | 等切回來 | 會 | 是（次要） |
| 下載位置選擇 | 立即跳出，無對話名稱 | 框可見，等點擊 | 否（一次性） |
| FAP 權限框 | 立即跳出，無對話名稱 | 框可見，等點擊 | 視情況（權限確認） |
| `askBranchChoice` | 沒查 | 沒查 | 沒查 |

## 步驟 4：監控與冒泡（已驗證，見下方已知缺口）

### 改了什麼

- 來源：`renderer/src/floating-assistant.js`（這是源頭；`renderer/floating-assistant*.js` 是建置產物，不提交）。
- 純函式：`renderer/src/chat/sub_status.js`（步驟 2）嵌入主檔，標記 `SUBCHATSTATUS-BEGIN／END` 放在 `SUBCHATHANDOFF-END` 後面；`scripts/embed-code-ui.js` 新增一行 `embed(...)`；`scripts/build-web-lazy.js` 的 EXCLUDE 加 `SUBCHATSTATUS`（留在網頁版核心，與 `SUBCHATHANDOFF` 相同）。
- 新方法（源頭檔）：
  - `_subchatStatusMod()`：載入狀態模型（new Function，只載入一次）。
  - `_subchatSetStatus(childId, event, info)`：所有狀態變化的入口。狀態有變才寫索引、重畫側欄；父對話的連結卡片若已在畫面上，呼叫 `_subchatLinkDecorate` 只更新它。`entry.subInfo` 只在進入 waiting_user（問題）或 failed（原因）時設定。
  - `_subchatPendingMap()`：子對話 id → 等待中的卡片訊息（只在記憶體，不存檔）。
  - `_subchatLinkInfo(childId)`：連結卡片要顯示的文字與 `canAnswer`。等待中但記憶體裡沒有卡片（重新整理後）顯示「等你回應已失效」。
  - `_subchatAnswer(childId, text)`：父對話回答。用「略過選項＋直接打字回答」的結果（`skipped:true`、`supplement`，與 `ask_user_card` 工具說明相同）交給卡片的等待者，子對話接著跑。
  - `_subchatLinkDecorate(w, childId)`：連結卡片的狀態列與回答欄（可重複呼叫，先清再畫）。
- 既有函式的改動：
  - `_subchatOpenFor`：完成時先用既有的 `_turnFailureText(使用者訊息位置)` 判斷；有失敗文字（⚠️／❌／🚫 開頭的 assistant 訊息）就記 `error`，否則 `finish`。`executeChat` 出錯時通常**不 reject**，只留下訊息，所以只靠 reject 會漏判。
  - `askCard`：卡片屬於子對話（`ctx.id` 的索引有 `parentId`）時，進入等待前記 `ask`（問題＝卡片標題），等待者回應後記 `answer`。
  - `_chatRunner`：新增 `_faHost`（proxy 取得真正的 app 實例）。原因見下方教訓。
  - 連結卡片渲染分支：加 `data-child-id`，改用 `_subchatLinkDecorate`。

### 評估

`scripts/eval/subchat_bubble.eval.js`，真桌面版，換埠 17965，假 LLM。最終結果 `allPass: true`（14 項全過）：

- 案例 A（問使用者 → 父對話回答 → 完成）：子對話 `waiting_user`；父對話連結卡片顯示「等你回應：要用哪種配色？」與回答欄；在父對話回答後 `_subchatAnswer` 回 ok；子對話收到答案（工具結果含「紅色」）、模型接著回「完成」，最後 `done`；父對話沒有卡在回應中。
- 案例 B（executeChat 拋錯）：`failed`，連結卡片顯示「失敗：fake boom」。
- 案例 C（executeChat 正常結束但最後一則是 ⚠️ 失敗訊息）：`failed`，連結卡片顯示「失敗：⚠️ 模型回應失敗…」。
- `loadedWorkdirImpl`：函式原始碼含 `fa-subchat-answer-row`（工作目錄的實作）。

修前證明：步驟 4 第一次跑（改程式前，評估的 A 段與現在相同）：`aStatusWaitingUser: false`、`aParentLinkShowsQuestion: false`、`aParentHasAnswerBox: false`、`aAnswerAccepted: false`、`aStatusDone: false`（子對話沒有停在等待上，也沒有完成）。B／C 案例是後來才改成替換 executeChat 的版本，修前沒有單獨跑過；這點照實說明。

### 評估過程中改掉的東西（都是評估或實作的問題，不是判準被放寬）

1. 假 LLM 回 HTTP 500：應用會重試（約 8 次、間隔逐漸拉長，約 20 秒以上），不是失敗。
2. 假 LLM 回 HTTP 400：應用把它當成「上下文過長」，做歷史摘要後再試，摘要請求得到的預設「完成」被當成成功。
3. 假 LLM 失敗時，應用的離線食譜會接住，子對話變成「🍳 離線食譜…」的正常回覆，判成 done。這是應用既有的離線備援，不是 S4 要改的。所以 B／C 改成替換 `executeChat`，測的是 S4 自己的失敗判斷。
4. 案例 B 一開始找到的是案例 A 的子對話（同一個父對話底下，`[0]` 取到錯的）。改成用標題找。

### 已知缺口（沒有冒泡的等待種類）

1. `requestUserForm`（表單）：子對話在背景時會在 `visibleWaiters` 等待，**使用者切回子對話才會出現**，父對話的連結卡片不會冒泡。會卡住子對話。
2. FAP 檔案權限框（`_showFapPermissionDialog`）與下載位置選擇（`_showUserFormDialog` 直接呼叫）：是全畫面的 modal，看得見、子對話會等點擊，但框上沒有對話名稱，不知道是哪個子對話在要。沒有改。
3. `askBranchChoice`：步驟 3 沒查完，沒有改。
4. 重新整理後：等待中的卡片記憶體消失，子對話索引仍是 `waiting_user`，連結卡片顯示「等你回應已失效」。卡片本身在重新整理後會變成唯讀「已結束」。沒有自動把子對話改成失敗或完成。
5. **重要（給步驟 5 與管理層）**：子對話送出的工具清單（實測 8～13 項）**不含 `ask_user_card`**。所以真實模型在子對話裡不一定能呼叫它，冒泡在真實使用中可能很少觸發。評估是假模型直接回傳這個工具呼叫，驗證的是執行端與冒泡，不是「模型會不會主動問」。這一點需要管理層決定：要不要讓子對話的工具清單包含 `ask_user_card`。
6. 錯誤判斷靠 ⚠️／❌／🚫 開頭的文字（`_turnFailureText` 既有判準）。離線備援會把失敗包成正常回覆，子對話會判成 done。
7. 新增的狀態欄位：`entry.subInfo`（索引欄位，會存檔）、`_subchatPending`（FA 層，不存檔）、`_subchatStatusModule`（FA 層快取）。**沒有**新增 ctx 狀態欄位，所以沒有加進 `FA_CHAT_CTX_KEYS`。

## 步驟 5：父對話傳訊息給子對話（已驗證）

### 改了什麼（源頭 `renderer/src/floating-assistant.js`）

- `_subchatRun(childId, cctx, text)`：開子對話（`_subchatOpenFor`）與傳訊息共用的執行段。開始記 `start`（閒置的子對話回到 running）；完成記 `finish`；出錯記 `error`（失敗判斷仍是 `_turnFailureText`）。`_subchatOpenFor` 的執行段改成呼叫它。
- `_subchatSend(childId, text)`：連結卡片的「傳給子對話」。
  - 子對話 `isResponding` 為真 → 走既有插話規則（`executeChat` 開頭的 `_addSteeringMessage`，子對話訊息多一則 `[Steering]`），回 `mode: 'steer'`。
  - 閒置 → `_subchatRun` 當成新一輪（狀態回 running），回 `mode: 'turn'`。
  - 子對話不在記憶體 → 用 `_chatCtxLoad` 載入。
- `_subchatLinkDecorate`：輸入列永遠存在。等待中且記憶體有卡片 → 按鈕是「回答」（交給卡片）；否則「傳給子對話」。父對話自己的輸入框沒有改，仍然只問父對話。

### 評估

`scripts/eval/subchat_send.eval.js`，真桌面版，換埠 17966，假 LLM。`allPass: true`（19 項全過）：

- 案例 1（閒置 → 新一輪）：`mode: 'turn'`，狀態確實觀察到 running，最後 done；子對話有使用者訊息與「完成」回覆；父對話模型呼叫數不變。
- 案例 2（回應中 → 插話）：子對話 `isResponding` 為真時送出，`mode: 'steer'`，子對話訊息含 `[Steering]` 與原文；最後 done。
- 案例 3（父對話輸入框）：父對話模型多一次呼叫，父對話有該則使用者訊息，子對話訊息數不變、沒有新子對話。
- 案例 4（畫面按鈕）：連結卡片有「傳給子對話」按鈕與輸入框；輸入後點擊，子對話收到文字，輸入框清空。
- `loadedWorkdirImpl`：函式原始碼含 `steer`。

修前：`_subchatSend` 這個方法在改程式前不存在，整個評估的前提不成立（沒有另外跑修前版本，這是新功能，不是修正）。

### 回歸

步驟 4 的 `subchat_bubble.eval.js` 在 `_subchatOpenFor` 改成 `_subchatRun` 後重跑：`allPass: true`（14 項全過）。

### 已知限制

- 子對話在等待使用者回答（`waiting_user` 且記憶體有卡片）時，連結卡片的按鈕是「回答」，不會把文字當成一般訊息送出。要補充說明就得用回答的文字。
- 插話文字只進子對話的訊息，不會自動在父對話顯示（父對話的連結卡片沒有列出傳過去的內容）。
- 步驟 4 的已知缺口（表單、權限框、重新整理後的等待）沒有因為這一步改變。

## 教訓

- 第一次評估失敗的原因是評估設計（第四則觸發了新話題），不是程式。之後看到「沒抓到請求」先印出呼叫類型與子對話清單，不要直接改判準。
- 主檔是長行，`grep -n` 的行號沒有意義；用 `node` 讀檔後 `indexOf` 定位，回報用字元位置。源頭 `renderer/src/floating-assistant.js` 是排過版的，可以用行號。
- 在對話 proxy（`_chatRunner`）上呼叫 `_renderMessageHistory` 會畫到**子對話**的訊息；畫面要用真正的 app 實例（`_faHost`）。
- 增量重畫不會重建已經在畫面上的舊卡片；狀態變了要自己更新那張卡片（`_subchatLinkDecorate`）。
- `executeChat` 出錯通常不 reject，要看子對話訊息裡的失敗文字；假模型的 500／400 會觸發應用的重試、摘要、離線備援，評估時要替換 `executeChat` 才能測到 S4 自己的分支。
- 評估跑太久會超過 `run_eval.js` 的 170 秒上限，輸出會是空的。等待時間要縮短到整段在上限內。
- 工作目錄裡別人未提交的建置產物（`renderer/floating-assistant*.js`、`web-lazy/*`、`update-manifest.json`、`test-reports/*`）在建置時會被覆寫。建置前先備份到暫存資料夾。
- 主檔是長行，`grep -n` 的行號沒有意義；用 `node` 讀檔後 `indexOf` 定位，回報用字元位置。
