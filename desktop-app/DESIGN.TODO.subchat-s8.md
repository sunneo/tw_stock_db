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

## 教訓

- 守衛要放在「寫入前」與「寫入後」兩邊。只檢查寫入前，遇到 await 中間的刪除就會漏。
- 模擬「已 abort 但仍會回來」與「寫入中途被刪」是兩種不同情境；只做前者會得到假的通過。
