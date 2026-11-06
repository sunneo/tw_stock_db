# Linux 小工具拆解 → Blockly 缺口清單（2026-11-06）

起因（使用者）：「下一個教學試題，claude先把linux的util如tar, gz, xz, xxd, grep, cat, eval, exec, 實現bmp reader/writer 整個都拆解，全部給予blockly教學，看哪邊有未知的。以及uml到切割問題，到 blockly，哪裡有題形、演算法沒跟上的」。

本文只含分析與題庫，沒有改任何管線程式。產物：`scripts/eval/gen_bench_linux.py`（出題器）、`renderer/src/recipe/seed/bench_linux_all.jsonl`（64 題、508 筆測資）。缺口結論交協調 session 轉 blockly-teach。

## 0. 結論（先看這裡）

| 項目 | 結果 |
|---|---|
| 拆出的最小單元 | 64 個（xxd 5、cat 4、grep 8、regex 3、eval 5＋VM 1、exec 3、tar 5、gzip/DEFLATE 12、xz/LZMA 6、BMP 8、base64 2、端序 1、RLE 1） |
| 難度 | LX0 17、LX1 25、LX2 22；`split`：train 37、**holdout 27**（holdout 不准拿去教課／範式，只量測） |
| 參考解在判題器上 | 64/64 AC（參考解全部從頭手寫，產生器另以 zlib／tarfile／gzip／base64 交叉驗證 CRC、tar 標頭、gzip 成員、固定霍夫曼 inflate、LZMA 範圍編碼） |
| 參考解經「tree-sitter → UML → Python」來回 | **64/64 AC**（語法層面，積木／IR 表得出來） |
| **現有離線流程解出（配方→課→範式→矩陣層，無模型）** | **0/64（模式 A）、0/64（模式 B 加矩陣層）** |
| 讀取器（`algo_intent_core.reader`）讀得出 UML | 38/64；讀出的 38 題中 `algo` 為 null 的 36 題、**錯認 2 題**（`lx-huffman-cost`→`list-sum`、`lx-xz-delta`→`kth-largest`，後者還會挑出 `sort.kth-largest` 骨架——假陽性） |
| 命中任何範式骨架的題數 | 1（就是上面那個錯認的） |

一句話：**不是積木語法表達不出來（來回 64/64），而是題型辨識、輸入形狀、切割模板、範式、位元／位元組積木這五層都沒跟上。** 27 個範式全是競賽式「整數／清單進、一個答案出」；這批題是「文字行串流」「二進位欄位表」「位元流」「狀態機／直譯器」四大類，一題都不在其中。

### 前五大缺口（詳見 §4）

1. **G1 讀取器：敘述→意圖／輸入形狀**（P0，補 Blockly 讀取器與動作表）：36/38 題 `algo=null`；「第一行 n，接著 n 行文字」被讀成 `scalars:int`（行內容整段丟失）；單行十六進位串只讀成 `str`；多段輸入（旗標行＋樣式行＋資料段、兩個「檔案」）讀不出；另 26 題連 UML 都讀不出。
2. **G2 UML 切割：只有一種固定切法**（P0，補 UML 層＋Blockly 範式）：`scenarioToModel` 永遠切成 `Solver.main／readInput／solve` 三個操作；沒有「格式編解碼（reader＋writer 成對）」「斷詞→剖析→求值」「狀態機」等切法，也沒有輔助函式操作。
3. **G3 位元／位元組／格式化積木全缺**（P0，補 Blockly 積木）：積木庫（`py_blocks_core` 90 範本＋`py_blocks_lib_core`）完全沒有 `& | ^ << >>`、`ord／chr`、`int(x,16)`、`"%02x"／"%08x"／"%6d\t"` 格式、`hex／bin`、`bytes／struct`、`startswith／find／replace／isdigit／ljust／zfill`、`try`、`def`。（走「程式：」原樣行可以過，但不是可教的積木。）
4. **G4 「欄位表」式二進位格式範式**（P0，補 Blockly 範式）：BMP 檔頭、tar 標頭、gzip 成員、xz 標頭都是「位移＋寬度＋端序＋有無正負號」的欄位表，讀（parse）寫（pack）對偶；一個範式 `binfmt.field-table` 可蓋 15 題以上。
5. **G5 文字行過濾器範式族**（P0，補 Blockly 範式）：cat／grep／管線共 16 題，骨架幾乎同一個（讀 n 行→每行過濾／轉換→帶行號或計數輸出），旗標是槽位。

## 1. 每個工具的最小單元（契約／資料結構與演算法／Blockly）

契約一律是「判題器 stdin 文字進、stdout 文字出」。二進位資料用小寫十六進位字串當代理（原因見 G15）。範式欄的「（新）」＝現有 27 個範式沒有，需新增；「近似」＝可由現有骨架延伸。題目 id 前綴 `lx-`。層別代碼：**R**=讀取器辨識不到題型／algo、**S**=輸入形狀讀錯、**P**=沒有範式、**K**=缺積木、**A**=缺演算法、**D**=骨架不能含 `def`／輔助函式、**J**=判題不支援（真二進位／檔案／argv／行程）。目前每一題都卡在 R（或 S）→ P，下表只列「補上 R／P 之後還會卡的」。

### xxd（hex dump／反向）

| 單元 id | 輸入→輸出契約 | 資料結構／演算法 | 範式／積木 | 補完 R／P 後仍缺 |
|---|---|---|---|---|
| xxd-encode | 一行 ASCII→兩位十六進位相連 | 逐字元 `ord`＋`%02x` | 逐字映射（新：`str.map-join`）／積木 `ord`、`格式化十六進位` | K |
| xxd-decode（holdout） | 十六進位→文字 | 每 2 字元 `int(,16)`＋`chr` | 同上／`int(x,16)`、`chr` | K |
| xxd-bits | 小寫文字→每字元 8 位二進位 | 位元移位取位 | `bits.expand`（新）／`>>`、`&` | K |
| xxd-dump（holdout） | 十六進位（≤40 位元組）→每 16 位元組一行 offset: 組 ascii | 切塊、分組、`ljust`、可印字元判斷 | `chunk.rows`（新）／`ljust`、條件式 | K |
| xxd-reverse | n 行傾印→十六進位 | 固定欄位切片（col 11–49）＋`split` | `line.slice-fields`（新） | S |

### cat

| 單元 id | 契約 | 演算法 | 範式／積木 | 仍缺 |
|---|---|---|---|---|
| cat-n | n 行→加寬 6 行號＋Tab | 計數器＋格式 `%6d\t` | `lines.map`（新，G5）／格式化 | K |
| cat-ns（holdout） | 壓縮連續空行並編號 | 前一行是否空行（一格狀態） | `lines.filter-state`（新） | — |
| cat-A | Tab→`^I`、行尾 `$` | `replace` | `lines.map` | K（`replace`） |
| cat-two（holdout） | 兩個「檔案」連接、行號連續 | 兩段輸入 | `lines.concat`（新） | S（多段輸入） |

### grep

| 單元 id | 契約 | 演算法 | 範式／積木 | 仍缺 |
|---|---|---|---|---|
| grep-fixed / -i / -v(holdout) / -n / -c(holdout) | 樣式＋n 行→符合的行／行號前綴／計數 | 子字串、`lower`、取反、計數 | `lines.filter`（新，旗標為槽位）；現有積木有 `小寫`、`在裡面` | S |
| grep-flags（holdout） | 旗標行＋樣式＋n 行 | 旗標解析＋以上組合 | `lines.filter` 多槽位（-i -v -n -c 四個布林槽，窮舉 ≤16） | S（旗標行） |
| grep-o | 不重疊出現次數與逐個輸出 | 掃描（i += len） | `scan.nonoverlap-count`（近似 `str.kmp-count`） | — |
| grep-w（holdout） | 整字比對 | `split(" ")` 後成員判斷 | `lines.filter` | — |
| regex-kp（holdout）★ | `. * ^ $` 的 Kernighan–Pike 比對 | **遞迴回溯**（`match_here`／`match_star`） | `regex.backtrack`（新） | **D**（遞迴要 `def`）、A |
| regex-class | `[abc] [^ab] . ? + *` 全行符合 | 剖析樣式→單元；二維 DP（i,j） | `dp.regex`（新，近似 `dp.lcs` 的二維 DP 殼） | A |
| glob | `* ?` 全字串比對 | 二維 DP | `dp.glob`（新，近似 `dp.lcs`） | — |

### eval

| 單元 id | 契約 | 演算法 | 範式／積木 | 仍缺 |
|---|---|---|---|---|
| eval-tokenize | 算式→NUM/OP/LP/RP 逐行 | 字元掃描狀態機 | `lexer.scan`（新，G10） | K（`isdigit`） |
| eval-rpn | 後序式求值 | 堆疊 | 近似 `stack.brackets`（新：`stack.eval-rpn`） | — |
| eval-infix2rpn（holdout） | 調度場 | 運算子堆疊＋優先級表 | `stack.shunting-yard`（新） | — |
| eval-arith（holdout）★ | 含括號四則、向 0 取整除 | **遞迴下降**（expr/term/factor），或調度場＋RPN 兩段 | `parser.recursive-descent`（新）／可改寫成調度場＋RPN（無 `def`） | **D**、A |
| eval-vars | n 行 `名稱 = 式子` 直譯 | 字典環境＋兩級優先序 | `interp.assign-env`（新） | A |
| vm-exec（holdout） | 堆疊虛擬機：PUSH/LOAD/STORE/ADD/SUB/MUL/JZ/JMP/PRINT | **pc 迴圈＋指令分派** | `interp.dispatch`（新，G12） | A |

### exec（沙盒內可行的子集）

真 `fork／execve／pipe／waitpid`、信號、環境繼承在判題沙盒不可行（子行程判決不確定），**只拆到「純函式可驗證」的部分**：參數切分、環境展開、管線的資料流語意。

| 單元 id | 契約 | 演算法 | 範式／積木 | 仍缺 |
|---|---|---|---|---|
| exec-argv | shell 風格命令列→argv（單／雙引號、反斜線、空參數） | **字元狀態機**（引號內／外、跳脫） | `lexer.state-machine`（新） | A（空參數需「has」旗標） |
| exec-env（holdout） | `$X` `${X}` 展開 | 掃描＋字典 | `str.template-expand`（新） | — |
| exec-pipeline | `cmd1 \| cmd2`（upper/rev/sort/uniq/tac/head/tail/wc/grep） | 命令表分派＋清單轉換串接 | `interp.dispatch` | — |

### tar

| 單元 id | 契約 | 演算法 | 範式／積木 | 仍缺 |
|---|---|---|---|---|
| tar-blocks（holdout） | 大小→區塊數、封存檔大小 | 向上取整到 512 | `align.up`（新，G9） | — |
| tar-offsets | 多檔→標頭／資料位移 | 累加 `512 + align(size)` | `align.up`＋累加 | — |
| tar-checksum | 組標頭→檢查碼（chksum 欄先當空白）八進位 6 位 | 欄位表＋加總＋`%06o` | `binfmt.field-table` | K（八進位格式） |
| tar-write（holdout） | 單檔 ustar 完整封存檔→十六進位 | 欄位表 pack、補 0、結尾 1024 個 0 | `binfmt.field-table`（寫） | K |
| tar-parse | 十六進位封存檔→列出 名稱 大小 | 讀欄位（NUL 結尾字串、八進位數字）、依 size 跳區塊 | `binfmt.field-table`（讀）＋`align.up` | K |

### gzip／DEFLATE（LZ77＋Huffman、CRC32）

| 單元 id | 契約 | 演算法／資料結構 | 範式／積木 | 仍缺 |
|---|---|---|---|---|
| crc32 / crc32-table(holdout) | 文字→8 位十六進位 | 位元迴圈＋多項式；256 項查表 | `checksum.crc32`（新） | K（`^ >>`、`0x…`） |
| adler32 | 文字→8 位十六進位 | 兩個累加器 mod 65521 | `checksum.mod-sum`（新） | — |
| lz77-encode（holdout） | 貪婪最長匹配（視窗 16、最短 3、可重疊） | 雙層迴圈＋平手規則 | `lz77.greedy`（新，G13） | A |
| lz77-decode | `<L,d>` 記號→字串（逐字元複製） | 往回複製、可重疊 | `lz77.copy`（新） | — |
| huffman-cost | 頻率→最佳編碼總位元 | 反覆合併最小兩個（堆積） | 近似 `heap.kth-smallest`（新：`heap.huffman-merge`） | — |
| canonical-huffman（holdout） | 碼長→RFC1951 範式碼 | bl_count／next_code 兩段、位元字串輸出 | `huffman.canonical`（新） | K |
| bit-reader | 位元組＋欄位寬→值（LSB 先） | 位元游標 | `bitstream.reader`（新，G6） | K |
| deflate-stored | 文字→stored 區塊十六進位 | pack：旗標＋LEN＋NLEN 小端 | `binfmt.field-table`（寫）／`le` 打包 | K |
| gzip-member（holdout） | 文字→完整 .gz（標頭＋stored＋CRC＋ISIZE） | 以上＋CRC32 整合 | `binfmt.field-table`＋`checksum.crc32` | K、整合題 |
| gunzip-stored | .gz→文字或 CRC ERROR | 解析＋驗證 | 同上（讀） | K |
| inflate-fixed ★ | 固定霍夫曼區塊→字串 | **位元流＋固定碼解碼＋長度／距離表＋LZ77 複製** | `bitstream.reader`＋`huffman.fixed-decode`（新）＋`lz77.copy` | **D**（巢狀 `bit()/lsb()/msb()/sym()` 閉包）、K、A |

（動態霍夫曼區塊 inflate 沒出題：需要碼長碼的碼長（HCLEN）剖析，屬 inflate-fixed 的下一層，建議在 G6/G13 完成後再加，見 §5。）

### xz（LZMA 概念層級：結構、範圍編碼）

| 單元 id | 契約 | 演算法 | 範式／積木 | 仍缺 |
|---|---|---|---|---|
| xz-varint-dec / -enc(holdout) | 多位元組整數（每位元組低 7 位、高位續） | 位元移位累加 | `varint.leb`（新） | K |
| xz-header（holdout） | 12 位元組串流標頭：魔術數字＋旗標＋CRC32 | 欄位表＋CRC32＋三種判決 | `binfmt.field-table`＋`checksum.crc32` | K |
| xz-delta | Delta 過濾器還原 | 前項回饋（輸出距離 d） | `filter.delta`（新；近似 `prefix.range-sum`） | — |
| lzma-rc-bits（holdout） | 單一自適應機率的二元範圍解碼 | 32 位元 range／code 算術、機率更新、正規化 | `rangecoder.bit`（新）| K、A（超出 Blockly 的邊緣，見 G14） |
| lzma-literals | 256 節點位元樹字面量解碼 | 上者＋位元樹索引 `m=m*2+bit` | `rangecoder.bit-tree`（新） | K、A |

LZMA 的 match／rep0–3／距離槽／狀態轉移機、LZMA2 區塊分塊、BCJ 過濾器**沒拆**（見 G14）。

### BMP reader／writer

| 單元 id | 契約 | 演算法 | 範式／積木 | 仍缺 |
|---|---|---|---|---|
| bmp-header | 十六進位檔→width/height/bpp/offset/order（高度可為負＝top-down） | 小端有號／無號欄位讀取 | `binfmt.field-table`（讀） | K |
| bmp-stride（holdout） | 寬、位元深度→stride、padding | `(w*bpp+31)//32*4` | `align.up` | — |
| bmp-pixel（holdout） | 24 位元、指定 (x,y)→RGB | 列序翻轉＋stride＋BGR | `binfmt.pixel-at`（新，G8） | K |
| bmp-write24 | 像素網格→完整 24 位元 BMP（bottom-up、BGR、補列） | pack 檔頭＋列反序＋補 0 | `binfmt.field-table`（寫）＋`image.rows-bottom-up`（新） | K |
| bmp-write8（holdout） | 調色盤＋索引→8 位元 BMP | 同上＋調色盤區 | 同上 | K |
| bmp-read8 | 8 位元調色盤檔→由上到下 RGB 十六進位 | 讀調色盤＋索引→顏色 | `image.palette-lookup`（新） | K |
| bmp-read1（holdout） | 1 位元檔→逐像素索引 | 位元解包（MSB 先）＋32 位元列對齊 | `bits.unpack-msb`（新） | K |
| bmp-gray | 24 位元→灰階 `(R*299+G*587+B*114)//1000` | 讀像素＋映射 | `image.pixel-map`（新） | K |

### 周邊（跨工具共用）

| 單元 id | 契約 | 範式／積木 | 仍缺 |
|---|---|---|---|
| base64-encode(holdout)/decode | 3 位元組→4 個 6 位元群 | `bits.regroup`（新，6↔8 位元重組） | K |
| endian-pack | 值＋位元組數＋端序→十六進位 | `le/be pack`（新積木） | K |
| rle-encode | 連續相同字元→次數＋字元 | `scan.run-length`（新；近似 `tp.palindrome` 的掃描殼） | — |

## 2. 用現有離線流程逐題試的結果

方法：`FA_TS_DIR=/tmp/fa-ts-cache`，沿用 `scripts/eval/bench_coverage.js` 的接法（`UC.scenarioToModel(statement,{readers:[AI.reader]})` → `PL.buildFromUML`，無模型；模式 A＝配方→課→範式，模式 B＝再加矩陣層 `matrix_synth_core`），判題器 `judge-runner.js`（含隱藏測資，tokens 比對）。另寫分析腳本（放 scratchpad，未入庫）量：參考解在判題器是否 AC、參考解經 `C2U.fromTree → toPython` 來回是否 AC、讀取器讀出的 `algo／inputs／verbs`、`Paradigms.forIntent` 有無骨架。

| 層 | 結果 | 說明 |
|---|---|---|
| 判題 | 64/64 參考解 AC | 文字 IO 夠用；二進位全部走十六進位字串（G15） |
| 語法／IR 表達力 | 64/64 來回 AC | `def`、閉包、`try`、位元運算、`%` 格式、推導式、切片步長、`bytes／struct` 在整份程式層級都保得住 |
| 讀取器辨識 UML | 38/64 | 26 題「這份 UML 不是算法題讀取器讀出來的」（多為 crc／base64／bmp／tar-checksum／xz-header 等「單行字串進」題型） |
| 讀出後的 `algo` | 36 個 `null`、2 個錯認 | 錯認：`lx-huffman-cost`（`list-sum`）、`lx-xz-delta`（`kth-largest`） |
| 輸入形狀 | 多數錯 | n＋n 行文字→`scalars:int`（grep／cat／regex／glob／pipeline／env）；`lx-vm-exec`→`scalars:int,grid`；`lx-bmp-write8`→`list`；`lx-grep-*`→`scalars:int,scalars:int`（把樣式字串當整數） |
| 命中範式骨架 | 1（錯認那題） | 27 個範式沒有任何一個與這批題同型 |
| 配方／課 | 0 | 配方只認運算式、單清單 max/min/sum、單字反轉 |
| 矩陣層（模式 B） | 0 | 全部以「不是一個整數進一個整數出／輸入輸出形狀不是單行單詞」拒絕；其中 `dfa` 候選對 crc32、crc32-table、base64、inflate-fixed、gunzip-stored 等「單行字串」題嘗試過並被判題器擋下（RE／WA），沒有誤收 |
| 「CNL 程式區塊」路徑 | **巢狀 `def` 被丟掉** | 實測 `程式區塊：` 含 `def f(x)…` 後只剩 `print(f(2))`（`def` 不見）——這就是 DESIGN.ast-nodes §7.3「骨架不能含 def」；閉包（`pos=[0]; def g()`）同樣；`try/except` 在 CNL 路徑保得住 |

標記為 train 的 37 題可拿來教；27 題 holdout 在補完範式後用來驗證泛化（`py_paradigms.test.js` 的作法：換變數名稱＋換測資，不給課）。

## 3. UML → 任務切割 → Blockly：整條路在哪裡斷

| 階段 | 現況 | 這批題的問題 |
|---|---|---|
| ① 敘述→UML（`scenarioToModel`＋`algo_intent_core.reader`） | 只認固定句型的算法題；輸入形狀只有 `scalars／list／words／str／grid／rows` | (a) 工具型題沒有「算法名」可映射（G1）。(b) 「本題的輸入是一份格式（十六進位位元組）」「輸入是 n 行文字＋旗標」不是形狀（G1、G2）。(c) 沒有「規格即題目」的題型：敘述把整個演算法寫出來，要做的是**照規格翻譯**而不是**選演算法** |
| ② 切割（UML 操作） | 固定三操作 `read_input／solve／main`；`mkModel` 寫死三個 op | 沒有輔助操作（`tokenize`／`parse`／`emit`／`crc32`／`le_pack`），所以遞迴、共用的 CRC、位元讀取器沒地方放（G5、G2）。整合題（gzip-member＝CRC＋pack＋stored）需要「把一題切成幾個已會的單元再組合」，現在沒有組合機制 |
| ③ 骨架（範式） | 27 個，骨架不能含 `def`、不能有連續賦值 | 缺少這四類範式家族：行過濾器、欄位表二進位格式、位元流、狀態機／直譯器（G3–G12） |
| ④ 積木（block）迴圈 | 90 範本＋40 專用＋54 運算式，領域偏數學／繪圖 | 沒有位元運算、`ord/chr`、十六進位格式化、字串方法（`startswith/find/replace/isdigit/ljust/zfill`）、`try`、`def`（G3） |
| ⑤ 判題 | stdin 為 JS 字串、stdout 以 utf8 解碼、`tokens` 比對 | 沒有位元組 IO、檔案夾具、argv、結束碼、環境變數（G15）；這批題以十六進位字串繞過，但「真的讀寫二進位檔」「真的 exec」無法驗證 |
| ⑥ 備援鏈（矩陣層→上網／CoLU／待補教學） | 矩陣層只做「整數進整數出」類 | 這批題對它全是 N/A；應直接落到「待補教學」並帶上規格段落（G14、G17） |

另一個流程層的提醒：`scripts/eval/bench_coverage.js` 以 `/^bench_.*\.jsonl$/` 掃種子目錄，**新增的 `bench_linux_all.jsonl` 會被併進既有基準**（60 題→124 題），使 DESIGN.matrix-fallback.md §9 的數字不可直接比較。建議 matrix-fallback-1 加 `--only`／`--skip linux` 過濾（我沒改該檔），或在比較時用 `LX*` 等級分開看（腳本已按 level 分組輸出）。

## 4. 缺口清單（優先序 P0 最高；「補 Blockly」＝由 blockly-teach 補；「超出」＝Blockly 不該補、交給別層）

| # | 缺口 | 類型 | 優先 | 影響題數 | 建議補法 | 歸屬 |
|---|---|---|---|---|---|---|
| G1 | 讀取器辨識不到題型／輸入形狀：`algo=null`、n＋n 行文字被讀成整數、樣式字串被當整數、單行十六進位只讀成 `str`、多段輸入（旗標行＋樣式行＋資料段／兩個檔案）讀不出 | 題型（讀取器） | **P0** | 64（全部） | 動作表加工具型動詞（`行號／過濾／十六進位／校驗／打包`）；新增輸入形狀 `lines(n)`（n 後接 n 行文字）、`hexbytes`（單行十六進位）、`flagline`（旗標行）、`sections`（多段）；讀取器改由「形狀＋動詞」映射到範式 id，而不是只看算法名 | 補 Blockly |
| G2 | UML 切割只有一種切法：固定 `Solver` 三操作；沒有輔助操作、沒有「格式編解碼」「管線（斷詞→剖析→求值）」「狀態機」切法，整合題無法拆成已會單元再組合 | 切割 | **P0** | 約 40（所有需要輔助函式或整合的） | 切割模板庫：`codec`（欄位表＋parse＋pack 對偶）、`pipeline`（lex→parse→eval）、`state-machine`（狀態×輸入表）；`mkModel` 允許額外 op（輔助函式）；整合題＝單元的 `call` 組合（先會 crc32、le_pack，再組 gzip-member） | 補 Blockly（切割層屬 uml 與 pipeline，與 blockly-teach 協調） |
| G3 | 位元／位元組／格式化積木全缺（`& \| ^ << >>`、`ord/chr`、`int(x,16)`、`%02x／%08x／%6d`、`hex/bin`、`bytes/struct`、`startswith/find/replace/isdigit/ljust/zfill`、`try`） | 積木 | **P0** | 約 45 | 在 `py_blocks_lib_core` 的 `EXPR_EXTRA` 補一組「位元組·位元」「字串·進階」積木（保持一個積木一個 Python 運算式，CNL 為中文）；`格式化十六進位 {a} 寬 {n}` 之類包 `%0nx`；單元測試沿用 `py_blocks.test.js` 的往返檢查 | 補 Blockly |
| G4 | 沒有「欄位表」式二進位格式範式（位移／寬度／端序／正負號；讀＋寫對偶） | 範式 | **P0** | 約 18（bmp 8、tar 5、gzip 3、xz 1、endian 1） | `binfmt.field-table`：槽位＝欄位表（以題目敘述的欄位列抽出）、方向（read／write）、端序（le／be）、有號；骨架本文不用 `def`（用 `for` 逐欄位＋位移累加），配合 G9 的 `align.up`、G7 的 CRC | 補 Blockly |
| G5 | 行過濾器範式族缺（cat／grep／管線；旗標＝槽位） | 範式 | **P0** | 16 | `lines.map`／`lines.filter`（槽位：忽略大小寫、取反、行號前綴、只計數、整字、壓縮空行、`replace` 規則）；窮舉組合 ≤ 16；旗標行靠 G1 的 `flagline` 形狀 | 補 Blockly |
| G6 | 骨架／CNL 路徑丟掉巢狀 `def`；遞迴、閉包做不出來 | 骨架限制 | P1 | 4（regex-kp、eval-arith、inflate-fixed、vm 之外的遞迴題） | 兩條路：(a) 讓 `stmtsOfSource` 保留 `def`（需改 `py_blocks_core`）；(b) 為遞迴題準備**無 def 改寫**（調度場＋RPN 取代遞迴下降；顯式堆疊取代回溯）。建議先 (b) 做 `eval-arith`，再評估 (a) | 補 Blockly |
| G7 | 校驗碼範式缺（CRC-32 位元／查表、Adler-32） | 範式 | P1 | 8（crc32、crc32-table、adler32、xz-header、gzip-member、gunzip-stored、tar-checksum、…） | `checksum.crc32`（槽位：位元式／查表式；初值；最後取反）、`checksum.mod-sum` | 補 Blockly |
| G8 | 位元流範式缺：LSB 先位元讀取器、MSB 先碼、固定霍夫曼解碼、位元重組（base64、1 位元 BMP） | 範式＋演算法 | P1 | 6 | `bitstream.reader`、`bits.unpack-msb`、`bits.regroup`、`huffman.fixed-decode`（依 RFC1951 §3.2.6 的固定碼區間表） | 補 Blockly |
| G9 | 對齊／填充與列序：`align.up`、bottom-up 列序、stride | 範式（小） | P1 | 8（bmp-stride、tar-blocks、tar-offsets、bmp 系列） | `align.up`（槽位：基數 4／512、含／不含零長度）；`image.rows-bottom-up`；兩者可先做成**配方**（算式固定） | 補 Blockly |
| G10 | 詞法／狀態機範式缺（斷詞、argv 引號跳脫） | 範式 | P1 | 3（tokenize、argv、eval-vars 的前段） | `lexer.scan`、`lexer.state-machine`（槽位：狀態集合、轉移表由敘述的規則抽出） | 補 Blockly |
| G11 | 運算式求值範式缺（RPN、調度場） | 範式 | P1 | 3 | `stack.eval-rpn`（近似 `stack.brackets`）、`stack.shunting-yard`；遞迴下降見 G6 | 補 Blockly |
| G12 | 直譯器／指令分派範式缺（指令表分派、pc 迴圈、環境字典） | 範式 | P2 | 4（vm-exec、eval-vars、exec-pipeline、exec-env） | `interp.dispatch`（槽位：指令集由敘述抽出）、`interp.assign-env` | 補 Blockly |
| G13 | 壓縮演算法範式缺：LZ77 貪婪、霍夫曼合併、範式霍夫曼、DP 比對（regex-class／glob）、Delta／RLE | 範式＋演算法 | P2 | 9 | `lz77.greedy`／`lz77.copy`；`heap.huffman-merge`；`huffman.canonical`；`dp.regex`／`dp.glob`（以 `dp.lcs` 為殼）；`filter.delta`、`scan.run-length`（可先做配方） | 補 Blockly |
| G14 | LZMA 完整流程：範圍編碼器的 32 位元算術與機率模型、match／rep／距離槽狀態機、LZMA2 分塊、BCJ | 演算法（規模） | P3 | 2（已出題）＋未拆部分 | **超出 Blockly 範式**：規格冗長且狀態多，範式槽位窮舉不經濟。建議走「待補教學（老師教→`deriveLesson` 收成課）」＋題目敘述自帶完整規格（本題庫兩題 `lzma-*` 已如此），可選上網補規格；目前只做到範圍解碼＋位元樹字面量，之後的 match 解碼不建議做成範式 | 超出（待補教學／上網） |
| G15 | 判題器不支援二進位 IO、檔案夾具、argv、結束碼、環境變數、子行程 | 判題 | P1（對真實 tar／gzip／exec 驗證）；P3（對本題庫，因已用十六進位代理） | 所有真實檔案題 | 擴充 `judge-runner`：`inputHex／outputHex`（以 Buffer 餵 stdin、比對 stdout 位元組）、`files:{名稱:hex}`（在 cwd 預置檔案）、`args:[…]`、`env:{…}`、`expectExit`；真 `exec` 只允許白名單命令（`echo／cat／sort`）並限時。**不是 Blockly 的事** | 超出（判題器；交 coding-ci／judge 維護者） |
| G16 | 真行程管理（`fork／execve／pipe／waitpid`、信號、重導向）無法在沙盒內驗證 | 題型 | P3 | 0（本題庫以 `exec-pipeline` 模擬資料流語意代替） | **超出**：只教概念（待補教學），範式只做「管線語意模擬」；不做真行程 | 超出（待補教學） |
| G17 | 讀取器假陽性：`huffman-cost→list-sum`、`xz-delta→kth-largest`，錯認後套錯骨架（`sort.kth-largest`），浪費窮舉並可能誤過弱測資 | 題型（讀取器） | **P0（便宜）** | 2（已確認）＋風險 | 讀取器的否決條件：輸入形狀與範式 `shape` 不符就不給骨架；輸出動詞不符（求「總位元數」≠`sum`）；範式需要的敘述關鍵詞（`第 k`）缺席就不選。補一組「近鄰但不同題」的負例測試 | 補 Blockly |
| G18 | 「規格即題目」的題型：敘述已寫出完整演算法（`lzma-rc-bits`、`inflate-fixed`、`gzip-member`），要做的是照規格翻譯而非挑演算法 | 題型 | P2 | 約 12 | 在讀取器加一個 `spec-translate` 類別：偵測大量步驟／公式／表格的敘述，直接走「區塊迴圈（模型微選擇）」或老師迴圈，而不是硬配範式；課記下敘述特徵以便下次命中 | 補 Blockly（讀取器分流）＋超出（模型／老師） |

**優先序依據**：P0 是「補了才有可能解出任何一題」且成本低／影響面廣者（G1、G2、G3、G4、G5、G17）；P1 是補了能再解出一整個家族者；P2 是單點但教學價值高；P3 與其硬補，不如明確交給別層。

## 5. 建議的補法順序（讓 blockly-teach 照做）

1. **G17＋G1 最小版**：加否決條件與 `lines(n)`／`hexbytes`／`flagline` 三個輸入形狀；用 `bench_linux_all.jsonl` 的 train 題確認「讀取器讀得出、不會錯認」。
2. **G3 積木**（位元、`ord/chr`、`int(x,16)`、`%0nx` 格式、字串進階方法）；先補，因為後面所有範式的骨架都要用。
3. **G5 行過濾器範式**（16 題，立即可量到 holdout 的泛化：`lx-cat-ns`、`lx-grep-v`、`lx-grep-c`、`lx-grep-flags`、`lx-grep-w`、`lx-cat-two`）。
4. **G9→G7→G4**：`align.up`（先做配方）、`checksum.crc32`、`binfmt.field-table`；holdout 觀察：`lx-bmp-stride`、`lx-tar-blocks`、`lx-crc32-table`、`lx-bmp-pixel`、`lx-tar-write`、`lx-bmp-write8`、`lx-xz-header`、`lx-gzip-member`。
5. **G2 切割模板**（`codec`／`pipeline`／`state-machine`＋輔助操作）；之後 **G6(b)**、G8、G10–G13。
6. G14／G15／G16 不由 Blockly 補：寫進「待補教學」清單與判題器需求，由協調 session 另派。

量測方式：每補一批就跑 `bench_coverage.js`（模式 A）看 `LX*` 的 train 與 holdout 分開的通過率；**holdout 的通過率才是泛化指標**，train 只代表教過的。再補完一族範式後，建議加一個 `py_paradigms` 風格的測試：選項反序仍解得出（證明是窮舉不是排前面），換變數名稱＋換測資仍解得出。

## 6. 題庫說明

- 檔案：`renderer/src/recipe/seed/bench_linux_all.jsonl`（64 題；`checker: tokens`；每題 `tests`（2）＋`hidden`（4–6；`lx-tar-write`、`lx-tar-parse`、`lx-inflate-fixed` 因輸出很長較少）；`ref.python` 為 `def main()`，與既有 `bench_*.jsonl` 同格式，另加 `split`（train／holdout）與 `tool` 欄位）。
- 重新產生：`python3 scripts/eval/gen_bench_linux.py`（固定亂數種子，輸出可重現）。產生器內含自我驗證：CRC32／Adler 與 `zlib` 一致；tar 標頭可被 `tarfile` 讀回；gzip 成員可被 `gzip.decompress` 解；固定霍夫曼流可被 `zlib.decompress(..., -15)` 解；LZMA 範圍編碼器與解碼參考解往返一致；BMP 寫入器與測資產生器一致；且每題每筆測資的輸出都不是空的（避免「什麼都不印」過關）。
- 與既有基準不重複：id 皆 `lx-` 前綴，題材不與既有 L0–L6 題重疊。
- 未涵蓋（刻意）：動態霍夫曼 inflate、LZMA match 解碼與 LZMA2、BMP RLE4／RLE8 與 32 位元／位元欄遮罩、tar 的 PAX／GNU 長檔名、真實檔案 IO、真行程。這些在 §4 對應 G14／G15／G16 或列為下一輪。
