# 核心測試報告

產生時間：2026-11-07T17:31:25.931Z　（`node scripts/run-core-tests.js`）

結果：221 / 221 組通過，全部通過；總耗時 465 秒（只含這些純函式核心，不含 Electron／瀏覽器的真實環境測試）

| 結果 | 測試組 | 摘要／失敗原因 | 耗時 |
|---|---|---|---|
| 通過 | 知識引擎（類型、驗證、展開、知識包） | 66 passed, 0 failed [] | 0.1 秒 |
| 通過 | 標註核心（魔術棒、切格、猜字） | 22 passed, 0 failed [] | 0.0 秒 |
| 通過 | 蒙皮核心（骨架、權重、動作） | 17 passed, 0 failed [] | 0.0 秒 |
| 通過 | 名稱表（C++ STL、Rust、Go） | 59 passed, 0 failed [] | 0.0 秒 |
| 通過 | 名稱表（C#、Ruby、Lua；Python、Java、JavaScript 補強） | 94 passed, 0 failed [] | 0.0 秒 |
| 通過 | 圖片處理核心（灰階／強化／減色／模糊／馬賽克／旋轉／縮放／頁面排版） | 31 passed, 0 failed [] | 0.3 秒 |
| 通過 | 文件合併核心（種類判斷、文字解碼、docx／xlsx 簡化轉換、排版） | 7 passed, 0 failed [] | 0.0 秒 |
| 通過 | 依任務文字補專用工具（圖片轉PDF、合併文件成PDF） | 5 passed, 0 failed [] | 0.1 秒 |
| 通過 | 工具預算：短說明、精簡參數、階段切割、檢索 | 9 passed, 0 failed [] | 0.0 秒 |
| 通過 | Agent Model Configure：階段圖、特性估計、自動決定、內建預設、開關不動設定、重置、解析與備援順序、AI 回覆檢查 | PASS Agent Model Configure（階段圖、特性估計、自動決定、內建預設、開關不動設定、重置、解析與備援順序、AI 回覆檢查）：35 passed, 0 failed [] | 0.0 秒 |
| 通過 | 專案索引的定義抽取（C# 方法／屬性／namespace、Kotlin object、Java） | 5 passed, 0 failed [] | 0.1 秒 |
| 通過 | 離線圖像轉文字（模型登記、裝置、快取用量） | 143 passed, 0 failed [] | 0.0 秒 |
| 通過 | 離線小模型食譜（路由、填欄位、驗證、決策紀錄、多步驟引擎） | 94 passed, 0 failed [] | 0.0 秒 |
| 通過 | CoLU+Thinking 階段 2（thinkingPlan 預算、jsonStep 的 thinking 參數與退路） | 49 passed, 0 failed [] | 0.0 秒 |
| 通過 | 離線多步驟計畫（目標、規劃、狀態機、決策樹） | 60 passed, 0 failed [] | 0.0 秒 |
| 通過 | UML → 程式骨架（DSL、驗證、圖、template、情境到 UML） | 80 passed, 0 failed [] | 0.0 秒 |
| 通過 | 程式碼 → tree-sitter → UML（指令層級）→ Python 往返（需 tree-sitter 快取，沒有就略過） | 20 passed, 0 failed | 1.8 秒 |
| 通過 | 程式區塊範本庫（90 個範本：程式↔區塊↔受控自然語言雙向、種子程式往返判題；需 tree-sitter 快取） | 20 passed, 0 failed | 1.9 秒 |
| 通過 | 老師迴圈的客觀驗證核心（check 種類、抽出程式碼、判題器問題形狀） | 4 passed, 0 failed | 0.0 秒 |
| 通過 | 內建的課泛化：沒見過的改寫（換變數名稱、隨機測資）離線自己做對，不認得的算法不亂套（需 tree-sitter 快取） | 17 passed, 0 failed | 2.6 秒 |
| 通過 | uml_design 先讀情境：算法題讀成 UML（0 次模型）→ 骨架 → 區塊 → 沙盒；含沒見過的寫法（需 tree-sitter 快取） | 7 passed, 0 failed | 0.4 秒 |
| 通過 | 範式骨架庫：不給課，範式骨架＋槽位窮舉＋沙盒解出種子題與沒見過的改寫（選項順序反過來也找得到；需 tree-sitter 快取） | 89 passed, 0 failed | 15.9 秒 |
| 通過 | Linux 工具題（cat／grep／xxd／tar／gzip／xz／bmp）：輸入形狀、否決條件、範式（只用 train 題；需 tree-sitter 快取） | Linux 工具範式測試：125 passed, 0 failed | 75.5 秒 |
| 通過 | 位元／位元組／格式化／字串進階積木（G3）：每個積木的往返、反推與 Python 求值（需 tree-sitter 快取） | 位元／位元組／格式化／字串積木：35 passed, 0 failed | 0.8 秒 |
| 通過 | 領域包 DSP：18 題種子（原敘述＋改寫＋選項反序），不給課、0 次模型，float 容差判題，含隱藏大測資（需 tree-sitter 快取） | 72 passed, 0 failed | 17.2 秒 |
| 通過 | 領域包 algo2：矩陣層沒解出的 15 個演算法家族（歐拉函數、完全數、步數、k 進位、直方圖、更暖天數、巢狀展開、最長合法括號、約瑟夫、視窗聚合、區間聯集、配對計數、RLE 解碼、回文子串、巴斯卡）；train 30/30（需 tree-sitter 快取） | 60 passed, 0 failed | 13.6 秒 |
| 通過 | 領域包 os（作業系統模擬）：CPU 排程（非搶先／RR／SRTF）、分頁置換、記憶體配適、磁碟排程；train 全過、holdout 只量測（需 tree-sitter 快取） | 66 passed, 0 failed | 42.9 秒 |
| 通過 | 領域包 ds（資料結構操作序列）：雜湊表、LRU、堆積、BST、Trie、並查集、鏈結串列；train 全過、holdout 只量測（需 tree-sitter 快取） | 48 passed, 0 failed | 18.0 秒 |
| 通過 | 領域包 linuxtext（cut／sort／uniq／wc／head／tail／tr／sed／awk 行為）：train 全過、holdout 只量測（需 tree-sitter 快取） | 56 passed, 0 failed | 64.3 秒 |
| 通過 | 領域包 sync（同步原語事件模擬）：信號量、互斥鎖、條件變數、生產者消費者；train 全過、holdout 只量測（需 tree-sitter 快取） | 32 passed, 0 failed | 11.9 秒 |
| 通過 | 領域包 graph2（進階圖與樹）：最小生成樹、強連通、Bellman-Ford、樹直徑、LCA、二分圖、最大流；train 全過、holdout 只量測（需 tree-sitter 快取） | 26 passed, 0 failed | 9.6 秒 |
| 通過 | 領域包 twofile（Linux 兩段輸入）：cat -n 兩檔、comm／diff、join、paste、cmp；train 全過、holdout 只量測（需 tree-sitter 快取） | 20 passed, 0 failed | 11.6 秒 |
| 通過 | 領域包 fs（檔案系統）：FAT 簇鏈／空閒簇、inode 區塊階層與佔用區塊數；train 全過、holdout 只量測（需 tree-sitter 快取） | 20 passed, 0 failed | 8.4 秒 |
| 通過 | 領域包 linuxsem（Linux 行為語意模擬）：fd 表（open／dup／dup2／close）、管線緩衝、信號遮罩、TCP 狀態機；train 全過、holdout 只量測（需 tree-sitter 快取） | 22 passed, 0 failed | 12.9 秒 |
| 通過 | 領域包 linuxfmt（格式型小工具家族）：樣板變數展開、區塊對齊計數、範式前綴碼；train 全過、holdout 只量測（需 tree-sitter 快取） | 12 passed, 0 failed | 5.8 秒 |
| 通過 | 區塊的庫存與範本規則（三區、型別、終止條件、模組需求；需 tree-sitter 快取） | 9 passed, 0 failed | 0.1 秒 |
| 通過 | UML 遞迴切割寫 body（假模型：補全式逐行、縮排結構、退回重寫、區塊版；需 tree-sitter 快取） | 5 passed, 0 failed | 0.1 秒 |
| 通過 | AST 建樹：隨機建樹與真 tree-sitter 一致、種子程式重放（需 tree-sitter 快取） | 20 passed, 0 failed | 2.0 秒 |
| 通過 | CoLU+Thinking 階段 3（計畫階段接上 thinking：開關、逾時退路、推理不進 messages） | think_plan_uml: 25 passed, 0 failed | 0.0 秒 |
| 通過 | CoLU+Thinking 階段 4（反思：有缺口重做一次、上限、逾時與解析失敗退路、其他模型不變） | 26 passed, 0 failed | 0.1 秒 |
| 通過 | CoLU+Thinking 階段 5（設定開關預設值、推理區塊跳脫 HTML、空推理不顯示、長推理截斷） | colu_think_ui.test: 20 passed, 0 failed | 0.0 秒 |
| 通過 | CoLU+Thinking 階段 7（思考逾時的硬性上限：準時、超時放棄、舊結果丟棄、連續不錯位、沒給 timeoutMs 不變、逾時退路） | 19 passed, 0 failed | 5.1 秒 |
| 通過 | 設計抉擇與 framework 目錄（推薦、片段、rework、專案展開） | 72 passed, 0 failed [] | 0.1 秒 |
| 通過 | 膠水（接到真正的 library、經驗、登記） | 23 passed, 0 failed [] | 0.1 秒 |
| 通過 | 設計檢視器資料（節點樹、UML↔原始碼對應） | 21 passed, 0 failed [] | 0.0 秒 |
| 通過 | 互動對話卡片（規格、驗證、wizard、還原唯讀） | 29 passed, 0 failed [] | 0.0 秒 |
| 通過 | UML 設計引導（卡片流程、套用答案） | 16 passed, 0 failed [] | 0.0 秒 |
| 通過 | 離線日誌格式學習（模板、欄位、摘要、問答、訓練器規則） | 29 passed, 0 failed [] | 0.6 秒 |
| 通過 | 離線設定檔結構學習（INI、TOML、EDK2 INF／DEC／DSC、比較、機密遮蔽） | 44 passed, 0 failed [] | 0.0 秒 |
| 通過 | 文法自己發現（讀→建規則→驗證→再長；YAML、BitBake、nginx、Dockerfile、自創格式） | 46 passed, 0 failed [] | 0.0 秒 |
| 通過 | LALR(1) 表產生器與驅動程式（遞迴文法、衝突處理、優先序、bison 輸出） | 17 passed, 0 failed [] | 0.3 秒 |
| 通過 | 遞迴文法與分析表的學習（讀→找解析不了的地方→換成別的規則／組合／新規則→驗證） | 27 passed, 0 failed [] | 0.1 秒 |
| 通過 | 語法斷點發現（不假設一行一個陳述：找處理不了的邊界→兩兩合併→終結符號→驗證） | 24 passed, 0 failed [] | 0.2 秒 |
| 通過 | 混合內容語法高亮（切段、語言識別、信心度、自學習、逐詞著色） | 35 passed, 0 failed [] | 0.1 秒 |
| 通過 | 英文句子理解（詞類、片語、LALR 子句文法、框架、意圖、混合內容引用） | 26 passed, 0 failed [] | 0.1 秒 |
| 通過 | 意圖推導（受詞／目標型別、簽名比對、離線計畫可行性） | 16 passed, 0 failed [] | 0.1 秒 |
| 通過 | 離線理解閘（動作、目標種類、開啟工具、後置步驟、處理建議） | 49 passed, 0 failed | 0.1 秒 |
| 通過 | 離線理解閘接進執行流程（找主題、站內搜尋、摘要、路由） | 30 passed, 0 failed | 0.1 秒 |
| 通過 | 離線理解閘：理解不了先思考、問使用者並記憶、最後核對 | 27 passed, 0 failed | 0.1 秒 |
| 通過 | 離線理解閘：打開的種類表（MIME 對應）、覆蓋測試、終端機、語意推導命中率 | 70 passed, 0 failed | 0.2 秒 |
| 通過 | 離線理解閘：探索迴圈（目錄→知識庫→小模型→問使用者）與反思換路線 | 22 passed, 0 failed | 0.1 秒 |
| 通過 | 單元目錄核心（已登記工具 → 單元：型別、副作用、可用性、信任等級；型別字串與相容判斷；格式驗證；評量統計） | catalog_core: 82 passed | 0.0 秒 |
| 通過 | 萬物皆矩陣相乘的驗證（半環矩陣、DFA 連乘與掃描、min-plus／布林圖、Berlekamp–Massey 遞推、LALR 表矩陣＋有界堆疊、CYK 布林矩陣、Hankel 秩與從範例學矩陣） | 53 passed, 0 failed [] | 1.0 秒 |
| 通過 | 矩陣＋狀態機＋ReLU 電路＋矩陣 VM 的驗證（暫存器機：費氏／DFA 計數／括號堆疊／gcd／質數／固定 n 排序與二分；直和 vs 乘積；ReLU 閘數；VM 指令集、驗證器、JSONL、編譯對照） | 28 passed, 0 failed [] | 0.4 秒 |
| 通過 | ReLU 網路 → CoLU 決策樹／機器的編譯（精確等價、exact 與 domain 模式、JSONL、區域數 vs 神經元數、域外與浮點的反例、驗證會擋） | 16 passed, 0 failed [] | 0.3 秒 |
| 通過 | 矩陣接不起來的地方的銜接（佇列 BFS、one-hot 記憶體＝矩陣、雙調排序不經意網路、並查集與指標跳躍、有界堆疊＝移位矩陣、種子 20 題最少記憶體） | 11 passed, 0 failed [] | 0.1 秒 |
| 通過 | 矩陣反編譯與可讀性（矩陣→遞推式、one-hot 矩陣→DFA→狀態圖／正規表示式、ReLU 樹→if／else、VM→中文 CNL；結構式 vs 稠密學出的矩陣） | 15 passed, 0 failed [] | 0.1 秒 |
| 通過 | 矩陣層後備（只靠敘述＋2 筆範例合成：L1 線性遞推枚舉＋矩陣冪、L2 自動機家族；形狀不支援／不是線性遞推要明確失敗；範例不足回報 ambiguous） | 17 passed, 0 failed | 3.2 秒 |
| 通過 | 矩陣層 graph／grid 模組（邊表／格子形狀＋L3 半環與走訪範本；heldout2 ≥20/22、heldout3 ≥21/21 回歸，heldout4 ≥14/19、heldout5（L0）verified ≥4/12，範本庫沒有的題型要誠實失敗） | 7 passed, 0 failed | 21.6 秒 |
| 通過 | 矩陣 → code edit（合成程式整理成可編輯版：形態往返、改係數／轉移表行為跟著變、走 Python→UML 路徑 raw=0、改壞時降級；需 tree-sitter 快取） | 7 passed, 0 failed | 0.8 秒 |
| 通過 | 程式優化對照表（12 條慢寫法→優化寫法，含記憶體實測；輸出一致、實測不變慢、不安全不動、沒測資不改） | 12 passed, 0 failed | 13.1 秒 |
| 通過 | 型別接線矩陣與路徑搜尋（回傳型別推論、具體程度、布林矩陣連乘、前 K 條接線與得分、萬用結構強制轉型） | matrix_core: 53 passed | 0.1 秒 |
| 通過 | 單元目錄：Python 原型抽取（註解 → 型別、原型 → 單元、真實跑抽取腳本） | extract_py: 74 passed | 0.1 秒 |
| 通過 | 單元目錄：型別存根轉換（typeshed 風格的 .pyi → 型別表：TypeVar／別名展開、多載合併、版本與平台分支）與存根型別套進單元 | stub_to_types: 33 passed | 0.2 秒 |
| 通過 | 單元目錄：探測執行（輸入產生、結果套回單元、真實跑探測腳本：擋檔案／系統呼叫、SystemExit、非決定性） | probe_core: 59 passed | 0.2 秒 |
| 通過 | 單元目錄：catalog_onboard 核心（請求驗證與安全關卡、為什麼沒晉升、摘要、持久化與合併、過期判斷、查詢） | onboard_core: 53 passed | 0.0 秒 |
| 通過 | 單元選擇評測核心（中英文檢索、候選與提示、答案解析、選擇與填參數評分、評測集檢查） | select_core: 54 passed | 0.0 秒 |
| 通過 | 呼叫格式（IR）與直譯器（靜態檢查、引用與型別、條件與有上限的迴圈、逾時／取消／預算、確認閘、模擬執行、從路徑產生程式） | ir_core: 56 passed | 0.1 秒 |
| 通過 | 歷史呼叫逆向推論（從實際回傳值反推 JSON 結構、合併樣本、選填欄位、狀態可存檔累積、套進目錄） | shape_core: 40 passed | 0.0 秒 |
| 通過 | JavaScript 單元抽取（匯出方式、JSDoc 型別、副作用與呼叫鏈、類別與 prototype、真實 UMD 檔案） | extract_js: 36 passed | 0.1 秒 |
| 通過 | 能力卡片（長文切片與地圖縮放、事實抽取、多片段投票融合、各種文件種類） | card_core: 33 passed | 0.0 秒 |
| 通過 | 排名模型訓練（邏輯迴歸、類別不平衡、留一組交叉驗證、特徵、模型排名） | rank_train: 11 passed | 0.1 秒 |
| 通過 | MCP（設定檔各家寫法、bundle manifest、專案偵測、JSON-RPC 用戶端、stdio／Streamable HTTP／SSE 傳輸、結果格式） | mcp_core: 53 passed | 0.2 秒 |
| 通過 | 壓縮檔（檔頭辨識 zip／jar／7z／rar／tar／gzip／bzip2／xz／iso、bzip2 解碼、tar 的 pax／GNU 長檔名、內容判斷、jar 摘要） | archive_core: 37 passed | 0.1 秒 |
| 通過 | 中英互譯的核心（方向判斷、切句、檢查譯文：語言／網址／重複／數字、提示詞、術語、自然語言命令不誤判） | translate_core: 87 passed | 0.0 秒 |
| 通過 | 語音合成的意圖辨識（用英文語音說…、把「…」念出來、tts: …；提問與別的「念／讀」不誤判） | tts_intent: 48 passed | 0.0 秒 |
| 通過 | 「沒有工具」的反思（宣稱偵測、搜尋所有領域的工具、提示文字） | cap_reflect: 45 passed | 0.0 秒 |
| 通過 | UML 拆解題（真的拆解流程＋假模型：完美、亂答、靠退回重來、連線失敗、空白；評分同義詞與中文關鍵字；建議 self／stepwise／program_first／unknown） | uml_bench_core: 41 passed | 0.0 秒 |
| 通過 | UML 編修（各種編修、套用後驗證並退回壞的、diff、問題→候選編修、小模型選編號、一批問題解決） | uml_edit_core: 54 passed, 0 failed | 0.0 秒 |
| 通過 | 達成路線（分類、依環境選程式語言、寄信三條路線、手動／自動閘門與副作用一定先問、缺能力→UML 編修） | route_core: 41 passed, 0 failed | 0.0 秒 |
| 通過 | 技能→食譜編譯器（抽步驟與工具、綁欄位、缺口交給 UML design、資料流） | PASS 技能→食譜編譯器：48 passed, 0 failed [] | 0.0 秒 |
| 通過 | 意圖解析（文字切割、語意角色、行為、隱含期待與驗證、缺口問題、UML、測試案例、中英翻譯輔助與媒合） | PASS 意圖解析（文字切割、語意角色、行為、隱含期待與驗證、缺口問題、UML、測試案例）：78 passed, 0 failed [] | 0.0 秒 |
| 通過 | 瀏覽器控制穩定生成（動作檢查、狀態接線、副作用標記、UML 來回、計畫一批、等擴充功能連上、執行驗證重試、整個任務） | bcplan_core: 70 passed, 0 failed | 0.0 秒 |
| 通過 | 資料離線精準查詢（SPDX／工作表：結構、讀問題、計畫、檢查、執行、SQL、放寬與最接近的值、歧義問字母、題庫） | dataquery_core: 31 passed, 0 failed | 0.1 秒 |
| 通過 | UML → LLVM IR → wasm32-wasi（IR 解析與型別檢查、wasm 產生、真的執行、運算／迴圈／遞迴／struct／全域／字串、檢查器擋錯、UML 軌跡一致） | llvm_core: 103 passed, 0 failed | 0.1 秒 |
| 通過 | 探索時的反思（錯字：英文編輯距離／中文同音近形字、不認得的字、概念再找、可能是新的需求、整份計畫反思：問使用者／統一走建議／上限） | reflect_core: 40 passed | 0.0 秒 |
| 通過 | CoLU 的 ReLU 形式（relu／sat／max2、可達性逐位元等於位元版、ReLU 層疊網路、最佳接線分數等於 findPipelines、矩陣連乘後端一致性檢查） | relu_core: 20 passed | 0.1 秒 |
| 通過 | CoLU 接線題（出題、評分、退化偵測、假模型跑整套、建議 self／guided／auto／unknown、使用時的提示） | colu_bench_core: 42 passed | 0.0 秒 |
| 通過 | 弱模型 harness 迴圈（程式路由、封閉題核對、退回重答、預設退路、判定、命令列續跑；假模型：完美、亂答、沉默、連線失敗） | 27 passed, 0 failed | 0.0 秒 |
| 通過 | harness 經驗與回流閘門（去識別、簽名去重、拒絕附原因、上限、migrate、訓練器 pattern、UML 編修問題） | 26 passed, 0 failed | 0.1 秒 |
| 通過 | harness 經驗匯入離線訓練器（只收 harness 來源、拒絕含路徑金鑰的、獨立領域預設停用、重複只更新） | 7 passed, 0 failed | 0.0 秒 |
| 通過 | harness skill 可攜（vendor 與來源一致、搬到 repo 外仍能跑迴圈、經驗閘門、離線訓練器乾跑與規則比對、行為分析引擎載入） | 11 passed, 0 failed | 0.2 秒 |
| 通過 | harness 共識閘門（中文字面與正規表達式條款、行號、allow 遮罩、必須缺漏、結束碼 0／1／2、--root 與 scope、--json） | 14 passed, 0 failed | 0.1 秒 |
| 通過 | harness 老師端閘門（派工紀錄、提交範圍、共識在提交內容上檢查、驗收指令結束碼、宣稱檢查、原話逐條對照預設否、observe、命令列結束碼） | 27 passed, 0 failed | 0.4 秒 |
| 通過 | harness 速度守則（派工附上守則與上限、報告與新增行的超限等待／逾時／排程警告、警告不改變通過與否、舊派工紀錄相容） | 13 passed, 0 failed | 0.1 秒 |
| 通過 | 計畫的分歧偵測（沒有分歧不問、分數接近／取捨／勉強合格／找不到、題數上限、套用回答、打字補充撿網址、摘要） | branch_core: 40 passed | 0.0 秒 |
| 通過 | 採用／退回的回饋累積（壓縮卡片、計畫轉標註、權重、覆蓋規則、轉成訓練資料、可不可以訓練、樣本權重） | feedback_core: 22 passed | 0.1 秒 |
| 通過 | 缺口驅動探索（缺口、搜尋關鍵字、候選排名、錯誤歸類與換做法、整個迴圈用假主機） | discover_core: 50 passed | 0.0 秒 |
| 通過 | 單元嵌入檢索（單元文字、向量打包與失效、餘弦排名、排名融合） | embed_core: 24 passed | 0.0 秒 |
| 通過 | 需求→活動→單元（UML 型別合約、檢索加型別打分、資料流、橋接、型別接線） | bind_core: 38 passed | 0.1 秒 |
| 通過 | 資料檢視器核心（JSON／YAML／TOML／CSV 解析與轉出、上色、SBOM 轉多工作表、XLSX 讀寫、樹與搜尋） | data_core: 60 passed | 0.0 秒 |
| 通過 | SQL 語句切分與完整性判斷 | 14 passed, 0 failed [] | 0.0 秒 |
| 通過 | 檔案用途／函式做什麼的說明產生器（FaExplain） | 16 passed, 0 failed [] | 0.0 秒 |
| 通過 | CI 核心（Gerrit／GitHub／Jenkins 整理、失敗記錄分診 triage） | 21 passed, 0 failed [] | 0.6 秒 |
| 通過 | Pipeline 解析／lint／本機重現／樣板（Jenkinsfile、GitHub Actions、GitLab CI） | 13 passed, 0 failed [] | 0.0 秒 |
| 通過 | coding_edit 核心（搜尋取代、regex、unified diff 用 git apply 驗證） | 12 passed, 0 failed [] | 1.1 秒 |
| 通過 | coding_edit／coding_patch_tool 整合（真的暫存工作區、git、腳本乾跑與套用） | 14 passed, 0 failed [] | 5.3 秒 |
| 通過 | CI 連線 HTTP（讀取上限、tail、寫入確認、逾時） | 7 passed, 0 failed [] | 2.1 秒 |
| 通過 | 行為描述 8 種語言（真的 tree-sitter 文法；離線時略過） | 263 passed, 0 failed [] | 0.9 秒 |
| 通過 | sqlitebrowser 純函式（過濾語法、DDL 預覽、儲存格、匯出） | 9 passed, 0 failed [] | 0.0 秒 |
| 通過 | 終端機 /mnt 即時 FAP 檔案系統（wasi-sh 契約、快取、寫回、衝突） | 15 passed, 0 failed [] | 0.2 秒 |
| 通過 | 桌面版終端機 /mnt 的同步檔案後端（fsx-sync：真的碰磁碟） | 6 passed, 0 failed [] | 0.0 秒 |
| 通過 | 遠端群組：密碼規則、金鑰推導、加解密、群組（人數上限、名稱不重複、訊息切塊） | rg_core: 34 passed | 1.6 秒 |
| 通過 | 遠端群組：函式清單（防止新功能插入時蓋掉別組功能） | rg_methods: 102 passed | 0.0 秒 |
| 通過 | 遠端群組：慢速信箱（Cloudflare KV，用假 KV 測 Worker 與傳輸） | rg_kv: 20 passed | 10.4 秒 |
| 通過 | 遠端群組：內容傳輸（直連與轉送備援、完整性驗證、未宣告拒絕） | rg_files: 10 passed | 0.4 秒 |
| 通過 | 遠端編輯器橋接（文件快取、素材往返、允許名單與閘門、取消、by 蓋章） | rg_edit: 32 passed | 1.5 秒 |
| 通過 | 多人同編核心（主持機排序、副本收斂、衝突略過、各人獨立復原、離線暫存） | rg_session: 27 passed, 0 failed | 0.0 秒 |
| 通過 | 多人同編訊息層（列表、加入、提出與廣播、by 蓋章、唯讀、各人復原、presence、漏補、離線暫存） | rg_collab: 26 passed, 0 failed | 2.9 秒 |
| 通過 | 多人同編素材（加入時取齊、參與者新增的圖經主持機轉給大家） | rg_collab_assets: 7 passed, 0 failed | 1.8 秒 |
| 通過 | 多人同編接手（主持機離線太久由 nodeId 最小的在線者接手、改連、舊主持機回來被通知） | rg_collab_failover: 11 passed, 0 failed | 4.9 秒 |
| 通過 | 試算表公式求值器（四則、範圍、統計、文字、IF、查找、循環與錯誤） | sheet_formula: 22 passed, 0 failed | 0.0 秒 |
| 通過 | 表格文件核心（CSV 往返位元組一致、動作、公式參照位移、程式白話、xlsx 讀寫） | sheet_core: 60 passed, 0 failed | 0.1 秒 |
| 通過 | Word 文件核心（讀、沒改的區塊原樣輸出、package patching、格式、清單、表格、程式白話） | docx_core: 46 passed, 0 failed | 0.1 秒 |
| 通過 | 本機檔案綁定核心（開檔、存回、外部修改衝突、讀回驗證、web 控制代碼） | local_file: 25 passed, 0 failed | 0.0 秒 |
| 通過 | 表格／文字／Word 離線 harness 領域（細切、推導、缺口、工具呼叫→封閉動作） | doc_semantics: 52 passed, 0 failed | 0.0 秒 |
| 通過 | 遠端共筆 patch 模式（id 定址的 JSON 差異、套用與略過、逐行 diff3） | rg_patch: 21 passed | 0.0 秒 |
| 通過 | 環境基準線（檔位判斷、政策、OOM 辨識、資源治理：讓位／排隊／跑完卸載／壓力／降級） | env_profile: 36 passed | 0.6 秒 |
| 通過 | 模擬 swap（熱區上限、最久沒用的先寫出、讀回、丟掉） | swap: 12 passed | 0.0 秒 |
| 通過 | 文件類編輯器核心：markdown／純文字（往返位元組一致、區塊解析、封閉動作） | text_core: 61 passed | 0.0 秒 |
| 通過 | 動畫簡報：格式、驗證、時間軸、渲染（deck_core） | deck_core: 82 passed, 0 failed | 0.1 秒 |
| 通過 | 動畫簡報：字幕可以跟念的不一樣（caption）、配音失敗／逾時的備援、聲音清單 | PASS 簡報字幕與配音備援：28 passed, 0 failed [] | 0.0 秒 |
| 通過 | 動畫簡報：動畫物件描述（場景、物件動畫、鏡頭、連動音效、對話泡泡、敘事文字、要點 highlight、疊字幕） | PASS 動畫物件描述（場景、物件動畫、鏡頭、連動音效、對話泡泡、敘事文字、要點 highlight、疊字幕）：52 passed, 0 failed [] | 0.1 秒 |
| 通過 | 動畫簡報：RPG 式對話場景（程序化地圖／人物／頭像、格子座標走路、A* 繞路、對話框與字幕、聚光、黑幕轉場、使用者素材、CoLU 故事規劃） | 93 passed, 0 failed | 0.1 秒 |
| 通過 | 動畫簡報：點陣精靈（去背、縮進畫格、調色盤、外框、物件樣板） | 36 passed, 0 failed | 0.1 秒 |
| 通過 | 動畫簡報：點陣圖物件設計工具（調色盤、字母列、鏡射、繪圖指令、亮暗部、外框、內建範例） | 28 passed, 0 failed | 0.0 秒 |
| 通過 | 動畫簡報：人物精靈圖（3D 人物零件、z-buffer 光柵、多格共用調色盤、精靈圖打包、三種風格） | 39 passed, 0 failed | 0.4 秒 |
| 通過 | 動畫簡報：故事／名詞清單→舞台（意象推導＋CoLU：角色與對話、動作與音效、進出場景、名詞清單、封閉問題） | PASS 故事→舞台（意象推導＋CoLU：角色與對話、動作與音效、進出場景、名詞清單、封閉問題）：39 passed, 0 failed [] | 0.1 秒 |
| 通過 | 教育文書（學習單）：讀請求、驗證、排版、SVG／HTML／PDF、參考圖片、編輯動作、封閉題 | PASS 教育文書（學習單）：讀請求、驗證、排版、SVG／HTML／PDF、參考圖片、編輯動作、封閉題：90 passed, 0 failed [] | 0.0 秒 |
| 通過 | 網頁編輯器：描述驗證、預覽內嵌、起手式、編輯動作、後端分流 | PASS 網頁編輯器核心（描述驗證、預覽內嵌、起手式、編輯動作、讀指令與分流、後端任務、摘要 prompt）：30 passed, 0 failed [] | 0.0 秒 |
| 通過 | SVG／圖片／3D 編輯器共用的物件模型：封閉動作、相對放置、無邊界畫布 | edit_objects_core: 46 passed | 0.0 秒 |
| 通過 | SVG／圖片編輯器的圖片來源：維基共享資源與 Openverse 的排序、網址、授權 | picture_source: 14 passed | 0.0 秒 |
| 通過 | SVG 編輯器：形狀與自由 SVG 物件、合成、拆回物件、安全檢查 | edit_svg_core: 23 passed | 0.0 秒 |
| 通過 | SVG 描圖：量化、輪廓追蹤、簡化、相似度 | svg_trace: 11 passed | 0.1 秒 |
| 通過 | 圖片編輯器：風格濾鏡、修復（補洞／去雜訊／去污點） | pic_fx: 28 passed | 0.1 秒 |
| 通過 | 圖片編輯器的擴散細化層：裁哪裡、羽化遮罩、色調對齊、蓋回去、借細節、縮放 | 27 passed, 0 failed | 0.0 秒 |
| 通過 | 圖片編輯器：圖層（濾鏡層、修復層）、風格、相對放置、程式先讀的指令 | edit_picture_core: 37 passed | 0.0 秒 |
| 通過 | 3D 場景編輯器：以使用者視角的相對放置、封閉動作、群組、貼皮、YAML 往返、程式先讀的指令 | edit3d_core: 59 passed | 0.1 秒 |
| 通過 | 3D 單一物件編輯（貼皮）：面、位置、顏色、圖、程式先讀的指令 | edit3d_part_core: 19 passed | 0.0 秒 |
| 通過 | 遊戲編輯器：模擬核心（固定步長、碰撞、規則與狀態機、場景切換、對話、戰鬥、確定性重播、現場熱修補） | game_sim: 42 passed | 0.1 秒 |
| 通過 | 遊戲編輯器：封閉動作、相對放置、影響範圍、YAML 往返、脈絡包、程式先讀的指令、範本 | game_core: 44 passed | 0.1 秒 |
| 通過 | 遊戲編輯器：畫法、聲音合成、UML、遊戲包 .fagame | game_parts: 23 passed | 0.2 秒 |
| 通過 | 遊戲編輯器：目標原始碼（網頁／Electron／Node.js 由程式產生、AI 逐檔計畫、舊機種適配檢查、測試向量） | game_gen: 31 passed | 0.2 秒 |
| 通過 | 簡報編輯器：簡報檔的物件模型、封閉動作（加頁、改旁白、搬動、隱藏、鎖定、整份替換）、程式先讀的白話、前後版本差異 | deck_edit_core: 44 passed | 0.0 秒 |
| 通過 | 長文章目錄：wiki、新聞、小說章回、分段閱讀 | article_outline: 20 passed | 0.0 秒 |
| 通過 | NVIDIA 線上圖像生成：請求整理、參數夾範圍、回應解析 | nvidia_image: 18 passed | 0.0 秒 |
| 通過 | 本機小模型生圖（SDXS-512 GPU／CPU 版）：選版本、取樣的數學、亂數、張量轉圖片、錯誤說明 | local_sd: 33 passed | 0.0 秒 |
| 通過 | sd-turbo 圖生圖改圖：時間點、加噪與還原、遮罩混合、尺寸、強度、選版本 | sd_turbo: 25 passed | 0.0 秒 |
| 通過 | 圖像生成分流：形狀圖（SVG／Mermaid 純文字）或擴散模型、提示詞範本（SD／FLUX／SD3）、圖片描述轉欄位 | image_route: 80 passed | 0.0 秒 |
| 通過 | 主題簡報食譜（/media-presentation 只給主題）：需求解析、規劃與樣板、旁白驗收、組簡報、修復 | deck_topic: 27 passed | 0.0 秒 |
| 通過 | /image 的規劃：由上而下細切成單元、樣板退路、依輸入輸出欄位接線成 IR 程式 | image_plan: 17 passed | 0.0 秒 |
| 通過 | 文件撰寫器（/user-guide、/design-guide）：掃描與證據、架構比對、範本選擇、組文件、驗證、潤飾驗收、md／wiki／html／pdf／docx 輸出 | docgen: 47 passed | 0.0 秒 |
| 通過 | YAML 用途標記（#!fa:deck 這類開頭／結尾宣告）：偵測、檢查、加標記 | yamlkind_core: 30 passed | 0.0 秒 |
| 通過 | Knowledge Inventory 核心：各格式帶行號的來源、出處、關鍵字＋向量檢索、原句摘要、核對、關聯 | knowledge_core: 55 passed | 0.0 秒 |
| 通過 | Knowledge Inventory 儲存層（真的 SQLite＋FTS5；沒有 node:sqlite 的 Node 會略過） | knowledge_store: skipped（沒有 node:sqlite，要 Node 22.5 以上才會跑）0 failed | 0.0 秒 |
| 通過 | 動畫簡報：程式碼視窗、patch、問答卡、小工具沙盒、互動視覺的格式規則 | 97 passed | 0.1 秒 |
| 通過 | 動畫簡報：影片視覺（播放、重播、快轉、速度、A-B 循環的格式規則） | 20 passed | 0.0 秒 |
| 通過 | 動畫簡報：每份簡報自己的外框配色（deck.colors） | deck_colors: 8 passed | 0.0 秒 |
| 通過 | 動畫簡報：內建可愛插圖（注音與第一個符號核對） | deck_cute: 43 passed | 0.0 秒 |
| 通過 | 主行程可 live-update 的 IPC 模組（main-ext.js：fa:rawfs:* 九個 handler） | main_ext: 24 passed | 0.0 秒 |
| 通過 | 系統匣縮小時的對話框處理（子視窗取消、原生對話框擋住、顯示視窗帶回） | 7 passed, 0 failed | 0.1 秒 |
| 通過 | JSONL 分頁器（一行一筆、cursor、單筆過大分段、壞行保留、窗口按比例） | 23 passed, 0 failed | 0.1 秒 |
| 通過 | 網頁內文區塊化（章節索引、區塊、連結、參照文件偏移） | web_blocks: 27 passed | 0.0 秒 |
| 通過 | 思考堆疊（push／pop、焦點標頭與字元上限、wrap、verify 重試、JSONL 往返） | 7 passed, 0 failed | 0.0 秒 |
| 通過 | 模型輸出成 JSONL 並自動續傳（被截斷接著寫、壞行保留、去重、重試、停損） | 12 passed, 0 failed | 0.1 秒 |
| 通過 | 超大回應轉 JSONL 的接線（截斷改回第 1 頁、頁頁讀完相等、窗口越小頁越多） | 14 passed, 0 failed | 10.3 秒 |
| 通過 | 本地中文語音：文字轉音素（1379 個音節與 misaki 逐字相同） | zh_g2p: 13 passed | 0.0 秒 |
| 通過 | 動畫簡報：問答頁把關（標題不洩漏答案、問「這個東西」要有畫面） | deck_quiz_slide: 5 passed | 0.0 秒 |
| 通過 | 動畫簡報：一頁一種語言的語音（混語檢查、念之前翻成英文或退回中文語音） | 19 passed | 0.0 秒 |
| 通過 | 動畫簡報：小工具範例（打磚塊）真的玩到通關 | widget_example: 6 passed | 0.0 秒 |
| 通過 | 動畫簡報：工具（長文字 handle、圖片目錄、長度估算） | deck_tools: 31 passed | 0.0 秒 |
| 通過 | 動畫簡報：樣板（預設值、複寫會改變繪製） | deck_template: 18 passed | 0.0 秒 |
| 通過 | 電腦操作：PNG 編解碼、裁切縮放、差異、格線 | computer-png: 15 passed, 0 failed | 0.0 秒 |
| 通過 | 電腦操作：安全閘門（範圍、被蓋住、拒絕清單、密碼欄、按鍵、速率、中止、預覽） | computer-use-safety: 69 passed, 0 failed | 0.0 秒 |
| 通過 | 電腦操作：RFB 編解碼（DES、持續狀態 inflate、ZRLE 磁磚） | rfb-codec: 13 passed, 0 failed | 0.0 秒 |
| 通過 | 電腦操作：RFB 用戶端（假伺服器：Raw／RRE／Hextile／ZRLE／CopyRect／游標／驗證／輸入／WebSocket／候選物件） | rfb-client: 23 passed, 0 failed | 1.5 秒 |
| 通過 | 電腦操作：遠端協定探測（RDP／SPICE／NX／SSH／HTTP／RFB）、畫布視窗偵測、WebSocket 用戶端 | computer-remote: 46 passed, 0 failed | 9.0 秒 |
| 通過 | 電腦操作：Windows 後端（PowerShell 腳本產生、C# 編譯檢查、nircmd、UI Automation 轉換；Windows 實跑未實測） | computer-use-windows: 38 passed, 0 failed | 0.3 秒 |
| 通過 | 電腦操作：主行程 IPC（假 Electron：原生核准、權限提升、全域中止鍵、機密） | computer-use-ipc: 40 passed, 0 failed | 4.3 秒 |
| 通過 | 電腦操作：renderer 核心（詞彙與主行程一致、動作整理、座標換算、視覺答案解析、驗證評分、/computer 指令） | computer_core: 40 passed, 0 failed | 0.0 秒 |
| 通過 | 電腦操作：視覺慢路徑（切磚、定位、驗證、探索；假視覺模型） | computer_vision: 17 passed, 0 failed | 0.0 秒 |
| 通過 | 電腦操作：renderer 工具層（19 個 computer_* 工具、/computer 指令、網頁版不註冊） | computer_host: 47 passed, 0 failed | 0.0 秒 |
| 通過 | 電腦操作：INTEGRATION.md 的貼上用區塊（領域、任務提示 regex、YAML、embed 片段、接線補丁） | integration_doc: 36 passed, 0 failed | 0.1 秒 |
| 通過 | 圖片轉3D核心（封閉殼、平滑殼、背景差分、全景分層、貼材質） | 65 passed | 5.5 秒 |
| 通過 | 圖片轉3D主機端模擬（只要主體：挑主體、貼圖流程、擺到桌子上） | 14 passed | 0.1 秒 |
| 通過 | 音樂：MIDI 核心（解析、寫出、往返、量化、移調、合併拆分、速度表） | 29 passed, 0 failed | 0.1 秒 |
| 通過 | 音樂：播放排程（事件、頻道配置、前瞻排程、靜音獨奏、跳轉、迴圈） | 64 passed, 0 failed | 0.0 秒 |
| 通過 | 音樂：MIDI 編輯器純函式層（封閉動作、中文指令、復原重做） | 29 passed, 0 failed | 0.0 秒 |
| 通過 | 音樂：MIDI 遠端共編（共編訊息層、事件層級合併） | 4 passed, 0 failed | 0.7 秒 |
| 通過 | 音樂：作曲的理解需求（假 AI：完美、亂答、部分答對、沉默、逾時、丟錯；使用者說的優先；改成…；說明卡片） | 55 passed, 0 failed | 9.3 秒 |
| 通過 | 音樂：作曲樹（曲式、和聲、聲部、動機逐節點；假模型七種；重做節點、改成…、組裝掃描） | 96 passed, 0 failed | 7.3 秒 |
| 通過 | 音樂：midigenai 橋（假引擎：完美、沒引擎、超出範圍、不合格重生、逾時、出錯、模型壞掉、部分通過） | 56 passed, 0 failed | 0.3 秒 |
| 通過 | 音樂：作曲說法的路由（寫貝多芬風格的 MIDI → midi_compose）與成品用卡片交付的規則 | 36 passed, 0 failed | 0.1 秒 |
| 通過 | 音樂：配樂共用介面（簡報、遊戲、影片剪輯的背景音樂：規格、淡入淡出、循環鋪滿、播放控制） | 14 passed, 0 failed | 0.0 秒 |
| 通過 | 音樂：程式作曲（風格範本、和弦進行、旋律檢查、同種子同曲） | 49 passed, 0 failed | 0.5 秒 |
| 通過 | 音樂：音色庫樣本內部 loop 偵測與瘦身規則（週期、無縫 loop、截尾、降取樣） | 13 passed, 0 failed | 0.1 秒 |
| 通過 | 音樂：音訊轉 MIDI 的規則部分（鼓拆解、音高追蹤、速度、量化、樂器標籤、組裝） | 12 passed, 0 failed | 0.2 秒 |
| 通過 | 音樂：音訊轉 MIDI 流程（分段、可插拔分軌器與轉譜器、續跑、中斷、誠實報告） | 12 passed, 0 failed | 4.3 秒 |
| 通過 | 音樂：Basic Pitch 視窗與音符解碼（真模型輸出固定資料） | 5 passed, 0 failed | 0.0 秒 |
| 通過 | 音樂：樂器分類（封閉候選清單、GM 對應） | 7 passed, 0 failed | 0.0 秒 |
| 通過 | 音樂：模型分片下載（續傳、核對、重試） | 15 passed, 0 failed | 0.2 秒 |
