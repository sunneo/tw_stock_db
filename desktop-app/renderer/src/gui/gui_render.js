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

  // ---- design system: one stylesheet for every GUI window (colors come from the five palette variables, everything else is derived) ----
  // A window sets --gui-bg, --gui-fg, --gui-accent, --gui-danger, --gui-muted (applyTheme); surfaces, borders, hover and press states are mixed from
  // them, so any palette (light or dark) keeps the same look. Spacing is 4/8/12/16, text sizes are em steps of --gui-fs, radius is --gui-radius.
  // role="..." on a node picks a named look (toolbar, sidebar, statusbar, card, panel, heading, title, muted, primary, danger, ...).
  var GUI_CSS = [
    '.gui-window{--gui-bg:#ffffff;--gui-fg:#1f2328;--gui-accent:#2563eb;--gui-danger:#dc2626;--gui-muted:#6b7280;--gui-on-accent:#ffffff;',
    '--gui-radius:6px;--gui-fs:14px;--gui-s1:4px;--gui-s2:8px;--gui-s3:12px;--gui-s4:16px;',
    '--gui-surface:color-mix(in srgb,var(--gui-fg) 4%,var(--gui-bg));--gui-surface2:color-mix(in srgb,var(--gui-fg) 9%,var(--gui-bg));',
    '--gui-border:color-mix(in srgb,var(--gui-fg) 16%,var(--gui-bg));--gui-hover:color-mix(in srgb,var(--gui-fg) 8%,transparent);',
    '--gui-press:color-mix(in srgb,var(--gui-fg) 15%,transparent);--gui-accent-soft:color-mix(in srgb,var(--gui-accent) 16%,transparent);',
    '--gui-shadow:0 10px 32px rgba(0,0,0,.28);--gui-shadow-sm:0 1px 3px rgba(0,0,0,.14);--gui-ease:120ms ease;',
    "--gui-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono','Noto Sans Mono CJK TC',monospace;",
    "--gui-sans:system-ui,-apple-system,'Segoe UI','Microsoft JhengHei','Noto Sans TC',sans-serif;--gui-serif:Georgia,'Noto Serif TC','PMingLiU',serif;",
    '--gui-t-comment:#6a737d;--gui-t-string:#0a7f45;--gui-t-number:#b35900;--gui-t-keyword:#7c3aed;--gui-t-const:#b45309;--gui-t-fn:#1d4ed8;',
    '--gui-t-type:#0e7490;--gui-t-attr:#b45309;--gui-t-tag:#be185d;--gui-t-punct:#6b7280;--gui-t-key:#1d4ed8;--gui-t-heading:#be185d;--gui-t-link:#2563eb;',
    'font-family:var(--gui-font,var(--gui-sans));font-size:var(--gui-fs);line-height:1.45;color:var(--gui-fg);background:var(--gui-bg);',
    'display:flex;flex-direction:column;box-sizing:border-box;border:1px solid var(--gui-border);border-radius:calc(var(--gui-radius) + 2px);box-shadow:var(--gui-shadow);overflow:hidden}',
    '.gui-window[data-scheme=dark]{--gui-shadow:0 10px 36px rgba(0,0,0,.6);--gui-shadow-sm:0 1px 3px rgba(0,0,0,.5);',
    '--gui-t-comment:#7f8a99;--gui-t-string:#7ee0a1;--gui-t-number:#f0a35e;--gui-t-keyword:#c4a1ff;--gui-t-const:#f0a35e;--gui-t-fn:#79b8ff;',
    '--gui-t-type:#5fd3e0;--gui-t-attr:#f0b86e;--gui-t-tag:#ff7eb6;--gui-t-punct:#8b95a5;--gui-t-key:#79b8ff;--gui-t-heading:#ff7eb6;--gui-t-link:#79b8ff}',
    '.gui-window[data-density=compact]{--gui-s2:6px;--gui-s3:8px;--gui-s4:12px}.gui-window[data-density=comfy]{--gui-s2:10px;--gui-s3:16px;--gui-s4:22px}',
    '.gui-window *{box-sizing:border-box}.gui-window [hidden]{display:none!important}',
    '.gui-titlebar{display:flex;align-items:center;gap:2px;padding:6px 6px 6px 14px;background:var(--gui-surface);border-bottom:1px solid var(--gui-border);',
    'user-select:none;flex:0 0 auto;font-size:.93em;font-weight:600;letter-spacing:.01em}',
    '.gui-close:hover{background:var(--gui-danger)!important;color:#fff!important}.gui-maximize:hover{background:var(--gui-hover)!important}',
    '.gui-body{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;min-width:0;padding:var(--gui-s3);gap:var(--gui-s2);overflow:auto}',
    '.gui-body:has(>.gui-role-page){padding:0;gap:0;overflow:hidden}',
    '.gui-column,.gui-tab,.gui-scroll{display:flex;flex-direction:column;gap:var(--gui-s2);min-width:0}',
    '.gui-column>*,.gui-tab>*,.gui-scroll>*{flex-shrink:0}',
    '.gui-column>.gui-button,.gui-column>.gui-checkbox,.gui-column>.gui-label{align-self:flex-start}',
    '.gui-row{display:flex;flex-direction:row;align-items:center;gap:var(--gui-s2);min-width:0}',
    '.gui-row>.gui-entry{flex:1 1 0;min-width:0}.gui-row>.gui-label{min-width:0}',
    '.gui-grid{gap:var(--gui-s2)}.gui-scroll{overflow:auto}',
    '.gui-label{display:block}',
    '.gui-role-heading{font-size:1.15em;font-weight:600}.gui-role-title{font-size:1.6em;font-weight:700;letter-spacing:-.01em;line-height:1.25}',
    '.gui-label.gui-role-muted,.gui-role-muted{color:var(--gui-muted);font-size:.9em}.gui-label.gui-role-primary{color:var(--gui-accent);font-weight:600}',
    '.gui-label.gui-role-danger{color:var(--gui-danger);font-weight:600}',
    '.gui-label.gui-role-divider{align-self:stretch;width:1px;min-height:18px;margin:2px var(--gui-s1);background:var(--gui-border);overflow:hidden;color:transparent;flex:0 0 1px}',
    '.gui-column.gui-role-divider,.gui-row.gui-role-divider{height:1px;width:auto;background:var(--gui-border);padding:0;margin:var(--gui-s1) 0;flex:0 0 1px;align-self:stretch}',
    '.gui-role-page{flex:1 1 0%;min-height:0;display:flex;flex-direction:column;gap:0}',
    '.gui-role-toolbar{flex:0 0 auto;display:flex;flex-direction:row;align-items:center;gap:var(--gui-s1);padding:var(--gui-s2) var(--gui-s3);background:var(--gui-surface);border-bottom:1px solid var(--gui-border)}',
    '.gui-role-toolbar>.gui-entry{max-width:260px}.gui-role-toolbar>.gui-button{background:transparent;border-color:transparent}',
    '.gui-role-toolbar>.gui-button:hover:not(:disabled){background:var(--gui-hover)}.gui-role-toolbar>.gui-button:active:not(:disabled){background:var(--gui-press)}',
    '.gui-role-toolbar>.gui-button.gui-role-primary{background:var(--gui-accent);color:var(--gui-on-accent)}',
    '.gui-role-sidebar{flex:0 0 200px;width:200px;display:flex;flex-direction:column;gap:var(--gui-s1);padding:var(--gui-s3) var(--gui-s2);background:var(--gui-surface);border-right:1px solid var(--gui-border);overflow:auto;min-height:0}',
    '.gui-role-statusbar{flex:0 0 auto;display:flex;flex-direction:row;align-items:center;gap:var(--gui-s4);padding:var(--gui-s1) var(--gui-s3);background:var(--gui-surface);border-top:1px solid var(--gui-border);font-size:.86em;color:var(--gui-muted);min-height:26px}',
    '.gui-role-card{display:flex;flex-direction:column;gap:var(--gui-s2);padding:var(--gui-s3);background:var(--gui-surface);border:1px solid var(--gui-border);border-radius:var(--gui-radius);box-shadow:var(--gui-shadow-sm)}',
    '.gui-role-panel{padding:var(--gui-s3);background:var(--gui-surface)}.gui-role-surface{background:var(--gui-surface)}',
    '.gui-role-group{padding:var(--gui-s2) var(--gui-s3);border:1px solid var(--gui-border);border-radius:var(--gui-radius)}',
    '.gui-button{font:inherit;display:inline-flex;align-items:center;justify-content:center;gap:var(--gui-s1);padding:5px 14px;border:1px solid var(--gui-border);border-radius:var(--gui-radius);',
    'background:var(--gui-surface);color:var(--gui-fg);cursor:pointer;transition:background var(--gui-ease),border-color var(--gui-ease),box-shadow var(--gui-ease);white-space:nowrap}',
    '.gui-button:hover:not(:disabled){background:var(--gui-surface2);border-color:color-mix(in srgb,var(--gui-fg) 26%,var(--gui-bg))}',
    '.gui-button:active:not(:disabled){background:var(--gui-press)}.gui-button:disabled{opacity:.45;cursor:default}',
    '.gui-button:focus-visible,.gui-entry:focus-visible,.gui-textarea:focus-visible,.gui-list:focus-visible{outline:2px solid var(--gui-accent);outline-offset:1px}',
    '.gui-button.gui-role-primary{background:var(--gui-accent);border-color:var(--gui-accent);color:var(--gui-on-accent);font-weight:600}',
    '.gui-button.gui-role-primary:hover:not(:disabled){background:color-mix(in srgb,var(--gui-accent) 86%,var(--gui-fg));border-color:transparent}',
    '.gui-button.gui-role-primary:active:not(:disabled){background:color-mix(in srgb,var(--gui-accent) 72%,var(--gui-fg))}',
    '.gui-button.gui-role-danger{background:transparent;border-color:var(--gui-danger);color:var(--gui-danger)}',
    '.gui-button.gui-role-danger:hover:not(:disabled){background:var(--gui-danger);border-color:var(--gui-danger);color:#fff}',
    '.gui-button.gui-role-outline{background:transparent}',
    '.gui-entry,.gui-textarea,.gui-list,.gui-cell{font:inherit;color:var(--gui-fg);background:var(--gui-bg);border:1px solid var(--gui-border);border-radius:var(--gui-radius);padding:5px 9px;min-width:0;',
    'transition:border-color var(--gui-ease),box-shadow var(--gui-ease)}',
    '.gui-entry:hover:not(:disabled),.gui-textarea:hover:not(:disabled){border-color:color-mix(in srgb,var(--gui-fg) 30%,var(--gui-bg))}',
    '.gui-entry:focus,.gui-textarea:focus,.gui-list:focus{outline:none;border-color:var(--gui-accent);box-shadow:0 0 0 3px var(--gui-accent-soft)}',
    '.gui-entry::placeholder,.gui-textarea::placeholder{color:var(--gui-muted)}.gui-textarea{resize:vertical;line-height:1.5}',
    '.gui-list{padding:3px}.gui-list option{padding:3px 8px;border-radius:calc(var(--gui-radius) - 2px)}.gui-list option:checked{background:var(--gui-accent-soft);color:var(--gui-fg)}',
    '.gui-checkbox{display:inline-flex;align-items:center;gap:var(--gui-s2);cursor:pointer}.gui-checkbox input{accent-color:var(--gui-accent);width:15px;height:15px;margin:0}',
    '.gui-progress{width:100%;height:8px;appearance:none;border:none;border-radius:4px;overflow:hidden;background:var(--gui-surface2);accent-color:var(--gui-accent)}',
    '.gui-progress::-webkit-progress-bar{background:var(--gui-surface2)}.gui-progress::-webkit-progress-value{background:var(--gui-accent);transition:width 200ms ease}',
    '.gui-expander{border:1px solid var(--gui-border);border-radius:var(--gui-radius);padding:var(--gui-s1) var(--gui-s3);display:block}',
    '.gui-expander>summary{cursor:pointer;font-weight:600;padding:var(--gui-s1) 0}.gui-expander[open]>summary{margin-bottom:var(--gui-s2)}',
    '.gui-expander>*:not(summary){margin-bottom:var(--gui-s2)}',
    '.gui-tablebox{overflow:auto;border:1px solid var(--gui-border);border-radius:var(--gui-radius);min-height:0}',
    '.gui-table{border-collapse:separate;border-spacing:0;width:100%;font-size:.95em}',
    '.gui-table th{position:sticky;top:0;text-align:left;font-weight:600;padding:6px 10px;background:var(--gui-surface2);border-bottom:1px solid var(--gui-border);color:var(--gui-muted);font-size:.9em;letter-spacing:.02em}',
    '.gui-table td{padding:0;border-bottom:1px solid var(--gui-border)}.gui-table tr:last-child td{border-bottom:none}.gui-table tbody tr:hover{background:var(--gui-hover)}',
    '.gui-cell{border:none;border-radius:0;background:transparent;width:100%;padding:6px 10px}.gui-cell:focus{box-shadow:inset 0 0 0 2px var(--gui-accent)}',
    '.gui-tabs{display:flex;flex-direction:column;min-width:0;min-height:0}',
    '.gui-tabbar{display:flex;gap:2px;padding:0 var(--gui-s3);border-bottom:1px solid var(--gui-border);flex:0 0 auto;background:var(--gui-surface)}',
    '.gui-tabbar button{font:inherit;border:none;background:transparent;color:var(--gui-muted);padding:var(--gui-s2) var(--gui-s3);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;transition:color var(--gui-ease),background var(--gui-ease)}',
    '.gui-tabbar button:hover{color:var(--gui-fg);background:var(--gui-hover)}.gui-tabbar button.gui-tab-active{color:var(--gui-fg);border-bottom-color:var(--gui-accent);font-weight:600}',
    '.gui-tabs>.gui-tab{flex:1 1 0%;min-height:0;padding:var(--gui-s3);overflow:auto}',
    '.gui-split{display:flex;gap:1px;background:var(--gui-border);min-height:0;min-width:0}.gui-split>*{background:var(--gui-bg);min-width:0;min-height:0;overflow:auto}',
    '.gui-menubar{display:flex;gap:2px;padding:2px var(--gui-s2);background:var(--gui-surface);border-bottom:1px solid var(--gui-border);flex:0 0 auto;position:relative;z-index:5}',
    '.gui-menu{position:relative}.gui-menu>summary{list-style:none;padding:3px 10px;border-radius:calc(var(--gui-radius) - 1px);cursor:default;user-select:none}',
    '.gui-menu>summary::-webkit-details-marker{display:none}.gui-menu>summary:hover{background:var(--gui-hover)}.gui-menu[open]>summary{background:var(--gui-press)}',
    '.gui-menupanel{position:absolute;left:0;top:calc(100% + 2px);min-width:220px;display:flex;flex-direction:column;padding:4px;background:var(--gui-bg);',
    'border:1px solid var(--gui-border);border-radius:calc(var(--gui-radius) + 2px);box-shadow:var(--gui-shadow);z-index:30}',
    '.gui-menuitem{font:inherit;display:flex;align-items:center;gap:var(--gui-s4);width:100%;text-align:left;border:none;background:transparent;color:var(--gui-fg);padding:5px 10px;border-radius:calc(var(--gui-radius) - 1px);cursor:pointer}',
    '.gui-menuitem:hover:not(:disabled){background:var(--gui-accent);color:var(--gui-on-accent)}.gui-menuitem:disabled{opacity:.45}',
    '.gui-keys{margin-left:auto;opacity:.6;font-size:.88em}',
    '.gui-canvas{background:#000;border-radius:calc(var(--gui-radius) - 1px)}.gui-canvas-fit{background:var(--gui-surface2)}',
    // the editor: a line number gutter, a highlight layer under a transparent textarea (so it keeps native editing, undo and scrollbars)
    '.gui-editor{position:relative;display:flex;flex-direction:row;min-height:0;min-width:0;border:1px solid var(--gui-border);border-radius:var(--gui-radius);overflow:hidden;background:var(--gui-bg);',
    'font-family:var(--gui-mono);font-size:13px;line-height:20px}',
    '.gui-column>.gui-editor,.gui-row>.gui-editor{flex-shrink:0}',
    '.gui-ed-cur{position:absolute;left:0;right:0;height:20px;background:var(--gui-hover);pointer-events:none;top:0}',
    '.gui-ed-gutter{position:relative;flex:0 0 auto;overflow:hidden;background:var(--gui-surface);border-right:1px solid var(--gui-border);color:var(--gui-muted);text-align:right;user-select:none}',
    '.gui-ed-gutter pre,.gui-ed-hl{margin:0;font:inherit;line-height:20px;position:absolute;left:0;top:0;white-space:pre;will-change:transform}',
    '.gui-ed-gutter pre{right:0;padding:0 10px 0 8px}.gui-ed-gutter .gui-ed-now{color:var(--gui-fg);font-weight:600}',
    '.gui-ed-main{position:relative;flex:1 1 0;min-width:0;overflow:hidden}.gui-ed-hl{pointer-events:none;color:var(--gui-fg)}',
    '.gui-ed-ta{position:absolute;left:0;top:0;right:0;bottom:0;width:100%;height:100%;margin:0;border:none;outline:none;resize:none;padding:8px 12px 8px 8px;font:inherit;line-height:20px;',
    'white-space:pre;overflow:auto;background:transparent;color:transparent;caret-color:var(--gui-fg);tab-size:2;-moz-tab-size:2}',
    '.gui-ed-ta::selection{background:var(--gui-accent-soft);color:transparent}.gui-ed-ta:disabled{opacity:.6}',
    '.gui-tok-comment{color:var(--gui-t-comment);font-style:italic}.gui-tok-string{color:var(--gui-t-string)}.gui-tok-number{color:var(--gui-t-number)}',
    '.gui-tok-keyword{color:var(--gui-t-keyword)}.gui-tok-const{color:var(--gui-t-const)}.gui-tok-fn{color:var(--gui-t-fn)}.gui-tok-type{color:var(--gui-t-type)}',
    '.gui-tok-attr{color:var(--gui-t-attr)}.gui-tok-tag{color:var(--gui-t-tag)}.gui-tok-punct{color:var(--gui-t-punct)}.gui-tok-key{color:var(--gui-t-key)}',
    '.gui-tok-heading{color:var(--gui-t-heading);font-weight:700}.gui-tok-bold{font-weight:700}.gui-tok-italic{font-style:italic}',
    '.gui-tok-link{color:var(--gui-t-link);text-decoration:underline}.gui-tok-code{color:var(--gui-t-string)}.gui-tok-quote{color:var(--gui-t-comment)}',
    // scrollbars: thin, rounded, follow the palette
    '.gui-window ::-webkit-scrollbar{width:12px;height:12px}.gui-window ::-webkit-scrollbar-track{background:transparent}',
    '.gui-window ::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--gui-fg) 24%,transparent);border-radius:8px;border:3px solid transparent;background-clip:content-box}',
    '.gui-window ::-webkit-scrollbar-thumb:hover{background:color-mix(in srgb,var(--gui-fg) 42%,transparent);background-clip:content-box}.gui-window ::-webkit-scrollbar-corner{background:transparent}'
  ].join('\n');

  function ensureStyles(doc) {
    if (!doc || !doc.head || !doc.createElement || !doc.head.appendChild) { return; }
    if (doc.querySelector && doc.querySelector('style[data-gui-css]')) { return; }
    var st = doc.createElement('style');
    st.setAttribute('data-gui-css', '1');
    st.textContent = GUI_CSS;
    doc.head.appendChild(st);
  }

  // ---- syntax coloring: a small line tokenizer. tokenizeLine(lang, text, state) -> { tokens: [[class, text]...], state } where state carries a
  // multi-line construct (a block comment, a triple quoted string, a code fence, an open tag) into the next line. Tokens always join back to the text. ----
  var WORDS = {
    python: { kw: 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case', cs: 'True False None self cls __name__', bi: 'print len range int str float list dict set tuple bool open type isinstance enumerate zip map filter sorted min max sum abs any all super object input reversed round id repr format hasattr getattr setattr Exception ValueError TypeError KeyError' },
    javascript: { kw: 'async await break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch throw try typeof var void while with yield get set', cs: 'true false null undefined NaN Infinity this', bi: 'console window document Math JSON Object Array String Number Boolean Promise Map Set Date RegExp Error require module' }
  };
  Object.keys(WORDS).forEach(function (k) { ['kw', 'cs', 'bi'].forEach(function (f) { var m = {}; WORDS[k][f].split(' ').forEach(function (w) { m[w] = 1; }); WORDS[k][f] = m; }); });
  var LANG_ALIAS = { py: 'python', python3: 'python', js: 'javascript', jsx: 'javascript', ts: 'javascript', typescript: 'javascript', node: 'javascript', json: 'json', jsonl: 'json', md: 'markdown', markdown: 'markdown', htm: 'html', html: 'html', xml: 'html', svg: 'html', css: 'css', scss: 'css' };
  function pusher(out) {
    return function (cls, t) { if (!t) { return; } var l = out[out.length - 1]; if (l && l[0] === cls) { l[1] += t; } else { out.push([cls, t]); } };
  }
  // a quoted string starting at s[i] (the quote); returns the index after the closing quote, or -1 when the line ends first
  function endOfString(s, i, q) {
    for (var j = i + 1; j < s.length; j++) { if (s[j] === '\\') { j++; } else if (s[j] === q) { return j + 1; } }
    return -1;
  }
  function scanCode(lang, s, state) {
    var out = [], push = pusher(out), i = 0, n = s.length, py = lang === 'python', j, prevWord = '';
    if (state === 'cmt') {
      j = s.indexOf('*/');
      if (j < 0) { push('comment', s); return { tokens: out, state: 'cmt' }; }
      push('comment', s.slice(0, j + 2)); i = j + 2; state = '';
    } else if (state === 'q3d' || state === 'q3s' || state === 'tpl') {
      var close = state === 'q3d' ? '"""' : state === 'q3s' ? "'''" : '`';
      var k = 0, found = -1;
      for (; k < n; k++) { if (s[k] === '\\') { k++; } else if (s.substr(k, close.length) === close) { found = k; break; } }
      if (found < 0) { push('string', s); return { tokens: out, state: state }; }
      push('string', s.slice(0, found + close.length)); i = found + close.length; state = '';
    }
    while (i < n) {
      var c = s[i], m;
      if (py && c === '#') { push('comment', s.slice(i)); i = n; break; }
      if (!py && c === '/' && s[i + 1] === '/') { push('comment', s.slice(i)); i = n; break; }
      if (!py && c === '/' && s[i + 1] === '*') {
        j = s.indexOf('*/', i + 2);
        if (j < 0) { push('comment', s.slice(i)); state = 'cmt'; i = n; break; }
        push('comment', s.slice(i, j + 2)); i = j + 2; continue;
      }
      if (c === '"' || c === "'" || (!py && c === '`')) {
        if (py && s.substr(i, 3) === c + c + c) {
          var cl = c + c + c, e3 = -1;
          for (j = i + 3; j < n; j++) { if (s[j] === '\\') { j++; } else if (s.substr(j, 3) === cl) { e3 = j + 3; break; } }
          if (e3 < 0) { push('string', s.slice(i)); state = c === '"' ? 'q3d' : 'q3s'; i = n; break; }
          push('string', s.slice(i, e3)); i = e3; continue;
        }
        var e = endOfString(s, i, c);
        if (e < 0) { push('string', s.slice(i)); if (c === '`') { state = 'tpl'; } i = n; break; }
        push('string', s.slice(i, e)); i = e; continue;
      }
      m = /^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+)/.exec(s.slice(i, i + 40));
      if (m && !/[\w$]/.test(s[i - 1] || ' ')) { push('number', m[0]); i += m[0].length; continue; }
      m = /^[A-Za-z_$][\w$]*/.exec(s.slice(i, i + 80));
      if (m) {
        var w = m[0], after = s[i + w.length];
        if (py && /^[rbfuRBFU]{1,2}$/.test(w) && (after === '"' || after === "'")) { // a string prefix: f"..", r'..'
          var q = after, trip = s.substr(i + w.length, 3) === q + q + q;
          if (!trip) { var e2 = endOfString(s, i + w.length, q); if (e2 >= 0) { push('string', s.slice(i, e2)); i = e2; continue; } }
        }
        var W = WORDS[lang], cls = 'plain';
        if (W.kw[w]) { cls = 'keyword'; } else if (W.cs[w]) { cls = 'const'; } else if (W.bi[w]) { cls = 'type'; }
        else if (prevWord === 'def' || prevWord === 'function') { cls = 'fn'; }
        else if (prevWord === 'class') { cls = 'type'; }
        else if (/^\s*\(/.test(s.slice(i + w.length, i + w.length + 12))) { cls = 'fn'; }
        else if (/^[A-Z][a-z]/.test(w)) { cls = 'type'; }
        push(cls, w); prevWord = w; i += w.length; continue;
      }
      if (py && c === '@' && /[A-Za-z_]/.test(s[i + 1] || '')) { m = /^@[\w.]+/.exec(s.slice(i)); push('fn', m[0]); i += m[0].length; continue; }
      if (/[+\-*/%=<>!&|^~?:;,.(){}[\]]/.test(c)) { push('punct', c); i++; prevWord = ''; continue; }
      push('plain', c); i++;
      if (c !== ' ' && c !== '\t') { prevWord = ''; }
    }
    return { tokens: out, state: state };
  }
  function scanJson(s) {
    var out = [], push = pusher(out), i = 0, n = s.length, m;
    while (i < n) {
      var c = s[i];
      if (c === '"') {
        var e = endOfString(s, i, '"');
        var end = e < 0 ? n : e;
        push(/^\s*:/.test(s.slice(end)) ? 'key' : 'string', s.slice(i, end)); i = end; continue;
      }
      m = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(s.slice(i, i + 40));
      if (m && !/[\w]/.test(s[i - 1] || ' ')) { push('number', m[0]); i += m[0].length; continue; }
      m = /^(true|false|null)\b/.exec(s.slice(i, i + 8));
      if (m) { push('const', m[0]); i += m[0].length; continue; }
      if (/[{}[\],:]/.test(c)) { push('punct', c); i++; continue; }
      push('plain', c); i++;
    }
    return { tokens: out, state: '' };
  }
  function scanMarkdown(s, state) {
    var out = [], push = pusher(out), m;
    if (state === 'fence') {
      if (/^\s*```/.test(s)) { push('punct', s); return { tokens: out, state: '' }; }
      push('code', s); return { tokens: out, state: 'fence' };
    }
    if (/^\s*```/.test(s)) { push('punct', s); return { tokens: out, state: 'fence' }; }
    if (/^#{1,6}(\s|$)/.test(s)) { push('heading', s); return { tokens: out, state: '' }; }
    if (/^\s*>/.test(s)) { push('quote', s); return { tokens: out, state: '' }; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(s)) { push('punct', s); return { tokens: out, state: '' }; }
    var rest = s;
    m = /^(\s*)([-*+]|\d+[.)])(\s+)/.exec(rest);
    if (m) { push('plain', m[1]); push('punct', m[2]); push('plain', m[3]); rest = rest.slice(m[0].length); }
    var re = /`[^`]*`|\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|_[^_\s][^_]*_|\[[^\]]*\]\([^)]*\)/g, last = 0;
    while ((m = re.exec(rest))) {
      push('plain', rest.slice(last, m.index));
      var t = m[0], cls = t[0] === '`' ? 'code' : (t[0] === '[' ? 'link' : (t[0] === '*' && t[1] === '*') || t.slice(0, 2) === '__' ? 'bold' : 'italic');
      push(cls, t); last = m.index + t.length;
    }
    push('plain', rest.slice(last));
    return { tokens: out, state: '' };
  }
  // inside a tag (after "<name"): attributes up to ">"; returns the index after it, or the line's end with inTag true
  function scanTagBody(s, i, push) {
    var n = s.length, m;
    while (i < n) {
      var c = s[i];
      if (c === '>') { push('punct', '>'); return { i: i + 1, inTag: false }; }
      if (c === '/' && s[i + 1] === '>') { push('punct', '/>'); return { i: i + 2, inTag: false }; }
      if (c === '"' || c === "'") { var e = endOfString(s, i, c); var end = e < 0 ? n : e; push('string', s.slice(i, end)); i = end; continue; }
      if (c === '=') { push('punct', c); i++; continue; }
      m = /^[^\s=>/"']+/.exec(s.slice(i));
      if (m) { push('attr', m[0]); i += m[0].length; continue; }
      push('plain', c); i++;
    }
    return { i: i, inTag: true };
  }
  function scanHtml(s, state) {
    var out = [], push = pusher(out), i = 0, n = s.length, j, m;
    if (state === 'hcmt') {
      j = s.indexOf('-->');
      if (j < 0) { push('comment', s); return { tokens: out, state: 'hcmt' }; }
      push('comment', s.slice(0, j + 3)); i = j + 3; state = '';
    } else if (state === 'tag') {
      var r0 = scanTagBody(s, 0, push); i = r0.i; state = r0.inTag ? 'tag' : '';
    }
    while (i < n) {
      var c = s[i];
      if (c === '<') {
        if (s.substr(i, 4) === '<!--') {
          j = s.indexOf('-->', i + 4);
          if (j < 0) { push('comment', s.slice(i)); return { tokens: out, state: 'hcmt' }; }
          push('comment', s.slice(i, j + 3)); i = j + 3; continue;
        }
        m = /^<(\/?)(!?[A-Za-z][\w:-]*)/.exec(s.slice(i, i + 60));
        if (m) {
          push('punct', '<' + m[1]); push(m[2][0] === '!' ? 'keyword' : 'tag', m[2]); i += m[0].length;
          var r = scanTagBody(s, i, push); i = r.i; if (r.inTag) { return { tokens: out, state: 'tag' }; }
          continue;
        }
      }
      if (c === '&') { m = /^&#?\w+;/.exec(s.slice(i, i + 12)); if (m) { push('const', m[0]); i += m[0].length; continue; } }
      push('plain', c); i++;
    }
    return { tokens: out, state: state };
  }
  function scanCss(s, state) {
    // state: '' | 'c' (inside a comment) | a digit (open brace depth), 'c' + digit (comment inside braces)
    var out = [], push = pusher(out), i = 0, n = s.length, j, m;
    var inCmt = state.charAt(0) === 'c', depth = parseInt(state.replace('c', '') || '0', 10);
    var stat = function () { return (inCmt ? 'c' : '') + (depth ? String(depth) : ''); };
    var value = false; // after "prop:" until ";" or "}"
    if (inCmt) {
      j = s.indexOf('*/');
      if (j < 0) { push('comment', s); return { tokens: out, state: stat() }; }
      push('comment', s.slice(0, j + 2)); i = j + 2; inCmt = false;
    }
    var pendingProp = false;
    while (i < n) {
      var c = s[i];
      if (c === '/' && s[i + 1] === '*') {
        j = s.indexOf('*/', i + 2);
        if (j < 0) { push('comment', s.slice(i)); inCmt = true; i = n; break; }
        push('comment', s.slice(i, j + 2)); i = j + 2; continue;
      }
      if (c === '"' || c === "'") { var e = endOfString(s, i, c); var end = e < 0 ? n : e; push('string', s.slice(i, end)); i = end; continue; }
      if (c === '{') { depth++; push('punct', c); i++; value = false; continue; }
      if (c === '}') { depth = Math.max(0, depth - 1); push('punct', c); i++; value = false; continue; }
      if (c === ';') { push('punct', c); i++; value = false; continue; }
      if (c === ':' && depth > 0 && pendingProp && !value) { push('punct', c); value = true; pendingProp = false; i++; continue; }
      if (c === '@') { m = /^@[\w-]+/.exec(s.slice(i)); if (m) { push('keyword', m[0]); i += m[0].length; continue; } }
      if (c === '#' && /^#[0-9a-fA-F]{3,8}\b/.test(s.slice(i, i + 10)) && (value || depth > 0)) { m = /^#[0-9a-fA-F]+/.exec(s.slice(i)); push('number', m[0]); i += m[0].length; continue; }
      m = /^-?\d*\.?\d+(%|[a-z]{1,4})?/.exec(s.slice(i, i + 24));
      if (m && (value || depth > 0) && !/[\w-]/.test(s[i - 1] || ' ')) { push('number', m[0]); i += m[0].length; continue; }
      m = /^[A-Za-z_-][\w-]*/.exec(s.slice(i, i + 60));
      if (m) {
        var w = m[0], rest = s.slice(i + w.length);
        var cls;
        if (depth > 0 && !value && /^\s*:/.test(rest) && !/^[^;}{]*\{/.test(rest)) { cls = 'attr'; pendingProp = true; }
        else if (value) { cls = /^\s*\(/.test(rest) ? 'fn' : (w === 'important' ? 'keyword' : 'plain'); }
        else { cls = 'tag'; }
        push(cls, w); i += w.length; continue;
      }
      if ((c === '.' || c === '#') && !value) {
        m = /^[.#][\w-]+/.exec(s.slice(i));
        if (m) { push('type', m[0]); i += m[0].length; continue; }
      }
      if (c === '!') { push('keyword', c); i++; continue; }
      push(/[,>+~*()[\]=]/.test(c) ? 'punct' : 'plain', c); i++;
    }
    return { tokens: out, state: stat() };
  }
  var MAX_TOKENIZE = 2000; // a longer line is left uncolored (a minified file must not freeze the editor)
  function tokenizeLine(lang, text, state) {
    var l = LANG_ALIAS[String(lang || '').toLowerCase()] || (WORDS[String(lang || '').toLowerCase()] ? String(lang).toLowerCase() : '');
    state = state || '';
    if (!l || text.length > MAX_TOKENIZE) { return { tokens: text ? [['plain', text]] : [], state: state }; }
    if (l === 'python' || l === 'javascript') { return scanCode(l, text, state); }
    if (l === 'json') { return scanJson(text); }
    if (l === 'markdown') { return scanMarkdown(text, state); }
    if (l === 'html') { return scanHtml(text, state); }
    return scanCss(text, state);
  }

  // The editor: a box with a line number gutter and a main area of two layers: a highlight layer (only the visible lines are built, so a big file
  // stays fast) under a transparent textarea that keeps real editing, selection, undo and the scrollbars. Same font and line height in both, so
  // the colored text sits exactly under the typed text. Returns the box; box.value reads and writes the text (a synthetic input event on the box
  // works like typing). Only createElement, appendChild, addEventListener, style and textContent are used.
  var LINE_H = 20, PAD_T = 8, PAD_L = 8, BUFFER = 30;
  function buildEditor(doc, n, onEvent) {
    var box = doc.createElement('div');
    box.className = 'gui-editor';
    var lang = String(n.lang || '').toLowerCase();
    var showNumbers = n.numbers !== false;
    var gutter = doc.createElement('div'); gutter.className = 'gui-ed-gutter';
    var gnums = doc.createElement('pre');
    gutter.appendChild(gnums);
    var main = doc.createElement('div'); main.className = 'gui-ed-main';
    var cur = doc.createElement('div'); cur.className = 'gui-ed-cur';
    var hl = doc.createElement('pre'); hl.className = 'gui-ed-hl';
    var ta = doc.createElement('textarea'); ta.className = 'gui-ed-ta';
    ta.spellcheck = false; ta.value = n.value || ''; ta.disabled = n.enabled === false;
    ta.setAttribute('wrap', 'off'); ta.setAttribute('aria-label', 'editor');
    if (n.placeholder) { ta.placeholder = n.placeholder; }
    main.appendChild(hl); main.appendChild(ta);
    if (showNumbers) { box.appendChild(gutter); }
    box.appendChild(cur);
    box.appendChild(main);
    box.style.minHeight = '60px';
    box.style.height = ((n.rows || 8) * LINE_H + PAD_T * 2 + 2) + 'px';
    box.setAttribute('data-lang', lang);
    var cache = [];           // per line: { text, inState, tokens, outState }
    var rendered = { from: -1, to: -1, count: -1 };
    var curLine = 0, raf = null;
    var win = doc.defaultView || null;

    function lines() { return ta.value.split('\n'); }
    function lineStateAt(ls, upto) { // tokenizes lines 0..upto-1 (cached) and returns the state at the start of line upto
      var st = '';
      for (var i = 0; i < upto && i < ls.length; i++) {
        var c = cache[i];
        if (!c || c.text !== ls[i] || c.inState !== st) { var r = tokenizeLine(lang, ls[i], st); c = cache[i] = { text: ls[i], inState: st, tokens: r.tokens, outState: r.state }; }
        st = c.outState;
      }
      return st;
    }
    function lineCountOf(value, upto) { var c = 0; for (var i = 0; i < upto; i++) { if (value.charCodeAt(i) === 10) { c++; } } return c; }
    function visibleRange(total) {
      var top = ta.scrollTop || 0, h = ta.clientHeight || (n.rows || 8) * LINE_H;
      var first = Math.max(0, Math.floor((top - PAD_T) / LINE_H) - BUFFER);
      var last = Math.min(total - 1, Math.ceil((top + h - PAD_T) / LINE_H) + BUFFER);
      return { first: first, last: last };
    }
    function position() {
      var top = ta.scrollTop || 0, left = ta.scrollLeft || 0;
      hl.style.transform = 'translate(' + (PAD_L - left) + 'px,' + (PAD_T - top + (rendered.from < 0 ? 0 : rendered.from) * LINE_H) + 'px)';
      gnums.style.transform = 'translateY(' + (PAD_T - top + (rendered.from < 0 ? 0 : rendered.from) * LINE_H) + 'px)';
      cur.style.transform = 'translateY(' + (PAD_T - top + curLine * LINE_H) + 'px)';
    }
    function fill(el, parts) { el.textContent = ''; parts.forEach(function (p) { if (typeof p === 'string') { el.appendChild(doc.createTextNode ? doc.createTextNode(p) : (function () { var t = doc.createElement('span'); t.textContent = p; return t; }())); } else { var s = doc.createElement('span'); s.className = 'gui-tok-' + p[0]; s.textContent = p[1]; el.appendChild(s); } }); }
    function paint(force) {
      var ls = lines(), total = ls.length, r = visibleRange(total);
      if (!force && rendered.count === total && r.first >= rendered.from && r.last <= rendered.to && rendered.version === ta.value.length) { position(); return; }
      var st = lineStateAt(ls, r.first), parts = [], nums = [];
      for (var i = r.first; i <= r.last; i++) {
        var c = cache[i];
        if (!c || c.text !== ls[i] || c.inState !== st) { var res = tokenizeLine(lang, ls[i], st); c = cache[i] = { text: ls[i], inState: st, tokens: res.tokens, outState: res.state }; }
        st = c.outState;
        c.tokens.forEach(function (t) { parts.push(t); });
        if (i < r.last) { parts.push('\n'); }
        nums.push(i === curLine ? [ 'ed-now', String(i + 1) ] : String(i + 1));
        if (i < r.last) { nums.push('\n'); }
      }
      fill(hl, parts);
      var gparts = []; nums.forEach(function (x) { gparts.push(typeof x === 'string' ? x : x); });
      gnums.textContent = '';
      gparts.forEach(function (x) { if (typeof x === 'string') { gnums.appendChild(doc.createTextNode ? doc.createTextNode(x) : (function () { var t = doc.createElement('span'); t.textContent = x; return t; }())); } else { var s = doc.createElement('span'); s.className = 'gui-' + x[0]; s.textContent = x[1]; gnums.appendChild(s); } });
      var digits = String(total).length;
      gutter.style.width = 'calc(' + Math.max(2, digits) + 'ch + 20px)';
      rendered = { from: r.first, to: r.last, count: total, version: ta.value.length };
      position();
    }
    function schedule(force) {
      if (!win || !win.requestAnimationFrame) { paint(force); return; }
      if (force) { rendered.count = -1; }
      if (raf !== null) { return; }
      raf = win.requestAnimationFrame(function () { raf = null; paint(false); });
    }
    function updateCaret() {
      var line = lineCountOf(ta.value, ta.selectionStart || 0);
      if (line !== curLine) { curLine = line; rendered.count = -1; schedule(false); }
    }
    function insertText(text) { // keeps the browser's undo stack when it can
      var ok = false;
      try { ok = !!(doc.execCommand && doc.execCommand('insertText', false, text)); } catch (e) { ok = false; }
      if (!ok) { var s = ta.selectionStart, t = ta.selectionEnd; ta.value = ta.value.slice(0, s) + text + ta.value.slice(t); ta.selectionStart = ta.selectionEnd = s + text.length; }
    }
    Object.defineProperty(box, 'value', { get: function () { return ta.value; }, set: function (v) { ta.value = String(v); schedule(true); } });
    Object.defineProperty(box, 'disabled', { get: function () { return ta.disabled; }, set: function (v) { ta.disabled = !!v; } });
    box.addEventListener('input', function () {
      rendered.count = -1;
      updateCaret();
      onEvent('input', n.id, ta.value);
      schedule(true);
    });
    ta.addEventListener('scroll', function () {
      var r = visibleRange(rendered.count < 0 ? lines().length : rendered.count);
      if (r.first < rendered.from + 5 && rendered.from > 0 || r.last > rendered.to - 5 && rendered.to < rendered.count - 1) { schedule(true); } else { position(); }
    });
    ['keyup', 'click', 'mouseup', 'focus'].forEach(function (t) { ta.addEventListener(t, updateCaret); });
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); insertText('  '); onEvent('input', n.id, ta.value); schedule(true); return; }
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // keep the indentation of the current line (one more level after an opening ":" "{" "[" "(")
        var s = ta.selectionStart, v = ta.value, ls = v.lastIndexOf('\n', s - 1) + 1, indent = (/^[ \t]*/.exec(v.slice(ls, s)) || [''])[0];
        var prev = v.slice(ls, s).replace(/\s+$/, '').slice(-1);
        if (indent || /[:{[(]/.test(prev)) {
          e.preventDefault();
          insertText('\n' + indent + (/[:{[(]/.test(prev) && (lang === 'python' ? prev === ':' : prev !== ':') ? '  ' : ''));
          onEvent('input', n.id, ta.value); schedule(true);
        }
      }
    });
    box.paintNow = function () { paint(true); };
    box.focusEditor = function () { if (ta.focus) { ta.focus(); } };
    if (win && win.ResizeObserver) { new win.ResizeObserver(function () { schedule(true); }).observe(main); }
    paint(true);
    return box;
  }

  // A canvas with fps > 0 sends "frame" events on the page clock. The timer stops once the window is no longer in the page.
  function startFrames(doc, el, id, fps, onEvent) {
    var win = doc.defaultView;
    if (!win || !win.setInterval || !(fps > 0)) { return; }
    var timer = win.setInterval(function () {
      if (el.isConnected === false) { win.clearInterval(timer); return; }
      onEvent('frame', id, { t: Date.now() });
    }, Math.round(1000 / fps));
  }

  // the pointer in drawing pixels; a fit canvas is scaled to fit its box (object-fit: contain), so the picture's own box is smaller than the element
  function canvasPoint(el, fit, e) {
    var r = el.getBoundingClientRect(), k = fit && r.width && r.height ? Math.min(r.width / el.width, r.height / el.height) : 0;
    if (k) { var ox = r.left + (r.width - el.width * k) / 2, oy = r.top + (r.height - el.height * k) / 2; return { x: (e.clientX - ox) / k, y: (e.clientY - oy) / k }; }
    var sx = r.width ? el.width / r.width : 1, sy = r.height ? el.height / r.height : 1;
    return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy };
  }

  // opts.image(nodeId, name) gives the decoded picture of a canvas (see paintFrame); without it no picture is drawn
  function renderNode(doc, n, onEvent, opts) {
    var el, menuPanel = null;
    function on(type, fn) { el.addEventListener(type, fn); }
    function label(text) { var s = doc.createElement('span'); s.textContent = text; return s; }
    switch (n.kind) {
      case 'column': case 'row':
        el = doc.createElement('div');
        el.className = 'gui-' + n.kind;
        break;
      case 'grid':
        el = doc.createElement('div');
        el.className = 'gui-grid';
        el.style.display = 'grid';
        el.style.gridTemplateColumns = 'repeat(' + (n.columns || 2) + ', 1fr)';
        break;
      case 'tabs': case 'tab':
        el = doc.createElement('div');
        el.className = 'gui-' + n.kind;
        break;
      case 'split':
        el = doc.createElement('div');
        el.className = 'gui-split';
        el.style.display = 'flex';
        el.style.flexDirection = n.direction === 'column' ? 'column' : 'row';
        break;
      case 'menubar':
        el = doc.createElement('div');
        el.className = 'gui-menubar';
        break;
      case 'menu':
        el = doc.createElement('details');
        el.className = 'gui-menu';
        var msum = doc.createElement('summary');
        msum.textContent = n.text || '';
        el.appendChild(msum);
        // the items sit in a panel that drops below the title
        menuPanel = doc.createElement('div');
        menuPanel.className = 'gui-menupanel';
        el.appendChild(menuPanel);
        break;
      case 'menuitem':
        el = doc.createElement('button');
        el.type = 'button';
        el.className = 'gui-menuitem';
        el.textContent = n.text || '';
        if (n.keys) { var hint = label(n.keys); hint.className = 'gui-keys'; el.appendChild(hint); }
        el.disabled = n.enabled === false;
        on('click', function () {
          var box = el.parentNode;
          if (box && box.open) { box.open = false; }
          onEvent('click', n.id);
        });
        break;
      case 'scroll':
        el = doc.createElement('div');
        el.className = 'gui-scroll';
        el.style.overflow = 'auto';
        if (!(n.grow > 0)) { el.style.maxHeight = (n.height || 200) + 'px'; }
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
        el = buildEditor(doc, n, onEvent);
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
        el = doc.createElement('div');
        el.className = 'gui-tablebox';
        var tableEl = doc.createElement('table');
        tableEl.className = 'gui-table';
        var head = doc.createElement('tr');
        (n.columns || []).forEach(function (c) { var th = doc.createElement('th'); th.textContent = c; head.appendChild(th); });
        var thead = doc.createElement('thead');
        thead.appendChild(head);
        tableEl.appendChild(thead);
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
        tableEl.appendChild(tbody);
        el.appendChild(tableEl);
        break;
      case 'canvas':
        el = doc.createElement('canvas');
        el.className = 'gui-canvas';
        el.width = n.width || 320;
        el.height = n.height || 240;
        el.tabIndex = 0; // focusable, so key presses reach it
        if (n.fit) {
          // the drawing space stays width x height; the box is scaled to fill the area (whole picture visible, centered)
          el.style.cssText = 'display:block;object-fit:contain;min-width:0;min-height:0;' + (n.grow > 0 ? 'contain:size;' : 'width:100%;height:auto;');
          el.className += ' gui-canvas-fit';
        } else if (opts && opts.resizable) {
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
            var p = canvasPoint(el, n.fit, e);
            onEvent('mouse', n.id, { kind: kind, x: p.x, y: p.y, button: e.button || 0 });
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
          var p = canvasPoint(el, n.fit, e);
          onEvent('wheel', n.id, { x: p.x, y: p.y, dy: e.deltaY });
        }, { passive: false });
        startFrames(doc, el, n.id, n.fps || 0, onEvent);
        break;
      default:
        throw new Error('unknown GUI kind "' + n.kind + '"');
    }
    el.setAttribute('data-node', n.id);
    if (n.visible === false) { el.hidden = true; }
    // layout and look hints: grow takes a share of the parent's free space (the parent is a flex row or column), gap and pad are spacing, role is a named look
    if (n.grow > 0 && n.kind === 'editor') { el.style.height = ''; }
    if (n.grow > 0) { el.style.flex = n.grow + ' 1 0%'; el.style.minWidth = '0'; el.style.minHeight = '0'; el.setAttribute('data-grow', String(n.grow)); }
    if (n.gap !== undefined) { el.style.gap = n.gap + 'px'; }
    if (n.pad !== undefined) { el.style.padding = n.pad + 'px'; }
    if (n.role) { el.className = (el.className ? el.className + ' ' : '') + 'gui-role-' + n.role; }
    var holder = menuPanel || el;
    (n.children || []).forEach(function (c) { holder.appendChild(renderNode(doc, c, onEvent, opts)); });
    if (n.kind === 'tabs') { buildTabs(doc, el, n, onEvent); }
    if (n.kind === 'split') {
      var pages = Array.prototype.slice.call(el.children || []);
      pages.forEach(function (child, i) { child.style.flex = i === 0 && pages.length > 1 ? '0 0 ' + (n.ratio || 50) + '%' : '1 1 0'; child.style.minWidth = '0'; });
    }
    return el;
  }

  // tabs: a bar of buttons (one per tab page, titled by the page's text) above the pages; one page shows. The page comes from the node's
  // `selected` (a page id), else the first; a click shows that page and tells the program (select, value = the page id).
  function buildTabs(doc, el, n, onEvent) {
    var pages = Array.prototype.slice.call(el.children || []);
    var bar = doc.createElement('div');
    bar.className = 'gui-tabbar';
    var chosen = (n.children || []).some(function (c) { return c.id === n.selected; }) ? n.selected : ((n.children || [])[0] || {}).id;
    var buttons = [];
    function show(pageId) {
      pages.forEach(function (p, i) { p.hidden = (n.children[i].id !== pageId); });
      buttons.forEach(function (b, i) { var on_ = n.children[i].id === pageId; b.className = 'gui-tabbutton' + (on_ ? ' gui-tab-active' : ''); });
    }
    (n.children || []).forEach(function (c) {
      var b = doc.createElement('button');
      b.type = 'button';
      b.textContent = c.text || c.id;
      b.addEventListener('click', function () { show(c.id); onEvent('select', n.id, c.id); });
      bar.appendChild(b);
      buttons.push(b);
    });
    el.insertBefore(bar, el.firstChild || null);
    show(chosen);
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

  // ---- theme and shortcuts (window-level look and keys; the bridge validated every value) ----
  var KEY_NAMES = { ' ': 'Space', Enter: 'Enter', Escape: 'Esc', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Delete: 'Delete', Backspace: 'Backspace', Tab: 'Tab' };
  // a keydown as the bridge's shortcut text: Ctrl+Shift+Alt+<key> (Cmd counts as Ctrl); null for a key with no name
  function shortcutKey(e) {
    var key = String(e.key || '');
    var name = KEY_NAMES[key] || (/^F([1-9]|1[0-2])$/.test(key) ? key : (key.length === 1 ? key.toUpperCase() : null));
    if (!name) { return null; }
    return ((e.ctrlKey || e.metaKey) ? 'Ctrl+' : '') + (e.shiftKey ? 'Shift+' : '') + (e.altKey ? 'Alt+' : '') + name;
  }
  // black or white, whichever reads better on the color (#rgb or #rrggbb)
  function textOn(color) {
    var h = String(color).replace('#', '');
    if (h.length === 3) { h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2); }
    var r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#000000' : '#ffffff';
  }
  function allNodes(el, out) {
    out = out || [];
    // a real DOM's children is an HTMLCollection (no forEach): copy it into an array first
    Array.prototype.slice.call(el.children || []).forEach(function (c) { out.push(c); allNodes(c, out); });
    return out;
  }
  // Paints a window with its theme: { palette:{bg,fg,accent,danger,muted}, font, size, radius, density }. Called after the window's own style is set
  // (the host replaces the whole style text), and safe to call with no theme. The stylesheet (GUI_CSS) derives surfaces, borders and hover states
  // from the palette variables, so this only sets the variables, the scheme (dark or light text colors for the code editor) and a few basics.
  var FONT_VARS = { 'sans-serif': 'var(--gui-sans)', serif: 'var(--gui-serif)', monospace: 'var(--gui-mono)' };
  function isDark(color) {
    var h = String(color).replace('#', '');
    if (h.length === 3) { h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2); }
    var r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) < 128;
  }
  function applyTheme(win, theme) {
    if (!win || !win.style || !theme || !Object.keys(theme).length) { return; }
    var p = theme.palette || {}, st = win.style;
    function v(name, value) { if (st.setProperty) { st.setProperty(name, value); } else { st[name] = value; } }
    Object.keys(p).forEach(function (k) { v('--gui-' + k, p[k]); });
    if (p.accent) { v('--gui-on-accent', textOn(p.accent)); }
    if (p.bg) { st.background = p.bg; if (win.setAttribute) { win.setAttribute('data-scheme', isDark(p.bg) ? 'dark' : 'light'); } }
    if (p.fg) { st.color = p.fg; }
    if (theme.font) { v('--gui-font', FONT_VARS[theme.font] || theme.font); st.fontFamily = FONT_VARS[theme.font] || theme.font; }
    if (theme.size) { st.fontSize = theme.size + 'px'; v('--gui-fs', theme.size + 'px'); }
    if (theme.radius !== undefined) { v('--gui-radius', theme.radius + 'px'); }
    if (theme.density && win.setAttribute) { win.setAttribute('data-density', theme.density); }
  }

  // keys the window answers: shortcuts is { 'Ctrl+S': 'save' }. A key with no Ctrl or Alt is ignored while typing in a text box.
  function bindShortcuts(win, shortcuts, onEvent) {
    var names = shortcuts || {};
    if (!Object.keys(names).length) { return; }
    win.tabIndex = -1; // a click into the window focuses it, so its keys arrive here
    win.addEventListener('keydown', function (e) {
      var combo = shortcutKey(e);
      if (!combo || !Object.prototype.hasOwnProperty.call(names, combo)) { return; }
      var tag = String((e.target && e.target.tagName) || '').toLowerCase();
      if ((tag === 'input' || tag === 'textarea' || tag === 'select') && !/Ctrl\+|Alt\+/.test(combo)) { return; }
      if (e.preventDefault) { e.preventDefault(); }
      onEvent('shortcut', 'root', names[combo]);
    });
  }

  // snapshot = { id, title, width, resizable, maximizable, theme, shortcuts, root }; onEvent(name, nodeId, value) is called for user actions in the window;
  // opts (optional) = { image(nodeId, name) } for the pictures of the canvases
  var CONTROL_BUTTON_CSS = 'border:none;background:transparent;cursor:pointer;font:inherit;font-size:15px;line-height:1;padding:3px 9px;border-radius:5px;color:inherit;';
  function renderWindow(doc, snap, onEvent, onClose, opts) {
    var win = doc.createElement('div');
    ensureStyles(doc);
    win.className = 'gui-window';
    win.setAttribute('data-window', snap.id);
    win.style.width = snap.width + 'px';
    var bar = doc.createElement('div');
    bar.className = 'gui-titlebar';
    // the title on the left, the control buttons on the right (close last), like any desktop window
    var title = doc.createElement('span');
    title.textContent = snap.title;
    title.style.cssText = 'flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
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
    }
    body.className = (body.className ? body.className + ' ' : '') + 'gui-body';
    win.appendChild(body);
    bindShortcuts(win, snap.shortcuts, onEvent);
    applyTheme(win, snap.theme); // the host sets the window's own style text afterwards and calls applyTheme again
    return win;
  }

  return { GUI_CSS: GUI_CSS, tokenizeLine: tokenizeLine, isDark: isDark, CONTROL_BUTTON_CSS: CONTROL_BUTTON_CSS, renderWindow: renderWindow, paintFrame: paintFrame, applyTheme: applyTheme, shortcutKey: shortcutKey, textOn: textOn };
}));
