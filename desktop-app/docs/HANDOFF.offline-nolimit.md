# 交接：離線模型不設固定耗時上限（2026-11-18）

使用者原話：
- 「我在 knowledge, aidoc 使用存離線 ai 請他用 cpu 慢慢生字，都不會這樣叫他閉嘴的」
- 「有載入，持續出詞元，就等，這邊做法要跟 streaming 一樣，如果詞元是退化文字才中斷」
- 「這不是線上的，這是離線，使用者的電腦 gpu，當使用者決定用離線模型，就有要等很久的準備了」
- 「這不只是新聞摘要」「離線模型本身就是該這樣做」
- 「aidoc ask 必須就是聊天核心，背後不管接 tool／recipe，他的目的就是以這包 code 為範圍」

## 已完成（都已提交；v447、v448 發布）
- `f4d245624`：新聞摘要拿掉所有固定耗時上限，只靠明確失敗、退化文字、使用者取消中斷。
- `59b5fc134`、`15f76f658`：離線生成卡死偵測，只在「完全沒有新詞元且載入也沒進度」時終止，門檻 10 分鐘（呼叫端 `a.stallMs` 給）；頁首顯示階段、字數、速度；`offline_stall.test.js`。
- `c2db82540`：CoLU 與 Thinking 的時限改為 0（不設）。
- 藏書閣：離線模型拿掉 20 分鐘絕對上限（`knowledge_host.js`）。
- `docs/offline-timeouts.md`：離線耗時上限盤點表（逐項標改了／線上不動／待改）。
- 快照 `1e50ec2d1`：共用入口進行中的改動（語法與 offline_stall 9 項、vlm_core 165 項通過）。後續一批（offline_stall 11 項）工作階段被使用者中斷，內容若有留在工作目錄請先看 `git status` 再決定。

## 待辦（依序）
1. 查證聊天核心（藏書閣對話、終端機 ask AI）呼叫離線模型的共用入口，確認 streaming、取消、退化偵測。我 grep 只找到基準用的 `degenerate(call)`（`floating-assistant.js` 約 38913 行）；聊天核心有沒有同類偵測沒查證。
2. 新聞摘要改走同一個入口；聊天核心沒有退化偵測就把 `degenerate()` 抽成純函式共用，並接到聊天核心 streaming，讓所有離線對話受益；與卡死偵測重複的併掉。
3. `/aidoc ask` 改成走聊天核心（背後可接 tool／recipe），範圍限定為本專案程式碼。現況只是離線索引查詢、不呼叫 AI：入口約 `floating-assistant.js:95686` → `_repoAskRun`（約 98889）→ `_faCodeAsk`（約 3228）。
4. 照盤點表逐項把離線路徑的固定上限改掉；線上 API 的逾時不動。
5. `knowledge_truncation.test.js` 工作階段說啟動就出錯，我找不到這個檔，要先確認檔名再判斷是不是既有問題。

## 規則與陷阱
- 純中文、不夾英文縮寫；失敗訊息要有具體事實。
- 每批通過動到的測試就提交；發布由管理者跑，不要跑 `scripts/publish.sh`。
- 兩個工作階段同改 `renderer/src/floating-assistant.js`：只 `git add` 自己的檔案，不要 `git add -A`。
- 改完嵌入來源模組要跑 `node scripts/embed-code-ui.js` 與 `node build-assistant.js`。
