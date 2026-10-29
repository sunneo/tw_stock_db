# 核心測試報告

產生時間：2026-10-29T16:49:22.184Z　（`node scripts/run-core-tests.js`）

結果：133 / 136 組通過，**3 組失敗**；總耗時 187 秒（只含這些純函式核心，不含 Electron／瀏覽器的真實環境測試）

| 結果 | 測試組 | 摘要 | 耗時 |
|---|---|---|---|
| 通過 | 知識引擎（類型、驗證、展開、知識包） | 66 passed, 0 failed [] | 1.0 秒 |
| 通過 | 標註核心（魔術棒、切格、猜字） | 22 passed, 0 failed [] | 0.3 秒 |
| 通過 | 蒙皮核心（骨架、權重、動作） | 17 passed, 0 failed [] | 0.1 秒 |
| 通過 | 名稱表（C++ STL、Rust、Go） | 59 passed, 0 failed [] | 0.2 秒 |
| 通過 | 名稱表（C#、Ruby、Lua；Python、Java、JavaScript 補強） | 94 passed, 0 failed [] | 0.2 秒 |
| 通過 | 圖片處理核心（灰階／強化／減色／模糊／馬賽克／旋轉／縮放／頁面排版） | 31 passed, 0 failed [] | 2.6 秒 |
| 通過 | 文件合併核心（種類判斷、文字解碼、docx／xlsx 簡化轉換、排版） | 7 passed, 0 failed [] | 0.4 秒 |
| 通過 | 依任務文字補專用工具（圖片轉PDF、合併文件成PDF） | 5 passed, 0 failed [] | 1.0 秒 |
| 通過 | 工具預算：短說明、精簡參數、階段切割、檢索 | 9 passed, 0 failed [] | 0.5 秒 |
| 通過 | Agent Model Configure：階段圖、特性估計、自動決定、內建預設、開關不動設定、重置、解析與備援順序、AI 回覆檢查 | PASS Agent Model Configure（階段圖、特性估計、自動決定、內建預設、開關不動設定、重置、解析與備援順序、AI 回覆檢查）：35 passed, 0 failed [] | 0.1 秒 |
| 通過 | 專案索引的定義抽取（C# 方法／屬性／namespace、Kotlin object、Java） | 5 passed, 0 failed [] | 0.3 秒 |
| 通過 | 離線圖像轉文字（模型登記、裝置、快取用量） | 134 passed, 0 failed [] | 0.2 秒 |
| 通過 | 離線小模型食譜（路由、填欄位、驗證、決策紀錄、多步驟引擎） | 72 passed, 0 failed [] | 0.2 秒 |
| 通過 | 離線多步驟計畫（目標、規劃、狀態機、決策樹） | 57 passed, 0 failed [] | 0.3 秒 |
| 通過 | UML → 程式骨架（DSL、驗證、圖、template、情境到 UML） | 76 passed, 0 failed [] | 0.7 秒 |
| 通過 | 設計抉擇與 framework 目錄（推薦、片段、rework、專案展開） | 54 passed, 0 failed [] | 0.6 秒 |
| 通過 | 膠水（接到真正的 library、經驗、登記） | 23 passed, 0 failed [] | 0.8 秒 |
| 通過 | 設計檢視器資料（節點樹、UML↔原始碼對應） | 21 passed, 0 failed [] | 0.2 秒 |
| 通過 | 互動對話卡片（規格、驗證、wizard、還原唯讀） | 29 passed, 0 failed [] | 0.1 秒 |
| 通過 | UML 設計引導（卡片流程、套用答案） | 16 passed, 0 failed [] | 0.2 秒 |
| 通過 | 離線日誌格式學習（模板、欄位、摘要、問答、訓練器規則） | 29 passed, 0 failed [] | 2.8 秒 |
| 通過 | 離線設定檔結構學習（INI、TOML、EDK2 INF／DEC／DSC、比較、機密遮蔽） | 44 passed, 0 failed [] | 0.2 秒 |
| 通過 | 文法自己發現（讀→建規則→驗證→再長；YAML、BitBake、nginx、Dockerfile、自創格式） | 46 passed, 0 failed [] | 0.2 秒 |
| 通過 | LALR(1) 表產生器與驅動程式（遞迴文法、衝突處理、優先序、bison 輸出） | 17 passed, 0 failed [] | 1.2 秒 |
| 通過 | 遞迴文法與分析表的學習（讀→找解析不了的地方→換成別的規則／組合／新規則→驗證） | 27 passed, 0 failed [] | 0.5 秒 |
| 通過 | 語法斷點發現（不假設一行一個陳述：找處理不了的邊界→兩兩合併→終結符號→驗證） | 24 passed, 0 failed [] | 0.9 秒 |
| 通過 | 混合內容語法高亮（切段、語言識別、信心度、自學習、逐詞著色） | 35 passed, 0 failed [] | 0.5 秒 |
| 通過 | 英文句子理解（詞類、片語、LALR 子句文法、框架、意圖、混合內容引用） | 26 passed, 0 failed [] | 0.7 秒 |
| 通過 | 意圖推導（受詞／目標型別、簽名比對、離線計畫可行性） | 16 passed, 0 failed [] | 0.3 秒 |
| 通過 | 單元目錄核心（已登記工具 → 單元：型別、副作用、可用性、信任等級；型別字串與相容判斷；格式驗證；評量統計） | catalog_core: 82 passed | 0.1 秒 |
| 通過 | 型別接線矩陣與路徑搜尋（回傳型別推論、具體程度、布林矩陣連乘、前 K 條接線與得分、萬用結構強制轉型） | matrix_core: 53 passed | 0.8 秒 |
| 通過 | 單元目錄：Python 原型抽取（註解 → 型別、原型 → 單元、真實跑抽取腳本） | extract_py: 74 passed | 0.8 秒 |
| 通過 | 單元目錄：型別存根轉換（typeshed 風格的 .pyi → 型別表：TypeVar／別名展開、多載合併、版本與平台分支）與存根型別套進單元 | stub_to_types: 33 passed | 1.3 秒 |
| 通過 | 單元目錄：探測執行（輸入產生、結果套回單元、真實跑探測腳本：擋檔案／系統呼叫、SystemExit、非決定性） | probe_core: 59 passed | 0.8 秒 |
| 通過 | 單元目錄：catalog_onboard 核心（請求驗證與安全關卡、為什麼沒晉升、摘要、持久化與合併、過期判斷、查詢） | onboard_core: 53 passed | 0.1 秒 |
| 通過 | 單元選擇評測核心（中英文檢索、候選與提示、答案解析、選擇與填參數評分、評測集檢查） | select_core: 54 passed | 0.1 秒 |
| 通過 | 呼叫格式（IR）與直譯器（靜態檢查、引用與型別、條件與有上限的迴圈、逾時／取消／預算、確認閘、模擬執行、從路徑產生程式） | ir_core: 56 passed | 0.2 秒 |
| 通過 | 歷史呼叫逆向推論（從實際回傳值反推 JSON 結構、合併樣本、選填欄位、狀態可存檔累積、套進目錄） | shape_core: 40 passed | 0.1 秒 |
| 通過 | JavaScript 單元抽取（匯出方式、JSDoc 型別、副作用與呼叫鏈、類別與 prototype、真實 UMD 檔案） | extract_js: 36 passed | 0.3 秒 |
| 通過 | 能力卡片（長文切片與地圖縮放、事實抽取、多片段投票融合、各種文件種類） | card_core: 33 passed | 0.2 秒 |
| 通過 | 排名模型訓練（邏輯迴歸、類別不平衡、留一組交叉驗證、特徵、模型排名） | rank_train: 11 passed | 0.3 秒 |
| 通過 | MCP（設定檔各家寫法、bundle manifest、專案偵測、JSON-RPC 用戶端、stdio／Streamable HTTP／SSE 傳輸、結果格式） | mcp_core: 53 passed | 0.5 秒 |
| 通過 | 壓縮檔（檔頭辨識 zip／jar／7z／rar／tar／gzip／bzip2／xz／iso、bzip2 解碼、tar 的 pax／GNU 長檔名、內容判斷、jar 摘要） | archive_core: 37 passed | 0.8 秒 |
| 通過 | 中英互譯的核心（方向判斷、切句、檢查譯文：語言／網址／重複／數字、提示詞、術語、自然語言命令不誤判） | translate_core: 87 passed | 0.1 秒 |
| 通過 | 語音合成的意圖辨識（用英文語音說…、把「…」念出來、tts: …；提問與別的「念／讀」不誤判） | tts_intent: 48 passed | 0.1 秒 |
| 通過 | 「沒有工具」的反思（宣稱偵測、搜尋所有領域的工具、提示文字） | cap_reflect: 45 passed | 0.1 秒 |
| 通過 | UML 拆解題（真的拆解流程＋假模型：完美、亂答、靠退回重來、連線失敗、空白；評分同義詞與中文關鍵字；建議 self／stepwise／program_first／unknown） | uml_bench_core: 37 passed | 0.2 秒 |
| 通過 | UML 編修（各種編修、套用後驗證並退回壞的、diff、問題→候選編修、小模型選編號、一批問題解決） | uml_edit_core: 48 passed, 0 failed | 0.1 秒 |
| 通過 | 達成路線（分類、依環境選程式語言、寄信三條路線、手動／自動閘門與副作用一定先問、缺能力→UML 編修） | route_core: 41 passed, 0 failed | 0.1 秒 |
| 通過 | 技能→食譜編譯器（抽步驟與工具、綁欄位、缺口交給 UML design、資料流） | PASS 技能→食譜編譯器：48 passed, 0 failed [] | 0.1 秒 |
| 通過 | 意圖解析（文字切割、語意角色、行為、隱含期待與驗證、缺口問題、UML、測試案例、中英翻譯輔助與媒合） | PASS 意圖解析（文字切割、語意角色、行為、隱含期待與驗證、缺口問題、UML、測試案例）：78 passed, 0 failed [] | 0.2 秒 |
| 通過 | 瀏覽器控制穩定生成（動作檢查、狀態接線、副作用標記、UML 來回、計畫一批、等擴充功能連上、執行驗證重試、整個任務） | bcplan_core: 70 passed, 0 failed | 0.2 秒 |
| 通過 | 資料離線精準查詢（SPDX／工作表：結構、讀問題、計畫、檢查、執行、SQL、放寬與最接近的值、歧義問字母、題庫） | dataquery_core: 31 passed, 0 failed | 0.3 秒 |
| 通過 | UML → LLVM IR → wasm32-wasi（IR 解析與型別檢查、wasm 產生、真的執行、運算／迴圈／遞迴／struct／全域／字串、檢查器擋錯、UML 軌跡一致） | llvm_core: 103 passed, 0 failed | 1.1 秒 |
| 通過 | 探索時的反思（錯字：英文編輯距離／中文同音近形字、不認得的字、概念再找、可能是新的需求、整份計畫反思：問使用者／統一走建議／上限） | reflect_core: 40 passed | 0.2 秒 |
| 通過 | CoLU 的 ReLU 形式（relu／sat／max2、可達性逐位元等於位元版、ReLU 層疊網路、最佳接線分數等於 findPipelines、矩陣連乘後端一致性檢查） | relu_core: 20 passed | 0.9 秒 |
| 通過 | CoLU 接線題（出題、評分、退化偵測、假模型跑整套、建議 self／guided／auto／unknown、使用時的提示） | colu_bench_core: 42 passed | 0.3 秒 |
| 通過 | 計畫的分歧偵測（沒有分歧不問、分數接近／取捨／勉強合格／找不到、題數上限、套用回答、打字補充撿網址、摘要） | branch_core: 40 passed | 0.1 秒 |
| 通過 | 採用／退回的回饋累積（壓縮卡片、計畫轉標註、權重、覆蓋規則、轉成訓練資料、可不可以訓練、樣本權重） | feedback_core: 22 passed | 0.6 秒 |
| 通過 | 缺口驅動探索（缺口、搜尋關鍵字、候選排名、錯誤歸類與換做法、整個迴圈用假主機） | discover_core: 50 passed | 0.2 秒 |
| 通過 | 單元嵌入檢索（單元文字、向量打包與失效、餘弦排名、排名融合） | embed_core: 24 passed | 0.1 秒 |
| 通過 | 需求→活動→單元（UML 型別合約、檢索加型別打分、資料流、橋接、型別接線） | bind_core: 38 passed | 0.2 秒 |
| 通過 | 資料檢視器核心（JSON／YAML／TOML／CSV 解析與轉出、上色、SBOM 轉多工作表、XLSX 讀寫、樹與搜尋） | data_core: 50 passed | 0.4 秒 |
| 通過 | SQL 語句切分與完整性判斷 | 14 passed, 0 failed [] | 0.1 秒 |
| 通過 | 檔案用途／函式做什麼的說明產生器（FaExplain） | 16 passed, 0 failed [] | 0.1 秒 |
| 通過 | CI 核心（Gerrit／GitHub／Jenkins 整理、失敗記錄分診 triage） | 21 passed, 0 failed [] | 2.4 秒 |
| 通過 | Pipeline 解析／lint／本機重現／樣板（Jenkinsfile、GitHub Actions、GitLab CI） | 13 passed, 0 failed [] | 0.2 秒 |
| 通過 | coding_edit 核心（搜尋取代、regex、unified diff 用 git apply 驗證） | 12 passed, 0 failed [] | 19.5 秒 |
| 通過 | coding_edit／coding_patch_tool 整合（真的暫存工作區、git、腳本乾跑與套用） | 14 passed, 0 failed [] | 10.0 秒 |
| 通過 | CI 連線 HTTP（讀取上限、tail、寫入確認、逾時） | 0 passed, 0 failed [] (略過：這個 Node 沒有 fetch，需要 Node 18 以上) | 0.1 秒 |
| **失敗** | 行為描述 8 種語言（真的 tree-sitter 文法；離線時略過） | 261 passed, 1 failed [ 'csharp_broken: 找到函式 After ["Load","Save"]' ] | 8.7 秒 |
| 通過 | sqlitebrowser 純函式（過濾語法、DDL 預覽、儲存格、匯出） | 9 passed, 0 failed [] | 0.1 秒 |
| 通過 | 終端機 /mnt 即時 FAP 檔案系統（wasi-sh 契約、快取、寫回、衝突） | 15 passed, 0 failed [] | 0.4 秒 |
| 通過 | 桌面版終端機 /mnt 的同步檔案後端（fsx-sync：真的碰磁碟） | 6 passed, 0 failed [] | 0.2 秒 |
| 通過 | 遠端群組：密碼規則、金鑰推導、加解密、群組（人數上限、名稱不重複、訊息切塊） | rg_core: 34 passed | 2.1 秒 |
| 通過 | 遠端群組：函式清單（防止新功能插入時蓋掉別組功能） | rg_methods: 102 passed | 0.1 秒 |
| 通過 | 遠端群組：慢速信箱（Cloudflare KV，用假 KV 測 Worker 與傳輸） | rg_kv: 20 passed | 14.5 秒 |
| 通過 | 遠端群組：內容傳輸（直連與轉送備援、完整性驗證、未宣告拒絕） | rg_files: 10 passed | 1.2 秒 |
| 通過 | 動畫簡報：格式、驗證、時間軸、渲染（deck_core） | deck_core: 82 passed, 0 failed | 0.4 秒 |
| 通過 | 動畫簡報：字幕可以跟念的不一樣（caption）、配音失敗／逾時的備援、聲音清單 | PASS 簡報字幕與配音備援：28 passed, 0 failed [] | 0.3 秒 |
| 通過 | 動畫簡報：動畫物件描述（場景、物件動畫、鏡頭、連動音效、對話泡泡、敘事文字、要點 highlight、疊字幕） | PASS 動畫物件描述（場景、物件動畫、鏡頭、連動音效、對話泡泡、敘事文字、要點 highlight、疊字幕）：52 passed, 0 failed [] | 0.6 秒 |
| 通過 | 動畫簡報：RPG 式對話場景（程序化地圖／人物／頭像、格子座標走路、A* 繞路、對話框與字幕、聚光、黑幕轉場、使用者素材、CoLU 故事規劃） | 93 passed, 0 failed | 1.2 秒 |
| 通過 | 動畫簡報：點陣精靈（去背、縮進畫格、調色盤、外框、物件樣板） | 36 passed, 0 failed | 1.4 秒 |
| 通過 | 動畫簡報：點陣圖物件設計工具（調色盤、字母列、鏡射、繪圖指令、亮暗部、外框、內建範例） | 28 passed, 0 failed | 0.2 秒 |
| 通過 | 動畫簡報：人物精靈圖（3D 人物零件、z-buffer 光柵、多格共用調色盤、精靈圖打包、三種風格） | 39 passed, 0 failed | 1.8 秒 |
| 通過 | 動畫簡報：故事／名詞清單→舞台（意象推導＋CoLU：角色與對話、動作與音效、進出場景、名詞清單、封閉問題） | PASS 故事→舞台（意象推導＋CoLU：角色與對話、動作與音效、進出場景、名詞清單、封閉問題）：39 passed, 0 failed [] | 0.4 秒 |
| 通過 | 教育文書（學習單）：讀請求、驗證、排版、SVG／HTML／PDF、參考圖片、編輯動作、封閉題 | PASS 教育文書（學習單）：讀請求、驗證、排版、SVG／HTML／PDF、參考圖片、編輯動作、封閉題：90 passed, 0 failed [] | 0.2 秒 |
| 通過 | 網頁編輯器：描述驗證、預覽內嵌、起手式、編輯動作、後端分流 | PASS 網頁編輯器核心（描述驗證、預覽內嵌、起手式、編輯動作、讀指令與分流、後端任務、摘要 prompt）：30 passed, 0 failed [] | 0.1 秒 |
| 通過 | SVG／圖片／3D 編輯器共用的物件模型：封閉動作、相對放置、無邊界畫布 | edit_objects_core: 46 passed | 0.1 秒 |
| 通過 | SVG／圖片編輯器的圖片來源：維基共享資源與 Openverse 的排序、網址、授權 | picture_source: 14 passed | 0.1 秒 |
| 通過 | SVG 編輯器：形狀與自由 SVG 物件、合成、拆回物件、安全檢查 | edit_svg_core: 23 passed | 0.1 秒 |
| 通過 | SVG 描圖：量化、輪廓追蹤、簡化、相似度 | svg_trace: 11 passed | 0.6 秒 |
| 通過 | 圖片編輯器：風格濾鏡、修復（補洞／去雜訊／去污點） | pic_fx: 28 passed | 0.7 秒 |
| 通過 | 圖片編輯器的擴散細化層：裁哪裡、羽化遮罩、色調對齊、蓋回去、借細節、縮放 | 27 passed, 0 failed | 0.3 秒 |
| 通過 | 圖片編輯器：圖層（濾鏡層、修復層）、風格、相對放置、程式先讀的指令 | edit_picture_core: 37 passed | 0.2 秒 |
| 通過 | 3D 場景編輯器：以使用者視角的相對放置、封閉動作、群組、貼皮、YAML 往返、程式先讀的指令 | edit3d_core: 59 passed | 0.3 秒 |
| 通過 | 3D 單一物件編輯（貼皮）：面、位置、顏色、圖、程式先讀的指令 | edit3d_part_core: 19 passed | 0.2 秒 |
| 通過 | 遊戲編輯器：模擬核心（固定步長、碰撞、規則與狀態機、場景切換、對話、戰鬥、確定性重播、現場熱修補） | game_sim: 42 passed | 0.7 秒 |
| 通過 | 遊戲編輯器：封閉動作、相對放置、影響範圍、YAML 往返、脈絡包、程式先讀的指令、範本 | game_core: 40 passed | 0.5 秒 |
| 通過 | 遊戲編輯器：畫法、聲音合成、UML、遊戲包 .fagame | game_parts: 23 passed | 1.7 秒 |
| 通過 | 遊戲編輯器：目標原始碼（網頁／Electron／Node.js 由程式產生、AI 逐檔計畫、舊機種適配檢查、測試向量） | game_gen: 31 passed | 2.4 秒 |
| 通過 | 簡報編輯器：簡報檔的物件模型、封閉動作（加頁、改旁白、搬動、隱藏、鎖定、整份替換）、程式先讀的白話、前後版本差異 | deck_edit_core: 44 passed | 0.2 秒 |
| 通過 | 長文章目錄：wiki、新聞、小說章回、分段閱讀 | article_outline: 20 passed | 0.1 秒 |
| 通過 | NVIDIA 線上圖像生成：請求整理、參數夾範圍、回應解析 | nvidia_image: 18 passed | 0.2 秒 |
| 通過 | 本機小模型生圖（SDXS-512 GPU／CPU 版）：選版本、取樣的數學、亂數、張量轉圖片、錯誤說明 | local_sd: 33 passed | 0.2 秒 |
| 通過 | 圖像生成分流：形狀圖（SVG／Mermaid 純文字）或擴散模型、提示詞範本（SD／FLUX／SD3）、圖片描述轉欄位 | image_route: 80 passed | 0.2 秒 |
| 通過 | 主題簡報食譜（/media-presentation 只給主題）：需求解析、規劃與樣板、旁白驗收、組簡報、修復 | deck_topic: 27 passed | 0.1 秒 |
| 通過 | /image 的規劃：由上而下細切成單元、樣板退路、依輸入輸出欄位接線成 IR 程式 | image_plan: 17 passed | 0.1 秒 |
| 通過 | 文件撰寫器（/user-guide、/design-guide）：掃描與證據、架構比對、範本選擇、組文件、驗證、潤飾驗收、md／wiki／html／pdf／docx 輸出 | docgen: 47 passed | 0.3 秒 |
| 通過 | YAML 用途標記（#!fa:deck 這類開頭／結尾宣告）：偵測、檢查、加標記 | yamlkind_core: 30 passed | 0.2 秒 |
| 通過 | Knowledge Inventory 核心：各格式帶行號的來源、出處、關鍵字＋向量檢索、原句摘要、核對、關聯 | knowledge_core: 55 passed | 0.2 秒 |
| 通過 | Knowledge Inventory 儲存層（真的 SQLite＋FTS5；沒有 node:sqlite 的 Node 會略過） | knowledge_store: skipped（沒有 node:sqlite，要 Node 22.5 以上才會跑）0 failed | 0.1 秒 |
| 通過 | 動畫簡報：程式碼視窗、patch、問答卡、小工具沙盒、互動視覺的格式規則 | 97 passed | 0.6 秒 |
| 通過 | 動畫簡報：影片視覺（播放、重播、快轉、速度、A-B 循環的格式規則） | 20 passed | 0.5 秒 |
| 通過 | 動畫簡報：每份簡報自己的外框配色（deck.colors） | deck_colors: 8 passed | 0.2 秒 |
| 通過 | 動畫簡報：內建可愛插圖（注音與第一個符號核對） | deck_cute: 43 passed | 0.1 秒 |
| 通過 | 主行程可 live-update 的 IPC 模組（main-ext.js：fa:rawfs:* 九個 handler） | main_ext: 24 passed | 1.2 秒 |
| 通過 | 本地中文語音：文字轉音素（1379 個音節與 misaki 逐字相同） | zh_g2p: 13 passed | 0.2 秒 |
| 通過 | 動畫簡報：問答頁把關（標題不洩漏答案、問「這個東西」要有畫面） | deck_quiz_slide: 5 passed | 0.2 秒 |
| 通過 | 動畫簡報：一頁一種語言的語音（混語檢查、念之前翻成英文或退回中文語音） | 19 passed | 0.2 秒 |
| 通過 | 動畫簡報：小工具範例（打磚塊）真的玩到通關 | widget_example: 6 passed | 0.4 秒 |
| 通過 | 動畫簡報：工具（長文字 handle、圖片目錄、長度估算） | deck_tools: 31 passed | 0.2 秒 |
| 通過 | 動畫簡報：樣板（預設值、複寫會改變繪製） | deck_template: 18 passed | 0.3 秒 |
| 通過 | 動畫簡報：簡報封包（開啟新舊格式、拒絕不合法） | deck_pack: 14 passed | 0.4 秒 |
| 通過 | 電腦操作：PNG 編解碼、裁切縮放、差異、格線 | computer-png: 15 passed, 0 failed | 0.2 秒 |
| 通過 | 電腦操作：安全閘門（範圍、被蓋住、拒絕清單、密碼欄、按鍵、速率、中止、預覽） | computer-use-safety: 69 passed, 0 failed | 0.1 秒 |
| 通過 | 電腦操作：RFB 編解碼（DES、持續狀態 inflate、ZRLE 磁磚） | rfb-codec: 14 passed, 0 failed | 0.2 秒 |
| 通過 | 電腦操作：RFB 用戶端（假伺服器：Raw／RRE／Hextile／ZRLE／CopyRect／游標／驗證／輸入／WebSocket／候選物件） | rfb-client: 23 passed, 0 failed | 2.5 秒 |
| 通過 | 電腦操作：遠端協定探測（RDP／SPICE／NX／SSH／HTTP／RFB）、畫布視窗偵測、WebSocket 用戶端 | computer-remote: 46 passed, 0 failed | 9.3 秒 |
| 通過 | 電腦操作：Windows 後端（PowerShell 腳本產生、C# 編譯檢查、nircmd、UI Automation 轉換；Windows 實跑未實測） | computer-use-windows: 35 passed, 0 failed | 0.3 秒 |
| **失敗** | 電腦操作：主行程 IPC（假 Electron：原生核准、權限提升、全域中止鍵、機密） |   setRemoteSecret：名稱消毒、存進 secrets.json 的專屬欄位、不動別的金鑰、檔案權限 600 | 4.6 秒 |
| 通過 | 電腦操作：renderer 核心（詞彙與主行程一致、動作整理、座標換算、視覺答案解析、驗證評分、/computer 指令） | computer_core: 40 passed, 0 failed | 0.2 秒 |
| 通過 | 電腦操作：視覺慢路徑（切磚、定位、驗證、探索；假視覺模型） | computer_vision: 17 passed, 0 failed | 0.2 秒 |
| 通過 | 電腦操作：renderer 工具層（19 個 computer_* 工具、/computer 指令、網頁版不註冊） | computer_host: 47 passed, 0 failed | 0.2 秒 |
| **失敗** | 電腦操作：INTEGRATION.md 的貼上用區塊（領域、任務提示 regex、YAML、embed 片段、接線補丁） |  | 0.1 秒 |
| 通過 | 圖片轉3D核心（封閉殼、平滑殼、背景差分、全景分層、貼材質） | 38 passed | 41.7 秒 |

## 失敗項目

### 行為描述 8 種語言（真的 tree-sitter 文法；離線時略過）（`renderer/src/behavior/tests/langs.itest.js`）

### 電腦操作：主行程 IPC（假 Electron：原生核准、權限提升、全域中止鍵、機密）（`scripts/computer-tests/ipc.test.js`）

### 電腦操作：INTEGRATION.md 的貼上用區塊（領域、任務提示 regex、YAML、embed 片段、接線補丁）（`scripts/computer-tests/integration_doc.test.js`）
- stderr：D:\Downloads\videos-嗨投資-desktop-app\desktop-app\scripts\computer-tests\integration_doc.test.js:9 const block = (name) => { const m = new RegExp('<!-- BLOCK:' + name + ' -->\\s*```(\\w+)\\n([\\s\\S]*?)```').exec(md); if (!m) throw new Error('找不到區塊 ' + name); return m[2]; }; 
