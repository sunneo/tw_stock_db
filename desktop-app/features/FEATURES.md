# AI 功能清單

> 這份檔案由 `node scripts/ai-features.js build` 從 `features/ai-features.yaml` 自動產生，請不要手改。

## 助理本身

對話、建議、模型與多代理人分工

### 建議操作（`suggest`）

一開始或清空對話後，顯示可以直接點的建議；輸入 /suggest 可以重新顯示。

- 可用平台：網頁版、桌面版
- 斜線指令：`/suggest`
- 範例：
  - `/suggest`

### AI 功能總覽（`ai-features`）

列出助理所有功能（依分類），也可以查單一分類或單一功能的說明與範例。

- 可用平台：網頁版、桌面版
- 斜線指令：`/ai-features`
- 子代理人領域：`feature_guide`
- AI 工具：`list_ai_features`
- 範例：
  - `/ai-features`
  - `/ai-features media`
  - `你有哪些功能？`
  - `怎麼把影片轉成逐字稿？`

### 專家子代理人分工（`subagent-delegation`）

複雜任務會自動委派給專門領域的子代理人（檔案解讀、3D、繪圖、影音、程式設計…），只把結論帶回主對話，不污染上下文。

- 可用平台：網頁版、桌面版
- AI 工具：`delegate_to_subagent`、`get_tool_details`
- 介面入口：設定 → 多代理人模式
- 範例：
  - `幫我用 3D 畫一個太陽系，並且做成可以旋轉的場景`

### 模型基準測試（`benchmark-model`）

對指定模型跑簡易回應、單一工具呼叫、完整多步驟報告三項測試並算加權總分，評估要不要內建。

- 可用平台：網頁版、桌面版
- 斜線指令：`/benchmark-model`
- 範例：
  - `/benchmark-model nvidia/nemotron-3-super-120b-a12b`

### 淺色／深色主題（`theme`）

上方列的主題按鈕切換淺色或深色，設定面板也會跟著換。

- 可用平台：網頁版、桌面版
- 介面入口：上方列主題按鈕

### 對話清單（左邊，可收合、可分群組）（`chat-list`）

桌面版與 aiweb 左邊有可拖曳調整寬度、可收合的對話清單，每個對話各有自己的訊息；可以新增、切換、刪除，也能分群組（拖曳或右鍵移動）。右鍵對話可重新命名、匯出 Markdown／JSON、刪除。單機版存成檔案（使用者資料夾 AppData/Roaming/floating-assistant-desktop/chats），aiweb 存在瀏覽器的 persistentStorage；台股頁不啟用。

- 可用平台：桌面版
- 介面入口：左邊對話清單（☰ 收合、右鍵選單）

### 台灣節慶套版（`festival-themes`）

依台灣行事曆（連假也算同一個節慶）自動換上春節、元宵、端午、中秋、國慶、聖誕…的套版，越接近節日越豐富（中秋前月亮漸盈、春節前逐漸高掛鞭炮）；套版從 GitHub 的 festival-themes 分支下載，每個不超過 1MB。

- 可用平台：網頁版、桌面版
- 介面入口：設定 → LLM 基礎設定 → 啟用台灣節慶套版

### 離線訓練器（AI 失效時的備援）（`offline-trainer`）

不經過 AI 也能做事：純文字→槽位擷取（網址、路徑、引號）→規則與語意比對（字串雜湊向量＋中英文概念詞典）→文字重排（BM25＋TextRank＋MMR）→決定要呼叫的工具與參數（含「開分頁→讀文字→關分頁」這類多步驟做法）→執行並整理結果。畫面右上角的開關可以切成純離線；所有 AI model 都失敗時會自動退回離線（可關）。線上 AI 成功的做法、RAG 與對話紀錄會自動學進去；在「設定 → AI → 離線訓練器」可以管理領域、規則、範例句、同義詞，並用乾跑確認它會怎麼判斷（不會真的執行）。有副作用的工具執行前一定先問使用者。AI 可以用 offline_trainer 的 add_tool（原始碼工具，在沙盒 worker 執行）／add_state（狀態機）／add_pattern 把解法寫回去，離線時就能重現；勾選「自動訓練」後，長期對話的成功做法（例如一直在查 SDK 的定義）會由背景 worker 整理成「觸發規則＋狀態機＋原始碼」的技能，離線時做不到的請求會記成待辦給 AI。訓練成果（規則＋狀態機＋原始碼工具＋已學會的解法＋同義詞）可以匯出成單一 JSON 檔、在別台電腦匯入（匯入會逐一檢查原始碼語法與 checksum，並請你確認）；AI 寫的原始碼工具可用 run_tool 試跑、改壞了可以 rollback_tool。/offline-trainer-by-ai（通用，需先打開自動訓練）：讓 AI 處理一個任務或一長串同類項目（每行一項、regex 抽取或 JSON 陣列），並要求 AI 每次成功後把可重複的做法寫回離線訓練器（原始碼工具＋狀態機＋規則）；每一項先讓離線訓練器自己試，離線自己解決的比例就是訓練成效；可停止、接續、看報告。

- 可用平台：網頁版、桌面版
- 斜線指令：`/offline`、`/offline-dry`
- AI 工具：`offline_trainer`
- 介面入口：畫面右上角的線上／離線開關、設定 → AI → 離線訓練器
- 範例：
  - `/offline on`
  - `/offline-dry 用瀏覽器控制開啟 https://example.com 並說明內容`
  - `把這個問答教給離線訓練器`

## 知識與自製函式

知識圖譜（RAG）、AI 自製函式、儲存常用腳本

### 知識圖譜（RAG）（`rag`）

把筆記或大文件存成知識節點，之後用自然語言查詢；大文件會自動分段。

- 可用平台：網頁版、桌面版
- 子代理人領域：`rag_lookup`、`rag_management`
- AI 工具：`rag_store_graph_node`、`rag_query_graph`、`rag_chunk_document`、`rag_delete`
- 範例：
  - `把這份文件存進知識庫`
  - `知識庫裡有沒有關於 KD 黃金交叉的筆記？`

### AI 自製函式（`ai-functions`）

讓助理把常用流程存成可重複呼叫的函式，之後直接叫用。

- 可用平台：網頁版、桌面版
- 子代理人領域：`ai_functions`
- AI 工具：`list_ai_functions`、`call_ai_function`、`add_ai_function`、`delete_ai_function`
- 範例：
  - `幫我建立一個函式，把輸入的價格換算成漲跌幅`

### 儲存腳本（`saved-scripts`）

把 bash／python 腳本存起來，之後用名稱取回再執行。

- 可用平台：網頁版、桌面版
- AI 工具：`register_saved_script`、`list_saved_scripts`、`get_saved_script`
- 範例：
  - `把剛剛那段 python 存成 stats-report 腳本`

## 檔案與資料夾

上傳檔案解讀、授權資料夾存取、圖片理解

### 上傳檔案解讀（`file-analysis`）

解讀你上傳的 csv／xlsx／json／markdown／yaml／docx／pptx／log 等檔案，也能解開 zip／tar／tgz；大檔會自動分段摘要。

- 可用平台：網頁版、桌面版
- 子代理人領域：`file_analysis`
- AI 工具：`list_uploaded_files`、`parse_uploaded_file`、`summarize_large_text`、`attachment_apply_patch`
- 範例：
  - `幫我看剛上傳的 xlsx，整理成重點表格`

### 圖片理解（`image-interpret`）

描述或解讀上傳的圖片內容（圖表、截圖、照片）。

- 可用平台：網頁版、桌面版
- AI 工具：`interpret_image`
- 範例：
  - `這張截圖裡的錯誤訊息是什麼意思？`

### 圖片比較與投影片抽圖（`image-compare`）

把 pptx 投影片裡嵌入的圖片抽出來，或把多張圖片（含影片截幀、瀏覽器截圖）一起交給讀圖模型比較。

- 可用平台：網頁版、桌面版
- 斜線指令：`/media-compare-images`
- AI 工具：`extract_pptx_images`、`compare_images`
- 範例：
  - `把這份 pptx 每張投影片裡的圖片抽出來`
  - `比較這兩張圖有什麼不同`
  - `/media-compare-images file_1,file_2 哪一張比較新`

### 合併PDF附件（`merge-pdfs`）

把多份已上傳的PDF依指定順序合併成一份新的PDF；直接複製原始頁面（不重新渲染），合併後文字仍可選取/搜尋、畫質不劣化。不支援有密碼保護的PDF。

- 可用平台：網頁版、桌面版
- 斜線指令：`/office-pdf-merge`
- 子代理人領域：`file_analysis`
- AI 工具：`merge_pdfs`
- 範例：
  - `把這三份上傳的PDF合併成一個`
  - `幫我把這幾份報告PDF照順序併成一份`
  - `/office-pdf-merge file_1 file_2`

### 辦公室報告／簡報（週報、pptx）（`office-report`）

專門處理週報、簡報、投影片、pptx／docx／xlsx、合併PDF附件的固定流程：先找現成腳本直接執行、用 python 當主軸、大檔案先 grep 定位再讀那一段；產出後一定驗證（pptx_inspect 檢查大小／頁數／master／圖片／斷掉的關聯，PowerPoint 逐頁轉圖後用 compare_images 比對）。不綁定任何特定公司系統。

- 可用平台：桌面版
- 子代理人領域：`office_report`
- AI 工具：`pptx_inspect`、`office_export_slide_images`、`fs_grep`、`extract_pptx_images`、`compare_images`、`merge_pdfs`
- 範例：
  - `依範本產生這週的簡報，並逐頁檢查有沒有圖片或背景掉了`
  - `檢查這份 pptx 有沒有壞掉、為什麼檔案很難打開`
  - `把這幾份上傳的PDF合併成一份`

### 授權資料夾存取（File Access Point）（`file-access-points`）

授權一個真實資料夾後，助理可以列出、讀取、搜尋、寫入修補其中的檔案。

- 可用平台：網頁版、桌面版
- 斜線指令：`/fap-list`、`/fap-read`、`/fap-find`
- 子代理人領域：`file_access_points`
- AI 工具：`list_file_access_points`、`fap_list_files`、`fap_read_file`、`fap_find_file`、`fap_write_file`、`fap_apply_patch`、`fap_copy_from_storage`、`fap_copy_to_storage`、`fap_download_url`
- 範例：
  - `/fap-list`
  - `/fap-read fap:我的筆記/todo.txt`
  - `/fap-find fap:我的筆記 todo`

### 本機檔案與指令執行（`desktop-ops`）

直接讀寫本機檔案、執行系統指令、開 tmux 工作階段（桌面版限定，需在設定允許）。

- 可用平台：桌面版
- 子代理人領域：`desktop_ops`
- AI 工具：`run_command`、`fs_read_file`、`fs_write_file`、`fs_list_files`、`fs_find_file`、`fs_grep`、`fs_stat`、`fs_mkdir`、`fs_remove`、`tmux_start_session`、`tmux_send_keys`、`tmux_capture_pane`、`tmux_list_sessions`、`tmux_kill_session`、`batch_process_items`、`analyze_large_file`、`get_large_file_analysis_chunk`
- 範例：
  - `列出這個資料夾最大的 10 個檔案`
  - `在背景開一個 tmux 跑這個腳本`

## 程式設計與版本控制

流程化寫程式、git 操作、Skill 建立、沙盒內執行程式

### 程式設計流程（`coding-workflow`）

評估、需求分析、設計計畫、用 git patch 修改、語法檢查、測試、發佈，可中斷後恢復（桌面版限定）。

- 可用平台：桌面版
- 子代理人領域：`coding`
- AI 工具：`coding_read_file`、`apply_git_patch`、`git_inspect`、`coding_task_state`、`coding_run_tests`、`coding_run_check`、`coding_workspace`
- 範例：
  - `在目前工作目錄修一個 bug，全程用 git patch，改完跑測試`

### 程式設計領域分支（各有計畫範本與狀態機）（`programming-domains`）

依領域分支的程式設計：平行程式設計、HPC、web service、生態系設計、繪圖工具、嵌入式／Raspberry Pi、BMC／OpenBMC、Android、Windows、iOS。每個領域都有固定的計畫範本與狀態機（評估→實驗→設計→實作→驗證→交付，缺欄位會被退回、每一步都告訴你下一步做什麼），專為較弱的模型設計；驗證不了的部分（硬體、工具鏈）一定要誠實列出。可以申請或替換各領域的工具。

- 可用平台：網頁版、桌面版
- 子代理人領域：`prog_parallel`、`prog_hpc`、`prog_webservice`、`prog_ecosystem`、`prog_graphics`、`prog_embedded`、`prog_bmc`、`prog_bios`、`prog_android`、`prog_windows`、`prog_ios`
- AI 工具：`playbook_state`、`programming_domains`
- 範例：
  - `我要用 Cloudflare Worker 做一個待辦清單 REST API（程式設計：web service 領域）`
  - `幫我設計 Raspberry Pi 讀溫度感測器、超過門檻就亮燈的程式`
  - `我想做一個 OpenBMC 的 Redfish 感測器服務，先用 mock 驗證介面`
  - `列出程式設計有哪些領域，並把 render_3d_scene 申請給繪圖工具領域`

### BIOS／UEFI／EDK II（Tianocore）開發領域（`bios-uefi`）

BIOS 韌體開發領域：先決定改動在哪個階段（SEC／PEI／DXE／BDS／TSL／RT／AL）或哪一類檔案（建置中繼資料、HII 設定畫面），有計畫範本與狀態機。內建 INF、DEC、DSC、FDF、UNI、VFR、VFCF 檔案解析與一致性檢查（uefi_parse），GUID 結構與字串互轉。

- 可用平台：網頁版、桌面版
- 子代理人領域：`prog_bios`、`know_uefi`
- AI 工具：`uefi_parse`、`programming_knowledge`、`playbook_state`
- 範例：
  - `幫我在 PEI 建立一個平台資訊 HOB 給 DXE 讀取（BIOS／UEFI 領域）`
  - `幫我檢查這份 INF／DEC／DSC 有沒有錯`
  - `這個 VFR 和 UNI 的字串對得起來嗎？`

### 程式設計知識助理（Rust／UEFI／OpenBMC）（`programming-knowledge`）

把背景知識放在獨立的知識助理與卡片庫，避免塞爆開發領域的上下文：Rust 語法與函式庫、UEFI／EDK II（階段、Protocol、HOB、服務、變數、建置、檔案格式）、OpenBMC 分層（kernel、HAL、感測器與 Entity Manager、D-Bus 與 IPMI、Redfish、SNMP、Web）。每次只回最相關的一兩張卡，並能引導取出各開發領域的計畫範本與狀態機。

- 可用平台：網頁版、桌面版
- 子代理人領域：`know_uefi`、`know_openbmc`、`know_rust`
- AI 工具：`programming_knowledge`
- 範例：
  - `Rust 的借用和生命週期是什麼意思？`
  - `UEFI 的 gBS 和 gRT 差在哪裡？`
  - `OpenBMC 的 Entity Manager 設定檔怎麼寫？`
  - `給我 BMC Redfish 開發的計畫範本`

### 不認識的程式語言探索（`language-explore`）

遇到舊模型不認識的新語言或框架：先查內建與已保存的知識，沒有才上網探索（至少兩個來源）、整理成入門摘要，再詢問使用者要成為新的領域（含知識助理與開發領域）、只記到 RAG，或先不要。

- 可用平台：網頁版、桌面版
- 子代理人領域：`lang_explorer`
- AI 工具：`language_explore`
- 範例：
  - `我要用 Zig 寫個小工具，但你好像不熟 Zig`
  - `這個專案用了一個你沒看過的語言，先學起來`

### 沙盒實驗（先實驗再設計）（`sandbox-lab`）

設計前先在沙盒真的跑一次確認行為：隔離的 iframe（可複製目前畫面）、瀏覽器控制的全新 about:blank 分頁、彈出視窗（使用者按一下）、Web Worker（有持久檔案系統、可測 handler(request)）、Python web app（micropip 安裝 Flask／FastAPI 後直接以測試請求呼叫）。先用 sandbox_capabilities 評估目前能用哪些。

- 可用平台：網頁版、桌面版
- AI 工具：`sandbox_capabilities`、`sandbox_html`、`sandbox_worker`、`sandbox_mock`、`sandbox_py_app`
- 範例：
  - `先用沙盒做一個點擊計數器，確認事件行為再改我的頁面`
  - `用 Worker 模擬 Cloudflare Worker 的 handler，送幾個請求看回應`
  - `用 Flask 寫個 API 在沙盒裡測 /hi 和 /sum`

### 沙盒模擬後端（測試與部署同一份）（`sandbox-mock`）

被測試的頁面照常寫 fetch／XMLHttpRequest／EventSource／WebSocket，沙盒只在測試時把它們接到 Web Worker 裡的伺服器程式（iframe 與瀏覽器控制的新分頁都支援），資料存在持久儲存（IndexedDB）。伺服器程式用標準 Request／Response（router、crud、ws），可匯出成 Node 或 Cloudflare Workers 部署檔，頁面程式碼不用為了測試或部署改動。全部在瀏覽器裡跑，沙盒不使用 Cloudflare Worker 的流量（*.workers.dev、*.pages.dev 與設定的 proxy 網址一律擋下）。

- 可用平台：網頁版、桌面版
- AI 工具：`sandbox_mock`、`sandbox_html`
- 範例：
  - `幫我寫待辦清單的前端，並用沙盒模擬 REST API 測試新增、修改、刪除`
  - `做一個聊天室，沙盒裡用模擬 WebSocket 測試兩個人互傳訊息`
  - `測好之後匯出成 Node 伺服器讓我部署`

### 專案結構追蹤（分階段）（`repo-map`）

有專案／repository 時先追出結構（網頁版用已授權資料夾，桌面版可直接給絕對路徑）：最小地圖→逐批展開資料夾→逐批分析檔案的定義與依賴。只給模糊名稱也能 find 出原始碼，再沿依賴 explore；路徑不存在就當結構改變，只從最近還存在的那一層重追；整份索引（index_start）會先問使用者，之後在背景漸進建立（進度卡片、可停止、可接續、大型專案如已 build 的 OpenBMC 也行，大小與檔案數有上限可調），並記下每個定義上面的註解與檔案之間的呼叫關係。

- 可用平台：網頁版、桌面版
- 子代理人領域：`coding`
- AI 工具：`repo_map`、`repo_ask`、`repo_read_doc`
- 範例：
  - `幫我找一下專案裡處理登入的原始碼，再看它依賴哪些檔案`
  - `這個檔案路徑找不到了，專案是不是改過結構？`
  - `先看一下這個 repo 的整體結構`

### 專案索引百科（類似 DeepWiki）（`repo-wiki`）

類似 DeepWiki 的專案百科，分階段產生（避免大專案的檔案清單被截斷、也避免只得到一份空泛的 markdown）：plan 算出模組與頁面清單 → 每頁 evidence（預算內的事實與程式碼片段＋寫法規定）→ AI 寫成有說明的頁面並 write_page（驗證標題、字數、引用的檔案必須存在）→ finalize 組成單檔的查詢頁面（頁面、依賴圖、結構、定義、名詞）；沒寫的頁面用結構草稿補上；頁面多時委派 wiki_writer 子任務。存進 persistentStorage（IndexedDB），可選擇寫進專案資料夾。export 可產生單檔 HTML：內嵌 SQLite（看百科畫面、瀏覽檔案與符號、離線問答、直接下 SQL 查檔案關聯與呼叫關係）或純 HTML／JavaScript 的問答頁。

- 可用平台：網頁版、桌面版
- 子代理人領域：`coding`、`wiki_writer`
- AI 工具：`repo_wiki`、`repo_map`
- 範例：
  - `幫這個專案產生可以搜尋的百科頁面`
  - `查一下 parseConfig 這個函式定義在哪、誰在用`
  - `幫專案裡的重要名詞寫定義，放進百科`

### AIDoc 專案文件（/aidoc、/ai-repo-doc）（`aidoc`）

專案索引的整套操作：/aidoc index 選資料夾建立索引（桌面版直接用路徑，網頁版選完自動授權成 fap）、/aidoc dive 讓 AI 逐檔讀程式碼把確認過的說明補進資料庫、/aidoc view 開互動檢視器（可視窗化／最大化，左邊瀏覽、右邊對話查資料，點進檔案或函式可請 AI 排隊回答，過程用假的 fetch／WebSocket 與主程式溝通）、/aidoc save／load／bundle／import 讓不同人拿同一份專案繼續延伸索引與說明。AI 的程式設計相關領域可用 repo_map／repo_ask 快速取得整體結構，深入後用 annotate 補說明。舊名 /deepwiki 仍可用。

- 可用平台：網頁版、桌面版
- 子代理人領域：`coding`
- AI 工具：`repo_map`、`repo_ask`、`repo_read_doc`
- 範例：
  - `/aidoc view`
  - `幫這個專案建立索引並讓 AI 補上每個檔案的說明`
  - `把專案的索引存進專案資料夾，同事拿到可以接著補`

### 查錯誤碼（Linux／Windows）（`ref-error-codes`）

離線查錯誤碼的意思：Linux errno（EACCES、13、-ENOMEM）、訊號（SIGSEGV）、shell 退出碼（139、127）、Windows Win32 錯誤（ERROR_ACCESS_DENIED、GetLastError）、HRESULT（0x80070005，含解碼）、NTSTATUS（0xC0000005，也吃帶號整數）、Winsock（10061）。這些知識同時用在程式行為說明裡（錯誤碼常數、exit code 會被標註）。

- 可用平台：網頁版、桌面版
- 斜線指令：`/ref`
- AI 工具：`lookup_error_code`
- 範例：
  - `errno 13 是什麼意思`
  - `0xC0000005 是什麼錯誤`
  - `ERROR_ACCESS_DENIED 怎麼處理`
  - `exit code 139 代表什麼`
  - `GetLastError 126 是什麼`
  - `WSAECONNREFUSED 10061`
  - `0x80070005`

### 逐項解釋命令列（gcc、qemu、gdb、Linux 命令）（`ref-command-explain`）

離線逐項解釋整行命令：gcc／g++／javac／java／python／node／gdb／qemu-system-arm／aarch64／x86_64（含 -M 機型、-cpu、-drive／-device／-netdev 子選項、-append 核心命令列，並講整台模擬機器怎麼組）與常用 Linux 命令（grep、find、tar、curl、ssh、rsync、systemctl、git、docker、cmake、make… 內容來自 man 手冊重點）。

- 可用平台：網頁版、桌面版
- 斜線指令：`/ref`
- AI 工具：`explain_command_line`
- 範例：
  - `qemu-system-aarch64 -M virt -cpu cortex-a53 -m 1G -kernel Image -nographic 這行在做什麼`
  - `gcc -O2 -fopenmp -march=native main.c -o a.out 各代表什麼`
  - `gdb --args ./a.out 怎麼用`
  - `tar -xzvf a.tar.gz -C /tmp`
  - `javac -d out -cp lib/* Main.java`

### 日誌診斷（建置錯誤、gdb、核心日誌、kernel panic、journal）（`ref-log-diagnose`）

離線讀懂日誌並說明發生什麼事：建置失敗（make、CMake、BitBake／Yocto、ninja、Meson、autotools、Kbuild、gcc／g++／clang 編譯錯誤、ld 連結錯誤、Maven、Gradle、npm、Cargo、pip、Go）、gdb 訊息（Program received signal、Cannot access memory、遠端除錯架構不符…）、Linux 核心日誌（dmesg、Oops、soft lockup、OOM、驅動 probe 失敗、韌體缺失、模組載入）、kernel panic（找不到根檔案系統、init 死掉）、systemd／journal（服務啟動失敗、status=203/EXEC、start-limit-hit、sshd 登入失敗、SELinux／AppArmor 拒絕）。找出根本原因、連帶結果與傳遞路徑（編譯器錯誤→make→BitBake 任務失敗），並說明常見原因與處理。沒有規則的錯誤行進「待學習清單」，AI 之後補規則（每條要附真實範例驗證與來源），越用越完整。

- 可用平台：網頁版、桌面版
- 斜線指令：`/ref`
- AI 工具：`diagnose_log`、`explain_build_error`
- 範例：
  - `make: *** [Makefile:45: foo.o] Error 1 這是什麼意思`
  - `ERROR: Nothing PROVIDES 'libfoo'`
  - `undefined reference to sqrt 怎麼解`
  - `Kernel panic - not syncing: VFS: Unable to mount root fs on unknown-block(0,0)`
  - `myapp.service: Main process exited, code=exited, status=203/EXEC`
  - `Program received signal SIGSEGV 然後 Cannot access memory at address 0x0`
  - `/ref diag <貼上整段日誌>`
  - `/ref queue`

### 查 pragma、選項與參考知識（`ref-lookup`）

離線查 C 的

- 可用平台：網頁版、桌面版
- 斜線指令：`/ref`
- AI 工具：`ref_lookup`
- 範例：
  - `#pragma omp parallel for reduction(+:sum) 怎麼解釋`
  - `gcc 的 -fPIC 是什麼`
  - `omp schedule dynamic 和 static 差在哪`
  - `gdb 的 x 命令怎麼看記憶體`
  - `#pragma pack(push,1)`

### AI 自己找資料擴充知識庫（`ref-expand`）

讓 AI 上網查官方資料，補進離線訓練器與 AIDoc 行為說明的知識（錯誤碼、命令選項、API 語意、pragma，以及文法 pattern、語意、分詞規則、組合語言、建置系統）；分成「離線訓練器知識擴充」與「AIDoc 行為說明擴充」兩個領域，補的每一筆都附來源。補的內容可用 /ref export 匯出，交給開發者或 Claude 升級成內建（scripts/promote-runtime-defs.js）。內建涵蓋 OpenMP、MPI（MPICH／MVAPICH）、BLAS、cuBLAS、cuDNN、CUDA 執行期與驅動 API、Linux 核心標頭函式的引數與回傳值語意。

- 可用平台：網頁版、桌面版
- 斜線指令：`/ref`
- 子代理人領域：`offline_knowledge_expander`、`aidoc_knowledge_expander`
- AI 工具：`ref_expand`、`ref_define`
- 範例：
  - `/ref expand RISC-V 向量指令`
  - `/ref expand Windows 網路相關的 HRESULT --aidoc`
  - `/ref export`
  - `幫我查官方文件，補 Bazel 建置檔的知識`

### 可註冊的知識類型（有結構的知識）（`knowledge-types`）

離線訓練器的知識除了文字，還能註冊「類型」（用 schema 描述 customize 欄位：數字範圍、列舉、清單、物件、引用其他條目、繼承），之後補的條目依類型驗證，可遞迴引用、繼承、帶參數覆寫地展開，並有循環與缺漏檢查；用來描述臉的部位、骨骼、關節運動、聲音、手勢、畫面物件等有結構的知識。需要知識資料格式 v1：舊格式（v0）照常使用，用到時才會問你要不要 migration（離線訓練器設定頁也有 Migration、備份、還原按鈕）。

- 可用平台：網頁版、桌面版
- AI 工具：`ref_types`、`ref_resolve`、`ref_validate`、`ref_define`
- 範例：
  - `列出已註冊的知識類型`
  - `把 human-face 展開成完整定義`
  - `檢查整個知識庫的引用有沒有壞掉`
  - `註冊一個 gesture 類型`

### 程式行為分析（explain_code）（`behavior-analyzer`）

把原始碼／組合語言解釋成由下而上、沿正向路徑、可折疊的行為說明：函式與檔案自己的註解優先，區塊註解重排後部分採用，aidoc 裡 AI 或使用者補的說明更優先；沒有註解就用呼叫事實（引數與回傳值語意、47 個行為分類、組合語言 idiom）。不認得的呼叫列成候選，可用 behavior_define 補定義（持久保存、可匯出匯入，也能直接匯入 Domain Resolver 的 yml 定義）。支援 C／Java／JavaScript／Python／Shell／PowerShell／Batch／GLSL／x86 與 ARM 組合語言／LLVM IR／PTX／WASM。aidoc 用 /aidoc explain <檔案> [函式]，檢視器檔案頁有「行為說明」。

- 可用平台：網頁版、桌面版
- 斜線指令：`/aidoc`
- 子代理人領域：`coding`
- AI 工具：`explain_code`、`behavior_define`
- 範例：
  - `解釋這個函式在做什麼`
  - `/aidoc explain src/net.c recv_all`
  - `這段組合語言在做什麼`
  - `解釋這支 Rust 檔案`
  - `這段 Go 程式在做什麼`
  - `解釋這個 C++ 類別（用了哪些 STL）`

### 程式碼問答（類似 doxygen＋語意搜尋）（`repo-ask`）

問專案裡「某個函式做什麼」「在哪裡定義」「誰用到它」「跟什麼相關」「某功能的程式在哪」。依 repo_map 的索引（定義、註解、簽名、依賴、呼叫關係）回答，用字串雜湊向量＋BM25＋TextRank 重排，不需要模型；回傳事實與程式碼片段讓 AI 整理成回答。同一個問答引擎也會內嵌進匯出的 HTML，離線在瀏覽器裡問。

- 可用平台：網頁版、桌面版
- 子代理人領域：`coding`
- AI 工具：`repo_ask`、`repo_wiki`
- 範例：
  - `parse_config 這個函式是做什麼的？`
  - `誰用到 Logger 這個類別？`
  - `處理登入的程式碼在哪些檔案？`
  - `把這個專案匯出成可以離線查詢、能下 SQL 的 HTML`

### git 操作（`git-operations`）

clone、pull、status、log、commit、push（網頁版透過 worker 中繼）。

- 可用平台：網頁版、桌面版
- 子代理人領域：`git_operations`
- AI 工具：`git_clone`、`git_pull`、`git_status`、`git_log`、`git_commit`、`git_push`
- 範例：
  - `幫我 clone 這個 repo 並看最近 5 筆 commit`

### 建立 Skill（`skill-creator`）

建立 Claude 格式的 Skill（SKILL.md 加腳本與參考資料），可下載成 .skill 檔，也能匯入匯出。

- 可用平台：網頁版、桌面版
- 子代理人領域：`skills`
- AI 工具：`skill_create`、`skill_list`、`skill_read`
- 介面入口：設定 → Skill
- 範例：
  - `幫我建立一個整理會議紀錄的 Skill`

### 沙盒程式執行（`code-execution`）

在瀏覽器沙盒內執行 bash（busybox）與 python（Pyodide），管線可以混用 python、jq、xq。

- 可用平台：網頁版、桌面版
- 子代理人領域：`code_execution`
- AI 工具：`bash_execute`、`python_execute`
- 範例：
  - `用 python 算費氏數列前 20 項，再用 column -t 排版`

### 互動終端機（`terminal`）

在對話裡嵌入可以直接打字的終端機（WASM 沙盒），可與沙盒互相複製檔案。

- 可用平台：網頁版、桌面版
- 斜線指令：`/run-terminal`、`/run-terminal-cp-to`、`/run-terminal-cp-from`
- AI 工具：`terminal_create`、`terminal_list`、`terminal_run`、`terminal_get_text`、`terminal_cp_to`、`terminal_cp_from`
- 範例：
  - `/run-terminal`
  - `/run-terminal ls -la`

## 圖表與視覺化

繪圖、流程圖、3D 場景、互動元件、2D 動畫

### 通用繪圖（`drawing`）

用 SVG 畫示意圖、流程圖、圖表。

- 可用平台：網頁版、桌面版
- 子代理人領域：`drawing`
- AI 工具：`render_drawing`
- 範例：
  - `畫一張 TCP 三向交握的示意圖`

### UML／流程圖（Mermaid）（`uml`）

用 Mermaid 語法畫 UML、流程圖、序列圖，圖可以拖曳縮放並匯出 SVG／PNG。

- 可用平台：網頁版、桌面版
- AI 工具：`render_uml_diagram`
- 範例：
  - `畫一張登入流程的序列圖`

### 3D 場景（`scene-3d`）

用 YAML 描述 3D 場景，在對話裡用滑鼠旋轉縮放；也能匯入 3D 場景檔。

- 可用平台：網頁版、桌面版
- 斜線指令：`/view-3d-attachment`
- 子代理人領域：`scene_3d`
- AI 工具：`render_3d_scene`、`get_3d_scene_topic`、`get_3d_scene_yaml`、`import_3d_model_attachment`
- 範例：
  - `做一個會旋轉的太陽系 3D 場景`

### 互動元件（`interactive-viewer`）

產生多頁表單、引導頁、教學畫面等可互動的介面，可保存狀態並匯出封裝檔。

- 可用平台：網頁版、桌面版
- 斜線指令：`/import-viewer-attachment`
- 子代理人領域：`interactive_component`
- AI 工具：`render_interactive_viewer`、`get_interactive_viewer_yaml`、`get_viewer_state`、`set_viewer_state`、`import_interactive_viewer_attachment`
- 範例：
  - `做一個三步驟的新手引導精靈`

### 2D 動畫（`animation-2d`）

用多邊形描述 2D 動畫並播放，也能匯入動畫檔。

- 可用平台：網頁版、桌面版
- 斜線指令：`/import-2d-animation-attachment`
- 子代理人領域：`animation_2d`
- AI 工具：`render_2d_animation`、`get_2d_animation_yaml`、`import_2d_animation_attachment`
- 範例：
  - `做一個彈跳的球的 2D 動畫`

## 影音處理

逐字稿、抽音、字幕、剪輯、GIF、語音合成、配音（都在瀏覽器端處理，不上傳）

### 影音轉逐字稿（`media-transcribe`）

用瀏覽器端 Whisper 把影片或音檔轉成逐字稿，預設中文。

- 可用平台：網頁版、桌面版
- 斜線指令：`/media-transcribe`
- 子代理人領域：`media_av`
- AI 工具：`transcribe_media`
- 範例：
  - `/media-transcribe`
  - `/media-transcribe en`

### 抽出影片聲音（`media-extract-audio`）

把影片音軌存成 MP3（可在設定改 WAV）。

- 可用平台：網頁版、桌面版
- 斜線指令：`/media-extract-audio`
- AI 工具：`extract_audio`
- 範例：
  - `/media-extract-audio`

### 燒字幕（`media-burn-subtitles`）

把字幕燒進影片輸出新的 MP4；沒有字幕檔時自動先轉逐字稿。

- 可用平台：網頁版、桌面版
- 斜線指令：`/media-burn-subtitles`
- AI 工具：`burn_subtitles`
- 範例：
  - `/media-burn-subtitles`

### 擷取片段（`media-clip`）

擷取影片指定時間範圍（含畫面聲音，或只要聲音），不重新編碼。

- 可用平台：網頁版、桌面版
- 斜線指令：`/media-extract-clip-range`、`/media-extract-clip-range-audio`
- AI 工具：`extract_clip_range`、`extract_clip_range_audio`
- 範例：
  - `/media-extract-clip-range 1:20-1:45`

### 擷取影片指定時間的畫面（`media-frames`）

取影片幾個時間點的畫面存成圖片；搭配圖片比較，可以用投影片圖片找出對應的影片時間再剪出來。

- 可用平台：網頁版、桌面版
- AI 工具：`extract_video_frames`、`compare_images`、`extract_clip_range`
- 範例：
  - `每 30 秒取一張這支影片的畫面`
  - `拿投影片第 3 頁的圖，找出它出現在影片的哪個時間，並把那一段剪出來`

### 影片轉動態 GIF（`media-gif`）

把影片或其中一段轉成動態 GIF，可指定每秒幀數。

- 可用平台：網頁版、桌面版
- 斜線指令：`/media-to-animated-gif`
- AI 工具：`convert_to_animated_gif`
- 範例：
  - `/media-to-animated-gif 0:05-0:10 8`

### 影片轉 2D 動畫（`media-to-animation`）

逐格擷取影片畫面，轉成本 app 的 2D 動畫 YAML。

- 可用平台：網頁版、桌面版
- 斜線指令：`/media-to-animation`
- AI 工具：`convert_video_to_animation`
- 範例：
  - `/media-to-animation 0:00-0:03 fps=5 loop`

### 文字轉語音／合併音檔（`tts`）

英文用本地 Kokoro，中文粵語日文韓文用可選的 API 轉接；可列出全部語音代號；也能把多個音檔依序合併成一個。

- 可用平台：網頁版、桌面版
- 斜線指令：`/media-text-to-speech`、`/media-list-voices`、`/media-concat-audio`
- AI 工具：`text_to_speech`、`concat_audio`
- 範例：
  - `/media-text-to-speech 歡迎使用 AI 助理`
  - `/media-list-voices`
  - `/media-concat-audio file_1 file_2`

### 配音小幫手（`dubbing`）

針對影片某個時間段逐句錄音或上傳音檔配音，再合成新影片。

- 可用平台：網頁版、桌面版
- 斜線指令：`/media-dub-video`
- 子代理人領域：`video_editing`
- AI 工具：`start_dubbing_session`、`compose_video`
- 範例：
  - `/media-dub-video 1:20-1:45`

### 離線圖像轉文字（Florence-2、SmolVLM、PaliGemma…）（`image-to-text`）

用跑在這台電腦上的小型視覺模型（瀏覽器內的 WebGPU 或 WebAssembly CPU，推論在背景執行緒、不卡畫面）描述圖片、辨識圖上的文字（OCR）、列出物件、回答關於圖片的問題；不需要線上視覺模型，圖片不會上傳。第一次使用才下載模型（會先問大小），Configure 的「離線模型管理」可以選偏好 GPU 或 CPU（沒有 WebGPU 一律降級 CPU）、設定 CPU 核心上限、看使用空間與清除。線上視覺模型失敗時，若離線模型已下載會自動備援。輸出主要是英文。

- 可用平台：網頁版、桌面版
- 斜線指令：`/image-to-text`
- AI 工具：`image_to_text`
- 範例：
  - `解析這張圖`
  - `辨識這張圖片裡的文字`
  - `/image-to-text 文字`
  - `描述這張圖片裡有什麼`

### 圖片分解與向量重繪（2.5D）（`image-decompose-redraw`）

把一張圖分解成三角網格與區域、猜前後景深、用距離變換充氣成 2.5D 幾何體、重新取樣貼回原圖顏色，輸出 SVG、網格 JSON、OBJ＋貼圖。預設純幾何（不需要視覺模型），並用知識庫的部位知識（臉、五官、頭髮、動物臉）偵測並加上凸凹深度，補知識就會認得更多（顏色族群、容器）；離線也能用；vision:auto 時用助理已設定、支援讀圖的 Model 決定前後順序，沒有就退回純幾何。內建技能（skill_builtin-skill-image-decompose-redraw）。

- 可用平台：網頁版、桌面版
- 斜線指令：`/annotate`、`/rig-animate`
- AI 工具：`image_decompose_redraw`、`image_parts_teach`、`image_parts_annotate`、`image_rig_animate`
- 範例：
  - `把這張臉做成 2.5D`
  - `我要在圖上標註這個杯子，教你認得`
  - `我自己標，不要 AI 猜`
  - `讓這個 2.5D 模型動起來（點頭、揮手）`
  - `把這張圖做成 2.5D 視差網格`
  - `幫我把這張圖向量化重繪成 SVG，並猜出前後景深`

### 下載 YouTube 影片（`youtube-download`）

下載 YouTube 影片（瀏覽器端跑真正的 yt-dlp，含 JS 簽章解密橋接＋PO Token/BotGuard橋接）。Advance Settings 的 YouTube Data API 金鑰／頻道 ID 是選填的範圍限制（填了才會限制只能下載本人頻道或 CC 授權影片，留空可下載任何影片）。已知限制：Google 目前只給這個app信任度較低的「降級版」PO Token，多數影片仍然會下載失敗、只剩縮圖格式可用（已排除是瀏覽器環境被偵測為自動化的問題），這塊持續是進行中的逆向工程課題。

- 可用平台：網頁版、桌面版
- 斜線指令：`/media-youtube-download`、`/media-youtube-download-verbose`、`/media-youtube-selfcheck`
- AI 工具：`youtube_download`
- 範例：
  - `幫我下載這支 YouTube 影片並轉成逐字稿`
  - `/media-youtube-download https://www.youtube.com/watch?v=xxxxxxxxxxx`
  - `/media-youtube-download-verbose https://www.youtube.com/watch?v=xxxxxxxxxxx`
  - `/media-youtube-selfcheck`

## 網路與瀏覽器

搜尋、抓網頁、控制你的 Chrome

### 網路搜尋（`browser-search`）

搜尋維基百科、StackOverflow、GitHub、Google 新聞、SourceForge、CodeProject、DeepWiki 等來源（需在設定啟用）。

- 可用平台：網頁版、桌面版
- 子代理人領域：`browser_search`
- AI 工具：`browser_search`
- 介面入口：設定 → 啟用網路搜尋
- 範例：
  - `搜尋 GitHub 上有哪些 sql.js 的範例`

### 抓取網頁內容（`fetch-web-page`）

抓取指定網址的文字內容給助理閱讀。

- 可用平台：網頁版、桌面版
- AI 工具：`fetch_web_page`
- 範例：
  - `讀一下這個網址，幫我摘要重點`

### 瀏覽器控制（`browser-control`）

控制你的 Chrome：分頁群組、分頁、捲動、截圖、滑鼠鍵盤（桌面版，需安裝擴充功能）。

- 可用平台：桌面版
- 子代理人領域：`browser_control`
- AI 工具：`browser_get_page_structure`、`browser_screenshot`
- 範例：
  - `用瀏覽器控制開啟 https://tw.news.yahoo.com/ ，說明今天的最新新聞`
  - `截取頁面上方 800x400 的範圍，並說明畫面內容`

## 研究分析

唯讀的程式碼與檔案分析

### 唯讀研究（`research-readonly`）

分析程式碼與檔案但不修改、不執行，適合先理解專案再動手。

- 可用平台：桌面版
- 子代理人領域：`research`
- 範例：
  - `幫我看目前工作目錄，說明專案結構與主要功能`
