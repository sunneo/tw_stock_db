# 交接：block-writer（範式骨架庫＋離線組合；下一階段：補缺口、第二個語言、LLVM IR）

## 1. 開場提示（接手者收到的原文）

請接續 `desktop-app/HANDOFF.block-writer.md`：完整讀完（含使用者原話與工作方式），照著做，並執行 low-context-long-run 技能（門檻 30%）：做下一個待辦，context 到門檻就寫下一份交接、啟動自己的接手者。第一則訊息請用一行確認你讀了文件、從哪個待辦開始。
使用者原話（2026-11-06）：「先做一個程式語言，第二步是做llvmir，然後llvm ir => code gen」；以及「* 沒有對應範式的算法，仍要請老師或模型；還缺回溯、圖最短路、線段樹、字串匹配。* 內建課遇到 n 很大的題（例如費氏取餘）會先試課、逾時後才退到範式，比較慢。* 老師迴圈只在離線自己重做通過時才抽課，老師的解答若沒走這條路就不會變成課。* HANDOFF 待辦 3～7（模型選擇仍弱、讀取器覆蓋小、積木庫擴充、效能）是長期項目，沒有動。先做」。使用者已確認排序：**先做完上面四個待改善，再做「第二個語言的區塊庫（Node.js）→ LLVM IR → 由 IR 產生程式碼」**。

## 2. 概況

- repo `tw_stock_db`，資料夾 `/home/hungfu.lee/下載/SRC/tw_stock_db/desktop-app`，分支 `desktop-app`，HEAD `8531a9ed`。Linux、使用者 `automation`。**這個工作階段與之前的全部變更都未提交、未發布**（使用者規定：「可以都完工再來發布」，只在他說「提交並發布」時才提交發布；提交走 `ssh hungfu.lee@127.0.0.1`，但自動模式分類器曾拒絕我用 ssh，要提交時請先問使用者）。
- 本階段已完成（全部未提交）：
  - `renderer/src/uml/py_paradigms_core.js`（`FaPyParadigms`）**23 個範式骨架**，每個 ≤12 個槽位組合，程式窮舉＋沙盒、第一個 AC 就用；`buildFromUML` 順序＝配方→課→範式→區塊迴圈（模型）；骨架可有 `when(statement)`。
  - `py_paradigms.test.js`（已登記 `scripts/run-core-tests.js`）：種子 17/17、改寫 16/16、反序 16/16、後加 6 個範式 12/12＋反序 12/12；`deriveLesson` 可記 `paradigm`＋`slots`。
  - `algo_intent_core.js` 的 `ALGOS`／`PARADIGMS` 新增 inversions／tree-traversal／kth-smallest／lps／lcs。
  - 宿主（`renderer/src/floating-assistant.js`）：`_codeOffline`（tree-sitter 走 `_behTsHost`）、`_pyParserSync`、`_pyLearnLesson`（老師解答→課，只靠這堂課自己重做過判題才收）、`_pyLessonsLoad/Save/Export`（localStorage `fa_py_runtime_lessons`）、`_otTeacherTryOffline(text, s, item)` 對 Python 判題項目先走離線組合；`code_agent_core.runCode` 的 `offline` 掛鉤；`embed-code-ui.js` 新增 `py_*`／`algo_intent`／內建課嵌入（floating-assistant.js 已有對應 `/* PYxxx-BEGIN */` 標記）。
  - 判題 IPC 單筆測資上限 64KB→**256KB**（`main-ext.js` `JUDGE_LIMITS.testBytes`、`teacher_check_core.js`、`_codeAgent` 略過門檻 250KB、`scripts/main-tests/judge_ipc.test.js`）。`main-ext.js` 的變更要靠 patch 發布才到已安裝使用者。
  - 驗證（我實測）：真 Electron `scripts/eval/offline-code.eval.js`：20 題（含 85KB 隱藏測資）不給課 20/20（17 範式＋3 配方）、給課 20/20，0 次模型；`scripts/eval/teach-lesson.eval.js` 通過；`judge_ipc.test.js` 4 passed；核心測試在 256KB 修改前 199/199。**256KB 修改後的完整核心測試我交接時還沒看到結果：請重跑** `FA_TS_DIR=/tmp/fa-ts-cache node scripts/run-core-tests.js` 確認 199/199。
  - 文件：`DESIGN.ast-nodes.md` 7.3、`DESIGN.TODO.md` 現況列、`STATUS.md` 第四批已更新。
- 其他工作階段：`matrix-algorithms-1`（local_794f0770-fcf5-4319-9622-05fa9424f6fb）在做矩陣演算法，別碰它的檔案。

## 2b. 交接 1 的進度（2026-11-06，全部仍未提交、未發布）

- 待辦 1～3 **已做完並驗證**：範式 23→27（`bt.n-queens`、`sp.dijkstra`、`fenwick.point-range`、`str.kmp-count`）、課可記 `paradigm` 且骨架不含它就不先試課（費氏取餘給課也直接走 `matrix.fib-mod`）、老師迴圈在離線重做失敗時用老師的程式碼圍欄抽課（回歸失敗會移除課）。驗證：`py_paradigms.test.js` 89 passed、核心測試 200/200、真 Electron `offline-code.eval.js` 不給課 20/20＋給課 20/20（0 次模型）、`teach-lesson.eval.js` 含新增整合項通過。`STATUS.md`／`DESIGN.TODO.md` 已更新。
- 剩餘（待改善）：排列組合回溯、區間更新線段樹、Z 函式；只有 `fib#1` 標了 `paradigm`（其餘內建課沒標，`teach-builtin-lessons.js` 已改成保留欄位但未重跑）；老師用 python_execute 跑的程式沒抓。
- 週額度 82%（context 僅 15%）時停手交接。**下一步從下面「待辦 4（挑一小塊）」或直接「待辦 5 第二個語言 Node.js」開始**（待辦 1～3 不用再做）。

## 2c. 新任務（2026-11-06，父工作階段轉達使用者）：多領域 block-writer，第一個領域 DSP

使用者原話：「接著是要多領域的block-writer，像是數位訊號處理的演算法」。目標：block-writer 從競賽式算法題擴成多領域；領域包（詞彙＋讀取器、積木庫、範式骨架、種子題＋隱藏測資）、判題容差模式（先看 judge-core.js／judge-runner.js 支援什麼，單筆上限 256KB）、與矩陣評估連動（DFT＝矩陣乘、FIR＝Toeplitz、IIR＝狀態空間；`DESIGN.matrix-algorithms.md`，不要等它）、驗證同 7.3（不給課、0 次模型、種子＋改寫都過沙盒，至少 15 題 DSP 種子題含隱藏測資與容差）、文件（`DESIGN.ast-nodes.md` 7.4 或 `DESIGN.block-domains.md`：領域包格式、註冊方式、怎麼用 /teacher-loop 教課，誠實列待改善）。先讀 DESIGN.ast-nodes.md 第六、七節與 7.3、DESIGN.TODO.md block-writer「未完成 4～6」、py_blocks_lib_core.js、py_paradigms_core.js、algo_intent_core.js、judge-core.js／judge-runner.js。此任務排在待辦 5（Node.js）之前，由使用者透過父工作階段指定。

### 2c 追加（同日，父工作階段逐字轉達，使用者原話）

- 「影像處理的演算法」（第二個領域，接在 DSP 後；領域包格式不要為 DSP 寫死）。內容建議：讀取器（二維陣列／灰階／RGB、核大小、閾值）、積木（卷積、高斯／均值／中值、Sobel／Laplacian、直方圖等化、Otsu、形態學、連通區域標記、縮放旋轉插值、色彩空間、積分圖）、範式骨架（滑動視窗 2D 卷積、可分離＝兩次 1D、BFS／並查集連通區域、直方圖→CDF→查表、積分圖、距離變換 DP）；沿用 DSP 的容差判題；小圖 8×8～32×32；至少 15 題。
- 「分散式運算、平行運算的演算法」（第三個領域）；範式：map-reduce、分塊歸併、平行前綴和、歸約樹、資料平行、工作佇列、雜湊分片、樣本／雙調排序、BSP／Pregel、矩陣分塊乘法、一致性（選舉、Paxos／Raft 狀態機）、同步。判題＝確定性模擬（multiprocessing／threading 或自製小排程器），輸出與單執行緒參考逐項相同，另加性質檢查（無資料競爭、切分總和、死結用逾時）；引用矩陣評估（矩陣連乘結合律→分段平行、前綴掃描；半環歸約＝平行歸約）；至少 15 題；沙盒資源不足要誠實列待改善。
- 「平行運算與同步的演算法也要」：同步另列一組至少 15 題（Peterson、Dekker、麵包店、test-and-set／CAS 自旋鎖、semaphore／monitor、有界緩衝區、讀者寫者、哲學家用餐、barrier、無鎖 CAS 堆疊／佇列與 ABA、死結偵測與銀行家演算法、優先權反轉、記憶體模型）。判題＝確定性排程器窮舉小規模（2～3 執行緒、少量步驟）全部交錯或固定種子交錯；性質：互斥、無死結、無飢餓、有界等待、結果與排程無關；錯的實作要能報出反例交錯。排程器做成可重用小元件（虛擬化領域也用）；交錯＝狀態機乘積。
- 「虛擬化設計概念的演算法」（第四個領域）：分頁／多級頁表／TLB 位址轉換、頁面置換（FIFO／LRU／Clock／OPT）、CPU 排程（RR／SJF／MLFQ／CFS）、資源配置（首次／最佳適應、buddy、slab）、超賣與 bin packing 放置、電梯 I/O 排程、檔案系統配置、小虛擬機指令解釋器；判題＝確定性模擬逐項相同。
- 「尋求問題並接起現有應用的演算法呢?例如螞蟻演算法，貪婪演算法」（第五個領域，最佳化／啟發式）：貪婪（活動選擇、找零、哈夫曼、區間排程、Kruskal／Prim、Dijkstra）、ACO、模擬退火、基因演算法、爬山／禁忌、粒子群、分支定界、回溯、A*、背包近似。重點＝敘述→「這是最佳化／搜尋問題」→抽目標函數與限制；槽位＝目標函數、鄰域、選擇規則、終止條件、費洛蒙更新與揮發率；隨機性演算法固定種子、用品質門檻判（例如 ≤ 參考貪婪解 1.05 倍或達已知最佳），確定性者逐項相同。擴充 `algo_intent_core.js` 的 PARADIGMS 與動作表，不另起。
- 「記憶體配置是屬於...? 樹狀節點與平衡嗎」→ 父工作階段的歸類（照辦）：記憶體配置（首次／最佳適應、buddy、slab、TLSF）歸虛擬化領域，但用到資料結構；新增**第六個領域「資料結構」**：BST（插入／刪除／前驅後繼）、平衡（AVL、紅黑、treap、splay）、堆積、trie、線段樹／Fenwick、區間樹、並查集、雜湊表（開放定址／鏈結）、B 樹、跳躍表、LRU；槽位＝節點欄位、比較規則、重新平衡觸發與旋轉、不變量；判題＝隨機操作序列對照 sorted／heapq／dict 逐步相同＋不變量檢查（樹高≤1.44 log n、紅黑性質、堆序）。記憶體配置骨架要引用資料結構的積木（best-fit＝平衡樹 lower_bound），**領域包格式要支援領域間積木相依**。
- 六個領域：DSP、影像、分散式／平行（含同步）、虛擬化（含記憶體配置）、最佳化／啟發式、資料結構。建議順序：資料結構與虛擬化相鄰（共用積木），其餘照先前。**每批一個領域，做完跑核心測試與評測再做下一個；每個領域至少 15 題種子題（含隱藏測資），不給課、0 次模型，種子與沒見過的改寫都要過沙盒，誠實列過不了的；六個領域完成後寫領域包格式與新增領域的方法文件（待改善如實列）。** 判題器已有 `float` checker（`judge-core.js`，`opts.eps`，相對誤差，逐 token 比數字）；複數／整體容差／性質檢查尚無，要擴充。

### 2d 進度（交接 1 之後，未提交）：領域 1 DSP 完成

- 完成：`domain_registry_core.js`、`domain_dsp_core.js`、`domain_dsp.test.js`（36/36＋反序 36/36）、host 註冊（`_pyDomainsInit`）、embed 與測試登記；核心測試 203/203。文件：`DESIGN.block-domains.md`（領域包格式、新增領域步驟、待改善）、`STATUS.md`。
- **下一步：領域 2。** 建議順序（父工作階段）：資料結構與虛擬化相鄰做（共用積木，先用 `requires`／`snippets` 做第一個真實跨領域相依）；影像；分散式／平行（先做可重用的確定性排程器／交錯窮舉元件，同步另列 15 題）；最佳化／啟發式（判題器要加「品質門檻」checker，固定種子）。每批一個領域：種子 ≥15 題含隱藏測資、原敘述＋改寫＋選項反序、不給課、0 次模型；做完跑核心測試與 `offline-code.eval.js` 再做下一個。新增領域的步驟見 `DESIGN.block-domains.md` 第 2 節；骨架槽位值用 option 的 `v`（不是 id）。
- 週額度 83%，所以這個階段停手、沒有啟動接手者；若要續做，從領域 2 開始。

## 3. 待辦（依序）

1. **補範式缺口**：回溯（N 皇后／排列組合）、圖最短路（Dijkstra／BFS 加權）、線段樹／樹狀陣列、字串匹配（KMP／Z）。做法同 `py_paradigms_core.js`：新增 `ALGOS` regex＋`PARADIGMS` 項＋骨架（≤12 組合）＋`py_paradigms.test.js` 的 `EXTRA` 加題目＋參考程式＋隨機測資＋改寫＋反序。**骨架限制**：本文走「程式區塊：」→`parseCNL`，**巢狀 `def` 會被丟掉**（`stmtsOfSource` 只取敘述），所以不能用 `def`（遞迴改堆疊、矩陣用四個變數）；避免 `a = b = 0` 連續賦值；局部變數撞題目變數名會自動改 `名_2`。
2. **課先逾時的問題**：n 很大的題（費氏取餘）內建課 `fib#1` 會先試而逾時，才退到範式。建議：配對課時看敘述（骨架的 `when`）或給課加排除條件；最少要讓這題直接走範式。驗證：`fib-mod` 題在「給課」的情況下也由範式解出且不逾時。
3. **老師解答也能抽課**：`_pyLearnLesson` 目前只在 `_otTeacherLoop` 的 `rv.ok && lastOut`（離線訓練器自己重做的輸出）時呼叫。要讓「老師的解答」（老師子任務回報的 Python 程式碼，通常在 `r.text` 的 ```python 圍欄，或用 `FaTeacherCheck.extractCode`）在離線沒重做出來時也能抽課：先 `_pyLearnLesson`（它自己會驗證「這堂課重做過判題」才收），成功就當作這一項已教會。注意老師迴圈的回滾／回歸邏輯（`_otTeacherSnapshot/Regress`）。驗證：擴充 `teach-lesson.eval.js`。
4. **舊待辦 3～7**（`DESIGN.TODO.md` block-writer 的「未完成 3～7」）：模型選擇仍弱（目標動詞過濾、規則更緊）、讀取器覆蓋小（多組測資、二維陣列、含空白字串、輸出格式變體）、積木庫擴充、其他語言、效能（KV 快取）。長期項目：每次挑能驗證的一小塊做，如實列成「待改善」，不要假裝做完。
5. **第二個語言：Node.js 區塊庫**（使用者要求；已確認）。每個語言各自一份、不跨語言共用：照 Python 那套——`js_blocks_core.js`（區塊範本庫）、規則、庫存、課、範式骨架、codegen、tree-sitter（javascript wasm 在 `tree-sitter-wasms`）。先讀 `py_blocks_core.js`／`py_blocks_lib_core.js`／`py_blocks_rules_core.js`／`py_code2uml_core.js` 的結構再動手；用同 20 題種子驗證。
6. **LLVM IR**（第二步）：專案已有 `renderer/src/uml/llvm_core.js`＋`llvm_core.test.js`（`DESIGN.ast-nodes.md` 第五節提到「指令層級」）——**先讀它現有做到哪裡**。目標：程式（IR）→ LLVM IR。
7. **LLVM IR → code gen**（第三步）：由 LLVM IR 產生各語言程式碼；接既有工具（如 `uml_to_wasm`）前先 grep。
8. 收尾：文件（`DESIGN.TODO.md` 現況列、`DESIGN.ast-nodes.md`、`STATUS.md`）、`node scripts/embed-code-ui.js && node build-assistant.js`、`FA_TS_DIR=/tmp/fa-ts-cache node scripts/run-core-tests.js`（要全過）。**不要提交發布，除非使用者說「提交並發布」。**

## 4. 工作方式（使用者的規則，原樣照辦）

- 回應用繁體中文或英文，**簡體字絕對不行**；講清楚在做什麼、給看得到的輸出，不要讓使用者猜是不是卡住；誠實區分「我驗證的／別人回報的／推測」；沒達標叫「待改善」，不要說成完成。
- **先讀專案現有的程式再動手**（tree-sitter、離線訓練器、`uml_design`、`/offline-trainer-by-ai`、`llvm_core.js` 都早就存在；使用者多次因為沒讀而生氣）。
- 寫程式：每個語言各自一份、不跨語言共用；`write_code` 只有一個入口；`write_code` 領域關閉思考；流程是 UML 切割（`uml_design`）→ 骨架 → 區塊迴圈（庫存過濾合法選項、嚴格範本）→ 模型只在合法庫存內微選擇 → 沙盒 ⇄ 錯誤回饋；函式 body 固定三區（引入、宣告、邏輯與流程）；Claude 教會之後要內建進去。大模型在 wasm 跑不動，所以要讓小模型每一步的選擇更少、更明確。
- 開發期間步數上限維持無限大；有多少 release 多少；下載與安裝先取得同意並列出檔名、來源、大小；熱更新不准要求重裝；版號單調遞增；**不使用埠 17923**；原生執行器不開。
- 提交與發布一律用 `hungfu.lee`（`ssh hungfu.lee@127.0.0.1`，cd 到同資料夾）；`scripts/publish.sh -m … --skip-build` 並帶 `PUBLISH_TRAILER`；建置要先用自己的帳號做完再 `--skip-build`。提交只加自己的檔案（別的工作階段的未提交檔案：`features/FEATURES.md`、`skills/image-decompose-redraw/data/parts_builtin.json`、`DESIGN.edit-*.md`、`DESIGN.env-baseline.md`、`HANDOFF.edit-remote.md`、`skills/weak-model-harness/scripts/bridge/`、`72d21a0c-…` 資料夾都不是我的）。提交訊息結尾加：`Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`。
- 週額度接近 90% 就交接（上次看：週 77%、5 小時 26%）。
- `docs/HANDOFF.md` 的擁有者是 `stevenyc.huang`，`automation` 寫不進去，不要 chmod；進度寫在 `STATUS.md` 與本檔。
- 不要自己動權限設定；自動模式分類器拒絕的動作（例如 ssh）不要繞過，停下來告訴使用者。

## 5. 使用者原話（逐字，附日期）

- 2026-11-05：「json的檢視器，要支援階層view, source view, 以及table view (轉table,類似excel)，也要支援jsonl, jsonc格式。要可以匯出json, xlsx, sqlite3 把DESIGN.jsonl-paging.md完成」「完成後請把狀態更新到STATUS跟HANDOFF」
- 2026-11-05：「可以都完工再來發布」、「提交並發布」（每次發布都是他明確說這句才發）
- 2026-11-05：「uml-design與midi音樂設計也是 我希望可以藉由這個形式來讓任意窗口的模型都能達成」「我們也可以對於uml-design的遞迴深入，保有原有的結構，但是提供一個flatten-jsonl converter，這個convert出來的結構可以正確對應回去」
- 2026-11-05：「我的想法是只要脈落傳過去，並且它可以當下留下一個"該檢查什麼" 的文字跟標準 就像是在面對一個經常失億的工程師」
- 2026-11-06：「先完成用真的 qwen3-0.6b 量思考堆疊的兄弟一致性。需要有模型的機器，目前只有假模型。」＋「browser_get_page_text 長頁面章節索引，用真的 Chrome 擴充功能實測」「JSONL 分頁的舊待改善」「CoLU 計畫前的路由（chooseTool）建思考堆疊」「MIDI compose_tree 攤平，以及 UML／MIDI 的「小窗口分段寫」」（已做完，見 STATUS.md）
- 2026-11-06：「接著完成 offline model的DESIGN.TODO的block writer的項目 範式骨架庫(每個範式一個帶槽位的區塊谷架) 寫程式的離線組合(uml_design、課、區塊迴圈、沙河)接進wrie_code」（已做完）
- 2026-11-06：「為什麼有64k上限，可以提高?這個限制的規則是什麼」→「調到256K ok」（已做）
- 2026-11-06：「* 沒有對應範式的算法，仍要請老師或模型；還缺回溯、圖最短路、線段樹、字串匹配。* 內建課遇到 n 很大的題（例如費氏取餘）會先試課、逾時後才退到範式，比較慢。* 老師迴圈只在離線自己重做通過時才抽課，老師的解答若沒走這條路就不會變成課。* HANDOFF 待辦 3～7（模型選擇仍弱、讀取器覆蓋小、積木庫擴充、效能）是長期項目，沒有動。先做」
- 2026-11-06：「先做一個程式語言，第二步是做llvmir，然後llvm ir => code gen」（使用者確認：第一步＝第二個語言（Node.js）的區塊庫；順序：先做完上面四個待改善，再做語言／LLVM）
- 寫程式流程（記錄在 `DESIGN.ast-nodes.md` 第六、七節，使用者逐字重點）：UML 任務切割 → 程式骨架生成（Boilerplate）→ 進入 Block 產生迴圈〔① 程式端計算當前 Symbol Table（Inventory）② 用 Inventory 過濾合法區塊選項 ③ 套嚴格 Template（For／While 結構防呆）〕→ 模型僅在合法 Inventory 內做微型選擇 → 沙盒編譯驗證 ⇄ 錯誤回饋。

## 6. 交接程序（自我遞迴）

執行 low-context-long-run 技能，門檻 30%（用 `mcp__ccd_session_mgmt__get_usage` 看自己的 context 百分比，只在一個完成的工作單位之後檢查）。到門檻：改寫這份文件（不要新開一份，保留逐字使用者原話、追加新的）→ 提交這份文件（只在使用者允許提交時；否則只寫檔、在報告裡說明未提交）→ `mcp__ccd_session__start_session`（initiation `user_asked`、context `fresh`、同資料夾、標題「block-writer · handoff N」）→ 等接手者確認它讀了文件並開始第一個待辦 → `mark_completed` 再 `archive_session`（被拒就停，告訴使用者哪個 session id 沒封存）。待辦清空且驗證完就不要再交接，直接向使用者報告完成。

## 7. 陷阱

- `scripts/embed-code-ui.js` 會把 `renderer/src/` 模組整份蓋回 `floating-assistant.js` 的嵌入區塊：直接改嵌入區塊的程式會被蓋掉。先 `grep -rl` 找來源檔，改完 embed＋build 後 grep 確認還在。宿主程式（`_codeOffline` 等方法）不在嵌入區塊，直接改 `floating-assistant.js` 即可。
- 核心測試的 tree-sitter 組在沒有快取時「略過」會被算失敗；快取在 `/tmp/fa-ts-cache`：`FA_TS_DIR=/tmp/fa-ts-cache node …`。核心測試同時跑 embed 會讓 `tray_dialog` 暫時失敗（單獨跑 7/7）。
- `pkill -f`／`pgrep -f` 的模式會比對到自己的 bash 指令而殺掉自己：用 `ps -eo pid,args | grep "[x]yz"` 取 pid 再 kill。
- 真 Electron 評測：`xvfb-run -a node scripts/eval/run_eval.js <評估檔> <埠>`，run_eval 有 170 秒上限；一次跑太多題會逾時，分批或縮減。`offline-code.eval.js` 跑兩輪（不給課／給課）。
- 前台指令超過 120 秒會被丟到背景；等結果用 Monitor（until 迴圈），不要 `sleep` 串接；Monitor 的 grep 條件別用太常見的字（「通過」會被判題測試的輸出誤觸發）。
- 判題 IPC 的限制在 `main-ext.js` `JUDGE_LIMITS`（程式 200KB、60 筆測試、單筆 256KB、逾時 20 秒）；超過回 `{ok:false,error}` 被包成 UNAVAILABLE。
- 生 0.6B 連 UML 的參與者階段都過不了：評測要先由程式回答前兩階段。
- 用內嵌指令寫修補程式會吃掉反斜線與引號：寫成檔案再執行。
- 內建課遇到大 n 會先試課逾時（待辦 2）；內建課 id 會跟執行期課撞號，`_pyLearnLesson` 的 serial 已把內建＋執行期都算進去。
