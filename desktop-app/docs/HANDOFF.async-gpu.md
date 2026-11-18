# 交接：Python 沙盒的 GPU 非同步提交（CPU／GPU 負載分攤）

狀態：第 1 項（唯讀盤點）完成；第 2 項（設計）寫在本文件；第 3 到 5 項尚未實作。
程式來源檔（`renderer/src/pybridge/`、`floating-assistant.js`、`renderer/src/gpu/`）本次沒有改動。
等管理者通知 v449 發布完成後，才開始改程式。

## 一、現況盤點（第 1 項）

### 1.1 整條呼叫鏈

| 層 | 位置 | 行為 |
|---|---|---|
| Python 使用者程式 | 技能包腳本 | 呼叫 `cupy`／`numba.cuda`／`torch.cuda`／`pycuda`／`cudaweb` 墊片 |
| 墊片 → 相容層 | `fa_gpu.py` `_rpc()` | 網頁版：`pyodide.ffi.run_sync(_fa_gpu.call(...))`，**Python 掛起直到 JS 回應**；桌面版：寫檔到信箱資料夾，`fa_bridge.call` 忙等（指數退避，上限 0.2 秒） |
| JS 橋接入口 | `floating-assistant.js` `_pyBridgeGpu(name, a)`（約 96999 行） | `async`，內部全部 `await`（`_gpuBinRead`、`rt.runKernel`、`_cudawebCall`、`backendInfo`）；JS 端本身不阻塞 |
| 執行期 | `gpu/cudaweb_runtime.js`、`gpu/gpu_core.js` | WebGPU 提交後即回傳，GPU 工作在背景跑；讀回（`mapAsync`）才等 |

結論：**阻塞點只在 Python 那一層的 `run_sync`**。JS 端其實已經是非同步的，所以不需要重寫 WebGPU 執行期，只要讓 Python 不必等。

### 1.2 各墊片的「同步阻塞」清單

| 墊片／op | 現在怎麼做 | 是否阻塞 Python | 能否排隊 |
|---|---|---|---|
| `fa_gpu.call(op)`（cudaweb 的 vector_add、matmul、sum、axpy、scal、dot、nrm2、gemv） | `_rpc("call")` → `run_sync` | 是 | 能。提交後結果要等才有，可以拆成「提交」與「取結果」 |
| `fa_gpu.run_kernel(plan)`（numba 核心 → WGSL） | `_rpc("kernel")`，寫入 `gpu-k-in-*.bin` | 是 | 能。注意：輸出是 `write` 綁定，寫回要等執行完 |
| `fa_gpu.info()` | `_rpc("info")` | 是（很短） | 不需要排隊，保持同步 |
| `cupy.asnumpy`、`copy_to_host`、`DeviceArray` | 資料全在 numpy，**沒有真的裝置記憶體** | 不適用 | 讀回是本機陣列，沒有傳輸 |
| `cupy.cuda.Device.synchronize()` | 空函式，回傳 None | 不阻塞（但也沒有實際同步） | 語意上應該要等所有已提交的工作；目前沒有工作可等，所以正確 |
| `numba.cuda.synchronize()` | 空函式 | 同上 | 同上 |
| `torch.cuda.synchronize()` | 見 `torch/cuda.py` 第 26 行，同樣是空函式 | 同上 | 同上 |
| `pycuda.driver.memcpy_htod／dtoh` | 本機 numpy 的 bytes 複製，**不經過 GPU** | 不阻塞 | 不適用 |
| `cupy.cuda.Stream`／`Event`／`numba.cuda.stream()`／`event()` | **不存在**（`cupy/cuda.py` 只有 `Device`、`_Runtime`、`is_available`；`numba/cuda.py` 的 `stream` 參數被忽略） | 不適用 | 目前沒有 stream 語意，要新增 |
| 核心啟動（numba `@cuda.jit` 的 `__call__`） | 先 `_try_gpu`（同步 `run_kernel`），失敗就 `_emulate` 在 Python 逐執行緒模擬 | 是 | 能提交，但**失敗退路是同步的**，所以排隊的核心失敗時要延遲到同步點再決定退路 |

### 1.3 重要事實（與管理者原本的描述有差）

1. cupy 墊片**沒有** Stream 類別，只有 Device。要新增，不是「改寫既有的」。
2. 目前 numpy 是資料容器，GPU 只在 matmul、dot、一維 sum 等熱點出現（見 `cupy/__init__.py` 開頭註解）。所以「CPU 與 GPU 同時工作」的收益，主要來自「GPU 熱點提交後，Python 立刻做下一段 numpy 計算」。
3. numba 的「GPU 執行」只在 `fa_gpu.run_kernel` 有真的 WebGPU 派發；其餘都是 Python 模擬。模擬的 CPU 工作與 WebGPU 工作可以重疊，這是最直接的收益來源。
4. 網頁版的 `run_sync` 需要 JSPI（前提是整支程式包在 `callPromising` 裡，見 `fa_bridge.py` 的 `call()` 內註解；行號我沒有逐一核對）。非同步提交時 Python 不再掛起，所以 JSPI 的前提可以保留，只是 `run_sync` 不再被呼叫在每次 GPU 操作上。
5. 桌面版是檔案信箱，`fa_bridge.call` 的忙等會佔住 Python 執行緒。非同步提交要改成「寫完請求檔就回傳句柄」，之後再檢查回應檔。

## 二、設計（第 2 項，尚未實作）

### 2.1 JS 端：提交佇列與句柄

- 每個 Python 工作階段有一個 `GpuQueue`：`submit(op, args) -> handle`，立刻回傳句柄，不等 GPU。
- 句柄狀態：`pending`、`done`、`error`；結果存在佇列內，直到被 `wait(handle)` 取走。
- 同一個 stream 的句柄要依提交順序執行（保序）；不同 stream 的句柄可以重疊（各自獨立的 `await` 鏈）。
- 錯誤不立刻丟出，只存到句柄上，在 `synchronize()`、`wait(handle)`、讀回資料時才丟出（與 CUDA 相同）。
- 純邏輯（保序、重疊、延遲錯誤、句柄狀態）抽成獨立模組，例如 `gpu/gpu_async_queue.js`，用假裝置做 node 測試，不需要 WebGPU。

### 2.2 Python 端：stream、event、非同步提交

- `cupy.cuda.Stream`：`with stream:` 進入後，提交的 GPU 操作都掛在此 stream；`synchronize()` 等此 stream 的全部句柄。
- `cupy.cuda.Event`：`record(stream)` 在目前位置放一個標記；`synchronize()` 等到標記之前的工作完成；`elapsed_time(end)` 回傳毫秒（只在 WebGPU 時間戳可用時準確，否則回傳 NaN 並說明）。
- `numba.cuda.stream()`、`numba.cuda.event()` 與上述語意相同；`numba.cuda.synchronize()` 等所有 stream。
- 沒有開 stream 的程式：仍走現在的同步路徑，**行為完全不變**（預設值）。這是要守住的相容性約定。
- `fa_gpu.call_async(op, args) -> handle` 與 `fa_gpu.wait(handle)`，`fa_gpu.call()` 保留為「`call_async` 之後立刻 `wait`」的包裝。

### 2.3 句柄的 Python 表示

- 句柄是 Python 物件，持有 queue id 與句柄 id，不持有結果本身。
- 讀回（`asnumpy`、`copy_to_host`）時才 `wait`。
- 句柄不能跨 Pyodide worker 使用（worker 之間各自有自己的佇列）。

### 2.4 網頁版與桌面版的差異

| 項目 | 網頁版（Pyodide） | 桌面版（檔案信箱） |
|---|---|---|
| 提交 | 新增 `_fa_gpu.submit(op, json)`：JS 端先登記並開始執行，立刻把句柄 id 回給 Python（Python 端不掛起） | 寫 `req-*.json`，立刻回傳句柄 |
| 等結果 | `run_sync` 只在 `wait` 時呼叫 | 忙等回應檔，只在 `wait` 時執行 |
| 風險 | 若 `wait` 之前 Python 掛起，JSPI 會失效 | 主程式沒讀請求時句柄永遠 pending，要有逾時 |

### 2.5 取捨（請管理者決定，不確定的部分我先按預設寫）

1. **預設同步不變**（已決定）：不開 stream 就不改行為，降低風險。
2. **錯誤延遲到同步點**（已決定，與 CUDA 相同）。
3. **numba 核心失敗的退路**：非同步提交時，退路（Python 模擬）要等到 `synchronize` 才跑，代價是失敗時結果延後。這裡我選「延後」，因為先跑模擬會佔住 CPU，與分攤的目標衝突。
4. **Event 的計時**：WebGPU 時間戳需要 feature，不一定有。我選「不可用時回傳 NaN」，不假造數字。
5. **佇列上限**：預設 64 個未完成句柄，超過時 `submit` 先等最舊的，避免記憶體無限成長。

## 三、實作待辦（第 3 到 5 項，等管理者通知後開始）

- [ ] 3a. `gpu/gpu_async_queue.js`：純邏輯佇列，含保序、重疊、延遲錯誤、句柄狀態，附 node 測試（假裝置）
- [ ] 3b. `floating-assistant.js` `_pyBridgeGpu` 加 `submit`／`wait`／`sync` 三個 op，沿用現有 `call` 的參數格式
- [ ] 3c. `fa_gpu.py`：`call_async`、`wait`；`call` 改為包裝，預設行為保持不變
- [ ] 3d. `cupy/cuda.py`：`Stream`、`Event`；`numba/cuda.py`：`stream()`、`event()`、`synchronize()` 接上佇列
- [ ] 3e. `fa_bridge.py`：桌面版非同步提交（寫請求後回傳句柄，等待時才讀回應）
- [ ] 3f. 嵌入：改 `renderer/src` 來源後跑 `node scripts/embed-code-ui.js` 與 `node build-assistant.js`
- [ ] 4a. node 假裝置測試：保序、重疊、延遲錯誤、synchronize
- [ ] 4b. Python 範例：CPU 迴圈加 GPU matmul 同時跑，計時比較串列與重疊（範例檔放 `renderer/src/pybridge/examples/`）
- [ ] 4c. 真機只做一次：一頁一形狀、先估時間、單次派發小、監聽 `device.lost`、不跑會逾時的測試、用 `requestExclusiveGpu` 做量測互斥

## 四、評估（第 5 項，只寫設計，不實作）

多個 Pyodide 工作者分攤 CPU：墊片 `multiprocessing`／`concurrent.futures` 的做法草案：
- 每個工作者是一個獨立 Pyodide Worker，各自有自己的 `GpuQueue`。
- 工作者之間用訊息傳 numpy 陣列（結構化複製或 transferable），不共用記憶體。
- 主執行緒只做排程與結果收集。
- 風險：每個 Worker 載入 Pyodide 與 numpy 的記憶體成本；WebGPU 裝置是否可被多個 Worker 同時使用，需要實測（目前沒有資料，我沒查）。

本項未實作。前面四項做完才評估是否值得做。

## 五、驗證狀態

- 第 1 項：唯讀盤點完成，以上行號與檔名都是我自己用 Read／grep 讀出來的。
- JSPI 在這個 Pyodide 版本的行為、`mapAsync` 在 WebGPU 的實際重疊情況：**我沒有驗證**，要在第 4c 項真機測試時確認。
- 沒有跑任何測試，也沒有改任何來源檔。
