# 交接：把紅米端的「工具與領域多層壓縮＋路由子代理快取＋描述式申請工具」移植到我們這邊

## 1. 開場提示（接手者收到的原文）

請從這份交接文件接手：`desktop-app/docs/HANDOFF.compact-modes-port.md`（repo 根目錄 `D:\Downloads\videos-嗨投資-desktop-app`，分支 `desktop-app`）。完整讀完，包含「使用者原話」與「做事方式」，並照做。執行 low-context-long-run 技能：做下一個待辦；脈絡到門檻時寫下一份交接並啟動自己的接手者。第一則訊息用一行確認你讀了文件、要從哪個待辦開始。

使用者原話（2026-11-27，逐字）：
「redmine這邊設計了把tools, domain像是藏書閣一樣多層壓縮的方式，並做了subagent cache，讓route subagent (認識所有tool的subagent)進行cache，只有tool變多時才重新壓縮/更新cache 也要讓request_additional_tool支援prompt(roughly) 用描述來申請更多tool 我們這邊也要跟上」

## 2. 概況

- 目標：我們這邊（桌面版／網頁版共用的 `desktop-app/renderer/src/floating-assistant.js`）要跟上紅米端的設計：
  1. 工具與領域像藏書閣一樣**多層壓縮**成精簡索引（每個工具／領域一行摘要，先給索引、要用才載入完整描述與參數）。
  2. **路由子代理快取**：認識所有工具的路由子代理，其壓縮結果快取起來，**只有工具變多（工具集改變）時才重新壓縮／更新快取**。
  3. `request_additional_tools`（我們的名字是複數）要**支援用描述（大致的文字提示）申請更多工具**，不只能用精確工具名。
- 紅米端參考文件（唯讀，別改）：`D:\Downloads\SRC\redmine_ai_chat\docs\HANDOFF-compact-modes.md`。要點：
  - 新增兩個實驗模式 `orchestrator_full_compact`、`orchestrator_thin_compact`；`subagent_mode_base` 對應回舊模式，舊模式提示與工具清單必須逐位元組不變。
  - 壓縮索引模組 `app/models/redmine_ai_chat/compact_index.rb`：`CORE_TOOLS`、`summary`、`build(catalog, core:, budget_chars:)`、`resolve(index, domains:, tools:)`、`reachable?`、`domain_for`。目錄格式 `{領域鍵 => {label, tools => {名稱 => 描述}}}`。
  - 重用既有機制：`prune_to_core!`（只留核心工具、其餘收進暫存）、`expand_domain`、`request_tools`（意圖過濾工具）；索引一次送出，取代「非核心原生 schema＋重複文字清單」。
  - 量測基準：完整 43.9k → 目標約 15k；精簡 17.2k → 目標約 9k（紅米端估算值，不可為達標調估算器）。
  - 可達性測試：至少 40 題典型問題，斷言所需領域／工具在索引裡且能被申請載入（確定性、不跑模型）。
  - 那份文件的「第 9.3 節」有它們現有 prompt／schema 組成的研究，可借鏡。
  - 紅米端的快取細節（路由子代理快取）在該文件**可能尚未寫到**；若找不到，到 `redmine/plugins/redmine_ai_chat`（repo `WebServices`，本機在 `D:\Downloads\SRC\redmine_ai_chat`）查原始碼與最新提交，再決定我們這邊的做法。
- 我們這邊現況（已查，供起點）：
  - `request_additional_tools`、`get_tool_details`、`delegate_to_subagent` 在 `renderer/src/floating-assistant.js`（約 3455 行的元工具集合；約 75864 行起有領域工具申請說明；約 113528 行有各路徑擋 ask_user_card 的處理）。
  - `renderer/src/tools/tool_budget_core.js` 有工具預算相關邏輯，值得先讀。
  - 領域上限檢查：約 51507 行（領域工具 schema token 上限，冷門工具建議移到 request_additional_tools）。
  - 此檔 2MB 以上：只用 Grep 加小範圍 Read，不要整檔讀。
- 本段尚未改任何程式；沒有提交過這個任務的程式變更；沒有發布。
- 本機已提交未推送：`1a0f1e941`（待辦文件）。已發布到 v588。下次發布版本會是 589，但**只在使用者說「發布」時才做**。

## 3. 待辦（依序）

1. **先查資料再設計**（唯讀）：
   a. 讀 `tools/tool_budget_core.js`，Grep `request_additional_tools` 的實作位置（工具定義與處理函式，不是提示文字）、`get_tool_details`、現有領域登錄表（領域鍵、工具描述從哪來）、現有路由子代理（`delegate_to_subagent`／領域路由）如何認識工具。
   b. 讀紅米端原始碼：`compact_index.rb`、`intent_filter_tools.rb`、路由子代理快取（找 cache／digest／工具集雜湊相關程式）。
   c. 寫一頁設計 `desktop-app/docs/DESIGN.compact-tool-index.md`：我們的壓縮層級（領域層摘要 → 工具一行摘要 → 完整 schema）、快取鍵（工具集內容雜湊，工具變多或描述變才重做）、快取存放處（桌面版 userData、網頁版 IndexedDB／localStorage，兩邊都要能退路）、`request_additional_tools` 的描述比對流程。
2. **描述式申請**：`request_additional_tools` 新增 `description`（自然語言）參數；先用程式比對壓縮索引（關鍵字、領域標籤、摘要）給候選，弱模型走字母選擇題由程式確認（遵守 CoLU／封閉題形狀），不確定時回候選清單讓模型選，不可悄悄猜。精確名稱的舊用法必須照舊。
3. **壓縮索引與快取**：新純模組（建議 `renderer/src/tools/compact_index.js`，純函式、可在 Node 測試、不依賴 DOM），含 `build`、`resolve`、工具集雜湊。快取只在工具集雜湊變了才重算。
4. **接進提示組裝**：新增實驗開關（預設關，預設行為逐位元組不變），開啟時送一份壓縮索引取代非核心工具的完整 schema；工具要用時用 `request_additional_tools`／`get_tool_details` 載入。逃生口：模型說沒有工具時程式自動放寬。
5. **測試**：(a) 雜湊與快取失效；(b) 索引預算；(c) 描述式申請的可達性（至少 40 題，含台股網頁自己帶的技能不可混進通用層——見做事方式）；(d) 預設關閉時提示與工具清單與改動前完全一致（先從 HEAD 抓基準）。
6. **量測**：用實際提示 token 數比較前後，如實報告，不調估算。
7. 全部完成、測試通過後：提交（明確路徑），回報使用者；**不發布、不合併、不推送**，等使用者指示。

## 4. 做事方式（逐條照做）

- 回覆用純繁體中文，句子裡不要夾英文縮寫或術語（程式識別字用英文可以）。
- 子工作階段或工作者只寫程式與測試，不發布、不推送；發布只在使用者說「發布」時，用 `scripts/publish.sh`；合併只在使用者說「合併」時。
- 提交一律用明確路徑，不用 `git add -A`／`commit -a`；提交訊息結尾加 `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`。
- 使用者 build 前會 `git checkout ./`，沒提交的半成品會消失：做到一半也要先提交。
- 改程式用 Edit 工具，別用 shell 內嵌修補（反斜線與引號會被吃）；腳本先用 Write 寫成檔再執行。
- `floating-assistant.js` 裡嵌入的區塊要改來源模組，改嵌入後那份會被蓋掉；改完用 `node scripts/embed-code-ui.js` 一類的既有腳本（先查）。
- 台股專屬技能只能由台股網頁帶，通用層不可有程式痕跡。
- 門檻（塞多少內容算太大）要跟 `contextWindowTokens` 按比例，不要寫死常數。
- 不要建議換模型；失敗訊息要附具體事實（狀態碼、耗時等）。
- 一次只開一個 Electron，用獨立 `--user-data-dir`、自選埠（不可用 17923），結束後用 Win32_Process 確認無殘留。別做大範圍遞迴 grep。
- 整套核心測試一天只跑一次；平常只跑動到的測試。
- 紅米端：不要改其共享設定、不讀憑證、不動線上；本任務只讀它的文件與原始碼。
- 管理層（本交接的發起者）工作階段不封存；接手者若是工作者，完成後回報給領導者。
- 配額：每週約 81%（2026-11-27）；接近 90% 就停下並寫交接。

## 5. 使用者原話（逐字）

- 2026-11-27：「redmine這邊設計了把tools, domain像是藏書閣一樣多層壓縮的方式，並做了subagent cache，讓route subagent (認識所有tool的subagent)進行cache，只有tool變多時才重新壓縮/更新cache 也要讓request_additional_tool支援prompt(roughly) 用描述來申請更多tool 我們這邊也要跟上」
- 2026-11-27（呼叫技能時附上的參照，逐字）：`D:\Downloads\SRC\redmine_ai_chat\docs\HANDOFF-compact-modes.md`
- 常駐規則（來自記憶，使用者先前所說）：「不猜不放棄」「UML design 是達成路線」「已知缺口要現在補完」「有多少release多少」「給了順序就做到底」。

## 6. 交接程序（自我遞迴）

執行 low-context-long-run 技能，門檻 30%。在完成並提交的批次邊界檢查脈絡用量（`mcp__ccd_session_mgmt__get_usage`）；到門檻就重寫本文件（章節順序不變）、提交（訊息註明是交接）、用 `mcp__ccd_session__start_session`（initiation「user_asked」、context「fresh」、同一目錄）啟動接手者，標題含交接次數，提示中逐字引用使用者原話。接手者確認接手後，前一個才可退場；管理層不封存。待辦清空且驗證完成就不再交接，回報完成。

## 7. 陷阱

- 我們的工具名是 `request_additional_tools`（複數），使用者說的是單數，指同一個東西。
- `floating-assistant.js` 極大，整檔讀會爆脈絡。
- 預設行為必須逐位元組不變（新機制走實驗開關，預設關）。
- 紅米端是 Ruby 2.6；我們這邊是 JavaScript，移植的是設計不是程式碼。
- 網頁版與桌面版共用同一份程式，快取存放處要兩邊都能退路。
- publish.sh 工作目錄是 CRLF 修改版：發布時才用 `git update-index --assume-unchanged`，之後還原；本任務先不發布。
- 子工作階段若開，簡報要寫明：歧義自決、不來回詢問、不縮小範圍。
