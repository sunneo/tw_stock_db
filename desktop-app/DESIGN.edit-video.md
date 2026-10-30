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

## 時間軸:分割／合併／刪除一段／轉場／疊圖片／插入聲音(`video_timeline.js`,`TwVideoTimeline`)
- **非破壞**:專案多了 `clips: [{id, fileId, name, in, out, tr:{type,dur}}]`(來源檔的一段範圍,不存位元組)與 `overlays: [{id, fileId, start, dur, x, y, w}]`。逐字稿、配音、疊圖片都在**時間軸時間**上。舊專案(只有 `video`)載入時變成一個涵蓋整支的片段。
- **播放**:一個 `<video>` 播目前片段的來源;`box._ve.video` 是時間軸時鐘(currentTime/duration/paused/ended/play/pause/事件),編輯器其他部分(逐字稿高亮、配音同步、字幕層)不用改。換片段時換來源或 seek;同來源接續的片段不 seek。原生控制列關掉,改成自己的 ▶ + 進度條 + 時間。
- **✂ 分割**:在播放位置切成兩段。**🗑 刪除這段**:填起/迄(或按 [ ] 取播放位置)把整段拿掉,後面往前接;落在那段裡的逐字稿/圖片被刪、跨邊界的被截短、配音(錄音不截)只往前移;物件列每個片段的 ✕ 也是同一個動作。**➕ 加入影片**:可多選,依序接在最後(合併)。**↶ 復原剪輯**:時間軸+逐字稿+配音+圖片一起復原(最多 30 步)。
- **🖼 插入圖片**:在播放位置疊一張圖(預設 3 秒,位置/大小/起訖在物件列改)。**🎵 插入聲音**:變成一個 `kind:'file'` 的配音,所以移動、刪除、邊播邊聽、燒錄混音都是配音原有的。
- **轉場**(物件列每個片段〔第 2 個起〕的下拉＋秒數,0.2~3 秒):淡入淡出(經黑/白)、交叉淡化、四向滑入、四向推出、四向掃描線、中心向左右/上下展開、圓圈展開/收合、百葉窗、放大淡入。**不縮短時間軸**:轉場畫在切點前後各 d/2,用「對方的凍結畫面」混合,所以逐字稿/配音不會因設定轉場而位移;聲音在切點前後淡出/淡入。**編輯器裡的預覽只有淡黑/白近似**,真正的樣子在輸出的 MP4。
- **輸出**:🔥 燒錄在有剪輯(多片段、被截、有疊圖)時走 `_videoRenderTimeline`:mediabunny `CanvasSink` 逐片段解碼 → 轉場/疊圖/字幕合成 → `_encodeCanvasFramesToMp4`(30 fps,尺寸=第一個片段),音軌是整條時間軸混好的 48 kHz(各片段原音+配音);沒剪輯時仍走原本的燒錄 worker。AAC 編不起來的環境(例如這個 headless Electron)會退回無聲輸出並說明。
- **辨識**:逐字稿辨識依片段切開,每段在自己的來源檔辨識再換成時間軸時間。
- 驗證:`node scripts/video-tests/video_timeline.test.js`(純函式)、`scripts/eval/video_timeline.eval.js`(真 Electron+真 mediabunny:分割、刪除、合併、轉場、疊圖、插聲音、播放跨片段、輸出 MP4 的長度與畫面;AAC 音軌在該環境編不起來,所以音軌混合只驗到「退回無聲」)。
- 未做:轉場在編輯器內的真實預覽、片段排序(拖曳)、片段內縮放/速度、圖片動畫。
