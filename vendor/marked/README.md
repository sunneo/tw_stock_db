# marked（本地備份，不依賴 CDN）

`floating-assistant.js` 用 [marked](https://github.com/markedjs/marked) 把 AI
回覆的 markdown 文字轉成 HTML 顯示（見該檔案 `_ensureMarkdownLibsLoaded()`）。

## 檔案來源

| 檔案 | 來源 |
|---|---|
| `marked.min.js` | `https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js` |
| `LICENSE` | `https://raw.githubusercontent.com/markedjs/marked/v12.0.2/LICENSE.md` |

- 版本：**marked 12.0.2**（跟原本引用的 CDN 版本一致）。
- 下載日期：2026-08-28。
- SHA256：`marked.min.js` = `15fabce5b65898b32b03f5ed25e9f891a729ad4c0d6d877110a7744aa847a894`

## 授權

MIT License（見同目錄 `LICENSE`），原封不動保留官方 repo 對應版本標籤的授權
內容。專案本身：<https://github.com/markedjs/marked>。

## 升級版本

從 [marked Releases](https://github.com/markedjs/marked/releases) 找到新版號，
把 cdn 網址的版本號換掉重新下載，同步更新這份 README 的版本號/日期/SHA256，
並重新抓一次對應版本標籤的 LICENSE。
