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

## 教訓

- 第一次評估失敗的原因是評估設計（第四則觸發了新話題），不是程式。之後看到「沒抓到請求」先印出呼叫類型與子對話清單，不要直接改判準。
- 主檔是長行，`grep -n` 的行號沒有意義；用 `node` 讀檔後 `indexOf` 定位，回報用字元位置。
