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

## 步驟 2：純函式 `renderer/src/chat/topic_local.js`（commit `a85577c4`）

- `fingerprintOf(text)`：中文取二元組（單字取一元組），英文與數字取小寫單字；虛詞清單 `STOP_CJK_BIGRAMS`、`STOP_EN_WORDS` 不計入。回傳純物件詞頻表。
- `mergeFingerprint(fp, text, max)`：累加後只留次數最多的 `max` 個詞，預設 40。理由：話題核心詞會反覆出現，次數高者留下；40 個詞約容納十來則內容訊息，比對成本可忽略。同次數依字典序，結果確定。
- `similarity(a, b)`：餘弦相似度，0–1。
- `detectShift(current, candidates, text, opts)`：判斷順序見檔頭註解。門檻 `sameThreshold = 0.25`、`matchThreshold = 0.25`，偏向判轉移（使用者決定「誤判寧可多開」）。0.25 是經驗值，由測試案例校準，可由 `opts` 覆寫。
- 太短的判定：去掉句尾標點後不到 2 個字，或在 `TRIVIAL` 清單內（「好」「繼續」「謝謝」等），不判轉移。
- 延續句：`CONTINUATION_RE` 只涵蓋「（再／又／也／還）＋加／多／來／改／換成／換一／同樣／一樣／繼續／接著」開頭，以及英文 also／again／another／more／add／continue 開頭。這是為了讓「再加一隻狗」不被判成新話題。

測試：`node renderer/src/chat/topic_local.test.js` 12 項全過，含使用者案例序列、英文序列、中英混合序列，以及 1000 次判斷總耗時（實測約 10 ms，門檻 50 ms）。

## 步驟 3：接進 `executeChat`（commit `42fc6b68`，補丁 `2604b09b`）

- 主檔新增 `_topicLocalMod()`（比照 `_chatTreeMod`，用 `new Function` 載入嵌入的 `FA_TOPIC_LOCAL_SRC`）與 `_localTopicCheck(userText)`（同步、不 await、不改 `this.messages`）。插在 `_checkTopicTransition` 前面。
- 呼叫點：`executeChat` 內原本的 `await this._checkTopicTransition(userText)` 改為 `this._localTopicCheck(userText)`，仍由 `topicShiftCheck === true` 把關。開關關閉時完全不呼叫。
- 狀態：`this._lastTopicShift = { isShifted, score, matchedTopicId, reason, at }`；`topicData.fingerprint` 是目前話題指紋；`topicData.pastTopics` 是轉出的舊話題（上限 20 筆，S5 比對用）。
- 嵌入：`scripts/embed-code-ui.js` 新增 TOPICLOCAL 區塊；`scripts/build-web-lazy.js` 的 EXCLUDE 加入 `TOPICLOCAL`，與 `CHATTREE` 相同，留在網頁版核心。
- 清除對話（`_clearChatHistory`）也會清掉 `fingerprint` 與 `pastTopics`（補丁 `2604b09b`）。
- 未改：`_checkTopicTransition` 本體保留（S3 決定是否刪）；摘要與整批替換 `this.messages` 的程式碼仍在它裡面，只是不再被呼叫（開關開啟時）。

## 步驟 4：真桌面版評估（`scripts/eval/topic_local.eval.js`）

- 指令：`node scripts/eval/run_eval.js scripts/eval/topic_local.eval.js 17961`，結果寫在 `[eval-file] result`。
- 修後（commit 之後的工作目錄建置）：13 項判準全部通過（`allPass: true`）。每則偵測耗時 0.1–2.8 ms，皆小於 5 ms。開關開啟時，模型呼叫序列只有 `main_chat`；`_lastTopicShift` 依序為 不轉移（`no-current-topic`）／不轉移（`continuation-phrase`）／轉移（`new-topic`）／轉移（`returned-to-earlier-topic`，matchedTopicId 有值）／不轉移（`trivial`）。`this.messages` 沒有摘要、`archivedDisplayBlocks` 沒有新增。
- 修前對照：暫時把建置產物換成步驟 3 之前的備份建置，跑同一個評估，結果不同：開關開啟時每則都有 `topic_check`＋`shift_summary`＋`main_chat` 三次呼叫，`_lastTopicShift` 不存在，判準全數失敗。跑完已還原修後建置（以 `cmp` 確認）。
- 來源檢查：`loadedWorkdirImpl` 用字串常值「判定新話題」檢查工作目錄載入的實作，`loadedBehaviorOk` 用行為檢查。

## 驗證範圍（誠實列出）

- 真桌面版驗證過：送出流程的模型呼叫序列、`_lastTopicShift` 結果序列、偵測耗時、開關關閉時行為不變、修前修後對照。
- 只有 node 測試：`topic_local.js` 的判斷規則（12 項）。
- 既有測試：`chat_tree.test.js` 22 項、`read_ledger.test.js` 12 項通過。
- 沒有驗證：真實使用者訊息上的誤判率沒有量測。門檻與延續句清單只用上述案例校準，遇到真實對話可能要調整。
- 沒有驗證：`topicShiftCheck` 開啟時整個 UI 行為（側欄、畫面）。S2 只改偵測，不改畫面。
- 建置產物（`renderer/floating-assistant*.js`、`update-manifest.json`、`web-lazy/*`、`test-reports/*`）是建置的副產品，沒有提交；原本的建置產物備份在 scratchpad `s2-backup` 目錄下。

## 教訓

1. 新增一個對話狀態（`topicData.fingerprint`、`pastTopics`）時，要同時檢查所有重設點。這次漏了 `_clearChatHistory`，是在步驟 3 之後才補上（補丁 `2604b09b`）。下次新增狀態欄位，先 Grep 該物件的重設處（`topicData`）再寫。
2. 評估檔若依賴新函式（如 `_topicLocalMod`），要先用防呆寫法，否則修前版本會在最後一步拋錯、拿不到對照結果。
3. 主檔是 CRLF 行尾，Edit 工具替換多行時要注意行尾。這次新增的多行片段沒有出問題，但 git 顯示 LF 會轉成 CRLF 的警告。
