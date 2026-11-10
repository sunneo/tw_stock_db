#!/usr/bin/env node
// 一次跑完所有「純函式核心」的測試（不需要 Electron、不需要瀏覽器）。移植到別的專案（例如 redmine 的 AI 聊天）之後，搬過去的檔案跑這支，確認行為跟這邊一致。
// 用法：node scripts/run-core-tests.js
// 注意：需要真實環境驗證的部分（Electron／瀏覽器裡的標註視窗、蒙皮檢視器、Worker）不在這裡，見 DESIGN.knowledge-portability.md 的「驗證」一節。
const { spawnSync } = require('child_process');
const path = require('path');
const root = path.join(__dirname, '..');
const suites = [
    ['知識引擎（類型、驗證、展開、知識包）', 'renderer/src/refs/tests/ref_engine.test.js'],
    ['標註核心（魔術棒、切格、猜字）', 'renderer/src/annotator/annot_core.test.js'],
    ['蒙皮核心（骨架、權重、動作）', 'renderer/src/skin/skin_core.test.js'],
    ['名稱表（C++ STL、Rust、Go）', 'renderer/src/behavior/tests/names_tables.test.js'],
    ['名稱表（C#、Ruby、Lua；Python、Java、JavaScript 補強）', 'renderer/src/behavior/tests/names_more_langs.test.js'],
    ['圖片處理核心（灰階／強化／減色／模糊／馬賽克／旋轉／縮放／頁面排版）', 'renderer/src/imgproc/imgproc_core.test.js'],
    ['文件合併核心（種類判斷、文字解碼、docx／xlsx 簡化轉換、排版）', 'renderer/src/docmerge/docmerge_core.test.js'],
    ['依任務文字補專用工具（圖片轉PDF、合併文件成PDF）', 'scripts/task-tool-hints.test.js'],
    ['工具預算：短說明、精簡參數、階段切割、檢索', 'renderer/src/tools/tool_budget_core.test.js'],
    ['本機代理：上游回應標頭很肥（40KB）不能變成 502；連不上仍回 502＋x-fa-error', 'scripts/local-proxy-bigheader.test.js'],
    ['YouTube 下載網路層（502 暫時性判斷、重試退避、具體失敗訊息、同意頁／機器人頁／不完整網頁診斷、yt-dlp 錯誤分類）', 'renderer/src/media/yt_net_core.test.js'],
    ['Agent Model Configure：階段圖、特性估計、自動決定、內建預設、開關不動設定、重置、解析與備援順序、AI 回覆檢查', 'renderer/src/tools/agent_model_core.test.js'],
    ['專案索引的定義抽取（C# 方法／屬性／namespace、Kotlin object、Java）', 'scripts/repo-extract.test.js'],
    ['離線圖像轉文字（模型登記、裝置、快取用量）', 'renderer/src/vlm/vlm_core.test.js'],
    ['離線小模型食譜（路由、填欄位、驗證、決策紀錄、多步驟引擎）', 'renderer/src/recipe/recipe_core.test.js'],
    ['CoLU+Thinking 階段 2（thinkingPlan 預算、jsonStep 的 thinking 參數與退路）', 'renderer/src/recipe/think_plan.test.js'],
    ['離線多步驟計畫（目標、規劃、狀態機、決策樹）', 'renderer/src/recipe/plan_core.test.js'],
    ['UML → 程式骨架（DSL、驗證、圖、template、情境到 UML）', 'renderer/src/uml/uml_core.test.js'],
    ['程式碼 → tree-sitter → UML（指令層級）→ Python 往返（需 tree-sitter 快取，沒有就略過）', 'renderer/src/uml/py_code2uml.test.js'],
    ['程式區塊範本庫（90 個範本：程式↔區塊↔受控自然語言雙向、種子程式往返判題；需 tree-sitter 快取）', 'renderer/src/uml/py_blocks.test.js'],
    ['老師迴圈的客觀驗證核心（check 種類、抽出程式碼、判題器問題形狀）', 'renderer/src/harness/teacher_check.test.js'],
    ['內建的課泛化：沒見過的改寫（換變數名稱、隨機測資）離線自己做對，不認得的算法不亂套（需 tree-sitter 快取）', 'renderer/src/uml/py_lessons.test.js'],
    ['uml_design 先讀情境：算法題讀成 UML（0 次模型）→ 骨架 → 區塊 → 沙盒；含沒見過的寫法（需 tree-sitter 快取）', 'renderer/src/uml/py_uml_pipeline.test.js'],
    ['範式骨架庫：不給課，範式骨架＋槽位窮舉＋沙盒解出種子題與沒見過的改寫（選項順序反過來也找得到；需 tree-sitter 快取）', 'renderer/src/uml/py_paradigms.test.js'],
    ['Linux 工具題（cat／grep／xxd／tar／gzip／xz／bmp）：輸入形狀、否決條件、範式（只用 train 題；需 tree-sitter 快取）', 'renderer/src/uml/linux_paradigms.test.js'],
    ['位元／位元組／格式化／字串進階積木（G3）：每個積木的往返、反推與 Python 求值（需 tree-sitter 快取）', 'renderer/src/uml/py_blocks_bits.test.js'],
    ['領域包 DSP：18 題種子（原敘述＋改寫＋選項反序），不給課、0 次模型，float 容差判題，含隱藏大測資（需 tree-sitter 快取）', 'renderer/src/uml/domain_dsp.test.js'],
    ['領域包 algo2：矩陣層沒解出的 15 個演算法家族（歐拉函數、完全數、步數、k 進位、直方圖、更暖天數、巢狀展開、最長合法括號、約瑟夫、視窗聚合、區間聯集、配對計數、RLE 解碼、回文子串、巴斯卡）；train 30/30（需 tree-sitter 快取）', 'renderer/src/uml/domain_algo2.test.js'],
    ['領域包 os（作業系統模擬）：CPU 排程（非搶先／RR／SRTF）、分頁置換、記憶體配適、磁碟排程；train 全過、holdout 只量測（需 tree-sitter 快取）', 'renderer/src/uml/domain_os.test.js'],
    ['領域包 ds（資料結構操作序列）：雜湊表、LRU、堆積、BST、Trie、並查集、鏈結串列；train 全過、holdout 只量測（需 tree-sitter 快取）', 'renderer/src/uml/domain_ds.test.js'],
    ['領域包 linuxtext（cut／sort／uniq／wc／head／tail／tr／sed／awk 行為）：train 全過、holdout 只量測（需 tree-sitter 快取）', 'renderer/src/uml/domain_linuxtext.test.js'],
    ['領域包 sync（同步原語事件模擬）：信號量、互斥鎖、條件變數、生產者消費者；train 全過、holdout 只量測（需 tree-sitter 快取）', 'renderer/src/uml/domain_sync.test.js'],
    ['領域包 graph2（進階圖與樹）：最小生成樹、強連通、Bellman-Ford、樹直徑、LCA、二分圖、最大流；train 全過、holdout 只量測（需 tree-sitter 快取）', 'renderer/src/uml/domain_graph2.test.js'],
    ['領域包 twofile（Linux 兩段輸入）：cat -n 兩檔、comm／diff、join、paste、cmp；train 全過、holdout 只量測（需 tree-sitter 快取）', 'renderer/src/uml/domain_twofile.test.js'],
    ['領域包 fs（檔案系統）：FAT 簇鏈／空閒簇、inode 區塊階層與佔用區塊數；train 全過、holdout 只量測（需 tree-sitter 快取）', 'renderer/src/uml/domain_fs.test.js'],
    ['領域包 linuxsem（Linux 行為語意模擬）：fd 表（open／dup／dup2／close）、管線緩衝、信號遮罩、TCP 狀態機；train 全過、holdout 只量測（需 tree-sitter 快取）', 'renderer/src/uml/domain_linuxsem.test.js'],
    ['領域包 linuxfmt（格式型小工具家族）：樣板變數展開、區塊對齊計數、範式前綴碼；train 全過、holdout 只量測（需 tree-sitter 快取）', 'renderer/src/uml/domain_linuxfmt.test.js'],
    ['區塊的庫存與範本規則（三區、型別、終止條件、模組需求；需 tree-sitter 快取）', 'renderer/src/uml/py_blocks_rules.test.js'],
    ['UML 遞迴切割寫 body（假模型：補全式逐行、縮排結構、退回重寫、區塊版；需 tree-sitter 快取）', 'renderer/src/uml/py_body.test.js'],
    ['AST 建樹：隨機建樹與真 tree-sitter 一致、種子程式重放（需 tree-sitter 快取）', 'renderer/src/ast/ast_replay.test.js'],
    ['CoLU+Thinking 階段 3（計畫階段接上 thinking：開關、逾時退路、推理不進 messages）', 'renderer/src/uml/plan_think.test.js'],
    ['CoLU+Thinking 階段 4（反思：有缺口重做一次、上限、逾時與解析失敗退路、其他模型不變）', 'renderer/src/recipe/think_reflect.test.js'],
    ['CoLU+Thinking 階段 5（設定開關預設值、推理區塊跳脫 HTML、空推理不顯示、長推理截斷）', 'renderer/src/recipe/colu_think_ui.test.js'],
    ['CoLU+Thinking 階段 7（思考逾時的硬性上限：準時、超時放棄、舊結果丟棄、連續不錯位、沒給 timeoutMs 不變、逾時退路）', 'renderer/src/recipe/colu_think_timeout.test.js'],
    ['設計抉擇與 framework 目錄（推薦、片段、rework、專案展開）', 'renderer/src/uml/design_core.test.js'],
    ['膠水（接到真正的 library、經驗、登記）', 'renderer/src/uml/glue_core.test.js'],
    ['設計檢視器資料（節點樹、UML↔原始碼對應）', 'renderer/src/uml/view_core.test.js'],
    ['互動對話卡片（規格、驗證、wizard、還原唯讀）', 'renderer/src/card/card_core.test.js'],
    ['UML 設計引導（卡片流程、套用答案）', 'renderer/src/card/uml_guide.test.js'],
    ['離線日誌格式學習（模板、欄位、摘要、問答、訓練器規則）', 'renderer/src/logmine/log_core.test.js'],
    ['離線設定檔結構學習（INI、TOML、EDK2 INF／DEC／DSC、比較、機密遮蔽）', 'renderer/src/logmine/cfg_core.test.js'],
    ['文法自己發現（讀→建規則→驗證→再長；YAML、BitBake、nginx、Dockerfile、自創格式）', 'renderer/src/logmine/gram_core.test.js'],
    ['LALR(1) 表產生器與驅動程式（遞迴文法、衝突處理、優先序、bison 輸出）', 'renderer/src/logmine/lr_core.test.js'],
    ['遞迴文法與分析表的學習（讀→找解析不了的地方→換成別的規則／組合／新規則→驗證）', 'renderer/src/logmine/cfglearn_core.test.js'],
    ['語法斷點發現（不假設一行一個陳述：找處理不了的邊界→兩兩合併→終結符號→驗證）', 'renderer/src/logmine/boundary_core.test.js'],
    ['混合內容語法高亮（切段、語言識別、信心度、自學習、逐詞著色）', 'renderer/src/logmine/mix_core.test.js'],
    ['英文句子理解（詞類、片語、LALR 子句文法、框架、意圖、混合內容引用）', 'renderer/src/logmine/nlu_core.test.js'],
    ['意圖推導（受詞／目標型別、簽名比對、離線計畫可行性）', 'renderer/src/logmine/intent_core.test.js'],
    ['離線理解閘（動作、目標種類、開啟工具、後置步驟、處理建議）', 'scripts/offline-gate.test.js'],
    ['離線理解閘接進執行流程（找主題、站內搜尋、摘要、路由）', 'scripts/offline-gate-exec.test.js'],
    ['離線理解閘：理解不了先思考、問使用者並記憶、最後核對', 'scripts/offline-gate-think.test.js'],
    ['離線理解閘：打開的種類表（MIME 對應）、覆蓋測試、終端機、語意推導命中率', 'scripts/offline-gate-open.test.js'],
    ['離線理解閘：探索迴圈（目錄→知識庫→小模型→問使用者）與反思換路線', 'scripts/offline-gate-explore.test.js'],
    ['單元目錄核心（已登記工具 → 單元：型別、副作用、可用性、信任等級；型別字串與相容判斷；格式驗證；評量統計）', 'renderer/src/catalog/catalog_core.test.js'],
    ['萬物皆矩陣相乘的驗證（半環矩陣、DFA 連乘與掃描、min-plus／布林圖、Berlekamp–Massey 遞推、LALR 表矩陣＋有界堆疊、CYK 布林矩陣、Hankel 秩與從範例學矩陣）', 'renderer/src/algo/matrix_forms.test.js'],
    ['矩陣＋狀態機＋ReLU 電路＋矩陣 VM 的驗證（暫存器機：費氏／DFA 計數／括號堆疊／gcd／質數／固定 n 排序與二分；直和 vs 乘積；ReLU 閘數；VM 指令集、驗證器、JSONL、編譯對照）', 'renderer/src/algo/matrix_machine.test.js'],
    ['ReLU 網路 → CoLU 決策樹／機器的編譯（精確等價、exact 與 domain 模式、JSONL、區域數 vs 神經元數、域外與浮點的反例、驗證會擋）', 'renderer/src/algo/relu_compile.test.js'],
    ['矩陣接不起來的地方的銜接（佇列 BFS、one-hot 記憶體＝矩陣、雙調排序不經意網路、並查集與指標跳躍、有界堆疊＝移位矩陣、種子 20 題最少記憶體）', 'renderer/src/algo/matrix_memory.test.js'],
    ['矩陣反編譯與可讀性（矩陣→遞推式、one-hot 矩陣→DFA→狀態圖／正規表示式、ReLU 樹→if／else、VM→中文 CNL；結構式 vs 稠密學出的矩陣）', 'renderer/src/algo/matrix_decompile.test.js'],
    ['矩陣層後備（只靠敘述＋2 筆範例合成：L1 線性遞推枚舉＋矩陣冪、L2 自動機家族；形狀不支援／不是線性遞推要明確失敗；範例不足回報 ambiguous）', 'renderer/src/algo/matrix_synth.test.js'],
    ['矩陣層 graph／grid 模組（邊表／格子形狀＋L3 半環與走訪範本；heldout2 ≥20/22、heldout3 ≥21/21 回歸，heldout4 ≥14/19、heldout5（L0）verified ≥4/12、heldout6（組合）12 成功 verified ≥9，範本庫沒有的題型要誠實失敗）', 'renderer/src/algo/matrix_graph.test.js'],
    ['矩陣 → code edit（合成程式整理成可編輯版：形態往返、改係數／轉移表行為跟著變、走 Python→UML 路徑 raw=0、改壞時降級；需 tree-sitter 快取）', 'renderer/src/algo/matrix_edit.test.js'],
    ['矩陣 → Blockly 區塊（合成結果拆成有名字的區塊段落：DFA／遞推／圖／格子／方陣／組合層；區塊編回 Python 與原程式在題庫測資＋隨機輸入上輸出一致；改槽位與換組合積木後輸出照新形態；需 tree-sitter 快取與 python3）', 'renderer/src/algo/matrix_blocks.test.js'],
    ['函式內部再切成步驟（轉換鏈→歸約、對半遞迴切 1～4 層；切割規則與門檻按 contextWindowTokens 縮放、步驟簽名接線、步驟級驗證只換壞的那一步、組裝後整體判題、失敗回退 fallback、字母選擇題退路；1/2/3 層三題對照只切一層；需 python3）', 'renderer/src/uml/step_split.test.js'],
    ['核心 IR（跨語言中間語言）：資料結構／驗證器／序列化、標準操作目錄（72 個操作 x 8 個語言的靜態一致性）、型別推斷與降低、Python → IR（註解／位置保留）→ Python 往返、→ nodejs／java／c 實際編譯執行並與 Python 輸出一致；需 tree-sitter 快取與 javac／gcc', 'renderer/src/ir/ir.test.js'],
    ['核心 IR 抽回設計：簽名／呼叫關係／標準操作用量／副作用／摘要 → UML 模型（過 uml_core 驗證）→ 改設計（改名、加參數、uml_edit 差異）→ 重新產生程式碼；需 tree-sitter 快取', 'renderer/src/ir/ir_design.test.js'],
    ['行為描述（第一層）：行為分析器＋tree-sitter 抽 python／nodejs 的函式行為描述，與中間語言轉出的描述比對；操作目錄反向索引；只靠行為描述產生的骨架可編譯；需 tree-sitter 快取', 'renderer/src/ir/ir_behavior.test.js'],
    ['離線思考堆疊（缺口 C 層框／E 成品檢查／I 路由量測骨架；純程式，用假模型驗骨架）', 'renderer/src/recipe/offline_stack.test.js'],
    ['區塊 ↔ 中間語言 ↔ 目標語言：樣本 → 區塊 → 受控自然語言 → Python → 中間語言 → nodejs／java／c，實跑輸出與原 Python 一致；函式行為卡可從區塊抽出；需 tree-sitter 快取', 'renderer/src/ir/ir_blocks.test.js'],
    ['中間語言橋接進產品（FaIrBundle 嵌入與來源逐字一致、嵌入版橋產生 nodejs 並實跑一致、convert_code 註冊在 coding 領域）', 'renderer/src/ir/ir_wire.test.js'],
    ['「進」與新輸出器接進產品（嵌入版橋：nodejs／java／c 來源→python／perl 實跑一致、→cpp／csharp／ruby 產生、行為卡第二層、/code 路由；需 tree-sitter 文法與 python／perl，沒有就略過）', 'renderer/src/ir/ir_wire2.test.js'],
    ['C++ 補齊的 18 個標準操作（Python→IR→C++→真 g++ 與 Python 逐字一致，含天真對照組；沒有 g++ 就略過）', 'renderer/src/ir/ir_cpp_ops.test.js'],
    ['C++／C#／Perl／Ruby 輸出器實跑（g++ mingw64、dotnet、perl 編譯執行與 Python 逐字一致；ruby 沒環境只做語法檢查；找不到工具就略過該語言）', 'renderer/src/ir/ir_out_more.test.js'],
    ['nodejs／java 的「進」（目錄樣板當樣式做結構比對；Python→IR→nodejs／java→IR→Python 實跑與原輸出一致、註解保存；需 tree-sitter javascript／java 文法與 python，沒有就略過）', 'renderer/src/ir/ir_in_brace.test.js'],
    ['C++／C# 的「進」（Python→IR→C++／C#→IR→Python 實跑與原輸出一致、註解保存；需 tree-sitter cpp／c_sharp 文法與 python，沒有就略過）', 'renderer/src/ir/ir_in_typed.test.js'],
    ['Ruby 的「進」（Python→IR→Ruby→IR→Python 實跑與原輸出一致、註解保存；需 tree-sitter ruby 文法與 python，沒有就略過）', 'renderer/src/ir/ir_in_ruby.test.js'],
    ['Perl 的「進」（自己寫的剖析器、不需文法；Python→IR→Perl→IR→Python 實跑與原輸出一致、註解保存、手寫 Perl 的 local／修飾語句收成原生區塊）', 'renderer/src/ir/ir_in_perl.test.js'],
    ['矩陣 VM 反編譯與狀態機圖種（VM→while／if 結構化中文與 Python，13 個編譯器產物與 VM 在隨機輸入上一致；預設名稱改寫；DFA⇄狀態機 DSL／Mermaid／PlantUML⇄轉移矩陣；需 python）', 'renderer/src/algo/matrix_structure.test.js'],
    ['VM 程式給出區塊（VM→Python→區塊→編回 Python 與 VM 一致；需 tree-sitter 與 python，沒有就略過）', 'renderer/src/algo/matrix_vm_blocks.test.js'],
    ['矩陣轉區塊接進產品（嵌入版 FaMatrixBlocks 與來源一致、管線帶出 matrixForm、嵌入版 DFA 拆區塊並改接受集、matrix_blocks 工具註冊在 coding 領域；需 tree-sitter 與 python）', 'renderer/src/algo/matrix_wire.test.js'],
    ['tree-sitter 文法取得順序與核對（快取→內建 Python→釘住 commit 的分支並核對位元組數與 MD5→jsdelivr；純函式不連網）', 'renderer/src/behavior/ts_assets.test.js'],
    ['判題器 exec 逾時連子孫一起清掉（孫行程脫離管線也不能變孤兒；exec 不能無限等待）', 'judge-runner-kill.test.js'],
    ['AI 面向的 Graph RAG 已移除（領域清單、提示詞、功能清冊）；底層 rag 工具與訓練器／語言探索用的儲存層仍在', 'renderer/src/catalog/rag_removed.test.js'],
    ['/code 指令路由（寫／修／優化／合併／設計／解釋由程式判斷、欄位只從文字抽不編造、缺什麼說什麼；所有工具都註冊在程式設計領域；離線訓練器 code_write 規則）', 'renderer/src/recipe/code_slash.test.js'],
    ['程式優化對照表（13 條慢寫法→優化寫法（含 two-sum 計數題型），含記憶體實測；輸出一致、實測不變慢、不安全不動、沒測資不改）', 'renderer/src/recipe/code_optimize.test.js'],
    ['型別接線矩陣與路徑搜尋（回傳型別推論、具體程度、布林矩陣連乘、前 K 條接線與得分、萬用結構強制轉型）', 'renderer/src/catalog/matrix_core.test.js'],
    ['單元目錄：Python 原型抽取（註解 → 型別、原型 → 單元、真實跑抽取腳本）', 'renderer/src/catalog/extract_py.test.js'],
    ['單元目錄：型別存根轉換（typeshed 風格的 .pyi → 型別表：TypeVar／別名展開、多載合併、版本與平台分支）與存根型別套進單元', 'renderer/src/catalog/stub_to_types.test.js'],
    ['單元目錄：探測執行（輸入產生、結果套回單元、真實跑探測腳本：擋檔案／系統呼叫、SystemExit、非決定性）', 'renderer/src/catalog/probe_core.test.js'],
    ['單元目錄：catalog_onboard 核心（請求驗證與安全關卡、為什麼沒晉升、摘要、持久化與合併、過期判斷、查詢）', 'renderer/src/catalog/onboard_core.test.js'],
    ['單元選擇評測核心（中英文檢索、候選與提示、答案解析、選擇與填參數評分、評測集檢查）', 'renderer/src/catalog/select_core.test.js'],
    ['呼叫格式（IR）與直譯器（靜態檢查、引用與型別、條件與有上限的迴圈、逾時／取消／預算、確認閘、模擬執行、從路徑產生程式）', 'renderer/src/catalog/ir_core.test.js'],
    ['歷史呼叫逆向推論（從實際回傳值反推 JSON 結構、合併樣本、選填欄位、狀態可存檔累積、套進目錄）', 'renderer/src/catalog/shape_core.test.js'],
    ['JavaScript 單元抽取（匯出方式、JSDoc 型別、副作用與呼叫鏈、類別與 prototype、真實 UMD 檔案）', 'renderer/src/catalog/extract_js.test.js'],
    ['能力卡片（長文切片與地圖縮放、事實抽取、多片段投票融合、各種文件種類）', 'renderer/src/catalog/card_core.test.js'],
    ['排名模型訓練（邏輯迴歸、類別不平衡、留一組交叉驗證、特徵、模型排名）', 'renderer/src/catalog/rank_train.test.js'],
    ['MCP（設定檔各家寫法、bundle manifest、專案偵測、JSON-RPC 用戶端、stdio／Streamable HTTP／SSE 傳輸、結果格式）', 'renderer/src/mcp/mcp_core.test.js'],
    ['壓縮檔（檔頭辨識 zip／jar／7z／rar／tar／gzip／bzip2／xz／iso、bzip2 解碼、tar 的 pax／GNU 長檔名、內容判斷、jar 摘要）', 'renderer/src/archive/archive_core.test.js'],
    ['中英互譯的核心（方向判斷、切句、檢查譯文：語言／網址／重複／數字、提示詞、術語、自然語言命令不誤判）', 'renderer/src/tools/translate_core.test.js'],
    ['語音合成的意圖辨識（用英文語音說…、把「…」念出來、tts: …；提問與別的「念／讀」不誤判）', 'renderer/src/tools/tts_intent.test.js'],
    ['「沒有工具」的反思（宣稱偵測、搜尋所有領域的工具、提示文字）', 'renderer/src/tools/cap_reflect.test.js'],
    ['UML 拆解題（真的拆解流程＋假模型：完美、亂答、靠退回重來、連線失敗、空白；評分同義詞與中文關鍵字；建議 self／stepwise／program_first／unknown）', 'renderer/src/uml/uml_bench_core.test.js'],
    ['UML 編修（各種編修、套用後驗證並退回壞的、diff、問題→候選編修、小模型選編號、一批問題解決）', 'renderer/src/uml/uml_edit_core.test.js'],
    ['達成路線（分類、依環境選程式語言、寄信三條路線、手動／自動閘門與副作用一定先問、缺能力→UML 編修）', 'renderer/src/catalog/route_core.test.js'],
    ['技能→食譜編譯器（抽步驟與工具、綁欄位、缺口交給 UML design、資料流）', 'renderer/src/recipe/skill_compile_core.test.js'],
    ['意圖解析（文字切割、語意角色、行為、隱含期待與驗證、缺口問題、UML、測試案例、中英翻譯輔助與媒合）', 'renderer/src/uml/user_intent_core.test.js'],
    ['瀏覽器控制穩定生成（動作檢查、狀態接線、副作用標記、UML 來回、計畫一批、等擴充功能連上、執行驗證重試、整個任務）', 'renderer/src/browser/bcplan_core.test.js'],
    ['資料離線精準查詢（SPDX／工作表：結構、讀問題、計畫、檢查、執行、SQL、放寬與最接近的值、歧義問字母、題庫）', 'renderer/src/dataview/dataquery_core.test.js'],
    ['UML → LLVM IR → wasm32-wasi（IR 解析與型別檢查、wasm 產生、真的執行、運算／迴圈／遞迴／struct／全域／字串、檢查器擋錯、UML 軌跡一致）', 'renderer/src/uml/llvm_core.test.js'],
    ['探索時的反思（錯字：英文編輯距離／中文同音近形字、不認得的字、概念再找、可能是新的需求、整份計畫反思：問使用者／統一走建議／上限）', 'renderer/src/catalog/reflect_core.test.js'],
    ['CoLU 的 ReLU 形式（relu／sat／max2、可達性逐位元等於位元版、ReLU 層疊網路、最佳接線分數等於 findPipelines、矩陣連乘後端一致性檢查）', 'renderer/src/catalog/relu_core.test.js'],
    ['CoLU 接線題（出題、評分、退化偵測、假模型跑整套、建議 self／guided／auto／unknown、使用時的提示）', 'renderer/src/catalog/colu_bench_core.test.js'],
    ['弱模型 harness 迴圈（程式路由、封閉題核對、退回重答、預設退路、判定、命令列續跑；假模型：完美、亂答、沉默、連線失敗）', 'scripts/harness-tests/loop.test.js'],
    ['harness 經驗與回流閘門（去識別、簽名去重、拒絕附原因、上限、migrate、訓練器 pattern、UML 編修問題）', 'scripts/harness-tests/experience.test.js'],
    ['harness 經驗匯入離線訓練器（只收 harness 來源、拒絕含路徑金鑰的、獨立領域預設停用、重複只更新）', 'scripts/harness-tests/host_import.test.js'],
    ['harness skill 可攜（vendor 與來源一致、搬到 repo 外仍能跑迴圈、經驗閘門、離線訓練器乾跑與規則比對、行為分析引擎載入）', 'scripts/harness-tests/portable.test.js'],
    ['harness 共識閘門（中文字面與正規表達式條款、行號、allow 遮罩、必須缺漏、結束碼 0／1／2、--root 與 scope、--json）', 'scripts/harness-tests/consensus.test.js'],
    ['harness 老師端閘門（派工紀錄、提交範圍、共識在提交內容上檢查、驗收指令結束碼、宣稱檢查、原話逐條對照預設否、observe、命令列結束碼）', 'scripts/harness-tests/teacher_gate.test.js'],
    ['harness 速度守則（派工附上守則與上限、報告與新增行的超限等待／逾時／排程警告、警告不改變通過與否、舊派工紀錄相容）', 'skills/weak-model-harness/scripts/teacher_speed.test.js'],
    ['計畫的分歧偵測（沒有分歧不問、分數接近／取捨／勉強合格／找不到、題數上限、套用回答、打字補充撿網址、摘要）', 'renderer/src/catalog/branch_core.test.js'],
    ['採用／退回的回饋累積（壓縮卡片、計畫轉標註、權重、覆蓋規則、轉成訓練資料、可不可以訓練、樣本權重）', 'renderer/src/catalog/feedback_core.test.js'],
    ['缺口驅動探索（缺口、搜尋關鍵字、候選排名、錯誤歸類與換做法、整個迴圈用假主機）', 'renderer/src/catalog/discover_core.test.js'],
    ['單元嵌入檢索（單元文字、向量打包與失效、餘弦排名、排名融合）', 'renderer/src/catalog/embed_core.test.js'],
    ['需求→活動→單元（UML 型別合約、檢索加型別打分、資料流、橋接、型別接線）', 'renderer/src/catalog/bind_core.test.js'],
    ['資料檢視器核心（JSON／YAML／TOML／CSV 解析與轉出、上色、SBOM 轉多工作表、XLSX 讀寫、樹與搜尋）', 'renderer/src/dataview/data_core.test.js'],
    ['SQL 語句切分與完整性判斷', 'renderer/src/sql/sql_split.test.js'],
    ['檔案用途／函式做什麼的說明產生器（FaExplain）', 'renderer/src/explain/code_explain.test.js'],
    ['CI 核心（Gerrit／GitHub／Jenkins 整理、失敗記錄分診 triage）', 'renderer/src/ci/ci_core.test.js'],
    ['Pipeline 解析／lint／本機重現／樣板（Jenkinsfile、GitHub Actions、GitLab CI）', 'renderer/src/ci/pipeline_core.test.js'],
    ['coding_edit 核心（搜尋取代、regex、unified diff 用 git apply 驗證）', 'scripts/coding-edit.test.js'],
    ['coding_edit／coding_patch_tool 整合（真的暫存工作區、git、腳本乾跑與套用）', 'scripts/coding-tools.itest.js'],
    ['CI 連線 HTTP（讀取上限、tail、寫入確認、逾時）', 'scripts/ci-fetch.itest.js'],
    ['行為描述 8 種語言（真的 tree-sitter 文法；離線時略過）', 'renderer/src/behavior/tests/langs.itest.js'],
    ['sqlitebrowser 純函式（過濾語法、DDL 預覽、儲存格、匯出）', 'renderer/src/sql/browser_core.test.js'],
    ['終端機 /mnt 即時 FAP 檔案系統（wasi-sh 契約、快取、寫回、衝突）', 'renderer/src/terminal/fapfs_core.test.js'],
    ['桌面版終端機 /mnt 的同步檔案後端（fsx-sync：真的碰磁碟）', 'scripts/fsx-sync.test.js'],
    ['遠端群組：密碼規則、金鑰推導、加解密、群組（人數上限、名稱不重複、訊息切塊）', 'scripts/remote-tests/rg_core.test.js'],
    ['遠端群組：函式清單（防止新功能插入時蓋掉別組功能）', 'scripts/remote-tests/rg_methods.test.js'],
    ['遠端群組：慢速信箱（Cloudflare KV，用假 KV 測 Worker 與傳輸）', 'scripts/remote-tests/rg_kv.test.js'],
    ['遠端群組：內容傳輸（直連與轉送備援、完整性驗證、未宣告拒絕）', 'scripts/remote-tests/rg_files.test.js'],
    ['遠端編輯器橋接（文件快取、素材往返、允許名單與閘門、取消、by 蓋章）', 'scripts/remote-tests/rg_edit.test.js'],
    ['多人同編核心（主持機排序、副本收斂、衝突略過、各人獨立復原、離線暫存）', 'scripts/remote-tests/rg_session.test.js'],
    ['多人同編訊息層（列表、加入、提出與廣播、by 蓋章、唯讀、各人復原、presence、漏補、離線暫存）', 'scripts/remote-tests/rg_collab.test.js'],
    ['多人同編素材（加入時取齊、參與者新增的圖經主持機轉給大家）', 'scripts/remote-tests/rg_collab_assets.test.js'],
    ['多人同編接手（主持機離線太久由 nodeId 最小的在線者接手、改連、舊主持機回來被通知）', 'scripts/remote-tests/rg_collab_failover.test.js'],
    ['試算表公式求值器（四則、範圍、統計、文字、IF、查找、循環與錯誤）', 'scripts/edit-tests/sheet_formula.test.js'],
    ['表格文件核心（CSV 往返位元組一致、動作、公式參照位移、程式白話、xlsx 讀寫）', 'scripts/edit-tests/sheet_core.test.js'],
    ['Word 文件核心（讀、沒改的區塊原樣輸出、package patching、格式、清單、表格、程式白話）', 'scripts/edit-tests/docx_core.test.js'],
    ['本機檔案綁定核心（開檔、存回、外部修改衝突、讀回驗證、web 控制代碼）', 'scripts/edit-tests/local_file.test.js'],
    ['表格／文字／Word 離線 harness 領域（細切、推導、缺口、工具呼叫→封閉動作）', 'scripts/edit-tests/doc_semantics.test.js'],
    ['遠端共筆 patch 模式（id 定址的 JSON 差異、套用與略過、逐行 diff3）', 'scripts/remote-tests/rg_patch.test.js'],
    ['環境基準線（檔位判斷、政策、OOM 辨識、資源治理：讓位／排隊／跑完卸載／壓力／降級）', 'scripts/env-tests/env_profile.test.js'],
    ['模擬 swap（熱區上限、最久沒用的先寫出、讀回、丟掉）', 'scripts/env-tests/swap.test.js'],
    ['文件類編輯器核心：markdown／純文字（往返位元組一致、區塊解析、封閉動作）', 'scripts/edit-tests/text_core.test.js'],
    ['動畫簡報：格式、驗證、時間軸、渲染（deck_core）', 'scripts/deck-tests/deck_core.test.js'],
    ['動畫簡報：字幕可以跟念的不一樣（caption）、配音失敗／逾時的備援、聲音清單', 'scripts/deck-tests/deck_voice.test.js'],
    ['動畫簡報：動畫物件描述（場景、物件動畫、鏡頭、連動音效、對話泡泡、敘事文字、要點 highlight、疊字幕）', 'scripts/deck-tests/deck_collage.test.js'],
    ['動畫簡報：RPG 式對話場景（程序化地圖／人物／頭像、格子座標走路、A* 繞路、對話框與字幕、聚光、黑幕轉場、使用者素材、CoLU 故事規劃）', 'scripts/deck-tests/deck_rpg.test.js'],
    ['動畫簡報：點陣精靈（去背、縮進畫格、調色盤、外框、物件樣板）', 'scripts/deck-tests/sprite_pixel.test.js'],
    ['動畫簡報：點陣圖物件設計工具（調色盤、字母列、鏡射、繪圖指令、亮暗部、外框、內建範例）', 'scripts/deck-tests/pixel_art.test.js'],
    ['動畫簡報：人物精靈圖（3D 人物零件、z-buffer 光柵、多格共用調色盤、精靈圖打包、三種風格）', 'scripts/deck-tests/sprite_char.test.js'],
    ['動畫簡報：故事／名詞清單→舞台（意象推導＋CoLU：角色與對話、動作與音效、進出場景、名詞清單、封閉問題）', 'scripts/deck-tests/deck_stage.test.js'],
    ['教育文書（學習單）：讀請求、驗證、排版、SVG／HTML／PDF、參考圖片、編輯動作、封閉題', 'scripts/worksheet-tests/worksheet_core.test.js'],
    ['網頁編輯器：描述驗證、預覽內嵌、起手式、編輯動作、後端分流', 'scripts/webedit-tests/webedit_core.test.js'],
    ['SVG／圖片／3D 編輯器共用的物件模型：封閉動作、相對放置、無邊界畫布', 'scripts/edit-tests/edit_objects_core.test.js'],
    ['SVG／圖片編輯器的圖片來源：維基共享資源與 Openverse 的排序、網址、授權', 'scripts/edit-tests/picture_source.test.js'],
    ['SVG 編輯器：形狀與自由 SVG 物件、合成、拆回物件、安全檢查', 'scripts/edit-tests/edit_svg_core.test.js'],
    ['SVG 描圖：量化、輪廓追蹤、簡化、相似度', 'scripts/edit-tests/svg_trace.test.js'],
    ['圖片編輯器：風格濾鏡、修復（補洞／去雜訊／去污點）', 'scripts/edit-tests/pic_fx.test.js'],
    ['圖片編輯器的擴散細化層：裁哪裡、羽化遮罩、色調對齊、蓋回去、借細節、縮放', 'scripts/edit-tests/pic_detail.test.js'],
    ['圖片編輯器：圖層（濾鏡層、修復層）、風格、相對放置、程式先讀的指令', 'scripts/edit-tests/edit_picture_core.test.js'],
    ['3D 場景編輯器：以使用者視角的相對放置、封閉動作、群組、貼皮、YAML 往返、程式先讀的指令', 'scripts/edit-tests/edit3d_core.test.js'],
    ['3D 單一物件編輯（貼皮）：面、位置、顏色、圖、程式先讀的指令', 'scripts/edit-tests/edit3d_part_core.test.js'],
    ['遊戲編輯器：模擬核心（固定步長、碰撞、規則與狀態機、場景切換、對話、戰鬥、確定性重播、現場熱修補）', 'scripts/game-tests/game_sim.test.js'],
    ['遊戲編輯器：封閉動作、相對放置、影響範圍、YAML 往返、脈絡包、程式先讀的指令、範本', 'scripts/game-tests/game_core.test.js'],
    ['遊戲編輯器：畫法、聲音合成、UML、遊戲包 .fagame', 'scripts/game-tests/game_parts.test.js'],
    ['遊戲編輯器：目標原始碼（網頁／Electron／Node.js 由程式產生、AI 逐檔計畫、舊機種適配檢查、測試向量）', 'scripts/game-tests/game_gen.test.js'],
    ['簡報編輯器：簡報檔的物件模型、封閉動作（加頁、改旁白、搬動、隱藏、鎖定、整份替換）、程式先讀的白話、前後版本差異', 'scripts/deck-tests/deck_edit_core.test.js'],
    ['長文章目錄：wiki、新聞、小說章回、分段閱讀', 'scripts/article-tests/article_outline.test.js'],
    ['NVIDIA 線上圖像生成：請求整理、參數夾範圍、回應解析', 'scripts/imagegen-tests/nvidia_image.test.js'],
    ['本機小模型生圖（SDXS-512 GPU／CPU 版）：選版本、取樣的數學、亂數、張量轉圖片、錯誤說明', 'scripts/imagegen-tests/local_sd.test.js'],
    ['sd-turbo 圖生圖改圖：時間點、加噪與還原、遮罩混合、尺寸、強度、選版本', 'scripts/imagegen-tests/sd_turbo.test.js'],
    ['圖像生成分流：形狀圖（SVG／Mermaid 純文字）或擴散模型、提示詞範本（SD／FLUX／SD3）、圖片描述轉欄位', 'scripts/imagegen-tests/image_route.test.js'],
    ['主題簡報食譜（/media-presentation 只給主題）：需求解析、規劃與樣板、旁白驗收、組簡報、修復', 'scripts/deck-tests/deck_topic.test.js'],
    ['/image 的規劃：由上而下細切成單元、樣板退路、依輸入輸出欄位接線成 IR 程式', 'scripts/imagegen-tests/image_plan.test.js'],
    ['文件撰寫器（/user-guide、/design-guide）：掃描與證據、架構比對、範本選擇、組文件、驗證、潤飾驗收、md／wiki／html／pdf／docx 輸出', 'scripts/docgen-tests/docgen.test.js'],
    ['YAML 用途標記（#!fa:deck 這類開頭／結尾宣告）：偵測、檢查、加標記', 'scripts/yamlkind-tests/yamlkind_core.test.js'],
    ['Knowledge Inventory 核心：各格式帶行號的來源、出處、關鍵字＋向量檢索、原句摘要、核對、關聯', 'scripts/knowledge-tests/knowledge_core.test.js'],
    ['Knowledge Inventory 否定與更正：主題「不是／沒有 X」不搜 X、不當證據；反駁上一答案時回頭檢查並重答；提示詞限制', 'scripts/knowledge-tests/knowledge_negation.test.js'],
    ['Knowledge Inventory 物件格式（類 git，未接線）：物件打包、3 向合併、blob／root 伺服器合約', 'scripts/knowledge-tests/knowledge_repo_pack.test.js'],
    ['Knowledge Inventory 物件格式 http 層（假伺服器）', 'scripts/knowledge-tests/knowledge_repo_http.test.js'],
    ['Knowledge Inventory 儲存層（真的 SQLite＋FTS5；沒有 node:sqlite 的 Node 會略過）', 'scripts/knowledge-tests/knowledge_store.test.js'],
    ['動畫簡報：程式碼視窗、patch、問答卡、小工具沙盒、互動視覺的格式規則', 'scripts/deck-tests/deck_interactive.test.js'],
    ['動畫簡報：影片視覺（播放、重播、快轉、速度、A-B 循環的格式規則）', 'scripts/deck-tests/deck_video.test.js'],
    ['動畫簡報：每份簡報自己的外框配色（deck.colors）', 'scripts/deck-tests/deck_colors.test.js'],
    ['動畫簡報：內建可愛插圖（注音與第一個符號核對）', 'scripts/deck-tests/deck_cute.test.js'],
    ['主行程可 live-update 的 IPC 模組（main-ext.js：fa:rawfs:* 九個 handler）', 'scripts/main-tests/main_ext.test.js'],
    ['系統匣縮小時的對話框處理（子視窗取消、原生對話框擋住、顯示視窗帶回）', 'scripts/main-tests/tray_dialog.test.js'],
    ['JSONL 分頁器（一行一筆、cursor、單筆過大分段、壞行保留、窗口按比例）', 'renderer/src/agent/jsonl_pager.test.js'],
    ['網頁內文區塊化（章節索引、區塊、連結、參照文件偏移）', 'renderer/src/agent/web_blocks.test.js'],
    ['思考堆疊（push／pop、焦點標頭與字元上限、wrap、verify 重試、JSONL 往返）', 'renderer/src/recipe/think_stack.test.js'],
    ['模型輸出成 JSONL 並自動續傳（被截斷接著寫、壞行保留、去重、重試、停損）', 'renderer/src/agent/jsonl_stream.test.js'],
    ['超大回應轉 JSONL 的接線（截斷改回第 1 頁、頁頁讀完相等、窗口越小頁越多）', 'scripts/jsonl-paging.test.js'],
    ['本地中文語音：文字轉音素（1379 個音節與 misaki 逐字相同）', 'scripts/tts-tests/zh_g2p.test.js'],
    ['動畫簡報：問答頁把關（標題不洩漏答案、問「這個東西」要有畫面）', 'scripts/deck-tests/deck_quiz_slide.test.js'],
    ['動畫簡報：一頁一種語言的語音（混語檢查、念之前翻成英文或退回中文語音）', 'scripts/deck-tests/deck_language.test.js'],
    ['動畫簡報：小工具範例（打磚塊）真的玩到通關', 'scripts/deck-tests/widget_example.test.js'],
    ['動畫簡報：工具（長文字 handle、圖片目錄、長度估算）', 'scripts/deck-tests/deck_tools.test.js'],
    ['動畫簡報：樣板（預設值、複寫會改變繪製）', 'scripts/deck-tests/deck_template.test.js'],
    ...(() => { try { require.resolve('jszip'); return [['動畫簡報：簡報封包（開啟新舊格式、拒絕不合法）', 'scripts/deck-tests/deck_pack.test.js']]; } catch (_) { console.log('略過 簡報封包測試：沒有安裝 jszip（npm install --no-save jszip）'); return []; } })(),
    // ===== 電腦操作（computer use，桌面版；DESIGN.computer-use.md）：純解析／腳本產生／協定解碼／安全閘門／IPC（假 Electron）／renderer 工具層。真實 X11／VNC／Electron 的整合測試是 *.itest.js，不在這裡（見文件）=====
    ['電腦操作：PNG 編解碼、裁切縮放、差異、格線', 'scripts/computer-tests/png.test.js'],
    ['電腦操作：安全閘門（範圍、被蓋住、拒絕清單、密碼欄、按鍵、速率、中止、預覽）', 'scripts/computer-tests/safety.test.js'],
    ['電腦操作：RFB 編解碼（DES、持續狀態 inflate、ZRLE 磁磚）', 'scripts/computer-tests/rfb_codec.test.js'],
    ['電腦操作：RFB 用戶端（假伺服器：Raw／RRE／Hextile／ZRLE／CopyRect／游標／驗證／輸入／WebSocket／候選物件）', 'scripts/computer-tests/rfb_client.test.js'],
    ['電腦操作：遠端協定探測（RDP／SPICE／NX／SSH／HTTP／RFB）、畫布視窗偵測、WebSocket 用戶端', 'scripts/computer-tests/remote.test.js'],
    ['電腦操作：Windows 後端（PowerShell 腳本產生、C# 編譯檢查、nircmd、UI Automation 轉換；Windows 實跑未實測）', 'scripts/computer-tests/windows.test.js'],
    ['電腦操作：主行程 IPC（假 Electron：原生核准、權限提升、全域中止鍵、機密）', 'scripts/computer-tests/ipc.test.js'],
    ['電腦操作：renderer 核心（詞彙與主行程一致、動作整理、座標換算、視覺答案解析、驗證評分、/computer 指令）', 'scripts/computer-tests/computer_core.test.js'],
    ['電腦操作：視覺慢路徑（切磚、定位、驗證、探索；假視覺模型）', 'scripts/computer-tests/computer_vision.test.js'],
    ['電腦操作：renderer 工具層（19 個 computer_* 工具、/computer 指令、網頁版不註冊）', 'scripts/computer-tests/computer_host.test.js'],
    ['電腦操作：INTEGRATION.md 的貼上用區塊（領域、任務提示 regex、YAML、embed 片段、接線補丁）', 'scripts/computer-tests/integration_doc.test.js'],
    ['圖片轉3D核心（封閉殼、平滑殼、背景差分、全景分層、貼材質）', 'scripts/media-tests/image3d_core.test.js'],
    ['圖片轉3D主機端模擬（只要主體：挑主體、貼圖流程、擺到桌子上）', 'scripts/media-tests/image3d_host.test.js'],
    ['音樂：MIDI 核心（解析、寫出、往返、量化、移調、合併拆分、速度表）', 'scripts/music-tests/midi_core.test.js'],
    ['音樂：播放排程（事件、頻道配置、前瞻排程、靜音獨奏、跳轉、迴圈）', 'scripts/music-tests/midi_play.test.js'],
    ['音樂：MIDI 編輯器純函式層（封閉動作、中文指令、復原重做）', 'scripts/music-tests/midi_edit.test.js'],
    ['音樂：MIDI 遠端共編（共編訊息層、事件層級合併）', 'scripts/music-tests/midi_remote.test.js'],
    ['音樂：作曲的理解需求（假 AI：完美、亂答、部分答對、沉默、逾時、丟錯；使用者說的優先；改成…；說明卡片）', 'scripts/music-tests/compose_plan.test.js'],
    ['音樂：作曲樹（曲式、和聲、聲部、動機逐節點；假模型七種；重做節點、改成…、組裝掃描）', 'scripts/music-tests/compose_tree.test.js'],
    ['音樂：midigenai 橋（假引擎：完美、沒引擎、超出範圍、不合格重生、逾時、出錯、模型壞掉、部分通過）', 'scripts/music-tests/midigen_bridge.test.js'],
    ['音樂：作曲說法的路由（寫貝多芬風格的 MIDI → midi_compose）與成品用卡片交付的規則', 'scripts/music-tests/midi_route.test.js'],
    ['音樂：配樂共用介面（簡報、遊戲、影片剪輯的背景音樂：規格、淡入淡出、循環鋪滿、播放控制）', 'scripts/music-tests/soundtrack.test.js'],
    ['音樂：程式作曲（風格範本、和弦進行、旋律檢查、同種子同曲）', 'scripts/music-tests/music_compose.test.js'],
    ['音樂：音色庫樣本內部 loop 偵測與瘦身規則（週期、無縫 loop、截尾、降取樣）', 'scripts/music-tests/sf_loop.test.js'],
    ['音樂：音訊轉 MIDI 的規則部分（鼓拆解、音高追蹤、速度、量化、樂器標籤、組裝）', 'scripts/music-tests/audio_to_midi.test.js'],
    ['音樂：音訊轉 MIDI 流程（分段、可插拔分軌器與轉譜器、續跑、中斷、誠實報告）', 'scripts/music-tests/audio_pipeline.test.js'],
    ['音樂：Basic Pitch 視窗與音符解碼（真模型輸出固定資料）', 'scripts/music-tests/basic_pitch.test.js'],
    ['音樂：樂器分類（封閉候選清單、GM 對應）', 'scripts/music-tests/instrument_classify.test.js'],
    ['merge diff patcher（unified diff 解析、策略鏈、函式邊界三方合併、合併後語法＋判題驗證與回滾；diff3 對照 git merge-file；需 python／git，沒有就略過該部分）', 'renderer/src/recipe/code_patch.test.js'],
    ['merge diff patcher 第二批（4.2 衝突階梯、亂序片段、語法樹函式單元與 docstring 防護、patch 接進 editCode；需 python，語法樹部分需 renderer/vendor/tree-sitter）', 'renderer/src/recipe/code_patch_repair.test.js'],
    ['merge diff patcher 接進產品（runCode 帶 patch＋剖析器；宿主 merge_patch／_codeAgent 有傳 parser 與 patch）', 'renderer/src/recipe/code_patch_wire.test.js'],
    ['音樂：模型分片下載（續傳、核對、重試）', 'scripts/music-tests/audio_models.test.js'],
];
let failed = 0, failedNew = 0;
const results = [], t00 = Date.now();
// 已知失敗清單（test-reports/known-failures.json：{ "測試檔路徑": "原因與為什麼先不修" }）：列在裡面的失敗標「既有」，不讓入口測試變紅；沒列的失敗是「新增」，一律變紅
let known = {};
try { known = JSON.parse(require('fs').readFileSync(path.join(root, 'test-reports', 'known-failures.json'), 'utf8')); } catch (_) { known = {}; }
// 失敗原因：先找測試自己印的 FAIL／FAILED 行（含後面縮排的說明），再找 stderr 裡的第一個錯誤訊息；都沒有就老實寫「沒有輸出原因」
function reasonOf(r) {
    const out = String(r.stdout || '').split('\n'), err = String(r.stderr || '').split('\n').map((l) => l.replace(/\r$/, ''));
    const lines = [];
    out.forEach((l, i) => { if (/^FAIL|FAILED|failed [1-9]|[1-9][0-9]* failed/.test(l)) { lines.push(l.trim()); for (let k = 1; k <= 2 && out[i + k] && /^\s+\S/.test(out[i + k]); k++) lines.push(out[i + k].trim()); } });
    const e = err.find((l) => /(Error|assert)/i.test(l) && !/^\s+at /.test(l));
    if (e) lines.push('stderr：' + e.trim());
    if (r.status === null) lines.push('被中止（逾時或訊號 ' + (r.signal || '?') + '）');
    else if (r.status !== 0 && !lines.length) lines.push('結束碼 ' + r.status + '，沒有輸出原因');
    return lines.slice(0, 4).join('；').slice(0, 300);
}   // 測試報告：每組的結果、數量、失敗項目、耗時
for (const [name, file] of suites) {
    const t0 = Date.now(), r = spawnSync(process.execPath, [path.join(root, file)], { encoding: 'utf8' });
    const last = String(r.stdout || '').trim().split('\n').pop();
    const ok = r.status === 0 && /(0 failed|[0-9]+ passed)/.test(last) && !/FAILED/.test(last);
    const reason = ok ? '' : reasonOf(r), isKnown = !ok && Object.prototype.hasOwnProperty.call(known, file);
    if (!ok) { failed++; if (!isKnown) failedNew++; }
    console.log((ok ? 'PASS ' : (isKnown ? 'FAIL(既有) ' : 'FAIL(新增) ')) + name + '：' + (ok ? last : reason || last));
    results.push({ name, file, ok, known: isKnown, reason, summary: last, failures: ok ? [] : String(r.stdout || '').split('\n').filter((l) => /^FAIL/.test(l)).map((l) => l.slice(0, 200)), error: ok ? '' : String(r.stderr || '').slice(0, 300), ms: Date.now() - t0 });
    if (!ok) console.log(String(r.stdout || '').split('\n').filter((l) => /^FAIL/.test(l)).join('\n') + String(r.stderr || '').slice(0, 500));
}
// 部位偵測（Python）：有 python 與 numpy／pillow 才跑，沒有就略過並說明
const py = spawnSync('python', ['-c', 'import numpy, PIL'], { encoding: 'utf8' });
if (py.status === 0) {
    const ex = spawnSync(process.execPath, [path.join(root, 'scripts/export-visual-parts.js')], { encoding: 'utf8' });
    const r = spawnSync('python', [path.join(root, 'skills/image-decompose-redraw/tests/test_parts.py')], { encoding: 'utf8' });
    const last = String(r.stdout || '').trim().split('\n').filter(Boolean).pop() || '';
    const ok = ex.status === 0 && r.status === 0 && /0 failed/.test(last);
    if (!ok) failed++;
    console.log((ok ? 'PASS ' : 'FAIL ') + '部位偵測（Python）：' + last);
} else console.log('略過 部位偵測（Python）：沒有 python 或缺 numpy／pillow');
// fa_sqlite（Python 的 sqlite3 相容介面）：用標準函式庫的 sqlite3 假冒引擎來測，有 python 才跑
const pq = spawnSync('python', [path.join(root, 'scripts/test_fa_sqlite.py')], { encoding: 'utf8' });
if (pq.error) console.log('略過 fa_sqlite（Python）：沒有 python');
else { const last = String(pq.stdout || '').trim().split('\n').filter(Boolean).pop() || ''; const ok = pq.status === 0 && /0 failed/.test(last); if (!ok) failed++; console.log((ok ? 'PASS ' : 'FAIL ') + 'fa_sqlite（Python 的 sqlite3 相容介面）：' + last); }
// 報告：test-reports/core-tests-latest.md（人看）與 .json（程式比對）；每次覆寫，歷史靠 git
try {
    const fs = require('fs'), dir = path.join(root, 'test-reports'); fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString(), pass = results.filter((x) => x.ok).length;
    const md = ['# 核心測試報告', '', '產生時間：' + stamp + '　（`node scripts/run-core-tests.js`）', '', '結果：' + pass + ' / ' + results.length + ' 組通過' + (failed ? '，**' + failed + ' 組失敗**' : '，全部通過') + '；總耗時 ' + Math.round((Date.now() - t00) / 1000) + ' 秒（只含這些純函式核心，不含 Electron／瀏覽器的真實環境測試）', '', '| 結果 | 測試組 | 摘要／失敗原因 | 耗時 |', '|---|---|---|---|']
        .concat(results.map((x) => '| ' + (x.ok ? '通過' : (x.known ? '**失敗（既有）**' : '**失敗（新增）**')) + ' | ' + x.name.replace(/\|/g, '/') + ' | ' + (x.ok ? x.summary : (x.reason || x.summary)).replace(/\|/g, '/').slice(0, 160) + ' | ' + (x.ms / 1000).toFixed(1) + ' 秒 |'));
    const bad = results.filter((x) => !x.ok); if (bad.length) { md.push('', '## 失敗項目'); bad.forEach((x) => { md.push('', '### ' + x.name + '（`' + x.file + '`）'); x.failures.slice(0, 20).forEach((l) => md.push('- ' + l)); if (x.error) md.push('- stderr：' + x.error.replace(/\s+/g, ' ')); if (x.reason) md.push('- 原因：' + x.reason); if (x.known) md.push('- 既有失敗：' + known[x.file]); }); }
    fs.writeFileSync(path.join(dir, 'core-tests-latest.md'), md.join('\n') + '\n'); fs.writeFileSync(path.join(dir, 'core-tests-latest.json'), JSON.stringify({ at: stamp, failed, failed_new: failedNew, results }, null, 1));
    console.log('\n測試報告：test-reports/core-tests-latest.md');
} catch (e) { console.log('（測試報告寫不出來：' + e.message + '）'); }
console.log('\n通過 ' + (results.length - failed) + '／' + results.length + ' 組；失敗 ' + failed + '（新增 ' + failedNew + '、既有 ' + (failed - failedNew) + '）' + (failedNew ? '　← 有新增失敗' : ''));
process.exit(failedNew ? 1 : 0);
