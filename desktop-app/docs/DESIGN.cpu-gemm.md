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

---

## 第三批：修正上一次真機分攤的缺陷（分到的 CPU 比例太小）

### 先前的說法更正
上一節寫「分攤 1.06× 與分攤上限約 7% 的結論相符」是**錯的**。那個 7% 是用舊核心（約 0.5 GFLOP/s）算的。新核心主執行緒是 12.6 GFLOP/s，GPU 端到端約 11.7 GFLOP/s，兩邊量級相同，理論最佳分攤應接近各半。

### 原因查證（不是單純的舊快取）
上一次真機是**全新的暫存資料夾**，速率是那次執行中現場量的，不是舊快取。實際上 CPU 段慢的主因是**工作者路徑的每次呼叫固定成本**：
- 每次呼叫都重新 `new WebAssembly.Module(bytes)`。節點量測：40 列時工作者 31 ms、主執行緒 4.5 ms。
- 修正（工作者內快取編譯後的模組與實例，以位元組長度與總和為鍵）後：40 列時工作者 **6.8 ms**，主執行緒 4.5 ms。
- 同時 `decideSplit` 的 CPU 速率是從「含這段固定成本」的分段時間量出來的，所以速率被壓低，CPU 比例自然小。

### 修正內容
1. **速率快取的鍵含 CPU 核心版本**：`hetero_rates.rateKey` 加入 `kernel` 欄位（`cpu_share.CPU_KERNEL_ID = 'cpu-simd-pack4x8-v2'`），前綴改為 `v2`。核心換了，舊速率讀不到（自動作廢）。測試：`cpu_kernel_rate_key_test.js`。
2. **決策用假裝置驗證**：`cpu_share_new_rates_test.js`。新速率（GPU 1.17e7、CPU 1.26e7 flops/ms）→ 切分，比例 0.500（上限），預測省 48%，與平衡點掃描的最佳差距 −0.18%。舊速率（0.70e6）→ 全給 GPU。
3. **工作者門檻**：`cpu_share.cpuPathFor` 純函式，運算量 2·m·k·n 小於 `MIN_WORKER_FLOPS = 2·768³` 只用主執行緒（`runCpuOnly` 與分攤的 CPU 段都套用）。依據：512³ 工作者慢於主執行緒（真機 9.6／9.4／11.4 vs 12.6）；1024³ 工作者有加速（節點 1.75× 到 2.7×）。門檻是兩點之間的估計，**之後要用真機再校正**。測試：`cpu_share_threshold_test.js`。
4. **Profile 的誤報修正**：`runCpuOnly` 在門檻下回傳 `info.threshold = true`，Profile 的量測不再把它誤判成「CPU 池建不起來」而降成 1 核。
5. **Profile 白話結論**：`scripts/gpu_profile_new_rates.test.js` 用新速率餵 `faProfilePlan`：結論改為「大的運算讓 CPU 與 GPU 一起算有收益：512x512x512 約讓 CPU 分擔 50%，預估省約 48% 時間」；舊速率對照則是「全給 GPU」。`gpu_profile_plan.test.js`、`gpu_compat_view.test.js` 全綠（只改資料來源，沒有重寫）。

### 真機重跑：**被阻擋，尚未完成**
- 修正後的真機 GPU＋CPU 分攤（一次）**嘗試啟動時被自動模式分類器拒絕**（權限拒絕，沒有給理由）。
- 依規定沒有以其他方式繞過。這一項**還沒有真機數字**，上面的決策結論是假裝置與用新速率算出來的，不是實測。
- 需要使用者決定：允許後再跑同一個 `scripts/eval/hetero-matmul.eval.js`（獨立暫存資料夾、埠 17993、互斥鎖），或改由使用者在桌面版按 Profile 按鈕量測。

### 節點量測（不是真機）的參考
- 工作者 40 列：31 ms → 6.8 ms（快取編譯後）。
- 工作者與主執行緒在 512³：主執行緒仍快（36 vs 39 ms，節點）。

- 第一次真機（修正後的程式，有效）：提交 5a32a74d2 的建置與 HEAD 相同。512³，只用 GPU 中位數 17.8 ms，分攤 17.9 ms，加速 0.99。分攤時 CPU 40 列（比例 0.08），CPU 段 15.3 ms（約 1.4 GFLOP/s）。速率 CPU 1.07e6、GPU 7.76e6 flops/ms。（以上數字為同一台機器的另一個 session 所量，這裡照記，不是本 session 的量測。）
- 落差：純核心在主執行緒量到 12.6 GFLOP/s，40 列應約 1.7 ms，實測 CPU 段 15.3 ms，多出約 9 倍。多出來的是傳遞、排程或等待成本，速率 EMA 把它吃進去，所以決策只給 CPU 8%。來源待查（見下一節）。

---

## 第四批：CPU 段比核心多出的落差（來源查證與修正）

### 機制（假裝置重現）
`cpu_share.run()` 原本用「提交 CPU 段的時刻 → CPU 段完成」當 CPU 段耗時。GPU 段的 `gpuFn` 是**同步**在主執行緒上執行的：它的提交工作（上傳、編碼、送出）會先占住主執行緒，CPU 段排在它後面才開始，這段同步時間就被算進 CPU 段。

重現（`cpu_share_breakdown_test.js`，假 Worker 跑真的 Worker 原始碼，GPU 段同步占用 12 ms）：
- 量到的 GPU 同步成本 `gpuSyncMs` = 11.4 ms（與設定的 12 ms 相符）。
- CPU 段自己的執行時間 `cpuOwnMs`：無占用 20.7 ms、占用 22.6 ms，差 1.9 ms。也就是 GPU 同步**沒有**算進 CPU 段自己的時間。
- 牆鐘時間 `cpuMs`（修正前的量法）則會隨同步成本一起增加。

### 為什麼比例會被壓到 8%
三個因素疊在一起：
1. `ratioNow` 的決策用 `gpuOverheadMs: 0`，GPU 的固定同步成本完全沒進模型。
2. 回饋（`feedbackFraction`）用的是牆鐘 CPU 段時間。被同步成本撐大的 CPU 段會讓回饋把比例往下修。
3. 回饋只會往下修（`min(d.fraction, fbFrac)`），不會往上補。

所以即使核心本身夠快，只要 GPU 同步成本大，CPU 的比例就會一路往下掉到 8%。

### 修正
- `run()`：量 GPU 提交的同步成本（`gpuSyncMs`，包住 `gpuFn` 的回傳時間），量 CPU 段自己的執行時間（`cpuOwnMs`，佇列執行器內）。
- 回饋與 CPU 速率改用 `cpuOwnMs`；GPU 速率仍用 GPU 段的牆鐘時間（它本來就包含提交成本）。
- `goMs`：`gpuSyncMs` 的 EMA，放進 `decideSplit` 的 `gpuOverheadMs`（GPU 有固定成本時，CPU 應該多分擔，而不是少分擔）。
- `stats()` 新增 `goMs`；`last` 新增 `gpuSyncMs`、`cpuOwnMs`。
- 評估模式（`createCpuShare({profile: true})`）：`stats().cpuBreak` 累加主執行緒 CPU 核心的分段計時（打包 B、打包 A、計算、呼叫次數、重用的 B 區塊數、牆鐘）。

### 40 列呼叫的固定成本（節點量測）
- 40 列（512×512 的 B）完整呼叫約 4.8 ms，其中打包整個 B 約 2.5 ms。這是每次呼叫都要付的固定成本，所以 40 列遠高於「核心計算 1.7 ms」的理想值。
- 修正：`gemmPackedSimd` 加上 **opt-in** 的 B 打包快取（`cacheB: true`，以 B 物件為鍵；呼叫端承諾呼叫之間不改動 B）。同樣 40 列降到約 3.8 ms；第二次呼叫重用 4 個區塊。
- `cpu_share` 在有 `bKey` 時才開啟快取（與既有的 Worker B 快取同一份契約）。

### 還沒證實的
- 真機上 CPU 段 15.3 ms 與 1.7 ms 之間的差距，有多少來自 GPU 同步（已有機制與重現）、有多少來自每次呼叫的打包與拼接（節點量到約 1–2 ms）。需要真機的 `cpuBreak` 與 `gpuSyncMs` 才能分開。
- 回饋仍然只會往下修（沒有對稱的往上補）。這一點如果真機仍然偏低，要再改。
- `cpu_share_breakdown_test.js` 的第三項（CPU 列數）兩次都撞到上限 0.5，所以它只證明「不會變少」，沒有證明會變多。

---

## 第五批：各尺寸真機（對方 session 所量，照記）、整個運算卸載、CPU 段工作者模式、精度修正

### 各尺寸真機（Kepler＋i5-2320 4 核，各尺寸獨立啟動，中位數 ms）
這些數字是另一個 session 量的（`E:/Temp/hetero-sizes/results.txt`），這裡照記，不是本 session 的量測。

| N | 只用 GPU | 分攤 | 加速 | CPU 列數 |
|---|---|---|---|---|
| 32 | 13.8 | 11.9 | 1.16 | 0 |
| 64 | 12.8 | 12.5 | 1.02 | 0 |
| 128 | 11.9 | 12.3 | 0.97 | 0 |
| 256 | 13.8 | 13.6 | 1.01 | 0 |
| 512 | 17.9 | 17.0 | 1.05 | 40 |
| 768 | 29.5 | 30.5 | 0.97 | 61 |
| 1024 | 49.2 | 47.6 | 1.03 | 81 |

- N≤256：只用 GPU 固定約 12–14 ms，即使 32³ 也是。這是 GPU 的固定成本，與運算量無關。
- **推算（沒有量）**：以新核心 12.6 GFLOP/s 推算，N 約 420 以下整個運算走 CPU 主執行緒會比 GPU 快（32³ 約 0.01 ms，對 13.8 ms）。這只是推算，要用真機驗證。
- N≥512：分攤沒有好處。觀察到的 CPU 段速率只有 1.2／2.3／3.4 GFLOP/s（核心本身 12.6），GPU 段在分攤時也變慢（512：分攤 22.3 ms、只用 GPU 17.9 ms）。推測是主執行緒被 CPU 段占住、GPU 提交與回讀回呼被延後。

### 整個運算卸載給 CPU（接進 mm_ops 的決策）
- `mm_ops.matmul`：f32、單一批次、非轉置 A，且 `offloadDecision`（`cpu_gemm_offload.js`）判定 `cpu` 時，整個運算走 `runCpuOnly`（SIMD，主執行緒）。結果 `lastKernel = 'offload-cpu'`。
- 交界點**不寫死**：來自 Profile 實測的 `crossoverFlops`，存在 `localStorage` 的 `fa_gpu_profile`。Profile 存檔時同時呼叫 `mm.setOffloadCrossover`。
- Profile 的 `crossoverFlops` 為 `Infinity` 時（CPU 各種大小都不輸），JSON 存不下，所以另存 `crossoverAllCpu: true`，讀回時還原為 `Infinity`。沒有這個旗標，全 CPU 的情況會被誤判為「沒有實測」。
- 沒有實測（null）就不卸載，維持原路徑。
- 測試：`mm_offload_test.js`（交界點無限大、null、邊界 32³/64³、轉置 A 不卸載、轉置 B 卸載結果正確）。
- 評估檔（一次對照，**尚未執行**）：`scripts/eval/offload-small.eval.js`，比較交界點 0（只用 GPU）與 Infinity（卸載），每個 N 各 5 次中位數。

### CPU 段工作者模式（N≥512 的互相拖慢）
- `run(..., { cpuSegment: 'worker' })`：強制分攤的 CPU 段走工作者，不占主執行緒。預設 `auto` 維持原行為（依門檻，小段走主執行緒）。
- `mm_ops.matmul` 把 `o.cpuSegment` 傳進分攤。
- 測試：`cpu_share_segment_test.js`（`worker` 模式主執行緒核心呼叫 0 次；`auto` 模式小段走主執行緒；兩者結果都正確）。
- **是否恢復 GPU 段時間還沒量**，要用真機比較 `cpuSegment: 'worker'` 與預設。

### 精度修正（重要）
- 量測發現：SIMD 核心在 K=512 的最大相對誤差 **1.26e-5**，超過 1e-5 門檻。JS 核心為 4.9e-7。
- 原因：f32 微核心在每個 KC 區塊內做 f32 累加，區塊越長誤差越大。把跨區塊累加改為 f64 **沒有**改善（誤差在區塊內，不在區塊之間）。
- 修正：預設 `KC` 改為 64。K=512 的誤差降為 6.5e-6（KC=128 反而是 1.49e-5，所以不是單調的；選 64 是實測結果）。代價：速度約降 20%（6.6 → 5.4 GFLOP/s，單核，1024 尺寸附近）。
- 變體競賽的候選全部改成 KC=64（否則競賽會因為速度選到 KC=256 或 384，把精度問題帶回來）。
- 回歸測試：`cpu_gemm_accuracy_test.js`（256×512×512 與 512³，JS 與 SIMD 都要 ≤ 1e-5）。

### 數字的界線（照實寫）
- 本批的 CPU 核心速度與精度，是節點量測與假裝置。真機的 CPU 段時間、GPU 段時間、以及整個運算卸載的對照，都還沒有在真機上量。
- 「N 約 420 以下卸載」是推算，不是量測結果；實際交界點由 Profile 的實測決定。

---

## 第六批：卸載在桌面版靜默失效的修正，以及一次真機對照（一次，使用者在對話中允許）

### 失效原因（已重現）
`cpu_gemm_offload` 沒有進嵌入清單（`scripts/embed-code-ui.js`）。桌面版的 `mm_ops` 在 require 它時失敗，而 `mm_ops` 用 `try/catch` 把錯誤吞掉，所以卸載在桌面版被靜默關掉。直接 `require` 的單元測試模組解析正常，所以之前全綠卻沒抓到。

修正：
- 加進嵌入清單。
- `mm_ops.getOffloadStatus()` 暴露載入狀態（loaded、error、crossover、cpuShareLoaded），載入失敗看得見。
- `embed_real_path_test.js`：(1) 所有 require 都在嵌入清單；(2) 用只認嵌入清單的 require 載入 `mm_ops`，走真實呼叫路徑（`cacheB:true`、Float32Array、單批次），確認 `lastKernel` 為 `offload-cpu`。修正前紅，修正後綠。

### 真機對照（`scripts/eval/offload-small.eval.js`，一次，每個尺寸 5 次中位數）
只用 GPU 的那一欄是交界點設為 0（永不卸載）；卸載欄是交界點設為 Infinity（強制卸載）。`offloadStatus.loaded` 為 true。

| N | 只用 GPU（ms） | 卸載給 CPU（ms） | 加速 | 誤差（卸載） |
|---|---|---|---|---|
| 32 | 12.1 | 0.2 | 60.5× | 7.7e-7 |
| 128 | 12.8 | 1.0 | 12.8× | 6.3e-7 |
| 256 | 13.7 | 4.9 | 2.8× | 7.7e-7 |
| 512 | 20.8 | 27.9 | 0.75× | 7.7e-7 |

- 卸載在 N≤256 明顯快於 GPU（GPU 固定成本約 12–14 ms）。512 卸載反而慢（0.75×）。
- **Profile 的交界點與這次量測不一致**：Profile 存的 `crossoverFlops` 為 1.18e7（約 N=180）。但 256 的運算量（約 3.4e7）高於這個交界點，實測卸載仍快 2.8 倍。也就是 Profile 的交界點偏低，CPU 較有利的範圍比它說的大。原因未查明，可能是 Profile 的 CPU 或 GPU 擬合點不夠（它的 CPU 點用的是舊的或較小的形狀）。
- 512 的對照是強制卸載。實際決策路徑在 512 會因為交界點而走 GPU，所以 0.75× 不代表實際行為的損失。
- 誤差在所有尺寸都在 1e-5 以內（最大 1.25e-6 出現在 GPU 路徑的 256）。

### 下一步（未做）
- 用這次的量測重算交界點（現在 Profile 的擬合點看起來偏保守），而不是沿用 1.18e7。
- 這次的數字是單次中位數，沒有重複；要當成定論前應再量一次。
