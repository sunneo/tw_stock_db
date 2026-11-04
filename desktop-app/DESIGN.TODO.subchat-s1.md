# 子對話 S1（資料模型與側欄樹狀）：定位與決定

> 範圍：只做 `DESIGN.TODO.chat-subsessions.md` 第 10.2 節的 S1。S2–S6 不做。
> 行號以現在的原始碼為準（2026-11-04 核對）。主檔＝`renderer/src/floating-assistant.js`（以下簡稱「主檔」），它是編輯來源；`renderer/floating-assistant.js` 是建置產物，不要改。
> 「找不到」的項目明說，不猜。

---

## 1. 步驟 1：定位（每項附行號）

### 1.1 對話索引結構

| 項目 | 位置 | 內容 |
|---|---|---|
| 索引讀取與預設值 | `_chatListInit` 主檔 79555–79595 | 索引 `{ version, currentId, sidebarCollapsed, groups, chats }`（79560）；讀不到或格式錯就重建（79559–79575） |
| 索引欄位（建立時） | 79570、79577 | `{ id, title, groupId, createdAt, updatedAt }` |
| 其他已存在的索引欄位 | `touched`：79609、79699 附近；`shared`／`remote`：`rg_dispatch.js` 581（嵌入副本在主檔 53473 附近） | `remote = { fromName, fromId, taskId, at, fp }` |
| 沒有的欄位 | 全專案 | 沒有 `parentId`、`status`、`topicId`、`fingerprint`、`summary`、`nodeName`。`grep parentId` 等只命中無關程式 |
| 索引存檔 | `_saveChatIndex` 主檔 79488–79491 | `JSON.stringify(this._chatIndex)` 寫入 `_chatBackend().writeIndex` |
| 單筆查找 | `_chatEntry(id)` 主檔 79493 | `this._chatIndex.chats.find` |
| 後端 | `_chatBackend()` 主檔 79411 起（結尾未核對） | 有 `window.desktopAPI.chats` 用檔案；否則 `FileCache`（設計文件原寫 79409–79431，已偏移 2 行） |
| 新 id | `_chatNewId(prefix)` 主檔 79435 | `${prefix}_${時間36進位}${隨機}` |

### 1.2 建立對話 `_chatNew`

- 定義：主檔 79681–79709，簽章 `async _chatNew(groupId = null)`。
- 「空對話不重複建立」規則：79683–79693。
- 推入索引：79699 `this._chatIndex.chats.push({ id, title: '新對話', groupId, createdAt: now, updatedAt: now })`。
- 之後：`_chatCtxNew(id)` 79702、`_chatActivate` 79704、`_saveChatIndex` 79706。
- S1 要加的選用參數 `{ parentId, nodeName }`：加在這個函式（預設不傳時行為不變）。

### 1.3 刪除對話 `_chatDelete`

- 定義：主檔 79711–79743。
- 過濾掉目標：79723 `this._chatIndex.chats = this._chatIndex.chats.filter((c) => c.id !== id)`。
- 刪除檔案：79726。
- 沒有任何子對話相關的處理（S1 要加：子對話提升為根，見第 5 節）。

### 1.4 重新命名對話

- `_chatRename(id, title)`：主檔 79745–79752，改 `entry.title` 後呼叫 `_renderChatList` 與 `_saveChatIndex`。
- 側欄「更多」選單的入口：`cl-more` 在 79863、79992–80025 附近（只確認到 `_chatRename` 被呼叫於 79974、80025）。

### 1.5 側欄列項目渲染

- 清單渲染入口 `_renderChatList()` 主檔 79835–79881。
- 列項目 `chatEl(c, nested)`：79846 起，`cl-item`、`nested` class 已存在（79848）。
- 標題 `cl-title`：79859。遠端對話前綴 `🌐 `、分享前綴 `📡 `（79859）。
- 依建立時間排序（新在上）：79867 `byTime`。
- 群組分支：79868–79879；無群組的根對話：79880。
- 簽章快取（沒變就不重畫）：`st` 79840、`sig` 79841 附近。S1 的樹狀要把「父子結構、展開狀態」也放進 `sig`，否則收合不會重畫。

### 1.6 節點名稱（遠端）

- 本機節點名稱：`this._rgSettings().machineName`（`renderer/src/remote/rg_host.js:21` 預設值；`rg_host.js:170` 連線後 `_rgSaveSettings({ machineName: room.self.name })`；設定 UI `rg_host.js:719–722`）。
- 預設值形式：`(window.desktopAPI ? '桌面' : '網頁') + '-' + 4 位數隨機`（`rg_host.js:21`）。
- 遠端來源名稱：`job.fromName`（`rg_dispatch.js:575–581`）。
- 嵌入副本：主檔 `_rgCreateRemoteChat` 約 53461–53473；`rg_host.js` 的名稱在主檔對應位置也有副本（主檔 53769 附近是 `nodeName` 的 SVG DOM 用法，與遠端無關，**不是**節點名稱）。

### 1.7 遠端需求建立對話的位置（**設計文件原寫的 822 有誤**）

- **建立**：`renderer/src/remote/rg_dispatch.js:575–588` `_rgCreateRemoteChat(job)`；`rg_dispatch.js:580–581` 推入索引，帶 `shared:true`、`touched:true`、`remote:{fromName, fromId, taskId, at, fp}`。
- 呼叫點：`rg_dispatch.js:532`。
- **822 不是建立**：`rg_dispatch.js:822` 是把遠端訊息丟進已存在對話的 `executeChat('[來自 ' + who + ' 的遠端訊息]…')`。
- 主檔嵌入副本：建立在主檔 53461；呼叫在主檔 53418。

### 1.8 嵌入與建置

- 嵌入腳本：`scripts/embed-code-ui.js`（嵌入範本與純函式）。其中 `read_ledger.js` 以 `READLEDGER-BEGIN`／`READLEDGER-END` 嵌入（`scripts/embed-code-ui.js:65`）。
- 建置：`node build-assistant.js`（產物 `renderer/floating-assistant.js`）。
- 網頁版核心排除清單：`scripts/build-web-lazy.js:16` 的 `EXCLUDE` 集合。`READLEDGER` **在**排除清單內（第 28 項，已核對）。網頁版嵌入的助理沒有對話清單（見 `rg_dispatch.js:577` 註解），所以 `chat_tree` 也不需要在網頁版核心裡，步驟 4 時比照 `READLEDGER` 加入 `EXCLUDE`（決定，理由同此）。

### 1.9 找不到的項目

- 「刪除父對話時連帶處理子對話」：目前沒有子對話，所以沒有相關程式（第 5 節決定）。
- 「對話名稱的 `@` 解析」：沒有既有實作，全新寫。
- `FileCache` 是否底層為 IndexedDB：沒查（不影響 S1）。

---

## 2. 決定（S1 內）

- **同層排序**（步驟 2）：根依建立時間新到舊（與現在側欄一致，回歸不變）；子對話依建立時間舊到新（第一個子對話在最上面，符合對話先後）。
- **子對話數**（步驟 2）：`childCount` 只算直接子對話；收合時也顯示。
- **環與孤兒**（步驟 2）：parentId 指向不存在的對話、自己指自己、互指，都視為根；環上每一筆都當根，掛在環上的其他對話成為它的子對話。理由：側欄絕不能因為壞資料而消失或無限迴圈。
- **`@` 格式**（步驟 3）：本機 `@對話名`；遠端 `@節點名/對話名`；名稱含空白、方括號時用 `@[…]`。**不用引號**（中文輸入常把引號換成全形）。理由：使用者只需要記一種括號。
- **遠端省略節點名**（步驟 3）：只寫對話名、而且只有遠端對話符合時，回傳 `needNode`，不替使用者猜。理由：使用者明確說「標記對話名稱時，要包含節點名稱」。
- **同名**（步驟 3）：完整名稱重複時回傳 `ambiguous` 與候選清單，不自動挑。
- **對話名含 "/"**（步驟 3）：比對拿整段字串跟「節點名/對話名」全文比，不切字串，所以名稱中的 "/" 不會誤判。
- **比對規則**（步驟 3）：忽略大小寫與前後空白；名稱內部空白不合併。
- **刪父對話**（見第 5 節）：子對話提升為根，不連帶刪除。
- **展開狀態**（見第 6 節）：存在索引的 `expanded`；沒有記錄就是收合。
- **模組位置**（步驟 2–3）：全部放在 `renderer/src/chat/chat_tree.js`，一個檔，UMD 寫法（同 `read_ledger.js`），測試在 `chat_tree.test.js`（22 項）。
- **側欄展開鈕**（步驟 5）：父對話前面一個 ▸／▾，後面顯示子對話數；點鈕只切換展開，不切換對話（事件處理先判斷 `.cl-tree-toggle`）。理由：使用者點父對話列是要看內容，點鈕是要收合。
- **明確收合優先**（步驟 5）：`expanded[id] === false` 不會被「目前對話在它底下」自動展開；只有從沒設定過（undefined）的父對話才會為了顯示目前對話而展開。理由：避免使用者收合後怎麼按都收不起來。
- **群組跟父對話走**（步驟 5）：子對話顯示在它的根對話所在的群組，不看子對話自己的 `groupId`。理由：避免同一棵樹被拆到不同群組。群組標題的計數只算根對話。
- **回歸的定義**（步驟 5）：沒有任何子對話時，列表沒有 `.cl-tree-toggle`、`.cl-child`、`.cl-children-count`，列項目 class 名稱與以前相同，順序相同（新到舊）。**沒有與修前的 DOM 逐字比對**（沒有修前的執行環境），這點是結構檢查，不是位元比對。

## 3a. 步驟 5 驗證結果（真桌面版）

- `scripts/eval/chat_tree.eval.js`（換埠 17952）：預設收合（P＝▸ 2）、點展開不切換對話、展開後縮排正確（C1、C2 在 P 底下，G 在 C2 底下縮排 2）、收合整棵子樹、明確收合不被自動展開、未設定時目前對話路徑自動展開、群組計數與成員正確、刪父後 C1／C2 提升為根且 G 仍在 C2 底下、展開狀態寫回後端、沒有子對話時沒有樹狀元件。全部 `true`。
- 步驟 4 的 `chat_tree_index.eval.js` 在步驟 5 改動後重跑，仍全部通過。
- 只有 node 測試：`chat_tree.test.js`（22 項）、`scripts/remote-tests/rg_methods.test.js`（102 項）。
- **沒驗證**：修前與修後的 DOM 逐字比對；真的遠端群組來的對話在側欄的顯示（`nodeName` 寫入有驗證，側欄遠端列的顯示沒有）；網頁版（沒有對話清單，不在範圍）。

## 4a. 教訓（這次走過的錯）

- 設計文件寫遠端建立對話在 `rg_dispatch.js:822`，實際是 575（822 是遠端訊息轉進既有對話）。下次：設計文件的行號先 grep 確認，不要照抄。
- 讀 `build-web-lazy.js` 的 `EXCLUDE` 時只看了前 200 字，誤以為 `READLEDGER` 不在清單裡。下次：列舉清單要用 `tr ',' '\n' | grep` 看完整項目。
- 步驟 4 的評估第一次失敗（`existing_fields_kept` false），原因是既有的 `_touchSig` 邏輯會更新目前對話的 `updatedAt`，與補欄位無關。下次：比對失敗先找出是哪個欄位、再確認是不是既有寫入，不要直接改判準。

## 3. 驗證方式

- 純函式：`node renderer/src/chat/chat_tree.test.js`（步驟 2 起）。
- 真桌面版：`scripts/eval/chat_tree.eval.js`，用 `scripts/eval/run_eval.js` 啟動真 Electron（步驟 5）。
- **步驟 4 已驗證（真桌面版）**：`scripts/eval/chat_tree_index.eval.js`（換埠 17951、全新資料夾）。結果：載入來源為工作目錄的 `renderer/floating-assistant.js`；舊索引載入後 6 個新欄位全為 null；舊欄位不變（`updatedAt` 除外）；補齊後寫回後端，重讀仍正確；`_chatNew()` 不傳選項時不帶 `parentId`／`nodeName`；`_chatNew(null,{parentId,nodeName})` 寫入兩者。
- **步驟 4 未驗證**：遠端需求建立對話寫入 `nodeName`（`rg_dispatch.js` `_rgCreateRemoteChat`）只有讀程式與 `rg_methods.test.js`（102 項，全過）；沒有真的跑遠端群組。
- 步驟 4 的 `updatedAt` 說明：目前對話在載入時 `updatedAt` 會被既有邏輯更新（`floating-assistant.js` 約 79543，`_touchSig`），與補欄位無關，評估檔已排除此欄位比對。

## 4. 教訓

（工作途中若走歪，在這裡新增一條：錯在哪、下次怎麼做。）

## 5. 刪除父對話的處理（決定）

- 決定：**子對話提升為根**（把子對話的 `parentId` 設為 `null`），不連帶刪除。
- 理由：子對話可能有使用者要保留的內容；連帶刪除會讓「刪一個父對話」變成大範圍不可逆的刪除。使用者在第 10 節沒有要求連帶刪除。
- 實作位置：`_chatDelete`（主檔 79723 附近）在過濾之後，把 `parentId === id` 的項目改成 `null`。
- 驗證：步驟 5 的真桌面版評估檔刪父對話後，子對話出現在根層。

## 6. 展開狀態（決定）

- 決定：存在索引的 `expanded`（物件 `{ [chatId]: boolean }`），不放 localStorage。
- 理由：索引已經是這個對話清單的唯一真實來源，與 `sidebarCollapsed`、`groups[].collapsed` 放在一起最一致；localStorage 在清單模式下不會跟著索引搬移。
- 預設：沒有記錄的父對話視為**收合**（符合「預設收在父對話底下」）。
