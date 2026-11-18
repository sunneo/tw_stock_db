# 純 CPU GEMM 設計與量測（第一批）

狀態：第一批完成（分塊打包＋WASM SIMD 微核心＋交叉驗證＋單執行緒基準）。多核、變體競賽、接進 cpu_share／mm_ops、真機量測尚未完成，見「尚未做」。

## 目標

在沒有 WebGPU 的環境（或 GPU 被判定不可用時），讓純 CPU 矩陣相乘盡量快，且結果正確。量測依據：本機 Intel Core i5-2320（Sandy Bridge，有 AVX、沒有 FMA、沒有 AVX2），4 核、3.0 GHz，node 16.15。

## 結構（GotoBLAS 風格）

- 外層分塊：NC（列寬）、KC（沿 k）、MC（列高）；預設 NC=512、KC=256、MC=96，可由呼叫端覆寫（測試會變動這三個值）。
- 打包：A 的 MC×KC 區塊打成 MR=4 列的面板，B 的 KC×NC 區塊打成 NR=8 欄的面板；不足的邊界補 0。轉置在打包時處理（transA 讀 A[p·m+i]，transB 讀 B[j·k+p]），所以不需要整個矩陣轉置，也不改輸入。
- 微核心：4×8 累加器。JS 版用 double 累加，寫回 Float32 只做一次；SIMD 版用 f32x4，每列兩個 v128。
- SIMD：node 16 有 WASM SIMD。沒有編譯器（clang／wat2wasm 都沒有），所以 `cpu_gemm_wasm.js` 直接在 JS 組出 wasm 二進位，`WebAssembly.validate` 驗證後使用。乘與加分開（不用 relaxed-simd 的 fma，因為這台沒有 FMA，且 node 16 預設沒開 relaxed）。
- 面板直接放在 wasm 線性記憶體，微核心用位移呼叫，沒有每次呼叫的拷貝。

## 量測（單執行緒，GFLOP/s，取三次最小值）

| 核心 | 256³ | 512³ | 1024³ |
|---|---|---|---|
| 既有 cpuRowsRef（baseline） | 0.475 | 0.460 | 0.424 |
| packed（JS，double 累加） | 0.457 | 0.536 | 0.553 |
| packedSimd（WASM f32x4） | 6.490 | 7.354 | 7.520 |

誠實結論：
- 純 JS 分塊打包**沒有可量測的好處**（0.46–0.55 GFLOP/s，與既有相當）。另外試了 4×4 區域變數版本（scratch 實驗，不在 repo）也沒有好處（0.35–0.50）。JS 本身的純量吞吐在這台機器上大約卡在 0.5 GFLOP/s。
- SIMD 版約為既有的 15–16 倍。SSE 理論峰值約 24 GFLOP/s/核（3.0 GHz、每週期一乘一加、各 4 寬），目前約 30%。
- 「分塊」在 JS 版沒有帶來好處，主要收益來自 SIMD 微核心；分塊的效果要等 SIMD 版才看得出來（SIMD 版 1024³ 仍維持 7.5，沒有掉下去）。

## 精度

與朴素雙精度參考比對（`cpu_gemm_test.js`，81 項，全部通過）：
- JS 版最差相對誤差 3.07e-7。
- SIMD 版最差 3.97e-6（100×300×70，k=300）。誤差隨 k 變大，因為 f32 lane 累加；仍在 1e-5 門檻內，但 k 再大時會超過，這是已知限制。

## 轉置與記憶體

- 預設不修改輸入（測試以逐元素比對驗證）。
- 原地轉置（`inplace=True`）尚未實作：打包已經避免了轉置的需要，所以目前沒有使用情境。若之後要加，方正方陣用對稱交換、非方陣用循環跟隨，記憶體與時間取捨另寫。

## 尚未做

1. 多核：沿 M 分割到 Worker，有 SharedArrayBuffer 用零拷貝，否則拷貝。目前 cpu_share 的 Worker 仍跑舊的 cpuRowsRef，還沒換成 SIMD 核心。
2. 變體競賽：幾個 MC/KC/NC、微核心大小、SIMD 開關的變體，在本機量一次，勝者存 IndexedDB（以核心數與瀏覽器版本為鍵）。
3. 接進 cpu_share／mm_ops（目前只是獨立模組，應用程式沒有呼叫它）。
4. 真機量測：只跑純 CPU、一次，記錄 GFLOP/s。尚未進行。
5. 瀏覽器環境的 WASM SIMD 偵測與 Worker 內的 wasm 編譯，尚未在瀏覽器驗證。

## 檔案

- `renderer/src/gpu/cpu_gemm.js`：gemmPacked、gemmPackedSimd、gemmNaive、packA、packB
- `renderer/src/gpu/cpu_gemm_wasm.js`：wasm 二進位組裝、simdSupported、getKernel
- `renderer/src/gpu/cpu_gemm_test.js`：81 項交叉驗證
- `renderer/src/gpu/cpu_gemm_bench.js`：單執行緒基準

---

## 第二批（多核、變體競賽、接線、原地轉置、卸載交界點）

### 多核（cpu_gemm_rows.js）
- 沿 M 方向切成列區塊（每段列數為 MR 的倍數），每個工作者算自己的列區塊。
- 工作者內的核心 `gemmRowsSimdKernel` 自給自足（沒有外部參照），所以 `toString()` 可以放進 Blob Worker，與 cpu_share 的做法一致。
- 零複製：`SharedArrayBuffer` 可用時，A、B 複製一次進 SAB（這是唯一的複製），C 直接寫進共享的 SAB，不用回傳。SAB 不可用（瀏覽器未跨來源隔離）時退回 postMessage 拷貝。
- 工作者池是持久的，只建立一次；量測的是計算時間，不含啟動。

實測（node，1024³，4 邏輯核心 i5-2320，計算時間）：

| 工作者 | GFLOP/s | 加速比 |
|---|---|---|
| 1 | 6.56 | 1.00× |
| 2 | 11.5 | 1.75× |
| 4（第一次） | 17.7 | 2.7× |
| 4（第二次、第三次） | 8.1–8.6 | 1.25× |

4 工作者的結果不穩定（兩種模式），原因未查明。懷疑是背景負載使部分工作者拿不到實體核心，但沒有證實。這點必須在真機上再看，不能拿這個數字當穩定的加速比。

### 變體競賽（cpu_gemm_race.js）
- 候選 5 個：SIMD 四種分塊（MC/KC/NC）與純 JS 預設。微核心大小**未納入**，因為 SIMD 微核心只組了 4×8 一種。
- 每個變體取兩次最小值。勝者需比預設快 **5% 以上**（低於此視為量測雜訊），否則維持預設。非勝者標「有好處」（快 5% 以上但不是最快）或「沒有好處」。
- 鍵：`gemm-race|cores=<核心數>|browser=<瀏覽器名稱＋主版本>`，版本變了就重新競賽。
- 保存與讀回走注入的後端（`{get,set}`，可接 hetero_rates_idb 的後端）。失敗不拋錯，退回預設。
- 實測（node，1024³）：最快的 simd-96-384-512 只快 2.2%，低於門檻，所以維持預設 simd-96-256-512。SIMD 四種分塊之間**沒有可量測的好處**。純 JS 比 SIMD 慢約 14 倍，標「沒有好處」。

### 接線（cpu_share.js、mm_ops.js）
- `cpu_share` 的主執行緒路徑（`runCpuOnly`，cores=0）改用 `cpuKernel`：支援 SIMD 就用 `gemmPackedSimd`，否則退回 `cpuRowsRef`。
- Worker 原始碼改為包含 `gemmRowsSimdKernel`；每則訊息帶 wasm 位元組，Worker 有位元組就跑 SIMD，沒有就跑舊的 `cpuRowsRef`。
- `mm_ops` 的純 CPU 池路徑呼叫 `runCpuOnly`，所以自動使用新核心，`mm_ops.js` 不需要改。
- **Profile 的 CPU 量測**：`floating-assistant.js` 的 `_gpuProfileRun` 第 3 步呼叫 `sh.runCpuOnly`，所以 Profile 現在量的是**新核心**。舊核心的 0.46 GFLOP/s 結論已經失效，要重新量。
- 嵌入：`scripts/embed-code-ui.js` 加入 `cpu_gemm`、`cpu_gemm_wasm`、`cpu_gemm_rows`。
- 測試 `cpu_share_simd_test.js`：真的執行 `workerSource()` 產生的 Worker 原始碼（vm 沙箱），SIMD 與轉置 B 都與參考一致；沒有 wasm 時退回舊核心也正確。

### 原地轉置與轉置旗標（cpu_gemm.js）
- 預設：完全不改輸入。轉置旗標（transA、transB）在打包時處理，不整個矩陣轉置。
- `inplace: true`：才原地轉置呼叫端的陣列，然後用不轉置的核心算。這是**有記錄的副作用**，呼叫端的 A 或 B 會變成轉置後的內容。
- `transposeInPlace`：方陣兩兩交換（不需額外記憶體）；非方陣用循環跟隨，已搬位置以位元組陣列（約 N/8 位元組）記錄，時間 O(N)。

### 卸載交界點（cpu_gemm_offload.js，純函式）
- `offloadDecision({m,k,n,gpuReady,crossoverFlops})`：運算量 2·m·k·n 小於交界點走 CPU，否則走 GPU。
- 交界點來自 Profile 的實測（`faProfilePlan` 的 `crossoverFlops`）。沒有實測值時回到**維持 GPU**，不自己編門檻。
- 特殊值：`Infinity` 全走 CPU；0 或負數永遠走 GPU。

### 尚未做
1. 真機純 CPU 量測（只一次）：還沒跑。要在 Profile 或真實應用程式中跑，不能只靠 node。
2. 真機 GPU＋CPU 分攤量測（只一次）：還沒跑。
3. 變體競賽的勝者目前**沒有接進 cpu_share 的執行**：`cpu_share` 固定用預設分塊（96/256/512）。讀取保存的勝者並套用，還沒做。
4. 微核心大小的變體：需要組第二個 wasm 微核心（例如 8×8），還沒做。
5. 瀏覽器內的 IndexedDB 保存與讀回：只在 node 用記憶體後端測過，沒有在瀏覽器驗證。
6. SAB 在瀏覽器是否可用（跨來源隔離）：未驗證。目前應用程式大概率走拷貝路徑。

---

## 真機一次（第二批，兩次量測，各只跑一次）

環境：桌面版（真 Electron），獨立暫存資料夾，換埠，`FA_DISABLE_MAIN_OVERLAY=1`，不加 `--disable-gpu`。本機 4 邏輯核心，GPU 為 NVIDIA Kepler（adapter.info：vendor nvidia、architecture kepler）。

### 量測一：純 CPU（`scripts/eval/cpu-gemm-pure.eval.js`，完全不碰 GPU）
512³ f32，每設定暖機一次後取 3 次中位數：

| 設定 | 中位數 | GFLOP/s | 相對舊核心 |
|---|---|---|---|
| 舊核心 `cpuRowsRef`，單執行緒 | 500.3 ms | 0.54 | 1.00× |
| 新核心 `runCpuOnly`，主執行緒（cores=0） | 21.3 ms | 12.6 | 23.5× |
| 新核心，1 工作者 | 28.0 ms | 9.59 | 17.9× |
| 新核心，2 工作者 | 28.6 ms | 9.39 | 17.5× |
| 新核心，4 工作者 | 23.6 ms | 11.4 | 21.2× |

誠實結論：
- 單執行緒 SIMD 核心的收益是真的（約 23 倍）。
- **在 512³ 這個尺寸，工作者路徑比主執行緒慢**，沒有加速。這和節點量測（1024³ 有 1.75× 到 2.7×）不一致。目前的解釋是：每次呼叫都要把 B 與 A 的列區塊送進工作者（B 約 1 MB），在 512³ 這種小尺寸，傳送成本佔了計算時間的大部分。這是**推測**，沒有另外量證實。
- 量測中有偶發的高值（單次 46–74 ms），取中位數後排除。
- 結果與參考的最大相對誤差 2.0e-6。

### 量測二：GPU＋CPU 分攤（`scripts/eval/hetero-matmul.eval.js`，512³，中位數）

| 設定 | 中位數 |
|---|---|
| 只用 GPU（分攤關閉） | 18.7 ms |
| GPU＋CPU 分攤（`cpu_share`，4 工作者） | 17.6 ms |

- 加速比 **1.06×**（約 6%）。分攤版的每次執行都在 16.8–17.7 ms，只用 GPU 的在 17.8–22.4 ms。
- 分攤決策的 CPU 比例是 0.08（512 列中分給 CPU 40 列）。最後一次實測：GPU 段 19.7 ms、CPU 段 18.0 ms、總計 20.5 ms。
- 速率：GPU 約 1.17×10⁷、CPU 約 7.0×10⁵（flops/ms）。GPU 與 CPU 的速率比約 16.7 倍，與先前「約 14 倍」的估計接近。
- 這個 6% 的收益，與前面「分攤的上限約 7%」的結論相符。
- 誤差：分攤版與只用 GPU 版都是 2.0e-6。

### 這兩次量測對 Profile 的影響
- 純 CPU 的實測速率已經從 0.54 提高到約 12.6 GFLOP/s（主執行緒）。所以 Profile 的 CPU 速率、卸載交界點、分攤決策，都應該用新的數字重算。本次沒有跑 Profile 本身，所以沒有重新計算的結果。
- 分攤在這台機器上的收益仍然很小（約 6%），結論沒有因為 CPU 變快而改變，只是 CPU 分得的比例變小（0.08）。

### 未達成 / 限制
- 工作者在 512³ 沒有加速，原因未證實（上面的推測）。若要改善，需要量 1024³ 以上，或減少每次傳送的資料量。
- 這些是各跑一次的結果，沒有重複驗證。
