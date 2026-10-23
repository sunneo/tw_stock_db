<!-- 從 TODO.md 拆出（2026-10-23）：內容原封不動，只是改成一份一個主題。 -->

## 專案索引：匯出的 HTML 要能「自己讀寫、自己問答」（之後再做，2026-10-13 使用者提出）

背景：專案索引設定頁拿掉了「匯出問答 HTML」「存進專案資料夾」「從專案資料夾載入」「匯出索引檔」「匯入索引檔」五個按鈕
（索引改成直接建立在專案資料夾的 `.floating-assistant/index/`，預設索引完成自動存回、再開專案自動接續）。
目前保留「匯出 SQLite HTML」；下面是希望它變成的樣子（完整設計見 [DESIGN.project-index.md](DESIGN.project-index.md) §16～§19）：

- [x] **匯出的 HTML 自帶 File Access Point（fap）**：打開後可以授權專案資料夾，用 fap 直接**讀寫原始碼**、**讀寫 sqlite**（索引資料庫），
  不用再回到助理主程式操作。
- [x] **內建 AI 問答（部分）**：HTML 自己下載小模型（Qwen3 0.6B，跟助理主程式同一個預設）。模型放進專案的隱藏資料夾
  （`.floating-assistant/` 底下），並可載入瀏覽器的 persistent storage（同一份快取，不重複下載）；靜默下載、用到才載入。
- [x] **搭配離線訓練器（Offline Trainer）的能力**：用類似 tree-sitter 的結構分析，快速讀懂程式的「定義」與「架構」（符號、依賴、呼叫關係），
  問答時由程式先查結構、小模型只負責措辭與選擇題，不要讓 0.6B 自己硬讀整份原始碼（跟離線食譜模式同一個思路）。
- 完成狀態與限制見 [DESIGN.project-index.md](DESIGN.project-index.md) §19、§20：已做大索引分段匯出、頁內「🧠 解釋」（語法樹＋函式語意＋離線模型）、批次更新與資料夾說明。**還沒做**：模型檔存進專案 `.floating-assistant/models/`（目前只存瀏覽器快取）、真的 `showDirectoryPicker` 手動走一次、100 MB 以上與 7 萬檔專案的實測。
- 要先確認的事：HTML 單檔大小（內嵌 sqlite wasm 與小模型載入器）、網頁版與桌面版的 fap 授權流程差異、模型下載來源（HuggingFace）在 file:// 下能不能用。
