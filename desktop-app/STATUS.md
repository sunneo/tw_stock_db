# 狀態（desktop-app）

## 2026-11-05　JSONL 分頁器與檢視器
- 已完成：分頁器、總截斷轉 JSONL、`big_content page`、讀取帳本、VLM 拆解續傳（`DESIGN.jsonl-paging.md` 一～七節）。
- 已完成：檢視器支援 JSONL／NDJSON／JSONC（第八節），匯出 JSON／JSONL／XLSX／SQLite3；`data_core` 56、`dataquery_core` 31、`jsonl-paging` 13 測試全過。
- 未做：JSONL 超大檔行索引虛擬捲動；真畫面實測；`knowledge_ask`／`repo_*` 帶 `_page`；離線小模型比例調校；發布與提交。

## 2026-11-05　多層 JSONL（網頁、深層結構、AST、UML）
- 已完成：長網頁三層（索引→區塊→參照文件）、超深結構攤平與還原、收合／往下鑽、AST 攤平與不完整節點標示、UML 模型 JSONL 轉換（可還原）。`jsonl_pager` 21、`web_blocks` 15、`jsonl-paging` 14、`design_core` 59 測試全過。細節 `DESIGN.jsonl-paging.md` 第九節。
- 未做：UML 往下鑽的工具接線、MIDI 音樂設計同形式、`browser_get_page_text` 區塊化。

## 2026-11-05　第二批：往下鑽工具、MIDI、瀏覽器頁面文字
- 已完成（未發布）：`big_content tree／expand`、`midi_song_jsonl`＋`FaMidi.toJsonl／expandNotes／fromJsonl`、`browser_get_page_text` 長頁面回章節索引（純文字依預算切段）。`midi_core` 29、`web_blocks` 18、`jsonl_pager` 21 測試過；接線只過語法與建置，未實機。
- 未做：UML 的 write 方向、實機驗證。

## 2026-11-05　收尾：UML write 與實機評估
- 已完成：`uml_edit` 的 `model_jsonl_read`／`model_jsonl`；真 Electron 評估 `scripts/eval/layers-jsonl.eval.js`（tree／expand、MIDI、網頁三層、UML）全部通過。
- 已發布：v304（第二批的前兩項與瀏覽器頁面文字）。**尚未發布**：`uml_edit` 的 JSONL 讀寫、評估檔、文件。
- 未做：`browser_get_page_text` 新分支的真 Chrome 擴充功能實測。

## 2026-11-05　思考堆疊（`DESIGN.think-stack.md`）
- 已完成（未提交、未發布）：`think_stack.js`（push／pop、焦點標頭、列檢查、回來核對、自問、JSONL）接進 `jsonStep`、`reworkRegion`／`reworkModel`、反思；測試過；模擬「會忘的小模型」有堆疊時一致。
- 未做：用真的 `qwen3-0.6b` 在使用者機器上量「兄弟一致性」（`uml_bench_core` 加評分）；接 `uml_core` stageSpec 流程、CoLU 計畫階段、`_umlDesign` 外層。

## 2026-11-05　思考堆疊第二批接線
- 已完成（未提交、未發布）：`uml_core.scenarioToModel`（含迴圈列檢查／回來核對）、`designProject` 外層共用堆疊、CoLU 計畫階段 `plan_core.advance` 每步 push／pop 與 `fill` 第三參數。測試：`uml_core` 80、`design_core` 72、`plan_core` 60、`plan_think` 25 全過。
- 未做：用真 `qwen3-0.6b` 量「兄弟一致性」；CoLU 計畫之前的路由（`chooseTool`）尚未建堆疊。

## 2026-11-06　第三批：小窗口、頁數預估、真 Chrome／真瀏覽器／真模型實測（`DESIGN.jsonl-paging.md` 第十節、`DESIGN.think-stack.md` 最後一節）
- 已完成（未提交、未發布）：
  - `knowledge_ask`／`repo_map` 清單／`repo_ask search` 帶 `_page`＋`offset`；頁面 meta 的 `pages_left`；帳本提醒帶「約還要幾頁、現在放得下幾頁」；分頁預算改 token（4096 窗口一頁從 21% 降到預算內）。
  - 超大 JSONL 檢視：批次視窗（Viewer／表格一批 2 萬筆，◂ ▸ 翻批）；真瀏覽器實測 15 萬行。
  - `browser_get_page_text`：用真 Chrome 156 跑擴充功能的 `pageTextExtractor`，**抓到並修了真 bug**（回 `total_length`，程式只認 `total_chars`，長頁面永遠不分層）；回放測試用真輸出。
  - 作曲樹攤平 JSONL（`toJsonl`／`fromJsonl`）＋工具 `midi_compose_tree`（一次寫一個節點）；`uml_edit` 的 `next`／`queue`（一次一格）。
  - `chooseTool` 建思考堆疊（選工具是路由的一層，選了哪個留給補欄位與計畫階段）；計畫目標與工具路由共用一個「路由」堆疊。
  - 思考堆疊「兄弟一致性」：`uml_bench_core.siblingConsistency` ＋ `scripts/eval/stack_consistency.js`，用真 qwen3-0.6b（本機 `llama_cpp_python`）量。
- 測試：核心 198/198（要 `FA_TS_DIR=/tmp/fa-ts-cache`）；真 Electron `small-window.eval.js`、`jsonl-paging.eval.js`、`layers-jsonl.eval.js` 通過。
- 注意：`docs/HANDOFF.md` 的擁有者是 `stevenyc.huang`，這個工作階段（`automation`）寫不進去，所以 HANDOFF 的「下一步」與陷阱（`embed-code-ui.js` 會蓋掉直接改嵌入區塊的程式；tree-sitter 測試要 `FA_TS_DIR`）請改用這一段，或由有權限的人貼進去。
- 未做：擴充功能連線層端對端；擴充功能不回 `title`／`url`；`repo_read_doc`／`repo_sql` 的 `_page`；沒用真的 4096 小模型跑完整問答量「一次讀幾頁」。


## 2026-11-06　第四批：範式骨架庫＋`write_code` 離線組合（block-writer）
- 已完成（未提交、未發布）：
  - `renderer/src/uml/py_paradigms_core.js`（`FaPyParadigms`）17 個範式骨架，每個帶 1～3 個槽位（≤12 組合），程式窮舉組合逐個交沙盒、第一個 AC 就用；`buildFromUML` 順序＝配方→課→範式→區塊迴圈（模型）。
  - `py_paradigms.test.js`（已登記）：不給課，種子（有範式的）17/17、沒見過的改寫 16/16、選項順序反過來 16/16，0 次模型。
  - 宿主：`runCode` 的 `offline` 掛鉤、`_codeOffline`（tree-sitter 走 `_behTsHost`）；沒有模型時 Python 算法題也能做；`embed-code-ui.js` 嵌入 `py_*`／`algo_intent`／內建課。
  - 真 Electron（`scripts/eval/offline-code.eval.js`，0 次模型）：**不給課 20/20**（17 題由範式骨架、3 題由配方）、**給課 20/20**。
- **待改善（第一版，之後已處理的標在後面）**：range-sum 的 85KB 隱藏測資——查明不是判題器卡住，是 main-ext 的判題 IPC 單筆上限 256KB 直接拒絕（回 UNAVAILABLE），離線組合把每個槽位組合都當失敗；**已修**：`_codeAgent` 略過單筆超過 60KB 的測試並在 gaps 說明，`_codeOffline` 遇到判題器不可用立即停止；評測改用完整測資（超大的被略過）20/20。`/teacher-loop` 離線試做、`deriveLesson` 存執行期課與記 paradigm＋slots **已做**（`teach-lesson.eval.js` 真 Electron 驗證）；範式補到 23 個（分治、樹走訪、堆積、區間 DP、二維 DP、矩陣快速冪，`py_paradigms.test.js` 12/12＋反序 12/12）；其他語言未做；待辦 3～7（模型選擇仍弱、讀取器覆蓋小、積木庫擴充、效能）原樣保留在 `DESIGN.TODO.md`。
- 判題 IPC 單筆測資上限 64KB → 256KB（`main-ext.js` 的 `JUDGE_LIMITS.testBytes`、`teacher_check_core.js` 的 cleanTests、`_codeAgent` 略過門檻 250KB、`judge_ipc.test.js`）；range-sum 的 85KB 隱藏測資現在完整驗證，20/20（兩輪）通過。`main-ext.js` 的變更要靠 patch 發布才會到已安裝的使用者。
- 追加（同日，交接後第一批，未提交、未發布）：
  - 範式骨架再補 4 個（回溯 N 皇后 `bt.n-queens`、Dijkstra `sp.dijkstra`、樹狀陣列 `fenwick.point-range`、KMP `str.kmp-count`；`algo_intent_core` 的 ALGOS／PARADIGMS 同步）；`py_paradigms.test.js` 的後加範式 10 個 20/20（原敘述＋改寫）、選項反序 20/20。**待改善**：還缺排列組合回溯、線段樹（區間更新）、Z 函式。
  - 待辦 2：課可記 `paradigm`，這題敘述挑出的骨架不含它就不先試課（`py_uml_pipeline_core.js`）；內建 `fib#1` 標 `dp.fib`；費氏取餘（n 到 10^18）給內建課時直接走 `matrix.fib-mod`（測試已加）。**待改善**：只有 fib#1 標了範式，其餘內建課還沒標；`scripts/teach-builtin-lessons.js` 已改成會保留 `paradigm`，但尚未重跑。
  - 待辦 3：`_otTeacherLoop` 在離線重做失敗時，改用老師回報的程式碼圍欄走 `_pyLearnLesson`（自己重做過判題才收）；回歸失敗會把這堂課移除。`teach-lesson.eval.js` 擴充（真 Electron 通過：由老師程式碼抽課、回歸失敗移除）。**待改善**：只看 `r.text` 的圍欄，老師用 python_execute 工具跑的程式沒抓。
  - 核心測試 200/200。
- 追加（同日）：**多領域 block-writer 第一個領域：DSP**（未提交、未發布；設計與待改善見 `DESIGN.block-domains.md`）：領域包格式（`domain_registry_core.js`）、`domain_dsp_core.js` 17 個骨架、`domain_dsp.test.js` 18 題種子 36/36＋反序 36/36（float 容差、含隱藏大測資、0 次模型），核心測試 203/203，真 Electron 通用題 20/20。**待改善**：另五個領域（影像、分散式／平行含同步、虛擬化、最佳化、資料結構）沒做；DSP 沒跑真 Electron、沒有 FFT。

## 2026-11-06　評估：「所有演算法都能變成矩陣相乘嗎」（`DESIGN.matrix-algorithms.md`）
- 已完成（未提交、未發布；評估任務，不進產品）：
  - `DESIGN.matrix-algorithms.md`：結論＋證明過／驗證過／推測三分；LALR 表是矩陣但驅動需要堆疊；未知題 function body 對應矩陣的範圍與資料障礙；對 block-writer 的建議。
  - `renderer/src/algo/matrix_forms_core.js`＋`matrix_forms.test.js`（49 項，已登記進核心測試）：DFA 連乘與前綴掃描、min-plus／布林圖（對 Floyd／Dijkstra／BFS／並查集）、Berlekamp–Massey 遞推、LALR 表矩陣驅動（用 `logmine/lr_core.js`）＋有界堆疊組態數（K=2…14：3→5407）、CYK 布林矩陣、Hankel 秩、Ho–Kalman 學習、狀態合併學 DFA，皆有隨機對照與反例。
- **待改善**：只在小字母表／短字串上驗證；稀疏範例（未知題只有 2～3 筆 tests）下的學習沒有實驗；`range-sum`、`knapsack` 的分類是推測；是否把 state-machine／semiring-closure／linear-recurrence 範式接進範式骨架庫由使用者決定（沒動 `py_paradigms_core.js`）。
- 追加（同日）：使用者加問「多個小矩陣＋狀態機」「ReLU, CoLU」「矩陣運算當成虛擬機器」→ `DESIGN.matrix-algorithms.md` 第 9～11 節；新增 `renderer/src/algo/matrix_machine_core.js`（暫存器機）、`relu_core.js`（ReLU 電路）、`matrix_vm_core.js`（19 種封閉指令、JSONL、驗證器、8 個編譯範例）＋`matrix_machine.test.js`（28 項，已登記）。直和 vs 乘積 2、5、10 維 vs 2、6、30 狀態；ReLU 整數除法閘數隨範圍線性成長；種子 20 題裡 VM 矩陣指令是主角 6 題、其餘 14 題只是普通暫存器機。**待改善**：VM 沒有形狀／型別的庫存規則、沒有 VM→Python、BFS 走訪與 ReLU 學習沒測。
- 追加（同日）：使用者命題「內層ReLU被實做出來、驗證各種輸入輸出都滿足，就足以被編譯成一個CoLU」→ `DESIGN.matrix-algorithms.md` 第 12 節＋`renderer/src/algo/relu_compile_core.js`／`relu_compile.test.js`（16 項，已登記）：ReLU→決策樹／CoLU 機器的編譯是精確等價、不靠驗證；驗證只負責「網路＝規格」，兩者合起來才成立，且限於有界整數域、整數語意、精確算術、網路夠小；排序 n=6：15 閘→720 葉、x mod 3（N=1000）666 葉。**待改善**：沒有 LP／SMT 剪枝與逐區域證明、沒有梯度學出的網路。
- 追加（同日）：使用者問「無法用矩陣接起來的有什麼程式化的銜接?另一個矩陣?堆疊?」→ `DESIGN.matrix-algorithms.md` 第 13 節＋VM 新增 `tr onehot enq deq jqe`、`matrix_memory.test.js`（11 項，已登記）：四種缺口各有封閉的銜接（計數器／堆疊／佇列／陣列、控制狀態機、半環或 ReLU、one-hot 位址）；另一個矩陣能代替有界堆疊（移位矩陣，控制狀態線性成長，對照堆疊內容展開是指數）與陣列（one-hot，O(n)），不能代替無界堆疊（除非元素放無界整數）；種子 20 題最少記憶體：無 3、計數器 1、堆疊 2、陣列／佇列 14；雙調排序 n=16：80 vs 氣泡 120 比較。**待改善**：沒有靜態庫存規則；DFS／堆積／LRU 只是歸類。
- 追加（同日）：使用者問「如果這個可行…核心會是很難解讀的黑盒子嗎」→ `DESIGN.matrix-algorithms.md` 第 14 節＋`renderer/src/algo/matrix_decompile_core.js`／`matrix_decompile.test.js`（15 項，已登記）：不必然；結構式矩陣可反編譯成遞推式／狀態圖／正規表示式／if-else／中文 CNL，稠密學出的矩陣才是黑盒子；可讀性隨大小下降（隨機 DFA 正規表示式 n=3→7：29→108 字元；30 狀態 DFA 91 行 vs 三個小機器 33 行）；VM 約人寫 Python 的 1～6 倍行數。**待改善**：CNL 沒接 py_blocks 的受控自然語言、沒有 VM→Python、命名要手動、門檻是判斷。
