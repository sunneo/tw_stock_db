# 思考堆疊：小模型深入解題時不要忘記在做什麼（2026-11-05）

使用者原話：「我想到一個離線模型跟小模型的點子，幫我評估，因為uml-design+think, CoLU 深入思考，也有可能在深入解決計畫項目時，忘記剛剛再做什麼，這有沒有可能發生？這邊怎麼解決，可以用思考堆疊來做嗎」「做思考堆疊」。

## 問題（讀程式確認）

- 程式端的狀態不會忘：`reworkRegion`、`jsonStep` 每次都用程式裡的模型重組提示，每一題是獨立呼叫。
- 會忘的是**給模型看的上層脈絡**：往下鑽（套件→類別→成員）時提示只有情境＋該區本身，看不到上層選了什麼、兄弟已經定了什麼；思考模式（`qwen3-0.6b`，預算 1500～3000 token，窗口 4096）又容易在長思考裡偏題；反思題只看到計畫本身、看不到使用者的目標。

## 做法

`renderer/src/recipe/think_stack.js`（`FaThinkStack`，純函式、UMD）：堆疊由程式持有，不靠模型記。

| 函式 | 做什麼 |
|---|---|
| `create(goal)`／`push(stack,{path,question,note})` | 開堆疊；往下鑽一層就 push 一個框架 |
| `decide(stack,text)` | 目前框架記一條「已定」（每框架最多 5 條，舊的擠掉） |
| `pop(stack,{summary,verify,result})` | 做完一層：一行摘要變成上層的「已定」；`verify` 不過先退回重試一次，再放行並標 `failed` |
| `header(stack)` | 焦點標頭：【目標】【路徑】（最多 4 層，更早的用 `…`）【現在這題】【已定，不要改】【上層】【做完回到】；上限 600 字元（約 4096 窗口的 5%），超過依序丟舊決定 → 上層摘要 → 截斷 |
| `wrap(messages,stack,{repeat})` | 標頭放在最後一則 user 訊息前；`repeat`（思考模式）在最後再說一次「你現在只回答這一題」 |
| `toJsonl`／`fromJsonl` | 一個框架一行 `{id,parent,path,question,state,decisions,summary}`，可還原（跟其他多層 JSONL 同格式思路） |

## 接線

- `recipe_core.jsonStep(ctx)`：`ctx.stack`＋`ctx.stackMod` 有給就每一輪（含 thinking 那輪）重新放標頭；沒給＝提示跟以前完全一樣。
- `design_core.reworkRegion`：每個區域一個框架（system／package／class／usecase），往下鑽自動巢狀，做完 pop，類別的摘要是「屬性 …；操作 …」變成上層的已定；`reworkModel` 每個問題一個框架；`opts.stack` 可共用同一個堆疊，`opts.thinkStack === false` 關閉。
- 反思：`coluThinkReflect`／`coluThinkRevise` 接 `stack`；`guideApply` 的計畫反思帶「目標＋這個設計有沒有缺口」。
- 嵌入：`FaThinkStack` 在 `floating-assistant.js` 的 `THINKSTACK` 區塊（`scripts/embed-code-ui.js`），放在 `DESIGN-BEGIN` 之前。

## 每一層的自問（2026-11-05 追加）

使用者原話：「那我們也可以幫每一層堆疊都請它評估:我再下一層堆疊回來前，有沒有什麼要檢查」「think stack, validate (自問)」。三個時間點，都是封閉小題、程式預設退路、不阻擋流程：

| 時間點 | 函式 | 問什麼 | 結果 |
|---|---|---|---|
| 往下一層之前 | `planChecks(stack,{ask,next,defaults})` | 「我要往下做 X，做完回到這裡之前，有什麼要先記下來、回來後要檢查的？」最多 3 項（去重、截短） | 存在目前框架 `checks`；下一層的標頭帶【回到上層後要檢查】；問不出來用程式預設（套件：類別都有成員、名稱不重複、關係兩端存在） |
| 回到上一層之後 | `reviewReturn(stack,{ask,returned})` | 把上層列的檢查逐項核對，每項 ok／fix | `problems` 非空 → 帶著要修的事重做那一層一次（`reason` 寫明）；問不出來 `unsure`（不當成都對，也不當成有問題） |
| 離開這一層之前（葉層：類別、使用案例） | `selfValidate(stack,{ask,result})` | 自問：「我的結果有回答這一題嗎？A 有 B 沒有：缺…」 | 沒有 → 帶著缺的東西重做一次（每區最多一次）；`res.self_check` 記 ok／missing／unsure |

接線在 `design_core.reworkRegion`：套件區域先 `planChecks`，每個類別回來 `reviewReturn`，類別／使用案例離開前 `selfValidate`；`opts.stackChecks === false` 全部關掉（只剩焦點標頭）。每次自問最多 160 token、一輪最多重試 2 次。代價：每個類別多 2 個小呼叫（核對＋自問），套件多 1 個（列檢查），小窗口的使用者可以關。

**像面對一個常常忘記的工程師**（使用者原話：「我的想法是只要脈落傳過去，並且它可以當下留下一個"該檢查什麼" 的文字跟標準」）：往下之前當下就把檢查項寫下來，每項是 `{check, standard}`——要檢查什麼，加上**怎樣算通過**（具體、一眼可判斷，例如「每個類別至少一個屬性或操作」）；寫在框架裡，下一層的標頭帶著，回來時照標準逐項核對，核對提示也附標準，不靠回來時的模型重新想標準。程式預設的檢查項也都有標準。檢查項隨堆疊 JSONL 保存與還原。

## 驗證與限制

- 測試：`think_stack.test.js`（7，含列檢查、回來核對、自問）；`design_core.test.js` 加 10 項（含套件列檢查一次、回來核對有問題就重做、葉層自問、`stackChecks:false`）（標頭內容、共用堆疊、關閉、巢狀路徑、模擬「會忘的小模型」：有堆疊時三個兄弟類別一致、沒有時各寫各的）；`think_reflect.test.js` 加 2 項；舊測試全過。
- **模擬不是證據**：「會忘的小模型」是照規則寫的假模型，只證明標頭真的送進提示、堆疊邏輯正確；真的 `qwen3-0.6b` 有沒有因此更一致，要用 `uml_bench_core` 加「兄弟一致性」評分，在使用者機器上量（待做）。
- 標頭太長會擠掉題目：所以有字元上限與摘要規則。堆疊只防「忘了在做什麼」，不增加 0.6B 的判斷力。
- 沒有用真的小模型量過效果（見上）。

## 第二批接線（2026-11-05，使用者：「先接 還沒接：uml_core 的 stageSpec 流程、CoLU 計畫階段、_umlDesign 外層」）

| 位置 | 做法 |
|---|---|
| `uml_core.scenarioToModel`（一次一個小問題：參與者→類別→每個類別的成員→關係→呼叫順序） | 整個流程一個 `design` 框架；每一問（`ask`）一個子框架（路徑 `design > members > members:Book`），做完 pop，一行結果（「類別 Book、Cart」「屬性 id；操作 run」）變成上層的已定，後面的問題都帶得到。逐類別補成員、逐使用案例排順序這兩個迴圈：往下之前 `planChecks`（檢查＋標準），做完回來 `reviewReturn` 一次；有問題記進 `warnings` 與 `decisions`，**不重跑**（離線小模型的呼叫很貴）。大問題切塊時每塊一個 `design` 框架，`note` 寫「第 i／n 塊」。 |
| `design_core.designProject`（`_umlDesign` 外層） | 整個「情境→UML→程式骨架」共用一個堆疊（目標＝使用者的原情境，`maxDecisions` 8）：產生模型（含切塊）、計畫反思、rework 都在同一個 `project` 框架底下；`opts.stack` 可由外面給。 |
| `plan_core.advance`（CoLU 計畫階段） | `env.stackMod` 有給就每一步 push／pop（路徑 `plan > s2:local_summarize`，結果摘要變上層已定）；`env.fill(step, missing, {stack, stackMod})` 多一個第三參數，宿主 `_planEnv` 的 `fill` 把它交給 `modelFill`；`recipe_core.modelFill`／`chooseTool` 接 `stack`。`advancedSettings.thinkStack === false` 關閉。沒給 `stackMod` 就跟以前完全一樣。 |

**思考模式下額外的列檢查／核對／自問預設不加**（每題已經 1500+ token，且 `plan_think.test.js` 規定思考請求的形狀）：`stackChecks:true` 才開；焦點標頭照樣會帶。沒開思考的離線小模型預設會加。

## 真模型實測：兄弟一致性（2026-11-06，qwen3-0.6b Q8，本機 llama.cpp，溫度 0.7）

使用者原話：「先完成用真的 qwen3-0.6b 量思考堆疊的兄弟一致性。需要有模型的機器，目前只有假模型。」

**做法**：`uml_bench_core.siblingConsistency(model)`（純程式評分，不問模型）：`naming`＝類別名同一種寫法的占比、`style`＝方法與屬性名最多的那種寫法（camel／snake…）的占比、`refs`＝步驟與關係指到的類別、方法、參與者都存在的占比、`unique`＝沒有重複名稱；`score`＝有值項目的平均。腳本 `scripts/eval/stack_consistency.js`（服務用 `scripts/eval/mini_llama_server.py`）：同一批情境、同一個真模型，跑三種變體——`off`（`thinkStack:false`）、`stack`（焦點標頭）、`checks`（再加往下前列檢查／回來核對／自問，`stackChecks:true`）。

**一個重要的限制（本身就是發現）**：生的 0.6B 連第一階段都過不了——參與者與使用案例的名稱要英文 PascalCase，它四次都重複中文名（開思考也一樣），完成率 0。所以前兩階段（參與者／類別）由程式用人工答案回答（`uml_bench_core.FIXTURES` 的第一個英文名，等於 DESIGN 的 program_first 建議），類別成員、關係、呼叫順序（兄弟最多、最容易前後不一）交給真模型。這個評測量的是「小模型在後面三個階段會不會前後不一」，不是整條流程。

**結果**（5 情境 × 3 變體 × 4 次＝60 組；member 情境 12 組全部在「類別」階段就被擋（我給的人工答案類別 `User` 跟參與者 `User` 同名，是評測設定的問題，不是模型的問題），不列入；其餘 4 個情境每個變體 16/16 完成）：

| 變體 | 完成 | 一致性 | 風格 | 最差一組 | 一次合格率 | 平均呼叫 | 平均秒 |
|---|---|---|---|---|---|---|---|
| off | 16/16 | 0.99 | 0.89 | 0.96 | 0.69 | 13.2 | 32 |
| stack | 16/16 | **1.00** | **1.00** | 1.00 | 0.72 | 12.1 | 43 |
| checks | 16/16 | 1.00 | 0.99 | 0.98 | 0.59 | 18.0 | 54 |

成對比較（同情境同次數、兩邊都完成的 16 組）：`stack` 比 `off` 較好 5、較差 0、持平 11；`checks` 比 `off` 較好 5、較差 1、持平 10。

**怎麼讀（誠實）**：
- 有效果但很小：差別幾乎全在「風格」（成員名稱的 camel／snake 一致）——`off` 偶爾前後不一（最差 0.96），`stack` 的標頭把前面兄弟的寫法帶進提示後 16 組全部一致。命名、參照、不重複三項 `off` 本來就接近滿分，沒有可比的空間。
- 沒有勝過 `stack` 的證據：額外的列檢查／自問（`checks`）沒有更好，反而多 49% 的呼叫、一次合格率更低（0.59），所以預設維持「思考模式下額外檢查關閉」是對的；非思考模式要不要預設開，這份數據不支持。
- `stack` 每組多約 10 秒（標頭讓提示變長，加上這台機器同時在跑別的工作，時間只能當量級）。
- 樣本：16 組成對、4 個有效情境、單一模型與溫度；`off` 的 0.99 本來就高，天花板效應明顯，不能推論到「完成率」或「正確性」——標頭沒有讓更多組做完（都是 16/16，天花板），一次合格率 0.69→0.72 在雜訊內。
- 還沒量：真的離線跑 CoLU 計畫階段、`chooseTool` 路由堆疊的效果（這次只量 UML 拆解）；開思考模式；不同溫度（0 的結果會是確定的）。


## 離線寫程式路徑的缺口（blockly-teach，2026-11-07；唯讀調查＋我覆核）

調查原文在協調 session 的 notes（`blockly-teach-thinkstack-colu-gaps.md`）；我覆核過的事實：`py_uml_pipeline_core.js`、`py_cnl_choose_core.js` 沒有任何 `stackMod`／`FaThinkStack`／stackChecks；`runCode` 的 `stackMod` 只傳給模型路線（`Loop.solve`、`Proj.solveProject`、`Ed.editCode`），離線 `a.offline(...)` 在這些之前執行、沒收到它；`siblingConsistency` 只有基準腳本 `uml_bench_core.js` 呼叫。行號因嵌入重建一直在飄，以符號名為準。結論成立：**離線路徑沒有堆疊框、沒有一致性檢查、沒呼叫 CoLU 規劃路由；失敗時「卡在哪一層」原本被丟掉**。

| # | 缺口 | 狀態 | 說明／下一步 |
|---|---|---|---|
| A | 離線失敗時 `rounds` 被丟掉 | **已補（97231841）** | `_codeOffline` 失敗與成功都帶回 `rounds`；`runCode` 外層把「配方✘→課✘→範式✘(試 N 個)→矩陣✘」摘進 `gaps`（後面的路線會整個換掉 gaps，所以在最外層補回）；`code_agent_core.test.js` 有測試 |
| B | 成功時也帶回 rounds | **已補（97231841）** | `offline.rounds` |
| C | 離線沒有思考堆疊框 | **已接線（2026-11-08）**：`FaOfflineStack`（`offline_stack_core.js`，已嵌入）的 `wireOffline` 由 `_codeOffline` 結尾經 `_offlineStackWire` 呼叫，回傳值多 `stack`（JSONL 行）、`stuckAt`、`stackHeader`（失敗時）、`stackNote`。`runCode` 失敗轉模型時，給模型的敘述尾端改用堆疊標頭（含「不要重複前面失敗的路」），gaps 多一句「卡在「某層」」；沒有標頭（舊嵌入）就退回原本的單行字串。成功時 `stuckAt` 一律 null（實機遇過矩陣層成功但 rounds 只記 `matrix✘`）。測試：`offline_stack.test.js` 7 項、`code_agent_core.test.js` 缺口 C 一項；真 Electron 評估 `scripts/eval/offline-stack.eval.js`（`FA_EVAL_EXEC=1 node scripts/eval/code-slash.run.js offline-stack`）確認 `_codeOffline` 實跑帶回 stack | **待改善**：層內（例如範式試了哪幾個骨架）沒有逐項框；`Stack.decide` 只記到層；堆疊目前只輸出不存檔，也沒顯示給使用者看（gaps 只有一句卡在哪） |
| D | 離線失敗轉模型路線時，已試過的層沒交給模型 | **已補（2026-11-08）**，並在 C 接線後改用堆疊標頭（沒標頭才用單行字串） | — |
| E | 離線沒有 stackChecks | **已接線（2026-11-08）**：`wireOffline` 在離線成功時跑 `selfCheck`。程式檢查永遠跑；問模型的自問預設關（`enabled:false`，這條路徑不傳 `ask`）。結果進 `stackNote`，只提醒、不擋（成品已過沙盒判題） | **待改善**：命名風格檢查（`ir_blocks_core.styleCheck`）**沒有接**——它要先嵌入六個中間語言模組才能建橋，這次沒嵌，所以目前離線路徑上實際跑的程式檢查是空的（`check.ok` 恆為 true，只證明接線通了）；自問是否值得預設開沒有實測 |
| F | 兄弟一致性只在基準腳本 | **部分補（2026-11-08）**：純程式的 `styleCheck(python)`（`renderer/src/ir/ir_blocks_core.js`，測試 `ir_blocks.test.js`）檢查函式名／變數名主流命名風格占比並指出混用的名稱 | **待改善**：尚未接進離線路徑（`_codeOffline` 沒呼叫它，要管理者接線）；不是語法樹比對；離線模型固定單類別，跨類別一致性未設計 |
| G | CoLU 規劃路由未接到寫程式流程 | **不建議接** | `FaRoute` 是「找不到工具」的路線，離線組合不是它的場景；只在 gap 說明。若要接，先釐清需求 |
| H | `DESIGN.colu.md` 沒有堆疊／一致性／規劃路由的定義 | **已補（本批）** | 在該檔加交叉引用，註明離線尚未接線 |
| I | `chooseTool` 路由堆疊、CoLU 計畫階段實測 | **量測骨架已補（2026-11-08）**：`measureRoute`＋`scripts/eval/stack_route.js --url <模型服務>`（同一批 10 題×重複、無堆疊 vs 有堆疊的正確率與呼叫數）；骨架用確定性假模型驗過會跑、堆疊版提示確實帶標頭 | **待改善／需真模型**：**還沒有任何真模型數字**（2026-11-08 再查：這台機器沒有 `llama_cpp`、也找不到 qwen3-0.6b 的 gguf，桌面版自己的離線模型在使用者執行中的資料夾裡不能動；要得到數字需要下載模型或提供一個已在跑的 OpenAI 相容服務網址，尚未獲同意），所以不能宣稱路由堆疊有沒有效；CoLU 計畫階段的量測尚無骨架；題目是自己出的小題組，量測時要注意天花板效應 |
