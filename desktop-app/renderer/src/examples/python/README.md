# Python 範例（run terminal 預設資料夾 `/work/examples/python/`）

在 run terminal 裡直接執行，例如：

    cd examples/python/gpgpu
    python nbody3d.py
    python fluid3d.py --device cpu

| 資料夾 | 內容 |
|---|---|
| `game/` | 打磚塊、飛彈指揮官、賽車、類馬力歐闖關、RPG、類暗黑破壞神的地圖探索（標準的 pygame-ce 寫法） |
| `gui/` | 讀檔寫檔編輯器、音樂、MIDI、照片檢視器（viewport、縮放、翻轉）、曼德博、碎形、3D 場景（`gl_scene.py`） |
| `opencl/` | **標準的 pyopencl**（pip 的真套件，我們只接後端）：`device_info.py`（平台與裝置）、`vector_add.py`（官方 Getting started 原封不動）、`array_ops.py`（pyopencl.array：逐元素、歸約、前綴和、複數、ElementwiseKernel／ReductionKernel）、`local_memory_reduction.py`（`__local`＋`barrier`：樹狀歸約與前綴和）、`matmul_tiled.py`（分塊矩陣乘法）、`nbody_float4.py`（float4 向量）、`complex_mandelbrot.py`（複數型別）、`gl_interop.py`（OpenCL↔OpenGL 互通，需要 pygame＋PyOpenGL 視窗） |
| `gpgpu/` | `swap_stream.py`（IndexedDB 當 swap 的 out-of-core 處理）、3D N-body（照 `sdlmm/exams/nbody3d.c` 移植：同物理、同隨機化、同控制與覆蓋層、加成混合的光點）、3D SPH 流體：計算來源可在視窗內或用 `--device cpu|gpu|auto` 切換 |

## pygame 與 OpenGL：都是 pip 的真套件

`import pygame` 是真的 pygame-ce，`from OpenGL.GL import *` 是真的 PyOpenGL（第一次用時 Worker 會從 PyPI 裝，要有網路）；我們只接後端
（視窗、事件、WebGL2），API 與 pip 的一樣，所以標準的 pygame／PyOpenGL 範例原封不動能跑。`pygame.display.set_mode((w, h), DOUBLEBUF | OPENGL)` 開 WebGL2 視窗。
聲音：`pygame.mixer`（`Sound`、`Channel`、`music`）會真的出聲，由頁面的 Web Audio 播放（多聲道、循環、音量）；`import fa_audio` 可以直接用。`gui` 的 `tone()` 仍是最簡單的單音嗶聲（`music_player.py`、`midi_tool.py` 用它）。

## 3D 小工具：`gl3d`

`import gl3d` 是建在 PyOpenGL 之上的小工具庫：軌道相機、矩陣數學、立方體／球／格線，內建 flat、lit、points、dots、glow 著色器；`View.show(frame)` 用 PyOpenGL 的函式
（`glCreateShader`、`glBufferData`、`glUniform*`、`glDrawArrays`…）畫一幀。從 `gui/gl_scene.py` 開始看；自訂著色器的寫法也在那裡。

## 計算來源（gpgpu）

- **CPU**：numpy，永遠可用。
- **GPU**：numba `@cuda.jit` 核心，由 GPU 相容層翻成 WGSL，經 WebGPU 在真 GPU 執行。核心裡的純量參數會在翻譯時寫死。
- GPU 核心跑不起來（沒有 WebGPU、頁面拒絕）時，相容層會改用 Python 逐執行緒模擬，比 numpy 慢很多；範例偵測到就自動退回 CPU 並在畫面上說明。
- `--bench`：不開視窗，兩個來源各跑幾步並比對結果與耗時。
- 另外，AI 助理設定 →「GPU 相容層」有「CPU 分擔矩陣乘的核心數」：大於 0 時，`mm_ops` 的矩陣乘會由 GPU 與 CPU 的 Worker 分工（內顯與 CPU 共用記憶體）。預設 0＝完全不分擔。

## 限制（來自圖形橋接層）

- 2D 畫布每幀最多 200 道指令；pygame／OpenGL 的畫面是一幀一張 PNG（至多 1 MB），所以沒有指令數與緩衝區數的上限。
- 聲音只有短嗶聲（`tone`）。
- 鍵盤要先點一下視窗；滾輪縮放要按 Ctrl。

## IndexedDB 當 swap：`fa_swap`

`import fa_swap`：陣列比記憶體大也能用。`a = fa_swap.array((100000, 256), 'float32')` 沿第 0 軸分頁，Python 只留熱區（預設 16 MB，`FA_SWAP_HOT_MB` 或 `fa_swap.set_hot_mb(n)` 調整），其餘經橋接放進 IndexedDB。
`a[i]`、`a[s:e]`、`a[[1,5,9]]`、`a[s:e, 3]` 讀寫都像 numpy；`a.blocks(n)`／`a.apply(fn)` 一塊一塊處理；`fa_swap.stats()` 看讀寫次數。沒寫過的頁讀出來是 0；程式結束就丟掉。
沒有橋接（或沒有 IndexedDB）時退回記憶體字典，功能一樣但不省記憶體（`stats()['backend']=='memory'`）。範例：`gpgpu/swap_stream.py`。

## OpenCL：標準的 pyopencl

`import pyopencl` 是 pip 的真 pyopencl（第一次用時從 PyPI 取得純 Python 檔案，要有網路；`pytools`、`platformdirs`、`mako` 用 micropip 裝）。C 擴充 `_cl` 那一層由我們提供，底下是 ICD 載入器與驅動：
平台 0 是 **GPU**（WebGPU → WebGL2，用 cudaweb 的 KIR 裝置層；很小的問題會自動改走 CPU），平台 1 是 **CPU**（我們的 OpenCL C 前端 → JS，支援 `__local`＋`barrier`、struct、向量型別、複數、原子操作）。
`cl.create_some_context()` 預設選第一個。限制見 `DESIGN.pyopencl.md` §10–§11（圖像、SVM、Pipe 尚未支援，會得到標準的 OpenCL 錯誤）。
OpenCL↔OpenGL 互通用標準寫法（`cl.GLBuffer`、`enqueue_acquire_gl_objects`、`get_gl_sharing_context_properties`）；GL 緩衝區與 OpenCL 緩衝區是兩塊記憶體，acquire／release 是同步點。
