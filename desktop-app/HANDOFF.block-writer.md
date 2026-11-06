# 交接：block-writer（範式骨架庫＋寫程式離線組合接進 write_code）

## 1. 開場提示（接手者收到的原文）

請接續 `desktop-app/HANDOFF.block-writer.md`：完整讀完（含使用者原話與工作方式），照著做，並執行 low-context-long-run 技能（門檻 30%）：做下一個待辦，context 到門檻就寫下一份交接、啟動自己的接手者。第一則訊息請用一行確認你讀了文件、從哪個待辦開始。
使用者原話（2026-11-06）：「接著完成 offline model的DESIGN.TODO的block writer的項目：範式骨架庫(每個範式一個帶槽位的區塊谷架)、寫程式的離線組合(uml_design、課、區塊迴圈、沙河)接進wrie_code」。

## 2. 概況

- repo `tw_stock_db`，資料夾 `/home/hungfu.lee/下載/SRC/tw_stock_db/desktop-app`，分支 `desktop-app`，HEAD `8531a9ed`。Linux、使用者 `automation`；提交與發布走 `ssh hungfu.lee@127.0.0.1`（見 `docs/HANDOFF.md` §3）。
- 已發布 live-update patch v310。**這個工作階段做的事全部未提交、未發布**（使用者規定：「可以都完工再來發布」，只在他說「提交並發布」時才提交發布）：
  - 小窗口／頁數預估／真 Chrome 修 bug／`midi_compose_tree`／`uml_edit` 的 `next`／`queue`／`chooseTool` 堆疊／超大 JSONL 批次視窗等，詳見 `STATUS.md` 最後一節與 `DESIGN.jsonl-paging.md` 第十節；核心測試 198/198（`FA_TS_DIR=/tmp/fa-ts-cache`）。
  - 本次新增、已寫進交接並要一起提交的檔案：`scripts/eval/mini_llama_server.py`、`scripts/eval/stack_consistency.js`、`scripts/eval/small-window.eval.js`、`renderer/src/agent/fixtures/chrome_page_text.json`。
- **還在背景跑**：思考堆疊兄弟一致性的真模型評測（5 情境×3 變體×4 次，約 60 組，寫到 `/tmp/claude-1011/-home-hungfu-lee----SRC-tw-stock-db-desktop-app/ed57e225-734e-4994-a83f-6b40def27751/scratchpad/sc3.log`、結果檔 `sc3.json`，我交接時 46/60）。模型服務是本機 18099 埠（`python3 -I scripts/eval/mini_llama_server.py /var/www/html/check-source-download/crb-status/models/qwen3-0.6b/Qwen3-0.6B-Q8_0.gguf 18099`）。工作階段被封存時這些背景程序可能一起死掉：先看 `sc3.json` 在不在；不在就重起服務、用 `node scripts/eval/stack_consistency.js --url http://127.0.0.1:18099/v1/chat/completions --reps 3 --tries 4 --out <檔>` 重跑（約 30～40 分鐘），把結果（變體：off／stack／checks；欄：完成數、一致性、命名、風格、參照、不重複、一次合格率、呼叫數）寫進 `DESIGN.think-stack.md` 最後一節，並更新 `DESIGN.TODO.md` 現況總覽的「思考堆疊兄弟一致性」那一列。先前小樣本（假的 3 情境）：stack 優於 off 4 次、劣於 0 次、持平 2 次（一致性約 0.97→1.00），尚不能下結論。

## 3. 待辦（依序）

1. **範式骨架庫**（`DESIGN.TODO.md` 原檔：block-writer「未完成 1」；動作表 `algo_intent_core.js` 的 `PARADIGMS` 已給每種算法的範式 key）。我已讀完 `algo_intent_core.js`、`py_uml_pipeline_core.js`、`py_lessons_core.js`，**尚未寫任何程式**。我定的設計：
   - 新檔 `renderer/src/uml/py_paradigms_core.js`（`FaPyParadigms`，UMD，Python 專屬）。每個範式 = `{id, label, applies(intent), slots:[{id,label,options(intent)→[{id,label,...}]}], render(choice,intent)→ solve 的受控自然語言（CNL，用 `py_blocks_core.js` 現有範本的 `line` 寫；沒有對應範本才用 `程式：<一行 Python>`）, check}`。範式先做：一維 DP（費氏／爬樓梯／硬幣最少／LIS）、背包（0/1）、BFS（網格最短步數）、DFS／連通分量（含並查集）、二分（lower_bound）、前綴和、雜湊計數、堆疊（括號）、雙指標（迴文）、數論（gcd／篩法）、矩陣快速冪（用現有 `mat_pow`）、區間掃描合併、排序後取第 k。
   - 槽位用 1～4 個的小選單（狀態是什麼、轉移是什麼、終止條件是什麼…）；**關鍵做法：選單這麼小，就由程式窮舉組合（上限約 12），每個組合交沙盒（判題器）跑範例，第一個 AC 就用**——不靠 0.6B 那個接近隨機的選擇；`pick`（模型）只用來決定窮舉順序，沒有也行。
   - 接進 `py_uml_pipeline_core.js` 的 `buildFromUML`：順序＝配方 → 課 → **範式骨架（新）** → 區塊迴圈（模型）。回傳結果加 `paradigm`、`slots`、`tried`。
   - 驗證：20 題種子（`renderer/src/recipe/seed/problems.jsonl`，判題器 `judge-runner.js`）**在「不給課」的情況下**用範式骨架解出幾題（目標：種子裡有範式的題幾乎全過）；再寫沒見過的改寫（換變數名、換測資、換敘述）當泛化測試。測試檔 `py_paradigms.test.js`，並登記到 `scripts/run-core-tests.js`（tree-sitter 相關的要有「找不到快取就略過」那套，同 `py_lessons.test.js`）。
   - 課變成範式的實例：`deriveLesson` 可記下 `paradigm`＋`slots`（可選，先不做也行）。
2. **宿主接線：`write_code` 接離線組合**（原檔 block-writer「未完成 2」）：`write_code`（單一入口，領域關閉思考）→ `uml_design`（`opts.readers=FaAlgoIntent.reader`）→ 課／範式／配方 → 區塊迴圈 → 沙盒。要做：
   - 用 `scripts/embed-code-ui.js` 嵌入 `py_*` 模組、`algo_intent_core`、`py_lessons_builtin.js`（資料檔，勿手改）、新的 `py_paradigms_core`；前端要有 tree-sitter 解析（看 `FaPyBody`／`py_code2uml_core` 怎麼取 parser；桌面版載入方式參考 `scripts/teach-builtin-lessons.js` 的 `FA_TS_DIR`）。
   - `/teacher-loop` 對寫程式項目能「離線試做」走這條管線；老師成功後用 `deriveLesson` 抽成課存進訓練器（執行期的課另外存、可匯出成內建）。
   - 真 Electron 評估（照 `scripts/eval/small-window.eval.js` 的寫法：`xvfb-run -a node scripts/eval/run_eval.js <評估檔> <埠>`）：離線（不問模型）對 N 題算法題跑完整管線，列出誰過誰沒過。
3. 文件與收尾：`DESIGN.TODO.md` 現況總覽那列、`DESIGN.ast-nodes.md` 第七節（新增 7.3 範式骨架庫）、`STATUS.md`；跑 `node scripts/embed-code-ui.js && node build-assistant.js`、`FA_TS_DIR=/tmp/fa-ts-cache node scripts/run-core-tests.js`（要 198/198＋新測試）。**不要提交發布，除非使用者說「提交並發布」。**
4. 完成後把待辦裡的 3～7（模型選擇仍弱、讀取器覆蓋範圍、積木庫擴充…）如實列成「待改善」，不要假裝做完。

## 4. 工作方式（使用者的規則，原樣照辦）

- 回應用繁體中文或英文，**簡體字絕對不行**；講清楚在做什麼、給看得到的輸出，不要讓使用者猜是不是卡住；誠實區分「我驗證的／別人回報的／推測」；沒達標叫「待改善」，不要說成完成。
- **先讀專案現有的程式再動手**（tree-sitter、離線訓練器、`uml_design`、`/offline-trainer-by-ai` 都早就存在；使用者多次因為沒讀而生氣）。
- 寫程式：每個語言各自一份、不跨語言共用；`write_code` 只有一個入口；`write_code` 領域關閉思考；流程是 UML 切割（`uml_design`）→ 骨架 → 區塊迴圈（庫存過濾合法選項、嚴格範本）→ 模型只在合法庫存內微選擇 → 沙盒 ⇄ 錯誤回饋；函式 body 固定三區（引入、宣告、邏輯與流程）；Claude 教會之後要內建進去。大模型在 wasm 跑不動，所以要讓小模型每一步的選擇更少、更明確。
- 開發期間步數上限維持無限大；有多少 release 多少；下載與安裝先取得同意並列出檔名、來源、大小；熱更新不准要求重裝；版號單調遞增；**不使用埠 17923**；原生執行器不開。
- 提交與發布一律用 `hungfu.lee`（`ssh hungfu.lee@127.0.0.1`，cd 到同資料夾）；`scripts/publish.sh -m … --skip-build` 並帶 `PUBLISH_TRAILER`；建置要先用自己的帳號做完再 `--skip-build`。提交只加自己的檔案（別的工作階段的未提交檔案：`features/FEATURES.md`、`skills/image-decompose-redraw/data/parts_builtin.json`、`DESIGN.edit-*.md`、`DESIGN.env-baseline.md`、`HANDOFF.edit-remote.md`、`skills/weak-model-harness/scripts/bridge/`、`72d21a0c-…` 資料夾都不是我的）。
- 提交訊息結尾加：`Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`。
- 週額度接近 90% 就交接（目前週 76%、5 小時 21%）。
- `docs/HANDOFF.md` 的擁有者是 `stevenyc.huang`，`automation` 寫不進去，不要 chmod；進度寫在 `STATUS.md` 與本檔。

## 5. 使用者原話（逐字，附日期）

- 2026-11-05：「json的檢視器，要支援階層view, source view, 以及table view (轉table,類似excel)，也要支援jsonl, jsonc格式。要可以匯出json, xlsx, sqlite3 把DESIGN.jsonl-paging.md完成」「完成後請把狀態更新到STATUS跟HANDOFF」
- 2026-11-05：「可以都完工再來發布」、「提交並發布」（每次發布都是他明確說這句才發）
- 2026-11-05：「uml-design與midi音樂設計也是 我希望可以藉由這個形式來讓任意窗口的模型都能達成」「我們也可以對於uml-design的遞迴深入，保有原有的結構，但是提供一個flatten-jsonl converter，這個convert出來的結構可以正確對應回去」
- 2026-11-05：「我的想法是只要脈落傳過去，並且它可以當下留下一個"該檢查什麼" 的文字跟標準 就像是在面對一個經常失億的工程師」
- 2026-11-06：「先完成用真的 qwen3-0.6b 量思考堆疊的兄弟一致性。需要有模型的機器，目前只有假模型。」＋「browser_get_page_text 長頁面章節索引，用真的 Chrome 擴充功能實測」「JSONL 分頁的舊待改善」「CoLU 計畫前的路由（chooseTool）建思考堆疊」「MIDI compose_tree 攤平，以及 UML／MIDI 的「小窗口分段寫」」（已做完，見 STATUS.md）
- 2026-11-06：「接著完成 offline model的DESIGN.TODO的block writer的項目 範式骨架庫(每個範式一個帶槽位的區塊谷架) 寫程式的離線組合(uml_design、課、區塊迴圈、沙河)接進wrie_code」
- 寫程式流程（記錄在 `DESIGN.ast-nodes.md` 第六、七節，使用者逐字重點）：UML 任務切割 → 程式骨架生成（Boilerplate）→ 進入 Block 產生迴圈〔① 程式端計算當前 Symbol Table（Inventory）② 用 Inventory 過濾合法區塊選項 ③ 套嚴格 Template（For／While 結構防呆）〕→ 模型僅在合法 Inventory 內做微型選擇 → 沙盒編譯驗證 ⇄ 錯誤回饋。

## 6. 交接程序（自我遞迴）

執行 low-context-long-run 技能，門檻 30%（用 `mcp__ccd_session_mgmt__get_usage` 看自己的 context 百分比，只在一個完成的工作單位之後檢查）。到門檻：改寫這份文件（不要新開一份，保留逐字使用者原話、追加新的）→ 提交這份文件（用 `ssh hungfu.lee@127.0.0.1`，只加自己的檔案）→ `mcp__ccd_session__start_session`（initiation `user_asked`、context `fresh`、同資料夾、標題「block-writer · handoff N」）→ 等接手者確認它讀了文件並開始第一個待辦 → `mark_completed` 再 `archive_session`（被拒就停，告訴使用者哪個 session id 沒封存）。待辦清空且驗證完就不要再交接，直接向使用者報告完成。

## 7. 陷阱

- `scripts/embed-code-ui.js` 會把 `renderer/src/` 模組整份蓋回 `floating-assistant.js` 的嵌入區塊：直接改嵌入區塊的程式會被蓋掉（本次 `knowledge_ask` 與代理迴圈提醒各中一次）。先 `grep -rl` 找來源檔，改完 embed＋build 後 grep 確認還在。
- 核心測試的 tree-sitter 七組在沒有快取時「略過」會被算失敗；快取在 `/tmp/fa-ts-cache`：`FA_TS_DIR=/tmp/fa-ts-cache node …`。
- `pkill -f`／`pgrep -f` 的模式會比對到自己的 bash 指令而殺掉自己：用 `ps -eo pid,args | grep "[x]yz"` 取 pid 再 kill。
- 內建瀏覽器窗格隱藏時 `requestAnimationFrame` 不會跑：要先 `tabs_select`。
- 生 0.6B 連 UML 的參與者階段都過不了（識別字要英文 PascalCase 它做不到）：評測要先由程式回答前兩階段。
- 用內嵌指令寫修補程式會吃掉反斜線與引號：寫成檔案再執行，先在記憶體組好新內容再寫檔。
