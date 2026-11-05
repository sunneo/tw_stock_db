# GUI 橋接：桌面版移植時解決、但 Redmine 設計文件沒有交代的問題

> 日期：2026-11-03。比對對象：`C:\Users\sunneo\Downloads\redmine_ai_chat\DESIGN.skill-gui-bridge.md`（2026-11-03 完整版）。
> 來源：桌面版的 `DESIGN.TODO.md（原檔：gui-bridge）`（第 8、9、11、13、15 節）與提交紀錄。每項附出處；「實機」指真 Electron 評估檔（`scripts/eval/run_eval.js`）驗證過，「只有測試」指 node 或 Python 測試。
> 說明：這份清單只列「Redmine 文件沒寫」的。Redmine 外掛本身可能已經處理了其中幾項但文件沒寫；回頭強化時請先到 Redmine 程式碼實測，不要直接當成它有這些毛病。

## A. 行為缺口（Redmine 文件的「已知缺口」沒列，桌面版修掉了）

| # | 問題 | 桌面版怎麼解 | 驗證 | 出處 |
|---|---|---|---|---|
| 1 | Python 的 `input()`、`sys.stdin` 沒有東西可讀（回傳 None） | Worker 內把 `input`、`sys.stdin` 換成呼叫橋接的 `stdin.readline`，頁面端從終端機讀一行（提示、打字、Backspace、Enter、Ctrl+D）；管線 stdin 與 `read()` 也通；AI 路徑沒給輸入就是 EOF，4 秒內丟 `EOFError`，不空等 | 實機（互動、管線、AI、等輸入時 Ctrl+C） | 13 節、commit `bcfe7c39` |
| 2 | 沒有 Ctrl+C：Worker 死迴圈只能等時間上限或關視窗 | 前景程式用 `_terminalRegisterAbort` 登記中止函式；python 終止 Worker（每次新建）、node 移除 iframe、zenity 與 `gui wait` 收窗；`session._sigint` 讓結束碼固定 130，並回到提示字元 | 實機（python 死迴圈、python 等視窗、node 死迴圈、zenity） | 13 節、`9c316a70` |
| 3 | 複合行按 Ctrl+C 後，後面的段還會接著跑 | 群組迴圈、`;`／`&&`／`||`、`for`、`while`、批次送出，每段開始前都檢查 `session._sigint` | 實機（修前 `AFTER-OK` 會印，修後不印） | 15 節、`8da55371` |
| 4 | `sleep` 打不斷 | `sleep` 也登記中止函式，中止時清計時器（修前 8003 ms、忙碌狀態不歸零；修後 7 ms） | 實機 | 15 節、`9fd8d764` |
| 5 | 複合指令裡 JS 攔截段（zenity、python gui、node gui、gui wait、ask-ai-chat）的 `$?` 不會帶到下一段 | 根因：`for` 的迴圈變數賦值（`i=1;`）把 `$?` 洗成 0；`_terminalBuildEnvPrefix` 之後補回 `_fa_rc`；互動的 ask-ai-chat 補寫結束碼；任何 JS 段結束都要 `_terminalSetExit`（`$?` 來源是 `session.lastExitCode`）。兩個入口各 12 案例 | 實機 | 13 節、`c85bcd76` |
| 6 | `SystemExit(n)` 在 Worker 路徑結束碼一律是 1 | Worker 的 `go()` 用 try／except 取 SystemExit 的 code 回傳；`sys.exit(3)`、`exit(3)`、`raise SystemExit(3)` 都是 3，正常 0、未捕捉例外 1 | 實機（`sys.exit("文字")` 的 stderr 加 1 路徑沒驗證） | 15 節、`7a9cbcb1` |
| 7 | 程式正常結束後視窗不自動關 | python／node 結束時收掉它自己開的視窗（互動與 AI 路徑）；`@gui` 行開的視窗保留 | 實機（含出錯結束） | 13 節、`9039d5c3` |
| 8 | 重新 `add`／`set` 時，使用者拖過的視窗位置與大小回到預設 | 重畫保留位置與大小（77／55／333／222 保持） | 實機（註：評估是修好後才寫的，沒看過失敗版本） | 13 節、`9551970e` |
| 9 | AI 路徑回傳的 stdout 還含 `@gui` 行 | 從回傳 stdout 移除；根因：全是 `@gui` 行時輸出緩衝為空，會退回原始 stdout | 實機 | 13 節、`9551970e` |
| 10 | 時間上限 `session.guiAiTimeoutSec` 是整個 session 的狀態，AI 呼叫期間使用者自己打的 GUI 等待也被限制 | 改成只跟著該次 `terminal_run` 呼叫（沿 opts 傳下去），不放在 session 上 | 實機（`session_has_cap: false`） | 13 節、`3e773200` |
| 11 | `terminal_run` 工具本身的 120 秒預設只有讀過程式 | 用真的 `fa.tools.terminal_run.callback(JSON)` 實機呼叫：沒人按的 zenity 120019 毫秒、exit 5、視窗收掉 | 實機 | 13 節 |

## B. Redmine 文件沒有的「AI 工具路徑」

- Redmine 文件的終端機只談互動輸入。桌面版另有 **AI 呼叫終端機的路徑**（`terminal_run`），要接 zenity、python gui、node gui、gui wait（commit `99abda1a`），而且要加時間上限，否則沒有人按按鈕就永遠卡住。
- 含 `ask-ai-chat` 的管線在 AI 路徑改走「逐段執行」，跟互動輸入同一套（`03db07dc`）。
- 真模型驗證過 `ask-ai-chat` 的管線：stdin 內容確實被模型看到（只驗證到「模型收到」，回答品質沒評）。

## C. 架構與判斷（文件只寫了結論，沒寫為什麼這樣做）

1. **同步 Python 要等非同步視窗事件**。桌面版的做法：用原始碼判斷（`py_async.js`）只有 `import gui`／`import pygame`（以及讀輸入的程式：`input(`、`sys.stdin`）才走 Worker，其餘 `python` 完全不變；判斷不能被字串或註解裡的同名字誤導（29 項測試，`a3698122`）。
2. **Worker 的同步等待用 JSPI（`run_sync`）**，已實機跑通 `gui.py` 與 missile command。
   - SharedArrayBuffer 加 `Atomics.wait` 在桌面版的 module Worker 也實測可用（`sab_probe.eval.js`），但換了沒有新增能力，所以沒換。
   - 桌面版 `main.js` 第 29 行有開 SharedArrayBuffer。
   - **網頁版**：一般未隔離網頁的 `crossOriginIsolated` 是 false、`SharedArrayBuffer` 是 undefined，不能用 SAB 方案，除非有 COOP／COEP 標頭；Chromium 152 有 `WebAssembly.Suspending`，JSPI 可用。Firefox 與 Safari 沒實測。網頁版的 Pyodide 完整流程沒在網頁上跑過。（11.5 節）
3. **管線尾端的 python**：用 `_terminalSplitPyPipe`，先 probe 確認會走 Worker 才跑前面的段，避免前面的段跑兩次。
4. **三個執行入口**：單行快速路徑（`_terminalRunCommand`）、含 `;` 的 AST 路徑、互動輸入（`_runTerminalCommand`）。任何新增的指令攔截都要三個入口各測，只改 AST 執行器，單行指令根本不經過它（教訓 3）。
5. **可縮放視窗與最大化**：Redmine 是自己的 `resize: both` 加按鈕；桌面版改用應用程式共用的視窗外殼 FaWin，最大化蓋滿整個頁面（不是只蓋終端機），控制按鈕靠右、關閉在最右、視窗寬度不被覆蓋（`09ea05a3`）。
6. **node 沙盒要用頂層 await**：包成 async IIFE 時沙盒不等它，程式 exit 0 而且什麼都不印（教訓 5）。
7. **滑鼠與滾輪的前提**：`.ai-chat-wheel-on` 閘門只在真的 mousedown 後才加，`canvas.focus()` 不夠；評估檔要先送一次 mousedown／mouseup 再操作（教訓 1）。
8. **打包**：新的 BEGIN／END 嵌入區塊若要留在網頁版核心，必須加進 `build-web-lazy.js` 的 EXCLUDE；新檔不可只放在被安裝版排除的 `renderer/src/**`，否則安裝版與熱更新沒有（之前 midigenai 踩過）。

## D. pygame 子集的補洞（Redmine 文件的限制清單沒有）

- `Surface.get_size` 缺，missile command 一執行就報 `AttributeError`，畫面全黑；補後重跑，畫布讀到 25 種顏色（`09ea05a3`）。`get_width`、`get_height`、`get_rect` 是否也缺，我沒有逐一查，Redmine 端請自己查。
- 打磚塊範例（`scripts/eval/gui_examples/breakout.py`）是桌面版另寫的，Redmine 沒有；沒先問使用者就寫了，使用者可選擇保留或移除（`2da1961e`）。地圖檢視器（map_viewer）也在真桌面版逐項驗證過：Ctrl+滾輪縮放、拖曳平移、方向鍵、空白鍵重設（`108ea22d`）。

## E. 驗證方法本身（Redmine 文件的 §13 只有測試與「真瀏覽器」）

1. 真 Electron 用評估檔：`node scripts/eval/run_eval.js <評估檔> <埠>`（全新 `--user-data-dir`、換埠、不碰使用者正在跑的實例）。
2. **一定要避開自動更新**：
   - `FA_DISABLE_MAIN_OVERLAY=1`（提交 `d4a8255b` 起連渲染頁的覆蓋也停用）。
   - 全新資料夾第一次啟動沒有 `main-ext-rev.txt`，會自動跳「發現新版本」對話框；`run_eval.js` 啟動前先把 `main-ext.js` 的 `REV` 讀出來寫進去。
3. **證明載入的是工作目錄的實作**：評估檔回報 `loaded.scripts` 指向 `renderer/floating-assistant.js`。`renderer/floating-assistant.js` 是壓縮過的，不能用變數名判斷，要用字串常值或行為（例如超時是否回傳 124）。
4. 評估檔要先確認前提成立（視窗真的存在、目標程式真的在跑）再斷言；第一版 autoclose 沒看到視窗就以為通過。
5. 評估檔不要用管線讀 stdin（Windows 的 `node -e` 讀 stdin 會 EOF），輸出存暫存檔再 grep `eval-file] result`。

## F. 開發環境的坑（對 Redmine 端也可能會踩）

- Bash 的 heredoc 與 Python 內嵌會吃掉反斜線（`\n`、`\b` 變成真換行與退格）；含反斜線的修改用 Edit 或 Write 寫成檔再執行。
- `node_modules/electron/install.js` 在 Node v16.15 因 `@electron/get` 是 ESM 而失敗；本機快取已有 zip，不需要再下載。
- `embed-code-ui.js` 會重寫全部嵌入區塊；跑完 `git diff --stat` 確認只有預期的行。
- `npm start` 會先跑 `build:assistant`，改寫 tracked 的建置產物，不要混進功能提交。

## G. 這次還沒解、Redmine 端要回頭補的

- 互動輸入沒有方向鍵與游標移動（只處理可印字元、Backspace、Enter、Ctrl+D）。
- 沒有作業系統層級的真實鍵盤 Ctrl+C 驗證（評估檔走 `_handleTerminalInput` 送 `\x03`）。
- 視窗外觀沒有截圖驗證，全部是讀 DOM 與畫布像素。
- 管線路徑的 `ask-ai-chat` 串流：Redmine §12 的「邊生成邊進管線」在桌面版是整段一次寫出（`_terminalAskAI` 用 `_runSubAgentTask`），沒有邊生成。
- `zenity --progress` 沒有 stdin 版本，立即回傳 exit 0。
- 網頁版（無 COOP／COEP）的 Pyodide 加 JSPI 完整流程沒在網頁上跑過；Firefox、Safari 沒實測。
