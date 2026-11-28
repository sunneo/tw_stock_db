# RoPE 慣例修正報告（2026-11-28，依使用者決定）

使用者決定（逐字）：「LoRA不一致的話，以效率為主，我們程式不可以有損壞的情形發生」。
選項 (a)：把 GPU 核心與 JS 訓練器的 RoPE 改成與推論一致的 rotate-half，改在核心裡改索引，不另加矩陣乘。

## 改動
- `renderer/src/gpu/nn_ops.js`：`ropeRef`、WGSL `rope`、WebGL2 `FS_ROPE` 全改 rotate-half（第 i 維與第 i+hd/2 維成一對）。版本常數 `ROPE_CONVENTION = 'rotate-half-v1'`。
- `renderer/src/gpu/full_param_step_device.js`：移除排列矩陣包裝與 `permD/permKd`（原本每次 RoPE 多 2 次矩陣乘），改直接呼叫核心。
- `renderer/src/studio/lora_ref_train.js`：JS 訓練器的 `rope` 改 rotate-half，匯出 `ROPE_CONVENTION`。
- `renderer/src/studio/full_param_train.js`：移除 cudaweb 介面的交錯↔半轉轉換（核心已是半轉）。
- `renderer/src/gpu/fused_ops.js`：融合 QKV RoPE 核心（無產品呼叫者，為避免留下不一致路徑一併改）。
- `renderer/src/studio/lora_graph_model.js`：ONNX LoRA 圖的 RoPE 矩陣改半轉（目前無產品呼叫者）。
- `renderer/src/studio/backend_cudaweb.js`：LoRA 檢查點存出時帶 `rope: 'rotate-half-v1'`；載入時缺標記或版本不同即拒絕，訊息說明要以目前版本重新訓練。常數與 lora_ref_train 相同，由 `rope_convention_test.js` 核對（不 require，因主行程扁平套件沒有 lora_ref_train.js）。

## 驗證
- PyTorch 真值（真 Electron 的 GPU 核心，`scripts/eval/rope_check_torch.py`）：三組形狀、正向與反向，對 rotate-half 最大絕對誤差 1.0e-7 到 3.4e-7；對交錯慣例誤差 0.92 到 2.16。結論：GPU 核心為 rotate-half。
- 單元測試：`nn_ops_test.js` 37/0（正交性測試改為半轉配對）、`rope_convention_test.js` 6/0（版本一致、與 llm_scratch 式公式逐元素一致、舊檢查點與其他版本被拒絕、目前版本可往返）、`lora_ref_train_async_test.js` 8/0、`backend_cudaweb_test.js` 8/0、`backend_cudaweb_devicestep_test.js` 5/0、`train_step_test.js` 3/0、`full_param_train.test.js` 全通過、`fused_ops_test.js` 11/0、`onnx_grad_core.test.js` 全通過。
- 期望值的變化：trainStepDevice 的損失數值會變（同設定、步 1 損失由 7.100106 變為 7.179705），因為位置編碼改了；既有測試都對 JS 參考比對，不是固定數值，所以期望值不需改，全部仍通過。

## 效率（真 Electron，同設定：V256 d128 L4 H8 F256 r8，T=64，25 步，中位數取第 6–25 步）
- 改前：中位數 93.8 ms／步（最小 86.7、最大 122.3）
- 改後：中位數 89.8 ms／步（最小 85.0、最大 114.0）
- 結論：沒有退步（略快，來自去掉排列矩陣乘）。

## 舊檢查點
- 舊的 cudaweb LoRA 檢查點（沒有 `rope` 標記、以交錯慣例訓練）不能再載入。要重新訓練，或在修正後以 rotate-half 版本重訓。
- 盤點：`backend_cudaweb.saveCheckpoint` 回傳的是 JS 物件，產品內目前沒有把它寫成磁碟檔的路徑；LoRA 套用（`lora_apply_core`）路徑未檢查此標記，已列為後續待辦（見 PLAN）。

## 不在範圍內（未改）
- 推論路徑：`qwen_decode.js`、`llm_skeleton*.js`、`llm_q8_onnx.js`、`moss_*`、`midi_*`、`attn_ops.js` 等各自的 RoPE 實作，本來就是各模型自己的慣例，未改。
