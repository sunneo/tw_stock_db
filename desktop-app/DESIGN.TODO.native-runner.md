# 原生推論執行器（native runner）設計與進度

狀態：實作中（2026-11-04）。這份文件是唯一的設計來源；每階段完成後在「進度」節更新。
標記：「實測」＝真 Electron 或真程式跑過；「推測」＝沒有量測；「外部資料」＝外部說法，本專案未驗證。

## 0. 共識（must，不可違反）

1. **只用標準輸入輸出（stdin/stdout，一行一則 JSON）加進度檔 `progress.jsonl`** 做主程序與子程序溝通。不用 HTTP、不開本機埠、不做伺服器模式。
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
- 協定（stdin/stdout，一行一則 JSON，欄位定義見 `protocol.js` 的 `MESSAGES`）：`hello`／`hello_ack`（版本號 1）、`load`、`run`（含 `stream`）、`cancel`、`dispose`；子程序回 `progress`、`token`、`done`、`error`（`code` 只能是 `protocol.js` 的 `ERROR_CODES` 其中之一：`load_failed`、`oom`、`timeout`、`cancelled`、`internal`、`crashed`、`version_mismatch`）、`cancelled`。`native_disabled` 由主程序產生，不經過子程序。協定沒有任何 HTTP 式欄位。
- 換行與編碼：一則一行、結尾 `\n`；解碼時去掉行尾 `\r`（Windows 的 CRLF 相容）；兩端都以 UTF-8 讀寫。子程序的日誌只寫 stderr，stdout 只放協定訊息。
- 行程管理差異（階段 5 的真引擎要沿用）：
  - Windows：`child.kill()` 結束行程（不送訊號）；`windowsHide: true`；路徑用 `path.join`，`userData` 來自 `app.getPath`。
  - Linux：`child.kill()` 送 SIGTERM，寬限後 SIGKILL；`exit` 事件的 `signal` 欄位要記錄；`userData` 路徑同樣由 `app.getPath` 取得。
  - 兩平台都用 `ELECTRON_RUN_AS_NODE=1` 與 `process.execPath`，不靠系統的 node。
- 驗收：
  - Windows：`node native-runner/native_runner.test.js` 19 passed（含真子程序的懶啟動、閒置關閉、崩潰重啟、連續崩潰停用、取消、逾時、串流、進度檔在強制結束後仍存在、版本不符）；真 Electron `scripts/eval/native_runner.eval.js` PASS（需 `FA_DEBUG_NATIVE_FAKE=1`）。
  - Linux：**未在 Linux 實跑**。驗證方式：同一份 `native_runner.test.js` 在 Linux 以 `node` 執行（程式不含 Windows 專屬呼叫）；`kill` 的 SIGTERM／SIGKILL 行為由程式碼審查確認。實跑要等有 Linux 環境（或 WSL）後補。
- 提交：`9e4d9a68`（協定與執行器）；`14bbd6af`（撤回 HTTP 並加入設定頁區塊）。
- 撤回紀錄：階段 4 的本機 HTTP 伺服器（提交 `2f124973`）已於 `14bbd6af` 撤回，因為共識要求只用標準輸入輸出。

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
  - 目前 `main.js` 與 `preload.js` 的改動（階段 3、4）需要一次安裝才會到達使用者。若要完全不重裝，需找出能在熱更新中替換的入口（`main-ext.js` 已在清單中，可以承接 IPC 註冊；但渲染程序的 `desktopAPI` 橋接在 `preload.js`，目前無通用通道）。**這是需要使用者決定的事（第 5 節）。**
- 驗收（Windows 與 Linux 各自）：
  - 下載驗證：sha256 不符時拒絕安裝並回報；中途斷線可續傳或重來。
  - 真 Electron：Windows 實跑；Linux 未在 Linux 實跑（標示限制，見階段 3 的說明）。
  - 退回：執行包不存在時，自動走 WebGPU／WASM，行為與改動前相同（比對 `backendOrder` 結果）。

### 階段 6：速度與正確率量測 — 尚未開始

- 目標：原生 CPU、WebGPU、WASM 的速度與正確率對照；固定 20 題，每組 3 次取中位數，超過 15 分鐘的組別標 `timeout`。
- 驗收：結果檔 `test-reports/native-bench-latest.json` 含每組 `median_ms`、`first_token_ms`、`peak_mb`、`crashes`、`accuracy`；Windows 實跑，Linux 標示未實跑（若無環境）。

## 4. 網頁版規則

1. 網頁版沒有 `window.desktopAPI`，所有原生分支以它守護，網頁版走舊路徑。
2. `resolveDevice` 的舊行為不變；`backendOrder` 在原生關閉時等價（已測）。
3. 網頁版的執行緒規則維持 `crossOriginIsolated`（由網頁版的 coi-serviceworker 提供）。
4. `renderer/src/floating-assistant.js` 是來源；`renderer/floating-assistant.js` 與 `.min.js` 由 `build-assistant.js` 產生，不手改。

## 5. 要使用者決定的事（每項附推薦）

1. **是否同意下載 onnxruntime-node（階段 5）？** 檔名：`onnxruntime-node`（npm）；來源：registry.npmjs.org；大小：全平台約 307.6 MB（最新版，metadata），單平台待量測。推薦：先量單平台大小後再同意。
2. **不重裝的做法**：要不要接受「第一次改動 main.js／preload.js 需要重裝一次」，還是改用 `main-ext.js` 承接 IPC、並在 preload 加一個通用通道（同樣要一次重裝）？推薦：先把執行器檔案改成頂層名稱並由 `main-ext.js` 承接；preload 的通用通道是一次性的成本，請決定是否接受。
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
| 本機 HTTP 伺服器（已撤回） | 撤回 | `2f124973` 撤回於 `14bbd6af` |
| 4 設定與介面 | 完成（區塊已接） | `14bbd6af` |
| 5 原生執行包 | 未開始，等使用者同意 | — |
| 6 量測 | 未開始 | — |
