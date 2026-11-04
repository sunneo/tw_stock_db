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
