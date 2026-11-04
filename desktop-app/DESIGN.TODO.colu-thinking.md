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

---
## 階段 3 記錄（2026-11-04，計畫階段接上 thinking；只做 UML 由上而下計畫這一條）

**接線位置**（計畫入口 → 呼叫端）：
- `renderer/src/floating-assistant.js` `_coluThinkingFor(M)`（新增，在 `_umlDesign` 前）：線上模型或沒有模型時回傳 null；離線模型交給 `R.thinkingPlan({modelId, stage:'plan', contextTokens, enabled: advancedSettings.coluThinking !== false})`。開關未設定視為開。
- `_umlDesign`：把結果當 `thinking` 傳給 `FaDesign.designProject`；`onStage` 多處理 `type:'thinking'`，進度列印「🧠 思考中…（階段）」「🧠 思考完成（N 字）」。
- `renderer/src/uml/design_core.js`：`designProject` 把 `opts.thinking` 傳給 `scenarioToModelBig`；回傳多一個 `reasoning` 欄位（只給程式內部，`_umlDesign` 不放進工具結果）。
- `renderer/src/uml/uml_core.js`：`scenarioToModel` 的 `ask` 把 `opts.thinking` 原樣交給 `R.jsonStep`；思考字數用 `thinking` 事件送出；結果多一個 `reasoning` 欄位；`scenarioToModelBig` 把切塊的推理串接起來。沒有 `thinking`（或 enabled:false）時，請求與以前完全相同。
- 逾時：`jsonStep` 把 `timeoutMs`（30 秒）交給 `generate`，`_llmGenerate` 本來就用 `a.timeoutMs`；逾時時 worker 回傳已生成的部分文字（不丟例外），沒閉合的思考就變成空答案，jsonStep 走退路（同一題、關 thinking 再問一次）。最後仍不合格就照既有預設路徑（`ok:false`，各階段退回程式預設）。

**修正一個階段 2 的接線問題**：`jsonStep` 開 thinking 那一輪原本也帶 `prefill`（例如 `{"actors":["`），worker 會把 prefill 接在生成提示後面，模型就沒機會先思考。現在只有「開 thinking 的那一輪」不帶 prefill；退路那一輪照舊帶。

**推理不進哪裡（證明）**：`grep reasoning` 在 `recipe_core.js`、`uml_core.js`、`design_core.js`、`floating-assistant.js` 的計畫段落，只會看到：`stripThink` 回傳、`jsonStep` 的 `reasoning` 陣列與回傳欄位、`scenarioToModel`／`scenarioToModelBig`／`designProject` 的回傳欄位、`_umlDesign` 的進度文字（只用字數）。重試時退回的 `messages` 只用答案（`stripThink` 之後的文字）；`decisions` 與 `dsl` 也不含推理。工具結果 `_umlResult(...)` 沒有 `reasoning`，不會存進對話。

**不是 UI**：完整展開推理的介面留給階段 5；這階段只有一行進度。

**測試**：
- `renderer/src/uml/plan_think.test.js`（新檔）：25 passed, 0 failed。涵蓋 thinkingPlan 模型與預算縮放（4096→1638，2048→1500 下限，8192→3000 上限）、開關關、其他模型的請求鍵集合不變、逾時與不合格的退路（同一題、保留 prefill、30 秒）、generate 拋錯不丟例外、推理不進 messages／dsl／decisions、進度事件、切塊合併推理。
- 既有：`recipe_core.test.js` 89、`plan_core.test.js` 57、`skill_compile_core.test.js` 48、`think_plan.test.js` 41、`vlm_core.test.js` 135、`uml_core.test.js` 76，全部 0 failed。
- `scripts/eval/colu_think_plan.eval.js`（真 Electron）：在隔離副本（`%TEMP%\colu-iso\desktop-app`，node_modules 用 junction）跑 `node scripts/eval/run_eval.js`，結果 PASS：qwen3-0.6b 的 7 次計畫呼叫帶 `enableThinking`、逾時 30000、預算 1638，工作者 RPC 的 payload 有 `enableThinking:true`；推理標記不在工具結果；開關關掉後沒有任何 thinking 請求。
- `node scripts/run-core-tests.js`（在隔離副本跑，沒有動到工作目錄的 `test-reports/`）：172／175 組通過。失敗：`tray_dialog`（已知）、`computer-remote` RFB（已知），以及 `harness skill 可攜`（新，見下）。

**沒有做、需要知道的事**：
- `renderer/floating-assistant.js`（建置出來的檔）**沒有**在工作目錄重新建置，因為 `build-assistant.js` 會改寫 `.min.js` 與 `update-manifest.json`（發佈相關）。評估是在隔離副本建置後跑的。發布前要照 `publish-live-update-patch` 流程跑建置。
- `harness skill 可攜` 失敗來自 `skills/weak-model-harness/scripts/vendor/recipe_core.js` 與來源不一致，**從階段 1（4d30a0c0）就開始**（那時就決定不同步，留給發布階段）。這次沒有同步，需要決定：同步 vendor 副本（會讓這個檢查通過）或刪掉這條檢查。
- 計畫階段每一題都可能等 30 秒，一次 UML 設計的題數多（類別、成員、關係、呼叫順序各一題）時，總時間會變長；尚未量測真機時間。
- 評估裡另有 6 次生成沒有 thinking（呼叫來源沒有逐一查明，推測是設計流程的重整／歧義判斷，`designProject` 內的 `opts.generate`）。依設計只有計畫階段開 thinking，這 6 次行為不變。

---

## 階段 4 記錄（2026-11-04，反思：CoLU+Thinking 反思，設計 5(c)；只對 qwen3-0.6b，預設開）

**命名與區分**：函式一律叫「CoLU+Thinking 反思」（`coluThinkReflect`、`coluThinkRevise`、`coluThinkBudget`），和 `floating-assistant.js` 的「反思①②」（程式流程：找工具、達成路線）、`catalog/reflect_core.js`（字詞反思）都不同。

**改了哪些檔**：
- `renderer/src/recipe/recipe_core.js`（新增約 50 行，匯出加三個）：
  - `coluThinkReflect({generate, modelId, contextTokens, enabled, question, timeoutMs?})`：封閉題「這個計畫有沒有缺口？A 沒有 B 有：缺口是…」，走 `thinkingPlan({stage:'reflect'})` 的預算（ratio 0.075、300～600）與 15 秒逾時、`jsonStep` 的 `maxTries: 2`。回傳 `{gap, note, reasoning, ok}`。解析失敗、逾時、generate 拋錯一律 `gap:false`（`ok:false`）；沒有 thinking 時 `skipped:true` 且不呼叫 generate。`note` 最長 200 字。
  - `coluThinkRevise({qid, budget, generate, modelId, contextTokens, enabled, original, describe, redo, secondCheck})`：反思 → 有缺口就 `redo(note)` 重做一次 →（`secondCheck` 時）重做結果再反思一次，仍有缺口就用原本的。上限：整份計畫（`budget.total`）最多 2 次反思；`qid` 不是 `'plan'` 的題目（答案核對失敗那一種）每題最多 1 次。超過上限、重做失敗、重做後仍有缺口一律 `fallback`，`value` 是原本的。
  - `coluThinkBudget({max?, perQMax?})`：預設 `max 2`、`perQMax 1`。
- `renderer/src/recipe/think_reflect.test.js`（新檔）：24 項，全過。涵蓋沒缺口、有缺口重做一次、重做仍失敗用原計畫、計畫層上限、每題上限、整體上限為 0、逾時、解析失敗、拋錯、其他模型不變、開關關閉、推理不進重試的 messages、預算 307（4096 上下文）。
- `renderer/src/uml/design_core.js`（計畫層）：`designProject` 在 `opts.reflect.enabled` 時，計畫產生後反思；有缺口就把 note 以「（反思提示，請修正這個缺口：…）」加在情境後重做一次；`onStage` 送 `{type:'reflect', level:'plan', …}`；`trail` 記一筆。沒給 `reflect` 時呼叫與以前相同。
- `renderer/src/uml/uml_core.js`（答案層）：`scenarioToModel` 的 `ask` 在答案核對失敗（`jsonStep` 回 `ok:false`）且 `opts.reflect.enabled` 時，反思一次；有缺口就把 note 當反思提示重做該題一次（重做的結果照常過 `validate`）；推理只 push 進 `reasoning`。
- `renderer/src/floating-assistant.js`（**來源**，不是建置檔）：
  - 新增 `_coluReflectFor(M)`：和 `_coluThinkingFor(M)` 同一條件（只有 qwen3-0.6b 且開關不是 false），其他情況 `null`，反思完全不跑。
  - `_umlDesign` 傳入 `reflect: this._coluReflectFor(M)`；`onStage` 多一個 `reflect` 分支，進度列一行：「🪞 反思（N 字）：有缺口，已依此重做一次：…／沒有缺口／沒有定論（逾時或格式不對），照原本的」。
  - `node scripts/embed-code-ui.js` 重新嵌入 uml／design／recipe 區塊；`git diff` 確認只有上面這些變動（137 行新增、7 行刪除，跨 4 個檔）。
- `skills/weak-model-harness/scripts/vendor/recipe_core.js`：同步為新的 `recipe_core.js`（改前已確認與 HEAD 一致）。`harness skill 可攜` 仍然通過。
- `scripts/run-core-tests.js`：登記 `think_reflect.test.js` 一行。
- `scripts/eval/colu_think_reflect.eval.js`（新檔）：真 Electron，走 `fa._umlDesign` 整條路徑，假的 `_vlmRpc`，不下載模型。

**測試結果**：
- `think_reflect.test.js`：24 passed, 0 failed。
- 既有：`recipe_core.test.js` 89、`plan_core.test.js` 57、`skill_compile_core.test.js` 48、`think_plan.test.js` 41、`plan_think.test.js` 25、`vlm_core.test.js` 135、`uml_core.test.js` 76，全部 0 failed。`node --check renderer/src/floating-assistant.js` 通過。
- `node scripts/run-core-tests.js`：174／176 組通過。失敗只有既有的兩個：`tray_dialog`（系統匣對話框）與 `computer-remote` 的 RFB 探測。（報告上標「新增」只是因為它們不在 `known-failures.json` 裡，不是新壞的。）`harness skill 可攜` 通過。
- 真 Electron 評估 `scripts/eval/colu_think_reflect.eval.js`：**PASS**。
  - A（gap-once）：計畫後反思 2 次（計畫層＋重做後），有缺口 → 重做請求確實出現；反思帶 thinking；推理標記不在工具結果，也不在任何非反思請求的 messages。
  - B（gap-always）：計畫層反思剛好 2 次，第二次仍有缺口 → 用原計畫。
  - C（garbage）：反思輸出壞掉 → 3 次 RPC（thinking 兩次＋退路一次），沒有重做，流程照常完成。
  - D（開關 false）：0 次反思、0 個 thinking 請求。
  - E（classes-fail）：類別答案核對失敗 → 答案層反思一次（請求含「沒有通過核對」）；計畫層又反思一次（共 2）。
- 評估是在隔離副本跑的（`%TEMP%\colu-iso4\desktop-app`，node_modules 用 junction，在那裡 `node build-assistant.js` 後跑 `run_eval.js`，埠 17942，不用 17923）。工作目錄沒有重建建置檔。

**Grep 證明推理不進 messages／工具結果**：
- `uml_core.js` 的 `reasoning` 只出現在：`scenarioToModel` 的 `reasoning` 陣列與回傳欄位（第 495 行）、`scenarioToModelBig` 串接（第 525、528 行）、`ask` 裡的 `reasoning.push`（推理）。`decisions` 與 `warnings` 不含推理。
- `design_core.js` 的 `reasoning` 只在 `designProject` 回傳欄位（`res.reasoning`），`_umlResult` 不取它。
- `floating-assistant.js` 的 `_umlDesign` 只用 `e.chars`（字數）與 `e.note`（結論），推理文字本身不進進度列。

**遇到的坑與教訓**：
- **第一次評估 0 次反思，原因不在功能**：評估載入的是建置檔 `renderer/floating-assistant.js`，它沒有階段 2～4 的任何程式（`_coluThinkingFor` 也找不到）。建置檔要在隔離副本建置，這跟階段 3 的做法一樣。工作目錄的建置檔仍然是舊的，發布時要照 `publish-live-update-patch` 流程重建（會改 `.min.js` 與 `update-manifest.json`，這一階段沒有做）。
- **測試抓到的真 bug**：`coluThinkBudget({max:0})` 因為寫成 `opts.max || 2` 被當成 2。改成 `!= null` 判斷，並留了一項測試。
- `node scripts/run-core-tests.js` 會覆寫 `test-reports/core-tests-latest.*`，而這兩個檔本來就有使用者未提交的變動。這次先備份、跑完後還原（sha1 驗證），沒有動到它們。
- `scripts/embed-code-ui.js` 會重寫所有嵌入區塊，改前改後都要看 `git diff`，這次確認只有預期的變動。

**沒做、需要知道的事**：
- 真模型（`qwen3-0.6b`）的反思耗時與正確率還沒量測，屬於階段 6（需要使用者先確認下載）。
- 反思的預算（300～600）與逾時（15 秒）是依上一階段的決定，沒有量測。
- 進度列會顯示缺口的一句話（`note`）。這是「結論」，不是推理全文；推理全文留給階段 5 的介面。
- 反思在計畫層與答案層共用同一份預算（整份計畫最多 2 次），所以答案層先反思過，計畫層就只剩一次反思的額度；重做後可能就用不到第二次反思。這是依「整個計畫最多 2 次」的字面意思做的，如果要分開算，請管理層決定。

---
## 階段 5 記錄（2026-11-04，設定介面與推理顯示）

**設定位置（只有一份 UI）**：`#ai-topic-shift-chk`（話題更動檢查）只在 `renderer/src/floating-assistant.js` 的 AI 進階設定 `llm-basic` 分頁裡；`renderer/index.html` 沒有這個開關（grep `topicShiftCheck` 整個 `renderer/` 只有 floating-assistant.js）。所以 CoLU+Thinking 的開關也只加在同一個分頁、話題更動檢查的下面，**沒有第二份要同步**。

**改了哪些檔**：
- `renderer/src/floating-assistant.js`（來源）：
  - 預設 `advancedSettings.coluThinking: true`（`topicShiftCheck` 預設那行上方）；讀設定時 `FaRecipe.coluThinkingSetting(raw.coluThinking)`（未設定視為開）。
  - 面板新增 `#ai-colu-think-chk`＋說明文字（只對離線 qwen3-0.6b、計畫最多約 30 秒、關閉維持快速流程）；面板同步與 `change` 事件寫回 `advancedSettings.coluThinking` 並存檔。
  - `_createProgressWidget`：卡片狀態多 `reasoning` 陣列；回傳物件多 `reasoning(block)`（編輯器靜默路徑是 no-op）；`_faUpdate` 把每段推理畫成一個收合的「思考過程」區塊（`FaRecipe.reasoningBlockHtml`）。
  - `_umlDesign` 的 `onStage`：`thinking` 的 done 與 `reflect` 事件把推理文字交給卡片（`prog.reasoning`）。
- `renderer/src/recipe/recipe_core.js`：新增純函式 `coluThinkingSetting`、`escapeHtml`、`reasoningView`（空白→不顯示；超過 20000 字截斷並記總字數）、`reasoningBlockHtml`（`<details>` 收合，摘要「思考過程（階段）」，內容先跳脫 HTML，截斷註明）；匯出清單加入。
- `renderer/src/uml/uml_core.js`、`renderer/src/uml/design_core.js`：進度事件多帶 `text`（推理全文）與 `label`；`chars` 不變，既有測試不受影響。
- 內嵌區塊：`node scripts/embed-code-ui.js` 重新嵌入（RECIPE、uml、design 區塊）；`git diff -U0` 確認 floating-assistant.js 的 hunk 只有上面這些與嵌入的對應區塊。**沒有在工作目錄跑 build-assistant.js**（會改 `.min.js` 與 manifest，發布才做）。
- `skills/weak-model-harness/scripts/vendor/recipe_core.js`：同步為新的 recipe_core.js（改前已確認與 HEAD 一致）。
- `renderer/src/recipe/colu_think_ui.test.js`（新檔，20 項，全過）；`scripts/run-core-tests.js` 登記一行。
- `scripts/eval/colu_think_ui.eval.js`（新檔，真 Electron）。

**推理三項證明（Grep）**：
- 不進 messages：推理只存在進度卡片的 `state.reasoning`，而 `state` 是掛在 msg 上的**不可列舉**屬性（`Object.defineProperty(..., enumerable:false)`），存檔的 JSON 不會帶；卡片 `content` 仍是空字串。`grep -n "reasoning" renderer/src/floating-assistant.js` 的新增行只出現在設定、卡片與 `_umlDesign` 進度回呼。
- 不送回模型：推理文字只在 `jsonStep`／`scenarioToModel` 的 `reasoning` 陣列與進度事件的 `text` 裡流動；重試與反思的 `messages` 只用 `stripThink` 後的答案（階段 3、4 已證明）。eval 第 4 項確認標記不在任何後續請求的 messages。
- 不進工具結果：`_umlResult(...)` 沒有 `reasoning` 欄位；eval 確認 `JSON.stringify(result)` 不含標記。

**測試結果**：
- `colu_think_ui.test.js`：20 passed, 0 failed。
- 既有：`recipe_core` 89、`plan_core` 57、`skill_compile_core` 48、`think_plan` 41、`plan_think` 25、`think_reflect` 24、`vlm_core` 135、`uml_core` 76，全部 0 failed。`node --check renderer/src/floating-assistant.js` 通過。
- 真 Electron `colu_think_ui.eval.js`：**PASS**（在隔離副本 `%TEMP%\colu-iso5\desktop-app` 建置後跑，埠 17952，不用 17923）。驗證：checkbox 存在、標籤含 CoLU+Thinking、預設打開、點擊切換寫回設定；關閉時計畫無 thinking 請求、沒有推理區塊；開啟時有 thinking 請求，8 個收合區塊預設收合、摘要以「思考過程」開頭，展開後含標記，推理內的 `<img>` 被跳脫（沒有產生元素、沒有執行）。
- `node scripts/run-core-tests.js`（隔離副本）：175／177。失敗只有已知的兩個：`tray_dialog`（標為新增，因為不在 known-failures）與 `computer-remote` RFB 探測。新測試通過。

**沒做、需要知道的事**：
- 推理區塊目前掛在**進度卡片**上（每次設計呼叫的每段推理一個收合區塊），不是獨立的對話泡泡；「每次回應各有自己的推理」在這裡指「每次 UML 設計呼叫各有自己的卡片與推理」。若要放進 AI 回覆泡泡，需要另外設計（留給管理層決定）。
- 重新載入頁面或重開對話後，卡片與推理一起消失（允許的）。
- 工作目錄的 `renderer/floating-assistant.js` 與 `.min.js` 仍是舊建置，發布前要照 `publish-live-update-patch` 流程建置。
- `test-reports/*` 與 `.claude/launch.json`、`features/FEATURES.md`、`parts_builtin.json` 是使用者既有的未提交變動，本階段沒有提交。

---
## 階段 6 記錄（2026-11-04，真模型量測；CPU；樣本只有 8 題／組，屬於粗略估計）

**全部是真量測**（真 Electron、真 `_vlmEnsureLoaded`、真 `_llmGenerate` 與工作者），除非另外標註「推測」。

**環境與下載**：
- 隔離副本 `%TEMP%\colu-real\desktop-app`（robocopy 複製、node_modules 用 junction、在副本跑 `build-assistant.js`），獨立 `--user-data-dir=%TEMP%\colu-real-ud`，埠 17961，`FA_DISABLE_MAIN_OVERLAY=1`，工作目錄的檔案沒有動到。
- 下載：只有 `qwen3-0.6b`，走桌面版離線模型的載入機制（`_vlmEnsureLoaded`）。快取裡有一個 **589.1 MB** 項目（`Service Worker\CacheStorage\…\49032712165d938b_0`），對應 CPU 版（`bytes.cpu` 589 MB）。檔名沒有還原成 ONNX 原名（推測是 CPU 版權重）。**下載耗時沒有量到**（第一次前景執行被 170 秒上限截斷，沒有計時）。
- 裝置：`gpu.available` 為真，但 `這張顯示卡不支援 fp16 著色器（shader-f16）`，所以退到 **CPU（wasm）**。**沒有量到 WebGPU。**

**題目**（固定種子 20261104，程式算答案）：
- 封閉題：8 題（乘法、除法餘數、數列、四則運算各 2 題），答案字母。
- 計畫題：`FaColuBench.makeTasks` 出的前 8 題（有選項的），`FaColuBench.grade` 判分。
- 反思：計畫題前 3 題，每題 3 次 `coluThinkReflect`。

**逾時的誠實說明**：程式裡的思考逾時是 WebGPU 30 秒、CPU 用量測上限 **60 秒**（這是量測用上限，不是產品設定）。實際執行中，**思考開的 16 次呼叫有 2 次被實際卡到 120 秒（`err:"已卸載"`，判定逾時）**，計畫題有一題最長跑到 **148.6 秒**，仍然回了正確答案。所以 60 秒上限在 CPU 上**沒有被準確執行**。原因沒有查證（推測：工作者的中斷要等目前這一步結束，CPU 上一步很慢）。以下的「超過 30 秒」與耗時分布是實測值，不是預期值。

**數字**（來自結果檔 `%TEMP%\colu-real-out\run-2026-11-04T12-28-17-902Z.jsonl`，`event:"done"`）：

| 組 | 題數 | 正確 | 中位耗時 | 最長 | 超過 30 秒 | 逾時 | 解析失敗（退路觸發） | 思考字數中位 |
|---|---|---|---|---|---|---|---|---|
| G1 封閉題・思考關 | 8 | 1（13%） | 3.6 秒 | 6.7 秒 | 0 | 0 | 0 | 0 |
| G2 封閉題・思考開 | 8 | 6（75%） | 61.1 秒 | 120.0 秒 | 7 | 1 | 1 | 265 |
| G3 計畫題・思考關 | 8 | 4（50%） | 8.4 秒 | 13.1 秒 | 0 | 0 | 0 | 0 |
| G4 計畫題・思考開 | 8 | 6（75%） | 112.8 秒 | 148.6 秒 | 8 | 1 | 1 | 432 |
| R 反思（3 題×3 次，逾時 15 秒） | 9 | **0 個有效判斷**（全部 15 秒逾時） | 15.0 秒 | 15.0 秒 | — | 9 | — | — |

- 同題對照（思考開 vs 關，只看正確與否）：封閉題 開贏 5、關贏 0、都對 1、都錯 2；計畫題 開贏 2、關贏 0、都對 4、都錯 2。
- 退路（解析失敗時改問關閉思考那一題）：封閉題退路後 6/8，計畫題退路後 6/8（退路那一題答案＝G1／G3 同題答案，兩題的退路答案都是對的）。
- 反思的「三次一致率」**沒有量到**：9 次都逾時，沒有有效判斷可以比。
- 原始回覆文字**沒有存進結果檔**（只存判分與耗時），所以 G1 的 7 題錯誤是「不思考就錯」還是「格式／字母位置偏差」無法從資料分辨。
- 結果檔裡的逐題進度行是即時寫的（`event:"q"`）；桌面版不會把 renderer 的 `console.log` 送到終端，所以進度只能從結果檔看。

**三問結論**（都只有 8 題／組，CPU，請當作方向性的證據）：

1. **thinking 開比關好嗎？** 在這 8 題的樣本裡是好的：封閉題 13%→75%，計畫題 50%→75%，而且「關贏、開輸」是 0 題（沒有同題是關對開錯）。代價很大：CPU 上封閉題中位耗時從 3.6 秒變成 61 秒，計畫題從 8.4 秒變成 113 秒。**結論：正確率有利，但耗時在 CPU 上不能接受當預設。** 樣本太小，不能說「一定比較好」，只能說沒有看到反效果。

2. **30 秒夠嗎？** **CPU 上不夠。** 思考開的 16 次呼叫中 15 次超過 30 秒，中位數 61 秒（封閉）與 113 秒（計畫）。如果按產品設定的 30 秒切（沒有實際跑這個設定，只看實測耗時分布推測），思考開的答案大多會被切掉；退路會改問關閉思考那一題，本組的關閉結果是 50%（G3），所以 30 秒上限在 CPU 上會讓計畫題退回接近關閉思考的水準。這是推測，沒有實測。**WebGPU 上是否夠，沒有量到**（這台機器的 WebGPU 不能用這個模型）。

3. **預算 1500～3000 要不要調？** 這次的預算是 1638（上下文 4096 × 0.4）。**沒有看到預算被用完的證據**：思考都有閉合（`unclosed` 全部 0），思考字數中位數只有 265 與 432 字（字數不等於 token，沒有 token 計數）。所以**這次的數據不支持把預算調大**；真正的瓶頸是時間，不是預算。如果要調，應該先做**逾時行為**的修正（上面的 60 秒沒有被準確執行），再決定預算。**建議（只是建議，沒有改程式）**：CPU 上計畫階段的思考預設關閉，或使用者明確開啟時顯示預估時間；預算維持 1638 不動。反思的 15 秒在 CPU 上**完全不可用**（0/9 有效判斷），反思在 CPU 上應該先關掉，或把逾時放寬後重量。

**沒有做、需要知道的事**：
- 每組只有 8 題（使用者原始要求 ≥20 題；管理層這次縮小為 8 題，原因是 CPU 單組可達一小時以上）。
- 反思三次一致率沒有量到；WebGPU 沒有量到；下載耗時沒有量到。
- 60 秒上限沒有被準確執行，原因沒有查證。
- 沒有存原始回覆，無法分析錯誤型態。
- 第一次背景執行（`by308vpbd`）很快以 exit 0 結束，沒有輸出；原因沒有查證（後來的前景執行正常）。

**量測指令**（在隔離副本，不要在工作目錄直接跑）：
```bash
cd "$TEMP/colu-real/desktop-app"
FA_DISABLE_MAIN_OVERLAY=1 FA_DEBUG_EVAL_FILE="$PWD/scripts/eval/colu_think_real.eval.js" FA_BROWSER_CONTROL_PORT=17961 ./node_modules/electron/dist/electron.exe "$PWD" --no-sandbox --user-data-dir="$TEMP/colu-real-ud"
```
- `scripts/eval/colu_think_real.eval.js` 的 `FAKE` 常數為 `false` 時是真量測；`FAKE = true` 時只跑假生成（約 7 秒），用來驗證流程與結果檔。
