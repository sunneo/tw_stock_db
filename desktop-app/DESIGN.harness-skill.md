# 弱模型 harness 做成 skill（零件地圖、缺口、進度）

> 結論：有機會，零件已經九成齊。缺的是兩樣：①一個「不依賴 Electron、可跨呼叫續跑」的封閉題迴圈（命令列），②一個「程式核對才收」的經驗閘門。這份文件是一頁地圖；交接與使用者原話在 `DESIGN.TODO.harness-skill.md`。

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
- 第 2～7 項：見提交紀錄；未做的項目會在下面逐項補上「做到哪、哪些未驗證」。
