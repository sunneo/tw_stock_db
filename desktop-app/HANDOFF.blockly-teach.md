# 交接：Blockly 教學範本擴充（blockly-teach）——給「任何帳號的 session」冷啟動接手

> 本檔不假設你知道先前的對話。讀完本檔、`DESIGN.blockly-curriculum.md`（教學範本總表＝進度欄）、`DESIGN.blockly-gaps.md`、`DESIGN.blockly-gap.md` 就能接手。

## 1. 開場提示（接手者收到的原文）

請接續 `desktop-app/HANDOFF.blockly-teach.md`：完整讀完（含使用者原話與工作方式），照著做，並執行 low-context-long-run 技能（門檻 30%）：做下一個待辦，到門檻就寫下一份交接、啟動接手者（若系統拒絕你啟動 session，就把交接文件更新好並提交，通知協調者）。第一則訊息請用一行確認你讀了文件、從哪個待辦開始。使用者原話（2026-11-07）：「我們這邊就認真擴充blockly-teach, 涵蓋演算法、資料結構、作業系統、真實linux programming，等各種領域作為範本，把教學範本補齊」；「甚至下週也可以繼續補齊，所以這邊盡量安排成有多少做多少，補好的就commit/deploy」。

## 2. 概況

- **是什麼**：Blockly 離線寫程式流程（敘述 → 讀取器 → 範式骨架（槽位窮舉）→ 沙盒判題，0 次模型）。目標：把「教學範本」補齊到演算法、資料結構、作業系統、真實 Linux programming。**矩陣層（`renderer/src/algo/`，含 `matrix_synth*`）是別的 session 的事（stevenyc.huang 那邊），不要碰。**
- **路徑**：repo `tw_stock_db`，資料夾 `desktop-app`（原機：`/home/hungfu.lee/下載/SRC/tw_stock_db/desktop-app`），分支 `desktop-app`。核心檔：`renderer/src/uml/algo_intent_core.js`（讀取器：`read`、`readToolInput`、`TOOLS`、`TOOL_FAMILIES`、`extractFacts`）、`py_paradigms_core.js`（骨架表：`GEN` 通用、`LX`～`LX6` Linux 工具；`forIntent`、`combos`、`render`、`solve`）、`py_uml_pipeline_core.js`（`buildFromUML`、`readInputCNL`、`mkModel`）、`py_blocks_core.js`／`py_blocks_lib_core.js`（積木）、`domain_registry_core.js`／`domain_dsp_core.js`（領域包格式範例）。題庫在 `renderer/src/recipe/seed/`（`bench_linux_all.jsonl` 64 題，欄位 `split`: train 37／holdout 27）。
- **已完成並提交（hash）**：階段 1 `49f2547f`（通用 42 骨架，原 60 題 59/60）；階段 2：`dfed1565`（G17＋G1＋G5）、`73deb981`（G3＋G4＋G7–G13，積木 35 個、骨架約 45 個）、`4e653d57`（舊交接）。已發布到 v313（含 bea451cb 對應批次 1）；**批次 2（73deb981）等協調 session 發 v314**。
- **數字**（無模型）：bench_linux_all train 37/37、holdout 21/27（起點 0/64）；原 60 題 59/60；`holdout_blockly.jsonl` 28/31；核心測試 208/208；真 Electron 20 題種子 20/20。holdout 未解 6 題：cat-two、exec-env、tar-blocks、canonical-huffman、xz-header、bmp-write8。
- **進度欄**：`DESIGN.blockly-curriculum.md` 的總表（領域 → 子領域 → 範式，已有／缺／優先序）。**每提交一批就同步更新它的「狀態」「提交」欄**。

## 3. 待辦（依序；每個都要小批提交、驗證、回報）

0. （v313 退步已修於 `73deb981`；若你在舊提交上看到 `domain_dsp.test.js` 或 `linux_paradigms.test.js` 失敗，確認已含 73deb981。）
1. **G2 切割模板**：骨架可宣告 `helpers:(c,N,I)=>[{name,params,py}]`；`Paradigms.solve` 把 helper 的 CNL 連同 solve 交給 `judge(cnl, extra)`；`py_uml_pipeline_core.js` 的 `mkModel(solveIR, imports, extraOps)` 加第三參數。示範：共用 `crc32(data)` 單元被 `checksum.crc32`、`gzip.stored-member`、`gzip.member-write`、`xz.stream-header` call。改這檔前先問 matrix-fallback 的接手 session（目前 `local_324e6835-fc92-4db8-8b82-2627bf329daa`；沒回就只加行不改既有行）。
2. **G18** `intent.specLike` 偵測；DESIGN.blockly-gaps.md 加 §7 逐列「已補＋hash」（內容可從總表 §2 抄）。
3. **領域包化**：把 Linux 工具搬成獨立 `renderer/src/uml/domain_linux_core.js`（擴充 `addAlgos` 讓領域條目可帶 `shape`），並新增資料結構／作業系統領域包（各一個獨立檔：`domain_ds_core.js`、`domain_os_core.js`）。新檔要：登記到 `scripts/embed-code-ui.js` 的 `embedUml()` 清單、在 `renderer/src/floating-assistant.js` 加 `/* XXX-BEGIN */`／`/* XXX-END */` 標記、在 `scripts/run-core-tests.js` 登記測試。
4. 依總表 P0 優先做新領域：作業系統（CPU 排程、分頁置換、記憶體配適）、資料結構（雜湊表／LRU）、Linux（sed／awk／cut／sort／uniq／wc／tr／diff 行為）。每個領域包都要有 train 題＋holdout 題（自己出題；`scripts/eval/gen_bench_linux.py` 是出題器範例，固定亂數種子、參考解自己驗證、重試要有上限），回報泛化解出數。
5. 真 Electron 跑新題庫：`scripts/eval/bench-coverage.eval.js` 在本機會卡住，勿用；改用 Node 版 `bench_coverage.js`＋20 題種子 Electron 回歸。
6. **思考堆疊／CoLU 缺口檢查**（使用者原話：「blockly-teach看那條uml thinking stack/CoLU thinking有少」）：讀 `DESIGN.think-stack.md`、`DESIGN.colu.md`、`renderer/src/uml/uml_bench_core.js` 的 `siblingConsistency`，對照 `py_uml_pipeline_core.js`／`renderer/src/recipe/code_agent_core.js` 離線路徑（`buildFromUML`、區塊迴圈、`_codeOffline`）哪些階段沒有 push／pop 思考堆疊框、沒有一致性檢查、沒有 CoLU 規劃路由、失敗時沒把「卡在哪一層」寫回堆疊。缺口列進 DESIGN 小節（缺什麼／影響階段／建議補法），小項補並加測試，大項列清單。
7. 「超出 Blockly」清單隨時維護（G14 LZMA match／LZMA2／BCJ、G15 判題器二進位 IO／檔案／argv／結束碼／環境、G16 真行程、G18 模型／老師部分），回報協調者。

## 3a. 最新進度（blockly-teach-2，2026-11-07 凌晨；比 §3 新，先看這裡）

- 已完成：G2／G18（0a2bc959）；領域包 algo2／os／ds（97231841）、linuxtext（下一個提交）；思考堆疊缺口 A、B、H（`DESIGN.think-stack.md` 末節）。數字見 `DESIGN.blockly-curriculum.md` §3。核心測試 212/212、Linux 題庫 37/37＋21/27、原 60 題 59/60、holdout_blockly 28/31、Electron 20/20。
- 新增領域包的做法：寫 `domain_X_core.js`（骨架）＋`domain_X.test.js`（種子，用 `domain_harness.js`），在 `scripts/embed-code-ui.js` 清單、`renderer/src/floating-assistant.js` 的 BEGIN/END 標記與 `_pyDomainsInit` 清單、`scripts/run-core-tests.js` 各加一行；embed／build 要用 `ssh hungfu.lee@127.0.0.1`（檔案屬於 hungfu.lee）。`c.<槽位>` 是選項的**值**不是 id（pascal 曾因此踩雷）。
- 讀取器的坑：領域條目標 `pri:true` 才能壓過內建工具詞彙（lines-map 會搶「每行」）；單行字串輸入要寫成「輸入一個字串 s」；指令序列用「第一行 q，之後 q 行指令：…」；兩個清單要分別寫「第二行 n 個…，第三行 q 個…」。
- 下週待辦（優先序）：(1) 多矩陣輸入形狀（銀行家演算法、分頁位址轉換）；(2) ✔diff／join／cat-two 的「兩段輸入」已做（v322：`domain_twofile_core.js`＋讀取器把「兩個檔案，每個是一行 k 加上 k 行」改寫成兩段輸入）；(3) 同步原語事件模擬、檔案系統（inode／FAT）、進階圖樹（MST／SCC／Bellman-Ford／LCA）；(4) 真 Linux 語意模擬（fd 表、dup2、pipe 緩衝、信號遮罩、socket 狀態機；純函式）；(5) 思考堆疊 C／E／F／I；(6) holdout 未解：Linux 6 題（cat-two、exec-env、tar-blocks、canonical-huffman、xz-header、bmp-write8）與各包 holdout 各 1 題（輸入措辭；補時要用新出的 holdout，不要拿現有的當教材）。

## 3b. 最新進度（blockly-teach-4，2026-11-07 06:10 CST；比 §3a 新，先看這裡）

- 已做：`renderer/src/uml/domain_sync_core.js`＋`domain_sync.test.js`（信號量／互斥鎖／條件變數／生產者消費者；train 16/16、holdout 3/4，未解 1 題為輸入措辭，已用通用輸入形狀修正補上）；`algo_intent_core.js` 兩個通用小修（「之後 q 行事件／動作」；「接著 q 行：…」保留第一行整數）；登記於 embed 清單、`floating-assistant.js` 的 DOMAINSY 標記與 `_pyDomainsInit`、`run-core-tests.js`。
- 驗證狀態以提交訊息與協調者回報為準；核心測試或 Electron 20/20 若未全過，先修。`floating-assistant.js` 屬 hungfu.lee，automation 帳號寫不進，要用 `ssh hungfu.lee@127.0.0.1` 直接下指令（ssh 跑 /tmp 小腳本曾被權限分類器擋）。
- 接續點（依序，Linux 格式型家族 linuxfmt（樣板展開／區塊對齊／範式前綴碼）v329；Linux 語意模擬 linuxsem（fd 表／管線／信號遮罩／TCP）v324；檔案系統 fs（FAT／inode）已於 v323 做第一批；進階圖 graph2 已於 v321 做完第一批：MST／SCC／Bellman-Ford／樹直徑／LCA／二分圖／最大流；讀取器通用放寬：區段數量可寫 n-1、「每行 a b 描述…」）：(1) ✔已做（stevenyc.huang 的 session，2026-11-07）：`os.banker`、`os.page-translate`＋讀取器通用放寬（連接詞「接下來／最後／緊接著／隨後」、名稱可用「、」分隔、「第一行有三個整數」、第一行整數不被讀成字串）。原說明：銀行家演算法／分頁位址轉換＝多矩陣輸入：「第一行 n m，接著 n 行…，再接著 n 行…」目前讀成兩個 raw lines 但丟掉第一行整數；修法是 `algo_intent_core.js` 的 `readToolInput` 覆蓋處（搜尋 `const keep =`）把保留條件放寬到 `ti.every(x => x.k==='lines'||x.k==='rest')`，再寫 banker 骨架（是否安全／安全序列）。(2) diff／join 兩段輸入。(3) 檔案系統（inode／FAT）、進階圖樹（MST／SCC／Bellman-Ford／LCA）、真 Linux 語意模擬（fd 表、dup2、pipe、信號遮罩、socket 狀態機）。(4) 思考堆疊 D／F／H（C、E 先設計）。(5) Linux holdout 6 題與各包 holdout 未解題（只補通用能力）。
- 額度：2026-11-07 06:08 使用者指示不要用到隔週額度；07:00 重置後由使用者決定何時續做。

## 3c. 最新進度（2026-11-08，管理者第二批；比 §3b 新）

- 多矩陣輸入形狀（銀行家、分頁位址轉換）§3b 已做，本批只核對存在（`domain_os_core.js` 的 `os.banker`、`os.page-translate`，`domain_os.test.js` 66 項過）。
- Linux 語意模擬補了行程樹（`lx.proctree`）與 socket 監聽佇列（`lx.listen`），數字與誠實註記在 `DESIGN.blockly-curriculum.md`。
- holdout 量測：`holdout_blockly` 28/31、`bench_linux_all` 59/64，只量不教。
- 新增領域包／範式的做法不變（§3a）；本批新增範式的坑：`limit` 要 ≥ 槽位組合總數（`lx.listen` 2×3=6，一度設 5 導致解不出）；偵測詞放進 `algos` 要 `pri:true`；第一行 `cap q` 的名稱最好沿用已有範式的寫法（`backlog q` 讀不出）；生成輸入要讓輸出非空（行程樹的殭屍輸出一開始全是空行，參考解被判「產生不出測資」）。

## 3d. 最新進度（2026-11-10，blockly 續做）

- Linux 語意模擬（`domain_linuxsem_core.js`）新增三個範式，各有 train／holdout 分開的種子，整份測試 train 27/27、holdout 10/10：`lx.socket`（socket／bind／listen／connect／accept／send／recv／close 全套事件）、`lx.signest`（信號處理常式巢狀：處理常式引發信號、自身遮罩、pending 遞送；骨架不能用 def，所以用顯式堆疊）、`lx.envexec`（環境變數匯出／繼承與 exec 事件模擬）。提交：`5b8eed9c9`、`e231198a3`、`9f4431b90`。
- **判題器能力（2026-11-10 已補，見 §3e）**：argv、環境變數、結束碼、多檔案夾具與輸出檔、二進位 stdin／stdout、真子行程／管線、fork（Windows 走 WSL 或 msys 並標明 mode）、本機 socket 都已做進 `judge-runner.js`。（原 `exec-env` holdout 其實是樣板變數展開，早已由 linuxfmt 解掉。）
- 這台 Windows 機器跑領域包測試要設 `FA_TS_DIR=~/.cache/fa-ts` 與 `FA_PYTHON=python`（`python3` 是商店空殼；`domain_harness.js` 已支援 `FA_PYTHON`）。腳本改檔別用 shell 內嵌（反斜線會被吃成退格字元），用 Write 寫成檔再跑。
- 偵測詞排在 `algos` 最前面才不會被 `lx.fdtable`（「最小的空閒 fd」）搶走；新範式的偵測詞要避開別的範式的關鍵字。
- 嵌入：這批沒跑 `embed-code-ui.js`（`floating-assistant.js` 另有他人未提交改動），發布時要嵌入。
- 真 Electron 矩陣層逐題結果見 `DESIGN.matrix-fallback.md` §11.8。

## 3e. 最新進度（2026-11-10，判題器真行程＋LZMA 完整流程＋xz／bmp 留存題）

- **判題器**（`judge-runner.js`，測試 `judge-runner-real.test.js` 14 項、原 `judge-runner.test.js` 25 項、`judge-runner-kill.test.js` 5 項）：測試除 `{in, out}` 還可帶 `args／env／files／expectFiles／expectExit／inHex／outHex／needs`（欄位說明在檔案開頭註解）。`needs:['fork']` 時：非 Windows 直接真 fork（mode native）；Windows 的 bash 走 msys 的真 fork（mode msys）；Windows 的 python／C／C++ 交給 WSL 發行版（mode wsl，第一次啟動約 20 秒）；都沒有就該筆回 UNAVAILABLE（mode none，不假裝通過）。`needs:['socket']` 會替測試挑 127.0.0.1 的空閒埠，換掉 args／env 裡的 `{{PORT}}` 並設環境變數 JUDGE_PORT。逾時殺整棵行程樹；Windows 另掃「父行程已結束才變孤兒」的後代。
- **不彈視窗（使用者抱怨過搶走焦點）**：Windows 沙盒的 python 掛 `sitecustomize.py`（PYTHONPATH 指向沙盒暫存目錄），把 subprocess／os.system／os.popen／os.spawn* 改成 CREATE_NO_WINDOW＋SW_HIDE 並補標準代碼；nodejs 掛 `scripts/hide-child-windows.js`。測試用子行程自己回報 GetConsoleWindow 為 0 來證明。**已知沒處理**：C／C++ 程式自己呼叫 system()／CreateProcess、bash（msys）的子行程；WSL 內的行程（wsl.exe 本身是 windowsHide 啟動）。
- **領域包**：`domain_linuxreal_core.js`（環境變數查詢、argv、子行程環境、文字檔轉換、多檔案合併、二進位檔轉換、本機 socket 回應、fork＋管線、子行程管線）、`domain_lzma_core.js`（LZMA alone／LZMA2／LZMA2＋BCJ／xz 容器解碼，解碼器是 helpers，對 Python 標準庫 lzma 逐筆比對）、`domain_binfmt_core.js`（xz 標頭檢查類型名稱、xz 頁尾、8 位元調色盤 BMP 寫出）。數字見 `DESIGN.blockly-curriculum.md` §3。
- 讀取器通用小修：領域條目可標 `raw:true`（輸入不在標準輸入時給一個原樣行清單）、`rawAll:true`（整份輸入原樣讀成行清單）；「給一行…」視同「輸入一行…」；「以空白隔開的位元組」也是 hex 輸入。
- 測試跑法：這台機器 4 核心，所有 node 測試一律 `node scripts/qrun.js --timeout 秒數 -- <命令>`（排隊、低優先權、不彈視窗），一次只跑一個。

## 4. 環境與流程（任何帳號都能照做）

- **依賴**：Node 20、Python 3、`xvfb-run`（真 Electron 測試）、tree-sitter 快取目錄。`export FA_TS_DIR=/tmp/fa-ts-cache`（需含 `tree-sitter.js`、`tree-sitter.wasm`、`tree-sitter-python.wasm`；沒有就從 `~/.cache/fa-ts` 或專案說明取得；測試找不到會印「略過」）。
- **記憶體上限**（2026-11-07 曾因某 python3 吃到約 78GB 造成全域 OOM）：所有 Python／評測腳本加 `systemd-run --user --scope -p MemoryMax=16G -p MemorySwapMax=0 <指令>`（或 `ulimit -v 16000000`）。
- **量測**：`node scripts/eval/bench_coverage.js --files <題庫>.jsonl --mode A --json out.json` 再 `python3 scripts/eval/split_report.py out.json <題庫>.jsonl`（分 train／holdout）；原 60 題回歸 `node scripts/eval/bench_coverage.js --mode A`（要 59/60）；`--files holdout_blockly.jsonl`（28/31）。
- **核心測試**：`node scripts/run-core-tests.js`（目前 208/208；結果寫到 `test-reports/`，那是別人的檔，**不要提交**）。新測試輸出要含「N passed, 0 failed」。
- **改 renderer 後驗證**：`node scripts/embed-code-ui.js && node build-assistant.js`，再 `xvfb-run -a node scripts/eval/run_eval.js scripts/eval/offline-code.eval.js <空的埠>`（種子 20 題要 noLessons／withLessons 皆 20/20；埠不可用 17923）。**不要改 `renderer/src/floating-assistant.js` 內嵌區塊**（改來源檔再 embed）。embed／build 只在批次通過後做；不要在工作樹留下未通過的 renderer 變更（協調者發布前會檢查 renderer／scripts／web-lazy 是否乾淨）。build 產物（`floating-assistant*.js`、`web-lazy/`、`update-manifest.json`）不提交，由發布流程重建。
- **提交**：只 `git add` 你自己改的檔案（不要 `git add -A`）。其他 session 的未提交檔不要碰：`features/FEATURES.md`、`skills/image-decompose-redraw/data/parts_builtin.json`、`DESIGN.edit-*.md`、`DESIGN.env-baseline.md`、`HANDOFF.edit-remote.md`、`skills/weak-model-harness/scripts/bridge/`、`72d21a0c-*`、`test-reports/`、`renderer/src/algo/`、`scripts/eval/bench_coverage.js` 的判題標準。
  - 原機（hungfu.lee 帳號）：本機直接 `git` 會報 dubious ownership，要走 `ssh hungfu.lee@127.0.0.1 'cd /home/hungfu.lee/下載/SRC/tw_stock_db/desktop-app && git add <檔案> && git commit -q -m "…" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"'`；也**不要**用 `git show … > 檔案` 之類可能失敗的重導向覆蓋原始檔（曾把檔案清空，靠備份還原）。
  - 沒有 hungfu.lee 帳號時：在你自己的 clone／帳號下直接 `git add <檔案>`＋`git commit`（訊息結尾加 `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`）；若報 dubious ownership，對該目錄 `git config --global --add safe.directory <路徑>`。分支 `desktop-app`。
- **發布**：**自己不要發布**。每批提交後向協調者回報（提交 hash、train／holdout 解出數、改了哪些 renderer 檔、測試結果），由協調者驗證並發布（發布流程見 skill `publish-live-update-patch`）。協調者原機 session id：`local_aa2d0534-d9c3-41a6-8c95-9c3591567ef0`（若在別的環境，改回報給使用者）。
- **額度**：平時週額度 88% 就停手、寫交接、不起接手者；週五 19:00～週六 07:00（CST）可用光（使用者規則：「這個週額度可以用光的規則僅用於禮拜五晚上7點後」；「平時禮拜六七點後，到隔週的禮拜五晚上七點前，不能這樣做」）。2026-11-07 07:00 CST 週額度重置；使用者後來說下週也可繼續補，仍以「有多少做多少、補好就提交」為原則。context 門檻 30%。

## 5. 工作方式（使用者規則，原樣照辦）

- 語言：繁體中文，**簡體字絕對不行**；講清楚在做什麼、給看得到的輸出；誠實區分「我驗證的／別人回報的／推測」；沒達標叫「待改善」；不宣稱「涵蓋所有問題」。
- **先讀專案現有程式再動手**；**泛化**：不可把題目答案硬編；骨架窮舉槽位交沙盒、不靠排序；參數由敘述抽（facts），抽不到就 throw 不渲染。
- **holdout 絕不可教**：只量測；不要讀 holdout 的敘述去寫規則或範式（要診斷用只印判決種類的腳本，別印預期輸出）。回報時照實說「家族」是否被缺口表點名。
- 每批要小（一個缺口、一個範式族、一個領域子集），寧可多發幾次；提交前確認核心測試全過、原 60 題不退步、Electron 20/20。
- `pkill -f`／`pgrep -f` 會比對到自己的指令，不要用；等待背景工作用 Monitor 或直接看檔案，不要長 `sleep`。不使用埠 17923；版號單調遞增。

## 6. 使用者原話（逐字，附日期）

- 2026-11-07：「我們這邊就認真擴充blockly-teach, 涵蓋演算法、資料結構、作業系統、真實linux programming，等各種領域作為範本，把教學範本補齊」
- 2026-11-07：「矩陣補齊我想要交給其他session，例如stevenyc.huang」
- 2026-11-07：「甚至下週也可以繼續補齊，所以這邊盡量安排成有多少做多少，補好的就commit/deploy」
- 2026-11-07：「blockly的銜接在blockly-teach內，讓它去接續，我要讓stevenyc那邊先啟動，這邊如果週額度用光，還可以提前插入到handoff讓stevenyc那邊接續完成」
- 2026-11-06：「請將未知題目的blockly補上」
- 2026-11-06：「個別完成都要回來發布」
- 2026-11-06：「請務必缺口都要補好」
- 2026-11-06：「剛剛linux工具的部份，看來有東西要補」
- 2026-11-06：「blockly-teach看那條uml thinking stack/CoLU thinking有少」
- 2026-11-06：「請用ssh hungfu.lee@127.0.0.1」
- 2026-11-06（Linux 題庫起因）：「下一個教學試題，claude先把linux的util如tar, gz, xz, xxd, grep, cat, eval, exec, 實現bmp reader/writer 整個都拆解，全部給予blockly教學，看哪邊有未知的。以及uml到切割問題，到 blockly，哪裡有題形、演算法沒跟上的」
- 寫程式流程（`DESIGN.ast-nodes.md` 第六、七節）：UML 任務切割 → 程式骨架生成（Boilerplate）→ Block 產生迴圈〔① Inventory ② 過濾合法區塊 ③ 嚴格 Template〕→ 模型僅在合法 Inventory 內做微型選擇 → 沙盒編譯驗證 ⇄ 錯誤回饋。

## 7. 交接程序（自我遞迴）

執行 low-context-long-run 技能，門檻 30%：每批提交後檢查 context（`mcp__ccd_session_mgmt__get_usage`）；到門檻就改寫本檔（保留逐字使用者原話與總表進度）→ 提交 → `mcp__ccd_session__start_session`（`user_asked`、`fresh`、同資料夾、標題「blockly-teach · handoff N」，prompt 為 §1 原文）。**若系統拒絕（本 session 就是被別的 session 起的，被拒過）**：把文件更新好並提交、通知協調者，由協調者／使用者啟動接手者；不要用其他方式繞過。待辦清空且驗證完就不要再交接，直接報告完成。

## 8. 陷阱

- 骨架 `py(c,N,I)` 的 `c.<槽位>` 是選項的 **v**（值）不是 id；`S(id,label,[[id,v],…])`。局部變數用帶底線名（`raw_`、`w_`）避免被 `render` 改名成 `名稱_2`。
- Python：`"" in "?*"` 為真，判量詞要逐一用 `==`；骨架不含 def、不用 `a = b = 0`；JS 字串裡的 Python 反斜線要寫 `\\`。
- 骨架 `limit` 必須 ≥ 槽位組合總數，否則窮舉被截斷（`linux_paradigms.test.js` 會檢查）。
- `TOOLS` 的正規式太寬會劫持別的題（`push` 大小寫、`二進位`、`差分`、`記號` 都踩過）；每次改都跑原 60 題、`holdout_blockly`、`domain_dsp.test.js`、`linux_paradigms.test.js`。同家族候選靠 `TOOL_FAMILIES`（沙盒擇一）。
- 讀取器 override：工具型 `readToolInput` 只在舊流程沒讀到、或讀到 hex／lines／rest／樣式角色／無長度 list 時才覆蓋；舊流程有 grid／rows 就不覆蓋。
- 在發布前，別讓 `renderer/src` 留半成品：協調者發布腳本曾用 `git add -A renderer web-lazy` 把我做到一半的改動一起發出（v313），造成 2 組測試退步。
- 判題器 `judge-runner.js` 的 WA 詳情會洩漏預期輸出的格式；對 holdout 不要印。
