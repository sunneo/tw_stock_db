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

## 3. 待辦（依序；下一項最先）

1. **【最優先】找出實機視窗空白的原因。** 症狀：`electron.exe .` 啟動後，主視窗標題是 `FloatingAssistant`，程序回應正常，但螢幕上那塊區域（DISPLAY1，0,0–1920,1040）只看到桌布，沒有內容。已排除：live-patch 覆蓋（d4a8255b 之後渲染頁用內建檔）。下一步：
   - 用 `FA_DEBUG_CONSOLE`（見 `main.js` 約 1844 行）或 `FA_DEBUG_EVAL_FILE`（約 1940 行）把渲染頁的 console 錯誤寫到檔案，讀 `$env:TEMP\fa_electron_*.log`。
   - 確認 `renderer/index.html` 與 `renderer/floating-assistant.js` 的載入路徑（`resolveIndexHtmlPath`，約 1527 行）。
   - 預期結果：看得到渲染錯誤，或確認頁面有內容但視窗位置／透明度問題。找到原因後才繼續。
2. **zenity 實機驗證**（需要的指令：在終端機輸入 `zenity --entry --text=hi`，截圖確認對話框出現，輸入後答案印在終端機）。通過後回報「已提交，可發布，commit <hash>」（若有修正）。
3. **`ask-ai-chat` 管線**：stdin 讀入、stdout 輸出、可接管線（`cat log.txt | ask-ai-chat "摘要"`、`ask-ai-chat "..." | grep ...`）。桌面版現有的是 `ask-floating-ai-assistant`（`_terminalAskAI`，約 86572 行，不讀 stdin，整段輸出）。預設做法：新增 `ask-ai-chat` 別名，沿用 `_runSubAgentTask` 現有模型呼叫；做不到串流就整段輸出並說明限制。**命名問題待使用者確認**（見 4）。
4. **`gui wait` 與 `@gui` 行**（shell 端）：`gui wait <window> [VAR]`（同 sleep 的非同步虛擬指令，上限 300 秒，超時 exit 124）；程式輸出裡以 `@gui ` 開頭的行交給 host 套用、不顯示。
5. **Python 接線**：桌面版 `python <file.py>` 目前走 `terminalPython` → `AiChatPython`；要把 `gui.py` / `pygame.py` 提供給 worker（`fa_bridge` 的 gui op 接到 `_terminalGuiOp`）。
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
