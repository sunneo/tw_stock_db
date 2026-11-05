# 其他模型是否也走原生執行器（唯讀調查，2026-11-05）

> 狀態：階段 1～3 已實作並驗證（見第 7、8 節）；第 1～6 節是 2026-11-05 的調查與計畫原文（其中「不改 nr-protocol」等做法與第 8.1 節不同，以第 8 節為準）。
> 標記：「實測」＝有實際跑過或文件記有量測結果；「推測」＝沒有量測，只是依模型結構或經驗估計；「未查證」＝本次沒有追到證據。

## 開頭：共識（must）

1. 子程序與主程序之間只用標準輸入輸出（一行一則 JSON）加進度檔 progress.jsonl 溝通；不用網路服務端的做法、不開本機埠、不用任何網路通道。
2. Windows 與 Linux 都要實作與驗證；Mac 不必須，但程式不寫死平台。
3. 不要求使用者重新安裝；原生執行包按需下載到使用者資料夾。舊版安裝也要能收到。
4. 下載任何模型檔前，先顯示檔名、來源、大小，並取得使用者同意。安裝與下載前一律先問。
5. 桌面版原生優先；原生不可用或沒下載時，退回網頁版原路徑（WebGPU／WASM），並顯示實際後端與真實原因。網頁版原路徑保留，不刪。
6. 原生只跑 CPU。DirectML 在 qwen3-0.6b 的某個節點失敗，本次範圍不含 DirectML；Linux 的 CUDA 目前只是規劃，未實跑。
7. 設計定稿後直接實作：第一階段是量測，量測結果出來後直接接著做，不另開設計會議。
8. 不用 Python；子程序以 process.execPath 加 ELECTRON_RUN_AS_NODE=1 執行（沿用 native-runner 既有做法）。
9. **後端選擇規則（管理層補充共識，所有模型一致，使用者原話：「選的是 webgpu 版，就不用透過原生；選的是 cpu 版，就直接跑 native」）**：
   - 使用者選 webgpu → 只走網頁版 WebGPU，不碰原生。（與「選cpu才走原生」一致：只有 cpu 才走原生。）
   - 使用者選 cpu → 直接走原生（已安裝且可用）；原生失敗才退網頁版 WASM，並顯示真實原因。
   - 使用者選 auto → 有可用 WebGPU 就走 WebGPU；沒有就按 cpu 處理（原生優先，失敗退 WASM）。
   - 因此逐模型的評估重點是「cpu 路徑：原生 CPU 對 WASM 值不值得」。WebGPU 路徑不受原生影響，不拿原生去比 WebGPU 來做取捨，只在量測表中記錄供參考。

共識來源：`skills/weak-model-harness/references/consensus/native-runner.json`，完整設計與進度見 `DESIGN.TODO.native-runner.md`。

---

## 1. 模型清單盤點

### 1.1 圖像、影片、音訊相關模型（使用者列出的範圍）

下表每列一個模型。「執行方式」欄說的是網頁版（渲染程序）現在怎麼跑；所有 transformers.js 模型都經由 `_ensureTransformersJsLoaded`（`renderer/src/floating-assistant.js`，transformers.js 3.7.5 來自 cdn.jsdelivr.net，約第 49090 行）載入。

| 模型 | 用途 | 檔案與大小（登錄值） | 執行方式 | 載入與推論位置 | 前後處理位置 | 張量輸入輸出（實測或讀程式） | 桌面版已測速度 | 模型存放位置 |
|---|---|---|---|---|---|---|---|---|
| **Florence-2 base（ft）** | 看圖：描述、詳細描述、OCR、物件 | 登錄 gpu 約 344 MB、cpu 約 208 MB；repo `onnx-community/Florence-2-base-ft`，未釘版本（用 `resolve/main`） | transformers.js，WebGPU（embed fp16、視覺 fp16、編碼與解碼 q4）或 WASM（embed q8、視覺 q4、編碼解碼 q4） | `renderer/src/vlm/vlm_core.js:14`（登錄）；推論在 VLM Worker（`faVlmWorkerMain`，`web-lazy/core.js` 內） | 分詞與生成迴圈在 transformers.js 內；圖像縮放正規化在 transformers.js 的 processor 內（未逐行核對） | 視覺編碼器輸入 pixel_values 約 [1,3,768,768]（推測，依 Florence-2 結構）；輸出 token ID | 實測（登錄註記）：CPU 4 執行緒，簡短描述約 34 秒（含下載與載入），詳細描述約 21 秒 | IndexedDB 不是；在瀏覽器 Cache Storage（`env.useBrowserCache = true`，`floating-assistant.js:50967`、`63534`） |
| **SmolVLM 256M** | 看圖，可以問問題 | 登錄 gpu 約 200 MB、cpu 約 203 MB；repo `HuggingFaceTB/SmolVLM-256M-Instruct` | transformers.js，WebGPU 或 WASM | `vlm_core.js:18` | 同上（transformers.js 內） | 未逐項核對 | 登錄註記：CPU 約 16～38 秒、Intel GPU 約 10 秒，`verified: false` | 同上 Cache Storage |
| **ViT-GPT2** | 一句話描述（最簡單） | 登錄 cpu 約 238 MB（q8）；repo `Xenova/vit-gpt2-image-captioning` | transformers.js，WASM 為主 | `vlm_core.js:22` | 同上 | 未核對 | 實測（登錄註記）：CPU 4 執行緒約 2 秒 | 同上 Cache Storage |
| **Depth Anything V2 Small** | 深度估計，給 /image-to-3d 當基礎層 | 登錄 gpu（fp16）約 50 MB、cpu（fp32）約 99 MB；repo `onnx-community/depth-anything-v2-small`，約 25M 參數 | transformers.js；CPU 用 fp32（int8 在 WASM 缺 ConvInteger，載不進去，實測） | `vlm_core.js:52`（登錄）、`vlm_core.js:69`（預設）；使用端 `renderer/src/edit/edit3d_host.js:486` 起 | 深度圖後處理（`renderer/src/media/image3d_core.js`，建網格與封閉檢查，純 JS） | 輸入約 512×384 的影像（實測尺寸）；輸出單通道相對深度圖（推測） | 實測（登錄註記）：CPU（WASM，fp32）512×384 約 8～10 秒 | Cache Storage |
| **SlimSAM 77（uniform）** | 分割：自動分物件，給 /image-to-3d --segment | 登錄 gpu（fp16）約 22 MB、cpu（q8）約 16 MB；讀檔清單記錄 q8 為編碼器 8.9 MB ＋解碼器 4.9 MB、fp16 為 12.2 MB ＋ 8.6 MB；repo `Xenova/slimsam-77-uniform` | transformers.js；CPU 用 q8 | `vlm_core.js:55`；撒點、取遮罩、去重的邏輯在 JS（`renderer/src/media/image3d_core.js` 或使用端，未逐行核對） | 撒點（4×4 網格）、遮罩選擇、去重、去小碎塊：JS | 編碼器一次，解碼器每個點一次（推測，依 SAM 結構） | 實測（登錄註記，2026-10-30，瀏覽器 CPU q8）：載入約 6 秒、影像編碼約 16 秒、4×4 共 16 點約 28 秒 | Cache Storage |
| **MoveNet Thunder** | 單人姿態，17 個關鍵點，給 /image-to-3d 找手臂 | 登錄 fp32 約 25 MB（8 位元版在 WASM 缺 ConvInteger，所以用完整版）；repo `Xenova/movenet-singlepose-thunder` | transformers.js，WASM | `vlm_core.js:60` | 關鍵點信心值過濾與座標換算：JS | 輸入 256×256 整數 NHWC（登錄註記）；輸出 17 個（y、x、信心值） | 實測（登錄註記，2026-11-02）：CPU 推論約 0.3 秒、載入約 5 秒（含下載） | Cache Storage |
| **Whisper base** | 語音轉文字（影片逐字稿、transcribe_media） | 登錄約 80 MB（`vlm_core.js:63`）；**UI 文字寫約 77 MB**（`video_host.js:52`、`floating-assistant.js:1764`），兩處數字不一致，需以檔案清單為準；repo `onnx-community/whisper-base`，dtype `q8`（`floating-assistant.js:47027`–`47028`） | transformers.js `automatic-speech-recognition`；`_getWhisperTranscriber(device)` 依裝置建立（`floating-assistant.js:64413`），WebGPU 失敗退 CPU | `floating-assistant.js:64413`；影片端 `renderer/src/video/video_host.js:38`–`58`（`_runWhisperWindowed` 分段） | 解碼成 16 kHz 單聲道（主執行緒，`_decodeAudioForWhisper`）；梅爾頻譜在 transformers.js 內（推測）；分段與合併在 `video_host.js` | 編碼器輸入 log-mel 約 [1,80,3000]（推測，Whisper 結構）；編碼器輸出約 [1,1500,512]（推測）；解碼器逐 token 呼叫（推測） | 未在桌面版量測（本次未找到量測紀錄） | Cache Storage；`transformers-cache` 有備份分支退路（`floating-assistant.js` 約 64440 行起，從自家 repo 補檔） |
| **Basic Pitch（nmp.onnx）** | 多音轉譜（音訊轉 MIDI） | `renderer/src/music/audio_models.js:10`：230,444 位元組（約 225 KB），**有 SHA-256 釘住** | onnxruntime-web 1.22.0（CDN：cdn.jsdelivr.net），WebGPU 失敗退 WASM（`audio_runtime.js` 的 `createSession`） | `renderer/src/music/audio_runtime.js` 的 `makeTranscriber`；前後處理在 `renderer/src/music/basic_pitch.js` | 重新取樣到 22050 Hz、切窗（`windows`）、拼接（`stitch`）、解碼（`decode`）：全部 JS | 輸入 [1, 43844, 1] float32（約 2 秒，22050 Hz 單聲道，實測）；輸出多個張量，順序在 `basic_pitch.js` 固定（實測） | 未在桌面版量測（本次未找到量測紀錄） | IndexedDB `fa-a2m-models`，8 MB 分片、每片存起來可續傳（`audio_models.js:16`、`57`） |
| **YAMNet（yamnet.onnx）** | 樂器分類（決定 GM 音色） | `audio_models.js:11`：16,093,355 位元組（約 15.3 MB），SHA-256 釘住 | onnxruntime-web 1.22.0 | `audio_runtime.js` 的 `makeClassifier`；後處理在 `renderer/src/music/instrument_classify.js` | 取前 0.96 秒、標籤挑選（`IC.pick`）：JS | 輸入 waveform [N]，16 kHz 單聲道（實測）；輸出 scores [幀數, 521]，每 0.48 秒一幀（實測） | 未量測 | IndexedDB `fa-a2m-models` |
| **Demucs 6 軌（htdemucs_6s，fp16 權重）** | 分軌：鼓、貝斯、其他、人聲、吉他、鋼琴 | `audio_models.js:12`：136,428,532 位元組（約 130 MB），SHA-256 釘住 | onnxruntime-web 1.22.0；`DEMUCS_OPT = 'disabled'`（關掉圖形最佳化，實測：開著 WASM 與 WebGPU 都建不起工作階段，`audio_runtime.js:41`） | `audio_runtime.js` 的 `makeSeparator`（固定段長 `SEG = 343980` 樣本，44.1 kHz，約 7.8 秒） | 立體聲分左右兩段、重新取樣到 44.1 kHz、段與段之間的拼接：JS；**未看到重疊相加（overlap-add），段界可能有接縫，需確認** | 輸入 mix [1, 2, 343980] float32（實測，程式內固定）；輸出 6 軌，每軌左右兩聲道，順序在 `STEMS` 固定（程式內） | 未量測 | IndexedDB `fa-a2m-models` |
| **midigenai v5（作曲模型，decoder）** | 以 MIDI 為輸入，替種子樂句補聲部（自回歸生成） | 兩檔二選一：CPU（wasm、int8）`midigenai-v5-cpu` 114,561,179 位元組（約 109 MB）；GPU（WebGPU、q4）`midigenai-v5-gpu` 73,151,835 位元組（約 70 MB）；兩者都有 SHA-256（`audio_models.js:13`–`14`） | onnxruntime-web 1.22.0；裝置順序 `['webgpu', 'wasm']`（`midigen_bridge.js:96`–`117`） | `renderer/src/music/midigen_bridge.js`（裝置選擇與載入）、`MANIFEST` 在 `midigen_bridge.js:125`（vocab 598、12 層、12 頭、head_dim 64、opset 17） | 符號化（vocab）、取樣與逐 token 迴圈、KV 快取的拼接：JS（`midigen_bridge.js` 內，未逐行核對） | 有 KV 快取：GPU 版 `(1,H,P,D)`，CPU 版 `(1,P,H,D)`（`MANIFEST` 的 `cache` 欄位）；逐步呼叫，每步一次 session.run（推測） | 未量測；頁面說「約 7 秒／256 音符（CPU）」「約 2.8 秒（GPU）」，**都是專案頁面數字，未在這台機器實測**（`audio_models.js` 註記） | IndexedDB `fa-a2m-models`（同一套登錄；`midigen_bridge.js` 的 `ensure` 未逐行核對） |
| **SDXS-512（文字生圖、/edit-picture 擴散細化）** | 生圖，以及 /edit-picture 的「擴散細化」（只重畫一小塊） | GPU 版（fp16）：text_encoder 246,275,486、unet 631,766,742、vae_decoder 2,467,568 位元組，合計約 880 MB（十進位）；CPU 版（int8）合計約 1,116 MB（`local_sd.js:14`–`22`）；repo 與 commit 釘住（`skillsafeai/sdxs-512-dreamshaper-onnx-webgpu`、`lequangky/tipsy-sdxs-512-int8`） | onnxruntime-web：GPU 為 WebGPU、CPU 為 WASM（`local_sd.js:3`–`4`） | `renderer/src/imagegen/local_sd.js`（登錄與挑版本）、`sd_turbo_core.js`（TAESD 小型 VAE 與降級路徑，約 5 MB） | 分詞：CLIP 分詞器（Xenova/clip-vit-base-patch32，JS）；去噪迴圈與排程：JS（推測，未逐行核對）；VAE 解碼：ONNX | text 輸出約 [1,77,768]（推測，CLIP 結構）；unet 潛空間約 [1,4,64,64]（推測）；每步 unet 一次（推測） | 未量測 | **未查證**：`local_sd.js` 本身沒有 cache 與 IndexedDB 呼叫，要到 `floating-assistant.js` 的 SDXS 下載流程（約第 76854 行附近）再查 |
| **TAESD（小型 VAE）** | 給 SDXS 與降級路徑當編碼器與解碼器 | 各約 5 MB（`sd_turbo_core.js:15`） | onnxruntime-web，wasm 與 WebGPU 都能跑（onnxruntime-web 1.20 wasm 實測編碼→解碼成功，註記） | `sd_turbo_core.js` | 同 SDXS | 未核對 | 註記中有 1.20 版實測 | **未查證** |
| **Qwen3 0.6B（預設文字模型，原生已有路徑）** | 聊天、RAG、工具呼叫 | gpu q4f16 約 543 MB、cpu q8 約 589 MB；repo `onnx-community/Qwen3-0.6B-ONNX`（`vlm_core.js:32`） | transformers.js（網頁版）；**原生已有路徑**：onnxruntime-node 1.22.0 子程序（`native-runner/nr-engine.js`、`nr-tokenizer.js`，分詞與生成迴圈在子程序內） | `vlm_core.js:32`；原生 `native-runner/nr-engine.js` 的 `generate` | 分詞與樣板在子程序內（`nr-tokenizer.js`、`nr-template.js`） | 已在原生路徑跑通 | 實測（`DESIGN.TODO.native-runner.md`）：原生 CPU 4 執行緒每步中位數 267 ms；網頁版 WASM 4 執行緒每題中位數 12,925 ms（16 題總計 175,177 ms）；原生比 WASM 快約 1.3～1.5 倍（以文件記錄為準） | 原生路徑：使用者資料夾（執行包 `userData/native-runtime/`，模型檔仍取自瀏覽器快取，見第 4 節） |
| **Qwen2.5 0.5B / 1.5B、Qwen3 1.7B、SmolLM2 360M、Granite 4.0 350M 與 1B** | 聊天、工具呼叫（其他文字模型，都在 `vlm_core.js:24`–`50`） | 登錄約 260 MB（SmolLM2）到 1.7 GB（Granite 1B、CPU） | transformers.js；**只有 Qwen3 0.6B 有原生路徑**；其餘 `verified: false` 或未在這台機器驗證 | `vlm_core.js` | 同 Qwen3 | 同 Qwen3 的 transformers.js 路徑 | 未量測（Granite 350M、1B 註記「未實測」） | Cache Storage |

#### 1.2 其他離線模型（使用者列出之外，專案內有）

| 模型 | 用途 | 檔案與大小 | 執行方式與位置 | 備註 |
|---|---|---|---|---|
| **Whisper base（另一條影片路徑）** | 同上 Whisper，`transcribe_media` 工具 | 同上 | `floating-assistant.js:47027` | 與上面同一模型，兩個入口，要一起改 |
| **Kokoro（TTS，文字轉語音）** | 朗讀 | 約 90 MB（`floating-assistant.js:1764` 的說明文字） | transformers.js（未逐行核對） | **未查證**大小與位置；屬於 TTS，不在使用者列表內 |
| **MOSS-TTS-Nano（聲音複製）** | 語音合成（零樣本複製） | 來源 `OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX`、`MOSS-Audio-Tokenizer-Nano-ONNX`（`floating-assistant.js` 內的登錄） | onnxruntime-web，**只有 `executionProviders: ['wasm']`**（`renderer/src/tts/moss_worker.js:17`） | 不在使用者列表內；要另立一份評估 |
| **Qwen 系列生成的 ONNX 檔（以文字模型為主）** | 同上 | 同上 | 同上 | 已在上面的表列出 |

#### 1.3 盤點的限制（要誠實說）

- 每個模型的前後處理主要在 transformers.js 內部或 JS 內，本次只核對了專案自己寫的部分（`audio_runtime.js`、`basic_pitch.js`、`instrument_classify.js`、`midigen_bridge.js`、`local_sd.js`、`video_host.js`）。transformers.js 內部的分詞與梅爾頻譜是推測。
- 「桌面版已測速度」只採用文件與登錄檔裡寫的量測。它們寫的是「瀏覽器 CPU」，沒有註明是否在桌面版（Electron）內。
- 登錄檔的檔案大小有兩個來源（讀 HuggingFace 清單的日期不同），Whisper 的 80 MB 與 77 MB 就不一致。

---

## 2. 通用方案評估：「通用 ONNX 工作階段服務」

### 2.1 方案

子程序只做三件事：載入模型檔（`InferenceSession.create`）、接收輸入張量、呼叫 `session.run` 後回傳輸出張量。前處理與後處理留在渲染程序的 JS（沿用 `basic_pitch.js`、`audio_runtime.js`、`local_sd.js` 等現有程式）。Qwen3 0.6B 那條專用路徑（子程序內含分詞與生成迴圈）保留，不併入通用服務。

### 2.2 與現有協定的差異（`native-runner/nr-protocol.js`）

現有訊息種類（第 10–20 行）：`hello`、`load`、`run`、`cancel`、`dispose`、`hello_ack`、`progress`、`token`、`done`、`error`、`cancelled`。這些都是 LLM 專用（`messages`、`token`、`finish_reason`）。

建議新增（不改動既有 LLM 訊息）：

| 新訊息 | 方向 | 必填欄位 | 用途 |
|---|---|---|---|
| `tensor_load` | 主程序 → 子程序 | `id`、`model_path`、`device`、`threads`、`graph_opt`（預設 `all`，Demucs 用 `disabled`） | 載入 ONNX 檔成 session（與 LLM 的 `load` 分開，避免混用） |
| `tensor_run` | 主程序 → 子程序 | `id`、`inputs`（每項 `name`、`dtype`、`dims`、`path`）、`timeout_ms` | 跑一次 `session.run`；輸入張量放在檔案，訊息只帶路徑 |
| `tensor_done` | 子程序 → 主程序 | `id`、`outputs`（每項 `name`、`dtype`、`dims`、`path`）、`ms` | 回傳輸出張量的檔案路徑 |
| `tensor_error` 或沿用 `error` | 子程序 → 主程序 | `id`、`code` | 錯誤碼沿用 `ERROR_CODES`（`load_failed`、`oom`、`timeout`、`cancelled`、`internal`、`crashed`、`version_mismatch`） |

`cancel` 與 `dispose` 可以直接沿用，只要 `id` 能對到。

### 2.3 張量傳輸方式

**結論：控制訊息走標準輸入輸出，張量走暫存檔。**

理由與估算（數字是推測，依張量大小算出，沒有實際量測；第一階段要量測）：

| 張量 | 大小（float32 原始位元組） | 若用 JSON 一行（數字文字約 3 到 4 倍） | 若用 base64 | 建議 |
|---|---|---|---|---|
| Basic Pitch 一窗輸入 [1,43844,1] | 約 175 KB | 約 0.6 MB | 約 233 KB | 暫存檔即可，JSON 也撐得住 |
| YAMNet 輸入 0.96 秒 | 約 61 KB | 約 0.2 MB | 約 81 KB | 同上 |
| Whisper 梅爾頻譜 [1,80,3000] | 約 960 KB | 約 3 MB | 約 1.3 MB | 暫存檔 |
| Whisper 編碼器輸出 [1,1500,512] | 約 3.1 MB | 約 10 MB | 約 4.1 MB | 暫存檔 |
| Florence-2 pixel_values [1,3,768,768] | 約 7.1 MB | 約 22 MB | 約 9.5 MB | 暫存檔 |
| Demucs 輸入 [1,2,343980] | 約 2.75 MB | 約 9 MB | 約 3.7 MB | 暫存檔 |
| Demucs 輸出 6 軌（每段） | 約 16.5 MB | 約 50 MB | 約 22 MB | 暫存檔，必須 |
| SD 的 unet 潛空間 [1,4,64,64] | 約 65 KB | 約 0.2 MB | 約 87 KB | 暫存檔（每步很多次，小張量也建議走檔） |

- 不選 JSON 一行：標準輸入輸出是「一行一則」，一行 50 MB 的 JSON 會讓讀行、解析、記憶體同時變壞，而且每一步都要重解析。
- 不選 base64 一行：仍然要整塊進記憶體，只是小一點。
- 選暫存檔：張量寫成原始二進位（`.bin`），檔名放在使用者資料夾的暫存目錄（每個 `id` 一個子資料夾），訊息只帶路徑、dtype、dims 與位元組數。子程序讀完即刪；主程序收到 `tensor_done` 後讀完即刪。子程序與主程序都要核對位元組數，不符就回 `error`。
- 注意：子程序的標準輸出只能放協定訊息，不能有任何除錯輸出，否則會汙染協定（現有 `nr-protocol.js` 已用一行一則解析，這點沿用）。

### 2.4 效能損耗估算（推測）

- 單次呼叫的額外成本 = 寫檔 ＋ 讀檔 ＋ 一次行程間訊息。在一般硬碟與系統快取下，寫讀各數 MB 的檔案通常是幾毫秒到幾十毫秒（推測，未量測）。
- Demucs 一段 7.8 秒的音訊：輸入與輸出合計約 19 MB 的檔案 IO，相對於 Demucs 一段推論的時間（推測為數秒到數十秒），IO 不是瓶頸。
- SD 每步一次 unet 呼叫，只有幾百 KB 的張量，但步數多時，每步的固定成本（行程間訊息、檔案 IO）會累積。這一類要量測，不能只靠估算。
- 結論：**效能損耗以「單次呼叫的固定成本」為主，不以張量大小為主**。量測時要把兩者分開記錄。

### 2.5 串流與分段

- **Whisper**：影片端已經分段（`_runWhisperWindowed`，`video_host.js:54`）。每一段一次 `tensor_run`（編碼器），解碼器的逐 token 迴圈若要放原生，就會變成很多次 `tensor_run`，固定成本會放大。這一點是 Whisper 不能直接套用通用服務的主要理由，建議先測。
- **Demucs**：段長固定 7.8 秒（程式內），天然分段。每段一次 `tensor_run`，進度用 `progress` 訊息（或 progress.jsonl）回報「第幾段／共幾段」。
- **Basic Pitch**：已經切窗（`windows`），每窗一次。
- **取消與逾時**：每個 `tensor_run` 帶 `timeout_ms`；超時就 kill 子程序（與 LLM 路徑一致）；使用者按取消就送 `cancel`，子程序在兩次 `session.run` 之間檢查，無法中斷正在跑的一次呼叫（onnxruntime-node 沒有中斷 API，推測）。所以單次呼叫的上限要夠短，Demucs 一段的時間就是取消的最壞延遲。

### 2.6 與 qwen3-0.6b 專用路徑的並存

- 子程序內部用 `kind` 區分：`llm`（現有的 `load`、`run`、`token`、`done`）與 `onnx`（新的 `tensor_*`）。一個子程序一次只載入一個模型（沿用現有做法，避免記憶體疊加），切換模型時先 `dispose`。
- Qwen3 的 `nr-engine.js`、`nr-tokenizer.js`、`nr-template.js` 不改動，只在 `nr-child.js` 的訊息分派處多一條路。
- 通用服務不要求 Qwen 改寫；如果以後要把 Florence-2、Whisper 的解碼器搬進原生，那是「每個模型一份樣板」的工作，不是通用服務的一部分。

---

## 3. 逐模型建議

判斷依據：
1. 只比 cpu 路徑（依共識第 9 條「選cpu才走原生」）：原生 CPU 對 WASM 值不值得。WebGPU 路徑不經原生，只記錄供參考。已知原生 CPU 對 WASM 約 1.3～1.5 倍，這是 Qwen3 0.6B 的實測；其他模型沒有實測，下面凡是說「會比較快」的都是推測。
2. 耗時最長、最吃效能的先做。
3. 原生加速後端（DirectML、Linux CUDA）只做量測，不做預設。

| 模型 | 建議 | 理由 | 預期風險 |
|---|---|---|---|
| **Demucs 6 軌** | **做（第二批，量測通過就做）** | 耗時最長的音訊模型，段長固定，輸入輸出簡單；最可能因為原生 CPU 而有明顯收益（推測） | 130 MB 下載；圖形最佳化關閉（`DEMUCS_OPT`）可能讓原生速度不如預期；段界接縫（未確認有無重疊相加）；大輸出 16.5 MB 每段的檔案 IO |
| **Basic Pitch** | **做（第一批，試點）** | 最小（225 KB）、前後處理已經在 JS、張量形狀與順序已實測；最適合用來驗證整條張量路徑 | 收益可能很小（模型很小，主要成本可能在 JS 前處理）；收益不大不代表不要做，它的價值是驗證協定 |
| **YAMNet** | **做（第一批，跟 Basic Pitch 一起試）** | 15 MB，輸入一段 0.96 秒，呼叫次數少，前後處理簡單 | 收益不明；同 Basic Pitch |
| **midigenai v5** | **測了再說** | 自回歸逐 token 生成，每步一次 `session.run`，固定成本會放大；KV 快取的形狀（GPU 與 CPU 不同）要在子程序內照樣維持；CPU 版的速度數字（7 秒）未實測 | 每步小張量，固定成本可能吃掉收益；GPU 版（q4 WebGPU）原生沒有對應後端，只能 CPU；KV 快取要跨多次呼叫保留在子程序（要新增 session 狀態的規則）；授權註記「訓練資料集授權未確認」 |
| **Whisper base** | **測了再說（先量編碼器）** | 編碼器一次性、輸入大，原生 CPU 可能有收益（推測）；解碼器是逐 token 迴圈，放原生要做樣板，工作量大 | 解碼器逐 token 呼叫會放大固定成本；WebGPU 路徑（q8 在 WebGPU 的行為）未在這裡確認；`video_host` 有 WebGPU 失敗退 CPU 的邏輯，原生要跟它對齊 |
| **SDXS-512（生圖與擴散細化）** | **測了再說（先問使用者同不同意 1.1 GB 下載）** | 最大的模型檔之一，每步 unet 一次，原生 CPU 路徑可能有收益（推測），要實測；生圖步數由 `local_sd.js` 的設定決定，要先確認步數 | 下載量最大（GPU 版約 880 MB、CPU 版約 1.1 GB）；磁碟佔用加倍（見第 4 節）；SDXS 的 unet 在 DirectML 是否會失敗未知，要逐一測；**存放位置未查證** |
| **TAESD（小型 VAE）** | **跟 SDXS 一起做，單獨不做** | 約 5 MB，沒有獨立價值 | 跟 SDXS 同 |
| **Depth Anything V2 Small** | **做（第二批）** | 單次推論、輸入輸出簡單、只有一個張量進出；WASM 的 fp32 在 CPU 要 8～10 秒，原生 CPU 可能明顯較快（推測），很適合當「第二個量測對象」 | 99 MB 下載（CPU fp32）；WebGPU 用 fp16，原生的 fp16 支援要量測 |
| **SlimSAM 77** | **測了再說（先做編碼器）** | 編碼器約 16 秒是大頭（實測），原生 CPU 可能有收益（推測）；解碼器每點一次，量少，之後再說 | 解碼器點數多時固定成本放大；登錄檔大小在兩個來源不一致（22 MB 與 13.8 MB），要以實際檔案為準 |
| **MoveNet Thunder** | **不做** | CPU 推論約 0.3 秒，已經夠快；25 MB 下載不划算 | 無 |
| **Florence-2 base** | **測了再說（最後才做）** | 同時有視覺編碼器與自回歸解碼器，還有 transformers.js 內部的生成迴圈，要逐步搬，工作量最大；實測 CPU 約 21～34 秒，收益可能很大，但不是第一批 | 生成迴圈與分詞在 transformers.js 內，搬出來要自己寫；WebGPU 的 q4 是否在原生可跑未知 |
| **SmolVLM 256M** | **不做（先不管）** | `verified: false`，連網頁版的品質都還沒驗證；先不投入 | 無 |
| **ViT-GPT2** | **不做** | 實測 CPU 約 2 秒，夠快，只是一句話描述，沒有需要加速的理由 | 無 |
| **Qwen3 0.6B** | **已做（原生路徑已存在），本次範圍不動** | 已有原生路徑與實測 | DirectML 在某節點失敗（已知） |
| **Qwen2.5、Qwen3 1.7B、SmolLM2、Granite** | **不在本次範圍；測了再說** | 只有 Qwen3 0.6B 驗證過原生路徑；其餘未在這台機器驗證，先不擴大範圍 | 更大的模型，下載量與記憶體需求更高 |
| **Whisper（另一條路徑，transcribe_media）** | 跟 Whisper base 同一件事 | 同一模型，兩個入口 | 同 Whisper |
| **Kokoro TTS、MOSS-TTS-Nano** | **不在本次範圍，另立評估** | 使用者列表外；MOSS 是 WASM-only，原生收益要另測 | 無 |

---

## 4. 模型檔共用

### 4.1 現況（實測與讀程式）

| 來源 | 存放位置 | 是否有檢查碼 |
|---|---|---|
| transformers.js 模型（Florence-2、SmolVLM、ViT-GPT2、Depth、SlimSAM、MoveNet、Whisper、Qwen 系列） | 瀏覽器 Cache Storage（`env.useBrowserCache = true`，`floating-assistant.js:50967`、`63534`） | **沒有**：`vlm_core.js` 的 `repo` 欄位沒有 commit 釘住，`resolve/main` 會跟著上游變；只有大小的檢查 |
| 音訊模型（Basic Pitch、YAMNet、Demucs、midigenai） | IndexedDB `fa-a2m-models`，8 MB 分片，每片存起來（`audio_models.js:16`、`57`） | **有**：SHA-256 釘住，下載完比對，不符就清掉重下 |
| SDXS／TAESD | 未查證（見 1.1 表） | SDXS 的 repo 與 commit 有釘住（`local_sd.js:16`、`18`）；大小核對在下載時做 |

### 4.2 原生執行包需要什麼

原生子程序要的是**檔案路徑**，不是瀏覽器快取的位元組。所以模型檔必須落地到使用者資料夾。

### 4.3 建議做法

**建議：一份落地到使用者資料夾，由現有下載流程寫入，並建一個索引檔。**

1. 目錄：`userData/native-models/<model-id>/<檔名>`，另有 `userData/native-models/index.json`，每個條目記：模型 id、檔名、位元組數、SHA-256（如有）、來源 repo 與 revision（如有）、寫入時間。
2. 寫入來源：
   - 音訊模型（有 SHA-256）：從 IndexedDB 的分片依序讀出，寫進檔案（每次一片，避免一次把 130 MB 放進記憶體），寫完後核對 SHA-256。
   - transformers.js 模型（沒有檢查碼）：不從瀏覽器快取讀（Cache Storage 的內容格式不是單純的檔案），而是由主程序依 repo 與檔名重新下載一次，寫入上述目錄，並在索引檔記下大小。這會重複下載一次，要先問使用者同意。
3. 重複佔用：瀏覽器快取與原生目錄會各存一份，磁碟佔用加倍。SDXS 合計約 1.1 GB、Demucs 130 MB、Whisper 約 80 MB。
   - 建議：原生目錄是唯一的原生來源，瀏覽器快取保留不動（網頁版路徑仍需要）。
   - 替代：原生啟用後，提供「清除瀏覽器重複快取」的選項，但必須使用者確認；預設不刪。
4. 不重複下載的做法：
   - 音訊模型：從 IndexedDB 讀出寫檔，不用重新下載。
   - transformers.js 模型：若使用者已經在網頁版下載過，原生目錄還是需要一份，會重新下載一次。這是本方案的代價，要在下載前列出檔名、來源、大小，取得同意。
5. 舊版安裝不需要重裝：
   - 原生目錄是按需建立的，沒有就走網頁版路徑，並提示「可以下載原生模型」。
   - 下載流程與第 4.1 節的現有機制一致（分片、續傳、SHA-256），不要求安裝包改版。
6. 版本釘住：
   - 所有要給原生用的模型都要寫 revision 或 SHA-256 進索引檔。
   - `vlm_core.js` 的 transformers.js 模型目前沒有釘住，原生目錄要用就要先補釘住，否則網頁版與原生版可能拿到不同版本，結果不一致。這一點要先問使用者。

---

## 5. 分階段實作計畫與驗收

每階段格式：目標、檔案與函式、逐步清單、驗收（程式可檢查）、Windows 與 Linux 驗證方式、不准做的事。

### 階段 1：逐模型量測（最便宜，必須先做）

**目標**：用固定題目，逐模型比較「原生 CPU（onnxruntime-node 1.22.0）」與「WASM（onnxruntime-web 1.22.0）」的實際速度，並記錄輸出是否一致。WebGPU（onnxruntime-web 1.22.0）只作為參考列記錄，不影響取捨。

**檔案與函式**（新增，不改產品程式）：
- 新增 `scripts/eval/native_all_models_bench.js`：主流程，讀 `bench-config.json`，逐模型逐後端執行，結果寫 `test-reports/native-all-models/results.jsonl`（一行一筆，每完成一題就寫一行）。
- 新增 `scripts/eval/native_all_models_bench/inputs/`：固定輸入（固定種子、固定音訊檔、固定影像），每個模型至少 3 題，題目與答案雜湊寫在 `inputs/manifest.json`。
- 重用既有腳本的做法：`scripts/eval/native_vs_onnx_node.js`（原生量測）與 `scripts/eval/native_vs_wasm.eval.js`（網頁版量測）。不另寫新的推論程式。

**逐步清單**：
1. 寫 `bench-config.json`：列出 Basic Pitch、YAMNet、Depth Anything V2 Small、Demucs 6 軌、Whisper base（編碼器）、SlimSAM（編碼器）、SDXS（只量一步 unet，不跑完整生圖）、midigenai（只量 16 步）。
2. 每個模型先檢查「模型檔是否已在本機」：
   - 已在（音訊模型的 IndexedDB 或已有的原生目錄）：直接量。
   - 不在：列檔名、來源、大小，寫入結果檔的 `needs_download` 欄位，標記「需先問使用者」，**不下載**。
3. 量測設定：
   - 每個後端每題跑 1 次暖機（不計時）＋ 3 次計時，取中位數。
   - 子程序以低優先權執行（Windows 用 `os.setPriority(pid, 19)` 等級的低優先權；Linux 用 `nice`）。
   - 總時間上限 45 分鐘；超過就停止並寫入 `aborted: "time_cap"`。
   - 單次呼叫逾時 120 秒，逾時記錄為 `timeout`，不重試。
4. 逐題進度：每完成一題寫一行 `{"model":..., "backend":..., "q":..., "ms":..., "ok":..., "out_hash":...}`。進度另寫 progress.jsonl，供 UI 或人工查看。
5. 輸出一致性：每個模型的 WASM 結果當作參考，原生與 WebGPU 的輸出張量做最大絕對誤差比對，寫入 `max_abs_err`。
6. 結束時輸出摘要表（每個模型一列，三個後端的中位數、誤差、狀態）。

**驗收（程式可檢查）**：
- `results.jsonl` 每一行都是合法 JSON，且欄位齊全（model、backend、q、ms、ok、out_hash、max_abs_err 或 null）。
- 每個模型的「原生 CPU」與「WASM」兩列必須都有；「WebGPU」列為參考，可以是 `skipped` 並附原因（例如「沒有 WebGPU 轉接器」）。
- 沒有任何模型在量測過程中自動下載：可用 `needs_download` 欄位檢查，且量測前後的模型目錄檔案數不變。
- 同一次量測跑兩遍，WASM 的 out_hash 一致（確認可重現）。
- 總時間不超過 45 分鐘，超過時 `aborted` 欄位有值。

**Windows 與 Linux 驗證方式**：
- Windows：在 Electron 的 node 模式下執行（沿用 `native_vs_onnx_node.js` 的做法）。
- Linux：**未實跑**。本次環境是 Windows，Linux 的量測要在有 Linux 環境時補做，結果先標「未驗證」。

**不准做的事**：
- 不准下載模型（即使是小檔）。需要下載的只列出來。
- 不准啟用 DirectML 或 CUDA 作為量測條件之一，除非使用者另外同意（第 6 節的決定）。
- 不准改產品程式（`renderer/src/**`、`native-runner/**`）。
- 不准用網頁版的 `floating-assistant.js` 直接跑量測（它會觸發下載與 UI 狀態）。量測腳本必須自己載入需要的 ONNX 檔。

### 階段 2：張量協定與試點（Basic Pitch ＋ YAMNet）

**前提**：階段 1 的結果顯示原生 CPU 對這兩個模型不會比 WASM 差，且輸出誤差在容許範圍內。

**目標**：在 `nr-protocol.js` 新增 `tensor_*` 訊息，`nr-child.js` 支援 `kind: 'onnx'`，用 Basic Pitch 跑通一整條路徑。

**檔案與函式**：
- `native-runner/nr-protocol.js`：第 10–20 行的訊息表新增 `tensor_load`、`tensor_run`、`tensor_done`；第 33–48 行的驗證函式新增對應欄位檢查。
- `native-runner/nr-child.js`：訊息分派新增 `kind: 'onnx'` 分支，載入 `onnxruntime-node`（沿用 `nr-engine.js` 的 `ortModule()`）。
- `renderer/src/music/audio_runtime.js`：新增一個「原生工作階段」的包裝，與 `createSession` 同介面，失敗時回退到既有的 WebGPU／WASM 路徑。
- 新增 `native-runner/nr-tensor-io.js`：張量寫檔與讀檔（原始二進位，附 dtype、dims、位元組數核對）。

**逐步清單**：
1. 寫 `nr-tensor-io.js`，附單元測試（寫入後讀回一致、位元組數不符要丟錯）。
2. 擴充 `nr-protocol.js` 的驗證，新增單元測試（不合法的 `inputs`、缺 `path` 要被拒絕）。
3. `nr-child.js` 支援 `tensor_load` 與 `tensor_run`。
4. 在 `audio_runtime.js` 加原生包裝，依共識規則接線：只有使用者選 cpu（或 auto 且無 WebGPU）才先試原生；選 webgpu 完全不經原生；原生失敗退 WASM 並顯示真實原因。
5. Basic Pitch 的 `makeTranscriber` 改成可接受外部 session（不改演算法）。

**驗收（程式可檢查）**：
- 單元測試：張量寫讀一致、協定驗證通過。
- 原生輸出與 WASM 參考的最大絕對誤差 ≤ 1e-4（Basic Pitch 的 onset、note 張量各一項）。
- 旗標關閉時，`audio_runtime.js` 的行為與現況完全一致（用既有的 `audio_runtime.test.js` 驗證，`scripts/music-tests/audio_runtime.test.js`）。
- 原生失敗（例如 `nmp.onnx` 不存在）時，UI 或回傳值要顯示實際後端與真實原因，不靜默退回。

**Windows 與 Linux 驗證方式**：Windows 用 Electron 真實執行；Linux 未實跑，標未驗證。

**不准做的事**：
- 不准把張量放進 stdin 或 stdout 的同一行。
- 不准讓子程序在標準輸出寫除錯訊息。
- 不准開本機埠或做任何網路伺服器。
- 不准改動 Qwen 的 `load`、`run`、`token`、`done` 訊息。

### 階段 3：Depth Anything V2 Small 與 Demucs

**前提**：階段 2 通過，階段 1 量測顯示 Demucs 或 Depth 的原生收益明顯。

**目標**：兩個模型都能走原生，並支援取消與逾時。

**檔案與函式**：
- `renderer/src/vlm/vlm_core.js`：Depth 的原生包裝（只在 `depth-estimation` 任務，不動 Florence 與其他）。
- `renderer/src/music/audio_runtime.js`：`makeSeparator` 的原生包裝（段長與 `DEMUCS_OPT` 保留）。
- `native-runner/nr-child.js`：`tensor_run` 支援取消（每次呼叫前檢查旗標）。

**逐步清單**：
1. Depth 先做（單次推論，風險小）。
2. Demucs 段與段的拼接先確認是否有接縫：用同一首歌的原生與 WASM 輸出做比對，接縫位置的誤差要在容許範圍內。
3. Demucs 段數多時，進度以段為單位回報。

**驗收（程式可檢查）**：
- Depth：原生與 WASM 的深度圖最大絕對誤差 ≤ 1e-3（值域 0 到 1 或 0 到 255，明寫在測試）。
- Demucs：六軌的 SNR（相對 WASM）≥ 40 dB（推測的門檻，需第一階段量測後確認）。
- 取消：送出取消後，下一段開始前就停止，不得在 5 秒內仍有新的段輸出。
- 逾時：單段超過 `timeout_ms` 時子程序被 kill，UI 顯示「逾時，已退回網頁版」。

**Windows 與 Linux 驗證方式**：同階段 2。

**不准做的事**：
- 不准為了加速而關閉檢查碼核對。
- 不准把 Demucs 的 `DEMUCS_OPT` 改成 `all` 來「試試看」，除非先在階段 1 的量測中證明它在原生可以建 session。

### 階段 4：midigenai、Whisper 編碼器、SlimSAM 編碼器

**前提**：階段 3 完成，且階段 1 量測證明這些模型原生有收益。

**目標**：
- midigenai：CPU 版（wasm int8 對應的 ONNX）在原生跑，KV 快取保留在子程序。
- Whisper：編碼器原生，解碼器仍在網頁版（混合路徑）。
- SlimSAM：編碼器原生，解碼器仍在網頁版。

**檔案與函式**：
- `renderer/src/music/midigen_bridge.js`：`load(dev)` 支援原生選項。
- `native-runner/nr-child.js`：`tensor_run` 支援保留 session 內的狀態（KV 快取）。
- `renderer/src/video/video_host.js`：Whisper 編碼器的原生包裝。

**驗收**：
- midigenai：每步輸出的 logits 與 WASM 參考誤差 ≤ 1e-3；同一種子生成的音符序列完全相同。
- Whisper 編碼器：輸出誤差 ≤ 1e-3，轉錄文字與網頁版一致（以固定的 3 段音訊比對）。
- SlimSAM 編碼器：遮罩 IoU ≥ 0.98（與網頁版比）。

**Windows 與 Linux 驗證方式**：同階段 2。

**不准做的事**：
- 不准把 Whisper 的解碼器搬進原生（這是另一個階段，要另外規劃）。
- midigenai 原生只用 CPU 檔（int8）；GPU 檔（q4）只留給網頁版 WebGPU 路徑，不准在原生路徑上使用或宣稱它的加速。

### 階段 5：SDXS（生圖與擴散細化）

**前提**：使用者同意 1.1 GB 下載與磁碟佔用（第 6 節），且階段 1 量測證明 unet 原生有收益。

**目標**：SDXS 的 unet 原生跑，text encoder 與 VAE 仍在網頁版（混合路徑），或者全部原生（視量測而定）。

**檔案與函式**：`renderer/src/imagegen/local_sd.js`、`renderer/src/imagegen/sd_turbo_core.js`、`native-runner/nr-child.js`。

**驗收**：生成的影像與網頁版參考的 PSNR ≥ 35 dB（推測的門檻，要量測後確認）；同種子結果一致。

**Windows 與 Linux 驗證方式**：同階段 2。

**不准做的事**：不准在沒有使用者同意的情況下下載 1.1 GB。

### 階段 6：Florence-2、SmolVLM、其他

**前提**：前面階段完成，使用者另外決定。本次只列為「測了再說」，沒有驗收條件。

---

## 6. 要問使用者的決定（每項附推薦與理由）

1. **要不要把 Basic Pitch 與 YAMNet 作為第一批試點？**
   - 推薦：要。理由：最小、前後處理已在 JS、張量形狀已實測，最適合驗證整條張量路徑；收益可能不大，但它的價值在協定。
2. **階段 1 的量測要不要實際下載需要的模型？**
   - 推薦：不下載。只量已經在本機的模型；沒有的列檔名、來源、大小，等使用者逐一同意。理由：下載量最大的是 SDXS（約 1.1 GB），不能在量測時順手下載。
3. **模型檔要不要在原生目錄保留一份（重複佔用磁碟）？**
   - 推薦：保留一份，瀏覽器快取不動。理由：網頁版路徑要保留，刪快取會讓網頁版也要重下。提供「清除重複快取」選項，但預設不刪。
4. **transformers.js 模型（沒有檢查碼）要不要補釘住 revision？**
   - 推薦：要，並且在下載原生模型前先做。理由：沒釘住的話，原生與網頁版可能拿到不同版本，結果不一致，難以比對。
5. **DirectML 要不要在第一階段量測中試？**
   - 推薦：不試，移出本次範圍。理由：依管理層補充共識，原生只在使用者選 cpu 時使用；DirectML 不是 CPU 路徑，不在量測條件內。若日後要做，另案評估。請確認。
6. **SDXS 要不要進原生？**
   - 推薦：測了再說，先問使用者是否接受 1.1 GB 下載與磁碟佔用。理由：它是最大的模型，收益不確定（每步固定成本可能吃掉收益）。
7. **Demucs 要不要做？**
   - 推薦：做，但要在階段 1 量測證明收益之後。理由：它是最耗時的音訊模型，最可能有收益；但它的圖形最佳化被關掉，原生速度要實測。
8. **Florence-2 要不要做？**
   - 推薦：最後才做。理由：它的生成迴圈在 transformers.js 內，搬出來工作量最大。
9. **Kokoro 與 MOSS-TTS-Nano 要不要納入？**
   - 推薦：不納入本次範圍，另立評估。理由：不在使用者列出的範圍內，而且 MOSS 是 WASM-only，要另測。
10. **Whisper 登錄大小 80 MB 與介面文字 77 MB 不一致，以哪個為準？**
    - 推薦：以實際下載檔案的位元組數為準，階段 1 量測時順便記錄，然後修正登錄檔。理由：目前兩處數字不一致，會誤導使用者的磁碟空間判斷。

---

## 附：本次調查沒有完成的部分（誠實列出）

- SDXS 與 TAESD 的模型檔存放位置：未查證（`floating-assistant.js` 的 SDXS 下載流程未逐行追）。
- midigenai 的下載是否走 IndexedDB 的同一套登錄：推測是，未逐行核對 `midigen_bridge.js` 的 `ensure`。
- Demucs 段界是否有重疊相加：未確認。
- transformers.js 內部的分詞與梅爾頻譜：未核對（在 transformers.js 套件內，不在本專案）。
- Kokoro 與 MOSS-TTS-Nano 的檔案大小與位置：未查證。
- 所有原生與 WebGPU 的速度：沒有實測，全部標推測，留給階段 1 量測。
- Linux 的任何驗證：未實跑。

---

## 7. 階段 1 量測結果（2026-11-05，實測）

> 狀態：階段 1 量測完成（8 個模型中 6 個實測，Whisper 與 midigenai 本機沒有檔案未量）。以下數字全部是這台機器的實測，標明「推測」的才是推測。

### 7.1 做法與環境

- 機器：Windows 10，Intel Core i5-2320（4 核心 4 執行緒，3.0 GHz），同一台、同一時段、同一份輸入檔。**機器上同時有其他工作階段在跑，單次計時抖動很大**（YAMNet 原生單次從 9 到 142 毫秒），所以看中位數與整體倍率，不要看單次。
- 原生：`onnxruntime-node` 1.22.0（使用者安裝版的執行包 `native-runtime/1.22.0-1`），以 Electron 44.4.0 的 node 模式執行，CPU、`intraOpNumThreads=4`，圖形最佳化 `all`。
- 瀏覽器端：真的 Electron（隔離 `--user-data-dir`、`FA_BROWSER_CONTROL_PORT` 換埠、`FA_DISABLE_MAIN_OVERLAY=1`），用跟產品相同的設定載入 `onnxruntime-web` 1.22.0（CDN 版，proxy 開，WASM 4 執行緒，頁面 `crossOriginIsolated` 為 false 但 SharedArrayBuffer 可傳）。
- 每題 1 次暖機（不計）＋ 計時取中位數：Basic Pitch、YAMNet 7 次，Depth、SlimSAM 3 次，Demucs、SDXS 2 次（單次太久）。每個模型各用獨立的行程量（原生一個行程、WASM 一個全新的 Electron），記憶體峰值才不會被前一個模型墊高；每模型 3 題，輸入由固定種子產生（`scripts/eval/native_all_models_bench/gen_inputs.js`），原生與 WASM 讀同一份檔。
- 兩邊都用一般優先權（早期版本曾把原生設成低優先權，結果對 WASM 不公平，已拿掉）。
- 記憶體：原生用 `process.resourceUsage().maxRSS`（該行程峰值）；WASM 用每 0.5 秒輪詢整個 Electron 行程樹的工作集峰值。**兩者不能直接相減**：Electron 本身（不載模型）的行程樹峰值是 624 MB（實測基線），原生子程序單獨載入模型是 136～163 MB。
- 輸出一致性：兩邊的輸出張量逐元素比對最大絕對誤差。
- 模型檔來源：這兩個模型本來就在使用者安裝版的瀏覽器資料庫（IndexedDB `fa-a2m-models`）裡；我只讀取複本（沒有動原資料、沒有下載、沒有網路），把 8 MB 分片（Basic Pitch 是 Snappy 壓縮過的）還原成整檔，**還原後的 SHA-256 與登錄檔釘住的值完全相同**（Basic Pitch 230,444 位元組、YAMNet 16,093,355 位元組）。還原用的暫存檔放在工作階段暫存資料夾，不在倉庫內。
- 程式：`scripts/eval/native_all_models_bench/`（`bench-config.json`、`gen_inputs.js`、`native_bench.js`、`wasm_bench.eval.js`、`run_wasm.js`、`run_each.js`、`compare.js`）；原始結果在 `test-reports/native-all-models/`。
- 重現指令（Windows，`E` 為 desktop-app 資料夾，`W` 為工作資料夾，`M` 為放模型檔的資料夾）：先 `node gen_inputs.js W/inputs`；原生 `ELECTRON_RUN_AS_NODE=1 NAB_ORT=<執行包>/node_modules/onnxruntime-node NAB_MODELS=M NAB_WORK=W NAB_OUT=W/native.jsonl electron.exe native_bench.js`；WASM `node run_wasm.js W M electron.exe E`；最後 `node compare.js W`；逐模型各開行程的總控是 `run_each.js`。

### 7.2 量測表（全部實測，這台機器，4 執行緒對 4 執行緒）

「快幾倍」＝ WASM 中位數 ÷ 原生中位數（大於 1 表示原生較快）。每個模型 3 題，表中是 3 題中位數的中位數。

| 模型（輸入） | 原生 CPU（毫秒） | WASM（毫秒） | 原生快幾倍 | 輸出誤差（最大絕對誤差／訊噪比） | 原生子程序峰值記憶體 | WASM 整個 Electron 峰值（基線 624 MB） |
|---|---|---|---|---|---|---|
| Basic Pitch（一窗 43,844 樣本） | 101 | 193 | 1.9 | 1.0e-6／127 dB | 136 MB | 975 MB |
| YAMNet（3 秒 16 kHz） | 45 | 470 | 見下方說明 | 6.2e-6／118 dB | 155 MB | 1,023 MB |
| Depth Anything V2 Small（fp32，518×518） | 4,392 | 7,355 | 1.7 | 1.9e-6／131 dB | 491 MB | 1,617 MB |
| Demucs 6 軌（一段 7.8 秒立體聲，圖形最佳化關閉） | 18,032 | 31,550 | 1.75 | 6.7e-4／57.7 dB | 1,940 MB | 1,865 MB |
| SlimSAM 77 編碼器（q8，1024×1024） | 7,975 | 10,152 | 1.27 | 6e-8／151 dB | 3,610 MB | 2,272 MB |
| SDXS-512 unet 一步（int8，隨機輸入） | 7,682 | 13,466 | 1.75 | 2.1e-1／34.8 dB（最大值 4.15） | 1,632 MB | 4,555 MB |
| Whisper base 編碼器 | 未量：本機沒有檔案，未下載 | | | | | |
| midigenai v5 16 步 | 未量：本機沒有檔案，未下載 | | | | | |

- **Basic Pitch、YAMNet 有三次量測**（早期含低優先權版本、第一批、逐模型獨立行程版）：Basic Pitch 原生比 WASM 快 1.7～1.9 倍；YAMNet 快 3.6 倍（第一批）到 10 倍（最後一批，因為那次 WASM 特別慢，從 200 變 470 毫秒）。YAMNet 的絕對值只有幾十到幾百毫秒，這台忙碌機器上雜訊比差距還大，**方向一致（原生較快），倍數不要當真，保守取 3 到 4 倍以上**。
- 其餘模型單次計時之間差距小（Depth 與 SlimSAM 同題各次差不到 10%），倍數可信度較高。Demucs 與 SDXS 每題只計 2 次（單次太久），倍數可信度中等。
- 逐題數字在 `test-reports/native-all-models/table-final.md`；原始逐行結果在 `native-final.jsonl`、`wasm-final.jsonl`。
- **載入時間不能拿來比較**：原生是 `InferenceSession.create(檔案路徑)`；WASM 要先經行程間通訊把整個檔案讀進來再編譯，包含了讀檔。原生載入 Demucs 約 20 秒、SDXS unet 約 4 秒，是一次性的成本。
- **記憶體只供參考**：原生是單一行程的峰值（`maxRSS`）；WASM 是整個 Electron（渲染、主程序、背景執行緒）每 0.5 秒輪詢的峰值，可能漏掉短暫高點，而且含基線 624 MB，兩者不能直接相減。方向性：SlimSAM 的原生峰值（3.6 GB）比 WASM（2.3 GB）高，推測是原生的記憶體配置策略（未驗證，沒有試關閉）；SDXS 的 WASM 整體峰值 4.6 GB 遠高於原生 1.6 GB。
- **誤差的意義**：Basic Pitch、YAMNet、Depth、SlimSAM 的差異在浮點誤差範圍（訊噪比超過 100 dB）。Demucs 57.7 dB，過了階段 3 的 40 dB 門檻。**SDXS unet 在隨機輸入下訊噪比只有 34.8 dB**：int8 量化的矩陣乘法在原生與 WASM 內核的捨入不同，誤差被放大；這不等於影像品質差，但**階段 5 的驗收（影像 PSNR ≥ 35 dB）必須用真的生圖逐張比**，現在不能預先宣稱通過。
- 沒有量到 DirectML、WebGPU（依共識第 9 條，WebGPU 不經原生，也不影響取捨；本次沒有量，標「未量」）。Linux：**未實跑**，全部數字只代表 Windows。

### 7.3 結論：哪些值得走原生（只比 cpu 路徑）

| 模型 | 結論 | 依據（實測） | 風險／保留 |
|---|---|---|---|
| Demucs 6 軌 | **值得，優先**（單次省的絕對時間最多） | 每段 7.8 秒音訊省約 13.5 秒（31.6→18.0 秒），1.75 倍，訊噪比 57.7 dB；三首歌段數多時累積省很多（推測：3 分鐘約 24 段，約省 5 分鐘，未實跑整首歌） | 峰值記憶體約 1.9 GB、載入約 20 秒；圖形最佳化仍須關閉；取消的最壞延遲是一段約 18 秒；段界有無接縫仍未確認（見附錄） |
| Depth Anything V2 Small | **值得** | 4.4 對 7.4 秒，1.7 倍，誤差極小（131 dB） | 491 MB；輸入尺寸這次用 518×518 的固定值，產品實際輸入尺寸不同時倍數可能略異（推測） |
| SDXS unet | **值得，但要先過影像比對** | 一步 7.7 對 13.5 秒，1.75 倍；原生記憶體 1.6 GB 遠低於 WASM 整體 4.6 GB | unet 輸出訊噪比 34.8 dB；要完整生圖（text encoder＋unet＋VAE）後比 PSNR；text encoder 與 VAE 本次未量 |
| Basic Pitch | **值得當試點** | 1.7～1.9 倍、誤差 1e-6、記憶體 136 MB | 每窗省約 80～90 毫秒，絕對收益小；價值在驗證張量協定 |
| YAMNet | **值得當試點** | 原生較快（3.6～10 倍，倍數不穩）、誤差 6e-6 | 同上，絕對值小 |
| SlimSAM 編碼器 | **效益小，往後排** | 只快 1.27 倍（8.0 對 10.2 秒） | 原生峰值 3.6 GB，高於 WASM；除非日後找到降低原生記憶體的設定，否則不急 |
| Whisper base 編碼器 | **無資料，不下結論** | 本機沒有檔案 | 見 7.4 |
| midigenai v5 | **無資料，不下結論** | 本機沒有檔案 | 見 7.4 |

整體：**同樣是 CPU，原生比 WASM 約快 1.3 到 1.9 倍**（Qwen3 0.6B 先前量到 1.3～1.5 倍），模型越大、單次計算越重，絕對省下的時間越多；小模型倍數大但絕對值小。

### 7.4 本機沒有、未量的模型（只列出，沒有下載）

| 模型 | 檔名 | 來源 | 大小 |
|---|---|---|---|
| Whisper base 編碼器（q8） | `onnx/encoder_model_quantized.onnx` | `https://huggingface.co/onnx-community/whisper-base` | 登錄寫整個 Whisper base（編碼器＋解碼器）約 80 MB，編碼器單檔大小未查證；使用者瀏覽器快取裡沒有 Whisper 的檔案（實查快取清單） |
| midigenai v5 CPU 版 | `decoder-wasm-int8.onnx` | `https://huggingface.co/nicholasbien/midigenai/resolve/main/v5/onnx/decoder-wasm-int8.onnx` | 114,561,179 位元組，SHA-256 `5ca00f42ba3900aeb6d98821d4e8b559a880c8d99d62dbdc0d1555a38c1eed65`；使用者資料庫裡沒有 |

量測腳本裡這兩項已寫好設定（`bench-config.json`），midigenai 的「逐步迴圈（KV 快取）」輸入尚未實作（`inputs: "kv_loop"`），拿到檔案後要先補；Whisper 輸入是 `input_features [1,80,3000]`，已可直接量。

### 7.5 這次下載的檔案紀錄（使用者 2026-11-05 同意，僅此一項）

- 放在工作階段暫存資料夾（不在倉庫內、不在使用者安裝版資料夾），只拿來量測，不散佈。
- SDXS-512 CPU int8 版，來源 `lequangky/tipsy-sdxs-512-int8`，commit `41203dc02882252d74bb683dedc9bfde08641b55`（下載網址直接用這個 commit，不是 `main`）。授權 CreativeML Open RAIL++-M（有使用限制，說明照 `renderer/src/imagegen/local_sd.js` 的 `LICENSE`）。位元組數核對全部相符：

| 檔案 | 位元組 | SHA-256 |
|---|---|---|
| `text_encoder.onnx` | 237,811,651 | `7c99acee71d4a604c60591c5ed9e19b7bcd9f8ee589c07584639a85f1e2e7afa` |
| `unet.onnx` | 873,388,448 | `d311df495bb008b82c3c8f50767d042efab97aaf59b2592fbdb4e5044baac568` |
| `vae_decoder.onnx` | 4,912,820 | `801e913994dc73d9ec68643d555d4325a70b72f431ffbf33b2b1c278dd5da72f` |

- 這三個檔案登錄檔只釘了位元組數，沒有釘 SHA-256；上表是這次實際下載的檔案算出來的，可以補進登錄（`local_sd.js` 的 `MODELS`）。
- TAESD（MIT 授權，`julienkay/taesd`，commit `c8a437fd0201c21c3bcd298fcf3181b063bcc1eb`）：`vae_encoder/model.onnx` 4,910,437 位元組、`vae_decoder/model.onnx` 4,912,312 位元組，皆與登錄相符。本次未量測（SDXS 只量 unet 一步）。
- 其他模型沒有下載：Basic Pitch、YAMNet、Demucs 從使用者安裝版的瀏覽器資料庫唯讀還原（SHA-256 全部與登錄釘住的值相同）；Depth Anything V2 Small 與 SlimSAM 編碼器從使用者瀏覽器的快取唯讀還原（登錄沒有檢查碼，只核對大小：99,060,839 與 8,882,165 位元組，且 ONNX 能載入；SHA-256 為 `afb6a5c2…10c`、`cce23c7b…2971`）。

### 7.6 這次沒驗證的部分（誠實列出）

- Linux 全部未實跑。DirectML、CUDA、WebGPU 都沒量。
- 是在有其他工作階段同時跑的機器上量的，單次計時有雜訊（特別是 YAMNet、Basic Pitch 這類幾十毫秒的），沒有關掉背景程式重量。
- 輸入是固定種子的合成資料（音訊用正弦加雜訊、影像用漸層加方塊），不是真實歌曲或照片；速度對輸入內容不敏感（推測），但誤差數字（尤其 SDXS）換成真實輸入可能不同。
- WASM 端用 CDN 版 `onnxruntime-web` 1.22.0 的 WebGPU 打包檔但只走 wasm 後端，與產品相同；沒有量 `crossOriginIsolated` 為真時的多執行緒差異（這個桌面版頁面為 false）。
- 記憶體輪詢間隔 0.5 秒，WASM 峰值可能偏低。
- Demucs 段界有無重疊相加、Whisper 80 對 77 MB 的差異，都因為沒有檔案或沒有進一步查而維持原狀。

### 7.7 待真人驗證（不算待辦）

- Linux 環境補量（沒有 Linux 機器）。
- 真實歌曲／照片／圖片的端對端結果比對（分軌聽感、深度圖視覺、SDXS 生圖 PSNR）。

---

## 8. 階段 2～3 實作結果（2026-11-05，已實作並用真 Electron 驗證）

> 做完的部分：Basic Pitch、YAMNet、Demucs 6 軌、Depth Anything V2 Small 都能走原生（只有使用者選 CPU，或選自動而且沒有 WebGPU 時才試；選 WebGPU 完全不碰原生），失敗自動退回網頁版並寫出真實原因。這份文件因此改名為 `DESIGN.native-all-models.md`；沒做的部分列在 8.6「待改善」，需要真人驗證的列在 8.7，都不算待辦。

### 8.1 架構（跟第 2 節原設計的差異與理由）

- **張量協定寫在 `main-ext.js` 的 `NRT` 區塊，沒有改 `nr-protocol.js`／`nr-child.js`**：那兩個檔屬於執行包，有 md5 釘在清單裡並從 GitHub 分支下載，改了會讓已安裝的執行包核對失敗；`main-ext.js` 會被熱更新送達，舊安裝也收得到。
- 子程序用 `ELECTRON_RUN_AS_NODE=1 electron -e <原始碼>` 啟動（原始碼就是 `NRT.tensorChildMain` 的 `toString`，不另寫檔），`onnxruntime-node` 從已安裝的執行包載入。每個模型一個子程序、一次一個要求；逾時就強制結束；崩潰時等待中的要求收到 `crashed`；閒置 10 分鐘結束，之後下一次 `run` 自動重新載入同一個模型（呼叫端手上的 session 不用重建）。
- 控制訊息走標準輸入輸出（一行一則 JSON），張量走暫存檔；**小張量（輸入合計不到 6 MB、輸出不到 8 MB）直接放在信箱請求／回應裡（base64）**，少幾次檔案讀寫與行程間通訊——這是測出來的：信箱往返最低約 20 毫秒，每窗一次呼叫的小模型會被固定成本吃掉。信箱輪詢從 200 毫秒縮到 10 毫秒（主程序）與 5 毫秒（渲染程序，用列目錄確認回應檔出現才讀，因為對不存在的檔案 `readFile` 每次都會讓主程序記一筆錯誤日誌）。寫到一半的請求檔不再被當成壞檔丟掉（輪詢變密後真的發生過，測試抓到）。
- 信箱新增 `onnx_status`、`onnx_install`、`onnx_load`、`onnx_run`、`onnx_release`。模型檔放 `<userData>/native-models/<id>/<檔名>`，旁邊的 `.ok` 記大小與 SHA-256，核對過才算裝好；名稱一律限制成 `[A-Za-z0-9._-]`，不接受路徑。
- 渲染端 `renderer/src/music/native_ort.js`（`FaNativeOrt`）：把原生子程序包成跟 onnxruntime-web 同介面的 session（`inputNames`、`outputNames`、`run`），所以 `makeTranscriber`／`makeClassifier`／`makeSeparator` 一行都沒改；`withFallback` 在原生 `run` 第一次失敗時永久切到網頁版 WASM（原因記在 `lastError`），結果格式不變。
- 音訊三個模型：`_nrAudioSession`（`floating-assistant.js`）把 IndexedDB 裡已下載好的分片一片一片寫到原生資料夾（不重新下載、不整個放進記憶體），SHA-256 全部核對。深度：`_depthNative` 從瀏覽器快取（transformers.js 已下載好的 `onnx/model.onnx`）取檔寫進原生資料夾，沒有就回報原因並走網頁版（原生不自己下載）。
- 深度的前後處理在渲染程序：短邊對到 518、保持長寬比、取 14 的倍數、正規化（照 `preprocessor_config.json`），輸出用雙線性縮回原圖大小（與網頁版 Worker 回傳的形狀約定一致）。

### 8.2 真 Electron 驗證（隔離 `--user-data-dir`、`FA_BROWSER_CONTROL_PORT` 換埠、沒有用 17923；模型用使用者現有的檔案，沒有下載）

腳本：`scripts/eval/native_audio_e2e.js`（用法在檔頭）。同一組輸入、原生與網頁版交錯呼叫，這台機器同時有其他程式在跑，單次計時抖動很大，看中位數。

| 模型 | 原生（毫秒，端對端含信箱） | 網頁版 WASM（毫秒） | 原生快幾倍 | 輸出差異 |
|---|---|---|---|---|
| Basic Pitch（每窗一次呼叫） | 約 190～250 | 約 130～180 | **約 0.7～0.9（原生略慢）** | 最大絕對誤差 7.5e-7 |
| YAMNet（3 秒音訊） | 74～124 | 140～180 | 約 1.5～2.4 | 最大絕對誤差 9.1e-6 |
| Demucs 6 軌（每段 7.8 秒） | 26,903 | 32,779 | 約 1.2（單獨量測是 1.75，App 內 CPU 被 Electron 自己分走） | 最大絕對誤差 9.9e-4，訊噪比 56.3 dB（門檻 40 dB） |
| Depth Anything V2 Small（640×480 圖，含前後處理） | 6,055 | 8,658 | 約 1.4 | 與網頁版相關係數 0.998，平均絕對差為值域的 1.3%（差別來自縮放：畫布對 transformers.js） |

- **整條音訊轉 MIDI 流程**（40 秒合成音訊，Basic Pitch＋YAMNet）：原生（模型已裝進原生資料夾）約 0.65 秒，網頁版約 1.4 秒，兩邊轉出同樣的音軌與 10 個音。較快主要來自原生子程序常駐、不用每次重建工作階段；第一次使用要把模型寫進原生資料夾，多花約 6 秒（Demucs 另加載入約 22 秒）。
- Demucs 開分軌的流程（16 秒音訊）原生開、關兩次都轉出同樣的 4 個音軌；注意流程本身會把分軌結果存起來續用，所以第二、三次的時間不能拿來比速度，速度以上表「每段」為準。
- **退回路徑真的走過**：①刻意不給執行包 → 進度卡與結果的「沒做到的部分」寫出「原生不可用（沒有可用的執行包…真實原因），改用網頁版 WASM」，流程照常完成；②測試期間有一次請求驗證寫錯，原生 `run` 失敗，自動退回網頁版並寫出原因，結果正確。
- 單元測試：`tests/native/tensor_host.test.js`（20 項：載入失敗、輸入位元組不符、逾時強制結束後可重載、崩潰、閒置關閉後自動重載、dispose）、`scripts/music-tests/native_ort.test.js`（30 項：分片安裝、小／大張量、subarray、退回、深度前後處理手算值）；既有 `audio_runtime`、`audio_models`、`audio_pipeline`、`native_runner`、`vlm_core` 測試全過。

### 8.3 對 7.3 預測的修正（誠實）

- Basic Pitch 在 App 內**沒有淨收益**（原生單獨量測 1.9 倍，但端對端扣掉信箱固定成本與 Electron 搶 CPU 後略慢）。保留原生路徑是因為整條流程仍較快（子程序常駐），而且它驗證了整條張量路徑；若日後只在乎單窗速度，可以把 Basic Pitch 從原生名單拿掉（改 `_nrAudioSession` 的條件即可）。
- Demucs 的收益在 App 內比單獨量測小（1.2 對 1.75），仍是絕對省時最多的（每段約省 6 秒）。

### 8.4 要注意的行為

- 原生模型檔放在使用者資料夾 `native-models`，**目前沒有清除介面**；移除執行包只會關掉子程序，不會刪模型檔（Demucs 約 130 MB）。
- 深度只認瀏覽器快取裡 CPU 版（`onnx/model.onnx`，fp32）；只下載過 GPU 版（fp16）的使用者，原生會回報「快取裡沒有」並走網頁版。
- `floating-assistant.js` 裡 `_audioToMidi` 有兩份重複定義（後面那份生效），這次兩份都改了同一處；之後應該刪掉其中一份（與本功能無關，沒動）。

### 8.5 完成的檔案

`main-ext.js`（NRT、信箱操作）、`renderer/src/music/native_ort.js`、`renderer/src/floating-assistant.js`（`_nrAudioSession`、`_depthNative`、兩處 `load` 閉包、`_depthEstimate` 的一行接線、輪詢間隔）、`scripts/embed-code-ui.js`（嵌入新模組）、`tests/native/tensor_host.test.js`、`scripts/music-tests/native_ort.test.js`、`scripts/eval/native_audio_e2e*.js`。重建產物 `renderer/floating-assistant.js`、`.min.js`、`web-lazy/` 一併更新；`renderer/update-manifest.json` 沒動。

### 8.6 待改善（不是待辦：已知的下一步，沒達標或沒做的原因寫在這裡）

- **SDXS unet**：單獨量測原生快 1.75 倍，但 unet 輸出訊噪比 34.8 dB（int8 內核差異），要用完整生圖比 PSNR 才能決定；text encoder 與 VAE 還沒量。
- **SlimSAM 編碼器**：只快 1.27 倍、原生峰值記憶體 3.6 GB，效益小，往後排。
- **Whisper 編碼器、midigenai**：本機沒有檔案，沒下載所以沒量；midigenai 的逐步迴圈（KV 快取）輸入還沒實作。
- **Demucs**：取消只能在兩段之間生效（最壞延遲一段約 20～30 秒）；段與段之間有無接縫仍未確認。
- **小模型的信箱固定成本**：可以再降（例如一次送多窗），目前沒做。
- **原生模型檔清除介面**、**深度模型 SHA-256 釘住**（登錄沒有檢查碼，目前只核對大小）。
- **Basic Pitch 是否留在原生名單**（見 8.3）。

### 8.7 待真人驗證（不算待辦）

- Linux 全部未實跑（子程序啟動方式、路徑分隔字元、原生執行包都沒在 Linux 試過）。
- 真實歌曲、真實照片的端對端結果（分軌聽感、深度圖視覺、3D 成品）；這次的輸入是合成音訊與合成圖。
- 長音訊（接近 15 分鐘上限）連續分段時的記憶體與時間；使用者安裝版（非隔離 profile）按「安裝原生執行包」後的實際流程。

---

## 9. 部分原生：逐模型註冊表（使用者原則，2026-11-05）

使用者原話：「最根本的、核心的聊天／呼叫 tool／recipe 的有加速，其他的是 nice to have。我希望當我打開 native offline，如果實作還沒做好，就必須維持舊的作法，就是可以 partial native。」另：「速度有變快、保持正確性，這樣就有價值，所以我偏好能接得就都上」；「很少有原生會比 WASM 肥的，這很怪。有的話肯定 WASM 版偷偷改了什麼」。

### 9.1 規則

1. **部分原生**：打開原生離線時，只有「已實作並驗證」的模型走原生；沒實作的模型一律維持舊做法（瀏覽器端／WASM），不報錯、不要求使用者關掉原生、不影響其他功能。
2. **逐模型註冊表**決定路由：`FaNativeOrt.REGISTRY`（`renderer/src/music/native_ort.js`）只列已完成並驗證的模型（目前：`basic-pitch`、`yamnet`、`demucs-6s`、`depth-anything-v2-small`）；不在表裡就是舊路（`routed(id)` 回 `{native:false, why}`，呼叫端連信箱都不問）。每個模型另有開關 `localStorage['fa.native.model.<id>']`（`'0'`＝關，預設開）。新增模型的規則：實作並用真 Electron 驗證（含下面三種退回）之後才加進表。
3. **退回**：已在表裡的模型，原生失敗（執行包沒裝、載入失敗、執行到一半出錯）都退回舊路，輸出格式相同；執行到一半出錯時只有出錯的那一次呼叫（Basic Pitch 一窗、Demucs 一段）改由網頁版重做，已完成的窗／段不重做；失敗原因寫進結果的「沒做到的部分」或進度卡，不顯示莫名錯誤。
4. **核心不受影響**：聊天／呼叫工具／食譜的原生（`qwen3-0.6b`）有自己的路徑（`_nrNativeState`、`backendOrder`）與判斷，不經過這張表；這次的改動沒有碰它，既有 `tests/native/native_runner.test.js`（19 項）與 `renderer/src/vlm/vlm_core.test.js`（143 項，含 `backendOrder`／`wantsNativeBackend`）每次改動後都重跑，全過。
5. **判準改為**：原生能載入並跑通、輸出與瀏覽器端一致、速度沒有變慢，就納入註冊表，不再用「快多少倍」當門檻（SlimSAM 編碼器、SDXS 也要納入；輸出不一致的才暫緩並寫明差異原因）。原生比 WASM 慢或吃更多記憶體視為異常，要逐項對照瀏覽器端的 session 設定查原因。

### 9.2 驗證（真 Electron、隔離 profile，`scripts/eval/native_audio_e2e*.js` 的 `partial_native` 步驟）

| 情況 | 結果（實測） |
|---|---|
| 註冊表外的模型（用 midigenai 代表） | 回 `null`，信箱呼叫 0 次，沒有任何訊息；`routed('whisper-base')` 為 false |
| 逐模型開關關掉（YAMNet） | 回 `null`，信箱呼叫 0 次；其他模型不受影響 |
| 執行包沒裝 | 整條音訊轉 MIDI 照常完成；「沒做到的部分」寫「原生不可用（沒有可用的執行包…真實原因），改用網頁版 WASM」 |
| 載入失敗（原生資料夾的模型檔被換成同大小垃圾） | 回 `null`，原因寫出 onnxruntime 的載入錯誤，改用網頁版 |
| 執行到一半出錯（第二次呼叫前釋放主程序端的模型） | 同一個 session 物件自動切到網頁版，輸出與原生的最大絕對差 5.1e-7，原因「這個模型還沒載入」寫進 notes |

單元測試：`scripts/music-tests/native_ort.test.js` 34 項（含註冊表：表內四個走原生、表外含 `constructor`／`__proto__` 等一律不走、逐模型開關、讀開關失敗當沒設定）。

### 9.3 原生記憶體異常調查（SlimSAM 編碼器，實測）

同一份模型、同一份輸入，各自獨立行程量（ 的做法：只換 session 選項）：

| 選項 | 執行（毫秒，三次） | 峰值記憶體 |
|---|---|---|
| 預設（原本） | 8053、8275、7468 | 3,508 MB |
|  | 12946、8286、8297 | 1,719 MB |
| **** | 7808、7491、7361 | **1,875 MB** |
| 兩個都關 | 12640、12030、12349 | 1,679 MB |
| 圖形最佳化  | 8529、8402、8346 | 3,503 MB |

- **原因**：onnxruntime-node 預設開的記憶體樣式（memory pattern）會依第一次執行的張量配置預先保留一大塊，這個模型（1024×1024 的視覺編碼器）因此多佔約 1.6 GB；關掉後速度沒有變慢（甚至略快）。瀏覽器端（onnxruntime-web）本來就不做這件事，這就是 3.6 GB 對 2.3 GB 的差。關掉記憶體區（arena）也能降，但第一次執行慢約 5 秒，不採用。
- **處理**： 子程序的 session 選項加 （），量測腳本同步。用真 Electron 重跑 Basic Pitch、YAMNet、Depth：輸出完全沒變、速度沒有變慢（Depth 原生 5.8 秒、網頁版 8.2 秒）。Demucs 沒有重量（預期同樣只會少佔記憶體）。
- **Basic Pitch 在 App 內仍比網頁版慢**（約 243 對 166 毫秒）：單獨量測原生是 101 對 193 毫秒。已排除的原因：輸出不一致（誤差 7.5e-7）、記憶體樣式、載入。**沒有證實的假設**：4 核心機器上，信箱輪詢（主程序 10 毫秒、渲染程序 5 毫秒）與 Electron 自己的執行緒搶 CPU，使原生子程序的 4 個計算執行緒變慢（子程序自己量到的計算時間 120～250 毫秒，比單獨量測的 101 毫秒長）。下一步可以試把子程序執行緒數降到 2 或降低輪詢頻率後重量。目前整條流程仍比網頁版快，所以維持在註冊表內。

### 9.4 接續點（尚未做）

- **SlimSAM 編碼器**：記憶體異常已查明並處理（見 9.3），輸出已驗證一致（6e-8）；尚未納入註冊表，因為使用端是  的  分支（transformers.js 的 ，解碼器每點一次），原生只接編碼器要把  與  交回 Worker，需另寫橋接與真 Electron 驗證，做完才加進表。
- **SDXS**：unet 輸出訊噪比 34.8 dB，要用同一份輸入逐輸出比對 int8 算子差異（原因還沒查）；納入前仍須完整生圖（text encoder＋unet＋VAE）比對，不下載新模型（暫存資料夾裡已有使用者同意下載的那份）。
- 其餘（Whisper 編碼器、midigenai）本機沒有檔案，沒下載，維持舊路。
