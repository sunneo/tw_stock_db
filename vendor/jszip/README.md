# JSZip（本地備份，不依賴 CDN）

`floating-assistant.js` 用 [JSZip](https://github.com/Stuk/jszip) 讀寫 `.skill`
匯入/匯出用的 zip 檔（見該檔案 `_ensureJSZipLoaded()`）。只有使用者真的按了
匯入/匯出 `.skill` 才會動態載入，不是每次開頁面都需要。

## 檔案來源

| 檔案 | 來源 |
|---|---|
| `jszip.min.js` | `https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js` |
| `LICENSE` | `https://raw.githubusercontent.com/Stuk/jszip/v3.10.1/LICENSE.markdown` |

- 版本：**JSZip 3.10.1**（跟原本引用的 CDN 版本一致）。
- 下載日期：2026-08-28。
- SHA256：`jszip.min.js` = `acc7e41455a80765b5fd9c7ee1b8078a6d160bbbca455aeae854de65c947d59e`

## 授權

MIT License **或** GPLv3 雙授權，使用者可自行選擇其一（見同目錄 `LICENSE`），
原封不動保留官方 repo 對應版本標籤的授權內容。專案本身：
<https://github.com/Stuk/jszip>。

## 升級版本

從 [JSZip Releases](https://github.com/Stuk/jszip/releases) 找到新版號，把 cdn
網址的版本號換掉重新下載，同步更新這份 README 的版本號/日期/SHA256，並重新抓
一次對應版本標籤的 LICENSE。
