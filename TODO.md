# xterm + Domain 架構 TODO（2026-09-18 起）

追蹤範圍：desktop-app 分支，floating-assistant.js 共用引擎 + bootstrap.js + main.js。
確認順序：**Phase 1（bug）→ Phase 2（xterm）→ Phase 3（domain 架構）**。
規則：個別完成、個別commit；未經明確「push it」不commit。

## Phase 1 — Bug 修復

- [x] Advance Settings 分組上線後，桌面版「桌面版設定」分頁（🔑API金鑰等）憑空消失 → 新增 `registerAdvancedSettingsTab()`，bootstrap.js 改用它
- [x] 桌面app不一定會堅持使用desktop op → 輕量stopgap：`delegate_to_subagent`額外補一個桌面版專屬的appendToolDescription補充（跟既有setEnvironmentNote是兩個獨立訊號通道）；過程中發現並修好一個真正的regression——`appendToolDescription()`補上去的文字原本會被`_updateDelegateToSubagentDescription()`的整段重建覆寫掉（`register_domain()`/`_saveAdvancedSettings()`都會觸發），現在`appendToolDescription()`會記住補充內容、重建時自動重新接上
- [x] 對於已安裝的Skill，AI呼叫得很薄弱/不穩定 → 找到真正根因：`delegate_to_subagent`自己的description從來沒提到使用者自訂的技能包/工具，根模型讀不到這件事就不會考慮委派，router完全沒有機會——已補上明確提示（不列出實際skill名稱，維持分層揭露原則）

## Phase 2 — xterm 終端機 widget（延續原 #3）

- [x] ~~cross-origin isolation阻塞~~ → 使用者提出更好的方向：不用wasi-sh的`spawn()`（需要crossOriginIsolated/SharedArrayBuffer），改用「指令攔截」——shell迴圈完全自己用JS實作，一般指令交給既有的`run()`（bash_execute同一個函式，純批次執行，完全不需要COI），vim/less/top這類全螢幕程式改成JS實作的bundle接管畫面。main.js的COOP/COEP標頭+SharedArrayBuffer feature flag+local-proxy.js的靜態檔案服務保留著當一般基礎設施（無害，將來可能用得到），但不再是這個功能的必要條件。
- [x] xterm.js載入（`FA_ASSET_URLS.xtermJs`/`xtermCss`，UMD build，跟其餘CDN函式庫同一種lazy-load模式）
- [x] Shell loop（JS實作的行編輯：印字/backspace/Enter/Ctrl+C/上下鍵翻歷史；`cd`/`pwd`/`clear`/`exit`/`help`這五個JS層攔截處理，維護跨指令的虛擬cwd狀態；其餘指令交給`run()`+`onOutput`即時串流輸出）
- [x] `/run-terminal` slash command：不加參數＝只開互動終端機；加參數＝開啟後直接執行；已在slash指令選單可見
- [x] Terminal program bundle機制（`registerTerminalProgram()`/`_ensureTerminalProgramLoaded()`）：vim/less/top這類指令設計成可外掛抓回來的獨立bundle（呼應使用者原話），不寫死進floating-assistant.js。**目前`TERMINAL_PROGRAM_BUNDLES`registry是空的——機制已驗證可運作（載入/dispatch/接管鍵盤輸入都測過），但vim/less/top/more還沒有實際bundle內容，打這幾個指令目前會被busybox回報「not found」**
- [ ] 實作真正的vim-like/less-like/more-like bundle（JS host builtin，不是busybox原生binary——原生的在這個沙盒沒有fork/exec，README明確排除在scope外）。`top`因為沒有其他process可列，考慮直接不做或做一個只顯示假資訊的版本
- [ ] 新Configure分頁：xterm設定——字體、字體大小、column數、可回捲行數、要不要scroll to output、佈景主題（system跟隨外部theme／ubuntu／powershell／黑底白字／白底黑字）——**目前完全沒有UI，字體/大小/主題都是寫死的預設值**
- [ ] 終端機後端切換設定：優先WASM模擬器 vs 使用者真實系統shell（網頁版只能選模擬器）——**目前只有WASM emulator這一條路徑，真實系統shell backend還沒做**；使用者已確認：真實shell backend走真正的OS pty，vim/top/less應該原生就能動，不需要這裡的intercept/bundle機制
- [ ] 新增虛擬CLI工具`ask-floating-ai-assistant`，自動註冊在xterm環境的PATH裡：行為等同`FloatingAssistantApp -p`，可指定回應格式[text,json]，阻塞等待回應，所有思考過程走stderr；WASM模擬器跟真實shell都要能用到——**還沒開始**，架構上應該做成一個JS層攔截的指令（跟cd/pwd同一種模式），不是真的丟進busybox執行

## Phase 3 — Domain / Subagent 架構

- [ ] 新增「研究」subagent domain：很會叫用檔案讀取＋很會叫用思考，先判斷使用者是想修改程式還是分析。檔案存取：FAP（web+desktop都適用）＋（desktop限定）fs_read_file/真實絕對路徑能力，涵蓋對話中提到的路徑跟目前working directory
- [ ] 目前subagent domain清單UI（看得到現有哪些domain）
- [ ] Domain管理UI：內建domain（不可刪除）＋使用者自建；每個domain可以自己描述內容
- [ ] Domain描述欄位旁「AI revise」按鈕：跳對話框，讓LLM檢查這段描述會不會影響選擇時的權重
- [ ] Domain管理UI「AI Dry Run」：輸入框+按鈕，模擬目前這個LLM model面對某個假設性需求會路由到哪個domain、原因是什麼
- [ ] Skill編輯畫面：choose domain（像MediaWiki的category一樣，可選現有的、也可以create new）
- [ ] Configure > AI：「主domain偏好」選項（例如Programming／Stock Analysis）——不只影響路由權重，也影響回應風格：選了Programming偏好後，AI應該優先寫檔案/實際操作，不要把code當聊天內容直接回覆
