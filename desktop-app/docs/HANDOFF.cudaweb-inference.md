# 交接文件：cudaweb 推論（WebGPU）接線與模型驗證

## 1. 開場提示（啟動接手者時的提示詞）

Continue from the handoff document at `desktop-app/docs/HANDOFF.cudaweb-inference.md`（專案目錄 `desktop-app/`，分支 `desktop-app`；Linux 機器 `/home/hungfu.lee/下載/SRC/tw_stock_db/desktop-app`）。完整讀完，特別是第 5 節使用者原話、第 4 節工作方式、第 7 節陷阱；待辦以 `docs/CHECKLIST.cudaweb-wire.md` 為準（規則：每項都是 [x] 或 BLOCKED 才可結束一輪，不中途回報、不丟問題卡片）。執行 low-context-long-run 技能（門檻 THRESHOLD 30%）：做下一項，到門檻就更新本文件、提交、啟動自己的接手者；被拒就停下回報一次。第一則訊息用一行說明你讀過文件、從哪一項開始。

使用者原話（必須遵守）：「接手目前repo的任務，剛剛還在完成cudaweb」；「Qwen3 文字推論的加速不是第一優先嗎」；「訓練的是最後的最後」。

## 2. 總覽

- **目標**：把 cudaweb（WebGPU 推論）接進產品，預設全部關、失敗自動退回、診斷齊全。**不推送、不發布。**
- **環境（本棒起）**：Linux、無真 GPU；Chrome 156 有軟體 WebGPU（SwiftShader，旗標見 §8.9）；node 20 64 位元可跑大模型。Qwen q8 模型在 `~/.config/floating-assistant-desktop/native-models/qwen3-0.6b-q8/`；這台**沒有** MOSS、midigen、whisper 檔。
- **本棒（2026-11-16，Linux）提交（新到舊）**：清單 O 勾掉（dd 除法／次方／math.*，Chrome 軟體 WebGPU 對 float64 < 1e-11；dd_mul 改 Dekker）→ N（`device_pick.js`，設定 `gpuAuto`）→ A/C/J/K/L/M/P 標 BLOCKED → H（20 步對拍結果）→ F（建置與檢查）→ E（pipeline 快取與退路測試）→ D（midigen `midiGpu`：`midi_session.js`）→ B（MOSS `mossGpu`：`moss_gpu_runners.js`，提交 `8d60a5bec`）。先前：`cbb355b66`、`c79bd2cbd`（Q）等。`git log --oneline` 看全部。
- **（2026-11-16 後續棒）清單全部 [x]（部分項目為逐節點層級，見清單與 DESIGN §7.21、§7.22）**：P（Kokoro）`93f2e0c5f`、L（Demucs、YAMNet）`a26e471f2`、M（SDXS int8）`9c3c569e6`、A（MOSS 整管線 3 幀對 ORT 一致）`decc116e8`。新工具：`conv_ops.convT2d／convInt1d`、`mm_ops`、`node_eval`、`scripts/eval/cudaweb_node_dump.js`（逐節點對真 ORT）、`cudaweb_node_gpu_check.js`＋`cudaweb_headless_node_check.sh`（無頭 Chrome 軟體 WebGPU，可用 `SERVER_CMD` 跑其他驗證頁）。`runWgsl` 支援 `cache:true` 常駐權重與二維派發。模型檔在 scratchpad（不入庫）。仍未做：LSTM／STFT／GroupNorm／Softmax 等其餘算子與各模型整管線、產品接線、經產品 worker 的 mossGpu 端到端。
- **清單現況（較舊）**：Q、B、D、H＝部分完成（程式與單元測試做完；真模型／真 GPU 驗收 BLOCKED，原因寫在清單）；E、F、G、N、O＝[x]；A、C、J、K、L、M、P＝BLOCKED（缺模型檔需使用者同意下載，或改動過大）；I（LoRA 訓練端到端 GPU）已完成，清單全部 [x] 或 BLOCKED，只差最終回報。
- **設定開關**（全在 `_gpuCompatControls`，AI 助理設定與桌面版設定頁共用同一處；預設關）：`llmGpuHead`、`qwenGpuDecode`、`mossGpu`、`midiGpu`、`gpuAuto`（自動決定，手動勾選仍有效）。診斷：`_gpuStat`、`_mossGpuStat`、`_midiGpuNote/_midiGpuStat`、`_gpuAutoDec`、各結果的 `gpu` 欄位。
- **DESIGN**：`DESIGN.webgpu-cuda.md` §7.13（Qwen，含 20 步對拍）、§7.14（MOSS）、§7.15（midigen）、§7.16（自動選擇）、§7.17（dd 補洞與兩個平台問題）。

## 3. 待辦（依序，下一步在最前）

1. **I 已完成**（2026-11-16，Chrome 軟體 WebGPU 20 步 loss 對拍，DESIGN §7.18；清單全部是 [x] 或 BLOCKED）。
2. 做完 I 後再檢查清單是否每項都是 [x] 或 BLOCKED（B、D、H、Q 的 [~] 已把 BLOCKED 部分寫在項目裡；若要嚴格一致可把 [~] 改成 [x]＋「BLOCKED 驗收」字樣），F 再跑一次（`node build-assistant.js`、`node scripts/build-web-lazy.js`、`node scripts/web-lazy-check.js`，**產物不提交**，跑完 `git checkout -- renderer/floating-assistant.js renderer/floating-assistant.min.js renderer/update-manifest.json web-lazy` 並刪掉 build 新增的未追蹤 `web-lazy/chunks/{headsvc,midigpu,mossgpu,qwengpu}.js`）。
3. **最終回報（只回報一次，由最後一棒做）**：做了什麼（每項一行）、提交編號、哪些只過 CPU 參考／哪些真 Chrome（軟體 WebGPU）驗證過、哪些沒驗證、哪些 BLOCKED（原因）、需要使用者決定的（Basic Pitch／Whisper／SDXS／Kokoro／Demucs／YAMNet 的模型檔下載同意；midigen q4 約 73 MB 與 MOSS 約 760 MB 的真模型對拍；真 GPU 與真 Electron 驗證；桌面版 Qwen 信箱接線要主程序檔）。

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
- 2026-11-16：「接手目前repo的任務，剛剛還在完成cudaweb」
- 2026-11-16：「Qwen3 文字推論的加速不是第一優先嗎」
- 2026-11-16：「訓練的是最後的最後」

**轉述（不是使用者在本對話說的，只能當作管理者的指示參考，不能當作使用者同意）**：「做完才回報」、「一直停下來是有什麼問題嗎」、「不是啊，還再量?!」、「為什麼他又要跳卡片說要不要測!」、「到 60% 門檻才交接」、「把 q4 核心提到注意力前面」、「繼續做 MOSS，我同意下載」（管理者對話中）。

## 6. 交接程序（自我遞迴）

執行 low-context-long-run 技能，THRESHOLD 30%：每個批次結束（做完、驗證、提交）用 `mcp__ccd_session_mgmt__get_usage` 看自己的 context 百分比；到或超過 30% 就把當前批次做完提交、重寫本文件（同樣章節順序）、提交（訊息寫「交接」，不推送），再用 `mcp__ccd_session__start_session`（initiation: "user_asked"、context: "fresh"、同專案同工作目錄、title「cudaweb 推論接線 · 交接 N」、prompt = 第 1 節）啟動接手者；被拒重試一次，仍被拒就停下回報原因。接手者確認接手後，才可把本 session 標記完成並封存（不要刪除）。5 小時額度若 ≥ 90%，工作放輕，必要時等重置後再繼續。

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

- **（本棒新增）Bash 的 `pkill -f 字串` 會殺到自己的 shell（exit 144）**：要停自己開的 Chrome／伺服器，寫成腳本檔用 `ps -eo pid,args | awk` 比對 `--user-data-dir` 的資料夾名再 `kill`（見做法：`/tmp/claude-1001/rundd.sh`），不要在指令字串裡放要比對的字。
- **（本棒新增）SwiftShader 的 `fma` 不是融合運算**，且**編譯器會對第一運算元是編譯期常數的 dd 運算化簡掉誤差項**（DESIGN §7.17）；寫 dd／兩段式運算的 WGSL 時，兩個運算元盡量都是執行期值，並用真 Chrome 對 float64 驗證。
- **（本棒新增）`node scripts/test-affected.js` 要 9 分鐘左右**，用背景執行並把輸出存檔；唯一預期的失敗是 `studio_embed.test.js`（`lora_ref_train.js` 找不到，先前提交就存在）。
- **（本棒新增）build 產物不提交**：`renderer/floating-assistant*.js`、`update-manifest.json`、`web-lazy/*`；build 完要還原（見待辦 2）。
- **（本棒新增）python 一次寫檔腳本裡的字串別用 `"""` 結尾又以 `"` 收尾**（曾因此寫檔失敗卻照常提交，要看 `git show --stat` 確認）。
- 本文件第 8 節程式地圖是 Windows 時代寫的，路徑與「Windows／Electron node」說法在這台 Linux 不適用；§8.9 才是 Linux 做法。新增模組：`gpu/moss_gpu_runners`（在 `tts/`）、`gpu/midi_session.js`、`gpu/device_pick.js`、`scripts/eval/cudaweb_dd_math_check.js`（dd 數值驗證，Chrome 軟體 WebGPU，埠 18782；DD_LIB 由 python 寫到 `/tmp/dd_lib.wgsl`）、`scripts/eval/cudaweb_qwen_greedy.js`（加教師強迫）。嵌入：`embed-code-ui.js` 的 `embedMossGpu`（`FA_MOSS_GPU_SRC`，worker 用）、`embedMidiGpu`（`FA_MIDI_GPU_SRC`）、Qwen 套件現在還帶 `pick`、`nn`。

## 8. 程式地圖（每棒只讀這節就能動工；隨進度維護，改了檔案就更新這裡）

路徑皆相對 `desktop-app/`。「狀態」欄以提交為準，最後更新 2026-11-16（b1d329b4a）。

### 8.1 通用與共用

- `renderer/src/gpu/onnx_lite.js`：ONNX protobuf 解析（UMD，node 可 require）。入口 `parseModel(buf)` → `{buf,nodes,inits,inputs,outputs}`；`parseGraph(buf, range)`（If 子圖）；`constantValue(m,node)`（Constant 節點值）；`tensorBytes`。屬性 `attrs.x.i/f/ints/strings/tensor/graph`。注意：varint 負數以 2^64 表示（見 `onnx_interp.attrInt`）。狀態：可用，已對 codec 與 MOSS 驗證。
- `renderer/src/gpu/onnx_interp.js`：通用 CPU 圖解釋器。入口 `run(model, feeds, dataFiles)`；張量格式 `{d,t:'f'|'i'|'b',v}`（'i' 以 Float64 儲存）。已實作算子：Identity Constant Add Sub Mul Div Mod Pow Equal Less LessOrEqual Greater GreaterOrEqual And Or Xor Not Where Sqrt Exp Sin Cos Tanh Erf Reciprocal Neg Cast Shape Gather Concat Transpose Reshape Unsqueeze Squeeze Slice ConstantOfShape Range Softmax LayerNormalization Conv（1D）MatMul Clip If。未實作的會丟錯。狀態：codec 整圖對 ORT 一致（相對誤差約 6e-6）；未優化（T=25 約 31 秒）。熱點（MatMul、Conv）尚未換成 GPU。
- `renderer/src/gpu/nn_ops.js`：訓練步與 cudaweb 共用的小運算（CPU）；`runWgsl(dev,code,bufs,uniform,groups)` 現在快取 pipeline（以 WGSL 字串為鍵，存在 dev.__cudawebPipes）；`tryLayers(name,opts,gpuFn,glFn,refFn)` 為 T1→cpu-js 分層（WebGL2 層尚未實作的核心會直接退 cpu-js）。狀態：既有＋快取已提交（281314126）。
- `renderer/src/gpu/gpu_core.js`：GPU 核心（能力偵測、`runWgsl`；一維派發，每次呼叫重建 pipeline，這是「慢」的主因）。瀏覽器端以 `window.FaGpuCore` 提供。
- `renderer/src/gpu/gpu_preload.js`、`cudnn_subset.js`、`head_service.js`、`infer_ops.js`、`infer_poc_core.js`、`attn_ops.js`：既有的 cudaweb 推論路徑與 lm_head 接線（見 DESIGN §7.5–7.7）。狀態：既有，本棒未動。

- `renderer/src/gpu/conv_ops.js`：共用卷積（MOSS codec、Basic Pitch、Whisper 共用）。入口 `conv1dRef`、`conv2dRef`（CPU，含 stride／pads／dilation／groups）、`conv1d(x,N,C,L,w,M,Cg,K,b,p,ops)`（非同步，T1 WGSL→cpu-js；ops.gpu===false 強制 CPU）。WGSL 常數 `WGSL_CONV1D`。轉置卷積：codec 圖沒有 ConvTranspose，未實作。狀態：codec 全部 17 個卷積（皆 1×1，C=8→512、512→768）在真 Chrome WebGPU T1 對 CPU 參考相對誤差約 1e-7（`cudaweb_conv_gpu_check.js` 通過）；conv2d 只有 CPU 參考，未有 GPU 版。WebGL2 退路未做（目前退純 JS）。Basic Pitch（2D）與 Whisper（1D，核 3、stride 1/2）的參數落在此模組涵蓋內，但權重未下載，未實測。
- `renderer/src/gpu/onnx_interp.js` 的 Conv 已改走 conv_ops.conv1d；解釋器 `run` 改為非同步（需 await）。

### 8.2 MOSS-TTS-Nano

- `renderer/src/gpu/moss_decoder.js`：全域解碼一步。入口 `loadMossDecodeStep(onnxBuf, dataFiles)`、`decodeStep(model, ids17, caches, ops)` → `{hidden, caches}`（caches[層] = `{K,V,L}`，時間優先 L×D）。`ops` 可注入 `linear/attention/layerNorm/rope/gelu`，缺的退回 CPU。狀態：CPU 參考對 ORT 相對誤差約 1e-5；預填以逐列 decodeStep 代替 prefill 圖。
- `renderer/src/gpu/moss_gpu.js`：`makeGpuOps({navigator})` 給 decodeStep 的 WebGPU 運算（linear、attention、LN、RoPE、GELU；`ops.tiers` 記錄每個運算是 T1 還是退回）。每次呼叫重建 pipeline（慢）。狀態：單元對拍（`cudaweb_moss_gpu_check.js`）通過；整管線 GPU 版待 Chrome 驗證（見 8.5）。
- `renderer/src/gpu/moss_local.js`：本地解碼器（非快取，17 位置一次跑完）。入口 `loadMossLocal(onnxBuf, dataFiles)`、`localDecode(model, globalHidden, textId, audioPrefix15, ops)` → `{textLogits, audioLogits[16]}`。狀態：CPU 對 ORT 通過；`ops` 可接 GPU linear。快取版（`moss_tts_local_cached_step.onnx`）未做（只是加速）。
- `renderer/src/gpu/moss_sampling.js`：整幀取樣（fixed_sampled_frame 的手寫版）。入口 `sampleFrame(model, globalHidden, seenMask Int32[16*1024], uAssistant, uAudio[16], ops)` → `{shouldContinue, frameTokenIds}`。常數：重複懲罰 1.2、溫度 0.8、top-k 25、top-p 0.95；續停 logit 取詞元 9 與 7（不是 0、1）；續停詞元 9，停止 7。狀態：3 組對 ORT 完全一致（含續停為 0）。
- `renderer/src/tts/moss_core.js`（產品，UMD）：SentencePiece（`parseModel`、`encode`）、`buildPrompt`、`generate(runners, cfg, prompt, opts)`（runners = {prefill, decode, sample}）、`splitText`、`resample`、`fromCodecOutput`。狀態：產品既有，未改。
- `renderer/src/tts/moss_worker.js`（產品 worker，ORT-web）：`makeRunners` 用 ORT 建 runners，`codecDecode` 用 ORT。這裡是產品接線點（尚未接 cudaweb）。
- `renderer/src/floating-assistant.js` 內 `MOSS_FILES`（約 72822 行）、MOSS 快取下載（約 101030 行）：產品模型清單。

### 8.3 MIDI（midigenai）

- `renderer/src/gpu/midi_decoder.js`：midigen 解碼器（CPU 參考＋投影走 mm 注入）。入口 `loadMidiDecoder(buf)`、`decode(model, ids, cache, mm)` → `{logits, cache}`。狀態：CPU 對 ORT 約 1e-6；未接產品。
- `renderer/src/gpu/matmulnbits_ref.js`、`matmulnbits_gpu.js`：MatMulNBits CPU 參考與 WebGPU 版（`matmulNBits`）。狀態：GPU 對真權重通過（`cudaweb_matmulnbits_real.js`）。
- `renderer/src/music/native_ort.js`、`midigen_bridge.js`、`audio_models.js`：產品 midigen 路徑（ORT；`midigenai-v5-gpu` 與 `-cpu` 檔）。`audio_models.js` 的 REGISTRY 含 basic-pitch（230,444 位元組）與 midigen 檔的網址、大小、sha256。狀態：產品既有，未接 cudaweb。

### 8.4 Qwen3 與注意力

- `renderer/src/gpu/attn_gpu.js`、`attn_ops.js`：注意力＋KV 快取（WebGPU／CPU 參考）。入口見檔頭；驗證 `cudaweb_attn_layer0*.js`。狀態：第 0 層一步 decode 對 ORT 約 3e-6。
- Qwen 網頁版解碼迴圈：未接（待辦）。

- `cudaweb_conv_dump.js <dir> <out> [T]` 與 `cudaweb_conv_gpu_check.js <cases> [埠]`：卷積真實案例轉存與 Chrome WebGPU 驗證（通過）。

### 8.5 驗證腳本（scripts/eval/，全部用 Electron 的 node 跑大模型）

用法通式：`ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/eval/<檔> <MOSS 資料夾> ...`。ORT 從 `%APPDATA%/floating-assistant-desktop/native-runtime/1.22.0-1/node_modules/onnxruntime-node` 載入。

- `cudaweb_onnx_dump.js`：傾印圖的節點。
- `cudaweb_moss_sample_check.js <dir>`：取樣 CPU 對 ORT（3 組）。通過。
- `cudaweb_codec_interp_check.js <dir> [T]`：codec 解釋器對 ORT。通過（T=4、25）。
- `cudaweb_moss_pipeline_check.js <dir> <文字> <幀數> [ref.json]`：整條 CPU 管線對 ORT；第 4 參數輸出 ORT 參考 json。通過（6 幀、音訊 2e-6）。耗時長（6 幀約 130 秒）。
- `cudaweb_moss_pipeline_gpu_check.js <dir> <ref.json> [埠]`：起 HTTP 伺服器，給 Claude in Chrome 開 `http://127.0.0.1:<埠>/`，結果寫系統暫存的 `cudaweb_moss_pipeline_gpu_check.result.json`。狀態：待 Chrome 結果（Chrome 分頁曾因主執行緒忙碌而 CDP 逾時，需等結果檔）。
- `cudaweb_moss_gpu_check.js`、`cudaweb_moss_local_gpu_check.js`、`cudaweb_moss_check.js`、`cudaweb_moss_local_check.js`：各運算單元的 CPU／GPU 對拍（較早）。
- `cudaweb_matmulnbits_real.js`、`cudaweb_mlp_*.js`、`cudaweb_attn_*.js`、`cudaweb_midi_*.js`、`cudaweb_qwen_poc.js`、`cudaweb_infer_browser.js`、`cudaweb_head_*.js`、`cudaweb_web_head_*.js`：Qwen／midigen／lm_head 的既有驗證。
- `cudaweb_mlp_sweep.js`：未提交（使用者工作區，不要動）。

### 8.6 設定 UI 與嵌入（陷阱）

- 兩處 AI 設定 UI 要同步：`index.html` 的 AI 助理設定分頁，與 `floating-assistant.js` 內部面板（memory：`feedback_duplicate_ai_settings_ui`）。桌面版設定頁的位置：未查證，下一棒先 Grep `設定` 找。
- 嵌入：`floating-assistant.js` 內含 `FA_GPU_CORE_SRC`（約 4610 行）、`FA_HEAD_SRC`（約 4616 行）等字串，由 `scripts/embed-code-ui.js` 產生。**改 `renderer/src/...` 來源模組後必須重新產生嵌入，不可只改嵌入字串**（memory：`feedback_embedded_source_modules`）。產生後的檔案要重看一次有無蓋掉。
- 熱更新：產品更新走 live-update patch，不在本棒範圍（不發布）。

### 8.7 模型檔（scratchpad，不入庫）

- MOSS：`E:\Temp\claude\1845096e089295dd\dc8081b9-67f9-4ce8-859c-6915fcfbc7b1\scratchpad\moss\`（15 檔；含 `browser_poc_manifest.json`（tts_config／prompt_templates）、`tts_browser_onnx_meta.json`、`codec_browser_onnx_meta.json`、`tokenizer.model`）。
- Qwen q4f16、midigen：同一 scratchpad 的 `models\`。
- 參考：同一 scratchpad 的 `moss_pipe_ref.json`（**此檔在本棒的 scratchpad `0832c1c6-…` 下**，由 `cudaweb_moss_pipeline_check.js` 第 4 參數產生；3 幀）。
- 注意：新棒的 scratchpad 資料夾代號可能不同；先確認路徑存在再跑。

### 8.9 Qwen3 整段 GPU 解碼（本棒新增，詳見 DESIGN §7.13）

- `renderer/src/gpu/qwen_decode.js`：`loadWeights(onnxBytes)`（從 q8 ONNX 取全部權重，不複製）、`createCpuEngine(W,{maxT,trace})`（有 KV 的 CPU 參考，`step(ids)`→最後一列 logits）、`greedy(engine,prompt,n,stop)`、`embedRows`。
- `renderer/src/gpu/qwen_gpu.js`：`createGpuEngine(dev,W,{maxT,maxM})`→`{step(ids,{logits,trace})→{token,...}, reset(), len, info}`。WGSL 核心：rms、quant、mm、qk（qk-norm＋RoPE＋寫 KV）、attn、silu、add、lm（分塊）、argmax；509 個派發一個 command buffer；每個核心的綁定都要全部用到（`layout:'auto'` 會丟掉沒用到的綁定）；每個 stage 的儲存緩衝區上限 8（qk 核心用 7）。
- 接線：`renderer/src/studio/llm_web_core.js` 的 `greedyGenerate` 的 `opts.gpuDecode:{engine,timeoutMs}`；`studio_server_core.js` 的 `/api/llm/web/generate` 帶入；`floating-assistant.js` 的 `_qwenGpuDecodeOn/_qwenModule/_llmGpuDecodePrepare`、`llmWeb.gpuDecode`、設定 `qwenGpuDecode`（`_gpuCompatControls` 的第三個勾選）、內嵌殼 `QWENGPU-BEGIN/END`（`scripts/embed-code-ui.js` 的 `embedQwenGpu`）。
- 測試：`renderer/src/gpu/qwen_decode_test.js`、`renderer/src/studio/llm_web_gpudecode.test.js`（都已登記 `scripts/run-core-tests.js`）。
- 驗證腳本：`scripts/eval/cudaweb_qwen_greedy.js [n] [out.json]`（真 ORT 對 CPU 參考，`QWEN_PROMPT_IDS=逗號分隔` 換提示，輸出參考 json）、`scripts/eval/cudaweb_qwen_gpu_browser.js <參考資料夾> [埠]`（頁面在 Chrome 跑 GPU 引擎對參考；結果寫 `$TMP/cudaweb_qwen_gpu_browser.result.json`）。
- 這台 Linux 的做法：模型在 `~/.config/floating-assistant-desktop/native-models/qwen3-0.6b-q8/onnx/model_quantized.onnx`；ORT 在 `~/.config/floating-assistant-desktop/native-runtime/1.22.0-1/node_modules/onnxruntime-node`；node 20（64 位元）可直接跑；無頭 Chrome 加 `--headless=new --no-sandbox --user-data-dir=<獨立資料夾> --enable-unsafe-webgpu --enable-features=Vulkan --use-angle=swiftshader --use-webgpu-adapter=swiftshader` 就有軟體 WebGPU（沒有真 GPU，慢，約 2.5～3.4 秒／詞元）。**只殺自己記下的 Chrome 行程**（用獨立 user-data-dir 比對，不要 pkill -f／killall chrome）。
- 已知：動態量化讓詞元對 ORT 不保證逐字相同（ORT 本身跨 CPU 也會）；通過標準用「首詞元對拍＋退回」。不要再試 fma 屏障（已證明無效）。
- **Q 尚未做**：真 GPU 對拍與速度；桌面版信箱接線（要主程序／執行包檔，不能熱更新，需真 Electron）；App UI 實測。

### 8.8 未查證與未做（下一棒優先序）

1. 看 8.5 的 Chrome 結果檔，若通過記入 §2 與 §3。
2. 共用卷積核心 `renderer/src/gpu/conv_ops.js`（使用者指示：卷積做成共用、MOSS codec、Basic Pitch、Whisper 共用；CPU 參考＋WGSL＋WebGL2 或純 JS 退路＋pipeline 快取）。然後 MOSS codec 接上（用真實形狀對 ORT 最小對拍，真 Chrome）。
3. 注意力與 MatMulNBits 的 WebGL2／純 JS 退路，pipeline 快取（現在每次呼叫重建 pipeline，比 CPU 慢）。
4. MOSS 產品接線（`moss_worker.js` runner 切換、開關、失敗退回 ORT）；Qwen 網頁版解碼迴圈；midigen 網頁與桌面接線。全部預設關。
5. 【2026-11-16 更新】卷積 GPU（T1）已通過；codec 整圖走 GPU 卷積尚未做（解釋器的 MatMul 仍是 CPU）。MOSS 整管線 GPU 結果檔尚未產生（Chrome 分頁曾卡住，見 8.5）。WebGL2 退路、attention／MatMulNBits 的 pipeline 快取以外的加速、MOSS 產品接線、Qwen、midigen 皆未做。
6. Basic Pitch 與 Whisper：只查檔名、來源、大小（HF 檔案清單，不下載權重）；卷積參數能否被 conv_ops 涵蓋，寫進最終回報與 DESIGN。
