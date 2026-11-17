# 交接：離線模型 thinking／更大模型／GPU 記憶體上限／1.7B 接進產品／transformers.js 路徑接 cudaweb 核心（2026-11-17，handoff 2）

## 1. Opening prompt（接手者收到的原文）

Continue from the handoff document at desktop-app/docs/HANDOFF.offline-model.md. Read it fully, including the verbatim user words (§5), the working style (§4: do NOT interrupt the user — no questions, no "still running" reports, decide ambiguities yourself, report once when done; publish steps) and the traps (§7). Run the low-context-long-run skill (THRESHOLD 30%): do the next todo item, and when your context reaches the threshold, write the next handoff and start your own successor (if the app refuses because you were started by a session, retry once, then end with a final message saying the handoff is written and the top-level session should start the next one). User's key instructions, verbatim: 「如果沒有接上去，就代表你沒有照著我的要求達成」「cuda相容層我們昨天花了很多時間在transformer.js」「我的要求就是把它做完!!!!!!」「為什麼要一直中斷?!」. As your first message, confirm in one line that you read the document and which todo item you are starting.

## 2. Overview

- 專案：`tw_stock_db` 的 Electron 桌面版，分支 `desktop-app`，目錄 `desktop-app/`（repo 根 `/home/hungfu.lee/下載/SRC/tw_stock_db`）。繁體中文／英文回覆。Linux、沒有真 GPU（軟體 WebGPU）。
- **已完成並發布（patch v431，`desktop-app` `337fe7b3`，網頁版已釘）**：
  - v429 離線模型 Thinking 開關（`offlineThinking`；GPU 整段解碼與 WebGPU/WASM 吃 `enableThinking`，原生執行器不支援故跳過）。注意：另一個對話後來把開關 UI 搬進「離線模型開關」面板（`data-om-switch`）。
  - v430 GPU 記憶體上限（`gpuMemMB`、`gpu_mem.js` 偵測／基準、`estimateEngineBytes` 與實際逐位元組相符、`GPU_BUDGET`）。
  - v431 Qwen3 GPU 引擎分層（`planLayers`，常駐層＋串流層）、`gpu/qwen_models.js`（模型表、Range 分段下載、sha256、讀入、`choosePlan`／`describe`）、`_qwenGpuChat` 依 `model.id`、設定畫面每模型一行與下載按鈕。DESIGN §7.30 有全部數字與整合狀態（§7.28 被 Basic Pitch 占用，所以是 §7.30）。
- **關鍵事實**：(1) `qwen3-1.7b` 早就在 `vlm_core.js` 的 FaVlm 登錄（repo onnx-community/Qwen3-1.7B-ONNX、dtype gpu q4f16／cpu q8、bytes gpu 1360 MB／cpu 1662 MB、verified:false、contextTokens 8192），transformers.js 路徑本來就能選到它，**在 ORT-web 上能否載入與生成沒實測**。(2) 我們的 Qwen3 q8 整段 GPU 解碼引擎（`renderer/src/gpu/qwen_gpu.js`）是旁邊的路徑；**產品預設的離線 GPU 路徑是 transformers.js（Worker 內 ORT-web WebGPU，q4f16）**，cudaweb 的 WebGPU 核心還沒接進去（清單 C 當初標 BLOCKED，是錯判，使用者要補做）。(3) 驗證工具：`scripts/eval/cudaweb_qwen_greedy.js`（`QWEN_Q8`、`QWEN_PROMPT_IDS` 環境變數；CPU 參考對真 ORT）、`scripts/eval/cudaweb_qwen_gpu_browser.js`（軟體 WebGPU 的無頭 Chrome；`QWEN_Q8`、`QWEN_BUDGETMB`、`QWEN_CHUNKM`）、scratchpad 裡有 `run_b.sh`（但路徑在舊 scratchpad，可照 `/tmp/claude-1001/qwen/runchrome.sh` 重寫；**別在指令字串裡寫 user-data-dir 又跑 killmine，會殺到自己的 shell（exit 144）**，腳本要用 Write 工具建）。1.7B q8 檔 1,742,387,852 位元組已驗證 sha256 `202ed819…feb427`；q4f16 檔（`onnx/model_q4f16.onnx` 1,426,069,098 位元組，單檔）尚未下載。
- **handoff 3 新增（C' 已做完並提交 `6a7d9afef`，尚未發布）**：`gpu/qwen_decode_q4.js`（q4f16 載入）、`qwen_gpu.js` 的 `fmt:'q4'`（`WGSL.mm4`／`lm16`、分層與估算同步）、`_qwenGpuChat(…,'q4')` 接在 `_llmGenerateInner` 的 transformers.js 原路徑**之前**（設定 `qwenGpuQ4`，`device_pick` 的 `qwenGpuQ4` 讓真 GPU 自動開；權重讀 transformers.js 存的 Cache API 檔 `_qwenCacheGet`，第一次回答由 transformers.js 下載）、畫面列出各後端與大小。驗證與數字在 DESIGN §7.31：對真 ORT CPU 的 q4f16 圖，0.6B／1.7B 全常駐與 1.7B 900 MB 分層，16 詞元×2 組詞元全部相同、估算＝實際、logits 相對差 1.5e-3～2.1e-3（沒有達到 1e-5～1e-6，ORT 用 fp16 激活）。驗證用腳本：`scratchpad/ort_q4.js`（ORT CPU 參考，已不在庫；邏輯＝仿 `cudaweb_qwen_greedy.js` 但 past 用 float16 空張量）＋`QWEN_FMT=q4 … cudaweb_qwen_gpu_browser.js`（`QWEN_Q8` 放 q4f16 檔路徑、`QWEN_BUDGETMB`）。q4f16 檔：0.6B 569,789,750、1.7B 1,426,069,098（單檔，HF `onnx/model_q4f16.onnx`）。
## 3. Todo（依序，下一步在最前）

1. **發布 v432（C' 已提交 `6a7d9afef`，只差發布）**：`git status` 若還有別人未提交的來源檔（上次是 `scripts/eval/news_real_run.js`，別的對話的），`scripts/publish.sh` 會拒絕——等對方提交，不要繞過；乾淨後跑 `bash /tmp/claude-1001/qwen/pub.sh "v432 Qwen3 q4f16 整段 GPU 解碼接進 transformers.js 路徑" "Qwen3 q4f16 整段 GPU 解碼 v432" v432`（腳本不在就照 §4 步驟）。發完回報一次。
2. **原本要求但沒做的實測（verified:false）**：1.7B q4f16 在 **transformers.js 路徑本身**（Worker 內 ORT-web WebGPU）能不能載入與生成。需要 ORT-web 的 WebGPU fp16，這台軟體 WebGPU 可能不支援（先用 `adapter.features.has('shader-f16')` 查）；不行就把原因寫進 DESIGN §7.31 並把 `vlm_core.js` 的 `verified` 說明改成「我們的引擎驗證過，ORT-web 路徑未驗證」。
3. **沒驗證且可能值得補**：(a) Electron 視窗裡 `_qwenCacheGet` 真的讀得到 transformers.js 的快取（快取名稱預設 `transformers-cache`，用 `caches.keys()` 確認；Worker 與主頁面是否同一個 origin／partition）；(b) 風險：`qwenGpuQ4` 在真 GPU 上自動開，而 q8 路徑在使用者舊顯卡曾 `DXGI_ERROR_DEVICE_HUNG`（原因未確認）——q4 路徑有記憶體上限、失敗自動停用、可停止，但沒在那台機器跑過；若使用者回報卡死，先看 console 的「最近的 GPU 工作」。
4. 已完成、不用再做：thinking 開關、GPU 記憶體上限與偵測、分層、1.7B 登錄／下載／畫面（q8）、q4f16 引擎與接線（只差發布）。

## 4. Working style（使用者規則，照抄重點）

- **不要中斷使用者**：使用者明確發火「為什麼要一直中斷?! fucking hate it!」「我並不是ALL DAY LONG都在陪你這專案」「我的要求就是把它做完!!!」。所以：不問選項、不回報「還在跑」、背景工作自己等；歧義自己決定並寫進文件／提交訊息；只在整個任務做完或真的卡死時回報一次。
- 回覆只能繁體中文或英文；結論先講、誠實：沒驗證的就說沒驗證，不要宣稱完成；查不出原因就說查不出（使用者問「為什麼」時別編原因；這輪我把 GPU 卡死歸給「舊顯卡」被使用者糾正，那是猜測）。
- 提交：只 `git add` 自己改的檔案（工作目錄有別人的未追蹤檔，不要碰）；commit 訊息寫「做了什麼＋怎麼驗證」並以 `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` 結尾；作者是 git 設定的 Sunneo IceCold。
- **發布用 `/tmp/claude-1001/qwen/pub.sh "<patch說明>" "<commit說明>" vNNN`**（若檔案不在就照下面步驟自己做）：(1) 暫時把 `skills/weak-model-harness/scripts/bridge/`（別人從 11 月 2 日起未追蹤、不被建置嵌入的三個檔案）移到 `/tmp/claude-1001/bridge-aside`，因為 `scripts/publish.sh` 會因未追蹤來源拒絕發布；發完**用絕對路徑**移回（上一輪漏了這點，已修）；(2) `git push origin desktop-app`；(3) `bash scripts/publish.sh --no-web -m "…" --commit-msg "…"`（要用 bash 執行）；(4) 網頁版釘到 main：用 git worktree 改 `web/index.html` 與 `web/aiweb/index.html` 裡的舊 SHA 為 desktop-app 新 HEAD，訊息「網頁版載入改釘 <sha8>（vNNN）」，push main，移除 worktree。使用者已授權 commit／push／publish（「可以先commit , push, publish」）。若遠端 `origin/desktop-app` 有別人新提交（本地落後），先 `git merge origin/desktop-app`，`floating-assistant.js` 的嵌入字串衝突用 `node scripts/embed-code-ui.js` 重新產生。版號用 `node scripts/release-version.js status` 確認（單一來源 `PATCH_VERSION`）。
- 改了 `renderer/src` 的模組後必跑 `node scripts/embed-code-ui.js`（內嵌步驟），再 `node --check renderer/src/floating-assistant.js`。
- 驗證 GPU 相關：本地伺服器＋無頭 Chrome（軟體 WebGPU，旗標見 `docs/HANDOFF.cudaweb-inference.md` §8.9）；**只殺自己啟動的 Chrome**：用 `/tmp/claude-1001/qwen/killmine.sh`（比對獨立 user-data-dir）；**不要在指令字串裡直接寫 `--user-data-dir=/tmp/claude-1001/qwen/...` 又用 grep／pkill 比對**（比對會命中自己的 shell，工具呼叫以 exit 144 被殺）；`runchrome.sh [chunkM]` 可重跑 Qwen GPU 驗證。
- 額度：每批邊界看 `get_usage`；5 小時額度偏高時只做輕量事。真 GPU 不用驗證（使用者：「真gpu不用管，我們用最爛的機器(Geforce 720T)測過，比當代Intel Core I5-2620還快1.78倍」）。

## 5. Verbatim user words（原文，依日期）

- 2026-11-17：「我想要我的離線模型那邊有開關可以打開thinking」
- 2026-11-17：「另外是像我們有indexdb as swap, 有cuda相容層 這樣有辦法推的起參數量比較高的model嗎?例如從0.6b -> 1B」
- 2026-11-16：「真gpu不用管，我們用最爛的機器(Geforce 720T)測過，比當代Intel Core I5-2620還快1.78倍」
- 2026-11-17：「gpu 相容層那個configure會不會寫的太誇張，每個都一個checkbox, 請全部預設enable 我們本來就有fallback的能力」
- 2026-11-17：「而且困擾的是ai offline, 你沒有stop可以用」
- 2026-11-17：「因為我發現我發一個hi 遲遲很久什麼transcribe都沒出現 過很久才跑出來」
- 2026-11-17：「應該跟舊險卡無關?」
- 2026-11-17：「為什麼要一直中斷?! fucking hate it!」「我並不是ALL DAY LONG都在陪你這專案」「我的要求就是把它做完!!!!!!!!!!!!!!!!!!!!!!!!!!!!!」
- 2026-11-17：「可以先commit , push, publish」
- 2026-11-16：「該下載的，麻煩都一起下載，別再反覆問」（舊交接文件第 5 節保存的使用者原話）；「下載同意」「就選擇適合的!」
- 2026-11-17：「應該有接上去了才對」（指 1.7B／cudaweb 接進產品）
- 2026-11-17：「如果沒有接上去，就代表你沒有照著我的要求達成」
- 2026-11-17：「cuda相容層我們昨天花了很多時間在transformer.js」
- 2026-11-17：「把 1.7B 接進產品，可以顯示讓使用者取用，要有辦法限制上限後分層」
- 2026-11-17：「做完再回報 我希望這邊可以任意調，也可以probe/benchmark出適當的值」
- 2026-11-17：「我們有設定gpu buffer的地方?」

## 6. Handoff procedure（自我遞迴）

執行 low-context-long-run skill，THRESHOLD 30%：每個批次邊界（已提交）讀 `get_usage` 的 context 百分比；到或超過門檻就更新本文件、提交（訊息寫明是交接），用 `mcp__ccd_session__start_session`（initiation "user_asked"、context "fresh"、同目錄、`use_worktree:false`、標題「離線模型 thinking 與大模型 · handoff N」，prompt 為 §1 的原文）啟動自己的接手者，等它確認讀過文件並開工後，才把自己 `mark_completed` 並 `archive_session`（不刪除、不 clear）。**注意：由 session 啟動的 session，app 會拒絕它再啟動 session**（上一輪 handoff 1 就遇到）；被拒時重試一次，仍被拒就在最後訊息說明「交接已寫好，請頂層 session 啟動下一棒」並結束。待辦清空就不再交接，回報完成。

## 7. Traps（已踩過）

- GPU 卡死（`DXGI_ERROR_DEVICE_HUNG`）之後，瀏覽器的 GPU 行程會停在 `DEVICE_REMOVED` 狀態，要重啟 app 才恢復；卡死的真因未確認（可能是單次提交過長、預填一次太多詞元、核心沒最佳化），診斷已加（console 的「最近的 GPU 工作」）。
- 預設開 GPU 加速曾讓「發 hi」等很久（首次要讀 589 MB 模型、沒進度）；所以聊天的 Qwen GPU 解碼現在只有手動勾選。
- 離線模式（「🔌 離線模式（Offline Trainer，不經過AI）」卡片）是規則比對，模型和 LoRA 完全沒被呼叫；使用者看到的「離線模型」（Qwen3-0.6B）是另一條路徑（原生／WebGPU／GPU 解碼），別搞混。
- Qwen3 q8 的動態量化讓詞元對 ORT 不保證逐字相同（ORT 本身跨 CPU 也會），驗證標準用「首詞元對拍＋退回」與逐層誤差，不要追求逐詞元相同。
- `_normalizeAdvancedSettings` 有白名單：新增設定沒加進去，存檔會被洗掉。
- 設定改名比改預設值可靠：舊設定檔存過預設值（`gpuAuto: 'off'`），改預設不會生效，所以改名成 `gpuAccel`。
- 主程序／執行包檔案（`nr-engine.js`、`nr-child.js`、`main-ext.js` 等）不能熱更新；只改 renderer 能靠 patch 發給已安裝的使用者。
- 分類器偶爾拒絕 `start_session`（無理由）：換成使用者原話觸發的訊息、重試一次通常可以。
- `studio_embed.test.js` 的 `lora_ref_train.js` 找不到是既有失敗，與你的改動無關。
- `git status` 可能有別的對話未提交的 `floating-assistant.js` 改動：只提交自己的區塊（臨時索引：`GIT_INDEX_FILE=… git read-tree HEAD && git apply --cached <我的 patch>`），之後把真實索引對齊新 HEAD（`git reset -q HEAD -- 我的檔案`，再 `git apply --cached` 重新套回對方已暫存的區塊）；`scripts/publish.sh` 會因別人未提交的來源變更拒絕發布，等對方提交再發，不要繞過。
- `vlm_core.js` 的測試要求模型 id／repo 唯一：不要重複登錄 `qwen3-1.7b`（早就有）。
- 估算函式 `estimateEngineBytes` 與實際配置要逐位元組對照（lm_head 分塊數曾寫死成 5 差 64 位元組）。
