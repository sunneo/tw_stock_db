/* 專屬介面的「視窗外殼」（UMD）：讓對話裡的任何一個介面（終端機、檢視器、編輯器、sqlitebrowser、知識庫…）都能
 *   ⤢ 彈出成浮動視窗（拖曳標題列移動、八個邊角把手改大小）、☐ 最大化／❐ 還原（也可以雙擊標題列）、⤓ 收回對話裡。
 * 做法：元素**留在原本的位置**，只改成 position:fixed（原位留一個佔位提示）——不搬動 DOM，所以 iframe、canvas、WebGL、終端機都不會重新載入或掉狀態。
 * 如果祖先元素讓 position:fixed 失效（transform、filter 等會變成新的定位基準），自動改成搬到 document.body（那種情況 iframe 會重新載入）。
 * 彈出的狀態（位置、大小、有沒有最大化）依 id 記在 localStorage；重新整理後介面本身會從對話紀錄回來（停在對話內），要不要再彈出由使用者決定。
 *
 *   FaWin.decorate(el, { id, title, bar, minW, minH, floating, onChange }) → ctl
 *     bar：介面自己的標題列（有的話按鈕加在裡面、拿它當拖曳把手）；沒有就在元素右上角放一排小按鈕（滑過才明顯），彈出時多一條標題列。
 *     floating：true＝一開始就彈出。
 *   ctl: { pop(), dock(), maximize(on), toggleMax(), isPopped(), isMaximized(), destroy() }
 *   FaWin.registry：目前有外殼的元素（除錯與測試用）。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaWin = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var Z0 = 100000, zTop = Z0;
  var CSS = '.fwin-tools{position:absolute;top:3px;right:6px;z-index:6;display:flex;gap:3px;opacity:.25;transition:opacity .15s}.fwin-host:hover>.fwin-tools,.fwin-tools:focus-within{opacity:.95}.fwin-tools button,.fwin-title button,.fwin-btn{background:rgba(127,127,127,.18);color:inherit;border:1px solid rgba(127,127,127,.45);border-radius:5px;padding:0 6px;cursor:pointer;font:12px/20px system-ui,"Microsoft JhengHei",sans-serif;height:22px}.fwin-tools button:hover,.fwin-title button:hover,.fwin-btn:hover{border-color:#58a6ff}'
    + '.fwin-host{position:relative}.fwin-ph{border:1px dashed rgba(127,127,127,.6);border-radius:8px;padding:14px;color:#8b949e;font:13px system-ui,"Microsoft JhengHei",sans-serif;display:flex;align-items:center;gap:10px}'
    + '.fwin-host.fwin-pop{position:fixed!important;margin:0!important;box-shadow:0 10px 44px rgba(0,0,0,.5);border-radius:10px!important;overflow:hidden;max-width:none!important;max-height:none!important;box-sizing:border-box}.fwin-host.fwin-pop.fwin-max{border-radius:0!important;box-shadow:none}'
    + '.fwin-host.fwin-pop.fwin-notitle{padding-top:26px!important}.fwin-title{position:absolute;top:0;left:0;right:0;height:26px;z-index:6;display:flex;align-items:center;gap:6px;padding:2px 6px;background:rgba(33,38,45,.96);color:#e6edf3;cursor:move;user-select:none;font:12px system-ui,"Microsoft JhengHei",sans-serif}.fwin-title b{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}'
    + '.fwin-rz{position:absolute;z-index:7}.fwin-rz.n{top:0;left:8px;right:8px;height:5px;cursor:ns-resize}.fwin-rz.s{bottom:0;left:8px;right:8px;height:5px;cursor:ns-resize}.fwin-rz.e{right:0;top:8px;bottom:8px;width:5px;cursor:ew-resize}.fwin-rz.w{left:0;top:8px;bottom:8px;width:5px;cursor:ew-resize}.fwin-rz.ne{top:0;right:0;width:10px;height:10px;cursor:nesw-resize}.fwin-rz.nw{top:0;left:0;width:10px;height:10px;cursor:nwse-resize}.fwin-rz.se{bottom:0;right:0;width:14px;height:14px;cursor:nwse-resize}.fwin-rz.sw{bottom:0;left:0;width:10px;height:10px;cursor:nesw-resize}';
  var registry = [];
  function injectCss() { if (document.getElementById('fwin-css')) return; var s = document.createElement('style'); s.id = 'fwin-css'; s.textContent = CSS; (document.head || document.documentElement).appendChild(s); }
  function h(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  var isBtn = function (t) { return /^(BUTTON|INPUT|SELECT|TEXTAREA|A|LABEL)$/.test(t.tagName); };
  function load(id) { try { return id ? JSON.parse(localStorage.getItem('fwin:' + id) || 'null') : null; } catch (e) { return null; } }
  function save(id, st) { try { if (id) localStorage.setItem('fwin:' + id, JSON.stringify(st)); } catch (e) { /* 存不了就算了 */ } }

  function decorate(el, opts) {
    opts = opts || {}; injectCss(); if (el._fwin) return el._fwin;
    var MINW = opts.minW || 480, MINH = opts.minH || 300, id = opts.id || null, bar = opts.bar || null, titleText = opts.title || '';
    var popped = false, maxed = false, ph = null, saved = null, rect = null, rects = null, mode = null, rzDir = null, sx = 0, sy = 0, reparent = false, homeParent = null, homeNext = null, titleEl = null, handles = [], cleanup = null;
    el.classList.add('fwin-host'); if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    var bMax = h('button', null, '☐'), bPop = h('button', null, '⤢'); bMax.title = '最大化（也可以雙擊標題列）'; bPop.title = '彈出成可以拖曳、改大小的視窗';
    var tools = null;
    if (bar) { bar.appendChild(bMax); bar.appendChild(bPop); } else { tools = h('div', 'fwin-tools'); tools.appendChild(bMax); tools.appendChild(bPop); el.insertBefore(tools, el.firstChild); }
    function notify() { if (typeof opts.onChange === 'function') { try { opts.onChange({ popped: popped, maximized: maxed }); } catch (e) { /* */ } } }
    function front() { zTop += 1; el.style.zIndex = String(zTop); }
    function persist() { if (popped && rect) save(id, { rect: rect, maxed: maxed }); }
    function apply(r) { rect = r; el.style.left = r.left + 'px'; el.style.top = r.top + 'px'; el.style.width = r.width + 'px'; el.style.height = r.height + 'px'; }
    function clamp(r) { var W = window.innerWidth, H = window.innerHeight; var w = Math.max(Math.min(MINW, W), Math.min(r.width, W)), hh = Math.max(Math.min(MINH, H), Math.min(r.height, H)); return { left: Math.max(0, Math.min(W - Math.min(w, 120), r.left)), top: Math.max(0, Math.min(H - 40, r.top)), width: w, height: hh }; }
    function setMax(on) {
      if (!popped) { if (on) pop(); else return; } if (on === maxed) return; maxed = on;
      if (on) { rects = rect; el.classList.add('fwin-max'); apply({ left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }); bMax.textContent = '❐'; bMax.title = '還原'; handles.forEach(function (x) { x.style.display = 'none'; }); }
      else { el.classList.remove('fwin-max'); apply(clamp(rects || rect)); bMax.textContent = '☐'; bMax.title = '最大化（也可以雙擊標題列）'; handles.forEach(function (x) { x.style.display = ''; }); }
      persist(); notify();
    }
    function pop() {
      if (popped) { front(); return ctl; }
      var r = el.getBoundingClientRect(), st = load(id), start = clamp(st && st.rect ? st.rect : { left: Math.max(20, r.left), top: Math.max(20, Math.min(r.top, window.innerHeight - 420)), width: Math.max(MINW, Math.min(r.width, 960)), height: Math.max(MINH, Math.min(Math.max(r.height, 520), window.innerHeight - 40)) });
      saved = el.getAttribute('style') || ''; ph = h('div', 'fwin-ph'); ph.style.height = Math.min(Math.max(r.height, 60), 220) + 'px'; ph.appendChild(h('span', null, '📌 ' + (titleText || '這個介面') + ' 已彈出成視窗')); var back = h('button', 'fwin-btn', '⤓ 收回'); back.onclick = function () { dock(); }; ph.appendChild(back);
      homeParent = el.parentNode; homeNext = el.nextSibling; if (homeParent) homeParent.insertBefore(ph, el);
      el.classList.add('fwin-pop'); if (!bar) el.classList.add('fwin-notitle'); el.style.height = ''; popped = true; maxed = false; apply(start); front();
      // position:fixed 被祖先（transform／filter…）改成相對於祖先時，位置會不對：改搬到 document.body
      var chk = el.getBoundingClientRect(); if (Math.abs(chk.left - start.left) > 3 || Math.abs(chk.top - start.top) > 3) { reparent = true; document.body.appendChild(el); apply(start); }
      if (!bar) { titleEl = h('div', 'fwin-title'); titleEl.appendChild(h('b', null, titleText || '')); titleEl.appendChild(bMax); titleEl.appendChild(bPop); el.insertBefore(titleEl, el.firstChild); if (tools) tools.style.display = 'none'; }
      bPop.textContent = '⤓'; bPop.title = '收回對話裡'; var dragEl = bar || titleEl; if (dragEl) { dragEl.style.cursor = 'move'; }
      ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].forEach(function (d) { var x = h('div', 'fwin-rz ' + d); x.onmousedown = function (e) { if (maxed) return; mode = 'rz'; rzDir = d; sx = e.clientX; sy = e.clientY; rects = null; el._r0 = { l: rect.left, t: rect.top, w: rect.width, h: rect.height }; front(); e.preventDefault(); e.stopPropagation(); }; el.appendChild(x); handles.push(x); });
      var down = function (e) { if (maxed || isBtn(e.target)) return; mode = 'mv'; sx = e.clientX; sy = e.clientY; el._o = { l: rect.left, t: rect.top }; front(); e.preventDefault(); };
      var dbl = function (e) { if (isBtn(e.target)) return; setMax(!maxed); };
      if (dragEl) { dragEl.addEventListener('mousedown', down); dragEl.addEventListener('dblclick', dbl); }
      var mv = function (e) {
        if (!mode) return; var dx = e.clientX - sx, dy = e.clientY - sy;
        if (mode === 'mv') { apply({ left: Math.max(0, Math.min(window.innerWidth - 120, el._o.l + dx)), top: Math.max(0, Math.min(window.innerHeight - 40, el._o.t + dy)), width: rect.width, height: rect.height }); return; }
        var o = el._r0, L = o.l, T = o.t, W = o.w, H = o.h;
        if (rzDir.indexOf('e') >= 0) W = Math.max(MINW, Math.min(window.innerWidth - L, o.w + dx));
        if (rzDir.indexOf('s') >= 0) H = Math.max(MINH, Math.min(window.innerHeight - T, o.h + dy));
        if (rzDir.indexOf('w') >= 0) { var nw = Math.max(MINW, o.w - dx); L = Math.max(0, o.l + o.w - nw); W = o.l + o.w - L; }
        if (rzDir.indexOf('n') >= 0) { var nh = Math.max(MINH, o.h - dy); T = Math.max(0, o.t + o.h - nh); H = o.t + o.h - T; }
        apply({ left: L, top: T, width: W, height: H });
      };
      var up = function () { if (mode) { mode = null; persist(); } }, rs = function () { if (!popped) return; if (maxed) apply({ left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }); else apply(clamp(rect)); };
      var onDown = function () { front(); }; el.addEventListener('mousedown', onDown, true);
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up); window.addEventListener('resize', rs);
      cleanup = function () { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); window.removeEventListener('resize', rs); el.removeEventListener('mousedown', onDown, true); if (dragEl) { dragEl.removeEventListener('mousedown', down); dragEl.removeEventListener('dblclick', dbl); dragEl.style.cursor = ''; } };
      if (st && st.maxed) setMax(true);
      notify(); return ctl;
    }
    function dock() {
      if (!popped) return ctl; if (cleanup) cleanup(); cleanup = null; maxed = false; popped = false;
      handles.forEach(function (x) { x.remove(); }); handles = []; if (titleEl) { bMax.remove(); bPop.remove(); titleEl.remove(); titleEl = null; if (tools) { tools.style.display = ''; tools.appendChild(bMax); tools.appendChild(bPop); } else if (bar) { bar.appendChild(bMax); bar.appendChild(bPop); } }
      el.classList.remove('fwin-pop', 'fwin-max', 'fwin-notitle'); if (saved) el.setAttribute('style', saved); else el.removeAttribute('style'); if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
      if (reparent && ph && ph.parentNode) { ph.parentNode.insertBefore(el, ph); } reparent = false; if (ph) { ph.remove(); ph = null; }
      bMax.textContent = '☐'; bMax.title = '最大化（也可以雙擊標題列）'; bPop.textContent = '⤢'; bPop.title = '彈出成可以拖曳、改大小的視窗'; notify(); return ctl;
    }
    bPop.onclick = function () { if (popped) dock(); else pop(); }; bMax.onclick = function () { setMax(!maxed); };
    var ctl = { pop: pop, dock: dock, maximize: function (on) { setMax(on === undefined ? !maxed : !!on); return ctl; }, toggleMax: function () { setMax(!maxed); return ctl; }, isPopped: function () { return popped; }, isMaximized: function () { return maxed; }, setTitle: function (t) { titleText = t; if (titleEl && titleEl.firstChild) titleEl.firstChild.textContent = t; }, destroy: function () { if (popped) dock(); if (tools) tools.remove(); try { bMax.remove(); bPop.remove(); } catch (e) { /* */ } el.classList.remove('fwin-host'); delete el._fwin; var i = registry.indexOf(ctl); if (i >= 0) registry.splice(i, 1); }, el: el };
    el._fwin = ctl; registry.push(ctl); if (opts.floating) pop(); return ctl;
  }
  return { decorate: decorate, registry: registry };
});
