# 程式設計 domain：patch 小工具、CI/CD（Gerrit／GitHub／Jenkins）與 pipeline（2026-10-14）

需求：`coding` domain 要能分析、讀檔、跑測試、修 bug，**隨時準備一個小程式／工具來上 patch**，並且懂 Gerrit／GitHub／Jenkins 這些 CI/CD，有 pipeline 的工具。
前提（弱模型）：事實由程式查、模型只做判斷與措辭；每個工具回傳整理好的結構，不是幾十 MB 的原始記錄。

## 1. 上 patch 的三條路（都在暫存工作區、都產生真的 diff、都 all-or-nothing）

| 工具 | 什麼時候用 | 做法 |
|---|---|---|
| `coding_edit` | 小修改（優先） | `{path, search, replace}`：程式定位（逐字 → 忽略行尾空白 → 忽略縮排並套用同樣縮排；必須唯一，多處要 `all`＋`expect`）、保留 CRLF、建立／刪除／在錨點前後插入、跨檔 regex（`expect_count`／`expect_files`）。找不到時回 `closest.actual`＝最接近的實際內容（含行號）。 |
| `coding_patch_tool` | 機械式大量修改（改名、批次替換、搬移、產生檔案） | 模型寫一支小腳本（node 最保險，用 Electron 內建 node 不用安裝；也支援 python／sh）→ 在工作區跑 → 取得 `git diff` → **dry_run 預設**：還原並把 patch 存起來 → 審查 → `apply` 套用「審查過的那份 patch」（不是重跑腳本）。腳本與 patch 存在 `<workspace>/.floating-assistant/patch-tools/`，`list`／只帶 name 即可重用，不會被 deploy 帶回使用者資料夾。腳本等於任意程式，走跟 `run_command` 同一個確認閘；工作區必須乾淨；失敗或逾時全部還原。 |
| `apply_git_patch` | 別人給的 patch、前兩者都不適合 | 既有：`git apply --check` 乾跑後套用。 |

邏輯在主行程：`coding-edit.js`（純函式）、`coding-tools.js`（IPC `fa:codingtools:edit／script`）。
`unifiedDiff` 以「300 組隨機（含空檔、結尾沒換行、新增、刪除）產生的 diff 用真的 `git apply` 套回去內容必須一模一樣」驗證，過程中抓到並修好兩個 `\ No newline at end of file` 的邊界。

## 2. CI/CD 連線

- 設定：Advance Settings →「CI/CD 連線」（只在工程模式顯示）：`[{name, kind: gerrit|github|jenkins, baseUrl, user, token}]`。token 只存在本機，由主行程的 HTTP 帶出去，**不會出現在任何工具的回傳**。公開服務（GitHub 公開 repo、gerrit-review.googlesource.com、公開 Jenkins）不用設定也能唯讀查詢。
- HTTP：`ci-fetch.js`（IPC `fa:ci:fetch`）用 Electron 的 `net.fetch`：沒有 CORS、吃系統代理與作業系統憑證庫（公司自簽 CA 可用）；回應有上限、console 記錄可「只留尾巴」；**寫入動作（POST／PUT／DELETE／PATCH）一律跳原生確認框**（內容中的機密會遮蔽）。測試用環境變數 `FA_DEBUG_CI_CONFIRM=allow|deny`（無頭環境按不了對話框；正式使用不會設）。
- 工具（`FaCi` 純函式整理，`bootstrap.js` 接線）：
  - `gerrit`：`change`（狀態、標籤、**blockers＝為什麼還不能 submit**、檔案、fetch／cherry-pick 指令、機器人留言裡的 CI 連結）、`query`、`comments`（未解決留言，串的最後一則才算）、`patch`、`files`、`push_help`（`refs/for`、WIP、topic、reviewer、rebase、Change-Id hook）、`review`（寫入）。
  - `github_ci`：`pr`（PR＋檔案＋全部 checks＋失敗的 job 與 step）、`checks`、`runs`、`jobs`、`log`（**直接做失敗分診**）、`diff`、`comments`、`rerun`／`comment`（寫入）。
  - `jenkins`：`build`（一次給結果、stage、測試統計、新增的失敗測試、失敗時自動分診）、`job`、`console`、`triage`、`tests`、`stages`、`trigger`（寫入；自動取 crumb）。
  - `ci_connections`（列出／測試，不顯示 token）、`ci_triage`、`pipeline_inspect`、`ci_guide`。

## 3. 失敗分診（`FaCi.triage`）

把長記錄變成：判定（success／failure／aborted）、**類別**（code／environment／config／infra）、失敗階段、**根因（檔案:行:欄:訊息＋上下文）**、失敗的測試、其餘發現、建議。
重點是「第一個真正的錯誤」：`make Error 1`、Maven `Failed to execute goal`、`script returned exit code` 都標成連鎖、不當根因；網路逾時／磁碟滿／OOM／節點離線標成 infra（建議重試而不是改程式）；認證失敗標 config（提醒別把 token 寫進程式）。
規則涵蓋 GCC／Clang、Rust、Go、Python（traceback 與 pytest）、Node（訊息在前、frame 在後，跳過 node 內部與 node_modules）、jest、tsc、eslint、Maven、Gradle、gtest、ctest、Jenkins、GitHub Actions。50 萬行記錄 < 8 秒。

## 4. Pipeline（`FaPipeline`）

`detect`／`parse`（Jenkinsfile 宣告式與腳本式：用「略過字串與註解的括號掃描」；GitHub Actions、GitLab CI 用 js-yaml，由呼叫端注入）→ `summarize`（有沒有 build／test／lint／deploy／報告）→ `lint`（寫死的機密、`curl | sh`、`|| true`、`sudo`、`pull_request_target` 加 checkout PR 程式碼、未釘版本的 action、script injection、沒有 timeout／permissions／concurrency／buildDiscarder／post／測試報告、`parallel` 沒設 failFast、`input` 沒 timeout、needs／stage 指到不存在的東西…，每項附修法）→ `localCommands`（把每個階段的 shell 步驟變成「本機可以一條一條跑」的指令；`uses: actions/setup-node` 轉成「需要 Node 20」；含 `${{ }}`／變數的標註要換成實際值）→ `scaffold`（偵測 npm／yarn／pnpm／pytest／go／cargo／maven／gradle／cmake／make，產生 Jenkinsfile／GitHub／GitLab 樣板；**自我檢查測試：產生的樣板解析得回來、lint 沒有 high／warn**）。

## 5. 提示詞

`_faBuildCodingSystemPrompt`：新增「先判斷任務類型」（A 新功能／B 修 bug／C Review・CI・pipeline）、**修 bug 流程**（取得失敗現場 → 重現 → 定位根因 → 先寫會失敗的回歸測試 → 最小修改 → 全測試）、「CI／Review／Pipeline」區塊（對外動作——push、留言、重跑、觸發——使用者沒明講不做）、步驟 0 加上 `repo_ask`／`explain_code` 的分析用法、步驟 5 的改檔改成 `coding_edit` → `coding_patch_tool` → `apply_git_patch`。桌面版 `coding` domain 補上之前缺的分析工具（`repo_ask`／`repo_sql`／`repo_read_doc`／`explain_code`／`language_explore`／`programming_knowledge`）與新工具。`ci_guide` 提供 workflow／gerrit／github／jenkins／patch／pipeline 六個主題的觀念與指令速查。

## 6. 驗證

- 純函式：`ci_core.test.js`（20）、`pipeline_core.test.js`（13）、`coding-edit.test.js`（12，含隨機 git apply）。
- 整合：`coding-tools.itest.js`（14：真的暫存工作區、git、腳本乾跑／套用／失敗還原／逾時還原／python／sh）、`ci-fetch.itest.js`（7：本機 HTTP）。
- 真實 Electron：公開 Gerrit（query／change／comments／patch，含 `)]}'` 與 `refs/changes` 指令）、公開 GitHub（runs／jobs／pr／diff，log 在未登入時給清楚的「需要登入」）；Jenkins 用本機假伺服器（Basic 認證、crumb、build／stages／tests／console、trigger 帶參數）端到端；錯誤帳號回清楚訊息。公開的 ci.jenkins.io 對匿名 API 一律回 `{}`，所以沒辦法拿它當測試對象（工具會明確說「回了空的物件」）。
- 模擬 AI 修 bug 全流程（真實專案）：開工作區 → 基準測試失敗 → `ci_triage` → `coding_edit`（dry-run、找不到時的 `closest`、套用）→ 測試通過 → `git_inspect diff` → commit → `coding_patch_tool`（dry-run 還原、apply、列表）→ deploy dry-run（patch-tools 不會被帶回）。**這次模擬抓到一個缺口**：Node 例外（訊息在前、frame 在後）原本分診不出位置，已補。

## 7. 沒做／沒驗證

- **沒有用真的、需要登入的 Gerrit／GitHub／Jenkins 測過**（沒有帳號）：認證標頭、`/a/` 前綴、crumb 是依文件與假伺服器寫的；公開服務與假伺服器之外的行為（SSO、反向代理改寫、自訂 CSRF）未驗證。
- 真實弱模型照這份提示詞走完整個修 bug 流程的遵從度（同 Phase 4 的既有限制）：只能靠使用者實測回報再調提示詞。
- 網頁版沒有這些工具（需要主行程的 HTTP，內部 Gerrit／Jenkins 沒有 CORS）；`coding_edit`／`coding_patch_tool` 也只有桌面版。
- GitLab／Zuul／Azure DevOps 的連線沒做（只有 GitLab CI 的 pipeline 檔案解析）。
- Gerrit 回覆個別留言（reply／resolve）、投票以外的 review 動作沒做；目前 `review` 只能整體留言與投 label。
- Jenkinsfile 的解析是括號掃描加規則，不是完整 Groovy：動態產生 stage（迴圈、函式回傳 map）解析不到；共享函式庫（`@Library`）裡的步驟看不到。
