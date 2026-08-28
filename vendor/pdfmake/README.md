# pdfmake（本地備份，不依賴 CDN）

`floating-assistant.js` 用 [pdfmake](https://github.com/bpampuch/pdfmake) 把
AI 回覆匯出成 PDF 報告（見該檔案 `FA_PDFMAKE_URL`/`FA_PDFMAKE_FONTS_URL` 附近的
說明）。`vfs_fonts.js` 是 pdfmake 內建字型（Roboto 等）的 base64 虛擬檔案系統，
跟 `pdfmake.min.js` 是同一個版本配對使用，不能單獨升級其中一個。

## 檔案來源

| 檔案 | 來源 |
|---|---|
| `pdfmake.min.js` | `https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.9/pdfmake.min.js` |
| `vfs_fonts.js` | `https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.9/vfs_fonts.js` |
| `LICENSE` | `https://raw.githubusercontent.com/bpampuch/pdfmake/0.2.9/LICENSE` |

- 版本：**pdfmake 0.2.9**（跟原本引用的 CDN 版本一致）。
- 下載日期：2026-08-28。
- SHA256：
  - `pdfmake.min.js` = `f4bd777009cdb0de8458d859b631084a3a39f56ef1ca2ea205a4e6f8ee05b36f`
  - `vfs_fonts.js` = `e6a5cd79421e567b9b5f7cfb5cfe4df4ff75ba7a3809398badb6c2af53657297`

## 授權

MIT License（見同目錄 `LICENSE`，Copyright (c) 2014-2015 bpampuch），原封不動保留
官方 repo 對應版本標籤的授權內容。專案本身：
<https://github.com/bpampuch/pdfmake>。

## 升級版本

從 [pdfmake Releases](https://github.com/bpampuch/pdfmake/releases) 找到新版號，
`pdfmake.min.js`／`vfs_fonts.js` 兩個檔案務必**同時**換成同一個版本（版本不一致
可能造成字型找不到或渲染錯誤），同步更新這份 README 跟重新抓 LICENSE。
