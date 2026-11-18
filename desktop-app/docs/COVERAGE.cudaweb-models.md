# 離線模型覆蓋表（cudaweb O15a）

對應清單：`docs/CHECKLIST.cudaweb-optimize.md` O15a。
性質：**唯讀盤點**（沒改程式、沒下載模型、沒跑真機）。行號是 2026-11-18 這個 HEAD 的行號；`renderer/src/floating-assistant.js` 內嵌了 `FaVlm`、`FaCatalogEmbed` 等模組的副本，行號指的是這個被建置檔裡的位置，源頭檔在 `renderer/src/vlm/vlm_core.js` 等。

## 這台機器的前提

- Intel 內顯，WebGPU adapter 沒有 `shader-f16`，沒有 CUDA。
- `renderer/src/floating-assistant.js:14257-14262`（`resolveDevice`）：模型登記 `gpuNeedsF16: true`，且偵測到 WebGPU 但 `f16 === false` 時，**不走 GPU**，改 `wasm`（CPU）；標 `gpuOnly` 的模型直接報錯。所以下表所有 `gpuNeedsF16` 的模型，在這台的實際執行裝置是 **CPU（wasm）**，這是程式寫死的規則，不是猜的。
- 「GPU 可否在這台跑」一欄的寫法：`否（f16 閘門）`＝程式擋住；`可能（未量測）`＝沒有 f16 需求，但沒有真機資料；`未知`＝查不到。

## 表一：每個離線模型

| 模型／功能 | 執行環境 | 現在跑在哪（預設） | 經過 cudaweb 優化核心？ | 這台能否走 GPU | 缺哪些算子 | 證據（檔案:行） |
|---|---|---|---|---|---|---|
| **Florence-2 base**（圖像轉文字，預設 VLM） | transformers.js 3.7.5，離線 Worker | WASM（CPU）q8；GPU 版是 q4f16 | 否：`faVlmWorkerMain` 沒有任何 cudaweb 呼叫 | 否（f16 閘門） | 未知（沒有取得模型圖） | 登記 `floating-assistant.js:14176`；載入 `:77265-77266`；閘門 `:14260`；源頭 `renderer/src/vlm/vlm_core.js:97-98` |
| **SmolVLM 256M**（圖像轉文字） | 同上（`vision2seq`） | WASM q8 | 否（cudaweb 的 SmolVLM 視覺路徑只在 `O13b` 的 CPU fp32 測試通過，沒接進 Worker） | 否（f16 閘門） | 未知 | 登記 `:14180`；載入 `:77267-77268`；cudaweb 對拍見 commit `5b4416a6a` |
| **LLaVA-Interleave Qwen 0.5B**（實驗） | 同上（`llava`） | WASM q8 | 否 | 否（f16 閘門） | 未知 | 登記 `:14201`；載入 `:77270-77272` |
| **Qwen3 聊天 LLM（網頁，0.6B～1.7B）** | transformers.js `AutoModelForCausalLM`（Worker）；另有 `studio` 的 ORT-web 路徑 | WASM q8；GPU 版是 q4f16 | 部分：網頁 Qwen3 q8 整段 GPU 解碼（`qwenGpuDecode`）只是選用，預設關 | 網頁 q4f16 路徑：否（f16 閘門）；q8 GPU 解碼：**未知**（沒有真卡量測） | 未知 | 登記 `:14209-14227`；載入 `:77284-77287`；`qwenGpuDecode` 預設 `:84625`、`:86092`、解碼 `:130509-130514`、`:11023` |
| **Qwen3 聊天 LLM（桌面原生 runner）** | 原生（`nr-engine.js` 子程序，ORT-node CPU） | CPU；`nrGpuHead` 選用把 lm_head 放 WebGPU | 部分：只有 lm_head 可選走 cudaweb，預設關 | lm_head：可能（未量測）；其餘：否（CPU） | 未知 | `nr-engine.js:33-35, 59-62`（cpu EP）；`nrGpuHead` 預設 `:84625`、`:86081`、`:130463-130477` |
| **studio 的 LLM 推論（網頁訓練工作台）** | ORT-web（`llm_web_core.js`、`qwen3_layered_engine.js`） | WASM（`executionProviders: ['wasm']`）；layered 引擎的 `ep` 由呼叫端決定 | 否（`cudaweb` 字樣只出現在註解或設定，沒有 cudaweb session） | 否（目前寫死 wasm；layered 引擎若傳 webgpu 則理論可能，**未查**） | 未知 | `renderer/src/studio/llm_web_core.js:106`；`renderer/src/studio/studio_server_core.js:366`；`renderer/src/studio/qwen3_layered_engine.js:39` |
| **深度估計 Depth Anything V2 Small**（`/image-to-3d` 基礎層） | transformers.js 的 `depth-estimation` pipeline（網頁）；原生 ORT-node（桌面 `FaNativeOrt.depth`） | 網頁：`gpuNeedsF16` 模型，這台降到 WASM fp32；桌面：原生 CPU fp32 | 否（原生路徑 `_nrDepthSess` 沒有 cudaweb 呼叫） | 否（f16 閘門；fp32 WebGPU 路徑未實測） | int8 版在 WASM 缺 `ConvInteger`（登記註記，2026-10-30 實測），所以 CPU 用 fp32 | 登記 `:14229-14230`；pipeline `:77290-77291`；原生 `:129080-129108`；閘門 `:14260` |
| **SlimSAM 77**（分割，`/image-to-3d --segment`） | transformers.js `SamModel`（Worker）；編碼器可走原生 ORT-node | 網頁：這台降 CPU（q8 或 fp16 被閘門擋）；編碼器原生：CPU | 否 | 否（f16 閘門） | 未知 | 登記 `:14232`；載入 `:77297-77298`；原生編碼器 `:129112-129124`；`_segmentObjects` `:129136-129157` |
| **MoveNet Thunder**（姿態，`/image-to-3d` 找手臂） | transformers.js `AutoModel`（退回基礎類別，只跑 ONNX） | fp32；**沒有** `gpuNeedsF16`，所以在有 WebGPU 的環境會走 WebGPU fp32 | 否 | **可能**（fp32 不被 f16 閘門擋；這台 WebGPU fp32 **未量測**，登記的實測只有 CPU） | 未知（登記的實測是 CPU 成功） | 登記 `:14237-14238`；載入 `:77293-77295`；閘門不擋 `:14260` |
| **物件偵測** | 未找到模型 | 不適用 | 不適用 | 不適用 | 不適用 | 在 `renderer/src`、`main-ext.js`、`nr-*.js`、`native-slot-model.js` 搜尋 DETR／YOLO／OWL／object-detection，**沒有命中**。`/image-to-3d` 的物件切分用的是 SlimSAM，不是偵測模型。尚未搜 `renderer/vendor` 與 `web-lazy` 以外的其他目錄，所以「完全沒有」這個結論是 **未完全確認** |
| **midigenai v5 作曲（桌面）** | onnxruntime-web；WebGPU 版為 q4（MatMulNBits）檔 | 原路徑 ORT：webgpu 版用 webgpu EP，否則 wasm；預設 `midiGpu: 'off'` | 部分：`midiGpu` 開啟時，12 層 MatMulNBits 投影走 cudaweb，注意力與 RoPE 仍在 CPU | 投影：可能（未量測；WebGPU 版的 q4 檔不是 f16 閘門的對象，但登記沒寫）；注意力與 RoPE：否（CPU） | 注意力與 RoPE 未上 GPU（這是程式的實際狀態，不是缺算子） | `renderer/src/floating-assistant.js:86085`（預設）、`:103987-103989`（cudaweb 分支）、`:104005-104019`（`_midiGpuLoad`）、ORT 原路徑 `:103909-103941`；cudaweb decoder 原始碼 `:16299`（`FA_MIDI_GPU_SRC`） |
| **midigenai v5 作曲（網頁）** | onnxruntime-web（vendor 檔） | webgpu EP（`storageBufferCacheMode: 'lazyRelease'`）若有 adapter，否則 wasm | **未核對**：`web-lazy/chunks/midigpu.js` 的 cudaweb 引用沒有逐行看，只有上一輪的字串計數 | 可能（未量測） | 未知 | `renderer/vendor/midigenai/midigen-web.mjs:354-369`（EP 選擇與 session）；`:63` requestAdapter |
| **Whisper base**（語音轉文字，`transcribe_media`） | transformers.js `automatic-speech-recognition`（q8）；另有原生路徑（`nativeAttached`） | WebGPU 或 WASM，取決於 `order`（未完整追蹤預設值） | 選用：編碼器 cudaweb（`whisperGpu`，預設關）；解碼器與特徵擷取不動 | 編碼器：可能（`whisper_gpu.js` 用 MatMulInteger 與一維卷積，無 f16 需求，未量測）；其餘：CPU | 未知（只知道 `whisper_gpu.js` 的運算失敗會退到 cpu-js） | 模型與 dtype `floating-assistant.js:73262-73263`；pipeline `:91459-91466`；編碼器附掛 `:91492`、`:91535-91537`；預設 `:86086`；`renderer/src/gpu/whisper_attach.js`、`renderer/src/gpu/whisper_gpu.js:2-3` |
| **Kokoro TTS**（語音合成） | transformers.js（`kokoro-js`） | **WASM**（`const device = 'wasm'` 寫死），q8 | 選用：`kokoroGpu`（預設關）的 cudaweb 圖形 session，Conv、ConvTranspose、大 MatMul 上 GPU，其餘在 CPU | 可能（未量測）；但目前 device 寫死 wasm，要改才會試 GPU | 圖形 session 遇到不支援的算子會丟錯，退回原 session；**具體缺哪些算子未知**（需要模型圖） | 型號 `:73318-73319`；`device='wasm'` `:90832`；from_pretrained `:90833-90839`；cudaweb 附掛 `:90846-90864`；預設 `:86089`；`renderer/src/gpu/graph_session.js:1-20`（規則：不支援的算子丟錯） |
| **SDXS 生圖（CPU int8 版）** | onnxruntime-web 1.22.0（`ort.webgpu.min.mjs` 入口）；另有原生路徑 | ORT 的 `ep` 由 `pick` 決定（**未查預設值**） | 選用：`sdxsGpu`（預設關）的 cudaweb 圖形 session，三段（文字編碼器、unet、VAE） | 可能（未量測）；int8 模型的卷積在 GPU 路徑**未知** | 未知 | `renderer/src/floating-assistant.js:105510-105512`（分派）、`:105554-105573`（cudaweb）、`:86088`（預設）、`:105516`、`:105651`（ORT `InferenceSession.create`）、入口 `_localSdLoad` 約 `:105476-105479` |
| **YAMNet／Demucs／Basic Pitch**（音訊轉 MIDI） | onnxruntime-web 1.22.0（`audio_runtime.js`） | `createSession` 預設 `['webgpu','wasm']`；`_audioGpuSession` 另外可走 cudaweb | 選用：`audioGpu`（預設關）的 cudaweb 圖形 session | 可能（未量測） | 未知（依 `graph_session` 規則，不支援的算子會丟錯） | `renderer/src/music/audio_runtime.js:21-23`；`floating-assistant.js:104251`、`:104276`（載入）、`:131429-131437`（cudaweb）、`:86087`（預設） |
| **MOSS-TTS-Nano**（語音合成） | onnxruntime-web（worker 內）；選用 cudaweb 的全域解碼與取樣 | ORT **WASM** 寫死 `executionProviders: ['wasm']`；選用 `mossGpu`（預設關） | 選用：decode 一步與取樣（`moss_decoder`、`moss_gpu`、`moss_sampling`）。**codec 解碼仍在 ORT wasm**（卷積 GPU 版驗證過，但整圖在 CPU 解釋器上慢，所以沒接） | 可能（未量測）：WebGPU 探測需要 adapter | codec 的卷積：未接（原因是效能，不是缺算子） | `renderer/src/tts/moss_worker.js:17-19`（wasm 寫死）、`:30`、`:94-97`（gpu 分支）；`renderer/src/tts/moss_gpu_runners.js:2-6`（範圍與 codec 註記）、`:15-22`（探測）；預設 `floating-assistant.js:84625` |
| **multilingual-e5-small**（語意向量，`intent_gate`、知識檢索、單元目錄） | transformers.js 3.7.5 `feature-extraction`（q8） | **WASM 寫死**（`device: 'wasm'`） | 否 | 否（沒有接 GPU 的 device；理論上可改，未做） | 不適用（沒有接） | 模型 `renderer/src/catalog/embed_core.js:10`；單元目錄 `floating-assistant.js:127421`；vendor 路徑 `:133385-133393` |
| **離線翻譯**（英中、中英） | transformers.js 3.7.5 `translation`（q8） | **WASM 寫死**（`device: 'wasm'`） | 否 | 否（寫死 wasm） | 不適用 | `floating-assistant.js:133379` |
| **ECAPA-TDNN 聲紋** | onnxruntime-web 1.22.0（CDN） | 未查到執行 device | **否**（註解寫「桌面版原生路徑尚未接」） | 未知 | 未知 | `renderer/src/floating-assistant.js:132285-132290`（註解與模型資訊） |
| **原生 ORT 通用執行（NRT，桌面）** | onnxruntime-node（子程序） | CPU（`executionProviders: ['cpu']`） | 否（主程序與子程序檔案裡沒有 cudaweb 呼叫） | 否（CPU 寫死） | 不適用 | `main-ext.js:1944`；`nr-engine.js:33-35`、`:59-62` |

## 結論（這一版盤點能確定的）

1. **只有 WebGPU 路徑、沒有 f16 需求的模型，在這台可能真的用到 GPU**：MoveNet（fp32，transformers.js 原路徑）、midigen 的投影（q4 MatMulNBits）、Whisper 編碼器（cudaweb 選用）、Kokoro／SDXS／音訊（cudaweb 選用，預設關）、MOSS 解碼（cudaweb 選用，預設關）。**都沒有在這台量過**。
2. **所有 `gpuNeedsF16` 的模型在這台一律跑 CPU**（Florence-2、SmolVLM、LLaVA、Depth Anything、SlimSAM、Qwen3 網頁版）。這是程式的閘門，不是 cudaweb 缺算子。要讓它們用 GPU，必須改用 f32／q8 的 GPU 路徑，這一項屬於 O15b 的範圍。
3. **已接 cudaweb 的，預設全部關閉**（`midiGpu`、`whisperGpu`、`audioGpu`、`sdxsGpu`、`kokoroGpu`、`mossGpu`、`qwenGpuDecode`、`nrGpuHead`，見 `floating-assistant.js:84625`、`:86081-86092`）。
4. **沒有接 cudaweb、也沒有 GPU device 的**：VLM 三個、深度、分割、姿態（登記仍是 CPU 實測）、e5 嵌入、離線翻譯、ECAPA、原生 NRT。
5. **物件偵測沒有對應的模型**（搜尋未命中）。

## 這份表沒做的（明確的缺口）

- **沒有真機量測**：所有「可能」都是未量測。這台是 Intel 內顯，沒有 CUDA；cudaweb 的 WGSL 在真 GPU 上也**還沒驗證**（見 `CHECKLIST.cudaweb-optimize.md` O14b、O14c）。
- **沒有逐一取得模型圖**，所以「缺哪些算子」全部是**未知**，除了登記中已有實測記錄的 `ConvInteger`（depth int8 在 WASM）。要列出完整缺口，需要讀每個 ONNX 的節點清單，這需要下載或讀瀏覽器快取，本次不做。
- **預設裝置未完整追蹤**：Whisper 的 `order`、SDXS 的 `pick.ep`、layered 引擎的 `ep`，以及 studio 推論是否會傳 webgpu，都沒有查到。
- **網頁版 midigen 的 cudaweb 引用**（`web-lazy/chunks/midigpu.js`）只有字串計數，沒有逐行核對。
- **Qwen 桌面原生的完整路徑**（不只是 lm_head）沒有追到底。
- **物件偵測**的搜尋範圍只涵蓋 `renderer/src`、`main-ext.js`、`nr-*.js`、`native-slot-model.js`；`renderer/vendor` 與 `web-lazy` 沒有以偵測關鍵字搜尋。
- 原始 `renderer/src/vlm/vlm_core.js` 與 `floating-assistant.js` 內嵌副本之間的同步性沒有檢查。
