# Python 範例（run terminal 預設資料夾 `/work/examples/python/`）

在 run terminal 裡直接執行，例如：

    cd examples/python/gpgpu
    python nbody3d.py
    python fluid3d.py --device cpu

| 資料夾 | 內容 |
|---|---|
| `game/` | 打磚塊、飛彈指揮官、賽車、類馬力歐闖關、RPG、類暗黑破壞神的地圖探索（2D，`import pygame` 小子集） |
| `gui/` | 讀檔寫檔編輯器、音樂、MIDI、照片檢視器（viewport、縮放、翻轉）、曼德博、碎形、3D 場景（`gl_scene.py`） |
| `gpgpu/` | 3D N-body（照 `sdlmm/exams/nbody3d.c` 移植：同物理、同隨機化、同控制與覆蓋層、加成混合的光點）、3D SPH 流體：計算來源可在視窗內或用 `--device cpu|gpu|auto` 切換 |

## 3D／OpenGL：`gl3d`

`import gl3d` 提供 OpenGL 風格的 3D：視窗裡的 WebGL2 畫布，在你的真 GPU 上繪圖。上傳頂點緩衝區、登記 GLSL ES 3.00 著色器、每幀送一串指令
（clear、use、uniform、attr、draw）。內建 flat、lit、points、dots 四個程式，附矩陣數學、軌道相機、立方體／球／格線。
從 `gui/gl_scene.py` 開始看；自訂著色器的寫法也在那裡。不是 PyOpenGL：沒有全域 GL 環境，也沒有 `glXxx` 函式名。

## 計算來源（gpgpu）

- **CPU**：numpy，永遠可用。
- **GPU**：numba `@cuda.jit` 核心，由 GPU 相容層翻成 WGSL，經 WebGPU 在真 GPU 執行。核心裡的純量參數會在翻譯時寫死。
- GPU 核心跑不起來（沒有 WebGPU、頁面拒絕）時，相容層會改用 Python 逐執行緒模擬，比 numpy 慢很多；範例偵測到就自動退回 CPU 並在畫面上說明。
- `--bench`：不開視窗，兩個來源各跑幾步並比對結果與耗時。
- 另外，AI 助理設定 →「GPU 相容層」有「CPU 分擔矩陣乘的核心數」：大於 0 時，`mm_ops` 的矩陣乘會由 GPU 與 CPU 的 Worker 分工（內顯與 CPU 共用記憶體）。預設 0＝完全不分擔。

## 限制（來自圖形橋接層）

- 2D 畫布每幀最多 200 道指令；GL 畫布每幀最多 256 道指令，單一緩衝區 4 MB、24 個緩衝區、12 個程式。
- 聲音只有短嗶聲（`tone`）。
- 鍵盤要先點一下視窗；滾輪縮放要按 Ctrl。
