# 交接起點頁（FloatingAssistant 桌面版）

> **一頁看完**。更新：2026-11-08（管理者）。這台是 Windows 機器 `D:Downloadsideos-嗨投資-desktop-appdesktop-app`，下面第 1 節的 Linux／hungfu.lee 說明來自另一台機器。「已核對」＝我實際跑過（測試、真 Electron、遠端 manifest）；「另一條線」＝別的工作階段的報告，沒有逐項核對。
> 舊的交接（v299 時期、進度補記一到六、使用者原話）**逐字**在 [`HANDOFF.history.md`](HANDOFF.history.md)，可能過期；待辦的完整表在 [`../DESIGN.TODO.md`](../DESIGN.TODO.md) 最前面的「現況總覽」。

## 1. 現況

- 專案 repo `tw_stock_db`，資料夾 `desktop-app`，分支 `desktop-app`。本機（Linux）`/home/hungfu.lee/Downloads/SRC/tw_stock_db/desktop-app`；舊交接裡的 Windows 路徑 `D:\Downloads\videos-嗨投資-desktop-app\desktop-app` 是另一台機器。
- **已發布 live-update patch v310**（已核對：遠端 `manifest.v2` 是 310，54 個檔案檢查碼與本機建置一致）。互換版 `manifest.json` 凍結在 186，**不要再動**。網頁版 `videos-嗨投資` 這台機器找不到、一直沒有同步（要同步需要使用者給路徑，或確認不需要）。
- 核心測試 **198/198**（已核對：`node scripts/run-core-tests.js`）。
- 近幾版（以 commit 訊息與遠端 manifest 為準）：v307 思考堆疊接進 `uml_core` 流程／`designProject` 外層／CoLU 計畫階段；v308 判題器（IPC 在 `main-ext.js`，可熱更新）、遞迴寫程式迴圈、語法修復、編輯、程式碼轉 UML；v309 `uml_design` 讀算法題、程式讀情境配方、區塊庫與庫存規則；v310 `/teacher-loop`（`/offline-trainer-by-ai` 的別名）加客觀驗證／離線重做／回歸／回滾、內建的課（離線不問模型 3/20→20/20）、範式與矩陣積木。更早的離線原生模型（v291～v299）與 JSONL 分頁器、檢視器、多層 JSONL（v304 前後）見舊交接與各設計文件。
- 工作樹裡有**別的工作階段未提交的修改**：`DESIGN.jsonl-paging.md`、`features/FEATURES.md`、`skills/*`、`DESIGN.TODO.md` 舊章節的一行；`test-reports/*` 是跑測試產生的。**不要 `git add -A`**。

## 1b. 2026-11-08 最新（先看這裡，比第 1、2 節新）

- 已發布 **v337**（遠端 manifest.v2）。待發布 v338：內建剖析器（`renderer/vendor/tree-sitter/`，Python 文法）、判題器 Windows 不彈視窗＋用 `python`、`/code` 指令、區塊↔中間語言橋與行內註解保存、思考堆疊接線（進行中）。
- 發布：從 `desktop-app` 目錄 `PUBLISH_TRAILER="Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" sh scripts/publish.sh -m "說明"`；`publish.sh` 會 `git add -A renderer scripts web-lazy`，發布前一定先看 `git status`，並確認沒有子工作階段做到一半。
- 測試環境（Windows）：`PATH` 要含 `D:Downloadsa-ts-cachein`（真的 python）；語法解析器在 `C:Userssunneo.cachea-ts`；整套核心測試約 6～20 分鐘，放背景跑。
- **未完成清單的唯一入口：`DESIGN.TODO.md` 最前面的「2026-11-08 未完成清單」**（diff／patch／merge 4.2、editCode 整合、語法樹邊界、中間語言各語言、行為卡接線、矩陣轉 Blockly 接線、Blockly 教學待辦等）。
- 使用者規則補充：找檔案只在專案內，**絕不 `find /`**（電腦會卡死）；編譯環境自動尋找已擱置；Windows 的 Python 叫 `python`；下載先列檔名、來源、大小等同意；管理者工作階段不用交接。

## 2. 下一步（依序，來源見 `DESIGN.TODO.md` 現況總覽）

1. 寫程式管線接進產品：`write_code` → `uml_design` → 內建的課／配方 → 區塊迴圈 → 沙盒；前端要嵌入 `py_*` 模組並有 tree-sitter 解析；`/teacher-loop` 才能對真的寫程式項目離線試做。接著做**範式骨架庫**（分治、DFS、BFS、樹走訪、資料結構對應、動態規劃、矩陣快速冪）。
2. 在真的 Electron 打開 `.jsonl`／`.jsonc` 檢視器看一次（另一條線：只測過純函式與建置）。
3. 用真的 qwen3-0.6b 量思考堆疊的「兄弟一致性」（目前只有假模型；需要有模型的機器）。
4. `browser_get_page_text` 長頁面章節索引用真的 Chrome 擴充功能實測。
5. JSONL 分頁舊待改善：`knowledge_ask`／`repo_*` 帶 `_page`、頁數預估接 `fitToBudget`、離線小模型（4096）調校、超大檔行索引（`DESIGN.jsonl-paging.md` 第六節）。
6. 其他：CoLU 計畫前的路由（`chooseTool`）建思考堆疊；MIDI `compose_tree` 與 UML 的「小窗口分段寫」；merge diff patcher；函式內部再切步驟；套件／類別層接 `design_core`；其他語言的區塊庫與課。

## 3. 常用指令（本機 Linux）

- 檢查與建置：`node --check renderer/src/floating-assistant.js`；`node scripts/embed-code-ui.js && node build-assistant.js`（約 10 萬行的 `renderer/src/floating-assistant.js` 只用小改動，改完立刻檢查）。
- 測試：`node scripts/run-core-tests.js`（約 2～3 分鐘）。真 Electron：`xvfb-run -a node scripts/e2e/teacher_loop.e2e.mjs`（把 `playwright-core` 連結進 `node_modules`；用暫時的 `--user-data-dir`，不要碰使用者的設定）。
- **提交與發布一律用 `hungfu.lee` 帳號**：`ssh automation@127.0.0.1` 再 `ssh hungfu.lee@127.0.0.1`，`cd /home/hungfu.lee/Downloads/SRC/tw_stock_db/desktop-app`。發布：`PUBLISH_TRAILER="Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" scripts/publish.sh -m "說明" --skip-build --no-web`。版號：`node scripts/release-version.js status`（下一版是 311）。
- **建置要用自己的帳號先做完再 `--skip-build`**：用我的帳號建置出來的檔案，`hungfu.lee` 沒有寫入權（`web-lazy/chunks` 會卡在 `rmdir`）。不要用 `chmod` 補權限（會被自動模式擋下，而且是在授權另一個帳號）。
- 提交只加自己的檔案。要提交 `DESIGN.TODO.md` 但別人也有未提交修改時：以 HEAD 版本加上自己的修改算出內容，用 `git hash-object -w` ＋ `git update-index --cacheinfo` 只暫存自己的那一部分。

## 4. 使用者的規則（越新越前；原話見舊交接）

- 回應用繁體中文或英文，**簡體字絕對不行**；講清楚在做什麼、給看得到的輸出，不要讓使用者猜是不是卡住；誠實區分「我驗證的／別人回報的／推測」；該做的事直接做，不要變成問句（使用者不喜歡被打斷）。
- **先讀專案現有的程式再動手**（tree-sitter、離線訓練器、`uml_design`、`/offline-trainer-by-ai` 都早就存在；使用者多次因為沒讀而生氣）。
- 寫程式：AST 就是 Abstract Syntax Tree；每個語言各自一份、不跨語言共用；`write_code` 只有一個入口；`write_code` 領域關閉思考；流程是 UML 切割（`uml_design`）→ 骨架（UML codegen）→ 區塊迴圈（庫存＋範本，函式 body 固定三區：引入、宣告、邏輯與流程）→ 模型只做微選擇（全部是選擇題，包括槽位）→ 沙盒驗證＋錯誤回饋；Claude 教會之後要**內建進去**；步數上限開發期設無限大。
- 有多少 release 多少，沒達標叫「待改善」；下載與安裝先取得同意並列出檔名、來源、大小；熱更新不准要求重裝；版號單調遞增；不使用埠 17923；原生執行器不開網路通道；repo 根目錄不建 `package.json`／`node_modules`。
- 大模型在 wasm 跑不動（除非 transformer 記憶體能用 IndexedDB 模擬），所以要讓小模型每一步的選擇更少、更明確。

## 5. 設計文件地圖

| 主題 | 文件 |
|---|---|
| 待辦總表（先看最前面的現況總覽） | `DESIGN.TODO.md` |
| 寫程式：區塊、課、內建、範式、`uml_design` 讀算法題（第五～七節） | `DESIGN.ast-nodes.md` |
| 離線訓練器、`/offline-trainer-by-ai`＝`/teacher-loop`（驗證擴充見 5.1） | `DESIGN.offline-trainer.md` |
| UML → 骨架、`uml_edit`、LLVM | `DESIGN.uml-framework.md` |
| 程式修復、merge diff patcher | `DESIGN.code-repair.md`、`DESIGN.fn-template.md` |
| JSONL 分頁器、檢視器、多層 JSONL | `DESIGN.jsonl-paging.md` |
| 思考堆疊 | `DESIGN.think-stack.md` |
| 原生離線模型 | `DESIGN.native-all-models.md`、`DESIGN.TODO.native-runner.md` |
| 離線意圖、全語音 | `DESIGN.offline-intent-pipeline.md`、`DESIGN.live-voice.md` |
| 發版流程與版號 | `DESIGN.release.md`、技能 `publish-live-update-patch` |
| 舊的 token 層文法引導（已被取代） | `DESIGN.grammar-guided.md` |

## 6. 陷阱

- `run-core-tests.js` 只認每支測試**最後一行**含 `N passed` 或 `0 failed`；`N checks passed` 這種寫法會讓整組被判失敗、單獨跑卻通過（托盤測試就是這樣，已修）。
- 用內嵌指令寫修補程式會吃掉反斜線與引號：寫成檔案再執行；而且**先在記憶體組好新內容再寫檔**——曾經一個寫壞的修補讓檔案被截成空檔。
- `git add` 萬用字元不會暫存刪除，刪檔用 `git rm`；`publish.sh` 的 `git add -A renderer scripts web-lazy` 會把這三個資料夾裡所有改動（含別人的）一起提交，發布前先看 `git status`。
- 對跑到一半的工作階段送訊息會排隊，要等它這輪結束才生效；自動通知觸發的回合不能直接啟動新工作階段。
- 舊交接裡 Windows 專屬的陷阱（本機 Python 不能用、WindowsApps 殘根）在這台 Linux 機器不適用，這裡 Python 與 `node` 都能用。

## 7. 歷史

[`HANDOFF.history.md`](HANDOFF.history.md)：舊的管理層交接（逐字）、2026-11-05 的使用者原話與進度補記一到六。
