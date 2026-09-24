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
| `desktop-app/TODO.md` | 這個子系統各次功能加入/修正的完整歷史紀錄與驗證方式（Phase 5起陸續累加） |
