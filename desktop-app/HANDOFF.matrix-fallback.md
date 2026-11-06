# 交接：Blockly writer ＋ 矩陣演算法 要能涵蓋所有「可解」問題（矩陣層當 Blockly writer 的後備）

## 1. 開場提示（接手者收到的原文）

請接續 `desktop-app/HANDOFF.matrix-fallback.md`：完整讀完（含使用者原話與工作方式），照著做，並執行 low-context-long-run 技能（門檻 30%；**週額度到 88% 就停手交接，不要硬做**）：做下一個待辦，到門檻就寫下一份交接、啟動接手者。第一則訊息請用一行確認你讀了文件、從哪個待辦開始。
使用者原話（2026-11-06）：「blockly-writer -> matrix-algorithms　blockly-writer評估不出來, out of scope的用matrix-algorithm評估　我們的blockly+matrix-algorithm的範式，需要可以cover所有的可解問題，讓code-writer可以產生能解決使用者需求的程式」。使用者接著補充：「上述是實現的順序的宣告，請依序完成」。（使用者說「blockly-writer」，不是「block-writer」；文件與檔名舊的還叫 block-writer，先不改名。）

## 2. 概況

- repo `tw_stock_db`，資料夾 `/home/hungfu.lee/下載/SRC/tw_stock_db/desktop-app`，分支 `desktop-app`。Linux、使用者 `automation`；提交與發布走 `ssh hungfu.lee@127.0.0.1`（`docs/HANDOFF.md` §3；`docs/HANDOFF.md` 是 `stevenyc.huang` 擁有，寫不進去，進度寫 `STATUS.md` 與本檔）。
- **已發布 patch v311**（遠端 `manifest.v2` 311，已核對；`desktop-app` HEAD `6bd56987`）。v311 已含：範式骨架庫（27 個範式）、`write_code` 離線組合（`runCode` 的 `offline` 掛鉤、`_codeOffline`）、DSP 領域包、矩陣評估與原型（`renderer/src/algo/`）、判題單筆上限 256KB。核心測試 205/205（要 `FA_TS_DIR=/tmp/fa-ts-cache`）。
- 工作樹裡別的工作階段的未提交檔案**不要碰**：`features/FEATURES.md`、`skills/image-decompose-redraw/data/parts_builtin.json`、`DESIGN.edit-*.md`、`DESIGN.env-baseline.md`、`HANDOFF.edit-remote.md`、`skills/weak-model-harness/scripts/bridge/`、`72d21a0c-…` 資料夾。
- 現有零件（先讀再動手）：
  - Blockly writer（Python）：`renderer/src/uml/` 的 `algo_intent_core.js`（讀取器、`ALGOS`、`PARADIGMS`）、`py_uml_pipeline_core.js`（`buildFromUML`：配方→課→範式骨架→區塊迴圈）、`py_paradigms_core.js`（27 個範式骨架，窮舉組合交沙盒）、`py_blocks_*_core.js`（區塊庫、規則、庫存、受控自然語言 CNL）、`py_lessons_core.js`＋`py_lessons_builtin.js`、`domain_registry_core.js`＋`domain_dsp_core.js`（領域包，見 `DESIGN.block-domains.md`）。
  - 矩陣演算法（`DESIGN.matrix-algorithms.md` 全文必讀，15 節）：`renderer/src/algo/` 的 `matrix_forms_core.js`（DFA／min-plus／布林閉包／遞推／LR 表／CYK 的矩陣形式；Berlekamp–Massey、Hankel 學習）、`matrix_machine_core.js`（多個小矩陣＋控制狀態機）、`matrix_vm_core.js`（矩陣 VM，加記憶體：堆疊／佇列／陣列，見 `matrix_memory.test.js`）、`relu_core.js`／`relu_compile_core.js`（ReLU 網路⇄決策樹）、`matrix_decompile_core.js`（矩陣／VM 反編譯成遞推式、狀態圖、正規表示式、if 鏈、CNL）。
  - 宿主與沙盒：`renderer/src/recipe/code_agent_core.js`（`runCode`、`offline` 掛鉤）、`floating-assistant.js` 的 `_codeOffline`、判題器 `judge-core.js`／`judge-runner.js`（IPC 在 `main-ext.js`，單筆 256KB）。

## 3. 使用者的要求（拆解，要先確認理解再做）

1. **後備鏈**：Blockly writer「評估不出來」（讀取器讀不出／沒有配方、課、範式骨架能解／沙盒驗證全部沒過＝out of scope）時，改用矩陣演算法評估（矩陣層），不是直接放棄或丟給模型。
2. **涵蓋所有可解問題**：Blockly ＋ 矩陣的範式要能 cover 所有「可解」問題，讓 code-writer 能產生解決使用者需求的程式。要把「涵蓋」講清楚並量化（見待辦 1）。
3. 產出仍是程式：矩陣層的結果要反編譯成程式（CNL→Python），過沙盒驗證，才算解出。

## 4. 待辦（依序）

1. **【已完成並提交】`DESIGN.matrix-fallback.md` 已寫（分級 L0～L6、涵蓋表、後備鏈接口、無測資方案、風險、實作契約）。以下為原要求：**`DESIGN.matrix-fallback.md`（繁體中文，誠實分「證明過的／實驗驗證的／推測」）。要回答：
   - **「所有可解問題」的定義與界線**：可計算＝圖靈機可解；停機問題等不可判定的、以及「沒有規格／範例就不知道要什麼」的需求都不可能保證涵蓋。用 `DESIGN.matrix-algorithms.md` 第 13 節的階層（控制 FSM＋矩陣 ＜ ＋計數器 ＜ ＋堆疊 ＜ ＋佇列／陣列／帶子＝圖靈完備）把題目分級，每一級對應一個矩陣層的元件與一個「保證會停」的求解策略；寫出涵蓋表（等級×元件×求解方式×是否保證會停×是否需要範例）。
   - **後備鏈與接口**：`buildFromUML` 的新順序＝配方 → 課 → Blockly 範式骨架 →（新）矩陣層 → 區塊迴圈（模型）。矩陣層的輸入＝意圖（讀取器）＋範例（題目的 `tests`、讀取器能算出的、或使用者給的）；輸出＝VM／矩陣程式 → 反編譯 → CNL → Python → 沙盒（含隱藏測資）。矩陣層內的子順序：遞推（Berlekamp–Massey→矩陣冪）→ 有限自動機（Hankel／狀態合併）→ 半環圖（路徑計數／最短路／閉包）→ VM（控制 FSM＋小矩陣＋堆疊／佇列／陣列）枚舉合成（小指令集、有預算）。
   - **使用者只有需求、沒有測資怎麼辦**：這是產品上最大的缺口。方案要寫清楚：由讀取器從敘述生成範例輸入、請使用者（卡片）確認或補期望輸出、用參考解（若有）、或標 `verified:false` 並誠實說明。不能假裝驗證過。
   - 風險與誠實的界線：範例太少會推錯、過度擬合；枚舉合成的預算與指數爆炸；可讀性（第 14 節的守則：小區塊、命名、反編譯）。
2. **【模式 A 已跑完：Blockly 現況 2/60，結果在 DESIGN.matrix-fallback.md §9；跑法 `FA_TS_DIR=/tmp/fa-ts-cache node scripts/eval/bench_coverage.js --json out.json`（Node 版，每題一行進度；Electron 版 bench-coverage.eval.js 在本機卡住，勿用）。下一步＝待辦 3：矩陣層要自己從 tests 推輸入形狀（§9.2），先做 L1 遞推與 L2 有限狀態，跑 bench 模式 B 比對】量涵蓋率的基準（歷史記錄）。題庫已寫完（60 題，未提交）：`scripts/eval/gen_bench_*.py`（共用 `bench_lib.py`；答案由 ref 執行得出）→ `renderer/src/recipe/seed/bench_L1_L2.jsonl`、`bench_L3_L4.jsonl`、`bench_L0_L5_L6.jsonl`、`bench_extra.jsonl`（L0:6 L1:8 L2:8 L3:8 L4:10 L5:7 L6:9 other:4）。【下一步】寫跑分器（Node，例如 `scripts/eval/bench_coverage.js`，仿 `scripts/eval/offline-code.eval.js` 的做法，用 judge-core 當 judge），只跑模式 A＝Blockly 現況（buildFromUML，無 pick），輸出每級題數／解出數／用到哪層（recipe／lesson／paradigm）／tried／耗時／解不出清單與原因，存成報告檔；之後矩陣層做完再加模式 B、C。原要求：**（DESIGN.matrix-fallback.md §7 有契約；分批寫題，每批 10 題一個檔，例如 `renderer/src/recipe/seed/bench_L1_L2.jsonl`，格式沿用 problems.jsonl；每題附 `level` 欄）：不要只靠種子 20 題。寫一組「沒見過的」題目（至少 60 題，分級：FSM／遞推／半環圖／計數器／堆疊／佇列／陣列／其他），每題有敘述、`tests`、`hidden`、參考解；分三種跑：只用 Blockly（現況）、Blockly＋矩陣層、全部加模型（沒有模型時跳過）。輸出涵蓋矩陣（每級題數、解出數、用到哪一層、嘗試次數、耗時）。**如實列出解不出的與原因**。放在 `renderer/src/recipe/seed/` 或新資料夾（先看現有 `problems.jsonl` 格式，沿用）。
3. **【進行中：第一批＋L0 已做並提交（5afacde1、1ba893d9；未發布）】`renderer/src/algo/matrix_synth_core.js` 已有 L1 遞推枚舉（BigInt 矩陣冪）、L2 自動機家族、L0 公式枚舉（`synthFormula`）；`buildFromUML` 已接 `Matrix`／`examples`（讀不出意圖時與範式骨架後各試一次）；`matrix_synth.test.js` 已登記（核心測試 183 項全過）。基準模式 B：`FA_TS_DIR=/tmp/fa-ts-cache node scripts/eval/bench_coverage.js --mode B` ＝ 21/60（A 是 2/60；21 裡只有約 +17 屬矩陣層，其餘是別的 session 改讀取器；L1 8/8、L2 8/8 不是獨立結果，見 DESIGN §9.3）。沒解出的 L0：clamp（2 筆範例都在範圍→過度擬合）、sum-1-to-n（數值上限 2^50）、triangle-area2（大小>9）、sort-4（多整數輸出）。**【重要更新】題庫已被 Blockly 補教學污染：模式 A 現在 59/60、B 60/60（見 DESIGN §9.5），不再是泛化指標；b-lucas-mod 參考解已修。下一步優先：做一份新的 held-out 題庫（凍結合成器與範式後才產生、不依它調整），才能量矩陣層的邊際價值。**下一批**：輸入形狀推斷（整數清單、n＋清單、格子、邊表）＋L3 半環範本、L4 計數器範本（gcd／collatz／digit-sum／isqrt／pow-mod／is-prime）、L5 堆疊、L6 佇列／陣列範本（VM 範本庫，骨架優先）；範例太少時的主動提問／生成輸入（DESIGN §5）；`explain／blocks／matrixForm` 欄位已預留。完成後接宿主 `_codeOffline`＋嵌入（待辦 4）。原要求：**新檔（純函式 UMD）例如 `renderer/src/algo/matrix_synth_core.js`（從範例合成矩陣／VM 程式）＋接進 `py_uml_pipeline_core.js` 的 `buildFromUML`（在範式骨架之後、區塊迴圈之前，回傳結果加 `matrix:{kind, size, tried}`）；反編譯用 `matrix_decompile_core.js`；先把待辦 2 的基準跑出「Blockly 解不出、矩陣層能解」的題目，逐級做，每做一級就跑核心測試與基準。每級要有：隨機輸入對照參考解的測試、沙盒驗證、錯誤範例（過度擬合）的防護（隱藏測資、範例切分驗證：用一部分範例推、另一部分驗證）。
4. **宿主接線與真 Electron 評估**：`_codeOffline` 走新的後備鏈（沒有模型也能走），`write_code` 結果要標清楚用了哪一層；`scripts/eval/offline-code.eval.js` 擴充；`embed-code-ui.js` 嵌入新模組（記得：改嵌入區塊要改來源檔，不要直接改 `floating-assistant.js`）；`xvfb-run -a node scripts/eval/run_eval.js <評估檔> <埠>`。
5. 文件與收尾：`DESIGN.TODO.md` 現況總覽一列、`DESIGN.ast-nodes.md`（新增 7.5 或指向新文件）、`STATUS.md`；`node scripts/embed-code-ui.js && node build-assistant.js`；`FA_TS_DIR=/tmp/fa-ts-cache node scripts/run-core-tests.js` 全過。**不提交發布，除非使用者說「提交並發布」。**
6. **依序接著做，不要停下來問**（使用者說「上述是實現的順序的宣告，請依序完成」；我的理解：後備鏈的順序是 Blockly writer → 矩陣層，實現也照這個順序——先量 Blockly 單獨的涵蓋率，再做矩陣層；做完 1～5 之後，再依 `HANDOFF.block-writer.md` 排好的順序往下做）：Node.js 區塊庫、LLVM IR、LLVM IR→code gen、其餘領域（資料結構、虛擬化、影像、分散式／平行含同步、最佳化／啟發式）、用區塊增修既有程式。細節在 `HANDOFF.block-writer.md` 與 `DESIGN.block-domains.md`。

## 5. 工作方式（使用者的規則，原樣照辦）

- 回應用繁體中文或英文，**簡體字絕對不行**；講清楚在做什麼、給看得到的輸出，不要讓使用者猜是不是卡住；誠實區分「我驗證的／別人回報的／推測」；沒達標叫「待改善」，不要說成完成；不要宣稱「涵蓋所有問題」，要給涵蓋表與解不出的清單。
- **先讀專案現有的程式再動手**（使用者多次因為沒讀而生氣）；每個語言各自一份、不跨語言共用；`write_code` 只有一個入口；`write_code` 領域關閉思考；流程是 UML 切割 → 骨架 → 區塊迴圈（庫存過濾、嚴格範本）→ 模型只在合法庫存內微選擇 → 沙盒 ⇄ 錯誤回饋。大模型在 wasm 跑不動，所以每一步選擇要更少、更明確。
- 有多少 release 多少；下載與安裝先取得同意並列出檔名、來源、大小；**不使用埠 17923**；版號單調遞增。
- 提交與發布一律用 `hungfu.lee`（`ssh hungfu.lee@127.0.0.1`，cd 到同資料夾）；建置要先用自己的帳號做完再 `scripts/publish.sh -m "…" --skip-build --no-web`（帶 `PUBLISH_TRAILER="Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"`）；`publish.sh` 會把 `renderer`／`scripts`／`web-lazy` 三個資料夾裡所有改動一起提交，發布前先看 `git status`；根目錄的檔案（`main-ext.js`、文件）要另外先提交。
- 只有使用者說「提交並發布」才提交發布（他曾經誤把這句送給子工作階段，發布前先確認沒有別的工作階段已經在發）。
- **週額度規則（2026-11-06 更新，取代舊的「84%→88% 就停手」）**：平時（週六 07:00 CST 週額度重置後，到下週五 19:00 前）週額度到 88% 就停手、寫交接、不要啟動接手者（等使用者續）；**只有「週五 19:00 → 週六 07:00（CST）」可以放心用光週額度**（可跑真模型評測與較大基準）。判斷用 `date` 查本機時間；5 小時額度到上限會自己暫停，再繼續即可。context 到 30% 仍照交接程序交給接手者。

## 6. 使用者原話（逐字，附日期）

- 2026-11-06：「blockly-writer -> matrix-algorithms　blockly-writer評估不出來, out of scope的用matrix-algorithm評估　我們的blockly+matrix-algorithm的範式，需要可以cover所有的可解問題，讓code-writer可以產生能解決使用者需求的程式」
- 2026-11-06（矩陣評估，已完成，`DESIGN.matrix-algorithms.md`）：「有一種概念是萬物都可以做成矩陣相乘，評估一下有可能所有演算法都成為矩陣相乘嗎，把矩陣+狀態機，像是LALR/yacc會做成一個狀態矩陣」「如果這個可行，我們是不可以將未知問題的function body mapping變成矩陣」「如果是不用一個巨大的，而是多個小的組織起來呢，中間用狀態機連接」「就像把矩陣運算當成一個虛擬機器一樣，類似CoLU的概念」「ReLU, CoLU的概念」「如果內層ReLU被實做出來，驗證可以各種輸入輸出都滿足，就足以被編譯成一個CoLU」「那對於我們無法用矩陣接起來的有什麼程式化的銜接的方式?另一個矩陣?堆疊?」「幫我評估，如果這個可行，是各種應用都做的出來，但核心會是很難解讀的黑盒子嗎」
- 2026-11-06（Blockly writer）：「接著完成 offline model的DESIGN.TODO的block writer的項目 範式骨架庫(每個範式一個帶槽位的區塊谷架) 寫程式的離線組合(uml_design、課、區塊迴圈、沙河)接進wrie_code」；「先做一個程式語言，第二步是做llvmir，然後llvm ir => code gen」；多領域：「接著是要多領域的block-writer，像是數位訊號處理的演算法」「影像處理的演算法」「分散式運算、平行運算的演算法」「虛擬化設計概念的演算法」「尋求問題並接起現有應用的演算法呢?例如螞蟻演算法，貪婪演算法」「平行運算與同步的演算法也要」「記憶體配置是屬於...? 樹狀節點與平衡嗎」；「應該是blockly writer」；「block-writer整合到write-code完成了嗎，完成了可以先發布」（已發布 v311）；「例如增修功能 block-writer有具備從現有的code走tree sitter，反射到blockly，來支援code edit嗎?」
- 2026-11-06：「上述是實現的順序的宣告，請依序完成」（接在上面那句 blockly-writer -> matrix-algorithms 之後）
- 2026-11-05：「可以都完工再來發布」、「提交並發布」（發布只在他明確說這句時才做）
- 2026-11-06（週額度規則，三則）：「週額度要重啟了，請放心用光」；「這個週額度可以用光的規則僅用於禮拜五晚上7點後」；「平時禮拜六七點後，到隔週的禮拜五晚上七點前，不能這樣做」
- 2026-11-06（完整備援鏈）：「blockly -> fallback matrix algorithms -> 這邊還沒效，就是要上網找答案，湊CoLU，或等我們補教學」；「uml-design+colu 無法切割的問題，會去找 sourceforge、github、codeproject 這些開源地方，變成 CoLU 後組裝」（已實作：catalog_discover，見 DESIGN.matrix-fallback.md §10，不另寫）
- 2026-11-06（矩陣→UML／Blockly 支援 code edit）：「我們有matrix的decompiler，可以從這變成matrix -> uml/blockly來支援code edit吧」（設計在 DESIGN.matrix-fallback.md §11，實作排在矩陣層有進步之後）
- 寫程式流程（`DESIGN.ast-nodes.md` 第六、七節，使用者逐字重點）：UML 任務切割 → 程式骨架生成（Boilerplate）→ 進入 Block 產生迴圈〔① 程式端計算當前 Symbol Table（Inventory）② 用 Inventory 過濾合法區塊選項 ③ 套嚴格 Template（For／While 結構防呆）〕→ 模型僅在合法 Inventory 內做微型選擇 → 沙盒編譯驗證 ⇄ 錯誤回饋。

## 7. 交接程序（自我遞迴）

執行 low-context-long-run 技能，門檻 30%（`mcp__ccd_session_mgmt__get_usage`，只在一個完成的工作單位之後檢查）；**週額度規則見 §5（平時 88% 停手、不啟動接手者）**，把狀態寫進本檔與 `STATUS.md`，不要啟動接手者（等額度重置再由使用者續）。到 context 門檻而額度還夠：改寫這份文件（保留逐字使用者原話）→ 提交（`ssh hungfu.lee@127.0.0.1`，只加自己的檔案）→ `mcp__ccd_session__start_session`（`user_asked`、`fresh`、同資料夾、標題「matrix-fallback · handoff N」）→ 等接手者確認 → `mark_completed` 再 `archive_session`（被拒就停，告訴使用者）。待辦清空且驗證完就不要再交接，直接報告完成。

## 8. 陷阱

- `scripts/embed-code-ui.js` 會把 `renderer/src/` 模組整份蓋回 `floating-assistant.js` 的嵌入區塊：直接改嵌入區塊會被蓋掉。改完 embed＋build 後 grep 確認還在。
- 核心測試的 tree-sitter 七組在沒有快取時「略過」算失敗：`FA_TS_DIR=/tmp/fa-ts-cache node scripts/run-core-tests.js`。系統匣對話框那組整組跑偶發失敗、單獨跑會過。
- 範式骨架限制：走「程式區塊：」→`parseCNL`，**巢狀 `def` 會被丟掉**，所以骨架不能寫遞迴函式；矩陣層的遞迴型題目要靠 VM 的堆疊，或先修這個限制。
- `pkill -f`／`pgrep -f` 會比對到自己的 bash 指令：用 `ps -eo pid,args | grep "[x]yz"`。
- 生 qwen3-0.6b：`scripts/eval/mini_llama_server.py`（本機 `llama_cpp_python`，模型 `/var/www/html/check-source-download/crb-status/models/qwen3-0.6b/*.gguf`）；它連 UML 的參與者階段都過不了，評測要由程式先回答前面階段。這個任務原則上不需要模型。
- 用內嵌指令寫修補程式會吃掉反斜線與引號：寫成檔案再執行，先在記憶體組好新內容再寫檔。
- 內建瀏覽器窗格隱藏時 `requestAnimationFrame` 不會跑：要先 `tabs_select`。
