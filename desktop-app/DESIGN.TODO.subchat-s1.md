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

（會在後續步驟補上理由。）

## 3. 驗證方式

- 純函式：`node renderer/src/chat/chat_tree.test.js`（步驟 2 起）。
- 真桌面版：`scripts/eval/chat_tree.eval.js`，用 `scripts/eval/run_eval.js` 啟動真 Electron（步驟 5）。

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
