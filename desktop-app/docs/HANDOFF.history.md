# 交接文件（歷史，原樣保留）

> 2026-11-06 起，起點頁改成 `docs/HANDOFF.md`（一頁）；這份是舊的管理層交接，**逐字保留**（含 v299 時期的概況、Todo、使用者原話、陷阱，與進度補記一到六）。
> 裡面的版本號、「尚未提交／未發布」、「等 jsonl-paging-inv 回報」、Windows 路徑與 `mcp__ccd_session` 工具等描述是當時的狀態，**可能已過期**，要以 `docs/HANDOFF.md` 與 `DESIGN.TODO.md` 的「現況總覽」為準。
> 其中進度補記是另一個工作階段在這份文件上補的、當時尚未提交的內容，一併保留在這裡。

---

# 管理層交接文件（FloatingAssistant 桌面版）

## 1. 開場提示（接手者收到的原文）

請讀完這份交接文件（含使用者原話與做法），照做。你是管理層工作階段的接手者：不寫大量程式，只派工、驗證、發布、回報。執行 low-context-long-run 技能（門檻 30%）；做 Todo 第一項，上下文到門檻就更新這份文件、提交，並啟動你的接手工作階段。第一則訊息用一行說明你讀完了、要開始哪一項。回覆一律繁體中文、不要夾英文縮寫。使用者原話：「請把他們陸續完工，並陸續發布，不要再停下來問。」（下載與安裝除外，要先取得同意並列出檔名、來源、大小。）

## 2. 概況（2026-11-05）

- 專案：`D:\Downloads\videos-嗨投資-desktop-app\desktop-app`，分支 `desktop-app`。發布用 `PUBLISH_TRAILER="Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" sh scripts/publish.sh -m "<說明>"`（在 desktop-app 資料夾），完成後用 `node scripts/release-version.js status` 確認遠端 `manifest.v2` 版本。目前已發布到 **v299**。
- 本日已發布：v291 離線向量檢索；v292 上下文推導；v293 離線接線補齊；v294 單一工具剩餘目標；v295 原生 Basic Pitch／YAMNet；v296 Demucs、Depth、註冊表；v297 Whisper 編碼器；v298 SlimSAM 編碼器；v299 SDXS（CPU 版）。
- 原生 ONNX 已納入註冊表：Basic Pitch、YAMNet、Demucs、Depth、Whisper 編碼器、SlimSAM 編碼器、SDXS。暫緩：midigenai（輸出不一致、整體仍較慢；原因與可改進處見 `DESIGN.native-all-models.md` 9.9）。
- 設計文件：離線 `DESIGN.offline-intent-pipeline.md`；全語音 `DESIGN.live-voice.md`（階段 A 到 I 完成，真人驗證項另列）；原生 `DESIGN.native-all-models.md`、`DESIGN.TODO.native-runner.md`；其餘待辦已合併成 `DESIGN.TODO.md`。
- 進行中：工作階段 `jsonl-paging-inv`（id `local_1386fae1-fba3-43fc-a122-a6c3a182b41e`，Sonnet）正在實作「超大回應轉 JSONL＋分頁器＋視覺模型拆圖斷掉的續傳＋讀取帳本四個缺口」，之後才做 `.jsonl`／`.ndjson`／`.jsonc` 檢視器。設計在 `DESIGN.TODO.md` 的「JSONL 分頁器與檢視器」一節（提交 54ca0765）。它每個小階段獨立提交、不發布，由你驗證後發布。

## 3. Todo（依序）

1. 等 `jsonl-paging-inv` 的回報（系統會以通知送來）。每個小階段：執行 `node --check renderer/src/floating-assistant.js`、`for f in scripts/offline-*.test.js tests/native/*.test.js scripts/music-tests/native_ort.test.js; do node $f | tail -1; done`、新增的測試；確認 repo 根目錄無 `package.json`／`node_modules`；沒退步就發布，再把結果告訴使用者。
2. 若它的上下文到 30% 停下，接手者開新的 Sonnet 工作階段（fresh、use_worktree false），prompt 指向 `DESIGN.TODO.md` 該節的接續點。
3. 待改善（不是待辦，使用者有空再說）：離線新說法命中率（第二組 67%）、離線上下文缺「目前開著的分頁／編輯器種類」、midigenai 原生（快取留子程序）、Linux 原生未實跑、網頁版載入版本未驗證（本機 Node 16 沒有 fetch）。
4. 清理：下載的暫存模型檔（Whisper 編碼器、midigenai、SDXS）在工作階段暫存資料夾，使用者要求時再刪。

## 4. 做法（使用者偏好，照抄規則）

- 回覆用繁體中文，不夾英文縮寫或術語；誠實區分「我驗證的／子工作階段回報的／推測」。
- 有多少 release 多少；沒達標的叫「待改善」，不擋發布；需要真人驗證的另列、不放待辦。已上線的設計文件改名 `DESIGN.*`，不叫 TODO。
- 下載與安裝一律先取得同意，並列出檔名、來源、大小；同意只限當次列出的項目。
- 絕不使用埠 17923；測試設 `FA_BROWSER_CONTROL_PORT` 換埠並用獨立 `--user-data-dir`；不干擾使用者正在跑的桌面版；原生執行器不開 HTTP 或網路通道；repo 根目錄不建 `package.json`／`node_modules`，不清空任何 `node_modules`。
- 子工作階段一律用 `claude-sonnet-5-5`（不用 Haiku）；同一時間只有一個人寫 `renderer/src/floating-assistant.js`（約 10 萬行，只用小 Edit，改完 `node --check`，再 `node scripts/embed-code-ui.js && node build-assistant.js`）。
- 原生：打開原生離線時，只有已實作並驗證的模型走原生，其餘維持舊路（partial native）；失敗退回網頁版。判準：onnxruntime 1.2x 接得起來、速度沒變慢、輸出正確就上。
- 熱更新不准要求重裝；舊欄位只加不改；版號單調遞增。
- 管理層工作階段不封存（保留）；交接後舊管理層只保留，不刪除。
- 每週額度快到 90% 時：先收尾已完成並驗證的階段、發布，再停，不開新的大型工作。
- 這個管理層的記憶在 `C:\Users\sunneo\.claude\projects\D--Downloads-videos----\memory\`（MEMORY.md 是索引）。

## 5. 使用者原話（逐字，2026-11-05 為主）

- 「請把他們陸續完工，並陸續發布，不要再停下來問。」
- 「離線模型統一要走harness迴圈」
- 「我偏好有多少release多少，這只是待改善，不是沒做」
- 「真麥克風你沒有辦法驗證吧?這需要真人  請不用把等待真人驗證的放在todo」
- 「最根本的、核心的聊天/呼叫tool/recipe的有加速  其他的是nice to have  我希望當我打開native offline，如果實作還沒做好，就必須維持舊的作法，就是可以partial native」
- 「我偏好:只要onnx-runtime 1.2x.x 可以接得起來，就算，很少有原生會比wasm肥的，這很怪。有的話肯定wasm版偷偷改了什麼」
- 「速度有變快，保持正確性，這樣就有價值，所以我偏好能接得就都上」
- 「那20個TODO不在我們今天在意的，可以全部合併成一個DESIGN.TODO」
- 「調整離線模型正確性的文件很重要，請最後讓我知道design doc」
- 「我想到一個點子是tool的超大json回應都統一jsonl格式，並提供paginator，要有辦法讓ai可以完整讀完。然後我們viewer也要支援jsonl,jsonc」
- 「缺口要補，以及先把超大回應的轉jsonl，因為像是請vlm去看一張圖拆解，他可能回應6000-8000個物件，結果斷掉。但如果用jsonl，就很好持續傳達」
- 「用subsession」
- 「因為我們往往是根據前後文關係來決定這邊講的是什麼」（離線上下文推導）
- 「為什麼還是todo，不是已經實現了」

## 6. 交接程序（自我遞迴）

執行 low-context-long-run 技能，門檻 30%：在每個批次邊界用 `mcp__ccd_session_mgmt__get_usage` 看自己的上下文；到門檻就改寫這份文件、提交、用 `mcp__ccd_session__start_session`（`initiation:"user_asked"`、`context:"fresh"`、同資料夾、模型 `claude-sonnet-5-5`）啟動接手者，確認接手者回報讀完文件後，舊的管理層工作階段只保留不封存。

## 7. 陷阱

- `git add` 用萬用字元只會加現存檔案，**刪除不會被暫存**（合併 TODO 文件時漏過一次，已補）；刪檔用 `git rm` 或 `git add -A <路徑>` 後看 `git status`。
- 發布腳本最後的網頁版遠端檢查會因本機 Node 16 沒有 `fetch` 而報錯（已知、無害）；真正版本以 `node scripts/release-version.js status` 為準。
- 對跑到一半的工作階段送訊息會排隊，要等它這輪結束才生效；自動通知觸發的回合不能直接 `start_session`（只能提案卡片），使用者自己的訊息觸發的回合才可以。
- 用 heredoc 或內嵌指令寫修補程式會吃掉反斜線與引號，用 Write 工具寫成檔再執行。
- 本機 Python 不能用（WindowsApps 殘根），用 node。
- 刪除工作階段需要使用者批准卡片；已刪除的 Haiku 與完成的子工作階段共 31 個，保留的是管理層交接、音樂作曲家、弱模型 harness 交接與目前進行中的幾個。

## 進度補記（2026-11-05，JSONL 檢視器）

- 使用者要求：「把DESIGN.jsonl-paging.md完成」、「完成後請把狀態更新到STATUS跟HANDOFF」。
- 完成：檢視器支援 `.jsonl`／`.ndjson`／`.jsonc`（階層、原文、表格、匯出 JSON／JSONL／XLSX／SQLite3），已嵌入並建置，測試全過。細節見 `DESIGN.jsonl-paging.md` 第八節。
- 未做：JSONL 超大檔行索引虛擬捲動、真 Electron 畫面實測、發布（尚未執行 `scripts/publish.sh`，未提交）。

## 進度補記二（2026-11-05，多層 JSONL）

- 使用者新增要求：網頁內文、超深結構、AST、UML design、MIDI 音樂設計都用多層 JSONL，可攤平也可還原，讓任意窗口的模型都能做完（原話見 `DESIGN.jsonl-paging.md` 第九節）。
- 完成：網頁三層、flatten／unflatten／expand、AST、UML 轉換器（見該節表格）。
- 下一步：MIDI 音樂設計（先調查 `renderer/src/music/compose_tree.js`、`midi_compose` 資料形狀）；UML 往下鑽的工具接線。發布流程：用 `ssh hungfu.lee@127.0.0.1` 在 desktop-app 資料夾執行 `scripts/publish.sh`（automation 帳號推不上 github）。

## 進度補記三（2026-11-05，第二批）

- 使用者指定三項（原話：「UML 往下鑽的工具接線, MIDI 音樂設計同形式, browser_get_page_text 區塊化」）：三項都已完成並寫進 `DESIGN.jsonl-paging.md` 第九節「第二批」。
- 狀態：已建置、純函式測試通過，**尚未提交、未發布**（發布方式見上一節：`ssh hungfu.lee@127.0.0.1` 後在 desktop-app 執行 `scripts/publish.sh`，使用者要說「發布」才做）。
- 待做：實機驗證三個接線；UML／MIDI 的 write 方向。

## 進度補記四（2026-11-05，收尾）

- 使用者新增要求（原話）：「可以都完工再來發布」。
- 已發布到 v304（遠端 `manifest.v2` 304，commit `26c38ac5`）。之後完成：`uml_edit` 的 `model_jsonl_read`／`model_jsonl`、`scripts/eval/layers-jsonl.eval.js`（真 Electron 全過）、文件。這些**尚未提交、未發布**，等使用者說發布再做（v305）。
- 剩下只有：`browser_get_page_text` 新分支用真的 Chrome 擴充功能實測（需要使用者環境）。

## 進度補記五（2026-11-05，思考堆疊）

- 使用者要求（原話）：「做思考堆疊」「那我們也可以幫每一層堆疊都請它評估:我再下一層堆疊回來前，有沒有什麼要檢查」「think stack, validate (自問)」「可以都完工再來發布」。
- 完成並測試：見 `DESIGN.think-stack.md`。**尚未提交、未發布**（使用者要說發布才做；發布方式見進度補記）。
- 下一步：真模型量測；接 `uml_core` stageSpec、CoLU 計畫階段、`_umlDesign` 外層。

## 進度補記六（2026-11-05，思考堆疊接線）

- 使用者要求（原話）：「先接 還沒接：uml_core 的 stageSpec 流程、CoLU 計畫階段、_umlDesign 外層。」已完成，細節見 `DESIGN.think-stack.md` 「第二批接線」。**尚未提交、未發布**（等使用者說發布；v306 之後的改動）。
