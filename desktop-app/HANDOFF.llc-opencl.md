# HANDOFF：接手前面的工作＋接上 run terminal 的 llc OpenCL 墊片（2026-11-19）


## 0. 範圍更新（2026-11-19，使用者）

使用者原話：「我們這個session已經離很久，source code已經前進很遠了, blockly那邊可以不用管了」「要確保examples裡面的llc的gpgpu可以用opencl加速跑nbody3d, fluid3d」。**Blockly 相關與第 3 節的待辦 3、4 全部作廢。** 唯一目標：`renderer/src/examples/llc/gpgpu/nbody3d.ll`、`fluid3d.ll` 能在 run terminal／job 用 OpenCL 墊片加速跑（後端 WebGPU／cudaweb，沒有 WebGPU 時 CPU 後備），要有真輸出與實測加速數字，沒有加速也如實報告。完成後提交、回報領導，由領導發布。子 session 用 haiku（領導 Sonnet）。

## 1. 開場提示（接手者收到的話）

Continue from the handoff document at desktop-app/HANDOFF.llc-opencl.md. Read it fully, including the verbatim user words and the working style, and follow them. Run the low-context-long-run skill (THRESHOLD 30%): do the next todo item, and when your context reaches the threshold, write the next handoff and start your own successor. As your first message, confirm in one line that you read the document and which todo item you are starting. 使用者原話：「接手前面的工作，完成後要publish」「接上run terminal的llc的opencl墊片」。

## 2. 概況

- 專案 `tw_stock_db`，Electron 桌面版 FloatingAssistant，分支 `desktop-app`，工作目錄 `/home/hungfu.lee/下載/SRC/tw_stock_db/desktop-app`。使用者寫繁體中文；回覆只用繁體中文或英文。
- 本文件由協調 session（`local_aa2d0534-d9c3-41a6-8c95-9c3591567ef0`）在 context 30% 時寫，沒有實作任何程式；2026-11-19 22:59 CST 查到：HEAD `0df5a476`（別的 session 的 llc nbody3d／fluid3d 移植），週額度 62%（重置 2026-11-20 22:59:59 UTC），5 小時額度 3%。
- 「前面的工作」＝兩條線：(A) `HANDOFF.long-run-todo.md` 的四組待辦（1 矩陣與 Blockly、2 函式行為卡、3 多語言中間語言、4 diff／patch／merge；該文件寫「尚未開始實作」，先看 `git log` 與 `DESIGN.TODO.md` 現況表確認哪些已被別人做掉），細節在 `HANDOFF.todo-1108.md`；(B) Blockly 教學下一批：`HANDOFF.blockly-teach.md` §3b（檔案系統、進階圖樹、真實 Linux programming、銀行家演算法輸入修正）。發布流程見 `HANDOFF.coordinator.md`（含乾淨匯出做法）。
- 已在使用者端的 Blockly／矩陣成果：patch v318 為止（見 `HANDOFF.coordinator.md`）；之後的版號以 `PATCH_VERSION`／遠端 manifest 為準（long-run-todo 寫 341，**先跑 `node scripts/release-version.js next` 確認**）。
- **OpenCL 墊片現況（本次新工作）**：`renderer/src/uml/llvm_host.js`（＋`llvm_host.test.js`）已提供 SDL2／OpenGL／GTK3／音訊／stdio 檔案函式的 wasm host import，讓 `.ll` 在 run terminal／job 的沙盒（wasm 只有 WASI）能跑；**沒有 OpenCL**。`renderer/src/examples/llc/gpgpu/opencl_vecadd.ll` 目前「只能在有驅動的真機器上跑（下一步：接 cudaweb）」。相關文件：`DESIGN.run-terminal.md` §21（host import 的做法與限制，第 1643 行寫「沙盒沒有 OpenCL」）、`renderer/src/examples/llc/README.md`、`DESIGN.webgpu-cuda.md`（cudaweb／WebGPU 端）、`DESIGN.env-baseline.md`（他人檔，只讀）。nbody3d／fluid3d 範例是用 CPU 計算替代 OpenCL（見 `examples/llc/_gen/_gen_*.py`）。

## 3. 待辦（依序）

1. **OpenCL 墊片**（優先）：先讀 `DESIGN.run-terminal.md` §21、`llvm_host.js` 現有 host import 的註冊與沙盒函式的寫法、`DESIGN.webgpu-cuda.md`。設計：把 OpenCL C API 的最小可用子集接成 host import — `clGetPlatformIDs／clGetDeviceIDs／clCreateContext／clCreateCommandQueue(WithProperties)／clCreateBuffer／clEnqueueWriteBuffer／clEnqueueReadBuffer／clCreateProgramWithSource／clBuildProgram／clCreateKernel／clSetKernelArg／clEnqueueNDRangeKernel／clFinish／clRelease*`。後端二選一並寫進設計文件：(a) 走 WebGPU／cudaweb（核心字串轉 WGSL，OpenCL C 子集轉譯）；(b) 沒有 GPU 時的 CPU 後備：把 OpenCL C 核心（逐元素向量加、簡單迴圈）用現有 JS 直譯／編譯成 JS 函式在 host 端執行（先支援 `opencl_vecadd.ll` 這種 get_global_id＋算術核心）。**驗證要用真輸出**：`llvm_host.test.js` 加 OpenCL 項目（node，跑向量加並比對結果）、`scripts/eval/llc_host.eval.js` 加 `opencl_vecadd.ll`（真 Electron）。限制要誠實寫進 `DESIGN.run-terminal.md` §21 與 `examples/llc/README.md`（支援的 API 子集、核心語言子集、沒有的東西）。
2. 提交（只加自己的檔案）→ 乾淨匯出流程發布（見 `HANDOFF.coordinator.md` §6）→ 在 `DESIGN.TODO.md` 現況表加一列「llc OpenCL 墊片：進 renderer？」。使用者要求「完成後要publish」。
3. 接著做「前面的工作」(A)：`HANDOFF.long-run-todo.md` 四組待辦，先 `git log --oneline -30` 與 `DESIGN.TODO.md` 現況表確認哪些已完成，再依序做；每完成一部份就 commit＋publish patch。
4. 最後 (B)：`HANDOFF.blockly-teach.md` §3b 的 Blockly 教學下一批。
5. 做不完的寫進 `DESIGN.TODO.md`（「進 renderer？」欄）與本文件，下一棒續做。

## 4. 工作風格

- 繁體中文；回報誠實（驗證過的與轉述的分開；沒做的明說）。
- 提交與 push 用 `ssh hungfu.lee@127.0.0.1`（使用者原話：「請用ssh hungfu.lee@127.0.0.1」）；automation 帳號用 git 要加 `-c safe.directory=/home/hungfu.lee/下載/SRC/tw_stock_db`。只 selective `git add`，不用 `git add -A`（發布腳本內建的除外）。
- 工作目錄與他人共用：發布前看 `git status renderer scripts web-lazy`；有別人未提交的來源就走乾淨匯出（`HANDOFF.coordinator.md` §6）。
- 內嵌模組改完要跑 `node scripts/embed-code-ui.js && node build-assistant.js`；測試 `FA_TS_DIR=/tmp/fa-ts-cache node scripts/run-core-tests.js`（不要用 `ulimit -v`，WASM 測試會失敗）；真 Electron：`FA_USERDATA=<空目錄>` 內放 `desktop-settings.json`＝`{"execEnabled":true,"execConfirmRequired":false}`，`xvfb-run -a`，port 不用 17923；評測要 `FaLlm.realFetch=null`。
- Python／評測腳本加記憶體上限：`systemd-run --user --scope -p MemoryMax=16G -p MemorySwapMax=0 …`。
- 額度：週額度 ≥88% 就停手、寫交接、不起接手；只有「週五 19:00 → 週六 07:00 CST」可用光（見第 5 節原話）。用 `date`、`mcp__ccd_session_mgmt__get_usage` 查。
- `start_session` 只接受使用者本人在該對話的話；自動回合被拒就留提案卡（`own_initiative`）等使用者點。
- 不擴大範圍；不碰他人未提交檔：`features/FEATURES.md`、`skills/image-decompose-redraw/data/parts_builtin.json`、`DESIGN.edit-docs.md`、`DESIGN.edit-remote.md`、`DESIGN.env-baseline.md`、`HANDOFF.edit-remote.md`、`skills/weak-model-harness/scripts/bridge/`、`72d21a0c-84c8-409b-b2aa-0bdb5628ec1e`、`test-reports/`。

## 5. 使用者原話（逐字，含日期）
- 2026-11-19：「你是領導」「領導如果使用sonnet, subsession就用haiku」「領導如果用opus, subsession就用sonnet」（`start_session` 的 `model` 要低一階：領導 Sonnet→`claude-haiku-5-5`，領導 Opus→`claude-sonnet-5-5`；子 session 開的下一棒也照此；領導負責驗證與發布）

- 2026-11-19：「接手前面的工作，完成後要publish」／「接上run terminal的llc的opencl墊片」
- 2026-11-06：「提交並發布」（發布觸發語）；「個別完成都要回來發布」
- 2026-11-06：「請用ssh hungfu.lee@127.0.0.1」
- 2026-11-06：「週額度要重啟了，請放心用光」／「這個週額度可以用光的規則僅用於禮拜五晚上7點後」／「平時禮拜六七點後，到隔週的禮拜五晚上七點前，不能這樣做」
- 2026-11-07：「如果這過程有補matrix,有補blockly，都要commit push, publish/deploy」／「甚至下週也可以繼續補齊，所以這邊盡量安排成有多少做多少，補好的就commit/deploy」／「無法完成的就放到TODO, HANDOFF, 等下週其他接手的人(或自己) 完成」
- 2026-11-07：「我覺得設計一下子沒有寫TODO,卻也不進renderer  很亂」／「這樣我怎知道什麼沒做」
- 2026-11-07（llc 動機，`DESIGN.run-terminal.md` §21）：llc 的範例（SDL2 遊戲、GTK3 視窗、OpenGL）不只能在真機器編成原生執行，在 run terminal／job 的模擬環境也要能跑。
- 2026-11-08（long-run-todo）：「照以下順序完成」「每完成一個部份就commit patch, deploy(publish patch)」

## 6. 交接程序

跑 low-context-long-run（門檻 30%）：批次邊界檢查 context；到門檻就更新本文件、提交、啟動接手（`initiation:"user_asked"`，`context:"fresh"`；被拒就留提案卡）；successor 確認接手後才 `mark_completed`＋`archive_session`（失敗就告訴使用者哪個 session id 留著）。

## 7. 陷阱

- `pkill -f`／`pgrep -f` 會殺到自己的命令列或被擋，改用 `ps -eo pid,args | grep "[x]yz"`。
- 發布腳本 `git add -A renderer scripts web-lazy` 會把別人做到一半的改動一起發出去（v313 事故）；sparse-checkout 的複本發布要設 `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.sparseCheckout GIT_CONFIG_VALUE_0=false`，否則 patch 漏檔（v314 事故）；發布後核對 patch 樹檔案數（約 69，以前一版為準）。
- 全域 OOM 事件（2026-11-07，某 python3 吃 78GB）；所有 Python／評測腳本加記憶體上限。
- `build-assistant.js` 在 automation 帳號會因 `web-lazy/chunks` 屬於 hungfu.lee 而 EACCES；build 與發布用 hungfu.lee（ssh）。
- 子 session 的數字是轉述，要自己驗證；Blockly 60 題基準已被教過，只能當回歸。
- 網頁版倉庫 `videos-嗨投資` 不在這台機器（舊事實）：long-run-todo 說網頁版釘 main 用 git worktree 改 `web/index.html`、`web/aiweb/index.html` 的 SHA，先看那份文件現在怎麼做，再決定發布要不要加 `--no-web`。
