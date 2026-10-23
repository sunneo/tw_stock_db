<!-- 從 TODO.md 拆出（2026-10-23）：內容原封不動，只是改成一份一個主題。 -->

# TODO: Neovim in WASM with WASI（nvim-wasm）取代/run-terminal裡手寫的vim clone

## 背景

`/run-terminal`裡的vim是`terminal-programs/editor.mjs`手刻的簡化JS clone，不是真的vim
（原因見`DESIGN.run-terminal.md`§7：wasi-sh本身明講不支援互動式全螢幕程式，沒有fork/exec）。
使用者實測回報一長串缺的功能：`:set nu`、`:set wrap`不認得、`/`搜尋不能用、Esc-u/r/c/v/p/y
（undo/redo/剪下/visual/貼上/複製等視覺模式操作）全部無效——這些都是簡化clone從來沒做過的
真實vim功能，不是bug，是clone架構性的能力上限。

使用者明確要求「完整的vim，例如vim.wasm」，不要再繼續補丁clone。

## 已排除：rhysd/vim.wasm

- 不是終端機程式，是Vim的GUI frontend（像GTK frontend一樣，只是換成`<canvas>`+`<input>`）。
- 執行緒模型靠Web Worker + `SharedArrayBuffer`跟主執行緒溝通，需要`crossOriginIsolated===true`
  （COOP/COEP headers）。
- 桌面版用`loadFile()`載入`file://`、網頁版用GitHub Pages（沒有自訂response header的空間）都
  沒辦法滿足`crossOriginIsolated`——這正是當初選擇手寫clone架構、放棄wasi-sh `spawn()`的同一道牆
  （見`DESIGN.run-terminal.md`），不是新問題，vim.wasm一樣會撞到。
- 就算能跑，畫面模型也對不上：它要自己的`<canvas>`+`<input>`，不是把ANSI文字流進xterm.js終端機，
  沒辦法「長得像」現有終端機裡打開一個vim session的樣子。

參考：https://github.com/rhysd/vim.wasm 、 https://github.com/rhysd/vim.wasm/issues/45

## 選定方向：nvim-wasm（MuNeNiCK/nvim-wasm）+ Asyncify + xterm-pty

真正的Neovim（C+Lua）透過WASI SDK編譯成`wasm32-wasi`。關鍵是它有Asyncify後處理版本：
`wasi_snapshot_preview1.poll_oneoff`可以在等待輸入時「暫停」整個wasm執行、讓Worker透過
`postMessage`把鍵盤輸入送進去再「恢復」執行——**不需要`SharedArrayBuffer`**，正面繞開
crossOriginIsolated這道牆。

跟xterm.js的整合用`xterm-pty`（cryptool-org/wasm-webterm或xterm-pty本身，兩個都是「連接
xterm.js跟Emscripten/WASI終端機程式」的現成bridge），概念上是真正的PTY層，不是自己從頭刻。

參考：
- https://github.com/MuNeNICK/nvim-wasm
- https://xterm-pty.netlify.app/
- https://github.com/cryptool-org/wasm-webterm

## 已知風險 / 還沒驗證的假設

1. **沒有prebuilt binary**，必須從C/Lua原始碼建置（WASI SDK + CMake + Binaryen + Lua +
   libuv + luv + lua-compat-5.3，全部從`github.com/*/releases/download/*`跟`lua.org/ftp`抓）。
   這個sandbox環境能不能連到這些下載來源**還沒實測確認**（curl測試因為當時Bash工具本身故障
   沒能跑完，下一步要先補測）。
2. 這是早期fork（截至查證時只有28個commit），社群規模小，建置過程遇到問題時能參考的除錯資訊
   有限，要有心理準備可能要自己debug build failure，不是穩定跑得完的`make`。
3. repo本身的demo把「xterm.js UI」跟「SAB-free Asyncify」列成**分開**的demo選項
   （`demo-xterm`用SharedArrayBuffer、`demo-asyncify`可能是別的畫面，不是xterm.js）——目前看起來
   **沒有現成「xterm.js + Asyncify（免SAB）」的組合demo**，可能要自己把Asyncify那份demo的
   I/O callback（postMessage-based stdin、stdout callback）接到xterm.js終端機上，不是抓來就能用。
4. 建置完wasm binary後，還要處理「開檔/存檔」怎麼接回我們自己的沙盒檔案系統
   （`session.fsStore`，跟wasi-sh目前用的是同一顆——理想上nvim開的檔案應該要跟同一個terminal
   session裡`ls`/`cat`看到的是同一份，不是另外開一個獨立、互不相通的檔案系統）。細節（WASI
   preopens怎麼指到我們的memoryFs）還沒查證。
5. wasm binary本身（Neovim完整功能）體積預期會比目前的wasi-sh busybox（已經算大）更大很多，
   首次載入時間/頻寬成本要納入評估（可能需要跟xterm.js/wasi-sh一樣走`_faLoadScriptOnce`+CDN
   backup分支的既有機制）。

## 執行階段（尚未開始，逐步進行、每階段各自驗證後才進下一階段）

- [ ] **階段0：可行性探測**（不寫功能程式碼，只確認地基穩不穩）
  - [ ] 確認這個sandbox環境能不能連到WASI SDK/CMake/Binaryen/libuv/luv/lua-compat-5.3的
        github releases下載網址、以及lua.org/ftp
  - [ ] 找一台可以裝這些build工具（wasi-sdk/cmake/binaryen/lua開發工具鏈）的環境（本機sandbox或
        另開worktree/背景agent），實際跑`make host-lua && make wasm-deps && make wasm`，
        確認光是「編出一顆能跑的nvim.wasm（還沒Asyncify）」這一步能不能成功、要花多久
  - [ ] 跑`make wasm-asyncify`，確認Asyncify後處理版本能不能正常產生、體積/效能差異大概多少

- [ ] **階段1：獨立驗證Asyncify版nvim.wasm能不能在瀏覽器裡「跑起來」**（先不接我們自己的終端機/
      檔案系統，就開一個最小的測試頁）
  - [ ] 照著nvim-wasm自己的Asyncify demo（非xterm.js版）跑一次，確認基本互動（開檔、打字、
        `:w`存檔、`:q`離開）在真實Electron/瀏覽器裡正常運作、且完全不需要
        `crossOriginIsolated`/`SharedArrayBuffer`

- [ ] **階段2：接上xterm.js（PTY bridge）**
  - [ ] 研究Asyncify demo的I/O callback介面（postMessage送鍵盤輸入、收stdout bytes的callback
        長什麼樣子），改接到xterm.js的`Terminal.write()`/`onData()`，不透過原本demo自帶的畫面
  - [ ] 驗證真的能在xterm.js終端機視窗裡看到vim畫面（ANSI escape正確渲染：狀態列、行號、語法
        高亮等），鍵盤輸入（含Esc序列、方向鍵、Ctrl組合鍵）正確送達

- [ ] **階段3：接上我們自己的沙盒檔案系統**
  - [ ] 研究nvim-wasm的WASI preopens設定方式，讓`vim <file>`開的檔案讀寫對應到
        `session.fsStore`（跟同一個terminal session的`ls`/`cat`共用同一份，不是各自獨立）
  - [ ] 存檔（`:w`）後，terminal session的其他指令（`cat`/`ls`）要能立刻看到最新內容

- [ ] **階段4：接進終端機指令分派**
  - [ ] `_runTerminalCommand`/`terminal_run`遇到`vim`/`nvim`指令時，改成掛載這個真正的nvim
        widget（取代目前呼叫`editor.mjs`那個分支），互動輸入路徑（使用者自己在畫面上打字）
        要能正常接手鍵盤事件（跟目前`activeProgram`機制整合）
  - [ ] 確認`terminal_run`這個「一次呼�叫、等執行完才回傳」的AI工具介面，跟一個「互動式、不會
        自己結束」的nvim session怎麼共存（可能需要限制AI工具呼叫路徑不能直接開互動式nvim，
        只有真人使用者手動在畫面上打字才能開，跟`activeProgram`既有的「必須是整行唯一指令」
        限制精神一致）

- [ ] **階段5：資源/效能驗證＋正式整合進build**
  - [ ] 確認多個terminal同時開nvim不會讓分頁資源暴增（跟既有`_terminalSessionIsLive`/
        resourcePolicy機制的關係）
  - [ ] 首次載入的wasm體積、CDN backup分支（比照`_faLoadScriptOnce`+`assetBackupProxyUrl`）
  - [ ] 移除/保留`editor.mjs`（決定是整個換掉、還是當作nvim載入失敗時的fallback）
  - [ ] 完整測試使用者原始回報的具體項目：`:set nu`、`:set wrap`、`/`搜尋、Esc-u（undo）、
        Esc-r（redo）、Esc-c（change/剪下相關visual操作）、Esc-v（visual mode）、
        Esc-p（貼上）、Esc-y（複製/yank）——這些理論上是「真的Neovim」原生就支援的功能，
        全部要逐一實測確認在這個整合下真的可用，不能只假設「因為是真vim所以應該可以」
