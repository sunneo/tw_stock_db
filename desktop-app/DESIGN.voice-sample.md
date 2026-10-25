# 聲音樣本（我的聲音）

使用者要求（2026-10-25）：TTS 要能用自己產生的聲音樣本；語音設定頁有「匯入聲音樣本」「建立聲音樣本」，各有斜線指令；中文、英文都支援；建立後能匯出給別人用（例如 ChatTTS）；匯入後下拉選單、`/media-list-voices` 都找得到、有自己的語音代號。

## 兩種聲音樣本（主要是第一種）

### 1. 錄音樣本（主要，符合原始需求）
「聲音樣本」＝自己的聲音錄音：24kHz 單聲道 16-bit WAV ＋ 念的文字稿 ＋ 名字與語言。ChatTTS（`sample_audio_speaker`）、XTTS、F5-TTS 這類吃**參考音檔**的引擎都是拿這種樣本取得說話人，所以匯出的就是這個 WAV 與一份 `.voice-sample.json`（念的文字、語言、各引擎的用法）。
- 建立：麥克風錄音（`/voice-create` 不帶參數、`/voice-record`、設定頁「建立聲音樣本」）。念稿中英文各三句；錄音關掉回音消除／降噪／自動增益（這些會改變聲音特徵），用 ScriptProcessor 收原始樣本，不經過有損壓縮；停止後修剪頭尾靜音、重採樣 24kHz、正規化，並做品質檢查（長度、爆音、講話音量、靜音比例、底噪／訊噪比），不合格會說明原因、建議重錄（仍可強制儲存）。
- 匯入：`/voice-import`／設定頁「匯入聲音樣本」，接受 wav、mp3、m4a、ogg、webm、mp4、flac（WAV 自己解，其他交給 decodeAudioData），同樣的處理與品質檢查。
- 存放：自己的 IndexedDB `FloatingAssistantVoiceSamples`（不放檔案快取：檔案快取超過容量會自動刪最久沒用的，聲音樣本要長期保存）。
- 匯出：`/voice-export <代號>`／清單的「匯出」，下載 `<名字>.wav` 與 `<名字>.voice-sample.json`。
- 代號：`vs_` 開頭（`/media-list-voices` 的「我的錄音樣本」、設定頁下拉選單的「我的錄音樣本」群組可見）。
- **用錄音樣本念字**：本機內建的 Kokoro 不能用參考音檔，所以目前選了錄音樣本合成會回明確說明（請匯出、在支援參考音檔的引擎用），下拉選單裡這些項目是停用狀態。還沒做的是「交給支援參考音檔的引擎念」——需要先決定引擎（見 DESIGN.TODO.voice-sample-engine.md）。

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
