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
- 遊戲音樂來源（nes、pce、sfc、rix、swf）只辨識，不擷取；哼歌比對、歌詞轉錄、批次輸出、YouTube 清單（2026-11-22 已做，真網路未驗證）都在這份之外的進度裡。

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

## 進度表（距離目標多遠，每次完成一段就更新；2026-11-22 NES 擷取發布後）

「已驗證」只算接進桌面版並在真 Electron 跑過；單元測試通過但沒接線的不算完成。

| 項目 | 狀態 |
|---|---|
| 介面像 library、加資料夾 | 已發布並真機驗證（掃描、重開資料還在、重掃未變更）。**未驗：資料夾瀏覽器按鈕實際點擊、加檔案、多選逐一點按、網頁版** |
| 掃描 mid／wav／mp3／mp4／mov／webm | 已發布，真機掃描通過；mp4／mov／webm 轉 mp3 已驗 webm；mp4／mov 沒有單獨驗 |
| RIX、Flash（SWF）擷取 | 已發布（v535）。RIX 真桌面版 10/10（86 個真實檔解析、擷取 mid／wav／mp3）；**Flash 只有單元測試，沒有真實 SWF 驗證** |
| NES（FC）擷取 | 已接進桌面版，真桌面版 6/6：3 個真實 ROM（mapper 4、0、1）都擷取成 NSF＋MIDI＋wav＋mp3 子曲目，第二次全部沿用。**成功率未知**：先前 67 個抽樣結果是 18 個 NSF、4 個只出 MIDI、45 個失敗（當時不支援的 mapper），之後補了多個 mapper 但沒重跑；mapper 74、195 仍會崩潰、187 的修改未驗證；單一 ROM 約 10 至 30 秒 |
| PCE 擷取 | 已發布，真桌面版 6/6：3 個真實 ROM 中 2 個擷取成 MIDI＋wav＋mp3 子曲目（自寫 HuC6280 加六聲道 PSG），第 3 個（P2001）失敗並寫明原因（有 PSG 寫入但沒有按音，可能是 CD 遊戲或需要別的啟動條件）。**成功率未知（只試 3 個）、音色與時序沒有對真機** |
| SFC（超任）擷取 | 部分：掃描、標頭、.spc 組裝、DSP 轉 MIDI 退路已併入並有單元測試；**主 CPU 執行與 .spc 傾印沒做（SnesJs 不存在，jsmoo 的 DSP 是空殼）、snes_spc 渲染缺 wasm 工具鏈**；目前 SFC 擷取會明確失敗並說明階段 |
| 第二層：直接播放現成 NSF／SPC／HES | 未做（等 SFC 的 wasm 做法定案） |
| 晶片音樂播放器（重播、seek、goto、匯出） | 已併入並真桌面版驗證（12/13）：RIX 的 OPL2 真模擬（渲染不靜音、seek 與連續渲染完全一致、goto）、面板按鈕掛出控制卡片（播放、重播、前往、匯出 mp3、匯出 MIDI）、NSF 後端（3Eyes 渲染、seek 一致）。**未驗：實際聽感與音色、匯出檔案內容、卡片進度條拖曳；Bomberman 2 的 NSF 初始化不返回（擷取品質問題）、ARKANOID 的 NSF 幾乎無聲** |
| 加 YouTube 清單 | 已併入（單元 13＋整合 6 通過）：yt-dlp flat-playlist 展開，逐支沿用既有範圍驗證再下載。**未驗：真網路展開與下載、面板實際畫面（輸入區已出現在面板）** |
| 效果 1：文字找檔名 | 已驗證 |
| 效果 2：文字找歌詞 | 已發布；真 Whisper 只跑過 1 秒靜音。**未驗：真歌詞轉出文字並被搜尋命中** |
| 效果 3、4：哼歌找相似音樂 | 已發布（v534），真桌面版 10/10（升調、變速、錯音、顫音仍命中第一名；無關旋律不命中）。**未驗：麥克風錄音按鈕、Basic Pitch 模型路徑、真實哼唱（只用合成音）、試聽實際播出** |
| 效果 5：找不到時問要不要演奏 MIDI | 已發布，開 MIDI 編輯器不出錯已驗；實際聽到聲音未驗 |
| 批次輸出 mid／mp3 | 已發布並真機驗證 16/16（wav→mp3、mid→mp3、webm 抽音軌、音訊→mid）；ROM 來源現在走擷取子曲目；mp3→mp3 截取未單獨驗 |

整體：RIX／Flash／NES／PCE 擷取、晶片播放器（RIX、NSF）、哼歌找歌、批次輸出、檔名搜尋、加資料夾與掃描已接進桌面版並真機驗證（各項「未驗」見上）；SFC 只做了一半；YouTube 清單已做未真網路驗證；第二層直接播放 SPC／HES 與歌詞真轉錄驗證未開始。

## 歌詞轉錄與搜尋：現況（2026-11-22）

狀態：佇列、狀態機、歌詞搜尋與面板已做；單元測試與假轉錄真桌面版評測通過；**真 Whisper 轉錄沒有跑完**（見下）。

### 做了什麼

- `musiclib_core.js`：每筆曲目多 `lyrics`（段落 `[{start,end,text}]`、語言、長度、轉錄時間）、`lyricStatus`（none 未轉錄、queued 排隊、running 轉錄中、done 完成、failed 失敗）、`lyricError`（失敗的具體原因）。檔案變更時曲目重建，歌詞跟著清掉。
- `createLyricQueue(lib, transcriber, opts)`：逐首轉錄；每首完成就存檔；暫停時轉錄函式丟出 `err.paused` 的那首退回排隊、續跑從頭做；已完成的不重做；失敗的下次會重試；遊戲來源（pending）不排進佇列；重開時上次「轉錄中」退回未轉錄。
- 歌詞搜尋：`searchRecords(…, {scope})`，scope 為 all／meta（不含歌詞）／lyrics（只查歌詞）。歌詞命中權重 1.2（每個關鍵字），檔名與標題 3，所以檔名命中仍排前面。回傳 `lyricHits`（命中的段落與時間點，最多 8 段）。中日英都用子字串比對。多個關鍵字可以分散在不同段落，但不能跨段落連在一起。
- `musiclib_host.js`：預設轉錄 `whisperTranscribe`，接 app 既有的 Whisper 流程（`_decodeAudioForWhisperWithFallback`、`_getWhisperTranscriber`、`_runWhisperWindowed`），裝置順序同 `transcribe_media`（WebGPU 失敗退回 CPU）。讀整檔進來解碼，每 600 秒分一段跑，段與段之間檢查暫停。`FaMusicLibHost.setTranscriber(fn)` 可換成別的轉錄函式。
- `musiclib_ui.js`：「轉錄歌詞」（勾選的未完成曲目；沒勾選就全部未完成）、「暫停／續跑」、進度列（完成、排隊、未轉錄、失敗、轉錄中與百分比、已暫停）、歌詞欄（失敗會顯示原因）、範圍下拉、搜尋時列出歌詞命中的段落與時間點。

### 修正既有的 bug（不是這個功能本身）

`scripts/embed-code-ui.js` 嵌入 `transcode_fallback_core.js` 的方式不對：核心檔是 `const … ; module.exports = …` 的寫法，不是 UMD，嵌入後 `FaTranscodeFallback` 是 undefined，所有 Whisper 解碼都會失敗（包括既有的 `transcribe_media` 工具）。已改為傳入 `{ exports: {} }` 的模組物件，重新嵌入並建置。

### 驗證

- 單元測試：`musiclib_core.test.js` 26/26 通過（含假轉錄的狀態機、暫停與續跑、失敗原因、續跑不重做、檔案變更才重做、重開後歌詞還在、中日英歌詞搜尋、命中時間點、檔名優先排序、範圍切換）。
- 真桌面版（獨立 user-data-dir、FA_BROWSER_CONTROL_PORT=18932）假轉錄評測：第一次掃描 6 首，按「轉錄歌詞」後暫停、續跑，結果 5 完成、1 失敗（`song.mid`，附模擬的具體原因）；搜尋「English lyric」（全部範圍 5 首、只查不含歌詞 0 首、只查歌詞 5 首）與時間點正確。第二次開啟（同一 profile）：5 完成、1 失敗與原因、歌詞仍在。
- 真 Whisper（`musiclib-ud-real`，複製了本機既有的 Service Worker 快取，約 1.8 GB，未改動使用者的預設 profile）：**沒有跑完**。第一次因上面的嵌入 bug 解碼即失敗；修正後重跑，「Autumn Leaves.wav」（1 秒靜音）停在轉錄中 0%，等了 400 秒沒有進展，也沒有錯誤回報。推測是模型載入（快取是否命中、或網路載入 transformers.js）卡住。**這一項沒有驗證成功**。

### 沒做、已知限制

- 轉錄沒有逾時機制：模型載入卡住時，佇列會一直停在「轉錄中」，要重開 app 才會解除（重開時會退回未轉錄）。下一步應加逾時與明確的錯誤原因。
- 長檔的分段是 600 秒一段，段與段之間沒有重疊，邊界的字可能被切斷。
- 整檔讀進記憶體解碼（經 IPC base64），非常大的影片會吃記憶體。
- 暫停只在段與段之間生效；暫停的那首從頭重做。
- 歌詞搜尋不做簡繁、假名互通；歌詞的時間點是 Whisper 給的段落時間，不是逐字時間。
- 評測的中文輸出在主控台亂碼，判定以狀態與計數為準。
- 沒有 GPU 的環境下真轉錄會很慢（這次評測的卡住也可能是這個原因），不能確定是慢還是壞掉。
- 沒有發布、沒有推送；建置產物（`renderer/floating-assistant.js`、`.min.js`、`web-lazy/`、`update-manifest.json`）未提交。

## 歌詞轉錄：保護機制與真機評測（第二輪，2026-11-22）

狀態：無進展偵測、自動重試、等待同意的階段、暫停即時生效都已做並有單元測試；假轉錄真桌面版評測通過；真 Whisper 評測通過一次（wav，1 秒）。**沒驗證的部分見最後一節。**

### 為什麼 0% 卡住（查證結果）

- 測試用的 1 秒靜音 wav 一開始是壞檔：生成器只寫了標頭、沒寫取樣資料，標頭宣稱 1 秒、檔案實際沒有音訊。既有的 `transcribe_media` 流程（同一個 profile、同一個檔案，對照只跑一次）在解碼就失敗（`Unable to decode audio data`，23 秒）。這是測試資料的錯，已修正（`make_music.js`）。
- 修正測試檔後，真 Whisper 評測（`musiclib_lyrics_real`）整條流程通過：原生解碼成功（不需要 ffmpeg）、WebGPU 推論、4 段、長度 1 秒，耗時 172 秒（大部分是模型載入）。
- 更早那次 0% 卡住：解碼退路會走到 `_ffmpegWasmConsent`，對話裡的「下載 ffmpeg.wasm」卡片等使用者按確認；背景佇列沒有人按，所以卡住。這是最可能的解釋，但我沒有從卡片本身證實「等待時間點」與它解開的方式，所以只寫成「最可能」。
- 快取：這個 profile 的 Cache Storage 裡沒有 Whisper 模型（`caches.keys()` 只有 `kokoro-voices`、`fa-moss-tts-v1`），模型是從網路下載的。

### 這一輪加入的保護（佇列）

- **無進展偵測**（`musiclib_core.js`）：每個階段（decode 解碼、load 載入模型、infer 推論）都要回報進展；超過「3 × 每單位預估耗時 × 本次回報單位」沒有回報就中止這次嘗試，錯誤附階段名、已耗時、最後進度。每單位耗時一開始用保守先驗值，之後用指數移動平均依實測更新。`STALL_FLOOR_MS`（20 秒）只是最短保底。
- **暫時性失敗自動重試**：無進展、逾時、網路、GPU 裝置遺失這類錯誤，全新再試（重新建立轉錄器），最多重試 3 次，間隔 2、6、14 秒。其餘失敗（例如格式解不了）不重試。重試用完仍失敗才標失敗，原因寫明嘗試次數。
- **等待使用者確認下載**：解碼退路需要 ffmpeg.wasm 時，宿主把「等待使用者確認下載 ffmpeg.wasm」做成明確階段，說明含來源與大小（取 app 原本的同意文字，估計約 30 MB）；這個階段不計無進展逾時；使用者拒絕、或超過 10 分鐘（`USER_WAIT_TIMEOUT_MS`），才標失敗並附原因。不替使用者按、不預先寫入已同意狀態。**這條路徑只有程式碼與假設，沒有真機驗證**（本輪真 Whisper 只跑 wav，沒有觸發下載）。
- **暫停立即生效**：暫停會中止正在卡住的那次嘗試，不必等無進展逾時。
- **面板顯示**：目前階段（中文名）、已耗時（每秒更新）、第幾次嘗試、重試倒數、最後進度。
- `setPolicy`：執行期調整政策（評測用）；正式值是常數。

### 測試結果

- 單元測試 `musiclib_core.test.js`：**34/34 通過**。新增的項目：卡住的階段被中止並附階段名與耗時、重試 3 次後才標失敗；慢但持續有回報的不算卡住、狀態顯示目前階段；暫時性失敗後重試成功；不可重試的失敗只試一次；卡住的一首不影響其他首；重試等待中暫停；暫停能打斷卡住的那次嘗試；`setPolicy` 執行期生效。
- 假轉錄真桌面版評測（`musiclib_lyrics.eval`，新 profile，只跑一次）：暫停立即生效（`running: false`，6 首排隊）；續跑後 4 首完成、2 首失敗；「晴天」第一次網路錯誤、重試後成功；「Autumn Leaves.wav」卡住、4 次嘗試後標失敗，原因含階段名、耗時與最後進度；「song.mid」不可重試，立刻失敗；歌詞搜尋與範圍切換正確。
- 真 Whisper（`musiclib_lyrics_real`，同一個 profile，只跑 wav）：本輪共跑兩次。第一次用的是修正前的截斷檔，解碼失敗（測試資料錯誤）；第二次（重新產生測試檔後）**通過**：WebGPU、4 段、1 秒、172 秒。注意：一段靜音產生 4 段文字，內容可能是 Whisper 的幻覺，這次沒有檢查內容是否合理。

### 沒驗證、沒做到

- 「等待使用者確認下載」的階段與拒絕、逾時的失敗路徑只有程式碼，沒有單元測試也沒有真機驗證。
- 真 Whisper 只跑了一次短音檔，模型是從網路下載的（約 77 MB）；沒有比較不同模型與不同長度的吞吐。
- 長檔（分段）與長時間的暫停、續跑，沒有真機驗證。
- 沒有發布、沒有推送；建置產物未提交。

### 修正 `embed-code-ui.js` 的包裝（證據）

- 原本的包裝是 `(function (module, self) { 核心檔 }).call(null, undefined, holder); return holder.FaTranscodeFallback;`。
- 核心檔 `renderer/src/media/transcode_fallback_core.js` 的寫法不是 UMD：第 7 行是 `const FaTranscodeFallback = (function () {…})();`，第 126 行是 `if (typeof module !== 'undefined' && module.exports) module.exports = FaTranscodeFallback;`。傳入的 `module` 是 `undefined`，所以第 126 行什麼都不做，`holder` 永遠是空的，`return holder.FaTranscodeFallback` 得到 `undefined`。
- 實際看到的錯誤：解碼時 `Cannot read properties of undefined (reading 'decodeForWhisper')`，`_decodeAudioForWhisperWithFallback` 整段失敗。既有的 `transcribe_media` 工具也受影響。
- 修正：傳入 `mod = { exports: {} }`，核心檔的 `module.exports` 就會寫進 `mod`，包裝回傳 `mod.exports`（只改這一個嵌入函式）。
- 其他同樣用 `embed(...)` 包裝寫法的模組（我檢查過的）：`renderer/src/gui/*`（8 個）、`renderer/src/chat/*`（6 個）、`renderer/src/agent/*`（3 個），都是標準 UMD（`else { root.X = factory() }`），不受影響。`renderer/src/gpu/gpu_core.js`、`gpu_preload.js` 也用同一個包裝，**這一輪沒有檢查**。

## 評測守則（使用者要求，2026-11-22）

適用：所有 `scripts/eval/musiclib*.eval.js` 的真桌面版評測。檔案開頭的註解也寫了同樣的守則。

1. **每次評測都用全新的 `--user-data-dir`**（空目錄）。開始時佇列與對話狀態必須是空的，不沿用上次評測留下的轉錄工作、佇列、對話。評測腳本開頭會檢查 `out.startClean`（佇列空、沒有排隊或轉錄中的曲目），不符合就不算通過。
2. **一次只跑一個評測**；同一時間只有一個轉錄工作在跑。新評測開始前，先確認上一個 Electron 與轉錄工作都已結束或已取消（用 PID 確認，不用名稱全殺，因為使用者自己的 `FloatingAssistantApp` 也在跑）。
3. **評測結束前取消自己產生的佇列**（`FaMusicLibHost.cancelTranscribe()`），並確認沒有殘留行程（只停自己啟動的 PID）。
4. **面板上若有舊的卡住工作，開新評測不能與它並行**，要先取消。面板的「取消轉錄」按鈕做的事和 `cancelTranscribe()` 相同：清空排隊、中止正在跑的那一首（不算失敗、不重試，曲目回到未轉錄）。
5. 評測都不需要 GPU。真 Whisper 評測要先確認模型快取是否可用；沒有就明講「未驗證」，不下載大檔，也不替使用者按任何下載同意。

**實際做法的注意**：真 Whisper 評測目前用的 profile（`musiclib-ud-real`）是複製過來的 Service Worker 快取（約 1.8 GB），它不是全新空目錄；守則 1 要求的「全新」目前只對假轉錄評測成立。之後的真 Whisper 評測如果要符合守則 1，需要每次重新複製快取到新目錄，或另外建一個只放模型快取的基底目錄。

進度更新（2026-11-22，批次輸出後）：十項裡，加資料夾與掃描、檔名搜尋、歌詞搜尋（假轉錄）、批次輸出 mp3（wav、mid 來源）與 mid（mid 來源）已接進桌面版並驗證；音訊轉 MIDI、哼歌比對、演奏 MIDI、YouTube、ROM／RIX／Flash 擷取未做。
