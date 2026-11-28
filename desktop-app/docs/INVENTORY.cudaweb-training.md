# cudaweb 訓練運算盤點（步驟 1）

日期：2026-11-28。唯讀盤點，未改任何程式。目的：列出 `llm_scratch.py` 的小型語言模型（密集、專家混合、推理架構）全參數訓練所需的每個運算，對照 cudaweb 現況，標出「有且已對拍」「有但未對拍」「沒有」。

依據檔案（皆已讀過）：
- `renderer/src/studio/backend_cudaweb.js`（整步路徑 `trainStepDevice`，否則 `lossAndGradsAsync` ＋ `adamStepAsync`）
- `renderer/src/studio/lora_ref_train.js`
- `renderer/src/gpu/nn_ops.js`（`trainerOps`：rmsnorm、softmax、silu、rope、adamw；`crossEntropy`）
- `renderer/src/gpu/train_step_device.js`（WGSL：attn_fwd、attn_bwd_kv、attn_bwd_q、rms_bwd、mlp_bwd、lora 反向）
- `renderer/src/studio/llm_scratch.py`（`build_model_classes`，行 168–320）
- `renderer/src/studio/model_types_core.js`

## 0. 關鍵結論（先看這個）

1. **現有 cudaweb 訓練器是 LoRA 專用，不是全參數訓練。** `lora_ref_train.js` 的 `makeModel` 只建 LoRA（q、k、v、o 四組 A／B）；`lossAndGradsAsync` 回傳的梯度只有 LoRA 的 A、B；基底權重 `Wq/Wk/Wv/Wo`、MLP、嵌入、RMSNorm 增益全部凍結。`train_step_device.js` 的 `r.loraBwd` 也只產生 dA、dB、dx。**要做全參數訓練，缺的是「基底線性層的 dW（權重梯度）、嵌入梯度、RMSNorm 增益梯度，以及對這些參數的 AdamW 更新」。** 這是第一個必須補的缺口。
2. **llm_scratch 的密集模型用的 MLP 是三個線性層（gate、up、down），不是 LoRA 掛在 q/k/v/o 上的結構。** cudaweb 的 MLP 只有 SiLU 閘門的反向（`mlp_bwd`），沒有 MLP 三個投影的前向與 dW。
3. **專家混合（MoE）完全沒有 cudaweb 運算**：路由器 softmax＋topk、稀疏 gather／index_add、專家 SwiGLU、負載平衡輔助損失，全部沒有。
4. **推理架構**與密集共用主幹，額外的是 `<think>` 區塊的資料格式與 GRPO（強化學習）。GRPO 的取樣與策略梯度在 llm_scratch 是 `sample_cached`＋CPU torch；cudaweb 沒有取樣路徑（`greedy_cached`／`sample_cached` 都沒接）。
5. **梯度裁剪（`clip_grad_norm_`）與 MoE 輔助損失** cudaweb 沒有。
6. 「全有或全無」（設計 §4f）目前**沒有實作**：`probe` 只看有沒有 WebGPU／WebGL2，不列缺哪些運算。見 §3。

## 1. 運算覆蓋表

圖例：**有＋對拍**＝有實作且有與參考比對的測試；**有未對拍**＝有實作，但在訓練路徑上沒有與 PyTorch 比對；**沒有**＝cudaweb 沒有實作。

### 1a. 前向（dense 密集模型，llm_scratch `Block`／`LM`）

| 運算（llm_scratch 位置） | cudaweb 現況 | 狀態 |
|---|---|---|
| 嵌入查表 `s.emb(ids)`（行 276、300） | `lossAndGradsAsync` 在 CPU 上以 JS 迴圈取列（`m.emb[inp[t]*d+i]`） | 有（CPU，不在 GPU） ／ 未對拍 |
| RMSNorm `RMSNorm.forward`（行 177） | `nn_ops.rmsnorm`（T1 WGSL → T3 WebGL2 → cpu-js 三層降級），`rmsFwdA` 呼叫 | 有未對拍（nn_ops 測試以 CPU 參考版為真值，不是 PyTorch） |
| QK-norm（q、k 各做一次 RMSNorm，dim=head_dim，行 249） | 同上，dim=hd | 有未對拍 |
| 線性層 `nn.Linear`（q、k、v、o、gate、up、down，行 237、187–188） | `cudawebMatmulBackend`（矩陣乘走 cudaweb 執行期）；LoRA 版 `loraLinManyA` 另加 A·B 低秩分支 | **LoRA 路徑：有未對拍。** 基底線性層（不掛 LoRA）的前向只在 LoRA 內部以 `W` 乘，等同有 |
| RoPE（行 250–251，`q*cos + rot_half(q)*sin`） | `nn_ops.rope`（dir=+1）；整步路徑 `trainStepDevice` 的 rope 是否在 GPU 上未查到 | 有未對拍 |
| 因果遮罩＋注意力分數 `QKᵀ`、softmax、`PV`（行 261–267） | `nn_ops.softmax`；整步路徑有 `WGSL_ATTN_FWD`（train_step_device.js） | 有未對拍（attn_fwd 只在整步路徑，且只與 `attnFwdRef`（f64 JS）比對，未與 PyTorch 比對） |
| 分組查詢注意力的 KV 複製（`expand`＋`reshape`，行 258–260） | 整步路徑未查到對應運算 | **沒有（未查到，需確認）** |
| SiLU 閘門 `F.silu(gate)*up`（行 190–191） | `nn_ops.silu`；整步路徑 `mlp_bwd` | 有未對拍 |
| 殘差加法（`x + o(y)`、`x + m`） | 矩陣與向量加法（`B.axpy`） | 有未對拍 |
| 輸出投影（LM head，權重共享 `emb.weight.t()`，行 313） | 同矩陣乘；權重共享需要嵌入梯度加總 | 有未對拍（但權重共享的梯度見 1c） |
| 交叉熵損失（`F.cross_entropy`，`cmd_pretrain`／`cmd_sft`） | `nn_ops.crossEntropy`（T1 WGSL → 參考版），回傳 `loss` 與 `dl`（已含反向的 softmax−onehot） | 有未對拍（與 `crossEntropyRef` 比，未與 PyTorch 比） |

### 1b. 前向（MoE，llm_scratch `MoE`，行 193–230）

| 運算 | cudaweb 現況 | 狀態 |
|---|---|---|
| 路由器線性層＋softmax（行 207） | softmax 有；路由線性層是矩陣乘 | 有未對拍 |
| `topk`＋重新正規化（行 208–209） | **沒有** | **沒有** |
| 稀疏權重 `sel`／`wmat`（行 210–211） | **沒有** | **沒有** |
| 專家 `wg`、`wu`、`wd` 的三維參數與逐專家矩陣乘（行 224） | **沒有**（只有單一 `W`） | **沒有** |
| `index_add`／`nonzero` 稀疏分派（行 218–225） | **沒有** | **沒有** |
| 匯出時的稠密計算（`dense_export`，行 213–215） | **沒有** | **沒有**（匯出走 ONNX，不在 cudaweb 範圍） |
| 負載平衡輔助損失 `aux`（行 226–228） | **沒有** | **沒有** |

### 1c. 反向（全參數訓練必需）

| 運算 | cudaweb 現況 | 狀態 |
|---|---|---|
| 交叉熵反向（`dl`） | `crossEntropy` 直接回傳 `dl` | 有未對拍 |
| LM head 反向：對 `x` 的梯度（`dl·emb`）與對 `emb` 的梯度（`dlᵀ·x`） | 矩陣乘的 transA／transB 變體（`ammAt`／`ammBt`）存在 | 有未對拍（**對 emb 的梯度沒接，因為 emb 是凍結的**） |
| RMSNorm 反向（對 x） | `rms_bwd`（`WGSL_RMS_BWD`，train_step_device.js） | 有未對拍（只與 `rmsBwdRef` f64 比對） |
| RMSNorm 增益（weight）的梯度 | **沒有**（JS 有 `rmsBwd` 但 dg 未算） | **沒有** |
| SiLU 閘門反向（dg、du） | `mlp_bwd`（WGSL_MLP_BWD） | 有未對拍 |
| 線性層反向 dX（`dY·Wᵀ`） | `ammBt`；整步路徑 `loraBwd` 只算 LoRA 的 dx | LoRA 有；**基底 `W` 的 dX 在 LoRA 路徑被算，但在整步路徑只回傳 LoRA 分支的 dx** — 需確認是否包含基底分支（未確認） |
| 線性層反向 dW（`Xᵀ·dY`，全參數需要） | `ammAt` 存在，但 backend 只對 LoRA 的 A、B 呼叫 | **沒有（對基底權重）** |
| 注意力反向（dQ、dK、dV） | `attn_bwd_q`、`attn_bwd_kv`（整步路徑） | 有未對拍（只與 `attnBwdRef` 比） |
| softmax 反向（注意力內） | 併在 `attn_bwd_*` 內 | 有未對拍（併在注意力內，無獨立運算） |
| RoPE 反向 | `nn_ops.rope` 帶 `dir=-1`（理論上正確） | 有未對拍（未確認 dir=-1 路徑有測試） |
| 嵌入反向（scatter-add 到 `emb` 的列） | **沒有**（只在 CPU 的 `m.emb` 讀，無寫回） | **沒有** |
| MoE 反向（路由、專家、`aux`） | **沒有** | **沒有** |
| 分組查詢注意力的反向（KV 複製的加總） | **沒有（未查到）** | **沒有** |

### 1d. 優化器與其他

| 運算 | cudaweb 現況 | 狀態 |
|---|---|---|
| AdamW（逐元素，任意一維陣列） | `nn_ops.adamw`（T1／T3／cpu-js 三層） | 有未對拍（與 `adamwRef` 比，未與 PyTorch 比）；**目前只用在 LoRA 參數上**，可直接套用到全參數 |
| 梯度範數與裁剪（`clip_grad_norm_`，行 cmd_pretrain） | **沒有** | **沒有** |
| 學習率排程（warmup＋cosine，CPU 純量） | 不需要 GPU | 不適用（CPU 即可） |
| 亂數（初始化、取樣） | 初始化在 JS（`makeRng`，xorshift），與 PyTorch 不同 | **不一致**（與 PyTorch 對拍時要共用初始權重，見步驟 3） |
| 檢查點（含優化器狀態） | `saveCheckpoint` 只存 LoRA 與 `t`，沒有 Adam 動量、沒有亂數狀態、沒有資料位置 | **不完整**（步驟 5 要補） |
| 取樣（`greedy_cached`、`sample_cached`，推理與 GRPO） | **沒有** | **沒有** |

## 2. 各型態在 cudaweb 上的可行性（依上表）

| 型態（llm_scratch） | 能否在 cudaweb 全參數訓練 | 缺什麼 |
|---|---|---|
| 密集（dense） | **不能**（目前） | 基底權重 dW、嵌入梯度與權重共享、RMSNorm 增益梯度、clip_grad_norm、全參數 AdamW 套用、檢查點補全 |
| 專家混合（moe） | **不能** | 上面全部，加上路由 topk、稀疏分派、專家矩陣乘、aux 損失及其反向 |
| 推理（reasoning，密集或 MoE 主幹） | **不能** | 同主幹缺口，加上取樣（sample_cached）與 GRPO 的策略梯度與獎勵計算 |
| 既有 LoRA 語言模型（`lora_ref_train.js`） | **能**（JS 訓練器、LoRA，有 WebGPU 與 WebGL2 層） | 無（但不是全參數） |

## 3. 全有或全無原則（設計 §4f）尚未實作的部分

- `probe` 目前只判斷有沒有 GPU 核心（`backend_cudaweb.js` 行 44–48），**不列缺哪些運算**。
- 按設計，應在 probe 時列出目標型態需要的全部運算，缺任何一個就回 `available:false` 並列出缺項（給 `model_types_core.js` 守門使用）。
- 本盤點的運算清單就是該檢查表的來源；尚未寫入程式碼。

## 4. 未查到／未確認（誠實列出）

- 整步路徑 `trainStepDevice` 的 RoPE 是否在 GPU 上執行（只確認 `nn_ops.rope` 存在）。
- `WGSL_ATTN_FWD` 是否支援分組查詢注意力（KV 頭數 ≠ 查詢頭數）：未讀完整 WGSL。
- 基底權重 `W` 在整步路徑的 dX 是否被算入（`loraBwd` 只回傳 LoRA 分支的 dx，需讀 `cudaweb_runtime.js` 的 `loraBwdMany` 確認）。
- `nn_ops` 的各運算與 PyTorch 是否逐位元或在門檻內一致：**全部未比對**，只與 CPU 參考版或 f64 JS 比對過。
- 本機的 WebGPU 可用性：本盤點未執行任何程式，未量測。

## 5. 下一步（不在本盤點範圍）

依設計與使用者指示，下一步應是：
1. 先補**基底權重 dW ＋ 嵌入梯度 ＋ RMSNorm 增益梯度 ＋ 全參數 AdamW**（密集模型），並與 PyTorch 逐步對拍（步驟 3）。
2. 之後補 clip_grad_norm 與檢查點完整化（步驟 5）。
3. MoE、取樣、GRPO 另列，不在第一階段。
