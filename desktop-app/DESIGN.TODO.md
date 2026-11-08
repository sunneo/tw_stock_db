# DESIGN.TODO（合併檔）

這份合併了原本分散的 32 份 `DESIGN.TODO.<名稱>.md`，內容逐字保留，各節標題為「原檔：名稱」。`DESIGN.TODO.native-runner.md` 仍單獨存在（`native-all-models` 已完成，改名為 `DESIGN.native-all-models.md`）。完成的項目請改成 `DESIGN.<名稱>.md`；需要真人驗證的另列，不算待辦。

## 2026-11-08 未完成清單（管理者彙整，以此為準；細節在各設計文件）

> 已完成的不在這裡。「待改善」＝做了但沒達標；需要真人驗證的另列，不算待辦。

### 程式 diff／patch／merge（`DESIGN.code-repair.md` 4.1／4.2，負責：diff-patcher 工作階段）
- 衝突階梯（4.2）已做縮小衝突、詞元合併、同處插入兩種順序；**沒做**：同一處兩邊都改（刻意不自動取一邊）、重複行很多時的候選品質沒量過。
- `editCode` 已吃 `patch` 參數（`code_edit_core.js`）；**還沒接**：`code_agent_core.runCode0` 與 `floating-assistant.js` 沒把使用者的修補傳進去，桌面版也沒載入語法樹 `parser` 給 `merge_patch`（`_codePatch` 沒傳 `parser`）。
- 語法樹只有 Python：docstring 防護、巢狀／同名函式只在有 `parser` 時生效（沒有時會改到 docstring 裡的範例，測試有列）。其他語言文法本機沒有，下載需使用者同意（檔名、來源、大小待回報）；C++ 模板邊界只有詞法切分，未逐一驗證。
- 離線小模型實際走 `merge_patch` 的成效沒量過（目前只有假模型）。

### 思考堆疊與離線寫程式（`DESIGN.think-stack.md`）
- 缺口 C、E 接進 `_codeOffline`（`wireOffline`，負責：code-slash 工作階段，進行中）。
- 缺口 I 只有量測骨架，沒有真模型數字。

### 多語言中間語言與函式行為（`DESIGN.core-ir.md`）
- c++、c#、ruby、perl 輸出器與樣板只有目錄，沒實跑；java／c 的「進」（抽回設計）、nodejs 反向沒做。
- 行為描述與行為卡還沒接進程式碼編輯介面（要做成 AI 可呼叫的唯讀工具）。
- 區塊轉中間語言的橋（`ir_blocks_core.js`）還沒接進 `floating-assistant.js`。
- 註解保存：行被改寫／搬動／刪除的規則已做（`a53b519b`），其餘節點類型的註解錨定待驗證。

### 矩陣與 Blockly（`DESIGN.matrix-fallback.md`、`HANDOFF.blockly-teach.md`）
- 矩陣轉 Blockly（`matrix_blocks_core.js`）沒接進產品、沒真 Electron 驗證。
- 狀態機 UML 圖種、虛擬機轉結構化自然語言的反編譯、反編譯後狀態命名。
- Blockly 教學下週待辦：多矩陣輸入形狀（銀行家演算法、分頁位址轉換）、Linux 語意模擬缺口、holdout 未解題（只量測不可教）。

### 剖析器與環境
- 內建剖析器只有 Python 文法（`renderer/vendor/tree-sitter/`）；其他語言要使用者同意後下載。
- 這台機器：C 編譯器沒設系統標頭路徑（C 實跑測試失敗，是環境問題）；awk 求和、`list-as-set` 偶爾因機器慢超時；編譯環境自動尋找已擱置。

### 介面
- Graph RAG：**已全部移除（2026-11-08）**——標題列徽章、基本系統提示的說法、`rag_lookup`／`rag_management` 兩個子任務領域、功能清冊的 `rag` 功能、語言探索領域的 `rag_query_graph`。**刻意保留**：四個 `rag_*` 工具的註冊（沒有任何領域入口，AI 看不到）、`ragSystem` 儲存層（離線訓練器查詢、語言探索「記到知識庫」仍用）。「啟用 RAG」設定項與說明文字保留（只當訓練器養分）。測試 `renderer/src/catalog/rag_removed.test.js`、實機評估 `scripts/eval/rag-removed.eval.js`。待改善：舊使用者已保存的 `ragEnabled` 設定名稱仍叫 RAG，不改名以免相容問題。


## 現況總覽（2026-11-06 快照，先看這張）

> 這份合併檔很長（32 份原檔），目錄只有標題、沒有狀態。這張表給「現在做到哪、下一步是什麼、細節在哪一節」。
> **「已核對」＝我這個工作階段實際跑過測試或真 Electron；「另一條線盤點」＝來自另一個工作階段的報告，我沒有逐項核對；舊章節（下面「原檔：…」大部分）的狀態我沒有逐一核對，不要把它當成最新。**

| 項目 | 狀態 | 下一步 | 在哪 |
|---|---|---|---|
| 寫程式：`uml_design` 讀算法題、內建的課、區塊庫、範式骨架庫 | **已核對**：不給課、只用範式骨架＋槽位窮舉＋沙盒，種子 17/17、沒見過的改寫 16/16（選項反序也 16/16）；`write_code` 已接離線組合（無模型也能做 Python 算法題）；真 Electron 逐題結果見 `STATUS.md`；**函式內部再切成步驟（2026-11-08）**：`step_split_core.js` 單元測試 14 項過，接在範式骨架／矩陣層之後，2 層、3 層題從需求到判題通過、與只切一層對照（數字見 `DESIGN.fn-template.md` 第 125 行與 STATUS） | 範式 23 個（缺回溯、圖最短路、線段樹等）；其他語言；老師迴圈對寫程式只在「離線自己重做通過」時抽課 | 原檔：block-writer、`DESIGN.ast-nodes.md` 第七節 7.3 |
| `/teacher-loop`（＝`/offline-trainer-by-ai`）的客觀驗證 | **已核對**：驗證、老師教完離線重做、回歸、回滾，真 Electron 端到端（假模型）通過 | 寫程式的離線組合接進來，才能對真任務跑 | `DESIGN.offline-trainer.md` 5.1、`scripts/e2e/teacher_loop.e2e.mjs` |
| 「萬物皆矩陣相乘」評估（矩陣＋狀態機、LALR 狀態矩陣、未知題 body→矩陣） | **評估完成＋已驗證**：DFA／min-plus／布林圖／線性遞推（BM）／CYK 布林矩陣／LALR 表矩陣＋有界堆疊／Hankel 學習，49 項測試含隨機對照與反例；種子 20 題 A3／B5／C12（A、B 各有部分只是推測）；追加：多個小矩陣＋狀態機、ReLU vs CoLU、矩陣 VM（19 種封閉指令、JSONL、8 個編譯對照；種子 20 題中矩陣指令是主角 6 題） | 是否把 state-machine／semiring-closure／linear-recurrence 範式接進範式骨架庫，由使用者決定（未動產品） | `DESIGN.matrix-algorithms.md`、`renderer/src/algo/` |
| 跨語言核心中間語言＋標準函式庫轉接層＋行為描述（python／nodejs／c／c++／c#／java／ruby／perl） | **調查設計完成＋最小驗證已核對（未進 renderer）**：語言中立程式樹、72 個標準操作（8 語言對照＋陷阱）、python 進／nodejs、java、c、python 出；python→中間語言→nodejs 10/10、java 10/10、c 8/8 實際執行且與 python 輸出一致；行為描述（第一層）由現有行為分析器抽 python／nodejs，與中間語言轉出的描述一致；測試 48＋7＋4 項。c++／c#／ruby／perl 只有目錄樣板（靜態一致、未實跑） | 先把行為描述接進 code edit（只讀、不產生程式），再做 python→nodejs／java 的完整節點樹產生；需使用者決定的事見文件第 6 節 | `DESIGN.core-ir.md`、`renderer/src/ir/` |
| **進 renderer 的對照（2026-11-07，一眼看哪些真的在使用者端）** | 規則：每份設計文件在這張表都要有一列，寫「進 renderer？」與「下一步」；沒進 renderer 的不算完成 | — | 下面幾列 |
| Blockly 範式骨架＋讀取器（Linux 工具題、位元／位元組積木 35 個、欄位表範式、校驗碼、LZ77／霍夫曼） | **已進 renderer（v312、v313；v314 待發）**：Linux 64 題離線 0/64 → train 37/37、holdout 21/27（無模型）；原 60 題 59/60；核心 208/208、真 Electron 20 題種子 20/20 | v313 誤發了半成品（DSP／huffman 退步），`73deb981` 已修，等工作樹乾淨發 v314 | `DESIGN.blockly-gaps.md`、`DESIGN.blockly-gap.md`、`DESIGN.blockly-curriculum.md` |
| Blockly 教學範本總表（演算法／資料結構／作業系統／真實 Linux programming） | **設計＋總表完成，資料結構／作業系統／Linux programming 領域包還沒開工**（並行 session 被使用者擋下） | 依總表優先序逐領域做領域包（一個領域一個檔，train／holdout 分開），小批次提交＋發布；G2 切割模板、G6、G18、思考堆疊／CoLU 缺口檢查 | `DESIGN.blockly-curriculum.md`、`HANDOFF.blockly-teach.md` |
| 領域包 sync（同步原語事件模擬：信號量／互斥鎖／條件變數／生產者消費者，`domain_sync_core.js`） | **提交後等發布才進 renderer**：train 16/16、holdout 3/4；`algo_intent_core.js` 兩個輸入形狀小修。接續點（銀行家／多矩陣輸入、diff／join、檔案系統、進階圖樹、Linux 語意模擬、思考堆疊 D／F／H）見 `HANDOFF.blockly-teach.md` §3b | 
| 領域包 algo2／os／ds／linuxtext（Blockly 教學範本，`DESIGN.blockly-curriculum.md` §3） | **已提交、等發布才進 renderer**：algo2 train 30/30、os 22/22（holdout 4/5）、ds 24/24（holdout 4/5）、linuxtext 28/28（holdout 4/5）；Linux 題庫 37/37、21/27、原 60 題 59/60、核心 212/212、Electron 20/20 | 發布後在使用者端；下週續補：多矩陣輸入形狀（銀行家／位址轉換）、diff／join（兩段輸入）、同步原語、檔案系統、進階圖樹、真 Linux 語意模擬（fd／pipe／信號／socket）；思考堆疊缺口 C／E／F／I（`DESIGN.think-stack.md` 末節） | `DESIGN.blockly-curriculum.md`、`HANDOFF.blockly-teach.md` |
| 領域包 DSP | **已進 renderer**：18 題種子，float 容差判題 | — | `DESIGN.block-domains.md` |
| 矩陣層後備 `matrix_synth_core`（敘述＋範例合成） | **程式在倉庫、測試過，但 renderer 沒接**：`FaMatrixSynth` 不在 `floating-assistant.js`，`buildFromUML` 的 `o.Matrix` 沒人傳，使用者端沒有作用；stevenyc 那邊正在接宿主（未提交） | 接宿主（embed 清單、`_codeOffline` 傳 `Matrix`、`write_code` 標示層級與 `verified:false`）、真 Electron、發布；之後邊表輸入形狀＋L3 半環範本（預期多解 8～10 題） | `DESIGN.matrix-fallback.md`、`HANDOFF.matrix-fallback.md` |
| 矩陣層的實際價值 | **已量（保留題庫 48 題，沒教過）**：Blockly 17、加矩陣層 21，只多解 4 題；60 題基準已被教過，只能當回歸 | 看接線後與補形狀／範本後的增益 | `DESIGN.matrix-fallback.md` §9 |
| 各領域矩陣化可行性與缺口（資料結構、作業系統、Linux、演算法） | **只是評估＋4 個實測，沒進 renderer**：純計算部分表達得出來；缺 Mealy 轉換器、GF(2)、位元級 IO、關聯記憶體／指標堆、輸入形狀前端、由規格合成 | 交給 stevenyc 那邊的矩陣 session | `DESIGN.matrix-fallback.md` §12 |
| 矩陣 → UML／Blockly（支援 code edit） | **Blockly 部分：純模組做完＋測試（2026-11-08）**：`renderer/src/algo/matrix_blocks_core.js`（`decompile`／`compile`／`cnl`／`readForm`／`setForm`／`setCompose`），題庫 74 題中合成成功 71，區塊編回 Python 後測資輸出 71/71 與原程式一致（與題庫預期輸出也 71/71 相同），通用「程式」區塊只佔 0.7%（10/1348）；DFA／遞推（含取模）／圖／格子／方陣／組合層都有分段，DFA 轉移表與接受集、遞推係數與初值與取模、組合層三段積木可在區塊上改且輸出照新形態；**還沒接進 `floating-assistant.js`（別的 session 正在改該檔）、沒有真 Electron 驗證**；UML 圖種（狀態機圖）未做、VM／ReLU 沒有 | 接線（embed 清單＋MATRIXBLOCKS 標記＋code edit 入口顯示分段）與真 Electron 打通一題；狀態機 UML 圖種 | `DESIGN.matrix-fallback.md` §11.5c |
| 備援第三層（上網找答案、湊 CoLU、待補教學佇列） | **只有介面設計（§10），沒實作**；`catalog_discover` 探索端已實作 | 介面實作；網頁搜尋需開子 agent，SourceForge／CodeProject 常 403 | `DESIGN.matrix-fallback.md` §10、`DESIGN.unit-catalog.md` |
| 交接文件索引（**別的 session 要接手，先讀這列**） | **協調／發布**：`HANDOFF.coordinator.md`（發布流程、驗證清單、使用者原話、陷阱）；**Blockly 教學**：`HANDOFF.blockly-teach.md`＋`DESIGN.blockly-curriculum.md`（可跨帳號冷啟動）；**矩陣**：`HANDOFF.matrix-fallback.md`（寫給 stevenyc.huang 的 session）；舊的 `HANDOFF.blockly-teach.md`（Blockly 教學）、`HANDOFF.matrix-fallback.md`（矩陣，已寫成給 stevenyc 冷啟動）、`HANDOFF.matrix-algorithms.md`／`HANDOFF.block-writer.md`（已完成，僅供查）、`HANDOFF.edit-remote.md`（別條線） | — | 各檔 |
| 發布 | **已核對**：patch v313（桌面版）；網頁版沒同步（這台機器找不到 `videos-嗨投資`）；發布前要確認 renderer／scripts／web-lazy 工作樹乾淨（`publish.sh` 會 `git add -A`） | 要同步網頁版請給 repo 路徑 | `DESIGN.release.md` |
| 核心測試 `tray_dialog.test` 整組失敗 | **已核對**：根因是最後一行 `N checks passed` 不符合跑器的 `N passed`，已改輸出格式 | — | `scripts/main-tests/tray_dialog.test.js` |
| JSONL／JSONC 檢視器 | **已核對（2026-11-06）**：在真瀏覽器頁面載入 `data_ui.js`，15 萬行 JSONL：Source 捲到 14 萬行、Viewer 一批 2 萬筆可前後翻、匯出整份 JSON 17 MB；超大檔批次視窗已做 | Electron 對話區塊裡的畫面沒另外看（同一份程式） | `DESIGN.jsonl-paging.md` 第八、十節 |
| 思考堆疊「兄弟一致性」 | **已核對（2026-11-06）**：真 qwen3-0.6b，16 組成對（4 個有效情境）：有標頭一致性 1.00 vs 無 0.99（風格 1.00 vs 0.89），較好 5／較差 0／持平 11；額外檢查沒有更好；完成率與一次合格率沒有可分辨的差別（member 情境因評測設定問題無效）。生 0.6B 連參與者階段都過不了，所以前兩階段由程式回答 | 還沒量：CoLU 計畫階段／`chooseTool` 路由、開思考、不同溫度 | `DESIGN.think-stack.md` 最後一節 |
| `browser_get_page_text` 長頁面章節索引 | **已核對（2026-11-06）**：用真 Chrome 156 跑擴充功能的 `pageTextExtractor`，抓到真 bug（擴充功能回 `total_length`，程式只認 `total_chars`，長頁面永遠不分層），已修並用真輸出做回放測試 | 擴充功能連線層端對端沒跑過；擴充功能不回 `title`／`url` | `DESIGN.jsonl-paging.md` 第十節 |
| JSONL 分頁的舊待改善 | **已做（2026-11-06）**：`_page`＋`offset`（`knowledge_ask`、`repo_map` 清單、`repo_ask search`）、頁數預估（`pages_left`＋帳本提醒放得下幾頁）、4096 小窗口改 token 預算（中文不再低估 3 倍）、超大檔批次視窗；真 Electron 評估通過 | `repo_read_doc`／`repo_sql` 的 `_page`；沒用真 4096 小模型跑完整問答 | `DESIGN.jsonl-paging.md` 第十節 |
| `docs/HANDOFF.md` | 另一條線盤點：開頭停在 v299、待辦過期、後面補了很多段，不適合當起點頁 | 整理成一頁起點（版本、現況、下一步），歷史段落往後放 | `docs/HANDOFF.md` |
| merge diff patcher（unified diff → 合併進使用者目前的程式，`code_patch_core.js`、工具 `merge_patch`） | **提交、等發布才進 renderer**：node 測試 64 項；diff3 對照 git merge-file（無重複行隨機 800 組逐字一致；大量重複行 400 組只 356 組一致，已寫明）；真 Electron（nodejs）使用者編輯過＋修補→合併驗證 AC、語法壞／答案錯／衝突回滾、重複套用 no-op；python 的真 Electron 判題這台跑不了 | 衝突自動解（4.2）、接進 editCode、改用 tree-sitter 語法樹定位 | `DESIGN.code-repair.md` 4.1 |
| 其他（函式內部再切步驟、套件／類別層接 `design_core`、以樹為基礎的修復、其他語言） | 未做 | 見各文件「還沒做」 | `DESIGN.code-repair.md`、`DESIGN.fn-template.md`、`DESIGN.ast-nodes.md` |

## 目錄

- 原檔：aidoc-locator-port
- 原檔：block-writer（程式區塊寫程式）
- 原檔：cad-sheet
- 原檔：chat-subsessions
- 原檔：coding-patch-ci
- 原檔：colu-thinking
- 原檔：completion-verification
- 原檔：edge-tts-gec
- 原檔：edit-picture-sdturbo
- 原檔：edit-svg-picture-3d
- 原檔：gui-bridge
- 原檔：harness-skill
- 原檔：image-to-3d
- 原檔：lazy-loading
- 原檔：manager
- 原檔：multi-chat
- 原檔：music
- 原檔：nvim-wasm
- 原檔：path-experience
- 原檔：project-index-html
- 原檔：read-ledger
- 原檔：safe-self-upgrade
- 原檔：subchat-s1
- 原檔：subchat-s2
- 原檔：subchat-s3
- 原檔：subchat-s4
- 原檔：subchat-s4b
- 原檔：subchat-s5
- 原檔：subchat-s6
- 原檔：subchat-s7
- 原檔：subchat-s8
- 原檔：subject-research
- 原檔：topic-switch


---

## 原檔：aidoc-locator-port

# 交接文件：讓 floating-assistant 的 AIDoc 跟上 Redmine 外掛的「除錯定位器」（handoff 1，2026-10-29）

## 1. 開場提示（給接手的工作階段）
Continue from the handoff document at `D:\Downloads\videos-嗨投資-desktop-app\desktop-app\DESIGN.TODO.aidoc-locator-port.md`. 先完整讀完（含使用者原話與做法備忘），照做。執行 low-context-long-run 技能（門檻 30%）：做 Todo 的第一項，context 到門檻就更新這份文件並啟動你的接手工作階段。第一則訊息用一行說明你讀完了、要開始哪一項。回覆一律繁體中文、不要夾英文縮寫。

使用者的關鍵指示（逐字）：「我要請你改的不是redmine, 是讓我們floating-assistant的AI跟上aidoc的修改」、「我是給你資料，讓你跟上!」、「含中文的句子也可能是有log，這部份請在裡面建立domain/subagent跟tool/recipe」。

## 2. 概況
- 目標：把 Redmine 外掛 `D:\Downloads\redmine_ai_chat` 的 AIDoc「除錯定位器」（設計見該資料夾 `DESIGN.aidoc-locator.md`；程式在 `assets/javascripts/ai_chat_aidoc_{trace,elf,sql,worker,viewer}.js`、`ai_chat_aidoc.js` 的 `locate`（765–945 行）、`test/aidoc/*`）移植到本專案（桌面版＋網頁版共用的 `renderer/src/floating-assistant.js`）。分支 `desktop-app`，工作目錄 `D:\Downloads\videos-嗨投資-desktop-app\desktop-app`。
- **已提交**：`AIDoc 除錯定位器移植（一）`——`renderer/src/aidoc/trace.js`、`elf.js`（UMD，全域 `FaAidocTrace`／`FaAidocElf`，`scripts/embed-code-ui.js` 的 `embedAidoc()` 嵌入）、測試 `scripts/aidoc-tests/{trace,elf}.test.js`（trace 67 項過；elf 需要 Linux 的 gcc／addr2line，這台 Windows 沒跑＝未驗證）。
- **已改、尚未提交、尚未跑測試**：`renderer/src/sql/index_core.js`（schema 1→3：表 `logmsgs`、`calls_raw`→`calls`、meta `tree_ref`；builder.addFile 吃 `rec.logs`／`rec.calls`；finalize 收 `o.treeRef`；reader 新增 `schemaVersion／hasTable／treeRef／filesByName／logCandidates／callers`）、`scripts/sqlite-index.itest.js`（新增「除錯定位器（schema 3）」測試）。**接手第一件事：跑這個測試**（要 Electron 當 Node：`ELECTRON_RUN_AS_NODE=1 <scratchpad>/el_test/app/FloatingAssistantApp.exe scripts/sqlite-index.itest.js`；使用者上一次拒絕了我直接執行這條，**先問或改用別的方式**），通過再 `node scripts/embed-code-ui.js` 把 index_core 重新嵌進主程式，然後提交。
- 沒部署、沒發布。Redmine 資料夾我誤改過（`ai_chat_aidoc_viewer.js`、`aidoc-viewer.html`、`test/aidoc/ask_trace_e2e.js`、三份文件），使用者說改錯對象；**不要再動 Redmine 資料夾**，是否還原問使用者。

## 3. Todo（依序）
0. （2026-10-29 更新）索引測試已不再被拒絕（先前是誤觸），可直接用 Electron 當 Node 跑；`mcp__ccd_session__start_session` 現在可用（要先 ToolSearch 載入，不是沒有這個工具）。此項以下的舊說明已過時，實際進度看文件最後的「進度」一節。
1. （已完成 2026-10-29：index 測試 6 項全過，已嵌入）
2. 建索引時抽 log 與呼叫邊：`floating-assistant.js` 的 `_faRepoExtract(path, text, opts)`（約 3939–4127 行）回傳值加 `logs: FaAidocTrace.extractLogs(text, lang)`、`calls: FaAidocTrace.extractCalls(text, lang, symbols)`，`sv` 升到新抽取版本；`_repoMapPutFile` 的記憶體地圖與 `ctx.sqlB.addFile` 傳下去（約 59033、59876 行）；續建時舊 `sv` 的檔案自動重新分析（約 59661 行，比照 cs 的做法）；`tree_ref` 由 `.git/HEAD`（含 `packed-refs`）讀出，傳給 `builder.finalize({treeRef})`。
3. 主機 `locate`（對照 Redmine `locate`／`locateChains`／`locateMessages`／`locateText`）＋ `repo_ask` 新動作 `locate`／`callers`／`check_citations`（`_repoAskRun`，約 58164 行）＋ `/aidoc locate [--elf…]`；工具說明文字用中文引號，不要反引號 code span。
4. 檢視器自由提問：`renderer/src/aidoc-viewer.template.html` 的提問框改多行（Enter 送出、Shift+Enter 換行、Ctrl+Enter 問 AI）；兩處 `/api/ask`（約 56263、58110 行）先走 `locate`，AI 只說明（發生點／什麼問題／誰造成），回答後 `FaAidocTrace.checkCitations` 核對。可參考我在 Redmine 做的 `traceTextOf`／`runTraceAsk`（`ai_chat_aidoc_viewer.js`）。
5. **含中文的句子也可能是 log**（使用者要求）：不能用「含 CJK 就是使用者的話」。做法＝以索引當裁判（索引的 log 格式字串逐字比對，沒對上就不顯示、不吵）＋ `trace.js` 的 `isMessageLine`／`extractLogs` 接受中文固定文字（會改索引內容，要再升抽取版本與 migration）＋ 建 domain（`code_debug`）、subagent（`log_triage`：封閉選擇題 A=使用者的話／B=log／C=堆疊，程式驗證）、tool（`log_triage`）、recipe（離線小模型版，參考 `DESIGN.recipes.md` 的概念與本專案 `renderer/src/recipe/`）。
6. 測試、`node scripts/embed-code-ui.js && node build-assistant.js`、測試版驗證（`scratchpad/el_test/deploy3.sh`）、補 `features/ai-features.yaml` 清冊、文件、發布（`PUBLISH_TRAILER="Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" bash scripts/publish.sh -m "…"`，只在使用者說「發布」時）。

## 4. 做法備忘（使用者的規則）
- 繁體中文、結論先說、不要在中文裡夾英文縮寫；做完誠實說哪些沒驗證。
- 改來源模組（`renderer/src/aidoc/*.js`、`renderer/src/sql/index_core.js`），再 `node scripts/embed-code-ui.js && node build-assistant.js`；不要改嵌入後那份。
- 資料庫結構或記憶格式有改，必須定義版本與 migration（舊索引能讀、定位器明講「請重新建立索引」，新建一律新版）。
- 編譯前會清工作目錄：做到一半也先 commit。給了順序就做到底，不要中途問「接著做哪個」。
- 熱更新名單別擴大（使用者否決過）；不要要求使用者重裝。

## 5. 使用者原話（逐字，2026-10-29）
- 「redmine這邊aidoc有加強trace (backtrace)與自由詢問的能力，例如給一包code, 在aidoc給一個自由提問的視窗，我們可以問他exception的發生點在哪，是什麼問題，某個錯誤訊息是誰造成的」
- 「我要請你改的不是redmine, 是讓我們floating-assistant的AI跟上aidoc的修改」
- 「我是給你資料，讓你跟上!」
- 「所以你不應該沒有任何修改!」
- 「你剛改錯對象?」
- 「含中文的句子也可能是有log，這部份請在裡面建立domain/subagent跟tool/recipe」
- 「更新網頁，發布patch」（標準發布指令）；「你不知道要呼叫subsession?」；「現在這個對話的context多大了 ？！」

## 6. 交接流程（自我遞迴）
執行 low-context-long-run 技能：每個批次邊界用 `mcp__ccd_session_mgmt__get_usage` 看 context，≥30% 就更新本文件、提交、用 `start_session`（fresh）啟動接手，確認後 `mark_completed`＋`archive_session`。`start_session` 是延遲載入的工具，先用 ToolSearch（query 為 select:mcp__ccd_session__start_session）載入再呼叫，不是沒有。

## 7. 陷阱
- shell heredoc／Python 字串裡的反斜線與引號會被吃掉或弄亂（`\n` 變真換行）；改檔用 Edit／Write 工具，需要換行字元用 `chr(10)`。
- `scripts/embed-code-ui.js` 是 CRLF 檔；Edit 後要統一行尾。
- 這台 Windows 的 Node 沒有 `node:sqlite`，資料庫整合測試要用 Electron 當 Node。
- 使用者曾拒絕我直接執行 `FloatingAssistantApp.exe` 跑測試的指令。

## 進度（handoff 3，2026-10-29，Sonnet 5.5）
- 已完成並提交：index 測試 6 項過；建索引抽 log／呼叫邊（sv 5）與 tree_ref；repo_ask 的 locate／callers／check_citations；/aidoc locate／callers；檢視器多行提問框與先定位後說明；中文 log；log_triage 工具＋FaLogTriage 食譜（測試 13 項）＋ code_debug 子代理 domain；清冊 aidoc-locator。
- **未驗證**：主機端 _repoLocate／檢視器端到端／log_triage 工具在桌面版實跑；ELF（/aidoc locate --elf）尚未移植（elf.js 只有純函式模組，沒接主機）；測試版驗證（deploy3.sh）未做。

---

## 原檔：cad-sheet

# TODO：CAD 風格工程圖還沒做的（設計缺口）

設計見 DESIGN.cad-sheet.md。

- **真正的多視角**：目前每個零件只有「平面外形＋厚度側視」。三視圖（前／側／上）、剖面圖（指定切面）、局部放大圖還沒有。
- **爆炸圖只有「層疊側視」**：沒有等角（isometric）爆炸圖；不是層疊的組裝（榫接、插入、貼在側面）只能用文字步驟說明，圖上沒有零件之間的位置關係。
- **外形種類只有 5 種**：沒有任意曲線（貝茲路徑）、沒有斜邊梯形的快捷（可用 polygon 湊）、琴頭（卷軸）、F 孔這種有機形狀只能簡化成矩形或多邊形。
- **尺寸標註只標外形與孔槽**：沒有公差、沒有基準面、沒有零件之間的間距尺寸、沒有角度標註與半徑標註。
- **規格由模型列出時，尺寸是否合理（榫槽對得上、零件放得進總尺寸）沒有程式檢查**：目前只檢查格式與範圍。

---

## 原檔：chat-subsessions

# 話題偵測與子對話：唯讀調查與設計草案

> 狀態：調查結果（步驟 1–4 有事實依據）＋設計草案（步驟 5，**草案不是結論**）。
> 本文件不改任何程式。行號以 `renderer/src/floating-assistant.js` 為準（以下簡稱「主檔」），工作目錄 `desktop-app/`。
> 「真桌面版量測」＝ `scripts/eval/send_latency.eval.js` 在真 Electron 內跑的結果；「讀程式」＝只看原始碼推測；「沒查」＝未確認。

---

## 0. 摘要（一頁看完）

1. **每則訊息都等的那一步是 `_checkTopicTransition`**（話題過渡判斷）。它在 `executeChat` 裡 `await` 一次主模型呼叫（主檔 102549），而且是**在使用者訊息寫進對話之前**就等。第 3 則訊息起（對話訊息數 ≥ 3，見 95873）每一則都會呼叫一次模型；若判成話題轉移，還會再多一次摘要呼叫（95964）。
2. 「engagement／RAG 話題」的殘留已經不在送出路徑上：RAG 的 `ragSystem.query` 不在送出前呼叫（主檔 102563–102564 的註解與程式確認）。意圖過濾（`_routeTaskIntent`）也不在送出路徑上，它只在模型呼叫 `delegate_to_subagent` 之後才跑（104400–104414）。
3. 子對話目前是「**沒有獨立對話記錄的委派**」：`_runSubAgentTask` 用函式內的區域訊息陣列，結果當成工具結果回到父對話；進度卡片是父對話裡一則 `role:'tool'` 訊息（78104–78106）。沒有子對話的 ID、父子欄位、獨立 UI。
4. 對話清單（側欄）已存在且有索引（`_chatIndex`，79557–79577），但**索引裡沒有 parent／child 欄位**，全專案 grep `parentId|parent_id|parentSession|childSessions` 只命中無關的動畫與 3D 程式碼。
5. 真桌面版量測：假模型立即回覆，第 2 則（換話題）比第 1 則多出一次話題判斷＋一次摘要呼叫，耗時 39.2ms（假模型幾乎零延遲，真實環境的代價＝真實模型往返時間）。第 3 則（拉回）也有一次話題判斷呼叫（17.3ms）。

---

## 1. 步驟 1：送出到第一次呼叫主模型之前的前置步驟

入口：`executeChat(userText)`，主檔 **102415**。被呼叫處：`_chatRunner(ctx).executeChat`（遠端 102415 附近的其他入口見 `remote/rg_dispatch.js:822`、主檔 100133 的送出按鈕路徑）。

| # | 步驟 | 函式／行號 | 呼叫模型？ | 網路？ | 可否關閉／設定開關 | 備註（量測＝真桌面版，讀＝讀程式） |
|---|---|---|---|---|---|---|
| 1 | 還在回應中？變成「插話」(steering)，直接 return | 102416–102419 | 否 | 否 | 無 | 量測／讀：正在回應時送出不走以下步驟 |
| 2 | 重設本輪旗標（寫入證據、帳本、意圖、工具紀錄等） | 102437–102445 | 否 | 否 | 無 | 讀 |
| 3 | 取得主力模型設定 `_getInitialFallbackConfig` | 77194（呼叫 102446） | 否 | 否 | 無 | 量測：0.0–0.3ms |
| 4 | 更新標題的模型名、`_setRespondingState(true)` | 102449–102468 | 否 | 否 | 無 | 讀 |
| 5 | **原生工具呼叫探測** `_ensureNativeToolSupportProbed` | 102475–102477（定義 77695–77716） | 只有快取沒命中且不在內建表時才會打一次探測請求 | 首次可能 | `advancedSettings.toolCallMode`：`native`／`text` 會跳過；內建表 `PRESET_MODEL_TOOLCALL_SUPPORT`（48779）命中就不打網路；結果存 localStorage | 量測：第 1–3 則都只花 0.3ms、沒見探測請求（快取或內建表命中；本次未驗證是哪一種） |
| 6 | **話題過渡判斷** `_checkTopicTransition` | 102549（定義 95871–約 96010） | **是，阻塞式**：訊息數 ≥ 3 時每則一次（95912）；判成轉移再一次摘要呼叫（95964） | 是 | **沒有設定開關**（沒查到；只能在評估檔覆寫） | 量測（見第 2 節）：第 2 則 39.2ms（判斷 ＋摘要），第 3 則 17.3ms。注意：在使用者訊息 push 進 `this.messages` 之前（102576），所以訊息在畫面上要等它回來才出現（讀） |
| 7 | 話題判斷失敗就靜默 return（非 ok、解析不了 JSON 都 return） | 95927、95932 | — | — | — | 讀 |
| 8 | 停止旗標檢查 | 102550 | 否 | 否 | — | 讀 |
| 9 | 外部 `contextProvider` 注入 `[Live Context]` | 102522–102532 | 否（同步） | 取決於外部 | 由宿主提供 | 讀；沒查 provider 內容 |
| 10 | 過濾掉舊的 `[Hermes 歷史記憶喚醒]` 訊息 | 102562 | 否 | 否 | 無 | 讀：只是過濾，不查 RAG |
| 11 | RAG 查詢 | 送出路徑上**沒有**（102563–102564 註解：2026-10-15 起 RAG 不再自動插入） | — | — | `advancedSettings.ragEnabled` 只影響其他路徑（59525、66427、99449、81906） | 讀（grep 102549–102583 之間無 `ragSystem.query`） |
| 12 | 命令歷史寫 localStorage | 102567–102571 | 否 | 否 | 無 | 讀 |
| 13 | 超長貼上文字截斷 `_truncateToolResultForContext` | 102575 | 否 | 否 | 無 | 讀 |
| 14 | 寫入使用者訊息、重新繪製 | 102576–102577 | 否 | 否 | — | 讀 |
| 15 | 進入主迴圈 `_loopFetch` → 原生分流 `_shouldUseNativeToolCalls` | 102583；102637–102646 | — | — | — | 讀 |
| 16 | 每一輪送出前修配對 `_sanitizeToolCallPairing` | 103265 | 否 | 否 | 無 | 讀 |
| 17 | **第一次主模型呼叫** `FaLlm.fetch` | 103279 | **是（主模型）** | 是 | — | 量測：第 1 則 21.4ms 後出現；第 2 則第一個呼叫是話題判斷（0.7ms），主模型在 44.8ms；第 3 則主模型在 20.3ms |
| 18 | 工具清單根層過濾 `_getRootToolNames` → `_intentFilter` | 74735；過濾本體 75596–75611 | 否（純本地詞彙比對） | 否 | `multiSubAgentMode === 'intent'` 才啟用（75595） | 讀；**沒查**是否逐行由 `_getRootToolNames` 內呼叫 `_intentFilter`（只看到函式本體與開關） |
| 19 | 意圖路由 `_routeTaskIntent` ／ `_intentRouteLocal` | 75629–75645 | 路由失敗才走 `_routeTaskToDomains`（會呼叫模型） | — | `multiSubAgentMode === 'intent'` | **不在送出路徑上**：只在 `_delegateToSubagentAutoOnce` 裡（104412–104414），也就是模型已經呼叫 `delegate_to_subagent` 之後 |
| 20 | 能力反思（「叫用 RAG 之後的能力反思」） | 75654 註解；75696 | 沒找到呼叫點 | — | — | 只找到註解，**判定不在送出路徑上**（沒有呼叫點，只靠 grep 判斷） |
| 21 | 歷史壓縮 `pruneContext` | 只在 400／413 之後的反應式路徑（102534–102543 註解） | 是（但不是送出前） | 是 | — | 讀；**沒查**完整呼叫點清單 |
| 22 | 離線訓練器、離線退路 | 102585 之後，只在第一個模型失敗之後 | 否（送出前） | — | `offlineAutoFallback` | 讀 |
| 23 | 記憶（Hermes）、Memory、摘要以外的分類器 | **沒查** | — | — | — | 只查了 `_routeTaskIntent／_intentRouteLocal／_loopFetch(Native)／executeChat／_checkTopicTransition`、RAG 查詢點、`classify／detect／judge` 等名稱中的一部分 |

**結論**：送出前真正會**阻塞、呼叫模型**的只有第 5（首次探測）與第 6（話題判斷）。第 6 是每則訊息都會發生的那一個。

---

## 2. 量測結果（真桌面版）

檔案：`scripts/eval/send_latency.eval.js`（新增，見 commit）。執行：`node scripts/eval/run_eval.js scripts/eval/send_latency.eval.js`。輸出：`[eval-file] result`。
`loadedScripts` 指向工作目錄 `renderer/floating-assistant.js` 與 `renderer/bootstrap.js`。

| 訊息 | 內容 | 話題判斷（阻塞） | 摘要呼叫 | 主模型第一次呼叫（自送出起算） | 全部耗時 | 模型呼叫序列 |
|---|---|---|---|---|---|---|
| 1 | 幫我畫一張貓的圖 | 0.3ms（訊息數 < 3，直接 return，**沒打模型**） | 無 | 21.4ms | 36.7ms | 主模型 |
| 2 | 幫我創作一首音樂（換話題） | 39.2ms（**打模型**，判成轉移） | 有（8.4ms 起） | 44.8ms | 48.0ms | 判斷 → 摘要 → 主模型 |
| 3 | 再畫一張狗（拉回） | 17.3ms（**打模型**，判成沒轉移） | 無 | 20.3ms | 40.1ms | 判斷 → 主模型 |

所有 `err` 皆為 `null`。假模型延遲約 0，所以上表的毫秒數只反映**本機的呼叫鏈開銷**；真實環境每一次模型呼叫會多出真實往返時間。以第 2 則為例，真實環境會等 **兩次**模型往返（判斷＋摘要）才看到使用者訊息，之後才等主模型。

量測說明：
- 只在評估檔裡包裝（`wrapAsync`／`wrapSync`），沒有改來源。
- `_ensureNativeToolSupportProbed` 量到 0.3ms，沒看到探測請求；本次沒分辨是快取命中還是內建表命中。
- 假模型用 `body.messages[0].content` 的特徵字串分辨三種呼叫（判斷、摘要、主模型），這是評估檔內的做法，不代表來源的結構。

---

## 3. 步驟 3：現有「子對話」機制盤點

| 機制 | 位置 | 資料結構 | 存在哪 | 獨立對話記錄／UI？ | 狀態表示 | 等待使用者時怎麼冒泡 | 結果怎麼回主對話 | 能否被使用者打開來看 |
|---|---|---|---|---|---|---|---|---|
| `delegate_to_subagent`（工具） | 主檔 `_delegateToSubagentAuto` 104400；`_delegateToSubagentAutoOnce` 104407；`_delegateToSubagentDomain` 103751／`Inner` 103755 | 工具參數＋`domain`；領域定義在 `this.domains`（`register_domain`） | 記憶體（`this.domains`） | 否：沒有獨立記錄 | 進度卡片（見下） | **沒查清楚**子 agent 能否叫出 `ask_user_card`（工具登記在 61059，不知是否在子 agent 允許清單內） | `subResult` 當成工具結果（104451–104458） | 只能看父對話裡的進度卡片 |
| `_runSubAgentTask` | 主檔 104572（迴圈本體約 104600 以後） | 函式內區域變數（訊息陣列、重試計數、`groupIndex` 等，104596–104609） | 記憶體，函式結束即丟 | 否 | 回傳 `{ text, … }`（呼叫端讀 `.text`，見 105311） | 沒查 | 回傳值 | 否 |
| 進度卡片 `_createSubagentProgressWidget` → `_createProgressWidget` | 主檔 103707–103710；78096–78109 | `{ role:'tool', content:'' }` 並以非列舉屬性 `_progressWidget` 夾帶狀態（title／pct／status／done／error／trace）（78103–78105） | **父對話的 `this.messages`**（78106） | 只是父對話的一則訊息 | `done`／`error`／`status` 欄位 | 不冒泡（它本身就在父對話裡） | 不適用 | 會在畫面上顯示；只有 `showInternalTrace` 為真或 `force` 時才建立（103708） |
| 批次子任務 `runBatchSubAgents` | 主檔 105273 起 | 項目陣列＋併發數（上限 8，105276–105278） | 記憶體 | 否（78456 註解：子任務有自己獨立、用完即丟的訊息陣列） | 沒查完整 | 沒查 | 回傳結果陣列（沒查確切結構） | 否 |
| 技能包／deck 委派（domain 的 `skill_` 前綴） | 主檔 103772–103807 | 同上，`isSkillDomain` 有額外的 Python 橋接深度（103778） | 記憶體 | 否 | 同上 | 沒查 | 同上 | 否 |
| 遠端需求（別台機器交過來的需求） | `remote/rg_dispatch.js:822`；主檔 53458–53463 | 不是子 agent：**會在側欄新增一個對話**（第一則訊息記來源） | 對話索引（第 4 節） | **是**（側欄一個新對話；嵌入式網頁版則把內容包成可展開的框，53463） | 對話的 `running`（53564） | — | 回到那個對話 | 是 |
| 範本 `ask_user_for_input`／表單 | 主檔 78215–78221（說明區） | 表單 `{title, description, choices, fields}` | 畫面 | 不適用 | 等使用者回答 | 直接跳表單（host 端） | 回答當作工具結果 | — |

**對照子對話的需求**（使用者要的是「真的開子對話、可監控、完成或需要使用者回應時往父對話冒泡」）：現有機制**沒有**子對話的 ID、沒有獨立記錄、沒有狀態欄位（只有進度卡片的 `done`／`error`）、沒有「等待使用者」的冒泡路徑（沒查到子 agent 的等待機制）。

---

## 4. 步驟 4：對話（session）本身

| 項目 | 位置 | 內容 |
|---|---|---|
| 索引讀取、建立預設對話 | `_chatListInit` 79553–79577 | `idx = { version:1, currentId, sidebarCollapsed, groups:[], chats:[…] }`（79558） |
| 索引的對話欄位 | 79568 建立時：`{ id, title, groupId, createdAt, updatedAt }`；79687／79697：`touched`（79684 註解）；53564：`shared`；79857：`remote`（`{ fromName, at }`） | **沒有 `parentId`／`childIds`／`kind` 之類欄位** |
| 群組 | `idx.groups`（79574）、`_chatNew(groupId)`（79679） | 群組只是分類，不是父子關係 |
| 新對話 | `_chatNew` 79679；「空對話不重複建立」規則 79683–79697 | 目前對話若沒用過（`!touched` 且沒有內容）就不再建立 |
| 切換對話 | `_chatSwitch` 79668 | 會把舊 ctx 存起來、載入新 ctx |
| 對話 ctx 容器 | `this._chatCtxs = new Map()`（56303）；`this._activeCtx` | 每個對話一個 ctx 物件（messages、archivedDisplayBlocks、topicData、isResponding 等，見 53678、53564） |
| 存放後端 | `_chatBackend()` 79409–79431 | 有 `window.desktopAPI.chats` 就用 `kind:'files'`（api.readIndex／read／write／delete）；否則 `FileCache('FloatingAssistantChats_<suffix>')`（79420）以 `chat-index` 與 `chat:<id>` 為鍵（79426–79427）。**沒查 `FileCache` 底層是否為 IndexedDB**（有 IndexedDB 的程式碼但不確定是不是它） |
| 每個對話的存檔內容 | `_persistChatHistory` 約 106430–106445 | `messages`、`archivedDisplayBlocks`、`topicData`、`terminalMap`、`progressMap`、圖片與推理的 map |
| 載入（非清單模式） | `_loadPersistedChatHistory` 106448 起；`localStorage` 鍵 `floating_ai_chat_history`（56354） | 清單模式（`options.chatList`，56300）時不從 localStorage 載入（106451） |
| 側欄清單呈現 | 79857（列項目、`cl-title`）、79864（依建立時間排序，不因點擊跳動） | 側欄只讀索引 |
| 遠端／分享對話的唯讀狀態 | 53564（`shared`）、53678（回傳 `running`） | `running: !!ctx.isResponding` |

**結論**：對話與對話之間目前是**平的清單**（只有群組），沒有 parent／child。若要做子對話，需要在索引加欄位（例如 `parentId`、`fromTurn`、`status`），並在 `_chatCtxs` 旁邊維持「父→子」關係。

---

## 5. 步驟 5：設計草案（意見，不是結論）

### 5.1 (a) 不要每則訊息都等（偵測改成本地、非阻塞）

- **要改的現有函式**：
  - `executeChat` 102549 的 `await this._checkTopicTransition(userText);` → 改成同步的本地判斷（不 await 模型），或把判斷移到送出之後、與主模型**並行**。
  - `_checkTopicTransition` 95871–約 96010：把「呼叫模型判斷」拆出來；本地版本只做關鍵詞／詞向量相似度，回傳 `{ isShifted, score, matchedTopicId }`。模型判斷改成背景的「校正」，不擋送出。
- **需要新增的資料**：每個對話存一個輕量的「話題指紋」（例如關鍵詞集合或向量，存在索引或對話存檔裡）；`topicData` 已存在（`currentTopic`），可以擴充（`topicData` 出現在 106430 附近的存檔）。
- **風險**：
  - 本地判斷的準確度會低於模型，誤判時的代價要定（誤判成轉移會開出多餘的子對話；漏判會延續舊對話）。
  - 目前 95901 有「判斷有疑慮時一律 isShifted:false」的規則，本地版本要沿用同樣的保守方向或另訂。
  - 「畫圖」與「創作音樂」都是短句，關鍵詞判斷可能失準（使用者實測過的同一類誤判，見 95882–95890 的註解）。
- **要先問使用者的決定**：見第 6 節的問題 1、2。

### 5.2 (b) 話題拉回來要能接回舊的子對話，不當全新話題

- **要改的現有函式**：`_checkTopicTransition` 的 `this.topicData.currentTopic = result.newTopicSummary || newUserPrompt;`（95999）目前只記一個「當前話題」字串，且話題轉移時會把整批 `messages` 換成摘要（95991–95994）＋把舊內容存入 `archivedDisplayBlocks`（95989）。這正是「拉回來也當全新話題」的成因：舊內容只剩摘要，沒有指回原來的記錄。
- **需要新增的資料**：
  - 每個子對話（或話題段）有 `topicId`、`fingerprint`（第 5.1 節的指紋）、`lastActiveAt`。
  - 話題段之間的指向（例如 `archivedDisplayBlocks[i]` 加上 `topicId`），讓拉回時能找到對應的段落。
- **風險**：舊段落要不要完整載入回模型的上下文（token 成本）；摘要與原文的一致性。
- **要先問使用者的決定**：問題 3。

### 5.3 (c) 偵測到新議題時，真正開出子對話（準備交接 → 建立 → 送出 → 監控 → 冒泡）

建議的流程（草案）：

1. **交接內文**：從父對話取「必要的上下文」（第 5.2 節的段落摘要＋使用者的新問題）。可重用現有 `pruneContext` 的摘要規格（95955–95961 的摘要要求：原始意圖、已呼叫的工具與結果、缺什麼）。
2. **建立子對話**：呼叫 `_chatNew`（79679）的變體，新增一筆索引，並寫入 `parentId`（新欄位）。
3. **送出**：在子對話的 ctx 上呼叫 `executeChat`（已有 `_chatRunner(ctx)` 模式，見 rg_dispatch.js:822，可以沿用「對指定 ctx 執行」的做法）。
4. **監控**：父對話需要知道子對話的狀態。草案的狀態欄位：`status ∈ {running, done, waiting_user, failed}`，由子對話的 `isResponding`（53678 已有 `running`）與結束原因推導。
5. **冒泡**：子對話轉 `done` 或 `waiting_user` 時，父對話寫一則 `role:'tool'` 或新的「子對話狀態」訊息（沿用 78104–78106 的 `_progressWidget` 模式即可，不需要新 UI），並在父對話同步顯示。
6. **接回**：使用者說「回到剛才那個」時，依第 5.2 節的指紋找回子對話，`_chatSwitch`（79668）。

- **要改的現有函式**：`_chatNew` 79679、`_chatSwitch` 79668、`_chatListInit` 79553（索引欄位）、`_delegateToSubagentAuto`（104400）與 `_runSubAgentTask`（104572）只需要在「要不要開子對話」的判斷點接上，不必改動它們內部的迴圈。
- **需要新增的資料**：索引欄位 `parentId`、`status`、`topicId`、`fingerprint`；ctx 上的 `childIds`（或由索引反查）。
- **風險**：
  - 子對話的 `executeChat` 會把 `_checkTopicTransition` 也跑一遍（新對話訊息數少，應該只 return，但要確認）。
  - 併發：父子同時 `isResponding` 時，`executeChat` 的插話規則（102416）會把新訊息變成插話，要定義子對話如何接收。
  - 遠端需求也是「新對話」（53458–53463），要避免兩套機制互相覆蓋。
  - 巢狀子對話的深度與成本（每一層都是一整套模型呼叫）。
- **要先問使用者的決定**：問題 4–6。

---

## 6. 要先問使用者的決定（問題清單，**不要自己決定**）

1. **偵測方式**：本地關鍵詞、詞向量（需要哪個模型或資料）、還是「本地先判、模型背景校正」三擇一？誤判的偏好是寧可多開還是寧可少開？
2. **既有的保守規則**（95901「有疑慮就不轉移」）要保留嗎？
3. **拉回的舊話題**：要整段載回模型上下文，還是只載摘要？摘要由誰產生（模型或本地）？
4. **子對話的可見性**：子對話要不要顯示在側欄（和現有對話平級），還是收在父對話底下？
5. **子對話的接收**：使用者在子對話進行中又打字，是插話給子對話，還是問父對話？
6. **遠端需求**（53458）與子對話要不要統一成同一種「子對話」？

---

## 7. 沒查、需要接手者補查的項目

- `_getRootToolNames`（74735）內是否逐行呼叫 `_intentFilter`（只確認函式本體與開關）。
- `pruneContext` 完整呼叫點清單；「記憶」（Hermes）與離線訓練器有沒有送出前的呼叫。
- 子 agent 能否叫出 `ask_user_card`（61059 登記、允許清單是否包含）；子 agent 等待使用者的完整路徑。
- `FileCache`（79420 使用）底層是 IndexedDB 還是其他。
- `runBatchSubAgents` 的回傳結構（105273–105311 之後）。
- 量測沒涵蓋：真實網路延遲、探測請求在第一次真的發生時的耗時、離線模式、`toolCallMode` 為 `text` 時的路徑。

---

## 8. 教訓

- 本次一開始用「分類器」「engagement」等詞在 grep 找步驟，找不到；改用 `executeChat` 的入口往下追才找到 `_checkTopicTransition`。下次先從入口的 `await` 清單往下讀，不要先猜名字。
- 步驟 1 的表有幾列只做了 grep 沒有讀完整函式（列 18、20、21）。已在表內標成「沒查」或「只看到註解」，不要當成已驗證。

---

## 9. 本次改動範圍

- 新增：`scripts/eval/send_latency.eval.js`（評估檔，只包裝、不改來源）。
- 新增：本文件 `DESIGN.TODO.chat-subsessions.md`。
- 未改任何 `renderer/`、`web-lazy/`、`update-manifest.json`、`test-reports/` 或其他檔案。

---

## 10. 使用者的決定（2026-11-04，逐字；以本節為準，取代第 5、6 節的草案選項）

使用者原話（回答第 6 節六個問題）：
1. 「選速度快的方式，誤判寧可多開」
2. 「不用保留」（既有的「有疑慮就不轉移」保守規則不保留）
3. 「如果有開subsession，這還要嗎，建議只有摘要」（有子對話後，拉回舊話題只載摘要）
4. 「預設收在父對話底下」
5. 「問父對話，當他有出現子對話了，可以透過父對話跟子對話溝通，也可以插給子對話，父對話要有一個像是連結的可以點過去子對話。可以在所有對話@對話名稱 來讓父對話知道這是指誰。因為我們有remote，標記對話名稱時，要包含節點名稱」
6. 「統一」（遠端需求與子對話統一成同一種子對話）

原始構想（同日）：「我覺得可以設計成start subsession，準備交接內文，產生子對話，把訊息丟過去，並檢查子對話的狀態，如果子對話完成或者有跳出等待的，就往parent傳遞，parent同步送出來」；「這些話題我的設計是在chat底下設計subsession，但看來應該要真正地做到發出新的子對話，監控子對話會比較好，而且目前會變成監測到新議題，就把舊的縮起來」。

### 10.1 由決定推出的設計（管理層的解讀；有疑問的標「待確認」）

- 偵測：本地、非阻塞、不呼叫模型（關鍵詞或字元片段相似度），結果同步得出；偏向「判成新話題」（誤判寧可多開子對話）。第 1 節表中第 6 步的 `await _checkTopicTransition` 改為本地判斷，不再阻塞送出。
- 開關：沿用 `advancedSettings.topicShiftCheck`（預設 false，commit `6e01d052`），語意改為「偵測到新話題時開子對話」；關閉時完全不偵測。（待確認：使用者是否希望新功能預設開啟。使用者先前說「預設不檢查話題更動」，所以先保持預設關閉。）
- 拉回舊話題：只載摘要，不載整段；本地比對舊子對話的指紋，找得到就把訊息送進那個子對話（不當全新話題）。
- 子對話：真的新對話（有 id、`parentId`、`status`、`topicId`、指紋、摘要），在側欄預設收在父對話底下；父對話裡有可點的連結卡片，點了切到子對話。
- 狀態與冒泡：`status ∈ {running, done, waiting_user, failed}`；子對話完成或需要使用者回應（問題、權限、確認對話框）時，父對話同步顯示並可直接回應。
- 溝通：使用者在父對話打字，預設由父對話處理；子對話存在時，可以透過父對話轉達，也可以直接插給子對話。
- `@對話名稱`：在任何對話輸入 `@` 加對話名稱，讓父對話知道指的是哪個對話。因為有遠端，名稱要含節點名稱（例如 `節點名/對話名`）；需要自動完成與歧義處理（同名時要求更完整的名稱）。
- 統一：遠端需求（`remote/rg_dispatch.js:822`、主檔 53458）改成同一種子對話，帶來源節點名稱。

### 10.2 實作階段（每階段一個 Haiku 工作階段，一次只有一個寫檔者，每階段先寫失敗的測試再修）

| 階段 | 內容 | 驗收（真桌面版評估） |
|---|---|---|
| S1 | 資料模型：索引欄位 `parentId`、`status`、`topicId`、`fingerprint`、`summary`、`nodeName`；對話名稱解析與 `@` 解析的純函式（含節點名稱、同名歧義）；側欄「收在父對話底下」的樹狀呈現 | 手動建立父子對話後側欄樹狀顯示、收合；`@節點/名稱` 解析測試 |
| S2 | 本地快速話題偵測（純函式，不呼叫模型，偏向判新話題），取代 `await _checkTopicTransition`；接上 `topicShiftCheck` | 送出延遲量測：判斷耗時趨近 0、不呼叫模型；換話題與拉回案例 |
| S3 | 開子對話：本地產生交接摘要、`_chatNew` 變體寫入 `parentId`、在子對話 ctx 上 `executeChat`、父對話出現可點連結卡片 | 換話題後側欄出現子對話，連結點擊切換 |
| S4 | 狀態監控與冒泡：`status` 推導、完成或等待時父對話顯示，並可在父對話回應；插話規則（父子同時回應中） | 假模型讓子對話等使用者回答，父對話出現並可回應 |
| S5 | 拉回舊話題：指紋比對現有子對話，找到就送進該子對話（只帶摘要）；`@對話名稱` 輸入與自動完成 | 換話題後拉回，訊息進原子對話 |
| S6 | 統一遠端需求為子對話（帶節點名稱），移除重複機制 | 遠端需求進來後側欄樹狀顯示 |

| S7 | 批次刪除子對話（使用者 2026-11-04 原話：「也要有工具可以批次刪除子對話」）：側欄／父對話的多選刪除，另有給 AI 呼叫的工具（暫名 `chat_delete_children`，參數：父對話、條件如「已完成」「失敗」「全部」、或 id 清單）；刪除是不可復原的動作，AI 呼叫一定要先出確認卡片列出將刪除的子對話標題與數量，使用者按確認才執行；只刪子對話，不刪父對話；刪除時要一併清掉存檔與 `status` 監控。（待確認：「工具」是指 AI 工具、側欄介面，還是兩者；先兩者都做。） | 建立 1 父 5 子後批次刪除「已完成」的，只剩未完成的；AI 工具未經確認不得刪除 |

注意：每一階段完成後都要確認 `topicShiftCheck` 關閉時行為不變（回歸）；全部階段完成並驗證前，管理層不請使用者發布子對話功能。

---

## 原檔：coding-patch-ci

<!-- 從 TODO.md 拆出（2026-10-23）：內容原封不動，只是改成一份一個主題。 -->

# TODO：程式設計 domain 的 patch 小工具與 CI/CD（2026-10-14）

已完成並驗證的內容見 [DESIGN.coding-ci.md](DESIGN.coding-ci.md)。還沒做：

- [ ] 用**真的需要登入**的 Gerrit／GitHub／Jenkins 實測一次（認證標頭、Gerrit `/a/` 前綴、Jenkins crumb、反向代理／SSO 環境）；目前只驗過公開服務與本機假伺服器。
- [ ] 真實弱模型走完整修 bug 流程（提示詞遵從度）；路由器是否把「修 bug／CI 失敗」導向 `coding`。
- [ ] Gerrit：回覆個別留言（reply／resolve）、`rebase`／`submit` 這類 review 動作；GitLab／Zuul／Azure DevOps 的連線。
- [ ] 網頁版的 `coding_edit`／`coding_patch_tool`（目前只有桌面版）。
- [ ] Jenkinsfile 解析：動態 stage、`@Library` 共享函式庫。
- [ ] 設定頁「CI/CD 連線」目前只在工程模式顯示；若要常駐可以從 `ADVANCED_ENGINEERING_CATS` 拿掉。

---

## 原檔：colu-thinking

# CoLU+Thinking 設計草案（TODO，唯讀調查結果，尚未實作）

來源需求（使用者 2026-11-04）：「安排一個是離線的 qwen，要 CoLU+thinking，因為 qwen 也確實可以 thinking，也可以讓他反思，中間的計畫要多點 think。請把這個稱為 CoLU+Thinking。」

本文件只是草案，不是結論。所有「事實」都附行號；標明「推測」「沒查」的地方沒有讀程式確認。

---

## 步驟 1：現有離線 Qwen 盤點

檔案：`renderer/src/vlm/vlm_core.js` 的模型表（`MODELS`，約第 24–52 行）。

| 模型 id | 行號 | 大小（GPU / CPU，位元組常數） | 裝置 | 執行函式庫 | thinking | 用途 |
|---|---|---|---|---|---|---|
| `qwen3-0.6b`（預設文字模型） | 30–32 | 543 MB / 589 MB | GPU 用 q4f16，CPU 用 q8；`gpuNeedsF16` | transformers.js（見下） | 有思考模式，但這裡關掉（註解第 32 行寫「太慢」） | chat、rag、tools（hermes） |
| `qwen2.5-0.5b` | 33–35 | 461 MB / 488 MB | 同上 | 同上 | 無（沒有 thinking 設定） | chat、rag、tools；`verified: false` |
| `qwen2.5-1.5b` | 45–47 | 1165 MB / 1506 MB | 同上，CPU 很慢 | 同上 | 無 | chat、rag、tools |
| `qwen3-1.7b` | 48–50 | 1360 MB / 1662 MB | 要 GPU 才實用 | 同上 | 有（同 Qwen3） | chat、rag、tools |
| `llava-interleave-qwen-0.5b`（圖像轉文字，實驗） | 24–27 | 780 MB / 695 MB | GPU 或 CPU（實測 CPU 約 140～150 秒） | transformers.js（llava 架構） | 不適用 | 圖像描述 |

- 預設文字模型常數：`DEFAULT_TEXT_MODEL = 'qwen3-0.6b'`，`vlm_core.js:75`。
- 函式庫：worker 內用 `L.TextStreamer`、`L.InterruptableStoppingCriteria`、`cur.tokenizer.apply_chat_template`、`cur.model.generate`，可判定為 **transformers.js**（`floating-assistant.js:50829–50842`）。沒有 WebLLM 的使用（grep 沒找到，推測）。
- 裝置決定：`resolveDevice` 在 `vlm_core.js:79–92`，回傳依序嘗試的 `order`：`['webgpu','wasm']`（偏好 GPU 且有 WebGPU）、`['webgpu']`（只能 GPU）、`['wasm']`（CPU）。GPU 失敗會降級到 CPU（`vlm_core.js:92` 理由文字）。
- 每個模型的 `contextTokens` 是實際給的上下文長度：qwen3-0.6b 4096（`vlm_core.js:31`）、qwen2.5-1.5b 與 qwen3-1.7b 8192（`:46`、`:49`）。

使用處（文字生成）：
- 離線文字 chat 入口：`floating-assistant.js:100376–100395` `_llmGenerate(model, a, cb)`。逾時：WebGPU 90 秒、其他 300 秒（`:100386`）。預設 `maxTokens` 512（`:100388`）。`deterministic: true` 時用貪婪解碼（`:100383`）。
- 工具呼叫的離線 agent 迴圈：`vlm_core.js:349` `runAgentLoop`；`vlm_core.js:365–368` 有「垃圾輸出」偵測後用保守參數重試一次（`strict: true`，`maxTokens: min(reply, 256)`）。
- 離線自動退路：`offlineAutoFallback` 預設 true（`floating-assistant.js:57717`、`:59148`），勾選框在 `:69302`，所有模型失效時才退回離線訓練器。
- 進階設定的離線文字模型：`this.advancedSettings.offlineTextModel || 'qwen3-0.6b'`（`floating-assistant.js:98068`）。
- 離線訓練器與 `offlineAutoFallback`：`floating-assistant.js:103391`、`:103431`。
- 「離線訓練器」在 `floating-assistant.js` 內是另一組程式（沒有逐一查完）。

注意：`floating-assistant.js` 內嵌了一份 `vlm_core` 的副本（例如 `textGenParams` 在 `:7489`，`parseToolCalls` 的 `<think>` 處理在 `:7511`）。依記憶檔 `feedback_embedded_source_modules`，改動要改來源模組再重新嵌入。

---

## 步驟 2：現有 CoLU 實作盤點

CoLU（封閉題外殼）的核心是 `recipe/recipe_core.js` 的 `jsonStep`：

- `recipe_core.js:86–92`：`jsonStep(ctx)`，`ctx = { generate, messages, validate, maxTries=2, maxTokens=160, prefill }`。每次呼叫 `ctx.generate({messages, maxTokens, prefill})`，失敗就用 `validate` 的錯誤訊息再問一次（最多 `maxTries` 次）。`prefill` 把回覆開頭先寫好（例如 `{"choice":`），讓小模型不會改成散文。
- 「選項題」（字母選擇題）：`{"choice": "字母"}`，`maxTokens: 40`，`prefill: '{"choice":'`。出現在：
  - `catalog/route_core.js:48`（`classifyWithModel`，四種做法的分類：model／program／design／external_action）。
  - `floating-assistant.js:8646`（`ask` 的 menu 版本）、`:14633`（UML 修正選單）、`:14707`（分類選單）、`:15924`（資料查詢選項）。
  - `uml/uml_edit_core.js:227`（UML 編輯的選單）。
- 「固定欄位」（欄位 JSON）：`recipe_core.js:132` 的 fill 形式，`prefill: '{"<欄位名>":'`；`floating-assistant.js:8602` 同樣寫法（`maxTries: 2`，`maxTokens` 用預設 160）。
- 「填成員／順序」的 UML 步驟：`floating-assistant.js:10688`（members，`maxTokens: 400`）、`:10706`（sequence，`maxTokens: 300`），`prefill` 來自 `uml/uml_core.js:434`（`PREFILL` 表）。
- 核對函式（程式）：每個 `validate(o) → [錯誤]`，例如 `route_core.js:48`、`floating-assistant.js:8646`。
- 預設退路：`pick(o) < 0` 時 `jsonStep` 失敗，呼叫端改用程式結果（`recipe_core.js` 的 `ok:false` 回傳，`:92`）。
- 經驗閘門：`catalog/colu_bench_core.js:13`（`DEFAULTS`：`high: 0.8`、`unstable: 0.25`、`minCalls: 3`、`minEdge: 0.9`、`requireOptions: true`），`makeTasks` 在 `:29`，`grade` 由 `colu_bench_core.js` 其他位置（沒查完整）。`colu_bench_core.js:12` 與 `floating-assistant.js:77527` 的 `_coluBenchCall`（`maxTokens: 4096`，走 `this._coluBenchCall(cfg, …)`，看起來是**線上**呼叫，沒查確認）。
- 達成路線（FaRoute）：`floating-assistant.js:14657` 起的 `const FaRoute = (function () {…})`，註解說明設計在 `DESIGN.unit-catalog.md` 第三十七節。
- 反思（程式依序看）：`floating-assistant.js:56158` 的註解：① 先找現有工具 → ② 達成路線（UML design → 程式 → 模型）。反思②的實作在 `:56178–56186`。這一段**主要是程式流程，不是 thinking**。
- 反思的字詞核對：`catalog/reflect_core.js:12` 的 `CONFUSABLE` 表（像／象、截／擷 等形近字），`reflect_core.js:7` 是模組匯出。這是**字詞層的反思**，不用模型。

目前 CoLU 的呼叫方式：全部都經 `generate` 函式注入。離線時 `generate` = `_llmGenerate`（`floating-assistant.js:100445` 的 `gen(model)`，選工具用 `deterministic: true`），線上時是 `_coluBenchCall` 等（沒查確認每個 `generate` 的注入點）。

---

## 步驟 3：離線模型的 thinking 輸出處理

事實（讀程式確認）：
- **離線 worker 關掉 thinking**：`floating-assistant.js:50832` 與 `:50834`，`apply_chat_template(..., enable_thinking: false)`。所以目前不會產生 `<think>`。
- 生成參數：`textGenParams`（`vlm_core.js:248`；副本 `floating-assistant.js:7489`）：採樣 `do_sample: true, temperature: 0.4, top_p: 0.9, repetition_penalty: 1.08`；`deterministic` 時 `do_sample: false` 並刪掉 temperature 與 top_p（貪婪）。
- 最大 token：worker 端 `max_new_tokens: m.maxTokens || 512`（`floating-assistant.js:50839`）。`jsonStep` 預設 160，選項題 40。
- 停止條件：`InterruptableStoppingCriteria`（`:50835`），可由 `interrupt` 中斷；逾時在 `_llmGenerate` 的 `setTimeout`（`:100386`）。
- 垃圾偵測：`vlm_core.js:311` `looksLikeGarbage`，在 `floating-assistant.js:100390` 每 64 字檢查，命中就 interrupt。`vlm_core.js:365–368` 再做一次保守重試。

`<think>` 的剝除位置（多處，沒有統一函式）：
- `vlm_core.js:270`（`parseToolCalls` 回傳的 `text`，`/<think>[\s\S]*?<\/think>/g`）。
- `floating-assistant.js:7511`（同上副本）。
- `floating-assistant.js:8550`、`:14057`、`:14063`、`:27205`、`:27275`、`:33035`、`:42692`、`:45054`（各自正規表達式，沒有共用函式）。
- `floating-assistant.js:34015` 與 `:34180` 的 `stripThink`（比較完整：處理未閉合的 `<think>`、`<thinking>`，並去掉 ``` 圍欄）。
- 結論：**沒有一個統一的「先去思考區塊再解析」的入口**；`jsonStep` 本身（`recipe_core.js:89–92`）也沒有去除 `<think>`。如果開 thinking，`jsonStep` 的 `validate`／`JSON.parse` 會遇到前綴文字，要靠各呼叫端自己去除。

風險（推測，沒實測）：
- 如果 `prefill: '{"choice":'` 之前的模型輸出含 `<think>`，prefill 本身會被接在提示詞後面，**思考區塊會出現在 prefill 之前**，不會出現在答案裡；但 `jsonStep` 的 `generate` 回傳文字要包含 prefill（`recipe_core.js:88` 註解），所以要確認 `raw` 的組合順序。
- Qwen3 的聊天範本在 `enable_thinking: false` 時通常會塞一個空的 `<think></think>`（推測，沒查範本檔）。

---

## 步驟 4：「計畫」階段盤點

- 「UML design 由上而下規劃」：`uml/uml_core.js` 的 `PREFILL`（`:434`）與 `uml_core.js:455–456`（`fromHints` 的程式生成），`floating-assistant.js:10688–10706` 的 members／sequence 步驟，`maxTokens` 分別 400 與 300，`maxTries: 2`。
- 「達成路線」的計畫文字：`floating-assistant.js:56178`（UML design 路線的字串）。
- 深度規劃（多步驟）：`harness/harness_host.js` 的 `decompose`（`:16` 呼叫 `FH.decompose`，`:17` 呼叫 `FH.toUml`），`:23` 的 `FH.callsOf`。**沒查**：`FH.decompose` 內部是否呼叫模型。
- 路由（四種做法）：`catalog/route_core.js:27` 的 `score`（規則打分）、`:33` 的 `classify`；只有在 `ambiguous`（前兩名差距小於 1，`:39`）時才呼叫模型做 `classifyWithModel`（`:42–48`），且 `maxTokens: 40`。**計畫本身目前完全沒有 thinking 預算**。
- 計畫的 token 預算：只有上面 `400`（members）與 `300`（sequence）；沒有「計畫專用的大預算」。
- 離線計畫的生成參數：同 `_llmGenerate`，選工具用貪婪（`floating-assistant.js:100445`）。

結論：目前專案**沒有**一個「先想再畫」的長計畫階段給離線小模型；計畫多半由程式規則與小型選單完成，模型只回一個字母或一小段 JSON。

---

## 步驟 5：CoLU+Thinking 設計草案（草案，不是結論）

### (a) 各階段要不要開 thinking、預算多少
| 階段 | 型態 | 建議 thinking | 建議預算（token，草案） | 理由 |
|---|---|---|---|---|
| 路由（做法 A/B/C/D） | 字母選單 | 關 | 0（沿用 `maxTokens: 40`） | 規則已能分；模型只在「模糊」時才問 |
| 填欄位 | 固定欄位 JSON | 關 | 沿用 160 | 欄位答案短，開 thinking 容易超時 |
| 計畫（UML 由上而下、多步驟路線） | 結構化 JSON | **開** | 最大，例如 1500～3000（草案，需實測） | 使用者要求「計畫多想」 |
| 反思（答案核對失敗、計畫後檢查） | 字母選單＋一句理由 | **開，但限短** | 300～600 | 反思是封閉題，預算要小 |
| 核對失敗後的修正 | 固定欄位 JSON | 關（先試），失敗再開 | 沿用 160 | 修正要快 |

注意：以上數字都是**推測**，尚未用真模型量測。`contextTokens` 只有 4096～8192，計畫階段的 thinking 會吃掉上下文，預算要跟 `contextTokens` 按比例縮放（依記憶檔 `feedback_self_adaptive_chunk_sizing`，不要寫死常數）。

### (b) 答案解析
1. 先用一個統一函式去掉 `<think>…</think>`（含未閉合的，沿用 `floating-assistant.js:34015` 的寫法），再交給 `jsonStep` 的 `validate`。建議新增在 `recipe_core.js`（`jsonStep` 之前），而不是每個呼叫端各改一次（目前有 10 幾處各自正規表達式，見步驟 3）。
2. 思考內容另存成「推理紀錄」（字串，可在介面展開看），不進答案、不進 `messages` 歷史（避免上下文被吃光）。
3. 思考不收斂或超過預算時的退路，依序：
   1) 截斷思考區塊，只看 `prefill` 之後的答案；
   2) 若答案仍不合法：改用 `enable_thinking: false` 再問一次（同一題）；
   3) 再不行：程式預設答案（沿用 `route_core.js` 與 `recipe_core.js` 的 `ok:false` 路徑）。

### (c) 反思
- 反思題也是封閉題：`"這個計畫有沒有缺口？A 沒有 B 有：缺口是…"`，`maxTokens` 300～600，`maxTries: 2`。
- 觸發條件：(1) 某階段答案被核對失敗；(2) 計畫產生後。
- 上限：每題反思最多 1 次；整個計畫最多 2 次（草案）。超過就走 (b) 的退路。
- 與現有反思的關係：`floating-assistant.js:56158–56186` 的「反思①②」是**程式流程**（找工具、達成路線），`catalog/reflect_core.js` 是**字詞**反思。CoLU+Thinking 的反思是**第三種**（模型 thinking 反思），要明確區分命名，避免混淆。

### (d) 離線速度與裝置
- Qwen 在 WebGPU 或 CPU 上開 thinking 會慢很多（`vlm_core.js:32` 註解已寫「太慢」）；逾時目前是 WebGPU 90 秒、其他 300 秒（`floating-assistant.js:100386`）。CoLU+Thinking 的計畫階段要有**獨立逾時**，建議更短或依 token 數估算（沒量測）。
- 開關：預設**關閉**（使用者慣例：新功能預設保守）；開啟時顯示預估時間。
- 裝置偏好：沿用 `resolveDevice`（`vlm_core.js:79–92`）與 `_omDevicePrefOf`（`floating-assistant.js:100378`），不另立一套。
- 模型建議：`qwen3-0.6b` 與 `qwen3-1.7b` 有思考模式（`vlm_core.js:32`、`:49`）；`qwen2.5-*` 沒有，不列入 CoLU+Thinking 的候選（推測：Qwen2.5 無 thinking 模式，依官方資料，**沒查**）。

### (e) 設定位置
- 放在 **Configure** 的 LLM 基礎設定（記憶檔 `feedback_domain_configure_button` 與 `project_topic_shift_setting_pending` 有相關慣例），新增一個「CoLU+Thinking」區塊。
- 離線文字模型選單沿用 `advancedSettings.offlineTextModel`（`floating-assistant.js:98068`），只列有 thinking 的模型。
- 預設值：開關關、計畫預算中等、反思上限 1。
- 記憶檔 `feedback_ai_settings_ui_duplicate`：`index.html` 與 `floating-assistant.js` 內部的 AI 設定有兩份 UI，**兩邊都要改**（沒查兩邊的實際行號）。

### (f) 如何評量
1. 假模型測流程：用固定回覆的假 `generate`，驗證 `<think>` 剝除、退路、反思上限（只需 node 測試，類似 `vlm_core.test.js`）。
2. 真離線模型量測（**需要先問使用者**，寫明檔名、來源、大小）：
   - 檔案：`qwen3-0.6b` 的 ONNX 權重，來源 HuggingFace `onnx-community/Qwen3-0.6B-ONNX`，GPU 約 543 MB、CPU 約 589 MB（`vlm_core.js:31`）。
   - 指標：封閉題正確率、有無 thinking 的差別、每題耗時。
3. 評量題型可沿用 `colu_bench_core.js` 的 `makeTasks`／`grade`（`:29`）。

### (g) 實作分階段建議（每階段一個 Haiku 工作階段、一次一個寫檔者）
1. 純函式：`<think>` 剝除＋推理紀錄（`recipe_core.js`），附 node 測試。
2. `jsonStep` 接上 thinking 參數與預算（只改 `recipe_core.js` 與 `_llmGenerate` 的參數傳遞）。
3. 計畫階段：UML 由上而下（`uml_core.js:434`、`floating-assistant.js:10688`）開 thinking，獨立逾時。
4. 反思階段：核對失敗後的一次反思（`floating-assistant.js:56158` 附近）。
5. 設定 UI（兩份：`index.html` 與 `floating-assistant.js`）。
6. 真模型評量（先問使用者）。

風險：`floating-assistant.js` 十萬行，改動要用 `Edit` 小段改，並改來源模組再嵌入（記憶檔 `feedback_embedded_source_modules`）；`.min.js` 與 `web-lazy` 也要同步（`git status` 顯示這些檔案已有未提交變動，**不可以碰**，本次不改）。

---

## 要先問使用者的決定（不要自己決定）

1. 是否要真的下載 `qwen3-0.6b` 或 `qwen3-1.7b` 來量測？（需要先問：檔名、來源、大小見 (f)）
2. 「計畫」階段的 thinking 預算上限要多大？（草案 1500～3000，沒量測）
3. 計畫階段在 WebGPU 上可接受的最長等待時間？
4. CoLU+Thinking 要不要對 `qwen2.5-*` 也開放（它們沒有 thinking 模式，預設不列）？
5. 推理紀錄要不要存進對話歷史（會吃上下文）？
6. 開關的預設值確定是「關」嗎（草案建議關）？

### 使用者決定（2026-11-04，已定案，覆蓋上面草案）
1. 同意下載 `qwen3-0.6b` 來量測（階段 6 才下載，下載前仍要列檔名、來源、大小再確認一次）。
2. 計畫階段思考預算上限 1500～3000 token（仍依 `contextTokens` 按比例縮放）。
3. 計畫階段在 WebGPU 上最多等 30 秒（離線模型，寬裕即可）；逾時走退路。
4. **只留 `qwen3-0.6b`**：CoLU+Thinking 只對 `qwen3-0.6b` 開；其他離線模型（含 `qwen3-1.7b`、`qwen2.5-*`）不走這條，保持原行為（「補充 2」的退化設計不做）。
5. 推理紀錄**只給使用者看**，不放進 `messages` 歷史、不送回模型；每次回應各自有自己的推理（因為送出的 prompt／messages 本來就含上下文）。
6. 開關**預設打開**（只對 `qwen3-0.6b` 生效）。

---

## 補充（管理層 2026-11-04）：全部離線文字模型與無 thinking 的退化

範圍從 Qwen 擴大到專案內**所有離線文字生成模型**（`task: 'text-generation'`，`vlm_core.js:30–50`）。另外的離線模型（圖像轉文字、深度、分割、姿態、語音）不屬於文字生成，不列入 CoLU+Thinking，理由見下表。

### 補充 1：離線文字模型盤點（全部 7 個）

依 `vlm_core.js:30–50` 的 `MODELS` 表。thinking 欄是**程式現況**與**外部已知的模型能力**分開標示；外部能力沒有在本專案實測。

| 模型 id | 行號 | 參數量（概略，label 或註解） | 大小 GPU / CPU | 支援 thinking？ | 工具呼叫 | contextTokens | 目前用途 |
|---|---|---|---|---|---|---|---|
| `qwen3-0.6b`（預設） | 30–32 | 0.6B | 543 MB / 589 MB | **支援**（Qwen3 有 `enable_thinking`，程式目前設 false：`floating-assistant.js:50832`、`:50834`） | hermes | 4096 | chat、rag、tools |
| `qwen3-1.7b` | 48–50 | 1.7B | 1360 MB / 1662 MB | **支援**（同上，程式目前關） | hermes | 8192 | chat、rag、tools |
| `qwen2.5-0.5b` | 33–35 | 0.5B | 461 MB / 488 MB | **不支援**（Qwen2.5 Instruct 無 thinking 模式；外部已知，沒查範本） | hermes | 4096 | chat、rag、tools，`verified: false` |
| `qwen2.5-1.5b` | 45–47 | 1.5B | 1165 MB / 1506 MB | **不支援**（同上） | hermes | 8192 | chat、rag、tools |
| `smollm2-360m` | 36–38 | 360M | 260 MB / 348 MB | **不支援**（外部已知） | 無（`toolCalling: null`） | 2048 | chat、rag，英文為主 |
| `granite-4.0-350m` | 39–41 | 350M | 336 MB / 551 MB | **不支援**（外部已知，IBM 小模型未標 thinking；沒查） | hermes | 4096 | chat、rag、tools，`verified: false`，註解寫「適合工具階段」 |
| `granite-4.0-1b` | 42–44 | 1B | 1192 MB / 1702 MB | **不支援**（同上，沒查） | hermes | 8192 | chat、rag、tools，`verified: false` |

結論：全部 7 個中，只有 Qwen3 系列（`qwen3-0.6b`、`qwen3-1.7b`）可能支援 thinking。其餘 5 個在 CoLU+Thinking 裡一律走退化路線（補充 2）。

不列入文字模型（用途不同，`vlm_core.js:12–63`）：`florence-2-base-ft`（12）、`smolvlm-256m`（16）、`vit-gpt2`（20）、`llava-interleave-qwen-0.5b`（24，圖像轉文字，它底下的語言模型是 Qwen 0.5B，但不是文字生成入口）、`depth-anything-v2-small`（52）、`slimsam-77-uniform`（55）、`movenet-thunder`（60）、`whisper-base`（63，`managedOnly`）。

注意：`vlm_core.js:282–287` 的 `weather_zh`、`calc_zh`、`search_zh`、`chat_none` 等是意圖標籤，不是模型。

### 補充 2：沒有 thinking 能力的模型，在 CoLU+Thinking 裡怎麼退化

設計原則：**能力分三級**，程式依模型表決定走哪一級，不靠呼叫端猜。

- **Level 1：內建 thinking**（`qwen3-0.6b`、`qwen3-1.7b`）：`enable_thinking: true`，思考區塊由 (b) 的解析函式去掉，推理紀錄另存。
- **Level 2：多輪封閉題模擬 thinking**（`qwen2.5-*`、`smollm2-360m`、`granite-4.0-*`）：不開思考。計畫與反思改成**一連串封閉題**，每題仍是字母選擇或短欄位 JSON，程式把前一題答案串成下一題的提示詞。
- **Level 3：只用 CoLU 外殼**（`smollm2-360m`，英文為主、無工具呼叫）：只做單題封閉題，不做計畫與反思；計畫由程式規則產生，模型只回字母選擇。

Level 2 的具體做法（草案）：
1. **計畫拆成封閉題鏈**：程式先列出候選步驟（規則產生，例如 `route_core.js` 的做法清單），模型每次只回答「下一步選哪一個 A/B/C」（`maxTokens: 40`，`prefill: '{"choice":'`，沿用 `recipe_core.js` 的 `jsonStep`）。最多 N 步（草案 N=5），每步的答案由程式記入計畫，不讓模型自由寫長段計畫。
2. **反思用多輪封閉題代替內建 thinking**：核對失敗或計畫完成後，程式問三題（草案）：
   - 「這個計畫有沒有缺口？A 沒有 B 有」
   - 若 B：「缺口屬於哪一類？A 欄位缺 B 步驟缺 C 順序錯」
   - 「修正後要不要重排？A 要 B 不要」
   每題 `maxTokens` 40，總次數上限 3。這些題都是字母選擇，不要求模型寫理由。
3. **不讓模型寫自由理由**：封閉題不要求「先想一下再答」。若硬要模擬思考，只允許一個 `{"reason": "…", "choice": "字母"}` 欄位且 `reason` 限 40 字，超過就截斷，只取 `choice`。這一點是草案，沒有實測；小模型寫理由容易偏題，風險高，預設關。
4. **預算不靠 thinking token**：Level 2 的計畫總耗時由「封閉題數 × 每題上限」決定，不再需要 (d) 的大預算。離線速度風險反而降低（但多輪仍慢於單題，每題都要重新過一次 `_llmGenerate`，見 `floating-assistant.js:100376`）。
5. **品質退化（預期，沒實測）**：Level 2 的計畫只能到「選步驟」的粒度，拿不到長推理；Level 3 只能做單題。文件要求 UI 明示「這個模型沒有思考能力，計畫為程式輔助」。

Level 判斷的設定位置：模型表加一個欄位（例如 `thinking: 'native' | 'none'`），由 vlm_core 的 `MODELS` 決定，不在呼叫端寫死。`qwen3-*` 設 `native`，其餘設 `none`。未來要加新模型時只改模型表。

風險：
- 多輪封閉題會讓 `_llmGenerate` 被呼叫多次，每次都會經過 `_vlmEnsureLoaded` 與 worker 派送（`floating-assistant.js:100376–100395`）。要確認連續呼叫時不會重複載入（沒查 `_vlmEnsureLoaded` 的快取行為）。
- `looksLikeGarbage` 的 64 字檢查（`:100390`）對很短的封閉題可能誤判，要另設門檻（沒實測）。

### 補充 3：對 CoLU+Thinking 的影響

- 只有 Qwen3 兩個模型能走 Level 1，使用者若選 `qwen2.5-1.5b` 或 `granite-4.0-1b`，計畫與反思會走 Level 2。
- 設定 UI 要顯示目前模型的級別（Level 1／2／3），避免使用者以為離線 thinking 開了就一定有效。
- 預設模型 `qwen3-0.6b` 是 Level 1，但 contextTokens 只有 4096，多輪與 thinking 都會吃上下文，要沿用 (d) 的比例縮放（`textBudget`，`vlm_core.js` 附近）。

---

## 沒查的事項

- `index.html` 的 AI 設定 UI 實際位置（只有記憶檔提到，沒讀）。
- Qwen3 聊天範本在 `enable_thinking: false` 時實際輸出什麼（推測會塞空的 `<think></think>`，沒讀範本檔）。
- `FH.decompose`（`harness/harness_host.js:16`）內部是否呼叫模型。
- `_coluBenchCall`（`floating-assistant.js:77527`）是否一定是線上呼叫。
- `renderer/src/catalog/relu_core.js` 與 ReLU 激活函數無關（它是矩陣可達性計算，`relu_core.js:15` 的 `relu` 只是 max(x,0) 用於布林矩陣），與本題無關，未深入。
- 沒有下載、沒有執行任何模型；所有數字（token 預算、等待時間）都是草案。

## 離線與線上分界（給後續實作者）

- 離線：`_llmGenerate`（`floating-assistant.js:100376`）→ worker → transformers.js。
- 線上：`_coluBenchCall`、`ai.chat`、`_kiLlm`（沒查每一條）。
- 本草案只針對**離線**。

---

## 階段 1 記錄（2026-11-04，純函式，不接 UI、不呼叫模型）

**改了哪些檔**（只有三個，其餘未碰）：
- `renderer/src/recipe/recipe_core.js`：
  - 新增 `stripThink(text)`（約第 88 行起）：回傳 `{answer, reasoning, unclosed}`；去掉 `<think>…</think>` 與 `<thinking>…</thinking>`（大小寫不分），多段思考以空行合併；只有開頭沒閉合時，從開頭到結尾都當思考，並設 `unclosed: true`。
  - `jsonStep`（約第 98 行起）：每次 `generate` 回傳後先呼叫 `stripThink`，驗證、退回提示的「上一個回覆」都只用答案；思考文字累積到 `reasoning`（多次嘗試以空行串接）。成功、失敗、`generate` 拋錯三種回傳都帶 `reasoning` 欄位（新欄位，既有欄位語意不變）。
  - 匯出清單加入 `stripThink`（約第 296 行）。
- `renderer/src/recipe/recipe_core.test.js`：新增約第 165–205 行，共 17 個新檢查（stripThink 12 個＋jsonStep 整合 5 個）。
- 本記錄（`DESIGN.TODO.colu-thinking.md`）。

**測試結果**：
- `node renderer/src/recipe/recipe_core.test.js`：89 passed, 0 failed。
- `node renderer/src/recipe/plan_core.test.js`：57 passed, 0 failed。
- `node renderer/src/recipe/skill_compile_core.test.js`：48 passed, 0 failed。

**遇到的坑與教訓**：
- 步驟 3 寫的 `floating-assistant.js:34015` 在 `renderer/floating-assistant.js`（1196 行）裡超出範圍，行號對不上；語意改照本階段規格（閉合、未閉合、多段、大小寫）實作，沒有照抄那份程式。之後若要對照，要先確認是哪一份副本。
- `skills/weak-model-harness/scripts/vendor/recipe_core.js` 是另一份副本，本階段刻意不同步；要不要同步留給發布階段決定。
- 工作目錄在 Windows 上 git 會提示「LF will be replaced by CRLF」，但索引與工作樹都是 LF，`git diff --stat` 只顯示 54 行新增、6 行刪除，沒有整檔換行變動。
- 回傳新增 `reasoning` 欄位時，要把失敗路徑（`generate` 拋錯）也補上，否則前幾次嘗試的思考會遺失；已補並有測試。

## 階段 2 記錄（2026-11-04，參數與預算，不接任何呼叫端、不接 UI）

**改了哪些檔**：
- `renderer/src/recipe/recipe_core.js`：
  - 新增 `thinkingPlan({modelId, stage, contextTokens, enabled})`（約第 103 行）：只有 `qwen3-0.6b` 且 stage 為 `plan`／`reflect` 且 `enabled !== false` 才開；`plan` 預算＝contextTokens×0.4 夾在 1500～3000、逾時 30000；`reflect` 預算＝×0.075 夾在 300～600、逾時 15000；其他一律 `{enabled:false, maxTokens:null, timeoutMs:null}`。
  - `jsonStep`（約第 117 行）：接受選用的 `ctx.thinking`。有且 enabled 時，先開 `enableThinking:true` 問一輪（maxTokens 用 `thinking.maxTokens`，每次生成都帶 `timeoutMs`）；答案仍不合法 → 同一題（原始 messages）改 `enableThinking:false` 再問一次（只一次，maxTokens 用 `ctx.maxTokens||160`）；再不行走既有 ok:false。`generate` 拋錯不做退路，直接 ok:false。沒有 `ctx.thinking` 時，`generate` 收到的物件只有 `messages／maxTokens／prefill` 三個鍵，與階段 1 完全相同。
  - 匯出清單加入 `thinkingPlan`。
- `renderer/src/floating-assistant.js`（只改 4 處，都用 Edit 以字串定位）：
  - 工作者端 `chat(m)` 的兩處 `enable_thinking: false` → `enable_thinking: m.enableThinking === true`（約第 50881、50883 行）。沒傳時仍是 false，行為不變。
  - `_llmGenerate` 的 `limitMs`（約第 100507 行）：有 `a.timeoutMs` 就用它，否則沿用 90／300 秒。
  - `_llmGenerate` 的 `_vlmRpc('chat', …)` payload 加 `enableThinking`（約第 100509 行）；`_vlmRpc` 用 `Object.assign` 轉交，已確認會到工作者的 `m`。
  - 內嵌的 RECIPE 區塊由 `node scripts/embed-code-ui.js` 重新產生（這次順便把階段 1 的 stripThink 也嵌入了，之前嵌入的是舊版）。其他區塊內容沒有變動。**沒有跑 `build-assistant.js`**，因為它會改寫 `renderer/floating-assistant.js` 與 `.min.js`，這兩份不在本階段範圍。
- `renderer/src/recipe/think_plan.test.js`（新檔，41 個檢查）。
- `scripts/run-core-tests.js`：登記新測試一行。

**測試結果**（假模型，全部在 node 執行）：
- `think_plan.test.js`：41 passed, 0 failed。
- `recipe_core.test.js`：89 passed, 0 failed（與階段 1 相同，沒有新增檢查）。
- `plan_core.test.js`：57 passed, 0 failed。
- `skill_compile_core.test.js`：48 passed, 0 failed。
- `vlm_core.test.js`：135 passed, 0 failed。
- `node --check renderer/src/floating-assistant.js`：語法通過。
- 沒有跑完整的 `run-core-tests.js`，因為它會改寫 `test-reports/` 下本來就有未提交變動的報告檔。

**還沒做（留給後續階段）**：
- 沒有任何呼叫端傳 `thinking`，所以目前實際執行路徑沒有任何改變（階段 3、4 才接計畫與反思）。
- 主執行緒的 `_llmGenerate` 目前只會把 `enableThinking` 與 `timeoutMs` 轉交，還沒有 jsonStep 把 `generate` 的 `req.enableThinking` 轉成 `_llmGenerate` 的 `a.enableThinking`。呼叫端接線時要自己轉（`generate: (req) => this._llmGenerate(model, {messages: req.messages, maxTokens: req.maxTokens, prefill: req.prefill, enableThinking: req.enableThinking, timeoutMs: req.timeoutMs}, cb)`）。
- `renderer/floating-assistant.js` 與 `.min.js` 沒有重新建置，發布前要照專案流程跑 `build-assistant.js`。
- `skills/weak-model-harness/scripts/vendor/recipe_core.js` 仍是另一份副本，本階段刻意不同步（同階段 1）。

**遇到的坑與教訓**：
- `embed-code-ui.js` 會一次重寫所有嵌入區塊。這次 `git diff` 確認只有 RECIPE 區塊與我改的 4 處有實質變動，但之後跑它前應該先 diff 一次確認。
- 工作目錄仍有本階段之外的未提交變動（`.claude/launch.json`、`features/FEATURES.md`、`test-reports/*`、`parts_builtin.json`），提交時只加本階段的檔案。

---
## 階段 3 記錄（2026-11-04，計畫階段接上 thinking；只做 UML 由上而下計畫這一條）

**接線位置**（計畫入口 → 呼叫端）：
- `renderer/src/floating-assistant.js` `_coluThinkingFor(M)`（新增，在 `_umlDesign` 前）：線上模型或沒有模型時回傳 null；離線模型交給 `R.thinkingPlan({modelId, stage:'plan', contextTokens, enabled: advancedSettings.coluThinking !== false})`。開關未設定視為開。
- `_umlDesign`：把結果當 `thinking` 傳給 `FaDesign.designProject`；`onStage` 多處理 `type:'thinking'`，進度列印「🧠 思考中…（階段）」「🧠 思考完成（N 字）」。
- `renderer/src/uml/design_core.js`：`designProject` 把 `opts.thinking` 傳給 `scenarioToModelBig`；回傳多一個 `reasoning` 欄位（只給程式內部，`_umlDesign` 不放進工具結果）。
- `renderer/src/uml/uml_core.js`：`scenarioToModel` 的 `ask` 把 `opts.thinking` 原樣交給 `R.jsonStep`；思考字數用 `thinking` 事件送出；結果多一個 `reasoning` 欄位；`scenarioToModelBig` 把切塊的推理串接起來。沒有 `thinking`（或 enabled:false）時，請求與以前完全相同。
- 逾時：`jsonStep` 把 `timeoutMs`（30 秒）交給 `generate`，`_llmGenerate` 本來就用 `a.timeoutMs`；逾時時 worker 回傳已生成的部分文字（不丟例外），沒閉合的思考就變成空答案，jsonStep 走退路（同一題、關 thinking 再問一次）。最後仍不合格就照既有預設路徑（`ok:false`，各階段退回程式預設）。

**修正一個階段 2 的接線問題**：`jsonStep` 開 thinking 那一輪原本也帶 `prefill`（例如 `{"actors":["`），worker 會把 prefill 接在生成提示後面，模型就沒機會先思考。現在只有「開 thinking 的那一輪」不帶 prefill；退路那一輪照舊帶。

**推理不進哪裡（證明）**：`grep reasoning` 在 `recipe_core.js`、`uml_core.js`、`design_core.js`、`floating-assistant.js` 的計畫段落，只會看到：`stripThink` 回傳、`jsonStep` 的 `reasoning` 陣列與回傳欄位、`scenarioToModel`／`scenarioToModelBig`／`designProject` 的回傳欄位、`_umlDesign` 的進度文字（只用字數）。重試時退回的 `messages` 只用答案（`stripThink` 之後的文字）；`decisions` 與 `dsl` 也不含推理。工具結果 `_umlResult(...)` 沒有 `reasoning`，不會存進對話。

**不是 UI**：完整展開推理的介面留給階段 5；這階段只有一行進度。

**測試**：
- `renderer/src/uml/plan_think.test.js`（新檔）：25 passed, 0 failed。涵蓋 thinkingPlan 模型與預算縮放（4096→1638，2048→1500 下限，8192→3000 上限）、開關關、其他模型的請求鍵集合不變、逾時與不合格的退路（同一題、保留 prefill、30 秒）、generate 拋錯不丟例外、推理不進 messages／dsl／decisions、進度事件、切塊合併推理。
- 既有：`recipe_core.test.js` 89、`plan_core.test.js` 57、`skill_compile_core.test.js` 48、`think_plan.test.js` 41、`vlm_core.test.js` 135、`uml_core.test.js` 76，全部 0 failed。
- `scripts/eval/colu_think_plan.eval.js`（真 Electron）：在隔離副本（`%TEMP%\colu-iso\desktop-app`，node_modules 用 junction）跑 `node scripts/eval/run_eval.js`，結果 PASS：qwen3-0.6b 的 7 次計畫呼叫帶 `enableThinking`、逾時 30000、預算 1638，工作者 RPC 的 payload 有 `enableThinking:true`；推理標記不在工具結果；開關關掉後沒有任何 thinking 請求。
- `node scripts/run-core-tests.js`（在隔離副本跑，沒有動到工作目錄的 `test-reports/`）：172／175 組通過。失敗：`tray_dialog`（已知）、`computer-remote` RFB（已知），以及 `harness skill 可攜`（新，見下）。

**沒有做、需要知道的事**：
- `renderer/floating-assistant.js`（建置出來的檔）**沒有**在工作目錄重新建置，因為 `build-assistant.js` 會改寫 `.min.js` 與 `update-manifest.json`（發佈相關）。評估是在隔離副本建置後跑的。發布前要照 `publish-live-update-patch` 流程跑建置。
- `harness skill 可攜` 失敗來自 `skills/weak-model-harness/scripts/vendor/recipe_core.js` 與來源不一致，**從階段 1（4d30a0c0）就開始**（那時就決定不同步，留給發布階段）。這次沒有同步，需要決定：同步 vendor 副本（會讓這個檢查通過）或刪掉這條檢查。
- 計畫階段每一題都可能等 30 秒，一次 UML 設計的題數多（類別、成員、關係、呼叫順序各一題）時，總時間會變長；尚未量測真機時間。
- 評估裡另有 6 次生成沒有 thinking（呼叫來源沒有逐一查明，推測是設計流程的重整／歧義判斷，`designProject` 內的 `opts.generate`）。依設計只有計畫階段開 thinking，這 6 次行為不變。

---

## 階段 4 記錄（2026-11-04，反思：CoLU+Thinking 反思，設計 5(c)；只對 qwen3-0.6b，預設開）

**命名與區分**：函式一律叫「CoLU+Thinking 反思」（`coluThinkReflect`、`coluThinkRevise`、`coluThinkBudget`），和 `floating-assistant.js` 的「反思①②」（程式流程：找工具、達成路線）、`catalog/reflect_core.js`（字詞反思）都不同。

**改了哪些檔**：
- `renderer/src/recipe/recipe_core.js`（新增約 50 行，匯出加三個）：
  - `coluThinkReflect({generate, modelId, contextTokens, enabled, question, timeoutMs?})`：封閉題「這個計畫有沒有缺口？A 沒有 B 有：缺口是…」，走 `thinkingPlan({stage:'reflect'})` 的預算（ratio 0.075、300～600）與 15 秒逾時、`jsonStep` 的 `maxTries: 2`。回傳 `{gap, note, reasoning, ok}`。解析失敗、逾時、generate 拋錯一律 `gap:false`（`ok:false`）；沒有 thinking 時 `skipped:true` 且不呼叫 generate。`note` 最長 200 字。
  - `coluThinkRevise({qid, budget, generate, modelId, contextTokens, enabled, original, describe, redo, secondCheck})`：反思 → 有缺口就 `redo(note)` 重做一次 →（`secondCheck` 時）重做結果再反思一次，仍有缺口就用原本的。上限：整份計畫（`budget.total`）最多 2 次反思；`qid` 不是 `'plan'` 的題目（答案核對失敗那一種）每題最多 1 次。超過上限、重做失敗、重做後仍有缺口一律 `fallback`，`value` 是原本的。
  - `coluThinkBudget({max?, perQMax?})`：預設 `max 2`、`perQMax 1`。
- `renderer/src/recipe/think_reflect.test.js`（新檔）：24 項，全過。涵蓋沒缺口、有缺口重做一次、重做仍失敗用原計畫、計畫層上限、每題上限、整體上限為 0、逾時、解析失敗、拋錯、其他模型不變、開關關閉、推理不進重試的 messages、預算 307（4096 上下文）。
- `renderer/src/uml/design_core.js`（計畫層）：`designProject` 在 `opts.reflect.enabled` 時，計畫產生後反思；有缺口就把 note 以「（反思提示，請修正這個缺口：…）」加在情境後重做一次；`onStage` 送 `{type:'reflect', level:'plan', …}`；`trail` 記一筆。沒給 `reflect` 時呼叫與以前相同。
- `renderer/src/uml/uml_core.js`（答案層）：`scenarioToModel` 的 `ask` 在答案核對失敗（`jsonStep` 回 `ok:false`）且 `opts.reflect.enabled` 時，反思一次；有缺口就把 note 當反思提示重做該題一次（重做的結果照常過 `validate`）；推理只 push 進 `reasoning`。
- `renderer/src/floating-assistant.js`（**來源**，不是建置檔）：
  - 新增 `_coluReflectFor(M)`：和 `_coluThinkingFor(M)` 同一條件（只有 qwen3-0.6b 且開關不是 false），其他情況 `null`，反思完全不跑。
  - `_umlDesign` 傳入 `reflect: this._coluReflectFor(M)`；`onStage` 多一個 `reflect` 分支，進度列一行：「🪞 反思（N 字）：有缺口，已依此重做一次：…／沒有缺口／沒有定論（逾時或格式不對），照原本的」。
  - `node scripts/embed-code-ui.js` 重新嵌入 uml／design／recipe 區塊；`git diff` 確認只有上面這些變動（137 行新增、7 行刪除，跨 4 個檔）。
- `skills/weak-model-harness/scripts/vendor/recipe_core.js`：同步為新的 `recipe_core.js`（改前已確認與 HEAD 一致）。`harness skill 可攜` 仍然通過。
- `scripts/run-core-tests.js`：登記 `think_reflect.test.js` 一行。
- `scripts/eval/colu_think_reflect.eval.js`（新檔）：真 Electron，走 `fa._umlDesign` 整條路徑，假的 `_vlmRpc`，不下載模型。

**測試結果**：
- `think_reflect.test.js`：24 passed, 0 failed。
- 既有：`recipe_core.test.js` 89、`plan_core.test.js` 57、`skill_compile_core.test.js` 48、`think_plan.test.js` 41、`plan_think.test.js` 25、`vlm_core.test.js` 135、`uml_core.test.js` 76，全部 0 failed。`node --check renderer/src/floating-assistant.js` 通過。
- `node scripts/run-core-tests.js`：174／176 組通過。失敗只有既有的兩個：`tray_dialog`（系統匣對話框）與 `computer-remote` 的 RFB 探測。（報告上標「新增」只是因為它們不在 `known-failures.json` 裡，不是新壞的。）`harness skill 可攜` 通過。
- 真 Electron 評估 `scripts/eval/colu_think_reflect.eval.js`：**PASS**。
  - A（gap-once）：計畫後反思 2 次（計畫層＋重做後），有缺口 → 重做請求確實出現；反思帶 thinking；推理標記不在工具結果，也不在任何非反思請求的 messages。
  - B（gap-always）：計畫層反思剛好 2 次，第二次仍有缺口 → 用原計畫。
  - C（garbage）：反思輸出壞掉 → 3 次 RPC（thinking 兩次＋退路一次），沒有重做，流程照常完成。
  - D（開關 false）：0 次反思、0 個 thinking 請求。
  - E（classes-fail）：類別答案核對失敗 → 答案層反思一次（請求含「沒有通過核對」）；計畫層又反思一次（共 2）。
- 評估是在隔離副本跑的（`%TEMP%\colu-iso4\desktop-app`，node_modules 用 junction，在那裡 `node build-assistant.js` 後跑 `run_eval.js`，埠 17942，不用 17923）。工作目錄沒有重建建置檔。

**Grep 證明推理不進 messages／工具結果**：
- `uml_core.js` 的 `reasoning` 只出現在：`scenarioToModel` 的 `reasoning` 陣列與回傳欄位（第 495 行）、`scenarioToModelBig` 串接（第 525、528 行）、`ask` 裡的 `reasoning.push`（推理）。`decisions` 與 `warnings` 不含推理。
- `design_core.js` 的 `reasoning` 只在 `designProject` 回傳欄位（`res.reasoning`），`_umlResult` 不取它。
- `floating-assistant.js` 的 `_umlDesign` 只用 `e.chars`（字數）與 `e.note`（結論），推理文字本身不進進度列。

**遇到的坑與教訓**：
- **第一次評估 0 次反思，原因不在功能**：評估載入的是建置檔 `renderer/floating-assistant.js`，它沒有階段 2～4 的任何程式（`_coluThinkingFor` 也找不到）。建置檔要在隔離副本建置，這跟階段 3 的做法一樣。工作目錄的建置檔仍然是舊的，發布時要照 `publish-live-update-patch` 流程重建（會改 `.min.js` 與 `update-manifest.json`，這一階段沒有做）。
- **測試抓到的真 bug**：`coluThinkBudget({max:0})` 因為寫成 `opts.max || 2` 被當成 2。改成 `!= null` 判斷，並留了一項測試。
- `node scripts/run-core-tests.js` 會覆寫 `test-reports/core-tests-latest.*`，而這兩個檔本來就有使用者未提交的變動。這次先備份、跑完後還原（sha1 驗證），沒有動到它們。
- `scripts/embed-code-ui.js` 會重寫所有嵌入區塊，改前改後都要看 `git diff`，這次確認只有預期的變動。

**沒做、需要知道的事**：
- 真模型（`qwen3-0.6b`）的反思耗時與正確率還沒量測，屬於階段 6（需要使用者先確認下載）。
- 反思的預算（300～600）與逾時（15 秒）是依上一階段的決定，沒有量測。
- 進度列會顯示缺口的一句話（`note`）。這是「結論」，不是推理全文；推理全文留給階段 5 的介面。
- 反思在計畫層與答案層共用同一份預算（整份計畫最多 2 次），所以答案層先反思過，計畫層就只剩一次反思的額度；重做後可能就用不到第二次反思。這是依「整個計畫最多 2 次」的字面意思做的，如果要分開算，請管理層決定。

---
## 階段 5 記錄（2026-11-04，設定介面與推理顯示）

**設定位置（只有一份 UI）**：`#ai-topic-shift-chk`（話題更動檢查）只在 `renderer/src/floating-assistant.js` 的 AI 進階設定 `llm-basic` 分頁裡；`renderer/index.html` 沒有這個開關（grep `topicShiftCheck` 整個 `renderer/` 只有 floating-assistant.js）。所以 CoLU+Thinking 的開關也只加在同一個分頁、話題更動檢查的下面，**沒有第二份要同步**。

**改了哪些檔**：
- `renderer/src/floating-assistant.js`（來源）：
  - 預設 `advancedSettings.coluThinking: true`（`topicShiftCheck` 預設那行上方）；讀設定時 `FaRecipe.coluThinkingSetting(raw.coluThinking)`（未設定視為開）。
  - 面板新增 `#ai-colu-think-chk`＋說明文字（只對離線 qwen3-0.6b、計畫最多約 30 秒、關閉維持快速流程）；面板同步與 `change` 事件寫回 `advancedSettings.coluThinking` 並存檔。
  - `_createProgressWidget`：卡片狀態多 `reasoning` 陣列；回傳物件多 `reasoning(block)`（編輯器靜默路徑是 no-op）；`_faUpdate` 把每段推理畫成一個收合的「思考過程」區塊（`FaRecipe.reasoningBlockHtml`）。
  - `_umlDesign` 的 `onStage`：`thinking` 的 done 與 `reflect` 事件把推理文字交給卡片（`prog.reasoning`）。
- `renderer/src/recipe/recipe_core.js`：新增純函式 `coluThinkingSetting`、`escapeHtml`、`reasoningView`（空白→不顯示；超過 20000 字截斷並記總字數）、`reasoningBlockHtml`（`<details>` 收合，摘要「思考過程（階段）」，內容先跳脫 HTML，截斷註明）；匯出清單加入。
- `renderer/src/uml/uml_core.js`、`renderer/src/uml/design_core.js`：進度事件多帶 `text`（推理全文）與 `label`；`chars` 不變，既有測試不受影響。
- 內嵌區塊：`node scripts/embed-code-ui.js` 重新嵌入（RECIPE、uml、design 區塊）；`git diff -U0` 確認 floating-assistant.js 的 hunk 只有上面這些與嵌入的對應區塊。**沒有在工作目錄跑 build-assistant.js**（會改 `.min.js` 與 manifest，發布才做）。
- `skills/weak-model-harness/scripts/vendor/recipe_core.js`：同步為新的 recipe_core.js（改前已確認與 HEAD 一致）。
- `renderer/src/recipe/colu_think_ui.test.js`（新檔，20 項，全過）；`scripts/run-core-tests.js` 登記一行。
- `scripts/eval/colu_think_ui.eval.js`（新檔，真 Electron）。

**推理三項證明（Grep）**：
- 不進 messages：推理只存在進度卡片的 `state.reasoning`，而 `state` 是掛在 msg 上的**不可列舉**屬性（`Object.defineProperty(..., enumerable:false)`），存檔的 JSON 不會帶；卡片 `content` 仍是空字串。`grep -n "reasoning" renderer/src/floating-assistant.js` 的新增行只出現在設定、卡片與 `_umlDesign` 進度回呼。
- 不送回模型：推理文字只在 `jsonStep`／`scenarioToModel` 的 `reasoning` 陣列與進度事件的 `text` 裡流動；重試與反思的 `messages` 只用 `stripThink` 後的答案（階段 3、4 已證明）。eval 第 4 項確認標記不在任何後續請求的 messages。
- 不進工具結果：`_umlResult(...)` 沒有 `reasoning` 欄位；eval 確認 `JSON.stringify(result)` 不含標記。

**測試結果**：
- `colu_think_ui.test.js`：20 passed, 0 failed。
- 既有：`recipe_core` 89、`plan_core` 57、`skill_compile_core` 48、`think_plan` 41、`plan_think` 25、`think_reflect` 24、`vlm_core` 135、`uml_core` 76，全部 0 failed。`node --check renderer/src/floating-assistant.js` 通過。
- 真 Electron `colu_think_ui.eval.js`：**PASS**（在隔離副本 `%TEMP%\colu-iso5\desktop-app` 建置後跑，埠 17952，不用 17923）。驗證：checkbox 存在、標籤含 CoLU+Thinking、預設打開、點擊切換寫回設定；關閉時計畫無 thinking 請求、沒有推理區塊；開啟時有 thinking 請求，8 個收合區塊預設收合、摘要以「思考過程」開頭，展開後含標記，推理內的 `<img>` 被跳脫（沒有產生元素、沒有執行）。
- `node scripts/run-core-tests.js`（隔離副本）：175／177。失敗只有已知的兩個：`tray_dialog`（標為新增，因為不在 known-failures）與 `computer-remote` RFB 探測。新測試通過。

**沒做、需要知道的事**：
- 推理區塊目前掛在**進度卡片**上（每次設計呼叫的每段推理一個收合區塊），不是獨立的對話泡泡；「每次回應各有自己的推理」在這裡指「每次 UML 設計呼叫各有自己的卡片與推理」。若要放進 AI 回覆泡泡，需要另外設計（留給管理層決定）。
- 重新載入頁面或重開對話後，卡片與推理一起消失（允許的）。
- 工作目錄的 `renderer/floating-assistant.js` 與 `.min.js` 仍是舊建置，發布前要照 `publish-live-update-patch` 流程建置。
- `test-reports/*` 與 `.claude/launch.json`、`features/FEATURES.md`、`parts_builtin.json` 是使用者既有的未提交變動，本階段沒有提交。

---
## 階段 6 記錄（2026-11-04，真模型量測；CPU；樣本只有 8 題／組，屬於粗略估計）

**全部是真量測**（真 Electron、真 `_vlmEnsureLoaded`、真 `_llmGenerate` 與工作者），除非另外標註「推測」。

**環境與下載**：
- 隔離副本 `%TEMP%\colu-real\desktop-app`（robocopy 複製、node_modules 用 junction、在副本跑 `build-assistant.js`），獨立 `--user-data-dir=%TEMP%\colu-real-ud`，埠 17961，`FA_DISABLE_MAIN_OVERLAY=1`，工作目錄的檔案沒有動到。
- 下載：只有 `qwen3-0.6b`，走桌面版離線模型的載入機制（`_vlmEnsureLoaded`）。快取裡有一個 **589.1 MB** 項目（`Service Worker\CacheStorage\…\49032712165d938b_0`），對應 CPU 版（`bytes.cpu` 589 MB）。檔名沒有還原成 ONNX 原名（推測是 CPU 版權重）。**下載耗時沒有量到**（第一次前景執行被 170 秒上限截斷，沒有計時）。
- 裝置：`gpu.available` 為真，但 `這張顯示卡不支援 fp16 著色器（shader-f16）`，所以退到 **CPU（wasm）**。**沒有量到 WebGPU。**

**題目**（固定種子 20261104，程式算答案）：
- 封閉題：8 題（乘法、除法餘數、數列、四則運算各 2 題），答案字母。
- 計畫題：`FaColuBench.makeTasks` 出的前 8 題（有選項的），`FaColuBench.grade` 判分。
- 反思：計畫題前 3 題，每題 3 次 `coluThinkReflect`。

**逾時的誠實說明**：程式裡的思考逾時是 WebGPU 30 秒、CPU 用量測上限 **60 秒**（這是量測用上限，不是產品設定）。實際執行中，**思考開的 16 次呼叫有 2 次被實際卡到 120 秒（`err:"已卸載"`，判定逾時）**，計畫題有一題最長跑到 **148.6 秒**，仍然回了正確答案。所以 60 秒上限在 CPU 上**沒有被準確執行**。原因沒有查證（推測：工作者的中斷要等目前這一步結束，CPU 上一步很慢）。以下的「超過 30 秒」與耗時分布是實測值，不是預期值。

**數字**（來自結果檔 `%TEMP%\colu-real-out\run-2026-11-04T12-28-17-902Z.jsonl`，`event:"done"`）：

| 組 | 題數 | 正確 | 中位耗時 | 最長 | 超過 30 秒 | 逾時 | 解析失敗（退路觸發） | 思考字數中位 |
|---|---|---|---|---|---|---|---|---|
| G1 封閉題・思考關 | 8 | 1（13%） | 3.6 秒 | 6.7 秒 | 0 | 0 | 0 | 0 |
| G2 封閉題・思考開 | 8 | 6（75%） | 61.1 秒 | 120.0 秒 | 7 | 1 | 1 | 265 |
| G3 計畫題・思考關 | 8 | 4（50%） | 8.4 秒 | 13.1 秒 | 0 | 0 | 0 | 0 |
| G4 計畫題・思考開 | 8 | 6（75%） | 112.8 秒 | 148.6 秒 | 8 | 1 | 1 | 432 |
| R 反思（3 題×3 次，逾時 15 秒） | 9 | **0 個有效判斷**（全部 15 秒逾時） | 15.0 秒 | 15.0 秒 | — | 9 | — | — |

- 同題對照（思考開 vs 關，只看正確與否）：封閉題 開贏 5、關贏 0、都對 1、都錯 2；計畫題 開贏 2、關贏 0、都對 4、都錯 2。
- 退路（解析失敗時改問關閉思考那一題）：封閉題退路後 6/8，計畫題退路後 6/8（退路那一題答案＝G1／G3 同題答案，兩題的退路答案都是對的）。
- 反思的「三次一致率」**沒有量到**：9 次都逾時，沒有有效判斷可以比。
- 原始回覆文字**沒有存進結果檔**（只存判分與耗時），所以 G1 的 7 題錯誤是「不思考就錯」還是「格式／字母位置偏差」無法從資料分辨。
- 結果檔裡的逐題進度行是即時寫的（`event:"q"`）；桌面版不會把 renderer 的 `console.log` 送到終端，所以進度只能從結果檔看。

**三問結論**（都只有 8 題／組，CPU，請當作方向性的證據）：

1. **thinking 開比關好嗎？** 在這 8 題的樣本裡是好的：封閉題 13%→75%，計畫題 50%→75%，而且「關贏、開輸」是 0 題（沒有同題是關對開錯）。代價很大：CPU 上封閉題中位耗時從 3.6 秒變成 61 秒，計畫題從 8.4 秒變成 113 秒。**結論：正確率有利，但耗時在 CPU 上不能接受當預設。** 樣本太小，不能說「一定比較好」，只能說沒有看到反效果。

2. **30 秒夠嗎？** **CPU 上不夠。** 思考開的 16 次呼叫中 15 次超過 30 秒，中位數 61 秒（封閉）與 113 秒（計畫）。如果按產品設定的 30 秒切（沒有實際跑這個設定，只看實測耗時分布推測），思考開的答案大多會被切掉；退路會改問關閉思考那一題，本組的關閉結果是 50%（G3），所以 30 秒上限在 CPU 上會讓計畫題退回接近關閉思考的水準。這是推測，沒有實測。**WebGPU 上是否夠，沒有量到**（這台機器的 WebGPU 不能用這個模型）。

3. **預算 1500～3000 要不要調？** 這次的預算是 1638（上下文 4096 × 0.4）。**沒有看到預算被用完的證據**：思考都有閉合（`unclosed` 全部 0），思考字數中位數只有 265 與 432 字（字數不等於 token，沒有 token 計數）。所以**這次的數據不支持把預算調大**；真正的瓶頸是時間，不是預算。如果要調，應該先做**逾時行為**的修正（上面的 60 秒沒有被準確執行），再決定預算。**建議（只是建議，沒有改程式）**：CPU 上計畫階段的思考預設關閉，或使用者明確開啟時顯示預估時間；預算維持 1638 不動。反思的 15 秒在 CPU 上**完全不可用**（0/9 有效判斷），反思在 CPU 上應該先關掉，或把逾時放寬後重量。

**沒有做、需要知道的事**：
- 每組只有 8 題（使用者原始要求 ≥20 題；管理層這次縮小為 8 題，原因是 CPU 單組可達一小時以上）。
- 反思三次一致率沒有量到；WebGPU 沒有量到；下載耗時沒有量到。
- 60 秒上限沒有被準確執行，原因沒有查證。
- 沒有存原始回覆，無法分析錯誤型態。
- 第一次背景執行（`by308vpbd`）很快以 exit 0 結束，沒有輸出；原因沒有查證（後來的前景執行正常）。

**量測指令**（在隔離副本，不要在工作目錄直接跑）：
```bash
cd "$TEMP/colu-real/desktop-app"
FA_DISABLE_MAIN_OVERLAY=1 FA_DEBUG_EVAL_FILE="$PWD/scripts/eval/colu_think_real.eval.js" FA_BROWSER_CONTROL_PORT=17961 ./node_modules/electron/dist/electron.exe "$PWD" --no-sandbox --user-data-dir="$TEMP/colu-real-ud"
```
- `scripts/eval/colu_think_real.eval.js` 的 `FAKE` 常數為 `false` 時是真量測；`FAKE = true` 時只跑假生成（約 7 秒），用來驗證流程與結果檔。

## 階段 7 記錄：思考逾時的硬性上限

**查證結果（讀程式碼，不是推測）**：

1. **120 秒很可能是閒置卸載計時器造成（由程式碼推得，量測時的環境檔位未查證）。** `_vlmScheduleIdle` 在每次呼叫成功後排一個閒置卸載計時器（中檔 `idleMs` 為 120000 毫秒，低檔 `graceMs` 為 4 秒）。`_llmGenerate` 開始新呼叫時**沒有取消**這個計時器，所以計時器在呼叫進行到第 120 秒時觸發 `_vlmTerminate` → `die('已卸載')`，把正在算的呼叫以 `err:"已卸載"` 結束。這正好是量測表的「120.0 秒，`err:已卸載`」。
2. **148.6 秒是另一個機制**：`_llmGenerate` 的 60 秒逾時只送出 `interrupt`（協作式），工作者要等目前這一步結束才看得到中斷；這一步沒有被殺掉，所以呼叫端一直等到它自然結束。
3. **jsonStep 的思考那一輪拋錯就直接失敗**（沒有走關閉思考重問的退路），所以逾時後使用者會直接拿到失敗，而不是退路答案。

**修正（只改有給 `timeoutMs` 的呼叫）**：

- `FaRecipe.guardedCall(start, {timeoutMs, graceMs: 5000, interrupt, abandon})`（`renderer/src/recipe/recipe_core.js`）：到 `timeoutMs` 先 `interrupt`；再等 5 秒寬限，還沒回來就 `abandon`（終止工作者），呼叫端立即拿到 `err.timeout === true` 的錯誤。之後才到的結果一律丟棄（每次呼叫只結算一次）。沒給 `timeoutMs`（或不是正數）時就是原本的呼叫。
- `_llmGenerate`（`renderer/src/floating-assistant.js`）：有 `timeoutMs` 時用 `guardedCall` 包住 `_vlmRpc`，並在開始前取消閒置卸載計時器（`_vlmCancelIdle`）。沒有 `timeoutMs` 的呼叫維持原樣（包括閒置卸載計時器的行為）。
- `jsonStep`：思考那一輪是逾時（`timeout` 欄位）時，走既有的「關閉思考重問一次」退路；其他拋錯維持原樣直接失敗。

**測試**：
- 假工作者 node 測試 `renderer/src/recipe/colu_think_timeout.test.js`：19 項全過（準時回覆、可中斷的工作者、卡住後放棄並終止一次、時限在 timeoutMs＋寬限內、舊結果晚到被丟棄、連續呼叫不錯位、放棄後新工作者不被卡住、沒給 timeoutMs 不變、0／負數／非數字視同沒給、同步丟錯、abandon 丟錯、一般錯誤不算逾時、jsonStep 逾時退路、一般錯誤不退路、退路也逾時、沒有 thinking 不變）。已加入 `scripts/run-core-tests.js`。
- 真 Electron 評估 `scripts/eval/colu_think_timeout.eval.js`（假的卡住工作者，`timeoutMs` 設 3 秒，不載入真模型）：**PASS**
  - A：卡住的呼叫在 8.07 秒拋出逾時錯誤（3 秒＋5 秒寬限），工作者被終止 1 次。
  - B：`jsonStep` 思考那一輪逾時後，關閉思考重問，8.09 秒拿到合格答案（`ok:true`）。
  - C：會中斷的工作者，3.12 秒拿到中斷後的結果，不終止工作者。
- `node scripts/run-core-tests.js`：176／178 通過。兩組失敗都是既有或已知的：`tray_dialog`（系統匣對話框）與 RFB 探測（遠端協定）。CoLU+Thinking 階段 2 到 7 相關的組都通過。

**沒有做、需要知道的事**：

- **沒有改 `renderer/floating-assistant.js` 與 `.min.js`**。那兩個檔案是 `build-assistant.js` 從 `renderer/src/floating-assistant.js` 產生的（發佈流程的一部分）。所以目前倉庫裡的桌面版載入的仍是舊的 `_llmGenerate`，要等建置與發佈才會生效。真評估是在暫存副本（`%TEMP%\colu-s7\desktop-app`）跑完 `build-assistant.js` 之後做的。
- **沒有改沒給 `timeoutMs` 的呼叫的閒置卸載問題**。依指示，沒有給 `timeoutMs` 的呼叫行為不變；但低檔的 4 秒 `graceMs` 理論上也會在呼叫中途殺掉它（推測，未量測）。若要修，需要另外決定。
- **`vlm` 的 `run`（圖像）路徑沒有動**，它也會呼叫 `_vlmScheduleIdle`，未檢查它是否有同樣的中途卸載問題。
- 真模型（qwen3-0.6b）上的效果沒有重新量測。本階段只用假工作者證明流程正確。

### 階段 7 補記：任務 C（依裝置取逾時）與任務 D（CPU 反思重量測）

**任務 C（程式，已提交 7e0ada05）**：`thinkingPlan` 新增 `device`。webgpu（沒給也當 webgpu）：計畫 30 秒、反思 15 秒；cpu：計畫 300 秒、反思 120 秒。預算（maxTokens）兩種裝置相同。裝置由 `_coluDeviceOf` 判斷：先看已載入的結果，沒有就照 `resolveDevice` 的第一選擇，拿不到當 webgpu。反思的 device 一路傳到 `coluThinkRevise`／`coluThinkReflect`。設定面板的提示文字改成 GPU 約 30 秒、CPU 約 5 分鐘（原本寫死 30 秒）。目前沒有其他「預估時間」的顯示需要跟著改（已 Grep 確認）。測試：`think_plan.test.js` 新增 8 項。

**任務 D（真量測，CPU 反思，只重跑反思）**：腳本 `scripts/eval/colu_think_reflect_cpu.eval.js`，在暫存副本（`%TEMP%\colu-s7d\desktop-app`，建置後）跑真 Electron，重用已快取模型（沒有下載）。

- 裝置（產品判斷）：cpu；實際載入：wasm（載入 7.3 秒）；反思逾時 120 秒；預算 307。
- 題目：計畫題前 3 題（與階段 6 同一批題，種子 20261104），每題 3 次，共 9 次。
- 有效判斷：**9/9**；逾時：0；三次一致的題數：**3/3**（每題三次都合格且結論相同）。
- 每次耗時（毫秒）：83867、103328、46007、79364、81875、103109、107450、102117、85050；中位數約 85 秒，最長約 107 秒（都低於 120 秒上限）。整個量測約 800 秒。
- 每次結論都是「沒有缺口」。

**樣本很小，要註明**：只有 3 題、每題 3 次，而且 9 次全部是「沒有缺口」。所以「三次一致」只代表這 3 題在這次量測裡穩定，**不能推論反思能抓出缺口**（階段 6 也沒有測到有缺口的情況）。

**任務 A、B、C、D 的提交**：A `94f9d810`（WASM 執行緒實測）；B `459f84bb`（思考逾時硬性上限）；C `7e0ada05`（依裝置取逾時）；D 本次提交（eval 檔與本記錄）。

**真量測與推測要分開**：
- 真量測：任務 A 的 crossOriginIsolated、執行緒數、numThreads；任務 B 的 8 秒逾時路徑；任務 D 的 9 次反思耗時與結論。
- 推測（未量測）：單執行緒是 CPU 慢的主因之一；低檔閒置卸載在沒給 timeoutMs 的呼叫中途殺掉工作者（任務 B 留下的項目，未處理）。

---

## 原檔：completion-verification

# 交接文件：補完與真實驗證（跨工作線，handoff 1，2026-11-01）

## 1. 開場提示（給接手的工作階段）
Continue from the handoff document at `D:\Downloads\videos-嗨投資-desktop-app\desktop-app\DESIGN.TODO.completion-verification.md`. 先完整讀完（含使用者原話與做法備忘），照做。工作目錄 `D:\Downloads\videos-嗨投資-desktop-app\desktop-app`。**開工前先確認音樂線的工作階段（「音樂領域 · handoff N」）沒有在跑，同一個工作樹同時只能有一個寫手；它在跑就先只讀不寫，回報後等管理層指示。** 第一則訊息用一行說明你讀完了、要開始哪一項。回覆一律繁體中文、不要夾英文縮寫。不要長篇規劃、不要問，直接查證、寫程式、測試、提交。發布由管理層代發：你不要執行發布腳本，每項提交後在回報最後一行寫「第 N 項已提交，可發布，commit <hash>」。到 context 門檻（30%）時更新本文件、提交，回報最後一行寫「需要接手，文件已更新，commit <hash>」（子工作階段在這個 app 不能自己啟動接手）。

## 2. 概況
各工作線做完後留下的「沒驗證」與「沒做」，整理成一份。每項都附證據位置，接手前先自己核對是否仍然成立（有些文件已過時）。

## 3. Todo（依序）
1. **AIDoc 除錯定位器：把 ELF 接進主機端並驗證**。`renderer/src/aidoc/elf.js`（`FaAidocElf`）是純函式模組：靜態讀 ELF 檔（符號表找函式、DWARF `.debug_line` 找檔名行號、build-id 比對版本），**不執行程式**，用 `File`／`Blob` 切片讀取。要做：① `/aidoc locate --elf <檔案>`（桌面版給路徑，網頁版選檔）與 `repo_ask` 的 `locate` 動作加 `elf`／`base`／`module` 參數，呼叫 `parseModuleFrames`／`resolveFrames`／`applyToFrames`，結果進定位報告（`reportLines`），build-id 不符要明講；② 驗證：這台是 Windows、沒有 gcc／addr2line，測試用**預先編好、提交進 repo 的小型 ELF 檔案（含除錯資訊）當夾具**，位址與預期的函式／檔案:行寫死在測試裡（可在 Linux 或 WSL 編一次；沒有就找現成小型 ELF 範例並註明來源與授權），`scripts/aidoc-tests/elf.test.js` 在 node 直接跑；③ 參考 `D:\Downloads\redmine_ai_chat` 的 `ai_chat_aidoc.js` 的 `locate`（765–945 行，**只讀不改 Redmine 資料夾**）。
2. **AIDoc 其他未驗證**：主機端 `_repoLocate`、檢視器端到端、`log_triage` 工具在桌面版實跑；測試版驗證（`scratchpad/el_test/deploy3.sh` 那套，若不存在就用 Electron 當 Node 跑自己寫的小驗證腳本）。結果寫進 `DESIGN.TODO.aidoc-locator-port.md` 的「未驗證」那段並更新。
3. **image-to-3d 真實驗證與殘留**：`DESIGN.TODO.image-to-3d.md` 列的「真實 App 還沒驗證」：設定頁卡片顯示、兩張圖貼上時的指令分流、GPU（fp16）路徑、SlimSAM 流程、編輯器真的開啟；新舊並排品質比較（舊的 image-decompose-redraw 充氣 vs 新的封閉立體，同一批圖）；第 33 行「edit-game-3d 還沒接」**已過時**（`e28dc585` 已接，見 `renderer/src/game/game_host.js` 約 110–120 行），把文件改正。用內建瀏覽器或 Electron 實跑，附截圖或數字。
4. **網頁版延遲載入第二階段**：核心 `web-lazy/core.js` 約 5.1 MB，非嵌入部分約 445 萬字元仍大。先用內建瀏覽器量**真實開頁**的下載量與解析時間（改前基準在 `DESIGN.lazy-loading.md`，改後沒量過），寫進文件；再盤點核心裡還能拆的大塊（聊天主程式以外的零碎工具），依「開頁一定碰到／只有某指令才用」分類，一批一批拆，規則同 `DESIGN.TODO.lazy-loading.md`（stub＋動態載入、每個新區塊檔都進 manifest、零功能退步、入口測試不得有新增失敗）。`DESIGN.TODO.lazy-loading.md` 第 32 行「沒有任何程式碼改動」已過時，改正。
5. **改圖（edit-picture）殘留**：使用者 2026-11-01 說 sd-turbo 已 drop（授權），確認屬實（`8f0e7490`、`fee59ca3` 已移除，只留 SDXS＋TAESD）。要做：① 把殘留的名字清乾淨——`renderer/src/imagegen/sd_turbo_core.js`／`FaSdTurbo`／`scripts/imagegen-tests/sd_turbo.test.js`／兩份 `DESIGN*sdturbo*.md` 改名成不含 sd-turbo 的名字（例如 `local_edit_core.js`／`FaLocalEdit`），同步改嵌入腳本、`run-core-tests.js`、`image_route.js`、`edit_host.js`、`floating-assistant.js` 的所有引用與註解，入口測試必須全過；② 遮罩選取區域改圖是否已完成（文件說「目前整張」，回報說選區重畫 v227 已發布，互相矛盾，讀程式核對）；③ 真實 App 驗證 SDXS＋TAESD 圖生圖（畫質、WebGPU）。
6. **入口測試的不穩定項**：電腦操作遠端協定探測（`scripts/computer-tests/remote.test.js`，RFB 探測）時過時不過；單獨跑探測是通過的（約 730 毫秒，預設等待窗 800 毫秒）。用重複跑 20 次記錄失敗率、在失敗時印出實際回傳值，找出原因（計時、埠重用、假伺服器），修成穩定，再把 `test-reports/known-failures.json` 那筆移除。
7. **工作樹雜物**：`skills/image-decompose-redraw/data/parts_builtin.json`（不知道誰改的，先 `git diff` 看內容，是生成檔就查是哪個腳本產生、是否該提交或加入 `.gitignore`）、`features/FEATURES.md`（清冊產生檔，`node scripts/ai-features.js build` 後若有差異就提交）、`wiki/`（未追蹤，先問管理層，不要刪）。

## 4. 做法備忘（使用者的規則）
- 繁體中文、結論先說、不要在中文裡夾英文縮寫；做完誠實說哪些沒驗證。**沒驗證就寫「未驗證」，不要寫「應該可以」。**
- 改來源模組，再 `node scripts/embed-code-ui.js && node build-assistant.js`；不要改嵌入後那份。新模組要加進嵌入清單。
- 改檔用 Edit／Write 工具；**Bash heredoc 內的 Python 會吃掉反斜線與中文**，需要時用 Write 工具寫 `.py` 檔再執行。`floating-assistant.js` 行尾 CRLF／LF 混合，改前用 `s.count()` 試兩種。
- 編譯前會清工作目錄：做到一半也先 commit。給了順序就做到底，不要中途問。
- 熱更新：舊版也要收得到、不准要求重裝、版本號單調、manifest 清單完整、拆出的檔案都要進 live patch 與網頁版清單。
- 入口測試：`node scripts/run-core-tests.js`，失敗分「新增」與「既有」，只有新增失敗讓它變紅；既有失敗登記在 `test-reports/known-failures.json`。這台 Node 沒有 `fetch`，遠端核對用 curl。
- 工作樹有不是你改的檔案：不要放進你的提交，也不要還原。

## 5. 使用者原話（逐字，2026-11-01）
- 「image-to-3d應該要整合到edit-game-3d」（已整合，見 Todo 3）
- 「aidoc除錯定位器--elf需要直接跑程式嗎，還是只是拿到真實執行檔評判?」→ 答覆：不執行，靜態讀檔；使用者回「好」（同意把 ELF 接進主機端並驗證，Todo 1）
- 「sd-turbo 應該drop掉，我記得我們改用sdsx的vae了」（Todo 5）
- 「我不知道有沒有哪個handoff漏掉?」（本文件就是回答）
- 一貫的態度：「JUST DO IT!」「不要再繼續plan了」。

## 6. 交接流程
同第 1 節：子工作階段不能自己啟動接手；到門檻時更新本文件、提交、回報「需要接手」。

## 7. 陷阱
- `elf.js` 的測試原本靠 Linux 的 gcc／addr2line 產生對照；這台沒有，改用提交進 repo 的夾具，不要依賴本機有沒有編譯器。
- 不要把 Redmine 資料夾（`D:\Downloads\redmine_ai_chat`）改動，只讀。
- 改名（Todo 5）會同時動到嵌入腳本、網頁版區塊、測試與文件，改完必須重跑入口測試、`node scripts/embed-code-ui.js`、`node build-assistant.js`，並確認 `web-lazy/manifest.json` 一致。
- 音樂線的工作階段若正在跑，不要跟它同時改 `renderer/src/floating-assistant.js` 與 `scripts/embed-code-ui.js`。

---

## 原檔：edge-tts-gec

<!-- 從 TODO.md 拆出（2026-10-23）：內容原封不動，只是改成一份一個主題。 -->

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

## 原檔：edit-picture-sdturbo

# 交接文件：把 sd-turbo 整合進 `/edit-picture`（圖生圖改圖，handoff 1，2026-10-30）


## 0. 進度（handoff 2，2026-10-30）
- 第 1 項完成（提交 a876923c）：查證寫在 DESIGN.edit-picture-sdturbo.md。結論：ONNX 用 jdp8/sd-turbo-onnx（含 vae_encoder，fp16 大小，unet 1.7 GB）；授權是 Stability AI 社群授權（商業須登記），所以不內建、使用者自己下載；wasm 沒有能跑的 sd-turbo 版本，降級用 SDXS（同一套數學）。onnxruntime-web WebGPU 的運算子支援未驗證。
- 第 2 項完成（提交 4d220fec）：renderer/src/imagegen/sd_turbo_core.js（全域 FaSdTurbo）＋ scripts/imagegen-tests/sd_turbo.test.js（20 項通過，已加進 run-core-tests）。尚未加進 scripts/embed-code-ui.js 的嵌入清單與 floating-assistant.js 的 SDTURBO-BEGIN/END 標記（第 3 項一起做，仿 LOCALSD-BEGIN）。
- 下一步：第 3 項（主機端下載／載入／執行，含 SDXS 降級需要的 VAE 編碼器來源）。本週額度在這個階段用到 98%，所以沒有啟動接手工作階段；額度重置（2026-10-31 06:59 UTC）後由使用者重新叫起。

## 0b. 進度（2026-10-30 晚）
- 第 3、4、6、7 項完成並發布（patch v225）：主機端 _localEditImage（floating-assistant.js）、/edit-picture 用文字改圖（edit_host.js 的 _edTextEdit）、細化層本機路徑改成圖生圖、功能清冊。小型編碼器用 julienkay/taesd；madebyollin/taesd 只有 safetensors，沒有 ONNX，無法當執行時的退路。
- 還沒做：第 5 項（edit_cases 成功案例）、設定頁列出 sd-turbo 下載狀態、遮罩選取區域改圖（目前整張）。整條路在真實 App 沒跑過（不知道 SDXS 在中途時間點畫質、sd-turbo 文字編碼器輸出層、WebGPU）。

## 0c. 決定（2026-10-30）：不用 sd-turbo
- 使用者決定不要 sd-turbo（授權要商業登記）。程式已移除 sd-turbo 路徑，只留 SDXS＋TAESD（OpenRAIL++-M＋MIT）。第 5 項（成功案例）沿用編輯器既有的通用機制，不另做；設定頁已加 TAESD 狀態。剩下：遮罩選區改圖、真實 App 驗證畫質。

## 0d. 遮罩與選區重畫（2026-10-30 完成）
- 細化層加「重畫」旗標（用途下拉）；手動遮罩＝細化畫筆圈的框或塗抹；口語遮罩＝「把 X 改成 Y」拆句，位置字眼直接算比例框，其他名詞請視覺模型在 4×4 字母格上選格子（程式核對字母）。純函式在 sd_turbo_core.js（25 項測試）。真實 App 沒驗證。

## 1. 開場提示（給接手的工作階段）
Continue from the handoff document at `D:\Downloads\videos-嗨投資-desktop-app\desktop-app\DESIGN.TODO.edit-picture-sdturbo.md`. 先完整讀完（含使用者原話與做法備忘），照做。執行 low-context-long-run 技能（門檻 30%）：做 Todo 的第一項，context 到門檻就更新這份文件並啟動你的接手工作階段（`mcp__ccd_session__start_session` 是延遲載入的工具，先用 ToolSearch 載入）。第一則訊息用一行說明你讀完了、要開始哪一項。回覆一律繁體中文、不要夾英文縮寫。**不要再做規劃、不要問，直接查證、寫程式、測試、提交。**

使用者的關鍵指示（逐字）：「幫我整合sd-turbo(wasm, webgpu, cpu)在edit-picture裡面，進行圖像編輯，或處理使用者給一張圖後要求改圖的需求」。

## 2. 概況
- 目標：把 sd-turbo 做成 `/edit-picture` 的「圖生圖」改圖引擎：使用者給一張圖＋一句話（「把天空改成黃昏」「變成水彩風」「加一頂帽子」），離線在本機跑，三種執行環境都要支援：WebGPU、WASM（CPU）、以及純 CPU 降級（對應現有 onnxruntime-web 的 `webgpu`／`wasm` 兩種後端；「cpu」＝wasm）。
- 分支 `desktop-app`，工作目錄 `D:\Downloads\videos-嗨投資-desktop-app\desktop-app`。image-to-3d 已完成並發布到 v224，與這個無關。
- 現況（先讀這些）：
  - `renderer/src/imagegen/local_sd.js`（`FaLocalSd`）：本機小模型**文字生圖**（SDXS-512-DreamShaper，一步取樣，GPU fp16 約 880MB／CPU int8 約 1.1GB，onnxruntime-web），下載／載入／執行在 `floating-assistant.js`（搜 `FaLocalSd`、`_localSd`）。**沒有 VAE 編碼器的使用、沒有圖生圖。**
  - `DESIGN.edit-picture-diffusion.md`：`/edit-picture` 已有「擴散細化層（`detail`）」——只重畫一小塊細節再羽化蓋回去。接手前先讀，沿用它的蓋回／羽化／記錄機制。
  - `renderer/src/edit/edit_picture_core.js`、`edit_picture_ui.js`、`edit_pictures.js`、`pic_detail.js`、`pic_fx.js`：編輯器本體；`edit_host.js` 主機轉接層。
- 沒有任何 sd-turbo 的程式碼。沒部署。

## 3. Todo（依序，每項做完測試、提交）
1. **查證（半小時內，不寫長報告）**：sd-turbo 的 ONNX 在哪（Hugging Face 上的 ONNX 匯出，例如 microsoft／onnx-community 的 sd-turbo；或自己從 `stabilityai/sd-turbo` 匯出）、各部分檔案大小（text encoder／unet／vae encoder／vae decoder，fp16／int8 版本）、**授權**（stabilityai/sd-turbo 的授權條款是否允許商業與散布——這是公開產品；查不到或不允許就改成「使用者自己下載」，像 UniK3D 那樣不內建不替下載，並在設定頁顯示授權）、onnxruntime-web 的 WebGPU 與 WASM 是否都能跑（運算子支援、記憶體）。把查到的（含「未驗證」）寫進 `DESIGN.edit-picture-sdturbo.md`（新檔，短）。查完直接進第 2 項，不等回覆。
2. **純函式核心** `renderer/src/imagegen/sd_turbo_core.js`（UMD，全域 `FaSdTurbo`，仿 `local_sd.js`；測試 `scripts/imagegen-tests/sd_turbo.test.js`）：模型清單與釘住的檔案大小、選版本（WebGPU fp16／wasm int8，沿用 `FaLocalSd` 的選版本邏輯）、**圖生圖取樣的數學**（圖→VAE 編碼→latent×縮放→依 strength 加噪到起始 timestep→1～4 步 Euler／LCM 取樣→VAE 解碼）、遮罩混合（只改遮罩內，羽化蓋回）、尺寸對齊（512 或 8 的倍數）、錯誤白話說明。strength、steps、seed 要可調。
3. **主機端**（`floating-assistant.js`，參考 `FaLocalSd` 的下載／載入／工作執行緒做法）：下載含進度卡片（只出一張進度卡，記錄分「章節／主角／行為」，沿用 image-to-3d 的進度卡做法 `圖片轉3D` 單一進度卡）、載入、執行；三種後端（`webgpu`／`wasm`／降級）依機器自動選，失敗降級並寫明原因（附具體事實：HTTP 狀態、耗時、後端）。
4. **接進 `/edit-picture`**：新動作「用文字改圖」（圖＋指令，可選遮罩／選取區域，沒遮罩就整張）；使用者貼圖＋說「把…改成…」時，程式先解析（改哪裡、改成什麼、強度——「微調／大改」對應 strength），解析不出再用封閉式選擇題問模型，答案由程式核對；結果進圖層、可復原、記錄成有效的一步（沿用編輯器的 `effectiveSteps`）。設定頁（媒體→離線模型）列出 sd-turbo 與下載狀態。
5. **接進離線訓練器的成功案例**（`edit_cases.js`，種類 `edit-picture`）：好的改圖（指令＋參數）可存成案例。
6. 補功能清冊（`node scripts/ai-features.js check` 通過再 `build`）、`node scripts/embed-code-ui.js && node build-assistant.js`、核心測試（`node scripts/run-core-tests.js`）。
7. **完成後直接發布**（使用者慣例：完成就更新網頁、發布 patch）：`PUBLISH_TRAILER="Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" bash scripts/publish.sh -m "…"`，再 curl 查遠端 `manifest.v2.json` 版本。真實 App 沒驗證的部分在回報裡誠實列出。

## 4. 做法備忘（使用者的規則）
- 繁體中文、結論先說、不要在中文裡夾英文縮寫；做完誠實說哪些沒驗證。
- 改來源模組（`renderer/src/...`），再 `node scripts/embed-code-ui.js`；不要改嵌入後那份。新模組要加進 `scripts/embed-code-ui.js` 的嵌入清單。
- 改檔用 Edit／Write 工具；**Bash heredoc 內的 Python 會吃掉反斜線與中文**，需要時用 Write 工具寫 `.py` 檔再執行。`floating-assistant.js` 行尾 CRLF／LF 混合，改前用 `s.count()` 試兩種。
- 編譯前會清工作目錄：做到一半也先 commit。給了順序就做到底，不要中途問「接著做哪個」。
- 熱更新名單別擴大；不要要求使用者重裝。
- 暫時性失敗要自己重試；失敗訊息附具體事實；不要靠換模型復原。
- 工具說明文字用中文引號，不要反引號 code span。
- 下載模型要有進度、可中斷續傳；大檔照現有 `FaLocalSd` 的分檔／核對大小做法。
- 工作樹有不是你改的檔案（`skills/image-decompose-redraw/data/parts_builtin.json`、`test-reports/*`）：不要放進你的提交，也不要還原。

## 5. 使用者原話（逐字，2026-10-30）
- 「幫我整合sd-turbo(wasm, webgpu, cpu)在edit-picture裡面，進行圖像編輯，或處理使用者給一張圖後要求改圖的需求」
- 標準發布指令（使用者歷來說過）：「更新網頁，發布patch」「完成就可以更新網頁，發布patch」
- 一貫的態度：「JUST DO IT!」「不要再繼續plan了」——不要規劃、不要問，直接做。

## 6. 交接流程（自我遞迴）
執行 low-context-long-run 技能（門檻 30%）：每個批次邊界用 `mcp__ccd_session_mgmt__get_usage` 看 context，≥30% 就更新本文件、提交、用 `start_session`（initiation `user_asked`、context `fresh`、同一個工作目錄、`use_worktree:false`）啟動接手，確認後 `mark_completed`＋`archive_session`（被拒就跳過並告知，不要重試迴圈）。

## 7. 陷阱
- sd-turbo 的授權我沒查證：先查，查不到就當作不能內建散布。
- 現有 `FaLocalSd` 是文字生圖，沒有圖生圖；圖生圖需要 VAE **編碼器**，ONNX 檔不一定有，查證時要確認。
- sd-turbo 原生解析度是 512×512，且用 1～4 步、guidance 為 0；strength 太高會整張重畫（使用者要的是「改圖」，要保留沒被提到的部分，遮罩混合是關鍵）。
- WebGPU 的 fp16 要顯示卡支援 `shader-f16`，否則降級；wasm 版記憶體大，注意分頁記憶體上限。
- `scripts/embed-code-ui.js` 會把 `floating-assistant.js` 整份重寫（行尾可能被統一）；提交時看 `git diff --stat` 是否變成整檔，整檔差異要確認只是行尾。

---

## 原檔：edit-svg-picture-3d

<!-- 從 TODO.md 拆出（2026-10-23）：內容原封不動，只是改成一份一個主題。 -->

# TODO：`/edit-svg`、`/edit-picture`、`/edit-3d-model`（2026-10-23 已實作，這裡只留還沒做／沒驗證的）

設計與用法見 DESIGN.edit-svg.md、DESIGN.edit-picture.md、DESIGN.edit-3d.md；程式在 `renderer/src/edit/`，驗證在 `scripts/edit-tests/`（核心，已併入 `run-core-tests.js`）與 `scripts/eval/edit.eval.js`、`scripts/eval/edit3d.eval.js`（真實 Electron，假的 LLM／VLM／生圖）。

- **/edit-picture 的擴散細化層**：已實作，見 DESIGN.edit-picture-diffusion.md（真實的 FLUX Kontext、本機 SDXS 紋理借用、視覺模型描述品質沒驗證）。
- **三個編輯器共通**：真實 LLM／VLM 把話翻成動作的品質（只用假模型驗過流程）；登入後的真實網頁版（`web/`）沒跑過；英文介面只有 SVG／圖片編輯器有（3D 編輯器的字只有中文）；拖曳物件、滾輪縮放、修復畫筆的滑鼠操作在桌面版只用合成事件驗過 3D 的拖曳與點選，SVG／圖片的是外掛版 Playwright 驗過同一份程式。
- **/edit-3d-model 還沒做**：匯入 glb；匯入的真實 OBJ／STL 模型走編輯器的實測；粒子與動畫節點在編輯器畫面裡的預覽（目前只保留在 YAML、畫面靜態）；單一物件編輯的拖曳旋轉；曲面貼皮的展開（現在是整張貼圖烘上去，圖會被拉伸）；真實 GPU；群組只有等比縮放；很大的模型的效能。
- **Redmine 外掛版**：`/edit-3d-model` 還沒移植（桌面版實現後才移植；`redmine_ai_chat/CHANGES.md` 寫著「不做」的那一項現在可以做了）。

---

## 原檔：gui-bridge

# DESIGN.TODO.gui-bridge — 終端機與技能的 GUI 橋接（桌面版）

## 1. 開場提示（貼給接手的工作階段；這段也是 start_session 的 prompt）

Continue from the handoff document at desktop-app/DESIGN.TODO.gui-bridge.md (repo root D:\Downloads\videos-嗨投資-desktop-app, branch desktop-app). Read it fully, including the verbatim user words and the working style, and follow them. Run the low-context-long-run skill: do the next todo item, and when your context reaches 30%, write the next handoff and start your own successor. Quote the user verbatim: 「請實際跑程式驗證missile-command, 打磚塊, map-viewer，resizable, maximize 視窗化」 and 「麻煩打開來驗證那該死的skill gui 橋接 用該死的missile command遊戲 如果找不到，麻煩寫一套」 and 「馬上implement!!!」. Reply to the user in Traditional Chinese only, with no English abbreviations inside Chinese sentences. Do not push and do not run publish.sh (the manager publishes). First message: one line saying you read the document and which todo item you start.

## 2. 總覽（Overview）

- 目標：讓桌面版（FloatingAssistant，`desktop-app/`）的終端機與技能裡的程式，能開視窗、畫 canvas、收點擊／按鍵／滑鼠事件。順序：shell（zenity、`gui wait`、`@gui` 行）→ `ask-ai-chat` 管線 → Python（gui.py、pygame 子集）→ JavaScript（node，sandbox iframe 不加 allow-same-origin）→ 技能可宣告 GUI。SDL 在 pygame 之後；GTK#、XAML、QML、WinForms、WinAPI 不做（只留紀錄）。
- 設計來源：`C:\Users\sunneo\Downloads\redmine_ai_chat\DESIGN.skill-gui-bridge.md` 與 `HANDOFF.skill-gui-bridge.md`；Redmine 外掛的實作可直接移植（使用者 2026-11-03 明確要求沿用，不要重新發明協定）：`assets\javascripts\ai_chat_gui_*.js`、`ai_chat_zenity.js`、`ai_chat_js_program.js`、`assets\pybridge\gui.py`、`pygame.py`、`examples\missile_command.py`（與四張貼圖 `missile_*.png`）、`examples\map_viewer.py`、`test\gui_bridge\*`。Redmine 的 Rails、ActiveJob 輪詢不搬。
- 分支 `desktop-app`。**不 push、不跑 publish.sh**（管理層發布）。其他工作階段也會在這個分支提交（例如 `abd4526f` MIDI 編輯器），不要 reset、stash、切分支。

### 已提交（本分支，由新到舊）

| commit | 內容 | 驗證 |
|---|---|---|
| 929d4de7 | 待辦 5 第二批：視窗的 × 送 close 事件給程式（之前直接關、遊戲收不到事件，之後 draw 報 window is not open）；Worker 結束時把 /work 的檔案寫回終端機；gui_host.test.js 新增 × 情境 | 實機 missile_command.py：開始→遊戲視窗 400×300 畫出畫面，輸入後改變 771 像素（對照組不操作 75 像素），按 × 後 exit 0；gui_host.test.js 26 項 |
| 9ec1871c | 待辦 5 第一批：`fa_bridge.call` 網頁版改 `run_sync`；`_pyBridgeDispatch` 加 gui.* 分支（`_pyBridgeGui`）；含 import gui／pygame 的 python 走 module Worker（`_terminalTryPythonAsync`、`_terminalRunPythonWorker`，模組 `renderer/src/gui/py_worker.js`，嵌入 GUIPYWORKER／GUIPYASYNC）；視窗被點擊後加 `ai-chat-wheel-on`（桌面版沒有設定，滑鼠事件會被 gui_render 丟掉） | 實機 gui.py 範例：開窗、填 Alice、按 OK，終端機印出 `answer: Alice`、`done`，exit 0；不含 gui 的 python 照常（回歸：plain 2）；py_worker.test.js 24 項 |
| efd9bbc8 | （另一個工作階段的 MIDI 提交，見第 9 節的說明：它夾帶了我的 fa_bridge.py、py_worker.js 與產物）| 見第 9 節 |
| d4a8255b | `main.js`：`FA_DISABLE_MAIN_OVERLAY=1` 同時停用渲染頁的 live-patch 覆蓋（`computeEffectiveLocalManifest` 早退，`index.html` 改用安裝包內建 `renderer/`） | `node --check` 通過；實機效果未確認 |
| 2a1b5536 | 終端機接上 zenity：`_faGuiModule`、`_terminalGuiHost`、`_terminalZenity`；`zenity` 加入 `JS_INTERCEPTED_WITH_CAPTURE`、`TERMINAL_VIRTUAL_SCRIPT_COMMANDS`；有 shell 運算子時走 shell | 四組 node 測試通過；`node build-assistant.js` 成功，四個 GUI 常數進入 `renderer/floating-assistant.js` 與 `.min.js`；實機未驗證 |
| ef2fe842 | 視窗主機 `renderer/src/gui/gui_host.js`（開/關/重繪/事件佇列/上限 50/frame 合併/mouse move 合併/wait） | `gui_host.test.js` 21 項通過 |
| 2d0846a6 | Python 端 `renderer/src/pybridge/gui.py`、`pygame.py` 與 `gui_py_test.py`、`gui_pygame_test.py` | 本機 Python 3.10 通過（10 呼叫；pygame 子集） |
| f5fb8f12 | zenity 純函式 `renderer/src/gui/zenity.js` ＋測試，嵌入 GUIZENITY | `zenity.test.js` 56 項通過 |
| 0d1570d2 | DOM 繪製器 `renderer/src/gui/gui_render.js` ＋測試，嵌入 GUIRENDER | `gui_render.test.js` 40 項通過（fake DOM） |
| 739164eb | 協定核心 `renderer/src/gui/gui_bridge.js` 嵌入 GUIBRIDGE；`build-web-lazy.js` EXCLUDE 加入 | 嵌入字串可 `new Function` 載入並 apply |
| 4d6a197c | 協定核心 `gui_bridge.js` ＋ `gui_bridge.test.js` | 69 項通過 |

- 嵌入機制：BEGIN/END 區塊 → `scripts/embed-code-ui.js` 的 `embed(...)` 一行 → `build-web-lazy.js` 的 EXCLUDE。目前的區塊：GUIBRIDGE、GUIRENDER、GUIZENITY、GUIHOST、PYBRIDGE（`FA_PYBRIDGE_FILES` 會自動帶入 `renderer/src/pybridge/*.py`）。
- 打包與熱更新：`renderer/src/**` 不進安裝包（`package.json` build.files 排除），所以模組一律嵌進 `floating-assistant.js`，由 `build-assistant.js` 產生 `renderer/floating-assistant.js`、`.min.js`，這兩個檔在 `renderer/**/*` 與熱更新允許清單內。`.py` 也不是獨立檔案，而是字串。

### 本機環境（已確認）

- Electron 二進位檔：已從本機快取解壓到 `node_modules/electron/dist`（來源 `C:\Users\sunneo\AppData\Local\electron\Cache\electron-v44.4.0-win32-x64.zip`，158,278,765 bytes，與預期一致）。`node_modules/electron/path.txt` 內容 `electron.exe`。不要再跑 `npm install` 或 `node install.js`（Node v16.15.0 會因 ESM 報錯）。
- 啟動方式（已可啟動，視窗內容仍空白，見待辦 1）：
  ```
  $env:FA_BROWSER_CONTROL_PORT = "17924"; $env:FA_DISABLE_MAIN_OVERLAY = "1"
  Start-Process -FilePath ".\node_modules\electron\dist\electron.exe" -ArgumentList "."
  ```
- 測試用控制埠 17924（不要用預設 17923）。

## 2b. 驗證方法（實機，2026-11-03 管理層指定）

- 用真的 Electron 加評估檔，不截圖、不靠肉眼找視窗。範例檔：`scripts/eval/gui_bridge.eval.js`。
- 啟動（每次用全新的暫存資料夾，不碰安裝版資料；埠不用 17923）：
  ```
  FA_DISABLE_MAIN_OVERLAY=1 FA_DEBUG_EVAL_FILE=<評估檔絕對路徑> FA_BROWSER_CONTROL_PORT=17931 electron.exe <desktop-app路徑> --no-sandbox --disable-gpu --user-data-dir=<全新暫存資料夾>
  ```
- 一定要加 `FA_DISABLE_MAIN_OVERLAY=1`。沒加的那次執行會下載遠端版本（輸出「要更新 2 個檔案」），驗證的就不是工作目錄的實作。加了之後評估檔的 `loaded.scripts` 指向工作目錄的 `renderer/floating-assistant.js`，輸出仍會有一行「檢查更新」，但沒有套用，全新資料目錄裡也不會產生 `live-patch`。
- 啟動前先跑 `node scripts/embed-code-ui.js` 與 `node build-assistant.js`，讓 `renderer/floating-assistant.js` 與原始碼同步。這兩個產物是追蹤中的檔案，要不要 commit 屬於發布流程，不要混進功能 commit。
- 結果看標準輸出的 `[eval-file] result` 或 `[eval-file] error` 行；跑完程序會自己結束（逾時用 `timeout` 包住）。
- 評估檔在渲染頁裡執行，可用 `window.fa`、`fa._createTerminalForAI`、`fa._resolveTerminalSession`、`fa._runTerminalCommand` 與 DOM（視窗主機的節點是 `.gui-window[data-window]`，輸入框 `.gui-entry`，按鈕 `.gui-button`）。
- 「模擬使用者」是在 DOM 上填值、派發 input 事件、呼叫按鈕的 click，不是作業系統層級的滑鼠輸入。
- 已驗證過的：zenity `--entry --text=hi` 在真 Electron 裡出現視窗、按 OK 後答案 Alice 印在終端機、視窗關閉、指令結束（2026-11-03，`gui_bridge.eval.js`）。
- 未驗證：視窗在螢幕上的實際外觀（沒有做視覺檢查）、zenity 的退出碼（評估檔沒有讀取）、取消按鈕、其他 GUI 指令。

## 3. 待辦（依序；下一項最先）

1. **【已解決：不重現】找出實機視窗空白的原因。**（2026-11-03 結論：用獨立資料夾啟動後，渲染頁 DOM 有內容，topbar 1904×38、app 1904×948，視窗在主螢幕 (0,0)–(1920,1040) 可見，截圖確認聊天介面正常。之前看到的空白未能重現，原因未知。） 症狀：`electron.exe .` 啟動後，主視窗標題是 `FloatingAssistant`，程序回應正常，但螢幕上那塊區域（DISPLAY1，0,0–1920,1040）只看到桌布，沒有內容。已排除：live-patch 覆蓋（d4a8255b 之後渲染頁用內建檔）。下一步：
   - 用 `FA_DEBUG_CONSOLE`（見 `main.js` 約 1844 行）或 `FA_DEBUG_EVAL_FILE`（約 1940 行）把渲染頁的 console 錯誤寫到檔案，讀 `$env:TEMP\fa_electron_*.log`。
   - 確認 `renderer/index.html` 與 `renderer/floating-assistant.js` 的載入路徑（`resolveIndexHtmlPath`，約 1527 行）。
   - 預期結果：看得到渲染錯誤，或確認頁面有內容但視窗位置／透明度問題。找到原因後才繼續。
2. **zenity 實機驗證**（需要的指令：在終端機輸入 `zenity --entry --text=hi`，截圖確認對話框出現，輸入後答案印在終端機）。通過後回報「已提交，可發布，commit <hash>」（若有修正）。
3. **`ask-ai-chat` 管線**：stdin 讀入、stdout 輸出、可接管線（`cat log.txt | ask-ai-chat "摘要"`、`ask-ai-chat "..." | grep ...`）。桌面版現有的是 `ask-floating-ai-assistant`（`_terminalAskAI`，約 86572 行，不讀 stdin，整段輸出）。預設做法：新增 `ask-ai-chat` 別名，沿用 `_runSubAgentTask` 現有模型呼叫；做不到串流就整段輸出並說明限制。**命名問題待使用者確認**（見 4）。
4. **`gui wait` 與 `@gui` 行**（shell 端）：`gui wait <window> [VAR]`（同 sleep 的非同步虛擬指令，上限 300 秒，超時 exit 124）；程式輸出裡以 `@gui ` 開頭的行交給 host 套用、不顯示。
5. **Python 接線**（2026-11-03 管理層決定：只有 import gui／pygame 的程式走非同步，既有 `python` 行為不動；Python 在 worker 跑，gui.wait/poll 透過橋接回呼頁面，頁面用 Promise 等事件，worker 端阻塞等回覆）。
   - 進度：已完成 `renderer/src/gui/py_async.js`（判斷要不要走非同步，29 項 node 測試通過，commit a3698122）。
   - 程式路徑（已查明，見共用筆記資料夾的 python-gui-wiring-findings.md）：`python` 指令 → `SANDBOX_COMMAND_REGISTRY`（`kind:'pyodide'`）→ `_runPythonBuiltin` → `_runPyodideScriptSync`（同步）。`_pyBridgeDispatch` 沒有 `gui.*` 分支。`_pyBridgeEnabled()` 只在 `_pyBridgeDepth>0` 時為真（目前只有技能網域與 rig 流程會加）。
   - 注意：pyodide 只能從 jsDelivr 這類正確送出 JS mimetype 的來源載入（見 floating-assistant.js 約 48984 行的註解），內部用動態 `import()`。在 Blob worker 裡能否載入，要先實測。
   - **實測結果（2026-11-03，`scripts/eval/py_worker_probe.eval.js`，真 Electron）**：
     - Pyodide 在 **module worker** 裡能載入：`new Worker(blobUrl, {type:'module'})`，內部 `await import(base + 'pyodide.mjs')`，`loadPyodide({indexURL: base})`，`1+1` 得 2。classic worker（importScripts）不行，回報「Classic web workers are not supported」。
     - 頁面 `crossOriginIsolated` 是 false，所以 SharedArrayBuffer 不能用，`Atomics.wait` 不能用。
     - **JSPI 可用**（`WebAssembly.Suspending` 存在）。做法：worker 裡 `self.slow_js = async (x) => …`（要掛在 `self` 上，`py.globals.set` 的值 `from js import` 拿不到）；Python 用 `pyodide.ffi.run_sync(slow_js(21))` 同步取值；整支程式要包在一個 `def` 裡，用 `py.globals.get('go').callPromising()` 呼叫（直接 `runPython` 的入口會報「Cannot stack switch…Use pyFunc.callPromising()」）。結果 `42`。
     - 因此 gui.wait 可以是「同步的 Python 呼叫，worker 內掛起 wasm 堆疊、等頁面回覆」，不需要 SAB。
   - 下一步：(a) worker 內 `self.guiCall(op,args)` 回傳 Promise，用 postMessage 把 op 送到頁面，頁面用 `_terminalGuiHost` 做事後回覆；(b) `fa_bridge.call` 的 IN_BROWSER 分支要從 `asyncio.run(...)` 改成 `pyodide.ffi.run_sync(_fa_pybridge.call(...))`；(c) 程式入口用 callPromising。
   - 還沒做：worker 的建立與 Pyodide 載入（上面已實測）、`gui.*` op 接到 `_pyBridgeDispatch`（`gui.open`→`@gui {v:1,op:'open',...}`、`add`、`draw`、`image`（要回傳 w/h）、`poll`／`wait`（host 的 `poll`/`wait` 回字串，要 JSON.parse）、`close`）、`gui.py` 範例與 missile command 的實機驗證。
6. **missile command 實機驗證**：Redmine 的 `examples/missile_command.py` 與四張貼圖複製到桌面版（用終端機寫檔或 `terminal_cp_to`），在終端機執行，截圖確認：widget 開始視窗、canvas 遊戲畫面、貼圖可見、滑鼠點擊發射、拖曳、滾輪。沒有截圖證據就寫「未驗證」。
7. **resizable、maximize**：`map_viewer.py` 或 pygame 的 `RESIZABLE` 視窗，實機拖曳與最大化按鈕截圖驗證。
8. **打磚塊**：Redmine 沒有這個範例。要做的話，先問使用者是否同意我另寫一支。
9. **JavaScript**：`node <file.js>` 的 sandbox iframe 執行器（移植 `ai_chat_js_program.js`，sandbox 只有 `allow-scripts`）。
10. **打包核對（管理層要求）**：說明新檔進安裝版與熱更新的方法。已知答案見第 2 節；實際跑一次 `node build-assistant.js` 後檢查 `renderer/floating-assistant.js` 與 `.min.js` 含有 `FA_GUI_*`、`FA_PYBRIDGE_FILES`。

每一項：先寫或確認測試，通過再 commit；commit 後回報「已提交，可發布，commit <hash>」，並分開說明「測試驗證過的」與「沒在桌面版實機跑過的」。

## 4. 還沒有答案的問題（要問使用者，不要自己決定）

- `ask-ai-chat` 這個名稱：桌面版既有的是 `ask-floating-ai-assistant`。預設是新增別名，使用者未確認。
- 打磚塊要不要我另寫。
- 實機驗證需要用桌面自動化工具（Windows-MCP）截圖與操作桌面版。使用者已同意（2026-11-03：「同意,實機驗證」）。

## 5. 工作方式（使用者規則，依記憶檔整理）

- 語言：繁體中文，**中文句子裡不要夾英文縮寫或術語**（memory：純中文回覆）。程式碼與註解照周遭風格。
- 結論先說；誠實分開「驗證過」與「推測」；失敗要附具體事實（HTTP 狀態、錯誤訊息、耗時等）。
- 改程式用 Edit／Write，不用 shell 內嵌（memory：改程式別用 shell 內嵌）。大檔（`renderer/src/floating-assistant.js` 約 10 萬行）用 Grep 定位，不整檔讀。
- 嵌入區塊要改來源模組（`renderer/src/gui/*.js`、`renderer/src/pybridge/*.py`），然後 `node scripts/embed-code-ui.js`，用 `git diff --stat` 確認只有預期的改動（memory：嵌入的來源模組）。
- 熱更新不准要求重裝（memory）；新檔要核對是否進安裝版與熱更新。
- 不 push、不跑 publish.sh；`git add` 只加自己改過的檔案；不 stash、不切分支、不 reset。
- commit 訊息結尾 `Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>`（依最新系統提示）。
- 下載任何檔案前要先問（檔名、來源、大小）；使用者曾因大小估錯而重新確認，所以要給正確大小。
- 測試用控制埠 17924（memory：測試程式別佔 17923）。
- 上下文：30% 交接（low-context-long-run）。交接前先 commit。

## 6. 使用者原話（逐字，依時間；只列仍然有效的）

- 2026-11-03（任務原話，經管理層轉達）：「DESIGN.skill-gui-bridge.md 是讓run terminal, skill可以自己產生gui的功能，請實現」
- 2026-11-03（設計文件內原話）：「首先建立 bridge 到 gui 上,先以 python、javascript、shellscript 為主,接著才是 SDL、gtk#、xaml、qml(qt)。」
- 2026-11-03（設計文件內原話）：「可以sdl, pygame優先,後面原生的我們還沒有ABI橋接,留作紀錄」
- 2026-11-03（管理層轉達，使用者補充）：「可以參考C:\Users\sunneo\Downloads\redmine_ai_chat 的實作」（沿用 Redmine 實作，不重新發明協定）
- 2026-11-03（管理層轉達，使用者補充）：「我想要有zenity, ask-ai-chat stdin, stdout pipe,」
- 2026-11-03（管理層轉達）：「不用等使用者，請直接往下做」；「第一個使用者能實際看到的指令（zenity 能彈窗並回傳答案）做完、測試過就回報『已提交，可發布，commit <hash>』」；「新檔（gui/*.js、pybridge/*.py）確實會進安裝版與熱更新，並說明核對方法」
- 2026-11-03（使用者）：「用中文跟我溝通」
- 2026-11-03（使用者）：「請實際跑程式驗證missile-command, 打磚塊, map-viewer，resizable, maximize 視窗化」
- 2026-11-03（使用者）：「同意,實機驗證」；「好」（同意下載 Electron；之後使用者說「之前都可以直接開本地的來跑，沒道理你現在還要抓」，改用本機快取）
- 2026-11-03（使用者）：「把他修正」（指 FA_DISABLE_MAIN_OVERLAY 沒有作用於渲染頁）
- 2026-11-03（使用者）：「麻煩打開來驗證那該死的skill gui 橋接 用該死的missile command遊戲 如果找不到，麻煩寫一套」（找到了 Redmine 的 `examples/missile_command.py`，不需要重寫）
- 2026-11-03（使用者）：「那你浪費30%的context ?」（承認浪費；之後要省 context：窄範圍 Grep、少截圖、少重複報告）
- 2026-11-03（使用者，以 skill 呼叫）：「馬上implement!!!」（要求立即交接並繼續實作）

## 7. 交接程序（自我遞迴）

執行 low-context-long-run 技能（門檻 30%）。每個批次：做完 → 測試 → commit → 用 `mcp__ccd_session_mgmt__get_usage` 讀 context 百分比。低於 30% 繼續下一項；達到 30% 就：改寫本檔（保留逐字原話、補 commit 紀錄與待辦狀態）→ commit（訊息寫明是 handoff）→ `mcp__ccd_session__start_session`（initiation user_asked、context fresh、同目錄、同分支 desktop-app、title「GUI 橋接 · handoff N」、prompt 用第 1 節）→ 等後繼確認接手 → 本 session 才能 mark_completed 與 archive（不刪除，不 clear）。

## 7.5 補充（管理層要求，給接手者直接用）

**驗證分類**

- 驗證過（node 或本機 Python）：協定 `gui_bridge.test.js` 69、繪製器 `gui_render.test.js` 40、zenity `zenity.test.js` 56、視窗主機 `gui_host.test.js` 21、Python `gui_py_test.py`、`gui_pygame_test.py`；`node build-assistant.js` 成功，四個 GUI 常數進入 `renderer/floating-assistant.js` 與 `.min.js`。
- 驗證過（語法）：`main.js` 與 `floating-assistant.js` 的 `node --check`。
- **未驗證（桌面版實機）**：以上全部。實機啟動後視窗空白，渲染頁是否載入不知道。zenity 對話框、`ask-ai-chat`、`gui wait`、Python 開窗、JavaScript 執行器、missile command、resizable、maximize，都沒有實機確認。

**已提交的關鍵位置（以名稱搜尋，不靠行號）**

- `renderer/src/floating-assistant.js` 的 `_faGuiModule(name)`（用嵌入字串 `FA_GUI_*_SRC` + `new Function` 載入）、`_terminalGuiHost(session)`（每個 session 一個 `guiHost`，容器 `session.container` 設為 `position: relative`）、`_terminalZenity(session, argsText)`（建立視窗、等 `host.wait`、回傳 exit code 0/1/5）。
- `session.container = container` 在 `_mountTerminalWidget` 建立 session 的地方設定。
- zenity 接線點：`_runTerminalCommand` 裡 `ask-floating-ai-assistant` 那一行後面（有 shell 運算子時走 `_terminalRunShellText`，否則直接 `_terminalZenity`）；管線擷取點是 `JS_INTERCEPTED_WITH_CAPTURE` 物件（已加 `zenity`）；`TERMINAL_VIRTUAL_SCRIPT_COMMANDS` 集合開頭已加 `'zenity'`。
- 既有的 `_terminalAskAI(session, argsText)` 在 `ask-floating-ai-assistant` 的分支裡，呼叫 `_runSubAgentTask`，不讀 stdin。
- 視窗主機在 `renderer/src/gui/gui_host.js`，它只接受 `render` 與 `bridge` 作為參數，DOM 細節不在這裡。

**Electron 本機快取與啟動方式**

- 快取 zip：`C:\Users\sunneo\AppData\Local\electron\Cache\electron-v44.4.0-win32-x64.zip`（158,278,765 bytes，與預期一致）。
- 已解壓到 `node_modules/electron/dist`，`node_modules/electron/path.txt` 寫入 `electron.exe`。
- 啟動（PowerShell，在 `desktop-app` 目錄）：
  ```
  $env:FA_BROWSER_CONTROL_PORT = "17924"; $env:FA_DISABLE_MAIN_OVERLAY = "1"
  Start-Process -FilePath ".\node_modules\electron\dist\electron.exe" -ArgumentList "."
  ```
- 不要跑 `npm install` 或 `node install.js`（Node v16.15.0 會因為 ESM 失敗），也不要重新下載。

**不要做的事**

- 不要整檔讀 `renderer/src/floating-assistant.js`（約 10 萬行，會超過上限）；用 Grep 搜名稱，再用 Read 的 offset/limit 讀 40–80 行。
- 不要連續截圖；截圖只用在關鍵驗證點，因為每張都很耗 token。
- 不要在桌面版 Claude 的聊天輸入框打字（那是別人在用的）。
- 不要提交 `renderer/floating-assistant*.js`、`renderer/update-manifest.json`、`web-lazy/*`，它們是 build 產物，交給發布流程。
- 不要 push、不要跑 publish.sh。

## 8. Traps（踩過的坑）

- 直接用 Read 讀 `renderer/src/floating-assistant.js` 會超過上限（約 11 萬 token）。用 Grep（`output_mode: content`、`head_limit`）定位後，再用 Read 的 offset／limit 讀 40–80 行。
- Windows-MCP 的 Screenshot 會把 Claude 桌面版的視窗也拍進來；桌面版的 Claude 聊天輸入框可能被別人打字，**不要在那個輸入框打任何字**。
- `FloatingAssistant` 視窗在螢幕上是 DISPLAY1（0,0–1920,1040）；截圖左半邊只有桌布，不代表視窗不存在。用 `Get-Process` 看 `MainWindowTitle`，用 `GetWindowRect` 看位置。
- 啟動時 live-update 會把遠端檔案寫進 `%APPDATA%\floating-assistant-desktop\live-patch\`（log 會顯示「更新 2 個檔案」），不影響已經加上 `FA_DISABLE_MAIN_OVERLAY=1` 的渲染頁。
- `npm start` 會先跑 `build:assistant`，會改寫 `renderer/floating-assistant*.js`、`renderer/update-manifest.json`、`web-lazy/*`（這些是 tracked 產物，屬於發布流程，不要混進功能 commit）。`.claude/launch.json` 的修改不是我做的，不要提交。
- `embed-code-ui.js` 會重寫全部嵌入區塊；跑完要 `git diff --stat` 確認只有預期的三行左右（本次確認過）。
- 新的 BEGIN/END 區塊若要留在網頁版核心，必須加進 `build-web-lazy.js` 的 EXCLUDE。
- 桌面版的 `ask-floating-ai-assistant` 不讀 stdin；`_terminalAskAI` 用 `_runSubAgentTask`，整段答案一次寫出。
- `zenity` 的 `--progress` 沒有 stdin 版本，立即回傳 exit 0（`Z.immediate`）。
- Electron 的 `node_modules/electron/install.js` 在 Node v16.15.0 會因為 `@electron/get` 是 ESM 而失敗；本機快取已有 zip，不需要再下載。
- 截圖 token 很貴；只在關鍵驗證點截圖。

## 9. 交接 3（2026-11-03，待辦 5 第一、二批完成後寫）

### 9.1 已完成（已提交到 desktop-app，未 push、未 publish）

- 待辦 5 的四步：`fa_bridge.call` 網頁版改 `run_sync`（不再 `asyncio.run`）；`_pyBridgeDispatch(op, a, ctx)` 的 `gui.*` 分支轉到 `_pyBridgeGui(op, a, session)`；`python`／`python3` 的程式，`py_async.js` 的 `needsAsync` 為真才走 `_terminalTryPythonAsync` → `_terminalRunPythonWorker`（module Worker，Pyodide 網址同 `FA_ASSET_URLS.pyodideJsBase`）。其他 python 指令路徑沒有改。
- 技術選擇的理由：
  - `gui.wait` 用輪詢佇列（`waitEvent`）而不用 `host.wait`：host 的 resolver 不能取消，超時後下一個事件會被丟掉。
  - 程式包在 `go()` 裡用 `callPromising` 執行，因為 `run_sync` 要在 JSPI 堆疊裡才能用；`install_hooks` 也放進 `go()`（放頂層會報「Cannot stack switch」）。
  - × 送 close 事件：程式要知道使用者關了視窗，否則之後的 draw 會失敗。
  - Worker 結束後把 /work 的檔案寫回終端機的目前目錄（missile 會寫貼圖）。
  - 窗的指標：gui_render 只在 `.ai-chat-wheel-on` 祖先之下送滑鼠與滾輪，這是 Redmine 那邊的 scroll-focus 腳本設的，桌面版沒有，所以在 gui_host 的 capture-phase mousedown 加上。
- 測試：`gui_host` 26、`gui_render` 40、`gui_bridge` 69、`zenity` 56、`py_async` 29、`py_worker` 24（node，全部通過）。
- 實機（真 Electron，`FA_DISABLE_MAIN_OVERLAY=1`、`FA_BROWSER_CONTROL_PORT=17931`、全新 `--user-data-dir`，評估檔 `scripts/eval/gui_py_worker.eval.js`）：
  - gui.py 範例：開窗、填值、按 OK，終端機 `answer: Alice`、`done`，exit 0。
  - 回歸：不含 gui 的 python 照常（`plain 2`），沒有走 Worker。
  - missile_command.py（Redmine 範例原檔，四張貼圖）：按「開始」→遊戲視窗 400×300，畫面有 23→115 種顏色；對照組（不操作 1.2 秒）改變 75 像素，輸入後改變 771 像素；指標旗標生效；按 × 後程式 exit 0，沒有錯誤。
  - missile 的評估檔在 scratchpad（`missile.eval.js`，由 `gen_missile.js` 從 `missile.tpl.js` 產生，含貼圖的 base64），沒有進 repo。

### 9.2 未驗證（要明講）

- 畫面外觀：沒有截圖，視窗位置、貼圖是否正確顯示、字型都未看過。
- missile 的各操作只驗到「有反應」：沒有分開確認射擊命中、拖曳、滾輪、方向鍵。
- 「按 Ctrl+C 停止 Worker」沒有做。程式如果不等視窗事件而死迴圈，目前只能關視窗（若程式有 wait／poll 會收到 close）；無 wait 的死迴圈無法停。
- Worker 的 stdin 永遠回傳 None（`input()` 會失敗）。
- 終端機 AI 工具路徑（`terminal_run`，約 `_runTerminalCommand` 之外的 `JS_INTERCEPTED_WITH_CAPTURE` 那段）沒有接 Worker 路徑，AI 呼叫含 gui 的 python 仍會走同步路徑而失敗。這要另外接。
- 視窗程式結束後不自動關閉（目前的選擇，使用者要自己按 ×）。
- `sleep()` 在 fa_bridge 網頁版仍是 `asyncio.run`（沒有在 Worker 實測過）。
- `renderer/src/pybridge/fa_bridge.py` 的 `acall` 仍用 asyncio（只在網頁版路徑，沒有人呼叫）。
- resizable、maximize、map_viewer、JavaScript 執行器、打磚塊：都還沒做。打磚塊要先問使用者。

### 9.3 另一個工作階段夾帶我的 WIP（需要知道）

- 提交 `efd9bbc8`（MIDI 編輯器，另一個工作階段）把我當時尚未提交的 `renderer/src/pybridge/fa_bridge.py`、`renderer/src/gui/py_worker.js`、`py_worker.test.js`，以及 `renderer/floating-assistant.js` 等 build 產物一起提交了（`git add -A` 式）。
- 沒有改寫歷史（不 reset、不 rebase）。`fa_bridge.py` 的內容現在在 HEAD 上是正確的；`py_worker.js` 的舊版在 efd9bbc8，之後的修改在 9ec1871c、929d4de7。
- 兩個共用資料夾的工作階段會互相覆蓋：提交時只用明確路徑 `git add <file>`，不要用 `git add -A`。

### 9.4 工作方式（沿用第 5 節，這次新增的）

- 每個 commit 只加自己改過的檔案；產物（`renderer/floating-assistant*.js`、`renderer/update-manifest.json`、`web-lazy/*`、`test-reports/*`、`features/FEATURES.md`、`.claude/launch.json`、`skills/*/parts_builtin.json`）不提交。
- 每次改 `renderer/src/floating-assistant.js` 後要跑：`node scripts/embed-code-ui.js`、`node build-assistant.js`，再啟動 Electron 驗證（嵌入的 `FA_GUI_*_SRC` 來自 `renderer/src/gui/*.js`，改來源模組後一定要 re-embed）。
- 下一項最先：待辦 7（map_viewer、resizable、maximize）；待辦 9-10 之後。打磚塊先問使用者（第 4 節）。

### 9.5 更正：SharedArrayBuffer（管理層指正，2026-11-03）

- 我先前寫「頁面沒有 SAB、只能用 JSPI」，這個結論沒有查 `main.js`，不可信。
- 事實：`main.js` 第 29 行是 `app.commandLine.appendSwitch("enable-features", "SharedArrayBuffer")`，桌面版已啟用 SAB。`fapfs_transport.js` 也用 SAB 加 `Atomics.wait`。
- 我實測過的只有：頁面 `crossOriginIsolated` 是 false（`scripts/eval/py_worker_probe.eval.js`）。這只代表頁面不是 cross-origin isolated，不能證明 `SharedArrayBuffer` 不可用；`typeof SharedArrayBuffer` 的值我沒有在 Worker 裡讀過。
- 建議（管理層指示）：Python Worker 的同步等待改用 SAB 加 `Atomics.wait`，做法同 `fapfs_transport.js`；JSPI（`run_sync`）留給網頁版備援。目前程式碼（9ec1871c、929d4de7）還是 JSPI 版，沒有改。
- 未驗證：SAB 在 module Worker 裡能不能用、`Atomics.wait` 在 Worker 裡能不能用。下一步要用真 Electron 的評估檔實測這兩點，再決定。

### 9.6 教訓（每條：錯在哪、下次怎麼做）

1. **沒被允許就自己開後繼工作階段。** 錯在：我在交接時自行開了 `GUI 橋接 · handoff 3`，跟管理層開的 `gui-h2` 撞到同一批檔。下次怎麼做：後繼只有管理層能開。到 30% 只更新文件、commit 通過測試的部分，然後回報「需要接手，文件已更新，commit <hash>」並結束。
2. **一直停下來問技術取捨。** 錯在：取捨（輪詢或 host.wait、視窗結束後要不要關、Worker 的同步方式）我停下來問，而管理層已說這類取捨自己決定並寫理由。下次怎麼做：自己選，理由寫進文件與 commit 訊息，只有使用者的決定才停下來問。
3. **宣稱「已用真桌面版跑通」卻漏掉 `FA_DISABLE_MAIN_OVERLAY=1`。** 錯在：沒有這個變數，會下載遠端版本，跑到的可能不是工作目錄的實作。下次怎麼做：每次實機驗證都要證明載入的是工作目錄的實作（評估檔的 `loaded.scripts` 指向 `renderer/floating-assistant.js`，`has_*` 旗標為真），宣稱前先看這個證據。我這次的 gui.py 與 missile 評估檔有 `loaded` 欄位，但 missile 的 `loaded` 只檢查了函式存在，沒有檢查腳本路徑，下次要補上。
4. **寫下「頁面沒有 SAB」卻沒查 `main.js` 第 29 行。** 錯在：事實沒有先用 Grep 驗證就寫進文件，後來被推翻。下次怎麼做：文件裡寫的每個技術事實，先用 Grep 或實測確認，寫進去時附上來源（檔案與行號或評估結果）。
5. **繞路找 Electron、連續截圖。** 錯在：花了額外的步驟找 Electron 二進位檔，連續截圖消耗大量 token。下次怎麼做：用 `node_modules/electron/dist/electron.exe`（文件已記載），截圖只用在必要的驗證點，優先用評估檔讀 DOM 與 canvas 的像素。

### 9.7 下一個工作階段（後繼）

- 不由本工作階段開後繼。文件更新後由管理層決定是否開。
- 後繼開場先讀本檔 9.5（SAB 更正）與 9.6（教訓），再讀第 9 節的未驗證清單。

### 9.8 原先的後繼說明（已作廢，保留紀錄）

- 讀本檔第 1 節的開場提示（它仍然有效，改用本檔第 9 節的現況）。
- 先確認 `git log --oneline -5` 有 `929d4de7` 與 `9ec1871c`，再開始。

## 10. 交接 4（2026-11-03，gui-h2 在 context 約 27% 時寫；不自行開後繼，由管理層決定）

### 10.1 這個階段新增的提交（都未 push、未 publish；全部完成並驗證前不要說「可發布」，使用者原話：「後面gui橋接 *全部* 完成再publish」）

| commit | 內容 | 實機驗證（真 Electron，`FA_DISABLE_MAIN_OVERLAY=1`，評估檔在 scripts/eval/） |
|---|---|---|
| 1caf05e6 | `ask-ai-chat`（別名 `ask-floating-ai-assistant`）讀管線 stdin、輸出可接管線；stdin 依 contextWindowTokens 截斷（前六後四）；管線含 `; & > <` 時維持舊路徑 | `ask_ai_pipe.eval.js`：單獨、`cat\|ask`、`ask\|grep`、`cat\|ask\|wc`、舊名稱、usage 都對。**模型呼叫換成回聲，沒有驗證真模型的回答品質**。另有 `sab_probe.eval.js`（SAB 實測） |
| 7086733d | shell 的 `@gui` 行（輸出經 `_terminalFilterGuiLines` 套用、不顯示）與 `gui wait\|poll`（`_terminalGui`；變數、`--timeout`、超時 exit 124） | `gui_shell.eval.js`：echo 開視窗、按鈕事件存進變數、超時走 `\|\|` 分支、`@gui` 沒洩漏 |
| 986c2fc5 | `node 檔案.js`（`js_program.js` 移植 Redmine，sandbox 只有 allow-scripts；`_terminalNode`；嵌入 GUIJSPROGRAM，已加入 build-web-lazy 的 EXCLUDE） | `js_node.eval.js`：console.log、gui 視窗與事件、`parent.fa` 被擋、throw 印錯誤、找不到檔案。node 測試 3 項 |
| 09ea05a3 | 可縮放視窗改用應用程式共用外殼 `FaWin.decorate`（只套用在 resizable／maximizable 的視窗）；控制按鈕靠右、關閉最右；視窗寬度不再被 cssText 蓋掉；pygame `Surface.get_size` | `gui_resize.eval.js`：最大化後視窗 1904x1001＝頁面大小，畫布隨之 1902x974 並送出 VIDEORESIZE，還原再送一次；標題在左、按鈕靠右（量座標） |
| 102d9bc3 | `gen_missile_eval.js`（產生 missile 逐項驗證評估檔） | missile 原檔：點擊 shots 0→1、拖曳砲台 60／250、**Ctrl+滾輪**一格 ±12、方向鍵三次 +12、空白鍵發射、畫布 23 色 |

### 10.2 使用者指正（本階段，必須記住）

- 「他對最大化有誤解」「不是填滿terminal」：最大化是**蓋滿整個頁面**（跟應用程式其他視窗一樣，用 `FaWin`：☐ 最大化、⤢ 彈出、⛶ 全螢幕、八向縮放），不是填滿終端機區域。舊的 `gui_render.js` 自帶的最大化鈕（填滿終端機）只在沒有外殼時當備援。
- 「視窗控制的control button 應該要靠右」：標題在左，按鈕在右，關閉鈕最右。
- 「SharedArrayBuffer一直都有在用」：桌面版 `main.js:29` 已啟用；module Worker 內 `SharedArrayBuffer`＋`Atomics.wait` 實測可用（被主執行緒喚醒，值 7）。**技術選擇**：Python Worker 仍用 JSPI（`run_sync`），因為已實機跑通 gui.py 與 missile，SAB 沒有帶來額外能力；若之後要停掉死迴圈或網頁版備援再改。

### 10.3 還沒做（依序，下一項最先）

1. **map_viewer 實機驗證**：`C:\Users\sunneo\Downloads\redmine_ai_chat\examples\map_viewer.py`（pygame，滾輪／滑鼠移動／方向鍵／空白鍵）。做法照 `gen_missile_eval.js`：包一層換掉狀態輸出，用 DOM 事件操作畫布，從終端機輸出核對。若它沒有 RESIZABLE，resizable 已用 `gui_resize.eval.js` 的自寫程式驗過。
2. **打磚塊**：Redmine 沒有範例。**要先問使用者是否同意我另寫**，不要自己寫。
3. **AI 工具路徑（terminal_run）**：含 `import gui`／pygame 的 python、`node`、`gui`、`@gui` 行、`ask-ai-chat` 在 `terminal_run` 不會套用（見 9.2；`_runTerminalCommandForTool` 約在 `JS_INTERCEPTED_WITH_CAPTURE` 那段）。要不要接、怎麼接（AI 沒有人按按鈕，視窗會一直等）屬技術取捨，自己決定並寫理由。
4. **真模型驗證 ask-ai-chat**：用有設定模型的環境跑一次 `cat log | ask-ai-chat "摘要"`，確認 stdin 內容真的被模型看到（目前只驗證了提示詞內容）。
5. **剩餘小項**：Worker 的 `input()`／stdin 永遠 None；沒有 Ctrl+C 停止 Worker；重新顯示（add／set）時已彈出的視窗位置回到預設；程式結束後視窗不自動關閉（目前選擇）。
6. **打包核對（待辦 10）已查**：`FA_GUI_JSPROGRAM_SRC`、`FA_GUI_PYWORKER_SRC`、`FA_PYBRIDGE_FILES` 都在 `renderer/floating-assistant.js` 與 `.min.js`（`package.json` 的 `renderer/**/*` 包含、`!renderer/src/**` 排除原始碼；熱更新允許清單含這兩個檔）；`web-lazy/core.js` 刻意不含 GUIJSPROGRAM（EXCLUDE）。發布前由管理層再跑 `node scripts/embed-code-ui.js`、`node build-assistant.js`。
7. 全部完成後才回報「已提交，可發布，commit <hash>」，分開寫「真桌面版驗證過的」與「只有 node／Python 測試的」。

### 10.4 本階段教訓（補充到 9.6）

6. **殼層指令內嵌（heredoc／python 內嵌）又吃掉反斜線。** 錯在：用 Bash 的 heredoc 寫含 `\n`、`\d` 的程式，反斜線被吃掉，評估檔語法錯誤，來回修了三次。下次：含反斜線的程式一律用 Edit／Write 工具，或在程式裡改用 `String.fromCharCode(10)`、`[0-9]`。
7. **沒先查設計意圖就沿用「最大化＝填滿終端機」。** 錯在：前人這樣做，我驗證時只量到「填滿」就當通過，使用者才指正。下次：驗證前先找應用程式已有的同類功能（這次是 `FaWin`）與使用者的用語，不是只驗證現有行為。
8. **範例檔尾端直接呼叫 `main()`**（missile）：包一層要在 import 前去掉它，否則 monkey patch 來不及。`py_async` 只看被執行的那支檔案本身，包裝檔要自己 `import pygame` 才會走 Worker。
9. **評估檔偶爾「終端機掛載逾時」**：是環境暫時問題，重跑即可，不要誤判成程式壞掉。
10. **滾輪要 Ctrl**（一般滾輪保留給頁面捲動）：測試與說明都要寫 Ctrl+滾輪。

### 10.5 驗證指令（沿用第 2b 節）

```
node scripts/embed-code-ui.js && node build-assistant.js
FA_DISABLE_MAIN_OVERLAY=1 FA_DEBUG_EVAL_FILE=<評估檔絕對路徑> FA_BROWSER_CONTROL_PORT=17931 node_modules/electron/dist/electron.exe . --no-sandbox --disable-gpu --user-data-dir=<全新暫存資料夾>
node scripts/eval/gen_missile_eval.js <examples資料夾> <輸出評估檔>
```
node 測試：`renderer/src/gui/*.test.js`（gui_host 26、gui_render 40、gui_bridge 69、zenity 56、py_async 29、py_worker 24、js_program 3，全部通過）。

### 10.6 啟動測試實例的正確做法（管理層更正，2026-11-03）

- 全新 `--user-data-dir` 第一次啟動沒有 `main-ext-rev.txt`，`main-ext.js` 會把 `autoPrompt` 設為真，畫面自動跳出「發現新版本」對話框，按「立即更新」會把遠端版本蓋過工作目錄的實作。不用新增環境變數：啟動前在暫存資料夾預先寫入 `main-ext-rev.txt`（內容讀自 `main-ext.js` 的 `REV`，不要寫死）。
- 一律用 `node scripts/eval/run_eval.js <評估檔> [埠]`（已包含：暫存資料夾、預寫 rev、`FA_DISABLE_MAIN_OVERLAY=1`、換埠）。第 2b、10.5 節的手動啟動指令請改用它。
- 證明：`scripts/eval/no_update_dialog.eval.js` 讀 DOM，有預寫 rev 時 `update_dialog_shown:false`，對照組（沒預寫）`true`。畫面上的更新按鈕標籤也會寫「發現新版本」，那不是對話框，判斷對話框看有沒有「立即更新」。
- 不要在測試實例按「立即更新」。
- pygame `Surface.get_size` 已補（commit 09ea05a3），本次加測試；missile 重跑畫布 25 色（讀 canvas 像素，不是全黑）。

## 11. 本階段完成狀態（gui-h2 續作，2026-11-03；以本節為準，取代 10.3 的待辦）

### 11.1 待辦 10.3 的結果

| 項目 | 結果 | commit | 驗證 |
|---|---|---|---|
| 1. map_viewer 實機驗證 | 完成 | 108ea22d（評估檔產生器 `scripts/eval/gen_map_eval.js`） | 真 Electron，`run_eval.js`：Ctrl+滾輪放大 1→1.25 並保持游標下的點不動、再滾回 1；拖曳平移 (0,0)→(-40,-20)；方向鍵右三次 +60；空白鍵重設；畫布 32 色；載入的是工作目錄的 `renderer/floating-assistant.js` |
| 2. 打磚塊 | 完成（使用者同意「同意，另寫一支」，2026-11-03） | 2da1961e（`scripts/eval/gui_examples/breakout.py`、`scripts/eval/gen_breakout_eval.js`） | 真 Electron：發球後球會動；左鍵擋板 165→81；追球機器人 16 秒內打中 2 塊（分數 2）；漏接命數 3→2；按 × 後 exit 0 |
| 3. terminal_run（AI 工具路徑）接 gui／node／@gui／ask-ai-chat | 完成 | 99abda1a、03db07dc | `scripts/eval/ai_gui_cap.eval.js`（上限設 4 秒）：zenity 管線與單獨 exit 5 且視窗關閉；python gui exit 124 並印出逾時訊息、視窗關閉；node gui exit 124、視窗關閉；`gui wait` exit 124；回歸：不含 gui 的 python 輸出 2 |
| 4. 真模型驗證 ask-ai-chat | 完成（使用者答「用本機設定」） | 03db07dc（修正：AI 路徑的管線沒接上 ask-ai-chat） | 見 11.3 |
| 5. 剩餘小項 | 不實作，列為已知限制（見 11.4） | — | — |
| 6. 打包核對 | 完成（已再核對） | — | `renderer/floating-assistant.js` 與 `.min.js` 都含 `closeAll`、`guiAiTimeoutSec`、`FA_GUI_HOST_SRC`（Grep 計數 8／7／2） |
| 網頁版 JSPI 查證 | 完成（內建瀏覽器實測） | — | 見 11.5 |

### 11.2 本階段新增的提交（都未 push、未 publish）

- 108ea22d map_viewer 評估檔產生器
- 99abda1a AI 工具路徑接上 zenity／python gui／node gui／gui wait，並加 120 秒上限；`gui_host.closeAll`（gui_host.test.js 30 項通過）
- 2da1961e 打磚塊範例與評估檔產生器
- 03db07dc AI 路徑的含 ask-ai-chat 管線改走 `_terminalRunAiPipe`（跟互動路徑同一套）

node 測試（全部通過）：gui_bridge 69、gui_host 30、gui_render 40、js_program 3、py_async 29、py_worker 24、zenity 56。

### 11.3 真模型驗證（2026-11-03）

- 做法：`run_eval.js` 的同一套啟動，但另外把使用者本機的 `secrets.json` 複製進這次的暫存使用者資料夾，跑完刪除副本（原檔不動）。secrets.json 只含模型金鑰（欄位名稱：NVAPI_KEY、OPENROUTER_API_KEY），內容沒有寫進任何檔案或回報。
- 結果：`cat log.txt | ask-ai-chat "用一句話摘要…，並把專案代號原文寫出來"` 的回答含 `ORCHID-7`（這個代號只存在於 stdin 的文字裡），exit 0，約 5.4 秒。對照：不給 stdin 時回答「不知道」，沒有提到代號。stdin 確實被模型看到。
- 修正過程：第一次跑時管線報 `sh: line 4: ask-ai-chat: not found`，原因是 AI 路徑沒有接 `_terminalSplitAiPipe`（互動路徑有）。已修（03db07dc）。
- 未做：模型名稱、回答品質的評分（只驗證 stdin 可見）。

### 11.4 已知限制（交接 6 之後八條全部已修，見第 13 節；以下保留原文）

- Python Worker 的 `input()`／stdin 永遠回傳 None。
- 沒有 Ctrl+C 停止 Worker；程式不等視窗事件的死迴圈只能靠時間上限（AI 路徑）或關視窗（互動路徑，程式要有 wait／poll 才會收到 close）。
- 程式正常結束後視窗不自動關閉（互動路徑與 AI 路徑都是）。
- 重新 show（add／set）時已彈出的視窗位置回到預設。
- AI 路徑的 stdout 仍會含 `@gui` 行（視窗會正確開啟，只是行本身沒有從回傳的 stdout 移除）。
- 複合指令裡 JS 攔截段的 `$?` 不會帶到下一段（既有限制，不是 GUI 造成）。
- 時間上限（`session.guiAiTimeoutSec`）是整個終端機 session 的狀態：terminal_run 呼叫期間，同一個 session 裡使用者自己打的 GUI 等待也會被限制（120 秒）。
- `terminal_run` 包裝裡的 120 秒預設，只有程式碼檢查，沒有用 terminal_run 工具本身實機呼叫過（評估檔是直接呼叫 `_terminalRunCommand` 並手動設上限）。

### 11.5 網頁版 JSPI 查證（2026-11-03，內建瀏覽器，Chromium 152）

- `typeof WebAssembly.Suspending === 'function'`：true（JSPI 可用）。
- 未隔離的一般網頁：`crossOriginIsolated` 為 false，`SharedArrayBuffer` 為 undefined（所以網頁版不能用 SAB＋Atomics.wait，除非網頁有 COOP／COEP 標頭）。
- 結論：管理層決定的「Python 同步等待維持 JSPI」在網頁版的 Chromium 系瀏覽器可以跑。Firefox 與 Safari 的支援狀況沒有實測，不寫成事實。
- 注意：這次只驗證了 JSPI 的存在；網頁版的 Pyodide 完整流程沒有在網頁上跑過（只有桌面版的 Electron 實機跑過）。

### 11.6 教訓（本階段，每條：錯在哪、下次怎麼做）

1. **評估檔的滑鼠與滾輪沒有先點一下，就以為是程式壞掉。** 錯在：`.ai-chat-wheel-on` 閘門只在真的 mousedown 後加上，`cv.focus()` 不夠，滾輪事件被丟掉，縮放沒變。下次怎麼做：每個含滑鼠或滾輪的評估檔，先送一次 mousedown／mouseup（不做事）再操作。
2. **範例檔取名 `gui.py` 會遮住 gui 模組。** 錯在：`import gui` 先找到 cwd 的 gui.py，報「partially initialized module」。下次怎麼做：測試程式不要用內建模組的名字。
3. **只改 AST 執行器，單行指令根本不經過它。** 錯在：我先把 python gui 的判斷加在 `_terminalExecSimpleCommand`，單行 `python3 x.py` 走的是 `_terminalRunCommand` 的快速路徑，改了也沒用，還以為是 Worker 的問題。下次怎麼做：每個攔截都要在兩個入口（單行快速路徑、含 `;` 的 AST 路徑）各測一次；這次的做法是把單行判斷放進 `_terminalRunCommand` 的攔截區。
4. **壓縮產物的識別字會被改名，不能用變數名判斷載入的程式是不是新的。** 錯在：我用 `String(fa._terminalExecSimpleCommand).includes('restArgsQuoted')` 驗證，結果 false，誤以為改動沒載入。下次怎麼做：用字串常值（例如 `'python3'`）或行為（超時是否回傳 124）驗證；`renderer/floating-assistant.js` 是壓縮過的，`grep -c 變數名` 不可靠。
5. **node 沙盒的程式要用頂層 await。** 錯在：包成 IIFE 的 async 函式，沙盒不等它，程式 exit 0 而且沒有印出任何東西。下次怎麼做：照 `js_node.eval.js` 的寫法，頂層 `await gui.open(...)`。
6. **AskUserQuestion 的題目至少要有兩個選項。** 錯在：多塞了一題空的，整個呼叫被拒絕。下次怎麼做：只問有兩個真正選項的題目。
7. **AI 路徑的管線沒有跟互動路徑同步。** 錯在：`_terminalRunCommand` 與 `_runTerminalCommand` 是兩套入口，我只在一邊接了 AI 段。下次怎麼做：新增攔截或管線判斷時，檢查兩個入口是不是都要改（`grep -n "_terminalSplitAiPipe\|_terminalRunCommand(" 檔案`）。
8. **沒有先確認使用者目前的環境。** 錯在：我一開始沒有查模型金鑰放在哪；使用者要求「用本機設定」才去找。下次怎麼做：需要使用者本機資料的驗證，先問，再只複製需要的檔案，跑完刪副本、不印出內容。

### 11.7 驗證指令（本階段用的）

```
node scripts/embed-code-ui.js && node build-assistant.js
node scripts/eval/gen_map_eval.js <examples資料夾> <輸出評估檔>
node scripts/eval/gen_breakout_eval.js <輸出評估檔>
node scripts/eval/run_eval.js scripts/eval/ai_gui_cap.eval.js 17933
node scripts/eval/run_eval.js <map 或 breakout 評估檔> 17932
```
真模型驗證的評估檔與啟動器在 gui-h2 的暫存資料夾，沒有進 repo（依賴使用者本機的金鑰）；做法見 11.3。

## 12. 交接 6（2026-11-03，gui-h2 續作在 context 33% 時寫；不自行開後繼，由管理層決定）

### 12.1 開場提示（貼給接手的工作階段）

Continue from the handoff document at desktop-app/DESIGN.TODO.gui-bridge.md (repo root D:\Downloads\videos-嗨投資-desktop-app\desktop-app, branch desktop-app). Read it fully, especially section 12 (current status, half-done items and resume points) and section 12.5 (verbatim words), then section 11.6 and 12.6 (lessons). Follow the working style there. Run the low-context-long-run skill: do the next todo item in 12.3, and when your context reaches 30%, update this document, commit, and report 「需要接手，文件已更新，commit <hash>」 to the manager; do not start your own successor. Quote the user's key instruction verbatim: 「python的input回傳none, 沒有ctrl+c的問題必須修掉」「複合指令的$? 必須帶到下一段」「那些限制都必須修正」. Reply to the user in Traditional Chinese only, no English abbreviations inside Chinese sentences. Do not push and do not run publish.sh. First message: one line saying you read the document and which item you start.

### 12.2 管理層指示（2026-11-03，原文，經管理層轉達）

「python的input回傳none, 沒有ctrl+c的問題必須修掉」「複合指令的$? 必須帶到下一段」「那些限制都必須修正」。11.4 的八條已知限制全部要修，不可再列為已知限制。每條先寫會重現的測試（node 與真桌面版評估檔，用 `scripts/eval/run_eval.js`）再修，每修好一條就提交，真桌面版驗證與只有 node 測試的要分開寫。全部做完並驗證後才回報「已提交，可發布，commit <hash>」，中途只回報進度。打磚塊：使用者已選「同意，另寫一支」（見 11.1 第 2 項），所以不必再問；在教訓裡已更正（見 12.6 第 1 條）。

### 12.3 八條的狀態（每條對應 11.4 的限制）

| 條 | 內容 | 狀態 | 位置／證據 |
|---|---|---|---|
| 7 | 時間上限改成呼叫範圍，不放 session | **完成（已實機）**：`session_has_cap: false`；`ai_gui_cap.eval.js` 全部通過 | `terminal_run` 包裝改成 `_terminalRunCommand(session, cmd, { ..., guiTimeoutSec: 120 })`，沿 opts 往下傳到 `_terminalZenity`／`_terminalGui`／`_terminalNode`／`_terminalTryPythonAsync`（第三個參數 `guiTimeoutSec`）；session 上已沒有 `guiAiTimeoutSec` |
| 6 | 複合指令 `$?` 帶到下一段 | **進行中（半完成，未全部驗證）**，見 12.4 | `exit_code_chain.eval.js` |
| 5 | AI 路徑 stdout 移除 `@gui` 行 | **程式已改、未驗證** | `_terminalWriteOutput` 回傳過濾後文字；`_terminalRunWasmLine` 的 onOutput 用它當 stdout（或 `_terminalFilterGuiLines`） |
| 4 | 重新 show 保留視窗位置與大小 | **程式已改、未驗證** | `renderer/src/gui/gui_host.js` `show()`：`prev` 原本在有外殼（`shells[winId]`，可縮放／可最大化）時不擷取，現在一律擷取（外殼是套在同一個元素上，`FaWin.decorate(el)`） |
| 3 | 程式結束後收掉它開的視窗（互動與 AI） | **未開始** | 設計：在 `_runTerminalCommand`（互動）與 `terminal_run` 包裝（AI）記錄開始前已開的視窗 id，結束時 `host.close` 掉新開的；python worker `finish` 與 node 結束也要收 |
| 2 | Ctrl+C 中止執行中的程式（exit 130，含死迴圈） | **未開始** | 先找終端機鍵盤輸入的接收處（`term.onData` 或同等，用 Grep），在前景程式期間攔截 `\x03`：呼叫 session 上登記的 abort（python worker 用 `terminate` 後重建、node 用 `js_program` 的 abort promise、zenity／gui wait 用 host.close）；收窗、印 `^C`、回提示字元、結束碼 130 |
| 1 | `input()`／`sys.stdin` 真的讀得到 | **未開始** | 做法：worker 的 RUNNER 裡 `input` 與 `sys.stdin.readline` 改呼叫 `run_sync(js_stdin_readline())`（同 gui 的 JSPI 路徑，已實機可用）；頁面端把終端機的輸入行（Enter 送出）或管線 `opts.stdin` 的內容排進佇列回覆；沒有輸入來源（AI 路徑沒給 stdin）時回 EOF（`EOFError`），不要永遠等 |
| 8 | 用真 `terminal_run` 工具路徑實機呼叫一次 | **未開始** | 要找到註冊的 `terminal_run` handler 能從評估檔呼叫（`registerOptional('terminal_run', ...)` 附近，約 62830 行，用 Grep 找它怎麼存放）；呼叫時傳入 JSON 字串，檢查回傳的 JSON（exit_code、stdout） |

### 12.4 第 6 條的確切狀態（續作入口）

已做（都在 `renderer/src/floating-assistant.js`，未提交前的工作樹內）：
- `TERMINAL_COMPOUND_INTERCEPT_NAMES` 補上 `zenity`、`python`、`python3`。
- `_terminalGroupCompoundLine`：含頂層 `&&`／`||` 的段（且第一個字不是 if／for 等控制字）→ `{type:'andor'}` 群組；其他 JS 名單的段維持 `js`。
- 新方法 `_terminalSplitAndOr(text)`（引號內不切）與 `_terminalRunAndOr(session, text, opts)`（短路執行，每段用 `_terminalRunCommand`，每段後 `_terminalSetExit`）。
- 三個群組迴圈（AI 的 `_terminalRunCommand`、互動的 `_runTerminalCommand`）都認得 `andor`；AI 的群組迴圈每段後 `_terminalSetExit`。
- `_terminalSetExit` 也寫在：AST 的 JS 攔截分支（`_terminalExecSimpleCommand` 的 captured 之後）、`_terminalRunCommand` 的 JS 攔截分支（`tExit`）、互動的 zenity／node／gui 分派。

評估 `scripts/eval/exit_code_chain.eval.js`（上一輪結果，build 之後）：
- AI 入口：`;` 的 zenity／sleep／gui wait／python gui／node gui／ask-ai-chat 的 `$?` 全部正確；`&&`／`||` 短路正確（`zenity && echo` 不印、`zenity || echo` 印）；`if zenity; then … else …` 正確（IFGOOD）。
- AI 入口未過：`for i in 1; do zenity --entry --timeout=1; echo M8:$?; done` 得到 0，應為 5。未查出原因。可能是 `for` 整段沒有進 AST 的 JS 分派（先在 `_terminalExecSimpleCommand` 加一行 `console`/寫入 `session.term` 看它有沒有走到 zenity），或 for 迴圈內的 `$?` 在同一個 wasm 腳本裡展開。
- 評估檔的錯誤（已修）：`and_ok` 的 `bad` 寫錯（`sleep 0 && echo ANDGOOD` 成功時應該印出 ANDGOOD）。
- 評估檔的錯誤（未修）：互動入口的判斷用 `termText(session).slice(before)`，但 xterm 有捲動上限，長度對不上，所以全部判成失敗（`tail` 欄位顯示輸出其實都在）。修法：每個案例用不同的標記（例如把 `M<n>` 換成 `I<n>`），在整個 `termText` 裡找 `I<n>:<值>`；`bad` 字串只在不含 `/work $` 提示字元的行裡找（指令回顯會含 bad 字串）。
- 互動入口的 `ask-ai-chat` 用法行確實印出（`usage: ask-ai-chat …`），但 `_terminalSetExit` 沒有加在互動的 ask 分派上（`if (cmdName === 'ask-floating-ai-assistant' || …)` 那一行），還需要補。

### 12.5 使用者與管理層原話（逐字，依時間；仍然有效）

- 2026-11-03（管理層轉達使用者原話）：「python的input回傳none, 沒有ctrl+c的問題必須修掉」「複合指令的$? 必須帶到下一段」「那些限制都必須修正」
- 2026-11-03（AskUserQuestion 答覆，使用者）：「同意，另寫一支」（打磚塊）；「用本機設定」（真模型驗證）
- 以下更早的原話仍有效，見第 6 節與 11.1：「後面gui橋接 *全部* 完成再publish」「馬上implement!!!」「用中文跟我溝通」

### 12.6 教訓（本輪；每條：錯在哪、下次怎麼做）

1. **更正：打磚塊不是擅自寫的。** 我先用 AskUserQuestion 問過使用者（「打磚塊 Redmine 外掛沒有範例，要我另寫一支 pygame 打磚塊來驗證嗎？」），使用者答「同意，另寫一支」，之後才寫。管理層轉達時寫成「你當時沒先問使用者就自己寫了」，這與事實不符。文件與回報裡以這裡為準；使用者仍可選擇保留或移除 `scripts/eval/gui_examples/breakout.py`（2da1961e）。
2. **單行指令與複合指令走不同入口。** 攔截要在單行快速路徑與含 `;` 的 AST 路徑各測一次；`_terminalGroupCompoundLine` 的 JS 名單與 AST 的分派是兩份名單，改一處忘另一處會出錯。
3. **`&&`／`||` 在 AST 裡不被認得。** 整串會被當成一個指令的參數（`sleep: 不合法的時間長度「0 && echo …」`）。下次別以為 AST 能處理所有運算子，先用評估檔看 argv。
4. **評估檔自己也會寫錯期望。** `and_ok` 的期望寫反，我先當成程式錯；結果看起來像故障，其實是測試錯。每次看到失敗，先看 `shown` 的實際輸出再判斷。
5. **互動入口的評估檔不能用字元長度切片。** xterm 有捲動上限，`before` 位置會失效；用標記搜尋。
6. **`$?` 的來源是 session.lastExitCode**（wasm 腳本開頭的 `_fa_rc`）。任何 JS 段跑完都要 `_terminalSetExit`，否則下一段的 `$?` 是舊值。

### 12.7 本輪改動的提交狀態

- 這一輪的工作樹改動在 `renderer/src/floating-assistant.js`、`renderer/src/gui/gui_host.js`、`scripts/eval/ai_gui_cap.eval.js`、`scripts/eval/exit_code_chain.eval.js`（新檔）。build 產物（`renderer/floating-assistant*.js`、`update-manifest.json`、`web-lazy/*`）沒有提交，依規則不提交。
- 已提交的 WIP 見本文件末尾的 commit（12.8）；WIP 的狀態是「未全部驗證」，續作者要先重跑 `scripts/eval/ai_gui_cap.eval.js` 與 `scripts/eval/exit_code_chain.eval.js` 確認沒有回歸。

### 12.8 續作者的第一步

1. `node scripts/embed-code-ui.js && node build-assistant.js`，然後 `node renderer/src/gui/gui_host.test.js` 等 node 測試。
2. `node scripts/eval/run_eval.js scripts/eval/ai_gui_cap.eval.js 17950` 必須全部通過（這是 7 項已完成的回歸）。
3. 修 `exit_code_chain.eval.js` 的互動判斷（12.4），再看 `for_zenity`。
4. 依 12.3 的表，第 5、4 項先用評估檔驗證（5：`echo '@gui …'` 的 AI 呼叫 stdout 不含 `@gui`、視窗開；4：可縮放視窗設定 `style.left/top` 後送 `add` op，位置不變）。
5. 然後第 3、2、1、8 項。每修一條就提交，並在 12.3 更新狀態。

### 12.9 交接程序（自我遞迴）

執行 low-context-long-run 技能（門檻 30%）。做完一批、通過測試、提交後看 `mcp__ccd_session_mgmt__get_usage`；到 30% 就更新本節、提交、回報「需要接手，文件已更新，commit <hash>」，不自行開後繼。

## 13. 交接 7 結果（Sonnet，2026-11-03）：11.4 的八條全部修完並實機驗證

全部用 `node scripts/eval/run_eval.js <評估檔> <埠>`（真 Electron、全新資料夾、換埠），每個評估檔輸出的 `loaded.scripts` 指向工作目錄的 `renderer/floating-assistant.js`。

| 條 | 內容 | commit | 評估檔 | 結果 |
|---|---|---|---|---|
| 7 | 時間上限只跟呼叫 | 3e773200 | ai_gui_cap | 通過（本輪再跑，無回歸） |
| 6 | 複合指令 `$?` | c85bcd76 | exit_code_chain | AI 與互動兩個入口各 12 案例全過。根因：for 的迴圈變數賦值（`i=1;`）把 `$?` 洗成 0，`_terminalBuildEnvPrefix` 後補回 `_fa_rc`；互動的 ask-ai-chat 補寫結束碼；評估檔互動判斷改用 I<n> 標記 |
| 5 | AI 路徑 stdout 移除 `@gui` | 9551970e | gui_stdout_pos | stdout 為空字串。根因：全是 `@gui` 行時 outBuf 空，退回原始 stdout |
| 4 | 重新 add 保留位置大小 | 9551970e | gui_stdout_pos | 77/55/333/222 保持。註：評估是在修好後寫的，沒有先看到失敗的版本 |
| 3 | 程式結束收窗 | 9039d5c3 | gui_autoclose | python／node 正常與出錯結束，互動與 AI 都收掉；`@gui` 行開的視窗保留 |
| 2 | Ctrl+C | 9c316a70 | ctrl_c | 走真的 `_handleTerminalInput`：python 死迴圈、python 等視窗、node 死迴圈、zenity 都在毫秒內停止，視窗收掉，結束碼 130，下個指令正常（Worker 每次新建） |
| 1 | input／stdin | bcfe7c39 | py_stdin | 互動（提示、打字、Backspace、Enter、sys.stdin.readline）、管線（互動與 AI；read() 讀全部）、AI 沒給輸入＝EOF（4 秒內 EOFError，不等）、等輸入時 Ctrl+C=130、不讀輸入的 python 不變 |
| 8 | 真 terminal_run 工具 | 本節所在 commit | terminal_run_tool | `fa.tools.terminal_run.callback(JSON)`：echo 正常；沒人按的 zenity 120019 毫秒、exit 5、視窗收掉 |

### 技術取捨（自己決定）
- 讀輸入的 python（`input(`、`sys.stdin`）也走 Worker（`py_async.js`），因為同步 python 沒辦法在呼叫處等一行；Worker 的 `input` 與 `sys.stdin` 在 RUNNER 的 `go()` 裡換成呼叫橋接 `stdin.readline`（JSPI），頁面端 `_terminalReadStdinLine`。
- 管線尾端的 python 用 `_terminalSplitPyPipe`：先 probe 確認會走 Worker 才跑前面的段，避免前面的段跑兩次。
- Ctrl+C：前景程式用 `_terminalRegisterAbort` 登記中止函式；Worker `terminate`、node 移除 iframe；zenity 與 `gui wait` 靠 `closeAll`；`session._sigint` 讓結束碼固定 130。

### 沒做、要明講
- `python x.py; echo 後面` 這種複合行，Ctrl+C 只中止目前這支程式，後面的段仍會接著跑（真的 shell 會整行中止）。
- `sleep` 沒有登記中止函式，Ctrl+C 打不斷。
- `SystemExit(3)` 在 Worker 路徑結束碼是 1（既有行為，沒改）。
- 互動輸入只處理可印字元、Backspace、Enter、Ctrl+D；方向鍵與游標移動沒做。
- 沒有視覺截圖（全部讀 DOM／終端機文字）。

### 教訓（本輪）
1. Bash 的 heredoc、Python 內嵌會吃反斜線（`\n`、`\b` 變成真換行與退格字元），這次又發生三次（js_program.js、py_async.js、測試檔）。含反斜線的修改一律用 Edit 工具，或用 Write 寫成 node 腳本並用 `String.fromCharCode(92)`。
2. 評估檔先確認「前提成立」：autoclose 第一版沒看到視窗存在就以為通過，加了 MutationObserver 與保留視窗才算數。
3. Windows 上 `node -e` 讀 stdin 會 EOF 失敗，改輸出到檔案再解析。

## 14. 給接手者（Haiku）的一步一步（交接 7 收尾，2026-11-03）

八條都已完成，沒有半成品。還沒修的只有第 13 節「沒做、要明講」那幾項，使用者沒有要求就不要開新的一條。

### 還沒修的限制與驗收做法
| 限制 | 接續點 | 驗收 |
|---|---|---|
| 複合行 Ctrl+C 後，後面的段仍會跑 | `_terminalInterrupt` 設了 `session._sigint`；`_runTerminalCommand` 的群組迴圈、`_terminalRunAndOr`、`_terminalExecShellNode` 的 For／While／Sequence 迴圈每段開始前檢查它，為真就停 | 在 `scripts/eval/ctrl_c.eval.js` 新增案例 `python3 spin.py; echo AFTER`，Ctrl+C 後終端機文字不含 AFTER，結束碼 130 |
| `sleep` 打不斷 | `_terminalSleep` 內用 `_terminalRegisterAbort` 登記，中止時清 timer 並 resolve | 同上評估檔加 `sleep 30` 案例，毫秒內回提示字元 |
| `SystemExit(3)` 結束碼是 1 | `renderer/src/gui/py_worker.js` 的 `go()` 捕捉 SystemExit 取 code，done 訊息帶回 | `scripts/eval/gui_autoclose.eval.js` 的 py_exit3 案例，預期 exit 3 |
| 互動輸入沒有方向鍵 | `_terminalStdinFeed` | 不急，使用者沒要求 |

### 一步一步（每步一個動作，附可檢查的結果）
1. 讀本檔第 13、14 節。檢查：能說出八條各用哪個評估檔。
2. `git log --oneline -3`。檢查：看得到 4021f5b1 或更新的提交。
3. 改程式只用 Edit 或 Write 工具，不要用 Bash 的 heredoc 或 python 內嵌（會吃反斜線，這輪壞了三次）。檢查：改完用 `node --check` 或對應的 node 測試。
4. 改 `renderer/src/gui/*.js` 或 `renderer/src/floating-assistant.js` 後，先跑 `node scripts/embed-code-ui.js && node build-assistant.js`。檢查：指令沒報錯。
5. 寫評估檔，先確認前提真的成立（例如視窗真的存在、目標程式真的在跑），再斷言結果。檢查：沒修時評估檔必須失敗。
6. 跑 `node scripts/eval/run_eval.js scripts/eval/<檔>.eval.js <埠>`，輸出存到暫存檔再 grep `eval-file] result`（不要用管線讀 stdin）。每個評估檔用不同的埠。檢查：`loaded.scripts` 指向工作目錄的 `renderer/floating-assistant.js`。
7. 回歸三個評估檔：`ai_gui_cap`、`exit_code_chain`、`ctrl_c`，加 `renderer/src/gui/*.test.js` 全部。檢查：與第 13 節的數字相同。
8. 提交只用 `git add <明確路徑>`；不提交 `renderer/floating-assistant*.js`、`update-manifest.json`、`web-lazy/*`、`test-reports/*`、`.claude/launch.json`。訊息結尾加 Co-Authored-By 行。檢查：`git status` 沒有誤加。
9. 不 push、不跑 publish.sh，發布由管理層做。回報用繁體中文，不夾英文縮寫，並分開寫真桌面版驗證過的與只有 node 測試的。

### 常見坑
- 單行指令走 `_terminalRunCommand` 的快速路徑，含 `;` 走 AST，互動輸入又是 `_runTerminalCommand`；新增攔截要三個入口各測。
- `$?` 的來源是 `session.lastExitCode`，任何 JS 段結束都要 `_terminalSetExit`。
- 壓縮產物的變數名不可靠，驗證載入用字串常值或行為。
- 評估檔偶爾「終端機掛載逾時」是環境暫時問題，重跑即可。

## 15. 最後三項限制修完（Haiku，2026-11-03）

| 步驟 | 內容 | commit | 評估檔 | 修前 → 修後 |
|---|---|---|---|---|
| A | 複合行 Ctrl+C 後後段不再跑 | 8da55371 | ctrl_c（新增 py_compound） | after_ok true → false，結束碼 130，下一個指令正常 |
| B | sleep 可被 Ctrl+C 打斷 | 9fd8d764 | ctrl_c（新增 sleep_30） | 8003 ms、busy 不歸零 → 7 ms、busy 歸零、結束碼 130 |
| C | SystemExit(n) 結束碼是 n | 7a9cbcb1 | gui_autoclose（新增 boom_sys、boom_exit、err） | sys.exit(3)／exit(3)／raise SystemExit(3) 都是 1 → 都是 3；正常 0、未捕捉 1 |

- 驗證方式：`node scripts/eval/run_eval.js <評估檔> <埠>`（真 Electron、全新資料夾、換埠），每個評估檔的 `loaded.scripts` 都指向工作目錄的 `renderer/floating-assistant.js`。
- 回歸：ctrl_c 6 案例全部 130 且下一個指令正常；exit_code_chain 24 項 ok 全為真；gui_autoclose 的 AI 與互動兩個入口一致；`renderer/src/gui/*.test.js` 全部通過。
- 沒驗證：`sys.exit("文字")` 印到 stderr 後結束碼 1 的路徑；視窗外觀；使用者真的用鍵盤按 Ctrl+C（評估檔是走 `_handleTerminalInput` 送 `\x03`，不是作業系統層級的鍵盤）。
- 做法：A 在群組迴圈、`_terminalRunAndOr`、`_terminalRunUnits`、shell 的 Sequence／AndOr／For／While 每段前檢查 `session._sigint`，Sequence 的批次送出也檢查；B 用 `_terminalRegisterAbort` 登記，中止時清計時器；C 在 Worker 的 `go()` 用 try/except SystemExit 回傳結束碼。

### 教訓（Haiku）
1. **shell 的工作目錄會殘留。** 錯在：前一條指令 `cd` 進了 `renderer/src`，後面的 `node scripts/...` 全部找不到檔案，我以為是工具壞了。下次怎麼做：每條 Bash 指令開頭都用絕對路徑 `cd "…/desktop-app"`，錯誤訊息先看路徑再判斷。

---

## 原檔：harness-skill

# 交接文件：把弱模型 harness（offline-trainer、UML design、CoLU）做成 skill，並讓經驗回流（handoff 1，2026-11-01）

## 1. 開場提示（給接手的工作階段）
Continue from the handoff document at `D:\Downloads\videos-嗨投資-desktop-app\desktop-app\DESIGN.TODO.harness-skill.md`. 先完整讀完（含使用者原話與做法備忘），照做。工作目錄 `D:\Downloads\videos-嗨投資-desktop-app\desktop-app`。**開工前先確認沒有別的工作階段（音樂線、補完與驗證線）正在跑並改同一個工作樹；有就先只讀、寫設計文件，不碰 `renderer/src/floating-assistant.js` 與 `scripts/embed-code-ui.js`。** 第一則訊息用一行說明你讀完了、要開始哪一項。回覆一律繁體中文、不要夾英文縮寫。不要長篇規劃、不要問，直接讀、寫、測、提交。發布由管理層代發：你不要執行發布腳本，每項提交後在回報最後一行寫「第 N 項已提交，可發布，commit <hash>」。到 context 門檻（30%）時更新本文件、提交，回報最後一行寫「需要接手，文件已更新，commit <hash>」（子工作階段在這個 app 不能自己啟動接手）。**（2026-11-01 更新：本週額度實際約 15%，五小時額度才是瓶頸；88% 是上一個週期的舊數字。）跑模型的實驗（第 4 項）要小樣本、記錄用量，不要大量呼叫。**

## 2. 結論與大方向（先說）
**有機會，而且大部分零件已經存在。** 使用者的想法：offline-trainer、UML design、CoLU 這一整套「讓小模型／弱模型也能把事情做對」的機制，其實是一個**弱模型 harness**；它可以包成 **skill**（Claude 格式 `SKILL.md`＋`scripts/`＋`references/`），讓像 `claude-haiku-5.5` 這種小模型在它的帶領下執行任務，品質有保證；而 harness 處理問題時得到的**經驗，適合的要回流補進 offline-trainer**——也就是 offline-trainer 不只是名義上的離線訓練器，而是 harness 的「學習層」。

做法的骨架（細節由接手者依現有文件落實）：
1. **harness 當 skill**：`SKILL.md` 教模型用「迴圈」：呼叫 `node scripts/harness.js next` 拿到一題**封閉選擇題／填空**（字母、編號、固定欄位），模型只回答，`node scripts/harness.js answer <答案>` 交給程式核對、前進下一步；程式負責路由、欄位、驗證、預設退路，模型只當「字母神諭」。這跟專案現有的 CoLU 形狀一致（字母選擇題、程式檢查、程式預設退路）。純函式核心（UMD）在 node 就能跑，不需要 Electron。
2. **Haiku 當試金石**：用 `claude-haiku-5.5`（模型代號以 Claude Code 當下可用的為準，名稱不確定就先查）當「故意選的小模型」，A/B 比較：**光桿 Haiku** vs **Haiku＋harness**，同一組任務、同一套評分（沿用 `renderer/src/catalog/colu_bench_core.js` 的評測題與評分），證明 harness 確實拉高品質、而且穩定。
3. **經驗回流**：harness 每次跑完留下一筆「經驗紀錄」（任務簽名、走的路線、每步的選擇與程式核對結果、最後判定）；**回流閘門**（程式決定，不靠模型自述）：只收「程式驗證過的成功」，去重（簽名相同只留一筆並累計次數）、去識別（路徑、金鑰、個資遮蔽）、大小上限；通過的寫進 offline-trainer（成功案例／語意 pattern，來源標 `harness`，使用者可停用、可刪）；失敗的產生 UML 編修候選（`renderer/src/uml/uml_edit_core.js`），不直接寫進知識。
4. **改名定位**：UI 與文件把 offline-trainer 的定位改為「harness 的學習層」（名稱可保留，旁邊加說明），避免只被當成「離線用」。

## 3. Todo（依序）
1. **讀與對照（短）**：讀 `DESIGN.offline-harness.md`、`DESIGN.offline-trainer.md`、`DESIGN.offline-trainer-roadmap.md`、`DESIGN.colu.md`、`DESIGN.colu-porting.md`、`DESIGN.uml-framework.md`、`DESIGN.skill-recipes.md`、`DESIGN.offline-recipes.md`、`DESIGN.offline-plans.md`；看 `renderer/src/catalog/`（`colu_bench_core.js`、`relu_core.js`、`select_core.js`、`reflect_core.js`、`rank_train.js`）、`renderer/src/recipe/`（`recipe_core.js`、`plan_core.js`、`skill_compile_core.js`＝技能→食譜編譯器）、`renderer/src/uml/`。寫 `DESIGN.harness-skill.md`（新檔，一頁）：harness 的零件地圖（哪個檔案負責路由／規劃／選擇／驗證／學習）、已有什麼、缺什麼，**缺口要具體到檔案與函式**。已有就說已有，不要重做。
2. **skill 套件**：`skills/weak-model-harness/`（參考既有的 `skills/image-decompose-redraw/` 格式與 `.claude/skills/publish-live-update-patch/`）：`SKILL.md`（frontmatter＋迴圈使用說明，用中文，**說明裡不要出現反引號包住的 code span 造成歧義的寫法？——SKILL.md 是檔案不受 JS 字串限制，可用**）、`scripts/harness.js`（命令列：`start <任務>`、`next`、`answer <答案>`、`status`、`learn`，狀態存成 JSON 檔以便跨呼叫、可中斷續跑）、`references/`（封閉題型說明）。核心用 `require` 載入現有 UMD 模組（路徑相對於 repo；套件要能搬走時，另有打包腳本把用到的核心複製進 `scripts/vendor/`）。測試：`scripts/harness-tests/`（用假模型跑完整迴圈：完美、亂答、沉默、連線失敗，程式核對與預設退路都要驗到）。
3. **經驗與回流閘門** `renderer/src/harness/experience_core.js`（`FaHarnessExp`，UMD，測試 `scripts/harness-tests/experience.test.js`）：紀錄格式、簽名、去重累計、去識別、大小上限、`gate(record)`→`{accept, reason}`（所有拒絕都附原因）、`toTrainer(record)`→訓練器 pattern／案例（沿用 `editor_cases` 的存法：`renderer/src/edit/edit_cases.js`，成品大的放獨立資料表，pattern 小）、`toUmlEdit(record)`→UML 編修候選。接進 harness.js 的 `learn`。**新增資料格式要定義版本與 migration。**
4. **Haiku 實驗（小樣本，記用量）**：先 `mcp__ccd_session_mgmt__get_usage` 記下起點；用 `claude -p --model <haiku 代號> --output-format json`（無頭模式）或使用者設定的金鑰，跑固定的小題組（例如 CoLU bench 抽 12～20 題，涵蓋路由、填欄位、接線、規劃），**兩組**：光桿 Haiku、Haiku＋harness（迴圈由腳本驅動，模型每次只收到一題封閉題）。記錄：通過率、重試次數、格式違規率、平均每題 token；結果與用量寫進 `DESIGN.harness-skill.md`。**如果無頭模式或模型代號不可用，照實寫「未驗證」並用假模型示範，不要編造數字。**
5. **回流前後對照**：把第 4 項裡「程式驗證過的成功」經 `gate` 寫入訓練器，再跑一次同題組，記錄有沒有進步（尤其是路由與預設值的命中），誠實報告沒進步的部分。
6. **UI 與文件定位**：離線訓練器的說明文字與設定頁（`floating-assistant.js` 搜 `offline_trainer`／訓練器面板）加上「harness 的學習層」與「來自 harness 的經驗」來源標示、可停用可刪；`features/ai-features.yaml` 清冊新增條目（`node scripts/ai-features.js check` 通過再 `build`）；`node scripts/embed-code-ui.js && node build-assistant.js`；`node scripts/run-core-tests.js` 沒有新增失敗（新測試加進清單）。
7. 發布由管理層代發；把「做到哪、哪些未驗證」寫進文件。

## 4. 做法備忘（使用者的規則）
- 繁體中文、結論先說、不要在中文裡夾英文縮寫；做完誠實說哪些沒驗證。沒驗證就寫「未驗證」。
- **UML design 的意思**（使用者定義）：由上而下持續規劃、細切到不可再切，再用 CoLU 接線；弱到不能規劃時用樣板；不是寫死流程。CoLU 思考外殼：字母選擇題、程式檢查、程式預設退路；模型輸出一律由程式核對。
- 回流只收**程式驗證過**的成功，不信模型自述（記憶：宣稱要用磁碟驗證）。
- 改來源模組再嵌入；不要改嵌入後那份。改檔用 Edit／Write；Bash heredoc 內的 Python 會吃掉反斜線與中文，需要時用 Write 工具寫 `.py` 檔再執行。
- 編譯前會清工作目錄：做到一半也先 commit。給了順序就做到底，不要中途問。
- 資料庫結構或記憶格式有改，必須定義版本與 migration。
- 工具說明文字用中文引號，不要反引號 code span（JS 字串內）。
- 熱更新：舊版也要收得到、不准要求重裝；新檔案要進 live patch 與網頁版清單。
- 工作樹有不是你改的檔案：不要放進你的提交，也不要還原。

## 5. 使用者原話（逐字，2026-11-01）
- 「我有一個想法，幫我實現，我們的offline-trainer, uml-design, CoLU可以是小模型，弱模型的harness，他有沒有機會成為skill。舉例來說，我們可以故意拿claude-haiku-5.5 當小模型的案例，來確保執行品質。 在這個harness處理問題時得到的經驗、適合回流進去處理的，可以補回到offline-trainer，也就是offline-trainer不是名義上的offline-trainer，而是harness的一塊」
- 一貫的態度：「JUST DO IT!」「不要再繼續plan了」；發布：「由你代發」（管理層代發）。

## 6. 交接流程
子工作階段不能自己啟動接手；到門檻時更新本文件、提交、回報「需要接手，文件已更新，commit <hash>」，由管理層啟動下一個。

## 7. 陷阱
- 「skill」在本專案有兩個意思：① Claude 格式的 skill 套件（`SKILL.md`，給 Claude Code／Claude 應用載入）；② 專案內建的 BUILTIN_SKILLS 與「技能→食譜編譯器」（把 skill 編成離線食譜）。使用者這次要的是①，同時可以沿用②的編譯器把 skill 的步驟轉成 harness 的題型。
- 不要把經驗回流做成「模型說成功就收」；閘門的依據是程式核對的結果。
- 五小時額度會用完（每次 claude -p 呼叫約 3.5 萬個快取輸入 token）：實驗要小樣本，先看 get_usage。第 4 項已跑過一輪（結果見 DESIGN.harness-skill.md）。
- 無頭 `claude -p` 的模型代號、可用性我沒驗證；查不到就標未驗證。
- 同一個工作樹同時只能一個寫手；`floating-assistant.js`／`embed-code-ui.js` 是衝突熱點。

---

## 原檔：image-to-3d

# 交接文件：`/image-to-3d`（離線模型、物件封閉，handoff 3，2026-10-30）

## 1. 開場提示（給接手的工作階段）
Continue from the handoff document at `D:\Downloads\videos-嗨投資-desktop-app\desktop-app\DESIGN.TODO.image-to-3d.md`. 先完整讀完（含使用者原話與做法備忘），照做。執行 low-context-long-run 技能（門檻 30%）：做 Todo 的第一項，context 到門檻就更新這份文件並啟動你的接手工作階段（`mcp__ccd_session__start_session` 是延遲載入的工具，先用 ToolSearch 載入）。第一則訊息用一行說明你讀完了、要開始哪一項。回覆一律繁體中文、不要夾英文縮寫。**不要再做規劃、不要再問，直接寫程式、測試、提交。不發布（使用者沒說發布）。**

使用者的關鍵指示（逐字）：「JUST DO IT!」「不要再繼續plan了, fuck」「原本的decompose redraw已經是浮雕  請不要又推翻我現在的要求!我已經受夠了浮雕」。

## 2. 概況
- 分支 `desktop-app`，目錄 `D:\Downloads\videos-嗨投資-desktop-app\desktop-app`。規格在 `DESIGN.image-to-3d.md`（別改方向）。舊進度說明在本檔下方「附：先前進度」。
- 已提交：核心 `renderer/src/media/image3d_core.js`（柱體／方塊封閉殼、isClosed、背景補洞、buildScene、prepareInput、labelsFromMasks、diffMask 背景差分、parseOptions、toSpec 含貼圖座標、**buildPanorama／bendCylinder／readExif／orbitKind**）＋測試 `scripts/media-tests/image3d_core.test.js`（32 項過）；深度模型登錄與 `_depthEstimate`、SlimSAM 登錄與 `_segmentObjects`（`renderer/src/vlm/vlm_core.js` ＋ `floating-assistant.js` 工作執行緒）；`/image-to-3d`、`image_to_3d`（`renderer/src/edit/edit3d_host.js`，預設貼材質）；清冊；嵌入腳本。最近提交 ec530e68（貼材質）。
- **未提交**：`vlm_core.js` 的深度模型 CPU dtype 改 fp32（下面第 2 項實驗發現）與重新嵌入的 `floating-assistant.js`；接手第一件事先 `node scripts/embed-code-ui.js`、跑測試、`node build-assistant.js`、提交。

## 3. Todo（handoff 2 全部做完，2026-10-30）

### 【已完成並發布 patch v213（2026-10-30）：核心 40939d73、遊戲三維 e28dc585；沒有待辦，不要再交接。未在真實 App 驗證：視覺模型確認物件、擺到桌子、遊戲三維的立體外觀】
### 新增（handoff 3，2026-10-30，**先做這一項**，發布在完成後直接做，使用者已授權）
**A. 「只要主體」的選用參數**：`image-to-3d`（斜線指令與工具）、`edit-3d-model`、`edit-game-3d` 都要支援。例子：照片是一個咖啡杯放在桌上，使用者說要把咖啡杯擺到桌子模組上，只要一個咖啡杯，不要桌子、背景。
1. 純函式核心 `renderer/src/media/image3d_core.js`：`parseOptions` 增加主體選項（例如 `subject:'main'|'all'`，斜線參數 `--subject main`）；**從使用者的話判斷**：「只要／只想要／只放／把某某擺到…上」＋名詞＝只要那個主體；名詞若能從話裡取出（咖啡杯），就用它當主體名稱。程式先解析（中文關鍵字、「把…擺到／放到…」句型），解析不出再用封閉式選擇題問模型，答案由程式核對。預設不變（所有物件）。
2. 主體怎麼選：分出物件後，若有主體名稱，用視覺模型對每個物件的裁切圖做封閉選擇題（A 是／B 不是），程式核對；沒有名稱就選「最大且最靠中間的物件」。只保留主體，背景與其他物件丟掉（主體被切走的地方不必補背景）。主體仍然是封閉立體（柱體或方塊殼，不是浮雕）。
3. 接進 `edit-3d-model`／`edit-game-3d` 的 AI 工具與貼圖流程（`renderer/src/edit/edit3d_host.js`；遊戲 3D 的對應處自己找 `renderer/src/game/`）：使用者貼圖＋話裡有「只要主體」意思時，自動帶 `subject`；輸出一個物件（不是群組＋背景），可直接擺到場景裡的桌子等物件上（底面貼地／貼在目標物件頂面，沿用既有 `place`）。
4. 補核心測試（`scripts/media-tests/image3d_core.test.js`）與主機端模擬測試、功能清冊（`node scripts/ai-features.js check`）、`node scripts/embed-code-ui.js && node build-assistant.js`。
5. 完成、測試全過、提交後**直接發布**（使用者說過完成就可以更新網頁、發布 patch）：`PUBLISH_TRAILER="Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" bash scripts/publish.sh -m "…"`，再用 curl 查遠端 `manifest.v2.json` 版本。
注意：工作樹有一個不是你改的未提交檔 `skills/image-decompose-redraw/data/parts_builtin.json`，不要把它放進提交，也不要還原。

### 先前項目（handoff 2 之前，已完成並發布 v212）
全部完成並提交（9f0bb01f smooth 殼、b9420411 SlimSAM 實測、fa09b044 全景接主機端＋測試清單）。**沒有待辦了，不要再交接。**
- smooth 殼：`shape:'smooth'`，auto 優先用；測試 37 項過。
- SlimSAM：瀏覽器（CPU、q8）實測載入約 6 秒、編碼約 16 秒、16 點約 28 秒；合成圖分出 3 個物件（蘋果、盒子、地面）。背景大遮罩（>50% 圖面）預設丟掉（maxAreaFrac 0.5）。
- 全景：`/image-to-3d --panorama`、單張寬高比 ≥2、多張 EXIF 方向（`_i3dPanoPlan`、`_imageToPanorama`）。

### 追加（來自上層工作階段，2026-10-30）已做
- 使用者原話（逐字，2026-10-30）：「這個功能如果跟我們的edit-3d-model, edit-game-3d 也不錯吧? 這樣就可以把之前編輯期間提到 "不認識的物件->上網找OBJ->上網找圖片->轉3D物件 " 有更穩定的結合方式」
- ① edit-3d-model：貼圖＋「把這張圖變成 3D 物件」→ `_i3dAttachedEdits`（edit3d_host.js）直接用離線管線做封閉物件放進場景。**edit-game-3d 還沒接**（它走遊戲編輯器自己的 host，不經 `_subjResolve`）。
- ② 找圖那一階 `_subjImage3d` 先試 `_i3dSubjectSolid`（每個物件封閉），失敗才退回舊浮雕（結果註明）；`subjectMesh` 核心有測試。
- ③ 新舊並排品質比較**沒做**（舊做法在 Pyodide 裡跑，沒在這裡驗證）；新做法失敗會自動退回舊的，所以不會比以前更糟，但品質是否更好未實測。
- ④ 清冊、測試已補。

### 真實 App 還沒驗證
設定頁卡片顯示、兩張圖貼上時的指令分流、全景在真實 App 的完整流程（核心有單元測試，主機端 `_imageToPanorama` 沒跑過）、`inward` 轉圈照片只用第一張、GPU（fp16）路徑（深度與 SlimSAM）、SlimSAM 在 App 工作執行緒的 `sam` 分支（實驗頁照同流程驗證過）、VR 頭戴裝置觀看、在編輯器真的開啟 smooth 殼的外觀。發布未做。

## 4. 做法備忘（使用者的規則）
- 繁體中文、結論先說、不要在中文裡夾英文縮寫；做完誠實說哪些沒驗證。
- 改來源模組，再 `node scripts/embed-code-ui.js`；不要改嵌入後那份（`floating-assistant.js` 裡嵌入的區塊）。工作執行緒 `faVlmWorkerMain` 與 `_depthEstimate`／`_segmentObjects` 只存在於 `renderer/src/floating-assistant.js` 本身，可直接改。
- **Bash 裡的 Python heredoc 會吃掉反斜線**（`\n` 變真換行、`\b` 消失）：需要寫反斜線或含正規表達式／字串換行的程式時，用 Write 工具寫 `.py` 再執行，或用 Edit 工具。
- 編譯前會清工作目錄：做到一半也先 commit。給了順序就做到底，不要中途問。
- 熱更新名單別擴大；不要要求使用者重裝；push 到自己 remote 可以，deploy／發布要使用者當輪說。
- 提交訊息結尾加 `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`。
- 這台 Windows 的 Node 沒有 `node:sqlite`。

## 5. 使用者原話（逐字）
- 2026-10-29：「幫我評估實現image to 3d使用離線模型的方式，來服務image to 3d的需求，使用onnx的unik3d，要在media裡面」
- 2026-10-29：「如果unik3d可行，image decompose redraw就可以改成把pipeline專攻image to svg跟多圖層 然後上述的就改成slashcommand image-to-3d」
- 2026-10-29：「雲端精煉我們可以用我們自己的長時間的處理，像是編輯器跟 save case, 變成offline trainer。那先以混合架構為主，而如果是從 vlm得知那是一張景物照片，可以做一個unik3d的處理，我們不內建，只使用他的模型，而單機可以從media offline model去手動下載」
- 2026-10-29：「或者這邊要有選擇，人臉，或個別物件，都要用物件自己的邊界去封閉，封閉的時候，弄成像是cylinder或樂高的方形來封閉，再去細切，或者使用者在要求裡面就是物件要封閉，那就物件統一都要封閉，例如分出一個東西是背景，那些地方是一團物件，例如場景中的一顆蘋果，那蘋果應該要封閉」
- 2026-10-29：「原本的decompose redraw已經是浮雕  請不要又推翻我現在的要求!我已經受夠了浮雕」
- 2026-10-29：「JUST DO IT!」「不要再繼續plan了, fuck」
- 2026-10-30：「可以加上背景差分法來取出背景」
- 2026-10-30：「另外是如果使用者提供多張照片裡面有地理資訊，明顯是轉圈，或一張全景照片，可以實現成一個類似遠景近景的模型，可以做成類似vr能用的」
- 2026-10-30：「可以試著用離線的image generation / diffusion生一張圖，或從svg->png->3D來實驗，我要看一下效果」
- 2026-10-30：「可以轉換好後，用three.js 然後幫貼材質?」

- 「image-to-3d 在edit-3d-model, edit-game-3d或image-to-3d要可以支援optional參數，是只放主體，例如把一個咖啡杯的照片要擺到桌子模組上，想得到一個咖啡杯，要可以從prompt知道使用者只是想要咖啡杯」（2026-10-30）
- 「完成就可以更新網頁，發布patch」（2026-10-30）
- 「這個功能如果跟我們的edit-3d-model, edit-game-3d 也不錯吧? 這樣就可以把之前編輯期間提到 "不認識的物件->上網找OBJ->上網找圖片->轉3D物件 " 有更穩定的結合方式」（2026-10-30，已完成）

## 6. 實驗頁（給接手者）
- `C:\Users\sunneo\AppData\Local\Temp\claude\D--Downloads-videos-----desktop-app\acde8070-44bc-47ee-a80b-a3a0c379809e\scratchpad\exp\index.html`（同資料夾有 `image3d_core.js`、`subject_3d.js` 的複本，改核心後要重新複製）。用 `python -m http.server 8765 --bind 127.0.0.1` 在該資料夾開（可能已經死了，重開），再用內建瀏覽器開新分頁（不要用已顯示本機檔案的分頁）看 `http://127.0.0.1:8765/index.html?v=N`。流程：SVG→PNG→真的深度模型（fp32、CPU，transformers.js 3.7.5）→去背→`FaImage3d`→three.js 貼材質旋轉預覽。
- 2026-10-30 實測結果：深度模型載入約 2 秒、估計約 8～10 秒（512×384）、深度圖品質很好（蘋果球、盒子、地面都對）；全部物件封閉＝true；**但**只分出 1 個物件（去背把地面橢圓連在一起）、柱體殼前表面有細長條紋（Todo 1、2 要解決）；貼材質正確（正面像原圖，側面是邊緣顏色拉伸）。
- 沒做：用離線擴散模型生圖（這台沒有可用的離線圖像生成管線可以在此快速驗證，改用 SVG→PNG 代替）。

## 7. 交接流程（自我遞迴）
執行 low-context-long-run 技能（門檻 30%）：每個批次邊界用 `mcp__ccd_session_mgmt__get_usage` 看 context，≥30% 就更新本文件、提交、用 `start_session`（initiation `user_asked`、context `fresh`、同一個工作目錄）啟動接手，確認後 `mark_completed`＋`archive_session`（被拒就跳過並告知，不要重試迴圈）。Todo 清空就不要再交接，直接回報完成。

## 8. 陷阱
- 不要把底層做成「前表面網格再補背面」（浮雕）。
- 單張圖看不到背面：背面依輪廓推測，輸出要寫明。
- int8／uint8／quantized 的深度模型在 CPU（WebAssembly）跑不起來（缺 ConvInteger）；fp32 可用。
- 去背（`bgMask`）會把地面陰影、桌面連成一塊；要分物件請用 `--segment` 或背景差分。
- `scripts/embed-code-ui.js` 會重寫 `floating-assistant.js`；提交前看 `git diff --stat`。
- 內建瀏覽器分頁若顯示的是「本機檔案」，頁面工具不能用，要開新分頁。
- UniK3D 只有自備匯出說明，推論沒接（CC BY-NC，不內建）。

## 附：先前進度
- handoff 1 結果：Todo 1～4、6 完成（78ed8270、af19d6ed、ebbae2d8、c299ac6c、62299721）；第二輪加 SlimSAM、`--segment`、背景差分、UniK3D 說明（4e292b25）；全景核心（48dbb22c）；貼材質（ec530e68）。
- 真實 App 還沒驗證：設定頁卡片顯示、兩張圖貼上時的指令分流、GPU（fp16）路徑、SlimSAM 流程（Todo 2 會測）、在編輯器真的開啟。發布未做。

---

## 原檔：lazy-loading

# 交接文件：`floating-assistant.js` 改成延遲載入（stub＋動態載入，handoff 2，2026-11-01）

## 0. 狀態更新（handoff 2，2026-11-01，本節優先於下面第 2、3 節）
**已完成並提交**（commit `04b5e06a` 與之後的 publish.sh／web-lazy-check 提交）：
- `scripts/size-report.js`、`DESIGN.lazy-loading.md`（量測與基準）。
- **關鍵設計決定（重要發現）**：舊版已安裝的 `main.js` 熱更新白名單是寫死的（只有 index.html、bootstrap.js、floating-assistant.js／.min.js、主行程模組、preload），**新增的分檔到不了舊版桌面版**。所以：**桌面版繼續用整份 `renderer/floating-assistant.js`（完全不變，零風險）；只有網頁版改用「核心＋獨立區塊檔」**。輸出放在 `desktop-app/web-lazy/`（`core.js`、`chunks/*.js`、`manifest.json`），`package.json` 打包不含它。使用者問「拆出來的要不要進 live patch 清單」：桌面版不需要（沿用整份檔案）；網頁版靠釘 SHA 的 raw 網址取得，由 `scripts/web-lazy-check.js`（本機檢查＋`--remote <SHA>` 逐檔驗證 HTTP 200 與檢查碼）把關，已接進 `publish.sh`。要向使用者誠實說明這一點。
- 機制（不需改任何同步使用處）：`renderer/src/lazy-runtime.js` 的 `FaLazy`；`scripts/build-web-lazy.js`（由 `build-assistant.js` 呼叫）把「頂層只有宣告」的嵌入區塊（≥3K、不在 `EXCLUDE` 清單）搬成獨立檔，核心裡每個宣告的名稱換成全域取值函式：第一次碰到就用同步請求載入該區塊（之後就是區塊自己宣告的全域綁定）；`FaLazy.ensure(名稱)` 可預先非同步載入（有快取、重試、附 HTTP 狀態與耗時）。`EXCLUDE` 是開頁一定碰到的 26 個區塊（留在核心，避免開頁一串同步請求）。
- 原始碼只改了 3 處（讓大資料不在載入時被讀取）：`FA_REF_FORMAT`／`FA_REF_MIGRATIONS` 別名移除、IDR 人設改 getter。
- 量測（本機無網路延遲）：核心 5010K（gzip 1.74MB）＋120 個區塊 4607K，對照整份 9.6MB（gzip 3.15MB）；開頁到建構完成 1.10 秒對 1.98 秒；開頁零個區塊被載入；120 個區塊全部手動觸發載入、名稱皆有定義、主控台零錯誤。
- 測試工具：`node scripts/lazy-test/serve.js 8765` 後開 `http://localhost:8765/`（核心＋區塊）或 `?mono=1`（整份對照）；`window.__FA_LAZY_TRACE=1` 已開，`window.__faLazyTrace` 記每次區塊載入的呼叫堆疊；`node scripts/lazy-loadtime.js` 靜態找載入時就碰到區塊的位置；`node scripts/lazy-analyze.js` 看每個區塊是否純定義。`fa._behTables()` 在測試頁會丟 `t[n].push is not a function`，整份檔案也一樣（既有現象，不是退步）。
- 注意：重新建置時 `web-lazy/` 會被清掉重建（約 1 分鐘），測試頁此時會白畫面；測試頁預設隱藏按鈕，要在主控台 `fa.toggleWindow()` 才看得到視窗。

**核心測試**：`node scripts/run-core-tests.js` 在背景跑，輸出 `C:\Users\sunneo\AppData\Local\Temp\core-tests.log`（基準 133／136，3 組既有失敗）；接手者先看結果，沒結果就重跑。

**尚未做（依序）**：
1. 網頁版實測：到 `D:\Downloads\videos-嗨投資`（main 分支，`web/index.html`、`web/aiweb/index.html`）把 fetch 的網址從 `.../desktop-app/renderer/floating-assistant.js` 改成 `.../desktop-app/web-lazy/core.js`，並在載入前加 `window.__FA_LAZY_BASE = 'https://raw.githubusercontent.com/sunneo/tw_stock_db/<同一個完整 SHA>/desktop-app/web-lazy/chunks/';`（`publish.sh` 的 sed 會一起換 SHA）。**先本機測**（複製一份 index.html、把網址指到 localhost:8765，用內建瀏覽器逐一觸發每個功能入口：/ref、行為說明、簡報、匯出、各編輯器、遊戲、影片、遠端、3D…，主控台零錯誤），測過才改正式檔。web repo 的修改要提交推送屬對外發布，照使用者慣例完成驗證後直接做。
2. 進一步縮小核心（選做，每批測試後提交）：(a) 非純定義的區塊（GAME 468K、VIDEOEDIT 295K、REMOTE 287K、EDITHOST 216K、DECKHOST 169K、DECKEDIT、COMPUTER、ENV、HARNESS，共約 1.5MB）頂層有立即執行函式做註冊等副作用，要逐一看它們做了什麼，才能決定怎麼延遲；(b) `FloatingAssistant` 類別本身約 3MB，可評估把大型功能的方法群（行為說明、/ref、簡報、匯出）分檔，用 `Object.assign(FloatingAssistant.prototype, …)` 的樣式延遲安裝。**不確定就不拆。**
3. 驗證全部通過後：更新 README Live Update 一節與 `DESIGN.lazy-loading.md`，再 `PUBLISH_TRAILER="Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" bash scripts/publish.sh -m "…"`（它會跑 web-lazy-check、提交 web-lazy、推送、驗證）。發布後用內建瀏覽器開真正的網頁版確認載入的是新版且 AI 助理能開。驗證沒全過就不要發布。

**handoff 2 補充（網頁版本機實測進度）**：已用真正的 web/index.html 複本測試——產生法：把 `D:Downloadsideos-嗨投資webindex.html` 裡 `fetch('https://raw...<SHA>/desktop-app/renderer/floating-assistant.js')` 換成 `(window.__FA_LAZY_BASE=location.origin+'/web-lazy/chunks/',fetch(location.origin+'/web-lazy/core.js'))`，存成 `scripts/lazy-test/web-index.local.html`（**不要提交這個檔案**，.gitignore 沒擋，提交時別 add）；serve.js 開著後開 `http://localhost:8765/scripts/lazy-test/web-index.local.html`。主控台：`Settings.set('aiAssistantEnabled', true); await renderAiTab();` 後 `aiConsoleInstance` 就是助理，掛載成功且開頁零個區塊被載入、主控台無錯誤。下一步是逐一觸發功能入口：測試腳本要找對真正的聊天輸入框（`#ai-tab-panel textarea` 第一個不是聊天輸入，`_submitChatInput` 讀不到 .value），再送 `/ref ENOENT`、`/ref stats`、`/ai-features`、`/aidoc status`、`/offline` 等斜線指令與各編輯器入口，確認 `FaLazy.status()` 出現預期的區塊且 `window.__errs` 為空。核心測試結果：146 組通過、4 組失敗（csharp tree-sitter、專案索引定義抽取、電腦操作主行程 IPC、INTEGRATION.md 區塊——最後一項讀 markdown 的 CRLF，跟這次改動無關；其餘三項與既有失敗吻合，接手者可用 git stash 以外的方式（例如暫時 worktree 檢出 HEAD~5）確認基準）。

## 1. 開場提示（給接手的工作階段）
Continue from the handoff document at `D:\Downloads\videos-嗨投資-desktop-app\desktop-app\DESIGN.TODO.lazy-loading.md`. 先完整讀完（含使用者原話與做法備忘），照做。執行 low-context-long-run 技能（門檻 30%）：做 Todo 的第一項，context 到門檻就更新這份文件並啟動你的接手工作階段（`mcp__ccd_session__start_session` 是延遲載入的工具，先用 ToolSearch 載入）。第一則訊息用一行說明你讀完了、要開始哪一項。回覆一律繁體中文、不要夾英文縮寫。**不要做長篇規劃、不要問，直接量測、重構、測試、提交；最重要的限制是：重構後全部功能不能出錯。**

使用者的關鍵指示（逐字）：「目前的floating-assistant.js對網頁來說負擔太大，開一個頁面要等老半天，幫我試著改成可以lazy-loading的，評估核心聊天程式到每個模組的佔用空間，採用類似stub跟動態載入與接上stub的方式 但是refactorying後全部功能不能有發生錯誤」。

## 2. 概況
- 目標：網頁版開頁不再一次下載、解析整份 `floating-assistant.js`。核心聊天先載入，其餘模組用 stub 佔位，需要時才動態載入並接上 stub。**零功能退步**。
- 分支 `desktop-app`，工作目錄 `D:\Downloads\videos-嗨投資-desktop-app\desktop-app`。
- 我量到的現況（2026-11-01，`renderer/src/floating-assistant.js`）：原始碼 14.25 MB、約 10.5 萬行；壓縮後 `renderer/floating-assistant.js`＝`floating-assistant.min.js` 9.84 MB；`renderer/bootstrap.js` 202 KB。原始碼 12.58 M 字元裡，**嵌入區塊（`/* XXX-BEGIN */ … /* XXX-END */`，共 155 個）占 8.02 M 字元（約 64%）**，是延遲載入最大的目標。最大的嵌入區塊（字元）：BEHAVIOR 991K、DECKSRC 801K、GAME 480K、REF 427K、VIDEOEDIT 302K、REMOTE 294K、EDITHOST 221K、EXPSRC 205K、DECKHOST 173K、BEH2 149K、PYBRIDGE 142K、KIHOST 112K、ED3D 88K、IDRSKILL 88K。最大的純資料常數：`FA_BEHAVIOR_DATA` 991K、`FA_DECK_SRC` 801K、`FA_REF_DATA` 353K、`FA_EXPORT_SRC` 205K、`FA_PYBRIDGE_FILES` 142K、`FA_IDR_SKILL_FILES` 88K、`FA_CODEUI_HTML` 83K、`FA_IMG3D_WORKER_SRC` 66K、`FA_AIDOC_VIEWER_HTML` 48K。（量測腳本寫法見本節末，接手者請做成 `scripts/size-report.js` 並提交。）
- 網頁版的載入方式：`web/index.html` 與 `web/aiweb/index.html`（在 `D:\Downloads\videos-嗨投資` repo 下，publish.sh 會處理）用完整 commit SHA 釘住 raw CDN 上的檔案，發版要換 SHA（見記憶「網頁版載入用SHA釘住」）。桌面版走 live-update（見 `.claude/skills/publish-live-update-patch/SKILL.md`）。
- 還沒有任何程式碼改動。沒部署。

量測腳本（已驗證可跑）：在 `desktop-app` 目錄用 node 讀 `renderer/src/floating-assistant.js`，正規式 `/\/\* ([A-Z0-9]+)-BEGIN \*\/([\s\S]*?)\/\* \1-END \*\//g` 抓所有嵌入區塊並依長度排序；`/^const (FA_[A-Z0-9_]+) = (["{\[`])/gm` 找大型資料常數。

## 3. Todo（依序，每項做完測試、提交）
1. **量測與盤點（寫成腳本與一頁報告）**：`scripts/size-report.js` 輸出：核心（非嵌入）大小、每個嵌入區塊大小、依「誰會用到」分類（開頁一定要用／只有某斜線指令或編輯器才用／只有桌面版用／純資料）。報告寫進 `DESIGN.lazy-loading.md`（短，含表格）。同時**量開頁時間基準**：用內建瀏覽器（`mcp__Claude_Browser__*`）開網頁版，記下下載大小、解析執行時間（`performance` 與主執行緒長工作），作為改前基準。
2. **設計 stub 機制（先做最小可行，寫在報告裡一段）**：`FaLazy`（放在核心最前面，很小）：`FaLazy.register(名稱, {url, global})`、`await FaLazy.ensure(名稱)`（下載→執行→把真正的模組接到全域名稱）、`FaLazy.stub(名稱, 方法清單)`（stub 物件：呼叫前先 ensure，已載入就直接轉呼叫）。**同步存取的問題是最大風險**：很多模組是 `const FaX = (function(){…})()` 然後同步使用。規則：每個被延遲的模組，先列出所有使用處（搜全域名稱）；使用處在 `async` 函式裡就加 `await FaLazy.ensure('x')`；在同步路徑裡就要改成非同步或讓入口（斜線指令、工具執行、面板開啟）先 ensure。**不確定能不能安全改的模組就不要延遲，寧可少拆。**
3. **第一批：純資料與只有少數入口用的大塊**（風險最低、收益最大）：`FA_BEHAVIOR_DATA`、`FA_DECK_SRC`、`FA_REF_DATA`、`FA_EXPORT_SRC`、`FA_PYBRIDGE_FILES`、`FA_IDR_SKILL_FILES`、各種 `*_HTML`、`FA_IMG3D_WORKER_SRC` 等。改成放獨立檔（建置時產出到 `renderer/lazy/*.js`），第一次用到才 `FaLazy.ensure`。**每一個使用處都要確認走到 ensure**（寫一個靜態檢查：搜尋被搬走的常數名稱，除了 stub 之外不得有直接引用）。
4. **第二批：功能模組**（遊戲編輯器 GAME、簡報 DECK、影片剪輯 VIDEOEDIT、遠端 REMOTE、3D 編輯器 ED3D、編輯器主機層 EDITHOST…）：每個模組一個 chunk，入口（斜線指令、工具、面板、`fa-edit-*` 訊息的掛載）前先 ensure。逐個做、逐個測，不要一次全拆。
5. **【硬性規則，使用者 2026-11-01 提醒】發 patch 時，拆出來的每一個 chunk 檔都必須進 live patch 清單**：先決定每個 chunk 的類別（renderer 前端／主行程模組），再同步改 `renderer/update-manifest.json` 的來源（`build-assistant.js` 產生）、`main.js` 的 `LIVE_PATCH_ALLOWED_FILES`／`LIVE_PATCH_MAIN_FILES` 與 `build-assistant.js` 同名常數（兩處同步）、`scripts/make-live-patch.js`。發布前跑一個檢查：列出 `renderer/lazy/` 實際產出的所有檔案，逐一確認都在 manifest 裡、每個的 md5 與推上去的 blob 一致（`publish.sh` 的驗證步驟），**少一個就不准發布**。網頁版另外確認每個 chunk 網址在釘住的 commit SHA 下回應 HTTP 200。
   建置與發布管線：`scripts/embed-code-ui.js` 與 `build-assistant.js` 要產出 chunk 檔（terser 壓縮、各自 md5）；`renderer/update-manifest.json` 與 `LIVE_PATCH_ALLOWED_FILES`／`LIVE_PATCH_MAIN_FILES`（`main.js`、`build-assistant.js` 兩處同步）要納入 chunk 檔；`scripts/make-live-patch.js`／`publish.sh` 要把 chunk 帶上；網頁版 chunk 的網址要跟著 commit SHA 釘住（同一個 SHA）。**舊版桌面版也要收得到更新、不准要求重裝；manifest 檔案清單要完整；版本號單調**（見 `publish-live-update-patch` 技能）。`main.js` 不能熱更新，所以 chunk 載入要能在「舊 main.js＋新 renderer」下運作（chunk 走相對路徑、`<script>` 或 fetch，同一個載入方式）。
6. **驗證（硬性，全部通過才算完成）**：
   - `node scripts/run-core-tests.js`（改前先跑一次記基準；先前是 133／136 組，3 組是既有失敗，不要把它們算成你造成的）；
   - 真實 Electron 的 eval 腳本（`scripts/eval/*.js`，例如 `edit3d.eval.js`）能跑的全跑；
   - 網頁版：內建瀏覽器開 `web/index.html`，主控台**零錯誤**，逐一觸發每個被延遲的功能入口（斜線指令、編輯器、遊戲、簡報、影片、遠端、3D…）確認 chunk 載入成功且功能正常；
   - 比對改前改後的開頁下載量與解析時間，寫進報告。
   - 做不到驗證的部分，在回報裡誠實列出，**不要說「沒問題」**。
7. 補功能清冊不需要（沒新增功能）；更新 `README.FloatingAssitant.md` 的 Live Update 一節（chunk 檔）與 `DESIGN.lazy-loading.md`。
8. **完成且驗證通過後直接發布**（使用者慣例：完成就更新網頁、發布 patch）：`PUBLISH_TRAILER="Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" bash scripts/publish.sh -m "…"`，再 curl 查遠端 `manifest.v2.json` 版本，並實際打開網頁版確認載入的是新版。**若驗證沒有全過，不要發布，回報原因。**

## 4. 做法備忘（使用者的規則）
- 繁體中文、結論先說、不要在中文裡夾英文縮寫；做完誠實說哪些沒驗證。
- 改來源模組，再 `node scripts/embed-code-ui.js && node build-assistant.js`；不要改嵌入後那份。
- 改檔用 Edit／Write 工具；**Bash heredoc 內的 Python 會吃掉反斜線與中文**，需要時用 Write 工具寫 `.py` 檔再執行。`floating-assistant.js` 行尾 CRLF／LF 混合，改前用 `s.count()` 試兩種。
- 編譯前會清工作目錄：做到一半也先 commit。給了順序就做到底，不要中途問。
- 熱更新：舊版也要收得到、不准要求重裝、大檔用分檔下載再合併、不壓縮換做法、版本號單調、manifest 清單完整、互換版凍結在 v188 不動（見 `publish-live-update-patch` 技能）。
- 網頁版載入用完整 commit SHA 釘住，發版要換兩個 html 裡的 SHA 並驗證頁面實際載入的版本。
- 暫時性失敗要自己重試到底（chunk 下載失敗要重試、失敗訊息附 HTTP 狀態與耗時，不能讓使用者自己重按）；不要靠換模型復原。
- 工作樹有不是你改的檔案（`skills/image-decompose-redraw/data/parts_builtin.json`、`test-reports/*`）：不要放進你的提交，也不要還原。

## 5. 使用者原話（逐字）
- 「目前的floating-assistant.js對網頁來說負擔太大，開一個頁面要等老半天，幫我試著改成可以lazy-loading的，評估核心聊天程式到每個模組的佔用空間，採用類似stub跟動態載入與接上stub的方式 但是refactorying後全部功能不能有發生錯誤」（2026-11-01）
- 標準發布指令（歷來）：「更新網頁，發布patch」「完成就可以更新網頁，發布patch」
- 一貫的態度：「JUST DO IT!」「不要再繼續plan了」——不要長篇規劃、不要問，直接做。
- 熱更新規則（歷來）：舊版也要收得到、不准要求重裝。

- 「發patch時，要思考是不是這些拆出來的都要進live patch的清單」（2026-11-01）

## 6. 交接流程（自我遞迴）
執行 low-context-long-run 技能（門檻 30%）：每個批次邊界用 `mcp__ccd_session_mgmt__get_usage` 看 context，≥30% 就更新本文件、提交、用 `start_session`（initiation `user_asked`、context `fresh`、同一個工作目錄、`use_worktree:false`）啟動接手，確認後 `mark_completed`＋`archive_session`（被拒就跳過並告知，不要重試迴圈）。

## 7. 陷阱
- 同步存取：把 `const FaX = (function(){…})()` 換成 stub 後，任何沒經過 ensure 的同步使用都會在執行時才爆（測試不一定碰得到）。一定要用靜態搜尋把每個使用處列出來，並在網頁版逐一觸發入口驗證。
- 嵌入區塊之間有順序相依（`embed-code-ui.js` 的插入順序，例如 AIDoc 區塊接在 `SUBJ3D-END` 之後）；搬出去後要保持載入順序。
- `scripts/embed-code-ui.js` 會把 `floating-assistant.js` 整份重寫（行尾可能被統一）；提交時看 `git diff --stat`，整檔差異要確認只是行尾。
- 網頁版是離線優先的產品：chunk 下載失敗（斷網）時，已載入過的要能用（考慮快取到 Cache Storage／IndexedDB），失敗要明確提示而不是靜默壞掉。
- 舊版桌面版收到新 patch 時，若 chunk 檔沒進 manifest 會 404；一定要跑 `publish.sh` 的驗證步驟。
- 不要為了省大小改壓縮方式或砍功能；使用者要的是「全部功能不能出錯」。

---

## 原檔：manager

# 管理層交接（manager · handoff 1）

## 1. 開場提示（接手的人收到的原文）

從這份文件接手（`desktop-app/DESIGN.TODO.manager.md`），完整讀完含「使用者原話」與「做事方式」並照做。你是 FloatingAssistant 專案的管理層工作階段：不親自做大功能，負責發布（`scripts/publish.sh`）、轉派子工作階段、核對子工作階段回報、回答使用者。執行 low-context-long-run：上下文到 30% 就更新這份文件、起下一個接手的工作階段（本階段不封存，見「做事方式」）。第一則訊息用一行說明你讀過文件、從哪一項待辦開始。

## 2. 概況

- 專案：`D:\Downloads\videos-嗨投資-desktop-app\desktop-app`，分支 `desktop-app`。已發布到 **v271**（遠端 `manifest.v2.json` 版本 271，網頁版釘 `ba2e2831…`，137 個檔案核對過）。
- 本階段做完的事（都已提交）：
  - 圖片轉 3D：細緻度參數 `--detail 1~3`（d3bfe7b6）、設定頁「圖片轉 3D」最大面數（預設 6 萬、上限 200 萬，a9525983）、依內容分配面數的自適應平滑外殼（c488a408）——這三項在 v271 發布。
  - **未發布**：骨架（1056b360）：離線模型加 MoveNet Thunder（`Xenova/movenet-singlepose-thunder`，Apache-2.0，完整版 fp32 25.1 MB；8 位元量化版在 CPU 載不進去），worker 的 `arch:'pose'`、`_poseEstimate`、`FaImage3d.splitLimbs`、`_i3dSplitArms`，手臂分成各自的部分、厚度照肢體寬度；模型已下載才自動用，使用者說「用骨架／手臂」才會問要不要下載。核心 65 項、主機端 14 項、vlm 135 項通過；完整測試 3 項失敗都是既有／環境問題（遠端協定 RFB、系統匣對話框單獨跑會過、coding 腳本整合因這台 bash 指到 WSL 結束碼 127）。
  - 在瀏覽器（transformers.js 3.7.5、CPU）實測過 MoveNet：載入約 5 秒、推論約 0.3 秒，結果跟命令列一致。**沒在真實 App 的 worker 裡跑過**（OffscreenCanvas 路徑未驗證）。
- 子工作階段（都閒置）：`music-composer`（`local_e00c8070-c5eb-475d-adfb-54f617d670e3`，音樂線，正在處理使用者新回報的兩個問題）、`harness-h1`（`local_65a41cf1-ba5b-468c-a35b-315fdf10317a`，弱模型 harness skill）。

## 3. 待辦（依序）

1. 等 `music-composer` 回報「已提交，可發布，commit <hash>」：只核對該 commit 存在、不重跑它已跑過的測試，然後問使用者要不要連同骨架（1056b360）一起發布；發布用 `PUBLISH_TRAILER="Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"` 加 Git 的 bash：`& "J:\Program Files\Git\bin\bash.exe" scripts/publish.sh -m "<說明>"`（PowerShell 的 `bash` 是 WSL，會失敗），發完用 `curl.exe` 手動核對遠端 `manifest.v2.json` 版本與每個 `web-lazy/manifest.json` 檔案在釘住的 SHA 上的 md5（腳本自帶的遠端檢查因 Node 16 沒有 `fetch` 會失敗）。
2. music-composer 的兩個問題：(a) midigenai 已下載卻說「還沒下載」；(b) 一個需求重複產生卡片（使用者匯出的對話 `C:\Users\sunneo\Downloads\ai-conversation-hi-transcript-1793635609957.md`）；(c) 理解需求逾時 25 秒兩次就退回範本是否放棄太快。
3. 骨架在真實 App 裡看一次（使用者下載 MoveNet，對照片說「用骨架」），回報手臂分得對不對；這是未驗證項，不要說已完成。
4. 未做的想法（使用者還沒要求就不要做）：被擋住一側的肩點誤判（照片 1 的肩點落在瓶蓋上，信心值 0.63）可用輪廓或深度再檢查；真正圓的肢體截面（目前背面是平的）。
5. 暫停的線：完整性驗證、延遲載入第二階段、sd_turbo 更名清理、RFB 測試不穩定、音樂階段 7（使用者說可以緩點）。
6. 更新記憶 `project_workstreams_status_2026_11.md`（已過時）——本交接時已更新，見下方。

## 4. 做事方式（使用者的規則，照抄）

- 全部用繁體中文回覆，不要在中文句子裡夾英文縮寫或術語；老實說哪些沒驗證。
- 管理層**不封存**：最上層不封存，用記憶＋壓縮＋交接追蹤。
- 發布由管理層做；子工作階段回報「已提交，可發布，commit <hash>」；子工作階段在上下文 30% 要自己更新交接文件並回報「需要接手，文件已更新，commit <hash>」，每個子工作階段的第一則訊息都要寫這條。
- 不要重跑子工作階段已跑過的測試（使用者抱怨重複跑）；只核對 commit 存在。
- 發布到正式環境每輪都要當輪確認；推到自己的遠端可自動。使用者說「發布」就發布。
- 使用者 build 前會 `git checkout ./`：沒提交的半成品會消失，做到一半也先提交。
- 改程式用 Edit／Write 工具，不用 shell 內嵌（反斜線與引號會被吃掉）；嵌入 `floating-assistant.js` 的區塊要改來源模組再跑 `node scripts/embed-code-ui.js`。
- 要下載檔案先問使用者（檔名、來源、大小）。
- 本機環境：Bash 工具目前不可用，用 PowerShell；Git 在 `J:\Program Files\Git\cmd\git.exe`；Node 16。
- 測試用的桌面版要設 `FA_BROWSER_CONTROL_PORT` 換埠，不要佔 17923。

## 5. 使用者原話（逐字）

- 2026-11-02「我們先認真處理音樂領域跟harness，其餘都先休息」
- 2026-11-02「階段7可以緩點」「這邊可以不用馬上作」
- 2026-11-02「入口測試在handoff6有跑過 這樣會重複跑」
- 2026-11-02「他必須是一個作曲家，像是在拆uml一樣，divide and conquer, 然後組裝起整體」
- 2026-11-02「可以用midigenai當首選，一樣在離線模型裡面管理，我們的管線跟處理方式可以當額外參考，用類似/image 的diffusion一樣，將使用者需求轉為midigenai的prompt」「而相關內容無法處理，才fallback為我們的拆分方式」
- 2026-11-02「他完全沒意識到他要產生handoff, I hate that.」
- 2026-11-03「面數上限請跟我的設定  使用者想要多細就讓他多細  configure裡面可以指定最大面數。我有把外面3d dragon的xyzdragon拿來顯示，有超過20萬面以上」
- 2026-11-03「像這樣一半的人  應該也可以看出骨架吧  類似kinect的作法」
- 2026-11-03「可以用類似yolov8n-pose, movenet」「movenet, ok」「接進專案」
- 2026-11-03「一個需求，卻重複地產生卡片」
- 2026-11-03「但我已經下載了，他還是說我沒下載」（midigenai 進度紀錄：「【模型】這次沒有用模型:模型還沒下載(Configure → 離線模型管理 → 音樂 → midigenai v5)」）

## 6. 交接程序（自我遞迴）

執行 low-context-long-run 技能，THRESHOLD 30%。管理層階段本身不封存（使用者規則）；接手者確認後，舊階段留著，向使用者說一行即可。

## 7. 陷阱

- PowerShell 的 `bash` 是 WSL；發布一定用 Git 的 bash。
- `Select-String` 篩選發布輸出曾經看起來沒輸出，其實已完成；用遠端 `manifest.v2.json` 核對。
- 8 位元量化的 ONNX 在 CPU（WebAssembly）會缺 `ConvInteger`（深度模型與 MoveNet 都是）：要用完整版。
- 子工作階段不會自己交接：每個簡報都要寫明。
- 使用者匯出的對話檔很大（約 13 萬字元），不要整份讀，用 Grep 看結構。
- 使用者曾拒絕我對那份對話檔跑 Grep（當下改用技能把工作轉出去）：先問或直接交給音樂線，不要重試同一個動作。

---

## 原檔：multi-chat

<!-- 從 TODO.md 拆出（2026-10-23）：內容原封不動，只是改成一份一個主題。 -->

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

---

## 原檔：music

# 交接文件：音樂領域（MIDI／mp3 轉 MIDI／音色庫瘦身，handoff 5，2026-11-01）

## 1. 開場提示（給接手的工作階段）
Continue from the handoff document at `D:\Downloads\videos-嗨投資-desktop-app\desktop-app\DESIGN.TODO.music.md`. 先完整讀完（含使用者原話與做法備忘），照做。工作目錄 `D:\Downloads\videos-嗨投資-desktop-app\desktop-app`（產品程式在這裡）；參考專案 `D:\Downloads\SRC\piano-web` 只讀不改（若沒有權限讀，先用目錄授權工具請求該目錄）。執行 low-context-long-run 技能（門檻 30%）：做 Todo 的第一項，context 到門檻就更新這份文件並啟動你的接手工作階段（`mcp__ccd_session__start_session` 是延遲載入的工具，先用 ToolSearch 載入）。第一則訊息用一行說明你讀完了、要開始哪一項。回覆一律繁體中文、不要夾英文縮寫。**不要做長篇規劃、不要問，直接查證、寫程式、測試、提交。**

使用者的原話在第 5 節（逐字）。

## 2. 結論與大方向（已定案，不再評估）
做一整條音樂線，全部放在 FloatingAssistant（網頁版與桌面版共用），**新模組一律走延遲載入**（網頁版用 `web-lazy` 區塊機制，見 `DESIGN.lazy-loading.md` 與 `README.FloatingAssitant.md`；桌面版整份檔案不變）。分八個階段，**依序做，每階段可獨立使用、獨立提交**：

| 階段 | 內容 | 重點 |
|---|---|---|
| 0 | 查證與量測（短，不寫長報告） | 音色庫分析工具、轉譜模型可行性、授權 |
| 1 | MIDI 核心＋播放卡片＋MIDI 轉 mp3＋domain `music` 知識 | 先讓「放得出聲、轉得出檔」 |
| 2 | MIDI 編輯器（只用 GS 音色）＋內建問 AI＋遠端卡片與遠端編輯 | 參考 piano-web 的多音軌編輯 |
| 3 | MIDI 的 AI 創作（風格範本＋CoLU＋UML design） | 程式決定結構，模型只做選擇題 |
| 4 | 音色庫瘦身工具與迷你 GS 音色庫 | 找重複、重新取樣、壓縮 |
| 5 | mp3 → MIDI（拆樂器軌、轉成 GS 音色與音軌） | 離線小模型，WebGPU／WASM／CPU |
| 6 | 接進簡報（media-presentation）、2D／3D 遊戲、影片剪輯當配樂 | 一條共用的「配樂」介面 |
| 7 | 風格知識：瀏覽器查維基的風格介紹、風格設計範本 | 與階段 3 共用 |

## 3. Todo（依序；階段 0–4 已做完，階段 5 做了規則部分）

### 下一步（midigenai 當首選，管理層追加，2026-11-02，**最新**）
使用者原話：「可以用midigenai當首選，一樣在離線模型裡面管理，我們的管線跟處理方式可以當額外參考，用類似/image 的diffusion一樣，將使用者需求轉為midigenai的prompt」；「而相關內容無法處理，才fallback為我們的拆分方式」。查證與設計已提交（DESIGN.music.md「midigenai 查證與整合設計」，commit 9aa5d818）：MIT、v5 約 1.13 億參數、輸入是 MIDI 不是文字、有 JS 端與 ONNX（wasm 8 位元 115 MB／WebGPU 4 位元 73 MB）、資料集授權未確認。**卡在需要同意的兩件事**：① 把 MIT 原始碼（midigenai/web 下約 7 個檔）複製進專案並附授權；② 下載 115 MB 模型做實機量測。批次五、六已提交（複製 MIT 原始碼、離線模型管理兩列、midigen_bridge 橋＋假引擎測試 25 項、宿主三層退路與卡片層級列）；批次七（實機量測）被自動分類器擋下，未驗證，需使用者在自己機器上用 scripts/music-tests/midigen-bench.html 量測。

### 下一步（作曲家升級，管理層派工，2026-11-02，（上一項，已完成））：AI 真的是作曲家，不只是選範本
使用者原話（2026-11-02）：「請問照這樣，有哪個是他透過api去填入midi 的note的?感覺只是讓ai選種子」；「yes，他必須是一個作曲家，像是在拆uml一樣，divide and conquer, 然後組裝起整體」；先前：「他好歹要LLM學會...」。UML design 的意思（使用者定義）：由上而下持續規劃、細切到不可再切，再用 CoLU 接線；弱到不能規劃時用樣板；不是寫死流程。
- 設計寫在 DESIGN.music.md「作曲樹」章節。新模組 renderer/src/music/compose_tree.js（FaComposeTree）：規格 → 曲式 → 每段和聲 → 每段聲部分工 → 主題動機 → 程式發展與組裝 → 整體檢查；每個節點小而封閉、程式驗證、失敗只重做該節點（嚴格版重問，再不行用該節點範本）、結果卡片以樹狀列出每個節點來源（AI 決定／程式修正／範本預設）。
- 進度（每批提交後更新這裡）：批次一～三已提交：設計文件、compose_tree.js 核心＋假模型測試 65 項、宿主接線＋樹狀卡片（重做/改成…）＋經驗回流＋入口測試（細節見 DESIGN.music.md「作曲樹實作紀錄」）。真模型小樣本實測：未驗證（沒有金鑰）。可再加強：旋律發展手法只有原樣/模進/反行/逆行/答句，沒有變奏節奏；每段只問和聲不問段內小節級的細節；失敗案例進 UML 編修候選仍未做。
- 階段七（音樂知識與維基風格查詢）仍暫緩。管理層代發，不要自己執行發布腳本；context 到 30% 自己更新本段、提交，回報「需要接手，文件已更新，commit <hash>」。

### 下一步（handoff 7 接手，2026-11-02，（前一輪））：讓作曲真的由 LLM「學會」理解需求
使用者原話（2026-11-02）：「他好歹要LLM學會...我們handoff7 有辦法enable這件事情嗎？」；實測 v267 的 /media-compose-midi 顯示：「這次沒有用 AI，用的是範本規則（AI 的回答讀不懂（The user wants to create tech-style musi…））」。

**現況（已提交 6b16b71a）：** renderer/src/music/compose_plan.js（FaComposePlan：decide／parseAnswer／questionOf／toOptions／edit／describe）、宿主 renderer/src/floating-assistant.js 的 _midiComposeFlow／_midiComposeFinish／_midiRecompose／_mountComposeCards（卡片 fa-compose）；斜線 /media-compose-midi 與工具 midi_compose 都走 _midiComposeFlow；測試 scripts/music-tests/compose_plan.test.js（27 項，假 AI：完美、亂答、無 JSON、部分答對、沉默、逾時、丟錯、重試）。AI 呼叫是 this._callSimpleCompletion(user, { systemPrompt, maxTokens: 300, temperature: 0, noBudgetRetry: true })，逾時 25 秒，最多 2 次。

**失敗原因（推測，尚未用真模型驗證）：** 現在是「一次要整包 JSON」（questionOf 一段長系統提示 + 六個字母欄位 + purpose）。有些模型會先回英文的思考文字（「The user wants to create…」），沒有 JSON，parseAnswer 讀不到，整段退回規則。maxTokens 300 對會先思考的模型也可能不夠（思考吃光上限，答案是空的；_callSimpleCompletion 的預算加倍重試被 noBudgetRetry 關掉了）。

**管理層查到的原因（補充，未用該模型驗證）：**
- renderer/src/floating-assistant.js 約 73788 行（_midiComposeFlow）：ask 呼叫 _callSimpleCompletion(user, { systemPrompt, maxTokens: 300, temperature: 0, noBudgetRetry: true })。
- renderer/src/music/compose_plan.js：questionOf() 一次要整包 JSON（七個欄位）；parseAnswer() 只取第一個 {…} 並 JSON.parse，不剝思考文字、不寬容；decide() 第二次重問是同一題原樣重送，不會有不同結果。
- 使用者看到的回覆開頭是英文「The user wants to create tech-style musi…」：推測是帶思考過程的模型在 maxTokens 300 內把 token 用在思考，回覆被截斷、JSON 還沒出現。要先確認 _callSimpleCompletion 會不會把思考內容混進回覆、有沒有 reasoning 參數可關或可分離。
- 我在內建瀏覽器用假模型回「The user wants to create tech-style music…」重現了同樣的症狀（兩次都讀不懂、退回規則）；進度卡現在會寫出模型名稱與回了什麼前 80 字。

**這一輪已加（進度卡，使用者另外回報「按斜線指令沒有任何處理中的卡片」）：** _midiComposeFlow 現在會放一張「🎼 作曲」進度卡（【理解需求】【核對】【作曲】，含模型名稱、AI 回答的欄位或回的前 80 字、退回規則的原因）；compose_plan.js 的 decide 多了 onStep 回呼與 report.aiRaw。尚未做：逐欄診斷（哪一欄、回了什麼）要在逐欄提問改好後再補。

**要做的事（照使用者要求，沿用 CoLU／弱模型 harness 做法）：**
1. 一次問一欄、字母作答，不要整包 JSON；每題前面放 2～3 個範例（few-shot），明講「只回一個字母，不要解釋」；用途（purpose）另外一題，回一句話。
2. 解析要寬容：剝掉思考區塊（<think>、英文思考）與前後文字，在回覆裡找第一個／最後一個合法字母或欄位值；仍讀不懂就用同一題「更嚴格版」重問一次（把上次的回覆貼回去，說明格式錯在哪），兩次都失敗才退回「那一欄」的預設，只退那一欄。maxTokens 要夠（思考型模型）或開預算加倍重試。
3. 診斷要誠實：失敗時卡片要寫出是哪一欄、模型回了什麼（前 80 字）、用了哪個模型（this._getApiConfig().apiModel），方便判斷是模型問題還是提示問題。FaComposePlan.decide 的 report 要多帶 perField 診斷。
4. 經驗回流（harness 的學習層）：使用者最後接受的結果（沒按「換一首」、直接用或下載）當作程式驗證過的成功，經 renderer/src/harness/experience_core.js 的閘門寫進離線訓練器；之後類似說法（「科技感／電子／用來描述某產品」）由程式直接對到正確範本與配器，不必每次問 AI；失敗案例進 UML 編修候選，不直接當知識。先讀 skills/weak-model-harness 與 DESIGN.TODO.harness-skill.md、experience_core.js 的介面。
5. 用 skills/weak-model-harness 的假模型測試法測：完美、亂答、英文思考文字、沉默、逾時、只回一半，每種的欄位與退路；再用真模型（claude-haiku-5-5 或使用者設定的模型）小樣本實測一次並記用量；沒實測的寫「未驗證」。
測完跑整套入口測試（tray_dialog 與遠端協定探測是偶發既有項，單獨跑通過即可）、提交，回報最後一行「已提交，可發布，commit <hash>」。

**其他已完成、別重做：** 階段 6 配樂（bb43a845）、音色庫換瘦身版（99371b76，記得 v262 起預設 6.3 MB）、播放卡片清混音（a29bd77f）、說明文字與離線模型管理音樂區（f43774ff）、作曲說法路由與成品卡片（448917dc）。階段 7 仍暫緩。

### 已完成（handoff 7 接手，2026-11-02）：作曲「理解需求」改成逐欄提問
- **查證結果**：`_callSimpleCompletion` 只讀 `choices[0].message.content`，標準的 `reasoning_content` 不會混進回覆；但有些模型（或轉接服務）會把英文思考直接寫在 content 裡（使用者看到的「The user wants to create tech-style musi…」就是這種），而且舊的整包 JSON 一次要七欄，模型先思考就讀不到 JSON。`maxTokens: 300` + `noBudgetRetry: true` 讓「思考吃光額度、回空白」無法自動加倍重試。這些是讀程式的結論，**沒有用真模型驗證**。沒有找到可關閉思考的通用參數（`reasoning_effort` 只在進階取樣設定，不通用），所以改成問得短、讀得寬。
- `compose_plan.js`：`questionOf(欄位, 需求, strict)` 一次問一欄（風格、情緒、速度、調式、主奏、長度、用途），每題附三個範例、明講只回一個字母；`parseLetter` 先剝思考區塊（含沒關的 think），再找 JSON、開頭字母、「答案是 X」、整句只有選項名稱，長篇英文思考文字不亂猜；第二次用「更嚴格版」（貼回上次回覆、說明不合法）；兩次都讀不懂只那一欄退回規則／預設。使用者已經說了的欄位（風格詞、bpm、小調／大調、樂器、小節數、用途）不問。連線類錯誤連兩次就不再問後面的欄位，前三欄一個都沒答對也停（避免每欄都等逾時）。`report.perField` 帶每欄的次數、回覆前 80 字、錯誤，卡片的提醒會寫「AI 沒答對的欄位改用程式預設：欄位（原因）」，進度卡寫模型名稱。
- 宿主 `_midiComposeFlow`：maxTokens 改 400（用途 200），**不再關預算加倍重試**。
- 經驗回流：結果卡片多了「👍 就用這個」按鈕（使用者按了才算接受）。`_composeLearn` 經 `FaHarnessExp` 閘門（只收程式驗證過的、去識別、去重、上限）存本機 `fa_compose_experience`，並把 pattern 送進離線訓練器 `harness_experience` 領域（預設停用）。之後類似說法（字元二連詞相似度 ≥ 0.7）由 `FaComposePlan.matchLearned` 直接對到字母，那幾欄不再問 AI，來源顯示「以前學到的」。程式猜的與預設的欄位不收。失敗案例進 UML 編修候選：**未做**（只有成功回流）。
- 測試 `scripts/music-tests/compose_plan.test.js` 43 項：加了 parseLetter／parsePurpose、六種假模型（完美、亂答、英文思考文字、沉默、逾時、只回一半）與嚴格版重問、學到的說法。
- **未驗證**：真模型小樣本實測（這個環境沒有 API 金鑰）；「就用這個」按鈕在真實介面的點擊與離線訓練器匯入；快取／網頁版載入。使用者實測時請看卡片的提醒文字，會寫出哪一欄、模型回了什麼。
- 限制：用途（purpose）那題若模型亂回短句，程式只擋英文思考開頭與過長，擋不掉一句不相干的中文。

### 階段 6 已提交（handoff 7）
- 新模組 renderer/src/music/soundtrack.js（FaSoundtrack：規格、淡入淡出、循環鋪滿、wav、播放控制；真渲染測試 scripts/music-tests/soundtrack.html）、工具 soundtrack_make。簡報：deck.soundtrack（set_deck 的 soundtrack、編輯器簡報屬性裡的配樂列，播放接在旁白下、匯出 MP4 混進去）；遊戲：set_bgm 的 soundtrack 參數、場景面板與聲音分頁的「🎼 配樂」按鈕、播放端非同步取緩衝；影片剪輯：「🎼 配樂」鋪滿時間軸存成一筆配音。MIDI 遠端卡片：卡片的 fa-midi 區塊內含 base64（90 KB 以下），遠端收到同樣會掛載播放卡片（讀程式確認，沒有兩台機器實測）。
- 限制：獨立遊戲包不帶配樂（退回風格合成）；影片剪短後配樂不跟著變短；簡報拖進度時配樂重接，未做旁白時壓低；階段 7 依使用者指示暫緩。

### 音色庫驗證結果（handoff 7，2026-11-01，**最新**）
- **結論（已更新）：七項波形門檻沒有全過（10 個位置），但使用者 2026-11-01 決定接受，用最好的一版（22 kHz、SF3 品質 3、6.6 MB）取代原版。已推到 soundfont-assets 分支（commit 9ee509dd06ec0e9c0bcebaaea7c7645294a5edff，單片 GeneralUser-GS-22k.sf3.part000，md5 c6f01d650e1ba739f1a7c84bacf2d661，sha256 與清單一致），FA_ASSET_URLS.gsSoundbankBase 已填，原始 sf2 網址保留當退路。桌面版沒有放進 live patch 清單。**
- 使用者接受的未過位置：頻譜距離 GM 72、5、12、15；重心位移 GM 61、116、7、88；包絡相關 GM 110、83；高頻損失 GM 42。
- 驗證（內建瀏覽器、本機伺服器）：開 renderer/index.html 後資源請求清單沒有 sf2／sf3／spessasynth 檔；第一次播放才出現 spessasynth-processor、spessasynth-lib、manifest.json、GeneralUser-GS-22k.sf3.part000，進度訊息「下載音色庫 第 1 / 1 片」到「就緒」；遠端這一片的 md5 與清單一致。沒驗證：快取後離線播放、桌面版（桌面版同一段程式，沒另外跑）。
- 新增：sf-compare.html 改成七項（靜音、均方根差 ≤3 dB、11 kHz 以下對數頻譜距離 ≤5 dB、重心位移 ≤12%、包絡相關 ≥0.9、接縫爆音、高頻損失清單）；sf-loop.js 加逐樣本波形檢查（改 loop 的樣本照 loop 播放比頻譜與重心，不過就退回原樣本）與高頻分級（11 kHz 以上能量多的樣本不降取樣，用 --hi-share-db=-35）；sf-slim.js 不動兩類樣本：sampleModes=3（鬆鍵後繼續播 loop 後尾段）與用到起訖／loop 位移產生器的（共 135 個）。這兩類被截尾是上一版 GM 35 等大量失敗的原因，修完 131 個比對位置從 44 個失敗降到 10 個。
- 目前最好一版（22 kHz、SF3 品質 3、6.6 MB）：沒有靜音、沒有接縫爆音、高頻損失只剩 GM 42（9.4 dB）。**仍未過的 10 項**：頻譜距離 GM 72（7.4）、GM 5（7.1）、GM 12（6.9）、GM 15（5.0）；重心位移 GM 61（32%）、GM 116（14%）、GM 7（41%）、GM 88（39%）；包絡相關 GM 110（0.58）、GM 83（0.65）。提高 SF3 品質到 7（8.9 MB）只修好 GM 15 並多出 GM 9，所以不是壓縮品質，是降取樣或剩下的 loop 處理造成。
- 下一步（若要繼續）：對這幾個音色的樣本逐一用 --max-rate 不降、--no-add-loop 試，看是哪一步造成；重現指令：node scripts/sf-slim.js 原版.sf2 輸出.sf3 --max-rate=22050 --sf3 --hi-share-db=-35，再 node 小伺服器開 scripts/music-tests/sf-compare.html?a=原版&b=輸出&from=0&to=128。

### 目前狀態（handoff 6，2026-11-01，**最新，先看這段**）
- **階段 5 已提交（2eb0a0c5，入口測試 162/163，唯一失敗是既有的遠端協定探測）**：`renderer/src/music/` 新增 `audio_pipeline.js`、`basic_pitch.js`、`instrument_classify.js`、`audio_models.js`、`audio_runtime.js`；工具 `audio_to_midi`、斜線 `/audio-to-midi [拆軌]`、功能清冊 `music-audio-to-midi`。三個模型都真的下載並在瀏覽器實測（結果寫在 DESIGN.music.md「階段 5 實測」）。限制：Demucs 要關最佳化、只能 wasm、很慢，預設不拆軌；鼓分類門檻與 YAMNet 對真實錄音的準確度未驗證；`/audio-to-midi` 在整個 App 裡沒有手動點過（只測了零件與流程）。
- **下一步：階段 6**（配樂共用介面：先看 `game_audio.js`、簡報 `media-presentation`、影片剪輯 `edit-video` 現有音訊欄位，一個一個接），然後階段 7。發布仍由管理層代發。
- 測試用本機伺服器：scratchpad 的 `srv.js`（`node srv.js <folder>`，埠改用沒被占的，8778 被別人占了），測試頁在 `scripts/music-tests/a2m-*.html`。
- 想還原誤改的檔案時，`git checkout <檔>` 會被權限擋下；改用重新跑 embed/build 讓產生檔回到來源內容。

### 目前狀態（handoff 5 接手時，2026-11-01，管理層寫入，**先看這段**）
- 已完成並提交：階段 0～4。階段 1／2／3 已由管理層發布（v257／v258／v259）。階段 4（音色庫瘦身，cc17af7e）只有腳本與測試，沒有隨 patch 發出的檔案，所以沒發布。階段 5 的模型查證已提交（787c1623：Demucs 6 軌 fp16 約 136 MB、MIT；Basic Pitch Apache-2.0；都沒下載或實跑，Basic Pitch 檔案大小與張量形狀、WebGPU 能否跑沒查到，仍是「未驗證」）。
- **工作樹有上一個接手做到一半、尚未提交的階段 5 規則部分**（`renderer/src/floating-assistant.js`、`scripts/embed-code-ui.js`、`scripts/run-core-tests.js` 等有修改，另有新檔）：它回報「規則部分已寫好、單元測試…」但被截斷、沒提交。**第一件事：看 `git status`／`git diff` 弄清楚這些修改是什麼，跑對應的測試與 `node scripts/run-core-tests.js`，沒有新增失敗就提交；有壞掉的就修好或還原那一段（只還原你確認是上一個接手寫的、不是別人的）。**
- 然後做階段 5 剩下的（拆軌模型的載入與執行、Basic Pitch 轉譜、樂器分類選擇題、分群退路、輸出進 `/edit-midi`），再階段 6、7。
- **等使用者決定、你不要自己做**：① 5.8 MB 瘦身版 SF3（`gs-22k.sf3`，在 scratchpad）要不要取代原版當預設音色庫；② 要不要把音色庫 5 片推到 `soundfont-assets` 分支並填入 `gsSoundbankBase`。聽感尚未用耳朵確認。
- **發布由管理層代發**（使用者 2026-11-01 說「由你代發」）：你**不要執行發布腳本**。每完成一個階段（測試全過、入口測試沒有新增失敗、已提交），在回報最後一行寫「階段 N 已提交，可發布，commit <hash>」，然後立刻接著做下一個階段。若這個階段沒有隨 patch 發出的檔案，註明「只有腳本與文件」。
- **這個 app 不允許子工作階段自己啟動接手**（上一個接手試過）。所以到 context 門檻時：更新本文件、提交，然後在回報最後一行寫「需要接手，文件已更新，commit <hash>」，由管理層啟動下一個。


**已完成並提交（細節與實測結果見 `DESIGN.music.md` §1–§5）：**
- 階段 0：`scripts/sf-analyze.js`（結論：重複樣本不到 0.05 MB，瘦身要靠降取樣與 SF3 壓縮）、轉譜模型查證、piano-web 盤點（c6a21abf）。
- 階段 1 程式：`renderer/src/music/{midi_core,midi_play,midi_ui,music_knowledge}.js`＋測試 `scripts/music-tests/`（41 項全過，已接進 `scripts/run-core-tests.js`）、播放卡片 `fa-midi`、工具 `midi_play`／`midi_to_mp3`／`music_topic`、斜線 `/midi`、`/midi-to-mp3`、domain `music`、合成器程式庫放 `renderer/vendor/spessasynth/`（提交 2befe2d0…最新見 git log）。瀏覽器實測有聲、卡片可播（測試頁 `scripts/music-tests/browser.html`、`card.html`；音色庫本機副本放在 TEMP 的 gs.sf2，**不要放進 scripts/ 以免 publish.sh 的 git add -A 把 32 MB 提交進去**）。

**階段 1 補充（handoff 3 做完的）：** 功能清冊 `features/ai-features.yaml` 已加 `music-midi`（FEATURES.md 是產生檔，不要手改）；mp3 編碼是重用既有 `_encodeMp3`（lamejs，TTS 與抽音訊走同一條，已實用過），未單獨真機跑一次；網頁版合成器路徑推導（__FA_LAZY_BASE 往上兩層＝desktop-app/，再接 renderer/vendor/spessasynth/）檢查過邏輯，**發布後要用 curl 對釘住的 commit 查 200**；合成器程式庫是 fetch 文字後用 data: 網址載入，所以 CDN 的 MIME 類型不是問題。

**階段 2、3、4 已完成並提交（handoff 5）：** 階段 2、3 已由管理層發布（v258、v259）。階段 4 已提交 cc17af7e 並回報管理層（只加腳本與測試，不影響主程式）：`scripts/sf-loop.js`、`scripts/sf-slim.js`、`scripts/music-tests/sf-compare.html`；實測 GeneralUser GS 本來就設好短 loop，找 loop 只省約 5%，降到 22 kHz 加 SF3 從 32.3 MB 剩 5.8 MB（瘦身版放在 scratchpad 的 gs-22k.sf3，**沒有進 repo**，要不要當預設音色庫由使用者決定）。音色庫分片推送（soundfont-assets 分支）仍等使用者決定，**不要推、不要填 gsSoundbankBase**。

**發布一律由管理層代發**：每階段提交、入口測試（node scripts/run-core-tests.js，約 3 分鐘，用 run_in_background 輸出到 /tmp 再用 Monitor 等；遠端協定探測那組是不穩定的既有測試）無新增失敗後，用 SendMessage 回報 local_49f6c57d-8f18-427b-a8f1-7b1d23efc5f5「階段 N 已提交，可發布，commit <hash>」，然後立刻接著做。**app 不允許在自動事件回合用 start_session（會被拒），所以接手工作階段要由使用者或管理層在對話裡要求才起得來；本工作階段 context 過門檻（34%）後停在這裡。**

**第一項（現在就做）：階段 5 的剩餘部分**（查證結果已寫進 DESIGN.music.md「階段 5 查證」，規則部分已完成）：
- 已提交：`renderer/src/music/audio_to_midi.js`（鼓軌規則拆解、YIN 單音音高追蹤、音符切分、速度估計、量化、樂器標籤對應 GM、音域退路、組裝多軌）＋ `scripts/music-tests/audio_to_midi.test.js`（12 項，**用合成音訊調的門檻，真實錄音還沒試過**，鼓分類門檻要用真實鼓樣本再調）。已加進 embed 清單與入口測試。
- 待做 1：`FaAudioToMidiPipeline`（新檔 `renderer/src/music/audio_pipeline.js`）：解碼（WebAudio decodeAudioData，重新取樣到 44.1 kHz 立體聲）→ 可插拔分軌器（`separator(chunk) → {drums,bass,other,vocals,guitar,piano}`，沒有就把整個混音當一軌，鼓用 drumHits、其餘用 Basic Pitch 介面或單音追蹤）→ 逐軌轉譜 → 分類標籤 → buildSong；長曲分段（7.8 秒一段、重疊相加）、可中斷續跑（每段結果存 IndexedDB）、進度只出一張卡。介面用假的分軌器與假的轉譜器寫測試。
- 待做 2：模型登錄與下載（沿用 FaVlm 的登錄與工作執行緒，`renderer/src/vlm/vlm_core.js`、`faVlmWorkerMain()`）：Demucs 6 軌 ONNX（adowu/htdemucs-6s-onnx，fp16 版 136 MB，MIT）、Basic Pitch nmp.onnx（Apache-2.0，大小未驗證）、YAMNet ONNX（約 15 MB，Apache-2.0）；WebGPU／WASM／CPU 三條路；下載要進度、續傳、核對大小與檢查碼；**檔案大小、輸入輸出張量、瀏覽器速度都未驗證，先下載一個真的跑一次再寫進文件**。
- 待做 3：工具 `audio_to_midi({file_id})` 與斜線 `/audio-to-midi`，結果用 `_midiPushEditor` 進編輯器，並在回覆誠實寫明：拆樂器只到鼓／貝斯／人聲／其他（模型有就多吉他與鋼琴）、沒有模型時哪些部分被跳過、不保證準確。加進功能清冊 `features/ai-features.yaml`、domain music 的 toolNames 與提示詞。
- 之後：階段 6（配樂共用介面：先看 `game_audio.js` 與簡報、影片編輯器現有音訊欄位，一個一個接）、階段 7（風格知識工具 music_style_lookup 與範本）。

**之後各階段（做完前一階段再做下一階段，不要問）：階段 2 → 7，內容見原文如下（階段 1 已完成的部分略）。**
- **階段 2**：MIDI 編輯器 `/edit-midi`（仿 `FaEditShell` 外框：音軌欄、鋼琴捲簾、屬性、復原重做、底部 AI 對話框；**音色只能選 GS 音色**，GM 128＋鼓組；piano-web 的多音軌設計可參考，但不要整個搬）；**內建問 AI**：編輯器底部對話框用封閉動作（add_note、move、transpose、quantize、set_program、add_track、delete…）加 `parseCommands`（程式先讀中文），讀不懂才問模型；**遠端**：MIDI 播放卡片要能在遠端卡片裡顯示（看 `REMOTE` 區塊與遠端卡片機制，`renderer/src/remote/`），**遠端編輯**（遠端的人改同一份 MIDI，沿用現有遠端群組的訊息通道；衝突用「較新者勝＋事件層級合併」，每次編輯是一個事件）。
- **階段 3**：AI 創作。UML design 的意思（使用者定義）：「由上而下持續規劃，細切到不可再切，再用 CoLU 接線；弱到不能規劃時用樣板；不是寫死流程」。做法：風格→段落結構（前奏／主歌／副歌…）→和弦進行（從風格範本挑，程式驗證調內和弦）→旋律（節奏型範本＋和弦音約束，程式驗證音域與不超過跳進上限）→伴奏／貝斯／鼓（範本）→配器（GM 音色對應）。模型只做封閉選擇題與填空（挑風格、挑進行、挑速度），生成的音符由程式產生並檢查；檢查失敗自動重來（暫時性失敗要自己重試到底）。輸出直接進 `/edit-midi`。可存成功案例進離線訓練器（`editor_cases` 種類 `edit-midi`）。
- **階段 4**：依階段 0 的分析報告，做 `scripts/sf-slim.js`：去掉未使用樣本、合併完全相同的樣本、近似重複改成共用（調整調音偏移）、降取樣率（依音高與用途，例如 22.05 kHz／16 kHz）、截短循環前多餘的尾段、壓縮（Ogg Vorbis 的 sf3，SpessaSynth 若支援 sf3 就用；不支援就用自訂分檔格式＋解壓）。目標：**迷你 GS 音色庫**（使用者說 Roland Virtual Sound Canvas SC-88 的安裝包與音色檔非常小，GeneralUser GS 太大，要最小化音色並找出重複區）。**階段 4 更正（使用者 2026-11-01）：「找重複」是指每個樣本波形內部的 loop，像壓縮演算法，不是樣本之間的重複（階段 0 已證明幾乎沒有）。** 做法：① 自相關／週期偵測找基頻週期與穩定段，找可無縫循環的起訖點（對齊零交越、相位連續、能量一致，避免喀嚓聲）；② 有 loop 的樣本，loop 結束點之後的資料不會被播放，直接截掉；穩定段太長的只留整數個週期當 loop，其餘丟掉；③ 沒有 loop 的持續音（弦樂、管樂、合唱等）嘗試自動找 loop 並加上，打擊類單擊音不加；④ 再降取樣率與 SF3 壓縮。聽感比對工具要加：同一份 MIDI 用原版與瘦身版各渲染一次，算頻譜差異與接縫處的不連續度，列出差異最大的音色。
**重要：Roland 的音色資料有版權，只能當「大小目標」參考，絕對不要抽取、轉換或散布 Roland 的樣本。** 只對 GeneralUser GS（允許修改散布，保留授權文字）做瘦身；每次瘦身要附**聽感比對工具**（同一份 MIDI 用原版與瘦身版各渲染一次，算頻譜差異，列出差異最大的音色給人聽）。
- **階段 5**：mp3→MIDI：解碼（WebAudio）→（可選）拆四軌（人聲／鼓／貝斯／其他）→逐軌轉譜（Basic Pitch 類）→樂器指派（貝斯軌→GM 貝斯、鼓軌→鼓組、其他→用封閉選擇題＋程式核對挑 GM 音色，例如鋼琴／吉他／弦樂）→量化→輸出 MIDI 進 `/edit-midi`。三種執行環境：WebGPU、WASM、CPU 降級，沿用 `FaVlm` 的模型登錄與工作執行緒（`renderer/src/vlm/vlm_core.js`、`faVlmWorkerMain()`）、下載進度卡（只出一張進度卡，記錄分「章節／主角／行為」，沿用 image-to-3d 的做法）。**拆成「多種樂器」只能到四軌＋鼓；更細的樂器分離沒有可靠的離線小模型，要在結果裡誠實寫明。** 長曲子分段處理、可中斷續跑。
- **階段 5 採用的順序（使用者 2026-11-01 同意；模型名稱、檔案大小、授權、能否在瀏覽器跑都是未驗證，開做前先查證並寫進 DESIGN.music.md，查不到標「未驗證」）：** ① 6 軌版 Demucs（人聲／鼓／貝斯／其他＋吉他＋鋼琴，MIT 授權待確認，有沒有 ONNX 待查）＋ Basic Pitch 逐軌轉譜；鼓軌用規則拆底鼓／小鼓／踩鑔／通鼓／鈸（偵測打擊起點，再看頻帶能量：底鼓低頻、小鼓寬頻雜訊、踩鑔高頻）對應 GM 鼓組音符；人聲與貝斯是單音，用音高追蹤（pYIN 類）。② 「其他」軌再用樂器分類（YAMNet／PANNs／AST／Essentia 之一，擇可在瀏覽器跑者）對每段打標籤，封閉選擇題＋程式核對挑 GM 音色。③ 分類不準退回：音符頻譜特徵（質心、MFCC）分群，每群指派一個 GM 音色；最後才用音域規則當預設。可評估用 GS 音色樣本當字典做非負矩陣分解，只做實驗不當預設。④ MT3／YourMT3+ 太大，只當桌面版「使用者自備、選用」，不內建。⑤ 三種執行環境沿用 FaVlm；下載只出一張進度卡；長曲分段可續跑；結果誠實寫明拆樂器只到這幾軌。輸出進 /edit-midi。
發布前入口測試（node scripts/run-core-tests.js）不能有新增失敗；發布被權限檢查擋下就回報使用者，不要繞過。
- **階段 6**：「配樂」共用介面：簡報（`media-presentation`）、2D／3D 遊戲（`edit-game-2d`、`edit-game-3d`）、影片剪輯（`edit-video`）都能選一個 MIDI 或 mp3 當配樂（循環、淡入淡出、音量）；先看這四個編輯器現有的音訊欄位（遊戲有 `game_audio.js`），一個一個接，不要一次大改。
- **階段 7**：風格知識。工具 `music_style_lookup`：用瀏覽器查維基（`browser_search`／`fetch_web_page` 已存在）找某個風格的介紹，程式抽出「速度範圍、拍號、典型和弦進行、典型樂器、節奏特徵」存成**風格範本**（使用者可停用／刪除，存進離線訓練器的領域知識，仿 `editor_cases`）；內建一批常見風格的範本（離線可用）。階段 3 的創作優先用範本。

**完成後直接發布**（使用者慣例：完成一個階段、測試全過就更新網頁、發布 patch；**沒有全過不要發布**）：`PUBLISH_TRAILER="Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" bash scripts/publish.sh -m "…"`，再 curl 查遠端 `manifest.v2.json` 版本。發布前確認：新模組的網頁版區塊檔都在 `web-lazy/manifest.json`、都在釘住的 commit 下回應 HTTP 200（這台 Node 沒有 `fetch`，`web-lazy-check.js --remote` 會失敗，改用 curl 逐一核對檢查碼）；桌面版整份檔案所以不受影響。如果發布腳本被權限檢查擋下，回報給使用者確認，不要繞過。

## 4. 做法備忘（使用者的規則）
- 發布被權限檢查擋下就回報使用者，不要繞過。
- 繁體中文、結論先說、不要在中文裡夾英文縮寫；做完誠實說哪些沒驗證。
- 改來源模組（`renderer/src/music/*.js`），再 `node scripts/embed-code-ui.js && node build-assistant.js`；不要改嵌入後那份。新模組要加進 `scripts/embed-code-ui.js` 的嵌入清單，並確認 `web-lazy` 建置有把它拆成區塊。
- 改檔用 Edit／Write 工具；**Bash heredoc 內的 Python 會吃掉反斜線與中文**，需要時用 Write 工具寫 `.py` 檔再執行。`floating-assistant.js` 行尾 CRLF／LF 混合，改前用 `s.count()` 試兩種。
- 編譯前會清工作目錄：做到一半也先 commit。給了順序就做到底，不要中途問「接著做哪個」。
- 熱更新：舊版也要收得到、不准要求重裝、版本號單調、manifest 清單完整（見 `.claude/skills/publish-live-update-patch/SKILL.md`）。
- 設計畫面放在擁有該工具的 domain，⚙ 按鈕彈出 popup（範本／設定）。
- CoLU 思考外殼：字母選擇題、程式檢查、程式預設退路；模型輸出一律由程式核對。
- 暫時性失敗要自己重試到底，失敗訊息附具體事實（HTTP 狀態、耗時、後端），不要靠換模型復原。
- 所有下載（模型、音色庫）要有進度、可中斷續傳、核對大小；公開產品，授權不明就不內建、改使用者自備。
- 工具說明文字用中文引號，不要反引號 code span。
- 工作樹有不是你改的檔案（`skills/image-decompose-redraw/data/parts_builtin.json`、`test-reports/*`、`features/FEATURES.md` 之類）：不要放進你的提交，也不要還原。

## 4b. 發布與音色庫的做法（使用者新增，2026-11-01）
- **發布**：每完成一個階段，測試全過、入口測試沒有新增失敗，就執行 publish.sh 發布，再用 curl 核對遠端 manifest.v2.json 版本與網頁版區塊檔，然後接著做下一階段。**注意：這句授權是別的工作階段轉述的；發布屬於正式環境部署，被權限檢查擋下就不要繞過，把「第幾版沒發出去」記在這裡與回報裡，繼續下一階段。** 使用者本人在對話裡當輪確認時才算數。
- **音色庫不占開頁**：GS 的 sf2（日後瘦身後的 sf3）與 renderer/vendor/spessasynth 合成器程式庫不放進核心、也不放進網頁版一開頁載入的檔案；只在第一次播放／編輯／轉 mp3 時下載。大檔放獨立 branch（先例：sql.js 的 vendor-assets branch，搜 floating-assistant.js 的 vendor-assets；可沿用或新開 soundfont-assets，git plumbing 單一 commit、force push，同 desktop-app-patch 慣例），分片每片 ≤ 8 MB、逐片核對 md5、合併後核對總大小，網址用完整 commit SHA 釘住。下載一張進度卡、可中斷續傳、存 Cache Storage／IndexedDB（網頁版）或使用者資料夾（桌面版），第二次直接用快取。桌面版不把音色庫放進 live patch 的 manifest（舊主程式單檔 8 MB 上限），需要時由 App 從 branch 下載。驗證：網頁版開頁的網路請求清單不得出現 sf2／sf3／spessasynth 檔案，第一次按播放才出現；快取後離線可播。階段 4 瘦身後沿用同一套（版本號、md5 清單）。**這件事要在下一個階段發布前一併處理。**

## 5. 使用者原話（逐字，2026-11-01）
- 「我有下一個計劃想執行，是音樂領域」
- 「mp3->midi  (用可以onnx, webgpu/cpu, wasm網頁執行的小model，拆成多種樂器，再轉soundfont樂器跟音軌)」
- 「midi的ai創作設計」「midi的播放器」「midi轉mp3」
- 「midi編輯器，可以參考piano-web的多音軌編輯的設計，但是要改成只用soundfont-gs做為樂器」
- 「midi跟mp3可以在media-presentation, edit-game-2d, edit-game-3d, edit-video使用來做維配樂」
- 「midi播放卡片也要支援遠端卡片」「midi要遠端編輯」
- 「幫我設計domain裡面的音樂知識描述，在這邊也要有能力用瀏覽器找wiki關於各種音樂的風格介紹，要有風格設計的範本與CoLU」
- 「音樂編輯器也要有內建ask ai」
- 「這個應該也是可以lazy-loading」
- 「然後我希望裡面用到的generic可以重新評估、取樣跟壓縮，因為我有買過一個roland virtual canvas sc88，但他整個安裝包跟音色檔非常小。這個gs的soundfont音色太大。想要最小化音色，來找出重複區」
- 「那幫我在階段四，除了壓縮格式外也把loop找出來最小化音色」（2026-11-01）
- 「我說的找重複不是音色重複，是類似壓縮演算法，例如找到聲音裡面的loop區段」（2026-11-01）
- 「好，階段五採用你的建議，先照著順序往下做」（2026-11-01）
- 「請完成每一個就自動發布，並接著往下做」（2026-11-01，經 desktop-app 工作階段轉述）
- 「音色我們可以放到branch或者lazy-loading，避免網頁一進去就占用」（2026-11-01，經 desktop-app 工作階段轉述）
- 標準發布指令（歷來）：「更新網頁，發布patch」「完成就可以更新網頁，發布patch」；態度：「JUST DO IT!」「不要再繼續plan了」。

## 6. 交接流程（自我遞迴）
執行 low-context-long-run 技能（門檻 30%）：每個批次邊界用 `mcp__ccd_session_mgmt__get_usage` 看 context，≥30% 就更新本文件、提交、用 `start_session`（initiation `user_asked`、context `fresh`、工作目錄 `D:\Downloads\videos-嗨投資-desktop-app\desktop-app`、`use_worktree:false`）啟動接手，確認後 `mark_completed`＋`archive_session`（被拒就跳過並告知，不要重試迴圈）。

## 7. 陷阱
- **Roland 版權**：SC-88／Virtual Sound Canvas 的音色不能抽取或散布，只當大小目標。piano-web 的 `gs-engine.js` 檔頭記載使用者先前用過 Nuked-SC55（需要使用者自備 ROM、而且是非商業授權），後來換成 SpessaSynth＋GeneralUser GS，原因就是授權；不要走回頭路。
- piano-web 是獨立專案（`D:\Downloads\SRC\piano-web`，有自己的 git）：只讀；要用的程式「移植」進本專案，不要讓本專案依賴那個資料夾。
- 音色庫 43 MB（base64）絕不能進核心檔；音色與合成引擎都是延遲載入的區塊或使用者下載。
- 轉譜模型多半只能到四軌（人聲／鼓／貝斯／其他）；不要在說明裡承諾能分出任意樂器。
- 遠端編輯要先看現有遠端機制能不能傳「事件」而不是整份檔案，大 MIDI 整份傳會卡。
- 網頁版是離線優先：區塊下載失敗要明確提示、已載入的能用。
- `scripts/embed-code-ui.js` 會把 `floating-assistant.js` 整份重寫（行尾可能被統一）；提交時看 `git diff --stat`。

## 8. 階段 1 學到的坑（handoff 2 新增）
- 離線渲染（OfflineAudioContext＋SpessaSynth）送完事件後要等一下才能 startRendering，否則整段靜音（事件經訊息埠非同步到處理器執行緒）；`renderOffline` 已處理。
- 瀏覽器窗格隱藏時下載與計時會被節流：測試用本機伺服器＋本機音色庫副本；`javascript_tool` 不要回傳大量日誌（進度回呼只存最後一則）。
- `scripts/publish.sh` 會 `git add -A renderer scripts web-lazy`：scripts/ 底下不能放大檔；其他工作階段未提交的檔案也會被帶進去，發布前看 `git status`。
- 本機 python http.server 在這台會回 404（cwd 問題），改用 scratchpad 內的小 node 伺服器（`node srv.js <資料夾>`，埠 8777）。
- 嵌入 `floating-assistant.js` 的模組 factory 取不到另一個嵌入模組要用 `root.X || (typeof X !== "undefined" ? X : undefined)`（見 midi_play.js 開頭）。
- 對 `floating-assistant.js` 的大改用 Write 寫一次性補丁腳本（scratchpad），錨點必須唯一，CRLF/LF 混合所以錨點用單行。

---

## 原檔：nvim-wasm

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

---

## 原檔：path-experience

# 路線經驗：CoLU+Thinking 的正路、分支與反思（TODO，整理文件）

**目的**：把 CoLU+Thinking 七個階段（加上調查）走過的路，整理成之後同類任務可以先讀的「路線經驗」。這份是人讀的版本；機器讀的版本在 `skills/weak-model-harness/references/path-experiences.json`（共 40 筆）。

**來源與方法**：
- 工作階段紀錄（唯讀）：`export_transcript`／`list_events` 讀過調查與階段 1～7 的工作階段（節錄，不是全文）。
- 提交紀錄：`git log --format="%h %ad %s" --date=iso`，時間是作者時間。
- 設計文件：`DESIGN.TODO.colu-thinking.md` 的各階段記錄（第 246 行起），以它為主要證據。
- 每條都附來源：工作階段名、提交號或文件行號。

**標記規則**：
- 「證據」欄只寫看得到的來源。推測會明寫「推測」。
- JSON 的 `verified` 欄位：`true` 表示這條的測試指令本次已重跑並通過（見下方「核對表」）；`false` 表示只來自工作階段紀錄，本次沒有重跑。

---

## 0. 時間線（提交作者時間，只能看跨度，不能當各階段耗時）

| 時間（2026-11-04） | 提交或事件 | 說明 |
|---|---|---|
| 16:00:57 | `e12ff754` 調查草案 | 調查 Haiku（`local_fd90132f…`）完成第一版 |
| 16:01:41 | `8e0f2417` 補充範圍 | 同一工作階段補充全部離線文字模型（管理層中途擴大範圍） |
| 16:01 → 18:04 | （無 CoLU 提交） | 推測：等待使用者定案六項決定（使用者決定小節） |
| 18:04:22 | `4115b65e` 使用者六項決定 | 之後才開始階段 1 |
| 18:06:06 | `4d30a0c0` 階段 1 | 思考剝除純函式 |
| 18:10:34 | `adea8058` 階段 2 | 思考參數與預算 |
| 18:28:16 | `500bcdb4` 階段 3 | 計畫階段接上思考 |
| 18:35:59 | `a3c16797` vendor 同步 | 把 vendor 副本同步到來源（由另一個工作階段提交） |
| 18:51:22 | `8784bbbb` 階段 4 | 反思 |
| 19:02:53 | `b12affba` 階段 5 | 設定開關與推理顯示 |
| 19:02 → 20:26 | （無 CoLU 提交；中間有 `225ac54b`、`7aa10ec8`、`f0780c44` 等其他工作線提交） | 推測：管理層同時推進其他工作線 |
| 20:26:24 | `bd8f9bbf` 階段 6 量測計畫 | 尚未縮小 |
| 20:54:04 | `8414f5a8` 階段 6 結果 | 縮小為每組 8 題後真跑，寫入記錄 |
| 21:08:26 | `459f84bb` 階段 7 | 逾時硬性上限 |
| 21:15:07 | `7e0ada05` 階段 7 任務 C | 依裝置取逾時 |
| 21:23 | 桌面程式重新啟動 | 階段 7 的量測中斷，改為讀結果檔接續 |
| 21:33:16 | `cc1f44c0` 階段 7 任務 D | 處理器版反思重量測 |
| 21:44:26 | `92bbafdd` 管理層彙整 | 最後一筆 CoLU+Thinking 提交 |

**耗時的誠實說明**：階段 1 與階段 2 的提交只差 4 分鐘，但兩者都有幾十則以上的操作紀錄，所以提交時間不足以估算各階段耗時。能確定的只有：階段 6 的真量測約需 34 分鐘（管理層估算上限，見 `bd8f9bbf` 的計畫）；階段 7 任務 D 的九次反思量測約 800 秒（記錄第 263 行）。16:01 到 18:04 的空檔是推測的使用者決定等待，沒有直接證據。

---

## 1. 整體正路（跨階段的順序，證據見各階段）

盤點（調查）→ 思考剝除純函式（階段 1）→ 思考參數與預算（階段 2）→ 計畫入口接線（階段 3）→ 反思（階段 4）→ 設定與推理顯示（階段 5）→ 真模型量測（階段 6）→ 逾時修正與依裝置分流（階段 7）。

每一步都是「純函式＋假模型測試＋真 Electron 評估」的三層驗證。這個順序是有效的，主要的碰壁都發生在「真評估」那一層（見第 2 節各階段的分支）。

---

## 2. 各階段：正路／分支／反思

### 調查（inv）

- **正路**（`inv-positive-1`）：先 Grep 定位模型表與關閉思考的地方，再小段讀取；盤點結論附行號，「沒查」另立一節。驗收：`grep -n "qwen3-0.6b" renderer/src/vlm/vlm_core.js` 命中第 30 行，`qwen3-1.7b` 命中第 48 行（本次已核對）。
- **分支**（`inv-branch-1`）：中途範圍從 Qwen 擴大到所有離線文字模型。選擇同一工作階段補充（`8e0f2417`），沒有另開。結果：補充完成，但文件末尾的「要先問使用者」清單沒有同步更新（記錄在 `8e0f2417` 的最後回報中）。
- **反思**（`inv-reflection-1`）：盤點前要先確認「來源檔」與「建置檔」各自的行數與位置。證據：階段 1 的 `floating-assistant.js:34015` 在 `renderer/floating-assistant.js`（1196 行）找不到；階段 2 又改了同一檔的 50881 行。同一個檔名兩份副本，行號完全不同。

### 階段 1：思考剝除（`4d30a0c0`）

- **正路**（`1-positive-1`）：讀規格 → 寫 `stripThink` → `jsonStep` 先剝再驗證 → 17 項新測試 → 只提交三個檔。驗收：`recipe_core.test.js` 89 通過（本次已重跑）、`plan_core.test.js` 57、`skill_compile_core.test.js` 48（本次已重跑）。
- **分支 A**（`inv`、`1`）：文件給的行號對不上，選擇「照規格重寫」而不是照抄。結果：可以實作，行號只當線索。
- **分支 B**（`1-branch-1`）：vendor 副本刻意不同步，留給發布階段。結果：階段 3 的可攜測試失敗，後來由 `a3c16797` 同步，多花了一段來回。
- **反思**（`1-reflection-1`）：改了有 vendor 副本的來源，提交前要跑 `node scripts/harness-tests/portable.test.js`（本次重跑：11 通過）。同階段就同步。

### 階段 2：參數與預算（`adea8058`）

- **正路**（`2-positive-1`）：`thinkingPlan` 純函式 → `jsonStep` 三層退路（思考一輪、關閉思考重問一次、既有的 ok:false）→ 離線工作者接參數 → 語法檢查。驗收：`think_plan.test.js` 通過（本次重跑：49，階段 2 當時是 41，階段 7 任務 C 加了 8）。
- **分支 A**（`2-branch-1`）：思考那一輪帶了 prefill，模型跳過思考。階段 3 才發現並修正：只有退路那一輪帶 prefill。
- **分支 B**（`2-branch-2`）：`embed-code-ui.js` 會全量重寫所有嵌入區塊，需要逐一 diff。之後每階段都重複這個步驟。
- **反思**（`2-reflection-1`）：跑真評估前先用標記字串確認評估載入的是哪一份檔（`grep -c "_coluThinkingFor" renderer/floating-assistant.js`）。階段 2 沒有重建建置檔，這個錯誤在階段 4 才顯現（0 次反思）。

### 階段 3：計畫階段接上思考（`500bcdb4`）

- **正路**（`3-positive-1`）：`_coluThinkingFor` → `_umlDesign` → `designProject` → `scenarioToModel` → `jsonStep`；推理只放回傳欄位與進度文字。驗收：`plan_think.test.js` 25 通過（本次重跑）；真評估 `colu_think_plan.eval.js` PASS（在隔離副本）。
- **分支 A**（`3-branch-1`）：工作目錄不重建建置檔（因為不能碰 `.min.js`），評估改在隔離副本建置。
- **分支 B**（`3-branch-2`）：可攜測試失敗時，先查 HEAD 與 vendor 的狀態，發現同步已由另一個工作階段完成，只回報並提出決定。
- **反思**（`3-reflection-1`）：接線前要先算「題數 × 逾時」的最壞時間。階段 3 只寫了「會變長」，沒有算數；階段 6 量測後才發現單題就超過 30 秒。

### 階段 4：反思（`8784bbbb`）

- **正路**（`4-positive-1`）：`coluThinkReflect`／`coluThinkRevise`／`coluThinkBudget` 純函式 → 計畫層與答案層各接一處 → 真評估五個情境（有缺口重做、上限、輸出壞掉、開關關閉、答案層反思）→ 核心測試並還原使用者報告檔。驗收：`think_reflect.test.js` 24 通過（本次重跑）；`run-core-tests` 174／176，失敗是已知的 `tray_dialog` 與 RFB 探測。
- **分支 A**（`4-branch-1`）：第一次真評估 0 次反思，原因是載入了舊建置檔，不是功能問題。在隔離副本建置後重跑通過。
- **分支 B**（`4-branch-2`）：隔離副本建置時 `robocopy` 遇到含中文的路徑，回傳 exit 16。改用 node 複製，`node_modules` 用 junction；junction 因目的地已有 `node_modules` 失敗，刪掉後重建。
- **分支 C**（`4-branch-3`）：測試抓到 `opts.max || 2` 把 0 當成 2 的 bug。改成 `!= null` 判斷並補測試。
- **分支 D**（`4-branch-4`）：`run-core-tests` 會覆寫使用者未提交的 `test-reports`。先備份、跑完後還原並用 sha1 驗證。
- **分支 E**（`4-branch-5`）：反思預算「整份計畫最多兩次」規格不清楚，是否包含答案層。依字面實作並留待管理層決定。
- **反思**（`4-reflection-1`）：評估出現 0 次呼叫時，先查載入的檔案是否含新程式（`grep -c "_coluReflectFor"` 在隔離副本）。這樣第一次評估就不用白跑。

### 階段 5：設定開關與推理顯示（`b12affba`）

- **正路**（`5-positive-1`）：純函式（設定、推理區塊、跳脫 HTML、截斷）→ 推理掛在進度卡片的不可列舉屬性上（不進對話存檔）→ 真評估驗證開關與收合區塊。驗收：`colu_think_ui.test.js` 20 通過（本次重跑）；`colu_think_ui.eval.js` PASS。
- **分支**（`5-branch-1`）：設定 UI 是否要兩處同步。記憶檔裡有「設定 UI 有兩份」的通則，但這次先 grep 確認，`topicShiftCheck` 只在 `floating-assistant.js` 有 UI，所以只加一處。
- **反思**（`5-reflection-1`）：推理放在卡片還是回覆泡泡，應在動工前交給管理層決定。階段 5 是做完才提出，後來仍停留在卡片。

### 階段 6：真模型量測（`bd8f9bbf` → `8414f5a8`）

- **正路**（`6-positive-1`）：固定種子出題 → 假生成乾跑（7 秒，41 行進度）→ 真跑，進度寫進 `jsonl` 檔 → 統計。
- **分支 A**（`6-branch-1`）：題數從使用者要求的 20 題以上縮成 8 題。估計 CPU 單組超過一小時。管理層決定縮小。
- **分支 B**（`6-branch-2`）：上一次取消的量測留下四個殘留的 Electron 程序，管理層以為已關。自己用程序列表確認是自己的隔離副本後停止。
- **分支 C**（`6-branch-3`）：處理器版的思考 60 秒上限沒有被準確執行，實測最長 148.6 秒。原因在階段 7 才查明。
- **分支 D**（`6-branch-4`）：反思的 15 秒逾時在處理器上九次全部逾時，沒有有效判斷。這是最大的一筆浪費：這台機器的顯示卡不支援 `shader-f16`，量測前就能判定只會跑處理器版，但逾時還是照顯示卡版設定。
- **分支 E**（`6-branch-5`）：結果檔沒存原始回覆，之後無法分辨錯誤是推理錯還是格式錯。
- **分支 F**（`6-branch-6`）：記錄寫完才發現繁簡字與一句超出量測的敘述，提交前修正。
- **反思**（`6-reflection-1`）：量測前先查裝置能力與實際載入的版本，再決定逾時。量測腳本一定要存原始回覆。

### 階段 7：逾時與裝置（`459f84bb`、`7e0ada05`、`cc1f44c0`）

- **正路**（`7-positive-1`）：先讀程式找根因（閒置卸載計時器在呼叫中途觸發，以「已卸載」結束）→ `guardedCall`（中斷、寬限、放棄）→ 只對有 `timeoutMs` 的呼叫生效 → 假工作者測試 19 通過（本次重跑）→ 真評估 PASS（卡住呼叫 8.07 秒拋逾時、退路 8.09 秒拿到答案）。
- **分支 A**（`7-branch-1`）：協作式中斷在處理器上等不到工作者回應，改為寬限後放棄。
- **分支 B**（`7-branch-2`）：逾時值依裝置分組。顯示卡版 30 秒與 15 秒；處理器版 300 秒與 120 秒。預算不變。
- **分支 C**（`7-branch-3`）：處理器版反思重量測，九次全部有效、三題三次一致，但**全部「沒有缺口」**。這代表穩定，不代表會抓缺口，因為沒有已知有缺口的對照題。
- **分支 D**（`7-branch-4`）：量測中途桌面程式重新啟動。不殺程序，改讀結果檔，跑完後寫記錄。
- **反思**（`7-reflection-1`）：列出所有計時與卸載機制，確認它們不會互相殺掉呼叫；量測逾時時看延遲分布（含最長值與超時次數），不只看中位數。

---

## 3. 整體思考捷徑（通則，每條附證據）

> 注意：這一節的通則是從 7 個階段的紀錄歸納出來的。標「推測」的沒有直接量測。

### 通則 1：開工前先查三件事（最大的省時來源）

1. **來源還是建置檔**：同一檔名的來源與建置檔行號完全不同。證據：`inv-reflection-1`（階段 1 的 34015 行找不到）。
2. **評估載入的是哪一份檔**：評估 0 次呼叫時，多半是載入舊建置檔，不是功能有問題。證據：`4-branch-1`、`2-reflection-1`、`4-reflection-1`（階段 4 的第一次評估）。
3. **執行裝置能力**：顯示卡是否支援 `shader-f16`，決定會跑顯示卡版還是處理器版，逾時要依此設定。證據：`6-branch-4`（量測前就能判定，階段 6 白跑了九次反思）；`7-branch-2`。

**前置檢查清單（建議寫進開工範本）**：`grep` 來源與建置檔；`grep -c` 標記字串確認評估載入的版本；查裝置能力再定逾時。

### 通則 2：先 grep 確認有幾份副本，再動手

- 不要套用記憶通則（「設定 UI 有兩份」）。先 grep 確認實際有幾份。證據：`5-branch-1`（只加一處即可）。
- 動手前先查 HEAD 與別人是否已經做過。證據：`3-branch-2`（同步已由 `a3c16797` 完成）。

### 通則 3：有 vendor 副本、建置檔、設定 UI 的同步，要在同一階段完成或明確交棒

- 證據：`1-branch-1` 與 `1-reflection-1`（vendor 漂移，階段 3 才發現）、`2-branch-2`（嵌入全量重寫）、`5-branch-1`。
- 每階段收尾跑 `node scripts/harness-tests/portable.test.js`。

### 通則 4：量測要先乾跑、寫進度檔、存原始回覆，並先算最壞時間

- 先假生成乾跑（7 秒完成，41 行進度）再真跑。證據：`6-positive-1`。
- 進度寫進結果檔（渲染程序的 `console.log` 不會送到終端機）。證據：`6-positive-1`。
- 結果檔要存原始回覆，否則錯誤型態無法分析。證據：`6-branch-5`。
- 題數 × 逾時 = 最壞時間，寫進風險欄。證據：`3-reflection-1`（階段 3 沒算，階段 6 才發現）。

### 通則 5：何時先問使用者（比現在早一步）

以下情況應在動工前提出，而不是做完才提：

- **範圍擴大**（`inv-branch-1`）：要同步更新待問清單。
- **產品決定**（推理放卡片或泡泡，`5-reflection-1`）：影響顯示位置與之後的重做。
- **樣本縮小**（題數從 20 縮成 8，`6-branch-1`）：要先給估算時間，不要跑到一半才說。
- **規格有歧義**（預算是否共用，`4-branch-5`）：依字面做，並明寫留待決定。

### 通則 6：長時間的量測要能從檔案接續

- 桌面程式重啟與程序殘留都發生過（`7-branch-4`、`6-branch-2`）。結果寫檔、不殺程序、用程序列表確認。

### 通則 7：可以並行的步驟（推測）

- 推測：純函式的開發（階段 1、2、4）與盤點文件可以並行，因為它們的檔案互不重疊；但 `recipe_core.js` 是共用檔，寫的人只能有一個。
- 推測：真量測（長時間執行於隔離副本）與下一階段的 UI 寫作可以並行，因為量測只讀隔離副本，不碰工作目錄。這在階段 6 與 7 之間沒有真的並行過（階段 6 結束後管理層才開階段 7），所以只是推測。
- 推測：`vendor` 同步與建置檔重建應該放在最後一步，由發布階段統一做，不要在每階段各做一次。

### 通則 8：提交前逐句對照數字與結果檔

- 證據：`6-branch-6`（記錄中有超出量測範圍的句子）。

### 通則 9（推測）：逾時問題先查計時器機制，不要先調數字

- 證據：`7-positive-1`（找到閒置卸載計時器）。階段 6 的 60 秒沒有生效，如果階段 2 就查計時器，可以提早發現。這一點是推測，因為階段 2 沒有實測。

---

## 4. 待辦建議（給管理層決定；本次沒有改 `harness.js`）

1. **新增讀取子指令**：`node scripts/harness.js paths --task 關鍵字`，依 `task` 與 `kind` 篩出 `path-experiences.json` 的記錄。需要管理層決定是否做。
2. **不要讓 `learn` 寫入路線經驗**：現有 `learn` 只收程式驗證為 ok 的封閉題；路線經驗是人工整理與階段結束時寫入的，兩者混在一起會讓經驗的意義不清楚。
3. **前置檢查腳本**：一支小腳本，在開工前列出來源與建置檔的行數、評估會載入的標記字串是否存在、顯示卡是否支援 `shader-f16`。對應通則 1。
4. **量測腳本預設存原始回覆**：對應 `6-branch-5`。
5. **可攜測試在每階段收尾時跑**：現有 `portable.test.js` 已經能抓到漂移，問題是階段 1 不會主動跑。對應通則 3。

---

## 5. 沒查的事項與限制

- 沒有逐則核對工作階段全文，只讀了 `list_events` 的節錄（每個工作階段 60 至 120 則）。分支的細節以設計文件的記錄為主。
- 沒有重跑真評估（`colu_think_plan`、`colu_think_reflect`、`colu_think_ui`、`colu_think_timeout`）；這些只來自記錄。
- 沒有確認 `floating-assistant.js` 各處行號（來源與建置檔的對照只看到矛盾，沒有逐行查證）。
- 沒有查證 16:01 到 18:04 的空檔原因，只能推測。
- 沒有查證 6 階段真量測的 60 秒上限為什麼沒有生效之外的其他原因；低檔的 4 秒寬限是否也會中途殺掉工作者，記錄中標為推測，本次沒有量測。
- 「沒有使用的 60 秒上限」與「閒置卸載」的關係，只由程式碼推得（階段 7 記錄第 229 行），沒有在量測時的環境檔位上驗證。

---

## 6. 核對表（本次重跑的指令）

| 指令 | 結果 |
|---|---|
| `node renderer/src/recipe/recipe_core.test.js` | 89 passed, 0 failed |
| `node renderer/src/recipe/plan_core.test.js` | 57 passed, 0 failed |
| `node renderer/src/recipe/skill_compile_core.test.js` | 48 passed, 0 failed |
| `node renderer/src/recipe/think_plan.test.js` | 49 passed, 0 failed |
| `node renderer/src/recipe/think_reflect.test.js` | 24 passed, 0 failed |
| `node renderer/src/recipe/colu_think_ui.test.js` | 20 passed, 0 failed |
| `node renderer/src/recipe/colu_think_timeout.test.js` | 19 passed, 0 failed |
| `node renderer/src/uml/plan_think.test.js` | 25 passed, 0 failed |
| `node scripts/harness-tests/portable.test.js` | 11 passed, 0 failed |
| `git ls-files --eol DESIGN.TODO.colu-thinking.md skills/weak-model-harness/SKILL.md` | i/lf w/lf |

JSON 驗證與記錄數見提交時的檢查（40 筆，每筆 `evidence` 非空；階段 1 至 7 與調查每階段至少 1 筆正路、1 筆反思；有碰壁的階段至少 1 筆分支）。

---

## 7. 教訓（給寫這份文件的自己）

- 第一輪寫入 JSON 時，`1-branch-1` 寫成「階段 4 才同步」，但同步其實是 `a3c16797`（18:35，由另一個工作階段提交）。寫完才對照 git log 更正。之後的路線經驗，每條時間與提交號都要先對 git log。
- 提交時間只能看跨度（見第 0 節），把它當成耗時估計是錯的。

## 8. 速度反模式（2026-11-05 補，給 Haiku 與老師看）

使用者原話：「為什麼那白癡全語音live會有這種故意減速的」「Haiku從頭到尾都在用最慢的方式做事」。下列每條都附來源。來源欄寫的是逐字稿檔名前八碼（位於 `C:\Users\sunneo\.claude\projects\D--Downloads-videos-----desktop-app\`）、提交 hash 或工作樹檔名。**證據強度**分三級：「逐字稿或提交直接看到」、「工作樹檔案直接看到（未提交）」、「管理層回報，未核實」。

| # | 反模式 | 證據 | 證據強度 |
|---|---|---|---|
| S1 | 設長間隔排程等待（20 分鐘） | 逐字稿 `297b791e`：ScheduleWakeup 的 `delaySeconds` 出現 1200 兩次，原因寫「waiting for CMN-off measurement run to finish」，等的是背景量測；同一逐字稿 Haiku 紀錄 619 則。 | 逐字稿直接看到 |
| S2 | 把量測丟背景後空等，用佔位 Monitor 拖時間 | 逐字稿 `2f414373`（Haiku 915 則）：Monitor 以「Idle placeholder」佔位出現 10 次；同一檔的程式碼寫「安裝逾時（20 分鐘）」。 | 逐字稿直接看到 |
| S3 | 子程序等待 25 分鐘且無逐步輸出（安裝模擬卡住才被催） | `scripts/eval/native_old_layout_install.js:62`：`spawnSync(..., timeout: 1500000)`，沒有逐步進度輸出；檔案為工作樹未提交（`??`）。管理層回報「卡 13 分鐘才被使用者催促」，該時長未由逐字稿核實。 | 工作樹檔案直接看到；卡住時長未核實 |
| S4 | 每改一點就跑完整核心測試 | 提交 `ec52493a`（00:30）寫「核心測試 178／180」；`test-reports/core-tests-latest.json` 與 `.md` 在工作樹中被反覆改寫（`git status` 顯示 M）。確切次數未核實。 | 提交與工作樹直接看到；次數未核實 |
| S5 | 小事也開真 Electron 評估 | 提交 `5d051cd5`（00:46）與 `ccc5866a`（00:06）各自都是真 Electron 評估，分別只驗一個安裝步驟與一個舊版套用。 | 提交直接看到 |
| S6 | 不先乾跑就跑真量測（兩次真量測，中間沒有乾跑紀錄） | 提交 `233005ef`（22:22）寫「原生 onnxruntime-node CPU 真量測；WASM 對照與正確率未做」，`c4478add`（22:57）才補對照；提交中找不到乾跑的紀錄。 | 提交直接看到；「沒有乾跑」是從提交紀錄推斷 |
| S7 | 獨立步驟沒有並行，一個接一個等 | 同一小時內 `dea57733`（01:06）、`6d226ecd`（01:06）、`b35e9859`（01:13）序列完成；這些步驟互不依賴。 | 推測（提交時序，未核實並行可行性） |
| S8 | 不到上下文的 30% 就提早結束一輪，造成多輪往返 | 交接提交 `a22c34c3`（00:02）與 `107d4a89`（00:10），相隔 8 分鐘；兩次交接都在同一個任務線內。上下文百分比未核實。 | 提交直接看到；上下文百分比未核實 |

**通則（由上表歸納）**：

1. 等待一律用「短間隔＋逐步進度」，不用長間隔排程（S1、S2）。
2. 任何逾時都要有上限，且不超過 5 分鐘（S3）。
3. 測試分兩層：開發中跑相關測試，提交前才跑一次完整核心測試（S4）。
4. 真評估前先乾跑 10 秒內（S5、S6）。
5. 互不依賴的步驟並行（S7）。
6. 一輪內做完整個階段（S8）。

這些條款寫成 `references/consensus/speed-rules.json`，並由 `teacher_gate.js verify` 掃描報告與提交中的超限數字（警告，不影響通過與否）。

---

## 原檔：project-index-html

<!-- 從 TODO.md 拆出（2026-10-23）：內容原封不動，只是改成一份一個主題。 -->

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

## 原檔：read-ledger

# 讀取帳本（read ledger）：分頁讀取沒讀完就下結論

> 接手者先看這裡：本文件記錄「分頁讀取工具只靠說明文字叫模型繼續讀、工具迴圈沒有強制」的修法。
> 目前狀態：步驟 1（定位迴圈）完成；步驟 2 之後尚未做。

## 總覽

使用者原話（2026-11-04）：
「redmine那邊發生上傳log 結果read attachment自己沒讀完就回應 比方說使用者說查一下裡面有什麼錯誤，結果他回應說報告都是正確的 原因是沒有讀取完畢，所以請根據這個修正設計去處理，看我們有沒有類似問題」

Redmine 端的修正設計：工具迴圈每次工具回傳 `has_more: true` 就記下那次讀取；最後一頁（沒有 has_more）就清掉。

桌面版有類似風險：多個分頁讀取工具回傳 `has_more`／`next_offset`（蛇形）、`chunk.hasMore`／`chunk.nextOffset`（技能包參考檔，駝峰）或 `truncated:true`，但迴圈不擋最終回答。

## 步驟 1 的發現（定位）

檔案：`desktop-app/renderer/src/floating-assistant.js`（壓縮過的長檔，不要整檔讀）

### 主聊天迴圈（原生 tool_calls 路徑）

- `_loopFetch` 第 102581 行：串流路徑入口，有工具時轉交 `_loopFetchNative`（102590）。
- `_loopFetchNative` 第 103176 行起：
  - 第 103284 行：從 API 回應取出 `message.tool_calls`。
  - 第 103388 行：`_pushAssistantMessage` 把這一輪的 assistant 訊息放進對話。
  - 第 103390 行：`if (!toolCalls.length)` 就是「接受最終回答」的地方。目前在這裡只有兩道退回檢查：`_fakeWriteNudge`（宣稱寫入但沒有成功的寫入工具）與 `_claimPathCheck`（宣稱建檔但磁碟上沒有），各最多 2 次。**沒有讀取帳本檢查。**
  - 第 103431–103448 行：逐一執行工具，結果用 `_pushToolResultMessage(fnName, result, { tool_call_id })` 放回對話。
  - 第 103450 行：有工具呼叫時遞迴 `_loopFetchNative(..., 1, ...)`。
- 退回樣板可參考：第 103391–103397 行（`nudge` 以 `role:'system'` 塞回 `this.messages` 後再呼叫 `_loopFetchNative`）。

### 離線小模型路徑（FaVlm）

- `runAgentLoop` 第 7563 行（函式內 `opts.messages` 等，約 7563–7613）。
- 工具結果放回：第 7602 行 `messages.push({ role: 'tool', name, content })`。
- 最終回答：第 7589 行 `if (!pc.calls.length || !useTools.length) return finishFrom(...)`。
- 呼叫端：第 99686、99695、99701 行（`FaVlm.runAgentLoop`）。
- 強制收尾提示：第 7607 行（「請根據上面的資訊直接回答我的問題，不要再呼叫工具。」）。

### 子工作委派（subagent）迴圈

- `_delegateToSubagentDomain` 第 103670 行、`_delegateToSubagentDomainInner` 第 103674 行、`_delegateToSubagentAuto` 第 104319 行、`_delegateToSubagentAutoOnce` 第 104326 行。
- 另有一段 `toolCalls` 處理在第 104945–105043 行附近，與主迴圈不是同一段程式碼。**步驟 3 依指示：不是同一套就只記位置，不改。**

## 總體計畫（四步）

1. 定位迴圈並寫入本文件（完成）。
2. 寫純函式模組 `renderer/src/agent/read_ledger.js` 與 `read_ledger.test.js`，node 測試全過。
3. 把帳本接進主迴圈（第 103390 行的最終回答閘門），每來源最多提醒 3 次，之後放行並加固定警語。重建嵌入與網頁版 EXCLUDE。
4. 真桌面版評估 `scripts/eval/read_ledger.eval.js`：修前失敗、修後被擋、固執放行。

## 待辦

- [ ] 步驟 2：`renderer/src/agent/read_ledger.js`＋測試
- [ ] 步驟 3：接進 `_loopFetchNative`（第 103390 行附近），決定是否也接 `_loopFetch` 串流路徑（需要先確認串流路徑的最終回答判斷位置，約第 103077–103137 行的工具分支）
- [ ] 步驟 3：`runAgentLoop`（離線路徑）是否也要接，待決定（它的 `tools` 與 `handoff` 結構不同）
- [ ] 步驟 4：真桌面版評估

## 步驟 2 完成

- `renderer/src/agent/read_ledger.js`（UMD，同 gui_bridge.js 寫法）與 `read_ledger.test.js`，`node renderer/src/agent/read_ledger.test.js` 11 項全過。commit 7a8dd03a。
- 純函式：`record` 回傳新帳本（不改傳入值）；`ok:false` 不改；駝峰與蛇形都認；只有 truncated 沒有續讀參數的列為 `blocking:false`（只提醒、不阻擋最終回答）。

## 步驟 3 接線（進行中）

- 嵌入：`scripts/embed-code-ui.js` 登記 `READLEDGER-BEGIN/END` → 常數 `FA_READ_LEDGER_SRC`；`renderer/src/floating-assistant.js` 內 `/* READLEDGER-BEGIN */`、`/* READLEDGER-END */` 標記在 `GUIPYWORKER-END` 之後。
- 載入：`_faReadLedgerMod()`（同 `_faGuiModule` 的 new Function 做法）。
- 記錄：`_noteReadLedger(fnName, rawArgs, result)`，在原生迴圈 `_loopFetchNative` 工具執行後、`_pushToolResultMessage` 之前呼叫。
- 閘門：`_readLedgerGate()`，在 `_loopFetchNative` 的「沒有 tool_calls」分支（`if (!toolCalls.length)`，在 `_pushAssistantMessage(finalContent…)` 之前）。有 blocking 且該來源提醒未滿 3 次就 `messages.push({role:'system'})` 後重跑；提醒用完就在 `finalContent` 前加警語放行；放行後帳本與提醒次數歸零。
- 建置：`scripts/build-web-lazy.js` 的 EXCLUDE 加入 `READLEDGER`（核心迴圈一開始就要用，不能拆成延遲載入區塊；不加的話會產生 `web-lazy/chunks/readledger.js`）。

## 還沒做（步驟 3 的缺口）

- 串流路徑 `_loopFetch`（文字式工具呼叫，例如 `[CALL:...]` 的模型）沒有接帳本，只接了原生路徑。這條路徑的工具結果在第 103048 行附近（`task.fnName`）。需要另外評估。
- 離線小模型路徑 `runAgentLoop`（`renderer/src/floating-assistant.js` 第 7563 行）沒有接，依指示只記位置。
- 工具執行出錯（catch 分支）不記帳本，也不影響帳本。
- 帳本只在「放行的最終回答」時歸零；如果這一輪因錯誤或停止而中斷，帳本會殘留到下一輪（待評估）。

## 步驟 5 結果（新訊息入口與中止收尾歸零）

- 歸零位置：`executeChat` 入口（與 `_writeEvidence` 同一處，約 102424 行）；原生迴圈的中止分支（AbortError）與失敗收尾（錯誤紀錄前）。提交 d3739203。
- 評估 D（新訊息入口）、E（中止收尾）：修前（用 setter 忽略歸零來模擬）第二輪被提醒三次並帶警語；修後提醒 0 次、無警語。
- 誠實註記：修前是模擬（setter），不是拿舊 commit 重跑。

## 步驟 6 結果（串流文字式路徑與離線迴圈）

- 串流文字式路徑：`_loopFetch` 的純文字回答分支（`else`，約 103130 行）。工具結果在 `_noteReadLedger(task.fnName, JSON.stringify(parsedArgs), result)`（約 103090 行）。評估 F：修前只讀第一頁；修後讀完三頁、無警語。
- 離線 `runAgentLoop`：來源在 `renderer/src/vlm/vlm_core.js`（不是 floating-assistant 的 VLM 區塊直接改）。接受點在 `pc.calls` 為空的回答，handoff 之前。評估 G：修前只讀第一頁；修後讀完三頁、兩次提醒、無警語。
- 離線路徑的 `opts.readLedger === false` 只給評估當修前對照，正式路徑不傳。
- 提交 9f07a267。

## 步驟 7：分頁工具表（會回傳 has_more／hasMore／truncated 的地方）

圖例：已驗證＝讀過來源與參數；未驗證＝只確認回傳格式，參數名稱沒有逐一確認。

| 工具／來源 | 位置（floating-assistant.js，除非註明） | 回傳格式 | 帳本是否涵蓋 | 依據與備註 |
|---|---|---|---|---|
| `parse_uploaded_file`（上傳附件、log） | 60701 起；分頁走 `_pageText` 64555 | `has_more`／`next_offset`（頂層） | 涵蓋（已驗證） | 參數 `file_id`（60716）是來源身分。評估 H 用真的 `_pageText` 驗證：修前只讀一頁，修後讀完四頁。 |
| `coding_read_file` | 60070–60077（參數）；實作 72586–72610 | `has_more`、`next_start_line` | 涵蓋（已驗證參數） | 來源身分 `cwd_abs`＋`path`（ledger 的 `cwd_abs|path`）。`start_line` 不是來源身分，會被排除。 |
| `browser_get_page_text`（瀏覽器分頁） | 60598 起；回傳 66451 | `has_more`（字串提示） | 部分涵蓋（未驗證） | 參數是 `tab_id`，不在來源欄位清單內；後備鍵用其餘參數，所以同一個分頁可以涵蓋，但沒有 `tab_id` 時所有分頁共用 `args={}`。待確認。 |
| `fap_read_file`（File Access Point 檔案） | 讀檔 `_fapReadFile` 約 64560 起；回傳 64580–64604 | `has_more`、`next_offset`、`truncated` | 未驗證 | 參數名稱（預期 `ref`／`path`）還沒有逐一確認。若是 `path`／`ref` 就會涵蓋。 |
| `article_section`（長文章章節） | `renderer/src/tools/article_outline.js` 136 行（`sectionText`） | `has_more`、`next_offset` | 未驗證 | 工具參數（預期 `file_id`）還沒確認。 |
| 技能包參考檔讀取（`chunk.hasMore`／`chunk.nextOffset`，駝峰） | 58319–58324（工具名稱函式 `_syncSkillBundleDomains` 附近） | `chunk: {hasMore, nextOffset}` | 未驗證（格式已涵蓋） | 解析器認駝峰格式（已有 node 測試）。來源身分要看參數是否含 bundle 與檔名，還沒確認。 |
| 文章大綱內部分頁迴圈 | 61476–61477 | 迴圈內讀 `has_more` | 不需涵蓋 | 程式內自己讀到底，不把中間結果交給模型。 |
| 目錄內部分頁迴圈（fap 清單） | 68458–68459 | 迴圈內讀 `has_more` | 不需涵蓋 | 同上，程式內讀完。 |
| 清單輸出截斷（`out.has_more`／`next_offset`） | 71064、71177、71512、71716 | `has_more`、`next_offset` | 未驗證 | 這些是清單輸出的預算截斷，所屬工具沒有逐一確認。 |
| PDF 頁文字 | 94450 附近 | `has_more` | 未驗證 | 所屬工具沒有確認。 |

重點：使用者回報的情境（上傳 log 後讀附件沒讀完）已由評估 H 驗證涵蓋。其他未驗證的項目要在後續逐一確認，不能當成已涵蓋。

## 步驟 7 之後的待辦

- [ ] 逐一確認表中「未驗證」的工具參數，並補上對應評估（尤其 `fap_read_file`、`article_section`、技能包參考檔）。
- [ ] 警語來源顯示 `args={}` 的問題（沒有來源欄位的工具）。

## 陷阱

- 不要用 `grep` 直接搜 `renderer/src/floating-assistant.js` 的嵌入常數名（例如 `FA_GUI_BRIDGE_SRC`）：會把整段壓縮字串印出來，吃掉大量上下文。要加 `-l`，或只用 `cut -c1-160` 截斷。
- 嵌入常數 `FA_*_SRC` 的字串是一整行，`Read` 那一段也會很長。

- `floating-assistant.js` 是十萬行壓縮檔，不要整檔讀，只用 Grep 加小範圍 Read。
- 不要提交 `renderer/floating-assistant*.js`、`update-manifest.json`、`web-lazy/*`、`test-reports/*`。
- 驗證「載入的是工作目錄」時，不能用壓縮後的變數名，要用字串常值或行為。

## 步驟 4 結果（真桌面版評估）

評估檔：`scripts/eval/read_ledger.eval.js`，執行：`node scripts/eval/run_eval.js scripts/eval/read_ledger.eval.js 17941`（獨立使用者資料夾、換埠、FA_DISABLE_MAIN_OVERLAY=1；輸出存在 scratchpad）。

- 真 Electron 驗證過：載入的是工作目錄的實作（閘門方法的字串常值「只讀了一部分」、嵌入模組的 `reminderText`／`record` 都在）。
- A 修前（閘門換成 null，等同舊行為；這是模擬，不是拿舊 commit 重跑）：只呼叫一次工具（offset 0）就被接受，最終回答「報告都正確，沒有錯誤。」。重現使用者的 bug。
- B 修後、順從的模型：呼叫 offset 0、1、2 讀完三頁；被擋兩次、提醒兩次；最終回答沒有警語。
- C 修後、固執的模型：只讀第一頁，三次提醒後放行；最終回答前面有固定警語「注意：以下來源只讀了一部分，結論可能不完整：…」。
- 只跑 node 的：`read_ledger.test.js` 12 項全過。
- 沒驗證的：真的線上模型是否聽從提醒（評估用的是假模型）；串流文字式路徑；離線 runAgentLoop。

## 待辦（步驟 4 之後）

- [ ] 串流文字式路徑（`_loopFetch`，`[CALL:...]` 模型）接上帳本。
- [ ] 離線 `runAgentLoop`（第 7563 行）是否接上帳本。
- [ ] 警語的來源顯示：沒有來源欄位的工具，顯示成 `args={}`，應改成工具名稱。
- [ ] 帳本只在放行的最終回答時歸零；中斷的那一輪殘留到下一輪，待評估。
- [ ] 發布前才跑 `node scripts/build-web-lazy.js`（建置產物，留給發布）。

## 教訓

- 2026-11-04：第一版後備來源鍵把 `offset` 算進身分，同一來源每頁的鍵都不同，帳本永遠清不掉，三頁讀完還是被警告。單元測試沒抓到（測試用的工具有 `path`），只有真桌面版評估的情境 B 抓到。下次：來源身分不能包含續讀參數；寫評估時，假工具要刻意沒有來源欄位，測後備路徑。
- 2026-11-04：評估用 `scripts/eval/read_ledger.eval.js` 的假工具有 `offset`，不是 `path`，正好逼出上面的缺陷。
- 2026-11-04：離線 `runAgentLoop` 的改動兩度消失。原因：它位於 `floating-assistant.js` 的 `VLM-BEGIN`～`VLM-END` 區塊，`embed-code-ui.js` 每次重建都用 `renderer/src/vlm/vlm_core.js` 整段覆蓋該區塊。下次：改來源模組（`vlm_core.js`），改完跑 `embed-code-ui.js` 後用 grep 確認改動還在。
- 2026-11-04：編輯工具曾回報「檔案在磁碟上被改過」，同一資料夾可能有別的工作階段在改同一個檔。下次：每次編輯後立刻用 grep 驗證，提交前看 `git diff` 只含自己的改動。
- 2026-11-04：評估 G 第一次失敗，是因為評估寫的工具呼叫格式錯了（用 `[CALL:...]`，離線路徑認的是 `<tool_call>` JSON）。下次：寫假模型前先看對應路徑的 `parseToolCalls` 格式。

---

## 原檔：safe-self-upgrade

<!-- 從 DESIGN.TODO.four-directions.md 拆出（2026-10-25）：四個方向裡只有這一項還沒做。 -->

# 安全自我升級（2026-10-21 使用者提出，尚未開始）

- 知道自己的原始碼位置、讀得懂；替每一段行為建索引；把現有程式反推成 UML design，再從 UML design 產生更新的程式。
- 新版先放進沙盒隔離測試；裝上去後啟動畫面，確認「自升級的部分」沒壞；壞了自己還原（沿用 live-patch 已有的「壞版本標記＋退回安裝包內建版」機制）。
- 邊界：只能改 renderer 那四個可熱更新的檔案；主行程與 preload 的改動不自動套用。

## 熱更新的主行程模組：壞版本不能讓 app 起不來

設計缺口：preload.js 有「壞版本自動標記、退回內建版」的保險（live-patch/preload.bad），主行程模組沒有。main.js 啟動時直接 require("./main-ext.js").register(...)，覆蓋版只有「編譯失敗會退回內建版」；register() 執行時丟例外會讓整個 app 起不來，連更新都收不到，而使用者不能重新安裝。

- 覆蓋版主行程模組在啟動階段丟例外：記到 logs/main-ext.log、標記該檔案的壞版本（md5）、本次改用內建版重試，之後同一個 md5 不再採用，等下一個新版本。
- 舊安裝的 main.js 不能改，保險只能放在 main-ext.js 的啟動流程裡替它之後載入的模組把關；main-ext.js 自己壞掉的情況要在新安裝的 main.js 加同樣的保險。

---

## 原檔：subchat-s1

# 子對話 S1（資料模型與側欄樹狀）：定位與決定

> 範圍：只做 `DESIGN.TODO.chat-subsessions.md` 第 10.2 節的 S1。S2–S6 不做。
> 行號以現在的原始碼為準（2026-11-04 核對）。主檔＝`renderer/src/floating-assistant.js`（以下簡稱「主檔」），它是編輯來源；`renderer/floating-assistant.js` 是建置產物，不要改。
> 「找不到」的項目明說，不猜。

---

## 1. 步驟 1：定位（每項附行號）

### 1.1 對話索引結構

| 項目 | 位置 | 內容 |
|---|---|---|
| 索引讀取與預設值 | `_chatListInit` 主檔 79555–79595 | 索引 `{ version, currentId, sidebarCollapsed, groups, chats }`（79560）；讀不到或格式錯就重建（79559–79575） |
| 索引欄位（建立時） | 79570、79577 | `{ id, title, groupId, createdAt, updatedAt }` |
| 其他已存在的索引欄位 | `touched`：79609、79699 附近；`shared`／`remote`：`rg_dispatch.js` 581（嵌入副本在主檔 53473 附近） | `remote = { fromName, fromId, taskId, at, fp }` |
| 沒有的欄位 | 全專案 | 沒有 `parentId`、`status`、`topicId`、`fingerprint`、`summary`、`nodeName`。`grep parentId` 等只命中無關程式 |
| 索引存檔 | `_saveChatIndex` 主檔 79488–79491 | `JSON.stringify(this._chatIndex)` 寫入 `_chatBackend().writeIndex` |
| 單筆查找 | `_chatEntry(id)` 主檔 79493 | `this._chatIndex.chats.find` |
| 後端 | `_chatBackend()` 主檔 79411 起（結尾未核對） | 有 `window.desktopAPI.chats` 用檔案；否則 `FileCache`（設計文件原寫 79409–79431，已偏移 2 行） |
| 新 id | `_chatNewId(prefix)` 主檔 79435 | `${prefix}_${時間36進位}${隨機}` |

### 1.2 建立對話 `_chatNew`

- 定義：主檔 79681–79709，簽章 `async _chatNew(groupId = null)`。
- 「空對話不重複建立」規則：79683–79693。
- 推入索引：79699 `this._chatIndex.chats.push({ id, title: '新對話', groupId, createdAt: now, updatedAt: now })`。
- 之後：`_chatCtxNew(id)` 79702、`_chatActivate` 79704、`_saveChatIndex` 79706。
- S1 要加的選用參數 `{ parentId, nodeName }`：加在這個函式（預設不傳時行為不變）。

### 1.3 刪除對話 `_chatDelete`

- 定義：主檔 79711–79743。
- 過濾掉目標：79723 `this._chatIndex.chats = this._chatIndex.chats.filter((c) => c.id !== id)`。
- 刪除檔案：79726。
- 沒有任何子對話相關的處理（S1 要加：子對話提升為根，見第 5 節）。

### 1.4 重新命名對話

- `_chatRename(id, title)`：主檔 79745–79752，改 `entry.title` 後呼叫 `_renderChatList` 與 `_saveChatIndex`。
- 側欄「更多」選單的入口：`cl-more` 在 79863、79992–80025 附近（只確認到 `_chatRename` 被呼叫於 79974、80025）。

### 1.5 側欄列項目渲染

- 清單渲染入口 `_renderChatList()` 主檔 79835–79881。
- 列項目 `chatEl(c, nested)`：79846 起，`cl-item`、`nested` class 已存在（79848）。
- 標題 `cl-title`：79859。遠端對話前綴 `🌐 `、分享前綴 `📡 `（79859）。
- 依建立時間排序（新在上）：79867 `byTime`。
- 群組分支：79868–79879；無群組的根對話：79880。
- 簽章快取（沒變就不重畫）：`st` 79840、`sig` 79841 附近。S1 的樹狀要把「父子結構、展開狀態」也放進 `sig`，否則收合不會重畫。

### 1.6 節點名稱（遠端）

- 本機節點名稱：`this._rgSettings().machineName`（`renderer/src/remote/rg_host.js:21` 預設值；`rg_host.js:170` 連線後 `_rgSaveSettings({ machineName: room.self.name })`；設定 UI `rg_host.js:719–722`）。
- 預設值形式：`(window.desktopAPI ? '桌面' : '網頁') + '-' + 4 位數隨機`（`rg_host.js:21`）。
- 遠端來源名稱：`job.fromName`（`rg_dispatch.js:575–581`）。
- 嵌入副本：主檔 `_rgCreateRemoteChat` 約 53461–53473；`rg_host.js` 的名稱在主檔對應位置也有副本（主檔 53769 附近是 `nodeName` 的 SVG DOM 用法，與遠端無關，**不是**節點名稱）。

### 1.7 遠端需求建立對話的位置（**設計文件原寫的 822 有誤**）

- **建立**：`renderer/src/remote/rg_dispatch.js:575–588` `_rgCreateRemoteChat(job)`；`rg_dispatch.js:580–581` 推入索引，帶 `shared:true`、`touched:true`、`remote:{fromName, fromId, taskId, at, fp}`。
- 呼叫點：`rg_dispatch.js:532`。
- **822 不是建立**：`rg_dispatch.js:822` 是把遠端訊息丟進已存在對話的 `executeChat('[來自 ' + who + ' 的遠端訊息]…')`。
- 主檔嵌入副本：建立在主檔 53461；呼叫在主檔 53418。

### 1.8 嵌入與建置

- 嵌入腳本：`scripts/embed-code-ui.js`（嵌入範本與純函式）。其中 `read_ledger.js` 以 `READLEDGER-BEGIN`／`READLEDGER-END` 嵌入（`scripts/embed-code-ui.js:65`）。
- 建置：`node build-assistant.js`（產物 `renderer/floating-assistant.js`）。
- 網頁版核心排除清單：`scripts/build-web-lazy.js:16` 的 `EXCLUDE` 集合。`READLEDGER` **在**排除清單內（第 28 項，已核對）。網頁版嵌入的助理沒有對話清單（見 `rg_dispatch.js:577` 註解），所以 `chat_tree` 也不需要在網頁版核心裡，步驟 4 時比照 `READLEDGER` 加入 `EXCLUDE`（決定，理由同此）。

### 1.9 找不到的項目

- 「刪除父對話時連帶處理子對話」：目前沒有子對話，所以沒有相關程式（第 5 節決定）。
- 「對話名稱的 `@` 解析」：沒有既有實作，全新寫。
- `FileCache` 是否底層為 IndexedDB：沒查（不影響 S1）。

---

## 2. 決定（S1 內）

- **同層排序**（步驟 2）：根依建立時間新到舊（與現在側欄一致，回歸不變）；子對話依建立時間舊到新（第一個子對話在最上面，符合對話先後）。
- **子對話數**（步驟 2）：`childCount` 只算直接子對話；收合時也顯示。
- **環與孤兒**（步驟 2）：parentId 指向不存在的對話、自己指自己、互指，都視為根；環上每一筆都當根，掛在環上的其他對話成為它的子對話。理由：側欄絕不能因為壞資料而消失或無限迴圈。
- **`@` 格式**（步驟 3）：本機 `@對話名`；遠端 `@節點名/對話名`；名稱含空白、方括號時用 `@[…]`。**不用引號**（中文輸入常把引號換成全形）。理由：使用者只需要記一種括號。
- **遠端省略節點名**（步驟 3）：只寫對話名、而且只有遠端對話符合時，回傳 `needNode`，不替使用者猜。理由：使用者明確說「標記對話名稱時，要包含節點名稱」。
- **同名**（步驟 3）：完整名稱重複時回傳 `ambiguous` 與候選清單，不自動挑。
- **對話名含 "/"**（步驟 3）：比對拿整段字串跟「節點名/對話名」全文比，不切字串，所以名稱中的 "/" 不會誤判。
- **比對規則**（步驟 3）：忽略大小寫與前後空白；名稱內部空白不合併。
- **刪父對話**（見第 5 節）：子對話提升為根，不連帶刪除。
- **展開狀態**（見第 6 節）：存在索引的 `expanded`；沒有記錄就是收合。
- **模組位置**（步驟 2–3）：全部放在 `renderer/src/chat/chat_tree.js`，一個檔，UMD 寫法（同 `read_ledger.js`），測試在 `chat_tree.test.js`（22 項）。
- **側欄展開鈕**（步驟 5）：父對話前面一個 ▸／▾，後面顯示子對話數；點鈕只切換展開，不切換對話（事件處理先判斷 `.cl-tree-toggle`）。理由：使用者點父對話列是要看內容，點鈕是要收合。
- **明確收合優先**（步驟 5）：`expanded[id] === false` 不會被「目前對話在它底下」自動展開；只有從沒設定過（undefined）的父對話才會為了顯示目前對話而展開。理由：避免使用者收合後怎麼按都收不起來。
- **群組跟父對話走**（步驟 5）：子對話顯示在它的根對話所在的群組，不看子對話自己的 `groupId`。理由：避免同一棵樹被拆到不同群組。群組標題的計數只算根對話。
- **回歸的定義**（步驟 5）：沒有任何子對話時，列表沒有 `.cl-tree-toggle`、`.cl-child`、`.cl-children-count`，列項目 class 名稱與以前相同，順序相同（新到舊）。**沒有與修前的 DOM 逐字比對**（沒有修前的執行環境），這點是結構檢查，不是位元比對。

## 3a. 步驟 5 驗證結果（真桌面版）

- `scripts/eval/chat_tree.eval.js`（換埠 17952）：預設收合（P＝▸ 2）、點展開不切換對話、展開後縮排正確（C1、C2 在 P 底下，G 在 C2 底下縮排 2）、收合整棵子樹、明確收合不被自動展開、未設定時目前對話路徑自動展開、群組計數與成員正確、刪父後 C1／C2 提升為根且 G 仍在 C2 底下、展開狀態寫回後端、沒有子對話時沒有樹狀元件。全部 `true`。
- 步驟 4 的 `chat_tree_index.eval.js` 在步驟 5 改動後重跑，仍全部通過。
- 只有 node 測試：`chat_tree.test.js`（22 項）、`scripts/remote-tests/rg_methods.test.js`（102 項）。
- **沒驗證**：修前與修後的 DOM 逐字比對；真的遠端群組來的對話在側欄的顯示（`nodeName` 寫入有驗證，側欄遠端列的顯示沒有）；網頁版（沒有對話清單，不在範圍）。

## 4a. 教訓（這次走過的錯）

- 設計文件寫遠端建立對話在 `rg_dispatch.js:822`，實際是 575（822 是遠端訊息轉進既有對話）。下次：設計文件的行號先 grep 確認，不要照抄。
- 讀 `build-web-lazy.js` 的 `EXCLUDE` 時只看了前 200 字，誤以為 `READLEDGER` 不在清單裡。下次：列舉清單要用 `tr ',' '\n' | grep` 看完整項目。
- 步驟 4 的評估第一次失敗（`existing_fields_kept` false），原因是既有的 `_touchSig` 邏輯會更新目前對話的 `updatedAt`，與補欄位無關。下次：比對失敗先找出是哪個欄位、再確認是不是既有寫入，不要直接改判準。

## 3. 驗證方式

- 純函式：`node renderer/src/chat/chat_tree.test.js`（步驟 2 起）。
- 真桌面版：`scripts/eval/chat_tree.eval.js`，用 `scripts/eval/run_eval.js` 啟動真 Electron（步驟 5）。
- **步驟 4 已驗證（真桌面版）**：`scripts/eval/chat_tree_index.eval.js`（換埠 17951、全新資料夾）。結果：載入來源為工作目錄的 `renderer/floating-assistant.js`；舊索引載入後 6 個新欄位全為 null；舊欄位不變（`updatedAt` 除外）；補齊後寫回後端，重讀仍正確；`_chatNew()` 不傳選項時不帶 `parentId`／`nodeName`；`_chatNew(null,{parentId,nodeName})` 寫入兩者。
- **步驟 4 未驗證**：遠端需求建立對話寫入 `nodeName`（`rg_dispatch.js` `_rgCreateRemoteChat`）只有讀程式與 `rg_methods.test.js`（102 項，全過）；沒有真的跑遠端群組。
- 步驟 4 的 `updatedAt` 說明：目前對話在載入時 `updatedAt` 會被既有邏輯更新（`floating-assistant.js` 約 79543，`_touchSig`），與補欄位無關，評估檔已排除此欄位比對。

## 4. 教訓

（工作途中若走歪，在這裡新增一條：錯在哪、下次怎麼做。）

## 5. 刪除父對話的處理（決定）

- 決定：**子對話提升為根**（把子對話的 `parentId` 設為 `null`），不連帶刪除。
- 理由：子對話可能有使用者要保留的內容；連帶刪除會讓「刪一個父對話」變成大範圍不可逆的刪除。使用者在第 10 節沒有要求連帶刪除。
- 實作位置：`_chatDelete`（主檔 79723 附近）在過濾之後，把 `parentId === id` 的項目改成 `null`。
- 驗證：步驟 5 的真桌面版評估檔刪父對話後，子對話出現在根層。

## 6. 展開狀態（決定）

- 決定：存在索引的 `expanded`（物件 `{ [chatId]: boolean }`），不放 localStorage。
- 理由：索引已經是這個對話清單的唯一真實來源，與 `sidebarCollapsed`、`groups[].collapsed` 放在一起最一致；localStorage 在清單模式下不會跟著索引搬移。
- 預設：沒有記錄的父對話視為**收合**（符合「預設收在父對話底下」）。

---

## 原檔：subchat-s2

# 子對話 S2（本地快速話題偵測）：現況定位與決定

> 範圍：只做 `DESIGN.TODO.chat-subsessions.md` 第 10.2 節的 S2。S3–S7 不做。
> 行號以現在的主檔為準（2026-11-04 核對）。主檔＝`renderer/src/floating-assistant.js`，是編輯來源；`renderer/floating-assistant.js` 是建置產物，不要改。

## 步驟 1：現有 `_checkTopicTransition` 的定位（每項附行號）

### 1.1 輸入

| 項目 | 位置 | 內容 |
|---|---|---|
| 函式定義 | 主檔 95923 | `async _checkTopicTransition(newUserPrompt)` |
| 吃的輸入 | 95925、95932、95944–95945 | 讀 `this.messages`（非 system 的最後 6 則，95932）、`this.topicData.currentTopic`（95944）、本次 `newUserPrompt`（95945）。另外用 `_getApiConfig()`（95924）取 apiKey／apiUrl／apiModel |
| 呼叫點 | 主檔 102601 | `if (this.advancedSettings.topicShiftCheck === true) await this._checkTopicTransition(userText);`，位於 `executeChat` 內，`this.stopRequested` 檢查（102602）之前。這是阻塞送出的那一步 |

### 1.2 回傳與判斷

| 項目 | 位置 | 內容 |
|---|---|---|
| 訊息少於 3 則的提早返回 | 95925–95928 | 直接把 `currentTopic` 設成 `newUserPrompt`，不呼叫模型，`return`（無回傳值） |
| 模型呼叫 | 95963–95977 | `FaLlm.fetch` 送 `chat/completions`，`temperature: 0.1`，非串流 |
| 解析 | 95979–95986 | `!response.ok` 直接 return；取 `choices[0].message.content`，用 `/\{[\s\S]*\}/` 抓 JSON |
| 判斷欄位 | 95988 | `result.isShifted === true` 才算轉移；`result.newTopicSummary` 用於新話題名稱（96009 之後、96051） |
| 函式回傳值 | 全函式 | 沒有 `return` 值；結果只透過副作用（`this.messages`、`archivedDisplayBlocks`、`topicData`）寫回 |

### 1.3 轉移時的副作用

| 項目 | 位置 | 內容 |
|---|---|---|
| 再次呼叫模型做摘要 | 96004–96033 | 另一次 `FaLlm.fetch`（96016）產生過渡摘要，`temperature: 0.2`；摘要失敗（`!summaryResponse.ok`）則什麼都不改（96031） |
| 封存舊訊息 | 96041 | `this.archivedDisplayBlocks.push({ reason, messages: fullHistoryWithoutSystem })`，reason 為 `話題轉移：舊主題 → 新主題` |
| 替換 `this.messages` | 96043–96046 | 整批換成兩則 system：最終 system prompt + `[Topic Transition Summary …]` 摘要 |
| 重繪 | 96047 | `this._renderMessageHistory()` |
| 更新主題 | 96051 | `this.topicData.currentTopic = result.newTopicSummary || newUserPrompt`（注意：不轉移時也會執行，因 96051 不在 `if` 內） |

### 1.4 `topicData` 的其他使用處

| 位置 | 用途 |
|---|---|
| 主檔 51009 | `FA_CHAT_CTX_KEYS`：`topicData` 屬於每個對話的 ctx 狀態（多對話隔離用） |
| 主檔 56989–56991 | 初始化 `{ currentTopic: "無（新對話開始）" }` |
| 主檔 79454 | 新 ctx 初始化 `topicData: { currentTopic: '無（新對話開始）' }` |
| 主檔 79560 | 索引讀取後重設為「無（新對話開始）」 |
| 主檔 106655–106663 | 清除對話時重設 `topicData.currentTopic`，註解說明曾造成誤判（既有問題，S2 不動） |
| 主檔 95944、95926、96041、96051 | 上述判斷本身 |

### 1.5 開關

- 預設：主檔 57699 `topicShiftCheck: false`；讀設定 59130 `raw.topicShiftCheck === true`。
- 設定畫面：主檔 105539（checkbox `ai-topic-shift-chk`）、81721（同步勾選）、108458（寫回）。

### 1.6 對 S2 的含意

- 現有判斷是「模型判斷＋模型摘要＋整批替換 `this.messages`」。S2 只換判斷那一段，摘要與替換（96004–96047）不在 S2 範圍內（S3 才接手開子對話）。
- 現有保守規則（95953「判斷有疑慮時一律 isShifted:false」）依使用者決定「不用保留」，S2 的本地偵測偏向判成新話題。
- 現有 `topicData.currentTopic` 會在不轉移時也被更新（96051），S2 要的指紋應另存，不共用這個字串。

## 步驟 2：純函式 `renderer/src/chat/topic_local.js`（commit `a85577c4`）

- `fingerprintOf(text)`：中文取二元組（單字取一元組），英文與數字取小寫單字；虛詞清單 `STOP_CJK_BIGRAMS`、`STOP_EN_WORDS` 不計入。回傳純物件詞頻表。
- `mergeFingerprint(fp, text, max)`：累加後只留次數最多的 `max` 個詞，預設 40。理由：話題核心詞會反覆出現，次數高者留下；40 個詞約容納十來則內容訊息，比對成本可忽略。同次數依字典序，結果確定。
- `similarity(a, b)`：餘弦相似度，0–1。
- `detectShift(current, candidates, text, opts)`：判斷順序見檔頭註解。門檻 `sameThreshold = 0.25`、`matchThreshold = 0.25`，偏向判轉移（使用者決定「誤判寧可多開」）。0.25 是經驗值，由測試案例校準，可由 `opts` 覆寫。
- 太短的判定：去掉句尾標點後不到 2 個字，或在 `TRIVIAL` 清單內（「好」「繼續」「謝謝」等），不判轉移。
- 延續句：`CONTINUATION_RE` 只涵蓋「（再／又／也／還）＋加／多／來／改／換成／換一／同樣／一樣／繼續／接著」開頭，以及英文 also／again／another／more／add／continue 開頭。這是為了讓「再加一隻狗」不被判成新話題。

測試：`node renderer/src/chat/topic_local.test.js` 12 項全過，含使用者案例序列、英文序列、中英混合序列，以及 1000 次判斷總耗時（實測約 10 ms，門檻 50 ms）。

## 步驟 3：接進 `executeChat`（commit `42fc6b68`，補丁 `2604b09b`）

- 主檔新增 `_topicLocalMod()`（比照 `_chatTreeMod`，用 `new Function` 載入嵌入的 `FA_TOPIC_LOCAL_SRC`）與 `_localTopicCheck(userText)`（同步、不 await、不改 `this.messages`）。插在 `_checkTopicTransition` 前面。
- 呼叫點：`executeChat` 內原本的 `await this._checkTopicTransition(userText)` 改為 `this._localTopicCheck(userText)`，仍由 `topicShiftCheck === true` 把關。開關關閉時完全不呼叫。
- 狀態：`this._lastTopicShift = { isShifted, score, matchedTopicId, reason, at }`；`topicData.fingerprint` 是目前話題指紋；`topicData.pastTopics` 是轉出的舊話題（上限 20 筆，S5 比對用）。
- 嵌入：`scripts/embed-code-ui.js` 新增 TOPICLOCAL 區塊；`scripts/build-web-lazy.js` 的 EXCLUDE 加入 `TOPICLOCAL`，與 `CHATTREE` 相同，留在網頁版核心。
- 清除對話（`_clearChatHistory`）也會清掉 `fingerprint` 與 `pastTopics`（補丁 `2604b09b`）。
- 未改：`_checkTopicTransition` 本體保留（S3 決定是否刪）；摘要與整批替換 `this.messages` 的程式碼仍在它裡面，只是不再被呼叫（開關開啟時）。

## 步驟 4：真桌面版評估（`scripts/eval/topic_local.eval.js`）

- 指令：`node scripts/eval/run_eval.js scripts/eval/topic_local.eval.js 17961`，結果寫在 `[eval-file] result`。
- 修後（commit 之後的工作目錄建置）：13 項判準全部通過（`allPass: true`）。每則偵測耗時 0.1–2.8 ms，皆小於 5 ms。開關開啟時，模型呼叫序列只有 `main_chat`；`_lastTopicShift` 依序為 不轉移（`no-current-topic`）／不轉移（`continuation-phrase`）／轉移（`new-topic`）／轉移（`returned-to-earlier-topic`，matchedTopicId 有值）／不轉移（`trivial`）。`this.messages` 沒有摘要、`archivedDisplayBlocks` 沒有新增。
- 修前對照：暫時把建置產物換成步驟 3 之前的備份建置，跑同一個評估，結果不同：開關開啟時每則都有 `topic_check`＋`shift_summary`＋`main_chat` 三次呼叫，`_lastTopicShift` 不存在，判準全數失敗。跑完已還原修後建置（以 `cmp` 確認）。
- 來源檢查：`loadedWorkdirImpl` 用字串常值「判定新話題」檢查工作目錄載入的實作，`loadedBehaviorOk` 用行為檢查。

## 驗證範圍（誠實列出）

- 真桌面版驗證過：送出流程的模型呼叫序列、`_lastTopicShift` 結果序列、偵測耗時、開關關閉時行為不變、修前修後對照。
- 只有 node 測試：`topic_local.js` 的判斷規則（12 項）。
- 既有測試：`chat_tree.test.js` 22 項、`read_ledger.test.js` 12 項通過。
- 沒有驗證：真實使用者訊息上的誤判率沒有量測。門檻與延續句清單只用上述案例校準，遇到真實對話可能要調整。
- 沒有驗證：`topicShiftCheck` 開啟時整個 UI 行為（側欄、畫面）。S2 只改偵測，不改畫面。
- 建置產物（`renderer/floating-assistant*.js`、`update-manifest.json`、`web-lazy/*`、`test-reports/*`）是建置的副產品，沒有提交；原本的建置產物備份在 scratchpad `s2-backup` 目錄下。

## 教訓

1. 新增一個對話狀態（`topicData.fingerprint`、`pastTopics`）時，要同時檢查所有重設點。這次漏了 `_clearChatHistory`，是在步驟 3 之後才補上（補丁 `2604b09b`）。下次新增狀態欄位，先 Grep 該物件的重設處（`topicData`）再寫。
2. 評估檔若依賴新函式（如 `_topicLocalMod`），要先用防呆寫法，否則修前版本會在最後一步拋錯、拿不到對照結果。
3. 主檔是 CRLF 行尾，Edit 工具替換多行時要注意行尾。這次新增的多行片段沒有出問題，但 git 顯示 LF 會轉成 CRLF 的警告。

---

## 原檔：subchat-s3

# 子對話 S3（開出真正的子對話）：定位與決定

> 範圍：只做 `DESIGN.TODO.chat-subsessions.md` 第 10.2 節的 S3。S4–S7 不做（不做狀態冒泡、不做拉回舊話題、不做遠端統一、不做批次刪除）。
> 行號以現在的主檔為準（`renderer/src/floating-assistant.js`，編輯來源；`renderer/floating-assistant.js` 是建置產物，不改）。
> 找不到的項目明說。

## 步驟 1：定位（每項附行號）

### 1.1 `executeChat` 對 `this._activeCtx` 的依賴

- `executeChat` 本體：主檔 102503 起。在它的範圍（102503–約 103400）內，**沒有直接寫 `this._activeCtx`**；唯一出現的是 103203 的註解。
- 它透過 `_chatRunner(ctx)` 拿到的代理物件執行，所以 `this._ctx` 會回傳該對話的 ctx（79479–79497，代理的 `get` 攔截 `_ctx`）。
- 畫面相關函式都先判斷 `this._chatIsVisible()`（79474，等於 `this._ctx === this._activeCtx`）：
  - `_setRespondingState`（94987）：背景時不碰 `#ai-response-indicator`（94989）。
  - `_renderMessageHistory`（106715–106717）：背景時只存檔並打未讀標記，不重畫。
- 直接讀 `_activeCtx` 的地方（不在 executeChat 內，但 executeChat 會經過）：`_chatCtxLoad`（79647–79649，暫時借用）、`_chatCtxPrune`（79657）、`_chatActivate`（79664–79673）。這些是切換對話用的，executeChat 不呼叫它們。
- **風險（未處理，回報用）**：executeChat 內若有人新增 `this.xxx` 且該欄位不在 `FA_CHAT_CTX_KEYS`（51009 起），寫入會落在實例上（＝目前顯示的對話）。這是 S2 已寫明的既有風險，S3 不改清單。
- 代理的 `get` 會把 `executeChat`／`_log` 等 bind 過的函式換回原型版本（79488–79491 附近）。S3 新增的方法必須是原型方法（不要在建構子裡 bind），代理才拿得到正確的 `this`。

### 1.2 `executeChat` 的執行順序（與 S3 有關的行）

| 行 | 內容 |
|---|---|
| 102504–102507 | 已在回應中則 `_addSteeringMessage` 並 return |
| 102556 | `this._setRespondingState(true)`（在話題偵測之前就設為回應中） |
| 102637 | S2 的 `if (this.advancedSettings.topicShiftCheck === true) this._localTopicCheck(userText);` |
| 102638 | `if (this.stopRequested) return;` |
| 102664 | `this.messages.push({ role: "user", content: userText });` |
| 102665 | `this._renderMessageHistory();` |
| 102697 | `finally` 內 `this._setRespondingState(false, '', ...)` |
| 102725 | `_loopFetch`（模型呼叫） |

- 因為 102556 已經把 `isResponding` 設為 true，S3 的分支若在 102638 之後 return，**必須自己呼叫 `this._setRespondingState(false, '', 'completed')`**，否則父對話會卡在回應中。
- 決定：S3 的分支插在 102637 之後、102638 之前。

### 1.3 `_localTopicCheck`（S2 產物）

- 定義：95935；內部寫 `this._lastTopicShift`（95935–95960 之間）與 `topicData.fingerprint`、`topicData.pastTopics`。
- `_lastTopicShift = { isShifted, score, matchedTopicId, reason, at }`。

### 1.4 `_chatRunner` 與 `_chatCtxNew`

- `_chatCtxNew(id)`：79456–79468。新 ctx 欄位包含 `messages`、`topicData: { currentTopic: '無（新對話開始）' }`、`isResponding`、`runner: null` 等。
- `_chatRunner(ctx)`：79479–79497。Proxy；`FA_CHAT_CTX_KEYS`（51009 起）的鍵讀寫落在 ctx；其餘落在實例。`topicData` 在 `FA_CHAT_CTX_KEYS` 內（51012 起）。
- `_chatCtxPrune`（79655–79661）：背景且沒在跑、沒未讀、沒等待的 ctx 會從 `_chatCtxs` 移除（內容已存檔）。子對話 ctx 跑完後會被這樣移除，之後由 `_chatCtxLoad`（79639）重讀，所以 S3 不需要額外保留記憶體。

### 1.5 建立對話 `_chatNew`（S1 已擴充）

- 定義：79702。簽章 `_chatNew(groupId = null, opts = null)`。
- `opts.parentId` → `forChild`（79705）：跳過「空對話不重複建立」（79711 起）。
- 寫入索引：建立 `entry` 在 79721，`parentId` 在 79722，`nodeName` 在 79723。
- **問題**：79729 `this._chatActivate(ctx)` 會把畫面切到新對話。S3 的決定是「不自動切換」，所以 `_chatNew` 需要新增 `opts.noActivate`（S3 會加，預設不傳行為不變）。
- 設計：不另寫 `_chatNewChild`，改用既有的 `_chatNew(groupId, { parentId, nodeName, noActivate: true })`。

### 1.6 `_chatSwitch`（連結卡片點擊的目標）

- 定義：79690–79699。條件：`_chatListReady`、不是目前對話、沒在切換中。流程：`_flushChatWrite` → `_chatCtxLoad(id)` → `_chatActivate(ctx)` → `_saveChatIndex`。
- 作用：把畫面切到指定對話（沒有 ctx 則從存檔讀）。連結卡片的點擊會呼叫它。

### 1.7 進度卡片的建立、存檔與還原

- 建立：`_createProgressWidget(title)`：78104 起。訊息是 `{ role: 'tool', content: '' }`（78111），`_progressWidget` 是非可列舉屬性（78113），推入 `this.messages`（78114）。
- 存檔：`_persistChatHistory`（106391 起）。進度卡片的狀態另存一份（106464–106470），重新載入後以 `_progressWidget` 還原（106570）。
- 顯示型別的參考模式：`_pushDisplayToolMessage(note, prop, value)`（53907–53911）用 `_buildToolResultMessage('display', …)`（78592）建立 `role:'tool'` 的訊息，`prop` 是非可列舉屬性。
- **決定**：連結卡片沿用 `_pushDisplayToolMessage` 的 `role:'tool'`＋`display` 結構，但把連結資料放在**可列舉**的 `_subchatLink` 欄位（`{ childId, title }`）。理由：非可列舉屬性不會被 `JSON.stringify` 存檔，重新載入後連結會消失；可列舉欄位會隨 `messages` 一起存檔。（待確認：送給模型的 API 組裝是否會把這個欄位帶出去。步驟 4 的評估要驗證。）

### 1.8 遠端與 `rg_dispatch.js` 的位置（修正設計文件的錯誤行號）

- `remote/rg_dispatch.js:822` 是「把遠端訊息送進**既有**對話」的 `executeChat` 呼叫（S1 已指出，設計文件原寫的「建立」是錯的）。S3 不碰遠端。
- 主檔的 `_chatRunner(ctx)` 用法範例：53474–53476（建立 ctx 後 `this._chatRunner(ctx)`）、53714（對指定 ctx 呼叫 `executeChat`）。S3 沿用這個寫法：`this._chatRunner(childCtx).executeChat(newText)`。

### 1.9 索引與存檔

- `_chatIndex`、`_chatEntry(id)`：79511。
- `_saveChatIndex()`：79506。
- `_chatMarkUnread(ctx)`：79500（背景對話有新內容時打未讀標記）。

### 1.10 找不到的項目

- 「子對話完成時的狀態更新」：沒有既有 hook。S3 的做法：在建立子對話時，對子對話 `executeChat` 回傳的 Promise 掛 `.then`／`.catch`，更新索引的 `status`，再 `_renderChatList()`。不改 executeChat 本體的 `finally`。
- `_getFinalSystemPrompt()`：76024（子對話建立時用來補 system prompt，因為 executeChat 只在 `messages.length === 0` 時才建立）。

## 決定（S3 內）

1. **觸發條件**：`advancedSettings.topicShiftCheck === true` 且 `_lastTopicShift.isShifted === true` 且 `matchedTopicId` 為空，且目前對話本身**不是**子對話（索引沒有 `parentId`，防止子對話再開子對話）。`matchedTopicId` 有值時照舊在父對話處理，留給 S5。
2. **插入點**：102637 之後、102638 之前。
3. **父對話**：使用者訊息照常推入 `this.messages`（102664 的寫法）並重繪；不呼叫父對話模型；推入一則連結卡片；`_setRespondingState(false)`。
4. **子對話建立**：`_chatNew(null, { parentId, nodeName: '', noActivate: true })`。子對話標題＝`buildHandoff` 產生的標題（新訊息前 20 字）。`status = 'running'`，`summary` 寫交接摘要。
5. **子對話的 ctx**：用 `_chatRunner(childCtx)`。先設定 `messages = [最終 system prompt, 交接 system 訊息]`，`topicData.fingerprint = fingerprintOf(newText)`（以新訊息初始化，避免子對話再判轉移）。之後 `executeChat(newText)` 會推入使用者訊息並呼叫子對話自己的模型。
6. **子對話 executeChat 不再開子對話**：由「目前對話有 `parentId` 就不開」的條件擋住（見上）。
7. **狀態**：`running` → `done`（executeChat 的 Promise resolve）或 `failed`（reject）。`waiting_user` 與冒泡屬 S4，不做。
8. **不自動切換畫面**：`noActivate` 讓 `_chatNew` 不呼叫 `_chatActivate`。

## 驗證計畫

- 步驟 2：`node renderer/src/chat/handoff.test.js`。
- 步驟 3：`scripts/eval/subchat_open.eval.js`（假模型，真 Electron）。先在修前證明：索引沒有子對話、父模型呼叫數不對。
- 步驟 4：點擊卡片、存檔還原、側欄樹狀。
- 步驟 5：開關關閉回歸；`topic_local.eval.js`、`chat_tree.eval.js`、`chat_tree_index.eval.js`、`read_ledger.eval.js` 重跑。

## 步驟 2–5 結果

- 步驟 2（`2b62a0f4`）：`renderer/src/chat/handoff.js` 與 `handoff.test.js`，`node renderer/src/chat/handoff.test.js` 12 項全過。
- 步驟 3（`bb025243`）：
  - 嵌入：`scripts/embed-code-ui.js` 新增 SUBCHATHANDOFF 區塊，主檔加 `SUBCHATHANDOFF-BEGIN`／`END` 標記，`scripts/build-web-lazy.js` 的 EXCLUDE 加入 `SUBCHATHANDOFF`（與 TOPICLOCAL 相同，留在網頁版核心）。
  - `_chatNew`（主檔約 79705）新增 `opts.title`、`opts.status`／`summary`／`fingerprint`（只在 `parentId` 時寫入）、`opts.noActivate`（不切換畫面），並改為回傳新對話 id。
  - `_subchatOpenFor(userText)`（主檔約 95974 起）：由 `executeChat` 在推入使用者訊息之後呼叫（主檔約 102716）。`_lastTopicShift` 加入 `FA_CHAT_CTX_KEYS`，讓父子各自一份。
  - 連結卡片：`_buildToolResultMessage('display', …)`，`_subchatLink` 為可列舉屬性；`_renderSingleMessageInner` 最前面加分支（約 107046 起）。
  - 評估 `scripts/eval/subchat_open.eval.js`（換埠 17962）：修前 `onOneChild`、`onChildCalledModel`、`onParentCallsFirstTwoOnly` 等 9 項不成立（父對話三則都呼叫模型）；修後 18 項全過（`allPass: true`），`loadedWorkdirImpl` 修前 false、修後 true。
- 步驟 4（`68bb3452`）：`scripts/eval/subchat_link.eval.js`（換埠 17963）14 項全過：停留父對話、點「打開」切到子對話、切回後按鈕還在、JSON 往返保留連結、從存檔重讀後按鈕仍在且可點、側欄樹狀預設收合、點開關出現子對話列、點開關不切換。
- 步驟 5：開關關閉的回歸由 `subchat_open.eval.js` 的關閉段證明（沒有子對話、沒有連結卡片、每則一次父對話呼叫）。既有評估：
  - `topic_local.eval.js`：`allPass: true`（13 項）。
  - `chat_tree.eval.js`：全部判準為 true（其中 `shape_after_delete` 是字串記錄，不是判準）。
  - `chat_tree_index.eval.js`：各欄位符合預期，沒有 false。
  - `read_ledger.eval.js`：**沒有內建的通過／失敗判準**，只印出修前修後的數值。數值與設計方向一致（例如 C_stubborn `warned: true`，修後 D／E 的 `reminders_in_request` 為 0），但這是人工判讀，不是機器判定，回報時不算通過。

## 驗證範圍（誠實列出）

- 真桌面版驗證過：送出流程的父子模型呼叫歸屬、子對話索引欄位（`parentId`、`title`、`status`）、子對話訊息（交接 system、使用者訊息、回覆）、父對話不呼叫模型、連結卡片的點擊與存檔重讀、側欄樹狀、關閉時的回歸、修前修後對照。
- 只有 node 測試：`handoff.js` 的標題與交接規則（12 項）。
- 沒驗證：
  - 連結卡片（`role:'tool'` 的 display 訊息）在父對話**下一則**送出時，是否被送進模型請求。`_buildToolResultMessage` 會補 `tool_call_id`（主檔約 78637），但沒有 assistant 的 `tool_calls` 前導，不確定模型端是否接受。既有的 `_pushDisplayToolMessage` 走同一條路，屬既有行為，本次沒有單獨測。
  - 真實的遠端需求、拉回舊話題（S5）、狀態冒泡（S4）都沒碰。
  - 真實模型的回覆品質與交接摘要的內容品質。

## 風險（給 S4–S5 接手者）

1. **`executeChat` 對 `this._activeCtx`**：executeChat 本體沒有直接寫 `_activeCtx`，所有畫面路徑都先看 `_chatIsVisible()`。但 executeChat 可達的方法若新增了寫入、且欄位不在 `FA_CHAT_CTX_KEYS`，會寫到實例上（＝目前顯示的對話）。S3 只新增 `_lastTopicShift` 進清單，其餘沒有審查。
2. **子對話 status 只有 done／failed**：`finish` 以 executeChat 的 Promise 結束為準。executeChat 內部模型失敗（`_otAllModelsFailed`）時仍會 resolve，所以會標成 done。S4 的 `waiting_user` 與冒泡要改成讀真正的結果。
3. **應用程式中途關閉**：子對話的 `status` 可能停在 `running`，沒有重啟後的修復。
4. **`_lastTopicShift` 只在父對話的執行中被讀**：`_subchatOpenFor` 在同步區段內讀取，所以父子並行不會誤讀；但若將來有人在 await 之後才讀，會讀到子對話寫的值。
5. **`_chatNew` 的 `forChild` 路徑跳過空對話檢查**：同一個父對話連續三則新話題，會開三個子對話（沒有去重）。這是預期（每個新話題一個子對話），但 S5 拉回時要用指紋比對，避免重複。

## 教訓

1. **背景執行的呼叫會被記到前一輪**：`subchat_open.eval.js` 第一次跑，`onParentCallsFirstTwoOnly` 失敗。原因是子對話的模型呼叫在父對話 `executeChat` 回傳前就發出，所以被記到父對話第三則那一列。修正是只數「不帶交接內文」的呼叫（父對話），子對話的呼叫另外用 `onChildCalledModel` 證明。這是記錄歸屬的修正，不是放寬判準；修前版本仍然 `onChild*` 全不成立。下次：評估要判斷「是誰的呼叫」時，用請求內容的特徵分辨，不要用時間順序。
2. **`_chatNew` 預設會切換畫面**：要 `noActivate` 才能留在父對話。也因此 `_chatNew` 改成回傳 id，之後呼叫方不必再找「最後一筆」。
3. **狀態欄位要進 `FA_CHAT_CTX_KEYS`**：`_lastTopicShift` 原本不在清單內，父子共用同一份。S2 的教訓（新增狀態要查所有重設點）在這次又適用：`_clearChatHistory` 要不要清 `_lastTopicShift`，目前沒有處理（它只在下一則訊息前被重新寫入，風險低，但要記住）。
4. 寫入主檔後跑 `scripts/embed-code-ui.js` 會重寫所有嵌入區塊；提交前用 `git diff --stat` 確認只有自己的變更（本次確認過，只有 `renderer/src/floating-assistant.js` 的 81 行與嵌入一行）。
5. 建置前先把 `renderer/floating-assistant*.js`、`update-manifest.json`、`web-lazy/`、`test-reports/` 備份到 scratchpad；修前對照時把備份的建置換進去跑評估，之後把新建置放回（先用 `cp` 另存一份當作新建置）。

---

## 原檔：subchat-s4

# 子對話 S4：狀態監控與冒泡（進行中）

依據：`DESIGN.TODO.chat-subsessions.md` 第 10.2 節的 S4；前置 `subchat-s1.md`、`subchat-s2.md`、`subchat-s3.md`。
範圍：只做 S4。不做 S5（拉回舊話題、`@` 輸入）、S6（遠端統一）、S7（批次刪除）。
開關：`advancedSettings.topicShiftCheck === true` 且有子對話時才會發生；開關關閉時行為與現在相同。

## 步驟 1：連結卡片是否進入模型請求（已驗證）

對應 S3 文件「沒驗證」的第一項。

### 結論

連結卡片（`role:'tool'` 的顯示訊息，`_subchatLink`）**不會**進入模型請求，不需要修。

### 程式依據

- 主檔 `renderer/floating-assistant.js` 只有 1196 行（長行），所以用字元位置（`String.indexOf`）定位，不用行號：
  - 連結卡片由 `_subchatOpenFor`（字元位置 8646537）建立：`_buildToolResultMessage("display", …, {})`，之後設 `h._subchatLink`（字元位置 8647633）。這則卡片沒有 `_card`／`_humanOnly` 旗標。
- 送出前的過濾是 `_sanitizeToolCallPairing`（字元位置 8138498；`_buildToolResultMessage` 在 8139355）：
  - 只保留 `role:'tool'` 且 `tool_call_id` 在「前一則 assistant 的 `tool_calls`」裡的訊息。
  - 卡片前面是使用者訊息或 assistant 的純文字，沒有 `tool_calls`，所以被 `continue` 丟掉。
  - 有 `_card`／`_humanOnly` 旗標的訊息會被略過（不影響這個判斷）。
- 呼叫端：`g=this._sanitizeToolCallPairing(0===m…` 位於字元位置 9034528，`messages:this._sanitizeToolCallPairing(F)` 位於 9084202。

### 評估

`scripts/eval/subchat_card_request.eval.js`，真桌面版（`run_eval.js`，埠 17964），假 LLM 抓請求 body。

前置：前三則開出子對話，父對話 `fa.messages` 有 1 張連結卡片（`preCardExists: true`）。

第四則「還有一句話」在父對話送出，請求摘要：

- 送進模型 7 則；介面 9 則（差 2 = 兩張連結卡片以外的顯示訊息，已由 `requestSmallerThanUi: true` 確認比介面少）。
- 角色序列：`assistant, user, assistant, user, assistant, user, user`。
- 沒有任何 `role:'tool'` 訊息，因此沒有孤兒 tool，也沒有「↳ 子對話」字樣（`noCardTextInRequest: true`、`noOrphanToolInRequest: true`）。
- 父對話送出沒有錯誤（`parentNoError: true`）。
- 全部 6 項 `allPass: true`。

### 評估的注意事項（不是產品缺陷，但要知道）

- 第四則**不能**在話題偵測開啟時送出：本地話題偵測（S2）會把「還有一句話」判成新話題，開出第三個子對話、父對話不呼叫模型（實測）。所以這一則在 `topicShiftCheck = false` 時送出。這仍是正確的測試情境（卡片在父對話訊息列表、父對話自己送模型請求）。
- 「本地話題偵測把不相關的一則判成新話題」是 S2 既有行為，不在 S4 範圍，記在這裡當作已知現象，之後交給管理層判斷。

### 修前失敗？

沒有：判準在現有程式下已成立，沒有做任何程式修改。

## 步驟 3：需要使用者回應的等待種類（只調查，未改程式）

定位方式：主檔只有 1196 行（長行），以下都是字元位置（`String.indexOf`），不是行號。

### 背景：子對話 ctx 與父對話的關係

- `FA_CHAT_CTX_KEYS` 定義在字元位置 5781995，包含 `messages`、`isResponding`、`_toolCallLog` 等，每個對話各一份。
- `_chatRunner(ctx)`（字元位置 8160987）回傳 Proxy：對這些欄位的讀寫導向 ctx 自己的那一份；`_ctx` 也指向 ctx。所以子對話的 `this.messages` 是子對話自己的訊息。
- `_chatIsVisible()`（字元位置 8160935）＝`this._ctx === this._activeCtx`，判斷這個對話現在是不是使用者看得到的那個。
- `_chatActivate`（約 8165854 之後）：切換對話時，若離開的對話有 `pendingForm`，會把表單從畫面移除、設 `waitingForUser`，並放進 `visibleWaiters`；切回來時才重新顯示（`visibleWaiters` 的 flush 在字元位置約 8166633）。

### 種類 1：`ask_user_card`（互動卡片，最常見）

- 實作：`askCard(e)`（字元位置 8108338）。把卡片訊息（`_card` 旗標）推進 `this.messages`（子對話的 ctx 下就是子對話自己的訊息），然後 `new Promise` 等使用者送出。
- 不可見時：`askCard` 只在 `!this._chatIsVisible()` 時設 `ctx.waitingForUser = true` 並重畫側欄（`_renderChatList`）。卡片本身只有在對話畫面渲染時才會出現（`_renderMessageHistory`）。
- 表現：子對話在背景時，卡片在子對話的訊息裡、使用者看不到；子對話的 `executeChat` 停在這個 Promise 上不會往下走（**卡住**）。只有側欄有一個 `waitingForUser` 標記，且要使用者自己點進子對話才看得到卡片。
- 呼叫端（字元位置）：`ask_user_card` 工具註冊 7199149 附近；`askCardFlow` 8109170；擴展回合的確認卡 7977318（有「不要／以後都不要問」選項，是權限式問題）；日誌學習確認卡 8873611。
- 這一種**沒有**冒泡機制，是 S4 要處理的主要對象。

### 種類 2：`requestUserForm` → `_showUserFormDialog`（表單／選擇框）

- `requestUserForm(e)`（字元位置 8124148）三段式：
  1. 進階設定的 modal 開著 → 直接 `_showUserFormDialog`（與對話無關，立即顯示）。
  2. 對話不可見 → 設 `waitingForUser`、重畫側欄，等 `visibleWaiters`（使用者切回來才顯示）。**卡住直到使用者切回子對話**。
  3. 可見 → `_requestUserFormNow`。
- `_showUserFormDialog`（字元位置 8130700）是 `document.body` 上的 modal 覆蓋層，點選項後 resolve。第 15 秒會 `r.remove()` 移除 DOM；**沒查**這時 Promise 是否會結束（如果不結束就是卡住，要另外確認）。
- 另一個直接呼叫者：下載位置選擇（字元位置 8128956），直接 `_showUserFormDialog`，不經 `requestUserForm`，所以**不論哪個對話**都會立即跳出來，且對話框上沒有對話名稱。

### 種類 3：FAP 檔案存取權限（`_checkFapPermission` → `_showFapPermissionDialog`）

- `_checkFapPermission`（字元位置 7356364）檢查 `queryPermission`，不足時呼叫 `_showFapPermissionDialog`（字元位置 7356715，modal 覆蓋層，`document.body`）。結果用 `_fapPermissionDialogPromises` 合併同一把資料夾的同時請求。
- 表現：**不論哪個對話**都立即跳出；子對話會等使用者在這個框上按下才繼續（框在畫面上，使用者找得到，所以不是無限卡住），但框上沒有對話名稱，使用者可能不知道是哪個子對話在要權限。
- 這一種不是「看不見而卡住」，而是「看得見但不知來源」。S4 可以先不改，只在文件列為已知缺口。

### 種類 4：`askBranchChoice`（分支選擇）

- 字元位置 8127324。**沒查**是否為 modal、是否受 `_chatIsVisible` 影響，以及在子對話中的表現。

### 沒找到的種類

- 模型工具呼叫的逐次核准（tool approval）：關鍵字 `tool_approval`、`needApproval`、`_confirmTool`、`_showConfirm` 在主檔都是 0 次；`approve` 只有 `approvePlan` 一次（與工具核准無關）。本次沒有找到模型工具呼叫的核准機制。
- `window.confirm(`：約 25 次，多為使用者在畫面上按「刪除」的確認（例如知識庫刪除，字元位置約 2614739 之後的 `window.confirm` 系列），不是模型發起。**沒逐一查**全部 60 次 `confirm(`（另有 `c.confirm(`、`t.confirm(` 各 1 次，沒查）。

### 小結（給步驟 4 用）

| 種類 | 子對話在背景時 | 會卡住子對話 | S4 要冒泡 |
|---|---|---|---|
| `ask_user_card`（`askCard`） | 卡片只在子對話，側欄標記 | 會 | **是（優先）** |
| `requestUserForm` | 等切回來 | 會 | 是（次要） |
| 下載位置選擇 | 立即跳出，無對話名稱 | 框可見，等點擊 | 否（一次性） |
| FAP 權限框 | 立即跳出，無對話名稱 | 框可見，等點擊 | 視情況（權限確認） |
| `askBranchChoice` | 沒查 | 沒查 | 沒查 |

## 步驟 4：監控與冒泡（已驗證，見下方已知缺口）

### 改了什麼

- 來源：`renderer/src/floating-assistant.js`（這是源頭；`renderer/floating-assistant*.js` 是建置產物，不提交）。
- 純函式：`renderer/src/chat/sub_status.js`（步驟 2）嵌入主檔，標記 `SUBCHATSTATUS-BEGIN／END` 放在 `SUBCHATHANDOFF-END` 後面；`scripts/embed-code-ui.js` 新增一行 `embed(...)`；`scripts/build-web-lazy.js` 的 EXCLUDE 加 `SUBCHATSTATUS`（留在網頁版核心，與 `SUBCHATHANDOFF` 相同）。
- 新方法（源頭檔）：
  - `_subchatStatusMod()`：載入狀態模型（new Function，只載入一次）。
  - `_subchatSetStatus(childId, event, info)`：所有狀態變化的入口。狀態有變才寫索引、重畫側欄；父對話的連結卡片若已在畫面上，呼叫 `_subchatLinkDecorate` 只更新它。`entry.subInfo` 只在進入 waiting_user（問題）或 failed（原因）時設定。
  - `_subchatPendingMap()`：子對話 id → 等待中的卡片訊息（只在記憶體，不存檔）。
  - `_subchatLinkInfo(childId)`：連結卡片要顯示的文字與 `canAnswer`。等待中但記憶體裡沒有卡片（重新整理後）顯示「等你回應已失效」。
  - `_subchatAnswer(childId, text)`：父對話回答。用「略過選項＋直接打字回答」的結果（`skipped:true`、`supplement`，與 `ask_user_card` 工具說明相同）交給卡片的等待者，子對話接著跑。
  - `_subchatLinkDecorate(w, childId)`：連結卡片的狀態列與回答欄（可重複呼叫，先清再畫）。
- 既有函式的改動：
  - `_subchatOpenFor`：完成時先用既有的 `_turnFailureText(使用者訊息位置)` 判斷；有失敗文字（⚠️／❌／🚫 開頭的 assistant 訊息）就記 `error`，否則 `finish`。`executeChat` 出錯時通常**不 reject**，只留下訊息，所以只靠 reject 會漏判。
  - `askCard`：卡片屬於子對話（`ctx.id` 的索引有 `parentId`）時，進入等待前記 `ask`（問題＝卡片標題），等待者回應後記 `answer`。
  - `_chatRunner`：新增 `_faHost`（proxy 取得真正的 app 實例）。原因見下方教訓。
  - 連結卡片渲染分支：加 `data-child-id`，改用 `_subchatLinkDecorate`。

### 評估

`scripts/eval/subchat_bubble.eval.js`，真桌面版，換埠 17965，假 LLM。最終結果 `allPass: true`（14 項全過）：

- 案例 A（問使用者 → 父對話回答 → 完成）：子對話 `waiting_user`；父對話連結卡片顯示「等你回應：要用哪種配色？」與回答欄；在父對話回答後 `_subchatAnswer` 回 ok；子對話收到答案（工具結果含「紅色」）、模型接著回「完成」，最後 `done`；父對話沒有卡在回應中。
- 案例 B（executeChat 拋錯）：`failed`，連結卡片顯示「失敗：fake boom」。
- 案例 C（executeChat 正常結束但最後一則是 ⚠️ 失敗訊息）：`failed`，連結卡片顯示「失敗：⚠️ 模型回應失敗…」。
- `loadedWorkdirImpl`：函式原始碼含 `fa-subchat-answer-row`（工作目錄的實作）。

修前證明：步驟 4 第一次跑（改程式前，評估的 A 段與現在相同）：`aStatusWaitingUser: false`、`aParentLinkShowsQuestion: false`、`aParentHasAnswerBox: false`、`aAnswerAccepted: false`、`aStatusDone: false`（子對話沒有停在等待上，也沒有完成）。B／C 案例是後來才改成替換 executeChat 的版本，修前沒有單獨跑過；這點照實說明。

### 評估過程中改掉的東西（都是評估或實作的問題，不是判準被放寬）

1. 假 LLM 回 HTTP 500：應用會重試（約 8 次、間隔逐漸拉長，約 20 秒以上），不是失敗。
2. 假 LLM 回 HTTP 400：應用把它當成「上下文過長」，做歷史摘要後再試，摘要請求得到的預設「完成」被當成成功。
3. 假 LLM 失敗時，應用的離線食譜會接住，子對話變成「🍳 離線食譜…」的正常回覆，判成 done。這是應用既有的離線備援，不是 S4 要改的。所以 B／C 改成替換 `executeChat`，測的是 S4 自己的失敗判斷。
4. 案例 B 一開始找到的是案例 A 的子對話（同一個父對話底下，`[0]` 取到錯的）。改成用標題找。

### 已知缺口（沒有冒泡的等待種類）

1. `requestUserForm`（表單）：子對話在背景時會在 `visibleWaiters` 等待，**使用者切回子對話才會出現**，父對話的連結卡片不會冒泡。會卡住子對話。
2. FAP 檔案權限框（`_showFapPermissionDialog`）與下載位置選擇（`_showUserFormDialog` 直接呼叫）：是全畫面的 modal，看得見、子對話會等點擊，但框上沒有對話名稱，不知道是哪個子對話在要。沒有改。
3. `askBranchChoice`：步驟 3 沒查完，沒有改。
4. 重新整理後：等待中的卡片記憶體消失，子對話索引仍是 `waiting_user`，連結卡片顯示「等你回應已失效」。卡片本身在重新整理後會變成唯讀「已結束」。沒有自動把子對話改成失敗或完成。
5. **重要（給步驟 5 與管理層）**：子對話送出的工具清單（實測 8～13 項）**不含 `ask_user_card`**。所以真實模型在子對話裡不一定能呼叫它，冒泡在真實使用中可能很少觸發。評估是假模型直接回傳這個工具呼叫，驗證的是執行端與冒泡，不是「模型會不會主動問」。這一點需要管理層決定：要不要讓子對話的工具清單包含 `ask_user_card`。
6. 錯誤判斷靠 ⚠️／❌／🚫 開頭的文字（`_turnFailureText` 既有判準）。離線備援會把失敗包成正常回覆，子對話會判成 done。
7. 新增的狀態欄位：`entry.subInfo`（索引欄位，會存檔）、`_subchatPending`（FA 層，不存檔）、`_subchatStatusModule`（FA 層快取）。**沒有**新增 ctx 狀態欄位，所以沒有加進 `FA_CHAT_CTX_KEYS`。

## 步驟 5：父對話傳訊息給子對話（已驗證）

### 改了什麼（源頭 `renderer/src/floating-assistant.js`）

- `_subchatRun(childId, cctx, text)`：開子對話（`_subchatOpenFor`）與傳訊息共用的執行段。開始記 `start`（閒置的子對話回到 running）；完成記 `finish`；出錯記 `error`（失敗判斷仍是 `_turnFailureText`）。`_subchatOpenFor` 的執行段改成呼叫它。
- `_subchatSend(childId, text)`：連結卡片的「傳給子對話」。
  - 子對話 `isResponding` 為真 → 走既有插話規則（`executeChat` 開頭的 `_addSteeringMessage`，子對話訊息多一則 `[Steering]`），回 `mode: 'steer'`。
  - 閒置 → `_subchatRun` 當成新一輪（狀態回 running），回 `mode: 'turn'`。
  - 子對話不在記憶體 → 用 `_chatCtxLoad` 載入。
- `_subchatLinkDecorate`：輸入列永遠存在。等待中且記憶體有卡片 → 按鈕是「回答」（交給卡片）；否則「傳給子對話」。父對話自己的輸入框沒有改，仍然只問父對話。

### 評估

`scripts/eval/subchat_send.eval.js`，真桌面版，換埠 17966，假 LLM。`allPass: true`（19 項全過）：

- 案例 1（閒置 → 新一輪）：`mode: 'turn'`，狀態確實觀察到 running，最後 done；子對話有使用者訊息與「完成」回覆；父對話模型呼叫數不變。
- 案例 2（回應中 → 插話）：子對話 `isResponding` 為真時送出，`mode: 'steer'`，子對話訊息含 `[Steering]` 與原文；最後 done。
- 案例 3（父對話輸入框）：父對話模型多一次呼叫，父對話有該則使用者訊息，子對話訊息數不變、沒有新子對話。
- 案例 4（畫面按鈕）：連結卡片有「傳給子對話」按鈕與輸入框；輸入後點擊，子對話收到文字，輸入框清空。
- `loadedWorkdirImpl`：函式原始碼含 `steer`。

修前：`_subchatSend` 這個方法在改程式前不存在，整個評估的前提不成立（沒有另外跑修前版本，這是新功能，不是修正）。

### 回歸

步驟 4 的 `subchat_bubble.eval.js` 在 `_subchatOpenFor` 改成 `_subchatRun` 後重跑：`allPass: true`（14 項全過）。

### 已知限制

- 子對話在等待使用者回答（`waiting_user` 且記憶體有卡片）時，連結卡片的按鈕是「回答」，不會把文字當成一般訊息送出。要補充說明就得用回答的文字。
- 插話文字只進子對話的訊息，不會自動在父對話顯示（父對話的連結卡片沒有列出傳過去的內容）。
- 步驟 4 的已知缺口（表單、權限框、重新整理後的等待）沒有因為這一步改變。

## 步驟 6：回歸（已驗證）

真桌面版，各評估各自換埠、並行跑，改動後的最新建置（步驟 5 之後）。

| 評估 | 結果 | 說明 |
|---|---|---|
| `subchat_open.eval.js` | `allPass: true`（18 項） | 含「開關關閉」段：`offNoChild`、`offNoLinkCard`、`offEachTurnOneParentCall`（三則都只在父對話、每則一次父對話呼叫） |
| `subchat_link.eval.js` | `allPass: true`（14 項） | 連結卡片的打開、存檔重讀、側欄樹狀 |
| `subchat_card_request.eval.js` | `allPass: true`（6 項） | 步驟 1 的連結卡片不進請求 |
| `subchat_bubble.eval.js` | `allPass: true`（14 項） | 步驟 4 冒泡，步驟 5 之後重跑 |
| `subchat_send.eval.js` | `allPass: true`（19 項） | 步驟 5 傳訊息 |
| `topic_local.eval.js` | 全部 true（13 項） | 開關關閉的呼叫數與開啟時一致 |
| `chat_tree.eval.js` | 全部判準 true | 含 `regression_no_children`、`regression_class_names` |
| `chat_tree_index.eval.js` | 各欄位符合預期，沒有 false | 沒有內建 `allPass`，人工判讀 |
| `read_ledger.eval.js` | 數值符合 S3 記錄的方向 | **沒有內建判準**，人工判讀，不算通過（與 S3 相同） |

結論：開關關閉時，三則訊息只在父對話處理，沒有子對話與連結卡片（`subchat_open` 關閉段、`topic_local` 關閉段）；既有的子對話、樹狀、索引功能沒有變紅。

## 教訓

- 第一次評估失敗的原因是評估設計（第四則觸發了新話題），不是程式。之後看到「沒抓到請求」先印出呼叫類型與子對話清單，不要直接改判準。
- 主檔是長行，`grep -n` 的行號沒有意義；用 `node` 讀檔後 `indexOf` 定位，回報用字元位置。源頭 `renderer/src/floating-assistant.js` 是排過版的，可以用行號。
- 在對話 proxy（`_chatRunner`）上呼叫 `_renderMessageHistory` 會畫到**子對話**的訊息；畫面要用真正的 app 實例（`_faHost`）。
- 增量重畫不會重建已經在畫面上的舊卡片；狀態變了要自己更新那張卡片（`_subchatLinkDecorate`）。
- `executeChat` 出錯通常不 reject，要看子對話訊息裡的失敗文字；假模型的 500／400 會觸發應用的重試、摘要、離線備援，評估時要替換 `executeChat` 才能測到 S4 自己的分支。
- 評估跑太久會超過 `run_eval.js` 的 170 秒上限，輸出會是空的。等待時間要縮短到整段在上限內。
- 工作目錄裡別人未提交的建置產物（`renderer/floating-assistant*.js`、`web-lazy/*`、`update-manifest.json`、`test-reports/*`）在建置時會被覆寫。建置前先備份到暫存資料夾。
- 主檔是長行，`grep -n` 的行號沒有意義；用 `node` 讀檔後 `indexOf` 定位，回報用字元位置。

---

## 原檔：subchat-s4b

# 子對話 S4b：補完 S4 的缺口（進行中）

依據：`DESIGN.TODO.subchat-s4.md`（已知缺口 1～5）、`DESIGN.TODO.chat-subsessions.md` 第 10 節。
範圍：只做 S4b。不做 S5（拉回舊話題、`@` 輸入）、S6（遠端統一）、S7（批次刪除）。
位置說明：以下行號都是源頭 `renderer/src/floating-assistant.js`（已排版，行號有效）。建置產物 `renderer/floating-assistant.js` 是長行，不用行號。

## 步驟 1：子對話工具清單與父對話不同的根因（只調查，未改程式）

### 結論（靜態證據，步驟 2 會用評估實測）

`ask_user_card` 在父對話的根層級清單裡就**不存在**（預設模式 `full` 下）。子對話的清單與父對話一樣缺它，這不是子對話獨有的分歧。根因是它被歸類成「domain-gated」（需要透過領域委派才拿得到的工具），而不是根層級工具。

所以 S4 的「已知缺口 5」寫的「子對話送出的清單不含 ask_user_card」是事實，但不是子對話的錯，而是**父對話也沒有**。管理層要的「子對話與父對話一致」在這個根因下會是一致的，但子對話要問父對話使用者的能力，也因此沒有了。

### 程式依據

1. 預設模式：`multiSubAgentMode: 'full'`（`floating-assistant.js` 57646）。
2. 根層級清單：`_getRootToolNames()`（74749–74761）
   - `mode === 'off'` 才會列出全部內建工具。
   - 其他模式：`rootBuiltins = Object.keys(this.tools).filter(n => !this._domainGatedToolNames.has(n))`（74756）。domain-gated 的工具不進根層級。
   - 再加上 `_rootTaskHints()` 的專用工具（74758），以及 `intent` 模式的過濾（74759）。
3. 分類來源：`_domainGatedToolNames` 由 `registerOptional()` 填入（59429–59432）。`_registerBuiltinAiTools` 註解（59407–59428）寫明：「這批通用內建工具（共 23 個）用 registerOptional 註冊，讓 `_getRootToolNames()` 知道哪些工具要從根層級排除」。
4. `ask_user_card` 用 `registerOptional` 註冊：61073–61084。也就是說它屬於 gated 集合。
5. 專用工具提示（`FA_TASK_TOOL_HINTS`，47191 起）**沒有** `ask_user_card`（用 `grep` 全檔搜尋確認，只出現在 1041、14751、25205、61073、96064 行，其中 25205 是階段 `ph_design` 的工具列表，不是提示）。所以使用者說什麼都不會把它補進根層級。
6. 階段 `ph_design`（25205）與領域 `design` 的工具清單有它，所以只有委派到設計領域的子 agent 才拿得到。

### 子對話與父對話送出清單的路徑是同一條

- 送出的 `tools` 都是 `this._buildNativeToolsSchema(this._getRootToolNames())`（`_loopFetchNative` 的 103546；另一處 102222 是 benchmark，同一邏輯）。
- 子對話與父對話用同一個 `_getRootToolNames()`。差異只能來自「狀態」：
  - `_currentTurnUserText`、`messages`：在 `FA_CHAT_CTX_KEYS`（51017–51027），每個對話各一份。
  - `_intentPlanCache`、`_intentRecent`、`_intentExtra`、`_intentWiden`、`_intentMiss`、`_intentHidden`：**不在** `FA_CHAT_CTX_KEYS`，只在 `intent` 模式下有作用（75609 `_intentOn()`）。預設 `full` 模式下不生效。
- `_focusTools`（77765）只在領域子 agent 執行（104051），不在對話送出的路徑上，**不是**原因。
- `_domainGatedToolNames` 是 app 實例上的 Set，子對話與父對話讀到的一樣。

### 排除的其他可能（照實寫）

- 工具預算／聚焦（`FaToolBudget`、`_focusTools`）：只在領域子 agent 路徑，不影響對話請求。排除。
- 意圖過濾（`intent`）：預設不是 `intent` 模式，不是原因；但若使用者切到 `intent`，`ask_user_card` 會變成「根層級候選」，會不會留下要看它的詞彙分數（75619），步驟 2 不處理這個模式，只在文件註明。
- 新對話沒登記某些工具：不是。子對話與父對話用同一個 `this.tools`。
- ctx 沒帶設定：不是。`multiSubAgentMode` 是 app 層設定，不是 ctx 欄位。

### 還沒確定的（步驟 2 用評估確認）

- 「父對話在 `full` 模式下送出的清單真的不含 `ask_user_card`」是靜態推論，還沒實測。步驟 2 的評估會先跑修前版本，同一句話在父對話與子對話各抓一次 `tools`。
- `_domainGatedToolNames` 收錄的確切數目（註解寫 23 個，現在可能更多）：未查，不影響結論。

## 修正方向（給步驟 2，管理層決定：自己決定並寫理由）

選項比較：

- A. 在子對話的 ctx 上額外加入 `ask_user_card`（只改子對話）：會讓子對話與父對話不一致，違反管理層決定 (1)。不採用。
- B. 把 `ask_user_card` 從 gated 移到根層級（改成一般 `register_openai_tool`，不經 `registerOptional`）：父對話與子對話都會有它，符合「工具能力一致」。代價：根層級多一個工具的 schema 大約幾百 token。**採用此方案**。理由：`ask_user_card` 是對話層級的互動能力（問使用者），不是某個領域的專用工具，放在 gated 集合是分類錯誤。
- C. 只在 `ask_user_card` 加到提示表（`FA_TASK_TOOL_HINTS`）：靠關鍵字，不可靠。不採用。

## 步驟 2：修根因，工具清單一致（已驗證）

> **已由使用者決定取代（2026-11-04，「ask_user_card只在parent」）**：本段的「根層級註冊」改回 `registerOptional`（domain-gated），子對話永遠沒有 `ask_user_card`。細節與行號見 `DESIGN.TODO.subchat-s8.md` 步驟 F。

### 改了什麼（源頭 `renderer/src/floating-assistant.js`）

- `_registerBuiltinAiTools` 裡 `ask_user_card` 從 `registerOptional(...)` 改成 `this.register_openai_tool(...)`（約 61073 行，附註解）。它不再屬於 `_domainGatedToolNames`，所以 `_getRootToolNames()` 在 `full`／`router` 模式下會列出它。說明、參數、回傳格式都沒改。
- 選了方案 B（見上面「修正方向」）：A 只改子對話會造成不一致，C 靠關鍵字不可靠。
- 代價：根層級每一輪多一個工具的 schema（約幾百 token）。父對話行為會多一種能力：可以主動開互動卡片。步驟 6 要確認工具預算相關評估沒有變紅。

### 評估

`scripts/eval/subchat_tools.eval.js`，真桌面版，埠 17967，假 LLM 抓 `body.tools`。同一句「幫我畫一張貓的圖」：父對話（話題偵測關閉）與子對話（經 `_subchatSend`，閒置 → 新一輪）各抓一次請求。

| 檢查 | 修前 | 修後 |
|---|---|---|
| parentCaptured／childCaptured | true／true | true／true |
| sameNameSet（名稱集合完全相同） | true | true |
| parentHasAskCard | **false** | true |
| childHasAskCard | **false** | true |
| loadedWorkdirImpl | （修前沒有此項） | true |
| 工具數（父／子） | 9／9 | 10／10 |
| allPass | false | **true** |

修前的重點：父與子的名稱集合本來就相同，兩邊都缺 `ask_user_card`。所以管理層預期的「子對話與父對話不同」在這個根因下不成立，差異是**父子都缺**。修前失敗來自 `parentHasAskCard`、`childHasAskCard`。

### 建置注意

- 建置後的 `renderer/floating-assistant.js` 把單引號改成雙引號（`register_openai_tool("ask_user_card",`），而且行數與排版都不同。判準不能只找單引號字串；評估改成兩種引號都接受的 regex。
- 建置前已把 `renderer/floating-assistant*.js`、`update-manifest.json`、`web-lazy/core.js`、`web-lazy/manifest.json`、`test-reports/core-tests-latest.*`、`skills/image-decompose-redraw/data/parts_builtin.json` 備份到暫存資料夾（不提交）。

## 步驟 3：表單與下載選擇的冒泡與回答（已驗證）

### 種類判定（先查再改）

- 表單（`requestUserForm`）：模型工具執行中呼叫，**會卡住子對話**。要冒泡。
- 下載位置選擇（`_pickDownloadDir` → `_showUserFormDialog`，`_wireDesktopDownloadLink` 的點擊處理）：只有**使用者點了下載連結**才會呼叫；`_pickDownloadDir` 的呼叫者只有那個點擊處理（用 Grep 確認）。模型不等它，子對話不會因此停住，所以**不是等待，不冒泡**。畫面上的對話框是使用者自己點的那個對話，沒有「哪個子對話」的混淆。不改。

### 改了什麼（源頭 `renderer/src/floating-assistant.js`）

- `requestUserForm`：Configure 視窗開著時仍照舊（最上層對話框）；其餘情況若目前對話是子對話（`_chatEntry(id).parentId`），改走 `_subchatAskForm`。
- `_subchatAskForm(subId, options)`：等待記錄 `{kind:'form', options}` 存在 `_subchatPendingMap`（只在記憶體）；狀態送 `ask`（問題＝表單標題）→ `waiting_user`。
  - 子對話在畫面上：照常畫表單，同時父對話也能回答；先回答的一方算數，另一方的畫面會收掉。
  - 子對話不在畫面上：不靠使用者切回來，父對話連結卡片就能回答；切回來時才補顯示（若還沒被回答）。
  - 表單選項物件多一個 `isCancelled`：父對話已回答的表單，之後不再畫出來（見下方「踩到的坑」）。
- `_subchatAnswerForm(childId, payload)`：父對話回答。payload 種類與回傳形狀：
  - `{kind:'choice', answer}` → `{confirmed:true, answer}`（只接受表單裡的選項）。
  - `{kind:'supplement', text}` → `{confirmed:true, answer:null, skipped:true, supplement}`，**只在 `allowSupplement` 為真時接受**（與子對話自己的表單一致；執行、安裝、刪除這類同意表單不接受打字）。
  - `{kind:'values', values}` → `{confirmed:true, values}`（只給欄位表單）。
  - `{kind:'cancel'}` → `{confirmed:false}`。
- `_subchatAnswer(childId, text)`（S4 既有的卡片回答）：等待中是表單時，轉給 `_subchatAnswerForm` 的 supplement（被拒絕就回傳錯誤）。
- `_subchatLinkInfo` 多回傳 `pending`（`'form'`／`'card'`）與 `form`（選項）。`_subchatLinkDecorate`：等待中是表單時，改畫 `_subchatFormRow`（選項按鈕、欄位輸入＋送出、取消、允許補充時的文字輸入）。
- `_showUserForm`：`options.isCancelled()` 為真時直接結束、不畫（見踩到的坑）。只有子對話表單帶這個欄位，其他表單行為不變。
- 沒有新增 ctx 狀態欄位（`pendingForm`、`visibleWaiters`、`waitingForUser` 都是既有的），所以不用進 `FA_CHAT_CTX_KEYS`。

### 評估

`scripts/eval/subchat_form.eval.js`，真桌面版，埠 17968，假 LLM。子對話先建立（前三則），之後直接呼叫子對話的 `requestUserForm`。表單只會在執行中要求，所以每案例前先 `_subchatSetStatus(kid,'start')`（模擬一輪開始；`done` 是終態，`ask` 會被忽略）。

最終結果 `allPass: true`（19 項全過）：F1 背景選項表單（waiting_user、題目顯示、父對話連結卡片有選項、父對話選了「藍色」→ 子對話表單拿到「藍色」）；F2 欄位表單（values）；F3 不允許補充的表單：打字被表單路與卡片路都拒絕、仍在 waiting_user，之後按選項才答完；F4 允許補充：打字當成 supplement；F5 子對話在畫面上：表單顯示、父對話回答後表單被收掉；F6 子對話在畫面上、子對話先按：父對話等待取消，之後父對話回答被拒絕；F7 父對話回答後切回子對話，不再重新顯示；`loadedWorkdirImpl`。

修前（同一評估，用 HEAD 的源頭重建）：`f1_waitingUser: false`、`f1_parentLinkShowsForm: false`、`f1_resolvedChoice: false`、`f2_valuesResolved: false`、`f3_choiceResolves: false`、`f4_supplementAccepted: false`、`f5_formShownInChild: false`、`f5_parentAnswerResolves: false`、`f6_childAnswerResolves: false`、`loadedWorkdirImpl: false`，`allPass: false`。修前的「拒絕」判定（F3 打字、F6 晚到回答）為 true，是因為方法不存在而回傳錯誤，不是功能正確，所以不能算作通過的證據。

### 踩到的坑（照實寫）

1. 評估第一次全部失敗，原因是**評估**：子對話在 `done` 時送 `ask` 會被狀態機忽略（`sub_status.js` 的 `done` 是終態）。表單本來就只在執行中要求，所以評估要先模擬 `start`，不是程式錯。
2. 父對話回答後，表單又在子對話切回時重新出現（F5 之後 F6 之前）。原因：`_chatActivate` 離開有 `pendingForm` 的對話時，會把表單收起來並在 `visibleWaiters` 放一個重新顯示的等待者（`_chatActivate` 約 79681–79686 行）。父對話先回答時沒有取消那個等待者，切回來就畫出已結束的表單。修法：`isCancelled`（只影響子對話的表單）。這也是 F7 的由來。

### 還沒驗證（明說）

- F5 的「父對話先回答、子對話畫面上的表單收掉」是在子對話**被切走之後**的路徑（`_chatActivate` 收起表單 → 父對話回答 → 切回）也有驗證到（F5 之後接 F6／F7）；但「子對話在畫面上、父對話先回答」的直接路徑只驗證到「表單被收掉」（`f5_childFormRemoved`）。
- 欄位表單的 `widget` 與 `info` 種類不在這次範圍（`_showUserForm` 只支援 choices 與 fields，見源頭註解）。

## 步驟 4：FAP 資料夾授權框的冒泡與回答（已驗證）

### 種類與不可自動回答的原則

- `_checkFapPermission`（約 64405 行）＝模型工具要讀寫資料夾時，若沒有授權就跳出授權框（全域 modal，`_showFapPermissionDialog`），工具等使用者按「授權」或「拒絕」。**會卡住子對話**，要冒泡。
- **權限式問題**：這是安全閘門，**一律由使用者在父對話或權限框上明確按下**。程式不會替使用者同意：沒有自動授權、沒有逾時自動同意、父對話的文字輸入不接受（`_subchatAnswer` 對 `fap` 回傳錯誤）。
- 瀏覽器的 `requestPermission()` 需要使用者手勢，所以「授權」必須在點擊事件裡同步呼叫。父對話的按鈕與權限框的按鈕都呼叫同一組 `allow()`／`deny()`，`allow()` 第一個動作就是同步呼叫 `requestPermission()`。

### 改了什麼（源頭 `renderer/src/floating-assistant.js`）

- `_checkFapPermission`：子對話來的檢查（`this._ctx` 是子對話，`_chatEntry(id).parentId` 有值）→ 登記 `_subchatFapBubble`（等待記錄 `{kind:'fap', key, label, mode}` 存在 `_subchatPendingMap`，狀態 `ask`，問題文字「需要資料夾授權：<名稱>（讀寫／讀取）」）。等待結束（不論同意或拒絕）`clear()` 清掉等待記錄、狀態回 `answer`。
- `_showFapPermissionDialog(rec, mode, key, from)`：權限框加上「來自子對話：<標題>」（回答原本的「框上沒有對話名稱」缺口）；框註冊 `_fapPermCtl`（key → `{allow, deny}`），框關閉時移除。
- `_subchatAnswerFap(childId, allow)`：父對話按「授權／拒絕」→ 呼叫 `_fapPermCtl` 的 `allow()`／`deny()`。
- `_subchatFapRow(w, childId)`：連結卡片的按鈕列（授權、拒絕、說明「權限問題只能由你按按鈕決定」）。
- `_subchatLinkInfo` 的 `pending` 多一種 `'fap'`；`_subchatLinkDecorate` 對 `fap` 畫按鈕列；`_subchatAnswer` 對 `fap` 回傳錯誤（不接受文字）。
- 同一子對話同時只顯示一件等待：已有別的等待（卡片、表單）時，權限的等待不覆蓋它，權限框仍在畫面上可以按（照常等）。這是已知限制，見下。
- 沒有新增 ctx 狀態欄位（`_fapPermCtl` 與 `_subchatPending` 都在 app 實例上），所以不用進 `FA_CHAT_CTX_KEYS`。

### 評估

`scripts/eval/subchat_fap.eval.js`，真桌面版，埠 17969，假 handle（`queryPermission` 回 prompt、`requestPermission` 回 granted），不碰真的檔案系統。最終結果 `allPass: true`（19 項全過）：

- P1 子對話發起讀取授權：waiting_user；權限框有「來自子對話」；連結卡片有「授權」按鈕；父對話打字被拒絕；等 800ms 仍未回答（沒有自動回答）；父對話按「授權」→ 檢查結束、框消失、等待清除、狀態不再 waiting。
- P2 子對話發起讀寫授權，父對話按「拒絕」→ 檢查拋出含「拒絕」的錯誤、等待清除。
- P3 子對話發起授權，使用者直接在權限框按「授權」→ 檢查結束、連結卡片的等待也清除（兩條路一致）。
- P4 父對話自己發起授權：不冒泡（子對話狀態不變、沒有等待記錄）。
- `loadedWorkdirImpl`。

修前（HEAD 源頭重建）：`p1_waitingUser`、`p1_questionShown`、`p1_modalShownFromChild`、`p1_cardHasAllowButton`、`p1_answerOk`、`p1_resolvedOk`、`p1_modalGone`、`p2_denyOk`、`p2_deniedThrows`、`p3_waitingUser`、`p3_modalPathResolves`、`loadedWorkdirImpl` 都是 false，`allPass: false`。修前為 true 的 `p1_typingRejected`（方法不存在而出錯）、`p1_notAutoAnswered`（沒有回答）、`p4_parentNoBubble`（本來就不冒泡，是防回歸的判準）、`p1_bubbleCleared`、`p2_bubbleCleared`、`p3_bubbleClearedByModal`、`p1_notWaitingAfter`，不能算作修正的證據，只是確認沒有誤判。

### 已知限制（照實寫）

- 同一子對話同時有兩件等待（例如一張卡片加一個授權）時，連結卡片只顯示先到的那一件；另一件的框仍在畫面上可以按，但連結卡片上沒有它的按鈕。這種情況子對話的工具呼叫本來就很少同時發生，本次沒有測。
- 「重新整理後的權限等待」見步驟 5（記憶體等待消失）。

## 步驟 5：重新整理後的等待狀態（已驗證）

### 決定（自己決定，理由）

- 選項：(a) 標成 `failed`，原因寫清楚；(b) 保留可重新提問。**採 (a)**。理由：等待中的問題與執行中的一輪都只存在記憶體（卡片的 Promise、表單的 resolve、權限框的 DOM），重新載入後**無法**恢復，所以不可能真的繼續等；(b) 需要重新送出問題，等於替模型重做一次，且可能重複執行有副作用的工具。(a) 是終態但不復活，使用者要繼續，就在父對話的連結卡片傳訊息（`failed` 可由 `start` 離開，會開新一輪；步驟 5 的評估 R4 已驗證）。
- 執行中的一輪（`running`）同樣在重新整理後消失，索引仍寫著 `running`，連結卡片會永遠顯示「進行中」。這不在管理層列的缺口裡，但是同一個機制，照「限制都必須修正」的原則一起修：改成 `failed`，原因「頁面重新整理，這一輪被中斷」。**這是我自己擴大的範圍**，在此明說。

### 改了什麼（源頭 `renderer/src/floating-assistant.js`）

- `_chatListInit`：索引建好（`this._chatIndex = idx`）之後呼叫 `_subchatRecoverAfterReload(idx.chats)`，有修正才 `_saveChatIndex()`。失敗只寫 log，不影響載入。
- `_subchatRecoverAfterReload(chats)`（`_subchatSetStatus` 上方）：只處理有 `parentId` 的子對話；`waiting_user` → `failed`（原因「頁面重新整理，等待中的問題已失效」）；`running` → `failed`（原因「頁面重新整理，這一輪被中斷」）。`done`、`failed` 與根對話不動。回傳修正筆數。
- 連結卡片：載入後索引已是 `failed`，`_subchatLinkInfo` 顯示「失敗：…」，不再是「等你回應」。原本的「等你回應已失效」分支保留（只在同一次執行中出現「等待但記憶體沒有」的情況才會走到，不是重新整理後的主要路徑）。
- 沒有新增 ctx 狀態欄位，不用進 `FA_CHAT_CTX_KEYS`。

### 評估

`scripts/eval/subchat_reload.eval.js`，真桌面版，埠 17970，假 LLM。流程：子對話設成等待（或執行中）→ `await _saveChatIndex()` → 清掉記憶體等待 → 呼叫真正的 `_chatListInit`（開頁面時走的同一條路）→ 檢查。最終結果 `allPass: true`（9 項全過）：

- R1 `waiting_user` → 重新載入後 `failed`，原因正確；父對話連結卡片文字「失敗：頁面重新整理，等待中的問題已失效」，不含「等你回應」。
- R2 `running` → `failed`，原因「頁面重新整理，這一輪被中斷」。
- R3 修正函式不動 `done`、不動沒有父對話的項目（回傳 0）。
- R4 `failed` 的子對話仍可繼續：父對話傳「繼續」→ 模式 `turn` → 最後 `done`。
- `loadedWorkdirImpl`。

修前（HEAD 源頭重建，同一份評估）：`beforeR1: waiting_user` 重新載入後仍是 `waiting_user`，連結卡片顯示「等你回應已失效（重新整理後請到子對話處理）」，`r1_failedAfterReload`、`r1_reasonText`、`r1_linkShowsFailedNotWaiting`、`r1_notSavedAsWaiting`、`r2_failedRunning`、`r3_untouchedDoneAndRoot`、`loadedWorkdirImpl` 都 false，`allPass: false`。這正是管理層指出的「永遠顯示等你回應」的狀態（文字有「已失效」，但狀態本身仍停在 `waiting_user`，側欄也會持續標示等待）。`r4_*` 修前也通過，是防回歸的判準，不是修正證據。

### 評估過程踩到的坑

- 第一次評估（修前與修後）都失敗：`_saveChatIndex()` 回傳 Promise（寫入是非同步的），評估沒有 `await`，重新載入讀到的是舊索引（`done`）。這是**評估**的時序問題，改成 `await` 後重跑。修前的第一次結果因此混了時序問題，所以修前用同一份最新評估重跑一次，上面的數字是這一次的。
- 真實頁面的注意事項：索引存檔是非同步的。使用者在狀態剛改變的那一瞬間重新整理，可能讀到舊狀態（例如還是 `running`，或還是 `waiting_user` 但實際上已在 `done`）。這個小窗口本次沒有處理（不影響正常路徑，要處理的話需要存檔佇列，範圍超出 S4b），照實列為已知限制。

### 已知限制

- 存檔與重新整理之間的競態（見上）。
- 重新整理後，子對話的「卡片」（`_card` 訊息）會留在子對話的歷史裡變成唯讀（S4 已知，本次沒有改）。

## 步驟 6：回歸（已驗證）

真桌面版，工作目錄的最終建置（步驟 5 之後），評估 14 個並行（埠 18001 起）；其中兩個（fap、reload）並行時初始化競態失敗，單獨重跑後通過，以單獨結果為準。

| 評估 | 結果 | 說明 |
|---|---|---|
| `subchat_open` | `allPass: true` | 含開關關閉段（`offNoChild`、`offNoLinkCard`、`offEachTurnOneParentCall`） |
| `subchat_link` | `allPass: true` | 連結卡片、存檔重讀、側欄 |
| `subchat_card_request` | `allPass: true` | 連結卡片不進請求 |
| `subchat_bubble` | `allPass: true` | 卡片等待冒泡（S4 原判準） |
| `subchat_send` | `allPass: true` | 傳訊息（閒置 turn、回應中 steer） |
| `topic_local` | 全部 true | 開關關閉與開啟的呼叫數一致 |
| `chat_tree` | 全部 true | 含 `regression_no_children`、`regression_class_names` |
| `chat_tree_index` | 各欄位符合預期，沒有 false | 沒有內建 `allPass`，人工判讀 |
| `read_ledger` | 數值記錄完整 | **沒有內建判準，只做人工判讀**，沒有與 S3 記錄逐項比對，不算通過 |
| `tool-budget` | `ok: false`，違規 `domain_too_many_tools:skill_…` | **既有問題**：S4 的 commit（`17971890`）重建跑同一評估，也有同類違規（不同技能 ID）。與 S4b 的根層級變動無關（本步驟改的是 `ask_user_card` 的根層級歸類，不是領域工具數）。不在 S4b 範圍，列為既有問題 |
| `subchat_tools` | `allPass: true` | 步驟 2 |
| `subchat_form` | `allPass: true` | 步驟 3（19 項含 F7） |
| `subchat_fap` | `allPass: true`（單獨重跑） | 步驟 4；並行時失敗為初始化競態 |
| `subchat_reload` | `allPass: true`（單獨重跑） | 步驟 5；並行時失敗為初始化競態 |

結論：S4 既有判準全部維持；`subchat_open` 的開關關閉段顯示關閉時三則只在父對話、各一次父對話呼叫，行為不變。

## 總結：S4 缺口的處理結果

- 缺口 5（子對話工具清單不含 `ask_user_card`）：根因是 `ask_user_card` 被歸為 domain-gated，父對話在預設 `full` 模式也不送，子對話與父對話一致地缺它。修為根層級工具。
- 缺口 1（表單）：已冒泡並可在父對話回答（選項、欄位、允許補充的打字）。
- 缺口 2（FAP 權限框）：已冒泡，父對話按「授權／拒絕」才算數，不自動回答、文字不接受，權限框標示來自哪個子對話。
- 下載位置選擇：**沒有冒泡，不是缺口**。它只在使用者點了下載連結才開，模型不等它，子對話不會因此停住。
- 缺口 3（`askBranchChoice`）：S4 文件寫「沒查」。它走 `requestUserForm`，因此已隨表單的冒泡一起處理（表單路徑的 choices／allowSupplement 都適用），但沒有單獨的評估案例。
- 缺口 4（重新整理後）：`waiting_user` 與 `running` 改為 `failed`，原因寫明，父對話不再永遠顯示「等你回應」。

## 未驗證／限制（照實寫）

- 連結卡片上的按鈕**點擊路徑**（表單選項、授權按鈕）只在評估中以程式呼叫 `_subchatAnswerForm`／`_subchatAnswerFap`，或點權限框本身；卡片按鈕的實際點擊沒有單獨驗證，只驗證到按鈕存在、數量正確。
- 存檔與重新整理之間的競態（步驟 5）。
- 同一子對話同時兩件等待時，連結卡片只顯示先到的一件（步驟 4）。
- `read_ledger` 沒有與 S3 記錄逐項比對。
- `tool-budget` 的既有違規未修。

## 教訓

- 步驟 1：`ask_user_card` 被歸為 domain-gated 是分類錯誤，不是子對話的錯。之後遇到「子對話少了某工具」先確認父對話有沒有，不要直接在子對話加。
- 步驟 2：建置會改寫引號與排版，評估判準要用 regex 接受兩種引號，不要寫死單引號字串。一開始 `loadedWorkdirImpl` 因此誤判成 false，不是載入錯檔；修判準後重跑才通過。

---

## 原檔：subchat-s5

# 子對話 S5：拉回舊話題、`@對話名稱`、父對話的子對話工具

> 範圍：只做 `DESIGN.TODO.chat-subsessions.md` 第 10.2 節的 S5（步驟 1–3）與回歸（步驟 4）。S6（遠端統一）、S7（批次刪除）不做。
> `ask_user_card` 的根層級歸類（`d12293d1`）沒有改、沒有依賴。
> 行號以 2026-11-04 的主檔 `renderer/src/floating-assistant.js` 為準（編輯來源；`renderer/floating-assistant*.js` 是建置產物，沒有提交）。

## 使用者的決定（照 `chat-subsessions.md` 第 10 節）

- 拉回舊話題只載摘要，不整段載回。
- 父對話可以透過自己跟子對話溝通，也可以直接插給子對話。
- `@對話名稱` 讓父對話知道指的是誰；標記時遠端對話要含節點名稱。

## 步驟 1：拉回舊話題（commit `4df50ae1`）

### 做法

- `_localTopicCheck`（主檔 96019）的候選：舊話題（`topicData.pastTopics`）加上**父對話底下的子對話**（`_subchatChildCandidates`，主檔 96052，候選 id＝子對話 id）。
- 命中子對話（`toChild`，主檔 96029）時：父對話的目前話題**不變**（子對話的話題不算父對話的話題），`_lastTopicShift.toChild = true`。
- 命中父對話自己的舊話題：照舊（父對話處理）。
- 找不到（子對話已刪除，候選裡沒有）→ 當全新話題，開新子對話。
- `_subchatPullback`（主檔 96306）：訊息轉給那個子對話（沿用 `_subchatSend`，子對話正在回應時走既有插話、閒置時開新一輪），更新子對話的指紋，父對話只留使用者訊息＋卡片「↳ 回到子對話：〈標題〉」，不呼叫父模型，不把子對話歷史載回父對話。
- 開新子對話（`_subchatOpenFor`，主檔 96328）成功後，父對話話題還原：把 `_localTopicCheck` 剛推進 `pastTopics` 的那一筆移掉，`fingerprint` 還原成 `prevFingerprint`。原因：沒有還原的話，子對話的話題會變成父對話的話題，下一則就會判到錯的地方（見下方教訓）。

### 評估

`scripts/eval/subchat_pullback.eval.js`，真桌面版，換埠 17963，假 LLM。

- 修前（`4df50ae1` 之前的建置）：13 項中 6 項失敗（`pullbackChildGotOneRound`、`pullbackParentNoModelCall`、`pullbackChildModelCalled`、`pullbackParentLinkCardText`、`afterDeleteNewChildB`、`loadedWorkdirImpl`）。修前的事件序列：第四則被父對話處理（父模型 1 次），第五則也沒開新子對話。
- 修後：13 項全過。事件序列：`main_chat` → `child`（開 A）→ `main_chat`（貓，仍在父對話）→ `child`（拉回 A）→ `child`（刪 A 後開 B）。

### 案例句子的調整（照實寫）

- 第一版第五則用「來一首音樂的歌」，結果沒開新子對話。原因：S2 既有的延續句規則（`topic_local.js` 的 `CONTINUATION_RE`）把「來」開頭判成延續，不轉移。這不是 S5 的錯，判準沒有改，只把案例句子換成「幫我寫一首搖滾音樂的歌」。

### 行為上要知道的事

- 在 S3 之後，每個新話題都開子對話，所以父對話的 `pastTopics` 幾乎不會再有項目（只有開子對話失敗時才會留）。`matchedTopicId` 命中父對話舊話題的路徑（a）因此很少走到，保留是為了與 S2 行為相容。
- 「第三則回到畫貓」在這個設計下是「同一話題」（父對話的目前話題仍是貓），不是「拉回」，因為貓不是被推出去的話題。評估的判準是「父對話處理、沒有新子對話」，兩種路徑都符合。

## 步驟 2：`@對話名稱`（commit `8979cb2c`）

- `_mentionMenuInit`（主檔 100529）：輸入 `@` 出現自動完成（`AiChatTree.listMentionCandidates`，本機在前，名稱含空白用 `@[…]`）。選取用 Enter／Tab，移動用 Up／Down，Escape 關閉。監聽放在 document 捕捉階段，選取時先於送出處理，所以選取時不會送出。掛在 `_wireSlashCommandMenu`（主檔 108576，呼叫點 108683）。
- `_mentionPrepare`（主檔 100504）：送出時用 `resolveMention` 解析，回傳 `{blocked, message, hint}`。
  - 同名或遠端只用對話名（歧義）→ `blocked`，不送出，輸入框保留原文，狀態列提示補完整名稱。
  - 找到 → `hint`：「`[提及對話] 使用者提到對話〈名稱〉(id=…,節點=…,狀態=…,摘要:…)`」，以隱藏的 system 訊息（`_mentionHint: true`）送進 `this.messages`，只給模型看。
  - 找不到 → 當一般文字，沒有提示。
- `_submitChatInput`（主檔 100590，`_mentionPrepare` 呼叫點 100599）：每次送出先移掉上一則的提示，所以提示只活一輪。使用者看到的文字一律不變。
- 渲染：system 訊息的開頭不在白名單內，所以是 `hidden-system`（主檔 107172）。

### 評估

`scripts/eval/chat_mention.eval.js`，換埠 17964，假 LLM。

- 修前：`acShowsOnAt`、`acLocalFirst`、`acEnterInsertsName`、`acBracketInsertForSpace`、`sendHintInRequest`、`ambiguousNotSent` 失敗（6 項）。`notFoundSentAsPlain`、`sendVisibleTextUnchanged`、`notFoundNoHintInReq` 本來就成立（不改原文、找不到不加提示）。
- 修後：11 項全過。

## 步驟 3：父對話的子對話工具（commit `cb2aad8a`）

- 註冊（主檔 61087、61095、61107）：`chat_list_children`、`chat_send_to_child`（`{chat_id, message}`）、`chat_get_child_summary`（`{chat_id}`）。描述都寫「只在已經有子對話時有用」。
- 過濾（主檔 74793 `_subchatToolFilter`）：`_getRootToolNames`（主檔 74812）三個回傳點都套用。目前對話沒有子對話 → 三個工具從清單拿掉，清單與之前完全相同。
- 目標檢查（主檔 74802 `_subchatToolTarget`）：只能操作本機、且 `parentId` 是目前對話的子對話。非子對話 → `這不是目前對話的子對話`；遠端（`nodeName` 有值）→ `遠端對話不能用這個工具…`。
- `chat_send_to_child` 回傳 `{ok, mode, status}`，`mode` 是 `turn`（閒置，開新一輪）或 `steer`（子對話正在回應，走插話）。

### 評估

`scripts/eval/subchat_tools_ai.eval.js`，換埠 17965，假 LLM。

- 修前：6 項失敗（工具不存在）。沒有子對話時的工具清單校驗值 `count 6, hash 935053194`（這是之後的回歸基準）。
- 修後：10 項全過。沒有子對話時的校驗值仍是 `count 6, hash 935053194`（與基準相同）；有子對話時 `count 9`。
- 假模型呼叫 `chat_send_to_child` → 子對話多一輪（使用者訊息「補充：用水彩風格」進子對話）、工具結果 `{"ok":true,"mode":"turn",...}`。

## 步驟 4：回歸

真桌面版，建置為步驟 3 之後的工作目錄（`cb2aad8a`）。

| 評估 | 結果 | 說明 |
|---|---|---|
| `topic_local` | `allPass: true`（13 項） | 第一次跑 2 項失敗（見下），判準修正後全過 |
| `chat_tree` | 全部 true（21 個布林值） | 沒有 `allPass` 欄位，人工確認沒有 false |
| `chat_tree_index` | 全部 true（8 個），false 0 個 | 沒有 `allPass` 欄位 |
| `read_ledger` | 沒有內建判準，人工判讀 | 3 個 false 都是「沒有下一頁／沒有警告」，正常值。`renderer/src/agent/read_ledger.test.js` 12 項通過 |
| `subchat_open` | `allPass: true` | |
| `subchat_link` | `allPass: true` | |
| `subchat_card_request` | `allPass: true` | |
| `subchat_bubble` | `allPass: true` | |
| `subchat_send` | `allPass: true` | |
| `subchat_tools` | `allPass: true` | 第一次跑 `sameNameSet` 失敗，判準修正後全過（見下） |
| `subchat_form` | `allPass: true` | |
| `subchat_fap` | `allPass: true` | |
| `subchat_reload` | `allPass: true` | |
| `subchat_pullback`（新） | `allPass: true`（13 項） | 步驟 1 |
| `chat_mention`（新） | `allPass: true`（11 項） | 步驟 2 |
| `subchat_tools_ai`（新） | `allPass: true`（10 項） | 步驟 3 |
| `tool-budget` | `ok: false`，1 筆 `domain_too_many_tools:skill_54f871ce-…` | 與 S4b 文件記錄的一筆同類既有違規相同（S4b 那次 skill ID 不同，所以這裡只說「同類」）。我的三個工具是根層級工具，不計入領域工具數。**沒有在改動前後各跑一次比對**，所以這個「沒有增加」是依文件記錄與工具性質推論，不是量測結果 |

### 第一次跑失敗、判準修正的兩處（都是 S5 有意的改變，不是放寬）

1. **`topic_local` 第四則**：原本預期「命中舊話題」（`matchedTopicId` 有值、`isShifted: true`），改成「同一話題」（`isShifted: false`，原因 `same-topic`）。原因：步驟 1 讓開出子對話後父話題還原成貓，所以「再畫一張狗的圖」是父對話目前話題的延續，不再是被推出去的舊話題。結果不變：不轉移、不開新子對話、沒有摘要。判準名稱由 `onMatchedOnReturn` 改為 `onReturnStaysInParent`。
2. **`subchat_tools` 的 `sameNameSet`**：原本要求父與子的工具名稱完全相同。S5 起父對話多出三個子對話工具，子對話沒有（子對話不再有子對話）。判準改為「父扣掉三個後等於子清單，且三個只出現在父對話」。

### 沒有子對話時的工具清單（步驟 3 的回歸）

`subchat_tools_ai.eval.js` 記錄的校驗值：沒有子對話時 `count 6, hash 935053194`，修前後相同。有子對話時 `count 9`。

## 驗證範圍（誠實列出）

- 真桌面版驗證過：步驟 1–3 的三個評估（修前、修後）與回歸（見下）。
- 沒有驗證：真實使用者訊息上的拉回誤判率（門檻沿用 S2，只用案例校準）。
- 沒有驗證：`@` 自動完成的實際畫面位置與手機寬度（只驗證 DOM 與送出行為）。
- 沒有驗證：`hidden-system` 的提示在畫面上確實不顯示（只讀渲染程式的判準，沒有截圖）。
- 沒有做：S6（遠端統一，遠端 `@` 與遠端子對話工具都還不支援）、S7（批次刪除）。

## 教訓

1. **子對話開出後，不能把子對話的話題留在父對話身上。** 第一次做拉回時沒有還原父對話話題，`pastTopics` 裡的音樂話題變成父對話的候選，第五則「幫我寫一首搖滾音樂的歌」被父對話接走，沒開新子對話。下次只要「建立子對話」這件事會動到父對話的狀態，就要列出父對話的狀態欄位（`topicData.fingerprint`、`pastTopics`、`_lastTopicShift`）逐一確認。
2. **評估的句子要先排除既有規則。** 「來一首音樂的歌」被延續句規則吃掉（S2 的 `CONTINUATION_RE`），看起來像拉回壞掉。先用 `detectShift` 的 `reason` 看是哪一條規則，再決定是改句子還是改判準。這次只改句子。
3. **來源檢查的判準只能看函式本體。** 寫在方法上方的註解不在 `String(fn)` 裡，`loadedWorkdirImpl` 因此誤判成 false。判準要用本體裡的字串常值（例如工具名稱）。
4. **工具清單的過濾要在 `_getRootToolNames` 的每個回傳點都套用**（`off`、`intent`、預設三條路徑）。只改預設路徑，`off` 模式下新工具就會一直出現。
6. **回歸紅燈先查是哪個判準、為什麼。** 這次兩個舊評估變紅（`topic_local`、`subchat_tools`），都是 S5 的有意改變造成的；判準的修正寫在評估檔的註解與本文件的回歸段落。下次若要改判準，先確認結果的「使用者看得到的部分」（開不開子對話、有沒有摘要、父模型呼叫數）是否不變，只有內部原因字串改變才改判準。
7. **沒有子對話時工具清單要能用校驗值證明沒有變。** 這次用「名稱數量＋字元碼總和」當校驗值，修前後數字相同即可，比逐字比對清單簡單，而且能寫進文件。

---

## 原檔：subchat-s6

# 子對話 S6：遠端需求統一成子對話

> 範圍：只做 `DESIGN.TODO.chat-subsessions.md` 第 10.2 節的 S6。**S7（批次刪除）不做。**
> `ask_user_card` 的根層級歸類（`d12293d1`，S4b）沒有改、沒有依賴。
> 行號以 2026-11-04 的來源為準：主檔 `renderer/src/floating-assistant.js`（編輯來源；`renderer/floating-assistant*.js` 是建置產物，不提交）與 `renderer/src/remote/rg_dispatch.js`。

## 使用者的決定（照 `chat-subsessions.md` 第 10 節，逐字）

- 第 6 點：「統一」（遠端需求與子對話統一成同一種子對話）。
- 第 5 點：「因為我們有remote，標記對話名稱時，要包含節點名稱」。

管理層的設計決定（本階段依此實作）：遠端需求沒有「發出它的本機父對話」，所以建立**虛擬的收件對話**當父對話，每個來源節點一個，標題「遠端需求 · 〈節點名〉」，索引欄位 `kind:'remote-inbox'`、`nodeName`。

## 步驟 1：定位（本文件）

### 1.1 行號對照

`rg_dispatch.js` 與主檔內嵌的同一段程式行號差 **52898**（例如 `rg_dispatch.js:580` ↔ 主檔 `53478`，已 Grep 驗證；`rg_dispatch.js:533` ↔ 主檔 `53431`）。以下以主檔為準，括號內是 `rg_dispatch.js` 行號。

**注意**：舊的交接文字寫「`remote/rg_dispatch.js:822` 是遠端需求建立對話」，**不對**。`rg_dispatch.js:822` 其實是「分享對話的接著對話」`_rgOnChatSay` 裡的 `executeChat('[來自 … 的遠端訊息]…')`（主檔 53720）。真正建立遠端需求對話的是 `rg_dispatch.js:580–581`（主檔 53478–53479）。

### 1.2 建立遠端需求對話的全部路徑

| # | 位置 | 做什麼 | 寫入的欄位 | 備註 |
|---|---|---|---|---|
| A | 主檔 `_rgRunTask` 約 53431（rg 533） | `job.chatCtx = await this._rgCreateRemoteChat(job)`，之後 `_setRespondingState(true, '⏳ 遠端需求…')` | — | 這是「收到需求」的入口；`job.sub` 為真（子任務）直接不建對話（53474） |
| B | 主檔 `_rgCreateRemoteChat` 53473–53486（rg 575–588） | **唯一建立路徑**：`_chatNewId('c')`、`_chatIndex.chats.push({…})`，`_chatCtxNew` + `_chatCtxs.set`，寫第一則記錄，再 `user` 訊息＝需求原文，`_persistChatHistory`，`_renderChatList`，`_saveChatIndex`，`_rgPushChats` | 索引：`id, title('來自 〈來源〉：…'), groupId:null, createdAt, updatedAt, touched:true, shared:true, nodeName:job.fromName, remote:{fromName, fromId, taskId, at, fp}` | **不經過 `_chatNew`**：直接 push 索引，所以沒有 `parentId`、`status`、`topicId`、`fingerprint`、`summary` 欄位（只有 S1 補齊 null） |
| C | 主檔 53476（rg 578） | 嵌入式網頁版（`!this._chatListEnabled` 等）：不建對話，`job.chatInline = true`，結果回來用 `_rgRecordInline` 包成可展開的 `<details>` 框記在目前對話 | — | 這條路徑**保持不變**（沒有對話清單，不能有收件對話） |
| D | 主檔 `_rgRecordInline` 53520–53531 | 同上 C，把整份結果包成 `<details>` | — | 不動 |
| E | 主檔 `_rgChatRecord` 53487–53501（rg 589–603） | 結果回來寫進 `job.chatCtx` 那個對話（完成／停止／失敗） | 會更新 `en.updatedAt` | 這裡的 `run._setRespondingState(false, '', 'completed'|'stopped')` 會決定 `status` 的終態，S6 要把它改成同時更新子對話的 `status` |
| F | 主檔 `_rgLoadPending` 53542–53551 | 重新載入後接續等待中的任務：`p.chatId` 有效就用那個對話的 ctx | — | 子對話化後 `chatId` 會是子對話 id，行為相同 |

**沒有其他地方建立遠端對話**（Grep `_chatIndex\.chats\.push` 與 `_chatNewId\(` 全檔）：只有 `_chatNew`（79800）、`_chatListInit` 補預設對話（79667、79676）、清單空白補一個（79846–79847）、群組（79877）、以及 B。

### 1.3 讀取 `remote` 欄位的地方（Grep `\.remote\b`、`fromName`，精準搜尋）

| 位置 | 讀什麼 | 依賴「遠端對話是一般根對話」？ |
|---|---|---|
| 主檔 79972 `_renderChatList`／`chatEl` | `c.remote ? '🌐 '` 前綴、`t.title` tooltip 讀 `c.remote.fromName`、`c.remote.at` | **是**：顯示的前綴與 tooltip 直接讀 `c.remote`。子對話化後，子對話列要保留「🌐」與來源，但父層（收件對話）不應有 `remote`。要改成依 `nodeName` 或子對話 `remote` 判斷 |
| 主檔 80112 右鍵選單 | `entry.remote` → 文字「📡 取消分享（遠端需求對話）」 | 是（只影響文字） |
| 主檔 100545 `row.textContent = it.label + (it.remote ? '（遠端）' : '')` | `@` 自動完成的候選列（`it` 來自 `listMentionCandidates`，不是 `c.remote`） | 不是讀 `c.remote`，是讀 `chat_tree` 的 `remote` 布林（`candidateOf`，`chat_tree.js:177`） |
| 主檔 `chat_tree.js:148` `isRemoteChat` | 讀 **`nodeName`**，不讀 `remote` | 不依賴 `remote`；但會把 `nodeName ≠ selfNodeName` 的對話當遠端（`selfNodeName` 目前沒有被傳入，見 1.5） |
| 主檔 `_rgSharedList` 53574–53577 | 只挑 `c.shared` 的對話送給群組（`chats` 訊息）；遠端需求對話 `shared:true`，所以會被分享出去 | 是：收件對話若不設 `shared`，就不會被分享；子對話要分享與否要想清楚（見 1.6） |
| 主檔 `_rgOnChatSay` rg 804 | 接著對話要求 `en.shared` | 同上 |
| 主檔 `_chatNew` 79806 | `opts.nodeName` 寫入索引（S1 已有） | 已存在，S6 直接沿用 |
| `renderer/src/chat/chat_tree.test.js:11,18` | 測試 `remote:{fromName:'X'}` → 遷移後 `nodeName` 為 null | 測試固定了「舊格式 `remote` 不會自動變 `nodeName`」，S6 要改這個行為時要同步改測試（見步驟 2） |

### 1.4 依賴「遠端對話是一般根對話」的地方（清單）

1. **側欄**：`flattenTree` 把沒有 `parentId` 的當根（`chat_tree.js` 107–135）。舊遠端對話（有 `remote`、沒有 `parentId`）目前全部是根，會平鋪在側欄。S6 要在載入時遷移（`migrateRemoteChats`，步驟 2）。
2. **`_renderChatList` 的 sig**（79953）只看 `c.parentId`，遷移後要重算（會自動，因為 sig 含 `parentId`）。
3. **`@` 解析**：`resolveMention` 的 `isRemoteChat` 讀 `nodeName`。舊遠端對話有 `remote` 但沒有 `nodeName` 時，**不會**被當遠端（`nodeName` 為 null）。所以 `migrateRemoteChats` 要用 `remote.fromName` 補 `nodeName`（使用者的決定與步驟 2 都要求這個）。
4. **`_subchatChildCandidates`**（96052）：只找 `c.parentId === 目前對話`。遠端子對話掛在收件對話底下，所以當收件對話是「目前對話」時候選是子對話，但收件對話**不呼叫模型**（管理層決定），不會走到話題判斷。
5. **`_subchatToolTarget`**（74802–74807）：`e.nodeName` 有值 → 回「遠端對話不能用這個工具（遠端子對話之後的版本才支援）」。S6 要決定：遠端子對話是否允許 `chat_send_to_child`。**建議保留拒絕**（遠端子對話的訊息要經過群組傳輸，不在 S6 範圍）；寫進步驟 4 的已知缺口。
6. **`_rgCreateRemoteChat` 的 `touched:true`、`shared:true`**：收件對話與子對話是否要 `shared`，見 1.6。
7. **`_chatCtxPrune`**（79736）、`_chatActivate`（79745）：收件對話沒有 ctx 也能被切換嗎？`_chatSwitch` 會 `_chatCtxLoad(id)`，收件對話有 id 就能建 ctx，但它沒有訊息；步驟 3 要讓收件對話開啟時只顯示說明卡片與子對話連結卡片（不是空白）。
8. **`_chatDelete`**（79820）：刪父對話時子對話目前怎麼處理（S1–S5 已有行為，沒改）。收件對話被刪會孤立子對話（S1 規則：孤兒提升為根，`chat_tree.js` 14）。這是已知行為，S6 不改。
9. **`_rgPushChats`／群組分享**：群組其他成員看到的是 `shared` 對話清單（53574）。收件對話不應該出現在別人的清單裡（它沒有內容）。**建議：收件對話 `shared:false`，子對話 `shared:true`**（與目前「每個遠端需求對話都 shared」的行為一致）。待確認項：子對話的 `parentId` 會不會讓別人端的清單顯示錯，見步驟 3 的檢查。

### 1.5 `selfNodeName` 的來源（先查清楚，不確定的明說）

`chat_tree.js` 的 `isRemoteChat(c, selfNodeName)` 需要「本機節點名」。Grep 主檔 `resolveMention(` 與 `listMentionCandidates(` 的呼叫點：`_mentionPrepare`（100504 附近）與 `_mentionMenuInit`（100529 附近）。**沒查**這兩處傳進去的 `selfNodeName` 是哪個值（是 `rg.room.self.name` 還是空字串）。若是空字串，`isRemoteChat` 會把所有 `nodeName` 非空的對話都當遠端，這對本機對話（沒有 `nodeName`）沒有影響。**步驟 4 要先查這個值**。

### 1.6 嵌入的網頁版與 `_chatListEnabled`

主檔 53476 的判斷 `!this._chatListEnabled || !this._chatIndex || !this._chatListReady`：沒有對話清單（嵌入網頁版）時走 C／D 的 `<details>` 路徑。**S6 不改這條路徑**，所以嵌入網頁版的行為不變（符合使用者「不要動」的範圍）。是否能在評估裡跑到這條路徑：**沒驗證**，若要驗證要用沒有對話清單的建置，列為步驟 3 的缺口。

## 2. 現在的資料流（摘要）

```
rg_dispatch 收到 task(sub=false)
  → _rgRunTask（主檔 ~53431）
     → _rgCreateRemoteChat（主檔 53473）
          push 索引 {nodeName, remote:{…}, shared:true}   ← 平的根對話
          _chatCtxNew + user 訊息（需求原文）
     → 執行（_runSubAgentTask 或 _rgRunSlash）
  → _rgChatRecord（主檔 53487）
     → 寫結果、_setRespondingState(false, …, 'completed'|'stopped')
```

## 3. S6 的目標資料流（管理層決定）

```
rg 收到 task(sub=false, fromName=N)
  → 找或建「收件對話」：索引 {kind:'remote-inbox', nodeName:N, title:'遠端需求 · N', parentId:null, shared:false}
  → _chatNew(null, {parentId: 收件id, nodeName: N, status:'running', …})   ← 子對話
  → 第一則訊息＝來源記錄＋需求原文（與現在相同）
  → 執行、_rgChatRecord 寫結果，status 照 S4 狀態模型更新（done／failed）
  → 等使用者回應時，連結卡片冒泡到收件對話（沿用 S4／S4b 的 _subchatAnswer）
```

## 4. 路徑清單與驗證方式

| 路徑 | S6 怎麼處理 | 能否在評估跑 | 備註 |
|---|---|---|---|
| A、B（建立） | 改成收件對話＋子對話 | 能（假 LLM 不需要真的遠端；要模擬 `_rgCreateRemoteChat` 的呼叫） | 步驟 3 評估 |
| C、D（嵌入網頁版） | **不改** | **沒驗證**（需要沒有對話清單的建置，本次不做） | 列為缺口 |
| E（結果回寫） | 加上子對話 `status` 更新 | 能（評估檢查 `status`） | 步驟 3 |
| F（重新載入接續） | 不改（`chatId` 指向子對話即可） | 沒驗證 | 列為缺口 |
| 遷移（舊 `remote` 欄位） | 新增 `migrateRemoteChats` | 能（純函式 node 測試＋評估的舊格式索引） | 步驟 2、3 |

## 5. 步驟 2：純函式（已完成）

- 模組：`renderer/src/chat/remote_inbox.js`（UMD，同 `chat_tree.js`）。測試：`renderer/src/chat/remote_inbox.test.js`，16 項，`node renderer/src/chat/remote_inbox.test.js` 全過。
- 函式：`inboxIdFor`、`findInbox`、`makeInboxEntry`、`ensureInbox`（只建一次，回傳新陣列不改原陣列）、`attachRemoteChild`（回傳 `parentId`、`nodeName`、已確保存在的 `chats`、`created`）、`migrateRemoteChats`（只處理有 `remote` 欄位、沒有 `parentId` 的對話；節點名先用 `nodeName`，沒有才用 `remote.fromName`；只補 `parentId` 與缺的 `nodeName`；冪等）。
- 既有 `chat_tree.test.js` 仍全過（22 項）。`chat_tree.test.js:18` 測的是 `normalizeChatEntry` 不改 `nodeName`，本步驟沒改那個函式，所以不衝突。
- **尚未嵌入主檔**（`scripts/embed-code-ui.js` 還沒加 `REMOTEINBOX-BEGIN/END`，主檔還沒有 `FA_REMOTE_INBOX_SRC`）。這是步驟 3 的事。
- 收件對話索引欄位：`kind:'remote-inbox'`、`nodeName`、`parentId:null`、`shared:false`、`status:null`、`touched:true`。

### 步驟 2 的教訓

- **還沒到 30% 就回報「需要接手」，錯在把「這一輪做不完」當成交接理由。** 下次怎麼做：未到 30% 一律繼續做完全部步驟；交接只在上下文真的到 30% 時才做。

- 測試裡每次呼叫都建新的 id 產生器，同一次測試內會得到重複 id（`in1`），測試就紅了。同一個測試的多次呼叫要共用一個產生器。

## 6. 步驟 3 起的待辦（交接用）

1. `scripts/embed-code-ui.js`：加 `embed('renderer/src/chat/remote_inbox.js', 'REMOTEINBOX-BEGIN', 'REMOTEINBOX-END', 'FA_REMOTE_INBOX_SRC')`（參照 `chat_tree.js` 66–67 行的寫法）；`scripts/build-web-lazy.js` 的 EXCLUDE 要查（`chat_tree` 的 `CHATTREE` 是否已在 EXCLUDE，照它的做法）。
2. 主檔：在 `_chatTreeMod()`（79527）旁加 `_remoteInboxMod()`（同 79528 的 `new Function` 寫法）。
3. 改 `_rgCreateRemoteChat`（主檔 53473–53486）：用 `ensureInbox` 找或建收件對話（建立要 `this._chatIndex.chats` 寫回並存檔），再用 `_chatNew`（79783）的 `opts.parentId`／`opts.nodeName`／`opts.status`／`opts.summary`／`opts.fingerprint`（已存在，79802–79806）或同等的 push 建子對話；第一則訊息與來源記錄保持原樣；子對話的 `remote` 欄位保留（側欄前綴 79972 讀它）。注意 `_chatNew` 會 `_chatActivate`，遠端收到需求時**不能**切走使用者的畫面，要用 `noActivate:true`。
4. 載入索引時（`_chatListInit` 79673–79674 之後）呼叫 `migrateRemoteChats`，寫入 `idx.chats`。
5. `FA_CHAT_CTX_KEYS`（51009 起）：S6 目前沒有新增 ctx 狀態欄位，若新增要進去並查重設點。
6. 評估：`scripts/eval/subchat_remote.eval.js`（新檔），參照 `scripts/eval/subchat_pullback.eval.js` 的寫法（真 Electron、換埠、假 LLM）。先證明修前不成立（修前：遠端需求是根對話、沒有收件對話）。

## 6.5 步驟 3：接進建立路徑（已完成，真桌面版驗證過）

改動（照 6 節待辦）：

- `scripts/embed-code-ui.js`：新增 `embed('renderer/src/chat/remote_inbox.js', 'REMOTEINBOX-BEGIN', 'REMOTEINBOX-END', 'FA_REMOTE_INBOX_SRC')`。主檔 `renderer/src/floating-assistant.js` 在 `SUBCHATSTATUS-END` 後面放了標記區塊（先放空字串，嵌入後自動填入）。
- `scripts/build-web-lazy.js`：EXCLUDE 加 `REMOTEINBOX`（與 `CHATTREE` 相同，留在網頁版核心，因為遠端需求邏輯在核心）。
- `renderer/src/floating-assistant.js`：
  - `_remoteInboxMod()`（`_chatTreeMod` 旁，用 `new Function` 載入 `FA_REMOTE_INBOX_SRC`）。
  - `_chatListInit`：`normalizeChats` 之後呼叫 `migrateRemoteChats`（載入時遷移舊索引，之後由 `_saveChatIndex` 寫回）。
- `renderer/src/remote/rg_dispatch.js`（來源；主檔的 REMOTE 區塊由 `embed-code-ui.js` 內嵌）：
  - `_rgCreateRemoteChat`：`ensureInbox` 找或建來源節點的收件對話（只建一次，不切換畫面、不呼叫模型）；子對話寫入 `parentId`、`nodeName`、`status:null`，之後 `_subchatSetStatus(id,'start')`。第一則訊息與來源記錄不變。
  - `_rgChatRecord`：結果回寫時，子對話狀態 done→`finish`，failed／rejected→`error`（原因＝錯誤字串），stopped→`error`（原因「已停止」）。
- `scripts/eval/subchat_remote.eval.js`（新檔）：模擬兩個節點各一需求再加一個，以及舊格式索引遷移。

建置：`node scripts/embed-code-ui.js && node build-assistant.js`（後者會連帶跑 `build-web-lazy`，產生的 `web-lazy/*`、`renderer/floating-assistant*.js`、`update-manifest.json` 都**沒有提交**）。建置前的備份在 scratchpad `bak/`。

### 評估結果（真桌面版，換埠 17966 修後／17967 修前，假 LLM）

- 修後：`allPass: true`，20 項全過。事實：收件對話 2 個（B機、C機）；B機 2 個子對話（標題「來自 B機：寫一首詩」「來自 B機：寫一首短歌」）、C機 1 個；子對話 `status` 全為 `done`；建立時 `currentId` 不變；沒有模型呼叫；側欄收件對話列 `childCount:2`、收合時子對話不出現在扁平清單；舊格式 `D機` 遠端對話遷移後 `parentId` 指向 D機收件對話、`remote` 欄位不變。
- 修前（建置前的 `renderer/floating-assistant.js` 備份）：`allPass: false`，多數判準失敗（`hasRemoteInboxMod`、`inboxOnePerNode`、`noRootRemoteChats`、`sidebarDomHasInbox`、`migrateOldRemoteUnderInbox`、`loadedWorkdirImpl` 等）。
- **空真注意**：修前 `childNodeName`、`childStatusDone` 為真，原因是修前沒有任何子對話，`every` 在空陣列上為真。這兩項在修前沒有證明力，修後的結果才是有效證據。

### 步驟 3 沒有驗證的

- 沒有真的遠端節點對真的需求（用 `_rgCreateRemoteChat`／`_rgChatRecord` 模擬 `_rgRunTask` 的兩個呼叫）。
- 沒有經過 `_rgRunTask` 的完整流程（排隊、閘門、執行）。
- 嵌入式網頁版路徑（沒有對話清單，走 `_rgRecordInline`）沒有驗證，行為理論上未變（程式未改），但沒有證據。
- 收件對話被點開時的畫面（目前會顯示一般空對話的建議卡片）是步驟 4 的工作，尚未處理。

## 6.6 步驟 4：冒泡與 `@`（已完成，真桌面版驗證過）

改動：

- `renderer/src/remote/rg_dispatch.js`：`_rgCreateRemoteChat` 建立子對話後，呼叫 `_remoteInboxLink(inboxId, childId, title)`（連結卡片進收件對話）。
- `renderer/src/floating-assistant.js`：
  - `_remoteInboxLink`（`_remoteInboxMod` 旁）：收件對話第一次建立時放一則說明卡片；每個子對話放一張 `_subchatLink` 連結卡片（沿用 S3 的形狀）。收件對話 ctx 用 `_chatCtxLoad` 載入，存檔後若目前正在看就重畫。
  - `executeChat` 開頭守衛：目前對話是 `kind:'remote-inbox'` 就只提示「這是遠端需求的收件對話，不能在這裡直接對話…」，**不送出、不呼叫模型**。
- 子對話等待使用者（表單）的冒泡沿用 S4：`_subchatAskForm` 以 `isChild`（`parentId`）判斷，遠端子對話因為有 `parentId` 自動走這條路，不需要新程式。
- `@`：`_mentionPrepare` 已經用 `resolveMention(chats, tok, '')`，遠端子對話（有 `nodeName`）以 `節點名/對話名` 比對，S6 不需要改解析。

評估：`scripts/eval/subchat_remote_bubble.eval.js`（新檔，換埠 17968 修後、17969 修前，假 LLM）。

- 修後：`allPass: true`，13 項全過。事實：子對話 `waiting_user`；收件對話的連結卡片 `canAnswer: true`、`pending: 'form'`；打字回答被拒（只有選項）；按選項回答後子對話離開等待、pending 清除；`@[B機/來自 B機：畫一張貓]` 解析到子對話且提示含 `id=…,節點=B機`；只寫對話名的 `@[…]` 要求補節點名；收件對話打字不呼叫模型，顯示提示；收件對話畫面有連結卡片 DOM。
- 修前（建置前備份）：`allPass: false`。失敗：`childWaitingUser`、`inboxHasLinkCard`、`inboxCardCanAnswer`、`loadedWorkdirImpl`、`inboxShowsLinkDom`、`inboxNoModelCall`、`inboxNoticeShown`（修前沒有收件對話，這些都不成立）。
- **不是 S6 新能力的判準**：`typedRejectedForChoiceOnly`、`answerResolvedForm`、`childLeftWaiting`、`pendingCleared`、`mentionAutocompleteFindsRemoteChild`、`mentionResolvesRemoteChild`、`mentionBareNeedsNode` 在修前也通過。原因：這些是 S4 與 S1 既有的行為，修前的遠端需求對話本來就有 `nodeName`、本來就能被 `@` 解析、表單本來就能在任何對話 ctx 上等待。所以它們證明的是「S6 之後沒有壞掉」，不是「S6 做好了」。

### 步驟 4 沒有驗證的（缺口）

- 權限框（`fap`）與「問題卡片」（`ask_user_card` 的文字問題）在遠端子對話上的冒泡：評估只跑了表單（`choices`）。權限框與問題卡片的程式路徑與表單共用 `_subchatLinkInfo`，但沒有實際跑過。
- 收件對話的連結卡片數量很多時的捲動與收合：沒有驗證。
- 標題格式：遠端子對話標題仍是「來自 B機：〈需求前 22 字〉」（與 S6 前相同）。因為標題含空白與冒號，`@` 必須用方括號 `@[B機/來自 B機：…]`，手打不方便。**這是已知的可用性缺口**，改標題格式要先問使用者（會改變側欄顯示），本步驟沒改。
- `@` 候選會包含收件對話本身（`B機/遠端需求 · B機`）。收件對話不接受直接對話，所以這個候選送出後會被守衛擋下。是否要從候選移除，本步驟沒改，列為缺口。
- 遠端子對話的 `chat_send_to_child`（父對話工具）仍然拒絕遠端子對話（S5 規則，`_subchatToolTarget` 的「遠端對話不能用這個工具」）。是否支援遠端子對話的工具，留給之後，列為缺口。

## 6.7 步驟 5：回歸（已完成）

真桌面版，建置為步驟 4 之後的工作目錄（`8bfc3a8e`）。預設 `topicShiftCheck` 為 false（評估檔沒有改它）。

| 評估 | 結果 | 說明 |
|---|---|---|
| `topic_local` | allPass true | |
| `chat_tree` | 21 個布林全為 true，0 個 false | 沒有 `allPass` 欄位，人工判讀 |
| `chat_tree_index` | 全部 true（修正判準後，見下） | 第一次跑 `new_fields_filled` 為 false，原因見下 |
| `read_ledger` | 沒有內建判準，人工判讀 | 見下 |
| `subchat_open`、`subchat_link`、`subchat_card_request`、`subchat_bubble`、`subchat_send`、`subchat_tools`、`subchat_form`、`subchat_fap`、`subchat_reload`、`subchat_pullback`、`chat_mention`、`subchat_tools_ai` | allPass true | |
| `subchat_remote`（S6 步驟 3） | allPass true | |
| `subchat_remote_bubble`（S6 步驟 4） | allPass true | |
| `tool-budget` | `ok: false`，1 筆 `domain_too_many_tools:skill_54f871ce-e55a-4b2a-a8b6-a67609186012` | 與 S5 文件記錄的違規 ID 相同，數量沒有增加（S5 的基準也是 1 筆）。S6 沒有新增工具 |

### 修改判準的一處（S6 有意改變，不是放寬）

`chat_tree_index.eval.js` 的 `new_fields_filled`：原本要求舊索引的所有新欄位（含遠端的 `c_old2`）都是 null。S6 的遷移（`migrateRemoteChats`，載入時執行）會把舊遠端對話收進收件對話底下，`parentId` 與 `nodeName` 因此不再是 null，這是管理層決定的行為。

- 使用者看得到的結果：舊遠端對話在側欄收進來源節點的收件對話底下（`B機`），`remote` 欄位與標題不變。
- 改了什麼判準：本機舊對話仍要求所有新欄位為 null；遠端舊對話改為要求 `status`、`topicId`、`fingerprint`、`summary` 為 null，另外新增 `remote_migrated_to_inbox`（`parentId` 指向 `kind:'remote-inbox'`、`nodeName` 為 `B機`）。
- 修改後：`new_fields_filled`、`remote_migrated_to_inbox` 都為 true，其餘（`existing_fields_kept`、`remote_kept`、`persisted_*`、`child_new_chat`）不變且全為 true。

### `read_ledger`（人工判讀，照實寫）

- 輸出中有 12 個 false：10 個 `warned:false`、2 個 `has_more:false`（`parsed_has_more`、`last_page_has_more`）。
- 判讀：`warned:false` 與 `has_more:false` 是「沒有警告」「沒有下一頁」的正常值。
- **數字對不上**：S5 文件記的是 3 個 false，這次是 12 個。`read_ledger.js` 與 `read_ledger.eval.js` 在 S6 沒有改動（`git diff` 沒有這兩個檔），所以這不是 S6 造成的；但我沒有重跑 S5 的建置來做逐項比對，所以「不是 S6 造成的」是依檔案沒有改動推論，不是量測結果。

### 步驟 5 的範圍與缺口

- 所有評估都是真桌面版、假 LLM。
- 「`topicShiftCheck` 關閉時行為不變」：評估檔沒有改開關，等於在預設（關閉）下跑。沒有另外用開啟狀態跑一次作為對照。
- 嵌入式網頁版（沒有對話清單）路徑：沒有評估覆蓋（步驟 3 已列為缺口）。
- 真實遠端節點與真實需求：沒有驗證（所有遠端需求都是用 `_rgCreateRemoteChat` / `_rgChatRecord` 模擬）。

## 7. 沒驗證、目前的缺口

- 步驟 1 的行號是讀程式與 Grep 驗證，沒有真桌面版驗證。
- 步驟 2 只有 node 測試，沒有真桌面版驗證。
- 尚未做步驟 3–5 的任何程式修改（只有步驟 1 文件與步驟 2 純函式）。

---

## 原檔：subchat-s7

# 子對話 S7：批次刪除子對話

來源：`DESIGN.TODO.chat-subsessions.md` 第 10 節（使用者 2026-11-04 原話：「也要有工具可以批次刪除子對話」）與 S7 那一列。
範圍：只做 S7。不動 `ask_user_card` 的根層級歸類。

行號以 `renderer/src/floating-assistant.js`（源碼，110382 行）為準；`renderer/floating-assistant.js` 是嵌入產物，不改。

## 步驟 1：定位（本文件）

### 1.1 現有的刪除對話流程

| 項目 | 位置 | 內容 |
|---|---|---|
| 刪除入口（側欄右鍵選單） | 80155 | `{ label: '刪除對話', danger: true, run: () => this._chatDelete(id) }`，在對話項目的右鍵選單裡 |
| 刪除函式 | 79853–79880 | `async _chatDelete(id)`，見下 |
| 確認 | 79856 | `confirm(...)`（瀏覽器原生對話框，不是卡片）；文字含標題與「這個動作無法復原」；若 AI 正在回應會加一行「會一併停止」 |
| 停止進行中的 AI | 79859–79863 | 若 `running.isResponding`：設 `stopRequested`，呼叫 `currentAbortController.abort()` |
| 從索引移除 | 79865 | `this._chatIndex.chats = …filter(c => c.id !== id)` |
| 父對話刪除的提升規則 | 79867 | 底下子對話的 `parentId` 改成 `null`（**提升為根，不連帶刪除**）。S1 步驟 5 的規則，S7 的「只刪子對話」不改這條 |
| 展開狀態 | 79868 | `delete this._chatIndex.expanded[id]` |
| 待送出的 pending | 79869 | `this._chatPendingMap.delete(id)` |
| ctx 快取 | 79870、79873 | `this._chatCtxs.delete(id)`（若不是目前 ctx；目前 ctx 在 `wasCurrent` 分支刪） |
| 存檔刪除 | 79871 | `await this._chatBackend().del(id)`；失敗只 `console.warn`，不中斷 |
| 目前對話被刪時 | 79872–79880 | 切到最近更新的一筆；沒有就新建一筆「新對話」 |
| 存檔後端 | 79505–79512 | `_chatBackend()`：`kind:'files'`，`del: (id) => api.delete(id)`（`window.desktopAPI.chats`） |
| ctx 建立與讀取 | 79753 | `_chatCtxLoad(id)`：快取沒有就讀檔 |
| 索引查詢 | 79621 | `_chatEntry(id)` |
| 側欄重畫 | 79980 起 | `_renderChatList()`；有簽名（signature）比對，變了才重畫，所以索引變動後要把 `_chatListSig = null` 再呼叫 |
| 展開／收合 | 80046–80050 | `_chatTreeToggle(id, wasOpen)` 寫進 `idx.expanded`（false＝明確收合） |

### 1.2 子對話與連結卡片

- 子對話判斷：`parentId` 非空（`renderer/src/chat/chat_tree.js` 的 `normalizeChatEntry`，`parentKeyOf`）。孤兒（parentId 指向不存在者）與環上的節點視為根（同檔 `buildTree`）。
- 父對話的連結卡片：訊息上的可列舉屬性 `m._subchatLink = { childId, title }`（96350、96386；存檔後仍在）。
- 畫面渲染與冒泡：`_subchatLinkDecorate(w, childId)`（96131），狀態來自 `_subchatLinkInfo(childId)`（96191）。刪除後這個函式查不到 entry，`info` 會變成 `{status:null,text:''}`，但**連結卡片本身仍會留在父對話裡**，S7 要明確把它標成「已刪除」且不可再點。
- 點擊連結卡片切換到子對話的處理：107531 起（`if (msg && msg._subchatLink)`）。S7 要在這裡加「已刪除就不切換」的守衛，避免 `_chatCtxLoad` 拋錯。
- 遠端收件對話：`kind === 'remote-inbox'`（103034 有判斷）；S6 建立的收件對話與子對話（`_remoteInboxLink`，79550）。S7 不刪收件對話本身。

### 1.3 工具核准與確認機制（Grep 結果，附行號）

| 機制 | 位置 | 是什麼 | S7 能不能用 |
|---|---|---|---|
| `ask_user_card`（AI 工具） | 61085 註冊；`askCard(spec)` 78029；`askCardFlow` 78045 | 互動卡片，等使用者送出；子對話的卡片會冒泡到父對話（78035） | **不可用**（管理層指示：不依賴 `ask_user_card`） |
| 原生 `confirm()` | 79856（`_chatDelete`）；`deck_template_admin.js` 231 | 瀏覽器阻塞對話框，同步回傳 true/false | **可用**：與側欄刪除同一種確認，AI 工具內也能呼叫（需在使用者可見的渲染程序裡，本專案是桌面版，可用） |
| 電腦操作的原生核准視窗 | 44649–44702（註解「預覽、核准、範圍選擇、中止都在主行程的原生視窗；這裡的工具只能『請求』」） | 主行程原生視窗，先預覽再核准 | 可以，但要經主行程 IPC，範圍大，S7 不採用 |
| 檔案系統授權 `requestPermission` | 64446–64523、109324 | 檔案存取授權，必須是真人點擊觸發（瀏覽器限制） | 不適用 |
| 子對話權限框冒泡 | 96261（`_subchatAnswerFap`）、96269（`_subchatFapRow`） | 子對話的權限框冒泡到父對話連結卡片，點擊授權或拒絕 | 不適用（那是權限，不是刪除確認） |

**S7 的決定（管理層指示內）**：
- 側欄多選刪除：用原生 `confirm()`（與 `_chatDelete` 同一種），對話框文字列出標題與數量；要勾「也刪除進行中的」就改用一個自訂的小確認框（見步驟 4，待決）。
- AI 工具：用 `confirm()` 作為確認機制（不用 `askCard`）。若 `confirm` 不可用（例如非視窗環境），工具只回傳預覽（`dry_run` 等價），不刪。

### 1.4 側欄列項目與核取方塊可以放哪

- 每一列是 `chatEl(c, nested, depth, row)`（80000 起附近的 `const chatEl = …`），`el.dataset.chatId = c.id`，子對話有 `cl-child` 與 `marginLeft`（depth×14px）。
- 多選可放的位置：在 `chatEl` 內、標題前面加一個 `<input type="checkbox" class="cl-select">`，只在「選取模式」打開時顯示（這樣沒有選取模式時，DOM 與現在完全相同，符合回歸要求）。
- 父對話列（有子對話的那一列）右鍵選單或列底下加「刪除選取的子對話」「刪除已完成／失敗的」（按鈕放在父對話展開區的最下面，只在父對話展開且有子對話時出現）。
- 選取狀態存在 `this._chatSelect`（Set，不寫進存檔），切換父對話、刪除後一律清空。

### 1.5 `@` 候選與 ctx 清理相關

- `@` 候選清單：`_subchatChildCandidates()`（96085）。刪除後要重算（它讀的是索引，所以刪索引就會自動更新；但要確認沒有快取）。
- 新 ctx 欄位：若 S7 新增任何 ctx 狀態欄位，要加進 `FA_CHAT_CTX_KEYS`（51020 起的 Set）。S7 原則上不需要新 ctx 欄位（選取狀態放 UI，不放 ctx）。
- 子對話工具的條件註冊：`_subchatToolFilter(names)`（74804）。它用 `SUB = ['chat_list_children','chat_send_to_child','chat_get_child_summary']` 過濾；S7 的 `chat_delete_children` 要加進這個清單，並且同一條件（有子對話才送進工具清單）。
- 工具註冊位置：61097–61125 附近（`chat_list_children` 61098、`chat_send_to_child` 61106、`chat_get_child_summary` 61118）。
- 目標檢查（只能操作本機、parentId 是目前對話的子對話）：`_subchatToolTarget(pid, childId)`（74813）。S7 的刪除工具可重用它。

## 2. 風險（先寫，之後補）

1. **刪除是不可復原的**。AI 工具必須先確認，未確認前不得刪任何一筆。
2. 進行中的子對話（`status === 'running'` 或 `ctx.isResponding`）：預設跳過，勾選才先中止再刪。
3. 父對話提升規則：刪子對話不影響其他子對話；刪的若是「中間層」（有孫），孫要一併刪（管理層決定）。提升規則只在刪「根」時發生，S7 不刪根，所以不會觸發。
4. 連結卡片點擊：已刪除的子對話，點擊要不拋錯。
5. 目前對話若是被刪的子對話，要切到父對話（不是切到「最近更新的一筆」）。

## 3. 待決（自己決定，寫理由）

- 側欄多選：用「選取模式」（不是每列常駐核取方塊），理由：沒有子對話或沒按選取時，側欄與現在完全相同（回歸）。
- 進行中的勾選框：用原生 `confirm()` 分兩段問會很亂，改為：先 `confirm` 列出清單（含進行中數量），若有進行中且使用者按「取消」就直接結束；另外一個獨立的 `confirm` 問「也要刪除進行中的嗎？」。理由：不新增自訂對話框 DOM，維持與 `_chatDelete` 同一種機制。步驟 4 實作時再看是否改成自訂框。

## 4. 步驟 2 起的待辦

- 步驟 2：`renderer/src/chat/chat_delete.js` 與 `chat_delete.test.js`，純函式 `planDelete(chats, {parentId, filter, ids, includeRunning})`。
- 步驟 3：`_chatDeleteMany(plan)`，逐項刪除與清理（見 1.1、1.5）。評估 `scripts/eval/subchat_delete.eval.js`。
- 步驟 4：側欄多選 UI 與確認。評估讀 DOM。
- 步驟 5：AI 工具 `chat_delete_children` 與條件註冊。評估 `scripts/eval/subchat_delete_ai.eval.js`。
- 步驟 6：回歸與文件收尾。

## 5. 教訓

（尚無）

## 6. 步驟 2：純函式（已完成，node 測試 19 項全過）

- `renderer/src/chat/chat_delete.js`：`createDelete(AiChatTree 模組)` 回傳 `{planDelete, FILTERS}`。樹模組由呼叫端傳入（嵌入時用 `new Function`，不能 `require`）。
- `planDelete(chats, {parentId, filter, ids, includeRunning, busyIds})` → `{toDelete, skipped, descendantsDeleted, error?}`。
- 規則：只刪有效子對話；根、孤兒（視為根）、`kind:'remote-inbox'` 不刪；子樹任一筆進行中（`running`／`waiting_user`／`busyIds`）整棵跳過（reason `in_progress` 或 `descendant_in_progress`），`includeRunning` 才包含。
- 測試：`node renderer/src/chat/chat_delete.test.js`。

## 7. 步驟 3：執行與清理（已完成，真桌面版驗證過）

- `_chatDeleteMod()`（源碼 `floating-assistant.js`，緊接 `_chatBackend` 之前）：`new Function(FA_CHAT_DELETE_SRC)` 載入一次。
- `_chatDeleteMany(plan)`（緊接 `_chatDelete` 之後）：逐項 abort 進行中的 → 先刪存檔（失敗記入 `failed`，索引不動）→ 移出索引、`expanded`、pending map。目前對話被刪時改停在父對話（沒被刪的），否則最近更新的一筆，否則新對話。被刪的 ctx 移出記憶體。
- 連結卡片：`_subchatLinkInfo` 查不到子對話時回 `{gone:true, text:'已刪除'}`；`_subchatLinkDecorate` 遇到 `gone` 直接返回（沒有回答欄）；`_renderSingleMessageInner` 的「打開」按鈕顯示「已刪除」且停用，點擊守衛 `if (!this._chatEntry(...)) return`。
- 建置：`scripts/embed-code-ui.js` 加 `CHATDELETE` 區塊；`scripts/build-web-lazy.js` 的 `EXCLUDE` 加 `CHATDELETE`（與 `CHATTREE` 同理：開頁就會同步用到，不能分成lazy區塊）。
- 評估：`scripts/eval/subchat_delete.eval.js`，修前 `fa._chatDeleteMod is not a function`（fatal，allPass 假）；修後 allPass 真，`uncaught` 空。
- 驗證的事實（Grep / 執行結果）：`planDelete` 刪 c1,c2,c4,c5,g1；c3 留下；存檔與 ctx 清掉；父對話 5 張卡片，4 張「已刪除」停用，c3 可用；側欄與 `@` 候選更新。

## 8. 步驟 3 的教訓

- 連結卡片的節點會沿用既有 DOM，`_renderMessageHistory()` 不保證重建。刪除後要直接改現有卡片（已在 `_chatDeleteMany` 做），不能只靠重畫。
- 建置會移除註解，源碼裡要讓評估檢查到的標記用「字串常值」（`res.tag = 'S7:chat_delete_many'`），不能只用註解。
- `build-web-lazy` 會把純定義的新區塊自動搬成 lazy chunk；若同步要用，必須加進 `EXCLUDE`，否則 `web-lazy/chunks/chatdelete.js` 會被產生。
- 新的 UMD 模組不能 `require`：嵌入後是 `new Function('module', …)`，樹模組要由呼叫端傳入。

## 9. 還沒做（後續步驟）

- 步驟 4：側欄多選 UI。步驟 5：AI 工具 `chat_delete_children`（確認用原生 `confirm()`，預覽退路）。步驟 6：回歸。
- 已知缺口（步驟 3）：被刪子對話若正在背景跑、已 abort，它的 `_persistChatHistory` 可能在刪除後又寫回一次存檔（會復活檔案）。目前沒有防護，步驟 6 要決定如何處理並驗證。

## 10. 步驟 4：側欄多選（已完成，真桌面版驗證過）

- 入口：子對話的父對話右鍵選單「批次刪除子對話…」（只有有子對話時才出現），進入選取模式：父對話展開、子對話列前面出現核取方塊 `.cl-select`，列表頂端出現工具列 `.cl-batch`（已選數、「刪除選取的（n）」、「刪除已完成／失敗的」、「取消」）。
- 沒有選取模式時列表 DOM 與現在相同（回歸）：`.cl-select`、`.cl-batch` 都不存在。
- 確認：`_chatBatchDelete(pid, opts)`：先 `confirm` 列出將刪除的標題與數量（含子孫數）；有略過項目就列出；選到進行中的另問一次「連它們一起刪？」（確定＝`includeRunning`，取消＝只刪其餘）。取消任何一步都不動資料。
- 判準（管理層決定的解讀）：「也刪除進行中的」做成第二個確認框，不做自訂對話框（理由：沿用 `_chatDelete` 的 `confirm`，不新增 DOM）。快捷「刪除已完成／失敗的」不會把進行中的算進去，所以不問第二次。
- 評估：`scripts/eval/subchat_delete_ui.eval.js` allPass（讀 DOM、假 confirm）。修前沒有另外跑（功能不存在就沒有 DOM），這是缺口。

## 11. 步驟 5：AI 工具 `chat_delete_children`（已完成，真桌面版驗證過）

- 參數：`parent_id?`（省略＝目前對話）、`filter`（done／failed／done_or_failed／all／ids，必填）、`ids?`、`include_running?`、`dry_run?`。一行說明。只在目前對話有子對話時送進工具清單（`_subchatToolFilter` 的 `SUB` 清單加入此名稱）。
- 流程：`_chatDeleteChildrenTool`（源碼 `floating-assistant.js`，緊接 `_chatBatchDelete` 之前）：計畫 → 若 `dry_run` 或沒有子對話可刪 → 回預覽 → 沒有 `window.confirm` 時只回預覽 → `confirm` 列出標題與數量 → 按確認才 `_chatDeleteMany`。
- 不能刪正在執行這個工具的對話本身（回 ok:false）。
- 確認機制選擇：`window.confirm`（與側欄、`_chatDelete` 相同），不用 `ask_user_card`（管理層指示）。理由：卡片要等使用者在對話裡答，工具要同步拿到答案；原生確認直接回傳布林。缺點：是阻塞式對話框。
- 評估：`scripts/eval/subchat_delete_ai.eval.js` allPass：工具清單有／無子對話、dry_run 不跳確認不刪、未確認 ok:false 不刪、根與不存在的 id 列 skipped、假模型 TOOLDEL 呼叫 → 確認框 → 按確認才刪、工具結果 JSON 可讀。
- 缺口：修前沒有另外跑（工具不存在時第一個檢查就會失敗，本次沒有單獨留下修前紀錄）。

## 12. 步驟 6：回歸（已完成）

### 12.1 回歸結果（真桌面版，工作目錄；2026-11-04）

- 沒有子對話時：工具清單不含 `chat_delete_children`（`notInRootListNoKids`）；側欄沒有 `.cl-select`／`.cl-batch`（`regressionNoBoxes`）。
- 有 allPass 的評估全數 allPass：`chat_mention`、`subchat_bubble`、`subchat_card_request`、`subchat_fap`、`subchat_link`、`subchat_open`、`subchat_pullback`、`subchat_remote`、`subchat_remote_bubble`、`subchat_send`、`subchat_tools_ai`、`topic_local`、`topic_shift_setting`、`topic_shift_ui`。
- `chat_tree`、`chat_tree_index`：沒有 allPass 欄位，逐項檢查，全部為 true。
- `subchat_form`、`subchat_reload`：第一次跑時失敗（F6 區段／`currentId` 讀取），同一份程式重跑即通過；與背景上一輪評估同時跑有關，未再重現。如實記錄為「不穩」，不是 S7 造成。
- `subchat_tools`：判準改動（見 12.2），重跑 allPass。
- `tool-budget`：違規數仍是 1（與基線相同，`domain_too_many_tools:skill_54f871ce…`）；`flat_all_tools` 由 54676 增加到 54866（+190，新工具的說明與參數）。
- `read_ledger`：與 S6 基線逐欄相同（reminders、final_text、warned）。
- `chat-incremental`：沒有 allPass，輸出的 checks 全部為 true（未另外比對基線）。
- 節點測試：`chat_tree` 22、`topic_local` 12、`handoff` 12、`remote_inbox` 16、`sub_status` 20、`chat_delete` 19，全過。

### 12.2 判準改動（有意）

- `subchat_tools.eval.js` 的 `SUB3` 加入 `chat_delete_children`：S7 起父對話多一個子對話工具（只在有子對話時）。使用者看得到的結果：父對話的 AI 多一個批次刪除工具；子對話的工具清單不變（`cn.every(SUB3 不含)` 仍成立）。

### 12.3 基線比對方法

- 用 `git worktree` 在 `77c6a037`（S7 之前）建了暫時工作樹，`node_modules` 用 junction 連到工作目錄，建置後跑 `subchat_form`、`tool-budget`、`read_ledger`；用完已移除 junction 與工作樹（原本的 `node_modules` 確認完好）。

## 13. 教訓（S7 過程）

- 連結卡片的 DOM 會被重用：`_renderMessageHistory()` 不保證重建，所以被刪子對話的卡片要直接改 DOM（步驟 3）。
- 建置會去掉註解：評估要檢查的載入標記要用字串常值（`res.tag`、`'AI 要求刪除'`），不能靠註解。
- `build-web-lazy` 會把純定義的新區塊搬成 lazy chunk：同步要用的區塊要加進 `EXCLUDE`（步驟 3）。
- 嵌入模組不能 `require`：樹模組由呼叫端傳入（步驟 2b）。
- 評估的前置條件要自己保證：`_chatNew()` 會重用空對話，評估裡要先讓父對話有內容（步驟 5）。
- 背景跑一串評估時，若跟另一組評估同時跑，會出現不穩；要一個一個跑（步驟 6）。

## 14. 已知缺口（最後狀態）

1. 被刪子對話若正在背景跑、已 abort，它的 `_persistChatHistory` 可能在刪除後又寫回存檔（會復活檔案）。目前沒有防護，也沒有評估涵蓋這個情境。理由：要模擬「abort 後仍寫檔」需要新的假模型時序，本次沒有做。後續要做：刪除前等 `isResponding` 變 false（有時限），或在 ctx 上加一個 `_deleted` 旗標擋寫入（要進 `FA_CHAT_CTX_KEYS`）。
2. 步驟 4、5 沒有跑修前紀錄（步驟 3 有）。理由：功能不存在時介面就不會出現，評估的第一個檢查就會失敗；這是口頭推論，沒有實際留下紀錄。
3. 確認機制是阻塞式 `window.confirm`。如果工作階段在無視窗環境執行，工具會退回預覽（已做，但沒有實際在無視窗環境驗證）。
4. 網頁版：`CHATDELETE` 已加入 EXCLUDE，沒有實際跑網頁版載入驗證。

---

## 原檔：subchat-s8

# 子對話 S8：收尾（關掉前面階段的缺口）

來源：`DESIGN.TODO.chat-subsessions.md` 第 10 節、`DESIGN.TODO.subchat-s7.md` 第 14 節（已知缺口）。
範圍：S8 只做收尾。不動 `ask_user_card` 的根層級歸類（S4b `d12293d1`）。
使用者規則（2026-11-04，逐字）：「所有的提問都要保留在parent / root那個，但如果使用者到child去回答，root也要知道」。

行號以 `renderer/src/floating-assistant.js`（源碼）為準；`renderer/floating-assistant.js` 是嵌入產物，不提交。

## 步驟 A：被刪子對話不復活

### A.1 修前證據（真桌面版，`scripts/eval/subchat_resurrect.eval.js`）

- 情境 1（模型忽略 abort、延遲 1200ms 才回，子對話在回應中被刪）：**沒有復活**。`_writeChatBlob`（約 79660）已用 `_chatEntry(id)` 擋住，`_chatCtxs`、pending 都清乾淨。
- 情境 2（存檔寫入已開始、尚未落盤時刪除，寫入被拖慢 1500ms）：**復活**，修前 `s2NoFile:false`，檔案 `{"messages":[…]}` 仍在。
- 原因：`_flushChatWrite`（約 79662）在 `await write` 之前檢查了 entry，之後沒有再檢查；刪除的 `del` 先落盤，寫入後到，檔案又寫回來。

### A.2 修法

- `_flushChatWrite`：寫入落盤後若 entry 已不存在，再呼叫一次 `del`（字串 `S8:resurrect` 留在警告訊息裡，評估用來確認載入的是工作目錄實作）。
- 沒有加 `_deleted` ctx 旗標、也沒有改 `FA_CHAT_CTX_KEYS`：情境 1 已被既有守衛擋住，新增 ctx 狀態會增加重設點，不必要。理由寫在這裡。
- 等 `isResponding` 變 false 的方案沒採用：模型可能忽略 abort 很久，等待會卡住刪除動作。

### A.3 修後驗證

- `subchat_resurrect.eval.js`：allPass（情境 1、2 全部檢查通過，`loadedWorkdirImpl` 為真）。
- 回歸：`subchat_delete.eval.js`、`subchat_delete_ai.eval.js` 皆 allPass。

### A.4 限制

- 情境 2 的「拖慢寫入」是人為注入（包裝 `_chatBackend().write`），真實磁碟寫入通常很快；修法不依賴時序，只依賴「寫入後檢查 entry」，所以仍成立。
- 頁面重新整理期間的寫入沒有測。

## 步驟 B：提問在根、回答在子要同步

### B.1 提問種類盤點（對應 S4 文件第 3 節的種類）

| 種類 | 來源 | 根對話回答（路徑 root） | 子對話回答（路徑 child） |
|---|---|---|---|
| 卡片 `ask_user_card` | `askCard`（約 78048）；子對話的等待記錄在 `_subchatPendingMap` | `_subchatAnswer`（約 96503） | 卡片的 `_cardWaitersMap` 回呼（約 78057） |
| 表單選項 | `requestUserForm` → `_subchatAskForm`（約 96393）；`askBranchChoice` 也走這裡 | `_subchatAnswerForm`（約 96421） | `settle` 由子對話的 `p.then(settle)` 觸發 |
| 表單欄位 | 同上（`fields`） | 同上（`values`） | 同上 |
| 資料夾授權（FAP） | `_showFapPermissionDialog`（約 64504）；子對話端 `_checkFapPermission`（約 64476–64495） | `_subchatAnswerFap`（約 96450） | 授權框按鈕（`#fa-fapperm-allow`） |
| 下載位置選擇 | 只在使用者點下載連結時開，模型不等它 | 不冒泡（S4b 已判定不是缺口） | — |

### B.2 修前證據（真桌面版，`scripts/eval/subchat_qa_sync.eval.js`，步驟 B 修改前的建置）

- 根對話路徑：回答都通過，但連結卡片沒有任何問答紀錄（`qaRecorded:false`、`rootShowsQA:false`、`savedQA:false`）。
- 子對話路徑：子對話回答後根對話的卡片完全沒有反應（`rootShowsQA:false`，四種都是）。
- 所以修前「提問在根、回答在子要同步」不成立。

### B.3 修法

- 問答紀錄存在連結訊息 `m._subchatLink.qa`（可列舉，隨父對話存檔），每筆 `{kind, q, where:'root'|'child', a, at}`，最多留最近 20 筆（理由：卡片上的紀錄要能掃完、不讓長對話的連結卡片無限變長；超過丟最舊）。
- 紀錄點：卡片回呼、表單 `settle`（`by` 參數區分 root 與 child）、FAP 授權結果（`_fapRootKeys` 記錄是否在根對話按的）。權限式問題寫「授權」或「拒絕」。
- 父對話不在畫面上時，`_subchatQARecord` 會把快取裡那一份父對話 ctx 放回 `_chatCtxs`（`_chatCtxPrune` 可能已清掉）並立刻 `_flushChatWrite()`（不等 350ms 延遲寫檔），切回父對話時不會讀到舊版。
- 連結卡片 `_subchatLinkDecorate` 在狀態列下面畫出 `.fa-subchat-qa`：`❓ 問題 → 在根對話回答／在子對話回答：答案`。子對話回答後狀態回到 running，根對話不再顯示可回答的欄位（只剩「傳給子對話」的輸入列，那是 S5 的一般傳話，不是回答）。

### B.4 修後結果（真桌面版）

- `subchat_qa_sync.eval.js`：allPass。8 個案例（4 種 × 2 條路徑）的待答、已回答、紀錄、根顯示、無回答欄位、存檔後重讀都通過；上限 20 筆與「留最新」通過。
- 回歸：`subchat_form`、`subchat_fap`、`subchat_bubble`、`subchat_card_request`、`subchat_send`、`subchat_resurrect` 皆 allPass。

### B.5 限制（如實寫）

- 卡片的子對話端回答不是點 DOM 按鈕：評估用 `FaCard.setAnswer`＋`submitStep`＋`_cardFinish` 模擬畫面送出（三個函式都是畫面送出時會呼叫的）。DOM 按鈕的點擊沒有逐一驗證。
- 「根對話不再顯示可回答的欄位」以「連結卡片裡沒有回答／授權／選項按鈕」判定；「傳給子對話」輸入列保留。
- 問答紀錄的答案摘要截斷 120 字。
- 下載位置選擇沒有冒泡（見 B.1），不在本步驟範圍。

## 步驟 D：話題偵測語料與門檻校準

### D.1 修前的問題

- `CONTINUATION_RE`（`renderer/src/chat/topic_local.js`）對「來」開頭一律當延續句：「來聊聊投資」「來一首音樂的歌」不開子對話（S5 評估已發現）。
- 同一判準也不看長度：一整句新需求只要以「加／來／改…」開頭，就不會轉移。

### D.2 修法（`topic_local.js`）

- `isContinuation(text)`：先符合 `CONTINUATION_RE`，再套長度規則：
  - 含中文：字元數 ≤ 12（`CONTINUATION_MAX_LEN`）。理由：語料中最長的延續句 7 字；12 字留餘裕，又不會把一整句新需求當延續。
  - 單獨「來」開頭（不是「再來／又來／也來／還來」）：字元數 ≤ 4（`BARE_LAI_MAX_LEN`）。「來一個」「來兩張」是接續，「來一首音樂的歌」「來聊聊投資」是新需求。
  - 純英文：單字數 ≤ 6（字元數偏長，不適用中文的上限）。
- 延續清單補上「然後」「還要」「也說」「也講」開頭。理由：語料中「然後呢」「還要再詳細一點」「也說說它的經濟」是明確的接續語，原清單沒有；不補的話這三句在任何門檻都被誤開（見 D.4）。這四個前綴也會漏掉短的新需求（「還要幫我寫一首詩」），語料留有這個反例。

### D.3 語料（`renderer/src/chat/topic_corpus.json`，合成，63 組）

- 類別：A 換話題 18、B 同話題追問 18、C 明確延續短句 14、D「來」開頭或其他短新需求 9、E 換話題後拉回 4。
- 中文、英文、中英混合都有。標籤依語意人工判定，拿不準的沒放進來。
- 語料是合成的，不是使用者的真實對話：數字只代表這份語料，**真實誤判率沒量**。

### D.4 校準（`scripts/chat/topic_calibrate.js`）

門檻同時設 `sameThreshold` 與 `matchThreshold`（同一個旋鈕），從 0.10 到 0.50、步長 0.05：

| 門檻 | 該開沒開（漏判） | 不該開卻開（誤開） | 明確延續句被誤開 |
|---|---|---|---|
| 0.10 | 12.9%（4/31） | 0.0%（0/32） | 0.0%（0/14） |
| 0.15 | 12.9%（4/31） | 6.3%（2/32） | 0.0%（0/14） |
| 0.20 | 9.7%（3/31） | 6.3%（2/32） | 0.0%（0/14） |
| **0.25** | **3.2%（1/31）** | **12.5%（4/32）** | **0.0%（0/14）** |
| 0.30 | 3.2%（1/31） | 25.0%（8/32） | 0.0%（0/14） |
| 0.35 | 3.2%（1/31） | 37.5%（12/32） | 0.0%（0/14） |
| 0.40 | 3.2%（1/31） | 37.5%（12/32） | 0.0%（0/14） |
| 0.45 | 3.2%（1/31） | 43.8%（14/32） | 0.0%（0/14） |
| 0.50 | 3.2%（1/31） | 46.9%（15/32） | 0.0%（0/14） |

- 補延續清單前（同一份語料、同一判準的前一版）：「明確延續句被誤開」在所有門檻都是 21.4%（3/14），是三句沒被辨識（「然後呢」「還要再詳細一點」「也說說它的經濟」），門檻調整改不了這個數字。
- 選擇規則（管理層依使用者「選速度快的方式，誤判寧可多開」）：在「明確延續句被誤開 ≤ 15%」的門檻中，選「該開沒開」最低者；同樣低時選「不該開卻開」較低者。
- 結果：0.25 以上都是 3.2% 漏判；同樣低時選誤開較少的 **0.25**，與現有預設值相同，所以預設門檻沒改（`DEFAULT_SAME_THRESHOLD`、`DEFAULT_MATCH_THRESHOLD` 仍是 0.25）。
- 唯一的漏判是「還要幫我寫一首詩」（新需求，被「還要」前綴當成延續）。這是補清單的代價，照實留著。

### D.5 驗證

- `node renderer/src/chat/topic_local.test.js`：12 項全過（修前的「英文序列」因 `add another dog` 字元數超過中文上限而變紅，改用單字數後通過，這是修法的一部分，不是判準改動）。
- `node renderer/src/chat/topic_corpus.test.js`：6 項全過（語料格式、中英混合、延續誤開 ≤ 15%、漏判 ≤ 1、「來」新需求、短延續不開）。
- Electron：`scripts/eval/topic_local.eval.js` allPass（工作目錄的實作，已建置）。`topic_shift_setting`、`topic_shift_ui`、`subchat_pullback` 回歸 allPass。

### D.6 限制

- 語料合成，樣本小（31 個正例、32 個負例、14 個延續句）。0.25 的漏判只有 1 句，統計上不可靠。
- 延續清單是手寫的，沒有覆蓋所有口語（例如「ok 那下一個」「對了」）。這些句子的行為沒有量。
- 門檻對 `matchThreshold`（拉回舊話題）與 `sameThreshold`（同話題）是同一個旋鈕；分開調沒有做。

## 步驟 C：`@` 與遠端的缺口

### C.1 結果一覽

| 項目 | 修前 | 修後 | 證據 |
|---|---|---|---|
| (1) `@` 候選排除遠端收件對話 | 收件對話在候選裡（S6 缺口） | 排除（`isInbox`，`chat_tree.js`，`listMentionCandidates` 與 `resolveMention` 都過濾 `kind:'remote-inbox'`） | `chat_tree.test.js` 的 S8 測試；修前用 HEAD 模組跑同一份測試，第一個 S8 斷言失敗 |
| (2) 節點名/標題前綴 | 只有精準比對與方括號 | 精準不變；沒有精準時，完整名稱（節點名/對話名）的**唯一**前綴可用，前綴至少 2 字；歧義列候選（`ambiguous`、`prefix:true`） | `chat_tree.test.js` 的 S8 前綴測試（`@b機/來自 B機：幫我寫一個` 命中 `r1`、`@B機/來自 B機：` 列 `r1`、`r2`）；修前同一測試失敗 |
| (3) `chat_send_to_child` 遠端子對話 | 拒絕 | **保留拒絕**（理由見 C.2） | 程式位置與傳輸路徑 |
| (4) 網頁版載入 | 沒驗證 | `scripts/web-lazy-check.js` 本機檢查通過（核心與 137 個區塊）；嵌入式網頁版路徑（無對話清單）**沒有**跑 | `node scripts/web-lazy-check.js` 輸出「本機檢查通過」 |

- `@` 的 Electron 回歸：`chat_mention.eval.js` allPass（工作目錄實作）；`chat_tree.eval.js`、`chat_tree_index.eval.js` 沒有 allPass 欄位，逐項檢查，沒有任何 `false`。
- 「遠端子對話標題含空白與冒號」本身不改（S6 管理層指示：改標題格式會改變側欄顯示，要先問使用者）；改用前綴比對解決手打不便的問題。

### C.2 第 (3) 項：為什麼保留拒絕（證據）

- 遠端需求的進度、結果、停止都經由群組傳輸回給發出的節點：`_rgEvent(job, {kind:'progress'|…})`（`floating-assistant.js` 約 53440 起，`job.done` 與 `prog.fail` 旁邊）。
- 子對話的回應由本機的子對話 ctx 執行（`_subchatSend` 約 96366 不檢查 nodeName），但「追問一句」不會經過那條回報路徑：發出需求的節點不知道這句話，兩邊的結果會分岔。
- 所以在本機對遠端子對話追問需要一個新的回報協定，超出 S8 範圍。保留 `_subchatToolTarget` 的拒絕（約 74832，錯誤訊息「遠端對話不能用這個工具」）。
- 缺口：遠端子對話仍不能由父對話工具傳訊息；使用者若要追問，需要另外的協定設計（列為後續，不在 S8）。

### C.3 測試與限制

- `renderer/src/chat/chat_tree.test.js`：26 項全過（含 S8 的 4 項）。
- 限制：前綴比對只對「完整名稱」（節點名/對話名）做，不對對話名單獨做（遠端對話名單獨對上時仍是 `needNode`，維持原行為）。
- 限制：`@` 候選的 App 層（輸入框自動完成）沒有另做 Electron 評估，只靠模組測試與 `chat_mention.eval.js`。

## 步驟 F：ask_user_card 只在父對話（2026-11-04 管理層更新）

使用者原話：「ask_user_card只在parent」。這取代先前「不要動 ask_user_card 的根層級歸類」的指示。

### F.1 決定與理由

- (1) 根層級註冊還原：`ask_user_card` 回到 `registerOptional`（domain-gated），與 `d12293d1^` 相同（`floating-assistant.js` 61087）。理由：使用者的原則是「只在 parent」，根層級註冊會讓所有對話都有它，包括子對話。
- (2) 子對話永遠沒有它：不靠「不送進清單」一招，而是三層擋：清單過濾、領域委派過濾、工具實作本身擋下（executor 擋下才能涵蓋所有取得路徑）。
- (3) 評估：`subchat_no_ask.eval.js`（新）與 `subchat_tools.eval.js`（更新）。

### F.2 路徑盤點（子對話內可能取得 ask_user_card 的每一條路徑，附行號）

| 路徑 | 位置 | 處理 |
|---|---|---|
| 根層級清單 | `_getRootToolNames`（74856）只取非 gated 工具；`FA_TASK_TOOL_HINTS`（47197）不含它（Grep 確認） | 還原後不在根層級清單；子對話清單另由 `_subchatToolFilter`（74835、過濾在 74838）移除 |
| 領域委派 | 領域清單含它：`toolNames`（1558，uml 領域）、`ph_design` 階段（25211）；子代理取得領域工具於 `_resolveDomainToolNames`（104524） | `_resolveDomainToolNames` 在子對話回傳前過濾（104530） |
| 技能包 | 技能步驟的工具提示（14757，`st(ask, …, { tool: ask_user_card })`）；路由正則（11972）；說明文字（1041） | 只是提示或說明，不會把工具送進子對話；實際呼叫仍被下一條擋下 |
| `get_tool_details`／`request_additional_tools` | 補工具的機制；取得說明後呼叫仍走同一個工具實作 | 不改；呼叫時在工具實作擋下（61091） |
| 工具實作（所有路徑的共同終點） | `registerOptional(ask_user_card, …)` 的 async 函式（61087、61091） | 子對話呼叫 → `ok:false`，訊息：「這個對話是子對話，提問由根對話負責；需要使用者決定的事請直接用文字寫在回覆裡，系統會顯示在根對話的連結卡片上」 |

判斷子對話：`_subchatIsChild()`（74830）。有有效 `parentId` 的 ctx 都是子對話，包括收件對話底下的遠端子對話。

### F.3 修前與修後（真桌面版）

- 修前（`subchat_no_ask.eval.js`，修改前的建置）：`rootListNoAsk`、`gatedRegistration`、`childDomainNoAsk`、`childListNoAsk`、`childCallNotOk`、`childCallExplains`、`noCardLeft`、`loadedWorkdirImpl` 失敗；子對話呼叫會卡在等使用者（逾時 4 秒才回來，證明它確實開了卡片）。`parentDomainHasAsk` 修前就通過（父對話經領域拿得到，符合「只在 parent」）。
- 修後：`subchat_no_ask.eval.js` allPass；`subchat_tools.eval.js` allPass。
- 判準改動（有意，理由：規則改變）：`subchat_bubble.eval.js` 的案例 A 原本測「子對話用 ask_user_card 開卡片、冒泡到父對話、父對話回答」。新規則下子對話不能開卡片，所以案例 A 改為測「子對話呼叫被擋下（工具結果含「提問由根對話負責」）、子對話不等待、父對話連結卡片沒有問題、在父對話回答會被拒絕」。舊的四個判準（`aStatusWaitingUser`、`aParentLinkShowsQuestion`、`aAnswerAccepted`、`aChildGotAnswer`）移到 info，不再計入 allPass。
- F 之後的回歸重跑（見步驟 E 的表）：全部 allPass 或無 false；`subchat_bubble` 改判準後 allPass。

### F.4 與管理層指示的落差（需要知道）

管理層第 (1) 項要求「父對話清單與 d12293d1^ 一致」，第 (3) 項又說父子差異「包含子對話沒有 ask_user_card」。在沒有啟用領域的父對話情境（`subchat_tools` 的情境）下，父對話本來就不含 `ask_user_card`（與 d12293d1^ 相同），所以那個情境的父子差異不含它。父對話只在領域啟用時才有它，這是 `subchat_no_ask` 的 `parentDomainHasAsk` 所檢查的。我依 (1) 的機制與證據實作，並以使用者的原話「只在 parent」寫成領域路徑的評估，不把差異硬塞進沒有領域的情境。

### F.5 限制

- 子對話呼叫在評估中是直接呼叫工具實作（不是經由假模型的工具呼叫）。模型實際收到的清單由 `subchat_tools` 的假模型請求檢查。
- `request_additional_tools` 等補工具機制沒有逐一用真實的模型流程測試，依賴工具實作的擋下。

## 步驟 E：回歸

真桌面版（`scripts/eval/run_eval.js`，工作目錄實作，已建置）：

| 評估 | 結果 |
|---|---|
| `subchat_link`、`subchat_open`、`subchat_tools`、`subchat_tools_ai`、`subchat_remote`、`subchat_reload` | 全過（`subchat_reload` 沒有 allPass 欄位，逐項無 false） |
| `subchat_remote_bubble`、`subchat_pullback`、`subchat_form`、`subchat_fap`、`subchat_bubble`、`subchat_card_request`、`subchat_send` | 全過 |
| `subchat_delete`、`subchat_delete_ai`、`subchat_delete_ui`、`subchat_resurrect`、`subchat_qa_sync` | 全過 |
| `chat_mention` | 全過 |
| `chat_tree`、`chat_tree_index` | 沒有 allPass 欄位，逐項無 false |
| `topic_local`、`topic_shift_setting`、`topic_shift_ui` | 全過 |
| `tool-budget` | 違規數仍是 1（`domain_too_many_tools:skill_54f871ce…`，與 S7 基線相同）；`flat_all_tools` 54866（與 S7 相同，本階段沒有新增工具） |
| `read_ledger` | 沒有內建判準，人工判讀：`A_before_fix` 到 `H_attach_after_fix` 各欄位與 S7 記錄的形狀一致；但 S6 的基線數值沒有在本次文件逐項列出，**無法嚴格逐欄比對**，如實寫明 |

- 「topicShiftCheck 關閉時行為不變」：`topic_shift_setting` 全過。
- 「沒有子對話時工具清單與側欄與現在相同」：`subchat_delete_ai` 的「沒有子對話時工具清單不含 `chat_delete_children`」與 S7 `regressionNoBoxes` 再次通過。
- 節點測試：`chat_tree` 26（S8 新增 4 項）、`topic_local` 12、`topic_corpus` 6、`chat_delete` 19。
- 網頁版：`scripts/web-lazy-check.js` 本機檢查通過。

## 已知缺口（S8 收尾後的最後狀態）

1. **嵌入式網頁版（沒有對話清單的路徑）**：沒有跑真實載入驗證（步驟 C 缺口 4，S6 也列過）。理由：需要沒有對話清單的建置，這次沒有做。
2. **遠端子對話的 `chat_send_to_child`**：保留拒絕（C.2）。理由：遠端需求的回報經群組傳輸，本機追問沒有回報路徑；需要新協定。
3. **問答紀錄的子對話端卡片回答**：用 `FaCard` API 與 `_cardFinish` 模擬，沒有逐一點 DOM 按鈕（B.5）。
4. **話題偵測是合成語料**：真實誤判率沒量（D.6）。「還要幫我寫一首詩」這類以延續前綴開頭的新需求會漏判（D.4）。
5. **`read_ledger` 沒有逐欄對 S6 基線**（步驟 E）。
6. **`@` 候選的輸入框自動完成**沒有另做 Electron 評估，只有模組測試與 `chat_mention` 評估（C.3）。
7. **被刪子對話的情境 2 是人為拖慢寫入**（A.4）；真實磁碟寫入通常很快，修法不依賴時序。
8. **`ask_user_card` 根層級歸類**：本階段沒有改動，也沒有依賴（管理層指示）。

## 教訓（S8 過程）

- 守衛要放在「寫入前」與「寫入後」兩邊。只檢查寫入前，遇到 await 中間的刪除就會漏（步驟 A）。
- 模擬「已 abort 但仍會回來」與「寫入中途被刪」是兩種不同情境；只做前者會得到假的通過（步驟 A）。
- 快取有兩份時，修改的必須是「UI 會讀的那一份」。`_chatCtxPrune` 會清掉不在畫面上的對話快取，之後會從磁碟重讀；修改後要立刻落盤，不能等 350ms 的延遲寫入（步驟 B）。
- 評估裡的過期物件會覆蓋真正的狀態：收尾時用 `fa._chatActivate(parentCtx)` 把開頭那份舊物件換回來，導致假失敗。要用 `_chatCtxs.get(id)` 取當前的（步驟 B）。
- 評估之間要等延遲寫檔完成（sleep 700ms）再切換對話，否則讀到舊版（步驟 B）。
- 延續句的長度上限要分語言：中文用字元數，英文用單字數。字元數會把 `add another dog` 誤判成新話題（步驟 D）。
- 校準時，門檻調整改不了的誤判（所有門檻都 21.4%）要先找原因，多半是判準本身缺條件，不是門檻問題（步驟 D）。只檢查寫入前，遇到 await 中間的刪除就會漏。
- 模擬「已 abort 但仍會回來」與「寫入中途被刪」是兩種不同情境；只做前者會得到假的通過。

---

## 原檔：subject-research

# TODO：「不認識的東西先去查」還沒做的（設計缺口）

設計與已做的見 DESIGN.subject-research.md。使用者的決定（2026-10-26）：找現成 OBJ 用 GitHub 公開的；找圖再 3D 化的圖片來源用 imgur、Google 圖片、維基；預設直接下載、不問，只放記憶體與 IndexedDB，不存成檔案。

- **瀏覽器控制搜尋沒有連上真正的擴充功能測過**：三個抽取腳本在真實頁面驗證過、流程用假的擴充功能驗證過；GitHub 程式碼搜尋登入後的頁面結構沒看過（抽取同時看 `/blob/` 連結與內嵌 JSON）。沒開瀏覽器控制時的備援：imgur／Google 要使用者自己的金鑰（`imgurClientId`、`googleSearchKey`＋`googleSearchCx`），設定畫面還沒有填這三個值的欄位（現在要改 `advancedSettings`）。
- **圖片 3D 化是單面浮雕**：沒有背面的真實貼圖、沒有側面厚度的牆（`wall_faces` 為 0）；要做真的立體需要多視角或鏡射補背面。
- **2D 還沒做的**：找到的平面圖用程式描摹成向量（`FaSvgTrace`，視覺模型只負責命名與評分），目前只做了「視覺模型整理成部位」；`/edit-picture` 只用文字外形資料（它的物件是點陣圖層，放不進 SVG 素材）。
- **沒有用真實線上模型量過改善多少**：只驗證了接線（資料確實送進編輯器的模型、快取、離線略過、畫圖路線共用）。
- **GitHub 搜尋命中率**：只用專案搜尋（程式碼搜尋要登入）；可以再加專題標籤（`topic:3d-models`）與常見模型集合專案的清單。

---

## 原檔：topic-switch

# 話題更動檢查開關（topicShiftCheck）

日期：2026-11-04　分支：desktop-app　負責：子工作階段（Haiku）

## 背景

使用者原話：「我在評估我們還有沒有需要檢測'話題更動' 來避免執著 可以把檢查的功能做成configure的LLM基礎設定，預設不檢查話題更動，因為目前架構還不錯，且長期的對話應該也會隨著拉遠而不再執著」「這個每一句對話都要等一下很不好」。

現況：`executeChat` 裡 `await this._checkTopicTransition(userText)`，訊息數 ≥ 3 後每則都會阻塞呼叫一次模型；判成話題轉移時再多一次摘要呼叫。目前沒有任何開關。

## 目標

- 新增設定 `advancedSettings.topicShiftCheck`，布林，**預設 false**。
- 關閉時：`executeChat` 完全不呼叫 `_checkTopicTransition`，不產生話題摘要，也不把舊訊息換成摘要。
- 開啟時：行為與現在完全相同。

## 步驟 1 — 行號盤點（已用 Grep / Read 驗證，2026-11-04）

來源檔：`renderer/src/floating-assistant.js`（只改來源，不改嵌入複本）

| 行號 | 內容 | 本功能要做的事 |
|---|---|---|
| 57009 | `this.advancedSettings = this._loadAdvancedSettings();`（建構子載入） | 不用改 |
| 57695 | 預設值區塊，`image3dMaxFaces: 60000,` 所在行 | **加 `topicShiftCheck: false,`** |
| 59003 | `_normalizeAdvancedSettings(raw)` 開頭 | 不用改 |
| 59125 | normalize 內 `image3dMaxFaces: (() => …)()` | **加 `topicShiftCheck: raw.topicShiftCheck === true,`** |
| 59320 | `_loadAdvancedSettings` 讀 localStorage 後呼叫 normalize | 不用改（經過 normalize 即得 false） |
| 59328 | 讀取後再 normalize 一次 | 不用改 |
| 59330 | `_saveAdvancedSettings` 寫 localStorage | 不用改（整個物件序列化，欄位自動保存） |
| 82114 | 匯出：`advancedSettings: JSON.parse(JSON.stringify(this.advancedSettings))` | 不用改（整包複製，欄位自動帶出） |
| 82237–82238 | 匯入：`this._normalizeAdvancedSettings(config.advancedSettings)` | 不用改（經過 normalize 即得 false 或保留的 true） |
| 66612 | 離線判斷 `FaVlm.shouldUseOfflineLlm(d, this.advancedSettings)` | 無關，不動 |

`image3dMaxFaces` 另外出現在 `renderer/src/edit/edit3d_host.js:211–220`、`:327` 與 `floating-assistant.js:37667–37783`，那些是圖片轉 3D 的面數 UI，與本功能無關，不動。

## 步驟 3 — 核取方塊（已完成，2026-11-04）

- 面板代號：`llm-basic`（「LLM 基礎設定」，約 81596 行的標籤對照；`data-pane="llm-basic"` 在 105475 行）。使用者說的 Configure 即此對話框（`_openAdvancedModal` 在 80980 行）。
- 新增核取方塊 `#ai-topic-shift-chk`：105488 行起的 HTML（checkbox＋標籤＋說明）；同步在 `_renderAdvancedSettings` 的 81672–81673 行；點擊寫入事件在 108407 行起（呼叫 `_saveAdvancedSettings`）。
- 另一份 UI 查證：`renderer/index.html` 只有 CSS 覆蓋（`.ai-advanced-*`），沒有「LLM 基礎設定」或任何 `ai-*-chk` 控制項，對話框 DOM 來自 `floating-assistant.js`。因此沒有第二份需要改的面板。
- 評估：`scripts/eval/topic_shift_ui.eval.js`（真 Electron）通過：控制項存在、標籤正確、預設未勾、點擊後設定值 true、再點回 false。
- 注意：`renderer/floating-assistant.js` 必須重建（`node scripts/embed-code-ui.js && node build-assistant.js`）後評估才看得到新控制項。

## 步驟 4 待確認

- `executeChat` 中 `_checkTopicTransition` 呼叫處（約 102549 行，需以 Grep 重新確認）。
- `_checkTopicTransition` 定義處（約 95871 行，需以 Grep 重新確認）。

## 步驟 4 — executeChat 加條件（已完成，2026-11-04）

- 改動：`renderer/src/floating-assistant.js` 約 102553 行，`executeChat` 的 `_checkTopicTransition` 呼叫改為 `if (this.advancedSettings.topicShiftCheck === true) await this._checkTopicTransition(userText);`，`stopRequested` 檢查保留。
- `_checkTopicTransition` 是唯一呼叫處（Grep 驗證）。`topicData.currentTopic` 只在它內部讀寫，其餘只有重設（約 79551、106615 行），關閉時沒有殘留依賴。
- 評估檔：`scripts/eval/send_latency.eval.js` 改成兩組（先 `_clearChatHistory()` 再送同樣三則），`off`＝預設、`on`＝開啟。

### 量測（真桌面版，2026-11-04）

| 則 | 修前（舊程式，無論設定都判斷） | 修後 off（預設） | 修後 on（開啟） |
|---|---|---|---|
| 1 畫貓 | 步驟有跑但無模型呼叫（訊息數不足 3 就提早 return）→ 主模型 | 主模型 | 步驟有跑但無模型呼叫 → 主模型 |
| 2 創作音樂 | 判斷 → 摘要 → 主模型 | 主模型 | 判斷 → 摘要 → 主模型 |
| 3 再畫狗 | 判斷 → 主模型 | 主模型 | 判斷 → 主模型 |

- 修前第 1 則：`_checkTopicTransition` 有出現在步驟列，但模型呼叫只有主模型（訊息數不足 3 會提早 return）。
- 修後 off：三則都沒有 `_checkTopicTransition` 步驟，模型呼叫只有主模型。第 2 則沒有判斷與摘要。
- 修後 on：與修前第 2、3 則完全相同（判斷 → 摘要 → 主模型；判斷 → 主模型），證明開啟時行為不變。
- 第 2 則修前耗時約 29.9 ms、修後 off 約 11.9 ms（同一機器單次量測，僅供參考，不是統計結論）。

## 驗證總結

- 步驟 2：`scripts/eval/topic_shift_setting.eval.js` 真桌面版全部通過（預設 false、舊設定 false、只接受布林、匯出匯入保留 true）。
- 步驟 3：`scripts/eval/topic_shift_ui.eval.js` 真桌面版全部通過（核取方塊存在、預設未勾、點擊改設定值）。
- 步驟 4：`scripts/eval/send_latency.eval.js` 真桌面版，見上表。
- 每次評估都在全新暫存資料夾、換埠（17941–17944）執行；每次都先重建嵌入檔才評估。
- 評估載入的是工作目錄的實作：修後 off 組沒有判斷步驟，修前有，這個差異只可能來自本次改動。

## 教訓

（若走歪，在此新增一條：錯在哪、下次怎麼做）


---

## JSONL 分頁器與檢視器（2026-11-05，唯讀調查後的設計）

**進度（2026-11-05）**：分頁器、總截斷轉 JSONL、`big_content page`、讀取帳本四個缺口、VLM 拆解的 JSONL 續傳**已實作並移到 `DESIGN.jsonl-paging.md`**（含調查實證與測試）。下面的設計全文保留；**2.6 檢視器已做（2026-11-05，見 `DESIGN.jsonl-paging.md` 第八節；僅缺 JSONL 超大檔行索引虛擬捲動）。還沒做、仍是待改善的**：2.5 的「一次問答最多讀幾頁」預估與離線小模型的比例調校、`knowledge_ask`／`repo_*` 帶 `_page` meta。

使用者原話（2026-11-05）：「tool 的超大 json 回應都統一 jsonl 格式，並提供 paginator，要有辦法讓 ai 可以完整讀完。然後我們 viewer 也要支援 jsonl、jsonc」。
標記：【確認】＝這次讀程式確認過；【推測】＝沒親眼驗證。行號是 `renderer/src/floating-assistant.js`（簡稱 FA）在 2026-11-05 的行號，會漂移，改之前先用內容搜尋。

### 一、現況（調查結果）

**1. 大回應現在怎麼處理**

分頁欄位已經有，但各工具各說各話：

| 工具／來源 | 分頁欄位 | 單位 | 單頁上限 | 位置 |
|---|---|---|---|---|
| `parse_uploaded_file`、`fetch_web_page`（抓下來變 file_id 再讀） | `has_more`、`next_offset` | 字元 | 內容窗口 10%（下限 8000 字元） | FA 66516 `_pageText` 【確認】 |
| `browser_get_page_text` | `has_more`、`next_offset` | 字元 | 預設 12000 | FA 62449、擴充功能 `background.js:111-145` 【確認】 |
| `article_section` | `has_more`、`next_offset` | 字元 | 參數 | `tools/article_outline.js:136` 【確認】 |
| `repo_read_doc` | `has_more`、`next_offset` | 字元 | 同 `_pageText` | FA 73051 【確認】 |
| `repo_wiki` 單頁 | `has_more`、`next_offset` | 字元 | 3500～14000 | FA 74055 【確認】 |
| `repo_wiki` 頁面清單 | `has_more`、`next_offset` | 筆（固定 40） | 40 筆寫死 | FA 73854 【確認】 |
| `repo_*` 清單類（results、nodes、entries…） | `has_more`、`next_offset`、`<欄位>_total`、`paging_note` | 筆 | 工具結果預算 60% | FA 73383 `_repoApplyBudget` 【確認】 |
| `coding_read_file` | `has_more`、`next_start_line` | 行 | 內容窗口 10%（下限 6000） | FA 74950 【確認】 |
| `knowledge_detail` | `truncated`、`next_line` | 行 | 來源模組內決定 | FA 20981、21238 【確認】 |
| `knowledge_ask` | **沒有**，只有 `limit`（預設 5） | — | 無續讀 | FA 57824 【確認：參數只有 question、sources、limit】 |
| 其他沒有自己分頁的工具 | 沒有 | — | 超過就被總截斷 | 見下 |

同一個欄位名 `next_offset` 有兩種意思：字元位置，或第幾筆。AI 與讀取帳本都得靠工具名猜，這是缺口之一。【確認】

**總截斷與暫存**（所有沒分頁的大回應最後都走這裡）：`_toolResultBudgetChars()`（FA 80284）= 自動代理模式內容窗口 25%（下限 16000 字元），一般模式 15%（下限 8000）；字元／token 估 3 比 1（FA 1372）。超過就 `_truncateToolResultForContext`（FA 80309）：完整內容放進 `_bigStash`（代號 `bc_N`，總量上限 120 MB，滿了丟最舊的），只回開頭＋JSON 結構概要；AI 要用 `big_content` 工具（FA 63838）讀，動作有 `info`、`read`（offset＋length）、`grep`、`json`（路徑）、`js`（15 秒 Worker）。【確認】

**離線自動讀完**：`_faOtFollowAll`（FA 3503）只服務 `fetch_web_page`、`browser_get_page_text`，最多 `FA_OT_MAX_PAGES = 5` 頁（FA 3467，寫死常數）；沒讀完會回 `has_more:true`＋`read_chars`。python 橋 `pw.text` 最多 40 頁×100000 字（FA 70790）。【確認】

**讀取帳本**（`agent/read_ledger.js`，純函式，嵌入版 `FA_READ_LEDGER_SRC` FA 4593）：看到 `has_more:true`、`chunk.hasMore` 或「`truncated` 且有續讀位置」就記下來源，同來源回一個沒有 `has_more` 的結果就清掉（`read_ledger.js:46-72`）。最終回答前 `_readLedgerGate`（FA 89715）最多提醒 3 次，之後放行並附警語。【確認】

**帳本的四個缺口**（這是「讓 AI 完整讀完」真正要補的地方）：
1. **沒有覆蓋範圍**：只記「下一個位置」。AI 跳到最後一頁（沒有 `has_more`）會把整個來源清掉，中間沒讀的部分不會被發現（`read_ledger.js:62-66`）。【確認】
2. **總截斷看不到**：帳本是在 `_pushToolResultMessage` 之前用「工具原始結果」記的（FA 107451），截斷發生在後面的 `_formatToolResult`，所以被 `bc_N` 截斷的大回應完全不在帳本裡，AI 沒讀完也不會被提醒。【確認】
3. **`big_content` 的 `read` 沒有 `has_more`**，只有 `next_offset`（FA 63850 附近），帳本不認得。【確認】
4. **提醒 3 次就放行**，沒有「一定要讀完或明確回報讀不完的原因」的硬條件。【確認】

**2. 檢視器現況**

- `dataview/data_core.js:18`：`detectFormat` 把 `jsonc`、`json5` 的提示都歸成 `json`；但 `parse` 用嚴格 `JSON.parse`（`data_core.js:189`）。所以 `.jsonc` 有註解或尾逗號會**解析失敗**，只是副檔名表放行了。【確認】
- **`.jsonl`／`.ndjson` 完全沒有檢視器支援**：`_dataViewOpenFile` 只放行 `csv、tsv、json、jsonc、yaml、yml、toml`，其他走「格式還不能用檢視器開」（FA 100997 一帶）；`_mountDataViewers` 的 `LANGS`（FA 100972）、`VIEWABLE`（FA 101024）、離線「打開」種類表 `offline/intent_gate.js:61`（`exts` 有 `jsonc`、沒有 `jsonl`／`ndjson`；FA 47022 是嵌入的同一份）、`/view` 判斷（FA 55119，只認 `jsonc?`）都一樣。【確認】
- 已有的零星處理：知識庫匯入把 `jsonl`／`ndjson` 當「每行一筆記錄」，位置標記是 `record`（FA 20826、57024）；`TEXT_EXT` 認 `jsonl`（FA 26419）；MCP 設定檔安裝認 `.json`／`.jsonc`（FA 100720，註解怎麼處理由 `FaMcp.parseConfigText` 決定，【推測】沒讀）；匯出追蹤用 `application/x-ndjson`（FA 103369）。這些都不是檢視器。
- `parse_uploaded_file` 的說明沒列 `jsonl`（FA 62561 附近）【確認】；實際行為【推測】會被當純文字。
- 上色器已有註解類別 `c`（`data_core.js:212`），可重用。

**3. 弱模型與離線小模型**

現有「自適應」是 `_getAdaptiveContentBudgetChars(fraction, floor)` = `max(floor, 內容窗口token × fraction × 3)`（FA 59835）。比例對了，但**下限寫死**：8000／6000／3500 字元對只有 4096 token 的離線小模型已經是整個窗口的 2/3，會直接炸。新分頁器的下限必須是「一筆記錄」而不是固定字元數。

### 二、設計

**原則**：①只有「超大且結構是記錄清單」的 JSON 才轉 JSONL；字串／文字類（網頁、PDF、程式碼）本質不是記錄，維持字元或行分頁，只統一欄位與覆蓋追蹤。②舊欄位全部保留，新欄位只加不改（舊版已安裝的使用者收得到熱更新、舊對話與舊帳本資料照常運作，不要求重裝）。③大小一律跟 `contextWindowTokens` 按比例，不寫死常數。④「讀完」由程式判斷，不聽模型說。

**2.1 統一回應格式（給模型看的）**

大 JSON 的分頁結果＝**第一行是 meta 的 JSON 物件，其後每行一筆記錄**：

```
{"_page":{"source":"bc_3","page":2,"from":41,"to":80,"returned":40,"total":312,"total_exact":true,"has_more":true,"next_cursor":"c1.bc_3.80","limit":40,"limit_basis":"ctx*0.1","digest":"a1b2c3"}}
{"id":41,"name":"..."}
{"id":42,"name":"..."}
```

- `from`／`to`：第幾筆（0 起算，半開區間 `[from,to)`）；`total` 已知給確切值，只能估時給 `total_estimate` 並讓 `total_exact:false`。
- `next_cursor` 是不透明字串（格式版本＋來源＋位置），模型只能原樣帶回；程式端驗證，亂填回錯誤而不是亂讀。最後一頁 `has_more:false`、`next_cursor:null`、多一個 `done:true` 與 `read_records`／`total`。
- 同時保留舊欄位 `has_more`、`next_offset`（語意同該工具原本的），不遷移、不改名；新欄位 `next_cursor` 與 `next_offset` 並存，舊帳本只認 `has_more` 照樣有效。理由：`next_offset` 目前有「字元」「筆」兩種意思，硬統一會讓 `_repoApplyBudget`、`_faOtFollowAll`、python 橋同時壞；風險是欄位重複佔幾十字元，可接受。
- 單筆記錄比一頁還大：不丟棄、不截斷，用 `part` 續傳（`next_cursor` 指到同一筆的第 N 段，meta 標 `record_part`）；模型看到 `record_part` 就知道這筆沒完。
- 回應整個是字串、第一行起不是單一 JSON 時，內部呼叫者（`_faOtFollowAll`、python 橋）仍可用舊路徑；所以分頁格式**只套在「給模型看的最後一步」**（見 2.3），工具內部傳遞的 JSON 結構不變。

**2.2 分頁器模組（純函式）`renderer/src/agent/jsonl_pager.js`**

UMD、無 DOM、無 I/O、可 `new Function` 載入（跟 `read_ledger.js` 一樣），測試檔 `jsonl_pager.test.js`。介面（暫定）：

- `toRecords(text|value)` → `{ records, shape }`：頂層是陣列→每筆一個元素；頂層是物件且有唯一占大宗的陣列欄位→記錄是該陣列，其餘欄位進 `head`（第一頁一併給）；JSONL／NDJSON 文字→逐行（壞行保留為 `{"_bad_line":n,"raw":"…"}`，不丟）；其餘（純量、沒有大陣列的物件）→回 `null`，呼叫者退回現行截斷。
- `pageSize({ ctxTokens, fraction, avgRecordChars })` → 筆數：`max(1, floor(ctxTokens × fraction × 3 / avgRecordChars))`，**沒有字元下限，只有至少 1 筆**；`fraction` 沿用 `_toolResultBudgetChars` 的 0.15／0.25，離線小模型另外給更小的比例（待實測，不先寫死）。
- `page(records, cursor, opts)` → `{ meta, lines, nextCursor }`；`encodeCursor`／`decodeCursor`（含檢查來源、版本、範圍）。
- `digest(lines)`：短雜湊，給帳本核對「這一頁真的拿到過」。
- 壞輸入（空、循環、超深）回明確錯誤物件，不拋例外。

**2.3 接線（最小改動順序）**

1. **`_truncateToolResultForContext`（FA 80309）**：超過預算且 `toRecords` 成功時，不再「只放開頭＋概要」，改回**第 1 頁 JSONL**（meta 裡 `source` 就是 `bc_N`）。`toRecords` 回 null 才走原本的截斷。
2. **`big_content` 加 `page` 動作**（`cursor` 參數）；`info` 回應加 `records`、`shape`；`read` 回應補 `has_more`。`json` 動作遇到 JSONL 文字改逐行解析而不是整體 `JSON.parse`（現在會直接報「不是合法 JSON」，FA 63860 附近）。
3. **帳本改在格式化後的版本再記一次**：`_noteReadLedger` 現在吃原始結果；新增「截斷／分頁後的 meta」記錄，補缺口 2。
4. 有自己分頁的工具（`repo_*` 清單、`repo_wiki` 清單、`knowledge_ask` 加 `offset`）：結果照舊，只多帶 `_page` meta 與 `next_cursor`；`knowledge_ask` 目前根本不能續讀，是最小風險的補丁。
5. 文字類工具（`parse_uploaded_file`、`fetch_web_page`、`browser_get_page_text`、`article_section`、`repo_read_doc`、`coding_read_file`、`knowledge_detail`）**不轉 JSONL**，只讓帳本的覆蓋追蹤吃它們的 `offset`／`next_start_line`／`next_line`。

**2.4 讀取帳本升級（相容）**

`read_ledger.js` 的 entry 加選用欄位：`covered`（已讀範圍的區間陣列，單位在 `unit`：`record`／`char`／`line`）、`total`、`totalExact`、`digests`。舊 entry（沒有這些欄位）照舊邏輯運作；新欄位缺席時不報錯。

「讀完」的**程式可檢查條件**（全部成立才算）：
1. 有 `total` 且 `totalExact` 時，`covered` 合併後恰好覆蓋 `[0,total)`；`total` 只是估計時，改要求「已收到 `done:true` 的最後一頁」且區間從 0 連續到最後。
2. 中間有洞（跳頁）→ 回報洞的範圍（「第 41～80 筆還沒讀」），仍是 blocking，不會因為讀到最後一頁而清掉。
3. 帶 `record_part` 的記錄必須讀到該筆最後一段。
4. 最終回答的閘門：條件 1～3 不成立就**一律擋**，模型必須續讀、或明確回報無法讀完的原因（例如被使用者停止、來源被清掉）；現行「提醒 3 次就放行」改成：3 次後仍擋一次並要求模型在答案前段寫出「只讀了第 a～b 筆，共 n 筆」，且這段警語由程式附加，不靠模型自己寫。
5. `bc_N` 被 `_bigStash` 淘汰（超過 120 MB）時，cursor 解析失敗要回「來源已清掉，請重新呼叫原工具」，帳本把該來源標為失效而不是已讀完。

**2.5 上限**

- 單頁：`pageSize` 算出的筆數，至少 1 筆。
- 一次問答最多讀幾頁：不寫死；以「模型內容窗口＋已用量」估算還容得下幾頁，容不下就由程式提示「請先摘要已讀內容再繼續」（跟既有 `fitToBudget` 的 placeholder 機制銜接，FA 7674），而不是無限續讀。【這段要實測，先寫成待改善】
- 暫存總量沿用 120 MB；單一來源超過就只分頁暫存的前段，meta 標 `source_truncated:true` 與實際收了多少。
- `FA_OT_MAX_PAGES = 5`（離線自動讀網頁）維持，但 `has_more` 回報要帶 `covered`，離線流程才不會把 5 頁當全部。

**2.6 檢視器**

*共通*：`data_core.js` 新增格式 `jsonl`、`jsonc`（不再把 jsonc 併進 json）。`detectFormat` 提示 `jsonl`／`ndjson`→`jsonl`；`jsonc`→`jsonc`；`json5` 暫時維持現狀並在說明中寫明不支援尾逗號之外的語法。`.json` 嚴格解析失敗時，**不悄悄重試**：重試為 jsonc 成功就顯示徽章「這份 JSON 含註解／尾逗號，以 JSONC 解析」。

*`.jsonl`／`.ndjson`*：
- 逐行解析，空行略過但計入行號；每筆記下原始行號；`\r\n`、BOM、最後一行沒換行都要處理。
- **壞行不讓整檔失敗**：壞行進「壞行」清單（行號＋錯誤訊息＋原文前 200 字元），主表格照樣顯示好的；畫面頂端顯示「共 N 行，M 行無法解析」。
- 記錄是物件→套現有「JSON→表格」（設計文件第二節）；不是物件→單一 `value` 欄；欄位聯集上限沿用現有表格規則。
- 大檔：用 `Blob.slice` 分塊掃描建「行起點索引」（只存 Uint32 位移），表格虛擬捲動，每次只解析可見視窗±緩衝的行；現行 100 MB 上限（FA 100997）對 JSONL 放寬到按索引記憶體估算（待量，先維持 100 MB 並明說）。
- 複製／匯出一律輸出**原始行**，不重新序列化（避免改鍵順序、大數字精度）。檢視器是唯讀，不做「格式化」。

*`.jsonc`*：
- 專用解析：字串內的 `//`、`/*` 不算註解（`"http://x"`）；支援 `//` 單行、`/* */` 區塊（不巢狀）、物件／陣列尾逗號；未結束的區塊註解回錯誤並帶行列。解析結果除了 `data`，另回 `comments:[{line,col,kind,text}]` 與 `trailingCommas`。
- **不能悄悄丟註解**：原文檢視（上色，註解用既有類別 `c`）永遠保留全部註解；樹狀／表格檢視因為資料模型沒有註解，頂端顯示「含 N 則註解，原文檢視可看」；任何會重新序列化的動作（現有格式化，`data_core.js:295` 的 `JSON.stringify(JSON.parse(…))`）對 jsonc 一律停用並說明原因，不得輸出沒有註解的版本當成「格式化結果」。
- 檢視器的「儲存／匯出」若有，匯出原文。

*同步位置（改來源模組，不要改嵌入後的 `floating-assistant.js`；做完用 `scripts/embed-code-ui.js` 重產，見記憶「嵌入的來源模組」）*：`dataview/data_core.js`、`dataview/data_ui.js`、`offline/intent_gate.js:61`（`exts` 加 `jsonl`、`ndjson`，`nouns` 加 `jsonl|ndjson|jsonc`，label 改成「資料檢視器（JSON／JSONL／JSONC／YAML／TOML）」）、`DESIGN.data-viewers.md` 第二、四節、FA 內 `LANGS`／`VIEWABLE`／`_dataViewOpenFile` 清單／`/view` 判斷（FA 55119）／失敗訊息（列出可開格式）。`parse_uploaded_file` 說明補上 `jsonl`，行為為每行一筆並走分頁器。兩份 AI 設定畫面無關，這次不涉及。

### 三、先做哪些、風險

| 順序 | 內容 | 大小風險 | 備註 |
|---|---|---|---|
| 1 | `jsonl_pager.js` 純函式＋測試 | 小 | 無接線，零風險，可單獨發布 |
| 2 | 檢視器 `jsonc` 容忍解析、`jsonl` 檢視（含壞行、虛擬捲動）、種類表同步 | 中（虛擬捲動） | 與分頁器無相依，可平行 |
| 3 | `big_content` 加 `page`／`read` 補 `has_more`；`_truncateToolResultForContext` 對記錄清單改回第 1 頁 | 中 | 最大收益：目前所有沒分頁的大 JSON 都走這裡 |
| 4 | 帳本覆蓋範圍＋截斷後記帳＋最終閘門條件 | 中高（會改行為，可能讓舊對話多擋幾次） | 先只對有 `_page` meta 的來源生效，舊來源行為不變 |
| 5 | `knowledge_ask` 加 `offset`；`repo_*` 清單帶 `_page` | 低 | 欄位只加不改 |
| 6 | 離線小模型的 `fraction` 實測調校、頁數預估（2.5） | 待量 | 列待改善，不阻擋 1～5 |

主要風險：①把回應第一行改成 meta，會讓**只解析整串 JSON 的呼叫者**壞掉——所以分頁格式只套在給模型看的最後一步，內部呼叫路徑不變，並加測試鎖住；②模型可能對 JSONL 不熟，meta 的 `next_cursor` 要在說明裡用一句話講清楚，並在每頁尾端附一行中文提示（跟現有 `page_hint` 同風格）；③雜湊／區間記帳讓帳本變大，要限制每來源區間數並合併；④熱更新：新模組是新增檔案、舊用戶端沒有就維持舊行為，帳本資料新欄位全選用，不必重裝；不動 `renderer/update-manifest.json` 的決定交給管理層發版時處理。

### 四、測試計畫

**分頁器**（`jsonl_pager.test.js`，`new Function` 載入，語料如下）：
- 頂層陣列 1／40／10000 筆；頂層物件含一個大陣列＋其他欄位；巢狀大陣列；純量；空陣列；非記錄物件（回 null）。
- 單筆比一頁大（`record_part` 續傳，串回去逐字相等）；中文、emoji、含換行的字串（JSONL 一筆不能含實體換行，序列化要用 `JSON.stringify`）。
- 內容窗口 2048／4096／32768／1000000 token：每頁至少 1 筆、頁大小隨窗口單調增加、沒有出現寫死的下限常數（掃描原始碼斷言）。
- 逐頁讀完串回去 ＝ 原資料（逐筆相等，總筆數＝total）；cursor 竄改、過期、來源不符都回明確錯誤。
- 反例：中途丟掉一頁、重複讀同一頁、反向讀、跳到最後一頁。

**帳本**：覆蓋區間合併（相鄰、重疊、重複、亂序）；跳到最後一頁**不得清掉**中間的洞（現行行為的回歸測試，這是缺口 1）；`total` 估計與確切兩種；舊 entry 沒有新欄位時行為與現在完全相同（把現有 `read_ledger.test.js` 全部保留跑一遍）；`bc_N` 被淘汰後標失效。

**整合**：假工具回 5 MB 記錄清單，經 `_formatToolResult` 得到第 1 頁；用假模型逐頁呼叫 `big_content page` 到讀完，閘門放行；中途想結束就被擋；內部呼叫者（`_faOtFollowAll`、python 橋）對同一工具輸出照常 `JSON.parse`。

**檢視器**（`data_core.test.js` 擴充）：
- `jsonl`：好行＋壞行混合、全壞、空檔、只有空行、`\r\n`、BOM、最後沒換行、記錄為純量／陣列／巢狀物件、10 萬行（索引建立時間與記憶體量測）、單行 1 MB。
- `jsonc`：行註解、區塊註解、字串裡的 `//` 與 `/*`、轉義引號後接 `//`、尾逗號（物件與陣列）、未結束區塊註解（帶行列）、註解在最前／最後、空檔、純註解；解析後 `comments` 數量正確；格式化動作被停用。
- 反例：把有註解的 `.json` 以嚴格模式解析→明確錯誤並顯示徽章；`json5` 的單引號、無引號鍵→維持報錯，不假裝支援。
- 種類表：離線說「打開 log.jsonl／config.jsonc」→ 命中 `data`；`intent_gate` 既有測試全過。

**真人驗證（另列，不放待辦）**：1 GB 級 JSONL 的實際捲動順暢度；離線小模型（4096 token）實際逐頁讀完一份 5 MB 清單並正確回答。

### 五、工作量、同意事項、建議第一階段

- 工作量：分頁器＋測試約 0.5 天；檢視器（jsonc 解析＋jsonl 檢視含虛擬捲動＋種類表）約 1.5 天；`big_content`／截斷接線約 0.5 天；帳本覆蓋與閘門約 1 天；其餘小項各 0.25 天。總計約 4 天。
- 使用者同意：本案**不涉及下載**，不需要新的同意流程；行為變化（最終回答被擋得更嚴）寫進發版說明。
- **建議第一個可發布的小階段**：步驟 1＋2 的 `jsonc` 部分——`jsonl_pager.js` 純函式（無接線、可測）加 `data_core.js` 的 `jsonc` 容忍解析與「註解不丟」規則、`jsonl`／`ndjson`／`jsonc` 同步進離線種類表。理由：不碰工具回應與帳本，不會影響既有對話；現況 `.jsonc` 有註解就解析失敗是現在就看得到的缺陷；`jsonl` 檢視（含虛擬捲動）可緊接為第二階段，再來才接 `big_content` 與帳本。

---

## 原檔：block-writer（程式區塊寫程式）

> 2026-11-06。設計與現況見 `DESIGN.ast-nodes.md` 第六、七節（7.2 是課與內建）與 `DESIGN.offline-trainer.md` 5.1（老師迴圈的驗證擴充）；程式在 `renderer/src/uml/`（`algo_intent_core.js`、`py_uml_pipeline_core.js`、`py_lessons_core.js`、`py_lessons_builtin.js`、`py_blocks_*_core.js`、`py_cnl_choose_core.js`、`py_code2uml_core.js`）與 `renderer/src/harness/teacher_check_core.js`；測試與端到端見各 `*.test.js`、`scripts/e2e/teacher_loop.e2e.mjs`、`scripts/teach-builtin-lessons.js`。`/teacher-loop` 是 `/offline-trainer-by-ai` 的別名。

**使用者定的流程**：UML 任務切割（`uml_design`）→ 程式骨架（UML codegen）→ 區塊迴圈〔程式算符號表（庫存）→ 庫存過濾合法選項 → 嚴格範本（For／While 防呆）〕→ 模型只在合法庫存內做微型選擇 → 沙盒驗證 ⇄ 錯誤回饋；函式 body 固定三區（引入、宣告、邏輯與流程）；Claude 教會之後要內建進去。

**已完成**
- `uml_design` 讀算法題（`opts.readers`＋`FaAlgoIntent`）：20 題全部讀出 UML，0 次模型；動作表給算法種類與範式。
- 老師教、內建進去：17 堂課（判題器含隱藏測資驗證、回歸、無退回），**離線自己解決（不問任何模型）3/20 → 20/20**；沒見過的改寫 16/16。
- `/offline-trainer-by-ai`（別名 `/teacher-loop`）擴充：項目可帶 `check`（contains／regex／equals／judge），離線做對＝通過驗證；老師教完離線要自己重做通過；回歸；回滾；真 Electron 端到端驗證。
- 區塊庫 130 個陳述範本＋103 個運算式積木（科學：math、numpy、statistics、random、scipy、matplotlib 繪圖；矩陣：mat_mul／mat_pow／numpy 矩陣乘冪），庫存與範本規則（三區、型別、終止條件、模組要先引入）；程式碼→UML→程式 46 個真實檔 AST 全相同。

**未完成（依序）**
1. （**27 個已做**，見 `DESIGN.ast-nodes.md` 7.3；2026-11-06 補了回溯 N 皇后、Dijkstra、樹狀陣列、KMP；仍缺：排列組合回溯、線段樹（區間更新）、Z 函式…）**範式骨架庫（處理模型）**：分治（divide-and-conquer）、DFS、BFS、樹走訪（前序／中序／後序／層序）、資料結構對應（雜湊、堆疊、佇列、堆積、並查集）、動態規劃（一維、二維、背包、區間）、矩陣快速冪（線性遞推、轉移矩陣、路徑計數）、前綴和、二分、雙指標…；每個範式一個帶槽位的區塊骨架（槽位用小選單選：狀態是什麼、轉移是什麼、終止條件是什麼），動作表從敘述的特徵挑範式；課變成範式的實例。這是讓「新題」不必逐題教課的關鍵。
2. （**`write_code` 接離線組合、`/teacher-loop` 離線試做、`deriveLesson` 執行期存課都已做**）**宿主接線**：`write_code` 接 `uml_design → 課／配方 → 區塊迴圈 → 沙盒`（`py_*` 模組要用 `embed-code-ui.js` 嵌入、前端要有 tree-sitter 解析）；內建的課要載入；`/teacher-loop` 對寫程式項目要能「離線試做」走這條管線，老師成功後用 `deriveLesson` 抽成課存進訓練器（執行期的課，另外存、可匯出成內建）。目前老師迴圈的驗證擴充已通用（contains／regex／equals／judge），但寫程式的離線組合還沒接進產品。
3. **模型的選擇仍弱**：0.6B 在合法選單裡接近隨機（同題換選項順序答案就變；逐項是／否 0/4；開思考 8 次只對 2 次）。現在能靠內建的課避開，但新算法仍需要：範式骨架把選單壓到 1～4 個；目標動詞過濾選單；規則再緊（題目有輸入就一定先讀入、常數只能來自題目）。
4. **讀取器覆蓋範圍小**：輸入格式只認種子題規整的句型；要擴充（多組測資、二維陣列、含空白字串、整數範圍）、輸出格式（多行、保留小數、YES/NO 變體）與更多寫法，並用沒見過的題目持續驗證。
5. **積木庫擴充（越大越好）**：字串處理、二維走訪、DP 表、圖演算法、遞迴、類別方法；scipy、pandas、matplotlib 子圖、3D；每個新積木補型別表（`py_blocks_lib_core.js` 的 `TYPES`／`ETYPES`／`REQ`）與反推測試；槽位型別再細（list 元素型別）。
6. **其他語言**：tree-sitter 的 wasm 已有（nodejs、c、c++、java、ruby、perl、bash、C#）；每個語言各自一份區塊庫、規則、課與 codegen，不共用。
7. **效能與大模型**：選擇題每題 2 次前向、提示每次重新編碼，之後用 KV 快取共用前綴；開發期間步數上限維持無限大，做完再 profile。wasm 跑不動較大的模型（除非 transformer 的記憶體能用 IndexedDB 模擬分頁）；Qwen2.5-Coder-1.5B 已下載驗證但目前不用。
