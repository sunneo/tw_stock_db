# 交接：離線模型 thinking 開關＋更大模型（0.6B→1B 級）可行性（2026-11-17）

## 1. Opening prompt（接手者收到的原文）

Continue from the handoff document at desktop-app/docs/HANDOFF.offline-model.md. Read it fully, including the verbatim user words and the working style, and follow them. Run the low-context-long-run skill (THRESHOLD 30%): do the next todo item, and when your context reaches the threshold, write the next handoff and start your own successor. As your first message, confirm in one line that you read the document and which todo item you are starting.
使用者原話：「我想要我的離線模型那邊有開關可以打開thinking」「另外是像我們有indexdb as swap, 有cuda相容層 這樣有辦法推的起參數量比較高的model嗎?例如從0.6b -> 1B」「我的要求就是把它做完!!!!!!」「為什麼要一直中斷?!」

## 2. Overview

- 專案：`tw_stock_db` 的 Electron 桌面版，分支 `desktop-app`，目錄 `desktop-app/`（repo 根 `/home/hungfu.lee/下載/SRC/tw_stock_db`）。使用者寫繁體中文，回覆只能繁體中文或英文。Linux 機器，沒有真 GPU（Chrome 只有軟體 WebGPU）；使用者自己的 Windows 機器有 Geforce 720 等級顯卡。
- 本次新任務（尚未開始實作）：(A) 離線模型（Qwen3-0.6B）加一個「開啟 thinking」的設定開關；(B) 回答並（可行就）驗證「用 IndexedDB 當 swap、CUDA 相容層，能不能推動參數量更大的模型，例如 0.6B→1B 級」。
- 已發布的現況：patch v428（`desktop-app` `9827ae8b`，`desktop-app-patch` 已發，網頁版 `main` 已釘 `9827ae8b`）。本輪之前的 cudaweb 工作全部在 `desktop-app` 上，詳見 `docs/HANDOFF.cudaweb-inference.md`、`docs/CHECKLIST.cudaweb-wire.md`、`DESIGN.webgpu-cuda.md` §7.13～§7.27。
- GPU 現況重點：設定 `gpuAccel`（總開關，預設開；舊 `gpuAuto` 已改名）＋「進階」摺疊區的個別勾選；`device_pick.js` 只要真 GPU 就開各路徑；**Qwen3 聊天的 GPU 解碼（`qwenGpuDecode`）已不在自動清單，只有手動勾選才用**（原因：要讀 589 MB q8 模型、使用者的 Windows 機器曾發生 `DXGI_ERROR_DEVICE_HUNG`，原因未確認）。GPU 裝置遺失時 console 會印「最近的 GPU 工作」（診斷已加）。
- Qwen3 q8 GPU 引擎（`renderer/src/gpu/qwen_decode.js`、`qwen_gpu.js`、`qwen_chat.js`）的形狀參數（D、H、Hkv、I、L、V）都從權重讀，`hd` 限制 ≤128（Qwen3 全系列 hd=128），所以 **Qwen3-1.7B（onnx-community/Qwen3-1.7B-ONNX 的 q8，約 1.8 GB）理論上不改程式就能載入**——這點尚未驗證；Qwen3 沒有 1B，0.6B 之上是 1.7B、4B。
- 離線模型 thinking 現況（要先查證）：`_qwenGpuChat` 內有 `enable_thinking: a.enableThinking === true ? undefined : false`；設定面的 CoLU 有 `coluThinking`（`FaRecipe.coluThinkingSetting`）；原生路徑用 `nr-template.js`／`nr-gen-params.js`（根目錄，唯一實作）；`FaVlm`（transformers.js 路徑）有自己的樣板。要確認三條離線路徑（原生子程序、WebGPU/WASM transformers.js、GPU 整段解碼）各自怎麼決定 thinking，統一由一個設定控制。

## 3. Todo（依序，下一步在最前）

1. **thinking 開關**：新增設定（建議名 `offlineThinking`，預設 `off`，因為現行行為是關）。步驟：(a) Grep `enableThinking`、`enable_thinking`、`coluThinking` 找出三條離線路徑決定 thinking 的位置；(b) 加預設值、`_normalizeAdvancedSettings` 白名單（記得，否則存檔會被洗掉，之前 `nrGpuHead` 犯過）、設定 UI（AI 助理設定與桌面版設定頁共用一處，放在離線模型相關的區塊；`_gpuCompatControls` 是 GPU 專用，不要放那）；(c) 三條路徑都吃這個設定（原生路徑要把旗標帶進 `_nrRunNative` 的 payload 並確認 `nr-engine.js`／`nr-template.js` 支援；注意 nr 檔案屬主程序／執行包，**不能熱更新**，若要改只能寫進說明，改 renderer 能做到的部分）；(d) thinking 開時輸出會有 `<think>…</think>`：確認顯示、`cleanText`（`qwen_chat.js`）與聊天歷史怎麼處理，別讓它被當垃圾輸出擋掉（`FaVlm.looksLikeGarbage`）；(e) 單元測試＋`node scripts/embed-code-ui.js`＋`node scripts/test-affected.js`（完整測試不要跑；`studio_embed.test.js` 的 `lora_ref_train.js` 失敗是既有問題）；(f) 提交、發布（見 §4）。
2. **更大模型可行性**：寫成 `DESIGN.webgpu-cuda.md` §7.28（短，附數字）並用實測支撐，不要只憑推論。重點：(a) 記憶體：1.7B q8 約 1.8 GB；`Uint8Array` 能裝，但 `readLargeFile` 分段讀入的記憶體峰值、`createGpuEngine` 把權重寫進 GPU 的總量（每個矩陣一個緩衝區，單個遠小於 128 MiB 上限；lm_head 分塊）；使用者的 Geforce 720 顯存可能只有 1～2 GB，裝不下時需要「分層串流權重」（每層用到才寫入 GPU，PCIe 頻寬約 8 GB/s → 1.8 GB 每詞元約 0.2 秒以上）——這才是「swap」的真正位置；IndexedDB 只能當權重快取（避免每次啟動重讀 1.8 GB），不是運算 swap；CUDA 相容層是給 Python numba／cupy 程式用的，與這條 JS 引擎無關，不能拿來加速模型。(b) 驗證：用 Qwen3-1.7B q8（使用者已同意該下載：「該下載的，麻煩都一起下載，別再反覆問」，來源 `onnx-community/Qwen3-1.7B-ONNX`，先唯讀確認確切檔名與大小再下載到 scratchpad，不入庫）：CPU 參考引擎對真 ORT 貪婪 8 詞元（`scripts/eval/cudaweb_qwen_greedy.js` 的 `QWEN_Q8` 環境變數換模型），再用 `scripts/eval/cudaweb_qwen_gpu_browser.js` 在軟體 WebGPU 跑 GPU 引擎；形狀參數（H=16、Hkv=8、D=2048、I=6144 預期）看引擎會不會丟錯。(c) 結論寫清楚：能不能、要改什麼、速度與顯存預估、哪些沒量到（真 GPU 不用管，使用者已說測過）。
3. 若 (2) 的結論是「可行」：評估把第二個離線模型（1.7B）加進產品的模型登錄與下載流程需要改哪些地方（原生模型 ID 是 `qwen3-0.6b`、`native-models/qwen3-0.6b-q8`、`FaVlm` 模型表、`MOSS_FILES` 風格的下載清單），寫成待辦寫進 DESIGN，不要在沒被要求時一次全做。

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
