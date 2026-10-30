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

## Ask AI 的時間軸動作
封閉動作新增:`transcribe`{start,end|secs,every,lang}(**只產生請求**,套用時每一段在「工作佇列」排一個辨識工作,不是當場跑;`every` 把範圍切成每 N 秒一個工作,最多 40 個)、`split`{at}、`remove_range`{start,end}、`remove_clip`{n}、`set_transition`{n|'all',type,dur}、`add_video`/`add_picture`{at}/`add_sound`{at}(開檔案選擇,由使用者選檔)、以及原有的 `add_tts_dub`(可給 text+start+lang,不一定要引用某一句)。
- `applyEdits(…, tlctx={clips, TL, now})` 逐項用 `TwVideoTimeline` 驗證:時間軸動作依序在「前面的動作做完之後的片段」上檢查(邊緣、範圍、轉場名稱、片段編號),壞的退回並說明。時間軸動作在逐字稿動作**之後**執行。
- 套用時時間軸部分是**一個「復原剪輯」步驟**(連同逐字稿一起還原)。
- 程式先讀的白話:「每 10 秒辨識」「從 0:30 到 1:00 產生逐字稿」「在 0:30 分割」「刪除 0:10 到 0:20」「刪掉第 2 個片段」「所有片段之間加圓圈展開轉場 1.5 秒」「在 0:05 用英文配音 說 hello」「加入影片／插入圖片／插入聲音」;讀不懂且線上才問模型(提示裡附片段清單)。

## AI 的順序與離線 harness
Ask AI 讀一句話的順序:**程式先讀**(`localParseMulti`,多子句要每句都讀懂,否則整句往下交)→ **線上模型**(`_kiLlm` 的 `noOffline`:只走線上,逾時/出錯/回覆讀不懂都算失效)→ **線上失效才接離線 harness**(`host.ai.offline` = `_videoOffline`);App 的「離線模式」開著時順序相反(harness 先,找不到才問線上)。離線小模型**不再自己寫 JSON**,只在 harness 裡答字母選擇題。`_videoOffline` 逐層做,前一層做出動作就停:
1. **離線訓練器**:`_otPlan` 找領域 `edit_video`(及其他領域)裡學過的做法;只收 `video_*` 工具的結果,轉回封閉動作。**學回去**:線上做成功、使用者按「套用」的句子,`_videoLearn` 用 `TwVideoPlans.generalize` 把句子裡的數字換成擷取群組、引號裡的字換成 `{quoted}`,存成 `edit_video` 的 regex 規則(`steps` = `video_*` 呼叫);數字不在句子裡的(例如計畫展開出來的)不學。
2. **計畫模板**(`video_plans.js`,`TwVideoPlans.GOALS`):剪掉片頭/片尾 N 秒、只保留 A 到 B、每 N 秒切一刀、全部逐字稿用某語言配音、整支分段辨識。目標由觸發字分類,步驟由程式展開,數字來自句子或編輯器的狀態(影片長度、逐字稿列),模型不參與。
3. **意圖引擎**(`FaEditOffline.videoAdapter`,`edit_offline.js`):句子切子句,每個子句對到一個意圖(辨識、分割、刪除一段、刪除片段、轉場、TTS 配音、加入素材、改字、平移、刪空白列);缺轉場種類之類才問模型一個字母。
3. **細切 + 語意推導 + UML + CoLU 接線**(通用 harness 的 `video` 領域,`video_semantics.js`;核心與擴充點見 `DESIGN.offline-harness.md`):一句話切成意圖,「前半段、最後 10 秒、第 3 句那一段、沒有字幕的地方、只保留 A 到 B、正中間」用編輯器的狀態推導成數字(每個推導都顯示在預覽的說明裡),寫成 UML 使用案例,交給 CoLU 單元目錄接線成 `video_*` 工具呼叫(UML 操作名稱 + 單元的白話說明 + 型別合約;沒接上的步驟退回該動作自己的工具,並提醒)。缺什麼(哪一種轉場、刪哪一段)變成「缺」的提示,不猜。
4. **意圖引擎**(`FaEditOffline.videoAdapter`)是退路:語意推導讀不出來時,子句對意圖,缺轉場種類之類才問離線模型一個字母。
最後對所有層的結果再做一次 CoLU 接線檢查(`_videoCoLU`,只提醒不擋;最後一道檢查仍是 `applyEdits`)。`video_*` 工具在單元目錄裡是 tier-1 有型別單元(`catalog_core.js` 的 EFFECT_RULES 補了 `video_*`,回傳型別由說明裡的「回傳 {…}」推出)。

**agent 工具**:封閉動作原封不動變成工具 `video_split / video_cut_range / video_cut_clip / video_set_transition / video_transcribe / video_tts_dub / video_set_line / video_shift_lines / video_add_media` 與 `edit_video_open`(`TwVideoPlans.TOOLS` 是動作⇄工具的對照表,`runOps` 檢查後立刻執行),所以對話裡的 agent、離線訓練器、CoLU 單元目錄都用同一套詞彙驅動「開著的」編輯器;已加進 `editors` 領域與 `FA_TASK_TOOL_HINTS`。
**沒做**:`FaPlan` 的 GOALS/CAPS(那套是以檔案種類倒推工具鏈,編輯器的動作不產生檔案,所以改用上面的計畫模板);離線小模型答字母題的準確度沒用真模型量過。
驗證:`scripts/video-tests/video_plans.test.js`、`scripts/edit-tests/edit_offline_video.test.js`、`scripts/eval/video_harness.eval.js`(真 Electron:工具、單元 tier 1 與型別、CoLU 2/2 接線、學回去與換數字重放、計畫模板、意圖引擎、線上失效→離線→預覽→套用、線上成功→學回去)。
