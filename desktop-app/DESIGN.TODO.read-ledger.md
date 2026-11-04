# 讀取帳本（read ledger）：分頁讀取沒讀完就下結論

> 接手者先看這裡：本文件記錄「分頁讀取工具只靠說明文字叫模型繼續讀、工具迴圈沒有強制」的修法。
> 目前狀態：步驟 1（定位迴圈）完成；步驟 2 之後尚未做。

## 總覽

使用者原話（2026-11-04）：
「redmine那邊發生上傳log 結果read attachment自己沒讀完就回應 比方說使用者說查一下裡面有什麼錯誤，結果他回應說報告都是正確的 原因是沒有讀取完畢，所以請根據這個修正設計去處理，看我們有沒有類似問題」

Redmine 端的修正設計：工具迴圈每次工具回傳 `has_more: true` 就記下那次讀取；最後一頁（沒有 has_more）就清掉。

桌面版有類似風險：多個分頁讀取工具回傳 `has_more`／`next_offset`（蛇形）、`chunk.hasMore`／`chunk.nextOffset`（技能包參考檔，駝峰）或 `truncated:true`，但迴圈不擋最終回答。

## 步驟 1 的發現（定位）

檔案：`desktop-app/renderer/src/floating-assistant.js`（壓縮過的長檔，不要整檔讀）

### 主聊天迴圈（原生 tool_calls 路徑）

- `_loopFetch` 第 102581 行：串流路徑入口，有工具時轉交 `_loopFetchNative`（102590）。
- `_loopFetchNative` 第 103176 行起：
  - 第 103284 行：從 API 回應取出 `message.tool_calls`。
  - 第 103388 行：`_pushAssistantMessage` 把這一輪的 assistant 訊息放進對話。
  - 第 103390 行：`if (!toolCalls.length)` 就是「接受最終回答」的地方。目前在這裡只有兩道退回檢查：`_fakeWriteNudge`（宣稱寫入但沒有成功的寫入工具）與 `_claimPathCheck`（宣稱建檔但磁碟上沒有），各最多 2 次。**沒有讀取帳本檢查。**
  - 第 103431–103448 行：逐一執行工具，結果用 `_pushToolResultMessage(fnName, result, { tool_call_id })` 放回對話。
  - 第 103450 行：有工具呼叫時遞迴 `_loopFetchNative(..., 1, ...)`。
- 退回樣板可參考：第 103391–103397 行（`nudge` 以 `role:'system'` 塞回 `this.messages` 後再呼叫 `_loopFetchNative`）。

### 離線小模型路徑（FaVlm）

- `runAgentLoop` 第 7563 行（函式內 `opts.messages` 等，約 7563–7613）。
- 工具結果放回：第 7602 行 `messages.push({ role: 'tool', name, content })`。
- 最終回答：第 7589 行 `if (!pc.calls.length || !useTools.length) return finishFrom(...)`。
- 呼叫端：第 99686、99695、99701 行（`FaVlm.runAgentLoop`）。
- 強制收尾提示：第 7607 行（「請根據上面的資訊直接回答我的問題，不要再呼叫工具。」）。

### 子工作委派（subagent）迴圈

- `_delegateToSubagentDomain` 第 103670 行、`_delegateToSubagentDomainInner` 第 103674 行、`_delegateToSubagentAuto` 第 104319 行、`_delegateToSubagentAutoOnce` 第 104326 行。
- 另有一段 `toolCalls` 處理在第 104945–105043 行附近，與主迴圈不是同一段程式碼。**步驟 3 依指示：不是同一套就只記位置，不改。**

## 總體計畫（四步）

1. 定位迴圈並寫入本文件（完成）。
2. 寫純函式模組 `renderer/src/agent/read_ledger.js` 與 `read_ledger.test.js`，node 測試全過。
3. 把帳本接進主迴圈（第 103390 行的最終回答閘門），每來源最多提醒 3 次，之後放行並加固定警語。重建嵌入與網頁版 EXCLUDE。
4. 真桌面版評估 `scripts/eval/read_ledger.eval.js`：修前失敗、修後被擋、固執放行。

## 待辦

- [ ] 步驟 2：`renderer/src/agent/read_ledger.js`＋測試
- [ ] 步驟 3：接進 `_loopFetchNative`（第 103390 行附近），決定是否也接 `_loopFetch` 串流路徑（需要先確認串流路徑的最終回答判斷位置，約第 103077–103137 行的工具分支）
- [ ] 步驟 3：`runAgentLoop`（離線路徑）是否也要接，待決定（它的 `tools` 與 `handoff` 結構不同）
- [ ] 步驟 4：真桌面版評估

## 步驟 2 完成

- `renderer/src/agent/read_ledger.js`（UMD，同 gui_bridge.js 寫法）與 `read_ledger.test.js`，`node renderer/src/agent/read_ledger.test.js` 11 項全過。commit 7a8dd03a。
- 純函式：`record` 回傳新帳本（不改傳入值）；`ok:false` 不改；駝峰與蛇形都認；只有 truncated 沒有續讀參數的列為 `blocking:false`（只提醒、不阻擋最終回答）。

## 步驟 3 接線（進行中）

- 嵌入：`scripts/embed-code-ui.js` 登記 `READLEDGER-BEGIN/END` → 常數 `FA_READ_LEDGER_SRC`；`renderer/src/floating-assistant.js` 內 `/* READLEDGER-BEGIN */`、`/* READLEDGER-END */` 標記在 `GUIPYWORKER-END` 之後。
- 載入：`_faReadLedgerMod()`（同 `_faGuiModule` 的 new Function 做法）。
- 記錄：`_noteReadLedger(fnName, rawArgs, result)`，在原生迴圈 `_loopFetchNative` 工具執行後、`_pushToolResultMessage` 之前呼叫。
- 閘門：`_readLedgerGate()`，在 `_loopFetchNative` 的「沒有 tool_calls」分支（`if (!toolCalls.length)`，在 `_pushAssistantMessage(finalContent…)` 之前）。有 blocking 且該來源提醒未滿 3 次就 `messages.push({role:'system'})` 後重跑；提醒用完就在 `finalContent` 前加警語放行；放行後帳本與提醒次數歸零。
- 建置：`scripts/build-web-lazy.js` 的 EXCLUDE 加入 `READLEDGER`（核心迴圈一開始就要用，不能拆成延遲載入區塊；不加的話會產生 `web-lazy/chunks/readledger.js`）。

## 還沒做（步驟 3 的缺口）

- 串流路徑 `_loopFetch`（文字式工具呼叫，例如 `[CALL:...]` 的模型）沒有接帳本，只接了原生路徑。這條路徑的工具結果在第 103048 行附近（`task.fnName`）。需要另外評估。
- 離線小模型路徑 `runAgentLoop`（`renderer/src/floating-assistant.js` 第 7563 行）沒有接，依指示只記位置。
- 工具執行出錯（catch 分支）不記帳本，也不影響帳本。
- 帳本只在「放行的最終回答」時歸零；如果這一輪因錯誤或停止而中斷，帳本會殘留到下一輪（待評估）。

## 陷阱

- 不要用 `grep` 直接搜 `renderer/src/floating-assistant.js` 的嵌入常數名（例如 `FA_GUI_BRIDGE_SRC`）：會把整段壓縮字串印出來，吃掉大量上下文。要加 `-l`，或只用 `cut -c1-160` 截斷。
- 嵌入常數 `FA_*_SRC` 的字串是一整行，`Read` 那一段也會很長。

- `floating-assistant.js` 是十萬行壓縮檔，不要整檔讀，只用 Grep 加小範圍 Read。
- 不要提交 `renderer/floating-assistant*.js`、`update-manifest.json`、`web-lazy/*`、`test-reports/*`。
- 驗證「載入的是工作目錄」時，不能用壓縮後的變數名，要用字串常值或行為。

## 步驟 4 結果（真桌面版評估）

評估檔：`scripts/eval/read_ledger.eval.js`，執行：`node scripts/eval/run_eval.js scripts/eval/read_ledger.eval.js 17941`（獨立使用者資料夾、換埠、FA_DISABLE_MAIN_OVERLAY=1；輸出存在 scratchpad）。

- 真 Electron 驗證過：載入的是工作目錄的實作（閘門方法的字串常值「只讀了一部分」、嵌入模組的 `reminderText`／`record` 都在）。
- A 修前（閘門換成 null，等同舊行為；這是模擬，不是拿舊 commit 重跑）：只呼叫一次工具（offset 0）就被接受，最終回答「報告都正確，沒有錯誤。」。重現使用者的 bug。
- B 修後、順從的模型：呼叫 offset 0、1、2 讀完三頁；被擋兩次、提醒兩次；最終回答沒有警語。
- C 修後、固執的模型：只讀第一頁，三次提醒後放行；最終回答前面有固定警語「注意：以下來源只讀了一部分，結論可能不完整：…」。
- 只跑 node 的：`read_ledger.test.js` 12 項全過。
- 沒驗證的：真的線上模型是否聽從提醒（評估用的是假模型）；串流文字式路徑；離線 runAgentLoop。

## 待辦（步驟 4 之後）

- [ ] 串流文字式路徑（`_loopFetch`，`[CALL:...]` 模型）接上帳本。
- [ ] 離線 `runAgentLoop`（第 7563 行）是否接上帳本。
- [ ] 警語的來源顯示：沒有來源欄位的工具，顯示成 `args={}`，應改成工具名稱。
- [ ] 帳本只在放行的最終回答時歸零；中斷的那一輪殘留到下一輪，待評估。
- [ ] 發布前才跑 `node scripts/build-web-lazy.js`（建置產物，留給發布）。

## 教訓

- 2026-11-04：第一版後備來源鍵把 `offset` 算進身分，同一來源每頁的鍵都不同，帳本永遠清不掉，三頁讀完還是被警告。單元測試沒抓到（測試用的工具有 `path`），只有真桌面版評估的情境 B 抓到。下次：來源身分不能包含續讀參數；寫評估時，假工具要刻意沒有來源欄位，測後備路徑。
- 2026-11-04：評估用 `scripts/eval/read_ledger.eval.js` 的假工具有 `offset`，不是 `path`，正好逼出上面的缺陷。
