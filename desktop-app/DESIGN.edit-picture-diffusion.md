# `/edit-picture` 的擴散細化層（`detail`）：只重畫一小塊的細節，再羽化蓋回去（已實作，2026-10-26）

> 這份是**實作後**的樣子，以及規劃時沒料到的地方（規劃稿 `DESIGN.TODO.edit-picture-diffusion.md` 已刪，要看可從 git 歷史找）。

## 做了什麼
- **新的圖層型別 `detail`**（`edit_picture_core.js`）：`region`（框）或 `marks`（塗抹）、`target`、`prompt`、`strength`、`feather`、`context`、`model`（auto／online／local）、`seed`，生成後多 `crop`（裁片在世界座標的位置）、`result`（生出來的圖）、`refine`（edit／texture）、`state`（pending 待細化／preview 預覽中／applied 已接受）、`opacity`。跟修復層一樣是圖層：可以隱藏、刪除、調透明度、復原，**原圖不動**。
- **純函式 `pic_detail.js`**（`FaPicDetail`，Node 可測，27 項）：`plan`（裁哪裡：區域加四周多裁的脈絡、收進圖內、放大到模型邊長、羽化寬度）、`rectMask`／`softMask`（羽化遮罩）、`toneMatch`（色調對齊）、`composite`（蓋回去）、`detailTransfer`（只借細節）、`scale`、`regionOfMarks`。
- **合成**（`edit_picture_ui.js` 的 `render`）：把 `result` 縮到裁片大小，色調對齊到它下面的合成結果，用羽化遮罩只蓋區域。隱藏這一層畫面回到原樣。
- **UI**：工具列「✨ 擴散細化」（在畫面上拖出矩形）＋「啟用擴散編修」勾選（預設關；沒有生圖模型時按鈕灰掉並說明原因）；選到細化層時屬性面板有提示詞、強度、羽化、脈絡、模型、重畫（換 seed）、**接受／退回**；畫面上用綠色虛線框標出區域與狀態（待細化／預覽中／已細化）。
- **語言入口**：「把右下角的字細化」「讓招牌多一點細節」「refine / add more detail」→ 程式讀位置詞（左上、右下、上方、左邊…，沒說就是圖片中央）→ 加細化層並生成；沒啟用時只回答怎麼啟用；LLM 給的 `add_detail` 動作也會在回合結束時把待細化的層生成。「變成水彩風格」「調亮」「銳利一點」不會被當成細化。
- **宿主**（`edit_host.js` 的 `_edDetail`）：把細化層下面的圖層合成起來 → 依 `plan` 裁出一小塊（含脈絡）並放大 → 視覺模型描述這一小塊（有就用）→ 生圖 → 結果存進圖片庫 → 回傳要套用的屬性，由 UI 以 `update_object` 套用（所以復原／重做照常）。
- **設定**：`advancedSettings.editDiffusion`（預設 false；要加進設定的欄位白名單才存得住——評測抓到過一次它被丟掉）。

## 跟規劃不一樣的地方（重要）
- **本機 SDXS 做不了 img2img**：本機模型只有文字編碼器、UNet、VAE **解碼器**（`imagegen/local_sd.js` 的檔案清單），沒有 VAE 編碼器，而且一步取樣沒有可調的「強度」。所以規劃裡「SDXS 低強度 img2img 只補細節」**不可行**。
- 因此兩條路：
  1. **線上能改圖的模型**（`refine: edit`）：`nvidia_image.js` 新增 `black-forest-labs/flux.1-kontext-dev`（`edit: true`），請求多一個 `image`（data URL）與 `aspect_ratio: match_input_image`。把裁片放大後送出，依原圖補細節。**請求格式照 NVIDIA 的說明寫，沒有用真實金鑰送過。**
  2. **只有本機 SDXS**（`refine: texture`，實驗性）：用提示詞重畫一張，只借它的**高頻細節紋理**（`detailTransfer`）加到原圖上，原圖的結構與顏色不變。因為重畫出來的圖和原圖不是對齊的，效果因圖而異（樹葉、毛、牆面這類紋理比較合適，臉與文字可能會出現重影）；預覽、接受／退回就是為了這個。
- 改圖用的模型不出現在「預設模型」下拉選單（它不能純文字生圖）。

## 驗證
- Node：`scripts/edit-tests/pic_detail.test.js`（27）、`edit_picture_core.test.js`（detail 層與 `add_detail`、語言辨識，共 37）；`imagegen-tests/nvidia_image.test.js`。
- 真實 Electron（**生圖與視覺模型是假的**）：`scripts/eval/edit_detail.eval.js`（29 項）：合成（只蓋區域、邊緣沒有接縫、色調對到原圖附近、隱藏回到原樣、待細化不畫）、宿主（線上改圖送出的是含脈絡的裁片與 init_image、本機走紋理且不送圖、強制本機、沒有模型的說明、區域在圖外被拒）、語言入口、UI（框選 → 生成 → 預覽 → 接受 → 復原 → 取消勾選有存）。
- **沒驗證**：真實的 FLUX Kontext 改圖（請求格式與回應）、真實本機 SDXS 的紋理借用效果、真實視覺模型描述裁片的品質、大圖的效能（裁片本身是小的，但 `render` 會合成整張）。

## 還沒做
- 用語言指到物件（「臉」「招牌」）由視覺模型回傳框：目前只認位置詞與使用者框選。
- 區域重疊時的順序固定為圖層順序（後面的蓋掉前面的），沒有另外的衝突處理。
- 細化層的 `result` 是依生成當時下面的圖層算出來的；下面的圖層之後被改動，要按「重畫」。
