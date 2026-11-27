# 交接：壓縮工具索引（紅米端設計移植）——現況與下一個待辦：查「抓網頁」出錯的根因

## 1. 開場提示（接手者收到的原文）

請從這份交接文件接手：`desktop-app/docs/HANDOFF.compact-modes-port.md`（repo 根目錄 `D:\Downloads\videos-嗨投資-desktop-app`，分支 `desktop-app`）。完整讀完，包含「使用者原話」與「做事方式」，並照做。執行 low-context-long-run 技能（門檻 30%）：做下一個待辦；脈絡到門檻時寫下一份交接並啟動自己的接手者。第一則訊息用一行確認你讀了文件、要從哪個待辦開始。

使用者原話（逐字，摘要見第 5 節）：「redmine這邊設計了把tools, domain像是藏書閣一樣多層壓縮的方式，並做了subagent cache，讓route subagent (認識所有tool的subagent)進行cache，只有tool變多時才重新壓縮/更新cache 也要讓request_additional_tool支援prompt(roughly) 用描述來申請更多tool 我們這邊也要跟上」

## 2. 概況

- 領導者（發起這條線的工作階段）：`local_49f6c57d-8f18-427b-a8f1-7b1d23efc5f5`（名稱 desktop-app）。回報由系統自動轉給它；要問它才用 SendMessage。
- 已完成並提交（分支 desktop-app，未發布、未推送）：
  - 設計 `desktop-app/docs/DESIGN.compact-tool-index.md`（含實測表，第 6 節）。
  - 純模組 `renderer/src/tools/compact_index.js`（嵌入為 `FaCompactIndex`；測試 `compact_index.test.js`，15 項）。三層索引、內容雜湊快取、描述式比對＋字母選擇題、第 0 層截斷、共用工具摘要只寫一次。
  - 接進 `renderer/src/floating-assistant.js`：開關 `localStorage['fa.compactToolIndex']`，**預設開**（只有 `'0'` 才關）；根層級索引區塊（`_compactRootNote`）、根層級 `request_additional_tools`（`description`／`names`／`choice`）、off 模式收起領域閘門工具（`_compactHidden`）、逃生口（`_compactWiden`、直接呼叫補進 `_compactExtra`）、路由子代理常駐提示（`_compactRouterPrompt`，工具集雜湊沒變就重用、無歷史、不限提問長短）。
  - 關閉時與改動前逐位元組一致：基準 `scripts/eval/baselines/compact-off-baseline.json`（改動前版本 ddbe3276f 抓的），比對腳本 `scripts/compact-off-baseline.test.js`（18 項相同）。
  - 評估檔（真 Electron、假語言模型）：`scripts/eval/compact-tool-index.eval.js`（各模式前後 token、off 模式、逃生口、路由不退步、路由常駐與無狀態）、`scripts/eval/compact-baseline.eval.js`。
- 最後一筆提交：`3f7740cef`（路由子代理常駐化）。之前：`4c89bc7ec`（預設開＋off 模式）、`b60393b2f`（基準）、`d70b163fc`、`c8295948d`、`ddbe3276f`。
- 使用者已發布到 v589～v592（領導者轉述：v589 起預設開；v590～v592 修了重複呼叫與「提到的工具補進」）。**這些版本號是使用者／領導者發的，不是我發的；我不發布。**
- 實測（估算 token，假語言模型）：off 模式 59,200→17,578；其他模式根層級 1,468→4,210（多 2,742）；路由系統提示約 16,987（固定、完整索引；舊的先檢索縮減版 2,010～9,275）；本地組裝約 4.5～8.6 毫秒。

## 3. 待辦（依序）

1. **（進行中，尚未動手）查「抓網頁」出錯的根因，要通用修法**。領導者轉述使用者（2026-11-28）：「這次他犯錯了」。記錄檔 `C:\Users\sunneo\Downloads\ai-conversation-hi-transcript-1795797525766.md`（已讀：問題句「https://www.aiposthub.com/nemotron-parse-open-datasets-document-adaptation-recipe/ 這篇在說什麼」）。現象：
   (1) 模型第一輪直接回「我目前沒有直接瀏覽外部網頁的工具」，沒有 request_additional_tools、沒用 fetch_web_page；
   (2) 接著 `delegate_to_subagent`，domain 卻是 `music`，任務是抓網頁並總結；
   (3) 子代理日誌「🧭 任務符合專用工具：translate_text——已補給這個子agent」（任務文字有「不要翻譯成其他語言」被誤判成翻譯）。
   上一份記錄 `1795794206166.md` 是模型有申請工具、但重打 fetch_web_page 23 次（已在 v590～v592 修）。
   領導者要求逐項查並**印出實際證據**才下結論：
   a. 壓縮索引開著時，這句話實際的根層級系統提示與工具清單給了模型什麼（借用 `compact-tool-index.eval.js` 的做法印出來：模式要用使用者實際的模式，先查預設模式與該使用者設定；`_getFinalSystemPrompt()`、`_getRootToolNames()`、`_buildNativeToolsSchema`）。逃生口為什麼沒觸發（`FaCapReflect.claimsNoTool` 的比對詞是否涵蓋「我目前沒有直接瀏覽外部網頁的工具」；`_noToolClaimNudge` 在哪些條件下直接 return，例如 `_forceNoTools`、已有 delegate_to_subagent 呼叫、counter）。
   b. domain 為什麼是 music：模型自己選的，還是路由子代理（`_compactRouterPrompt`、`_routeTaskToDomains`）選的？（delegate_to_subagent 帶了 domain 參數時走 `_delegateToSubagentDomain`，不經路由；要看模型是不是照 delegate 說明裡的領域清單亂選。）印出路由輸入與輸出；索引裡「網路與瀏覽器」領域（鍵名要查，可能是 `web` 一類，`fetch_web_page` 在 `ph_research` 階段群組與其他領域）有沒有被看到、摘要夠不夠。
   c. 專用工具提示（`FA_TASK_TOOL_HINTS`／`_rootTaskHints`／子代理的「任務符合專用工具」）把 translate_text 誤判：是舊問題還是壓縮索引造成；若舊問題另列。
   d. 關閉壓縮索引（`localStorage fa.compactToolIndex='0'`）時同一句怎麼走，作對照。
   修法要通用：例如「提示裡有網址」這類最常見意圖，任何模式都要直接拿得到 `fetch_web_page`，或第一步就被程式帶到（可接 `_rootTaskHints` 的任務專用工具機制，注意它不能含台股專屬字眼）。補測試；用真 Electron 重現這句話的提示與工具清單（沒有真模型就標明是模擬）。完成後提交（明確路徑），不發布、不推送，回報：根因、證據、改了什麼、測試、未驗證項。
2. 之後的選配（領導者沒要求，先不做）：路由提示若嫌大，可改領域層索引（約 3.5k）；web 版延遲載入未實跑。

## 4. 做事方式（逐條照做）

- 回覆用純繁體中文，句子裡不要夾英文縮寫或術語（程式識別字用英文可以）。
- 不發布、不推送、不合併（使用者說才做；發布用 `scripts/publish.sh`）。提交一律明確路徑，不用 `git add -A`／`commit -a`；提交訊息結尾加 `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`。
- 使用者 build 前會 `git checkout ./`：沒提交的半成品會消失，做到一半也要先提交。
- 改程式用 Edit 工具；修補腳本先用 Write 工具寫成檔再執行（shell 內嵌會吃反斜線，本任務已踩過兩次）。
- `floating-assistant.js` 極大（2MB 以上）：只用 Grep 加小範圍 Read。嵌入區塊要改來源模組（`renderer/src/tools/compact_index.js`），改完 `node scripts/embed-code-ui.js`，再 `node build-assistant.js`（約 2.5 分鐘）才會進 `renderer/floating-assistant.js`；建置產物（`renderer/floating-assistant*.js`、`update-manifest.json`、`web-lazy/`）是發布用，**跑完評估後用 `git checkout -- <那些路徑>` 還原並 `git clean -fdq web-lazy`，不要提交**。
- 預設行為逐位元組不變的規則已改為：壓縮索引預設開；但開關設成 `'0'` 時必須與基準逐位元組一致（改了共用路徑後要重跑 `compact-baseline.eval.js` 並用 `scripts/compact-off-baseline.test.js` 比對）。
- 台股專屬技能只能由台股網頁帶，通用層（含索引模組）不可有站別字眼（單元測試有檢查）。
- 門檻要跟 `contextWindowTokens` 按比例，不要寫死常數。不要建議換模型；失敗訊息附具體事實。
- 真 Electron 評估做法：`bash E:/Temp/claude/1845096e089295dd/eaf34fa0-b767-4943-b585-f7c4459e39cd/scratchpad/run-eval.sh <評估檔名> <輸出檔名>`（若暫存資料夾已被清，照 `reference_real_electron_eval_verification` 記憶：獨立 `--user-data-dir`、寫入 `main-ext-rev.txt`、`FA_DISABLE_MAIN_OVERLAY=1`、`FA_DEBUG_EVAL_FILE`、`FA_BROWSER_CONTROL_PORT=18777`（不可用 17923）；輸出的 `[eval-file] result:` 行是結果；結束後用 Win32_Process 確認沒有殘留 electron）。評估前必須先 embed＋build，否則跑的是舊版。評估檔裡設模式要用 `fa.advancedSettings.multiSubAgentMode = ...; fa._amMode = ...`，不是 `fa.multiSubAgentMode`（那是唯讀 getter）。時鐘會變，比對提示前先 `fa._getGroundingContext = () => '固定'`。
- 別做大範圍遞迴 grep；整套核心測試一天只跑一次，平常只跑動到的測試（`node renderer/src/tools/compact_index.test.js`、`tool_budget_core.test.js`）。
- 歧義自行決定、不來回詢問；做完回報領導者（系統自動轉，最後一則訊息前 400 字是重點：先寫做了什麼＋提交雜湊）。
- 配額：每週約 85%（2026-11-28 重置前）；接近 90% 就停下並寫交接。
- 提交只含自己改的檔：`desktop-app/scripts/publish.sh` 的修改、`bash.exe.stackdump`、`wiki/` 不是我的，別碰。

## 5. 使用者原話（逐字，含領導者轉述的指示）

- 2026-11-27：「redmine這邊設計了把tools, domain像是藏書閣一樣多層壓縮的方式，並做了subagent cache，讓route subagent (認識所有tool的subagent)進行cache，只有tool變多時才重新壓縮/更新cache 也要讓request_additional_tool支援prompt(roughly) 用描述來申請更多tool 我們這邊也要跟上」
- 2026-11-27：「off模式也接  預設打開」（已完成）
- 2026-11-27：「router mode的路由比較像是我們剛說的"認識所有tool的subagent" 他要常駐，但不具備記憶體，可以很快的反應路由」（已完成）
- 2026-11-27：「路由的輸入上限為什麼要有上限  他應該是自由的orchestrator問什麼就可以給出方向」（已遵守：不設上限、不截斷）
- 2026-11-28（領導者轉述使用者原話）：「這次他犯錯了」
- 常駐規則（來自記憶）：「不猜不放棄」「UML design 是達成路線」「已知缺口要現在補完」「有多少release多少」「給了順序就做到底」。

## 6. 交接程序（自我遞迴）

執行 low-context-long-run 技能，門檻 30%。在完成並提交的批次邊界檢查脈絡用量（`mcp__ccd_session_mgmt__get_usage`，需先 ToolSearch 載入）；到門檻就重寫本文件（章節順序不變）、提交（訊息註明是交接）、用 `mcp__ccd_session__start_session`（initiation「user_asked」、context「fresh」、同一目錄、不開新 worktree）啟動接手者，標題含交接次數，提示中逐字引用使用者原話。接手者確認接手後，前一個才可退場；本工作階段是領導者啟動的工作者，退場方式照技能（mark_completed、archive）；若被拒絕就跳過並說明。待辦清空且驗證完成就不再交接，回報完成。

## 7. 陷阱

- 評估用 `Get-Content -Raw`／中文路徑的 PowerShell 腳本會失敗（PowerShell 5.1 與編碼）；用上面的 bash 腳本。
- `git show` 抓舊版原始碼要放到 `/tmp`；覆蓋 `renderer/src/floating-assistant.js` 做基準後要 `git checkout --` 還原。
- 路由提示的 `## 鍵（標籤）` 標頭：解析鍵名用 `^## ([A-Za-z0-9_]+)`，不是 `\S+`。
- `request_additional_tools` 現在一律註冊；關閉時由 `_getRootToolNames` 濾掉；子代理內另有同名偽工具（`_runSubAgentTask`，參數 `need`，也接受 `description`）。
- off 模式開啟時重新呼叫 `_registerBuiltinAiTools()` 會重設 `_domainGatedToolNames`（評估時要先存後還原）。
- 路由請求主體的 `stream` 在送出時是 true（程式寫 false，呼叫層改的），不是本任務造成。
- 領導者啟動的是這條線；使用者發布版本時會用到 `publish.sh`，不要動。

## 8. 更新（2026-11-28，晚於上面各節；上面第 3 節的待辦 1 已完成）

- 已提交：`2f7f89176`（網址／否定句／反思領域）、`d39ad007c`（字母固定、編造名給最接近真工具、網址預先讀——**其中網址部分已被下一筆移除**）、`174a0035e`（移除網址寫死規則；根層級意圖判斷改由路由子代理 `_compactRootRoute`；`docs/AUDIT.repeat-calls.md` 第 9 節）。
- 路由子代理：`_compactRootRoutePrompt`（完整索引、常駐重用）、`_compactRootRoute`（每輪在 `executeChat` 開頭呼叫一次，12 秒逾時，輸出 `{"tools","domains","reason"}`，用索引驗證後把工具補進 `_compactExtra`、領域寫成建議；答不出來只有詞彙比對很有把握才補）、`_compactRouteNote`。評估 `scripts/eval/compact-route.eval.js`（模型是模擬的）。
- **尚未做（使用者 2026-11-28 指定）**：批次大小上限定案——所有批次選項上限 0.4、預設 0.25（按 `contextWindowTokens` 比例，不寫死），避開推理死角 0.5 門檻（`floating-assistant.js` 約 110502 行）；先做三件最大的（藏書閣第 1 層、`summarize_large_text`、`big_content` 分段），各附測試；其餘（藏書閣整理、`article_section` 等）列清單與預估節省、別一次全改。這項要從頭查：先 Grep 各分段大小常數與現有按比例縮放的函式（`chunkSizing`、約 110460 行的比例函式）。
- 還沒驗證：真模型的路由品質與延遲（評估是模擬）；每輪多一次路由呼叫的延遲代價。

## 9. 更新（2026-11-28 再晚）：虛擬領域 general

- 已做：`_syncGeneralDomain`（壓縮索引開著時在 `this.domains` 最前面放虛擬領域 `general`，關閉時刪掉；`executeChat` 開頭同步）、`_clarifyWrap`（子代理回 `{need_clarification,question,options}` 原樣帶回申請者）、所有「退回第一個領域」改指 general（`_noToolClaimNudge`、`_capabilityReflectionText`、`_delegateToSubagentAutoOnce` 路由失敗／空領域）；「工具數最少領域」的啟發式已拿掉；路由提示與根層級路由都認得 general。評估 `scripts/eval/compact-general.eval.js`（模型是模擬的）。
- 還沒做：批次大小上限 0.4／0.25（見第 8 節）；`delegate_to_subagent` 的說明文字沒有告訴 orchestrator 有 general（它只透過退回提醒、available_domains 與路由知道）。

## 10. 批次大小（2026-11-28）
- 所有批次選項上限 0.4、預設 0.25，依 contextWindowTokens 等比縮放（tool_budget_core 的 batchFraction／batchChars）。
- 已改三處：藏書閣第 1 層視窗（_kiWindowChars）、summarize_large_text 分段（_summarizeChunkSize）、big_content 分頁（_pagerBudgetChars）。131072 視窗下 60 萬字元文件：第 1 層 250→7 窗、摘要 100→7 段（真實 Electron 量測，假模型）。
- 待辦（未改）：_getAdaptiveContentBudgetChars 各呼叫點（0.1／0.15／0.25）、article_section、藏書閣更高層。每處估算節省與上面同量級，需逐一加測試。
- 風險：窗變粗（128k 視窗約 96k 字元），摘要品質未用真模型比較。
