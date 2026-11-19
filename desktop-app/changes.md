# 近期更新（2026-11-18 → 2026-11-20，live-update patch v484–v490）

驗證程度分三種標記：**真機**（使用者的真 GPU／真 Chrome 或 Electron 驗過）、**軟體 GL**（本機 SwiftShader／Electron 驗過，不代表真 GPU）、**靜態**（只做結構檢查或單元測試，沒有實跑）。

## 1. floating-assistant 的 LLVM（lli／llc）執行器

- **主機函式庫（host import）**：LLVM IR 可直接呼叫 SDL2、OpenGL、GTK3、SDL 音訊（佇列模式）、stdio；同一份 `.ll` 在模擬環境也能跑（`renderer/src/uml/llvm_host.js`）。編譯器補了內建浮點函式直出 wasm。
- **畫面**：OpenGL 畫面零拷貝（ImageBitmap），並加 JPEG 後送；修掉 gl3d 全黑（PyOpenGL 名字以 NUL 結尾造成 uniform／attribute 找不到）；GL 點大小修正。
- **螢幕文字（HUD）**：nbody／fluid 的 HUD 反映真實後端（`fa_cl_backend`）、時間標籤改為秒、CPU／GPU 按鈕真的切換計算來源、預設 GPU、選中按鈕綠底、GPU 不可用自動退回 CPU 並說明原因。
- **尚待處理**：`music_player`、`midi_player`、`sdl2_piano`、`sdl2_pong`、`sdl2_gl_triangle` 等互動範例畫面上沒有操作說明文字（每幀繪圖指令上限 200、7×13 字型只含 ASCII），已有設計，未實作。

## 2. OpenCL 墊片與 KIR

- **OpenCL 墊片**：run terminal／job 內的 llc 程式可呼叫 `clGetPlatformIDs … clEnqueueNDRangeKernel`；先有 CPU 後備（JS 墊片），再接 GPU。
- **KIR（核心中間表示）**：OpenCL C 子集 → KIR（`cl_front.js`）→ JS 後端（`kir.js`）／GLSL ES 3.00 渲染到紋理（`kir_gen.js`、`kir_webgl2.js`）／WGSL（`kir_gen.js`，**靜態**，未在真 GPU 驗證）。
- **GPU 常駐裝置層**：緩衝區留在 GPU 紋理，跨派送保留（alloc／upload／download／dispatch／free，拒絕 feedback loop）；llvm_host 以 `kirDev` 掛鉤使用，緩衝區有髒旗標，一個核心失敗退回 JS 墊片。
- **打包紋理（一次讀回）**：`allocPacked`／`view`／一次 `readPixels`、`u_off` 列偏移；單元與真裝置對照 eval 通過。**nbody 沒有採用**：修好後輸出與 CPU 一致，但軟體 GL 約 60 ms／幀，慢於 v489 的 20 ms，真 GPU 未驗證，所以 nbody 維持 v489 的逐部分讀回版（打包版生成器留在 `_gen/_wip_nbody3d_cl_packed.py.txt`）。
- **實測（真機，使用者）**：nbody 的 OpenCL 版 GPU 0.063 s／step 對 CPU 0.961 s／step（約 15 倍）；GPU 使用率 CPU 模式 <2%、GPU 模式 70%。軟體 GL 下 nbody N=512 約 20.5 ms／幀對 CPU 約 19 ms；fluid N=1000 約 148 ms 對 CPU 約 30 ms（軟體光柵化的成本，不是 GPU 的數字）。
- **Bug 紀錄**：`accel_cl` 的拷貝迴圈計數器沒歸零，使第 2 幀起輸出凍結（打包版 WIP 才有）；`u_off` 沒帶造成座標全相同（已修）。

## 3. OpenCL ↔ OpenGL interop（設計，未實作）

- 目標：位置資料留在 GPU，直接當點精靈來源，省掉每幀讀回。
- 卡關點：WebGL 紋理不能跨 context，而 GUI 畫布的 context（`renderer/src/gui/gui_render.js:48`）與 KIR 的離屏 context 不同；零拷貝需要 KIR 共用 GUI 畫布的 context。
- 設計在 `DESIGN.webgpu-cuda.md` §13 階段 6，有 4 個待決事項（context 取得方式、context lost 策略、批次上限值、步驟 2 是否等 1c）。另外 `llvm_host.js` 的 GL 批次目前只取前 20 筆，要改成具名常數。

## 4. cudaweb 後端與優化

- **後端選路**：WebGPU → WebGL2 → JS → CPU（`renderer/src/gpu/gpu_core.js` 的 `probeAdapter`／`profileOf`／`tolerance`）。OpenCL 的 GPU 後端接到同一層。
- **CUDA 後端**：CUDA runtime API 前端（cudaMalloc／cudaMemcpy／cudaLaunchKernel 子集）**尚未實作**，NVPTX 路線只有文件、沒有 PTX 解析器。
- **R3／R4／R5 優化**：matmul 子群組（M=1、K<1024）與 split-K（M=1、K≥1024，S=8）；LoRA 小 N 的 split-K；R4 平鋪工作群組 128／192／256 量測；q8mm split-K（整數累加，與 `q8mmRef` 逐位相同，純核心快 21–25%，端到端沒有好處所以不採用）；卷積 im2col＋GEMM、注意力 split-KV。
- **O8 訓練**：交叉熵上裝置、訓練頭一次提交、每群組一次提交、f16 前向（有 shader-f16）、整步一次提交（預設關）；修掉真 GPU 整步全為 0（`attn_bwd_kv` 宣告了未使用的綁定）。
- **O12 推論／骨架**：`llm_skeleton_gpu` 完整 GPU 解碼；llama3 RoPE 縮放；覆寫登錄表（`useOverrides`）；ONNX 讀取與 q8 骨架（**步 1 起未通過，如實記錄**）。
- **異質排程（CPU＋GPU 分工）**：分攤決策（固定成本、15% margin、比例上限 0.5、淨收益至少 10%）；速率持久化（IndexedDB，鍵含 op／瀏覽器／介面卡／核心數）；非同步佇列（stream／event，同 stream 保序）；`fa_gpu`／cupy／numba／torch 的 stream 與 event；範例 `async_overlap.py`（假裝置串列 3.648 秒、重疊 1.924 秒，省約 47%）。
- **純 CPU GEMM**：分塊打包核心＋WASM SIMD（f32x4）、多核（沿 M 分割、持久工作者池、SAB 零複製）、變體競賽、接進 `mm_ops`（無 WebGPU 時自動走純 CPU 池）。

## 5. node.js、LLVM 執行器與範例程式

- **執行器**：run terminal 的 Python（Pyodide）、node、llvm（lli／llc）三種；Python 的 pygame／OpenGL 改用 pip 的真套件（pygame-ce、PyOpenGL），只接後端（`fa_pygame`、`fa_opengl_platform`，WebGL2＋…）。
- **IndexedDB 當 swap**：Python `fa_swap`、node `swap`＋canvas、橋接 `swap.*` 已上線（熱區預設 16 MB，要明確 `import fa_swap`）。node 與 LLVM 的自動啟用與統一 configure（swap 預設 4GB、hot 預設 4GB 為 wasm 上限）**只有設計**（`DESIGN.run-terminal.md` §24）；已寫的實作在 WIP 分支，**未發布**。已知限制：node 的 IndexedDB 是非同步，做不到 `a[i]` 同步語法；numpy 不能自動換頁；LLVM 的 malloc 透明換頁要改 allocator。
- **範例目錄**：`renderer/src/examples/{python,node,llc}`；llc 下有 `gpgpu/`（`opencl_vecadd`、`nbody3d`、`nbody3d_cl`、`fluid3d`、`fluid3d_cl`）與 `gui/`（`music_player`、`midi_player` 含 SMF 解析與沙盒 `fopen`、`sdl2_*`、`gtk3_*`）。nbody3d／fluid3d 照 Python 版移植；`_cl` 版的加速度／SPH 走 OpenCL 核心。`.ll` 由 `_gen/` 的 Python 生成器產生，不要手改。
- **驗證腳本**：`scripts/eval/`（真 Electron；`FA_EVAL_GL=swiftshader|gpu`）：`llc_hud.eval.js`（22 項）、`llc_gpu_timing.eval.js`、`kir_*.eval.js`、`llvm_device.eval.js`、`gpgpu_bench.eval.js`（真 GPU 基準，需在有顯示卡的機器跑）。

## 6. 其他

- 照片檢視器放大時改送可見範圍的原始解析度裁切；`onnx_lite` 回傳形狀回到舊呼叫端格式；卸載在桌面版靜默失效已修。
- 網頁版部署尚未做（`videos-嗨投資` 倉庫不在這台機器上），所有發布仍是 `--no-web`（桌面版 patch）。

## 待辦摘要

1. 互動範例的畫面文字（HUD）與「有／沒有說明」檢查表。
2. OpenCL↔OpenGL interop 實作（先審 4 個待決事項）。
3. KIR 的 WebGPU 裝置層（靜態檢查階段）。
4. CUDA runtime API 前端。
5. node／LLVM／Python 自動 swap 與統一 configure（已有設計與 WIP 分支）。
6. 在真 GPU 重新量測 nbody／fluid（打包版是否值得出貨）。

## 計劃書（設計文件）索引：與本期相關

總表在 `DESIGN.TODO.md` 的「現況總覽」（每份設計文件一列，標「進 renderer？」；該表的快照停在 2026-11-06，本期新增項目以下面為準）。

| 計劃書 | 內容 | 狀態 |
|---|---|---|
| `DESIGN.webgpu-cuda.md` | cudaweb 後端選路、KIR（§13：階段 1–4、真 GPU 數字、interop 草案階段 6） | KIR 階段 1–4、常駐裝置層、打包層**已進 renderer**；WebGPU 裝置層、interop **未做** |
| `DESIGN.run-terminal.md` | run terminal：llc host import（§21）、HUD、真 GPU 基準指令（§21.x）、node／LLVM IndexedDB swap（§24） | §21 **已進 renderer**；§24 **設計＋WIP 分支，未發布** |
| `HANDOFF.llc-opencl.md` | llc OpenCL／GPU 工作的交接（範圍、模型規則、待辦） | 進行中 |
| `HANDOFF.coordinator.md` | 協調與發布流程（乾淨匯出、驗證清單、使用者原話、陷阱） | 使用中 |
| `DESIGN.pygame-opengl-standard.md` | pygame／OpenGL 以 pip 真套件只接後端 | 已進 renderer |
| `DESIGN.python-api-bridge.md` | Python 的 API 橋接（`fa_bridge`、`swap.*` 等） | 已進 renderer |
| `DESIGN.parallel-domain.md`、`DESIGN.sandbox-worker.md` | 多工作者／沙盒工作者 | 見各文件 |
| `DESIGN.blockly-curriculum.md`、`HANDOFF.blockly-teach.md` | Blockly 教學範本（演算法／資料結構／作業系統／Linux programming 等領域包） | **已完成**，領域包（DSP、algo2、os、ds、linuxtext 等）已進 renderer；本期不再動 |
| `DESIGN.matrix-fallback.md`、`HANDOFF.matrix-fallback.md` | 矩陣層後備（交給 stevenyc.huang 的 session） | 另一條線 |

尚無獨立計劃書的待辦（寫在 changes.md「待辦摘要」與上列文件內）：互動範例 HUD 文字、CUDA runtime API 前端。
