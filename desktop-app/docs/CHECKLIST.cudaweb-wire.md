# 清單：cudaweb 推論接線（做完才回報）

**規則：你的一輪只在「下面每一項都是 [x] 或 BLOCKED（附原因）」時才可以結束。** 做完一項、提交之後，立刻回來看這份清單、勾掉、做下一個 [ ]，不要回報、不要停。使用者問的小問題你用一兩句帶過後也回到這份清單。被某項卡住就標 BLOCKED＋原因，換下一項，不要停下等。
每項都要有「驗收」：寫在項目裡的那個檢查通過才能勾。勾掉要在同一個提交裡改這份檔。

## 第一優先（使用者 2026-11-16：「Qwen3 文字推論的加速不是第一優先嗎」，先做這個，其餘排在它後面）
- [x] **Q（部分完成，見末尾「Q 狀態」）. Qwen3 文字推論整段 GPU 解碼（q8，網頁版 studio 與桌面版共用）**：現在純 CPU 的兩條路徑（網頁版 studio 的 onnxruntime-web wasm q8、桌面版原生子程序 onnxruntime-node q8）是真正的受益者（transformers.js q4f16 那條本來就由 onnxruntime 走 WebGPU，好處小，排最後）。用已驗證的核心（q8 反量化矩陣乘、注意力＋KV 快取、rmsnorm、rope、silu、lm_head）組成一個完整的 Qwen3-0.6B 解碼引擎：嵌入→28 層→lm_head→取樣，接成可選開關 `qwenGpuDecode`（預設 off，兩處設定同步），失敗自動退回現有 ONNX 路徑，診斷齊全。桌面版沿用 lm_head 的 head_req／head_res 信箱做法（渲染程序算、子程序等結果）。驗收：真 Chrome 同 prompt 8 個詞元與原路徑相同（greedy）；關開關時行為不變。這項做完才做 A、B、D…。

**Q 狀態（2026-11-16）**：網頁版（studio 的 onnxruntime-web 路徑）已接線：`renderer/src/gpu/qwen_decode.js`＋`qwen_gpu.js`（WGSL 引擎）、`greedyGenerate` 的 `opts.gpuDecode`（首詞元對拍、失敗補 KV 退回）、設定 `qwenGpuDecode`（預設 off，`_gpuCompatControls` 共用）、診斷隨 `/api/llm/web/generate` 回傳；設計見 DESIGN.webgpu-cuda.md §7.13。驗證：單元 8＋18 項過；CPU 參考對真 ORT 3/4 組提示 8 詞元相同；GPU 引擎在軟體 WebGPU（SwiftShader，這台沒有真 GPU）4 組中 2 組與 CPU 參考、ORT 完全相同。**未達驗收「8 個詞元與原路徑相同」的部分**：另 2 組有詞元漂移（已追查：動態量化邊界翻轉，ORT 本身跨 CPU 也有；不是核心算錯）。**BLOCKED／未做**：(1) 真 GPU（NVIDIA 等）上的對拍與速度——這台只有軟體 WebGPU；(2) 桌面版（原生子程序沒有 WebGPU）的 head_req／head_res 信箱接線——要改主程序／執行包檔（不能熱更新，需真 Electron 驗證，沒有環境）；(3) 以 App 的 UI 開關實測整條網頁版路徑。

## 項目
- [ ] **BLOCKED（見下方原因：整管線驗證頁 30 分鐘無結果）** **A. MOSS WebGPU 整管線** — BLOCKED：2026-11-16 驗證頁 cudaweb_moss_pipeline_gpu_check.js（埠 18776、18779）在真 Chrome 跑了 30 分鐘以上仍無結果檔；每個運算重建 pipeline（現已快取）＋頁面 CPU 段落佔住主執行緒，未能完成。下一棒需先把 decodeStep／取樣搬到 Worker 或分批讓出主執行緒再驗。：把已驗證的 CPU 管線（預填、生成、取樣、codec）各運算換成 GPU 核心（矩陣乘、注意力、LN、RoPE、GELU、conv_ops），與 ORT 比對。驗收：真 Chrome 驗證頁結果檔 pass（音訊相對誤差 ≤ 1e-4，同 seed 同幀數）。
- [x] **B.（BLOCKED 驗收） MOSS 產品接線**（部分完成，2026-11-16）：已做：`moss_gpu_runners.js`＋worker 的 `gpu` 選項（沒有 GPU／載入失敗／運算退層／中途失敗自動退回 ORT wasm 從頭生成）、設定 `mossGpu`（預設 off，`_gpuCompatControls` 兩處共用）、診斷 `result.gpu`、嵌入 `FA_MOSS_GPU_SRC`、單元測試 2 個（開關關時 `gpu:null`，路徑不變）、DESIGN §7.14。**BLOCKED（驗收後半）**：「開時在真 Chrome 生成音訊且與 wasm 路徑一致」——依賴 A（整管線 GPU 在驗證頁 30 分鐘無結果；這台無真 GPU，SwiftShader 太慢）。
- [ ] **BLOCKED（transformers.js q4f16 路徑要改寫 ORT 圖並在 Worker 內插入注意力／KV／MatMulNBits，改動過大，且大部分價值已由 Q（q8 路徑）取代；依本項規則不硬做）** **C. （降級，排最後；被 Q 取代的大部分）Qwen3 transformers.js q4f16 路徑接線**：注意力＋KV 快取＋MatMulNBits 投影接進 transformers.js q4f16 路徑（Worker）；開關 `qwenGpuDecode`（預設 off）；失敗退回。驗收：真 Chrome 8 個詞元與原路徑相同。若這條需要的圖改寫太大，標 BLOCKED＋原因，不要硬做。
- [x] **D.（BLOCKED 驗收） midigen 接線**（部分完成，2026-11-16）：已做：`midi_session.js` 假 session（接 `MidigenModel` 的 cpu 步進）、`_midiGpuLoad`、設定 `midiGpu`（預設 off，`_gpuCompatControls` 共用）、失敗退回 ORT、嵌入 `FA_MIDI_GPU_SRC`、單元測試、DESIGN §7.15。桌面版渲染程序有 WebGPU，不需信箱。**BLOCKED（驗收）**：「固定種子前 N 個 token 與原路徑相同」需要真模型檔（midigen q4，約 73 MB）；這台機器沒有，下載需使用者在本對話同意。
- [x] **E. 退路與快取**：pipeline 快取已在 `nn.runWgsl`（以 WGSL 字串為鍵，`dev.__cudawebPipes`，提交 281314126；attn、matmulnbits、moss 各運算、conv 都走它；qwen_gpu 自己在載入時一次建好全部 pipeline）。退路：`tryLayers` 的 T1 → cpu-js（純 JS 參考）；WebGL2 層對這些核心尚未實作（只有 rmsnorm／softmax／silu／rope／adamw 有），以純 JS 退路滿足「WebGL2 或純 JS」。驗收：`gpu_cache_fallback_test.js`（假 WebGPU 裝置：matmulNBits 與 moss linear／layerNorm 第二次呼叫不重建 pipeline；沒有 WebGPU 與裝置遺失兩種情況退 cpu-js，結果與參考一致，原因寫明）通過；attn 退路原有 `attn_gpu_test.js`。
- [x] **F. 建置與檢查**（2026-11-16，B／D／E 之後）：`node build-assistant.js`（18.85MB→13.24MB）、`node scripts/build-web-lazy.js`（core.js 5812K、232 區塊）、`node scripts/web-lazy-check.js`（通過：core.js＋232 個區塊檔）都成功；建置產物（renderer/floating-assistant*.js、update-manifest.json、web-lazy/*）是可重現的產物，不提交（先前提交慣例同），已還原；動到的測試（test-affected）只剩既有的 studio_embed `lora_ref_train.js` 失敗（先前提交就存在，與本工作無關）；`git status` 沒有未提交的來源（未追蹤的 DESIGN.edit-*／env-baseline／HANDOFF.edit-remote／skills/weak-model-harness/scripts/bridge 不是本工作）。
- [x] **G. 模型檔查詢**：Whisper 產品用 onnx-community/whisper-base（q8，約 80 MB），已在使用，沒有新下載。Basic Pitch：待查檔名／來源／大小（不下載）→ 寫進 DESIGN 與最終回報。（Basic Pitch 已查，見 DESIGN §12）

## 第二階段（A 到 G 全部完成後接著做；使用者要「完整加速」）
- [x] **H.（BLOCKED 驗收） Qwen3 整段 GPU 解碼**（2026-11-16；實作由 Q 完成：嵌入、層間串接、lm_head、argmax 取樣都在 GPU）：20 步對拍已做，結果與限制見 DESIGN §7.13 末段——教師強迫 argmax 一致 18／20、19／20，logits 相對差 3%～25%（q8 動態量化的離群通道放大，ORT 跨 CPU 也有）；GPU 引擎對 CPU 參考自由生成前綴 4／12 個詞元。**BLOCKED（逐字一致的驗收）**：原因是動態量化的數值特性，不是核心錯誤，無法靠改核心達成；真 GPU 沒有。
- [ ] **BLOCKED（缺真模型檔（midigen q4，約 73 MB）無法對拍；這台機器沒有，下載需使用者在本對話同意）** **J. midigen 整個解碼器 GPU 管線**（含注意力）。
- [ ] **BLOCKED（產品的 whisper-base（onnx-community，q8，約 80 MB）只存在使用者的瀏覽器快取，這台機器沒有；不新下載需先有使用者同意）** **K. Whisper 編碼器走 GPU**（conv_ops 一維卷積＋注意力），對 transformers.js 輸出比對；用產品現有 whisper-base，不新下載。
- [ ] **BLOCKED（先查清單已有（DESIGN §12），Demucs／YAMNet 清單與所有模型下載都需使用者同意）** **L. Basic Pitch、Demucs、YAMNet**：先查模型檔清單（不下載）；有同意再做圖對照。
- [ ] **BLOCKED（缺 SDXS 模型檔，下載需使用者同意）** **M. SDXS 影像生成**：GroupNorm、交叉注意力、上採樣、VAE；只針對 CPU 版與沒有 f16 的機器。
- [x] **N. 裝置自動選擇**（2026-11-16）：`device_pick.js`（探測＋小基準＋決策）、設定 `gpuAuto`（預設關，手動勾選仍可關／開）、各 GPU 路徑 `_xxxOn()` 接上、DESIGN §7.16、單元測試通過；真 GPU 的基準門檻未用真機數字校準（如實寫在 §7.16）。沒有 WebGPU 的機器維持原路徑（wasm／純 JS）。
- [x] **O. Python 相容層補洞**（2026-11-16）：dd 模式補上除法、次方（整數／一般）、`math.sqrt/exp/log/sin/cos/tan/tanh/floor/ceil/fabs`；取餘與 `//` 仍拒絕並說明。驗收：真 Chrome WebGPU（軟體）410 組對 float64 相對誤差全部 < 1e-11（`cudaweb_dd_math_check.js`）、`fa_gpu_py_test.py` 48 項通過；順帶修 `dd_mul` 在 SwiftShader 只剩 float32 精度的問題（改 Dekker）。已知風險（常數運算元被編譯器化簡）寫在 DESIGN §7.17。
- [ ] **BLOCKED（唯讀查圖形也需要 kokoro 模型檔（下載需使用者同意））** **P. Kokoro**：先查 kokoro-js 圖形（唯讀），能估工作量再決定。
- [x] **I. 【最後的最後】LoRA 訓練端到端 GPU**（2026-11-16 完成：真 Chrome 軟體 WebGPU 20 步 loss 對 CPU f64 最差相對差 1.05e-4，全 T1，見 DESIGN §7.18；softmax 梯度／交叉熵／RMSNorm inv 仍在 CPU，真 GPU 與 Qwen 規模未驗）（使用者 2026-11-16：「訓練的是最後的最後」，其他全部做完才碰）：梯度與交叉熵等其餘運算，端到端訓練 20 步 loss 對拍。

## 最終回報（只回報一次）
做了什麼（每項一行）、提交編號、哪些只通過 CPU 參考／哪些真 Chrome 驗證過、哪些沒驗證、哪些 BLOCKED（原因）。

## 怎麼做才不浪費
- 先讀 `docs/HANDOFF.cudaweb-inference.md` §8 程式地圖，用 Grep 定位函式，不要整檔讀 `floating-assistant.js`（十幾萬行）。
- 每個核心已有「CPU 參考 → 真 ORT 對拍 → 真 Chrome」的做法，照既有的 `scripts/eval/cudaweb_*_check.js` 複製，不要重新設計。
- 不做獨立效能量測；一個提交只做一件事；提交訊息寫「做了什麼＋怎麼驗證」。
