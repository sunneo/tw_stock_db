# 管理者交接：音樂庫、網頁全螢幕頁、台股技能（2026-11-24）

專案 `D:\Downloads\videos-嗨投資-desktop-app\desktop-app`，分支 `desktop-app`；網頁版倉庫 `D:\Downloads\videos-嗨投資`。舊的 `docs/HANDOFF.manager.md` 是 GPU 線的管理者交接，不要覆蓋它；這份只管音樂庫、網頁全螢幕頁、台股技能這幾條。

## 1. 開場提示（接手者收到的原文）
接續管理者工作。完整讀 `desktop-app/docs/HANDOFF.musiclib-manager.md`（含使用者原話與工作方式）並照著做，執行 low-context-long-run 技能（門檻 30%）。第一件事：使用者剛糾正「台股那個技能我沒有要安裝在 desktop app 跟一般 ai，他是台股網頁 only」，但 v568 已經把它發給所有人了，要先修正並重新發布。第一則訊息用一行確認你讀過文件、正要開始待辦第 1 項。管理者工作階段不封存。

## 2. 概況
- 我（前一棒，Sonnet 5.5）是管理者；子工作階段用 Haiku、推理強度 high（用 get_session 核對，它們常掉回 medium）。
- **已發布到 v568**（`desktop-app` 分支 `2de84dc3c`，遠端核對過）。本機乾淨（只有未追蹤的 `bash.exe.stackdump`、`../wiki/`）。
- 最近做完並發布的：
  - 哼歌：專用轉音符路徑（消雜音、滑音規則、多種轉法取最高分、放寬音程容忍）。以使用者給的樣本在真實 86 首 RIX 曲庫實測，名次 14／2／72 → 1／2／3（sample1→MUSIC_36、sample2→MUSIC_22（與 MUSIC_17 同分，是重複檔）、sample4→MUSIC_03；sample3→MUSIC_14 排第 2，沒參與調參）。樣本在 `C:\Users\sunneo\Desktop\sample1~4.mp3`，答案 MIDI 在 `C:\Users\sunneo\Downloads\MUSIC_*.RIX_1.mid`，RIX 曲庫在 `D:\Downloads\SOFTSTAR.tar\SOFTSTAR\SOFTSTAR\PAL\86RIX`。調參腳本在 `E:\Temp\`（rixpool.js、sweep.js、final.js；暫存，可能被清）。
  - 音樂庫：加檔案／加資料夾記住上次位置；歌詞欄對 MIDI／遊戲音樂顯示「—（無人聲）」；旋律索引進度顯示；設定視窗改左側分頁；視窗控制鈕（☐ ⤢ ⛶）放標題列右邊並接 FaWin；彈出或最大化時內容撐滿；匯入資料庫後 md5 算完自動接上；強制重建旋律索引（勾選或選資料夾）。
  - 網頁：`https://sunneo.github.io/tw_stock_db/web/aiweb/<指令>/` 全螢幕頁（11 個指令，產生器 `scripts/gen-aiweb-pages.js` 由 publish.sh 呼叫；載入器網址帶版本標記避開 10 分鐘快取）。
  - 台股量化技能（`skills/tw-trading/`、`DESIGN.tw-trading-skills.md`、`BUILTIN_SKILLS` 項目 `tw-trading-market-tools`）：**這是錯的發法，見待辦 1**。
- 工作階段：`web-aiweb`（`local_7810cc0a-...`）與 `tw-skills`（`local_79c3248a-...`）都已完成並合併，閒置。

## 3. 待辦（依序）
1. **台股技能改成「只在台股網頁」**：使用者原話見第 5 節。現狀：`renderer/src/floating-assistant.js` 的 `BUILTIN_SKILLS` 裡有 `tw-trading-market-tools`，桌面版與一般網頁版 AI 都會載入。要做：(a) 先查台股網站（`D:\Downloads\videos-嗨投資\web\index.html` 的載入設定）有沒有能讓主機頁傳設定給 FloatingAssistant 的機制（如主機頁註冊技能、旗標或網址判斷），找出「只有台股網頁才啟用」的最乾淨做法；(b) 把內建項目從所有人預設載入改成只在台股網頁出現（桌面版與 `/aiweb/` 其他頁面的一般 AI 不出現）；(c) 單元測試覆蓋「桌面版沒有、台股網頁有」；(d) 發布；(e) 用真桌面版（評測，全新資料夾、換埠）確認技能清單裡沒有它，並用台股網頁真網址確認有。注意：此技能的程式與文件放在 `desktop-app/skills/tw-trading/`，網頁版倉庫在 `D:\Downloads\videos-嗨投資`（只能透過 publish.sh 的流程更動網頁倉庫）。
2. 台股技能實跑驗證：網頁版 AI 不能直接呼叫 JavaScript 核心，改請 AI 用瀏覽器內 Python 照公式算，這條**從沒跑過**。在台股網頁真的問「看今天大盤廣度」，看有沒有載入技能、算出數字。
3. `/aiweb/` 全螢幕頁剩下的：GUI 上方仍有一則 AI 說明訊息、GUI 外有內距；桌面寬度沒驗；只實際看了 musiclib 與 edit-midi，其餘 9 個指令沒逐一看；瀏覽器主控台有 jsDelivr 403（預熱失敗同類），沒查頁面怎麼退回。
4. v566 起的功能只有單元測試、沒在真桌面版點過：強制重建旋律索引兩顆按鈕、匯入後 md5 自動接上、彈出視窗被拉大的畫面。
5. Redmine 那邊的回覆（使用者貼來的報告）：我已答「我們的做法是技能包→專屬領域 `skill_<id>`＋同名斜線指令＋`read_skill_file__<id>` 按需讀檔；匯入時 `personaPrompt` 只放 SKILL.md，沒有折腳本；110 KB 是 Redmine 外掛自己的行為，建議改成只載入 SKILL.md」。使用者問要不要整理成一段貼回去，**尚未回覆**。
6. 哼歌後續：使用者可能再給樣本與答案檔；每次加進基準再調。比對靠名次、不靠分數門檻（預設最低分 0.15、低於 0.5 標「可能」）。
7. 使用者優先順序：主要目標是音樂資料庫與哼歌；ROM 轉音樂只是 nice to have（NES 擷取線已停，分支 `claude/ml-chipquality-ccf217` 未併）。已知未驗證：RIX 打擊樂與 SPC 音質、真網路 YouTube、設定視窗與搬家對應畫面、Doraemon 1 SPC 幾乎無聲。
8. 收尾檢查：Win32_Process 確認沒有殘留的預覽伺服器（埠 18123）、Electron、publish.sh。

## 4. 工作方式（使用者規則，抄重點）
- 純繁體中文、不夾英文縮寫；失敗訊息要有具體事實。不確定的事實要說「我沒查」。
- **不准被動等**：使用者罵過「你是等到我通知你才動」。長工作放背景，用 Monitor 等完成事件，每個回合先看通知；不要在前景用 waitbuild 卡 10 分鐘。
- **不要先質疑使用者**：使用者說「更新到 v566 還是只有部分」時，我先猜「沒更新」並要截圖，被罵「你先質疑 user」。使用者說有問題，先查自己的測試與程式；我的評測只量了外框、沒量內容，才沒測出來。
- 發布流程：`PUBLISH_TRAILER="Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" scripts/publish.sh -m "…"` 背景跑，`Monitor` 等 `PUBLISH_DONE`；完成的判準是日誌有「完成：patch vN」且 `git ls-remote origin refs/heads/desktop-app` 等於本機 HEAD；預熱的 jsDelivr 403 是警告不影響。來源沒變只重發時用 `--skip-build`（不要先 `git checkout -- renderer web-lazy`）。發布前來源要乾淨，否則腳本拒絕。這條線使用者已授權「完成後直接核對並發布」，不用每次再問。
- 改內嵌模組要改**來源模組**（`renderer/src/<模組>/…`），改 `floating-assistant.js` 裡嵌入產生的那份會在建置時被蓋掉（`/knowledge-ui` 就這樣害網頁入口頁產生失敗）；每次嵌入後 grep 確認改動還在。
- 改程式用 Edit 工具，或先用 Write 寫成檔再執行；shell 內嵌 python 的反斜線會被吃掉（今天又踩了三次）。
- 真桌面版評測：`E:\Temp\run_eval.ps1 -Eval <檔名> -Tag <標籤> -Port <埠>`（檔名不含路徑），全新資料夾、換埠（不用 17923）、同一評測最多跑兩次、只停自己啟動的 PID（廣泛比對的 Stop-Process 會被擋，要用埠號查出自己的 PID）。
- 派子工作階段：Sonnet 5.5 領導 → Haiku、推理強度 high；開完用 get_session 核對 model 與 effort（上次兩次都掉成 medium）；簡報寫明只寫程式與測試、不發布不 push 不建置不開真桌面版、歧義自決不來回問、不准縮小範圍；回報後我核對提交與測試再合併。子工作階段做的內嵌改動要確認放在來源模組。
- 音樂庫 UI 有兩份（`index.html` 的設定分頁與 `floating-assistant.js` 內部面板）要一起查；音樂庫評測守則在 `scripts/eval/musiclib*.eval.js` 檔頭。
- 授權：GPL 程式碼不能抄；YouTube 擁有權／創用 CC 驗證不能放寬；MIT 改寫要保留版權聲明（台股技能已附 `THIRD-PARTY-NOTICE.md`）。
- 用量：5 小時額度與每週額度近 90% 要先告訴使用者（目前每週 44%）。

## 5. 使用者原話（逐字，節錄仍有效的）
- 「我想到一個本地音樂資料庫的點子 … 可以用文字找出音樂 … 可以透過麥克風或音樂檔案片段，找出類似那端聲音的音樂 (不用非常精準) … 要支援打擊聲音，使用者哼歌的時候如果有文字，也可以作為一個增加廣度的搜尋條件 … 過濾器當真找不到，也可以詢問要不要幫使用者演奏midi」（2026-11-21）
- 「rom轉音樂是nice to have, 不是must have」「主要目標是音樂資料庫/哼歌」（2026-11-23）
- 「人沒辦法同一時間哼超過一個旋律，除非beatbox」（2026-11-23）
- 「你的目標是設法做出演算法，把sample轉出的midi經過配對可以找到我提到的RIX」（2026-11-24；樣本對應見第 2 節）
- 「如果音高我要拉到那麼高  那哼歌找音樂的效果就是不好的」（2026-11-24）
- 「我希望+檔案跟+資料夾可以記住上一次的選擇 不然每次都要從workspace開始很不方便」（2026-11-24）
- 「也加上一個強制更新旋律索引  可以選資料夾或多選來更新指定的旋律索引」（2026-11-24）
- 「我覺得musiclib的configure 應該要一致是左右分頁的方式」（2026-11-24）
- 「我希望我們網站的網頁可以支援 https://sunneo.github.io/tw_stock_db/web/aiweb/{具備gui的slashcommand名稱} 裡面是讓整個gui就是full screen完整的頁面，但是使用的indexdb, fap還是原本的 … 如果github不支援這樣，那hashtag看能不能做到？」（2026-11-24）
- 「完成後直接核對並發布」（2026-11-24，台股技能這條）
- 「**台股那個技能我沒有要安裝在 desktop app跟一般ai，他是台股網頁only**」（2026-11-24，待辦 1）
- 「我說了，結果你先質疑user?」「你是等到我通知你才動」「你在等什麼?」（2026-11-24）
- 「musiclib未轉錄的column是什麼意思 好像都沒用到?」（已做：無人聲顯示破折號）

## 6. 交接程序（自我遞迴）
執行 low-context-long-run 技能，門檻 30%：批次邊界用 get_usage 讀自己的 context；到門檻或額度近 90% 就更新本文件、提交、start_session（initiation user_asked、context fresh、同目錄、use_worktree false 以便繼續在 `desktop-app` 分支）、確認接手者讀過文件並開始第一個待辦。**例外：不封存、不 mark_completed 管理者工作階段。**

## 7. 陷阱
- v568 把台股技能發給了所有人（使用者本來要的是台股網頁專用）。修的時候別只刪技能：要保證台股網頁仍然有。
- 內嵌產生區的改動會被建置蓋掉（`/knowledge-ui` 事件）；publish.sh 在最後的網頁版步驟才會因此中止，桌面版補丁其實已經推出去了，網頁倉庫會留下改到一半的檔案，再發布一次會修正。
- 前景長等待會擋住子工作階段的通知（web-aiweb 完成後約 10 分鐘我才處理）。
- GitHub Pages 對靜態檔快取 10 分鐘：網頁驗證要帶新的查詢參數或強制重新整理。
- `Stop-Process` 用廣泛條件比對行程會被自動模式擋；用 `Get-NetTCPConnection -LocalPort` 查出自己啟動的 PID 再停。
- 我的真桌面版評測是全新資料夾，測不到使用者資料夾裡記著的視窗狀態（例如 `fwin:musiclib` 彈出狀態）；使用者回報「某處不對」時，先懷疑自己漏測了狀態，不是使用者沒更新。
- 評測要量「內容本身」而不只是外框（音樂庫最大化事件）。
