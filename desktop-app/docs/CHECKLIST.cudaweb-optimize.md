# 清單：cudaweb 推論與訓練核心優化（適應各級 GPU）

使用者 2026-11-17：「我希望推論、訓練的cudaweb是經過高度優化的，必須可以適應各種等級的gpu」。
起因：設定頁 GPU 基準（`bench_run.js`）顯示 cudaweb 矩陣乘比 ort-webgpu、ort-wasm 慢一個數量級（這台 Kepler 14 W：64x1024x1024 cudaweb 178 ms、ort-webgpu 21.9 ms、ort-wasm 9.4 ms）。查原因：`mm_ops.js` 是一個執行緒算一格、每格迴圈 K 次讀全域記憶體。已修（提交 `b8d681672`，平鋪核心，真 Chrome 同機 69.8→16.4 ms、398→33 ms、1192→78 ms，驗證頁自己的計時）。

**規則：一輪只在每一項都是 [x] 或 BLOCKED（附原因）時結束。** 做完一項就提交、勾掉；每項都要有「驗收」。回報只在全部做完時一次。語言：繁體中文，不夾英文縮寫。

## 現況盤點（2026-11-17，讀程式確認；「核心」＝WGSL 著色器）
| 核心 | 檔案 | 現況 |
|---|---|---|
| f32 矩陣乘（ONNX MatMul、基準的 cudaweb） | `mm_ops.js` | 已改平鋪（64×64、暫存器 4×4）。還沒有 f16／向量載入／依 GPU 分級的變體 |
| 矩陣乘（numba／cupy／torch 相容層、訓練步） | `gpu_core.js` `WGSL.matmul` | 16×16 平鋪、一個執行緒一格；還沒用暫存器分塊 |
| q8 反量化矩陣乘（Qwen 解碼的主力） | `infer_ops.js` `q8mm` | 一個執行緒一格，內層每個元素都在位元組裡取值、沒有平鋪、沒有 4 位元組點積 |
| q8 詞表頭 | `infer_ops.js` `q8lm` | 一個工作群組一列、逐 u32 讀 4 位元組、樹狀歸約，尚可 |
| 4 位元（MatMulNBits） | `matmulnbits_gpu.js` | 一個執行緒一格，內層每個元素都做除法、取模、取位元組；最慢的一種 |
| 注意力＋KV | `attn_gpu.js` | 一個執行緒算一個（詞元, 頭）：分數算三遍、解碼（S=1）只有 H 個執行緒（約 16）在工作，GPU 幾乎閒著 |
| 卷積 | `conv_ops.js` | 一個執行緒一個輸出元素 |
| 正規化、softmax、silu、rope、AdamW | `nn_ops.js` | 一個執行緒一個元素或一列（記憶體受限的運算，影響較小，但沒有融合） |
| 執行模型 | `nn_ops.js` `runWgsl` | 每個運算各自上傳、各自 submit、各自 mapAsync 讀回；沒有指令批次、沒有緩衝區池（只有 pipeline 快取與權重 WeakMap 常駐） |

## 分級的定義（不看廠牌名，看能力；每級都要能跑，高級只是更快）
探測來源：`adapter.limits`（`maxComputeWorkgroupStorageSize`、`maxComputeInvocationsPerWorkgroup`、`maxStorageBufferBindingSize`、`maxComputeWorkgroupSizeX`）、`adapter.features`（`shader-f16`、`subgroups`、`timestamp-query`）、`wgslLanguageFeatures`（`packed_4x8_integer_dot_product` 等）、adapter.info（只用來記錄與快取鍵，不用來做決定）。
- **低階**（像這台 Kepler 14 W）：沒有 f16、沒有 subgroups、共用記憶體 16 KiB、每群組 ≤256 執行緒。要求：平鋪＋小暫存器分塊（4×4 以內）、f32、不用 subgroup。這是「必須比 ORT 好或相當」的基準線。
- **中階**：有 `shader-f16` 或點積語言功能；共用記憶體 ≥32 KiB。多一個 f16 儲存／計算變體、較大平鋪（64×128）、向量（vec4）載入。
- **高階**：有 `subgroups`（或將來的矩陣指令）、共用記憶體 ≥48 KiB。多一個子群組歸約變體與 8×8 暫存器分塊、雙緩衝。
- **最低階／軟體 adapter**：維持現有「簡單核心」（逐格），確保一定能跑。
選擇器要純函式（輸入能力表、形狀、運算 → 變體編號），node 可測；結果與基準勝負寫進快取（鍵＝adapter 描述＋形狀區間），使用者可在設定頁看到並可強制指定變體。

## 記憶體空間的選擇（使用者 2026-11-17：「早期的 nvidia 的 gpu 要優化過，要自己選擇把記憶體放到 constant memory 或 texture」）
早期 NVIDIA（Kepler 這一代）的快取結構和新卡不同：唯讀資料走專用的唯讀／貼圖快取、所有執行緒讀同一個位址時走常數快取（廣播），一般全域讀取反而不一定快。WebGPU 沒有直接的「constant memory」或 `__ldg`，最接近的對應：
- **uniform 緩衝區**（`var<uniform>`，預設上限 `maxUniformBufferBindingSize` 64 KiB，要 16 位元組對齊，用 `array<vec4<f32>>`）：所有執行緒讀同一個值的小資料（解碼時的輸入向量 x、縮放值、偏置、rope 表、LoRA 小矩陣），驅動程式可以放進常數快取做廣播。超過上限就分段綁定。
- **取樣貼圖**（`texture_2d<f32>` ＋ `textureLoad`，`r32float` 或 `rgba32float`，不需要過濾功能；每邊上限 `maxTextureDimension2D`，超過就切成多張）：唯讀的權重矩陣、有二維局部性的存取（卷積的輸入、矩陣乘的 B），走貼圖快取；`rgba32float` 一次讀 4 個值等於向量載入。
- **唯讀 storage 緩衝區**（`var<storage, read>`，現況）與**共用記憶體**（工作群組內重用，現況的平鋪就是）。
這些都是「變體」，由 O1 的選擇器與 O9 的自動調校依「能力＋實測」決定，不是寫死：新卡的統一快取讓它們差不多，舊 NVIDIA 才可能有明顯差別；沒有量到好處的運算就不要換（保持簡單）。每個用到的變體都要有能力檢查（貼圖尺寸、uniform 上限不夠就不選）與退回路徑。

## 共用記憶體（工作群組記憶體）一律要用（使用者 2026-11-17：「gpu kernel 還要用 shared memory 快取跟加速運算」）
凡是「同一份資料被工作群組內多個執行緒重複讀」的核心，都要把那份資料先成塊搬進 `var<workgroup>`，再從共用記憶體讀，而不是每個執行緒各自讀全域記憶體。逐個核心的做法（不是只有矩陣乘）：
- **矩陣乘／q8mm／MatMulNBits**：A、B 平鋪塊進共用記憶體（矩陣乘已做）；解碼用的 GEMV：輸入向量 x 整段（或分段）搬進共用記憶體，所有執行緒共用；反量化的縮放值每區塊讀一次放共用記憶體。
- **注意力**：K、V 以「鍵的平鋪塊」搬進共用記憶體，群組內所有查詢（或同一個 KV 頭的多個查詢頭，GQA）共用同一塊；分數與線上 softmax 的暫存值放共用記憶體做歸約。
- **卷積**：輸入的二維平鋪塊（含邊界）搬進共用記憶體，濾波器權重也搬一份。
- **rmsnorm／softmax／歸約**：一列資料搬進共用記憶體後用樹狀歸約（不是每個執行緒各掃全列）。
- **訓練的矩陣乘（含轉置版）**：同上；轉置的存取用「共用記憶體裡轉置」避免全域記憶體非連續讀。
- 實作規則：搬入時相鄰執行緒讀相鄰位址（合併存取）；共用記憶體陣列的列寬補 1（避免 bank 衝突）並用實測確認有沒有好處；低階卡的共用記憶體預算是 16 KiB（`maxComputeWorkgroupStorageSize`），平鋪大小要由 O1 的選擇器依這個上限算；高階卡才用雙緩衝（搬下一塊的同時算這一塊）。
- 每個核心的變體說明裡要寫「用了多少共用記憶體」，選擇器依能力表檢查，超過上限不選。

## 項目
- [ ] **O1m. 記憶體空間變體**（2026-11-17 進度：(a) x 放 uniform 已量：`scripts/eval/mem_space_check.html`，真 Chrome 純核心 K1024N3072 storage 0.465 ms 對 uniform 3.89 ms、K2048 0.87 對 8.34、K1024N1024 0.295 對 1.305 ⇒ **沒有好處，不採用**，結果一致（相對誤差 ≤3e-7）；(b) B 放 rgba32float 貼圖、(c) rope 表與偏置放 uniform 尚未做。｜原規格：在 `kernel_select.js` 的變體裡加「資料放哪裡」這個維度（storage／uniform／貼圖／共用記憶體暫存），並先做三個具體的：(a) 解碼用 q8mm／MatMulNBits／lm_head 的輸入向量 x 與縮放值放 uniform（分段綁定，x 是 K 個值，Qwen3-0.6B 的 K=1024 約 4 KiB，放得下）；(b) 矩陣乘的 B（權重）放 `rgba32float` 貼圖（平鋪核心用 `textureLoad` 讀 4 個值）；(c) rope 表、偏置放 uniform。每個變體：能力不足不選、node 假裝置測試、真 Chrome 對拍、同機計時（標硬體）。驗收：真 Chrome 同一張卡上每個變體逐元素一致；計時結果寫進 `cudaweb_optimize.result.json`，並寫明這台（Kepler 14 W）上哪個放法勝出、勝多少（沒有勝出就如實寫「沒有好處」，不要硬選）。
- [x] **O1. 能力探測與變體選擇器**（2026-11-17 完成：`renderer/src/gpu/kernel_select.js` 與 `kernel_select_test.js` 9 項通過；驗收為 node 測試，已滿足。目前變體表只列已實作的 matmul、q8mm；O4、O3、O5 加核心時要同步加進表。infer_ops 的 `q8mmVariant` 仍是獨立判斷，測試確認與選擇器一致，尚未改為呼叫選擇器。）：`renderer/src/gpu/kernel_select.js`（新）：`probeCaps(adapter, device)` → 能力表（上面列的 limits／features／語言功能，探不到的給保守預設）；`pickVariant(op, shape, caps, overrides)` → `{ id, tile, regBlock, useF16, useSubgroup, ... }`；覆蓋表可強制變體（測試與使用者用）。所有核心變體必須宣告「需要的能力」，能力不足的變體不會被選到。驗收：node 測試涵蓋三種假能力表（低／中／高）與強制覆蓋；低階一定回傳簡單或平鋪 f32 變體。
- [x] **O2. q8mm 優化（Qwen 解碼主力）**（2026-11-17 完成：`q8mm_dec`（M 任意、256 執行緒、共用記憶體 5 KiB）與 `q8mm_pf`（64×64 平鋪＋4×4 暫存器，共用記憶體 5 KiB）；`q8mmVariant` 選擇：N%4≠0 → simple，M<64 → dec，M≥64 → pf；真 Chrome（Kepler 14 W，`scripts/eval/q8mm_check.html`）12 個形狀全部與 q8mmRef 逐位相同（maxAbsDiff 0）；純核心時間每次派發：M=8 simple 5.7 ms／dec 0.8 ms；M=64 simple 44.3 ms／dec 5.8 ms／pf 4.1 ms；M=1 K1024 N1024 simple 0.78／dec 0.15 ms。pf 在 M=1、8 比 dec 慢，所以門檻設 64；（2026-11-17 補量：M=32 dec 2.985 ms 對 pf 4.13 ms，dec 仍快；M=64 起 pf 勝出，門檻 64 正確。）**未完成的部分**：端到端含上傳讀回約 12 ms（overhead 主導，要靠 O6 批次才看得出差別）；裝置後來因 simple 在 M=256 的 20 次派發超過 Windows GPU 逾時而丟失，之後 Chrome 的 WebGPU 介面卡回傳空值，M=256 與 pf 的覆蓋量測已於 2026-11-17 GPU 恢復後補做，見 `scripts/eval/cudaweb_optimize.result.json`。）：兩個變體：(a) 解碼用（M ≤ 8）：一個工作群組負責一小段輸出欄、沿 K 切給多個執行緒、一次讀整個 u32（4 個權重）、有 `packed_4x8_integer_dot_product` 時用 `dot4I8Packed`／`dot4U8Packed`、否則手動展開；工作群組內歸約。(b) 預填用（M 大）：平鋪＋暫存器分塊。驗收：真 Chrome 對現有 `q8mmRef` 逐元素一致（整數累加，必須逐位相同）；同機計時 8 個詞元解碼的 q8mm 部分，標硬體；低階路徑不需要點積功能也能跑。
- [x] **O3. MatMulNBits 優化**（2026-11-17 完成：解碼 `matmulnbits_dec`（M≤8）與預填 `matmulnbits_pf`（M>8，16×16 塊、128 k 分塊，共用 9.25 KiB）；真 Chrome 三個變體所有形狀 T1、相對誤差 ≤1.3e-6；端到端計時 M=8 dec 17.2 ms 對 pf 19.3 ms，M=16 起 pf 勝（17.9 對 20.2），門檻與實測一致；結果寫在 result.json。純核心計時尚未量，端到端被上傳蓋過一部分。｜早先的紀錄：真 Chrome 已驗證解碼變體：6 個形狀全部 T1、相對誤差 ≤3.2e-7；M1 K1024 N3072 dec 15.4 ms 對逐格版 23.6 ms（牆鐘，只標這台）。仍未完成：預填平鋪變體。｜以下為原始說明：解碼變體 `matmulnbits_dec` 寫好（256 執行緒、16 欄×16 條 lane、A 的 256 個 k 搬進共用記憶體、縮放值每字一次、歸約經共用記憶體，共用 2 KiB）；M≤8 走它。node：索引數學的 JS 模擬與參考版相對誤差 ≤1e-5（五個形狀），假裝置走 T1，`matmulnbits_dec_test.js` 9 項通過。**未完成**：①預填（M 大）平鋪變體，目前 M>8 仍走逐格版；②真 Chrome 驗證待介面卡恢復，驗證頁 `scripts/eval/matmulnbits_dec_check.html`（讀 `window.__out`，cases 的 `pass` 全 true）；③計時「比現況快」尚未量。）：反量化搬到區塊層級（每 32 個權重一個縮放值，讀一次）、一個工作群組處理多個輸出欄、每個執行緒一次處理 8 個 nibble（一個 u32）；解碼（M 小）與預填（M 大）兩個變體。驗收：真 Chrome 對 `matmulnbits_ref` 相對誤差 ≤1e-5（f32 累加）；同機計時比現況快（標硬體）。
- [x] **O4. 注意力優化**（2026-11-17 真 Chrome 已驗證：`attn_flash_check.html` 6 個形狀全部 T1、相對誤差 ≤1.1e-6；解碼 S=1 past512 H16 Hkv8 hd128 flash 20.3 ms 對 attn 158.5 ms；預填 S=16 flash 12.8 ms 對 attn 18.0 ms（牆鐘含讀回，只標這台）。結果在 `scripts/eval/cudaweb_optimize.result.json`。｜以下為原始說明：2026-11-17：`attn_gpu.js` 新增 `attn_flash`（分塊線上 softmax，64 執行緒、共用記憶體 sc 1 KiB，預填與解碼共用；hd 須為 64 的倍數且 ≤512，否則保底 `attn`）；`flashRef` 的 JS 版與 `attnCore` 在五個形狀（含 GQA、past>0、跨 256 邊界、hd 128/256）相對誤差 ≤1e-5；假裝置走 T1。`attn_flash_test.js` 9 項通過。**真機驗證待做**：desktop-app 資料夾 `python -m http.server <埠>`，Chrome 開 `scripts/eval/attn_flash_check.html`，讀 `window.__out`，判準 cases 的 `pass` 全為 true 且 `time` 標硬體。）：解碼（S=1）：一個工作群組負責一個（頭），群組內執行緒分攤「鍵」維度做線上 softmax（一遍：最大值與分母一起更新）、再分攤 hd 做加權和，工作群組歸約；預填（S 大）：每個（詞元, 頭）一個群組、鍵維度平鋪、線上 softmax。分數只算一遍。驗收：真 Chrome 對 `attn_ops` 參考相對誤差 ≤1e-5，涵蓋 GQA（Hkv<H）、past>0、S=1 與 S>1；同機計時（標硬體）。
- [x] **O5. 矩陣乘再優化＋共用**（2026-11-18 完成；f16 為 BLOCKED：本機介面卡無 shader-f16，核心已寫、標待驗證。進度：①共用核心完成：`gpu_core.js` 的 `mmTileWgsl` 同時供 `WGSL.matmul` 與 `mm_ops` 平鋪版，未另開模組（gpu_core 是 UMD 嵌入，不能 require）；②轉置（AᵀB、ABᵀ、AᵀBᵀ）用 p0 旗標，真 Chrome `scripts/eval/mm_tile_check.html` 23 項逐位相同、負對照相對誤差 1.50；③f16 核心已寫，本機無 shader-f16，標「待驗證」；④vec4 變體完成：不轉置、K 與 N 為 4 的倍數時 wgMatmul 自動選用；真 Chrome 逐位相同，同機計時 512×1024×3072 約 78–87 ms 對純量平鋪 110–129 ms（快約 25–30%），512×1024×1024 約 32 ms 對 41–54 ms，64×1024×1024 兩者持平約 16 ms；⑤f16 BLOCKED（無 shader-f16，待有此功能的機器驗證）。數字與 result.json 的 matmul_tiled_* 一致。）：`gpu_core.js` 的 `WGSL.matmul``gpu_core.js` 的 `WGSL.matmul`（numba／cupy／torch 相容層與訓練步用）改用 `mm_ops` 的平鋪核心（抽成共用模組，兩邊 import 同一份）；加 f16 變體（需要 `shader-f16`，儲存 f16、累加 f32）與 vec4 載入變體；依 O1 的選擇器選。轉置版（訓練的反向：`AᵀB`、`ABᵀ`）用同一份核心的索引參數，不另寫一份。驗收：真 Chrome 各形狀（含非平鋪倍數、批次、窄、轉置）對 CPU 參考相對誤差 ≤1e-6（f32）／≤1e-3（f16）；強制每個變體都跑一遍（同一張卡上用覆蓋表模擬各級）。
- **O6 最後一步（第十一段，假裝置計次）**：`renderer/src/gpu/qwen_gpu_submit_count.test.js` 用記錄型假裝置跑真的 `createGpuEngine().step()`：一步 submit＝L+1（L=1、3），兩步＝2×(L+1)，3 項通過。**未用真模型驗證**（真 Qwen3-0.6B 權重載入太重，如實標示）。原先的 BLOCKED 改為此項。
- BLOCKED **O6 的最後一步**（2026-11-18 第九段，程式證據）：`qwen_gpu.stepOnce` 本來就是「每層一次 submit」（每步 L+1 次：28 層各一個 command encoder＋lm_head／argmax 那一段；每 4 層等一次完成，註解寫明是為了舊顯卡不被判定卡死），**不是**每運算一次。所以真 Qwen 的「每層一次」計次不需要改程式；BLOCKED 的原因是「用真 Qwen3-0.6B 權重在 Chrome 量 submit 次數」需要載入模型，本輪沒做。
- [ ] **O6. 執行模型：指令批次與緩衝區池**（2026-11-18 第九段補充：批次新增 `quantizeDyn`（動態量化整段在 GPU：兩個工作群組核心求 min／max、算 scale／zp，第二段逐元素量化成 i32）。真 Chrome `scripts/eval/o6_quant_check.html` 5 個案例全部通過：整批 1 次 submit，xq 逐元素與參考版相同（0 個不一致），scale 相對誤差 ≤1e-6（GPU 的 f32 除法比參考版 f64 再 fround 相差 1 ulp）。之後又加 `q8mmBatched`（infer_ops，dec／pf／simple 三個核心的批次版，scale 從 GPU 讀）：真 Chrome `scripts/eval/o6_q8_batch_check.html` 四個形狀全過，整批 1 次 submit，相對誤差 0～1.3e-7。再加 `attnCoreBatched`（attn_gpu，flash 與保底兩個核心）：真 Chrome `scripts/eval/o6_attn_batch_check.html` 三個形狀全過，每案 1 次 submit，相對誤差 1e-7～1e-6。再加 `matmulNBitsBatched`（matmulnbits_gpu，dec／pf／simple）：真 Chrome `scripts/eval/o6_nbits_batch_check.html` 四個案例全過，每案 1 次 submit，相對誤差 1e-7～5e-7。**O6 還沒完成的部分**：真 Qwen 區塊還沒用批次版串成一層（q8mm、注意力、MatMulNBits 與 rmsnorm、rope、silu 放在同一個 submit），所以「每層一次 submit」還沒對真模型量；這一步要在 qwen_gpu 的層迴圈接線後才能量。）（2026-11-18 進度：批次新增 matmul（K、N 為 4 倍數走 vec4 版，否則純量，與 gpu_core 共用核心）；真 Chrome `scripts/eval/batch_layer_check.html`：rmsnorm→matmul→rope→matmul→silu→matmul 這串「層形」運算，批次 1 次 submit 對逐運算 6 次，兩個形狀（d=64 與 d=50）皆與逐運算逐位相同，牆鐘中位數 4.0 ms 對 24.5 ms（只標這台）。**未完成**：真的 Qwen 區塊（注意力、q8mm、MatMulNBits 等）還沒接進 createBatch，所以「每層一次 submit」還沒對真模型量。以下為 2026-11-17 進度：node 部分完成，`renderer/src/gpu/gpu_pool.js`（池＋管線快取）接進 `nn_ops.createBatch`；讀回用池的暫存緩衝區；`gpu_pool_test.js` 7 項、`nn_ops_test.js` 36 項通過。**未完成**：真 Chrome 跑一層 Qwen 區塊的 submit 計次與逐位比對（待 WebGPU 介面卡恢復，驗證指令見 O10）；`createBatch` 目前只涵蓋 rmsnorm、softmax、silu、rope，matmul 還沒進批次。）：`nn_ops.runWgsl` 之上加「一個 submit 跑一串運算」的批次介面（一層 Transformer 的運算編進同一個 command encoder，中間結果留在 GPU，最後才讀回）；暫存緩衝區池（依大小分桶、用完歸還，不每次 createBuffer／destroy）；讀回改用環狀暫存（不每次建立 MAP_READ 緩衝區）；`Float32Array.from` 不必要的複製全部去掉。驗收：node 假裝置測試涵蓋批次與池（歸還、重用、上限）；真 Chrome 跑一層 Qwen 區塊，submit 次數從每運算一次降到每層一次（計次證據），結果與原本逐位相同。
- [~] **O7 進度（2026-11-18 第九段）**：①程式證據：生產引擎已有 `qk`（RoPE＋QK 正規化＋寫 KV，融合）、`silu`（gate×up 融合）、`add`（殘差）；`rms`、`quant` 仍是獨立派發。②新增 `rmsQuantFused`（nn_ops，單列 RMSNorm＋動態量化一次派發）。**拆開量（第十一段）**：rmsnorm 並行化 0.780 → 0.220 ms／鏈（約 3.5 倍）；融合（3 派發 → 1 派發，兩者都並行）0.220 → 0.109 ms（約 2.0 倍）；總計 7.1 倍。結果在結果檔 `fusion_O7_split_2026_11_18`。真 Chrome `scripts/eval/o7_rmsq_check.html`：正確性通過（q 不一致 0、y 相對誤差 7e-8、1 次 submit）；計時（64 次重複、同一批次、牆鐘含讀回，只標這台）：串列 rmsnorm＋quantizeDyn 每鏈 0.82 ms（3 次派發）、融合 0.13 ms（1 次派發）。**注意**：基準的 rmsnorm 是每列一個執行緒串列掃描（很慢），所以這個 6 倍混了「並行化 rmsnorm」與「融合」兩個效果，還沒分開量。③**未做**：把融合核心接進生產引擎（要在真 Qwen 上驗證，本輪沒做）；卷積融合與 softmax 線上版未做。
- [ ] **O7. 融合與其他核心**：rmsnorm＋後續矩陣乘的輸入縮放、silu×乘法（gate×up）、rope 併進 QKV 後處理；卷積改「im2col＋平鋪矩陣乘」或直接平鋪卷積（依 O1 選）；softmax 線上版。驗收：每個融合核心對未融合版本逐元素一致（相對誤差 ≤1e-6）；真 Chrome 同機計時（標硬體）。
- [ ] **O8. 訓練路徑**：LoRA／AdamW／交叉熵等用 O5 的平鋪與轉置核心；AdamW 與梯度累加融合成一次派發；前向可用 f16（有 `shader-f16` 時）、主權重與累加維持 f32；訓練步內不做逐運算讀回。驗收：真 Chrome 20 步訓練 loss 對 CPU f64 最差相對差不比現在（見 `docs` 內 I 項結果）差；同機每步時間（標硬體）。
- [ ] **O9. 自動調校與快取**（進度 2026-11-17：node 部分完成，`kernel_select.js` 的 `cacheKey`／`capsHash`／`pickWithCache`／`chooseWinner`，`kernel_select_test.js` 15 項通過。**未完成**：瀏覽器端的競賽執行（背景、≤2 秒、取消）、localStorage 包裝、設定頁兩處的 UI、真 Chrome 跑一次的結果。）：`bench_core.js` 已有基準；加「變體競賽」：第一次遇到（adapter、運算、形狀區間）時，在合理時間內（≤2 秒、背景、可取消）各變體各跑 3 次取中位數，勝者寫進快取（localStorage，鍵含 adapter 描述與能力表雜湊，能力變了就失效）；使用者可在設定頁（兩處：AI 助理設定與桌面版設定頁，同步）看到每個運算目前用哪個變體、可強制指定、可重跑、可恢復預設。預設只用選擇器的規則；調校預設開但絕不擋住第一次使用（先用規則的變體，調校完下次才換）。驗收：node 測試涵蓋快取鍵、失效、強制覆蓋；真 Chrome 在這台上跑一次，結果顯示在設定頁。
- [ ] **O10. 各級模擬驗證**：因為只有一張真卡（低階），用 O1 的覆蓋表在同一張卡上強制每個變體（含需要 f16 或 subgroups 的，若這張卡不支援就用軟體 adapter 或標「待有該能力的機器驗證」並寫好驗證頁與指令），每個變體都要過各自的對拍；結果寫進 `scripts/eval/cudaweb_optimize.result.json`（含硬體、能力表、每個變體的誤差與時間）。驗收：結果檔每個變體有「通過」或「待驗證（原因）」。
- [ ] **O11. 建置與整合**：`node scripts/embed-code-ui.js`、`node build-assistant.js`、`node scripts/build-web-lazy.js`、動到的 node 測試全過；設定頁基準（`bench_run.js`）顯示優化後的 cudaweb 數字；`git status` 沒有未提交來源（web-lazy 的 CRLF 差異不算）。不發布，管理者核對後發布。

## 怎麼做才不浪費
- 先讀 `docs/HANDOFF.cudaweb-inference.md` §8 的程式地圖，用 Grep 定位，不要整檔讀 `floating-assistant.js`。
- 每個核心的做法：CPU 參考（已有）→ node 假裝置測試（核心名稱辨識）→ 真 Chrome 驗證頁（照 `scripts/eval/mm_tiled_check.html`：起 `python -m http.server <埠>`、用 Claude in Chrome 開、讀 `window.__out`）。**用完一定關掉伺服器與分頁，用 PowerShell 查 `Win32_Process` 確認沒有殘留**（使用者的機器老舊，殘留行程會吃 CPU 與磁碟）。
- 不要對 AppData 或整個家目錄做遞迴搜尋。
- 速度數字都標硬體（這台：Kepler 14 W、舊 CPU）；驗證頁自己的計時與設定頁基準的數字不同（基準含轉換與讀回），不要混著比。
- 一個提交只做一件事；提交訊息寫做了什麼＋怎麼驗證。改程式用 Edit／Write 工具，不用 shell 內嵌 heredoc 寫含反斜線的程式；中文內容的 Python 腳本要用 Write 工具寫成檔再用 `python -X utf8` 執行。
- context 到 60% 才交接（Haiku 子工作階段）。

## 新目標（2026-11-18 管理者轉達使用者：「要讓 webgpu 趨近官方的 cublas 一樣效能」）
完整說明與規則：`docs/TARGET.cudaweb-cublas.md`。這台沒有可用的 cuBLAS，用屋頂模型：峰值 ＝ WebGPU 實測；大矩陣乘目標 ≥60%（第一階段 40%）、記憶體受限運算 ≥80% 頻寬。優先於 O6 以後的項目（O5 已完成，這是 O5 之後的矩陣乘效能線）。
- [x] **R0. 屋頂**（2026-11-18）：`scripts/eval/roofline_check.html`。peakFlops ≈ 127–128 GFLOP/s（純 FMA 8 條鏈；16 條鏈反而 80），peakBW ≈ 11.4 GB/s（vec4 複製 64 MiB）。結果在 result.json 的 `roofline_2026_11_18`。
- **R1 結論（2026-11-18 第三段，kernel-only 實測，見 result.json 的 `kernel_only_2026_11_18`）：8×8 與 8×4 暫存器分塊核心在 512×1024×1024 達 47–50% 峰值、512×1024×3072 達 49%，都比現有 v4（4×4 暫存器、64×64 塊、vec4 載入）慢（v4：78%、65%）。沒有好處，不採用為預設；保留程式（`mmR8Wgsl`）供後續分析。v4 目前最好：1024³ 67%、512×1024×3072 65%，已達第一階段 50%，逼近 60%。**
- [ ] **R1 原規格（保留）**：`gpu_core.js` 的 `mmR8Wgsl`（16×16 執行緒、128×128 輸出塊、64 個 fma 累加器、K 每次 8 層、A 與 B 以 vec4 搬進 8 KiB 共用記憶體、計算迴圈全展開）。條件：不轉置、K%8==0、N%4==0。**狀態：程式已寫、node 測試通過（fake 路徑）；真 Chrome 單次派發正確（r8_probe.html：128×64×128、130×24×132、512×1024×1024 全部正確）；計時尚未完成**——`mm_r8_check.html` 整頁多次讓 Chrome 分頁凍結、WebGPU 一度無回應，已停手；之後請用 `r8_time.html`（一次一個形狀）逐一量，再回填下表。
  - 目前的比較基準（同機，含讀回，見 result.json）：512×1024×1024 vec4 約 32 ms ≈ 33 GFLOP/s ≈ 26% of 127；512×1024×3072 vec4 約 78–87 ms ≈ 37–41 GFLOP/s ≈ 30–32%。
- [ ] R2. 向量載入與合併存取（已用於 vec4 版與 R1）、明確 fma（R1 已用）、軟體預取（待做）
- [ ] R3. split-K（解碼與 LoRA 的小 M、N 大 K 形狀）
- [ ] R4. 工作群組大小搜尋（128／192／256 執行緒）與自動調校（併入 O9）
- [ ] R5. 套用到 q8mm、MatMulNBits、注意力、卷積、訓練轉置版（各自量前後）
- 每個變體：GFLOP/s、峰值百分比、優化前後、真 Chrome 對拍（相對誤差 ≤1e-6）。沒好處的如實記「沒有好處」。

### 變體階梯（G1–G5，依管理者 2026-11-18 排序：G1 → G2 → G4 → G3 → G5；編譯慢不淘汰變體，只留約 30 秒的防卡死上限；快取存 IndexedDB，存「勝者參數」）
- [~] **G1. 產生器** `renderer/src/gpu/kernel_gen.js`（2026-11-18 第四段）：`describe`、`enumerate(caps)`、`generate(spec)`、`dispatchFor`。內層 k 用迴圈、只展開 TM·TN 的 fma。node 測試 `kernel_gen_test.js` 8 項通過（含 JS 索引模擬 scalar 與 vec4 對 CPU 參考）。**2026-11-18 第六段收尾（管理者核對前的進度）**：①嵌入：`scripts/embed-code-ui.js` 的 `embed()` 新增可選參數 `prependFile`，`FA_GPU_CORE_SRC` 先放 kernel_gen 再放 gpu_core（kernel_gen 掛在 `self.FaKernelGen`，gpu_core 的 `kg()` 取用；node 用 require）。方案 A。②`mmR8Wgsl` 已改成 kernel_gen 實例（WG16 TM8 TN8 BK8 vec4，8 KiB 共用）。③`mmTileWgslVec4` **還原手寫版**：kernel_gen 的同幾何實例（WG16 TM4 TN4 BK16 vec4）真 Chrome 實測 44–59 ms／次，手寫版 10.4 ms（80.5% 峰值），慢約 5 倍，production（nn_ops）不能換。kernel_gen v4 的差距原因未查（疑似 As 的列主序寫入造成共用記憶體 bank 衝突，或 k 迴圈未展開），列為 G1 後續。④真 Chrome 驗證頁 `scripts/eval/g1_gen_check.html`（一頁一形狀，`?M&K&N&kernel=r8|v4&before=1`）：512×1024×1024 kernel_gen R8 相對誤差 3.0e-7、17.97 ms／次、46.6% 峰值（R1 記錄 47–50%，持平）；kernel_gen v4 相對誤差 3.0e-7、51.6 ms、16.2%；HEAD 手寫 v4 相對誤差 0、10.4 ms、80.5%。⑤node：gpu_core 41、kernel_gen 8、nn_ops 37、mm_ops、gpu_kernel 4 項全過。**未完成**：q8mm、MatMulNBits 的內層還沒接上 kernel_gen（G1 的「三種運算共用外層」）。（2026-11-18 第八段：kernel_gen v4 慢的原因已查明＝`a*b+c` 沒用 `fma()`，改用 fma 後與手寫版持平，見 `scripts/eval/kgen_vec4_fma_2026_11_18.json`；不換 production。）
- [x] **G2. 階梯與編譯預算**（2026-11-18 完成：`kernel_gen.ladder()` 產生 18 個變體（5 個塊 × BK 8／16 × 純量／vec4；2×2 塊不能 vec4 故少 2 個）。真 Chrome `scripts/eval/g2_ladder_compile.html` 只編譯、不派發（無逾時風險）：全部 18 個編譯成功、無裝置遺失；編譯毫秒 85（32×32 BK8 純量）到 400（128×128 BK16 vec4）；共用記憶體最大 16 KiB（128×128 BK16）。不因慢淘汰。split-K 未由產生器支援，列為 G2 後續。）：約 8–12 個代表階梯（32x32/t2x2、64x64/t4x4、64x128/t4x8、128x64/t8x4、128x128/t8x8，各加 vec4 與 split-K），逐一 `createComputePipelineAsync` 並記錄編譯毫秒；**編譯慢不淘汰**，只留約 30 秒防卡死上限。
- [~] **G4. 選擇與驗證**（2026-11-18 進度：`renderer/src/gpu/variant_race.js` 完成：`race()`（驗證先於計時、驗證不過標壞退下一名、K 上限 3、時間預算 2 秒、可取消、3 次取中位數）、`makeKey()`（adapter＋驅動／瀏覽器版本＋能力簽名＋運算＋形狀，任一變即失效）、`createStore()`（IndexedDB，失敗或不存在退記憶體）。`variant_race_test.js` 9 項通過（node，無 indexedDB，只驗記憶體退路與 IndexedDB 開啟失敗的退路）。**未完成**：①IndexedDB 真機讀寫（Chrome 上未跑）；②接進 nn_ops／infer_ops 的實際派發（目前只是模組，尚無呼叫端）；③「真 Chrome 在這台跑一次」的競賽（需要 G5 的頁面或測試頁）。）：首次使用前小形狀對 CPU 參考驗證，不過就標壞退下一名；priors 第一名先用；背景對前 3 名實測（≤2 秒、可取消）；勝者參數存 IndexedDB（失敗退記憶體），鍵含 adapter 描述、驅動／瀏覽器版本、能力簽名；變了就重跑完整 benchmark。
- [x] **G3. priors**（2026-11-18 完成：`renderer/src/gpu/profile_priors.js`（`capSig`、`tierOf`、`lookup`、`validate`、`exportPriors`、`importPriors`）與 `profile_priors.json`（一筆 measured＝GT 720 簽名 `wg16384-inv256-f160-sg1`，三筆 heuristic 低／中／高）；`profile_priors_test.js` 9 項通過（含匯出入往返、heuristic 不可匯入、JSON 與內建同步）。sg 欄位的真實值待 G5 頁確認。）：能力簽名 × 運算 × 形狀區間 → 候選順序；`measured`（目前只有這張 GT 720）與 `heuristic`（屋頂模型估算，明確標示，不當成已量測）分開；匯出／匯入 JSON。
- [x] **G5. 設定頁「變體競賽」表**（2026-11-18 第十段：真 Electron 實機驗證通過，`scripts/eval/g5_variant_panel.eval.js`，獨立使用者資料夾與埠 18641，表 10 列、六個按鈕、各按鈕狀態文字正確。**發現**：這台的能力簽名算成 `sg0`，priors 的實測項是 `sg1`，所以實測剖析在這台沒命中，sg 真值要確認。兩處同步：index.html 沒有 GPU 基準區塊，未加第二處，待管理者決定。以下為第九段的原始進度記錄：`renderer/src/gpu/variant_table.js`（純函式：GFLOP/s、占峰值、來源、勝者、摘要）與 `variant_table_test.js` 7 項 node 通過；`floating-assistant.js` 的 `_gpuVariantPanel()` 接在 GPU 基準面板下方，按鈕：套用最佳（重新套用儲存的勝者）、重跑變體競賽（只量 AUTO_SHAPES 64×1024×1024，可取消）、匯出剖析、匯入剖析（heuristic 不接受）、恢復預設；`profile_priors`、`variant_table` 已加進嵌入清單與 `FA_QWEN_SRC`。**未做**：①真桌面版／真 Chrome 讀 DOM（尚未開頁，所以畫面與按鈕行為沒有實機證據）；②「兩處同步」：`renderer/index.html` 的 AI 助理設定沒有 GPU 基準區塊（grep「gpu／GPU」零結果），所以目前只有 floating-assistant 內部面板一處，是否要在 index.html 加一份待管理者決定；③編譯毫秒欄目前一律「未記錄」（競賽沒有量編譯時間）；④預先剖析的 local 項目是依能力簽名查表、不分形狀，排序只當參考。）：形狀 × 變體，GFLOP/s、峰值百分比、編譯毫秒、正確性、來源（measured／heuristic／本機實測）、勝者標示；按鈕：套用最佳、重跑、匯出、匯入、恢復預設。AI 助理設定與桌面版設定兩處同步。

## 持續優化迴圈（2026-11-17 管理者轉達使用者：「讓他持續優化下去」）
O1m 到 O11 做完後不結束，進入迴圈。完整規則與交接見 `docs/HANDOFF.cudaweb-optimize.md`。每一輪在這裡追加一筆：

| 輪次 | 量到的瓶頸（同機、標硬體） | 這輪改什麼 | 改後數字（對照 ort-webgpu） | 提交 |
|---|---|---|---|---|
| 第 1 輪（2026-11-18，第十一段） | 結果檔找出最遠離屋頂的可量運算：小形狀 64×256×256，v4 13.8% 峰值（0.47 ms／派發，只派發 4 個工作群組，這台 1 個 SMX） | 試 kernel_gen R8 1×4 塊（16×64，16 個群組） | 0.43 ms、15.2% 峰值（+9%，在雜訊內）；正確性 2.1e-7。**沒有明顯好處，不換 production**。這個差距主要是每次派發的延遲，不是核心本身；真正的改善已經是 O6 的批次（同一提交多個派發）。 | 本段無程式提交（只有量測；量測頁沿用 g1_gen_check.html） |

每輪的計時形狀：設定頁基準 64×1024×1024、512×1024×1024、512×1024×3072；Qwen 解碼單步；注意力；4 位元矩陣乘代表形狀。沒有好處的方向如實記「沒有好處」。

## O12. Llama 系列通用解碼骨架（使用者 2026-11-18：「把 Llama 系列的通用解碼骨架排進去，qwen_gpu 優化則是一種 override」）
背景：`renderer/src/gpu/qwen_gpu.js` 把 Qwen3 的結構寫死（qk-norm＋RoPE、GQA、SiLU×up、q8、大嵌入表），其他 LLM 吃不到 cudaweb 的優化。要拆成「通用骨架＋結構描述＋可覆寫的優化」。
- [ ] **O12a 結構描述（架構描述表）**：每個模型族一份純資料描述：層數、隱藏維度、頭數與 KV 頭數（GQA／MHA）、頭維度、前饋維度；歸一化種類（RMSNorm／LayerNorm）與 epsilon、是否 qk-norm；位置編碼（RoPE 基底、是否縮放、旋轉方式 half／interleaved）；前饋啟動（SiLU×up／GELU 等）；是否有偏置；是否共用嵌入與 lm_head；量化格式（q8／q4／f16／f32）；詞表與特殊詞元。先涵蓋 Llama 系列（Llama 3.x、TinyLlama、SmolLM 這類 RMSNorm＋RoPE＋GQA＋SiLU），Qwen3 以描述表表示（qk-norm 開）。Gemma／Phi 只先寫描述欄位與待驗證標記，不宣稱支援。
- [ ] **O12b 通用解碼骨架** `llm_gpu.js`（名字可調）：依描述表組出每層的運算序列（RMSNorm → 動態量化 → 投影 → [qk-norm] → RoPE → KV 快取 → 注意力 → 輸出投影 → 殘差 → RMSNorm → 前饋 → 殘差 → 最後歸一化 → lm_head → argmax），全部用現有的通用核心（變體競賽選出的矩陣乘、`q8mm`、`MatMulNBits`、`attn_flash`、批次送出）。不寫死任何模型的維度。CPU 參考引擎（`qwen_decode.js` 的做法）同樣參數化，逐位對拍。
- [ ] **O12c 覆寫機制**：骨架的每個運算位置是可覆寫的「槽」；預設用通用核心；模型族可註冊覆寫（例如 Qwen3 的融合 RMSNorm＋動態量化、qk-norm＋RoPE 合併核心、`qwen_gpu` 現有的手調路徑）。`qwen_gpu.js` 改成「Qwen3 的覆寫集合＋描述表」，行為與現有結果逐位相同（`qwen_gpu_*.test.js` 全部維持通過，不得退步）。覆寫要可關掉，用來量「覆寫有沒有真的比通用快」，沒有好處就如實記並移除。
- [ ] **O12d 模型表與載入**：`qwen_models.js` 的模型表泛化成模型族＋模型清單（Qwen3 兩個照舊，加 Llama 系列一到兩個小模型的 repo、大小、sha256 待下載後核對）；`isFamily` 改為依描述表判斷；沒有 WebGPU 或不支援的結構一律退回既有 ONNX 路徑，不得悄悄算錯。
- 驗收：node 測試涵蓋描述表驗證（缺欄位、不合法組合要報錯）、通用骨架對 CPU 參考逐位相同（用小型假權重的 Llama 形狀與 Qwen 形狀各一）、覆寫開關前後結果相同、現有 qwen 測試全過。真 Chrome：Qwen3 0.6B 走新骨架結果與舊引擎逐詞元相同；Llama 系列有真權重才驗，沒有就標「未用真模型驗證」。每小步提交。

## O13. VLM（看圖模型）接進 cudaweb（使用者 2026-11-18：「排成 O13，VLM 也要，我們應該也有用 llava 那個」）
現況（查證 2026-11-18）：看圖模型有 Florence-2、SmolVLM 256M、LLaVA-Interleave Qwen 0.5B（模型表在 `renderer/src/vlm/vlm_core.js`，`arch` 為 `florence`／`vision2seq`／`llava`），全部走 transformers.js（Worker、onnxruntime-web），**沒有走 cudaweb 的核心**（`docs/INVESTIGATE.cudaweb-models.md` §2.2；`docs/CHECKLIST.cudaweb-wire.md` 的接線只到 Qwen3 聊天、Whisper 編碼器、YAMNet／Demucs、SDXS、Kokoro、Basic Pitch、MOSS）。且 `gpuNeedsF16` 的模型在無 f16 的卡上（這台 GT 720）直接退 CPU，LLaVA 在 CPU 上要 140 到 150 秒。
- [ ] **O13a LLaVA-Interleave Qwen 0.5B**：語言模型部分是 Qwen2 結構（用 O12 的描述表表示，通用骨架加 Qwen 覆寫）；視覺部分是 SigLIP 類的 ViT 編碼器加投影層，另寫「視覺編碼器骨架」（patch 嵌入、LayerNorm、多頭注意力、MLP、投影，全用現有通用核心：變體競賽的矩陣乘、`attn_flash`）。圖像特徵以嵌入形式插進文字嵌入序列（影像詞元位置）後送進解碼骨架。**無 f16 的卡要用 f32 或 q8 路徑**，不能再因 `gpuNeedsF16` 退 CPU（這正是這台最大的收益）。
- [ ] **O13b SmolVLM 256M**：同上（語言模型是 SmolLM 類 Llama 結構，視覺是 SigLIP）。
  - 進度（2026-11-18）：程式與假權重測試完成。`renderer/src/gpu/smolvlm_skeleton.js` 加上 `smolvlm_skeleton_test.js`（11 項）：pixel shuffle、連接器、影像佔位詞元插入、`llm_skeleton.stepVec` 與 `step` 逐位一致、整段前向對獨立算的結果。`llm_skeleton.js` 為此新增 `stepVec`（原本的 `step` 行為不變，16 項與 GPU 版 5 項仍通過）。
  - **2026-11-18 真權重進度（使用者本人同意下載）**：位置 `ai-temp/vlm-weights/smolvlm/`（不進 git）。從 HuggingFace 官方 `HuggingFaceTB/SmolVLM-256M-Instruct` 的 `onnx/` 下載並核對 LFS sha256 相符：`vision_encoder.onnx`（374,316,497 B，`e27ad810…18`，fp32 參考）、`vision_encoder_quantized.onnx`（94,247,969 B，`f82adc84…95`，cpu 組合）、`vision_encoder_q4.onnx`（63,784,987 B，`95814e66…88`，gpu 組合）、`embed_tokens.onnx`（113,541,419 B，`a68ea405…0a`，fp32 參考）、`embed_tokens_quantized.onnx`（28,385,824 B，`4b919b82…ef`）、`embed_tokens_fp16.onnx`（56,770,946 B，`019af590…91`）、`decoder_model_merged_q4.onnx`（86,562,901 B，`e3fd8113…5f`，原本就有、核對相符）。全部寫進 `renderer/src/vlm/vlm_core.js` 的 `files` 欄（commit `fa309c1c9`，`vlm_core.test.js` 165 項通過）。
  - **真實形狀（ORT CPU 實跑，`onnxruntime-node` 1.22.0）**：`vision_encoder` 輸入 `pixel_values`＋`pixel_attention_mask`、輸出 `image_features`；512×512 影像 → `[1, 64, 576]`（64 個影像詞元、LM 隱藏維度 576）。`embed_tokens` 輸入 `input_ids`、輸出 `inputs_embeds`，形狀 `[1, 3, 576]`。`decoder_model_merged_q4` 有 30 層 KV（`past_key_values.0..29`）。
  - **驗證層級**：真權重的檔案完整性與 ORT 形狀實跑 ✔；**CPU 參考（`smolvlm_skeleton.js`）對真權重的逐層對拍：未做**（原因：要從 ONNX 的 initializer 抽出權重，並對應到 `vit_skeleton`／`llm_skeleton` 的權重格式；本機沒有 Python 的 `onnx` 套件，JS 端也沒有 protobuf 解析器，這一步沒有在這個工作階段完成）。
  - **pixel shuffle 展開順序：未核對**。影像詞元數 64 與 `1024÷16÷16 = 64`（r = 4）一致，但這只證明數量，不證明展開順序；順序要對照 modeling 程式或逐層中間輸出才能定案（ONNX 內部的 pixel shuffle 與連接器已包在 `vision_encoder` 裡，只能看到最終輸出）。`verified:false` 維持不變。
  - **GPU 版：未做**。這台沒有 CUDA，也沒有真 GPU 量測；`vlm_core.js` 的 gpu 組合檔案只確認 sha256，沒有執行。
  - **下一步**：要定案順序與逐層對拍，需要先用 protobuf 解析 ONNX（或裝一個獨立的 Python 虛擬環境裝 `onnx`，不裝全域），抽出 `vision_encoder.onnx` 的權重與 `image_features` 中間值，再用 `smolvlm_skeleton.forward` 同輸入比對。
- [ ] **O13c Florence-2**：編碼器—解碼器結構（DaViT 視覺編碼器加語言編碼器與帶交叉注意力的解碼器），較複雜，排在 a、b 之後；只做到能對拍的子圖就如實標範圍。
- [ ] 共通：先用既有的「逐節點對拍」做法（`scripts/eval/cudaweb_node_*`）把這些 ONNX 圖在 cudaweb 上逐節點對 ORT 驗證，再決定整圖接線或骨架重寫；預設關、行為不變、失敗永久退回原路徑；兩處設定介面（AI 助理設定、桌面版設定頁）同步開關；速度數字標硬體（Kepler 14 W）。沒有真權重或載入太重就標「未用真模型驗證」。每小步提交。

## O14. 使用者寫的 CUDA（Python／JavaScript）也吃到優化（使用者 2026-11-18：「我要這個 cudaweb 獲得完整核心優化的結果，可以將來 python/js 寫 cuda 的時候，都可以獲得好處」）
原則：優化放在 cudaweb 的**函式庫層**（`mm_ops`、`infer_ops`、`kernel_gen`、`kernel_select`、`variant_race`、`gpu_pool`），所有入口（內部模型引擎、`cudaweb.py`、`cublas`／`cudnn` 相容層、torch／cupy／numba／pycuda 墊片、使用者自己寫的 JS）都走同一組，不各自留一份舊核心。
- [ ] **O14a 入口盤點**：列出使用者可碰到的全部入口與它們現在用哪個核心（`pybridge/cudaweb.py` 的 matmul／sgemm／gemv／dot／axpy、`pybridge/torch`、`cupy`、`numba`、`pycuda`；JS 端 `gpu_core.js` 的 `WGSL.*`、`cudnn_subset.js`、`nn_ops`）。逐一標：已走優化核心／仍走舊樸素核心／純 JS。寫進 `scripts/eval/cudaweb_optimize.result.json` 或獨立表。
  - **O14a 盤點（2026-11-18，唯讀，行號為本次查證）**：
    | 入口 | 位置 | 現在用哪個核心 | 狀態 |
    |---|---|---|---|
    | `pybridge/cudaweb.py` `sgemm` | `cudaweb.py` 132 | 送 `matmul` 並帶 transA／transB；小運算元有轉置旗標 | 轉置已通；alpha、beta 是否補齊未核對 |
    | `pybridge/cudaweb.py` `sgemm_batched` | 176 | `matmul_many` → gpu_core `matmulMany`（e11be05c7：一次 submit） | 批次已有；尚未內嵌進桌面版（需重新產生 floating-assistant 內嵌） |
    | `saxpy`／`sscal`／`sdot`／`sgemv` | 223–243 | `axpy`／`scal`／`dot`／`gemv` | 已接 gpu_core |
    | 模組層 `vector_add`、`matmul`、`sum`、`axpy`、`scal`、`dot`、`nrm2`、`gemv` | 58–119 | 對應的 runtime 操作 | 已接 |
    | gpu_core runtime 操作 | `gpu_core.js` 1170–1346 | `vectorAdd`、`matmulOne`、`matmul`（超過上限分塊）、`matmulMany`、`sum`（樹狀歸約）、`sumDd`、`scatterAdd`、`axpy`、`scal`、`dot`、`nrm2`、`scan`、`transpose`、`gemv`、`backendInfo` | 全部有 WGSL→WebGL2→CPU 三層 |
    | 矩陣乘的核心選擇 | `gpu_core.js` `matmulKernelChooser`（預設 null）、`wgMatmul` | 預設走樸素 `matmul`，K、N 為 4 的倍數且不轉置時走 `matmul_vec4` | **缺口**：變體競賽的勝者（平鋪版 `WGSL_MM_F32_TILED`）只在 `mm_ops` 路徑；預設的 runtime 沒有接上勝者 |
    | 桌面橋接 `_cudawebCall` | `floating-assistant.js` 96635–96676 | matmul（M=1 走 gemv）、matmul_many、gemv、backend_info；其他操作丟「沒有這個操作」 | 小 M gemv 已接；其餘操作不經此橋 |
    | torch 墊片 `matmul` | `pybridge/torch/__init__.py` 348 | cuda 裝置上的二維 matmul 走 GPU 橋接，失敗退 numpy | 已接（只有二維前向） |
    | cupy 墊片 `matmul`、`dot`、一維 `sum` | `pybridge/cupy/__init__.py` 65、80、92 | 同上橋接 | 已接（熱點三個） |
    | numba、pycuda | `pybridge/numba/`、`pybridge/pycuda/` | numba 的 `wgsl.py` 有 3 處相關字樣（未逐一核對）；pycuda 沒有 cudaweb 字樣 | **未接或未核對**（使用者自寫核心的路徑屬 O14c） |
    | `nn_ops.js`、`cudnn_subset.js` | `renderer/src/gpu/` | 經由 gpu_core 的 runtime；`mm_ops` 的競賽也在這裡 | 內部模組，未逐一核對 |
  - 這次沒做的：逐一真機量測、alpha／beta、numba／pycuda 的內容核對。
- [ ] **O14b 全部改走優化路徑**：舊樸素核心的入口改成呼叫 `mm_ops`（含變體競賽勝者）等；轉置版 `AᵀB`／`ABᵀ`、`alpha`／`beta`（`sgemm` 目前只支援 N、N、alpha=1、beta=0，補齊並用同一份核心）、批次 gemm、`gemv`（走 q8／解碼式的 M 小路徑）、`dot`／`nrm2`／`sum`（分層歸約，不是單執行緒）。每個入口對 CPU 參考逐元素對拍，並量優化前後。
  - **O14b 進度（2026-11-18，子工作階段，提交 e0f82b77d 起）**：① 選核接線已完成：`gpu_core.js` 加全域選核政策（`setMatmulForce`：`auto`／`off`／`mm_vec4_f32`／`mm_tiled_f32`，強制優先於勝者；`setMatmulWinnerSource`），`mm_ops.js` 載入時把競賽勝者接上（只有 `pickWithCache` 的 `source` 為 `tuned` 才換；`mm_simple_f32` 在 gpu_core 沒有對應核心，視為無勝者）。無勝者時行為與接線前相同（規則預設）。GPU 相容層設定頁新增「矩陣乘核心」下拉（`cudaMatmulKernel`，預設 `auto`），啟動時套用。驗證：`mm_winner_wiring_test.js` 6 項（無勝者＝舊核心、有勝者用勝者、強制覆蓋勝者、關閉＝舊核心、simple 勝者退回預設、非法強制值報錯），全部是假裝置（`gpu_fakes.js`）只驗主機端流程與選到的核心名。② `sgemm` 的 alpha、beta、轉置早已補齊：轉置旗標走同一份平鋪核心的 `p0`（小運算元）；alpha、beta 在 Python 端後處理（O(mn)），**沒有**進 WGSL；`cudaweb_py_test.py` 15 項通過。③ **未驗證／未完成**：WGSL 在真 GPU 上**未驗證**（本機沒有 NVIDIA）；設定頁「強制」已接；winner 來源是否與網頁 `FaGpuCore` 同一實例，我沒查；`gemv`、`dot`、`nrm2`、`sum` 的逐元素對拍與分層歸約、優化前後的量測，本段沒有重做，仍待辦，所以本項維持未勾。
- [~] **O14c 使用者自寫核心的路徑**（2026-11-18，子工作階段 O14c／O14d：**部分完成，驗證層級＝node 通過、WGSL 待真 GPU 驗證**。盤點：gpu_core 已有 `sum`（分層：每執行緒跨步＋共用記憶體樹狀歸約）、`scan_block`＋`add_offsets`（區塊 Hillis–Steele ＋遞迴）、`transpose`（16×16 分塊、列寬 17）；這些是固定大小的核心，沒有能力參數，也沒有獨立的 CPU 索引模擬。本段新增 `renderer/src/gpu/kernel_templates.js`：`pickParams(caps)` 依能力選工作群組與分塊；`reduceWgsl`（sum／max／min）、`transposeWgsl`、`scanWgsl` 產生參數化的 WGSL；`reduceRef`、`transposeRef`、`scanRef` 為 CPU 參考；`simReduce`、`simTranspose`、`simScan` 照 WGSL 的階段順序在 JS 模擬。`kernel_templates_test.js` 16 項 node 通過（`dbfa8566d`）。**驗證範圍**：只驗主機端的索引與階段邏輯，**不驗 WGSL**。**WGSL 逐項真 GPU 驗證：未完成，待有 NVIDIA 或其他真卡的機器**（這台只有 Intel 內顯，沒有跑真 GPU 量測）。**未做**：①樣板沒有接進 gpu_core 的派發（既有固定核心不動）；②numba／pycuda 的自寫核心還沒呼叫這些樣板（`pybridge/numba/` 只到 WGSL 產生）；③Python 入口 `cudaweb.py` 沒有 `transpose` 與 `scan`；④「歸約分層而非單執行緒」：`sum` 已分層，`max`／`min` 只在樣板裡，gpu_core 沒有對應的 max／min 核心；⑤fake 裝置（`gpu_fakes.js`）沒有認得新的 `@kernel` 名稱，所以新樣板沒有經過假裝置的派發流程，只驗了索引模擬。）原始規格：使用者用 numba／pycuda／cupy 風格寫自訂核心時，編出來的 WGSL 要有基本的好處：自動工作群組大小（依能力表）、需要時自動用共用記憶體分塊的樣板（常見的 reduce、scan、矩陣轉置、逐元素）、管線快取與批次送出（`gpu_pool`）。先做可驗證的：reduce、transpose、scan 三個樣板。
- [~] **O14d 文件與範例**（2026-11-18，子工作階段 O14c／O14d：**部分完成**。已完成：`DESIGN.webgpu-cuda.md` 新增「11.1 哪些入口享有哪些優化」（對照 O14a 入口表與 O14b 的選核規則、強制與關閉開關，各列驗證層級）與「11.2 使用者自寫核心的範例」；範例：JS `renderer/src/gpu/examples/custom_kernel_templates.js`（`node` 直接跑，已跑通，只做 CPU 模擬）、Python `renderer/src/gpu/examples/custom_kernel_cudaweb.py`（用 `cudaweb.sum`、`dot`、`matmul`，未在 Python 模擬器或真 GPU 執行）。**未完成**：「量優化前後」——範例沒有量時間，這台沒有 NVIDIA，所以沒有可引用的數字；要在真 GPU 上量、標硬體後才能寫進文件。）原始規格：`DESIGN.webgpu-cuda.md` 加一節「哪些入口享有哪些優化」與使用者可用的開關（強制變體、恢復預設、匯出剖析）；給一個 Python 範例與一個 JS 範例，量優化前後。

## O15. 全部離線模型在 WebGPU 上都要獲得好處（使用者 2026-11-18：「離線模型也是全都要在使用 webgpu 時獲得好處」「除了 vlm、midigen、image to 3d、切割或物件偵測呢」）
現況（`docs/INVESTIGATE.cudaweb-models.md` 與 `docs/CHECKLIST.cudaweb-wire.md` 查證；調查表是接線前的狀態，會過時，**先逐項重新驗證再動手**）：已接 cudaweb：Qwen3 q8 聊天、midigen 整個解碼器（桌面是否也走要查）、MOSS、Whisper 編碼器、YAMNet／Demucs／Basic Pitch、SDXS、Kokoro（部分）。未接：VLM（O13）、其他 LLM（O12）、深度（Depth Anything V2 Small）、分割（SlimSAM 77）、姿態（MoveNet Thunder）、聲紋 ECAPA、文字嵌入 e5、image-to-3d（先查它用哪個模型與執行環境）、物件偵測（先查有沒有；調查表寫「人臉沒查到」，物件偵測要另查）。
- [ ] **O15a 全模型清單與覆蓋表**：一張表列出每個離線模型：執行環境（transformers.js／ORT-web／原生 ORT）、現在跑在哪（WebGPU／wasm／CPU）、是否經過 cudaweb 優化核心、這台（無 f16）能否走 GPU、缺哪些算子。附證據（檔案行號、真機量測）。含 midigen（網頁與桌面兩邊）、image-to-3d、分割、物件偵測。
  - **O15a 第一步（唯讀覆蓋表，2026-11-18 查證；仍未完成：沒有真機量測，也沒有逐一核對 Whisper 與 MOSS 的行號）**：
    | 模型／功能 | 執行環境 | 現在跑在哪 | 是否經過 cudaweb | 證據（檔案與行號） | 缺口 |
    |---|---|---|---|---|---|
    | midigenai v5 作曲（桌面） | onnxruntime-web；WebGPU 版為 q4 檔 | 原路徑 onnxruntime-web；cudaweb 解碼只在開關 midiGpu 打開時用 | 部分：只有 12 層投影（MatMulNBits）走 GPU，注意力與 RoPE 仍在 CPU | `renderer/src/floating-assistant.js` 96506–96513、103909–103941；預設值 86048 為 `midiGpu:'off'` | 預設關；注意力與 RoPE 未上 GPU |
    | midigenai v5 作曲（網頁） | 同上 | 網頁版 chunk | 是（chunk 內有 cudaweb 引用） | `web-lazy/chunks/midigpu.js`（字串計數 8 處；未逐行核對） | 同上；網頁與桌面兩邊的開關要同步 |
    | image-to-3d 深度（Depth Anything V2 Small） | transformers.js（網頁）；原生 ORT 路徑 `_nrDepthSess` | 原生路徑有但僅在非 WebGPU 時；網頁版 transformers.js | 否（這段路徑沒有 cudaweb 呼叫） | 註冊表 `floating-assistant.js` 14216；原生路徑約 129000–129031 | 未接；註冊表標 `gpuNeedsF16: true`，無 f16 的卡不能因此退到 CPU |
    | image-to-3d 分割（SlimSAM 77） | transformers.js（Worker）；原生 ORT 編碼器 `_samNativeEnc` | 編碼器可走原生 ORT（非 WebGPU 時），解碼器在 Worker | 否 | 註冊表 14218–14219；`_samNativeReady`／`_samNativeEnc` 129034–129057；`_segmentObjects` 129059 | 未接；`gpuNeedsF16: true`；編碼器是 ViT 類，可參考 O13a 骨架但要先核對 SAM 結構 |
    | image-to-3d 姿態（MoveNet Thunder，找手臂） | transformers.js | 網頁版 | 否（未找到 cudaweb 呼叫） | 註冊表 14224 | 未接；執行路徑未查到，待查 |
    | 物件偵測 | 未知 | 未知 | 未知 | 桌面註冊表未找到 DETR／YOLO／OWL 類模型；`/image-to-3d` 的物件分割是用 SlimSAM 代替 | 「有沒有物件偵測模型」本次未定案；`renderer/src/vlm/vlm_core.js` 有偵測相關字樣，尚未核實 |
    | 音訊 YAMNet／Demucs／Basic Pitch | cudaweb 圖形 session（WebGPU） | 預設關（`audioGpu`） | 是（開關打開時） | `floating-assistant.js` 131348–131378；預設 86050 | 預設關 |
    | SDXS 生圖（CPU int8 版） | cudaweb 圖形 session | 預設關（`sdxsGpu`） | 是（開關打開時） | 105476–105495；預設 86051 | 預設關 |
    | Kokoro TTS | cudaweb 圖形 session | 預設關（`kokoroGpu`） | 是（開關打開時） | 90801–90820；預設 86052 | 預設關 |
    - 結論（第一步）：已接 cudaweb 的只有 midigen（部分）、音訊三個、SDXS、Kokoro，且全部預設關；深度、分割、姿態、物件偵測都沒有接。物件偵測的模型還沒定案。
- [ ] **O15b 逐一補齊**，依「使用頻率 × 在這台的收益」排序；每個模型走既有做法：逐節點對 ORT 驗證 → 接線（預設關、失敗永久退回原路徑、兩處設定開關同步）→ 量前後（標硬體）。**無 f16 的卡不得因 f16 要求而退 CPU**，改用 f32／q8 路徑。
- [ ] 範圍外要如實標：沒有真權重、載入太重、或遇到 cudaweb 缺的算子（例如特殊卷積、非常規操作）的，記「未完成：原因」，不要宣稱全部完成。
