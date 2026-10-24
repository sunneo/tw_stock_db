# TODO（索引）

還沒做的事一份一個主題，檔名是 `DESIGN.TODO.<主題>.md`；做完（或決定不做）就改名拿掉 `TODO.`（變成 `DESIGN.<主題>.md`）或刪除。

| 主題 | 檔案 | 狀態 |
|---|---|---|
| Neovim in WASM（nvim-wasm）取代 /run-terminal 裡手寫的 vim clone；含終端機各 Phase 的歷史紀錄 | [DESIGN.TODO.nvim-wasm.md](DESIGN.TODO.nvim-wasm.md) | Phase 1–5 的紀錄與驗證方式都在這份（程式註解裡的「TODO.md Phase N」指這裡） |
| 多對話並行背景執行＋chat list UI（進行中沙漏／未讀圖示／最後更新時間） | [DESIGN.TODO.multi-chat.md](DESIGN.TODO.multi-chat.md) | 需求與根本原因；執行階段尚未開始（以這份的勾選為準） |
| 專案索引：匯出的 HTML 要能自己讀寫、自己問答（2026-10-13） | [DESIGN.TODO.project-index-html.md](DESIGN.TODO.project-index-html.md) | 之後再做；設計見 DESIGN.project-index.md |
| 本機 /edge-tts 的 Sec-MS-GEC v2 簽章 | [DESIGN.TODO.edge-tts-gec.md](DESIGN.TODO.edge-tts-gec.md) | 先放著，目前夠用 |
| 程式設計 domain 的 patch 小工具與 CI/CD（2026-10-14） | [DESIGN.TODO.coding-patch-ci.md](DESIGN.TODO.coding-patch-ci.md) | — |
| 安全自我升級（原「四個方向」裡唯一還沒做的；前三個已完成，見 DESIGN.four-directions.md） | [DESIGN.TODO.safe-self-upgrade.md](DESIGN.TODO.safe-self-upgrade.md) | 尚未開始 |
| /edit-svg、/edit-picture、/edit-3d-model 已實作後還沒做／沒驗證的 | [DESIGN.TODO.edit-svg-picture-3d.md](DESIGN.TODO.edit-svg-picture-3d.md) | 設計見 DESIGN.edit-svg／edit-picture／edit-3d.md |
| /edit-game-2d、/edit-game-3d（遊戲編輯器） | [DESIGN.edit-game.md](DESIGN.edit-game.md) | 已實作（2026-10-25）；AI 逐檔移植的目標碼沒在這裡編譯過、舊機種只做適配檢查，見文件的「實作狀態」 |
| /edit-media-presentation（簡報播放器旁邊的 AI 對話框，每一頁都能插入內容、代理人上網找圖與資料） | [DESIGN.edit-media-presentation.md](DESIGN.edit-media-presentation.md) | 已實作（2026-10-25）；代理人那條路用假的子代理驗證過，真的連模型與網路的端到端沒測 |
| `/edit-picture` 的擴散細化層（只重畫一小塊、羽化蓋回、啟用項） | [DESIGN.TODO.edit-picture-diffusion.md](DESIGN.TODO.edit-picture-diffusion.md) | 只有規劃（§5 要先做最小實測） |
| 熱更新（live-update）：發佈腳本驗證分段版、狀態自我修復、各平台驗證 | [DESIGN.TODO.live-update.md](DESIGN.TODO.live-update.md) | 主體已完成（v188）；只剩驗證與小項目 |
