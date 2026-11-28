# 設計：cudaweb 訓練步矩陣乘（matmul_vec4／_ta／_tb）優化

狀態：**進行中，尚無計時數字，尚無產品程式變更，未提交。**

## 一、已確認的事實（讀程式得出，非量測）

核心位置：
- `renderer/src/gpu/nn_ops.js:1038`　`MM_VEC4_CODE = core.mmTileWgslVec4({ marker: 'matmul_vec4' })`（不轉置、K、N 為 4 的倍數）
- `renderer/src/gpu/nn_ops.js:1041`　`MM_VEC4T_CODE`，由 `mm_geom.js` 的 `mmVec4TWgsl` 產生，旗標 1＝transA（`matmul_vec4_ta`）、2＝transB（`matmul_vec4_tb`）、3＝兩者（`matmul_vec4_tt`）。只在 M、K、N 都是 4 的倍數時用（`MMG.mmVec4TOk`），否則退回純量平鋪 `MM_TILED_CODE`。
- 選核邏輯：`nn_ops.js:1132-1135`（`v4`、`v4t`、退回平鋪）。
- `gpu_core.js:137`　`mmTileVec4Ok` 只允許不轉置（`flags == 0`）；`gpu_core.js:221` 的 `mmR8Ok` 為另一個分支。

## 二、訓練步實際用到的矩陣乘形狀（符號化，維度待 S／M／L／XL 配置代入）

記號：`matmul(A, B, M, K, N, flags)`，A 為 M×K（transA 時為 K×M），B 為 K×N（transB 時為 N×K）。T＝序列長度，d＝隱藏維度，F＝FFN 寬，V＝詞表，rr＝LoRA 秩。

LoRA 路徑（`train_step_device.js`）：
| 行 | 形狀 | 旗標 | 說明 |
|---|---|---|---|
| 357 | (T, din, rr) | 無 | xA |
| 358 | (T, din, dout) | 無 | 基底（可能 f16） |
| 359 | (T, rr, dout) | 無 | 低秩分支 |
| 364 | (rr, T, dout) | transA | dB（transA） |
| 365 | (T, dout, rr) | transB | dxA（transB） |
| 366 | (din, T, rr) | transA | dA（transA） |
| 367 | (T, dout, din) | transB | dx（transB） |
| 368 | (T, rr, din) | transB | dx2（transB） |

全參數路徑（`full_param_step_device.js`）另有：
- 前向：(T,d,d)×3 QKV、(T,d,d) Wo、(T,d,F)×2 gate/up、(T,F,d) down
- 反向：transA 的權重梯度 (d,T,d)、(d,T,F)、(F,T,d)；transB 的輸入梯度 (T,d,F)、(T,F,d)、(T,d,d)
- 輸出頭：(T,d,V) transB 前向；(T,V,d) 反向；transA (V,T,d)（`emb` 梯度）

每步呼叫次數：每個 Transformer 區塊重複一次（層數 = 配置的 layers），頭部各一次。**確切次數與 L、XL 的 T、d、F、V 數值尚未從配置檔代入，待實測前補上。**

## 三、已知限制（阻擋計時）

1. 計時必須在真 WebGPU 環境執行（Chrome 或 Electron 頁面）。Node 環境沒有真 WebGPU 介面卡，只有假裝置（`gpu_fakes.js`），不能產生效能數字。
2. 量測前要取量測鎖（`E:/Temp/fa-measure.lock`），目前沒有人持有。本次尚未取鎖，也尚未執行任何計時。
3. 既有評估頁（`scripts/eval/cudaweb_train_browser.js`、`mm_correct.eval.js` 等）需由 HTTP 服務載入，本 session 尚未確認能否啟動。
4. 這台 GT 720（Kepler）過去出現過驅動逾時與裝置遺失（見 CHECKLIST.cudaweb-optimize.md 的 O1／O2 紀錄），計時前後必須先確認裝置可用。

## 四、下一步（尚未做）

1. 取量測鎖，用 `cudaweb_train_browser.js` 或等價頁面，逐形狀量 matmul 耗時（時間戳或派發前後計時，標明方法），換算 GFLOPS，對照 2048³ 天花板 100.0 GFLOPS。
2. 找出差距最大的形狀，依序驗證假設（瓦片、暫存器分塊、bank 衝突、K 展開、邊界、工作組數）。每個假設先寫預測再實測。
3. 通過對拍（dense／gqa × fp64／f32，梯度範數相對誤差 ≤1e-5，續訓逐位相同）與四規模交錯 A/B（A B A B，十步中位數）才進產品檔；沒通過的只留在評估檔。
4. 提交只用明確檔案路徑，不發布、不推送、不合併。

## 五、不得外推的紀錄

本檔目前沒有任何效能數字。管理者提供的 L 規模 30.8 ms／步、XL 294.6 ms／步、天花板 100.0 GFLOPS、XL 等效 79.3 GFLOPS 為上游紀錄（HEAD b3c40758d），本 session 尚未在目前版本重新量測確認。

## 六、整步時間基線（2026-11-29，HEAD cf36ee32e，真 Electron WebGPU，GPU 鎖）

量測：`scripts/eval/gen_step_bench_eval.js` 產生的評估檔，`scratchpad/mm/run_step_bench.js` 啟動（不加 --disable-gpu），12 步，前 5 步暖機，取其後中位數（每步時間為 fullParamStepDevice 回傳的 ms）。裝置：NVIDIA Kepler（GT 720），timestamp-query 與 subgroups 功能可用。

| 規模 | 中位數 ms／步 | 最小 | 最大 |
|---|---|---|---|
| S | 13.9 | 13.8 | 15.0 |
| M | 26.9 | 25.9 | 28.1 |
| L | 93.7 | 93.1 | 95.2 |
| XL | 未量 | | |

注意：這是整步時間，不是矩陣乘單獨時間。逐形狀時間戳量測與 XL 基線尚未做（XL 可能觸發裝置遺失，待單獨取鎖執行）。上游紀錄的 L 矩陣乘合計 30.8 ms 仍未在本版重測。

## 七、共用記憶體位元組數與驗證錯誤（2026-11-29，依 attn 通知）

依程式碼宣告計算（f32 為 4 位元組）：
| 變體 | 位置 | As | Bs | 合計位元組 | 是否超過預設 16384 |
|---|---|---|---|---|---|
| matmul（平鋪，mmTileWgsl） | gpu_core.js:69–70 | 64×16 | 16×64 | 8192 | 否 |
| matmul_vec4（mmTileWgslVec4） | gpu_core.js:153–154 | 64×16 | 16×64 | 8192 | 否 |
| matmul_vec4_ta／_tb／_tt（mmVec4TWgsl） | mm_geom.js:147–148 | 1024 | 1024 | 8192 | 否 |
| mmPipeWgsl（休眠，未接產品） | mm_geom.js:206–207 | 1152 | 1024 | 8704 | 否 |

結論：產品用的三個變體在預設 16384 位元組的裝置上都能跑；`mmGeomWgsl` 的大小由參數決定，目前未接產品，不列入。

待辦：
- 評估與對拍要用 `pushErrorScope('validation')` 包住派發，對任何錯誤判失敗。`scripts/eval/gen_step_bench_eval.js` 目前沒有這個包裝，上面 S／M／L 的基線因此不能排除派發被拒絕的可能，需要重跑並補上檢查後才能作為正式基線。
- 矩陣乘核心的 limits 選擇（依 `device.limits` 在執行時選變體）等 attn 通知 nn_ops.js 那幾行的改動，我同意後再動。
