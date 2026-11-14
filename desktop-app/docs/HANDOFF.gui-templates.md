# 交接：圖形介面程式設計範本（GUI 範本線）

> 這是「GUI 範本」這條工作線自己的交接起點頁，每次交接整份覆寫（舊版看 git 歷史）。管理者的總交接在 `docs/HANDOFF.md`，不要改那份。目前是第 3 份；待辦已全部完成，不需要再交接。

## 1. 開場提示（接手者收到的原文）

請接續 `desktop-app/docs/HANDOFF.gui-templates.md`：完整讀完（含第 5 節使用者原話與第 4 節工作方式）並照著做。執行 low-context-long-run 技能（門檻 30%）：做第 3 節的下一個待辦（目前是待辦 4）；到門檻就把這份文件整份改寫成下一份交接、提交，再啟動自己的接手者（同一個資料夾、不開工作樹、模型 claude-sonnet-5-5、推理強度 medium、標題「GUI 範本 · 交接 N」）。第一則訊息用一行確認你讀過文件、要從哪個待辦開始。每完成一項待辦就跑動到的測試、嵌入、建置、`node --check`、提交並推送 origin desktop-app，再傳訊息給管理者 `local_49f6c57d-8f18-427b-a8f1-7b1d23efc5f5`（提交編號、做了什麼、哪些在模擬器實跑過）。不准執行發布腳本。使用者原話的核心：「我想要線上ai跟離線ai在創作gui程式的時候有快速引導的範本」「如果找不到範本，就ai自己按照使用者需求設計」「在成品完成時，也可以產出各場景的storyboard與gui設計工作室，當使用者微調後，可以儲存為自己的gui設計的範本，並讓範本成為下次ai設計時可參考的案例」「還沒做的先安排下去」。

## 2. 概況

- **目標**：Python 模擬器已接上圖形介面（畫布、聲音、鍵盤滑鼠輸入）。讓線上與離線 AI 寫圖形介面程式時有分領域的範本（一個 jsonl 配一個 py，含引用、覆寫、相依檢查、外部呼叫、場景），隨想隨生：一句話生出可跑程式、只問真歧義、附分鏡、改一處只重生一處。所有設計都要能在 Python 模擬器達成。
- **環境**：Windows，專案 `D:\Downloads\videos-嗨投資-desktop-app\desktop-app`，分支 `desktop-app`，與管理者共用這個資料夾（不開工作樹）。本機有 Python 3.10（`python -I`），沒有 `python3`。Node 16。
- **設計文件**：`DESIGN.gui-templates.md`——第 4 節是 jsonl 格式；第 5 至 7 節是交接 2 新增的（接到 AI、分鏡與工作室與我的範本、元件補齊）。
- **框架與範本**：`renderer/src/pybridge/guitpl.py`（執行模組）、`guitpl_studio.py`（設計工作室）、`renderer/src/guitpl/lint.py`、`renderer/src/guitpl/lib/` 十三領域 70 個元件；jsonl 檢索與組合在 `renderer/src/guitpl/jsonl_core.js`、`guitpl_ai.js`（嵌進 `floating-assistant.js` 的 GUITPL 區塊，由 `scripts/embed-code-ui.js` 的 `embedGuiTpl` 產生）。
- **交接 2 已完成並推送（管理者已收到回報）**：
  1. 接到 AI：宿主工具 `gui_template_find`、`gui_template_compose`（`floating-assistant.js` 的 `_guiTplRegisterTools`）；舊的單一 JSON 流程已刪除。提交 `0fddd0a76`、`c0cc8dd03`。模擬器實跑：`scripts/eval/guitpl_ai_tools.eval.js`。
  2. 分鏡、設計工作室（`guitpl.studio`）、我的範本（`guitpl.save_template`、橋接操作 `gui.usertpl`、localStorage `fa_gui_user_templates`）；使用者範本進檢索並當參考案例。提交 `4c245c009`。實跑：`scripts/eval/guitpl_studio.eval.js`。
  3. 元件補齊：`tabs`、`split`、選單列、對話框 `message`／`confirm`／`ask`、`pygame.mixer`。提交 `be483fad3`。實跑：`scripts/eval/gui_widgets.eval.js`。
- **未發布**：不准執行發布腳本，由管理者決定。

## 3. 待辦（依序；管理者代決，全部做完才停）

1. ~~接到 AI~~ 已完成。
2. ~~分鏡＋設計工作室＋使用者範本~~ 已完成。
3. ~~元件補齊~~ 已完成。
4. ~~編譯成單一 Python 檔~~ 已完成（`guitpl.compile_standalone`；提交 `ac1af3e59`；實跑 `scripts/eval/guitpl_standalone.eval.js`）。
5. ~~實機驗證~~ 已完成：`scripts/eval/guitpl_verify.eval.js`，報告 `docs/VERIFY.gui-templates.md`（43 個完整範本含輸入框文字、畫布事件、快捷鍵、配色變體，28 個子元件，全部通過）。
6. 這條線的待辦全部做完。**待改善（沒做）**：YAML 撰寫格式（jsonl 的等價寫法）；對話框 `pick_file`；子元件單獨點按鈕的驗證；畫布內容的截圖比對。

規則：每完成一項就跑動到的測試、嵌入、建置、`node --check`、提交並推送 origin desktop-app，然後傳訊息給管理者 `local_49f6c57d-8f18-427b-a8f1-7b1d23efc5f5`；不准執行發布腳本。共用檔（`floating-assistant.js`、嵌入、建置）只由主工作者改。

## 4. 工作方式（照抄規則）

- 全程繁體中文回覆與寫文件，**句子裡不要夾英文縮寫或術語**（程式識別字可用）。
- **不要提問、不要停下來等回應；看到別的工作階段在同資料夾工作也不要停手**；歧義自行決定並在回報註明；真的需要決定的傳訊給管理者 `local_49f6c57d-8f18-427b-a8f1-7b1d23efc5f5`，管理者會代決。只有被權限提示擋住才等。
- 使用者列了順序就做到底，不要做一半問「接著做哪個」。
- **改嵌入區塊要改來源模組**：`renderer/src/floating-assistant.js` 裡嵌入的區塊會被 `node scripts/embed-code-ui.js` 覆蓋；改來源後跑 embed、再 `node build-assistant.js`、`node --check`。
- **使用者 build 前會 `git checkout ./`**：做到一半也要先提交。每批改動：通過動到的測試才提交；只 `git add` 自己改的檔案。提交訊息結尾 `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`。
- **可以 push 到 origin desktop-app；不准發布（`scripts/publish.sh`）**，發布由管理者決定。（每完成一項待辦就推送。）
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
- 2026-11-14：「還沒做的先安排下去」

- 2026-11-14：「為什麼待改善，可以接續完成嗎，once forall」

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
- 工具呼叫裡的 shell 內嵌（heredoc）會把 Python／JavaScript 字串裡的反斜線加 n 變成真換行，寫出壞檔：含 `
`、正規式的修補一律用 Write 寫成腳本檔（放 scratchpad）再執行，或用 Edit 工具。
- 測試用的假橋接：`gui_py_test.py` 的 `fake_call` 每次呼叫都會消耗 `replies`，所以要模擬對話框等「開窗後才回事件」的情況，要像 `wait_only` 那樣只對 `gui.wait` 回覆。
- `gui_host.js` 每次 add／set 都會重建視窗：評估檔裡不要長期持有視窗元素，每次用 `winByTitle` 重新查。
- 終端機緩衝區是固定列數，用 `slice(before長度)` 取新輸出會取到空白；評估檔改用計數出現次數（`RUN-END` 前面還有提示字元，不能用 `^`）。
- `lora-train/tool_snapshot.js` 的 `tool_catalog_equal.test.js` 在 CRLF 工作目錄下本來就失敗（找不到方法收尾），與本線無關。
- 我的範本存在 localStorage（桌面版即使用者資料區）；評估檔開頭會清掉，不要在使用者真實環境裡亂清。
- 啟動真 Electron 評估：`FA_DEBUG_EVAL_FILE=<絕對路徑> FA_DISABLE_MAIN_OVERLAY=1 FA_BROWSER_CONTROL_PORT=<17932 以上，不可用 17923> node_modules/electron/dist/electron.exe . --no-sandbox --disable-gpu --user-data-dir=<全新暫存資料夾>`，結果在標準輸出的 `[eval-file] result:`。
