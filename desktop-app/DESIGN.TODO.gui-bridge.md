# DESIGN.TODO.gui-bridge — 終端機與技能的 GUI 橋接（桌面版）

## 開場提示（貼給接手的工作階段；這段也是 start_session 的 prompt）

Continue from the handoff document at desktop-app/DESIGN.TODO.gui-bridge.md (repo root D:\Downloads\videos-嗨投資-desktop-app, branch desktop-app). Read it fully, including the verbatim user words and the working style, and follow them. Run the low-context-long-run skill: do the next todo item, and when your context reaches 30%, write the next handoff and start your own successor. Quote the user verbatim: 「DESIGN.skill-gui-bridge.md 是讓run terminal, skill可以自己產生gui的功能，請實現」 and 「先以 python、javascript、shellscript 為主」. Do not push and do not run publish.sh (the manager publishes). Reply to the user in Traditional Chinese only, with no English abbreviations inside Chinese sentences. First message: one line saying you read the document and which todo item you start.

## 總覽（Overview）

- 目標：讓桌面版（FloatingAssistant，`desktop-app/`）的終端機（run terminal）與技能（skill）裡的程式，能開視窗、畫 canvas、收點擊／按鍵／滑鼠事件。順序：shell（`gui wait`、`@gui` 行、zenity 子集）→ Python（gui.py、pygame 子集）→ JavaScript（node，sandbox iframe 不加 allow-same-origin）→ 技能可宣告／使用 GUI。SDL 在 pygame 之後；GTK#、XAML、QML、WinForms、WinAPI 不做（只留紀錄）。
- 設計來源：`C:\Users\sunneo\Downloads\redmine_ai_chat\DESIGN.skill-gui-bridge.md`（完整讀過）與同目錄 `HANDOFF.skill-gui-bridge.md`；已完成的 Redmine 外掛程式在 `C:\Users\sunneo\Downloads\redmine_ai_chat\assets\javascripts\ai_chat_gui_*.js`、`ai_chat_zenity.js`、`ai_chat_js_program.js`，`assets\pybridge\gui.py`、`pygame.py`，測試在 `test\gui_bridge\*`。可移植，不要照抄 Redmine 的 Ruby／路徑部分。
- 安全規則（設計文件 §8，不可放寬）：程式不碰 DOM，繪製器只用 textContent／createElement，不用 innerHTML；事件只回傳節點宣告過的事件；JS 只在 sandbox iframe（只有 allow-scripts）；圖片只接受 data URL（png、jpeg、gif、webp）；視窗是 AI 聊天同頁的 UI，不是系統視窗；滑鼠與滾輪只在聚焦後才送給程式。

### 打包與熱更新位置（已核對，2026-11-03）

- `renderer/src/**` 不進安裝包（`package.json` build.files 排除 `!renderer/src/**`），也不在熱更新允許清單。所以新模組不能只放在 `renderer/src/`，要**嵌進 `renderer/src/floating-assistant.js`**（同 PYBRIDGE、IDRSKILL 的做法）。嵌進去之後，`build-assistant.js` 產生的 `renderer/floating-assistant.js` 與 `.min.js` 會進安裝包（`renderer/**/*`）與熱更新清單（`LIVE_PATCH_ALLOWED_FILES` 含這兩個檔）。
- 網頁版（web-lazy）：`scripts/build-web-lazy.js` 會把 BEGIN/END 區塊切成 chunk，所以 `GUIBRIDGE` 已加進 `EXCLUDE`（留在核心，不變成延遲載入的區塊）。
- 還沒實際跑 `node build-assistant.js` 確認產物內含 `FA_GUI_BRIDGE_SRC`（這一步會改 `renderer/update-manifest.json` 與 min.js，屬於發布流程，交給管理層）。

## Commit 紀錄

| commit | 內容 | 驗證 |
|---|---|---|
| 4d6a197c | `renderer/src/gui/gui_bridge.js`（協定核心，UMD，自 Redmine 移植）＋ `gui_bridge.test.js` | `node renderer/src/gui/gui_bridge.test.js`：69 項通過 |
| 0d1570d2 | `renderer/src/gui/gui_render.js`（DOM 繪製器，自 Redmine 移植）＋ `gui_render.test.js`，並嵌入 GUIRENDER 區塊（`FA_GUI_RENDER_SRC`）；`build-web-lazy` EXCLUDE 加 GUIRENDER | `node renderer/src/gui/gui_render.test.js`：40 項通過（fake DOM，未在真頁面看過） |
| f5fb8f12 | `renderer/src/gui/zenity.js`（自 Redmine 移植）＋ `zenity.test.js`，嵌入 GUIZENITY 區塊（`FA_GUI_ZENITY_SRC`），EXCLUDE 加 GUIZENITY | `node renderer/src/gui/zenity.test.js`：56 項通過 |
| 739164eb | 嵌入：`floating-assistant.js` 的 `GUIBRIDGE-BEGIN/END` 區塊（常數 `FA_GUI_BRIDGE_SRC`）、`scripts/embed-code-ui.js` 加 `embed(...)` 一行、`scripts/build-web-lazy.js` EXCLUDE 加 GUIBRIDGE | 用 node 讀嵌入的字串、`new Function` 載入後 `apply` 開窗成功（一次性檢查，未寫成測試） |

## 追加需求與現況（2026-11-03，管理層透過 side session 轉達）

- 使用者補充：「我想要有zenity, ask-ai-chat stdin, stdout pipe」。ask-ai-chat 要能從 stdin 讀（`cat log.txt | ask-ai-chat "摘要"`），答案寫到 stdout，可再接管線（`ask-ai-chat "..." | grep ...`）。用桌面版既有的模型呼叫（線上／離線依既有設定，不另寫一套）；**不搬 Redmine 的 Rails／ActiveJob 輪詢**。能邊生成邊進管線就做，做不到就整段輸出並說明限制。沒有真實模型時用假模型測，並明說沒在桌面版真實跑過。
- 使用者補充：「可以參考C:\Users\sunneo\Downloads\redmine_ai_chat 的實作」：協定核心、繪製器、zenity、node 的 iframe 執行器、gui.py、pygame.py 與 test\gui_bridge\* 能沿用就沿用，改成桌面版模組形式與嵌入方式；不要重新發明協定。
- 桌面版現況（已讀）：終端機已有虛擬指令 `ask-floating-ai-assistant`，入口 `_terminalAskAI(session, argsText)`（floating-assistant.js 約 86572 行）。它呼叫 `_runSubAgentTask`，整段答案一次寫到終端機，**不讀 stdin**，`--format text|json`。
- 虛擬指令進管線的既有機制：`JS_INTERCEPTED_WITH_CAPTURE`（約 85366 行）讓 sleep／curl／wget／httping 的輸出可被管線接走（以暫換 `session.term.write` 錄下輸出）。ask-ai-chat 的 stdin 要比照這個路徑接，stdin 來源是前一段指令的輸出（`VIRTUAL_STDIN` 類機制需要確認）。
- 命名決定（待確認）：桌面版既有名稱是 `ask-floating-ai-assistant`，使用者與管理層要求的是 `ask-ai-chat`。預設做法：兩個名稱都可用（`ask-ai-chat` 為新增別名），並在 commit 訊息說明；若使用者不要別名，再改。

## Todo（依序；下一項最先）

1. **（嵌入已完成，739164eb；讀取端待做）**：在 `floating-assistant.js` 找到終端機的 session 建立處，加一個懶載入函式（例如 `_faGuiBridge()`），用 `new Function('module', FA_GUI_BRIDGE_SRC)` 取得 `AiChatGuiBridge`（module.exports 形式）。寫 node 測試：讀嵌入字串、載入、apply。注意 floating-assistant.js 極大（約 10 萬行），**不要整檔讀**，用 Grep 找 `_mountTerminalWidget`（約 83029 行）、`_runTerminalCommand`（約 84466）、`_runTerminalShellLine`（約 85190）、`SANDBOX_COMMAND_REGISTRY`（約 47636）。
2. **（已完成，0d1570d2）繪製器**。注意：`renderer/src/gui/gui_render.js` 的 canvas 聚焦判斷仍用 Redmine 的 `.ai-chat-wheel-on` 類別（`el.closest('.ai-chat-wheel-on')`），桌面版要換成自己的聚焦類別，或在視窗主機加上同名類別（第 3 項處理）。
3. **視窗主機與事件佇列**：session.guiHost（show、hide、refresh、paint；上限 4 視窗；事件佇列上限 50；frame、mouse move 合併）。顯示位置先用 terminal 容器內的浮層（`.ai-gui-layer` 類）。
4. **shell**（zenity 的純函式部分已完成，f5fb8f12；終端機的接線還沒做）：`gui wait <window> [VAR]`（同 sleep 的非同步虛擬指令，上限 300 秒，超時 exit 124）、stdout 的 `@gui ` 行交給套用函式（不顯示）、zenity 子集（`--info --warning --error --question --entry --password --list --checklist --radiolist --progress`；其餘 exit 1 並說明）。
5. **Python**：`gui.py`、`pygame.py` 子集放在 `renderer/src/pybridge/`（pybridge 已由 build 嵌入 FA_PYBRIDGE_FILES，會自動進 worker）。注意：pybridge 會被嵌入，新增 .py 不需改 build 腳本，但要確認 `ai_chat_python_worker` 的檔案清單（桌面版對應的是現有 python 執行路徑）。
6. **JavaScript**：`node <file.js>` 在 sandbox iframe 執行（`allow-scripts` only）。
7. **技能宣告 GUI**：技能（skill）能宣告/使用 GUI，待前面完成後再細化。

每一項：先寫測試、通過再 commit，commit 後回報「已提交，可發布，commit <hash>」，並分開說明「測試驗證過的」與「沒在桌面版真實執行過的」。

## 工作方式（使用者規則）

- 回覆：繁體中文，**不要在中文句子裡夾英文縮寫或術語**（memory: 純中文回覆）；結論先說。
- 改程式用 Edit／Write，不用 shell 內嵌（memory: 改程式別用 shell 內嵌）。
- 改嵌入區塊要改來源模組（`renderer/src/gui/*.js`），然後跑 `node scripts/embed-code-ui.js`（memory: 嵌入的來源模組）。
- 不 push、不跑 publish.sh（管理層發布）。`git add` 只加自己改過的檔案；不 stash、不切分支、不 reset。
- commit 訊息結尾：`Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>`（以系統提示為準）。
- 不佔用預設的 browser control 埠（17923）；測試要用桌面版時設 `FA_BROWSER_CONTROL_PORT` 換埠（memory: 測試程式別佔 17923）。
- 不重跑別人已跑過的測試（使用者規則 6）。
- 下載任何檔案前要先問（檔名、來源、大小）。
- 安全規則照設計文件 §8，不放寬。
- 上下文：30% 交接（low-context-long-run）；交接前先 commit 完整批次。

## 使用者原話（逐字，依時間）

- 2026-11-03：「DESIGN.skill-gui-bridge.md 是讓run terminal, skill可以自己產生gui的功能，請實現」
- 2026-11-03（設計文件內，原話）：「首先建立 bridge 到 gui 上,先以 python、javascript、shellscript 為主,接著才是 SDL、gtk#、xaml、qml(qt)。」
- 2026-11-03（設計文件內，原話）：「可以sdl, pygame優先,後面原生的我們還沒有ABI橋接,留作紀錄」
- 2026-11-03（任務指派，管理層）：「讓桌面版的終端機與技能裡的程式……能自己開視窗、畫 canvas、收點擊/按鍵/滑鼠事件。使用者決定:搬進桌面版,不是補 Redmine 外掛。」
- 2026-11-03（任務指派，管理層）：「你不要 push、不要跑 publish.sh」；「每階段 commit 後回報『已提交，可發布，commit <hash>』」。
- 2026-11-03（原設計文件）：「shell的事件看winetrick怎麼做 它應該是stdin ?」→ 結論（使用者確認）：shell 事件用 `gui wait`（設計 D），不走 stdin。
- 2026-11-03（原設計文件）：「missile command 要有貼圖（不是只有色塊）、開始前用 widget 詢問、遊戲畫面是 canvas」「滑鼠事件都要支援：click、move、drag（down、move、up）、wheel」「可縮放視窗與最大化按鈕也要做」。
- 2026-11-03（原設計文件）：「Redmine 上的 skill 與 bash emulator 也有機會拓展成支援 gui」（原始動機）。

## 交接程序（自我遞迴）

執行 low-context-long-run 技能（門檻 30%）。每個批次：做完 → 測試 → commit → 用 `mcp__ccd_session_mgmt__get_usage` 讀 context%。低於 30% 繼續；達到 30% 就：改寫本檔（保留逐字原話、補 commit 紀錄與 Todo）→ commit（訊息寫明是 handoff）→ `mcp__ccd_session__start_session`（initiation user_asked、context fresh、同目錄、同分支 desktop-app、title「GUI bridge · handoff N」、prompt 用本檔的開場提示）→ 等後繼確認接手 → 本 session 才能 mark_completed 與 archive（不刪除，不 clear）。

## Traps（踩過的坑）

- 直接用 Read 讀 `renderer/src/floating-assistant.js` 會超過上限（約 11 萬 token）。一定要用 Grep 搭配 offset／limit。
- `renderer/src/**` 不進安裝包；新檔若沒嵌進 floating-assistant.js，安裝版與熱更新都沒有。
- `embed-code-ui.js` 會重寫整個 floating-assistant.js 的所有嵌入區塊；跑完用 `git diff --stat` 確認只有預期的改動（本批已確認：只有 GUIBRIDGE 的 3 行）。
- git 有 CRLF 警告（autocrlf）：正常，commit 內容是 LF。
- Redmine 外掛的 `test\gui_bridge\*` 路徑不存在於桌面版；測試檔要改 require 路徑（已在 4d6a197c 改為 `./gui_bridge.js`）。
- `build-web-lazy.js` 會把純區塊切成 chunk：新增的 BEGIN/END 區塊若要留在核心，必須加進 EXCLUDE。
