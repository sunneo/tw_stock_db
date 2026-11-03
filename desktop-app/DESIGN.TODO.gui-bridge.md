# DESIGN.TODO.gui-bridge — 終端機與技能的 GUI 橋接（桌面版）

## 1. 開場提示（貼給接手的工作階段；這段也是 start_session 的 prompt）

Continue from the handoff document at desktop-app/DESIGN.TODO.gui-bridge.md (repo root D:\Downloads\videos-嗨投資-desktop-app, branch desktop-app). Read it fully, including the verbatim user words and the working style, and follow them. Run the low-context-long-run skill: do the next todo item, and when your context reaches 30%, write the next handoff and start your own successor. Quote the user verbatim: 「請實際跑程式驗證missile-command, 打磚塊, map-viewer，resizable, maximize 視窗化」 and 「麻煩打開來驗證那該死的skill gui 橋接 用該死的missile command遊戲 如果找不到，麻煩寫一套」 and 「馬上implement!!!」. Reply to the user in Traditional Chinese only, with no English abbreviations inside Chinese sentences. Do not push and do not run publish.sh (the manager publishes). First message: one line saying you read the document and which todo item you start.

## 2. 總覽（Overview）

- 目標：讓桌面版（FloatingAssistant，`desktop-app/`）的終端機與技能裡的程式，能開視窗、畫 canvas、收點擊／按鍵／滑鼠事件。順序：shell（zenity、`gui wait`、`@gui` 行）→ `ask-ai-chat` 管線 → Python（gui.py、pygame 子集）→ JavaScript（node，sandbox iframe 不加 allow-same-origin）→ 技能可宣告 GUI。SDL 在 pygame 之後；GTK#、XAML、QML、WinForms、WinAPI 不做（只留紀錄）。
- 設計來源：`C:\Users\sunneo\Downloads\redmine_ai_chat\DESIGN.skill-gui-bridge.md` 與 `HANDOFF.skill-gui-bridge.md`；Redmine 外掛的實作可直接移植（使用者 2026-11-03 明確要求沿用，不要重新發明協定）：`assets\javascripts\ai_chat_gui_*.js`、`ai_chat_zenity.js`、`ai_chat_js_program.js`、`assets\pybridge\gui.py`、`pygame.py`、`examples\missile_command.py`（與四張貼圖 `missile_*.png`）、`examples\map_viewer.py`、`test\gui_bridge\*`。Redmine 的 Rails、ActiveJob 輪詢不搬。
- 分支 `desktop-app`。**不 push、不跑 publish.sh**（管理層發布）。其他工作階段也會在這個分支提交（例如 `abd4526f` MIDI 編輯器），不要 reset、stash、切分支。

### 已提交（本分支，由新到舊）

| commit | 內容 | 驗證 |
|---|---|---|
| 929d4de7 | 待辦 5 第二批：視窗的 × 送 close 事件給程式（之前直接關、遊戲收不到事件，之後 draw 報 window is not open）；Worker 結束時把 /work 的檔案寫回終端機；gui_host.test.js 新增 × 情境 | 實機 missile_command.py：開始→遊戲視窗 400×300 畫出畫面，輸入後改變 771 像素（對照組不操作 75 像素），按 × 後 exit 0；gui_host.test.js 26 項 |
| 9ec1871c | 待辦 5 第一批：`fa_bridge.call` 網頁版改 `run_sync`；`_pyBridgeDispatch` 加 gui.* 分支（`_pyBridgeGui`）；含 import gui／pygame 的 python 走 module Worker（`_terminalTryPythonAsync`、`_terminalRunPythonWorker`，模組 `renderer/src/gui/py_worker.js`，嵌入 GUIPYWORKER／GUIPYASYNC）；視窗被點擊後加 `ai-chat-wheel-on`（桌面版沒有設定，滑鼠事件會被 gui_render 丟掉） | 實機 gui.py 範例：開窗、填 Alice、按 OK，終端機印出 `answer: Alice`、`done`，exit 0；不含 gui 的 python 照常（回歸：plain 2）；py_worker.test.js 24 項 |
| efd9bbc8 | （另一個工作階段的 MIDI 提交，見第 9 節的說明：它夾帶了我的 fa_bridge.py、py_worker.js 與產物）| 見第 9 節 |
| d4a8255b | `main.js`：`FA_DISABLE_MAIN_OVERLAY=1` 同時停用渲染頁的 live-patch 覆蓋（`computeEffectiveLocalManifest` 早退，`index.html` 改用安裝包內建 `renderer/`） | `node --check` 通過；實機效果未確認 |
| 2a1b5536 | 終端機接上 zenity：`_faGuiModule`、`_terminalGuiHost`、`_terminalZenity`；`zenity` 加入 `JS_INTERCEPTED_WITH_CAPTURE`、`TERMINAL_VIRTUAL_SCRIPT_COMMANDS`；有 shell 運算子時走 shell | 四組 node 測試通過；`node build-assistant.js` 成功，四個 GUI 常數進入 `renderer/floating-assistant.js` 與 `.min.js`；實機未驗證 |
| ef2fe842 | 視窗主機 `renderer/src/gui/gui_host.js`（開/關/重繪/事件佇列/上限 50/frame 合併/mouse move 合併/wait） | `gui_host.test.js` 21 項通過 |
| 2d0846a6 | Python 端 `renderer/src/pybridge/gui.py`、`pygame.py` 與 `gui_py_test.py`、`gui_pygame_test.py` | 本機 Python 3.10 通過（10 呼叫；pygame 子集） |
| f5fb8f12 | zenity 純函式 `renderer/src/gui/zenity.js` ＋測試，嵌入 GUIZENITY | `zenity.test.js` 56 項通過 |
| 0d1570d2 | DOM 繪製器 `renderer/src/gui/gui_render.js` ＋測試，嵌入 GUIRENDER | `gui_render.test.js` 40 項通過（fake DOM） |
| 739164eb | 協定核心 `renderer/src/gui/gui_bridge.js` 嵌入 GUIBRIDGE；`build-web-lazy.js` EXCLUDE 加入 | 嵌入字串可 `new Function` 載入並 apply |
| 4d6a197c | 協定核心 `gui_bridge.js` ＋ `gui_bridge.test.js` | 69 項通過 |

- 嵌入機制：BEGIN/END 區塊 → `scripts/embed-code-ui.js` 的 `embed(...)` 一行 → `build-web-lazy.js` 的 EXCLUDE。目前的區塊：GUIBRIDGE、GUIRENDER、GUIZENITY、GUIHOST、PYBRIDGE（`FA_PYBRIDGE_FILES` 會自動帶入 `renderer/src/pybridge/*.py`）。
- 打包與熱更新：`renderer/src/**` 不進安裝包（`package.json` build.files 排除），所以模組一律嵌進 `floating-assistant.js`，由 `build-assistant.js` 產生 `renderer/floating-assistant.js`、`.min.js`，這兩個檔在 `renderer/**/*` 與熱更新允許清單內。`.py` 也不是獨立檔案，而是字串。

### 本機環境（已確認）

- Electron 二進位檔：已從本機快取解壓到 `node_modules/electron/dist`（來源 `C:\Users\sunneo\AppData\Local\electron\Cache\electron-v44.4.0-win32-x64.zip`，158,278,765 bytes，與預期一致）。`node_modules/electron/path.txt` 內容 `electron.exe`。不要再跑 `npm install` 或 `node install.js`（Node v16.15.0 會因 ESM 報錯）。
- 啟動方式（已可啟動，視窗內容仍空白，見待辦 1）：
  ```
  $env:FA_BROWSER_CONTROL_PORT = "17924"; $env:FA_DISABLE_MAIN_OVERLAY = "1"
  Start-Process -FilePath ".\node_modules\electron\dist\electron.exe" -ArgumentList "."
  ```
- 測試用控制埠 17924（不要用預設 17923）。

## 2b. 驗證方法（實機，2026-11-03 管理層指定）

- 用真的 Electron 加評估檔，不截圖、不靠肉眼找視窗。範例檔：`scripts/eval/gui_bridge.eval.js`。
- 啟動（每次用全新的暫存資料夾，不碰安裝版資料；埠不用 17923）：
  ```
  FA_DISABLE_MAIN_OVERLAY=1 FA_DEBUG_EVAL_FILE=<評估檔絕對路徑> FA_BROWSER_CONTROL_PORT=17931 electron.exe <desktop-app路徑> --no-sandbox --disable-gpu --user-data-dir=<全新暫存資料夾>
  ```
- 一定要加 `FA_DISABLE_MAIN_OVERLAY=1`。沒加的那次執行會下載遠端版本（輸出「要更新 2 個檔案」），驗證的就不是工作目錄的實作。加了之後評估檔的 `loaded.scripts` 指向工作目錄的 `renderer/floating-assistant.js`，輸出仍會有一行「檢查更新」，但沒有套用，全新資料目錄裡也不會產生 `live-patch`。
- 啟動前先跑 `node scripts/embed-code-ui.js` 與 `node build-assistant.js`，讓 `renderer/floating-assistant.js` 與原始碼同步。這兩個產物是追蹤中的檔案，要不要 commit 屬於發布流程，不要混進功能 commit。
- 結果看標準輸出的 `[eval-file] result` 或 `[eval-file] error` 行；跑完程序會自己結束（逾時用 `timeout` 包住）。
- 評估檔在渲染頁裡執行，可用 `window.fa`、`fa._createTerminalForAI`、`fa._resolveTerminalSession`、`fa._runTerminalCommand` 與 DOM（視窗主機的節點是 `.gui-window[data-window]`，輸入框 `.gui-entry`，按鈕 `.gui-button`）。
- 「模擬使用者」是在 DOM 上填值、派發 input 事件、呼叫按鈕的 click，不是作業系統層級的滑鼠輸入。
- 已驗證過的：zenity `--entry --text=hi` 在真 Electron 裡出現視窗、按 OK 後答案 Alice 印在終端機、視窗關閉、指令結束（2026-11-03，`gui_bridge.eval.js`）。
- 未驗證：視窗在螢幕上的實際外觀（沒有做視覺檢查）、zenity 的退出碼（評估檔沒有讀取）、取消按鈕、其他 GUI 指令。

## 3. 待辦（依序；下一項最先）

1. **【已解決：不重現】找出實機視窗空白的原因。**（2026-11-03 結論：用獨立資料夾啟動後，渲染頁 DOM 有內容，topbar 1904×38、app 1904×948，視窗在主螢幕 (0,0)–(1920,1040) 可見，截圖確認聊天介面正常。之前看到的空白未能重現，原因未知。） 症狀：`electron.exe .` 啟動後，主視窗標題是 `FloatingAssistant`，程序回應正常，但螢幕上那塊區域（DISPLAY1，0,0–1920,1040）只看到桌布，沒有內容。已排除：live-patch 覆蓋（d4a8255b 之後渲染頁用內建檔）。下一步：
   - 用 `FA_DEBUG_CONSOLE`（見 `main.js` 約 1844 行）或 `FA_DEBUG_EVAL_FILE`（約 1940 行）把渲染頁的 console 錯誤寫到檔案，讀 `$env:TEMP\fa_electron_*.log`。
   - 確認 `renderer/index.html` 與 `renderer/floating-assistant.js` 的載入路徑（`resolveIndexHtmlPath`，約 1527 行）。
   - 預期結果：看得到渲染錯誤，或確認頁面有內容但視窗位置／透明度問題。找到原因後才繼續。
2. **zenity 實機驗證**（需要的指令：在終端機輸入 `zenity --entry --text=hi`，截圖確認對話框出現，輸入後答案印在終端機）。通過後回報「已提交，可發布，commit <hash>」（若有修正）。
3. **`ask-ai-chat` 管線**：stdin 讀入、stdout 輸出、可接管線（`cat log.txt | ask-ai-chat "摘要"`、`ask-ai-chat "..." | grep ...`）。桌面版現有的是 `ask-floating-ai-assistant`（`_terminalAskAI`，約 86572 行，不讀 stdin，整段輸出）。預設做法：新增 `ask-ai-chat` 別名，沿用 `_runSubAgentTask` 現有模型呼叫；做不到串流就整段輸出並說明限制。**命名問題待使用者確認**（見 4）。
4. **`gui wait` 與 `@gui` 行**（shell 端）：`gui wait <window> [VAR]`（同 sleep 的非同步虛擬指令，上限 300 秒，超時 exit 124）；程式輸出裡以 `@gui ` 開頭的行交給 host 套用、不顯示。
5. **Python 接線**（2026-11-03 管理層決定：只有 import gui／pygame 的程式走非同步，既有 `python` 行為不動；Python 在 worker 跑，gui.wait/poll 透過橋接回呼頁面，頁面用 Promise 等事件，worker 端阻塞等回覆）。
   - 進度：已完成 `renderer/src/gui/py_async.js`（判斷要不要走非同步，29 項 node 測試通過，commit a3698122）。
   - 程式路徑（已查明，見共用筆記資料夾的 python-gui-wiring-findings.md）：`python` 指令 → `SANDBOX_COMMAND_REGISTRY`（`kind:'pyodide'`）→ `_runPythonBuiltin` → `_runPyodideScriptSync`（同步）。`_pyBridgeDispatch` 沒有 `gui.*` 分支。`_pyBridgeEnabled()` 只在 `_pyBridgeDepth>0` 時為真（目前只有技能網域與 rig 流程會加）。
   - 注意：pyodide 只能從 jsDelivr 這類正確送出 JS mimetype 的來源載入（見 floating-assistant.js 約 48984 行的註解），內部用動態 `import()`。在 Blob worker 裡能否載入，要先實測。
   - **實測結果（2026-11-03，`scripts/eval/py_worker_probe.eval.js`，真 Electron）**：
     - Pyodide 在 **module worker** 裡能載入：`new Worker(blobUrl, {type:'module'})`，內部 `await import(base + 'pyodide.mjs')`，`loadPyodide({indexURL: base})`，`1+1` 得 2。classic worker（importScripts）不行，回報「Classic web workers are not supported」。
     - 頁面 `crossOriginIsolated` 是 false，所以 SharedArrayBuffer 不能用，`Atomics.wait` 不能用。
     - **JSPI 可用**（`WebAssembly.Suspending` 存在）。做法：worker 裡 `self.slow_js = async (x) => …`（要掛在 `self` 上，`py.globals.set` 的值 `from js import` 拿不到）；Python 用 `pyodide.ffi.run_sync(slow_js(21))` 同步取值；整支程式要包在一個 `def` 裡，用 `py.globals.get('go').callPromising()` 呼叫（直接 `runPython` 的入口會報「Cannot stack switch…Use pyFunc.callPromising()」）。結果 `42`。
     - 因此 gui.wait 可以是「同步的 Python 呼叫，worker 內掛起 wasm 堆疊、等頁面回覆」，不需要 SAB。
   - 下一步：(a) worker 內 `self.guiCall(op,args)` 回傳 Promise，用 postMessage 把 op 送到頁面，頁面用 `_terminalGuiHost` 做事後回覆；(b) `fa_bridge.call` 的 IN_BROWSER 分支要從 `asyncio.run(...)` 改成 `pyodide.ffi.run_sync(_fa_pybridge.call(...))`；(c) 程式入口用 callPromising。
   - 還沒做：worker 的建立與 Pyodide 載入（上面已實測）、`gui.*` op 接到 `_pyBridgeDispatch`（`gui.open`→`@gui {v:1,op:'open',...}`、`add`、`draw`、`image`（要回傳 w/h）、`poll`／`wait`（host 的 `poll`/`wait` 回字串，要 JSON.parse）、`close`）、`gui.py` 範例與 missile command 的實機驗證。
6. **missile command 實機驗證**：Redmine 的 `examples/missile_command.py` 與四張貼圖複製到桌面版（用終端機寫檔或 `terminal_cp_to`），在終端機執行，截圖確認：widget 開始視窗、canvas 遊戲畫面、貼圖可見、滑鼠點擊發射、拖曳、滾輪。沒有截圖證據就寫「未驗證」。
7. **resizable、maximize**：`map_viewer.py` 或 pygame 的 `RESIZABLE` 視窗，實機拖曳與最大化按鈕截圖驗證。
8. **打磚塊**：Redmine 沒有這個範例。要做的話，先問使用者是否同意我另寫一支。
9. **JavaScript**：`node <file.js>` 的 sandbox iframe 執行器（移植 `ai_chat_js_program.js`，sandbox 只有 `allow-scripts`）。
10. **打包核對（管理層要求）**：說明新檔進安裝版與熱更新的方法。已知答案見第 2 節；實際跑一次 `node build-assistant.js` 後檢查 `renderer/floating-assistant.js` 與 `.min.js` 含有 `FA_GUI_*`、`FA_PYBRIDGE_FILES`。

每一項：先寫或確認測試，通過再 commit；commit 後回報「已提交，可發布，commit <hash>」，並分開說明「測試驗證過的」與「沒在桌面版實機跑過的」。

## 4. 還沒有答案的問題（要問使用者，不要自己決定）

- `ask-ai-chat` 這個名稱：桌面版既有的是 `ask-floating-ai-assistant`。預設是新增別名，使用者未確認。
- 打磚塊要不要我另寫。
- 實機驗證需要用桌面自動化工具（Windows-MCP）截圖與操作桌面版。使用者已同意（2026-11-03：「同意,實機驗證」）。

## 5. 工作方式（使用者規則，依記憶檔整理）

- 語言：繁體中文，**中文句子裡不要夾英文縮寫或術語**（memory：純中文回覆）。程式碼與註解照周遭風格。
- 結論先說；誠實分開「驗證過」與「推測」；失敗要附具體事實（HTTP 狀態、錯誤訊息、耗時等）。
- 改程式用 Edit／Write，不用 shell 內嵌（memory：改程式別用 shell 內嵌）。大檔（`renderer/src/floating-assistant.js` 約 10 萬行）用 Grep 定位，不整檔讀。
- 嵌入區塊要改來源模組（`renderer/src/gui/*.js`、`renderer/src/pybridge/*.py`），然後 `node scripts/embed-code-ui.js`，用 `git diff --stat` 確認只有預期的改動（memory：嵌入的來源模組）。
- 熱更新不准要求重裝（memory）；新檔要核對是否進安裝版與熱更新。
- 不 push、不跑 publish.sh；`git add` 只加自己改過的檔案；不 stash、不切分支、不 reset。
- commit 訊息結尾 `Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>`（依最新系統提示）。
- 下載任何檔案前要先問（檔名、來源、大小）；使用者曾因大小估錯而重新確認，所以要給正確大小。
- 測試用控制埠 17924（memory：測試程式別佔 17923）。
- 上下文：30% 交接（low-context-long-run）。交接前先 commit。

## 6. 使用者原話（逐字，依時間；只列仍然有效的）

- 2026-11-03（任務原話，經管理層轉達）：「DESIGN.skill-gui-bridge.md 是讓run terminal, skill可以自己產生gui的功能，請實現」
- 2026-11-03（設計文件內原話）：「首先建立 bridge 到 gui 上,先以 python、javascript、shellscript 為主,接著才是 SDL、gtk#、xaml、qml(qt)。」
- 2026-11-03（設計文件內原話）：「可以sdl, pygame優先,後面原生的我們還沒有ABI橋接,留作紀錄」
- 2026-11-03（管理層轉達，使用者補充）：「可以參考C:\Users\sunneo\Downloads\redmine_ai_chat 的實作」（沿用 Redmine 實作，不重新發明協定）
- 2026-11-03（管理層轉達，使用者補充）：「我想要有zenity, ask-ai-chat stdin, stdout pipe,」
- 2026-11-03（管理層轉達）：「不用等使用者，請直接往下做」；「第一個使用者能實際看到的指令（zenity 能彈窗並回傳答案）做完、測試過就回報『已提交，可發布，commit <hash>』」；「新檔（gui/*.js、pybridge/*.py）確實會進安裝版與熱更新，並說明核對方法」
- 2026-11-03（使用者）：「用中文跟我溝通」
- 2026-11-03（使用者）：「請實際跑程式驗證missile-command, 打磚塊, map-viewer，resizable, maximize 視窗化」
- 2026-11-03（使用者）：「同意,實機驗證」；「好」（同意下載 Electron；之後使用者說「之前都可以直接開本地的來跑，沒道理你現在還要抓」，改用本機快取）
- 2026-11-03（使用者）：「把他修正」（指 FA_DISABLE_MAIN_OVERLAY 沒有作用於渲染頁）
- 2026-11-03（使用者）：「麻煩打開來驗證那該死的skill gui 橋接 用該死的missile command遊戲 如果找不到，麻煩寫一套」（找到了 Redmine 的 `examples/missile_command.py`，不需要重寫）
- 2026-11-03（使用者）：「那你浪費30%的context ?」（承認浪費；之後要省 context：窄範圍 Grep、少截圖、少重複報告）
- 2026-11-03（使用者，以 skill 呼叫）：「馬上implement!!!」（要求立即交接並繼續實作）

## 7. 交接程序（自我遞迴）

執行 low-context-long-run 技能（門檻 30%）。每個批次：做完 → 測試 → commit → 用 `mcp__ccd_session_mgmt__get_usage` 讀 context 百分比。低於 30% 繼續下一項；達到 30% 就：改寫本檔（保留逐字原話、補 commit 紀錄與待辦狀態）→ commit（訊息寫明是 handoff）→ `mcp__ccd_session__start_session`（initiation user_asked、context fresh、同目錄、同分支 desktop-app、title「GUI 橋接 · handoff N」、prompt 用第 1 節）→ 等後繼確認接手 → 本 session 才能 mark_completed 與 archive（不刪除，不 clear）。

## 7.5 補充（管理層要求，給接手者直接用）

**驗證分類**

- 驗證過（node 或本機 Python）：協定 `gui_bridge.test.js` 69、繪製器 `gui_render.test.js` 40、zenity `zenity.test.js` 56、視窗主機 `gui_host.test.js` 21、Python `gui_py_test.py`、`gui_pygame_test.py`；`node build-assistant.js` 成功，四個 GUI 常數進入 `renderer/floating-assistant.js` 與 `.min.js`。
- 驗證過（語法）：`main.js` 與 `floating-assistant.js` 的 `node --check`。
- **未驗證（桌面版實機）**：以上全部。實機啟動後視窗空白，渲染頁是否載入不知道。zenity 對話框、`ask-ai-chat`、`gui wait`、Python 開窗、JavaScript 執行器、missile command、resizable、maximize，都沒有實機確認。

**已提交的關鍵位置（以名稱搜尋，不靠行號）**

- `renderer/src/floating-assistant.js` 的 `_faGuiModule(name)`（用嵌入字串 `FA_GUI_*_SRC` + `new Function` 載入）、`_terminalGuiHost(session)`（每個 session 一個 `guiHost`，容器 `session.container` 設為 `position: relative`）、`_terminalZenity(session, argsText)`（建立視窗、等 `host.wait`、回傳 exit code 0/1/5）。
- `session.container = container` 在 `_mountTerminalWidget` 建立 session 的地方設定。
- zenity 接線點：`_runTerminalCommand` 裡 `ask-floating-ai-assistant` 那一行後面（有 shell 運算子時走 `_terminalRunShellText`，否則直接 `_terminalZenity`）；管線擷取點是 `JS_INTERCEPTED_WITH_CAPTURE` 物件（已加 `zenity`）；`TERMINAL_VIRTUAL_SCRIPT_COMMANDS` 集合開頭已加 `'zenity'`。
- 既有的 `_terminalAskAI(session, argsText)` 在 `ask-floating-ai-assistant` 的分支裡，呼叫 `_runSubAgentTask`，不讀 stdin。
- 視窗主機在 `renderer/src/gui/gui_host.js`，它只接受 `render` 與 `bridge` 作為參數，DOM 細節不在這裡。

**Electron 本機快取與啟動方式**

- 快取 zip：`C:\Users\sunneo\AppData\Local\electron\Cache\electron-v44.4.0-win32-x64.zip`（158,278,765 bytes，與預期一致）。
- 已解壓到 `node_modules/electron/dist`，`node_modules/electron/path.txt` 寫入 `electron.exe`。
- 啟動（PowerShell，在 `desktop-app` 目錄）：
  ```
  $env:FA_BROWSER_CONTROL_PORT = "17924"; $env:FA_DISABLE_MAIN_OVERLAY = "1"
  Start-Process -FilePath ".\node_modules\electron\dist\electron.exe" -ArgumentList "."
  ```
- 不要跑 `npm install` 或 `node install.js`（Node v16.15.0 會因為 ESM 失敗），也不要重新下載。

**不要做的事**

- 不要整檔讀 `renderer/src/floating-assistant.js`（約 10 萬行，會超過上限）；用 Grep 搜名稱，再用 Read 的 offset/limit 讀 40–80 行。
- 不要連續截圖；截圖只用在關鍵驗證點，因為每張都很耗 token。
- 不要在桌面版 Claude 的聊天輸入框打字（那是別人在用的）。
- 不要提交 `renderer/floating-assistant*.js`、`renderer/update-manifest.json`、`web-lazy/*`，它們是 build 產物，交給發布流程。
- 不要 push、不要跑 publish.sh。

## 8. Traps（踩過的坑）

- 直接用 Read 讀 `renderer/src/floating-assistant.js` 會超過上限（約 11 萬 token）。用 Grep（`output_mode: content`、`head_limit`）定位後，再用 Read 的 offset／limit 讀 40–80 行。
- Windows-MCP 的 Screenshot 會把 Claude 桌面版的視窗也拍進來；桌面版的 Claude 聊天輸入框可能被別人打字，**不要在那個輸入框打任何字**。
- `FloatingAssistant` 視窗在螢幕上是 DISPLAY1（0,0–1920,1040）；截圖左半邊只有桌布，不代表視窗不存在。用 `Get-Process` 看 `MainWindowTitle`，用 `GetWindowRect` 看位置。
- 啟動時 live-update 會把遠端檔案寫進 `%APPDATA%\floating-assistant-desktop\live-patch\`（log 會顯示「更新 2 個檔案」），不影響已經加上 `FA_DISABLE_MAIN_OVERLAY=1` 的渲染頁。
- `npm start` 會先跑 `build:assistant`，會改寫 `renderer/floating-assistant*.js`、`renderer/update-manifest.json`、`web-lazy/*`（這些是 tracked 產物，屬於發布流程，不要混進功能 commit）。`.claude/launch.json` 的修改不是我做的，不要提交。
- `embed-code-ui.js` 會重寫全部嵌入區塊；跑完要 `git diff --stat` 確認只有預期的三行左右（本次確認過）。
- 新的 BEGIN/END 區塊若要留在網頁版核心，必須加進 `build-web-lazy.js` 的 EXCLUDE。
- 桌面版的 `ask-floating-ai-assistant` 不讀 stdin；`_terminalAskAI` 用 `_runSubAgentTask`，整段答案一次寫出。
- `zenity` 的 `--progress` 沒有 stdin 版本，立即回傳 exit 0（`Z.immediate`）。
- Electron 的 `node_modules/electron/install.js` 在 Node v16.15.0 會因為 `@electron/get` 是 ESM 而失敗；本機快取已有 zip，不需要再下載。
- 截圖 token 很貴；只在關鍵驗證點截圖。

## 9. 交接 3（2026-11-03，待辦 5 第一、二批完成後寫）

### 9.1 已完成（已提交到 desktop-app，未 push、未 publish）

- 待辦 5 的四步：`fa_bridge.call` 網頁版改 `run_sync`（不再 `asyncio.run`）；`_pyBridgeDispatch(op, a, ctx)` 的 `gui.*` 分支轉到 `_pyBridgeGui(op, a, session)`；`python`／`python3` 的程式，`py_async.js` 的 `needsAsync` 為真才走 `_terminalTryPythonAsync` → `_terminalRunPythonWorker`（module Worker，Pyodide 網址同 `FA_ASSET_URLS.pyodideJsBase`）。其他 python 指令路徑沒有改。
- 技術選擇的理由：
  - `gui.wait` 用輪詢佇列（`waitEvent`）而不用 `host.wait`：host 的 resolver 不能取消，超時後下一個事件會被丟掉。
  - 程式包在 `go()` 裡用 `callPromising` 執行，因為 `run_sync` 要在 JSPI 堆疊裡才能用；`install_hooks` 也放進 `go()`（放頂層會報「Cannot stack switch」）。
  - × 送 close 事件：程式要知道使用者關了視窗，否則之後的 draw 會失敗。
  - Worker 結束後把 /work 的檔案寫回終端機的目前目錄（missile 會寫貼圖）。
  - 窗的指標：gui_render 只在 `.ai-chat-wheel-on` 祖先之下送滑鼠與滾輪，這是 Redmine 那邊的 scroll-focus 腳本設的，桌面版沒有，所以在 gui_host 的 capture-phase mousedown 加上。
- 測試：`gui_host` 26、`gui_render` 40、`gui_bridge` 69、`zenity` 56、`py_async` 29、`py_worker` 24（node，全部通過）。
- 實機（真 Electron，`FA_DISABLE_MAIN_OVERLAY=1`、`FA_BROWSER_CONTROL_PORT=17931`、全新 `--user-data-dir`，評估檔 `scripts/eval/gui_py_worker.eval.js`）：
  - gui.py 範例：開窗、填值、按 OK，終端機 `answer: Alice`、`done`，exit 0。
  - 回歸：不含 gui 的 python 照常（`plain 2`），沒有走 Worker。
  - missile_command.py（Redmine 範例原檔，四張貼圖）：按「開始」→遊戲視窗 400×300，畫面有 23→115 種顏色；對照組（不操作 1.2 秒）改變 75 像素，輸入後改變 771 像素；指標旗標生效；按 × 後程式 exit 0，沒有錯誤。
  - missile 的評估檔在 scratchpad（`missile.eval.js`，由 `gen_missile.js` 從 `missile.tpl.js` 產生，含貼圖的 base64），沒有進 repo。

### 9.2 未驗證（要明講）

- 畫面外觀：沒有截圖，視窗位置、貼圖是否正確顯示、字型都未看過。
- missile 的各操作只驗到「有反應」：沒有分開確認射擊命中、拖曳、滾輪、方向鍵。
- 「按 Ctrl+C 停止 Worker」沒有做。程式如果不等視窗事件而死迴圈，目前只能關視窗（若程式有 wait／poll 會收到 close）；無 wait 的死迴圈無法停。
- Worker 的 stdin 永遠回傳 None（`input()` 會失敗）。
- 終端機 AI 工具路徑（`terminal_run`，約 `_runTerminalCommand` 之外的 `JS_INTERCEPTED_WITH_CAPTURE` 那段）沒有接 Worker 路徑，AI 呼叫含 gui 的 python 仍會走同步路徑而失敗。這要另外接。
- 視窗程式結束後不自動關閉（目前的選擇，使用者要自己按 ×）。
- `sleep()` 在 fa_bridge 網頁版仍是 `asyncio.run`（沒有在 Worker 實測過）。
- `renderer/src/pybridge/fa_bridge.py` 的 `acall` 仍用 asyncio（只在網頁版路徑，沒有人呼叫）。
- resizable、maximize、map_viewer、JavaScript 執行器、打磚塊：都還沒做。打磚塊要先問使用者。

### 9.3 另一個工作階段夾帶我的 WIP（需要知道）

- 提交 `efd9bbc8`（MIDI 編輯器，另一個工作階段）把我當時尚未提交的 `renderer/src/pybridge/fa_bridge.py`、`renderer/src/gui/py_worker.js`、`py_worker.test.js`，以及 `renderer/floating-assistant.js` 等 build 產物一起提交了（`git add -A` 式）。
- 沒有改寫歷史（不 reset、不 rebase）。`fa_bridge.py` 的內容現在在 HEAD 上是正確的；`py_worker.js` 的舊版在 efd9bbc8，之後的修改在 9ec1871c、929d4de7。
- 兩個共用資料夾的工作階段會互相覆蓋：提交時只用明確路徑 `git add <file>`，不要用 `git add -A`。

### 9.4 工作方式（沿用第 5 節，這次新增的）

- 每個 commit 只加自己改過的檔案；產物（`renderer/floating-assistant*.js`、`renderer/update-manifest.json`、`web-lazy/*`、`test-reports/*`、`features/FEATURES.md`、`.claude/launch.json`、`skills/*/parts_builtin.json`）不提交。
- 每次改 `renderer/src/floating-assistant.js` 後要跑：`node scripts/embed-code-ui.js`、`node build-assistant.js`，再啟動 Electron 驗證（嵌入的 `FA_GUI_*_SRC` 來自 `renderer/src/gui/*.js`，改來源模組後一定要 re-embed）。
- 下一項最先：待辦 7（map_viewer、resizable、maximize）；待辦 9-10 之後。打磚塊先問使用者（第 4 節）。

### 9.5 更正：SharedArrayBuffer（管理層指正，2026-11-03）

- 我先前寫「頁面沒有 SAB、只能用 JSPI」，這個結論沒有查 `main.js`，不可信。
- 事實：`main.js` 第 29 行是 `app.commandLine.appendSwitch("enable-features", "SharedArrayBuffer")`，桌面版已啟用 SAB。`fapfs_transport.js` 也用 SAB 加 `Atomics.wait`。
- 我實測過的只有：頁面 `crossOriginIsolated` 是 false（`scripts/eval/py_worker_probe.eval.js`）。這只代表頁面不是 cross-origin isolated，不能證明 `SharedArrayBuffer` 不可用；`typeof SharedArrayBuffer` 的值我沒有在 Worker 裡讀過。
- 建議（管理層指示）：Python Worker 的同步等待改用 SAB 加 `Atomics.wait`，做法同 `fapfs_transport.js`；JSPI（`run_sync`）留給網頁版備援。目前程式碼（9ec1871c、929d4de7）還是 JSPI 版，沒有改。
- 未驗證：SAB 在 module Worker 裡能不能用、`Atomics.wait` 在 Worker 裡能不能用。下一步要用真 Electron 的評估檔實測這兩點，再決定。

### 9.6 教訓（每條：錯在哪、下次怎麼做）

1. **沒被允許就自己開後繼工作階段。** 錯在：我在交接時自行開了 `GUI 橋接 · handoff 3`，跟管理層開的 `gui-h2` 撞到同一批檔。下次怎麼做：後繼只有管理層能開。到 30% 只更新文件、commit 通過測試的部分，然後回報「需要接手，文件已更新，commit <hash>」並結束。
2. **一直停下來問技術取捨。** 錯在：取捨（輪詢或 host.wait、視窗結束後要不要關、Worker 的同步方式）我停下來問，而管理層已說這類取捨自己決定並寫理由。下次怎麼做：自己選，理由寫進文件與 commit 訊息，只有使用者的決定才停下來問。
3. **宣稱「已用真桌面版跑通」卻漏掉 `FA_DISABLE_MAIN_OVERLAY=1`。** 錯在：沒有這個變數，會下載遠端版本，跑到的可能不是工作目錄的實作。下次怎麼做：每次實機驗證都要證明載入的是工作目錄的實作（評估檔的 `loaded.scripts` 指向 `renderer/floating-assistant.js`，`has_*` 旗標為真），宣稱前先看這個證據。我這次的 gui.py 與 missile 評估檔有 `loaded` 欄位，但 missile 的 `loaded` 只檢查了函式存在，沒有檢查腳本路徑，下次要補上。
4. **寫下「頁面沒有 SAB」卻沒查 `main.js` 第 29 行。** 錯在：事實沒有先用 Grep 驗證就寫進文件，後來被推翻。下次怎麼做：文件裡寫的每個技術事實，先用 Grep 或實測確認，寫進去時附上來源（檔案與行號或評估結果）。
5. **繞路找 Electron、連續截圖。** 錯在：花了額外的步驟找 Electron 二進位檔，連續截圖消耗大量 token。下次怎麼做：用 `node_modules/electron/dist/electron.exe`（文件已記載），截圖只用在必要的驗證點，優先用評估檔讀 DOM 與 canvas 的像素。

### 9.7 下一個工作階段（後繼）

- 不由本工作階段開後繼。文件更新後由管理層決定是否開。
- 後繼開場先讀本檔 9.5（SAB 更正）與 9.6（教訓），再讀第 9 節的未驗證清單。

### 9.8 原先的後繼說明（已作廢，保留紀錄）

- 讀本檔第 1 節的開場提示（它仍然有效，改用本檔第 9 節的現況）。
- 先確認 `git log --oneline -5` 有 `929d4de7` 與 `9ec1871c`，再開始。

## 10. 交接 4（2026-11-03，gui-h2 在 context 約 27% 時寫；不自行開後繼，由管理層決定）

### 10.1 這個階段新增的提交（都未 push、未 publish；全部完成並驗證前不要說「可發布」，使用者原話：「後面gui橋接 *全部* 完成再publish」）

| commit | 內容 | 實機驗證（真 Electron，`FA_DISABLE_MAIN_OVERLAY=1`，評估檔在 scripts/eval/） |
|---|---|---|
| 1caf05e6 | `ask-ai-chat`（別名 `ask-floating-ai-assistant`）讀管線 stdin、輸出可接管線；stdin 依 contextWindowTokens 截斷（前六後四）；管線含 `; & > <` 時維持舊路徑 | `ask_ai_pipe.eval.js`：單獨、`cat\|ask`、`ask\|grep`、`cat\|ask\|wc`、舊名稱、usage 都對。**模型呼叫換成回聲，沒有驗證真模型的回答品質**。另有 `sab_probe.eval.js`（SAB 實測） |
| 7086733d | shell 的 `@gui` 行（輸出經 `_terminalFilterGuiLines` 套用、不顯示）與 `gui wait\|poll`（`_terminalGui`；變數、`--timeout`、超時 exit 124） | `gui_shell.eval.js`：echo 開視窗、按鈕事件存進變數、超時走 `\|\|` 分支、`@gui` 沒洩漏 |
| 986c2fc5 | `node 檔案.js`（`js_program.js` 移植 Redmine，sandbox 只有 allow-scripts；`_terminalNode`；嵌入 GUIJSPROGRAM，已加入 build-web-lazy 的 EXCLUDE） | `js_node.eval.js`：console.log、gui 視窗與事件、`parent.fa` 被擋、throw 印錯誤、找不到檔案。node 測試 3 項 |
| 09ea05a3 | 可縮放視窗改用應用程式共用外殼 `FaWin.decorate`（只套用在 resizable／maximizable 的視窗）；控制按鈕靠右、關閉最右；視窗寬度不再被 cssText 蓋掉；pygame `Surface.get_size` | `gui_resize.eval.js`：最大化後視窗 1904x1001＝頁面大小，畫布隨之 1902x974 並送出 VIDEORESIZE，還原再送一次；標題在左、按鈕靠右（量座標） |
| 102d9bc3 | `gen_missile_eval.js`（產生 missile 逐項驗證評估檔） | missile 原檔：點擊 shots 0→1、拖曳砲台 60／250、**Ctrl+滾輪**一格 ±12、方向鍵三次 +12、空白鍵發射、畫布 23 色 |

### 10.2 使用者指正（本階段，必須記住）

- 「他對最大化有誤解」「不是填滿terminal」：最大化是**蓋滿整個頁面**（跟應用程式其他視窗一樣，用 `FaWin`：☐ 最大化、⤢ 彈出、⛶ 全螢幕、八向縮放），不是填滿終端機區域。舊的 `gui_render.js` 自帶的最大化鈕（填滿終端機）只在沒有外殼時當備援。
- 「視窗控制的control button 應該要靠右」：標題在左，按鈕在右，關閉鈕最右。
- 「SharedArrayBuffer一直都有在用」：桌面版 `main.js:29` 已啟用；module Worker 內 `SharedArrayBuffer`＋`Atomics.wait` 實測可用（被主執行緒喚醒，值 7）。**技術選擇**：Python Worker 仍用 JSPI（`run_sync`），因為已實機跑通 gui.py 與 missile，SAB 沒有帶來額外能力；若之後要停掉死迴圈或網頁版備援再改。

### 10.3 還沒做（依序，下一項最先）

1. **map_viewer 實機驗證**：`C:\Users\sunneo\Downloads\redmine_ai_chat\examples\map_viewer.py`（pygame，滾輪／滑鼠移動／方向鍵／空白鍵）。做法照 `gen_missile_eval.js`：包一層換掉狀態輸出，用 DOM 事件操作畫布，從終端機輸出核對。若它沒有 RESIZABLE，resizable 已用 `gui_resize.eval.js` 的自寫程式驗過。
2. **打磚塊**：Redmine 沒有範例。**要先問使用者是否同意我另寫**，不要自己寫。
3. **AI 工具路徑（terminal_run）**：含 `import gui`／pygame 的 python、`node`、`gui`、`@gui` 行、`ask-ai-chat` 在 `terminal_run` 不會套用（見 9.2；`_runTerminalCommandForTool` 約在 `JS_INTERCEPTED_WITH_CAPTURE` 那段）。要不要接、怎麼接（AI 沒有人按按鈕，視窗會一直等）屬技術取捨，自己決定並寫理由。
4. **真模型驗證 ask-ai-chat**：用有設定模型的環境跑一次 `cat log | ask-ai-chat "摘要"`，確認 stdin 內容真的被模型看到（目前只驗證了提示詞內容）。
5. **剩餘小項**：Worker 的 `input()`／stdin 永遠 None；沒有 Ctrl+C 停止 Worker；重新顯示（add／set）時已彈出的視窗位置回到預設；程式結束後視窗不自動關閉（目前選擇）。
6. **打包核對（待辦 10）已查**：`FA_GUI_JSPROGRAM_SRC`、`FA_GUI_PYWORKER_SRC`、`FA_PYBRIDGE_FILES` 都在 `renderer/floating-assistant.js` 與 `.min.js`（`package.json` 的 `renderer/**/*` 包含、`!renderer/src/**` 排除原始碼；熱更新允許清單含這兩個檔）；`web-lazy/core.js` 刻意不含 GUIJSPROGRAM（EXCLUDE）。發布前由管理層再跑 `node scripts/embed-code-ui.js`、`node build-assistant.js`。
7. 全部完成後才回報「已提交，可發布，commit <hash>」，分開寫「真桌面版驗證過的」與「只有 node／Python 測試的」。

### 10.4 本階段教訓（補充到 9.6）

6. **殼層指令內嵌（heredoc／python 內嵌）又吃掉反斜線。** 錯在：用 Bash 的 heredoc 寫含 `\n`、`\d` 的程式，反斜線被吃掉，評估檔語法錯誤，來回修了三次。下次：含反斜線的程式一律用 Edit／Write 工具，或在程式裡改用 `String.fromCharCode(10)`、`[0-9]`。
7. **沒先查設計意圖就沿用「最大化＝填滿終端機」。** 錯在：前人這樣做，我驗證時只量到「填滿」就當通過，使用者才指正。下次：驗證前先找應用程式已有的同類功能（這次是 `FaWin`）與使用者的用語，不是只驗證現有行為。
8. **範例檔尾端直接呼叫 `main()`**（missile）：包一層要在 import 前去掉它，否則 monkey patch 來不及。`py_async` 只看被執行的那支檔案本身，包裝檔要自己 `import pygame` 才會走 Worker。
9. **評估檔偶爾「終端機掛載逾時」**：是環境暫時問題，重跑即可，不要誤判成程式壞掉。
10. **滾輪要 Ctrl**（一般滾輪保留給頁面捲動）：測試與說明都要寫 Ctrl+滾輪。

### 10.5 驗證指令（沿用第 2b 節）

```
node scripts/embed-code-ui.js && node build-assistant.js
FA_DISABLE_MAIN_OVERLAY=1 FA_DEBUG_EVAL_FILE=<評估檔絕對路徑> FA_BROWSER_CONTROL_PORT=17931 node_modules/electron/dist/electron.exe . --no-sandbox --disable-gpu --user-data-dir=<全新暫存資料夾>
node scripts/eval/gen_missile_eval.js <examples資料夾> <輸出評估檔>
```
node 測試：`renderer/src/gui/*.test.js`（gui_host 26、gui_render 40、gui_bridge 69、zenity 56、py_async 29、py_worker 24、js_program 3，全部通過）。

### 10.6 啟動測試實例的正確做法（管理層更正，2026-11-03）

- 全新 `--user-data-dir` 第一次啟動沒有 `main-ext-rev.txt`，`main-ext.js` 會把 `autoPrompt` 設為真，畫面自動跳出「發現新版本」對話框，按「立即更新」會把遠端版本蓋過工作目錄的實作。不用新增環境變數：啟動前在暫存資料夾預先寫入 `main-ext-rev.txt`（內容讀自 `main-ext.js` 的 `REV`，不要寫死）。
- 一律用 `node scripts/eval/run_eval.js <評估檔> [埠]`（已包含：暫存資料夾、預寫 rev、`FA_DISABLE_MAIN_OVERLAY=1`、換埠）。第 2b、10.5 節的手動啟動指令請改用它。
- 證明：`scripts/eval/no_update_dialog.eval.js` 讀 DOM，有預寫 rev 時 `update_dialog_shown:false`，對照組（沒預寫）`true`。畫面上的更新按鈕標籤也會寫「發現新版本」，那不是對話框，判斷對話框看有沒有「立即更新」。
- 不要在測試實例按「立即更新」。
- pygame `Surface.get_size` 已補（commit 09ea05a3），本次加測試；missile 重跑畫布 25 色（讀 canvas 像素，不是全黑）。

## 11. 本階段完成狀態（gui-h2 續作，2026-11-03；以本節為準，取代 10.3 的待辦）

### 11.1 待辦 10.3 的結果

| 項目 | 結果 | commit | 驗證 |
|---|---|---|---|
| 1. map_viewer 實機驗證 | 完成 | 108ea22d（評估檔產生器 `scripts/eval/gen_map_eval.js`） | 真 Electron，`run_eval.js`：Ctrl+滾輪放大 1→1.25 並保持游標下的點不動、再滾回 1；拖曳平移 (0,0)→(-40,-20)；方向鍵右三次 +60；空白鍵重設；畫布 32 色；載入的是工作目錄的 `renderer/floating-assistant.js` |
| 2. 打磚塊 | 完成（使用者同意「同意，另寫一支」，2026-11-03） | 2da1961e（`scripts/eval/gui_examples/breakout.py`、`scripts/eval/gen_breakout_eval.js`） | 真 Electron：發球後球會動；左鍵擋板 165→81；追球機器人 16 秒內打中 2 塊（分數 2）；漏接命數 3→2；按 × 後 exit 0 |
| 3. terminal_run（AI 工具路徑）接 gui／node／@gui／ask-ai-chat | 完成 | 99abda1a、03db07dc | `scripts/eval/ai_gui_cap.eval.js`（上限設 4 秒）：zenity 管線與單獨 exit 5 且視窗關閉；python gui exit 124 並印出逾時訊息、視窗關閉；node gui exit 124、視窗關閉；`gui wait` exit 124；回歸：不含 gui 的 python 輸出 2 |
| 4. 真模型驗證 ask-ai-chat | 完成（使用者答「用本機設定」） | 03db07dc（修正：AI 路徑的管線沒接上 ask-ai-chat） | 見 11.3 |
| 5. 剩餘小項 | 不實作，列為已知限制（見 11.4） | — | — |
| 6. 打包核對 | 完成（已再核對） | — | `renderer/floating-assistant.js` 與 `.min.js` 都含 `closeAll`、`guiAiTimeoutSec`、`FA_GUI_HOST_SRC`（Grep 計數 8／7／2） |
| 網頁版 JSPI 查證 | 完成（內建瀏覽器實測） | — | 見 11.5 |

### 11.2 本階段新增的提交（都未 push、未 publish）

- 108ea22d map_viewer 評估檔產生器
- 99abda1a AI 工具路徑接上 zenity／python gui／node gui／gui wait，並加 120 秒上限；`gui_host.closeAll`（gui_host.test.js 30 項通過）
- 2da1961e 打磚塊範例與評估檔產生器
- 03db07dc AI 路徑的含 ask-ai-chat 管線改走 `_terminalRunAiPipe`（跟互動路徑同一套）

node 測試（全部通過）：gui_bridge 69、gui_host 30、gui_render 40、js_program 3、py_async 29、py_worker 24、zenity 56。

### 11.3 真模型驗證（2026-11-03）

- 做法：`run_eval.js` 的同一套啟動，但另外把使用者本機的 `secrets.json` 複製進這次的暫存使用者資料夾，跑完刪除副本（原檔不動）。secrets.json 只含模型金鑰（欄位名稱：NVAPI_KEY、OPENROUTER_API_KEY），內容沒有寫進任何檔案或回報。
- 結果：`cat log.txt | ask-ai-chat "用一句話摘要…，並把專案代號原文寫出來"` 的回答含 `ORCHID-7`（這個代號只存在於 stdin 的文字裡），exit 0，約 5.4 秒。對照：不給 stdin 時回答「不知道」，沒有提到代號。stdin 確實被模型看到。
- 修正過程：第一次跑時管線報 `sh: line 4: ask-ai-chat: not found`，原因是 AI 路徑沒有接 `_terminalSplitAiPipe`（互動路徑有）。已修（03db07dc）。
- 未做：模型名稱、回答品質的評分（只驗證 stdin 可見）。

### 11.4 已知限制（交接 6 之後八條全部已修，見第 13 節；以下保留原文）

- Python Worker 的 `input()`／stdin 永遠回傳 None。
- 沒有 Ctrl+C 停止 Worker；程式不等視窗事件的死迴圈只能靠時間上限（AI 路徑）或關視窗（互動路徑，程式要有 wait／poll 才會收到 close）。
- 程式正常結束後視窗不自動關閉（互動路徑與 AI 路徑都是）。
- 重新 show（add／set）時已彈出的視窗位置回到預設。
- AI 路徑的 stdout 仍會含 `@gui` 行（視窗會正確開啟，只是行本身沒有從回傳的 stdout 移除）。
- 複合指令裡 JS 攔截段的 `$?` 不會帶到下一段（既有限制，不是 GUI 造成）。
- 時間上限（`session.guiAiTimeoutSec`）是整個終端機 session 的狀態：terminal_run 呼叫期間，同一個 session 裡使用者自己打的 GUI 等待也會被限制（120 秒）。
- `terminal_run` 包裝裡的 120 秒預設，只有程式碼檢查，沒有用 terminal_run 工具本身實機呼叫過（評估檔是直接呼叫 `_terminalRunCommand` 並手動設上限）。

### 11.5 網頁版 JSPI 查證（2026-11-03，內建瀏覽器，Chromium 152）

- `typeof WebAssembly.Suspending === 'function'`：true（JSPI 可用）。
- 未隔離的一般網頁：`crossOriginIsolated` 為 false，`SharedArrayBuffer` 為 undefined（所以網頁版不能用 SAB＋Atomics.wait，除非網頁有 COOP／COEP 標頭）。
- 結論：管理層決定的「Python 同步等待維持 JSPI」在網頁版的 Chromium 系瀏覽器可以跑。Firefox 與 Safari 的支援狀況沒有實測，不寫成事實。
- 注意：這次只驗證了 JSPI 的存在；網頁版的 Pyodide 完整流程沒有在網頁上跑過（只有桌面版的 Electron 實機跑過）。

### 11.6 教訓（本階段，每條：錯在哪、下次怎麼做）

1. **評估檔的滑鼠與滾輪沒有先點一下，就以為是程式壞掉。** 錯在：`.ai-chat-wheel-on` 閘門只在真的 mousedown 後加上，`cv.focus()` 不夠，滾輪事件被丟掉，縮放沒變。下次怎麼做：每個含滑鼠或滾輪的評估檔，先送一次 mousedown／mouseup（不做事）再操作。
2. **範例檔取名 `gui.py` 會遮住 gui 模組。** 錯在：`import gui` 先找到 cwd 的 gui.py，報「partially initialized module」。下次怎麼做：測試程式不要用內建模組的名字。
3. **只改 AST 執行器，單行指令根本不經過它。** 錯在：我先把 python gui 的判斷加在 `_terminalExecSimpleCommand`，單行 `python3 x.py` 走的是 `_terminalRunCommand` 的快速路徑，改了也沒用，還以為是 Worker 的問題。下次怎麼做：每個攔截都要在兩個入口（單行快速路徑、含 `;` 的 AST 路徑）各測一次；這次的做法是把單行判斷放進 `_terminalRunCommand` 的攔截區。
4. **壓縮產物的識別字會被改名，不能用變數名判斷載入的程式是不是新的。** 錯在：我用 `String(fa._terminalExecSimpleCommand).includes('restArgsQuoted')` 驗證，結果 false，誤以為改動沒載入。下次怎麼做：用字串常值（例如 `'python3'`）或行為（超時是否回傳 124）驗證；`renderer/floating-assistant.js` 是壓縮過的，`grep -c 變數名` 不可靠。
5. **node 沙盒的程式要用頂層 await。** 錯在：包成 IIFE 的 async 函式，沙盒不等它，程式 exit 0 而且沒有印出任何東西。下次怎麼做：照 `js_node.eval.js` 的寫法，頂層 `await gui.open(...)`。
6. **AskUserQuestion 的題目至少要有兩個選項。** 錯在：多塞了一題空的，整個呼叫被拒絕。下次怎麼做：只問有兩個真正選項的題目。
7. **AI 路徑的管線沒有跟互動路徑同步。** 錯在：`_terminalRunCommand` 與 `_runTerminalCommand` 是兩套入口，我只在一邊接了 AI 段。下次怎麼做：新增攔截或管線判斷時，檢查兩個入口是不是都要改（`grep -n "_terminalSplitAiPipe\|_terminalRunCommand(" 檔案`）。
8. **沒有先確認使用者目前的環境。** 錯在：我一開始沒有查模型金鑰放在哪；使用者要求「用本機設定」才去找。下次怎麼做：需要使用者本機資料的驗證，先問，再只複製需要的檔案，跑完刪副本、不印出內容。

### 11.7 驗證指令（本階段用的）

```
node scripts/embed-code-ui.js && node build-assistant.js
node scripts/eval/gen_map_eval.js <examples資料夾> <輸出評估檔>
node scripts/eval/gen_breakout_eval.js <輸出評估檔>
node scripts/eval/run_eval.js scripts/eval/ai_gui_cap.eval.js 17933
node scripts/eval/run_eval.js <map 或 breakout 評估檔> 17932
```
真模型驗證的評估檔與啟動器在 gui-h2 的暫存資料夾，沒有進 repo（依賴使用者本機的金鑰）；做法見 11.3。

## 12. 交接 6（2026-11-03，gui-h2 續作在 context 33% 時寫；不自行開後繼，由管理層決定）

### 12.1 開場提示（貼給接手的工作階段）

Continue from the handoff document at desktop-app/DESIGN.TODO.gui-bridge.md (repo root D:\Downloads\videos-嗨投資-desktop-app\desktop-app, branch desktop-app). Read it fully, especially section 12 (current status, half-done items and resume points) and section 12.5 (verbatim words), then section 11.6 and 12.6 (lessons). Follow the working style there. Run the low-context-long-run skill: do the next todo item in 12.3, and when your context reaches 30%, update this document, commit, and report 「需要接手，文件已更新，commit <hash>」 to the manager; do not start your own successor. Quote the user's key instruction verbatim: 「python的input回傳none, 沒有ctrl+c的問題必須修掉」「複合指令的$? 必須帶到下一段」「那些限制都必須修正」. Reply to the user in Traditional Chinese only, no English abbreviations inside Chinese sentences. Do not push and do not run publish.sh. First message: one line saying you read the document and which item you start.

### 12.2 管理層指示（2026-11-03，原文，經管理層轉達）

「python的input回傳none, 沒有ctrl+c的問題必須修掉」「複合指令的$? 必須帶到下一段」「那些限制都必須修正」。11.4 的八條已知限制全部要修，不可再列為已知限制。每條先寫會重現的測試（node 與真桌面版評估檔，用 `scripts/eval/run_eval.js`）再修，每修好一條就提交，真桌面版驗證與只有 node 測試的要分開寫。全部做完並驗證後才回報「已提交，可發布，commit <hash>」，中途只回報進度。打磚塊：使用者已選「同意，另寫一支」（見 11.1 第 2 項），所以不必再問；在教訓裡已更正（見 12.6 第 1 條）。

### 12.3 八條的狀態（每條對應 11.4 的限制）

| 條 | 內容 | 狀態 | 位置／證據 |
|---|---|---|---|
| 7 | 時間上限改成呼叫範圍，不放 session | **完成（已實機）**：`session_has_cap: false`；`ai_gui_cap.eval.js` 全部通過 | `terminal_run` 包裝改成 `_terminalRunCommand(session, cmd, { ..., guiTimeoutSec: 120 })`，沿 opts 往下傳到 `_terminalZenity`／`_terminalGui`／`_terminalNode`／`_terminalTryPythonAsync`（第三個參數 `guiTimeoutSec`）；session 上已沒有 `guiAiTimeoutSec` |
| 6 | 複合指令 `$?` 帶到下一段 | **進行中（半完成，未全部驗證）**，見 12.4 | `exit_code_chain.eval.js` |
| 5 | AI 路徑 stdout 移除 `@gui` 行 | **程式已改、未驗證** | `_terminalWriteOutput` 回傳過濾後文字；`_terminalRunWasmLine` 的 onOutput 用它當 stdout（或 `_terminalFilterGuiLines`） |
| 4 | 重新 show 保留視窗位置與大小 | **程式已改、未驗證** | `renderer/src/gui/gui_host.js` `show()`：`prev` 原本在有外殼（`shells[winId]`，可縮放／可最大化）時不擷取，現在一律擷取（外殼是套在同一個元素上，`FaWin.decorate(el)`） |
| 3 | 程式結束後收掉它開的視窗（互動與 AI） | **未開始** | 設計：在 `_runTerminalCommand`（互動）與 `terminal_run` 包裝（AI）記錄開始前已開的視窗 id，結束時 `host.close` 掉新開的；python worker `finish` 與 node 結束也要收 |
| 2 | Ctrl+C 中止執行中的程式（exit 130，含死迴圈） | **未開始** | 先找終端機鍵盤輸入的接收處（`term.onData` 或同等，用 Grep），在前景程式期間攔截 `\x03`：呼叫 session 上登記的 abort（python worker 用 `terminate` 後重建、node 用 `js_program` 的 abort promise、zenity／gui wait 用 host.close）；收窗、印 `^C`、回提示字元、結束碼 130 |
| 1 | `input()`／`sys.stdin` 真的讀得到 | **未開始** | 做法：worker 的 RUNNER 裡 `input` 與 `sys.stdin.readline` 改呼叫 `run_sync(js_stdin_readline())`（同 gui 的 JSPI 路徑，已實機可用）；頁面端把終端機的輸入行（Enter 送出）或管線 `opts.stdin` 的內容排進佇列回覆；沒有輸入來源（AI 路徑沒給 stdin）時回 EOF（`EOFError`），不要永遠等 |
| 8 | 用真 `terminal_run` 工具路徑實機呼叫一次 | **未開始** | 要找到註冊的 `terminal_run` handler 能從評估檔呼叫（`registerOptional('terminal_run', ...)` 附近，約 62830 行，用 Grep 找它怎麼存放）；呼叫時傳入 JSON 字串，檢查回傳的 JSON（exit_code、stdout） |

### 12.4 第 6 條的確切狀態（續作入口）

已做（都在 `renderer/src/floating-assistant.js`，未提交前的工作樹內）：
- `TERMINAL_COMPOUND_INTERCEPT_NAMES` 補上 `zenity`、`python`、`python3`。
- `_terminalGroupCompoundLine`：含頂層 `&&`／`||` 的段（且第一個字不是 if／for 等控制字）→ `{type:'andor'}` 群組；其他 JS 名單的段維持 `js`。
- 新方法 `_terminalSplitAndOr(text)`（引號內不切）與 `_terminalRunAndOr(session, text, opts)`（短路執行，每段用 `_terminalRunCommand`，每段後 `_terminalSetExit`）。
- 三個群組迴圈（AI 的 `_terminalRunCommand`、互動的 `_runTerminalCommand`）都認得 `andor`；AI 的群組迴圈每段後 `_terminalSetExit`。
- `_terminalSetExit` 也寫在：AST 的 JS 攔截分支（`_terminalExecSimpleCommand` 的 captured 之後）、`_terminalRunCommand` 的 JS 攔截分支（`tExit`）、互動的 zenity／node／gui 分派。

評估 `scripts/eval/exit_code_chain.eval.js`（上一輪結果，build 之後）：
- AI 入口：`;` 的 zenity／sleep／gui wait／python gui／node gui／ask-ai-chat 的 `$?` 全部正確；`&&`／`||` 短路正確（`zenity && echo` 不印、`zenity || echo` 印）；`if zenity; then … else …` 正確（IFGOOD）。
- AI 入口未過：`for i in 1; do zenity --entry --timeout=1; echo M8:$?; done` 得到 0，應為 5。未查出原因。可能是 `for` 整段沒有進 AST 的 JS 分派（先在 `_terminalExecSimpleCommand` 加一行 `console`/寫入 `session.term` 看它有沒有走到 zenity），或 for 迴圈內的 `$?` 在同一個 wasm 腳本裡展開。
- 評估檔的錯誤（已修）：`and_ok` 的 `bad` 寫錯（`sleep 0 && echo ANDGOOD` 成功時應該印出 ANDGOOD）。
- 評估檔的錯誤（未修）：互動入口的判斷用 `termText(session).slice(before)`，但 xterm 有捲動上限，長度對不上，所以全部判成失敗（`tail` 欄位顯示輸出其實都在）。修法：每個案例用不同的標記（例如把 `M<n>` 換成 `I<n>`），在整個 `termText` 裡找 `I<n>:<值>`；`bad` 字串只在不含 `/work $` 提示字元的行裡找（指令回顯會含 bad 字串）。
- 互動入口的 `ask-ai-chat` 用法行確實印出（`usage: ask-ai-chat …`），但 `_terminalSetExit` 沒有加在互動的 ask 分派上（`if (cmdName === 'ask-floating-ai-assistant' || …)` 那一行），還需要補。

### 12.5 使用者與管理層原話（逐字，依時間；仍然有效）

- 2026-11-03（管理層轉達使用者原話）：「python的input回傳none, 沒有ctrl+c的問題必須修掉」「複合指令的$? 必須帶到下一段」「那些限制都必須修正」
- 2026-11-03（AskUserQuestion 答覆，使用者）：「同意，另寫一支」（打磚塊）；「用本機設定」（真模型驗證）
- 以下更早的原話仍有效，見第 6 節與 11.1：「後面gui橋接 *全部* 完成再publish」「馬上implement!!!」「用中文跟我溝通」

### 12.6 教訓（本輪；每條：錯在哪、下次怎麼做）

1. **更正：打磚塊不是擅自寫的。** 我先用 AskUserQuestion 問過使用者（「打磚塊 Redmine 外掛沒有範例，要我另寫一支 pygame 打磚塊來驗證嗎？」），使用者答「同意，另寫一支」，之後才寫。管理層轉達時寫成「你當時沒先問使用者就自己寫了」，這與事實不符。文件與回報裡以這裡為準；使用者仍可選擇保留或移除 `scripts/eval/gui_examples/breakout.py`（2da1961e）。
2. **單行指令與複合指令走不同入口。** 攔截要在單行快速路徑與含 `;` 的 AST 路徑各測一次；`_terminalGroupCompoundLine` 的 JS 名單與 AST 的分派是兩份名單，改一處忘另一處會出錯。
3. **`&&`／`||` 在 AST 裡不被認得。** 整串會被當成一個指令的參數（`sleep: 不合法的時間長度「0 && echo …」`）。下次別以為 AST 能處理所有運算子，先用評估檔看 argv。
4. **評估檔自己也會寫錯期望。** `and_ok` 的期望寫反，我先當成程式錯；結果看起來像故障，其實是測試錯。每次看到失敗，先看 `shown` 的實際輸出再判斷。
5. **互動入口的評估檔不能用字元長度切片。** xterm 有捲動上限，`before` 位置會失效；用標記搜尋。
6. **`$?` 的來源是 session.lastExitCode**（wasm 腳本開頭的 `_fa_rc`）。任何 JS 段跑完都要 `_terminalSetExit`，否則下一段的 `$?` 是舊值。

### 12.7 本輪改動的提交狀態

- 這一輪的工作樹改動在 `renderer/src/floating-assistant.js`、`renderer/src/gui/gui_host.js`、`scripts/eval/ai_gui_cap.eval.js`、`scripts/eval/exit_code_chain.eval.js`（新檔）。build 產物（`renderer/floating-assistant*.js`、`update-manifest.json`、`web-lazy/*`）沒有提交，依規則不提交。
- 已提交的 WIP 見本文件末尾的 commit（12.8）；WIP 的狀態是「未全部驗證」，續作者要先重跑 `scripts/eval/ai_gui_cap.eval.js` 與 `scripts/eval/exit_code_chain.eval.js` 確認沒有回歸。

### 12.8 續作者的第一步

1. `node scripts/embed-code-ui.js && node build-assistant.js`，然後 `node renderer/src/gui/gui_host.test.js` 等 node 測試。
2. `node scripts/eval/run_eval.js scripts/eval/ai_gui_cap.eval.js 17950` 必須全部通過（這是 7 項已完成的回歸）。
3. 修 `exit_code_chain.eval.js` 的互動判斷（12.4），再看 `for_zenity`。
4. 依 12.3 的表，第 5、4 項先用評估檔驗證（5：`echo '@gui …'` 的 AI 呼叫 stdout 不含 `@gui`、視窗開；4：可縮放視窗設定 `style.left/top` 後送 `add` op，位置不變）。
5. 然後第 3、2、1、8 項。每修一條就提交，並在 12.3 更新狀態。

### 12.9 交接程序（自我遞迴）

執行 low-context-long-run 技能（門檻 30%）。做完一批、通過測試、提交後看 `mcp__ccd_session_mgmt__get_usage`；到 30% 就更新本節、提交、回報「需要接手，文件已更新，commit <hash>」，不自行開後繼。

## 13. 交接 7 結果（Sonnet，2026-11-03）：11.4 的八條全部修完並實機驗證

全部用 `node scripts/eval/run_eval.js <評估檔> <埠>`（真 Electron、全新資料夾、換埠），每個評估檔輸出的 `loaded.scripts` 指向工作目錄的 `renderer/floating-assistant.js`。

| 條 | 內容 | commit | 評估檔 | 結果 |
|---|---|---|---|---|
| 7 | 時間上限只跟呼叫 | 3e773200 | ai_gui_cap | 通過（本輪再跑，無回歸） |
| 6 | 複合指令 `$?` | c85bcd76 | exit_code_chain | AI 與互動兩個入口各 12 案例全過。根因：for 的迴圈變數賦值（`i=1;`）把 `$?` 洗成 0，`_terminalBuildEnvPrefix` 後補回 `_fa_rc`；互動的 ask-ai-chat 補寫結束碼；評估檔互動判斷改用 I<n> 標記 |
| 5 | AI 路徑 stdout 移除 `@gui` | 9551970e | gui_stdout_pos | stdout 為空字串。根因：全是 `@gui` 行時 outBuf 空，退回原始 stdout |
| 4 | 重新 add 保留位置大小 | 9551970e | gui_stdout_pos | 77/55/333/222 保持。註：評估是在修好後寫的，沒有先看到失敗的版本 |
| 3 | 程式結束收窗 | 9039d5c3 | gui_autoclose | python／node 正常與出錯結束，互動與 AI 都收掉；`@gui` 行開的視窗保留 |
| 2 | Ctrl+C | 9c316a70 | ctrl_c | 走真的 `_handleTerminalInput`：python 死迴圈、python 等視窗、node 死迴圈、zenity 都在毫秒內停止，視窗收掉，結束碼 130，下個指令正常（Worker 每次新建） |
| 1 | input／stdin | bcfe7c39 | py_stdin | 互動（提示、打字、Backspace、Enter、sys.stdin.readline）、管線（互動與 AI；read() 讀全部）、AI 沒給輸入＝EOF（4 秒內 EOFError，不等）、等輸入時 Ctrl+C=130、不讀輸入的 python 不變 |
| 8 | 真 terminal_run 工具 | 本節所在 commit | terminal_run_tool | `fa.tools.terminal_run.callback(JSON)`：echo 正常；沒人按的 zenity 120019 毫秒、exit 5、視窗收掉 |

### 技術取捨（自己決定）
- 讀輸入的 python（`input(`、`sys.stdin`）也走 Worker（`py_async.js`），因為同步 python 沒辦法在呼叫處等一行；Worker 的 `input` 與 `sys.stdin` 在 RUNNER 的 `go()` 裡換成呼叫橋接 `stdin.readline`（JSPI），頁面端 `_terminalReadStdinLine`。
- 管線尾端的 python 用 `_terminalSplitPyPipe`：先 probe 確認會走 Worker 才跑前面的段，避免前面的段跑兩次。
- Ctrl+C：前景程式用 `_terminalRegisterAbort` 登記中止函式；Worker `terminate`、node 移除 iframe；zenity 與 `gui wait` 靠 `closeAll`；`session._sigint` 讓結束碼固定 130。

### 沒做、要明講
- `python x.py; echo 後面` 這種複合行，Ctrl+C 只中止目前這支程式，後面的段仍會接著跑（真的 shell 會整行中止）。
- `sleep` 沒有登記中止函式，Ctrl+C 打不斷。
- `SystemExit(3)` 在 Worker 路徑結束碼是 1（既有行為，沒改）。
- 互動輸入只處理可印字元、Backspace、Enter、Ctrl+D；方向鍵與游標移動沒做。
- 沒有視覺截圖（全部讀 DOM／終端機文字）。

### 教訓（本輪）
1. Bash 的 heredoc、Python 內嵌會吃反斜線（`\n`、`\b` 變成真換行與退格字元），這次又發生三次（js_program.js、py_async.js、測試檔）。含反斜線的修改一律用 Edit 工具，或用 Write 寫成 node 腳本並用 `String.fromCharCode(92)`。
2. 評估檔先確認「前提成立」：autoclose 第一版沒看到視窗存在就以為通過，加了 MutationObserver 與保留視窗才算數。
3. Windows 上 `node -e` 讀 stdin 會 EOF 失敗，改輸出到檔案再解析。

## 14. 給接手者（Haiku）的一步一步（交接 7 收尾，2026-11-03）

八條都已完成，沒有半成品。還沒修的只有第 13 節「沒做、要明講」那幾項，使用者沒有要求就不要開新的一條。

### 還沒修的限制與驗收做法
| 限制 | 接續點 | 驗收 |
|---|---|---|
| 複合行 Ctrl+C 後，後面的段仍會跑 | `_terminalInterrupt` 設了 `session._sigint`；`_runTerminalCommand` 的群組迴圈、`_terminalRunAndOr`、`_terminalExecShellNode` 的 For／While／Sequence 迴圈每段開始前檢查它，為真就停 | 在 `scripts/eval/ctrl_c.eval.js` 新增案例 `python3 spin.py; echo AFTER`，Ctrl+C 後終端機文字不含 AFTER，結束碼 130 |
| `sleep` 打不斷 | `_terminalSleep` 內用 `_terminalRegisterAbort` 登記，中止時清 timer 並 resolve | 同上評估檔加 `sleep 30` 案例，毫秒內回提示字元 |
| `SystemExit(3)` 結束碼是 1 | `renderer/src/gui/py_worker.js` 的 `go()` 捕捉 SystemExit 取 code，done 訊息帶回 | `scripts/eval/gui_autoclose.eval.js` 的 py_exit3 案例，預期 exit 3 |
| 互動輸入沒有方向鍵 | `_terminalStdinFeed` | 不急，使用者沒要求 |

### 一步一步（每步一個動作，附可檢查的結果）
1. 讀本檔第 13、14 節。檢查：能說出八條各用哪個評估檔。
2. `git log --oneline -3`。檢查：看得到 4021f5b1 或更新的提交。
3. 改程式只用 Edit 或 Write 工具，不要用 Bash 的 heredoc 或 python 內嵌（會吃反斜線，這輪壞了三次）。檢查：改完用 `node --check` 或對應的 node 測試。
4. 改 `renderer/src/gui/*.js` 或 `renderer/src/floating-assistant.js` 後，先跑 `node scripts/embed-code-ui.js && node build-assistant.js`。檢查：指令沒報錯。
5. 寫評估檔，先確認前提真的成立（例如視窗真的存在、目標程式真的在跑），再斷言結果。檢查：沒修時評估檔必須失敗。
6. 跑 `node scripts/eval/run_eval.js scripts/eval/<檔>.eval.js <埠>`，輸出存到暫存檔再 grep `eval-file] result`（不要用管線讀 stdin）。每個評估檔用不同的埠。檢查：`loaded.scripts` 指向工作目錄的 `renderer/floating-assistant.js`。
7. 回歸三個評估檔：`ai_gui_cap`、`exit_code_chain`、`ctrl_c`，加 `renderer/src/gui/*.test.js` 全部。檢查：與第 13 節的數字相同。
8. 提交只用 `git add <明確路徑>`；不提交 `renderer/floating-assistant*.js`、`update-manifest.json`、`web-lazy/*`、`test-reports/*`、`.claude/launch.json`。訊息結尾加 Co-Authored-By 行。檢查：`git status` 沒有誤加。
9. 不 push、不跑 publish.sh，發布由管理層做。回報用繁體中文，不夾英文縮寫，並分開寫真桌面版驗證過的與只有 node 測試的。

### 常見坑
- 單行指令走 `_terminalRunCommand` 的快速路徑，含 `;` 走 AST，互動輸入又是 `_runTerminalCommand`；新增攔截要三個入口各測。
- `$?` 的來源是 `session.lastExitCode`，任何 JS 段結束都要 `_terminalSetExit`。
- 壓縮產物的變數名不可靠，驗證載入用字串常值或行為。
- 評估檔偶爾「終端機掛載逾時」是環境暫時問題，重跑即可。

## 15. 最後三項限制修完（Haiku，2026-11-03）

| 步驟 | 內容 | commit | 評估檔 | 修前 → 修後 |
|---|---|---|---|---|
| A | 複合行 Ctrl+C 後後段不再跑 | 8da55371 | ctrl_c（新增 py_compound） | after_ok true → false，結束碼 130，下一個指令正常 |
| B | sleep 可被 Ctrl+C 打斷 | 9fd8d764 | ctrl_c（新增 sleep_30） | 8003 ms、busy 不歸零 → 7 ms、busy 歸零、結束碼 130 |
| C | SystemExit(n) 結束碼是 n | 7a9cbcb1 | gui_autoclose（新增 boom_sys、boom_exit、err） | sys.exit(3)／exit(3)／raise SystemExit(3) 都是 1 → 都是 3；正常 0、未捕捉 1 |

- 驗證方式：`node scripts/eval/run_eval.js <評估檔> <埠>`（真 Electron、全新資料夾、換埠），每個評估檔的 `loaded.scripts` 都指向工作目錄的 `renderer/floating-assistant.js`。
- 回歸：ctrl_c 6 案例全部 130 且下一個指令正常；exit_code_chain 24 項 ok 全為真；gui_autoclose 的 AI 與互動兩個入口一致；`renderer/src/gui/*.test.js` 全部通過。
- 沒驗證：`sys.exit("文字")` 印到 stderr 後結束碼 1 的路徑；視窗外觀；使用者真的用鍵盤按 Ctrl+C（評估檔是走 `_handleTerminalInput` 送 `\x03`，不是作業系統層級的鍵盤）。
- 做法：A 在群組迴圈、`_terminalRunAndOr`、`_terminalRunUnits`、shell 的 Sequence／AndOr／For／While 每段前檢查 `session._sigint`，Sequence 的批次送出也檢查；B 用 `_terminalRegisterAbort` 登記，中止時清計時器；C 在 Worker 的 `go()` 用 try/except SystemExit 回傳結束碼。

### 教訓（Haiku）
1. **shell 的工作目錄會殘留。** 錯在：前一條指令 `cd` 進了 `renderer/src`，後面的 `node scripts/...` 全部找不到檔案，我以為是工具壞了。下次怎麼做：每條 Bash 指令開頭都用絕對路徑 `cd "…/desktop-app"`，錯誤訊息先看路徑再判斷。
