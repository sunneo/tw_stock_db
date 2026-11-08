# 待辦交接（2026-11-08 週日 02:00，stevenyc.huang 的 session 留下）

給接手的 session。先讀這份，再看相關的 DESIGN／HANDOFF。已發布到 patch **v335**；核心測試 221/221（`FA_TS_DIR=/tmp/fa-ts-cache node scripts/run-core-tests.js`）。使用者原定：週日 07:00 CST 停、週五 19:00 CST 續；每次推進都要發布。

## 0. 工作規則（使用者講過的，必守）
- 回覆只用**繁體中文或英文**，不能有簡體字。
- 誠實回報：verified／reported／guess 分清楚；題庫被「吃掉」後不能再當泛化數字；holdout 不教，教了就改記成 train，另寫新 holdout。
- 先讀現有程式再改；不碰別的 session 的檔案；選擇性 `git add`，不要 `-A`。
- **發布**：`ssh automation@127.0.0.1` → 內層 `ssh hungfu.lee@127.0.0.1` → `cd /home/hungfu.lee/Downloads/SRC/tw_stock_db/desktop-app`，commit 後 `PUBLISH_TRAILER="Co-Authored-By: …" scripts/publish.sh -m "…" --no-web`（**不要 `--skip-build`**：bundle 檔屬 hungfu.lee，我的帳號寫不進去）。commit 訊息結尾加 Co-Authored-By 行。
- 宿主改動流程：改來源 → `node scripts/embed-code-ui.js` → `node --check renderer/src/floating-assistant.js` → 核心測試 → commit＋發布 → 真 Electron 驗證（見 §6）。
- 使用者提醒過的：**decompile／反編譯是為了 code edit，不是評估用**（已接進產品，見 §2）。

## 1. 已完成（近兩天，供對照，不要重做）
- Blockly 領域包：graph2（v321）、twofile（v322）、fs（v323）、linuxsem（v324）、linuxfmt（v329）；讀取器通用放寬（n-1 區段、兩段輸入改寫、「第三行 s 是…」、`整數 fat` 命名）。
- 矩陣層：graph／grid 模組（v325）、sqmat＋更多範本（v326）、L0 predicate／multi／real＋synth alternatives（v327）、suggest 資料面（v328）、G8 判環修正、**可編輯整理 matrix_edit（v331）**、**組合層 matrix_compose（v335）**。
- 程式優化 `optimize_code`（v332–v334，13 條規則，見 `DESIGN.code-optimize.md`）。
- 思考堆疊缺口 D（v330）。
- 各批新題庫：heldout2–6（`renderer/src/recipe/seed/heldout{2,3,4,5,6}_*.jsonl`，生成器 `scripts/eval/gen_heldout{2..6}.py`）。**heldout2、3 已被範本吃掉（只當回歸）；heldout4／5／6 是目前的量測用，但每補一批範本就要再寫下一批（第七批起）。**

## 2. 待辦清單（依建議優先序）

### A. 組合層下一步（使用者最近指定的方向：design pattern 把未知題拆成已知積木）
1. **輸入積木／輸出積木也拆成可插拔**：目前向量積木只吃「邊表」與「格子」。要讓同一組向量×歸約套到清單（n＋一行整數）、字串、方陣、逐行文字。檔：`renderer/src/algo/matrix_compose_core.js`（`synthGraphCompose`／`synthGridCompose` 各自內嵌輸入解析，抽成輸入積木註冊表）。
2. **補積木而不是補整題範本**：先看缺的是向量、過濾還是歸約。候選積木：BFS 層數、拓撲位置、連通分量編號、最短路徑樹的父節點；歸約：第二大、中位數、眾數、前綴最大、相鄰差；過濾：偶數位置／某字元。
3. 把現有整題範本（`matrix_graph_core.js` 的 GT、`GR`）逐步改成「向量×歸約」表達，減少重複。
4. 組合結果走 `matrix_edit` 的可編輯整理（目前只有 dfa／recurrence 有專屬整理；compose 的輸出已分段加註解，但 `extractForm`／`applyForm` 沒支援 compose，要加：讓使用者改歸約或過濾後直接換程式段）。
5. **寫第七批 held-out**（`gen_heldout7.py`）：新組合＋新輸入形狀（清單、字串），先量基線再補積木。

### B. 程式優化 `optimize_code`（`DESIGN.code-optimize.md` 末節）
1. **接題型家族**：`pair-sum-count` 是第一個「認題型→換快範式」的規則。「找第一組配對」要保持 (最小 i, 最小 j) 的輸出順序（用 value→遞增索引串列＋bisect），還沒做。
2. 更多規則：迴圈不變量提到迴圈外、`range(len(a))` 取元素→enumerate、二維 DP 滾動陣列、`in list(...)`／`list.index` 迴圈、字串切片迴圈、遞迴改迭代（深度風險）。
3. **宿主端記憶體量測**：判題器 IPC（`main.js` `fa:judge:run`）目前只回 maxMs，沒有峰值記憶體；測試端執行器有量。要在 judge-runner 回 `maxRssKB`（`resource.getrusage`）再串到 `_codeOptimize`。
4. 非 Python 語言。
5. 從「程式→題型」的反向配對：用 `py_code2uml` 的結構配對骨架家族（偵測到雙層迴圈找配對→暴力 pair-sum 家族→換雜湊範式），目前只有各規則自己的正規式偵測。

### C. 矩陣 → code edit（`DESIGN.matrix-fallback.md` §11.5b）
1. **狀態機 UML 圖種**：`uml_core` 能否表達狀態機待查（DFA 的轉移表可編輯版已有，但沒有 UML 狀態圖）。
2. VM／ReLU 決策樹的 `blocks` 直接產生（路 B，目前只有 Python→UML 的路 A）。
3. graph／grid／compose 範本的形態編輯（`extractForm`／`applyForm` 目前只有 dfa、recurrence）。
4. 往返測試補強：矩陣→區塊→矩陣在隨機輸入上輸出相同（目前測的是程式輸出相同，不是矩陣重建）。

### D. 「主動要更多範例」（矩陣層 ambiguous 的根本解）
資料面已通：predicate 回 `suggest`（候選答案不一致的輸入），經 pipeline／宿主 `_codeOffline`／`code_agent` 報告文字帶出。**沒做**：
1. 卡片 UI（讓使用者／模型補那幾筆輸入的正確輸出）。
2. 補完輸出後「用新範例重跑 synth」的流程（synth 本來就吃更多範例，只缺前端互動與 `suggest` 對 compose／formula／graph 模組的支援——目前只有 predicate 回 suggest）。
3. 讓題目自己生成輸入（讀取器生成合法輸入、使用者確認輸出）。

### E. 思考堆疊（`DESIGN.think-stack.md` 離線缺口表）
- **C** 離線思考框（`buildFromUML` 每層 push／pop）：大，要先設計「層」對應哪種框與寫回格式。
- **E** 離線 stackChecks（只對 `writeBlocks` 外層加一次 `selfValidate`）：看 C。
- **F** 兄弟一致性：離線輸出來自固定範本，風格本來一致，價值低，我判斷不用做。
- **D** 的框化版本（`Stack.decide` 前置「已試」）等 C；目前版本是把已試各層摘要附在給模型的敘述尾端（v330）。
- **I** `scripts/eval/stack_consistency.js` 加離線變體。

### F. 第三層介面（Blockly＋矩陣層都解不出時）
上網找答案／湊 CoLU／等補教學（`DESIGN.matrix-fallback.md` §10；`catalog_discover` 探索端已實作，介面端沒做）。優先對象：Linux 的 `lx-xz-header`、`lx-bmp-write8`（規格太具體，不適合再做整題範本）、`lx-lzma-literals`、`lx-inflate-fixed`。需要先和使用者確認互動方式。

### G. Blockly 領域包剩餘
- linuxfmt：`${名稱:-預設}` 預設值語法未解（holdout 誠實失敗）。
- fs：目錄解析、路徑正規化、區塊配置策略（first-fit／best-fit）。
- linuxsem：socket 全套、行程樹 fork／wait／exec、信號處理常式巢狀。
- graph2：Floyd、二分圖匹配（Hungarian／Hopcroft-Karp）。
- 其他（`DESIGN.blockly-curriculum.md` 還是 ✗ 的列）。
- **每個新包都要另寫 holdout**，並在 `scripts/e2e/matrix_graph.e2e.mjs` 加一條宿主接線驗證。

### H. 文件收尾
`DESIGN.TODO.md` 現況一列、`DESIGN.ast-nodes.md`、`STATUS.md`、`docs/HANDOFF.md`（一頁起點頁，尚未加入本批的組合層／程式優化）。

## 3. 已知風險與誠實限制（接手要知道）
- **ambiguous 候選可能是錯的但碰巧過隱藏測資**（例：h4-symmetric 組合層湊出 row-sum→all-odd）。系統標 ambiguous／不 verified，但程式本身是錯的——**不要把 ambiguous 當成功回報給使用者**；`code_agent` 報告已寫「只過範例，沒有獨立驗證」。
- `bench_coverage.js` 只量核心範式，**不載入領域包**；領域包數字以各自 `*.test.js` 為準，宿主有沒有接上以 e2e 為準。
- 凍結的 `heldout_all.jsonl` 模式 B：21→30/48，但範本家族是看過它的失敗類型選的，**不是乾淨泛化**。
- `str-join` 這類 CPython 已優化的規則，優化器實測記憶體變大會退回（不硬換）。
- 讀取器是共用檔 `algo_intent_core.js`，改了要跑：原 60 題（`bench_coverage.js --mode A` 要 59/60）、`--files holdout_blockly.jsonl`（28/31）、`--files bench_linux_all.jsonl`（59/64）、核心測試。

## 4. 新增領域包的註冊點（五處）
1. `renderer/src/uml/domain_<x>_core.js`（`make(PAR)`→`{id,label,requires,judge,algos(pri:true),paradigms,skeletons}`）＋ `domain_<x>.test.js`（train＋holdout，harness 見 `domain_harness.js`）。
2. 宿主 `renderer/src/floating-assistant.js`：加 `/* DOMAINxx-BEGIN */ const FaDomainXx = null; /* DOMAINxx-END */` 空殼（放在上一個領域包的 END 後），並把 `FaDomainXx` 加進 `_pyDomainsInit` 的清單。
3. `scripts/embed-code-ui.js` 的清單加 `['…_core.js', 'DOMAINxx-BEGIN', 'DOMAINxx-END', 'FaDomainXx']`。
4. `scripts/run-core-tests.js` 加測試列。
5. 文件：`DESIGN.blockly-curriculum.md`、`HANDOFF.blockly-teach.md`。
- 骨架陷阱：`c.<slot>` 是**選項的值**不是 id；骨架不能含 `def`；JS 字串 `.replace('x', y)` 只換第一個，要用 `split().join()`。
- 矩陣層新模組：`FaMatrixSynth.register(name, fn, {order})`，宿主用 `MATRIXxx-BEGIN/END` 空殼＋install 行（見 `MATRIXGRAPH`、`MATRIXL0`、`MATRIXEDIT`、`MATRIXCOMPOSE`）。模組可回 `alternatives`（judge 退掉第一個時依序試）、`suggest`。

## 5. 量測指令
- 矩陣層：`node scripts/eval/matrix_bench.js heldout6_compose.jsonl`（也可 heldout2…5；`--ex N` 範例數）；回歸下限寫在 `renderer/src/algo/matrix_graph.test.js`（heldout2 22／3 21／4 15／5 4 verified／6 12 成功 9 verified）。
- 模式 B：`node scripts/eval/bench_coverage.js --mode B [--files heldout_all.jsonl]`（原 60 題要 60/60）。
- 程式優化：`node renderer/src/recipe/code_optimize.test.js`。
- 可編輯整理：`node renderer/src/algo/matrix_edit.test.js`（需 tree-sitter 快取）。

## 6. 真 Electron 驗證
- `scripts/e2e/matrix_graph.e2e.mjs`（graph／graph2／fs／linuxsem／linuxfmt／twofile／L0／可編輯 DFA 共 8 條路徑，期望全 verified、頁面錯誤 0）、`scripts/e2e/code_optimize.e2e.mjs`（optimize_code）。
- 跑法：`mkdir -p node_modules`，把全域 playwright-core 連進去（見 skill `publish-live-update-patch` 的測試 recipe），`FA_USERDATA=<空目錄> xvfb-run -a node scripts/e2e/<檔>.mjs`；userData 要有 `desktop-settings.json` = `{"execEnabled":true,"execConfirmRequired":false}`（少了後者判題會卡確認視窗而 app 退出）。
- 種子 20 題：`node scripts/embed-code-ui.js && node build-assistant.js`（用有寫入權限的帳號），再 `xvfb-run -a node scripts/eval/run_eval.js scripts/eval/offline-code.eval.js <空埠>`，noLessons／withLessons 皆 20/20（埠不可用 17923）。

## 7. 相關檔案索引
`HANDOFF.blockly-teach.md`（領域包）、`HANDOFF.matrix-fallback.md`（矩陣層，含各批數字）、`DESIGN.matrix-fallback.md`（§11 code edit、§12 領域矩陣化缺口）、`DESIGN.code-optimize.md`、`DESIGN.think-stack.md`、`DESIGN.blockly-curriculum.md`、memory：`project_blockly_matrix_progress_1107.md`。
