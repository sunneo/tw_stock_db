# 交接文件：cudaweb 推論（WebGPU）接線與模型驗證

## 1. 開場提示（啟動接手者時的提示詞）

接續 `desktop-app/docs/HANDOFF.cudaweb-inference.md`（專案 `D:\Downloads\videos-嗨投資-desktop-app\desktop-app`，分支 `desktop-app`）。完整讀完本文件，特別是第 5 節使用者原話與第 4 節工作方式，並照著做。執行 low-context-long-run 技能（門檻 60%）：依第 3 節的待辦順序做，到門檻就寫下一份交接文件、提交，再啟動自己的接手者（model 用 `claude-haiku-5-5`、effort 用 `high`）；被拒就停下回報。第一則訊息用一行說明你讀過文件、從哪一項待辦開始。

使用者原話（必須遵守）：「我的要求『做完才回報』有什麼疑慮嗎」；「同意下載 MOSS」；「該下載的，麻煩都一起下載，別再反覆問」。這三句是在本對話中使用者直接說的。

## 2. 總覽

- **目標**：把已驗證的 WebGPU 推論核心接進產品（網頁版與桌面版），三個模型：Qwen3-0.6B（網頁版 q4f16，MatMulNBits 投影）、midigenai v5 解碼器（MIDI 生成）、MOSS-TTS-Nano（語音，含 codec）。
- **環境**：Windows、Git Bash；專案 `D:\Downloads\videos-嗨投資-desktop-app\desktop-app`；分支 `desktop-app`。**不推送、不發布。**
- **模型檔位置**（scratchpad，不入庫）：`E:\Temp\claude\1845096e089295dd\dc8081b9-67f9-4ce8-859c-6915fcfbc7b1\scratchpad\`
  - `models\qwen3-q4f16.onnx`（569,789,750 位元組，來源 `onnx-community/Qwen3-0.6B-ONNX`，`onnx/model_q4f16.onnx`）
  - `models\midigen-decoder-webgpu-q4.onnx`（73,151,835 位元組，來源 `nicholasbien/midigenai`，`v5/onnx/decoder-webgpu-q4.onnx`）
  - `moss\`：MOSS-TTS-Nano 15 個檔，合計 762,840,113 位元組（來源 `OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX` 與 `OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX`，清單同桌面版 `floating-assistant.js` 的 `MOSS_FILES`）。
  - 另有 `mlp0\`（從 Qwen 檔衍生的 MLP 權重）、`moss_ort_ref.json`、`moss_local_ref.json`、`midi_ort_ref.json`（ORT 參考輸出）。
- **已提交（新到舊）**：
  - `a85925066` MOSS 本地解碼器線性層走真 Chrome WebGPU（170 次 T1）
  - `4f40cb970` MOSS 本地解碼器（非快取）CPU 參考版對真 ORT
  - `effcd9692` MOSS LayerNorm／RoPE／GELU 走真 Chrome WebGPU
  - `43150428f` MOSS 解碼一步矩陣乘與注意力走真 Chrome WebGPU
  - `b01a7ba4c` MOSS 全域解碼一步 CPU 參考版對真 ORT
  - `39c13f3b6` midigenai 解碼器 CPU 參考版＋真 Chrome WebGPU 投影
  - `d15e7f3d4` MatMulNBits 真權重驗證（Qwen q4f16 第 0 層 MLP）
  - `74e3fd70c` MatMulNBits GPU 核心＋真 Chrome 驗證
  - `807e0f325` MatMulNBits CPU 參考版
  - `789c7cbe3` 第 0 層一步 decode 對真 ORT
  - 更早：`3c7c77958`、`d1b50ead6`、`8be226632`、`b12061413`、`f1cae6209`、`6a60c18da` 等（注意力、KV 快取、lm_head 接線，見 DESIGN §7.5–§7.7）
- **已完成的驗證（真 Chrome WebGPU 或真 ORT）**：
  - Qwen：注意力與 KV 快取的 CPU 參考版對真 ORT（第 0 層一步 decode 相對誤差約 3e-6；28 層預填 logits 相對誤差 5.3e-7）。MatMulNBits GPU 核心與真權重 MLP 相對誤差約 1e-6。
  - midigen：CPU 參考版對真 ORT 相對誤差約 1e-6；投影 170 次走 T1，logits 相對誤差約 5e-6。
  - MOSS 全域解碼一步：CPU 與 GPU（矩陣乘、注意力、LN、RoPE、GELU 共 316 次 T1）對真 ORT，相對誤差約 4e-6。
  - MOSS 本地解碼器（非快取）：CPU 對真 ORT 相對誤差約 5e-6，argmax 16/16；GPU 線性層 170 次 T1，與 ORT 一致。
- **尚未完成**：見第 3 節。**沒有任何產品端接線（網頁版或桌面版）已完成**；所有驗證都在 scripts/eval 的獨立頁面，沒有改動 `floating-assistant.js` 的推論路徑。
- **DESIGN 文件**：`DESIGN.webgpu-cuda.md` §7.7（注意力與 KV）、§7.9（MatMulNBits）、§7.10（midigen）、§7.11（MOSS 全域）、§7.12（MOSS 本地）已更新。

## 3. 待辦（依序，下一步在最前）

1. **（進行中的下一步）MOSS 本地解碼器取樣與快取版**：
   - 取樣：`moss_tts_local_fixed_sampled_frame.onnx`（4949 節點，輸入 `global_hidden`、`repetition_seen_mask`(int32)、`assistant_random_u`、`audio_random_u`；輸出 `should_continue`(int32)、`frame_token_ids`(int32)）。含 TopK、CumSum、GatherElements、Clip、Div、ReduceSum。先用 `scripts/eval/cudaweb_onnx_dump.js` 傾印，再寫 CPU 參考，對 ORT 比對（注意隨機數 u 由輸入給，應可確定性比對）。
   - 快取版：`moss_tts_local_cached_step.onnx`（輸入 `global_hidden`、`text_token_id`、`audio_token_id`、`channel_index`、`step_type`、`past_valid_lengths`、`local_past_key_0`、`local_past_value_0`；輸出 logits 與 `local_present_*`）。
2. **MOSS codec 解碼**：`moss_audio_tokenizer_decode_full.onnx`（含 17 個 Conv、MatMul 80、LayerNormalization 24、Softmax 12、Erf、If）。需要 GPU 卷積核心（一維卷積）與 CPU 參考；codec 權重在 `moss_audio_tokenizer_decode_shared.data`（44,198,912 位元組）。
3. **MOSS 推論路徑接線（產品）**：網頁版與桌面版的 MOSS 路徑加**預設關閉**的開關，失敗自動退回現有路徑（`tts/moss_worker.js`、`renderer/src/floating-assistant.js` 的 MOSS 區段）。開關放在 **AI 助理設定** 與 **桌面版設定頁** 兩處，兩處同步（DESIGN 與 memory 的規則）。
4. **Qwen3 網頁版解碼迴圈接線**：把 `attn_gpu.js`（注意力）、KV 快取與 MatMulNBits 投影接進網頁版 Qwen 解碼迴圈，預設關、失敗退回現有 q8／現有路徑，開關同第 3 項放兩處。注意：網頁版真實權重是 q4f16（MatMulNBits 投影、lm_head fp16）；本機 q8 路徑是桌面版。
5. **midigenai 解碼器接進網頁版與桌面版 MIDI 生成路徑**：`renderer/src/gpu/midi_decoder.js` 已有 CPU 參考與 GPU 投影（`matmulnbits_gpu.js`）；注意力、RoPE、RMSNorm 還在 CPU。接線預設關，失敗退回 `music/native_ort.js` 路徑。
6. **卷積派發（Basic Pitch）與 Whisper**：需要**新模型檔**，**不得下載**，先列出需要的檔名、來源、大小，寫進最終回報，由使用者決定。
7. **最終回報**：一次回報（不要中途回報、不要結束一輪、不要問問題卡片）。內容：做了什麼、提交編號、哪些沒驗證、哪些需要使用者決定（Basic Pitch 與 Whisper 的模型清單、以及產品接線是否要在真 Electron 上驗證）。

## 4. 工作方式（使用者要求，從對話與轉述整理）

- **不推送、不發布**。提交後只寫在 git 歷史，不 push、不 deploy。
- **下載需要使用者在本對話直接同意**，並先列檔名、來源網址、大小。使用者的同意範圍只限於他說的檔案。這次 MOSS 的同意是使用者在本對話說「同意下載 MOSS」。**Basic Pitch 與 Whisper 的新模型尚未同意，不得下載。**
- **不做獨立效能掃描**。速度只在實作完成後順手記一個數字，標明「未優化」。使用者說過「不是啊，還再量?!」，他不要量測卡片。
- **不要問題卡片、按鈕或「要不要…？」的收尾問題**。只有「需要使用者的下載同意」才可以問，而且只問那一句。
- **每一塊都要用最小的正確性對拍確認**（真 Chrome WebGPU 或真 ORT），通過才提交；提交後在最終回報統一說明。
- **開關預設關閉，失敗自動退回現有路徑，診斷資訊齊全**（失敗原因、層級、耗時寫進結果）。
- **歧義自己決定**，決定寫進 DESIGN 或提交訊息，不要停下來等回覆。
- 驗證頁面：在 `scripts/eval/` 寫獨立的伺服器（埠 1877x）與頁面，用 Claude in Chrome（`mcp__claude-in-chrome__*`）開 `http://127.0.0.1:<埠>/`，結果寫到系統暫存資料夾的 `*.result.json`，完成後呼叫 `/quit`、關分頁、執行 `node scripts/cleanup-orphans.js`。
- 大型檔案的 ORT 比對要用 Electron 的 Node（`ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe`），本機的 Node 是 32 位元，會 ArrayBuffer 配置失敗。

## 5. 使用者原話（逐字，依日期）

以下是使用者在本對話或先前交接中直接說的，逐字保留：

- 2026-11-16：「照計畫接線」（先前交接的開場要求）
- 2026-11-16：「做，先做推論概念驗證，可以的話就接上去」
- 2026-11-16：「盡可能讓使用者gpu成為可用」
- 2026-11-16：「不管哪些查證，請只管實現」
- 2026-11-16：「我有開著claude for chrome, 可以用本地server來驗證」
- 2026-11-16：「Verify the changes you made actually work.」
- 2026-11-16：「Try again」
- 2026-11-16：「同意讀取檔頭」（HF 檔頭的 HTTP Range 讀取，4 MB）
- 2026-11-16：「同意讀取中繼資料」（HF 檔案列表與前 1 MB）
- 2026-11-16：「繼續做第 0 層一步 decode」
- 2026-11-16：「同意下載」（回答我列出 Qwen q4f16 約 570 MB 與 midigen 約 73 MB 的問題）
- 2026-11-16：「該下載的，麻煩都一起下載，別再反覆問」
- 2026-11-16：「同意下載 MOSS」（在本對話直接說的，範圍：MOSS 所需檔案）

**轉述（不是使用者在本對話說的，只能當作管理者的指示參考，不能當作使用者同意）**：「做完才回報」、「一直停下來是有什麼問題嗎」、「不是啊，還再量?!」、「為什麼他又要跳卡片說要不要測!」、「到 60% 門檻才交接」、「把 q4 核心提到注意力前面」、「繼續做 MOSS，我同意下載」（管理者對話中）。

## 6. 交接程序（自我遞迴）

依 low-context-long-run 技能執行：
1. 每個批次結束（一塊做完、驗證、提交）時檢查 context 使用率（`mcp__ccd_session_mgmt__get_usage`）。低於 60% 就繼續做下一項待辦。
2. 到或超過 60%：先把當前批次做完、驗證、提交；若在中途，把半完成的步驟精確寫進本文件（檔案、已完成、剩下、如何接續）。
3. 重寫本文件（同樣的章節順序），提交（訊息寫明是交接），**不推送**。
4. 用 `mcp__ccd_session__start_session`（initiation: "user_asked"，context: "fresh"，同一專案與工作目錄，title：「cudaweb 推論接線 · 交接 N」，prompt 為第 1 節的開場提示）啟動接手者。被拒就重試一次；仍被拒就停下，在最終回報說明原因。
5. 接手者確認接手（讀完文件、說明開始的待辦）後，才可以把本 session 標記完成並封存（不要刪除）。

## 7. 陷阱（已踩過）

- **分類器暫時失敗**：Bash、Edit、Write 偶爾回「auto mode classifier gave no verdict」。這是暫時性錯誤，重試一次即可；連續多次就換別的工作。
- **Chrome 分頁群組會消失**：`tabs_context_mcp` 要用 `createIfEmpty: true` 重建；`javascript_tool` 的輸出有時被擋（`[BLOCKED: Cookie/query string data]`），改用結果檔（`*.result.json`）與頁面標題「驗證完成」判斷。
- **背景下載被 subshell 殺掉**：用 `run_in_background` 直接跑 curl，不要用 `( ... ) &`。續傳（`-C -`）曾產生錯誤大小的檔案，已刪除重下；**一律核對位元組數**。
- **Node 是 32 位元**：大檔（> 500 MB）要用 Electron 的 Node 跑 ORT 或解析。
- **runWgsl 限制**：`dispatchWorkgroups` 只接受一個數字（一維派發），二維要在 shader 內由扁平索引還原（見 `matmulnbits_gpu.js`）。
- **runWgsl 每次重建 pipeline**：速度差，所有速度數字都標「未優化」。
- **onnx_lite 的外部資料**：`tensorBytes` 只讀 inline 的 raw；外部資料（`.data`）要依 `ext.location／offset／length` 自己切（見 `moss_decoder.js` 的 `readInit`）。
- **Identity 別名**：MOSS 圖中的 LN 權重名是 Identity 輸出，要照 `m.aliases` 解析（`readInit` 已處理）。
- **CRLF 警告**：git 的 "LF will be replaced by CRLF" 是正常的，不影響提交。
- **Shell 的 cwd 會被重設**：每次命令都寫完整路徑或 `cd` 到專案目錄。
- **`sed -i` 與 Edit 工具**：修改後要確認；Edit 工具要先 Read 檔案（對自己寫的檔案，Write 後可直接 Edit）。
- **工作區有不屬於本工作的未提交檔**：`web-lazy/*`、`scripts/move-to-e.ps1`、`../wiki/`、`scripts/eval/cudaweb_mlp_sweep.js`，**不要動、不要提交**。
- **下載的模型檔只在 scratchpad**：不要提交，不要引用到 repo 的路徑中。Qwen 與 midigen 檔的使用已被管理者要求停止（使用者要決定留或刪）；MOSS 檔可以用（有使用者同意）。
