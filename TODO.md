# xterm + Domain 架構 TODO（2026-09-18 起）

追蹤範圍：desktop-app 分支，floating-assistant.js 共用引擎 + bootstrap.js + main.js。
確認順序：**Phase 1（bug）→ Phase 2（xterm）→ Phase 3（domain 架構）**。
規則：個別完成、個別commit；未經明確「push it」不commit。

## Phase 1 — Bug 修復

- [x] Advance Settings 分組上線後，桌面版「桌面版設定」分頁（🔑API金鑰等）憑空消失 → 新增 `registerAdvancedSettingsTab()`，bootstrap.js 改用它
- [x] 桌面app不一定會堅持使用desktop op → 輕量stopgap：`delegate_to_subagent`額外補一個桌面版專屬的appendToolDescription補充（跟既有setEnvironmentNote是兩個獨立訊號通道）；過程中發現並修好一個真正的regression——`appendToolDescription()`補上去的文字原本會被`_updateDelegateToSubagentDescription()`的整段重建覆寫掉（`register_domain()`/`_saveAdvancedSettings()`都會觸發），現在`appendToolDescription()`會記住補充內容、重建時自動重新接上
- [x] 對於已安裝的Skill，AI呼叫得很薄弱/不穩定 → 找到真正根因：`delegate_to_subagent`自己的description從來沒提到使用者自訂的技能包/工具，根模型讀不到這件事就不會考慮委派，router完全沒有機會——已補上明確提示（不列出實際skill名稱，維持分層揭露原則）

## Phase 2 — xterm 終端機 widget（延續原 #3）

- [ ] 新Configure分頁：xterm設定——字體、字體大小、column數、可回捲行數、要不要scroll to output、佈景主題（system跟隨外部theme／ubuntu／powershell／黑底白字／白底黑字）
- [ ] 終端機後端切換設定：優先WASM模擬器 vs 使用者真實系統shell（網頁版只能選模擬器）
- [ ] 真正的終端機模擬（xterm.js整合）：支援ANSI上色、特殊字元、vim/top/less/more這類全螢幕互動操作
- [ ] `/run-terminal` slash command：不加參數＝嵌入互動xterm；加參數＝嵌入+執行；要能在slash指令選單被找到
- [ ] 新增虛擬CLI工具`ask-floating-ai-assistant`，自動註冊在xterm環境的PATH裡：行為等同`FloatingAssistantApp -p`，可指定回應格式[text,json]，阻塞等待回應，所有思考過程走stderr；WASM模擬器跟真實shell都要能用到

## Phase 3 — Domain / Subagent 架構

- [ ] 新增「研究」subagent domain：很會叫用檔案讀取＋很會叫用思考，先判斷使用者是想修改程式還是分析。檔案存取：FAP（web+desktop都適用）＋（desktop限定）fs_read_file/真實絕對路徑能力，涵蓋對話中提到的路徑跟目前working directory
- [ ] 目前subagent domain清單UI（看得到現有哪些domain）
- [ ] Domain管理UI：內建domain（不可刪除）＋使用者自建；每個domain可以自己描述內容
- [ ] Domain描述欄位旁「AI revise」按鈕：跳對話框，讓LLM檢查這段描述會不會影響選擇時的權重
- [ ] Domain管理UI「AI Dry Run」：輸入框+按鈕，模擬目前這個LLM model面對某個假設性需求會路由到哪個domain、原因是什麼
- [ ] Skill編輯畫面：choose domain（像MediaWiki的category一樣，可選現有的、也可以create new）
- [ ] Configure > AI：「主domain偏好」選項（例如Programming／Stock Analysis）——不只影響路由權重，也影響回應風格：選了Programming偏好後，AI應該優先寫檔案/實際操作，不要把code當聊天內容直接回覆
