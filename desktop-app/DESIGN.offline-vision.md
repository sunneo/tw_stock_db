# 離線圖像轉文字（Image to Text）與離線模型管理

> 狀態：2026-10-06，**程式與介面完成、流程用假的推論驗證過；真實模型還沒有下載與實測**（見第 7 節）。
> 目標：線上視覺模型看不到圖片、失敗、或使用者要離線處理時，有一個**跑在這台電腦上**的圖像轉文字能力，作為離線訓練器的圖像辨識解法之一；而且**不能卡住主執行緒**。

## 1. 架構

```
主執行緒（只做：設定、進度顯示、傳圖片與收結果）
  └─ _imageToText(p)  ── postMessage ──►  Worker（faVlmWorkerMain）
        │                                    ├─ import transformers.js（CDN；WebGPU 用 4.2.0、CPU 用 3.7.5，跟 Whisper 同一套）
        │                                    ├─ from_pretrained(模型, {dtype, device, progress_callback})   ← 下載＋載入
        │                                    └─ 前處理＋generate（Florence-2／SmolVLM／ViT-GPT2／PaliGemma／llava）
        └─ 純邏輯 FaVlm（renderer/src/vlm/vlm_core.js）：模型登記表、裝置與執行緒決策、任務與提示詞、結果整理、快取用量
```

- **模型下載、載入、推論全都在 Worker**（module worker，從 Blob 建立）；圖片用 Blob 直接丟給 Worker，主執行緒不解碼、不推論。這是看過「圖片分解卡住畫面」之後的硬性要求。
- Worker 重複使用（模型載一次，之後的呼叫不用再載）；**閒置 5 分鐘自動卸載**（結束 Worker，釋放記憶體與顯示記憶體）。換裝置、換核心數設定、刪除模型時也會卸載。
- 模型檔存在瀏覽器的 Cache API（`transformers-cache`，URL 為鍵），跟 Whisper 共用；用量與刪除都是掃這個快取。

## 2. 模型登記表（`FaVlm.MODELS`）

大小是 2026-10-06 從 HuggingFace 檔案清單讀的（只讀 metadata，沒有下載模型）。`verified: false` 代表**照官方範例寫的、還沒在真實環境跑過**，介面會標「未驗證」。

| 模型 | 來源 | 下載量（CPU／GPU） | 能做 | 備註 |
|---|---|---|---|---|
| **Florence-2 base（預設）** | `onnx-community/Florence-2-base-ft` | 約 208MB／344MB | 簡短與詳細描述、OCR、物件偵測 | 沒有自由問答；英文輸出 |
| SmolVLM 256M | `HuggingFaceTB/SmolVLM-256M-Instruct` | 約 203MB／200MB | 描述、OCR、物件、**問問題** | 英文為主 |
| ViT-GPT2 | `Xenova/vit-gpt2-image-captioning` | 約 238MB | 一句話描述 | 最簡單 |
| **LLaVA-Interleave Qwen 0.5B（實驗）** | `luisresende13/llava-interleave-qwen-0.5b-hf`（**社群轉檔**） | 約 1.4GB（int8）／2.2GB（fp16） | 描述、OCR、物件、問問題 | **沒有官方的瀏覽器版轉檔**；能不能跑要看 transformers.js 是否支援 llava 架構，載入失敗會直接回報 |
| Whisper base | `onnx-community/whisper-base` | 約 80MB | （語音轉文字，只用來管理快取） | 不是圖像模型 |

**PaliGemma 2 3B 已從清單移除**（2026-10-06）：使用者機器上載入失敗（WebGPU：`operation does not support unaligned accesses`），沒辦法驗證，留在清單只會讓人點了就失敗。Worker 與 `buildTask` 裡的 `paligemma` 分支保留，之後有可行的轉檔再把登記表加回來。LLaVA-Interleave 原本只是社群轉檔，LLaVA-Interleave 在 HuggingFace 上找不到 transformers.js 官方轉檔，只有一份社群轉的 ONNX，**我沒有驗證它能不能在瀏覽器跑**。預設用 Florence-2（小、快、會 OCR）。

輸出主要是**英文**（這些模型的限制）；要中文就由線上 AI 翻譯，或使用者自己讀。

## 3. 裝置與核心數（全域設定，Whisper 共用）

設定：`advancedSettings.offlineDevicePreference`（`gpu`／`cpu`，預設 gpu）、`offlineMaxCpuCores`（0＝不限制）、`imageToTextModel`、`offlineVisionFallback`。舊設定沒有這幾個時，偏好沿用 Whisper 的 `whisperDevicePreference`。

- **偏好 GPU，不支援一律降級 CPU**（`FaVlm.resolveDevice`）：
  - 偏好 GPU＋有 WebGPU → 依序試 `webgpu`、`wasm`（載入或推論任何一步失敗都會自動降級重試，結果會標 `fell_back_from_gpu`）。
  - 沒有 WebGPU → CPU，並說明原因（`navigator.gpu` 不存在、找不到介面卡…）。
  - **這張顯示卡不支援 `shader-f16`** 而模型的 GPU 版本用 fp16／q4f16 → 這個模型改用 CPU（我在這台開發機的 GPU 上實際碰到：偵測到 WebGPU，但沒有 fp16）。
  - 只能用 GPU 的模型（目前清單沒有，邏輯與測試保留）在沒有 GPU 或沒有 fp16 時直接拒絕，不假裝能跑；偏好 CPU 也仍然用 GPU（並說明）。
- **CPU 核心上限**：請求的執行緒數 ＝ min(上限, 偵測到的邏輯核心)；ONNX Runtime 的 WASM 多執行緒需要頁面是 **cross-origin isolated**（`SharedArrayBuffer`），否則只會用 1 個執行緒。**設定頁會照實顯示「請求 N 個、實際 M 個」與原因。**
  - **已知限制（我在打包版實測）**：目前桌面版 `crossOriginIsolated` 是 **false**（頁面用 `file://` 載入，`main.js` 已經補了 COOP／COEP 標頭但在 `file://` 下沒有用，原因記在 `main.js` 的註解裡）。所以 **CPU 路徑現在實際只有 1 個執行緒**，核心數設定要等頁面改成 `http://127.0.0.1` 由本機伺服器提供（`local-proxy.js` 已經有提供靜態檔與 COOP 標頭的能力）才會生效——那是主程序的載入流程改動，不能熱更新，這次沒有做。**多核心 CPU 目前是設定與介面都備好、但環境條件還沒滿足。** WebGPU 路徑不受影響。
  - 網頁版（GitHub Pages）靠 `coi-serviceworker` 取得隔離（Whisper 已經在用）；沒有隔離時一樣降成 1 個執行緒。

## 4. 設定頁：Configure →「離線模型管理」

- **運算裝置**：偏好 GPU／CPU 下拉；WebGPU 偵測結果（顯示卡名稱、是否支援 fp16）；CPU 核心上限；「請求幾個、實際幾個」與原因。
- **儲存空間**：快取總用量；每個模型一列——狀態（已下載 X MB／未下載）、預估大小、標籤（預設、實驗、未驗證、只能用 GPU）、**下載**（先問、顯示進度）、**設為預設**、**刪除**；其他（非登記模型）快取可以逐個 repo 刪除；**全部清除**；備援開關。
- **試跑**：選一張圖、選任務、（問問題時）輸入提示詞，直接用預設模型跑，顯示文字、裝置、執行緒、秒數、是否降級。
- 原本 Whisper 區塊的「運算裝置」與「CPU 執行緒數」移到這裡（共用同一組設定）；Whisper 的快取用量與清除按鈕保留。

## 5. 使用入口

- **工具 `image_to_text`**（AI 呼叫）：`task`（caption／detailed／ocr／objects／ask）、`image`、`prompt`、`model`、`device`、`max_tokens`。沒給圖就用這個對話最新的圖片附件（多張會問）。第一次下載前一定先問（顯示來源、大小、可清除）。
- **斜線指令 `/image-to-text [描述|詳細|文字|物件|問 …]`**：先貼圖再打、或先打指令再貼圖送出都可以。
- **離線訓練器的路由**：「解析這張圖」「描述這張圖片」「圖片轉文字」「辨識圖片裡的文字」「OCR」直接走 `image_to_text`，不經過 AI（「截圖」留給原本的截圖規則）。
- **線上視覺備援**：`interpret_image`（線上視覺模型）失敗時，若離線模型**已經下載**，自動改用離線並註明；**不會偷偷下載幾百 MB**（沒下載就回報錯誤並提示 `image_to_text`）。工具說明也告訴 AI：線上模型看不到圖片時改用 `image_to_text`。

## 6. 測試

- 純函式：`node renderer/src/vlm/vlm_core.test.js`（36 項：登記表、裝置決策含降級／fp16／只能 GPU、執行緒、任務提示詞、結果整理、快取用量）；已併進 `node scripts/run-core-tests.js`。
- 真實 Electron（打包版）：
  - 設定頁分頁出現、各列與按鈕、裝置與核心數設定寫入並影響 Whisper 的執行緒、快取用量與刪除（用假的快取檔案）、全部清除。
  - **Worker 真的是獨立執行緒**：dispose 往返 12 毫秒；載入一個故意壞掉的函式庫會得到錯誤而不是卡住。
  - `_imageToText` 流程（**用假的 Worker 回應，沒有真的下載與推論**）：GPU 推論失敗→降級 CPU 重試成功；GPU 載入失敗→降級；沒有 WebGPU→CPU；只能用 GPU 的模型被拒絕；沒下載過會先問（取消就不跑）；備援模式不自己下載。
  - 離線路由：5 句中文說法分到 `image_to_text`、「變成 3D」仍然分給圖片分解。

## 7. 真實環境實測結果（2026-10-06）與還沒驗證的

同一張圖（藍白機器人＋金色硬幣＋圓形金邊框），開發機（CPU 4 執行緒，顯示卡缺 `shader-f16`）與使用者的 Intel GPU：

| 模型 | 路徑 | 簡短 | 詳細 | 品質 |
|---|---|---|---|---|
| Florence-2 | CPU 約 21～34 秒；使用者 GPU 載入成功 | ✓ | ✓ | 堪用；把機器人頭上的標誌讀成「B」 |
| ViT-GPT2 | CPU 約 2 秒（首次含載入 16 秒） | ✓ | 不支援，降級成簡短並標明 | 最差（說成「時鐘上的卡通人物」） |
| LLaVA-Interleave | CPU 約 140～150 秒；**Intel GPU 約 23 秒** | ✓ | ✓ | **最準**（藍白機器人、金幣、圓形金邊） |
| SmolVLM 256M | CPU 16～38 秒；Intel GPU 約 10 秒 | ✓ | ✓ | 差：細節幻覺（把頭盔笑容讀成數字「3」、編出不存在的文字） |

- **SmolVLM 重複迴圈**：第一次實測會一直重複同一句（CPU、GPU 都是）。修法是對話式模型（`vision2seq`、`llava`）的描述類任務加 `repetition_penalty 1.25`＋`no_repeat_ngram_size 6`（OCR 不加，文字本來就會重複），並把描述的預設 token 上限降到簡短 96／詳細 256／OCR 384（`FaVlm.generationParams`、`FaVlm.defaultMaxTokens`）。修後不再迴圈，但**準確度是 256M 模型的上限，不是程式問題**——只適合快速粗略描述，不要拿來讀字或數東西。
- 登記表的 `verified` 現在代表「真的跑過」，並用 `verifiedOn` 註明路徑（`cpu`／`cpu+gpu`）、`measured` 記實測數字，設定頁會顯示。SmolVLM 維持 `verified:false`（品質不足）。
- **選模型建議**：預設 Florence-2（快、有 OCR 與物件偵測）；要最準且有 GPU 用 LLaVA-Interleave；只有 CPU 時 LLaVA 太慢（約 2.5 分鐘）。

**仍然沒驗證**

1. 上表以外的組合沒有跑過（例如 Florence-2 在 GPU 上的推論結果、多執行緒的實際加速幅度）。以下是最初寫程式時的假設，現在多數已被上表推翻或證實：Worker 裡的載入與推論程式碼是照 transformers.js 官方範例寫的（Florence-2：`construct_prompts`／`post_process_generation`；SmolVLM：`apply_chat_template`＋`processor(text,[image])`；PaliGemma、llava 是依同樣模式推的）。**第一次真實執行可能遇到的：函式庫版本不支援某個架構、dtype 組合在你的 GPU 上不能跑、記憶體不足、HuggingFace 連線被擋。** 這些都會以錯誤訊息回報、GPU 失敗會自動降級，但我沒辦法保證預設組合一次成功。
2. 版本選擇沿用 Whisper 的經驗：WebGPU 用 transformers.js 4.2.0、CPU 用 3.7.5；VLM 在這兩個版本上的行為沒有驗證。
3. 多核心 CPU 見第 3 節（環境條件）。
4. 大模型（原本的 PaliGemma 約 2.7GB）一次載入就失敗了（`unaligned accesses`），所以從清單移除；之後想加更大的模型，要先在真實機器上載得起來再登記。
5. 中文：這些模型輸出英文；LLaVA-Interleave（Qwen 基底）理論上能處理中文提示，但沒有驗證。

## 8. 抽象的 vision API 與看圖的優先順序（2026-10-06）

所有「看圖」都走同一層 `_visionDescribe`：Python 腳本的 openai／anthropic 圖片訊息、`fa_llm.vision_describe`、`interpret_image` 工具、離線路由。後端優先順序由設定 `visionBackendPolicy` 決定：`llm-first`（預設，線上視覺模型優先；**沒有可用的模型或全部失敗就退離線模型**）、`offline-first`、`llm`、`offline`。離線當備援時只用**已經下載**的模型，不會偷偷下載；離線排第一才會問使用者要不要下載。失敗訊息帶 `attempts`（每個後端試了什麼、為什麼失敗）。

**提示詞格式在這一層解決**：呼叫端只給自然語言（中英文都行）；`FaVlm.inferTask` 判斷是 OCR、描述、列物件、簡短描述還是問問題，`FaVlm.pickModel` 挑模型（預設模型不能問問題就改用已下載的對話式模型），`FaVlm.buildTask` 轉成各模型自己的格式（Florence-2 的 `<OCR>`、PaliGemma 的 `ocr`、對話式模型的完整句子）。

驗證（打包版 Electron，用假的線上與離線後端）：四種優先順序與備援各種組合、`interpret_image` 在沒有可用視覺模型時改用離線、**真的用 Pyodide 跑 Python 腳本**——`fa_llm.vision_describe` 與 OpenAI 圖片訊息在沒有線上視覺模型時都走到離線（回傳 `model:"offline:florence-2-base-ft"`、`x_vision` 診斷欄位）。純函式：`vlm_core.test.js` 49 項。移植到 redmine 見 `DESIGN.offline-vision-portability.md`。
