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
