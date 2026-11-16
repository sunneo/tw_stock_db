# 交接：技能包相容（skill_run_script ＋ Redmine 版視窗介面）

## 開場提示（接手者會收到的文字）
照這份文件做完全部項目才可以結束；每項做完就提交（Windows、分支 desktop-app、工作目錄 D:\Downloads\videos-嗨投資-desktop-app\desktop-app）。context 到 60% 才交接。不要問使用者問題，歧義自己決定。做完直接回報一次。

## 目標（使用者 2026-11-16：「做，補 skill_run_script 跟相容介面」）
使用者在 Redmine 版 AI Chat 匯入技能 testcaseviewer（樣本在 `E:\Temp\claude\1845096e089295dd\e49cfb73-b239-407d-a0c7-0036bc8d60d4\scratchpad\tcv_skill\`，是解開的 .skill；附件樣本 `C:\Users\sunneo\Desktop\result.tar.gz`）能開出視窗；桌面版匯入同一個技能卻不能。要讓同一份技能兩邊都能跑。

## 已知差異（已核對）
技能 `scripts/tcv_gui.py` 用到而桌面版 `renderer/src/pybridge/gui.py` 沒有的：
1. `w.list(items, selected=, parent=, rows=)`：桌面版叫 `listbox`（已有 rows，提交 f427e0584）。補別名 `list`（同時保留 listbox）。
2. `w.tree(columns, rows, parent=)`：欄位 `[{"title","width","align"}]`；列 `{"id","depth","cells":[...],"tones":[...],"bold","expanded"}`；`w.set(tree, rows=..., columns=..., selected=id)`；點列送 `select`（value = 列 id）。深度要能收合展開，上限 3000 列要流暢。
3. `w.doc(blocks, parent)`：`set(doc, blocks=[...])`；區塊 `{"t": title|p|h|pre|list|table|kv|ref, ...}`：title(text,badge,tone)、p(text,tone)、h(text)、pre(text,wrap)、list(items,tone)、table(columns,rows)、kv(rows=[[k,v,highlight,mono]])、ref(text,ref)；點 ref 送事件 `ref`（value = ref）。tone: pass/fail/warn/muted。完整寫法讀 `tcv_detail.py`。
4. `w.filepick(label, accept, parent, multiple=, directory=)`＋`w.pick_files(ev)`：事件 `pick`；`pick_files(ev)` 回傳 `(files, skipped)`，files 是 `[{"name","ref",...}]`（看 `tcv_gui.py` 的 `picked_many` 與 `tcv_files.VirtualFiles` 怎麼用）。桌面版用真的檔案選擇器（沿用現有 `pick_file` 的做法）。
5. `w.split([22, 44, 34], parent)`：多路權重（現有 `split(direction, ratio)`；接受 list 時當權重、橫排）。
6. `w.wait(timeout=, also=("select","change"))`：`also` 列出的事件也要讓 wait 回傳（預設 select/change 只更新 value 不回傳）。
7. `Window(title, width, resizable=True, maximizable=True)` 已有。
8. 工具 `skill_run_script`：參數 `{skill, script, args[], timeout_seconds}`。行為：把這個技能包的檔案放進頁面的 Python 執行環境（跟 `python_execute` 同一套，含 pybridge 的 gui、fa_bridge），以該技能的 `scripts/` 為模組路徑執行腳本（`argv = args`），回傳 stdout 與結束狀態；腳本裡 `import gui` 開的視窗畫在桌面版的視窗主機上（用法同 `guitpl.run`）。來源 URI 要能解：`workspace://名稱`、`attachment://<id>`（桌面版對應對話附件，以 file_id 為主；找不到時給清楚的錯誤）、本機路徑。技能的 SKILL.md 與 FA_SKILL_RUN_PROTOCOL（`renderer/src/floating-assistant.js` 3952 行附近）要更新：有 skill_run_script 時優先用它，沒有才用 run_command。技能領域要保留這個工具（比照提交 f546558b2 的 skillKeepTools）。

## 程式地圖
- 視窗繪製：`renderer/src/gui/gui_render.js`（renderNode、patchNode、GUI_CSS）；橋接驗證：`renderer/src/gui/gui_bridge.js`（種類表在 75 行附近，props／events／rows 限制）；主機：`gui_host.js`；Python 端：`renderer/src/pybridge/gui.py`（改了要跑 `node scripts/embed-code-ui.js` 再 `node build-assistant.js`，因為 pybridge 與 gui 繪製器都嵌在 `renderer/src/floating-assistant.js`）。
- 測試：`node renderer/src/gui/gui_render.test.js`、`gui_bridge.test.js`、`gui_host.test.js`；Python 端有 `renderer/src/gui/gui_py_test.py`。每個新元件都加測試。
- 真 Chrome 驗證頁範例：`scripts/eval/gui_list_height_check2.html`（用 python -m http.server 起伺服器，再用 Claude in Chrome 開；使用者要求驗證預設用 Chrome）。

## 項目（全部 [x] 才能結束；每項一個提交，提交訊息寫做了什麼＋怎麼驗證）
- [x] 1. gui.py：`list` 別名、`wait(also=)`、`split` 權重清單
- [x] 2. 新元件 `tree`（橋接、繪製、Python、patch、測試）
- [x] 3. 新元件 `doc`（八種區塊、ref 事件、測試）
- [x] 4. `filepick`＋`pick_files`（桌面版真檔案選擇器；網頁版沿用既有 pick_file 的退路）
- [x] 5. 工具 `skill_run_script`＋URI 解析＋更新 FA_SKILL_RUN_PROTOCOL／技能領域保留工具
- [x] 6. 端到端（待本機驗證：真 Chrome 點選樹與 ref、真桌面版開視窗；驗證頁 scripts/eval/gui_tree_doc_check.html）：在 node 或真 Chrome 用樣本技能跑 `tcv_gui.py --open <result.tar.gz 路徑>`，確認視窗元件都建得起來、樹狀列可點、ref 可點；做不到的部分標「待本機驗證」＋寫驗證頁
- [ ] 7. 建置：`node scripts/embed-code-ui.js`、`node build-assistant.js`、相關測試全過，`git status` 沒有未提交的來源（web-lazy 的 CRLF 差異不算，不要動）

## 工作風格
- 一律繁體中文，不夾英文縮寫；回報只在全部做完或標 BLOCKED 時一次。
- 改程式用 Edit／Write 工具，不要用 shell 內嵌 heredoc 改含反斜線的程式；先有測試再提交。
- 不發布、不推送（管理者核對後處理）；不開真桌面版視窗搶焦點；不啟動會占用 17923 埠的程式。
- 速度數字要標硬體；沒驗證的不要說驗證過。
- 提交前先 commit 再 build（使用者 build 前會 git checkout，沒提交的會消失）。
- Haiku 守則：不要長排程、不要空等、不要整套測試（只跑動到的）。

## 使用者原話（逐字）
- 2026-11-16：「做，補 skill_run_script 跟相容介面」
- 2026-11-16：「redmine那邊可以匯入後 …（貼上 Redmine 的執行紀錄：skill_run_script 載入後 TestCaseViewer 視窗打開並關閉）… 但我們這邊沒有，是不是缺少什麼」
- 2026-11-16：「而且他還在不停地解開裡面的內容到我的對話內」

## 交接程序
照 low-context-long-run 技能（門檻 60%）：到門檻就更新本文件的項目勾選與「進度」，提交，開下一棒（model claude-haiku-5-5、effort high、fresh）。

## 陷阱
- `gui.py` 的 `Window` 舊程式用 `listbox`，別刪。
- 橋接層會驗證 props，新元件的 props／events 沒登記會被擋（"prop not allowed"）。
- 嵌入區塊改了來源就要重跑 embed-code-ui.js，不然改動會被蓋。
- 檔案行尾：多數是 CRLF，用 Python 取代時要保留。
