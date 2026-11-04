# 子對話 S5：拉回舊話題、`@對話名稱`、父對話的子對話工具

> 範圍：只做 `DESIGN.TODO.chat-subsessions.md` 第 10.2 節的 S5（步驟 1–3）與回歸（步驟 4）。S6（遠端統一）、S7（批次刪除）不做。
> `ask_user_card` 的根層級歸類（`d12293d1`）沒有改、沒有依賴。
> 行號以 2026-11-04 的主檔 `renderer/src/floating-assistant.js` 為準（編輯來源；`renderer/floating-assistant*.js` 是建置產物，沒有提交）。

## 使用者的決定（照 `chat-subsessions.md` 第 10 節）

- 拉回舊話題只載摘要，不整段載回。
- 父對話可以透過自己跟子對話溝通，也可以直接插給子對話。
- `@對話名稱` 讓父對話知道指的是誰；標記時遠端對話要含節點名稱。

## 步驟 1：拉回舊話題（commit `4df50ae1`）

### 做法

- `_localTopicCheck`（主檔 96019）的候選：舊話題（`topicData.pastTopics`）加上**父對話底下的子對話**（`_subchatChildCandidates`，主檔 96052，候選 id＝子對話 id）。
- 命中子對話（`toChild`，主檔 96029）時：父對話的目前話題**不變**（子對話的話題不算父對話的話題），`_lastTopicShift.toChild = true`。
- 命中父對話自己的舊話題：照舊（父對話處理）。
- 找不到（子對話已刪除，候選裡沒有）→ 當全新話題，開新子對話。
- `_subchatPullback`（主檔 96306）：訊息轉給那個子對話（沿用 `_subchatSend`，子對話正在回應時走既有插話、閒置時開新一輪），更新子對話的指紋，父對話只留使用者訊息＋卡片「↳ 回到子對話：〈標題〉」，不呼叫父模型，不把子對話歷史載回父對話。
- 開新子對話（`_subchatOpenFor`，主檔 96328）成功後，父對話話題還原：把 `_localTopicCheck` 剛推進 `pastTopics` 的那一筆移掉，`fingerprint` 還原成 `prevFingerprint`。原因：沒有還原的話，子對話的話題會變成父對話的話題，下一則就會判到錯的地方（見下方教訓）。

### 評估

`scripts/eval/subchat_pullback.eval.js`，真桌面版，換埠 17963，假 LLM。

- 修前（`4df50ae1` 之前的建置）：13 項中 6 項失敗（`pullbackChildGotOneRound`、`pullbackParentNoModelCall`、`pullbackChildModelCalled`、`pullbackParentLinkCardText`、`afterDeleteNewChildB`、`loadedWorkdirImpl`）。修前的事件序列：第四則被父對話處理（父模型 1 次），第五則也沒開新子對話。
- 修後：13 項全過。事件序列：`main_chat` → `child`（開 A）→ `main_chat`（貓，仍在父對話）→ `child`（拉回 A）→ `child`（刪 A 後開 B）。

### 案例句子的調整（照實寫）

- 第一版第五則用「來一首音樂的歌」，結果沒開新子對話。原因：S2 既有的延續句規則（`topic_local.js` 的 `CONTINUATION_RE`）把「來」開頭判成延續，不轉移。這不是 S5 的錯，判準沒有改，只把案例句子換成「幫我寫一首搖滾音樂的歌」。

### 行為上要知道的事

- 在 S3 之後，每個新話題都開子對話，所以父對話的 `pastTopics` 幾乎不會再有項目（只有開子對話失敗時才會留）。`matchedTopicId` 命中父對話舊話題的路徑（a）因此很少走到，保留是為了與 S2 行為相容。
- 「第三則回到畫貓」在這個設計下是「同一話題」（父對話的目前話題仍是貓），不是「拉回」，因為貓不是被推出去的話題。評估的判準是「父對話處理、沒有新子對話」，兩種路徑都符合。

## 步驟 2：`@對話名稱`（commit `8979cb2c`）

- `_mentionMenuInit`（主檔 100529）：輸入 `@` 出現自動完成（`AiChatTree.listMentionCandidates`，本機在前，名稱含空白用 `@[…]`）。選取用 Enter／Tab，移動用 Up／Down，Escape 關閉。監聽放在 document 捕捉階段，選取時先於送出處理，所以選取時不會送出。掛在 `_wireSlashCommandMenu`（主檔 108576，呼叫點 108683）。
- `_mentionPrepare`（主檔 100504）：送出時用 `resolveMention` 解析，回傳 `{blocked, message, hint}`。
  - 同名或遠端只用對話名（歧義）→ `blocked`，不送出，輸入框保留原文，狀態列提示補完整名稱。
  - 找到 → `hint`：「`[提及對話] 使用者提到對話〈名稱〉(id=…,節點=…,狀態=…,摘要:…)`」，以隱藏的 system 訊息（`_mentionHint: true`）送進 `this.messages`，只給模型看。
  - 找不到 → 當一般文字，沒有提示。
- `_submitChatInput`（主檔 100590，`_mentionPrepare` 呼叫點 100599）：每次送出先移掉上一則的提示，所以提示只活一輪。使用者看到的文字一律不變。
- 渲染：system 訊息的開頭不在白名單內，所以是 `hidden-system`（主檔 107172）。

### 評估

`scripts/eval/chat_mention.eval.js`，換埠 17964，假 LLM。

- 修前：`acShowsOnAt`、`acLocalFirst`、`acEnterInsertsName`、`acBracketInsertForSpace`、`sendHintInRequest`、`ambiguousNotSent` 失敗（6 項）。`notFoundSentAsPlain`、`sendVisibleTextUnchanged`、`notFoundNoHintInReq` 本來就成立（不改原文、找不到不加提示）。
- 修後：11 項全過。

## 步驟 3：父對話的子對話工具（commit `cb2aad8a`）

- 註冊（主檔 61087、61095、61107）：`chat_list_children`、`chat_send_to_child`（`{chat_id, message}`）、`chat_get_child_summary`（`{chat_id}`）。描述都寫「只在已經有子對話時有用」。
- 過濾（主檔 74793 `_subchatToolFilter`）：`_getRootToolNames`（主檔 74812）三個回傳點都套用。目前對話沒有子對話 → 三個工具從清單拿掉，清單與之前完全相同。
- 目標檢查（主檔 74802 `_subchatToolTarget`）：只能操作本機、且 `parentId` 是目前對話的子對話。非子對話 → `這不是目前對話的子對話`；遠端（`nodeName` 有值）→ `遠端對話不能用這個工具…`。
- `chat_send_to_child` 回傳 `{ok, mode, status}`，`mode` 是 `turn`（閒置，開新一輪）或 `steer`（子對話正在回應，走插話）。

### 評估

`scripts/eval/subchat_tools_ai.eval.js`，換埠 17965，假 LLM。

- 修前：6 項失敗（工具不存在）。沒有子對話時的工具清單校驗值 `count 6, hash 935053194`（這是之後的回歸基準）。
- 修後：10 項全過。沒有子對話時的校驗值仍是 `count 6, hash 935053194`（與基準相同）；有子對話時 `count 9`。
- 假模型呼叫 `chat_send_to_child` → 子對話多一輪（使用者訊息「補充：用水彩風格」進子對話）、工具結果 `{"ok":true,"mode":"turn",...}`。

## 步驟 4：回歸

真桌面版，建置為步驟 3 之後的工作目錄（`cb2aad8a`）。

| 評估 | 結果 | 說明 |
|---|---|---|
| `topic_local` | `allPass: true`（13 項） | 第一次跑 2 項失敗（見下），判準修正後全過 |
| `chat_tree` | 全部 true（21 個布林值） | 沒有 `allPass` 欄位，人工確認沒有 false |
| `chat_tree_index` | 全部 true（8 個），false 0 個 | 沒有 `allPass` 欄位 |
| `read_ledger` | 沒有內建判準，人工判讀 | 3 個 false 都是「沒有下一頁／沒有警告」，正常值。`renderer/src/agent/read_ledger.test.js` 12 項通過 |
| `subchat_open` | `allPass: true` | |
| `subchat_link` | `allPass: true` | |
| `subchat_card_request` | `allPass: true` | |
| `subchat_bubble` | `allPass: true` | |
| `subchat_send` | `allPass: true` | |
| `subchat_tools` | `allPass: true` | 第一次跑 `sameNameSet` 失敗，判準修正後全過（見下） |
| `subchat_form` | `allPass: true` | |
| `subchat_fap` | `allPass: true` | |
| `subchat_reload` | `allPass: true` | |
| `subchat_pullback`（新） | `allPass: true`（13 項） | 步驟 1 |
| `chat_mention`（新） | `allPass: true`（11 項） | 步驟 2 |
| `subchat_tools_ai`（新） | `allPass: true`（10 項） | 步驟 3 |
| `tool-budget` | `ok: false`，1 筆 `domain_too_many_tools:skill_54f871ce-…` | 與 S4b 文件記錄的一筆同類既有違規相同（S4b 那次 skill ID 不同，所以這裡只說「同類」）。我的三個工具是根層級工具，不計入領域工具數。**沒有在改動前後各跑一次比對**，所以這個「沒有增加」是依文件記錄與工具性質推論，不是量測結果 |

### 第一次跑失敗、判準修正的兩處（都是 S5 有意的改變，不是放寬）

1. **`topic_local` 第四則**：原本預期「命中舊話題」（`matchedTopicId` 有值、`isShifted: true`），改成「同一話題」（`isShifted: false`，原因 `same-topic`）。原因：步驟 1 讓開出子對話後父話題還原成貓，所以「再畫一張狗的圖」是父對話目前話題的延續，不再是被推出去的舊話題。結果不變：不轉移、不開新子對話、沒有摘要。判準名稱由 `onMatchedOnReturn` 改為 `onReturnStaysInParent`。
2. **`subchat_tools` 的 `sameNameSet`**：原本要求父與子的工具名稱完全相同。S5 起父對話多出三個子對話工具，子對話沒有（子對話不再有子對話）。判準改為「父扣掉三個後等於子清單，且三個只出現在父對話」。

### 沒有子對話時的工具清單（步驟 3 的回歸）

`subchat_tools_ai.eval.js` 記錄的校驗值：沒有子對話時 `count 6, hash 935053194`，修前後相同。有子對話時 `count 9`。

## 驗證範圍（誠實列出）

- 真桌面版驗證過：步驟 1–3 的三個評估（修前、修後）與回歸（見下）。
- 沒有驗證：真實使用者訊息上的拉回誤判率（門檻沿用 S2，只用案例校準）。
- 沒有驗證：`@` 自動完成的實際畫面位置與手機寬度（只驗證 DOM 與送出行為）。
- 沒有驗證：`hidden-system` 的提示在畫面上確實不顯示（只讀渲染程式的判準，沒有截圖）。
- 沒有做：S6（遠端統一，遠端 `@` 與遠端子對話工具都還不支援）、S7（批次刪除）。

## 教訓

1. **子對話開出後，不能把子對話的話題留在父對話身上。** 第一次做拉回時沒有還原父對話話題，`pastTopics` 裡的音樂話題變成父對話的候選，第五則「幫我寫一首搖滾音樂的歌」被父對話接走，沒開新子對話。下次只要「建立子對話」這件事會動到父對話的狀態，就要列出父對話的狀態欄位（`topicData.fingerprint`、`pastTopics`、`_lastTopicShift`）逐一確認。
2. **評估的句子要先排除既有規則。** 「來一首音樂的歌」被延續句規則吃掉（S2 的 `CONTINUATION_RE`），看起來像拉回壞掉。先用 `detectShift` 的 `reason` 看是哪一條規則，再決定是改句子還是改判準。這次只改句子。
3. **來源檢查的判準只能看函式本體。** 寫在方法上方的註解不在 `String(fn)` 裡，`loadedWorkdirImpl` 因此誤判成 false。判準要用本體裡的字串常值（例如工具名稱）。
4. **工具清單的過濾要在 `_getRootToolNames` 的每個回傳點都套用**（`off`、`intent`、預設三條路徑）。只改預設路徑，`off` 模式下新工具就會一直出現。
6. **回歸紅燈先查是哪個判準、為什麼。** 這次兩個舊評估變紅（`topic_local`、`subchat_tools`），都是 S5 的有意改變造成的；判準的修正寫在評估檔的註解與本文件的回歸段落。下次若要改判準，先確認結果的「使用者看得到的部分」（開不開子對話、有沒有摘要、父模型呼叫數）是否不變，只有內部原因字串改變才改判準。
7. **沒有子對話時工具清單要能用校驗值證明沒有變。** 這次用「名稱數量＋字元碼總和」當校驗值，修前後數字相同即可，比逐字比對清單簡單，而且能寫進文件。
