# 設計：cudaweb = CPU + GPU 異質排程器

狀態：設計草案（2026-11-18）。這份文件先寫、再實作。實作分批提交，每批附測試。
目標（使用者原話）：「希望是直接做在 cudaweb 這支上面，變成 cudaweb = cpu + gpu，不論是 js 還是 python」。

## 0. 現況（先查證，不重寫）

- `renderer/src/gpu/cpu_share.js` 已經有「矩陣乘按列切給 CPU Worker 與 GPU 同時跑」：`createCpuShare`，比例用實測速率的指數平均（`rate.gpu`、`rate.cpu`），小運算不分工（`MIN_FLOPS`、`MIN_ROWS`），上限 `MAX_CPU_RATIO = 0.5`，Worker 端快取 B 矩陣，快取被擠掉會補送，錯誤會回傳。`mm_ops` 用它。
- 所以本設計的主體不是從零做分工，而是補上它缺的四件事（見第 4 節）。
- `gpu_async_queue.js` 已經有單一裝置的非同步句柄、stream、event、sticky 錯誤。
- `mp_core.js` 有 CPU 工作的依序分派 `runMap`、工作者上限 `mpWorkerCap`。
- 目前速率只存在記憶體裡（重新開頁就沒了）；變體競賽（`variant_race.js`）已經有 IndexedDB 的做法可以沿用。

## 1. 介面

### 1.1 裝置與句柄
- 裝置：`cpu`（CPU Worker 池）與 `gpu`（WebGPU 執行層）。兩者都是同一個排程器的「裝置」。
- 任務：`{ device, op, args, stream }`。`device` 可以省略，由排程器決定（見 1.3）。
- 句柄：與 `gpu_async_queue` 相同（`submit` 立刻回傳，`wait` 取結果，`query`、`forget`）。
- stream：同一個 stream 內保序（不論裝置）；不同 stream 可以重疊。
- event：`record(stream)`、`eventSynchronize`、`eventQuery`、`eventElapsed`（與 `gpu_async_queue` 相同語意，時間是主機牆鐘）。
- `synchronize(stream?)`：等全部（或指定 stream）。錯誤延遲到等待點丟出，同一 stream sticky。

### 1.2 可切分的運算（分攤的對象）
- 逐元素（elementwise）：輸入輸出長度相同，切連續區段。
- 批次矩陣乘 `matmulMany`：切批次維度（每個批次獨立）。
- 行切分或列切分的 `matmul`、`gemv`：切列（與 `cpu_share` 相同）。
- 規約（sum、dot、nrm2）：切段後在合併時再規約（只有對結果可交換的操作才可以切；浮點結果會因順序略有不同，要在文件與測試註明容許誤差）。
- 不可切分的運算：只能整個給一個裝置（由決策決定）。

### 1.3 裝置選擇（不切分時）
- 沒有 WebGPU → 全部給 CPU（純 CPU 池，第 5 節）。
- 有 WebGPU 且 CPU 池可用 → 依分攤決策（第 2 節）決定 GPU、CPU 或切分。

### 1.4 入口
- JS：`cudaweb.matmul(...)` 等現有入口，內部改走排程器。
- Python：`fa_gpu.call`／`call_async` 與墊片（cupy／numba／torch）都呼叫同一個 cudaweb 入口。墊片只做型別與參數轉換，不自己決定裝置。
- `multiprocessing` 墊片的 CPU 工作者池（`mp_core`、`_mpBridge`）與 cudaweb 的 CPU 池是同一個池的兩個用法，不另開一套。Python 的 `Pool.map` 等只是順便，不是主軸。

## 2. 分攤決策（比例）

符號：`W`＝運算量（flops 或元素數），`g`＝GPU 速率（單位／毫秒，含傳輸），`c`＝CPU 速率（單位／毫秒），`go`＝GPU 固定成本（派發＋讀回，毫秒），`co`＝CPU 固定成本（分派給 Worker、拷貝，毫秒），`f`＝給 CPU 的比例。

- 只給 GPU 的預測時間：`T_g = go + W/g`
- 切分時 GPU 段與 CPU 段同時跑，兩段的預測時間分別是 `(1−f)W/g + go` 與 `f·W/c + co`。平衡點：
  `f* = (W/g + go − co) / (W/g + W/c)`
- 切分的預測時間：`T_s = max((1−f)W/g + go, fW/c + co)`
- 採用切分的條件（全部要成立）：
  1. `f ∈ [f_min, f_max]`，`f_max = 0.5`（與 `cpu_share` 的 `MAX_CPU_RATIO` 一致），`f_min` 使 CPU 段至少有 `minCpuWork`（預設讓 CPU 段的預測時間 ≥ 2 倍 `co`，否則固定成本划不來）。
  2. `T_s ≤ (1 − margin)·T_g`，`margin = 0.15`。省不到 15% 就不切，全給 GPU（保守）。
- 沒有實測速率（第一次、或換了裝置）→ 不切分，全給 GPU。這是預設的保守行為。若 GPU 也沒有速率，就全給 CPU。
- 速率的估計：每次實際執行後，用各裝置自己完成的時間更新 `g`、`c`（指數平均，與 `cpu_share` 相同）。

## 3. 速率的持久化（IndexedDB）

- 鍵：`裝置名稱 | 瀏覽器版本 | GPU 介面卡字串 | CPU 核心數 | 運算種類`。任何一項變了就視為新環境，速率重新量測。
- 儲存：IndexedDB（與變體競賽同一個資料庫，不同的 store）。讀取失敗或沒有資料 → 第 2 節的保守預設。
- 不存在 localStorage（容量與同步問題）。

## 4. 缺口與要補的四件事

1. 統一句柄：CPU 段目前是直接 `await`，不在佇列裡。要把 CPU 段也包成同一個 `submit`，才能和 GPU 句柄一起 `synchronize`、事件計時。
2. 通用切分：目前只有 `mm_ops` 的矩陣乘在用。要抽成「可切分運算」的通用介面（第 1.2 節），逐元素與規約先做。
3. 持久化速率：目前只在記憶體，要存到 IndexedDB（第 3 節）。
4. 決策公式：目前 `ratioNow()` 只用速率比例，沒有 `go`、`co`、`margin`、`minCpuWork`。要換成第 2 節的公式。

## 5. 沒有 WebGPU 時

- 排程器的裝置清單只剩 `cpu`，所有運算都給 CPU 池。
- 若 CPU 池也建立失敗（沒有 Worker），退回單一執行緒的 JS 實作（現有的 `cpuRowsRef` 等），並在結果裡註明 `why`。
- 不得因為缺 GPU 而丟錯；cudaweb 在沒有 GPU 的環境要能跑（使用者要求）。

## 6. 與量測互斥鎖的關係

- `requestExclusiveGpu`（`nn_ops.js`）只鎖「GPU 量測」，目的是量測時不要被別的 GPU 工作干擾。
- 分攤的 GPU 段是正常執行，不需要排隊，但如果這個運算正在做量測（變體競賽、速率量測），量測期間不能把 GPU 段排進去。做法：量測時用同一把鎖，排程器的 GPU 段要先取得鎖（與量測互斥）。
- CPU 段不需要這把鎖（不會干擾 GPU 量測）。但 CPU 量測（速率估計）本身也要避免和 CPU 池的其他工作互相干擾，量測時 CPU 池要先排空（`synchronize` 的 CPU 部分）。

## 7. 失敗退回路徑

- GPU 段失敗（不是 sticky 的 device lost）：該段改由 CPU 補算，並記錄 `fallback: 'gpu-error'` 與原因。
- device lost：標記 GPU 不可用，之後的決策全給 CPU；GPU 恢復要重新初始化，不自動重試（避免反覆掉）。
- CPU 段失敗：整個運算失敗（丟錯，回傳第一個錯誤），在飛中的另一段等它結束後才丟。
- 取消（`AbortSignal`）：不再開始新的段，在飛中的段跑完，丟 `AbortError`。
- 速率資料壞掉（IndexedDB 讀不到、數值不合理）→ 當作沒有速率，保守預設。

## 8. 測試計畫（node，假裝置＋假 CPU 工作者）

- 切分正確：列切分與連續區段覆蓋整個範圍、不重不漏。
- 合併順序：各段的結果依原始位置合併，與單一裝置結果一致。
- 例外傳回：段失敗時，第一個錯誤丟出，另一段結束後才丟。
- 取消：不再開始新段，丟 AbortError。
- 比例退回：沒有速率 → 全給 GPU；沒有 GPU → 全給 CPU；速率不合理 → 保守預設。
- 決策公式：在已知速率下，`f*` 與預測時間符合第 2 節；省不到 15% 時不切。
- 真機（一次）：記錄 CPU 核心數、GPU 型號、加速比。

## 9. 實作順序（批次）

1. `gpu_async_queue` 允許 op 為物件（裝置標記），保持既有測試。
2. `hetero_split.js`：決策公式、列切分、合併、`runSplit`（含退回與取消）＋ node 測試。
3. 速率持久化（IndexedDB 介面與假實作的測試）。
4. 把 `cpu_share` 的 CPU 段改成排程器的 `cpu` 裝置（統一句柄）。
5. 通用切分接上 elementwise 與規約；cudaweb 入口改走排程器。
6. Python 墊片接上（薄層）。
7. 真機一次。

## 10. 沒有做、要說清楚的

- WASM SIMD 的 CPU 核心：目前 CPU 段是 JS（`cpuRowsRef`）。WASM 版要另外寫，本次不做，列為後續。
- `SharedArrayBuffer` 零複製：目前是複製（`postMessage`）。SAB 可用時的零複製要看環境（需要跨來源隔離），本次不做；複製的傳輸成本已經放進第 2 節的 `co`。
- 浮點結果的精確一致：切分後的規約順序不同，結果會有極小差異，測試以容許誤差判定。
