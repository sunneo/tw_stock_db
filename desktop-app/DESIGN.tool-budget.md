# 工具預算：工具再多，模型的上下文也不會被塞滿

目標：內建工具由我們這邊增加、使用者還能加很多技能。工具數量長大時，小 context 模型（gpt-oss:120b 這一級）仍要能
正常運作、不被污染、選得到正確的工具。Redmine 外掛有同一套的 Ruby 版（`redmine_ai_chat/DESIGN.tool-scale.md`），兩邊要同步。

## 原則（不可打破）
所有工具一律「**一行短說明 ＋ 精簡參數**」。完整說明與完整參數只從 `get_tool_details` 取得，或者在模型沒查就呼叫、
而且**第一次失敗**時，自動附在失敗結果的 `usage` 裡（每個工具每次執行只附一次）。

## 做了什麼
| 層 | 做法 | 位置 |
|---|---|---|
| 清單 | 短說明（第一句，去括號，≤90 字，可用 `short` 覆寫）＋ `compactToBudget`（欄位名、型別、必填、列舉永遠保留；說明逐級縮短→巢狀不留說明→全部不留、巢狀物件只列欄位名） | `renderer/src/tools/tool_budget_core.js`、`_buildNativeToolsSchema` |
| 失敗 | 第一次失敗附完整 `usage` | `_callToolGuarded` |
| 領域太大（有階段可切） | 依「階段群組」切成**協調者＋階段子領域**（探索→讀懂→查資料→實驗→設計→實作→驗證→CI→記錄）；協調者只拿自己的工具＋ `delegate_subtask`，階段子 agent 只拿自己那一組，交接用「交接單」；內部的 `ph_*` 領域不出現在公開清單、路由目錄、巢狀委派目錄 | `planSplit`、`_ensureDomainSplits`、`_runSubAgentTask` |
| 領域太大（切不開：技能、host／使用者自己註冊的） | **聚焦**：只給與任務最相關的前 16 個，其餘留在 reserve；模型用 `request_additional_tools` 申請時，**先在本地依需求文字從 reserve 補**；補不到、或補了又來申請（＝剛才挑的不對）就改走原本的領域路由（LLM）。任務與工具沒有共同詞時不聚焦（給全部） | `_focusTools`、`_focusPick`、`_runSubAgentTask` |
| 路由 | 路由前先檢索（詞彙索引＋名稱命中加倍），路由器只看相關領域；沒有重疊時退回完整目錄 | `_shortlistDomains` |
| 量測 | `fa._toolBudgetReport()`：每個工具的 token、每個領域的工具數／token、超標項目與修法建議 | `scripts/eval/tool-budget.eval.js` |

開關（進階設定）：`domainSplit`（切割）、`toolFocus`（聚焦）、路由先檢索的 `routeShortlist`。關掉就回到舊行為。

## 精準度：檢索只縮小候選，語意理解永遠在 LLM
本地檢索是**字詞比對**（中文雙字詞、英文單字、名稱命中加倍），不懂語意。所以：
- 寧可多留、不要漏：聚焦留 16 個；檢索沒有依據（沒有共同詞）就不聚焦；
- 檢索挑不到、或挑錯了，都有 LLM 兜底（申請第二次改走 LLM 路由）；
- 模型自己永遠看得到「還有申請入口」，不會卡死，最壞情況是多繞一次。

### 決定：語意排序（尚未實作）
使用者要求：不保證一定有 embedding 服務，要有能在 WASM 跑的離線小模型，**30 秒內答不出來就丟給 LLM**。
設計成逐級降級，每一級都有期限：
1. 使用者設定的 embedding 模型（`_computeRealEmbedding`，已有，RAG 用）；
2. 離線 WASM embedding 模型（transformers.js feature-extraction；候選：多語 e5-small／bge-small 一類，q8 約 100～120MB，
   第一次要下載，之後快取；工具向量算一次、依「模型＋工具名稱＋說明」快取）；
3. 字詞檢索（現在的做法，永遠可用）；
4. 任何一級在期限（預設 30 秒，含模型載入）內沒答出來、或失敗 → 不用檢索的結果，**交給 LLM**（領域路由／不聚焦）。
未驗證：模型選擇、載入與推論實際耗時（尤其 CPU 無 WebGPU 時）、中文工具說明的召回率。**要先量，再決定要不要接。**

## 測試
- `renderer/src/tools/tool_budget_core.test.js`（9 個：短說明、精簡、收緊、檢索、切割與聯集一致、預算報告）
- `scripts/eval/tool-budget.eval.js`（真實 Electron、假 LLM：切割、協調者交辦、交接單、內部領域隱藏、路由提示大小、第一次失敗附說明）
- `scripts/eval/tool-focus.eval.js`（30 個工具的大領域：聚焦成 15 個、本地補工具不打路由模型、沒有共同詞不聚焦、小領域與關閉開關不受影響）

## 量到的數字（197 個工具、43 個公開領域）
- 全部工具攤平的 schema：85k → 約 32.6k tokens；根層（router／full）4.2k → 0.65k；coding 領域 22.9k → 9.6k
- 單一工具上限 700 token：`images_to_pdf` 1101（原始）→ 608、`repo_map` 838 → 572，沒有工具再超標
- 路由目錄（含 4 個領域的任務）約 2.4k tokens，先前是 22k
- 仍超標：技能領域 39 個工具（切不開，靠執行時聚焦處理，報告仍會列出）

## 還沒做／沒驗證
- 沒有用真實模型端到端跑過切割與聚焦（只用假 LLM）；使用者提議在 Redmine 的 ai_chat 驗證，那邊是另一個程式碼庫
- 聚焦對「真實技能」的召回率只用合成工具測過
- 離線語意排序（見上）
- 領域靜態報告不知道「執行時會聚焦」，所以技能領域仍列為超標
