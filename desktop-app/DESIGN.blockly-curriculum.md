# Blockly 教學範本總表（blockly-teach 主線，2026-11-07 起）

使用者原話（2026-11-07，經協調 session 轉述）：「我們這邊就認真擴充blockly-teach, 涵蓋演算法、資料結構、作業系統、真實linux programming，等各種領域作為範本，把教學範本補齊」；「矩陣補齊我想要交給其他session，例如stevenyc.huang」；「甚至下週也可以繼續補齊，所以這邊盡量安排成有多少做多少，補好的就commit/deploy」。
本表是**進度欄**：每提交一批就更新「狀態」與「提交」。矩陣層（`renderer/src/algo/`）不在本表範圍，不要動。

## 0. 機制（接手者先讀）

- 範式＝帶槽位的區塊骨架（`renderer/src/uml/py_paradigms_core.js`），槽位由沙盒窮舉；讀取器 `algo_intent_core.js` 把敘述讀成意圖（`inputs`／`facts`／`algo`／`algos`）。領域包格式見 `domain_registry_core.js`、`domain_dsp_core.js`（`algos`＋`paradigms`＋`skeletons`＋`seeds`）。
- **現況**：通用算法（階段 1，`GEN` 區塊 42 個骨架）與 Linux 工具（階段 2，`LX`～`LX6` 約 45 個骨架＋`TOOLS`／`TOOL_FAMILIES`）都直接寫在 `py_paradigms_core.js`／`algo_intent_core.js` 裡。**待辦**：把 Linux 工具搬成獨立領域包 `renderer/src/uml/domain_linux_core.js`（需把 `addAlgos` 擴充成可帶 `shape`／工具型條目），新領域（資料結構、作業系統）一律各一個獨立檔，才能多 session 並行不互踩；新檔要在 `scripts/embed-code-ui.js` 的 `embedUml()` 清單與 `renderer/src/floating-assistant.js` 加 BEGIN/END 標記，並在 `domain_registry_core.js` 的使用處註冊。
- 每個領域包：train 題（可教）＋holdout 題（只量測，**絕不拿來教課／範式／讀取器規則**）；每批回報 train／holdout 各解出幾題；測試不給課、0 次模型、原敘述＋換名稱＋選項反序。
- 量測：`FA_TS_DIR=/tmp/fa-ts-cache node scripts/eval/bench_coverage.js --files <題庫>.jsonl --mode A --json out.json`；`python3 scripts/eval/split_report.py out.json <題庫>.jsonl` 分 train／holdout。

## 1. 總表（領域 → 子領域 → 範式／課／積木）

狀態：✔已有、◐部分、✗缺。優先序 P0（最先）～P3。「提交」欄填 hash。

### A. 演算法（競賽式整數／清單題）
| 子領域 | 狀態 | 範式／內容 | 提交 |
|---|---|---|---|
| 公式、遞推、矩陣快速冪、數論（gcd、質數、模冪、因數…） | ✔ | `GEN` 區塊＋原 27 個（階段 1） | 49f2547f |
| DP（背包、LIS、LCS、LPS、硬幣、格子路徑、湊零錢） | ✔ | `dp.*` | 49f2547f |
| 圖（BFS／DFS／並查集／Dijkstra／拓撲／可達／k 步路徑） | ✔ | `bfs.*`、`dfs.*`、`graph.*` | 49f2547f |
| 排序／二分／前綴和／雙指標／單調堆疊／區間合併 | ✔ | | 49f2547f |
| 字串（KMP、迴文、字串自動機、RLE、凱薩、羅馬） | ✔ | | 49f2547f |
| 樹（走訪）、線段樹／樹狀陣列 | ◐ | 走訪✔、樹狀陣列✔；線段樹區間更新✗；LCA、樹 DP✗ | P2 |
| 進階圖（最小生成樹、強連通、最短路 Bellman-Ford／Floyd、二分圖匹配、網路流） | ✔ | `domain_graph2_core.js`：Kruskal、Kosaraju、Bellman-Ford、樹直徑、LCA、二分圖判定、最大流；`domain_graph3_core.js`（2026-11-10）：Floyd 全點對（查詢／總和／直徑／可達對數／矩陣）、二分圖最大匹配（匹配數／完美／未配對數／最大獨立集，BFS 找增廣路）、指派問題（匈牙利，最小／最大）、最短路變體（路徑還原字典序最小／最少邊數、最短路條數／是否唯一、第 k 短（可重複走訪／簡單路徑）、限制邊數（至多／恰好）；graph3 train 33/33（選項反序也過）。誠實註記：Hopcroft-Karp 沒做（用 BFS 增廣，結果相同、複雜度較高）；第 k 短的簡單路徑版是枚舉，只適合小圖 | 本批 |
| 計算幾何、博弈、位元 DP、數論進階（CRT、Miller-Rabin） | ✗ | | P3 |
| 讀取器未涵蓋的 holdout 失敗（b-seq-given、roman-rev、vowel-count） | ✗ | 見 DESIGN.blockly-gap.md §4 | P2 |

### B. 資料結構（實作型：給操作序列，輸出結果）
| 子領域 | 狀態 | 範式／內容 | 提交 |
|---|---|---|---|
| 堆疊／佇列／雙端佇列指令模擬 | ✔ | `seq.cmd-sim` | 49f2547f |
| 堆積（優先佇列）操作序列、第 k 小 | ✔ | 第 k 小✔；操作序列（最小／最大堆）✔ | 97231841 |
| 雜湊表（開放定址、鏈結）、LRU 快取 | ◐ | 開放定址✔、LRU✔（`domain_ds_core.js`）；鏈結法✗ | 97231841 |
| 鏈結串列（插入／刪除／反轉／環偵測）、環狀佇列 | ◐ | 操作序列✔；環偵測、環狀佇列✗ | 97231841 |
| 二元搜尋樹（插入／刪除／走訪／高度）、AVL／旋轉 | ◐ | 插入＋走訪／高度／葉數✔；刪除、AVL✗ | 97231841 |
| Trie、並查集（路徑壓縮／按秩）、區間樹 | ◐ | 並查集✔（含操作序列）、Trie✔；區間樹✗ | 97231841 |
| 稀疏表、單調佇列、跳躍表 | ◐ | 稀疏表（min／max／gcd、位置起點、右端含不含、層數／格數）✔、跳躍表（固定層數序列的 insert／delete／search，輸出是否找到／右走步數／比較次數／總步數／各層內容）✔、AVL（插入旋轉，輸出中序／前序／樹高／根／旋轉次數／葉數）✔（`domain_ds_core.js`）；單調佇列✗ | 本批 |

### C. 作業系統（模擬型：輸入工作／請求，輸出排程或結果）
| 子領域 | 狀態 | 範式／內容 | 提交 |
|---|---|---|---|
| CPU 排程：FCFS／SJF／SRTF／優先權／RR／MLFQ（平均等待、週轉、甘特圖） | ◐ | `os.sched-np／rr／srtf`✔；MLFQ、甘特圖✗ | 97231841 |
| 記憶體：首次／最佳／最差配適、夥伴系統、分頁表位址轉換 | ◐ | 配適✔；分頁位址轉換✔（`os.page-translate`：輸出實體位址／框編號／位移，頁不在記憶體印標籤或 -1；train 3/3、holdout 1/1，但這題 holdout 的句型我診斷時看過，已不獨立）；夥伴系統✗ | 97231841、本批 |
| 分頁置換：FIFO／LRU／OPT／Clock／LFU（缺頁次數） | ✔ | `os.page-replace` | 97231841 |
| 磁碟排程：FCFS／SSTF／SCAN／C-SCAN／LOOK | ✔ | `os.disk-sched` | 97231841 |
| 同步原語：訊號量／互斥鎖／條件變數的事件序列模擬、生產者消費者、哲學家、死結偵測（資源配置圖）、銀行家演算法 | ✔ | `domain_sync_core.js` 信號量／互斥鎖／條件變數／生產者消費者；`domain_os_core.js` 的 `os.banker`；`domain_sync2_core.js`（2026-11-10）：哲學家用餐事件模擬（先拿左／右／奇偶不同；總餐數／每人餐數／是否死結／完成順序）與「同時最多幾位能吃」、死結偵測（等待圖／資源配置圖找環、多實例 Allocation／Request 矩陣）。銀行家 holdout 的輸入措辭缺口已用通用讀取規則補上（第二行沒寫個數時，長度由第一行沒被當行數用的那個整數推，唯一時才推），該 holdout 1/1。sync2 train 19/19、舊 holdout 3/4 | 本批 |
| 檔案系統：inode／區塊配置、FAT 鏈、目錄解析、路徑正規化 | ✔ | `domain_fs_core.js`：FAT 簇鏈／空閒簇、inode 階層與佔用區塊數；2026-11-10 新增路徑正規化（絕對／相對／接在工作目錄後；輸出路徑／層數／最後一層／上一層）、目錄解析（mkdir／cd／pwd，. ..，上層必須存在或連同建立，cd 失敗留原處或印標籤）、連續配置策略（first／best／worst-fit，輸出起點／失敗數／空閒段數／最長段／外部碎片）、內部碎片；fs train 33/33、holdout 7/7（本批 holdout 為寫完骨架後所出，非冷啟動）。未做：夥伴系統（在記憶體那列）、日誌檔案系統 | 本批 |
| 行程樹／fork 次數推算、信號傳遞序列 | ✗ | 純計算（不真 fork） | P2 |

### D. 真實 Linux programming（文字進出、判題器可驗證的部分）
| 子領域 | 狀態 | 範式／內容 | 提交 |
|---|---|---|---|
| cat／grep／管線／xxd／base64／endian／RLE | ✔ | `lines.*`、`str.*`、`interp.pipeline` | dfed1565、73deb981 |
| tar／gzip／xz／BMP 二進位格式（讀寫對偶） | ✔ | `tar.*`、`gzip.*`、`bmp.*`、`xz.*` | 73deb981 |
| 校驗碼／位元流／LZ77／霍夫曼／固定霍夫曼 inflate／LZMA 範圍解碼 | ✔ | | 73deb981 |
| 樣式比對（glob、正規式子集）、算式求值、直譯器、堆疊 VM、argv 切分、環境展開 | ✔ | | 73deb981 |
| sed／awk／cut／sort／uniq／wc／tr／head／tail／diff／join 行為 | ◐ | `domain_linuxtext_core.js`：除 diff／join 外✔；兩段輸入工具另在 `domain_twofile_core.js`：cat -n 兩檔、comm／diff（只在 A／B／共同、去重、排序、個數）、join（inner／left）、paste、cmp；train 10/10、新 holdout 4/4。注意：`bench_coverage.js` 不載入領域包（只量核心範式），所以 bench_linux_all 58→59 來自讀取器的「兩個檔案各是一行 k 加 k 行」改寫（通用），不是 twofile 骨架；lx-cat-two 的敘述另被當 train（cat-cont）教進 twofile 測試，領域包層面不算泛化，泛化看新 holdout ho-cat（換措辭）。領域包的數字以各自 test.js 為準，宿主是否接上以 `scripts/e2e/matrix_graph.e2e.mjs` 為準 | ✔ |
| 文字剖析：CSV／JSON 子集／INI／log 解析、printf 格式化、strftime | ✗ | | P1 |
| 檔案 IO／行程／管線／信號／socket 的**語意模擬**（open flags、fd 表、dup2 重導向、pipe 緩衝、信號遮罩、socket 狀態機） | ✗ | 輸入「系統呼叫序列」，輸出狀態／輸出（純函式，不真呼叫） | P1 |
| 動態霍夫曼 inflate、LZMA match 解碼、LZMA2、BCJ、BMP RLE／32 位元遮罩、tar PAX | ✗ | 超出多半（DESIGN.blockly-gaps.md G14） | P3 |
| 真 fork／exec／socket／檔案 IO（判題器需二進位 IO／argv／環境／結束碼，G15、G16） | ✗ | **超出 Blockly**：交判題器維護者 | — |

## 2. Linux 缺口 G1–G18 狀態（對照 DESIGN.blockly-gaps.md §4）

| # | 狀態 | 提交／備註 |
|---|---|---|
| G1 讀取器形狀 | ✔ 已補 | dfed1565、73deb981（`readToolInput`、`TOOLS`、`TOOL_FAMILIES`、`intent.algos`） |
| G2 切割模板（輔助操作） | ✔ 已補（helpers；共用 crc32 單元） | 見 DESIGN.blockly-gaps.md §7 |
| G3 積木 | ✔ 已補（`try` 以 `try_ignore` 單本體積木處理；雙本體 try/except 仍走通用程式區塊） | 73deb981 |
| G4 欄位表範式 | ✔ 已補 | 73deb981（`ftTable` 從敘述抽欄位位移，抽不到用標準位移） |
| G5 行過濾器 | ✔ 已補 | dfed1565 |
| G6 無 def 改寫 | ✔ 實質完成（regex 狀態集、調度場＋RPN、inflate、VM 都不含 def）；(a) 保留 def 不做 | 73deb981 |
| G7 校驗碼 | ✔ 已補 | 73deb981 |
| G8 位元流 | ✔ 已補 | 73deb981 |
| G9 對齊／列序 | ✔ 已補（`align.up`、`bmp.stride-pad`） | 73deb981 |
| G10 詞法／狀態機 | ✔ 已補 | 73deb981 |
| G11 算式求值 | ✔ 已補 | 73deb981 |
| G12 直譯器 | ✔ 已補 | 73deb981 |
| G13 壓縮演算法 | ✔ 已補 | 73deb981 |
| G14 LZMA 完整流程 | 超出 Blockly（待補教學／上網） | — |
| G15 判題器二進位 IO 等 | 超出（判題器維護者） | — |
| G16 真行程 | 超出（待補教學） | — |
| G17 讀取器假陽性 | ✔ 已補 | dfed1565、73deb981 |
| G18 規格即題目 | ✔ 偵測 `intent.specLike` 已補；模型／老師部分超出 | 見 DESIGN.blockly-gaps.md §7 |

量測（無模型）：bench_linux_all **train 37/37、holdout 21/27**（起點 0/64）；holdout 未解：cat-two、exec-env、tar-blocks、canonical-huffman、xz-header、bmp-write8（輸入措辭／輸出格式猜不到，需老師教）。holdout 對「家族」不乾淨（缺口表已點名單元），數字代表「家族＋沒看過的措辭／格式」的泛化。

## 3. 領域包進度（2026-11-07 批次 1–2；全部無模型、不給課）

| 包（檔） | 內容 | train（原敘述＋改寫＋選項反序） | holdout（另寫措辭，只量測） | 提交 |
|---|---|---|---|---|
| `domain_algo2_core.js` | §9.7 A② 的 15 家族：歐拉函數、完全數、步數、k 進位、直方圖最大矩形、更暖天數、巢狀展開、最長合法括號、約瑟夫、視窗聚合、區間聯集、配對計數、RLE 解碼、回文子串、巴斯卡 | 30/30 | 無（原 `heldout_all.jsonl` 凍結，只在 scripts/eval 看判決；因本包依缺口表點名的家族寫成，那 17 題對這些家族已不乾淨） | 97231841 |
| `domain_os_core.js` | CPU 排程（非搶先 FCFS／SJF／優先權、RR、SRTF）、分頁置換（FIFO／LRU／OPT／LFU／Clock）、記憶體配適（首／最佳／最差／下次）、磁碟排程（FCFS／SSTF／SCAN／C-SCAN／LOOK） | 22/22 | 4/5（未解：「接下來 n 行各有三個整數」的輸入措辭讀不出，未補以免污染） | 97231841 |
| `domain_ds_core.js` | 雜湊表（開放定址）、LRU、堆積操作、BST（走訪／高度／葉數）、Trie、並查集操作、鏈結串列操作 | 24/24 | 4/5（未解：`add／extract／peek` 的指令字不在讀取器詞彙裡） | 97231841 |
| `domain_linuxtext_core.js` | cut／sort／uniq（-c）／wc／head／tail／tr／sed s///／awk 分組聚合 | 28/28 | 4/5（未解：「欄位以分號分隔」措辭沒抽到分隔符） | 本批 |
| `domain_graph3_core.js` | Floyd、二分圖最大匹配、指派問題（匈牙利）、最短路徑還原／條數／第 k 短／限制邊數 | 33/33（選項反序也 33/33） | 舊 `ho` 組 2/7（這組我看過未解結果並補了「路線」等同義詞，已不乾淨）；新 `ho2` 組 7/8（未解：用「車站／軌道」描述的路徑還原題）。兩組都是我寫完骨架後所出，非冷啟動 | 本批 |
| `domain_sync2_core.js` | 哲學家用餐事件模擬、同時最多幾位能吃、死結偵測（等待圖／資源配置圖／多實例矩陣） | 19/19 | 舊 3/4（未解：完全沒出現「死結」字樣、用「永遠卡住」描述的題）；`ho2` 3/3 | 本批 |
| `domain_fs_core.js`（擴充） | 路徑正規化、目錄解析、連續配置策略（first／best／worst-fit）、內部碎片 | 33/33（含原有 10 題） | 7/7＋`ho2` 2/2 | 本批 |
| `domain_ds_core.js`（擴充） | AVL、跳躍表、稀疏表 | 新增題全過（完整檔最後一次含舊題的跑法有 AVL 旋轉次數的 bug，修後只跑了相關子集 6/6） | 5/6（未解：把查詢欄位叫 x y 的稀疏表題） | 本批 |

- 共用測試 harness：`domain_harness.js`（種子 `{id, want, st, rw, ref, gen, split}`，`split:'holdout'` 只量測；`DBG=1`／`ONLY=id,...` 環境變數除錯）。新包只要寫骨架檔＋種子檔。
- 讀取器配套小修：字串輸入可帶名稱（「輸入一個字串 s」）、同名重複清單改名（a、b…）、「查詢字串」不再當整數、`rle-pair` 對解碼題否決、領域條目可標 `pri:true` 比內建工具詞彙（lines-map）優先。
- 台面上還沒做（linuxfmt 已做：樣板變數展開、區塊對齊計數、範式前綴碼三個參數化家族，train 6/6、新 holdout 3/4（${名稱:-預設} 誠實未解）；舊 Linux holdout 的 exec-env／tar-blocks／canonical-huffman 敘述已被當 train 教過，不再算 holdout；仍未解：xz-header、bmp-write8（規格太具體，只能靠第三層介面）。linuxsem 已做：fd 表／管線／信號遮罩／TCP 狀態機，train 11/11、新 holdout 4/4；未做：socket 全套、行程樹 fork／wait／exec、信號處理常式巢狀）：程序／fd／管線／信號／socket 的語意模擬、進階圖與樹（MST、SCC、Bellman-Ford、LCA…）、資料結構的 AVL／跳躍表／稀疏表。見 `DESIGN.TODO.md`。

## 4. 收尾盤點（2026-11-08，使用者：「blockly-teach 先完工」）

我讀程式與文件盤點的（不是重跑全部評測）：
- **多矩陣輸入形狀**：`os.banker`、`os.page-translate` 已由另一個工作階段完成（2026-11-07），讀取器放寬也已進。
- **真 Linux 語意模擬**：`domain_linuxsem_core.js` 已有 fd 表（open／dup／dup2／close）、管線緩衝、信號遮罩、TCP 狀態機，**2026-11-08 補行程樹（fork／exit／wait、殭屍、過繼給 init、init 是否立刻回收、wait 挑最小或最早 exit）與 socket 監聽佇列（backlog、conn／accept、丟棄、backlog+1）**；`domain_linuxsem.test.js` train 17/17（選項反序也 17/17）、holdout 6/6、整個測試檔 34 項過。**誠實註記**：新增兩個範式的 holdout 敘述是我寫完骨架後才寫的另一種措辭，不是冷啟動出題，所以 holdout 對這兩個範式只能說「換措辭仍解得出」，不能當泛化證據。同時加了兩個全域有風險的偵測詞（`殭屍`、`backlog`、`fork … wait`），已跑 `linux_paradigms`（125 項）、`domain_os`、`domain_sync`、`domain_dsp` 都過。**仍待改善**：socket 全套（bind／connect／半關閉）、`exec` 與環境變數（判題器能力，見下表）、信號處理常式巢狀。
- **思考堆疊**：F 部分補（見 `DESIGN.think-stack.md`）；C（離線每層框）、E（離線自檢）、I（路由堆疊實測，需模型）仍未做，C 與 E 要先設計層與框的對應，不是小改。
- **holdout 未解題（2026-11-08 量測，沒讀敘述、沒教）**：`holdout_blockly.jsonl` 28/31（未解 h-roman-rev、h-vowel-count、h-seq-given-hold，與之前相同）；`bench_linux_all.jsonl` 59/64（未解 lx-exec-env、lx-tar-blocks、lx-canonical-huffman、lx-xz-header、lx-bmp-write8；原本的 cat-two 已由 v322 的兩段輸入解掉）。用 `bench_coverage.js --json` 只看解出與否，輸出裡的判決種類是「程式讀不出這題的解法」，沒有預期輸出。這些仍是待改善，沒有為它們寫規則。
- **區塊 ↔ 中間語言 ↔ 目標語言 ↔ 函式行為卡**：已接成同一條線，見 `DESIGN.core-ir.md` §8。

### 「超出 Blockly」清單（更新）
| 項目 | 原因 | 去處 |
|---|---|---|
| LZMA match／LZMA2／BCJ、動態霍夫曼 inflate、BMP RLE／遮罩、tar PAX | 規格冗長、狀態多，範式槽位窮舉不經濟 | 待補教學（老師教→`deriveLesson`）或題目自帶規格 |
| 真 fork／exec／socket／檔案 IO、二進位 IO、argv、結束碼、環境變數 | 判題器能力（G15、G16） | 判題器維護者 |
| xz-header、bmp-write8（Linux holdout 未解） | 規格太具體 | 第三層介面／模型 |
| 模型／老師部分（G18） | 非範式 | 模型路線 |
| 區塊層保留行內註解 | 區塊樹沒有註解節點 | 見 `DESIGN.core-ir.md` §8 待改善 1（可做，屬區塊層而非超出） |
