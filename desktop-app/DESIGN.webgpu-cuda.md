# PyTorch on WebGPU 與 Python CUDA on WebGPU：調查與設計

> 狀態：調查與設計文件（2026-11-15）。**本輪沒有實作任何核心**，只新增本文件與唯讀盤點。
> 標示規則：【查證】＝本輪有網路來源可引用；【推測】＝我的判斷或經驗，沒有來源；【未驗證】＝沒有在這台機器或瀏覽器實跑過。
> 寫作守則：全文中文，英文只保留專有名詞與程式識別字。

---

## 0. 結論摘要

- **可行性**：可行，但要分開看兩件事。
  - 「PyTorch 形式的張量與自動微分跑在瀏覽器 WebGPU」：可行。前人已有 tinygrad、ONNX Runtime Web、rullama 等路線，但它們各有缺口（見 §2）。
  - 「CUDA 與 PTX 的完整語意跑在 WebGPU」：**不可行到完整相容**。WebGPU 缺 f64、64 位元整數、64 位元原子操作、f32 原子操作（依目前查到的規格，見 §3），也沒有 Tensor Core、動態平行、函式指標。只能做「子集＋替代做法＋明確降級記錄」。
- **最大風險**：
  1. 數值一致性：替代做法（雙 f32 模擬 f64、CAS 迴圈模擬 f32 原子）的結果與 CUDA 不一定逐位元相同，要靠容差測試，且容差只能用實測決定（目前沒有數字）。
  2. 效能：替代做法與缺少 Tensor Core 會讓速度落後很多，沒有實測前不承諾速度。
  3. 本機顯示卡與 WebGPU 能否用：見 §8，本輪沒有實跑，**未驗證**。
  4. 法律：NVIDIA CUDA 授權條款禁止以逆向工程產出的結果去支援非 NVIDIA 平台（查證來源見 §2.6）。我們的 PTX 轉譯器只能依 NVIDIA 公開的 PTX 指令集文件實作，不得取用 NVIDIA 二進位、SDK 或 ZLUDA 類專案的程式碼。
- **建議第一階段**：向量加＋矩陣乘＋歸約三個核心，WGSL 版、CPU 參考版、能力偵測與降級記錄、一致性測試。見 §7。

---

## 1. 現有可重用資產（唯讀盤點）

路徑皆相對於 `desktop-app/`。

| 資產 | 位置 | 可重用內容 | 對本設計的用途 |
|---|---|---|---|
| 訓練後端設計與 WebGPU 研究項 | `DESIGN.TODO.offline-training-studio.md` §5.2、§5.6、§5.7（階段 4） | `webgpu` 後端定義、單層梯度對拍的驗收標準（最大相對誤差 ≤ 1e-3）、全模型 20 步 loss 對拍（每步差 ≤ 2%） | 直接沿用為 WebGPU 核心的驗收條件 |
| 運算後端登錄表 | `renderer/src/studio/backend_core.js` | `BACKEND_IDS` 已有 `webgpu`；`KIND_BACKENDS` 與 `MATURITY` 的排序；`probeResult`、`validateProbeResult`（不可用時必須有具體原因）；介面方法 `probe/benchmark/init/step/evalLoss/saveCheckpoint/loadCheckpoint/dispose` | **降級階梯接到這裡**，不另起一套（§4） |
| WebGPU 能力偵測的既有寫法 | `renderer/src/vlm/vlm_core.js` 第 80～85 行（`shader-f16` 檢查，偵測不到時當成支援）；`renderer/src/studio/backend_planned.js`（含 `navigator.gpu`，屬規劃中） | `shader-f16` 偵測與「不支援時寫明原因再退回」的模式 | 能力偵測照這個模式寫 |
| 純 JS 反向參考實作 | `renderer/src/studio/onnx_grad_core.js`、`renderer/src/studio/lora_ref_train.js`、`backend_cpu_js.js` | 已驗證的手寫反向（LoRA q/k/v/o）與梯度對拍測試 | **當作 CPU 參考版**與最後一層降級（§4） |
| 純 Python 訓練後端 | `renderer/src/studio/backend_cpu_py.js`、`llm_scratch.py`、`cpu_py_integration.test.js` | 完整訓練路徑的對照基準 | 對拍的黃金標準 |
| ONNX Runtime Web 的 WebGPU 用法 | `vlm_core.js`（已用 onnxruntime-web WebGPU，有降級） | 現成的 WebGPU 推論路徑 | 推論用，不取代訓練核心 |
| PTX 指令表 | `DESIGN.behavior-analyzer.md` 第 88 行（PTX 174、LLVM IR 116、WASM 218）；助記符表格式見第 95 行 | 174 個 PTX 助記符的名稱與說明，可直接當第一批要支援的清單來源 | NVPTX 路線的指令清單（§5） |
| LLVM 工具 | `renderer/floating-assistant.js` 約第 87498 行 `registerOptional('llvm_execute', …)`；`renderer/src/uml/llvm_core.js` | `llvm_execute` 與 `uml_to_wasm` 已登錄為可選工具 | 產生 PTX 的來源（§5） |
| Python 執行環境 | `renderer/src/gui/py_worker.js`（Pyodide Worker）、`py_worker.test.js` | Pyodide 已在瀏覽器內跑 Python | Python CUDA 語法子集的入口（§6.2） |
| 既有 GPU 相關測試 | `renderer/src/studio/backend_core.test.js`、`backend_wasm_web.test.js` | 後端介面的測試寫法 | 新測試照這個寫 |

**沒有的東西**（需新增）：`renderer/src/gpu/` 目錄目前不存在；沒有 WGSL 核心、沒有 PTX 轉譯器、沒有 `@cuda.jit` 解析器。

---

## 2. 前人工作調查

每項寫：做到哪、授權、能不能直接用或只能參考。日期為查證日（2026-11-15）。

### 2.1 歷史脈絡：BrookGPU 到 CUDA

- 【查證】BrookGPU 是 Stanford 的 GPU 串流語言，論文 "Brook for GPUs: Stream Computing on Graphics Hardware"（SIGGRAPH 2004，作者含 Ian Buck）把 C 擴充成資料平行語法。來源：[Stanford 論文頁](https://graphics.stanford.edu/papers/brookgpu/)。
- 【查證】Ian Buck 在 Stanford 研究期間開始做 GPU 運算，之後加入 NVIDIA，並以 Brook 的經驗推動 CUDA；Buck 自己說 Brook 的記憶體模型限制很大，CUDA 放寬了它。來源：[Tom's Hardware 訪談](https://www.tomshardware.com/reviews/ian-buck-nvidia,2393.html)、[NextPlatform 2015 回顧](https://www.nextplatform.com/2015/10/28/inside-the-programming-evolution-of-gpu-computing)。
- 【查證但有衝突】來源對「CUDA 何時開始」說法不一：有的說 Buck 在 Stanford 就開始做 CUDA，有的只說 2004 年轉到 NVIDIA 後才延續。本文件不採信單一時點，只用「Brook 是 CUDA 的前身」這個不爭議的結論。

### 2.2 WebGPU 與 WGSL 現況

| 項目 | 狀態 | 來源與日期 | 可否直接用 |
|---|---|---|---|
| WebGPU 基本計算 | Chrome 已正式支援 | 【查證】[Chrome 144 更新（2026-01-07）](https://developer.chrome.com/blog/new-in-webgpu-144) | 可直接用（Chrome／Edge） |
| subgroups（warp 類操作） | Chrome 已出貨；`subgroup_id` 擴充於 Chrome 144 提供；subgroup size control 於 2026 年 6 月的 Chrome 提案中獲 W3C GPU for the Web 工作小組批准（有 Safari、Firefox 參與） | 【查證】[Chrome 134 說明](https://developer.chrome.com/blog/new-in-webgpu-134)、[Chrome 144](https://developer.chrome.com/blog/new-in-webgpu-144)、[Intent to Ship: subgroup size control](https://groups.google.com/a/chromium.org/g/blink-dev/c/Lx06y9Rdzvs/m/7D44AVweAAAJ) | Chrome 可用；Firefox、Safari 未確認（【未驗證】） |
| shader-f16 | Chrome 120 起支援 WGSL 的 16 位元浮點 | 【查證】[Chrome 120 說明](https://developer.chrome.com/blog/new-in-webgpu-120) | 可用（要先偵測） |
| f32 原子操作 | 查到的 WebKit 測試檔把 `atomic<f32>` 列為錯誤；沒找到 WGSL 規格的浮點原子擴充 | 【查證】[WebKit WGSL 測試](https://sources.debian.org/src/webkit2gtk/2.48.5-1/Source/WebGPU/WGSL/tests/invalid/atomics.wgsl) | 視為**沒有**（【推測】，規格全文未核對） |
| 64 位元原子操作 | 不可行（依 Futhark 學位論文的 WebGPU 後端報告） | 【查證】[Futhark 學位論文](https://www.futhark-lang.org/student-projects/caleb-bsc-thesis.pdf) | 沒有；8／16 位元原子可模擬 |
| 規格預設限制 | `maxStorageBufferBindingSize` 預設 128 MiB；`maxComputeWorkgroupStorageSize` 預設 16 KiB（只有一個來源，【未驗證】） | 【查證】[w3cub 整理的 GPUSupportedLimits](https://docs.w3cub.com/dom/gpusupportedlimits)、[MDN GPUSupportedLimits](https://developer.mozilla.org/en-US/docs/Web/API/GPUSupportedLimits) | 要在建立 device 時主動請求較高值，否則只有預設值 |

### 2.3 Dawn、Tint、naga、wgpu

- 【查證】**Tint** 是 Google 的 WGSL 編譯器，Chromium 2021 年起以 Tint 取代 SPIRV-Cross 做著色器翻譯（SPIR-V／WGSL 與 HLSL、MSL 之間）。來源：[Chromium 郵件公告](https://lists.w3.org/Archives/Public/public-gpu/2021Jul/0000.html)、[Tint README](https://dawn.googlesource.com/tint/)。Chrome 141 起 SPIR-V 前端改為直接產生 IR 並加入 float16 支援（來源：[Chrome 141 說明](https://developer.chrome.com/blog/new-in-webgpu-141?hl=ja)）。
- 【查證】**naga**（wgpu 專案）：WGSL 作為輸入是完整驗證的前端；SPIR-V 輸出為主要支援目標，MSL 也是；WGSL 輸出只是次要支援。來源：[docs.rs naga 30.0.x](https://docs.rs/crate/naga/latest)。
- 授權：Tint、Dawn 為 BSD 類（【推測】，未核對條文）；naga 與 wgpu 為 MIT／Apache-2.0（【推測】，未核對）。**都可以當作參考或在 Rust 工具鏈中使用，但我們的專案目前沒有 Rust 工具鏈，直接引入成本高。**
- 建議：第一版**不引入** Tint 或 naga，我們的核心直接以 WGSL 字串產生；只有在要做 PTX 轉 SPIR-V 之類的需求出現時才重新評估。

### 2.4 tinygrad

- 【查證】tinygrad 官方文件有 runtime 頁面（[docs.tinygrad.org/runtime](https://docs.tinygrad.org/runtime/)），本輪搜尋的摘要被截斷，**沒有確認 runtime 表中是否有 WebGPU**。
- 【未驗證】我的記憶中 tinygrad 曾有 WebGPU 相關的後端與範例（例如透過 wgpu-py）；本輪沒有找到可引用的來源，**不能當作事實**，需要到 tinygrad 倉庫的 runtime 目錄或 issue 搜尋 "webgpu" 才能確定。
- 【查證】社群有 EfficientNet 的 WebGL 移植（[efficientnet-tinygrad-webgl](https://github.com/softwiredtech/efficientnet-tinygrad-webgl)），說明 WebGL 方向有人做過，但不是 WebGPU。
- 結論：tinygrad 只能當「小型可讀的 IR 與核心生成器」參考，**不能當現成 WebGPU 訓練路線**。

### 2.5 ONNX Runtime Web、WebLLM、Triton

- 【查證】ONNX Runtime 有官方 WebGPU 執行提供者教學（[onnxruntime.ai/docs/tutorials/web/ep-webgpu.html](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html)）：切換到 `onnxruntime-web/webgpu`，session 選項指定 `webgpu`；另有 `preferredOutputLocation` 讓輸出留在 GPU buffer。
- 【查證】[ONNX Runtime 文件](https://onnxruntime.ai/docs/execution-providers/WebGPU-ExecutionProvider.html) 說明 WebGPU 是推論路徑，訓練仍以 CPU 為主（與 `DESIGN.TODO.offline-training-studio.md` §5.6 查證結論一致）。
- WebLLM（MLC）與 Triton：【未查證】本輪沒有搜尋到可引用的來源，只能依 TODO §5.6 既有結論，**都只做推論**，不列為訓練參考。Triton 只有 NVIDIA 與部分 AMD 後端，對 WebGPU 沒有直接價值（【推測】）。

### 2.6 ZLUDA 與授權風險

- 【查證】ZLUDA 仍在開發，2026 年 1 月的預覽版加入 CUDA 13.1 相容；AMD 曾簽約後終止支援；來源：[Phoronix](https://phoronix.com/news/zluda-cuda-13.1-compatibility)、[Tom's Hardware](https://www.tomshardware.com/tech-industry/artificial-intelligence/zluda-breathes-new-life-with-financial-backing-from-unknown-party-pivots-to-ai-workloads-across-multiple-gpu-vendors)。
- 【查證】同一篇報導指出 NVIDIA 的 CUDA EULA 禁止逆向工程其輸出以支援非 NVIDIA 平台，依賴 ZLUDA 的開發者可能被迫重寫。
- 結論：**我們不把 ZLUDA 或 NVIDIA 二進位當依賴**。PTX 轉譯器只依 NVIDIA 公開的 PTX ISA 文件與 LLVM 公開文件實作；不解析 NVIDIA 內部格式。法務意見【未取得】，本文件不是法律意見，需要使用者或法務確認。

### 2.7 LLVM NVPTX 後端

- 【查證】LLVM 的 NVPTX 使用者指南（`NVPTXUsage.rst`，[LLVM 21.1 版](https://releases.llvm.org/21.1.0/docs/NVPTXUsage.html)）要點：
  - 目標三元組 `nvptx64-nvidia-cuda` 產生 64 位元 PTX。
  - 核心函式用 `ptx_kernel` 呼叫慣例；預設產生的是 device 函式。
  - 位址空間固定對映（generic、global、shared、constant、local），全域變數要明寫 `addrspace(N)`。
  - 屏障 `llvm.nvvm.barrier0` 對應 PTX 的 `bar.sync 0`；特殊暫存器用 `llvm.nvvm.read.ptx.sreg.*`。
- 【推測】NVPTX 產出的 PTX 會用到的指令集與我們的 174 個 PTX 助記符表大致重疊；實際使用量要用 `llvm_execute` 產生的 PTX 統計，**本輪沒有做**。

### 2.8 Numba CUDA（`@cuda.jit`）

- 【查證】Numba 內建的 CUDA 目標已**棄用**，開發移到 NVIDIA 的 `numba-cuda` 套件（來源：[numba-cuda 文件](https://nvidia.github.io/numba-cuda/user/cudapysupported.html)、[Numba 舊版文件](https://numba.readthedocs.io/en/stable/cuda/cudapysupported.html)）。
- 【查證】支援：自遞迴裝置函式（呼叫參數型別要與第一次相同）；印出（非同步，需 `synchronize`）；`assert` 只在 `debug=True` 生效；ndarray 的 shape、strides、ndim、索引與切片；部分 ufunc（輸出要當位置參數傳入）。
- 【查證】不支援：例外處理（try／except／finally）、`with`、推導式、`yield`、核心內配置記憶體（大部分 NumPy API 因此不能用）、陣列建立與陣列方法。
- 【查證】有模擬器 `NUMBA_ENABLE_CUDASIM=1`，在 CPU 上跑核心，可當除錯用。
- 授權：Numba 為 BSD 類（【推測】，未核對）。**可以當語法範圍的參考，不引入其程式碼**。

### 2.9 PyTorch 後端擴充機制

- 【查證】官方教學 "Facilitating New Backend Integration by PrivateUse1"（[pytorch.org](https://pytorch.org/tutorials/advanced/privateuseone.html)）：PyTorch 原本保留 PrivateUse1、2、3 三個分派鍵，社群改用 PrivateUse1 才能同時接多個後端。
- 【查證】參考實作：PyTorch 測試目錄的 `test/cpp_extensions/open_registration_extension`；教學還提到 `torch.rename_privateuse1_backend`（只在舊版中文翻譯看到，【未驗證】）。
- 【查證】自動載入外部後端的原型教學（`torch_<名稱>` 套件慣例）。
- 結論：PyTorch 的後端擴充需要 **C++ 與 ATen 內部 API**，而且要編譯與部署到 PyTorch 的版本。對網頁版不現實。**我們的 PyTorch on WebGPU 應該做成「PyTorch 風格的 JS API」，而不是 PyTorch 的後端外掛。**
- torch.compile、Inductor、ExecuTorch：【未查證】，本輪沒有搜尋，只列為後續研究項。

### 2.10 其他已知專案

- 【查證】Futhark 的 WebGPU 後端（學位論文）：一個子集的 Futhark 程式能編譯成 WGSL 在瀏覽器執行，是最接近「高階語言 → WGSL」的公開實例。授權與程式碼【未取得】。
- 【查證】rullama（Rust、wgpu）：README 宣稱瀏覽器內 LoRA 微調（僅 Gemma 4 系列），已在 TODO §5.6 列為「不可直接用」。
- 【查證】tensorgrad（npm）：只支援 f32、無 LoRA、無量化（TODO §5.6）。
- 【查證】Tapasya（示範頁）：進化策略而非梯度法，已在 TODO §5.6 列出。

### 2.11 本節小結（可否直接用）

| 專案 | 能直接用？ | 只能參考？ | 不採用 |
|---|---|---|---|
| ONNX Runtime Web WebGPU | 推論可直接用（已在 `vlm_core`） | 訓練路徑 | — |
| naga／Tint | 技術上可用，但需要 Rust 或 C++ 工具鏈 | 翻譯器設計 | 第一版不引入 |
| tinygrad | 否 | 小型 IR 與核心生成 | — |
| Futhark WebGPU | 否（授權未取得） | 子集編譯思路 | — |
| rullama | 否（只支援單一模型家族） | LoRA 反向算子清單 | — |
| ZLUDA | 否（法律風險） | 無 | 不採用 |
| Numba CUDA | 否（棄用，程式碼不引入） | 語法範圍 | — |

---

## 3. 能力落差表（核心）

標記：**完整**＝WGSL 有等價功能；**部分**＝有但有限制或要看擴充；**沒有**＝WGSL 無法直接表達，要替代。替代成本為【推測】，沒有實測。

| # | CUDA／PTX 原語 | WGSL 狀態 | 限制與依據 | 替代做法 | 替代成本（推測） |
|---|---|---|---|---|---|
| 1 | 執行緒階層 grid／block／thread | **完整**：dispatch 的 workgroup 數＋`workgroup_id`、`local_invocation_id`、`global_invocation_id` | workgroup 大小有上限（`maxComputeWorkgroupSizeX` 等）；預設值未在本輪查證中核對 | 把 CUDA 的 grid 對映到 dispatch 的 (x,y,z)；block 對映到 workgroup。超過上限就拆成多次 dispatch | 低 |
| 2 | 共享記憶體 shared | **部分**：`var<workgroup>` | 容量受 `maxComputeWorkgroupStorageSize` 限制，預設 16 KiB（【未驗證】單一來源）；CUDA 單一 block 可用量依架構不同 | 大陣列拆成小塊，每塊用 tile 迴圈處理；容量先用偵測結果決定 tile 大小（自適應，不寫死常數） | 中 |
| 3 | `__syncthreads()` | **完整**：`workgroupBarrier()` | WGSL 的 uniformity 分析要求屏障在一致控制流中；不一致的屏障在編譯期會被拒絕 | 轉譯時檢查 barrier 是否在分支內，若在分支內要改寫成所有執行緒都走同一路徑 | 中 |
| 4 | warp shuffle、vote、ballot | **部分**：subgroups 擴充（`subgroupAdd`、`subgroupBroadcast`、`subgroupShuffle`、`subgroupBallot` 等）；Chrome 已出貨，其他瀏覽器【未驗證】 | subgroup size 不固定（依驅動）；需要 `enable subgroups;` 與 device 請求 `subgroups` 功能 | 偵測不到時用 workgroup 記憶體＋`workgroupBarrier` 做歸約與廣播 | 中（歸約）；高（任意 shuffle） |
| 5 | 原子操作 i32、u32 | **完整** | `atomic<i32>`、`atomic<u32>` 支援 add、min、max、and、or、xor、exchange、compareExchange（【推測】，函式表未逐項核對） | 直接用 | 低 |
| 6 | 原子操作 f32（`atomicAdd` on float） | **沒有** | `atomic<f32>` 被拒（【查證】WebKit 測試），沒找到浮點原子擴充 | `atomic<u32>` 的 compare-exchange 迴圈，用 `bitcast<f32>` 讀寫。迴圈在競爭高時會慢 | 中到高（競爭高時明顯慢） |
| 7 | 原子操作 64 位元 | **沒有** | Futhark 論文：64 位元原子不可行（【查證】） | 分散累加（每個 workgroup 先歸約，再用 32 位元原子合併高低兩半並記錄進位）；或改為兩階段歸約 | 高 |
| 8 | f32 | **完整** | 無 | 直接用 | 低 |
| 9 | f16 | **部分**：需要 `enable f16;` 與 device 請求 `shader-f16`（Chrome 120 起） | 不支援時整個核心不能跑 | 偵測不到時整個核心降到 f32 版本，並在降級紀錄寫明原因 | 低（實作），但精度與記憶體行為要測 |
| 10 | f64 | **沒有** | 規格無 f64 | 雙 f32 表示（double-float，`hi + lo`，用 TwoSum、TwoProd 做加乘）。有效尾數約 48 位元（【推測】，理論值，未實測） | 高（每個運算 10～20 倍） |
| 11 | 64 位元整數 i64、u64 | **沒有** | 規格無 | 兩個 u32 加進位與借位；乘法用 16 位元分段（【推測】） | 中到高 |
| 12 | 指標與任意位址 | **部分**：只有 `ptr<storage/workgroup/function, T>`，無指標算術 | 不能從整數轉指標 | 把所有陣列放進綁定的 storage buffer，用整數索引；超過單一 buffer 上限就分塊並帶 buffer 索引 | 中 |
| 13 | 動態平行（kernel 內再啟動 kernel） | **沒有** | WebGPU 沒有裝置端發起 dispatch | 主機端排程；或以 indirect dispatch 讓前一個 kernel 寫入下一個的參數 | 中 |
| 14 | Tensor Core `mma`（矩陣乘指令） | **沒有** | WebGPU 沒有矩陣乘指令 | 平鋪的 workgroup 矩陣乘（共享記憶體平鋪＋`workgroupBarrier`） | 高（速度差距未實測） |
| 15 | 非同步複製 `cp.async` | **沒有** | — | 雙緩衝：用 queue 的 copy 與計算重疊 | 中 |
| 16 | 全域記憶體合併存取（coalescing） | **部分**：WGSL 沒有合併存取的規格保證，依驅動 | 行為不可預期 | 以連續索引與 vec4 讀寫為設計原則，實測後再調整 | 效能風險，無法靜態保證 |
| 17 | 遞迴 | **沒有**（【推測】WGSL 禁止遞迴，規格條文未逐條核對） | — | 改寫成迴圈或顯式堆疊 | 中 |
| 18 | 函式指標、vtable | **沒有** | — | 用 `switch` 分派＋常數表，或展開成多個核心 | 低到中 |
| 19 | printf | **沒有** | — | 寫入除錯用 storage buffer，主機讀回後印出 | 低 |

**判讀**：可以全數替代的只有 1、3、5、8（以及 2 容量受限）。6、7、10、11、14 是**效能與精度的主要風險**；13、17、18 是**語意上的落差**，要在翻譯器層直接拒絕或改寫。

---

### 3.1 後期原語（2026-11-15 增補；完整演進表見 §11）

| # | 後期原語 | WGSL 狀態 | 替代做法 | 層級 |
|---|---|---|---|---|
| 20 | cooperative groups（sub-block／block／grid 分組與同步） | **部分**：workgroup 與 subgroup 可表達；**grid 級同步沒有** | 拆成多次 dispatch，dispatch 之間即 grid 同步；多裝置 group 不做 | T2 |
| 21 | warp 矩陣指令 `wmma`／`mma.sync`（Tensor Core） | **沒有** | 平鋪 workgroup 矩陣乘（與第 14 項相同） | T2 |
| 22 | 低精度 bf16、tf32 資料型別 | f16 部分（shader-f16）；bf16、tf32 **沒有** | bf16 以 u16 位元移位轉成 f32 計算；tf32 以 f32 計算（精度較高，**不是位元相同**，§13） | T2 |
| 23 | 非同步複製到共享記憶體（`cp.async`） | **沒有** | 雙緩衝：queue 的複製與計算重疊 | T2 |
| 24 | thread block cluster（Hopper，最多 16 個 CTA 協作） | **沒有** | 無等價做法；只能拆核心或改用全域記憶體中轉 | 不做（T4 或拆核心） |
| 25 | TMA（Tensor Memory Accelerator）張量搬移 | **沒有** | 手寫的 buffer 索引搬移，效能差距未實測 | T2（效能風險高） |

判讀：後期原語裡，WGSL 能用「原語拆解」替代的多半是**同步與搬移**；**Tensor Core、cluster、TMA** 這三類是效能主要落差，沒有實測前不承諾。

---

## 4. 降級階梯設計（使用者指定的順序）

使用者指定順序：WGSL 完整替代且完全支援 → 用 WGSL；WGSL 不完整 → 用我們自己的做法；沒有 WebGPU → 降級；完全沒有解法 → 才走 WASM／CPU。

### 4.1 四層定義

| 層 | 條件 | 實作位置 | 例子 |
|---|---|---|---|
| **T1 原生 WGSL** | 該原語在 WGSL 完整支援，且 device 的功能都具備 | 核心的 WGSL 版本，不需要替代 | 單精度加法、`workgroupBarrier`、`atomic<u32>` |
| **T2 WGSL 內的替代做法（我們的做法）** | WGSL 不完整，但可以用 WGSL 本身模擬 | 同一個 WebGPU device，核心內含替代程式碼 | f64 用雙 f32、f32 原子用 CAS 迴圈、64 位元整數用兩個 u32、subgroup 歸約用 workgroup 記憶體 |
| **T3 無 WebGPU 的 GPU 路線** | 沒有 WebGPU 或 device 建立失敗，但有其他 GPU 路線 | 現有登錄表中的 `directml`、`vulkan`（目前**都未實作**，在 TODO §5.2 標為研究項） | 本輪不實作，只保留介面 |
| **T4 WASM／CPU** | 以上都沒有 | `backend_wasm_web.js`（處理器訓練，慢但正確）、`backend_cpu_js.js`、`backend_cpu_py.js` | 純 JS 參考實作 |

**與使用者順序的對應**：「WGSL 完整替代且完全支援」＝T1；「WGSL 不完整用我們的做法」＝T2；「沒有 WebGPU 再降級」＝T3；「完全沒有解法才走 WASM、CPU」＝T4。

**待決**：T3 的候選目前只有 `directml`、`vulkan`，兩者都還沒實作，**本設計不假設它們會存在**。若 T3 沒有實作，階梯直接從 T2 跳到 T4，降級紀錄要寫「跳過 T3，原因：未實作」。

### 4.2 原語到層級的對映（第一批）

| 原語 | T1 | T2 | T3 | T4 |
|---|---|---|---|---|
| 向量加 f32 | 是 | — | — | 是 |
| 矩陣乘 f32 | 是（平鋪） | — | — | 是 |
| 歸約 f32（workgroup 內） | 是（barrier＋記憶體） | subgroup 版本（有 subgroups 時） | — | 是 |
| 直方圖（i32 原子） | 是 | — | — | 是 |
| f32 原子加 | 否 | CAS 迴圈 | — | 是 |
| f64 運算 | 否 | 雙 f32 | — | 是（原生 f64） |
| 64 位元整數 | 否 | 兩個 u32 | — | 是 |
| Tensor Core mma | 否 | 平鋪矩陣乘 | — | 是（不支援時回報無） |

### 4.3 能力偵測

偵測流程（寫在 `renderer/src/gpu/cap_probe.js`，**本輪未建立**）：

1. `navigator.gpu` 存在與否；不存在則直接標記 T3 不可用，原因寫「此瀏覽器沒有 WebGPU」。
2. `await navigator.gpu.requestAdapter()`；回傳 `null` 時原因寫「沒有可用的顯示卡介面卡」。
3. 讀 `adapter.features` 是否含 `shader-f16`、`subgroups`、`subgroups-f16`（名稱以規格為準，【未驗證】）。
4. 讀 `adapter.limits`：`maxStorageBufferBindingSize`、`maxComputeWorkgroupStorageSize`、`maxComputeInvocationsPerWorkgroup`、`maxComputeWorkgroupSizeX`。
5. `requestDevice` 時明確要求要用的功能與上限；要求失敗時原因寫「要求的功能 X 不被此裝置接受」。
6. 建立 device 後監聽 `device.lost`，原因寫進紀錄（對應 TODO §5.2 的「裝置遺失要能續跑」）。

**降級紀錄格式**（給 `backend_core.js` 的 `probeResult` 用，沿用現有 `reason` 欄位）：

```
{ op: "matmul_f32", tier: "T2", missing: ["subgroups"], fallbackFrom: "T1", fallbackTo: "T2",
  reason: "此裝置沒有 subgroups 功能，歸約改用 workgroup 記憶體" }
```

要求：每一次降級都要有具體原因（缺哪個功能、退到哪一層），不寫籠統的「不支援」。這符合使用者「要真實診斷資訊」的要求。

### 4.4 接到現有後端登錄表

- `backend_core.js` 的 `BACKEND_IDS` 已有 `webgpu`；本設計**不新增後端 id**，而是在 `webgpu` 下面加「層級」欄位（T1／T2），降級紀錄掛在 `probe` 結果的 `fingerprint` 或新增的 `tiers` 欄位。
- `MATURITY` 排序不變；`KIND_BACKENDS.lora` 不變。
- 基準測試快取的指紋（TODO §4.1）要加入「實際選到的層級」，避免同一張卡在 T1、T2 之間切換時快取誤用。

### 4.5 一致性測試（證明各層結果一致）

- 每個核心在 T1、T2、T4 各跑一次，同一組輸入、同一組隨機種子。
- **容差規則（暫定，【未驗證】）**：
  - f32 核心：相對誤差 ≤ 1e-5（逐元素，最大值），歸約另外放寬到 ≤ 1e-4（因為加法順序不同）。
  - f64 替代（T2）：以 T4 的 f64 為基準，相對誤差 ≤ 1e-9；若實測達不到，改為記錄實際值，**不寫死**。
  - 整數與原子直方圖：完全相等（位元一致）。
- 容差的數值只能靠實測決定，**本輪沒有任何實測數字**。
- 測試檔放 `renderer/src/gpu/*.test.js`，node 可跑的部分只測 CPU 參考與降級邏輯；WebGPU 的部分放在 Worker 或真桌面版評估中跑（沿用 `DESIGN.TODO.offline-training-studio.md` §5.8 的做法）。

---

## 5. NVPTX 路線：從 LLVM 到 WGSL

### 5.1 管線

```
C／C++（clang）或 Rust ──► LLVM IR ──► NVPTX 後端 ──► PTX 文字
                                                   │
                                                   ▼
                              PTX 解析器（只支援子集）──► 中介表示（SSA 風格）
                                                   │
                                  ┌────────────────┴────────────────┐
                                  ▼                                 ▼
                       WGSL 產生器（T1／T2）              CPU 參考解譯器（T4）
```

- LLVM 端：`llvm_execute` 已有；需要確認它能否產生 PTX（`llvm` 工具鏈是否含 NVPTX target）。**本輪未驗證**。
- 解析器：PTX 是文字格式，可以用手寫的 tokenizer；指令名稱比對沿用 `DESIGN.behavior-analyzer.md` 的「逐段退回」規則（`ld.global.f32` → `ld.global` → `ld`）。

### 5.2 自寫 PTX→WGSL 的範圍

- **第一版只支援子集**：純量與向量算術、整數與 f32 的比較與分支、global／shared 記憶體讀寫、`bar.sync 0`、`atom.*.add`、`ret`。
- **明確拒絕**（回報具體原因）：`call` 到外部函式、間接分支、`.f64` 與 `.u64` 運算（要先經 §3 的替代）、`.f16` 指令（有 shader-f16 才能做）、`mma`、`cp.async`、`vote`、`shfl`（subgroups 不可用時）、`brx`、`cvta` 以外的位址轉換。

### 5.3 第一批要支援的 PTX 指令

來源：`DESIGN.behavior-analyzer.md` 的 PTX 表（174 條）。以下是依 PTX 常見用法的挑選，**【推測】**，要與 174 條表逐條核對後才定案。

| 類別 | 指令 | 第一版 |
|---|---|---|
| 搬移 | `mov`、`cvt`（只到 i32／u32／f32） | 是 |
| 算術 | `add`、`sub`、`mul.lo`、`mad.lo`、`fma`、`div.rn`（f32）、`rem`、`min`、`max`、`abs`、`neg` | 是 |
| 位元 | `and`、`or`、`xor`、`shl`、`shr`、`not` | 是 |
| 比較與選擇 | `setp`、`selp` | 是 |
| 分支 | `bra`、`ret`、`exit` | 是（只支援結構化分支） |
| 記憶體 | `ld.param`、`ld.global`、`st.global`、`ld.shared`、`st.shared` | 是 |
| 同步 | `bar.sync 0` | 是（要檢查 uniformity） |
| 原子 | `atom.global.add`、`atom.shared.add`（i32、u32） | 是 |
| 其他 | `f64`、`u64`、`mma`、`shfl`、`vote`、`call` | 否（拒絕並回報） |

### 5.4 NVPTX 路線的風險

- 【推測】PTX 的隱含行為（例如 `setp` 的 NaN 語意、`div.rn` 的捨入模式）與 WGSL 不同，要逐條寫測試。
- 【推測】LLVM 產生的 PTX 常用 `.param` 空間傳參，翻譯時要改成 uniform buffer 或 storage buffer 的綁定。
- 授權風險見 §2.6：只依公開文件實作，不解析 NVIDIA 內部格式。

---

## 6. 兩個產品的分層

### 6.1 PyTorch on WebGPU

**定位**：PyTorch 風格的 JS API（張量、自動微分、模組），不是 PyTorch 的 C++ 後端外掛（見 §2.9）。

**第一批運算子（訓練工作室需要的）**：

| 運算子 | T1（WGSL） | 現有參考實作 | 備註 |
|---|---|---|---|
| matmul（f32，平鋪） | 要寫 | `onnx_grad_core.js` 的前向與反向 | 第一批核心 |
| softmax（含 causal mask） | 要寫 | `onnx_grad_core.js` | 數值穩定（減最大值） |
| layernorm、RMSNorm | 要寫 | `qwen3_layered_engine.js` 的 RMSNorm | 反向要對拍 |
| attention（前向＋反向） | 要寫 | `qwen3_graph.js`、`lora_graph_model.js` | 大序列要分塊 |
| AdamW | 要寫 | `llm_scratch.py`、`lora_ref_train.js` 的優化器 | 狀態放 storage buffer |
| 交叉熵（含 log-softmax） | 要寫 | `onnx_grad_core.js` | 與 `cpu-py` 對拍 |

**與現有資產的關係**：
- 現有純 JS 後端（`backend_cpu_js.js`、`onnx_grad_core.js`）**同時是參考實作與 T4 降級層**，不另寫。
- 現有 `backend_cpu_py.js` 是最終的黃金標準（TODO §5.4 的排序）。
- 自動微分：第一版只做手寫反向（與 TODO §5.6 的 (d-1) 相同路線），不做通用 tape，避免擴大範圍。

**不做（第一版）**：通用張量 API 的完整子集、動態形狀、多 GPU、混合精度訓練。

### 6.2 Python CUDA on WebGPU

**定位**：在 Pyodide 裡寫 `@cuda.jit` 風格的核心，由 JS 端翻譯成 WGSL。

**語法子集（參考 §2.8 的 Numba 限制，只保留可映射的部分）**：

- 支援：`cuda.grid(1)`、`cuda.blockIdx`、`cuda.threadIdx`、`cuda.blockDim`、`cuda.shared.array(shape, dtype)`、`cuda.syncthreads()`、`cuda.atomic.add(arr, idx, val)`（i32、u32）、for 迴圈（range）、if、基本算術、ndarray 索引。
- 不支援（直接拒絕並給原因）：try／except、with、推導式、yield、核心內配置陣列、遞迴（同 §3 第 17 項）、印出（改用除錯 buffer）。

**流程**：Python 原始碼 → 解析成 AST（在 Pyodide 或 JS 端，待決）→ 型別推斷（只允許 f32、i32、u32，其餘拒絕）→ 產生 WGSL → 主機端建立 pipeline 與 dispatch。

**第一版範例**：

1. 向量加（`c[i] = a[i] + b[i]`）。
2. 矩陣乘（平鋪，共享記憶體）。
3. 歸約（workgroup 內樹狀，含 barrier）。
4. 直方圖（i32 原子加）。

**待決**：AST 解析放在 Pyodide（用 Python 的 `ast` 模組）還是 JS 端（需要另外的 Python 解析器）。建議**放 Pyodide**，因為 Python 的 `ast` 是標準庫，不需要額外依賴，但 Pyodide 的啟動成本要量測（【未驗證】）。

---

### 6.3 ATen 對映與函式庫層（細節見 §12）

本節只列對映**方向**：ATen 運算子先對到 cuBLAS／cuDNN 子集（§12.1、§12.2），對不到的才自寫核心。第一批對映表與不做清單在 §12.3。

---

## 7. 分階段路線圖

每階段都有可驗證的完成標準；工時為【推測】。

**2026-11-15 路線調整（依使用者追加）**：
- **第一階段**：向量加、矩陣乘（同時是 `cublas.sgemm` 的最小版，先接上介面）、歸約；加上能力偵測、降級紀錄、一致性測試，以及接進 Python 模擬器的最小橋接（§15）。
- **第二階段**：cuBLAS 常用子集（§12.1）。
- **第三階段**：cuDNN 常用子集與 ATen 對映子集（§12.2、§12.3）。
- 下表的 P2 至 P5 順序保留作為**後續**，其中「替代做法 T2」與「PTX 子集」排在第三階段之後。

| 階段 | 內容 | 完成標準（可驗證） | 工時（推測） |
|---|---|---|---|
| **P1（第一輪可完成）** | 向量加、矩陣乘、歸約三個核心：WGSL 版（T1）、CPU 參考版（T4）、能力偵測與降級紀錄、一致性測試 | (1) 三個核心在 T1 與 T4 的輸出在容差內一致；(2) 降級紀錄能列出缺的功能與退到的層；(3) 不支援 WebGPU 的環境下測試會跳過 T1 並寫明原因，而不是失敗 | 一到兩輪 |
| P2 | 替代做法 T2：f32 原子（CAS）、subgroup 歸約（無 subgroups 時）、f64 雙 f32 | 每個替代在 T2 與 T4 的誤差表有實測數字；容差由數字決定 | 兩到三輪 |
| P3 | PTX 子集解析與 WGSL 產生（§5） | 用 `llvm_execute` 產生的一個小 PTX（向量加）翻譯後，結果與 T4 一致 | 三到四輪 |
| P4 | PyTorch 風格 API 的第一批運算子（§6.1）與 `@cuda.jit` 子集（§6.2） | 訓練工作室的 LoRA 單層梯度對拍（TODO §5.7 階段 4(a)） | 四到六輪 |
| P5 | 全模型 20 步 loss 對拍、效能實測、裝置遺失續跑 | TODO §5.7 階段 4(c)：每步 loss 差 ≤ 2% | 視結果 |

**P1 的具體要做的事**（使用者要求第一階段一輪能做出來）：

1. `renderer/src/gpu/cap_probe.js`：能力偵測（純函式，吃注入的 `navigator`，方便 node 測試）。
2. `renderer/src/gpu/ref_cpu.js`：三個核心的 CPU 參考版。
3. `renderer/src/gpu/kernels_wgsl.js`：三個核心的 WGSL 字串。
4. `renderer/src/gpu/degrade_log.js`：降級紀錄的組裝與格式。
5. `renderer/src/gpu/consistency.test.js`：CPU 版自身的測試（node 跑）；WebGPU 版的對拍放在 Worker 或真桌面版（待 §8 的實機結果決定）。

---

## 8. 驗證現況（本機）

### 8.1 本輪做了什麼

- **靜態檢查**（沒有啟動任何程式）：
  - Electron 主行程 `main.js`：只設了 `enable-features=SharedArrayBuffer`，**沒有**關掉 GPU 或 WebGPU 的命令列參數（`main.js` 第 29 行）。
  - 測試腳本（`scripts/eval/*.run.js`）大量使用 `--disable-gpu`，這是測試用的啟動參數；**真正跑 WebGPU 的評估不能帶這個參數**，要寫進後續評估的設計。
  - `renderer/src/vlm/vlm_core.js` 已有 `shader-f16` 偵測，可以沿用。
- **顯示卡名稱**（PowerShell `Win32_VideoController`，唯讀）：回報 **NVIDIA GeForce GT 720**（只看到這一行，沒有看到其他顯示卡）。
  - **這與 `DESIGN.TODO.offline-training-studio.md` 第 119 行「本機沒有 NVIDIA 顯示卡」矛盾**，本輪無法判定哪一個正確（可能是舊資訊或多張卡）。需要使用者確認。
  - 【推測】GT 720 是舊世代的入門顯示卡，Chrome 的 WebGPU 在 Windows 上需要 D3D12，**它未必能提供 WebGPU 介面卡**。這只是推測，要實測。
- **Node 版本**：v16.15.0。`node --check` 本輪沒有對任何檔案跑（沒有改程式）。

### 8.2 沒有做的（並說明原因）

- **沒有啟動真桌面版 Electron 去讀 `navigator.gpu`、adapter、features 清單**。原因：本輪是唯讀調查，啟動桌面版會搶焦點，而且 `DESIGN.TODO` 與使用者的規則是「真桌面版評估每項最多兩次、事先 `node --check`、會搶焦點先說明」；本輪沒有必要為了這一題冒險。**這是本節最主要的缺口**，建議下一輪在一個獨立的 `--user-data-dir` 與換埠的評估檔中做（沿用 `reference_real_electron_eval_verification` 的做法），而且不加 `--disable-gpu`。
- **沒有下載任何檔案**（符合「不下載大檔」規則）。
- **沒有掃描整台機器**。

### 8.3 結論

- WebGPU 在這台機器上**未驗證**：不知道有沒有 adapter，不知道 features 清單。
- 決定下一步時需要的資訊：（1）實機 adapter 與 features；（2）顯示卡型號是否為 GT 720（與 TODO 的說法衝突）。

---

## 9. 未驗證與待核對清單（集中列出）

1. WGSL 規格中 subgroups、f16、原子的完整函式表與條件（只查到 Chrome 文件與 WebKit 測試）。
2. Firefox、Safari 的 subgroups 與 shader-f16 實際支援（【未驗證】）。
3. `maxComputeWorkgroupStorageSize` 預設 16 KiB 只有一個來源（【未驗證】）。
4. tinygrad 是否有 WebGPU runtime（【未驗證】）。
5. WebLLM、Triton、torch.compile、Inductor、ExecuTorch 的細節（本輪沒有搜尋）。
6. Tint、Dawn、naga、Numba、rullama、Futhark 的授權條文（【未核對】）。
7. LLVM `llvm_execute` 是否真的能產生 PTX（【未驗證】）。
8. PTX 第一批指令清單與 174 條表的逐條核對（§5.3，【推測】）。
9. 本機顯示卡型號（GT 720 與 TODO 第 119 行的衝突）與 WebGPU adapter（§8）。
10. 容差數字（§4.5）全部未實測。
11. 法律意見：CUDA 授權與 PTX 轉譯器的界線（§2.6），本文件不是法律意見。

---

## 10. 來源清單

- Stanford BrookGPU 論文：https://graphics.stanford.edu/papers/brookgpu/
- Tom's Hardware 訪談 Ian Buck：https://www.tomshardware.com/reviews/ian-buck-nvidia,2393.html
- NextPlatform 2015 回顧：https://www.nextplatform.com/2015/10/28/inside-the-programming-evolution-of-gpu-computing
- Chrome 144 WebGPU（2026-01-07）：https://developer.chrome.com/blog/new-in-webgpu-144
- Chrome 134 WebGPU（2025-02-26）：https://developer.chrome.com/blog/new-in-webgpu-134
- Chrome 120 WebGPU（f16）：https://developer.chrome.com/blog/new-in-webgpu-120
- Chrome 141 WebGPU（2025-09-24）：https://developer.chrome.com/blog/new-in-webgpu-141?hl=ja
- Intent to Ship subgroup size control：https://groups.google.com/a/chromium.org/g/blink-dev/c/Lx06y9Rdzvs/m/7D44AVweAAAJ
- WebKit WGSL 原子測試：https://sources.debian.org/src/webkit2gtk/2.48.5-1/Source/WebGPU/WGSL/tests/invalid/atomics.wgsl
- Futhark 學位論文（WebGPU 後端）：https://www.futhark-lang.org/student-projects/caleb-bsc-thesis.pdf
- w3cub GPUSupportedLimits：https://docs.w3cub.com/dom/gpusupportedlimits
- MDN GPUSupportedLimits：https://developer.mozilla.org/en-US/docs/Web/API/GPUSupportedLimits
- Tint README：https://dawn.googlesource.com/tint/
- Chromium 切換 Tint 公告（2021）：https://lists.w3.org/Archives/Public/public-gpu/2021Jul/0000.html
- naga（docs.rs 30.0.x）：https://docs.rs/crate/naga/latest
- ONNX Runtime WebGPU 教學：https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html
- ONNX Runtime WebGPU 執行提供者：https://onnxruntime.ai/docs/execution-providers/WebGPU-ExecutionProvider.html
- tinygrad runtime 文件：https://docs.tinygrad.org/runtime/
- efficientnet-tinygrad-webgl：https://github.com/softwiredtech/efficientnet-tinygrad-webgl
- ZLUDA（Phoronix 2026）：https://phoronix.com/news/zluda-cuda-13.1-compatibility
- ZLUDA 與 EULA（Tom's Hardware）：https://www.tomshardware.com/tech-industry/artificial-intelligence/zluda-breathes-new-life-with-financial-backing-from-unknown-party-pivots-to-ai-workloads-across-multiple-gpu-vendors
- LLVM NVPTX 使用者指南（21.1）：https://releases.llvm.org/21.1.0/docs/NVPTXUsage.html
- numba-cuda 支援的 Python 功能：https://nvidia.github.io/numba-cuda/user/cudapysupported.html
- Numba 舊版支援功能：https://numba.readthedocs.io/en/stable/cuda/cudapysupported.html
- PyTorch PrivateUse1 教學：https://pytorch.org/tutorials/advanced/privateuseone.html
- NVIDIA GTC 投稿頁（現行）：https://www.nvidia.com/en-us/gtc/present/call-for-submissions/
- NVIDIA 部落格 CUDA 9 WMMA 與 Volta（GTC 2017 公告）：https://developer.nvidia.com/blog/?p=7874
- NVIDIA 部落格 Cooperative Groups：https://developer.nvidia.com/blog/cooperative-groups
- NVIDIA 部落格 WMMA 延伸到 Ampere（CUDA 11.0）：https://developer.nvidia.com/blog/?p=24627
- Tensor Core 程式化研究（arXiv 1803.04014）：https://arxiv.org/pdf/1803.04014
- Triton Gluon 多 CTA 教學（thread block cluster 描述）：https://triton-lang.org/main/getting-started/tutorials/gluon/multicta.html
- CUDA 功能封存文件：https://docs.nvidia.com/cuda/cuda-features-archive/index.html
- cuBLAS 行主序與列主序用法：https://leimao.github.io/blog/cuBLAS-Transpose-Column-Major-Relationship
- Netlib cuBLAS 批次 BLAS 講義：https://www.netlib.org/utk/people/JackDongarra/WEB-PAGES/Batched-BLAS-2016/Day2/cublas_utk.pdf
- PyTorch 數值精度說明：https://pytorch.org/docs/stable/notes/numerical_accuracy
- PyTorch torch.nn.attention（SDPA 後端列舉）：https://docs.pytorch.org/docs/2.7/_modules/torch/nn/attention.html
- MONAI 精度與加速（TF32 預設）：https://monai.readthedocs.io/en/stable/precision_accelerating.html

---

## 11. 後期原語演進表（2026-11-15 增補）

### 11.1 查證說明

- **「CUDA 原語來自 GTC 論文徵集」這個說法：未查證。** 本輪只查到現行 GTC 的投稿頁（[NVIDIA GTC 投稿頁](https://www.nvidia.com/en-us/gtc/present/call-for-submissions/)，2027 年 3 月 GTC 的海報徵集），沒有查到任何文件說明某個 CUDA 原語是經由 GTC 論文徵集併入。WMMA 首次公開是在 GTC 2017 的 CUDA 9 公告（[NVIDIA 部落格](https://developer.nvidia.com/blog/?p=7874)），那是**發表場合**，不等於「論文徵集併入」。因此本文件不採用這個說法作為事實。
- 下表每列寫明：引入版本與來源、查證狀態。標【推測】的年份沒有在本輪查證中核對。

### 11.2 演進表

| 原語 | CUDA 引入 | 來源與狀態 | 硬體 | WGSL 對應 | 層級 | 替代做法與成本（推測） |
|---|---|---|---|---|---|---|
| 動態平行（kernel 內啟動 kernel） | CUDA 5.0 | 【推測】未查證 | Kepler | 沒有 | T2（主機排程） | 主機端迴圈發 dispatch；indirect dispatch 部分替代 |
| Cooperative groups | CUDA 9（2017） | 【查證】[NVIDIA 部落格](https://developer.nvidia.com/blog/cooperative-groups)：可定義 sub-warp 到 multi-GPU 的群組並做集合同步 | Volta 起 | 部分：workgroup、subgroup 可表達；grid 同步沒有 | T2 | grid 同步 = 拆 dispatch；多裝置群組不做 |
| Warp 級 shuffle 與投票（sync 版本） | CUDA 9 起以 `_sync` 版本為主 | 【推測】未查證（以 CUDA 9 的 cooperative groups 同一批公告為脈絡） | Volta 起 | 部分：subgroups（Chrome 已出貨） | T2（無 subgroups 時） | workgroup 記憶體＋barrier 做歸約與廣播 |
| WMMA（warp 矩陣乘） | CUDA 9（2017，預覽） | 【查證】[NVIDIA 部落格](https://developer.nvidia.com/blog/?p=7874)；2018 年 arXiv 分析說明它是預覽、無向後相容保證（[arXiv 1803.04014](https://arxiv.org/pdf/1803.04014)） | Volta | 沒有 | T2 | 平鋪 workgroup 矩陣乘，速度差距未實測 |
| WMMA 延伸到 Ampere | CUDA 11.0 | 【查證】[NVIDIA 部落格](https://developer.nvidia.com/blog/?p=24627) | Ampere | 沒有 | T2 | 同上 |
| `mma.sync`（PTX 低階矩陣指令） | CUDA 10.1 | 【查證，次要來源】[CUDA 範例說明](https://turing.une.edu.au/~cosc330/lectures/cuda_samples_old/samples/0_Simple/cudaTensorCoreGemm/readme.txt)、[CUTLASS 投影片](https://developer.download.nvidia.com/video/gputechconf/gtc/2019/presentation/s9593-cutensor-high-performance-tensor-operations-in-cuda-v2.pdf) | Volta 起 | 沒有 | T2 | 同上；PTX 轉譯器（§5）遇到直接拒絕並回報 |
| 低精度資料型別（bf16、tf32）與 Tensor Core 的 tf32 模式 | CUDA 11（Ampere） | 【查證，次要來源】NVIDIA 2020 年投影片列出 CUDA 11 的 low precision 與 WMMA 項目（[OLCF 2020 投影片](https://www.olcf.ornl.gov/wp-content/uploads/2020/09/OLCF_Users_Call_Oct2020.pdf)） | Ampere | f16 部分（shader-f16）；bf16、tf32 沒有 | T2 | bf16 以位元移位轉 f32；tf32 以 f32 計算（精度較高，不是位元相同，§13） |
| `cp.async`（非同步複製到共享記憶體） | Ampere 世代 | 【推測】未查證 | Ampere | 沒有 | T2 | 雙緩衝 |
| 非同步 barrier（mbarrier） | Ampere 世代 | 【推測】未查證 | Ampere | 只有 `workgroupBarrier` | T2（部分） | 粗粒度 barrier，效能風險 |
| Thread block cluster（CGA，最多 16 個 CTA） | Hopper | 【查證】[Triton Gluon 教學](https://triton-lang.org/main/getting-started/tutorials/gluon/multicta.html)：CGA 可協作讀取 HBM、並以 mbarrier 同步子集 | Hopper | 沒有（workgroup 之間無共享記憶體） | 不做 | 無等價做法；拆核心改用全域記憶體中轉 |
| TMA（Tensor Memory Accelerator） | Hopper（【推測】，未查證） | 【推測】本輪搜尋只看到它在 cluster 廣播的脈絡 | Hopper | 沒有 | T2（效能風險高） | 手寫索引搬移 |
| Warpgroup 矩陣指令（wgmma） | Hopper（【推測】，未查證） | 【推測】未查證 | Hopper | 沒有 | T2 | 同 WMMA 平鋪 |
| 統一記憶體（unified memory） | CUDA 6（【推測】，未查證） | 未查證 | Kepler 起 | 沒有 | T2 | 明確的 buffer 上傳與回讀 |
| 多裝置協作啟動 | 早期版本 | 【查證，次要來源】[CUDA 功能封存](https://docs.nvidia.com/cuda/cuda-features-archive/index.html) 的摘要提到 CUDA 13.x 移除相關參考 | — | 沒有 | 不做 | 不做 |

### 11.3 判讀

- 後期原語能替代的主要是**同步、搬移、低精度資料型別**（T2）。
- **矩陣指令、cluster、TMA、wgmma** 是 WGSL 完全沒有的硬體能力；只能用平鋪軟體實作，效能差距要實測。
- 我們的 PTX 子集（§5）**不支援**這些指令，遇到時直接回報「原語未支援」，不靜默降級。

---

## 12. 函式庫層相容設計（第二、三階段）

### 12.1 cuBLAS 常用子集（第二階段）

- 介面：照 cuBLAS 的命名與參數順序。`cublasSgemm` 的參數為 handle、transa、transb、m、n、k、alpha、A、lda、B、ldb、beta、C、ldc（【查證，次要來源】[Netlib 講義](https://www.netlib.org/utk/people/JackDongarra/WEB-PAGES/Batched-BLAS-2016/Day2/cublas_utk.pdf)、[Leimao 說明](https://leimao.github.io/blog/cuBLAS-Transpose-Column-Major-Relationship)）。
- **lda 規則**（參考 BLAS 的 SGEMM 文件，【查證，次要來源】）：transa 為 N 時 lda ≥ max(1, m)，否則 lda ≥ max(1, k)；ldb 同理（n 與 k 對換）。
- **欄主序**：cuBLAS 假設欄主序；行主序的呼叫者要交換運算元與轉置旗標（【查證，次要來源】同 Leimao 說明）。
- **Python 端形式**：`cudaweb.cublas.sgemm(transa, transb, alpha, A, B, beta, C)`，去掉 handle，lda、ldb、ldc 由陣列形狀推得。**與 cuBLAS 的差異必須寫在文件裡**（去掉 handle、陣列取代裸指標）。

| 子程式 | 語意 | WGSL 實作 | 層級 | 複雜度（推測） |
|---|---|---|---|---|
| `sgemm` | C ← αop(A)op(B)+βC | 平鋪 kernel（T1），轉置用索引映射 | T1 | O(mnk)，平鋪後接近記憶體限制 |
| `sgemv` | y ← αop(A)x+βy | 每列一個 workgroup 歸約 | T1 | O(mn) |
| `saxpy` | y ← αx+y | 逐元素 | T1 | O(n) |
| `sdot` | x·y | 歸約（與第 3 節第 2 項相同） | T1 | O(n) |
| `sscal` | x ← αx | 逐元素 | T1 | O(n) |
| `snrm2` | ‖x‖₂ | 平方和歸約後 sqrt；注意溢位與下溢，用縮放避免（與 reference BLAS 同思路，【推測】） | T1 | O(n) |
| `sgemmStridedBatched` | 批次 gemm | 第三個 workgroup 維度為批次索引 | T1 | O(b·mnk) |

**不做（第二階段）**：Tensor Core 路徑（`cublasGemmEx` 的 tensor op 模式）、複數、雙精度（`dgemm`，需 §3 第 10 項的雙 f32）、混合精度輸入輸出的 `gemmEx`。

### 12.2 cuDNN 常用子集（第三階段）

| 運算 | 常見 cuDNN 入口（【未查證】具體函式名稱與參數） | WGSL 做法 | 層級 | 複雜度（推測） |
|---|---|---|---|---|
| 卷積前向 | 前向卷積 | im2col＋sgemm（T1 組合）；或直接卷積核心 | T1 | im2col 增加記憶體 |
| 卷積反向（資料、濾波器） | 反向卷積 | 兩個 im2col＋sgemm 的反向形式 | T1 | 同上 |
| 池化（max、avg） | 池化前向與反向 | 逐元素窗口核心 | T1 | O(窗口·輸出) |
| softmax | 前向與反向 | 歸約（最大值、和）＋逐元素 | T1 | O(n) |
| 批次正規化 | 前向與反向 | 歸約（均值、變異數）＋逐元素 | T1 | O(n) |
| 激活（relu、tanh、sigmoid、gelu） | 逐元素 | 逐元素 | T1 | O(n)；gelu 是否在 cuDNN 入口內【未查證】 |
| 注意力 | cuDNN 的 SDPA 後端（【查證】PyTorch 列舉有 `CUDNN_ATTENTION`，見 §12.3） | 第一版用數學版（mm＋softmax＋mm），不做融合 | T1＋T2 | O(s²d)，記憶體為 O(s²) |

**不做（第三階段）**：融合核心、混合精度訓練、量化卷積、RNN 系列。

### 12.3 ATen 對映表（第三階段，子集）

來源：PyTorch 的 SDPA 後端列舉為 MATH、FLASH_ATTENTION、EFFICIENT_ATTENTION、CUDNN_ATTENTION，預設由框架依優先順序挑選（【查證】[PyTorch 文件](https://docs.pytorch.org/docs/2.7/_modules/torch/nn/attention.html)）。我們**只實作 MATH 版**，其餘後端不做。

| ATen 運算子 | 對到 | 狀態 | 備註 |
|---|---|---|---|
| `aten::mm` | cuBLAS `sgemm` | 做（第二階段） | 2D 矩陣乘 |
| `aten::bmm` | cuBLAS 批次 gemm | 做（第二階段） | 3D |
| `aten::addmm` | gemm＋bias 加法（β=1） | 做（第二階段） | |
| `aten::matmul` | 依維度分派到 mm 或 bmm | 做（第二階段） | |
| `aten::softmax` | 自寫歸約核心（或 cuDNN softmax） | 做（第三階段） | 數值穩定（減最大值） |
| `aten::layer_norm`、RMSNorm | 自寫歸約核心 | 做（第三階段） | 反向要對拍 |
| `aten::conv2d` | cuDNN 子集（im2col＋sgemm） | 做（第三階段） | |
| `aten::scaled_dot_product_attention` | MATH 版（mm＋softmax＋mm） | 做 MATH 版；**不做** FLASH、EFFICIENT、CUDNN 版 | 與 PyTorch 的 MATH 後端對齊 |
| 逐元素（add、mul、relu、gelu…） | 自寫核心 | 做（第三階段） | |
| `aten::sum`、`aten::mean` | 自寫歸約核心 | 做（第一階段的歸約核心延伸） | |
| `aten::cross_entropy`、`nll_loss` | 自寫核心（含 log-softmax） | 做（第三階段） | |
| `aten::embedding` | 自寫 gather 核心 | 做（第三階段） | |
| 優化器（AdamW，融合或 foreach） | 自寫核心 | 做（第三階段，非融合） | |
| `aten::index_select` | 自寫 gather | 做（第三階段，後段） | |
| `aten::scatter_add`、`index_add` | 需要 f32 原子 | **不做**（等 §3 第 6 項的 CAS 替代，P4） | |
| `aten::batch_norm` | cuDNN 子集 | 後段，視需要 | |
| FFT、稀疏、量化、nested tensor、c10d 分散式 | — | **不做** | 超出範圍 |
| 自動混合精度（autocast） | — | **不做** | |

**PyTorch 後端擴充機制**（§2.9）：我們不做 PyTorch 的 C++ 後端，只做 JS 端的 ATen 風格介面，因此上表是**介面對映**，不是 dispatch 註冊。

### 12.4 降級層回報（`backend_info()`）

每個函式庫呼叫都回報：

```
{ lib: "cublas", op: "sgemm", layer: "T1" | "T2" | "T4",
  via: "wgsl-native" | "ours-emulated" | "cpu-fallback",
  reason: "…", accumulate: "f32", inputPrecision: "f32", reductionOrder: "tree-wg256" }
```

- `via` 對應使用者要求的三個名稱：WGSL 原生實作（T1）、我們的替代實作（T2）、CPU 降級（T4）。
- `reason` 必填，要具體（例如「此裝置沒有 subgroups，歸約改用 workgroup 記憶體」）。

---

## 13. 精度與語意：不得宣稱位元相同

**原則**：WebGPU 結果與 CUDA **不做位元相同宣稱**。差異來源與記錄方式：

| 差異來源 | 說明 | 記錄欄位 |
|---|---|---|
| 累加順序 | 歸約用樹狀或序列，結果不同 | `reductionOrder` |
| FMA 融合 | 是否使用融合乘加依編譯器而定；WGSL 與 CUDA 的融合規則【未驗證】 | `fma: "unknown"` |
| tf32 | PyTorch 文件：tf32 的輸入只讀前 10 位元尾數（【查證】[PyTorch 數值精度](https://pytorch.org/docs/stable/notes/numerical_accuracy)）。PyTorch 預設 matmul 的 tf32 **關閉**，conv 的 tf32 **開啟**（【查證】[MONAI](https://monai.readthedocs.io/en/stable/precision_accelerating.html)，PyTorch 1.12 之後）。我們用 f32 計算，**精度比 tf32 高**，與 CUDA 的 tf32 結果不同 | `inputPrecision: "f32"`，並標示比對的 CUDA 設定 |
| f16 累加 | PyTorch 文件：半精度 GEMM 通常以 f32 累加，部分 GPU 會截斷中間結果（【查證】同上） | `accumulate: "f32"` 或 `"f16"`（我們只用 f32） |
| bf16 | 以位元移位轉成 f32 計算，結果與原生 bf16 指令不同 | `inputPrecision: "bf16-emulated"` |

**容差規則（暫定，未實測）**：
- 容差與 `k`（內積長度）、`eps`（機器精度）成比例，**不寫死常數**（依使用者「門檻要自適應」規則）。暫定：相對誤差 ≤ c·√k·ε_f32，c 由實測決定。
- 比對基準要用**更高精度的參考**（CPU 的 f64 或雙 f32），而不是只比 CUDA。
- 整數與原子直方圖：完全相等。

**禁止的說法**：「與 CUDA 完全相容」「位元相同」「結果一樣」。只能說「在記錄的容差內一致」，並附實測數字與容差來源。

---

## 14. 路線圖調整（2026-11-15）

| 階段 | 內容 | 完成標準 |
|---|---|---|
| **第一階段** | 向量加、矩陣乘（同時是 `cublas.sgemm` 最小版）、歸約；能力偵測、降級紀錄、一致性測試；Python 模擬器最小橋接（§15） | 三核心 T1 與 T4 在容差內一致；`backend_info()` 能回報層與原因；假 `navigator.gpu` 測試通過 |
| **第二階段** | cuBLAS 常用子集（§12.1） | 每個子程式與 T4 比對通過；介面與參數順序與 cuBLAS 一致（除已記錄的差異） |
| **第三階段** | cuDNN 常用子集與 ATen 對映子集（§12.2、§12.3） | 卷積前向與反向、softmax、layer norm、交叉熵與 CPU 比對；MATH 版 SDPA 與 PyTorch 的 MATH 後端比對（同輸入的誤差表） |
| 後續 | 替代做法 T2 的 f32 原子與 f64（§3）、PTX 子集（§5）、全模型對拍（§7 的 P5） | 依實測決定 |

- 第二、三階段的工時為【推測】。
- 「沒有 WebGPU 的環境」：所有層都回報 T4 與原因，**不能壞掉**。

---

## 15. 第一階段實作紀錄與 Python 模擬器接線（2026-11-15）

**檔案**（與 §7 的規劃有一處差異：五個檔案合併成一個）：
- `renderer/src/gpu/gpu_core.js`：能力偵測、CPU 參考版、三個 WGSL 核心、執行期（降級與回報）。合併的原因：嵌入流程（`scripts/embed-code-ui.js` 的 `embed()`）一個區塊只吃一個檔。
- `renderer/src/gpu/gpu_core.test.js`：20 項，node 執行。假的 `navigator.gpu` 依 WGSL 開頭的 `@kernel` 標記改用 CPU 參考版算結果，**只驗證流程**（降級、回報、邊界、錯誤），不驗證 WGSL 本身。
- `renderer/src/studio/backend_core.js`：新增 `webgpuTierProbe(backendInfo)`，把執行期狀態轉成登錄表的 probe 結果（不可用時 reason 必填）。`KIND_BACKENDS` 沒有改，避免影響既有測試。
- `renderer/src/pybridge/cudaweb.py`：Python 端 API（`vector_add`、`matmul`、`sum`、`backend_info`）。
- `renderer/src/gpu/cudaweb_py_test.py`：8 項，以假的 `_fa_cudaweb` 與 `pyodide.ffi` 測試。
- `renderer/src/gpu/examples/cudaweb_demo.py`：範例。`features/ai-features.yaml` 加了 `cudaweb` 條目（清單由 `scripts/ai-features.js build` 產生）。
- `scripts/eval/cudaweb_gpu.eval.js`、`scripts/eval/cudaweb_gpu.run.js`：真桌面版檢查（見下）。

**Python 模擬器接線**：
- 主程式 `renderer/src/floating-assistant.js` 的 `_pyBridgeInstallPyodide` 開頭呼叫 `_cudawebInstallPyodide`，註冊 JS 模組 `_fa_cudaweb`，把 `cudaweb.py` 寫進 `/fa_cudaweb`。這條路徑是 Pyodide 模擬器（`_runPyodideScriptSync`、`_runPyodideScriptAsync`）共用的，網頁版與桌面版都走它。
- 與 `fa_bridge`（Python API 轉接）分開：不受「Python API 轉接」開關影響。
- `cudaweb.py` 只在 Pyodide（`sys.platform == "emscripten"`）生效；在一般 Python 呼叫會報錯並說明，不會壞掉。
- 建置：`GPUCORE` 區塊嵌入主檔（`FA_GPU_CORE_SRC`）；`scripts/build-web-lazy.js` 的 `EXCLUDE` 加入 `GPUCORE`，核心留在主檔、不切成懶載入區塊（核心只約 15KB，且 Python 模擬器同步呼叫，不值得多一次非同步載入）。

**未涵蓋**：
- GUI 的 `py_worker`（pygame 等獨立 Worker 的模擬器）沒有註冊 `_fa_cudaweb`，那條路徑不能 `import cudaweb`。
- 沒有 WebGPU 的環境只會走 T4，這是預期行為；T2、T3 尚未實作。

**驗證現況**：
- node：20 項全過（`node renderer/src/gpu/gpu_core.test.js`）。
- Python：10 項全過（`python renderer/src/gpu/cudaweb_py_test.py`）。其中含 `cudaweb.cublas.sgemm` 的最小介面：只支援 transa=transb='N'、alpha=1、beta=0，其他組合直接報錯；A、B、C 是列主序扁平 list，不是 cuBLAS 的欄主序裸指標。
- 真桌面版（真 Electron，不加 `--disable-gpu`，獨立 userData，換埠 18931）：**執行了一次，但結果遺失**。原因是評估檔最外層的 `return` 缺漏，腳本沒把結果回傳給啟動器。已修正並用假 WebGPU 離線模擬，6 項檢查全過。**沒有再開一次真桌面版**（規則：最多一次）。因此真 WebGPU 的 adapter、功能清單與核心結果目前**未驗證**。
- 網頁版真瀏覽器：**未驗證**。
- 數值容差仍是暫定值，**未實測**。
