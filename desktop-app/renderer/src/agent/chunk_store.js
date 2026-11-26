// 大段文字暫存（純函式，無 DOM；UMD）。網頁內文太大時，不再整份留在記憶體，而是一塊一行 JSONL 寫到磁碟。
// I/O 由呼叫端注入（backend），沒有注入或寫入失敗時退回記憶體，行為與舊版相同。
//   createStore({ backend, chunkChars, maxTotalChars }) → store
//     backend（可省略）：{ append(name, text) → Promise<{start}>, readRange(name, start, bytes) → Promise<string>, remove(name) → Promise }
//     store.put(url, text, { chunkChars?, maxTotalChars? }) → Promise<{ ok, id, chunks, total_chars, kept_chars, truncated, dropped_chars, storage, fallback? }>
//     store.get(id, i) → Promise<{ ok, text, url, i, chunks, total_chars, storage }> 或 { ok:false, error }
//     store.remove(id) → Promise<{ ok }>；store.has(id) → boolean；store.stats() → { entries, memChunks, diskEntries, notes }
// 每行一筆 JSON：{"url":網址,"i":區塊序號,"off":文字起點字元偏移,"len":字數,"text":文字}
// 切分：沿換行切（不盲切）；單行超過預算才硬切並避開代理字元。依序接起來一定等於原文（逐字相等）。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaChunkStore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var seq = 0;
  var BATCH_BYTES = 4 * 1024 * 1024; // 每次寫入約 4 MB，避免單次 IPC 過大

  // UTF-8 位元組數（不用 Buffer，讓這個模組在瀏覽器與 Node 都能跑）
  function utf8Len(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }

  // 沿換行切成區塊；一段超過預算才硬切。依序接起來＝原文。
  function splitText(text, budget) {
    var out = [], pos = 0, n = text.length;
    while (pos < n) {
      var end = Math.min(n, pos + budget);
      if (end < n) {
        var nl = text.lastIndexOf('\n', end - 1);
        if (nl >= pos + Math.floor(budget / 2)) end = nl + 1;
        else {
          var c = text.charCodeAt(end - 1);
          if (c >= 0xD800 && c <= 0xDBFF && end - pos > 1) end--;
        }
      }
      out.push(text.slice(pos, end));
      pos = end;
    }
    return out;
  }

  function createStore(opts) {
    opts = opts || {};
    var backend = opts.backend && typeof opts.backend.append === 'function' && typeof opts.backend.readRange === 'function' ? opts.backend : null;
    var defaultChunk = Number(opts.chunkChars) > 0 ? Math.floor(Number(opts.chunkChars)) : 6000;
    var maxTotal = Number(opts.maxTotalChars) > 0 ? Math.floor(Number(opts.maxTotalChars)) : 0; // 0＝不設上限
    var entries = Object.create(null); // id → { url, storage, file, chunks:[{start,bytes,chars,off}]|null, mem:[text]|null, total }
    var notes = [];

    function newId() { seq++; return 'ck_' + Date.now().toString(36) + '_' + seq; }

    // 寫到磁碟，回傳每一行的位元組起點與長度；任何失敗回傳 null（呼叫端改用記憶體）
    async function writeDisk(file, lines) {
      if (!backend) return null;
      try {
        var starts = [], lens = [], i = 0;
        while (i < lines.length) {
          var batch = [], size = 0, j = i;
          while (j < lines.length && (batch.length === 0 || size + utf8Len(lines[j]) + 1 <= BATCH_BYTES)) {
            var b = utf8Len(lines[j]) + 1;
            batch.push(lines[j]); lens.push(b); size += b; j++;
          }
          var r = await backend.append(file, batch.join('\n') + '\n');
          var base = r && r.start != null ? Number(r.start) : null;
          if (base == null || !isFinite(base)) throw new Error('寫入沒有回傳位置');
          for (var k = 0; k < batch.length; k++) { starts.push(base); base += lens[i + k]; }
          i = j;
        }
        return { starts: starts, lens: lens };
      } catch (e) {
        notes.push('磁碟寫入失敗，改用記憶體：' + String((e && e.message) || e));
        return null;
      }
    }

    async function put(url, text, o) {
      o = o || {};
      var src = String(text == null ? '' : text);
      var cap = Number(o.maxTotalChars) > 0 ? Math.floor(Number(o.maxTotalChars)) : maxTotal;
      var kept = src, dropped = 0;
      if (cap > 0 && src.length > cap) { kept = src.slice(0, cap); dropped = src.length - cap; }
      var budget = Number(o.chunkChars) > 0 ? Math.floor(Number(o.chunkChars)) : defaultChunk;
      var parts = splitText(kept, Math.max(1, budget));
      var id = newId(), u = String(url || '');
      var offs = [], acc = 0;
      for (var q = 0; q < parts.length; q++) { offs.push(acc); acc += parts[q].length; }
      var lines = parts.map(function (t, i) { return JSON.stringify({ url: u, i: i, off: offs[i], len: t.length, text: t }); });
      var file = 'stage-' + id + '.jsonl';
      var disk = await writeDisk(file, lines);
      var ent;
      if (disk) {
        ent = { url: u, storage: 'disk', file: file, mem: null, total: kept.length,
          chunks: parts.map(function (t, i) { return { start: disk.starts[i], bytes: disk.lens[i], chars: t.length, off: offs[i] }; }) };
      } else {
        ent = { url: u, storage: 'memory', file: null, chunks: null, mem: parts.slice(), total: kept.length };
      }
      entries[id] = ent;
      return {
        ok: true, id: id, chunks: parts.length, total_chars: src.length, kept_chars: kept.length,
        truncated: dropped > 0, dropped_chars: dropped, storage: ent.storage,
        fallback: ent.storage === 'memory' && notes.length ? notes[notes.length - 1] : undefined
      };
    }

    async function get(id, i) {
      var ent = entries[id];
      if (!ent) return { ok: false, error: '找不到暫存 ' + id + '：暫存只在這次執行中有效，重新載入頁面或超過保存時間後會消失，請重新讀取網頁。' };
      var idx = Number(i) | 0;
      var n = ent.mem ? ent.mem.length : ent.chunks.length;
      if (idx < 0 || idx >= n) return { ok: false, error: '區塊序號超出範圍：' + idx + '（共 ' + n + ' 塊）' };
      if (ent.mem) return { ok: true, text: ent.mem[idx], url: ent.url, i: idx, chunks: n, total_chars: ent.total, storage: 'memory' };
      var c = ent.chunks[idx];
      try {
        var line = await backend.readRange(ent.file, c.start, c.bytes);
        var rec = JSON.parse(String(line).replace(/\n$/, ''));
        if (typeof rec.text !== 'string') throw new Error('區塊格式不對');
        return { ok: true, text: rec.text, url: rec.url, i: idx, chunks: n, total_chars: ent.total, storage: 'disk' };
      } catch (e) {
        return { ok: false, error: '磁碟暫存讀取失敗（' + ent.file + ' 第 ' + idx + ' 塊）：' + String((e && e.message) || e) };
      }
    }

    async function remove(id) {
      var ent = entries[id];
      if (!ent) return { ok: true, already: true };
      delete entries[id];
      if (ent.file && backend && typeof backend.remove === 'function') { try { await backend.remove(ent.file); } catch (_) { /* 檔案已不在就算了 */ } }
      return { ok: true };
    }

    function has(id) { return !!entries[id]; }
    function stats() {
      var ids = Object.keys(entries), mem = 0, disk = 0;
      ids.forEach(function (k) { if (entries[k].mem) mem += entries[k].mem.length; else disk++; });
      return { entries: ids.length, memChunks: mem, diskEntries: disk, notes: notes.slice(-5) };
    }
    return { put: put, get: get, remove: remove, has: has, stats: stats };
  }

  return { createStore: createStore, splitText: splitText, utf8Len: utf8Len };
}));
