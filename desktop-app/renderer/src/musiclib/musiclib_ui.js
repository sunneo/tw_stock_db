/* 音樂庫的最小畫面（UMD）：像 library 的清單，不做輸出。
 *   上方工具列：＋加檔案、＋加資料夾、搜尋框（多關鍵字，檔名／專輯／標題／演出者都查）、筆數統計。
 *   中間清單：路徑、檔名、專輯、種類、長度；每列有勾選框（多選，給之後的批次輸出預留；這階段不輸出）。
 *   已消失的檔案用刪除線顯示，搜尋時不出現。
 * 只依賴：core（musiclib_core.js）與 library（M.createLibrary 的結果，需已 load()）。
 * host 可以不給（瀏覽器用 <input type=file>，只拿得到檔名，拿不到完整路徑）；桌面版可以給 host.pickFiles／pickFolder，
 * 回傳 null（取消）或 { label, entries:[{path,size,mtimeMs}], readHead(path, n) → Promise<Uint8Array|null> }，這樣路徑才是真的磁碟路徑。
 * 掛載：FaMusicLibUI.mount(container, { library, host }) → { refresh(), destroy() }。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./musiclib_core.js')); else root.FaMusicLibUI = factory(root.FaMusicLib || (typeof FaMusicLib !== 'undefined' ? FaMusicLib : undefined));
})(typeof self !== 'undefined' ? self : this, function (M) {
  'use strict';
  var CSS = '.fml{font:13px system-ui,"Microsoft JhengHei",sans-serif;color:#1f2328;background:#fff;border:1px solid #d0d7de;border-radius:8px;overflow:hidden;max-width:100%}'
    + '.fml-bar{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:6px 8px;background:#f6f8fa;border-bottom:1px solid #d0d7de}'
    + '.fml-bar button{background:#f6f8fa;border:1px solid #d0d7de;border-radius:5px;padding:3px 9px;cursor:pointer;font:inherit}'
    + '.fml-bar input[type=search]{flex:1;min-width:160px;padding:4px 6px;border:1px solid #d0d7de;border-radius:5px;font:inherit}'
    + '.fml-st{color:#59636e;font-size:12px}.fml-wrap{overflow:auto;max-height:520px}'
    + '.fml-tbl{width:100%;border-collapse:collapse}.fml-tbl th,.fml-tbl td{padding:4px 6px;border-bottom:1px solid #eaeef2;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:260px}'
    + '.fml-tbl th{background:#f6f8fa;position:sticky;top:0}.fml-tbl tr.gone td{color:#8c959f;text-decoration:line-through}'
    + '.fml-foot{padding:6px 8px;color:#59636e;font-size:12px;border-top:1px solid #d0d7de}';
  var COLS = ['路徑', '檔名', '專輯', '種類', '長度'];

  function h(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  // 把瀏覽器的 File 清單轉成掃描用的 { label, entries, readHead }。資料夾用 webkitRelativePath，檔案只有檔名。
  function fromFileList(list, folder) {
    var files = Array.prototype.slice.call(list || []), map = {};
    var entries = files.map(function (f) {
      var p = folder ? (f.webkitRelativePath || f.name) : f.name;
      map[p] = f;
      return { path: p, size: f.size, mtimeMs: f.lastModified };
    });
    var readHead = function (p, n) {
      var f = map[p];
      if (!f) return Promise.resolve(null);
      return f.slice(0, n).arrayBuffer().then(function (b) { return new Uint8Array(b); });
    };
    var label = folder ? String((files[0] && files[0].webkitRelativePath) || '資料夾').split('/')[0] : files.length + ' 個檔案';
    return { label: label, entries: entries, readHead: readHead };
  }

  function mount(container, opts) {
    opts = opts || {};
    var lib = opts.library, host = opts.host || {};
    var q = '', msg = '', sel = {};
    var root = h('div', 'fml');
    var style = h('style'); style.textContent = CSS; root.appendChild(style);

    var bar = h('div', 'fml-bar');
    var bFile = h('button', null, '＋加檔案');
    var bFolder = h('button', null, '＋加資料夾');
    var search = h('input'); search.type = 'search'; search.placeholder = '搜尋：檔名、專輯、標題、演出者（空白分隔多個關鍵字）';
    var stat = h('span', 'fml-st');
    bar.appendChild(bFile); bar.appendChild(bFolder); bar.appendChild(search); bar.appendChild(stat);

    var wrap = h('div', 'fml-wrap');
    var tbl = h('table', 'fml-tbl');
    var thead = h('thead'), tbody = h('tbody');
    tbl.appendChild(thead); tbl.appendChild(tbody); wrap.appendChild(tbl);
    var foot = h('div', 'fml-foot');

    var fIn = h('input'); fIn.type = 'file'; fIn.multiple = true; fIn.style.display = 'none';
    var dIn = h('input'); dIn.type = 'file'; dIn.setAttribute('webkitdirectory', ''); dIn.style.display = 'none';
    root.appendChild(bar); root.appendChild(wrap); root.appendChild(foot); root.appendChild(fIn); root.appendChild(dIn);
    container.appendChild(root);

    function visibleRows() {
      if (q.trim()) return lib.search(q).map(function (x) { return x.record; });
      return lib.records.slice().sort(function (a, b) {
        return (a.album || '').localeCompare(b.album || '') || a.name.localeCompare(b.name);
      });
    }
    function render() {
      var rows = visibleRows();
      thead.innerHTML = '';
      var htr = h('tr'); var all = h('input'); all.type = 'checkbox';
      all.checked = rows.length > 0 && rows.every(function (r) { return !!sel[r.key]; });
      all.onchange = function () { rows.forEach(function (r) { if (all.checked) sel[r.key] = true; else delete sel[r.key]; }); render(); };
      var th0 = h('th'); th0.appendChild(all); htr.appendChild(th0);
      COLS.forEach(function (c) { htr.appendChild(h('th', null, c)); });
      thead.appendChild(htr);

      tbody.innerHTML = '';
      rows.forEach(function (r) {
        var tr = h('tr'); if (r.status === 'missing') tr.className = 'gone';
        var cb = h('input'); cb.type = 'checkbox'; cb.checked = !!sel[r.key];
        cb.onchange = function () { if (cb.checked) sel[r.key] = true; else delete sel[r.key]; foot.textContent = selText(); };
        var td0 = h('td'); td0.appendChild(cb); tr.appendChild(td0);
        tr.appendChild(h('td', null, r.path));
        tr.appendChild(h('td', null, r.name + (r.status === 'missing' ? '（已消失）' : '')));
        tr.appendChild(h('td', null, r.album || ''));
        tr.appendChild(h('td', null, r.label || r.kind));
        tr.appendChild(h('td', null, M.formatDuration(r.durationSec) + (r.durationApprox ? '≈' : '')));
        tbody.appendChild(tr);
      });
      var total = lib.records.filter(function (r) { return r.status !== 'missing'; }).length;
      stat.textContent = (q.trim() ? '找到 ' + rows.length + ' 首' : '共 ' + total + ' 個檔案') + (msg ? '　' + msg : '');
      foot.textContent = selText();
    }
    function selText() { var n = Object.keys(sel).length; return '已選 ' + n + ' 個（批次輸出之後的階段才做）'; }

    async function addFrom(type, src) {
      if (!src || !src.entries || !src.entries.length) { msg = '沒有可加入的檔案'; render(); return; }
      var sid = lib.addSource(type, src.label);
      msg = '掃描中…'; render();
      try {
        var rep = await lib.scan(sid, src.entries, src.readHead);
        await lib.save();
        msg = '新增 ' + rep.added + '、變更 ' + rep.changed + '、未變 ' + rep.unchanged + '、消失 ' + rep.missing + '、略過 ' + rep.skipped;
      } catch (e) {
        msg = '掃描失敗：' + (e && e.message);
      }
      render();
    }
    async function pick(kind) {
      var fn = kind === 'folder' ? host.pickFolder : host.pickFiles;
      if (fn) { var src = await fn(); if (src) addFrom(kind === 'folder' ? 'folder' : 'file', src); return; } // 取消（null）就什麼都不做
      (kind === 'folder' ? dIn : fIn).click();
    }

    bFile.onclick = function () { pick('file'); };
    bFolder.onclick = function () { pick('folder'); };
    fIn.onchange = function () { var src = fromFileList(fIn.files, false); fIn.value = ''; addFrom('file', src); };
    dIn.onchange = function () { var src = fromFileList(dIn.files, true); dIn.value = ''; addFrom('folder', src); };
    search.oninput = function () { q = search.value; render(); };

    render();
    return {
      refresh: render,
      destroy: function () { if (root.parentNode) root.parentNode.removeChild(root); }
    };
  }

  return { mount: mount, fromFileList: fromFileList, CSS: CSS };
});
