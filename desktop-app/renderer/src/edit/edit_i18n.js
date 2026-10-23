// English for the screens of /edit-svg and /edit-picture (the shared frame and the two editors). The source strings are Traditional Chinese; on a page whose language is not zh* they are shown in
// English: FaEditI18n.localize(el) translates every text node, title, placeholder and aria-label under el now and whenever the editor changes them. Texts with numbers or names in them are matched
// by RULES; a text with no entry stays as it is. <html lang> decides (window.FaUiLocale.locale = 'zh' | 'en' overrides it); the user's own texts (object names, code) are never touched.
//   FaEditI18n.extend(EN, RULES)   FaEditI18n.localize(el)   FaEditI18n.tr(text)
(function (root, factory) { var api = factory(root); if (typeof module !== 'undefined' && module.exports) { module.exports = api; } else { (typeof self !== 'undefined' ? self : root).FaEditI18n = api; } })(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';
  var EN = {
    '↶ 復原': '↶ Undo', '↷ 重做': '↷ Redo', '📝 整理成 prompt': '📝 Make a prompt', '📤 輸出…': '📤 Export…', '📋 複製': '📋 Copy', '✓ 已複製': '✓ Copied', '✨ 請 AI 潤飾': '✨ Ask the AI to polish it', '潤飾中…': 'Polishing…',
    '只收沒被復原、而且真的改變了成品的那幾輪對話；可以貼到別處重現': 'Only the steps that were not undone and really changed the result; paste it elsewhere to rebuild it',
    '🗂 物件': '🗂 Objects', '（還沒有物件：對 AI 說要加什麼，或從上面的起手式開始）': '(no objects yet: tell the AI what to add)', '顯示／隱藏': 'Show / hide', '鎖定／解鎖': 'Lock / unlock', '往上一層': 'Up one layer', '往下一層': 'Down one layer', '複製': 'Duplicate', '刪除': 'Delete',
    '🤖 AI 助手': '🤖 AI assistant', '🕘 記錄': '🕘 History', '送出': 'Send', '附圖（也可以直接貼上、拖進來）': 'Attach a picture (or paste / drop it)', '點一步就回到那一步（之後的步驟還在，可以重做）：': 'Click a step to go back to it (later steps stay and can be redone):', '（沒有說明）': '(no description)', '開始': 'Start',
    '這樣已經是目前的樣子了。': 'It already looks like that.', '改好了：': 'Done:', '這次沒有改成：': 'Nothing was changed:', '這次沒成功：': 'That did not work: ', '（附圖）': '(picture)', '產生中…': 'Making it…', '已放進對話': 'Put into the conversation', '已匯出': 'Exported',
    '⬇ 下載 PNG 圖片': '⬇ Download PNG picture', '💬 放進對話 PNG 圖片': '💬 Put the PNG picture into the conversation', '⬇ 下載 SVG 檔': '⬇ Download SVG file', '💬 放進對話 SVG 檔': '💬 Put the SVG file into the conversation', '⬇ 下載 專案（JSON）': '⬇ Download project (JSON)',
    '🖍 SVG 編輯器': '🖍 SVG editor', '🖼 畫面': '🖼 Canvas', '🧩 原始碼': '🧩 Source', '▶ 套用原始碼': '▶ Apply the source', '↻ 重新產生': '↻ Regenerate', '沒有改動': 'No changes', '已套用': 'Applied',
    '整張圖的 SVG。改完按「套用原始碼」：最上層的每個元素會變成一個物件（名字從 data-name／id 來；用形狀工具畫的形狀會變成「圖形」物件）。': 'The whole drawing as one SVG. Press "Apply the source": every top-level element becomes an object (names come from data-name / id; shapes become "drawing" objects).',
    '畫布（匯出的範圍框，不是邊界）': 'Canvas (the frame that is exported, not a boundary)', '寬': 'Width', '高': 'Height', '背景': 'Background', '貼合內容': 'Fit to the content', '填色': 'Fill', '邊框': 'Stroke', '邊框粗細': 'Stroke width', '文字': 'Text', '字級': 'Font size', '邊數': 'Sides', '圓角': 'Corner', '旋轉': 'Rotate', '透明度': 'Opacity', '縮放': 'Scale',
    'SVG 內容（改完離開輸入框就會套用）': 'SVG content (applied when you leave the box)', '✨ 把這張圖變成 SVG': '✨ Turn this picture into SVG',
    '用說的畫：「在中間畫一個紅色的圓」「在太陽的右邊加一朵雲」「把煙囪放到房子上面」「找一張飛機的照片」；也可以貼一張圖進來，我試著把它變成 SVG（向量圖）': 'Draw by talking: "a red circle in the middle", "a cloud to the right of the sun", "put the chimney above the house", "find a photo of an airplane"; or paste a picture and I will try to turn it into SVG (a vector drawing)',
    '我是用語言來畫的概念畫家：你說要畫什麼、放在哪個東西的哪一邊，我就加一個新的物件（形狀、手繪的圖、網路上找的圖片都是物件），可以隨時隱藏、改名、鎖定、移動或刪掉，改錯了按「復原」。畫面沒有邊界，可以加在任何地方；中間的畫面可以拖曳、縮放，⌖ 回到第一個物件（圖片）的中間。貼一張圖進來，我會試著把它變成 SVG：先用程式描出每個顏色的輪廓，再用視覺模型看過、比對，不夠像就重來。也可以直接給網址，或說「找一張…的圖」。':
      'I am a concept painter led by language: say what to draw and where, relative to which object, and I add a new object (shapes, drawings and pictures found on the web are all objects) that you can hide, rename, lock, move or delete any time; if I got it wrong press Undo. There is no boundary: add anything anywhere; drag and zoom the middle view, ⌖ goes back to the middle of the first object (the picture). Paste a picture and I try to turn it into SVG: the program traces the outline of every colour, the vision model looks at it and compares, and it starts again if it is not close enough. You can also give an address, or say "find a picture of …".'
  };
  var RULES = [
    [/^第 (\d+)／(\d+) 步$/, 'Step $1 of $2'], [/^🗂 物件（(\d+)）$/, '🗂 Objects ($1)'], [/^新增物件「(.*)」$/, 'Added the object "$1"'], [/^新增物件「(.*)」（(.*)）$/, 'Added the object "$1" ($2)'], [/^刪掉物件 (.+)$/, 'Deleted the object $1'], [/^(.+) 改名為 (.+)$/, 'Renamed $1 to $2'],
    [/^隱藏 (.+)$/, 'Hid $1'], [/^顯示 (.+)$/, 'Showed $1'], [/^鎖定 (.+)$/, 'Locked $1'], [/^解鎖 (.+)$/, 'Unlocked $1'], [/^複製 (.+)$/, 'Duplicated $1'], [/^(.+) 往上一層$/, '$1 up one layer'], [/^(.+) 往下一層$/, '$1 down one layer'], [/^移動 (.+)$/, 'Moved $1'], [/^改 (.+)$/, 'Changed $1'],
    [/^畫布貼合內容$/, 'Canvas fitted to the content'], [/^標題改成「(.*)」$/, 'Title changed to "$1"'], [/^清空所有物件$/, 'Cleared all objects'], [/^放置物件 (.+)$/, 'Placed $1'], [/^移動物件 (.+?)（(.+)）$/, 'Moved the object $1 ($2)'], [/^變形物件 (.+)$/, 'Transformed $1'], [/^修改圖形 (.+)$/, 'Changed the drawing $1'], [/^修改物件 (.+)$/, 'Changed the object $1'],
    [/^(.+) 的右邊$/, 'right of $1'], [/^(.+) 的左邊$/, 'left of $1'], [/^(.+) 的上面$/, 'above $1'], [/^(.+) 的下面$/, 'below $1'], [/^(.+) 的裡面$/, 'inside $1'], [/^(.+) 的中央$/, 'the centre of $1'],
    [/^改寫原始碼（(\d+) 個物件）$/, 'Rewrote the source ($1 objects)'], [/^把「(.+)」描成 SVG$/, 'Traced "$1" into SVG'], [/^✗ (.+)：(.*)$/, '✗ $1: $2'], [/^✓ (.+)$/, '✓ $1'],
    [/^(\d+)\. (.*)$/, '$1. $2'], [/^畫布 (.+)=(.+)$/, 'Canvas $1 = $2'], [/^背景 (.+)$/, 'Background $1'], [/^出處：(.*)$/, 'Source: $1']
  ];
  function isZh() { if (root.FaUiLocale && root.FaUiLocale.locale) { return /^zh/i.test(root.FaUiLocale.locale); } var l = (root.document && root.document.documentElement && root.document.documentElement.lang) || ''; return !l || /^zh/i.test(l); }
  function extend(en, rules) { Object.keys(en || {}).forEach(function (k) { EN[k] = en[k]; }); (rules || []).forEach(function (r) { RULES.push(r); }); }
  function tr(s) {
    var m = /^(\s*)([\s\S]*?)(\s*)$/.exec(String(s)), core = m[2]; if (!core || !/[　-鿿＀-￯]/.test(core)) { return s; }
    var out = EN[core];
    if (out === undefined) { for (var i = 0; i < RULES.length; i++) { var r = RULES[i][0].exec(core); if (r) { out = core.replace(RULES[i][0], RULES[i][1].replace(/\$(\d)/g, function (_, n) { return tr(r[+n] === undefined ? '' : r[+n]); })); break; } } }
    return out === undefined ? s : m[1] + out + m[3];
  }
  var ATTRS = ['title', 'placeholder', 'aria-label'];
  function walk(node) {
    if (node.nodeType === 3) { var t = tr(node.nodeValue); if (t !== node.nodeValue) { node.nodeValue = t; } return; }
    if (node.nodeType !== 1) { return; }
    if (/^(script|style|svg|iframe)$/i.test(node.tagName)) { return; }   // the picture itself is the user's; the object names are in <span class="nm"> and are translated only when they match a text of the program
    ATTRS.forEach(function (a) { if (node.hasAttribute && node.hasAttribute(a)) { var v = node.getAttribute(a), t = tr(v); if (t !== v) { node.setAttribute(a, t); } } });
    if (node.tagName === 'TEXTAREA' || node.tagName === 'INPUT') { return; }
    for (var c = node.firstChild; c; c = c.nextSibling) { walk(c); }
  }
  function localize(el) {
    if (!el || isZh()) { return el; } walk(el);
    if (typeof MutationObserver === 'function' && !el._i18n) { el._i18n = new MutationObserver(function (list) { list.forEach(function (m) { if (m.type === 'childList') { Array.prototype.forEach.call(m.addedNodes, walk); } else { walk(m.target); } }); }); el._i18n.observe(el, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS }); }
    return el;
  }
  return { localize: localize, tr: tr, extend: extend, EN: EN, isZh: isZh };
});
