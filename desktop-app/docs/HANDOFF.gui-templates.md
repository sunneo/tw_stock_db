# 交接：圖形介面程式設計範本（GUI 範本線）

> 這是「GUI 範本」這條工作線自己的交接起點頁，每次交接整份覆寫（舊版看 git 歷史）。管理者的總交接在 `docs/HANDOFF.md`，不要改那份。目前是第 2 份（交接 2 的接手者讀這份）。

## 1. 開場提示（接手者收到的原文）

請接續 `desktop-app/docs/HANDOFF.gui-templates.md`：完整讀完（含第 5 節使用者原話與第 4 節工作方式）並照著做。執行 low-context-long-run 技能（門檻 30%）：做第 3 節的下一個待辦；到門檻就把這份文件整份改寫成下一份交接、提交，再啟動自己的接手者（同一個資料夾、不開工作樹、模型 claude-sonnet-5-5、推理強度 medium、標題「GUI 範本 · 交接 N」）。第一則訊息用一行確認你讀過文件、要從哪個待辦開始。使用者原話的核心：「我想要線上ai跟離線ai在創作gui程式的時候有快速引導的範本，涵蓋layout，應用程式行為，配色，佈景主題，快捷鍵等framework與客製化」「如果找不到範本，就ai自己按照使用者需求設計」「在成品完成時，也可以產出各場景的storyboard與gui設計工作室，當使用者微調後，可以儲存為自己的gui設計的範本，並讓範本成為下次ai設計時可參考的案例」。

## 2. 概況

- **目標**：Python 模擬器已接上圖形介面（畫布、聲音、鍵盤滑鼠輸入）。要讓線上 AI 與離線 AI 寫圖形介面程式時，有分領域、逐步切割與詢問的設計範本（版面、應用程式行為、配色、佈景主題、快捷鍵；框架＋客製化），各步驟找範本、最後組合；找不到就依需求自行設計；成品完成時產出各場景分鏡（storyboard）與「圖形介面設計工作室」，使用者微調後可存成自己的範本，成為下次設計的參考案例。
- **領域（使用者列的）**：辦公、文件、遊戲設計、專案設計、投影片軟體、進銷存、美顏拍貼、證件照、MIDI 設計、文字編輯器、網頁設計、影像處理、多媒體編碼解碼與播放。
- **環境**：Windows，專案 `D:\Downloads\videos-嗨投資-desktop-app\desktop-app`，分支 `desktop-app`，與管理者共用這個資料夾（不開工作樹）。本機有 Python 3.10（`python -I`），沒有 `python3`。
- **設計文件**：`desktop-app/DESIGN.gui-templates.md`——第 1 節現況、第 2 節設計（規格格式 2.2、範本檔格式 2.3、檢索 2.4、逐步詢問 2.5、自行設計 2.6、組合與驗收 2.7、分鏡 2.8、工作室與使用者範本 2.9、十三領域 2.10、要補的能力 2.11、目錄 2.12）、第 3 節實作現況與決定記錄。**接手前先讀第 2、3 節。**
- **已完成並提交（分支 `desktop-app`，尚未推送）**：
  - 待辦 1（現況調查）`5b62f7aaf`、待辦 2（設計）`d72241221`。
  - 範本核心 `guitpl_core.js`（`a1d946aaf`）；組合器 `compose_core.js`＋假橋接空跑 `fake_run.py`（`2d7c9997a`）；範本庫載入與一條龍 `guitpl_run.js`＋`data/_common.json`＋`data/text-editor.json`（`e29c56254`）。全部在 `renderer/src/guitpl/`，各有測試檔（`node 檔名.test.js`）。
  - Python 與橋接新能力：`set()`、textarea／checkbox／progress／listbox（`398dd2d09`）；`theme`／`shortcut`／`tone` 貫通橋接→畫面→主機→Python（`5c8b32997`、`f68dbcd85`）；`grid`／`scroll` 容器（`2bdf0cd24`）。
  - 設計文件第 3 節實作現況 `90cb6a144`。
- **待辦 3 未完成的部分**（2.11 清單）：`tabs`、`split`、`menubar`／`menu`、對話框（`message`／`confirm`／`pick_file`，走 `renderer/src/gui/zenity.js` 那條路）、pygame 相容層 `mixer`（最小：`mixer.Sound` 轉呼叫 `tone`）。
- **未發布**：本線的改動都還沒發布（不准執行發布腳本，由管理者決定）。

## 3. 待辦（依序）

1. **待辦 3 收尾（缺的能力）**：依序補 `tabs`（容器，子節點各帶 `title`，或 `tab` 子容器）、`split`、`menubar`／`menu`（項目可帶快捷鍵提示並與 `shortcut` 連動）、對話框（先讀 `zenity.js` 看 `gui.Window` 怎麼接）、pygame `mixer`。每項都要走完整鏈：`gui_bridge.js`（KINDS／CONTAINERS／屬性檢查）→ `gui_render.js` → `gui_host.js`（若有新操作）→ `py_worker.js`（`GUI_OPS`，若有新操作）→ `pybridge/gui.py` → `compose_core.js`（`KIND_METHODS`）→ 各自測試；最後 `node scripts/embed-code-ui.js`、`node build-assistant.js`、`node --check renderer/src/floating-assistant.js`，再提交（含 `renderer/floating-assistant.js`、`renderer/floating-assistant.min.js`、`renderer/src/floating-assistant.js`；`update-manifest.json` 與 `web-lazy/` 是建置副產物，不提交）。做不到的項目寫進設計文件第 3 節「未完成」並繼續下一步，不卡住。
2. **待辦 4：十三個領域的範本**：在 `renderer/src/guitpl/data/` 為其餘十二個領域各建一個檔（仿 `text-editor.json`：`steps` 六步、`actions`、`presets`、至少兩種配色用共用的、一種佈景、一組快捷鍵、一支範例），並在 `scripts/eval/gui_examples/` 放各領域組合出的範例程式；`guitpl_run.test.js` 會自動對每個領域的每個選項跑組合＋空跑。圖像、影音、MIDI 類受限於畫布一幀 200 道指令與圖片大小，要在範本裡誠實標「簡化版預覽」，列入待改善。遊戲領域優先參考 `scripts/eval/gui_examples/breakout.py` 與 `renderer/src/game/game_templates.js`。
3. **待辦 5：接到 AI**：宿主工具 `gui_template_find`／`gui_template_compose`（用 `register_openai_tool`，參考 `DESIGN.extension-points.md`）；線上系統提示加短指引；離線用食譜（`FaRecipe`）或 CoLU 字母選擇題走 `guitpl_core.js` 的 `choiceMenu`／`letterToOption`；找不到領域時的自行設計路徑（2.6，模型填規格 JSON 再交給同一個組合器）。嵌入新模組要改 `scripts/embed-code-ui.js`（來源模組在 `renderer/src/guitpl/`，不要改嵌入後的那份）。
4. **待辦 6：分鏡＋設計工作室＋存範本**：`storyboard_core.js`（2.8）、`studio_gui.py`（用 `gui.Window` 寫，吃自己的狗食）、`user_store.js`（桌面檔案、網頁 `persistentStorage` 兩種後端；使用者範本進 `findDomain` 的 `userSpecs` 加權與參考案例）。
5. **待辦 7：真實桌面版驗證**：照 `reference_real_electron_eval_verification`（評估檔＋獨立 `--user-data-dir`＋換埠，`FA_BROWSER_CONTROL_PORT` 不可用 17923）。寫驗證報告（`scripts/eval/` 一支新的評估檔，驗證主題、快捷鍵、聲音、容器在真畫面上的效果）。做完回報管理者 `local_49f6c57d-8f18-427b-a8f1-7b1d23efc5f5`，由管理者決定發布。

## 4. 工作方式（照抄規則）

- 全程繁體中文回覆與寫文件，**句子裡不要夾英文縮寫或術語**（程式識別字可用）。
- **不要提問、不要停下來等回應；看到別的工作階段在同資料夾工作也不要停手**；歧義自行決定並在回報註明；真的需要決定的傳訊給管理者 `local_49f6c57d-8f18-427b-a8f1-7b1d23efc5f5`，管理者會代決。只有被權限提示擋住才等。
- 使用者列了順序就做到底，不要做一半問「接著做哪個」。
- **改嵌入區塊要改來源模組**：`renderer/src/floating-assistant.js` 裡嵌入的區塊會被 `node scripts/embed-code-ui.js` 覆蓋；改來源後跑 embed、再 `node build-assistant.js`、`node --check`。
- **使用者 build 前會 `git checkout ./`**：做到一半也要先提交。每批改動：通過動到的測試才提交；只 `git add` 自己改的檔案。提交訊息結尾 `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`。
- **可以 push 到 origin desktop-app；不准發布（`scripts/publish.sh`）**，發布由管理者決定。（交接 1 沒有推送；交接 2 在第一個穩定批次後推送一次。）
- 改程式用 Edit／Write 工具，**不要用 shell 內嵌改檔**（交接 1 又犯了一次：node -e 內嵌吃掉跳脫字元，最後改用 sed 單行才收拾）；修補或測試腳本先用 Write 寫成檔再執行。
- 整套核心測試一天只跑一次，平常只跑動到的測試：`node renderer/src/gui/gui_bridge.test.js`、`gui_render.test.js`、`gui_host.test.js`、`py_worker.test.js`、`py_async.test.js`、`js_program.test.js`；`python -I renderer/src/gui/gui_py_test.py`、`gui_pygame_test.py`；`node renderer/src/guitpl/*.test.js`。
- 不准擅自安裝套件、不准刪 `node_modules`、不准掃整台電腦、下載要先問管理者。
- 速度：不要長時間空等、不要長逾時、不要長排程；卡住三分鐘內換做法。
- 「宣稱已建立」要用磁碟檢查（stat／讀檔）驗證；沒驗證的事寫明沒驗證。
- 桌面版能力優先（原生路徑），網頁版當退路；有多少做多少、沒達標寫成待改善。
- 子工作階段模型規則：上層 Opus → 子層 Sonnet medium；上層 Sonnet medium → 子層 Haiku。這條線的工作者本身是 Sonnet medium，若要再開子工作階段用 Haiku。

## 5. 使用者原話

- 2026-11-14：「我們的python emulator有接gui，含canvas，聲音，鍵盤滑鼠輸入，我想要線上ai跟離線ai在創作gui程式的時候有快速引導的範本，涵蓋layout，應用程式行為，配色，佈景主題，快捷鍵等framework與客製化，可以涵蓋我們已知的ai範圍，如辦公，文件，遊戲設計，專案設計，投影片軟體設計，進銷存軟體，美顏拍貼軟體，證件照軟體，midi設計軟體，文字編輯器，網頁設計軟體，影像處理軟體，多媒體編碼解碼與播放。就像是設計上也具備domain分類，逐步切割與詢問，從各個步驟找到設計範本，最後結合。如果找不到範本，就ai自己按照使用者需求設計，建議gui程式可以做成：在成品完成時，也可以產出各場景的storyboard與gui設計工作室，當使用者微調後，可以儲存為自己的gui設計的範本，並讓範本成為下次ai設計時可參考的案例」
- 2026-11-14：「hint：我們的原則是上層領導的用opus時，subsession用sonnet medium,上層使用sonnet medium，subsession就用haiku」
- 2026-11-13：「這種就是個問題，我已經要求不要來回詢問了」
- 2026-11-14（整條線的最高目標，設計時照它取捨；詳見 `DESIGN.gui-templates.md` 設計原則一節）：「我的理想是把概念上的「what you think is what you build」「gui應用程式就像自來水一樣，隨想隨生」」
- 2026-11-14：「請以今天本週重置前可以有成果為目標，有多少範本填入多少」
- 2026-11-14：「重置後就不要繼續，有完成的就commit push publish」（這條線在 2026-11-14 15:00 台灣時間額度重置時結束，不再交接）
- 2026-11-14：「我會偏好建立一個可以涵蓋這範圍的framework，可能用jsonl或yaml來定義範本，客製化區域可以是其他範本檔案，範本描述檔案涵蓋美感跟版面與storyboard，然後一個pipeline可以做個編譯轉出python，或者python本身就可以載入那個storyboard並執行，被範圍超出的客製化可以直接變成foreign call一樣，是一個python檔案的參考跟呼叫，甚至所有的範本的核心都是參考python檔案與entry point, function」
- 2026-11-14：「我希望最核心的元件跟描述都是一個jsonl對一個python，達到最高的範本化與客製化」
- 2026-11-14：「建議，framework程式這個要優先出，接著大量填範本」
- 2026-11-14：「所有的設計都要可以在python emulator達成，所以連套件相依性都是描述在每個範本檔裡面」

## 6. 交接程序（自我遞迴）

執行 low-context-long-run 技能，門檻 30%：每完成並提交一批就用 `mcp__ccd_session_mgmt__get_usage` 看自己的上下文百分比；到門檻（或額度近 90%）就：完成並提交手上這批 → 整份改寫本文件（七節順序固定，原話區只追加不改寫）→ 提交（訊息寫「交接」）→ 用 `start_session`（initiation "user_asked"、context "fresh"、use_worktree false、model "claude-sonnet-5-5"、effort "medium"、標題「GUI 範本 · 交接 N」）啟動接手者，提示用第 1 節 → 等接手者確認讀過並開始 → 才標記完成並封存自己。待辦全做完且驗證過就不再交接，改向管理者回報。**管理者工作階段 `local_49f6c57d-…` 不封存、不屬於這條鏈。**

## 7. 陷阱

- 工作目錄是 CRLF（core.autocrlf=true），測試正規式裡的 `\n` 要寫 `\r?\n`；提交時的「LF will be replaced by CRLF」警告是正常的。
- 這台 Node 很舊（v16.15），沒有全域 `fetch`；需要網路檢查用 curl。
- Windows 管道的 Python 標準輸出不是 UTF-8：從 node 呼叫 Python 並讀 JSON 時，Python 端要印純 ASCII（`json.dumps` 預設即可，別加 `ensure_ascii=False`）。
- `gui.py` 的 `wait()` 只回傳 click、shortcut、close；input／change／select／toggle／cell 被吸收進 `value()`。要對這些事件做動作，迴圈必須用 `poll()`（組合器已自動判斷）。視窗被使用者關掉後 `w.close()` 不再送關閉操作。
- `gui_host.js` 的 `show()` 每次 add／set／theme／shortcut 都會整個重建視窗，並用整段 `style.cssText` 覆蓋視窗樣式，所以主題要在那之後再套（已處理）。新增會改視窗外觀的操作時要記得這點。
- 原始碼檔案裡不小心貼進字面的 U+2028／U+2029 會讓 JavaScript 正規式壞掉；Python 字串用 `JSON.stringify` 即可，不必處理。
- `git status` 常看到 `renderer/update-manifest.json`、`web-lazy/chunks/*.js`、`wiki/` 的變動：是建置副產物或別人的檔案，不要提交。
- 本機 `settings.json` 設的自動壓縮 50% 目前看起來沒生效，所以要自己照門檻交接，不要等自動壓縮。
- 每次補橋接能力都要完整走鏈（見待辦 1），漏掉 `py_worker.js` 的 `GUI_OPS` 會讓新操作在 Python 端被拒（`沒有這個 GUI 操作`）。
