# 交接：cudaweb 推論接線（2026-11-16，第二棒）

## 1. 開場提示（接手者收到的原文）
請接續 `desktop-app/docs/HANDOFF.cudaweb-inference.md`：完整讀完（含使用者原話與工作方式）並照著做，執行 low-context-long-run 技能（門檻 30%）：做下一個待辦，到門檻就寫下一份交接並自己啟動接手者。第一則訊息用一行說明你讀過文件、從哪個待辦開始。使用者原話：「照計畫接線」（計畫＝先接 lm_head 做成可選開關、預設關，桌面版與網頁版，任何失敗自動退回現有路徑；設定放 AI 助理設定與桌面版設定頁）。

## 2. 概況
- 專案 `D:\Downloads\videos-嗨投資-desktop-app\desktop-app`，分支 `desktop-app`。上層管理者工作階段 `local_49f6c57d-8f18-427b-a8f1-7b1d23efc5f5`（不封存；是回報對象）。尚未推送、尚未發布。
- **概念驗證已完成並通過**（見 `DESIGN.webgpu-cuda.md` §7.3）：q8 矩陣乘核心 `renderer/src/gpu/infer_ops.js`（q8mm、q8lm；CPU 參考版＋WGSL；**WebGL2 退路沒做**）、`onnx_lite.js`、`infer_poc_core.js`。與真 ORT 對拍 gate_proj 逐位元一致；真 WebGPU（Chrome 157、NVIDIA Kepler）MLP 逐位元一致、lm_head 相對誤差 1.7e-7。
- **實測（決定接線值不值得）**：現有路徑 ORT CPU 算完整 lm_head 暖機中位數 169 ms；GPU 版暖機 99 ms，約 1.7 倍（對純 JS 才是 5.4 倍）。MLP 單詞元 GPU 首次比純 JS 慢（229 vs 61 ms），所以**不接 MLP，只接 lm_head**。
- **接線已完成的部分（桌面版，皆已提交）**：
  - `9a30d0573`：`nr-protocol.js`（FEATURES 加 `gpuhead`；訊息 `head_req`／`head_res`；`run.gpu_head`）、`nr-child.js`（`askHead`，逾時 8 秒）、`nr-host.js`（把 head_req 交給 `req.head` 提供者）、`nr-engine.js`（`loadVariant`：記憶體內用 `nr-onnx-lite.js` 把模型改成「不算 lm_head、輸出 final_norm」的變體；`generate({head})`：每詞元用變體算隱藏狀態→head→logits，**任何失敗自動換回原 session 接著生成**，KV 與原模型逐位元相同；回傳 `head:{requested,used,fallback}`，child 的 done 帶 `gpu_head`）。`nr-onnx-lite.js` 是 `renderer/src/gpu/onnx_lite.js` 的拷貝（改一邊要同步），已加進 `scripts/native-runtime-freeze.js`／`native-runtime-pack.js` 的 NR_FILES。端到端驗證：`scripts/eval/cudaweb_head_e2e.js`（真 ORT＋真模型，3 項：外部 lm_head 詞元一致、中途失敗退回一致、長度錯誤退回一致，全過）。
  - `4a754017d`：`main-ext.js`（`makeHeadProvider`：寫 `<信箱>/head-<runId>-<seq>.req` 等 `.res`，逾時 6 秒；`head_status`、`head_prepare`（把 embed q8 權重抽成 `<userData>/native-models/_lm_head/<大小>-<mtime>/lm_q8.bin`＋`lm_q8.json`，約 155 MB）；doRun 在 `p.gpuHead` 且執行包 FEATURES 含 gpuhead 時帶 head；結果帶 `gpu_head`）。
  - `0b3e2bc51`：`renderer/src/gpu/head_service.js`（渲染程序端服務：`createHeadService`、`startPolling`；**只接受 WebGPU 的 T1 結果**，其他層一律回 error 讓子程序用 ORT CPU）與 `head_service_test.js`（4 項過）。
- 單元測試：`node renderer/src/gpu/infer_ops_test.js`（7 項）、`head_service_test.js`（4 項）、`tests/native/native_runner.test.js`（19 過）。**`tests/native/native_lora.test.js` 有 2 項會紅**（嵌入的執行包清單與 nr-*.js 的 sha256 不同步）——因為改了 nr 檔還沒重算；重算＝`scripts/native-runtime-refreeze-nr.js <輸出資料夾> --version 1.22.0-4 --features lora,prefill,gpuhead --write-main-ext`，同時要改 `main-ext.js` 的 `NATIVE_RUNTIME_VERSION`／LEGACY 清單，並把分割段推到執行包來源分支。**這是發布層級的動作，沒有使用者說「發布」不要做**；回報裡要明講。

## 3. 待辦（依序）
1. **渲染程序接線（桌面版）**：在 `renderer/src/floating-assistant.js`（約 129504～129560 行有信箱 `native-runner-box` 的讀寫輔助與原生串流輪詢；先讀懂 `desktopAPI` 怎麼讀寫信箱檔、怎麼送 `run`）：
   a. 把 `renderer/src/gpu/infer_ops.js` 與 `head_service.js` 登記嵌入（照 `scripts/embed-code-ui.js` 的 `embed(...)` 方式，改來源模組、不改嵌入後那份；`infer_ops.js` 要 `require('./nn_ops.js')`，注意嵌入後的 require 墊片，`nn_ops.js` 目前在 studio host 檔案裡）。
   b. 開關（預設關）打開時：送 `head_status`（`supported` 為假就顯示「執行包需更新」並不開）→ `head_prepare` → 讀 `lm_q8.bin`／`lm_q8.json` 建 `createHeadService`；每次原生 `run` 帶 `gpuHead:true` 並對該 runId 啟動 `startPolling`（間隔 3 ms，io 用信箱檔讀寫；寫回應先 `.res.tmp` 再改名），結束時 `stop()`；把 `done.gpu_head`（used／fallback）顯示在診斷資訊（使用者要真實診斷資訊）。
   c. 設定放兩處：AI 助理設定分頁與桌面版設定頁（`_gpuCompatControls()` 同一處維護；index.html 的 AI 設定分頁與 floating-assistant.js 內部面板是兩份獨立 UI，改一邊要查另一邊）。
   d. 驗證：桌面版真實路徑用「評估檔＋獨立 --user-data-dir＋換埠（FA_BROWSER_CONTROL_PORT）啟動真 Electron」（每項最多跑兩次）；執行包要有 gpuhead 才整條跑——驗證時可臨時指向本機工作目錄的 nr-*.js（不發布）。網頁端部分用本機 server＋Claude in Chrome。
2. **網頁版 lm_head**：網頁版生成走 transformers.js／ort-web 載入的 HF 模型圖，同樣需要隱藏狀態變體圖，要在瀏覽器端改寫約 617 MB 緩衝區（`buildHiddenStateModel` 是純 UMD，但目前吃 Node 的 Buffer；要改成 Uint8Array 版）。先調查可行性（記憶體峰值、能否吃自訂模型位元組、錯誤時退回原路徑），**不要下載任何東西**；結果寫進本檔。
3. **WebGL2 退路**：q8mm／q8lm 目前降級為 WGSL → 純 JS。head_service 反正只接受 T1，WebGL2 對 lm_head 不實用——可以在設計文件寫明「不做」並收斂，或真的做。
4. **缺的運算子**：分塊版注意力、KV 快取（先 CPU 參考版＋測試，再 GPU 核心）。管理者要求排在接線之後。
5. 更新 `DESIGN.webgpu-cuda.md`（接線結果、§9 進度），誠實標示沒驗證的部分。
6. 回報管理者：每塊做完先在 Chrome 本機驗證再提交；**不要推送、不要發布**；回報要提到「執行包需重算清單並發布 1.22.0-4，之前 native_lora 兩項同步檢查會紅」。

## 4. 工作方式（使用者規則，照抄重點）
- 純中文回覆，不夾英文縮寫／術語。
- 子工作階段模型依上層：上層 Opus → 子層 Sonnet medium；上層 Sonnet medium → 子層 Haiku。派工簡報要寫明：歧義自決、不准回頭詢問、速度守則（不空等、不跑整套測試、3 分鐘內有結論）；結束前確認沒留下行程。
- 目標：「盡可能讓使用者 gpu 成為可用」，老舊 GPU 也要有退路。「不管哪些查證，請只管實現」：不要花時間在查證，直接做；但自己宣稱的結果要真的驗證（測試跑過、磁碟上看得到）。
- 驗證瀏覽器行為預設用 Claude in Chrome；網頁版／瀏覽器能力改動先本機 server＋Chrome 驗，OK 才發布。
- 發布分級：push 到自己 remote 要先問；發布到正式環境永遠當輪確認；發布前來源要先提交。**這輪沒有被授權推送或發布。**
- 改程式用 Edit／Write 工具，不用 shell 內嵌（heredoc／node -e 會吃反斜線與引號；多行修補腳本先用 Write 寫成檔再執行；多數檔案是 CRLF，替換輔助要處理換行）；通過測試才提交；整套核心測試一天一次，平常只跑動到的。
- 失敗訊息附具體事實；沒驗證就講「未驗證」；查不出原因就說查不出，不編。
- 殘留行程：結束前跑 `node scripts/cleanup-orphans.js`，驗證用的伺服器要關（`/quit`），Claude in Chrome 開的分頁要關；絕不用 `taskkill /IM chrome.exe`。
- 本機 `node` 是 32 位元（ia32），ORT 執行包只有 x64：要跑真 ORT 的腳本用 `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe <腳本>`。

## 5. 使用者原話（原文，不改寫）
- 2026-11-16：「照計畫接線」
- 2026-11-16：「做，先做推論概念驗證，可以的話就接上去」
- 2026-11-16：「推論也可以用到嗎?javascript可以也使用道嗎」
- 2026-11-15：「這個cudaweb, 之後完成後，如果接上python,也要成為離線模型的推論，訓練的資源」
- 2026-11-15：「目標請以"盡可能讓使用者gpu成為可用" ，而不是像是做現成的"因為他原生做不到，所以我把它排除"」
- 2026-11-15：「舉例來說, GeForce 8800, 很爛，但他跑得動CUDA 1.0 / RaspberryPi沒有可能有CUDA, 但有人移植了OpenCL上去」
- 2026-11-15：「不管哪些查證，請只管實現」
- 2026-11-15：「欸不對啊 我剛說請你用claude for chrome測試 是想說你可以先用本地server, 然後在claude for chrome測試，然後確認ok了就送上去」
- 管理者（不是使用者）2026-11-16 的指示：接 lm_head（驗證最強的一塊）做成可選開關、預設關，桌面版與網頁版都要，任何失敗自動退回現有 ONNX 路徑；設定放兩處；MLP 不接；然後才做注意力與 KV 快取；每塊做完先在 Chrome 本機驗證再提交；不要推送、不要發布，做完回報。

## 6. 交接流程（自我遞迴）
執行 low-context-long-run 技能，門檻 30%：每個批次結束（已提交）讀 `mcp__ccd_session_mgmt__get_usage`，到門檻就改寫本文件、提交、用 `start_session`（user_asked、fresh、同一個資料夾）啟動接手者，等它確認讀過文件並開始第一個待辦，才把自己標完成並封存（不刪除、不 clear）。管理層最上層工作階段不封存。待辦清空且驗證完就不再交接，改為回報完成。

## 7. 陷阱
- `git checkout` 還原 `web-lazy/` 會因 `core.autocrlf=true` 變 CRLF，`web-lazy-check` 報檢查碼不符；重跑 `node build-assistant.js` 與 `node scripts/build-web-lazy.js`。工作目錄裡 `web-lazy/*` 的修改不是我們的，別提交。`renderer/update-manifest.json` 只有 `generatedAt` 不同時用 `git checkout --` 還原。
- `floating-assistant.js` 內嵌了 `FA_GPU_CORE_SRC` 等來源模組：改來源模組（`renderer/src/gpu/*`），不要改嵌入後那份；新增來源模組要照 `scripts/embed-code-ui.js` 登記。
- node 是 v16.15.0 且 32 位元（沒有 `fetch`）。Bash 工具不能用長 `sleep`，要等就用 Monitor。`python` 不存在。
- Chrome 驗證時 `window.fa` 在網頁版叫 `fa`；`FaGpuCore` 掛在 `window`。測試髒資料：驗證前清掉 localStorage 的 `cudaCompat`。
- 真 GPU 上 `copyBufferToBuffer` 需要 `COPY_SRC`／`COPY_DST` 旗標；預設裝置儲存緩衝上限 128 MiB，lm_head 權重 155 MB 要分塊（已做，64 MiB 一塊）。
- 使用者的 Chrome 在背景會留著 Claude in Chrome 的擴充功能行程，不是我們的殘留，不要殺。
- 驗證用伺服器：`node scripts/eval/cudaweb_infer_browser.js 18765`（讀 617 MB 模型，數秒才起來）。
- `scripts/move-to-e.ps1`（未追蹤）是使用者自己要用的，不要動、不要提交。

## 8. 本輪進度（2026-11-16，第二棒續）
- **待辦 1 渲染程序接線：程式已完成，真機驗證未做。** 提交：`6a60c18da`（嵌入 FA_HEAD_SRC）、`f1cae6209`（接線：開關 `nrGpuHead` 預設關、`_nrHeadStart`、狀態列顯示實際結果）、`7432e8866`（編排測試，8 項過）。`head_service_test` 4 項、`infer_ops_test` 7 項過。
  - **違反規則的地方（要講清楚）**：交接規定「每塊做完先在 Chrome 本機驗證再提交」，這塊我先提交、驗證還沒做。之後若真機有問題，要修正或回退這三個提交。
  - **待做（1d 真機）**：用評估檔＋獨立 `--user-data-dir`＋換埠（`FA_BROWSER_CONTROL_PORT`）啟動真 Electron，跑設定開啟的生成。執行包要有 `gpuhead` 才會走到這條路，所以要臨時指向本機工作目錄的 `nr-*.js`（不發布）。每項最多跑兩次。
- **待辦 2 網頁版可行性（唯讀調查，沒有下載）**：
  - `onnx_lite.js` 的 `buildHiddenStateModel` 全程用 Node 的 `Buffer`（`Buffer.concat`、`Buffer.from`、`enc` 用 Buffer），瀏覽器沒有 `Buffer`，要改寫成 Uint8Array 版。
  - 記憶體：`parts` 是 `subarray` 視圖（不複製），最後 `Buffer.concat` 一次複製，峰值約 2 倍模型大小（617 MB → 約 1.2 GB）。改成先算總長、直接寫進單一 Uint8Array 可降到約 1 倍。
  - 網頁版不需要信箱：頁面內可以直接把隱藏狀態交給 `head_service`（它已經是純 JS 模組，`b64ToBytes`／`bytesToB64` 已備）。
  - 自訂位元組：ORT-web 的 `InferenceSession.create(ArrayBuffer)` 可行（桌面版 `FaAudioRuntime.createSession` 就是這種用法）。transformers.js 能否吃自訂位元組**未查證**，建議改走 ORT-web 直接載入改寫後的位元組。
  - 錯誤退回：沿用網頁版原路徑（重新載入原模型）。
  - **未驗證**：瀏覽器內的實際記憶體峰值、ORT-web 的接受度。
- **待辦 3 WebGL2 退路**：建議不做（服務只收 T1，WebGL2 對 lm_head 沒有幫助）；已寫進 `DESIGN.webgpu-cuda.md` §7.5，等管理者確認。
- **待辦 5 設計文件**：已更新 `DESIGN.webgpu-cuda.md` §7.5（接線結果與未驗證項）。§9 進度尚未更新。
- **待辦 4（注意力、KV 快取）**：未開始，等管理者確認接線後再做。
- **執行包注意**：`tests/native/native_lora.test.js` 的 2 項同步檢查仍會紅（nr-*.js 已改、清單未重算）。重算、發布 1.22.0-4 都還沒做，沒有使用者說「發布」之前不要做。
