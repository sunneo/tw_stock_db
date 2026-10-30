# 交接文件：把 sd-turbo 整合進 `/edit-picture`（圖生圖改圖，handoff 1，2026-10-30）


## 0. 進度（handoff 2，2026-10-30）
- 第 1 項完成（提交 a876923c）：查證寫在 DESIGN.edit-picture-sdturbo.md。結論：ONNX 用 jdp8/sd-turbo-onnx（含 vae_encoder，fp16 大小，unet 1.7 GB）；授權是 Stability AI 社群授權（商業須登記），所以不內建、使用者自己下載；wasm 沒有能跑的 sd-turbo 版本，降級用 SDXS（同一套數學）。onnxruntime-web WebGPU 的運算子支援未驗證。
- 第 2 項完成（提交 4d220fec）：renderer/src/imagegen/sd_turbo_core.js（全域 FaSdTurbo）＋ scripts/imagegen-tests/sd_turbo.test.js（20 項通過，已加進 run-core-tests）。尚未加進 scripts/embed-code-ui.js 的嵌入清單與 floating-assistant.js 的 SDTURBO-BEGIN/END 標記（第 3 項一起做，仿 LOCALSD-BEGIN）。
- 下一步：第 3 項（主機端下載／載入／執行，含 SDXS 降級需要的 VAE 編碼器來源）。本週額度在這個階段用到 98%，所以沒有啟動接手工作階段；額度重置（2026-10-31 06:59 UTC）後由使用者重新叫起。

## 0b. 進度（2026-10-30 晚）
- 第 3、4、6、7 項完成並發布（patch v225）：主機端 _localEditImage（floating-assistant.js）、/edit-picture 用文字改圖（edit_host.js 的 _edTextEdit）、細化層本機路徑改成圖生圖、功能清冊。小型編碼器用 julienkay/taesd；madebyollin/taesd 只有 safetensors，沒有 ONNX，無法當執行時的退路。
- 還沒做：第 5 項（edit_cases 成功案例）、設定頁列出 sd-turbo 下載狀態、遮罩選取區域改圖（目前整張）。整條路在真實 App 沒跑過（不知道 SDXS 在中途時間點畫質、sd-turbo 文字編碼器輸出層、WebGPU）。

## 0c. 決定（2026-10-30）：不用 sd-turbo
- 使用者決定不要 sd-turbo（授權要商業登記）。程式已移除 sd-turbo 路徑，只留 SDXS＋TAESD（OpenRAIL++-M＋MIT）。第 5 項（成功案例）沿用編輯器既有的通用機制，不另做；設定頁已加 TAESD 狀態。剩下：遮罩選區改圖、真實 App 驗證畫質。

## 0d. 遮罩與選區重畫（2026-10-30 完成）
- 細化層加「重畫」旗標（用途下拉）；手動遮罩＝細化畫筆圈的框或塗抹；口語遮罩＝「把 X 改成 Y」拆句，位置字眼直接算比例框，其他名詞請視覺模型在 4×4 字母格上選格子（程式核對字母）。純函式在 sd_turbo_core.js（25 項測試）。真實 App 沒驗證。

## 1. 開場提示（給接手的工作階段）
Continue from the handoff document at `D:\Downloads\videos-嗨投資-desktop-app\desktop-app\DESIGN.TODO.edit-picture-sdturbo.md`. 先完整讀完（含使用者原話與做法備忘），照做。執行 low-context-long-run 技能（門檻 30%）：做 Todo 的第一項，context 到門檻就更新這份文件並啟動你的接手工作階段（`mcp__ccd_session__start_session` 是延遲載入的工具，先用 ToolSearch 載入）。第一則訊息用一行說明你讀完了、要開始哪一項。回覆一律繁體中文、不要夾英文縮寫。**不要再做規劃、不要問，直接查證、寫程式、測試、提交。**

使用者的關鍵指示（逐字）：「幫我整合sd-turbo(wasm, webgpu, cpu)在edit-picture裡面，進行圖像編輯，或處理使用者給一張圖後要求改圖的需求」。

## 2. 概況
- 目標：把 sd-turbo 做成 `/edit-picture` 的「圖生圖」改圖引擎：使用者給一張圖＋一句話（「把天空改成黃昏」「變成水彩風」「加一頂帽子」），離線在本機跑，三種執行環境都要支援：WebGPU、WASM（CPU）、以及純 CPU 降級（對應現有 onnxruntime-web 的 `webgpu`／`wasm` 兩種後端；「cpu」＝wasm）。
- 分支 `desktop-app`，工作目錄 `D:\Downloads\videos-嗨投資-desktop-app\desktop-app`。image-to-3d 已完成並發布到 v224，與這個無關。
- 現況（先讀這些）：
  - `renderer/src/imagegen/local_sd.js`（`FaLocalSd`）：本機小模型**文字生圖**（SDXS-512-DreamShaper，一步取樣，GPU fp16 約 880MB／CPU int8 約 1.1GB，onnxruntime-web），下載／載入／執行在 `floating-assistant.js`（搜 `FaLocalSd`、`_localSd`）。**沒有 VAE 編碼器的使用、沒有圖生圖。**
  - `DESIGN.edit-picture-diffusion.md`：`/edit-picture` 已有「擴散細化層（`detail`）」——只重畫一小塊細節再羽化蓋回去。接手前先讀，沿用它的蓋回／羽化／記錄機制。
  - `renderer/src/edit/edit_picture_core.js`、`edit_picture_ui.js`、`edit_pictures.js`、`pic_detail.js`、`pic_fx.js`：編輯器本體；`edit_host.js` 主機轉接層。
- 沒有任何 sd-turbo 的程式碼。沒部署。

## 3. Todo（依序，每項做完測試、提交）
1. **查證（半小時內，不寫長報告）**：sd-turbo 的 ONNX 在哪（Hugging Face 上的 ONNX 匯出，例如 microsoft／onnx-community 的 sd-turbo；或自己從 `stabilityai/sd-turbo` 匯出）、各部分檔案大小（text encoder／unet／vae encoder／vae decoder，fp16／int8 版本）、**授權**（stabilityai/sd-turbo 的授權條款是否允許商業與散布——這是公開產品；查不到或不允許就改成「使用者自己下載」，像 UniK3D 那樣不內建不替下載，並在設定頁顯示授權）、onnxruntime-web 的 WebGPU 與 WASM 是否都能跑（運算子支援、記憶體）。把查到的（含「未驗證」）寫進 `DESIGN.edit-picture-sdturbo.md`（新檔，短）。查完直接進第 2 項，不等回覆。
2. **純函式核心** `renderer/src/imagegen/sd_turbo_core.js`（UMD，全域 `FaSdTurbo`，仿 `local_sd.js`；測試 `scripts/imagegen-tests/sd_turbo.test.js`）：模型清單與釘住的檔案大小、選版本（WebGPU fp16／wasm int8，沿用 `FaLocalSd` 的選版本邏輯）、**圖生圖取樣的數學**（圖→VAE 編碼→latent×縮放→依 strength 加噪到起始 timestep→1～4 步 Euler／LCM 取樣→VAE 解碼）、遮罩混合（只改遮罩內，羽化蓋回）、尺寸對齊（512 或 8 的倍數）、錯誤白話說明。strength、steps、seed 要可調。
3. **主機端**（`floating-assistant.js`，參考 `FaLocalSd` 的下載／載入／工作執行緒做法）：下載含進度卡片（只出一張進度卡，記錄分「章節／主角／行為」，沿用 image-to-3d 的進度卡做法 `圖片轉3D` 單一進度卡）、載入、執行；三種後端（`webgpu`／`wasm`／降級）依機器自動選，失敗降級並寫明原因（附具體事實：HTTP 狀態、耗時、後端）。
4. **接進 `/edit-picture`**：新動作「用文字改圖」（圖＋指令，可選遮罩／選取區域，沒遮罩就整張）；使用者貼圖＋說「把…改成…」時，程式先解析（改哪裡、改成什麼、強度——「微調／大改」對應 strength），解析不出再用封閉式選擇題問模型，答案由程式核對；結果進圖層、可復原、記錄成有效的一步（沿用編輯器的 `effectiveSteps`）。設定頁（媒體→離線模型）列出 sd-turbo 與下載狀態。
5. **接進離線訓練器的成功案例**（`edit_cases.js`，種類 `edit-picture`）：好的改圖（指令＋參數）可存成案例。
6. 補功能清冊（`node scripts/ai-features.js check` 通過再 `build`）、`node scripts/embed-code-ui.js && node build-assistant.js`、核心測試（`node scripts/run-core-tests.js`）。
7. **完成後直接發布**（使用者慣例：完成就更新網頁、發布 patch）：`PUBLISH_TRAILER="Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" bash scripts/publish.sh -m "…"`，再 curl 查遠端 `manifest.v2.json` 版本。真實 App 沒驗證的部分在回報裡誠實列出。

## 4. 做法備忘（使用者的規則）
- 繁體中文、結論先說、不要在中文裡夾英文縮寫；做完誠實說哪些沒驗證。
- 改來源模組（`renderer/src/...`），再 `node scripts/embed-code-ui.js`；不要改嵌入後那份。新模組要加進 `scripts/embed-code-ui.js` 的嵌入清單。
- 改檔用 Edit／Write 工具；**Bash heredoc 內的 Python 會吃掉反斜線與中文**，需要時用 Write 工具寫 `.py` 檔再執行。`floating-assistant.js` 行尾 CRLF／LF 混合，改前用 `s.count()` 試兩種。
- 編譯前會清工作目錄：做到一半也先 commit。給了順序就做到底，不要中途問「接著做哪個」。
- 熱更新名單別擴大；不要要求使用者重裝。
- 暫時性失敗要自己重試；失敗訊息附具體事實；不要靠換模型復原。
- 工具說明文字用中文引號，不要反引號 code span。
- 下載模型要有進度、可中斷續傳；大檔照現有 `FaLocalSd` 的分檔／核對大小做法。
- 工作樹有不是你改的檔案（`skills/image-decompose-redraw/data/parts_builtin.json`、`test-reports/*`）：不要放進你的提交，也不要還原。

## 5. 使用者原話（逐字，2026-10-30）
- 「幫我整合sd-turbo(wasm, webgpu, cpu)在edit-picture裡面，進行圖像編輯，或處理使用者給一張圖後要求改圖的需求」
- 標準發布指令（使用者歷來說過）：「更新網頁，發布patch」「完成就可以更新網頁，發布patch」
- 一貫的態度：「JUST DO IT!」「不要再繼續plan了」——不要規劃、不要問，直接做。

## 6. 交接流程（自我遞迴）
執行 low-context-long-run 技能（門檻 30%）：每個批次邊界用 `mcp__ccd_session_mgmt__get_usage` 看 context，≥30% 就更新本文件、提交、用 `start_session`（initiation `user_asked`、context `fresh`、同一個工作目錄、`use_worktree:false`）啟動接手，確認後 `mark_completed`＋`archive_session`（被拒就跳過並告知，不要重試迴圈）。

## 7. 陷阱
- sd-turbo 的授權我沒查證：先查，查不到就當作不能內建散布。
- 現有 `FaLocalSd` 是文字生圖，沒有圖生圖；圖生圖需要 VAE **編碼器**，ONNX 檔不一定有，查證時要確認。
- sd-turbo 原生解析度是 512×512，且用 1～4 步、guidance 為 0；strength 太高會整張重畫（使用者要的是「改圖」，要保留沒被提到的部分，遮罩混合是關鍵）。
- WebGPU 的 fp16 要顯示卡支援 `shader-f16`，否則降級；wasm 版記憶體大，注意分頁記憶體上限。
- `scripts/embed-code-ui.js` 會把 `floating-assistant.js` 整份重寫（行尾可能被統一）；提交時看 `git diff --stat` 是否變成整檔，整檔差異要確認只是行尾。
