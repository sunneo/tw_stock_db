// 子對話交接內文（純函式，不碰 DOM、不做 I/O、不呼叫模型）。
// 偵測到新話題、開出子對話時，用這裡的結果：子對話標題，以及一段交接 system 訊息。
// 交接只放「從哪個父對話分出來」與舊話題最近幾則使用者訊息的短摘錄，不載入整段歷史。
//
// 所有數字都是上限，超過就截斷：
//   TITLE_MAX      子對話標題（含省略號）最多幾個字
//   PARENT_MAX     父對話標題在交接內文裡最多幾個字
//   EXCERPT_MAX    每則摘錄最多幾個字
//   EXCERPT_COUNT  最多摘錄幾則舊話題的使用者訊息（取最近的）
//   TOTAL_MAX      交接內文總長上限（字）
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { root.AiChatHandoff = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TITLE_MAX = 20;
  var PARENT_MAX = 30;
  var EXCERPT_MAX = 80;
  var EXCERPT_COUNT = 3;
  var TOTAL_MAX = 600;
  var DEFAULT_TITLE = '新對話';

  // 把任意文字壓成單行：換行、tab、連續空白都收成一個空白，前後去掉
  function oneLine(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  // 依「字元」（code point）截斷，不切斷字；超過就在結尾加省略號，總長不超過 max
  function clip(s, max) {
    var chars = Array.from(s);
    if (chars.length <= max) return s;
    if (max <= 1) return chars.slice(0, Math.max(0, max)).join('');
    return chars.slice(0, max - 1).join('') + '…';
  }

  // 子對話標題：新訊息前 TITLE_MAX 字（去掉換行與多餘空白）；空的話用預設名稱
  function titleOf(newText) {
    var t = oneLine(newText);
    return t ? clip(t, TITLE_MAX) : DEFAULT_TITLE;
  }

  // 舊話題最近幾則使用者訊息（只取 role === 'user' 且內容為字串的）
  function recentUserTexts(oldTopicMessages) {
    var list = Array.isArray(oldTopicMessages) ? oldTopicMessages : [];
    var texts = [];
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (!m || m.role !== 'user' || typeof m.content !== 'string') continue;
      var t = oneLine(m.content);
      if (t) texts.push(t);
    }
    return texts.slice(-EXCERPT_COUNT);
  }

  // 交接內文：第一行說明來源，之後是舊話題的摘錄（沒有舊話題就只有第一行）
  function handoffText(parentTitle, oldTopicMessages) {
    var parent = clip(oneLine(parentTitle) || '（未命名對話）', PARENT_MAX);
    var lines = ['這個子對話是從〈' + parent + '〉分出來的。'];
    var excerpts = recentUserTexts(oldTopicMessages);
    if (excerpts.length) {
      lines.push('前一個話題裡使用者最近說過：');
      for (var i = 0; i < excerpts.length; i++) {
        lines.push('・' + clip(excerpts[i], EXCERPT_MAX));
      }
    }
    lines.push('請只針對下面的新問題回答；需要舊話題的細節時再問使用者。');
    return clip(lines.join('\n'), TOTAL_MAX);
  }

  // 對外入口：回傳 { title, handoff }。newText 是觸發轉移的那則使用者訊息。
  function buildHandoff(parentTitle, oldTopicMessages, newText) {
    return {
      title: titleOf(newText),
      handoff: handoffText(parentTitle, oldTopicMessages),
    };
  }

  return {
    buildHandoff: buildHandoff,
    titleOf: titleOf,
    TITLE_MAX: TITLE_MAX,
    PARENT_MAX: PARENT_MAX,
    EXCERPT_MAX: EXCERPT_MAX,
    EXCERPT_COUNT: EXCERPT_COUNT,
    TOTAL_MAX: TOTAL_MAX,
  };
}));
