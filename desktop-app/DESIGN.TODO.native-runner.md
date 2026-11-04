# 原生推論執行器（native runner）調查與設計草案

狀態：唯讀調查，未改任何程式、未下載、未安裝。
範圍：桌面版（Electron）離線小模型能否改由主程序／子程序的原生推論執行，而不是在渲染程序用網頁版 onnxruntime-web。

標記說明：「本專案實測」＝程式碼或指令在本專案實際看過；「推測」＝沒有本專案量測；「外部資料」＝引用外部說法，沒有在本專案驗證。

---

## 1. 現況盤點

### 1.1 各離線模型目前怎麼跑

所有離線推論都在渲染程序（renderer）的 JavaScript 裡跑，使用 WebAssembly 或 WebGPU。主程序（main.js）沒有任何推論程式。

| 功能 | 執行方式 | 位置（本專案實測） |
|---|---|---|
| 文字 LLM 小模型（qwen3-0.6b 等，經 vlm_core） | Transformers.js 包 onnxruntime-web，依 `resolveDevice` 排序 webgpu → wasm | `renderer/src/vlm/vlm_core.js` 79–92 行；`floating-assistant.js` 約 99628–99686 行（`_vlmRpc('load', …)`，`libUrl` 指向 `transformersJsWebGpu`／`transformersJs`） |
| 本機文字生成（另一組 onnx 路徑） | `ort.webgpu.min.mjs`，`executionProviders:[ep]` | `floating-assistant.js` 約 76785–76790 行 |
| 本機影像生成 SDXS＋TAESD | onnxruntime-web 1.22.0，從 jsdelivr 載入，WebGPU 或 WASM 二選一 | `floating-assistant.js` 18082–18174（後端選擇）、76865–76870（session 建立） |
| 作曲模型 midigenai v5（GPU 4 位元／CPU 8 位元兩檔） | onnxruntime-web；`preferredOutputLocation` 要求 proxy 關閉 | `floating-assistant.js` 34804–34834（MANIFEST）、75338–75352（載入） |
| 語音辨識 Whisper | Transformers.js，deviceOrder `['webgpu','wasm']` | `floating-assistant.js` 63465–63481、74768–74782 |
| 音訊／音樂（basic-pitch、Demucs 等） | onnxruntime-web；Demucs 圖形最佳化關閉（註解說明 wasm 與 webgpu 會失敗） | `floating-assistant.js` 35181–35207；`renderer/src/music/basic_pitch.js`、`audio_pipeline.js` |
| 聲音複製 MOSS-TTS-Nano | 瀏覽器端 worker（`mossworker.js`，web-lazy 分塊） | `web-lazy/chunks/mossworker.js`（本次未細讀） |
| 圖像轉文字（vlm） | 同 vlm_core | 同上 |

ORT 全域設定的關鍵點（本專案實測）：
- `loadOrt`（`floating-assistant.js` 35187）設定 `env.wasm.proxy`、`env.wasm.numThreads`。`numThreads` 只有在 `crossOriginIsolated === true` 時才大於 1，否則固定為 1。
- 同一個網址的 ort 實例全域共用，`proxy` 開與關會互相影響（35183 行註解）。
- 這代表：如果桌面版渲染程序不是跨來源隔離狀態，WASM 會是單執行緒。這一點可能是 CPU 很慢的主因，**需要先驗證**（見第 4 節第 0 步）。

### 1.2 主程序已有的子程序與原生能力（本專案實測）

- `main.js` 第 34 行引入 `child_process`（`execFile`、`spawn`），第 1003 行有 `execFileSync`，第 1084 行 `runShellCommand` 用 `spawn` 執行使用者要求的 shell 指令（子代理用，不是推論）。
- 第 1763 行有一個 `spawn(..., {detached:true}).unref()`，用於啟動較新的安裝檔（更新用）。
- 沒有 `utilityProcess`、沒有 `worker_threads`、沒有 `fork`。
- `main.js` 1818–1832 行的註解提到 COOP／COEP 標頭與 `crossOriginIsolated`，表示這個問題有人注意過，但文中寫到「目前這樣還不足以讓 spawn 真正動起來」。**COOP／COEP 目前實際設定沒有確認**，需要驗證。
- `package.json` 的 dependencies 只有 `terser`（devDependencies：electron ^44.4.0、electron-builder ^24.13.3、terser）。**沒有 `onnxruntime-node`、`node-llama-cpp` 或任何原生推論套件。**
- `package-lock.json` 中沒有 onnxruntime-node。

### 1.3 打包（本專案實測）

- electron-builder 設定：`files` 包含 `*.js`、`renderer/**/*`、`build/icon.png`、`builtin-secrets.json` 等；`"asar": true`；`afterPack: build/afterPack.js`。
- 目標：Windows `dir` 與 `nsis`（x64）；Linux `AppImage`（x64）。沒有 Mac 目標。
- 目前沒有任何 `.node` 原生模組，所以沒有 `asarUnpack` 設定。
- 若加入 onnxruntime-node：它的預先編譯二進位（`.node` 與 DLL）**必須放在 asar 外**，要加 `asarUnpack`；Windows 版與 Linux 版二進位不同，build 要按平台分開。（外部資料：onnxruntime-node 內含 `onnxruntime_binding.node` 與 onnxruntime 共享函式庫，DirectML 版另外有 `DirectML.dll`。本專案未驗證。）

---

## 2. 候選方案比較

「速度提升」一欄全部是**推測**，除非另外標明。本專案尚未量測任何原生路徑。

### a) 主程序直接載入 `onnxruntime-node`（原生 CPU）

- 做法：主程序 `require('onnxruntime-node')`，在主程序跑 `InferenceSession.create`；渲染程序用 IPC 送輸入、收輸出。
- 速度：推測比 WASM 單執行緒快數倍，原因是原生執行緒與 SIMD 實作較完整（外部資料說法，未在本專案驗證）。主程序會被推論佔用，需要搭配 b）。
- 打包大小：推測增加數十 MB（onnxruntime 原生函式庫），需要 asarUnpack。
- 跨平台：Windows x64、Linux x64 有預先編譯版（外部資料）；Mac 版本需要另外確認（本專案目標沒有 Mac）。
- 授權：onnxruntime 為 MIT（外部資料）。模型授權另外看（midigenai 授權已在程式中標示「未確認」）。
- 整合難度：中。要新增 IPC 協定，並改寫各功能的 `ort` 呼叫點（至少 vlm_core、SDXS、midigenai、音訊）。注意 Transformers.js 的 vlm、Whisper 不是直接用 onnxruntime API，要另外評估能不能換後端。
- 對網頁版的影響：網頁版沒有主程序，`require('onnxruntime-node')` 不存在，**必須保留現有 onnxruntime-web 路徑**，由後端選擇器判斷「有沒有原生後端」。

### b) 獨立子程序（utilityProcess 或 child_process）跑 onnxruntime-node

- 做法：`utilityProcess.fork` 或 `child_process.fork` 啟動一個子程序，裡面跑 onnxruntime-node；溝通用 `MessagePort`（utilityProcess 支援）或本機 loopback 連接埠。
- 速度：與 a) 相同的推論速度；額外好處是主程序與推論互不阻塞，崩潰也不會拖垮主程序。
- 打包大小：與 a) 相同。
- 跨平台：與 a) 相同。`utilityProcess` 是 Electron 內建（推測，需確認 Electron 44 的 API 名稱與行為）。
- 整合難度：中高。需要生命週期管理（見第 3 節）。
- 對網頁版的影響：同 a)，網頁版不啟動子程序。
- 建議：**若要做原生路徑，優先選 b)**，理由是可取消、可逾時、崩潰可重啟，主程序穩定。

### c) llama.cpp 或 node-llama-cpp（GGUF 格式）

- 做法：用 `node-llama-cpp` 載入 GGUF 格式的 qwen 系列模型，在子程序中跑。
- 速度：對 LLM 生成通常比 WASM 快，尤其是 CPU 上有 AVX2／AVX-512 的情況（外部資料，未驗證）。
- 打包大小：推測 100 MB 以上（含預先編譯的 llama 函式庫）；模型檔是 GGUF，**需要重新下載**，現有 onnx 檔不能用。
- 跨平台：node-llama-cpp 提供 Windows、Linux、Mac 預先編譯（外部資料）。
- 授權：llama.cpp 為 MIT（外部資料）；各模型授權另外看。
- 整合難度：高。換格式等於換一條模型管線，現有 vlm_core 的 onnx 模型表要重做。
- 對網頁版的影響：網頁版保留 onnx 路徑；GGUF 只在桌面版使用，兩份模型都要管理，會增加快取與磁碟使用。
- 注意：使用者要求的是「現有 onnx 模型」，這個方案會改變模型格式，需要使用者決定（見第 5 節）。

### d) Windows 的 DirectML／系統內建 NPU 路徑

- 做法：onnxruntime-node 的 DirectML 執行提供者（execution provider），在 Windows 上透過 DirectX 12 使用 GPU 或 NPU；或使用 Windows ML 的系統提供者。
- 速度：推測對有獨立顯示卡的機器明顯快於 CPU；對純 CPU 機器沒有幫助。NPU 是否可用取決於硬體與驅動（外部資料，未驗證）。
- 打包大小：DirectML.dll 約數 MB 到十幾 MB（外部資料）。
- 跨平台：只限 Windows。Linux 與 Mac 要用其他提供者。
- 授權：DirectML 有 Microsoft 授權條款，需要另外查（未確認）。
- 整合難度：中。是 a)／b) 的延伸，只換執行提供者。
- 對網頁版的影響：網頁版的 WebGPU 路徑已經有 GPU 加速，所以 DirectML 主要是補桌面版的 CPU 機器與 WebGPU 不可用的情況。

### 建議排序（推測，待量測）

1. **先做第 4 節第 0 步**：驗證 WASM 是否單執行緒（`crossOriginIsolated`、COOP／COEP 實際值）。這是零打包成本的可能解法，可能就解釋了大部分的慢。
2. 若第 0 步後仍慢：做 b)（子程序＋onnxruntime-node），再視 Windows 硬體加上 d)。
3. c) 只在使用者同意換 GGUF 格式時才考慮。

---

## 3. 設計草案

### 3.1 統一的推論後端介面

- 後端順序：原生子程序（onnxruntime-node）→ WebGPU（渲染程序）→ WASM（渲染程序）。
- 自動測試：啟動時對每個後端跑一次固定的小題目（假輸入，固定種子），記錄成功與耗時，結果存入設定。
- 沿用現有 `resolveDevice`（vlm_core.js 79 行）與 `_omDevicePrefOf`（偏好設定），**不另立一套**。原生後端只是 `resolveDevice` 的新選項，例如 `'native'`，排在 `'webgpu'` 前面。
- 介面草案（只寫形狀，不寫實作）：
  - `backend.available()` → `{ok, reason}`
  - `backend.load(modelSpec, {onProgress})` → `session`
  - `session.run(inputs, {signal, timeoutMs, onToken})` → 輸出（或串流 token）
  - `session.dispose()`

### 3.2 子程序生命週期

- 懶啟動：第一次要推論時才啟動子程序，不在 app 啟動時啟動。
- 閒置關閉：超過設定的閒置時間（建議預設 5 分鐘，待定）就結束子程序，釋放記憶體。
- 崩潰重啟：子程序意外結束時，主程序記錄原因（退出碼、signal、最後一則錯誤訊息），自動重啟一次；連續失敗兩次就停用原生後端並退回 WebGPU／WASM，並告訴使用者實際原因。
- 取消：每次推論有 `signal`，取消時送出中止訊號；子程序收到後停止生成並回傳 `cancelled`。
- 逾時：每次推論有 `timeoutMs`，逾時回傳 `timeout` 並視為失敗，會觸發第 3.2 節的重啟邏輯。
- 串流 token 回傳：子程序每生成一個 token 就用 `MessagePort`（或 loopback）送給渲染程序；渲染程序收到後轉成現有的串流介面。
- 通訊協定：所有訊息都有 `id`、`type`（`load`／`run`／`cancel`／`dispose`）、`payload`；回應有 `id`、`ok`、`error`（含 HTTP 式的具體原因，依使用者偏好要有真實診斷資訊）。

### 3.3 模型檔共用現有快取

- 現有模型快取位置（渲染程序的 IndexedDB 或 Cache Storage）無法被子程序直接讀取。
- 方案：渲染程序負責下載，把檔案位元組經 IPC 傳給子程序；或子程序直接讀 Electron 的使用者資料目錄，**兩個快取指向同一個檔案**，避免重複下載。
- 需要驗證：onnxruntime-node 是否能直接讀路徑（應該可以，推測）；大檔經 IPC 傳輸的成本（推測：很大的檔案應改用路徑傳遞，不經 IPC）。
- 不重複下載：子程序只收檔案路徑，不收位元組，除非快取不可用。

### 3.4 進度回報

- 下載進度：沿用現有 `_vlmProgressAgg` 與 `FaAudioModels` 的進度格式。
- 載入進度：子程序回報 `load` 階段（讀檔、建立 session、最佳化）。
- 推論進度：每個 token 或每個分段回報一次，格式與現有 `log(…)` 相同。

### 3.5 設定位置

- 與現有裝置偏好同一處：`_omDevicePrefOf`、`localDevice`（auto／webgpu／cpu）。新增一個值 `native`，或新增獨立的布林值 `nativeRunner`（待決定，見第 5 節）。
- 網頁版不顯示這個選項。

---

## 4. 驗證計畫

### 第 0 步（最便宜，不需要任何下載）

1. 在桌面版開發者工具執行 `crossOriginIsolated` 與 `navigator.hardwareConcurrency`，記錄結果。
2. 若 `crossOriginIsolated === false`，WASM 會是單執行緒。這時候比較原生路徑之前，先確認 COOP／COEP 設定（`main.js` 1818–1832 附近）能否讓 WASM 多執行緒，**這不需要任何新套件**。
3. 用同一個假題目，記錄單執行緒與多執行緒各自的耗時。

### 第 1 步：小題目量測（原生與網頁版）

- 假題目：固定輸入（例如固定 prompt 的 token 序列），固定種子，生成 32 個 token。
- 每個後端跑 3 次，取中位數；逐題輸出進度（每題開始、結束、耗時）。
- 量測項目：首 token 延遲、每秒 token 數、峰值記憶體、崩潰次數。
- 比較對象：WASM 單執行緒、WASM 多執行緒（若第 0 步可行）、WebGPU、onnxruntime-node CPU、onnxruntime-node DirectML（若有 Windows 獨立顯示卡）。

### 需要下載或安裝的東西（逐項列出，**全部需先問使用者**）

| 項目 | 來源 | 大小（推測） | 用途 |
|---|---|---|---|
| `onnxruntime-node`（npm 套件） | npm registry | 約數十 MB（含平台二進位，推測） | 原生 CPU 後端 |
| `onnxruntime-node` 的 DirectML 版本 | npm 或 Microsoft（需確認） | 約十幾 MB（推測） | Windows GPU／NPU 後端 |
| `node-llama-cpp`（若採方案 c） | npm | 推測 100 MB 以上 | GGUF 後端 |
| GGUF 模型檔（若採方案 c） | Hugging Face（來源需確認） | 依模型大小，0.6B 約數百 MB（推測） | 換格式用 |
| 量測用假題目 | 本專案產生 | 極小 | 不需下載 |

目前 onnx 模型檔的大小已在程式中記錄（例如 midigenai 的 GPU 版 73 MB、CPU 版 114 MB，見 `floating-assistant.js` 34834 行），不需要新下載。

---

## 5. 風險與要問使用者的決定

以下決定由使用者做，不由調查者決定：

1. **要不要先做第 0 步**（驗證 WASM 單執行緒與 COOP／COEP）？這一步不加任何套件，建議先做。
2. **要不要加入 onnxruntime-node**（會增加打包大小，且需要 asarUnpack 與按平台分包）？
3. **要不要接受 GGUF 格式**（方案 c），等於重新下載模型並維護兩套格式？
4. **原生路徑只做 Windows，還是也要 Linux**？Mac 目前沒有打包目標。
5. **閒置多久關閉子程序**（建議預設 5 分鐘，待定）？
6. **原生路徑失敗時，是否要自動退回 WebGPU／WASM**（建議是，並告訴使用者真實原因）？
7. **模型授權**：midigenai 的訓練資料授權程式中標示「未確認」，若要在原生路徑擴大使用，是否先確認？

風險：
- 原生套件的預先編譯二進位若放錯位置（在 asar 內）會在使用者機器上找不到，需要實際打包測試。
- 子程序 IPC 的大檔案傳輸會慢，應改用路徑傳遞。
- 同時有多個子程序（例如文字模型與音訊模型）會佔用大量記憶體，需要限制同時載入數量。
- 網頁版必須保留原路徑，原生路徑只是桌面版的附加選項，任何改動都要確認網頁版不受影響。
- `floating-assistant.js` 內有嵌入來源模組的情況（記錄於使用者記憶），改動要改來源模組，不是只改嵌入的那一份。

---

## 6. 本次調查的限制

- 未讀取 `vlm_core.js` 全文，只讀了 `resolveDevice`。
- 未讀取 `web-lazy/chunks/mossworker.js` 與 `floating-assistant.js` 的大部分，只用 Grep 找到呼叫點。
- 未量測任何速度，所有速度數字都是推測。
- 未檢查 Electron 44 的 `utilityProcess` 實際 API，需要在實作前確認。

---

## 第 0 步實測結果

量測腳本：`scripts/eval/wasm_threads.eval.js`，用真 Electron（`scripts/eval/run_eval.js`，獨立使用者資料夾、換埠），不下載任何模型。

**真量測（本機、file:// 載入桌面版頁面）：**

| 項目 | 結果 |
|---|---|
| 頁面協定 | `file:` |
| `crossOriginIsolated` | `false` |
| `navigator.hardwareConcurrency` | `4` |
| `typeof SharedArrayBuffer` | `function`（存在，但因非隔離狀態不能用於多執行緒 WASM） |
| 工作者（Worker，Blob 來源）內 `crossOriginIsolated` | `false`，`SharedArrayBuffer` 為 `function` |
| `navigator.gpu` 是否存在 | 存在（只量到物件存在，未驗證能否取得 adapter） |
| `loadOrt({})` 之後 `ort.env.wasm.numThreads` | `1` |
| `loadOrt({})` 之後 `ort.env.wasm.proxy` | `true` |
| `loadOrt({proxy:false})` 之後 `numThreads` / `proxy` | `1` / `false` |
| ORT 版本 | onnxruntime-web `1.22.0`（common、web 皆同） |
| `wasmPaths` | `https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/` |

結論（真量測）：這台機器上桌面版頁面不是跨來源隔離狀態，`loadOrt` 因此把 `numThreads` 設為 1，WASM 是單執行緒。這跟第 1.1 節的推測一致，**單執行緒已確認**。

**推測（未直接量到）：**

- 單執行緒是 CPU 很慢的主因之一（推測；需要以同一題比較單執行緒與多執行緒的耗時才能確認）。
- `main.js` 1818–1832 行設定的 COOP／COEP 標頭，在 `file://` 下仍未讓頁面變成隔離狀態（與該處註解的實測一致；本次未檢查標頭是否真的送出，只量到結果）。
- Transformers.js（vlm 用）內部是否也用 `numThreads` 同一組設定，本次未量測；推測它沿用同一個全域 ORT 實例，所以同樣是 1 執行緒。

**若要啟用多執行緒，最小改動建議（只建議，本次未改）：**

1. 先解決隔離狀態：改用自訂 `protocol.handle()` scheme 或本機 HTTP server＋`loadURL`，讓頁面以 http(s) 來源載入（與 `main.js` 1818–1832 註解提到的方向相同）。這是影響開機流程的架構層改動，需要使用者決定。
2. 驗證條件：`crossOriginIsolated === true` 後，`loadOrt` 會自動設 `numThreads = min(4, hardwareConcurrency)`，不需要改 `loadOrt`。
3. 預期影響（推測，未量測）：WASM 矩陣運算可能加速，但 4 執行緒通常不會到 4 倍；記憶體會增加（每個執行緒各有一份 WASM 堆疊）；`file://` 改為自訂 scheme 後，網頁版路徑與現有快取行為要重新確認。
