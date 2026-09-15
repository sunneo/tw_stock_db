# CHANGES.md

`floating-assistant.js`（AI聊天widget，host-agnostic，tw_stock_db/piano-web共用）
的逐日異動摘要。詳細技術細節（涉及的函式/行號/實測數據）見同資料夾的
`DESIGN-INDEX.md`，這份文件只做濃縮版的「今天做了什麼、為什麼」，方便快速掃過
歷史脈絡，不用整份翻`DESIGN-INDEX.md`。新的一天永遠加在最上面。

## 2026-09-15

背景：使用者要求Advance Settings新增「檔案存取管理」，可以新增多個要授權給
AI讀寫的真實磁碟資料夾（File System Access API）、權限要永久化；AI與斜線
指令要能區分「persistentStorage的file_id/檔名」跟「使用者授權的File Access
Point」；檔案讀寫API要支援列檔案/寫檔案/讀檔案/找檔案。

1. **`FileAccessPointStore`（新IndexedDB store）**：存`{id, label, handle}`，
   `handle`是`FileSystemDirectoryHandle`物件本身（Chromium瀏覽器IndexedDB
   用structured clone直接支援存這種handle）——這是「permission永久化」的
   關鍵：重新整理頁面後從IndexedDB讀回同一個handle，用
   `handle.queryPermission()`（唯讀查詢、不需要使用者手勢）檢查授權是否
   還在；真的失效時（瀏覽器長時間沒用/清過網站資料），提供「重新授權」
   按鈕讓使用者親自點擊觸發`handle.requestPermission()`——這一步依規範
   一定要「transient activation」，AI工具呼叫這種經過LLM往返的非同步鏈
   沒辦法滿足，設計上就是只能由使用者在UI上按。跟`fileCache`/
   `searchCache`一樣依mount實例分開資料庫。
2. **統一的`fap:`前綴定址格式，這是AI/斜線指令「自己區分」兩套系統的
   唯一依據**：`fap:<FAP的id或名稱>[/<相對路徑>]`（例如`fap:我的筆記`＝
   根目錄、`fap:我的筆記/2026/todo.txt`＝一個檔案）。`_looksLikeFapRef`/
   `_parseFapRef`是唯一的判斷入口；`_resolveUploadedFileRecord`（既有
   persistentStorage解析函式，`/media-*`等指令都在用）開頭新增一行
   guard，遇到`fap:`格式直接回傳null（不浪費時間在fileCache裡瞎找一個
   註定不會命中的字串），現有指令對FAP路徑會照原有邏輯回報「找不到
   已上傳檔案」，語意正確（這些既有指令本來就不支援FAP，要用新的
   `fap_*`工具/`/fap-*`指令）。
3. **5個新AI工具**（`registerOptional`＋新增`file_access_points`
   domain）：`list_file_access_points`（列出已授權清單含即時查詢的
   permission狀態）、`fap_list_files`（列檔案）、`fap_read_file`（讀純
   文字檔案，8000字元截斷同`parse_uploaded_file`慣例，二進位格式直接
   拒絕並導向既有的📎上傳附件管道）、`fap_write_file`（寫入，整份覆蓋、
   自動建立不存在的中途資料夾）、`fap_find_file`（遞迴搜尋檔名，安全
   上限：最多掃5000項/找200筆結果/往下8層，超過標記truncated）。路徑
   解析自己擋掉`.`/`..`片段（防禦深度，即使API本身理論上不會真的讓你
   逃出授權目錄）。
4. **3個新斜線指令**（本地直接執行、不經過LLM）：`/fap-list`
   `/fap-read` `/fap-find`。刻意不做`/fap-write`——在聊天輸入框打整份
   要寫入的內容不是好UX，寫入留給AI工具（可以先跟使用者確認內容再動手）。
5. **Advance Settings新分頁「檔案存取管理」**：清單（`_renderFapList`）
   顯示每個FAP的授權狀態/ref/新增時間，「+新增資料夾」呼叫
   `showDirectoryPicker({mode:'readwrite'})`（feature-detect僅Chrome/Edge，
   比照既有Skill資料夾匯入的disable+title提示模式）後存進store；每筆有
   「重新授權」（僅在權限失效時顯示）/「重新命名」（擋重複名稱）/
   「移除」（`confirm()`二次確認，說明不會刪除實際檔案）。
6. 實測（Browser工具，因為原生資料夾選擇對話框無法被自動化操作，改用
   手刻的mock `FileSystemDirectoryHandle`——實作`getDirectoryHandle`/
   `getFileHandle`/`entries()`/`queryPermission`/`requestPermission`
   這幾個介面方法、backing一個記憶體內的樹狀結構，繞過IndexedDB存不了
   純JS物件方法的限制直接注入到store）：UI正確渲染授權清單/空狀態；
   `fap_list_files`列根目錄與子目錄都正確；`fap_read_file`正確讀取純
   文字、正確拒絕二進位（.png）、正確處理檔案不存在；`fap_write_file`
   正確寫入既有檔案、正確自動建立多層不存在的中途資料夾；`fap_find_file`
   遞迴搜尋正確找到兩層深度的同名檔案；路徑穿越防禦正確擋下`..`跟`.`
   片段；3個斜線指令都正確推送格式化訊息；permission變成非granted時
   UI正確顯示「重新授權」按鈕、工具呼叫正確回報明確的重新授權指示；
   重新命名（擋重複名稱）/刪除（confirm）UI互動都正確觸發底層store方法。
7. **File Access Point ⇄ persistentStorage 二進位檔案橋接**（使用者回報
   缺口：`fap_read_file`/`fap_write_file`只支援純文字，沒辦法把AI產生
   的MP3等任何格式的二進位檔案搬進File Access Point）：新增
   `fap_copy_from_storage`（persistentStorage→FAP，直接複製`record.blob`
   保留二進位完整性，可選`move:true`變成真正移動；ref留空/以`/`結尾
   自動沿用來源檔名）、`fap_copy_to_storage`（反方向，`fileCache.put`
   讓fap_read_file讀不了的格式改用既有`parse_uploaded_file`等工具處理）、
   `fap_download_url`（直接瀏覽器`fetch()`網址內容寫進FAP，不繞道
   persistentStorage，受目標站CORS限制）。三者都經過真實檔案round-trip
   實測（byte-for-byte比對），不是只測純文字。
8. **`git_operations`——瀏覽器端git clone/pull/status/log/commit/push**
   （使用者要求「幫我做成一個subagent，裡面專用來git操作」，並在
   corsProxy策略/私有repo支援/write能力三個問題上明確選定：只用自己
   部署的Cloudflare Worker，不用第三方proxy；公開私有repo都要支援，
   私有repo的token由使用者自己在Advance Settings填入；要支援commit/push
   不只是唯讀clone）：
   - 新增`FapGitFs` class（把一個`FileSystemDirectoryHandle`包成
     isomorphic-git要求的`fs.promises`介面，含`readlink`/`symlink`
     stub——isomorphic-git執行期`bindFs()`無條件對這兩個也呼叫`.bind()`，
     即使TypeScript型別把它們標成選填，缺了會在建構期就丟
     `Cannot read properties of undefined (reading 'bind')`，這是讀
     isomorphic-git原始碼才找到的細節，不是文件寫的）。
   - `FA_ASSET_URLS`新增`bufferPolyfill`（真ESM，動態`import()`載入，
     不能走`_faLoadScriptOnce`那套UMD注入）、`isomorphicGit`（UMD，
     `window.git`）、`isomorphicGitHttp`（UMD，`window.GitHttp`）——
     版本`1.42.2`經真實clone/log/status/add/commit流程實測驗證過，
     不是猜的。
   - 6個新AI工具（`git_clone`/`git_pull`/`git_status`/`git_log`/
     `git_commit`/`git_push`）+ 新`git_operations` domain，操作對象
     只有File Access Point資料夾（persistentStorage是單一blob儲存，
     沒有「資料夾」概念，不支援）。corsProxy留空時退回目前AI端點
     apiUrl（跟`browserSearchProxyUrl`同一套慣例），需要對應Worker
     部署`/git-proxy`路由（見`tw_stock_db_code`私有repo的
     `code/cloudflare-worker/worker.js`的`handleGitProxy`，本次一併
     新增並push）。commit/push需要使用者先在Advance Settings「檔案
     存取管理」分頁填入git作者名稱/信箱、以及有寫入權限的GitHub
     Personal Access Token（私有repo/push都需要，公開repo唯讀clone/
     pull不需要）。
   - 實測：mock `FileSystemDirectoryHandle`+mock `window.git`/
     `window.GitHttp`（isomorphic-git本身不在這個環境重跑一次真實
     clone，那部分依賴先前開發驗證過的手動測試），確認6個方法正確
     組出`dir`/`corsProxy`/`onAuth`參數、`_gitCommit`正確依
     `statusMatrix`逐檔`add`/`remove`後才`commit`、`_resolveGitCorsProxyUrl`
     正確組出`.../git-proxy`。
9. **實機驗證（使用者真的部署Worker後、用真實瀏覽器+真實GitHub repo跑一輪）
   抓到並修好2個mock測試沒測出來的真bug，另外加了一個使用者當場回報的
   UX改善**：
   - **`worker.js`的`/git-proxy`**：一開始收到真實clone一路400——追出
     isomorphic-git核心（`index.umd.min.js`的`Pr`函式）對「不是以`?`結尾」
     的corsProxy，會在接上URL前**先把`https://`砍掉**（`corsProxy+'/'+
     url.replace(/^https?:\/\//,'')`），worker原本寫死「一定要有
     https://開頭」直接把這種正常請求擋掉。改成沒有scheme就自動補
     `https://`，有scheme也照樣接受，兩種呼叫端慣例都相容。已重新commit
     push到`tw_stock_db_code`（commit `a1fa161`），使用者需要重新部署
     （已完成）。
   - **`FapGitFs._unlink`/`_rmdir`**：修好worker後clone還是失敗在
     `git.fetch()`內部——用monkey-patch包住`fs.promises`每個方法記錄呼叫
     順序才抓到：isomorphic-git會嘗試`unlink('.git/shallow')`當清理步驟
     （檔案通常本來就不存在），靠`err.code==='ENOENT'`判斷「本來就沒有、
     不是真錯誤」安靜略過；但File System Access API的`removeEntry()`對
     不存在的項目丟的是原生`DOMException`（`name:'NotFoundError'`，
     legacy`.code`是數字8，不是字串'ENOENT'），isomorphic-git認不得，
     把它當真正失敗直接中止整個clone/fetch。兩個方法補上跟
     `_readFile`/`_stat`/`_readdir`一樣的`_enoent()`轉換。修完後
     `git_clone`/`git_status`/`git_log`/`git_commit`/`git_pull`對真實
     `octocat/Hello-World`repo全部跑通（`git_push`測了「沒填token時正確
     擋下」，沒有實際推真的repo）。
   - **UX改善（使用者當場反饋「configure這個路徑太遠」）**：`_checkFapPermission`
     原本permission不是granted時直接丟錯誤、要求使用者先跳去Advance
     Settings按「重新授權」。改成**當場跳一個輕量Modal**（新增
     `_showFapPermissionDialog`，跟既有`_showMp4ExportOptionsDialog`
     同一種Promise-based寫法）讓使用者原地點擊授權——`requestPermission()`
     要求的「剛剛發生的真人點擊」在這裡自然滿足，工具呼叫會停在原地
     等使用者回應，不用先跳頁面。同一個FAP同時有多個並發呼叫在等權限
     時，共用同一個dialog（用`_fapPermissionDialogPromises` Map依
     `${rec.id}:${mode}`去重，不會疊出好幾個一樣的視窗）。Advance
     Settings裡原本的「重新授權」按鈕保留，給想主動先授權好的使用者用，
     不是被取代。**已知限制**：這只是把「使用者要點的地方」搬近，
     `requestPermission()`授權本身能維持多久（多久算「太久沒用」而被
     重置）是Chrome自己的heuristic，這份改動沒有辦法、也沒有嘗試去
     延長瀏覽器實際的授權持續時間。
10. **斜線指令選單支援鍵盤上下鍵選取＋Enter套用**（使用者要求）：
    `_wireSlashCommandMenu`新增`selectedIndex`狀態，選單重繪（指令名稱
    匹配、或參數argChoices候選清單）時預設選第一項並反白（用
    `palette.detailBg`當反白底色，跟theme一致）；掛出
    `this._slashMenuMoveSelection(delta)`（上下移動，夾在頭尾不會繞回）／
    `this._slashMenuConfirmSelection()`（套用目前選到的，跟滑鼠點擊
    共用同一份`applyItem`邏輯，只把值填進輸入框、不自動送出，讓使用者
    確認/補打剩下的參數後自己再按一次Enter才是真的送出）給
    `_initEventListeners()`裡既有那個統一處理Tab/ArrowUp/ArrowDown/Enter
    的keydown監聽器呼叫——三個按鍵在選單開著時最前面就攔截掉、不落到
    原本「瀏覽指令歷史」/「送出訊息」的邏輯。另外確認了使用者提到的
    另外兩點其實既有邏輯已經正確：指令跟後面的說明文字本來就是用第一個
    空白分隔（`argsText = textToSend.slice(firstToken.length).trim()`）；
    `/`不在開頭就不算斜線指令（選單顯示`renderMenu`跟實際送出時的執行
    `_submitChatInput`都是`startsWith('/')`才算），這兩點沒有改動。
    Browser工具實測：`/`+部分字元時預設反白第一項、ArrowDown正確移動
    反白且到底會夾住不繞回、Enter正確把選到的項目填進輸入框並關閉選單
    （不會意外送出訊息）；參數候選清單（argChoices）同一套鍵盤操作也
    正確；`/`不在開頭（例如"hello /apple world"）確認選單不會跳出來。

## 2026-09-14（深夜再追加）

背景：使用者看了截圖回報「RAG知識庫還要多按一下管理條件圖譜太麻煩，應該
直接嵌入那頁面」；同一段對話中也要求把model row的temperature預設值從0
改成0.1。

1. **RAG知識庫分頁直接嵌入清單**：原本「RAG 知識庫」分頁只有一顆「管理
   條件圖譜」按鈕，點了才彈出獨立`ai-rag-modal`顯示搜尋列/操作列/表格。
   把那個modal的內容整段搬進`data-pane="rag"`本身，`_renderAdvancedSettings()`
   （Advance設定對話框每次開啟/重繪都會呼叫）新增一行`this._loadAndRenderRag()`，
   打開設定就直接看到清單，不用再多點一次。移除`ai-rag-modal`元素本身、
   `_openRagModal()`方法、以及3個會throw的按鈕事件綁定（`ai-rag-manage-btn`/
   `ai-rag-modal-close`/`ai-rag-modal-done`，元素已經不存在，若沒移除
   `.onclick=`賦值會直接噴錯讓整個widget初始化失敗）。單一節點的新增/編輯
   仍然維持獨立的`ai-rag-editor-modal`（沒有動，比照其他「清單inline、
   單項編輯用modal」的既有慣例，例如Skill清單）。`_closeRagModal()`保留
   成no-op（安全處理`document.getElementById`找不到元素的情況），避免要
   同步修改另外兩處既有的「點modal外側/按Escape關閉」判斷式——那兩處靠
   `ragModal`變數自然變成`null`、`_isModalOpen(null)===false`就自動變成
   無效分支，不用額外改動。
2. **model row的temperature預設值0→0.1**：新增`DEFAULT_CHAT_TEMPERATURE = 0.1`
   常數，取代`_loopFetch`/`_loopFetchNative`/`_runSubAgentTask`三處原本
   寫死的`temperature: 0`退回值（row自己有填temperature時仍然優先用row的
   值，這裡只改「row留空時的退回值」）。理由：既有comment本來就記錄過
   「temperature=0的貪婪解碼在某些模型上容易卡進『同一段輸出不斷重複』的
   退化狀態」，0.1幾乎一樣接近deterministic、不影響工具呼叫協定穩定性，
   但能進一步降低這個已知風險，`_hasRepeatingTail`偵測仍然保留當最後一道
   防線。UI上model row的temperature欄位placeholder同步從「預設0」改成
   「預設0.1」。
3. 實測（Browser工具）：RAG分頁確認清單直接顯示（`共0筆記錄`空狀態正確、
   無需額外點擊）、「新增節點」仍正確開啟獨立編輯modal、搜尋/全選按鈕
   無報錯；mock `fetch`跑一次真實`executeChat`，確認實際送出的`_loopFetch`
   請求`temperature`正確是`0.1`（另一次捕捉到的`temperature:0`請求經確認
   是既有、不受這次改動影響的原生tool_calls支援探測請求，不是聊天本身）。

## 2026-09-14（深夜）

背景：使用者要求把「模型」設定從單一組API KEY/URL/MODEL NAME＋MODEL NAME
留空時依內建清單自動fallback，改成好幾個column可以填的多筆管理方式（一個
row代表一個model/llm，各自可以有自己的URL/KEY/temperature/penalty/token
上限），可拖曳調整順序、可新增/刪除；並要求名稱以「openrouter/」開頭的
model改經Cloudflare Worker轉去OpenRouter，API key用worker端的
OPENROUTER_API_KEY／OPENROUTER_API_KEY_DEFAULT。

1. **`advancedSettings.llmModelRows`取代單一組API KEY/URL/MODEL NAME**：
   每筆row `{id, apiUrl, apiKey, modelName, temperature, frequency_penalty,
   presence_penalty, repetition_penalty, length_penalty, maxOutputTokens}`，
   除了modelName（必填），其餘留空(null)＝沿用全域預設（URL/Key沿用舊有的
   localStorage全域fallback值，溫度/penalty/max_tokens沿用「LLM Model
   管理」分頁下方的全域取樣設定）。內建預設清單＝原本的8個PRESET_MODEL_
   OPTIONS＋新增的`openrouter/free`，一次性migration邏輯把既有使用者原本
   存在localStorage的單一組API KEY/URL/MODEL NAME（如果有填過）搬進第一筆
   row，升級後原本的設定不會憑空消失。
2. **Fallback機制改成「一個row代表一個model/llm」**：row的排列順序（可
   拖曳調整）本身就是fallback優先順序，不再需要判斷「MODEL NAME是否留空」
   才啟動——同一輪對話一律先試第一筆，遇到該模型404才依序往下換，換row時
   URL/Key/生成參數整組一起換（不是像舊版只換模型名稱、URL/Key固定）。
   `_loopFetch`/`_loopFetchNative`新增第5個參數`genOverrides`
   （temperature/samplingOverrides/maxOutputTokens），跟既有的apiModel/
   retryAttempt一樣逐層往下傳；`_runSubAgentTask`（子agent委派用，可能
   透過`runBatchSubAgents`並行執行多份）改用function-scope區域變數追蹤
   目前用第幾筆row，不共用instance層級狀態，避免並行執行互相污染。
3. **`openrouter/`開頭的model改經Worker轉接**：`_resolveModelRowConfig`
   偵測到modelName以`openrouter/`開頭時，把resolve出來的base URL加上
   `/openrouter`路徑片段（不是直接從瀏覽器打openrouter.ai）。Worker新增
   `handleOpenRouterProxy`（`tw_stock_db_code私有repo的code/cloudflare-worker/worker.js`），跟既有
   `handleNvidiaProxy`同一套「假金鑰`tw_stock_db_api:{sessionId}`→用
   env.OPENROUTER_API_KEY（含流量控管）；真金鑰原樣轉發；空白→依序
   fallback OPENROUTER_API_KEY_DEFAULT→OPENROUTER_API_KEY」的邏輯，轉發到
   `https://openrouter.ai/api/v1/chat/completions`。
4. **Advance Settings UI**：「LLM 生成取樣參數」分頁改名「LLM Model
   管理」，內容換成可拖曳排序的model row清單（⠿拖曳把手、#編號、刪除
   按鈕、9個欄位的grid）＋「+新增Model」按鈕，下方保留「全域預設」取樣
   參數區塊（row留空的欄位會套用這裡，跟改動前的既有機制相同，只是多了
   per-row覆寫層）。「LLM 基礎設定」分頁移除原本的API KEY/URL/MODEL
   NAME三個欄位。事件綁定改用事件代理（url/key/數字欄位用`input`即時
   存檔但不重繪；modelName刻意改用`change`才存檔+重繪，避免使用者刪光
   模型名稱準備重打時，半路空白的瞬間被normalize邏輯判定成不合法整筆
   row憑空消失）。
5. **修正兩處`Number(null)`陷阱**：`_normalizeModelRow`跟
   `_resolveModelRowConfig`一開始都直接對`row[key]`做`Number(...)`轉換，
   但`Number(null)===0`（不是`NaN`！）——這代表所有「留空(null)代表不
   覆寫」的欄位都會被誤判成「明確填了0」，整批預設row的溫度/penalty/
   max_tokens全部變成0而不是真正留空、沿用全域預設。瀏覽器實測時才發現
   （`_resolveModelRowConfig`回傳的`temperature`等本來該是`null`的欄位
   全部顯示成`0`），改成先判斷`raw == null || raw === ''`才決定要不要
   呼叫`Number()`，修正後重測全部正確回傳`null`。
6. **另一個實測抓到的真實bug**：`_normalizeAdvancedSettings(raw)`當
   `raw`完全不存在（`localStorage.getItem(ADVANCED_SETTINGS_KEY)`是
   null，代表使用者從沒動過Advance Settings任何其他欄位——但舊版單一組
   API KEY/URL/MODEL NAME是直接寫進localStorage、不經過這個normalize
   流程存檔的，完全可能兩者都存在）原本會提早return
   `_createDefaultAdvancedSettings()`，完全跳過migration邏輯，導致這類
   使用者升級後原本設定的模型/URL/金鑰會憑空消失、只剩空白的內建預設
   清單。修正：這個提早return分支也要呼叫`_normalizeModelRows(null)`
   套用migration。
7. 實測（Browser工具，`new FloatingAssistant({})`+mock `fetch`）：UI
   渲染9個預設row（含openrouter/free）；`_resolveModelRowConfig`對一般
   row/openrouter row都正確解析出URL/Key/溫度覆寫（openrouter row的URL
   正確多了`/openrouter`後綴）；編輯欄位、新增row、刪除row（含「至少
   保留一筆」防呆）、原生HTML5拖曳排序（用`DataTransfer`+`DragEvent`
   模擬）全部正確更新`advancedSettings.llmModelRows`；**端到端fallback
   測試**（mock `fetch`讓第一筆row回404、第二筆成功）：確認
   `executeChat`／`_runSubAgentTask`都正確從row-a換到row-b，連
   URL／API Key／temperature／max_tokens都跟著整組換成row-b自己的值
   （不是只換模型名稱）；舊使用者migration（模擬localStorage裡有舊版
   單一組API KEY/URL/MODEL NAME但沒有advancedSettings blob）確認正確
   把原本的設定migrate成第一筆row。

## 2026-09-14（晚上）

背景：使用者對Advance Settings面板提出一批UI/預設值調整意見：上下文視窗預設
8192偏少（現在內建模型基礎都有128K）；「子Agent」分頁塞太多不相干內容太
rough；3D模型匯入三角形數量上限想改100000；「自訂函式」分頁少一個範例按鈕；
「AI自製函式」分頁應該併入「自訂函式」；「一般」分頁的RULES.md應該併入「LLM
基礎設定」。

1. **模型上下文視窗預設值8192→128000**：`_createDefaultGenerationSettings`。
   順便把面板上這個欄位的說明文字改正確——它其實只是參考顯示用，實際壓縮
   時機是靠伺服器400/413回應觸發，不是靠這個數字主動估算（既有code comment
   早就講過這點，欄位label文字卻沒跟著更新，一併修正）。
2. **匯入3D模型三角形數量上限預設10000→100000**：
   `SCENE3D_DEFAULT_MAX_IMPORTED_MESH_TRIANGLES`，同步更新`import_3d_model`
   工具description裡提到的預設值文字。
3. **Advance Settings分頁重整**：
   - 移除「一般」分頁，RULES.md欄位併入「LLM 基礎設定」分頁（排在API KEY/
     URL/MODEL NAME跟兩個checkbox之後）。
   - 移除「AI自製函式」分頁，內容（標題+「管理AI自製函式」按鈕）併入
     「自訂函式」分頁，排在原本的Customize Functions編輯器下方。
   - 「自訂函式」分頁的Customize Functions編輯器新增「範例」按鈕，點擊插入
     一段示範JS函式（`formatCurrency`/`clamp`/`daysBetween`）；範例內容如實
     說明這個欄位目前只是使用者自己的共用函式草稿，不會被自動注入到Skill/
     AI自製函式的實際執行環境（讀`_executeCustomTool`/`_createAiFnCallable`
     確認：只有各自的handlerScript/code會被組進執行用的`new Function`，
     `customFunctions`本身只會被驗證一次，這個既有的no-op驗證/未接線狀態
     這次沒有動，只是誠實反映在範例文案裡，不擴大這次變更範圍）。
   - 「子Agent」分頁拆成三個：「子Agent」只留多重子Agent模式選擇＋
     browser_search設定；新增「多媒體」分頁放影音處理子Agent設定（Whisper
     裝置/執行緒數、擷取聲音格式、燒錄字幕外觀）；新增「語音設定」分頁放
     兩塊語音合成子Agent設定（本地Kokoro英文語音＋API中文語音，含上一批
     剛做的試聽按鈕/語速滑桿）。分頁切換邏輯本來就是通用的
     `data-cat`/`data-pane`比對（沒有任何地方寫死分頁名稱字串），純粹是
     HTML區塊搬動+cat清單調整，不需要改任何JS邏輯。
   實測（Browser工具，`toggleWindow(true)`+`_openAdvancedModal()`）：確認
   分頁清單正確（11個分頁，無「一般」/「AI自製函式」，新增「多媒體」/
   「語音設定」）；LLM基礎設定分頁底部正確顯示RULES.md；自訂函式分頁正確
   顯示合併後的兩塊內容＋範例按鈕（點擊後textarea值與`advancedSettings
   .customFunctions`都正確寫入範例內容）；多媒體/語音設定/子Agent三個新
   分頁各自顯示正確的子集內容；`_getGenerationSettings().contextWindowTokens`
   確認128000、`advancedSettings.maxImportedMeshTriangles`確認100000。

## 2026-09-14（下午）

背景：使用者回報AI直接呼叫media_av子agent時被告知「沒有工具可以合併多個音檔」
（實際貼了8個file_id的真實工具回應），另外對語音合成子Agent的設定UI提出三點
意見：語音包安裝下拉選單多餘、想要試聽按鈕、想要調整語速；同一則訊息也要求
中文語音API預設enable。

1. **新增`concat_audio`工具**：`_concatAudioFiles`用`OfflineAudioContext`把多個
   已上傳音檔依指定順序解碼、依序排程（`src.start(cursor)`、`cursor+=duration`）
   混流成一軌後用既有`_encodeMp3`編碼，純瀏覽器端、不上傳。註冊進`media_av`
   domain（`toolNames`加入、`systemPrompt`補一句明講不要回報做不到）。
2. **`text_to_speech`新增`speed`參數（0.5~2.0）**：實測確認kokoro-js的
   `engine.generate()`本來就支援`speed`參數（直接讀minified原始碼確認），Edge
   TTS API這邊的Cloudflare Worker `/edge-tts`路由也早就支援`rate`欄位（讀
   `worker.js`確認，不用改worker）——這次只需要把`speed`從`_synthesizeSpeech`
   一路穿到本地Kokoro（含Worker版）跟API路徑（換算成`rate`百分比字串）兩條
   pipeline。新增`advancedSettings.ttsDefaultSpeed`（預設1.0）當使用者沒指定
   speed時的後備值。
3. **`ttsApiEnabled`預設改成`true`**：`_createDefaultAdvancedSettings`與設定
   normalize邏輯都改成「未設定＝啟用，只有明確存過`false`才維持關閉」，呼應
   使用者「中文語音API幫我預設enable」的要求。
4. **語音合成設定UI簡化＋新增試聽/語速**：移除「語音包管理」的安裝下拉選單＋
   安裝按鈕（改成選好預設語音、第一次試聽/合成時自動下載，跟原本的自動下載
   邏輯本來就一致，只是拿掉多餘的手動安裝步驟），本地/API語音的預設語音選單
   旁都加一個「🔊 試聽」按鈕（`_previewTtsVoice`依語言挑一句簡短示範文字，
   用目前語速合成後掛進既有的`_mountAudioPlayer`播放器），新增一個共用的語速
   滑桿（0.5~2.0x）同時控制試聽跟`text_to_speech`預設語速。瀏覽器實測：本地
   Kokoro試聽端到端跑通（真實模型合成、掛出播放器）；語速滑桿調到2.0x時實測
   輸出音檔長度從2.78s變成1.61s（非線性但方向正確，跟先前session量到的
   speed:1.5→1.61倍縮短一致）；API試聽在沒有真實Worker端點時正確顯示錯誤訊息、
   不crash。

## 2026-09-14（上午）

背景：使用者要求`/media-text-to-speech`（以及mp3/wav/ogg類音檔）除了下載連結
還要有真正的播放器；後續實測時發現並回報了兩個相關問題，一併修正。

1. **音檔/影片內建播放器**：新增`_mountMediaPlayer`（這個專案第一個
   `<audio>`/`<video>`元素）——play/pause、可拖曳進度條、回到開頭/跳到結尾、
   目前秒數/總秒數顯示，樣式跟widget既有palette一致。`_downloadFile`交付卡片
   （`_deliverExistingCacheFile`產生的下載訊息）現在音檔自動掛`_mountAudioPlayer`
   （隱藏引擎+全自訂UI）、影片自動掛`_mountVideoPlayer`（可見畫面，
   max-width 360px），兩者共用同一套控制邏輯。
2. **AI直接呼叫媒體工具時檔案沒有交付到對話裡（使用者實測發現的真實bug）**：
   `text_to_speech`/`transcribe_media`/`extract_audio`/`burn_subtitles`/
   `compose_video`這5個工具的callback本身（AI在一般對話或透過`media_av`
   domain委派時走的路徑）從來沒有呼叫過`_deliverExistingCacheFile`——只有
   對應的5個`/media-*`斜線指令會交付檔案，AI自己呼叫工具時使用者完全看不到
   下載連結/播放器，只看得到LLM用文字描述的file_id。新增
   `_deliverToolResultFile`共用helper，5個工具現在都會自動交付檔案，不影響
   斜線指令本身（走不同的程式碼路徑，不會重複交付）。
3. **`/media-text-to-speech`會卡住UI一陣子**：找到並修正`_faLamejsEncode`
   （純JS MP3編碼器）完全同步、沒有任何yield的問題，改成每16個chunk
   `await`一次讓出主執行緒（第一版門檻設200，實測10秒音訊完全沒生效，
   修正為16才真的有效）。⚠️已知限制：這只解決編碼階段的卡頓，本地Kokoro
   TTS模型推論本身（WASM、CPU同步執行）仍可能造成短暫卡頓，徹底解決需要
   把Kokoro搬進Web Worker，這次沒有做。
4. **AI用SSML控制發音，被Kokoro逐字唸出XML標記本身（使用者實測抓到、
   自己聽出來的真實bug）**：使用者要「m m moon」裡的m發「嗯」音，AI試著用
   `<speak><phoneme alphabet="ipa" ph="...">`這類SSML語法控制發音，但這條
   TTS pipeline完全不支援SSML，把整段XML標記原封不動餵給Kokoro，結果被
   逐字唸成「Speak version equals one point o XML and S equals HTTP...」
   長達24秒——這也是問題3那次UI嚴重卡到Chrome跳出「網頁無回應」對話框的
   直接原因（文字被SSML標記撐長很多倍，推論時間跟著大幅拉長）。修正：
   `_synthesizeSpeech`在送進任何引擎之前，先用正規表示式偵測XML/HTML標記
   （`<phoneme ...>`、`<speak ...>`等），偵測到就直接拒絕並回傳明確錯誤
   （不接受SSML、要求改用純文字/同音近似拼法），不會再讓引擎默默把垃圾
   標記唸出一大段音檔；`text_to_speech`工具的description也同步補充明講
   不支援SSML。
5. **Kokoro TTS搬進Web Worker，真正解決卡頓根因（不再只是已知限制）**：
   模型推論`engine.generate()`（WASM、CPU、完全同步）原本佔用主執行緒，
   這次搬進持久化的module worker（`FA_TTS_WORKER_SRC`），worker基礎設施
   有問題時自動退回main thread（完整保留原本邏輯當fallback）。實測：真實
   模型透過worker完整合成一次，main thread在~23.7秒合成期間完全沒被卡住
   （interval tick正常持續觸發，對照問題3修lamejs前「完全卡住、0 tick」
   的量測方法）。
6. **同一輪內AI連續呼叫text_to_speech等工具，只保留最後一個結果**：延伸
   既有「同一輪內同類型視覺輸出只留最後一次」機制（`_markSupersededVisualDrafts`）
   到`_downloadFile`（音檔/影片/其他交付檔案），較早的版本自動收合成
   草稿卡（預設隱藏），不會每次都各自顯示一張完整卡片。
7. **AI回應中途重繪會打斷正在播放的音檔/影片、重設3D viewer視角**：
   `_renderMessageHistory()`每次都整個清空重繪所有訊息，音檔/影片播放器
   跟3D viewer完全沒有「這則訊息沒變、不用重新掛載」的判斷，每次工具呼叫
   觸發的重繪都會讓播放位置歸零、3D視角被重設回預設值。新增
   `this._liveWidgetCache`（WeakMap），這兩種「有live互動狀態」的widget
   類型改成重用已掛載的DOM節點，不重新建立——實測確認重繪前後是**同一個
   物件參照**，播放位置/3D視角真的被保留。

## 2026-09-13

背景：使用者計畫把floating-assistant.js整合進piano-web（鋼琴多音軌編輯器），並
預期piano-web未來會需要大量（上百種）音樂曲風的subagent。今天圍繞著「怎麼讓
subagent機制撐得住這種規模、同時不污染主對話」這個主軸做了兩項延伸。

1. **Skill(自訂工具)改走subagent domain委派，不再無條件掛根層級**
   （commit `c9740921`）
   - Advance Settings「Skill」分頁的自訂工具（`advancedSettings.customTools`）
     原本無條件曝光在根層級對話工具清單，Skill越加越多會稀釋根模型注意力/塞爆
     system prompt。改成新增一個`custom_skills`虛擬domain（`toolNames`即時讀
     `advancedSettings.customTools`），跟9/6~9/9做好的內建工具domain委派機制
     共用同一套路由/執行邏輯——`router`/`full`模式下Skill不再無條件曝光，只能
     透過`delegate_to_subagent`委派給子agent按需查詢/呼叫；`off`模式（沒有
     subagent機制）維持直接掛根層級不變。
   - 新增`_importSkillFolder`（File System Access API）：除了既有的`.skill`
     zip附件匯入，現在也能直接選一個本機資料夾（結構跟zip解開後一樣：
     `SKILL.md`+`tools/*.js`）匯入，不用先手動打包成zip。刻意不持久化授權、
     不自動重新掃描——每次都是使用者主動選一次資料夾的單次匯入動作。
   - 順便確認（沒有改code）：RAG知識圖譜（`rag_lookup`domain）在這套委派機制下
     依然可用——路由子agent本來就能一次選多個domain，任務需要「Skill+過去成功
     案例/關聯經驗」時，`custom_skills`跟`rag_lookup`會被合併進同一次委派，實測
     驗證過。

2. **兩層domain路由（類別→細分domain）+ subagent執行中動態追加工具**
   （commit `f0dced72`）
   - 新增`multiSubAgentMode`第4個值`'hierarchical'`：domain數大到像「上百種
     曲風」這種規模時，既有的扁平單層路由（一次列出全部domain目錄）會塞爆
     路由子agent的注意力。改成選配的兩層路由——先選「類別」，選中的類別再
     各自平行問一次「該用哪個細分domain」。用tw_stock_db共用金鑰模式對
     `nvidia/nemotron-3-super-120b-a12b`做過真實LLM benchmark：45個domain時
     兩層式省58%路由token、但延遲多6-7秒；精準度測試裡扁平模式在45個domain
     時真的漏判一題，兩層式全對——這組實測數據是把它做成「選配」而非取代
     既有模式的依據，domain少時不建議用。
   - 新增`register_domain_category`+`register_domain`的`category`選填參數，
     讓host頁面（piano-web之後可以自己註冊）能把domain分類。
   - 新增`request_additional_tools`偽工具：子agent執行到一半才發現需要一個
     原本沒拿到的domain工具時，可以在**同一次執行**裡原地申請追加（直接擴充
     這次執行的可用工具清單、下一輪立刻生效），不需要跳出去重新委派一次
     整個流程——避免使用者擔心的「查完GitHub才發現要查wiki」這類多階段任務
     卡在工具不夠用。有申請次數上限（3次）防止失控。
   - 路由prompt同步補一句引導：任務如果是多階段的，路由時要盡量把預期會用到
     的domain一次選齊，降低事後才發現不夠的機率（零額外LLM往返成本的prompt
     wording調整，不是加一輪驗證呼叫）。

3. **快速設定面板整併進Advance設定對話框 + 子Agent執行進度可視化**
   - 使用者回報：開啟「顯示工具呼叫追蹤與思考過程」後還是看不到委派出去的
     子agent在忙什麼——因為`_runSubAgentTask`從以前開始就完全靜默執行，過程
     故意不碰主對話的訊息陣列。新增`options.onProgress`回呼＋
     `_createSubagentProgressWidget`，只在「顯示工具呼叫追蹤與思考過程」開啟
     時才在對話裡顯示一張即時更新的進度卡片（判斷委派給哪個領域、每輪呼叫了
     哪個工具、有沒有申請追加工具），關閉時維持完全靜默、零回歸。
   - 同時把原本散落在⚙️快速設定面板的設定（API KEY/URL/MODEL NAME、生成/
     取樣參數、Hermes自我演化、slash選單、顯示追蹤）全部搬進Advance設定
     對話框，新增三個分頁放在最前面：「LLM 基礎設定」「LLM 生成取樣參數」
     「LLM Debug」。快速設定面板整個移除，⚙️改成直接開啟Advance對話框。

兩項今天都只做在`floating-assistant.js`這個共用引擎本身，piano-web實際要用
（幫每個曲風`register_domain`帶`category`、累積曲風knowledge等）是piano-web
之後自己要做的事，這次沒有處理piano-web的實際曲風資料/MIDI分類管線。
