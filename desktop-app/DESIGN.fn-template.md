# 意圖→函式範本庫：讓離線小模型寫出整個大程式（2026-11-05）

使用者原話：「主要想法是用來讓offline model可以寫一整個足夠大的程式，因為目前uml design切到最後應該已經有能力產生一些程式架構，那如果細切進去，應該可以寫好一個function，甚至如果記錄好intention->function template，就可以用更快的方式產生一大堆code」「驗收測試:小程式的答案。可以從演算法題目，leetCode/ACM當成練習範本」。

狀態：**設計，尚未實作。** 沒有用真的小模型量過任何數字；下面的命中率、成本都是待量的假設。

## 零、兩個階段（2026-11-05 使用者校正）

使用者原話：「程式範本庫是第二階段，第一階段我是希望他可以根據需求，思考，來寫出程式」「我們可以先依序建立python, nodejs, c, c++, java, ruby, perl, bash, x86/x64 asm, C#」。

- **第一階段：需求 → 思考 → 程式。** 小模型靠思考堆疊、UML design、CoLU 規劃，自己把需求想清楚再寫程式；寫完交給判題器（第九節）驗收，不過就帶著失敗訊息再想一次。**沒有範本庫**。這階段要回答的問題是：沒有範本，離線小模型靠「思考＋驗收」能把多大的程式寫對？
- **第二階段：意圖→函式範本庫。** 第一階段寫出並通過驗收的函式，才有資格抽象成範本回存，再加速後續的生成。第三～七節的範本庫、晉升、索引、黏合範本都屬於這一階段，**第一階段不做**。
- 所以第一階段的判題器同時是「練習場」的基礎：它產生的 AC／WA／TLE 紀錄，之後就是範本晉升的證據。

語言支援先做判題器：python、nodejs、c、c++、java、ruby、perl、bash、x86／x64 組語、C#，依序驗證（第九節）。

## 一、管線（含第二階段）

```
情境 → UML（套件/類別/操作）                 已有：design_core
     → 每個操作 = 函式規格                    新增切點
        { intention, 簽名, 範例輸入輸出, 可呼叫的單元, 依賴 }
     → 函式本體，三條路依序嘗試：
        1. 範本命中：意圖比對 → 填槽位 → 產生        （0～1 次小呼叫）
        2. 組合：本體切 3～6 步，每步從單元目錄挑      （CoLU 規劃）
        3. 語法選擇題補全：合法 token 預測集＋符號表    （最貴，最後才用）
     → 驗收：規格的範例＋範本屬性測試，沙盒執行（程式端，不靠模型）
     → 過了才回存範本庫；不過退到下一條路
```

信任基礎是驗收，不是模型。驗收迴圈要最先做。

## 二、驗收測試來源：演算法題當練習範本

小程式的答案有明確輸入輸出，最適合當「練習場」：

- **期望值來自題庫的參考解與測試資料**，不是小模型產生。解掉先前「模型寫的期望值可能是錯的」的問題。
- 練習流程：題目 → 抽意圖標籤 → 走三條路 → 跑測試 → 通過的解法**抽象成帶槽位的範本**回存。
- 題型標籤（雙指標、二分、BFS/DFS、前綴和、雜湊計數、DP、排序）直接當範本庫的第一層索引。

### 題目格式（JSONL，一題一行）

```json
{"id":"two-sum","tags":["hashmap","array"],"intention":"find_pair_with_sum(nums:int[], target:int)->int[2]",
 "signature":{"name":"twoSum","params":["nums","target"]},
 "tests":[{"in":[[2,7,11,15],9],"out":[0,1]}],
 "hidden":[...], "ref":"參考解（只給驗收用，不給模型看）"}
```

- `tests` 給模型練習時看得到；`hidden` 只在驗收用，防止範本只記得範例。
- 多解的題目（任意順序）要有 `checker`（比對函式），不能只比字串。

### 版權與來源

- **不把 LeetCode 題目文字或測試資料打包進產品。** 題目文字有版權。使用者自己本機匯入的可以用，但不隨發行版散布。
- 可打包的來源：自己寫的種子題（原創、通常自己寫 20～50 題就夠起步）、授權明確的公開資料集（HumanEval、MBPP 這類，**使用前要先確認授權條款**，我沒有在這個 session 驗證過）。
- ACM／ICPC 各賽事題目授權不一，同樣不預設可散布。

## 三、範本庫

| 項目 | 內容 |
|---|---|
| 鍵 | 意圖正規化：動詞＋名詞＋資料形狀（`group_by(rows,key)`），不用自然語言原句 |
| 值 | 帶具名槽位的模板：型別、欄位名、謂詞、比較函式。槽位用選擇題或小填空，不自由生成 |
| 來源 | 練習場產出（通過測試）、內建常用樣式、從使用者既有程式碼抽取（接 `unit-catalog` 抽取器） |
| 晉升 | 候選要在**不同題目**上被命中且通過 N 次才升正式；避免整題解答被當範本 |
| 索引 | 分層：領域/標籤 → 候選，一次只給小模型 4～6 個 |
| 儲存 | JSONL，沿用多層 JSONL 做法 |

## 四、題庫涵蓋不到的部分（要誠實說）

演算法題訓練的是**演算法積木**（搜尋、排序、計數、圖走訪、DP）。大程式裡更多的是**黏合程式**：CRUD、欄位轉換、驗證、格式化、I/O、錯誤處理。這些題庫幾乎沒有。

因此範本庫分兩類：

1. **演算法範本**：練習場產出，驗收用題庫測試。
2. **黏合範本**：內建＋從使用者專案抽取，驗收用規格範例＋屬性測試（例如 `filter` 的結果必為輸入的子集、`sort` 結果長度不變且有序）。

只做第 1 類，大程式還是寫不完。

## 五、風險

| 風險 | 對策 |
|---|---|
| 誤命中：意圖相近語意不同 | 槽位填完先跑範例，不過退下一條路 |
| 範本記住整題解答，換個題就失效 | 晉升要求跨題命中；留 `hidden` 測試；範本必須有槽位，沒有槽位的整段程式不收 |
| 沙盒跑到無窮迴圈或惡意程式 | 步數與時間上限；離線 JS/Pyodide 沙盒，不給檔案與網路 |
| 函式各自通過、組合起來不通 | UML 關係檢查：呼叫對象存在、簽名吻合（純程式驗證） |
| 跨函式風格不一致 | 思考堆疊標頭帶同類別已定的命名與錯誤處理慣例 |
| 範本庫太大，比對本身變成負擔 | 分層索引，一次只給 4～6 個候選 |

## 六、要量的指標（用 `uml_bench_core` 一類的基準）

- 每條路的一次通過率（pass@1）：範本命中／組合／選擇題補全。
- 範本命中率隨練習題數增加的曲線（庫長大後第二十個同類函式是否真的近乎免費）。
- 平均每個函式的模型呼叫次數與 token。
- hidden 測試通過率與範例測試通過率的差距（過擬合指標）。
- 端到端：給一個情境，產出的整個專案能否編譯、跑過整合測試。

## 七、落地順序

**第一階段（思考寫程式）**
1. **驗收器（已做，第九節）**：十種語言的編譯、執行、判決。
2. **種子題庫（已做，20 題，第八節）**：涵蓋 14 種標籤，每題有 `tests` 與 `hidden`。
3. **思考寫程式迴圈（已做一層；CoLU 接線、多層遞迴未做，第八節）**：需求 → 思考堆疊／UML 切割 → 寫程式 → 判題器 → 失敗就帶判決與訊息重想（有次數上限）；每個函式一個堆疊框架。
4. 函式規格格式，從 `design_core` 葉層輸出（意圖、範例、依賴）。
5. 在真的小模型（`qwen3-0.6b`）上量：每題的一次通過率、重想次數、可寫對的程式規模。

**第二階段（範本庫）**
6. 範本庫與比對器（`fn_template_core.js`）：用第一階段通過驗收的函式回存，先內建 20 個樣式。
7. 練習迴圈：題目→三條路→驗收→回存，記錄指標。
8. 黏合範本：從專案抽取，接 UML 規格。
9. 語法選擇題補全（第 3 條路）。

## 八、第一階段的做法：CoLU＋思考＋UML design 遞迴切割＋思考堆疊（迴圈已實作；CoLU 接線、真模型實測未做）

**實作狀態（2026-11-05）**

| 項目 | 狀態 |
|---|---|
| 種子題庫 `renderer/src/recipe/seed/problems.jsonl`（20 題；原始檔 `scripts/seed-problems-src.js`、建置 `scripts/build-seed-problems.js`） | 已做。範例輸出手寫、用來反驗參考解；hidden 輸出由參考解算（所以 hidden 只保證和參考解一致） |
| 迴圈 `renderer/src/recipe/code_loop_core.js`（切割→由葉往上逐函式寫→組裝→判題→選擇題挑函式重寫）＋假模型 `code_loop_fake.js` | 已做。9 種語言可切函式（python、nodejs、c、c++、java、ruby、perl、bash、c#）；組語不切、整檔一個節點 |
| 測試 | `code_loop_core.test.js` 15 項（假判題器，流程控制）、`code-loop.test.js` 14 項（真判題器：20 題回放參考解全 AC、9 種語言兩函式組裝、寫錯→重寫、作弊→hidden 抓到、C 編譯錯→重寫） |
| 思考堆疊 | 已接：每個階段一個框架（`program`／`split`／`fn:名`／`rethink#n`），標頭帶目標、路徑、已定的函式簽名；`opts.stackChecks:true` 才用 `planChecks`／`selfValidate`／`reviewReturn`（預設關，離線小模型呼叫貴） |
| 遞迴深度 | **目前只切一層**（程式→函式）。函式內部再切成步驟、類別／套件層，還沒接 `design_core` |
| thinking 模式 | 只在重寫那一輪開（`meta.thinking`）；由注入的 `write` 決定怎麼用 |
| 專案模式 `renderer/src/recipe/code_project_core.js` | 已做：UML 模型 → 專案→套件→類別 逐類別寫 → 合成一個檔案 → 編譯檢查（有 driver＋測試才跑出行為）；python、nodejs、java、csharp、cpp、ruby、perl，真的編譯器驗證過 |
| 巢狀切割 | 已做：函式標 `complex` 可再切（最多 `maxDepth` 層，名稱衝突／切不開就維持單一函式並記 gap）；仍沒接 `design_core` 的套件／類別層（專案模式用的是 UML 模型本身的類別） |
| CoLU（`plan_core`） | 已接純函式層：**每種語言各自一條**寫程式能力 `local_write_code_<語言>`（`lang_colu_core.js`）、單一目標 `code_program`（`uml_project` 已移除），有測試（`plan_code.test.js`）；**本機函式的宿主執行見下一列**。重寫次數與預算仍由迴圈自己管 |
| 文法引導寫作（`grammar_core.js`＋`guided_write_core.js`）、每語言各自的 CoLU（`lang_colu_core.js`） | 已做並測試，見 [DESIGN.grammar-guided.md](DESIGN.grammar-guided.md)：六種語言各自一份文法（互不共用、有負面測試）；機械算出合法 token、模型做選擇題；每語言各自的 CoLU 能力／失敗規則；C／C++ 專屬的內嵌組語；上限以函式為單位、開發期間設無限大。**真模型的選擇題準確率是否如預期還在量，第一題的結果不理想（見該文第七節）** |
| 統一入口 `code_agent_core.js` | 已做：`makeBackend`（`generate`→`ask`／`write`）、`runCode`（題目／專案／edit 三種模式）、`detectLang`／`detectLangFromCode`、`formatReport`（一定寫明驗證到哪裡） |
| 語法自動修正、從任意程式碼接續修改 | 已做，見 [DESIGN.code-repair.md](DESIGN.code-repair.md)（含實測數字與限制） |
| 基準腳本 `scripts/eval/code_loop_bench.js` | 已做：回放模式（只證明管線）與 OpenAI 相容服務模式（量真模型）；**需要你自己把模型服務跑起來**，這台機器沒有 qwen3-0.6b |
| 真的小模型 | 已接（評估用適配器，見八之三）；結果見八之三。`ask`／`write` 都是注入的；真模型要自己實作這兩個函式（`ask` 要回「通過 validate 的 JSON 或 null」，可用 `recipe_core.jsonStep` 包） |
| 組語的迴圈整合測試 | 沒做（判題器本身的組語測試有）；迴圈對組裝只有單元測試 |
| 宿主（IPC、嵌入 `floating-assistant.js`、`write_code`／`fix_code` 工具、CoLU 的本機函式） | 已做（2026-11-05）：`main.js` 的 `fa:judge:available／run／check`（輸入驗證與大小上限；要開「允許 AI 執行程式」、第一次走既有的 `execConfirmGate` 確認框、同視窗 10 分鐘內不重複問；回傳帶 `sandbox` 限制說明）、`preload.js` 的 `desktopAPI.judge`、五個新模組嵌入 `floating-assistant.js`、`write_code`／`fix_code` 工具、`_planEnv().fns` 的 `local_write_code`／`local_write_project`；網頁版沒有判題器時誠實回 UNAVAILABLE、gaps 寫明「完全沒有驗證」。`scripts/main-tests/judge_ipc.test.js`（4 項）與既有測試全過；**在真實 Electron（xvfb、全新 user-data-dir、假模型、真判題器）跑過** `scripts/eval/code_agent.eval.js`。**沒驗證**：確認框的真實彈窗（eval 為了無人值守關掉了確認，確認邏輯只靠桩測試）、electron-builder 打包後 `judge_core.js` 是否真的在安裝包裡（`package.json` 的 `files` glob 順序沒實測）、網頁版 |

**測試證明了什麼、沒證明什麼**：假模型回放參考解，只證明題庫自洽、管線與組裝在各語言通、失敗回饋與重寫流程對、回饋不洩漏 hidden。**不證明**小模型能寫對任何一題。20 題全 AC 是回放參考解的結果，不是能力數字。

使用者原話：「要利用CoLU+思考與uml-design的recursively切割+思考堆疊」。四個既有零件各管一件事：

| 零件 | 在這裡負責 |
|---|---|
| UML design（`design_core`／`uml_core`） | **遞迴切割**：需求 → 系統 → 套件 → 類別 → 操作 → 操作內的步驟；每一層只讓模型回答一個小問題 |
| 思考堆疊（`think_stack`） | 每往下切一層 push 一個框架，做完 pop；標頭帶目標、路徑、上層已定的決定（命名、簽名、錯誤處理慣例）；`planChecks`／`reviewReturn`／`selfValidate` 在往下前、回來後、離開前各檢查一次 |
| 思考（thinking 模式） | 只用在「值得多想」的節點：切割方式的決定、演算法選擇、驗收失敗後的重想；不是每個 token 都想 |
| CoLU（`plan_core`） | 外層規劃與調度：決定下一個要補哪個節點、失敗後怎麼重新計畫、何時放棄某條路並回報 |

### 遞迴的樣子

```
solve(node, stack):
  push(stack, node)                              # 焦點標頭：目標／路徑／已定
  if node 夠小（能直接寫成一個函式或一段步驟）:
      code = write(node)                         # 小模型寫，標頭帶著同層已定的簽名與慣例
      verdict = judge(code, node.tests)          # 第九節判題器，程式端驗收
      if verdict != AC and 重想次數 < 上限:
          code = rethink(node, verdict.detail)   # 帶判決與失敗那筆的訊息再想；這一輪才開 thinking
      pop(stack, {summary: 簽名＋一行語意, verify: 判決})
  else:
      children = split(node)                     # UML design 切割；每個子節點有自己的規格與測試
      planChecks(stack)                          # 往下之前：回來前要檢查什麼、標準是什麼
      for c in children (依 CoLU 計畫的順序，被依賴的先做): solve(c, stack)
      reviewReturn(stack)                        # 回來後逐項核對（呼叫的函式都存在、簽名吻合…）
      integrate(node)                            # 組起來，再跑這一層的整合測試
      pop(stack, {...})
```

### 「夠小」怎麼判斷（程式端，不問模型）

- 規格的簽名與範例都齊全，且預估步驟數 ≤ 門檻（例如 6 步）；或
- 切割已達最大深度（避免無限切）：此時直接寫，寫不對就回報「切不動」給上層，由上層重新切。

### 每層怎麼知道對不對

- **葉層（函式）**：判題器。測試來源優先序：使用者給的範例 → 題庫（種子題）→ 規格自帶的屬性測試。模型自己產生的期望值**不單獨當依據**。
- **中間層（類別、套件）**：整合測試（把子函式組起來跑）＋ UML 關係檢查（純程式：呼叫對象存在、簽名吻合、沒有循環依賴）。
- **最外層**：使用者的原需求。能自動驗的部分用判題器；不能自動驗的（例如介面好不好看）標 `unverified`，不宣稱已驗證。

### 失敗時怎麼辦（CoLU 負責）

1. 葉層重想（帶判決與失敗訊息，上限 2～3 次）。
2. 還是不過 → 回報上層「這個節點切不動」→ 上層重新切（換一種切法）。
3. 整棵子樹反覆失敗 → CoLU 重新計畫，或把這個節點標成 `gap` 回報使用者，**不要假裝完成**。
4. 每一層的重試次數、模型呼叫次數、token 都記帳；離線小模型的呼叫很貴，要有總預算，超過就停並回報進度。

### 要先量的事（沒量之前都只是假設）

- 沒有範本時，`qwen3-0.6b`（窗口 4096）在「切割＋思考＋驗收重想」下，每題的一次通過率與重想次數。
- 能寫對的程式規模：切到多深、幾個函式、幾行，整合測試開始大量失敗。
- 思考堆疊的標頭是否真的讓跨函式命名與簽名更一致（思考堆疊文件已經列為待量）。
- 各語言差異：同一個切割，Python 與 C／asm 的通過率會差很多；組語很可能需要更細的切割（寄存器與呼叫慣例當作已定決定放進標頭）。

### 接線點（既有程式碼）

- `design_core.reworkRegion` 的葉層（類別、操作）目前只產生骨架；新增「寫操作本體」這一層，路徑 `class:Order > op:pay > body`。
- `plan_core.advance` 的步驟型別增加 `write_function`（寫）與 `judge`（驗），失敗轉成 CoLU 的重新計畫。
- 判題器已在 `judge-runner.js`；宿主要在 Electron 主程序，經 IPC 給 renderer 呼叫（renderer 沒有 `child_process`）。網頁版沒有本機工具鏈，只能回 UNAVAILABLE，這一點要在介面上講清楚。

## 八之二、`write_code` 對使用者只有一個入口（2026-11-05 使用者校正）

使用者原話：「我希望write_code就是write_code，對使用者來說不分是不是uml，要AI自己去看這是不是應該走uml」「使用者只管需求丟出來，產生程式」。

- 工具 `write_code` 的參數只剩：`task`（需求）、`language`、`tests`、`model`；**沒有 `uml`、`use_last_design`、`driver`**。CoLU 也只有一個目標 `code_program`（拿掉獨立的 `uml_project` 目標）。
- 路線由 `FaCodeAgent.runCode` 內部決定：`routeOf(text)`（程式端）依規模信號評分——系統／平台／網站、多個功能句、多個領域名詞、條列、需求很長 → 偏 UML；函式／演算法／輸入輸出規格／附測試／很短 → 偏直接。分數 ≥3 走 UML，≤0.5 直接寫，**中間是模糊帶**：有 `ask` 就讓模型做一題 A／B 選擇題，沒有就選比較便宜的直接寫並記 gap。
- 走 UML：呼叫注入的 `design({text, lang})`（宿主用 `FaDesign.designProject`；同一份需求最近設計過就沿用，不重做）→ 專案模式（逐類別寫、合成一個檔案、編譯檢查）。**設計失敗、沒有設計能力、語言不支援專案模式（c／bash／asm）→ 退回直接寫並記 gap**，不丟例外。
- 結果帶 `route`（走了哪條、誰決定的、理由、是否退回）與 `design`（UML DSL）；`formatReport` 一定寫出路線與驗證到哪裡；進度事件有 `route`。
- 限制：走了 UML 的大需求目前只做編譯檢查（沒有進入點程式碼，使用者給的 tests 不會被執行，gaps 會說明）；路由規則是手寫的評分，沒有用真資料校準，邊界案例（例如一句話的「停車場管理系統」）落在模糊帶。

## 八之三、真模型驗證（離線 qwen3-0.6b＋CoLU＋thinking，2026-11-05）

使用者同意下載模型後，在這台機器上用**桌面版原生引擎的同一套分詞、提示樣板、取樣與 KV 快取迴圈**跑真的 `qwen3-0.6b`：

- 下載（放 scratchpad，不進倉庫）：`onnx-community/Qwen3-0.6B-ONNX` 的 `onnx/model_quantized.onnx`（q8，589.1 MB；桌面版 CPU 預設就是這個 dtype）、`tokenizer.json`（9.1 MB）等設定檔；`onnxruntime-node@1.22.0`（桌面版文件固定的版本，`--ignore-scripts` 安裝）。**兩個大檔的 SHA-256 與 Hugging Face 公布的一致**。
- **發現**：生產用的 `nr-engine.js` 寫死 `enable_thinking:false` 且沒有 prefill，也就是桌面版的原生 CPU 路徑本身不跑思考模式（思考走 WASM／WebGPU 路徑）。所以評估用 `scripts/eval/native_gen_adapter.js`（複用 nr-tokenizer／nr-template／nr-gen-params，另外支援 `enableThinking` 與 prefill），**沒有改生產引擎**。
- 基準腳本 `scripts/eval/code_loop_bench.js`：`--backend native`、`--via direct|colu`（`colu`＝把需求包成使用者的話 → `matchGoals` → `buildPlan` → `advance` → `local_write_code` → `runCode`，就是宿主 `_planEnv` 做的事）、`--think`（只在重寫那一輪思考，設計預設）、`--think-all`（每次問與寫都思考）、`--trace-file`（每次模型呼叫的提示尾端與輸出，給診斷）。
- 速度（這台機器，24 核、threads 8～12）：不思考約 20 token/s、思考約 13 token/s。
- 冒煙：`29 × 37` 不思考答 1059（錯，應為 1073），思考模式算對——正是需要比較「思考」與「不思考」的原因。

RESULTS_PLACEHOLDER

## 九、判題器（第一階段，已實作 2026-11-05）

- `renderer/src/recipe/judge_core.js`（純函式，UMD）：`validateProblem`、`compare`（lines／tokens／float／unordered-lines／unordered-tokens）、`summarize`。測試 `judge_core.test.js`（6 項）。
- `judge-runner.js`（Node／Electron 主程序專用）：`available(lang)`、`judge({lang, source, problem, timeoutMs, ...})`。測試 `judge-runner.test.js`（21 項）。
- 題目是 stdin→stdout（ACM 風格），每筆 `{in, out}`；`tests` 給模型看，`hidden` 只在驗收用。LeetCode 式的函式簽名題需要另外的 harness，**還沒做**。
- 判決：AC／WA／TLE／RE／OLE／CE／UNAVAILABLE。沒有工具鏈的語言回 UNAVAILABLE，不算失敗也不算通過。

| 語言 | 編譯／執行 | 本機驗證 |
|---|---|---|
| python | `python3` | 通過（3.10） |
| nodejs | `node` | 通過（v20） |
| c／c++ | `gcc -O2`／`g++ -O2 -std=c++17` | 通過（11.4） |
| java | `javac`＋`java`，公開類別必須叫 `Main` | 通過（17） |
| ruby／perl／bash | 直譯 | 通過 |
| asm-x64／asm-x86 | GNU `as`（寫 `.intel_syntax noprefix`，進入點 `_start`）＋`ld`，不連 libc，直接用系統呼叫；x86 用 `int 0x80` | 通過；x86 有 probe 先證明核心跑得了 32 位元執行檔 |
| csharp | `mcs`（或 `csc`）＋`mono` | 通過（mono 6.12）；`dotnet` 沒有，未支援 |

A+B 參考解在這 11 個目標（x86、x64 組語算兩個）全部 AC；另外驗證了 WA、只過範例的作弊解（hidden 抓得到）、無窮迴圈與子行程不退出的 TLE（整個行程群組被殺）、非 0 結束碼的 RE、輸出爆量的 OLE、C 的 CE、stdin 沒讀完不會掛住。

**限制（誠實）：**
- **不是安全沙盒**：只有精簡環境變數、獨立暫存目錄、時間與輸出上限，沒有記憶體上限（Java／Mono 用位址空間限制會起不來），沒有檔案與網路隔離。只能跑自己或本機模型產生的程式。
- 只驗證了 A+B 這一題的參考解，證明「每種語言的編譯、執行、比對、判決都通」，**不代表**各語言的複雜程式都能通過；也還沒有任何小模型實測數據。
- 沒有裝 `nasm`，所以組語只支援 GNU as 語法。
- 尚未嵌入 `floating-assistant.js`（`embed-code-ui.js` 的嵌入區塊），目前只能在 Node 端使用。

## 八、與既有設計的關係

- [DESIGN.think-stack.md](DESIGN.think-stack.md)：焦點標頭、`planChecks`、`selfValidate` 直接用在函式層；每個函式一個框架。
- [DESIGN.unit-catalog.md](DESIGN.unit-catalog.md)：第 2 條路的「單元」來源；範本的槽位型別沿用單元型別。
- [DESIGN.skill-recipes.md](DESIGN.skill-recipes.md)：食譜引擎的步驟與驗證可複用於「組合」這條路。
- [DESIGN.colu.md](DESIGN.colu.md)：總覽。
