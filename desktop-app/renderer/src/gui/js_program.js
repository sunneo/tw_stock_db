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
    // canvas: a drawing area for frames (games). draw(nid, ops) paints one whole frame (ops as in the Python gui: ["rect", x, y, w, h, color], ...).
    // fps > 0 makes wait() return {event: "frame"} events; key presses come as {event: "key", value: {key, down}}; the pointer as "mouse".
    Win.prototype.canvas = function (width, height, fps, parent, fit) {
      var f = { width: Number(width) || 320, height: Number(height) || 240, fps: Number(fps) || 0 };
      if (fit) { f.fit = true; }
      return this._node('canvas', parent, f);
    };
    Win.prototype.draw = function (nid, ops) { return call('gui.draw', { id: this.id, node: nid, ops: ops }); };
    Win.prototype.set = function (nid, props) { return call('gui.set', { id: this.id, node: nid, props: props }); };
    Win.prototype.poll = function () { return call('gui.poll', { id: this.id }); };
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
    // swap: IndexedDB as swap. swap.array(length, "f32"|"f64"|"i32"|"u32"|"u8"|"i16"|"u16"|"i8") is a typed array of any length kept in pages: only the most
    // recently used pages (hotMB, default 16) stay in this program's memory, the rest lives in IndexedDB (via the page). Everything is async:
    //   var a = swap.array(50e6, "f32");  await a.set(0, new Float32Array([1, 2, 3]));  var x = await a.get(0, 3);  await a.map(function (blk, start) { ... });
    // a.fill(v), a.free(); swap.stats(); swap.hotMB(n). Pages not written yet read as 0. The pages are dropped when the program ends.
    var SW = { space: 'js-' + Math.random().toString(36).slice(2, 10), hot: 16 * 1048576, page: 256 * 1024, arrays: {}, seq: 0, reads: 0, writes: 0, hits: 0, cache: [] };
    var TYPES = { f32: Float32Array, f64: Float64Array, i32: Int32Array, u32: Uint32Array, u8: Uint8Array, i8: Int8Array, i16: Int16Array, u16: Uint16Array };
    function b64of(u8) { var s = ''; for (var i = 0; i < u8.length; i += 0x8000) { s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); } return btoa(s); }
    function u8of(b64) { var bin = atob(b64), u = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) { u[i] = bin.charCodeAt(i); } return u; }
    function hotSize() { var n = 0; SW.cache.forEach(function (e) { n += e.data.byteLength; }); return n; }
    function evict(keep) {
      var chain = Promise.resolve();
      while (SW.cache.length > 1 && hotSize() > SW.hot) {
        var i = SW.cache[0] === keep ? 1 : 0, e = SW.cache.splice(i, 1)[0];
        if (!e) { break; }
        chain = chain.then((function (e) { return function () { return flushEntry(e); }; })(e));
      }
      return chain;
    }
    function flushEntry(e) {
      if (!e.dirty && e.arr.disk[e.pno] !== undefined) { return Promise.resolve(); }
      var old = e.arr.disk[e.pno];
      return call('swap.put', { space: SW.space, b64: b64of(new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength)) }).then(function (r) {
        e.arr.disk[e.pno] = r.id; e.dirty = false; SW.writes++;
        if (old !== undefined) { return call('swap.drop', { space: SW.space, id: old }); }
      });
    }
    function pageOf(arr, pno, forWrite) {
      var found = null;
      for (var i = 0; i < SW.cache.length; i++) { if (SW.cache[i].arr === arr && SW.cache[i].pno === pno) { found = SW.cache.splice(i, 1)[0]; break; } }
      var got;
      if (found) { SW.hits++; got = Promise.resolve(found); }
      else {
        var n = Math.min(arr.perPage, arr.length - pno * arr.perPage);
        if (arr.disk[pno] !== undefined) {
          got = call('swap.get', { space: SW.space, id: arr.disk[pno] }).then(function (r) { SW.reads++; var u = u8of(r.b64); return { arr: arr, pno: pno, dirty: false, data: new arr.T(u.buffer, 0, n) }; });
        } else { got = Promise.resolve({ arr: arr, pno: pno, dirty: false, data: new arr.T(n) }); }
      }
      return got.then(function (e) { if (forWrite) { e.dirty = true; } SW.cache.push(e); return evict(e).then(function () { return e; }); });
    }
    function SwapArr(length, type) {
      var T = TYPES[type || 'f32'];
      if (!T) { throw new Error('swap.array: unknown type ' + type + ' (use ' + Object.keys(TYPES).join(', ') + ')'); }
      this.id = ++SW.seq; this.length = Math.floor(Number(length)); this.T = T; this.disk = {}; this.freed = false;
      if (!(this.length >= 0)) { throw new Error('swap.array: bad length'); }
      this.perPage = Math.max(1, Math.floor(SW.page / T.BYTES_PER_ELEMENT)); SW.arrays[this.id] = this;
    }
    SwapArr.prototype._chk = function (start, count) {
      if (this.freed) { throw new Error('swap array was freed'); }
      if (start < 0 || count < 0 || start + count > this.length) { throw new Error('swap array range ' + start + '..' + (start + count) + ' is outside 0..' + this.length); }
    };
    SwapArr.prototype.get = function (start, count) {
      var self = this; start = Math.floor(start); count = count === undefined ? self.length - start : Math.floor(count); self._chk(start, count);
      var out = new self.T(count), p = Math.floor(start / self.perPage), chain = Promise.resolve();
      for (; p * self.perPage < start + count; p++) {
        chain = chain.then((function (p) { return function () {
          return pageOf(self, p, false).then(function (e) {
            var from = Math.max(start, p * self.perPage), to = Math.min(start + count, (p + 1) * self.perPage);
            out.set(e.data.subarray(from - p * self.perPage, to - p * self.perPage), from - start);
          });
        }; })(p));
      }
      return chain.then(function () { return out; });
    };
    SwapArr.prototype.set = function (start, data) {
      var self = this; start = Math.floor(start); var count = data.length; self._chk(start, count);
      var src = data instanceof self.T ? data : new self.T(data), p = Math.floor(start / self.perPage), chain = Promise.resolve();
      for (; p * self.perPage < start + count; p++) {
        chain = chain.then((function (p) { return function () {
          return pageOf(self, p, true).then(function (e) {
            var from = Math.max(start, p * self.perPage), to = Math.min(start + count, (p + 1) * self.perPage);
            e.data.set(src.subarray(from - start, to - start), from - p * self.perPage);
          });
        }; })(p));
      }
      return chain;
    };
    SwapArr.prototype.fill = function (v) {
      var self = this, chain = Promise.resolve(), pages = Math.ceil(self.length / self.perPage);
      for (var p = 0; p < pages; p++) { chain = chain.then((function (p) { return function () { return pageOf(self, p, true).then(function (e) { e.data.fill(v); }); }; })(p)); }
      return chain;
    };
    // map(fn(block, startIndex) -> optional replacement block): one page at a time, written back
    SwapArr.prototype.map = function (fn, blockLen) {
      var self = this, step = blockLen || self.perPage, chain = Promise.resolve();
      for (var s = 0; s < self.length; s += step) {
        chain = chain.then((function (s) { return function () {
          return self.get(s, Math.min(step, self.length - s)).then(function (b) { var r = fn(b, s); return self.set(s, r || b); });
        }; })(s));
      }
      return chain;
    };
    SwapArr.prototype.free = function () {
      var self = this, ids = Object.keys(self.disk).map(function (k) { return self.disk[k]; });
      SW.cache = SW.cache.filter(function (e) { return e.arr !== self; }); self.freed = true; delete SW.arrays[self.id];
      return ids.reduce(function (c, id) { return c.then(function () { return call('swap.drop', { space: SW.space, id: id }); }); }, Promise.resolve());
    };
    window.swap = {
      array: function (length, type) { return new SwapArr(length, type); },
      hotMB: function (n) { SW.hot = Math.max(0, Number(n)) * 1048576; return evict(null); },
      flush: function () { return Promise.all(SW.cache.map(flushEntry)); },
      stats: function () { return call('swap.stats', { space: SW.space }).then(function (h) { return { pagesHot: SW.cache.length, hotBytes: hotSize(), limit: SW.hot, reads: SW.reads, writes: SW.writes, hits: SW.hits, arrays: Object.keys(SW.arrays).length, host: h }; }); },
      close: function () { SW.cache = []; SW.arrays = {}; return call('swap.close', { space: SW.space }); }
    };
    window.swap.__space = SW.space;

    window.gui = {
      open: function (title, width) {
        var id = 'w' + Math.random().toString(36).slice(2, 10);
        return call('gui.open', { id: id, title: String(title), width: Number(width) || 360 }).then(function () { return new Win(id); });
      }
    };

    var run = new Function('return (async function () {\n' + code + '\n})();');
    function closeSwap() { return Promise.resolve().then(function () { return window.swap.close(); }).catch(function () {}); }
    Promise.resolve().then(run).then(function () {
      return closeSwap().then(function () { parent.postMessage({ __done: { ok: true } }, '*'); });
    }, function (e) {
      return closeSwap().then(function () { parent.postMessage({ __done: { ok: false, error: String((e && e.stack) || e) } }, '*'); });
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
      // Ctrl+C: the terminal calls the registered function to stop the program (removing the iframe stops even a busy loop)
      if (opts.onAbortable) { opts.onAbortable(function () { finish({ ok: false, stdout: out.join(''), stderr: err.join('') + 'node: interrupted\n', exit_code: 130 }); }); }
      timer = setTimeout(function () {
        finish({ ok: false, stdout: out.join(''), stderr: err.join('') + 'node: timed out\n', exit_code: 124 });
      }, timeoutMs);
      iframe.srcdoc = buildSrcdoc(code);
      document.body.appendChild(iframe);
    });
  }

  return { run: run, buildSrcdoc: buildSrcdoc, programShim: programShim };
}));
