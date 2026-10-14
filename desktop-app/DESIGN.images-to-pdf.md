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
