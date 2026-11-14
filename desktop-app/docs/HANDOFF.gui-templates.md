# 交接：圖形介面程式設計範本（GUI 範本線）

> 這是「GUI 範本」這條工作線自己的交接起點頁，每次交接整份覆寫（舊版看 git 歷史）。管理者的總交接在 `docs/HANDOFF.md`，不要改那份。

## 1. 開場提示（接手者收到的原文）

請接續 `desktop-app/docs/HANDOFF.gui-templates.md`：完整讀完（含第 5 節使用者原話與第 4 節工作方式）並照著做。執行 low-context-long-run 技能（門檻 30%）：做第 3 節的下一個待辦；到門檻就把這份文件整份改寫成下一份交接、提交，再啟動自己的接手者（同一個資料夾、不開工作樹、模型 claude-sonnet-5-5、推理強度 medium、標題「GUI 範本 · 交接 N」）。第一則訊息用一行確認你讀過文件、要從哪個待辦開始。使用者原話的核心：「我想要線上ai跟離線ai在創作gui程式的時候有快速引導的範本，涵蓋layout，應用程式行為，配色，佈景主題，快捷鍵等framework與客製化」「如果找不到範本，就ai自己按照使用者需求設計」「在成品完成時，也可以產出各場景的storyboard與gui設計工作室，當使用者微調後，可以儲存為自己的gui設計的範本，並讓範本成為下次ai設計時可參考的案例」。

## 2. 概況

- **目標**：Python 模擬器已接上圖形介面（畫布、聲音、鍵盤滑鼠輸入）。要讓線上 AI 與離線 AI 寫圖形介面程式時，有分領域、逐步切割與詢問的設計範本（版面、應用程式行為、配色、佈景主題、快捷鍵；框架＋客製化），各步驟找範本、最後組合；找不到就依需求自行設計；成品完成時產出各場景分鏡（storyboard）與「圖形介面設計工作室」，使用者微調後可存成自己的範本，成為下次設計的參考案例。
- **領域（使用者列的）**：辦公、文件、遊戲設計、專案設計、投影片軟體、進銷存、美顏拍貼、證件照、MIDI 設計、文字編輯器、網頁設計、影像處理、多媒體編碼解碼與播放。
- **環境**：Windows，專案 `D:\Downloads\videos-嗨投資-desktop-app\desktop-app`，分支 `desktop-app`，與管理者共用這個資料夾（不開工作樹）。
- **已知入口（2026-11-14 管理者初查，未細讀）**：
  - Python 端：`renderer/src/pybridge/gui.py`（161 行；`Window` 有 label、button、entry、row、column、expander、editor、table、multilist、canvas、draw、image、poll、value、wait、close）。
  - JS 端：`renderer/src/gui/`（gui_bridge.js、gui_host.js、gui_render.js、py_worker.js、py_async.js、js_program.js、zenity.js，各有測試）；`gui_pygame_test.py` 表示有 pygame 相容層，聲音的實作位置還沒查。
  - 設計紀錄：`DESIGN.gui-bridge-delta-for-redmine.md`、`DESIGN.edit-game.md`；實機評估檔 `scripts/eval/gui_*.eval.js`、範例 `scripts/eval/gui_examples/`（breakout.py、map_viewer）。
  - 可能可重用的範本／分領域機制（要查）：`DESIGN.fn-template.md`、`DESIGN.offline-recipes.md`、`renderer/src/deck/deck_topics.json`（簡報主題欄位表）、`renderer/src/skin/`（佈景）、`DESIGN.extension-points.md`（FaExt 擴充點）、`DESIGN.colu.md`（CoLU 字母選擇題）、`DESIGN.uml-*`／`renderer/src/uml/`（UML design 逐層切割）、`renderer/src/studio/`。
- **已完成**：無（本文件是第一份）。尚未有任何提交。

## 3. 待辦（依序）

1. **現況調查（唯讀）**→ 寫 `DESIGN.gui-templates.md` 第 1 節「現況」：gui.py 能做什麼／缺什麼（聲音、快捷鍵、主題色、選單、對話框？）；線上與離線 AI 目前怎麼寫圖形介面程式（系統提示、`terminal_run`、範例）；上面列的可重用機制各自怎麼存範本、怎麼被檢索。每項附檔案:行號。提交。
2. **設計**→ 同一份文件第 2 節起：範本資料格式（領域 → 步驟：版面／行為／配色／佈景／快捷鍵；每步驟的範本片段與組合規則）；逐步詢問流程（線上直接問、離線用 CoLU 字母選擇題）；找不到範本時的自行設計路徑；分鏡輸出格式；設計工作室（微調、存成使用者範本、範本庫檢索成為下次案例）。歧義自己決定並在文件註明。提交。
3. **框架實作**：範本資料檔＋組合器＋檢索＋單元測試（來源放 `renderer/src/` 新資料夾，例如 `guitpl/`）。若 gui.py 缺第 1 步查到的必要能力（例如快捷鍵、主題色），補上並加測試。
4. **十三個領域的範本**：每領域至少一套完整範本（版面、行為、配色、佈景、快捷鍵），並各有一支能在模擬器跑起來的範例程式；加測試確認組合結果可執行。
5. **接到 AI**：線上（系統提示／工具說明）與離線（食譜／CoLU 路由）都能用範本逐步引導；找不到範本時走自行設計。
6. **分鏡＋設計工作室＋存範本**：成品完成時產生各場景分鏡；工作室可微調並存成使用者範本；使用者範本進檢索。
7. **真實桌面版驗證**：照 `reference_real_electron_eval_verification`（評估檔＋獨立 `--user-data-dir`＋換埠，`FA_BROWSER_CONTROL_PORT` 不可用 17923）。寫驗證報告。做完回報管理者，由管理者決定發布。

## 4. 工作方式（照抄規則）

- 全程繁體中文回覆與寫文件，**句子裡不要夾英文縮寫或術語**（程式識別字可用）。
- **不要提問、不要停下來等回應；看到別的工作階段在同資料夾工作也不要停手**；歧義自行決定並在回報註明；真的需要決定的傳訊給管理者 `local_49f6c57d-8f18-427b-a8f1-7b1d23efc5f5`，管理者會代決。只有被權限提示擋住才等。
- 使用者列了順序就做到底，不要做一半問「接著做哪個」。
- **改嵌入區塊要改來源模組**：`renderer/src/floating-assistant.js` 裡嵌入的區塊會被 `node scripts/embed-code-ui.js` 覆蓋；改來源後跑 embed、再 `node build-assistant.js`、`node --check`。
- **使用者 build 前會 `git checkout ./`**：做到一半也要先提交。每批改動：通過動到的測試才提交；只 `git add` 自己改的檔案。提交訊息結尾 `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`。
- **可以 push 到 origin desktop-app；不准發布（`scripts/publish.sh`）**，發布由管理者決定。
- 改程式用 Edit／Write 工具，不要用 shell 內嵌改檔；修補或測試腳本先用 Write 寫成檔再執行。
- 整套核心測試一天只跑一次，平常只跑動到的測試。
- 不准擅自安裝套件、不准刪 `node_modules`、不准掃整台電腦、下載要先問管理者。
- 速度：不要長時間空等、不要長逾時、不要長排程；卡住三分鐘內換做法。
- 「宣稱已建立」要用磁碟檢查（stat／讀檔）驗證；沒驗證的事寫明沒驗證。
- 桌面版能力優先（原生路徑），網頁版當退路；有多少做多少、沒達標寫成待改善。
- 子工作階段模型規則：上層 Opus → 子層 Sonnet medium；上層 Sonnet medium → 子層 Haiku。這條線的工作者本身是 Sonnet medium，若要再開子工作階段用 Haiku。

## 5. 使用者原話

- 2026-11-14：「我們的python emulator有接gui，含canvas，聲音，鍵盤滑鼠輸入，我想要線上ai跟離線ai在創作gui程式的時候有快速引導的範本，涵蓋layout，應用程式行為，配色，佈景主題，快捷鍵等framework與客製化，可以涵蓋我們已知的ai範圍，如辦公，文件，遊戲設計，專案設計，投影片軟體設計，進銷存軟體，美顏拍貼軟體，證件照軟體，midi設計軟體，文字編輯器，網頁設計軟體，影像處理軟體，多媒體編碼解碼與播放。就像是設計上也具備domain分類，逐步切割與詢問，從各個步驟找到設計範本，最後結合。如果找不到範本，就ai自己按照使用者需求設計，建議gui程式可以做成：在成品完成時，也可以產出各場景的storyboard與gui設計工作室，當使用者微調後，可以儲存為自己的gui設計的範本，並讓範本成為下次ai設計時可參考的案例」
- 2026-11-14：「hint：我們的原則是上層領導的用opus時，subsession用sonnet medium,上層使用sonnet medium，subsession就用haiku」
- 2026-11-13：「這種就是個問題，我已經要求不要來回詢問了」

## 6. 交接程序（自我遞迴）

執行 low-context-long-run 技能，門檻 30%：每完成並提交一批就用 `mcp__ccd_session_mgmt__get_usage` 看自己的上下文百分比；到門檻（或額度近 90%）就：完成並提交手上這批 → 整份改寫本文件（七節順序固定，原話區只追加不改寫）→ 提交（訊息寫「交接」）→ 用 `start_session`（initiation "user_asked"、context "fresh"、use_worktree false、model "claude-sonnet-5-5"、effort "medium"）啟動接手者，提示用第 1 節 → 等接手者確認讀過並開始 → 才標記完成並封存自己。待辦全做完且驗證過就不再交接，改向管理者回報。**管理者工作階段 `local_49f6c57d-…` 不封存、不屬於這條鏈。**

## 7. 陷阱

- 工作目錄是 CRLF（core.autocrlf=true），測試正規式裡的 `\n` 要寫 `\r?\n`。
- 這台 Node 很舊，沒有全域 `fetch`；需要網路檢查用 curl。
- `git status` 中途看到 `web-lazy/` 檔案被刪，多半是建置進行中，不是真的刪除。
- 本機 `settings.json` 設的自動壓縮 50% 目前看起來沒生效（顯示 97%），所以要自己照門檻交接，不要等自動壓縮。
