# 圖片轉 PDF（images_to_pdf）：指定順序、縮放／旋轉、影像處理（2026-10-14）

## 起因（真實對話）
使用者附 12 張手機照片（檔名 `1_…` 到 `12_…`），要求「等比例縮放、Zoom、置中，每張縮到 A4，再合併成一個 PDF」。根模型直接把任務 `delegate_to_subagent(domain:"code_execution")` 丟給沙盒，子 agent 在 Pyodide 裡找不到 Pillow／img2pdf、`micropip` 也 import 不了，用了 40 個回合試著安裝、改走 `run_command`（Windows 沒有 convert／magick）、FAP 複製…最後「子任務用完了 40 個回合」，一張圖都沒轉。而 `images_to_pdf` 早就存在（只會一張一頁、`fit`／`a4`／`letter`、沒有縮放旋轉處理、不管順序、JPEG 的 EXIF 方向被忽略），只是這個領域沒有它。

## 做了什麼
- **工具**：`images_to_pdf` 重寫（`_imagesToPdfAdvanced`）。來源：`files`／`pages`（每頁一個物件，順序＝頁序）／`folder`（`fap:名稱/路徑` 或桌面版絕對路徑，依檔名**自然排序**，`pattern` 篩選）；沒給＝對話附件，依檔名數字順序（`1_ 2_ … 10_`，不是上傳順序）。頁面：`page_size`（fit／a3／a4／a5／a6／b4／b5／letter／legal／tabloid／"210x297mm"）、`orientation`、`fit`（contain＝Zoom 置中、cover、stretch、actual）、`zoom`、`margin`、`background`、`dpi`。輸出：`filename`、`output_path`（FAP 或絕對路徑；不給＝下載附件）。
- **處理 ops**（`renderer/src/imgproc/imgproc_core.js`，純 JS、有單元測試，不用 canvas filter）：灰階、亮度／對比／飽和度／gamma、自動對比、**影像強化**（自動對比＋銳化＋飽和度）、**色調強化**（自動白平衡＋對比＋飽和度＋色溫）、**減少色彩**（中位切割，可抖色）、色階分離、二值化（Otsu）、反相、**高斯模糊**（三次方框模糊逼近，半徑再大也 O(1)/像素）、銳化、**馬賽克**（可只蓋一個區域）、旋轉（任意角度，直角精確）、縮放（面積平均／雙線性）、裁切、翻轉。名稱接受中文與英文別名，也接受 `"灰階"`、`{rotate:90}` 這類縮寫。**整串先驗證（名稱、範圍、必填），有錯一次講完、整份不做**。
- **EXIF 方向**：解碼走 `createImageBitmap`，手機照片不會橫倒（舊版直接嵌 JPEG 位元組，會）。`/media-image-to-pdf` 也改走這條。
- **放進領域**：辦公室報告（桌面）、通用繪圖、**程式執行環境**（那次事故的現場：提示詞明說「圖片轉 PDF 不要在沙盒裡寫 Python」）、影音處理與檔案解讀（原本就有，提示詞更新）。領域標籤也寫進「圖片轉 PDF」，根模型選領域時看得到。

## 驗證
- `imgproc_core.test.js`（23 項，進 run-core-tests）：每個操作的方向與邊界（常數圖模糊不變、點光源模糊後總亮度守恆、馬賽克格內單色且為平均、減色最多 N 色、Otsu、旋轉 90／180／270 精確與任意角度、縮放面積平均、裁切翻轉、操作名稱別名與縮寫、錯誤訊息、頁面排版的每種 fit、2000×1500 做三個操作 < 4 秒）。
- `scripts/eval/images-to-pdf.eval.js`（真實 Electron）：5 張合成圖（亂序檔名）排成自然順序、A4 直式／橫式隨圖片、`orientation:portrait` 強制、`pages` 逐頁旋轉／處理的回報、錯誤訊息、資料夾＋`output_path` 絕對路徑存檔（PDF 開頭 `%PDF-`）、EXIF 方向 6 → 尺寸對調、模型呼叫的那一層（工具 callback）。另用 `pdftoppm` 目視確認一頁（A5 橫式、2:1 圖片 contain 置中、減色生效）。

## 沒做／限制
- 沒有用真實模型測過「模型會不會在對的時候呼叫它、參數填得對不對」：這靠提示詞與工具描述，要使用者實測回報再調。
- 一頁一張圖（沒有拼貼多張到同一頁）；沒有頁碼／浮水印。
- 單張處理前上限約 6000 萬像素（超過先縮小並在 `warnings` 說明）；一次最多 500 頁。
- 網頁版沒有 `desktopAPI.rawfs`：絕對路徑與資料夾只在桌面版，網頁版用附件或 `fap:`。

## 後續修正（同日）
- **cover 真的裁切**：以前用 PDF 剪裁路徑隱藏超出的部分（檔案裡還有完整圖片、各閱讀器／印表機行為不一）。現在 `layoutPage` 回傳 `crop`（來源像素的矩形，置中），超出頁面可繪區域的部分直接從圖片裁掉再嵌進 PDF——檔案小、行為一致。實測 300×200 → A4 直式 cover 輸出 141×200（A4 比例）。
- **沙盒 `import micropip`／`import PIL`／`import numpy` 以前一律失敗**（那次對話的另一半事故）：Pyodide 的 `runPythonAsync` 不會自動載入套件（micropip 本身也是要 `loadPackage` 的套件），而 `python_execute` 的說明一直寫「micropip.install 或直接 import numpy／pandas 會自動載入」。`_runPyodideScriptAsync` 在執行前改成先 `loadPackagesFromImports(腳本)`（載入失敗不擋腳本）。實測：`micropip 0.11.1`、`PIL 12.2.0`、`numpy 2.4.6` 都 import 得到；`micropip.install("fpdf2")` 成功（PyPI 的純 Python 套件可以裝）；`img2pdf` 依賴 `pikepdf` 沒有 wasm 版，裝不起來（工具說明已寫明，並指向 `images_to_pdf`／`PIL Image.save(…,"PDF")`）。回歸檢查：`scripts/eval/python-autoload.eval.js`。

## 圖片格式：用內容判斷，副檔名不重要（同日）
- 來源檔先讀開頭幾個位元組（`_imgPdfSniff`）：JPEG／PNG／GIF／WebP／BMP／ICO／TIFF／AVIF／HEIC／SVG；PDF 會明說「是 PDF 不是圖片（用 merge_pdfs）」。沒有副檔名、`.dat`、`.jfif` 裡其實是 PNG、`.png` 裡其實是 JPEG 都可以。
- 解碼：Chromium 認得的（jpeg／png／gif／webp／bmp／ico／avif／svg）走 `createImageBitmap`（套用 EXIF 方向）；**TIFF** 用 UTIF（＋pako 解壓）、**HEIC／HEIF** 用 heic2any（內含 libheif），這兩個備援解碼器第一次用才從 jsDelivr 下載（要網路一次）。多頁 TIFF 目前只用第一頁，並在 `warnings` 說明。
- tga／psd／raw／pnm 等不支援，錯誤訊息直接列出支援的格式並建議先轉成 jpg 或 png。
- `folder` 沒給 `pattern` 時只收看起來像圖片的副檔名（png／apng／jpg／jpeg／jfif／jpe／pjpeg／pjp／webp／gif／bmp／dib／ico／svg／tif／tiff／avif／heic／heif）；給了 `pattern`（例如 `"*"`）就全收、用內容判斷，認不得的用 `on_error:"skip"` 略過。
- 全域的附件分類（縮圖、`interpret_image` 等）只多認了瀏覽器解得開的別名（jfif／jpe／pjpeg／pjp／apng／dib）；tif／heic 要明講檔名（`files`／`pages`／`folder`）才會被這個工具處理——不加進全域分類，避免它們被當成可顯示的縮圖或送給視覺模型而壞掉。
- 驗證：`scripts/eval/images-formats.eval.js`（真實 Electron，內嵌 160×100 的 jpg／jfif（內容是 PNG）／tiff／gif／webp／avif／heic／無副檔名／亂副檔名／`.png` 裡是 JPEG，全部 160×100 轉成功；tga 與文字檔有清楚的錯誤）。

## 為什麼模型還是自己寫 python？——RAG 記憶汙染＋工具沒被看到（同日，使用者提供 RAG 匯出）
- 第二份對話（更新後）根模型仍把「資料夾圖片轉PDF」委派給 `desktop_ops`，任務文字寫「使用 img2pdf」。RAG 匯出（64 筆）裡有 **15 筆**關於這件事的「技能／偏好」（`pref_image_batch_a4_pdf*`、`skill_image_*`、`skill_pdf_merge_*`…），內容全是 Pillow＋img2pdf／ImageMagick／reportlab 的腳本，而且最後一筆（`…landscape_fit_height_center_width_crop`，19:33:59 剛寫入）把「短邊填滿、長邊裁切」記成標準做法——跟使用者這次說的「等比例縮放、置中、看要不要橫向」（contain）相反。這是 **Hermes 自動演化把失敗／不合意圖的腳本做法存成技能，下一輪又被「歷史記憶喚醒」餵回去**的自我強化迴圈。
- **注意**：舊使用者的設定沒有 `ragEnabled` 欄位時，遷移邏輯是 `raw.ragEnabled !== false`＝**開**（新使用者才是預設關）；而且喚醒訊息是在下一輪開頭被清掉的，所以匯出的對話看不到它。
- 修法（三層）：① **依任務文字補專用工具**（`FA_TASK_TOOL_HINTS`／`_faTaskToolHints`）：不管根模型挑哪個領域，只要任務是「圖片→PDF」或「docx／xlsx／文字檔／圖片合併成PDF」，這次執行就多拿到 `images_to_pdf`／`merge_pdfs`，並附上專用的做法提醒（忽略任務裡指定的 img2pdf／Pillow）；根層級也一樣（`_getRootToolNames` 補工具、系統提示加提醒），所以根模型可以直接呼叫、不用先委派。反方向（PDF→圖片、從 PDF 抽圖、拆分）不命中。② **RAG 喚醒時略過「自己寫腳本」的舊記憶**：這則訊息有專用工具時，內容含 img2pdf／Pillow／ImageMagick／reportlab／PyPDF2／fitz 的節點不再注入（日誌會寫略過幾個；注入的節點 id 也記進日誌與訊息的 `_ragNodeIds`）。③ **Hermes 反思不把這類需求的腳本做法記成技能**。
- 已存在的 15 筆汙染記憶：另存了一份清掉它們的匯出檔（`/tmp/rag-records.cleaned.json`，64→49 筆，依賴關係也一併拿掉），由使用者決定要不要匯入或在 RAG 知識庫頁手動刪。
- 驗證：`scripts/task-tool-hints.test.js`（正反例）、`scripts/eval/images-to-pdf-routing.eval.js`（根層級命中／不命中、四個不同領域的委派都拿到工具與提醒、反方向不補）。

## 合併文件成 PDF：`merge_pdfs`／`/office-pdf-merge` 支援各種格式（同日）
- 輸入可以混在一起：**PDF**（複製頁面，文字仍可選取）、**圖片**（jpg／png／gif／webp／bmp／avif／tiff／heic／svg…，走 images_to_pdf 同一套：A4 等比置中、EXIF 方向）、**文字檔**（txt／md／csv／log／json／程式碼…；UTF-8／UTF-16／Big5／GBK 自動判斷，排版後用 canvas 畫成頁面，中文用系統字型）、**docx／xlsx／pptx／doc／xls／rtf／odt**。種類用檔案內容判斷，副檔名不重要。
- docx／xlsx 等怎麼轉：桌面版優先用 **Word／Excel／PowerPoint**（Windows，PowerShell COM）→ **LibreOffice**（`soffice --headless --convert-to pdf`，各平台）→ 都沒有時 docx／xlsx 退回**簡化版**（`renderer/src/docmerge/docmerge_core.js`：自己讀 zip、解 docx／xlsx 的 XML，保留標題、段落、清單、表格、工作表儲存格內容（日期序號轉日期），不保留圖片、圖表、字型、顏色；warnings 會明說）；pptx／doc／xls／rtf／odt 沒有備援，明說需要 Office。`office_engine`：auto／office／libreoffice／simple。轉換前用 `desktopAPI.exec.run`，所以受「允許 AI 執行程式」設定與確認框管制（每個 Office 檔跳一次確認）。
- 來源：`files`（照順序）／`folder`（`fap:` 或絕對路徑，檔名自然排序，`pattern` 篩選）／預設＝對話附件；`output_path` 存檔；`on_error:skip`；文字頁最多 400 頁。`/office-pdf-merge` 不給參數＝這次附加的全部檔案（依附加順序），單一個 docx 也能轉成 PDF。
- 驗證：`docmerge_core.test.js`（7 項，含 pandoc／soffice 產生的 docx／xlsx 實檔）、`scripts/eval/merge-docs.eval.js`（真實 Electron：簡化版 7 頁、壞檔明說是哪一個、指定順序＋存檔、**LibreOffice 轉 docx／xlsx 成功**、沒有副檔名的 docx）；目視確認文字檔、docx（標題、清單、表格）、xlsx 表格的頁面。
- **沒有驗證**：Windows 的 Word／Excel／PowerPoint COM 路徑（這台是 Linux，只測了 LibreOffice）；簡化版的 docx 不處理巢狀表格、文字方塊、頁首頁尾；xlsx 簡化版只轉儲存格的值（不跑公式、不顯示格式化後的數字，除了日期）。
