// GUI bridge renderer: turns one window snapshot (from AiChatGuiBridge.snapshot) into DOM nodes. It only creates elements and sets
// textContent / value / attributes -- never innerHTML -- so program text can never become markup. The document is passed in, so the
// same code runs in the page (document) and in node tests (a recording fake). Events go out through onEvent(name, nodeId, value).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { root.AiChatGuiRender = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Paints one canvas frame (the draw commands the bridge stored, already checked) with a 2d context. Only fill, stroke and image
  // calls, so the program's text goes through fillText and never through markup. lookup(name) gives a decoded picture (an Image the
  // host has loaded) or null; a picture that is not decoded yet is skipped.
  function paintFrame(ctx, ops, w, h, lookup) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    ops.forEach(function (op) {
      var name = op[0], color = op[op.length - 1];
      if (name === 'clear') { ctx.fillStyle = color; ctx.fillRect(0, 0, w, h); }
      else if (name === 'rect') { ctx.fillStyle = color; ctx.fillRect(op[1], op[2], op[3], op[4]); }
      else if (name === 'circle') { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(op[1], op[2], op[3], 0, Math.PI * 2); ctx.fill(); }
      else if (name === 'line') { ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(op[1], op[2]); ctx.lineTo(op[3], op[4]); ctx.stroke(); }
      else if (name === 'text') { ctx.fillStyle = color; ctx.font = '14px sans-serif'; ctx.fillText(op[3], op[1], op[2]); }
      else if (name === 'image') {
        var pic = lookup ? lookup(op[1]) : null;
        if (!pic) { return; }
        if (op.length === 6) { ctx.drawImage(pic, op[2], op[3], op[4], op[5]); } else { ctx.drawImage(pic, op[2], op[3]); }
      }
    });
  }

  // keys the game uses for movement: the page must not scroll while the canvas has focus
  var GAME_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '];

  // A canvas with fps > 0 sends "frame" events on the page clock. The timer stops once the window is no longer in the page.
  function startFrames(doc, el, id, fps, onEvent) {
    var win = doc.defaultView;
    if (!win || !win.setInterval || !(fps > 0)) { return; }
    var timer = win.setInterval(function () {
      if (el.isConnected === false) { win.clearInterval(timer); return; }
      onEvent('frame', id, { t: Date.now() });
    }, Math.round(1000 / fps));
  }

  // opts.image(nodeId, name) gives the decoded picture of a canvas (see paintFrame); without it no picture is drawn
  function renderNode(doc, n, onEvent, opts) {
    var el;
    function on(type, fn) { el.addEventListener(type, fn); }
    function label(text) { var s = doc.createElement('span'); s.textContent = text; return s; }
    switch (n.kind) {
      case 'column': case 'row':
        el = doc.createElement('div');
        el.className = 'gui-' + n.kind;
        break;
      case 'label':
        el = label(n.text || '');
        el.className = 'gui-label';
        break;
      case 'button':
        el = doc.createElement('button');
        el.type = 'button';
        el.className = 'gui-button';
        el.textContent = n.text || '';
        el.disabled = n.enabled === false;
        on('click', function () { onEvent('click', n.id); });
        break;
      case 'entry':
        el = doc.createElement('input');
        el.type = n.secret ? 'password' : 'text';
        el.className = 'gui-entry';
        el.value = n.value || '';
        el.placeholder = n.placeholder || '';
        el.disabled = n.enabled === false;
        on('input', function () { onEvent('input', n.id, el.value); });
        break;
      case 'textarea':
        el = doc.createElement('textarea');
        el.className = 'gui-textarea';
        el.value = n.value || '';
        el.placeholder = n.placeholder || '';
        el.rows = n.rows || 3;
        el.disabled = n.enabled === false;
        on('input', function () { onEvent('input', n.id, el.value); });
        break;
      case 'checkbox':
        el = doc.createElement('label');
        el.className = 'gui-checkbox';
        var box = doc.createElement('input');
        box.type = 'checkbox';
        box.checked = !!n.checked;
        box.disabled = n.enabled === false;
        box.addEventListener('change', function () { onEvent('change', n.id, box.checked); });
        el.appendChild(box);
        el.appendChild(label(n.text || ''));
        break;
      case 'progress':
        el = doc.createElement('progress');
        el.className = 'gui-progress';
        el.max = n.max || 100;
        el.value = n.value || 0;
        break;
      case 'list':
        el = doc.createElement('select');
        el.className = 'gui-list';
        el.size = Math.min(8, Math.max(2, (n.items || []).length));
        el.disabled = n.enabled === false;
        (n.items || []).forEach(function (text) {
          var o = doc.createElement('option');
          o.textContent = text;
          o.value = text;
          o.selected = text === n.selected;
          el.appendChild(o);
        });
        on('change', function () { onEvent('select', n.id, el.value); });
        break;
      case 'expander':
        el = doc.createElement('details');
        el.className = 'gui-expander';
        el.open = !!n.expanded;
        var summary = doc.createElement('summary');
        summary.textContent = n.text || '';
        el.appendChild(summary);
        el.addEventListener('toggle', function () { onEvent('toggle', n.id, el.open); });
        break;
      case 'editor':
        el = doc.createElement('textarea');
        el.className = 'gui-editor';
        el.spellcheck = false;
        el.value = n.value || '';
        el.rows = n.rows || 8;
        el.disabled = n.enabled === false;
        // Tab inserts two spaces instead of leaving the editor (a code editor, not a form field)
        el.addEventListener('keydown', function (e) {
          if (e.key !== 'Tab' || e.shiftKey) { return; }
          e.preventDefault();
          var s = el.selectionStart, t = el.selectionEnd;
          el.value = el.value.slice(0, s) + '  ' + el.value.slice(t);
          el.selectionStart = el.selectionEnd = s + 2;
          onEvent('input', n.id, el.value);
        });
        on('input', function () { onEvent('input', n.id, el.value); });
        break;
      case 'multilist':
        el = doc.createElement('select');
        el.className = 'gui-list';
        el.multiple = true;
        el.size = Math.min(8, Math.max(2, (n.items || []).length));
        el.disabled = n.enabled === false;
        (n.items || []).forEach(function (text) {
          var o = doc.createElement('option');
          o.textContent = text;
          o.value = text;
          o.selected = (n.selected || []).indexOf(text) >= 0;
          el.appendChild(o);
        });
        on('change', function () {
          var picked = [];
          for (var i = 0; i < el.options.length; i++) { if (el.options[i].selected) { picked.push(el.options[i].value); } }
          onEvent('select', n.id, picked);
        });
        break;
      case 'table':
        // cells are text inputs; a change sends {row, col, text} (the row and column indexes are the ones drawn here)
        el = doc.createElement('table');
        el.className = 'gui-table';
        var head = doc.createElement('tr');
        (n.columns || []).forEach(function (c) { var th = doc.createElement('th'); th.textContent = c; head.appendChild(th); });
        var thead = doc.createElement('thead');
        thead.appendChild(head);
        el.appendChild(thead);
        var tbody = doc.createElement('tbody');
        (n.rows || []).forEach(function (r, ri) {
          var tr = doc.createElement('tr');
          r.forEach(function (v, ci) {
            var td = doc.createElement('td'), cell = doc.createElement('input');
            cell.type = 'text';
            cell.className = 'gui-cell';
            cell.value = v;
            cell.disabled = n.enabled === false;
            cell.addEventListener('change', function () { onEvent('cell', n.id, { row: ri, col: ci, text: cell.value }); });
            td.appendChild(cell);
            tr.appendChild(td);
          });
          tbody.appendChild(tr);
        });
        el.appendChild(tbody);
        break;
      case 'canvas':
        el = doc.createElement('canvas');
        el.className = 'gui-canvas';
        el.width = n.width || 320;
        el.height = n.height || 240;
        el.tabIndex = 0; // focusable, so key presses reach it
        if (opts && opts.resizable) {
          // in a resizable window the canvas fills the window and gets one pixel per screen pixel; its new size goes back as "resize"
          el.style.cssText = 'display:block;width:100%;min-height:0;flex:1 1 auto;height:' + el.height + 'px;';
          var fit = function () {
            var w = Math.round(el.clientWidth), h = Math.round(el.clientHeight);
            if (w >= 16 && h >= 16 && (w !== el.width || h !== el.height)) {
              el.width = w; el.height = h;
              onEvent('resize', n.id, { width: w, height: h });
            }
          };
          if (typeof ResizeObserver !== 'undefined') { new ResizeObserver(fit).observe(el); }
        }
        paintFrame(el.getContext('2d'), n.frame || [], el.width, el.height, function (name) { return opts && opts.image ? opts.image(n.id, name) : null; });
        on('keydown', function (e) {
          if (GAME_KEYS.indexOf(e.key) >= 0) { e.preventDefault(); }
          onEvent('key', n.id, { key: e.key, down: true });
        });
        on('keyup', function (e) { onEvent('key', n.id, { key: e.key, down: false }); });
        // the pointer, in canvas pixels (the canvas may be drawn smaller than its size)
        function pointer(kind) {
          return function (e) {
            // the pointer goes to the game only after a click into the window (same rule as the wheel): hovering or dragging elsewhere sends nothing
            if (!el.closest || !el.closest('.ai-chat-wheel-on')) { return; }
            var r = el.getBoundingClientRect();
            var sx = r.width ? el.width / r.width : 1, sy = r.height ? el.height / r.height : 1;
            onEvent('mouse', n.id, { kind: kind, x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy, button: e.button || 0 });
          };
        }
        on('mousedown', pointer('down'));
        on('mouseup', pointer('up'));
        on('mousemove', pointer('move'));
        // the wheel: scrolls the game, not the page (the page is not scrolled while the canvas has the wheel)
        el.addEventListener('wheel', function (e) {
          // only after a click into the GUI layer (ai_chat_scroll_focus.js sets ai-chat-wheel-on): before that the page scrolls, Ctrl+wheel zooms the browser
          if (!el.closest || !el.closest('.ai-chat-wheel-on')) { return; }
          // a plain wheel always scrolls the page; Ctrl+wheel is the game's zoom (the browser's own Ctrl+wheel zoom is taken over here)
          if (!e.ctrlKey) { return; }
          e.preventDefault();
          var r = el.getBoundingClientRect();
          var sx = r.width ? el.width / r.width : 1, sy = r.height ? el.height / r.height : 1;
          onEvent('wheel', n.id, { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy, dy: e.deltaY });
        }, { passive: false });
        startFrames(doc, el, n.id, n.fps || 0, onEvent);
        break;
      default:
        throw new Error('unknown GUI kind "' + n.kind + '"');
    }
    el.setAttribute('data-node', n.id);
    if (n.visible === false) { el.hidden = true; }
    (n.children || []).forEach(function (c) { el.appendChild(renderNode(doc, c, onEvent, opts)); });
    return el;
  }

  // maximize fills the window's box (the terminal's area); the first click remembers the place and size, the next one restores them
  function toggleMaximize(win, button) {
    var box = win.parentNode && (win.parentNode.offsetParent || win.parentNode);
    if (!box) { return; }
    if (win.getAttribute('data-saved')) {
      var s = JSON.parse(win.getAttribute('data-saved'));
      win.style.left = s.left; win.style.top = s.top; win.style.width = s.width; win.style.height = s.height; win.style.maxWidth = s.maxWidth;
      win.removeAttribute('data-saved');
      button.textContent = '□';
    } else {
      // the size in pixels as it is now (the style may be empty or auto, and a canvas that grew has widened the window)
      win.setAttribute('data-saved', JSON.stringify({ left: win.style.left, top: win.style.top, width: (win.offsetWidth || parseFloat(win.style.width) || 0) + 'px', height: win.style.height || (win.offsetHeight ? win.offsetHeight + 'px' : ''), maxWidth: win.style.maxWidth }));
      win.style.left = '0px'; win.style.top = '0px'; win.style.maxWidth = 'none';
      win.style.width = box.clientWidth + 'px'; win.style.height = box.clientHeight + 'px';
      button.textContent = '❐';
    }
  }

  // snapshot = { id, title, width, resizable, maximizable, root }; onEvent(name, nodeId, value) is called for user actions in the window;
  // opts (optional) = { image(nodeId, name) } for the pictures of the canvases
  var CONTROL_BUTTON_CSS = 'border:none;background:transparent;cursor:pointer;font:14px sans-serif;line-height:1;padding:2px 7px;border-radius:4px;color:#222;';
  function renderWindow(doc, snap, onEvent, onClose, opts) {
    var win = doc.createElement('div');
    win.className = 'gui-window';
    win.setAttribute('data-window', snap.id);
    win.style.width = snap.width + 'px';
    var bar = doc.createElement('div');
    bar.className = 'gui-titlebar';
    // the title on the left, the control buttons on the right (close last), like any desktop window
    bar.style.cssText = 'display:flex;align-items:center;gap:2px;padding:3px 4px 3px 8px;background:#e9e9ee;border-bottom:1px solid #b5b5bd;border-radius:6px 6px 0 0;user-select:none;flex:0 0 auto;';
    var title = doc.createElement('span');
    title.textContent = snap.title;
    title.style.cssText = 'flex:1 1 auto;min-width:0;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    var close = doc.createElement('button');
    close.type = 'button';
    close.className = 'gui-close';
    close.textContent = '×';
    close.style.cssText = CONTROL_BUTTON_CSS;
    close.addEventListener('click', function () { onClose(); });
    bar.appendChild(title);
    if (snap.maximizable) {
      var max = doc.createElement('button');
      max.type = 'button';
      max.className = 'gui-maximize';
      max.textContent = '□';
      max.style.cssText = CONTROL_BUTTON_CSS;
      max.addEventListener('click', function () { toggleMaximize(win, max); });
      bar.appendChild(max);
    }
    bar.appendChild(close);
    win.appendChild(bar);
    var body = renderNode(doc, Object.assign({}, snap.root, { id: 'root' }), onEvent, Object.assign({}, opts || {}, { resizable: !!snap.resizable }));
    if (snap.resizable) {
      // the window can be dragged bigger at its corner: the body takes the rest of the height, and its canvases fill it
      win.setAttribute('data-resizable', '1');
      body.style.cssText = 'display:flex;flex-direction:column;flex:1 1 auto;min-height:0;';
    }
    win.appendChild(body);
    return win;
  }

  return { CONTROL_BUTTON_CSS: CONTROL_BUTTON_CSS, renderWindow: renderWindow, paintFrame: paintFrame };
}));
