// The screen of /edit-svg, built on the shared frame (edit_shell.js): the middle viewer is an ENDLESS plane (edit_viewport.js: scrollbars, drag the view, zoom; only the visible part is drawn), click an
// object to select it, drag it to move it (one undo step), the objects view and the properties panel are the frame's / this file's, the source tab shows the whole drawing as one SVG.
//   FaEditSvgUI.mount({ id, state, spec, host, container, restoring, store }) -> element (see FaEditShell: el._ed)
//   host: { ask, save, download, toChat?, polish?, palette?, windowApi? }  as the frame wants;  store = FaEditStore (pictures)
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaEditSvgUI = factory((root.FaEditSvg || (typeof FaEditSvg !== 'undefined' ? FaEditSvg : undefined)), (root.FaEditShell || (typeof FaEditShell !== 'undefined' ? FaEditShell : undefined)), (root.FaEditViewport || (typeof FaEditViewport !== 'undefined' ? FaEditViewport : undefined))); })(typeof self !== 'undefined' ? self : this, function (C, Shell, VP) {
  'use strict';
  var NS = 'http://www.w3.org/2000/svg';
  function h(tag, cls, text) { var e = document.createElement(tag); if (cls) { e.className = cls; } if (text != null) { e.textContent = text; } return e; }
  var ICON = { rect: '▭', ellipse: '⬭', line: '╱', arrow: '➜', triangle: '△', polygon: '⬡', star: '★', path: '✎', text: 'T' };
  function slug(s) { return String(s || 'drawing').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50) || 'drawing'; }
  function rasterize(svgText, w, h, scale) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' })), img = new Image();
      img.onload = function () { try { var cv = document.createElement('canvas'); cv.width = Math.max(1, Math.round(w * scale)); cv.height = Math.max(1, Math.round(h * scale)); var g = cv.getContext('2d'); g.drawImage(img, 0, 0, cv.width, cv.height); URL.revokeObjectURL(url); cv.toBlob(function (b) { b ? resolve(b) : reject(new Error('could not make the picture')); }, 'image/png'); } catch (e) { URL.revokeObjectURL(url); reject(e); } };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('the drawing could not be drawn as a picture')); }; img.src = url;
    });
  }

  function mount(opt) {
    var store = opt.store, host = opt.host || {};
    var W = { validate: C.validate, applyEdits: C.applyEdits, editWords: C.editWords, list: C.list, find: C.find };
    var resolve = function (ref) { return store ? store.imageUrl(ref) : ''; };
    return Shell.mount({
      id: opt.id, kind: 'edit-svg', title: '🖍 SVG 編輯器', W: W, spec: opt.spec, state: opt.state, host: host, container: opt.container, restoring: opt.restoring, windowApi: opt.windowApi,
      tabs: [{ id: 'canvas', label: '🖼 畫面', viewer: true }, { id: 'source', label: '🧩 原始碼' }],
      placeholder: '用說的畫：「在中間畫一個紅色的圓」「在太陽的右邊加一朵雲」「把煙囪放到房子上面」「找一張飛機的照片」；也可以貼一張圖進來，我試著把它變成 SVG（向量圖）',
      intro: '我是用語言來畫的概念畫家：你說要畫什麼、放在哪個東西的哪一邊，我就加一個新的物件（形狀、手繪的圖、網路上找的圖片都是物件），可以隨時隱藏、改名、鎖定、移動或刪掉，改錯了按「復原」。畫面沒有邊界，可以加在任何地方；中間的畫面可以拖曳、縮放，⌖ 回到第一個物件（圖片）的中間。貼一張圖進來，我會試著把它變成 SVG：先用程式描出每個顏色的輪廓，再用視覺模型看過、比對，不夠像就重來。也可以直接給網址，或說「找一張…的圖」。',
      objectIcon: function (o) { return o.type === 'shape' ? (ICON[o.shape] || '◻') : o.type === 'svg' ? '🖍' : '🖼'; },
      objectInfo: function (o) { return o.type === 'shape' ? o.shape : o.type === 'image' ? (o.credit ? '圖片・' + o.credit.split('—')[0].trim().slice(0, 14) : '圖片') : 'svg'; },
      parseCommands: C.parseCommands, promptOf: C.specToPrompt,
      exports: [{ id: 'png', label: 'PNG 圖片' }, { id: 'svg', label: 'SVG 檔' }, { id: 'json', label: '專案（JSON）', chat: false }],
      runExport: async function (id, spec) {
        var name = slug(spec.title);
        if (id === 'json') { return { blob: new Blob([JSON.stringify(spec, null, 1)], { type: 'application/json' }), name: name + '.json', mime: 'application/json' }; }
        var svg = C.compose(spec, { resolve: resolve });
        if (id === 'svg') { return { blob: new Blob([svg], { type: 'image/svg+xml' }), name: name + '.svg', mime: 'image/svg+xml' }; }
        var sc = Math.min(2, 4096 / Math.max(spec.canvas.w, spec.canvas.h)); return { blob: await rasterize(svg, spec.canvas.w, spec.canvas.h, sc), name: name + '.png', mime: 'image/png' };
      },
      build: function (ctx) {
        var spec = null, sel = null, drag = null, viewEl = h('div'), srcWrap = h('div'), vp = null;
        viewEl.style.cssText = 'display:flex;flex:1;min-height:0;min-width:0'; srcWrap.style.cssText = 'display:flex;flex-direction:column;gap:6px;flex:1';
        // ───── the endless plane: draw only what is in view ─────
        function pattern(z) { var s = Math.max(8, 16 / z); return '<defs><pattern id="few-chk" width="' + (2 * s) + '" height="' + (2 * s) + '" patternUnits="userSpaceOnUse"><rect width="' + (2 * s) + '" height="' + (2 * s) + '" fill="#e9ebef"/><rect width="' + s + '" height="' + s + '" fill="#dfe2e7"/><rect x="' + s + '" y="' + s + '" width="' + s + '" height="' + s + '" fill="#dfe2e7"/></pattern></defs>'; }
        function draw() {
          if (!vp || !spec) { return; }
          var v = vp.view(), c = spec.canvas, z = v.z, parts = ['<svg xmlns="' + NS + '" width="' + v.cw + '" height="' + v.ch + '" viewBox="' + v.x + ' ' + v.y + ' ' + v.w + ' ' + v.h + '">'];
          parts.push(pattern(z), '<rect x="' + v.x + '" y="' + v.y + '" width="' + v.w + '" height="' + v.h + '" fill="url(#few-chk)"/>');
          parts.push('<rect x="' + c.x + '" y="' + c.y + '" width="' + c.w + '" height="' + c.h + '" fill="' + c.bg + '"/>');
          spec.objects.forEach(function (o) { if (o.visible) { parts.push(C.objectMarkup(o, resolve).replace(/^<g id="/, '<g data-oid="')); } });
          parts.push('<rect x="' + c.x + '" y="' + c.y + '" width="' + c.w + '" height="' + c.h + '" fill="none" stroke="#8a93a3" stroke-width="' + (1 / z) + '" stroke-dasharray="' + (6 / z) + ' ' + (4 / z) + '" pointer-events="none"/>');
          var so = sel ? spec.objects.filter(function (o) { return o.id === sel; })[0] : null;
          if (so && so.visible) { var b = C.types[so.type].bbox(so), k = 1 / z; parts.push('<g pointer-events="none"><rect x="' + b.x + '" y="' + b.y + '" width="' + b.w + '" height="' + b.h + '" fill="none" stroke="#2f81f7" stroke-width="' + (1.5 * k) + '" stroke-dasharray="' + (5 * k) + ' ' + (3 * k) + '"/>' + [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]].map(function (p) { return '<rect x="' + (p[0] - 3 * k) + '" y="' + (p[1] - 3 * k) + '" width="' + (6 * k) + '" height="' + (6 * k) + '" fill="#fff" stroke="#2f81f7" stroke-width="' + k + '"/>'; }).join('') + '</g>'); }
          parts.push('</svg>');
          var markup = parts.join('');
          var DP = typeof window !== 'undefined' ? window.DOMPurify : null; if (DP) { markup = DP.sanitize(markup, { USE_PROFILES: { svg: true, svgFilters: true }, ADD_ATTR: ['data-oid', 'data-name'] }); }
          vp.layer.innerHTML = markup;
        }
        vp = VP.create({
          onView: draw, background: '#eef0f3',
          handle: function (ev) {
            var t = ev.target && ev.target.closest ? ev.target.closest('[data-oid]') : null; if (!t) { return false; }
            var id = t.getAttribute('data-oid'), o = spec.objects.filter(function (x) { return x.id === id; })[0]; if (!o) { return false; }
            ctx.select(id); ev.preventDefault();
            if (o.locked) { return true; }
            var w0 = vp.toWorld(ev.clientX, ev.clientY); drag = { id: id, w0: w0, dx: 0, dy: 0, moved: false, el: vp.layer.querySelector('[data-oid="' + id + '"]') };
            var mv = function (e) { if (!drag) { return; } var w1 = vp.toWorld(e.clientX, e.clientY); drag.dx = w1.x - drag.w0.x; drag.dy = w1.y - drag.w0.y; if (Math.abs(drag.dx) + Math.abs(drag.dy) > 2 / vp.zoom()) { drag.moved = true; } if (drag.el) { drag.el.style.transform = 'translate(' + drag.dx + 'px,' + drag.dy + 'px)'; } };
            var up = function () { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); var d = drag; drag = null; if (d && d.moved) { var o2 = spec.objects.filter(function (x) { return x.id === d.id; })[0]; ctx.apply([{ op: 'transform_object', id: d.id, dx: Math.round(d.dx * 100) / 100, dy: Math.round(d.dy * 100) / 100 }], '移動 ' + (o2 ? o2.name : d.id), '', 'panel'); } };
            window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); return true;
          },
          onBackgroundClick: function () { ctx.select(null); }
        });
        viewEl.appendChild(vp.el);
        // ───── properties of the selected object (or of the canvas frame) ─────
        function field(label, type, value, onChange, extra) {
          var l = h('label'), i = h('input'); i.type = type; i.value = value == null ? '' : value; if (extra && extra.step) { i.step = extra.step; } if (extra && extra.min != null) { i.min = extra.min; } l.appendChild(document.createTextNode(label)); l.appendChild(i);
          i.onchange = function () { onChange(type === 'number' ? Number(i.value) : i.value); }; return l;
        }
        function props() {
          var box = h('div'); box.style.cssText = 'display:flex;flex-direction:column;gap:6px';
          var o = sel ? spec.objects.filter(function (x) { return x.id === sel; })[0] : null;
          function upd(p, words) { ctx.apply([{ op: 'update_object', id: o.id, props: p }], words || ('改 ' + o.name), '', 'panel'); }
          if (!o) {
            var c = spec.canvas; box.appendChild(h('div', 'st', '畫布（匯出的範圍框，不是邊界）'));
            [['x', c.x], ['y', c.y], ['寬', c.w], ['高', c.h]].forEach(function (f, i) { box.appendChild(field(f[0], 'number', f[1], function (v) { var e = { op: 'set_canvas' }; e[['x', 'y', 'w', 'h'][i]] = v; ctx.apply([e], '畫布 ' + f[0] + '=' + v, '', 'panel'); })); });
            box.appendChild(field('背景', 'color', /^#[0-9a-f]{6}$/i.test(c.bg) ? c.bg : '#ffffff', function (v) { ctx.apply([{ op: 'set_canvas', bg: v }], '背景 ' + v, '', 'panel'); }));
            var fit = h('button', null, '貼合內容'); fit.onclick = function () { ctx.apply([{ op: 'fit_canvas' }], '畫布貼合內容', '', 'panel'); box.appendChild(h('span')); }; box.appendChild(fit);
            return box;
          }
          box.appendChild(h('div', 'st', o.name + '（' + (o.type === 'shape' ? o.shape : o.type) + '，' + o.id + '）'));
          if (o.type === 'shape') {
            ['x', 'y', 'w', 'h'].forEach(function (k) { box.appendChild(field(k === 'w' ? '寬' : k === 'h' ? '高' : k, 'number', o[k], function (v) { var p = {}; p[k] = v; upd(p); }, { step: 1 })); });
            if (o.shape !== 'line' && o.shape !== 'arrow') { box.appendChild(field('填色', 'color', /^#[0-9a-f]{6}$/i.test(o.fill) ? o.fill : '#4f8ef7', function (v) { upd({ fill: v }, o.name + ' 填色 ' + v); })); }
            box.appendChild(field('邊框', 'color', /^#[0-9a-f]{6}$/i.test(o.stroke) ? o.stroke : '#333333', function (v) { upd({ stroke: v }, o.name + ' 邊框 ' + v); })); box.appendChild(field('邊框粗細', 'number', o.sw, function (v) { upd({ sw: v }); }, { step: 1, min: 0 }));
            if (o.shape === 'text') { box.appendChild(field('文字', 'text', o.text, function (v) { upd({ text: v }); })); box.appendChild(field('字級', 'number', o.size, function (v) { upd({ size: v }); })); }
            if (o.shape === 'polygon' || o.shape === 'star') { box.appendChild(field('邊數', 'number', o.sides, function (v) { upd({ sides: v }); })); }
            if (o.shape === 'rect') { box.appendChild(field('圓角', 'number', o.rx, function (v) { upd({ rx: v }); }, { min: 0 })); }
            box.appendChild(field('旋轉', 'number', o.rotate, function (v) { upd({ rotate: v }); })); box.appendChild(field('透明度', 'number', o.opacity, function (v) { upd({ opacity: v }); }, { step: 0.1, min: 0 }));
          } else if (o.type === 'svg') {
            ['x', 'y'].forEach(function (k) { box.appendChild(field(k, 'number', o[k], function (v) { var p = {}; p[k] = v; upd(p); }, { step: 1 })); });
            box.appendChild(field('縮放', 'number', o.scale, function (v) { upd({ scale: v }); }, { step: 0.1, min: 0.01 })); box.appendChild(field('旋轉', 'number', o.rotate, function (v) { upd({ rotate: v }); })); box.appendChild(field('透明度', 'number', o.opacity, function (v) { upd({ opacity: v }); }, { step: 0.1, min: 0 }));
            var ta = h('textarea', 'code'); ta.rows = 6; ta.value = o.markup; ta.spellcheck = false; ta.onchange = function () { upd({ markup: ta.value }, o.name + ' 的圖形內容'); }; box.appendChild(h('div', 'st', 'SVG 內容（改完離開輸入框就會套用）')); box.appendChild(ta);
          } else if (o.type === 'image') {
            ['x', 'y', 'w', 'h'].forEach(function (k) { box.appendChild(field(k === 'w' ? '寬' : k === 'h' ? '高' : k, 'number', o[k], function (v) { var p = {}; p[k] = v; upd(p); }, { step: 1 })); }); box.appendChild(field('透明度', 'number', o.opacity, function (v) { upd({ opacity: v }); }, { step: 0.1, min: 0 }));
            if (o.credit) { box.appendChild(h('div', 'st', '出處：' + o.credit)); }
            var vec = h('button', null, '✨ 把這張圖變成 SVG'); vec.onclick = function () { if (ctx.el._ed && opt.onVectorize) { opt.onVectorize(o); } }; if (opt.onVectorize) { box.appendChild(vec); }
          }
          return box;
        }
        // ───── source: the whole drawing as one SVG; applying it makes objects again ─────
        var srcTa = h('textarea', 'code'); srcTa.rows = 18; srcTa.spellcheck = false; srcTa.style.flex = '1'; var srcRow = h('div', 'row'), bApply = h('button', 'pri', '▶ 套用原始碼'), bRe = h('button', null, '↻ 重新產生'), srcSt = h('span', 'st'); [bApply, bRe, srcSt].forEach(function (x) { srcRow.appendChild(x); });
        srcWrap.appendChild(h('div', 'st', '整張圖的 SVG。改完按「套用原始碼」：最上層的每個元素會變成一個物件（名字從 data-name／id 來；用形狀工具畫的形狀會變成「圖形」物件）。'));
        srcWrap.appendChild(srcTa); srcWrap.appendChild(srcRow);
        function composeForSource() { return C.compose(spec, { resolve: function (r) { return 'ref:' + r; } }); }
        function refreshSource() { if (document.activeElement !== srcTa) { srcTa.value = composeForSource(); } }
        bRe.onclick = function () { srcTa.value = composeForSource(); srcSt.textContent = ''; };
        bApply.onclick = function () {
          var text = srcTa.value; if (text === composeForSource()) { srcSt.textContent = '沒有改動'; return; }
          var d = C.decompose(text, spec.canvas); if (!d.ok) { srcSt.className = 'st bad'; srcSt.textContent = d.error; return; }
          var objs = d.objects.map(function (o) { var m = /^<g[^>]*>\s*<image x="(-?[\d.]+)" y="(-?[\d.]+)" width="([\d.]+)" height="([\d.]+)"[^>]*href="ref:([A-Za-z0-9_-]+)"/.exec(o.markup); return m ? { type: 'image', name: o.name, ref: m[5], x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) } : o; });
          var r = C.validate({ title: spec.title, canvas: d.canvas, objects: objs });
          if (!r.spec.objects.length) { srcSt.className = 'st bad'; srcSt.textContent = '沒有可用的物件：' + (r.problems[0] || ''); return; }
          ctx.commit(r.spec, '改寫原始碼（' + r.spec.objects.length + ' 個物件）', '', 'panel'); srcSt.className = 'st'; srcSt.textContent = '已套用' + (r.problems.length ? '（略過 ' + r.problems.length + ' 個不能用的元素）' : '');
        };
        return {
          tabs: { canvas: viewEl, source: srcWrap },
          env: function () { var v = vp.view(); return { view: { x: v.x, y: v.y, w: v.w, h: v.h } }; },
          refresh: function (s, selId) {
            spec = s; sel = selId;
            var b = C.bounds(s), c = s.canvas; var all = b ? { x: Math.min(b.x, c.x), y: Math.min(b.y, c.y), w: Math.max(b.x + b.w, c.x + c.w) - Math.min(b.x, c.x), h: Math.max(b.y + b.h, c.y + c.h) - Math.min(b.y, c.y) } : { x: c.x, y: c.y, w: c.w, h: c.h };
            vp.setBounds(all); var first = s.objects[0] ? C.types[s.objects[0].type].bbox(s.objects[0]) : null; vp.setHome(first || { x: c.x, y: c.y, w: c.w, h: c.h });
            draw(); ctx.setProps(props()); refreshSource();
          },
          showTab: function (t) { if (t === 'source') { srcTa.value = composeForSource(); } else { draw(); } },
          vp: vp, destroy: function () { vp.destroy(); }
        };
      }
    });
  }
  return { mount: mount, rasterize: rasterize };
});
