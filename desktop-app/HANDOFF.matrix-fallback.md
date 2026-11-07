# 交接：矩陣層後備（matrix-fallback）— 給 stevenyc.huang 的 session 冷啟動接手

寫於 2026-11-07。讀者不需要知道先前的對話。先讀本檔，再讀 `DESIGN.matrix-fallback.md`（全文，§9.5～9.7 最重要）與 `DESIGN.matrix-algorithms.md`。

## 1. 目標（一句話）

桌面版 `desktop-app`（repo `tw_stock_db`，分支 `desktop-app`）的「寫程式」離線管線是：配方 → 課 → **Blockly 範式骨架** →（新）**矩陣層** → 區塊迴圈（小模型）。Blockly 評估不出來的題目，改用矩陣層（`renderer/src/algo/matrix_synth_core.js`）只靠「題目敘述＋範例」合成 Python 程式，過沙盒（含隱藏測資）才算解出。兩者合起來要盡量涵蓋「可解」問題；**不得宣稱涵蓋所有問題**，要給涵蓋表與解不出清單。

分工（2026-11-07 起）：**Blockly 範式／課的擴充由 blockly-teach 那條線負責，不在本檔範圍；本檔只負責矩陣層。**

## 2. 已完成（提交都在 `desktop-app` 分支，均未發布）

| hash | 內容 |
|---|---|
| 5a69d482 | 未解題分類報告（DESIGN §9.7） |
| 434d1223 | held-out 題庫 48 題（`gen_heldout.py`、`heldout_all.jsonl`）與首次實測、`bench_coverage.js --set` |
| 10103bcd | `synthTemplate`（37 個 L4/L5 小範本）、`--files` 選項 |
| 290ff059 | 修 `b-lucas-mod` 參考解、記錄題庫被污染 |
| 1ba893d9、89f2087d、5afacde1 | L0 公式枚舉、L1 遞推、L2 自動機、`buildFromUML` 接線（`Matrix`／`examples` 參數） |
| e9da31cd、9b106be6 | 基準題庫與跑分器、設計文件 |

矩陣層現有：`synthRecurrence`（階≤4、BigInt 矩陣冪）、`synthDFA`（個數取模／值取模／含不含開頭結尾子字串／出現次數）、`synthTemplate`（37 個小範本，輸入形狀僅 int／str／k＋str／n＋清單）、`synthFormula`（大小≤9 的整數公式枚舉）。入口 `synth({statement, examples, judge, budget})` 回傳 `{ok, source, kind, level, verified, ambiguous, …}`。核心測試 206/206（`matrix_synth.test.js` 已登記）。

## 3. 數字（誠實版）

- **舊 60 題基準**（`bench_(L|extra)*.jsonl`）已被污染（別的 session 針對它補了範式）：A 59/60、B 60/60，只能當回歸測試。
- **保留題庫（held-out）48 題**（`heldout_all.jsonl`，**已凍結：不要依它調整合成器或範式，也不要讓補教學的 session 看題目**）：模式 A（Blockly）**17/48**、模式 B（Blockly＋矩陣層）**21/48**。矩陣層只多解 4 題（L0 公式 2、L1 遞推 2，其中 1 題 `verified:false`）；L3～L6、other 矩陣層 0 貢獻。這批題是同一作者寫的，信賴區間寬。
- **Linux 題庫**（`bench_linux_all.jsonl`，64 題，train 37／holdout 27）：模式 B 0/37（train），多半是依規格實作、格式解析，矩陣層邊際價值小。
- 之前用過的 `holdout_blockly.jsonl`（31 題）已被我用來補範本，不再是獨立指標。
- **graph／grid 模組（2026-11-07，stevenyc.huang 的 session，v325）**：`renderer/src/algo/matrix_graph_core.js`＋`FaMatrixSynth.register('graph'／'grid')`（宿主 `MATRIXGRAPH-BEGIN/END`，`install` 在 MATRIXSYNTH 之後）。完成待辦 1（邊表／格子形狀）、2（L3 半環：DAG 路徑數、恰好 k 步、最少邊數、到每點最少邊數、有環（有向／無向）、DAG 最長路、可達數、Dijkstra、度數、入度 0、s→t 可達、最大連通分量、字典序拓撲）、4（格子：轉置、上下／左右翻、旋轉 90／逆 90／180、列／欄／全部總和、最大值、某字元個數、島嶼數）。數字：`heldout2_graph.jsonl`（被範本吃掉，只當回歸）verified 20/22（基準原本 0/22）；**第三批 `heldout3_graph.jsonl`（graph／grid 做完後另寫，措辭、起點、標籤、header 形狀都換）第一次量測 13/21（verified 12、ambiguous 1），修掉三個通用小缺口（「首行」、HAS_CYCLE 這種含底線的標籤、「最少要幾步」）後 15/21 verified**；剩下 6 題刻意是範本庫沒有的（出度、最小生成樹、連通分量個數、每列最大值、方陣乘法、方陣冪的跡），全部誠實回 ok:false。量測：`node scripts/eval/matrix_bench.js heldout3_graph.jsonl`。G8（`transitiveClosure` 判環）已修（見 DESIGN §12 G8）。L0 補強（v327，`matrix_l0_core.js`：predicate 條件判斷、multi 多整數輸出、real 小數公式；`synthFormula` 多給 alternatives、`synth()` 在 judge 退掉第一個候選時依序試 alternatives；常數先驗＝敘述數字＋中文數量詞＋領域常數（時間 60／3600、公分 100／10000）＋輸入個數 k）已做：新批 `heldout5_l0.jsonl`（`gen_heldout5.py`，12 題）基線 0/12 → 合成成功 7/12、**verified 4**（秒數時分秒、商與餘數、三數平均、BMI）；3 題（閏年、3 或 5 的倍數、區間內）只有 2 個範例時湊出 ambiguous 候選，雖過了隱藏測資也標「沒有被獨立驗證」，不算 verified——**這是設計：條件判斷在 2 個範例下本質上欠定，要靠「主動要更多範例」（待辦 3）才會好**；5 題範本沒有的題型（gcd、階乘、冪取模、兩數和奇偶、三角形）誠實失敗或只給 ambiguous。凍結 `heldout_all` 模式 B 28→30/48（注意：這次補強的類別是看過 ho-avg4／range3／clock／leap 的失敗類型才選的，+2 不是乾淨泛化）。v328：predicate 修掉自相矛盾的組合（同一變數同一家族不再 and／or）、候選先偏好「用到所有輸入變數」；閏年與 3／5 倍數現在湊出正確公式（仍標 ambiguous，因為只有 2 個範例）；ambiguous 時回 `suggest`（前幾名候選答案不一致的輸入），經 pipeline／宿主／`code_agent` 報告文字帶出「補這幾筆輸入的正確輸出就能分出候選」——**主動要更多範例的資料面已通，卡片 UI 與「補完輸出後重跑」還沒做**。三角形、區間內因 2 個範例下候選太多（前 40 個裡沒有對的）仍失敗。未做：、matrix→UML／Blockly 反編譯、第三層介面。凍結的 `heldout_all.jsonl` 模式 B 21/48 → **28/48**（沒有為它調整任何東西，但範本家族的選擇受過 DESIGN §12 對它的失敗分析影響，所以這個 +7 不是乾淨的泛化數字）；原 60 題模式 B 60/60。`bench_coverage.js` 現在會自動 install graph／grid。**真 Electron 已驗證**（`scripts/e2e/matrix_graph.e2e.mjs`：graph 模組可達數 by matrix／verified；graph2 MST、fs FAT、linuxsem TCP 都由領域包範式解出且 verified，頁面錯誤 0）；種子 20/20 保持。**之後（v326）補了出度／入度／連通分量個數／MST／每列欄最值／方陣乘法相加冪跡（`sqmat` 模組）→ heldout3 變 21/21（已被吃掉）；另寫第四批 `heldout4_graph.jsonl`（`gen_heldout4.py`，措辭再換、混 5 題新題型：二分圖、奇度數個數、對角線和、對稱判斷、行列式）：第一次 13/19 verified，修「第一行為 n m」一個通用缺口後 14/19；5 題新題型誠實失敗。下一批範本做完要再寫第五批。**

## 4. 待辦（依序；來自 DESIGN §9.7）

1. **輸入形狀推斷**（`inferShape` 目前只認單行單詞）：邊表（首行 `n m` ＋ m 行 `a b [w]`；有向／無向由敘述「無向／→」判斷）、格子（首行 `r c` ＋ r 行）、n＋清單、逐行（首行 n＋n 行文字）、十六進位／位元組字串。
2. **L3 半環範本**（預期 +5，最有把握）：路徑計數（DAG 上 (+,×)）、最短步數（(min,+)／BFS）、有環（閉包對角線）、最長路（(max,+)）、可達數（布林閉包）。選範本靠敘述關鍵字＋範例驗證，輸出 Python 要過隱藏測資。對應 held-out 的 ho-dag-paths、ho-bfs-dist、ho-cycle、ho-longest-dag、ho-reach-from1。
3. **L0 補強**（預期 +2～4，取決於範例）：2 筆範例會過度擬合；做「主動要更多範例」（讀取器生成輸入＋使用者卡片確認／補輸出，DESIGN §5），擴充算子（`==`、`and`、`or`、多輸出）。對應 ho-avg4、ho-range3、ho-clock、ho-leap。
4. **格子形狀＋恆等變換範本**（轉置／翻轉／旋轉；+1，ho-transpose）。
5. **宿主接線與真 Electron 評估**：`floating-assistant.js` 的 `_codeOffline` 走新後備鏈；`write_code` 結果要如實標示用了哪一層、是否只被範例驗證；**矩陣層回傳 `ambiguous` 或 `verified:false` 的結果不能當 verified 回給使用者**。`scripts/eval/offline-code.eval.js` 擴充；嵌入要改來源檔再 `node scripts/embed-code-ui.js && node build-assistant.js`（不要直接改 `floating-assistant.js` 的嵌入區塊）。Electron 評估指令：`FA_TS_DIR=/tmp/fa-ts-cache FA_EVAL_TIMEOUT_MS=900000 xvfb-run -a node scripts/eval/run_eval.js scripts/eval/offline-code.eval.js <空的埠>`（別用 17923；曾用 17971）。先確認 offline-code.eval.js 能跑再仿它寫 60 題版；自寫的 Electron 版基準曾卡 25 秒，原因沒查明。
6. 新增範本／形狀後，**另寫一批新的 held-out 題**再量，不能回頭用凍結的 48 題。
7. **矩陣 → UML／Blockly（支援 code edit）**：設計在 DESIGN §11，用 `matrix_decompile_core.js` 反編譯；實作排在矩陣層有進步之後。
8. **第三層介面**：Blockly＋矩陣層都解不出時「上網找答案、湊 CoLU、或等補教學」（DESIGN §10；`catalog_discover` 已實作探索端，介面實作待做）。優先對象：Linux 題中的 lx-lzma-literals、lx-inflate-fixed 這類依規格實作的題目。
9. 文件收尾：`DESIGN.TODO.md` 現況一列、`DESIGN.ast-nodes.md`、`STATUS.md`；`FA_TS_DIR=/tmp/fa-ts-cache node scripts/run-core-tests.js` 全過。

**領域矩陣化缺口（2026-11-07，DESIGN §12，附實測腳本 `scripts/eval/matrix_domains_exp/`）**——矩陣補齊的待辦清單，建議順序 G5 → G8＋L3 半環範本 → G3 → G1 → G4 → G6：G5 輸入形狀前端（邊表／格子／逐行／十六進位）；G8 修 `transitiveClosure`（只給 `A^(2^k)`，判環要 `A·((A∨I)^(2^k))` 的對角線）；G3 VM 整數運算元（`iarith` 只有 `+ - >>1`，缺 `* // % & | ^ <<`）；G1 Mealy 轉換器（有輸出的自動機；CRC 逐位元組、霍夫曼、varint、base64、RLE、管線）；G4 位元組／位元級 I/O；G6 由規格而非範例合成（CRC 多項式、tar／xz 格式、regex／glob→DFA）；G2 GF(2) 已有（`SR.count(2)`，缺範本）；G7 動態表、G9 Petri 網、G10 結點配置慣例與可讀反編譯。實測：CRC32 GF(2) 矩陣 500/500、LRU 置換矩陣 300/300、死結布林閉包 500/500（修正版）、固定霍夫曼位元 DFA 300/300；exec／系統呼叫等副作用不可矩陣化。

不屬於矩陣層、已交給 blockly-teach：held-out 27 題中的 17 題缺範式（清單在 DESIGN §9.7 A②，含兩題「配方／課 WA 擋住後備」與兩題讀取器沒讀出意圖）。

## 5. 環境與陷阱

- **帳號**：先前的 session 以 Linux 使用者 `automation` 執行，提交用 `ssh hungfu.lee@127.0.0.1`（因 repo 擁有者是 `hungfu.lee`、`git` 對他人帳號報 `dubious ownership`）。**你是另一位使用者（stevenyc.huang），不要假設 `ssh hungfu.lee` 可用**：用自己的 clone／帳號提交，或先請 hungfu.lee 協調；`docs/HANDOFF.md` 是 `stevenyc.huang` 擁有（你可寫，之前的 session 寫不進去）。
- **repo**：`tw_stock_db`，資料夾 `desktop-app`，分支 `desktop-app`；主分支 `main`。只 `git add` 自己改的檔案。
- **測試**：`FA_TS_DIR=/tmp/fa-ts-cache node scripts/run-core-tests.js`（tree-sitter 七組在沒有快取時算失敗；快取在 `/tmp/fa-ts-cache`，若不存在需重建／向 hungfu.lee 要）。基準：`FA_TS_DIR=/tmp/fa-ts-cache node scripts/eval/bench_coverage.js --mode A|B [--set heldout|--files x.jsonl] [--json out.json]`（Node 版；Electron 版 `bench-coverage.eval.js` 在本機卡住，勿用）。矩陣層單元測試：`node renderer/src/algo/matrix_synth.test.js`。
- **記憶體上限（2026-11-07 00:06 發生全域 OOM：某 python3 吃到約 78GB，126GB swap 用光，Claude 桌面版被重啟）**：所有 Python／評測／合成搜尋腳本一律加上限：`systemd-run --user --scope -p MemoryMax=16G -p MemorySwapMax=0 <指令>` 或 `ulimit -v 16000000`，並加 `timeout`；枚舉搜尋要有深度／候選數上限（現有：公式 300000、遞推 200000）。題庫產生器要防無限迴圈（曾因圖題要求的邊數超過可能邊數而空轉，已修）。
- **不可碰（別的 session／使用者的未提交檔）**：`features/FEATURES.md`、`skills/image-decompose-redraw/data/parts_builtin.json`、`DESIGN.edit-*.md`、`DESIGN.env-baseline.md`、`HANDOFF.edit-remote.md`、`skills/weak-model-harness/scripts/bridge/`、`72d21a0c-…` 資料夾、`renderer/src/uml/algo_intent_core.js`／`py_paradigms_core.js`（blockly-teach 正在改）、`test-reports/*`。
- 嵌入：`scripts/embed-code-ui.js` 會把 `renderer/src/` 模組整份蓋回 `floating-assistant.js`；改完要 embed＋build 並 grep 確認。
- 範式骨架走「程式區塊：」→`parseCNL`，**巢狀 `def` 會被丟掉**，骨架不能寫遞迴函式。
- 矩陣層過度擬合：範例少時（2 筆）會湊出範例對、隱藏測資錯的公式，沙盒會擋，要靠更多範例；回報 `ambiguous`／`verified:false` 要誠實。
- 用內嵌指令寫修補程式會吃掉反斜線與引號：寫成檔案再執行。`pkill -f`／`pgrep -f` 會比到自己：用 `ps -eo pid,args | grep "[x]yz"`。
- 版號單調遞增；**不使用埠 17923**；下載與安裝先取得同意。

## 6. 工作規則（原使用者的偏好）

- 回應用繁體中文或英文，**簡體字絕對不行**；講清楚在做什麼、給看得到的輸出；誠實區分「我驗證的／別人回報的／推測」；沒達標叫「待改善」，不要說成完成。
- **先讀專案現有的程式再動手**；每個語言各自一份、不跨語言共用；`write_code` 只有一個入口。
- 提交與發布：不要自行發布。每個階段完成後提交，回報協調 session（hungfu.lee 那邊的 FloatingAssistant）：提交 hash、基準解出數變化、改了哪些 renderer 檔、跑過哪些測試。發布由協調者驗證後做；只有使用者明說「提交並發布」才發布。
- 週額度（hungfu.lee 帳號的規則，供參考）：平時週額度到 88% 就停手寫交接；週五 19:00→週六 07:00（CST）可用光。你的額度請依你自己的規則。

## 7. 使用者原話（逐字，附日期）

- 2026-11-06：「blockly-writer -> matrix-algorithms　blockly-writer評估不出來, out of scope的用matrix-algorithm評估　我們的blockly+matrix-algorithm的範式，需要可以cover所有的可解問題，讓code-writer可以產生能解決使用者需求的程式」
- 2026-11-06：「上述是實現的順序的宣告，請依序完成」
- 2026-11-06：「blockly -> fallback matrix algorithms -> 這邊還沒效，就是要上網找答案，湊CoLU，或等我們補教學」；「uml-design+colu 無法切割的問題，會去找 sourceforge、github、codeproject 這些開源地方，變成 CoLU 後組裝」
- 2026-11-06：「我們有matrix的decompiler，可以從這變成matrix -> uml/blockly來支援code edit吧」
- 2026-11-06：「個別完成都要回來發布」（完成一個階段、提交後回報協調 session）
- 2026-11-07：「好」（同意對保留題庫未解題做分類報告）；「矩陣補齊我想要交給其他session，例如stevenyc.huang」（矩陣層後續交給另一位使用者的 session；Blockly 教學範本由 blockly-teach 擴充）
- 寫程式流程（`DESIGN.ast-nodes.md` 第六、七節）：UML 任務切割 → 程式骨架生成 → Block 產生迴圈（程式端算 Inventory → 過濾合法區塊 → 嚴格 Template）→ 模型僅在合法 Inventory 內做微型選擇 → 沙盒驗證 ⇄ 錯誤回饋。

## 宿主接線的分工與步驟（2026-11-07，協調 session 補）

現況：`FaMatrixSynth` 還沒接到前端。`floating-assistant.js`、`web-lazy/core.js` 裡都沒有它；`py_uml_pipeline_core.js` 的 `buildFromUML` 只有一個要由呼叫端傳入的 `o.Matrix` 參數，沒人傳，所以 v312／v313 帶著矩陣層程式，但使用者端沒有作用。

接線步驟：
1. 把 `renderer/src/algo/matrix_synth_core.js` 加進 `scripts/embed-code-ui.js`（內嵌區塊清單）、`build-assistant.js`、web-lazy 區塊清單（`web-lazy/manifest.json`，`node scripts/web-lazy-check.js` 要通過）。
2. `floating-assistant.js` 的 `_codeOffline`：呼叫 `buildFromUML` 時傳 `Matrix: FaMatrixSynth` 和題目的 tests 當 `examples`；`write_code` 結果要標示用了哪一層（配方／課／Blockly 範式／矩陣層），只被範例驗證或 `ambiguous` 的標 `verified:false`，不能當成已驗證回給使用者。
3. 真 Electron 評估：`FA_TS_DIR=/tmp/fa-ts-cache xvfb-run -a node scripts/eval/run_eval.js scripts/eval/offline-code.eval.js <空的port>`，20 題種子必須維持 20/20；再用保留題庫跑模式 A／B 看實際增益。
4. 核心測試 `FA_TS_DIR=/tmp/fa-ts-cache node scripts/run-core-tests.js` 全過（不要用 `ulimit -v`，WASM 測試會因此失敗）。

跟 blockly-teach 的分工（同一個 checkout、同一批共用檔，最容易互踩）：
- 你只改接線那幾行（`embed-code-ui.js` 清單、`_codeOffline`、`code_agent_core.js` 的傳參）與 `renderer/src/algo/*`；不要碰 `algo_intent_core.js`、`py_paradigms_core.js`、`py_uml_pipeline_core.js`、`py_blocks_*`（blockly-teach 在改）。
- embed／build 會改寫 `renderer/floating-assistant*.js`、`web-lazy/`，整個檔案都會變：build 前先確認 `git status` 沒有別人未提交的 `renderer/src` 變更；build 與提交盡量連續做完，不要讓半途的 build 產物留在工作樹。
- 發布（`scripts/publish.sh`）由協調 session（hungfu.lee 帳號）統一做，因為它會 `git add -A renderer scripts web-lazy`，把工作樹裡所有未提交的東西一起發出去（v313 就因此誤發了別人做到一半的改動）。你提交完通知協調 session，等它發。
- 若你用的是 stevenyc.huang 帳號，沒有 `ssh hungfu.lee`：提交用你自己的帳號在同一個倉庫提交（需要該目錄的寫入權限與 git `safe.directory` 設定）；做不到就把變更留在工作樹並通知協調 session 代為提交。

## 程式優化（2026-11-08，v332，非矩陣層但同一批工作）
見 `DESIGN.code-optimize.md`：`optimize_code` 工具、9 條慢寫法→優化寫法對照表、輸出一致才收＋量時間。下一步：接題型家族（暴力→雜湊範式）、記憶體量測、更多規則。

## 組合層（design pattern：把未知題拆成已知積木的組合，2026-11-08，v335）
`renderer/src/algo/matrix_compose_core.js`（宿主 `MATRIXCOMPOSE-BEGIN/END`，install 需要 FaMatrixGraph）：**輸入積木 → 向量積木 → 過濾 → 歸約積木 → 輸出**（Pipeline＋Strategy）。向量：BFS 距離、加權最短距離、度數／出度／入度、分量大小（每點／每分量）、列和／欄和、列／欄最大最小、某字元的列／欄個數；歸約：最大、最小、總和、個數、不同個數、奇／偶／正／零／走不到的個數、最大／最小者的編號、由大到小／小到大排序、依序全列、全部偶／奇／相同、有沒有；過濾：全部／只看 ≥0／只看 >0。用範例驗證，命中多個時回 alternatives 讓 judge 依序試。輸出程式分段加註解（向量段／過濾／歸約），好編輯，也走 matrix_edit 的可編輯整理。
**數字（誠實版）**：新批 `heldout6_compose.jsonl`（`gen_heldout6.py`，12 題，全是「已知向量 × 已知歸約」的新組合）基線 **0/12**（graph／grid 範本都不認）→ **12/12 合成成功、verified 9**（3 題 2 個範例下有多個候選標 ambiguous）。⚠ 這批題是我寫完設計方向後才寫的，積木詞彙是照那個方向選的，所以 12/12 量到的是「組合機制有效」，不是對任意未知題的泛化；heldout4 的「奇度數個數」因此從失敗變 verified（14→15）；`h4-symmetric`（沒有對的積木）組合層湊出碰巧過隱藏測資的 row-sum→all-odd，如實標 ambiguous／不 verified。
限制：要新增的是積木，不是整題範本——新題型要先看缺的是向量、過濾還是歸約。下一步：輸入積木（邊表／格子／清單／逐行）與輸出積木也拆成可插拔，讓同一個向量／歸約套到更多輸入形狀（清單、字串、矩陣）。
