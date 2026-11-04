# 原生推論執行器（native runner）設計定稿

狀態：定稿，可照著實作。本文件本身不改任何產品程式、不下載、不安裝。
範圍：桌面版（Electron）的離線模型（Qwen 文字、看圖、語音、音樂、本機生圖）能否改由子程序（或本機伺服器）推論，並保留網頁版現有路徑。
核對日期：2026-11-04（本次所有行號都用 Grep／Read 重新核對過，見第 9 節）。

標記：「實測」＝本專案真的量到或在本專案程式碼裡讀到；「推測」＝沒量測；「外部資料」＝引用外部說法，本專案未驗證。

---

## 0-A 桌面版專屬優勢盤點（2026-11-04，Grep 與讀程式核對）

原則：網頁版做不到的事，桌面版要用；只寫有證據的項目。「已用」＝專案程式實際在用；「未用」＝程式沒有，但桌面版技術上可做。

| 優勢 | 狀態 | 證據（本次核對） |
|---|---|---|
| 主程序開子程序（`child_process`） | 已用（shell 指令）；未用於推論 | `main.js:34` 引入 `execFile`、`spawn`；`main.js:1073` `runShellCommand` |
| 子程序的 utilityProcess／worker_threads | 未用 | Grep `utilityProcess`、`worker_threads` 在 `main.js` 無結果 |
| 直接讀寫本機檔案（主程序 `fs`） | 已用 | `main.js:94`、`103`、`147`、`105`、`114` 讀寫 `renderer/update-manifest.json` 與 live-patch 狀態檔；`ipcMain.handle` 共 51 個 |
| 不受網頁跨來源限制（file:// 載入） | 已用（目前唯一的頁面載入方式） | `main.js:1676`、`1855` `loadFile()` |
| SharedArrayBuffer 功能旗標 | 已用 | `main.js:29` `appendSwitch("enable-features","SharedArrayBuffer")` |
| COOP／COEP 標頭（跨來源隔離） | 已設但不生效 | `main.js:1837–1845` 設了標頭；註解 `main.js:1825–1836` 記載 file:// 下 `crossOriginIsolated` 仍為 false |
| 本機 HTTP 伺服器（只綁 127.0.0.1） | 已用（做代理，不載入頁面） | `local-proxy.js:378` `listen(port, "127.0.0.1")`；`local-proxy.js:86–87` 已帶 COOP／COEP 標頭 |
| 原生推論套件（onnxruntime-node、node-llama-cpp） | 未用 | `package.json` 依賴只有 `terser`（與 devDependencies） |
| 顯示卡原生路徑（DirectML、CUDA） | 未用（只用瀏覽器 WebGPU） | 專案內無 `onnxruntime-node`、`directml` 的程式引用（只有行為資料誤中） |
| 主程序取得真實記憶體與核心數 | 已用 | `main.js:586` `fa:system:info` 回傳 `os.totalmem()`、`os.freemem()`、`os.cpus()`；`preload.js` 暴露 `desktopAPI.systemInfo` |
| 不受瀏覽器記憶體與執行緒上限（Node 層級的 JS 旗標） | 未用 | Grep `js-flags`、`max-old-space` 在 `main.js` 無結果 |
| 麥克風與音訊裝置的原生存取（主程序） | 未用（只用渲染程序的 getUserMedia，與網頁相同） | Grep `systemPreferences`、`desktopCapturer` 在 `main.js` 無結果；`floating-assistant.js` 內 `getUserMedia` 出現於 `13363` 附近的行為資料與功能程式 |
| 模型快取放在使用者資料夾（不受瀏覽器配額） | 未用（目前在瀏覽器 CacheStorage） | colu 階段 6 記錄：快取在 `Service Worker\CacheStorage`（`DESIGN.TODO.colu-thinking.md`） |
| 預載腳本的 contextBridge 窄接口 | 已用 | `preload.js:8` `contextBridge.exposeInMainWorld("desktopAPI", …)` |

重點（推測與依據）：
- 跑模型或吃效能的功能，最大的桌面版優勢是「原生推論」與「主程序不受瀏覽器限制」，目前兩者都未用。
- 網頁版沒有這些能力，所以網頁版只能走 WebAssembly 與 WebGPU，這是退路，不是上限。

## 0-B 設計原則（依使用者要求，2026-11-04）

1. **凡是跑模型或吃效能的功能，先走桌面版原生路徑**（子程序，之後才是原生 ORT）；網頁版維持現有 WebAssembly／WebGPU 路徑當退路。
2. **不為了網頁版而限制桌面版**：網頁版不能做的，桌面版照做，只要網頁版的退路不被破壞。
3. 每個原生路徑都要有開關與退路（第 7 節）。

## 0. 結論摘要（先看這裡）

1. **第一件事不是寫原生程序，而是量清楚現在的 Qwen CPU 路徑到底用幾個執行緒。** 本次核對發現：第 0 步實測量的是 `loadOrt`（音訊、音樂路徑），但文字與看圖模型走的 `_vlmEnsureLoaded` 用的執行緒判斷是 `_omThreadSupport`，**不要求 crossOriginIsolated**，只要求 SharedArrayBuffer 存在且 WebAssembly 執行緒指令驗證通過（實測：`typeof SharedArrayBuffer` 在桌面版是 `function`）。所以 Qwen CPU 路徑**有可能已經是多執行緒**，這一點必須先量（階段 1），不能直接假設它是單執行緒。
2. **推薦路線（依序，後一項只在前一項量測後仍不夠時才做）：**
   - 路線 A（零套件）：階段 1 量測 → 階段 2 修正音訊路徑 `loadOrt` 的執行緒條件，並視需要讓桌面版頁面改用本機 `http://127.0.0.1` 提供（`local-proxy.js` 已有這個伺服器與 COOP／COEP 標頭，`main.js` 還沒切過去）。
   - 路線 B（子程序，只有 A 量測後仍慢才做）：階段 3 子程序執行器（標準輸入輸出一行一則 JSON＋進度檔），先用假的推論程式驗證協定，**不需要任何新套件**；階段 4 才決定要不要加入 `onnxruntime-node`。
   - 路線 C（選用，之後再說）：本機推論伺服器（階段 5）。
3. **不推薦現在就加入 GGUF 格式或 `node-llama-cpp`**：會換掉整條模型管線，需要使用者明確同意（第 8 節第 3 項）。

標記：第 1 點的「可能已是多執行緒」是**推測**，階段 1 才會實測確認。

---

## 1. 現況盤點（本次核對後的正確版本）

### 1.1 各離線模型怎麼跑

所有離線推論都在渲染程序（renderer）的 JavaScript 裡跑，用 WebAssembly（wasm）或 WebGPU。主程序（`main.js`）沒有任何推論程式。

| 功能 | 執行方式 | 位置（本次核對） |
|---|---|---|
| 文字 LLM（qwen3-0.6b 等） | Transformers.js 包 onnxruntime-web，裝置順序由 `resolveDevice` 決定 | 來源：`renderer/src/vlm/vlm_core.js:81–95`；嵌入副本：`renderer/src/floating-assistant.js:7322` |
| 看圖（VLM，florence、llava 等） | 同上，經 `_vlmRpc('run', …)` 送給 worker | `renderer/src/floating-assistant.js:99830`、`99862`、`99892`、`99923` 附近 |
| 聊天生成入口 `_llmGenerate` | 取裝置、載入、經 `guardedCall` 包 `_vlmRpc('chat', …)` | `renderer/src/floating-assistant.js:100645`（逾時與卸載在 `100658`–`100664`） |
| 載入與裝置降級 `_vlmEnsureLoaded` | 依 `resolveThreads` 決定 `threads` 傳給 worker | `renderer/src/floating-assistant.js:99697`；執行緒計算在 `99700`；傳給 worker 的 `threads` 在 `99711` |
| worker 主體 `faVlmWorkerMain` | 讀 `libUrl`，`env.backends.onnx.wasm.numThreads = m.threads` | `renderer/src/floating-assistant.js:50935`；設定執行緒在 `50950` |
| 音訊／音樂 ORT 載入 `loadOrt` | 設 `env.wasm.proxy`、`env.wasm.numThreads`；**numThreads 要求 `crossOriginIsolated`** | 來源：`renderer/src/music/audio_runtime.js:12`；嵌入副本：`renderer/src/floating-assistant.js:35216` |
| 本機生圖 SDXS＋TAESD | onnxruntime-web 1.22.0，WebGPU 或 WASM 二選一 | `renderer/src/floating-assistant.js:18097`–`18119`（模型表與後端選擇） |
| 作曲 midigenai | `vendor/midigenai/midigen-web.mjs` 自己判斷 `crossOriginIsolated` 決定執行緒 | `renderer/vendor/midigenai/midigen-web.mjs:75`、`81`、`354` |
| 語音辨識 Whisper | Transformers.js，裝置順序 webgpu → wasm | `floating-assistant.js` 內（舊草案行號 63465–63481，本次未逐一核對） |
| TTS（moss） | worker 內固定 `threads || 1`，`proxy = false` | `renderer/src/tts/moss_worker.js:73` |
| 網頁版的 code-ui 模型載入 | `threads` 只在 `crossOriginIsolated` 時 >1 | `renderer/src/code-ui.template.html:631` |

### 1.2 執行緒判斷：兩套規則（本次更正的重點）

| 路徑 | 判斷函式 | 需要什麼才會多執行緒 | 本專案實測 |
|---|---|---|---|
| 文字／看圖（`_vlmEnsureLoaded`） | `_omThreadSupport`（`floating-assistant.js:99624`）→ `_omCores`（`99640`）→ `resolveThreads`（`vlm_core.js:99–104`） | SharedArrayBuffer 存在、能傳給 worker、WebAssembly 執行緒指令驗證通過。**不要求 crossOriginIsolated**（`vlm_core.js:97–98` 註解也這樣寫） | 未量（見階段 1） |
| 音訊／音樂（`loadOrt`） | `audio_runtime.js:12` 與 `floating-assistant.js:35216` 內的一行 | `crossOriginIsolated === true` | 第 0 步：`false`，`numThreads = 1` |

更正：第 0 步的結論「WASM 是單執行緒」**只對 `loadOrt` 路徑成立**，不能推廣到 Qwen 路徑。

### 1.3 主程序已有的子程序與伺服器能力

- `main.js:34` 引入 `execFile`、`spawn`（`child_process`）；`main.js:1073` 的 `runShellCommand` 用 `spawn` 執行使用者要的 shell 指令（不是推論）。
- 沒有 `utilityProcess`、沒有 `worker_threads`（在主程序端）。
- `local-proxy.js` 已經有一個 HTTP 伺服器：`local-proxy.js:378` 綁 `127.0.0.1`，`local-proxy.js:86–87` 會對回應加上 `Cross-Origin-Opener-Policy: same-origin` 與 `Cross-Origin-Embedder-Policy: require-corp`，`local-proxy.js:41–42` 的註解寫明「要把 renderer 靜態檔改由這個伺服器提供，主程序改用 loadURL()」。**但 `main.js` 目前仍用 `loadFile()`**（`main.js:1676`、`main.js:1855`），所以這個方向還沒接上。
- `main.js:1817–1845`：COOP／COEP 標頭的 `webRequest.onHeadersReceived` 仍在，註解說明在 `file://` 下 `crossOriginIsolated` 仍是 false。
- `browser-control-server.js:12`：`DEFAULT_PORT = 17923`，本機瀏覽器控制占用這個埠，新增的任何伺服器都必須避開它。
- `package.json:21`：`"electron": "^44.4.0"`。依賴只有 `terser`，**沒有 `onnxruntime-node` 與任何原生推論套件**（實測：`package.json` 未列出）。

### 1.4 打包（實測）

- electron-builder 設定：`files` 含 `*.js`、`renderer/**/*`；`"asar": true`；有 `afterPack`。
- 目標：Windows `dir` 與 `nsis`（x64），Linux `AppImage`（x64）。**沒有 Mac 目標。**
- 目前沒有任何 `.node` 原生模組，所以沒有 `asarUnpack` 設定。

---

## 2. 候選方案比較（精簡版）

速度欄全部是**推測**，直到階段 1 與階段 6 量測為止。

| 方案 | 做法 | 新套件 | 打包增加 | 網頁版影響 | 整合難度 | 本文件的建議 |
|---|---|---|---|---|---|---|
| A1 音訊路徑 `loadOrt` 改條件 | 不再只看 `crossOriginIsolated`，改為看執行緒能不能用（與 `_omThreadSupport` 一致） | 無 | 無 | 無（同一份程式，網頁版仍由 `typeof` 守護） | 低 | **階段 2 做** |
| A2 桌面版頁面改 `http://127.0.0.1` 載入 | `main.js` 把 `loadFile` 換成 `local-proxy` 的 `loadURL` | 無 | 無 | 無（網頁版不經過 Electron） | 中（影響開機與熱更新覆蓋目錄） | **只在 A1 不夠時做**（階段 2 的第二步） |
| B 子程序（不含推論套件） | 新增子程序，先跑假推論，驗證協定與生命週期 | 無 | 無 | 無 | 中高 | **階段 3 做** |
| B+ 子程序＋`onnxruntime-node` | 子程序裡跑原生 ORT | 有（數十 MB，推測） | 增加，需 `asarUnpack` | 無 | 中高 | 階段 4 再決定（第 8 節第 2 項） |
| C 推論伺服器 | 子程序開本機 HTTP，只綁 `127.0.0.1` 加金鑰 | 無 | 無 | 無 | 中 | 階段 5，選用，之後再做 |
| D GGUF＋`node-llama-cpp` | 換格式、換管線 | 有（推測 100 MB 以上） | 大 | 網頁版保留 onnx，兩套模型 | 高 | **不建議，等使用者決定**（第 8 節第 3 項） |
| E DirectML（Windows GPU／NPU） | `onnxruntime-node` 的 DirectML 提供者 | 有（推測十幾 MB） | 中 | 無 | 中（B+ 的延伸） | 階段 4 之後再評估 |

---

## 3. 推薦路線與依據

1. **階段 1（實測，不改產品程式）**：量 Qwen CPU 路徑在 `threads = 1` 與 `threads = 有效值` 時的耗時與實際 `numThreads`。依據：`_vlmEnsureLoaded` 會傳 `th.effective` 給 worker（`floating-assistant.js:99711`），而 `th.effective` 不要求 `crossOriginIsolated`（`99624`–`99640`、`vlm_core.js:99–104`）。如果量到已多執行緒，後面的路線要降級。
2. **階段 2（小改動，桌面版）**：只有在階段 1 證明音訊路徑（`loadOrt`）有問題時才改，且改來源模組（`renderer/src/music/audio_runtime.js`），再用 `build-assistant.js` 產生嵌入副本。依據：音訊路徑（basic-pitch、Demucs、midigenai 的 `loadOrt` 呼叫者）與文字路徑的執行緒規則不一致。
3. **階段 2 的第二步（只在第 1 步不夠時）**：桌面版頁面改由 `local-proxy` 以 `http://127.0.0.1` 提供，`main.js` 改 `loadURL`。依據：這是讓 `crossOriginIsolated` 真的為 true 的唯一已知方法（`main.js:1817–1845` 註解的追查結果；`local-proxy.js:41–42` 的設計）。**代價：影響開機流程與熱更新覆蓋目錄（`main.js:1527` 的註解提到覆蓋目錄會用 `loadFile()`），風險高，要使用者決定（第 8 節第 1 項）。**
4. **階段 3（子程序，零套件）**：只有階段 1 與 2 量測後仍慢，或使用者要「放著跑」的長任務不卡主程序時才值得做。依據：子程序崩潰不會拖垮主程序；標準輸入輸出與進度檔的設計見第 4 節階段 3。
5. **階段 4（原生 ORT）**：只有階段 3 的協定穩定、且使用者同意加入套件後才做。
6. **階段 5（伺服器模式）**：選用，之後再說。

「放著跑、遠端跑」的使用情境（使用者在第 0 節之外提出）會讓「等得起來」變成比「快」更重要。CPU 上思考開啟約 61–113 秒（階段 6 實測），所以長任務要能取消、能看進度、崩潰能保留紀錄，這些由階段 3 的協定處理。

---

## 4. 分階段實作計畫

每個階段都有：目標、要改的檔案與函式（行號為本次核對結果）、驗收條件（程式可檢查）、風險、由誰做。**每次只有一個寫檔的人（Haiku 一次一個寫檔者）**，不同階段不平行寫同一批檔案。

### 階段 1：量測 Qwen CPU 路徑的執行緒（實測，不改產品程式）

- **目標**：在真 Electron 裡，同一組固定題目，比較 `threads = 1` 與 `threads = 有效值` 的耗時；同時記錄 worker 內實際的 `numThreads`、`crossOriginIsolated`、`typeof SharedArrayBuffer`。
- **要改的檔案**：新增 `desktop-app/scripts/eval/native_threads_vlm.eval.js`（新檔）；結果檔 `desktop-app/test-reports/native-threads-vlm-latest.json`（新檔）。
  - 參考寫法：`scripts/eval/colu_think_reflect_cpu.eval.js`（真 Electron、暫存副本、重用已快取模型、不下載）與 `scripts/eval/wasm_threads.eval.js`（記錄 `crossOriginIsolated` 與 `SharedArrayBuffer`）。
  - 執行環境：`scripts/eval/run_eval.js`（獨立使用者資料夾、換埠）。
  - 不改 `floating-assistant.js` 與 `renderer/src/`；在暫存副本建置後量測（與階段 7 任務 D 做法相同）。
- **固定題目規格**：
  - 6 題封閉題，為封閉題（思考關，`maxTokens` 32，`deterministic: true`），題目由執行者在腳本內自行撰寫並寫死，不從外部讀；撰寫時參考 `colu_think_real.eval.js` 的封閉題格式（該檔的題目本身未逐一核對）。
  - 兩組設定：`threads = 1` 與 `threads = th.effective`（由 `resolveThreads` 算）。每組每題跑 1 次。
  - 逐題進度輸出到 stdout，一行一題：`[組 threads=N] [題 i/6] 開始` 與 `… 結束 耗時 X 秒 答案 Y`。
  - 結果檔寫入 `test-reports/native-threads-vlm-latest.json`，欄位：`cross_origin_isolated`、`sab_type`、`hardware_concurrency`、`observed_num_threads`（worker 內讀到的值）、每組的 `median_ms`、`max_ms`、`answers`。
  - **總時間上限 15 分鐘**：腳本內計時，超過 900 秒就中止並把已完成的題寫進結果檔，`verdict` 設為 `timeout`。
- **驗收條件**：
  - 腳本存在：`scripts/eval/native_threads_vlm.eval.js`。
  - 結果檔存在且 JSON 可解析，`verdict` 為 `done` 或 `timeout`（不能是空白）。
  - `done` 時 `groups` 有 2 組、每組 6 筆、`observed_num_threads` 為整數。
  - 結論寫進本文件第 10 節「階段 1 實測結果」，並標明「實測」與「推測」。
- **風險**：模型未快取時會下載（違反本階段「不下載」規則）。處理：先檢查快取（沒有就停止並回報，不下載）。CPU 題目單題可能 100 秒以上（階段 6 實測），6 題 ×2 組 約 10–20 分鐘，**可能觸及 15 分鐘上限**，超時時以結果檔為準，不重跑。
- **由誰做**：Haiku（寫腳本與執行），結論由管理層核對。

### 階段 2：修正音訊路徑的執行緒條件（與可選的本機 http 載入）

- **目標（2a）**：`loadOrt` 的 `numThreads` 條件與文字路徑一致，改為「SharedArrayBuffer 存在且 WebAssembly 執行緒指令驗證通過」，不再只看 `crossOriginIsolated`。
- **要改的檔案（2a）**：
  - 來源：`renderer/src/music/audio_runtime.js:12`（`loadOrt`）。
  - 重新產生嵌入副本：執行 `build-assistant.js`（產生 `renderer/src/floating-assistant.js` 內 `35216` 那一行，與 `renderer/floating-assistant.min.js`）。**不手改嵌入副本**（使用者記憶：嵌入來源模組要改來源，改嵌入會被蓋掉）。
  - 不改 `renderer/vendor/midigenai/midigen-web.mjs`（第三方 vendor，另議）。
  - 條件判斷可共用 `vlm_core.js` 的 `resolveThreads`，但音訊模組不 import 文字模組，所以只複製一小段判斷，並在註解寫明「與 `vlm_core.js` 的 `resolveThreads` 同一規則」。
- **驗收條件（2a）**：
  - 新增 `scripts/music-tests/audio_runtime.test.js` 的一項檢查：在 `crossOriginIsolated = false` 且 SharedArrayBuffer 存在的假環境裡，`loadOrt` 設的 `numThreads > 1`。
  - 現有 `scripts/music-tests/audio_runtime.test.js` 全部通過（`gpu1.env.wasm.numThreads >= 1` 那一項不退步）。
  - 真 Electron 評估（新增 `scripts/eval/loadort_threads.eval.js`）：`loadOrt({})` 後 `ort.env.wasm.numThreads > 1`，`verdict: PASS`。
- **風險**：多執行緒 wasm 在 `file://` 未隔離下是否穩定，未驗證。若出現崩潰或結果錯誤，回退方法：把條件改回 `crossOriginIsolated`（一行），重新建置。
- **目標（2b，只在階段 1 證明文字路徑也受限、或 2a 後音訊仍慢時才做）**：桌面版頁面改由本機伺服器載入，讓 `crossOriginIsolated` 為 true。
- **要改的檔案（2b）**：`main.js:1676`、`main.js:1855`（`loadFile` → `loadURL`）；`local-proxy.js`（確認 `renderer/` 靜態檔服務、COOP／COEP 標頭、只綁 `127.0.0.1`）；`main.js:1527` 附近的覆蓋目錄（熱更新）邏輯要一起改。
- **驗收條件（2b）**：真 Electron 評估 `scripts/eval/coi_http.eval.js`（新檔）：頁面 `crossOriginIsolated === true`；`typeof SharedArrayBuffer === 'function'`；熱更新覆蓋目錄仍能載入（另一項）；跨來源 CDN 載入（`cdn.jsdelivr.net` 的 ORT、Transformers.js）在 `require-corp` 下仍能載入（列出每個網址的結果）。
- **風險**：COEP `require-corp` 會擋掉沒有 CORS 標頭的跨來源資源；熱更新覆蓋目錄改載入方式；`file://` 使用者資料路徑。**這是架構層改動，必須先問使用者（第 8 節第 1 項）。**
- **由誰做**：Haiku（2a 寫檔）；2b 必須在使用者同意後才開始。

### 階段 3：子程序執行器與通訊協定（零新套件）

- **目標**：主程序能啟動、管理一個子程序，子程序用假的推論程式（不載入 ORT）驗證協定。
- **要改的檔案（新增）**：
  - `desktop-app/native-runner/native-runner-host.js`（主程序端，生命週期與協定）。
  - `desktop-app/native-runner/native-runner-child.js`（子程序端，先只回假結果）。
  - `desktop-app/native-runner/protocol.js`（訊息種類與欄位表，主程序與子程序共用；單一來源）。
- **要改的檔案（既有）**：`main.js`（註冊 IPC 與啟動時機，**只加掛鉤，不改現有流程**）；`renderer/src/vlm/vlm_core.js`（只在階段 4 才加 `'native'` 裝置，本階段不動）。
- **子程序種類**：先用 Electron 內建的 `utilityProcess.fork`（API 名稱與行為尚未驗證，見第 6 節；若不可用就用 `child_process.fork`）。
- **生命週期**：
  - 懶啟動：第一次要推論時才啟動，不在 app 啟動時啟動。
  - 閒置關閉：超過設定時間（預設值待決定，第 8 節第 5 項）就結束子程序並釋放資源。
  - 崩潰重啟：子程序非預期結束時，記錄退出碼與最後一則錯誤，自動重啟一次；連續兩次失敗就停用原生路徑，回退 WebGPU／WASM，並把**真實原因**告訴使用者（退出碼、signal、最後錯誤訊息，依使用者的偏好要有具體事實）。
  - 取消：每次推論有 `id`，主程序送 `cancel` 後子程序停止生成並回 `cancelled`。
  - 逾時：沿用現有 `FaRecipe.guardedCall`（`renderer/src/recipe/recipe_core.js:166`）的語意：到 `timeoutMs` 先送中斷，寬限 5 秒後終止子程序，呼叫端拿到 `err.timeout === true`。
- **通訊協定（標準輸入輸出，一行一則 JSON）**：

| 方向 | `type` | 必填欄位 | 說明 |
|---|---|---|---|
| 主→子 | `hello` | `v`（協定版本，本版為 1）、`id` | 第一則，子程序回 `hello_ack` 才算就緒 |
| 主→子 | `load` | `id`、`model_path`、`device`、`threads`、`dtype` | 只傳檔案路徑，不傳位元組 |
| 主→子 | `run` | `id`、`messages`、`max_tokens`、`timeout_ms`、`stream`（布林） | 串流時子程序逐 token 回 `token` |
| 主→子 | `cancel` | `id`（指向要取消的 run） | 子程序收到後回 `cancelled` |
| 主→子 | `dispose` | `id` | 釋放模型後結束 |
| 子→主 | `hello_ack` | `id`、`v`、`pid` | |
| 子→主 | `progress` | `id`、`stage`（`read`／`session`／`generate`）、`pct` 或 `tokens` | 進度 |
| 子→主 | `token` | `id`、`text` | 串流 |
| 子→主 | `done` | `id`、`ok`（布林）、`text`、`ms`、`finish_reason` | 結束；`ok:false` 時必有 `error` |
| 子→主 | `error` | `id`、`code`、`message`、`http_like`（數字或 null） | `code` 只能是：`load_failed`、`oom`、`timeout`、`cancelled`、`internal` |
| 子→主 | `cancelled` | `id` | |

- **進度檔（`progress.jsonl`）**：子程序每一則 `progress` 與 `token` 也追加寫到使用者資料夾下的 `native-runner/progress.jsonl`（每行一則 JSON，附時間戳）。子程序崩潰後，主程序讀這個檔就能拿到崩潰前的進度，這是第 0 節使用者想法中「檔案溝通」的用途。
- **版本號**：`protocol.js` 的 `v` 必須與子程序一致，不一致就拒絕啟動並回報原因（不靜默降級）。
- **驗收條件**（新增 `scripts/eval/native_runner_protocol.eval.js`，真 Electron，**不載入 ORT、不下載模型**，子程序是假的推論程式）：
  - `lazy_start`：啟動 app 時子程序數為 0；第一次 `run` 後為 1。
  - `idle_close`：閒置超過測試用的 3 秒後子程序結束。
  - `crash_restart_once`：送 `kill` 後自動重啟一次，之後的 `run` 成功。
  - `crash_twice_fallback`：連續兩次崩潰後，回報 `native_disabled` 且附原因。
  - `cancel`：長任務送 `cancel` 後 3 秒內回 `cancelled`。
  - `timeout`：`timeout_ms: 3000` 的假長任務在約 8 秒（3 秒＋5 秒寬限）內拋 `timeout`。
  - `stream`：假推論逐 token 回傳，主程序收到的 token 數等於假推論送出的數。
  - `progress_survives_kill`：子程序被強制結束後，`progress.jsonl` 仍有崩潰前的進度行。
  - `version_mismatch`：送錯的 `v` 時拒絕啟動並回報版本原因。
  - 評估檔 `verdict: PASS` 且所有項目通過。
- **風險**：Windows 上標準輸入輸出的緩衝與換行（`\r\n`）處理；子程序的 stdout 混入非 JSON 的日誌（規定：子程序只能用 `stderr` 寫日誌，`stdout` 只放協定訊息）。
- **由誰做**：Haiku（協定與主程序端）；子程序的假推論程式與評估檔為同一個人，寫完後跑評估。

### 階段 4：統一推論後端介面，並接入原生 ORT（需使用者同意加入套件）

- **目標**：後端順序為「原生（子程序＋`onnxruntime-node`）→ WebGPU → WASM」，由 `resolveDevice` 統一決定。
- **前置條件**：使用者同意加入 `onnxruntime-node`（第 8 節第 2 項）；階段 3 的評估全部 PASS。
- **要改的檔案**：
  - 來源：`renderer/src/vlm/vlm_core.js:81`（`resolveDevice`）新增 `'native'` 選項，排在 `'webgpu'` 前面；`vlm_core.test.js` 新增測試。
  - 嵌入副本：`renderer/src/floating-assistant.js:7322` 由 `build-assistant.js` 重新產生，不手改。
  - `renderer/src/floating-assistant.js:99697`（`_vlmEnsureLoaded`）新增原生分支；`100645`（`_llmGenerate`）對原生分支改走子程序，串流 token 仍轉成現有的 `cb.update` 介面。
  - `package.json`：加入 `onnxruntime-node`（**需先問**）；`build` 設定加入 `asarUnpack`（見第 6 節）。
- **介面草案（只寫形狀）**：`backend.available()` → `{ok, reason}`；`backend.load(modelSpec, {onProgress})` → `session`；`session.run(inputs, {signal, timeoutMs, onToken})`；`session.dispose()`。
- **驗收條件**：
  - `vlm_core.test.js` 原有測試全部通過（`resolveDevice` 舊行為不變：沒有 `native` 時回傳值與現在完全相同）。
  - 新增測試：`resolveDevice` 在 `preference` 為預設且 `native` 可用時，`order[0] === 'native'`；不可用時退回原順序。
  - 真 Electron 評估 `scripts/eval/native_vs_wasm.eval.js`（新檔）：同一題，原生與 WASM 的答案一致（字串完全相同或 6 題中至少 5 題一致，門檻先由使用者決定）。
- **風險**：`onnxruntime-node` 與 `onnxruntime-web` 的模型輸入輸出名稱與型別可能不同（外部資料，未驗證）；Transformers.js 的文字模型可能不直接用 ORT API，**需要先確認 Transformers.js 能不能換後端**，不能換就只有 SDXS 與 midigenai 能走原生。
- **由誰做**：Haiku（一次一個檔案）。

### 階段 5（選用）：本機推論伺服器

- **目標**：子程序開一個只綁 `127.0.0.1` 的 HTTP 伺服器，讓桌面版以外的程式（遠端工具、網頁版同機）共用同一份模型。
- **要改的檔案（新增）**：`desktop-app/native-runner/server.js`；金鑰檔放在使用者資料夾，首次啟動隨機產生 32 位元組。
- **規格**：
  - 只綁 `127.0.0.1`（不綁 `0.0.0.0`）。
  - 每個請求要有 `Authorization: Bearer <金鑰>`，沒有或錯誤回 401。
  - 埠預設 `17924`（**不可用 17923**，`browser-control-server.js:12` 已占用），設定可改，遇到占用就回報並拒絕啟動。
  - 只提供 `POST /v1/run`（與階段 3 的 `run` 相同語意）與 `GET /v1/health`。
- **驗收條件**（新增 `scripts/eval/native_server.eval.js`）：`127.0.0.1` 可連、`0.0.0.0` 或區網 IP 連不上、無金鑰 401、錯金鑰 401、正確金鑰 200、預設埠不是 17923 且被占用時回報原因。
- **風險**：金鑰外洩即等於開放本機模型，金鑰只寫入使用者資料夾，不寫進程式或日誌。與遠端使用的關係：這一階段只做本機；遠端存取需要另一份設計（不在本文件範圍）。
- **由誰做**：Haiku。**只有使用者確認要做時才開始。**

### 階段 6：評估與基準（原生對 WASM 的速度與正確率）

- **目標**：比較「WASM 單執行緒（若可量）、WASM 多執行緒、WebGPU、原生 CPU、原生 DirectML（若有 Windows 獨立顯示卡）」的速度、首 token 延遲、峰值記憶體、崩潰次數、正確率。
- **題目規格**：20 題（使用者原始要求是 20 題以上；階段 6 colu 量測曾縮成 8 題，因為 CPU 單組可達一小時以上，本階段要照原要求 20 題，超過時間就回報）。題目寫死在腳本，不隨機抽樣；每組跑 3 次取中位數（與第 4 節第 1 步的假題目做法一致）。
- **要改的檔案（新增）**：`scripts/eval/native_bench.eval.js`（新檔），結果寫入 `test-reports/native-bench-latest.json`。
- **驗收條件**：結果檔含每組的 `median_ms`、`first_token_ms`、`peak_mb`、`crashes`、`accuracy`（正確題數／20）；本文件第 10 節補上結論，並標明「實測」與「推測」；超過 15 分鐘的組別標 `timeout` 而不是省略。
- **風險**：DirectML 只限 Windows，且依硬體，本專案開發機的顯示卡與使用者機器可能不同，結論只對量測機器有效。
- **由誰做**：Haiku（寫腳本）；結果解讀由管理層做。

---

## 5. 網頁版保留現有路徑的明確規則

網頁版（`web/`、GitHub Pages 載入的版本）沒有 Electron 主程序，所以：

1. **不加任何原生分支會被執行**：所有原生相關程式都要以「桌面版才有的橋接物件」守護（名稱在階段 3 定義，由 preload 注入，網頁版不存在），並以 `typeof` 檢查；網頁版時守護條件為假，`resolveDevice` 不會回傳 `native`。
2. **`resolveDevice` 的舊行為不變**：`vlm_core.test.js` 既有測試與新測試都要通過。
3. **執行緒規則**：網頁版（GitHub Pages）的跨來源隔離由 coi-serviceworker 提供（`main.js:1821–1823` 註解記載 `web/index.html` 的做法，位於倉庫根的 `web/`）。階段 2a 的改動必須讓網頁版的結果與改動前相同（用 `typeof` 守護，網頁版 `crossOriginIsolated` 為 true 時兩種條件結果一致）。
4. **設定介面**：`native` 選項只在桌面版顯示（階段 6 的設定面板）。
5. **不改網頁版的 `loadOrt` 參數**：網頁版仍用現有 `ORT_URL`（CDN，`renderer/src/music/audio_runtime.js:6`）。
6. **既有的嵌入副本**：`renderer/src/floating-assistant.js` 與 `renderer/floating-assistant.min.js` 由 `build-assistant.js` 產生，改動一律改來源，不手改嵌入副本。

---

## 6. 打包與跨平台（需下載或安裝的項目）

**全部需先問使用者（第 8 節）。本文件不下載任何東西。** 大小一律為**推測**，要在真正要安裝前用 `npm view` 或實際下載量測。

| 項目 | 來源 | 大小（推測） | 用途 | 階段 | 授權 |
|---|---|---|---|---|---|
| `onnxruntime-node`（npm） | npm registry | 數十 MB（含各平台二進位，推測） | 原生 CPU 後端 | 4 | MIT（外部資料，未驗證） |
| `onnxruntime-node` 的 DirectML 版本 | 需確認來源 | 十幾 MB（推測） | Windows GPU／NPU | 6 | 需另外查（未確認） |
| Electron `utilityProcess` API | 內建於 Electron ^44.4.0 | 無 | 子程序 | 3 | 無 |
| `node-llama-cpp`（方案 D，不建議） | npm | 100 MB 以上（推測） | GGUF 後端 | 無（不排入） | MIT（外部資料） |
| GGUF 模型檔（方案 D，不建議） | Hugging Face（來源需確認） | 依模型大小（推測） | 換格式用 | 無（不排入） | 各模型另查 |
| 量測用假題目與假推論程式 | 本專案產生 | 極小 | 階段 3 與階段 1 | 1、3 | 無 |
| `qwen3-0.6b` ONNX 權重（已快取） | HF `onnx-community/Qwen3-0.6B-ONNX` | GPU 543 MB、CPU 589 MB（`renderer/src/vlm/vlm_core.js:30–32` 模型表） | 階段 1 與 6 量測，**已快取，不需下載** | 1、6 | Apache-2.0（模型表記錄） |

打包細節（階段 4 才需要，需實測）：
- `onnxruntime-node` 的原生二進位（`.node` 與共享函式庫）不能放在 asar 內，要加 `asarUnpack`，範圍需按套件實際路徑確認（**未驗證**，外部資料提到的是 `onnxruntime_binding.node` 與 onnxruntime 共享函式庫，DirectML 另有 `DirectML.dll`）。
- Windows 與 Linux 的二進位不同，build 要按平台分開；Linux 目標是 AppImage x64。
- 目前沒有 Mac 打包目標，原生路徑先只做 Windows；Mac 不在範圍內（第 8 節第 4 項）。
- 驗收：打包後安裝到乾淨使用者資料夾，原生路徑能載入，且 asar 內找不到 `.node`（用 `asar list` 或 Electron 的 `process.resourcesPath` 檢查）。

---

## 7. 風險與回退（每階段）

| 階段 | 主要風險 | 怎麼關掉 | 舊行為如何保留 |
|---|---|---|---|
| 1 | 模型未快取時下載 | 腳本先檢查快取，沒有就停（不下載） | 只讀，不改產品程式 |
| 2a | 多執行緒 wasm 在 `file://` 下不穩 | 把條件改回 `crossOriginIsolated`（一行），重建 | 網頁版結果不變（第 5 節第 3 點） |
| 2b | 熱更新覆蓋目錄、COEP 擋資源、使用者資料路徑 | 改回 `loadFile()`（`main.js:1676`、`1855`），本機伺服器不啟動 | 保留 `loadFile` 分支，用設定切換（預設不切） |
| 3 | 子程序殘留、崩潰循環、標準輸出混入日誌 | 閒置關閉、崩潰兩次停用原生、日誌只走 stderr | 子程序沒啟動時完全不影響現有流程 |
| 4 | ORT 輸入輸出不符、Transformers.js 不能換後端、asar 內找不到 `.node` | 設定開關預設關；`resolveDevice` 的 `native` 只在開關開時出現 | `resolveDevice` 舊測試全部保留 |
| 5 | 金鑰外洩、埠衝突 | 預設不啟動；金鑰只存使用者資料夾；不綁非本機位址 | 不啟動時完全不存在 |
| 6 | 結論只對量測機器有效 | 結果檔標明機器資訊；不把結論寫成通用規則 | 不改產品預設值 |

**總體回退**：每個階段都可以用一個設定開關關掉（預設關），關掉後行為與改動前相同。在階段 4 之前，產品程式的預設行為不變。

---

## 8. 要問使用者的決定（每項附推薦與理由，不由我們決定）

1. **要不要做階段 2b（桌面版頁面改由本機 `http://127.0.0.1` 載入）？**
   - 推薦：**先不做**，等階段 1 與 2a 的量測結果再決定。
   - 理由：這會改開機流程與熱更新覆蓋目錄，且 COEP 可能擋掉跨來源 CDN 資源；2a 可能已足夠。
2. **要不要加入 `onnxruntime-node`（階段 4，會增加數十 MB，需 `asarUnpack`，按平台分包）？**
   - 推薦：**等階段 3 的協定評估全部通過後再決定**。
   - 理由：協定沒驗證前加套件，出問題無法分辨是套件還是協定造成。
3. **要不要接受 GGUF 格式（方案 D，等於重新下載模型並維護兩套格式）？**
   - 推薦：**不接受**。
   - 理由：現有 onnx 模型表與快取都可用；換格式會影響所有離線功能，效益要先由階段 6 證明。
4. **原生路徑只做 Windows，還是也要 Linux？**
   - 推薦：**先只做 Windows**（使用者的機器與量測都在 Windows）。
   - 理由：Mac 目前沒有打包目標；Linux 有 AppImage，但沒有量測資料。
5. **閒置多久關閉子程序？**
   - 推薦：**10 分鐘**（而不是原本草案的 5 分鐘）。
   - 理由：使用者的情境是「放著跑」，5 分鐘可能在等待中途被關掉；10 分鐘在記憶體與等待之間取得平衡（推測，未量測）。
6. **原生路徑失敗時，是否自動退回 WebGPU／WASM 並告訴使用者真實原因？**
   - 推薦：**是**，並顯示退出碼與最後錯誤訊息。
   - 理由：使用者偏好要有具體事實，靜默退回會讓問題看不出來。
7. **崩潰自動重啟次數？**
   - 推薦：**1 次**，連續兩次失敗就停用原生路徑。
   - 理由：重啟太多次會讓長任務卡住，且掩蓋真正的錯誤。
8. **階段 1 量測的時間上限（15 分鐘）與題數（6 題）是否可以？**
   - 推薦：**可以**。
   - 理由：6 題 ×2 組的 CPU 時間約 10–20 分鐘（推測），超過就用已完成的結果，不重跑。
9. **階段 6 的題數要照原要求 20 題，還是沿用階段 6 colu 的 8 題？**
   - 推薦：**20 題**（照原要求）；CPU 組合可能超過一小時，超過時間就標 `timeout`。
   - 理由：8 題的樣本太小，不足以做結論（階段 6 colu 記錄自己也這樣寫）。
10. **原生正確率的門檻：字串完全相同，還是 6 題中至少 5 題一致？**
    - 推薦：**完全相同**（只對確定性解碼，`deterministic: true`），因為貪婪解碼下應該完全一致；不一致就是實作錯誤。
    - 理由：寬鬆門檻會掩蓋實作錯誤。
11. **`midigenai` 模型授權未確認（程式中已標示「未確認」），在原生路徑擴大使用前是否先確認？**
    - 推薦：**先確認再擴大**。
    - 理由：原生路徑讓更多使用者能用，授權風險也隨之增加。
12. **階段 2a 改動音訊路徑的條件，是否接受「只要 SharedArrayBuffer 存在就多執行緒」？**
    - 推薦：**接受，並以階段 2a 的評估檔驗證**。
    - 理由：與文字路徑的規則一致；若驗證有問題，回退只需改一行。

---

## 9. 行號核對表（本次用 Grep／Read 核對，2026-11-04）

以下是本文件引用的行號。舊草案的行號與現況有差異（例如 `loadOrt` 舊為 35187、現為 35216；`_llmGenerate` 舊為 100376–100395、現為 100645），本表以現況為準。

| 引用 | 檔案:行號 | 核對方式 |
|---|---|---|
| `resolveDevice`（來源） | `renderer/src/vlm/vlm_core.js:81–95` | Read |
| `resolveThreads`（來源） | `renderer/src/vlm/vlm_core.js:99–104` | Read |
| `resolveDevice`（嵌入副本） | `renderer/src/floating-assistant.js:7322` | Grep |
| `resolveThreads`（嵌入副本） | `renderer/src/floating-assistant.js:7340` | Grep |
| `loadOrt`（來源） | `renderer/src/music/audio_runtime.js:12` | Grep |
| `loadOrt`（嵌入副本） | `renderer/src/floating-assistant.js:35216` | Grep |
| `ORT_URL`（來源） | `renderer/src/music/audio_runtime.js:6` | Grep |
| `faVlmWorkerMain` | `renderer/src/floating-assistant.js:50935` | Grep |
| worker 設定 `numThreads` | `renderer/src/floating-assistant.js:50950` | Read |
| `_omSettings` | `renderer/src/floating-assistant.js:99615` | Grep |
| `_omThreadSupport` | `renderer/src/floating-assistant.js:99624` | Grep |
| `_omCores` | `renderer/src/floating-assistant.js:99640` | Grep |
| `_omGpuInfo` | `renderer/src/floating-assistant.js:99642` | Grep |
| `_vlmWorkerGet` | `renderer/src/floating-assistant.js:99658` | Grep |
| `_vlmRpc` | `renderer/src/floating-assistant.js:99673` | Grep |
| `_vlmTerminate` | `renderer/src/floating-assistant.js:99678` | Grep |
| `_vlmCancelIdle` | `renderer/src/floating-assistant.js:99683` | Grep |
| `_vlmScheduleIdle` | `renderer/src/floating-assistant.js:99684`（行首為省略的長行） | Grep |
| `_vlmProgressAgg` | `renderer/src/floating-assistant.js:99685` | Grep |
| `_vlmEnsureLoaded` | `renderer/src/floating-assistant.js:99697` | Grep |
| `th = resolveThreads(...)` | `renderer/src/floating-assistant.js:99700` | Grep |
| `load` 傳 `threads` | `renderer/src/floating-assistant.js:99711` | Grep |
| 看圖 `_vlmRpc('run', …)` | `renderer/src/floating-assistant.js:99832`、`99864`、`99894`、`99925` | Grep |
| `_coluDeviceOf` | `renderer/src/floating-assistant.js:100384` | Grep |
| `_omDevicePrefOf` | `renderer/src/floating-assistant.js:100642` | Grep |
| `_llmGenerate` | `renderer/src/floating-assistant.js:100645` | Grep |
| `_llmGenerate` 內 `guardedCall` 與 `_vlmRpc('chat', …)` | `renderer/src/floating-assistant.js:100660` | Grep |
| 設定面板 CPU 核心上限輸入 | `renderer/src/floating-assistant.js:100848` | Grep |
| SDXS 模型表 | `renderer/src/floating-assistant.js:18097`–`18099` | Grep |
| `guardedCall`（來源） | `renderer/src/recipe/recipe_core.js:166` | Grep |
| `guardedCall`（嵌入副本） | `renderer/src/floating-assistant.js:8636` | Grep |
| midigenai 執行緒判斷 | `renderer/vendor/midigenai/midigen-web.mjs:75`、`81`、`354` | Grep |
| TTS worker `numThreads` | `renderer/src/tts/moss_worker.js:73` | Grep |
| 網頁版 code-ui 執行緒 | `renderer/src/code-ui.template.html:631` | Grep |
| 主程序 COOP／COEP 註解 | `main.js:1817–1836` | Read |
| 主程序 COOP／COEP 標頭 | `main.js:1837–1845` | Read |
| 主程序 `loadFile`（開機） | `main.js:1676`、`main.js:1855` | Grep |
| 熱更新覆蓋目錄註解 | `main.js:1527` | Grep |
| `runShellCommand`（shell 指令，非推論） | `main.js:1073` | Grep（舊草案寫 1084，已更正為 1073） |
| `child_process` 引入 | `main.js:34` | Grep |
| `local-proxy` 設計註解 | `local-proxy.js:41–42` | Read |
| `local-proxy` 監聽 `127.0.0.1` | `local-proxy.js:378` | Grep |
| `local-proxy` COOP／COEP 標頭 | `local-proxy.js:86–87` | Grep |
| 瀏覽器控制埠 | `browser-control-server.js:12`（`DEFAULT_PORT = 17923`） | Grep |
| electron 版本 | `package.json:21`（`"electron": "^44.4.0"`） | Grep |
| 音樂測試（執行緒檢查） | `scripts/music-tests/audio_runtime.test.js:18` | Grep |
| 階段 1 參考腳本 | `scripts/eval/colu_think_reflect_cpu.eval.js`、`scripts/eval/wasm_threads.eval.js`、`scripts/eval/run_eval.js` | 檔案存在（ls） |
| vlm 執行緒單元測試 | `renderer/src/vlm/vlm_core.test.js:29–33` | Grep |

未逐一核對（標示為舊行號，實作前必須重新核對）：第 1.1 節 Whisper 與 Demucs 的行號、`sdxs` 之外的本機生圖細節。

---

## 10. 實測結果

### 10.1 第 0 步實測（2026-11-04，保留原結果並加註）

量測腳本：`scripts/eval/wasm_threads.eval.js`，用真 Electron（`scripts/eval/run_eval.js`，獨立使用者資料夾、換埠），不下載任何模型。

| 項目 | 結果 |
|---|---|
| 頁面協定 | `file:` |
| `crossOriginIsolated` | `false` |
| `navigator.hardwareConcurrency` | `4` |
| `typeof SharedArrayBuffer` | `function`（存在，但因非隔離狀態不能用於 `loadOrt` 的多執行緒條件） |
| 工作者（Blob 來源）內 `crossOriginIsolated` | `false`，`SharedArrayBuffer` 為 `function` |
| `navigator.gpu` | 存在（只量到物件存在，未驗證能否取得 adapter） |
| `loadOrt({})` 之後 `ort.env.wasm.numThreads` | `1` |
| `loadOrt({})` 之後 `ort.env.wasm.proxy` | `true` |
| `loadOrt({proxy:false})` 之後 `numThreads` / `proxy` | `1` / `false` |
| ORT 版本 | onnxruntime-web `1.22.0` |
| `wasmPaths` | `https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/` |

**更正（本次核對）**：上表結論「WASM 是單執行緒」只對 `loadOrt` 路徑成立（第 1.2 節）。文字與看圖路徑的執行緒判斷不要求 `crossOriginIsolated`，它們的實際執行緒數**尚未量測**（階段 1）。

### 10.2 階段 1 實測結果

（尚未執行。階段 1 完成後由執行者填入：`verdict`、各組 `median_ms`、`observed_num_threads`、結論，並標明「實測」與「推測」。）

---

## 11. 使用者想法：子程序溝通方式（2026-11-04，逐字）

> 用subprocess的時候，應該可以用stdin,stdout, 或檔案溝通來達到像是在一個任務完成之前持續溝通，或者透過開一個小小的local llm server，然後跟server溝通

管理層整理（設計判斷，未實測）：
- 標準輸入輸出，一行一則 JSON：串流逐字輸出、進度、中途取消；只有桌面版主程序與子程序一對一可用。已納入第 4 節階段 3 的協定表。
- 檔案（進度檔）：子程序崩潰或被停掉時已完成部分仍在；已納入階段 3 的 `progress.jsonl`。缺點是要輪詢，所以只用於崩潰後回溯，不取代標準輸入輸出。
- 本機小型推論伺服器：遠端、其他程式、網頁版同機可共用同一份模型，貼合「放著跑或遠端跑」的使用方式；已納入第 4 節階段 5，必須只綁 `127.0.0.1` 加金鑰，避開埠 17923。
- 建議第一版：標準輸入輸出加進度檔；伺服器模式做成選用，之後再開（與本文件一致）。
