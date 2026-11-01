# 音樂領域設計與查證（階段 0，2026-11-01）

標「未驗證」的是沒親眼確認的事。交接文件：`DESIGN.TODO.music.md`。

## 1. 音色庫分析（已實測）
工具：`node scripts/sf-analyze.js <sf2 或 piano-web 的 soundfont-gs-b64.js> [--json 輸出] [--corr 0.98]`。對象：GeneralUser GS 2.0.3 BETA，檔案 30.82 MB，16 位元，無 24 位元擴充。

| 項目 | 結果 |
|---|---|
| 樣本 | 920 個，共 30.53 MB；預設音色 287、樂器 324 |
| 未使用樣本 | 0 個（全部被某個預設音色用到） |
| 完全相同的樣本 | 2 組，只能省 0.02 MB |
| 近似重複（前 4096 點相關係數 ≥ 0.98） | 1 對，上限 0.01 MB |
| 取樣率 | 44100 Hz 約 383 個，44000 Hz 48 個，48000 Hz 63 個，32000／33000 Hz 約 88 個，22050 Hz 88 個，其餘零散 |
| 循環樣本 | 915 個；循環終點之後多餘的尾段只有 0.14 MB |

**結論：「找重複區」這條路幾乎沒有收益**（重複加起來不到 0.05 MB），這個音色庫已經很緊。真正的瘦身要靠：
1. 降取樣率（粗估，未壓縮）：上限 32 kHz → 27.1 MB；22.05 kHz → 20.6 MB；16 kHz → 15.1 MB。
2. 壓縮：SF3（Ogg Vorbis）。piano-web 內附的 SpessaSynth 程式裡有 SF3／SF2Pack／Vorbis／`compressSample`／`compressionFunction` 字樣，表示能讀、能壓（**實際能否在網頁裡壓與播，未驗證**，階段 4 開頭先實測）。
3. 依用途刪減：樣本是 16 位元，高音域樂器可大幅降取樣；打擊組與環境音（鳥叫、浪聲、白噪音）可選配成「進階包」。這是階段 4 的設計題，不是重複偵測。
4. 近似重複的偵測目前只比對「同原始音高、長度相近」的樣本，起點對齊零延遲；沒偵測到不代表不同音色聽感沒有重疊，階段 4 若要更積極，要改成「同一個樂器分區相鄰音高共用」的做法（用調音偏移補音高）。

Roland SC-88 的資料只當大小目標，不抽取、不轉換。注意：piano-web 資料夾內有 `sound-font/vsc55.dat`、`vsc88.dat`，**不要讀取、不要使用**。

## 2. 轉譜與拆軌模型查證（網路搜尋結果；只記查到的）
| 模型 | 位置 | 大小 | 授權 | 備註 |
|---|---|---|---|---|
| Basic Pitch（多音轉譜，樂器無關） | Hugging Face `daserge/basic-pitch-onnx`，檔名 `nmp.onnx`，與上游套件內檔案位元組相同（SHA-256 `2c3c1d14…59a0ec`） | 另一份清單寫約 0.2 MB（表格排版不清，**未驗證**） | Apache-2.0（上游 spotify/basic-pitch） | 頁面未寫輸入形狀；**輸入長度、後處理（把輸出轉成音符）與 WebGPU／WASM 實際可跑，未驗證**，階段 5 先實測 |
| HTDemucs 四軌（人聲／鼓／貝斯／其他） | Hugging Face `RabiatS/audio-playground-models`：`htdemucs.onnx`；另有 `htdemucs_6s.onnx`（六軌，加吉他、鋼琴） | 86 MB（六軌版 57 MB）；權重 fp16 存、圖內轉 fp32 | MIT（Meta 的 Demucs） | 頁面寫用 onnxruntime-web 在使用者顯卡上跑，短時間傅立葉轉換在 JavaScript 做；段長與 WebGPU 是否真的可行，**未驗證**。其他搬運版：316 MB（fp32）、166 MB（fp16）、180 MB |
| Open-Unmix UMX-HQ | `edgetools/umx-hq`，只有人聲一軌 | 17.0 MB | MIT | 只有 vocals，不夠四軌 |
| ADTOF 鼓轉譜 | `thebluescreen/adtof-drums-onnx` | 約 2.2 MB | **CC BY-NC-SA 4.0，非商業**，不能內建 | 若要用只能使用者自備 |
| Onsets and Frames 鼓 | `thebluescreen/oaf-drums-onnx` | 未驗證 | 頁面標 Apache-2.0（只看到標籤，**未驗證**） | 八個鼓音高 |
| MT3 類多樂器轉譜 | 查無 ONNX 版 | — | — | 結論：不排進計畫 |

**對階段 5 的影響：** 轉譜用 Basic Pitch（小，可內建或首次使用時下載）；拆軌用 HTDemucs（86 MB，改為使用者按需下載，附進度與核對大小，不內建）；鼓軌轉譜先用「Basic Pitch 對鼓軌的結果＋程式依頻譜區分踢鼓／小鼓／鈸」的自家做法，或 Onsets and Frames 鼓（授權先驗證）。誠實說明：樂器只能分到四軌（或六軌）加鼓。

## 3. piano-web 盤點（一頁清單，唯讀）
全部是無模組系統的全域函式（`<script>` 載入、`document`／`getElementById` 出現 120 次），要搬就是「移植」：把純邏輯抽進 `renderer/src/music/*.js`，畫面用本專案外框重寫。

| 檔案／函式 | 判斷 | 說明 |
|---|---|---|
| `js/midi-export.js`：`varLenEncode`、`buildMidiFile` | 可搬 | 只吃錄製資料，Format 0，階段 1 的 `FaMidi` 寫出器要自己寫成多軌版 |
| `multitrack.js`：`buildMtMidiFile`（約 2474）、`_mtVarLen`、`_mtReadVarLen`、`_mtParseMidiFile`（約 2590–2750） | 可搬（參考） | 多軌 MIDI 寫入與解析，邏輯純，依賴全域狀態處需改成參數 |
| `multitrack.js`：`mtCreateTrack`／`mtDeleteTrack`／`mtCloneTrack`／`mtAddNote`／`mtRemoveNote`／`mtUpdateNote`／`mtSetTrackInstrument`／`mtSetTrackVolume`／`mtSetTrackPan` | 資料模型可搬 | 依賴全域軌道陣列與 DOM 更新，改成純函式＋事件 |
| `multitrack.js`：`_mtBuildSchedEvents`、`_mtScheduleAll`、`_mtPlayNote`、`_mtOfflineTriggerNote` | 要改 | 排程邏輯可參考；播放全綁在 `audioCtx` 與 `getGSEngine()` 單例 |
| `multitrack.js`：`_mtGs*`（約 82–134）、`_mtOfflineGs*`、`_mtLoadSf*` | 要改成只走 GS | 目前同時混用 soundfont-player 的 mp3 樂器與自訂樂器；新設計只留 GS（GM 128＋鼓組），刪掉其餘分支 |
| `multitrack.js`：`mtExportMp3`（3156–3304） | 可搬 | 離線渲染 `OfflineAudioContext` ＋ 鏈 ＋ lame；尾段 3 秒緩衝可沿用 |
| `mp3-export.js`：`buildMp3`、`buildMp3Parallel`（Worker 平行編碼，切點交叉淡化） | 可搬 | 單聲道 128 kbps；本專案改成立體聲與選位元率 |
| `multitrack.js`：`mtRender*`、`_mtRenderMasterCanvasWebGL`、`_mtTimelineMousedown`… 約 1440–2370 | 不搬 | 綁死 piano-web 的 DOM／CSS／WebGL 時間軸，鋼琴捲簾用本專案外框重寫（仿 `FaEditShell`） |
| `multitrack.js`：`_mtAiScoreOverview`、`_mtAiScoreChunk`、`MT_AI_MAX_CHUNK_SIZE=200`、`_mtAiRegisterTools`（約 3834–4437） | 參考設計 | 「AI 讀譜分段」的分塊概念可借，工具註冊是 piano-web 自己的機制，改用本專案工具系統 |
| `multitrack.js`：`_mtBuildSheetMeasures`／`_mtRenderSheetPages`（VexFlow＋pdfMake，載入走 CDN） | 不搬（階段 2 之外） | 樂譜 PDF 不在計畫內 |
| `multitrack.js`：`mtImportMp3`、`audio-import.js`（NMF 非負矩陣分解找頻率成分，Worker 與 WebGL 兩條路徑） | 不搬 | 準確度有限，階段 5 以 Basic Pitch 取代 |
| `gs-engine.js`：`GSEngine`（SpessaSynth 啟動、`noteOn`／`noteOff`／`programChange`／`controlChange`／`stopAll`） | 可搬，需改 | 啟動流程：以 data URI 載入 worklet 處理器與函式庫，再 `addSoundBank`。注意：`noteOn` 等要轉送第 4 個 `eventOptions`（排程時間），否則提前排程失效；改成不用 base64 內嵌，改為延遲載入區塊／下載 |
| `soundfont.js`：`gmFullInstrumentGroups`、`gmProgramForGsValue` | 可搬（資料） | GM 音色分組與編號對照 |
| `custom-instruments.js`（錄音取樣自訂樂器） | 不搬 | 與「只用 GS」衝突 |
| `player.js`：合成鼓、人聲等 WebAudio 自製音色 | 不搬 | 同上 |

授權：SpessaSynth Apache-2.0（保留 `vendor/spessasynth/SPESSASYNTH-LICENSE.txt` 文字）；GeneralUser GS 允許任何用途含商業，需保留授權文字。

## 4. 下一步（階段 1）
純函式核心 `renderer/src/music/midi_core.js`（`FaMidi`）→ 測試 → 播放卡片 → 轉 mp3 → domain `music`。階段 4 開頭先實測 SF3 壓縮可行性。

## 5. 階段 1 實作現況（2026-11-01）
已做並提交:`renderer/src/music/midi_core.js`(FaMidi:解析／寫出／量化／移調／合併拆分／速度表)、`midi_play.js`(FaMidiPlay:事件排程、前瞻播放器、載入 SpessaSynth 與音色庫、離線渲染)、`midi_ui.js`(播放卡片畫面)、`music_knowledge.js`(音樂知識八個主題)。接進 `floating-assistant.js`:對話區塊 ```` ```fa-midi ````、工具 `midi_play`／`midi_to_mp3`／`music_topic`、斜線指令 `/midi`、`/midi-to-mp3`、domain `music`。合成器程式庫放 `renderer/vendor/spessasynth/`(Apache-2.0,附授權文字);音色庫不內建,第一次播放時從 GeneralUser-GS 官方倉庫下載(約 31 MB(原版;2026-11-01 之後預設是瘦身版,大小顯示一律從清單算),已驗證網址回應 200、長度 32319396 位元組)並存在瀏覽器快取。
**已實測(內建瀏覽器、本機伺服器):** 離線渲染一段 4 音的短曲有聲(峰值 0.096,非靜音取樣 5 萬點);播放卡片按播放後 12 個音符事件全部送出、播完按鈕復位、下載 MIDI 回傳 228 位元組。**踩到的坑:** 離線渲染必須在送完事件後等一下(事件經訊息埠非同步送進處理器執行緒,馬上渲染會是靜音);已在 `renderOffline` 加等待。
**未驗證:** (1) 在真正的桌面版／網頁版裡的整條流程(工具呼叫→卡片→播放);(2) `midi_to_mp3` 的 mp3 編碼(沿用 `_encodeMp3`,lamejs 從 CDN 載入);(3) 網頁版的合成器程式庫路徑(由延遲載入基底網址往上兩層推算 `renderer/vendor/spessasynth/`,若實際發佈的目錄結構不同會顯示載入失敗);(4) 聽感(只驗證有聲,沒有人聽過)。
**階段 1 剩下:** 遠端卡片屬階段 2;MIDI 轉 mp3 的真機驗證;`FEATURES.md` 加一條音樂功能(該檔目前有別的工作階段的未提交修改,等它提交後再加)。

## 音色庫分片與延遲載入（2026-11-01）
- 現況：網頁版開頁**不會**載入合成器程式庫與音色庫；只有第一次播放／編輯試聽／轉 mp3 時 `loadSynth` 才下載（程式庫以文字抓取再用 data 位址載入，音色庫放 Cache Storage，第二次直接讀快取）。
- 新增分片來源：`scripts/sf-pack.js <sf2> <輸出目錄> --path=GeneralUser-GS.sf2` 切成每片 ≤ 8 MB 並寫 `manifest.json`（長度與 sha256，整份與每片）；`FaMidiPlay.fetchParts` 逐片核對長度與檢查碼、每片單獨快取（中斷後只補缺的片）、合併後核對總大小。
- **待做（需要推送，由管理層代發）**：把輸出目錄（附 GeneralUser GS 的 `LICENSE.txt`）用 git plumbing 單一 commit 強制推到 `soundfont-assets` 分支，拿到完整 commit SHA 後，把 `FA_ASSET_URLS.gsSoundbankBase` 填成 `https://raw.githubusercontent.com/sunneo/tw_stock_db/<完整SHA>/`，重建並發布；`gsSoundbankBase` 空字串時沿用原始網址（行為不變）。驗證：開頁網路請求清單沒有 sf2／sf3／spessasynth，第一次按播放才出現分片；快取後離線可播。
- 桌面版：音色庫與程式庫不進 live patch manifest；網址相同時由 App 下載。階段 4 瘦身版沿用同一套（manifest 的 version 與 sha256）。

## 階段 4：音色庫瘦身實測（2026-11-01）
工具：`scripts/sf-loop.js`（純函式：自相關找週期、整數週期無縫 loop、持續音判斷、降取樣、截尾；測試 `scripts/music-tests/sf_loop.test.js` 12 項）、`scripts/sf-slim.js`（讀寫 sf2：改 smpl 與 shdr，其餘區塊原樣；`--max-rate`、`--sf3 --quality`）、聽感比對 `scripts/music-tests/sf-compare.html`（原版與瘦身版離線渲染 128 個音色加鼓組，算 24 頻帶差異、音量差、接縫突波）。輸入輸出的音色庫放 repo 外。
實測（GeneralUser GS 原版 32.3 MB、920 個樣本）：
- **GeneralUser 本來就已經設好短 loop**：916 個有 loop 的樣本裡 808 個 loop 短於 0.6 秒，只有 108 個長 loop；自動縮短 loop 只動到 41 個、截尾 145 個，**只省約 1.6 MB（5%）**。誠實結論：找樣本內部 loop 對這個音色庫的效益有限，主要在長 loop 的弦樂與合唱；沒有 loop 的持續音沒有找到需要補的（持續音幾乎都已有 loop）。
- 降取樣是大宗：`--max-rate=22050` → 20.7 MB（−36%）；16000 → 15.3 MB（−53%）。
- SF3（Ogg Vorbis，用 ffmpeg libvorbis，quality 3）加 22050：**5.8 MB（−82%）**，spessasynth 能直接載入播放（128 音色逐一渲染：無靜音、無音量掉落、接縫突波沒有變多；頻帶平均差 3.25 dB，差最大是 GM 35 無琴格貝斯 19 dB、GM 79 等，高頻被低通造成，需要人耳確認）。
- 尚未做：用耳朵聽的確認、16 kHz 與 quality 的取捨、鼓組與打擊類是否要保留 44.1 kHz、`gsSoundbankBase` 與瘦身版的發布（管理層）。

## 階段 5 查證（2026-11-01，來源是網路搜尋與 Hugging Face 頁面，檔案未下載、未在本機跑過）
- **Demucs 6 軌（鼓／貝斯／其他／人聲／吉他／鋼琴）ONNX**：社群匯出 `adowu/htdemucs-6s-onnx`（頁面標 MIT，與上游 facebookresearch/demucs 的 MIT 一致）；`htdemucs_6s.onnx` 258 MB（fp32，opset 17），`htdemucs_6s_fp16weights.onnx` 136 MB（權重 fp16）；輸入 `mix` (1,2,343980) 立體聲 44.1 kHz，輸出 `stems` (1,6,2,343980)，順序 drums、bass、other、vocals、guitar、piano；STFT 已換成 Conv1d 放在圖裡，原始波形直接進；一次 7.8 秒，長曲要分段重疊相加（頁面附 infer.py 的 separate）；頁面範例用 onnxruntime-web 的 wasm 後端載入 fp16 版，**沒提 WebGPU**。另有別的匯出標 57 MB 或授權不明（unblend 頁面警告權重不要假設跟程式碼同為 MIT），**用哪個檔要逐一核對檔案大小與授權後才內建**；**未驗證：瀏覽器實際記憶體與速度**（136 MB 檔在手機大概跑不動，只給桌面版／高階機）。
- **Basic Pitch**：Apache-2.0（spotify/basic-pitch，basic-pitch-ts 也是）；ONNX 檔 `nmp.onnx`（`daserge/basic-pitch-onnx`，SHA-256 2c3c1d14…a0ec，與上游套件內的檔案逐位元組相同）；**檔案大小與輸入輸出張量形狀未查到（未驗證）**，原始模型很小（參數量約 17 萬級，未驗證）；多音、輸出音高格＋起音＋輪廓，適合每個分軌逐軌轉譜。
- **YAMNet（音訊事件分類，521 類，含樂器類）**：Apache-2.0；ONNX 約 14–15 MB（`audiomagic/yamnet-onnx`；Qualcomm 的匯出標 MIT 但卡片指向上游授權，以 Apache-2.0 為準）；STMicroelectronics 有 int8 量化 256 維版（Apache-2.0，更小，分類力未驗證）；AudioSet 標籤 CC BY 4.0（要標示來源）。**PANNs／AST／Essentia 沒有查到可靠的瀏覽器版本資料（未驗證）**，先用 YAMNet。
- **結論（照使用者同意的順序做）**：先做不依賴大模型的部分——鼓軌規則拆解、單音音高追蹤（貝斯、人聲）、速度與量化、分軌組裝成 MIDI、樂器指派的退路規則（頻譜特徵、音域）；模型端（Demucs、Basic Pitch、YAMNet）做成可插拔的介面與下載登錄（沿用 FaVlm 的登錄與工作執行緒、只出一張進度卡、續傳、核對檔案大小與檢查碼），模型檔使用者按需下載，不進核心。

## 階段 5 實測（2026-11-01，三個模型都真的下載並跑過）
- **Basic Pitch `nmp.onnx`**：230,444 位元組，SHA-256 2c3c1d14…a0ec；輸入 `[批次,43844,1]`（22050 Hz，約 2 秒），輸出依序 onset `[批次,172,88]`、note `[批次,172,88]`、contour `[批次,172,264]`（順序用「兩個持續音」實測：onset 在 0.3 秒起音處出峰、note 持續）。88 格從 MIDI 21 起，幀長 256 樣本；視窗重疊 7680 樣本、頭尾各丟 15 幀。瀏覽器 wasm（onnxruntime-web 1.22）4 秒音訊約 0.8–1 秒，三個合成音（60、64、67）全對、起音誤差 0.01 秒。
- **YAMNet `yamnet.onnx`**：16,093,355 位元組，SHA-256 d3835ffb…f908e；輸入 `waveform`（16 kHz 一維），輸出 scores `[幀數,521]`（每 0.48 秒一幀）、embeddings、spectrogram。5 秒音訊 wasm 約 0.17 秒。我們只在 36 個樂器候選類別裡比平均分數（分數 ≥ 0.08、領先第二名 ≥ 0.02 才採用，否則退回音域規則）。**合成正弦波被判成 Synthesizer/Piano，真實錄音的分類準確度未驗證。**
- **Demucs 6 軌 fp16 權重版**：136,428,532 位元組，SHA-256 7ce55792…6869；輸入 `mix` `[1,2,343980]`、輸出 `stems` `[1,6,2,343980]`，順序 drums、bass、other、vocals、guitar、piano（模型卡）。原生 onnxruntime CPU 7.8 秒音訊約 11 秒。**瀏覽器：圖形最佳化開（預設）時 wasm 與 WebGPU 都建不起工作階段（「Aborted()」），把最佳化關掉（`graphOptimizationLevel:'disabled'`）wasm 才能載入：載入約 29 秒、單段（7.8 秒）推論約 42 秒（單執行緒，窗格被隱藏時可能偏慢）；WebGPU 在這台機器關掉最佳化也失敗。** 所以拆軌只有 wasm，三分鐘的歌約要 20 分鐘；預設不拆，使用者要求「拆軌」才下載。分軌用合成的正弦波測試，真實音樂的分離品質未驗證。
- 下載：8 MB 分片存 IndexedDB，重新整理後從快取載入（實測 17 片全部 resumed），SHA-256 在瀏覽器核對通過。
- 測試頁：`scripts/music-tests/a2m-browser.html?m=basic-pitch|yamnet|demucs-6s&ep=wasm|webgpu[&opt=disabled]`（要用本機伺服器開）。


## 音色庫取代原版（2026-11-01）
使用者決定用瘦身版（22 kHz、SF3 品質 3、6.6 MB，scripts/sf-slim.js --max-rate=22050 --sf3 --hi-share-db=-35）取代 32 MB 原版當預設，並接受七項波形門檻中 10 個位置未過：頻譜距離 GM 72、5、12、15；重心位移 GM 61、116、7、88；包絡相關 GM 110、83；高頻損失 GM 42（9.4 dB）。分片放在 soundfont-assets 分支 commit 9ee509dd06ec0e9c0bcebaaea7c7645294a5edff（單片，md5 c6f01d650e1ba739f1a7c84bacf2d661），floating-assistant.js 的 FA_ASSET_URLS.gsSoundbankBase 指向它，失敗時退回原始 sf2 網址。重現與進一步改善見 DESIGN.TODO.music.md「音色庫驗證結果」。

## 作曲樹：AI 是作曲家（2026-11-02 起）
**問題**：現行流程 AI 只逐欄選範本與參數（compose_plan.js），音符全由 music_compose.js 的範本產生，AI 沒有真的寫音。使用者要的是像拆 UML 一樣由上而下切分、每層只問小而封閉的問題、程式驗證、最後組裝。

**層次（compose_tree.js，FaComposeTree）**，每個節點有 id、題目、答案格式、程式核對、嚴格版重問、範本退路、來源標記（ai／fixed 程式修正／template 範本預設／user 使用者）：
1. `spec` 曲子規格：沿用 FaComposePlan（風格、情緒、速度、調式、主奏、長度、用途）。
2. `form` 曲式：從曲式範本挑一個字母（段落清單與各段小節數比例，如 前奏－主歌－副歌－主歌－副歌－尾奏）；程式把小節數縮放到總長、核對順序合法（有主歌才有副歌、尾奏在最後）、每段給力度曲線。
3. `harmony.<段落>` 每個不同段落名一題：AI 回羅馬數字和弦串（如 `I V vi IV`），封閉詞彙（大調 I ii iii IV V vi vii°、屬七 V7、小調 i ii° III iv v VI VII…）；程式核對：每個記號合法、數量 2～8、第一個和弦是主和弦或其替代、結尾段落以 I／V 等終止式收；不合格先嚴格版重問，再退回風格範本的和弦進行。
4. `voices.<段落>` 聲部分工：伴奏織體（柱式、分解和弦、切分、持續音）、貝斯型（根音四分、八分、行走、搖擺、持續）、鼓型（從該風格鼓型清單挑字母，另有「無鼓」）；都是字母選擇題。
5. `motif` 主題動機：AI 給 2～4 小節的動機，固定格式 `音級:時值`，如 `1:q 3:q 5:e 4:e 3:h`（音級 1～7，後綴 `+` 高八度、`-` 低八度；時值 w h q e s）；程式核對音級在調內、音域、時值加總剛好等於動機小節數的拍數；不合格嚴格版重問，再退回程式依風格節奏型產生的動機。
6. `assemble` 程式組裝（不問 AI）：由動機做發展（原樣重複、模進、反行、變奏、換段落和弦後把強拍音拉到最近的和弦音）展開成旋律；加和弦伴奏、貝斯、鼓、動態弧線（前奏小、副歌大、尾奏漸弱）；聲部連接與音域修正；整體檢查（總小節數與拍號、每小節都有音、旋律強拍與貝斯不碰半音衝突、音域）。不合格先換種子，最後退回保守版。同設定同種子產生同一首。

**一次一節點一題**、題目附範例、寬容解析（沿用 stripThink；和弦串與動機格式用寬容抽取：找第一個合法序列）。連線類錯誤連兩次就把剩下節點全部標為範本預設，不再等逾時；每個節點獨立退回，不整個放棄；沒有 AI（離線、額度用盡）整棵樹用範本並明講。

**結果**：樹狀卡片列出每個節點的值與來源；每個節點可「重做這段」（只重問該節點，其餘不動）或「改成…」（使用者直接給值，標 user）；「換一首」只換種子。使用者按「就用這個」時，通過程式驗證且來源是 AI 的節點（和聲、動機等）經 harness 經驗閘門回流離線訓練器。

**測試**：假模型七種（完美、亂答、英文思考文字、沉默、逾時、只回一半、答案違反音樂規則）逐層測；真模型小樣本實測需要金鑰，沒有就寫「未驗證」。
