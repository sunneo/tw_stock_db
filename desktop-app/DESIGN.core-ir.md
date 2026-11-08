# 跨語言核心中間語言、標準函式庫轉接層、行為描述（2026-11-08，調查＋設計＋最小驗證）

> 標記：【讀程式】＝我讀檔案確認；【實測】＝我用小程式跑過；【推測】＝沒驗證。程式在 `renderer/src/ir/`（純函式、UMD、不進產品、沒碰 `floating-assistant.js`）。測試：`ir.test.js`（48）、`ir_design.test.js`（7）、`ir_behavior.test.js`（4），已登記到 `scripts/run-core-tests.js`。

## 0. 結論先講

1. **兩條路都要，順序是「行為描述先、完整節點樹後」，而且共用同一份標準操作目錄。** 行為描述（每個函式一份語言中立的摘要）現有零件就能產生，涵蓋語言最多、風險最低，足以支撐「抽回設計→分析→改設計」；但它**不含函式本體，無法精準重現行為**。要「精準轉成目標語言」，一定要有完整節點樹（中間語言）。行為描述是中間語言的上層摘要，不是替代品。
2. **標準函式庫轉接層不要另造，也不能直接拿單元目錄當它。** 單元目錄（`catalog/`）是「每個執行環境各自的呼叫原型」，沒有「跨語言同一個語意」這個概念。做法：新增一層「語意操作」（本次做的 72 個），單元目錄當它下面的「各語言呼叫原型」資料來源（第 3.4 節）。
3. **【實測】最小驗證全過**：Python → 中間語言 → nodejs／java／c，10 個樣本函式組在 nodejs 10/10、java 10/10、c 8/8（字典與字串串列正確拒絕，不亂翻）實際編譯執行，輸出與 Python 逐行一致；Python → 中間語言 → Python 往返一致；註解、docstring、位置全數保留。實測抓到 4 個**真的會出錯的語意陷阱**（第 5 節），都在目錄裡處理了，並用「天真翻譯」對照組證明樣本測得到差異。
4. **沒做到的（誠實）**：c++、c#、ruby、perl 只有目錄樣板（靜態一致性測過，**沒有輸出器、沒有實跑**）；ruby 這台沒裝；c# 有 dotnet 8 SDK 但判題器要 mono，沒試；perl 在專案裡沒有 tree-sitter 文法（第 1 節），「進」做不了。node 之外的語言「進」（從 java／c 原始碼進中間語言）都還沒做。

## 1. 現況盤點【讀程式】

| 項目 | 現況 | 位置 |
|---|---|---|
| tree-sitter 載入 | web-tree-sitter 0.20.8＋tree-sitter-wasms 0.1.11（ruby 用 0.1.6，因為新版在 0.20.8 上會當掉）；第一次從 CDN 下載，存本機快取 | `renderer/src/floating-assistant.js:77738-77750`（`_behTsHost`）、`DESIGN.behavior-analyzer.md` 13.1 |
| 專案認得的語言（文法名稱） | c、cpp、rust、go、java、python、javascript、bash、c_sharp、ruby、lua；**沒有 perl** | `renderer/src/behavior/engine_5_api.js:5`、`engine_4_analyze.js:189`（副檔名對照） |
| 本機已快取的文法檔【實測】 | c_sharp 3.98MB、cpp 4.66MB、java 0.43MB、javascript 0.64MB、python 0.48MB、ruby 1.0MB、lua、rust；**c、bash 還沒下載過**（要網路）；tree-sitter 本體 js 72KB＋wasm 187KB | `%TEMP%\fa-ts-cache` |
| tree-sitter-wasms 有沒有 c／perl | c、bash 在名稱表裡，所以套件應有；perl **【推測】沒有**（專案裡完全沒有 perl 的剖析路徑），需要下載才能確認，本案不下載 | — |
| 行為分析器（FaBeh2） | 每個函式輸出：名稱、行號範圍、47 類行為分類、呼叫清單、分支／迴圈數、複雜度、開頭註解；另有呼叫圖、資料流。**沒有**簽名與型別、標準操作語意、前後條件、純度 | `renderer/src/behavior/engine_1..5_*.js`、`DESIGN.behavior-analyzer.md` |
| 函式定義庫 | `behavior_patterns.json`（279KB，呼叫名稱→分類）、`api_semantics.json`（487KB，C 340／JS 38／Python 35／Java 17 個函式有引數與回傳語意）、`names_more_langs.json`（267KB）、`names_cpp_rust_go.json`（106KB） | `renderer/src/behavior/*.json`、`DESIGN.behavior-analyzer.md` 10.1-10.2 |
| Blockly | **專案沒有 Google Blockly**；「區塊」是自己的範本庫（127 個陳述範本＋99 個運算式積木），**只有 Python**（檔頭寫「每個語言各自一份範本庫」） | `renderer/src/uml/py_blocks_core.js`、`DESIGN.ast-nodes.md` 6.2、7 |
| 程式→UML | Python 專屬，敘述樹到指令層級；**註解被丟掉**（`named()` 過濾掉 `comment` 節點）；參數型別只留標註文字（`type` 是 any）；try／with 等收成 `raw` | `renderer/src/uml/py_code2uml_core.js:20`、`:235` |
| UML 骨架多語言 | 只有 python、typescript、java 三種範本，型別對照表只有這三種 | `renderer/src/uml/uml_core.js:203-213`、`design_core.js:569` |
| UML 編修 | 13 種指令（含 add_member／remove_member／add_step），套用後整理並退回造成新錯誤的編修；沒有「改名」 | `renderer/src/uml/uml_edit_core.js:19`、`:46` |
| 單元目錄 | 單元＝一個執行環境的一個可呼叫物；`id` 如 `py:statistics.mean`、`js:…`、`tool:…`；Python 型別表 490 模組／3412 函式（typeshed，`stdlib_types.json` 844KB）；欄位有型別、副作用、可用性、測試案例 | `DESIGN.unit-catalog.md` 二、十二、十三、十八；`renderer/src/catalog/catalog_core.js:192,211`、`extract_js.js:172` |
| LLVM IR | 自己的 IR→wasm，用來**執行與驗證**；轉不回可讀原始碼 | `renderer/src/uml/llvm_core.js` 檔頭、`DESIGN.uml-framework.md` 166 節 |
| 判題器 | 11 種語言的編譯／執行命令（csharp 要 mono） | `judge-runner.js:14-30` |
| 本機工具鏈【實測】 | node 16、python 3.10（`python`；`python3` 是商店殼會失敗）、java 17／javac、gcc 13.3（mingw64 版可用）、perl 5.32、dotnet 8 SDK；**沒有 ruby、mono** | — |

## 2. 中間語言設計

### 2.1 形狀（`ir_core.js`）
`{ ir:'fa-core-ir', v:1, src:{lang}, name, imports, body:[節點], entry }`。節點共通欄位：`k`、`pos:[起行,起欄,迄行,迄欄]`、`c:{b:[前置註解], a:行尾註解, sp:前面空行數}`。

| 類別 | 種類 |
|---|---|
| 敘述 | `func`（參數、回傳型別、docstring、`locals`）、`assign`（`decl`、`ty`）、`aug`、`if`（elif 攤成巢狀）、`while`、`forrange`（from／to／step，step 必為常數）、`foreach`、`ret`、`brk`、`cont`、`pass`、`expr`、`raise`、`comment`（獨立成行）、`import`（原文）、`declare`（提升的宣告）、`native` |
| 運算式 | `lit`（int／float／str／bool／none）、`name`、`bin`、`un`、`cmp`、`logic`、`not`、`index`、`call`（**`op`＝標準操作 id**，接收者是 `args[0]`；**`fn`＝使用者函式**）、`list`、`dict`、`cond`、`native` |
| 型別 | `int float str bool void any unknown`，`list<T> dict<K,V> set<T> tuple<…>` |

**呼叫語意**：這是使用者要的「call function 產生語意」。`call` 只有兩種：標準操作（有目錄 id，帶語意）或使用者函式。依型別才有意義的運算子也在「降低」階段換成標準操作：`//`→`int.floordiv`、`%`→`int.mod`、`/`→`num.div`、`**`→`int.pow`、字串相加→`str.concat`、`in`→`coll.contains`、`sorted(字典)`→`dict.sorted_keys`、`[0]*n`→`list.filled`、`a, b = map(int, input().split())`→`str.split_ints`＋取值。所以每個「各語言行為不同」的地方都落在目錄裡，輸出器不必各自猜。

### 2.2 型別：動態與靜態
- 來源有標註就用標註；沒有就由字面值、操作回傳型別（`OPS.retType`）、賦值合流（`tyJoin`：unknown 讓位、int＋float→float、不同→any）推斷；推不出的標 **`unknown`**（和「明確任意」的 `any` 分開）。【實測】`dict` 的鍵／值型別能由後續 `d[k] = …` 補齊。
- 動態語言輸出器（python、nodejs、ruby、perl）遇到 unknown 照常輸出；**靜態語言輸出器（java、c、c++、c#）遇到 unknown 回報 error「請在來源標註型別」，不亂猜**【實測有測試】。
- 整數：中間語言的 `int` 是數學整數。對應 java `long`、c `long long`、nodejs `number`（超過 2^53 失精度，輸出器對大常數與位元運算發警告）。大整數要另開 `bigint` 型別（尚未做，列入風險）。

### 2.3 註解與空白（trivia）【實測】
- 前置註解（`c.b`）、行尾註解（`c.a`）、標頭行尾註解（`def … :  # 說明` 掛在函式的 `c.a`）、獨立註解（`comment` 節點）、docstring（`func.doc`，輸出成 JSDoc／Javadoc／`/* */`／docstring）、空行（`c.sp`）。
- **找到的坑**：tree-sitter 會把註解放在各種位置（函式標頭後的獨立註解成為 `function_definition` 的子節點、`# mid` 夾在 `if` 與 `elif` 之間成為 `if_statement` 的子節點、標頭行尾註解有時在區塊第一個子節點），不是都在「語句旁」，抽取器逐一處理。10 個樣本的註解數與中間語言裡的註解數**完全相等**。
- 輸出到 java：javac 預設用平台編碼（本機 Windows 繁中是 Big5）讀原始檔，註解裡的中文會讓編譯失敗。輸出器預設把註解的非 ASCII 字元逸出成 `\uXXXX`（選項 `asciiComments:false` 關掉，產品端若固定傳 `-encoding UTF-8` 就可關）。字串常數一律逸出。

### 2.4 來源位置、原生區塊、版本
- `pos` 記原檔行列，供 diff patcher（`DESIGN.code-repair.md` 4.1）定位、供錯誤回報；輸出器診斷帶回 `pos`。
- **`native{lang, src, why}`**：不認得的敘述／運算式（try、with、類別、生成式、lambda、關鍵字引數…）整段原文保留，不翻、不丟。輸出到同語言時原樣貼回；輸出到別的語言時回報 error，原文放成註解並丟「未翻譯」例外（編譯得過、執行時明確失敗，而不是悄悄少一段）【實測】。
- 版本：`v` 整數，驗證器拒絕比自己新的版本；新增節點種類只加不改，舊輸出器遇到不認得的種類回報 error。擴充規則：新語法先用 `native` 承接，累積到常見再升級成正式節點。

### 2.5 「精準轉為目標語言」的定義與驗收
**定義**：同一批輸入，目標程式的標準輸出與來源程式逐行相同（浮點用容許誤差的比對器）；錯誤情況（除以 0、越界、空容器）以「兩邊都失敗」為準，訊息不比。
**驗收**：①專案判題器；②判題器在這台機器的 java／c 不能用（下面第 5 節），改用直接編譯執行；③工具鏈不齊的語言標「未實跑」，只做靜態檢查（目錄一致性、`node --check` 類語法檢查）。**目前可實跑：nodejs、java、c；perl 有直譯器但沒輸出器；ruby 沒有；c# 要 mono 或自己建專案，未試。** 驗收樣本還要含**對照組**：把輸出裡的處理換成「看起來對」的天真寫法，必須有輸入答錯，才證明樣本測得到差異（已做）。

## 3. 標準函式庫通用轉接層（`ir_ops_core.js`）

### 3.1 結構
72 個語意操作，每個：`id`、參數型別、回傳型別、`sem`（純度／副作用／錯誤行為／複雜度）、**八個語言的樣板**（py、nodejs、java、c、cpp、cs、rb、pl；可依第 0 個引數型別分派，`null`＝沒有精準對應）、`pit`（語意差異與陷阱）、輔助函式（各語言一份，輸出器自動貼在檔案開頭並解相依）、匯入需求。

| 類別 | 操作 |
|---|---|
| io | print_line、read_line、read_all |
| conv | int、float、str、bool |
| num／int／math | abs、min、max、div、pow、floordiv、mod、sqrt、floor、ceil、gcd、round |
| fmt／rand／time | fixed、randint、now_seconds |
| coll／list | len、contains；new、filled、append、pop、insert、reverse、sorted、sort、index_of、copy、get、set、slice、min、max、sum |
| str | char_at、split_ws、split_sep、split_ints、strip、upper、lower、join、join_num、replace、startswith、endswith、find、concat、repeat、slice、is_digit、char_code、from_code |
| dict／set | new、get、get_default、put、delete、sorted_keys、keys；set.add |
| file／regex／json | read_all、write_all、search、dumps、loads |

【實測】覆蓋（有樣板的操作數／72）：py 72、nodejs 72、c# 72、java 70、ruby 71、perl 69、c 46、c++ 44。c 與 c++ 少是因為沒有內建的字串串列、字典、集合。60／72 個操作記有陷阱。樣板語法正確性只在 nodejs／java／c 以實跑驗證（見 5.2 用到的 19 個操作），**其餘語言與其餘操作是依知識寫的樣板，只通過靜態一致性（參數個數、輔助函式存在），沒有實跑**。

### 3.2 語意差異與陷阱（節錄；完整在各操作的 `pit`）
| 主題 | 差異 | 處理 |
|---|---|---|
| 整數除法與餘數 | Python／Ruby／Perl 向負無限取整、餘數與除數同號；C／C++／C#／Java／JavaScript 朝零截斷 | 一律用 floorDiv／floorMod 或輔助函式【實測：天真翻譯在 3 筆負數輸入上答錯】 |
| 溢位與大整數 | Python 無上限；Java／C 64 位元環繞；JavaScript 2^53 後失精度 | 目前只發警告；要 `bigint` 型別（未做） |
| 索引 | 負索引：Python 最後一個、JavaScript undefined、Java 例外、C 未定義 | 字面負索引改寫成 `len-k`；變數索引不處理，列為要使用者確認 |
| 字串長度與編碼 | Python 碼位、Java／JavaScript 碼元、C 位元組 | 目前不處理，目錄標明；非 ASCII 需使用者確認 |
| 排序 | JavaScript 預設字典序；C qsort 不穩定；Perl 預設字典序 | 數字給比較函式；整數串列看不出不穩定，記錄在 `pit` |
| 浮點格式化 | Java `String.format` 對平手「四捨五入」（0.125→0.13）；**JavaScript `toFixed` 也一樣**；Python／C 是精確值五成雙（0.12） | Java 用 `BigDecimal(精確值).setScale(HALF_EVEN)`；JavaScript 自寫精確展開＋五成雙輔助函式【實測：JavaScript 的 toFixed 在第一版就答錯，是測試抓到的，我原本以為 toFixed 沒問題】 |
| `round` | Python 五成雙；JavaScript `Math.round` 四捨五入且負數往正 | JavaScript 用輔助函式（有寫、**未用樣本實跑**） |
| 空值／缺鍵／空容器 | Python 丟錯；JavaScript 回 undefined；Java Map.get 回 null；C 未定義 | 輔助函式補丟錯（dict.get、list.pop、min／max 空串列） |
| 讀行 | 檔尾 Python 丟例外、Java 回 null、C 回 NULL | 統一成回空字串並標註 |
| 正規表示式 | 方言不同（命名群組、lookbehind、`\d` 是否含 Unicode） | 只保證簡單子集，其餘 `native` 並請使用者確認；**只有 `regex.search` 一個操作，尚無方言轉換器** |
| 可變與不可變、別名 | C 以值傳結構，對參數 append 不會回到呼叫端 | C 輸出器對「參數被增減元素」報 error【實測】 |
| Java 專屬 | 原始檔編碼（見 2.3）；HashMap 不保證順序 → 用 LinkedHashMap；`==` 比較包裝型別是比參考 → 取值時拆箱 | 輸出器處理【實測】 |

### 3.3 無法精準對應時
依序：①降級寫法（輔助函式實作，如 C 的串列）；②標「不支援」，輸出器回報 error 並指出是哪個操作、哪個語言、哪個型別（`render` 回 `missing`）；③原生區塊；④需要使用者確認的項目（變數負索引、非 ASCII 長度、大整數、正規表示式方言）列成診斷清單。**【實測】C 對字典與字串串列、Java 對 unknown 型別都會正確拒絕。**

### 3.4 能不能用單元目錄擴成這一層？
**判斷：不能直接擴，要疊一層；但單元目錄值得重用。**
- 單元目錄的單元 id 是 `py:…`、`js:…`，**每個單元只屬於一個執行環境**，型別詞彙是 `text/number/list<T>`，沒有「兩個環境的兩個單元語意相同」的欄位，也沒有樣板與陷阱。把它擴成跨語言層等於另建一層。
- 但它有三樣東西我們缺：Python 3412 個函式的簽名與型別（typeshed）、副作用細分、探測執行取得的實際型別。建議：目錄的每個語言格子**可選地**帶 `unit:'py:statistics.mean'` 連到單元目錄；不在 72 個操作內的呼叫，先查單元目錄得到簽名與副作用，做成 `call{fn:'lib', unit}`，輸出到別的語言時走「原生區塊＋要使用者確認」。這樣標準函式庫轉接層的擴充路徑是：高頻的人工進操作目錄（有樣板有陷阱有測試），長尾留在單元目錄（只有簽名）。
- 行為分析器的 `api_semantics`（引數與回傳值的意義）可當操作目錄 `sem` 的補充來源，不用另寫。

### 3.5 「抽回成設計」靠什麼
呼叫被認成標準操作之後，函式的語意摘要（用了 `io.read_line`＝讀標準輸入、`str.split_ints`、`io.print_line`＝寫標準輸出）、副作用、純度才算得出來；使用者函式則成為呼叫圖的邊。沒有這一層，只能知道「呼叫了名叫 split 的東西」。

## 4. 抽回設計與編修迴圈

### 4.1 兩條路的比較（使用者的折衷方案：先做行為描述）

| | 行為描述優先（第一層） | 完整中間語言（節點樹） |
|---|---|---|
| 內容 | 每函式：簽名、說明與註解、呼叫關係、用到的標準操作、副作用、控制流摘要（迴圈／分支／複雜度）、行為分類 | 整個程式的結構化樹，含每個運算式 |
| 來源 | 現有行為分析器（tree-sitter，**11 種語言**）＋簽名抽取＋由操作目錄自動建的反向索引 | 每個語言一份「進」（目前只有 python） |
| 精準度 | 描述準，但**無法重現行為**：只靠它產生程式只能得到骨架（簽名＋說明＋「待實作」）【實測：骨架可編譯，不假裝正確】 | 能精準轉換（實測 nodejs 10/10、java 10/10、c 8/8） |
| 涵蓋語言 | c、c++、rust、go、java、python、javascript、bash、c#、ruby、lua；**perl 沒有文法**（兩條路都一樣缺） | 每多一個語言多一份「進」＋「出」；目前進 1、出 4 |
| 工作量 | 小：已有 80% 零件（本次約 150 行） | 大：每語言「進」約 300 行＋「出」約 150 行＋樣板驗證 |
| 風險 | 低；描述的標準操作辨識靠名稱，同名多義（`split`、`join`）保留成候選 | 中：型別推斷、語意陷阱、大整數、native 比例 |
| 夠用的情況 | 看懂程式、畫架構圖／呼叫圖、改簽名／改名／刪函式、找副作用、評估能否翻譯、產生骨架 | — |
| 一定要完整節點樹 | — | 要精準翻譯函式本體；要改函式「裡面」的邏輯；要產生保留註解的程式再用 diff patcher 合併回原檔；要做步驟級驗證 |

【實測】兩種來源對 10 個樣本的 19 個函式：**函式名、呼叫關係、迴圈數、參數個數、副作用 19/19 一致**（行為分析器 vs 中間語言轉出）；中間語言用到的標準操作被行為描述找回 46/59（78%），標準操作重合度平均 0.65；python 與（由中間語言產生的）nodejs 兩份行為描述：呼叫關係、迴圈數、副作用 19/19 一致，操作重合度 0.54（因為 JavaScript 沒有等價的字串串列輔助函式名稱，且同名多義造成候選不同）。**【推測】** 差的部分主要是同名多義與型別資訊（行為描述沒有型別，無法依型別分派 `len`）；這就是為什麼「標準操作」精確度要靠第二層。

### 4.2 銜接方式（建議）
1. **同一份資料，兩個層級**：行為描述每筆有 `level`：1＝行為分析器產生，2＝由中間語言轉出（`fromIr`，同一形狀，`FaIrBehavior.fromIr`）。升級就是「同一個函式，拿到節點樹後把 level 1 換成 level 2」，上層（設計檢視器、UML）不用改。
2. **共用操作目錄**：行為描述用目錄樣板**自動反向建索引**（呼叫名稱→候選操作；`recognize`），不另維護名稱表。【實測】索引條目：py 45、nodejs 47、java 54、c 42、c++ 11、c# 52、ruby 23、perl 19。
3. **行為分析器的 47 類行為分類與 `api_semantics` 保留為補充欄位**，不重造。
4. 目錄新增一個操作或一種語言樣板，兩層同時受惠。

### 4.3 從中間語言抽設計（`ir_design_core.js`）
`extract` 回傳：函式簽名（含型別）、docstring、註解、呼叫圖、各函式用到的標準操作與次數、副作用（讀標準輸入／寫標準輸出／讀檔／亂數…）、純函式判斷、迴圈（最深層數）／分支數、白話摘要。`toUmlModel` 轉成 `uml_core` 的模型，【實測】10 個樣本都通過 `validateModel`，可轉 DSL 與 Mermaid；使用案例＝入口函式的呼叫順序。

### 4.4 編修迴圈
- **IR 層編修**（`applyEdit`）：改名（呼叫處一起改，名稱衝突／不合法被擋）、改參數／回傳型別、新增參數（目標語言不一定有預設參數，所以每個呼叫處補上預設值）。【實測】改名後重新產生 nodejs，10 筆輸出與改前相同、註解保留；新增參數後 java 能編譯、c 簽名正確。
- **UML 層編修接回**（`applyModelDiff`）：用 `uml_edit` 改完模型後，比對前後操作差異：刪操作（還有人呼叫就拒絕並說明）、加操作（產生「待實作」函式骨架，輸出器誠實回報有內容缺口）、簽名相同名稱不同推斷為改名。【實測】
- **已有／要補**：已有 `uml_design`（讀情境）、`uml_edit`（13 指令）、`design_core`（骨架）。要補：①`py_code2uml` 的註解與型別保留（改用中間語言當入口，或補丟掉的資訊）；②`uml_edit` 的「改名」「改簽名」指令；③`uml_core` 的語言表從 3 種擴到 8 種（型別對照可直接由目錄推）；④把產生的程式碼用 diff patcher 合併回原檔（`DESIGN.code-repair.md` 4.1，另一個工作階段在做）。

## 5. 最小驗證結果【實測】

### 5.1 數字
- `ir.test.js` 48 項：資料結構／驗證器（壞資料 9 類）、序列化穩定、目錄靜態一致性、降低與宣告、native 與 unknown 的誠實回報、Python→IR（0 原生區塊，註解數相等）、Python→IR→Python 往返（含「再轉一次 IR 相同」）、**端到端**：nodejs 10/10（走專案判題器）、java 10/10、c 8/8（`frequency`、`text-words` 預期被拒絕，也確實被拒絕）、對照組。整個檔約 55 秒。
- `ir_design.test.js` 7 項、`ir_behavior.test.js` 4 項。
- 樣本 10 組：加總、最大值位置（含 `a[-1]`）、質數個數（while／`%`）、迴文（字串索引）、字頻（字典）、泡沫排序（tuple 交換、串列索引賦值）、負數的 `//` 與 `%`、gcd／lcm（`a, b = map(int, input().split())`）、平均（`{:.2f}`，含 0.125）、文字（split／upper／字串連接）。實跑涉及 19 個標準操作（72 個中的 26%）。
- 對照組（天真翻譯答錯）：Java 的 `/` 與 `%` 3 筆、Java `String.format` 1 筆（0.125→0.13）、JavaScript `toFixed` 1 筆、JavaScript 截斷除法 3 筆、C 的 `/` 與 `%` 3 筆。

### 5.2 實測抓到的問題（都已處理或記錄）
1. **JavaScript `toFixed` 在精確平手時進位**（0.125→0.13，Python 是 0.12）：我寫目錄時以為沒問題，端到端測試抓到，改用精確展開＋五成雙輔助函式。
2. **Java 中文註解編譯失敗**（平台編碼）：註解逸出（2.3）。
3. **判題器在這台 Windows 對 java 逾時**：判題器用 `detached` 啟動並以 `process.kill(-pid)` 殺行程；在 Windows 上 `java` 是 `Program Files\Common Files\Oracle\Java\javapath` 的殼，殺不到孫行程，一次逾時要等約 45 秒才回（單獨跑 `java` 0.65 秒正常）。**根因是【推測】**，症狀是實測的。我沒有改判題器（不是我的模組）；測試改為 nodejs 走判題器、java／c 直接編譯執行。**這是另一個要處理的問題**。
4. **PATH 上排最前面的 gcc（msys 版）找不到 `stdio.h`**，判題器的 C 編譯在這台機器全是編譯失敗；mingw64 版 gcc 正常。測試自己找「真的能編譯含 stdio.h 的 gcc」，只在測試行程內使用，不改使用者環境。
5. Python 的 `python3` 在這台是商店殼（執行失敗，狀態 9009），判題器的 python 在這台等於不可用。
- 小事：tree-sitter 節點每次存取都是新的物件，不能用 `===` 比較（用 `id`／`startIndex`）。

### 5.3 沒驗證的
c++／c#／ruby／perl 的輸出器與樣板實跑；java／c 的「進」；浮點列印格式；大整數；字串非 ASCII 長度；`round` 輔助函式與其他沒被樣本用到的 53 個操作；tree-sitter 的 c、bash 文法（本機未快取）；perl 文法是否存在；行為描述在 nodejs 以外語言的抽取（只做了 python、javascript 兩個簽名抽取器，其他語言沿用行為分析器，只有名稱與行號）。

## 6. 實作階段與工作量、風險、要使用者決定的事

### 6.1 階段（建議）
| 階段 | 內容 | 可發布的小東西 | 工作量 |
|---|---|---|---|
| A | 行為描述接進 code edit：對任意檔案（行為分析器 11 種語言）顯示每函式的描述卡（簽名、標準操作、副作用、呼叫圖），資料同時餵 `uml_design`；補 java、c、c# 的簽名抽取器 | **「程式碼→函式行為卡」只讀功能**，不產生程式碼，風險最低 | 1 個工作階段 |
| B | 完整中間語言 python→nodejs／java（已有驗證）：加 python 的 try／with／類別／生成式的節點（取代 `raw`／`native`）、`bigint`、字串非 ASCII 長度確認 | 「把 python 函式轉成 JavaScript／Java」，附診斷與使用者確認清單 | 2-3 個工作階段 |
| C | 反向：nodejs→中間語言（tree-sitter-javascript 已在本機快取）、java→中間語言；做「進」就能把已有的 java／js 程式抽回設計 | 抽回設計不限 python | 每語言約 1 個工作階段 |
| D | 輸出器 c++（可由 c 輸出器改，加 STL 容器）、c#（需要 mono 或自己建專案才能實跑）、ruby／perl（先要有環境；perl 還要確認文法） | 擴語言 | 每語言約 1 個工作階段 |
| E | 編修迴圈完整化：`uml_edit` 加改名／改簽名、與 diff patcher 串接、`uml_core` 語言表擴到 8 種 | 「改設計→重新產生→合併回原檔」 | 2 個工作階段 |
**第一個可發布的小階段是 A。** 語言對先做 python→nodejs（最接近）、再 java，c 最後（受限最多）。

### 6.2 風險
- 範圍蔓延：Python 動態特性（生成式、lambda、類別、例外、裝飾器）很多，`native` 比例會高；用 `coverage.natives` 當進度指標。
- 型別推斷不足時，靜態語言輸出器會拒絕，使用者要補標註——是設計選擇，不是缺陷，但需要產品端有「補標註」的介面。
- 目錄樣板（尤其未實跑的 5 個語言）可能有錯；做法是每加一個語言就要有輸出器＋實跑樣本，不要只加樣板。
- 工具鏈不齊的環境（判題器的 java／c／python 在這台都有問題）會讓驗收不穩，要先處理判題器的 Windows 問題。
- 輸出的 c 程式有記憶體洩漏（字串連接、字串轉換不釋放），只適合小程式與驗證。

### 6.3 需要使用者決定的事
1. 階段 A 先做「只讀的函式行為卡」是否同意（它不產生程式碼，但是整條線的資料基礎）？
2. 靜態語言遇到沒標註的型別：要求使用者補標註（現行做法），還是讓模型／規則猜型別再經判題驗證？
3. 整數語意：預設用 64 位元（現行，簡單）、還是一律支援大整數（慢、程式醜）、還是靜態分析範圍後選擇？
4. 判題器在 Windows 的 java／C／python 問題（上述 5.2 的 3-5）要不要排一個修復？它影響所有語言的驗收。
5. perl 要不要做（需下載文法確認、這台有 perl 可實跑）？ruby／c# 要不要為了實跑而安裝（本案沒有安裝）？
6. 正規表示式方言轉換要做到什麼程度（只簡單子集，還是做方言轉換器）？

## 7. 檔案
`ir_core.js`（資料結構、驗證、序列化）、`ir_ops_core.js`（72 個操作＋輔助函式）、`ir_prep_core.js`（推斷、降低、宣告）、`ir_in_python_core.js`（Python 進）、`ir_out_{js,java,c,python}_core.js`（各語言出）、`ir_design_core.js`（抽回設計與編修）、`ir_behavior_core.js`（行為描述）、`ir_samples.js`（樣本）。每個語言的「進」「出」各自獨立，只有 `ir_core`、`ir_ops`、`ir_prep` 共用。

## 8. 與 Blockly 教學線接成同一條（2026-11-08，`ir_blocks_core.js`＋`ir_blocks.test.js`）

使用者原話（2026-11-08）：「blockly-teach 先完工  我們的多語言的中間語言跟function behavior 也是這個議題」。

**做法**：區塊的範本庫（`py_blocks_core`）是 Python 專屬，所以橋走 Python：區塊（或受控自然語言）→ 區塊的程式碼產生 → Python → 中間語言 → nodejs／java／c／python；反方向 Python 程式 → 區塊（反推）。函式行為卡直接用 `ir_behavior.fromIr`，再附上該函式的區塊統計。純模組，依賴注入，不碰 `floating-assistant.js`（由管理者接線）。

| 介面 | 作用 |
|---|---|
| `fromPython(src)` | 程式 → 每個函式的區塊與受控自然語言；回傳 `ctx`（原模型，保留 import、型別標註、模組層敘述） |
| `program(funcs, {ctx})` | 區塊／受控自然語言 → Python；帶 `ctx` 時只換函式本體 |
| `emit(python, lang)`／`blocksToTarget(funcs, lang)` | → 目標語言，診斷如實帶回（輸出器拒絕的樣本照樣被拒） |
| `cards(python)`／`cardText(card)` | 函式行為卡（第二層）＋區塊統計，供 code edit 把程式抽回設計 |
| `styleCheck(python)` | 函式名／變數名命名風格一致性（思考堆疊缺口 F 的離線版） |

**我驗證的**（`ir_blocks.test.js` 8 項全過，本機有 python／javac）：
- 10 個樣本 → 區塊 → 受控自然語言 → 區塊 → Python：全部可解析；實跑輸出與原樣本一致（每個測資）。
- 區塊 → 中間語言 → nodejs 實跑 10/10 與 Python 輸出一致；→ java 產生 10、編譯並實跑 10；→ c 產生 8，另 2 個如預期被如實拒絕。
- 行為卡從區塊產生的程式抽出，函式名／標準操作／副作用與直接從原程式抽的一致。
- 壞的受控自然語言不丟例外，回報解析錯誤。

**待改善（誠實清單；沒達標不叫沒做）**
1. 行內註解（已補，2026-11-08）：區塊樹仍沒有註解節點，改用旁路——`fromPython` 從原始碼收集註解並記下錨點（行尾註解＝同一行程式；獨立註解＝下一行程式），`program` 在產生 Python 後依程式行內容（去空白、去括號、引號統一）掛回，掛不回的附在檔尾並計入 `comments.unplaced`。實測 10 個樣本 6 個註解（行尾、獨立、函式內區塊裡的）全數保留：區塊→中間語言註解數與原程式相同，nodejs／java／c 輸出共比對 18 筆全部找到（java 預設逸出成 \uXXXX，還原後相符，見 2.3）。**待改善**：只在帶 `ctx` 的往返有效；使用者在區塊編輯器裡改寫了該行程式（錨點對不上）註解會落到檔尾；沒有驗證過多行字串裡的 # 與更大的程式集。
2. 只做 Python 區塊；其他語言的程式要先「進」中間語言才有區塊（目前進只有 python，`DESIGN.core-ir.md` 6.1 階段 C）。
3. c 的實跑沒驗（這台 C 編譯器沒設系統標頭路徑，屬環境問題）；java／c 只涵蓋樣本用到的 26% 標準操作。
4. 區塊內容超出樣本範圍（類別、例外、生成式）時，通用「程式」區塊會帶原生語法，輸出器照舊拒絕並說明——沒有驗證過更大的區塊程式集。
5. `styleCheck` 用文字樣式比對，不是語法樹；只看函式名與簡單賦值／for 變數。
6. 還沒接進 code edit 畫面與 `floating-assistant.js`（管理者統一接線）。
