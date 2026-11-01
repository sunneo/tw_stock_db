# 交接文件：`floating-assistant.js` 改成延遲載入（stub＋動態載入，handoff 1，2026-11-01）

## 1. 開場提示（給接手的工作階段）
Continue from the handoff document at `D:\Downloads\videos-嗨投資-desktop-app\desktop-app\DESIGN.TODO.lazy-loading.md`. 先完整讀完（含使用者原話與做法備忘），照做。執行 low-context-long-run 技能（門檻 30%）：做 Todo 的第一項，context 到門檻就更新這份文件並啟動你的接手工作階段（`mcp__ccd_session__start_session` 是延遲載入的工具，先用 ToolSearch 載入）。第一則訊息用一行說明你讀完了、要開始哪一項。回覆一律繁體中文、不要夾英文縮寫。**不要做長篇規劃、不要問，直接量測、重構、測試、提交；最重要的限制是：重構後全部功能不能出錯。**

使用者的關鍵指示（逐字）：「目前的floating-assistant.js對網頁來說負擔太大，開一個頁面要等老半天，幫我試著改成可以lazy-loading的，評估核心聊天程式到每個模組的佔用空間，採用類似stub跟動態載入與接上stub的方式 但是refactorying後全部功能不能有發生錯誤」。

## 2. 概況
- 目標：網頁版開頁不再一次下載、解析整份 `floating-assistant.js`。核心聊天先載入，其餘模組用 stub 佔位，需要時才動態載入並接上 stub。**零功能退步**。
- 分支 `desktop-app`，工作目錄 `D:\Downloads\videos-嗨投資-desktop-app\desktop-app`。
- 我量到的現況（2026-11-01，`renderer/src/floating-assistant.js`）：原始碼 14.25 MB、約 10.5 萬行；壓縮後 `renderer/floating-assistant.js`＝`floating-assistant.min.js` 9.84 MB；`renderer/bootstrap.js` 202 KB。原始碼 12.58 M 字元裡，**嵌入區塊（`/* XXX-BEGIN */ … /* XXX-END */`，共 155 個）占 8.02 M 字元（約 64%）**，是延遲載入最大的目標。最大的嵌入區塊（字元）：BEHAVIOR 991K、DECKSRC 801K、GAME 480K、REF 427K、VIDEOEDIT 302K、REMOTE 294K、EDITHOST 221K、EXPSRC 205K、DECKHOST 173K、BEH2 149K、PYBRIDGE 142K、KIHOST 112K、ED3D 88K、IDRSKILL 88K。最大的純資料常數：`FA_BEHAVIOR_DATA` 991K、`FA_DECK_SRC` 801K、`FA_REF_DATA` 353K、`FA_EXPORT_SRC` 205K、`FA_PYBRIDGE_FILES` 142K、`FA_IDR_SKILL_FILES` 88K、`FA_CODEUI_HTML` 83K、`FA_IMG3D_WORKER_SRC` 66K、`FA_AIDOC_VIEWER_HTML` 48K。（量測腳本寫法見本節末，接手者請做成 `scripts/size-report.js` 並提交。）
- 網頁版的載入方式：`web/index.html` 與 `web/aiweb/index.html`（在 `D:\Downloads\videos-嗨投資` repo 下，publish.sh 會處理）用完整 commit SHA 釘住 raw CDN 上的檔案，發版要換 SHA（見記憶「網頁版載入用SHA釘住」）。桌面版走 live-update（見 `.claude/skills/publish-live-update-patch/SKILL.md`）。
- 還沒有任何程式碼改動。沒部署。

量測腳本（已驗證可跑）：在 `desktop-app` 目錄用 node 讀 `renderer/src/floating-assistant.js`，正規式 `/\/\* ([A-Z0-9]+)-BEGIN \*\/([\s\S]*?)\/\* \1-END \*\//g` 抓所有嵌入區塊並依長度排序；`/^const (FA_[A-Z0-9_]+) = (["{\[`])/gm` 找大型資料常數。

## 3. Todo（依序，每項做完測試、提交）
1. **量測與盤點（寫成腳本與一頁報告）**：`scripts/size-report.js` 輸出：核心（非嵌入）大小、每個嵌入區塊大小、依「誰會用到」分類（開頁一定要用／只有某斜線指令或編輯器才用／只有桌面版用／純資料）。報告寫進 `DESIGN.lazy-loading.md`（短，含表格）。同時**量開頁時間基準**：用內建瀏覽器（`mcp__Claude_Browser__*`）開網頁版，記下下載大小、解析執行時間（`performance` 與主執行緒長工作），作為改前基準。
2. **設計 stub 機制（先做最小可行，寫在報告裡一段）**：`FaLazy`（放在核心最前面，很小）：`FaLazy.register(名稱, {url, global})`、`await FaLazy.ensure(名稱)`（下載→執行→把真正的模組接到全域名稱）、`FaLazy.stub(名稱, 方法清單)`（stub 物件：呼叫前先 ensure，已載入就直接轉呼叫）。**同步存取的問題是最大風險**：很多模組是 `const FaX = (function(){…})()` 然後同步使用。規則：每個被延遲的模組，先列出所有使用處（搜全域名稱）；使用處在 `async` 函式裡就加 `await FaLazy.ensure('x')`；在同步路徑裡就要改成非同步或讓入口（斜線指令、工具執行、面板開啟）先 ensure。**不確定能不能安全改的模組就不要延遲，寧可少拆。**
3. **第一批：純資料與只有少數入口用的大塊**（風險最低、收益最大）：`FA_BEHAVIOR_DATA`、`FA_DECK_SRC`、`FA_REF_DATA`、`FA_EXPORT_SRC`、`FA_PYBRIDGE_FILES`、`FA_IDR_SKILL_FILES`、各種 `*_HTML`、`FA_IMG3D_WORKER_SRC` 等。改成放獨立檔（建置時產出到 `renderer/lazy/*.js`），第一次用到才 `FaLazy.ensure`。**每一個使用處都要確認走到 ensure**（寫一個靜態檢查：搜尋被搬走的常數名稱，除了 stub 之外不得有直接引用）。
4. **第二批：功能模組**（遊戲編輯器 GAME、簡報 DECK、影片剪輯 VIDEOEDIT、遠端 REMOTE、3D 編輯器 ED3D、編輯器主機層 EDITHOST…）：每個模組一個 chunk，入口（斜線指令、工具、面板、`fa-edit-*` 訊息的掛載）前先 ensure。逐個做、逐個測，不要一次全拆。
5. **建置與發布管線**：`scripts/embed-code-ui.js` 與 `build-assistant.js` 要產出 chunk 檔（terser 壓縮、各自 md5）；`renderer/update-manifest.json` 與 `LIVE_PATCH_ALLOWED_FILES`／`LIVE_PATCH_MAIN_FILES`（`main.js`、`build-assistant.js` 兩處同步）要納入 chunk 檔；`scripts/make-live-patch.js`／`publish.sh` 要把 chunk 帶上；網頁版 chunk 的網址要跟著 commit SHA 釘住（同一個 SHA）。**舊版桌面版也要收得到更新、不准要求重裝；manifest 檔案清單要完整；版本號單調**（見 `publish-live-update-patch` 技能）。`main.js` 不能熱更新，所以 chunk 載入要能在「舊 main.js＋新 renderer」下運作（chunk 走相對路徑、`<script>` 或 fetch，同一個載入方式）。
6. **驗證（硬性，全部通過才算完成）**：
   - `node scripts/run-core-tests.js`（改前先跑一次記基準；先前是 133／136 組，3 組是既有失敗，不要把它們算成你造成的）；
   - 真實 Electron 的 eval 腳本（`scripts/eval/*.js`，例如 `edit3d.eval.js`）能跑的全跑；
   - 網頁版：內建瀏覽器開 `web/index.html`，主控台**零錯誤**，逐一觸發每個被延遲的功能入口（斜線指令、編輯器、遊戲、簡報、影片、遠端、3D…）確認 chunk 載入成功且功能正常；
   - 比對改前改後的開頁下載量與解析時間，寫進報告。
   - 做不到驗證的部分，在回報裡誠實列出，**不要說「沒問題」**。
7. 補功能清冊不需要（沒新增功能）；更新 `README.FloatingAssitant.md` 的 Live Update 一節（chunk 檔）與 `DESIGN.lazy-loading.md`。
8. **完成且驗證通過後直接發布**（使用者慣例：完成就更新網頁、發布 patch）：`PUBLISH_TRAILER="Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" bash scripts/publish.sh -m "…"`，再 curl 查遠端 `manifest.v2.json` 版本，並實際打開網頁版確認載入的是新版。**若驗證沒有全過，不要發布，回報原因。**

## 4. 做法備忘（使用者的規則）
- 繁體中文、結論先說、不要在中文裡夾英文縮寫；做完誠實說哪些沒驗證。
- 改來源模組，再 `node scripts/embed-code-ui.js && node build-assistant.js`；不要改嵌入後那份。
- 改檔用 Edit／Write 工具；**Bash heredoc 內的 Python 會吃掉反斜線與中文**，需要時用 Write 工具寫 `.py` 檔再執行。`floating-assistant.js` 行尾 CRLF／LF 混合，改前用 `s.count()` 試兩種。
- 編譯前會清工作目錄：做到一半也先 commit。給了順序就做到底，不要中途問。
- 熱更新：舊版也要收得到、不准要求重裝、大檔用分檔下載再合併、不壓縮換做法、版本號單調、manifest 清單完整、互換版凍結在 v188 不動（見 `publish-live-update-patch` 技能）。
- 網頁版載入用完整 commit SHA 釘住，發版要換兩個 html 裡的 SHA 並驗證頁面實際載入的版本。
- 暫時性失敗要自己重試到底（chunk 下載失敗要重試、失敗訊息附 HTTP 狀態與耗時，不能讓使用者自己重按）；不要靠換模型復原。
- 工作樹有不是你改的檔案（`skills/image-decompose-redraw/data/parts_builtin.json`、`test-reports/*`）：不要放進你的提交，也不要還原。

## 5. 使用者原話（逐字）
- 「目前的floating-assistant.js對網頁來說負擔太大，開一個頁面要等老半天，幫我試著改成可以lazy-loading的，評估核心聊天程式到每個模組的佔用空間，採用類似stub跟動態載入與接上stub的方式 但是refactorying後全部功能不能有發生錯誤」（2026-11-01）
- 標準發布指令（歷來）：「更新網頁，發布patch」「完成就可以更新網頁，發布patch」
- 一貫的態度：「JUST DO IT!」「不要再繼續plan了」——不要長篇規劃、不要問，直接做。
- 熱更新規則（歷來）：舊版也要收得到、不准要求重裝。

## 6. 交接流程（自我遞迴）
執行 low-context-long-run 技能（門檻 30%）：每個批次邊界用 `mcp__ccd_session_mgmt__get_usage` 看 context，≥30% 就更新本文件、提交、用 `start_session`（initiation `user_asked`、context `fresh`、同一個工作目錄、`use_worktree:false`）啟動接手，確認後 `mark_completed`＋`archive_session`（被拒就跳過並告知，不要重試迴圈）。

## 7. 陷阱
- 同步存取：把 `const FaX = (function(){…})()` 換成 stub 後，任何沒經過 ensure 的同步使用都會在執行時才爆（測試不一定碰得到）。一定要用靜態搜尋把每個使用處列出來，並在網頁版逐一觸發入口驗證。
- 嵌入區塊之間有順序相依（`embed-code-ui.js` 的插入順序，例如 AIDoc 區塊接在 `SUBJ3D-END` 之後）；搬出去後要保持載入順序。
- `scripts/embed-code-ui.js` 會把 `floating-assistant.js` 整份重寫（行尾可能被統一）；提交時看 `git diff --stat`，整檔差異要確認只是行尾。
- 網頁版是離線優先的產品：chunk 下載失敗（斷網）時，已載入過的要能用（考慮快取到 Cache Storage／IndexedDB），失敗要明確提示而不是靜默壞掉。
- 舊版桌面版收到新 patch 時，若 chunk 檔沒進 manifest 會 404；一定要跑 `publish.sh` 的驗證步驟。
- 不要為了省大小改壓縮方式或砍功能；使用者要的是「全部功能不能出錯」。
