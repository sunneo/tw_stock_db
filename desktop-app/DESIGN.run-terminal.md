# DESIGN — `/run-terminal` 終端機子系統

> 涵蓋範圍：WASM沙盒終端機（xterm.js + busybox ash）本體、bash/python執行引擎、
> 檔案搬運（cp_to/cp_from）與File Access Point整合、檔案傳輸GUI、`ask-floating-ai-assistant`
> 虛擬指令、PPTX/PDF匯出、畫面/狀態持久化。
>
> 對象檔案：`desktop-app/renderer/src/floating-assistant.js`（唯一可編輯原始碼，
> `class FloatingAssistant`）＋ `desktop-app/renderer/terminal-programs/{pager,editor,top}.mjs`
> （獨立的全螢幕互動程式ESM bundle）。桌面版／網頁版共用同一份引擎，本文件不特別
> 區分兩者（除非明確標註「僅桌面版」）。
>
> 行號皆為撰寫本文件當下`renderer/src/floating-assistant.js`的實際行號，日後編輯
> 難免飄移，找不到時以「函式名稱/常數名稱」搜尋為準。

---

## 0. 設計動機與核心哲學

使用者要求終端機要能「被AI當成一個可以設計程式、實際跑起來驗證的工作環境」，同時
使用者也能直接在畫面上手動操作、看到即時輸出——兩種操作方式（人手動打字 / AI呼叫
`terminal_*`工具）必須共用同一個session、同一個檔案系統狀態，不能是兩條互不相干
的路。

**最關鍵的架構決策：這不是一個真正的互動式shell process，而是「command
interception」**——原因記在`_ensureBashWasmLoaded`附近的說明（~17058-17073）：
`wasi-sh`套件本身有提供`spawn()`這個真正互動式的API，但那個API要求
`crossOriginIsolated === true`（COOP/COEP header），而桌面版是`file://`協定載入的
頁面，網頁版則是從一個第三方GitHub Pages載入，兩者都拿不到這個瀏覽器安全情境。

因此整個終端機的「互動感」完全是JS層自己刻出來的假象：

- 鍵盤輸入、游標位置、方向鍵歷史、tab補全——全部由`_handleTerminalInput`這個JS
  函式手刻的行編輯器處理，busybox完全不知道有鍵盤這回事。
- 使用者按下Enter，JS把累積的一整行文字，當成「一次性批次腳本」丟給
  `runtime.run({command: script, ...})`——**每次呼叫都是一個全新、無狀態的WASM
  instance**，執行完就消失，沒有真正常駐的shell process。
- 檔案系統狀態（`fsStore`，一個`memoryFs`）在多次`run()`呼叫之間**持久保留、重複
  傳入**，這是唯一真正「延續」的東西；`cwd`則是JS層自己用一個字串變數
  （`session.cwd`）追蹤，每次執行前手動`cd`回去。

這個設計選擇的直接後果，會在後面反覆出現：**沒有真正的長時間背景程序、沒有
fork/exec、`cd`必須被特別攔截才能持久化、互動式全螢幕程式（vi/less/top）busybox
天生辦不到、只能另外用JS重新刻一份**。

---

## 1. 架構總覽

```
使用者輸入 (鍵盤)  ──┐
                    ├─► _handleTerminalInput(session, data)
AI呼叫terminal_run ─┘         │
                              ▼
                    _runTerminalCommand(session, line)  ← 13段dispatch鏈（§5）
                              │
        ┌─────────────┬───────────────┬─────────────────┬──────────────────┐
        ▼             ▼               ▼                 ▼                  ▼
   JS內建指令    ask-floating-      Program Bundle   SANDBOX_COMMAND    真正的WASM
  (cd/pwd/help   ai-assistant      (less/vi/top，    _REGISTRY host     busybox ash
   /chmod/sync    虛擬指令           獨立ESM，接管      builtin（python/  (_runTerminalShellLine
   /which/...)   (§9，全agentic     全部鍵盤輸入）      jq/xq/column/     →runtime.run())
                  loop委派)                             split，注入進
                                                         run()的builtins）
```

底層共用：`session.fsStore`（`memoryFs`實例，見§4）、`session.cwd`（JS字串）、
`runtime`（`_ensureBashWasmLoaded()`快取的`{run, memoryFs, wasmBytes}`，見§3）。

---

## 2. Session 生命週期與掛載

### 2.1 建立入口

兩條路徑最終都掛上同一種`msg._displayTerminal = {id, name, initialCommand}`
（非可枚舉屬性，`Object.defineProperty`），再由`_renderSingleMessage`偵測到這個
屬性時呼叫`_mountTerminalWidget`：

| 入口 | 函式 | 特點 |
|---|---|---|
| `/run-terminal [name=xxx] [初始指令]` slash指令 | `_handleRunTerminalCommand`（~17169） | 使用者手動打的路徑，`name=`前綴選填 |
| `terminal_create` AI工具 | `_createTerminalForAI({name, initialCommand})`（~17263） | 額外輪詢`_getMountedTerminalSessions()`最多15秒，等xterm.js真的掛載完成才回傳，避免「剛建立就找不到session」的race |

兩者共用同一套id（`crypto.randomUUID()`）/name（`term-N`自動編號或自訂）賦予邏輯。

### 2.2 `_mountTerminalWidget(container, initialCommand, msg)`（~17360）

1. `await this._ensureXtermLoaded()`（載入xterm.js UMD script + CSS，見`FA_ASSET_URLS.xtermJs`）。
2. 讀`advancedSettings.terminal`（見§16）建構`new Terminal({convertEol, cursorBlink,
   fontFamily, fontSize, scrollback, cols(選填), theme})`，`term.open(container)`。
   主題`theme:'system'`跟隨App目前亮暗模式（`_getTerminalXtermTheme()`），其餘四種
   （`ubuntu`/`powershell`/`black-white`/`white-black`）是`TERMINAL_THEME_PRESETS`
   （~4657）固定色票。
3. 建構`session`物件，完整欄位：

   | 欄位 | 說明 |
   |---|---|
   | `id` | uuid，全域唯一 |
   | `name` | 顯示名稱，可重複（撞名由`_resolveTerminalSession`明講歧義，不猜） |
   | `term` | xterm.js `Terminal`實例 |
   | `fsStore` | 初始`null`，`_ensureTerminalFsStore`時才建立（見§4） |
   | `cwd` | 初始`'/work'`，JS字串追蹤的虛擬工作目錄 |
   | `history`/`historyIndex` | 指令歷史陣列/游標 |
   | `line`/`cursorPos` | 目前正在輸入、尚未送出的那一行文字/游標偏移 |
   | `activeProgram` | `null`；被`less`/`vi`/`top`接管時設成`{feed}`（見§7） |
   | `ended` | `exit`後設`true`，session被「凍結」（widget本身不會消失，只是不再接受輸入） |
   | `startedAt` | `Date.now()`，`top.mjs`用來算uptime |
   | `hasFocus` | 監聽`term.textarea`（xterm.js內部隱藏`<textarea>`）的原生`focus`/`blur` |
   | `inViewport` | `IntersectionObserver`（threshold 0.1）追蹤是否捲入可視範圍 |
   | `lastActiveAt` | focus/按鍵時更新，resource policy用來排序 |
   | `msg` | 擁有這個widget的訊息物件，`_persistTerminalSnapshot`用 |
   | `busy` | 執行中旗標，避免同時處理重疊指令 |
   | `execMarks` | `Set<絕對路徑>`，`chmod +x`標記過的路徑 |
   | `fapLabels`/`fapHydrated`/`fapLabelsAt`/`fapPullCost`/`fapManifest` | FAP掛載狀態（見§11） |

4. `container._terminalSession = session`——附掛在DOM節點上（純debug/檢查用，但
   `_getMountedTerminalSessions()`實際上依賴它）。
5. 印歡迎訊息；如果`msg._displayTerminal.savedScreen`存在（重新整理頁面後的畫面
   快照），原樣印出+灰字提示「這是全新session，不是恢復原本執行到一半的程式」
   （見§14）。
6. `term.onData((data) => { if (!session.ended) this._handleTerminalInput(session, data); })`
   ——每個鍵盤事件的唯一入口。
7. 有`initialCommand`就走`_runTerminalInitialCommand`（不是透過鍵盤路徑模擬Enter，
   因為那樣`session.line`是空的，指令只會被「印出來」卻不會真的執行——這是一個
   修過的真實bug）。

### 2.3 `_getMountedTerminalSessions()`（~17324）——刻意不維護獨立registry

```js
_getMountedTerminalSessions() {
    return Array.from(document.querySelectorAll('.ai-terminal-embed'))
        .map(el => el._terminalSession)
        .filter(Boolean);
}
```

設計理由：直接查DOM，而不是另外維護一個`Set<session>`。訊息被`pruneContext`
壓縮/清除對話時，DOM節點自然跟著訊息消失，查詢自然不會回傳死掉的session，也不
需要額外的清理程式碼；反過來說，若維護獨立`Set`，會讓已經沒有DOM節點對應的
session物件被額外持有、阻止GC。

`terminal_list`/`_resolveTerminalSession(idOrName)`/`_resolveTerminalCpTarget`/
`_terminalSessionIsLive`/`_terminalIdleRefreshMs`全部依賴這個方法。

---

## 3. WASM bash/busybox 載入機制

### `_ensureBashWasmLoaded()`（~17016）

單次載入、快取在`this._bashWasmRuntime`/`this._bashWasmLoadPromise`。載入
`wasi-sh@0.11.0`套件的兩個ESM模組：

```js
const [runMod, fsMod] = await Promise.all([
    import(this._viaAssetProxy(FA_ASSET_URLS.bashWasmJsBase + 'src/index.mjs')),
    import(this._viaAssetProxy(FA_ASSET_URLS.bashWasmJsBase + 'src/fs.mjs')),
]);
run = runMod.run;
memoryFs = fsMod.memoryFs;
```

`FA_ASSET_URLS.bashWasmJsBase = 'https://cdn.jsdelivr.net/npm/wasi-sh@0.11.0/'`。

**雙來源備援**：主要CDN載入失敗時，改抓GitHub備份分支
（`bashWasmBackupBase = 'https://raw.githubusercontent.com/sunneo/tw_stock_db/bash-wasm-backup/wasi-sh/'`）。
由於`raw.githubusercontent.com`回傳`Content-Type: text/plain`+`nosniff`，瀏覽器的
`import()`會直接拒絕執行，所以改成先fetch原始文字、包成
`new Blob([text], {type:'text/javascript'})`、`import()`這個Blob URL。

`_fetchAssetBackupFile`（~16956）額外支援「大檔案切成`.partNNN`分段」的慣例
（讀`manifest.json`判斷），跟whisper模型等其他大型資源共用同一套備援機制。

WASM二進位本身（`dist/busybox.wasm`）另外用`_fetchAssetBytesWithBackup`獨立抓取
（同樣主要CDN+GitHub備援），純binary不需要Blob MIME workaround。

**回傳的`runtime`物件形狀**：`{run, memoryFs, wasmBytes}`——`run`是批次執行函式
（見§5末段）、`memoryFs`是建立沙盒檔案系統store的工廠函式（見§4）、`wasmBytes`是
編譯好的busybox WASM模組原始bytes（每次呼叫`run()`前都要`.slice(0)`複製一份，
因為WASM instantiate似乎會消耗/detach掉傳入的buffer）。

xterm.js本身由`_ensureXtermLoaded()`（~17074）獨立載入，同樣是CDN失敗時retry直接
CDN（非GitHub備援，UMD script+CSS）。

---

## 4. 沙盒檔案系統（`fsStore`）

### `_ensureTerminalFsStore(session, runtime)`（~17848）

每個session lazily建立一次`session.fsStore = runtime.memoryFs(seedFiles)`。
`seedFiles`組成：

1. `/work/.keep`、`/mnt/.keep`——空佔位檔案，確保這兩個目錄存在。
2. **四種指令名稱清單的聯集**（`discoverableNames`），每個名字都在`/bin/<name>`跟
   `/usr/bin/<name>`各塞一個空佔位檔（純粹讓`ls /bin`/tab補全「探索」得到有哪些
   指令，內容從不會被真的讀取執行——實際dispatch永遠走`_runTerminalCommand`的JS
   邏輯，不是讀檔案bytes）：
   - `TERMINAL_SHELL_BUILTINS`
   - `TERMINAL_BUSYBOX_APPLETS`
   - `Object.keys(this._terminalProgramBundles)`
   - `Object.keys(SANDBOX_COMMAND_REGISTRY)`
3. 每個目前已授權（且——2026-09-24起改成不篩permission，見§11.4）的FAP各塞一個
   `/mnt/<label>/.keep`佔位，讓`ls /mnt`一開始就看得到有哪些FAP可用，實際內容
   lazy hydrate（見§11.2）。

---

## 5. 四種「可以打的指令」分類與完整派送鏈

### 5.1 四種分類的本質差異

| 分類 | 常數/來源 | 執行位置 | 舉例 |
|---|---|---|---|
| **busybox applets** | `TERMINAL_BUSYBOX_APPLETS`（~4635，約34個：`cat, ls, stat, touch, mkdir, rm, cp, mv, find, grep, sed, awk, sort, head, tail, wc, date, printf, uname, ...`） | **真的在WASM busybox binary內執行**，落到`runtime.run()` | `ls -la /work` |
| **shell builtins** | `TERMINAL_SHELL_BUILTINS`（~4648：`cd, pwd, clear, exit, help, which, chmod, time, sh, bash, ask-floating-ai-assistant, sync`） | **JS層攔截，完全不會送進`run()`** | `cd /work/proj` |
| **program bundles** | `TERMINAL_PROGRAM_BUNDLES`（~4620：`less/more→pager.mjs`, `vi/vim→editor.mjs`, `top→top.mjs`） | **獨立ESM模組**，接管全部鍵盤輸入 | `vi notes.txt` |
| **SANDBOX_COMMAND_REGISTRY** | ~2600：`python/python3→pyodide`, `jq→jq`, `xq→xq`, `column/split→本地JS實作` | 注入成`run()`的host builtin，被wasi-sh shell同步呼叫（shell parser仍解析管線/重導向） | `cat data.json \| jq .foo` |

busybox applets清單本身抄自wasi-sh 0.11.0 README的toolbox說明，只用來組`which`/
`/bin`佔位，applet本體的執行邏輯完全在WASM binary內，JS層不重新實作。

### 5.2 `_handleTerminalInput(session, data)`（~17538）——鍵盤層

若`session.activeProgram`存在，所有原始輸入直接餵給`program.feed(data)`（無行
編輯，由bundle自己詮釋）。否則JS自己刻一套行編輯：`\r`送出、Backspace/Delete、
Ctrl+C清空、上下鍵翻歷史、左右鍵移游標、Home/End、Tab補全
（`_handleTerminalTabComplete`，補全來源正是上表四種分類的聯集）。每次非Enter的
編輯都靠`_redrawTerminalLine`整行重繪（不做增量ANSI更新，換取實作簡單）。

### 5.3 `_runTerminalCommand(session, rawLine)`（~17706）——dispatch核心

依序嘗試（每項命中就return）：

1. `clear` → `session.term.clear()`
2. `exit` → `session.ended = true`（widget本身不消失，只是凍結）
3. `pwd` → 印`session.cwd`
4. `help` → 固定說明文字
5. `cd` → `await this._terminalCd(session, restArgs)`（見§6）
6. `which` → `_terminalWhich`（查§5.1四種分類）
7. `chmod` → `_terminalChmod`——沙盒fs沒有真正的權限位元，純粹記錄「標記為可執行」
   的絕對路徑進`session.execMarks`這個`Set`
8. `sync` → `_terminalSync`（見§11.3，`--pull`/`--push`/`--delete`）
9. `sh`/`bash <file> [args]` → `_terminalRunScriptFile`
10. `/bin/<name>`或`/usr/bin/<name>`改寫 → 若`<name>`是已知指令，遞迴呼叫
    `_runTerminalCommand(session, name + ...)`（修過的bug：`/bin/ask-floating-ai-assistant`
    原本被誤判成「使用者腳本」要求先`chmod +x`）
11. 含`/`的名稱（`./script.sh`等）→ 要求`session.execMarks`裡有這個絕對路徑
    （模擬真實shell的x-bit語意）才會執行
12. `time <cmd>` → 遞迴呼叫並計時（`performance.now()`），user/sys時間是假的
    `0m0.000s`（沙盒沒有真正process/CPU時間概念）
13. `ask-floating-ai-assistant [--format text|json] <問題>` → `_terminalAskAI`（見§9）
14. Program bundle查表命中 → `_ensureTerminalProgramLoaded`+`_runTerminalProgramBundle`
15. **落到最後**：`await this._runTerminalShellLine(session, trimmed)`——真正的WASM
    busybox ash

### 5.4 `_runTerminalShellLine(session, line)`（~18248）——WASM執行路徑

1. `runtime = await this._ensureBashWasmLoaded()`
2. `fsStore = await this._ensureTerminalFsStore(session, runtime)`
3. `await this._hydrateReferencedFapMounts(session, fsStore, line)`——lazy讀取這行
   指令提到的`/mnt/<label>`（見§11.2）
4. 組出**帶cd前綴**的script：
   ```js
   const script = `cd ${this._shQuote(session.cwd)} 2>/dev/null; ${line}`;
   ```
5. `builtins = await this._buildTerminalSandboxBuiltins(script)`（見§8.1）
6. `this._activeSandboxFsStack.push(fsStore)`（讓Pyodide的`subprocess.run(['sh',...])`
   知道要重用哪個store）
7. 真正呼叫：
   ```js
   await runtime.run({
       command: script,          // 完整shell腳本文字
       fs: fsStore,               // 持久的沙盒MemoryFs（多次呼叫間重用同一物件，檔案才會延續）
       wasm: runtime.wasmBytes.slice(0),  // 每次複製一份，避免detached buffer
       inline: true,               // 非interactive spawn模式，批次同步執行
       builtins,                    // host builtin注入表（見§8.1）
       onOutput: (bytes, channel) => {
           this._terminalWriteOutput(session, new TextDecoder().decode(bytes).replace(/\n/g, '\r\n'));
       },
   });
   ```
8. `finally { fsStack.pop(); }`

AI工具用的`_terminalRunCommand(session, line, opts)`（~18339，`terminal_run`背後）
共用一模一樣的`run()`呼叫形狀，額外從`onOutput`累積`stdout`/`stderr`字串（不直接
信任`run()`回傳值本身是否還帶正確內容），回傳`{ok, exit_code, stdout, stderr}`，
並支援`opts.outputFile`/`opts.stderrFile`（JS層直接把累積好的文字寫進沙盒檔案系統，
刻意不用shell的`>`重導向，這樣才不會讓輸出從`stdout`/`stderr`裡消失）。

---

## 6. `cd`/工作目錄的已知限制（重要，AI工具的說明文字也反覆強調）

**根因**：每一次`runtime.run()`呼叫都是全新、無狀態的WASM instance。busybox自己的
`cd`只會影響那一次instance的process狀態，呼叫一返回就消失——沒有真正常駐的shell
process。所以`session.cwd`必須完全由JS層追蹤，且每次`run()`呼叫都要手動在腳本
前面補一次`cd <session.cwd>`（見§5.4步驟4）「還原」虛擬位置。

因此，單獨一行的`cd <path>`**必須**在送進`run()`之前被攔截，把結果寫回
`session.cwd`供之後的指令使用。`_terminalCd(session, target)`（~18298）：

```js
const script = `cd ${quoted(session.cwd)} 2>/dev/null; cd ${quoted(target)} && pwd`;
result = await runtime.run({ command: script, fs: fsStore, wasm: runtime.wasmBytes.slice(0), inline: true });
if (result.exitCode === 0 && result.stdout.trim()) {
    session.cwd = result.stdout.trim();
    return { ok: true, cwd: session.cwd };
}
```

在沙盒內真的執行`cd`+`pwd`（讓busybox自己的路徑解析/`..`規則當權威判斷），再把
印出來的絕對路徑讀回來指派給`session.cwd`。回傳`{ok, cwd, error}`結構化結果，
互動輸入路徑（忽略回傳值，錯誤已經直接寫進終端機畫面）跟AI工具路徑
（`terminal_run`用來正確組出`exit_code`）共用同一份邏輯。

**為什麼`cd x && y`不會持久化**：`_terminalRunCommand`判斷「這一行是不是單獨的
cd」只是簡單字串比對——只有整個trimmed後的行**完全等於**`cd <target>`才會特別處理：

```js
const cmdNameOnly = firstSp === -1 ? trimmedLine : trimmedLine.slice(0, firstSp);
if (cmdNameOnly === 'cd') { ... }
```

`cd x && y`這種複合指令的「第一個字」雖然還是`cd`，但整行不等於單純的`cd x`，
不會命中這個判斷，falls through到`_runTerminalShellLine`——`cd`真的在沙盒內執行了，
但**只影響那一次性的WASM instance**，busybox沒有辦法把「cwd被改了」回報給沒有
真正shell parser的JS呼叫端。**這是文件明講的已知限制**：`terminal_run`工具的
說明文字要求「切換工作目錄要單獨一次呼叫只下`cd <path>`，不要跟其他指令用`&&`
接在一起」。

`_terminalResolvePath(cwd, target)`（~17920，純JS路徑正規化，不碰檔案系統）：
把相對路徑接到`cwd`後面，`split('/')`拿掉空段/`.`，遇到`..`就pop stack，重新
`join`——`chmod`、`sh`腳本路徑解析、`terminal_cp_to/from`、tab補全等到處都在用。

---

## 7. Program Bundles：`pager.mjs` / `editor.mjs` / `top.mjs`

### 7.1 為什麼需要獨立重刻

wasi-sh的README明講「互動式全螢幕工具（vi、less）」不在範圍內——沙盒沒有
fork/exec（「A command name containing a slash is always not found」「No
processes, ever」）。與其硬塞進busybox WASM binary，這三個工具完全用JS/ESM重新
刻一份簡化版。

### 7.2 註冊表與載入

```js
const TERMINAL_PROGRAM_BUNDLES = {
    less: './terminal-programs/pager.mjs',
    more: './terminal-programs/pager.mjs',
    vi: './terminal-programs/editor.mjs',
    vim: './terminal-programs/editor.mjs',
    top: './terminal-programs/top.mjs',
};
```
（~4620；建構子複製一份到`this._terminalProgramBundles`，可用
`registerTerminalProgram(name, bundleUrl)`（~17106）在執行期擴充。）

`_ensureTerminalProgramLoaded(name)`（~17111）——**純動態`import()`，不是Blob URL
trick、不是Web Worker**（跟§3的bash-wasm載入機制不同，因為不需要繞過
`raw.githubusercontent.com`的`nosniff`）：
- 若登記的是`http(s)://`絕對網址（host/AI註冊的外部bundle），直接`import()`。
- 若是內建的相對路徑，先試**原樣相對`import()`**（桌面版可行，因為
  `floating-assistant.js`跟`terminal-programs/`在同一個真實磁碟目錄）；失敗才退回
  CDN鏡像（`terminalProgramsBackupBase =
  'https://cdn.jsdelivr.net/gh/sunneo/tw_stock_db@desktop-app/desktop-app/renderer/'`）
  ——網頁版必然走這條，因為網頁版的`floating-assistant.js`本身是從`blob:`網址執行
  （沒有真實的相對路徑基準）。
- 載入結果快取在`this._terminalProgramModules[name]`。

### 7.3 執行/接管——`_runTerminalProgramBundle(session, mod, name, argsText)`（~19082）

建構一個`ctx`物件跟`program = {feed(data){...}}`控制物件，設定
`session.activeProgram = program`（這正是`_handleTerminalInput`停止行編輯、改把
原始按鍵直接丟給`program.feed`的開關），接著`await mod.run(ctx)`。結束後
`finally`把`session.activeProgram = null`還原成正常行編輯。

**`ctx`契約**（三個bundle檔案開頭都有一致的說明）：
- `ctx.write(text)` — 寫進終端機（自動`\n`→`\r\n`）
- `ctx.readKey()` — `Promise<string>`，resolve時機是下一次`program.feed(data)`被呼叫
- `ctx.readKeyOrTimeout(ms)` — 同上，額外支援`ms`後resolve`null`（`top.mjs`拿來做
  週期性重繪）
- `ctx.fs()` — `async`，回傳跟其餘session共用的同一個`MemoryFs`（`_ensureTerminalFsStore`）
- `ctx.cwd` — 呼叫當下`session.cwd`的快照（非即時更新）
- `ctx.args` — 依`argsText`切出來的參數陣列
- `ctx.cols`/`ctx.rows` — 終端機尺寸快照
- `ctx.sessionStartedAt`、`ctx.idleRefreshMs()`、`ctx.name` — bundle專屬延伸

**為什麼各自重複一份`resolvePath`**：`pager.mjs`/`editor.mjs`各自帶一份跟
`_terminalResolvePath`逐字相同的路徑正規化邏輯——因為它們是透過動態`import()`
從獨立檔案（網頁版甚至是不同CDN網域）載入的ESM模組，沒有辦法呼叫
`FloatingAssistant`實例的private class method，這點小重複被判斷是比硬拉一個
共用模組依賴更簡單/安全的取捨。

### 7.4 各自的功能範圍

- **`pager.mjs`（`less`/`more`）**：讀檔→切行→全螢幕重繪（`\x1b[2J\x1b[H`）＋反白
  狀態列（`-- file (NN%) --`）。按鍵：space/f/Enter/Ctrl+F下頁、b/Ctrl+B上頁、
  j/k或方向鍵單行捲動、g/G跳頭/尾、q/Ctrl+C離開。**沒有搜尋、沒有正規表示式高亮**
  （明講超出範圍）。
- **`editor.mjs`（`vi`/`vim`）**：簡化版模式編輯器，`state = {lines, row, col,
  scrollTop, mode:'normal'|'insert'|'command', commandBuffer, modified,
  pendingKey, statusMsg}`。支援游標移動/插入/刪除/`:w`/`:q`類命令模式。**沒有
  visual mode、沒有undo、沒有正規表示式搜尋替換**。存檔（`overwriteFile()`）要先
  `unlinkSync`+`createFileSync`+`writeSync`——因為沙盒fs的`writeSync`只能讓檔案
  變大不能變小，原地覆寫一份比原檔案短的內容必須先刪除重建。
- **`top.mjs`**：**不模擬process table**（沙盒本來就沒有process可列——「No
  processes, ever」），只顯示這個session自己的uptime、一筆假的「這個session」
  process row、`ctx.cwd`，依`ctx.idleRefreshMs()`（見§15）週期性重繪，q/Ctrl+C
  離開。

---

## 8. Python 模擬器

### 8.1 `SANDBOX_COMMAND_REGISTRY`（~2600）——完整內容與觸發機制

```js
const SANDBOX_COMMAND_REGISTRY = {
    python:  { kind: 'pyodide' },
    python3: { kind: 'pyodide' },
    jq:      { kind: 'jq' },
    xq:      { kind: 'xq' },
    column:  { kind: 'column' },
    split:   { kind: 'split' },
};
```

固定allow-list（不對外部來源做動態查詢/下載——新增指令要先mirror進備份分支再
在這裡登記）。`column`/`split`是純本地JS重新實作的缺漏busybox applet；只有
`python`/`python3`（Pyodide）、`jq`（jq-wasm）、`xq`（fast-xml-parser）真的會
按需下載引擎。

**觸發下載的時機**：`_buildTerminalSandboxBuiltins(script)`（~18226）在**即將要
執行的腳本文字**上做一次regex預掃描（word-boundary），只`await`已經確認被引用
到的指令對應的loader（`_ensurePyodideLoaded`/`_ensureJqLoaded`/
`_ensureXqXmlParserLoaded`），然後把已經resolve好的engine包進closure，組成一份
**純同步**的`builtins`映射：

```js
builtins[name] = (ctx) => this._runSandboxBuiltinCommand(SANDBOX_COMMAND_REGISTRY[name].kind, ctx, resolvedEngines);
```

這份`builtins`就是傳給`runtime.run({..., builtins})`的那個物件——**為什麼要先
await解析完才組同步函式**：wasi-sh釘選版本（0.11.0）的host-builtin handler API
要求**同步**回呼（async/可suspend的builtin會被拒絕），沒辦法在shell真的執行到那
一行時才`await`載入引擎，只能先掃描腳本文字、預先載好用得到的引擎。這套機制被
`_runTerminalShellLine`、`_terminalRunScriptFile`、`_terminalRunCommand`三處共用，
也跟獨立的`bash_execute`AI工具共用同一套邏輯（不是終端機專屬）。

### 8.2 Pyodide載入——`_ensurePyodideLoaded()`（~19225）

單例、快取在`this._pyodideInstance`/`this._pyodideLoadPromise`（**整個App一份
Pyodide instance，不是每個terminal session各自一份**）。標準Pyodide CDN啟動流程
（`pyodide.js` script + `loadPyodide({indexURL})`，主要CDN失敗retry備份鏡像），
載入完成後**無條件**額外做三件事：
1. `registerJsModule('_fa_shell_bridge', {runShell, runPython})`——供Python內
   `subprocess`呼叫回JS橋接。
2. `instance.runPython(PYODIDE_SUBPROCESS_SHIM_SRC)`——monkeypatch
   `subprocess.run`/`Popen`。
3. `registerJsModule('_fa_mp', this._mpBridge())` + `_mpInstallShim(instance)`
   ——安裝multiprocessing shim（見§8.4）。

因為是「無條件」安裝，**任何**用到這個共用instance的呼叫端（終端機`python`
builtin、`python_execute`工具、巢狀`subprocess.run`）都自動拿到這些能力。

### 8.3 跟獨立`python_execute`工具的關係——共用同一個instance，但呼叫方式不同

兩邊都呼叫**同一個**`_ensurePyodideLoaded()`，所以是**同一份**Pyodide/WASM
instance、同一份`pyodide.FS`（Emscripten MEMFS）、同一份shim。

| | 終端機`python`/`python3`（`_runPythonBuiltin`，host builtin） | `python_execute`工具 |
|---|---|---|
| 執行呼叫 | `pyodide.runPython(...)`——**同步**（`_runPyodideScriptSync`） | `await pyodide.runPythonAsync(...)`（`_runPyodideScriptAsync`） |
| top-level `await` | ❌不支援（host builtin handler不能await） | ✅支援 |
| `subprocess.run`/`Popen` | ❌不支援，呼叫直接失敗（工具描述明講：「這個路徑跑的python**不支援top-level await、也不支援subprocess**」） | ✅支援（透過shim） |
| globals隔離 | 不隔離（同一shell腳本內的多次呼叫共用模組層級狀態） | 不隔離（跟終端機一致，只有*巢狀* subprocess呼叫走`isolatedGlobals:true`） |
| 檔案系統橋接 | 每次呼叫都要在wasi-sh的`ctx.fs`（沙盒memoryFs）跟`pyodide.FS`之間顯式複製進/複製出，再清空 | 直接讀寫`pyodide.FS`，每次呼叫後`finally`清空 |

**因為共用instance**，`_runPythonBuiltin`必須嚴謹地在每次呼叫前後都把
`pyodide.FS`的`/work`清空（複製進沙盒fs前先清、寫回沙盒fs後再清），避免兩個入口
互相看到對方遺留的檔案——這是實測踩到的真實bug，之後補上的清理步驟。

### 8.4 Multiprocessing / Web Worker架構

Python端：`FA_MP_SHIM_PY`（一份很長的`String.raw`模板，替換掉`multiprocessing`/
`concurrent.futures`模組）安裝進`sys.modules['_fa_mp_impl']`；`FA_MP_WORKER_PY`
是每個Worker自己的Pyodide instance要跑的接收/執行腳本。

**Worker怎麼被拉起來**：
- `_mpCreateWorker()`——`new Worker(blobUrl, {type:'module'})`，Blob內容是
  `faMpWorkerMain.toString()`（module-level函式，worker內IIFE執行），`postMessage`
  帶`{type:'boot', indexURL, workerPy, shimPy}`讓worker啟動**自己的一份**Pyodide
  instance（同一個`indexURL`來源，但是**獨立的**instance，跟主執行緒那份不是同一個）。
- `_mpAcquire`/`_mpRelease`——小型worker池，上限`Math.max(2, Math.min(8,
  navigator.hardwareConcurrency || 4))`（2~8個），重用、飽和時排隊。
- `_mpRunTask`/`_mpSubmit`——把pickle過的任務payload分派給acquire到的worker，
  最多`n`個同時跑（`Promise.all`拉取共用index）。
- Worker內的`Queue.put`透過`postMessage({type:'qput', qid, data})`寫回主執行緒。

**`pyodide.ffi.run_sync`/JSPI**：Python shim用`run_sync(promise)`把一個JS
Promise「同步化」——讓`Pool.map(...)`這種看起來同步的呼叫能真的暫停整個WASM
呼叫堆疊，等worker的`postMessage`回覆才繼續，同時不會卡住JS事件迴圈。

**規則/限制**（`python_execute`工具說明文字也明講）：
- 進入點必須放在`if __name__ == '__main__':`底下——worker重新執行整份主腳本時
  用`ns["__name__"] = "__mp_main__"`（標準CPython spawn慣例），guard外的程式碼
  在每個worker都會重跑，guard內不會。
- 交給worker的函式必須是**模組最上層具名函式**——`pickle.dumps(task,
  protocol=4)`前置，lambda/巢狀/closure函式pickle會失敗。
- `Value`/`Array`/`Manager`/`Pipe`/`shared_memory`**明確不支援**（拋
  `NotImplementedError`，訊息指向「Web Worker之間不共用記憶體，請用
  Pool.map/apply_async的回傳值，或用Queue（worker端只能put）」）。
- `Lock`/`RLock`/`Event`/`Semaphore`是`threading`同義詞的化妝——只在單一
  interpreter內有效，不是真正跨process同步。
- `set_start_method`/`get_start_method`是no-op樁（`get_start_method`固定回報
  `"spawn"`），`active_children()`固定`[]`。

**⚠️終端機內的`python`指令無法真正平行**：`_parallel_ok()`檢查
`can_run_sync()`，而`_runPythonBuiltin`是走host builtin的**同步**呼叫路徑（不能
await），JSPI的`run_sync`需要async-suspendable的呼叫堆疊，同步路徑下不成立，所以
每次`multiprocessing`/`concurrent.futures`呼叫都會（印一次stderr警告後）自動
退回**單執行緒依序執行**，結果相同但沒有平行加速。只有`python_execute`（走
`runPythonAsync`）才能真的拿到worker平行加速。

### 8.5 `FA_PY_RUN_PRELUDE`/`FA_PY_RUN_POSTLUDE`（~689-715，只有終端機路徑用）

只有`_runPythonBuiltin`（終端機`python`）會跑這組prelude/postlude，`python_execute`
不會：

```js
const FA_PY_RUN_PRELUDE = `
import sys, os, importlib, json
sys.argv = json.loads(__fa_argv_json)
os.makedirs('/work', exist_ok=True)
os.chdir('/work')
_d = os.path.dirname(__fa_script_abs) or '/work'
for _p in (_d, '/work'):
    if _p not in sys.path:
        sys.path.insert(0, _p)
for _n, _m in list(sys.modules.items()):
    _f = getattr(_m, '__file__', None) or ''
    if _f.startswith('/work/'):
        del sys.modules[_n]
importlib.invalidate_caches()
__file__ = __fa_script_abs
`;
```

目的：讓終端機裡的`python script.py`行為貼近真實情況（`cwd=/work`、腳本所在
目錄加進`sys.path`讓`from calc import add`這種同目錄import能解析成功），並且
**每次呼叫都清掉`/work`來源的舊模組快取**——避免使用者改過一份`.py`檔案後重跑，
卻因為`sys.modules`快取還留著上一版而看到舊行為（實測踩到的真實bug）。Postlude
對稱地把`sys.argv`/`sys.path`/cwd/`__file__`還原、模組快取再清一次。

---

## 9. `ask-floating-ai-assistant` 虛擬指令

### 9.1 由來（使用者原話，~17827）

> 「xterm環境要新增一個虛擬的程式自動註冊在PATH內，叫做
> ask-floating-ai-assistant」「行為相當於FloatingAssistantApp -p」「這是一個
> 獨特的功能，在網頁的虛擬環境內可以利用LLM Model來回應，做些特別的程式或判斷」

### 9.2 語法

```
ask-floating-ai-assistant [--format text|json] <問題>
```

`_terminalAskAI(session, argsText)`（~19024）解析選填的`--format`旗標，其餘全部
當作prompt文字；空prompt或不支援的格式會印錯誤/用法，不會真的呼叫模型。

### 9.3 本質：完整agentic loop委派，不是單次LLM呼叫

```js
result = await this._runSubAgentTask(prompt, SUBAGENT_DELEGATE_MAX_ROUNDS);
```

`_runSubAgentTask`（~27934）是跟`delegate_to_subagent`共用的同一個通用子任務
執行器——因為呼叫時**沒有**傳`allowedToolNames`/`systemPrompt`限制，等於是
**根層級**的agentic loop：看得到全部工具、用主system prompt，可以跨多輪工具呼叫
（上限`SUBAGENT_DELEGATE_MAX_ROUNDS = 20`），API層級的重試/model fallback也跟主
對話同一套。

**設計歷程**（~18994）記錄了實測修正：
1. 「那個回應500是不被接受的」「他的邏輯必須跟FloatingAssistantApp本體一樣」——
   失敗容忍度要跟主對話一致，不能一遇到暫時性錯誤就直接放棄。
2. 「體驗上必須完全跟cli版本一致」——原本第一版用範圍較窄的
   `_delegateToSubagentAuto()`（需要先選一個「domain」），實測發現連「hi」「現在
   幾點」這種簡單問題都會被domain路由擋下來拒答，才改成直接呼叫
   `_runSubAgentTask`（等同根層級、看得到所有工具跟系統提示）。

### 9.4 回應方式——直接寫進終端機，無跨次記憶

```js
const answer = String((result && result.text) || '').trim();
if (format === 'json') {
    session.term.write(JSON.stringify({ ok: true, prompt, response: answer, elapsed_ms }) + '\r\n');
} else {
    session.term.write(answer + '\r\n');
}
```

不會推進`this.messages`、不會觸發主聊天UI；等待期間每5秒印一次心跳（抄CLI的
`runCliPrompt()`同樣格式）。**每次呼叫都是全新、獨立的一次`_runSubAgentTask`
呼叫**——這個虛擬指令的前一次問答不會被自動帶進下一次呼叫（沒有跨呼叫的對話
記憶），但**單次**呼叫內部本身可以是多輪工具呼叫的agentic loop。

### 9.5 沒有自動context注入

`_terminalAskAI`只把`session`拿來`session.term.write(...)`輸出，**不會**自動把
`session.cwd`、最近的終端機輸出、沙盒檔案內容塞進prompt——需要的話使用者要自己
在問題文字裡描述/貼上。

### 9.6 沒有更短的別名；`/bin/`路徑正規化

搜尋全檔沒有找到任何別名註冊（例如`ai`、`ask`）——只有
`ask-floating-ai-assistant`這個完整名稱可以用。§5.3第10項的`/bin/<name>`
passthrough規則讓`/bin/ask-floating-ai-assistant <問題>`也能正常運作，但那是
路徑前綴正規化，不是另一個別名。

---

## 10. 檔案搬運：`terminal_cp_to` / `terminal_cp_from`

### 10.1 AI工具（`registerOptional`，domain-gated，只有`coding` domain看得到）

| 工具 | 參數 | 行為 |
|---|---|---|
| `terminal_create`（~8888） | `{name?, initial_command?}` | 建立新終端機，回傳`{id, name}` |
| `terminal_list`（~8906） | 無 | 列出目前mounted的所有session（id/name/cwd/has_focus/last_active_at） |
| `terminal_run`（~8915） | `{id_or_name, command, output_file?, stderr_file?}` | 執行一行、拿到`{ok, exit_code, stdout, stderr}` |
| `terminal_get_text`（~8938） | `{id_or_name}` | 取得畫面目前顯示文字（≤500行） |
| `terminal_cp_to`（~8956） | `{id_or_name, src, dst_path}` | 複製檔案進沙盒 |
| `terminal_cp_from`（~8986） | `{id_or_name, src_path, dst?}` | 從沙盒取出檔案 |

`terminal_cp_to`的`dst_path`若是資料夾（結尾`/`或已存在的目錄）就沿用來源檔名；
`terminal_cp_from`的`dst`留空＝存成附件並直接顯示下載卡片。

### 10.2 slash指令（不經過AI，直接呼叫底層方法）

`/run-terminal-cp-to [name=xxx] <來源> <目的地路徑>`（~4963，
`_handleTerminalCpToCommand`~17201）、`/run-terminal-cp-from [name=xxx] <沙盒內路徑>
[目的地]`（~4968，`_handleTerminalCpFromCommand`~17228）——跟`/run-terminal`同一種
`name=`前綴寫法。`name=`留空時，`_resolveTerminalCpTarget(name)`會在「目前只開一個
終端機」時自動選用，開多個必須明講避免猜錯目標。

### 10.3 `_resolveTerminalCopySource(src)`（~18443）——來源三選一

1. `fap:<名稱或id>/<路徑>`——透過`_readFapFileBytes`直接用
   `FileSystemFileHandle.getFile()`讀bytes（不經過`fap_read_file`那套純文字限制，
   任何格式都能讀）。
2. 附件`file_id`（優先精確比對）或檔名（`_resolveUploadedFileRecord`模糊比對）——
   `this.fileCache.get`。
3. （僅桌面版）真實磁碟絕對路徑——`window.desktopAPI.rawfs.readFile(s, 'base64')`。
   網頁版沒有這個能力，會在這一步明確報錯（不會誤把字串當路徑送出去卻靜默失敗）。

### 10.4 `_writeTerminalCopyDestination(dst, bytes, filenameHint, mimeType)`（~18472）——目的地三選一

1. 留空——`fileCache.put`+`_deliverExistingCacheFile`，變成聊天裡的下載卡片。
2. `fap:<名稱或id>/<路徑或資料夾>`——`_writeFapFileBytes`（`createWritable()`直接
   寫bytes）。
3. （僅桌面版）真實磁碟絕對路徑/資料夾——`window.desktopAPI.rawfs.writeFile`，
   自動偵測目標是不是既有目錄來決定要不要補檔名。

---

## 11. File Access Point（FAP）整合：`/mnt`

### 11.1 掛載模式——hydrate-and-flush

`/mnt/<label>`一開始只塞一個`.keep`空佔位（§4），**不會**一開terminal就把整個
FAP資料夾內容讀進來（可能很大、拖慢每次開終端機的速度）。第一次有指令真的提到
`/mnt/<label>`時，才觸發完整讀取。

### 11.2 `_hydrateFapMount(session, fsStore, label)`（~17953）

```js
if (session.fapHydrated.has(label)) return;
session.fapHydrated.add(label);  // 先標記，避免同一輪掃描的巢狀/並發呼叫重複hydrate
rec = await this._resolveFapAccessPoint(label);
await this._checkFapPermission(rec, 'read');   // 權限不是granted會自動跳授權對話框（見11.4）
```
遞迴`walk(dirHandle, relPath)`把整棵目錄樹讀進`fsStore`，同時記錄
`session.fapManifest[label][relPath] = {size, mtime, hash}`——這份manifest是
雙向sync（§11.3）判斷「哪一邊被改過」的基準。

`_hydrateReferencedFapMounts(session, fsStore, text)`（`_runTerminalShellLine`每次
執行前都會呼叫）掃描指令文字裡提到的`/mnt/<label>`前綴，觸發對應的hydrate（或
已hydrate過的話走pull，見下）。

### 11.3 雙向sync——`sync`指令 / `_terminalPullFap`（~18004）

`session.fapManifest[label][相對路徑]`同時記錄「上次同步時」真實檔案狀態跟沙盒
內容的hash，pull（真實→沙盒）/push（沙盒→真實）都靠比對這份manifest判斷「哪一邊
改過」：只有一邊改過就直接套用到另一邊，**兩邊都改過視為衝突**（保留沙盒現況、
回報衝突，不覆蓋任一邊）。

`sync`指令（`_terminalSync`，~18164）：`sync`（無參數）＝對所有已讀取過的掛載先
pull再push；`sync <label>`只處理一個；`--pull`只從真實資料夾更新沙盒、`--push`
只把沙盒寫回、`--delete`才會讓沙盒裡刪掉的檔案也刪除真實檔案。每次執行指令前都會
重新掃描已授權FAP清單（新授權的FAP馬上出現在`/mnt`），已hydrate過的掛載會自動
pull（有節流：`minGap = max(4000ms, 上次pull耗時*10)`，避免大資料夾每個指令都
重新掃一次拖慢互動）。

### 11.4 失去授權的FAP仍可見（2026-09-24修正）

原本`_ensureTerminalFsStore`/`_refreshTerminalFapLabels`（~18144）只列
`permission==='granted'`的FAP，理由是「還沒授權就列出來，一cd進去就跳permission
dialog太突兀」——但使用者明確要求反過來：失去授權（被瀏覽器重置）的FAP要能被
看到/cd到/touch到，一access就跳授權要求，而不是使用者根本不知道曾經有這個FAP
存在。改成不篩permission、一律列出（`/mnt`跟🔀GUI的FAP分頁都是），點進去時
`_hydrateFapMount`內部的`_checkFapPermission`本來就會自動跳授權對話框（見
`_showFapPermissionDialog`，~10237，`z-index:2147483647`確保不被其他全螢幕overlay
擋住），沒有另外寫觸發邏輯，純粹是拿掉「隱藏」這一步。

---

## 12. 檔案傳輸GUI（🔀按鈕）

### 12.1 入口

終端機widget標題列的`.ai-terminal-transfer-slot`（跟`.ai-terminal-export-slot`
匯出按鈕並排）掛一個🔀按鈕，點擊呼叫`_openTerminalTransferDialog(session)`
（~18532）——lazy lookup當下的`terminalEmbedEl._terminalSession`（因為
`_mountTerminalWidget`是async，按鈕建立當下session可能還沒真的掛載完成）。

### 12.2 版面——FileZilla風格雙欄

- **左邊**四個分頁：
  - `💬 當下聊天`——`fileCache.getAll()`，依`createdAt`排序，區分📎附件／🤖產生。
  - `🔗 FAP`——先列已授權（含失去授權，§11.4）的FAP當「根」，點進去用
    `_fapListFiles`瀏覽子資料夾，失去授權的標「🔒需要重新授權」。
  - `📂 Working Directory`（僅桌面版）——`window.desktopAPI.workspace.get()`當根。
  - `💻 Computer`（僅桌面版）——`window.desktopAPI.rawfs.listDrives()`列磁碟機當
    根（`main.js`的`fa:rawfs:listDrives` IPC，win32逐一嘗試A-Z槽`fs.stat`成功才
    列入，非win32回傳`/`）。
- **右邊**固定是這個terminal session的沙盒檔案系統，從`/`開始，完整讀寫刪權限
  （直接操作`fsStore`的`readdirSync`/`statSync`/`unlinkSync`）。

### 12.3 複製/刪除邏輯——重用cp_to/cp_from底層，不重寫邏輯

- 左→右複製：把「目前瀏覽到哪、勾了誰」轉成`_resolveTerminalCopySource`已經認得
  的字串格式（`fap:...`/附件id/真實路徑），呼叫`_terminalResolvePath`+
  `_writeBytesToTerminalFs`寫進沙盒。
- 右→左複製：讀沙盒bytes（`_terminalSandboxFileBytes`），依左邊分頁決定
  `dst`字串（chat分頁＝空字串觸發下載卡片；其餘分頁＝目錄路徑，交給
  `_writeTerminalCopyDestination`）。
- 刪除：左邊FAP走`dirHandle.removeEntry`、Working Directory/Computer走
  `window.desktopAPI.rawfs.remove`；右邊沙盒走`fsStore.unlinkSync`。**刻意只支援
  檔案**——資料夾只能點進去瀏覽，不能勾選/複製/刪除（遞迴複製/刪除的邊界案例
  超出範圍）。刪除前一律`window.confirm`二次確認。

---

## 13. 匯出功能（PPTX / PDF）

### 13.1 匯出按鈕——`_appendCardExportButton`

終端機widget的`.ai-terminal-export-slot`掛一個匯出按鈕，`getSnapshotFn`：

```js
const session = terminalEmbedEl._terminalSession;
if (!session) return null;
await new Promise((resolve) => session.term.write('', resolve));  // drain，見下
const text = this._captureTerminalScreenText(session);
return text ? { kind: 'terminal', text } : null;
```

`extraFormats = []`——**匯出選單只有PPTX跟PDF兩個選項**（不像3D場景/2D動畫卡片
還有MP4/STL/OBJ/3MF）。

**drain-before-capture的理由**：xterm.js的`term.write()`是非同步佇列處理，緊接在
最後一次真實輸出之後立刻讀`buffer.active`有機會讀到還沒flush進buffer的舊畫面。
寫入一個空字串、帶完成callback，等這個callback觸發時，前面所有排隊中的write
（含指令輸出、新prompt）保證都已經套用進buffer，這時候再同步讀取才可靠。這個
drain手法在`_persistTerminalSnapshot`（§14.1）也用同一招。

`_captureTerminalScreenText(session)`（~17471）：最多讀最近500行（獨立於xterm
本身`scrollback`設定之上的額外上限，避免持久化快照跟著使用者調大的scrollback一起
膨脹），trim掉尾端的空白行，`join('\n')`。

### 13.2 PPTX——固定一張投影片

`_faMarkdownToPptxBlob('', '終端機記錄', [snap])`——markdown引數是空字串，內容
完全靠`visualSnapshots`陣列帶。`_faAppendVisualSnapshotSlides`裡`kind==='terminal'`
跟`kind==='viewer_summary'`共用同一段純文字render分支：

```js
s.addText(_faMdLiteToPlainText(snap.text), {
    x: 0.6, y: 1.3, w: 12.1, h: 5.7,
    fontFace: 'Calibri', fontSize: 14, color: FA_EXPORT_PALETTE.txt,
    align: 'left', valign: 'top', lineSpacingMultiple: 1.3, fit: 'shrink',
});
```

一張標題投影片＋固定尺寸文字框，靠`fit:'shrink'`自動縮小字級塞進框內。**這條路徑
不會呼叫`_faChunkTextByLength`**（那個只用在AI回覆markdown文字超過900字元時跨投
影片切分）——不管捕捉到的終端機文字多長，永遠只落在一張投影片上。等寬字型
（終端機本身的monospace排版）在匯出時會遺失，改用比例字型`Calibri`。

### 13.3 PDF——pdfmake自動分頁

`_faMarkdownToPdfBlob`同樣把`{kind:'terminal', text}`塞進`content`陣列（style
`body`，10.5pt），pdfmake本身會依內容長度自動流到下一頁（正常的PDF分頁行為，
不是這裡額外寫的分頁邏輯）。

### 13.4 其他取得終端機內容的管道

- **`terminal_get_text`AI工具**（~8938）——跟匯出按鈕同一套drain+capture邏輯，
  回傳JSON給AI，AI可以在自己的回覆文字裡引用，間接透過AI回覆本身的
  Markdown/PPTX/PDF匯出（`_appendMarkdownExportButton`）取得。
- **`terminal_run`的`output_file`/`stderr_file`**——只是把輸出寫進沙盒內的路徑，
  仍然要另外用`terminal_cp_from`或GUI才能真正取出bytes，不是獨立的匯出管道。
- 沒有剪貼簿複製按鈕（全檔唯一的`navigator.clipboard`用途是瀏覽器控制配對碼，
  跟終端機無關）。

---

## 14. 狀態持久化（跨重新整理）

### 14.1 `_persistTerminalSnapshot(session)`（~17495）——何時觸發、寫什麼

**觸發時機**：每個指令執行完、控制權回到prompt的當下——鍵盤Enter路徑
（`_handleTerminalInput`）跟`initialCommand`路徑（`_runTerminalInitialCommand`）
都在指令跑完後呼叫一次。刻意**不是**每個按鍵都存（太貴，每次都要重新序列化整個
對話），「指令執行完」是符合使用者原話「refresh時要恢復畫面」的天然存檔點，不是
逐字元同步。

```js
await new Promise((resolve) => session.term.write('', resolve));  // 同§13.1的drain理由
const savedScreen = this._captureTerminalScreenText(session);
Object.defineProperty(session.msg, '_displayTerminal', {
    value: { ...(session.msg._displayTerminal || {}), savedScreen },
    enumerable: false, configurable: true,
});
this._persistChatHistory();
```

### 14.2 重新整理後的恢復——只恢復畫面文字，不恢復process

`_mountTerminalWidget`讀回`savedScreen`：

```js
if (savedScreen) {
    term.write(savedScreen.replace(/\n/g, '\r\n'));
    term.write('\r\n\x1b[90m[以上是重新整理前保留的畫面內容——這是全新的session，' +
               '不是恢復原本執行到一半的程式，需要的指令請重新輸入]\x1b[0m');
}
```

**這是純文字replay，不是真的process還原**——每次重新整理都會建立全新的
`Terminal`跟全新的`session`物件（`cwd`重設回`/work`、指令歷史清空、WASM shell
狀態從零開始），`savedScreen`只是被寫進新終端機的畫面當「這是之前長的樣子」的
視覺參考，接著印出灰字提醒，然後才印出真正全新的prompt。使用者原話：「refresh
的時候要恢復畫面，但不用保留process狀態，就讓終端機的command恢復等待輸入」——
WASM shell的process狀態本來就沒有被真的持久化過，也沒必要（vi正在編輯到一半的
內容、背景跑到一半的迴圈都不會恢復，只有「畫面長什麼樣子」這個視覺記錄）。

### 14.3 `_liveWidgetCache`——避免無關的重繪把終端機歸零

建構子宣告`this._liveWidgetCache = new WeakMap()`——鍵是**訊息物件**，值是**已經
掛載好的DOM節點**（不是session物件本身，但session透過DOM節點間接存活，見下）。

終端機的`msg._displayTerminal`分支最前面：

```js
if (msg._displayTerminal) {
    if (this._liveWidgetCache.has(msg)) {
        container.appendChild(this._liveWidgetCache.get(msg));
        return;
    }
    // ...建立新wrap、掛xterm...
    this._liveWidgetCache.set(msg, wrap);
```

**快取的是DOM節點**（外層卡片容器`wrap`），不是session物件——但因為`wrap`底下的
`.ai-terminal-embed`元素上掛著`terminalEmbedEl._terminalSession = session`，重用
DOM節點就等於連帶保住了那個活的xterm.js `Terminal`實例（內部渲染狀態、游標、
scrollback）跟JS `session`物件（`cwd`、歷史、已標記可執行的路徑等）全部原封不動。

**為什麼需要這個快取**：同一輪AI回覆裡如果呼叫了多個工具，任何一次工具呼叫都可能
觸發`_renderMessageHistory()`把整個`chatBody`清空重繪——沒有這層快取，使用者剛打
到一半的指令、正在跑的`vi`session都會憑空消失。因為是`WeakMap`鍵在訊息物件上，
訊息真的被`pruneContext`丟棄（不再被`this.messages`/`archivedDisplayBlocks`引用）
時，快取項目跟著自動可以被GC，不需要手動清理。

---

## 15. 多終端機資源管理政策

### 15.1 `advancedSettings.terminal.resourcePolicy`——四種模式

`_terminalSessionIsLive(session)`（~17330）：

```js
_terminalSessionIsLive(session) {
    const policy = this.advancedSettings.terminal?.resourcePolicy || 'focus';
    if (policy === 'unlimited') return true;
    if (policy === 'viewport') return session.inViewport !== false;
    if (policy === 'count') {
        const limit = Math.max(1, Number(this.advancedSettings.terminal.resourceCountLimit) || 3);
        const ranked = this._getMountedTerminalSessions().sort((a, b) => (b.lastActiveAt||0) - (a.lastActiveAt||0));
        return ranked.slice(0, limit).includes(session);
    }
    return session.hasFocus === true;  // 'focus'（預設）
}
```

| 模式 | 判斷依據 |
|---|---|
| `focus`（預設） | 只有目前有鍵盤焦點（`session.hasFocus`）的那個session算「活的」 |
| `viewport` | 只有捲進可視範圍內（`session.inViewport`）的算活的 |
| `count` | 依`lastActiveAt`排序，取前N個（`resourceCountLimit`，預設3） |
| `unlimited` | 全部都算活的，不節流 |

`_terminalIdleRefreshMs(session)`（~17343）：活的session維持1秒重繪節奏，非活的
放慢到5秒——這個節奏是給`top.mjs`這類需要週期性重繪的program bundle用
（`ctx.idleRefreshMs()`），**跟xterm.js本身的即時輸出渲染無關**（有新輸出永遠
立刻`term.write()`，不受這個節流影響）。

### 15.2 IntersectionObserver——重要澄清：終端機跟2D動畫是兩套完全不同的機制

檔案裡有**兩處**`IntersectionObserver`，職責不同，**不要混為一談**：

1. **終端機**（`_mountTerminalWidget`）：`threshold:0.1`，callback只是設定
   `session.inViewport = entry.isIntersecting`這個旗標，**不會暫停任何渲染迴圈**。
   唯一消費者是`_terminalSessionIsLive`的`'viewport'`分支，間接影響的只是
   `top.mjs`這類全螢幕程式的重繪節奏（1秒vs5秒）——**xterm.js本身的字元/輸出渲染
   完全不受影響，捲出畫面外照樣即時渲染**。
2. **2D動畫canvas viewer**（另一個獨立功能，跟終端機無關）：`threshold:0`，
   `visible=false`時直接**停止**重新排程`requestAnimationFrame`，是真正會暫停
   render loop、省CPU的機制。

**結論**：「捲出可視範圍就暫停render loop降低CPU消耗」這個優化**只用在2D動畫
canvas widget**，終端機的IntersectionObserver是另一套、用途窄得多、也不會真的
暫停任何東西。

---

## 16. Advance Settings →「終端機」分頁設定

存在`advancedSettings.terminal`（`_createDefaultAdvancedSettings()`給預設值，
`_normalizeTerminalSettings(raw)`驗證/矯正），套用時機是**下一次**開啟的
`/run-terminal`（已掛載的既有終端機不會即時變更外觀，避免互動中畫面突然重排）：

| 欄位 | 預設值 | 說明 |
|---|---|---|
| `fontFamily` | `'monospace, monospace'` | |
| `fontSize` | `13` | 8–32 |
| `cols` | `0` | `0`＝不覆寫，沿用xterm.js預設(80)；`>0`才真的套用 |
| `scrollback` | `1000` | xterm自己的環狀緩衝上限 |
| `scrollToOutputEnabled` | `true` | 關閉時新輸出不會打斷使用者正在往上捲看的位置 |
| `theme` | `'system'` | `system`跟隨App目前亮暗模式；其餘四種固定色票（見§2.2） |
| `resourcePolicy` | `'focus'` | `focus`/`viewport`/`count`/`unlimited`（見§15.1） |
| `resourceCountLimit` | `3` | 只有`resourcePolicy==='count'`時有意義 |

---

## 17. 已知限制彙整

| 限制 | 根因 | 因應方式 |
|---|---|---|
| 沒有真正常駐的shell process | 每次`runtime.run()`都是全新WASM instance | `cwd`由JS層追蹤，每次呼叫前手動`cd`還原（§6） |
| 複合指令`cd x && y`不會持久化cwd | 沒有真正shell parser，只做「整行等於`cd <target>`」的字串判斷 | 文件明講：切cwd要單獨一次呼叫 |
| 沒有互動式全螢幕程式（真正的vi/less/top） | busybox沙盒沒有fork/exec | 用JS重新刻簡化版（`pager.mjs`/`editor.mjs`/`top.mjs`，功能有限，見§7.4） |
| 終端機內的`python`不支援`subprocess`/top-level await/真平行multiprocessing | Host builtin handler必須同步、不能`await` | 明確引導改用`python_execute`工具（走async路徑，功能完整） |
| `multiprocessing.Value/Array/Manager/Pipe`不支援 | Web Worker之間不共用記憶體 | 拋`NotImplementedError`並提示改用`Queue`/回傳值 |
| PPTX匯出的終端機截圖永遠只有一張投影片 | 沒有跨投影片分頁邏輯，只靠`fit:'shrink'` | 內容很長時字級會被自動縮到很小，沒有文字截斷 |
| 檔案傳輸GUI/`cp_to`/`cp_from`只支援檔案 | 資料夾遞迴複製/刪除的邊界案例超出範圍 | 資料夾只能瀏覽，不能勾選/操作 |
| `ask-floating-ai-assistant`沒有跨呼叫記憶 | 每次都是全新`_runSubAgentTask`呼叫 | 需要延續上下文要自己在問題裡重述 |
| 重新整理頁面只恢復畫面文字，不恢復process | 從未真的持久化WASM shell狀態，也沒必要 | 使用者原話已確認「不用保留process狀態」 |
| 網頁版才需要跑`terminal-programs/*.mjs`的CDN鏡像備援 | 網頁版`floating-assistant.js`本身從`blob:`執行，沒有真實相對路徑基準 | 桌面版走本機相對`import()`，網頁版retry CDN鏡像 |
| `sleep`/`curl`/`wget`/`httping`/`make`不能跟其他指令用管線/重導向接 | JS層攔截，根本沒有送進WASM shell的parser（見§19.1） | 各自用旗標取代（`-o`/`-O`指定輸出檔） |
| `m4`不是100% GNU m4相容 | 純JS重寫，查證過沒有可靠的瀏覽器WASM移植版 | 支援常見子集，見§19.2列出的builtin清單與排除項目 |
| `make`沒有真正的mtime比對 | wasi-sh沙盒fs沒有時間戳（README:「No symlinks, permissions, or timestamps」） | 簡化規則：目標不存在、或是`.PHONY`、或任一依賴這次真的被重建過，才重跑recipe（見§19.3） |

---

## 18. 相關檔案清單

| 檔案 | 角色 |
|---|---|
| `desktop-app/renderer/src/floating-assistant.js` | 唯一可編輯原始碼，本文件涵蓋的幾乎所有邏輯都在這裡（`class FloatingAssistant`） |
| `desktop-app/renderer/floating-assistant.js` / `.min.js` | `build-assistant.js`（`terser`）壓縮出的build output，桌面版`<script src>`跟網頁版runtime `fetch()`都吃這個路徑，內容跟`src/`版同步 |
| `desktop-app/renderer/terminal-programs/pager.mjs` | `less`/`more` |
| `desktop-app/renderer/terminal-programs/editor.mjs` | `vi`/`vim` |
| `desktop-app/renderer/terminal-programs/top.mjs` | `top` |
| `desktop-app/renderer/terminal-programs/make.mjs` | `make`（2026-09-25新增，見§19.3） |
| `desktop-app/scripts/split-asset-for-branch.js` | 「package為單位的backup分支」產出端工具：把本機大檔案切成≤20MB的`.partNNN`＋維護`manifest.json`，格式跟`_fetchAssetBackupFile()`完全對齊（見§19.4） |
| `desktop-app/scripts/merge-asset-from-branch.js` | 上面那支的反向操作，本機驗證/還原用 |
| `desktop-app/main.js`（`fa:rawfs:listDrives`等IPC） | 桌面版限定的real-OS檔案系統橋接，供檔案傳輸GUI的Working Directory/Computer分頁使用 |
| `desktop-app/preload.js` | 對應`window.desktopAPI.rawfs.*`/`workspace.*`介面 |

---

## 19. 2026-09-25新增：網路指令／m4／make／「package為單位」backup分支

### 19.1 `sleep` / `curl` / `wget` / `httping`

跟`ask-floating-ai-assistant`同一種JS層攔截（見`TERMINAL_SHELL_BUILTINS`新增這四個名稱、
`_runTerminalCommand`裡的攔截分支）——`curl`/`wget`/`httping`的核心動作
（`fetch()`）是非同步，而`SANDBOX_COMMAND_REGISTRY`那條host builtin路徑要求
**同步**callback（wasi-sh host-builtin handler API不支援async，跟終端機`python`
不支援top-level await是同一個根因），沒辦法用那套機制做真的網路請求。代價：
**不能放進shell管線/重導向**（`curl url | jq .`不會生效），改用`-o`/`-O`旗標
指定輸出檔案彌補。

**網路層**：`_terminalHttpFetch(method, url, opts)`一律經過既有的
`_viaAssetProxy()`（`/proxy/<url>`通用轉發，桌面版走`local-proxy.js`、網頁版走
使用者部署的Cloudflare Worker——跟git操作/資源備援下載同一套機制，不是新發明的
網路層）。桌面版預設就有`assetBackupProxyUrl`指向本機proxy，`curl`/`wget`/
`httping`開箱即用；沒設定代理時對大多數外部網站會因為CORS直接失敗，錯誤訊息會
主動提示去哪裡設定。

支援的旗標子集：`curl`（`-X`/`-H`/`-d`/`-o`/`-I`/`-i`/`-s`/`-L`）、`wget`
（`-O`/`-q`，沒給`-O`時依網址最後一段路徑猜檔名）、`httping`（`-c`次數預設5
上限50、`-i`間隔秒數，預設HEAD請求，最後印min/avg/max摘要）。`sleep`支援
s/m/h單位，上限3600秒（沙盒沒有Ctrl+C中斷執行中指令的機制，設上限避免打錯
數字卡死太久）。

**`terminal_run`工具整合的真實bug**：這四個指令（跟`make`）一開始只接進
`_runTerminalCommand`（互動輸入路徑），完全沒有接進`_terminalRunCommand`
（`terminal_run`工具背後的AI-tool路徑）——後者原本只特別處理`cd`，其餘一律
直接送進真正的WASM busybox（busybox裡根本沒有這幾個指令，AI呼叫
`terminal_run`執行`curl ...`會得到`command not found`，只有使用者自己在畫面上
打字才會生效）。已修正：`_terminalRunCommand`新增同一批攔截，並用
`_terminalCaptureWrites(session, fn)`（暫時替換`session.term.write`成一個
「先記錄、再呼叫原本write」的wrapper，畫面上使用者一樣即時看得到輸出）取得
這次呼叫期間的純文字輸出，轉成`{stdout, stderr, exit_code}`回傳給AI——用
`\x1b[31m`（這幾個方法一致採用的錯誤色）字串偵測「這次有沒有印過錯誤」決定
exit_code，是簡化判斷（不是真正逐行分開的兩個串流），不是縮水，這個沙盒本來
就沒有真正分開的stdout/stderr概念。已用真實Electron驗證（透過`terminal_run`
工具，非互動輸入）：`sleep 1`正確耗時~1秒；`curl -I`對`raw.githubusercontent.com`
拿到真實200回應與headers；`curl -o`/`wget -O`都正確下載真實檔案（260 bytes）
進沙盒並可用`cat`/`wc`讀回；`httping -c 3`正確量測3次真實round-trip時間並印
統計摘要。

### 19.2 `m4`

`SANDBOX_COMMAND_REGISTRY`新增`m4:{kind:'m4'}`（純本地JS實作，不需要下載——
查證過沒有任何可靠的瀏覽器WASM移植版GNU m4，見下方「查證過程」）。核心是
`_m4Expand(text, defines, quoteState, ctx, depth)`遞迴掃描/展開，支援的builtin：
`define`/`undefine`/`defn`/`ifdef`/`ifelse`/`dnl`/`changequote`/`include`/`len`/
`substr`/`index`/`eval`/`shift`/`translit`/`dumpdef`。**明確不支援**：
`divert`/`undivert`（輸出分流）、`regexp`/`patsubst`（m4的regex語法跟JS不同，
轉譯風險高，乾脆不做）、`eval()`只支援基本四則運算/比較/邏輯（不支援完整運算子
優先權表與進位制前綴）。

**踩到的真實bug**：`_m4ParseArgs`（負責找出頂層逗號/右括號位置，正確跳過nested
quote）回傳的原始引數文字**保留quote分隔字元本身**（那不是它的職責，quote的
解讀是讀取時才做的事）——但`define`/`ifelse`/`ifdef`這幾個「引數要保持未展開」
的巨集，如果直接把帶著quote字元的raw文字存起來/傳回去，之後被交回`_m4Expand`
重新掃描時，最外層那個quote會把整段內容吃成「一段引號內文字」，導致巨集呼叫
完全不會被展開。實測案例：教科書等級的m4遞迴階乘測試
`` define(FACT,`ifelse($1,0,1,`eval($1*FACT(eval($1-1)))')')FACT(5) ``
原本完全展開失敗，整段`ifelse(...)`原封不動被當成字面文字印出來。新增
`_m4UnquoteRaw(raw, quoteState)`——剝掉「剛好包住整段引數」的最外層一組quote
（真實m4的reader也是這樣：quote只在被讀取時剝一層，不做任何展開），套用在
`define`的name/body、`ifdef`/`ifelse`的then/else分支、`undefine`/`defn`/
`dumpdef`的名稱參數。修正後階乘測試正確算出`120`。

已用獨立單元測試驗證16個案例全過（define/ifdef footgun對照組、遞迴階乘、
quote/changequote、eval四則運算、dnl註解丟棄等），另外用真實Electron驗證
透過`echo '...' | m4`這種真正的shell pipe（`terminal_run`工具路徑）也正確運作
——這是單元測試無法涵蓋的部分（stdin讀取、`SANDBOX_COMMAND_REGISTRY`跟
`_buildTerminalSandboxBuiltins`的即時整合）。

### 19.3 `make`

`TERMINAL_PROGRAM_BUNDLES`新增`make: './terminal-programs/make.mjs'`（純JS
重寫，理由同m4——查證過沒有任何可靠的瀏覽器WASM移植版GNU make）。支援子集：
變數指派（`=`/`:=`/`?=`/`+=`）與`$(VAR)`/`${VAR}`展開、規則（`target: prereqs`
+ tab縮排recipe）、`.PHONY`、單一`%`的pattern rule（例如`%.o: %.c`）、自動變數
（`$@`/`$<`/`$^`/`$*`）、行尾`\`接續、`#`註解、recipe行開頭`@`靜音/`-`忽略
失敗。**明確不支援**：條件式（`ifeq`/`ifdef`/`else`/`endif`）、`include`、函式
呼叫（`$(wildcard ...)`/`$(shell ...)`等）、`-j`平行建構、`-k`。「要不要重建」
用簡化規則（目標不存在、或是`.PHONY`、或任一直接依賴這次真的被重建過）取代
真正的mtime比對——這個沙盒檔案系統本來就沒有時間戳可比。

recipe指令透過新增的`ctx.runShell(line)`（program bundle ctx契約第一次需要真的
執行shell指令的情境，`_runTerminalProgramBundle`新增這個欄位，直接重用
`_terminalRunCommand`，輸出即時串流進畫面、也拿得到exit_code判斷recipe是否
失敗要停下來）真的丟進WASM busybox ash執行，不是自己模擬。

**`terminal_run`整合**：跟sleep/curl/wget/httping同一個bug類別，但`make`的修法
不同——不是通用地讓所有program bundle都能透過`terminal_run`執行，因為
`less`/`vi`/`vim`/`top`都要等鍵盤輸入（`ctx.readKey`/`readKeyOrTimeout`），AI
呼叫`terminal_run`沒有辦法送出按鍵，通用開放的話會直接卡死整個呼叫。`make.mjs`
本身完全不用`ctx.readKey`（設計上就是跑到底、不等互動輸入），所以新增專屬的
`_terminalRunMakeViaTool(session, argsText)`（建構一個沒有`readKey`欄位的精簡
ctx），只有`make`透過`_terminalRunCommand`可以執行，其餘program bundle維持
只能互動輸入使用。

已用mock檔案系統/mock shell的單元測試驗證5個案例（基本規則建構、phony+
up-to-date跳過邏輯、pattern rule自動變數、變數展開、recipe失敗時停止建構）
全過，另外用真實Electron驗證透過`terminal_run`工具（mkdir+寫入Makefile+cd+
`make`）真的執行WASM busybox recipe、正確產出目標檔案內容。

### 19.4 「package為單位」的backup分支＋切割/合併工具

使用者要求：日後要mirror大型外部套件（例如WASM編譯器工具鏈）進GitHub時，每個
套件各自獨立一個backup分支（例如`clang-wasm-backup`），**不使用Git LFS**（延續
`db-snapshot`分支既有的理由：免費頻寬額度太容易超額），改用「一般git檔案+
手動切割」，超過20MB的檔案要切割並提供合併回來的script。

新增`desktop-app/scripts/split-asset-for-branch.js`（切割：讀一個本機檔案，
依`--chunk-mb`（預設20）切成`<relPath>.partNNN`＋維護`manifest.json`，格式跟
既有`_fetchAssetBackupFile()`的讀取邏輯完全對齊——`{files:[{path, parts, size,
sha256, partsSha256, chunkBytes, updatedAt}]}`，`_fetchAssetBackupFile()`
本身只驗證合併後總size，`sha256`/`partsSha256`是額外多記錄、給人工核對/未來
更嚴謹驗證用的欄位，不影響現有讀取邏輯。同一個`--out`目錄可以對多個不同檔案
各跑一次，manifest.json用path比對upsert，不會洗掉其他檔案的entry（呼應「一個
branch裡可能同時放好幾個檔案」的情境，例如`clang.wasm`+`lld.wasm`都在同一個
`clang-wasm-backup`分支）。

新增`desktop-app/scripts/merge-asset-from-branch.js`（合併：讀manifest.json、
依序讀回`.partNNN`、驗證每片與整份的sha256/size、寫出還原後的檔案）——純本機
驗證/還原用，不是renderer執行期會呼叫的東西（`_fetchAssetBackupFile()`自己有
一份等效邏輯，直接對著GitHub raw URL做一樣的事）。

已用45MB測試檔案（人工產生、非隨機，確保可重現）驗證切割→合併完整round-trip：
切成20MB+20MB+5MB三片，合併回來的檔案跟原始檔案位元組完全相同
（`cmp`比對通過），manifest.json的sha256/size驗證也都正確通過。

### 19.5 查證過程：build-essential（tcc/gcc、autoconf）現況

使用者要求的完整清單是「tcc/gcc、make、m4、autoconf」——`make`/`m4`已經如上
自己動手重寫（§19.2/19.3）。`gcc`/`tcc`/`autoconf`**還沒有實作**，先如實記錄
查證結果，避免留下錯誤印象：

- **沒有找到任何可靠、現成的瀏覽器WASM移植版TCC**：`tcc-riscv32-wasm`是不同
  目標架構（RISC-V，不是瀏覽器要的wasm32）；TCC官方支援「TCC可以自己編譯成
  `tcc.wasm`」，但那是給WASI runtime用的cross compiler，不是可以直接npm
  install進瀏覽器用的套件。
- **最可信的一條路是`browsercc`**（`clang.wasm`約43MB＋`lld.wasm`約23MB，
  合計約66MB，選用時才會有這個下載成本；另有選用性的19MB precompiled header）
  ——Clang/LLD編譯成WASM＋WASI記憶體檔案系統，可以在瀏覽器編譯/連結C/C++。
  同類的還有`wasm-clang`（binji/Ben Smith）demo專案，作者自己標註「alpha
  demoware」。**這兩個都只透過網路搜尋確認存在，沒有實際npm install下來測試
  過整合API**（package大小＋整合複雜度都不小，貿然wire進去有很高的機率是
  「看起來有做但實際上是壞的」，不如誠實記錄現況）。
- **沒有找到任何GNU m4/GNU make的WASM移植版**——已用自己動手重寫解決
  （§19.2/19.3）。
- **`autoconf`本身傳統上是一支Perl script**（呼叫m4展開`configure.ac`＋一份
  很大的巨集庫`autoconf.m4f`），要真的支援autoconf還需要一個Perl-in-WASM
  （`WebPerl`是查得到的真實、能動的專案）＋完整搬過去的巨集庫，這份巨集庫本身
  用到大量`ifelse`/`patsubst`/`m4_define`等進階m4功能，跟這次m4簡化子集
  （§19.2列出的排除項目）的落差不小，短時間內沒有把握做到「真的能跑通一個
  真實的`configure.ac`」。

**下一步建議**（尚未執行，等使用者決定）：`gcc`/`tcc`/`cc`可以先在
`SANDBOX_COMMAND_REGISTRY`／`TERMINAL_SHELL_BUILTINS`掛好指令名稱＋清楚的
「載入中/尚未驗證」提示（跟其他已完成項目一樣走`FA_ASSET_URLS`+GitHub backup
分支雙來源），但**真正wire進`browsercc`的`clang.wasm`/`lld.wasm`需要另外一輪
實測**（先用小型C原始碼實際編譯連結跑通，才能確認能力範圍/正確性，不是單靠
文件描述就能確定會動）；`autoconf`除非使用者有其他更務實的替代方案（例如只
需要支援固定幾個常見巨集、不追求完整autoconf.m4f相容），否則目前判斷投入產出
比不佳，建議先擱置。

### 19.6 bugfix：`;`分隔的複合指令裡，JS攔截指令不是第一個詞就失效

**症狀**（使用者實測回報）：互動輸入`echo "hi"; sleep 5; echo "hi2"`，`sleep`
回報`sh: line 0: sleep: not found`，前後的`echo`正常執行。

**根因**：`sleep`/`curl`/`wget`/`httping`（`TERMINAL_SHELL_BUILTINS`）與`make`
（`TERMINAL_PROGRAM_BUNDLES`）都是在指令送進WASM busybox**之前**被JS層攔截的
（§19.1/19.3已說明wasi-sh的host-builtin API要求同步callback、做不到`await
fetch()`/`setTimeout`，所以這幾個指令沒辦法走`SANDBOX_COMMAND_REGISTRY`）。
但攔截判斷本身只看**整行字串的第一個詞**是否等於已知指令名——`echo "hi";
sleep 5; echo "hi2"`整行第一個詞是`echo`，於是完全不觸發攔截，整行原封不動
丟進WASM busybox執行，而busybox裡根本沒有`sleep`這個applet（也沒有`curl`/
`wget`/`httping`/`make`），所以只有`sleep`本身失敗，前後真正由busybox執行的
`echo`不受影響。這個沙盒是WASM單執行緒＋`crossOriginIsolated`不可用（見文件
開頭「互動限制」章節），沒有真正的shell parser可以在既有架構下「原生」處理
`;`——只能在JS層自己做一層簡化的複合指令拆解。

**修法**：新增兩個共用method（`_terminalSplitTopLevelSemicolons`/
`_terminalGroupCompoundLine`），對整行做quote-aware（單/雙引號內的`;`不拆）
的頂層`;`拆解，再依`TERMINAL_COMPOUND_INTERCEPT_NAMES`（涵蓋`cd`/`pwd`/
`clear`/`exit`/`help`/`which`/`chmod`/`time`/`ask-floating-ai-assistant`/
`sync`/`sleep`/`curl`/`wget`/`httping`/`make`，刻意不含`less`/`vi`/`top`等
互動式program bundle、也不含`sh`/`bash`腳本執行）判斷每個segment的第一個詞，
把「JS攔截」segment跟「純WASM」segment分組——連續的純WASM segment合併成
一個script、用同一次`runtime.run()`呼叫執行（保留`export X=1; echo $X`這類
同一個wasm shell instance內共享狀態的既有語意），JS攔截segment各自獨立執行。

**兩條路徑都要改**（這是這次bugfix的重點，之前修`terminal_run`繞過JS攔截
的bug時就踩過同一種「兩條路徑要分開改」的坑，見上方Errors記錄）：
- 互動輸入路徑`_runTerminalCommand(session, rawLine)`：分組後，JS類segment
  遞迴呼叫自己、WASM類segment批次丟給`_runTerminalShellLine`，group數量
  ≤1（絕大多數單一指令的情況）時完全落回原本邏輯，不影響既有行為。
- `terminal_run` AI工具路徑`_terminalRunCommand(session, line, opts)`：
  同樣的分組判斷，JS類segment遞迴呼叫自己（`cd`的session.cwd更新、
  sleep/curl/wget/httping/make的`_terminalCaptureWrites`回傳結構都在遞迴
  裡沿用既有邏輯，不用重寫），WASM類segment合併後呼叫新抽出的
  `_terminalRunWasmLine(session, line, opts)`（把原本內嵌在
  `_terminalRunCommand`裡「真的送進WASM執行」那一段搬出來的獨立method，
  單一指令的fallthrough跟複合指令分組後的WASM批次共用同一份邏輯）。
  `opts.outputFile`/`opts.stderrFile`在複合指令情境下**不會**逐個group
  各寫一次，而是等整條複合指令跑完、累積好完整的stdout/stderr之後在
  `_terminalRunCommand`層級統一寫一次。

**驗證**（真實Electron，非mock）：`terminal_run`跑
`echo "hi"; sleep 1; echo "hi2"`確認exit_code=0、stdout含前後兩個echo、
實際delay≥0.9秒；同樣方式驗證`curl`/`make`夾在`;`中間也正常執行（含`make`
真的產出`out.txt`）；`export X=1; echo $X`（純WASM、不含任何JS攔截指令的
複合行）確認回傳`1`，證明沒有破壞既有的同一wasm instance共享狀態語意；
互動輸入路徑同樣重跑一次`echo "hi3"; sleep 1; echo "hi4"`與
`export Y=2; echo $Y`，透過`terminal_get_text`讀回畫面文字確認結果一致。
全部測試通過。

### 19.7 §19.6之後：control-structure-aware拆分 + 真正註冊成host builtin

§19.6上線後，使用者立刻用兩個更進階的情境測出兩個新落差，這裡一併記錄
（都是同一次追加修正裡處理的）：

**落差1：naive `;`拆分器不懂`for`/`while`/`if`/`case`本身也用`;`當語法**

使用者實測：`for i in \`seq 1 10\`;do date;sleep 2; done;`——`sleep`回報
`sh: line 5: sleep: not found`，`done`也報語法錯誤。根因：§19.6的
`_terminalSplitTopLevelSemicolons`只追蹤quote狀態，不知道`for ...;do ...;
done`這種控制結構的`;`是語法本身的一部分，不是頂層指令分隔符——naive拆分
把`sleep 2`從迴圈中間挖出來單獨執行，留下`for ...;do date`（缺done）跟孤立
的`done`兩段給WASM，兩段都變成語法錯誤。

修法：額外追蹤一個「控制結構巢狀深度」計數器，掃描到`for`/`while`/`until`/
`if`/`case`這幾個開頭關鍵字+1、掃到`done`/`fi`/`esac`收尾關鍵字-1（`do`/
`then`/`else`/`elif`/`in`不改變深度，它們一定出現在已經+1的區塊裡面，靠
對應的收尾關鍵字收尾即可），只有深度為0時的頂層`;`才真的拆開；同時追蹤
`(`/`)`跟`{`/`}`的巢狀深度、backtick開關狀態，避免子shell/command
substitution裡的`;`被誤判成頂層分隔符。這是簡化版的關鍵字比對（只算深度、
不驗證for跟done是不是真的配對正確），對合法shell語法已經足夠正確。

**落差2：`sleep`/`curl`/`wget`/`httping`就算不被naive拆分器搞壞，busybox
本身還是不認得這幾個指令——`./script.sh`腳本內容整段送進WASM時完全碰不到
pre-interception層**

即使落差1修好、for迴圈整段完整送進WASM執行，`sleep`還是「not found」——因為
busybox本身沒有這個applet，pre-interception（TERMINAL_SHELL_BUILTINS）
只在「這一行第一個詞」就是`sleep`時才生效，迴圈本體/腳本檔案內容從來不會
變成「這一行第一個詞」。使用者接著實測`./test.sh`（腳本內容是`for...do...
sleep 1...done`）同樣得到「not found」，並明確要求：「我希望sleep要成為
/usr/bin的程式」「可以跟ask-floating-ai-assistant一樣」「要讓這個bash可以
註冊bin，並讓那些binary實際上可以被外面的js engine handle」。

修法：把`sleep`/`curl`/`wget`/`httping`**額外**註冊進`SANDBOX_COMMAND_
REGISTRY`（跟`python`/`jq`/`xq`/`m4`同一套host builtin機制——busybox自己
parse到這個指令名稱時就會呼叫對應的JS實作，不是JS層攔截），這樣不管是
互動輸入單行、`terminal_run`單行、`;`複合指令、for/while/if迴圈本體、還是
`./script.sh`腳本內容，只要文字裡出現這幾個字，`_buildTerminalSandboxBuiltins`
的word-boundary掃描都會抓到並注入對應的host builtin。原本的JS層
pre-interception（async、不卡UI）保留不動，仍是「這一行第一個詞」情境的
優先路徑；host builtin只補上pre-interception完全碰不到的情境。

跟`_runPyodideScriptSync`（host builtin不能await，python也有一份專門給
builtin路徑用的同步版本）同一個限制、同一種付出代價的方式：
- **`_runSleepBuiltin`**：改用真的同步busy-wait（`while (Date.now() <
  deadline) {}`），會**真的凍結整個分頁**（不只terminal widget，連瀏覽器
  repaint都卡住），上限刻意收緊到30秒（pre-interception路徑的`_terminalSleep`
  上限是3600秒/1小時），避免腳本/迴圈裡不小心睡太久讓分頁長時間沒回應。
- **`_runCurlBuiltin`/`_runWgetBuiltin`/`_runHttpingBuiltin`**：改用同步
  `XMLHttpRequest`（`xhr.open(method,url,false)`）取代`fetch()`。同步XHR
  規格限制`responseType`只能是空字串或`'text'`（設`'arraybuffer'`會直接
  拋`InvalidAccessError`），所以這條路徑**只能正確處理文字內容**（JSON/
  HTML/純文字），二進位下載用這條路徑會因文字編碼往返而毀損位元組——真的
  要下載二進位檔案，請用互動輸入或terminal_run最上層直接打`curl -o`/
  `wget -O`（走pre-interception的`_terminalHttpFetch`，正確拿到
  ArrayBuffer）。`_terminalParseCurlArgs`/`_terminalParseWgetArgs`/
  `_terminalParseHttpingArgs`把原本內嵌在async方法裡的旗標解析抽成共用
  函式，pre-interception（tokens來自`_terminalTokenizeArgs`）跟host
  builtin（tokens直接是`ctx.argv.slice(1)`，wasi-sh自己已經拆好詞）兩條
  路徑共用同一份解析邏輯，避免之後各自修改而行為漂移。

**追加發現的另外兩個「terminal_run缺互動路徑既有邏輯」的落差**（跟前面
`sleep`/`curl`/`wget`/`httping`/`make`同一種bug類別，測試§19.7情境時順手
發現順手修）：`chmod`（設`session.execMarks`，讓`./script.sh`能被判定
「已授權可執行」）跟`sh`/`bash <script>`（不需要先chmod +x）原本都只接進
互動輸入路徑，`terminal_run`呼叫會得到「not found」。以及`./script.sh`
本身（含斜線的檔名，互動路徑原本就有判斷、`terminal_run`完全沒有）——這三個
一併補進`_terminalRunCommand`，用同一個`_terminalCaptureWrites`模式包裝成
結構化回傳。`_terminalGroupCompoundLine`的分組判斷也額外加上「含斜線的
指令名」條件（不能只靠固定名稱Set.has()，腳本檔名是使用者自己取的），並把
`sh`/`bash`加進`TERMINAL_COMPOUND_INTERCEPT_NAMES`。

**驗證**（真實Electron，非mock）：使用者原始回報的逐字指令`for i in
\`seq 1 10\`;do date;sleep 2; done;`互動輸入下去，10次迭代、每次真的delay
2秒（總耗時~20秒），不再有command not found/syntax error；`./test.sh`
（`chmod +x`後執行，腳本內容是含`sleep`的for迴圈）透過`terminal_run`正確
執行且delay真實生效；`curl`嵌在腳本裡正確抓到文字內容；`sh script.sh`
（不chmod）透過`terminal_run`正確執行；巢狀for迴圈（控制深度計數器正確性）
正確跑出4種組合；`export X=1; echo $X`（純WASM複合行）跟純`echo "hi";
sleep 1; echo "hi2"`（無控制結構的一般複合行）兩個既有回歸案例都沒有被
破壞。全部測試通過。

### 19.10 §19.7的busy-wait凍結問題：查證spawn()、確認host builtin無解、壓低上限止血

§19.7上線後，使用者實測回報「整個分頁完全失去回應，然後一口氣印出一堆」——
`_runSleepBuiltin`的同步busy-wait不只讓`session.term.write`的輸出延後可見，
是**真的凍結整個renderer process**（不只terminal widget，連瀏覽器repaint
都卡住），因為busy-wait期間JS主執行緒完全不會把控制權還給事件迴圈，瀏覽器
沒有任何機會重繪畫面——所有echo/date的輸出其實都正確依序寫進xterm.js的
內部buffer了，只是要等到整個`runtime.run()`呼叫真正結束、JS主執行緒終於
返回事件迴圈，畫面才會一次性重繪、看起來像「事後一口氣印出一堆」。

使用者要求「像vim/top一樣可以suspend但保持互動」，並具體提出「做成suspend
thread，向interpreter申請下次叫醒thread的要求」——這精準對應到一個真實
存在的機制：wasi-sh除了目前用的`run()`（單次同步呼叫）之外，還有一個
`spawn()`模式，**在Worker裡跑整個shell、用SharedArrayBuffer+Atomics.wait
實現真正的blocking read**（讀取wasi-sh官方README原文確認，不是憑空猜測）——
在這個模式下，busy-wait只會卡住Worker執行緒，主執行緒（xterm.js/畫面渲染）
完全不受影響，是`vim`/`top`要求鍵盤輸入時「畫面不動但仍可互動」那種suspend
語意的真正對應實作。**但`spawn()`需要cross-origin isolation
（COOP/COEP header）才能用SharedArrayBuffer**，而且要從`run()`換成
`spawn()`是重寫整個終端機執行核心的量級（不是小補丁：所有`_terminalRun*`
方法、host builtins註冊機制、fs store交握都要改成spawn()的持久session
模型）。使用者明確否決這個方向——不要cross-origin isolation、不想做這麼大的
架構異動。

同時也**明確驗證了host builtin真的無法async**：直接讀取wasi-sh官方README
（`https://cdn.jsdelivr.net/npm/wasi-sh@0.11.0/README.md`，不是猜測或沿用
舊註解）原文寫得非常清楚——「Handlers must be synchronous. The guest is a
synchronous wasm stack frame below the call — there is nothing to await
into. Returning a promise is reported as an error rather than silently
succeeding at exit 0.」在維持`run()`架構的前提下，這是函式庫本身的硬限制，
沒有任何寫法能繞過。

**決定**：不追加spawn()（使用者否決），在`run()`架構下老實接受這個限制，
把busy-wait能造成的最壞凍結時間壓到最低——`_runSleepBuiltin`的
`MAX_SECONDS_BUILTIN`從30秒降到**2秒**，`_runHttpingBuiltin`的請求間隔
busy-wait也同樣加上2秒上限（原本沿用`_terminalParseHttpingArgs`的`-i`
設定完全沒有上限）。互動輸入最上層的async版本（`_terminalSleep`，
setTimeout、不卡UI）完全不受影響，上限仍是原本的3600秒/1小時。

**`ask-floating-ai-assistant`的同一類問題，但決定不修**：使用者同時回報
`ask-floating-ai-assistant`在script裡也是「not found」（跟sleep/curl一樣
從沒被註冊進`SANDBOX_COMMAND_REGISTRY`）。但**這裡刻意不比照curl/wget/
httping的做法**（改寫成同步XHR host builtin）——`ask-floating-ai-assistant`
底層呼叫的是`_runSubAgentTask`，一個可能要好幾輪LLM API呼叫、耗時10-60秒
以上的agent loop，不是curl那種「一次HTTP request」的等級。如果做成同步
busy-wait host builtin，凍結時間會遠比sleep的worst case更長、更嚴重，
直接違背這次修busy-wait問題的初衷。維持現狀：`ask-floating-ai-assistant`
跟`vim`/`less`/`top`一樣是**只能在最上層互動輸入才能用**的指令（同一類
「需要真的suspend、但這個沙盒沒有能力在不凍結的前提下suspend」的限制），
在script/迴圈裡使用會得到busybox的「not found」——這是如實的架構限制，
不是遺漏。

**驗證**（真實Electron）：`for i in 1; do echo start; sleep 5; echo end;
done`確認`sleep 5`被正確壓到~2秒（`elapsed~2.0`）且stderr出現縮短警告文字；
`sleep 1`（低於新上限）在for迴圈裡確認仍正確delay且沒有警告訊息；§19.6/
19.7/19.9既有的所有回歸測試（for迴圈、script檔案、date時區、巢狀迴圈、
`export`/`echo`共享狀態）重跑全部通過，沒有因為調降上限而破壞既有行為。

### 19.8 `/usr/bin/sleep`絕對路徑呼叫＋python subprocess橋接漏wire builtins

§19.7上線後，使用者又測出`/usr/bin/sleep`（完整路徑呼叫，不是裸名稱）在
`./test.sh`裡還是「not found」，並提出兩個關鍵問題：「這已經是真正的指令了
可以讓他是程式就好？」「如果我把gcc/python弄進來，用exec sleep或執行一個
shell裡面有sleep，這不就又壞了？」。

**根因**：wasi-sh的busybox「指令名稱只要含斜線，一律視為外部檔案路徑、
直接not found，完全不會查host builtins表」（這個沙盒沒有真正的fork/exec
能力）——這不是「builtin沒註冊好」，是busybox自己刻意跳過builtin查表這一步，
即使`sleep`已經是host builtin，`/usr/bin/sleep`還是會被busybox的「含斜線
一律not found」邏輯攔下。使用者的第二個問題點出一個更深、且**真實存在**的
落差：全檔案掃過一輪`runtime.run(`的呼叫點（共7處），發現`_pyodideBridgeRunShell`
（python`subprocess.run(['sh','-c',...])`回頭呼叫shell的橋接）**完全沒有
wire builtins**——就算之後真的把python接進來，`subprocess.run(['sleep','5'])`
回頭經過這裡，連裸名稱`sleep`都會「not found」，不是路徑問題，是這個呼叫點
從一開始就沒把builtins map傳進`runtime.run()`。

**修法**：新增`_terminalRewriteBuiltinPaths(text)`——quote-aware（沿用
`_terminalSplitTopLevelSemicolons`同一套逐字元掃描+quote狀態追蹤，避免
誤改`echo "path is /usr/bin/sleep as literal text"`這種資料字串，這是
第一版純正則寫法實測踩到的真實bug，之後才改成逐字元版本）地把`/usr/bin/
<name>`／`/bin/<name>`這種完整路徑呼叫（只對SANDBOX_COMMAND_REGISTRY
登記過的名稱）改回裸名稱，讓它們回到busybox「查host builtins表」這條正常
路徑。**在整個檔案裡每一個把文字/argv送進`runtime.run()`執行的呼叫點都套用**
（`bash_execute`工具、`_codingRunInSandbox`、三個終端機script組裝點
`_terminalRunWasmLine`/`_runTerminalShellLine`/`_terminalRunScriptFile`、
以及`_pyodideBridgeRunShell`——這個順便一起補上原本完全沒有的builtins
wiring，直接回應使用者「python/gcc接進來會不會又壞」的疑慮）；`argv`陣列
形式（`_pyodideBridgeRunShell`用`args`不是`command`）則對每個元素分別套用
同一個rewrite函式。

**追加發現的第三個落差（跟上面兩個修法互相衝突）**：`/usr/bin/sleep`／
`/bin/sleep`如果是**直接打在互動輸入/terminal_run最上層**（不是藏在script
檔案內容裡），會先被既有的「含斜線＝使用者自己的script檔案，檢查chmod +x」
判斷搶先攔截（因為`/bin`、`/usr/bin`底下那些是純佔位符空檔案，從沒被
chmod +x過，得到誤導性的「權限不足」），根本輪不到`_terminalRewriteBuiltinPaths`
生效（那個只套用在「整段script文字送進WASM之前」，這裡整行還沒送進WASM）。
修法：在`_runTerminalCommand`（互動）跟`_terminalRunCommand`（AI工具）的
「當成使用者script檔案」判斷之前，先檢查這個路徑是不是剛好對到一個真的
有host builtin的名稱，是的話改寫成裸名稱、遞迴走回正常判斷。

**驗證**（真實Electron）：`/usr/bin/sleep`嵌在腳本裡、`/bin/sleep`直接打在
`terminal_run`最上層都正確delay且不再「not found」／「權限不足」；
`echo "path is /usr/bin/sleep as a literal string"`確認資料字串沒有被
誤改；python`subprocess.run(['sh','-c','sleep 1; echo hello...'])`確認
真的delay 1秒且正確拿到stdout（證實`_pyodideBridgeRunShell`的builtins
wiring修好了）；先前§19.6/19.7的所有回歸案例重跑一次全部通過。

### 19.9 `date`跟瀏覽器時區一致

使用者要求「terminal的date要跟我瀏覽器的timezone一致」——`date`是真的
busybox applet，但這個WASM環境沒有真正的tzdata，一律印UTC。

**第一次嘗試（失敗，如實記錄）**：直接註冊`date: {kind:'date'}`進
`SANDBOX_COMMAND_REGISTRY`，用JS的`Date`/`Intl`（天生就是瀏覽器本地時區）
實作`_runDateBuiltin`。**實測證實host builtins沒辦法蓋過同名的busybox
內建applet**——`date`/`date -u`/`date -I`全部還是busybox原本的行為（`-I`
甚至報busybox自己格式的錯誤訊息"unrecognized option"，證明新builtin被
完全忽略）。這是這個檔案第一次嘗試用host builtin蓋過既有busybox applet同名
指令，確認**行不通**。

**修法**：改註冊成`__fa_date`（保證不跟任何busybox applet撞名的內部別名），
新增`TERMINAL_APPLET_OVERRIDE_ALIASES = { date: '__fa_date' }`，並擴充
`_terminalRewriteBuiltinPaths`同一套quote-aware掃描，額外處理「裸名稱本身
就跟busybox內建撞名」這種情境——把指令位置出現的裸`date`改寫成`__fa_date`
（使用者畫面上看到的、AI收到的都還是原始`date`，改寫只發生在送進wasi-sh
執行的文字副本），這樣`__fa_date`底下註冊的host builtin就會被busybox
dispatch到（因為`__fa_date`根本不是busybox認得的applet名稱，直接落到
host builtins表查詢）。因為`_terminalRewriteBuiltinPaths`已經wire進
**所有**`runtime.run()`文字/script組裝點（見§19.8），這個修法**不需要**
額外的JS層pre-interception或`TERMINAL_COMPOUND_INTERCEPT_NAMES`項目就能
統一涵蓋互動輸入/terminal_run/複合指令/for迴圈本體/script檔案內容全部情境
——比sleep/curl/wget/httping當初的修法（需要pre-interception+host
builtin+compound-line分組三層）更簡單，因為`date`是純計算、不需要真的
async I/O或阻塞，host builtin本身已經足夠，只差busybox applet名稱衝突
這一關。

`_runDateBuiltin`支援常用旗標子集：`-u`/`--utc`（強制UTC）、`-d`/`--date`
/`--date=`（解析指定日期字串，用JS原生`Date`解析）、`+FORMAT`（strftime
風格子集：`%Y%m%d%H%M%S%a%A%b%B%p%j%n%%%z`）、`-I`/`--iso-8601`。明確不
支援`-s`（設定系統時間，沙盒沒有意義）、`-r`（讀檔案mtime）、完整GNU
strftime規格表。

**驗證**（真實Electron）：瀏覽器時區確認是`Asia/Taipei`（offset 480分鐘/
+8小時）；`date`（裸）輸出`Fri Sep 25 02:38:21 GMT+8 2026`，跟瀏覽器
`new Date().toString()`的本地時間一致（原本是UTC 18:38:21，正確差8小時）；
`date -u`正確強制印UTC；`+FORMAT`跟`-I`都正確帶`+0800`/`+08:00`offset；
`-d`解析固定日期字串正確；for迴圈本體跟`./script.sh`腳本內容裡的`date`
現在都正確顯示本地時間（原本§19.6/19.7測試transcript裡出現的UTC時間戳記，
這次重跑後全部變成GMT+8）；`echo "the date command shows local time now"`
這種提到"date"單字的一般文字資料沒有被誤改。

### 19.11 徹底解法：自己寫的shell控制流程parser+async執行器，取代busy-wait

§19.10把busy-wait上限壓到2秒後，使用者實測回報「整個分頁完全失去回應，
然後一口氣印出一堆」還是存在（只是縮短了，沒有真正解決），並且明確否決
「這是函式庫限制」這個說法——「我們不要依賴別人寫好但是有瑕疵的」「你應該
做的是把它做成suspend thread，向interpreter申請下次叫醒thread的要求」
「讓他就像是vim一樣！vim, top，你可以保持使用者沒有往前，terminal繼續在
那邊，但還是可以互動」。

**關鍵洞察**：`vim`/`top`這幾個`TERMINAL_PROGRAM_BUNDLES`本來就是「suspend
但保持互動」的真正實作——它們是在WASM執行**之前**就被JS層攔截、整個接管的
獨立ESM模組，用`await ctx.readKey()`真正async等待下一個按鍵，完全不涉及
wasi-sh的host builtin同步限制。`sleep`/`curl`/`date`/`ask-floating-ai-
assistant`當初會卡在busy-wait，不是因為「這些指令本質上做不到」，是因為
它們被送進`SANDBOX_COMMAND_REGISTRY`（wasi-sh host builtin，官方README
證實`Handlers must be synchronous`，無解）——**根本問題是`for`/`while`
迴圈本體、script檔案內容，整段被當成一個不透明blob送進wasi-sh單一次
`runtime.run()`呼叫**，busybox自己的shell parser在處理這段文字時，遇到
`sleep`只能透過host builtin同步呼叫，沒有其他路徑。

**解法**：自己寫一個真正的shell控制流程parser（recursive-descent，巢狀
深度由遞迴天然處理，不是regex/關鍵字計數——不會有「不知道會有幾層」的
問題，這是使用者對§19.9之前那些regex-based修法的直接批評）+async執行器，
完全取代「把for/while迴圈本體整段丟給wasi-sh」這個做法：

- **`_terminalLexShell(text)`**：quote-aware詞法掃描，產生word/`;`/`\n`/
  `&&`/`||`/`|`/`(`/`)`/eof token流。
- **`_terminalParseShellSource(text)`**：遞迴下降parser，支援`Sequence`
  （`;`/`\n`分隔）、`AndOr`（`&&`/`||`）、`For`（`for VAR in LIST; do
  BODY; done`）、`While`/`Until`、`If`/`elif`/`else`/`fi`、`SimpleCommand`
  （含`VAR=value`賦值）。**遇到自己不支援的語法**（pipeline多階段、
  subshell`(...)`、`case`、function等）**整段fallback成`Opaque`節點、
  原封不動送回wasi-sh**——跟修改前完全一樣的行為，零風險，只有支援的子集
  才會被拆解。`for`/`while`/`if`的body用巢狀深度計數找到對應的
  `done`/`fi`（`findMatchingKeywordEnd`），這個計數只用來**定位邊界**、
  不嘗試理解內部語意，body文字本身遞迴丟回`_terminalParseShellSource`
  自己parse——巢狀深度由函式呼叫的call stack天然處理，不是自己維護一個
  深度計數器貫穿整段文字（這正是使用者批評的那種寫法）。
- **`_terminalExecShellNode(session, node, env, opts)`**：async執行器，
  走AST。**虛擬指令**（`TERMINAL_VIRTUAL_SCRIPT_COMMANDS`：`sleep`/
  `curl`/`wget`/`httping`/`date`/`ask-floating-ai-assistant`/`make`）
  在`SimpleCommand`節點裡被辨識到時，**直接`await`既有的async JS實作**
  （`_terminalSleep`本來就是`setTimeout`、`_terminalAskAI`本來就是
  `fetch`+`_runSubAgentTask`，完全不需要busy-wait，也不受wasi-sh host
  builtin同步限制——因為它們根本不再是host builtin，是我們自己的JS函式
  直接被我們自己的執行器呼叫）。**非虛擬指令**（`ls`/`cat`/`grep`/
  `python`/`jq`...）委派給`_terminalRunWasmLine`（既有的wasi-sh
  `run()`封裝，重用busybox真正、正確的coreutils，不重寫）——而且
  `Sequence`執行時**連續的非虛擬SimpleCommand會合併成一批**（跟
  `_terminalGroupCompoundLine`同一個保守原則）一次送進`_terminalRunWasmLine`
  ，避免`export X=1; echo $X`這類依賴同一個wasi-sh instance共享狀態的
  用法被拆得太細而失效。`For`迴圈的清單展開（`` `seq A B` ``這種動態
  清單）借一次`echo LIST`的wasi-sh呼叫讓busybox自己做真正、正確的展開，
  不自己重寫glob/算術/變數展開語意。
- **`_terminalRunShellText(session, text, opts)`**：統一入口，parse+
  執行，取代原本三個呼叫點（`_runTerminalShellLine`互動leaf、
  `_terminalRunWasmLine`AI工具leaf、`_terminalRunScriptFile`）各自把
  整段文字塞進一次`runtime.run()`的做法。**整合方式刻意保守**：不動既有
  `_terminalGroupCompoundLine`的頂層`;`分組邏輯（cd/chmod/sh/bash/斜線
  腳本這些已經測過的JS攔截判斷完全不變），只把原本「wasm batch group
  直接送進wasi-sh」跟「完全沒有JS攔截指令時的整行fallthrough」這兩個
  地方改呼叫`_terminalRunShellText`——這正是for/while迴圈本體/script
  檔案內容當初被當成不透明整塊送進WASM的根源。

**`_pyodideBridgeRunShell`（python `subprocess.run(['sh','-c',...])`
橋接）也一併改用新引擎**：使用者明確提醒「外面的使用者未必只用bash，也
可能用很多層python去處理」「他必須可以接受任何設計而且不該卡住」——原本
這個橋接直接呼叫`runtime.run({args:argv})`，完全繞過新引擎，python巢狀
呼叫shell仍會撞回busy-wait凍結。改成建構一個沒有真正畫面的「假session」
（`term.write`是no-op，這條路徑本來就是程式化取得stdout/stderr）餵給
`_terminalRunShellText`，`stdin`注入（python `subprocess.run(input=...)`）
改成`opts.stdin`參數，用**消耗一次**的語意只餵給第一個真的執行到的leaf
wasi-sh呼叫（`_terminalConsumeStdinOpt`），近似真實shell「一份stdin只能
被讀一次」的語意。

**`TERMINAL_VIRTUAL_SCRIPT_COMMANDS`是這次確立的通用「註冊host-backed
虛擬指令」機制**（使用者原話：「這個ask-floating-assistant跟sleep只是一個
超級無敵小的目標，讓我確認你的register/handle能不能inject，能否設計出
裡面有binary，實際上是host幫跑」）——未來要新增任何「由host（JS/Electron）
實際執行、但在shell裡看起來像一個指令」的虛擬指令，只需要：(1)把名稱加進
`TERMINAL_VIRTUAL_SCRIPT_COMMANDS`（2)在`_terminalExecSimpleCommand`的
dispatch裡加一個分支(3)實作一個async JS函式，這個新指令就會自動在互動
輸入/`terminal_run`/複合指令/`for`/`while`/`if`/script檔案/python
subprocess橋接**全部情境**下正確運作，不需要為每個新指令重新踩一次這次
sleep/curl/date/ask-floating-ai-assistant各自踩過的坑。

**踩到的真實bug（實測抓到，已修正）**：parser的`parseSimpleCommand`一開始
用「遇到`CTRL_KEYWORDS`（`for`/`while`/`if`/`then`/`elif`/`else`/`fi`/
`do`/`done`/`in`）就停止掃描argv」的邏輯，誤判`echo done`這種把`done`
當成**普通參數**（不是控制關鍵字）的合法用法——`done`會被直接吃掉、完全
不出現在`argvWords`裡，`echo done`實際輸出變成空字串。根因：真實shell的
關鍵字只有在**新statement開頭**（分隔符之後）才有特殊意義，不是「這個word
剛好長得像關鍵字就要停」——`parseSequenceInner`的`STOP_WORDS`檢查已經在
正確的位置（呼叫`parseAndOr`之前）做這件事，`parseSimpleCommand`內部
不需要、也不應該重複這個判斷。修法：直接移除`parseSimpleCommand`裡這段
錯誤的提前中斷邏輯，SimpleCommand的argv掃描單純「連續word token直到遇到
分隔符」，不再對關鍵字字面文字特殊處理。

**驗證**（真實Electron，非mock，这是這次修法最重要的驗證項目）：
1. **不再凍結**：fire-and-forget方式送出`for i in 1 2 3 4 5; do echo
   x-$i; date; sleep 1; done`（不等待完成），每隔0.4-0.7秒對頁面做一次
   `page.evaluate('() => 1+1')`量測回應時間——**整個5秒執行期間，每次
   evaluate的回應時間穩定在3-6ms**（跟迴圈執行前後完全一樣），從未出現
   busy-wait版本會有的數百至數千毫秒延遲，證實主執行緒真的沒有被阻塞、
   瀏覽器repaint/事件處理完全正常。
2. **輸出真的是漸進式的**（不是最後一次性印出）：同一個fire-and-forget
   測試，終端機畫面上的內容隨時間逐步增加，不是卡住5秒後一次性全部出現。
3. **ask-floating-ai-assistant現在可以在script裡跑**（使用者原始回報的
   bug）：`./aiscript.sh`（內容含`ask-floating-ai-assistant "say the
   single word: PONG"`夾在兩個echo中間）透過`terminal_run`正確執行，
   AI真的回了"PONG"，前後兩個echo都正確輸出，耗時1.37秒（真實LLM
   round-trip時間，不是假的），不再是「not found」。
4. **python subprocess橋接不再繞過新引擎**：`subprocess.run(['sh','-c',
   'sleep 1; echo hello...'])`透過`_pyodideBridgeRunShell`確認真的delay
   ~1秒且正確拿到stdout（延續§19.8已經驗證過的builtins wiring，這次額外
   確認改用新引擎後行為沒有退化）。
5. `echo done`（讓parser的關鍵字誤判bug現形的最小重現案例）確認正確輸出
   `done`，不再是空字串。
6. §19.6～§19.10累積的所有回歸測試（for迴圈語法/腳本檔案/`/usr/bin/sleep`
   絕對路徑/`date`時區/巢狀for迴圈/`export`+`echo`共享狀態/簡單複合行）
   全部重跑一次，確認這次架構級重寫沒有破壞任何既有行為。

**已知限制（如實記錄，不是100%的shell parser，不追求）**：pipeline多階段
（`cmd1 | cmd2`）、subshell`(...)`、`case`、shell function定義、複雜參數
展開（`${VAR:-default}`）、算術`$((...))`——這些不在parser支援的子集內，
遇到時整段fallback成`Opaque`交回wasi-sh（維持修改前的行為，只是那段文字
如果剛好含有虛擬指令，還是會回到busy-wait的舊限制，這是刻意的、有明確
理由的範圍界線，不是遺漏）。`while`迴圈的condition每次迭代都要真的呼叫
一次wasi-sh（`_terminalRunWasmLine`檢查exit_code），沒有像`for`迴圈清單
展開那樣可以完全避開；虛擬指令的參數展開（`_terminalExpandWord`）只處理
常見的`$VAR`/`${VAR}`/單雙引號，不支援巢狀`$(...)`command substitution
出現在虛擬指令的參數裡（例如`sleep $(compute_delay)`不會被正確展開，會
原樣當成字面文字，這是實務上極少見的用法）。

| `desktop-app/DESIGN.TODO.md（原檔：nvim-wasm）` | 這個子系統各次功能加入/修正的完整歷史紀錄與驗證方式（Phase 5起陸續累加） |

---

## 17. `/mnt/<label>`：從「複製」改成「即時的 FAP 檔案系統」（2026-10-08）

### 17.1 問題
§11 的 hydrate-and-flush：第一次提到某個 label 就把**整個真實資料夾逐檔讀進記憶體**，`sync` 才推回去。大專案（數萬檔、含 GB 級索引庫）上 `cd /mnt/<label>` 等於把整個專案塞進頁面記憶體並卡死。那只是複製品，不是真的使用 FAP。

### 17.2 設計（比照 ext 檔案系統：頁面快取＋寫回）
實作在 `renderer/src/terminal/fapfs_core.js`（`FapMountFs`＋`mountRouter`，純 JS，符合 wasi-sh 的同步檔案系統契約，並通過它自己的官方符合性套件），傳輸在 `fapfs_transport.js`。

| 概念 | ext 檔案系統 | 這裡 |
|---|---|---|
| 目錄項／inode 快取 | dentry／inode cache | `stat` 與列表快取，**一個指令內有效**（每個指令開頭 `newEpoch()`） |
| 頁面快取 | page cache | 檔案以 1 MB 區塊快取（LRU，最多 128 塊），鍵含 `size:mtime`，外部改過就重讀 |
| 寫入 | 寫進 page cache，髒頁由 writeback 寫出 | 寫入進記憶體緩衝（髒檔），**每個指令結束**、`sync`、超過 128 MB 水位時寫回 |
| 一致性 | — | 寫回前檢查檔案是否還是讀進來時的 `size:mtime`；被外部改過就**不覆蓋**並警告（`sync <label> --force` 覆蓋） |
| 刪除 | — | 先記成墓碑，寫回時才真的刪；「刪了又建」合併成覆寫 |

- **路由**：只有 `/mnt/<已掛載 label>/…`（含 `/mnt/<label>` 本身）走 FAP；`/work`、`/bin`、沒掛載的 label 仍由原本的記憶體 store 處理。掛載時機＝第一次有指令提到該 label（沿用 `_hydrateReferencedFapMounts` 的偵測）。
- **兩種同步傳輸**（因為 store 契約是同步的，客體是 wasm 堆疊最底層，沒有東西可以 await）：
  - **桌面版**（授權的真實資料夾）：主行程 `fsx-sync.js` 用 `fs.*Sync` 直接處理，渲染行程用 `ipcRenderer.sendSync`（`desktopAPI.fsx.call`）。桌面版的 FAP handle 是走 IPC 的假 handle（`ElectronDirectHandle`），本來就不能丟給 worker。路徑限制在授權資料夾內；寫入＝寫暫存檔再改名（原子替換）；寫回前比對 size:mtime。
  - **網頁版**（`FileSystemDirectoryHandle`）：`WorkerBackend`——請求寫進 SharedArrayBuffer、worker 持有 handle 做非同步 API、頁面自旋等待回應；需要 SharedArrayBuffer，不行就退回舊的複製式掛載。worker 程式放獨立檔案（`fapfs_worker.js`）、建置時內嵌成字串常數——不能用 `function.toString()`，建置的壓縮器會改掉變數名稱（實測踩到）；`TextDecoder` 不收共享記憶體的視圖，要先複製（也踩到）。
- **語意**：`mkdir`／`rmdir` 立即生效；`rename` 只支援檔案（資料夾回 `EXDEV`，busybox 的 `mv` 會自動改成複製＋刪除；這是唯一與 wasi-sh 符合性套件不同之處，FAP 沒有原子的資料夾搬移）；連結 `ENOSYS`；`chmod`／`touch` 的權限位元與時間戳記在記憶體（FAP 沒有這些概念）；單檔寫入上限 256 MB（`EFBIG`），沒被寫的檔案任意大小都只讀用到的區塊；唯讀掛載寫入回 `EROFS` 並提示 `sync <label> --push`。
- **`sync`**（互動輸入）：`sync [label]` 立即寫回；`--force` 覆蓋被外部改過的檔案；`--pull` 丟棄快取；`--push` 申請寫入權限（網頁版）。AI 的 `terminal_run` 沒有 `sync`，但每個指令結束都會自動寫回。

### 17.3 實測（桌面版，真實資料夾經真實終端機）
`ls`、`cat`、`find`、`grep -r`、`echo >`、`>>`、`mkdir`、`mv`、`rm`、`cp`、`sqlite3 /mnt/…` 都直接作用在磁碟上；`ls /mnt/proj`、`cat` 約 0.01–0.04 秒；60 MB 的大檔不會被讀進來（`wc -c` 只 stat）；`sync` 的衝突偵測與 `--force`、`--pull` 驗證過（指令邊界寫回遇到外部改過的檔案不覆蓋、回報路徑）。

### 17.4 已知限制
- 目錄項超過約 150 個時 `ls`／`find` 只看到前面一部分：這是 wasi-sh 0.11.0 的目錄讀取緩衝限制，純記憶體沙盒也一樣（`readdirSync` 本身是完整的），不是 FAP 掛載造成的。
- 資料夾不能改名（見上）；`dd`、`head -c`、`od` 這類 busybox 沒編進來的指令仍然沒有。
- 網頁版（SharedArrayBuffer worker）的傳輸用 OPFS 資料夾（真的 `FileSystemDirectoryHandle`）在 Electron 的 Chromium 裡驗證過（stat、列表、區塊讀、分塊寫入、衝突、force、唯讀、刪除；每次同步呼叫約 1–25 ms）；還沒有用一般瀏覽器經 `showDirectoryPicker` 授權的資料夾驗證，網頁版頁面不是 cross-origin isolated 時是否能用 SharedArrayBuffer 也還沒確認（桌面版有開這個功能）。

## 20. job 執行層：不依賴畫面上的終端機（2026-11-19）

**動機（使用者）**：run terminal 只是「把程式的輸出與視窗顯示出來」的表現層；真正能跑 python／node／LLVM IR／shell 的能力，外面的 AI 也要能用，不必先在對話裡開一個終端機。

**做法**：`_terminalRunCommand` 只要求 session 物件有 `term.write`、`cwd`、`container`（視窗浮層容器）、`_aborts`。`_jobCreateSession` 造一個沒有 xterm 的 headless session（輸出收進緩衝、視窗畫進固定在畫面上的浮層 `.fa-job-layer`，使用者看得到），所以 job 與終端機共用同一套指令、沙盒檔案系統、`/work/examples`、`swap`、`gui`。
- 工具（`registerOptional`，放進「程式執行環境」領域與理解閘清單）：`job_run`（lang＝python｜node｜llvm｜shell；`code`、`files`、`args`、`detach`、`timeout_s`、`job_id` 重用）、`job_gui`（`snapshot`／`click`／`input`／`key`／`mouse`／`select`／`toggle`／`screenshot`／`close`）、`job_list`、`job_stop`（`dispose` 連沙盒與浮層丟掉）。最多留 8 個 job。
- `gui_host.js` 新增 `inject(winId, name, nodeId, value)`（與頁面送的事件走同一個協定檢查，不合法回 false）、`windows()`、`canvasPng(winId, n)`（只有 2D 畫布；WebGL 畫布沒保留緩衝）。
- `job_gui` 回傳的節點清單（id、kind、文字、值）就是 AI 要點的目標；screenshot 存成 job 沙盒的 `/work/shot-<視窗>.png`。
- `py_async.js`：行首 `import fa_swap` 也走 Worker 路徑（`fa_swap` 轉接層只在 Worker 提供；同時修了 `import numpy as np, gui` 這種帶 as 的多重 import 沒被辨認）。

**限制**：程式結束時它自己開的視窗會被收掉（既有的 `_terminalGuiScope`），所以要看最後畫面請 `detach` 後在程式還跑時截圖；（OpenCL 已由 CPU 後備墊片支援，見 §21；SDL2／OpenGL／GTK3 的 `.ll` 也由 host import 支援，見 §21）；job 與 terminal 的 session 互相看不到（job 不在 `terminal_list`）。

**驗證**：`scripts/eval/job_layer.eval.js`（真 Electron）：node／shell／swap 落到 IndexedDB（8 MB）且程式結束後清空、貪食蛇視窗快照→注入方向鍵→截圖→`job_stop`（結束碼 130）、python＋numpy＋`fa_swap`（後端 indexeddb）全過；單元：`gui_host.test.js`（inject／windows）、`py_async.test.js`。

## 21. LLVM IR 的主機函式庫：SDL2／OpenGL／GTK3 走 wasm host import（2026-11-19）

**動機（使用者）**：llc 的範例（SDL2 遊戲、GTK3 視窗、OpenGL）不只能在真機器編成原生執行，在 run terminal／job 的模擬環境也要能跑。
**做法**：
- `uml/llvm_core.js`（FaLlvm）新增 `registerHost`（主機函式的簽名表；IR 宣告了又沒定義就編成 wasm 匯入 `env`，簽名不符或沒實作在檢查階段就報）、`float`（f32、`fpext`／`fptrunc`）、可變參數呼叫（多出來的引數放影子堆疊上 8 位元組對齊的緩衝區，多傳一個指標）、函式指標當值（函式表格索引從 1 起、匯出 `table`；給主機函式當回呼，wasm 內不能間接呼叫）、`runHost`（JSPI：`WebAssembly.Suspending`／`promising`；只有用到 async 主機函式才要求 JSPI；`main(argc, argv)` 的參數寫進保留區 800..1024）。
- `uml/llvm_host.js`（FaLlvmHost，純邏輯，gui／sleep／now 由呼叫端傳入）實作 SDL2（視窗、渲染器、事件轉成 `SDL_Event` 位元組、計時）、OpenGL 固定管線（矩陣堆疊在 JS，`glBegin／End` 收成批次 → 上傳成緩衝區 → `flat` 程式的 `glframe`；QUADS／FAN 拆三角形）、GTK3（widget 樹在 `gtk_widget_show_all` 時一次送成 GUI 節點；`gtk_main` 輪詢事件、經函式表格呼叫訊號處理函式與 `g_timeout_add`；回傳字串用 wasm 保留區 64..784 的暫存環）、printf 家族。事件用 `gui('wait', {timeout: 0})` 讀（視窗已關閉會得到 close 事件）。
- 接線：`lli` 加進 `TERMINAL_COMPOUND_INTERCEPT_NAMES` 與 `TERMINAL_VIRTUAL_SCRIPT_COMMANDS`；`_terminalTryLliHost` 在 IR 用到主機函式時走非同步路徑（登記只在程式執行期間，用計數保護，結束就取消，不影響別的 IR 工具），不適用就退回原本的同步 `lli`（wasi-sh host builtin）。結束碼、Ctrl+C、逾時、視窗收尾跟 python／node 一致；job_run 的 `lang: 'llvm'` 直接可用。`job_gui` 新增 `change`（勾選框）、`wheel`。
- 同時：`pygame.locals`（`from pygame.locals import *` 的慣用寫法，墊片是單一檔案，改成登記在 `sys.modules` 的模組）。

**限制**：沒有 `phi`（用 alloca）；一幀 SDL 最多 200 道繪圖指令；GL 沒有光照、紋理、著色器；沒有音訊與影片；`gtk_main` 在所有視窗關閉後會結束（真 GTK 會一直等）；OpenCL 只有 CPU 後備（見 §21 的限制）；需要 JSPI（Chrome／Edge 137 以上、桌面版）。
**驗證**：`llvm_host.test.js`（12 項，node）、`llvm_core.test.js`（103 項沒壞）；真 Electron：`scripts/eval/llc_host.eval.js`（pong、GTK 自動／互動、GL、錯誤路徑，全過）。

**OpenCL 墊片（2026-11-19，CPU 後備）**：`llvm_host.js` 的 `SIGS` 加上 OpenCL 1.2 最小子集的 host import（`clGetPlatformIDs／clGetPlatformInfo／clGetDeviceIDs／clGetDeviceInfo／clCreateContext／clCreateCommandQueue(WithProperties)／clCreateBuffer／clEnqueueWriteBuffer／clEnqueueReadBuffer／clCreateProgramWithSource／clBuildProgram／clGetProgramBuildInfo／clCreateKernel／clSetKernelArg／clEnqueueNDRangeKernel／clFinish／clFlush／clWaitForEvents／clRelease*`）。**後端選 CPU 後備**，理由：沙盒（wasm＋WASI）沒有 GPU 也沒有 OpenCL 驅動，而 WebGPU／cudaweb 要另外的裝置與權限，不能保證 run terminal 內一定有；CPU 後備在任何環境都能跑，結果可以比對。
- 平台：一個；裝置：一個 CPU（`CL_DEVICE_TYPE_GPU` 查詢回 `CL_DEVICE_NOT_FOUND`，呼叫端退回 CPU 就會拿到它）。
- buffer 是 JS 端的 `Uint8Array`，寫入、讀回時跟 wasm 記憶體複製（和真裝置的行為一樣）；`CL_MEM_USE_HOST_PTR` 與 `CL_MEM_COPY_HOST_PTR` 都當成「把主機資料複製進 buffer」（不會同步回主機記憶體，這是限制）。
- 核心：`clBuildProgram` 把 OpenCL C 子集翻成 JS 函式（`clCompile`，`new Function`），`clEnqueueNDRangeKernel` 在當下**同步**逐一執行（工作群組大小固定 1，所以 `get_local_id`＝0、`get_local_size`＝1），`clFinish` 直接回傳；因此沒有非同步的 event 語意，`cl_event` 都是空的。
- **核心語言子集**：`__kernel void` 函式（一個或多個），參數是純量（`int／uint／float／double／char／uchar／short／ushort`）或 `__global`／`const` 指標；本體支援宣告、`if／for／while`、算術、比較、`return`、`(int)`／`(float)` 等轉型、`get_global_id／get_global_size／get_group_id／get_num_groups／get_work_dim`、`sqrt／fabs／sin／cos／exp／log／pow／floor／ceil／fmin／fmax／min／max／mad／clamp` 等數學。`f` 字尾的浮點常數可用。
- **不支援（明確報錯，不會悄悄算錯）**：`__local`、`barrier`、向量型別（`float4` 等）、`struct`、`image`、`atomic_*`、輔助函式、全域變數、巨集（`#define`；`#pragma` 會被忽略）、`goto`（翻譯後是 JS 語法錯誤，會回報建置失敗）。
- **驗證**：`llvm_host.test.js` 跑 `opencl_vecadd.ll`（真輸出：`vadd OK, n=1000 c=2997.000000`；預設 N＝1048576 時 `c=3145725.000000`），並測 `clCompile` 的執行結果與四種拒絕訊息。
- **限制（誠實）**：沒有真的 GPU 效能（JS 逐元素執行，N 很大時會慢）；不會用到 GPU 上的 `cl_khr_*` 擴充；`clEnqueueReadBuffer` 的 `blocking_read` 永遠視同 blocking；沒有 `clGetEventProfilingInfo`；沒有 `clCreateSubBuffer`、`clEnqueueCopyBuffer`、`clEnqueueMapBuffer`；沒有 `clCreateImage`。WebGPU／cudaweb 的後端另案（`DESIGN.webgpu-cuda.md`）。
- **範例**：`gpgpu/opencl_vecadd.ll` 把 `phi` 改成 alloca／load／store（本 llc 版本不支援 `phi`），`malloc` 改用 `i32` 參數（wasm32 的 libc 簽名）。nbody3d／fluid3d 還是 CPU 計算（與 OpenCL 無關）。

**2026-11-19 補充（OpenCL GPU 後端與 SDL 文字 HUD 的方案，未實作）**：
- **WebGPU 在這台不可用**：真 Electron（xvfb＋SwiftShader）裡 `navigator.gpu` 存在，但 `requestAdapter()` 回 `null`，WebGL2 可用。所以 nbody3d／fluid3d 的 OpenCL「真加速」沒有地方能驗證，本批只能驗證 CPU 後備；要在有 GPU adapter 的機器才能量加速。另一條路 WebGL2 transform feedback 做計算，工作量大、尚未評估。
- **SDL 文字的阻礙**：`llvm_host.js` 的 SDL 每幀最多 200 道繪圖指令（超過的丟掉）。每個字元用矩形畫點陣，一行約幾百個矩形，遠超上限。方案：(A) 提高上限（例如 800）並確認 GUI 橋接端沒有另一個上限，需要改 `llvm_host.js` 的 slice 與 renderer 的 draw 處理，並在本節與 examples/llc/README.md 寫明；(B) 不提高上限，改用 3×5 精簡字型，每行只畫關鍵字，文字仍可能太多，要再量；(C) 新增 SDL_CreateTexture／SDL_UpdateTexture／SDL_RenderCopy 主機函式（文字只畫一次），範圍最大。建議先 A 並實測每幀 ops 數。

## 22. LLVM IR 的 SDL 音訊與全域陣列初始值（2026-11-19）
`llvm_host.js` 新增 SDL2 音訊（佇列模式）：`SDL_OpenAudioDevice／OpenAudio／QueueAudio／GetQueuedAudioSize／ClearQueuedAudio／PauseAudioDevice／PauseAudio／CloseAudioDevice／CloseAudio`，每個裝置對應頁面端 `AiChatAudioHost` 的一個串流（`gui.audio` 的 `stream_*`）；取樣格式 U8／S8／U16／S16／S32／F32 轉成 16 位元有號 PCM 再送；裝置一開始暫停。callback 模式（`SDL_AudioSpec.callback` 非 NULL）回 0 並說明，因為主機端無法在 wasm 記憶體配置緩衝區。`llvm_core.js` 新增全域陣列初始值（`[i32 1, i32 2, …]`、float／double 的一維陣列）。範例 `examples/llc/game/sdl2_piano.ll`（原生用 llvmlite＋gcc＋SDL 的 dummy 音訊驅動驗證；wasm 版真 Electron 驗證：串流開啟、鍵盤注入、結束後串流收掉）。

## 23. LLVM IR 的檔案系統、libm 與四個新範例（2026-11-19）
`llvm_host.js` 新增 stdio 檔案函式（見 `examples/llc/README.md`「檔案系統」）：`create({ fs })` 的 `fs` 由 `_terminalTryLliHostRun` 接到終端機沙盒（`_terminalSandboxFileBytes`／`_writeBytesToTerminalFs`），程式結束後 `_terminalFlushLive` 寫回 `/mnt`。`llvm_core.runHost` 新增第五個參數 `declares`：宣告成 `i64` 的參數（`size_t`／`long`）JS 收到 BigInt，轉成數字；宣告成 `i64` 的回傳值轉成 BigInt。主機簽名的回傳型別也可以有替代（`'i32|i64'`）。另有 libm（`sin／cos／sqrt／pow／floor／fmod／atan2…` 與 `…f` 版）、`GL_POINTS` 依 `glPointSize` 畫圓點。
範例：`gpgpu/nbody3d.ll`、`gpgpu/fluid3d.ll`（CPU 計算＋OpenGL 點精靈）、`gui/music_player.ll`、`gui/midi_player.ll`（解析 SMF；`gui/demo.mid` 是二進位檔，嵌入時存成 `.b64`，播種時還原成位元組）。真 Electron 驗證：`scripts/eval/llc_host.eval.js` 的 `R.more`（四個範例＋ `.mid` 經 `fopen` 讀沙盒＋找不到檔案的錯誤）。

## 24. 自動 swap：python／node／LLVM 執行前自動啟用（設計；2026-11-19 立案，2026-11-20 定稿；尚未實作）

**動機（使用者）**：「我希望不只 python、node、llvm（lli/llc）也要有 indexdb as swap」；「我希望都是執行前自動設定，不要明確 import」；「讓它就像原生的一樣」；「16MB 太小了」。資料比記憶體大時，程式會被瀏覽器殺掉或 OOM。Python 現在有 `fa_swap`（熱區預設 16 MB，要 `import fa_swap`）；node 有 `swap.hotMB(n)`（全域，不必 require，但熱區預設 16 MB）；LLVM 完全沒有。

**設計目標**
1. 三種執行器（python、node、lli/llc）**執行前自動啟用** swap，使用者程式**不必 import／require／宣告**。
2. 「像原生一樣」的程度：各執行器能做到的範圍如下（做不到的寫在限制，不假裝透明）。
3. **統一設定**（一處定義，三種執行器共用）。
4. 共用分頁核心（一份演算法，三種執行器用同一組統計欄位）。

### 24.1 共用分頁核心與統一設定（一處定義）
- 核心：`renderer/src/env/fa_swap_core.js`（UMD、無 DOM）。把 swap 空間切成固定頁（預設 256 KB），熱區（記憶體）用 LRU，髒頁被踢出時寫回儲存層，沒寫過的頁讀出來是 0。儲存層注入（`put／get／drop／close`，預設是頁面橋接到 IndexedDB；沒有儲存層就是記憶體，統計標 `backend:'memory'`，功能一樣但不省記憶體）。
- 統計欄位（三種執行器一致）：`pages_hot、pages_total、reads、writes、hits、hot_bytes、limit、size_limit、size_used、arrays、page_bytes、backend、disk_bytes`。
- 設定 `resolveConfig`（唯一的預設來源）：

| 設定 | 預設 | 環境變數 | 說明 |
|---|---|---|---|
| swap 總量 `size` | **4096 MB** | `FA_SWAP_SIZE_MB` | 所有還活著的 swap 陣列加起來的上限；超過就明確丟錯，不靜默丟資料 |
| 熱區 `hot` | **4096 MB** | `FA_SWAP_HOT_MB` | 記憶體裡最多留多少；**wasm32 線性記憶體上限 4 GB，超過就夾到 4 GB**（標 `hot_capped`） |
| 頁大小 | 256 KB | — | 不對外開放 |

- 優先序：**助理設定**（`advancedSettings.envOverrides` 的 `swapSizeMB`／`swapHotMB`）＞ **環境變數** ＞ 預設。環境變數只對 Python 直接跑（有 OS 環境）有效；瀏覽器內沒有 OS 環境變數，實際上以助理設定為準。
- **Python 預設 16 MB 要改成 4096 MB**（`fa_swap.py` 的 `HOT_BYTES`，現在是 `FA_SWAP_HOT_MB` 預設 "16"）。Python 先問橋接 `swap.config`（由 JS 的 `resolveConfig` 回傳），橋接不通才讀環境變數，所以只有一份預設值（在 JS）。
- **node 的 `swap.hot(MB)` 與 `FA_SWAP_HOT_MB` 的關係**：`swap.hot(MB)` 是「熱區的執行期設定」，對應環境變數的熱區設定；啟動時的預設來自統一設定（4096 MB），不是 16 MB。現行 API 名稱是 `swap.hotMB(n)`，本設計決定：正名為 `swap.hot(MB)`，保留 `hotMB` 作為別名（相容既有的 `life_swap.js`、`swap_demo.js`）。`swap.hot()` 不帶參數回傳目前的熱區（MB）。
- 總量超過時的錯誤訊息要指出 `FA_SWAP_SIZE_MB`（或助理設定），而不是只說「超過」。

### 24.2 三種執行器：執行前自動啟用、不需 import
- **python**：Worker 執行前在 `builtins` 放一個延後載入的 `fa_swap` 代理（第一次用到才 import 真的 `fa_swap.py`，沒用到就不付 numpy 的載入成本）。`py_async.js` 判斷要不要走 Worker 時，程式只要提到 `fa_swap`（不是字串或註解裡的字）就走 Worker，橋接才接得上。既有的 `import fa_swap` 仍然可用（相容）。
- **node**：沙盒 iframe 的全域 `swap` 本來就不必 require（`gui/js_program.js` 的 shim）；設計是讓它的分頁改用共用核心（核心原始碼放進 iframe 的 script 裡），API 不變。
- **LLVM**：host 自動提供 `fa_swap_*`，IR 只要 `declare`，不需要任何 import。`llvm_host.js` 的 `create` 收 `swap` 選項（核心模組、頁面橋接、設定）；H.close() 丟掉這次程式的空間。

### 24.3 「像原生一樣」的透明程度與限制
| 執行器 | 能做到的透明 | 做不到／限制 |
|---|---|---|
| python | 不必 import；`fa_swap.array(shape, dtype)` 像 numpy 一樣索引、切片、`blocks`、`apply`；超過熱區自動換頁；超過總量明確丟 `SwapError` | **numpy 陣列的 buffer 必須常駐記憶體**，不能讓 `np.zeros(...)` 變成換頁陣列；要用 swap 必須寫 `fa_swap.array`。複本式讀寫（不是 mmap）；不是執行緒安全 |
| node | 不必 require；`swap.array(len, type)` 任意長度型別化陣列；超過熱區自動換頁；`swap.hot(MB)` 調熱區 | **IndexedDB 是非同步**，TypedArray 的同步語法（`a[i]`）做不到，只能 `await a.get／set／map`。要 `a[i]` 需要 JSPI 或 Worker＋Atomics，iframe 無法同步等 IDB。 |
| LLVM | 不必 import（`fa_swap_*` 由 host 提供）；超過 wasm 記憶體的資料用分頁讀寫 | 要**明確呼叫** `fa_swap_read／write`，不是一般指標。`malloc` 透明換頁見 24.4。 |

共通限制：效能是磁碟級，不是記憶體級；沒有 IndexedDB 時退回記憶體（不省記憶體，會標 `backend:'memory'`）；程式結束或 `close` 時一律丟掉自己的空間，啟動時清掉上次沒清乾淨的。

### 24.4 LLVM：`fa_swap_*` 與 malloc 透明換頁的評估
- **`fa_swap_*`（採用）**：`i32 fa_swap_open(i64 bytes, i64 page_bytes)`（0＝失敗）；`i32 fa_swap_read(i32 h, i64 off, ptr dst, i64 n)`、`i32 fa_swap_write(i32 h, i64 off, ptr src, i64 n)`（成功 0、失敗 -1；複製式，因為頁會被換出，不給指標別名；IndexedDB 非同步，所以走 JSPI，與 SDL_Delay 同做法）；`void fa_swap_close(i32 h)`。不進 libc 清單，只在 host 清單（避免混淆 libc 與擴充）。範例：超過 wasm 記憶體的陣列分頁讀寫（`examples/llc/swap/`，由 `_gen` 產生）。
- **malloc 透明換頁（評估：不做）**：C 語意的指標是 wasm 線性記憶體的絕對位址，程式可以任意保存、比較、算術運算。要透明換頁，等於要在 wasm 裡做虛擬記憶體（缺頁時中斷、換入、重映射），wasm 沒有這個能力，只能在每次存取前插入檢查（會讓所有程式變慢，且要改編譯器產生的每一個 load／store）。替代：明確的 `fa_swap_*` API，加上 `malloc` 超過某大小時回傳 `fa_swap` 不透明句柄的新 API（需要 IR 改寫，不是 libc 的原樣行為）。結論：**透明的 malloc 不可行，只提供明確 API**。若之後真的需要，再以「大型陣列專用的 `fa_swap_array` IR 型別」評估。

### 24.5 驗證計畫（實作時）
- `fa_swap_core.test.js`：統一設定（預設 4096、夾到 4096、覆寫優先序）、零頁、髒頁寫回與 LRU、總量上限、釋放與關閉、統計欄位與 Python 一致。
- `fa_swap_test.py`：預設 4096、環境變數、總量 `SwapError`；`js_program_swap.test.js`：`swap.hot`／`hotMB` 別名、node 的讀寫與結束清空；`llvm_host.test.js`：`fa_swap_*` IR 編譯、host 實作（node 沒有 JSPI，read／write 直接呼叫 impls）。
- 真 Electron：job 內 IndexedDB 頁數、結束後為空；`swap_big.ll` 實跑（JSPI）；Pyodide 不 import 直接用 `fa_swap.array`。

### 24.6 現況與 WIP（2026-11-20）
- 本節是設計，**尚未實作為正式功能**；`desktop-app` 上只應有設計文件的 commit。
- 已先寫、**未 commit、未接線**的程式碼（工作樹未追蹤或修改）：
  - 新增：`renderer/src/env/fa_swap_core.js`、`renderer/src/env/fa_swap_core.test.js`、`renderer/src/examples/llc/swap/swap_big.ll`、`renderer/src/examples/llc/_gen/_gen_swap_big.py`
  - 修改：`renderer/src/gui/js_program.js`（node 的 swap 改用核心）、`renderer/src/gui/js_program.test.js`、`renderer/src/gui/js_program_swap.test.js`、`renderer/src/gui/py_async.js`（偵測 fa_swap）、`renderer/src/gui/py_worker.js`（builtins 注入）、`renderer/src/pybridge/fa_swap.py`（預設 4096、總量上限）、`renderer/src/pybridge/fa_swap_test.py`、`renderer/src/uml/llvm_host.js`（`fa_swap_*`）、`renderer/src/uml/llvm_host.test.js`、`renderer/src/examples/llc/README.md`、`scripts/run-core-tests.js`
- 已驗證（只在工作樹上，node／python）：`fa_swap_core.test.js` 23 項、`js_program_swap.test.js` 11 項、`js_program.test.js`、`llvm_host.test.js` 51 項、`fa_swap_test.py` OK。`swap_big.ll` 只驗證編譯（需 JSPI 才能實跑）。
- **未做**：`renderer/src/floating-assistant.js` 接線（該檔無寫入權）、embed、build、真 Electron 驗證、Pyodide 端到端。
- **WIP 分支**：建議把上面的改動 commit 到 `wip/auto-swap`（不進 `desktop-app`、不發布），之後 `desktop-app` 只留設計文件。目前這個 session 無法執行 git（dubious ownership；ssh 到 hungfu.lee 被拒），所以**還沒有 WIP 分支，工作樹也還沒還原**。
- 接線步驟寫在 `local_aa2d0534…/swap-auto-handover.md`（side-session-notes）。

### 21.x 真 GPU 基準：`scripts/eval/gpgpu_bench.eval.js`（2026-11-19）

目的：在有獨立顯示卡的機器上量 llc 的 nbody3d、fluid3d 每幀耗時（CPU 版 wasm 對 OpenCL 版），並印出 WebGL2 的 renderer／vendor、`EXT_color_buffer_float`。
這個評測**不加任何軟體 GL 旗標**，所以一定要在有真 GPU 的機器上跑；在沒有 GPU 的機器上跑出來的數字，`renderer` 會是 SwiftShader，不能當作真 GPU 的結果。

**執行（在桌面版的專案根目錄）**——把下面這行直接貼進終端機：

```bash
node scripts/eval/gpgpu_bench.build.js /tmp/gpgpu_bench.js && FA_EVAL_GL=gpu FA_EVAL_TIMEOUT_MS=3000000 node scripts/eval/run_eval.js /tmp/gpgpu_bench.js
```

約需 10–30 分鐘（N＝3072 的 CPU 版最慢）。執行中會開一個視窗，不要關掉。

**預期輸出格式**：最後會有一行 `[eval-file] result: {…}`，內容是 JSON：

```
[eval-file] result: {"env":{"webgl2":true,"renderer":"…（真 GPU 的名稱）","vendor":"…","ext_color_buffer_float":true,"max_texture_size":16384,"webgpu":"adapter"|"no adapter",…},
 "nbody":{"512":{"cpu":{"ms_per_frame":…,"backend":"none"},"opencl":{"ms_per_frame":…,"backend":"webgl2"|"js-shim"}},"1024":{…},"3072":{…}},
 "fluid":{"1000":{"cpu":{…},"opencl":{…}}},
 "nbody_512_opencl_forced_js":{"ms_per_frame":…,"backend":"js-shim"}}
```

- `ms_per_frame`：斜率（10 幀與 40 幀的差）；`null` 代表那個執行失敗（看 `exit`）。
- `backend`：`webgl2`＝OpenCL 核心真的在 GPU 上跑（有 `gpu_dispatch` 次數）；`js-shim`＝退回 JS 墊片（有 `fallback` 次警告）；`none`＝CPU 版。
- 如果 `env.ext_color_buffer_float` 是 false，OpenCL 只會是 `js-shim`，那就不是 GPU 加速的數字。
- fluid 的粒子數寫死在產生器裡（1000），所以只有一個 N。

**已知限制**：目前 OpenCL 版每幀仍有寫入與讀回（見 DESIGN.webgpu-cuda.md §13 階段 6），所以真 GPU 上的加速也會被傳輸成本限制住；這個基準正是用來量這個差距。

### 21.y 螢幕說明（HUD）的真 Electron 檢查：`scripts/eval/llc_hud.eval.js`（2026-11-20）

做法：跑範例的 job，從畫布（preserveDrawingBuffer）讀像素，與依 `_gen` 的 `text()` 規則算出的期望像素比對（7×13 點陣，第 k 字元第 r 列第 c 欄畫在 (x0+7k+c, y0+r−2)）。覆蓋率＝期望像素中夠亮（RGB 平均 > 100）的比例，≥ 0.95 才算正確顯示。
- 按鈕與狀態行：nbody3d_cl 用 gui 的 `mouse` 事件（move／down／up）點 CPU、GPU 按鈕，檢查狀態行的文字真的變。
- 輸出：CPU 版與 OpenCL 版（途中點 GPU）的最終叢集中心、fluid 的平均 y 逐字比對。
- 執行：`node scripts/eval/llc_hud.build.js <檔>`，然後 `FA_EVAL_GL=swiftshader FA_EVAL_TIMEOUT_MS=1500000 node scripts/eval/run_eval.js <檔>`。

結果（SwiftShader，app 為 eab9cd930 之後重產的 .ll）：

| 範例 | 螢幕上有說明文字 | 狀態文字（顯示的內容） |
|---|---|---|
| nbody3d（CPU） | 有（標題、CPU／GPU 按鈕字、GPU 行） | `GPU: run nbody3d_cl.ll (OpenCL) instead` |
| nbody3d_cl（OpenCL） | 有 | 啟動：`CPU: wasm integration`；點 GPU：`GPU: OpenCL kernels (WebGL2 backend)`；點 CPU 再變回 CPU；再點 GPU 又變回 GPU |
| fluid3d（CPU） | 有（狀態行、操作說明行） | `1000 particles \| source: CPU (wasm) \| step …` |
| fluid3d_cl（OpenCL） | 有 | `1000 particles \| source: OpenCL WebGL2 \| step …` |

輸出：nbody CPU 與 OpenCL（途中切到 GPU）的 `cx=293.7 cy=108.2 cz=269.0` 相同；fluid CPU 與 OpenCL 的 `y_mean=0.090` 相同。

**發現並修正的問題**：`nbody3d.ll`、`nbody3d_cl.ll` 在改成 ASCII 字串之後沒有重產，檔案裡仍是舊的中文提示，檢查時顯示為空白。已重產。

**2026-11-20 補充（預設 GPU、按鈕底色、自動退回）**
- `nbody3d_cl.ll` 預設 `cl_mode＝1`（GPU）。第一幀後若 `fa_cl_backend()` 是 2（JS 墊片，也就是沒有 WebGL2 浮點渲染），自動退回 CPU（`cl_pull` 讀回狀態），`cl_fb` 旗標讓狀態行寫出「GPU unavailable: WebGL2 float render not supported」。
- 按鈕底色：選中的（CPU 或 GPU）是綠色（0.12, 0.48, 0.12），未選中的是灰色（0.19）；顏色是 i1 的 select，依 `cl_mode` 即時變。字仍然畫在填色之後。CPU 版的顏色維持原本的配置。
- `fluid3d_cl.ll` 沒有按鈕，一律走 OpenCL；狀態文字依真正的後端。`nbody3d.ll`（CPU）維持 CPU，視窗標題與狀態行都推薦改跑 `nbody3d_cl.ll`。
- 驗證（`scripts/eval/llc_hud.eval.js`，SwiftShader）：開場預設 GPU（狀態行 `GPU: OpenCL kernels (WebGL2 backend)`，GPU 按鈕綠、CPU 按鈕灰）；點 CPU → CPU 綠、GPU 灰；再點 GPU → GPU 綠；模擬沒有浮點渲染 → 狀態行 `GPU unavailable: WebGL2 float render not supported`、CPU 綠；CPU 版與 OpenCL 版（預設 GPU）的最終叢集中心相同（293.7, 108.2, 269.0）；fluid 的 y_mean 相同（0.090）。

**fluid3d_cl 的 CPU／GPU 切換（2026-11-20）**：與 nbody3d_cl 一致。預設 GPU（`cl_mode＝1`）；底部兩個按鈕（CPU 在 x=470、GPU 在 x=530，y=440..460），選中的是綠色底，字畫在填色之後。切換不需要讀回或上傳（粒子狀態一直在主機上，每步由 `sph_gpu` 暫存）。GPU 那一步後若 `fa_cl_backend()` 是 2（JS 墊片），`cl_check` 退回 CPU 並設 `cl_fb`，狀態行寫「source: CPU, GPU unavailable (no WebGL2 float)」。狀態行的後端文字：`GPU (OpenCL WebGL2)`、`GPU (OpenCL JS shim, not GPU)`、`GPU (OpenCL, not dispatched)`、`CPU (wasm)`。`fluid3d.ll` 維持純 CPU。
- 驗證（`scripts/eval/llc_hud.eval.js`，SwiftShader，22 項全部通過）：開場 GPU 綠；點 CPU → CPU 綠；點 GPU → GPU 綠；模擬無浮點 → 退回 CPU 並顯示原因；y_mean 在 CPU 版、預設 GPU 版、途中 CPU→GPU 切換的版本上都是 0.090。

### 21.y（續）互動範例的螢幕說明：music_player、midi_player、sdl2_piano、sdl2_pong、sdl2_gl_triangle（2026-11-20）

做法（`renderer/src/examples/llc/_gen/_hud.py`）：
- 字型沿用 `_font_data.py` 的 7×13 點陣（只有 ASCII，說明一律用英文）。`hud_text` 把整串每列的連續亮像素合併成一段（跨字元也合併），每段一次 `SDL_RenderFillRect`；`hud_int` 畫 0..999 的整數，不足三位補空白。
- GL 版 `hud_text_gl` 每段一個四邊形，整段說明包在一個 `glBegin(GL_QUADS)`／`glEnd` 批次裡。
- 產生器（music、midi）用 DSL 呼叫 `install_dsl(m)`；手寫的 piano、pong、gl_triangle 由 `_hud_patch.py` 插入（模組層級與畫面層級各一段標記區塊，重跑會先移除舊的再插入）。
- 每個 HUD 的繪圖次數上界（最壞狀態，依 `_hud.runs` 計算）：music_player 600、midi_player 588、sdl2_piano 402、sdl2_pong 472、sdl2_gl_triangle 416（GL 四邊形）。都在 600 以內。
- 狀態文字都是真實狀態：music 的播放／暫停、目前波形、BPM；midi 的播放／暫停、音符數、來源（內嵌示範曲或 .mid 檔）；piano 已彈音符數；pong 回擊數與最佳紀錄；gl_triangle 拖曳中／閒置。
- gtk3_widgets 是真的 GTK 控制項（有標題、標籤「Not pressed yet.」與按鈕文字），不補。

發現並修正的問題：
- `llvm_core` 解析 `c"…"` 字串常數時會吃掉相鄰的空白（`"A  B"` 讀成 `"A B"`），造成「SPACE PAUSE  R」這類雙空白字串整段錯位 7 像素。修法：`_irb.esc` 把相鄰的空白寫成 `\20`（只影響相鄰空白，已提交的其他 .ll 不變，重產時才會變）。
- 數字用 `hud_int` 時，不足三位補空白（0 畫成「  0」），檢查表的期望值要照這個寫。

驗證（分開寫）：
- **node（不需要視窗）**：`renderer/src/uml/llvm_hud.test.js` 6 項全過，IR 畫出的矩形與字型逐一相同（位置、長度、順序），包含雙空白、數字與非 ASCII 位元組（畫成空白）。`llvm_host.test.js` 41 項全過；五個改過的 .ll 都能編成 wasm。
- **真 Electron（SDL 2D 畫布與 GL 畫布，預設 GL，未設 `FA_EVAL_GL=swiftshader`）**：`scripts/eval/llc_hud.eval.js` 第 5 節，50 項中 47 項通過。音樂盒、MIDI、piano、pong、gl_triangle 的說明文字與狀態（按鍵後會變）全部通過。
- **未過的 3 項**是舊的 nbody3d_cl、fluid3d_cl 按鈕底色與狀態行檢查，原因尚未查明，不屬於這次的 HUD 範例。
- **軟體繪圖與真 GPU 的差異**：這次的 SDL 文字是軟體 2D 畫布畫的；GL 三角形的疊加也是在這台機器的 GL 後端上檢查。真 GPU 的畫面未另外驗證。

## 手機：設定頁窄螢幕與終端機卡住（2026-11-20）

**使用者回報**：Galaxy A54（約 360–412 CSS px）上分類太多，設定頁到不了；`run-terminal` 輸入簡單的 `ls` 就卡住。

**設定頁**：原本 `.ai-advanced-dialog` 有 `min-width: 480px`，窄螢幕會超出畫面，分類點不到。修法是 `@media (max-width: 600px)`：外框 100vw、無最小寬度；分類列在上面、高度上限 34vh 可捲動；內容單欄；表格（例如 GPU 基準表）在自己的容器裡橫向捲動；桌面不變（`renderer/src/terminal/settings_narrow.test.js` 檢查 CSS 文字）。

**終端機卡住的根因（從程式確認的部分）**：`_handleTerminalInput` 在 `session.busy` 為真時把所有鍵盤輸入直接 `return`（只有 Ctrl+C 例外），而且不顯示任何東西。指令如果永遠不結束（例如等待沒有掛載的檔案系統），`busy` 就一直是真，之後的輸入全部被吃掉，畫面看起來就是「打字沒有反應」。修法：
1. **看門狗**：指令超過 `_terminalWatchdogMs`（預設 45 秒）還沒結束，就放開 `busy`、寫出說明（指令可能還在背景跑，按 Ctrl+C 或直接繼續輸入）。
2. **不再默默吃輸入**：指令執行中的輸入只提示一次「指令還在執行…」。
3. **手機輸入**：xterm 的隱藏 textarea 關掉自動大寫、自動更正、拼字檢查（否則 Gboard 會把 `ls` 改成 `Ls`），Enter 標示成「傳送」；觸控裝置在終端機下方加一列快捷鍵（Enter、Tab、↑↓←→、⌫、Ctrl+C、`| ~ / - > & ;`），按鍵直接送進 `_handleTerminalInput`，不經過輸入法組字；按鈕 `mousedown` 不搶焦點，鍵盤不會收起。

**沒有從程式確認、因此沒有宣稱已修的部分**：(a) `ls` 本身為什麼在手機上不結束（沒有在真的 Android 上重現；看門狗只保證不會永久卡住，不保證 `ls` 會成功）；(b) Android 的 IME 組字（keyCode 229）在真手機上是否還有別的問題（組字結束時 xterm 送來的整段文字，測試用假資料模擬）。

**測試（假的 session、假的 shell、假的 DOM）**：`renderer/src/terminal/terminal_input.test.js` 16 passed：組字結果＋Enter 執行 `ls`；指令永不結束時 40 ms 內逾時、寫出說明、busy 解除、之後的輸入照常；執行中的輸入只提示一次；正常結束沒有逾時訊息；textarea 屬性與快捷鍵列（快捷鍵 Enter 真的執行 `ls`）；桌面不加快捷鍵列。

**只在模擬上驗過的／沒驗過的**：設定頁的窄螢幕版面沒有在瀏覽器裡量到（這次的瀏覽器工具不能操作本機檔案，而且本機伺服器的啟動被拒絕），只有 CSS 文字檢查；真的 Galaxy A54、Gboard 的組字行為沒有驗證。

**附帶發現**：同一個分支上有別的 session 的提交改了 `_planLocalSummarize`（改用 `_gpuDecodeCapOn`／`_gpuChunkCap`），兩個計畫測試的假 `this` 因此少了這兩個方法；已在測試裡補上（非 Qwen 模型不套上限，與產品行為相同）。

### 快捷列（v497，2026-11-20 使用者回報：手機沒有 Tab、Esc 鍵）

- **內容**：Esc、Tab、Ctrl、Alt（修飾鍵）、↑↓←→、Home、End、PgUp、PgDn、Enter、⌫、Ctrl+C，以及 `| / ~ - _ > & ;`（手機鍵盤難打的符號）。按鈕送出的序列和實體鍵盤相同，走 `_handleTerminalInput`，所以指令攔截、歷史、Tab 補全都有效；Tab 觸發 `_handleTerminalTabComplete`。
- **修飾鍵**：Ctrl 點一下＝下一個字元變控制字元（`| → 0x1c`）後自動解除；快速點兩下（450 ms 內）＝鎖定，再點一下解除。Alt 送 ESC 前綴。按鈕顯示目前狀態（亮起、鎖定時加 🔒）。
- **焦點**：按鈕的 `mousedown`／`pointerdown` 都 `preventDefault`，所以虛擬鍵盤不會收起來；每次按完會把焦點還給終端機。觸控目標高 40px、寬至少 40px。
- **顯示**：觸控裝置預設顯示，桌面預設隱藏；上方的「快捷列 ▾／▴」可收起或展開，選擇存在 `localStorage`（`fa_term_keybar`，`try/catch`，拿不到就用預設）。
- **虛擬鍵盤**：用 `visualViewport`：鍵盤跳出（可見高度比視窗少超過 80px）時，快捷列 `position: fixed` 貼在鍵盤上方；鍵盤收起就回到原位。
- **測試（模擬）**：`renderer/src/terminal/terminal_input.test.js` 28 passed：Esc／Tab／方向鍵／Home／End／PgUp／PgDn 序列、Ctrl 單次與鎖定、Alt 前綴、Tab 觸發補全、按鈕不搶焦點、收起與記住狀態、localStorage 拿不到、鍵盤跳出與收起的定位。
- **沒有驗證**：截圖（這次的瀏覽器工具不能操作本機檔案，本機伺服器的啟動被拒絕，所以沒有在手機模擬器裡看過版面）；真的 Galaxy A54 與 Gboard 上的實際手感與 `visualViewport` 行為。

### 指令卡住：硬上限、階段名稱、Ctrl+C 立刻放開（v498，2026-11-20）

**使用者實測（Galaxy A54，Android Chrome）**：輸入 `ls`，畫面顯示「指令還在執行，鍵盤輸入先不送出；按 Ctrl+C 可以中斷」，ls 一直沒有結束。

**執行路徑（程式碼確認）**：`_handleTerminalInput`（Enter）→ `_terminalRunUnits` → `_terminalExecSimpleCommand` → `_terminalRunShellText`／`_terminalRunWasmLine`。`_terminalRunWasmLine` 依序等待：(1) `_ensureBashWasmLoaded`（載入 bash wasm 模組）、(2) `_ensureTerminalFsStore`（檔案系統）、(3) `_hydrateReferencedFapMounts`（掛載的 FAP 資料夾讀取）、(4) `_buildTerminalSandboxBuiltins`（內建工具）、(5) `_terminalRun` → `runtime.run`（shell 執行）。**以上五個 await 原本都沒有時限。**

**為什麼上一版看門狗沒有擋住**（三個原因，都在程式碼裡確認）：
1. 看門狗只蓋住 `_terminalRunUnits` 這一層，而且是固定 45 秒；它只放開 `busy`，**沒有**中止卡住的階段，也沒有丟掉執行環境，所以下一個指令會再卡在同一處。
2. Ctrl+C（`_terminalInterrupt`）只會呼叫已登記的中止函式（`_aborts`）。卡在前面四個階段時還沒有任何中止函式登記，Ctrl+C 等於沒有作用，`busy` 要等 45 秒看門狗才會放開。
3. 45 秒期間使用者只看到提示文字，沒有任何階段資訊，所以看起來就是「永遠卡住」。

**修法**：
- **每個階段都有硬上限**（`_termTimed`）：bash 載入 30 秒、檔案系統 10 秒、FAP 掛載 15 秒、內建工具 10 秒；逾時錯誤寫出階段名稱（例如「「FAP 掛載讀取」超過 15 秒沒有完成」），並記在 `session._stage`。
- **指令上限**（`_terminalCapFor`）：`ls`／`cat`／`cd`／`pwd`／`echo` 等快速指令 5 秒；`python`／`node`／`curl`／`git`／`sleep` 等長時間指令 120 秒；其餘 30 秒。看門狗與 shell 執行的上限都用它。
- **逾時後丟掉執行環境**（`_bashWasmRuntime = null`，載入失敗則清 `_bashWasmLoadPromise`），下一次重新載入，不會一直沿用卡死的環境。
- **Ctrl+C 立刻放開**：Enter 時建立 `abortP`，`_terminalInterrupt` 會 reject 它，不管卡在哪一個階段都馬上放開 `busy`，寫出「已中斷（Ctrl+C）；中斷前卡在：…」。快捷列的 Ctrl+C 按鈕就是一鍵中斷（不需要先按 Ctrl 再按 c）。
- **按鍵**：指令執行中的按鍵不保留（只提示一次），中斷或逾時後直接丟棄，不會在之後無限補送。
- **看門狗訊息**寫出指令類別、上限秒數與卡住的階段；執行中的提示也會顯示「目前在：…」，讓使用者截圖時有資訊。

**測試（模擬）**：`renderer/src/terminal/terminal_hang.test.js` 21 passed：指令上限分類、階段逾時的錯誤訊息、整條 `_terminalRunWasmLine` 在 bash 載入／檔案系統（例如 IndexedDB 被擋）／FAP 掛載／shell 執行各階段卡住時都會回傳指出階段的錯誤、shell 卡住後丟掉執行環境、Ctrl+C 立刻放開（卡在還沒登記中止函式的階段）、卡住時的按鍵只提示一次且中斷後不補送、看門狗訊息含階段、正常指令沒有多餘訊息。`terminal_input.test.js` 28 passed（既有的看門狗與快捷列測試仍通過）。

**只在模擬上驗過的**：全部。假的永不 resolve 的 Promise 代表「卡住」，但真實的 `ls` 在 Android 上卡在哪一層沒有重現（手機不在這台機器上）。所以「卡住的真正位置」仍需要使用者用新版的提示（「目前在：…」與看門狗的「卡在：…」）截圖確認；若是 FAP 掛載、IndexedDB 或 bash 載入，訊息會直接點名；若都不是，那就是 shell 執行本身，訊息會寫「指令執行（shell）」。

### echo hi 很慢：快路徑（v499）與交接（2026-11-20）

**使用者實測（Galaxy A54，Chrome）**：`echo hi` 也要等很久，所以問題在每個指令前共同的階段，不是某個指令。

**已做（有測試）**：`echo`（含 `-n`）與 `pwd` 在 `_terminalExecSimpleCommand` 直接用 JS 算出結果，不碰 bash wasm、檔案系統或 FAP 掛載。只有沒有重導向、沒有 shell 運算子的簡單寫法才走快路徑。`renderer/src/terminal/terminal_fastpath.test.js` 5 passed（假依賴，證明快路徑完全不呼叫 wasm）。

**未做（交接，下一個 session 接手）**：
1. **量每個階段的耗時**：bash wasm 下載＋編譯／實例化、檔案系統儲存開啟（`_ensureTerminalFsStore`）、FAP 掛載 hydrate（`_hydrateReferencedFapMounts`）、內建工具（`_buildTerminalSandboxBuiltins`）、shell 啟動、指令本身。在行動 UA＋CPU 降速（6x）＋網路節流（Slow 4G）下量，找最大的一段。
2. **進度顯示**：在終端機輸出每個階段的進度與已用秒數（例如「載入 shell 12 秒…」），讓使用者看到不是當機。`_termTimed` 已經記下 `session._stage`，可以接上計時。
3. **快取編譯結果**：bash wasm 的編譯結果存進 IndexedDB（`WebAssembly.compileStreaming` 的結果可以存），第二次開啟幾乎瞬間。
4. **背景預載**：頁面閒置時非阻塞地預載 bash wasm；行動版（或小記憶體）不要等到第一個指令才開始下載。
5. **惰性 hydrate**：FAP 掛載的 hydrate 改成惰性＋背景，不阻塞第一個需要 shell 的指令。
6. **更多快路徑**：`cd`、`cat`、`clear`、`help`、`ls`（沒有掛載時）同樣可以用 JS 處理，只在真的需要檔案內容時才載入對應的那一層。
7. **測試**：假的慢載入（人為延遲 wasm、hydrate、儲存開啟），驗證 echo 立刻輸出、需要 shell 的指令顯示載入進度、背景預載完成後後續指令不再等。

**真機限制**：Galaxy A54 上的實際耗時只能由使用者用新版的階段計時截圖提供；本段的測試都在模擬上。

**追加交接（2026-11-20，使用者原話：「does it requires download,i.e. bash.wasm? i have no progress」）**：是，第一次要下載 bash：jsDelivr 的 wasi-sh@0.11.0 `src/index.mjs`、`src/fs.mjs`，加上 `dist/busybox.wasm`，失敗退回 raw.githubusercontent 備份（`FA_ASSET_URLS.bashWasmJsBase`、`_ensureBashWasmLoaded`、`_fetchAssetBytesWithBackup`、`_viaAssetProxy`）。需要做：
- 位元組級下載進度：用 fetch 的 ReadableStream 讀 Content-Length，在終端機同一行即時更新「下載 shell 1.2/4.8 MB（25%，已用 3 秒）」；沒有 Content-Length 就只顯示已下載量。
- 來源與失敗：顯示目前來源（主要或備份）；失敗時寫明網址、階段、錯誤原因；自動切備份時要顯示出來。
- 快取命中時顯示「已使用快取」。
- 這一項與上面的階段計時、快取、背景預載合併做，不要各做各的。

**使用者回報（v499 手機）**：`ls`、`echo` 卡在「檔案系統初始化」，而且 5 秒就中斷；沒有下載進度。
- 5 秒中斷的原因：整體看門狗用的是指令的快速上限（ls 5 秒），第一次要下載 bash，所以在下載途中就被切斷。修正：整體看門狗改成 120 秒的保險絲；各階段仍有自己的上限，5 秒只限 shell 執行本身。
- `echo` 應該走快路徑、不進檔案系統初始化；若還看到這個階段，代表手機還沒套用 v499（請在設定更新，或重新整理）。
- 下載進度仍未做（見上面的交接項目 8）。

## bash 下載進度、快取、背景預載與快路徑（v501，2026-11-20）

**使用者需求**：第一次開終端機要下載 bash（wasi-sh 的 `index.mjs`、`fs.mjs`，加 `busybox.wasm`），手機上等很久卻沒有任何進度；`ls`、`echo hi` 也要等。

**1. 位元組級下載進度**（`_bashReadBody`、`_fetchAssetBytesWithBackup`、`_fetchAssetBackupFile`）
- 有 body 串流就一塊一塊讀，約每 100ms 回報一次。有 Content-Length 顯示 `下載 shell 1.2/4.8 MB 25% 已用 6s 來源：主要`；沒有就顯示 `已下載 X MB`。
- 進度事件走 `_bashWasmEmit`，訂閱者由 `_ensureBashWasmLoaded(onProgress)` 傳入（呼叫期間訂閱，同一個進行中的載入多個呼叫共用）。終端機用 `_terminalBashProgressWriter` 以 `\r\x1b[2K` 就地更新同一行，完成、快取命中、切換來源時換行定稿。
- 主要來源失敗：顯示 `切換備份來源`，錯誤寫明網址、階段（下載／載入 JS 模組）、原因；兩邊都失敗時訊息列出兩邊。
- 已知限制：伺服器若 gzip 壓縮，Content-Length 是壓縮後大小，解碼後的已下載量可能超過它，此時不顯示百分比。
- 分界：JS 模組（`index.mjs`、`fs.mjs`）仍用原生 `import()`，不經串流，所以沒有位元組進度，只有失敗時的切換提示。

**2. 快取與背景預載**
- 快取：Cache API（`fa-bash-wasm-v1`），key 是完整網址（含 wasi-sh 版本，升版自然失效）。只快取 wasm 位元組。開啟加 3 秒逾時，不支援或被拒就退回無快取，不影響載入。**注意：原規格提到「編譯結果」與 IndexedDB，這一版沒做**：編譯結果快取需要改 `run()` 的介面（目前吃位元組），留給下一版。
- 背景預載：`_scheduleBashWasmPreload` 在終端機掛載時排程，`requestIdleCallback`（不支援就 1.5 秒後）執行；`navigator.connection.saveData` 時不預載。前景需要時共用進行中的載入，不重複下載。預載不會讓前景「插隊」到網路頻寬之上，頻寬是共用的。
- JS 模組與 wasm 位元組分開：`_bashLoadJsModules` 只載 `run`／`memoryFs`，所以 ls／cat／cd 不必等 `busybox.wasm`。

**3. 快路徑（不等 bash wasm）**
- `echo`（含 `-n`）、`pwd`、`clear`、`help`：v499 以來或原本就是 JS。
- `cd`：目標是現成目錄時用 JS 檔案系統直接換 cwd；`~`、`-`、shell 運算子、不存在的目錄照舊交給 shell。
- `ls`、`cat`：只處理無旗標、無 shell 運算子、路徑存在（cat 的目標不是目錄）的形式，只需要 JS 檔案系統（`_terminalFsFastPath`，FAP 掛載照常 hydrate）。其餘交給 shell，錯誤訊息仍由 shell 產生。
- **未驗證的差異**：`ls` 輸出為一行一個（busybox 非終端輸出的樣子），跟 shell 版本的排版是否完全一致，還沒在實機比對。

**4. `diag` 指令**：列出 bash 執行環境是否已載入、最近的下載／快取紀錄、最近一次主要來源失敗的原因、本終端機各階段耗時與成敗（`_termTimed` 記下的，最近 15 筆）、FAP 已讀取數。給使用者截圖回報用。
- 階段上限：bash 執行環境載入的上限從 30 秒改成 120 秒，因為第一次下載在慢網路上可能超過 30 秒，原本會被切斷然後重來。

**測試（模擬，不是實機）**
- `renderer/src/terminal/terminal_progress.test.js` 40 passed：分塊串流進度單調遞增、有／無 Content-Length 的顯示、\r 就地更新、主要失敗切備份（事件與終端機文字含網址、階段、原因）、兩邊都失敗的錯誤訊息、快取命中不再下載、Cache API 開啟被拒仍可載入、JS 主要失敗切 bundle、ls／cat／cd 在 wasm 永遠不回的情況下仍立即完成、背景預載只排程一次、前景加入預載共用同一次下載、saveData 不預載、diag 階段列表、session 結束後不寫入、停滯判定（無進展才逾時、有進展就續等）、互動 echo 在載入永不回時仍立即輸出。
- `terminal_hang.test.js` 21 passed（假 `self` 補上 `_terminalBashProgressWriter`）、`terminal_input.test.js` 28 passed、`terminal_fastpath.test.js` 5 passed。

**未驗證（只在模擬上驗過）**：Galaxy A54／Chrome 上的實際下載進度觀感、真實 CDN 回傳的 Content-Length 是否存在（jsDelivr 通常有 gzip，見上面限制）、快取在行動 Chrome 的實際命中行為、背景預載在手機上會不會影響其他頁面操作。使用者請截圖 `diag` 的輸出回報。

### 手機回報的修正（v501 追加，2026-11-20）

使用者實測（Galaxy A54、網頁版）：沒有下載進度、沒有任何輸出，`ls` 與 `echo` 被「自動中斷」。原因與處理：

- **echo 仍會等**：v499 的 echo 快路徑在 AST 路徑，前面的 `_runTerminalCommand` 還會先 `await _ensureTerminalProgramLoaded`（手機上慢）。現在 echo 快路徑放在所有 `await` 之前（只收沒有 shell 運算子、第一個參數不是旗標的寫法，`-n` 例外）。
- **逾時看的是「有沒有新位元組」**：bash 載入不再用固定秒數上限（原本 30 秒，手機上第一次下載可能更久）。`_termStalled` 每秒檢查，距離最後一次下載活動超過 30 秒才逾時；有位元組進展就一直等。
- **逾時一定會印出訊息**：寫明階段、已等秒數、最後的下載量與來源（例如「bash 執行環境載入」已 30 秒沒有新的下載進度（…最後：下載 shell 1.2/4.8 MB 25% …））。ls／cat 的快路徑逾時也會印錯誤，不再無聲。
- **先出現「準備中…」**：要載入 shell 或 JS 模組時，先印一行「準備中…（第一次使用需要下載 shell，下方會顯示進度）」。
- **未做**：頁面上沒有版本號的顯示。bundle 裡沒有版本常數（版本號只在 `PATCH_VERSION` 檔與 commit）。要確認新版是否載入，請看 main 的 `web/index.html` 裡釘的 SHA 是否為新 commit，或用瀏覽器的網路面板看 jsDelivr 網址。
- **網頁版要重新整理**：發版並 pin 之後，手機要硬重新整理（或清快取）才會拿到新的 `floating-assistant` 檔。

### 手機「什麼都不顯示」與檔案傳輸按鈕（v502 追加，2026-11-20）

使用者實測：`ls`、`echo` 不論電腦版或手機版版面都「什麼都不顯示」；檔案傳輸按鈕按了沒有任何反應。

- **就緒行**：終端機掛載後立刻寫出「終端機已就緒 vNNN 欄×列」。沒有這行＝整個終端機沒有渲染（不是指令的問題）。
- **輸入紀錄**：`term.onData` 與隱藏 textarea 的 keydown／input／composition 事件都記進 `session._inputLog`（最後 10 筆）。diag 會列出。沒有任何事件＝輸入沒進到終端機（例如 IME 或焦點問題），跟「指令被中斷」是兩回事。
- **diag 新欄位**：版本、xterm 欄×列、容器寬高、devicePixelRatio、渲染器種類（canvas／DOM）、最後 10 個輸入事件。
- **檔案傳輸按鈕**：找到的問題是 `session` 不存在時直接 `return`，完全無聲。現在按下有立即的視覺回饋；沒有就緒或開啟失敗會顯示紅色中文提示（5 秒後消失）。

**未做／未能驗證**
- **根因未確認**：「echo 什麼都不顯示」沒有在模擬或真機重現。node 測試證明 echo 的快路徑會寫出文字，但沒有證明文字有畫到 xterm 上。新加的就緒行與 diag 就是為了讓使用者截圖後判斷是哪一種情況。
- **電腦版網站 + 觸控的版面**（`pointer: coarse`、980px 版面、40px 觸控目標、快捷列常駐切換按鈕）：沒有做。這是獨立的 CSS 工作，建議另開 session 做，並用 resize_window 980×1800 + 觸控模擬驗證。
- **檔案傳輸彈窗**本身的手機版面、選檔後的進度與錯誤訊息：沒有深入改，只修了按鈕的無聲失敗。
- **版本標記**是手動改的常數（`_terminalBuildTag`，這次是 v502），發版時要跟著改。

測試：`terminal_progress.test.js` 42 passed（新增 T16：diag 的版本與輸入紀錄），`terminal_hang` 21、`terminal_input` 28、`terminal_fastpath` 5 passed。

### 快捷列診斷按鈕與兩條輸入路徑（v503 追加，2026-11-20）

- **快捷列「診斷」按鈕**：一鍵把 diag 印在終端機上，不送進指令、不影響正在跑的程式。
- **兩條輸入路徑**：實體鍵盤經 xterm 的 `onData` 進 `_handleTerminalInput`；快捷列按鍵直接呼叫 `send` 再進 `_handleTerminalInput`。兩者都記錄進 `_inputLog`（來源分別是 `data` 與 `keybar`），diag 可以比對是哪一條路徑沒有到達。快捷列與鍵盤在攔截器之後走同一條路，所以若只有其中一條失效，問題在它們之前（xterm 或 DOM 事件）。
- **版本**：`_terminalBuildTag()` 目前 v503，發版時要手動改。
- **未做**：網頁版固定位置的版本顯示與 SHA 釘點。這個 repo 的 main 沒有 pin 腳本，`web/index.html` 也沒有 jsDelivr SHA 釘點，所以無法照要求把版本寫進 pin 流程；需要先確定 pin 機制在哪一個 repo。

### bash 執行環境：來源清單、停滯逾時、設定頁下載區（v504 追加，2026-11-20）

使用者實測卡在「載入 JS 模組」沒有任何進度，懷疑 CDN 太慢。

- **JS 模組來源依序嘗試**（`_bashJsSourceList`）：匯入的檔案（快取）→ 自訂網址（單檔 bundle）→ GitHub 備份（`wasi-sh.bundle.mjs`，單檔，有 bundle 才分塊）→ jsDelivr 原生 import（多檔，沒有位元組進度）。原本是 jsDelivr 原生 import 在最前面，現在改為單檔 bundle 優先，因為單檔才能顯示位元組進度、才能用 fetch 串流。
- **wasm 來源依序嘗試**（`_fetchAssetBytesWithBackup`）：匯入的檔案 → 快取 → 自訂網址 → jsDelivr → GitHub 備份。
- **停滯逾時**：每個來源有「N 秒沒有新位元組就換下一個」（`_bashWithStall`，預設 20 秒，設定可調 5–120）。每個進度或階段事件都會更新活動時間；逾時後放棄該來源，記下網址與原因，換下一個。注意：被放棄的 fetch 不會真的中止，只是不再等它。
- **錯誤訊息**：全部來源失敗時，訊息逐一列出來源名、網址、階段、原因，並提示去 設定 > 終端機 換來源。
- **設定**：白名單新增 `bashSource`（auto／imported／custom／jsdelivr／backup）、`bashCustomUrl`（只收 http(s)）、`bashStallSec`（5–120，預設 20）、`bashPreload`（預設開）。設定頁「終端機」下方新增下載區：來源、自訂網址、逾時、預載開關、重試載入、清除快取、從檔案匯入 `wasi-sh.bundle.mjs`。
- **備份資源**：GitHub `bash-wasm-backup` 分支已有 `wasi-sh.bundle.mjs`（75KB）與 `dist/busybox.wasm`，實測 HTTP 200，所以不需要另外上傳。

**未做**
- 「立即下載（全部或單項）」與「取消」按鈕：沒做。目前只有重試、清除快取、匯入、換來源。
- 下載區的「狀態列表」（每個資源的未下載／下載中／已快取大小與時間）：沒做，只有一行狀態文字。
- 窄螢幕版面：只用 inline 樣式與 flex wrap，沒有在 375px 模擬上確認。
- 匯入只支援 `wasi-sh.bundle.mjs`，不支援 busybox.wasm 的匯入。
- **網頁版版本顯示與 SHA 釘點**：這個 repo 的 main 沒有 pin 腳本，`web/index.html` 也沒有 `SHA = '…'`，所以這次無法自動釘版。`/tmp/claude-1001/qwen/pub.sh` 會用 `grep "SHA = '…'"` 取得舊值再 `sed` 替換；舊值為空時 `sed` 會替換空字串，腳本不能直接用。

**測試（模擬）**：`terminal_progress.test.js` 49 passed（新增：來源順序、自訂網址、全部失敗時的錯誤內容、白名單）、`terminal_hang` 21、`terminal_input` 28、`terminal_fastpath` 5 passed。

### 下載不中斷、單檔 bundle 優先、全部失敗自動重試（v505，2026-11-20）

使用者實測：輸入 `ls` 後停在「載入 JS 模組」，沒有進度，指令被自動中斷。**「CDN 太慢」目前只是推測，沒有量測證據**；要判斷哪一段慢，請使用者在卡住時按快捷列「診斷」，看各階段耗時與「目前來源」。

**行為變更（A）**
- 下載中絕不自動中斷指令。`_handleTerminalInput` 的 120 秒看門狗到期時，若 `_bashDownloading()` 為真就順延；只有下載完成後的指令執行才會被砍（並印出明確訊息）。
- 移除 `_termStalled`（bash 載入的 30 秒逾時）與 ls／cat 快路徑的 30 秒逾時。
- Ctrl-C（`_terminalInterrupt`）是唯一會取消下載的動作：`_bashCancelLoads()` 讓進行中的重試迴圈在下一次檢查時以「已取消」結束。
- 仍保留的上限：shell 指令執行本身（`_terminalCapFor`，快速指令 5 秒、一般 30 秒、長時間 120 秒）與 FAP 掛載讀取（15 秒）、檔案系統初始化（10 秒）。這些都在下載完成之後，逾時會印出卡在哪一個階段。

**來源與重試（B）**
- JS 模組：匯入的檔案（快取）→ GitHub 備份的單檔 `wasi-sh.bundle.mjs`（fetch 串流、有位元組進度，Blob URL 後 import）→ jsDelivr 原生 import（多檔，沒有位元組進度，最後一個）。
- busybox.wasm：匯入的檔案 → 快取 → jsDelivr → fastly.jsdelivr → unpkg → GitHub 備份。
- 每個來源有「20 秒沒有新位元組就換下一個來源」（`_bashWithStall`）；被放棄的 fetch 不會真的中止，只是不再等它。
- 所有來源都失敗：每個來源的網址與原因都印出來，然後等 15 秒自動重試（不中斷指令），直到成功或 Ctrl-C。
- 快取：bundle 與 busybox.wasm 都以完整網址為 key 存進 Cache API（`fa-bash-wasm-v1`，開啟加 3 秒逾時），失敗就退回無快取。沒有用 IndexedDB。

**測試（模擬）**
- `terminal_progress.test.js` 54 passed：停滯換源（有無新位元組）、全部失敗不丟錯而是排程重試、Ctrl-C 後才以「已取消」結束、JS 模組的來源順序與自訂網址（自訂網址仍保留，C 版會移除）。
- `terminal_hang.test.js` 23 passed：下載中指令仍在等（不被砍）、下載中看門狗順延、下載結束後看門狗照常觸發。
- `terminal_input.test.js` 28、`terminal_fastpath.test.js` 5 passed。
- **未驗證**：真實的 120 秒以上慢下載（模擬用的是假的時間）、手機上 Ctrl-C 或快捷列「中斷」是否真的走到 `_terminalInterrupt`、15 秒重試在手機背景分頁是否被節流。

**未做（C 版）**：設定頁目前仍有來源下拉、自訂網址、逾時秒數等變數，要依需求精簡成「下載狀態＋下載／重試＋清除快取＋從檔案匯入＋預載開關」。

### ls「卡在剖析指令」：根因與修正（v506，2026-11-20）

使用者實測 v505：輸入 `ls` 後畫面一直停在「剖析指令」，沒有下載進度、沒有輸出。

**根因（程式碼層面的推論，未在手機上重現）**
1. `_terminalFsFastPath` 與 `_terminalCd` 呼叫 `_bashLoadJsModules(null)`，沒有掛上這個終端機的進度訂閱者。下載在背景進行，畫面上什麼都沒有，所以看起來像「沒有進度」。
2. 這段路徑上的 await 沒有設定階段名稱。`session._stage` 一直停在入口的「剖析指令」，卡住時無從判斷卡在哪裡。
3. 沒有掛載時，`ls`／`cd` 其實不需要 FAP、IndexedDB 或 bash 下載，卻仍然走了完整的檔案系統初始化。

**修正**
- `_terminalVirtualFs()`：記憶體中的唯讀虛擬目錄（與種子檔一致：`/work/examples`、`/bin`、`/usr/bin`）。沒有掛載、session 還沒有檔案系統時，ls／cat／cd 直接用它，不等任何載入。
- `_terminalFsView()`：只有路徑碰到 `/mnt` 才載入：JS 模組（下載進度顯示在終端機）→ 開啟儲存 → 掛載資料夾。每一步都設定 `session._stage`。
- `_terminalWithBashProgress()`：讓下載的進度事件在那段工作期間顯示在這個終端機，結束即退訂。
- 入口的階段名稱改為「派送指令（尚未進入任何階段）」；diag 新增「目前階段」一行。
- **沒有自動逾時**：有掛載而卡住時不會自動結束，只有 Ctrl-C 或看門狗（只在下載完成後的指令執行才會觸發）會處理。

**測試（模擬）**：`terminal_progress.test.js` 64 passed。T20：FAP、IndexedDB、bash 載入都是永不回的假物件時，ls／cat／cd 在無掛載情況下立即完成。T21：有掛載且卡住時不自動結束，階段名稱與 diag 會指出「開啟儲存」。T22：下載進度與階段會寫進終端機，結束後退訂。
**未驗證**：真機上 Android Chrome 的 IndexedDB 行為、真實下載進度的觀感。

### 統一的「第一次使用才下載」入口（v507，2026-11-20）

使用者實測 v506：`lli`、`python` 完全沒有輸出，也沒有進度。

**根因**：python 與 lli 的路徑在 shell 載入（bash）之前，或在 `_buildTerminalSandboxBuiltins` 裡 `await` 了 Pyodide／jq，這些地方沒有掛上進度訂閱者，也沒有準備行；而 `_buildTerminalSandboxBuiltins` 外面包著 10 秒上限，會在下載中把指令砍掉。

**修正**：所有第一次使用才下載的入口都走同一個函式 `_terminalLoadRuntime(session, label, loaded, fn)`：未載入時印「準備中」，把進度訂閱到這個終端機，階段寫進 `session._stage`，沒有逾時。涵蓋：shell（python、lli、cd）、Pyodide、jq、程式套件（bundle）。Pyodide 的大檔（`pyodide.asm.wasm`、`python_stdlib.zip`）先串流下載，每個來源有停滯換源，全部失敗就等 15 秒重試；Ctrl-C 取消。程式套件的備份路徑改用串流並重試。

**未做**：`python` 有 GUI 或 async 需求時走 Worker（`_terminalRunPythonWorker`），Worker 裡面自己載入 Pyodide，這段下載的進度目前沒有回報到終端機。設定頁的下載狀態列表（C 版）也還沒做。

**測試（模擬）**：`terminal_progress.test.js` 68 passed（T23：準備行、進度、階段、已載入不印準備行；T24：python 大檔串流下載）。`terminal_hang` 23、`terminal_input` 28、`terminal_fastpath` 5 passed。**未在真機驗證**。

### 「分派指令」之後卡住：統一的載入通報（v508，2026-11-20）

使用者實測 v507：lli、python 卡在「分派指令」，沒有輸出、沒有進度。

**根因**：`_handleTerminalInput` 設定的入口階段是「派送指令（尚未進入任何階段）」。分派之後，直接呼叫 `_ensureBashWasmLoaded()` 的地方（約 40 處）沒有經過 `_terminalLoadRuntime`，所以階段永遠停在入口值，也沒有準備行與進度。

**修正（一次處理所有呼叫端）**：不再逐一修改呼叫端，改在載入函式本身通報：
- 指令開始時記下 `this._termCurrent`（目前執行中的終端機），結束時清除。
- `_ensureBashWasmLoaded`、`_ensurePyodideLoaded` 在未載入時呼叫 `_termBeginLoad`：在目前終端機印一次準備行、設定階段名稱（「載入 shell 執行環境」「載入 python」）；同時把進度訂閱到該終端機。同一指令、同一執行環境只印一次。
- lli 的 GPU 後端偵測設定階段「GPU 後端偵測（WebGPU／WebGL）」。

**測試（模擬）**：`terminal_progress.test.js` 73 passed（T25：lli 分派後載入永不結束，階段變具體名稱、畫面有準備行；T26：不論呼叫端是誰，目前終端機都收到準備行與進度，且只印一次）。hang 23、input 28、fastpath 5 passed。**未在真機驗證。**

### lli 卡在「派送指令」與備份 bundle 的 Invalid URL（v509，2026-11-20）

使用者實測 v508（手機）：diag 顯示 bash、JS 都已載入，但執行 `lli nbody3d_cl.ll` 時階段一直是「派送指令」，沒有輸出。另外「最近一次主要來源失敗」是備份 bundle 的「Failed to construct 'URL': Invalid URL」。

**Invalid URL（確定的 bug，已用 node 重現）**：備份的 `wasi-sh.bundle.mjs` 內有 4 處 `new URL(…, import.meta.url)`。包成 Blob URL 後 `import.meta.url` 是 `blob:` 網址，相對網址在這個基底下解析失敗（node 的 `new URL('./busybox.wasm', 'blob:https://example.com/abc')` 同樣拋出 Invalid URL）。修正：匯入前把 `import.meta.url` 換成 CDN 上的 `src/index.mjs` 網址（`_bashBundleSource`）。這讓快取清掉之後，備份 bundle 來源真的能用。

**lli 卡住（根因）**：`_termBeginLoad` 在 shell 已載入時直接 return，所以階段名稱從來沒有更新，停在入口的「派送指令」。真正卡住的，很可能是 `_ensureTerminalFsStore` 裡的掛載清單讀取（`_listAllFapAccessPoints`，IndexedDB），它沒有階段標記、也沒有時限，而 lli 的每次執行都會經過它。

**修正**
- 階段名稱每次載入都更新（已載入時為「檢查 …」，未載入時為「載入 …」），不再停在入口值。
- 掛載清單讀取最多等 3 秒；逾時就印出警告，只提供記憶體中的檔案系統，/mnt 暫時沒有內容，不卡住。
- lli 執行前先確認檔案存在；找不到就印「lli: <檔案>: 找不到這個檔案（目前目錄 …）」並結束，不進入執行。
- diag 新增 python（Pyodide）與 lli（LLVM）的狀態，以及「最後一次指令錯誤」。「目前階段」在指令結束後保留最後的值。

**測試（模擬）**：`terminal_progress.test.js` 79 passed。T27 用 node 重現 blob 基底的 Invalid URL，並確認替換後能解析到 CDN 上的檔案；T28 已載入時階段仍會更新；T29 lli 找不到檔案時明確報錯；T30 掛載清單永不回時 3 秒後退回記憶體檔案系統並印出警告；T25 lli 分派後載入永不結束，階段與準備行都可見。`terminal_hang` 23、`terminal_input` 28、`terminal_fastpath` 5 passed。

**未驗證**：真機上 lli 與 python 的實際執行、IndexedDB 在 Android Chrome 的行為、備份 bundle 替換後在真實瀏覽器中的載入（只用 node 驗證了 URL 解析）。python 的 Worker 路徑仍未回報進度。

### 打錯指令會卡住、掛載清單 IndexedDB 很慢（v510，2026-11-20）

使用者實測 v509：輸入 `llo`（打錯）會卡一陣子，然後出現「掛載清單讀取超過 3 秒」。

**修正**
- **打錯的指令立即回應**：不在任何已知命令表裡（JS 攔截、shell 關鍵字、內建、busybox applet、程式套件、已註冊的執行環境、使用者定義的函式）、也沒有 `/`、`=`、shell 運算子的指令，直接印 `llo: command not found` 並以 127 結束，不送進 shell、不等任何載入。
- **掛載清單改為背景讀一次**：終端機掛載後延後 1 秒讀取（`_fapWarm`），60 秒內重複使用快取。指令路徑只讀記憶體；清單還沒讀到時，指令用空清單立即執行，不等也不警告。
- **只有存取 `/mnt` 才等**：等待超過 3 秒才提示「仍在讀取掛載清單…可按 Ctrl-C 取消」。一般指令不再出現這個警告。
- **diag 分段計時**：「掛載清單」一行顯示狀態、總耗時，以及 IndexedDB 讀取（`getAll`）、權限查詢（`queryPermission`）、OPFS 工作區枚舉各自的毫秒數。

**沒有解決的部分**
- **真正慢在哪裡，還沒有確定**：我從程式碼看到的三個可能是 IndexedDB 的 `getAll`、逐一的 `queryPermission`（手機上可能需要權限互動）、以及 OPFS 根目錄的枚舉。還沒有手機上的分段數字，所以不能說是哪一段。請用 diag 的「掛載清單」那一行回報。
- **掛載變更的即時性**：快取 60 秒後才會重讀。新增或移除掛載的程式碼路徑還沒有接上快取失效（`_fapInvalidate` 未被呼叫），所以新掛載最多要 60 秒才會出現在 `/mnt`。
- **打錯指令的清單可能不完整**：busybox 的 applet 清單是靠 `TERMINAL_BUSYBOX_APPLETS` 寫死的；若 busybox 支援但清單沒有的指令，會被誤判成 command not found。
- **IndexedDB 的連線共用與 `onblocked`／`onversionchange`**：沒有逐一檢查，這一版沒有改。

**測試（模擬）**：`terminal_progress.test.js` 84 passed。T31：`llo` 立即 command not found、127；已知指令與使用者函式不被誤判。T32：掛載清單未就緒時，指令立即用空清單執行，不等、不警告。T33：掛載清單背景只讀一次；diag 顯示分段耗時。`terminal_hang` 23、`terminal_input` 28、`terminal_fastpath` 5 passed。**未在真機驗證。**

### 「command not found」誤判修正（v511，2026-11-20）

v510 引入的 JS 端「command not found」判定有誤判：已知表漏了 busybox 的真正 applet（手寫清單缺 `ash`、`echo`、`false`、`true`、`pwd`、`sh`、`unlink`、`xargs`）。

**修正**
- **applet 清單改為從 busybox.wasm 生成**：`scripts/gen-busybox-applets.js` 直接讀 wasm 裡的 applet 名稱表（字典序、NUL 分隔的連續字串），目前生成 54 個。`TERMINAL_BUSYBOX_APPLETS` 以生成結果取代手寫版本，註解註明不要手改。
- **shell 內建補齊**：cd、export、alias、unalias、source、.、type、command、read、set、unset、eval、exec、test、[、[[、wait、jobs、trap、umask、ulimit、times、local、return、exit、true、false、:。
- **保守判定**（`_terminalNotFoundBasis`）：只有同時滿足「純單字（字母開頭，無路徑、~、.、$、=、引號、數字開頭）、沒有任何 shell 語法（管線、重導向、`&&`、`;`、括號、`$()`、反引號、萬用字元、井字號）、不在任何已知表」才在 JS 端直接回 not found。其餘全部交給 shell。
- **diag**：新增「最近一次被 JS 判為 not found」，顯示指令與判定依據。

**沒有做的部分**
- **alias**：本終端機沒有 alias 功能，所以「session 的 alias」不存在可以查。
- **PATH 內可執行檔、shebang 檔、/mnt 裡的程式**：判定規則中，這些都不是純單字（或不在已知表）時才會落到 shell，所以不會被 JS 誤判；但沒有實作「在 PATH 中找可執行檔」的查詢。
- **`py`**：沒有註冊為執行環境，所以 `py` 會被判為 not found。這跟 python 的別名處理是同一件事，還沒做。

**測試（模擬）**：`terminal_progress.test.js` 117 passed。T34：內建、applet（含 xargs、unlink 等舊清單會漏的）、session 函式、已註冊執行環境、路徑形式、賦值前綴、管線、`&&`、重導向、`$()`、反引號、括號、引號、斜線指令，全部不被誤判。T35：`llo` 立即印 `llo: command not found`、exit 127，不碰儲存、掛載、bash 載入；diag 顯示依據。`terminal_hang` 23、`terminal_input` 28、`terminal_fastpath` 5 passed。**未在真機驗證。**

**尚未處理（下一版）**：python 的 Pyodide 串流下載與 Worker 進度、設定頁下載狀態列表（C 版）。

### 移除看門狗與各階段硬上限（v512，2026-11-20）

使用者實測：python 跑到 120 秒沒有回應就被看門狗砍掉。使用者要求：不要看門狗，現在有 diag 可以診斷。

**修改**
- `_handleTerminalInput` 的 120 秒看門狗已移除。指令只會被 Ctrl-C（或快捷列「中斷」）中斷。
- `_terminalRunWasmLine` 內的各階段硬上限也移除：檔案系統初始化（原 10 秒）、FAP 掛載讀取（原 15 秒）、shell 執行（原依指令 5／30／120 秒）。這些同樣會在等待中把指令砍掉。`_termTimed` 函式保留，但指令路徑不再使用。
- 卡住時的診斷：diag 的「目前階段」、「最後一次輸出」、「掛載清單」、「檔案系統初始化」耗時。

**FAP 15 秒的根因（已確認）**：手機沒有掛載，但 diag 出現「FAP 掛載讀取 15003ms」。原因是 `_refreshTerminalFapLabels` 在**每一個**指令上都 `await _listAllFapAccessPoints()`（讀 IndexedDB）。現在改為只用背景快取（`_fapWarm`），指令路徑不再等 IndexedDB。

**測試（模擬）**：`terminal_hang` 7 passed（改寫：卡住的指令不會被自動結束、Ctrl-C 才放開、bash 載入／檔案系統／FAP 掛載／shell 執行卡住時都一直等、正常指令沒有多餘訊息）。`terminal_input` 25、`terminal_progress` 117、`terminal_fastpath` 5 passed。**未在真機驗證。**

**仍然沒有做的**：python 的 Worker 路徑進度與 micropip 安裝的逐包進度；IndexedDB 開啟為什麼慢的確切原因（diag 已加「IndexedDB 開啟」耗時，但需要手機上的數字）；設定頁的下載狀態區（C 版）。
