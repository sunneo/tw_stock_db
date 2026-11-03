// zenity-compatible dialogs for the terminal (pure, no DOM): `zenity --info|--question|--entry|--password|--list|--checklist|--radiolist|--progress ...`
// so scripts written for zenity (winetricks, for one) run unchanged on the bridge. A dialog is a skill window (AiChatGuiBridge messages),
// and the answer comes back the way zenity prints it: the text on stdout and an exit code (0 OK, 1 Cancel or closed, 5 timeout).
// The terminal drives it: parse(words) -> build(parsed, winId) gives the window messages to apply; start(parsed) gives the answer state;
// onEvent(parsed, state, event) returns null while waiting or {exit_code, stdout} when the dialog is answered.
//
// Limits on purpose (see DESIGN.skill-gui-bridge.md): --progress shows the bar and returns at once (it does not read stdin, and a
// virtual command cannot sit in a pipe); --file-selection, --calendar, --scale, --notification, --forms and friends are refused with
// exit 1 and a clear message. Row values with the same visible text in a --list are matched by their first occurrence.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { root.AiChatZenity = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MODES = { info: true, warning: true, error: true, question: true, entry: true, password: true, progress: true };
  var UNSUPPORTED = ['file-selection', 'calendar', 'scale', 'notification', 'color-selection', 'forms', 'text-info', 'about', 'password-dialog'];
  var VALUE_OPTS = { title: true, text: true, width: true, height: true, timeout: true, 'ok-label': true, 'cancel-label': true, 'entry-text': true,
    column: true, 'hide-column': true, 'print-column': true, separator: true, percentage: true, 'window-icon': true, 'icon-name': true };
  var FLAG_OPTS = { 'auto-close': true, pulsate: true, multiple: true, 'no-wrap': true, 'no-markup': true, ellipsize: true, modal: true,
    'hide-header': true, editable: true, 'hide-text': true, 'default-cancel': true };
  var MAX_ROWS = 150;   // one checkbox or list item per row; the bridge allows 200 nodes per window
  var DEFAULT_TITLE = { info: 'Information', warning: 'Warning', error: 'Error', question: 'Question', entry: 'Enter a value', password: 'Enter password', progress: 'Progress', list: 'Select', checklist: 'Select', radiolist: 'Select' };

  function fail(error) { return { ok: false, error: error }; }
  function num(v, name, lo, hi, dflt) {
    if (v === undefined) { return dflt; }
    var n = parseFloat(v);
    if (!isFinite(n)) { throw new Error('--' + name + ' needs a number'); }
    return Math.min(hi, Math.max(lo, n));
  }
  function isListMode(mode) { return mode === 'list' || mode === 'checklist' || mode === 'radiolist'; }

  // zenity's own argument form: `--name value`, `--name=value`, flags as `--name`. Words that do not start with -- are rows for --list.
  function parse(words) {
    var mode = null, listSeen = false, variant = null, opts = { columns: [] }, positional = [], error = null;
    try {
      for (var i = 0; i < words.length; i++) {
        var w = String(words[i]);
        if (w.indexOf('--') !== 0) { positional.push(w); continue; }
        var name = w.slice(2), value = null, eq = name.indexOf('=');
        if (eq !== -1) { value = name.slice(eq + 1); name = name.slice(0, eq); }
        if (UNSUPPORTED.indexOf(name) !== -1) { return fail('--' + name + ' is not supported by the bridge (use the GUI bridge directly for that)'); }
        if (MODES.hasOwnProperty(name)) {
          if (mode && mode !== name) { return fail('only one dialog type can be given'); }
          mode = name;
          continue;
        }
        if (name === 'list') { listSeen = true; continue; }
        if (name === 'checklist' || name === 'radiolist') { listSeen = true; variant = name; continue; }
        if (VALUE_OPTS.hasOwnProperty(name)) {
          if (value === null) {
            if (i + 1 >= words.length) { return fail('--' + name + ' needs a value'); }
            value = String(words[++i]);
          }
          if (name === 'column') { opts.columns.push(value); } else { opts[name] = value; }
          continue;
        }
        if (FLAG_OPTS.hasOwnProperty(name)) { opts[name] = true; continue; }
        return fail('unknown option --' + name);
      }
    } catch (e) {
      return fail(e.message || String(e));
    }
    if (listSeen) {
      if (mode) { return fail('a list cannot be combined with --' + mode); }
      mode = variant || 'list';
    }
    if (!mode) { return fail('pick a dialog: --info, --warning, --error, --question, --entry, --password, --list, --checklist, --radiolist or --progress'); }

    var out = { ok: true, mode: mode, opts: opts, title: opts.title !== undefined ? opts.title : DEFAULT_TITLE[mode] };
    try {
      out.width = num(opts.width, 'width', 160, 1200, 420);
      out.timeout = num(opts.timeout, 'timeout', 0, 300, 0);      // 0 = no timeout
      out.percentage = num(opts.percentage, 'percentage', 0, 100, 0);
    } catch (e) { return fail(e.message); }
    if (opts.separator === undefined) { out.separator = '|'; } else { out.separator = opts.separator; }

    if (isListMode(mode)) {
      var n = opts.columns.length;
      if (!n) { return fail('--' + mode + ' needs at least one --column'); }
      if (positional.length % n !== 0) { return fail('rows must come in groups of ' + n + ' values (one per --column)'); }
      var rowCount = positional.length / n;
      if (rowCount > MAX_ROWS) { return fail('at most ' + MAX_ROWS + ' rows'); }
      out.rows = [];
      for (var r = 0; r < rowCount; r++) { out.rows.push(positional.slice(r * n, r * n + n)); }
      out.flagged = mode === 'checklist' || mode === 'radiolist';     // first column is TRUE/FALSE
      if (out.flagged) {
        for (var k = 0; k < out.rows.length; k++) {
          if (out.rows[k][0] !== 'TRUE' && out.rows[k][0] !== 'FALSE') { return fail('row ' + (k + 1) + ': the first column must be TRUE or FALSE'); }
        }
      }
      out.multiple = mode === 'checklist' || !!opts.multiple;
      out.hideColumn = opts['hide-column'] !== undefined ? parseInt(opts['hide-column'], 10) : null;
      out.printColumn = opts['print-column'] !== undefined ? parseInt(opts['print-column'], 10) : (out.flagged ? 2 : 1);
      if (!(out.printColumn >= 1 && out.printColumn <= n)) { return fail('--print-column must be between 1 and ' + n); }
      if (out.hideColumn !== null && !(out.hideColumn >= 1 && out.hideColumn <= n)) { return fail('--hide-column must be between 1 and ' + n); }
      out.displayCols = [];
      for (var c = 0; c < n; c++) {
        if (out.flagged && c === 0) { continue; }
        if (out.hideColumn === c + 1) { continue; }
        out.displayCols.push(c);
      }
      out.labels = out.rows.map(function (row) { return out.displayCols.map(function (c) { return row[c]; }).join(' | '); });
    } else if (positional.length) {
      out.text = positional.join(' ');
    }
    return out;
  }

  // The window for the dialog, as AiChatGuiBridge messages (without "v"). Node ids: msg, val (entry), pick (list), c0.. (checkboxes), bar, ok, cancel.
  function build(parsed, winId) {
    var o = parsed.opts, mode = parsed.mode, msgs = [];
    var text = o.text !== undefined ? o.text : (parsed.text || '');
    msgs.push({ op: 'open', id: winId, title: parsed.title || '', width: parsed.width });
    msgs.push({ op: 'add', id: winId, node: { id: 'msg', kind: 'label', text: text } });
    function add(node, parent) { msgs.push({ op: 'add', id: winId, parent: parent || 'root', node: node }); }
    function buttons() {
      var row = { id: 'buttons', kind: 'row' };
      add(row);
      add({ id: 'ok', kind: 'button', text: o['ok-label'] || 'OK' }, 'buttons');
      if (mode !== 'info' && mode !== 'warning' && mode !== 'error' && mode !== 'progress') {
        add({ id: 'cancel', kind: 'button', text: o['cancel-label'] || 'Cancel' }, 'buttons');
      }
    }
    if (mode === 'progress') {
      add({ id: 'bar', kind: 'progress', value: parsed.opts.pulsate ? 0 : parsed.percentage, max: 100 });
    } else if (mode === 'entry' || mode === 'password') {
      add({ id: 'val', kind: 'entry', value: o['entry-text'] !== undefined ? o['entry-text'] : '', secret: mode === 'password' || !!o['hide-text'] });
      buttons();
    } else if (isListMode(mode)) {
      if (parsed.multiple) {
        parsed.labels.forEach(function (label, i) {
          add({ id: 'c' + i, kind: 'checkbox', text: label, checked: parsed.flagged ? parsed.rows[i][0] === 'TRUE' : false });
        });
      } else {
        var pick = { id: 'pick', kind: 'list', items: parsed.labels };
        var preset = parsed.flagged ? parsed.rows.findIndex(function (row) { return row[0] === 'TRUE'; }) : -1;
        if (preset >= 0) { pick.selected = parsed.labels[preset]; }
        add(pick);
      }
      buttons();
    } else {
      buttons();
    }
    return msgs;
  }

  // The answer state for a dialog, before any event.
  function start(parsed) {
    var st = { value: parsed.opts['entry-text'] !== undefined ? parsed.opts['entry-text'] : '', selected: -1, checked: [] };
    if (isListMode(parsed.mode)) {
      st.checked = parsed.rows.map(function (row) { return parsed.flagged && row[0] === 'TRUE'; });
      if (!parsed.multiple) { st.selected = parsed.flagged ? parsed.rows.findIndex(function (row) { return row[0] === 'TRUE'; }) : -1; }
    }
    return st;
  }

  function printed(parsed, index) { return parsed.rows[index][parsed.printColumn - 1]; }

  // One event from the window (the parsed JSON of a bridge event line). Returns null while the dialog is open, or {exit_code, stdout}.
  function onEvent(parsed, st, ev) {
    if (!ev) { return null; }
    if (ev.event === 'close') { return { exit_code: 1, stdout: '' }; }
    if (ev.event === 'input' && ev.node === 'val') { st.value = String(ev.value); return null; }
    if (ev.event === 'change' && /^c\d+$/.test(ev.node)) { st.checked[parseInt(ev.node.slice(1), 10)] = !!ev.value; return null; }
    if (ev.event === 'select' && ev.node === 'pick') { st.selected = parsed.labels.indexOf(String(ev.value)); return null; }
    if (ev.event !== 'click') { return null; }
    if (ev.node === 'cancel') { return { exit_code: 1, stdout: '' }; }
    if (ev.node !== 'ok') { return null; }
    var mode = parsed.mode;
    if (mode === 'entry' || mode === 'password') { return { exit_code: 0, stdout: st.value + '\n' }; }
    if (mode === 'info' || mode === 'warning' || mode === 'error' || mode === 'question' || mode === 'progress') { return { exit_code: 0, stdout: '' }; }
    if (parsed.multiple) {
      var picked = [];
      st.checked.forEach(function (on, i) { if (on) { picked.push(printed(parsed, i)); } });
      return { exit_code: 0, stdout: picked.length ? picked.join(parsed.separator) + '\n' : '' };
    }
    if (st.selected < 0) { return { exit_code: 1, stdout: '' }; }
    return { exit_code: 0, stdout: printed(parsed, st.selected) + '\n' };
  }

  // --progress does not wait for its window (no stdin in this version): the terminal opens the window and returns exit 0 at once.
  function immediate(parsed) { return parsed.mode === 'progress' ? { exit_code: 0, stdout: '' } : null; }

  return { parse: parse, build: build, start: start, onEvent: onEvent, immediate: immediate, MAX_ROWS: MAX_ROWS };
}));
