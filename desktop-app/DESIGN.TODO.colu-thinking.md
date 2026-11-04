# CoLU+Thinking 設計草案（TODO，唯讀調查結果，尚未實作）

來源需求（使用者 2026-11-04）：「安排一個是離線的 qwen，要 CoLU+thinking，因為 qwen 也確實可以 thinking，也可以讓他反思，中間的計畫要多點 think。請把這個稱為 CoLU+Thinking。」

本文件只是草案，不是結論。所有「事實」都附行號；標明「推測」「沒查」的地方沒有讀程式確認。

---

## 步驟 1：現有離線 Qwen 盤點

檔案：`renderer/src/vlm/vlm_core.js` 的模型表（`MODELS`，約第 24–52 行）。

| 模型 id | 行號 | 大小（GPU / CPU，位元組常數） | 裝置 | 執行函式庫 | thinking | 用途 |
|---|---|---|---|---|---|---|
| `qwen3-0.6b`（預設文字模型） | 30–32 | 543 MB / 589 MB | GPU 用 q4f16，CPU 用 q8；`gpuNeedsF16` | transformers.js（見下） | 有思考模式，但這裡關掉（註解第 32 行寫「太慢」） | chat、rag、tools（hermes） |
| `qwen2.5-0.5b` | 33–35 | 461 MB / 488 MB | 同上 | 同上 | 無（沒有 thinking 設定） | chat、rag、tools；`verified: false` |
| `qwen2.5-1.5b` | 45–47 | 1165 MB / 1506 MB | 同上，CPU 很慢 | 同上 | 無 | chat、rag、tools |
| `qwen3-1.7b` | 48–50 | 1360 MB / 1662 MB | 要 GPU 才實用 | 同上 | 有（同 Qwen3） | chat、rag、tools |
| `llava-interleave-qwen-0.5b`（圖像轉文字，實驗） | 24–27 | 780 MB / 695 MB | GPU 或 CPU（實測 CPU 約 140～150 秒） | transformers.js（llava 架構） | 不適用 | 圖像描述 |

- 預設文字模型常數：`DEFAULT_TEXT_MODEL = 'qwen3-0.6b'`，`vlm_core.js:75`。
- 函式庫：worker 內用 `L.TextStreamer`、`L.InterruptableStoppingCriteria`、`cur.tokenizer.apply_chat_template`、`cur.model.generate`，可判定為 **transformers.js**（`floating-assistant.js:50829–50842`）。沒有 WebLLM 的使用（grep 沒找到，推測）。
- 裝置決定：`resolveDevice` 在 `vlm_core.js:79–92`，回傳依序嘗試的 `order`：`['webgpu','wasm']`（偏好 GPU 且有 WebGPU）、`['webgpu']`（只能 GPU）、`['wasm']`（CPU）。GPU 失敗會降級到 CPU（`vlm_core.js:92` 理由文字）。
- 每個模型的 `contextTokens` 是實際給的上下文長度：qwen3-0.6b 4096（`vlm_core.js:31`）、qwen2.5-1.5b 與 qwen3-1.7b 8192（`:46`、`:49`）。

使用處（文字生成）：
- 離線文字 chat 入口：`floating-assistant.js:100376–100395` `_llmGenerate(model, a, cb)`。逾時：WebGPU 90 秒、其他 300 秒（`:100386`）。預設 `maxTokens` 512（`:100388`）。`deterministic: true` 時用貪婪解碼（`:100383`）。
- 工具呼叫的離線 agent 迴圈：`vlm_core.js:349` `runAgentLoop`；`vlm_core.js:365–368` 有「垃圾輸出」偵測後用保守參數重試一次（`strict: true`，`maxTokens: min(reply, 256)`）。
- 離線自動退路：`offlineAutoFallback` 預設 true（`floating-assistant.js:57717`、`:59148`），勾選框在 `:69302`，所有模型失效時才退回離線訓練器。
- 進階設定的離線文字模型：`this.advancedSettings.offlineTextModel || 'qwen3-0.6b'`（`floating-assistant.js:98068`）。
- 離線訓練器與 `offlineAutoFallback`：`floating-assistant.js:103391`、`:103431`。
- 「離線訓練器」在 `floating-assistant.js` 內是另一組程式（沒有逐一查完）。

注意：`floating-assistant.js` 內嵌了一份 `vlm_core` 的副本（例如 `textGenParams` 在 `:7489`，`parseToolCalls` 的 `<think>` 處理在 `:7511`）。依記憶檔 `feedback_embedded_source_modules`，改動要改來源模組再重新嵌入。

---

## 步驟 2：現有 CoLU 實作盤點

CoLU（封閉題外殼）的核心是 `recipe/recipe_core.js` 的 `jsonStep`：

- `recipe_core.js:86–92`：`jsonStep(ctx)`，`ctx = { generate, messages, validate, maxTries=2, maxTokens=160, prefill }`。每次呼叫 `ctx.generate({messages, maxTokens, prefill})`，失敗就用 `validate` 的錯誤訊息再問一次（最多 `maxTries` 次）。`prefill` 把回覆開頭先寫好（例如 `{"choice":`），讓小模型不會改成散文。
- 「選項題」（字母選擇題）：`{"choice": "字母"}`，`maxTokens: 40`，`prefill: '{"choice":'`。出現在：
  - `catalog/route_core.js:48`（`classifyWithModel`，四種做法的分類：model／program／design／external_action）。
  - `floating-assistant.js:8646`（`ask` 的 menu 版本）、`:14633`（UML 修正選單）、`:14707`（分類選單）、`:15924`（資料查詢選項）。
  - `uml/uml_edit_core.js:227`（UML 編輯的選單）。
- 「固定欄位」（欄位 JSON）：`recipe_core.js:132` 的 fill 形式，`prefill: '{"<欄位名>":'`；`floating-assistant.js:8602` 同樣寫法（`maxTries: 2`，`maxTokens` 用預設 160）。
- 「填成員／順序」的 UML 步驟：`floating-assistant.js:10688`（members，`maxTokens: 400`）、`:10706`（sequence，`maxTokens: 300`），`prefill` 來自 `uml/uml_core.js:434`（`PREFILL` 表）。
- 核對函式（程式）：每個 `validate(o) → [錯誤]`，例如 `route_core.js:48`、`floating-assistant.js:8646`。
- 預設退路：`pick(o) < 0` 時 `jsonStep` 失敗，呼叫端改用程式結果（`recipe_core.js` 的 `ok:false` 回傳，`:92`）。
- 經驗閘門：`catalog/colu_bench_core.js:13`（`DEFAULTS`：`high: 0.8`、`unstable: 0.25`、`minCalls: 3`、`minEdge: 0.9`、`requireOptions: true`），`makeTasks` 在 `:29`，`grade` 由 `colu_bench_core.js` 其他位置（沒查完整）。`colu_bench_core.js:12` 與 `floating-assistant.js:77527` 的 `_coluBenchCall`（`maxTokens: 4096`，走 `this._coluBenchCall(cfg, …)`，看起來是**線上**呼叫，沒查確認）。
- 達成路線（FaRoute）：`floating-assistant.js:14657` 起的 `const FaRoute = (function () {…})`，註解說明設計在 `DESIGN.unit-catalog.md` 第三十七節。
- 反思（程式依序看）：`floating-assistant.js:56158` 的註解：① 先找現有工具 → ② 達成路線（UML design → 程式 → 模型）。反思②的實作在 `:56178–56186`。這一段**主要是程式流程，不是 thinking**。
- 反思的字詞核對：`catalog/reflect_core.js:12` 的 `CONFUSABLE` 表（像／象、截／擷 等形近字），`reflect_core.js:7` 是模組匯出。這是**字詞層的反思**，不用模型。

目前 CoLU 的呼叫方式：全部都經 `generate` 函式注入。離線時 `generate` = `_llmGenerate`（`floating-assistant.js:100445` 的 `gen(model)`，選工具用 `deterministic: true`），線上時是 `_coluBenchCall` 等（沒查確認每個 `generate` 的注入點）。

---

## 步驟 3：離線模型的 thinking 輸出處理

事實（讀程式確認）：
- **離線 worker 關掉 thinking**：`floating-assistant.js:50832` 與 `:50834`，`apply_chat_template(..., enable_thinking: false)`。所以目前不會產生 `<think>`。
- 生成參數：`textGenParams`（`vlm_core.js:248`；副本 `floating-assistant.js:7489`）：採樣 `do_sample: true, temperature: 0.4, top_p: 0.9, repetition_penalty: 1.08`；`deterministic` 時 `do_sample: false` 並刪掉 temperature 與 top_p（貪婪）。
- 最大 token：worker 端 `max_new_tokens: m.maxTokens || 512`（`floating-assistant.js:50839`）。`jsonStep` 預設 160，選項題 40。
- 停止條件：`InterruptableStoppingCriteria`（`:50835`），可由 `interrupt` 中斷；逾時在 `_llmGenerate` 的 `setTimeout`（`:100386`）。
- 垃圾偵測：`vlm_core.js:311` `looksLikeGarbage`，在 `floating-assistant.js:100390` 每 64 字檢查，命中就 interrupt。`vlm_core.js:365–368` 再做一次保守重試。

`<think>` 的剝除位置（多處，沒有統一函式）：
- `vlm_core.js:270`（`parseToolCalls` 回傳的 `text`，`/<think>[\s\S]*?<\/think>/g`）。
- `floating-assistant.js:7511`（同上副本）。
- `floating-assistant.js:8550`、`:14057`、`:14063`、`:27205`、`:27275`、`:33035`、`:42692`、`:45054`（各自正規表達式，沒有共用函式）。
- `floating-assistant.js:34015` 與 `:34180` 的 `stripThink`（比較完整：處理未閉合的 `<think>`、`<thinking>`，並去掉 ``` 圍欄）。
- 結論：**沒有一個統一的「先去思考區塊再解析」的入口**；`jsonStep` 本身（`recipe_core.js:89–92`）也沒有去除 `<think>`。如果開 thinking，`jsonStep` 的 `validate`／`JSON.parse` 會遇到前綴文字，要靠各呼叫端自己去除。

風險（推測，沒實測）：
- 如果 `prefill: '{"choice":'` 之前的模型輸出含 `<think>`，prefill 本身會被接在提示詞後面，**思考區塊會出現在 prefill 之前**，不會出現在答案裡；但 `jsonStep` 的 `generate` 回傳文字要包含 prefill（`recipe_core.js:88` 註解），所以要確認 `raw` 的組合順序。
- Qwen3 的聊天範本在 `enable_thinking: false` 時通常會塞一個空的 `<think></think>`（推測，沒查範本檔）。

---

## 步驟 4：「計畫」階段盤點

- 「UML design 由上而下規劃」：`uml/uml_core.js` 的 `PREFILL`（`:434`）與 `uml_core.js:455–456`（`fromHints` 的程式生成），`floating-assistant.js:10688–10706` 的 members／sequence 步驟，`maxTokens` 分別 400 與 300，`maxTries: 2`。
- 「達成路線」的計畫文字：`floating-assistant.js:56178`（UML design 路線的字串）。
- 深度規劃（多步驟）：`harness/harness_host.js` 的 `decompose`（`:16` 呼叫 `FH.decompose`，`:17` 呼叫 `FH.toUml`），`:23` 的 `FH.callsOf`。**沒查**：`FH.decompose` 內部是否呼叫模型。
- 路由（四種做法）：`catalog/route_core.js:27` 的 `score`（規則打分）、`:33` 的 `classify`；只有在 `ambiguous`（前兩名差距小於 1，`:39`）時才呼叫模型做 `classifyWithModel`（`:42–48`），且 `maxTokens: 40`。**計畫本身目前完全沒有 thinking 預算**。
- 計畫的 token 預算：只有上面 `400`（members）與 `300`（sequence）；沒有「計畫專用的大預算」。
- 離線計畫的生成參數：同 `_llmGenerate`，選工具用貪婪（`floating-assistant.js:100445`）。

結論：目前專案**沒有**一個「先想再畫」的長計畫階段給離線小模型；計畫多半由程式規則與小型選單完成，模型只回一個字母或一小段 JSON。

---

## 步驟 5：CoLU+Thinking 設計草案（草案，不是結論）

### (a) 各階段要不要開 thinking、預算多少
| 階段 | 型態 | 建議 thinking | 建議預算（token，草案） | 理由 |
|---|---|---|---|---|
| 路由（做法 A/B/C/D） | 字母選單 | 關 | 0（沿用 `maxTokens: 40`） | 規則已能分；模型只在「模糊」時才問 |
| 填欄位 | 固定欄位 JSON | 關 | 沿用 160 | 欄位答案短，開 thinking 容易超時 |
| 計畫（UML 由上而下、多步驟路線） | 結構化 JSON | **開** | 最大，例如 1500～3000（草案，需實測） | 使用者要求「計畫多想」 |
| 反思（答案核對失敗、計畫後檢查） | 字母選單＋一句理由 | **開，但限短** | 300～600 | 反思是封閉題，預算要小 |
| 核對失敗後的修正 | 固定欄位 JSON | 關（先試），失敗再開 | 沿用 160 | 修正要快 |

注意：以上數字都是**推測**，尚未用真模型量測。`contextTokens` 只有 4096～8192，計畫階段的 thinking 會吃掉上下文，預算要跟 `contextTokens` 按比例縮放（依記憶檔 `feedback_self_adaptive_chunk_sizing`，不要寫死常數）。

### (b) 答案解析
1. 先用一個統一函式去掉 `<think>…</think>`（含未閉合的，沿用 `floating-assistant.js:34015` 的寫法），再交給 `jsonStep` 的 `validate`。建議新增在 `recipe_core.js`（`jsonStep` 之前），而不是每個呼叫端各改一次（目前有 10 幾處各自正規表達式，見步驟 3）。
2. 思考內容另存成「推理紀錄」（字串，可在介面展開看），不進答案、不進 `messages` 歷史（避免上下文被吃光）。
3. 思考不收斂或超過預算時的退路，依序：
   1) 截斷思考區塊，只看 `prefill` 之後的答案；
   2) 若答案仍不合法：改用 `enable_thinking: false` 再問一次（同一題）；
   3) 再不行：程式預設答案（沿用 `route_core.js` 與 `recipe_core.js` 的 `ok:false` 路徑）。

### (c) 反思
- 反思題也是封閉題：`"這個計畫有沒有缺口？A 沒有 B 有：缺口是…"`，`maxTokens` 300～600，`maxTries: 2`。
- 觸發條件：(1) 某階段答案被核對失敗；(2) 計畫產生後。
- 上限：每題反思最多 1 次；整個計畫最多 2 次（草案）。超過就走 (b) 的退路。
- 與現有反思的關係：`floating-assistant.js:56158–56186` 的「反思①②」是**程式流程**（找工具、達成路線），`catalog/reflect_core.js` 是**字詞**反思。CoLU+Thinking 的反思是**第三種**（模型 thinking 反思），要明確區分命名，避免混淆。

### (d) 離線速度與裝置
- Qwen 在 WebGPU 或 CPU 上開 thinking 會慢很多（`vlm_core.js:32` 註解已寫「太慢」）；逾時目前是 WebGPU 90 秒、其他 300 秒（`floating-assistant.js:100386`）。CoLU+Thinking 的計畫階段要有**獨立逾時**，建議更短或依 token 數估算（沒量測）。
- 開關：預設**關閉**（使用者慣例：新功能預設保守）；開啟時顯示預估時間。
- 裝置偏好：沿用 `resolveDevice`（`vlm_core.js:79–92`）與 `_omDevicePrefOf`（`floating-assistant.js:100378`），不另立一套。
- 模型建議：`qwen3-0.6b` 與 `qwen3-1.7b` 有思考模式（`vlm_core.js:32`、`:49`）；`qwen2.5-*` 沒有，不列入 CoLU+Thinking 的候選（推測：Qwen2.5 無 thinking 模式，依官方資料，**沒查**）。

### (e) 設定位置
- 放在 **Configure** 的 LLM 基礎設定（記憶檔 `feedback_domain_configure_button` 與 `project_topic_shift_setting_pending` 有相關慣例），新增一個「CoLU+Thinking」區塊。
- 離線文字模型選單沿用 `advancedSettings.offlineTextModel`（`floating-assistant.js:98068`），只列有 thinking 的模型。
- 預設值：開關關、計畫預算中等、反思上限 1。
- 記憶檔 `feedback_ai_settings_ui_duplicate`：`index.html` 與 `floating-assistant.js` 內部的 AI 設定有兩份 UI，**兩邊都要改**（沒查兩邊的實際行號）。

### (f) 如何評量
1. 假模型測流程：用固定回覆的假 `generate`，驗證 `<think>` 剝除、退路、反思上限（只需 node 測試，類似 `vlm_core.test.js`）。
2. 真離線模型量測（**需要先問使用者**，寫明檔名、來源、大小）：
   - 檔案：`qwen3-0.6b` 的 ONNX 權重，來源 HuggingFace `onnx-community/Qwen3-0.6B-ONNX`，GPU 約 543 MB、CPU 約 589 MB（`vlm_core.js:31`）。
   - 指標：封閉題正確率、有無 thinking 的差別、每題耗時。
3. 評量題型可沿用 `colu_bench_core.js` 的 `makeTasks`／`grade`（`:29`）。

### (g) 實作分階段建議（每階段一個 Haiku 工作階段、一次一個寫檔者）
1. 純函式：`<think>` 剝除＋推理紀錄（`recipe_core.js`），附 node 測試。
2. `jsonStep` 接上 thinking 參數與預算（只改 `recipe_core.js` 與 `_llmGenerate` 的參數傳遞）。
3. 計畫階段：UML 由上而下（`uml_core.js:434`、`floating-assistant.js:10688`）開 thinking，獨立逾時。
4. 反思階段：核對失敗後的一次反思（`floating-assistant.js:56158` 附近）。
5. 設定 UI（兩份：`index.html` 與 `floating-assistant.js`）。
6. 真模型評量（先問使用者）。

風險：`floating-assistant.js` 十萬行，改動要用 `Edit` 小段改，並改來源模組再嵌入（記憶檔 `feedback_embedded_source_modules`）；`.min.js` 與 `web-lazy` 也要同步（`git status` 顯示這些檔案已有未提交變動，**不可以碰**，本次不改）。

---

## 要先問使用者的決定（不要自己決定）

1. 是否要真的下載 `qwen3-0.6b` 或 `qwen3-1.7b` 來量測？（需要先問：檔名、來源、大小見 (f)）
2. 「計畫」階段的 thinking 預算上限要多大？（草案 1500～3000，沒量測）
3. 計畫階段在 WebGPU 上可接受的最長等待時間？
4. CoLU+Thinking 要不要對 `qwen2.5-*` 也開放（它們沒有 thinking 模式，預設不列）？
5. 推理紀錄要不要存進對話歷史（會吃上下文）？
6. 開關的預設值確定是「關」嗎（草案建議關）？

### 使用者決定（2026-11-04，已定案，覆蓋上面草案）
1. 同意下載 `qwen3-0.6b` 來量測（階段 6 才下載，下載前仍要列檔名、來源、大小再確認一次）。
2. 計畫階段思考預算上限 1500～3000 token（仍依 `contextTokens` 按比例縮放）。
3. 計畫階段在 WebGPU 上最多等 30 秒（離線模型，寬裕即可）；逾時走退路。
4. **只留 `qwen3-0.6b`**：CoLU+Thinking 只對 `qwen3-0.6b` 開；其他離線模型（含 `qwen3-1.7b`、`qwen2.5-*`）不走這條，保持原行為（「補充 2」的退化設計不做）。
5. 推理紀錄**只給使用者看**，不放進 `messages` 歷史、不送回模型；每次回應各自有自己的推理（因為送出的 prompt／messages 本來就含上下文）。
6. 開關**預設打開**（只對 `qwen3-0.6b` 生效）。

---

## 補充（管理層 2026-11-04）：全部離線文字模型與無 thinking 的退化

範圍從 Qwen 擴大到專案內**所有離線文字生成模型**（`task: 'text-generation'`，`vlm_core.js:30–50`）。另外的離線模型（圖像轉文字、深度、分割、姿態、語音）不屬於文字生成，不列入 CoLU+Thinking，理由見下表。

### 補充 1：離線文字模型盤點（全部 7 個）

依 `vlm_core.js:30–50` 的 `MODELS` 表。thinking 欄是**程式現況**與**外部已知的模型能力**分開標示；外部能力沒有在本專案實測。

| 模型 id | 行號 | 參數量（概略，label 或註解） | 大小 GPU / CPU | 支援 thinking？ | 工具呼叫 | contextTokens | 目前用途 |
|---|---|---|---|---|---|---|---|
| `qwen3-0.6b`（預設） | 30–32 | 0.6B | 543 MB / 589 MB | **支援**（Qwen3 有 `enable_thinking`，程式目前設 false：`floating-assistant.js:50832`、`:50834`） | hermes | 4096 | chat、rag、tools |
| `qwen3-1.7b` | 48–50 | 1.7B | 1360 MB / 1662 MB | **支援**（同上，程式目前關） | hermes | 8192 | chat、rag、tools |
| `qwen2.5-0.5b` | 33–35 | 0.5B | 461 MB / 488 MB | **不支援**（Qwen2.5 Instruct 無 thinking 模式；外部已知，沒查範本） | hermes | 4096 | chat、rag、tools，`verified: false` |
| `qwen2.5-1.5b` | 45–47 | 1.5B | 1165 MB / 1506 MB | **不支援**（同上） | hermes | 8192 | chat、rag、tools |
| `smollm2-360m` | 36–38 | 360M | 260 MB / 348 MB | **不支援**（外部已知） | 無（`toolCalling: null`） | 2048 | chat、rag，英文為主 |
| `granite-4.0-350m` | 39–41 | 350M | 336 MB / 551 MB | **不支援**（外部已知，IBM 小模型未標 thinking；沒查） | hermes | 4096 | chat、rag、tools，`verified: false`，註解寫「適合工具階段」 |
| `granite-4.0-1b` | 42–44 | 1B | 1192 MB / 1702 MB | **不支援**（同上，沒查） | hermes | 8192 | chat、rag、tools，`verified: false` |

結論：全部 7 個中，只有 Qwen3 系列（`qwen3-0.6b`、`qwen3-1.7b`）可能支援 thinking。其餘 5 個在 CoLU+Thinking 裡一律走退化路線（補充 2）。

不列入文字模型（用途不同，`vlm_core.js:12–63`）：`florence-2-base-ft`（12）、`smolvlm-256m`（16）、`vit-gpt2`（20）、`llava-interleave-qwen-0.5b`（24，圖像轉文字，它底下的語言模型是 Qwen 0.5B，但不是文字生成入口）、`depth-anything-v2-small`（52）、`slimsam-77-uniform`（55）、`movenet-thunder`（60）、`whisper-base`（63，`managedOnly`）。

注意：`vlm_core.js:282–287` 的 `weather_zh`、`calc_zh`、`search_zh`、`chat_none` 等是意圖標籤，不是模型。

### 補充 2：沒有 thinking 能力的模型，在 CoLU+Thinking 裡怎麼退化

設計原則：**能力分三級**，程式依模型表決定走哪一級，不靠呼叫端猜。

- **Level 1：內建 thinking**（`qwen3-0.6b`、`qwen3-1.7b`）：`enable_thinking: true`，思考區塊由 (b) 的解析函式去掉，推理紀錄另存。
- **Level 2：多輪封閉題模擬 thinking**（`qwen2.5-*`、`smollm2-360m`、`granite-4.0-*`）：不開思考。計畫與反思改成**一連串封閉題**，每題仍是字母選擇或短欄位 JSON，程式把前一題答案串成下一題的提示詞。
- **Level 3：只用 CoLU 外殼**（`smollm2-360m`，英文為主、無工具呼叫）：只做單題封閉題，不做計畫與反思；計畫由程式規則產生，模型只回字母選擇。

Level 2 的具體做法（草案）：
1. **計畫拆成封閉題鏈**：程式先列出候選步驟（規則產生，例如 `route_core.js` 的做法清單），模型每次只回答「下一步選哪一個 A/B/C」（`maxTokens: 40`，`prefill: '{"choice":'`，沿用 `recipe_core.js` 的 `jsonStep`）。最多 N 步（草案 N=5），每步的答案由程式記入計畫，不讓模型自由寫長段計畫。
2. **反思用多輪封閉題代替內建 thinking**：核對失敗或計畫完成後，程式問三題（草案）：
   - 「這個計畫有沒有缺口？A 沒有 B 有」
   - 若 B：「缺口屬於哪一類？A 欄位缺 B 步驟缺 C 順序錯」
   - 「修正後要不要重排？A 要 B 不要」
   每題 `maxTokens` 40，總次數上限 3。這些題都是字母選擇，不要求模型寫理由。
3. **不讓模型寫自由理由**：封閉題不要求「先想一下再答」。若硬要模擬思考，只允許一個 `{"reason": "…", "choice": "字母"}` 欄位且 `reason` 限 40 字，超過就截斷，只取 `choice`。這一點是草案，沒有實測；小模型寫理由容易偏題，風險高，預設關。
4. **預算不靠 thinking token**：Level 2 的計畫總耗時由「封閉題數 × 每題上限」決定，不再需要 (d) 的大預算。離線速度風險反而降低（但多輪仍慢於單題，每題都要重新過一次 `_llmGenerate`，見 `floating-assistant.js:100376`）。
5. **品質退化（預期，沒實測）**：Level 2 的計畫只能到「選步驟」的粒度，拿不到長推理；Level 3 只能做單題。文件要求 UI 明示「這個模型沒有思考能力，計畫為程式輔助」。

Level 判斷的設定位置：模型表加一個欄位（例如 `thinking: 'native' | 'none'`），由 vlm_core 的 `MODELS` 決定，不在呼叫端寫死。`qwen3-*` 設 `native`，其餘設 `none`。未來要加新模型時只改模型表。

風險：
- 多輪封閉題會讓 `_llmGenerate` 被呼叫多次，每次都會經過 `_vlmEnsureLoaded` 與 worker 派送（`floating-assistant.js:100376–100395`）。要確認連續呼叫時不會重複載入（沒查 `_vlmEnsureLoaded` 的快取行為）。
- `looksLikeGarbage` 的 64 字檢查（`:100390`）對很短的封閉題可能誤判，要另設門檻（沒實測）。

### 補充 3：對 CoLU+Thinking 的影響

- 只有 Qwen3 兩個模型能走 Level 1，使用者若選 `qwen2.5-1.5b` 或 `granite-4.0-1b`，計畫與反思會走 Level 2。
- 設定 UI 要顯示目前模型的級別（Level 1／2／3），避免使用者以為離線 thinking 開了就一定有效。
- 預設模型 `qwen3-0.6b` 是 Level 1，但 contextTokens 只有 4096，多輪與 thinking 都會吃上下文，要沿用 (d) 的比例縮放（`textBudget`，`vlm_core.js` 附近）。

---

## 沒查的事項

- `index.html` 的 AI 設定 UI 實際位置（只有記憶檔提到，沒讀）。
- Qwen3 聊天範本在 `enable_thinking: false` 時實際輸出什麼（推測會塞空的 `<think></think>`，沒讀範本檔）。
- `FH.decompose`（`harness/harness_host.js:16`）內部是否呼叫模型。
- `_coluBenchCall`（`floating-assistant.js:77527`）是否一定是線上呼叫。
- `renderer/src/catalog/relu_core.js` 與 ReLU 激活函數無關（它是矩陣可達性計算，`relu_core.js:15` 的 `relu` 只是 max(x,0) 用於布林矩陣），與本題無關，未深入。
- 沒有下載、沒有執行任何模型；所有數字（token 預算、等待時間）都是草案。

## 離線與線上分界（給後續實作者）

- 離線：`_llmGenerate`（`floating-assistant.js:100376`）→ worker → transformers.js。
- 線上：`_coluBenchCall`、`ai.chat`、`_kiLlm`（沒查每一條）。
- 本草案只針對**離線**。

---

## 階段 1 記錄（2026-11-04，純函式，不接 UI、不呼叫模型）

**改了哪些檔**（只有三個，其餘未碰）：
- `renderer/src/recipe/recipe_core.js`：
  - 新增 `stripThink(text)`（約第 88 行起）：回傳 `{answer, reasoning, unclosed}`；去掉 `<think>…</think>` 與 `<thinking>…</thinking>`（大小寫不分），多段思考以空行合併；只有開頭沒閉合時，從開頭到結尾都當思考，並設 `unclosed: true`。
  - `jsonStep`（約第 98 行起）：每次 `generate` 回傳後先呼叫 `stripThink`，驗證、退回提示的「上一個回覆」都只用答案；思考文字累積到 `reasoning`（多次嘗試以空行串接）。成功、失敗、`generate` 拋錯三種回傳都帶 `reasoning` 欄位（新欄位，既有欄位語意不變）。
  - 匯出清單加入 `stripThink`（約第 296 行）。
- `renderer/src/recipe/recipe_core.test.js`：新增約第 165–205 行，共 17 個新檢查（stripThink 12 個＋jsonStep 整合 5 個）。
- 本記錄（`DESIGN.TODO.colu-thinking.md`）。

**測試結果**：
- `node renderer/src/recipe/recipe_core.test.js`：89 passed, 0 failed。
- `node renderer/src/recipe/plan_core.test.js`：57 passed, 0 failed。
- `node renderer/src/recipe/skill_compile_core.test.js`：48 passed, 0 failed。

**遇到的坑與教訓**：
- 步驟 3 寫的 `floating-assistant.js:34015` 在 `renderer/floating-assistant.js`（1196 行）裡超出範圍，行號對不上；語意改照本階段規格（閉合、未閉合、多段、大小寫）實作，沒有照抄那份程式。之後若要對照，要先確認是哪一份副本。
- `skills/weak-model-harness/scripts/vendor/recipe_core.js` 是另一份副本，本階段刻意不同步；要不要同步留給發布階段決定。
- 工作目錄在 Windows 上 git 會提示「LF will be replaced by CRLF」，但索引與工作樹都是 LF，`git diff --stat` 只顯示 54 行新增、6 行刪除，沒有整檔換行變動。
- 回傳新增 `reasoning` 欄位時，要把失敗路徑（`generate` 拋錯）也補上，否則前幾次嘗試的思考會遺失；已補並有測試。

## 階段 2 記錄（2026-11-04，參數與預算，不接任何呼叫端、不接 UI）

**改了哪些檔**：
- `renderer/src/recipe/recipe_core.js`：
  - 新增 `thinkingPlan({modelId, stage, contextTokens, enabled})`（約第 103 行）：只有 `qwen3-0.6b` 且 stage 為 `plan`／`reflect` 且 `enabled !== false` 才開；`plan` 預算＝contextTokens×0.4 夾在 1500～3000、逾時 30000；`reflect` 預算＝×0.075 夾在 300～600、逾時 15000；其他一律 `{enabled:false, maxTokens:null, timeoutMs:null}`。
  - `jsonStep`（約第 117 行）：接受選用的 `ctx.thinking`。有且 enabled 時，先開 `enableThinking:true` 問一輪（maxTokens 用 `thinking.maxTokens`，每次生成都帶 `timeoutMs`）；答案仍不合法 → 同一題（原始 messages）改 `enableThinking:false` 再問一次（只一次，maxTokens 用 `ctx.maxTokens||160`）；再不行走既有 ok:false。`generate` 拋錯不做退路，直接 ok:false。沒有 `ctx.thinking` 時，`generate` 收到的物件只有 `messages／maxTokens／prefill` 三個鍵，與階段 1 完全相同。
  - 匯出清單加入 `thinkingPlan`。
- `renderer/src/floating-assistant.js`（只改 4 處，都用 Edit 以字串定位）：
  - 工作者端 `chat(m)` 的兩處 `enable_thinking: false` → `enable_thinking: m.enableThinking === true`（約第 50881、50883 行）。沒傳時仍是 false，行為不變。
  - `_llmGenerate` 的 `limitMs`（約第 100507 行）：有 `a.timeoutMs` 就用它，否則沿用 90／300 秒。
  - `_llmGenerate` 的 `_vlmRpc('chat', …)` payload 加 `enableThinking`（約第 100509 行）；`_vlmRpc` 用 `Object.assign` 轉交，已確認會到工作者的 `m`。
  - 內嵌的 RECIPE 區塊由 `node scripts/embed-code-ui.js` 重新產生（這次順便把階段 1 的 stripThink 也嵌入了，之前嵌入的是舊版）。其他區塊內容沒有變動。**沒有跑 `build-assistant.js`**，因為它會改寫 `renderer/floating-assistant.js` 與 `.min.js`，這兩份不在本階段範圍。
- `renderer/src/recipe/think_plan.test.js`（新檔，41 個檢查）。
- `scripts/run-core-tests.js`：登記新測試一行。

**測試結果**（假模型，全部在 node 執行）：
- `think_plan.test.js`：41 passed, 0 failed。
- `recipe_core.test.js`：89 passed, 0 failed（與階段 1 相同，沒有新增檢查）。
- `plan_core.test.js`：57 passed, 0 failed。
- `skill_compile_core.test.js`：48 passed, 0 failed。
- `vlm_core.test.js`：135 passed, 0 failed。
- `node --check renderer/src/floating-assistant.js`：語法通過。
- 沒有跑完整的 `run-core-tests.js`，因為它會改寫 `test-reports/` 下本來就有未提交變動的報告檔。

**還沒做（留給後續階段）**：
- 沒有任何呼叫端傳 `thinking`，所以目前實際執行路徑沒有任何改變（階段 3、4 才接計畫與反思）。
- 主執行緒的 `_llmGenerate` 目前只會把 `enableThinking` 與 `timeoutMs` 轉交，還沒有 jsonStep 把 `generate` 的 `req.enableThinking` 轉成 `_llmGenerate` 的 `a.enableThinking`。呼叫端接線時要自己轉（`generate: (req) => this._llmGenerate(model, {messages: req.messages, maxTokens: req.maxTokens, prefill: req.prefill, enableThinking: req.enableThinking, timeoutMs: req.timeoutMs}, cb)`）。
- `renderer/floating-assistant.js` 與 `.min.js` 沒有重新建置，發布前要照專案流程跑 `build-assistant.js`。
- `skills/weak-model-harness/scripts/vendor/recipe_core.js` 仍是另一份副本，本階段刻意不同步（同階段 1）。

**遇到的坑與教訓**：
- `embed-code-ui.js` 會一次重寫所有嵌入區塊。這次 `git diff` 確認只有 RECIPE 區塊與我改的 4 處有實質變動，但之後跑它前應該先 diff 一次確認。
- 工作目錄仍有本階段之外的未提交變動（`.claude/launch.json`、`features/FEATURES.md`、`test-reports/*`、`parts_builtin.json`），提交時只加本階段的檔案。
