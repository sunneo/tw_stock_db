# 資料檢視器：JSON／YAML／TOML／CSV／XLSX／SQLite（嵌在對話裡）

2026-10-15 使用者要求。目標：AI 回覆裡出現這些資料時，不是一大坨文字，而是可以看、可以查、可以問 AI、可以轉出去的檢視器。

## 一、共同外觀（所有檢視器長一樣，只有內容不同）

```
┌ JSON · 1,204 行 · 38 KB ─────── [Source][Viewer]  🔎[搜尋…] ◂ 3/17 ▸      [Export ▾] [🤖 Ask AI] ┐
│ 行號 │ 內容（上色）                                                                              │
│ ...                                                                                              │
├ 🤖 AI 查詢 ──────────────────────────────────────────────────────── [全部清除] [▾ 收合] ┤
│ ▸ Q：哪些套件的授權是 GPL？            （可收合、可刪除這一則）                                  │
│ [輸入想查什麼資料…                                                              ] [問]          │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Source / Viewer 兩個按鈕**：Source＝原文，有行號、上色；Viewer＝可收合的樹（JSON／YAML／TOML）或表格（CSV／XLSX）。
- **Export 是點下去跳出選單**（跟簡報影片匯出同一種做法）：JSON、YAML、CSV、XLSX（JSON／YAML／TOML 來源）；CSV／XLSX 來源是 XLSX、CSV、SQLite3。
- **搜尋**：Source 找文字（全部命中數、上一個／下一個）；Viewer 找鍵名與值，命中的節點自動展開。
- **滾輪要先點一下才啟用**：嵌在對話裡的檢視器預設不吃滾輪（滾輪屬於對話），點一下（得到焦點）才在檢視器內捲動；點到外面就放開。共用的做法放在 `FaDataView.focusWheel(root, scroller)`，之後設計的檢視器直接用。
- **大檔案不卡**：行／節點／列都是虛擬捲動（只畫看得到的），幾十萬行也只畫幾十行。
- **畫面重繪不丟狀態**：對話整個重畫時，檢視器的節點（含展開狀態、搜尋、AI 查詢紀錄）用同一個節點接回去，不重建。

## 二、JSON／YAML／TOML → 表格（CSV、XLSX）

表格轉換是最難的部分，原則：**不丟資料、能還原關聯、一個 CSV 不夠就用多個工作表**。

1. **物件陣列**（`[{…},{…}]`）→ 一張表，欄位＝所有出現過的鍵（巢狀物件用 `a.b.c` 展開；原始型別的陣列用 `; ` 串起來）。
2. **物件，裡面有幾個物件陣列**（SPDX、CycloneDX 這類 SBOM）→ 每個陣列一張工作表；其餘純量／小物件放進 `summary`（路徑、值）。
3. **陣列裡還有物件陣列**（SPDX 的 `packages[].externalRefs[]`、`checksums[]`）→ 子工作表 `packages.externalRefs`，帶 `_parent`（上層那一列的列號）和 `_parent_id`（上層的 `SPDXID`／`id`／`bom-ref`／`name`），要 join 回去看得到。
4. **物件的值全是物件**（以 id 當鍵的字典）→ 一張表，多一欄 `_key`。
5. **混合型別的陣列**（SPDX 3 的 `@graph`、有 `type` 欄位的清單）→ 依 `type` 拆成多張工作表。
6. 其他（純量、原始型別陣列）→ `summary` 或 `values`。
7. 限制：Excel 單格 32,767 字元、單表 1,048,575 列，超過會截斷並在 `notes` 工作表註明。
8. CSV 一次只能一張表：選單裡每張工作表一個項目（「CSV：packages（1,203 列）」）。

## 三、Ask AI（AI 導向的查詢，不用學查詢語法）

使用者用一句話問想要什麼（「列出授權是 GPL 的套件和版本」「有哪些相依套件沒有 checksum」）。

- 資料**不整份丟給模型**：暫存成代號，子 agent 只拿到結構概要，用 `big_content` 工具（寫 JavaScript 解析、篩選、統計）取結果。這樣一路繼承大內容守門、斷線重試、離線訓練器退路、API 轉接。
- 回答是一張卡片：問題、答案（可含表格）、做法；卡片可個別收合、刪除，面板有「全部清除」。
- 離線（連不上或離線模式）時改用本機搜尋找答案並說明。
- CSV／XLSX：AI 查出來的表格另外存成**新的工作表**（`AI：問題`），可以再匯出。

## 四、各檢視器

| 檢視器 | Source | Viewer | Export | 狀態 |
|---|---|---|---|---|
| JSON | 行號＋上色 | 樹 | json、yaml、csv、xlsx | 第一階段 |
| YAML | 行號＋上色 | 樹 | yaml、json、csv、xlsx | 第一階段 |
| TOML | 行號＋上色 | 樹 | toml 轉出的 json、yaml、csv、xlsx | 第一階段 |
| CSV | 行號＋上色 | 表格（排序、篩選） | csv、xlsx、sqlite3 | 第一階段（對話裡的 csv 區塊） |
| XLSX | — | 表格＋工作表頁籤（只有一張也顯示）、Excel 欄名 A、B、…、AA、可拖曳欄寬 | xlsx（全部工作表）、csv（只匯出目前選的工作表）、json、sqlite3 | 完成：用 /view 開附件或檔名 |
| SQLite 瀏覽器 | — | 既有 | — | 完成：多一個「🤖 Ask AI」分頁（AI 只拿到資料表結構，寫唯讀 SELECT，畫面端執行；失敗帶錯誤訊息重試最多兩次） |

## 五、程式結構

- `renderer/src/dataview/data_core.js`（`FaDataCore`）：純函式。解析（JSON／YAML／TOML／CSV）、轉出（JSON／YAML／TOML／CSV）、上色、JSON→表格、XLSX 寫入／讀取、搜尋、樹展開。node 可直接測。
- `renderer/src/dataview/data_ui.js`（`FaDataView`）：DOM 元件，只依賴 host 物件（載入 js-yaml／jszip、下載、問 AI），不依賴 floating-assistant 內部。
- floating-assistant.js：對話裡的 json／yaml／toml／csv 區塊換成檢視器；`askAI` 接 `big_content` 與子 agent。

## 六、/view 指令

/view [檔名]：開啟附件（附件會從輸入框上方拿掉，不再停在附件列）、指定檔名（用檔名或 file_id 找已上傳的檔案），不帶參數開最近上傳、可以檢視的檔案。訊息裡只存一個小的 fa-dataview 區塊（檔案 id＋名稱），內容每次從檔案快取讀，重新整理後仍在。

## 七、表格類（CSV／XLSX）的畫面規則

- 欄名像 Excel：A、B、…、Z、AA、…、ZZ、AAA…；第一列資料是 row 1（欄位名稱），資料從 row 2 開始。
- 欄寬可以拖曳欄名右邊界調整，雙擊自動調整；欄名可點選排序。
- 工作表頁籤一律顯示；AI 的回答一律變成另一張「AI：問題」工作表（有表格用表格，沒有就一行一列），可個別刪除，匯出 xlsx／sqlite3 時一起帶出。
