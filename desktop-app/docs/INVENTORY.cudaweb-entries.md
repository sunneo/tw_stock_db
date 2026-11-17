# cudaweb 入口盤點（O14a，2026-11-18，唯讀查證）

每一列：入口、它實際呼叫的核心、狀態。狀態只用三種：**已走優化核心**、**仍走舊樸素核心／未接競賽**、**純 JS／numpy（不經 GPU）**。證據欄列檔案與行號。

## A. Python 入口（`renderer/src/pybridge/cudaweb.py`，已打包進 `web-lazy/chunks/pybridge.js`）

| 入口 | 呼叫的操作 | 實際核心（JS 端） | 狀態 | 證據 |
|---|---|---|---|---|
| `cudaweb.vector_add` | `vector_add` | `wgVectorAdd`（逐元素一執行緒） | 已走 GPU，核心是單純逐元素（無優化空間） | gpu_core.js:675 |
| `cudaweb.matmul` | `matmul` | `wgMatmul` → `matmul_vec4`／`matmul`（共用平鋪核心） | **仍未接變體競賽**：gpu_core.js 沒有引用 `mm_ops`、`variant_race`、`kernel_select`，所以競賽勝者不會走到這裡 | gpu_core.js:680–689；無 mm_ops 引用 |
| `cudaweb.sum` | `sum` | `reduceBuffers`（分層樹狀歸約） | 已是分層歸約（不是單執行緒） | gpu_core.js:691–707 |
| `cudaweb.axpy` | `axpy` | `wgAxpy`（逐元素） | GPU，逐元素 | gpu_core.js:708–715 |
| `cudaweb.scal` | `scal` | `wgScal`（逐元素） | GPU，逐元素 | gpu_core.js:716–723 |
| `cudaweb.dot` | `dot` | `mul` 逐元素 ＋ `reduceBuffers` 樹狀歸約 | 已是分層歸約 | gpu_core.js:724–733 |
| `cudaweb.nrm2` | `nrm2` | `wgDot(x, x)` 再開根號 | 同上（沒有縮放，極大極小值可能溢位，文件已註明） | gpu_core.js:1109–1114 |
| `cudaweb.gemv` | `gemv` | `wgGemv` → `wgMatmul(A, x, m, n, 1)`，即把向量當成 N=1 的矩陣乘 | **仍走舊路徑**：沒有 M 小路徑（解碼式 GEMV）；只是退化的平鋪矩陣乘，沒有 q8／解碼核心 | gpu_core.js:734 |
| `cudaweb.cublas.sgemm` | `matmul`（只支援 transa=N、transb=N、alpha=1、beta=0，其他直接報錯） | 同 `matmul` | **功能缺口**：轉置、alpha、beta 不支援（O14b 要補） | cudaweb.py 的 `sgemm` 方法 |
| `cudaweb.cublas.saxpy／sscal／sdot／snrm2／sgemv` | 同對應操作 | 同上 | 同對應列；`sgemv` 只支援 transa=N、alpha=1、beta=0 | cudaweb.py |

## B. Python 墊片（`numba`／`cupy`／`torch`／`pycuda`）

| 入口 | 行為 | 狀態 | 證據 |
|---|---|---|---|
| `cupy.matmul` | 2D 且 `_gpu_ok` 時送 `cudaweb matmul`，否則 `np.matmul`（CPU）；`_gpu_or_none` 失敗時退回 numpy | **部分走 GPU**（門檻 `_gpu_ok` 的條件尚未查明） | pybridge.js，`def matmul(a, b, out=None)` |
| `cupy.dot` | 1D 且 `_gpu_ok` 時送 `cudaweb dot`，2D 轉 `matmul`，否則 `np.dot` | 同上 | pybridge.js，`def dot(a, b)` |
| `cupy.sum` 等其他 | `np.sum`（CPU） | **純 numpy** | pybridge.js |
| `torch`（墊片） | 以 numpy 實作的 autograd（`_t(a) @ _t(b)`），沒有看到送 cudaweb | **純 numpy／CPU**（從程式碼看，未實測） | pybridge.js，`def matmul(a, b): return _t(a) @ _t(b)` |
| `numba`（墊片） | `@numba.cuda.jit` 轉譯成 WGSL，由宿主在 WebGPU 執行；不支援的寫法直接報錯 | **走 GPU（自寫核心路徑）**；樸素的逐元素核心，沒有 reduce／transpose 樣板（O14c） | pybridge.js，`把轉譯好的 WGSL ... 交給宿主` |
| `pycuda`（墊片） | 訊息寫「未支援（建議：用 numpy 同名函式，或改寫為 @numba.cuda.jit 核心）」 | **不支援** | pybridge.js |

## C. JavaScript 入口（`renderer/src/gpu/`）

| 入口 | 實際核心 | 狀態 | 證據 |
|---|---|---|---|
| `gpu_core.js` 的 `WGSL.*`（`matmul`、`matmul_vec4`、`sum`、`sum_dd`、`axpy`、`scal`、`mul`、`scatter_add`、`vector_add`） | 上面 A 段所列 | 同 A 段 | gpu_core.js:356、1000–1003 |
| `cudnn_subset.js` | 只有卷積與注意力的子集，**沒有**獨立的 matmul 入口；其 API 表（`aten::mm` 等）指向 `cudaweb.matmul` | 同 A 段（間接） | cudnn_subset.js 第 163–167 行附近 |
| `nn_ops.js`（批次送出，`createBatch`） | 由 `mm_ops` 之外的線性層核心組成，含 `quantizeDyn`、`rmsQuantFused`、`q8mm` 等 | **已走優化核心**（推論路徑；這是 O6–O8 的成果） | nn_ops.js，createBatch |

## D. 缺口摘要（對應 O14b）

1. **`sgemm` 轉置與 alpha／beta**：Python 端直接拒絕；JS 端 `wgMatmul` 其實已支援 `flags.transA／transB`（gpu_core.js:683–685），缺的是 Python 端的參數轉送與 alpha／beta 的後處理。
2. **`matmul` 未接變體競賽勝者**：gpu_core.js 沒有引用 `mm_ops` 的競賽結果；要改成依形狀查競賽表選核心。
3. **`gemv` 沒有 M 小路徑**：目前是退化的 N=1 矩陣乘；應走 q8／解碼式核心（但 cudaweb.gemv 是 f32 輸入，需要先決定是否量化，這是設計決定，不能默默改精度）。
4. **`cupy`／`torch` 墊片多數仍在 numpy**：`torch` 完全沒有接 cudaweb；`cupy.sum` 等也沒有。
5. **`pycuda`** 未支援，設計上列為不做。

## E. 未驗證的部分

- 上表的「已走 GPU」只看程式路徑，**沒有在真機上逐一確認每個入口實際送出 GPU 工作**（`_gpu_ok` 的門檻未查）。
- 沒有量測優化前後（那是 O14b 的工作）。
