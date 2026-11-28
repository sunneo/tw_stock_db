# RoPE 慣例查證（2026-11-28）：cudaweb GPU 核心是交錯，基礎模型與推論是 rotate-half

## 證據（真值是 PyTorch，不是 JS 參考）
- 測試：`scripts/eval/gen_rope_check_eval.js` 產生評估檔，在 Electron 真機執行 `nn_ops` 的 GPU RoPE 核心（`createBatch().rope`，`trainStepDevice` 與 `full_param_step_device` 也用它），把輸出原樣回傳；`scripts/eval/rope_check_torch.py` 用 PyTorch 逐元素比對。
- 比對對象：慣例 A（交錯成對，第 2i 與 2i+1 維）與慣例 B（rotate-half：`llm_scratch.py` 行 180–182 的 `rot_half` 與行 279–284 的 `cos_t`／`sin_t`；HF Qwen3 的 `rotate_half`）。
- 結果（最大絕對誤差，三組形狀，正向與反向）：

| 形狀 T,H,hd | GPU+1 對交錯 | GPU+1 對半轉 | GPU−1 對交錯 | GPU−1 對半轉 |
|---|---|---|---|---|
| 4,2,8 | 1.4e-7 | 1.97 | 1.6e-7 | 1.71 |
| 6,4,16 | 3.5e-7 | 2.16 | 3.7e-7 | 1.75 |
| 3,1,8 | 1.2e-7 | 0.92 | 1.1e-7 | 0.98 |

- 結論：GPU 核心**確實是交錯慣例**（誤差在 f32 捨入等級），與 rotate-half 不同（誤差約 1–2）。

## 影響範圍
1. **cudaweb LoRA 訓練（GPU）**：`trainStepDevice` 用 `B.rope`（交錯）。以它訓練出的 LoRA，位置編碼與基礎模型不同。
2. **cudaweb LoRA 訓練（JS）**：`lora_ref_train.js` 的 `rope()` 也是交錯（已讀原始碼確認，pair＝2i、2i+1），同樣受影響。
3. **推論**：`qwen_decode.js` 的檔頭寫明 RoPE 是 rotate-half（Qwen），`llm_scratch` 匯出的 ONNX 與標準格式也是 rotate-half。因此，用上面兩條路徑訓練出的 LoRA 疊到推論用的基礎模型上，位置編碼不一致，會傷害品質（不會崩潰，所以不易察覺）。
4. **全參數路徑（`full_param_step_device`、`full_param_train.js`）**：已用 0/1 排列矩陣轉成 rotate-half，不受影響（對 PyTorch fp64 已通過）。
5. **已存在的 cudaweb LoRA 檢查點**：應視為以錯誤慣例訓練，不能直接用於推論基礎模型（需重新訓練，或在修正後以 rotate-half 重訓）。

## 未做（本次只查證）
- 不修改產品路徑（依領導指示：修不修由領導與使用者決定）。
- 修法的選項（供決定）：(a) `nn_ops.rope` 與 `trainStepDevice` 改 rotate-half（改核心，影響所有已訓練 LoRA）；(b) 在 LoRA 路徑用與 `full_param_step_device` 相同的排列包裝（不改核心，數值等價於 rotate-half）；(c) 保留交錯並在推論端轉換（不建議，推論端已是 rotate-half）。
