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
