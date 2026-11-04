# 子對話 S7：批次刪除子對話

來源：`DESIGN.TODO.chat-subsessions.md` 第 10 節（使用者 2026-11-04 原話：「也要有工具可以批次刪除子對話」）與 S7 那一列。
範圍：只做 S7。不動 `ask_user_card` 的根層級歸類。

行號以 `renderer/src/floating-assistant.js`（源碼，110382 行）為準；`renderer/floating-assistant.js` 是嵌入產物，不改。

## 步驟 1：定位（本文件）

### 1.1 現有的刪除對話流程

| 項目 | 位置 | 內容 |
|---|---|---|
| 刪除入口（側欄右鍵選單） | 80155 | `{ label: '刪除對話', danger: true, run: () => this._chatDelete(id) }`，在對話項目的右鍵選單裡 |
| 刪除函式 | 79853–79880 | `async _chatDelete(id)`，見下 |
| 確認 | 79856 | `confirm(...)`（瀏覽器原生對話框，不是卡片）；文字含標題與「這個動作無法復原」；若 AI 正在回應會加一行「會一併停止」 |
| 停止進行中的 AI | 79859–79863 | 若 `running.isResponding`：設 `stopRequested`，呼叫 `currentAbortController.abort()` |
| 從索引移除 | 79865 | `this._chatIndex.chats = …filter(c => c.id !== id)` |
| 父對話刪除的提升規則 | 79867 | 底下子對話的 `parentId` 改成 `null`（**提升為根，不連帶刪除**）。S1 步驟 5 的規則，S7 的「只刪子對話」不改這條 |
| 展開狀態 | 79868 | `delete this._chatIndex.expanded[id]` |
| 待送出的 pending | 79869 | `this._chatPendingMap.delete(id)` |
| ctx 快取 | 79870、79873 | `this._chatCtxs.delete(id)`（若不是目前 ctx；目前 ctx 在 `wasCurrent` 分支刪） |
| 存檔刪除 | 79871 | `await this._chatBackend().del(id)`；失敗只 `console.warn`，不中斷 |
| 目前對話被刪時 | 79872–79880 | 切到最近更新的一筆；沒有就新建一筆「新對話」 |
| 存檔後端 | 79505–79512 | `_chatBackend()`：`kind:'files'`，`del: (id) => api.delete(id)`（`window.desktopAPI.chats`） |
| ctx 建立與讀取 | 79753 | `_chatCtxLoad(id)`：快取沒有就讀檔 |
| 索引查詢 | 79621 | `_chatEntry(id)` |
| 側欄重畫 | 79980 起 | `_renderChatList()`；有簽名（signature）比對，變了才重畫，所以索引變動後要把 `_chatListSig = null` 再呼叫 |
| 展開／收合 | 80046–80050 | `_chatTreeToggle(id, wasOpen)` 寫進 `idx.expanded`（false＝明確收合） |

### 1.2 子對話與連結卡片

- 子對話判斷：`parentId` 非空（`renderer/src/chat/chat_tree.js` 的 `normalizeChatEntry`，`parentKeyOf`）。孤兒（parentId 指向不存在者）與環上的節點視為根（同檔 `buildTree`）。
- 父對話的連結卡片：訊息上的可列舉屬性 `m._subchatLink = { childId, title }`（96350、96386；存檔後仍在）。
- 畫面渲染與冒泡：`_subchatLinkDecorate(w, childId)`（96131），狀態來自 `_subchatLinkInfo(childId)`（96191）。刪除後這個函式查不到 entry，`info` 會變成 `{status:null,text:''}`，但**連結卡片本身仍會留在父對話裡**，S7 要明確把它標成「已刪除」且不可再點。
- 點擊連結卡片切換到子對話的處理：107531 起（`if (msg && msg._subchatLink)`）。S7 要在這裡加「已刪除就不切換」的守衛，避免 `_chatCtxLoad` 拋錯。
- 遠端收件對話：`kind === 'remote-inbox'`（103034 有判斷）；S6 建立的收件對話與子對話（`_remoteInboxLink`，79550）。S7 不刪收件對話本身。

### 1.3 工具核准與確認機制（Grep 結果，附行號）

| 機制 | 位置 | 是什麼 | S7 能不能用 |
|---|---|---|---|
| `ask_user_card`（AI 工具） | 61085 註冊；`askCard(spec)` 78029；`askCardFlow` 78045 | 互動卡片，等使用者送出；子對話的卡片會冒泡到父對話（78035） | **不可用**（管理層指示：不依賴 `ask_user_card`） |
| 原生 `confirm()` | 79856（`_chatDelete`）；`deck_template_admin.js` 231 | 瀏覽器阻塞對話框，同步回傳 true/false | **可用**：與側欄刪除同一種確認，AI 工具內也能呼叫（需在使用者可見的渲染程序裡，本專案是桌面版，可用） |
| 電腦操作的原生核准視窗 | 44649–44702（註解「預覽、核准、範圍選擇、中止都在主行程的原生視窗；這裡的工具只能『請求』」） | 主行程原生視窗，先預覽再核准 | 可以，但要經主行程 IPC，範圍大，S7 不採用 |
| 檔案系統授權 `requestPermission` | 64446–64523、109324 | 檔案存取授權，必須是真人點擊觸發（瀏覽器限制） | 不適用 |
| 子對話權限框冒泡 | 96261（`_subchatAnswerFap`）、96269（`_subchatFapRow`） | 子對話的權限框冒泡到父對話連結卡片，點擊授權或拒絕 | 不適用（那是權限，不是刪除確認） |

**S7 的決定（管理層指示內）**：
- 側欄多選刪除：用原生 `confirm()`（與 `_chatDelete` 同一種），對話框文字列出標題與數量；要勾「也刪除進行中的」就改用一個自訂的小確認框（見步驟 4，待決）。
- AI 工具：用 `confirm()` 作為確認機制（不用 `askCard`）。若 `confirm` 不可用（例如非視窗環境），工具只回傳預覽（`dry_run` 等價），不刪。

### 1.4 側欄列項目與核取方塊可以放哪

- 每一列是 `chatEl(c, nested, depth, row)`（80000 起附近的 `const chatEl = …`），`el.dataset.chatId = c.id`，子對話有 `cl-child` 與 `marginLeft`（depth×14px）。
- 多選可放的位置：在 `chatEl` 內、標題前面加一個 `<input type="checkbox" class="cl-select">`，只在「選取模式」打開時顯示（這樣沒有選取模式時，DOM 與現在完全相同，符合回歸要求）。
- 父對話列（有子對話的那一列）右鍵選單或列底下加「刪除選取的子對話」「刪除已完成／失敗的」（按鈕放在父對話展開區的最下面，只在父對話展開且有子對話時出現）。
- 選取狀態存在 `this._chatSelect`（Set，不寫進存檔），切換父對話、刪除後一律清空。

### 1.5 `@` 候選與 ctx 清理相關

- `@` 候選清單：`_subchatChildCandidates()`（96085）。刪除後要重算（它讀的是索引，所以刪索引就會自動更新；但要確認沒有快取）。
- 新 ctx 欄位：若 S7 新增任何 ctx 狀態欄位，要加進 `FA_CHAT_CTX_KEYS`（51020 起的 Set）。S7 原則上不需要新 ctx 欄位（選取狀態放 UI，不放 ctx）。
- 子對話工具的條件註冊：`_subchatToolFilter(names)`（74804）。它用 `SUB = ['chat_list_children','chat_send_to_child','chat_get_child_summary']` 過濾；S7 的 `chat_delete_children` 要加進這個清單，並且同一條件（有子對話才送進工具清單）。
- 工具註冊位置：61097–61125 附近（`chat_list_children` 61098、`chat_send_to_child` 61106、`chat_get_child_summary` 61118）。
- 目標檢查（只能操作本機、parentId 是目前對話的子對話）：`_subchatToolTarget(pid, childId)`（74813）。S7 的刪除工具可重用它。

## 2. 風險（先寫，之後補）

1. **刪除是不可復原的**。AI 工具必須先確認，未確認前不得刪任何一筆。
2. 進行中的子對話（`status === 'running'` 或 `ctx.isResponding`）：預設跳過，勾選才先中止再刪。
3. 父對話提升規則：刪子對話不影響其他子對話；刪的若是「中間層」（有孫），孫要一併刪（管理層決定）。提升規則只在刪「根」時發生，S7 不刪根，所以不會觸發。
4. 連結卡片點擊：已刪除的子對話，點擊要不拋錯。
5. 目前對話若是被刪的子對話，要切到父對話（不是切到「最近更新的一筆」）。

## 3. 待決（自己決定，寫理由）

- 側欄多選：用「選取模式」（不是每列常駐核取方塊），理由：沒有子對話或沒按選取時，側欄與現在完全相同（回歸）。
- 進行中的勾選框：用原生 `confirm()` 分兩段問會很亂，改為：先 `confirm` 列出清單（含進行中數量），若有進行中且使用者按「取消」就直接結束；另外一個獨立的 `confirm` 問「也要刪除進行中的嗎？」。理由：不新增自訂對話框 DOM，維持與 `_chatDelete` 同一種機制。步驟 4 實作時再看是否改成自訂框。

## 4. 步驟 2 起的待辦

- 步驟 2：`renderer/src/chat/chat_delete.js` 與 `chat_delete.test.js`，純函式 `planDelete(chats, {parentId, filter, ids, includeRunning})`。
- 步驟 3：`_chatDeleteMany(plan)`，逐項刪除與清理（見 1.1、1.5）。評估 `scripts/eval/subchat_delete.eval.js`。
- 步驟 4：側欄多選 UI 與確認。評估讀 DOM。
- 步驟 5：AI 工具 `chat_delete_children` 與條件註冊。評估 `scripts/eval/subchat_delete_ai.eval.js`。
- 步驟 6：回歸與文件收尾。

## 5. 教訓

（尚無）
