# 交接文件：音樂領域（MIDI／mp3 轉 MIDI／音色庫瘦身，handoff 3，2026-11-01）

## 1. 開場提示（給接手的工作階段）
Continue from the handoff document at `D:\Downloads\videos-嗨投資-desktop-app\desktop-app\DESIGN.TODO.music.md`. 先完整讀完（含使用者原話與做法備忘），照做。工作目錄 `D:\Downloads\videos-嗨投資-desktop-app\desktop-app`（產品程式在這裡）；參考專案 `D:\Downloads\SRC\piano-web` 只讀不改（若沒有權限讀，先用目錄授權工具請求該目錄）。執行 low-context-long-run 技能（門檻 30%）：做 Todo 的第一項，context 到門檻就更新這份文件並啟動你的接手工作階段（`mcp__ccd_session__start_session` 是延遲載入的工具，先用 ToolSearch 載入）。第一則訊息用一行說明你讀完了、要開始哪一項。回覆一律繁體中文、不要夾英文縮寫。**不要做長篇規劃、不要問，直接查證、寫程式、測試、提交。**

使用者的原話在第 5 節（逐字）。

## 2. 結論與大方向（已定案，不再評估）
做一整條音樂線，全部放在 FloatingAssistant（網頁版與桌面版共用），**新模組一律走延遲載入**（網頁版用 `web-lazy` 區塊機制，見 `DESIGN.lazy-loading.md` 與 `README.FloatingAssitant.md`；桌面版整份檔案不變）。分八個階段，**依序做，每階段可獨立使用、獨立提交**：

| 階段 | 內容 | 重點 |
|---|---|---|
| 0 | 查證與量測（短，不寫長報告） | 音色庫分析工具、轉譜模型可行性、授權 |
| 1 | MIDI 核心＋播放卡片＋MIDI 轉 mp3＋domain `music` 知識 | 先讓「放得出聲、轉得出檔」 |
| 2 | MIDI 編輯器（只用 GS 音色）＋內建問 AI＋遠端卡片與遠端編輯 | 參考 piano-web 的多音軌編輯 |
| 3 | MIDI 的 AI 創作（風格範本＋CoLU＋UML design） | 程式決定結構，模型只做選擇題 |
| 4 | 音色庫瘦身工具與迷你 GS 音色庫 | 找重複、重新取樣、壓縮 |
| 5 | mp3 → MIDI（拆樂器軌、轉成 GS 音色與音軌） | 離線小模型，WebGPU／WASM／CPU |
| 6 | 接進簡報（media-presentation）、2D／3D 遊戲、影片剪輯當配樂 | 一條共用的「配樂」介面 |
| 7 | 風格知識：瀏覽器查維基的風格介紹、風格設計範本 | 與階段 3 共用 |

## 3. Todo（依序；階段 0、1 已做完，階段 2 做了編輯器本體）

**已完成並提交（細節與實測結果見 `DESIGN.music.md` §1–§5）：**
- 階段 0：`scripts/sf-analyze.js`（結論：重複樣本不到 0.05 MB，瘦身要靠降取樣與 SF3 壓縮）、轉譜模型查證、piano-web 盤點（c6a21abf）。
- 階段 1 程式：`renderer/src/music/{midi_core,midi_play,midi_ui,music_knowledge}.js`＋測試 `scripts/music-tests/`（41 項全過，已接進 `scripts/run-core-tests.js`）、播放卡片 `fa-midi`、工具 `midi_play`／`midi_to_mp3`／`music_topic`、斜線 `/midi`、`/midi-to-mp3`、domain `music`、合成器程式庫放 `renderer/vendor/spessasynth/`（提交 2befe2d0…最新見 git log）。瀏覽器實測有聲、卡片可播（測試頁 `scripts/music-tests/browser.html`、`card.html`；音色庫本機副本放在 TEMP 的 gs.sf2，**不要放進 scripts/ 以免 publish.sh 的 git add -A 把 32 MB 提交進去**）。

**階段 1 補充（handoff 3 做完的）：** 功能清冊 `features/ai-features.yaml` 已加 `music-midi`（FEATURES.md 是產生檔，不要手改）；mp3 編碼是重用既有 `_encodeMp3`（lamejs，TTS 與抽音訊走同一條，已實用過），未單獨真機跑一次；網頁版合成器路徑推導（__FA_LAZY_BASE 往上兩層＝desktop-app/，再接 renderer/vendor/spessasynth/）檢查過邏輯，**發布後要用 curl 對釘住的 commit 查 200**；合成器程式庫是 fetch 文字後用 data: 網址載入，所以 CDN 的 MIME 類型不是問題。

**階段 2 已完成並提交（handoff 3）：** `renderer/src/music/midi_edit.js`（封閉動作 apply／applyAll、中文指令 parseCommands、復原重做 history；數字音軌＝從 0 起算索引，字串音軌＝第幾軌或名稱；測試 `scripts/music-tests/midi_edit.test.js` 19 項）、`midi_editor_ui.js`（鋼琴捲簾畫布、音軌欄、GS 128 音色下拉、復原重做、試聽、下載、底部對話框：程式先讀、讀不懂才 `host.askAI`）、`floating-assistant.js` 內的 `_midiPushEditor／_midiEditAsk／_mountMidiEditCards`、斜線 `/edit-midi`、工具 `midi_edit_open`、卡片區塊 `fa-midi-edit`；瀏覽器實測（`scripts/music-tests/editor.html`，新增／刪除音符、中文指令、AI 退路、復原都正確）。

**第一項（現在就做）：階段 2 剩下的「遠端」兩件**
1. 發布仍待使用者確認（被權限檢查擋過，見第 4 節）；未確認前不要發布、不要繞過。
2. **遠端卡片與遠端編輯**。查證結果（不要重查）：現有遠端共筆是 `renderer/src/remote/rg_collab.js`＋`rg_session.js`＋`rg_patch.js`＋`rg_edit.js`，**一個編輯器要被遠端共筆，必須是 `KINDS` 登錄的編輯器種類（`FaEditShell` 外框、專案存 `FaEditStore`）**，宣告在 `_edRemoteDecl(kind)`（`sync:'patch'`＋`patchKeys`＝陣列鍵欄位，文件必須是「以 id 定址的 JSON」）。我們的 MIDI 編輯器目前是對話裡的獨立卡片，不是 KINDS。做法：（a）新增純函式 `songToDoc／docToSong`（給每軌與每個音符穩定 id，`patchKeys:{tracks:'id',notes:'id'}`，這樣兩人改不同音符會事件層級合併、改同一個音符較新者勝）並加測試；（b）把 MIDI 登錄成 KINDS 的一種（`edit-midi`，仿最小的一種，看 `KINDS` 內 `remote`、`remoteRun`），讓 `/edit-midi` 可選擇「開成共筆編輯器」；（c）播放卡片的遠端顯示：看遠端卡片機制（grep `REMOTE` 區塊、`fa-worksheet` 在遠端的處理方式）；（d）用記憶體傳輸寫測試（`rg_*` 既有測試可仿）。若 KINDS 登錄代價太大，退路：在現有卡片上用 `rg.room.send` 直接傳動作事件（`host.onChange(song, action)` 已把每個動作送出；`card._midiEdit.applyRemote(actions)` 已能套用遠端動作），衝突用「較新者勝」，並在文件寫明。
3. 階段 2 做完且測試全過 → 回報使用者請他確認發布，之後進階段 3。

**之後各階段（做完前一階段再做下一階段，不要問）：階段 2 → 7，內容見原文如下（階段 1 已完成的部分略）。**
- **階段 2**：MIDI 編輯器 `/edit-midi`（仿 `FaEditShell` 外框：音軌欄、鋼琴捲簾、屬性、復原重做、底部 AI 對話框；**音色只能選 GS 音色**，GM 128＋鼓組；piano-web 的多音軌設計可參考，但不要整個搬）；**內建問 AI**：編輯器底部對話框用封閉動作（add_note、move、transpose、quantize、set_program、add_track、delete…）加 `parseCommands`（程式先讀中文），讀不懂才問模型；**遠端**：MIDI 播放卡片要能在遠端卡片裡顯示（看 `REMOTE` 區塊與遠端卡片機制，`renderer/src/remote/`），**遠端編輯**（遠端的人改同一份 MIDI，沿用現有遠端群組的訊息通道；衝突用「較新者勝＋事件層級合併」，每次編輯是一個事件）。
- **階段 3**：AI 創作。UML design 的意思（使用者定義）：「由上而下持續規劃，細切到不可再切，再用 CoLU 接線；弱到不能規劃時用樣板；不是寫死流程」。做法：風格→段落結構（前奏／主歌／副歌…）→和弦進行（從風格範本挑，程式驗證調內和弦）→旋律（節奏型範本＋和弦音約束，程式驗證音域與不超過跳進上限）→伴奏／貝斯／鼓（範本）→配器（GM 音色對應）。模型只做封閉選擇題與填空（挑風格、挑進行、挑速度），生成的音符由程式產生並檢查；檢查失敗自動重來（暫時性失敗要自己重試到底）。輸出直接進 `/edit-midi`。可存成功案例進離線訓練器（`editor_cases` 種類 `edit-midi`）。
- **階段 4**：依階段 0 的分析報告，做 `scripts/sf-slim.js`：去掉未使用樣本、合併完全相同的樣本、近似重複改成共用（調整調音偏移）、降取樣率（依音高與用途，例如 22.05 kHz／16 kHz）、截短循環前多餘的尾段、壓縮（Ogg Vorbis 的 sf3，SpessaSynth 若支援 sf3 就用；不支援就用自訂分檔格式＋解壓）。目標：**迷你 GS 音色庫**（使用者說 Roland Virtual Sound Canvas SC-88 的安裝包與音色檔非常小，GeneralUser GS 太大，要最小化音色並找出重複區）。**階段 4 更正（使用者 2026-11-01）：「找重複」是指每個樣本波形內部的 loop，像壓縮演算法，不是樣本之間的重複（階段 0 已證明幾乎沒有）。** 做法：① 自相關／週期偵測找基頻週期與穩定段，找可無縫循環的起訖點（對齊零交越、相位連續、能量一致，避免喀嚓聲）；② 有 loop 的樣本，loop 結束點之後的資料不會被播放，直接截掉；穩定段太長的只留整數個週期當 loop，其餘丟掉；③ 沒有 loop 的持續音（弦樂、管樂、合唱等）嘗試自動找 loop 並加上，打擊類單擊音不加；④ 再降取樣率與 SF3 壓縮。聽感比對工具要加：同一份 MIDI 用原版與瘦身版各渲染一次，算頻譜差異與接縫處的不連續度，列出差異最大的音色。
**重要：Roland 的音色資料有版權，只能當「大小目標」參考，絕對不要抽取、轉換或散布 Roland 的樣本。** 只對 GeneralUser GS（允許修改散布，保留授權文字）做瘦身；每次瘦身要附**聽感比對工具**（同一份 MIDI 用原版與瘦身版各渲染一次，算頻譜差異，列出差異最大的音色給人聽）。
- **階段 5**：mp3→MIDI：解碼（WebAudio）→（可選）拆四軌（人聲／鼓／貝斯／其他）→逐軌轉譜（Basic Pitch 類）→樂器指派（貝斯軌→GM 貝斯、鼓軌→鼓組、其他→用封閉選擇題＋程式核對挑 GM 音色，例如鋼琴／吉他／弦樂）→量化→輸出 MIDI 進 `/edit-midi`。三種執行環境：WebGPU、WASM、CPU 降級，沿用 `FaVlm` 的模型登錄與工作執行緒（`renderer/src/vlm/vlm_core.js`、`faVlmWorkerMain()`）、下載進度卡（只出一張進度卡，記錄分「章節／主角／行為」，沿用 image-to-3d 的做法）。**拆成「多種樂器」只能到四軌＋鼓；更細的樂器分離沒有可靠的離線小模型，要在結果裡誠實寫明。** 長曲子分段處理、可中斷續跑。
- **階段 5 採用的順序（使用者 2026-11-01 同意；模型名稱、檔案大小、授權、能否在瀏覽器跑都是未驗證，開做前先查證並寫進 DESIGN.music.md，查不到標「未驗證」）：** ① 6 軌版 Demucs（人聲／鼓／貝斯／其他＋吉他＋鋼琴，MIT 授權待確認，有沒有 ONNX 待查）＋ Basic Pitch 逐軌轉譜；鼓軌用規則拆底鼓／小鼓／踩鑔／通鼓／鈸（偵測打擊起點，再看頻帶能量：底鼓低頻、小鼓寬頻雜訊、踩鑔高頻）對應 GM 鼓組音符；人聲與貝斯是單音，用音高追蹤（pYIN 類）。② 「其他」軌再用樂器分類（YAMNet／PANNs／AST／Essentia 之一，擇可在瀏覽器跑者）對每段打標籤，封閉選擇題＋程式核對挑 GM 音色。③ 分類不準退回：音符頻譜特徵（質心、MFCC）分群，每群指派一個 GM 音色；最後才用音域規則當預設。可評估用 GS 音色樣本當字典做非負矩陣分解，只做實驗不當預設。④ MT3／YourMT3+ 太大，只當桌面版「使用者自備、選用」，不內建。⑤ 三種執行環境沿用 FaVlm；下載只出一張進度卡；長曲分段可續跑；結果誠實寫明拆樂器只到這幾軌。輸出進 /edit-midi。
發布前入口測試（node scripts/run-core-tests.js）不能有新增失敗；發布被權限檢查擋下就回報使用者，不要繞過。
- **階段 6**：「配樂」共用介面：簡報（`media-presentation`）、2D／3D 遊戲（`edit-game-2d`、`edit-game-3d`）、影片剪輯（`edit-video`）都能選一個 MIDI 或 mp3 當配樂（循環、淡入淡出、音量）；先看這四個編輯器現有的音訊欄位（遊戲有 `game_audio.js`），一個一個接，不要一次大改。
- **階段 7**：風格知識。工具 `music_style_lookup`：用瀏覽器查維基（`browser_search`／`fetch_web_page` 已存在）找某個風格的介紹，程式抽出「速度範圍、拍號、典型和弦進行、典型樂器、節奏特徵」存成**風格範本**（使用者可停用／刪除，存進離線訓練器的領域知識，仿 `editor_cases`）；內建一批常見風格的範本（離線可用）。階段 3 的創作優先用範本。

**完成後直接發布**（使用者慣例：完成一個階段、測試全過就更新網頁、發布 patch；**沒有全過不要發布**）：`PUBLISH_TRAILER="Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" bash scripts/publish.sh -m "…"`，再 curl 查遠端 `manifest.v2.json` 版本。發布前確認：新模組的網頁版區塊檔都在 `web-lazy/manifest.json`、都在釘住的 commit 下回應 HTTP 200（這台 Node 沒有 `fetch`，`web-lazy-check.js --remote` 會失敗，改用 curl 逐一核對檢查碼）；桌面版整份檔案所以不受影響。如果發布腳本被權限檢查擋下，回報給使用者確認，不要繞過。

## 4. 做法備忘（使用者的規則）
- 發布被權限檢查擋下就回報使用者，不要繞過。
- 繁體中文、結論先說、不要在中文裡夾英文縮寫；做完誠實說哪些沒驗證。
- 改來源模組（`renderer/src/music/*.js`），再 `node scripts/embed-code-ui.js && node build-assistant.js`；不要改嵌入後那份。新模組要加進 `scripts/embed-code-ui.js` 的嵌入清單，並確認 `web-lazy` 建置有把它拆成區塊。
- 改檔用 Edit／Write 工具；**Bash heredoc 內的 Python 會吃掉反斜線與中文**，需要時用 Write 工具寫 `.py` 檔再執行。`floating-assistant.js` 行尾 CRLF／LF 混合，改前用 `s.count()` 試兩種。
- 編譯前會清工作目錄：做到一半也先 commit。給了順序就做到底，不要中途問「接著做哪個」。
- 熱更新：舊版也要收得到、不准要求重裝、版本號單調、manifest 清單完整（見 `.claude/skills/publish-live-update-patch/SKILL.md`）。
- 設計畫面放在擁有該工具的 domain，⚙ 按鈕彈出 popup（範本／設定）。
- CoLU 思考外殼：字母選擇題、程式檢查、程式預設退路；模型輸出一律由程式核對。
- 暫時性失敗要自己重試到底，失敗訊息附具體事實（HTTP 狀態、耗時、後端），不要靠換模型復原。
- 所有下載（模型、音色庫）要有進度、可中斷續傳、核對大小；公開產品，授權不明就不內建、改使用者自備。
- 工具說明文字用中文引號，不要反引號 code span。
- 工作樹有不是你改的檔案（`skills/image-decompose-redraw/data/parts_builtin.json`、`test-reports/*`、`features/FEATURES.md` 之類）：不要放進你的提交，也不要還原。

## 4b. 發布與音色庫的做法（使用者新增，2026-11-01）
- **發布**：每完成一個階段，測試全過、入口測試沒有新增失敗，就執行 publish.sh 發布，再用 curl 核對遠端 manifest.v2.json 版本與網頁版區塊檔，然後接著做下一階段。**注意：這句授權是別的工作階段轉述的；發布屬於正式環境部署，被權限檢查擋下就不要繞過，把「第幾版沒發出去」記在這裡與回報裡，繼續下一階段。** 使用者本人在對話裡當輪確認時才算數。
- **音色庫不占開頁**：GS 的 sf2（日後瘦身後的 sf3）與 renderer/vendor/spessasynth 合成器程式庫不放進核心、也不放進網頁版一開頁載入的檔案；只在第一次播放／編輯／轉 mp3 時下載。大檔放獨立 branch（先例：sql.js 的 vendor-assets branch，搜 floating-assistant.js 的 vendor-assets；可沿用或新開 soundfont-assets，git plumbing 單一 commit、force push，同 desktop-app-patch 慣例），分片每片 ≤ 8 MB、逐片核對 md5、合併後核對總大小，網址用完整 commit SHA 釘住。下載一張進度卡、可中斷續傳、存 Cache Storage／IndexedDB（網頁版）或使用者資料夾（桌面版），第二次直接用快取。桌面版不把音色庫放進 live patch 的 manifest（舊主程式單檔 8 MB 上限），需要時由 App 從 branch 下載。驗證：網頁版開頁的網路請求清單不得出現 sf2／sf3／spessasynth 檔案，第一次按播放才出現；快取後離線可播。階段 4 瘦身後沿用同一套（版本號、md5 清單）。**這件事要在下一個階段發布前一併處理。**

## 5. 使用者原話（逐字，2026-11-01）
- 「我有下一個計劃想執行，是音樂領域」
- 「mp3->midi  (用可以onnx, webgpu/cpu, wasm網頁執行的小model，拆成多種樂器，再轉soundfont樂器跟音軌)」
- 「midi的ai創作設計」「midi的播放器」「midi轉mp3」
- 「midi編輯器，可以參考piano-web的多音軌編輯的設計，但是要改成只用soundfont-gs做為樂器」
- 「midi跟mp3可以在media-presentation, edit-game-2d, edit-game-3d, edit-video使用來做維配樂」
- 「midi播放卡片也要支援遠端卡片」「midi要遠端編輯」
- 「幫我設計domain裡面的音樂知識描述，在這邊也要有能力用瀏覽器找wiki關於各種音樂的風格介紹，要有風格設計的範本與CoLU」
- 「音樂編輯器也要有內建ask ai」
- 「這個應該也是可以lazy-loading」
- 「然後我希望裡面用到的generic可以重新評估、取樣跟壓縮，因為我有買過一個roland virtual canvas sc88，但他整個安裝包跟音色檔非常小。這個gs的soundfont音色太大。想要最小化音色，來找出重複區」
- 「那幫我在階段四，除了壓縮格式外也把loop找出來最小化音色」（2026-11-01）
- 「我說的找重複不是音色重複，是類似壓縮演算法，例如找到聲音裡面的loop區段」（2026-11-01）
- 「好，階段五採用你的建議，先照著順序往下做」（2026-11-01）
- 「請完成每一個就自動發布，並接著往下做」（2026-11-01，經 desktop-app 工作階段轉述）
- 「音色我們可以放到branch或者lazy-loading，避免網頁一進去就占用」（2026-11-01，經 desktop-app 工作階段轉述）
- 標準發布指令（歷來）：「更新網頁，發布patch」「完成就可以更新網頁，發布patch」；態度：「JUST DO IT!」「不要再繼續plan了」。

## 6. 交接流程（自我遞迴）
執行 low-context-long-run 技能（門檻 30%）：每個批次邊界用 `mcp__ccd_session_mgmt__get_usage` 看 context，≥30% 就更新本文件、提交、用 `start_session`（initiation `user_asked`、context `fresh`、工作目錄 `D:\Downloads\videos-嗨投資-desktop-app\desktop-app`、`use_worktree:false`）啟動接手，確認後 `mark_completed`＋`archive_session`（被拒就跳過並告知，不要重試迴圈）。

## 7. 陷阱
- **Roland 版權**：SC-88／Virtual Sound Canvas 的音色不能抽取或散布，只當大小目標。piano-web 的 `gs-engine.js` 檔頭記載使用者先前用過 Nuked-SC55（需要使用者自備 ROM、而且是非商業授權），後來換成 SpessaSynth＋GeneralUser GS，原因就是授權；不要走回頭路。
- piano-web 是獨立專案（`D:\Downloads\SRC\piano-web`，有自己的 git）：只讀；要用的程式「移植」進本專案，不要讓本專案依賴那個資料夾。
- 音色庫 43 MB（base64）絕不能進核心檔；音色與合成引擎都是延遲載入的區塊或使用者下載。
- 轉譜模型多半只能到四軌（人聲／鼓／貝斯／其他）；不要在說明裡承諾能分出任意樂器。
- 遠端編輯要先看現有遠端機制能不能傳「事件」而不是整份檔案，大 MIDI 整份傳會卡。
- 網頁版是離線優先：區塊下載失敗要明確提示、已載入的能用。
- `scripts/embed-code-ui.js` 會把 `floating-assistant.js` 整份重寫（行尾可能被統一）；提交時看 `git diff --stat`。

## 8. 階段 1 學到的坑（handoff 2 新增）
- 離線渲染（OfflineAudioContext＋SpessaSynth）送完事件後要等一下才能 startRendering，否則整段靜音（事件經訊息埠非同步到處理器執行緒）；`renderOffline` 已處理。
- 瀏覽器窗格隱藏時下載與計時會被節流：測試用本機伺服器＋本機音色庫副本；`javascript_tool` 不要回傳大量日誌（進度回呼只存最後一則）。
- `scripts/publish.sh` 會 `git add -A renderer scripts web-lazy`：scripts/ 底下不能放大檔；其他工作階段未提交的檔案也會被帶進去，發布前看 `git status`。
- 本機 python http.server 在這台會回 404（cwd 問題），改用 scratchpad 內的小 node 伺服器（`node srv.js <資料夾>`，埠 8777）。
- 嵌入 `floating-assistant.js` 的模組 factory 取不到另一個嵌入模組要用 `root.X || (typeof X !== "undefined" ? X : undefined)`（見 midi_play.js 開頭）。
- 對 `floating-assistant.js` 的大改用 Write 寫一次性補丁腳本（scratchpad），錨點必須唯一，CRLF/LF 混合所以錨點用單行。
