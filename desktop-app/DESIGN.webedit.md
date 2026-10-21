# 網頁編輯器（webedit）：HTML 檢視加假後端，兩邊都能請 AI 改

## 怎麼開

- 斜線指令：`/webedit`（列出起手式）、`/webedit 起手式名稱`、`/webedit 一句話描述`
- 工具：`webedit_open`（參數 starter 或 spec）、`webedit_topic`（查格式說明）
- 直接說：「幫我做一個記帳的小網站」「我想要 html 編輯器，加 mock backend」會由工具提示正規式帶出 `webedit_open`
- 對話裡會出現 `fa-webedit` 程式碼區塊（內容是 `{id, spec?}`），畫面上掛成編輯器；規格不大於 12000 字會一起嵌進去，換一台機器也能開。

## 規格

`{v:1, title, files:[{name, content}], backend:{lang:'js'|'python', code}|null}`

- `webedit_core.js`（純函式，`FaWebEdit`）：`validate`、`buildHtml`（把本機 css／js 內嵌進預覽）、`routesOf`、`pyPackages`、起手式（blank、todo、chat、form、python_api）。
- 編輯動作是封閉集合：`set_title set_file patch_file add_file remove_file rename_file set_backend patch_backend remove_backend`。`patch` 的要找字串必須剛好出現一次（除非 `all:true`）；PHP 直接拒絕並說明原因。
- `parseEditRequest` 先由程式讀指令；`classify` 判斷是前端還是後端的修改。

## 執行

- JS 後端：沿用 `sandbox_mock` 的 hub（`http`、`wsOpen`、`wsSend`、`attach`、`db.*`），所以 WebSocket、SSE、持久資料都真的能用，頁面裡的 `fetch`／`WebSocket` 由 `__faMockShim` 導進同一個 hub。
- Python 後端：`_sandboxPyAppRun`（Pyodide）；Flask 等框架第一次由 `pyPackages` 偵測 import 後安裝。同一個編輯器用同一個 session（`session` 參數）：app 只載入一次，記憶體裡的變數在請求之間保留；程式碼改了才重載。沒有 WebSocket。
- 「🔄 重整後端」按鈕（提示文字「這會讓套件重裝」）：丟掉 session、重新載入程式並重新安裝套件（`reset`），是唯一會重裝套件的操作。
- 套用新後端程式碼前，先用暫時名稱載入檢查；失敗就保留舊的後端繼續跑，並把原因說出來。
- 匯出：這裡的伺服器只是讓人體驗架設的感覺，要上線就匯出。每次匯出都帶 `README.md`（部署教學：本機跑、Render／Railway／Fly.io、自己的主機、注意事項）與 `PROMPT.md`（重建專案用的 prompt 加部署教學）。JS 後端匯出 Node（含 `public/` 頁面）或 Cloudflare；Python 後端匯出 `app.py`、`main.py`（把 `public/` 的頁面一起服務）、`requirements.txt`、`Procfile`、`Dockerfile`。PHP 不能執行也不能匯出。

## AI 修改

- 前端：`editPrompt` → 模型回 JSON 動作 → `parseEditsReply` → `applyEdits`。
- 後端：把 `backendTask` 組成自足的任務，交給 `prog_webservice`（programming 領域）寫，`extractCode` 取出程式碼後走載入檢查。
- 一個動作都沒套用時，訊息明講「這次沒有改成：」加原因，不說「改好了」。

## 編輯器介面

預覽（含視窗大小）／程式碼（檔案分頁、新增、改名、刪除）／後端（語言、套用並重啟、路由清單、請求測試、請求紀錄與伺服器輸出、持久資料、匯出）；右側 AI 對話（附圖、貼上、拖曳）與記錄；上一步、下一步、起手式、摘要、匯出、全螢幕。進度存在 fileCache JSON，對話重開能接著改。

## 限制

- PHP 不能執行。
- Python 後端沒有 WebSocket；第一次需要網路安裝套件。
- 學習單編輯器不需要後端，維持純學習單設計，不併進這個外殼。

## 驗證

`scripts/webedit-tests/webedit_core.test.js`（28 項）與 `scripts/eval/webedit.eval.js`（真實 Electron：開啟、頁面 fetch、WebSocket 廣播、資料庫、匯出、AI 分流、載入檢查、持久化、跨機器開啟、Python 請求／404／WebSocket 拒絕／匯出拒絕）。
