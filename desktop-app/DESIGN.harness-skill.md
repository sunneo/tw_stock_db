# 弱模型 harness 做成 skill（零件地圖、缺口、進度）

> 結論：有機會，零件已經九成齊。缺的是兩樣：①一個「不依賴 Electron、可跨呼叫續跑」的封閉題迴圈（命令列），②一個「程式核對才收」的經驗閘門。這份文件是一頁地圖；交接與使用者原話在 `DESIGN.TODO.md（原檔：harness-skill）`。

## 1. 零件地圖（已有，不重做）

| 職責 | 檔案／函式 | 備註 |
|---|---|---|
| 封閉小決策（含退回重答） | `renderer/src/recipe/recipe_core.js`：`jsonStep`、`parseJsonLoose`、`validateFill`、`fillMessages`、`modelFill` | 模型只看到自己最後一次回覆＋精確錯誤；兩次相同回覆提前停 |
| 路由（程式先決定） | 同檔：`narrowByEvidence`、`autoPick`、`menuMessages`、`chooseTool`；`catalog/route_core.js`、`catalog/select_core.js`（`retrieve`、`parseChoice`） | 差距夠大就不問模型 |
| 欄位程式預設 | 同檔：`programFill`、`relevantOptional`、`slotsFromSchema` | 沒有的欄位填 null，不准編 |
| 措辭與檢查 | 同檔：`checkExtractive`、`phraseMessages` | 數字／識別字必須出現在來源 |
| 食譜執行 | 同檔：`validateRecipe`、`runRecipe`、`newTrace`、`decide`、`pushRing` | 每個決定都有「誰決定的」紀錄 |
| 目標規劃與失敗規則 | `recipe/plan_core.js`：`matchGoals`、`buildPlan`、`createRun`、`advance`、`decideFailure` | |
| 技能轉食譜 | `recipe/skill_compile_core.js`：`extract`、`compile`、`gapScenario` | 把 SKILL.md 的步驟編成食譜；這是「skill」的第二個意思，本案沿用它把步驟變題型 |
| UML 細切與編修 | `uml/design_core.js`（`findIssues`）、`uml/glue_core.js`、`uml/uml_edit_core.js`：`candidates`、`choose`、`apply`、`pickIndex` | 失敗經驗的去處（只產生候選，不直接寫知識） |
| 接線 | `catalog/bind_core.js`、`catalog/relu_core.js`、`catalog/matrix_core.js` | 型別接線，零次模型呼叫 |
| 評測題與評分 | `catalog/colu_bench_core.js`：`makeTasks`、`buildPrompt`、`grade`、`summarize` | 需要單元目錄矩陣 M，實驗用小題組另備 |
| 領域 harness | `harness/intent_harness.js`（`FaHarness`，影片領域第一個） | 領域專用，不是通用迴圈 |
| 訓練器知識形狀 | `edit/edit_cases.js`：`makeEntry`（pattern 小、body 大分開存） | 回流的 pattern 沿用這個形狀 |
| 訓練器本體 | `renderer/src/floating-assistant.js`（`_otPlan`、`_otExecute`、`FA_OT_*`） | 熱點，音樂線在跑時不碰 |

## 2. 缺口（具體到檔案與函式）

1. **通用封閉題迴圈（命令列）**：沒有。新增 `skills/weak-model-harness/scripts/harness.js`，子命令 `start／next／answer／status／learn`，狀態存 JSON，可中斷續跑。核心邏輯寫成純函式放 `skills/weak-model-harness/scripts/loop_core.js`（`createSession`、`currentQuestion`、`submitAnswer`、`finish`），重用 `recipe_core` 的 `autoPick`、`validateFill`、`parseJsonLoose`。
2. **任務範本**：路由用的範本表（每個範本＝關鍵字＋有序題目＋最後的程式驗證）。新增 `skills/weak-model-harness/references/templates.json`。
3. **經驗與回流閘門**：沒有。新增 `renderer/src/harness/experience_core.js`（`FaHarnessExp`）：`makeRecord`、`signature`、`redact`、`gate`、`merge`、`toTrainer`、`toUmlEdit`、`migrate`（格式版本）。
4. **訓練器的「來自 harness」來源與開關**：`floating-assistant.js` 內尚無來源標示與可停用；等沒有別的寫手再做（第 6 項）。在那之前，命令列的 `learn` 把通過閘門的 pattern 寫進輸出檔 `harness-experience.json`，由應用程式匯入。
5. **打包**：套件要能搬走，需要腳本把用到的核心複製進 `scripts/vendor/`（`pack.js`）。
6. **用量記錄與實驗腳本**：`scripts/harness-tests/haiku-experiment.js`（小樣本、記用量、查不到模型就寫未驗證）。

## 3. 迴圈形狀

```
start 任務文字 → 程式路由到範本（autoPick；差距不夠才出一題路由選擇題）
next            → 印出一題封閉題（選擇題用字母；填空題列出固定欄位）
answer 答案     → 程式核對；不合格附精確原因退回，最多兩次；仍不合格 → 程式預設退路（紀錄 by:default）
（全部題目走完）→ 程式組裝結果並驗證 → 判定 ok／unverified／failed
learn           → 經驗閘門：只收程式驗證過的成功；去重、去識別、大小上限；輸出訓練器 pattern 或 UML 編修候選
```

## 4. 進度與未驗證

- 第 1 項：本文件（已寫）。
- 第 2、3 項（已做，測試 loop 21 項、experience 26 項全過）：skill 套件 skills/weak-model-harness/（SKILL.md、scripts/harness.js、loop_core.js、pack.js、references/）、經驗閘門 renderer/src/harness/experience_core.js；兩組測試已加進核心測試清單。命令列 learn 把通過閘門的 pattern 寫到 .weak-harness/trainer-patterns.json，失敗寫成 uml-candidates.json。範本目前 4 個（安排會議、單位換算、問題分級、批次改檔名），從技能編譯器（skill_compile_core）自動產生範本：未做。
- 第 4 項（Haiku 實驗）：**已跑，2026-11-01**，模型 claude-haiku-5-5（用 claude -p，使用者提供的登入權杖以環境變數傳入，沒寫進任何檔案）。固定 8 題（人工標準答案：範本＋欄位）、小樣本，只能當方向不能當統計。
  - 第一輪（範本標籤只有短名稱）：光桿 Haiku 完全答對 4/8、路由對 6/8、欄位 13/20；加 harness 完全答對 6/8、路由對 6/8、欄位 16/20；harness 被退回的答案 0 次、格式違規 0。兩邊各有 2 題路由錯（沒有關鍵字的「排版有點對不齊」「請問怎麼用匯出功能」）。光桿另外把取代的「舊字／新字」填反一題，加 harness 沒錯（目標欄位由題目分開問）。用量：16 次呼叫、輸入約 57 萬（大部分是 Claude Code 自己的快取前綴，每次呼叫約 3.5 萬）、輸出約 2500 個 token、約 0.023 美元。
  - 找到的弱點：路由題的選項太短。我把四個範本的標籤改成帶說明（例如「問題分級（回報程式的問題或錯誤、排版瑕疵，或詢問怎麼用某個功能）」），只重測那 2 題：光桿與 harness 都 2/2。**這是看過失敗題之後調整再測，不是獨立驗證**，而且光桿也跟著受益（光桿的提示也用同一份標籤），所以不能拿來說 harness 贏在路由。
  - 結論（誠實版）：在這 8 題上 harness 的優勢來自「欄位一題一題問、程式核對」（欄位 16/20 對 13/20，完全答對 6 對 4），路由則取決於範本標籤寫得好不好。樣本太小，沒有顯著性。
- 第 4 項補（語意路由，2026-11-01）：loop_core.routeCands 加了語意路由——範本的 examples 用離線訓練器的特徵雜湊嵌入跟使用者的話比餘弦，0.5 以上才由程式決定，弱的不猜（vendor/trainer_core 不在時自動略過）。**實測沒有救到那兩題**：「請問怎麼用匯出功能」只有 0.37、「排版有點對不齊，按鈕也歪了」只有 0.29（且跟另一個範本打平），低於門檻；把門檻降到 0.3 又會把「今天天氣如何」（0.27）誤路由到單位換算。所以門檻維持保守的 0.5，只在像「幫我把照片的名字統一加上日期」這種夠像的說法才起作用。結論：這兩題要靠路由題的說明文字（已改善）與回流經驗（相似說法才有用），特徵雜湊嵌入對短中文句分不開；若要更強的語意路由，需要真的嵌入模型（專案有嵌入設定，但 skill 內沒帶）。順手修了一個 bigrams 的跳脫字元錯誤（空白與數字的正規化原本沒生效）。
- 第 5 項（回流前後對照）：回流真的會改變路由——loop_core.routeCands 吃 hints（來自 experience.json，字元二連詞相似度 0.4 以上算命中，第一步標 learned）。程式部分已量：沒有關鍵字的相似說法，回流前路由不到、回流後由程式路由，無關的話不被誤路由（loop.test.js）。真模型的「回流後再跑一次同題組」：未做——第 4 項這 8 題彼此不相似，回流的經驗幫不到彼此，要設計成對的相似題組才有意義。
- 第 6 項（訓練器 UI 定位、清冊、嵌入）：訓練器頁「🧪 匯入 harness 經驗」按鈕、獨立領域 harness_experience（來源 harness、預設停用）、清冊說明、host_import.test.js（commit 3e710f19）。建置產物（renderer/floating-assistant*.js、update-manifest、web-lazy）未提交，交管理層重建；訓練器頁的實際畫面沒在瀏覽器看過（未驗證）。
- 第 7 項（內建離線訓練器與行為分析）：skill 自給自足——scripts/vendor/ 內附 recipe_core、experience_core、trainer_core（從 floating-assistant.js 依函式名切出）、behavior_engine＋behavior_data；命令 trainer、behavior；portable.test.js 驗證 vendor 與來源一致、搬到 repo 外仍能跑（commit 54a88f9c）。語法樹第一次要連網下載。
- 未驗證：套件在 Claude Code 載入後由 Haiku 實際照迴圈操作的品質（第 4 項才會量）。
