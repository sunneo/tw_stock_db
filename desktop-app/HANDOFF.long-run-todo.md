# 交接：四組待辦長跑（HANDOFF.long-run-todo.md）

## 1. Opening prompt（給接手 session 的原文）

Continue from the handoff document at desktop-app/HANDOFF.long-run-todo.md. Read it fully, including the verbatim user words and the working style, and follow them. Run the low-context-long-run skill (THRESHOLD 30%): do the next todo item, and when your context reaches the threshold, write the next handoff and start your own successor. As your first message, confirm in one line that you read the document and which todo item you are starting.
使用者原話：「照以下順序完成」「每完成一個部份就commit patch, deploy(publish patch)」。

## 2. Overview

- 專案 `tw_stock_db`，Electron 桌面版 FloatingAssistant，分支 `desktop-app`，工作目錄 `desktop-app/`（repo 根 `/home/hungfu.lee/下載/SRC/tw_stock_db`）。
- 使用者寫繁體中文；回覆只能繁體中文或英文，不可簡體。
- 本鏈目前**尚未開始實作**四組待辦，只做了讀檔與規劃。HEAD `44c3c3dd`（他 session 的 HANDOFF.todo-1108.md，本地領先 origin 1 個，未推）。`PATCH_VERSION`=341，遠端 manifest.v2 也是 341，下一版 342（發版前跑 `node scripts/release-version.js status` 確認）。
- 他人未追蹤檔，不要碰：`72d21a0c-…`、`DESIGN.edit-docs.md`、`DESIGN.edit-remote.md`、`DESIGN.env-baseline.md`、`HANDOFF.edit-remote.md`、`skills/weak-model-harness/scripts/bridge/`。
- 詳細背景：`HANDOFF.todo-1108.md`（規則、待辦 A–H、註冊點、量測指令、Electron 驗證步驟 §6）、`DESIGN.TODO.md`「2026-11-08 未完成清單」。
- 週用量交接時 95%（重置約 2026-11-08T21:59:59Z，即交接後約 5 小時）。接手者先 `get_usage`，週額度 ≥90% 就只做輕量事（讀、寫文件），等重置後再做重活。

## 3. Todo（依序；每完成一部份就 commit + publish patch + 釘 main 網頁版）

1. **矩陣與 Blockly**
   - 1a 多數題目看不到區塊：`write_code` 離線組合（`_codeOffline`，floating-assistant.js 約 113015–113080，`_matrixBlocksObj`）只在讀取器讀不出／範式沒解出才走矩陣層。第一步：範式解出後也跑矩陣層，輸出一致時附上驗證過的區塊。
   - 1b 沒有區塊畫面，只回受控自然語言：給 `matrix_blocks` 工具（約 73004）做區塊顯示卡片／畫面。
   - 1c 狀態機圖種收編進 `renderer/src/uml/uml_core`（並有畫面）；1d VM 區塊接進 `write_code`。
   - 1e Blockly 教學補：socket 全套、exec／環境變數、信號處理常式巢狀。holdout 未解題不可教。新 domain pack 要五個註冊點＋自己的 holdout＋`scripts/e2e/matrix_graph.e2e.mjs` 一行。
2. **函式行為卡**：真 Electron 實跑（要連網下載文法）；做「從程式抽回 UML 設計」工具與卡片畫面。
3. **多語言中間語言**：c++／c#／ruby／perl 當來源的「進」；cpp 19/72 標準操作缺樣板；ruby 本機沒直譯器（沒實跑）；JavaScript 來源缺型別轉靜態語言會拒絕。
4. **diff／patch／merge**：語法樹修補防護只有 Python，其他語言的單元切分（`treeUnits`/`treeStrings`）要做；同一處兩邊都改刻意不自動取一邊（保持）；量離線小模型走 `merge_patch` 的成效。

## 4. Working style

- 用 `scripts/publish.sh --no-web -m "…" --commit-msg "…"` 發 patch，別手工組 patch；版號單一來源 `PATCH_VERSION`＋`scripts/release-version.js`。網頁版釘 main：用 git worktree 改 `web/index.html`、`web/aiweb/index.html` 的 SHA，訊息「網頁版載入改釘 <sha8>（vNNN）」。publish.sh 自帶網頁步驟需 `../videos-嗨投資`，本機沒有，所以用 `--no-web`。
- 共用 Blockly 讀取器 `algo_intent_core.js` 回歸：`bench_coverage.js --mode A` 59/60、`--files holdout_blockly.jsonl` 28/31、`--files bench_linux_all.jsonl` 59/64、`node scripts/run-core-tests.js`。
- 評測要 `FaLlm.realFetch=null`；真 Electron：`FA_USERDATA=<空目錄>` 內放 `desktop-settings.json`＝`{"execEnabled":true,"execConfirmRequired":false}`，`xvfb-run -a`，port 不用 17923。
- 工作目錄與他人共用：只 selective `git add`，不動他人檔案，不用 `git add -A`。
- 絕不用 `pkill -f`/`pgrep -f`（會被擋且可能殺別人程序）；用 `ps -eo pid,args | grep "[x]yz"`。
- 內嵌模組改完要跑 `scripts/embed-code-ui.js` 內嵌步驟。
- 不擴大範圍；只做上列待辦。

## 5. Verbatim user words

- 2026-10-26：「我們要有個統一維護版號的地方，確保不論是這個session或其他session都可以持續接手」
- 2026-11-09：「照以下順序完成」＋四組清單（矩陣與 Blockly／函式行為卡／多語言中間語言／diff、patch、merge，內容同本文件 §3 的原句：「多數題目看不到區塊，因為只有讀取器讀不出、或範式沒解出時才走矩陣層。」「沒有區塊畫面，只回受控自然語言。」「狀態機圖種沒收編進 uml_core，沒有畫面；VM 區塊沒接 write_code。」「Blockly 教學：socket 全套、exec／環境變數、信號處理常式巢狀；holdout 未解題（不可教）。」「沒在真 Electron 跑過（要連網下載文法）。」「『從程式抽回 UML 設計』還沒做成工具，也沒有卡片畫面。」「c++、c#、ruby、perl 當來源的『進』沒做。」「cpp 有 19／72 個標準操作沒樣板。」「ruby 這台沒環境，沒實跑。」「JavaScript 來源缺型別時轉靜態語言會拒絕。」「語法樹的修補防護只有 Python；其他語言的文法已經有，但各語言的單元切分還沒做。」「同一處兩邊都改，刻意不自動取一邊。」「離線小模型實際走 merge_patch 的成效沒量過。」）
- 2026-11-09：「每完成一個部份就commit patch, deploy(publish patch)」
- 2026-11-09：呼叫 `/low-context-long-run`。

## 6. Handoff procedure（自我遞迴）

執行 low-context-long-run skill，THRESHOLD 30%。批次邊界查 `get_usage`（context% 與週額度）；到門檻或週額度近 90% → 重寫本文件、commit、`start_session`（initiation "user_asked"、context "fresh"、同目錄、標題「四組待辦長跑 · handoff N」），等後繼確認已讀文件並開工，再 `mark_completed` + `archive_session`（不刪除、不 clear）。啟動失敗：重試一次，仍失敗就向使用者報告一次並停，不 archive。待辦清空則不再交接，回報完成。

## 7. Traps

- 前一 session 一度找不到 `start_session`（需 ToolSearch `select:mcp__ccd_session__start_session`）。
- 合併多指令的 bash 曾被使用者中斷；指令分開、保持精簡。
- 離線評測載入真視覺模型會卡死／OOM，要 stub。
- 主程序檔無法熱更新；floating-assistant.js 大小由另一 session 處理（分塊下載、建置時 minify）。
- 週額度偏高時，別啟動重型評測／e2e。
