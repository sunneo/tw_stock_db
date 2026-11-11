# 交接起點頁（FloatingAssistant 桌面版）

> **2026-11-11 管理者交接（先看第 0 節，比下面所有節新）**。這台是 Windows 機器，專案 `D:\Downloadsideos-嗨投資-desktop-app\desktop-app`，分支 `desktop-app`。更舊的現況在下面第 1 節以後與 [`HANDOFF.history.md`](HANDOFF.history.md)，可能過期，先驗證再引用。

## 0. 2026-11-11 交接

### 0.1 最優先：v354 沒有真的上線
- 本機 `PATCH_VERSION` = 354，`desktop-app` 分支的發布提交 `97ffb93e9`（2026-11-11 13:54）訊息是 v354，publish.sh 當時印了「完成：patch v354」。
- 但是 `git fetch origin desktop-app-patch` 看到的遠端更新分支是 **v353**（提交 `1343f908b`，11:06，內容「網頁版 LoRA 真模型修正」）。也就是 **v354（訓練工作室內建資產顯示、評量、老師迴圈、五種符號式訓練、資料匯入輸入欄位、設定頁不再被蓋住）可能沒有上線**。原因未查：可能是 publish.sh 的強制推送失敗被吞掉，也可能被別的發布蓋過。網頁版的釘住 SHA 也要一起核對。
- 第一件事：`node scripts/release-version.js status` 與 `git ls-remote origin desktop-app-patch`，核對 `manifest.v2` 版本與檔案檢查碼；查 publish.sh 為何印成功；然後在**乾淨可信的狀態**重發。注意：目前工作樹的提交含**半成品**（見 0.3），直接 `sh scripts/publish.sh` 會把半成品一起帶上線。建議做法：先決定哪些線已驗證，或用 `git worktree add` 在 `97ffb93e9` 的乾淨副本上發布；不要隨手發。

### 0.2 已確認上線的版本（遠端 manifest.v2 = 353）
v350 工作室與資產／後端／基準測試／LoRA 登錄／資料匯入；v351 桌面版 LoRA 轉傳鏈與執行包 1.22.0-2（GitHub 分支 `native-runtime-1.22.0`，提交 `eb7fd2a43b3264a330b1c2b3bde58bdffaaaa4b3` 釘在 `main-ext.js` 的 `NATIVE_GITHUB_BASE`）；v352 多 adapter（rank 槽串接合併）、網頁版 LoRA 併入權重；v353 網頁版 LoRA 真模型修正。
**未上線或待確認**：v354（見 0.1），以及 0.3 的所有線。

### 0.3 各線現況（2026-11-11 約 14:30 因額度上限全部中斷，額度 **晚上 9 點（台北）重置**）
半成品已用多個「半成品存檔」提交存起來（`4eb5fb490` 矩陣、`162627e62` 中間層、`63a0236c5` blockly 新領域、`1a558fb22` 工作室新增領域、`2908bc119` 本機轉換、`502203c1d` 共用登錄與建置產物），**測試大多沒跑完，不可當作已驗證**。
| 線（工作階段名） | 內容 | 狀態與下一步 |
|---|---|---|
| blockly-finish `local_9a1a238e-08cb-4edf-a291-43c814f89bd9` | inflate／BMP 進階／tar PAX，之後 PNG／GIF／PCX／JPEG 讀寫（讀寫兩端都要）、holdout 未解題、G1–G18 | 最近實測 inflate train 8/10 holdout 2/4（gzip 敘述讀不出，除錯版沒結果）、BMP 進階 9/10 4/4、tar PAX 6/10 1/4（偵測詞，修正版沒結果）。缺口清單尚未寫進 DESIGN.blockly-curriculum.md |
| matrix-finish `local_72f6f078-4e5a-4f41-b232-b11ebbfeda5f` | DESIGN.matrix-fallback.md §12.3 缺口、反編譯、teach_queue 接線，另加離散餘弦轉換／YCbCr／量化／Z 字形／PNG 濾波器矩陣化（排後面） | 新增 bytes／checksum／list／regex／text／spec／sketch 模組已提交（半成品）；heldout7/8/9 題庫；測試沒跑完 |
| ir-finish `local_ffe1d586-2a91-40a7-a103-f7708a22ddf9` | 中間語言層剩餘缺口 | 溢位檢查模式 11 項過、ir.test 48 過、ir_design_edit 6 過、手寫覆蓋率 7/7（原生區塊佔比 c 0%、java 9%、cpp 14%、ruby 27%、csharp 31%、perl 57%）；Perl 布林、重新嵌入、ir_wire/ir_wire2 還沒看結果；缺口清單未寫進 DESIGN.core-ir.md |
| parallel-domain `local_7f7d54b2-71d6-400b-be1a-1a781f8690f9` | OpenMP 風格排程／相依分析／平行範式 | 階段 0、1 寫好（par_sched_core.js、domain_par_core.js）但**從沒跑過**；DESIGN 節未寫 |
| media-codec-domain `local_ad3917db-264f-458e-bd88-1731cb0f1214` | H.264 位元級→I 幀解碼→編碼→P 幀→CABAC／B 幀，有損聲音／影像 | 只完成設計節（提交 `33e4c0f5b`）與 domain_avbits 起手；其餘沒做 |
| studio-domain-author `local_996fbc7c-0bfd-4131-95c0-ad369708f2f3` | 工作室新增領域與 blockly／矩陣操作、scripts/training-studio.js、builtin-training/ | 領域規格／DSL／評量／執行期載入／示範領域／training-studio.js 已寫並存檔提交，測試沒跑完，真 Electron 沒驗 |
| lora-slot-js `local_6185ade8-b72f-4cc5-8b3d-79ca50aa3e07` | 桌面版用 JS 把標準 Qwen3 q8 ONNX 本機改寫成 LoRA 槽版 | `lora-slot-build.js`、`native-slot-model.js`、`tests/native/lora_slot_build.test.js` 已提交（半成品），**轉換從沒實跑**（測試檔 `E:\Temp\claude845096e089295dd\e49cfb73-b239-407d-a0c7-0036bc8d60d4\scratchpad\qwen3dl\onnx\model_quantized.onnx` 與 `...\qwen3pt\`（PyTorch 權重）都在，只讀） |
已完成並提交可驗證：cpu-py（`093004c22`，這台實測 24.7 詞元/秒、步時間中位數 10.4 秒）、網頁版訓練（WebGPU／WebAssembly 對 PyTorch 30 步最大 loss 相對差 2.8e-4／5.3e-4，端到端通過 `16b0da512`）、工作室內建資產／老師迴圈／評量（`97ffb93e9`，單元與真 Electron 40 項）。

### 0.4 其他待辦
1. 重發 v354（0.1）。2. 每條線跑自己動到的測試、修紅、再分項提交；全部完成後才做**一天一次**的整套核心測試。3. 缺口清單寫進各 DESIGN 文件末尾。4. 圖片格式（PNG／GIF／PCX／JPEG）、H.264、平行運算、工作室新增領域都是使用者明確要求，**不可刻意不做**，做不到要寫具體阻礙。5. 老師迴圈只用替身驗證，沒連線上 AI；blockly／矩陣訓練包裝沒端到端驗證；GitHub wiki 連網沒測；設定頁被蓋住的修正沒在真畫面看過。6. LoRA 訓練已能在這台跑（`lora-train/.venv`，Python 3.13；torch 2.15.0+cpu、transformers 5.22.2、peft 0.21.2）；預設 `python` 是 3.10.4 不能用。7. 網頁版訓練下一步：記憶體峰值（原 3.85GB）與 IndexedDB 交換空間已實作，真模型 q8 對微小數值差異敏感（縮放值只能取 2 的冪）。

### 0.5 工作方式（逐字規則見 0.6）
- 回覆繁體中文、不夾英文縮寫、不用簡體字；誠實區分「我驗證的／工作階段回報的／推測」。
- 派 Sonnet 子工作階段（`claude-sonnet-5-5`、`use_worktree:false`），管理者自己核對；commit 結尾 `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`。發布：`PUBLISH_TRAILER="Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" sh scripts/publish.sh -m "說明"`（**直接用 sh 跑，不要包 qrun，包了會立刻失敗**），之後 `node scripts/release-version.js status` 核對。
- **電腦要保持可用**：所有測試與長命令走 `node scripts/qrun.js --timeout <秒> -- <命令>`（命令裡路徑用絕對路徑；全機一次一個、最多 2 核心、低優先權、隱藏視窗）；禁止 `cmd /c start`、`Start-Process`、`nohup`、有視窗的 Electron、平行測試；新子行程要 `windowsHide:true`。整套核心測試一天一次。
- 下載一律先列檔名／來源／大小，使用者**直接**同意才做（子工作階段不接受轉述的同意，需要時由管理者代下載再把路徑交給它）。不掃整台機器、不改系統設定。
- 使用者已授權：各線有結果核對後直接 commit、push、publish（「繼續，有結果直接 commit、push、publish」）；但半成品不要帶上線。
- 新增內建 LLM 模型前用 `/benchmark-model`；「不要建議換模型」；失敗訊息要附 HTTP 狀態等具體事實。
- 額度：五小時額度用完時所有線會同時中斷，重置後逐條用 SendMessage 叫醒（`session_id` 參數；排隊的訊息會重啟已停的回合）。

### 0.6 逐字使用者原話（2026-11-11，仍有效）
- 「不可以刻意不做，我不接受。」（先前）　「請把他們陸續完工，並陸續發布，不要再停下來問。」　「我偏好有多少release多少，這只是待改善，不是沒做」
- 「目前四個全跑對我的電腦有點吃力  可以縮小concurrency嗎  留一個核心給我」「可以統一開一個console去控制而不要彈跳視窗，很困擾，會搶走我的focus無法打字」
- 「完成後直接 commit、push、publish」「繼續，有結果直接 commit、push、publish」「離線訓練器的gui尚未補齊的麻煩優先補齊完成」
- 「網頁wasm慢無所謂  我其他台有更強的 cpu」「如果wasm cpu ram會超過，請參考aidoc用indexdb當swap的做法」「如果支援需要修改transformer.js原始碼，請修改」「需要幫我達成，不要評估說不需要」「最差狀況，我會要求做出compiler on web, 利用webgpu/wasm的能力達成訓練跟產圖」
- 「訓練出來的LoRA要有辦法給主程式按需求載入，例如我也想要將來可以有資料匯入跟清洗器，將資料從wiki或open source或書本內容, aiDoc來變成LoRA」
- 「我們的matrix_algorithm, blockly-teach那段還沒全部做完」「中間語言層的部分」「如果要讓offline ai寫code來製作jpeg,pcx,png,gif writer / reader」（→「加進去」）「如果要讓offline ai寫h.264呢, 或用一個題目是利用平行運算能力，找到程式裡面適合平行的演算法，用類似openmp的block schedule跟cyclic schedule來加速影像壓縮、檔案壓縮、撰寫破壞的聲音跟影像壓縮演算法」（→「列為新領域」）「我希望我們增加新領域、加入新的blockly-teach, matrix-algorithm的操作，在離線訓練工作室也要可以達到」
- 「先幫我把目前現況能commit的commit上去，然後讓我可以交接，我要讓其他session接手」（本次）

### 0.8 接手前先看這裡：主文件與打包
- **主文件就是這一頁（`desktop-app/docs/HANDOFF.md` 第 0 節）**；其餘 DESIGN 文件是各線的細節，要看時從第 0.3 節表格進去。
- 另一台不會有本機檔案。打包腳本：`node scripts/handoff-pack.js --out <資料夾>`（建議 `node scripts/qrun.js --timeout 900 -- node <絕對路徑>\scripts\handoff-pack.js --out <資料夾>`）。產生單一 `.tar`：所有分支（含沒推送的提交）的 `repo.bundle`、倉庫外未追蹤的 `wiki/` 與 `.weak-harness/`、`progress.jsonl`、`test-reports/`、`RESTORE.md`（還原步驟、Python 環境重建指令、模型下載來源與大小）、`MANIFEST.json`（sha256，`--verify <解開資料夾>` 核對）。不含金鑰（`builtin-secrets*.json`）、`node_modules`、`dist`、`lora-train/.venv`。模型要帶就加 `--with-models <資料夾>`（Qwen3 約 1.4 GB 與 590 MB，不帶也行，RESTORE.md 有來源）。
- 沒有「訓練到一半」的東西需要續訓：目前只有煙霧與基準測試，沒有留下檢查點，對方要訓練就從頭開始。所有程式已推到遠端 `desktop-app` 分支，對方也可以直接 `git clone` 該分支（不需要 bundle），bundle 是離線備份。
- **Linux 新機器一鍵準備環境**：還原倉庫後 `bash desktop-app/scripts/setup-linux.sh --handoff <解開資料夾> [--with-python] [--with-electron]`（沒有 Node.js 也行：會下載並核對官方 Node 22、跑 npm ci、放回額外檔案、選用建訓練用 Python 環境、自我檢查；不用 sudo，缺系統套件時列出安裝指令）。
- 打包前先確認 `git status` 沒有已追蹤的未提交修改（腳本會警告）。

### 0.7 踩過的坑
- 用 `git hash-object -w` 推 GitHub 分支檔案時，CRLF 換行轉換會讓檔案檢查碼不符（nr-engine 分段檔就中過），要加 `--no-filters` 並逐檔核對 md5。
- qrun 殼層不認正斜線相對路徑，用絕對路徑；`sh scripts/publish.sh` 不能包 qrun。
- 這台 node 是 32 位元，跑不動 600MB 模型；要用 x64 Electron 當 node（`ELECTRON_RUN_AS_NODE`）。
- `pip --dry-run` 要用較新的 pip（venv 內建的太舊）；預設 python 3.10.4 裝不了 transformers 5.x，用 `py -3.13`。
- 子工作階段若認為「同意」是轉述就不會動，需要使用者直接回覆；管理者可自己下載再給路徑。
- 全機排隊佇列被長任務（例如處理器訓練基準測試）佔住時，其他線的測試會排很久；少開長任務。

---

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
