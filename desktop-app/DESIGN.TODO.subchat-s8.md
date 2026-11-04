# 子對話 S8：收尾（關掉前面階段的缺口）

來源：`DESIGN.TODO.chat-subsessions.md` 第 10 節、`DESIGN.TODO.subchat-s7.md` 第 14 節（已知缺口）。
範圍：S8 只做收尾。不動 `ask_user_card` 的根層級歸類（S4b `d12293d1`）。
使用者規則（2026-11-04，逐字）：「所有的提問都要保留在parent / root那個，但如果使用者到child去回答，root也要知道」。

行號以 `renderer/src/floating-assistant.js`（源碼）為準；`renderer/floating-assistant.js` 是嵌入產物，不提交。

## 步驟 A：被刪子對話不復活

### A.1 修前證據（真桌面版，`scripts/eval/subchat_resurrect.eval.js`）

- 情境 1（模型忽略 abort、延遲 1200ms 才回，子對話在回應中被刪）：**沒有復活**。`_writeChatBlob`（約 79660）已用 `_chatEntry(id)` 擋住，`_chatCtxs`、pending 都清乾淨。
- 情境 2（存檔寫入已開始、尚未落盤時刪除，寫入被拖慢 1500ms）：**復活**，修前 `s2NoFile:false`，檔案 `{"messages":[…]}` 仍在。
- 原因：`_flushChatWrite`（約 79662）在 `await write` 之前檢查了 entry，之後沒有再檢查；刪除的 `del` 先落盤，寫入後到，檔案又寫回來。

### A.2 修法

- `_flushChatWrite`：寫入落盤後若 entry 已不存在，再呼叫一次 `del`（字串 `S8:resurrect` 留在警告訊息裡，評估用來確認載入的是工作目錄實作）。
- 沒有加 `_deleted` ctx 旗標、也沒有改 `FA_CHAT_CTX_KEYS`：情境 1 已被既有守衛擋住，新增 ctx 狀態會增加重設點，不必要。理由寫在這裡。
- 等 `isResponding` 變 false 的方案沒採用：模型可能忽略 abort 很久，等待會卡住刪除動作。

### A.3 修後驗證

- `subchat_resurrect.eval.js`：allPass（情境 1、2 全部檢查通過，`loadedWorkdirImpl` 為真）。
- 回歸：`subchat_delete.eval.js`、`subchat_delete_ai.eval.js` 皆 allPass。

### A.4 限制

- 情境 2 的「拖慢寫入」是人為注入（包裝 `_chatBackend().write`），真實磁碟寫入通常很快；修法不依賴時序，只依賴「寫入後檢查 entry」，所以仍成立。
- 頁面重新整理期間的寫入沒有測。

## 步驟 B：提問在根、回答在子要同步

### B.1 提問種類盤點（對應 S4 文件第 3 節的種類）

| 種類 | 來源 | 根對話回答（路徑 root） | 子對話回答（路徑 child） |
|---|---|---|---|
| 卡片 `ask_user_card` | `askCard`（約 78048）；子對話的等待記錄在 `_subchatPendingMap` | `_subchatAnswer`（約 96503） | 卡片的 `_cardWaitersMap` 回呼（約 78057） |
| 表單選項 | `requestUserForm` → `_subchatAskForm`（約 96393）；`askBranchChoice` 也走這裡 | `_subchatAnswerForm`（約 96421） | `settle` 由子對話的 `p.then(settle)` 觸發 |
| 表單欄位 | 同上（`fields`） | 同上（`values`） | 同上 |
| 資料夾授權（FAP） | `_showFapPermissionDialog`（約 64504）；子對話端 `_checkFapPermission`（約 64476–64495） | `_subchatAnswerFap`（約 96450） | 授權框按鈕（`#fa-fapperm-allow`） |
| 下載位置選擇 | 只在使用者點下載連結時開，模型不等它 | 不冒泡（S4b 已判定不是缺口） | — |

### B.2 修前證據（真桌面版，`scripts/eval/subchat_qa_sync.eval.js`，步驟 B 修改前的建置）

- 根對話路徑：回答都通過，但連結卡片沒有任何問答紀錄（`qaRecorded:false`、`rootShowsQA:false`、`savedQA:false`）。
- 子對話路徑：子對話回答後根對話的卡片完全沒有反應（`rootShowsQA:false`，四種都是）。
- 所以修前「提問在根、回答在子要同步」不成立。

### B.3 修法

- 問答紀錄存在連結訊息 `m._subchatLink.qa`（可列舉，隨父對話存檔），每筆 `{kind, q, where:'root'|'child', a, at}`，最多留最近 20 筆（理由：卡片上的紀錄要能掃完、不讓長對話的連結卡片無限變長；超過丟最舊）。
- 紀錄點：卡片回呼、表單 `settle`（`by` 參數區分 root 與 child）、FAP 授權結果（`_fapRootKeys` 記錄是否在根對話按的）。權限式問題寫「授權」或「拒絕」。
- 父對話不在畫面上時，`_subchatQARecord` 會把快取裡那一份父對話 ctx 放回 `_chatCtxs`（`_chatCtxPrune` 可能已清掉）並立刻 `_flushChatWrite()`（不等 350ms 延遲寫檔），切回父對話時不會讀到舊版。
- 連結卡片 `_subchatLinkDecorate` 在狀態列下面畫出 `.fa-subchat-qa`：`❓ 問題 → 在根對話回答／在子對話回答：答案`。子對話回答後狀態回到 running，根對話不再顯示可回答的欄位（只剩「傳給子對話」的輸入列，那是 S5 的一般傳話，不是回答）。

### B.4 修後結果（真桌面版）

- `subchat_qa_sync.eval.js`：allPass。8 個案例（4 種 × 2 條路徑）的待答、已回答、紀錄、根顯示、無回答欄位、存檔後重讀都通過；上限 20 筆與「留最新」通過。
- 回歸：`subchat_form`、`subchat_fap`、`subchat_bubble`、`subchat_card_request`、`subchat_send`、`subchat_resurrect` 皆 allPass。

### B.5 限制（如實寫）

- 卡片的子對話端回答不是點 DOM 按鈕：評估用 `FaCard.setAnswer`＋`submitStep`＋`_cardFinish` 模擬畫面送出（三個函式都是畫面送出時會呼叫的）。DOM 按鈕的點擊沒有逐一驗證。
- 「根對話不再顯示可回答的欄位」以「連結卡片裡沒有回答／授權／選項按鈕」判定；「傳給子對話」輸入列保留。
- 問答紀錄的答案摘要截斷 120 字。
- 下載位置選擇沒有冒泡（見 B.1），不在本步驟範圍。

## 教訓

- 守衛要放在「寫入前」與「寫入後」兩邊。只檢查寫入前，遇到 await 中間的刪除就會漏。
- 模擬「已 abort 但仍會回來」與「寫入中途被刪」是兩種不同情境；只做前者會得到假的通過。
