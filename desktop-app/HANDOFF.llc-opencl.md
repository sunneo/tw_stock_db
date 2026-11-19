# HANDOFF：llc OpenCL 加速（nbody3d／fluid3d）與 KIR 通用核心派送（handoff 1，2026-11-19 深夜）

## 1. 開場提示（接手者收到的話）

Continue from the handoff document at desktop-app/HANDOFF.llc-opencl.md. Read it fully, including the verbatim user words and the working style, and follow them. Run the low-context-long-run skill (THRESHOLD 30%): do the next todo item, and when your context reaches the threshold, write the next handoff and start your own successor. As your first message, confirm in one line that you read the document and which todo item you are starting. 使用者原話（逐字，見第 5 節）：「要確保examples裡面的llc的gpgpu可以用opencl加速跑nbody3d, fluid3d」「我指的是opencl的gpu後端，讓它接到cudaweb的實做」「A, B都要」「我希望也有cuda後端，我們有幫 cudaweb做了不少優化」。

## 2. 概況

- 倉庫 `tw_stock_db`（主工作樹 `/home/hungfu.lee/下載/SRC/tw_stock_db`），分支 `desktop-app`；本文件在 `desktop-app/`。使用者寫繁體中文；回覆用繁體中文或英文。
- **範圍（領導 2026-11-19 確認）**：Blockly 與舊的待辦 3、4（`HANDOFF.long-run-todo.md`、`HANDOFF.blockly-teach.md`）全部不用做。唯一目標：`renderer/src/examples/llc/gpgpu/nbody3d.ll`、`fluid3d.ll` 能在 run terminal／job 用 OpenCL 加速跑，要有真輸出與實測數字；沒加速也要如實報告。
- **提交與 push 用 `ssh -o BatchMode=yes hungfu.lee@127.0.0.1`**，在 `/home/hungfu.lee/下載/SRC/tw_stock_db` 下 `git add desktop-app/<自己的檔>` 再 commit（不要 `git add -A`）。commit 訊息結尾 `Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>`。
- **領導**：協調 session `local_aa2d0534-d9c3-41a6-8c95-9c3591567ef0`（FloatingAssistant，Sonnet）。每個階段提交後用 `SendMessage` 回報它一次（第一行寫清楚是哪個階段與 hash）；它驗證並發布。我們是子 session，用 haiku。發布（`scripts/publish.sh`）只有領導做。

### 現況（2026-11-20，領導更新）

- 已發布到 **patch v490**（桌面版，`desktop-app` a11a0ae8b）。後續 commit 只有文件（`changes.md`、DESIGN §24、現況總覽）。
- v484–v490 內容：KIR WebGL2 執行層與常駐裝置層（`dd01eaec9`）、host 接 KIR（`1a7772f36`）、nbody3d／fluid3d 的 `_cl` 版（`9a27a6526`）、HUD 與 CPU／GPU 按鈕（v487–v489）、打包紋理裝置層與 host 匯入（`17864b490`、`a0d382294`、`e8f4f2d14`）。
- **nbody 維持 v489 的逐部分讀回版**（`75d1fbfb4` 還原）。打包版修了兩個 bug：`u_off` 列偏移（`e8f4f2d14`），以及 `accel_cl` 拷貝迴圈計數器 `%ci` 每幀沒歸零（第 2 幀起輸出凍結）。
- 真機（使用者）：nbody GPU 0.063 s／step 對 CPU 0.961 s／step；GPU 使用率 <2% → 70%。軟體 GL（這台）沒有加速，已如實記錄。
- 驗證：`llvm_host` 41、`kir` 30、`nbody3d_cl` 24、`fluid3d_cl` 20、`llc_hud.eval.js` 22/22。受影響測試有 3 組失敗（`lora_route_wiring`、`studio_embed`、`gpu-mem-settings`），在 lora／studio／transformers 快取，與本批無關，未追根因。
- 測試環境：`FA_TS_DIR=/tmp/fa-ts-cache`（需把 `renderer/vendor/tree-sitter/*` 複製進去，`/tmp` 被清過就要重建）。
- 這個 session 的模型規則：領導 Sonnet → 子 session 用 Haiku；領導 Opus → 子 session 用 Sonnet。

### 已提交（新到舊）

| hash | 內容 |
|---|---|
| `21b3859c4` | 階段 3：`renderer/src/gpu/kir_gen.js`（KIR→WGSL；KIR→GLSL ES 3.00 render-to-texture）；`kir_test.js` 30 項 |
| `ee1d49a2b` | 階段 2：`renderer/src/gpu/kir.js`（KIR、驗證、JS 後端 toJs／runJs）、`renderer/src/gpu/cl_front.js`（OpenCL C 子集解析器）、`kir_test.js` 22 項（vecadd、N 體、SPH 對照手寫 JS） |
| `b76d388c9` | 階段 1：`DESIGN.webgpu-cuda.md` §13（KIR 範圍、三個產生器、interop、驗證計畫） |
| `acedc739b` | 階段 0：`scripts/run-core-tests.js` 登記 `gpu_core.test.js`（44/44）；`backend_core.js` 過時註解更正 |
| `7676c39a3` | `DESIGN.run-terminal.md` §21：WebGPU adapter 在這台為 null、SDL 每幀 200 道繪圖指令上限的方案 |
| `a3fd33235` | OpenCL host import（CPU 後備）＋`opencl_vecadd.ll`（phi→alloca、malloc 用 i32）。領導已發布為 `desktop-app-patch` v483（desktop-app `a405e9cc`） |

### 測試（真的跑過）
- `node renderer/src/gpu/kir_test.js` → `kir: 30 passed`。
- `node renderer/src/gpu/gpu_core.test.js` → 44 通過。
- `node renderer/src/uml/llvm_host.test.js` → `llvm_host: 33 passed`（含 opencl_vecadd 真輸出）。
- 真 Electron `scripts/eval/llc_host.eval.js` 在 `a3fd33235` 時 ok=true（含 opencl_vecadd、nbody3d、fluid3d、SDL、GTK、音訊）。
- **沒有跑完整核心測試**（`scripts/run-core-tests.js` 沒加 `--full` 會退出 2；`scripts/test-affected.js` 對這批改動回報 0 個受影響測試）。交給領導時要如實說。
- WGSL 產生器只做結構檢查（本機沒有 naga／tint），**未在真 GPU 驗證**。GLSL 只做結構檢查，尚未在真 WebGL2 編譯。

### 環境事實（已驗證）
- 真 Electron（xvfb＋SwiftShader）：`navigator.gpu` 存在，`requestAdapter()` 回 **null**；WebGL2 可用。WebGPU 在這台**不能真的驗證**。

## 3. 待辦（依序；2026-11-20 領導更新，取代 handoff 1 的舊待辦）

階段 0–5、4b、1a（常駐裝置層）、1c（打包裝置層）、nbody／fluid 的 HUD 與 CPU／GPU 按鈕都**已完成並發布到 v490**（見上面「現況」）。剩下：

1. **OpenCL↔OpenGL interop（步驟 2）**：先讓使用者拍板 `DESIGN.webgpu-cuda.md` §13 階段 6 的 4 個決定（領導建議：KIR 共用 GUI 畫布 context `gui_render.js:48`；context lost 退回 CPU 路徑並在 HUD 說明；GL 批次上限具名常數 1024，目前 `llvm_host.js:518` 只取前 20；不等 1c）。實作：位置紋理直接當點精靈來源，不讀回；軟體 GL 與真 GPU 的數字分開寫。
2. **KIR 的 WebGPU 裝置層（步驟 3）**：同 `createDevice` 介面，重用 `gpu_core.js` 的 `probeAdapter`／`profileOf`；這台 `requestAdapter()` 是 null，只能做靜態檢查，標「未在真 GPU 驗證」。
3. **CUDA runtime API 前端**：`cudaMalloc／cudaMemcpy／cudaLaunchKernel` 子集＋`gpgpu/cuda_vecadd.ll`，走 cudaweb／KIR。NVPTX 路線沒有 PTX 解析器，限制寫明。
4. **HUD 文字（互動範例）：已完成（2026-11-20）**。music_player、midi_player、sdl2_piano、sdl2_pong、sdl2_gl_triangle 都有螢幕說明，狀態文字反映真實狀態；gtk3_widgets 是原生控制項，不補。每個 HUD 繪圖次數上界 600（依使用者指示；未採用舊的「上限 2000」，那是早先的草案數字）。做法與數字見 `DESIGN.run-terminal.md` §21.y（續）。真 Electron 檢查表 50 項過 47 項，未過的 3 項是舊的 nbody3d_cl／fluid3d_cl 按鈕底色與狀態行，原因未查，接手者先處理。
5. **打包版 nbody 的真 GPU 量測**（使用者機器）：生成器在 `renderer/src/examples/llc/_gen/_wip_nbody3d_cl_packed.py.txt`（輸出已與 CPU 一致，軟體 GL 約 60 ms／幀、慢於 v489 的 20 ms）；真 GPU 若明顯更快再換上。
6. **自動 swap／configure**：設計在 `DESIGN.run-terminal.md` §24；實作在分支 `wip/auto-swap`（f8dc80375，未審、未發布）。使用者要求「先寫下設計書就好」，所以先不接，等使用者說要做。

## 4. 工作風格（使用者與領導的規則）

- 繁體中文；回報誠實（驗證過的與轉述的分開；沒做的明說；沒有 GPU 的不能寫成已驗證）。
- **每個階段提交後回報領導一次**，第一行寫清楚階段與 hash。卡住就先回報、不要硬猜；設計不確定先寫進 DESIGN.webgpu-cuda.md §13 或 DESIGN.run-terminal.md §21 再做。
- 只 selective `git add`，只加自己的檔。不碰他人未提交檔：`features/FEATURES.md`、`skills/image-decompose-redraw/data/parts_builtin.json`、`DESIGN.edit-docs.md`、`DESIGN.edit-remote.md`、`DESIGN.env-baseline.md`、`HANDOFF.edit-remote.md`、`skills/weak-model-harness/scripts/bridge/`、`72d21a0c-84c8-409b-b2aa-0bdb5628ec1e`、`test-reports/`。
- 內嵌模組改完要跑 `node scripts/embed-code-ui.js && node build-assistant.js`（build 用 hungfu.lee，即 ssh；automation 帳號會因 `web-lazy/chunks` 屬於 hungfu.lee 而 EACCES）。
- 真 Electron 評測：`FA_USERDATA=<空目錄>` 內放 `desktop-settings.json`＝`{"execEnabled":true,"execConfirmRequired":false}`；指令形式：`systemd-run --user --scope -p MemoryMax=16G -p MemorySwapMax=0 bash -c "FA_USERDATA=… FA_DEBUG_EVAL_FILE=<eval 檔> timeout 900 xvfb-run -a node_modules/electron/dist/electron . --no-sandbox --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --user-data-dir=…"`，結果在輸出的 `[eval-file] result: {…}`。
- Python／評測腳本加記憶體上限（`systemd-run --user --scope -p MemoryMax=16G -p MemorySwapMax=0 …`）。
- 額度：週額度 ≥88% 就停手、寫交接；context ≥30% 就交接（本次即是）。用 `mcp__ccd_session_mgmt__get_usage`（先 ToolSearch 載入）。
- 暫存檔放 scratchpad（系統提示給的 `/tmp/claude-1011/…/scratchpad`），不要用 `/tmp` 根目錄。
- 長時間命令用背景並用有界的 bash 迴圈等（不要 sleep 超過 120 秒）。

## 5. 使用者原話（逐字，含日期；經領導轉述的標註）

- 2026-11-19（使用者）：「接手前面的工作，完成後要publish」／「接上run terminal的llc的opencl墊片」
- 2026-11-19（經領導轉述）：「我們這個session已經離很久，source code已經前進很遠了, blockly那邊可以不用管了」「要確保examples裡面的llc的gpgpu可以用opencl加速跑nbody3d, fluid3d」
- 2026-11-19（經領導轉述）：「我指的是opencl的gpu後端，讓它接到cudaweb的實做」
- 2026-11-19（經領導轉述）：「A, B都要」
- 2026-11-19（經領導轉述）：「我希望也有cuda後端，我們有幫 cudaweb做了不少優化」
- 2026-11-19（經領導轉述）：「我發現examples/llc/gui/music_player.ll 完全畫不出文字，我摸黑按1,2,3才知道可以切換方波」
- 2026-11-19（經領導轉述）：「sdl2_piano也不知道可以做什麼」
- 2026-11-19（經領導轉述，領導身分）：「你是領導」「領導如果使用sonnet, subsession就用haiku」「領導如果用opus, subsession就用sonnet」
- 2026-11-06（既有規則）：「提交並發布」（發布觸發語）；「週額度要重啟了，請放心用光」（只限週五晚 19:00 之後）；「請用ssh hungfu.lee@127.0.0.1」

## 6. 交接程序（自我遞迴）

1. 跑 `anthropic-skills:low-context-long-run`（THRESHOLD 30%）。每個批次邊界（一個已提交、已驗證的單位）用 `mcp__ccd_session_mgmt__get_usage` 檢查 context。
2. 低於 30% 就做下一個待辦；達到或超過 30% 就：重寫本文件（第 1–7 節）、提交（訊息說明是交接）、用 `mcp__ccd_session_mgmt__start_session`（`initiation: "user_asked"`、`context: "fresh"`、同一個工作目錄，title 形如 `llc OpenCL GPU · handoff 2`，prompt 用第 1 節的開場提示）啟動接手者。
3. 接手者回報「已讀文件、開始第 N 項」後，才 `mark_completed` 與 `archive_session` 自己（不 delete、不 clear）。沒接手就不 archive，告訴使用者。
4. 週額度 ≥88% 就停手、寫交接，不啟動接手。

## 7. 陷阱（已踩過）

- OpenCL 墊片（llc 的 llvm 版本）**不支援 `phi`**，要用 alloca／load／store；`malloc` 是 `i32` 參數（wasm32）。
- `opencl_vecadd.ll` 有 `if(i<n)`，所以 KIR 有沒有 else 的 if；`else` 會被拒絕。
- SDL 每幀超過 200 道繪圖指令會被丟掉（`llvm_host.js` 約第 352 行）；決定改 2000（第 3 節第 9 項）。
- 真 Electron 的 eval 跑的是**內嵌的範例**：改了 `renderer/src/examples/llc/*.ll` 要先 `node scripts/embed-code-ui.js && node build-assistant.js`，否則 eval 還在用舊的 .ll（我們踩過：eval 顯示「第一版不支援 phi」）。
- `scripts/run-core-tests.js` 沒有 `--full` 會退出 2；日常用單檔測試。`scripts/test-affected.js` 回報 0 個受影響測試，不能當作全部通過。
- WebGPU：`navigator.gpu` 存在但 `requestAdapter()` 回 null（這台）；WebGL2 可用。
- 背景任務的通知可能是舊的（先看 log 內容）。
- `git diff` 要在倉庫根目錄跑（`/home/hungfu.lee/下載/SRC/tw_stock_db`），在 desktop-app 子目錄會因 safe.directory 失敗；用 ssh 跑 git 比較穩。
- 網頁版倉庫 `videos-嗨投資` 不在這台機器（舊事實）；發布用 `--no-web`（領導決定）。
- 子 session 的數字是轉述，要自己驗證。

## 8. 2026-11-20 補充：WebGPU 裝置層（子 session 完成的部分）

完整數字與狀態表見 `DESIGN.webgpu-cuda.md` §13「階段 7」。摘要：

- **已提交**：`a46cfcfd5`（裝置層 `kir_webgpu.js` 與假裝置測試）、`964245a3e`（真 GPU eval 與內嵌產生器）、`46b517ddf`（workgroup 共享記憶體分塊預設開、展開選項、量測數字）。
- **真 GPU 驗證過**（這台 NVIDIA Kepler，Electron）：nbody3d_cl 與 fluid3d_cl 的四個核心都能在 WebGPU 編譯、執行、讀回；對 KIR JS 後端的相對誤差 nbody 4.8e-5、fluid 3e-6。
- **真 GPU 數字（每步、4 個核心）**：nbody N=3072 分塊 WebGPU 9.96 ms、未分塊 23.9 ms、WebGL2 54 ms；fluid N=1000 分塊 2.00 ms、未分塊 3.37 ms、WebGL2 5.6 ms。分塊的加速在兩次獨立執行都穩定。
- **沒有改善、只留選項**：工作群自適應（結果每次不一致）、內層展開 4 次。f32x4 向量化與 subgroups 沒做（見 §13 階段 7 表）。
- **未做（卡住，需要管理者決定）**：host 接線。`clEnqueueReadBuffer` 在 WebGPU 上要非同步讀回（JSPI 的 `async` import），但 node 16 沒有 JSPI，`llvm_host.test.js` 會失敗；`_kirHostHooks` 在 `floating-assistant.js`，這次規則不准改。建議：新模組 `renderer/src/gpu/kir_host_hooks.js`，並決定 OpenCL 的測試是否改在 Electron 跑。
- **不要做**：不要 `git push`，不要跑 `scripts/publish.sh`（管理者做）。

**下一步順序**：(1) 決定 JSPI 與 node 測試的做法；(2) 寫 `kir_host_hooks.js`（WebGPU → WebGL2 → JS，失敗要有具體原因）；(3) `llvm_host.js` 的 `clEnqueueReadBuffer` 改非同步（只有 WebGPU 裝置時）；(4) HUD 的後端字樣加上 WebGPU；(5) 在使用者真機重測（這台的工作群結果不穩定）。

## 9. 2026-11-20 補充：host 接線與端到端（子 session 第二批）

- 詳細數字與限制見 `DESIGN.webgpu-cuda.md` §13「階段 8」。
- **真 Electron 驗證過**：nbody3d_cl 在 WebGPU 與 WebGL2 上都實際派送，輸出與 CPU 版相同，HUD 顯示實際後端；JS 墊片會退回 CPU 積分。
- **沒有量到**：fluid3d 的每步耗時；JS 墊片路徑的 HUD 文字未逐字驗證。
- **已修正的 bug**：`llvm_host` 只在有同步 `kirRun` 時翻譯核心，WebGPU 因此全部退回 CPU。
- **還沒做**：讀回合併（4 次 `mapAsync`）、WebGPU 中途失敗時換成 WebGL2、f32x4 與 subgroups。
- **建置輸出不 add**：`renderer/floating-assistant.js`、`.min.js`、`update-manifest.json`、`web-lazy/` 由管理者重產。

## 10. 2026-11-20 補充：OpenCL 與繪圖的 interop（階段 6 步驟 2）

- 詳細數字與限制見 `DESIGN.webgpu-cuda.md` §13「階段 9」。
- **選擇：路線 A（WebGPU 直接畫位置 buffer，經 `drawImage` 進 2D 畫布）**，只用在 WebGPU 後端。真 GPU 上每幀約比讀回版快 6.6 ms（經 2D 橋接）；路線 B（WebGL2 `texelFetch`）只省約 2.5 ms，且要求 KIR 與 GUI 共用 GL context，目前做不到。
- **已驗證（真 GPU，NVIDIA Kepler）**：路線 A 的像素與讀回版相同（最大差 0）；路線 B 同樣相同；WebGL2 context 遺失會丟例外（真 GPU 與 swiftshader）。
- **未驗證**：`drawImage` 是否在 GPU 內完成（只有時間與像素證據）；2D 畫布到 GUI 的 WebGL2 畫布這一段沒量；`transferToImageBitmap` 在 WebGPU 畫布上不存在。
- **沒有接進 app**：GUI 的 `glframe` 協定還沒有「從 GPU 點雲來源畫點」的操作。
- **nbody 仍要讀回**：`cluster()` 每幀讀 x、y、z、ms、pot 算攝影機中心，任何路線都避不開；要解掉要在 GPU 上做歸約（另外排）。
- **GL 批次上限**：`llvm_host.js` 的 `slice(0, 20)` 改為 `GL_MAX_BATCHES_PER_FRAME = 1024`，超過會 `console.warn`；實際幀批次數還沒量。
- **沒有做**：app 接線、cluster 的 GPU 化、f32x4、subgroups。
- **評測指令**：`node scripts/eval/kir_interop.build.js <輸出>`，再 `FA_EVAL_GL=gpu node scripts/eval/run_eval.js <輸出>`（軟體 GL 用 `FA_EVAL_GL=swiftshader`，此模式沒有 WebGPU）。
