#!/usr/bin/env node
// 一次跑完所有「純函式核心」的測試（不需要 Electron、不需要瀏覽器）。移植到別的專案（例如 redmine 的 AI 聊天）之後，搬過去的檔案跑這支，確認行為跟這邊一致。
// 用法：node scripts/run-core-tests.js
// 注意：需要真實環境驗證的部分（Electron／瀏覽器裡的標註視窗、蒙皮檢視器、Worker）不在這裡，見 DESIGN.knowledge-portability.md 的「驗證」一節。
const { spawnSync } = require('child_process');
const path = require('path');
const root = path.join(__dirname, '..');
const suites = [
    ['知識引擎（類型、驗證、展開、知識包）', 'renderer/src/refs/tests/ref_engine.test.js'],
    ['標註核心（魔術棒、切格、猜字）', 'renderer/src/annotator/annot_core.test.js'],
    ['蒙皮核心（骨架、權重、動作）', 'renderer/src/skin/skin_core.test.js'],
    ['名稱表（C++ STL、Rust、Go）', 'renderer/src/behavior/tests/names_tables.test.js'],
    ['名稱表（C#、Ruby、Lua；Python、Java、JavaScript 補強）', 'renderer/src/behavior/tests/names_more_langs.test.js'],
    ['圖片處理核心（灰階／強化／減色／模糊／馬賽克／旋轉／縮放／頁面排版）', 'renderer/src/imgproc/imgproc_core.test.js'],
    ['文件合併核心（種類判斷、文字解碼、docx／xlsx 簡化轉換、排版）', 'renderer/src/docmerge/docmerge_core.test.js'],
    ['依任務文字補專用工具（圖片轉PDF、合併文件成PDF）', 'scripts/task-tool-hints.test.js'],
    ['工具預算：短說明、精簡參數、階段切割、檢索', 'renderer/src/tools/tool_budget_core.test.js'],
    ['Agent Model Configure：階段圖、特性估計、自動決定、內建預設、開關不動設定、重置、解析與備援順序、AI 回覆檢查', 'renderer/src/tools/agent_model_core.test.js'],
    ['專案索引的定義抽取（C# 方法／屬性／namespace、Kotlin object、Java）', 'scripts/repo-extract.test.js'],
    ['離線圖像轉文字（模型登記、裝置、快取用量）', 'renderer/src/vlm/vlm_core.test.js'],
    ['離線小模型食譜（路由、填欄位、驗證、決策紀錄、多步驟引擎）', 'renderer/src/recipe/recipe_core.test.js'],
    ['離線多步驟計畫（目標、規劃、狀態機、決策樹）', 'renderer/src/recipe/plan_core.test.js'],
    ['UML → 程式骨架（DSL、驗證、圖、template、情境到 UML）', 'renderer/src/uml/uml_core.test.js'],
    ['設計抉擇與 framework 目錄（推薦、片段、rework、專案展開）', 'renderer/src/uml/design_core.test.js'],
    ['膠水（接到真正的 library、經驗、登記）', 'renderer/src/uml/glue_core.test.js'],
    ['設計檢視器資料（節點樹、UML↔原始碼對應）', 'renderer/src/uml/view_core.test.js'],
    ['互動對話卡片（規格、驗證、wizard、還原唯讀）', 'renderer/src/card/card_core.test.js'],
    ['UML 設計引導（卡片流程、套用答案）', 'renderer/src/card/uml_guide.test.js'],
    ['離線日誌格式學習（模板、欄位、摘要、問答、訓練器規則）', 'renderer/src/logmine/log_core.test.js'],
    ['離線設定檔結構學習（INI、TOML、EDK2 INF／DEC／DSC、比較、機密遮蔽）', 'renderer/src/logmine/cfg_core.test.js'],
    ['文法自己發現（讀→建規則→驗證→再長；YAML、BitBake、nginx、Dockerfile、自創格式）', 'renderer/src/logmine/gram_core.test.js'],
    ['LALR(1) 表產生器與驅動程式（遞迴文法、衝突處理、優先序、bison 輸出）', 'renderer/src/logmine/lr_core.test.js'],
    ['遞迴文法與分析表的學習（讀→找解析不了的地方→換成別的規則／組合／新規則→驗證）', 'renderer/src/logmine/cfglearn_core.test.js'],
    ['語法斷點發現（不假設一行一個陳述：找處理不了的邊界→兩兩合併→終結符號→驗證）', 'renderer/src/logmine/boundary_core.test.js'],
    ['混合內容語法高亮（切段、語言識別、信心度、自學習、逐詞著色）', 'renderer/src/logmine/mix_core.test.js'],
    ['英文句子理解（詞類、片語、LALR 子句文法、框架、意圖、混合內容引用）', 'renderer/src/logmine/nlu_core.test.js'],
    ['意圖推導（受詞／目標型別、簽名比對、離線計畫可行性）', 'renderer/src/logmine/intent_core.test.js'],
    ['單元目錄核心（已登記工具 → 單元：型別、副作用、可用性、信任等級；型別字串與相容判斷；格式驗證；評量統計）', 'renderer/src/catalog/catalog_core.test.js'],
    ['型別接線矩陣與路徑搜尋（回傳型別推論、具體程度、布林矩陣連乘、前 K 條接線與得分、萬用結構強制轉型）', 'renderer/src/catalog/matrix_core.test.js'],
    ['單元目錄：Python 原型抽取（註解 → 型別、原型 → 單元、真實跑抽取腳本）', 'renderer/src/catalog/extract_py.test.js'],
    ['單元目錄：型別存根轉換（typeshed 風格的 .pyi → 型別表：TypeVar／別名展開、多載合併、版本與平台分支）與存根型別套進單元', 'renderer/src/catalog/stub_to_types.test.js'],
    ['單元目錄：探測執行（輸入產生、結果套回單元、真實跑探測腳本：擋檔案／系統呼叫、SystemExit、非決定性）', 'renderer/src/catalog/probe_core.test.js'],
    ['單元目錄：catalog_onboard 核心（請求驗證與安全關卡、為什麼沒晉升、摘要、持久化與合併、過期判斷、查詢）', 'renderer/src/catalog/onboard_core.test.js'],
    ['單元選擇評測核心（中英文檢索、候選與提示、答案解析、選擇與填參數評分、評測集檢查）', 'renderer/src/catalog/select_core.test.js'],
    ['呼叫格式（IR）與直譯器（靜態檢查、引用與型別、條件與有上限的迴圈、逾時／取消／預算、確認閘、模擬執行、從路徑產生程式）', 'renderer/src/catalog/ir_core.test.js'],
    ['歷史呼叫逆向推論（從實際回傳值反推 JSON 結構、合併樣本、選填欄位、狀態可存檔累積、套進目錄）', 'renderer/src/catalog/shape_core.test.js'],
    ['JavaScript 單元抽取（匯出方式、JSDoc 型別、副作用與呼叫鏈、類別與 prototype、真實 UMD 檔案）', 'renderer/src/catalog/extract_js.test.js'],
    ['能力卡片（長文切片與地圖縮放、事實抽取、多片段投票融合、各種文件種類）', 'renderer/src/catalog/card_core.test.js'],
    ['排名模型訓練（邏輯迴歸、類別不平衡、留一組交叉驗證、特徵、模型排名）', 'renderer/src/catalog/rank_train.test.js'],
    ['MCP（設定檔各家寫法、bundle manifest、專案偵測、JSON-RPC 用戶端、stdio／Streamable HTTP／SSE 傳輸、結果格式）', 'renderer/src/mcp/mcp_core.test.js'],
    ['壓縮檔（檔頭辨識 zip／jar／7z／rar／tar／gzip／bzip2／xz／iso、bzip2 解碼、tar 的 pax／GNU 長檔名、內容判斷、jar 摘要）', 'renderer/src/archive/archive_core.test.js'],
    ['中英互譯的核心（方向判斷、切句、檢查譯文：語言／網址／重複／數字、提示詞、術語、自然語言命令不誤判）', 'renderer/src/tools/translate_core.test.js'],
    ['語音合成的意圖辨識（用英文語音說…、把「…」念出來、tts: …；提問與別的「念／讀」不誤判）', 'renderer/src/tools/tts_intent.test.js'],
    ['「沒有工具」的反思（宣稱偵測、搜尋所有領域的工具、提示文字）', 'renderer/src/tools/cap_reflect.test.js'],
    ['UML 拆解題（真的拆解流程＋假模型：完美、亂答、靠退回重來、連線失敗、空白；評分同義詞與中文關鍵字；建議 self／stepwise／program_first／unknown）', 'renderer/src/uml/uml_bench_core.test.js'],
    ['UML 編修（各種編修、套用後驗證並退回壞的、diff、問題→候選編修、小模型選編號、一批問題解決）', 'renderer/src/uml/uml_edit_core.test.js'],
    ['達成路線（分類、依環境選程式語言、寄信三條路線、手動／自動閘門與副作用一定先問、缺能力→UML 編修）', 'renderer/src/catalog/route_core.test.js'],
    ['技能→食譜編譯器（抽步驟與工具、綁欄位、缺口交給 UML design、資料流）', 'renderer/src/recipe/skill_compile_core.test.js'],
    ['意圖解析（文字切割、語意角色、行為、隱含期待與驗證、缺口問題、UML、測試案例、中英翻譯輔助與媒合）', 'renderer/src/uml/user_intent_core.test.js'],
    ['瀏覽器控制穩定生成（動作檢查、狀態接線、副作用標記、UML 來回、計畫一批、等擴充功能連上、執行驗證重試、整個任務）', 'renderer/src/browser/bcplan_core.test.js'],
    ['資料離線精準查詢（SPDX／工作表：結構、讀問題、計畫、檢查、執行、SQL、放寬與最接近的值、歧義問字母、題庫）', 'renderer/src/dataview/dataquery_core.test.js'],
    ['UML → LLVM IR → wasm32-wasi（IR 解析與型別檢查、wasm 產生、真的執行、運算／迴圈／遞迴／struct／全域／字串、檢查器擋錯、UML 軌跡一致）', 'renderer/src/uml/llvm_core.test.js'],
    ['探索時的反思（錯字：英文編輯距離／中文同音近形字、不認得的字、概念再找、可能是新的需求、整份計畫反思：問使用者／統一走建議／上限）', 'renderer/src/catalog/reflect_core.test.js'],
    ['CoLU 的 ReLU 形式（relu／sat／max2、可達性逐位元等於位元版、ReLU 層疊網路、最佳接線分數等於 findPipelines、矩陣連乘後端一致性檢查）', 'renderer/src/catalog/relu_core.test.js'],
    ['CoLU 接線題（出題、評分、退化偵測、假模型跑整套、建議 self／guided／auto／unknown、使用時的提示）', 'renderer/src/catalog/colu_bench_core.test.js'],
    ['計畫的分歧偵測（沒有分歧不問、分數接近／取捨／勉強合格／找不到、題數上限、套用回答、打字補充撿網址、摘要）', 'renderer/src/catalog/branch_core.test.js'],
    ['採用／退回的回饋累積（壓縮卡片、計畫轉標註、權重、覆蓋規則、轉成訓練資料、可不可以訓練、樣本權重）', 'renderer/src/catalog/feedback_core.test.js'],
    ['缺口驅動探索（缺口、搜尋關鍵字、候選排名、錯誤歸類與換做法、整個迴圈用假主機）', 'renderer/src/catalog/discover_core.test.js'],
    ['單元嵌入檢索（單元文字、向量打包與失效、餘弦排名、排名融合）', 'renderer/src/catalog/embed_core.test.js'],
    ['需求→活動→單元（UML 型別合約、檢索加型別打分、資料流、橋接、型別接線）', 'renderer/src/catalog/bind_core.test.js'],
    ['資料檢視器核心（JSON／YAML／TOML／CSV 解析與轉出、上色、SBOM 轉多工作表、XLSX 讀寫、樹與搜尋）', 'renderer/src/dataview/data_core.test.js'],
    ['SQL 語句切分與完整性判斷', 'renderer/src/sql/sql_split.test.js'],
    ['檔案用途／函式做什麼的說明產生器（FaExplain）', 'renderer/src/explain/code_explain.test.js'],
    ['CI 核心（Gerrit／GitHub／Jenkins 整理、失敗記錄分診 triage）', 'renderer/src/ci/ci_core.test.js'],
    ['Pipeline 解析／lint／本機重現／樣板（Jenkinsfile、GitHub Actions、GitLab CI）', 'renderer/src/ci/pipeline_core.test.js'],
    ['coding_edit 核心（搜尋取代、regex、unified diff 用 git apply 驗證）', 'scripts/coding-edit.test.js'],
    ['coding_edit／coding_patch_tool 整合（真的暫存工作區、git、腳本乾跑與套用）', 'scripts/coding-tools.itest.js'],
    ['CI 連線 HTTP（讀取上限、tail、寫入確認、逾時）', 'scripts/ci-fetch.itest.js'],
    ['行為描述 8 種語言（真的 tree-sitter 文法；離線時略過）', 'renderer/src/behavior/tests/langs.itest.js'],
    ['sqlitebrowser 純函式（過濾語法、DDL 預覽、儲存格、匯出）', 'renderer/src/sql/browser_core.test.js'],
    ['終端機 /mnt 即時 FAP 檔案系統（wasi-sh 契約、快取、寫回、衝突）', 'renderer/src/terminal/fapfs_core.test.js'],
    ['桌面版終端機 /mnt 的同步檔案後端（fsx-sync：真的碰磁碟）', 'scripts/fsx-sync.test.js'],
    ['遠端群組：密碼規則、金鑰推導、加解密、群組（人數上限、名稱不重複、訊息切塊）', 'scripts/remote-tests/rg_core.test.js'],
    ['遠端群組：函式清單（防止新功能插入時蓋掉別組功能）', 'scripts/remote-tests/rg_methods.test.js'],
    ['遠端群組：慢速信箱（Cloudflare KV，用假 KV 測 Worker 與傳輸）', 'scripts/remote-tests/rg_kv.test.js'],
    ['遠端群組：內容傳輸（直連與轉送備援、完整性驗證、未宣告拒絕）', 'scripts/remote-tests/rg_files.test.js'],
    ['動畫簡報：格式、驗證、時間軸、渲染（deck_core）', 'scripts/deck-tests/deck_core.test.js'],
    ['動畫簡報：字幕可以跟念的不一樣（caption）、配音失敗／逾時的備援、聲音清單', 'scripts/deck-tests/deck_voice.test.js'],
    ['動畫簡報：動畫物件描述（場景、物件動畫、鏡頭、連動音效、對話泡泡、敘事文字、要點 highlight、疊字幕）', 'scripts/deck-tests/deck_collage.test.js'],
    ['動畫簡報：RPG 式對話場景（程序化地圖／人物／頭像、格子座標走路、A* 繞路、對話框與字幕、聚光、黑幕轉場、使用者素材、CoLU 故事規劃）', 'scripts/deck-tests/deck_rpg.test.js'],
    ['動畫簡報：點陣精靈（去背、縮進畫格、調色盤、外框、物件樣板）', 'scripts/deck-tests/sprite_pixel.test.js'],
    ['動畫簡報：點陣圖物件設計工具（調色盤、字母列、鏡射、繪圖指令、亮暗部、外框、內建範例）', 'scripts/deck-tests/pixel_art.test.js'],
    ['動畫簡報：人物精靈圖（3D 人物零件、z-buffer 光柵、多格共用調色盤、精靈圖打包、三種風格）', 'scripts/deck-tests/sprite_char.test.js'],
    ['動畫簡報：故事／名詞清單→舞台（意象推導＋CoLU：角色與對話、動作與音效、進出場景、名詞清單、封閉問題）', 'scripts/deck-tests/deck_stage.test.js'],
    ['教育文書（學習單）：讀請求、驗證、排版、SVG／HTML／PDF、參考圖片、編輯動作、封閉題', 'scripts/worksheet-tests/worksheet_core.test.js'],
    ['網頁編輯器：描述驗證、預覽內嵌、起手式、編輯動作、後端分流', 'scripts/webedit-tests/webedit_core.test.js'],
    ['長文章目錄：wiki、新聞、小說章回、分段閱讀', 'scripts/article-tests/article_outline.test.js'],
    ['NVIDIA 線上圖像生成：請求整理、參數夾範圍、回應解析', 'scripts/imagegen-tests/nvidia_image.test.js'],
    ['本機小模型生圖（SDXS-512 GPU／CPU 版）：選版本、取樣的數學、亂數、張量轉圖片、錯誤說明', 'scripts/imagegen-tests/local_sd.test.js'],
    ['圖像生成分流：形狀圖（SVG／Mermaid 純文字）或擴散模型、提示詞範本（SD／FLUX／SD3）、圖片描述轉欄位', 'scripts/imagegen-tests/image_route.test.js'],
    ['/image 的規劃：由上而下細切成單元、樣板退路、依輸入輸出欄位接線成 IR 程式', 'scripts/imagegen-tests/image_plan.test.js'],
    ['文件撰寫器（/user-guide、/design-guide）：掃描與證據、架構比對、範本選擇、組文件、驗證、潤飾驗收、md／wiki／html／pdf／docx 輸出', 'scripts/docgen-tests/docgen.test.js'],
    ['YAML 用途標記（#!fa:deck 這類開頭／結尾宣告）：偵測、檢查、加標記', 'scripts/yamlkind-tests/yamlkind_core.test.js'],
    ['Knowledge Inventory 核心：各格式帶行號的來源、出處、關鍵字＋向量檢索、原句摘要、核對、關聯', 'scripts/knowledge-tests/knowledge_core.test.js'],
    ['Knowledge Inventory 儲存層（真的 SQLite＋FTS5；沒有 node:sqlite 的 Node 會略過）', 'scripts/knowledge-tests/knowledge_store.test.js'],
    ['動畫簡報：程式碼視窗、patch、問答卡、小工具沙盒、互動視覺的格式規則', 'scripts/deck-tests/deck_interactive.test.js'],
    ['動畫簡報：影片視覺（播放、重播、快轉、速度、A-B 循環的格式規則）', 'scripts/deck-tests/deck_video.test.js'],
    ['動畫簡報：每份簡報自己的外框配色（deck.colors）', 'scripts/deck-tests/deck_colors.test.js'],
    ['動畫簡報：內建可愛插圖（注音與第一個符號核對）', 'scripts/deck-tests/deck_cute.test.js'],
    ['主行程可 live-update 的 IPC 模組（main-ext.js：fa:rawfs:* 九個 handler）', 'scripts/main-tests/main_ext.test.js'],
    ['本地中文語音：文字轉音素（1379 個音節與 misaki 逐字相同）', 'scripts/tts-tests/zh_g2p.test.js'],
    ['動畫簡報：問答頁把關（標題不洩漏答案、問「這個東西」要有畫面）', 'scripts/deck-tests/deck_quiz_slide.test.js'],
    ['動畫簡報：一頁一種語言的語音（混語檢查、念之前翻成英文或退回中文語音）', 'scripts/deck-tests/deck_language.test.js'],
    ['動畫簡報：小工具範例（打磚塊）真的玩到通關', 'scripts/deck-tests/widget_example.test.js'],
    ['動畫簡報：工具（長文字 handle、圖片目錄、長度估算）', 'scripts/deck-tests/deck_tools.test.js'],
    ['動畫簡報：樣板（預設值、複寫會改變繪製）', 'scripts/deck-tests/deck_template.test.js'],
    ...(() => { try { require.resolve('jszip'); return [['動畫簡報：簡報封包（開啟新舊格式、拒絕不合法）', 'scripts/deck-tests/deck_pack.test.js']]; } catch (_) { console.log('略過 簡報封包測試：沒有安裝 jszip（npm install --no-save jszip）'); return []; } })(),
];
let failed = 0;
for (const [name, file] of suites) {
    const r = spawnSync(process.execPath, [path.join(root, file)], { encoding: 'utf8' });
    const last = String(r.stdout || '').trim().split('\n').pop();
    const ok = r.status === 0 && /(0 failed|[0-9]+ passed)/.test(last) && !/FAILED/.test(last);
    if (!ok) failed++;
    console.log((ok ? 'PASS ' : 'FAIL ') + name + '：' + last);
    if (!ok) console.log(String(r.stdout || '').split('\n').filter((l) => /^FAIL/.test(l)).join('\n') + String(r.stderr || '').slice(0, 500));
}
// 部位偵測（Python）：有 python 與 numpy／pillow 才跑，沒有就略過並說明
const py = spawnSync('python', ['-c', 'import numpy, PIL'], { encoding: 'utf8' });
if (py.status === 0) {
    const ex = spawnSync(process.execPath, [path.join(root, 'scripts/export-visual-parts.js')], { encoding: 'utf8' });
    const r = spawnSync('python', [path.join(root, 'skills/image-decompose-redraw/tests/test_parts.py')], { encoding: 'utf8' });
    const last = String(r.stdout || '').trim().split('\n').filter(Boolean).pop() || '';
    const ok = ex.status === 0 && r.status === 0 && /0 failed/.test(last);
    if (!ok) failed++;
    console.log((ok ? 'PASS ' : 'FAIL ') + '部位偵測（Python）：' + last);
} else console.log('略過 部位偵測（Python）：沒有 python 或缺 numpy／pillow');
// fa_sqlite（Python 的 sqlite3 相容介面）：用標準函式庫的 sqlite3 假冒引擎來測，有 python 才跑
const pq = spawnSync('python', [path.join(root, 'scripts/test_fa_sqlite.py')], { encoding: 'utf8' });
if (pq.error) console.log('略過 fa_sqlite（Python）：沒有 python');
else { const last = String(pq.stdout || '').trim().split('\n').filter(Boolean).pop() || ''; const ok = pq.status === 0 && /0 failed/.test(last); if (!ok) failed++; console.log((ok ? 'PASS ' : 'FAIL ') + 'fa_sqlite（Python 的 sqlite3 相容介面）：' + last); }
console.log(failed ? '\n有 ' + failed + ' 組失敗' : '\n全部通過');
process.exit(failed ? 1 : 0);
