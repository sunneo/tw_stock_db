# 調查：專案所有離線模型盤點，與 cudaweb 的好處

性質：唯讀調查。沒有改程式、沒有跑測試、沒有下載模型、沒有提交或推送。只寫這個檔。
範圍：`desktop-app/renderer/src` 內所有會在本機跑的模型與推論引擎，外加 Python 訓練腳本。
證據以檔案路徑與行號標示。查不到的一律寫「沒查到」。
注意：`floating-assistant.js` 是打包後的大檔，行號取自打包內容，同一段程式可能在 `renderer/src` 的來源模組也有一份。

## 1. 總表

「GPU」欄：有＝程式會優先用 WebGPU；無＝目前只用 CPU（wasm 或 onnxruntime-node）。

| # | 類別 | 模型 | 執行環境 | 網頁版 與 桌面版 | 現在走 GPU？ | 熱點運算子 | cudaweb 現有 | cudaweb 缺 | 好處 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 文字 LLM（Qwen 系列） | Qwen3 0.6B／1.7B、Qwen2.5 0.5B／1.5B、SmolLM2、Granite 4.0 | transformers.js（vlm 路徑）；studio 網頁 LLM 用 onnxruntime-web wasm；桌面用原生子程序 onnxruntime-node | 網頁：vlm 路徑有 GPU，studio 網頁 LLM 無。桌面：原生子程序無 GPU，lm_head 經 gpuhead 在渲染端 GPU | 部分：vlm 有；studio 網頁與桌面原生解碼無 | 注意力（QK、softmax、V）、MLP、RMSNorm、RoPE、lm_head、KV 快取 | matmul、MLP、lm_head（已與 ORT 對拍）、rmsnorm、softmax、silu、rope | 注意力＋KV 快取組合 | **大** |
| 2 | 視覺語言（VLM）與視覺 | Florence-2 base、SmolVLM 256M、LLaVA-Interleave 0.5B、ViT-GPT2 | transformers.js，裝置 WebGPU 或 wasm | 網頁與桌面的 renderer 相同（vlm_core.js） | 有（gpuNeedsF16 的模型在無 f16 時退 CPU） | 視覺編碼器：卷積、注意力、LayerNorm、GELU；語言解碼器同 #1 | 卷積、GELU、注意力前向有參考實作（`cudnn_subset.js:20,134,142`，未確認是否派發到 GPU） | LayerNorm、視覺注意力、GPU 版卷積（未確認） | 中（已是 GPU，退路是 wasm） |
| 3 | 影像：深度、分割、姿態 | Depth Anything V2 Small、SlimSAM 77、MoveNet Thunder | transformers.js（同 #2） | 同 #2 | 有 | 卷積、注意力（Depth、SlimSAM 的 ViT） | 同 #2 | 同 #2 | 小（模型小、非主要瓶頸） |
| 4 | 影像生成（diffusion） | SDXS-512（文字生圖）；SDXS＋TAESD（圖生圖） | onnxruntime-web：GPU 版 fp16 WebGPU；CPU 版 int8 wasm | 同一份 renderer（local_sd.js、sd_turbo_core.js） | 有（GPU 版）；CPU 版無 | UNet 卷積（大量）、GroupNorm、SiLU、交叉注意力、上採樣、VAE 解碼器卷積 | 卷積參考、GELU、注意力參考（同 #2） | GroupNorm、上採樣、交叉注意力、GPU 卷積（未確認） | 中到大（CPU 版 1.1 GB，最慢；GPU 版已夠快） |
| 5 | 作曲（MIDI 生成） | midigenai v5（12 層解碼器） | onnxruntime-web：GPU 版 q4 WebGPU；CPU 版 int8 wasm | 網頁：有 WebGPU 用 q4，否則 wasm。**桌面：onnxruntime-node 子程序（native_ort.js），只有 CPU int8，KV 快取留在子程序** | 網頁有／無視瀏覽器；**桌面無** | 注意力＋KV 快取、MLP、RMSNorm、softmax、lm_head（598 列，小） | matmul、softmax、rmsnorm、silu、rope | 注意力＋KV 快取組合 | **大**（桌面無 GPU，與 #1 同架構） |
| 6 | 音訊轉 MIDI | Basic Pitch（nmp.onnx）、YAMNet（樂器分類）、Demucs htdemucs-6s（分軌） | onnxruntime-web，裝置順序 webgpu → wasm（audio_runtime.js:2），Demucs 關圖最佳化（audio_runtime.js:41） | 網頁與桌面 renderer 相同；桌面另有 native_ort 路徑（沒查到是否用於此流程） | 有（順序上 WebGPU 優先）；失敗退 wasm | 卷積（Basic Pitch、YAMNet、Demucs）、STFT／逆 STFT（Demucs，沒查到是否在模型圖內） | 卷積參考（同 #2） | GPU 版卷積、STFT（沒查到） | 中（順序已是 GPU 優先，退路 wasm） |
| 7 | 語音辨識（ASR） | Whisper base（onnx-community/whisper-base，q8） | transformers.js，裝置依 VLM 設定（WebGPU 或 wasm） | 網頁與桌面 renderer 相同（vlm_core.js:63；floating-assistant.js:4604、67423） | 依使用者裝置設定，有 WebGPU 可用 | 編碼器卷積（conv1d）、編碼器注意力、解碼器注意力、交叉注意力 | 卷積參考（同 #2）、注意力前向參考 | conv1d GPU（未確認）、交叉注意力 | 中 |
| 8 | 語音合成（TTS） | Kokoro-82M v1.0（kokoro-js，q8） | kokoro-js 在 worker 內，**device 固定 wasm**（floating-assistant.js:73555-73557、90094） | 網頁與桌面 renderer 相同 | **無** | 解碼器（卷積、LSTM 或注意力，架構細節沒查到）、iSTFT | 沒查到對應 | 整個解碼器架構，需先查 kokoro-js 內部 | 中到大（純 CPU，但架構要先查清楚） |
| 9 | 聲音複製 TTS | MOSS-TTS-Nano 0.1B（OpenMOSS，ONNX，含 codec） | onnxruntime-web **只用 wasm**（moss_worker.js:17：`executionProviders: ['wasm']`） | 網頁與桌面共用（moss_core.js、moss_worker.js，嵌入於 floating-assistant.js:16113） | **無** | 預填（prefill）與解碼器的矩陣乘與注意力、取樣、codec 卷積 | matmul、softmax、rmsnorm、rope（在 #1 的基礎上） | 注意力＋KV 快取、codec 卷積 | **大**（純 CPU；moss_worker.js:12 註解說大運算多執行緒快 1.4～2.4 倍，代表 CPU 是瓶頸） |
| 10 | 聲紋（說話人嵌入） | ECAPA-TDNN（astrolabos/ecapa-tdnn，約 80 MB，SpeechBrain 轉檔） | onnxruntime-web，session 由呼叫端注入（ecapa_embed.js:1-5；floating-assistant.js:130369-130418） | 網頁與桌面 renderer 相同 | **沒查到**（執行提供者未在這裡指定） | TDNN 的一維卷積、注意力式池化（attentive pooling） | 卷積參考（同 #2） | 一維卷積、池化 | 小（一次性、短音訊） |
| 11 | 文字嵌入（檢索） | multilingual-e5-small（Xenova，q8，約 118 MB） | transformers.js，EP 沒查到 | 網頁與桌面 renderer 相同（catalog/embed_core.js:10） | **沒查到** | 12 層 Transformer 編碼器（注意力、MLP、LayerNorm） | 同 #1 的注意力（若接上） | 注意力＋LayerNorm | 小（只在建索引時跑） |
| 12 | 文字嵌入（影像生成內） | CLIP ViT-B/32 文字編碼器（Xenova/clip-vit-base-patch32） | 隨 SDXS（onnxruntime-web） | 同 #4 | 跟隨 #4 | 文字編碼器注意力 | 同 #1 | 同 #1 | 小（依附於 #4） |
| 13 | OCR | 沒有獨立 OCR 引擎；由 Florence-2 的 OCR 任務（vlm_core.js:12）與 computer_vision.js:20、50 的 VLM 文字題代替 | 同 #2 | 同 #2 | 同 #2 | 同 #2 | 同 #2 | 同 #2 | 同 #2（不另計） |
| 14 | 人臉 | **沒查到**（renderer 內沒有人臉偵測或辨識模型；「face」字樣都是「surface」等字的子字串） | — | — | — | — | — | — | — |
| 15 | 其他：本機 LoRA 訓練（Qwen3 逐層） | Qwen3 0.6B（onnx-community/Qwen3-0.6B-ONNX）的逐層訓練 | onnxruntime-web，預設 wasm，可選 webgpu（qwen3_layered_engine.js:16-17；webtrain_worker_core.js:84） | 網頁（webtrain worker）與桌面（studio） | 預設無（wasm）；可選 WebGPU | 每層的矩陣乘（LoRA A／B）、反向傳播、AdamW | matmul、adamw（已有） | 反向傳播的 GPU 版（沒查到是否完整） | 中到大（訓練是 CPU 瓶頸；但屬於訓練，非推論） |
| 16 | 其他：Python 訓練腳本（不在瀏覽器） | speech_train.py、train_vlm_lora.py、music_train.py、sr_train.py、a2n_train.py、llm_scratch.py、export_onnx.py | PyTorch（CPU，從註解得知）；pybridge 的 torch 墊片（`renderer/src/pybridge/torch/cuda.py`） | 只在桌面的 Python 環境 | 無 | 同 #1、#2 的算子 | 墊片可接 torch.cuda 呼叫（`cudaweb` 相容層，見 DESIGN.webgpu-cuda.md:366） | 同 #1、#2 | 中（訓練為主；墊片已存在但是否接上這些腳本沒查到） |

## 2. 每類的簡短說明

### 2.1 文字 LLM（#1）
- 網頁：vlm 路徑（transformers.js，`vlm_core.js:28-48`）有 WebGPU；studio 的網頁 LLM 用 onnxruntime-web wasm（`studio/llm_web_core.js:5`、`studio/studio_server_core.js:366`）。
- 桌面：原生子程序（`nr-child.js`，onnxruntime-node）只有 CPU；lm_head 已經透過 gpuhead 送到渲染端 WebGPU（`nr-protocol.js:12-13`，`DESIGN.webgpu-cuda.md:412`）。
- 好處大：studio 網頁 LLM 與桌面原生的整段解碼都在 CPU，而 cudaweb 的 MLP 與 lm_head 已驗證。缺的是注意力與 KV 快取。

### 2.2 VLM 與影像理解（#2、#3）
- 已是 GPU 路徑（transformers.js 的 WebGPU）。cudaweb 的增量只是退路（沒有 WebGPU 的機器）與卷積、LayerNorm 的補強。
- 好處中。

### 2.3 影像生成（#4、#12）
- GPU 版已是 WebGPU fp16（`imagegen/local_sd.js:16`），要求 shader-f16。CPU 版 int8 很慢（1.1 GB，`local_sd.js:18-19`）。
- cudaweb 在這裡的價值只有 CPU 版。但 UNet 的卷積與 GroupNorm 缺口最大，工作量最大。
- 好處中到大（只有 CPU 版）。

### 2.4 MIDI 作曲（#5）
- 網頁：有 WebGPU 用 q4，否則 wasm int8（`music/midigen_bridge.js:95-96`，`music/audio_models.js:13-14`）。
- 桌面：`music/native_ort.js:1` 把 onnxruntime-node 包成 onnxruntime-web 的介面，只有 CPU。KV 快取留在子程序（`native_ort.js:59`）。
- 好處大：桌面沒有 GPU，且架構與 #1 相同。

### 2.5 音訊轉 MIDI（#6）
- 已經是 WebGPU 優先（`music/audio_runtime.js:2`）。
- Demucs 因為圖形最佳化會讓 wasm 與 WebGPU 建 session 失敗，所以關掉最佳化（`audio_runtime.js:41`）。這代表它的圖形在 cudaweb 上也要分開驗證。
- 好處中。

### 2.6 語音辨識（#7）
- Whisper base 走 transformers.js，裝置跟 VLM 設定共用（`vlm_core.js:63`）。
- 好處中。

### 2.7 語音合成（#8）
- Kokoro 固定 wasm（`floating-assistant.js:73555-73557`，`90094`）。
- 解碼器架構沒查到，所以工作量無法估計。要先查 kokoro-js 的圖形。
- 好處中到大（純 CPU）。

### 2.8 聲音複製（#9）
- MOSS-TTS-Nano 只用 wasm（`tts/moss_worker.js:17`）。
- `moss_worker.js:12` 的註解記錄：多執行緒對大運算快 1.4～2.4 倍，92 幀要 21 秒。這代表計算量大，CPU 是瓶頸。
- 好處大。工作量中到大（注意力與 codec 卷積）。

### 2.9 聲紋與嵌入（#10、#11、#12）
- 聲紋 ECAPA：執行提供者沒查到（`ecapa_embed.js:1-5` 說 session 由呼叫端注入）。
- 文字嵌入 e5：只在建索引時跑，好處小。
- CLIP 文字編碼器：跟隨 SDXS，好處小。

### 2.10 OCR 與人臉（#13、#14）
- OCR 沒有獨立引擎，用 VLM 代替（`computer/computer_vision.js:20,50`）。
- 人臉：沒查到任何模型。

### 2.11 本機 LoRA 訓練（#15）與 Python 訓練（#16）
- 本機訓練（`studio/qwen3_layered_engine.js`）是逐層訓練，已有 matmul 與 adamw。預設 wasm。
- Python 腳本（#16）是 PyTorch CPU，不在瀏覽器執行。它們屬於訓練，不是本次「推論」的主要範圍，但若要 GPU 化要另外規劃。

## 3. cudaweb 的缺口，依共用程度排序

這個排序很重要，因為下面的第一步很多都共用同一個元件：

1. **注意力＋KV 快取**：#1、#5、#7、#9、#11 都需要。目前只有單體的注意力前向參考（`cudnn_subset.js:142`）。**最高共用度**。
2. **卷積（conv1d、conv2d）的 GPU 派發**：#2、#3、#4、#6、#7、#10 都需要。參考實作存在，但沒查到是否派發到 WebGPU（`cudnn_subset.js:20,37`）。
3. **LayerNorm、GroupNorm**：#2、#4、#11 需要。目前只有 rmsnorm。
4. **上採樣、STFT**：#4、#6、#8 需要。沒查到。

## 4. 排序：好處大 × 工作量小 的前 5 名

| 排名 | 項目 | 好處 | 工作量 | 第一步（最小可驗證） |
|---|---|---|---|---|
| 1 | 注意力＋KV 快取（共用元件），先接到 Qwen3 0.6B | 大：studio 網頁 LLM 與桌面原生解碼都在 CPU；且解鎖 #5、#9 | 中（MLP 與 lm_head 已有，只差注意力與快取） | 取 Qwen3 0.6B 第 0 層，做一步 decode（有 KV 快取），與 `onnxruntime-web` wasm 的同層輸出比對，看相對誤差與 token 是否一致。 |
| 2 | MIDI 桌面原生（midigenai） | 大：桌面目前只有 CPU int8，且架構與 #1 相同 | 小（共用 #1 的注意力，之後只要接子程序） | 取 midigenai GPU 版的單步 logits，與 `native_ort.js` 的 onnxruntime-node CPU 版比對（先確認 KV 快取格式：GPU 版 `(1,H,P,D)`，CPU 版 time-major `(1,P,H,D)`，見 `midigen_bridge.js:125`）。 |
| 3 | MOSS-TTS-Nano 的解碼器 | 大：純 CPU，計算量大 | 中（需要 #1 的注意力，另外 codec 卷積） | 量 `decode_step` 的矩陣乘佔比（用現有 moss 的計時欄位 `moss_worker.js:9`），確認 GPU 能救的部分，再取一層與 wasm 比對。 |
| 4 | 卷積（conv1d、conv2d）的 GPU 派發（共用元件） | 中：#2、#4、#6、#7、#10 都會用到 | 小到中（參考實作已存在） | 取 Basic Pitch 的第一個卷積，在 cudaweb 上跑，與 `cudnn_subset.js` 的參考實作與 onnxruntime-web 比對。 |
| 5 | Whisper base 的編碼器 | 中：語音辨識現在是依裝置設定，無 WebGPU 時 CPU 慢 | 小到中（依賴 #1 注意力與 #4 卷積） | 取 whisper-base 編碼器的第一層（conv1d＋注意力），與 transformers.js 輸出比對。 |

**沒有排進前 5 的理由**：
- Kokoro（#8）好處中到大，但架構沒查到，工作量無法估計。建議先另外查 kokoro-js 的圖形，再排。
- SDXS（#4）好處中到大，但 GroupNorm、上採樣、交叉注意力都缺，工作量大。
- 嵌入（#11、#12）、聲紋（#10）、人臉（#14）好處小或沒有模型。

## 5. 沒查到或不確定的

- `cudnn_subset.js` 的卷積與注意力是否真的派發到 WebGPU 核心（只看到參考實作與 info 記錄）。
- ECAPA 聲紋與 e5 嵌入的執行提供者（沒查到）。
- Kokoro-82M 的解碼器架構（需查 kokoro-js）。
- 桌面版是否有原生影像生成路徑（沒查到）。
- 人臉模型（沒查到任何）。
- 各模型在 cudaweb 上的實測速度（本次不跑測試，全部沒測）。
- `WebGL2 層是否可用`：`gpu_core.js` 有「WebGL2 版尚未實作」的舊註解，但 `nn_ops.js:97-156` 有 glSupport 與 glRun，狀態不明。

## 6. 證據檔案清單

- `renderer/src/vlm/vlm_core.js`（第 9-63、79-94 行；Florence、SmolVLM、LLaVA、Qwen、Whisper、深度、分割、姿態的模型表）
- `renderer/src/studio/llm_web_core.js`（第 5 行，wasm）、`studio/studio_server_core.js`（第 366 行，wasm）
- `renderer/src/studio/qwen3_layered_engine.js`（第 16-17 行，逐層訓練）、`studio/webtrain_worker_core.js`（第 84 行）
- `renderer/src/music/midigen_bridge.js`（第 95-96、125 行）、`music/audio_models.js`（第 13-14 行）、`music/native_ort.js`（第 1、59 行）、`music/audio_runtime.js`（第 2、23、41 行）
- `renderer/src/imagegen/local_sd.js`（第 3-6、16-22 行）、`imagegen/sd_turbo_core.js`（第 1-20 行）
- `renderer/src/tts/moss_worker.js`（第 8-21 行，第 12 行的效能註解）、`tts/moss_core.js`（與 worker 共用）
- `renderer/src/floating-assistant.js`（打包內容；Kokoro 第 73555-73557、90094 行；Whisper 第 4604、67423、14081 行；嵌入 e5 第 37152 行；ECAPA 第 130369-130418 行；CLIP 第 42231 行）
- `renderer/src/voice/ecapa_embed.js`（第 1-5 行）、`catalog/embed_core.js`（第 10 行）、`computer/computer_vision.js`（第 1-8、20、50 行）
- `renderer/src/gpu/nn_ops.js`（第 92、97-156、179-184 行）、`gpu/cudnn_subset.js`（第 12-142 行）
- `renderer/src/nr-protocol.js` 等（桌面原生：`desktop-app/nr-protocol.js:12-13`，gpuhead）
- `DESIGN.webgpu-cuda.md`（第 366、412 行）
