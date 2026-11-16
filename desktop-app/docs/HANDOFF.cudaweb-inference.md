# 交接：cudaweb 推論（2026-11-16，第三棒）

## 1. 開場提示（接手者收到的原文）
（門檻已改為 60%，見第 6 節。）請接續 `desktop-app/docs/HANDOFF.cudaweb-inference.md`（專案 `D:\Downloads\videos-嗨投資-desktop-app\desktop-app`，分支 `desktop-app`）：完整讀完（含使用者原話、管理者指示與工作方式）並照著做，執行 low-context-long-run 技能（門檻 30%）：做下一個待辦，到門檻就寫下一份交接並自己啟動接手者（model 用 `claude-haiku-5-5`、effort 用 `high`，與上層的指示一致）。第一則訊息用一行說明你讀過文件、從哪個待辦開始。使用者原話：「我有開著claude for chrome, 可以用本地server來驗證」（2026-11-16）；管理者指示：「先做注意力＋KV 快取（第 1 項），先 CPU 參考版＋測試，再 GPU 核心，先接 Qwen3 0.6B，取第 0 層做一步 decode 與現有輸出比對」。

## 2. 概況
- 專案 `D:\Downloads\videos-嗨投資-desktop-app\desktop-app`，分支 `desktop-app`。管理者（回報對象）：`local_49f6c57d-8f18-427b-a8f1-7b1d23efc5f5`。**尚未推送、尚未發布。**
- **已提交（本輪，新到舊）**：`897917816`（網頁版 lm_head 中繼資料讀取結果，§7.6）、`b84a1c107`（設計 §7.7 更新）、`b12061413`（注意力 GPU 核心 `attn_gpu.js`＋退路測試＋真 Chrome 伺服器）、`6c2e31640`（第 0 層 K／V 對真 ORT 的評估）、`2d9d6621a`（§7.7 進度）、`8be226632`（注意力＋KV 快取 CPU 參考版 `attn_ops.js`＋9 項測試）、`6a1a92c17`（網頁版 lm_head 調查 §7.6）、`e4beaafda`／`2e139db0b`（交接與設計）、`7432e8866`（渲染編排測試 8 項）、`f1cae6209`（桌面版 lm_head 接線）、`6a60c18da`（嵌入 `FA_HEAD_SRC`）。上一棒：`9a30d0573`、`4a754017d`、`0b3e2bc51`。
- **已驗證**：
  - 注意力 CPU 參考版：`node renderer/src/gpu/attn_ops_test.js`（9 項）；GPU 退路：`node renderer/src/gpu/attn_gpu_test.js`（4 項）。
  - 第 0 層 K／V 快取對真 ORT：`ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/eval/cudaweb_attn_layer0.js`，K 相對誤差 1.9e-7、V 3.1e-6。
  - 注意力 GPU 核心在**真 Chrome WebGPU**：`node scripts/eval/cudaweb_attn_browser.js 18766`，用 Claude in Chrome 開 `http://127.0.0.1:18766/`，4 個情境都走 T1，相對誤差 0～2.6e-7。**速度慢於 CPU**（解碼 S=1 過去 40：GPU 36 ms、CPU 5 ms）。
  - 桌面 lm_head（gpuhead）：node 編排測試 8 項（`scripts/eval/cudaweb_head_renderer_mock.js`）與 `head_service_test` 4 項、`infer_ops_test` 7 項過。**真 Electron 未驗證**。
  - 其他：`infer_poc`（MLP、lm_head）在真 Chrome 通過（`cudaweb_infer_browser.js`），是既有結果。
- **未驗證／未做**：注意力輸出（softmax 之後）與 o_proj 對真 ORT；GPU 核心速度；WebGL2 退路；桌面 lm_head 真機；網頁版 lm_head（擱置，見待辦）。
- **執行包注意**：`tests/native/native_lora.test.js` 的 2 項同步檢查會紅（nr-*.js 已改、清單未重算）。重算清單與發布 1.22.0-4 都還沒做，沒有使用者或管理者說「發布」之前不要做。

## 3. 待辦（依序，下一步在最前）
0. **（已完成，2026-11-16，設計見 `DESIGN.webgpu-cuda.md` §7.8）lm_head 接線**：網頁版（主頁面 onnxruntime-web＋q8 ONNX）真 Chrome 通過，提交 `a9a0c5380`、`94c6db0bf`、`7017fb727`；WebGL2 退路（`q8lmGl`／`q8lmAuto`，真 Chrome 相對誤差 5.6e-7）提交 `7f6ea3008`。桌面版接線已存在（`f1cae6209`），模擬測試 8 項過，**真 Electron 未驗證、每個詞元的速度未量**，維持預設關。WebGL2 在這台 Kepler 約 0.9 秒／次，比 ORT CPU 慢，只當功能退路。**未做**：MLP 的 WebGL2 版（只接 lm_head）、transformers.js 的 fp16 lm_head 路徑（第 6 項）。
1. **（已完成，提交 `3c7c77958`）第 0 層完整一層對真 ORT 通過**（殘差後 3.2e-6、MLP down 9.4e-7、層輸出 1.8e-6，`scripts/eval/cudaweb_layer0_full.js`）。**28 層預填對真 ORT：通過（已修正）**（`scripts/eval/cudaweb_model_step.js`，預設 RMSNorm 以 f32 累加）：原先未通過的原因是 RMSNorm 平方和用 double 累加，與 ORT 的 f32 不同，造成第 21 層的量化整數在邊界翻轉。修正後：量化整數 0／3072 不一致、每層隱藏狀態相對誤差 1e-9 量級、logits 相對誤差 5.3e-7、argmax 3/3。**下一步**：見第 6 項（網頁版 lm_head 其實是 fp16，不是 q4；已更正）。之後依序 MIDI、MOSS、卷積派發、Whisper。先前完成的項目：注意力輸出與 o_proj（`419ce7672`）。（`scripts/eval/cudaweb_attn_layer0_out.js`，相對誤差 3.1e-6、3.2e-6）。**下一步**：單層的殘差與 MLP（ORT 的中間張量同樣用 `rewriteOutputs` 取）、再到 lm_head 的 logits，最後才是完整一步解碼。原待辦說明保留如下：進度：還沒有任何新程式。做法建議：參照 `renderer/src/gpu/onnx_lite.js` 的 `buildHiddenStateModel`（它會換掉圖的輸出、刪掉不用的節點），把注意力輸出（softmax 之後、o_proj 之前）與 o_proj 輸出加進 graph outputs，再讓 ORT 跑一次。目標是把注意力輸出（softmax 之後、o_proj 之前）與 o_proj 後的輸出與 ORT 比。ORT 模型沒有輸出那些張量，要用 `onnx_lite.js` 改寫圖（像 `buildHiddenStateModel` 那樣把節點輸出加進 graph outputs），先找節點名（`/model/layers.0/attn/...`，用 `lite.parseModel(...).nodes` 列出）。比對腳本放在 `scripts/eval/cudaweb_attn_layer0.js` 旁邊（新檔，不要改舊的）。CPU 路徑：`A.attentionBlock` 之後接 o_proj（q8 投影，`ops.q8mmRef`）。**完成標準**：相對誤差在 1e-3 內（參照 K／V 的 1e-6 量級）。
2. **GPU 核心速度**：`nn_ops.runWgsl` 每次呼叫都重建 shader 與 pipeline（`createComputePipeline` 很貴），改成依 device＋程式碼快取 pipeline，再量。再考慮分塊或共享記憶體版本。每次都在 Chrome 真 WebGPU 重驗（`cudaweb_attn_browser.js`）。**沒賺就如實寫明、維持預設關。**
3. **WebGL2 退路**：決定做或寫明不做（設計文件 §7.7 目前寫的是「未做」）。建議：注意力用 WGSL＋CPU 兩層即可，WebGL2 對注意力收益不明，寫明不做並請管理者確認。
4. **注意力接線**：管理者說「除非接線需要」才接。第 0 層一步 decode 通過後再判斷，接線要先在 Chrome 驗證。
5. **管理者順序（之後）**：(a) MIDI 桌面原生（midigenai，`music/native_ort.js`）：取 GPU 版單步 logits 與 CPU 版比對，再接線（沿用 gpuhead 做法）；(b) MOSS-TTS-Nano 解碼器：先量 `decode_step` 矩陣乘佔比（`tts/moss_worker.js:9` 計時欄位）再決定；(c) 卷積派發：確認 `cudnn_subset.js` 的卷積有沒有真的派發到 WebGPU，取 Basic Pitch 第一個卷積驗證；(d) Whisper base 編碼器。**每一項**：Chrome 真 WebGPU 驗證、誤差在容差內、如實量速度、提交、回報管理者。
6. **網頁版 lm_head：【更正】不是 q4。** 第二次讀前 4 MB 並解析 protobuf（使用者 2026-11-16 直接同意）確認：lm_head 是 `/lm_head/MatMul`（普通 MatMul），權重是 `Transpose_610` 轉置的 `model.embed_tokens.weight`，dtype **FLOAT16**、形狀 [151936, 1024]（約 311 MB）。投影層才是 `MatMulNBits`（bits=4、block_size=32，無 zero_points）。**下一步**：（a）fp16 矩陣乘的 lm_head（CPU 參考版＋測試，WGSL 要處理 fp16：`shader-f16` 或 u32 打包加 `unpack2x16float`）；（b）若要讓網頁版整段解碼都走 cudaweb，另外規劃 MatMulNBits 核心。每一步都要在 Chrome 真 WebGPU 驗證。**仍然不下載權重**；讀之前先列網址與大小，讓使用者確認。
7. **桌面 gpuhead 真機驗證**：管理者說之後有空檔再補（獨立 `--user-data-dir`、換埠 `FA_BROWSER_CONTROL_PORT`，每項最多跑兩次，臨時指向本機工作目錄的 `nr-*.js`，不發布）。
8. **更新設計文件**：每塊做完更新 `DESIGN.webgpu-cuda.md` 對應的 §7.x 與 §9 進度，沒驗證的明講。
9. **回報**：每塊做完提交後，用 SendMessage 回報管理者（`local_49f6c57d-8f18-427b-a8f1-7b1d23efc5f5`）。

## 4. 工作方式（使用者規則與管理者指示，照抄重點）
- 純中文回覆，不夾英文縮寫／術語（使用者規則）。
- 子工作階段：模型用 `claude-haiku-5-5`、effort `high`（管理者指示）。派工簡報要寫明：歧義自決、不准回頭詢問、速度守則（不空等、不跑整套測試、3 分鐘內有結論）、結束前確認沒留下行程。
- **驗證**：每一塊做完先在 **Claude in Chrome** 真 WebGPU 驗證（本機 server＋Chrome），誤差在容差內才提交（使用者原話：「我有開著claude for chrome, 可以用本地server來驗證」）。**先驗再交（管理者規則）**：桌面 lm_head 的三個提交是先交後驗，已記在第 2 節與第 7 節。
- **不推送、不發布**（管理者指示，這輪）。推送到自己 remote 要先問；發布到正式環境永遠當輪確認。
- 「不管哪些查證，請只管實現」（使用者原話 2026-11-15）：不要花時間在查證，直接做；但自己宣稱的結果要真的驗證（測試跑過、磁碟上看得到）。
- 「盡可能讓使用者 gpu 成為可用」（使用者原話 2026-11-15）：老舊 GPU 也要有退路，不能因為原生做不到就排除。
- 改程式用 Edit／Write 工具，不用 shell 內嵌（heredoc／`node -e` 會吃反斜線與引號）。多數檔案是 CRLF；`embed-code-ui.js` 會把 floating-assistant.js 統一成 CRLF。
- 失敗訊息附具體事實；沒驗證就講「未驗證」；查不出原因就說查不出，不編。
- 殘留行程：結束前跑 `node scripts/cleanup-orphans.js`；驗證用的伺服器要用 `/quit` 關掉；Claude in Chrome 開的分頁要關。**絕不用 `taskkill /IM chrome.exe`**。使用者 Chrome 背景的擴充功能行程不是我們的，不要殺。
- 本機 `node` 是 32 位元（ia32），ORT 執行包只有 x64：要跑真 ORT 的腳本用 `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe <腳本>`。
- `scripts/move-to-e.ps1`（未追蹤）是使用者自己要用的，不要動、不要提交。`web-lazy/*` 工作目錄的修改不是我們的，別提交。

## 5. 使用者與管理者原話（原文，不改寫）
使用者（依日期，新到舊）：
- 2026-11-16：「同意讀取中繼資料」（只讀 HF 中繼資料：檔案清單與檔頭用 Range，不下載權重）
- 2026-11-16：「我有開著claude for chrome, 可以用本地server來驗證」
- 2026-11-16：「照計畫接線」
- 2026-11-16：「做，先做推論概念驗證，可以的話就接上去」
- 2026-11-16：「推論也可以用到嗎?javascript可以也使用道嗎」
- 2026-11-15：「這個cudaweb, 之後完成後，如果接上python,也要成為離線模型的推論，訓練的資源」
- 2026-11-15：「目標請以"盡可能讓使用者gpu成為可用" ，而不是像是做現成的"因為他原生做不到，所以我把它排除"」
- 2026-11-15：「舉例來說, GeForce 8800, 很爛，但他跑得動CUDA 1.0 / RaspberryPi沒有可能有CUDA, 但有人移植了OpenCL上去」
- 2026-11-15：「不管哪些查證，請只管實現」
- 2026-11-15：「欸不對啊 我剛說請你用claude for chrome測試 是想說你可以先用本地server, 然後在claude for chrome測試，然後確認ok了就送上去」

管理者（不是使用者）指示（依日期，新到舊）：
- 2026-11-16（上層 `local_49f6c57d…`）：「選 B：網頁版 lm_head 先擱置（記在 DESIGN §7.6 為「待確認 q4 格式」），直接做注意力＋KV 快取（第 1 項），之後照原順序。A（讀 HF 中繼資料）要使用者直接同意，我會去問，得到同意再通知你；在那之前不要連網讀取任何模型相關檔案。桌面版 gpuhead 那三個提交我先記下，真機 Electron 驗證未做，之後有空檔再補（用獨立 --user-data-dir 與換埠）。」
- 2026-11-16：「順序：1. 注意力＋KV 快取（共用元件）：先 CPU 參考版＋測試，再 GPU 核心（WGSL，並盡可能有 WebGL2 或純 JS 退路），先接 Qwen3 0.6B，取第 0 層做一步 decode 與現有輸出比對。2. MIDI 桌面原生（midigenai，`music/native_ort.js`）…3. MOSS-TTS-Nano 的解碼器…4. 卷積（conv1d、conv2d）的 GPU 派發…5. Whisper base 編碼器。規則：每一項都先在 Claude in Chrome 真 WebGPU 驗證、誤差在容差內、如實量速度；每一塊做完提交並回報我；不要推送、不要發布；更新 DESIGN.webgpu-cuda.md 進度，沒驗證的明講。派子工作階段要用 claude-haiku-5-5 且 effort high（我已告知過）；你自己到 30% 門檻就依 low-context-long-run 寫交接，接手者也要帶 model 與 effort。」
- 2026-11-16（desktop-app 工作階段轉述）：「先做網頁版…（已擱置）；2. 再做桌面版…；3. 注意力與 KV 快取先不做，除非接線需要。不要推送、不要發布。」

## 6. 交接流程（自我遞迴）
執行 low-context-long-run 技能，**門檻 60%**（管理者轉達使用者 2026-11-16 原話：「haiku應該可以到 60%再交接」，取代原本的 30%）：每個批次結束（已提交）讀 `mcp__ccd_session_mgmt__get_usage` 的 `context.percentUsed`，到 60% 就改寫本文件、提交、用 `mcp__ccd_session__start_session`（`initiation: "user_asked"`、`context: "fresh"`、同一個資料夾、同一個分支，model `claude-haiku-5-5`、effort `high`）啟動接手者，等它確認讀過文件並開始第一個待辦，才把自己標完成並封存（不刪除、不 clear）。管理層最上層工作階段不封存。待辦清空且驗證完就不再交接，改為回報完成。

## 7. 陷阱
- 讀 Chrome 頁面的輸出時，`javascript_tool` 的文字曾被擋（`[BLOCKED: Cookie/query string data]`）。改從伺服器寫出的結果檔讀（`cudaweb_attn_browser.result.json` 在系統暫存資料夾，`cudaweb_infer_browser.result.json` 在 `scripts/eval/`）。
- `nn_ops.runWgsl` 每次都重建 shader 與 pipeline，GPU 核心因此很慢。不要因為單次 GPU 數字慢就判定核心錯了，先看是不是這個原因。
- `attn_gpu.js` 的退路 `tryLayers` 只在 node 沒有 WebGPU 時才會走到 cpu-js。在 Chrome 要確認 `info.layer === 'T1'`，否則數字是 CPU 來的。
- `scripts/eval/cudaweb_attn_layer0.js` 比對的是 K／V 快取，不是注意力輸出；不要把它的通過當成整層通過。
- ORT 模型的 KV 快取是 `[1, Hkv, S, hd]`（BHSD），我們的快取是 `[S, Hkv, hd]`（SHD）；比對時要換索引（見評估腳本的 `cmp`）。
- Qwen3 的 RoPE 是 rotate-half、theta 1e6；`nn_ops.ropeRef` 是交錯配對、base 10000，**不能重用**（`attn_ops.js` 自己寫了 `ropeHalf`）。
- 網頁版瀏覽器沒有 `Buffer`；`onnx_lite.js` 的 `buildHiddenStateModel` 全程用 Buffer，要改成 Uint8Array 版才能在網頁用。
- 網頁版 Qwen3 的 GPU 格式是 `q4f16`（`FaVlm` 的 dtype 表），cudaweb 的 lm_head 核心只支援 q8，所以網頁版 lm_head 被擱置。
- `floating-assistant.js` 內嵌的來源模組（`FA_HEAD_SRC`、`FA_GPU_CORE_SRC` 等）要改來源（`renderer/src/gpu/*`），改完跑 `node scripts/embed-code-ui.js`；不要改嵌入後那份。新增來源模組要照 `scripts/embed-code-ui.js` 登記。
- 信箱讀取：渲染端不能用 `rawfs.rename`（沒有這個 IPC），head 服務在沒有 rename 時直接寫 `.res`（主程序會等寫完整的 JSON）。
- `lm_q8.bin` 約 155 MB，渲染端用 base64 經 IPC 讀入（約 207 MB 字串），有上限風險；之後若要改成分段讀，要另外做。
- 本機的 `native-models/qwen3-0.6b-q8` 是 q8 格式，不是網頁版的 q4f16；不要拿它當網頁版的代表。
- 第 0 層一步 decode 的 ORT 輸入：必須同時給 `input_ids`、`attention_mask`、`position_ids`，以及 28 層的 `past_key_values.N.key/value`（空的 `[1,8,0,128]`）。
- 前一棒的錯誤：`6a60c18da`、`f1cae6209` 是先交後驗（違反「先驗再交」）。真機問題要回退或修正那三個提交。
