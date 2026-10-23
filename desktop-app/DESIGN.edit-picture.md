# `/edit-picture`:圖層式圖片編輯器(語言主導、像 GIMP 的後製與修復、可請生圖模型換風格)

> 2026-10-23。與 `/edit-svg`(DESIGN.edit-svg.md)同一套外框、物件模型、無邊界平面、AI 對話框,差別在:成品是**點陣圖**,偏向形狀加後製。**全部在 client 端**:濾鏡、修復、合成都在瀏覽器,「用 AI 重畫」走助理既有的生圖(`_generateImage`:線上 NVIDIA 或本機 SDXS,見 DESIGN.image-generation.md)。這是 Redmine 外掛版(`redmine_ai_chat/DESIGN.edit-picture.md`)的桌面版。

## 開法
`/edit-picture`(起手式 blank、poster)、`/edit-picture <一句話或網址>`;AI 工具 `edit_picture_open`(參數 starter／request／style／file_id／id;領域 `editors`;依任務補工具 `edit_picture_open`)。對話訊息 ```` ```fa-edit-picture {"id":…} ````;專案在 IndexedDB(`tw_edit`),圖片像素另存。

## 圖層(物件)型別(`edit_picture_core.js`,`FaEditPicture`)
- `image`(貼上、網址、找圖、生圖模型畫的;含 blend 混合模式、旋轉、翻轉、credit、prompt、seed)、`shape`、`svg`(同 /edit-svg,多了 blend)。
- `adjust`:**濾鏡層**,作用在下方全部或某個物件(`target`),可限區域、透明度;隱藏它圖就回到原樣。
- `heal`:**修復層**,`marks`(點／框／筆畫)標出的地方用周圍填補(`inpaint`)、`denoise`、`despeckle`。
- 動作:`edit_objects_core` 的封閉集合加 `transform_object`、`apply_style{style,strength,target}`、`add_heal{of,at,r,method}`(at:center／top／…／bottom-right,對圖片物件的框算位置);宿主執行的:`find_picture`、`generate_image`。
- 風格(`pic_fx.js`,`FaPicFx.STYLES`):oil、watercolor、sketch、ink、cartoon、pixel、poster、vintage、neon、emboss、halftone、dreamy、mono、warm、cool、night。濾鏡:oil、sketch、cartoon、watercolor、emboss、halftone、neon、denoise、despeckle、inpaint(遮罩),加既有的 `FaImgProc`(亮度／對比／飽和／模糊／銳化／黑白…共 28 種)。

## 語言怎麼變成動作(`FaEditHost._edAskPicture`)
1. 程式先讀得懂的(`parseCommands`):物件指令(改名／刪／隱藏／移動…)、調亮／對比／模糊／銳化等快速處理、位置與大小;**風格詞不在這裡處理**,交給宿主請視覺模型確認。(「調亮一點」這種帶尾巴的說法程式讀不懂,會走模型;「調亮」讀得懂。)
2. 貼進對話的圖 → 第一個圖層(畫布貼合它);網址／「找一張…」→ `FaPictureSource`;風格詞 → **restyle**;「用 AI 重畫」→ **repaint**;其餘交給 LLM 翻成封閉動作(`editPrompt`),程式驗證後套用。
3. **restyle**:程式加一個濾鏡層(強度 1)→ 把合成結果縮成 448 px 請視覺模型「Does this picture look like <風格 en>?」→ 說 yes 就停;不像就加強(1.8、2.8),最多三次;沒有視覺模型就只套用並註明沒確認。原圖永遠沒動。
4. **repaint**:視覺模型描述圖的內容 → 加上風格(使用者說的風格詞不會再重複進提示詞)→ `_generateImage` 畫**一張新圖**放在原圖旁邊,記下 prompt 與 seed;模型還沒下載就說「先輸入 /image download」。這是重畫,不是轉換,回答裡會明說。
5. 修復:說「修掉右下角的污點」→ 模型回 `add_heal`;或按「🩹 修復畫筆」直接在畫面上塗(一次塗抹 = 一個修復層)。

## 檢視器與外框
同 /edit-svg。合成(`FaEditPictureUI.render`)只畫看得見的區域:先畫圖層,遇到 adjust／heal 就對下方的合成結果套用;匯出 PNG／JPEG／專案 JSON,或把圖加上整理好的 prompt 放進對話。英文介面由 `edit_picture_i18n.js` 補字。

## 驗證與限制
- `node scripts/edit-tests/pic_fx.test.js`(28)、`edit_picture_core.test.js`(25)(在 `run-core-tests.js` 裡)。
- 真實 Electron(假的 LLM／VLM／生圖):`scripts/eval/edit.eval.js`——貼圖成第一層且畫布貼合、變成水彩(只一層濾鏡、視覺模型先說不像→加強→確認、原圖沒動、隱藏濾鏡畫面真的變回去)、說「修掉右下角的污點」(假模型回 add_heal)、AI 重畫(提示詞含視覺描述與風格、旁邊放新圖、seed)、匯出 PNG 與放進對話(含 prompt)、專案存起來後**從 IndexedDB 真的重新掛載一份**、斜線指令與工具。
- **沒驗證**:真實視覺模型判斷「像不像」的準確度與真實 LLM 翻譯品質;真實生圖(只用假的);WebGPU 路徑;大圖(>1600 px 會被縮小保存)的效能;修復畫筆的滑鼠操作(只在外掛版用 Playwright 驗證過)。濾鏡是傳統演算法,「水彩／油畫」是近似,不是生成式的風格轉換——要生成式的用 repaint。
