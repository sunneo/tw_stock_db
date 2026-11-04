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

## 教訓

- 第一次評估失敗的原因是評估設計（第四則觸發了新話題），不是程式。之後看到「沒抓到請求」先印出呼叫類型與子對話清單，不要直接改判準。
