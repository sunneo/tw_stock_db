/* 發音字典與行內讀法（UMD，純函式；桌面版與網頁版共用）。測試 scripts/tts-tests/pronunciation.test.js。
 * 起因：中文的破音字語音引擎會唸錯（「長高高」唸成「常高高」）。字幕要寫對的字，念出來的要換成同音的字（長(zhǎng) → 掌）：
 *   ① 簡報旁白裡的行內寫法 {長|掌}：字幕顯示「長」、念「掌」（簡報核心自己也有同一個規則，見 deck_core.js 的 pronInline）；
 *   ② 發音字典（設定 ttsPronunciations，指令 /tts-pronounce）：念之前把詞換成讀法，所有語音引擎、所有朗讀（含簡報）都適用；字幕與原文不變。
 * 讀法就是「換成另一個（同音的）字」，所以不管引擎是 Kokoro、Edge 還是複製引擎都有效，不用引擎懂拼音。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaTtsPron = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var LIM = { entries: 200, phrase: 20, reading: 40 };
  function clean(s, n) { return String(s == null ? '' : s).replace(/[\r\n\t{}|]+/g, ' ').trim().slice(0, n); }
  // 設定值 → { 詞: 讀法 }：物件或 [[詞, 讀法]…]；不合格的丟掉；詞與讀法相同的沒有意義也丟掉
  function normalize(raw) {
    var out = {}, n = 0, pairs = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? Object.keys(raw).map(function (k) { return [k, raw[k]]; }) : []);
    pairs.forEach(function (p) { if (!p || n >= LIM.entries) return; var k = clean(p[0], LIM.phrase), v = clean(p[1], LIM.reading); if (!k || !v || k === v || out[k] !== undefined) return; out[k] = v; n++; });
    return out;
  }
  function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  // 一次掃過把詞換成讀法（長的詞先比對；換出來的字不會再被換一次）
  function applyDict(text, dict) {
    var keys = Object.keys(dict || {}); if (!keys.length) return String(text == null ? '' : text);
    keys.sort(function (a, b) { return b.length - a.length; }); var re = new RegExp(keys.map(esc).join('|'), 'g');
    return String(text == null ? '' : text).replace(re, function (m) { return dict[m]; });
  }
  // 行內寫法 {顯示|讀法} → { shown, spoken, changed }
  var INLINE = /\{([^{}|\n]{1,24})\|([^{}|\n]{1,24})\}/g;
  function inline(text) {
    var s = String(text == null ? '' : text), changed = false;
    var shown = s.replace(INLINE, function (_m, a) { changed = true; return a; }), spoken = s.replace(INLINE, function (_m, _a, b) { return b; });
    return { shown: shown, spoken: spoken, changed: changed };
  }
  // /tts-pronounce 的參數：空或 list → 列出；delete 詞 → 刪；詞=讀法（也可以 → -> 或空白隔開）→ 加
  function parseCommand(args) {
    var a = String(args == null ? '' : args).trim(); if (!a || /^(list|ls|列出)$/i.test(a)) return { action: 'list' };
    var del = /^(?:delete|del|rm|remove|刪除|刪)\s+(.+)$/i.exec(a); if (del) return { action: 'delete', phrase: clean(del[1], LIM.phrase) };
    var m = /^(.+?)\s*(?:=|→|->|＝)\s*(.+)$/.exec(a) || /^(\S+)\s+(\S+)$/.exec(a);
    if (m) { var k = clean(m[1], LIM.phrase), v = clean(m[2], LIM.reading); if (k && v && k !== v) return { action: 'add', phrase: k, reading: v }; return { action: 'error', error: '詞與讀法不能相同，也不能是空的' }; }
    return { action: 'error', error: '用法：/tts-pronounce 詞=讀法（加）、/tts-pronounce delete 詞（刪）、/tts-pronounce（列出）' };
  }
  return { LIM: LIM, normalize: normalize, applyDict: applyDict, inline: inline, parseCommand: parseCommand };
});
