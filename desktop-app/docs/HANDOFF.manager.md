# 管理者交接（2026-11-18，第二棒起點頁）

> **最新狀態（使用者指示「寫好交接、停手，讓其他遠端接手」）**：已發布 v447（遠端三處核對過）；v448 發布中（核對遠端 manifest.v2、`git ls-remote origin refs/heads/desktop-app`、網頁 `var SHA`）。兩個工作階段的交接文件：`docs/HANDOFF.offline-nolimit.md`（離線不設耗時上限、/aidoc ask 要走聊天核心）、`docs/HANDOFF.cudaweb-optimize.md`（O12 到 O15；O14b、O14c、O14d、O13c、O15b、真權重下載與驗證未做，下載須使用者本人在接手的工作階段同意：SmolVLM-256M 的 `onnx/decoder_model_merged_q4.onnx` 86.6 MB、Florence-2-base-ft 的 `onnx/decoder_model_int8.onnx` 97.8 MB，視覺編碼器與 LLaVA 尚未查）。使用者規則：發布每階段都做（commit、push、publish），發布由管理者跑。下面的內容較舊，只當背景。

專案 `D:\Downloads\videos-嗨投資-desktop-app\desktop-app`，分支 `desktop-app`；網頁版倉庫 `D:\Downloads\videos-嗨投資`。這份比 `docs/HANDOFF.md` 更新，舊的只當背景。

## 1. 開場提示（接手者收到的原文）
接續管理者工作。完整讀 `desktop-app/docs/HANDOFF.manager.md`（含使用者原話與工作方式）並照著做，執行 low-context-long-run 技能（門檻 30%）：做下一個待辦；到門檻就更新本文件、啟動接手者。**不要封存管理者工作階段**（使用者規則：最上層不封存）。第一則訊息用一行確認讀過文件、要從哪個待辦開始。使用者的話：「讓他持續做下去」「推送並發布」「我受不了那邊無窮等待」。

## 2. 概況
- 我是管理者（前一棒 `local_49f6c57d-8f18-427b-a8f1-7b1d23efc5f5`，Sonnet 5.5，不封存）。底下的子工作階段用 Haiku、推理強度 high（用 get_session 核對，錯了用 set_session_effort 改）。
- **已發布 v446**（桌面版 patch、`desktop-app` 分支 `ede232557`、網頁版釘 `ede23255`，遠端都核對過）。v446 之後本機還有未推送、未發布的提交：屋頂量測安全校準 `a56dac179`、O12a 到 O12c（`6c6421c86`、`87caad159`、`869043756`）、sgemm 轉置與批次（`42304af2d`、`9279e80d0`）、eval `d460b2d8e`，以及新聞摘要與 GPU 設定相關後續。
- **等使用者說「發布」才能發 v447**：我曾預告要發被安全檢查擋下，發布與推送永遠要當輪確認。v447 想帶的重點：屋頂量測安全校準（v446 帶的舊版可能產生過長派發）。我建議先等 GPU 量測互斥鎖做完（見待辦 1）再發，把決定交給使用者。
- 進行中的工作階段（用 list_sessions 核對狀態）：
  - `cudaweb-5` = `local_2570098f-e044-491e-8061-350d1f5d9f4c`（Haiku）：清單 `docs/CHECKLIST.cudaweb-optimize.md`（O12 到 O15 與優化迴圈）、目標 `docs/TARGET.cudaweb-cublas.md`、交接 `docs/HANDOFF.cudaweb-optimize.md`。context 約 38%，60% 才交棒（它常提前停，要催）。
  - `session-2` = `local_cff154d3-fe77-4556-b9d8-c48dd54cea00`（Haiku）：新聞摘要（目標詞、退路都已提交）；剛收到新任務：離線模型生成不要固定逾時（比照藏書閣與 AIDoc：只做卡死偵測，有進度就一直等）、跑過摘要後 GPU 基準失敗要先釋放閒置 GPU 引擎。
- 設計決定（使用者拍板）：GPU 設定只放在 Advance 設定 →「GPU 相容層（numba／cupy／torch）」窗格，其他地方都不放（桌面版設定頁、Configure 都沒有）；變體競賽編譯慢沒關係、勝者存 IndexedDB；Llama 通用骨架＋qwen 優化做成 override（O12）；VLM（LLaVA、SmolVLM、Florence-2）要吃 cudaweb（O13）；使用者寫的 CUDA 與全部離線模型都要受益（O14、O15）。

## 3. 待辦（依序）
1. **盯 `cudaweb-5`**：GPU 量測互斥鎖與 `requestExclusiveGpu(reason)`（已轉達：屋頂、競賽、基準一次一個、含閒置持有者 release 回呼；submit 前先估時間 >100 ms 就拆）。做完請它再跑唯一一次真 Electron eval。之後 O12b GPU 版、O12d、O13、O15、O14 剩餘（gemv 小 M、批次路徑區分 lastPath）。
2. **盯 `session-2`**：不固定逾時與基準前釋放 GPU 引擎的接線；提交後核對 node 測試與真桌面版行為。
3. **使用者說「發布」時**：先確認來源乾淨再跑 `scripts/publish.sh -m "…"`（背景執行，不要在前景等；它會自動鎖定要推的 SHA）。若來源有別的工作階段未提交的改動：先跑動到的測試，通過就提交成一個快照再發，不要空等。發完用遠端 manifest.v2、`git ls-remote origin refs/heads/desktop-app`、網頁 `var SHA` 三處核對。
4. 用量：5 小時額度已 72%（約 22:20 UTC 重置）、每週 66%；到 90% 先告訴使用者。
5. 做完收尾：殘留程序檢查（Win32_Process：http.server、publish.sh、Electron、背景 grep）。

## 4. 工作方式（使用者規則，抄重點）
- 純中文、不夾英文縮寫；失敗訊息要有具體事實（狀態、耗時）。
- **不准空等**：使用者多次發火。不 sleep 輪詢、不等背景通知；背景任務放著，繼續下一步。
- **發布、推送、部署要當輪確認**；commit 不用確認（每個通過測試的小步就提交）。
- 子工作階段不准來回詢問，歧義自決；派工簡報要寫清楚順序、驗收、速度守則；督導要核對提交與測試，指出對錯。
- 真 GPU 安全量測：一頁一形狀、先估時間、單次派發小、監聽 device.lost、絕不跑會逾時的測試（會讓 Chrome 的 WebGPU 消失）；測試用 server 與視窗用完必須停掉並用 Win32_Process 確認；不要大範圍遞迴 grep。
- 使用者指出畫面位置不合理時，別拿「共用同一個函式」當設計理由辯護。
- 改程式用 Edit，或先用 Write 寫成檔再執行；heredoc 內嵌中文與反斜線會出事。
- 不確定的事實要說「我沒查」，不要編。

## 5. 使用者原話（逐字，2026-11-18）
- 「這台有kepler的cuda核心 要讓webgpu趨近官方的cublas一樣效能」
- 「我想到早期cuda library的一些sample，會用template programming來訂好多層的shared memory，會逐層切割kernel function, device function, 好幾個device function會特化成好幾個2的覓次方梯度優化過的小方塊切割，在編譯時期產生出來 我們有辦法優化出runtime準備多個覓次方梯度優化? 然後預先準備好pre-profile，幫不同能力的顯卡預選，即使不是nvidia架構 然後在gpu那頁benchmark挑出這種良好的成果」
- 「編譯慢沒關係，這通常是一次功，設備換了就再benchmark, 再編一次，可以存在indexdb」
- 「把 Llama 系列的通用解碼骨架排進去，qwen_gpu優化則是一種override」
- 「排成 O13，VLM 也要，我們應該也有用llava那個」
- 「我要這個cudaweb獲得完整核心優化的結果，可以將來python/js 寫cuda的時候，都可以獲得好處。離線模型也是全都要在使用webgpu時獲得好處」
- 「放在gpu相容層 (numba/cupy/torch) 比較合理」「其他地方不合理」「放這邊就是多餘」
- 「他不應該暫停的，他應該全部做完!」「叫他別等!」「我受不了那邊無窮等待」「publish. publish. publish it! 為什麼今晚publish一直卡住 !」
- 「我發現跑過一次，再去跑測試，會得到這種失敗，然後這邊30秒就逾時?線上AI都沒這麼苛刻吧!」
- 「我在knowledge, aidoc使用存離線ai請他用cpu慢慢生字，都不會這樣叫他閉嘴的」
- 「那台有intel gpu, intel xe-lpg 而且 wasm也不該遇到bad alloc」

## 6. 交接程序（自我遞迴）
執行 low-context-long-run 技能，門檻 30%：批次邊界用 get_usage 讀自己的 context；到門檻或額度近 90% 就更新本文件、提交、start_session（initiation user_asked、context fresh、同目錄）、確認接手者讀過文件並開始第一個待辦。**例外：不封存、不 mark_completed 管理者工作階段。**

## 7. 陷阱
- `start_session` 常被自動模式擋（沒給理由）；使用者在對話裡明說「開新工作階段」後再試就會過。不要繞過。
- publish.sh 在來源有未提交改動時會拒絕；建置要約 1 分鐘，期間別人改檔會讓 web-lazy 檢查碼不符而中止（什麼都沒發出去）；失敗的嘗試會先佔版號（PATCH_VERSION 可能比遠端大，版號跳號無妨）。
- 子工作階段常在 context 才 15%～40% 就結束 turn 回報、或停下來等背景建置；要用 SendMessage 催，並提醒用 get_usage 判斷。它們也會把推理強度掉回 medium。
- 子工作階段曾擅自跑 publish.sh 的 dry-run（會重建檔案，干擾真實發布）；簡報要明寫禁止。
- 兩個子工作階段同改 `renderer/src/floating-assistant.js`：只准各自 `git add` 自己的 hunk；`git add -A` 會掃進對方半成品。
- 屋頂量測舊版會產生單次 786 ms 派發；競賽自己的屋頂呼叫曾有 3 個派發的 submit 花 1549 ms（接近系統逾時）。
- 新聞摘要「bad_alloc」真因是提示超過 GPU 引擎 KV 上限（512 或 1024 詞元），不是記憶體不足；使用者機器是 Intel Xe-LPG。
- 我曾說「基準與變體競賽在 Configure」是錯的，它們一直在 GPU 相容層窗格；以畫面截圖為準。
