# /edit-video(桌面版):影片播放 + 逐字稿編輯器

Redmine 外掛 `redmine_ai_chat` 的 `/edit-video`(設計見該外掛的 `DESIGN.edit-video.md`)移植到桌面版。畫面與純函式**是同一份程式**(`renderer/src/video/video_edit_{core,jobs,ai,ui}.js`、`video_source_picker.js`、`video_tts_dialog.js`、`video_intent.js`,掛在 `window.TwVideo*`),只有外框與主機能力換成桌面版自己的:

| 外掛 | 桌面版 |
|---|---|
| `AiChatWindow.attach` | `FaWin.decorate`(彈出/最大化/收回對話裡;`video_edit_ui.js` 優先用 FaWin) |
| `AiChatPersistentStorage` | `fileCache`(`FileCache.pin()` 新增:釘選的檔案不被容量淘汰;影片、配音、燒錄輸出都釘選) |
| `TwEditStore` | `FaEditStore`(`project/edit-video/ID`,存成 `{v:1, spec:專案, state:null}`) |
| Whisper worker | 既有 `_decodeAudioForWhisper`/`_getWhisperTranscriber`/`_runWhisperWindowed`(WebGPU 失敗退 CPU) |
| 燒錄 worker | 既有 `FA_BURN_SUBTITLES_WORKER_SRC`,新增 `dubBed`/`dubRate`(配音軌逐樣本相加到原音)與 `_burnSubtitles(…, opt)` |
| TTS | `_deckSynthesize`(簡報旁白同一條);`_videoVoices()` 把 TTS_VOICES/TTS_ZH_VOICES/TTS_API_VOICES 轉成對話框格式 |
| AI | `_edAi()`;程式先讀白話,讀不懂才問模型 |

主機轉接層 `renderer/src/video/video_host.js`;以 `H.register('edit-video', …)` 登記,對話裡是 ```` ```fa-edit-video {"id":…} ```` 區塊,重新整理後由 `_mountEditEditors` 重建。入口 `/edit-video [檔名|檔案 id]`(沒給就帶入對話剛附的影片)。embed 區塊 `VIDEOEDIT-BEGIN/END`(`scripts/embed-code-ui.js`)。

## 驗證
`FA_DEBUG_EVAL_FILE=scripts/eval/video_edit.eval.js xvfb-run -a node_modules/electron/dist/electron . --no-sandbox --user-data-dir=$(mktemp -d)`(真 Electron;Whisper/TTS/燒錄 worker 用假的):開啟、掛載、載入影片、佇列產生逐字稿、Ask AI 套用、TTS 配音、燒錄帶配音軌、釘選、彈出/最大化、重新整理還原,全過。

## 未驗證／未做
真實 Whisper、真實 Kokoro/線上 TTS、真實燒錄 worker 混音(外掛有 `burn_mix_real_mediabunny.manual.js`,桌面版 worker 用同一段 `mixSample`)、麥克風權限。「編輯影片」一句話的意圖路由、`edit_video_open` 工具沒做(只有斜線指令與 GUI)。
