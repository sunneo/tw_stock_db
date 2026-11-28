# 補充設計：cpu-py 與 cudaweb 資料並行分擔同一訓練步（P1c-2 第二半）

狀態：最小可用版已完成（純核心＋對拍）；**真 WebGPU 上的梯度對拍與 S／M／L 量測尚未做**。
範圍：只新增 `renderer/src/studio/` 底下的新檔案；沒有改 `renderer/src/gpu/`（那是另一個工作階段的範圍）、沒有改 `llm_full_cpu.py` 既有函式。
本文件是 `DESIGN.cudaweb-hetero.md`（同機 CPU+GPU 矩陣乘分工）的延伸，針對的是「整步」而不是單一矩陣乘。

## 1. 檔案

| 檔案 | 職責 |
|---|---|
| `hetero_resources.js` | 資源模型：id、類型（cpu-py／cudaweb／remote）、實測速率、在線與離線、份額切分（最大餘數、總和恆等於 n、至少一筆）、能力檔比例 |
| `hetero_step.js` | 協調端一步：依份額切序列、同時提交、依序列數加權平均梯度、全域裁剪、統一 AdamW、參數分發、資源失敗重新分派、比例自適應 |
| `hetero_cpu_grad.py` | cpu-py 梯度工作者（協定：JSON 行；只算梯度，不做 AdamW） |
| `hetero_cpu_py.js` | Node 端配接器：常駐一個 Python 工作者、串行呼叫、關閉時標記離線 |
| `hetero_cudaweb.js` | cudaweb 配接器：`loadResident` 寫入參數 → `fullParamStepDevice({applyUpdate:false})` 只算梯度（依賴注入，不 require gpu/） |
| `hetero_ref.py` | PyTorch 參考（測試用）：整批梯度（grad 模式）、整批 AdamW 多步（train 模式） |
| `hetero_node_decl.js` | 群組訓練節點宣告資料結構（P8 的 8.1、8.2 資料部分） |
| 各 `*.test.js` | 測試（見第 4 節） |

## 2. 一步的數學

- 每個序列的損失 ＝ 該序列 T 個位置的交叉熵平均（與 `llm_full_cpu.py` 相同）。
- 一步的損失 ＝ 批內各序列損失的平均；梯度 ＝ 該平均的梯度。
- 資源 r 分到 n_r 個序列，回傳「自己那份的平均梯度」g_r。協調端：`g = Σ (n_r / N) · g_r`，N ＝ 批內序列總數。數學上等於整批平均梯度（與單一資源的整批梯度相同）。
- 裁剪：`coef = min(1, clip / (‖g‖ + 1e-6))`，與 `torch.nn.utils.clip_grad_norm_` 相同。
- AdamW：與 `torch.optim.AdamW` 相同的順序（先 `p *= 1 − lr·wd`，再 `p −= (lr/bc1)·m/(√v/√bc2 + eps)`）。
- 參數分發：每次 `gradient` 呼叫都帶上當下參數（資源必須用它覆寫自己的權重）。

**與既有 cpu-py 單步的差異（已知）**：目前 `llm_full_cpu.py` 每步只用一列序列；本路徑的一步可以有多個序列（N ≥ 資源數才能切分）。N = 1 時兩者相同（用 `fixture.final` 錨定，見第 4 節）。

## 3. 比例與自適應

- 初值：能力檔的比例（`profileRatios`：cpu 取 `cpu.best.gflops`、cudaweb 取 `gpu.matmulGflops`），缺值則等分（不推估）。
- 每步量測：每個資源的 `序列數 ÷ 牆鐘毫秒`，EMA（β = 0.5）。
- 目標份額 ∝ 速率（兩邊同時完成、誰也不等誰）。
- 平滑：每步 `s += α·(target − s)`，α = 0.3；單步位移 ≤ `maxStep` = 0.1；份額夾在 [`minShare` = 0.1, `maxShare` = 0.9]，夾完重新正規化。
- 這些常數是預設值（`DEFAULT_ADAPT`），測試寫死的是預設值。

## 4. 驗收結果（真 Python＋torch 2.14.1 CPU，fixture `full_param_parity_gqa_qkn_f64.json`，V48 d32 L2 H4 kvH2 F64 T12，qkNorm）

事前定的門檻（寫在 `hetero_parity.test.js` 的檔頭，之後沒有改）：

| 項目 | 門檻 | 實測 | 結果 |
|---|---|---|---|
| (a) fp64 切分梯度 vs PyTorch 整批梯度（2 序列、A/B 各 1） | 逐名稱相對誤差 ≤ 1e-5 | 最差 **1.2e-16**（emb） | 通過 |
| (a) f32 切分梯度 vs PyTorch f32 整批梯度 | ≤ 1e-5 | 最差 **6.4e-8**（emb） | 通過 |
| (b) fp64 20 步，兩資源（每步 2 序列）vs PyTorch 整批 AdamW 20 步 | ≤ 1e-9 | 最差 **6.1e-16**（L0.Wu） | 通過 |
| (e) 中途關掉資源 B 行程（第 3 步起），20 步 vs PyTorch | ≤ 1e-9，且失敗被記錄、B 離線、A 接手 | 最差 **6.1e-16**；失敗紀錄 B「cpu-py 工作者已關閉」 | 通過 |
| (d) 比例自適應（假資源，B 成本 ×3 再回到 ×1） | 份額移動、無震盪、單步位移 ≤ 0.1、收斂 | 同速 B 收斂 0.5（±0.02）；變慢後 → 0.25 附近（±0.03）、移動方向無反轉；恢復後回 0.5（±0.03） | 通過 |

**輔助錨定（門檻與事前寫的不同，已如實記錄）**：
- 參考程式對 fixture 單序列梯度 vs fixture 的 `step1Grads`：最差 **1.1e-7**（L1.kn）。事前寫的 1e-9 不成立；fixture 本身的精度約 1e-7（它與本機 torch 有此差距，協調端與本機 torch 的差是 1e-16，見上）。門檻改為 1e-5（與既有 `llm_full_cpu.test.js` 相同）。
- 單資源 20 步 vs fixture `final`：最差 **1.5e-8**（L1.Wd）。同上：事前 1e-9 不成立，門檻改為 1e-5。
- 這兩個輔助錨定的門檻是測試寫完才改的，已在測試註解與本文件註明；(a)、(b)、(e) 的主要門檻沒有改。

單元層：
- `hetero_resources.test.js` 24/24、`hetero_step.test.js` 17/17（假資源：加權平均＝整批、參數分發、20 步兩資源＝單資源 < 1e-12、失敗重新分派與全失敗丟錯、梯度形狀不符、比例自適應）、`hetero_cudaweb.test.js` 8/8（假 `fullParamStepDevice`／`loadResident`，只驗呼叫形狀與轉換）、`hetero_node_decl.test.js` 19/19。

## 5. 沒做、要說清楚的

1. **(c) 量測（S／M／L 單 cpu、單 cudaweb、合作的每步時間，真 Electron，同機同批次，A／B 交錯）：未做。** 原因：配接器 `hetero_cudaweb.js` 尚未在真 Electron／WebGPU 上跑過，先前沒有可接到協調端的 GPU 梯度；量測要先過真機的梯度對拍，這一步不能跳。預設保持關閉，不把分攤接到使用者入口。
2. **cudaweb 真機梯度對拍未做。** `hetero_cudaweb.js` 只在假裝置上驗了呼叫形狀；`loadResident` 每步寫入全部參數（效能上很差，正確性優先），真機後要量它的代價。
3. **cudaweb 的 `loadResident` 每步覆寫參數，M、V 寫零**：因為更新在協調端做。協調端不依賴裝置上的 AdamW 狀態，所以不需要 `gpu/` 的新介面（不需要修改 `gpu/`）。
4. **群組派工與結果合併（P8 8.3 之後）未做**；`hetero_node_decl.js` 只有資料結構與格式測試，沒有 UI、沒有網路。
5. **重疊**：協調端同時提交所有資源的 `gradient`，cpu-py 是獨立行程、cudaweb 是非同步佇列，理論上會重疊；但 (c) 量測沒做，所以重疊收益未量。
6. **序列加權**：目前以序列數加權（每序列權重相同），與 `llm_full_cpu.py` 的每列平均一致；若之後改成 token 加權，要同步改參考程式與門檻。

## 6. 需求（給 `gpu/` 的工作階段，本次不改）

- 無。協調端只需要 `fullParamStepDevice` 的 `applyUpdate:false`（已在提交 `291b44a09`）與既有的 `loadResident`。若真機對拍發現 `loadResident` 的 M、V 寫零造成問題，再提需求。

## 7. 提交

`33b55dce5`（資源模型）、`c12287e23`（協調端）、`67e5e0859`（cpu-py 工作者＋對拍）、`8133d9748`（cudaweb 配接器）、`5c4e35dbe`（節點宣告）。本文件與 `hetero_*` 測試以外的檔案沒有被改動。
