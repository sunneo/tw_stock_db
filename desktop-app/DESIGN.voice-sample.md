# 聲音樣本（我的聲音）與語音引擎抽象層

使用者要求（2026-10-25）：TTS 要能用自己產生的聲音樣本；語音設定頁有「匯入聲音樣本」「建立聲音樣本」，各有斜線指令；中文、英文都支援；建立後能匯出給別人用（例如 ChatTTS）；匯入後下拉選單、`/media-list-voices` 都找得到、有自己的語音代號，可以「優先使用我的聲音」；TTS 做一層引擎抽象層承接原本的 Kokoro，media-presentation 也要能用這些聲音。

## 語音引擎抽象層
每個聲音有 `engine` 欄位，由對應引擎念；引擎表在 `_ttsEngines()`（floating-assistant.js）：
| 引擎 | 聲音的 engine | 內容 |
|---|---|---|
| kokoro | `local`（英文）、`local-zh`（國語） | 本機 Kokoro-82M：內建聲音與「混合聲音」，不上傳 |
| edge | `api` | Microsoft Edge 線上語音（經自己的 Cloudflare Worker），中文／粵語／日文／韓文… |
| clone | `clone` | 零樣本聲音複製（MOSS-TTS-Nano）：自己的錄音樣本與官方內建示範聲音，中文與英文，本機 |
引擎介面：`{ id, label, test(voice), gate, synth(text, voice, onProgress, speed, opts), status?, install?, remove? }`。`_synthesizeSpeech` 依聲音分派；`text_to_speech`、`/media-text-to-speech`、簡報旁白都走同一個入口。簡報：`_deckTtsGate` 多一個 `clone` 排隊類別（一次一段）；`_deckPrepareSpeech` 對複製聲音不做「英文聲音念中文就翻成英文」的處理（它中英文都能念）；播放器 🎙 面板的聲音清單有「我的錄音樣本」「複製引擎內建」。
複製聲音被放進 `TTS_VOICES`（英文）／`TTS_ZH_VOICES`（中文）的最後面並帶 `clone:true`，所以所有原本用這兩個清單的地方（下拉選單、驗證、/media-list-voices）不用另外處理。

## 兩種聲音樣本

### 1. 錄音樣本（主要，符合原始需求）
「聲音樣本」＝自己的聲音錄音：24kHz 單聲道 16-bit WAV ＋ 念的文字稿 ＋ 名字與語言。核心 `renderer/src/tts/voice_recording.js`（測試 `scripts/tts-tests/voice_recording.test.js`）。
- 建立：麥克風錄音（`/voice-create` 不帶參數、`/voice-record`、設定頁「建立聲音樣本」）。念稿中英文各三句；錄音關掉回音消除／降噪／自動增益（這些會改變聲音特徵），用 ScriptProcessor 收原始樣本；停止後修剪頭尾靜音、重採樣 24kHz、正規化，並做品質檢查（長度、爆音、講話音量、靜音比例、底噪／訊噪比），不合格會說明原因、建議重錄（仍可強制儲存）。
- 匯入：`/voice-import`／設定頁「匯入聲音樣本」，接受 wav、mp3、m4a、ogg、webm、mp4、flac，同樣的處理與品質檢查。
- 存放：自己的 IndexedDB `FloatingAssistantVoiceSamples`（不放檔案快取：它超過容量會自動刪最久沒用的）；設定裡 `advancedSettings.voiceSamples` 是索引（代號、名字、語言、長度），讓聲音能在設定正規化時同步註冊（`_vsReconcile` 以 IndexedDB 為準對齊）。代號 `vs_` 開頭。
- 匯出：`/voice-export <代號>`，下載 `<名字>.wav`（直接當參考音檔）與 `<名字>.voice-sample.json`（念的文字、語言、ChatTTS／XTTS／F5-TTS 的用法）。
- 用來念字：複製引擎（下面）。

### 零樣本聲音複製引擎（MOSS-TTS-Nano）
OpenMOSS 的 0.1B 多語言零樣本 TTS（Apache-2.0），官方有 ONNX 版與 onnxruntime-web 支援；中文、英文，只要一段參考錄音、不需要逐字稿。為什麼選它：能在瀏覽器端 WASM 跑、中英文都支援、真的能從錄音複製聲音（Kokoro 沒有從錄音算向量的編碼器，Pocket TTS 只有英文、瀏覽器版沒有編碼器，Chatterbox/XTTS/F5/CosyVoice 太大）。
- 檔案：TTS repo（語言模型 5 個 ONNX 圖與 2 份共用權重，約 640MB）＋ codec repo（編碼器／解碼器，約 86MB），合計約 728MB；下載一次存在 Cache API `fa-moss-tts-v1`（有進度、逐檔驗大小、可續傳）。來源 huggingface.co（跨來源讀取正常）。安裝要使用者同意（設定頁按鈕、`/voice-install`、第一次用錄音樣本念字時）。
- 推論（`renderer/src/tts/moss_core.js` ＋ `moss_worker.js`，嵌進 worker）：照模型 repo（Apache-2.0）附的 `tts_browser_onnx_meta.json`、`browser_poc_manifest.json` 自己寫，**沒有複製官方瀏覽器專案（Reader）的程式碼**（它沒有附授權）。文字 → SentencePiece BPE 切詞（自己實作，與 python sentencepiece 逐案比對一致；正規化表是逐字元量出來的）→ 提示（每列 17 個整數＝1 文字通道＋16 聲碼通道：im_start、user 前綴、audio_start、參考聲碼列、audio_end、after-reference 前綴、目標文字、assistant 前綴、audio_start）→ prefill 一次吃整個提示 → 每幀 `local_fixed_sampled_frame` 取樣 16 個聲碼＋ `decode_step` → 全部聲碼丟給解碼器得到 48kHz 立體聲 → 單聲道、轉 24kHz、修靜音、段與段補停頓 → 跟 Kokoro 同一個打包（mp3／wav 存檔案快取）。
- 參考錄音：編碼器（48kHz 立體聲 → 16 通道聲碼，12.5 幀／秒），第一次用時編碼並存回 IndexedDB；提示長度上限 250 幀（20 秒）。內建示範聲音（中文 6、英文 5…）的聲碼在 manifest 裡。
- 中文：先轉簡體（模型沒看過繁體字，會被拆成位元組）；中文為主的文字先把阿拉伯數字轉中文念法（`FaZhTts.normalizeNumbers`，另外處理千分位與 3:30）；英文為主的文字模型自己會念數字。長文字依句子切段（中文 70 字、英文 220 字元）。
- 速度與記憶體：onnxruntime-web WASM 單執行緒，約聲音長度的 3 倍時間（有跨來源隔離時用多執行緒）；載入模型後渲染程序約 1.9GB，閒置 5 分鐘自動釋放 worker。語速參數不支援。
- 驗證（測試版，語音辨識＋基頻）：英文、簡體中文、繁體中文、數字日期都念對；女聲參考（基頻中位數 222Hz）複製出 222Hz、男聲參考 113Hz 複製出 107Hz，聲音確實跟著樣本走。
- 設定：`ttsPreferCustomVoice`（預設開）：沒指定聲音時，引擎裝好了就用最新的錄音樣本（中文、英文各自挑；沒裝不會自己下載）。


### 2. 混合聲音（次要，Kokoro 語音向量）
在建立視窗的第二個分頁／帶參數的 `/voice-create`。Kokoro-82M v1.0 的語音包（`voices/<代號>.bin`）是 510 列 × 256 維 float32（522,240 bytes），模型每念一小段依 token 數取一列當風格向量；Kokoro 沒有「從錄音算出向量」的編碼器，所以這種聲音是**把現有聲音依比例混合**（或用種子隨機配比），不是複製你的聲音。這種可以在本機直接念（中英文），也能匯出 `.bin`（Kokoro 系工具可用）。ChatTTS 的說話人向量是另一個空間，不能互通。

## 混合聲音的結構
Kokoro-82M v1.0 的語音包（`voices/<代號>.bin`）：510 列 × 256 維 float32（522,240 bytes）。模型每念一小段，依 token 數取一列當風格向量。所以：
- 建立 ＝ 現有聲音依比例混合（加權平均；`spread` 把結果往外推或往中間收），或用種子隨機挑幾個同語言的聲音、隨機配比（同一個種子永遠同一個聲音）。
- 匯入 ＝ `.bin`（大小必須剛好 522,240 bytes）或本程式匯出的 `.voice.json`（含名字、語言、性別、配方）。
- 匯出 ＝ `.bin`（Kokoro 系工具直接能用，例如 kokoro-js、Kokoro-FastAPI）＋ `.voice.json`（含配方，可再匯入）。
- ChatTTS 的說話人向量是另一個空間（768 維），不能互通；這份設計不做 ChatTTS（要有它的引擎才能試聽與合成）。

## 結構
- 核心：`renderer/src/tts/voice_sample.js`（UMD，純函式；測試 `scripts/tts-tests/voice_sample.test.js`），由 `scripts/embed-code-ui.js` 嵌進 `floating-assistant.js` 的 `VSAMPLE` 區塊（`FaVoiceSample`）。
- 語音代號：英文 `a` 開頭、中文 `z` 開頭，第二個字母 `f`/`m` 是性別，底線後只有小寫英文字母；自訂的名字一律以 `my` 開頭（`af_myvoice`、`zf_mylaoshi`），跟內建分得開。撞名時加字母後綴。
- 存放：語音包放在跟內建語音包同一個 `kokoro-voices` Cache（kokoro-js 找語音包就找這裡）；清單放 `advancedSettings.ttsCustomVoices`（代號、名字、語言、性別、來源、配方）。
- 註冊：自訂聲音被塞進 `TTS_VOICES`（英文）／`TTS_ZH_VOICES`（中文）的最前面並帶 `custom:true`，所以所有下拉選單、`text_to_speech`、`/media-text-to-speech`、`/media-list-voices` 都看得到（`/media-list-voices` 另外有「我的聲音」一節）。正規化設定時先註冊，預設語音才不會被當成不存在。
- 合成：中文走 `generate_from_ids`（不檢查聲音名單）；英文走 `generate`，kokoro-js 的聲音名單是凍結的，所以在 worker／主執行緒覆寫該引擎實例的 `_validate_voice`，自訂代號直接放行。
- 優先使用：`advancedSettings.ttsPreferCustomVoice`（預設開）。沒指定聲音時，中文、英文各自用最新的自訂聲音；中英混合句的英文片段也一樣。
- 語音包被瀏覽器清掉：有配方的（建立的）自動照配方重算；匯入的沒有配方，回明確錯誤請重新匯入。
- 介面：語音設定頁「我的聲音」區塊（建立／匯入按鈕、優先使用勾選、清單：試聽／設為預設／匯出／刪除）；`/voice-create`（不帶參數開視窗；`mix=代號:比例,…`、`random`、`seed=`、`count=`、`spread=`、`lang=`、`gender=`、`play=0`）、`/voice-import`、`/voice-export <代號>`、`/voice-delete <代號>`。

## 樣本再爛也要能合成（2026-10-26）
使用者用自己的聲音合成時遇到「語音合成失敗：11864224」（引擎內部例外只丟出一個數字）；要求取樣再爛都要能合成，背景吵就降噪。核心 `renderer/src/tts/voice_clean.js`（`FaVoiceClean`，測試 `scripts/tts-tests/voice_clean.test.js`）。
- **編碼前一律清理**（錄音原檔不動，聲碼記 `cleanV:1`，舊版沒清理過的聲碼會重算）：去直流＋70Hz 高通 → 爆音修補（軟性壓縮）→ 挑最清楚的一段（最長 12 秒，前面都是雜音就跳過）→ 降噪（頻譜閘控：最安靜 15% 視窗當噪音樣子，逐頻率扣，頻率與時間方向平滑；噪音越大扣越重，訊噪比低於 10 dB 做兩輪；噪音底低於 -62 dB 的乾淨錄音略過）→ 音量正規化。實測（合成樣本，噪音與人聲同樣大＋50Hz 嗡嗡聲＋削平）訊噪比 1 dB → 23 dB，複製合成成功。
- **引擎出錯自動重試**（`LADDER`）：數字代碼、記憶體不足、worker 錯誤都算「可重試」，由輕到重：照原本 → 換新引擎 → 參考片段縮到 120 幀（約 10 秒）→ 縮到 50 幀（約 4 秒）；某一階成功後，後面的段落從那一階開始。四階都失敗才回報，訊息翻成看得懂的話（附原始代碼）。
- 沒做：不改變音高音色（沒有等化、變聲）。數字錯誤的真正原因在沒有使用者錄音的情況下無法確認（推測記憶體不足或參考片段讓模型算不下去），所以用「重試階梯」兜底。

## 效能與音檔格式（2026-10-26）
- **引擎**：用的是官方的 ONNX（`onnxruntime-web`，WASM，在背景執行緒），不是 PyTorch。量測（測試版，4 核心；合成約 7.4 秒語音）：
  | 階段 | 單執行緒 | 現在（執行緒池 3～4，逐幀小運算 1 條） |
  |---|---|---|
  | 預填（參考聲音＋文字） | 4.4 秒 | 1.2～1.4 秒 |
  | 逐幀生成（decode_step ＋ 取樣，92 幀） | 21 秒 | 約 18～20 秒（decode 8～9.6、sample 9～10.6） |
  | 解碼器（48kHz 立體聲） | 10 秒 | 4.2～6.2 秒 |
  | 合計 | 約 35 秒 | 約 24～26 秒（快 27～31%） |
  執行緒池不用跨來源隔離也能開（Electron 的 SharedArrayBuffer 可用）；但逐幀的小運算開多執行緒反而更慢（21 → 27.5 秒），所以 `moss_worker.js` 的 `SMALL` 讓 decode_step 與取樣的 session 固定 1 條（`intraOpNumThreads`）。預設核心數減一（最多 4）；`advancedSettings.mossThreads` 可強制；重試兩次還失敗就退回單執行緒（`_mossSingle`）。worker 回傳 `timing`（各階段毫秒）方便量。
- **為什麼降低取樣率不會變快**：模型生成的是 12.5 幀／秒的聲碼，跟取樣率無關（逐幀生成占約 78%）；48kHz 立體聲是解碼器（約 16%）的結構，沒有輸出 24kHz 的選項，之後的轉 24kHz 只是重採樣。
- **「預先取樣／訓練完定住」**：這個引擎是零樣本——沒有每個人的訓練權重，聲音就是提示裡的參考聲碼。已經快取的有：參考聲碼（第一次用編碼後存回 IndexedDB，`cleanV`）。每段文字還要重算的是預填（現在只占約 5%）；要快取預填的 KV 需要「接續 past 的預填」圖，官方只提供「整段預填」與「單列 decode_step」，用 decode_step 一列一列補文字（約 40 列 × 0.1 秒）比整段預填還慢，所以不做。
- **還沒做、可能再快的**：LM 圖（占 78%）做 int8 量化（估計 1.5～2 倍，要自己量化、驗證音質、並找地方放新檔案）、WebGPU（KV 快取在 CPU／GPU 之間搬運的成本沒量過）、解碼器放第二個 worker 跟下一段生成重疊（簡報多段時省約 16%，要多 100MB 左右記憶體）。
- **簡報旁白的音檔格式**：播放器靠內容認格式（`decodeAudioData`），WAV 與 MP3 都能播。MP3（lamejs，沒有 LAME 標頭）開頭多約 46 毫秒、總長多約 64 毫秒，編碼要 0.8～1.1 秒，檔案小 3 倍；WAV 長度精確、編碼 0.25 秒。設定 `deckAudioFormat`：`auto`（預設）＝這個頁面累計的 WAV 在預算內用 WAV（記憶體 ≤ 4GB 的裝置 24MB，其餘 96MB，約 8～32 分鐘旁白），超過改 MP3；`wav`／`mp3` 強制。匯出封包（.deck.zip 與簡報封包）時 WAV 才壓成 MP3（`AiChatDeck.compressAudio`），封包裡一律是 mp3。
