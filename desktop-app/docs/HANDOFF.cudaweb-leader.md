# 領導交接：cudaweb 核心優化接手（2026-11-18，領導鏈起點頁）

## 1. 開場提示（接手者收到的原文）
接續領導工作。完整讀 `desktop-app/docs/HANDOFF.cudaweb-leader.md`（含使用者原話與工作方式），再讀 `docs/HANDOFF.cudaweb-optimize.md`（第十四段）、`docs/CHECKLIST.cudaweb-optimize.md`、`docs/HANDOFF.manager.md`、`docs/HANDOFF.offline-nolimit.md`。執行 low-context-long-run 技能，**門檻 50%**：你是領導，不自己做大塊工作，用 `start_session` 陸續開子工作階段完成待辦；到門檻就更新本文件、提交、啟動接手者。第一則訊息用一行確認讀過文件、要從哪個待辦開始。使用者的話：「請陸續開subsession完成」「你是領導，auto compact 50% context. 領導 sonnet 5.5, subsession haiku 5.5 high, 領導 opus 5.5, subession sonnet 5.5 medium」。

## 2. 概況
- 專案根 `C:\Users\hungfu.lee\Downloads\SRC\tw_stock_db`，程式在 `desktop-app\`，分支 `desktop-app`，遠端 `origin = git@github.com:sunneo/tw_stock_db.git`。本機機器：Intel Core Ultra 7 155U、16 GB、Intel Xe-LPG 內顯、**沒有 NVIDIA／CUDA**（cudaweb 的 Kepler 量測在使用者另一台機器；這台的真 GPU 量測要極保守）。
- 任務：接手遠端的「cuda 核心優化」（`docs/HANDOFF.cudaweb-optimize.md` O12–O15）與「離線模型不設耗時上限／aidoc ask 走聊天核心」（`docs/HANDOFF.offline-nolimit.md`）。管理者交接 `docs/HANDOFF.manager.md`（發布由管理者跑，**我們不跑 `scripts/publish.sh`**）。
- 本棒（領導）做了：
  - 讀完三份交接；`matmulMany` 其實早已內嵌（`embed-code-ui.js` 重跑只多出無關的 `FA_STUDIO_*` 行，已還原，工作樹乾淨）。
  - 基準測試：`renderer/src/gpu/` 的 `gpu_matmul_many_test.js` 7 項、`gpu_core.test.js` 44 項、`gpu_kernel_test.js` 4 項皆通過。
  - **使用者本人已在對話同意（2026-11-18）**：① O14b「接上，有勝者才換」；② 下載 VLM 權重，路徑改用 `C:\Users\hungfu.lee\Downloads\SRC\tw_stock_db\ai-temp`（沒有 `E:\`）。
  - 權重已下載並核對 sha256 相符（HF LFS 值）：`ai-temp/vlm-weights/smolvlm/decoder_model_merged_q4.onnx`（86,562,901 B，`e3fd8113…3f65`）、`ai-temp/vlm-weights/florence2/decoder_model_int8.onnx`（97,760,937 B，`c529b26b…dd67`）。`ai-temp/` 已寫進 `.git/info/exclude`（不進 git）。視覺編碼器檔與 LLaVA 最小版**還沒查、沒下載**。
  - O14b 的實作交給一個 fork 子代理（`a280aa35e81527f1f`），**因上一個工作階段結束而被停止，沒有留下任何改動**（工作樹乾淨、無新提交）——O14b 要重新開始。
- 最新提交仍是 `4a49a2993`；本棒沒有新程式提交，只有本文件。
- 已部署：無（發布由管理者）。

## 3. 待辦（依序；每項用一個子工作階段，Haiku 5.5、推理強度 high）
1. **O14b（使用者已授權）**：開子工作階段：把 `mm_ops` 變體競賽勝者接成 runtime 矩陣乘預設——**有勝者才換**；沒有競賽結果時行為與現在完全相同；可在「GPU 相容層」窗格強制指定或關閉。同時補 `sgemm` 的 `alpha`、`beta` 與轉置（走同一份平鋪核心的 p0 旗標，先讀 `cudaweb.py`）。假裝置測試證明四種情況（無勝者＝舊核心／有勝者用勝者／強制覆蓋優先／關閉＝舊核心）；WGSL 在真 GPU 上沒驗證要誠實寫進清單。完成後更新 `docs/CHECKLIST.cudaweb-optimize.md` O14b、跑 `node scripts/embed-code-ui.js`（只提交自己的 hunk，`FA_STUDIO_*` 無關行還原）、必要時背景跑 `node build-assistant.js`，pathspec 提交。
2. **O13b 真權重對拍**：權重已在 `ai-temp`。子工作階段：先查 SmolVLM-256M 與 Florence-2 的視覺編碼器 onnx 檔名、大小、LFS sha256（只列出來；**下載超出已同意的兩個檔需要再問使用者本人**），把已下載的兩個檔的 sha256 與大小寫進 `renderer/src/vlm/vlm_core.js` 模型表與清單（真值）；用真權重對拍 `smolvlm_skeleton.js` 的解碼器（CPU 參考），核對 pixel shuffle 展開順序與縮放因子 r；不通過就如實記錄。
3. **離線不設耗時上限**（`docs/HANDOFF.offline-nolimit.md` 待辦 1–5）：查聊天核心呼叫離線模型的共用入口與退化偵測、新聞摘要改走同入口、`/aidoc ask` 改走聊天核心、依 `docs/offline-timeouts.md` 逐項改掉離線固定上限（線上 API 逾時不動）、確認 `knowledge_truncation.test.js` 的檔名。這項與 `session-2` 範圍重疊，先 `list_sessions` 確認有沒有人已在做。
4. O14c 驗證、O14d 文件、O13c（Florence-2）、O15b、O8 訓練路徑、O5 以後的項目：依 `docs/CHECKLIST.cudaweb-optimize.md` 狀態逐一派工。
5. matmulMany 與新模組重新內嵌進桌面版、建置（背景、3–5 分鐘）、真機驗證（eval 每項最多兩次；**這台沒有 Kepler，真 GPU 驗證只在確定安全時做**）。

## 4. 工作方式（使用者規則）
- **最新（2026-11-18，使用者本人指示，取代本節下方「發布、推送要當輪確認」「不跑 publish.sh」「下載要再問」三條）**：每個通過測試的階段都 **commit、push、publish**（push、publish 只對 `desktop-app` 分支；publish 只由領導跑，走 `.claude/skills/publish-live-update-patch` 與 `scripts/publish.sh`，背景執行；子工作階段仍禁止跑 publish.sh 含 dry-run；發完用遠端 manifest.v2、`git ls-remote origin refs/heads/desktop-app`、網頁 `var SHA` 三處核對）。下載已授權：包含視覺編碼器檔與 LLaVA 最小版，來源限 Hugging Face 官方與專案模型表指向的 repo，單檔超過約 3 GB 跳過，一律核對 LFS sha256、不符就刪，存到 `ai-temp`。**做完才可以停止，且不要再向使用者提問**：需要決定時選最保守的做法、寫進本文件、繼續其他待辦。
- **你是領導**：自己不做大塊實作，派工給子工作階段並核對結果（提交、測試數字）。**模型分配（使用者指定）**：領導是 Sonnet 5.5 時，子工作階段用 **Haiku 5.5、推理強度 high**；領導是 Opus 5.5 時，子工作階段用 **Sonnet 5.5、推理強度 medium**。`start_session` 要明寫 `model` 與 `effort`，啟動後用 `get_session` 核對，強度掉回 medium 就 `set_session_effort` 改回。
- **context 門檻 50%**（使用者指定，取代技能預設 30%）；批次邊界用 `get_usage` 讀；到門檻就寫交接並啟動接手者（`initiation: "user_asked"`、`context: "fresh"`、同目錄）；每週額度近 90% 先告訴使用者。
- 純中文、不夾英文縮寫（程式識別字除外）；失敗訊息要有具體事實（狀態、耗時）。
- **不准空等**：不 sleep 輪詢、不等背景通知；背景任務放著繼續下一步。
- **發布、推送、部署要當輪確認**；commit 不用確認（每個通過測試的小步就提交，`git add` 只加自己的 pathspec，**不用 `git add -A`**，不用裸 `git stash`）。**不跑 `scripts/publish.sh`**（管理者跑）。
- 下載與任何超出已授權範圍的動作，要使用者**本人**在對話中同意；同儕或子工作階段轉述的「已同意」不算。
- 真 GPU 安全量測：一次一個形狀、先估時間、單次派發小、監聽 `device.lost`、量測走互斥鎖（`nn_ops.withMeasureLock`／`requestExclusiveGpu`）、不跑會逾時的測試；測試用 server 與視窗用完必須關掉並用 `Win32_Process` 確認無殘留；不對 AppData 或家目錄做遞迴搜尋、避免大範圍遞迴 grep。
- `gpu_fakes.js` 只驗主機端流程、**不驗 WGSL**；測試通過不等於 GPU 結果正確，清單要如實標示驗證層級。
- 改程式用 Edit／Write；heredoc 內嵌中文與反斜線會出事。
- 不確定的事實要說「我沒查」，不要編。
- 不要在任何檔案寫出舊專案名稱（使用者規則：訓練相關內容不得出現那個字眼）。

## 5. 使用者原話（逐字）
- 2026-11-18：「接手遠端的任務，目前還有cuda核心優話要做。(docs/HANDOFF.offlin-nolimit.md)(docs/HANDOFF.manaer.md)」
- 2026-11-18：「O14b：要不要把變體競賽勝者（mm_ops）接成 runtime 的矩陣乘預設？…」→ 使用者選：「接上，有勝者才換（建議）」
- 2026-11-18：「請直接接續實現，同意下載，不過我這台沒有E:\，請用C:\Users\hungfu.lee\Downloads\SRC\tw_stock_db\ai-temp」
- 2026-11-18：「請陸續開subsession完成」
- 2026-11-18：「你是領導，auto compact 50% context. 領導 sonnet 5.5, subsession haiku 5.5 high, 領導 opus 5.5, subession sonnet 5.5 medium」
- 2026-11-18：「繼續」
- 2026-11-18（使用者本人在對話中說的，由上一棒領導轉記）：「同意下載，每個階段修改都請commit, push, publish」「做完才可以停止」
- 2026-11-18（使用者本人在對話中說的）：「請不要再提問」
- 2026-11-17（延續自 `docs/HANDOFF.cudaweb-optimize.md`，仍有效）：「我希望推論、訓練的cudaweb是經過高度優化的，必須可以適應各種等級的gpu」「像是早期的nvidia的gpu要優化過 要自己選擇把記憶體放到constant memory或texture」「gpu kernel還要用shared memory快取跟加速運算」「讓他持續優化下去」
- 2026-11-18（延續自 `docs/HANDOFF.manager.md`，仍有效）：「這台有kepler的cuda核心 要讓webgpu趨近官方的cublas一樣效能」「編譯慢沒關係，這通常是一次功，設備換了就再benchmark, 再編一次，可以存在indexdb」「把 Llama 系列的通用解碼骨架排進去，qwen_gpu優化則是一種override」「排成 O13，VLM 也要，我們應該也有用llava那個」「我要這個cudaweb獲得完整核心優化的結果，可以將來python/js 寫cuda的時候，都可以獲得好處。離線模型也是全都要在使用webgpu時獲得好處」「放在gpu相容層 (numba/cupy/torch) 比較合理」「他不應該暫停的，他應該全部做完!」「叫他別等!」「我受不了那邊無窮等待」「我在knowledge, aidoc使用存離線ai請他用cpu慢慢生字，都不會這樣叫他閉嘴的」「有載入，持續出詞元，就等，這邊做法要跟 streaming 一樣，如果詞元是退化文字才中斷」「這不是線上的，這是離線，使用者的電腦 gpu，當使用者決定用離線模型，就有要等很久的準備了」「aidoc ask 必須就是聊天核心，背後不管接 tool／recipe，他的目的就是以這包 code 為範圍」

## 6. 交接程序（自我遞迴）
執行 low-context-long-run 技能，**門檻 50%**：批次邊界讀 `get_usage`；到門檻先完成並提交手上的批次，更新本文件（保留第 5 節逐字原話並追加新指示），提交（訊息寫明是交接），`start_session`（`user_asked`、`fresh`、同目錄、標題 `cudaweb 領導 · handoff N`、提示用第 1 節原文並逐字引用使用者關鍵話），等接手者回報「已讀文件、從哪項開始」，再 `mark_completed` 與 `archive_session`（被拒就跳過並告訴使用者一行）。不刪除、不 `clear_session`。工作全完成（待辦清空且驗證）時不交接，直接回報使用者。

## 7. 陷阱
- `start_session` 可能被自動模式擋；使用者在對話裡明說「開 subsession」後才會過；被拒重試一次，仍拒就回報使用者一次。
- 子工作階段常在 context 才 15%–40% 就結束回報、會把推理強度掉回 medium、會擅自跑 `publish.sh` dry-run（簡報要明寫禁止）。兩個工作階段同改 `renderer/src/floating-assistant.js` 時只加自己的 hunk。
- `embed-code-ui.js` 重跑會順帶改寫無關的 `FA_STUDIO_SEED_COUNTS`／`FA_STUDIO_LORA_DATA` 行（來自其他 session 的資料），**不是你的改動，提交前還原**。
- 上一個領導工作階段結束時會連帶停掉它派的 fork 子代理，未提交的子代理工作會消失；子代理要頻繁 pathspec 提交。
- `ai-temp/` 在 `.git/info/exclude`（本機）；它是下載目錄，不進 git。
- 這台沒有 CUDA，也沒有 Kepler；文件裡的 Kepler 數字來自使用者另一台機器。
