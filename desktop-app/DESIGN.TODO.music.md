# 交接文件：音樂領域（MIDI／mp3 轉 MIDI／音色庫瘦身，handoff 1，2026-11-01）

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

## 3. Todo（依序，每項做完測試、提交；發布見最後）
**第一項（現在就做）：階段 0 的三件事，各一小時內，結果寫進 `DESIGN.music.md`（新檔，短，含「未驗證」標示）：**
1. **音色庫分析工具** `scripts/sf-analyze.js`（node）：讀 `D:\Downloads\SRC\piano-web\vendor\soundfonts\`（或 `js/vendor-data/soundfont-gs-b64.js` 解出的 GeneralUser-GS.sf2，約 32 MB，base64 後 43 MB）。輸出：樣本（sample）數量與總位元組、取樣率分布、每個預設音色（preset）用到的樣本、**完全相同的樣本（內容雜湊）**、**近似重複的樣本（同音高、波形相關係數高）**、未被任何預設音色使用的樣本、循環點（loop）資訊。可以借 SpessaSynth 的 sf2 解析（`D:\Downloads\SRC\piano-web\vendor\spessasynth` 與 `vendor-data/spessasynth-lib-b64.js`），也可以自己寫（sf2 是 RIFF，格式單純）。這個報告決定階段 4 能省多少。
2. **轉譜模型查證**：找 mp3→MIDI 與樂器拆軌可用的 ONNX 模型——候選：Basic Pitch（多音轉譜，樂器無關，模型很小）、Demucs／Open-Unmix 的 ONNX（人聲／鼓／貝斯／其他四軌）、MT3 類（多樂器轉譜，通常很大）、鼓轉譜模型。對每個記：Hugging Face 或官方的 ONNX 檔在哪、檔案大小、授權（能不能散布；不能就改「使用者自己下載」，像 UniK3D 那樣不內建）、onnxruntime-web 的 WebGPU 與 WASM 是否能跑、輸入長度限制。**只記查到的事實，查不到就寫「未驗證」，不要猜。**
3. **piano-web 盤點**：讀 `D:\Downloads\SRC\piano-web` 的 `js/multitrack.js`（245 KB，多音軌編輯器；含 AI 讀譜分段 `MT_AI_MAX_CHUNK_SIZE`）、`js/gs-engine.js`（SpessaSynth＋GeneralUser-GS 的音色引擎）、`js/midi-export.js`、`js/mp3-export.js`（lame）、`js/player.js`、`js/soundfont.js`、`js/custom-instruments.js`，寫出「哪些能搬、哪些依賴 DOM／全域、哪些要改成只用 GS 音色」的一頁清單（以函式／檔案為單位）。授權：SpessaSynth 是 Apache-2.0，GeneralUser GS 允許任何用途包含商業（要保留授權文字，見 piano-web 的 `vendor/spessasynth/SPESSASYNTH-LICENSE.txt`）。

**之後各階段（做完前一階段再做下一階段，不要問）：**
- **階段 1**：純函式核心 `renderer/src/music/midi_core.js`（`FaMidi`：解析／寫出標準 MIDI 檔、事件模型 `{tracks:[{name,program,channel,notes:[{t,d,n,v}]}], tempo, timesig}`，量化、移調、合併／拆分軌，測試 `scripts/music-tests/`）；合成引擎沿用 SpessaSynth＋GS 音色（延遲載入，不是核心）；**MIDI 播放卡片**（聊天裡一則訊息，圖碼 ```` ```fa-midi {...} ````，仿 `fa-edit-*` 與 3D 場景卡；播放／暫停／進度／音軌靜音與音量／下載）；**MIDI 轉 mp3**（沿用 piano-web 的離線渲染＋lame 做法）；斜線指令 `/midi`、`/midi-to-mp3`，工具 `midi_play`、`midi_to_mp3`；domain `music` 登錄在 `SUBAGENT_DOMAIN_REGISTRY`（`renderer/src/floating-assistant.js` 搜 `SUBAGENT_DOMAIN_REGISTRY.code_debug` 看寫法），systemPrompt 裡放**音樂知識描述**：調性與音階、和弦與功能、節奏與拍號、聲部與音域（每種 GM 樂器的合理音域）、配器常識、各風格（流行、搖滾、爵士、古典、電子、民謠、拉丁、嘻哈…）的典型和弦進行／節奏型／速度範圍／配器；工具說明用中文引號，不要反引號。
- **階段 2**：MIDI 編輯器 `/edit-midi`（仿 `FaEditShell` 外框：音軌欄、鋼琴捲簾、屬性、復原重做、底部 AI 對話框；**音色只能選 GS 音色**，GM 128＋鼓組；piano-web 的多音軌設計可參考，但不要整個搬）；**內建問 AI**：編輯器底部對話框用封閉動作（add_note、move、transpose、quantize、set_program、add_track、delete…）加 `parseCommands`（程式先讀中文），讀不懂才問模型；**遠端**：MIDI 播放卡片要能在遠端卡片裡顯示（看 `REMOTE` 區塊與遠端卡片機制，`renderer/src/remote/`），**遠端編輯**（遠端的人改同一份 MIDI，沿用現有遠端群組的訊息通道；衝突用「較新者勝＋事件層級合併」，每次編輯是一個事件）。
- **階段 3**：AI 創作。UML design 的意思（使用者定義）：「由上而下持續規劃，細切到不可再切，再用 CoLU 接線；弱到不能規劃時用樣板；不是寫死流程」。做法：風格→段落結構（前奏／主歌／副歌…）→和弦進行（從風格範本挑，程式驗證調內和弦）→旋律（節奏型範本＋和弦音約束，程式驗證音域與不超過跳進上限）→伴奏／貝斯／鼓（範本）→配器（GM 音色對應）。模型只做封閉選擇題與填空（挑風格、挑進行、挑速度），生成的音符由程式產生並檢查；檢查失敗自動重來（暫時性失敗要自己重試到底）。輸出直接進 `/edit-midi`。可存成功案例進離線訓練器（`editor_cases` 種類 `edit-midi`）。
- **階段 4**：依階段 0 的分析報告，做 `scripts/sf-slim.js`：去掉未使用樣本、合併完全相同的樣本、近似重複改成共用（調整調音偏移）、降取樣率（依音高與用途，例如 22.05 kHz／16 kHz）、截短循環前多餘的尾段、壓縮（Ogg Vorbis 的 sf3，SpessaSynth 若支援 sf3 就用；不支援就用自訂分檔格式＋解壓）。目標：**迷你 GS 音色庫**（使用者說 Roland Virtual Sound Canvas SC-88 的安裝包與音色檔非常小，GeneralUser GS 太大，要最小化音色並找出重複區）。**重要：Roland 的音色資料有版權，只能當「大小目標」參考，絕對不要抽取、轉換或散布 Roland 的樣本。** 只對 GeneralUser GS（允許修改散布，保留授權文字）做瘦身；每次瘦身要附**聽感比對工具**（同一份 MIDI 用原版與瘦身版各渲染一次，算頻譜差異，列出差異最大的音色給人聽）。
- **階段 5**：mp3→MIDI：解碼（WebAudio）→（可選）拆四軌（人聲／鼓／貝斯／其他）→逐軌轉譜（Basic Pitch 類）→樂器指派（貝斯軌→GM 貝斯、鼓軌→鼓組、其他→用封閉選擇題＋程式核對挑 GM 音色，例如鋼琴／吉他／弦樂）→量化→輸出 MIDI 進 `/edit-midi`。三種執行環境：WebGPU、WASM、CPU 降級，沿用 `FaVlm` 的模型登錄與工作執行緒（`renderer/src/vlm/vlm_core.js`、`faVlmWorkerMain()`）、下載進度卡（只出一張進度卡，記錄分「章節／主角／行為」，沿用 image-to-3d 的做法）。**拆成「多種樂器」只能到四軌＋鼓；更細的樂器分離沒有可靠的離線小模型，要在結果裡誠實寫明。** 長曲子分段處理、可中斷續跑。
- **階段 6**：「配樂」共用介面：簡報（`media-presentation`）、2D／3D 遊戲（`edit-game-2d`、`edit-game-3d`）、影片剪輯（`edit-video`）都能選一個 MIDI 或 mp3 當配樂（循環、淡入淡出、音量）；先看這四個編輯器現有的音訊欄位（遊戲有 `game_audio.js`），一個一個接，不要一次大改。
- **階段 7**：風格知識。工具 `music_style_lookup`：用瀏覽器查維基（`browser_search`／`fetch_web_page` 已存在）找某個風格的介紹，程式抽出「速度範圍、拍號、典型和弦進行、典型樂器、節奏特徵」存成**風格範本**（使用者可停用／刪除，存進離線訓練器的領域知識，仿 `editor_cases`）；內建一批常見風格的範本（離線可用）。階段 3 的創作優先用範本。

**完成後直接發布**（使用者慣例：完成一個階段、測試全過就更新網頁、發布 patch；**沒有全過不要發布**）：`PUBLISH_TRAILER="Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" bash scripts/publish.sh -m "…"`，再 curl 查遠端 `manifest.v2.json` 版本。發布前確認：新模組的網頁版區塊檔都在 `web-lazy/manifest.json`、都在釘住的 commit 下回應 HTTP 200（這台 Node 沒有 `fetch`，`web-lazy-check.js --remote` 會失敗，改用 curl 逐一核對檢查碼）；桌面版整份檔案所以不受影響。如果發布腳本被權限檢查擋下，回報給使用者確認，不要繞過。

## 4. 做法備忘（使用者的規則）
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
