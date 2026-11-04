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

## 步驟 5 結果（新訊息入口與中止收尾歸零）

- 歸零位置：`executeChat` 入口（與 `_writeEvidence` 同一處，約 102424 行）；原生迴圈的中止分支（AbortError）與失敗收尾（錯誤紀錄前）。提交 d3739203。
- 評估 D（新訊息入口）、E（中止收尾）：修前（用 setter 忽略歸零來模擬）第二輪被提醒三次並帶警語；修後提醒 0 次、無警語。
- 誠實註記：修前是模擬（setter），不是拿舊 commit 重跑。

## 步驟 6 結果（串流文字式路徑與離線迴圈）

- 串流文字式路徑：`_loopFetch` 的純文字回答分支（`else`，約 103130 行）。工具結果在 `_noteReadLedger(task.fnName, JSON.stringify(parsedArgs), result)`（約 103090 行）。評估 F：修前只讀第一頁；修後讀完三頁、無警語。
- 離線 `runAgentLoop`：來源在 `renderer/src/vlm/vlm_core.js`（不是 floating-assistant 的 VLM 區塊直接改）。接受點在 `pc.calls` 為空的回答，handoff 之前。評估 G：修前只讀第一頁；修後讀完三頁、兩次提醒、無警語。
- 離線路徑的 `opts.readLedger === false` 只給評估當修前對照，正式路徑不傳。
- 提交 9f07a267。

## 步驟 7：分頁工具表（會回傳 has_more／hasMore／truncated 的地方）

圖例：已驗證＝讀過來源與參數；未驗證＝只確認回傳格式，參數名稱沒有逐一確認。

| 工具／來源 | 位置（floating-assistant.js，除非註明） | 回傳格式 | 帳本是否涵蓋 | 依據與備註 |
|---|---|---|---|---|
| `parse_uploaded_file`（上傳附件、log） | 60701 起；分頁走 `_pageText` 64555 | `has_more`／`next_offset`（頂層） | 涵蓋（已驗證） | 參數 `file_id`（60716）是來源身分。評估 H 用真的 `_pageText` 驗證：修前只讀一頁，修後讀完四頁。 |
| `coding_read_file` | 60070–60077（參數）；實作 72586–72610 | `has_more`、`next_start_line` | 涵蓋（已驗證參數） | 來源身分 `cwd_abs`＋`path`（ledger 的 `cwd_abs|path`）。`start_line` 不是來源身分，會被排除。 |
| `browser_get_page_text`（瀏覽器分頁） | 60598 起；回傳 66451 | `has_more`（字串提示） | 部分涵蓋（未驗證） | 參數是 `tab_id`，不在來源欄位清單內；後備鍵用其餘參數，所以同一個分頁可以涵蓋，但沒有 `tab_id` 時所有分頁共用 `args={}`。待確認。 |
| `fap_read_file`（File Access Point 檔案） | 讀檔 `_fapReadFile` 約 64560 起；回傳 64580–64604 | `has_more`、`next_offset`、`truncated` | 未驗證 | 參數名稱（預期 `ref`／`path`）還沒有逐一確認。若是 `path`／`ref` 就會涵蓋。 |
| `article_section`（長文章章節） | `renderer/src/tools/article_outline.js` 136 行（`sectionText`） | `has_more`、`next_offset` | 未驗證 | 工具參數（預期 `file_id`）還沒確認。 |
| 技能包參考檔讀取（`chunk.hasMore`／`chunk.nextOffset`，駝峰） | 58319–58324（工具名稱函式 `_syncSkillBundleDomains` 附近） | `chunk: {hasMore, nextOffset}` | 未驗證（格式已涵蓋） | 解析器認駝峰格式（已有 node 測試）。來源身分要看參數是否含 bundle 與檔名，還沒確認。 |
| 文章大綱內部分頁迴圈 | 61476–61477 | 迴圈內讀 `has_more` | 不需涵蓋 | 程式內自己讀到底，不把中間結果交給模型。 |
| 目錄內部分頁迴圈（fap 清單） | 68458–68459 | 迴圈內讀 `has_more` | 不需涵蓋 | 同上，程式內讀完。 |
| 清單輸出截斷（`out.has_more`／`next_offset`） | 71064、71177、71512、71716 | `has_more`、`next_offset` | 未驗證 | 這些是清單輸出的預算截斷，所屬工具沒有逐一確認。 |
| PDF 頁文字 | 94450 附近 | `has_more` | 未驗證 | 所屬工具沒有確認。 |

重點：使用者回報的情境（上傳 log 後讀附件沒讀完）已由評估 H 驗證涵蓋。其他未驗證的項目要在後續逐一確認，不能當成已涵蓋。

## 步驟 7 之後的待辦

- [ ] 逐一確認表中「未驗證」的工具參數，並補上對應評估（尤其 `fap_read_file`、`article_section`、技能包參考檔）。
- [ ] 警語來源顯示 `args={}` 的問題（沒有來源欄位的工具）。

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
- 2026-11-04：離線 `runAgentLoop` 的改動兩度消失。原因：它位於 `floating-assistant.js` 的 `VLM-BEGIN`～`VLM-END` 區塊，`embed-code-ui.js` 每次重建都用 `renderer/src/vlm/vlm_core.js` 整段覆蓋該區塊。下次：改來源模組（`vlm_core.js`），改完跑 `embed-code-ui.js` 後用 grep 確認改動還在。
- 2026-11-04：編輯工具曾回報「檔案在磁碟上被改過」，同一資料夾可能有別的工作階段在改同一個檔。下次：每次編輯後立刻用 grep 驗證，提交前看 `git diff` 只含自己的改動。
- 2026-11-04：評估 G 第一次失敗，是因為評估寫的工具呼叫格式錯了（用 `[CALL:...]`，離線路徑認的是 `<tool_call>` JSON）。下次：寫假模型前先看對應路徑的 `parseToolCalls` 格式。
