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

---

# TODO: 多對話並行背景執行 + chat list UI（進行中沙漏／未讀圖示／正確的最後更新時間）

## 使用者需求（原話整理）

1. aiweb跟desktop app除了chat list以外，可以在對話進行中切換chat list，切過去時「不受影響、
   繼續執行」——也就是切走不會中斷正在跑的那個對話。
2. 更新的內容/進度要「清楚知道自己是來自哪個對話」，正確更新回原本發出請求的那個對話，不是
   誤更新到「使用者現在正在看的那個對話」。
3. chat list每一項要有狀態圖示：
   - 對話還在執行中（尚未完成）→ 顯示類似沙漏的「進行中」圖示。
   - 對話已完成、但使用者還沒點進去看過結果 → 顯示「未讀」圖示。
   - 點進去看＝已讀，未讀圖示消失。
4. **已知bug**：目前「只要點一下chat list裡的項目（切換過去看）」，那個對話的「最後更新時間」
   就會被更新——這是錯的，最後更新時間應該只在「真的有新內容（新的user訊息/AI回應）加進那個
   對話」時才更新，單純切換過去查看不算。

## 已確認的根本原因：整個引擎目前只有「一個對話」的全域可變狀態

追查`_chatSwitch`/`_chatBusy`（`renderer/src/floating-assistant.js`）後確認：

- `this.messages`（目前對話的訊息陣列）、`this.isResponding`（是否正在等LLM回應）、
  `this._chatIndex.currentId`（目前作用中對話的id）**全部是`this`instance上的單一全域欄位**，
  不是「每個對話各自獨立」的狀態。
- `_chatBusy()`（`_chatSwitch`/`_chatNew`/`_chatDelete`共用的守門）直接檢查
  `this.isResponding`，**只要有任何對話正在等回應，整個chat list就完全鎖死、不能切換／新增／
  刪除**（`_chatBusy()`裡甚至會印出「AI 回應中，請先按 Stop 或等它完成」）。這證實使用者要的
  「切走不中斷」目前完全不支援，不是bug、是架構上根本沒做。
- 所有寫回存檔的地方（`_persistChatHistory()`全專案30處呼叫、`_touchCurrentChatMeta()`）都是
  無條件對`this._chatIndex.currentId`（**當下UI正在顯示的那個對話**）動作，不是對「這次回應
  真正屬於哪個對話」動作——如果將來真的放開`_chatBusy()`的限制、讓回應在背景繼續跑，現有這套
  寫法會直接把在背景完成的回應寫進「使用者切換過去、現在正在看的那個不相干的對話」，資料會
  互相污染。這也是使用者回報「最後更新時間」問題最可能的根因方向之一：`updatedAt`從來不是
  「這個對話真的被寫入新內容」才觸發，而是耦合在同一份global mutable state上，任何時序上的
  巧合都可能造成觀感上「切換=更新時間」。

**結論：這不是一個小bug修正，是要把「單一全域對話狀態」改成「每個對話各自獨立的執行狀態」的
架構調整**，範圍跟nvim-wasm整合是同一個量級，需要同樣分階段進行、每階段各自驗證。

## 執行階段（尚未開始）

- [ ] **階段0：盤點目前所有讀寫`this.messages`/`this.isResponding`的地方**
  - [ ] 列出`executeChat()`主迴圈、工具呼叫處理、`delegate_to_subagent`委派、
        `pruneContext()`/`_checkTopicTransition()`壓縮邏輯等所有直接讀寫這兩個欄位的函式
        （這些之後都要改成吃一個「對話執行context」參數，不能再假設只有一份全域狀態）
  - [ ] 盤點畫面渲染面（`_renderMessageHistory`/`_renderChatList`等）目前怎麼假設「畫面上顯示
        的就是`this.messages`」，改動後要能「畫面顯示對話A，但對話B在背景繼續跑」而不互相干擾

- [ ] **階段1：設計「每個對話一份獨立執行狀態」的資料結構**
  - [ ] 例如`this._chatRuntimes = Map<chatId, { messages, isResponding, abortController,
        turnPruneCount, ... }>`，取代目前直接掛在`this`上的單一全域欄位
  - [ ] `_chatSwitch()`改成「只是換畫面顯示指到哪個runtime」，不再需要`_chatBusy()`擋著不能切
        （在背景執行中的對話依然用它自己那份`_chatRuntimes.get(id)`繼續跑，不受畫面切換影響）
  - [ ] 明確定義「目前正在畫面上顯示」跟「目前正在背景執行」是兩個獨立的概念（可以同時有好幾個
        對話在背景執行，畫面永遠只顯示其中一個）

- [ ] **階段2：改寫所有持久化/更新邏輯，明確帶入chatId**
  - [ ] `_persistChatHistory()`/`_touchCurrentChatMeta()`/`_writeChatBlob()`全部改成接受明確的
        `chatId`參數（不是隱含用`this._chatIndex.currentId`），呼叫端從對應的`_chatRuntimes`
        entry取得，確保背景對話完成時寫回的是它自己真正的那個chatId，不是使用者當下正在看的
        chatId
  - [ ] `updatedAt`只在「這個chatId真的被寫入新訊息內容」的那一刻更新（確切定位在
        `_writeChatBlob`/`_touchCurrentChatMeta`實際被content-changing事件呼叫到的那幾個點——
        單純畫面切換／查看不能觸發這條路徑），修正使用者回報的「點一下就更新時間」

- [ ] **階段3：chat list UI狀態圖示**
  - [ ] 每個`_chatRuntimes` entry增加`status`欄位：`idle`/`running`/`done-unread`/`done-read`
  - [ ] `_renderChatList()`依`status`在對應的`.cl-item`上畫沙漏（running）或未讀圓點/圖示
        （done-unread）
  - [ ] `_chatSwitch()`切換進某個對話時，如果該對話目前是`done-unread`，切換動作本身要順便把
        狀態改成`done-read`（「點進去看＝已讀」），並重繪chat list清掉未讀圖示
  - [ ] 對話從`running`變成完成的那一刻：如果使用者「當下正在看」這個對話＝不用顯示未讀（直接
        算已讀，因為畫面上已經看得到結果了）；如果使用者當下在看別的對話＝標成`done-unread`

- [ ] **階段4：中斷/錯誤處理**
  - [ ] 背景執行中的對話如果中途出錯/被中止（例如使用者按了Stop，但Stop目前的實作可能也預設
        「只能停目前顯示中的對話」，要確認改成能指定停哪一個chatId的背景執行），狀態要正確降級
        （不能卡在`running`）
  - [ ] 分頁/App關閉、重新整理時，背景執行中的對話（還沒完成）狀態怎麼處理——目前完全沒有
        「背景執行」這個概念，重新整理會不會直接把進行中的回應弄丟需要一併考慮

- [ ] **階段5：資源/併發上限**
  - [ ] 使用者可能同時開很多個對話、每個都在背景跑——要不要限制同時背景執行的對話數量（避免
        無限制併發打爆API rate limit/瀏覽器資源），如果要限制，超過上限時新的請求怎麼處理
        （排隊？還是拒絕、提示使用者先等其他背景對話完成？）

## 遠端群組：之後再做

- [ ] **Cloudflare Tunnel 層**（五層後備之後的第六層，暫緩）：桌面版用 `cloudflared` 開具名通道當中繼站，只有桌面版能被派工與傳輸，網頁版只能當發出需求的一端。暫緩原因：要額外安裝 `cloudflared`、之後它更新了還要跟著更新，網頁版又不能隨開隨貢獻；目前四個 Supabase 專案加 Cloudflare KV 已經夠用。要做時：使用者有自己的網域，可用固定的子網域，不需要先靠 KV 通知網址。
- [ ] 影片串流（邊收邊播）、TURN 備援實測、三台以上機器同時在線實測、KV 層多台機器的讀取額度實測。

## 專案索引：匯出的 HTML 要能「自己讀寫、自己問答」（之後再做，2026-10-13 使用者提出）

背景：專案索引設定頁拿掉了「匯出問答 HTML」「存進專案資料夾」「從專案資料夾載入」「匯出索引檔」「匯入索引檔」五個按鈕
（索引改成直接建立在專案資料夾的 `.floating-assistant/index/`，預設索引完成自動存回、再開專案自動接續）。
目前保留「匯出 SQLite HTML」；下面是希望它變成的樣子（完整設計見 [DESIGN.project-index.md](DESIGN.project-index.md) §16～§19）：

- [x] **匯出的 HTML 自帶 File Access Point（fap）**：打開後可以授權專案資料夾，用 fap 直接**讀寫原始碼**、**讀寫 sqlite**（索引資料庫），
  不用再回到助理主程式操作。
- [x] **內建 AI 問答（部分）**：HTML 自己下載小模型（Qwen3 0.6B，跟助理主程式同一個預設）。模型放進專案的隱藏資料夾
  （`.floating-assistant/` 底下），並可載入瀏覽器的 persistent storage（同一份快取，不重複下載）；靜默下載、用到才載入。
- [x] **搭配離線訓練器（Offline Trainer）的能力**：用類似 tree-sitter 的結構分析，快速讀懂程式的「定義」與「架構」（符號、依賴、呼叫關係），
  問答時由程式先查結構、小模型只負責措辭與選擇題，不要讓 0.6B 自己硬讀整份原始碼（跟離線食譜模式同一個思路）。
- 完成狀態與限制見 [DESIGN.project-index.md](DESIGN.project-index.md) §19、§20：已做大索引分段匯出、頁內「🧠 解釋」（語法樹＋函式語意＋離線模型）、批次更新與資料夾說明。**還沒做**：模型檔存進專案 `.floating-assistant/models/`（目前只存瀏覽器快取）、真的 `showDirectoryPicker` 手動走一次、100 MB 以上與 7 萬檔專案的實測。
- 要先確認的事：HTML 單檔大小（內嵌 sqlite wasm 與小模型載入器）、網頁版與桌面版的 fap 授權流程差異、模型下載來源（HuggingFace）在 file:// 下能不能用。

---

# TODO：本機 `/edge-tts` 的 Sec-MS-GEC v2 簽章（先放著，目前夠用）

2026-10-14 評估：本機 proxy 的 `/edge-tts`（`edge-tts.js`）路由、驗證、CORS 都在，但實際合成會被 Microsoft 擋（握手 **403**）。
同一台機器上最新的參考函式庫 `edge-tts 7.3.1` 能合成，差別是協定改了：

- [ ] `Sec-MS-GEC-Version` 現在是 `2-143.0.3650.75`（我們送 `1-…`）。
- [ ] `Sec-MS-GEC` 改成 v2：`<16 hex>-<64 hex>`，由自訂的 SHA-256＋CS64 雜湊算出（參考 `edge_tts/drm.py` 的 `generate_sec_ms_gec_v2`，約 250 行）。移植後用 Python 在固定時間戳下的輸出當測試向量驗證。
- [ ] 403 時用回應的 `Date` 標頭校正時鐘差再重試一次（`DRM.handle_client_response_error`）。
- [ ] `edge-tts.js` 單元測試（簽章測試向量、驗證、錯誤路徑）。
- [ ] 授權：參考實作是 LGPL-3.0，直接移植要補 `THIRD-PARTY-NOTICES.md`，需先決定能不能接受。
- [ ] 使用者那份 Cloudflare `worker.js` 用的也是舊的 v1 公式，之後可能一樣失效（不在這個 repo）。

目前的替代：離線 Kokoro 中文語音已加上（使用者自己加的），線上中文語音失敗時會退到它，所以不急。
安裝版若根路徑回 404，多半是 9/21（`b903975d`）之前沒有 `/edge-tts` 路由的舊版；本機 proxy 的埠是隨機的，repo 裡沒有 `41877`。

---

# TODO：程式設計 domain 的 patch 小工具與 CI/CD（2026-10-14）

已完成並驗證的內容見 [DESIGN.coding-ci.md](DESIGN.coding-ci.md)。還沒做：

- [ ] 用**真的需要登入**的 Gerrit／GitHub／Jenkins 實測一次（認證標頭、Gerrit `/a/` 前綴、Jenkins crumb、反向代理／SSO 環境）；目前只驗過公開服務與本機假伺服器。
- [ ] 真實弱模型走完整修 bug 流程（提示詞遵從度）；路由器是否把「修 bug／CI 失敗」導向 `coding`。
- [ ] Gerrit：回覆個別留言（reply／resolve）、`rebase`／`submit` 這類 review 動作；GitLab／Zuul／Azure DevOps 的連線。
- [ ] 網頁版的 `coding_edit`／`coding_patch_tool`（目前只有桌面版）。
- [ ] Jenkinsfile 解析：動態 stage、`@Library` 共享函式庫。
- [ ] 設定頁「CI/CD 連線」目前只在工程模式顯示；若要常駐可以從 `ADVANCED_ENGINEERING_CATS` 拿掉。

# 之後的計畫：四個方向（2026-10-21 使用者提出，尚未開始）

## 1. Knowledge Inventory（FAP／IndexedDB 為主的本機 NotebookLM）
- 來源（上傳檔案、抓回來的網頁、FAP 資料夾的檔案、對話裡的內容）進同一個「收藏庫」，存在 IndexedDB；每個來源有章節目錄（可用 `article_outline`）、摘要、可引用的片段。
- 問答要附出處（來源、章節、片段），離線時用本機檢索，線上時才請模型整理；弱模型只問封閉式問題（挑片段、挑編號）。
- 待決定：向量檢索用哪個小模型、片段大小、容量上限與淘汰、是否能匯出／匯入成一包。

## 2. WebGPU／CPU＋transformers.js 的圖像生成（模型要夠小）
- 已整合（2026-10-22）：SDXS-512 一步取樣，GPU 版約 880 MB（fp16，WebGPU）、CPU 版約 1.12 GB（int8，wasm）；第一次下載的同意與授權提示、快取、設定、`generate_image`／`/image` 的 `provider` 都做好了，見 DESIGN.image-generation.md。
- [ ] 還沒做：在真機上實測載入與生圖（WebGPU 與 CPU 各一組速度與記憶體數字）；Electron 開 crossOriginIsolated 讓 CPU 版能多執行緒；更小的 CPU 模型（目前 CPU 版 1.1 GB）；對話裡以圖生圖／多張。

## 3. 桌面版專用功能 `computer use`（給弱模型用）
- 動作層：Windows 用類似 nircmd 的小工具，Linux 用 xdotool＋wmctrl；Windows 的視窗／控制項清單用 UI Automation（類似 Spy++）。
- 弱模型（Florence-2 base、LLaVA-Interleave Qwen 0.5B）負責描述與辨識：sash、網頁分頁、開始功能表、按鈕、標題列、工具列、各種視窗元件、整個畫面；程式負責座標、比例與驗證。
- 探索 → 移動 → 拍照確認：移動滑鼠看游標圖示與物件的變化來猜哪些可以點；分辨某個框是不是動畫，是的話接上連續取樣的觀察串流；用移動滑鼠加拍照量出滑鼠速度與座標比例。
- 整串流程要是 UML design → code，最後整體行為可以匯出給使用者直接跑。
- 安全：一律先預覽要做的動作、可隨時中止；不碰系統設定、密碼欄位、付款；範圍限定在使用者指定的視窗。

## 4. 安全自我升級
- 知道自己的原始碼位置、讀得懂；替每一段行為建索引；把現有程式反推成 UML design，再從 UML design 產生更新的程式。
- 新版先放進沙盒隔離測試；裝上去後啟動畫面，確認「自升級的部分」沒壞；壞了自己還原（沿用 live-patch 已有的「壞版本標記＋退回安裝包內建版」機制）。
- 邊界：只能改 renderer 那四個可熱更新的檔案；主行程與 preload 的改動不自動套用。


# TODO：`/edit-3d-model`（3D 場景編輯器，2026-10-23 使用者提出，任務大，先記下來）

跟 `/worksheet`、`/edit-html`（= `/webedit`）同一類：一個有 AI 對話框的編輯器，用斜線指令開啟。

## 使用者需求（原話整理）

- 主體是 **3D 場景 viewer**，旁邊有 AI 對話框，**完全基於我（使用者）的相對視角**擺放與編輯：「在我左前方放一個紅色的球」「把它移到桌子上面」。可以要求放入什麼形狀、在什麼位置。
- 兩個檢視：**物件 view**（場景裡有哪些物件，樹狀）與**物件屬性 view**（位置、旋轉、縮放、顏色、材質、貼圖…）。
- 可以切成 **viewer** 或 **3D scene YAML 的 source view**：source 可以直接編輯，編輯後切回 viewer 立刻呈現。
- 進編輯模式再退出，會**更新回去**（回到原本的對話或原本開啟的場景），而且**可以持續編輯**（再進來還是同一份）。
- 可以要求**貼上什麼貼圖**（對話裡說，或從對話框貼上素材）。
- **深入編輯單一物件**：在物件 view 的項目上**連點兩下**進入單一物件的編輯畫面，在那裡決定**哪個位置貼什麼圖**、可以從對話框貼上素材。感覺像在編輯一個 **GK 塑膠模型**：可以決定上色與貼皮。
- **場景與每個元件的編輯器都有 undo／redo**，也都支援 **AI 對話編輯**。
- 可以**匯出最後的 YAML**，也可以**匯出整個過程的有效 prompt**（只留下真的有影響結果的那些對話，方便重現）。
- 整個 3D 編輯器可以**視窗化、最大化**（沿用 `renderer/src/ui/win_shell.js` 的視窗外殼）。

## 可以重用的現成東西（開工前先看）

- 場景 YAML 與檢視：`render_3d_scene` 工具與 `viewer3d`（`FA_DECK_SRC.viewer3d`、scene_tools）已經有宣告式的場景描述（基本形狀 mesh、材質…）。
- 編輯器骨架：`renderer/src/worksheet/`（對話修改、屬性面板、復原／重做、附圖）與 `renderer/src/webedit/`（原始碼檢視與預覽切換、視窗外殼）是同一類，可以照著做。
- 視窗：`renderer/src/ui/win_shell.js`。
- 規劃：依 `DESIGN.image.md` 的做法（由上而下細切到單元、再依型別接線）把「對話 → 場景修改」拆成單元：解析相對位置（以使用者視角為座標系）、放置形狀、改屬性、貼圖、移動／對齊、刪除；小模型只回答封閉的小問題。

## 要先決定的事（做之前要問使用者）

1. 「相對視角」的座標系：以**目前相機**為準（左／右／前／後／上／下隨相機轉動），還是以**場景的固定前方**為準？
2. 貼圖的 UV：只做基本形狀的內建 UV，還是要讓使用者在單一物件畫面裡指定區域（貼在哪個面、縮放、旋轉）？
3. 匯入現成模型（obj／glb）要不要在第一版就做？
4. 匯出的「有效 prompt」怎麼判定有效：只留沒被 undo 掉、而且改變了場景的那些輪次？

## 分階段（尚未開始）

1. 場景 YAML 的 source view 與 viewer 雙向同步（編輯後立刻呈現）＋進出編輯模式＋視窗化。
2. 物件 view／屬性 view＋場景層級的 undo／redo。
3. AI 對話編輯：相對視角的位置解析＋放置形狀＋改屬性（全部走單元與接線）。
4. 貼圖：整個物件貼圖；然後單一物件編輯畫面（連點兩下進入）與分區貼皮、上色。
5. 每個元件各自的 undo／redo＋AI 對話；匯出 YAML 與有效 prompt。
