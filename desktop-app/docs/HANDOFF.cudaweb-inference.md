# 交接：cudaweb 推論概念驗證與接線（2026-11-16）

## 1. 開場提示（接手者收到的原文）
請接續 `desktop-app/docs/HANDOFF.cudaweb-inference.md`：完整讀完（含使用者原話與工作方式）並照著做，執行 low-context-long-run 技能（門檻 30%）：做下一個待辦，到門檻就寫下一份交接並自己啟動接手者。第一則訊息用一行說明你讀過文件、從哪個待辦開始。使用者原話：「做，先做推論概念驗證，可以的話就接上去」

## 2. 概況
- 機器：Windows 10，專案 `D:\Downloads\videos-嗨投資-desktop-app\desktop-app`，分支 `desktop-app`（已推送到 `origin/desktop-app`，最後提交 `5cafabf76`，之後本機另有這份交接提交）。上層管理者工作階段 `local_49f6c57d-8f18-427b-a8f1-7b1d23efc5f5`（不封存）。
- `cudaweb`（GPU 運算層）：設計見 `DESIGN.webgpu-cuda.md`；核心 `renderer/src/gpu/gpu_core.js`、訓練用運算 `renderer/src/gpu/nn_ops.js`（`rmsnorm`、`softmax`、`silu`、`rope`、`adamw` 已在使用者 Chrome 的真 WebGPU 驗證，誤差約 1e-8～2e-7）、`renderer/src/studio/backend_cudaweb.js`。降級順序 WGSL → 替代 → WebGL2 → 純 JS。
- **推論還沒接**：設計 §7.3（約第 397 行）規劃「Qwen3-0.6B 推論熱點概念驗證」：`lm_head`（151936×1024）與一層 MLP（1024×3072、3072×1024），讀入相同權重與輸入、與現有輸出比對，容差內一致才算通過。完整推論還缺：RoPE（已有）、注意力（分塊版）、RMSNorm（已有）、SiLU（已有）、**q8 反量化矩陣乘（現有權重格式）**、KV 快取。§9 第四階段（概念驗證＋資源調度）、第五階段（完整推論取代、20 步 loss 對拍）都標「待做」。
- 現行推論路徑（不經 cudaweb）：桌面版 `nr-engine.js`（onnxruntime-node，ONNX 專用）；網頁版 transformers.js／ort-web 的 ONNX q8（`onnx-community/Qwen3-0.6B-ONNX/onnx/model_quantized.onnx`）。本機已有模型檔在 `%APPDATA%\floating-assistant-desktop\native-models`（約 0.58 GB）。
- 另有一件使用者自己要做、不屬這條線：`scripts/move-to-e.ps1`（未追蹤、未提交；把 `.claude`、`floating-assistant-desktop`、`Claude-Data` 搬到 E: 並留 junction）。使用者會自己在 Claude 關閉時執行。

## 3. 待辦（依序）
1. **概念驗證（§7.3）**：新增 `renderer/src/gpu/infer_poc_core.js`（純 UMD，node 可 require）與測試。步驟：(a) 找出本機現有的 Qwen3-0.6B 權重（先看 `native-models`、`builtin-lora`、`nr-engine.js` 怎麼載；**不要下載任何東西**，要下載先列檔名／來源／大小問使用者）；(b) 讀出 `lm_head` 與第 0 層 MLP 的權重與一個固定輸入；(c) 用 `cudaweb.sgemm`（T1／T3）算，與純 JS／現有輸出比對，容差內一致才算過；(d) q8 反量化矩陣乘要做成核心（先 CPU 參考版＋WGSL＋WebGL2 退路，與 §3 同形式）；(e) 在使用者的 Chrome 真 WebGPU 驗證（照 `scripts/eval/cudaweb_browser.js` 的做法，換埠 18765，用完關掉伺服器），結果寫入 `scripts/eval/` 的 result JSON；(f) 量一下速度（相對純 JS 的倍數），如實記錄。
2. **缺的運算子**：分塊版注意力、KV 快取（先 CPU 參考版＋測試，再 GPU 核心）。
3. **接線（驗證通過才做）**：做成可選開關（預設關），桌面版與網頁版推論熱點（先 `lm_head`）走 `cudaweb`，任何失敗自動退回現有 ONNX 路徑；設定放 AI 助理設定與桌面版設定頁（`_gpuCompatControls()` 同一處維護，改一邊要查另一邊）。**未通過容差的運算子不啟用，回報原因。**
4. 更新 `DESIGN.webgpu-cuda.md`（§7.3 結果、§9 進度），誠實標示沒驗證的部分（真實桌面版路徑、完整 20 步 loss 對拍）。
5. 發布前：先本機起 server 用 Claude in Chrome 驗證，OK 才跑 `scripts/publish.sh`；使用者說「發布」才發布。

## 3a. 進度更新（2026-11-16，後續工作階段）
- 待辦 1（概念驗證）**已完成並通過**：提交 f4875cb6d、2eeed3e11、3e9e1b6b4。新增 `renderer/src/gpu/onnx_lite.js`、`infer_ops.js`（q8mm、q8lm）、`infer_poc_core.js`、`infer_ops_test.js`（7 項過）、`scripts/eval/cudaweb_ort_truth.js`（要用 `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe` 跑，本機 node 是 32 位元，執行包只有 x64）、`cudaweb_infer_browser.js`（結果 json 已提交）。
- 結果：與真 ORT 對拍 gate_proj 逐位元一致；真 WebGPU（Chrome 157、NVIDIA Kepler）MLP 逐位元一致、lm_head 相對誤差 1.7e-7、argmax 一致；lm_head 常駐後 99 ms 對純 JS 533 ms（約 5.4 倍）。MLP 單詞元首次反而比純 JS 慢（229 vs 61 ms，含編譯與上傳）。DESIGN §7.3、§9 已更新（待辦 4 的這一部分已做）。
- **WebGL2 退路尚未做**（q8mm、q8lm 目前降級為 WGSL → 純 JS）。待辦 1(d) 的這一小項還沒完成。
- 待辦 3（接線）的關鍵發現：`nr-engine.js` 直接用 ORT 輸出的 `r.logits`（第 90 行附近）；lm_head 是模型圖內最後一個 `MatMul`（輸入 `/model/layers.28/final_norm_layernorm/output_0`、權重 `model.embed_tokens.weight_transposed`，由 DequantizeLinear＋Transpose 在圖內產生）。要讓 GPU 接手 lm_head，必須有一個「輸出隱藏狀態（final_norm 輸出）而不算 lm_head」的模型圖：做法是用 onnx_lite 擴充成可改寫的讀寫器，從現有 q8 檔本機產生變體（不下載），或在圖輸出加上 final_norm 輸出但 lm_head 照算（沒省）。這需要設計決定，且變體檔約多出 0 位元組權重（可共用），尚未開始。
- 下一步建議順序：(1) 補 WebGL2 退路或明講不做；(2) 待辦 2 的 CPU 參考版注意力＋KV 快取；(3) 待辦 3 先在桌面版做「隱藏狀態變體圖＋cudaweb lm_head」並設可選開關預設關。

## 3b. 接線前的實測與架構發現（2026-11-16）
- 實測現有路徑：真 ORT（CPU）跑完整 lm_head（151936×1024，暖機）中位數 **169 ms**（`scripts/eval/cudaweb_ort_lmhead_time.js`，提交在 scripts/eval）；GPU 版（NVIDIA Kepler、Chrome）暖機 **99 ms**。所以相對現有路徑只有約 **1.7 倍**，不是對純 JS 的 5.4 倍。GPU 越新倍數越高（未測）。
- 桌面版架構阻礙：生成迴圈在原生子程序（`nr-child.js`／`nr-engine.js`，ELECTRON_RUN_AS_NODE，**沒有 WebGPU**），logits 在 `generate()` 內直接取樣。要讓 GPU 算 lm_head，需要：(a) 隱藏狀態變體圖（輸出 final_norm 結果、不算 lm_head；用 onnx_lite 擴充成寫入器，從本機現有檔產生，不下載），(b) 子程序→主程序→畫面（有 WebGPU 的程序）→回傳 logits 的每詞元往返，(c) 執行包版本（FEATURES）與協定要新增並保持舊版相容（熱更新規則）。
- 網頁版：生成走 transformers.js／ort-web 載入的 HF 模型圖，同樣要隱藏狀態變體圖，且變體檔要在瀏覽器端改寫（約 617 MB 緩衝區）；尚未調查可行性。
- 結論：接線不是小改，且收益只有約 1.7 倍（Kepler）。已回報管理者等待是否仍要做、先做哪一邊；沒有改動任何產品程式。

## 4. 工作方式（使用者規則，照抄重點）
- 純中文回覆，不夾英文縮寫／術語。
- 子工作階段模型依上層：上層 Opus → 子層 Sonnet medium；上層 Sonnet medium → 子層 Haiku。派工簡報要寫明：歧義自決、不准回頭詢問、速度守則（不空等、不跑整套測試、3 分鐘內有結論）；結束前確認沒留下行程。我（上一位）是 Sonnet medium，所以派 Haiku。
- 目標：「盡可能讓使用者 gpu 成為可用」，不要因為「原生做不到」就排除；老舊 GPU 也要有退路。
- 使用者說「不管哪些查證，請只管實現」：不要把時間花在查證，直接做；但自己宣稱的結果要真的驗證（磁碟上看得到、測試跑過）。
- 驗證瀏覽器行為預設用 Claude in Chrome；網頁版／瀏覽器能力改動先本機 server＋Chrome 驗，OK 才發布。
- 發布分級：push 到自己 remote 要先問（這輪使用者說「推送」才推）；發布到正式環境永遠當輪確認。發布前來源要先提交。
- 改程式用 Edit／Write 工具，不用 shell 內嵌；通過測試才提交；整套核心測試一天一次，平常只跑動到的。
- 測試用桌面版設 `FA_BROWSER_CONTROL_PORT` 換埠；真桌面版評估每項最多跑兩次。
- 失敗訊息附具體事實；沒驗證就講「未驗證」；查不出原因就說查不出，不編。
- 使用者寫 GPU 歷史相關文件時，口述要標「使用者口述」。
- 殘留行程：腳本只殺自己記下標記的行程（`scripts/cleanup-orphans.js`，標記 `fa-cold-`），絕不用 `taskkill /IM chrome.exe`。

## 5. 使用者原話（原文，不改寫）
- 2026-11-16：「推論也可以用到嗎?javascript可以也使用道嗎」
- 2026-11-16：「做，先做推論概念驗證，可以的話就接上去」
- 2026-11-15：「這個cudaweb, 之後完成後，如果接上python,也要成為離線模型的推論，訓練的資源」
- 2026-11-15：「目標請以"盡可能讓使用者gpu成為可用" ，而不是像是做現成的"因為他原生做不到，所以我把它排除"」
- 2026-11-15：「舉例來說, GeForce 8800, 很爛，但他跑得動CUDA 1.0 / RaspberryPi沒有可能有CUDA, 但有人移植了OpenCL上去」
- 2026-11-15：「不管哪些查證，請只管實現」
- 2026-11-15：「欸不對啊 我剛說請你用claude for chrome測試 是想說你可以先用本地server, 然後在claude for chrome測試，然後確認ok了就送上去」

## 6. 交接流程（自我遞迴）
執行 low-context-long-run 技能，門檻 30%：每個批次結束（已提交）讀 `mcp__ccd_session_mgmt__get_usage`，到門檻就改寫本文件、提交、用 `start_session`（user_asked、fresh）啟動接手者，等它確認讀過文件並開始第一個待辦，才把自己標完成並封存（不刪除、不 clear）。管理層最上層工作階段 `local_49f6c57d-…` 不封存。

## 7. 陷阱
- `git checkout` 還原 `web-lazy/` 會因 `core.autocrlf=true` 變 CRLF，`web-lazy-check` 報檢查碼不符；重跑 `node build-assistant.js` 與 `node scripts/build-web-lazy.js`（約 2～3 分鐘，建置中 `web-lazy/` 暫時是空的）。`renderer/update-manifest.json` 只有 `generatedAt` 不同時用 `git checkout --` 還原。
- `floating-assistant.js` 內嵌了 `FA_GPU_CORE_SRC` 等來源模組：改來源模組（`renderer/src/gpu/*`），不要改嵌入後那份（會被蓋掉）；新增來源模組要照既有方式登記嵌入。
- node 是 v16.15.0（沒有內建 `fetch`）。Bash 工具不能用長 `sleep`，要等就用 Monitor。
- Chrome 驗證時 `window.fa` 在網頁版叫 `fa`；`FaGpuCore` 掛在 `window`。測試髒資料：我曾把 `cudaCompat=off` 存進 localStorage 造成假的失敗，驗證前先清。
- 真 GPU 上 `copyBufferToBuffer` 需要 `COPY_SRC`／`COPY_DST` 用途旗標（假裝置現在會檢查）。
- 使用者的 Chrome 在背景會留著 Claude in Chrome 的擴充功能行程，不是我們的殘留，不要殺。
