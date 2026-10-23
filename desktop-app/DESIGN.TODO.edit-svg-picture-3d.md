<!-- 從 TODO.md 拆出（2026-10-23）：內容原封不動，只是改成一份一個主題。 -->

# TODO：`/edit-svg`、`/edit-picture`、`/edit-3d-model`（2026-10-23 已實作，這裡只留還沒做／沒驗證的）

設計與用法見 DESIGN.edit-svg.md、DESIGN.edit-picture.md、DESIGN.edit-3d.md；程式在 `renderer/src/edit/`，驗證在 `scripts/edit-tests/`（核心，已併入 `run-core-tests.js`）與 `scripts/eval/edit.eval.js`、`scripts/eval/edit3d.eval.js`（真實 Electron，假的 LLM／VLM／生圖）。

- **三個編輯器共通**：真實 LLM／VLM 把話翻成動作的品質（只用假模型驗過流程）；登入後的真實網頁版（`web/`）沒跑過；英文介面只有 SVG／圖片編輯器有（3D 編輯器的字只有中文）；拖曳物件、滾輪縮放、修復畫筆的滑鼠操作在桌面版只用合成事件驗過 3D 的拖曳與點選，SVG／圖片的是外掛版 Playwright 驗過同一份程式。
- **/edit-3d-model 還沒做**：匯入 glb；匯入的真實 OBJ／STL 模型走編輯器的實測；粒子與動畫節點在編輯器畫面裡的預覽（目前只保留在 YAML、畫面靜態）；單一物件編輯的拖曳旋轉；曲面貼皮的展開（現在是整張貼圖烘上去，圖會被拉伸）；真實 GPU；群組只有等比縮放；很大的模型的效能。
- **Redmine 外掛版**：`/edit-3d-model` 還沒移植（桌面版實現後才移植；`redmine_ai_chat/CHANGES.md` 寫著「不做」的那一項現在可以做了）。
