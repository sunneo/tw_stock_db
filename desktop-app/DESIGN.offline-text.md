# 離線文字生成（聊天）模型：設計與移植指南

離線訓練器（Offline Trainer）沒把握回答時，改叫「離線文字模型」（transformers.js，WebGPU 或 WASM 多核 CPU）回答；可以參考 RAG、呼叫工具，也可以把多個模型分工混用。
這份文件跟 `DESIGN.offline-vision.md`、`DESIGN.offline-vision-portability.md` 同一套機制（同一個登記表 `FaVlm.MODELS`、同一個 Worker、同一個快取管理），移植到 redmine AI chat 時一起帶走。

## 1. 流程

```
使用者的話 ──► 離線訓練器（規則／語意／重排）
                 │ 信心 ≥ 門檻 ─► 執行工具／回答（原本的路）
                 │ 信心 < 門檻（decision.status === 'unresolved'）
                 ▼
        離線文字模型（FaVlm.shouldUseOfflineLlm）
                 │ 缺參數（needs_input）不進來：模型也不知道缺的網址或路徑
                 ▼
        FaVlm.routeStages ──► 階段一：工具模型（呼叫工具）──交接──► 階段二：回答模型（寫文字）
                              （沒有工具／沒有可信的工具模型 ＝ 單純文字生成，只有一個階段）
```

- **信心門檻**範圍 0.1～1.0（`FaVlm.clampThreshold`）。拉到 **1.0＝只有「完全一樣的問題」（決定性快取，分數 1）才由訓練器處理，其餘幾乎都交給離線文字模型**。設定頁有兩處滑桿（離線訓練器分頁、離線模型管理分頁）綁同一個設定。
- 也用在「所有線上模型都失敗」的自動備援（`opts.fallback`）：這時**不問使用者、不偷偷下載**，只用已下載的模型，沒有就在訊息裡說明怎麼下載。使用者主動走的（門檻很高、離線模式）才會問一次要不要下載，拒絕後同一個工作階段不再問。

## 2. 兩個預設、角色標記、優先順序

- 預設分開：`offlineTextModel`（文字生成，預設 `qwen3-0.6b`）與 `imageToTextModel`（圖像 VLM，預設 `florence-2-base-ft`）。設定頁「離線模型管理」分成「文字生成（聊天）」「圖像（VLM）」「其他」三區，各自有「設為預設」。
- 每個文字模型有**角色標記**（`tools` 呼叫工具／`answer` 寫最後回答／`summarize` 摘要過長內容）、**優先順序**（數字大的先用）、**運算裝置**（跟全域／GPU／CPU），存在 `offlineTextRoles[modelId]`。
- 沒有工具呼叫格式的模型（`toolCalling` 為空，例如 SmolLM2）不能被勾 `tools`（`FaVlm.roleConfig` 會擋）。
- 選法（`FaVlm.routeStages`）：同一角色有多個候選時，**工具角色先看信任度**——基準測試「可靠／普通」的（trusted）排在沒測過的（untested）前面，評為「不可靠」或沒有格式的（no）直接排除；信任度相同再看優先順序；再看是否是預設；最後比大小。自動備援模式（`requireInstalled`）優先選已下載的。

## 3. 混用（模仿 MoE 的分工）與 GPU／CPU 分派

一張 GPU 放不下全部模型，所以**不同時載入同一個裝置，而是依階段輪流**：

- 階段一（工具模型）跑 `FaVlm.runAgentLoop(... handoff:true)`：呼叫工具、拿結果；一旦不再呼叫（或被強制收尾），就**交接**——不自己寫最後的回答，只回傳工具結果。
- 階段二（回答模型）拿「工具結果（整理成參考資料，`toolResultsAsReferences`）＋RAG＋對話歷史」專心寫文字，不給工具。
- 工具模型根本沒用到工具、自己直接答了：預設還是交給回答模型重寫（`offlineLlmMixRewrite`，可關）。
- **GPU 與 CPU 各有一個獨立的 Worker 槽**（`_vlmWorkerGet('gpu'|'cpu')`）。模型分派到不同裝置（例如小的工具模型放 CPU、大的回答模型放 GPU）就能**同時駐留、不用來回換**；同一個裝置上的兩個模型才是階段性輪流載入（新模型載入會卸掉那個槽原本的）。每個槽閒置 5 分鐘各自卸載。

## 4. 對話迴圈（`FaVlm.runAgentLoop`，純函式，注入 `generate`／`execTool`）

不調用工具＝單純文字生成（一輪、不給工具）。有調用才多輪，但一定收斂：

| 風險 | 防呆 |
|---|---|
| 無窮迴圈 | 輪數上限 4、呼叫總數上限 6、每輪最多 3 個呼叫；同一個「工具＋參數」不執行第二次（回一句「結果在上面，請直接回答」並收回工具）；不存在的工具最多容忍 2 次；收回工具後模型還在輸出工具呼叫 ＝ 沒收斂，走收尾 |
| 垃圾輸出 | `looksLikeGarbage`：空白、只有標點、重複同一段（6～80 字連續 4 次；短單位 12 次；重複行比例）、亂碼字元。**串流中**每 64 字檢查一次，偵測到就送 `interrupt` 中斷生成（Worker 端 `InterruptableStoppingCriteria`）；整體再加逾時（GPU 90 秒、CPU 300 秒）。垃圾 → 用保守參數（確定性、重複懲罰 1.2、`no_repeat_ngram_size` 5、不給工具）重試一次，還是垃圾 → 有工具結果就老實列出原始結果，沒有就回報失敗，**不把垃圾丟給使用者** |
| 上下文爆掉 | 每一輪重新估算（`estimateTokens`）；`fitMessages`：① 舊的工具結果換成 **placeholder**（`[工具名 的結果已省略；摘要：前 60 字…]`）② 最新的工具結果截短 ③ 丟最舊的對話（system、這次的問題、強制回答的提示不丟，並插一則「較早的 N 則已省略」）；仍放不下 → `context_full`，不呼叫模型。過長的工具結果先交給摘要模型摘要（同一個模型才做，避免中途換模型），沒有就截短 |
| 預算寫死 | `textBudget(model, maxReply)`：system／工具說明／RAG／歷史／問題的份量都是**模型 `contextTokens` 的比例**，不是常數；換大上下文的模型自動帶更多歷史與參考資料 |

## 4.1 不卡主執行緒

- 推論全在 Worker（GPU、CPU 各一個）；主執行緒只做很輕的事。
- 串流的文字在 Worker 端**每 120 毫秒批次送一次**（不是一個 token 一則訊息）。
- 正規表示式與 token 估計都限制長度：很長的輸出只檢查頭尾各 3000 字；`trimToTokens` 先把超長文字切短再二分搜尋。
- 實測（打包版 Electron，CPU 4 執行緒，Qwen3 0.6B 連續生成 111 秒、2230 個 50 毫秒計時點）：**主執行緒最大延遲 16 毫秒，超過 100 毫秒的次數 0**。
- 有副作用的工具執行前一定問使用者（`FA_OT_RISKY_TOOL`）；工具本身在主執行緒執行，這部分沿用既有工具的行為。

## 5. 工具呼叫基準測試

- 設定頁每個有工具格式的文字模型有「**測試工具呼叫**」按鈕：6 題固定題目、3 個假工具（`get_weather`、`calculator`、`search_web`）、確定性生成；涵蓋中文／英文、該用工具／不該用工具（要能克制）。
- 評分：選對工具＋參數對＝1 分（`FaVlm.scoreToolCase`）；彙總（`summarizeToolBench`）：≥83% 可靠、≥50% 普通、其餘不可靠。結果存 `offlineToolBench[modelId]`（含每題原因、裝置、耗時），設定頁用顏色標記。
- **標記決定工具迴圈是否啟用**：評為「不可靠」的模型不會被選去呼叫工具；沒測過的只在沒有測過的候選時才用，並在進度卡片提示「建議先做基準測試」。（redmine 那邊的實測也印證：Qwen3-0.6B 能正確輸出 `<tool_call>`，Qwen2.5 兩個沒有主動呼叫——所以不能靠「模型號稱支援」，要靠實測標記。）

## 6. 登記表（文字模型）

| id | repo | GPU／CPU 大小 | 工具 | 備註 |
|---|---|---|---|---|
| `qwen3-0.6b`（預設） | `onnx-community/Qwen3-0.6B-ONNX` | q4f16 543MB／q8 589MB | ✔ | 中英文；思考模式關閉 |
| `qwen2.5-0.5b` | `onnx-community/Qwen2.5-0.5B-Instruct` | 461MB／488MB | ✔（未測） | 更小，工具呼叫容易出錯 |
| `smollm2-360m` | `HuggingFaceTB/SmolLM2-360M-Instruct` | 260MB／348MB | ✘ | 最小，英文為主，只能聊天與依參考資料回答 |
| `granite-4.0-350m` | `onnx-community/granite-4.0-350m-ONNX-web` | 336MB／551MB | ✔（未測） | IBM，標榜工具呼叫；適合當工具階段模型 |
| `granite-4.0-1b` | `onnx-community/granite-4.0-1b-ONNX-web` | 1192MB／1702MB | ✔（redmine 實測通過，這邊未測） | IBM，工具呼叫專長；適合當工具階段模型 |
| `qwen2.5-1.5b` | `onnx-community/Qwen2.5-1.5B-Instruct` | 1165MB／1506MB | ✔（未測） | 上下文 8192；CPU 很慢 |
| `qwen3-1.7b` | `onnx-community/Qwen3-1.7B-ONNX` | 1360MB／1662MB | ✔（未測） | 清單裡品質最好 |

大小是依 HuggingFace 檔案清單讀來的。**沒列進來的**：FunctionGemma 270M（Gemma 授權、工具格式是 `<start_function_call>`）、LFM2（Pythonic 格式 `<|tool_call_start|>[fn(a=1)]`）——格式跟這裡的 Hermes `<tool_call>` 不同，要先在 `FaVlm.parseToolCalls` 加對應解析與測試再登記。

## 7. 移植到 redmine

帶走：`vlm_core.js`（含 `runAgentLoop`、`routeStages`、`parseToolCalls`、基準測試題目）與 `vlm_core.test.js`（兩邊行為一致的合約）、`faVlmWorkerMain`（`chat`／`interrupt`／`stream`）、host 端的 `_vlmWorkerGet(slot)`／`_llmGenerate`／`_offlineLlmAnswer`／`_omToolBench`。redmine 需要自己接的：`this.tools`（工具表與參數 schema）、`requestUserForm`（危險工具確認）、`ragSystem.query`、`_createProgressWidget`，以及把「離線訓練器 unresolved」接到 `_offlineLlmAnswer`。

## 7.1 真實環境實測（打包版 Electron、CPU 4 執行緒、2026-10-07）

- **工具呼叫基準測試**（6 題，確定性生成）：`qwen3-0.6b` **5/6 可靠**（只有「上網查 Rust borrow checker」沒輸出可解析的呼叫），`qwen2.5-0.5b` **1/6 不可靠**（只有「不該用工具」那題對；其餘都沒主動呼叫）。redmine 那邊獨立實測得到同樣的結論，所以工具迴圈是否啟用必須看基準測試標記，不能看模型「號稱支援」。
- **主執行緒不卡**：整個生成期間（基準測試 111～124 秒、對話 12～157 秒）用 50 毫秒計時器量主執行緒延遲，**最大 36 毫秒，超過 100 毫秒的次數 0**。
- **完整流程**：單一模型（qwen3-0.6b）：「用 ref_lookup 工具查一下 errno 2」→ 呼叫 `ref_lookup {query:"errno 2"}` → 依結果回答「文件或目錄不存在（No such file or directory）…」（正確）；「你好」→ 不呼叫工具直接回答。混用（qwen3-0.6b 工具 → qwen2.5-0.5b 寫回答）：兩階段、換模型都正常，但 0.5B 的寫回答模型品質差（把正確的工具結果寫成「答案是：no ERROR 2」）——**混用的好處是分工與省顯示記憶體，寫回答的模型本身不夠強就沒有幫助**，建議寫回答用 ≥1.5B 或同一個 0.6B。
- **小模型很脆弱的幾個教訓**（都已修）：① 工具階段的 system 提示詞要用基準測試驗證過的那一句（`FaVlm.TOOL_STAGE_SYSTEM`）；加長提示詞（「閒聊不要用工具」「請用繁體中文」）會讓 0.6B 直接不呼叫工具。② 工具結果要給**精簡的原始 JSON**，不要用給人看的 `_otPretty`（它把巢狀欄位壓平，`ref_lookup` 的 `matches` 整個消失，模型就拿不到答案）。③ 寫回答的小模型會忽略 system 裡的參考資料，工具結果要放進**使用者那一輪**並明說「只根據這些結果回答」。④ 一開始的 system 提示詞寫「不確定就說不確定」，0.6B 就對每句話（包括「你好」）回「不確定。」——不要用這種語氣。⑤ 選工具用確定性生成（貪婪），寫回答才用取樣。
- **已知限制**：0.6B 常輸出簡體字（即使提示詞要求繁體），事實性知識很差（會編造）；有 RAG 或工具結果時才可靠。

## 8. 還沒驗證的

- 沒有 slash command：**不做 `/offline-chat`**（redmine 那邊也取消了）。離線文字模型只有兩種進入方式——離線訓練器信心不足、以及線上模型全部失敗／斷線的自動備援。設定頁的「試聊」只是除錯用。
- GPU 路徑的文字推論（開發機的顯示卡沒有 `shader-f16`；使用者的 Intel GPU 已能跑圖像模型，文字模型待實測）。
- 混用兩個模型的實際耗時與記憶體（同裝置輪流載入、不同裝置同時駐留）。
- Qwen2.5、Granite、1.5B／1.7B 的工具呼叫評分；中文品質。
- 外部資料格式（`.onnx_data` 外部權重）在 Granite 上能不能載入。
