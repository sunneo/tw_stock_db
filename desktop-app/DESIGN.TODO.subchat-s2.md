# 子對話 S2（本地快速話題偵測）：現況定位與決定

> 範圍：只做 `DESIGN.TODO.chat-subsessions.md` 第 10.2 節的 S2。S3–S7 不做。
> 行號以現在的主檔為準（2026-11-04 核對）。主檔＝`renderer/src/floating-assistant.js`，是編輯來源；`renderer/floating-assistant.js` 是建置產物，不要改。

## 步驟 1：現有 `_checkTopicTransition` 的定位（每項附行號）

### 1.1 輸入

| 項目 | 位置 | 內容 |
|---|---|---|
| 函式定義 | 主檔 95923 | `async _checkTopicTransition(newUserPrompt)` |
| 吃的輸入 | 95925、95932、95944–95945 | 讀 `this.messages`（非 system 的最後 6 則，95932）、`this.topicData.currentTopic`（95944）、本次 `newUserPrompt`（95945）。另外用 `_getApiConfig()`（95924）取 apiKey／apiUrl／apiModel |
| 呼叫點 | 主檔 102601 | `if (this.advancedSettings.topicShiftCheck === true) await this._checkTopicTransition(userText);`，位於 `executeChat` 內，`this.stopRequested` 檢查（102602）之前。這是阻塞送出的那一步 |

### 1.2 回傳與判斷

| 項目 | 位置 | 內容 |
|---|---|---|
| 訊息少於 3 則的提早返回 | 95925–95928 | 直接把 `currentTopic` 設成 `newUserPrompt`，不呼叫模型，`return`（無回傳值） |
| 模型呼叫 | 95963–95977 | `FaLlm.fetch` 送 `chat/completions`，`temperature: 0.1`，非串流 |
| 解析 | 95979–95986 | `!response.ok` 直接 return；取 `choices[0].message.content`，用 `/\{[\s\S]*\}/` 抓 JSON |
| 判斷欄位 | 95988 | `result.isShifted === true` 才算轉移；`result.newTopicSummary` 用於新話題名稱（96009 之後、96051） |
| 函式回傳值 | 全函式 | 沒有 `return` 值；結果只透過副作用（`this.messages`、`archivedDisplayBlocks`、`topicData`）寫回 |

### 1.3 轉移時的副作用

| 項目 | 位置 | 內容 |
|---|---|---|
| 再次呼叫模型做摘要 | 96004–96033 | 另一次 `FaLlm.fetch`（96016）產生過渡摘要，`temperature: 0.2`；摘要失敗（`!summaryResponse.ok`）則什麼都不改（96031） |
| 封存舊訊息 | 96041 | `this.archivedDisplayBlocks.push({ reason, messages: fullHistoryWithoutSystem })`，reason 為 `話題轉移：舊主題 → 新主題` |
| 替換 `this.messages` | 96043–96046 | 整批換成兩則 system：最終 system prompt + `[Topic Transition Summary …]` 摘要 |
| 重繪 | 96047 | `this._renderMessageHistory()` |
| 更新主題 | 96051 | `this.topicData.currentTopic = result.newTopicSummary || newUserPrompt`（注意：不轉移時也會執行，因 96051 不在 `if` 內） |

### 1.4 `topicData` 的其他使用處

| 位置 | 用途 |
|---|---|
| 主檔 51009 | `FA_CHAT_CTX_KEYS`：`topicData` 屬於每個對話的 ctx 狀態（多對話隔離用） |
| 主檔 56989–56991 | 初始化 `{ currentTopic: "無（新對話開始）" }` |
| 主檔 79454 | 新 ctx 初始化 `topicData: { currentTopic: '無（新對話開始）' }` |
| 主檔 79560 | 索引讀取後重設為「無（新對話開始）」 |
| 主檔 106655–106663 | 清除對話時重設 `topicData.currentTopic`，註解說明曾造成誤判（既有問題，S2 不動） |
| 主檔 95944、95926、96041、96051 | 上述判斷本身 |

### 1.5 開關

- 預設：主檔 57699 `topicShiftCheck: false`；讀設定 59130 `raw.topicShiftCheck === true`。
- 設定畫面：主檔 105539（checkbox `ai-topic-shift-chk`）、81721（同步勾選）、108458（寫回）。

### 1.6 對 S2 的含意

- 現有判斷是「模型判斷＋模型摘要＋整批替換 `this.messages`」。S2 只換判斷那一段，摘要與替換（96004–96047）不在 S2 範圍內（S3 才接手開子對話）。
- 現有保守規則（95953「判斷有疑慮時一律 isShifted:false」）依使用者決定「不用保留」，S2 的本地偵測偏向判成新話題。
- 現有 `topicData.currentTopic` 會在不轉移時也被更新（96051），S2 要的指紋應另存，不共用這個字串。

## 步驟 2 起

（待寫）
