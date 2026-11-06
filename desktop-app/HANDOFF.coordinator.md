# HANDOFF：協調 session（發布、驗證、分派）— 2026-11-07

## 1. 開場提示（接手者收到的話）

讀完本文件（含使用者原話與工作風格），接手「協調 session」：不寫功能，負責 (a) 子 session 完成一批後驗證並發布、(b) 分派與提醒、(c) 把狀態寫進 `DESIGN.TODO.md` 現況總覽。跑 low-context-long-run（context 門檻 30%）。第一則訊息一行確認你讀了本文件、從哪項待辦開始。

## 2. 概況

- 專案：`/home/hungfu.lee/下載/SRC/tw_stock_db/desktop-app`，分支 `desktop-app`。目前發布到 **patch v317**（HEAD `2d7d64a2`）。v314 作廢（發布時 sparse checkout 漏檔，被 v315 取代）。
- 已在使用者端：Blockly 範式骨架、Linux 工具題（cat／grep／xxd／tar／gzip／xz／BMP，train 37/37、holdout 21/27）、35 個位元積木、領域包 DSP／algo2／os／ds／linuxtext、離線各層 rounds 帶回、矩陣層宿主接線（`FaMatrixSynth`，只過範例標 `verified:false`）。
- 矩陣層實測價值很小：保留題庫 48 題（沒教過）Blockly 17、加矩陣 21。矩陣補齊交給 stevenyc.huang 的 session（交接：`HANDOFF.matrix-fallback.md`、`DESIGN.matrix-fallback.md` §9.7／§12）。
- Blockly 教學由 `HANDOFF.blockly-teach.md`（可跨帳號冷啟動）＋`DESIGN.blockly-curriculum.md`（教學範本總表）驅動；現行接手：blockly-teach · handoff 3（`local_e86c1499-1ab7-4ba2-b118-b714bae40bf5`）。
- 狀態總表在 `DESIGN.TODO.md` 現況總覽（有「進 renderer？」欄；每份設計文件都要有一列）。

## 3. 待辦（依序）

1. 等 blockly-teach 回報「測過、已提交」的批次 → 用第 6 節流程驗證並發布 → 回報使用者一句話。
2. 子 session 做完時：沒有東西可發就只回報；有東西發布前先看 `git status renderer scripts web-lazy` 是否有別人未提交的來源。
3. 網頁版部署：`videos-嗨投資` 倉庫不在這台機器上，向使用者問路徑；有路徑後發布不要加 `--no-web`，並用 `WEB_REPO=<路徑>`。目前所有發布都是 `--no-web`（桌面版 patch only）。
4. 週六 07:00 CST（週額度重置 2026-11-06 23:00 UTC）後回到 88% 停手規則；下週接手的人或自己從 `HANDOFF.blockly-teach.md` 與本文件續做。
5. 開放問題：矩陣層對「沒有測資的需求」的產品缺口（需要讀取器生成範例＋確認卡）；備援第三層（上網找答案／湊 CoLU／待補教學佇列）只有介面；矩陣 → UML／Blockly 只有設計。
6. 使用者拒絕過並行開 4 個領域 session；要並行先問，且各領域用獨立檔、不碰共用檔、不 build。

## 4. 工作風格

- 繁體中文。回報要誠實：驗證過的和轉述子 session 的數字要分開講；沒做的、沒進 renderer 的要明說。
- 提交與 push 用 `ssh hungfu.lee@127.0.0.1`（使用者原話）。`git` 在 automation 帳號需 `git -c safe.directory=/home/hungfu.lee/下載/SRC/tw_stock_db`。
- 子 session 不發布、只提交並回報；由協調 session 發布。發布規則見使用者原話。
- 額度規則：週額度只在「週五 19:00 → 週六 07:00 CST」可用光；其他時間 88% 停手、寫交接、不起接手。用 `date` 查本機時間。
- `start_session` 只接受使用者本人的話：自動回合會被拒，改提案卡（`own_initiative`）等使用者點。
- 預設以 `date`、`mcp__ccd_session_mgmt__get_usage` 查額度與 context。

## 5. 使用者原話（逐字）

- 2026-11-06：「提交並發布」（發布的觸發語；曾誤送到別的 session）
- 2026-11-06：「週額度要重啟了，請放心用光」／「這個週額度可以用光的規則僅用於禮拜五晚上7點後」／「平時禮拜六七點後，到隔週的禮拜五晚上七點前，不能這樣做」
- 2026-11-06：「blockly-writer -> matrix-algorithms　blockly-writer評估不出來, out of scope的用matrix-algorithm評估　我們的blockly+matrix-algorithm的範式，需要可以cover所有的可解問題，讓code-writer可以產生能解決使用者需求的程式」／「上述是實現的順序的宣告，請依序完成」
- 2026-11-06：「個別完成都要回來發布」
- 2026-11-06：「請用ssh hungfu.lee@127.0.0.1」
- 2026-11-07：「如果這過程有補matrix,有補blockly，都要commit push, publish/deploy」
- 2026-11-07：「我們這邊就認真擴充blockly-teach, 涵蓋演算法、資料結構、作業系統、真實linux programming，等各種領域作為範本，把教學範本補齊」／「矩陣補齊我想要交給其他session，例如stevenyc.huang」
- 2026-11-07：「甚至下週也可以繼續補齊，所以這邊盡量安排成有多少做多少，補好的就commit/deploy」
- 2026-11-07：「另一邊希望你先認真完成blockly-teach的任務」／「然後你這邊commit , push, 發布」／「無法完成的就放到TODO, HANDOFF, 等下週其他接手的人(或自己) 完成」
- 2026-11-07：「我覺得設計一下子沒有寫TODO,卻也不進renderer  很亂」／「這樣我怎知道什麼沒做」
- 2026-11-07：「blockly的銜接在blockly-teach內，讓它去接續，我要讓stevenyc那邊先啟動，這邊如果週額度用光，還可以提前插入到handoff讓stevenyc那邊接續完成」

## 6. 發布流程（工作樹有別人未提交來源時用「乾淨匯出」）

1. 子 session 回報批次 hash、train／holdout 數、改了哪些檔。
2. 以 hungfu.lee 在 `/tmp/pub314`（`git clone --shared -n --branch desktop-app <repo>`、origin 設為 `https://github.com/sunneo/tw_stock_db.git`、sparse-checkout `desktop-app`、`node_modules` 以符號連結指向主目錄）：`git checkout -q -- .; git fetch /home/hungfu.lee/下載/SRC/tw_stock_db desktop-app && git merge --ff-only FETCH_HEAD`。
3. 在複本內：`FA_TS_DIR=/tmp/fa-ts-cache`；`node scripts/embed-code-ui.js && node build-assistant.js`；`node scripts/web-lazy-check.js`；`node scripts/run-core-tests.js`（全過；不要用 `ulimit -v`，WASM 測試會失敗）；`xvfb-run -a node scripts/eval/run_eval.js scripts/eval/offline-code.eval.js <空的port>`（20 題 noLessons／withLessons 皆 20/20）。
4. 發布：`export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.sparseCheckout GIT_CONFIG_VALUE_0=false PUBLISH_TRAILER="Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"; bash scripts/publish.sh -m "…" --skip-build --no-web`（沒有那個環境變數覆寫，sparse checkout 會讓 `git add -A` 漏掉 patch 檔、強推出不完整的 `desktop-app-patch`）。
5. 驗證：`git ls-tree -r --full-tree --name-only desktop-app-patch | wc -l` 應為 69；`git show desktop-app-patch:manifest.v2.json | grep version`。
6. 同步回主工作樹（hungfu.lee）：`git checkout -- renderer/floating-assistant.js renderer/floating-assistant.min.js renderer/update-manifest.json web-lazy; git clean -fdq web-lazy; git fetch /tmp/pub314 desktop-app && git merge --ff-only FETCH_HEAD`（別人未提交的 `renderer/src` 檔會留著）。

## 7. 陷阱

- `pkill -f <樣式>` 若樣式出現在自己的命令列會殺掉自己；用 `ps -eo pid,args | grep "[x]yz"` 找 pid。
- v313 因 `publish.sh` 的 `git add -A renderer scripts web-lazy` 把別人做到一半的改動一起發出去（DSP／huffman 退步，v314/v315 修）。發布前一定檢查工作樹。
- 全域 OOM（2026-11-07 00:06，某 python3 吃 78GB，使用者把 swap 縮成 4GB；元凶未查出）。所有 Python／評測腳本加記憶體上限（`systemd-run --user --scope -p MemoryMax=16G -p MemorySwapMax=0 …`），WASM 測試不能用 `ulimit -v`。
- 子 session 的數字是轉述；60 題基準已被教過，只能當回歸，泛化量尺是 Linux 題庫 holdout 與各領域 holdout（不可教）。
- `build-assistant.js` 在 automation 帳號會因 `web-lazy/chunks` 屬於 hungfu.lee 而 EACCES；build 與發布都用 hungfu.lee 做。
- `docs/HANDOFF.md` 屬於 stevenyc.huang，automation 不能寫；筆記放 `STATUS.md`／本類檔案。
- 不是我們的未提交檔（別碰）：`features/FEATURES.md`、`skills/image-decompose-redraw/data/parts_builtin.json`、`DESIGN.edit-docs.md`、`DESIGN.edit-remote.md`、`DESIGN.env-baseline.md`、`HANDOFF.edit-remote.md`、`skills/weak-model-harness/scripts/bridge/`、`72d21a0c-84c8-409b-b2aa-0bdb5628ec1e`。

## 8. 交接程序

跑 low-context-long-run（門檻 30%）：批次邊界檢查 context，到門檻就更新本文件、提交，並啟動接手（自動回合被拒就留提案卡）。
