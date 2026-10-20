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

---

# 互動編輯器（對話裡的小工具）
`renderer/src/worksheet/worksheet_ui.js`（FaWorksheetUI）。worksheet_make 做完會在對話裡放一個編輯器（訊息裡是 ```` ```fa-worksheet {"id":…} ```` ），也可以用 `/worksheet [描述]`（不帶描述＝接著最近一份，沒有就開空白的）或 `worksheet_open` 工具放。

## 畫面
- **預覽**：SVG，點一下選取一串／一個區塊／標題（`hitTest` 用版面框找；選取框是虛線）。
- **🤖 AI 助手**：對話框＋快速句子＋📎附圖（也可以貼上、拖進來）。
- **⚙ 屬性**：標題、說明、紙張、抬頭欄位；每個區塊的欄位（串珠：每串金珠、金珠顏色、每一串的顆數與顏色、大小、答案；數一數、十格框、算式（重新出題）、數線、文字、空白）、上移／下移／刪除、新增區塊。
- **🕘 記錄**：每一步一行，點一步就回到那一步（之後的步驟留著，可以重做）。
- 工具列：↶ 復原、↷ 重做（Ctrl+Z／Ctrl+Y）、📝 摘要成 prompt、⬇ 匯出（PDF／PNG／HTML／JSON）、⛶ 放大。

## AI 對話（CoLU：程式先讀）
1. `parseEditRequest`：一句話切成小句，每一句各自用規則判斷（改某一串顏色、串數、答案、紙張、大小、標題、抬頭欄位、新增／刪區塊…），讀得懂的**不呼叫模型**（離線也能用）。
2. 讀不懂的句子才交給模型：`editPrompt` 只准它回 `{say, edits}`，`edits` 的動作必須在封閉清單裡（`parseEditsReply` 擋掉亂來的），最後都由 `applyEdits` 逐一驗證；離線時直接說「沒聽懂」並指到屬性面板。
3. 附圖：視覺模型只回一小段 JSON（每串顆數與顏色），`refFromReply` 檢查後 `mergeRef` 併進來；沒有串珠區塊就照圖新增一組。讀不出來會說明，不亂猜。
4. 一次說的話算一步：復原一次整句回去；每步有白話說明（`editWords`）。

## 進度保留（延續編輯）
編輯進度 `{v:2, spec, state:{ptr, states:[{spec,summary,text,kind}], log}}` 存成 `worksheet_<id>.json`（同一個 id 覆蓋同一個檔）；重新整理、換對話再回來、再開同一則訊息，都從存好的進度接著改（每一步、復原位置、對話紀錄都在）。畫面元件依 id 快取，重畫對話不會丟掉編輯中的狀態。從對話用 `worksheet_adjust` 改的，會變成同一個 id 的新一步（已開著的編輯器就地更新，沒開著的接在存好的進度後面），所以對話與編輯器永遠是同一份。

## 摘要成 prompt
`specToPrompt(spec, 編輯步驟)`：程式組出一段可以重用的描述——紙張、標題、說明、每個區塊（串珠：base、每串顆數、金珠與每串顏色、答案線）、再列「編輯過程（依序）」。可以複製、「↻ 用這段重新生成」（交給 worksheet_make 做一份新的）、「✨ 請 AI 潤飾」（線上才有，只整理文字、保留所有數字與顏色）。沒有模型也能摘要。

## 測試
- `worksheet_core.test.js`（55 項）新增：讀編輯指令（逐句、讀不懂的留下）、模型回覆只留封閉動作、`set_block`／`move_block`、`hitTest`、選取框、摘要 prompt、`mergeRef` 新增區塊。
- `scripts/eval/worksheet-editor.eval.js`（真實 Electron）：訊息放編輯器、點選、屬性面板、對話（程式讀＝0 次模型呼叫；讀不懂＝1 次，亂動作被擋；回壞資料不變）、復原／重做、附圖（視覺模型回 JSON／壞掉）、記錄、摘要、四種匯出、模擬重新整理後從存檔接著編輯、`worksheet_adjust` 同步更新、`worksheet_open`。
