# sql.js（本地備份，不依賴 CDN）

`台股追蹤` 網頁本機用 [sql.js](https://github.com/sql-js/sql.js)（WASM 版
SQLite）跑整個前端資料庫。這份資料夾把 sql.js 的執行檔直接放進本 repo，
`web/index.html` 改成從這裡載入，不再每次開啟頁面都向 CDN
（cdnjs.cloudflare.com）現抓。

## 檔案來源

| 檔案 | 來源 |
|---|---|
| `sql-wasm.js` | `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/sql-wasm.js` |
| `sql-wasm.wasm` | `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/sql-wasm.wasm` |
| `LICENSE` | `https://raw.githubusercontent.com/sql-js/sql.js/v1.10.2/LICENSE`（對應同一個版本標籤） |

- 版本：**sql.js 1.10.2**（跟原本網頁引用的 CDN 版本完全一致，這次只是換
  成本地檔案，行為不變）。
- 下載日期：2026-08-28。
- SHA256（下載當下即時計算，供之後比對檔案有沒有被意外改動）：
  - `sql-wasm.js`：`3358bb12892642698c0804c85cba48de562bc2de324fe58a422f282832c79c01`
  - `sql-wasm.wasm`：`4c1c978826062f7b1bb6cc811503863b01415175d0e6dd9ce8a30a81a02c0afb`

## 授權

sql.js 採用 MIT License（見同目錄 `LICENSE`，Copyright (c) 2017 sql.js
authors）。這裡直接原封不動保留官方 repo 對應版本標籤的 LICENSE 檔案內容，
沒有修改。sql.js 專案本身：<https://github.com/sql-js/sql.js>。

## 為什麼要 vendor 進 repo，而不是繼續用 CDN

- 每次開啟網頁都要另外向 cdnjs 要一次這兩個檔案（尤其 `sql-wasm.wasm`
  超過600KB），改成同一個 GitHub Pages 部署直接附帶，省一個外部網域的
  網路往返、也不受該 CDN 當下是否可用/降速影響。
- 版本鎖定更明確：CDN 網址本身已經帶版本號（1.10.2），理論上不會變，但
  檔案直接進 repo 才是真正「這個版本、這份位元組」永遠不會變的保證。

## 之後要升級版本怎麼做

1. 從 [sql.js Releases](https://github.com/sql-js/sql.js/releases) 或
   npm（`https://www.npmjs.com/package/sql.js`）找到新版本號。
2. 重新下載對應版本的 `sql-wasm.js`／`sql-wasm.wasm`（cdnjs 網址把版本號
   換成新版本即可，或直接從 npm 套件的 `dist/` 目錄取得），覆蓋這個
   資料夾裡的檔案。
3. 同時更新這份 README 的版本號、下載日期、SHA256、以及重新抓一次對應
   版本標籤的 `LICENSE`（不同版本授權條款理論上不會變，但仍建議照抓，
   保持「檔案來源跟版本一一對應」的原則）。
4. 檢查 `web/index.html` 裡有沒有跟著版本號寫死的地方需要一併更新（目前
   是指向這個資料夾的相對路徑，不含版本號，理論上不用動）。
