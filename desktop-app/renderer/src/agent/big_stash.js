// 大段內容暫存的策略（純函式，無 DOM；UMD）：記憶體先放、超過門檻就背景落盤、記憶體超過上限就只丟文字（記錄留在盤上，讀取時再取回）。
// 磁碟層是 chunk_store.js 的 store（沒有時就是純記憶體，行為與舊版一樣）。編號 bc_N 照舊從 1 往上數。
//   createBigStash({ disk, capBytes, spillChars, chunkChars, log }) → 暫存物件
//     add(text, label) → id（同步；必要時在背景落盤）
//     get(id) → 紀錄 { id, label, text|null, disk|null, recs?, recsMeta? }（同步；text 為 null 表示文字已釋放，要用 text() 取回）
//     text(id) → Promise<string|null>（記憶體有就直接回；否則從盤上逐塊取回，長度不對或讀不到就丟錯，不回殘缺內容）
//     has(id)、keys()、remove(id)、flush()（等所有進行中的落盤完成，給測試與關閉前用）
// 淘汰規則：超過 capBytes 時，(A) 先丟掉「已落盤」的文字；(B) 還沒落盤的排隊落盤；(C) 只有在沒有磁碟層、或落盤失敗時，才照舊刪最舊的一筆（留最新一筆）。
// spillChars、chunkChars 可以是數字或函式（函式每次呼叫時重新算，讓門檻跟著窗口大小走）。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaBigStash = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function num(v) { return typeof v === 'function' ? Number(v()) : Number(v); }

  function createBigStash(opts) {
    opts = opts || {};
    var disk = opts.disk && typeof opts.disk.put === 'function' && typeof opts.disk.get === 'function' ? opts.disk : null;
    var cap = num(opts.capBytes) > 0 ? num(opts.capBytes) : Infinity;
    var log = typeof opts.log === 'function' ? opts.log : function () {};
    var map = new Map(), seq = 0, bytes = 0, inflight = new Set();

    function spillAt() { var v = num(opts.spillChars); return v > 0 ? v : Infinity; }
    function chunkAt() { var v = num(opts.chunkChars); return v > 0 ? Math.floor(v) : 6000; }

    function drop(rec) {
      if (rec.recs) rec.recsMeta = { shape: rec.recs.shape, head: rec.recs.head, bad: rec.recs.bad, path: rec.recs.path };
      rec.recs = undefined;
      bytes -= rec.text.length; rec.text = null;
    }

    function spill(rec) {
      if (!disk || rec.disk || rec.spilling || rec.spillFailed || rec.text == null) return;
      rec.spilling = true;
      var text = rec.text;
      var p = Promise.resolve().then(function () { return disk.put('bc_' + rec.id, text, { chunkChars: chunkAt() }); }).then(function (r) {
        rec.spilling = false;
        if (r && r.ok && r.storage === 'disk') {
          if (map.get(rec.id) === rec) rec.disk = { id: r.id, chunks: r.chunks, total: r.total_chars };
          else disk.remove(r.id).catch(function () { /* 已經不在了 */ });
        } else { rec.spillFailed = true; log('大段暫存落盤失敗，留在記憶體：' + rec.id); }
        evict();
      }).catch(function (e) { rec.spilling = false; rec.spillFailed = true; log('大段暫存落盤出錯：' + rec.id + '：' + String((e && e.message) || e)); evict(); });
      inflight.add(p); p.then(function () { inflight.delete(p); }, function () { inflight.delete(p); });
    }

    function evict() {
      if (bytes <= cap) return;
      // (A) 已落盤的：只丟文字，記錄與盤上位置留著
      map.forEach(function (rec) { if (bytes > cap && rec.disk && rec.text != null) drop(rec); });
      if (bytes <= cap) return;
      // (B) 還沒落盤的：排隊落盤（落盤完成後會再進來淘汰）
      if (disk) map.forEach(function (rec) { if (rec.text != null && !rec.disk) spill(rec); });
      // (C) 沒有磁碟層，或這筆落盤失敗：照舊刪最舊的，留最新一筆；落盤中的不刪（等它完成）
      var ids = Array.from(map.keys());
      for (var i = 0; i < ids.length && bytes > cap && map.size > 1; i++) {
        var r = map.get(ids[i]); if (!r || r.disk || r.spilling) continue;
        if (disk && !r.spillFailed) continue;
        if (r.text != null) bytes -= r.text.length;
        map.delete(ids[i]);
      }
    }

    function add(text, label) {
      seq++;
      var id = 'bc_' + seq; var s = String(text == null ? '' : text);
      var rec = { id: id, label: label || '', text: s, at: Date.now(), disk: null, spilling: false, spillFailed: false, recs: undefined, recsMeta: null };
      map.set(id, rec); bytes += s.length;
      if (disk && s.length > spillAt()) spill(rec);
      evict();
      return id;
    }

    function get(id) { return map.get(String(id || '')) || null; }
    function has(id) { return map.has(String(id || '')); }
    function keys() { return map.keys(); }

    function remove(id) {
      var rec = map.get(String(id || '')); if (!rec) return false;
      map.delete(rec.id); if (rec.text != null) bytes -= rec.text.length;
      if (rec.disk && disk) disk.remove(rec.disk.id).catch(function () { /* */ });
      return true;
    }

    async function text(id) {
      var rec = map.get(String(id || '')); if (!rec) return null;
      if (rec.text != null) return rec.text;
      if (!rec.disk) throw new Error('暫存內容已不在記憶體，也沒有落盤');
      var out = '';
      for (var i = 0; i < rec.disk.chunks; i++) {
        var g = await disk.get(rec.disk.id, i);
        if (!g || !g.ok) throw new Error((g && g.error) || '磁碟暫存讀取失敗');
        out += g.text;
      }
      if (out.length !== rec.disk.total) throw new Error('磁碟暫存長度不對（應為 ' + rec.disk.total + ' 字，實際 ' + out.length + ' 字），不回傳殘缺內容');
      return out;
    }

    async function flush() { while (inflight.size) await Promise.all(Array.from(inflight)); }

    return { add: add, get: get, has: has, keys: keys, remove: remove, text: text, flush: flush, bytes: function () { return bytes; } };
  }

  return { createBigStash: createBigStash };
}));
