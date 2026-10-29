# 交接文件：讓 floating-assistant 的 AIDoc 跟上 Redmine 外掛的「除錯定位器」（handoff 1，2026-10-29）

## 1. 開場提示（給接手的工作階段）
Continue from the handoff document at `D:\Downloads\videos-嗨投資-desktop-app\desktop-app\DESIGN.TODO.aidoc-locator-port.md`. 先完整讀完（含使用者原話與做法備忘），照做。執行 low-context-long-run 技能（門檻 30%）：做 Todo 的第一項，context 到門檻就更新這份文件並啟動你的接手工作階段。第一則訊息用一行說明你讀完了、要開始哪一項。回覆一律繁體中文、不要夾英文縮寫。

使用者的關鍵指示（逐字）：「我要請你改的不是redmine, 是讓我們floating-assistant的AI跟上aidoc的修改」、「我是給你資料，讓你跟上!」、「含中文的句子也可能是有log，這部份請在裡面建立domain/subagent跟tool/recipe」。

## 2. 概況
- 目標：把 Redmine 外掛 `D:\Downloads\redmine_ai_chat` 的 AIDoc「除錯定位器」（設計見該資料夾 `DESIGN.aidoc-locator.md`；程式在 `assets/javascripts/ai_chat_aidoc_{trace,elf,sql,worker,viewer}.js`、`ai_chat_aidoc.js` 的 `locate`（765–945 行）、`test/aidoc/*`）移植到本專案（桌面版＋網頁版共用的 `renderer/src/floating-assistant.js`）。分支 `desktop-app`，工作目錄 `D:\Downloads\videos-嗨投資-desktop-app\desktop-app`。
- **已提交**：`AIDoc 除錯定位器移植（一）`——`renderer/src/aidoc/trace.js`、`elf.js`（UMD，全域 `FaAidocTrace`／`FaAidocElf`，`scripts/embed-code-ui.js` 的 `embedAidoc()` 嵌入）、測試 `scripts/aidoc-tests/{trace,elf}.test.js`（trace 67 項過；elf 需要 Linux 的 gcc／addr2line，這台 Windows 沒跑＝未驗證）。
- **已改、尚未提交、尚未跑測試**：`renderer/src/sql/index_core.js`（schema 1→3：表 `logmsgs`、`calls_raw`→`calls`、meta `tree_ref`；builder.addFile 吃 `rec.logs`／`rec.calls`；finalize 收 `o.treeRef`；reader 新增 `schemaVersion／hasTable／treeRef／filesByName／logCandidates／callers`）、`scripts/sqlite-index.itest.js`（新增「除錯定位器（schema 3）」測試）。**接手第一件事：跑這個測試**（要 Electron 當 Node：`ELECTRON_RUN_AS_NODE=1 <scratchpad>/el_test/app/FloatingAssistantApp.exe scripts/sqlite-index.itest.js`；使用者上一次拒絕了我直接執行這條，**先問或改用別的方式**），通過再 `node scripts/embed-code-ui.js` 把 index_core 重新嵌進主程式，然後提交。
- 沒部署、沒發布。Redmine 資料夾我誤改過（`ai_chat_aidoc_viewer.js`、`aidoc-viewer.html`、`test/aidoc/ask_trace_e2e.js`、三份文件），使用者說改錯對象；**不要再動 Redmine 資料夾**，是否還原問使用者。

## 3. Todo（依序）
0. （2026-10-29 更新）索引測試已不再被拒絕（先前是誤觸），可直接用 Electron 當 Node 跑；`mcp__ccd_session__start_session` 現在可用（要先 ToolSearch 載入，不是沒有這個工具）。此項以下的舊說明已過時，實際進度看文件最後的「進度」一節。
1. （已完成 2026-10-29：index 測試 6 項全過，已嵌入）
2. 建索引時抽 log 與呼叫邊：`floating-assistant.js` 的 `_faRepoExtract(path, text, opts)`（約 3939–4127 行）回傳值加 `logs: FaAidocTrace.extractLogs(text, lang)`、`calls: FaAidocTrace.extractCalls(text, lang, symbols)`，`sv` 升到新抽取版本；`_repoMapPutFile` 的記憶體地圖與 `ctx.sqlB.addFile` 傳下去（約 59033、59876 行）；續建時舊 `sv` 的檔案自動重新分析（約 59661 行，比照 cs 的做法）；`tree_ref` 由 `.git/HEAD`（含 `packed-refs`）讀出，傳給 `builder.finalize({treeRef})`。
3. 主機 `locate`（對照 Redmine `locate`／`locateChains`／`locateMessages`／`locateText`）＋ `repo_ask` 新動作 `locate`／`callers`／`check_citations`（`_repoAskRun`，約 58164 行）＋ `/aidoc locate [--elf…]`；工具說明文字用中文引號，不要反引號 code span。
4. 檢視器自由提問：`renderer/src/aidoc-viewer.template.html` 的提問框改多行（Enter 送出、Shift+Enter 換行、Ctrl+Enter 問 AI）；兩處 `/api/ask`（約 56263、58110 行）先走 `locate`，AI 只說明（發生點／什麼問題／誰造成），回答後 `FaAidocTrace.checkCitations` 核對。可參考我在 Redmine 做的 `traceTextOf`／`runTraceAsk`（`ai_chat_aidoc_viewer.js`）。
5. **含中文的句子也可能是 log**（使用者要求）：不能用「含 CJK 就是使用者的話」。做法＝以索引當裁判（索引的 log 格式字串逐字比對，沒對上就不顯示、不吵）＋ `trace.js` 的 `isMessageLine`／`extractLogs` 接受中文固定文字（會改索引內容，要再升抽取版本與 migration）＋ 建 domain（`code_debug`）、subagent（`log_triage`：封閉選擇題 A=使用者的話／B=log／C=堆疊，程式驗證）、tool（`log_triage`）、recipe（離線小模型版，參考 `DESIGN.recipes.md` 的概念與本專案 `renderer/src/recipe/`）。
6. 測試、`node scripts/embed-code-ui.js && node build-assistant.js`、測試版驗證（`scratchpad/el_test/deploy3.sh`）、補 `features/ai-features.yaml` 清冊、文件、發布（`PUBLISH_TRAILER="Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" bash scripts/publish.sh -m "…"`，只在使用者說「發布」時）。

## 4. 做法備忘（使用者的規則）
- 繁體中文、結論先說、不要在中文裡夾英文縮寫；做完誠實說哪些沒驗證。
- 改來源模組（`renderer/src/aidoc/*.js`、`renderer/src/sql/index_core.js`），再 `node scripts/embed-code-ui.js && node build-assistant.js`；不要改嵌入後那份。
- 資料庫結構或記憶格式有改，必須定義版本與 migration（舊索引能讀、定位器明講「請重新建立索引」，新建一律新版）。
- 編譯前會清工作目錄：做到一半也先 commit。給了順序就做到底，不要中途問「接著做哪個」。
- 熱更新名單別擴大（使用者否決過）；不要要求使用者重裝。

## 5. 使用者原話（逐字，2026-10-29）
- 「redmine這邊aidoc有加強trace (backtrace)與自由詢問的能力，例如給一包code, 在aidoc給一個自由提問的視窗，我們可以問他exception的發生點在哪，是什麼問題，某個錯誤訊息是誰造成的」
- 「我要請你改的不是redmine, 是讓我們floating-assistant的AI跟上aidoc的修改」
- 「我是給你資料，讓你跟上!」
- 「所以你不應該沒有任何修改!」
- 「你剛改錯對象?」
- 「含中文的句子也可能是有log，這部份請在裡面建立domain/subagent跟tool/recipe」
- 「更新網頁，發布patch」（標準發布指令）；「你不知道要呼叫subsession?」；「現在這個對話的context多大了 ？！」

## 6. 交接流程（自我遞迴）
執行 low-context-long-run 技能：每個批次邊界用 `mcp__ccd_session_mgmt__get_usage` 看 context，≥30% 就更新本文件、提交、用 `start_session`（fresh）啟動接手，確認後 `mark_completed`＋`archive_session`。`start_session` 是延遲載入的工具，先用 ToolSearch（query 為 select:mcp__ccd_session__start_session）載入再呼叫，不是沒有。

## 7. 陷阱
- shell heredoc／Python 字串裡的反斜線與引號會被吃掉或弄亂（`\n` 變真換行）；改檔用 Edit／Write 工具，需要換行字元用 `chr(10)`。
- `scripts/embed-code-ui.js` 是 CRLF 檔；Edit 後要統一行尾。
- 這台 Windows 的 Node 沒有 `node:sqlite`，資料庫整合測試要用 Electron 當 Node。
- 使用者曾拒絕我直接執行 `FloatingAssistantApp.exe` 跑測試的指令。

## 進度（handoff 3，2026-10-29，Sonnet 5.5）
- 已完成並提交：index 測試 6 項過；建索引抽 log／呼叫邊（sv 5）與 tree_ref；repo_ask 的 locate／callers／check_citations；/aidoc locate／callers；檢視器多行提問框與先定位後說明；中文 log；log_triage 工具＋FaLogTriage 食譜（測試 13 項）＋ code_debug 子代理 domain；清冊 aidoc-locator。
- **未驗證**：主機端 _repoLocate／檢視器端到端／log_triage 工具在桌面版實跑；ELF（/aidoc locate --elf）尚未移植（elf.js 只有純函式模組，沒接主機）；測試版驗證（deploy3.sh）未做。
