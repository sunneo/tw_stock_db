// The middle viewer of the editors (/edit-svg, /edit-picture): an ENDLESS plane for the user to look at -- real scrollbars, drag the view (hand tool, Space + drag, middle button, or a drag on the empty
// background), zoom (Ctrl/Cmd + wheel around the pointer, buttons, 100 %, fit). There is no boundary: the scrollable area grows when the user scrolls near an edge, and fit() / center() can bring
// any far-away content into view, because the chat may add content anywhere.
//
// Only the VISIBLE part is ever drawn: the editor draws into `vp.layer` (a sticky layer the size of the visible area) from the rectangle in WORLD units that the viewport reports, so a huge
// coordinate or a high zoom never makes a huge element.
//
//   var vp = FaEditViewport.create({ onView(view), handle(ev) -> true when the editor took the pointer (an object drag), background:'#eef' });
//   vp.el (put it somewhere)   vp.layer (draw here)   vp.view() -> { x, y, w, h, z, cw, ch }   world rectangle that is visible, zoom, and the size of the visible area in px
//   vp.setBounds({x,y,w,h}|null)  the content box (the plane is at least this big, plus a margin)    vp.zoomTo(z, clientX?, clientY?)    vp.fit(rect, pad, maxZoom?)    vp.center(x, y)    vp.toWorld(clientX, clientY)
//   vp.setHome({x,y,w,h}|null)  the HOME of the view: the first object (the picture); the ⌖ button and goHome() bring the view back to its middle with all of it in sight, wherever the user dragged to
//   vp.setTool('hand'|'select')   vp.refresh()   vp.destroy()
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaEditViewport = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var MARGIN = 1500, GROW = 1500, EDGE = 160, MAXPX = 8e6, MINZ = 0.02, MAXZ = 64;
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  var CSS = '.tw-vp-wrap{position:relative;flex:1;min-height:0;min-width:0;display:flex;overflow:hidden}.tw-vp{position:relative;flex:1;min-height:0;min-width:0;overflow:auto;background:var(--vp-bg,#eef0f3);outline:none}'
    + '.tw-vp.hand,.tw-vp.hand *{cursor:grab!important}.tw-vp.panning,.tw-vp.panning *{cursor:grabbing!important;user-select:none}'
    + '.tw-vp-inner{position:relative}.tw-vp-layer{position:sticky;top:0;left:0;overflow:hidden}'
    + '.tw-vp-bar{position:absolute;right:14px;bottom:14px;display:flex;gap:4px;align-items:center;background:rgba(255,255,255,.92);border:1px solid #c8ccd2;border-radius:7px;padding:3px 5px;font:12px system-ui,sans-serif;color:#333;box-shadow:0 1px 5px rgba(0,0,0,.18)}'
    + '.tw-vp-bar button{background:#fff;border:1px solid #c8ccd2;border-radius:4px;padding:1px 7px;cursor:pointer;font:inherit;color:#333}.tw-vp-bar button.on{background:#dbe8ff;border-color:#5b8def}.tw-vp-bar span{min-width:44px;text-align:center}'
    + '@media (prefers-color-scheme: dark){.tw-vp{--vp-bg:#1b1f26}}';
  function css() { if (typeof document === 'undefined' || document.getElementById('tw-vp-css')) { return; } var s = document.createElement('style'); s.id = 'tw-vp-css'; s.textContent = CSS; document.head.appendChild(s); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) { e.className = cls; } if (text != null) { e.textContent = text; } return e; }

  function create(opt) {
    opt = opt || {}; css();
    var wrap = el('div', 'tw-vp-wrap'), sc = el('div', 'tw-vp'), inner = el('div', 'tw-vp-inner'), layer = el('div', 'tw-vp-layer'), bar = el('div', 'tw-vp-bar');
    sc.tabIndex = 0; if (opt.background) { sc.style.setProperty('--vp-bg', opt.background); }
    inner.appendChild(layer); sc.appendChild(inner); wrap.appendChild(sc); wrap.appendChild(bar);
    var home = null, z = 1, ext = { minX: -MARGIN, minY: -MARGIN, maxX: MARGIN, maxY: MARGIN }, bounds = null, tool = 'select', space = false, guard = false, raf = 0, dead = false;
    var bMinus = el('button', '', '−'), lbl = el('span', '', '100%'), bPlus = el('button', '', '+'), bOne = el('button', '', '1:1'), bFit = el('button', '', '⤢'), bHand = el('button', '', '✋'), bHome = el('button', '', '⌖');
    bMinus.title = 'Zoom out'; bPlus.title = 'Zoom in'; bOne.title = '100%'; bFit.title = 'Fit the content'; bHand.title = 'Hand: drag the view (or hold Space, or use the middle button)'; bHome.title = 'Back to the middle of the picture (the first object)';
    [bHand, bMinus, lbl, bPlus, bOne, bFit, bHome].forEach(function (b) { bar.appendChild(b); });

    function cw() { return Math.max(1, sc.clientWidth); } function ch() { return Math.max(1, sc.clientHeight); }
    function sizeInner() {
      var w = Math.max((ext.maxX - ext.minX) * z, cw() + 1), h = Math.max((ext.maxY - ext.minY) * z, ch() + 1);
      inner.style.width = Math.round(w) + 'px'; inner.style.height = Math.round(h) + 'px';
      layer.style.width = cw() + 'px'; layer.style.height = ch() + 'px'; layer.style.marginBottom = -ch() + 'px';
    }
    function view() { return { x: ext.minX + sc.scrollLeft / z, y: ext.minY + sc.scrollTop / z, w: cw() / z, h: ch() / z, z: z, cw: cw(), ch: ch() }; }
    function notify() { lbl.textContent = Math.round(z * 100) + '%'; if (opt.onView) { opt.onView(view()); } }
    function schedule() { if (raf || dead) { return; } raf = (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : function (f) { return setTimeout(f, 16); })(function () { raf = 0; if (!dead) { notify(); } }); }
    // the plane always covers the content, what is shown, and a margin around both; it only ever grows (no jumps)
    function include(x0, y0, x1, y1) {
      var dl = 0, dt = 0;
      if (x0 - MARGIN < ext.minX) { dl = (ext.minX - (x0 - MARGIN)); ext.minX = x0 - MARGIN; }
      if (y0 - MARGIN < ext.minY) { dt = (ext.minY - (y0 - MARGIN)); ext.minY = y0 - MARGIN; }
      if (x1 + MARGIN > ext.maxX) { ext.maxX = x1 + MARGIN; } if (y1 + MARGIN > ext.maxY) { ext.maxY = y1 + MARGIN; }
      return { dl: dl * z, dt: dt * z };
    }
    function limitZoom(v) { var span = Math.max(ext.maxX - ext.minX, ext.maxY - ext.minY, 1); return clamp(v, MINZ, Math.min(MAXZ, MAXPX / span)); }
    function setBounds(b) {
      bounds = b && isFinite(b.x + b.y + b.w + b.h) ? { x: b.x, y: b.y, w: b.w, h: b.h } : null;
      if (bounds) { var g = include(bounds.x, bounds.y, bounds.x + bounds.w, bounds.y + bounds.h); sizeInner(); if (g.dl || g.dt) { guard = true; sc.scrollLeft += g.dl; sc.scrollTop += g.dt; guard = false; } }
      schedule();
    }
    function zoomTo(nz, cx, cy) {
      nz = limitZoom(nz); if (!isFinite(nz) || nz === z) { return; }
      if (cx == null) { cx = cw() / 2; cy = ch() / 2; }
      var wx = ext.minX + (sc.scrollLeft + cx) / z, wy = ext.minY + (sc.scrollTop + cy) / z;
      z = nz; sizeInner(); guard = true; sc.scrollLeft = (wx - ext.minX) * z - cx; sc.scrollTop = (wy - ext.minY) * z - cy; guard = false; schedule();
    }
    function center(x, y) {
      var g = include(x, y, x, y); sizeInner(); guard = true; sc.scrollLeft += g.dl; sc.scrollTop += g.dt; sc.scrollLeft = (x - ext.minX) * z - cw() / 2; sc.scrollTop = (y - ext.minY) * z - ch() / 2; guard = false; schedule();
    }
    function fit(rect, pad, maxZoom) {
      rect = rect || bounds || { x: 0, y: 0, w: 800, h: 600 }; pad = pad == null ? 40 : pad;
      include(rect.x, rect.y, rect.x + rect.w, rect.y + rect.h); z = limitZoom(Math.min(cw() / (rect.w + 2 * pad), ch() / (rect.h + 2 * pad), maxZoom || 8)); sizeInner(); center(rect.x + rect.w / 2, rect.y + rect.h / 2);
    }
    function setHome(r) { home = r && isFinite(r.x + r.y + r.w + r.h) ? { x: r.x, y: r.y, w: Math.max(1, r.w), h: Math.max(1, r.h) } : null; }
    function goHome() { if (home) { fit(home, 40, 2); } else { var b = bounds || { x: 0, y: 0, w: 800, h: 600 }; fit(b, 40, 2); } }
    function toWorld(clientX, clientY) { var r = sc.getBoundingClientRect(); return { x: ext.minX + (sc.scrollLeft + clientX - r.left) / z, y: ext.minY + (sc.scrollTop + clientY - r.top) / z }; }
    // the endless part: scrolling close to an edge makes more plane on that side
    sc.addEventListener('scroll', function () {
      if (guard) { return; }
      var grew = false;
      if (sc.scrollLeft < EDGE) { ext.minX -= GROW; sizeInner(); guard = true; sc.scrollLeft += GROW * z; guard = false; grew = true; }
      if (sc.scrollTop < EDGE) { ext.minY -= GROW; sizeInner(); guard = true; sc.scrollTop += GROW * z; guard = false; grew = true; }
      if (sc.scrollWidth - sc.scrollLeft - sc.clientWidth < EDGE) { ext.maxX += GROW; grew = true; }
      if (sc.scrollHeight - sc.scrollTop - sc.clientHeight < EDGE) { ext.maxY += GROW; grew = true; }
      if (grew) { sizeInner(); }
      schedule();
    });
    sc.addEventListener('wheel', function (ev) {
      if (!(ev.ctrlKey || ev.metaKey)) { return; }
      ev.preventDefault(); var r = sc.getBoundingClientRect(); zoomTo(z * Math.exp(-ev.deltaY * 0.0018), ev.clientX - r.left, ev.clientY - r.top);
    }, { passive: false });
    // dragging the view
    var pan = null;
    layer.addEventListener('pointerdown', function (ev) {
      var hand = tool === 'hand' || space || ev.button === 1;
      if (!hand && opt.handle && opt.handle(ev) === true) { return; }
      if (ev.button !== 0 && ev.button !== 1) { return; }
      pan = { x: ev.clientX, y: ev.clientY, l: sc.scrollLeft, t: sc.scrollTop, moved: false, id: ev.pointerId }; sc.classList.add('panning');
      try { layer.setPointerCapture(ev.pointerId); } catch (e) { /* no capture */ }
      ev.preventDefault();
    });
    layer.addEventListener('pointermove', function (ev) { if (!pan) { return; } var dx = ev.clientX - pan.x, dy = ev.clientY - pan.y; if (Math.abs(dx) + Math.abs(dy) > 2) { pan.moved = true; } sc.scrollLeft = pan.l - dx; sc.scrollTop = pan.t - dy; });
    function endPan(ev) { if (!pan) { return; } var moved = pan.moved; pan = null; sc.classList.remove('panning'); try { layer.releasePointerCapture(ev.pointerId); } catch (e) { /* none */ } if (!moved && opt.onBackgroundClick) { opt.onBackgroundClick(ev); } }
    layer.addEventListener('pointerup', endPan); layer.addEventListener('pointercancel', endPan);
    function key(down) { return function (ev) { if (ev.code === 'Space' && (ev.target === sc || sc.contains(ev.target)) && !/^(input|textarea|select)$/i.test(ev.target.tagName)) { space = down; sc.classList.toggle('hand', down || tool === 'hand'); if (down) { ev.preventDefault(); } } }; }
    var kd = key(true), ku = key(false); sc.addEventListener('keydown', kd); sc.addEventListener('keyup', ku);
    function setTool(t) { tool = t === 'hand' ? 'hand' : 'select'; bHand.classList.toggle('on', tool === 'hand'); sc.classList.toggle('hand', tool === 'hand'); }
    bHand.onclick = function () { setTool(tool === 'hand' ? 'select' : 'hand'); };
    bMinus.onclick = function () { zoomTo(z / 1.25); }; bPlus.onclick = function () { zoomTo(z * 1.25); }; bOne.onclick = function () { zoomTo(1); };
    bFit.onclick = function () { fit(bounds || null); }; bHome.onclick = goHome;
    var ro = typeof ResizeObserver === 'function' ? new ResizeObserver(function () { sizeInner(); schedule(); }) : null; if (ro) { ro.observe(sc); }
    sizeInner();
    // centre on the origin region at first
    (typeof setTimeout === 'function' ? setTimeout : function (f) { f(); })(function () { if (dead) { return; } sizeInner(); if (home || bounds) { goHome(); } else { guard = true; sc.scrollLeft = (0 - ext.minX) * z - cw() / 4; sc.scrollTop = (0 - ext.minY) * z - ch() / 4; guard = false; } notify(); }, 0);
    return {
      el: wrap, layer: layer, scroller: sc, view: view, setBounds: setBounds, setHome: setHome, goHome: goHome, zoomTo: zoomTo, fit: fit, center: center, toWorld: toWorld, setTool: setTool, refresh: function () { sizeInner(); notify(); },
      zoom: function () { return z; }, panning: function () { return !!pan; }, extent: function () { return { x: ext.minX, y: ext.minY, w: ext.maxX - ext.minX, h: ext.maxY - ext.minY }; },
      destroy: function () { dead = true; if (ro) { ro.disconnect(); } sc.removeEventListener('keydown', kd); sc.removeEventListener('keyup', ku); }
    };
  }
  return { create: create };
});
