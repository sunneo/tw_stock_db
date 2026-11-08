# /code 指令：寫程式的前導（2026-11-08）

## 做了什麼（已上線的設計）
- `/code <一句話>`（`renderer/src/recipe/code_slash_core.js`，嵌入為 `FaCodeSlash`）：**程式**決定該呼叫哪個程式設計工具與欄位，不問模型。
  - 子指令：寫→`write_code`、修→`fix_code`、優化→`optimize_code`、合併→`merge_patch`、轉換→`convert_code`（轉成 nodejs／java／c／python，見 `DESIGN.core-ir.md` §9）、設計→`uml_design`、解釋→`explain_code`；也可不加動詞：沒貼程式當作寫、有 diff 區塊＋程式當作合併、貼了程式提到優化就優化、其餘貼了程式當作修。
  - 欄位只從文字抽（``` 程式區塊、```diff、```in／```out 成對測資、語言標記）；抽不到就在回覆裡列出缺什麼，不編造。
  - 只有一個入口：真正的寫與驗收都在工具裡（`write_code` 領域不開思考；離線小模型只在工具內答封閉選擇題）。`/code` 本身沒有第二條寫程式路徑。
- 離線訓練器 `core_rules` 多一條 `code_write` 規則（種子版本 v12→v13，已安裝的機器會重新播種）：一般說「寫一個函式…」「用 python 寫程式…」會直接選 `write_code`。**實測原因**：加之前走語意相似度，「寫一個函式，輸入兩個整數印出總和」會選到 `list_ai_functions`。
- 線上 AI：六個工具本來就在 coding 領域的 toolNames、描述講得出何時用；核心測試新增一項檢查這件事（工具真的註冊、都在領域名單、描述有關鍵詞）。

## 驗證
- 我驗證的（核心測試）：`renderer/src/recipe/code_slash.test.js`，13 項，已登記在 `scripts/run-core-tests.js`。
- 我驗證的（真的 Electron，獨立資料夾＋埠 17987＋停用覆蓋，載入的是工作目錄的 `renderer/floating-assistant.js`）：`node scripts/eval/code-slash.run.js`。
  - `/code` 已註冊；不帶參數印用法、不呼叫工具。
  - `/code 寫…` 路由到 `write_code`，欄位 task 與測資正確（**此項把 write_code 換成假的，只證明路由與欄位，不是真的寫出程式**）。
  - `/code 解釋 …` 真的呼叫 `explain_code` 並顯示說明；`/code 合併 …` 真的呼叫 `merge_patch`，因為這個新資料夾沒開「允許AI執行程式」，檢查器不能用，**正確地整份回滾並說明原因**（沒有驗證到合併成功的路徑，那條在 `code_patch.test.js`）。
  - `/code 優化` 沒給測資：說缺測資、不呼叫工具。
  - 離線訓練器：「寫一個函式…」「幫我用python寫程式計算費氏數列」現在選 `write_code`。

## 待改善（沒達標，誠實列出）
1. 離線訓練器對「這段程式有 bug 幫我修」「幫我優化這段程式」仍選 `explain_code`。原因：`_otPlan` 一進來就把換行壓成空白，貼上的程式縮排會毀掉，所以我**沒有**為修／優化加規則；目前這兩種請走 `/code 修`、`/code 優化`（或線上模型自己呼叫工具）。要補得先讓訓練器入口保留原文（程式區塊）。
2. 「從程式抽回設計」：已有唯讀的 `behavior_card` 工具（行為卡＋模組設計摘要，`DESIGN.core-ir.md` §10），`/code 行為卡`（或 `抽回設計`）路由到它；`/code 解釋` 仍走 `explain_code`（白話說明）。UML 抽回（`ir_design_core.toUmlModel`）還沒做成工具。
3. 沒有真的用離線小模型跑 `/code 寫…` 的完整端到端（需要下載模型；這次沒下載）。`write_code` 本身的端到端由 `code_agent_core.test.js`／`code_loop_core.test.js` 以假模型涵蓋。
4. 「CoLU 計畫階段（`chooseTool`）」：沒有改。`DESIGN.think-stack.md` 缺口 G 已決定「不建議把規劃路由接到寫程式」；`/code` 與訓練器規則是程式直接選工具，等於 CoLU 的「程式決定路由」那一層，沒有新增模型決策點。
