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

- [x] 3a. `gpu/gpu_async_queue.js`：純邏輯佇列，含保序、重疊、延遲錯誤、句柄狀態，附 node 測試（假裝置）。提交 d0e38766b
- [x] 3b. `floating-assistant.js` 來源：`_gpuAsync`（submit／wait／query／forget／sync／reset／event_*／stats），網頁版 `_fa_gpu.aop`、桌面版 `gpu.a.<name>`。提交 01a18c9b8
- [x] 3c. `fa_gpu.py`：`call_async`、`AsyncHandle.wait`、`synchronize`、事件；`call` 不變。提交 92f307117
- [x] 3d. `cupy.cuda.Stream／Event`、`numba.cuda.stream()／event()`、`cupy.matmul_async`；`synchronize` 沒有未完成操作時不碰宿主。提交 3d3984493
- [x] 3e. 桌面版：沿用既有信箱，`gpu.a.*` 路由已加在 `floating-assistant.js`，`fa_bridge.py` 不需要改
- [x] 3f. 嵌入與建置已完成（提交 1c8c2de83）：`node scripts/embed-code-ui.js`、`node build-assistant.js`。Python GPU 測試 59 項全過（含嵌入一致性），node 佇列測試全過
- [x] 4a. node 假裝置測試：保序、重疊、延遲錯誤、synchronize（`gpu_async_queue_test.js`，9 項全過）
- [x] 4b. Python 範例 `gpu/examples/async_overlap.py`（串列與重疊計時比較＋結果一致性），測試通過（提交 e7d078633）。範例放在 `renderer/src/gpu/examples/`，不是 pybridge 底下
- [x] 4c. 真機（已跑兩次，依規定不再跑）：第一次見第六節；第二次（修正版，CPU 分塊讓出、GPU 拆成 6 次 256×256 矩陣乘）顯示重疊有省時間，見第六之二節。評估檔 `scripts/eval/async-gpu.eval.js`（第一次）、`scripts/eval/async-gpu-overlap.eval.js`（第二次）
- [x] 4d（新增）. 假裝置耗時比較 `gpu/async_overlap_fake_bench.py`（提交 cef20115b）：串列 3.648 秒、重疊 1.924 秒，省下約 47%。CPU 迴圈校正為約等於一筆 GPU 延遲；不然重疊效果會被雜訊淹沒

## 四、評估（第 5 項，只寫設計，不實作）

多個 Pyodide 工作者分攤 CPU：墊片 `multiprocessing`／`concurrent.futures` 的做法草案：
- 每個工作者是一個獨立 Pyodide Worker，各自有自己的 `GpuQueue`。
- 工作者之間用訊息傳 numpy 陣列（結構化複製或 transferable），不共用記憶體。
- 主執行緒只做排程與結果收集。
- 風險：每個 Worker 載入 Pyodide 與 numpy 的記憶體成本；WebGPU 裝置是否可被多個 Worker 同時使用，需要實測（目前沒有資料，我沒查）。

本項未實作。前面四項做完才評估是否值得做。

### 第 5 項的設計與下一步（管理者要求，2026-11-18 補寫）

- 現況可以借鏡：`renderer/src/gpu/cpu_share.js` 已經有 JS 端的 CPU／GPU 分工（用 Worker 算一部分矩陣列，其餘交給 GPU），是同一類問題的既有解法，只是它是 JS 矩陣乘，不是 Python 沙盒。
- 設計草案：Python 端的 `concurrent.futures.ThreadPoolExecutor`／`multiprocessing.Pool` 墊片，底層每個工作者是一個獨立 Pyodide Worker（各自載入 Pyodide 與 numpy）。GPU 呼叫仍經由頁面的 `_fa_gpu`／`gpu.a.*`（工作者本身沒有 WebGPU 裝置，這一點要保留）。工作者之間用 transferable `ArrayBuffer` 傳 numpy 資料，不共用記憶體。
- 已知的風險與需要實測的地方（我沒有資料）：(1) 每個 Pyodide 實例的記憶體與啟動成本（應該是數十 MB 與數秒，要量）；(2) 多個工作者同時對同一個頁面的 GPU 橋接送請求，會不會在頁面端排隊或相互阻塞；(3) 工作者數量與 CPU 核心數的關係，需要先看 `navigator.hardwareConcurrency`。
- 下一步（依序）：(a) 先做一個 2 工作者的 CPU 純計算 PoC，只量吞吐量與啟動成本，不接 GPU；(b) 若 PoC 有明顯加速，再接上 `_fa_gpu.aop` 的請求路徑；(c) 每一步都要有真機結果才往下做，而且真機依規定最多兩次。
- 目前狀態：只有設計，沒有實作。

## 四之一、實作結果與偏離設計的地方（第 3、4 項）

- 已做：純邏輯佇列（保序、不同 stream 重疊、錯誤延遲且同 stream sticky、`reset`、事件、上限 64）、JS 橋接、Python `call_async`／`AsyncHandle`、`Stream`／`Event`、`cupy.matmul_async`、`numba.cuda.stream()／event()`、`synchronize` 接上、範例與測試。
- 測試結果：node 佇列測試 9 項全過；Python `fa_gpu_py_test.py` 58 項通過、1 項失敗。失敗的是「嵌入副本與原始碼一致」檢查，因為 `floating-assistant.js` 裡的嵌入副本還是舊的，要等 3f 嵌入後才會一致（預期中的失敗）。
- 偏離設計 1：**`cupy.matmul`（一般同步版）不會自動變成非同步**。只有明確呼叫 `matmul_async` 才會重疊，因為一般 `matmul` 要回傳真正的陣列，不能改回傳型別。
- 偏離設計 2：**numba 核心（`@cuda.jit`）還沒有非同步提交**。核心仍是同步的（`run_kernel` 會等）。要做的話，要把 `_try_gpu` 改成可以提交、失敗退路延後到 `synchronize`，這一步沒有做。
- 偏離設計 3：**`Stream.wait_event` 在主機上阻塞**（保守做法）。CUDA 的做法是讓 stream 等事件而不阻塞主機，我沒有實作那種依賴關係。
- 偏離設計 4：**`elapsed_time` 是主機牆鐘時間**，不是 GPU 時間戳。沒有實作 GPU 時間戳，所以目前不知道它與 GPU 實際執行時間的差距。
- 偏離設計 5：Python 端的 `done()` 與 `synchronize()` 都會往返宿主一次（短），`wait()` 才真的等 GPU。
- 沒有做：第 5 項（多 Pyodide 工作者分攤 CPU），按要求只寫在第四節設計。

## 五、驗證狀態

- 第 1 項：唯讀盤點完成，以上行號與檔名都是我自己用 Read／grep 讀出來的。
- JSPI 在這個 Pyodide 版本的行為、`mapAsync` 在 WebGPU 的實際重疊情況：**我沒有驗證**，要在第 4c 項真機測試時確認。
- 已跑的測試：node 佇列測試（9 項）、Python GPU 測試（59 項）、假裝置耗時比較、真機一次（第六節）。
- 本次改動來源：`renderer/src/gpu/`、`renderer/src/pybridge/`、`renderer/src/floating-assistant.js`、`scripts/embed-code-ui.js`、`scripts/eval/async-gpu.eval.js`、`docs/`；建置產物（嵌入與 build 的結果）在提交 1c8c2de83。

## 六、真機一次（第 4c 項）

- 評估檔：`scripts/eval/async-gpu.eval.js`。啟動：真的 Electron、獨立的暫存資料夾（寫了 `main-ext-rev.txt`）、`FA_DISABLE_MAIN_OVERLAY=1`、`FA_BROWSER_CONTROL_PORT=17990`、不加 `--disable-gpu`。只跑一次（符合「每項最多兩次」）。程序結束後沒有殘留的 Electron。
- 形狀：64×64 矩陣乘，每個量測前都先暖機一次。量測用互斥鎖 `requestExclusiveGpu`。
- 結果（一次量測）：
  - WebGPU 可用，`deviceReady` 在執行前後都是 true（沒有 device lost）。層：T1。
  - 同步 call：3.5 毫秒；結果與 CPU 參考的最大誤差 6.1e-6（float32 精度）。
  - 非同步 `submit` 立刻回傳：0.9 毫秒（比同步 call 快，符合「不等 GPU」）。
  - 串列（同步 call 後做 CPU）：6.3 毫秒。
  - 重疊（submit、做 CPU、wait）：7.4 毫秒。非同步結果誤差同上，正確。
- **重疊沒有省時間，這次的量測不能證明重疊。** 原因推測：評估的 CPU 工作是在頁面主執行緒上的忙迴圈，會擋住 GPU 回讀的回呼（`mapAsync`），所以 GPU 的完成要等 CPU 迴圈結束才處理。另外這次的形狀很小（3.5 毫秒），雜訊相對大。這是評估的設計問題，不是佇列的問題；我沒有驗證推測是否正確。
- 因為規定只跑一次，我沒有重跑。要證明真機重疊，需要：(a) CPU 工作放在另一個執行緒（網頁版的 Pyodide Worker 本來就是這樣，所以真實的 Python 重疊比這次評估更接近實際情況），或 (b) 更大的形狀、並且量測前先確認 GPU 的工作確實已派發。這兩點要另外派工並取得同意後才做。
- 沒有驗證：真的 Python 沙盒到 JS 的非同步路徑（這次評估直接呼叫 JS 的 `_gpuAsync`，沒有經過 Python）。

## 六之二、第二次真機（修正版，最後一次）

- 評估檔：`scripts/eval/async-gpu-overlap.eval.js`。啟動方式同第一次（獨立暫存資料夾、換埠、`FA_DISABLE_MAIN_OVERLAY=1`、不加 `--disable-gpu`）。建置已先跑 `node build-assistant.js`（exit 0）。只跑一次，依規定沒有第三次。
- 修正了什麼：(1) CPU 工作分塊，每塊約 2 毫秒，塊與塊之間讓出一個 macrotask，GPU 的提交與讀回回呼才能在 CPU 工作期間處理；(2) GPU 工作拆成 6 次 256×256 矩陣乘，每次單次 sync 量測 20 毫秒（≤ 50 毫秒的要求），整體目標約 120 毫秒；(3) 每種量測跑 3 次、取中位數，順序交錯。
- GPU 型號：WebGPU 回報 vendor `nvidia`、architecture `kepler`，device 與 description 是空字串。`kepler` 是很舊的架構代號，我沒有查它是哪一張卡，只照實記。
- 實測（中位數，3 次）：
  - GPU 單獨（6 次 submit 後全部等待）：72.5 毫秒
  - CPU 單獨（分塊）：124.5 毫秒
  - 串列（6 次同步 matmul，接 CPU）：196.2 毫秒
  - 重疊（6 次 submit，做 CPU，最後等待）：126.3 毫秒
  - 省下：69.9 毫秒（約 36%）。重疊的時間接近 max(GPU, CPU)，也就是 CPU 那段幾乎完全被 GPU 蓋住。
- 正確性：第一塊的結果與 CPU 參考的最大相對誤差 9.0e-7。
- device 狀態：`deviceReady` 執行前後都是 true；`device.lost` 沒有觸發（`lost: null`）。`lostHook: false`：我沒有取得 WebGPU 裝置物件，所以 device.lost 監聽實際上沒有掛上，只能說「沒有觀察到 device lost」，不能說有監聽。
- 與第一次的差別：第一次 CPU 忙迴圈擋住主執行緒，重疊沒有省時間；這次分塊讓出後省了 69.9 毫秒。這與「忙迴圈擋住 GPU 回呼」的推測一致，但這只是一次量測的觀察，不是證明。
- 沒有驗證：CPU 工作仍是頁面主執行緒上的 JS，不是 Python 工作者（真實沙盒的 CPU 工作在 Python 工作者裡）；真的 Python 沙盒到 JS 的路徑沒有在真機上跑過。
- 視窗與程序：Electron 已正常結束（exit 0），`tasklist` 沒有殘留的 electron；沒有我自己啟動的伺服器。

## 七、待辦（目前）

- 真機：Python 工作者版的重疊（需要使用者另外同意；依規定要算第三次，所以目前不做）。
- numba 核心非同步提交（見第四之一節偏離 2）。
- 多工作者分攤 CPU（第五項，只有設計）。
