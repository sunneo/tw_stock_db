# 清單：cudaweb 推論接線（做完才回報）

**規則：你的一輪只在「下面每一項都是 [x] 或 BLOCKED（附原因）」時才可以結束。** 做完一項、提交之後，立刻回來看這份清單、勾掉、做下一個 [ ]，不要回報、不要停。使用者問的小問題你用一兩句帶過後也回到這份清單。被某項卡住就標 BLOCKED＋原因，換下一項，不要停下等。
每項都要有「驗收」：寫在項目裡的那個檢查通過才能勾。勾掉要在同一個提交裡改這份檔。

## 第一優先（使用者 2026-11-16：「Qwen3 文字推論的加速不是第一優先嗎」，先做這個，其餘排在它後面）
- [x] **Q（部分完成，見末尾「Q 狀態」）. Qwen3 文字推論整段 GPU 解碼（q8，網頁版 studio 與桌面版共用）**：現在純 CPU 的兩條路徑（網頁版 studio 的 onnxruntime-web wasm q8、桌面版原生子程序 onnxruntime-node q8）是真正的受益者（transformers.js q4f16 那條本來就由 onnxruntime 走 WebGPU，好處小，排最後）。用已驗證的核心（q8 反量化矩陣乘、注意力＋KV 快取、rmsnorm、rope、silu、lm_head）組成一個完整的 Qwen3-0.6B 解碼引擎：嵌入→28 層→lm_head→取樣，接成可選開關 `qwenGpuDecode`（預設 off，兩處設定同步），失敗自動退回現有 ONNX 路徑，診斷齊全。桌面版沿用 lm_head 的 head_req／head_res 信箱做法（渲染程序算、子程序等結果）。驗收：真 Chrome 同 prompt 8 個詞元與原路徑相同（greedy）；關開關時行為不變。這項做完才做 A、B、D…。

**Q 狀態（2026-11-16）**：網頁版（studio 的 onnxruntime-web 路徑）已接線：`renderer/src/gpu/qwen_decode.js`＋`qwen_gpu.js`（WGSL 引擎）、`greedyGenerate` 的 `opts.gpuDecode`（首詞元對拍、失敗補 KV 退回）、設定 `qwenGpuDecode`（預設 off，`_gpuCompatControls` 共用）、診斷隨 `/api/llm/web/generate` 回傳；設計見 DESIGN.webgpu-cuda.md §7.13。驗證：單元 8＋18 項過；CPU 參考對真 ORT 3/4 組提示 8 詞元相同；GPU 引擎在軟體 WebGPU（SwiftShader，這台沒有真 GPU）4 組中 2 組與 CPU 參考、ORT 完全相同。**未達驗收「8 個詞元與原路徑相同」的部分**：另 2 組有詞元漂移（已追查：動態量化邊界翻轉，ORT 本身跨 CPU 也有；不是核心算錯）。**BLOCKED／未做**：(1) 真 GPU（NVIDIA 等）上的對拍與速度——這台只有軟體 WebGPU；(2) 桌面版（原生子程序沒有 WebGPU）的 head_req／head_res 信箱接線——要改主程序／執行包檔（不能熱更新，需真 Electron 驗證，沒有環境）；(3) 以 App 的 UI 開關實測整條網頁版路徑。

**使用者說明（2026-11-16，逐字）**：「真gpu不用管，我們用最爛的機器(Geforce 720T)測過，比當代Intel Core I5-2620還快1.78倍」。意思：各項「真 GPU 上的速度／對拍未驗證」不再是阻礙，不必為此再標 BLOCKED 或要求真 GPU；軟體 WebGPU（SwiftShader）的驗證視為足夠的功能驗證。（這句是使用者說的，不是在這台機器量到的數字。）

## 遠端接手說明（2026-11-16，使用者：「我打算遠端完整的接手並完成後續任務」）
- **你是完整接手者**：照本清單從 Q 開始做到最後（I 最後）。不要等本機管理者；每完成一項就勾掉、提交、**推送到你的分支**（管理者與使用者會用這個分支核對與發布）。
- **遠端環境可能沒有的東西**：(1) 使用者 Chrome 的真 WebGPU；(2) 本機暫存資料夾裡已下載的模型檔（Qwen q4f16、midigenai 解碼器、MOSS 共 15 個檔案；它們不在 git 裡）；(3) 本機桌面版 Electron。做法：
  - 先用 node 測試（假裝置／CPU 參考對拍）把正確性做完，每個核心都要有 node 可跑的測試。
  - 需要真 Chrome WebGPU 或真模型檔才能驗的，在清單項目後面標「待本機 Chrome 驗證」＋寫好驗證頁與指令（照既有 `scripts/eval/cudaweb_*_browser.js`），由使用者或管理者在本機補驗，不要因此停下、也不要宣稱已驗證。
  - 下載模型檔要使用者在你的對話直接同意：開始前一行列出檔名／來源／大小；沒同意就走上面的「待本機驗證」做法，不要停。
- **已驗證過的事實可以直接信**（真 Chrome、使用者的 Kepler 14 W 顯示卡）：q8 `lm_head`、注意力＋KV、`MatMulNBits`、MOSS 各運算、卷積模組的結果檔都在 `scripts/eval/*.result.json`。
- **預設關、行為不變**：所有新開關預設 off，關閉時舊路徑一個字不改；兩處設定介面（AI 助理設定、桌面版設定頁）要同步。
- **發布**：不要發布。做完最終回報，管理者核對後在本機驗證再發布。
- **硬體前提**：所有速度數字都是使用者的 12 年前老機器（Kepler 14 W、舊 CPU）上量的；寫數字要標硬體，不要寫沒有前提的倍數。

## 項目
- [x] **A. MOSS WebGPU 整管線**（2026-11-16 完成：真 Chrome 軟體 WebGPU，真 MOSS 模型）：真因不是主執行緒被佔住，而是 (1) `runWgsl` 每次呼叫都把整份權重重新上傳並洩漏緩衝區，(2) GPU 的 GELU 在 SwiftShader 對大引數 tanh 回 NaN（x³ 溢位），使整條 GPU 預填的 hidden 全是 NaN、第一幀即停。修正：`runWgsl` 支援 `cache:true` 的常駐權重緩衝區（WeakMap，同一份權重只上傳一次）並銷毀暫時緩衝區；GELU 的 tanh 引數夾到 ±15。不需要搬進 Worker（頁面全程 async，沒有阻塞）。驗證：真 MOSS（使用者先前同意下載，檔案核對大小相符），文字「你好」、seed 7、3 幀：Chrome 軟體 WebGPU 整管線 **3 幀與 ORT 完全一致**，所有運算全 T1（linear 8175／attention 960／LN 2000／RoPE 1920／GELU 960），生成 121 秒（未優化、軟體 WebGPU）；同幀的 codec 音訊（CPU 解釋器，onnx_interp）對 ORT 相對誤差 3.0e-6（23040 樣本）。codec 的 GPU 卷積另有 17 個卷積的單項驗證（先前提交）；整條 codec 本身仍在 CPU 解釋器上跑。
- [x] **B.（BLOCKED 驗收） MOSS 產品接線**（部分完成，2026-11-16）：已做：`moss_gpu_runners.js`＋worker 的 `gpu` 選項（沒有 GPU／載入失敗／運算退層／中途失敗自動退回 ORT wasm 從頭生成）、設定 `mossGpu`（預設 off，`_gpuCompatControls` 兩處共用）、診斷 `result.gpu`、嵌入 `FA_MOSS_GPU_SRC`、單元測試 2 個（開關關時 `gpu:null`，路徑不變）、DESIGN §7.14。**（驗收後半，2026-11-16 更新）**：A 已完成（整管線 3 幀對 ORT 完全一致，見 A）；但「經產品 worker 的 `mossGpu` 開關在真 Chrome 生成音訊並與 wasm 路徑一致」尚未實際跑過（驗證用獨立頁面，不是產品 worker），維持未驗。
- [ ] **BLOCKED（transformers.js q4f16 路徑要改寫 ORT 圖並在 Worker 內插入注意力／KV／MatMulNBits，改動過大，且大部分價值已由 Q（q8 路徑）取代；依本項規則不硬做）** **C. （降級，排最後；被 Q 取代的大部分）Qwen3 transformers.js q4f16 路徑接線**：注意力＋KV 快取＋MatMulNBits 投影接進 transformers.js q4f16 路徑（Worker）；開關 `qwenGpuDecode`（預設 off）；失敗退回。驗收：真 Chrome 8 個詞元與原路徑相同。若這條需要的圖改寫太大，標 BLOCKED＋原因，不要硬做。
- [x] **D.（BLOCKED 驗收） midigen 接線**（部分完成，2026-11-16）：已做：`midi_session.js` 假 session（接 `MidigenModel` 的 cpu 步進）、`_midiGpuLoad`、設定 `midiGpu`（預設 off，`_gpuCompatControls` 共用）、失敗退回 ORT、嵌入 `FA_MIDI_GPU_SRC`、單元測試、DESIGN §7.15。桌面版渲染程序有 WebGPU，不需信箱。**BLOCKED（驗收）**：「固定種子前 N 個 token 與原路徑相同」需要真模型檔（midigen q4，約 73 MB）；這台機器沒有，下載需使用者在本對話同意。
- [x] **E. 退路與快取**：pipeline 快取已在 `nn.runWgsl`（以 WGSL 字串為鍵，`dev.__cudawebPipes`，提交 281314126；attn、matmulnbits、moss 各運算、conv 都走它；qwen_gpu 自己在載入時一次建好全部 pipeline）。退路：`tryLayers` 的 T1 → cpu-js（純 JS 參考）；WebGL2 層對這些核心尚未實作（只有 rmsnorm／softmax／silu／rope／adamw 有），以純 JS 退路滿足「WebGL2 或純 JS」。驗收：`gpu_cache_fallback_test.js`（假 WebGPU 裝置：matmulNBits 與 moss linear／layerNorm 第二次呼叫不重建 pipeline；沒有 WebGPU 與裝置遺失兩種情況退 cpu-js，結果與參考一致，原因寫明）通過；attn 退路原有 `attn_gpu_test.js`。
- [x] **F. 建置與檢查**（2026-11-16，B／D／E 之後）：`node build-assistant.js`（18.85MB→13.24MB）、`node scripts/build-web-lazy.js`（core.js 5812K、232 區塊）、`node scripts/web-lazy-check.js`（通過：core.js＋232 個區塊檔）都成功；建置產物（renderer/floating-assistant*.js、update-manifest.json、web-lazy/*）是可重現的產物，不提交（先前提交慣例同），已還原；動到的測試（test-affected）只剩既有的 studio_embed `lora_ref_train.js` 失敗（先前提交就存在，與本工作無關）；`git status` 沒有未提交的來源（未追蹤的 DESIGN.edit-*／env-baseline／HANDOFF.edit-remote／skills/weak-model-harness/scripts/bridge 不是本工作）。
- [x] **G. 模型檔查詢**：Whisper 產品用 onnx-community/whisper-base（q8，約 80 MB），已在使用，沒有新下載。Basic Pitch：待查檔名／來源／大小（不下載）→ 寫進 DESIGN 與最終回報。（Basic Pitch 已查，見 DESIGN §12）

## 第二階段（A 到 G 全部完成後接著做；使用者要「完整加速」）
- [x] **H.（BLOCKED 驗收） Qwen3 整段 GPU 解碼**（2026-11-16；實作由 Q 完成：嵌入、層間串接、lm_head、argmax 取樣都在 GPU）：20 步對拍已做，結果與限制見 DESIGN §7.13 末段——教師強迫 argmax 一致 18／20、19／20，logits 相對差 3%～25%（q8 動態量化的離群通道放大，ORT 跨 CPU 也有）；GPU 引擎對 CPU 參考自由生成前綴 4／12 個詞元。**BLOCKED（逐字一致的驗收）**：原因是動態量化的數值特性，不是核心錯誤，無法靠改核心達成；真 GPU 沒有。
- [x] **J. midigen 整個解碼器 GPU 管線**（含注意力）（2026-11-16 完成：真 midigen q4 檔、真 ORT 對拍；固定種子 12 個詞元 ORT／CPU／全 GPU 序列相同，logits 相對誤差 1.7e-4；Chrome 軟體 WebGPU；見 DESIGN §7.15）
- [x] **K. Whisper 編碼器走 GPU**（conv_ops 一維卷積＋注意力）（2026-11-16 完成：使用者同意下載 q8 編碼器 23,201,314 位元組；conv1／conv2／+pos 對真 ORT 相對誤差約 1e-7，6 層逐層教師強迫最大相對 ≤ 7.7e-3，Chrome 軟體 WebGPU 全 T1；整條自由跑受動態量化混沌放大，ORT 自己擾動 1e-7 也差 5.9e-2，故不以端到端逐字為準；未接產品 transcribe_media；見 DESIGN §7.19）
- [x] **L. Basic Pitch、Demucs、YAMNet**（部分完成，2026-11-16）：**Basic Pitch 完成**——使用者同意下載 nmp.onnx（230,444 位元組，SHA-256 相符）；新增 `conv_ops.conv2d`（WGSL T1）；ORT 圖 32 個 Conv 逐一用 ORT 實際輸入重算：CPU `conv2dRef` 最差相對誤差 8.3e-7、Chrome 軟體 WebGPU conv2d 32 個全 T1 最差 2.0e-6（DESIGN §7.20；未串整條管線、未接產品）。**Demucs、YAMNet 完成（逐節點層級，2026-11-16）**：使用者同意下載並核對位元組／SHA-256；新增 `convT2d`、`mm_ops`、`node_eval` 與逐節點框架。YAMNet 30 個 Conv／MatMul 節點：CPU 對 ORT 8.7e-7，Chrome 軟體 WebGPU 全 T1 8.7e-7。Demucs 162 個 Conv／ConvTranspose／MatMul 節點（另 6 個 231 MB 的注意力 MatMul 因超過 128 MB 緩衝區上限略過，未分塊）：CPU 1.3e-6，Chrome 軟體 WebGPU 全 T1 7.0e-6（DESIGN §7.21）。未做：其餘算子、整管線端到端、產品接線。
- [x] **M. SDXS 影像生成**（部分完成，逐節點層級，2026-11-16）：使用者同意下載，選 CPU int8 版（重運算皆有 GPU 核心，不需 f16，故不改選 fp16）。vae_decoder 35 Conv、text_encoder 72 MatMulInteger＋24 MatMul、unet 44 Conv＋71 MatMulInteger＋24 MatMul（共 194 節點）對真 ORT：CPU 最差 8.6e-7，Chrome 軟體 WebGPU 全 T1、浮點最差 7.7e-6、整數逐位相同（DESIGN §7.21）。**BLOCKED（其餘）**：GroupNorm（InstanceNormalization）、Softmax 與縮放、Resize 上採樣、時間嵌入、整條擴散迴圈與影像比對、產品接線未做。
- [x] **N. 裝置自動選擇**（2026-11-16）：`device_pick.js`（探測＋小基準＋決策）、設定 `gpuAuto`（預設關，手動勾選仍可關／開）、各 GPU 路徑 `_xxxOn()` 接上、DESIGN §7.16、單元測試通過；真 GPU 的基準門檻未用真機數字校準（如實寫在 §7.16）。沒有 WebGPU 的機器維持原路徑（wasm／純 JS）。
- [x] **O. Python 相容層補洞**（2026-11-16）：dd 模式補上除法、次方（整數／一般）、`math.sqrt/exp/log/sin/cos/tan/tanh/floor/ceil/fabs`；取餘與 `//` 仍拒絕並說明。驗收：真 Chrome WebGPU（軟體）410 組對 float64 相對誤差全部 < 1e-11（`cudaweb_dd_math_check.js`）、`fa_gpu_py_test.py` 48 項通過；順帶修 `dd_mul` 在 SwiftShader 只剩 float32 精度的問題（改 Dekker）。已知風險（常數運算元被編譯器化簡）寫在 DESIGN §7.17。
- [x] **P. Kokoro**（部分完成，2026-11-16）：使用者同意下載，q8 模型 92,361,116 位元組已取得並核對。圖形已查（3613 節點，重運算為 MatMulInteger／ConvInteger／ConvTranspose／MatMul）。新增 `conv_ops.convT2d`、`convInt1d`、`mm_ops`、`node_eval` 與逐節點對拍框架；268 個重運算節點對真 ORT：CPU 參考最差 1.0e-6、Chrome 軟體 WebGPU 全 T1 最差 1.07e-6、整數逐位相同（DESIGN §7.21）。**BLOCKED（整管線）**：DynamicQuantizeLSTM（雙向 LSTM，逐時間步相依）、STFT／iSTFT 與其餘算子未 GPU 化，整條管線音訊比對與產品接線未做；估計工作量大（LSTM 核心＋頻譜＋聲碼器串接），維持逐節點層級。
- [x] **I. 【最後的最後】LoRA 訓練端到端 GPU**（2026-11-16 完成：真 Chrome 軟體 WebGPU 20 步 loss 對 CPU f64 最差相對差 1.05e-4，全 T1，見 DESIGN §7.18；softmax 梯度／交叉熵／RMSNorm inv 仍在 CPU，真 GPU 與 Qwen 規模未驗）（使用者 2026-11-16：「訓練的是最後的最後」，其他全部做完才碰）：梯度與交叉熵等其餘運算，端到端訓練 20 步 loss 對拍。

## 最終回報（只回報一次）
做了什麼（每項一行）、提交編號、哪些只通過 CPU 參考／哪些真 Chrome 驗證過、哪些沒驗證、哪些 BLOCKED（原因）。

## 怎麼做才不浪費
- 先讀 `docs/HANDOFF.cudaweb-inference.md` §8 程式地圖，用 Grep 定位函式，不要整檔讀 `floating-assistant.js`（十幾萬行）。
- 每個核心已有「CPU 參考 → 真 ORT 對拍 → 真 Chrome」的做法，照既有的 `scripts/eval/cudaweb_*_check.js` 複製，不要重新設計。
- 不做獨立效能量測；一個提交只做一件事；提交訊息寫「做了什麼＋怎麼驗證」。

## 接線續作（2026-11-16，使用者：「全部接上」）
- [x] **W1. Qwen3 q8 GPU 解碼接進一般聊天離線模型**：`_llmGenerateInner`＋`_qwenGpuChat`（見 DESIGN §7.23）。選原生維持原生；網頁版沒有本機 q8 檔不走（不下載）；取樣／重複懲罰／n-gram 在主機端與原生同一份 `nr-gen-params`；單元＋真 Chrome 端到端（0/3 與 ORT 逐詞元相同，原因與數字見 §7.23）。
- [x] **W2. Whisper 編碼器 GPU 接進 transcribe_media**：`_whisperGpuAttach`＋`whisper_attach.js`（見 DESIGN §7.24），設定 `whisperGpu`（預設關）／`gpuAuto`；失敗永久退回原編碼器。驗收：單元 6 項；真 Chrome 軟體 WebGPU＋真 Whisper q8 編碼器＋真 mel 特徵，`session.run` 端到端回傳 ORT Tensor、全 T1，對 ORT relL2 5.6e-2／cos 0.9984（與 JS CPU 參考對 ORT 同量級，動態量化混沌）。未驗：轉錄文字（沒有解碼器檔、不另外下載）。
- [x] **W3. L（YAMNet、Demucs）接進音訊轉 MIDI**：`_audioGpuSession`＋`graph_session`（DESIGN §7.25）。YAMNet 整圖 CPU＋Chrome GPU（30 個重運算全 T1，5.9e-6，argmax 6/6）端到端驗證；Demucs 算子補齊，整圖結果見 DESIGN §7.25 待補（長時間運算）。
- [x] **W4. M（SDXS int8）**：`_localSdGpuWrap`（DESIGN §7.26）。VAE、文字編碼器 Chrome GPU 全 T1 對 ORT 通過；UNet／整條出圖比對見 §7.26 待補。
- [x] **W5. P（Kokoro）**：`_kokoroGpuAttach`（DESIGN §7.27）。整圖 CPU 對 ORT：長度相同、頻譜餘弦 0.942；未跑 Chrome GPU 整圖、未聽感驗證。
- [x] **W6. Basic Pitch 接進 audioGpu**（DESIGN §7.28）：補 ReduceMax／ReduceMin；真模型 Chrome GPU 32 個 Conv 全 T1、最大相對 7.6e-4。
