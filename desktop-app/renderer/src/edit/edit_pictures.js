// The pictures of the web and of the chat for BOTH picture editors (/edit-svg, /edit-picture): keep a picture for the project, read an address, find a picture ("find a picture of an airplane"), say "another one".
// It does not know what an editor makes of a picture: the editor passes `C` (its document core: validate / applyEdits / bounds) and gets back edits (add_object image ... with the licence and the
// address kept as the credit). Sources and rules: picture_source.js (Wikimedia Commons, then Openverse; the browser first, the server relay when the site does not allow it).
//   var P = FaEditPictures.make({ C, store, ai:{ have(), chat(system,user,o) }, T, relayUrl, ask? })
//   P.keep(blob) -> { ref, mime, w, h, dataUrl }        P.decode(blob, maxSide)        P.addImageEdits(spec, kept, name, credit) -> edits (the first object of an empty document sets the frame)
//   P.fromText({ text, spec, editorId, status, onBlob? }) -> Promise<{ edits, notes, say, handled }>      addresses in the text, "find …", "another one"; onBlob(blob, name, credit) may take over a picture (e.g. to trace it)
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaEditPictures = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  function make(cfg) {
    var C = cfg.C, store = cfg.store, ai = cfg.ai || { have: function () { return false; } }, T = cfg.T || function (a, b) { return a; }, lastFound = {};
    function PS() { var M = cfg.PS || (typeof FaPictureSource !== 'undefined' ? FaPictureSource : (typeof self !== 'undefined' ? self : window).FaPictureSource); return M.make({ relayUrl: cfg.relayUrl, fetch: cfg.fetch, timeoutMs: 20000 }); }
    function canvasBlob(cv, type, q) { return new Promise(function (res) { cv.toBlob(res, type || 'image/png', q); }); }
    async function decode(blob, maxSide) {
      if (cfg.maxPx) { try { maxSide = Math.min(maxSide, Number(cfg.maxPx()) || maxSide); } catch (e) { /* 沒有環境資訊就照原來的 */ } }   // 環境檔位：手機圖最大邊 1024
      var bmp = await createImageBitmap(blob), s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height)), w = Math.max(1, Math.round(bmp.width * s)), h = Math.max(1, Math.round(bmp.height * s));
      var cv = document.createElement('canvas'); cv.width = w; cv.height = h; var g = cv.getContext('2d', { willReadFrequently: true }); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(bmp, 0, 0, w, h);
      var id = g.getImageData(0, 0, w, h); return { width: w, height: h, data: id.data, canvas: cv, natural: { w: bmp.width, h: bmp.height } };
    }
    // kept for the project: at most 1600 px on the longest side (a photo of 6000 px is not kept as it is)
    async function keep(blob) {
      var d = await decode(blob, 1600), kept = blob;
      if (d.natural.w > 1600 || d.natural.h > 1600 || blob.size > 1500000) { kept = await canvasBlob(d.canvas, /png/.test(blob.type) && blob.size < 3e6 ? 'image/png' : 'image/jpeg', 0.88); }
      var ref = await store.putImage(kept); return { ref: ref, mime: kept.type || 'image/png', w: d.width, h: d.height, dataUrl: store.imageUrl(ref) };
    }
    function placementFor(spec) { var b = C.bounds(spec); return b ? { x: Math.round(b.x + b.w + 60), y: Math.round(b.y), empty: false } : { x: 0, y: 0, empty: true }; }
    function addImageEdits(spec, k, name, credit) {
      var maxW = 480, sc = Math.min(1, maxW / k.w), p = placementFor(spec), edits = [], obj = { type: 'image', name: name, ref: k.ref, mime: k.mime, x: p.x, y: p.y, w: Math.round(k.w * sc), h: Math.round(k.h * sc), credit: credit || '' };
      if (p.empty) { var sc2 = Math.min(1, 900 / Math.max(k.w, k.h)); obj.w = Math.round(k.w * sc2); obj.h = Math.round(k.h * sc2); edits.push({ op: 'set_canvas', x: 0, y: 0, w: obj.w, h: obj.h }); edits.push({ op: 'add_object', object: obj }); }
      else { edits.push({ op: 'add_object', object: obj, place: { of: 'view', rel: 'center' } }); }
      return edits;
    }
    async function searchQuery(text) {
      var q = String(text || '').replace(/^(?:請|麻煩|幫我|可以)?\s*(?:上網|到網路上|在網路上)?\s*(?:幫我)?\s*(?:找|搜尋|搜|尋找|find|search(?: for)?)\s*(?:一|幾|兩)?\s*(?:張|些|個|a|an|some|the)?\s*/i, '').replace(/\s*(?:的)?\s*(?:圖片|圖|照片|相片|picture|photo|image)s?\s*(?:來|吧|給我)?[。.!！]*$/i, '').trim();
      q = q.replace(/^(?:of|for)\s+/i, '').trim() || String(text || '').trim();
      if (/[一-鿿]/.test(q) && ai.have()) { try { var en = (await ai.chat('Give 1 to 3 English keywords for searching a photo of this on Wikimedia Commons. Answer with the keywords only, separated by spaces.', q, { maxTokens: 40, timeoutMs: 30000 })).replace(/[^A-Za-z0-9 \-]/g, ' ').replace(/\s+/g, ' ').trim(); if (en) { return { shown: q, query: en }; } } catch (e) { /* the words as they are */ } }
      return { shown: q, query: q };
    }
    function creditOf(r) { return r.title + (r.creator ? ' — ' + r.creator : '') + (r.license ? ' — ' + r.license : '') + ' (' + r.source + ') ' + (r.page || ''); }
    // returns { handled, edits, notes, say }: handled = this module did something with the text (so the language step is for what is left)
    async function fromText(req) {
      var text = String(req.text || '').trim(), spec = req.spec, status = req.status || function () {}, id = req.editorId, notes = [], edits = [], say = '', ps = PS(), handled = false;
      var next = function () { return C.applyEdits(spec, edits).spec; };
      var urls = ps.urls(text).slice(0, 3);
      for (var u = 0; u < urls.length; u++) {
        handled = true;
        try {
          status(T('下載圖片：', 'Downloading the picture: ') + urls[u].slice(0, 60)); var got = await ps.load(urls[u]), nm = urls[u].split('/').pop().split('?')[0].replace(/\.[a-z0-9]+$/i, '') || 'picture';
          if (req.onBlob && await req.onBlob(got.blob, nm, urls[u], edits, next())) { /* taken over */ }
          else { var k = await keep(got.blob); addImageEdits(next(), k, nm, urls[u]).forEach(function (e) { edits.push(e); }); }
          notes.push(T('（' + (got.via === 'server' ? '經伺服器中繼' : '瀏覽器直接') + '下載）', '(' + (got.via === 'server' ? 'through the server relay' : 'straight by the browser') + ')')); say = say || T('把網址的圖片放進來了。', 'Added the picture from the address.');
        } catch (e) { notes.push(T('抓不到 ', 'could not get ') + urls[u].slice(0, 50) + '：' + String((e && e.message) || e).slice(0, 80)); }
      }
      var again = /^(?:換一張|換一個|再找一張|別的|另一張|another(?: one)?|next(?: one)?)/i.test(text), find = /(找|搜尋|搜|尋找|find|search).*(圖|照片|picture|photo|image)/i.test(text) && !urls.length;
      if (again && lastFound[id] && lastFound[id].results.length > lastFound[id].idx + 1) {
        handled = true; var lf = lastFound[id]; lf.idx++; var r = lf.results[lf.idx];
        try {
          status(T('換一張：', 'Another: ') + r.title.slice(0, 40)); var g2 = await ps.load(r), k3 = await keep(g2.blob), prev = spec.objects.filter(function (o) { return o.type === 'image' && o.ref === lf.ref; })[0];
          if (prev) { var sc = Math.min(prev.w / k3.w, prev.h / k3.h); edits.push({ op: 'remove_object', id: prev.id }); edits.push({ op: 'add_object', object: { type: 'image', name: lf.shown, ref: k3.ref, mime: k3.mime, x: prev.x, y: prev.y, w: Math.round(k3.w * sc), h: Math.round(k3.h * sc), credit: creditOf(r) } }); }
          else { addImageEdits(spec, k3, lf.shown, creditOf(r)).forEach(function (e) { edits.push(e); }); }
          lf.ref = k3.ref; say = T('換了一張（' + (lf.idx + 1) + '／' + lf.results.length + '）：' + r.title.slice(0, 40), 'Another one (' + (lf.idx + 1) + ' of ' + lf.results.length + '): ' + r.title.slice(0, 40));
        } catch (e) { notes.push(T('換圖失敗：', 'could not change it: ') + String((e && e.message) || e).slice(0, 80)); }
      } else if (find) {
        handled = true; var qq = await searchQuery(text); status(T('上網找圖：', 'Searching for pictures: ') + qq.query); var sr = await ps.search(qq.query, { limit: 6 });
        if (!sr.ok) { notes.push(sr.error); say = say || T('找不到圖。', 'No picture was found.'); }
        else {
          var top = sr.results[0];
          try {
            var g3 = await ps.load(top), k4 = await keep(g3.blob);
            lastFound[id] = { query: qq.query, shown: qq.shown, results: sr.results, idx: 0, ref: k4.ref };
            addImageEdits(next(), k4, qq.shown, creditOf(top)).forEach(function (e) { edits.push(e); });
            say = T('找到「' + top.title.slice(0, 40) + '」（' + top.source + '，' + (top.license || '授權未標示') + '）；還有 ' + (sr.results.length - 1) + ' 張候選，說「換一張」可以換。', 'Found "' + top.title.slice(0, 40) + '" (' + top.source + ', ' + (top.license || 'no licence given') + '); ' + (sr.results.length - 1) + ' more candidates: say "another one".');
          } catch (e) { notes.push(T('下載找到的圖失敗：', 'could not download it: ') + String((e && e.message) || e).slice(0, 80)); }
        }
      }
      return { handled: handled, edits: edits, notes: notes, say: say };
    }
    return { keep: keep, decode: decode, addImageEdits: addImageEdits, placementFor: placementFor, fromText: fromText, canvasBlob: canvasBlob, _lastFound: lastFound };
  }
  return { make: make };
});
