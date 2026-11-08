# 真正的語法樹（AST）建樹：每個空位列出合法節點種類，模型只做選擇（2026-11-06）

> 取代 [DESIGN.grammar-guided.md](DESIGN.grammar-guided.md) 裡「token 層」的做法。使用者的定義：**AST 就是 Abstract Syntax Tree，沒有別的定義**。
> 程式是一棵節點樹；每個空位有型別；機械演算法列出這個空位合法的**節點種類**；模型只在裡面選（或寫一個名稱／數字／字串）；最後把樹**反解**成原始碼。
> 不是 token（BPE 或詞法）層的預測，也不是「模型自由寫、文法事後驗證」。目前只做 Python（真的 tree-sitter-python 0.21.0 文法），其他語言各自用自己的 grammar.json，不共用。

## 一、檔案（`renderer/src/ast/`）

| 檔案 | 作用 |
|---|---|
| `python.grammar.json`、`python.node-types.json` | tree-sitter-python 0.21.0 的原始文法與節點型別（專案本來就從 CDN 載入並快取 web-tree-sitter 0.20.8＋tree-sitter-wasms） |
| `ast_menu_core.js` | 展開隱藏規則與 supertype，印出每個空位的合法節點種類（陳述 25、運算式 33、指定左邊 8、參數 9、呼叫引數 35） |
| `ast_build_core.js` | **建樹器**：照規則清單走——固定的字直接寫，欄位空位問「放哪一種節點」，可有可無問「要不要」，可重複問「再加一個嗎」；左因子提取（共同開頭只問一次）；反解（縮排換行、依優先順序自動補括號、單元素元組補逗號） |
| `ast_replay_core.js` | 神諭：照一棵真樹回答建樹器每個問題（證明「能表達」，也是測試基準） |
| `ast_choose_core.js` | 模型端：空位→選擇題（字母），受限選擇（只比對選項字母的機率，正倒序各一次抵銷位置偏誤），名稱從作用域挑 |
| `scripts/eval/ast_write_bench.js` | 實機評估：解法步驟→建樹→反解→判題器 |

## 二、已驗證的數字（真 tree-sitter 當裁判）

- 隨機決策建樹 1000 棵 → 反解 → 真 tree-sitter 解析：**972 棵 OK（無 ERROR 且節點結構完全一致）**，9 棵解析錯誤、19 棵結構不同。殘餘都是文法本身的歧義（`with (x):` 與元組、`yield` 後帶逗號、`(*x)`…）；實際流程反解後會再解析一次擋掉。
- 20 題種子程式：真 tree-sitter 解析 → 神諭照樹回答 → 建樹 → 反解：**20/20 結構一致、判題 AC 20/20**。也就是這棵樹的選單足夠表達這 20 個程式。
- 選單大小：左因子提取前二元運算的左運算元有 325 項，提取後最多 32 項、中位數 14 項。

## 三、模型端實測（誠實的結果）

qwen3-0.6b q8、CPU、**不開思考**（write_code 領域整個關思考）：

| 做法 | 結果 |
|---|---|
| 生成編號再解析 | 模型照抄選項清單（寫「1. 結束…」）或永遠回 1；一個 `import` 的點分名稱陷入「再加一個」無限迴圈 |
| 受限選擇（字母機率）＋解法步驟＋選單先驗順序＋深度限制 | 位置偏誤極強（幾乎全選 A）；`a-plus-b` 一題建不出程式（0/1），選到的節點接近隨機 |
| 再加正倒序抵銷偏誤 | 偏誤消失但選擇仍接近隨機；解法步驟本身就錯（`a+b` 寫成「用迴圈累加」） |

結論：**機械那一半（合法節點、建樹、反解）已成立；0.6B 不開思考這一半目前不成立。** 這不是 AST 的問題，是「選擇」這一步沒有足夠訊號。
可能的方向（尚未做，需要使用者決定）：開思考做選擇題（先前實測每題 20～60 秒、無明顯準確度增益）、換更大的模型、先寫「函式範本庫」（第二階段，用意圖→範本取代逐節點選擇）、選擇題粒度改成「整個敘述範本」而不是單一節點。

## 四、尚未做

- 把建樹接進 `write_code`／UML 遞迴切割迴圈、floating-assistant 與 `web-lazy`（renderer 目前沒有載入這些檔案，所以**沒有發布 live-update patch**——renderer 前端沒有變化）。
- 其他語言（nodejs、c、c++、java、ruby、perl、bash、asm、C#）：tree-sitter-wasms 已有對應 wasm；每個語言要各自的 grammar.json 與反解規則（括號、分號、縮排）。
- 以建樹為基礎的語法修復與編輯（從任意程式接續：把既有程式解析成樹，在某個節點重選）。

## 五、反向路徑：程式碼 → tree-sitter → UML（含指令層級）→ 程式碼（2026-11-06）

使用者的方向：還是走 **UML design 遞迴切割＋codegen／code converter**，converter 最後的粒度要到指令層級；缺的是「現有程式碼 → tree-sitter → UML」。盤點：現有 UML（`uml_core`）只到設計層級——類別、操作簽名、使用案例的呼叫順序；操作內部沒有地方放敘述（`llvm_core` 產出的是印軌跡的 stub）。

`renderer/src/uml/py_code2uml_core.js`（`FaPyCode2Uml`，Python 專屬，每個語言各自一份，不共用）：
- `fromTree(tree-sitter 根節點, {source, moduleName})` → `{model, coverage}`。`model` 保持 `uml_core` 的形狀（可過 `validateModel`、`toDsl`），並加上：`class.ops[i].body`（**指令層級的敘述樹**）、`op.params[i].default／kind`、`op.async／dec／ret`、`model.prelude`（模組層敘述）、`model.order`（保留原始頂層順序）、`class.order`（保留類別成員順序）。模組層函式放進與模組同名的類別（static 操作）。類別的 `attrs` 從 `self.x = …` 與類別層指派抽出，繼承→`inherit` 關係，建構呼叫→`depend` 關係，`main` 的呼叫順序→使用案例。
- 敘述：assign（含連鎖指派，右邊只算一次）、ann、aug、expr、if（elif 攤成巢狀）、for／while（含 else）、ret、break、cont、pass、def（含 async、裝飾器、回傳型別）、class、try／except／else／finally、with、raise、assert、global／nonlocal、del、import。運算式：名稱、常數、呼叫（含 kw／star）、屬性、索引、切片、二元／一元／比較／布林／not、條件式、list／tuple／set／dict、四種生成式、lambda、await、yield、walrus。沒轉成結構的收成 `raw`（保留原文），`coverage.raws` 如實計數。
- `toPython(model)`：回程 codegen（依運算子優先順序自動補括號）。

**驗證**
- 20 題種子程式：程式 → UML → Python → 判題 **20/20 AC**，且再轉一次結果逐字相同。
- 專案裡 46 個真實 Python 檔（5983 句敘述，含 async、裝飾器、類別、try／with）：轉回去 **46/46 的 Python `ast.dump` 與原檔完全相同**（不受括號與排版影響，這是語意相同的強證據），raw 為 0。
- 找到並修掉的真問題：`async def` 掉了 async、連鎖指派被拆成兩次（右邊會算兩次）、跨行的字串串接拆括號後縮排錯、頂層順序被改。

**還沒做（下一步）**：(1) 其他語言的 `code→UML` 與 codegen（tree-sitter-wasms 已有 wasm；各語言各自一份）；(2) 用 UML 遞迴切割讓模型**寫** body：函式簽名 → 切成幾個敘述區塊 → 每個敘述一個小題（這時選單的粒度是「敘述範本」，不是單一節點）；(3) 把 body 接進 `llvm_core`（目前是 stub）與設計檢視器；(4) 接進 `uml_edit` 的編修指令（改某個敘述）。

## 六、UML 遞迴切割讓模型寫 body；區塊（Blockly 式）範本庫（2026-11-06）

使用者的方向：模型逐節點選擇（第三節）行不通後，改走 **UML 遞迴切割 → body → codegen**；如果單純寫敘述也沒效，body 改成 **類似 Blockly 的區塊陳述**，並且要有「常見語意結構 → code」與「code → 語意結構」兩個方向，指定架構的程式區塊範本要夠多。

### 6.1 切割與逐行寫（`py_body_core.js`，`FaPyBody`）
題目 → 函式簽名（UML 的操作，輔助函式先、main 最後）→ 每個操作的 body → 一次一個敘述；區塊標頭（for／if／while…）往下一層，縮排變淺回上一層，`else／elif／except` 接在對應區塊後。**補全式**：把已寫好的程式當成助手回覆的開頭請模型續寫、只取第一行（0.5B coder 聽不懂「只輸出下一行」，但會續寫程式）。每一行用 tree-sitter 解析（剛好一個敘述、不能有 ERROR）、用敘述樹（`namesOf`）檢查名稱已定義，不合格連同原因再問（上限 3 次），失敗就說明原因。
實測（Qwen2.5-Coder-0.5B、不開思考、20 題種子）：自由寫整份 1/20 → 逐行寫 **4/20**（沒有質變；3 題寫滿 60 句迴圈，其餘多半題意理解錯誤）。

### 6.2 區塊範本庫（`py_blocks_core.js`，`FaPyBlocks`，90 個範本）
- **一個範本只定義一次**：一行中文受控自然語言 `line`（`{槽位:種類}`）＋一小段 Python `py`（`$槽位`、`$$子區塊`）。例：`讀入一行整數 {t:name}` ⇄ `$t = map(int, input().split())`；`重複 {n} 次，用 {i:name} 計數：` ⇄ `for $i in range($n):\n    $$body`。
- **同一份定義兩個方向都用**：區塊→程式＝槽位填進 IR 圖樣；程式→區塊＝敘述 IR 與圖樣結構比對（洞要一致綁定、名稱槽只收名稱、子區塊洞吃掉串列剩下的）。比對由大到小，多敘述範本（二分搜尋、篩法、前綴和、輾轉相除、佇列走訪）先於單句範本；if 鏈用專門的 `如果…就：／否則如果…就：／否則：`；比不到的收成通用的 `程式：<一行 Python>`／`程式區塊：`（任何程式都表達得了）。
- 類別：輸入 13、輸出 8、資料 36、更新 12、集合 8、迴圈 10、流程 5、演算法 4。
- 受控自然語言：一行一個區塊、縮排兩格表示子區塊；`parseCNL` 用 tree-sitter 檢查每個槽位是合法運算式（名稱槽要是名稱）。
- **驗證**：20 題種子程式 body → 區塊 → 受控自然語言 → 區塊 → Python：**IR 往返相同 20/20、CNL 往返相同 20/20、判題 AC 20/20**；153 個區塊裡只有 1 個落到通用「程式」區塊（0.7%），用到 37 種範本。

### 6.3 模型寫區塊（`py_cnl_write_core.js`）
提示裡放區塊目錄；示範與目標題目放在助手回覆的開頭（小模型吃文件續寫、不吃指令），模型續寫「區塊：」後面的行；每行用 `parseCNL` 驗證、名稱檢查、不合格退回。示範採「排除當前題目」。

## 七、架構定案：UML 切割 → 骨架 → 區塊迴圈（庫存＋範本）→ 模型微選擇 → 沙盒回饋（2026-11-06）

使用者的流程（逐字重點）：UML 任務切割 → 程式骨架生成（Boilerplate）→ 進入 Block 產生迴圈〔① 程式端計算當前 Symbol Table（Inventory）② 用 Inventory 過濾合法區塊選項 ③ 套嚴格 Template（For／While 結構防呆）〕→ 模型僅在合法 Inventory 內做微型選擇 → 沙盒編譯驗證 ⇄ 錯誤回饋。另外：函式 body 固定成**引入區、宣告區、邏輯與流程區**；積木庫越大越豐富，先從小程式、小需求開始；函式呼叫要涵蓋各種科學與繪圖。

| 層 | 檔案 | 做什麼 |
|---|---|---|
| 骨架 | `py_code2uml_core.js`（`toPython`） | UML 模型（操作＝函式）→ Python；body 由區塊轉出的敘述樹填入，引入區提升到模組最上面 |
| 區塊庫 | `py_blocks_core.js`、`py_blocks_lib_core.js` | 127 個陳述範本（輸入 13、輸出 8、資料 36、更新 12、集合 8、迴圈 15、流程 5、演算法 4、引入 9、繪圖 20、科學 3）＋ 運算式積木 99（算術、比較、邏輯、取值、函式、方法、組合、科學·數學／數值／統計／亂數／微積分／集合）；一個範本一份定義，區塊↔程式雙向 |
| 規則 | `py_blocks_rules_core.js` | **庫存（符號表）與範本規則**：變數與型別、已引入的模組、開著的區塊；算出每一步合法的類別與範本、槽位的型別選單、能不能結束區塊、能不能寫完函式 |
| 迴圈 | `py_cnl_choose_core.js` | 類別 → 範本 → 每個槽位（宣告的名稱、已宣告的變數、運算式積木遞迴最深 3 層）全部是選擇題；只有一個選項不問模型；組好後判題，沒過就把判決連同上一版回饋重寫 |

**規則清單（都有測試，`py_blocks_rules.test.js` 9 項）**
- 三區只能往後走：引入區只能放引入；宣告區只有輸入與資料；邏輯與流程區才有更新、集合、迴圈、輸出、條件、繪圖、演算法、流程，不能再引入。
- 什麼都沒宣告（邏輯區）只能宣告或 return；輸出、更新、迴圈、break 都不會出現。
- 用到變數的槽位只列型別相容的已宣告變數；沒有清單就沒有 append／sort，沒有數字變數就沒有 incr。
- `for`：結構化範本把初始化、條件、遞增放進範本（`for_counter`／`for_countdown`／`while_counter`／`while_countdown`），或「重複 n 次、用 i 計數」（`for_range`）；迴圈變數一律是新宣告的名稱。
- `while_do` 結束前檢查：迴圈裡有改到條件用到的變數或有 break，否則不能結束；`while True` 一定要有 break。
- break／continue 只在迴圈裡；return／break／continue 之後同一層只能結束區塊；空的區塊不能結束；輔助函式一定要 return 值。
- 模組函式要先引入模組才會出現（math、numpy、matplotlib.pyplot、statistics、random、scipy、collections、heapq、bisect）。
- 槽位型別（int／num／str／list／dict／iter／cond／any）：`cond` 槽只給比較與邏輯積木。

**目前量到的（誠實）**
- 機械那一半全部成立：種子程式 body ↔ 區塊 ↔ 受控自然語言 ↔ 程式，往返與判題 20/20；規則 9 項測試；管線（三區、庫存、型別槽位、沙盒回饋）可以從頭跑到尾。
- **模型那一半沒有成立**：qwen3-0.6b（不開思考）在合法選單裡的選擇仍接近隨機。診斷：同一題只換選項順序答案就變（機率 0.89／1.00 的極端偏向）；逐項「是／否」評分 0/4；開思考（15～70 秒／題）4 題正倒序共 8 次只對 2 次。`a+b` 這題管線跑完得到無意義的程式（0/1）。Qwen2.5-Coder-0.5B 不開思考自由寫整份 1/20、逐行補全式 4/20。
- 更大的模型（Qwen2.5-Coder-1.5B 已下載驗證）在 wasm 跑不動，除非 transformer 的記憶體能用 IndexedDB 模擬；所以**不能指望靠加大模型解決**，必須讓每一步的選擇更少、更明確。

### 7.1 uml_design 先行、程式讀情境（使用者要求，2026-11-06）

使用者從第一則訊息就要求「uml-design 的遞迴切割」，之前我沒有照做（自己寫了函式簽名的正則解析與預設只有 main）。改成：**算法題走 `uml_design` 的「程式先讀情境」入口**，不是另起一條。
- `uml_core.js` 新增擴充點 `opts.readers`（`readHints`）：領域讀取器先於業務詞彙表；結果帶回 `hints`（含讀取器的意圖）。既有 80 項 UML 測試維持通過。
- `algo_intent_core.js`（`FaAlgoIntent`，語言中立）：用規則讀「第一行 n t」「n 個整數」「接著 q 行每行 l r」「輸入一行兩個整數 a b」「輸入兩行小寫字串」…；讀「輸出 a+b」這種直接寫出的運算式與動作表（最大值、最小值、總和、反轉、排序、迴文、質數、gcd…）；產出 UML：`Solver { main(); readInput(); solve(參數) }`，使用案例 `RunSolver: User → main → readInput → solve`，**0 次模型呼叫**。
- `py_uml_pipeline_core.js`：UML → 骨架（每個操作一個函式）→ `read_input`、`main` 由程式用區塊生成 → `solve` 先試「動作表配方」（經沙盒驗證，沒過就退回）→ 沒有配方才進區塊迴圈（模型微選擇，參數型別是庫存的起點）→ 沙盒回饋。
- 測試 `py_uml_pipeline.test.js`：20 題種子 **`uml_design` 讀出 UML 20/20（0 次模型、驗證無錯）；程式直接解出且 AC 3 題（a-plus-b、max-of-array、reverse-words）；需要模型 17 題**；沒見過的寫法（「輸入兩個整數 x y，輸出 x*y」、「第一行一個整數 n，第二行 n 個整數。求最大值並輸出」等）**4/4 由程式直接解出且 AC**。
- 注意：讀取器是對著這 20 題寫的規則，雖然 4 個沒見過的寫法能過，但覆蓋範圍仍小（輸入格式 20/20 讀出，是因為種子題的句型很規整）。配方只在「很明確」時給，且一律交沙盒驗證——例如 range-sum 有「和」但有區間，配方不會套（單一清單才套）。

### 7.2 老師教、內建進去：課（lesson）、內建的課、範式、矩陣（2026-11-06）

使用者要求：Claude 如果能指導離線組合走向正確，**教完後內建進去**。做法（沿用 `/offline-trainer-by-ai` 的流程：先讓離線試、做不到才請老師、老師成功後必須教給訓練器、再驗證離線自己能重做；加上客觀驗證、回歸、回滾）：
- **課**（`py_lessons_core.js`）：老師的解答（`def solve(輸入變數)`，輸入已由 `read_input` 讀好，可含輔助函式與 import）→ 動作表的算法種類＋輸入形狀＋變數角色化的區塊配方（輸入變數叫 `v0…`，套用時換成題目的名稱，撞名的區域變數自動改名）。`matchLesson` 要算法種類與輸入形狀都相同才套；套用後交沙盒驗證，沒過才退回區塊迴圈。
- **老師迴圈（Node 版）**：`scripts/teach-builtin-lessons.js`，老師＝Claude 的解答（`scripts/teacher-solutions.js`），驗證＝判題器（含隱藏測資）。每題：離線試 → 沒過請老師 → 老師的解答自己要過驗證 → 訓練器抽成課 → 離線自己重做並通過 → 回歸（先前會的題不能退步）→ 通過才收，否則回滾。
- **內建**：通過的課寫成 `renderer/src/uml/py_lessons_builtin.js`（資料檔，由腳本產生，不要手改）。結果：**離線自己解決（不問任何模型）3/20 → 20/20**，17 堂課，沒有被退回的課。
- **泛化驗證**（`py_lessons.test.js`）：16 個沒見過的改寫（換變數名稱、不同的隨機測資、期望輸出由參考程式算出）**離線自己做對 16/16（全靠課）**；不認得的算法不會亂套課，回報需要模型。邊界：改寫只換變數名稱與測資、句型仍在讀取器認得的範圍內；課只涵蓋這 17 種算法；新算法要靠老師（`/teacher-loop`）再教。
- **處理模型（範式）**：動作表給每種算法標範式（`intent.paradigms`）：動態規劃、BFS、DFS、分治／二分、資料結構對應（雜湊、堆疊）、前綴和、數論、雙指標、排序掃描、矩陣快速冪…；課也記範式。下一階段把範式本身做成「帶槽位的區塊骨架」，新題套範式、填槽位，不必每題各教一堂課。
- **矩陣相乘求解**：`@`（修了 codegen 漏掉 `@` 的優先順序）、`np.linalg.matrix_power`、`np.eye`、行列式；純 Python 的區塊 `mat_mul`（矩陣相乘）、`mat_identity`、`mat_pow`（快速冪求方陣的 n 次方）。驗證：把費氏數映射成轉移矩陣 `[[1,1],[1,0]]`，用 `mat_pow` 算出第 n 個（n=90 也對），判題通過。

### 7.3 範式骨架庫：每個範式一個帶槽位的區塊骨架（2026-11-06）

- **檔案**：`renderer/src/uml/py_paradigms_core.js`（`FaPyParadigms`，Python 專屬）。23 個骨架（原 17＋後加 6）：一維 DP（費氏、硬幣最少、LIS、0/1 背包）、區間 DP（最長回文子序列）、二維 DP（LCS）、分治（歸併數逆序對）、樹走訪（前／中／後序，堆疊模擬）、堆積（第 k 小）、矩陣快速冪（費氏取餘，2x2 用四個變數）、BFS（網格最短步數）、DFS／並查集（連通分量）、二分（lower_bound）、前綴和（區間和）、雜湊計數、堆疊（括號）、排序後掃描（合併區間）、暴力雙迴圈（兩數之和）、排序取第 k 個、篩法、數論（gcd／lcm）、雙指標（迴文）、變位詞。
- **骨架＋槽位**：骨架固定這種算法該有的迴圈與資料結構，槽位是 1～3 個小選單（初值、比較方向、邊界、索引起點、輸出哪個…），每個骨架 ≤ 12 個組合。骨架以「程式區塊：」包 Python 輸出成受控自然語言（CNL），之後走 `parseCNL` → 區塊 → IR → codegen，跟其他區塊同一條路。
- **窮舉＋沙盒，不靠模型**：`solve` 把槽位組合逐個交判題器，第一個 AC 就用；`rank`（模型的 pick）只決定順序，沒有也行。**測試證明靠窮舉而不是排前面**：選項順序反過來，結果一樣。
- **接進管線**：`buildFromUML` 順序 ＝ 配方 → 課 → **範式骨架** → 區塊迴圈（模型）；回傳多 `paradigm`、`slots`、`tried`。局部變數撞到題目的變數名稱會自動改名（`名稱_2`）。
- **驗證（Node，`py_paradigms.test.js`，不給課）**：種子題有範式的 17/17、沒見過的改寫（換變數名稱＋隨機測資）16/16、選項反序 16/16，皆由判題器驗證，0 次模型呼叫。
- **宿主接線**：`code_agent_core.runCode` 新增 `offline` 掛鉤（Python、有測試、有判題器才試；AC 才採用，否則退回模型路線並在 gaps 說明）；`floating-assistant.js` 的 `_codeOffline`（tree-sitter 用 `_behTsHost`）；`write_code` 在沒有模型時對 Python 算法題仍可離線做。`embed-code-ui.js` 嵌入 `py_*`、`algo_intent_core`、內建課。
- **老師迴圈接線（`/teacher-loop`）**：`_otTeacherTryOffline(text, s, item)` 對 Python 判題項目先走離線組合；老師教完、離線自己重做通過驗證後，`_pyLearnLesson` 用 `deriveLesson` 把解答抽成課——**只靠這一堂課自己重做、過判題器才收**（否則不收），存 localStorage（`fa_py_runtime_lessons`，跟內建分開），`_pyLessonsExport()` 匯出 JSON 供轉成內建。`deriveLesson` 可記 `paradigm`＋`slots`。真 Electron 驗證：`scripts/eval/teach-lesson.eval.js`。
- **骨架的限制**：骨架本文走「程式區塊：」→ `parseCNL`，**巢狀 `def` 會被丟掉**（`stmtsOfSource` 只取敘述），所以骨架要寫成不含 `def`（遞迴改堆疊／由下而上，矩陣用四個變數）；也避免 `a = b = 0` 連續賦值。
- **還沒做**：沒有範式的算法（骨架是人寫的，新算法仍要請老師或模型）、非 Python 語言；內建課遇到 n 很大的題（如費氏取餘）會先試課而逾時才退到範式。

## 九、tree-sitter 資源的來源（2026-11-08 已決定）

- 內建：web-tree-sitter 0.20.8 與 **Python 文法**（`renderer/vendor/tree-sitter/`）。
- 其他語言（javascript、java、c、cpp、c_sharp、ruby、bash、rust、go）**延遲下載**：取得順序＝本機快取 → 專案內建 → 釘住 commit 的分支 `assets-tree-sitter`（`raw.githubusercontent.com/sunneo/tw_stock_db/<完整 commit>/grammars/…`，下載後核對位元組數與 MD5，核對不過就丟掉、不存壞檔）→ 最後才是原本的 jsdelivr。ruby 用 tree-sitter-wasms 0.1.6 版（新版在 0.20.8 上會當掉）。快取鍵含 commit 前八碼，換 commit 才會重抓。
- 程式：`renderer/src/behavior/ts_assets_core.js`（純函式 `FaTsAssets`：`sources`／`cacheKey`／`verify`／`md5`，核對表與分支 README 一致），嵌入 `floating-assistant.js`；載入器 `_behAsset`／`_behTsHost` 與 `skills/weak-model-harness/scripts/behavior.js` 都用它。測試 `ts_assets.test.js`（不連網）。
- 沒驗證：沒有實際從分支下載（本輪不下載；網址與檢查碼是管理者抽查過的）；分支的檔案若日後換 commit，要同步改 `COMMIT` 與核對表。
