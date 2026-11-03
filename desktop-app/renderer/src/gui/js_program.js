// Runs one JavaScript program (the terminal's `node <file.js>`) in a sandboxed iframe: sandbox="allow-scripts" only, so no same-origin
// -- no Redmine cookies, session or DOM. The program sees console.log / console.error and a `gui` object. Every gui call is a message
// to the page, which answers it with the same gui.* ops as the Python skill windows (see AiChatTerminal.guiPython); the page never runs
// anything the program sends it.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { root.AiChatJsProgram = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Runs inside the iframe: console and the gui API, then the program itself. Serialized with toString() into srcdoc.
  function programShim(code) {
    var nextRid = 0, pending = {};
    function call(op, args) {
      return new Promise(function (res, rej) {
        var rid = ++nextRid;
        pending[rid] = { res: res, rej: rej };
        parent.postMessage({ __gui: { rid: rid, op: op, args: args } }, '*');
      });
    }
    window.addEventListener('message', function (ev) {
      if (ev.source !== parent || !ev.data || !ev.data.__reply) { return; }
      var r = ev.data.__reply, p = pending[r.rid];
      if (!p) { return; }
      delete pending[r.rid];
      if (r.ok) { p.res(r.result); } else { p.rej(new Error(r.error)); }
    });
    function text(v) {
      if (typeof v === 'string') { return v; }
      try { return JSON.stringify(v); } catch (e) { return String(v); }
    }
    function log(kind) {
      return function () {
        var parts = [];
        for (var i = 0; i < arguments.length; i++) { parts.push(text(arguments[i])); }
        parent.postMessage({ __log: { s: kind, m: parts.join(' ') } }, '*');
      };
    }
    console.log = log('out');
    console.error = log('err');
    console.warn = log('err');

    function Win(id) { this.id = id; this.n = 0; this.values = {}; this.closed = false; }
    Win.prototype._node = function (kind, parent, fields) {
      var node = { id: 'n' + (++this.n), kind: kind }, k;
      for (k in fields) { if (fields.hasOwnProperty(k)) { node[k] = fields[k]; } }
      return call('gui.add', { id: this.id, parent: parent || 'root', node: node }).then(function () { return node.id; });
    };
    Win.prototype.label = function (text, parent) { return this._node('label', parent, { text: String(text) }); };
    Win.prototype.button = function (text, parent) { return this._node('button', parent, { text: String(text) }); };
    Win.prototype.row = function (parent) { return this._node('row', parent, {}); };
    Win.prototype.column = function (parent) { return this._node('column', parent, {}); };
    Win.prototype.entry = function (value, parent) {
      var self = this, v = value === undefined ? '' : String(value);
      return this._node('entry', parent, { value: v }).then(function (nid) { self.values[nid] = v; return nid; });
    };
    Win.prototype.expander = function (text, expanded, parent) {
      var self = this, open = !!expanded;
      return this._node('expander', parent, { text: String(text), expanded: open }).then(function (nid) { self.values[nid] = open; return nid; });
    };
    Win.prototype.editor = function (value, lang, rows, parent) {
      var self = this, v = value === undefined ? '' : String(value);
      return this._node('editor', parent, { value: v, lang: lang === undefined ? '' : String(lang), rows: Number(rows) || 8 }).then(function (nid) { self.values[nid] = v; return nid; });
    };
    Win.prototype.table = function (columns, rows, parent) {
      var self = this, cols = (columns || []).map(String), data = (rows || []).map(function (r) { return r.map(String); });
      data.forEach(function (r, i) { if (r.length !== cols.length) { throw new Error('table row ' + i + ' has ' + r.length + ' cells, the table has ' + cols.length + ' columns'); } });
      return this._node('table', parent, { columns: cols, rows: data }).then(function (nid) { self.values[nid] = data.map(function (r) { return r.slice(); }); return nid; });
    };
    Win.prototype.multilist = function (items, selected, parent) {
      var self = this, sel = (selected || []).map(String);
      return this._node('multilist', parent, { items: (items || []).map(String), selected: sel }).then(function (nid) { self.values[nid] = sel.slice(); return nid; });
    };
    Win.prototype.value = function (nid) { return this.values[nid]; };
    // value-changing events only update value(); click and close are returned to the program
    function valueEvent(self, ev) {
      if (ev.event === 'cell') { self.values[ev.node][ev.value.row][ev.value.col] = ev.value.text; return; }
      self.values[ev.node] = ev.value;
    }
    Win.prototype.wait = function (timeout) {
      var self = this, end = Date.now() + (Number(timeout) || 300) * 1000;
      function loop() {
        var left = (end - Date.now()) / 1000;
        if (left <= 0) { return Promise.resolve(null); }
        return call('gui.wait', { id: self.id, timeout: left }).then(function (ev) {
          if (!ev) { return null; }
          if (ev.event === 'input' || ev.event === 'cell' || ev.event === 'toggle' || ev.event === 'select') { valueEvent(self, ev); return loop(); }
          if (ev.event === 'close') { self.closed = true; }
          return ev;
        });
      }
      return loop();
    };
    Win.prototype.close = function () {
      if (this.closed) { return Promise.resolve(null); }
      this.closed = true;
      return call('gui.close', { id: this.id });
    };
    window.gui = {
      open: function (title, width) {
        var id = 'w' + Math.random().toString(36).slice(2, 10);
        return call('gui.open', { id: id, title: String(title), width: Number(width) || 360 }).then(function () { return new Win(id); });
      }
    };

    var run = new Function('return (async function () {\n' + code + '\n})();');
    Promise.resolve().then(run).then(function () {
      parent.postMessage({ __done: { ok: true } }, '*');
    }, function (e) {
      parent.postMessage({ __done: { ok: false, error: String((e && e.stack) || e) } }, '*');
    });
  }

  function buildSrcdoc(code) {
    // "<" is escaped so the program text can never close the script element
    var literal = JSON.stringify(String(code)).replace(/</g, '\\u003c');
    return '<!doctype html><html><head><meta charset="utf-8"></head><body><script>(' + programShim.toString() + ')(' + literal + ');</script></body></html>';
  }

  // opts: { onGui(op, args) -> Promise, timeoutMs }. Resolves {ok, stdout, stderr, exit_code} when the program finishes, fails or times out.
  function run(code, opts) {
    opts = opts || {};
    var timeoutMs = opts.timeoutMs || 300000;
    return new Promise(function (resolve) {
      var iframe = document.createElement('iframe'), out = [], err = [], finished = false, timer;
      iframe.setAttribute('sandbox', 'allow-scripts');
      iframe.style.cssText = 'display:none;';
      function finish(r) {
        if (finished) { return; }
        finished = true;
        window.removeEventListener('message', onMessage);
        clearTimeout(timer);
        if (iframe.parentNode) { iframe.parentNode.removeChild(iframe); }
        resolve(r);
      }
      function reply(rid, ok, value) {
        if (!iframe.contentWindow) { return; }
        iframe.contentWindow.postMessage({ __reply: { rid: rid, ok: ok, result: ok ? (value === undefined ? null : value) : undefined, error: ok ? undefined : String(value) } }, '*');
      }
      function onMessage(ev) {
        if (ev.source !== iframe.contentWindow || !ev.data) { return; }
        var d = ev.data;
        if (d.__log) { (d.__log.s === 'err' ? err : out).push(d.__log.m + '\n'); return; }
        if (d.__done) {
          finish({ ok: !!d.__done.ok, stdout: out.join(''), stderr: err.join('') + (d.__done.ok ? '' : d.__done.error + '\n'), exit_code: d.__done.ok ? 0 : 1 });
          return;
        }
        if (d.__gui) {
          var g = d.__gui;
          Promise.resolve().then(function () { return opts.onGui ? opts.onGui(g.op, g.args || {}) : Promise.reject(new Error('gui windows are not available here')); })
            .then(function (result) { reply(g.rid, true, result); }, function (e) { reply(g.rid, false, (e && e.message) || e); });
        }
      }
      window.addEventListener('message', onMessage);
      timer = setTimeout(function () {
        finish({ ok: false, stdout: out.join(''), stderr: err.join('') + 'node: timed out\n', exit_code: 124 });
      }, timeoutMs);
      iframe.srcdoc = buildSrcdoc(code);
      document.body.appendChild(iframe);
    });
  }

  return { run: run, buildSrcdoc: buildSrcdoc, programShim: programShim };
}));
