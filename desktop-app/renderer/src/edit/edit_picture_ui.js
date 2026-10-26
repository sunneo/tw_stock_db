// The screen of /edit-picture, built on the shared frame (edit_shell.js). The middle viewer is an endless plane (edit_viewport.js): the layers are put together into ONE picture (the compositor below:
// pictures, shapes and drawings are drawn in order; a filter layer changes what is under it; a repair layer fills the marked spots from what is around them) and only the part in view is shown.
// The pixels of the pictures are never changed: filter and repair layers are replayed from the document, so hiding one brings the picture back.
//   FaEditPictureUI.mount({ id, state, spec, host, container, restoring, store }) -> element (el._ed)      FaEditPictureUI.render(spec, opts) -> Promise<{ canvas, region, scale }>
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaEditPictureUI = factory((root.FaEditPicture || (typeof FaEditPicture !== 'undefined' ? FaEditPicture : undefined)), (root.FaEditSvg || (typeof FaEditSvg !== 'undefined' ? FaEditSvg : undefined)), (root.FaEditShell || (typeof FaEditShell !== 'undefined' ? FaEditShell : undefined)), (root.FaEditViewport || (typeof FaEditViewport !== 'undefined' ? FaEditViewport : undefined)), (root.FaPicFx || (typeof FaPicFx !== 'undefined' ? FaPicFx : undefined)), (root.FaImgProc || (typeof FaImgProc !== 'undefined' ? FaImgProc : undefined)), (root.FaPicDetail || (typeof FaPicDetail !== 'undefined' ? FaPicDetail : undefined))); })(typeof self !== 'undefined' ? self : this, function (C, SV, Shell, VP, F, IP, PD) {
  'use strict';
  function h(tag, cls, text) { var e = document.createElement(tag); if (cls) { e.className = cls; } if (text != null) { e.textContent = text; } return e; }
  var ICON = { image: '🖼', svg: '🖍', adjust: '✨', heal: '🩹', detail: '🔍' }, SHAPE_ICON = { rect: '▭', ellipse: '⬭', line: '╱', arrow: '➜', triangle: '△', polygon: '⬡', star: '★', path: '✎', text: 'T' };
  var BLEND = { normal: 'source-over' };
  function slug(s) { return String(s || 'picture').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50) || 'picture'; }

  // ───────────────────────── the compositor ─────────────────────────
  var bmpCache = {}, vecCache = {};
  function bitmapOf(store, ref) {
    if (bmpCache[ref]) { return bmpCache[ref]; }
    bmpCache[ref] = store.getImage(ref).then(function (b) { return b ? createImageBitmap(b) : null; });
    return bmpCache[ref];
  }
  function vectorBitmap(o, scale, resolve) {
    var b = C.types[o.type].bbox(o), m = Math.max(8, (o.sw || 0) * 2 + (o.rotate ? Math.max(b.w, b.h) * 0.5 : 0)), x = b.x - m, y = b.y - m, w = b.w + 2 * m, h = b.h + 2 * m, key = JSON.stringify([o, scale]);
    if (vecCache[key]) { return vecCache[key].then(function (img) { return { img: img, x: x, y: y, w: w, h: h }; }); }
    var pw = Math.max(1, Math.min(4096, Math.round(w * scale))), ph = Math.max(1, Math.min(4096, Math.round(h * scale)));
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + x + ' ' + y + ' ' + w + ' ' + h + '" width="' + pw + '" height="' + ph + '">' + SV.objectMarkup(Object.assign({}, o, { visible: true }), resolve) + '</svg>';
    var keys = Object.keys(vecCache); if (keys.length > 60) { delete vecCache[keys[0]]; }
    vecCache[key] = new Promise(function (res, rej) { var url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })), img = new Image(); img.onload = function () { URL.revokeObjectURL(url); res(img); }; img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('could not draw the shape "' + o.name + '"')); }; img.src = url; });
    return vecCache[key].then(function (img) { return { img: img, x: x, y: y, w: w, h: h }; });
  }
  // the area of the document and the scale it is drawn at (at most 4096 px on a side and 16 million pixels: a larger plane is drawn smaller, never refused)
  function docRegion(spec, frameOnly, maxSide) {
    var c = spec.canvas, r = { x: c.x, y: c.y, w: c.w, h: c.h };
    if (!frameOnly) { spec.objects.forEach(function (o) { if (!o.visible || (o.type !== 'image' && o.type !== 'shape' && o.type !== 'svg')) { return; } var b = C.types[o.type].bbox(o); if (!b) { return; } var x0 = Math.min(r.x, b.x), y0 = Math.min(r.y, b.y), x1 = Math.max(r.x + r.w, b.x + b.w), y1 = Math.max(r.y + r.h, b.y + b.h); r = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }; }); }
    var ms = maxSide || 4096, sc = Math.min(1, ms / Math.max(r.w, r.h), Math.sqrt(16e6 / (r.w * r.h))); return { region: r, scale: sc };
  }
  async function render(spec, opts) {
    opts = opts || {}; var store = opts.store, resolve = opts.resolve || function () { return ''; }, dr = docRegion(spec, !!opts.frameOnly, opts.maxSide), region = dr.region, sc = dr.scale;
    var W = Math.max(1, Math.round(region.w * sc)), H = Math.max(1, Math.round(region.h * sc)), cv = document.createElement('canvas'); cv.width = W; cv.height = H; var ctx = cv.getContext('2d', { willReadFrequently: true });
    var c = spec.canvas; if (c.bg && c.bg !== 'transparent') { ctx.fillStyle = c.bg; ctx.fillRect((c.x - region.x) * sc, (c.y - region.y) * sc, c.w * sc, c.h * sc); }
    function px(wx, wy) { return [(wx - region.x) * sc, (wy - region.y) * sc]; }
    for (var i = 0; i < spec.objects.length; i++) {
      var o = spec.objects[i]; if (!o.visible) { continue; }
      if (opts.isCancelled && opts.isCancelled()) { return null; }
      if (o.type === 'image') {
        var bmp = await bitmapOf(store, o.ref); if (!bmp) { continue; }
        var p = px(o.x + o.w / 2, o.y + o.h / 2); ctx.save(); ctx.globalAlpha = o.opacity; ctx.globalCompositeOperation = BLEND[o.blend] || o.blend || 'source-over'; ctx.translate(p[0], p[1]); if (o.rotate) { ctx.rotate(o.rotate * Math.PI / 180); } ctx.scale(o.flipX ? -1 : 1, o.flipY ? -1 : 1);
        ctx.imageSmoothingQuality = 'high'; ctx.drawImage(bmp, -o.w * sc / 2, -o.h * sc / 2, o.w * sc, o.h * sc); ctx.restore();
      } else if (o.type === 'shape' || o.type === 'svg') {
        var vb = await vectorBitmap(o, sc, resolve), q = px(vb.x, vb.y); ctx.save(); ctx.globalCompositeOperation = BLEND[o.blend] || o.blend || 'source-over'; ctx.drawImage(vb.img, q[0], q[1], vb.w * sc, vb.h * sc); ctx.restore();
      } else if (o.type === 'detail') {
        // 擴散細化層:把生出來的圖(result)蓋回它下面的合成結果——只蓋 region(或標記)那一塊,邊緣羽化,蓋之前把色調對齊。下面的圖不動,隱藏這層就回到原樣
        if (!o.result || !o.crop) { continue; }
        var gb = await bitmapOf(store, o.result); if (!gb) { continue; }
        var cb = o.crop, ca = px(cb.x, cb.y), dx = Math.round(ca[0]), dy = Math.round(ca[1]), dw = Math.round(cb.w * sc), dh = Math.round(cb.h * sc); if (dx < 0 || dy < 0 || dx + dw > W || dy + dh > H || dw < 2 || dh < 2) { continue; }
        var baseI = ctx.getImageData(dx, dy, dw, dh), tmp = document.createElement('canvas'); tmp.width = dw; tmp.height = dh; var tg = tmp.getContext('2d', { willReadFrequently: true }); tg.imageSmoothingQuality = 'high';
        var bw = gb.width, bh = gb.height, cover = o.refine === 'texture' ? Math.max(dw / bw, dh / bh) : null; if (cover) { tg.drawImage(gb, (dw - bw * cover) / 2, (dh - bh * cover) / 2, bw * cover, bh * cover); } else { tg.drawImage(gb, 0, 0, dw, dh); }
        var genI = tg.getImageData(0, 0, dw, dh), reg = o.region || PD.regionOfMarks(o.marks, 0), inner = { x: (reg.x - cb.x) * sc, y: (reg.y - cb.y) * sc, w: reg.w * sc, h: reg.h * sc }, fe = Math.max(2, Math.round(Math.min(inner.w, inner.h) * o.feather)), mask;
        if (o.region) { mask = PD.rectMask(dw, dh, inner, fe, PD.featherEdges({ region: o.region, crop: cb })); } else { mask = PD.softMask(F.marksToMask(o.marks, { x: cb.x, y: cb.y, w: cb.w, h: cb.h }, dw, dh), dw, dh, fe); }
        var gsrc = { width: dw, height: dh, data: genI.data }, bsrc = { width: dw, height: dh, data: baseI.data }, blend = o.refine === 'texture' ? PD.detailTransfer(bsrc, PD.toneMatch(gsrc, bsrc, mask, 1), 0.4 + o.strength * 1.6, Math.max(1, Math.round(2 * sc))) : PD.toneMatch(gsrc, bsrc, mask, 1);
        var outI = PD.composite(bsrc, blend, mask, o.opacity); ctx.putImageData(new ImageData(new Uint8ClampedArray(outI.data), dw, dh), dx, dy);
      } else if (o.type === 'adjust' || o.type === 'heal') {
        var wr = region; if (o.target && o.target !== 'all') { var t = spec.objects.filter(function (x) { return x.id === o.target; })[0], tb = t && C.types[t.type].bbox(t); if (tb) { wr = { x: tb.x, y: tb.y, w: tb.w, h: tb.h }; } else { continue; } }
        else if (o.type === 'adjust' && o.region) { wr = o.region; }
        else if (o.type === 'heal' && o.marks.length) { var hb = C.types.heal.bbox(o), pad = 24 / sc; wr = { x: hb.x - pad, y: hb.y - pad, w: hb.w + 2 * pad, h: hb.h + 2 * pad }; }
        else if (o.type === 'adjust') { var cc = spec.canvas; wr = { x: cc.x, y: cc.y, w: cc.w, h: cc.h }; }
        var a = px(wr.x, wr.y), rx = Math.max(0, Math.floor(a[0])), ry = Math.max(0, Math.floor(a[1])), rw = Math.min(W, Math.ceil(a[0] + wr.w * sc)) - rx, rh = Math.min(H, Math.ceil(a[1] + wr.h * sc)) - ry;
        if (rw < 1 || rh < 1) { continue; }
        var id = ctx.getImageData(rx, ry, rw, rh), src = { width: rw, height: rh, data: id.data }, out;
        if (o.type === 'adjust') { out = F.run(src, o.ops, { imgproc: IP }).img; if (o.opacity < 1) { var d0 = src.data, d1 = out.data; for (var k = 0; k < d1.length; k += 4) { for (var cch = 0; cch < 3; cch++) { d1[k + cch] = d0[k + cch] * (1 - o.opacity) + d1[k + cch] * o.opacity; } } } }
        else {
          var world = { x: region.x + rx / sc, y: region.y + ry / sc, w: rw / sc, h: rh / sc }, mask = F.marksToMask(o.marks, world, rw, rh);
          if (o.method === 'inpaint') { out = F.inpaint(src, mask, { radius: o.radius }); }
          else { var f = o.method === 'denoise' ? F.denoise(src, { strength: 0.9 }) : F.despeckle(src, {}); out = { width: rw, height: rh, data: new Uint8ClampedArray(src.data) }; var any = o.marks.length > 0; for (var m = 0; m < mask.length; m++) { if (!any || mask[m]) { out.data[m * 4] = f.data[m * 4]; out.data[m * 4 + 1] = f.data[m * 4 + 1]; out.data[m * 4 + 2] = f.data[m * 4 + 2]; } } }
        }
        ctx.putImageData(new ImageData(new Uint8ClampedArray(out.data), rw, rh), rx, ry);
      }
    }
    return { canvas: cv, region: region, scale: sc };
  }
  function blobOf(cv, type, q) { return new Promise(function (res) { cv.toBlob(res, type, q); }); }

  // ───────────────────────── the screen ─────────────────────────
  function mount(opt) {
    var store = opt.store, host = opt.host || {}, resolve = function (r) { return store ? store.imageUrl(r) : ''; };
    var W = { validate: C.validate, applyEdits: C.applyEdits, editWords: C.editWords, list: C.list, find: C.find };
    return Shell.mount({
      id: opt.id, kind: 'edit-picture', title: '🎨 圖片編輯器', W: W, spec: opt.spec, state: opt.state, host: host, container: opt.container, restoring: opt.restoring, windowApi: opt.windowApi,
      tabs: [{ id: 'canvas', label: '🖼 畫面', viewer: true }, { id: 'data', label: '🧩 圖層資料' }],
      placeholder: '用說的修：「把它變成水彩風格」「調亮一點」「修掉右下角的污點」「在左邊加一隻貓」「找一張飛機的照片」；也可以貼圖進來、給網址',
      intro: '我是用語言主導的概念畫家，也有像 GIMP 的後製：你說要畫什麼、放在哪裡，或要怎麼修，我就加一個新的圖層（圖片、形狀、濾鏡、修復都是圖層），原圖不動，隨時可以隱藏、調整、復原。畫面沒有邊界，可以加在任何地方；中間的畫面可以拖曳、縮放，⌖ 回到第一個圖層（圖片）的中間。「把這張圖變成油畫／水彩／素描／卡通…」會加一個風格濾鏡，並請視覺模型看過、不像就加強；說「用 AI 重畫成…」則用生圖模型（線上或本機，同 /image）依這張圖的內容重新畫一張。「修復畫筆」可以在畫面上塗出要修的地方。可以貼圖、給網址、或說「找一張…的圖」。',
      objectIcon: function (o) { return o.type === 'shape' ? (SHAPE_ICON[o.shape] || '◻') : (ICON[o.type] || '◻'); },
      objectInfo: function (o) { return o.type === 'adjust' ? o.ops.map(function (x) { return x.op; }).slice(0, 3).join('+') : o.type === 'heal' ? o.method : o.type === 'detail' ? (o.result ? (o.state === 'preview' ? '預覽中' : '已細化') : '待細化') : o.type === 'image' ? (o.prompt ? 'AI 畫的' : o.credit ? '圖片・' + o.credit.split('—')[0].trim().slice(0, 12) : '圖片') : o.type === 'shape' ? o.shape : 'svg'; },
      parseCommands: function (t, s) { return C.parseCommands(t, s, { styleToHost: true }); }, promptOf: C.specToPrompt,
      exports: [{ id: 'png', label: 'PNG 圖片' }, { id: 'jpg', label: 'JPEG 圖片' }, { id: 'json', label: '專案（JSON）', chat: false }],
      runExport: async function (id, spec) {
        var name = slug(spec.title);
        if (id === 'json') { return { blob: new Blob([JSON.stringify(spec, null, 1)], { type: 'application/json' }), name: name + '.json', mime: 'application/json' }; }
        var r = await render(spec, { store: store, resolve: resolve, frameOnly: true, maxSide: 8192 }); if (!r) { return null; }
        if (id === 'jpg') { var f = document.createElement('canvas'); f.width = r.canvas.width; f.height = r.canvas.height; var g = f.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, f.width, f.height); g.drawImage(r.canvas, 0, 0); return { blob: await blobOf(f, 'image/jpeg', 0.92), name: name + '.jpg', mime: 'image/jpeg' }; }
        return { blob: await blobOf(r.canvas, 'image/png'), name: name + '.png', mime: 'image/png' };
      },
      build: function (ctx) {
        var spec = null, sel = null, vp = null, docR = null, rid = 0, rt = null, brush = false, brushR = 12, stroke = null, drag = null, detailMode = false, dbox = null, dState = null, viewEl = h('div'), dataWrap = h('div');
        viewEl.style.cssText = 'display:flex;flex:1;min-height:0;min-width:0'; dataWrap.style.cssText = 'display:flex;flex-direction:column;gap:6px;flex:1';
        var cv = h('canvas'), cx = cv.getContext('2d'); cv.style.cssText = 'display:block;width:100%;height:100%;touch-action:none'; var chk = (function () { var p = h('canvas'); p.width = p.height = 16; var g = p.getContext('2d'); g.fillStyle = '#e9ebef'; g.fillRect(0, 0, 16, 16); g.fillStyle = '#dfe2e7'; g.fillRect(0, 0, 8, 8); g.fillRect(8, 8, 8, 8); return cx.createPattern(p, 'repeat'); })();
        var status = h('span', 'st');
        function draw() {
          if (!vp || !spec) { return; }
          var v = vp.view(), dpr = Math.min(2, window.devicePixelRatio || 1); if (cv.width !== Math.round(v.cw * dpr) || cv.height !== Math.round(v.ch * dpr)) { cv.width = Math.round(v.cw * dpr); cv.height = Math.round(v.ch * dpr); }
          cx.setTransform(dpr, 0, 0, dpr, 0, 0); cx.fillStyle = chk || '#eee'; cx.fillRect(0, 0, v.cw, v.ch);
          function scr(wx, wy) { return [(wx - v.x) * v.z, (wy - v.y) * v.z]; }
          if (docR) { var r = docR.region, sc = docR.scale, ix0 = Math.max(r.x, v.x), iy0 = Math.max(r.y, v.y), ix1 = Math.min(r.x + r.w, v.x + v.w), iy1 = Math.min(r.y + r.h, v.y + v.h); if (ix1 > ix0 && iy1 > iy0) { var a = scr(ix0, iy0), b = scr(ix1, iy1); cx.imageSmoothingEnabled = v.z * sc < 1 ? true : false; cx.imageSmoothingQuality = 'high'; cx.drawImage(docR.canvas, (ix0 - r.x) * sc, (iy0 - r.y) * sc, (ix1 - ix0) * sc, (iy1 - iy0) * sc, a[0], a[1], b[0] - a[0], b[1] - a[1]); } }
          var c = spec.canvas, p0 = scr(c.x, c.y); cx.save(); cx.strokeStyle = '#8a93a3'; cx.lineWidth = 1; cx.setLineDash([6, 4]); cx.strokeRect(p0[0] + 0.5, p0[1] + 0.5, c.w * v.z, c.h * v.z); cx.restore();
          var so = sel ? spec.objects.filter(function (o) { return o.id === sel; })[0] : null;
          if (so && so.visible) { var bb = C.types[so.type].bbox(so); if (bb) { var q = scr(bb.x + (drag && drag.id === so.id ? drag.dx : 0), bb.y + (drag && drag.id === so.id ? drag.dy : 0)); cx.save(); cx.strokeStyle = '#2f81f7'; cx.lineWidth = 1.5; cx.setLineDash([5, 3]); cx.strokeRect(q[0], q[1], bb.w * v.z, bb.h * v.z); cx.setLineDash([]); cx.fillStyle = '#fff'; [[0, 0], [1, 0], [0, 1], [1, 1]].forEach(function (k) { cx.fillRect(q[0] + k[0] * bb.w * v.z - 3, q[1] + k[1] * bb.h * v.z - 3, 6, 6); cx.strokeRect(q[0] + k[0] * bb.w * v.z - 3, q[1] + k[1] * bb.h * v.z - 3, 6, 6); }); cx.restore(); } }
          // the marks of a repair layer that is selected, and the stroke being painted
          function marksOf(o) { return o && o.type === 'heal' ? o.marks : []; }
          cx.save(); cx.fillStyle = 'rgba(229,57,53,.35)'; cx.strokeStyle = 'rgba(229,57,53,.9)'; cx.lineWidth = 1;
          marksOf(so).forEach(function (m) { if (m.points) { m.points.forEach(function (pt) { var s2 = scr(pt[0], pt[1]); cx.beginPath(); cx.arc(s2[0], s2[1], m.r * v.z, 0, 6.2832); cx.fill(); }); } else if (m.w != null) { var s3 = scr(m.x, m.y); cx.fillRect(s3[0], s3[1], m.w * v.z, m.h * v.z); cx.strokeRect(s3[0], s3[1], m.w * v.z, m.h * v.z); } else { var s4 = scr(m.x, m.y); cx.beginPath(); cx.arc(s4[0], s4[1], m.r * v.z, 0, 6.2832); cx.fill(); cx.stroke(); } });
          if (stroke) { stroke.points.forEach(function (pt) { var s5 = scr(pt[0], pt[1]); cx.beginPath(); cx.arc(s5[0], s5[1], brushR * v.z, 0, 6.2832); cx.fill(); }); }
          cx.restore(); overlayDetail(scr);
        }
        // 擴散細化:選到的細化層、還沒有結果的(待細化)、正在框選的區域——綠色虛線框(跟修復的紅色標記分開)
        function overlayDetail(scr) {
          var boxes = []; spec.objects.forEach(function (o) { if (o.type !== 'detail' || !o.visible) { return; } var b = C.types.detail.bbox(o); if (b && (o.id === sel || !o.result)) { boxes.push({ b: b, label: o.result ? (o.state === 'preview' ? '🔍 預覽中' : '🔍 已細化') : '🔍 待細化', sel: o.id === sel }); } });
          if (dbox) { boxes.push({ b: { x: Math.min(dbox.x0, dbox.x1), y: Math.min(dbox.y0, dbox.y1), w: Math.abs(dbox.x1 - dbox.x0), h: Math.abs(dbox.y1 - dbox.y0) }, label: '', sel: true }); }
          if (!boxes.length) { return; } cx.save(); cx.lineWidth = 1.5; cx.setLineDash([6, 4]); cx.font = '12px sans-serif';
          boxes.forEach(function (k) { var q = scr(k.b.x, k.b.y), w = k.b.w * vp.view().z, hh = k.b.h * vp.view().z; cx.strokeStyle = k.sel ? '#2ea043' : 'rgba(46,160,67,.7)'; cx.fillStyle = 'rgba(46,160,67,.10)'; cx.fillRect(q[0], q[1], w, hh); cx.strokeRect(q[0], q[1], w, hh); if (k.label) { cx.setLineDash([]); cx.fillStyle = '#2ea043'; cx.fillText(k.label, q[0] + 4, q[1] - 5); cx.setLineDash([6, 4]); } });
          cx.restore();
        }
        function schedule() { clearTimeout(rt); var my = ++rid; rt = setTimeout(function () { status.textContent = '合成中…'; render(spec, { store: store, resolve: resolve, isCancelled: function () { return my !== rid; } }).then(function (r) { if (r && my === rid) { docR = r; status.textContent = ''; draw(); } }, function (e) { status.className = 'st bad'; status.textContent = String((e && e.message) || e).slice(0, 100); }); }, 90); }
        vp = VP.create({
          onView: draw, background: '#eef0f3',
          handle: function (ev) {
            var w0 = vp.toWorld(ev.clientX, ev.clientY);
            if (detailMode) {
              dbox = { x0: w0.x, y0: w0.y, x1: w0.x, y1: w0.y }; ev.preventDefault();
              var mvd = function (e) { var w1 = vp.toWorld(e.clientX, e.clientY); dbox.x1 = w1.x; dbox.y1 = w1.y; draw(); };
              var upd2 = function () { window.removeEventListener('pointermove', mvd); window.removeEventListener('pointerup', upd2); var bx = dbox; dbox = null; draw(); if (!bx) { return; } var rg = { x: Math.round(Math.min(bx.x0, bx.x1)), y: Math.round(Math.min(bx.y0, bx.y1)), w: Math.round(Math.abs(bx.x1 - bx.x0)), h: Math.round(Math.abs(bx.y1 - bx.y0)) }; if (rg.w < 8 || rg.h < 8) { status.className = 'st bad'; status.textContent = '框太小了:拖出一個比較大的區域'; return; }
                var so = sel ? spec.objects.filter(function (o) { return o.id === sel; })[0] : null, tgt = so && (so.type === 'image' || so.type === 'shape' || so.type === 'svg') ? so.id : 'all', r = ctx.apply([{ op: 'add_object', object: { type: 'detail', name: '細化', region: rg, target: tgt } }], '框出要細化的地方', '', 'panel');
                setDetailMode(false); if (r && r.added && r.added.length) { runDetail(r.added[r.added.length - 1]); } };
              window.addEventListener('pointermove', mvd); window.addEventListener('pointerup', upd2); return true;
            }
            if (brush) { stroke = { points: [[w0.x, w0.y]] }; ev.preventDefault(); var mv = function (e) { var w1 = vp.toWorld(e.clientX, e.clientY), last = stroke.points[stroke.points.length - 1]; if (Math.hypot(w1.x - last[0], w1.y - last[1]) * vp.zoom() > 3) { stroke.points.push([Math.round(w1.x * 10) / 10, Math.round(w1.y * 10) / 10]); draw(); } };
              var up = function () { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); var st = stroke; stroke = null; draw(); if (!st || !st.points.length) { return; } var so = sel ? spec.objects.filter(function (o) { return o.id === sel; })[0] : null, mark = { points: st.points, r: brushR };
                if (so && so.type === 'heal' && !so.locked) { ctx.apply([{ op: 'update_object', id: so.id, props: { marks: so.marks.concat([mark]) } }], '補畫修復標記', '', 'panel'); }
                else { var tgt = so && (so.type === 'image' || so.type === 'shape' || so.type === 'svg') ? so.id : 'all'; ctx.apply([{ op: 'add_object', object: { type: 'heal', name: '修復', marks: [mark], method: 'inpaint', target: tgt } }], '用畫筆標出要修復的地方', '', 'panel'); } };
              window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); return true; }
            var hit = null; for (var i = spec.objects.length - 1; i >= 0; i--) { var o = spec.objects[i]; if (!o.visible || (o.type !== 'image' && o.type !== 'shape' && o.type !== 'svg')) { continue; } var bb = C.types[o.type].bbox(o); if (bb && w0.x >= bb.x && w0.x <= bb.x + bb.w && w0.y >= bb.y && w0.y <= bb.y + bb.h) { hit = o; break; } }
            if (!hit) { return false; }
            ctx.select(hit.id); ev.preventDefault(); if (hit.locked) { return true; }
            drag = { id: hit.id, w0: w0, dx: 0, dy: 0, moved: false };
            var mv2 = function (e) { if (!drag) { return; } var w1 = vp.toWorld(e.clientX, e.clientY); drag.dx = w1.x - drag.w0.x; drag.dy = w1.y - drag.w0.y; if (Math.abs(drag.dx) + Math.abs(drag.dy) > 2 / vp.zoom()) { drag.moved = true; } draw(); };
            var up2 = function () { window.removeEventListener('pointermove', mv2); window.removeEventListener('pointerup', up2); var d = drag; drag = null; if (d && d.moved) { var o2 = spec.objects.filter(function (x) { return x.id === d.id; })[0]; ctx.apply([{ op: 'transform_object', id: d.id, dx: Math.round(d.dx * 100) / 100, dy: Math.round(d.dy * 100) / 100 }], '移動 ' + (o2 ? o2.name : d.id), '', 'panel'); } else { draw(); } };
            window.addEventListener('pointermove', mv2); window.addEventListener('pointerup', up2); return true;
          },
          onBackgroundClick: function () { ctx.select(null); }
        });
        vp.layer.appendChild(cv); viewEl.appendChild(vp.el);
        // ───── the bar: the repair brush ─────
        var bBrush = h('button', null, '🩹 修復畫筆'), bSize = h('input'); bSize.type = 'number'; bSize.value = brushR; bSize.min = 1; bSize.max = 200; bSize.style.width = '58px'; bSize.title = '畫筆大小（畫面上的單位）'; bSize.style.display = 'none';
        bBrush.title = '在畫面上塗出要修復的地方（會變成一個修復圖層）'; bBrush.onclick = function () { brush = !brush; if (brush) { setDetailMode(false); } bBrush.className = brush ? 'pri' : ''; bSize.style.display = brush ? '' : 'none'; vp.scroller.style.cursor = brush ? 'crosshair' : ''; }; bSize.onchange = function () { brushR = Math.max(1, Number(bSize.value) || 12); };
        // ───── 擴散細化:啟用項、框選、產生 ─────
        var bDetail = h('button', null, '✨ 擴散細化'), dCk = h('input'), dLab = h('label', null, ''); dCk.type = 'checkbox'; dLab.style.cssText = 'display:inline-flex;align-items:center;gap:3px;font-size:12px;cursor:pointer'; dLab.appendChild(dCk); dLab.appendChild(document.createTextNode('啟用擴散編修')); dLab.title = '預設關閉。啟用後可以只針對一小塊重畫細節、再羽化蓋回去（要有生圖模型：線上金鑰或本機模型）';
        function refreshDiffusion() { if (!host.diffusion) { dLab.style.display = 'none'; bDetail.style.display = 'none'; return Promise.resolve(); } return Promise.resolve(host.diffusion.get()).then(function (st) { dState = st; dCk.checked = !!st.enabled; bDetail.disabled = !st.ready; bDetail.title = st.ready ? '在畫面上框出要細化的地方（只重畫那一小塊，再羽化蓋回去；原圖不動）' : (st.reason || '還不能用'); }, function () { /* 沒有就不顯示 */ }); }
        dCk.onchange = function () { Promise.resolve(host.diffusion.set(dCk.checked)).then(refreshDiffusion); }; refreshDiffusion();
        function setDetailMode(on) { detailMode = !!on; bDetail.className = detailMode ? 'pri' : ''; vp.scroller.style.cursor = detailMode ? 'crosshair' : ''; if (detailMode) { brush = false; bBrush.className = ''; bSize.style.display = 'none'; } }
        bDetail.onclick = function () { if (!detailMode) { refreshDiffusion().then(function () { if (!dState || !dState.ready) { status.className = 'st bad'; status.textContent = (dState && dState.reason) || '還不能用'; return; } status.className = 'st'; status.textContent = '在畫面上拖出要細化的區域'; setDetailMode(true); }); } else { setDetailMode(false); status.textContent = ''; } };
        var runningDetail = {};
        function runDetail(id) {
          var o = spec.objects.filter(function (x) { return x.id === id && x.type === 'detail'; })[0]; if (!o || !host.detail || runningDetail[id]) { return; } runningDetail[id] = true; status.className = 'st'; status.textContent = '細化中…（要等一下）';
          Promise.resolve(host.detail({ spec: spec, id: id, onStatus: function (t) { status.textContent = String(t).slice(0, 90); } })).then(function (r) { delete runningDetail[id]; if (!r || !r.ok) { status.className = 'st bad'; status.textContent = String((r && r.error) || '沒有成功').slice(0, 120); return; } status.textContent = r.note ? String(r.note).slice(0, 100) : ''; ctx.apply([{ op: 'update_object', id: id, props: r.props }], '擴散細化「' + (o.prompt || o.name) + '」', '', 'panel'); }, function (e) { delete runningDetail[id]; status.className = 'st bad'; status.textContent = String((e && e.message) || e).slice(0, 120); });
        }
        // ───── properties ─────
        function field(label, type, value, onChange, extra) { var l = h('label'), i = h('input'); i.type = type; i.value = value == null ? '' : value; if (extra && extra.step) { i.step = extra.step; } if (extra && extra.min != null) { i.min = extra.min; } if (type === 'checkbox') { i.checked = !!value; } l.appendChild(document.createTextNode(label)); l.appendChild(i); i.onchange = function () { onChange(type === 'number' ? Number(i.value) : type === 'checkbox' ? i.checked : i.value); }; return l; }
        function selectBox(label, options, value, onChange) { var l = h('label'), s = h('select'); options.forEach(function (o) { var op = h('option', null, o[1]); op.value = o[0]; s.appendChild(op); }); s.value = value; l.appendChild(document.createTextNode(label)); l.appendChild(s); s.onchange = function () { onChange(s.value); }; return l; }
        var STYLE_OPTS = [['', '套用風格…']].concat(Object.keys(C.STYLES).map(function (k) { return [k, C.STYLES[k].label]; }));
        function styleRow(targetId) { var r = h('div', 'row'), s = h('select'); STYLE_OPTS.forEach(function (o) { var op = h('option', null, o[1]); op.value = o[0]; s.appendChild(op); }); s.onchange = function () { if (s.value) { ctx.apply([{ op: 'apply_style', style: s.value, target: targetId || 'all' }], '套用風格「' + C.STYLES[s.value].label + '」', '', 'panel'); s.value = ''; } }; r.appendChild(s); return r; }
        function props() {
          var box = h('div'); box.style.cssText = 'display:flex;flex-direction:column;gap:6px'; var o = sel ? spec.objects.filter(function (x) { return x.id === sel; })[0] : null;
          function upd(p, words) { ctx.apply([{ op: 'update_object', id: o.id, props: p }], words || ('改 ' + o.name), '', 'panel'); }
          if (!o) {
            var c = spec.canvas; box.appendChild(h('div', 'st', '畫布（裁切與輸出的範圍框，不是邊界）'));
            [['x', c.x], ['y', c.y], ['寬', c.w], ['高', c.h]].forEach(function (f, i) { box.appendChild(field(f[0], 'number', f[1], function (v) { var e = { op: 'set_canvas' }; e[['x', 'y', 'w', 'h'][i]] = v; ctx.apply([e], '畫布 ' + f[0] + '=' + v, '', 'panel'); })); });
            box.appendChild(field('背景', 'color', /^#[0-9a-f]{6}$/i.test(c.bg) ? c.bg : '#ffffff', function (v) { ctx.apply([{ op: 'set_canvas', bg: v }], '背景 ' + v, '', 'panel'); }));
            var fit = h('button', null, '畫布貼合內容'); fit.onclick = function () { ctx.apply([{ op: 'fit_canvas' }], '畫布貼合內容', '', 'panel'); }; box.appendChild(fit);
            box.appendChild(h('div', 'st', '對整張圖：')); box.appendChild(styleRow('all'));
            var fx = h('div', 'row'); [['自動對比', { op: 'auto_contrast' }], ['去雜訊', { op: 'denoise' }], ['去污點', { op: 'despeckle' }], ['銳化', { op: 'sharpen', amount: 1 }]].forEach(function (b) { var bt = h('button', null, b[0]); bt.onclick = function () { ctx.apply([{ op: 'add_object', object: { type: 'adjust', name: b[0], ops: [b[1]], target: 'all' } }], b[0], '', 'panel'); }; fx.appendChild(bt); }); box.appendChild(fx);
            return box;
          }
          box.appendChild(h('div', 'st', o.name + '（' + (o.type === 'shape' ? o.shape : o.type) + '，' + o.id + '）'));
          if (o.type === 'image' || o.type === 'shape' || o.type === 'svg') {
            if (o.type === 'image' || o.type === 'shape') { ['x', 'y', 'w', 'h'].forEach(function (k) { box.appendChild(field(k === 'w' ? '寬' : k === 'h' ? '高' : k, 'number', o[k], function (v) { var p = {}; p[k] = v; upd(p); }, { step: 1 })); }); }
            else { ['x', 'y'].forEach(function (k) { box.appendChild(field(k, 'number', o[k], function (v) { var p = {}; p[k] = v; upd(p); }, { step: 1 })); }); box.appendChild(field('縮放', 'number', o.scale, function (v) { upd({ scale: v }); }, { step: 0.1, min: 0.01 })); }
            box.appendChild(field('旋轉', 'number', o.rotate, function (v) { upd({ rotate: v }); })); box.appendChild(field('透明度', 'number', o.opacity, function (v) { upd({ opacity: v }); }, { step: 0.1, min: 0 }));
            box.appendChild(selectBox('混合', C.BLENDS.map(function (b) { return [b, b]; }), o.blend || 'normal', function (v) { upd({ blend: v }); }));
            if (o.type === 'image') { box.appendChild(field('水平翻轉', 'checkbox', o.flipX, function (v) { upd({ flipX: v }); })); box.appendChild(field('垂直翻轉', 'checkbox', o.flipY, function (v) { upd({ flipY: v }); })); if (o.credit) { box.appendChild(h('div', 'st', '出處：' + o.credit)); } if (o.prompt) { box.appendChild(h('div', 'st', '提示詞：' + o.prompt)); } box.appendChild(h('div', 'st', '對這張圖：')); box.appendChild(styleRow(o.id)); var hb = h('button', null, '🩹 修復這張圖的中央'); hb.onclick = function () { ctx.apply([{ op: 'add_heal', of: o.id, at: 'center' }], '修復 ' + o.name, '', 'panel'); }; box.appendChild(hb); }
            if (o.type === 'shape') { if (o.shape !== 'line' && o.shape !== 'arrow') { box.appendChild(field('填色', 'color', /^#[0-9a-f]{6}$/i.test(o.fill) ? o.fill : '#4f8ef7', function (v) { upd({ fill: v }); })); } box.appendChild(field('邊框', 'color', /^#[0-9a-f]{6}$/i.test(o.stroke) ? o.stroke : '#333333', function (v) { upd({ stroke: v }); })); if (o.shape === 'text') { box.appendChild(field('文字', 'text', o.text, function (v) { upd({ text: v }); })); box.appendChild(field('字級', 'number', o.size, function (v) { upd({ size: v }); })); } }
          } else if (o.type === 'adjust') {
            box.appendChild(field('強度', 'number', o.opacity, function (v) { upd({ opacity: v }); }, { step: 0.1, min: 0 }));
            var tOpts = [['all', '整張圖']].concat(spec.objects.filter(function (x) { return x.type === 'image' || x.type === 'shape' || x.type === 'svg'; }).map(function (x) { return [x.id, x.name]; })); box.appendChild(selectBox('作用在', tOpts, o.target, function (v) { upd({ target: v }, o.name + ' 作用在 ' + v); }));
            o.ops.forEach(function (op, i) { var r = h('div', 'row'); r.appendChild(h('span', null, op.op + (Object.keys(op).filter(function (k) { return k !== 'op'; }).map(function (k) { return ' ' + k + '=' + op[k]; }).join('')))); var rm = h('button', null, '✕'); rm.onclick = function () { var ops = o.ops.slice(); ops.splice(i, 1); if (!ops.length) { ctx.apply([{ op: 'remove_object', id: o.id }], '刪掉 ' + o.name, '', 'panel'); } else { upd({ ops: ops }, o.name + ' 拿掉 ' + op.op); } }; r.appendChild(rm); box.appendChild(r); });
            var add = h('div', 'row'), sel2 = h('select'); [['brightness', '亮度'], ['contrast', '對比'], ['saturation', '飽和度'], ['blur', '模糊'], ['sharpen', '銳化'], ['grayscale', '黑白'], ['oil', '油畫'], ['watercolor', '水彩'], ['sketch', '素描'], ['cartoon', '卡通'], ['denoise', '降噪'], ['despeckle', '去污點']].forEach(function (x) { var op = h('option', null, x[1]); op.value = x[0]; sel2.appendChild(op); });
            var val = h('input'); val.type = 'number'; val.placeholder = '數值'; val.style.width = '64px'; var ab = h('button', null, '＋ 加一個處理'); ab.onclick = function () { var n = { op: sel2.value }; if (val.value !== '') { var key = { brightness: 'amount', contrast: 'amount', saturation: 'amount', blur: 'radius', sharpen: 'amount', oil: 'radius' }[sel2.value]; if (key) { n[key] = Number(val.value); } } upd({ ops: o.ops.concat([n]) }, o.name + ' 加 ' + sel2.value); };
            [sel2, val, ab].forEach(function (x) { add.appendChild(x); }); box.appendChild(add);
          } else if (o.type === 'detail') {
            box.appendChild(h('div', 'st', o.result ? (o.state === 'preview' ? '預覽中：滿意就按「接受」，不滿意可以重畫或退回' : '已細化（' + (o.refine === 'texture' ? '借重畫的細節紋理' : '依原圖改') + '）') : '待細化：按「✨ 細化」開始'));
            box.appendChild(field('提示詞', 'text', o.prompt, function (v) { upd({ prompt: v }, '細化提示詞'); })); box.appendChild(field('強度', 'number', o.strength, function (v) { upd({ strength: v }, '細化強度'); }, { step: 0.1, min: 0.1 }));
            box.appendChild(field('羽化', 'number', o.feather, function (v) { upd({ feather: v }, '細化羽化'); }, { step: 0.02, min: 0 })); box.appendChild(field('脈絡', 'number', o.context, function (v) { upd({ context: v }, '細化脈絡'); }, { step: 0.1, min: 0 }));
            box.appendChild(selectBox('模型', [['auto', '自動'], ['online', '線上（能改圖的模型）'], ['local', '本機（重畫細節紋理）']], o.model, function (v) { upd({ model: v }, '細化模型'); })); box.appendChild(field('透明度', 'number', o.opacity, function (v) { upd({ opacity: v }); }, { step: 0.1, min: 0 }));
            var drow = h('div', 'row'), go = h('button', null, o.result ? '🎲 重畫' : '✨ 細化'); go.onclick = function () { if (o.result) { upd({ seed: Math.floor(Math.random() * 4294967296), state: 'pending', result: '' }, '重畫細化'); setTimeout(function () { runDetail(o.id); }, 0); } else { runDetail(o.id); } }; drow.appendChild(go);
            if (o.result && o.state === 'preview') { var okb = h('button', 'pri', '✔ 接受'); okb.onclick = function () { upd({ state: 'applied' }, '接受細化'); }; drow.appendChild(okb); }
            var nob = h('button', null, '↩ 退回'); nob.onclick = function () { ctx.apply([{ op: 'remove_object', id: o.id }], '退回細化', '', 'panel'); }; drow.appendChild(nob); box.appendChild(drow);
            if (o.seed != null) { box.appendChild(h('div', 'st', 'seed ' + o.seed)); }
          } else if (o.type === 'heal') {
            box.appendChild(selectBox('方法', [['inpaint', '補洞（從周圍填入）'], ['denoise', '降噪'], ['despeckle', '去污點']], o.method, function (v) { upd({ method: v }); })); box.appendChild(field('半徑', 'number', o.radius, function (v) { upd({ radius: v }); }, { min: 1 }));
            box.appendChild(h('div', 'st', '標記 ' + o.marks.length + ' 處（用「🩹 修復畫筆」可以再塗）')); var clr = h('button', null, '清除標記'); clr.onclick = function () { ctx.apply([{ op: 'remove_object', id: o.id }], '刪掉 ' + o.name, '', 'panel'); }; box.appendChild(clr);
          }
          return box;
        }
        // ───── the layers as data ─────
        var jta = h('textarea', 'code'); jta.rows = 18; jta.readOnly = true; jta.style.flex = '1'; var jrow = h('div', 'row'), jcopy = h('button', null, '📋 複製'); jcopy.onclick = function () { try { navigator.clipboard.writeText(jta.value); jcopy.textContent = '✓ 已複製'; setTimeout(function () { jcopy.textContent = '📋 複製'; }, 1500); } catch (e) { jta.select(); } }; jrow.appendChild(jcopy);
        dataWrap.appendChild(h('div', 'st', '所有圖層與它們的設定（唯讀）。圖片的像素另外存在這個瀏覽器裡，這裡只有代號。')); dataWrap.appendChild(jta); dataWrap.appendChild(jrow);
        return {
          tabs: { canvas: viewEl, data: dataWrap }, bar: [bBrush, bSize, bDetail, dLab, status],
          env: function () { var v = vp.view(); return { view: { x: v.x, y: v.y, w: v.w, h: v.h } }; },
          refresh: function (s, selId) {
            spec = s; sel = selId; var b = C.bounds(s), c = s.canvas, all = b ? { x: Math.min(b.x, c.x), y: Math.min(b.y, c.y), w: Math.max(b.x + b.w, c.x + c.w) - Math.min(b.x, c.x), h: Math.max(b.y + b.h, c.y + c.h) - Math.min(b.y, c.y) } : { x: c.x, y: c.y, w: c.w, h: c.h };
            vp.setBounds(all); var first = s.objects[0] && s.objects[0].type !== 'adjust' && s.objects[0].type !== 'heal' ? C.types[s.objects[0].type].bbox(s.objects[0]) : null; vp.setHome(first || { x: c.x, y: c.y, w: c.w, h: c.h });
            ctx.setProps(props()); jta.value = JSON.stringify(s, null, 1); draw(); schedule();
          },
          showTab: function (t) { if (t === 'canvas') { draw(); } else { jta.value = JSON.stringify(spec, null, 1); } },
          vp: vp, render: function () { return render(spec, { store: store, resolve: resolve }); }, destroy: function () { vp.destroy(); }
        };
      }
    });
  }
  return { mount: mount, render: render, docRegion: docRegion };
});
