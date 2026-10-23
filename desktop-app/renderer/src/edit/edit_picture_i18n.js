// English for the picture editor (/edit-picture): the texts the editor shows; the shared ones are in edit_shell/edit_i18n.js. Loaded after it; FaEditI18n.localize(el) does the rest.
(function (root, I18N, FX) {
  'use strict';
  if (!I18N) { return; }
  var EN = {
    '🎨 圖片編輯器': '🎨 Picture editor', '🧩 圖層資料': '🧩 Layer data',
    '用說的修：「把它變成水彩風格」「調亮一點」「修掉右下角的污點」「在左邊加一隻貓」「找一張飛機的照片」；也可以貼圖進來、給網址': 'Talk to edit: "make it watercolor", "a bit brighter", "remove the speck at the bottom right", "add a cat on the left", "find a photo of an airplane"; or paste a picture or give an address',
    '我是用語言主導的概念畫家，也有像 GIMP 的後製：你說要畫什麼、放在哪裡，或要怎麼修，我就加一個新的圖層（圖片、形狀、濾鏡、修復都是圖層），原圖不動，隨時可以隱藏、調整、復原。畫面沒有邊界，可以加在任何地方；中間的畫面可以拖曳、縮放，⌖ 回到第一個圖層（圖片）的中間。「把這張圖變成油畫／水彩／素描／卡通…」會加一個風格濾鏡，並請視覺模型看過、不像就加強；說「用 AI 重畫成…」則用生圖模型（線上或本機，同 /image）依這張圖的內容重新畫一張。「修復畫筆」可以在畫面上塗出要修的地方。可以貼圖、給網址、或說「找一張…的圖」。': 'I am a concept painter led by language, with GIMP-like after-work: say what to draw, where, or how to fix it, and I add a new layer (pictures, shapes, filters and repairs are all layers); the original is untouched and you can hide, adjust or undo any time. The plane has no boundary: add anywhere; drag and zoom the view, ⌖ goes back to the middle of the first layer (the picture). "Make it an oil painting / watercolor / sketch / cartoon…" adds a style filter and asks the vision model whether it looks like it, a stronger one if not; "repaint it as…" paints a new picture of what is in it with the image model (online or local, as in /image). The "repair brush" paints the places to fix. Paste a picture, give an address, or say "find a picture of …".',
    'AI 畫的': 'Painted by the AI', '圖片・': 'Picture · ', '圖片': 'Picture', 'PNG 圖片': 'PNG picture', 'JPEG 圖片': 'JPEG picture', '專案（JSON）': 'Project (JSON)', '合成中…': 'Compositing…',
    '補畫修復標記': 'Add repair marks', '修復': 'Repair', '用畫筆標出要修復的地方': 'Mark the places to repair with the brush', '移動 ': 'Move ', '🩹 修復畫筆': '🩹 Repair brush',
    '畫筆大小（畫面上的單位）': 'Brush size (units on the plane)', '在畫面上塗出要修復的地方（會變成一個修復圖層）': 'Paint the places to repair (it becomes a repair layer)', '套用風格…': 'Apply a style…', '套用風格「': 'Applied the style "', '改 ': 'Change ',
    '畫布（裁切與輸出的範圍框，不是邊界）': 'Canvas (the frame that is cropped and exported, not a boundary)', '畫布 ': 'Canvas ', '背景 ': 'Background ', '畫布貼合內容': 'Canvas fitted to the content',
    '對整張圖：': 'For the whole picture: ', '自動對比': 'Auto contrast', '去雜訊': 'Denoise', '去污點': 'Remove specks', '銳化': 'Sharpen', '混合': 'Blend', '水平翻轉': 'Flip horizontally', '垂直翻轉': 'Flip vertically',
    '出處：': 'Source: ', '提示詞：': 'Prompt: ', '對這張圖：': 'For this picture: ', '🩹 修復這張圖的中央': '🩹 Repair the middle of this picture', '修復 ': 'Repair ', '強度': 'Strength', '整張圖': 'The whole picture', '作用在': 'Acts on', ' 作用在 ': ' acts on ',
    '刪掉 ': 'Deleted ', ' 拿掉 ': ' removed ', '亮度': 'Brightness', '對比': 'Contrast', '飽和度': 'Saturation', '模糊': 'Blur', '黑白': 'Black and white', '油畫': 'Oil painting', '水彩': 'Watercolor', '素描': 'Sketch', '卡通': 'Cartoon', '降噪': 'Denoise',
    '數值': 'Value', '＋ 加一個處理': '+ Add a process', ' 加 ': ' add ', '方法': 'Method', '補洞（從周圍填入）': 'Fill the hole (from around it)', '半徑': 'Radius', '標記 ': 'Marks ', ' 處（用「🩹 修復畫筆」可以再塗）': ' places (use the "🩹 repair brush" to paint more)', '清除標記': 'Clear the marks',
    '所有圖層與它們的設定（唯讀）。圖片的像素另外存在這個瀏覽器裡，這裡只有代號。': 'All layers and their settings (read only). The pixels of the pictures are kept apart in this browser; only a reference is here.'
  };
  root.FaEditPictureI18n = true;
  if (FX && FX.STYLES) { Object.keys(FX.STYLES).forEach(function (k) { var st = FX.STYLES[k]; if (st.label && !EN[st.label]) { EN[st.label] = String(st.en || k).replace(/^(an?|the) /, ''); } }); }
  EN['⬇ 下載 JPEG 圖片'] = '⬇ Download JPEG picture'; EN['💬 放進對話 JPEG 圖片'] = '💬 Put the JPEG picture into the conversation';
  I18N.extend(EN, [
    [/^套用風格「(.+)」$/, 'Applied the style "$1"'], [/^修復 (.*)$/, 'Repair $1'], [/^標記 (\d+) 處.*$/, '$1 marks (use the "🩹 repair brush" to paint more)'], [/^移動 (.*)$/, 'Move $1'], [/^畫布 (.+)$/, 'Canvas $1'], [/^修復（(.+)）$/, 'Repair ($1)'], [/^(.+?)；(.+)$/, '$1; $2'], [/^(.+?)\u3000— (.+)$/, '$1 — $2']
  ]);
})(typeof self !== 'undefined' ? self : this, (typeof self !== 'undefined' && self.FaEditI18n) || (typeof FaEditI18n !== 'undefined' ? FaEditI18n : undefined), (typeof self !== 'undefined' && self.FaPicFx) || (typeof FaPicFx !== 'undefined' ? FaPicFx : undefined));
