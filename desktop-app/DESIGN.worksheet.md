# 教育文書（學習單／練習卷）：描述 → HTML → PDF，支援參考圖片、人工調整、CoLU

目標：使用者貼一張學習單（或拍下學習單的照片）說「幫我設計一樣的、做成 PDF、顏色跟他一樣」，產出排好版的 PDF。領域 `worksheet`（教育文書），核心 `renderer/src/worksheet/worksheet_core.js`（FaWorksheet，純函式，node 可測）。

## 資料流
```
請求文字 ──parseRequest（程式讀）──▶ spec（JSON 描述）◀──mergeRef──  參考圖片 ──視覺模型（只回一小段 JSON，refFromReply 檢查）
                                         │  applyEdits（人工調整：封閉的編輯動作）
                                         ▼
                              layout(spec)：圖形清單（毫米座標：circle／rect／line／poly／text）
                       ┌────────────┼─────────────┐
                    toSvg／toHtml   toPdfmake     drawCanvas
                 （預覽、可列印、可   （向量 PDF，    （PNG 預覽圖）
                   再微調的 HTML）   中文用 NotoSansTC）
```
排版與輸出共用同一份圖形清單，所以 HTML、PDF、PNG 長得一樣；座標與字級一律是毫米，程式自己排，AI 不用寫座標。

## spec 與區塊
`{title, subtitle, header:{name,date,school,score}, page:{size:A4|A5|Letter, orient, margin}, blocks:[…]}`。區塊：`bead_rows`（串珠：base 顆金珠＋c 顆彩珠，端環、反光、右邊答案線）、`count_rows`（數一數：圓／方／星）、`equations`（加減法）、`ten_frames`（十格框）、`number_line`（數線，可挖空）、`text`、`spacer`。串珠標準色：1 紅、2 綠、3 粉、4 黃、5 藍、6 紫、7 白、8 桃紅、9 深藍、金色＝10（跟範例一樣）。`validate` 把任何來源整理成合法、有上限的形狀，壞的欄位退回預設並回報，不丟例外。

## 三個來源
1. **程式讀請求**：偵測是哪一種學習單、「10又1, 10又2」→ base 10、串數（範圍「10又1到10又5」、「做6串」、參考圖片的列數；都沒有就預設 1～8 並說明）、「右邊填上」→ 右側答案線、「附答案／教師版」→ 紅字答案、橫式、紙張。每個決定都記進 `notes`。
2. **參考圖片**：視覺模型只被問一小段 JSON（每串顆數與顏色、標題、金珠顏色），`refFromReply` 逐欄檢查（重複、超範圍、不合法的顏色都丟掉），`mergeRef` 才併進 spec；讀不出來就用預設並說明，不亂猜。走既有的 `_interpretImageWithVisionModel`（線上視覺模型→離線模型備援）。
3. **人工調整**：`applyEdits` 是封閉的動作集（`set_title／set_subtitle／set_counts／set_rows／set_color／set_base_color／set_answer／set_page／set_size／set_header／add_block／remove_block`），每個動作單獨驗證，壞的回 `rejected`（含原因），其他照做；不會改到傳入的 spec。

## CoLU
- **程式先讀**：弱模型或離線橋接不必自己組規格，`worksheet_from_request` 食譜（builtin）用 `parseRequest` 讀請求，最後一步交給呼叫端執行 `worksheet_make`（有附圖片就帶 `reference_file_id`）。
- **封閉題**：有歧義（沒說幾串）時，程式先用預設，同時回 `questions`（選項＋預設）；`resolveQuestions(res, pick)` 讓模型只選字母，選不出來、超範圍、丟錯都用預設。
- **看圖也是封閉格式**：只要一小段 JSON，不能自由發揮。
- **依任務補工具**：`FA_TASK_TOOL_HINTS` 的 `worksheet_make`（學習單／練習卷／串珠＋pdf／「10又幾」＋填…），根對話不必先委派也拿得到工具與做法提醒。
- 領域 `worksheet`：主功能 `worksheet_make`／`worksheet_adjust`，進階說明 `worksheet_topic(format|edits|reference|colors)`（按需查詢，不攤平進主工具說明）。

## PDF 的限制
中文字型（Noto Sans TC 子集）缺幾個全形標點，pdfmake 路線沿用既有的 `_faSanitizePdfText`（全形逗號、問號、括號等會變半形）；「｜」寫成 " | "。HTML／PNG 用系統字型，沒有這個限制。想要更好的標點，之後可以改嵌入完整字型。

## 測試
- `scripts/worksheet-tests/worksheet_core.test.js`（42 項）：讀請求（含使用者的真實說法）、驗證、排版（每顆珠子都畫到、不出頁面、列不重疊）、SVG／HTML／pdfmake 結構、教師版、其他區塊、參考圖片檢查、編輯動作、封閉題。
- `scripts/eval/worksheet.eval.js`（真實 Electron）：三個下載卡片（PNG／PDF／HTML）、PDF 檔頭與文字層、假視覺模型照照片給 9 串顏色、視覺模型壞掉或亂回仍能做、調整、壞輸入不丟例外、食譜（離線橋接）、依任務補工具、領域已註冊。
