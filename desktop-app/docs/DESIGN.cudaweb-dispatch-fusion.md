# cudaweb 派發融合設計（dispatch fusion）

狀態：第一輪，**未完成**。本檔只含「派發清單」與「實測計數」，融合核心尚未實作、四規模 A/B 尚未量測，沒有任何時間數字。

## 1. 計數方法（實測，不是估計）

- 工具：`scratchpad/count_dispatch.js`（評估檔，不進產品）。用 `gpu_fakes` 假裝置跑一整步 `fullParamStepDevice`，讀 `batch.stats.dispatches`／`submits`。只數派發與提交次數，不計時。
- 這些是假裝置上的次數，與 GPU 實測無關；同一份程式碼的次數是確定的。
- 規模設定取自 `docs/PLAN.cudaweb-training-phases.md` 第 143–145 行（真實規模）：
  - S `V258 d32 L2 H4 kvH2 F64 T12`：**193 次派發**（提交 5 次含收尾、讀回 2 次）
  - M `V512 d128 L4 H8 kvH4 F256 T64`：**367 次派發**（提交 9 次、讀回 2 次）
  - L `V2048 d256 L4 H8 kvH4 F512 T128`：**367 次派發**（提交 9 次、讀回 2 次）
  - XL：計畫檔只給 T＝256，沒有給 d、L、H 等設定，**未計數**，不猜。需要管理者提供 XL 設定。
- 與管理者記錄的 HEAD b3c40758d 數字（S 193、M／L 367）完全相同，計數方法與設定對得上。提交次數的說法不同（管理者記 S 4 段、M／L 8 段），我的計數多 1 次是最後一次收尾提交，未細查。
- 前一版（102、351）是自訂小設定，作廢，不再引用。

## 2. 一步的派發清單（由程式碼逐行對照得出，已用真實 L 規模的計數 367 對帳）

每層（`L` 層）的前向（`full_param_step_device.js` 341–368 行）：

| 項目 | 次數／層 | 說明 |
|---|---|---|
| rmsnorm n1 | 1 | 列寬 d |
| matmul Wq、Wk、Wv | 3 | |
| qk-norm 的 q、k rmsnorm | 2 | qkNorm 時 |
| RoPE q、k | 2 | `rp` |
| transposeTH k | 1 | |
| attnFwdKt | 1 | 注意力核心（屬 cudaweb-train-backend，不動） |
| transposeTH v | 1 | |
| matmul Wo | 1 | |
| axpy 殘差 h1 | 1 | |
| rmsnorm n2 | 1 | |
| matmul Wg、Wu | 2 | |
| silu、mul | 2 | `a = silu(g)∘u` |
| matmul Wd | 1 | |
| axpy 殘差 | 1 | |

前向合計約 **22 次／層**。

每層的反向（369–410 行）約 **41 次／層**，包含 MLP 反向（da、dWd、mlpBwd、dWg、dWu、dg·Wg、du·Wu、axpy）、增益梯度（每個 `gainGrad` 是 rmsnorm＋mul＋matmul 共 3 次，每層 4 處共 12 次）、rmsnormBwd（每層 4 次）、attnBwdVt（3 次）、RoPE 反向（2 次）、Wo／Wq／Wk／Wv 梯度與 dn1 累加。

每步的固定部分：
- 嵌入查表 gather 1 次、交叉熵與頭部約 5 次、嵌入 scatter 1 次。
- **優化器（每個參數張量各 2 次）**：`sumsqSlot` 1 次＋`adamwCoef` 1 次，共 `2 × 參數張量數`。L 類有 46 個參數張量，所以這一段就有 92 次；加上 `sumslots` 與 `clipCoef` 2 次。這是目前最大、最容易合併的一塊。
- K＝1 時 `scal` 不派發（已在程式碼中省略）。

對帳（真實 L 設定，4 層）：4 × (22＋41) = 252；優化器 46 個參數張量 × 2 = 92，再加 sumslots、clipCoef 共 2；頭與嵌入約 21（gather、交叉熵、頭部、增益梯度、scatter）。合計 367，與實測 367 相同。頭與嵌入的細項 21 次尚未逐項核對，只是由總數推算。

## 3. 合併候選（每項「省幾次」都尚未量測）

1. **優化器的平方和與 AdamW 批次化**（最大項，每張量 2 次，L 類 92 次）。
   - 障礙：WebGPU 每個核心的 storage 綁定數有上限，不能一次綁 46 個張量。
   - 候選做法：把所有參數、梯度、動量、變異數合成四條扁平緩衝區（一次性配置），用偏移表。這是常駐狀態的大改，需要改 `makeResidentState`、`readResident`、`loadResident`，要另外對拍檢查點。
   - 未量。
2. **殘差加法＋rmsnorm 合併**：`axpy` 後接 `rmsnorm`（n2）是資料相依的，但可寫在同一核心內（先算 h1 再歸一化，h1 寫出一次）。每層可省 1 次，未量。
3. **增益梯度的 `gainGrad` 三次派發**（rmsnorm＋mul＋matmul）：可合成一個逐列歸約核心，輸出列加總。每個 gainGrad 可省 2 次，每層 4 處，共 8 次／層，未量。融合核心若寫成大核心要留意暫存器用量，要量。
4. **RoPE q、k 合併為一次派發**（同一個核心處理兩個輸入），每層省 1 次，未量。
5. **silu＋mul**：`a = silu(g)∘u` 可合成一次，每層省 1 次，未量。

資料相依、必須分開的：matmul 之間（前一個輸出是後一個輸入）、注意力前後的轉置、反向中 dq／dk 進 RoPE 反向與 qk-norm 反向的順序。

## 4. 提交策略（未量）

- 目前每層前向與反向各 `flush()` 一次。XL 每段約 16 次派發的設計是為了避免 Windows 顯卡逾時，不可放寬到超過約 300 ms。
- 批次建立的處理器成本：未量。要用 `gpu_async_queue` 或計時實測，不能估。

## 5. 還沒做的事（下一輪）

- [x] 用真實 S／M／L 規模設定重跑計數：193／367／367，與管理者記錄相同。
- [ ] XL 設定：向管理者索取 d、L、H、kvH、F、V（目前只知 T＝256）。
- [ ] 實作融合 1（優化器批次化）的評估版，放在評估檔，對拍 dense／gqa × fp64／f32 四個 fixture，梯度範數相對誤差 ≤1e-5、續訓逐位相同。
- [ ] 通過對拍後，才做四規模 A B A B 十步中位數（需先取得 `E:/Temp/fa-measure.lock`）。
- [ ] 逐項做融合 2 至 5，每項同樣流程。

## 6. 本輪沒有做的事與原因

- 沒有改任何產品檔（`full_param_step_device.js` 未動）。原因：融合 1 需要改常駐狀態布局，屬於大改，要先有對拍工具，這一輪來不及安全完成。
- 沒有取得量測鎖，沒有任何計時數字。
- 沒有編輯 `PLAN.cudaweb-training-phases.md`（依規定由管理者彙整）。
