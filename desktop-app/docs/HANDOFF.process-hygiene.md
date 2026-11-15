# 交接：發布與測試留下的殘留行程（2026-11-16）

## 1. 開場提示（接手者收到的原文）
請接續 `desktop-app/docs/HANDOFF.process-hygiene.md`：完整讀完（含使用者原話與工作方式）並照著做，執行 low-context-long-run 技能（門檻 30%）：做下一個待辦，到門檻就寫下一份交接並自己啟動接手者。第一則訊息用一行說明你讀過文件、從哪個待辦開始。使用者原話：「我留意到我電腦經過publish，測試，會留下超多google chrome, python, powershell, conhost, dllhost的process，記憶體用量會被疊到很高直到claude被系統自動kill，這時即使畫面沒開google-chrome，仍有chrome在跑。我剛已經手動kill掉，讓記憶體水平從63%->28%」

## 2. 概況
- 機器：Windows 10，專案 `D:\Downloads\videos-嗨投資-desktop-app\desktop-app`，分支 `desktop-app`。上層（管理者）工作階段 `local_49f6c57d-8f18-427b-a8f1-7b1d23efc5f5`。
- 剛發完 v417（網頁版冷載入優化）：desktop-app `49887ae6b`、patch 分支 44fc3897e、網頁版 repo 釘到 `49887ae6`（網頁版 main `c86db9757`）。線上用 Claude in Chrome 驗過（核心與分塊走 jsDelivr）；遠端 229 個檔案檢查碼一致。
- 已提交、尚未推送：`2cf8563c3`（`scripts/publish.sh` 預熱不再用 process substitution＋不是 bash 時改用 bash 重跑；`scripts/web-lazy-check.js --remote` 沒有 fetch 時改用 https）。**推送要先問使用者**（push 到自己 remote 可設定成自動，但這輪還沒給）。
- 使用者提出的新問題：publish、測試之後殘留大量 chrome／python／powershell／conhost／dllhost 行程，記憶體疊到 63% 讓 claude 被系統殺掉；沒開 Chrome 畫面也還有 chrome 在跑。使用者已手動清掉（63%→28%）。**原因尚未查，也尚未修。**
- 我（上一位）量到的現況：tasklist 有 chrome.exe 14 個、conhost 7、python 4、claude.exe 15（含使用者自己的，不要動）。

## 3. 待辦（依序）
1. **盤點誰會生出殘留行程**（唯讀）：用 `Get-CimInstance Win32_Process` 抓 chrome／python／powershell／conhost／dllhost 的父行程鏈與命令列，對照這幾處：`scripts/web-cold-load-probe.js`（無頭 Chrome 量測，疑似主因）、`scripts/web-local-serve.js`、`scripts/eval/cudaweb_browser.js`、`judge-runner.js` 與各領域測試的 python 子行程（`renderer/src/uml/domain_harness.js` 用 `cp.spawnSync`）、`scripts/publish.sh` 的 node／curl、真桌面版評估（`--user-data-dir` 啟動的 Electron）。結論要附指令與輸出。
2. **修：自己啟動的就自己收乾淨**。每個會啟動無頭 Chrome／伺服器／Electron 的腳本，用 `try/finally` 加逾時，結束或逾時就殺整棵行程樹（Windows 用 `taskkill /T /F /PID`），並在 `process.on('exit'/'SIGINT')` 也做。**只殺自己記下 PID 的行程，不要用 `taskkill /IM chrome.exe` 這種一刀切**（會殺掉使用者的 Chrome 與 Claude in Chrome）。無頭 Chrome 要用獨立 `--user-data-dir`，結束後刪掉。
3. 加一個 `scripts/cleanup-orphans.js`：只列出（預設）／清除「命令列含本專案獨立 user-data-dir 或測試埠」的殘留，並讓 `publish.sh` 結尾與整套測試結尾呼叫它。附單元測試或可重現的檢查（先製造一個殘留、再確認被清掉、使用者的 Chrome 不受影響）。
4. 給派出去的子工作階段的簡報加一條：結束前自己確認沒留下行程（寫進派工簡報範本與 `DESIGN.release.md`）。
5. 使用者同意後才推送 `2cf8563c3` 與本次修補；發布走 `scripts/publish.sh`（用 bash 執行）。

## 4. 工作方式（使用者規則，照抄重點）
- 純中文回覆，不夾英文縮寫／術語。
- 子工作階段模型依上層：上層 Opus → 子層 Sonnet medium；上層 Sonnet medium → 子層 Haiku。派工簡報要寫明：歧義自決、不准回頭詢問、要速度守則（不空等、不跑整套測試、3 分鐘內有結論）。Haiku 愛用最慢方式，要盯。
- 驗證瀏覽器行為預設用 Claude in Chrome（不是內建瀏覽器）；網頁版改動先起本機 server 用 Chrome 驗，OK 才發布。
- 發布分級：push 到自己 remote 可設成自動；deploy 到正式環境永遠當輪確認。發布前來源要先提交（publish.sh 會拒絕未提交的來源）。
- 測試用桌面版要設 `FA_BROWSER_CONTROL_PORT` 換埠（別佔 17923）；真桌面版評估每項最多跑兩次。
- 改程式用 Edit／Write 工具，不要用 shell 內嵌（反斜線與引號會被吃）；修補腳本先寫成檔再執行；通過測試才提交。
- 整套核心測試一天一次，平常只跑動到的。
- 失敗訊息要附具體事實；沒驗證的事要講明「未驗證」，不要宣稱完成。
- 使用者問「為什麼」時，查不出就說查不出，不要編原因。

## 5. 使用者原話（原文，不改寫）
- 2026-11-16：「我留意到我電腦經過publish，測試，會留下超多google chrome, python, powershell, conhost, dllhost的process，記憶體用量會被疊到很高直到claude被系統自動kill，這時即使畫面沒開google-chrome，仍有chrome在跑。」「我剛已經手動kill掉，讓記憶體水平從63%->28%」
- 2026-11-16：「我喜歡bash，那怎麼會有一次用sh(dash) ?」
- 2026-11-15：「用 Chrome 測網頁版 / 也幫我看一下怎麼讓no cache的情況下，最快顯示出來」
- 2026-11-15：「欸不對啊 我剛說請你用claude for chrome測試 是想說你可以先用本地server, 然後在claude for chrome測試，然後確認ok了就送上去」

## 6. 交接流程（自我遞迴）
執行 low-context-long-run 技能，門檻 30%：每個批次結束（已提交）讀 `mcp__ccd_session_mgmt__get_usage`，到門檻就改寫本文件、提交、用 `start_session`（user_asked、fresh）啟動接手者，等它確認讀過文件並開始第一個待辦，才把自己標完成並封存（不刪除、不 clear）。

## 7. 陷阱
- `git checkout` 還原 `web-lazy/` 會因 `core.autocrlf=true` 變成 CRLF，`web-lazy-check` 會報「檢查碼不符」；修法是重跑 `node build-assistant.js` 與 `node scripts/build-web-lazy.js`（約 2～3 分鐘，建置期間 `web-lazy/` 暫時是空的，別在這時提交或檢查）。
- `renderer/update-manifest.json` 每次建置都會改 `generatedAt`，只有時間戳不同時用 `git checkout --` 還原，不要提交。
- 這台 node 是 v16.15.0，沒有 `fetch`。
- `publish.sh` 要用 bash 執行；Bash 工具指令內有 `sleep` 長等待會被擋，改用 Monitor。
- 不要用 `taskkill /IM chrome.exe`：會殺掉使用者的 Chrome 與擴充功能連線。
