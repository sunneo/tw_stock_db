# 本地音樂資料庫（music library）構想（2026-11-22，使用者提出，TODO）

狀態：只是構想，已排入調查；尚未實作。調查結果見文末「現有零件調查」。

## 使用者原話（逐字，2026-11-22）

我想到一個本地音樂資料庫的點子:
介面大概要像是library
可以add file, add folder
可以掃遊戲檔案如nes rom, pce rom , sfc rom, 或早期的RIX格式音樂, macromedia flash的檔案,  mid, wav, mp3, mp4, mov, webm 等格式

可以加youtube list(if possible)

掃描完成的建立 路徑/檔名/專輯
資料metadata

我希望達到的效果:

1. 可以用文字找出音樂，如檔名
2. 可以用文字找出歌詞內的音樂 (transcribe)
3. 可以透過麥克風或音樂檔案片段，找出類似那端聲音的音樂  (不用非常精準)，例如透過把使用者的哼歌轉旋律/midi，從音調的上下變化跟節奏去多方match。要支援打擊聲音，使用者哼歌的時候如果有文字，也可以作為一個增加廣度的搜尋條件
4. soundhound/shazam的特徵演算法也許可以，但我更希望音調可以
5. 過濾器當真找不到，也可以詢問要不要幫使用者演奏midi

介面可以將清單多選，批次輸出mid(透過我們設計好的像是將audio to midi), mp3(wav to mp3, midi to mp3, game rom-> (wav/midi) -> mp3, mp4->extract -> mp3,

預設輸出一分鐘, 使用者可以指定輸出幾分鐘

## 需求整理（白話，不取代原話）

- 介面像資料庫（library）：加檔案、加資料夾；可加 YouTube 清單（做得到才做）。
- 掃描來源：nes／pce／sfc 遊戲 ROM、早期 RIX 音樂、Macromedia Flash、mid、wav、mp3、mp4、mov、webm。
- 掃完建立：路徑／檔名／專輯，與其他中繼資料。
- 找法：(1) 文字找檔名；(2) 文字找歌詞（轉錄 transcribe）；(3) 麥克風或音樂片段找相似音樂，哼歌轉旋律／MIDI，用音高上下變化與節奏多方比對，不需非常精準，支援打擊聲，哼歌帶字時文字也當搜尋條件；(4) 比起 Shazam 式指紋，更偏好用音高；(5) 都找不到時詢問要不要幫使用者演奏 MIDI。
- 批次輸出：清單多選，輸出 mid（音訊轉 MIDI）、mp3（wav→mp3、midi→mp3、遊戲 ROM→wav／midi→mp3、mp4 抽音訊→mp3）；預設輸出一分鐘，使用者可指定分鐘數。

## 現有零件調查

2026-11-22 唯讀調查（子代理報告，只看檔名、開頭註解與關鍵字命中，**未逐項核實、未跑測試**；標「需確認」的要打開程式確認）。

### 已有且可直接用

- 音訊轉樂譜規則：`renderer/src/music/audio_to_midi.js`（鼓點偵測、單音音高追蹤、音高幀轉音符、速度、量化）；流程骨架 `audio_pipeline.js`（分段、分軌、轉譜可插拔、可中斷續跑）。
- MIDI：`midi_core.js`（讀寫 Format 1）、`midi_play.js`、`midi_ui.js`（播放、下載、「轉 mp3」鈕）、`midi_editor_ui.js`；Python 版 `examples/python/gui/midi_tool.py`。
- 語音轉文字：`transcribe_media` 工具（Whisper base），加速在 `gpu/whisper_enc.js`、`whisper_gpu.js`、`whisper_attach.js`，輸出 srt；解碼退路 `media/transcode_fallback_core.js`。
- 麥克風錄音：`tts/voice_recording.js`（純函式核心）；實際 getUserMedia 在 `floating-assistant.js`。
- 本地資料庫與全文索引：`knowledge/knowledge_core.js`、`knowledge_store.js`（單一 SQLite 含全文索引與向量）、`knowledge_host.js`、`knowledge_ui.js`。
- 播放：`gui/audio_host.js`、`pybridge/fa_audio.py`。

### 有但要改

- 模型執行層 `music/audio_runtime.js`、`audio_models.js`、`native_ort.js`（Basic Pitch、YAMNet、Demucs）：速度與品質文件寫「未驗證」；要接到批次與音訊檔流程，並補哼歌比對。
- mp3 輸出：有 lamejs 載入設定與 `midi_to_mp3` 工具名，編碼函式本體**需確認**。
- 影片抽音訊：`extract_audio` 工具，實作與輸出格式**需確認**。
- YouTube：`youtube_download` 工具存在，清單支援**需確認**。
- 加資料夾可對應 `terminal/fapfs_core.js`（/mnt/<標籤>）；`filesource/file_source_core.js` 只認對話中檔案，不是資料庫。

### 完全沒有

- NES／PCE／SFC ROM 音樂擷取或模擬（無 NSF、SPC、HuCard 解析）、RIX 解析、Flash（SWF）音樂擷取。
- 哼歌或片段的相似音樂搜尋（音高輪廓＋節奏比對、索引）；只有單音音高追蹤可當前半段。
- 音樂庫介面（加檔案／資料夾、路徑／檔名／專輯中繼資料、多選批次輸出、預設一分鐘）。
- 音樂專用的歌詞轉錄索引（只有通用轉錄與知識庫）。

### 相關文件

`DESIGN.music.md`（音樂領域階段 0 到 5）；`DESIGN.knowledge-inventory.md` 寫「尚未實作」但 `renderer/src/knowledge/` 已有程式，狀態不一致**需確認**；沒有 `HANDOFF.*music*`。

### 下一步（待使用者排序）

最小可行順序建議：庫的資料表與掃描（mid／wav／mp3／mp4 等現成格式）→ 檔名與歌詞文字搜尋（接知識庫與轉錄）→ 批次輸出（先 mid／mp3）→ 哼歌比對（音高輪廓＋節奏）→ 各平台 ROM／RIX／Flash 擷取（最重，各需新解析器）。

## 第一階段現況（庫與掃描，2026-11-22）

狀態：已實作純邏輯核心與最小畫面，單元測試全過；**尚未接進 `floating-assistant.js`，也未在瀏覽器或桌面版實際執行過畫面**。

### 做了什麼

- `renderer/src/musiclib/musiclib_core.js`（UMD，不碰 DOM、不碰檔案系統）
  - 種類辨識：先看檔頭（MThd、RIFF/WAVE、ID3 或 MPEG 音框、ftyp／qt、EBML、NES 標頭、FWS／CWS／ZWS），認不出來才看副檔名；兩者不同以檔頭為準（結果的 `via` 欄位註明來源）。
  - 種類：mid（含 midi）、wav、mp3、mp4、mov、webm 為音訊或影片；nes、pce、sfc、rix、swf 只登記成「遊戲音樂來源，待擷取」（`pending: true`），不做擷取。
  - 專輯：有專輯標籤用標籤（`albumSource: 'tag'`），沒有就用上一層資料夾名（`'folder'`）。
  - 中繼資料（能解析多少算多少，失敗只記在 `meta.notes`，不丟例外）：mp3 的 ID3v2（標題、演出者、專輯、TLEN）、ID3v1 尾端標籤、Xing／Info 精確長度或位元率估計長度（標 `≈`）；wav 的 fmt 與 data 區塊長度、LIST/INFO 標題與專輯；mid 的軌數、第一軌名稱、依速度變化算的長度；mp4／mov 的 moov／mvhd 長度。
  - 增量掃描 `scanSource`：路徑＋大小＋修改時間都不變就沿用、不重讀檔頭；新增、變更重新解析；這次沒看到的標成 `missing`（不刪，再出現時重新解析）；辨識不出來的檔案記住大小與修改時間，下次不重讀。
  - 搜尋 `searchRecords`：空白分隔多關鍵字（全部都要命中）；欄位權重：檔名與標題 3、專輯與演出者 2、路徑 1；檔名完全相同 +5、開頭相同 +2；同分依路徑排序；文字先做 NFKC 與小寫（全形英數會折成半形）。中文、日文、英文都用子字串比對。
  - 儲存：`createLibrary(backend)`，backend 只要求 `load()`／`save(data)`；提供 `createMemoryBackend`（記憶體）與 `createJsonBackend({ read, write })`（任何地方存 JSON 字串，例如 IndexedDB 或磁碟）。沒有筆數上限。
- `renderer/src/musiclib/musiclib_ui.js`（UMD）：`FaMusicLibUI.mount(容器, { library, host })`，工具列（加檔案、加資料夾、搜尋框、統計），清單欄位為路徑、檔名、專輯、種類、長度，每列有勾選框（多選，只預留，不輸出）。
- `renderer/src/musiclib/musiclib_core.test.js`：用手組位元組測試，共 19 項。

### 為什麼沒借用 knowledge_store

`knowledge_store.js` 的表（sources、sections、chunks、FTS5、vectors、links、summaries、digests）是為文字片段與全文索引設計的，音樂的欄位與增量判斷（路徑＋大小＋修改時間）對應不上，所以另寫一個小儲存層（backend 介面）。`knowledge_core.js` 的斷詞也沒借用：音樂搜尋用的是欄位子字串比對，較簡單，且與文字片段無關。

### 接線點（尚未接）

- 桌面版的 host：`pickFiles()`／`pickFolder()` 回傳 `{ label, entries:[{path,size,mtimeMs}], readHead(path, n) }`，路徑用磁碟真路徑（用 Electron 的檔案對話框與 fs.stat）。取消回傳 null。
- 持久化：`createLibrary(createJsonBackend({ read, write }))`，`read`／`write` 由 app 提供（例如 IndexedDB 或 FAP 磁碟）。
- 畫面：`FaMusicLibUI.mount(容器, { library, host })`，容器由 floating-assistant 的面板提供；入口與按鈕位置尚未決定。
- 若要嵌入 `floating-assistant.js`：在 `scripts/embed-code-ui.js` 登記（參照 knowledge 那幾行的做法）；本階段沒有做，也沒有重產任何建置產物。

### 沒做與已知限制

- **未驗證的部分**：畫面（`musiclib_ui.js`）沒有在瀏覽器或桌面版跑過，只有語法層級的載入；核心只跑 node 單元測試（19/19 通過），沒有用真的 mp3、wav、mid、mp4 檔案，全部是手組位元組。
- 瀏覽器的 File 拿不到完整路徑：只能用檔名與資料夾的相對路徑；路徑與專輯推導要用桌面版的 host 才準。
- 讀檔頭上限為每檔 2 MB（`HEAD_BYTES`）：mp4／mov 的 moov 若在檔尾，讀不到，長度留空；webm 長度未解析（留空）。
- mp3 沒有 Xing 標頭時長度為位元率估計（CBR 準，VBR 有誤差，標 `≈`）；mid 的 SMPTE 時間碼不算長度。
- 搜尋不做簡繁轉換、不做假名互通、不做詞幹化。
- 遊戲音樂來源（nes、pce、sfc、rix、swf）只辨識，不擷取；哼歌比對、歌詞轉錄、批次輸出、YouTube 都未做。

## 第二階段：接進桌面版（2026-11-22）

狀態：已接進主程式，真桌面版（Electron，獨立 user-data-dir）評測兩次通過；網頁版未測。

### 接線點

- 指令：`/musiclib`（`floating-assistant.js` 的 `_registerMusicLibCommand`，在建構子裡與 `/knowledge` 並排註冊）。對話裡出現一則訊息，裡面掛音樂庫畫面（`fa-musiclib` 區塊，由 `_mlMount` 掛載；與知識庫面板同一種做法）。
- 畫面：`renderer/src/musiclib/musiclib_ui.js`（`FaMusicLibUI.mount(容器, { library, host })`）。
- app 轉接層：`renderer/src/musiclib/musiclib_host.js`（嵌入為 `const FaMusicLibHost`，定義 `_mlLib`、`_mlMount`、`_mlOpen`、`_registerMusicLibCommand`）。
  - 加資料夾：`desktopAPI.roots.browse()`（桌面版既有的資料夾瀏覽器）→ `desktopAPI.rawfs.readdir` 遞迴走訪（堆疊，不遞迴呼叫；每 200 筆 `setTimeout 0` 讓出執行緒；沒有深度與筆數上限）。
  - 讀檔頭：新增 IPC `fa:rawfs:readHead`（`main-ext.js`；`preload.js` 的 `rawfs.readHead`），只讀前 N 位元組（呼叫端上限 2 MB，IPC 端硬上限 8 MB），不整檔讀進來。
  - 儲存：IndexedDB 資料庫 `fa-musiclib`，鍵 `library`，內容是 `createJsonBackend` 的 JSON 字串。沒有 IndexedDB 時退回記憶體，畫面會顯示提醒。
  - 加檔案：沿用畫面的瀏覽器 `<input type=file>`（拿不到完整路徑）。
- 嵌入：`scripts/embed-code-ui.js` 登記 `musiclib_core.js`（MLCORE）、`musiclib_ui.js`（MLUI），另有 `embedMusicLibHost()`（MLHOST）。`floating-assistant.js` 的標記區塊 `MLCORE`／`MLUI`／`MLHOST` 由嵌入腳本填入。
- 提交的 `floating-assistant.js` 只含手改的接線（標記與四行），內嵌產生區塊留給管理者重產（同一檔案的工作目錄版本已含產生內容）。

### 真機評測（2026-11-22）

- 評估檔：`scripts/eval/musiclib.eval.js`（`FA_DEBUG_EVAL_FILE`）。測試資料：`scratchpad/musictest` 的兩個資料夾，含中文、日文檔名，子資料夾，一個 txt（應略過）。
- 指令（PowerShell，Windows；HANDOFF 第 4 節的 systemd-run／xvfb 是 Linux 寫法，這裡沒用）：`FA_DEBUG_EVAL_FILE`、`FA_DISABLE_MAIN_OVERLAY=1`、`FA_BROWSER_CONTROL_PORT=18931`（不是 17923），`--user-data-dir` 指向獨立空目錄。
- 第一次（空庫）：加入 2 個資料夾，掃到 6 個音訊／MIDI（txt 略過）；搜尋「晴天」「autumn」「葉惠美」「夜曲」「さくら」「周杰倫 晴天」命中正確，「周杰倫 autumn」無結果（正確）；面板 `.fml` 出現 1 個，清單 6 列，搜尋框輸入「晴天」後剩 1 列。
- 第二次（同一 user-data-dir，重開 app）：啟動時庫已有 6 筆、2 個來源（**重開後資料還在**）；重掃兩個資料夾全部 `unchanged`，沒有重讀檔頭。
- 每項評測都跑 1 次，兩次都通過，沒有重跑。
- 兩次的程序都自己結束（`WaitForExit` 回 True）。

### 沒驗證、沒做到的

- **資料夾瀏覽器按鈕沒有實際點過**：`roots.browse` 在 contextBridge 物件上無法被評估檔改寫（`patched: false`），所以評測改用同一條路徑的其餘部分（`walkFolder`＋`readHead` 的 IPC）。真正的選取對話框要人工點一次確認。
- 畫面的加檔案、勾選、多選行為只做了開面板、清單列數與搜尋框輸入，沒有逐一點按驗證。
- 評測輸出的中文在主控台被亂碼化（Windows 代碼頁），資料本身以 IndexedDB 與索引比對結果為準；沒有用截圖確認畫面文字。
- 網頁版（無 desktopAPI）沒有測；資料夾按鈕在網頁版會提示只能用桌面版。
- 只有 Windows；HANDOFF 的 Linux 評測做法沒有套用。
- 沒有 GPU，本階段不需要。
- 沒有發布、沒有推送；建置產物（`renderer/floating-assistant.js`、`.min.js`、`web-lazy/`、`update-manifest.json`）未提交。
