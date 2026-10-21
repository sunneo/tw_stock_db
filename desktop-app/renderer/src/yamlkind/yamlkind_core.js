/* YAML 用途標記（UMD，純函式）：我們的 YAML 檔太多用途（簡報、3D 場景、2D 動畫、檢視器…），在檔案的開頭（或結尾）放一行「合法的 YAML 註解」
 * 當宣告，像 bash 開頭的 #!/bin/sh：
 *     #!fa:deck            簡報（.deck.yaml）
 *     #!fa:scene3d         3D 場景（.3dscene.yaml）
 *     #!fa:anim2d          2D 動畫（.2danim.yaml）
 *     #!fa:viewerdoc       檢視器定義（.viewerdoc.yaml）
 * 可以帶版本：#!fa:deck v1。放結尾也行（最後一行非空白行）；開頭優先。因為是註解，所有 YAML 解析器（js-yaml、PyYAML…）都照常讀，內容與驗證完全不受影響。
 * 判斷用途的順序：標記 ＞ 檔名（.deck.yaml 等）＞ 內容特徵（保守，只在很明確時）；標記跟檔名／內容矛盾時回報，不默默照其中一個走。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaYamlKind = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var TYPES = {
    deck: { label: '動畫簡報', ext: '.deck.yaml', open: 'deck' },
    scene3d: { label: '3D 場景', ext: '.3dscene.yaml', open: 'scene3d' },
    anim2d: { label: '2D 動畫', ext: '.2danim.yaml', open: 'anim2d' },
    viewerdoc: { label: '檢視器定義', ext: '.viewerdoc.yaml', open: 'viewerdoc' },
  };
  // 開頭／結尾的標記行：#!fa:deck、#! fa:deck v1、# fa:deck（容許少數寫法差異）
  var MARK = /^\s*#!?\s*fa\s*[:=]\s*([A-Za-z][\w-]*)(?:\s+v?(\d+(?:\.\d+)*))?\s*$/;
  function lines(text) { return String(text == null ? '' : text).replace(/^﻿/, '').replace(/\r\n/g, '\n').split('\n'); }

  function marker(type, version) { return '#!fa:' + type + (version ? ' v' + version : ''); }

  // 開頭：前幾行裡只有註解、空行、--- 時才算「檔案開頭」；結尾：最後一個非空白行
  function findHead(ls) {
    for (var i = 0, seen = 0; i < ls.length && seen < 6; i++) {
      var t = ls[i].trim(); if (!t) continue; seen++;
      var m = MARK.exec(ls[i]); if (m) return { type: m[1].toLowerCase(), version: m[2] || null, line: i };
      if (t[0] !== '#' && t !== '---') return null;
    }
    return null;
  }
  function findTail(ls) {
    for (var i = ls.length - 1; i >= 0; i--) { if (!ls[i].trim()) continue; var m = MARK.exec(ls[i]); return m ? { type: m[1].toLowerCase(), version: m[2] || null, line: i } : null; }
    return null;
  }
  function byFilename(name) {
    name = String(name || '').toLowerCase().replace(/[?#].*$/, ''); if (!name) return null;
    for (var k in TYPES) if (name.slice(-TYPES[k].ext.length) === TYPES[k].ext) return k; return null;
  }
  // 內容特徵：只在很明確時才猜（簡報＝頂層有 deck 與 chapters；3D 場景＝頂層有 nodes；2D 動畫＝頂層 kind 是 ai_chat_animation_2d）
  function sniff(text) {
    var s = lines(text).filter(function (l) { return /^[A-Za-z_][\w-]*\s*:/.test(l); }).map(function (l) { return l.split(':')[0].trim(); });
    var has = function (k) { return s.indexOf(k) >= 0; };
    if (has('deck') && has('chapters')) return 'deck';
    if (/^kind\s*:\s*['"]?ai_chat_animation_2d/m.test(String(text))) return 'anim2d';
    if (has('nodes') && !has('chapters') && !has('shapes')) return 'scene3d';
    return null;
  }

  // → { type, version, where: 'head'|'tail'|'filename'|'content'|null, label, known, conflict: string|null, marker: {head, tail} }
  function detect(text, opts) {
    opts = opts || {}; var ls = lines(text), head = findHead(ls), tail = findTail(ls), fn = byFilename(opts.filename), content = opts.noSniff ? null : sniff(text);
    var type = null, where = null, version = null, conflict = null;
    if (head) { type = head.type; version = head.version; where = 'head'; }
    else if (tail) { type = tail.type; version = tail.version; where = 'tail'; }
    else if (fn) { type = fn; where = 'filename'; }
    else if (content) { type = content; where = 'content'; }
    if (head && tail && head.type !== tail.type) conflict = '開頭標記是「' + head.type + '」、結尾標記是「' + tail.type + '」，兩個不一樣';
    if (!conflict && (head || tail) && fn && fn !== type) conflict = '檔名（' + TYPES[fn].ext + '）看起來是「' + TYPES[fn].label + '」，但標記寫的是「' + type + '」';
    if (!conflict && (head || tail) && content && content !== type && TYPES[type]) conflict = '標記寫的是「' + (TYPES[type].label || type) + '」，但內容的結構像「' + TYPES[content].label + '」';
    return { type: type, version: version, where: where, known: !!(type && TYPES[type]), label: type ? (TYPES[type] ? TYPES[type].label : type) : null, conflict: conflict, filenameType: fn, contentType: content };
  }

  // 檢查「這份 YAML 是不是我要的用途」：標記明講是別的 → 不是；沒有標記就看檔名與內容；都看不出來 → 不擋（舊檔案沒有標記）
  function check(text, expected, opts) {
    var d = detect(text, opts), exp = TYPES[expected] ? TYPES[expected].label : expected;
    if (d.conflict) return { ok: false, detected: d, message: '這份 YAML 的用途標示不一致：' + d.conflict + '。要當「' + exp + '」用的話，請先改成一致（開頭放 ' + marker(expected) + '）。' };
    if (d.type && d.type !== expected && d.where !== 'content') return { ok: false, detected: d, message: '這份 YAML 標明（' + d.where + '）是「' + d.label + '」，不是「' + exp + '」。' + (TYPES[d.type] ? '請用' + TYPES[d.type].label + '的開法。' : '') };
    return { ok: true, detected: d, message: '' };
  }

  // 加上開頭標記（已經有同種標記就不動；有別種標記不默默改，回報 conflict）；結尾標記也一併認得，不重複加
  function stamp(text, type, opts) {
    opts = opts || {}; var t = String(text == null ? '' : text), d = detect(t, { noSniff: true });
    if (d.type === type && (d.where === 'head' || d.where === 'tail')) return { text: t, changed: false, conflict: null };
    if (d.type && d.type !== type && (d.where === 'head' || d.where === 'tail')) return { text: t, changed: false, conflict: '已經標明是「' + d.type + '」，不改成「' + type + '」' };
    var bom = t.charCodeAt(0) === 0xFEFF ? '﻿' : ''; if (bom) t = t.slice(1);
    return { text: bom + marker(type, opts.version) + '\n' + t, changed: true, conflict: null };
  }
  // 拿掉標記行（開頭與結尾各一行）
  function strip(text) {
    var ls = lines(text), h = findHead(ls); if (h) ls.splice(h.line, 1); var t = findTail(ls); if (t) ls.splice(t.line, 1); return ls.join('\n');
  }
  function types() { return Object.keys(TYPES).map(function (k) { return { type: k, label: TYPES[k].label, ext: TYPES[k].ext, marker: marker(k) }; }); }

  return { TYPES: TYPES, MARK: MARK, marker: marker, detect: detect, check: check, stamp: stamp, strip: strip, sniff: sniff, byFilename: byFilename, types: types };
});
