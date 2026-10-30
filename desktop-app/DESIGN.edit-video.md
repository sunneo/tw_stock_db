# /edit-video(桌面版):影片播放 + 逐字稿編輯器

桌面版的影片逐字稿編輯器。畫面與純函式在 `renderer/src/video/video_edit_{core,jobs,ai,ui}.js`、`video_source_picker.js`、`video_tts_dialog.js`、`video_intent.js`(掛在 `window.TwVideo*`),外框與主機能力用桌面版自己的:

| 能力 | 桌面版 |
|---|---|
| 視窗外框 | `FaWin.decorate`(彈出/最大化/收回對話裡;`video_edit_ui.js` 優先用 FaWin) |
| 檔案儲存 | `fileCache`(`FileCache.pin()` 新增:釘選的檔案不被容量淘汰;影片、配音、燒錄輸出都釘選) |
| 專案儲存 | `FaEditStore`(`project/edit-video/ID`,存成 `{v:1, spec:專案, state:null}`) |
| 語音辨識 | 既有 `_decodeAudioForWhisper`/`_getWhisperTranscriber`/`_runWhisperWindowed`(WebGPU 失敗退 CPU) |
| 燒錄 | 既有 `FA_BURN_SUBTITLES_WORKER_SRC`,新增 `dubBed`/`dubRate`(配音軌逐樣本相加到原音)與 `_burnSubtitles(…, opt)` |
| 語音合成 | `_deckSynthesize`(簡報旁白同一條);`_videoVoices()` 把 TTS_VOICES/TTS_ZH_VOICES/TTS_API_VOICES 轉成對話框格式 |
| AI | `_edAi()`;程式先讀白話,讀不懂才問模型 |

主機轉接層 `renderer/src/video/video_host.js`;以 `H.register('edit-video', …)` 登記,對話裡是 ```` ```fa-edit-video {"id":…} ```` 區塊,重新整理後由 `_mountEditEditors` 重建。入口 `/edit-video [檔名|檔案 id]`(沒給就帶入對話剛附的影片)。embed 區塊 `VIDEOEDIT-BEGIN/END`(`scripts/embed-code-ui.js`)。

## 驗證
`FA_DEBUG_EVAL_FILE=scripts/eval/video_edit.eval.js xvfb-run -a node_modules/electron/dist/electron . --no-sandbox --user-data-dir=$(mktemp -d)`(真 Electron;Whisper/TTS/燒錄 worker 用假的):開啟、掛載、載入影片、佇列產生逐字稿、Ask AI 套用、TTS 配音、燒錄帶配音軌、釘選、彈出/最大化、重新整理還原,全過。

## 未驗證／未做
真實 Whisper、真實 Kokoro/線上 TTS、真實燒錄 worker 混音(燒錄 worker 的混音 `_mixSample` 只用假 worker 驗過參數)、麥克風權限。「編輯影片」一句話的意圖路由、`edit_video_open` 工具沒做(只有斜線指令與 GUI)。
