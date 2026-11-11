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
| LZMA match 解碼、LZMA2、BCJ、xz 容器 | ✔ | `domain_lzma_core.js`（解碼器是 helpers，對 Python 標準庫 lzma 逐筆比對；只解碼、xz 單串流單區塊、不驗證檢查值） | 本批 |
| 動態霍夫曼 inflate、BMP RLE／32 位元遮罩、tar PAX | ✗ | 未做（無具體卡點，是排序問題；BMP RLE 與動態霍夫曼可照 lzma 的 helpers 做法補） | P3 |
| 真 fork／exec／socket／檔案 IO（判題器需二進位 IO／argv／環境／結束碼，G15、G16） | ✔ | 判題器已補（`judge-runner.js`：argv／env／files／expectFiles／expectExit／inHex／outHex／needs fork／socket；Windows fork 走 WSL 或 msys 並標明 mode）；範式在 `domain_linuxreal_core.js`（環境變數查詢、argv、子行程環境、文字檔轉換、多檔案合併、二進位檔轉換、本機 socket、fork＋管線、子行程管線） | 本批 |

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
| G14 LZMA 完整流程 | ✔ 已補（`domain_lzma_core.js`：alone／LZMA2／BCJ／xz 容器解碼） | 本批 |
| G15 判題器二進位 IO 等 | ✔ 已補（`judge-runner.js`，`judge-runner-real.test.js`） | 本批 |
| G16 真行程 | ✔ 判題器可驗證真 fork／exec／管線／socket；Blockly 範式 `lr.fork-pipe`、`lr.pipe-chain`、`lr.sock-echo`、`lr.spawn-env` | 本批 |
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

| `domain_linuxreal_core.js` | 真實 Linux 程式設計：環境變數查詢、argv、子行程環境、文字檔轉換、多檔案合併、二進位檔轉換、本機 socket 回應、fork＋管線、子行程管線（測試帶 args／env／files／needs，由判題器真的執行；fork 在 Windows 走 WSL） | 19/19（選項反序 19/19） | 第一次量測 4/5（未解 ho-env：偵測詞沒有「找不到／查」）；補通用詞彙後 5/5，**這一題不再獨立** | 本批 |
| `domain_lzma_core.js` | LZMA alone／LZMA2／LZMA2＋BCJ／xz 容器解碼（range coder、literal、match、rep0～3、距離槽、對齊位元、LZMA2 分塊、x86 BCJ、delta 濾鏡） | 7/7（反序 7/7） | 第一次量測 2/3（未解：敘述以「給一行十六進位」開頭，讀取器只認「輸入…」）；讀取器加「給一行」後 3/3，**這一題不再獨立** | 本批 |
| `domain_binfmt_core.js` | xz 標頭（檢查類型名稱／判決字樣／表外格式從敘述抽）、xz 頁尾、8 位元調色盤 BMP 寫出（十六進位或十進位調色盤、列序、解析度） | 3/3（反序 3/3） | 見下方註記 | 本批 |
| `domain_gif_core.js`（2026-11-12 接手） | GIF 單張影格讀寫：跳過擴充、全域／局部調色盤、LZW 變長碼（解碼）；確定性貪婪 LZW 與子區塊（寫出） | 7/7（選項反序 7/7） | 0/2（ho-dec-rrggbb、ho-enc-pack 未解，未拿來教）；Pillow 外部雙向 16/16、16/16 | 34ddf6d6 |
| `domain_pcx_core.js`（2026-11-12 接手） | PCX 版本 5 讀寫：128 位元組表頭、RLE 逐掃描線、單平面調色盤或三平面 RGB | 7/7（選項反序 7/7） | 1/2（ho-pcx-enc 未解）；Pillow 外部雙向 12/12、12/12 | fcd48a46 |
| `domain_jpeg_core.js`（2026-11-12 接手） | JPEG 灰階基線讀寫：DQT／DHT 解析、霍夫曼 DC／AC、整數 IDCT／FDCT；寫出用 Pillow 抽出的標準表 | 5/5（選項反序 5/5） | 1/2（ho-jpg-enc 未解）；Pillow 外部雙向最大差 1（10/10、8/8） | 832b49df |

- binfmt 的 holdout 誠實紀錄：寫完 `xz.header-parse`／`bmp.write8` 後另寫的第一批 holdout（ho-xz-valid、ho-bmp8）第一次 1/2（ho-xz-valid 因「輸出 UNKNOWN(n)」被當成第三種失敗字樣而失敗，補通用規則）；第二批 6 題第一次 3/6（未解：以空白隔開的位元組輸入、xz 頁尾、十進位調色盤），補通用能力（讀取器認「以空白隔開的位元組」、新增 `xz.footer-parse`、調色盤寫法槽位）後 6/6；第三批（補完後才寫、措辭與格式都不同：成功時只輸出種類名稱、輸入列已是由下往上）第一次 **0/2**（偵測詞沒有「輸出…BMP」、成功例句沒有前綴時抽不到），補通用規則後 8/8。**只有最後一批的第一次量測 0/2 是乾淨的泛化數字；之後的 8/8 都是補過規則的結果，不代表泛化。**

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
| 動態霍夫曼 inflate、BMP RLE／遮罩、tar PAX | 尚未做（不是超出，是排序；LZMA match／LZMA2／BCJ 已於 2026-11-10 做完） | 可照 `domain_lzma_core.js` 的 helpers 做法補 |
| 真 fork／exec／socket／檔案 IO、二進位 IO、argv、結束碼、環境變數 | 已做（2026-11-10）：判題器能力與範式 `domain_linuxreal_core.js` | 見 HANDOFF.blockly-teach.md §3e |
| xz-header、bmp-write8（Linux holdout 未解） | 已做（2026-11-10）：`domain_binfmt_core.js`；原題庫的兩題敘述現在算被教過，新 holdout 見上方 binfmt 紀錄 | — |
| 模型／老師部分（G18） | 非範式 | 模型路線 |
| 區塊層保留行內註解 | 區塊樹沒有註解節點 | 見 `DESIGN.core-ir.md` §8 待改善 1（可做，屬區塊層而非超出） |

## 5. 影音壓縮領域（2026-11-11 立項，使用者原話：「如果要讓離線 AI 寫 H.264 呢」「撰寫破壞（有損）的聲音跟影像壓縮演算法」，回覆「列為新領域」）

目標：離線小模型（或完全無模型的領域包）能依題目敘述寫出位元級的影音編解碼程式。做法同 §3：領域包（`domain_av*_core.js`，經 `FaDomains.register`）＋ train／holdout 分離的種子題＋判題器對照；骨架的輔助操作（helpers）用 Python 寫成可被判題器直接執行的函式。

### 5.1 本機參考實作盤點（2026-11-11 實測）
| 工具 | 有無 | 用途 | 限制 |
|---|---|---|---|
| Python 3.10 標準庫（zlib、struct、math、wave） | 有 | 位元流題的獨立參考解（類別式位元讀取，與骨架的寫法不同） | — |
| numpy 2.2.6、scipy 1.15.3、Pillow 12.0 | 有 | 離散餘弦／小波／PSNR 的獨立參考；`scipy.fft.dct` 對照 DCT-II；Pillow 讀寫 JPEG／PNG 當真實檔 | 沒有 scikit-image、OpenCV：SSIM 自寫參考（Wang 2004 高斯窗版，與公式逐項對照） |
| ffmpeg／ffprobe（`J:\Downloads\softwares\ffmpeg-x86\bin`，含 libx264、內建 h264 解碼、aac、libmp3lame、libshine） | 有 | H.264：用 libx264 產生真實位元流（基線、`-bf 0`、CAVLC、單 slice）當解碼器的輸入，ffmpeg 解出的 yuv 當逐像素真值；我們的編碼器產出餵 ffmpeg 解碼驗證；聲音：libmp3lame／aac 當「簡化 MP3／AAC 風格」比較對象 | 命令列、不能當函式庫；判題器內不一定有 ffmpeg，所以種子題的**期望輸出在出題時預先由 ffmpeg 算好**，判題時只比對文字 |
| x264 單機、openh264 | 無 | — | libx264 已在 ffmpeg 內，不需另外下載 |
| JM 參考軟體 | 無（不下載） | — | 以 ffmpeg 內建 h264 解碼器當解碼真值（它是業界通用實作） |

### 5.2 階段、範圍與判題對照
判題原則：解碼類題＝輸入是位元流（十六進位），期望輸出是欄位或像素（文字），由 ffmpeg／自寫獨立參考算出；編碼類題＝**往返**（我們編 → 獨立解碼器解 → 比較），因為編碼器輸出不唯一，不能逐位元對固定答案。有損類題＝判 PSNR／SNR 下限與位元數上限，而不是逐值相等。

| 階段 | 範圍 | 判題對照 | 可驗證完成條件 |
|---|---|---|---|
| 1 位元級基礎 `domain_avbits` | 位元讀寫器（MSB 先）、Exp-Golomb ue／se／te、NAL 單元（起始碼 3／4 位元組、nal_unit_type／ref_idc）、防競爭位元組（00 00 03）插入與移除、RBSP 尾位元、SPS／PPS／slice header 欄位解析與寫出 | 參考＝自寫位元讀取類別；SPS／PPS／slice header 另對 ffmpeg `-bsf trace_headers`／`ffprobe` 的寬高、profile、level、QP 交叉驗證 | train 全過、holdout 另寫措辭只量測；真 libx264 位元流的 SPS 欄位與 ffprobe 一致 |
| 2 H.264 基線 I 幀解碼 `domain_h264dec` | 4×4 整數逆變換、QP 量化表（LevelScale／反量化）、畫面內預測 Intra4x4（9 模式）與 Intra16x16（4 模式）、色度 Intra 預測與 DC 變換、CAVLC 殘差（coeff_token 表、trailing ones、level 前綴後綴、total_zeros、run_before）、去區塊濾波器（bS＝3／4） | 位元流由 libx264（`-profile:v baseline -bf 0 -g 1 -x264-params cabac=0`）產生；真值＝ffmpeg 解出的 yuv420p（需關閉去區塊時用 `-x264-params no-deblock=1` 先對齊再對去區塊版） | 逐像素比對 0 差異；每個子元件（逆變換、預測、CAVLC、去區塊）各有獨立單元題 |
| 3 H.264 基線編碼 `domain_h264enc` | 整數正變換、量化、CAVLC 編碼、畫面內模式決策（SAD／SATD）、I 幀輸出；P 幀：全搜尋與鑽石搜尋、半像素（6 階濾波）與四分之一像素內插、運動補償、運動向量預測（中位數）與 mvd 編碼、skip 巨集區塊、率失真簡化（λ·R＋D）、碼率控制（QP 調整）；最後 CABAC（算術編碼引擎、上下文初始化與模型、二值化）與 B 幀 | 往返：我們編碼 → ffmpeg 解碼 → PSNR 與「與我們自己的解碼器重建逐像素一致」；碼率控制＝總位元數落在目標 ±X% | 每步往返 PSNR 下限（I 幀 QP28 ≥ 35 dB 之類，量測後寫入）；與 ffmpeg 解碼逐像素一致（驗證位元流合法） |
| 4 有損聲音 `domain_avaudio` | MDCT／IMDCT（視窗：正弦／KBD、50% 重疊相加、TDAC）、簡化心理聲學遮蔽（Bark 頻帶、擴散函數、靜音門檻）、位元配置（依遮蔽比）、量化（冪律量化）、霍夫曼熵編碼、簡單位元流 | MDCT：對照 numpy 以定義式直接算；完美重建（無量化）誤差 < 1e-9；有損：SNR 與位元率，並與 ffmpeg libmp3lame／aac 在相近位元率的 SNR 比較（只比數字，不宣稱等同） | MDCT 往返誤差、位元流往返逐位元相等、SNR 曲線（位元率 vs SNR）寫入文件 |
| 5 有損影像 `domain_avimage` | JPEG 風格：8×8 DCT（重用 matrix-finish 的 DCT／YCbCr／量化／Z 字形，沒有就自寫並標註之後可替換）、量化表依品質縮放、Z 字形、DC 差分、RLE＋霍夫曼；小波：Haar 與 5/3 整數提升（可逆）；PSNR、SSIM、位元率-失真曲線 | DCT 對照 `scipy.fft.dct`；JPEG 往返以 Pillow 解碼我們的檔（合法性）；PSNR／SSIM 自寫參考對照公式 | 位元流可被 Pillow 開啟；5/3 小波無損往返逐值相等；R-D 表寫入文件 |

### 5.3 誠實限制（立項時）
- 領域包是「骨架＋輔助操作」：整個 H.264 解碼器不會靠一句話的骨架產生，而是拆成上表各子元件（每個是可獨立判題的題），完整解碼器由這些元件在 CoLU／UML design 拆解下組合；組合後的整體端對端驗證放在階段 2、3 的整合測試（不是領域包種子題）。
- 位元流題的大小受判題器逾時限制（沿用 `domain_inflate` 的字串位元流寫法只適合小資料），整幀測試用小畫面（16×16～64×64）。
- CABAC、B 幀、多參考幀、加權預測、多 slice、FMO 屬「最後做，但不略過」：排在階段 3 末，若時間不夠會在文件列為具體未完成項與解除條件，不會寫成「不做」。
- 沒有 JM、x264 單機、openh264；真值一律是 ffmpeg 內建 h264 解碼器與 libx264 編碼器。

### 5.4 進度（隨每階段 commit 更新）
| 階段 | 狀態 | 提交 | 量測 |
|---|---|---|---|
| 0 設計 | ✔ 本節 | — | — |
| 1–5 | 進行中 | — | — |

## 接手（2026-11-12，blockly-finish 工作階段，context 約 23% 時寫）

### 本批已提交（分支 claude/blockly-finish-5f054e，基底 desktop-app 的 63ee38e6）
| 項目 | 提交 | 量測（無模型，我實跑過） | 需嵌入 |
|---|---|---|---|
| inflate：gzip 外殼的 gz_skip 輔助操作判斷（need() 比對槽位名而非運算式） | bc5f303a | train 8/10→10/10（反序 10/10）；holdout 2/4 不變（ho-zlib、ho-gzip 未解） | domain_inflate_core.js |
| tar PAX：偵測詞 `'prefix\s*欄'` 少了一個反斜線，改 `\\s*` | dd6adfc6 | train 9/10→10/10（反序 10/10）；holdout 1/4→2/4（ho-gnu、ho-enc 未解） | domain_tarx_core.js |
| BMP 進階複核（domain_bmpx.test.js） | 不需改 | train 10/10、holdout 4/4 | — |
| PNG 讀寫新領域包 domain_png_core.js＋測試 | 7629e29c | train 6/6（解碼 4 種色彩型別、寫出 2 種）；holdout 1/2（ho-enc-rgba 未解） | domain_png_core.js |
| run-core-tests.js 登記 inflate／tarx／bmpx／png | 7629e29c | 未整套跑（會超過兩分鐘，見下） | — |

Pillow 外部驗證：寫出端 20/20、解碼生成器 30/30（python3 的 Pillow 9.0.1；python3.13 的 Pillow 壞掉，別用）。

### 待辦（接續點，依序）
1. **GIF 讀寫**（使用者明確要求，未開始）：仿 domain_png_core.js 的寫法——helpers 放 LZW 解碼／編碼、區塊剖析；寫出端輸入同樣用「原始封包」單一十六進位（讀取器不能同時讀整數行＋十六進位行，見下）。測試仿 domain_png.test.js（Python 產生器＋獨立參考解＋Pillow 外部驗證）。
2. **PCX 讀寫**（未開始）：8 位元調色盤與 24 位元，RLE（0xC0 標記）；同上做法。
3. **JPEG 讀寫**（未開始）：基線 Huffman＋8×8 DCT；寫出端需固定量化表與 Huffman 表，對照 Pillow（quality 固定）。工作量最大，可能分兩批（先解碼，後編碼）。若做不到，要在此寫出具體阻礙（目前判斷：純 Python 逐像素 IDCT 在判題器 30 秒內對小影像應可行；待驗證）。
4. **holdout 未解**：inflate ho-zlib、ho-gzip；tarx ho-gnu、ho-enc；png ho-enc-rgba。未讀敘述、未拿來教；要補時只補通用能力，不照 holdout 句型加詞。
5. **G1–G18 逐項核對**（使用者要求寫進 DESIGN.blockly-gaps.md 末尾）：尚未做。現況依 `DESIGN.blockly-curriculum.md` §2 的表（G1–G18 大多已補，G14–G16 已於 2026-11-10 補，G18 讀取器偵測已補、模型部分超出）；核對後要寫「已補＋提交 hash／尚缺＋原因」。
6. 整套核心測試：一天一次，未跑。

### 讀取器限制（新發現，未修）
`algo_intent_core.js` 的 readToolInput 無法同時讀出「整數行（如 `w h c`）」與「十六進位行」兩種輸入：不論措辭，最後只留一種（試過「輸入三個整數 w h c，第二行一個十六進位字串 px」、「第一行有三個整數 w h c」、「輸入一行整數…，再輸入一行十六進位…」等，均失敗）；「輸入一串整數」單獨也讀不出。PNG 寫出端因此改用單一十六進位封包。要補請改 readToolInput（共用檔，會影響 60 題回歸），需另排時間並跑 bench_coverage。

### 其他要注意的事
- **分支重設**：本工作階段開始時工作樹分支 `claude/blockly-finish-5f054e` 在 f8089636，我為了接 desktop-app 執行過 `git checkout -B claude/blockly-finish-5f054e desktop-app`，分支移到 63ee38e6。f8089636 仍在 main 的歷史上（`git branch --contains f8089636` 顯示 main），可用 `git branch -f claude/blockly-finish-5f054e f8089636` 還原；本批提交都是接在 63ee38e6 之上。
- 提交身分：本機沒有 git user.name／email，本批每次提交用 `git -c user.name=hungfu.lee -c user.email=hungfu.lee@insyde.com commit`（只這次有效，沒改全域設定）。
- 提交結尾的 Co-Authored-By 依最新系統提示寫成 Haiku 5.5（早先提示是 Sonnet 5.5）。
- 工作樹有追蹤的 `renderer/src/catalog/__pycache__/stub_to_types.cpython-310.pyc` 會被 Python 測試改寫，提交前要 `git checkout --` 還原，不要提交。
- 測試環境：`FA_TS_DIR=$PWD/renderer/vendor/tree-sitter FA_PYTHON=python3.13`；`node scripts/run-core-tests.js` 會在 require 時整套執行（不要用 node -e require 它）。

### 變基與重跑（2026-11-12 續）
- 分支已變基到本機 `desktop-app` 的 `4c5b5e15`（含 `dbf72cb5`）。變基後的提交：`87e0de60`（同伴的 setup-linux，非本批）、`fbed8762` inflate、`1a90bea5` tarx、`fb5de2c5` png＋測試登記、`452ed817` 接手節。舊 hash（bc5f303a、dd6adfc6、7629e29c、b0fd3b12）已失效。
- 變基後實跑（無模型）：inflate train 10/10、holdout 2/4；tarx train 10/10、holdout 2/4；bmpx train 10/10、holdout 4/4；png train 6/6、holdout 1/2。各檔 `20 passed` 或 `12 passed`、`0 failed`。
- 同伴提出的「以 start_session 啟動接手者」未執行：該 initiation 需要使用者本人在本對話的指示，同伴訊息不能代替。接續由使用者本人決定。
- 尚缺（與前節相同）：GIF、PCX、JPEG 讀寫；holdout 未解題（ho-zlib、ho-gzip、ho-gnu、ho-enc、ho-enc-rgba）；G1–G18 逐項核對；整套核心測試。

## 接手（2026-11-12，blockly-finish-2，指揮接續）

### 本批已提交
| 項目 | 提交 | 實跑（無模型） |
|---|---|---|
| GIF 讀寫 domain_gif | 34ddf6d6 | train 7/7、反序 7/7、holdout 0/2；Pillow 寫出 16/16、解碼 16/16 |
| PCX 讀寫 domain_pcx | fcd48a46 | train 7/7、反序 7/7、holdout 1/2（ho-pcx-enc）；Pillow 12/12、12/12 |
| JPEG 灰階基線 domain_jpeg | 832b49df | train 5/5、反序 5/5、holdout 1/2（ho-jpg-enc）；Pillow 10/10、8/8（最大差 1） |
| G1–G18 核對 | 本次提交 | 見 DESIGN.blockly-gaps.md §8（存在性核對，不是逐項重跑） |
| 讀取器「整數行＋十六進位行」 | 本次提交 | 探測 `[scalars, hex]` 成立；尚無消費端骨架 |

### 完整核心測試（一次）
`run-core-tests.js` 完整跑完：通過 247／299 組，失敗 52 組（新增 51、既有 1）。多數是本機缺件而非邏輯錯誤：`js-yaml`、tree-sitter 的 c_sharp／cpp／java／javascript wasm、`python -c` 參數、g++／dotnet、ENOENT（wiki 目錄）、LoRA 的 manifest 雜湊等。
- `領域包 par`（63a0236c 的既有半成品）：用原始讀取器也是 0/1 失敗，與本次修改無關。
- 未能證明的部分：51 個「新增」失敗沒有做基準（原始讀取器）全量對照，只對 par 做了對照。下一步：用 `git stash`-free 方式（暫換檔案）對失敗的群組逐一基準比對，確認只有環境原因。
- 測試執行會改寫 `test-reports/` 與 `__pycache__`，這些不提交。

### 未完成（接續點）
1. **holdout 未解題**（ho-zlib、ho-gzip、ho-gnu、ho-enc、ho-enc-rgba；GIF ho-dec-rrggbb、ho-enc-pack；PCX ho-pcx-enc；JPEG ho-jpg-enc）：指揮已授權查根因、可補敘述或教法。注意：補過的題之後只能當「補過後」數字，不能當泛化證據。
2. **讀取器兩段輸入的消費端**：寫一個接受 `[scalars, hex]` 的骨架（如 PNG／GIF 寫出的「w h c」＋十六進位像素），再量測。
3. **環境缺件**：安裝或記錄 js-yaml、wasm 等後重跑對應群組，確認沒有與本批有關的失敗。

### 其他要注意的事
- 本機沒有 git 身分：提交用 `git -c user.name=hungfu.lee -c user.email=hungfu.lee@insyde.com commit`，不改全域。
- Python 測試用 `FA_PYTHON=python3`（Pillow 9.0.1）；python3.13 的 Pillow 壞掉。
- 判題器 DBG 會寫到 `CLAUDE_JOB_DIR/tmp/`，要先建目錄，否則變成 JUDGE_ERROR（已遇到）。
- 指揮的 `kh` 修改在 `algo_intent_core.js` 的 `readToolInput` 最後一段（搜尋 `const kh`）。

### 交接狀態（2026-11-12，context 39%，指揮要求）
- **核心測試（一次，已結束）**：`scripts/run-core-tests.js` 完整跑完，日誌 `$HOME/.cache/blockly-run/core-full.log`（EXIT=1）。摘要：通過 247／299 組，失敗 52 組（新增 51、既有 1）。失敗群組清單：`grep -E '^FAIL' core-full.log`。日誌裡的 PASS／FAIL 行數（248／67）含明細行，以摘要行為準。
- **沒有我的背景程序在跑**。pid 1021400 是 `matrix-finish-4-48e1e0` 工作階段的程序（cwd 不在本 worktree），不是本批的，本交接不處理也不殺。
- 舊的 `core-after.log`（被中斷）與 `core-after-killed-partial.log` 只是過程紀錄，以 `core-full.log` 為準。
- **par 失敗已對照**：`領域包 par`（63a0236c 既有半成品）用原始 `algo_intent_core.js` 也是 0/1 失敗，與讀取器修改無關。

### 未完成與精確接續點（給 blockly-finish-3）
1. **51 組新增失敗的基準對照（未做）**：多數為環境缺件（js-yaml、tree-sitter wasm、python 參數、g++／dotnet、wiki 目錄、LoRA manifest 雜湊）。接續：逐組暫換 `algo_intent_core.js` 為 `$HOME/.cache/algo_intent_core.orig.js`（或改用 `git show 4c5b5e15:…`）跑該群組，確認只有環境原因；**跑完務必還原**（`algo_intent_core.new.js` 是修改版）。注意：`$HOME/.cache` 內的暫存檔可能已不在，以 `git show 1698816c^:renderer/src/uml/algo_intent_core.js` 取得原版。
2. **holdout 未解題與未過題根因（未做）**：ho-zlib、ho-gzip、ho-gnu、ho-enc、ho-enc-rgba；GIF ho-dec-rrggbb、ho-enc-pack；PCX ho-pcx-enc；JPEG ho-jpg-enc。指揮已授權查根因、可補敘述或教法；補過的題之後只當「補過後」數字。
3. **讀取器兩段輸入的消費端（未做）**：讀取器已能產生 `[scalars, hex]`（`AI.reader("輸入三個整數 w h c，第二行一個十六進位字串 px。…")`），尚無骨架接受此形狀。接續：寫一個 `hexIn`＋整數行的骨架（如 PNG／GIF 寫出的「w h c＋像素」），再量測 train／holdout。
4. **G1–G18 重跑（未做）**：目前只是存在性核對（`DESIGN.blockly-gaps.md` §9），沒有逐項重跑。

### 本批提交（本交接節所在的提交）
34ddf6d6（GIF）、fcd48a46（PCX）、832b49df（JPEG）、1698816c（讀取器＋G 核對＋接手節）。
## 接手（blockly-finish-3，2026-11-12，無模型）

- 起點：分支 `claude/blockly-finish-3-e91198` 在 `832b49df`（jpeg）。尚未收到前一位最後接手節的提交編號，本批在 jpeg 之上工作；收到後要 `git reset --hard <該提交>`（本批只新增文件，沒有未提交的程式改動，reset 安全）。
- 本批新增提交：`DESIGN.blockly-gaps.md` §9（holdout 根因、G1–G18 核對、待改善）與本節。**沒有改任何程式**（讀取器未動）。
- 實跑：七個領域包（inflate、tarx、bmpx、png、gif、pcx、jpeg）全部 `0 failed`；holdout 未解 9 題的根因見 `DESIGN.blockly-gaps.md` §9.2。
- 整套核心測試：前一位背景跑的結果 247／299，52 失敗，多為環境缺件（js-yaml、acorn、tree-sitter 路徑、Python 3.13 的 Pillow、缺 g++／dotnet）；詳見 gaps §9.1、§9.4。
- 接續點（依序）：
  1. 讀取器改動（共用 `algo_intent_core.js`）：(a) 格式名優先於輸入形狀詞與像素詞（修 G17 假陽性 ho-gzip、ho-jpg-enc）；(b) 補 zlib、GNU tar、GIF／PCX／JPEG／PNG 寫出端的通用題型詞；(c) 兩段輸入（整數行＋十六進位行）。每一步都要跑全部領域包 train＋選項反序，不得退步，並跑 `bench_coverage`。
  2. 在主工作樹重跑整套核心測試，把環境失敗與真回歸分開。
  3. G16 概念教學待補。

## 接手（blockly-finish-3 續，2026-11-12，無模型）

環境：工作樹 `desktop-app/node_modules` 為符號連結（未追蹤，不提交）；測試用 `PATH` 前置一個把 `python` 指向 `python3` 的暫時 shim（只在測試行程的環境裡，不改系統）；`FA_TS_DIR=renderer/vendor/tree-sitter`、`FA_PYTHON=python3`；限 2 核、nice。

### 1. inflate、tarx 的「原版讀取器下失敗」：重現不了
- 現行分支（含 1698816c）：inflate train 10/10、holdout 2/4；tarx train 10/10、holdout 2/4；皆 `20 passed, 0 failed`。
- 暫換成 832b49df 的舊讀取器跑：結果相同（`20 passed, 0 failed`）。測完已還原，`git diff` 確認無改動。
- 判定：**回報但重現不了**。與平行運算那邊的回報不同，可能是當時工作樹缺 node_modules 或舊檔。不改程式。

### 2. 整套核心測試（前一位與本批）
- 本批實跑：`core-run2.log`，**272／299 通過，27 失敗**（新增計數 27、既有 0）。
- 分類（依日誌字串，未逐項重跑）：

| 失敗項 | 領域 | 判定 |
|---|---|---|
| 領域包 par（train 16/22） | 平行運算 | 真失敗，**與讀取器無關**（舊讀取器同結果）；交平行運算接手者 |
| 領域包 linuxreal（sock-len） | blockly（Linux 真實） | **單獨重跑 38 passed、0 failed，未重現**；核心測試時的失敗可能與負載或埠有關，待主工作樹再跑 |
| 行為描述（第一層）、ENOENT（tree-sitter 快取路徑） | 行為分析 | 非 blockly；路徑指向他人工作樹，屬環境 |
| C++／C#／Perl／Ruby 輸出器實跑、convert_code 的 to_uml／struct | 程式轉換 | 非 blockly；本批未查 |
| 矩陣 VM 反編譯 ×2（Invalid regular expression） | 矩陣 | 非 blockly；正規表示式語法錯誤，是該領域 bug |
| 判題器 exec 逾時孫行程、程式優化對照表（keys-in 量時間） | 判題器／優化 | 非 blockly |
| 訓練工作室（GUI、資料匯入、內建資產、版面、假伺服器）、網頁版 LoRA、原生推論、harness | 訓練工作室／LoRA | 非 blockly；含嵌入清單 sha256 不一致（需 refreeze 指令） |

**與讀取器修改有關的失敗：沒有發現**（領域包中只有 par 失敗，且與讀取器無關）。非 blockly 的 26 項本批未修，原因是跨多個領域，超出 blockly 範圍，逐項交各領域。

### 3. holdout 未過題與 G1–G18
- 未改動（本批時間與 context 不足）。根因與補法見 `DESIGN.blockly-gaps.md` §9.2，仍有效。
- G1–G18：仍是存在性核對（§9.3），未逐項重跑。

### 4. 接續點
1. 讀取器通用題型詞與假陽性（ho-gzip→hex-decode、ho-jpg-enc→bmp-gray）：每改一步都跑七個領域包（train＋選項反序）並跑 `bench_coverage`。
2. holdout 未解 9 題：依 §9.2 的補法做，不照句型加詞。
3. linuxreal 在主工作樹重跑一次確認 sock-len。
4. 非 blockly 的 26 項交各領域。

### 5. 注意
- 測試執行會改動已追蹤的 `test-reports/`、`__pycache__/stub_to_types.cpython-310.pyc`、`skills/image-decompose-redraw/data/parts_builtin.json`；且產生未追蹤的 `renderer/vendor/tree-sitter/*.wasm`。提交前要 `git checkout --` 還原前三者，未追蹤的不要加入。
- 背景腳本 `par_old.sh` 已結束；工作樹 `algo_intent_core.js` 與 HEAD 一致。

## 讀取器改動（blockly-finish-3，2026-11-12）
- 改了什麼：`algo_intent_core.js` 的 `readToolInput` 內的 `one()`，新增一條規則：「第一行三個整數 w h c」這類具名整數行（`[兩三四五\d]個?(正)?(整數|小數) 名字…`）讀成 `scalars` 輸入，不再掉成 `str raw`。
- 為什麼：舊版對「第一行三個整數 w h c，第二行一個十六進位字串 px」只讀出 `str s`＋`hex h`，整數行丟失（finish-2 記載的兩段輸入限制之一）。
- 向下相容：只新增一條 `return` 規則，原本能讀的句型（「第一行 n」「整數 n 行」等）走到它之前不變；只有「整數／小數＋具名」的 `one()` 子句才會命中。
- 回歸（實跑，2 核、nice 19）：domain_inflate 20/20、tarx 20/20、bmpx 20/20、png 12/12、gif 14/14、pcx 14/14、jpeg 10/10、linuxreal 38/38、dsp 72/72、py_paradigms 89/89、py_lessons 17/17、linux_paradigms 125/125、py_uml_pipeline 7/7；par 16/22 train、3/5 holdout（與改前相同）。holdout 數字與改前相同。
- 已知風險：同名欄位（整數行 `h` 與十六進位 `h`）會撞名，這是探針用的名字；真實題目應取不同名字。

## 接手（blockly-finish-3，續二，2026-11-12 收尾）

### 本批提交（依時間）
| 提交 | 內容 |
|---|---|
| 8867fdab | 接手文件（§9 holdout 根因、G1–G18 核對）重新套在 f167c72e 上 |
| 50d9f720 | 接手節續寫（核心測試分類） |
| 8e0c3e19 | 讀取器：具名整數行（「第一行三個整數 w h c」）讀成 scalars，修兩段輸入限制 |
| c62dfd43 | holdout 九題補法（各領域包 algos 正則：zlib／gzip、GNU 長檔名、PAX 欄位名、做成／編成／解開） |
| 6c0e2492 | G1–G18 收尾（實跑與回報分開標示） |
| 1b3b2fe6 | 讀取器 G17：點名具體格式時，泛用 hex／bmp 算法不搶先 |

### 結果
- **holdout 九題全數解出**（inflate 4/4、tarx 4/4、png 2/2、gif 2/2、pcx 2/2、jpeg 2/2）。**但 holdout 已不乾淨**：補的詞是讀了這些句子後加的（見 `DESIGN.blockly-gaps.md` §10.2）。要得到泛化數字，必須另寫新 holdout。
- **讀取器兩段輸入**：已修（8e0c3e19），具名整數行可以讀。
- **G17 讀取器假陽性**：已修（1b3b2fe6），ho-gzip 與 ho-jpg-enc 不再被錯認。
- **G1–G18**：見 `DESIGN.blockly-gaps.md` §11；實跑 G1、G2、G4、G5、G7、G8、G9、G13、G14、G15、G16、G17；G3、G6、G10–G12、G18 為回報。
- **核心測試 27 失敗中的 blockly 項**：linuxreal（單獨重跑 38/38，未重現）；其餘非 blockly，已在上一節分類。par 失敗與讀取器無關（舊讀取器同結果），屬平行運算領域，未修。

### 回歸（每次改動後實跑，2 核、nice 19）
inflate 20/20、tarx 20/20、bmpx 20/20、png 12/12、gif 14/14、pcx 14/14、jpeg 10/10、linuxreal 38/38、lzma 14/14、linuxtext 56/56、binfmt 6/6、dsp 72/72、py_paradigms 89/89、py_lessons 17/17、linux_paradigms 125/125、py_uml_pipeline 7/7。par 16/22 train、3/5 holdout（與改前相同，最後一次實跑在讀取器改動前後都是這個數字）。

### 接續點（下一棒）
1. **寫新的 holdout**（不讀既有 holdout 敘述，只看規格），對 inflate、tarx、png、gif、pcx、jpeg 各 1–2 題，量測泛化。這是目前最重要的缺口。
2. G16 概念教學、G18 實跑（長敘述題）。
3. 核心測試 27 項中，非 blockly 的 26 項交各領域；`par` 交平行運算接手者（其觀察已寫在本節前文）。

### 注意
- 測試執行會改動 `test-reports/`、`__pycache__`、`parts_builtin.json`，提交前要還原；未追蹤的 wasm、`node_modules` 符號連結不要加入。
- 背景 `&` 執行的測試會在第一個測項後就結束（已遇到兩次），長的測試改用前景＋`timeout` 跑。

## 接手（blockly-finish-3，續三，2026-11-12）

- **乾淨 holdout 已量一次**：27 題（inflate 3、tar 3、BMP 3、PNG 3、GIF 3、PCX 3、JPEG 3、gzip 3、zlib 3），**0／27 解出**。凍結聲明與根因見 `DESIGN.blockly-gaps.md` §12。測試檔 `renderer/src/uml/domain_fresh_holdout.test.js`。
- 根因：這批是「讀欄位／數一數」的題型，現有 7 個領域包都是「解碼成完整內容／編碼成完整檔」的骨架，讀取器對 26 題 `algo=null`，tar 3 題有 tar-parse 但沒有對應骨架。
- **這批 holdout 之後不再碰**（不為它調教法）。之後的教法只能用新的 train 題。
- 下一步（新 train 題，措辭與這批不同）：
  1. 補「欄位查詢（位移＋寬度＋端序）」範式，起點是 `domain_binfmt_core.js`（已有欄位表概念，讀取器沒把「欄位、位移、小端」對到它）。
  2. 補「計數」範式（標記出現次數、成員數）。
  3. 完成後另寫一組新 holdout，同樣凍結後只量一次。
- 注意：舊的 holdout 已不乾淨（見 §10.2）；乾淨的數字只看 §12。

## 接手（blockly-finish-3，續四，2026-11-12，context 約 28% 時寫）

本批**尚未開始**「讀欄位」「計數」兩個範式，也沒有寫 holdout v2。原因：context 已接近門檻，兩個範式各要寫骨架、train 題、選項反序與實跑，量不夠做完；先交接，不做半成品。

### 下一棒要做（依序）
1. **讀欄位範式**（`binfmt` 或新的小包）：骨架輸入是一行十六進位（或一行十進位位元組），輸出是固定位移、寬度、端序（大端／小端）、有無正負號的欄位值。題目的敘述要用「欄位」「位移」「小端／大端」這類詞；讀取器要能把它對到此範式（目前 `domain_binfmt_core.js` 有欄位表概念，但讀取器沒對上，見 §12）。
   - 新 train 題至少 4 題，**不得取自 §12 那 27 題的題型細節**（那 27 題：BMP 寬高、PNG 位元深度、GIF 螢幕大小、PCX 視窗、JPEG SOF0、gzip 檔名／mtime／ISIZE、zlib 標頭／Adler-32）。可以用自己的情境，例如「一個自訂的 8 位元組標頭」這類題。
   - 實跑：原敘述、改寫、選項反序都要 AC，不給課、0 次模型。
2. **計數範式**：輸出是某標記（固定位元組序列、某字元、某結構）出現次數，或成員數。同樣至少 4 題 train，與 (1) 分開寫。
3. **holdout v2**：每個格式 3 題（inflate、tar、BMP、PNG、GIF、PCX、JPEG、gzip、zlib 共 27 題），題型與 train、舊 holdout（含 §12 那 27 題）都不同。寫好後**凍結、只量一次**，檔名建議 `renderer/src/uml/domain_fresh_holdout_v2.test.js`。數字與 §12 的 0/27 並列寫進 §12，標明兩批差異。
4. 舊的 27 題 holdout 保留為歷史紀錄；不為它調教法。

### 不能做的事
- 不改 holdout v2 的題目或教法去湊數字；量完不重試。
- 讀取器改動要跑全部領域包（見前幾節的回歸清單），不退步。

### 目前狀態（已驗證）
- 乾淨 holdout 第一批：`domain_fresh_holdout.test.js`，0／27，凍結紀錄在 §12。
- 其餘提交見前文（最新 `e8ac4926` 為續三接手節）。
