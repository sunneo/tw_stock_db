# 離線訓練器（Offline Trainer）與 `/offline-trainer-by-ai` 設計文件

> 原始碼：`renderer/src/floating-assistant.js`（常數 `FA_OT_*`、`FA_SEM_GROUPS`；函式 `_otPlan`、`_otExecute`、`_otExecFsm`、`_faOtFsmRun`、`_faOtDistill`、`_faOtWorkerSource`、`FaOtWorkerHost`、`_otTrainRun`／`_otAdopt`／`_otTrainTurn`、`_otBundle*`、`_otTeacher*`、`_otRegisterPane`）。
> 相關：JS 工具的隔離執行見 `DESIGN.sandbox-worker.md`。

## 1. 目標

AI 模型全部連不上（或使用者開啟離線模式）時，助理仍能**精準地做事**，而不是只回罐頭文字。作法不是存「問答」，而是學**怎麼做**：
意圖 → 工具呼叫（函式＋參數樣板）→ 步驟／狀態機 → 必要時 JS 工具腳本。這些由線上 AI 示範、AI 老師教、背景 worker 整理，離線時由本機執行。

核心原則：
1. **只學 function call，不存回答或查詢結果**（例如「10/3 查詢新聞」學到的是 `news_search(date=?)` 的樣板；10/5 再問會重新查，不會拿舊結果回答）。舊的問答記憶已清掉。
2. **先讓離線訓練器試，做不到才交給 AI**；AI 成功後，離線訓練器**必須被擴充**（不能只是讓 AI 做完就算）。
3. **自動切到離線模式的條件：所有 AI 模型都沒辦法回應**，不是單一模型失敗。
4. 會改動東西的工具（`FA_OT_RISKY_TOOL`：write／delete／commit／push／exec／send／upload…）離線執行前一律向使用者確認。

## 2. 知識的形狀

| 種類 | 說明 |
|---|---|
| 規則 rule | 精確 pattern（regex／關鍵字）→ 動作，信心 0.98，優先於語意 |
| 語意 pattern | 範例語句＋意圖＋工具＋參數樣板；以雜湊嵌入（hashed-embedding）算相似度，`FA_SEM_GROUPS` 提供同義詞群組，`FA_OT_VERBS` 提供動詞同義 |
| 工具 tool | 單一工具呼叫，參數由 `_otGuessArgs` 從句子抽取 |
| 步驟 steps | 依序多個工具呼叫，後一步可引用前一步結果 |
| 狀態機 FSM | 狀態、`on_success`／`on_failure` 轉移，終止狀態 `report_success／report_unresolved／split_and_escalate`（`FA_OT_TERMINAL`）；`_faOtFsmRun` 以步數上限防迴圈 |
| JS 工具 | AI 寫的 JavaScript，在沙盒 worker 執行（無 fetch／XHR／WebSocket／indexedDB，以 `ctx.call` 橋接已登記的工具），有版本歷史與 `rollback_tool` |
| 同義詞、解法 | 使用者詞彙與已解決的案例 |

候選選擇：同時有「功能卡（answer-only）」與可執行候選時，**優先可執行的**（分數差 0.1 內）。

## 3. 規劃與執行

`_otPlan(text)` → 找規則 → 語意比對 → 產出 `{kind: steps|fsm|tool|slash|qa|answer, …}`；`_otExecute(plan)` 依種類執行：
- 工具：檢查工具存在、風險確認、套參數、執行、整理成使用者看得懂的結果（網頁文字用 `_otPageDigest` 去雜訊，避免湊出與內文無關的段落）。
- FSM：`_otExecFsm`，每個狀態跑一個動作；失敗走 `on_failure`。
- 瀏覽器控制、截圖：離線時也精準執行，截圖要把圖附在回覆裡（擴充功能版本檢查以實際能力為準）。
- 做不到 → 記進 **未解決紀錄（unresolved log）**，供之後訓練。

## 4. 學習來源

1. **線上 AI 示範（自動訓練）**——設定「自動訓練」下拉選單：
   - 否（預設）：不記錄。
   - 是，自動：線上 AI 成功的對話自動記錄，背景 worker 整理成技能。
   - 是，手動：每輪結束出現「動作完成了（加入離線訓練）」引導按鈕（action chip），按下才加入。
   只有勾選時才產生非同步訓練工作；`_otTrainTurn` 只取成功的工具呼叫（排除 `FA_OT_META_TOOLS`），`_otTrainRun`／`_otAdopt` 收錄。
2. **RAG／對話訓練**：同樣只保留 function call（工具＋參數樣板）。
3. **背景蒸餾 worker**（`_faOtDistill`、`FaOtWorkerHost`）：把多輪對話聚類，同一工具序列出現至少 N 次（預設 3）才升格為 pattern／FSM／格式化器（`_faOtGenFormatter`）；在 Web Worker 非同步執行，不卡畫面。
4. **AI 老師**：`/offline-trainer-by-ai`（下節）。

## 5. `/offline-trainer-by-ai`：AI 教離線訓練器

通用工具，不限特定領域。用法：`/offline-trainer-by-ai <目標>` ＋（可選）項目清單。

- 項目清單：預設**每行一項**，也可用 regex 或 JSON 陣列（`_faOtParseItems`）；沒給清單就是單一任務。
- 迴圈 `_otTeacherLoop`（長時間、**可停止／接續**）：對每個項目
  1. 先讓離線訓練器試（`_otPlan／_otExecute`）；
  2. 做不到才交給 AI 老師（協議 `FA_OT_TEACHER_PROTOCOL`）解決；
  3. AI 成功後，**必須**用離線訓練器的擴充動作（新增規則／pattern／FSM／JS 工具）把解法教給它，再驗證離線訓練器自己能重做；
  4. 統計「離線自己解決的比例」，隨著訓練上升。
- 子指令：`status`、`stop`、`resume`、`report`。工作階段存在 IndexedDB，關閉重開可接續。
- 老師規範與說明不含任何領域專屬寫法（先前的 CVE 專用描述已移除）。

## 6. 匯出／匯入 bundle

`_otBundleExport`：規則、狀態機、JS 工具原始碼、解法、同義詞包成單一 JSON，附 checksum。
`_otBundleInspect`／`_otBundleImport`：檢查格式、語法（JS 工具用 `node --check` 等價的解析）、checksum，顯示摘要請使用者確認後才合併；已有同名工具則保留版本歷史，可 `rollback_tool`。
`run_tool` 可先試跑單一工具。

## 7. 設定與介面

設定頁 `_otRegisterPane`：自動訓練下拉、離線模式、已學內容清單（規則／pattern／工具／FSM）、未解決紀錄、匯出匯入、訓練進度。`/offline` 可切換離線模式並顯示狀態。

## 8. 安全與限制

- JS 工具只能經 `ctx.call` 呼叫已登記工具，且受風險確認約束。
- 離線訓練器不聯網補資料；需要即時資料的意圖只學「怎麼查」，查詢仍需網路。
- 學習必須有重複證據（預設 3 次）才自動升格，避免一次性操作變成規則。
- 測試注意：測試要停用或覆寫 `requestUserForm`；老師迴圈測試用 `unattended` 避免風險確認卡住。
