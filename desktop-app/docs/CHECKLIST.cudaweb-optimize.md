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
- [ ] **O1m. 記憶體空間變體**：在 `kernel_select.js` 的變體裡加「資料放哪裡」這個維度（storage／uniform／貼圖／共用記憶體暫存），並先做三個具體的：(a) 解碼用 q8mm／MatMulNBits／lm_head 的輸入向量 x 與縮放值放 uniform（分段綁定，x 是 K 個值，Qwen3-0.6B 的 K=1024 約 4 KiB，放得下）；(b) 矩陣乘的 B（權重）放 `rgba32float` 貼圖（平鋪核心用 `textureLoad` 讀 4 個值）；(c) rope 表、偏置放 uniform。每個變體：能力不足不選、node 假裝置測試、真 Chrome 對拍、同機計時（標硬體）。驗收：真 Chrome 同一張卡上每個變體逐元素一致；計時結果寫進 `cudaweb_optimize.result.json`，並寫明這台（Kepler 14 W）上哪個放法勝出、勝多少（沒有勝出就如實寫「沒有好處」，不要硬選）。
- [x] **O1. 能力探測與變體選擇器**（2026-11-17 完成：`renderer/src/gpu/kernel_select.js` 與 `kernel_select_test.js` 9 項通過；驗收為 node 測試，已滿足。目前變體表只列已實作的 matmul、q8mm；O4、O3、O5 加核心時要同步加進表。infer_ops 的 `q8mmVariant` 仍是獨立判斷，測試確認與選擇器一致，尚未改為呼叫選擇器。）：`renderer/src/gpu/kernel_select.js`（新）：`probeCaps(adapter, device)` → 能力表（上面列的 limits／features／語言功能，探不到的給保守預設）；`pickVariant(op, shape, caps, overrides)` → `{ id, tile, regBlock, useF16, useSubgroup, ... }`；覆蓋表可強制變體（測試與使用者用）。所有核心變體必須宣告「需要的能力」，能力不足的變體不會被選到。驗收：node 測試涵蓋三種假能力表（低／中／高）與強制覆蓋；低階一定回傳簡單或平鋪 f32 變體。
- [x] **O2. q8mm 優化（Qwen 解碼主力）**（2026-11-17 完成：`q8mm_dec`（M 任意、256 執行緒、共用記憶體 5 KiB）與 `q8mm_pf`（64×64 平鋪＋4×4 暫存器，共用記憶體 5 KiB）；`q8mmVariant` 選擇：N%4≠0 → simple，M<64 → dec，M≥64 → pf；真 Chrome（Kepler 14 W，`scripts/eval/q8mm_check.html`）12 個形狀全部與 q8mmRef 逐位相同（maxAbsDiff 0）；純核心時間每次派發：M=8 simple 5.7 ms／dec 0.8 ms；M=64 simple 44.3 ms／dec 5.8 ms／pf 4.1 ms；M=1 K1024 N1024 simple 0.78／dec 0.15 ms。pf 在 M=1、8 比 dec 慢，所以門檻設 64；（2026-11-17 補量：M=32 dec 2.985 ms 對 pf 4.13 ms，dec 仍快；M=64 起 pf 勝出，門檻 64 正確。）**未完成的部分**：端到端含上傳讀回約 12 ms（overhead 主導，要靠 O6 批次才看得出差別）；裝置後來因 simple 在 M=256 的 20 次派發超過 Windows GPU 逾時而丟失，之後 Chrome 的 WebGPU 介面卡回傳空值，M=256 與 pf 的覆蓋量測已於 2026-11-17 GPU 恢復後補做，見 `scripts/eval/cudaweb_optimize.result.json`。）：兩個變體：(a) 解碼用（M ≤ 8）：一個工作群組負責一小段輸出欄、沿 K 切給多個執行緒、一次讀整個 u32（4 個權重）、有 `packed_4x8_integer_dot_product` 時用 `dot4I8Packed`／`dot4U8Packed`、否則手動展開；工作群組內歸約。(b) 預填用（M 大）：平鋪＋暫存器分塊。驗收：真 Chrome 對現有 `q8mmRef` 逐元素一致（整數累加，必須逐位相同）；同機計時 8 個詞元解碼的 q8mm 部分，標硬體；低階路徑不需要點積功能也能跑。
- [x] **O3. MatMulNBits 優化**（2026-11-17 完成：解碼 `matmulnbits_dec`（M≤8）與預填 `matmulnbits_pf`（M>8，16×16 塊、128 k 分塊，共用 9.25 KiB）；真 Chrome 三個變體所有形狀 T1、相對誤差 ≤1.3e-6；端到端計時 M=8 dec 17.2 ms 對 pf 19.3 ms，M=16 起 pf 勝（17.9 對 20.2），門檻與實測一致；結果寫在 result.json。純核心計時尚未量，端到端被上傳蓋過一部分。｜早先的紀錄：真 Chrome 已驗證解碼變體：6 個形狀全部 T1、相對誤差 ≤3.2e-7；M1 K1024 N3072 dec 15.4 ms 對逐格版 23.6 ms（牆鐘，只標這台）。仍未完成：預填平鋪變體。｜以下為原始說明：解碼變體 `matmulnbits_dec` 寫好（256 執行緒、16 欄×16 條 lane、A 的 256 個 k 搬進共用記憶體、縮放值每字一次、歸約經共用記憶體，共用 2 KiB）；M≤8 走它。node：索引數學的 JS 模擬與參考版相對誤差 ≤1e-5（五個形狀），假裝置走 T1，`matmulnbits_dec_test.js` 9 項通過。**未完成**：①預填（M 大）平鋪變體，目前 M>8 仍走逐格版；②真 Chrome 驗證待介面卡恢復，驗證頁 `scripts/eval/matmulnbits_dec_check.html`（讀 `window.__out`，cases 的 `pass` 全 true）；③計時「比現況快」尚未量。）：反量化搬到區塊層級（每 32 個權重一個縮放值，讀一次）、一個工作群組處理多個輸出欄、每個執行緒一次處理 8 個 nibble（一個 u32）；解碼（M 小）與預填（M 大）兩個變體。驗收：真 Chrome 對 `matmulnbits_ref` 相對誤差 ≤1e-5（f32 累加）；同機計時比現況快（標硬體）。
- [x] **O4. 注意力優化**（2026-11-17 真 Chrome 已驗證：`attn_flash_check.html` 6 個形狀全部 T1、相對誤差 ≤1.1e-6；解碼 S=1 past512 H16 Hkv8 hd128 flash 20.3 ms 對 attn 158.5 ms；預填 S=16 flash 12.8 ms 對 attn 18.0 ms（牆鐘含讀回，只標這台）。結果在 `scripts/eval/cudaweb_optimize.result.json`。｜以下為原始說明：2026-11-17：`attn_gpu.js` 新增 `attn_flash`（分塊線上 softmax，64 執行緒、共用記憶體 sc 1 KiB，預填與解碼共用；hd 須為 64 的倍數且 ≤512，否則保底 `attn`）；`flashRef` 的 JS 版與 `attnCore` 在五個形狀（含 GQA、past>0、跨 256 邊界、hd 128/256）相對誤差 ≤1e-5；假裝置走 T1。`attn_flash_test.js` 9 項通過。**真機驗證待做**：desktop-app 資料夾 `python -m http.server <埠>`，Chrome 開 `scripts/eval/attn_flash_check.html`，讀 `window.__out`，判準 cases 的 `pass` 全為 true 且 `time` 標硬體。）：解碼（S=1）：一個工作群組負責一個（頭），群組內執行緒分攤「鍵」維度做線上 softmax（一遍：最大值與分母一起更新）、再分攤 hd 做加權和，工作群組歸約；預填（S 大）：每個（詞元, 頭）一個群組、鍵維度平鋪、線上 softmax。分數只算一遍。驗收：真 Chrome 對 `attn_ops` 參考相對誤差 ≤1e-5，涵蓋 GQA（Hkv<H）、past>0、S=1 與 S>1；同機計時（標硬體）。
- [ ] **O5. 矩陣乘再優化＋共用**：`gpu_core.js` 的 `WGSL.matmul`（numba／cupy／torch 相容層與訓練步用）改用 `mm_ops` 的平鋪核心（抽成共用模組，兩邊 import 同一份）；加 f16 變體（需要 `shader-f16`，儲存 f16、累加 f32）與 vec4 載入變體；依 O1 的選擇器選。轉置版（訓練的反向：`AᵀB`、`ABᵀ`）用同一份核心的索引參數，不另寫一份。驗收：真 Chrome 各形狀（含非平鋪倍數、批次、窄、轉置）對 CPU 參考相對誤差 ≤1e-6（f32）／≤1e-3（f16）；強制每個變體都跑一遍（同一張卡上用覆蓋表模擬各級）。
- [ ] **O6. 執行模型：指令批次與緩衝區池**（進度 2026-11-17：node 部分完成，`renderer/src/gpu/gpu_pool.js`（池＋管線快取）接進 `nn_ops.createBatch`；讀回用池的暫存緩衝區；`gpu_pool_test.js` 7 項、`nn_ops_test.js` 36 項通過。**未完成**：真 Chrome 跑一層 Qwen 區塊的 submit 計次與逐位比對（待 WebGPU 介面卡恢復，驗證指令見 O10）；`createBatch` 目前只涵蓋 rmsnorm、softmax、silu、rope，matmul 還沒進批次。）：`nn_ops.runWgsl` 之上加「一個 submit 跑一串運算」的批次介面（一層 Transformer 的運算編進同一個 command encoder，中間結果留在 GPU，最後才讀回）；暫存緩衝區池（依大小分桶、用完歸還，不每次 createBuffer／destroy）；讀回改用環狀暫存（不每次建立 MAP_READ 緩衝區）；`Float32Array.from` 不必要的複製全部去掉。驗收：node 假裝置測試涵蓋批次與池（歸還、重用、上限）；真 Chrome 跑一層 Qwen 區塊，submit 次數從每運算一次降到每層一次（計次證據），結果與原本逐位相同。
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
