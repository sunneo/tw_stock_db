<!-- 從 TODO.md 拆出（2026-10-23）；2026-10-25 使用者確認 1～3 已完成，內容保留當作當初的目標與待決定事項，實作與細節見各自的設計文件。 -->

# 四個方向（2026-10-21 使用者提出）：前三個已完成（2026-10-25 確認），第四個「安全自我升級」拆到 DESIGN.TODO.safe-self-upgrade.md

## 1. Knowledge Inventory（FAP／IndexedDB 為主的本機 NotebookLM）
- 來源（上傳檔案、抓回來的網頁、FAP 資料夾的檔案、對話裡的內容）進同一個「收藏庫」，存在 IndexedDB；每個來源有章節目錄（可用 `article_outline`）、摘要、可引用的片段。
- 問答要附出處（來源、章節、片段），離線時用本機檢索，線上時才請模型整理；弱模型只問封閉式問題（挑片段、挑編號）。
- 待決定：向量檢索用哪個小模型、片段大小、容量上限與淘汰、是否能匯出／匯入成一包。

## 2. WebGPU／CPU＋transformers.js 的圖像生成（模型要夠小）
- 已整合（2026-10-22）：SDXS-512 一步取樣，GPU 版約 880 MB（fp16，WebGPU）、CPU 版約 1.12 GB（int8，wasm）；第一次下載的同意與授權提示、快取、設定、`generate_image`／`/image` 的 `provider` 都做好了，見 DESIGN.image-generation.md。
- [ ] 還沒做：在真機上實測載入與生圖（WebGPU 與 CPU 各一組速度與記憶體數字）；Electron 開 crossOriginIsolated 讓 CPU 版能多執行緒；更小的 CPU 模型（目前 CPU 版 1.1 GB）；對話裡以圖生圖／多張。

## 3. 桌面版專用功能 `computer use`（給弱模型用）
- 動作層：Windows 用類似 nircmd 的小工具，Linux 用 xdotool＋wmctrl；Windows 的視窗／控制項清單用 UI Automation（類似 Spy++）。
- 弱模型（Florence-2 base、LLaVA-Interleave Qwen 0.5B）負責描述與辨識：sash、網頁分頁、開始功能表、按鈕、標題列、工具列、各種視窗元件、整個畫面；程式負責座標、比例與驗證。
- 探索 → 移動 → 拍照確認：移動滑鼠看游標圖示與物件的變化來猜哪些可以點；分辨某個框是不是動畫，是的話接上連續取樣的觀察串流；用移動滑鼠加拍照量出滑鼠速度與座標比例。
- 整串流程要是 UML design → code，最後整體行為可以匯出給使用者直接跑。
- 安全：一律先預覽要做的動作、可隨時中止；不碰系統設定、密碼欄位、付款；範圍限定在使用者指定的視窗。

> 實作與細節：1 → DESIGN.knowledge-inventory.md；2 → DESIGN.image-generation.md；3 → DESIGN.computer-use.md。上面各項裡的「待決定」「還沒做」是當初寫的，**沒有逐項核對過是否都做完了**，以各設計文件為準。
