# 第三方前端函式庫（本地備份，不依賴 CDN）

`台股追蹤` 網頁跟內嵌的 `floating-assistant.js`（AI 助理）用到的第三方
JS/CSS/字型函式庫，全部原封不動下載進這個資料夾，不再每次開啟頁面都向外部
CDN（cdnjs.cloudflare.com／jsdelivr.net）現抓。每個子資料夾各自有一份
`README.md`（來源網址、版本、下載日期、SHA256 checksum）跟 `LICENSE`（原始
授權文件，未修改）。

**這份資料夾住在獨立的 `vendor-assets` 分支**（不在 `main`），跟
`db-snapshot` 分支同樣的道理：這些是很少變動的第三方二進位/函式庫檔案，放進
`main` 的一般 commit 歷史裡，每次改動都會讓 clone 體積跟著累加，而這些檔案
本身根本不需要保留歷史——`vendor-assets` 分支永遠**只有一個 commit**，每次
更新都是整個分支 force push 覆蓋（`git push --force origin vendor-assets:vendor-assets`），
沒有歷史包袱。`web/index.html`／`web/floating-assistant.js` 對這裡的檔案一律
用絕對網址引用（`https://raw.githubusercontent.com/sunneo/tw_stock_db/vendor-assets/vendor/<套件>/<檔案>`），
不是相對路徑——因為 `main` 分支本身不包含這些檔案。

## 目錄

| 資料夾 | 用途 | 版本 |
|---|---|---|
| [`sql.js/`](sql.js/README.md) | 網頁本機資料庫（WASM SQLite） | 1.10.2 |
| [`pptxgenjs/`](pptxgenjs/README.md) | AI助理匯出PPTX簡報 | 3.12.0 |
| [`pdfmake/`](pdfmake/README.md) | AI助理匯出PDF報告 | 0.2.9 |
| [`fonts-noto-sans-tc/`](fonts-noto-sans-tc/README.md) | PDF匯出用的繁體中文字型 | fontsource @latest 快照 |
| [`marked/`](marked/README.md) | AI回覆markdown轉HTML | 12.0.2 |
| [`dompurify/`](dompurify/README.md) | AI回覆HTML消毒（防XSS） | 3.1.6 |
| [`katex/`](katex/README.md) | AI回覆數學公式排版 | 0.16.11 |
| [`jszip/`](jszip/README.md) | `.skill`檔匯入/匯出 | 3.10.1 |

## 更新流程（維持單一commit）

1. 在 `main` 分支的工作目錄裡（例如這個 repo 的 `web/vendor/` 本身）先把
   新版檔案下載/更新好、確認檔案內容正確。
2. 切換到一份獨立的 `vendor-assets` 分支工作目錄（乾淨checkout，不要在
   `main` 的工作目錄上直接切branch，避免不小心把其他未commit的變更帶過去），
   把整個 `vendor/` 資料夾內容覆蓋過去。
3. `git add -A && git commit --amend -m "..."`（用`--amend`延續單一commit，
   不要疊加新commit）或先 `git reset` 到orphan根再重新commit一次。
4. `git push --force origin vendor-assets:vendor-assets`。
5. 如果新增了新的套件資料夾，記得同步更新這份總覽README的表格。

## 為什麼要 vendor 進 repo，而不是繼續用 CDN

- 每次開啟網頁、每次AI助理要匯出PPTX/PDF，都要另外向CDN要一次這些檔案——
  改成同一個GitHub Pages部署直接附帶，省一個外部網域的網路往返、也不受該CDN
  當下是否可用/降速影響（PPT/PDF等匯出功能因此不再依賴CDN存活與否）。
- 版本鎖定更明確：CDN網址本身通常已經帶版本號，理論上不會變，但檔案直接進
  repo才是真正「這個版本、這份位元組」永遠不會變的保證。
