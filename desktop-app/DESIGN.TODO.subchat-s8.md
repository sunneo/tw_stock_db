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

## 步驟 C：`@` 與遠端的缺口

### C.1 結果一覽

| 項目 | 修前 | 修後 | 證據 |
|---|---|---|---|
| (1) `@` 候選排除遠端收件對話 | 收件對話在候選裡（S6 缺口） | 排除（`isInbox`，`chat_tree.js`，`listMentionCandidates` 與 `resolveMention` 都過濾 `kind:'remote-inbox'`） | `chat_tree.test.js` 的 S8 測試；修前用 HEAD 模組跑同一份測試，第一個 S8 斷言失敗 |
| (2) 節點名/標題前綴 | 只有精準比對與方括號 | 精準不變；沒有精準時，完整名稱（節點名/對話名）的**唯一**前綴可用，前綴至少 2 字；歧義列候選（`ambiguous`、`prefix:true`） | `chat_tree.test.js` 的 S8 前綴測試（`@b機/來自 B機：幫我寫一個` 命中 `r1`、`@B機/來自 B機：` 列 `r1`、`r2`）；修前同一測試失敗 |
| (3) `chat_send_to_child` 遠端子對話 | 拒絕 | **保留拒絕**（理由見 C.2） | 程式位置與傳輸路徑 |
| (4) 網頁版載入 | 沒驗證 | `scripts/web-lazy-check.js` 本機檢查通過（核心與 137 個區塊）；嵌入式網頁版路徑（無對話清單）**沒有**跑 | `node scripts/web-lazy-check.js` 輸出「本機檢查通過」 |

- `@` 的 Electron 回歸：`chat_mention.eval.js` allPass（工作目錄實作）；`chat_tree.eval.js`、`chat_tree_index.eval.js` 沒有 allPass 欄位，逐項檢查，沒有任何 `false`。
- 「遠端子對話標題含空白與冒號」本身不改（S6 管理層指示：改標題格式會改變側欄顯示，要先問使用者）；改用前綴比對解決手打不便的問題。

### C.2 第 (3) 項：為什麼保留拒絕（證據）

- 遠端需求的進度、結果、停止都經由群組傳輸回給發出的節點：`_rgEvent(job, {kind:'progress'|…})`（`floating-assistant.js` 約 53440 起，`job.done` 與 `prog.fail` 旁邊）。
- 子對話的回應由本機的子對話 ctx 執行（`_subchatSend` 約 96366 不檢查 nodeName），但「追問一句」不會經過那條回報路徑：發出需求的節點不知道這句話，兩邊的結果會分岔。
- 所以在本機對遠端子對話追問需要一個新的回報協定，超出 S8 範圍。保留 `_subchatToolTarget` 的拒絕（約 74832，錯誤訊息「遠端對話不能用這個工具」）。
- 缺口：遠端子對話仍不能由父對話工具傳訊息；使用者若要追問，需要另外的協定設計（列為後續，不在 S8）。

### C.3 測試與限制

- `renderer/src/chat/chat_tree.test.js`：26 項全過（含 S8 的 4 項）。
- 限制：前綴比對只對「完整名稱」（節點名/對話名）做，不對對話名單獨做（遠端對話名單獨對上時仍是 `needNode`，維持原行為）。
- 限制：`@` 候選的 App 層（輸入框自動完成）沒有另做 Electron 評估，只靠模組測試與 `chat_mention.eval.js`。

## 步驟 F：ask_user_card 只在父對話（2026-11-04 管理層更新）

使用者原話：「ask_user_card只在parent」。這取代先前「不要動 ask_user_card 的根層級歸類」的指示。

### F.1 決定與理由

- (1) 根層級註冊還原：`ask_user_card` 回到 `registerOptional`（domain-gated），與 `d12293d1^` 相同（`floating-assistant.js` 61087）。理由：使用者的原則是「只在 parent」，根層級註冊會讓所有對話都有它，包括子對話。
- (2) 子對話永遠沒有它：不靠「不送進清單」一招，而是三層擋：清單過濾、領域委派過濾、工具實作本身擋下（executor 擋下才能涵蓋所有取得路徑）。
- (3) 評估：`subchat_no_ask.eval.js`（新）與 `subchat_tools.eval.js`（更新）。

### F.2 路徑盤點（子對話內可能取得 ask_user_card 的每一條路徑，附行號）

| 路徑 | 位置 | 處理 |
|---|---|---|
| 根層級清單 | `_getRootToolNames`（74856）只取非 gated 工具；`FA_TASK_TOOL_HINTS`（47197）不含它（Grep 確認） | 還原後不在根層級清單；子對話清單另由 `_subchatToolFilter`（74835、過濾在 74838）移除 |
| 領域委派 | 領域清單含它：`toolNames`（1558，uml 領域）、`ph_design` 階段（25211）；子代理取得領域工具於 `_resolveDomainToolNames`（104524） | `_resolveDomainToolNames` 在子對話回傳前過濾（104530） |
| 技能包 | 技能步驟的工具提示（14757，`st(ask, …, { tool: ask_user_card })`）；路由正則（11972）；說明文字（1041） | 只是提示或說明，不會把工具送進子對話；實際呼叫仍被下一條擋下 |
| `get_tool_details`／`request_additional_tools` | 補工具的機制；取得說明後呼叫仍走同一個工具實作 | 不改；呼叫時在工具實作擋下（61091） |
| 工具實作（所有路徑的共同終點） | `registerOptional(ask_user_card, …)` 的 async 函式（61087、61091） | 子對話呼叫 → `ok:false`，訊息：「這個對話是子對話，提問由根對話負責；需要使用者決定的事請直接用文字寫在回覆裡，系統會顯示在根對話的連結卡片上」 |

判斷子對話：`_subchatIsChild()`（74830）。有有效 `parentId` 的 ctx 都是子對話，包括收件對話底下的遠端子對話。

### F.3 修前與修後（真桌面版）

- 修前（`subchat_no_ask.eval.js`，修改前的建置）：`rootListNoAsk`、`gatedRegistration`、`childDomainNoAsk`、`childListNoAsk`、`childCallNotOk`、`childCallExplains`、`noCardLeft`、`loadedWorkdirImpl` 失敗；子對話呼叫會卡在等使用者（逾時 4 秒才回來，證明它確實開了卡片）。`parentDomainHasAsk` 修前就通過（父對話經領域拿得到，符合「只在 parent」）。
- 修後：`subchat_no_ask.eval.js` allPass；`subchat_tools.eval.js` allPass。
- 判準改動（有意，理由：規則改變）：`subchat_bubble.eval.js` 的案例 A 原本測「子對話用 ask_user_card 開卡片、冒泡到父對話、父對話回答」。新規則下子對話不能開卡片，所以案例 A 改為測「子對話呼叫被擋下（工具結果含「提問由根對話負責」）、子對話不等待、父對話連結卡片沒有問題、在父對話回答會被拒絕」。舊的四個判準（`aStatusWaitingUser`、`aParentLinkShowsQuestion`、`aAnswerAccepted`、`aChildGotAnswer`）移到 info，不再計入 allPass。
- F 之後的回歸重跑（見步驟 E 的表）：全部 allPass 或無 false；`subchat_bubble` 改判準後 allPass。

### F.4 與管理層指示的落差（需要知道）

管理層第 (1) 項要求「父對話清單與 d12293d1^ 一致」，第 (3) 項又說父子差異「包含子對話沒有 ask_user_card」。在沒有啟用領域的父對話情境（`subchat_tools` 的情境）下，父對話本來就不含 `ask_user_card`（與 d12293d1^ 相同），所以那個情境的父子差異不含它。父對話只在領域啟用時才有它，這是 `subchat_no_ask` 的 `parentDomainHasAsk` 所檢查的。我依 (1) 的機制與證據實作，並以使用者的原話「只在 parent」寫成領域路徑的評估，不把差異硬塞進沒有領域的情境。

### F.5 限制

- 子對話呼叫在評估中是直接呼叫工具實作（不是經由假模型的工具呼叫）。模型實際收到的清單由 `subchat_tools` 的假模型請求檢查。
- `request_additional_tools` 等補工具機制沒有逐一用真實的模型流程測試，依賴工具實作的擋下。

## 步驟 E：回歸

真桌面版（`scripts/eval/run_eval.js`，工作目錄實作，已建置）：

| 評估 | 結果 |
|---|---|
| `subchat_link`、`subchat_open`、`subchat_tools`、`subchat_tools_ai`、`subchat_remote`、`subchat_reload` | 全過（`subchat_reload` 沒有 allPass 欄位，逐項無 false） |
| `subchat_remote_bubble`、`subchat_pullback`、`subchat_form`、`subchat_fap`、`subchat_bubble`、`subchat_card_request`、`subchat_send` | 全過 |
| `subchat_delete`、`subchat_delete_ai`、`subchat_delete_ui`、`subchat_resurrect`、`subchat_qa_sync` | 全過 |
| `chat_mention` | 全過 |
| `chat_tree`、`chat_tree_index` | 沒有 allPass 欄位，逐項無 false |
| `topic_local`、`topic_shift_setting`、`topic_shift_ui` | 全過 |
| `tool-budget` | 違規數仍是 1（`domain_too_many_tools:skill_54f871ce…`，與 S7 基線相同）；`flat_all_tools` 54866（與 S7 相同，本階段沒有新增工具） |
| `read_ledger` | 沒有內建判準，人工判讀：`A_before_fix` 到 `H_attach_after_fix` 各欄位與 S7 記錄的形狀一致；但 S6 的基線數值沒有在本次文件逐項列出，**無法嚴格逐欄比對**，如實寫明 |

- 「topicShiftCheck 關閉時行為不變」：`topic_shift_setting` 全過。
- 「沒有子對話時工具清單與側欄與現在相同」：`subchat_delete_ai` 的「沒有子對話時工具清單不含 `chat_delete_children`」與 S7 `regressionNoBoxes` 再次通過。
- 節點測試：`chat_tree` 26（S8 新增 4 項）、`topic_local` 12、`topic_corpus` 6、`chat_delete` 19。
- 網頁版：`scripts/web-lazy-check.js` 本機檢查通過。

## 已知缺口（S8 收尾後的最後狀態）

1. **嵌入式網頁版（沒有對話清單的路徑）**：沒有跑真實載入驗證（步驟 C 缺口 4，S6 也列過）。理由：需要沒有對話清單的建置，這次沒有做。
2. **遠端子對話的 `chat_send_to_child`**：保留拒絕（C.2）。理由：遠端需求的回報經群組傳輸，本機追問沒有回報路徑；需要新協定。
3. **問答紀錄的子對話端卡片回答**：用 `FaCard` API 與 `_cardFinish` 模擬，沒有逐一點 DOM 按鈕（B.5）。
4. **話題偵測是合成語料**：真實誤判率沒量（D.6）。「還要幫我寫一首詩」這類以延續前綴開頭的新需求會漏判（D.4）。
5. **`read_ledger` 沒有逐欄對 S6 基線**（步驟 E）。
6. **`@` 候選的輸入框自動完成**沒有另做 Electron 評估，只有模組測試與 `chat_mention` 評估（C.3）。
7. **被刪子對話的情境 2 是人為拖慢寫入**（A.4）；真實磁碟寫入通常很快，修法不依賴時序。
8. **`ask_user_card` 根層級歸類**：本階段沒有改動，也沒有依賴（管理層指示）。

## 教訓（S8 過程）

- 守衛要放在「寫入前」與「寫入後」兩邊。只檢查寫入前，遇到 await 中間的刪除就會漏（步驟 A）。
- 模擬「已 abort 但仍會回來」與「寫入中途被刪」是兩種不同情境；只做前者會得到假的通過（步驟 A）。
- 快取有兩份時，修改的必須是「UI 會讀的那一份」。`_chatCtxPrune` 會清掉不在畫面上的對話快取，之後會從磁碟重讀；修改後要立刻落盤，不能等 350ms 的延遲寫入（步驟 B）。
- 評估裡的過期物件會覆蓋真正的狀態：收尾時用 `fa._chatActivate(parentCtx)` 把開頭那份舊物件換回來，導致假失敗。要用 `_chatCtxs.get(id)` 取當前的（步驟 B）。
- 評估之間要等延遲寫檔完成（sleep 700ms）再切換對話，否則讀到舊版（步驟 B）。
- 延續句的長度上限要分語言：中文用字元數，英文用單字數。字元數會把 `add another dog` 誤判成新話題（步驟 D）。
- 校準時，門檻調整改不了的誤判（所有門檻都 21.4%）要先找原因，多半是判準本身缺條件，不是門檻問題（步驟 D）。只檢查寫入前，遇到 await 中間的刪除就會漏。
- 模擬「已 abort 但仍會回來」與「寫入中途被刪」是兩種不同情境；只做前者會得到假的通過。
