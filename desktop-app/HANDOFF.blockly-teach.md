# 交接：Blockly 補教學（blockly-teach）階段 2 —— 補缺口 G1–G18，之後檢查思考堆疊／CoLU

## 1. 開場提示（接手者收到的原文）

請接續 `desktop-app/HANDOFF.blockly-teach.md`：完整讀完（含使用者原話與工作方式），照著做，並執行 low-context-long-run 技能（門檻 30%）：做下一個待辦，到門檻就寫下一份交接、啟動接手者。第一則訊息請用一行確認你讀了文件、從哪個待辦開始。使用者原話（2026-11-06）：「請務必缺口都要補好」；「個別完成都要回來發布」（＝完成一批、提交且測試＋真 Electron 驗證通過後，SendMessage 回報協調 session `local_aa2d0534-d9c3-41a6-8c95-9c3591567ef0`，由它驗證並發布；你自己不要發布）。

## 2. 概況

- repo 資料夾 `/home/hungfu.lee/下載/SRC/tw_stock_db/desktop-app`，分支 `desktop-app`。提交走 `ssh hungfu.lee@127.0.0.1 'cd /home/hungfu.lee/下載/SRC/tw_stock_db/desktop-app && git add <只加自己的檔案> && git commit -q -m … -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"'`（本機 git 有 dubious ownership，直接 git 會失敗，且**不要**用 `git show` 失敗時的重導向覆蓋檔案——我曾因此短暫清空檔案）。**不要發布**。
- 階段 1（patch v312 已發布）：原 60 題 59/60。階段 2 已提交：
  - `dfed1565`：G17＋G1 最小版＋G5（讀取器形狀 hex／lines／rest／樣式 pat／旗標行；否決條件 `veto`／`TOOLISH`；cat／grep 三骨架）。
  - `73deb981`：G3（35 個位元／位元組／格式化／字串積木＋`try_ignore`，`py_blocks_lib_core.js`；`py_blocks_core.js` 的運算式列改成 py 可含 `|`）＋G4＋G7–G13（約 45 個骨架 LX～LX6，在 `renderer/src/uml/py_paradigms_core.js`；`algo_intent_core.js` 的 `TOOLS`＋`TOOL_FAMILIES`＋`intent.algos` 多候選；`forIntent` 支援 shape／sk.limit／多候選）。
  - 都已回報協調 session（批次 2 訊息排隊中，未必已讀）。**尚未發布**。
- 量測（`FA_TS_DIR=/tmp/fa-ts-cache node scripts/eval/bench_coverage.js --files bench_linux_all.jsonl --mode A --json out.json` 再 `python3 scripts/eval/split_report.py out.json`）：**train 37/37、holdout 21/27**（起點 0/64）；原 60 題 59/60；holdout_blockly 28/31；核心測試 208/208；真 Electron 20 題 noLessons／withLessons 20/20。
- holdout 未解 6 題：cat-two（多段輸入措辭讀不出）、exec-env、tar-blocks、canonical-huffman、xz-header、bmp-write8。**不要讀 holdout 的敘述去教**（我沒讀）；只能量測。注意：DESIGN 缺口表已點名 holdout 單元，所以 holdout 對「家族」不乾淨，回報時要照實說。
- 其他 session 的未提交檔不要碰：`features/FEATURES.md`、`skills/image-decompose-redraw/data/parts_builtin.json`、`DESIGN.edit-*.md`、`DESIGN.env-baseline.md`、`HANDOFF.edit-remote.md`、`skills/weak-model-harness/scripts/bridge/`、`72d21a0c-*`、`test-reports/`。不要改 `renderer/src/algo/matrix_synth*`、`scripts/eval/bench_coverage.js` 判題標準。build 產物（`floating-assistant*.js`、`web-lazy/`、`update-manifest.json`）不提交。
- 除錯腳本在 scratchpad（`/tmp/claude-1011/-home-hungfu-lee----SRC-tw-stock-db-desktop-app/b92bd7fc-bc01-45ed-a48c-dca8b98eeb4a/scratchpad` 可能已不在；`/tmp/claude-1011/s/dev.js、dbg.js、verd.js、readdiag.js` 若還在可用）：dev.js 跑指定題；verd.js 只印判決種類不洩漏預期輸出。

## 3. 待辦（依序）

1. **G2 切割模板**：目前所有骨架把全部邏輯塞在 `solve` 一個操作裡。做「輔助操作 helpers」：骨架可宣告 `helpers:(c,N,I)=>[{name,params,py}]`；`Paradigms.solve` 把 helper 的 CNL 連同 solve 一起交給 `judge(cnl, extra)`；`py_uml_pipeline_core.js` 的 `mkModel(solveIR, imports, extraOps)` 加第三參數、把 helper 當額外操作（先問 matrix-fallback-1 `local_7d2ae051-803a-4458-b30c-8ff383841902`，上次問了沒回，改動只加不改既有行）。示範：共用 `crc32(data)` 單元被 `checksum.crc32`、`gzip.stored-member`、`gzip.member-write`、`xz.stream-header` call（整合題＝單元組合）。注意：骨架不能含 def 的限制只針對 CNL「程式區塊」；helper 走獨立操作，要驗證往返與沙盒。
2. **G6**（無 def 改寫）已實質完成（regex 狀態集模擬、調度場＋RPN、inflate、vm 全不含 def）——在 DESIGN 標「已補（無 def 改寫）」，(a) 讓 stmtsOfSource 保留 def 不做。**G18**：讀取器加 `intent.specLike`（敘述含多張表／公式／步驟時標記，供老師迴圈／模型分流；Blockly 側只做偵測與回報），模型／老師部分列「超出」。
3. **DESIGN.blockly-gaps.md**：新增 §7「階段 2 進度」，G1–G18 逐列標「已補＋提交 hash」或「超出」；列出 holdout 未解 6 題與原因、誠實聲明。**超出 Blockly 清單**回報協調 session：G14（LZMA match／rep／距離槽狀態機、LZMA2、BCJ）、G15（判題器二進位 IO／檔案／argv／結束碼／環境變數）、G16（真行程 fork／exec／pipe）、G18 的模型／老師部分、以及「輸出格式／輸入措辭猜不到」類（需老師教）。
4. **真 Electron 跑 64 題 Linux**：`scripts/eval/bench-coverage.eval.js` 在本機會卡住勿用；改用 Node 版 bench＋20 題種子 Electron 回歸（`FA_TS_DIR=/tmp/fa-ts-cache xvfb-run -a node scripts/eval/run_eval.js scripts/eval/offline-code.eval.js 17931`，埠不可用 17923）；改 renderer 先 `node scripts/embed-code-ui.js && node build-assistant.js`。
5. 每完成一批：核心測試 `FA_TS_DIR=/tmp/fa-ts-cache node scripts/run-core-tests.js` 全過、bench 分 train／holdout 報數、原 60 題不退步、Electron 20/20，提交，然後 SendMessage 回報協調 session（提交 hash、train／holdout 解出數、改了哪些 renderer 檔、測試結果）。
6. **思考堆疊／CoLU 缺口檢查**（缺口補完後）：讀 `DESIGN.think-stack.md`、`DESIGN.colu.md`、`uml_bench_core.js` 的 `siblingConsistency`，對照 `renderer/src/uml/py_uml_pipeline_core.js`／`renderer/src/recipe/code_agent_core.js` 離線路徑（`buildFromUML`、區塊迴圈、`_codeOffline`）哪些階段沒有 push／pop 思考堆疊框、沒有一致性檢查、沒有 CoLU 規劃路由、失敗時沒把「卡在哪一層」寫回堆疊。缺口列進 DESIGN 小節（缺什麼／影響階段／建議補法），小項直接補並加測試，大項列清單回報。使用者原話見 §5。
7. 全部做完且驗證後：不要再交接，直接向協調 session 報告完成。

## 4. 工作方式（使用者規則，原樣照辦）

- 語言：繁體中文，**簡體字絕對不行**；講清楚在做什麼、給看得到的輸出；誠實區分「我驗證的／別人回報的／推測」；沒達標叫「待改善」；不宣稱「涵蓋所有問題」。
- **先讀專案現有程式再動手**；規則是**泛化**：不可把題目答案硬編；骨架窮舉槽位交沙盒、不靠排序；參數由敘述抽（facts），抽不到就 throw 不渲染；holdout 只量測、不教。
- 不要改 `floating-assistant.js` 內嵌區塊（改來源檔再 embed＋build）；`pkill -f`／`pgrep -f` 會比對到自己的指令，不要用；等待背景工作用 Monitor 或直接看檔案，不要 `sleep` 長等。
- 所有 Python／評測腳本加記憶體上限：`systemd-run --user --scope -p MemoryMax=16G -p MemorySwapMax=0 <指令>`；新寫生成器要設重試上限。
- 額度：平時週額度 88% 就停手、寫交接、不起接手者；**週五 19:00～週六 07:00（CST）可用光**（2026-11-07 07:00 CST 重置，之後回到 88% 規則）。用 `date` 與 `mcp__ccd_session_mgmt__get_usage` 判斷。context 門檻 30%（一批完成後檢查）。
- 不使用埠 17923；版號單調遞增；提交一律走 ssh；只有使用者說「提交並發布」才發布（發布由協調 session 做）。

## 5. 使用者原話（逐字，附日期）

- 2026-11-06：「請將未知題目的blockly補上」
- 2026-11-06：「個別完成都要回來發布」
- 2026-11-06：「請務必缺口都要補好」
- 2026-11-06：「剛剛linux工具的部份，看來有東西要補」
- 2026-11-06：「blockly-teach看那條uml thinking stack/CoLU thinking有少」
- 2026-11-06：「請用ssh hungfu.lee@127.0.0.1」
- 2026-11-06（Linux 題庫起因，blockly-gap-linux 轉述）：「下一個教學試題，claude先把linux的util如tar, gz, xz, xxd, grep, cat, eval, exec, 實現bmp reader/writer 整個都拆解，全部給予blockly教學，看哪邊有未知的。以及uml到切割問題，到 blockly，哪裡有題形、演算法沒跟上的」
- 寫程式流程（`DESIGN.ast-nodes.md` 第六、七節）：UML 任務切割 → 程式骨架生成（Boilerplate）→ Block 產生迴圈〔① Inventory ② 過濾合法區塊 ③ 嚴格 Template〕→ 模型僅在合法 Inventory 內做微型選擇 → 沙盒編譯驗證 ⇄ 錯誤回饋。
- 週額度規則：「這個週額度可以用光的規則僅用於禮拜五晚上7點後」；「平時禮拜六七點後，到隔週的禮拜五晚上七點前，不能這樣做」

## 6. 交接程序（自我遞迴）

執行 low-context-long-run 技能，門檻 30%：批次邊界檢查 context；到門檻就改寫本檔（保留逐字使用者原話）→ 提交（只加自己的檔案）→ `mcp__ccd_session__start_session`（`user_asked`、`fresh`、同資料夾、標題「blockly-teach · handoff N」，prompt 為 §1 原文）→ 等接手者確認 → `mark_completed` 再 `archive_session`（被拒就停、告訴使用者）。待辦清空且驗證完就不要再交接。

## 7. 陷阱

- 骨架 `py(c,N,I)` 的 `c.<槽位>` 是選項的 **v**（值）不是 id（我又犯一次：`DIVS.find(...)`）；選項若寫成 `[id, v]`，c 拿到的是 v。
- `render` 會把與題目變數同名的局部變數改成 `名稱_2`；骨架局部變數用帶底線名（`raw_`、`w_`）避免。
- Python 陷阱：`"" in "?*"` 為真，判量詞要用 `==` 逐一比；骨架不能含 def、不用 `a = b = 0`；字串裡的反斜線在 JS 要寫 `\\`。
- 骨架 `limit` 必須 ≥ 槽位組合總數，否則窮舉被截斷（linux_paradigms.test.js 會檢查）。
- TOOLS 的正規式太寬會劫持原 60 題（`push` 大小寫、`二進位`、`差分` 都踩過）；每次改 TOOLS 都跑原 60 題、holdout_blockly 與 `domain_dsp.test.js`。同家族候選靠 `TOOL_FAMILIES`，由沙盒擇一。
- 讀取器 override 條件：工具型 `readToolInput` 只在舊流程沒讀到、或讀到 hex／lines／rest／樣式角色／無長度 list 時才覆蓋；舊流程有 grid／rows 就不覆蓋。
- 核心測試登記表在 `scripts/run-core-tests.js`，測試輸出要含「N passed, 0 failed」格式。
- test-reports 會被核心測試改寫，那是別人的檔，不要提交。
