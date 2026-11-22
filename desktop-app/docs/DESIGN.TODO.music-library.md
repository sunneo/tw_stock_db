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
