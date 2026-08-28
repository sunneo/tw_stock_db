# Noto Sans TC（本地備份，不依賴 CDN）

`floating-assistant.js` 匯出 PDF 時，pdfmake 內建字型（Roboto）完全沒有中文
字圖，中文會整段變成豆腐字方塊——這裡額外載入 Noto Sans TC（思源黑體繁體中文）
補上中文字型（見 `floating-assistant.js` 的 `FA_CJK_FONT_REGULAR_URL`/
`FA_CJK_FONT_BOLD_URL` 附近說明）。透過 [fontsource](https://fontsource.org/)
專案（把 Google Fonts 重新打包成獨立 TTF 檔）取得子集化過的 TTF。

## 檔案來源

| 檔案 | 來源 |
|---|---|
| `chinese-traditional-400-normal.ttf`（Regular） | `https://cdn.jsdelivr.net/fontsource/fonts/noto-sans-tc@latest/chinese-traditional-400-normal.ttf` |
| `chinese-traditional-700-normal.ttf`（Bold） | `https://cdn.jsdelivr.net/fontsource/fonts/noto-sans-tc@latest/chinese-traditional-700-normal.ttf` |
| `LICENSE` | `https://raw.githubusercontent.com/fontsource/font-files/main/fonts/google/noto-sans-tc/LICENSE` |

- 下載日期：2026-08-28（來源網址本身是 `@latest`，沒有固定版本號，下載當下是
  什麼內容就存成這份快照；之後要更新只能重新下載覆蓋，無法回溯查特定版本）。
- SHA256（下載當下即時計算，供之後比對檔案有沒有被意外改動）：
  - `chinese-traditional-400-normal.ttf` = `ac2b50fc8aef3350e611b7dd32515a7f2250bffadc32c4a1f245881babccd4b5`
  - `chinese-traditional-700-normal.ttf` = `b4ebab62716f0d35fb74aa93c67c3e430ce60e1b29f6894f8f228f3fc51f5768`

## 授權

SIL Open Font License, Version 1.1（見同目錄 `LICENSE`，Google Inc.）。Noto 字型
系列本身：<https://fonts.google.com/noto/specimen/Noto+Sans+TC>，fontsource
打包專案：<https://github.com/fontsource/fontsource>。

## 升級版本

來源網址沒有版本鎖定（`@latest`），內容可能隨時變動——如果之後想鎖定特定版本，
改用 npm 套件 `@fontsource/noto-sans-tc` 對應版本號的 `files/` 目錄底下同名
TTF，會比 `@latest` 更可預期。更新後同步更新這份 README 的下載日期與 SHA256。
