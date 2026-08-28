# DOMPurify（本地備份，不依賴 CDN）

`floating-assistant.js` 用 [DOMPurify](https://github.com/cure53/DOMPurify) 消毒
marked.js 轉出的 HTML，過濾掉 `<script>`／`on*` 事件屬性等，避免模型輸出（或被
工具結果間接帶進來的內容）挾帶惡意 HTML 造成 XSS（見該檔案
`_ensureMarkdownLibsLoaded()`）。

## 檔案來源

| 檔案 | 來源 |
|---|---|
| `purify.min.js` | `https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.1.6/purify.min.js` |
| `LICENSE` | `https://raw.githubusercontent.com/cure53/DOMPurify/3.1.6/LICENSE` |

- 版本：**DOMPurify 3.1.6**（跟原本引用的 CDN 版本一致）。
- 下載日期：2026-08-28。
- SHA256：`purify.min.js` = `c0845096a7c4a6741f362ac506c94c1c7d27dc603bcc1bf64a587f76f2dbe3a1`

## 授權

Apache License 2.0 / Mozilla Public License 2.0 雙授權（見同目錄 `LICENSE`，
Copyright 2024 Dr.-Ing. Mario Heiderich, Cure53），原封不動保留官方 repo 對應
版本標籤的授權內容。專案本身：<https://github.com/cure53/DOMPurify>。

## 升級版本

從 [DOMPurify Releases](https://github.com/cure53/DOMPurify/releases) 找到新版
號，把 cdn 網址的版本號換掉重新下載，同步更新這份 README 的版本號/日期/SHA256，
並重新抓一次對應版本標籤的 LICENSE。
