# 交接：Blockly 補教學（blockly-teach）——補範式／讀取器／積木，缺口都要補好

## 1. 開場提示（接手者收到的原文）

請接續 `desktop-app/HANDOFF.blockly-teach.md`：完整讀完（含使用者原話與工作方式），照著做，並執行 low-context-long-run 技能（門檻 30%）：做下一個待辦，到門檻就寫下一份交接、啟動接手者。第一則訊息請用一行確認你讀了文件、從哪個待辦開始。使用者原話（2026-11-06）：「請務必缺口都要補好」；「個別完成都要回來發布」（＝完成一階段、提交且測試＋真 Electron 驗證通過後，SendMessage 回報協調 session `local_aa2d0534-d9c3-41a6-8c95-9c3591567ef0`，由它驗證並發布；你自己不要發布）。

## 2. 概況

- repo `tw_stock_db`，資料夾 `/home/hungfu.lee/下載/SRC/tw_stock_db/desktop-app`，分支 `desktop-app`。提交用 `ssh hungfu.lee@127.0.0.1 'cd /home/hungfu.lee/下載/SRC/tw_stock_db/desktop-app && git add <只加自己的檔案> && git commit -m …'`，訊息結尾 `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`。**絕對不要發布**（除非使用者說「提交並發布」）。
- **階段 1 已完成並已交協調 session（提交 `49f2547f`）**：原 60 題基準 Blockly 2/60→58/60（題庫 b-lucas-mod 參考解錯已被 matrix-fallback-1 修，現 A 59/60）；31 題自寫 holdout 首輪 21/31、補後 28/31；核心測試 206/206；真 Electron 20 題種子 noLessons／withLessons 皆 20/20。改了 `renderer/src/uml/algo_intent_core.js`（新句型、`intent.facts`、39 個算法關鍵字、`extractFacts`）與 `renderer/src/uml/py_paradigms_core.js`（`GEN` 區塊 42 個新骨架，`py(c, N, intent)` 第三參數，缺參數 `throw`）。文件 `DESIGN.blockly-gap.md`（單數，我寫的）。**原 60 題已被我教過，只能當回歸，不再代表泛化。**
- **階段 2（現在要做）**：`DESIGN.blockly-gaps.md`（複數，blockly-gap-linux 寫，提交 f4c4a53e、e60e7e36）§4 的 G1～G18 缺口，題庫 `renderer/src/recipe/seed/bench_linux_all.jsonl`（64 題，欄位 `split`：train 37／holdout 27，`tool`；現有流程 0/64）。**`split: holdout` 的 27 題絕對不准拿去教課／範式，只量測**；只能用 train 37 題與自己另寫的新題教。Linux holdout 現在是唯一乾淨的泛化量尺；每一批都要報 train／holdout 各解出幾題。
- 使用者原話指示：全部「補 Blockly」的缺口（G1–G13、G17、G18 的讀取器分流部分，P0 到最後一項）都補完，不能留尾巴；標「超出 Blockly」（G14 LZMA 完整流程、G15 判題器二進位 IO／檔案／argv、G16 真行程、G18 的模型／老師部分）整理成清單回報協調 session，由它轉給矩陣層／上網／待補教學負責人。照該文件 §5 順序逐項補，每補完一項就在 `DESIGN.blockly-gaps.md` 該列標「已補」＋提交 hash。全部補完後用真實 Electron 跑 64 題與 20 題種子回歸再回報。
- 另一個待辦（協調 session 轉述，使用者原話：「blockly-teach看那條uml thinking stack/CoLU thinking有少」）：檢查「UML 思考堆疊／CoLU 思考」在 Blockly 寫程式流程裡缺了什麼：讀 `DESIGN.think-stack.md`（FaThinkStack、stackChecks、兄弟一致性、chooseTool 堆疊框）、`DESIGN.colu.md`、`uml_bench_core.js` 的 `siblingConsistency`；對照 `py_uml_pipeline_core.js`／`code_agent_core.js` 的離線路徑（`buildFromUML`、區塊迴圈、`_codeOffline`）哪些階段沒有 push／pop 思考堆疊框、沒有一致性檢查、沒有 CoLU 規劃路由，或失敗時沒有把「卡在哪一層」寫回堆疊。缺口列進 DESIGN 小節（缺什麼／影響哪些階段／建議補法），小項直接補並加測試，大項列清單回報。順序：G1–G3 優先，這項排在其後。
- 其他 session 的未提交檔不要碰：`features/FEATURES.md`、`skills/image-decompose-redraw/data/parts_builtin.json`、`DESIGN.edit-*.md`、`DESIGN.env-baseline.md`、`HANDOFF.edit-remote.md`、`skills/weak-model-harness/scripts/bridge/`、`72d21a0c-*`、`test-reports/`。邊界：不要改 `renderer/src/algo/matrix_synth*`、`scripts/eval/bench_coverage.js` 判題標準；改 `py_uml_pipeline_core.js` 前先 SendMessage matrix-fallback-1（`local_7d2ae051-803a-4458-b30c-8ff383841902`）確認沒在改，改動要最小。

## 3. 待辦（依序）

1. **G17＋G1 最小版**（讀取器否決條件＋輸入形狀）：新增形狀 `lines(n)`（第一行 n、接著 n 行文字）、`hexbytes`（單行十六進位）、`flagline`（旗標行）、`sections`（多段，如兩個檔案）、`pat` 字串行；`huffman-cost→list-sum`、`xz-delta→kth-largest` 兩個假陽性要有否決條件（輸入形狀不符就不給骨架；輸出動詞不符；範式要的關鍵詞缺席不選），並加「近鄰負例」測試。`readInputCNL`／`namesOf` 在 `py_uml_pipeline_core.js`／`py_paradigms_core.js`，要支援新形狀。量測：`FA_TS_DIR=/tmp/fa-ts-cache node scripts/eval/bench_coverage.js --files bench_linux_all.jsonl --mode A --json out.json`（`--files`／`--set` 是 matrix-fallback-1 加的；輸出要自己依 `split` 分 train／holdout，可寫小腳本讀 json 與 jsonl 的 id 對照）。
2. **G3 積木**（`py_blocks_lib_core` 的 `EXPR_EXTRA`：`& | ^ << >>`、`ord/chr`、`int(x,16)`、`%02x/%08x/%6d`、`hex/bin`、`startswith/find/replace/isdigit/ljust/zfill`、`try`）；一個積木一個 Python 運算式、CNL 為中文，往返測試沿用 `py_blocks.test.js`。
3. **G5 行過濾器範式**（`lines.map`／`lines.filter`：槽位＝忽略大小寫、取反、行號前綴、只計數、整字、壓縮空行、replace 規則；窮舉 ≤16；旗標行靠 G1）。原則同階段 1：骨架在 `GEN` 區塊或新檔，參數由 `facts` 從敘述抽，缺參數 throw。
4. **G9→G7→G4**：`align.up`（先配方）、`checksum.crc32`／`mod-sum`、`binfmt.field-table`（讀＋寫對偶，不用 `def`）。
5. **G2 切割模板**（`codec`／`pipeline`／`state-machine`＋輔助操作；`mkModel` 目前寫死三個 op，在 `py_uml_pipeline_core.js`，先問 matrix-fallback-1），之後 G6(b)（無 def 改寫：調度場＋RPN 取代遞迴下降）、G8、G10–G13。
6. 全部補完：真 Electron（`xvfb-run -a node scripts/eval/run_eval.js scripts/eval/offline-code.eval.js 17931`，埠不可用 17923）跑 20 題種子；64 題 Linux 在真 Electron 的跑法要查（`scripts/eval/bench-coverage.eval.js` 在本機會卡住，勿用；改用 Node 版＋種子 Electron 回歸）；整理「超出 Blockly」清單回報。
7. 思考堆疊／CoLU 缺口檢查（見 §2）。

每階段完成（提交、核心測試 `FA_TS_DIR=/tmp/fa-ts-cache node scripts/run-core-tests.js` 全過、`node scripts/embed-code-ui.js && node build-assistant.js`、真 Electron 20 題）就 SendMessage 回報協調 session：提交 hash、基準解出／總數變化（train／holdout 分開）、改了哪些 renderer 檔、跑過哪些測試。build 產物（`floating-assistant*.js`、`web-lazy/`、`update-manifest.json`）不要自己提交，發布時會重建。

## 4. 工作方式（使用者規則，原樣照辦）

- 語言：繁體中文（或英文），**簡體字絕對不行**；講清楚在做什麼、給看得到的輸出；誠實區分「我驗證的／別人回報的／推測」；沒達標叫「待改善」；不宣稱「涵蓋所有問題」。
- **先讀專案現有程式再動手**（使用者多次因沒讀而生氣）；規則是**泛化**：不可把題目答案硬編進程式；骨架要窮舉槽位交沙盒，不靠排在前面；參數由敘述抽，抽不到就不渲染。
- 不要改 `floating-assistant.js` 內嵌區塊（改來源檔再 embed＋build）；`pkill -f`／`pgrep -f` 會比對到自己的 bash 指令，**不要用**（曾因此把自己的 shell 殺掉）：用 `ps -eo pid,args | grep "[x]yz"`；等待背景工作用 Monitor 或直接檢查檔案，不要寫含 `pgrep -f` 的 until 迴圈。
- 週額度：平時週額度 88% 就停手、寫交接、不起接手者；**週五 19:00～週六 07:00（CST）可用光**（2026-11-07 07:00 CST 重置，之後回到 88% 規則）。用 `date` 與 `mcp__ccd_session_mgmt__get_usage` 判斷。context 門檻 30%（一個完成的工作單位後檢查）。
- 不使用埠 17923；有多少 release 多少；版號單調遞增；提交發布一律走 `ssh hungfu.lee@127.0.0.1`；只有使用者說「提交並發布」才發布。

## 5. 使用者原話（逐字，附日期）

- 2026-11-06：「請將未知題目的blockly補上」
- 2026-11-06：「個別完成都要回來發布」
- 2026-11-06：「請務必缺口都要補好」
- 2026-11-06：「剛剛linux工具的部份，看來有東西要補」
- 2026-11-06：「blockly-teach看那條uml thinking stack/CoLU thinking有少」
- 2026-11-06（Linux 題庫起因，blockly-gap-linux 轉述）：「下一個教學試題，claude先把linux的util如tar, gz, xz, xxd, grep, cat, eval, exec, 實現bmp reader/writer 整個都拆解，全部給予blockly教學，看哪邊有未知的。以及uml到切割問題，到 blockly，哪裡有題形、演算法沒跟上的」
- 寫程式流程（`DESIGN.ast-nodes.md` 第六、七節）：UML 任務切割 → 程式骨架生成（Boilerplate）→ Block 產生迴圈〔① Inventory ② 過濾合法區塊 ③ 嚴格 Template〕→ 模型僅在合法 Inventory 內做微型選擇 → 沙盒編譯驗證 ⇄ 錯誤回饋。
- 週額度規則：「這個週額度可以用光的規則僅用於禮拜五晚上7點後」；「平時禮拜六七點後，到隔週的禮拜五晚上七點前，不能這樣做」

## 6. 交接程序（自我遞迴）

執行 low-context-long-run 技能，門檻 30%；到門檻：改寫本檔（保留逐字使用者原話）→ 提交（只加自己的檔案）→ `mcp__ccd_session__start_session`（`user_asked`、`fresh`、同資料夾、標題「blockly-teach · handoff N」）→ 等接手者確認 → `mark_completed` 再 `archive_session`（被拒就停、告訴使用者）。待辦清空且驗證完就不要再交接，直接報告完成。

## 7. 陷阱

- `py_paradigms_core.js` 的 `render` 會把「與題目變數同名的局部變數」改成 `名稱_2`；骨架裡 `c.<槽位>` 是選項的 **v**（值），不是 id——曾因為拿 id 比較（`c.kind === 'stack'`）而失敗兩次；選項值若是 `'0'`／`'- 1'` 要連同運算子寫在 v 裡（曾寫成 `e = n 0`）。
- 骨架不能含 `def`（巢狀 def 會被 CNL 路徑丟掉）、不用 `a = b = 0`；字串常數裡的名稱不會被改名。
- 大 n 的題要 `when` 排除逐項骨架（`rec.iterate` 對 n=10^18 會讓沙盒空等 27 秒）。
- `bench_coverage.js` 已被 matrix-fallback-1 改成只讀 `bench_(L|extra)`／`--files`／`--set`；`bench_linux_all.jsonl` 要用 `--files` 指定。
- 我另寫的 holdout（`holdout_blockly.jsonl`）已被看過，不再乾淨；Linux holdout 27 題不可教。
- 內嵌指令寫修補程式會吃掉反斜線與引號：寫成檔案再跑。
- **記憶體上限（2026-11-07 全域 OOM：某個 python3 吃到約 78GB 把 swap 用光、桌面版被重啟，swap 已縮成 4GB）**：所有 Python／評測腳本一律加上限：`systemd-run --user --scope -p MemoryMax=16G -p MemorySwapMax=0 <指令>`（或 `ulimit -v 16000000`）。出題器（如 `gen_holdout_blockly.py`）的 `while len(ins) < …` 在輸入空間太小時會無限重試，新寫生成器要設重試上限。
