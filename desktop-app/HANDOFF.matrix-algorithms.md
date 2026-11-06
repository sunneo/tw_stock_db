# 交接：評估「所有演算法都能變成矩陣相乘嗎」（矩陣＋狀態機，LALR／yacc 的狀態矩陣）

## 1. 開場提示（接手者收到的原文）

請接續 `desktop-app/HANDOFF.matrix-algorithms.md`：完整讀完（含使用者原話與工作方式），照著做，並執行 low-context-long-run 技能（門檻 30%）：做下一個待辦，context 到門檻就寫下一份交接、啟動自己的接手者。第一則訊息請用一行確認你讀了文件、從哪個待辦開始。
使用者原話（2026-11-06）：「有一種概念是萬物都可以做成矩陣相乘，評估一下有可能所有演算法都成為矩陣相乘嗎，把矩陣+狀態機，像是LALR/yacc會做成一個狀態矩陣」；接著又說：「如果這個可行，我們是不可以將未知問題的function body mapping變成矩陣」。

## 2. 概況

- repo `tw_stock_db`，資料夾 `/home/hungfu.lee/下載/SRC/tw_stock_db/desktop-app`，分支 `desktop-app`。Linux、使用者 `automation`；提交與發布走 `ssh hungfu.lee@127.0.0.1`（`docs/HANDOFF.md` §3）。
- **這個任務是評估（寫文件＋用小程式驗證主張），不是產品功能**；不要提交發布，除非使用者說「提交並發布」。
- **別的工作還在進行，不要碰**：使用者的「提交並發布」（2026-11-06）誤送到接手工作階段 `block-writer-1`（`local_74101fc3-8469-4d02-aa68-4f795a79d118`），它正在做 block-writer 那批（範式骨架庫、write_code 離線接線、小窗口／頁數預估等）的提交與發布。**先查再動**：`git log --oneline -3`、`cat PATCH_VERSION`、`node scripts/release-version.js status`（要看到 311 才算發完；沒有的話不要自己發，問使用者或看那個工作階段）。工作樹裡有大量別人的未提交檔案；你只加自己的檔案（見下）。
- 相關既有成果（讀了再寫）：`DESIGN.ast-nodes.md` 7.2（矩陣快速冪：`mat_mul`／`mat_pow` 區塊、費氏轉移矩陣）與 7.3（範式骨架庫）、`renderer/src/uml/py_paradigms_core.js`（17 個範式，含 matrix-power）、`renderer/src/uml/algo_intent_core.js` 的 `PARADIGMS`、`DESIGN.TODO.md` 原檔 block-writer。

## 3. 待辦（依序）

1. **寫評估文件 `DESIGN.matrix-algorithms.md`**（繁體中文，結論先講、誠實分「證明過的／我用程式驗證的／推測」）。要回答：「所有演算法都能成為矩陣相乘嗎？」我先做的分析（要查證、補細節、必要時修正）：
   - **能（有結構的一大類）**：①有限狀態機（DFA／NFA／正規表示式）：每個輸入符號一個轉移矩陣，狀態是 one-hot 向量，輸入一串＝矩陣連乘；矩陣乘法有結合律，所以能分段並行、做前綴掃描（parallel prefix scan）。②線性遞推（費氏、轉移矩陣快速冪，O(log n)）。③圖：路徑計數（鄰接矩陣的冪）、可達性／傳遞閉包（布林半環）、最短路（min-plus 熱帶半環，Floyd–Warshall／矩陣平方）、最大可靠度（max-times）。④DP 的一大類＝半環上的矩陣乘法（Viterbi、前向演算法、計數型 DP）。⑤CYK／Valiant：上下文無關文法的辨識可化成布林矩陣乘法（O(M(n))）。⑥雜湊 id、排序網路…等「固定資料流」的線性部分。
   - **LALR／yacc**：action／goto 表本身是（稀疏）矩陣——「狀態 × 符號 → 動作」。但**驅動迴圈需要堆疊**（下推自動機），所以不是單一個有限矩陣的連乘；要把堆疊深度限制在 K 才能展開成（狀態×堆疊內容）的有限矩陣，狀態數指數成長。實際可說的是：「表是矩陣、一步移轉是一次向量×矩陣（one-hot 取列）、堆疊是矩陣之外的記憶」；等價的矩陣化路線＝CYK／Valiant（吃 O(n³) 或 O(M(n))，LR 是 O(n)）。要在文件裡講清楚這個取捨與誰比較適合小模型／可驗證。
   - **不能（或沒有意義）**：①任意電腦程式（圖靈完備）在「有界空間 S」下可寫成 2^S 維的 0/1 轉移矩陣（組態轉移矩陣），在形式上「全部都能」，但維度指數爆炸、不是演算法的結構而只是換個寫法；無界記憶要無限矩陣。②資料相依的控制流、遞迴、比較／分支（非線性）：要靠半環以外的運算（max／比較在熱帶半環裡是加法，但一般的 if 不是）；神經網路是「矩陣乘法＋非線性」，不是純矩陣乘法。③停機問題等不可判定的東西不管怎麼表示都不會變可判定。④效率：矩陣表示常比原演算法慢（如 LR 的 O(n) vs CYK 矩陣乘法），好處在並行、可微分、可驗證與「統一的骨架」。
   - 結論草案：**有限狀態／半環結構的演算法：可以，而且是好的表示；一般演算法：形式上可以（有界空間的組態矩陣），實用上不行；LALR／yacc：表是矩陣，驅動需要堆疊，不是純矩陣乘法。**
2. **用小程式驗證主張**（純函式 UMD，不進產品）：新檔 `renderer/src/algo/matrix_forms_core.js`＋ `matrix_forms.test.js`（登記到 `scripts/run-core-tests.js`）。至少驗證：①DFA 矩陣連乘＝直接跑 DFA（含前綴掃描分段並行結果相同）；②min-plus 矩陣平方＝Dijkstra／Floyd 最短路；③布林矩陣冪＝傳遞閉包／連通分量；④線性遞推用 `mat_pow`＝迴圈（n 很大也對，取模）；⑤用一個小文法（算術運算式）建 SLR／LALR 表（action／goto 矩陣），驅動迴圈＋堆疊剖析＝遞迴下降剖析；同時示範「去掉堆疊只用矩陣連乘」做不到（舉反例：括號配對需要無界計數，深度 K 的展開矩陣維度隨 K 成長，量給文件看）；⑥CYK 用布林矩陣乘法辨識同一個文法，對照 LR。每項測試要有隨機輸入對照。
2b. **第二個問題（使用者追加）：「如果這個可行，我們是不可以將未知問題的 function body mapping 變成矩陣」**——評估並用程式驗證：對「沒見過的題目」，能不能把 function body 對應成（狀態機＋）矩陣，讓離線小模型不必逐行寫程式，而是「選／推出矩陣」。我先做的分析（要查證、補細節）：
   - 這是**從輸入輸出範例推出矩陣**的問題：加權自動機的學習（Hankel 矩陣的秩＝最小線性表示的維度；譜學習 spectral learning／Ho–Kalman）、線性遞推用 Berlekamp–Massey 從數列求出遞推式再轉成轉移矩陣、DFA 用 L*／狀態合併（RPNI）、半環版本（min-plus、布林）要換成對應的學習法。題目的範例測資（`renderer/src/recipe/seed/problems.jsonl` 的 tests）就是學習資料；沙盒判題（含隱藏測資）是驗證，也能檢查「推出的矩陣有沒有過度擬合」。
   - **能做的範圍**：輸出是「輸入序列的線性（半環）函數」的題目（計數型、遞推型、固定長度視窗、狀態機型字串題、路徑計數／最短路）。**做不到**：需要無界記憶、非線性比較或分支（排序、二分、括號配對…）、輸入規模遠大於範例所能約束的情況——這些要在文件裡列清楚並用反例驗證（例如括號配對的 Hankel 矩陣秩無界）。
   - 要驗證的小實驗（放在 `matrix_forms_core.js` 或另一個純函式檔，同樣有測試）：①給費氏／爬樓梯／三項遞推的前 N 項，Berlekamp–Massey 推出遞推式、轉成轉移矩陣、`mat_pow` 算第 n 項，跟參考解逐一對照（含大 n 取模）；②給一個 DFA 風格的字串題（例如「二進位字串能被 3 整除」「不含連續兩個 1 的字串數」）只給範例，用狀態合併或 Hankel 秩學出轉移矩陣，對隨機字串對照；③給路徑計數題（小圖）學出的矩陣對照；④反例：括號配對、排序、第 k 大，Hankel 矩陣的秩隨範例變大而增加，學不出有限矩陣（量給文件看）。
   - 回答「function body mapping」：把學到的矩陣放進範式骨架（槽位＝矩陣維度、初始向量、轉移矩陣各元素、答案取哪一格、取模），產生的 body 是 `mat_pow`／連乘的區塊；這等於把「未知題」變成範式 `matrix-power`／`state-machine` 的實例，由沙盒驗證。文件要說清楚它跟現有「配方／課／範式骨架」的差別（那些是人寫好的候選，這個是從範例推出來的候選）、風險（範例太少會推錯、過度擬合、隱藏測資不過）、以及適用範圍的估計（種子 20 題裡有幾題在範圍內，用實驗數出來）。
3. **跟 block-writer 的連結（只寫建議，先不接進產品）**：文件最後一節回答「這對離線小模型寫程式有什麼用」：例如把「狀態機／線性遞推／圖半環」做成範式骨架庫的新範式（槽位＝狀態集合、轉移表、半環選擇、初始向量、答案取哪一格），選單小、可窮舉交沙盒；LALR 表當成「語法 → 狀態矩陣」的產生器可作為程式碼→UML／文法工具的一環。哪些先做、哪些不值得，如實列成待改善；不要直接動 `py_paradigms_core.js`。
4. 更新 `STATUS.md`（新增一段）與 `DESIGN.TODO.md` 現況總覽加一列（狀態：評估完成＋驗證了哪些；下一步：是否把半環／狀態機範式接進範式骨架庫，由使用者決定）。跑 `FA_TS_DIR=/tmp/fa-ts-cache node scripts/run-core-tests.js`（要全過）。**不提交發布**；你的檔案：`DESIGN.matrix-algorithms.md`、`renderer/src/algo/matrix_forms_core.js`、`renderer/src/algo/matrix_forms.test.js`、`scripts/run-core-tests.js` 的那一行、`STATUS.md`、`DESIGN.TODO.md` 那一列、本檔。

## 4. 工作方式（使用者的規則，原樣照辦）

- 回應用繁體中文或英文，**簡體字絕對不行**；講清楚在做什麼、給看得到的輸出，不要讓使用者猜是不是卡住；誠實區分「我驗證的／別人回報的／推測」；沒達標叫「待改善」，不要說成完成。
- **先讀專案現有的程式再動手**（使用者多次因為沒讀而生氣）；寫程式每個語言各自一份、不跨語言共用。
- 有多少 release 多少；下載與安裝先取得同意並列出檔名、來源、大小；**不使用埠 17923**；版號單調遞增。
- 提交與發布一律用 `hungfu.lee`（`ssh hungfu.lee@127.0.0.1`）；提交只加自己的檔案（別的工作階段的未提交檔案：`features/FEATURES.md`、`skills/image-decompose-redraw/data/parts_builtin.json`、`DESIGN.edit-*.md`、`DESIGN.env-baseline.md`、`HANDOFF.edit-remote.md`、`skills/weak-model-harness/scripts/bridge/`、`72d21a0c-…` 資料夾都不是我們的）。提交訊息結尾加：`Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`。
- 週額度接近 90% 就交接（交接時週 79%、5 小時 36%）。`docs/HANDOFF.md` 的擁有者是 `stevenyc.huang`，`automation` 寫不進去，不要 chmod；進度寫在 `STATUS.md` 與本檔。

## 5. 使用者原話（逐字，附日期）

- 2026-11-06：「有一種概念是萬物都可以做成矩陣相乘，評估一下有可能所有演算法都成為矩陣相乘嗎，把矩陣+狀態機，像是LALR/yacc會做成一個狀態矩陣」
- 2026-11-06：「如果這個可行，我們是不可以將未知問題的function body mapping變成矩陣」
- 2026-11-05：「可以都完工再來發布」、「提交並發布」（發布只在他明確說這句時才做）；2026-11-06 他又說「提交並發布」但送錯對象，說「我剛弄錯對象，跟subsession溝通了」。
- 2026-11-06（block-writer，已交給 `block-writer-1`）：「接著完成 offline model的DESIGN.TODO的block writer的項目 範式骨架庫(每個範式一個帶槽位的區塊谷架) 寫程式的離線組合(uml_design、課、區塊迴圈、沙河)接進wrie_code」
- 寫程式流程（`DESIGN.ast-nodes.md` 第六、七節，使用者逐字重點）：UML 任務切割 → 程式骨架生成（Boilerplate）→ 進入 Block 產生迴圈〔① 程式端計算當前 Symbol Table（Inventory）② 用 Inventory 過濾合法區塊選項 ③ 套嚴格 Template（For／While 結構防呆）〕→ 模型僅在合法 Inventory 內做微型選擇 → 沙盒編譯驗證 ⇄ 錯誤回饋。

## 6. 交接程序（自我遞迴）

執行 low-context-long-run 技能，門檻 30%（用 `mcp__ccd_session_mgmt__get_usage` 看自己的 context 百分比，只在一個完成的工作單位之後檢查）。到門檻：改寫這份文件（保留逐字使用者原話、追加新的）→ 提交（`ssh hungfu.lee@127.0.0.1`，只加自己的檔案）→ `mcp__ccd_session__start_session`（initiation `user_asked`、context `fresh`、同資料夾、標題「matrix-algorithms · handoff N」）→ 等接手者確認 → `mark_completed` 再 `archive_session`（被拒就停，告訴使用者哪個 session id 沒封存）。待辦清空且驗證完就不要再交接，直接報告完成。

## 7. 陷阱

- `scripts/embed-code-ui.js` 會把 `renderer/src/` 模組整份蓋回 `floating-assistant.js` 的嵌入區塊：直接改嵌入區塊會被蓋掉；本任務的新檔是純函式評估程式，先不要嵌入。
- 核心測試的 tree-sitter 七組在沒有快取時「略過」會被算失敗：`FA_TS_DIR=/tmp/fa-ts-cache node scripts/run-core-tests.js`（目前 199/199）。系統匣對話框那組整組跑偶發失敗、單獨跑會過。
- `pkill -f`／`pgrep -f` 會比對到自己的 bash 指令：用 `ps -eo pid,args | grep "[x]yz"`。
- 用內嵌指令寫修補程式會吃掉反斜線與引號：寫成檔案再執行。
- 生 qwen3-0.6b 的位置與本機服務見 `scripts/eval/mini_llama_server.py`；這個任務不需要模型。

## 8. 完成紀錄（2026-11-06，接手者 matrix-algorithms · 第 1 棒）

待辦 1、2、2b、3、4 全部完成，**沒有提交、沒有發布**：`DESIGN.matrix-algorithms.md`、`renderer/src/algo/matrix_forms_core.js`、`matrix_forms.test.js`（49 項）、`scripts/run-core-tests.js` 一行、`STATUS.md` 一段、`DESIGN.TODO.md` 一列。核心測試 `FA_TS_DIR=/tmp/fa-ts-cache node scripts/run-core-tests.js` 200/200。待辦清空，不需再交接。使用者要提交時請說「提交並發布」（只加上面這些檔案）。

### 8.1 追加的使用者原話（2026-11-06，逐字；由 FloatingAssistant 轉來）
- 「如果是不用一個巨大的，而是多個小的組織起來呢，中間用狀態機連接」
- 「ReLU, CoLU的概念」
- 「就像把矩陣運算當成一個虛擬機器一樣，類似CoLU的概念」
已做：`DESIGN.matrix-algorithms.md` 第 9～11 節、`matrix_machine_core.js`、`relu_core.js`、`matrix_vm_core.js`、`matrix_machine.test.js`（28 項，已登記）、STATUS／TODO。仍不提交發布。
- 「如果內層ReLU被實做出來，驗證可以各種輸入輸出都滿足，就足以被編譯成一個CoLU」（2026-11-06，逐字）→ 已做：第 12 節＋`relu_compile_core.js`、`relu_compile.test.js`（16 項，已登記）。
- 「那對於我們無法用矩陣接起來的有什麼程式化的銜接的方式?另一個矩陣?堆疊?」（2026-11-06，逐字）→ 已做：第 13 節＋`matrix_memory.test.js`（11 項，已登記）。
- 「幫我評估，如果這個可行，是各種應用都做的出來，但核心會是很難解讀的黑盒子嗎」（2026-11-06，逐字）→ 已做：第 14 節＋`matrix_decompile_core.js`、`matrix_decompile.test.js`（15 項，已登記）。
