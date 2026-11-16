# 清單：cudaweb 推論接線（做完才回報）

**規則：你的一輪只在「下面每一項都是 [x] 或 BLOCKED（附原因）」時才可以結束。** 做完一項、提交之後，立刻回來看這份清單、勾掉、做下一個 [ ]，不要回報、不要停。使用者問的小問題你用一兩句帶過後也回到這份清單。被某項卡住就標 BLOCKED＋原因，換下一項，不要停下等。
每項都要有「驗收」：寫在項目裡的那個檢查通過才能勾。勾掉要在同一個提交裡改這份檔。

## 項目
- [ ] **A. MOSS WebGPU 整管線**：把已驗證的 CPU 管線（預填、生成、取樣、codec）各運算換成 GPU 核心（矩陣乘、注意力、LN、RoPE、GELU、conv_ops），與 ORT 比對。驗收：真 Chrome 驗證頁結果檔 pass（音訊相對誤差 ≤ 1e-4，同 seed 同幀數）。
- [ ] **B. MOSS 產品接線**：moss_worker／moss_core 的推論可選走 GPU 管線；設定開關 `mossGpu`（預設 off）；失敗自動退回現有 wasm 路徑；診斷（層別、耗時、退回原因）。設定放 AI 助理設定與桌面版設定頁兩處。驗收：開關關時行為與現在完全相同（既有測試全過）；開時在真 Chrome 生成音訊且與 wasm 路徑結果一致。
- [ ] **C. Qwen3 網頁版解碼迴圈接線**：注意力＋KV 快取＋MatMulNBits 投影接進 transformers.js q4f16 路徑（Worker）；開關 `qwenGpuDecode`（預設 off）；失敗退回。驗收：真 Chrome 8 個詞元與原路徑相同。若這條需要的圖改寫太大，標 BLOCKED＋原因，不要硬做。
- [ ] **D. midigen 接線**：網頁版與桌面版 MIDI 生成路徑接 midigenai 解碼器；開關 `midiGpu`（預設 off）；失敗退回。驗收：固定種子前 N 個 token 與原路徑相同。桌面版沒有 WebGPU 的子程序，沿用 lm_head 的 head_req／head_res 信箱做法。
- [ ] **E. 退路與快取**：attn_gpu、matmulnbits_gpu、moss 各運算都要有 WebGL2 或純 JS 退路與 pipeline／shader 快取（現在注意力每次呼叫重建 pipeline，比 CPU 慢）。驗收：node 測試涵蓋退路；第二次呼叫不再重建 pipeline。
- [ ] **F. 建置與檢查**：`node build-assistant.js`、`node scripts/build-web-lazy.js`、`node scripts/web-lazy-check.js`、動到的測試全過；`git status` 沒有未提交的來源。
- [x] **G. 模型檔查詢**：Whisper 產品用 onnx-community/whisper-base（q8，約 80 MB），已在使用，沒有新下載。Basic Pitch：待查檔名／來源／大小（不下載）→ 寫進 DESIGN 與最終回報。（Basic Pitch 已查，見 DESIGN §12）

## 第二階段（A 到 G 全部完成後接著做；使用者要「完整加速」）
- [ ] **H. Qwen3 整段 GPU 解碼**：嵌入、層間串接、取樣都走 GPU，與 ORT 20 步 loss／logits 對拍。
- [ ] **I. LoRA 訓練端到端 GPU**：梯度與交叉熵等其餘運算，端到端訓練 20 步 loss 對拍。
- [ ] **J. midigen 整個解碼器 GPU 管線**（含注意力）。
- [ ] **K. Whisper 編碼器走 GPU**（conv_ops 一維卷積＋注意力），對 transformers.js 輸出比對；用產品現有 whisper-base，不新下載。
- [ ] **L. Basic Pitch、Demucs、YAMNet**：先查模型檔清單（不下載）；有同意再做圖對照。
- [ ] **M. SDXS 影像生成**：GroupNorm、交叉注意力、上採樣、VAE；只針對 CPU 版與沒有 f16 的機器。
- [ ] **N. 裝置自動選擇**：依能力探測與簡單基準自動決定 GPU 路徑要不要開（預設開關仍可手動關）；沒有 WebGPU 的機器走 WebGL2 或純 JS。
- [ ] **O. Python 相容層補洞**：float64 除法、次方、`math.*`。
- [ ] **P. Kokoro**：先查 kokoro-js 圖形（唯讀），能估工作量再決定。

## 最終回報（只回報一次）
做了什麼（每項一行）、提交編號、哪些只通過 CPU 參考／哪些真 Chrome 驗證過、哪些沒驗證、哪些 BLOCKED（原因）。

## 怎麼做才不浪費
- 先讀 `docs/HANDOFF.cudaweb-inference.md` §8 程式地圖，用 Grep 定位函式，不要整檔讀 `floating-assistant.js`（十幾萬行）。
- 每個核心已有「CPU 參考 → 真 ORT 對拍 → 真 Chrome」的做法，照既有的 `scripts/eval/cudaweb_*_check.js` 複製，不要重新設計。
- 不做獨立效能量測；一個提交只做一件事；提交訊息寫「做了什麼＋怎麼驗證」。
