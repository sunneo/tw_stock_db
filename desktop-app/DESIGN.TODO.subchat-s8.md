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

## 步驟 D：話題偵測語料與門檻校準

### D.1 修前的問題

- `CONTINUATION_RE`（`renderer/src/chat/topic_local.js`）對「來」開頭一律當延續句：「來聊聊投資」「來一首音樂的歌」不開子對話（S5 評估已發現）。
- 同一判準也不看長度：一整句新需求只要以「加／來／改…」開頭，就不會轉移。

### D.2 修法（`topic_local.js`）

- `isContinuation(text)`：先符合 `CONTINUATION_RE`，再套長度規則：
  - 含中文：字元數 ≤ 12（`CONTINUATION_MAX_LEN`）。理由：語料中最長的延續句 7 字；12 字留餘裕，又不會把一整句新需求當延續。
  - 單獨「來」開頭（不是「再來／又來／也來／還來」）：字元數 ≤ 4（`BARE_LAI_MAX_LEN`）。「來一個」「來兩張」是接續，「來一首音樂的歌」「來聊聊投資」是新需求。
  - 純英文：單字數 ≤ 6（字元數偏長，不適用中文的上限）。
- 延續清單補上「然後」「還要」「也說」「也講」開頭。理由：語料中「然後呢」「還要再詳細一點」「也說說它的經濟」是明確的接續語，原清單沒有；不補的話這三句在任何門檻都被誤開（見 D.4）。這四個前綴也會漏掉短的新需求（「還要幫我寫一首詩」），語料留有這個反例。

### D.3 語料（`renderer/src/chat/topic_corpus.json`，合成，63 組）

- 類別：A 換話題 18、B 同話題追問 18、C 明確延續短句 14、D「來」開頭或其他短新需求 9、E 換話題後拉回 4。
- 中文、英文、中英混合都有。標籤依語意人工判定，拿不準的沒放進來。
- 語料是合成的，不是使用者的真實對話：數字只代表這份語料，**真實誤判率沒量**。

### D.4 校準（`scripts/chat/topic_calibrate.js`）

門檻同時設 `sameThreshold` 與 `matchThreshold`（同一個旋鈕），從 0.10 到 0.50、步長 0.05：

| 門檻 | 該開沒開（漏判） | 不該開卻開（誤開） | 明確延續句被誤開 |
|---|---|---|---|
| 0.10 | 12.9%（4/31） | 0.0%（0/32） | 0.0%（0/14） |
| 0.15 | 12.9%（4/31） | 6.3%（2/32） | 0.0%（0/14） |
| 0.20 | 9.7%（3/31） | 6.3%（2/32） | 0.0%（0/14） |
| **0.25** | **3.2%（1/31）** | **12.5%（4/32）** | **0.0%（0/14）** |
| 0.30 | 3.2%（1/31） | 25.0%（8/32） | 0.0%（0/14） |
| 0.35 | 3.2%（1/31） | 37.5%（12/32） | 0.0%（0/14） |
| 0.40 | 3.2%（1/31） | 37.5%（12/32） | 0.0%（0/14） |
| 0.45 | 3.2%（1/31） | 43.8%（14/32） | 0.0%（0/14） |
| 0.50 | 3.2%（1/31） | 46.9%（15/32） | 0.0%（0/14） |

- 補延續清單前（同一份語料、同一判準的前一版）：「明確延續句被誤開」在所有門檻都是 21.4%（3/14），是三句沒被辨識（「然後呢」「還要再詳細一點」「也說說它的經濟」），門檻調整改不了這個數字。
- 選擇規則（管理層依使用者「選速度快的方式，誤判寧可多開」）：在「明確延續句被誤開 ≤ 15%」的門檻中，選「該開沒開」最低者；同樣低時選「不該開卻開」較低者。
- 結果：0.25 以上都是 3.2% 漏判；同樣低時選誤開較少的 **0.25**，與現有預設值相同，所以預設門檻沒改（`DEFAULT_SAME_THRESHOLD`、`DEFAULT_MATCH_THRESHOLD` 仍是 0.25）。
- 唯一的漏判是「還要幫我寫一首詩」（新需求，被「還要」前綴當成延續）。這是補清單的代價，照實留著。

### D.5 驗證

- `node renderer/src/chat/topic_local.test.js`：12 項全過（修前的「英文序列」因 `add another dog` 字元數超過中文上限而變紅，改用單字數後通過，這是修法的一部分，不是判準改動）。
- `node renderer/src/chat/topic_corpus.test.js`：6 項全過（語料格式、中英混合、延續誤開 ≤ 15%、漏判 ≤ 1、「來」新需求、短延續不開）。
- Electron：`scripts/eval/topic_local.eval.js` allPass（工作目錄的實作，已建置）。`topic_shift_setting`、`topic_shift_ui`、`subchat_pullback` 回歸 allPass。

### D.6 限制

- 語料合成，樣本小（31 個正例、32 個負例、14 個延續句）。0.25 的漏判只有 1 句，統計上不可靠。
- 延續清單是手寫的，沒有覆蓋所有口語（例如「ok 那下一個」「對了」）。這些句子的行為沒有量。
- 門檻對 `matchThreshold`（拉回舊話題）與 `sameThreshold`（同話題）是同一個旋鈕；分開調沒有做。

## 教訓

- 守衛要放在「寫入前」與「寫入後」兩邊。只檢查寫入前，遇到 await 中間的刪除就會漏。
- 模擬「已 abort 但仍會回來」與「寫入中途被刪」是兩種不同情境；只做前者會得到假的通過。
