# Agent Model Configure：不同子Agent模式的不同階段，偏好不同的模型

位置：Configure → AI →「子Agent」分頁，「多重子Agent模式」下面。核心 `renderer/src/tools/agent_model_core.js`（FaAgentModel，純函式，node 可測），畫面與動作在 `floating-assistant.js` 的 `_agentModelRender`／`_agentModelOnClick` 一帶。

## 階段圖
每個模式有自己的階段（一種階段＝一種模型呼叫），畫成由左到右的圖，點節點設定偏好：

| 模式 | 階段 |
|---|---|
| 不使用子Agent | Orchestrator |
| 1 兩層委派 router | Orchestrator → 路由（認識全部功能）→ 領域子Agent → Reducer |
| 2 認識全部領域 full | Orchestrator → 領域子Agent → Reducer |
| 4 兩層領域路由 hierarchical | Orchestrator → 類別路由 → 路由 → 領域子Agent → Reducer |
| 5 意圖過濾 intent | Orchestrator →（路由當備援，虛線）→ 領域子Agent → Reducer |

每個階段有「在意的特性」（程式自動決定時用）：Orchestrator 要快；路由要快、context 大；領域子Agent 工具呼叫要穩；Reducer 要謹慎、能吃長內容。不同模式的權重不同（例如不使用子Agent 時 Orchestrator 要自己做完，工具與謹慎比速度重要；意圖過濾的 Orchestrator 更重速度）。

## 設定與開關（開關不動已存的設定）
`advancedSettings.agentModels = { enabled:false, useBuiltin:true, modes:{ <模式>:{ enabled, stages:{ <階段>:{ prefs:[模型列 id…] } } } } }`
- **總開關預設關閉**：關著時完全照模型列原本的順序（跟以前一樣）。開關只決定「套不套用」，自訂的偏好、各模式的設定都原樣保留；關了再開，設定不變（有測試）。
- **每個模式也有自己的「套用」開關**。
- **解析順序**：總開關關 → 不套用；模式被關 → 不套用；這個階段有自訂偏好（只算還存在的模型列）→ 用自訂；否則用**內建預設**（有對得上的才用）；都沒有 → 不套用。
- **內建預設**是寫在程式裡的一份（依「模型名稱的樣式」挑，不寫死模型列）：Orchestrator／類別路由挑 lightning、flash、mini、8b、20b 這類快的；路由挑 super、120b…（context 大又不慢）；領域子Agent 挑 super、120b、ultra、qwen3、deepseek…；Reducer 挑 ultra、opus、550b、405b、thinking、pro…。有「沒有自訂的階段使用內建預設」勾選，預設勾；「複製內建預設來改」把它變成自己的設定。
- **全部重置成預設值**：清掉所有模式、所有階段的自訂與各模式開關，改回內建預設；總開關是使用者的選擇，不動。

## 偏好只是優先順序，不會讓呼叫卡死
`_computeModelRowGroups(stage)` 把偏好的模型所在的備援分組排到最前面，其餘照原本順序補在後面；所以挑到壞掉、404 的模型，仍然照原本的備援機制往下換，不會丟掉任何模型。接點：
- `orchestrator`：根對話的第一次選擇（`_getInitialFallbackConfig`）。
- `domain_agent`：領域子Agent 迴圈（`_runSubAgentTask`）。
- `router`／`category_router`：路由呼叫（`_callRouterLLM`，兩層路由第一步用類別路由）。
- `reducer`：根對話呼叫了委派工具、子Agent 結果回來之後的下一輪，改用 Reducer 偏好的模型（`_agentReducerNext`；沒委派就不換）。

## 自動決定（三種）
1. **🪄 用現有資料**（不呼叫模型）：每個模型用四種特性打分（0～1）——優先用實測（模型卡的速度、單一工具、多步驟、總分；CoLU 體檢的結論），沒有才用名稱與設定估（參數量、lightning／flash 這類字、上下文長度設定、不支援工具呼叫就壓低），每個數字都說明來源；依各階段的權重挑前三名（同一個模型只算一次、不支援工具的不用在工具階段、嵌入模型不用）。只填還沒自訂的階段。
2. **🧪 補跑基準測試再決定**：只對還沒有速度與工具資料的模型，各跑兩項（簡易回應、單一工具呼叫；先問使用者確認，可能計費，可以停止），結果存進模型卡，再用上面的方式決定；已有資料的不重跑。
3. **🤖 讓 AI 決定**：把所有模型的資料與各階段的需求交給目前的模型，只收封閉的 JSON（用字母代號指模型），`parseAi` 檢查（不存在的代號丟掉、每階段最多 3 個）後才採用；回不出可用的就退回 1。離線模式不能用。

## 測試
- `renderer/src/tools/agent_model_core.test.js`（35 項）：階段圖、特性估計（實測優先、估計、0～1）、自動決定、內建預設、**開關不動設定**、解析順序、模式開關、重置、正規化、備援順序、AI 回覆檢查。
- `scripts/eval/agent-model.eval.js`（真實 Electron）：畫面、點節點、加入／排序／移除偏好、執行時真的照偏好選模型（子Agent、路由、類別路由、Reducer）、備援順序不丟模型、關閉／再開設定不變、模式關閉、三種自動決定、重置。

---

# 遠端群組面板換主題
房間代號旁的「複製」按鈕、機器清單、設定的輸入框，原本是用「建立當下」的主題顏色寫死的；「交給」下拉只在成員變動時才上色，面板收著時 `_rgRender` 也不會重建，所以換主題之後會停在舊顏色（重新安裝也一樣，因為不是版本問題）。現在 `_applyThemeStyles` 會呼叫 `_rgThemeRefresh`：顏色組合變了就重建目前的畫面（表單填到一半的欄位會保留）並重上色「交給」下拉；面板與下拉都帶 `color-scheme`，原生的下拉選單、輸入框、捲軸也跟著主題。
