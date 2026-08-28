# KaTeX（本地備份，不依賴 CDN）

`floating-assistant.js` 用 [KaTeX](https://github.com/KaTeX/KaTeX) 把 AI 回覆裡
的 LaTeX 數學語法（`$...$`/`$$...$$`）排版成正式數學符號（見該檔案
`_ensureMarkdownLibsLoaded()`/`_renderMarkdownWithMath()`）。

## 檔案來源

| 檔案 | 來源 |
|---|---|
| `katex.min.js` | `https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.11/katex.min.js` |
| `katex.min.css` | `https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.11/katex.min.css` |
| `fonts/*`（60 個字型檔） | `https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.11/fonts/<檔名>`，逐一對照 `katex.min.css` 裡 `@font-face` 引用的每個 `url(fonts/...)` 下載，woff2/woff/ttf 三種格式都保留（不是只留woff2，才能跟上游原始發佈內容完全一致，也保留舊瀏覽器的字型格式回退能力） |
| `LICENSE` | `https://raw.githubusercontent.com/KaTeX/KaTeX/v0.16.11/LICENSE` |

- 版本：**KaTeX 0.16.11**（跟原本引用的 CDN 版本一致）。
- 下載日期：2026-08-28。
- SHA256（`katex.min.js`/`katex.min.css`）：
  - `katex.min.js` = `e6bfe5deebd4c7ccd272055bab63bd3ab2c73b907b6e6a22d352740a81381fd4`
  - `katex.min.css` = `717bc9ae7853b61f0f76455dddf0ecd4f527a783f42de2ac24684899c1c46258`
- `fonts/` 底下 60 個檔案的 SHA256 逐一列在同目錄 `fonts.sha256.txt`（格式跟
  `sha256sum` 輸出一致，可用 `sha256sum -c fonts.sha256.txt` 驗證）。

⚠️ **`katex.min.css` 用相對路徑 `url(fonts/xxx)` 引用字型**，所以這份 CSS 檔
只能放在 `fonts/` 目錄的上一層（跟 CDN 上的目錄結構一致），不能單獨搬移
`katex.min.css` 而不帶 `fonts/`，否則數學公式會顯示成沒有正確字型的預設字。

## 授權

MIT License（見同目錄 `LICENSE`，Copyright (c) 2013-2020 Khan Academy and other
contributors），原封不動保留官方 repo 對應版本標籤的授權內容——同一份 LICENSE
涵蓋程式碼跟字型檔（KaTeX 官方 repo 沒有另外為 `fonts/` 目錄提供獨立的字型
授權檔案）。專案本身：<https://github.com/KaTeX/KaTeX>。

## 升級版本

從 [KaTeX Releases](https://github.com/KaTeX/KaTeX/releases) 找到新版號：
1. 重新下載 `katex.min.js`／`katex.min.css`。
2. 從新版 `katex.min.css` 重新解析所有 `url(fonts/...)` 引用，逐一下載到
   `fonts/`（字型檔清單每個版本可能不同，不能假設檔名不變，務必用新版CSS
   重新解析一次，不要只覆蓋舊清單裡的檔名）。
3. 重新產生 `fonts.sha256.txt`、更新這份 README 的版本號/日期/checksum，
   並重新抓一次對應版本標籤的 LICENSE。
