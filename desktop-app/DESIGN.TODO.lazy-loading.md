# 交接文件：`floating-assistant.js` 改成延遲載入（stub＋動態載入，handoff 2，2026-11-01）

## 0. 狀態更新（handoff 2，2026-11-01，本節優先於下面第 2、3 節）
**已完成並提交**（commit `04b5e06a` 與之後的 publish.sh／web-lazy-check 提交）：
- `scripts/size-report.js`、`DESIGN.lazy-loading.md`（量測與基準）。
- **關鍵設計決定（重要發現）**：舊版已安裝的 `main.js` 熱更新白名單是寫死的（只有 index.html、bootstrap.js、floating-assistant.js／.min.js、主行程模組、preload），**新增的分檔到不了舊版桌面版**。所以：**桌面版繼續用整份 `renderer/floating-assistant.js`（完全不變，零風險）；只有網頁版改用「核心＋獨立區塊檔」**。輸出放在 `desktop-app/web-lazy/`（`core.js`、`chunks/*.js`、`manifest.json`），`package.json` 打包不含它。使用者問「拆出來的要不要進 live patch 清單」：桌面版不需要（沿用整份檔案）；網頁版靠釘 SHA 的 raw 網址取得，由 `scripts/web-lazy-check.js`（本機檢查＋`--remote <SHA>` 逐檔驗證 HTTP 200 與檢查碼）把關，已接進 `publish.sh`。要向使用者誠實說明這一點。
- 機制（不需改任何同步使用處）：`renderer/src/lazy-runtime.js` 的 `FaLazy`；`scripts/build-web-lazy.js`（由 `build-assistant.js` 呼叫）把「頂層只有宣告」的嵌入區塊（≥3K、不在 `EXCLUDE` 清單）搬成獨立檔，核心裡每個宣告的名稱換成全域取值函式：第一次碰到就用同步請求載入該區塊（之後就是區塊自己宣告的全域綁定）；`FaLazy.ensure(名稱)` 可預先非同步載入（有快取、重試、附 HTTP 狀態與耗時）。`EXCLUDE` 是開頁一定碰到的 26 個區塊（留在核心，避免開頁一串同步請求）。
- 原始碼只改了 3 處（讓大資料不在載入時被讀取）：`FA_REF_FORMAT`／`FA_REF_MIGRATIONS` 別名移除、IDR 人設改 getter。
- 量測（本機無網路延遲）：核心 5010K（gzip 1.74MB）＋120 個區塊 4607K，對照整份 9.6MB（gzip 3.15MB）；開頁到建構完成 1.10 秒對 1.98 秒；開頁零個區塊被載入；120 個區塊全部手動觸發載入、名稱皆有定義、主控台零錯誤。
- 測試工具：`node scripts/lazy-test/serve.js 8765` 後開 `http://localhost:8765/`（核心＋區塊）或 `?mono=1`（整份對照）；`window.__FA_LAZY_TRACE=1` 已開，`window.__faLazyTrace` 記每次區塊載入的呼叫堆疊；`node scripts/lazy-loadtime.js` 靜態找載入時就碰到區塊的位置；`node scripts/lazy-analyze.js` 看每個區塊是否純定義。`fa._behTables()` 在測試頁會丟 `t[n].push is not a function`，整份檔案也一樣（既有現象，不是退步）。
- 注意：重新建置時 `web-lazy/` 會被清掉重建（約 1 分鐘），測試頁此時會白畫面；測試頁預設隱藏按鈕，要在主控台 `fa.toggleWindow()` 才看得到視窗。

**核心測試**：`node scripts/run-core-tests.js` 在背景跑，輸出 `C:\Users\sunneo\AppData\Local\Temp\core-tests.log`（基準 133／136，3 組既有失敗）；接手者先看結果，沒結果就重跑。

**尚未做（依序）**：
1. 網頁版實測：到 `D:\Downloads\videos-嗨投資`（main 分支，`web/index.html`、`web/aiweb/index.html`）把 fetch 的網址從 `.../desktop-app/renderer/floating-assistant.js` 改成 `.../desktop-app/web-lazy/core.js`，並在載入前加 `window.__FA_LAZY_BASE = 'https://raw.githubusercontent.com/sunneo/tw_stock_db/<同一個完整 SHA>/desktop-app/web-lazy/chunks/';`（`publish.sh` 的 sed 會一起換 SHA）。**先本機測**（複製一份 index.html、把網址指到 localhost:8765，用內建瀏覽器逐一觸發每個功能入口：/ref、行為說明、簡報、匯出、各編輯器、遊戲、影片、遠端、3D…，主控台零錯誤），測過才改正式檔。web repo 的修改要提交推送屬對外發布，照使用者慣例完成驗證後直接做。
2. 進一步縮小核心（選做，每批測試後提交）：(a) 非純定義的區塊（GAME 468K、VIDEOEDIT 295K、REMOTE 287K、EDITHOST 216K、DECKHOST 169K、DECKEDIT、COMPUTER、ENV、HARNESS，共約 1.5MB）頂層有立即執行函式做註冊等副作用，要逐一看它們做了什麼，才能決定怎麼延遲；(b) `FloatingAssistant` 類別本身約 3MB，可評估把大型功能的方法群（行為說明、/ref、簡報、匯出）分檔，用 `Object.assign(FloatingAssistant.prototype, …)` 的樣式延遲安裝。**不確定就不拆。**
3. 驗證全部通過後：更新 README Live Update 一節與 `DESIGN.lazy-loading.md`，再 `PUBLISH_TRAILER="Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" bash scripts/publish.sh -m "…"`（它會跑 web-lazy-check、提交 web-lazy、推送、驗證）。發布後用內建瀏覽器開真正的網頁版確認載入的是新版且 AI 助理能開。驗證沒全過就不要發布。

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
5. **【硬性規則，使用者 2026-11-01 提醒】發 patch 時，拆出來的每一個 chunk 檔都必須進 live patch 清單**：先決定每個 chunk 的類別（renderer 前端／主行程模組），再同步改 `renderer/update-manifest.json` 的來源（`build-assistant.js` 產生）、`main.js` 的 `LIVE_PATCH_ALLOWED_FILES`／`LIVE_PATCH_MAIN_FILES` 與 `build-assistant.js` 同名常數（兩處同步）、`scripts/make-live-patch.js`。發布前跑一個檢查：列出 `renderer/lazy/` 實際產出的所有檔案，逐一確認都在 manifest 裡、每個的 md5 與推上去的 blob 一致（`publish.sh` 的驗證步驟），**少一個就不准發布**。網頁版另外確認每個 chunk 網址在釘住的 commit SHA 下回應 HTTP 200。
   建置與發布管線：`scripts/embed-code-ui.js` 與 `build-assistant.js` 要產出 chunk 檔（terser 壓縮、各自 md5）；`renderer/update-manifest.json` 與 `LIVE_PATCH_ALLOWED_FILES`／`LIVE_PATCH_MAIN_FILES`（`main.js`、`build-assistant.js` 兩處同步）要納入 chunk 檔；`scripts/make-live-patch.js`／`publish.sh` 要把 chunk 帶上；網頁版 chunk 的網址要跟著 commit SHA 釘住（同一個 SHA）。**舊版桌面版也要收得到更新、不准要求重裝；manifest 檔案清單要完整；版本號單調**（見 `publish-live-update-patch` 技能）。`main.js` 不能熱更新，所以 chunk 載入要能在「舊 main.js＋新 renderer」下運作（chunk 走相對路徑、`<script>` 或 fetch，同一個載入方式）。
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

- 「發patch時，要思考是不是這些拆出來的都要進live patch的清單」（2026-11-01）

## 6. 交接流程（自我遞迴）
執行 low-context-long-run 技能（門檻 30%）：每個批次邊界用 `mcp__ccd_session_mgmt__get_usage` 看 context，≥30% 就更新本文件、提交、用 `start_session`（initiation `user_asked`、context `fresh`、同一個工作目錄、`use_worktree:false`）啟動接手，確認後 `mark_completed`＋`archive_session`（被拒就跳過並告知，不要重試迴圈）。

## 7. 陷阱
- 同步存取：把 `const FaX = (function(){…})()` 換成 stub 後，任何沒經過 ensure 的同步使用都會在執行時才爆（測試不一定碰得到）。一定要用靜態搜尋把每個使用處列出來，並在網頁版逐一觸發入口驗證。
- 嵌入區塊之間有順序相依（`embed-code-ui.js` 的插入順序，例如 AIDoc 區塊接在 `SUBJ3D-END` 之後）；搬出去後要保持載入順序。
- `scripts/embed-code-ui.js` 會把 `floating-assistant.js` 整份重寫（行尾可能被統一）；提交時看 `git diff --stat`，整檔差異要確認只是行尾。
- 網頁版是離線優先的產品：chunk 下載失敗（斷網）時，已載入過的要能用（考慮快取到 Cache Storage／IndexedDB），失敗要明確提示而不是靜默壞掉。
- 舊版桌面版收到新 patch 時，若 chunk 檔沒進 manifest 會 404；一定要跑 `publish.sh` 的驗證步驟。
- 不要為了省大小改壓縮方式或砍功能；使用者要的是「全部功能不能出錯」。
