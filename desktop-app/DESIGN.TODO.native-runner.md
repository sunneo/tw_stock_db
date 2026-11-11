# 原生推論執行器（native runner）設計與進度

狀態：實作中（2026-11-04）。這份文件是唯一的設計來源；每階段完成後在「進度」節更新。
標記：「實測」＝真 Electron 或真程式跑過；「推測」＝沒有量測；「外部資料」＝外部說法，本專案未驗證。

## 0. 共識（must，不可違反）

1. **只用標準輸入輸出（stdin/stdout，一行一則 JSON）加進度檔 `progress.jsonl`** 做主程序與子程序溝通。不走網路通道，不做常駐服務。
1a. **設計定稿後直接實作**，不停在設計文件；每階段做完跑測試與真 Electron 評估後提交。
2. **Windows 與 Linux 都要有實作、測試與評估**，不是先做 Windows 再說。Mac 先不列為必須，但程式不寫死只能 Windows／Linux 的判斷。
3. **不要求重新安裝安裝包**（熱更新鐵則）。原生執行包按需下載到使用者資料夾，不進安裝包。
4. **按需下載**：下載任何檔案前，顯示檔名、來源、大小，取得使用者同意（沿用離線模型下載的同意流程與進度顯示）。
5. **不用 Python**（使用者機器不一定有）。子程序用應用程式自己的執行檔加 `ELECTRON_RUN_AS_NODE=1` 當 Node 啟動。
6. **沒下載或載入失敗時自動退回 WebGPU／WASM**，行為不變，並顯示實際使用的後端與真實失敗原因。
7. **GGUF 是平行路線，之後再考慮，現在不實作**（見第 6 節）。現在只做 onnx 原生路線。
8. 凡是跑模型或吃效能的功能，先走桌面版原生路徑；網頁版維持原路徑當退路，不為了網頁版限制桌面版。

## 1. 現況（實測）

| 項目 | 結果 | 依據 |
|---|---|---|
| 頁面 `crossOriginIsolated` | `false`（file:// 載入） | 真 Electron：`scripts/eval/native_threads_baseline.eval.js` |
| 頁面 `postMessage(SharedArrayBuffer)` | 成功（Electron 啟動開關 `enable-features SharedArrayBuffer` 已開） | 同上 |
| 文字／看圖路徑執行緒 | `resolveThreads` 為 4（判斷不要求 crossOriginIsolated） | 同上；`renderer/src/floating-assistant.js` 的 `_omThreadSupport`、`_omCores` |
| 音訊路徑 `loadOrt` 執行緒（修正前） | 1 | 同上（階段 1 之前） |
| 音訊路徑 `loadOrt` 執行緒（修正後） | 4 | 階段 1 提交後的同一個評估 |
| 自訂協定 `fa-local://` | 已存在，`protocol.handle` 處理 `/proxy/` 等路由 | `main.js:188–189`、`main.js:2956` |
| `main.js` 載入頁面 | `loadFile()`（file://） | `main.js:1676`、`main.js:1855` |
| 主程序 COOP／COEP 標頭 | 已設（`onHeadersReceived`），但 file:// 下不生效 | `main.js:1837–1845` |

結論（實測）：文字與看圖（Qwen 等）路徑**已經多執行緒**；音訊路徑已在階段 1 修正。`crossOriginIsolated` 仍為 false，是否還要做到 true，取決於階段 1 的 COI 評估（第 3 節）。

## 2. 桌面版專屬優勢盤點（Grep 核對）

| 優勢 | 狀態 | 證據 |
|---|---|---|
| 主程序開子程序 | 已用（shell 指令）；推論用子程序：階段 3 新增（假引擎） | `main.js:34`；`native-runner/host.js` |
| 子程序 utilityProcess／worker_threads | 未用 | Grep 無結果 |
| 直接讀寫本機檔案 | 已用 | `main.js:94`、`103`、`147` |
| 不受網頁跨來源限制 | 已用（file://） | `main.js:1676` |
| SharedArrayBuffer 旗標 | 已用 | `main.js:29` |
| 自訂協定 fa-local | 已用 | `main.js:189`、`2956` |
| 原生推論套件 onnxruntime-node | 未用（階段 5 按需下載，需同意） | `package.json` 無此依賴 |
| 顯示卡原生路徑（DirectML、CUDA） | 未用（目前 WebGPU） | 專案內無 `onnxruntime-node` 引用 |
| 主程序取得真實記憶體與核心數 | 已用 | `main.js:586` `fa:system:info` |
| 麥克風與音訊裝置原生存取 | 未用（渲染程序 getUserMedia，與網頁相同） | Grep `systemPreferences`、`desktopCapturer` 無結果 |
| 模型快取放使用者資料夾 | 未用（目前 CacheStorage） | colu 階段 6 記錄 |

## 3. 階段計畫與進度

每階段都有：目標、要改的檔案與函式、步驟（每步可檢查）、驗收（Windows／Linux 各自怎麼驗）、不准做的事。

### 階段 1：WASM 多執行緒（零新套件）— 已部分完成

- 目標：音訊路徑與文字路徑都用多執行緒；評估 `crossOriginIsolated` 能否變 true（COI）。
- 步驟與狀態：
  1. 基準量測 — **已完成**（`scripts/eval/native_threads_baseline.eval.js`，真 Electron，不下載）。
  2. 音訊 `loadOrt` 改用 `ortThreadCount()`（與 `_omThreadSupport` 同規則） — **已完成**，提交 `96292810`。驗收：`scripts/music-tests/audio_runtime.test.js` 13 passed（含 SAB 多執行緒檢查）；真 Electron 音訊 numThreads 1→4。
  3. COI 評估（未做）：用 `fa-local://` 自訂協定讓頁面以非 file 來源載入，回應加 COOP／COEP 標頭，驗證 `crossOriginIsolated === true`，且 ORT（jsdelivr CDN）與 Transformers.js 模型來源在 `require-corp` 下仍能載入。驗收：真 Electron 評估列出每個 CDN 網址的載入結果；前後速度量測（固定題目）。
  4. 若 COI 做不到，階段 1 結束，多執行緒已由步驟 2 滿足，不再處理。
- 驗收（Windows）：本機真 Electron。驗收（Linux）：未在 Linux 實跑（本機沒有 Linux 環境）；改以程式碼審查加 `audio_runtime.test.js`（純 Node，平台無關）標示限制。
- 不准做：不手改嵌入副本（`floating-assistant.js` 內的模組，要改來源再 `node scripts/embed-code-ui.js` 與 `node build-assistant.js`）；不改 `web-lazy/` 產物；不碰未提交的無關檔案。

### 階段 2：統一推論後端介面 — 已完成

- 目標：後端順序「原生 → WebGPU → WASM」由一個函式決定；原生關閉時與舊行為完全相同。
- 檔案：`renderer/src/vlm/vlm_core.js` 的 `backendOrder`（約第 104 行起）；測試 `renderer/src/vlm/vlm_core.test.js`。
- 驗收：vlm_core 141 passed（含所有組合的等價性）；真 Electron `scripts/eval/backend_order.eval.js` PASS。
- 提交：`d92cf86a`。
- 尚未接線：`_vlmEnsureLoaded` 仍用 `resolveDevice`，接線在階段 5（原生 ORT）時做。

### 階段 3：子程序執行器與協定（零新套件，假引擎）— 已完成

- 目標：主程序能啟動、握手、取消、逾時、崩潰重啟（一次）、連續兩次崩潰停用、閒置關閉；進度寫入 `progress.jsonl`。
- 檔案：`native-runner/protocol.js`（協定，唯一定義）、`native-runner/child.js`（子程序，假引擎）、`native-runner/host.js`（主程序端）、`native-runner/ipc.js`（IPC）；`main.js` 一行註冊 IPC；`preload.js` 的 `desktopAPI.nativeRunner`；`package.json` 打包清單加 `native-runner/**/*.js`。
- 協定（stdin/stdout，一行一則 JSON，欄位定義見 `protocol.js` 的 `MESSAGES`）：`hello`／`hello_ack`（版本號 1）、`load`、`run`（含 `stream`）、`cancel`、`dispose`；子程序回 `progress`、`token`、`done`、`error`（`code` 只能是 `protocol.js` 的 `ERROR_CODES` 其中之一：`load_failed`、`oom`、`timeout`、`cancelled`、`internal`、`crashed`、`version_mismatch`）、`cancelled`。`native_disabled` 由主程序產生，不經過子程序。協定只有上述欄位，沒有其他通道。
- 換行與編碼：一則一行、結尾 `\n`；解碼時去掉行尾 `\r`（Windows 的 CRLF 相容）；兩端都以 UTF-8 讀寫。子程序的日誌只寫 stderr，stdout 只放協定訊息。
- 行程管理差異（階段 5 的真引擎要沿用）：
  - Windows：`child.kill()` 結束行程（不送訊號）；`windowsHide: true`；路徑用 `path.join`，`userData` 來自 `app.getPath`。
  - Linux：`child.kill()` 送 SIGTERM，寬限後 SIGKILL；`exit` 事件的 `signal` 欄位要記錄；`userData` 路徑同樣由 `app.getPath` 取得。
  - 兩平台都用 `ELECTRON_RUN_AS_NODE=1` 與 `process.execPath`，不靠系統的 node。
- 驗收：
  - Windows：`node native-runner/native_runner.test.js` 19 passed（含真子程序的懶啟動、閒置關閉、崩潰重啟、連續崩潰停用、取消、逾時、串流、進度檔在強制結束後仍存在、版本不符）；真 Electron `scripts/eval/native_runner.eval.js` PASS（需 `FA_DEBUG_NATIVE_FAKE=1`）。
  - Linux：**未在 Linux 實跑**。驗證方式：同一份 `native_runner.test.js` 在 Linux 以 `node` 執行（程式不含 Windows 專屬呼叫）；`kill` 的 SIGTERM／SIGKILL 行為由程式碼審查確認。實跑要等有 Linux 環境（或 WSL）後補。
- 提交：`9e4d9a68`（協定與執行器）；`14bbd6af`（撤回試作通道並加入設定頁區塊）。
- 撤回紀錄：階段 4 的通道試作（提交 `2f124973`）已於 `14bbd6af` 撤回，因為共識要求只用標準輸入輸出。

### 階段 4：設定與介面 — 已完成（區塊已接，後端開關待階段 5）

- 目標：離線設定頁顯示原生執行器狀態與按鈕；網頁版不顯示。
- 檔案：`renderer/src/floating-assistant.js` 的 `_omNativeBoxHtml`、`_omNativeRefresh`、`_omNativeAct`，以及 `_omWirePane` 的 click 分支。
- 驗收：真 Electron `scripts/eval/native_settings_ui.eval.js` PASS（完整 `_omRenderPane` 含區塊；狀態列；關閉子程序按鈕）。
- 提交：`14bbd6af`。
- 尚未做：「原生執行器」開關（預設關）與後端選擇的實際接線。

### 階段 5：原生執行包（onnxruntime-node，按需下載）— 尚未開始，需使用者同意

- 目標：子程序執行器載入 onnxruntime-node 跑 onnx 模型（SDXS、midigenai、Qwen 等，依 Transformers.js 能否換後端而定）。
- 做法：
  1. 執行包放 `userData/native-runtime/<版本>/`，不進安裝包。內容：onnxruntime-node 的原生檔，依平台與 CPU 架構選檔（Windows x64、Linux x64）。
  2. 下載：分檔、驗證 sha256、再合併；沿用 `main.js` 的 live-patch 分檔與驗證做法（`fetchLivePatchFile` 與 parts 機制）或同等做法。下載前顯示檔名、來源、大小，取得同意。
  3. 子程序以 `process.execPath` + `ELECTRON_RUN_AS_NODE=1` 執行 `child.js`，`child.js` 以絕對路徑 `require` 執行包內的 onnxruntime-node。
  4. 裝置選擇：Windows 有 DirectML 時用 DirectML，否則 CPU；Linux 有 CUDA 時用 CUDA，否則 CPU。沒有可用加速就退 CPU（不報錯）。
  5. 載入失敗、沒下載、或 `native_disabled`：退回 WebGPU／WASM，UI 顯示實際後端與失敗原因。
- 查證（外部資料，待實測）：
  - onnxruntime-node 使用 N-API（跨 Node 版本的 ABI 穩定介面），Electron 內建 Node 可載入（推測）；需在階段 5 用真 Electron 實測 Windows 與 Linux。
  - 套件大小：npm 中位資料 `onnxruntime-node` 最新 1.31.1 的 unpackedSize 約 307.6 MB（全平台合計，`npm view` 取得，未下載）；1.22.0 約 247 MB。單一平台的原生檔大小未知，**需先量測再請使用者同意**。
- 不要求重新安裝的限制（實測查證）：
  - `main.js` 的 live-patch 清單只收 `update-manifest.json` 裡頂層的 `*.js`（`main.js:91–97`），**子目錄 `native-runner/*.js` 不會被熱更新送達**。因此執行器檔案要用頂層名稱（例如 `native-runner-host.js`）並加入清單，或由 `main-ext.js` 載入。
  - **查證（2026-11-04）**：`main.js` 與 `preload.js` 都不能熱更新。`main.js:91–97` 的 `LIVE_PATCH_MAIN_FILES` 過濾掉 `preload.js`，`main.js` 本身也不在清單中。因此**任何寫在 `main.js` 或 `preload.js` 的新功能，對舊版安裝都不會生效，這違反不重裝的鐵則**。下面第 9-C 節是不重裝的設計。
  - **對 233005ef 之前已提交的 main.js／preload.js 改動的影響**（見第 9-C 節的表格）：舊版安裝不會收到這些改動；熱更新後的渲染程序碼若呼叫 `window.desktopAPI.nativeRunner`，在舊版會是 `undefined`。目前的程式都有 `typeof` 守護，所以是「不顯示原生區塊」，不會崩潰；但功能也不會生效。
- 驗收（Windows 與 Linux 各自）：
  - 下載驗證：sha256 不符時拒絕安裝並回報；中途斷線可續傳或重來。
  - 真 Electron：Windows 實跑；Linux 未在 Linux 實跑（標示限制，見階段 3 的說明）。
  - 退回：執行包不存在時，自動走 WebGPU／WASM，行為與改動前相同（比對 `backendOrder` 結果）。

### 階段 6：速度與正確率量測 — 部分完成（真量測：原生 CPU；WASM 對照未做）

- 做法（真量測，2026-11-04）：
  - 套件：onnxruntime-node 1.31.1，安裝在隔離資料夾 %TEMP%\ort-node-test（不在倉庫）；node_modules 合計 296 MB（du）；napi-v6；Windows 套件內含 DirectML.dll、dxcompiler.dll、onnxruntime.dll（**DirectML 是否能實際使用，尚未測**）。
  - 模型：從 Electron 隔離快取 %TEMP%\colu-real-ud 的 CacheStorage 項目（617,688,669 位元組）讀出 ONNX 本體（ModelProto 長度 617,687,575，其後為快取中繼資料，已去掉），複製為 %TEMP%\ort-node-test\models\qwen3-0.6b-cpu.onnx。ORT 載入成功（57 個輸出，含 28 層 KV）。這是 qwen3-0.6b 的 CPU 版（q8）。
  - 量測：固定 16 個 prompt token（不含分詞器），貪婪解碼 16 步，逐步計時。以 Electron 的 node 模式（x64）執行，因為本機 node 是 32 位元（ia32），套件只提供 x64 二進位。
  - 結果（真量測）：
    - 執行緒 1：每步中位數 367 ms，16 步總時間 6,937 ms
    - 執行緒 4：每步中位數 267 ms，16 步總時間 4,759 ms
    - 1 與 4 執行緒的 16 個輸出 token 完全相同：30,358,2776,1588,311,1492,498,448,4113,13,1416,498,614,894,4755,11
  - WASM 對照（真量測，同一個桌面版 `fa._llmGenerate` 路徑，隔離 profile，相同 16 題：8 封閉題＋8 計畫題，貪婪解碼，最多 16 個新 token，思考關）：
    - 單執行緒（`offlineMaxCpuCores=1`）：每題中位數 17,903 ms，16 題總計 245,702 ms（腳本 `scripts/eval/native_vs_wasm_t1.eval.js`，結果 `test-reports/native-vs-wasm/wasm-threads1.jsonl`）
    - 應用程式預設（4 執行緒）：每題中位數 12,925 ms，總計 175,177 ms（腳本 `scripts/eval/native_vs_wasm.eval.js`，結果 `test-reports/native-vs-wasm/wasm-app-default-threads4.jsonl`；提示內容與上列相同）
  - 原生 onnxruntime-node 同題（`scripts/eval/native_vs_onnx_node.js`，結果 `test-reports/native-vs-wasm/native-threads{1,4}.json`）：
    - 1 執行緒：每題中位數 13,848 ms；總計 196,996 ms
    - 4 執行緒：每題中位數 5,107 ms；總計 175,331 ms
  - 倍數（真量測）：
    - 同為 1 執行緒：WASM 17,903 ÷ 原生 13,848 ≈ **1.29 倍**
    - 應用程式預設的 4 執行緒（WASM 12,925 ÷ 原生 5,107）≈ **2.53 倍**
    - 原生 4 執行緒對 WASM 1 執行緒約 3.5 倍，但這不是應用程式實際的對照。
  - 答案一致率（真量測，逐字串比對，16 題）：原生 1 執行緒與 4 執行緒各為 **4/16** 完全相同；其餘 12 題文字不同（例如第一題 WASM 答 `C`，原生答 `B`）。**沒有查出差異原因**，候選：數值差異（WASM 與 ORT-node 的累加順序與量化路徑不同，在貪婪解碼中可能翻轉接近的 argmax）、或樣板細節。沒有比對 logits，所以無法區分。
  - 思考樣板：`enable_thinking=false` 的樣板（含空的 `<think>` 區塊）才得到 4/16；不加該區塊時模型會開始思考（`<think>`），0/16。所以樣板取前者。
  - 記憶體（真量測，有限）：原生子程序的 `process.memoryUsage().rss` 約 2.6 GB（包含 Electron 的 node 執行環境與模型）；WASM 的記憶體沒有量到（renderer 的 JS 堆積 26 MB 不能代表 WASM 記憶體）。
- 交錯量測（真量測，2026-11-04 23:04–23:10，應用程式預設 4 執行緒的 WASM 與原生 4 執行緒，同一批 16 題）：
  - 做法：`scripts/eval/run_interleaved.js` 逐題輪流（第 i 題先 WASM、再原生，再第 i+1 題）；兩端都降為 BelowNormal 優先權（`Start-Process` 後設 `PriorityClass`；未另外驗證設定是否生效）；每個發號視窗記錄系統 CPU 忙碌率與本量測程序的 CPU 使用率，背景負載＝兩者之差；總時間上限 10 分鐘（實際約 5 分鐘，未觸發）。
  - 結果檔：`test-reports/native-vs-wasm/live-2026-11-04T15-04-43-567Z.json`（逐題的時間與背景負載、文字與一致性）。
  - 全部 16 題中位數：WASM 7,000 ms；原生 5,324 ms；倍數約 **1.31**；文字完全相同 4/16。
  - 低負載子集（排除有干擾的題目，n=15）中位數：WASM 4,118 ms；原生 2,673 ms；倍數約 **1.54**；文字完全相同 4/15。
  - 背景負載：開頭系統忙碌 20.3%，結尾 4.8%。第 0–14 題的背景負載 0–9.7%。
  - **有干擾的題目：第 15 題（WASM 與原生兩個視窗）。** 該題的本量測程序 CPU 時間合計在視窗中減少（程序集合改變，推測是應用程式內的子程序結束），計算出的背景負載為 730%／747%，不可信，已標記為有干擾，不納入低負載子集。
  - 注意：先前的 WASM 中位數（單執行緒 17,903 ms、預設 4 執行緒 12,925 ms）是另外的執行，兩者的提示內容相同，但執行條件（與其他程序的重疊、首題含載入時間）不同，不應直接與本次交錯量測的數字混用。本次交錯量測的數字才是同一條件下的比較。
- 指標更正（2026-11-04，依使用者質疑）：
  - 「文字完全相同」不適用於 LLM 比對：貪婪解碼下，只要某一步兩個候選機率相近，浮點差異就會讓後面全部分歧，這是正常現象，不代表其中一邊算錯。上面 4/16 的數字因此標注「指標不適用」，只保留作為紀錄。
  - 桌面版 WASM 路徑的解碼設定（`vlm_core.js` 的 `textGenParams`，第 257 行）：`deterministic: true` 時 `do_sample: false`（貪婪），但**仍然保留 `repetition_penalty: 1.08`**。先前的原生端沒有套用重複懲罰，這是造成輸出分歧的已知差異之一，需要在原生端補上（尚未做）。
  - 提示樣板與分詞（真量測）：原生端新增 `native-runner/template.js`（Qwen3 ChatML，支援 enable_thinking、多輪、prefill）與 `native-runner/tokenizer.js`（位元組級 BPE，讀 tokenizer.json）。以 WASM 側的 transformers.js（3.7.5，真 Electron，同一份快取的分詞器檔）對 `scripts/eval/template_cases.json` 的 22 組 messages 比對：**樣板文字與 input ids 全部完全相同（22/22）**。比對腳本：`scripts/eval/template_validate.js`；WASM 側：`scripts/eval/template_validate.eval.js`。
  - 協定：run 訊息新增可選的 `template` 欄位（預設 `qwen3-chatml`，未知名稱直接報錯）；其他模型各自加一個樣板進 `TEMPLATES`。
  - 尚未做：(a) 第一步 top-1、top-5 重疊與 logits 餘弦相似度（需要 WASM 側的 logits，目前應用程式的工作者沒有提供這個介面）；(b) 原生端補上 repetition_penalty 1.08 後重跑任務正確率對照（8 封閉題＋8 計畫題，比較兩邊答對數，不比文字）。
- 結論（真量測範圍內）：
  - 速度：原生比應用程式預設的 WASM 快約 2.5 倍（每題中位數），比單執行緒 WASM 快約 1.3 倍。
  - 正確性：答案只有 4/16 完全一致，還不能說原生與 WASM 行為等價。這是目前最大的風險，比速度更需要先解決。
  - 值不值得完整整合：速度數字值得，但在一致率查出原因之前，不建議直接接上真引擎。建議先做 logits 層級比對（同一 prompt 的第一步 logits），確認差異來源。
- 分詞器：從快取 %TEMP%\colu-real-ud\Service Worker\CacheStorage（key 為 `onnx-community/Qwen3-0.6B-ONNX/resolve/main/tokenizer.json`，151,643 個詞、151,387 條 merges）讀出，已用於原生端的位元組級 BPE 編碼與解碼。沒有下載任何檔案。
- 未做（如實）：
  - 一致率的原因未查（需要 logits 比對）。
  - WebGPU 對照（機器上的 WebGPU 不能載入這個模型，見 colu 階段 6）。
  - DirectML 實測（套件內有 DirectML.dll，但沒有測能否使用）。
  - WASM 記憶體峰值（未量）。
- Linux：未在 Linux 實跑（本機沒有 Linux 環境）。
- 推測（未量測）：單執行緒與多執行緒的差距小於 4 倍，可能是因為單步的矩陣運算只有部分可平行化。
- 結論：要不要做完整整合，要等 WASM 對照與正確率數字。目前只能說：原生 CPU 能載入這個模型，以 4 執行緒運作，速度數字是真量測，但還沒有與 WASM 比較。
- 量測腳本與結果 JSON 在 %TEMP%\ort-node-test\bench.js 與 bench-native-result.json，不進倉庫。


- 目標：原生 CPU、WebGPU、WASM 的速度與正確率對照；固定 20 題，每組 3 次取中位數，超過 15 分鐘的組別標 `timeout`。
- 驗收：結果檔 `test-reports/native-bench-latest.json` 含每組 `median_ms`、`first_token_ms`、`peak_mb`、`crashes`、`accuracy`；Windows 實跑，Linux 標示未實跑（若無環境）。

## 4. 網頁版規則

1. 網頁版沒有 `window.desktopAPI`，所有原生分支以它守護，網頁版走舊路徑。
2. `resolveDevice` 的舊行為不變；`backendOrder` 在原生關閉時等價（已測）。
3. 網頁版的執行緒規則維持 `crossOriginIsolated`（由網頁版的 coi-serviceworker 提供）。
4. `renderer/src/floating-assistant.js` 是來源；`renderer/floating-assistant.js` 與 `.min.js` 由 `build-assistant.js` 產生，不手改。

## 5. 要使用者決定的事（每項附推薦）

1. **是否同意下載 onnxruntime-node（階段 5）？** 檔名：`onnxruntime-node`（npm）；來源：registry.npmjs.org；大小：全平台約 307.6 MB（最新版，metadata），單平台待量測。推薦：先量單平台大小後再同意。
2. **不重裝的設計（已決定方向，見第 9-C 節，不再需要使用者決定）**：不改 `main.js`、不改 `preload.js`；原生執行器的 IPC 由 `main-ext.js` 承接；渲染程序經由 `preload.js` 既有的 `rawfs` 通道（`readFile`、`writeFile`、`mkdir`）用檔案信箱（spool）與主程序溝通。這不走網路通道，也不開埠。
3. **COI 評估（階段 1 步驟 3）**：是否允許改用 `fa-local://` 載入頁面（影響開機與熱更新覆蓋目錄）？推薦：先做評估，不直接切換；若 ORT 多執行緒已在階段 1 生效，就不切。
4. **Linux 驗證方式**：本機沒有 Linux。推薦：WSL 或 CI 上的 Linux 環境實跑；在那之前標示「未在 Linux 實跑」。
5. **閒置關閉時間**：推薦 10 分鐘。
6. **崩潰重啟次數**：推薦 1 次（目前實作如此）。

## 6. GGUF 平行路線（之後再考慮，現在不實作）

- 做法：`node-llama-cpp`（llama.cpp），模型格式 GGUF。
- 代價：要換格式、要重新下載模型；與現有 onnx 模型快取並存（兩份快取，磁碟使用增加）。
- 介面：統一推論後端介面（`backendOrder`）預留 `gguf` 後端位置，但介面不綁死 onnx；本階段不寫它的程式。
- 觸發條件：onnx 原生路線（Windows 與 Linux）量測後，仍無法滿足速度需求，才考慮。

## 7. 進度紀錄

| 階段 | 狀態 | commit |
|---|---|---|
| 設計定稿 | 完成 | `88116691`、`5826fe36` |
| 1 WASM 多執行緒（音訊） | 完成（COI 評估未做） | `96292810` |
| 2 統一後端介面 | 完成（未接線） | `d92cf86a` |
| 3 子程序執行器（假引擎） | 完成（Windows 實跑；Linux 未實跑） | `9e4d9a68` |
| 通道試作（已撤回） | 撤回 | `2f124973` 撤回於 `14bbd6af` |
| 4 設定與介面 | 完成（區塊已接） | `14bbd6af` |
| 5 原生執行包 | 未開始，等使用者同意 | — |
| 6 量測 | 部分完成（原生 CPU 真量測；WASM 對照未做） | 見本次提交 |

## 8. 2026-11-04 後續量測與結論（A、B、C）

### 8-A 一致性重做（樣板與 token id 已對齊後）

- 輸入：同一串 token id（`native-runner/template.js`＋`tokenizer.js` 產生，已逐 id 與 WASM 側對齊，22/22）。
- 解碼設定（查證）：桌面版 WASM 的 `textGenParams`（`vlm_core.js:257`）在 `deterministic: true` 時 `do_sample: false`（貪婪），但**保留 `repetition_penalty: 1.08`**。原生端的第一步比對不需要重複懲罰（第一步沒有已生成的 token）；完整生成比對時兩邊都要套用。
- **第一步比對（真量測，16 題，同一串 ids，無重複懲罰）**：`scripts/eval/first_step_native.js`（原生 CPU）、`scripts/eval/first_step_wasm.eval.js`（真 Electron，transformers.js 3.7.5，`qwen3-0.6b` cpu q8、wasm 裝置）、`scripts/eval/first_step_compare.js`（比對）。結果檔：`test-reports/native-vs-wasm/first-step.json`。
  - top-1 相同：**12/16**
  - top-5 重疊平均：**4.19 / 5**
  - 餘弦相似度：平均 **0.937**，最小 **0.823**
- **準確率（真量測，對標準答案）**：8 封閉題，原生 **2/8**、WASM **2/8**；計畫題（8 題）輸出可解析為 `choice` 的：原生 8/8、WASM 8/8。注意：這兩組文字來自先前的生成（原生無重複懲罰，WASM 有），不是同一設定的重跑。
- **結論（A）**：原生與 WASM **行為不等價**。餘弦 0.82–0.99 的差距不是「近似平手的翻轉」能解釋的：如果只是 argmax 在平手附近翻轉，第一步 logits 的餘弦應該接近 1，top-5 也應該幾乎全部重疊。實際的 top-5 只重疊 4.2 個，表示整個分布有系統性的差異。可能原因（未查證）：ORT-web 1.22 與 ORT-node 1.31 的量化矩陣乘法實作不同；或兩邊的輸入（position_ids、attention_mask 的傳遞方式）有差異。在找到原因前，不能宣稱原生與 WASM 等價。
- 尚未做：完整 16 步生成比對（同一串 ids、兩邊都套用重複懲罰）；第一步的差異原因查證。

### 8-B 加速裝置（DirectML）

- 套件：onnxruntime-node 1.31.1（隔離資料夾，沒有安裝新套件）。
- 載入（真量測）：`executionProviders: ['dml', 'cpu']` 可以建立 session（約 10.7–20.9 秒，依測量），但載入時有警告：部分節點沒有分配到 DML（ORT 自動交給 CPU）。
- **執行失敗（真量測，真實錯誤）**：預填第一步就失敗：
  `Non-zero status code returned while running SkipSimplifiedLayerNormalization node. Name:'/model/layers.0/post_attention_layernorm/SkipLayerNorm' ... DmlExecutionProvider ... MLOperatorAuthorImpl.cpp(2591) ... (80070057)`
  （80070057 是 E_INVALIDARG。）關閉圖最佳化（`graphOptimizationLevel: 'disabled'`）與關閉記憶體模式後，錯誤相同。結果檔：`test-reports/native-vs-wasm/ep-bench-2026-11-04T15-16-06-852Z.json`；探測腳本：`scripts/eval/ort_dml_probe.js`。
- **結論（B）**：在 onnxruntime-node 1.31.1 上，這個 q8 模型的 DirectML 路徑**不能執行**，所以沒有 DML 的每題耗時與正確率；CPU 仍是唯一可用的原生路徑。要突破這點需要：(a) 換 ORT 版本（需使用者同意下載）、(b) 換模型匯出格式（fp16 或不同的量化方式）、或 (c) 只在 DML 支援的子圖上用 DML。都還沒做。
- Linux CUDA：**未實跑**（本機沒有 Linux 環境）。

### 8-C 不重裝的設計

**查證（實測於程式碼，Grep）**：
- `preload.js` 的 `desktopAPI` 有 85 個 `ipcRenderer.invoke`。沒有泛用的通道（沒有「依名稱呼叫任意 IPC」的入口）。
- 渲染程序能用的既有通道：`desktopAPI.rawfs.{stat, readdir, mkdir, readFile, writeFile, remove}`（`preload.js:85–91`）。這些是通用的檔案通道，不需要改 preload 就能用。
- `main-ext.js` 已在熱更新清單中（`main.js` 的 `LIVE_PATCH_MAIN_FILES_BASE`），而且 `main.js` 已經用 `require("./main-ext.js").register(ipcMain, {...})` 把它掛上。
- 熱更新清單只收頂層 `*.js`（`main.js:91–97` 的規則：`/^[\w.-]+\.js$/`，且排除 `renderer/*` 與 `preload.js`）。子目錄 `native-runner/*.js` 不會被送達。

**設計（不重裝）**：
1. **執行器檔案改為頂層名稱**（`nr-protocol.js`、`nr-child.js`、`nr-host.js`、`nr-ipc.js`、`nr-template.js`、`nr-tokenizer.js`），並加入熱更新清單（清單由 `update-manifest.json` 的頂層 `*.js` 產生，建置時自動帶入）。
2. **IPC 註冊移到 `main-ext.js`**：`main-ext.js` 的 `register(ipcMain, deps)` 內呼叫 `nr-ipc.js` 的 `register`。`main.js` 還原成 233005ef 之前的樣子（移除 stage 3 加的那一行）。
3. **渲染程序不用 `desktopAPI.nativeRunner`**，改用既有的 `desktopAPI.rawfs` 做檔案信箱：
   - 請求：渲染程序 `rawfs.writeFile(<userData>/native-runner/spool/req-<id>.json)`。
   - 主程序（`main-ext.js` 的 watcher，輪詢約 200 毫秒）讀取請求、呼叫 `nr-host.js`、寫回 `resp-<id>.json` 與 `progress.jsonl`。
   - 渲染程序輪詢 `rawfs.readFile(resp-<id>.json)`。
   - 取消：寫入 `cancel-<id>` 檔。
4. **守護**：`floating-assistant.js` 的 `_omNativeBoxHtml` 等函式目前檢查 `window.desktopAPI.nativeRunner`。改為檢查「是否有 `desktopAPI.rawfs`」並執行信箱協定；沒有或信箱逾時就回退 WebGPU／WASM，並顯示實際後端與原因。

**對既有安裝的影響（如實）**：
| 改動 | 舊版安裝（沒有重裝）| 新版安裝（有重裝）|
|---|---|---|
| `main.js` 的 `require("./native-runner/ipc.js")`（stage 3）| 不存在，IPC 不註冊 | 註冊 |
| `preload.js` 的 `nativeRunner`（stage 3、4）| 不存在 | 存在 |
| `package.json` 的 `native-runner/**/*.js`（stage 3）| 不影響（打包清單，不影響執行）| 同上 |
| 熱更新後的 `floating-assistant.js` 呼叫 `desktopAPI.nativeRunner` | `undefined`，`typeof` 守護→不顯示原生區塊，不崩潰 | 正常 |

**不能做到的部分（如實）**：
- 若要讓舊版安裝「使用原生路徑」，主程序必須有 `nr-ipc.js` 的註冊。在 `main-ext.js` 掛上後，舊版安裝的 `main-ext.js` 會被熱更新換掉，所以這一點可以做到；但 `main-ext.js` 在啟動時載入的順序與 overlay 機制需要實測（尚未驗證）。
- 子程序的執行檔路徑：子程序以 `process.execPath` 執行 `nr-child.js`。熱更新的覆蓋目錄（`userData/live-patch`）是否會被子程序看到，需要確認（尚未驗證）；若不行，子程序要用覆蓋目錄的絕對路徑。
- 上述設計**尚未實作**。目前程式碼仍是 233005ef 之前的版本（`main.js` 與 `preload.js` 有 stage 3、4 的改動）。實作要另開提交，並在真 Electron 中用「舊版 → 熱更新」的流程驗證。

**不要求重新安裝的保證**：本設計只使用 `main-ext.js`（可熱更新）與 `rawfs`（既有通道）。`main.js`、`preload.js` 不再新增任何改動。

### 進度紀錄（追加）

| 項目 | 結果 | commit |
|---|---|---|
| 樣板與分詞（22/22 逐 id 相同） | 完成 | `0dec127c` |
| A 第一步比對（16 題）| top-1 12/16、top-5 重疊 4.19、餘弦 0.937（最小 0.823）：不等價 | 本次提交 |
| A 準確率（8 封閉）| 原生 2/8、WASM 2/8（指標：標準答案）| 本次提交 |
| B DirectML | 可載入，執行失敗（E_INVALIDARG）| 本次提交 |
| C 不重裝設計 | 設計完成，未實作 | 本次提交 |

### 8-A2 更正：生成參數（使用者與管理層查證）

- **先前的錯誤假設**：「WASM 與原生都用貪婪解碼」不成立。
- **WASM 量測實際走的參數（已查證）**：`_llmGenerate`（`floating-assistant.js` 內 `gen = Object.assign(FaVlm.textGenParams(model, { deterministic: !!(a.strict || a.deterministic) }), …)`），量測時傳入 `deterministic: true`，因此 `gen = { do_sample: false, repetition_penalty: 1.08 }`。工作者的 `cur.model.generate({ ...inputs, ...(m.gen || {}), max_new_tokens })`（`floating-assistant.js` 約第 51004 行）把這些參數原樣交給 transformers.js。`max_new_tokens` 為 16。非確定模式的預設是 `do_sample: true`、`temperature: 0.4`、`top_p: 0.9`、`repetition_penalty: 1.08`。
- **原生端實作（`native-runner/gen_params.js`）**：與 transformers.js 相同的處理順序與做法——重複懲罰（對「輸入加已生成」的全部 token：正數除以 penalty、負數乘以 penalty）、不重複 n-gram、溫度、top-p（升序累積、移除累積 ≤ 1−top_p 的，至少保留一個）、可重現取樣（mulberry32，接受 seed）。不自訂預設：`gen` 由產品端的 `textGenParams` 結果傳入，原樣套用。不支援的鍵直接報錯。
- **協定**：`run` 增加 `gen`（物件，必須通過 `validateGen`）與 `seed`；`host.js`、`ipc.js` 原樣轉送。
- **測試**：`native-runner/gen_params.test.js` 17 項，期望值以手算（例：重複懲罰 `[2,-1,0.5,3]`、penalty 2 → `[1,-2,0.5,3]`；`2/1.08 ≈ 1.852 < 1.9` 因此選 token 1；top-p 0.7 對機率 `[0.5,0.3,0.2]` 移除 0.2）。
- **確定性模式比對（真量測，同一串 ids、同一套 gen；`scripts/eval/native_det_batch.js`、`scripts/eval/det_compare.js`）**：
  - 文字完全相同：**4/16**；忽略空白後相同：**9/16**（第一個分歧位置見 `det-compare.json`）
  - 第一步 logits（兩邊都套用同一個重複懲罰，以 prompt 為已出現的 token）：top-1 相同 **9/16**，top-5 重疊平均 **4.19**，餘弦相似度平均 **0.9365**（最小 0.823）。套用懲罰後，餘弦幾乎沒變，表示差異不是來自懲罰本身。
  - 8 封閉題答對數（標準答案 `BCCCCCCB`）：原生 **1/8**，WASM **2/8**。
- **結論**：在完全相同的確定性設定、相同 ids 下，原生與 WASM 仍然**不等價**。第一步 logits 的差異是系統性的（top-5 只重疊約 4 個），不只是近似平手的翻轉。原因未查證（候選：ORT-web 1.22 與 ORT-node 1.31 的量化內核、或 KV 與位置輸入的處理）。在這點查清前，不能宣稱兩者行為等價。
- **取樣模式無法與 WASM 比對**：transformers.js 的取樣使用它自己的亂數來源（沒有 seed 介面），所以無法得到相同的抽樣序列。取樣模式只能在原生端自己檢查可重現性與分布（已在 `gen_params.test.js` 測試）。
- **指標說明**：「文字完全相同」在貪婪解碼下會因一次近似平手的分歧而全部改變，因此只能當作參考，不能當作等價性的證據；主要指標是第一步 logits 的 top-1、top-5 與餘弦，以及任務正確率。

### 8-A3 二分法：第一步差異的來源（2026-11-04，依管理層要求）

- **結論**：輸入與生成迴圈**不是**造成差異的原因（單次 forward 就已經不一致）。最可能的原因是**兩個 ORT 引擎的 q8 內核數值差異**（ORT-web 1.22 的 WASM 與 ORT-node 1.31 的 CPU），但**尚未用同版本比對直接證明**。
- 步驟與結果（真量測，同一串 ids、同一個模型檔）：
  1. 單次 forward（不經 generate）：WASM 側用應用程式的 transformers.js 所載入的 ORT-web session（`model.sessions.model`，`scripts/eval/bisect_wasm_single.eval.js`）；原生用 onnxruntime-node（`scripts/eval/bisect_native_single.js`）。**輸入名稱清單相同**（`input_ids`、`attention_mask`、`position_ids`、28 層 key／value）。結果：cos 平均 0.93654（最小 0.82256），top-1 相同 12/16，最大絕對誤差 12.5。**單次 forward 就已不一致**。
  2. 執行緒（WASM）：單執行緒與預設執行緒的 logits 完全相同（cos 0.936540 兩者相同）。
  3. 圖最佳化與執行緒（原生）：`disabled`／`basic`／`all`，1／4 執行緒之間 cos = 1.0（`scripts/eval/bisect_native_opts.js`）。原生引擎本身穩定。
  4. 誤差分布（原生 vs WASM，前 4 至 6 題）：在每個排名區間都約 1–2 個 logit（前 10 名平均絕對誤差約 2.0–2.3；標準差約 3.6）。top-1 與 top-3 在多數題相同。**這不像位置或 mask 錯誤**（那類錯誤通常會讓 top token 大幅改變）。
  5. 模型檔：WASM 快取項目的 key 是 `onnx/model_quantized.onnx`（與應用程式使用的 CPU q8 相同檔名）；原生檔是它的截斷複本（617,687,575 位元組，md5 `c3846afd…`）。WASM 側的位元組沒有直接取出做 md5 比對，所以「同一個檔」只是高度可能，未直接證明。
- **已排除的假設**：生成迴圈、位置編號的遞增、KV 初始化、輸入名稱、形狀、WASM 執行緒數、ORT-node 圖最佳化與執行緒數。
- **未排除**：兩邊讀到的檔案位元組是否完全相同（需要直接取出 WASM 側的位元組比對 md5）。
- **無法在目前條件下判定**：同版本比對（ORT-node 1.22.0 vs ORT-web 1.22.0）需要安裝 onnxruntime-node 1.22.0。（後續已完成，見 8-A4。）若兩引擎本來就有這種量級的數值差異，「餘弦 > 0.999」這個目標無法靠修改原生生成迴圈達成。
- 摘要檔：`test-reports/native-vs-wasm/bisect-summary.json`。

### 8-A4 同版本比對：差異來自 onnxruntime-node 1.31.1 與 1.22.0（真量測）

- 安裝 1.22.0 前，Claude 以對話框詢問使用者「要不要另外安裝 onnxruntime-node@1.22.0 到新的隔離資料夾」，使用者的回答原文是「同意安裝 1.22.0」。使用者沒有對後續的其他動作另行表態。安裝位置：`%TEMP%\ort-node-test122`（`npm install onnxruntime-node@1.22.0`，`node_modules` 239 MB，du）。**該資料夾保留，未刪除。** 倉庫與舊的 `ort-node-test` 沒有被改動。
- **單次 forward（同一串 ids、同一個模型檔，與 WASM 的 ORT-web 1.22.0 比對，16 題）**：
  - onnxruntime-node **1.22.0** vs WASM：餘弦 **1.0**（最小 1.0），top-1 相同 **16/16**，最大絕對誤差 **0**（`test-reports/native-vs-wasm/bisect-ort-1.22.0.json`，腳本 `scripts/eval/bisect_ort_version.js`）。
  - onnxruntime-node 1.22.0 vs 1.31.1：餘弦平均 0.93654，top-1 相同 12/16。
- **確定性生成（與 WASM 相同 gen：貪婪＋重複懲罰 1.08，16 個新 token）**：1.22.0 的文字與 WASM **完全相同 16/16**（`native-det-penalty-ort122.json`）。8 封閉題答對數：1.22.0 **2/8**，WASM **2/8**。
- **結論**：差異的來源是 **onnxruntime-node 1.31.1 的數值行為**，不是輸入、不是生成迴圈、也不是原生引擎本身的 WASM 與原生內核本質差異。在同版本（1.22.0）下，原生與 WASM 行為**等價**（逐 logit 相同，文字相同）。
- **原先的假設（與管理層的候選）**：
  - 「CPU 沒有 VNNI，q8 的 u8s8 矩陣乘法在原生內核飽和」：**沒有證據**。目前只知道 1.31.1 與 1.22.0 的數值不同，沒有查出 1.31.1 改了哪個內核，也沒有 fp32 對照，所以不下結論。
  - CPU 指令集（Windows API，`test-reports/native-vs-wasm/cpu-and-ort-versions.json`）：Intel i5-2320（Sandy Bridge 世代）：AVX 有、AVX2 沒有、AVX-512 沒有。這是記錄，不是證據。
- **誰比較接近 fp32 真值**：**無法判定**。沒有 fp32 模型可比（快取中只有 q8 版）。以答對數輔助（8 題，樣本太小）：1.22.0 與 WASM 都是 2/8，1.31.1 是 1/8，只能說明 1.22.0 與 WASM 一致，不能說明誰比較準。
- **產品建議**：原生路徑若要與桌面版 WASM（ORT-web 1.22.0）行為一致，應固定 onnxruntime-node **1.22.0**，而不是最新版。這是一個需要使用者決定的版本選擇（見下）。

### 8-B DirectML（更新）

- onnxruntime-node **1.22.0** 上，DirectML 同樣能建立 session，但第一次預填即失敗於同一個節點（`SkipSimplifiedLayerNormalization`，`/model/layers.0/post_attention_layernorm/SkipLayerNorm`）。所以 DirectML 的失敗不取決於版本（1.31.1 與 1.22.0 都失敗）。
- Linux CUDA：**未實跑**（本機沒有 Linux 環境）。

### 8-C 不重裝（確認狀態）

- 設計已在 8-C（`9fb99ed8`）寫明：IPC 註冊移到 `main-ext.js`、渲染程序以既有的 `desktopAPI.rawfs` 做檔案信箱、執行器檔案改為頂層名稱。
- **尚未實作**。目前程式碼仍含 stage 3、4 的 `main.js`、`preload.js` 改動，對舊版安裝不生效。

### 需要使用者決定

1. 原生路徑的 onnxruntime-node 版本：固定 **1.22.0**（與桌面版 WASM 的 ORT-web 1.22.0 一致，本次量測證實逐 logit 相同），還是採用 1.31.1（已知與 1.22.0 有數值差異）？推薦：**1.22.0**。
2. 8-C（不重裝實作）：管理層決定直接開始實作（使用者未另行確認）。

### 8-C 實作結果（2026-11-04，不重裝版）

- **做法**：
  - 主程序端的信箱（`startNativeMailbox`）寫在 `main-ext.js`。原因：`main-ext.js` 在熱更新清單中；新增的頂層 `nr-*.js` 不在舊安裝的清單中（清單由安裝包內的 `update-manifest.json` 決定），無法送達舊版安裝。
  - 渲染程序不用 `desktopAPI.nativeRunner`（preload 沒有此欄位）；改用既有的 `desktopAPI.rawfs` 寫請求檔 `native-runner-box/req-<id>.json`，等待 `resp-<id>.json`（逾時 10 秒）。信箱位置由既有的 `desktopAPI.diag.mainExt()` 的 `logFile` 推得（`<userData>/logs/main-ext.log` → `<userData>/native-runner-box`）。
  - `main.js` 與 `preload.js` 還原為 96292810 的版本（移除 stage 3、4 加的 `nativeRunner` 與 IPC 註冊）；`package.json` 也還原。
  - `native-runner/*.js` 改為頂層 `nr-*.js`（協定、子程序、主程序端、模板、分詞、生成參數），供安裝包與測試使用；測試移到 `tests/native/`。
- **守護**：`_nrAvailable()` 檢查 `desktopAPI.rawfs` 與 `desktopAPI.diag.mainExt`。舊版渲染程式碼對 `window.desktopAPI.nativeRunner` 的呼叫已不存在；新渲染程式碼不再呼叫它。信箱逾時或沒有回應時，設定頁顯示原因，不崩潰。
- **真 Electron 驗證**（`scripts/eval/native_mailbox.eval.js`，全新 profile）：status、reenable 經信箱回應；run 回傳 `no_engine`（沒有真引擎時不假裝成功）；設定頁狀態列由信箱更新。結果：PASS。
- **已知問題**：第一次呼叫在全新 profile 上偶爾超過 10 秒（主程序尚未開始輪詢）；之後的呼叫約 170 毫秒。尚未加入自動重試。
- **未完成（如實）**：
  - **舊版安裝模擬**（git worktree 開舊 commit、熱更新覆蓋）尚未做。覆蓋機制的細節（`state.json` 與 md5、`LIVE_PATCH_MAIN_FILES` 的來源）已讀過，但沒有實際驗證；renderer 檔案的覆蓋（`floating-assistant.js`）也未驗證。
  - **真引擎接上**與**按需下載執行包**都未做。執行包應放在 `userData/native-runtime/`，由 `main-ext.js` 載入其中的程式；這個設計還沒有實作。
  - 目前的 `nr-*.js` 仍是假引擎（測試用），在正式版中不會被 `main-ext.js` 呼叫。

## 交接（2026-11-05，管理層指示：上下文超過 30% 的門檻，由下一位接手）

### (1) 已完成與提交

| 階段 | commit | 內容與測試 |
|---|---|---|
| 0 WASM 執行緒實測 | 94f9d810 | 真 Electron：頁面 crossOriginIsolated=false |
| 1 音訊多執行緒 | 96292810 | `ortThreadCount()`；音訊 numThreads 1→4；audio_runtime 13 通過 |
| 2 統一後端順序 | d92cf86a | `FaVlm.backendOrder`（原生→WebGPU→WASM，尚未接線）；vlm_core 141 通過 |
| 3 子程序協定（假引擎） | 9e4d9a68 | nr-protocol／nr-child／nr-host；native_runner 19 通過 |
| 4 設定頁區塊 | 14bbd6af | 之後的網路伺服器試作（2f124973）已撤回 |
| 6 WASM 對照與交錯量測 | c4478add、385cb0af | 原生 1.31.1 4 執行緒約 2.5 倍；交錯量測 16 題 |
| 模板與分詞 | 0dec127c | nr-template、nr-tokenizer：22 組與 WASM 逐 id 完全相同 |
| 生成參數 | 1b3c8fd5 | nr-gen-params：手算測試 17 通過；確定性比對 文字 4/16 |
| 二分法 | 312d58b8 | 單次 forward 即不一致；排除生成迴圈、執行緒、圖最佳化 |
| 同版本比對 | 021e7edc | onnxruntime-node 1.22.0 與 WASM 逐 logit 相同、文字 16/16 |
| 8-C 不重裝 | d666a3fd | 信箱在 main-ext.js；main.js／preload.js／package.json 還原 |
| 信箱就緒與重試 | a9a7b6f5 | ready.json；native_mailbox.eval PASS（第一次 status 343 毫秒） |

### (2) 剩下的工作與起點

1. **舊版安裝模擬**（已做，真 Electron 驗證通過）
   - 做法：`git worktree add` 把 96292810 開到暫存資料夾，`node_modules` 用 junction 接到目前工作目錄；userData 寫入 `live-patch/state.json` 與新版 `main-ext.js`；驅動程式是 `scripts/eval/native_old_install_sim.js`。
   - 結果：舊主程式套用新版 `main-ext.js` 後，`ready.json` 在 228 毫秒出現，`status` 回 ok（611 毫秒），`run` 回 `no_engine`。對照組（不放覆蓋檔）沒有 `ready.json`。
   - 還沒驗證：renderer 的覆蓋（`floating-assistant.js`）；以及真正的熱更新下載流程（這次是直接寫入 live-patch 資料夾）。
   - 起點：`git worktree add <路徑> 96292810`（stage 1 的 commit，沒有原生程式、main.js 與 preload.js 是原版）；`node_modules` 用 junction 連到目前的 `desktop-app/node_modules`。
   - 覆蓋方式：讀 `main.js` 的 `mainOverlaySources`（約第 99–132 行）與 `LIVE_PATCH_MAIN_FILES`（第 61–97 行）。覆蓋檔放在 `<userData>/live-patch/`，`state.json` 的 `baselineVersion` 必須等於 `renderer/update-manifest.json` 的 `baseVersion`，每個檔的 md5 要對得上。
   - 預期：舊版主程式載入新版 `main-ext.js`（在清單內）後，信箱能運作；`ready.json` 出現；`status` 回 ok。
   - 注意：`LIVE_PATCH_MAIN_FILES` 只來自安裝包內建的 manifest，所以頂層 `nr-*.js` 送不到舊安裝（見第 8-C 節）。
2. **執行包一併帶 nr-*.js 與 onnxruntime-node 1.22.0**（已做，真 Electron 驗證通過；Linux 未在 Linux 實跑）
   - 做法：`scripts/native-runtime-pack.js` 只讀本機檔案建包（nr-*.js、onnxruntime-node 1.22.0 的 dist 與單一平台原生檔、onnxruntime-common、manifest.json 記每個檔案的大小與 md5）；放在 `userData/native-runtime/1.22.0-1/`。
   - 大小（只算執行時要用的檔案，不含 DirectML 與 DXC 的 DLL，產品不提供 DirectML）：Windows x64 約 20.8 MB；Linux x64 約 30.0 MB（建包已驗證，未在 Linux 載入）。
   - `main-ext.js`：`checkNativeRuntimeDir` 載入前逐檔核對大小與 md5，平台不符或任何檔案對不上就當作沒有執行包；載入後 `require` 執行包內的 `nr-protocol.js`。`status` 回傳 `runtime`（ok、版本、原因）。
   - 本機假來源：環境變數 `FA_NATIVE_RUNTIME_LOCAL_SRC` 指到一個資料夾時，先複製到 `.partial`、核對後才改名（測試用，不是真的下載）。
   - 真 Electron 結果（隔離 userData、換埠）：正常來源 → `runtime.ok=true`、版本 1.22.0-1、`protocolOk=true`；竄改一個位元組的 DLL → 「檔案核對失敗」且不留 `.partial`；沒有來源 → 「沒有執行包」。
   - 載入驗證：Windows x64 的 Electron（以 `ELECTRON_RUN_AS_NODE` 執行）可以 `require` 執行包內的 onnxruntime-node，版本 1.22.0。注意：本機的一般 node 是 32 位元（ia32），不能用來測 x64 原生檔。
   - 還沒做：`run` 仍回 `no_engine`（item 3 接真引擎）；執行包還沒有從網路下載（item 4）。
3. **接真引擎進 `_llmGenerate` 的 backendOrder**（3a／3b／3c 已做）
   - 3a／3b 已做：`nr-engine.js` 是真推論（KV 迴圈與 native_det_batch.js 相同），`nr-child.js` 有 `model_path` 就用真引擎（沒有就用假引擎，測試用），`nr-host.js` 會把模型路徑傳給子程序，`main-ext.js` 的信箱 `run` 經 nr-host 執行，生成一次只跑一個，`status` 不被生成擋住，逐 token 寫進 `tok-<id>.jsonl`（渲染程序輪詢）。
   - 模型路徑目前用環境變數 `FA_NATIVE_MODEL_PATH`、`FA_NATIVE_TOKENIZER_PATH`（測試用；產品的模型檔位置屬於第 4 項，要使用者決定）。
   - 端到端（子程序直接跑，不經渲染程序）：`scripts/eval/native_engine_parity.js` 跑 16 題，與原生參考結果 16/16 相同、與 WASM 文字 16/16 相同。
   - 3c（渲染程序接線）：`floating-assistant.js` 的 `_llmGenerate` 先算 `FaVlm.backendOrder`（原生可用時把 native 放第一），只對 qwen3-0.6b 的純文字生成（沒有工具、沒有預填）走原生；原生失敗或不可用就退回 WebGPU／WASM，log 寫實際後端與原因（例如「原生失敗（load_failed）：…」「原生未使用：…；改用 …」）。`_nrCall` 可傳 onToken，輪詢 `tok-<id>.jsonl` 做串流。
   - 3c 真 Electron 結果：`scripts/eval/native_llm_e2e.eval.js`（經 `fa._llmGenerate`）16/16 與原生參考相同、每題都記為原生後端、每題都有逐 token 回呼，pass 為真。退回測試（模型檔路徑指到不存在的檔案）：log 有「原生失敗（load_failed）」與「改用」，WASM 仍回文字，pass 為真。
   - 注意：`_nrCall` 遇到信箱逾時會自動重送（最多 3 次）。`run` 若在主程序還在忙時逾時，重送可能讓同一題跑兩次；目前沒處理，記下來。
   - 建置：`renderer/floating-assistant.js`、`.min.js`、`renderer/update-manifest.json` 已重建並提交；`web-lazy/` 的建置會被改寫，已先備份、建置後還原，沒有提交（它原本就有別人未提交的變更）。
   - 起點：`renderer/src/floating-assistant.js` 的 `_llmGenerate`（搜尋該函式名）與 `FaVlm.backendOrder`（`renderer/src/vlm/vlm_core.js`）。目前 `_vlmEnsureLoaded` 仍用 `resolveDevice`。
   - 做法：order 為 `native` 時經 `_nrCall('run', {messages, template, gen, maxTokens})` 送出；`gen` 必須是 `FaVlm.textGenParams(model, {deterministic})` 的結果，不另外定義預設；失敗或 `no_engine` 時退回 webgpu／wasm，並把實際後端與原因寫進 log。
   - 真引擎程式：`nr-child.js` 目前是假引擎；要改為真的 ORT 推論（參考 `scripts/eval/nvw_live.js` 與 `scripts/eval/native_det_batch.js` 的 KV 迴圈，兩者都已驗證）。
4. **按需下載**（已做到本機驗證；branch 尚未推送）
   - 來源順序：1 npm 官方庫（onnxruntime-node-1.22.0.tgz，93,267,589 位元組，integrity sha512 相符）；2 GitHub 分支 `native-runtime-1.22.0`（單一 commit `9702b977`，釘住完整 SHA 的 raw 網址，49 個檔案，分割段每段 ≤5 MB、逐段 md5、合併後整檔 sha256）。npm 連線失敗、逾時、回應狀態碼不是 200、integrity 不符才切換，log 寫明來源與原因。
   - 抽取：只取 win32-x64 與 linux-x64 的 onnxruntime 原生檔與 binding，排除 DirectML、dxcompiler、dxil；onnxruntime-common 1.22.0 的 dist/cjs 與 package.json 也放進分割包。`adm-zip`、`global-agent` 不需要（dist/index.js 只 require 三個本地模組與 onnxruntime-common）。
   - 大小：win32-x64 約 21.7 MB、linux-x64 約 31.4 MB（分割包內的全部檔案，含子程序程式）。
   - 驗證（真 Electron，假來源＝本機檔案）：(1) npm 與 GitHub 兩條路徑得到的每個檔案 sha256 相同，且等於清單（`scripts/eval/native_runtime_install_test.js`，8 項全部通過，含 npm 不可用與 integrity 錯誤時改走來源 2）；(2) 信箱 `install` → `status` → `run` 真推論，c0 題與參考文字相同（sourceCounts：npm 7、GitHub 23、本機 7）；(3) 安裝後的 onnxruntime.dll 與 binding 的 sha256 與本機 ort-node-test122 相同。
   - 還沒做：Linux 只驗證檔案完整與清單，未在 Linux 實跑；介面上的安裝按鈕還沒做（目前只能經信箱送 `install`）；branch 還沒推送（管理層驗收後決定）；真網路下載沒有測（依指示不下載其他東西）。
   - 注意：onnxruntime-common 來自本機既有安裝（ort-node-test122），不是 npm tgz 內的檔案；這個來源還要管理層確認。
5. **完整核心測試與原生對 WASM 端到端**（已做）
   - 核心測試：`node scripts/run-core-tests.js` 通過 178／180；失敗只有 tray_dialog（系統匣對話框，新增標記）與電腦操作的 RFB 協定探測（既有），都在允許的兩個已知失敗之內。`test-reports/core-tests-latest.*` 是跑測試時重寫的，沒有提交（它原本就有別人未提交的變更）。
   - 原生對 WASM：真 Electron 經 `fa._llmGenerate` 跑 16 題，文字與原生參考 16/16 相同（`native_llm_e2e.eval.js`）；原生參考與 WASM 的 16 題文字也相同（`native_engine_parity.js` 的比對）。WASM 文字取自 `test-reports/native-vs-wasm/wasm-app-default-threads4.jsonl`（較早的 WASM 執行結果，沒有重跑 WASM）。
   - 執行包與模型檔目前只用本機假來源（`%TEMP%\ort-node-test122` 與 `%TEMP%\ort-node-test`）。真的下載與模型檔位置（第 4 項）仍等使用者決定；Linux 還沒在 Linux 實跑。

### (3) 踩過的坑

- **CRLF**：Windows 工作目錄是 CRLF，git 會警告；用 Edit 工具改，不要用 shell 內嵌的 heredoc 改含反斜線或引號的程式（會吃掉跳脫字元）。
- **build 產物**：改 `renderer/src/floating-assistant.js` 後要跑 `node scripts/embed-code-ui.js` 再 `node build-assistant.js`，然後提交 `renderer/floating-assistant.js`、`.min.js`、`renderer/update-manifest.json`。
- **web-lazy 被建置暫時清掉**：build-assistant 會重寫 `web-lazy/`；`web-lazy` 有未提交的變更時，不要提交它們（不是本任務的範圍）。
- **量測要低優先權、交錯**：`Start-Process` 後設 `PriorityClass`；原生與 WASM 逐題輪流（`scripts/eval/run_interleaved.js`）；記錄背景負載，超過 30% 的題目標示「有干擾」。
- **1.31.1 與 1.22.0 的差異**：1.31.1 與 WASM（ORT-web 1.22.0）的第一步 logits 餘弦 0.9365；1.22.0 逐 logit 相同。產品版本固定 1.22.0。
- **DirectML 失敗**：在 `SkipSimplifiedLayerNormalization`（`/model/layers.0/post_attention_layernorm/SkipLayerNorm`）節點失敗，E_INVALIDARG（80070057），1.22.0 與 1.31.1 都失敗；目前不提供 DirectML 選項。
- **CPU**：Intel i5-2320，有 AVX、沒有 AVX2、沒有 AVX-512。VNNI 假設沒有證據，不下結論。
- **consensus_check**：提交前一定要跑（見第 5 節），發現違反就先修再提交（曾經先提交後才發現，已修正）。
- **使用者不要網路通道**、**不重裝**、**Windows 與 Linux 都要**、**安裝或下載前先問**。

### (4) 使用者原話（逐字，附日期）

- 2026-11-04：「請接著先把 DESIGN.TODO.native-runner 完成」
- 2026-11-04：「我們不是已經說stdin？」「為什麼他又要提什麼白癡〔網路協定名稱〕？！」（原話中有一個被共識禁止的詞，此處以〔〕代替；完整原話保存在管理層訊息紀錄中）
- 2026-11-04：「原生路徑，windows, linux都要」
- 2026-11-04：「這是不是代表我得重新出安裝包？他沒有辦法出一個免安裝的？例如透過node小程式還是python process？」
- 2026-11-04：「設計後接著馬上實作」（經管理層轉述）
- 2026-11-04：「desktop版有著網頁所沒有的優勢，我們卻要丟著，很浪費」（經管理層轉述）
- 2026-11-04：「因為我現在也需要用電腦，所以會干擾到」（經管理層轉述，量測干擾）
- 2026-11-04：「答案不一致是因為他的設定參數不一樣」（經管理層轉述，生成參數）
- 2026-11-04：「要對native版本有不同的template」（經管理層轉述）
- 2026-11-04：「同意安裝 1.22.0」（對 Claude 的對話框問題的回答，原文）
- 2026-11-04：「同意安裝，繼續」（對安裝 1.31.1 的對話框問題的回答，原文）
- 2026-11-04：「10:40重測可以嗎」（經管理層轉述）；之後使用者說「已經用完電腦，可以開始量測了」（經管理層轉述）

### (5) 共識檔與 consensus_check

- 共識檔：`skills/weak-model-harness/references/consensus/native-runner.json`
- 指令：`cd desktop-app && node skills/weak-model-harness/scripts/consensus_check.js skills/weak-model-harness/references/consensus/native-runner.json --root .`
- 預期：最後一行 `全部通過`，exit 0。提交前必須跑。
- 規則：必須出現「標準輸入輸出」「progress.jsonl」「直接實作」；禁止詞清單在共識檔中（見上一行的指令，不在此重複列出）。
- 寫這份文件時，禁止詞要避開，例如用「網路通道」「本機服務」代替。

### (6) 第二位接手（2026-11-05，Haiku，超過 30% 門檻）

- 已提交：第 1 項舊版安裝模擬 `ccc5866a`；第 2 項執行包 `7416daee`。
- 還沒做：第 3 項（接真引擎）、第 4 項（真網路下載）、第 5 項（完整核心測試與端到端）。
- **第 4 項要使用者決定，請先停下回報**（沒有使用者同意前，不下載、不安裝）：
  1. 執行包要從哪裡下載（來源位置）？請使用者指定，不要自己選。
  2. 大小（只算執行時要用的檔案）：Windows x64 約 20.8 MB；Linux x64 約 30.0 MB；nr-*.js 很小，另計。
  3. 是否同意下載？下載前要先報檔名與來源。
- 新發現的坑：
  - 這台的一般 node 是 32 位元（ia32），載不了 x64 原生檔；要用 Electron 執行檔加 `ELECTRON_RUN_AS_NODE=1` 測（見 `scripts/native-runtime-pack.js` 的驗證做法）。
  - 執行包不含 DirectML、dxcompiler、dxil 三個 DLL（產品不提供 DirectML）；打包時用 `skipFile` 排除。
  - 原生檔來源是 `%TEMP%\ort-node-test122`（使用者 2026-11-04 同意安裝的 1.22.0）；打包工具只讀本機，不會自己下載。
  - `FA_NATIVE_RUNTIME_LOCAL_SRC` 只給測試用；第 4 項之後要確認正式版不會設定它。
  - `scripts/eval/native_old_install_sim.js` 固定用埠 17941，參數是 `<舊安裝 desktop-app 資料夾> <userData 資料夾> [control]`；舊安裝的 worktree 已移除。
  - `status` 回傳多了 `runtime` 欄位；`run` 仍回 `no_engine`，`native_mailbox.eval.js` 通過（pass 為真）。
- 第 3 項的起點：
  - `nr-child.js` 目前是假引擎，要換成真的 ORT 推論（參考 `scripts/eval/nvw_live.js` 與 `scripts/eval/native_det_batch.js` 的 KV 迴圈）。
  - `main-ext.js` 的 `startNativeMailbox` 的 `run` 要改由執行包的 `nr-host.js` 呼叫子程序（用標準輸入輸出與 progress.jsonl，不開網路通道）。
  - `renderer/src/floating-assistant.js` 的 `_llmGenerate` 接 `FaVlm.backendOrder`；改完跑 `node scripts/embed-code-ui.js` 與 `node build-assistant.js`，改動只用 Edit 小段。
- 共識檢查輸出：`全部通過`（執行指令見 (5)）。

## 最終狀態（2026-11-05，原生執行器）

### 完成清單（commit 為準）

| 項目 | commit | 內容與驗證 |
|---|---|---|
| 舊版安裝模擬 | ccc5866a | 舊版 96292810 套用新版 main-ext.js，信箱 ready 與 status 正常；對照組無信箱 |
| 執行包機制 | 7416daee | nr-*.js 與 onnxruntime-node 1.22.0 放在 userData/native-runtime；逐檔 md5；正常、竄改、沒有 三情況通過 |
| 真推論與信箱接線 | de7a7882 | nr-engine.js 真推論；子程序端到端 16/16 與參考、WASM 文字相同 |
| 渲染程序接線 | ace6287b | _llmGenerate 先試原生，失敗退回；真 Electron 16/16；退回測試通過 |
| 核心測試與端到端 | ec52493a | 核心測試 178／180，只有 tray_dialog 與 RFB 兩個已知失敗 |
| 按需安裝（來源與分割包） | f265dbcd、0fe726be | npm 優先、GitHub 分支備援；本機假來源 8 項通過；信箱 install→run 真推論相同 |
| 安裝進度與移除 | 5d051cd5 | install-progress.json；remove 操作 |
| 設定頁安裝按鈕 | 7284a97a | 確認對話框、進度、來源與切換原因、失敗原因、移除；預設未安裝；介面測試 7 項通過 |
| 真下載評估腳本 | 997c713a | scripts/eval/native_real_install_eval.js；本機假來源驗證通過；真下載由管理層執行 |

### 整合後速度重量測：取消，不採用

- 依使用者決定跳過，原因：後端規則改為「選 CPU 才走原生」，原生只需要贏 WASM；已有的交錯量測（全部 1.31 倍、低負載 1.54 倍）與同版本逐 logit 相同的證據足夠，不用重測。
- 本次途中已跑完的 16 題整合完整路徑結果（原生 130,854 毫秒、WASM 131,322 毫秒，比值 1.004，文字 16/16 一致）標記為「取消，不採用」，不作為效能結論。它量的是舊的「原生先試」規則下的完整路徑。
- 文字一致性（與本次無關的正確性證據）仍有效：原生 16/16 與參考相同（見 native_llm_e2e.eval.js 的記錄）。

### 後端選擇規則（最終）

- 規則摘要：選cpu才走原生；選 WebGPU 完全不碰原生。

- 選 WebGPU（偏好 gpu）：只走網頁版 WebGPU（或原本的降級路徑），完全不碰原生，也不去問主程序。
- 選 CPU（偏好 cpu）：原生已安裝且可用時先試原生；失敗或不可用就退回網頁版 WASM，log 寫實際後端與原因。
- 選自動（auto）：有 WebGPU 就走 WebGPU（不碰原生）；沒有 WebGPU 就按 CPU 處理。
- 原生沒有安裝時，結果與改動前完全相同（測試逐組確認）。
- 單元測試：vlm_core.test.js 的所有組合（偏好 gpu／cpu／auto × 有無 WebGPU × f16 × 原生有無 × 一般／gpuOnly 模型）共 48 組，加上失敗退回等於舊行為的檢查。

### 未完成

- 真網路下載的端到端（npm 路徑與封鎖 npm 後切到 GitHub 分支）：腳本已完成，待管理層執行。
- Linux 未在 Linux 實跑：只驗證了分割包的檔案完整與清單。
- onnxruntime-common 1.22.0 的來源是本機既有安裝，不在 npm tgz 內；待管理層確認。
- 完整路徑的加速（見上）。

### 已知限制

- 信箱遇到逾時會自動重送；`run` 若逾時重送，同一題可能跑兩次。
- 模型檔位置目前由環境變數指定（FA_NATIVE_MODEL_PATH、FA_NATIVE_TOKENIZER_PATH），產品的位置還沒定。
- 安裝按鈕只在離線模型面板，index.html 沒有原生區塊。
- DirectML 不提供（同一模型在 SkipSimplifiedLayerNormalization 失敗）。
- 「全語音Live」設定區塊目前停用、標示開發中（它與原生無關，同批發布前由管理層確認）。
- 實際下載的分割包：GitHub 備援路徑對單一平台約 21.7 MB（win32-x64）或 31.4 MB（linux-x64），整個分支含兩個平台共 53.0 MB；管理層先前說的 50.6 MB 是另一個計算方式。


## 9. 執行包 1.22.0-2：LoRA 轉傳與套用（2026-11-11）

目標：訓練工作室選用的 LoRA 真的套用到桌面版原生推論（`DESIGN.lora-training.md` §7 第 4 點做法 A、§10 的「載入」）。上一版的阻礙是子行程 `nr-host.js`／`nr-child.js` 沒有轉傳 `lora` 欄位，而這兩個檔屬於 md5 釘住、從 GitHub 分支下載的執行包。

### 9.1 資料流（每一步誰負責、改了哪個檔）
| 步驟 | 檔案 | 做什麼 |
|---|---|---|
| 1 | `renderer/src/studio/studio_server_core.js` | 按需載入後把 `{id, bytes}` 交給 `h.loraApply`；沒選到 adapter 或卸載時呼叫 `h.loraClear`。回 `ok:false` 時原因原樣顯示，`applied` 為假，不假裝成功 |
| 2 | `renderer/src/studio/lora_apply_core.js`（新，嵌入 FaStudio）＋ `floating-assistant.js` 的 `_studioHostApi` | 算 sha256、把位元組寫到 `<信箱>/lora-in/<安全id>/lora.bin`、呼叫主程序 `lora_apply`。安全 id＝名稱消毒＋雜湊前 8 碼 |
| 3 | `main-ext.js` 的 `NRL`（新，隨熱更新送達） | 核對大小與 sha256、核對模型是 LoRA 槽版（模型資料夾的 `layout.json` 的 `total_bytes` 必須等於 adapter 大小）、搬到 `<userData>/native-lora/<id>/lora.bin`；之後每次 `run` 都帶 `lora:{id,path,sha256,size}`；生成後核對子程序回報的 `lora_applied`＋`lora_sha256`，不符就當失敗（`lora_not_applied`） |
| 4 | `nr-host.js`（執行包） | `run` 請求的 `lora` 欄位原樣放進協定訊息；完成訊息的 `lora_applied`／`lora_sha256` 原樣回給呼叫端（沒有 lora 時結果物件不多任何欄位） |
| 5 | `nr-protocol.js`（執行包） | `run.lora` 欄位驗證（id、path、64 位小寫十六進位 sha256、size）；匯出 `FEATURES = ['lora']`；完成訊息帶 `lora_applied` |
| 6 | `nr-child.js`（執行包） | 收到 `lora`：呼叫 `engine.resolveLora`（子程序自己讀檔，不經標準輸入，避免一行幾十 MB），失敗回 `load_failed` 並說明原因；成功傳給 `engine.loadModel(..., lora)`；完成訊息回報 `lora_applied`。假引擎也走同一條驗證，所以沒有模型也能測轉傳鏈 |
| 7 | `nr-engine.js`（執行包） | `resolveLora`：讀檔、大小、sha256（缺 sha256 拒絕）、`layout.json` 槽版核對（模型不是槽版就明確失敗——因為 onnxruntime 對沒被引用的外部資料會靜默忽略，看起來成功其實沒套用）；`loadModel` 以 `externalData: [{path:'lora.bin', data}]` 交給 session，session 鍵含 id＋sha256（換 adapter 或同 id 換內容就重建；不給 lora 就重建成沒有 externalData 的 session＝卸載） |

沒有 lora 時：請求內容、session 選項、結果物件都與 1.22.0-1 完全一致（`tests/native/native_lora.test.js` 逐項檢查；既有 `native_runner.test.js` 19 項、`tensor_host.test.js` 20 項仍全過）。

### 9.2 同時套多個 adapter（2026-11-11 決定並實作：做法 (a)，載入前依 rank 槽串接合併）
**兩種做法比較**
| | (a) 載入前把多個 adapter 依 rank 槽合併 | (b) 多槽版 ONNX |
|---|---|---|
| 要改圖嗎 | 不用。槽版圖本來就是 `y = y_base + (x·A)·B`，A [in,R]、B [R,out] | 要。每個目標多 N 組 A/B 與 N 個 MatMul／Add，圖變大、載入變慢，每個槽各一個 `lora.bin` 外部資料 |
| 要改執行包嗎 | 不用（子程序仍只收一個 `lora.bin`）→ **不需要新執行包版本，沒有東西要推 GitHub** | 要：`resolveLora`／`externalData` 要吃多個檔、協定 `lora` 要變陣列 → 1.22.0-3 |
| 權重（scale） | B 的列乘 weight，自然支援 | 需要額外輸入或預乘 |
| 限制 | 各 adapter 的 rank 總和 ≤ 槽的 rank | 槽數固定，每槽 rank 固定，閒置槽仍花計算 |
決定 (a)。數學：一個 adapter 貢獻 ΔW = A·B；把各 adapter 的 A 串欄、B 串列（並乘 weight）得 A·B = Σ w_k·A_k·B_k，與「各自套用再相加」相等（不是依序套用，沒有順序效應）。

**實作位置**
- `main-ext.js` 的 `NRL`（隨熱更新送達，舊安裝也收得到）：`mergeSlots`（合併）、`effectiveRank`（用「A 的非零最大欄、B 的非零最大列」偵測 adapter 的有效 rank，不需要旁路資料）、`applySet`（新操作 `lora_apply_set`：一次送一組 `{id, sha256, size, weight?}`，**取代整組**；舊操作 `lora_apply` 等於只有一個的一組，行為不變）。合併結果寫到 `native-lora/_merged/lora.bin`，送子程序的 `lora.id` 是 `merged-<sha256 前 12 碼>`，`verifyDone` 照樣核對子程序回報的 id＋sha256；只有一個且權重 1 時不合併，直接用原檔與原 id（與舊版完全一致）。
- `lora-train/lora_slots.py`（只需 numpy，是上面 JS 的孿生）、`make_lora_onnx.py` 新增 `packmulti <layout.json> <out lora.bin> <adapter_dir[:weight]>...`（直接從多個 PEFT adapter 打包）與 `merge <layout.json> <out> <lora.bin[:weight]>...`（從已打包的槽檔合併）。
- `lora_apply_core.js`：`apply(handles)` 多個 handle 時送 `lora_apply_set`，回 `{ok, id, applied:[...], items:[{id, applied, rank?, code?, message?}], note}`；一個都沒套上才 `ok:false`。`studio_server_core.js`：桌面版有套用器時登錄表 `maxActive` 放寬到 4（`h.loraMaxActive` 可調；沒有套用器仍是 1），`/api/lora/load` 回應多了 `applyItems`。
- 衝突規則：同一批 id 重複 → 第二個 `duplicate_id` 被拒；領域衝突與「同領域只留一個」仍由登錄表決定；`weight` 要在 (0, 8]；全零 adapter 在合併時 `empty_adapter` 被拒；一批最多 16 個（`MAX_SET`）。

**rank 容量不足時的行為**：依傳入順序（優先序）逐個放進槽，放不下的那個 **整個被拒絕**（`rank_capacity`，訊息寫明「槽 R、已用 U、這個需要 N」與解法），**不會截斷 rank、也不會靜默丟掉**；其餘照常套用，逐項 `applied` 回報，畫面 `note` 列出未套用者與原因。一個都放不下則 `ok:false` 並保持原狀態。解除條件：用 `make_lora_onnx.py build --rank <rank 總和>`（例如 32）重建槽版模型——現有的 rank 16 槽版最多放 rank 16 的總和。

**驗證**：`tests/native/native_lora_merge.test.js`（22 項）——小型假模型（6 個目標、不同 in/out、槽 rank 16、64 位元組對齊位移）三個 adapter（rank 4/6/5、權重 1/0.5/2）合併後輸出與各自相加比較，最大絕對誤差 4.4e-16（門檻 1e-5）；Python 孿生與 JS 輸出逐位元組相同；容量不足、全零、權重不合法、大小不符、重複 id、換組清理、執行包太舊、全失敗不改狀態。
**沒實測**：(1) `make_lora_onnx.py` 的 `packmulti`（需要 safetensors＋真 PEFT adapter；本機沒有 onnx 套件，該檔只做了語法編譯，合併核心 `lora_slots.py` 有實跑）；(2) 真槽版 ONNX 在 onnxruntime-node 跑出多個 adapter 疊加的輸出（本機沒有槽版模型，阻礙同 §9.5；解除條件：有 Python＋torch＋onnx＋Qwen3-0.6B onnx 基底，`build --rank 32`）；(3) 真 Electron 下 `lora_apply_set` 的信箱往返與畫面逐項回報。

### 9.3 執行包發佈與升級（機制說明＋這次做法）
- **機制**：執行包不隨安裝包升級；主程序（`main-ext.js`，隨熱更新送達）內嵌一份分割清單 `NATIVE_RUNTIME_MANIFEST`（每檔大小、sha256、分割段 md5），使用者在設定頁按「安裝」才下載：來源 1＝npm 官方庫的 onnxruntime-node tgz（integrity 驗證），來源 2＝GitHub 分支 `native-runtime-1.22.0` 的釘住 commit SHA 的 raw 網址（`NATIVE_GITHUB_BASE`，分割段逐段 md5＋整檔 sha256）。`nr-*.js` 只有來源 2 有，或安裝目錄剛好有同樣內容的檔案。安裝到 `<userData>/native-runtime/<版本>/`，載入前 `checkNativeRuntimeDir` 全檔核對 md5。
- **為什麼需要新版本**：`nr-*.js` 內容變了，md5 釘住的舊執行包不可能「就地」變成新的，所以版本從 `1.22.0-1` 升到 `1.22.0-2`（新資料夾）。
- **使用者要重新下載嗎**：要按一次「安裝」，但**不重下載 onnxruntime**：安裝時以舊版資料夾當種子（`seedDirs`），sha256 一致的檔案直接沿用，只從來源 2 取變動的 `nr-*.js`（約 40 KB），也不連 npm。
- **舊執行包相容與降級**：`findNativeRuntime` 先找新版、再找舊版；舊版核對通過仍可用（原生推論照常、功能不減），只是 `FEATURES` 沒有 `lora`：`lora_apply` 回 `runtime_outdated`，畫面顯示「已安裝的原生執行包（1.22.0-1）不支援 LoRA，需要更新執行包到 1.22.0-2」，`applied` 為假；`NRL.forRun` 另外保證「已套用後執行包被換回舊版」時 run 會被拒絕而不是默默不用；子程序沒回報套用也視為失敗。新版安裝成功後才刪舊版（新版沒就緒時保留舊版當退路）。
- **新版尚未發佈時**：`NATIVE_GITHUB_BASE` 目前留空；按安裝會在下載前以 `runtime_not_published` 明確失敗並說明（不是靜默），舊版照常可用。
- **安裝目錄的舊 `nr-*.js`**：原先 `installRuntime` 在「本機 nr 檔與清單 sha256 不同」時直接丟錯；新版改為略過並改用來源 2（舊安裝包附的版本本來就會不同）。
- 真機評估腳本不再寫死版本資料夾：`scripts/eval/find_installed_runtime.js` 用主程式同一個 `findNativeRuntime`（新版優先、舊版退路、md5 核對）找最新已安裝版本；`native_real_install_eval.js`、`stack_route_native.js`（省略 `--runtime`）、`native_audio_e2e.js`（RUNTIME 填 `auto`）、`native_sdxs/run_pair.sh` 都用它；`tests/native/find_installed_runtime.test.js` 守住。注意：它與主程式一樣會核對平台／架構，32 位元的 node 會找不到 win32-x64 的執行包，要用 64 位元 node 或 Electron 跑。

### 9.4 要推到 GitHub 的檔案（等管理者決定；本工作階段沒有推送）
目標：倉庫 `sunneo/tw_stock_db` 的分支 `native-runtime-1.22.0`。檔案已產生在共用筆記資料夾 `native-runtime-1.22.0-2-push/`（`node scripts/native-runtime-refreeze-nr.js <輸出資料夾> --version 1.22.0-2 --features lora --all` 可重現）：
- `manifest.json`（18884 位元組，md5 `0f0752463232c87fb3143022ed82d826`；與 `main-ext.js` 內嵌的 `NATIVE_RUNTIME_MANIFEST` 內容相同，測試逐項比對）
- `parts/nr-child.js.001.part`（md5 `6178c509cd10e08e1608c6f12796f854`）、`parts/nr-engine.js.001.part`（`4a3723c6c21fa270c5b63df21afcb28b`）、`parts/nr-host.js.001.part`（`4ab2df1e1105d57c796bbe6eaeb478a7`）、`parts/nr-protocol.js.001.part`（`d04c81af2a86709497e8cca28bf4ac61`）——這四個內容相對 1.22.0-1 有變動
- `parts/nr-gen-params.js.001.part`、`nr-template.js.001.part`、`nr-tokenizer.js.001.part` 內容沒變（推不推都可以，內容相同）
推上去之後：取得新 commit SHA，把 `main-ext.js` 的 `NATIVE_GITHUB_BASE` 設成 `https://raw.githubusercontent.com/sunneo/tw_stock_db/<新 SHA>`，再依熱更新流程發佈 `main-ext.js`＋`floating-assistant.js`。注意：改了任何 `nr-*.js` 都要重跑上面的工具加 `--write-main-ext`（`native_lora.test.js` 會在清單與檔案不一致時失敗）。

### 9.5 驗證狀態（誠實）
- 有測（`tests/native/native_lora.test.js`，65 項）：協定驗證、`resolveLora` 各種失敗、用假的 onnxruntime 驗證 `externalData` 傳遞與 session 重建規則、host→真 `nr-child.js`（假引擎）轉傳與失敗原因、`NRL` 全部分支、執行包版本選擇與 md5 竄改退回舊版、升級沿用舊檔不連網、清單重算與嵌入一致、渲染端套用器。
- **沒測到**：真的用 LoRA 槽版 ONNX 在 onnxruntime-node 1.22.0 跑出「與基底不同的輸出」——本機沒有槽版模型（要 `make_lora_onnx.py build`，需要 Python、torch、onnx 與 Qwen3-0.6B 的 onnx 基底，都不在本機）；`lora-train/lora_ort_test.js` 先前已實測 `externalData` 選項在 1.22.0 可用，但不是經過這條鏈。**沒測到**：真 Electron 下的信箱往返（`lora_apply`）與 UI。這兩項要有槽版模型後用 `scripts/eval/studio.eval.js` 加一項。
- 實際使用還需要模型位置：原生模型路徑目前仍由環境變數指定，且必須是槽版模型；非槽版會回 `not_slot_model`。
