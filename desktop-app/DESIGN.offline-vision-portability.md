# 離線視覺模型：模型管理、轉接、工具設計 — 移植到 宿主專案 AI 聊天的設計指南

> 狀態：2026-10-06。給「要把這套離線看圖能力植入 宿主專案 AI 聊天」的人看。
> 先講限制：這個版本庫裡沒有 宿主專案 的程式碼，我沒有在 宿主專案 上跑過任何一步；下面的「host 要實作的介面」是依本專案的接口寫的契約。實際行為驗證狀態見第 10 節（Florence-2 已在一台真實機器上完成下載與載入，**真實推論還沒有被驗證**）。
> 相關：`DESIGN.offline-vision.md`（這個能力本身的設計與測試）、`DESIGN.knowledge-portability.md`（知識引擎的移植，做法一致）、`DESIGN.python-api-bridge.md`。

## 1. 先看結論：分五層，只有最後兩層要重寫

| 層 | 內容 | 檔案 | 搬過去要做什麼 |
|---|---|---|---|
| L0 純邏輯 | 模型登記表、裝置與執行緒決策、**自然語言提示詞 → 任務 → 各模型自己的提示詞格式**、結果整理、挑模型、後端優先順序、快取用量計算 | `renderer/src/vlm/vlm_core.js`（`FaVlm`，UMD，49 項單元測試 `vlm_core.test.js`） | 原樣使用，不改 |
| L1 Worker | transformers.js 的載入、模型下載、前處理、推論（獨立執行緒，主執行緒不卡） | `floating-assistant.js` 裡的 `faVlmWorkerMain()`（一個自給自足的函式，轉成字串建 Blob Worker） | 原樣複製（或抽成獨立 `.js` 檔，用 `new Worker(url,{type:'module'})`） |
| L2 執行時 | Worker 的 RPC、裝置降級（GPU→CPU）、閒置卸載、進度彙整、`_imageToText` 流程 | `_vlmWorkerGet/_vlmRpc/_vlmEnsureLoaded/_imageToText` | 照第 4 節的契約重寫成 宿主專案 前端的一個物件 |
| L3 模型管理 | Cache API 用量與刪除、下載前確認、設定頁 | `_omUsage/_omDeleteModel/_omPreload/_omRenderPane…` | 重寫（UI 與設定儲存是 宿主專案 的） |
| L4 抽象 vision API 與工具 | `_visionDescribe`（依設定的優先順序＋備援）、Python 橋接、`image_to_text`／`interpret_image` 工具 | `_visionDescribe/_pyBridgeVisionComplete/…`、`registerOptional('image_to_text'…)` | 照第 5～7 節的契約重寫，**工具參數 schema 與說明文字照抄** |

「一致」靠：同一份 L0 與 L1、釘版本（commit SHA）、同一組測試、第 10 節的真實環境驗證清單。

## 2. 整體資料流

```
呼叫端（任何工具／腳本／AI）── 自然語言提示詞 + 圖片 ──►  抽象 vision API  _visionDescribe(spec)
                                                          │  依設定 visionBackendPolicy 決定順序
                          ┌───────────────────────────────┴───────────────────────────────┐
                          ▼ 線上視覺模型（宿主專案 原本的 LLM 呼叫，spec.runLlm）          ▼ 離線模型
                    成功 → 回傳                                                  inferTask(prompt)  → 任務
                    沒有可用模型／全部失敗 → 退離線                                pickModel(任務…)   → 模型
                                                                                buildTask(模型,任務) → 該模型自己的提示詞格式
                                                                                _imageToText → Worker（下載／載入／推論，GPU 失敗降級 CPU）
```

**提示詞格式在抽象層解決**：呼叫端只給一般的自然語言（「請辨識圖裡的文字」「How many cats?」），不需要知道 Florence-2 要 `<OCR>`、PaliGemma 要 `ocr`、對話式模型要完整句子。`FaVlm.inferTask`＋`pickModel`＋`buildTask` 這三個純函式負責，宿主專案 只要呼叫、不要自己再寫一份規則。

## 3. 設定（宿主專案 要存的欄位）

| 鍵 | 值 | 預設 | 說明 |
|---|---|---|---|
| `offlineDevicePreference` | `gpu`／`cpu` | `gpu` | 偏好 GPU，**不支援一律降級 CPU**（沒有 WebGPU、顯示卡不支援 `shader-f16`、載入或推論失敗都降級）；只能用 GPU 的模型（PaliGemma）不降級，直接拒絕 |
| `offlineMaxCpuCores` | 整數，0＝不限制 | 0 | CPU 路徑請求的執行緒數上限（實際值還要看環境能不能多執行緒，見第 8 節） |
| `imageToTextModel` | 模型 id | `florence-2-base-ft` | 預設的圖像模型 |
| `visionBackendPolicy` | `llm-first`／`offline-first`／`llm`／`offline` | `llm-first` | 看圖的後端優先順序（第 6 節） |

存放位置是 宿主專案 的決定：個人偏好（每個使用者自己的瀏覽器與 GPU 不同）建議存使用者層級；管理員可以另外提供「允許使用離線模型」的專案或全站開關與模型白名單。

## 4. L1／L2：Worker 協定與執行時契約

### 4.1 Worker 訊息（`faVlmWorkerMain`，host 無關）

主執行緒 → Worker：

| `type` | 欄位 | 說明 |
|---|---|---|
| `load` | `tid`、`libUrl`（transformers.js ESM 網址）、`modelId`、`arch`、`repo`、`processorRepo?`、`dtype`（依裝置挑好的組合）、`device`（`webgpu`／`wasm`）、`threads` | 載入函式庫＋下載並建立模型；會先卸載目前的模型 |
| `run` | `tid`、`image`（Blob）、`prompt`（**已經是該模型自己的格式**，由 `buildTask` 產生）、`maxTokens` | 推論一張圖 |
| `dispose` | `tid` | 釋放模型 |

Worker → 主執行緒：`progress`（`p:{status,file,progress,loaded,total}`，transformers.js 的下載進度）、`loaded`、`result`（`raw`，`ms`）、`disposed`、`error`（`error` 字串；ORT 有時丟的是數字，Worker 會轉成可讀訊息）。

規則：一次只做一件事（以 `tid` 對應回覆）；Worker 重複使用，**閒置 5 分鐘就結束 Worker**（釋放記憶體與顯示記憶體）；Worker 崩潰要把所有等待中的請求 reject 並把 Worker 清掉。

### 4.2 決策順序（`_imageToText`）

1. 解析設定 → `FaVlm.resolveDevice(模型, 偏好, gpu.available, gpu.f16)` 得到嘗試順序（例如 `['webgpu','wasm']`）；空陣列＝這個模型這台機器不能用，直接回報原因。
2. 取得圖片（Blob）。**宿主專案：附件要用已登入的 session 取（`fetch(url,{credentials:'same-origin'})` 轉 Blob），不要把附件網址交給 Worker**。
3. 算要下載多少（`FaVlm.estimateDownload`＝登記大小−快取已有）。超過 20MB 且沒有 `confirmed`：**一定先問使用者**（來源、大小、可清除）；`fallback:true` 的呼叫（自動備援）**不會問也不會下載**，直接回報「還沒下載」。
4. `FaVlm.buildTask(模型, 任務, 提示詞)` → 該模型的提示詞格式與降級說明。
5. 依順序載入（失敗就下一個裝置）→ 推論；**推論失敗且是 GPU → 卸載並用 CPU 重試一次**。結果標 `device`、`fell_back_from_gpu`、`ms`、`note`。
6. `FaVlm.formatResult` 整理成文字；排閒置卸載。

載入函式庫的網址：**先直接連 CDN（或 宿主專案 自己託管的路徑），proxy 網址當第二選擇**——本專案踩過：Worker 動態載入自訂協定（`fa-local://`）的模組會失敗。

## 5. L4：抽象 vision API（`_visionDescribe`）

```
_visionDescribe(spec) → { ok, backend:'llm'|'offline', llm?, text?, model?, task?, device?, note?, policy, attempts:[{backend, ok, error?}] }
spec = { images: [dataURL|Blob], prompt: 自然語言, runLlm: async () => 線上視覺的原始回傳, max_tokens?, policy? }
```

- **`runLlm` 由呼叫端提供**（宿主專案 原本呼叫視覺 LLM 的那條路）——抽象層不知道 LLM 怎麼呼叫，只知道「它成功或丟例外」。
- 離線排**第一**（`offline-first`／`offline`）才可以問使用者下載；離線當**備援**時一律只用已下載的模型。
- 失敗訊息帶 `attempts`（每個後端試了什麼、為什麼失敗）——這是診斷資訊，**要原樣回給使用者與 AI，不要只回「失敗」**。
- 多張圖：離線模型一張一張處理，結果以「圖片 N：…」合併。

### 5.1 優先順序表（`FaVlm.VISION_POLICIES`）

| 設定 | 順序 | 使用情境 |
|---|---|---|
| `llm-first`（預設） | 線上 → 離線 | 沒有可用的視覺模型、或全部失敗時，**離線模型（已下載）自動接手** |
| `offline-first` | 離線 → 線上 | 隱私優先、省 token；離線失敗退線上 |
| `llm` | 只線上 | 不要離線模型 |
| `offline` | 只離線 | 內網不外連；圖片不離開瀏覽器 |

### 5.2 自然語言 → 任務（`FaVlm.inferTask`）

| 提示詞（中英文都認） | 任務 |
|---|---|
| 辨識文字、OCR、transcribe、read the text、圖裡寫什麼 | `ocr` |
| 列出物件、detect/list objects | `objects` |
| 簡短、一句話、caption | `caption` |
| 描述、describe、what's in、有什麼、分析、解析 | `detailed` |
| 問句（?、how many、幾、是否、有沒有…） | `ask`（帶問題文字） |
| 空白 | `detailed` |

`pickModel(任務, 已下載清單, 預設模型, gpu)`：預設模型能做就用；不能（例如要問問題但預設是 Florence-2）就改用**已下載**而且能做的；都沒有就用預設並降級任務（`buildTask` 會在 `note` 說明「問題沒被使用」）。

## 6. 轉接（Python API 橋接）

- OpenAI 風格的 `chat.completions` 與 Anthropic 風格的 `messages`，圖片訊息都先被橋接層轉成 `{type:'image_url', image_url:{url}}`，經 `llm.complete` 進到 host。host 一發現訊息裡有圖片，就**不直接打線上 LLM，改走抽象 vision API**：從最後一則含圖片的使用者訊息取圖片，把所有（非 assistant）文字合併成提示詞，原本的線上路徑包成 `runLlm`。
- 回傳維持 OpenAI 形狀；走離線時 `model` 是 `offline:<模型>`，並多一個 `x_vision` 欄位（`backend`、`policy`、`attempts`、`model`、`task`、`device`、`note`）。腳本照原本讀 `choices[0].message.content` 就好，不用改。
- 另外提供直接呼叫：host op `vision.describe`（`{image: data URL, prompt, policy?, max_tokens?}` → `{text, backend, model, policy, attempts}`），Python 端 `fa_llm.vision_describe(image, prompt, policy=None)`／`avision_describe`（`image` 可以是 bytes、檔案路徑、data URL、http 網址）。
- 宿主專案 若沒有 Python 沙盒，這一層可以略過；抽象 vision API 本身（第 5 節）不依賴它。

## 7. 工具設計（給 LLM 的介面）

兩個工具，**職責分開**：

| 工具 | 誰用 | 行為 |
|---|---|---|
| `image_to_text` | 明確要離線處理、或線上視覺看不到時 | 一律走離線模型；參數：`task`（`caption`／`detailed`／`ocr`／`objects`／`ask`）、`image`（附件 id；省略＝這個對話最新的圖片附件，多張會問）、`prompt`、`model`、`device`、`max_tokens`。回傳 `{ok, text, model, device, threads, task, note, ms, fell_back_from_gpu?}` |
| `interpret_image`（宿主專案 若已有「看圖」工具就沿用它） | 一般看圖 | 改成呼叫抽象 vision API，依 `visionBackendPolicy` 決定線上／離線與備援；回傳加上 `backend`、`policy`、`attempts`、`note`（說明為什麼退離線） |

設計原則：
1. **工具說明裡明講限制**：離線輸出主要是英文（模型限制）；第一次要下載（會先問）；Florence-2 沒有自由問答。LLM 才不會亂用。
2. **參數只收登記表裡的模型 id**，不接受任意 repo 名稱（避免 AI 被誘導去下載來路不明的模型）；要加模型走設定頁或登記表。
3. 沒給圖片時用「最近一則附件」，多張就問，**不要猜**。
4. 斜線指令 `/image-to-text [描述|詳細|文字|物件|問 …]`：先貼圖再打、或先打指令再貼圖送出都要能動（附件帶進指令；沒有圖就等使用者貼圖，不用再打一次）。
5. 離線路由（若 宿主專案 有離線訓練器）：「解析這張圖」「圖片轉文字」「OCR」「辨識圖片裡的文字」直接走 `image_to_text`。

## 8. L3：離線模型管理（設定頁）

| 區塊 | 內容與行為 |
|---|---|
| 運算裝置 | 偏好 GPU／CPU 下拉；**WebGPU 偵測結果**（有沒有、顯示卡名稱、是否支援 `shader-f16`、沒有的原因）；CPU 核心上限；「請求幾個、實際幾個」與原因 |
| 看圖優先順序 | `visionBackendPolicy` 下拉＋說明 |
| 儲存空間 | 快取總用量、每個模型已下載量（依 URL 的 repo 分組：`https://huggingface.co/<owner>/<repo>/resolve/…`）、**下載**（先確認、顯示進度）、**設為預設**、**刪除**；非登記模型的快取可逐個 repo 刪除；**全部清除** |
| 試跑 | 選圖＋任務＋提示詞，直接跑預設模型，顯示文字、裝置、執行緒、秒數、是否降級 |

實作注意（都是踩過的）：
- **下載確認不要用會被設定視窗擋住的對話框**。本專案踩過：設定視窗開著時，聊天裡的確認對話框看不到，按鈕就一直停在「準備中」。設定視窗開著時用原生 `confirm()`；並且按下後立刻顯示「等待你的確認…」。
- 下載進度要有「進度卡片」（聊天裡）＋設定頁那一列的即時百分比；進度由 transformers.js 的 `progress_callback`（每個檔案的 `loaded/total`）彙整。
- 用量算法：Cache API 的每個 `Response` 用 `content-length`（沒有才讀 blob），純函式 `FaVlm.usageByModel(entries)` 負責分組。
- 刪除：`FaVlm.urlsOfModel(entries, 模型)` 取網址，`cache.delete(url)`；刪除正在使用的模型要先卸載 Worker。

## 9. 宿主專案 專屬要先決定的事

1. **模型下載來源**：預設從 `huggingface.co` 下載。**內網或封閉環境**：架一個 HF 鏡像，transformers.js 用 `env.remoteHost`／`env.remotePathTemplate` 指過去（`FaVlm.repoOfUrl` 目前只認 `huggingface.co` 的 URL，鏡像網址要擴充）；或預先把模型檔放到 宿主專案 的靜態路徑、用 `env.localModelPath`（且 `allowLocalModels = true`）。
2. **函式庫與 wasm 的來源**：預設從 jsDelivr 載入 transformers.js 與 ONNX Runtime 的 wasm。**CSP**：Worker 受頁面的 CSP 管，要允許 `worker-src blob:`，以及腳本來源（CDN 或自己託管的路徑）；內網建議把 transformers.js 與 wasm 檔**自己託管**在 宿主專案 的 `public/plugin_assets/…`，並設定 `env.backends.onnx.wasm.wasmPaths`。
3. **多執行緒**：ONNX Runtime 的 WASM 多執行緒只需要 `SharedArrayBuffer` 能用（**不是**非要 `crossOriginIsolated`——onnxruntime 自己檢查：SAB 存在、能傳給 Worker、WASM 執行緒指令可驗證，`FaVlm.resolveThreads`＋host 的偵測照這個）。瀏覽器只在頁面 cross-origin isolated 時開放 SAB（Electron 可以用旗標開）。宿主專案 是一般網頁，要取得隔離：伺服器回 `Cross-Origin-Opener-Policy: same-origin` 與 `Cross-Origin-Embedder-Policy: credentialless`（反向代理設標頭最乾淨），或像本專案網頁版那樣放一個 `coi-serviceworker.js`（credentialless 版）。⚠️ 隔離會影響整站：第三方 iframe、跨網域圖片／腳本、宿主專案 其他外掛可能壞掉——先在測試站驗證；做不到時設定頁會誠實顯示「實際 1 個執行緒」，WebGPU 路徑不受影響。
4. **圖片從哪來**：宿主專案 附件在伺服器、要帶登入 session 與 CSRF 才抓得到；`_vlmResolveImage` 要改成「附件 id → fetch → Blob」。圖片只在使用者的瀏覽器裡處理，**不會送到伺服器**（離線路徑）——這是賣點，要寫進說明。
5. **誰能用、誰能下載**：離線模型每個人下載自己一份（瀏覽器快取，上百 MB 到數 GB）；管理員可以提供開關、模型白名單、預設模型。
6. **設定與偏好的儲存**：個人層級（GPU 與核心數是每台機器不同的事）。
7. **瀏覽器相容**：WebGPU 需要新版 Chromium 系；Firefox／Safari 沒有 WebGPU 時一律 CPU；`credentialless` 在 Safari 不支援（拿不到隔離就單執行緒）。
8. **授權**：登記表有各模型授權欄位（Florence-2 MIT、SmolVLM Apache-2.0、LLaVA-Interleave 為 Tongyi Qianwen Research——**商用前要確認**）。

## 10. 驗證狀態與清單（先說清楚什麼被證實過）

**已在真實環境證實（本專案）**
- Worker 是獨立執行緒（dispose 往返十幾毫秒、載入壞掉的函式庫會得到錯誤而不是卡住）。
- 一台真實機器（使用者）上 **Florence-2 base 完成下載與載入**：9 個檔案、343MB，剛好是 GPU 版組合——代表 WebGPU 載入成功（沒有降級）。
- 設定頁、快取用量與刪除、裝置與核心數設定、偏好 GPU 失敗降級 CPU 的流程（用假的 Worker 回應驗證）、離線路由、抽象層的各種優先順序與備援（用假的後端驗證）。
- Worker 不能動態載入 `fa-local://` 的模組（已重現並修正：先直接連 CDN）；SAB 在桌面版頁面與 Worker 裡可用（共享記憶體、Atomics、WASM 執行緒指令都通過）。

**還沒證實**
- （已證實：Florence-2、ViT-GPT2、LLaVA-Interleave、SmolVLM 都跑過真實推論，見 `DESIGN.offline-vision.md` §7。）下面這段是當初的風險說明，仍可參考：載入成功不等於推論成功：dtype 組合在某些 GPU 上載得起來卻可能跑出亂碼（本專案的 Whisper 就遇過 WebGPU 路徑吐亂碼的先例）。第一次真實執行請用「試跑」，並且**比對 CPU 與 GPU 兩條路徑的輸出**。
- 多執行緒實際加速（只驗證了 onnxruntime 判斷多執行緒的條件，沒量過速度）。
- LLaVA-Interleave 已實測可跑（CPU 約 140～150 秒、Intel GPU 約 23 秒，社群轉檔缺 `processor_config.json`，處理器與分詞器改從原版 `llava-hf` repo 載入；提示詞用手組的 Qwen 對話格式）。**PaliGemma 2 已移除**：使用者機器上載入失敗（`unaligned accesses`）。
- 中文輸出品質（模型主要輸出英文）。

**移植到 宿主專案 後要自己驗的**
1. `node renderer/src/vlm/vlm_core.test.js` 全過（證明 L0 在新環境一致）。
2. 設定頁：WebGPU 偵測文字正確；改裝置與核心數後，下次載入才套用。
3. 沒下載過：呼叫 `image_to_text` 先問、取消就不跑；`llm-first` 備援時**不下載**並說明。
4. 用一台沒有 WebGPU 的機器：偏好 GPU 也走 CPU，只能 GPU 的模型被拒絕並說明原因。
5. 故意讓線上視覺失敗：`llm-first` 自動退離線（已下載時）；`attempts` 有寫清楚為什麼。
6. 兩個 CPU／GPU 路徑對同一張圖的輸出都合理。
7. 刪除模型後用量歸零；全部清除後再用要重新下載。
8. 頁面 CSP 與跨網域隔離（若啟用）下，整站其他功能沒壞。

## 11. 移植步驟（每步有檢查點）

1. 複製 `renderer/src/vlm/vlm_core.js` 與 `vlm_core.test.js`，跑測試。
2. 複製 `faVlmWorkerMain`，在 宿主專案 前端用 Blob（或自己託管的檔案）建 Worker；先只測 `dispose` 往返與「載入壞的函式庫會回報錯誤」。
3. 寫 L2（RPC、`_vlmEnsureLoaded` 的裝置降級、閒置卸載），用假 Worker 回應跑流程測試；再用 Florence-2 做一次真實載入（會下載約 208～344MB）。
4. 寫 L3 設定頁與用量（Cache API）。
5. 寫抽象 vision API 與 `image_to_text`；再把 宿主專案 現有的看圖工具接上 `runLlm`。
6. （可選）Python 橋接。
7. 做第 10 節的驗證清單；有 CSP／隔離問題先解，再談效能。

## 12. 改動規則（避免兩邊分叉）

1. 只在這個版本庫改 `vlm_core.js` 與 `faVlmWorkerMain`，宿主專案 引用它們（釘 commit SHA）。需要的修改回到這邊做、跑測試、再更新釘住的版本。
2. 新增模型 ＝ 只在登記表加一筆（`id`、`repo`、`arch`、`dtype`、`bytes`、`tasks`、`verified:false` …）；新的 `arch` 才需要改 Worker。**新模型一律標 `verified:false`，真實推論驗證過才改 `true`（並填 `verifiedOn` 與 `measured`）**；載不起來的模型不要留在清單裡（PaliGemma 的前例）。對話式模型要用 `FaVlm.generationParams` 的重複懲罰，否則小模型會陷入重複迴圈（SmolVLM 的前例）。移植時這兩個函式與 `defaultMaxTokens` 要一起帶走。
3. 改優先順序、任務判斷、挑模型的規則，一定同步補 `vlm_core.test.js`（它是兩邊行為一致的合約）。
4. 登記表的大小是「依 HuggingFace 檔案清單讀來的估計」，不是量測值；模型更新檔案後要重算。
