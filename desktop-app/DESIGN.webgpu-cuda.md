# CUDA 相容的 GPU 運算層：cudaweb、torch on WebGPU 與離線模型資源（完整設計）

> 版本：2026-11-15 整份重寫。本文件是可以交給別人照著實作的完整設計，取代先前所有分段的追加與更正。
> 現況（已提交）：調查與設計（`118e8bb26`、`f871816fe`、`510086b09`）、第一階段實作（`d437fda9f`）、`cudaweb.cublas.sgemm` 最小版（`b79454138`）。各項完成狀態見第 10 節。

---

## 0. 一頁摘要

**目標（一句話）**：盡可能讓使用者的 GPU 成為可用。舊的、弱的、沒有 WebGPU 的裝置都要盡量能跑；原生做不到的運算，由我們的替代實作補上，不是直接排除，也不是直接退到 CPU。只有「在 GPU 上做不了」的運算才退到 WASM 或純 JS，而且要寫明缺什麼、退到哪一層。

**產品範圍**：

| 產品 | 內容 | 使用者能做什麼 |
|---|---|---|
| **cudaweb**（Python CUDA on WebGPU） | Python 模擬器（Pyodide）裡可 `import cudaweb`，提供向量加、矩陣乘、歸約、直方圖、`@cuda.jit` 風格核心 | 在瀏覽器或桌面版裡寫 GPU 程式 |
| **torch on WebGPU** | PyTorch 風格的 JS 張量與自動微分，運算子對映到核心 | 訓練與推論用的張量運算 |
| **函式庫相容層** | cuBLAS 常用子集、cuDNN 常用子集、ATen 運算子對映 | 既有 CUDA 程式的呼叫形式可以搬過來 |
| **NVPTX 路線** | LLVM NVPTX 產出的 PTX 子集，轉成 WGSL 或 WebGL2 著色器 | 編譯型的 CUDA 程式碼 |
| **離線模型資源** | 訓練工作室的運算後端、離線模型推論的 GPU 路徑、與 Python 模擬器共用裝置的排程 | 離線 LoRA 訓練與本機推論用到 GPU |

**現有資產**：`renderer/src/gpu/gpu_core.js`（第一階段核心，WGSL＋CPU）、`renderer/src/pybridge/cudaweb.py`（Python 端）、`renderer/src/studio/backend_core.js`（運算後端登錄表）。

---

## 1. 設計原則

1. **替代優先於排除**。WGSL 或 WebGL2 沒有的原語，預設做法是用我們的替代實作補上（雙 f32 模擬 f64、兩個 u32 模擬 64 位元整數、compare-and-swap 迴圈模擬 f32 原子加、平鋪矩陣乘模擬 Tensor Core、共享記憶體加屏障模擬 warp 操作、分塊處理超過上限的工作、多趟排程模擬動態平行、顯式堆疊取代遞迴）。
2. **降級要說明白**。每次降級都要回報：缺哪個功能或 limits 值、退到哪一層、原因用人看得懂的句子寫出。不寫「不支援」這類籠統字眼。
3. **結果在容差內一致，不宣稱位元相同**。WebGPU、WebGL2、CPU 的累加順序與浮點行為不同；比對用容差，容差依內積長度與機器精度成比例，不寫死常數。
4. **沒有 GPU 不等於沒有加速**。沒有 WebGPU 但有 WebGL2（舊顯卡、樹莓派上的 Chromium、手機）要走 WebGL2 層，不直接掉到 CPU。
5. **能力依檔分級**。裝置歸到一個能力檔，檔決定哪些核心用原生做、哪些用替代做，比逐項硬判斷更容易維護。
6. **單一執行期**。網頁版與桌面版走同一份核心程式；桌面版只差在可以開真的 WebGPU 視窗做驗證。

---

## 2. 硬體與環境層級

### 2.1 降級階梯（完整版）

| 層 | 名稱 | 條件 | 做法 | 回報的 `layer` |
|---|---|---|---|---|
| L1 | WGSL 原生 | WebGPU 裝置可用，需要的功能都具備 | 直接跑 WGSL 核心 | `T1` |
| L2 | WGSL＋替代實作 | WebGPU 可用，但缺某些功能（f16、subgroups、原子 f32…） | 同一裝置，核心內用替代程式碼補上 | `T2` |
| L3 | WebGL2 GPGPU | 沒有可用的 WebGPU，但有 WebGL2 | 資料流為浮點紋理，核心為 fragment shader，輸出寫到 framebuffer，多趟縮減，gather 用紋理取樣，scatter 用多趟或排序，矩陣乘分塊多趟 | `T3` |
| L4 | WASM | 沒有任何 GPU 路線，但有 WebAssembly | SIMD 與 threads（若有）加速的 CPU 核心 | `T4` |
| L5 | 純 JS | 以上都沒有 | 參考實作，速度最慢但結果最可靠 | `T5` |

**WebGL2 層的細節**：
- **資料流**：浮點紋理（RGBA32F 或 R32F）。若沒有 `EXT_color_buffer_float`（不能渲染到浮點紋理），退到 RGBA16F（需要 `EXT_color_buffer_half_float`），再退到 RGBA8 打包編碼（每個 f32 拆成四個位元組，精度損失要在容差記錄裡寫明）。
- **核心**：一個 fragment shader 對應一個輸出元素；輸出寫到 framebuffer 紋理。
- **歸約**：多趟縮減，每趟把尺寸除以一個因子（例如 4 或 2），直到剩一個值。
- **gather**：紋理取樣（`texelFetch`）。
- **scatter**：沒有原生寫入任意位址的能力。替代做法是多趟（每趟只寫一個位址集合）或先排序再歸約。
- **矩陣乘**：分塊，每個分塊一趟，累加到輸出紋理。
- **限制**：單一紋理的最大尺寸（`MAX_TEXTURE_SIZE`）、最大繪製緩衝數（`MAX_DRAW_BUFFERS`）、線性過濾浮點（`OES_texture_float_linear`，只在需要插值時才用）。

### 2.2 能力檔（相當 CUDA 算力版本的概念）

能力檔是我們自己的分級，借用 CUDA 算力版本（compute capability）的想法：檔越高，原生能做的越多，替代越少。

| 檔 | 大致對應 | 條件 | 原生能做 | 需要替代 |
|---|---|---|---|---|
| **A** | 算力 1.0 級（老舊、弱） | WebGL2 裝置；或 WebGPU 但 `isFallbackAdapter` 為真（軟體介面卡）；或 WebGPU 的 `maxComputeWorkgroupStorageSize` 很小 | 不需要原子的核心：向量加、逐元素運算、矩陣乘（分塊）、歸約（多趟） | 原子操作（用多趟或排序取代）、f64（雙 f32）、整數 64 位元（兩個 u32）、大於記憶體上限的工作（分塊） |
| **B** | 算力 1.x 至 2.x 級 | WebGPU 可用，有 `i32`／`u32` 原子，`maxComputeWorkgroupStorageSize` 足夠（例如 16 KiB 以上），沒有 f16／subgroups | 整數原子、共享記憶體、屏障 | f32 原子（CAS 迴圈）、f64、整數 64 位元、warp 操作（用共享記憶體加屏障模擬） |
| **C** | 較新的 GPU | WebGPU 含 `shader-f16` 與 `subgroups` | 上述全部，加 f16、subgroup 歸約與廣播 | 矩陣乘指令（用平鋪）、f64、整數 64 位元 |

**歸檔規則**（由低到高判斷，取「最高的可用檔」的前一檔如果任一條件不成立）：
1. 沒有 WebGPU、也沒有 WebGL2 → 不歸檔，直接走 L4 或 L5。
2. 只有 WebGL2 → 檔 A。
3. WebGPU 可用，但 `isFallbackAdapter` 為真 → 檔 A（軟體介面卡通常很慢，要標記）。
4. WebGPU 可用，`maxComputeWorkgroupStorageSize` 小於 16384 位元組 → 檔 A。
5. WebGPU 可用，有 `shader-f16` 且有 `subgroups` → 檔 C。
6. 其他 WebGPU 可用的情況 → 檔 B。

### 2.3 能力偵測清單

**WebGPU**：
- `navigator.gpu` 是否存在。
- `requestAdapter()` 回傳值是否為空；`adapter.isFallbackAdapter`（軟體介面卡）。
- `adapter.features`（集合）：是否含 `shader-f16`、`subgroups`、`timestamp-query` 等。
- `adapter.limits`：`maxStorageBufferBindingSize`、`maxComputeWorkgroupStorageSize`、`maxComputeInvocationsPerWorkgroup`、`maxComputeWorkgroupSizeX`。
- `requestDevice()` 失敗的錯誤訊息，原樣記錄。

**WebGL2**：
- `canvas.getContext('webgl2')` 是否取得上下文。
- 上下文參數：`MAX_TEXTURE_SIZE`、`MAX_DRAW_BUFFERS`、`MAX_COLOR_ATTACHMENTS`。
- 擴充：`EXT_color_buffer_float`（能否渲染到 f32 紋理，決定是否能用 RGBA32F）、`EXT_color_buffer_half_float`、`OES_texture_float_linear`。

**回報原則**：每個缺的項目都要有具體原因，例如「缺 EXT_color_buffer_float，改用 RGBA8 打包編碼，精度降低」。

### 2.4 `backend_info()` 回報格式

Python 端 `cudaweb.backend_info()` 與 JS 端 `runtime.backendInfo()` 回傳相同結構：

```json
{
  "hasWebGPU": true,
  "hasAdapter": true,
  "isFallbackAdapter": false,
  "webgl2": { "available": false, "reason": "此瀏覽器沒有 WebGL2 上下文" },
  "profile": "B",
  "profileReason": "有 i32 原子與 16 KiB 共享記憶體，沒有 shader-f16 與 subgroups",
  "features": ["timestamp-query"],
  "limits": { "maxStorageBufferBindingSize": 134217728, "maxComputeWorkgroupStorageSize": 16384 },
  "deviceReady": true,
  "ops": {
    "vector_add": { "layer": "T1", "native": true, "substitutes": [], "reason": "" },
    "matmul": { "layer": "T1", "native": true, "substitutes": ["f32 原子不用"], "reason": "" },
    "sum": { "layer": "T1", "native": true, "substitutes": [], "reason": "" }
  },
  "last": { "op": "sum", "layer": "T1", "via": "wgsl-native", "reason": "", "accumulate": "f32", "reductionOrder": "tree-wg256" },
  "degradeLog": [
    { "op": "matmul", "from": "T1", "to": "T5", "reason": "輸入超過裝置的儲存緩衝上限（需要 … 位元組，上限 …）" }
  ],
  "budget": { "limitBytes": 268435456, "usedBytes": 0 }
}
```

- `ops` 逐項列出每個核心目前能用的層、哪些用原生、哪些用替代、哪些退層與原因。
- `layer` 用 `T1`、`T2`、`T3`、`T4`、`T5`（對應第 2.1 節）。
- `via` 是人看得懂的名稱：`wgsl-native`、`wgsl-substitute`、`webgl2`、`wasm`、`cpu-js`。

---

## 3. 原語對照與替代實作（核心表）

本表是實作的依據。每列都有「怎麼補」，不寫「不做」。成本與階段是預估，標示「預估」。

### 3.1 執行與同步

| CUDA／PTX 原語 | WGSL 原生 | 替代實作（WGSL） | WebGL2 做法 | CPU 做法 | 預估成本 | 階段 |
|---|---|---|---|---|---|---|
| grid／block／thread 階層 | 有：dispatch 的 workgroup 數＋`workgroup_id`、`local_invocation_id` | — | 每個輸出元素一個 fragment | 迴圈 | 低 | 1 |
| 超過 workgroup 大小上限 | — | 多趟 dispatch，每趟處理一段 | 多趟繪製 | 迴圈 | 低 | 1 |
| 共享記憶體 | 有：`var<workgroup>`，預設上限 16 KiB（依能力檔） | 大陣列分塊，每塊一趟 | 以紋理分塊多趟 | 陣列 | 中 | 1 |
| `__syncthreads()` | 有：`workgroupBarrier()` | 屏障位於分支內時，改寫成所有執行緒走同一路徑 | 不需要（每趟是獨立的繪製） | 不需要 | 中 | 1 |
| grid 級同步 | 沒有 | 拆成多趟 dispatch，dispatch 之間就是同步點 | 多趟繪製 | 迴圈 | 低 | 2 |
| warp shuffle、vote、ballot | 有（subgroups，檔 C） | 沒有 subgroups 時：共享記憶體＋屏障做歸約與廣播 | 紋理多趟 | 迴圈 | 中（歸約）；高（任意 shuffle） | 1 |
| 動態平行（核心內啟動核心） | 沒有 | 主機端排程多趟；或 indirect dispatch，前一趟寫下一趟參數 | 主機端多趟 | 主機排程 | 中 | 3 |
| 遞迴 | 沒有 | 顯式堆疊（陣列加索引）取代遞迴 | 同左 | 原生遞迴 | 中 | 4 |
| 函式指標、vtable | 沒有 | `switch` 分派加常數表；或展開成多個核心 | 同左 | 原生 | 低到中 | 4 |
| printf | 沒有 | 寫入除錯 storage buffer，主機讀回後印出 | 紋理讀回 | 直接印 | 低 | 1 |

### 3.2 數值型別

| 原語 | WGSL 原生 | 替代實作 | WebGL2 做法 | CPU 做法 | 預估成本 | 階段 |
|---|---|---|---|---|---|---|
| f32 | 有 | — | 有（RGBA32F，需 EXT_color_buffer_float；否則 RGBA8 打包） | 有 | 低 | 1 |
| f16 | 有（`shader-f16`，檔 C） | 沒有 `shader-f16`：整個核心改用 f32 版本 | RGBA16F（需 EXT_color_buffer_half_float） | f32 計算 | 低 | 1 |
| bf16 | 沒有 | 以 u16 位元移位轉成 f32 計算 | 同左 | 同左 | 低 | 2 |
| tf32 | 沒有 | 以 f32 計算（精度較高，結果不位元相同） | 同左 | 同左 | 低 | 2 |
| f64 | 沒有 | 雙 f32（double-float，`hi + lo`，TwoSum、TwoProd）；有效尾數約 48 位元（預估，待實測） | 同左，每個運算約 10 至 20 倍工作量 | 原生 f64 | 高（每個運算 10 至 20 倍） | 2 |
| 64 位元整數 i64、u64 | 沒有 | 兩個 u32 加進位與借位；乘法用 16 位元分段 | 同左 | 原生 | 中到高 | 2 |
| 8、16 位元整數原子 | 沒有 | 用 32 位元原子加遮罩模擬 | 不需要原子 | 原生 | 中 | 3 |

### 3.3 原子與記憶體

| 原語 | WGSL 原生 | 替代實作 | WebGL2 做法 | CPU 做法 | 預估成本 | 階段 |
|---|---|---|---|---|---|---|
| i32、u32 原子（add、min、max、and、or、xor、exchange、compareExchange） | 有（檔 B 以上） | — | 沒有原子：多趟排序後歸約（直方圖用排序加段落歸約） | 原生 | 低（有原子時）；中（用排序時） | 1 |
| f32 原子加 | 沒有 | `atomic<u32>` 的 compare-exchange 迴圈，用 `bitcast<f32>` 讀寫；競爭高時慢 | 排序後歸約 | 原生 | 中（低競爭）；高（高競爭） | 2 |
| 64 位元原子 | 沒有 | 分散累加：每個 workgroup 先歸約，再用兩個 32 位元原子合併高低兩半並記錄進位 | 排序後歸約 | 原生 | 高 | 3 |
| 全域記憶體合併存取 | 沒有保證（依驅動） | 以連續索引與 `vec4` 讀寫為設計原則，實測後調整 | 紋理取樣順序 | 快取友善的迴圈 | 效能風險，無法靜態保證 | 1 |
| 指標與任意位址 | 只有 `ptr<storage/workgroup/function, T>`，沒有指標算術 | 所有陣列放進綁定的 storage buffer，用整數索引；超過單一 buffer 上限就分塊並帶 buffer 索引 | 紋理座標 | 指標 | 中 | 1 |
| 非同步複製到共享記憶體（`cp.async`） | 沒有 | 雙緩衝：queue 的複製與計算重疊 | 紋理上傳與繪製重疊 | 預取 | 中 | 3 |
| 非同步屏障（mbarrier） | 沒有 | `workgroupBarrier` 粗粒度替代 | 不需要 | 不需要 | 中（效能風險） | 3 |
| 統一記憶體 | 沒有 | 明確的 buffer 上傳與回讀，由排程器管理 | 紋理上傳回讀 | 同一位址 | 低 | 2 |

### 3.4 矩陣與張量指令

| 原語 | WGSL 原生 | 替代實作 | WebGL2 做法 | CPU 做法 | 預估成本 | 階段 |
|---|---|---|---|---|---|---|
| warp 矩陣指令（`wmma`，PTX `mma.sync`） | 沒有 | 平鋪的 workgroup 矩陣乘：16×16 分塊，共享記憶體加屏障 | 分塊多趟繪製 | 分塊迴圈 | 高（速度差距待實測） | 1（矩陣乘本身）；指令層 3 |
| warpgroup 矩陣指令（wgmma） | 沒有 | 同上，分塊更大 | 同上 | 同上 | 高 | 3 |
| tf32、bf16 Tensor Core 模式 | 沒有 | 以 f32 或 u16 位元移位計算 | 同上 | 同上 | 中 | 2 |
| thread block cluster（最多 16 個 CTA 協作） | 沒有跨 workgroup 共享記憶體 | 拆核心，用全域記憶體中轉；或在單一 workgroup 內模擬 | 多趟 | 迴圈 | 高 | 3 |
| TMA（張量搬移單元） | 沒有 | 手寫的 buffer 索引搬移與分塊，效能差距待實測 | 紋理取樣 | 迴圈 | 中到高 | 3 |

---

## 4. 編譯路線

### 4.1 管線

```
Python 核心（@cuda.jit 風格子集）──┐
                                  ├─► 中介表示（IR）─┬─► WGSL（L1／L2）
PTX（LLVM NVPTX 產出）──► PTX 解析┘                 ├─► WebGL2 片段著色器（L3）
                                                    └─► CPU 解譯（L5）
```

- **中介表示**：SSA 風格，運算元有型別（f32、i32、u32、f16；f64、i64 先展開成多個 32 位元值）。
- **能力檔決定展開**：檔 A 的 IR 不含原子，遇到原子就展開成多趟；檔 B 以上可直接用原子。
- **拒絕而不靜默**：遇到還沒有替代實作的原語，編譯時回報「原語 X 尚未有替代實作，階段 N」，不靜默降級。

### 4.2 語法子集（`@cuda.jit` 風格）

| 支援 | 不支援（改用替代，列於右） |
|---|---|
| `cuda.grid(1)`、`cuda.blockIdx`、`cuda.threadIdx`、`cuda.blockDim` | 不支援直接用 `cuda.grid` 以外的 API 時，回報清楚 |
| `cuda.shared.array(shape, dtype)` | 超過共享記憶體上限：分塊 |
| `cuda.syncthreads()` | 屏障在分支內：改寫為統一路徑 |
| `cuda.atomic.add(arr, idx, val)`（i32、u32） | f32 原子：CAS 迴圈；檔 A 用多趟 |
| `for i in range(...)`、`if`、基本算術、ndarray 索引 | `try`／`except`：改用錯誤碼 |
| `print`：寫入除錯 buffer，主機讀回 | 直接印出：不支援 |
| 遞迴：不支援 | 改用顯式堆疊 |
| 推導式、`with`、`yield`、核心內配置陣列 | 改寫為迴圈與預先配置的陣列 |

型別推斷只允許 f32、i32、u32、f16；f64、i64 在解析時展開成多個 32 位元值的內部型別。

### 4.3 範例核心

1. **向量加**：`c[i] = a[i] + b[i]`，全部層都有。
2. **矩陣乘**：16×16 平鋪、共享記憶體、兩個屏障。
3. **歸約**：每個 workgroup 步進取數，樹狀歸約，多趟直到一個值。
4. **直方圖（含原子）**：檔 B 以上用 `atomic<u32>` 加；檔 A 用排序後段落歸約。

### 4.4 NVPTX／PTX 子集轉譯

**路線**：LLVM IR → NVPTX 後端 → PTX 文字 → 本專案的 PTX 解析器 → IR → WGSL、WebGL2 或 CPU。

**第一批支援的 PTX 指令**（從 `DESIGN.behavior-analyzer.md` 的 PTX 表 174 條挑選，逐條核對後定案）：

| 類別 | 指令 | 說明 |
|---|---|---|
| 搬移 | `mov`、`cvt`（到 i32、u32、f32） | — |
| 算術 | `add`、`sub`、`mul.lo`、`mad.lo`、`fma`、`div.rn`（f32）、`rem`、`min`、`max`、`abs`、`neg` | — |
| 位元 | `and`、`or`、`xor`、`shl`、`shr`、`not` | — |
| 比較與選擇 | `setp`、`selp` | — |
| 分支 | `bra`、`ret`、`exit` | 結構化分支；非結構化分支用顯式堆疊 |
| 記憶體 | `ld.param`、`ld.global`、`st.global`、`ld.shared`、`st.shared` | `.param` 改成 uniform 或 storage buffer |
| 同步 | `bar.sync 0` | 屏障在分支內要檢查 |
| 原子 | `atom.global.add`、`atom.shared.add`（i32、u32） | f32 原子用 CAS；檔 A 用多趟 |
| 其他 | `f64`、`u64`、`mma`、`shfl`、`vote`、`call` | 用第 3 節的替代：f64 雙 f32、u64 兩個 u32、`mma` 平鋪、`shfl` 共享記憶體、`vote` 屏障加歸約、`call` 內聯 |

**風險**：PTX 的隱含行為（`setp` 的 NaN 語意、`div.rn` 的捨入）與 WGSL 不同，要逐條寫測試。實作只依 NVIDIA 公開的 PTX ISA 文件，不解析 NVIDIA 內部格式，不使用 NVIDIA 二進位或 SDK 程式碼。

---

## 5. 函式庫層

### 5.1 cuBLAS 常用子集

介面照 cuBLAS 命名與參數順序，去掉 handle，陣列取代裸指標。

| 子程式 | 語意 | 實作做法 | 階段 |
|---|---|---|---|
| `sgemm` | C ← α·op(A)·op(B) + β·C | 平鋪核心；轉置用索引映射；α、β 乘在輸出 | 1（最小版：N、N、α=1、β=0），2（完整） |
| `sgemv` | y ← α·op(A)·x + β·y | 每列一個 workgroup 歸約 | 2 |
| `saxpy` | y ← α·x + y | 逐元素 | 2 |
| `sdot` | x·y | 歸約（與第 3.1 節相同） | 2 |
| `sscal` | x ← α·x | 逐元素 | 2 |
| `snrm2` | ‖x‖₂ | 平方和歸約後開根；用縮放避免溢位與下溢（與參考 BLAS 同思路） | 2 |
| `sgemmStridedBatched` | 批次矩陣乘 | 第三個 workgroup 維度為批次索引 | 2 |
| `dgemm`（f64） | 同 `sgemm` 但 f64 | 雙 f32 的平鋪核心 | 2 |
| `gemmEx`（混合精度） | 輸入 f16、累加 f32 | 輸入以 f32 讀取（檔 C 可直接用 f16） | 2 |

**`sgemm` 參數語意**（Python 端 `cudaweb.cublas.sgemm(transa, transb, m, n, k, alpha, A, B, beta, C)`）：
- `transa`、`transb`：`'N'` 用原樣，`'T'` 轉置。第二階段起支援。
- `m`、`n`、`k`：op(A) 為 m×k，op(B) 為 k×n，C 為 m×n。
- `A`、`B`、`C`：列主序扁平 list。cuBLAS 原本是欄主序，我們用列主序，行主序的呼叫者不需要交換運算元。
- 與 cuBLAS 的差異（一律寫在回報裡）：沒有 handle；沒有 `lda` 等參數（由形狀推得）；陣列是 list 而不是裝置指標。

### 5.2 cuDNN 常用子集

| 運算 | 實作做法 | 複雜度（預估） | 階段 |
|---|---|---|---|
| 卷積前向 | im2col 加 sgemm（組合）；或直接卷積核心 | im2col 增加記憶體 | 3 |
| 卷積反向（資料、濾波器） | 兩個 im2col 加 sgemm 的反向形式 | 同上 | 3 |
| 池化（max、avg）前向與反向 | 逐元素窗口核心 | O(窗口·輸出) | 3 |
| softmax 前向與反向 | 歸約（最大值、和）加逐元素 | O(n) | 3 |
| 批次正規化前向與反向 | 歸約（均值、變異數）加逐元素 | O(n) | 3 |
| 激活（relu、tanh、sigmoid、gelu） | 逐元素 | O(n) | 3 |
| 注意力（SDPA） | 第一版：數學版（mm、softmax、mm），不融合；之後加分塊版 | O(s²d)，記憶體 O(s²)；分塊版降為 O(s) | 3（數學版）；4（分塊版） |

### 5.3 ATen 運算子對映

| ATen 運算子 | 對到 | 階段 |
|---|---|---|
| `aten::mm` | `sgemm` | 2 |
| `aten::bmm` | 批次 `sgemm` | 2 |
| `aten::addmm` | `sgemm` 加 bias（β=1） | 2 |
| `aten::matmul` | 依維度分派到 mm 或 bmm | 2 |
| `aten::mv` | `sgemv` | 2 |
| `aten::dot` | `sdot` | 2 |
| `aten::softmax`、`log_softmax` | 自寫歸約核心（或 cuDNN softmax） | 3 |
| `aten::layer_norm`、RMSNorm | 自寫歸約核心 | 3 |
| `aten::conv2d` | 卷積前向（5.2） | 3 |
| `aten::scaled_dot_product_attention` | 數學版（5.2） | 3 |
| 逐元素（`add`、`mul`、`relu`、`gelu`…） | 自寫核心 | 3 |
| `aten::sum`、`mean` | 歸約核心 | 1 |
| `aten::cross_entropy`、`nll_loss` | 自寫核心（含 log-softmax） | 3 |
| `aten::embedding` | 自寫 gather 核心 | 3 |
| AdamW（融合或 foreach） | 自寫核心 | 3 |
| `aten::index_select` | 自寫 gather | 3 |
| `aten::scatter_add`、`index_add` | f32 原子用 CAS；檔 A 用排序後歸約 | 3 |
| `aten::batch_norm` | cuDNN 批次正規化 | 3 |
| FFT | 自寫 FFT 核心（蝶形運算，逐階段 dispatch） | 4 |
| 稀疏張量 | 自寫 CSR 核心（gather 加歸約） | 4 |
| 量化（int8 等） | 反量化成 f32 後計算；再加專用核心 | 4 |
| nested tensor | 展平成 padded 批次加遮罩 | 4 |
| 分散式（c10d） | 單機多裝置排程；跨機網路不在本設計範圍 | 4 |
| 自動混合精度 | 以 f16 或 f32 切換，沿用 autocast 語意 | 4 |

**PyTorch 後端擴充機制**：不做 PyTorch 的 C++ 後端外掛（那需要編譯進 PyTorch），只做 JS 端的 ATen 風格介面。上表是介面對映，不是 dispatch 註冊。

### 5.4 精度與容差

- **預設累加**：f32。`accumulate` 欄位記錄實際累加型別。
- **TF32**：PyTorch 預設 matmul 的 TF32 關閉、卷積的 TF32 開啟（PyTorch 1.12 之後）。我們用 f32 計算，精度比 TF32 高，結果與 CUDA 的 TF32 不位元相同。`inputPrecision` 欄位記錄。
- **f16 累加**：PyTorch 文件說半精度 GEMM 通常以 f32 累加。我們用 f32，記錄為 `accumulate: "f32"`。
- **容差（暫定，待實測）**：相對誤差 ≤ c·√k·ε，k 為內積長度，ε 為機器精度，c 由實測決定。比對基準用更高精度的參考（CPU 的 f64 或雙 f32）。
- **整數與原子直方圖**：完全相等。
- **禁止說法**：「與 CUDA 完全相容」「位元相同」。只能說「在記錄的容差內一致」，並附實測數字與容差來源。

---

## 6. 接進 Python 模擬器

### 6.1 架構

```
Python 程式（模擬器裡）
  └─ import cudaweb          renderer/src/pybridge/cudaweb.py
       └─ _fa_cudaweb.call(op, argsJson)     Pyodide 註冊的 JS 模組（floating-assistant.js）
            └─ _cudawebCall(op, args)        主程式的宿主方法
                 └─ FaGpuCore.createRuntime  renderer/src/gpu/gpu_core.js（WGSL、WebGL2、CPU 核心）
```

- 網頁版與桌面版走同一條 Pyodide 路徑（`_pyBridgeInstallPyodide` 開頭呼叫 `_cudawebInstallPyodide`）。
- `cudaweb` 與 `fa_bridge` 分開：不受「Python API 轉接」開關影響。
- `cudaweb.py` 在一般 Python（非 Pyodide）裡會報錯並說明，不會壞掉。

### 6.2 API 清單

| 函式 | 說明 | 回傳 |
|---|---|---|
| `cudaweb.vector_add(a, b)` | 向量加 | list |
| `cudaweb.matmul(A, B)` | 矩陣乘，二維 list | 二維 list |
| `cudaweb.sum(a)` | 歸約（總和） | float |
| `cudaweb.backend_info()` | 第 2.4 節的格式 | dict |
| `cudaweb.cublas.sgemm(transa, transb, m, n, k, alpha, A, B, beta, C)` | 第 5.1 節 | list |
| `cudaweb.kernel(src)`（第二階段起） | `@cuda.jit` 風格核心的編譯與執行 | 可呼叫物件 |

### 6.3 範例程式

`renderer/src/gpu/examples/cudaweb_demo.py`：向量加、矩陣乘、歸約，最後印出 `backend_info()` 的層與原因。

### 6.4 沒有 GPU 時的行為

- 每個函式都會回傳正確結果（經由降級層），`backend_info()` 說明實際用的層與原因。
- 例：「此瀏覽器沒有 WebGPU（navigator.gpu 不存在），也沒有 WebGL2，改用 WASM」。
- 只有在參數錯誤（形狀不合、非有限數字）時才報錯，而且不會嘗試降級。

### 6.5 GUI 模擬器（`py_worker`）

GUI 的獨立 Worker 模擬器目前沒有註冊 `_fa_cudaweb`，不能 `import cudaweb`。接法列入第 10 節的第三階段項目。

---

## 7. 離線模型推論與訓練資源

### 7.1 登錄為訓練工作室運算後端

- `renderer/src/studio/backend_core.js` 的 `BACKEND_IDS` 新增 `cudaweb`，`KIND_BACKENDS.lora` 加入 `cudaweb`。
- `webgpuTierProbe(backendInfo)` 已存在（第一階段），擴充為 `cudawebProbe(backendInfo)`：可用條件為有 WebGPU 或 WebGL2 裝置；`reason` 必填（不可用時）；`fingerprint` 含能力檔、各核心的層。
- 訓練工作室的後端選單選得到；狀態顯示實際走哪一層（例如「cudaweb：檔 B，matmul 與 softmax 用 WGSL，AdamW 用純 JS（替代尚未完成）」）。
- 登錄表的 `MATURITY` 排序：cudaweb 排在 webgpu 之前（它是 webgpu 的超集，但有降級回報）。實際排序以基準測試為準（既有規則）。

### 7.2 熱點接法

| 運算 | 原本路徑 | 改接 | 階段 |
|---|---|---|---|
| matmul（LoRA A、B 乘法；MLP） | `onnx_grad_core.js`、`lora_ref_train.js` 的純 JS | `cudaweb.sgemm`（T1 或 T3） | 2 |
| softmax（注意力） | 純 JS | 歸約核心 | 3 |
| RMSNorm、layer norm | 純 JS（`qwen3_layered_engine.js`） | 歸約核心 | 3 |
| attention（前向） | 純 JS | 數學版（mm、softmax、mm） | 3 |
| AdamW | 純 JS 或 `llm_scratch.py` | 逐元素核心 | 3 |
| 交叉熵 | 純 JS | 歸約核心 | 3 |

- 沒接的運算子退回原本的純 JS 或 Python 路徑。
- **容差一致**：每個接上的運算子，都要與原路徑比對，在容差內一致才啟用。比對不過的運算子不啟用，回報原因。
- `llm_scratch.py`（Python 路徑）：透過 `cudaweb` 模組呼叫，前提是在 Pyodide 裡執行；原生 Python 路徑維持原樣。

### 7.3 Qwen3-0.6B 推論熱點概念驗證

**現有執行提供者（查閱程式碼）**：
- `nr-engine.js`（桌面版）：原生 onnxruntime-node，CPU 執行提供者。
- `llm_web_core.js`（網頁版）：transformers.js 或 WebLLM 類路徑，視模型而定，常見為 WebGPU 或 WASM。

**接法**：cudaweb 不取代 onnxruntime，而是接在「自家 WebGPU 路徑」這一層：
- 網頁版：當 transformers.js 的 WebGPU 不可用時，或要用自家核心時，用 cudaweb 跑 lm_head 與 MLP 的 matmul。
- 桌面版：onnxruntime-node 維持 CPU；cudaweb 跑 matmul 的部分需要把輸出搬回來，代價待實測。

**概念驗證範圍**：Qwen3-0.6B 的 lm_head（151936×1024）與一層 MLP（1024×3072、3072×1024）。讀入相同的權重與輸入，與現有輸出比對，在容差內一致即算通過。**完整推論取代是後續階段**。

**缺的運算子（完整推論還需要）**：RoPE、注意力（分塊版）、RMSNorm、SiLU、q8 反量化矩陣乘（現有權重格式）、KV 快取。

### 7.4 與原生執行環境的關係

- cudaweb 不改動 `main-ext.js` 的原生執行包流程。
- 原生執行包（onnxruntime-node）仍是 CPU；cudaweb 只在網頁版或 Pyodide 路徑提供 GPU 加速。
- 若未來要在原生執行包用 GPU，走 onnxruntime 的 GPU 執行提供者，不屬於本設計。

---

## 8. 資源調度

### 8.1 GPU 緩衝區預算

- 預算並入既有的記憶體預算（與「同時最多 N 顆 LoRA」用同一套機制）。
- `backend_info().budget` 回報 `limitBytes` 與 `usedBytes`。
- 每次分配 GPU 緩衝區前檢查預算；超過預算時：先釋放快取的暫存緩衝區，再不夠就降層（到 WASM 或純 JS），並回報原因。

### 8.2 釋放策略

- 暫存緩衝區（核心內的中間結果）：用完立即 `destroy()`。
- 權重緩衝區（LoRA 或基底模型）：綁定到模型生命週期，模型卸載時釋放。
- 快取的管線（pipeline）：保留，但有上限，超過時釋放最久沒用的。

### 8.3 共用裝置的排程

Python 模擬器與離線模型推論共用同一個 GPU 裝置：

- **互斥鎖加優先級**：離線模型推論（訓練與推論）優先級高於模擬器使用者程式。
- **時間片**：模擬器的單次 dispatch 限制執行時間（例如 50 毫秒），超過就讓出，給推論一個機會。
- **餓死防護**：模擬器連續等待超過門檻時，推論暫停一個時間片讓模擬器跑。
- **排程結果寫進 `backend_info().scheduler`**：目前排程者、等待中的工作數、最近一次讓出的原因。

第一版實作互斥與時間片；餓死防護以計數器實作，門檻可設定。

---

## 9. 測試與驗證策略

### 9.1 三層互相比對

每個核心在三層（WGSL、WebGL2、CPU）各跑一次，同一組輸入與隨機種子，互相比對，容差依第 5.4 節。

### 9.2 假的後端

- **假 WebGPU**（`gpu_core.test.js` 已有）：依 WGSL 開頭的 `@kernel` 標記，改用 CPU 參考版算結果。驗證流程，不驗證 WGSL 本身。
- **假 WebGL2**：假的上下文，實作 `createTexture`、`createFramebuffer`、`drawArrays` 等最小介面，依 fragment shader 的標記用 CPU 參考版算。驗證流程。
- **假 Pyodide**（`cudaweb_py_test.py` 已有）：假的 `_fa_cudaweb` 與 `pyodide.ffi`。

### 9.3 真桌面版驗證（額度：每個版本最多一次）

- 目標：確認真 WebGPU 的 adapter 與功能清單；確認一個核心的結果在容差內；確認 WebGL2 層能跑一個核心。
- 工具：`scripts/eval/cudaweb_gpu.run.js` 與 `cudaweb_gpu.eval.js`。啟動器會開視窗、搶焦點，執行前先 `node --check`。
- 檢查結果的回傳值要正確傳回（第一次的評估檔因為缺 `return` 而丟失結果，已修正）。

### 9.4 已驗證與未驗證（一句話）

- **已驗證**：CPU 參考版、降級流程、Python 端參數與宿主呼叫（假後端）。
- **未驗證**：真 WebGPU 的 adapter 與核心結果、WebGL2 層、真 Pyodide 中的 `import cudaweb`、網頁版真瀏覽器、數值容差的實測值、Qwen3 熱點比對。

---

## 10. 分階段路線圖

| 階段 | 範圍 | 完成標準 | 依賴 | 預估工時 | 進度 |
|---|---|---|---|---|---|
| **第一階段** | 向量加、矩陣乘（sgemm 最小版）、歸約；WGSL 版與 CPU 版；能力檔與 `backend_info`；WebGL2 版（第 3 階段前先做三個核心）；Python 模擬器接線 | 三層互相比對通過（假後端）；Python 端測試通過；真桌面版確認 adapter 與一個核心 | 無 | 2 至 3 輪 | WGSL＋CPU＋Python 接線已完成（`d437fda9f`、`b79454138`）；能力檔、WebGL2、三層比對待做 |
| **第二階段** | cuBLAS 常用子集（5.1）；f32 原子 CAS、f64 雙 f32、i64 雙 u32（替代層）；`backend_core` 登錄 `cudaweb` | 每個子程式與 CPU 比對通過；替代層與 CPU 比對在容差內 | 第一階段 | 3 至 4 輪 | 待做 |
| **第三階段** | cuDNN 常用子集與 ATen 對映（5.2、5.3）；熱點接入訓練（7.2）；GUI 模擬器接線（6.5） | 卷積前向反向、softmax、layer norm、交叉熵與 CPU 比對；訓練熱點接入後 LoRA 單層梯度對拍 | 第二階段 | 4 至 6 輪 | 待做 |
| **第四階段** | Qwen3-0.6B 推論熱點概念驗證（7.3）；資源調度（8）；PTX 子集轉譯（4.4）；分塊版注意力 | 熱點比對通過；排程不餓死；PTX 第一批指令通過 | 第三階段 | 4 至 6 輪 | 待做 |
| **第五階段** | 完整推論取代；全模型 20 步 loss 對拍（TODO §5.7 階段 4(c)） | 每步 loss 差 ≤ 2% | 第四階段 | 視結果 | 待做 |

**第二與第三階段的並行**：cuBLAS 完成後，熱點接入可與 cuDNN 並行，但兩者都會改 `backend_core.js` 與 `gpu_core.js`，需要排序。

---

## 11. 風險與開放問題

每項寫對策。

| 風險 | 對策 |
|---|---|
| 替代實作（CAS、雙 f32、多趟）很慢 | 先求能跑、結果在容差內；再依 `backend_info` 的 `ops` 找熱點，逐項優化；效能差距以實測記錄 |
| 容差沒有實測數字 | 第一階段的一致性測試同時記錄實際誤差，容差以實測值的倍數定義 |
| WebGL2 的精度（RGBA8 打包） | 打包層的誤差記錄在 `accumulate` 與 `precision` 欄位；誤差超過容差時該核心不啟用 |
| 軟體介面卡或舊 GPU 的驅動差異 | 能力檔歸類時以 `isFallbackAdapter` 與 limits 判斷，不以型號判斷；真機驗證結果寫進回報 |
| 桌面版與網頁版的 WebGPU 行為不同 | 同一份程式；差異由 `backend_info` 回報；真桌面版驗證額度有限，網頁版真瀏覽器待補 |
| 離線模型與模擬器搶 GPU | 第 8.3 節的排程；互斥加時間片加餓死防護 |
| 法律：NVIDIA 授權條款禁止逆向工程輸出以支援非 NVIDIA 平台 | PTX 轉譯只依 NVIDIA 公開的 PTX ISA 文件；不取用 NVIDIA 二進位、SDK 或第三方 ZLUDA 類程式碼；法律意見需要使用者或法務確認 |
| 數值比對的累加順序造成假失敗 | 比對用高精度參考，不用 CUDA 原始輸出；容差依第 5.4 節 |
| 熱點接入後結果與原路徑不一致 | 每個接上的運算子都有比對測試；不一致就不啟用並回報 |
| 原生執行包（onnxruntime-node）沒有 GPU 加速 | 本設計不改原生路徑；需要時另走 onnxruntime 的 GPU 執行提供者 |

---

## 附錄 A：檔案與模組索引

| 檔案 | 責任 | 狀態 |
|---|---|---|
| `renderer/src/gpu/gpu_core.js` | 能力偵測、CPU 參考版、WGSL 核心（向量加、矩陣乘、歸約）、執行期（降級與回報） | 已實作（WGSL＋CPU）；WebGL2 層、能力檔待做 |
| `renderer/src/gpu/gpu_core.test.js` | node 測試（假 WebGPU、降級路徑、登錄表對映） | 已實作，20 項 |
| `renderer/src/gpu/cudaweb_py_test.py` | Python 端測試（假宿主） | 已實作，10 項 |
| `renderer/src/gpu/examples/cudaweb_demo.py` | 範例程式 | 已實作 |
| `renderer/src/gpu/cublas.js`（規劃） | cuBLAS 子集 | 待做 |
| `renderer/src/gpu/webgl2_core.js`（規劃） | WebGL2 GPGPU 層 | 待做 |
| `renderer/src/gpu/profile.js`（規劃） | 能力檔歸類與 `backend_info` 組裝 | 待做 |
| `renderer/src/gpu/budget.js`（規劃） | GPU 緩衝區預算與排程 | 待做 |
| `renderer/src/pybridge/cudaweb.py` | Python 端 API | 已實作 |
| `renderer/src/studio/backend_core.js` | 運算後端登錄表；`webgpuTierProbe` | 已實作；`cudaweb` 登錄待做 |
| `renderer/src/floating-assistant.js` | Pyodide 註冊 `_fa_cudaweb`（`_cudawebInstallPyodide`）；宿主方法 | 已實作 |
| `scripts/eval/cudaweb_gpu.run.js`、`cudaweb_gpu.eval.js` | 真桌面版檢查 | 已實作；結果待重跑 |

## 附錄 B：名詞表

| 名詞 | 意思 |
|---|---|
| 能力檔 | 我們自己的裝置分級（A、B、C），借用 CUDA 算力版本的概念 |
| 降級層（L1 至 L5、T1 至 T5） | 第 2.1 節的執行層級；回報時用 `T1` 至 `T5` |
| 替代實作 | 原生不支援的原語，用其他原語組合出來的做法 |
| 平鋪（tiling） | 把大矩陣切成小塊，每塊放進共享記憶體或紋理後計算 |
| 多趟（multi-pass） | 同一個運算拆成多次 dispatch 或繪製，趟與趟之間就是同步點 |
| double-float | 用兩個 f32 的和表示一個高精度數，`hi + lo` |
| CAS | compare-and-swap，用來實作 f32 原子加的迴圈 |
| WGSL | WebGPU 的著色語言 |
| fragment shader | WebGL2 中每個輸出像素執行的程式，我們用它當核心 |
| NVPTX | LLVM 的 NVIDIA PTX 後端 |
| ATen | PyTorch 的底層張量運算庫 |
| 排程（scheduler） | 決定哪個工作先用 GPU 的模組 |
