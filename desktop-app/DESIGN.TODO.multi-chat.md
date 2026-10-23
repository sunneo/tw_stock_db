<!-- 從 TODO.md 拆出（2026-10-23）：內容原封不動，只是改成一份一個主題。 -->

# TODO: 多對話並行背景執行 + chat list UI（進行中沙漏／未讀圖示／正確的最後更新時間）

## 使用者需求（原話整理）

1. aiweb跟desktop app除了chat list以外，可以在對話進行中切換chat list，切過去時「不受影響、
   繼續執行」——也就是切走不會中斷正在跑的那個對話。
2. 更新的內容/進度要「清楚知道自己是來自哪個對話」，正確更新回原本發出請求的那個對話，不是
   誤更新到「使用者現在正在看的那個對話」。
3. chat list每一項要有狀態圖示：
   - 對話還在執行中（尚未完成）→ 顯示類似沙漏的「進行中」圖示。
   - 對話已完成、但使用者還沒點進去看過結果 → 顯示「未讀」圖示。
   - 點進去看＝已讀，未讀圖示消失。
4. **已知bug**：目前「只要點一下chat list裡的項目（切換過去看）」，那個對話的「最後更新時間」
   就會被更新——這是錯的，最後更新時間應該只在「真的有新內容（新的user訊息/AI回應）加進那個
   對話」時才更新，單純切換過去查看不算。

## 已確認的根本原因：整個引擎目前只有「一個對話」的全域可變狀態

追查`_chatSwitch`/`_chatBusy`（`renderer/src/floating-assistant.js`）後確認：

- `this.messages`（目前對話的訊息陣列）、`this.isResponding`（是否正在等LLM回應）、
  `this._chatIndex.currentId`（目前作用中對話的id）**全部是`this`instance上的單一全域欄位**，
  不是「每個對話各自獨立」的狀態。
- `_chatBusy()`（`_chatSwitch`/`_chatNew`/`_chatDelete`共用的守門）直接檢查
  `this.isResponding`，**只要有任何對話正在等回應，整個chat list就完全鎖死、不能切換／新增／
  刪除**（`_chatBusy()`裡甚至會印出「AI 回應中，請先按 Stop 或等它完成」）。這證實使用者要的
  「切走不中斷」目前完全不支援，不是bug、是架構上根本沒做。
- 所有寫回存檔的地方（`_persistChatHistory()`全專案30處呼叫、`_touchCurrentChatMeta()`）都是
  無條件對`this._chatIndex.currentId`（**當下UI正在顯示的那個對話**）動作，不是對「這次回應
  真正屬於哪個對話」動作——如果將來真的放開`_chatBusy()`的限制、讓回應在背景繼續跑，現有這套
  寫法會直接把在背景完成的回應寫進「使用者切換過去、現在正在看的那個不相干的對話」，資料會
  互相污染。這也是使用者回報「最後更新時間」問題最可能的根因方向之一：`updatedAt`從來不是
  「這個對話真的被寫入新內容」才觸發，而是耦合在同一份global mutable state上，任何時序上的
  巧合都可能造成觀感上「切換=更新時間」。

**結論：這不是一個小bug修正，是要把「單一全域對話狀態」改成「每個對話各自獨立的執行狀態」的
架構調整**，範圍跟nvim-wasm整合是同一個量級，需要同樣分階段進行、每階段各自驗證。

## 執行階段（尚未開始）

- [ ] **階段0：盤點目前所有讀寫`this.messages`/`this.isResponding`的地方**
  - [ ] 列出`executeChat()`主迴圈、工具呼叫處理、`delegate_to_subagent`委派、
        `pruneContext()`/`_checkTopicTransition()`壓縮邏輯等所有直接讀寫這兩個欄位的函式
        （這些之後都要改成吃一個「對話執行context」參數，不能再假設只有一份全域狀態）
  - [ ] 盤點畫面渲染面（`_renderMessageHistory`/`_renderChatList`等）目前怎麼假設「畫面上顯示
        的就是`this.messages`」，改動後要能「畫面顯示對話A，但對話B在背景繼續跑」而不互相干擾

- [ ] **階段1：設計「每個對話一份獨立執行狀態」的資料結構**
  - [ ] 例如`this._chatRuntimes = Map<chatId, { messages, isResponding, abortController,
        turnPruneCount, ... }>`，取代目前直接掛在`this`上的單一全域欄位
  - [ ] `_chatSwitch()`改成「只是換畫面顯示指到哪個runtime」，不再需要`_chatBusy()`擋著不能切
        （在背景執行中的對話依然用它自己那份`_chatRuntimes.get(id)`繼續跑，不受畫面切換影響）
  - [ ] 明確定義「目前正在畫面上顯示」跟「目前正在背景執行」是兩個獨立的概念（可以同時有好幾個
        對話在背景執行，畫面永遠只顯示其中一個）

- [ ] **階段2：改寫所有持久化/更新邏輯，明確帶入chatId**
  - [ ] `_persistChatHistory()`/`_touchCurrentChatMeta()`/`_writeChatBlob()`全部改成接受明確的
        `chatId`參數（不是隱含用`this._chatIndex.currentId`），呼叫端從對應的`_chatRuntimes`
        entry取得，確保背景對話完成時寫回的是它自己真正的那個chatId，不是使用者當下正在看的
        chatId
  - [ ] `updatedAt`只在「這個chatId真的被寫入新訊息內容」的那一刻更新（確切定位在
        `_writeChatBlob`/`_touchCurrentChatMeta`實際被content-changing事件呼叫到的那幾個點——
        單純畫面切換／查看不能觸發這條路徑），修正使用者回報的「點一下就更新時間」

- [ ] **階段3：chat list UI狀態圖示**
  - [ ] 每個`_chatRuntimes` entry增加`status`欄位：`idle`/`running`/`done-unread`/`done-read`
  - [ ] `_renderChatList()`依`status`在對應的`.cl-item`上畫沙漏（running）或未讀圓點/圖示
        （done-unread）
  - [ ] `_chatSwitch()`切換進某個對話時，如果該對話目前是`done-unread`，切換動作本身要順便把
        狀態改成`done-read`（「點進去看＝已讀」），並重繪chat list清掉未讀圖示
  - [ ] 對話從`running`變成完成的那一刻：如果使用者「當下正在看」這個對話＝不用顯示未讀（直接
        算已讀，因為畫面上已經看得到結果了）；如果使用者當下在看別的對話＝標成`done-unread`

- [ ] **階段4：中斷/錯誤處理**
  - [ ] 背景執行中的對話如果中途出錯/被中止（例如使用者按了Stop，但Stop目前的實作可能也預設
        「只能停目前顯示中的對話」，要確認改成能指定停哪一個chatId的背景執行），狀態要正確降級
        （不能卡在`running`）
  - [ ] 分頁/App關閉、重新整理時，背景執行中的對話（還沒完成）狀態怎麼處理——目前完全沒有
        「背景執行」這個概念，重新整理會不會直接把進行中的回應弄丟需要一併考慮

- [ ] **階段5：資源/併發上限**
  - [ ] 使用者可能同時開很多個對話、每個都在背景跑——要不要限制同時背景執行的對話數量（避免
        無限制併發打爆API rate limit/瀏覽器資源），如果要限制，超過上限時新的請求怎麼處理
        （排隊？還是拒絕、提示使用者先等其他背景對話完成？）
