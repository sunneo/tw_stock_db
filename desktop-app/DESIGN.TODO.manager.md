# 管理層交接（manager · handoff 1）

## 1. 開場提示（接手的人收到的原文）

從這份文件接手（`desktop-app/DESIGN.TODO.manager.md`），完整讀完含「使用者原話」與「做事方式」並照做。你是 FloatingAssistant 專案的管理層工作階段：不親自做大功能，負責發布（`scripts/publish.sh`）、轉派子工作階段、核對子工作階段回報、回答使用者。執行 low-context-long-run：上下文到 30% 就更新這份文件、起下一個接手的工作階段（本階段不封存，見「做事方式」）。第一則訊息用一行說明你讀過文件、從哪一項待辦開始。

## 2. 概況

- 專案：`D:\Downloads\videos-嗨投資-desktop-app\desktop-app`，分支 `desktop-app`。已發布到 **v271**（遠端 `manifest.v2.json` 版本 271，網頁版釘 `ba2e2831…`，137 個檔案核對過）。
- 本階段做完的事（都已提交）：
  - 圖片轉 3D：細緻度參數 `--detail 1~3`（d3bfe7b6）、設定頁「圖片轉 3D」最大面數（預設 6 萬、上限 200 萬，a9525983）、依內容分配面數的自適應平滑外殼（c488a408）——這三項在 v271 發布。
  - **未發布**：骨架（1056b360）：離線模型加 MoveNet Thunder（`Xenova/movenet-singlepose-thunder`，Apache-2.0，完整版 fp32 25.1 MB；8 位元量化版在 CPU 載不進去），worker 的 `arch:'pose'`、`_poseEstimate`、`FaImage3d.splitLimbs`、`_i3dSplitArms`，手臂分成各自的部分、厚度照肢體寬度；模型已下載才自動用，使用者說「用骨架／手臂」才會問要不要下載。核心 65 項、主機端 14 項、vlm 135 項通過；完整測試 3 項失敗都是既有／環境問題（遠端協定 RFB、系統匣對話框單獨跑會過、coding 腳本整合因這台 bash 指到 WSL 結束碼 127）。
  - 在瀏覽器（transformers.js 3.7.5、CPU）實測過 MoveNet：載入約 5 秒、推論約 0.3 秒，結果跟命令列一致。**沒在真實 App 的 worker 裡跑過**（OffscreenCanvas 路徑未驗證）。
- 子工作階段（都閒置）：`music-composer`（`local_e00c8070-c5eb-475d-adfb-54f617d670e3`，音樂線，正在處理使用者新回報的兩個問題）、`harness-h1`（`local_65a41cf1-ba5b-468c-a35b-315fdf10317a`，弱模型 harness skill）。

## 3. 待辦（依序）

1. 等 `music-composer` 回報「已提交，可發布，commit <hash>」：只核對該 commit 存在、不重跑它已跑過的測試，然後問使用者要不要連同骨架（1056b360）一起發布；發布用 `PUBLISH_TRAILER="Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"` 加 Git 的 bash：`& "J:\Program Files\Git\bin\bash.exe" scripts/publish.sh -m "<說明>"`（PowerShell 的 `bash` 是 WSL，會失敗），發完用 `curl.exe` 手動核對遠端 `manifest.v2.json` 版本與每個 `web-lazy/manifest.json` 檔案在釘住的 SHA 上的 md5（腳本自帶的遠端檢查因 Node 16 沒有 `fetch` 會失敗）。
2. music-composer 的兩個問題：(a) midigenai 已下載卻說「還沒下載」；(b) 一個需求重複產生卡片（使用者匯出的對話 `C:\Users\sunneo\Downloads\ai-conversation-hi-transcript-1793635609957.md`）；(c) 理解需求逾時 25 秒兩次就退回範本是否放棄太快。
3. 骨架在真實 App 裡看一次（使用者下載 MoveNet，對照片說「用骨架」），回報手臂分得對不對；這是未驗證項，不要說已完成。
4. 未做的想法（使用者還沒要求就不要做）：被擋住一側的肩點誤判（照片 1 的肩點落在瓶蓋上，信心值 0.63）可用輪廓或深度再檢查；真正圓的肢體截面（目前背面是平的）。
5. 暫停的線：完整性驗證、延遲載入第二階段、sd_turbo 更名清理、RFB 測試不穩定、音樂階段 7（使用者說可以緩點）。
6. 更新記憶 `project_workstreams_status_2026_11.md`（已過時）——本交接時已更新，見下方。

## 4. 做事方式（使用者的規則，照抄）

- 全部用繁體中文回覆，不要在中文句子裡夾英文縮寫或術語；老實說哪些沒驗證。
- 管理層**不封存**：最上層不封存，用記憶＋壓縮＋交接追蹤。
- 發布由管理層做；子工作階段回報「已提交，可發布，commit <hash>」；子工作階段在上下文 30% 要自己更新交接文件並回報「需要接手，文件已更新，commit <hash>」，每個子工作階段的第一則訊息都要寫這條。
- 不要重跑子工作階段已跑過的測試（使用者抱怨重複跑）；只核對 commit 存在。
- 發布到正式環境每輪都要當輪確認；推到自己的遠端可自動。使用者說「發布」就發布。
- 使用者 build 前會 `git checkout ./`：沒提交的半成品會消失，做到一半也先提交。
- 改程式用 Edit／Write 工具，不用 shell 內嵌（反斜線與引號會被吃掉）；嵌入 `floating-assistant.js` 的區塊要改來源模組再跑 `node scripts/embed-code-ui.js`。
- 要下載檔案先問使用者（檔名、來源、大小）。
- 本機環境：Bash 工具目前不可用，用 PowerShell；Git 在 `J:\Program Files\Git\cmd\git.exe`；Node 16。
- 測試用的桌面版要設 `FA_BROWSER_CONTROL_PORT` 換埠，不要佔 17923。

## 5. 使用者原話（逐字）

- 2026-11-02「我們先認真處理音樂領域跟harness，其餘都先休息」
- 2026-11-02「階段7可以緩點」「這邊可以不用馬上作」
- 2026-11-02「入口測試在handoff6有跑過 這樣會重複跑」
- 2026-11-02「他必須是一個作曲家，像是在拆uml一樣，divide and conquer, 然後組裝起整體」
- 2026-11-02「可以用midigenai當首選，一樣在離線模型裡面管理，我們的管線跟處理方式可以當額外參考，用類似/image 的diffusion一樣，將使用者需求轉為midigenai的prompt」「而相關內容無法處理，才fallback為我們的拆分方式」
- 2026-11-02「他完全沒意識到他要產生handoff, I hate that.」
- 2026-11-03「面數上限請跟我的設定  使用者想要多細就讓他多細  configure裡面可以指定最大面數。我有把外面3d dragon的xyzdragon拿來顯示，有超過20萬面以上」
- 2026-11-03「像這樣一半的人  應該也可以看出骨架吧  類似kinect的作法」
- 2026-11-03「可以用類似yolov8n-pose, movenet」「movenet, ok」「接進專案」
- 2026-11-03「一個需求，卻重複地產生卡片」
- 2026-11-03「但我已經下載了，他還是說我沒下載」（midigenai 進度紀錄：「【模型】這次沒有用模型:模型還沒下載(Configure → 離線模型管理 → 音樂 → midigenai v5)」）

## 6. 交接程序（自我遞迴）

執行 low-context-long-run 技能，THRESHOLD 30%。管理層階段本身不封存（使用者規則）；接手者確認後，舊階段留著，向使用者說一行即可。

## 7. 陷阱

- PowerShell 的 `bash` 是 WSL；發布一定用 Git 的 bash。
- `Select-String` 篩選發布輸出曾經看起來沒輸出，其實已完成；用遠端 `manifest.v2.json` 核對。
- 8 位元量化的 ONNX 在 CPU（WebAssembly）會缺 `ConvInteger`（深度模型與 MoveNet 都是）：要用完整版。
- 子工作階段不會自己交接：每個簡報都要寫明。
- 使用者匯出的對話檔很大（約 13 萬字元），不要整份讀，用 Grep 看結構。
- 使用者曾拒絕我對那份對話檔跑 Grep（當下改用技能把工作轉出去）：先問或直接交給音樂線，不要重試同一個動作。
