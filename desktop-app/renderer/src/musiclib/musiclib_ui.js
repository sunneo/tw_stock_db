/* 音樂庫的畫面（UMD）：像 library 的清單。
 *   上方工具列：＋加檔案、＋加資料夾、搜尋框、範圍（全部／不含歌詞／只查歌詞）、筆數統計。
 *   歌詞列：轉錄歌詞（勾選的曲目；沒勾選就全部未轉錄）、暫停／續跑、進度（完成、排隊、轉錄中＋百分比、失敗數）。
 *   清單：路徑、檔名、專輯、種類、長度、歌詞狀態（失敗會顯示具體原因）；每列有勾選框（多選）。
 *   搜尋時，歌詞命中的段落與時間點列在該曲目下面。已消失的檔案用刪除線顯示，搜尋時不出現。
 * 依賴：core（musiclib_core.js）、library（M.createLibrary 的結果，需已 load()）、queue（M.createLyricQueue 的結果，可不給）。
 * host 可以不給（瀏覽器用 <input type=file>，只拿得到檔名）；桌面版給 host.pickFolder：回傳 null（取消）或
 * { label, entries:[{path,size,mtimeMs}], readHead(path, n) → Promise<Uint8Array|null> }。
 * 掛載：FaMusicLibUI.mount(container, { library, host, queue }) → { refresh(), destroy() }。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./musiclib_core.js')); else root.FaMusicLibUI = factory(root.FaMusicLib || (typeof FaMusicLib !== 'undefined' ? FaMusicLib : undefined));
})(typeof self !== 'undefined' ? self : this, function (M) {
  'use strict';
  var CSS = '.fml{font:13px system-ui,"Microsoft JhengHei",sans-serif;color:#1f2328;background:#fff;border:1px solid #d0d7de;border-radius:8px;overflow:hidden;max-width:100%}'
    + '.fml-bar,.fml-lyr{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:6px 8px;background:#f6f8fa;border-bottom:1px solid #d0d7de}'
    + '.fml button,.fml select{background:#f6f8fa;border:1px solid #d0d7de;border-radius:5px;padding:3px 9px;cursor:pointer;font:inherit}'
    + '.fml button:disabled{opacity:.45;cursor:default}'
    + '.fml-bar input[type=search]{flex:1;min-width:160px;padding:4px 6px;border:1px solid #d0d7de;border-radius:5px;font:inherit}'
    + '.fml-st{color:#59636e;font-size:12px}.fml-wrap{overflow:auto;max-height:520px}.fml-lyr .fml-st{flex:1}'
    + '.fml-tbl{width:100%;border-collapse:collapse}.fml-tbl th,.fml-tbl td{padding:4px 6px;border-bottom:1px solid #eaeef2;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:260px}'
    + '.fml-tbl th{background:#f6f8fa;position:sticky;top:0}.fml-tbl tr.gone td{color:#8c959f;text-decoration:line-through}'
    + '.fml-tbl td.bad{color:#cf222e}.fml-hit td{white-space:normal;color:#59636e;font-size:12px;padding-left:28px}'
    + '.fml-foot{padding:6px 8px;color:#59636e;font-size:12px;border-top:1px solid #d0d7de}';
  var COLS = ['路徑', '檔名', '專輯', '種類', '長度', '歌詞'];
  var LYRIC_TEXT = { none: '未轉錄', queued: '排隊中', running: '轉錄中', done: '完成', failed: '失敗' };

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
    var lib = opts.library, host = opts.host || {}, queue = opts.queue || null;
    var q = '', scope = 'all', msg = '', sel = {}, unsub = null;
    var root = h('div', 'fml');
    var style = h('style'); style.textContent = CSS; root.appendChild(style);

    var bar = h('div', 'fml-bar');
    var bFile = h('button', null, '＋加檔案');
    var bFolder = h('button', null, '＋加資料夾');
    var search = h('input'); search.type = 'search'; search.placeholder = '搜尋：檔名、專輯、標題、演出者、歌詞（空白分隔多個關鍵字）';
    var sSel = h('select');
    [['all', '全部（含歌詞）'], ['meta', '不含歌詞'], ['lyrics', '只查歌詞']].forEach(function (o) { var op = h('option', null, o[1]); op.value = o[0]; sSel.appendChild(op); });
    var stat = h('span', 'fml-st');
    bar.appendChild(bFile); bar.appendChild(bFolder); bar.appendChild(search); bar.appendChild(sSel); bar.appendChild(stat);

    var lyr = h('div', 'fml-lyr');
    var bLyr = h('button', null, '轉錄歌詞');
    var bPause = h('button', null, '暫停');
    var bCancel = h('button', null, '取消轉錄');
    var lyrStat = h('span', 'fml-st');
    lyr.appendChild(bLyr); lyr.appendChild(bPause); lyr.appendChild(bCancel); lyr.appendChild(lyrStat);
    if (!queue) { bLyr.disabled = true; bPause.disabled = true; bCancel.disabled = true; lyrStat.textContent = '歌詞轉錄不可用（需要桌面版）'; }

    var wrap = h('div', 'fml-wrap');
    var tbl = h('table', 'fml-tbl');
    var thead = h('thead'), tbody = h('tbody');
    tbl.appendChild(thead); tbl.appendChild(tbody); wrap.appendChild(tbl);
    var foot = h('div', 'fml-foot');

    var fIn = h('input'); fIn.type = 'file'; fIn.multiple = true; fIn.style.display = 'none';
    var dIn = h('input'); dIn.type = 'file'; dIn.setAttribute('webkitdirectory', ''); dIn.style.display = 'none';
    root.appendChild(bar); root.appendChild(lyr); root.appendChild(wrap); root.appendChild(foot); root.appendChild(fIn); root.appendChild(dIn);
    container.appendChild(root);

    function visibleRows() {
      if (q.trim()) return lib.search(q, { scope: scope }).map(function (x) { return { r: x.record, hits: x.lyricHits || [] }; });
      return lib.records.slice().sort(function (a, b) {
        return (a.album || '').localeCompare(b.album || '') || a.name.localeCompare(b.name);
      }).map(function (r) { return { r: r, hits: [] }; });
    }
    function lyricCell(r) {
      if (r.pending) return '—（遊戲來源，待擷取）';
      var st = r.lyricStatus || 'none';
      if (st === 'running' && queue) { var s = queue.state(); return '轉錄中 ' + (s.progress != null ? Math.round(s.progress * 100) + '%' : ''); }
      if (st === 'done') return '完成（' + ((r.lyrics && r.lyrics.segments) || []).length + ' 段）';
      if (st === 'failed') return '失敗：' + (r.lyricError || '未知原因');
      return LYRIC_TEXT[st] || st;
    }
    function render() {
      var rows = visibleRows();
      thead.innerHTML = '';
      var htr = h('tr'); var all = h('input'); all.type = 'checkbox';
      all.checked = rows.length > 0 && rows.every(function (x) { return !!sel[x.r.key]; });
      all.onchange = function () { rows.forEach(function (x) { if (all.checked) sel[x.r.key] = true; else delete sel[x.r.key]; }); render(); };
      var th0 = h('th'); th0.appendChild(all); htr.appendChild(th0);
      COLS.forEach(function (c) { htr.appendChild(h('th', null, c)); });
      thead.appendChild(htr);

      tbody.innerHTML = '';
      rows.forEach(function (x) {
        var r = x.r;
        var tr = h('tr'); if (r.status === 'missing') tr.className = 'gone';
        var cb = h('input'); cb.type = 'checkbox'; cb.checked = !!sel[r.key];
        cb.onchange = function () { if (cb.checked) sel[r.key] = true; else delete sel[r.key]; foot.textContent = selText(); };
        var td0 = h('td'); td0.appendChild(cb); tr.appendChild(td0);
        tr.appendChild(h('td', null, r.path));
        tr.appendChild(h('td', null, r.name + (r.status === 'missing' ? '（已消失）' : '')));
        tr.appendChild(h('td', null, r.album || ''));
        tr.appendChild(h('td', null, r.label || r.kind));
        tr.appendChild(h('td', null, M.formatDuration(r.durationSec) + (r.durationApprox ? '≈' : '')));
        var lc = h('td', (r.lyricStatus === 'failed' ? 'bad' : null), lyricCell(r)); lc.title = r.lyricStatus === 'failed' ? (r.lyricError || '') : '';
        tr.appendChild(lc);
        tbody.appendChild(tr);
        x.hits.forEach(function (hit) {
          var ht = h('tr', 'fml-hit'); var td = h('td'); td.colSpan = COLS.length + 1;
          td.textContent = '〔' + M.formatDuration(hit.start) + '–' + M.formatDuration(hit.end) + '〕' + hit.text;
          ht.appendChild(td); tbody.appendChild(ht);
        });
      });
      var total = lib.records.filter(function (r) { return r.status !== 'missing'; }).length;
      stat.textContent = (q.trim() ? '找到 ' + rows.length + ' 首' : '共 ' + total + ' 個檔案') + (msg ? '　' + msg : '');
      renderLyr();
      foot.textContent = selText();
    }
    function renderLyr() {
      if (!queue) return;
      var s = queue.state(), c = s.counts;
      var parts = ['完成 ' + c.done, '排隊 ' + c.queued, '未轉錄 ' + c.none, '失敗 ' + c.failed];
      if (s.running) {
        var cur = s.current ? (lib.records.filter(function (r) { return r.key === s.current; })[0] || {}) : {};
        var line = '轉錄中：' + (cur.name || '') + (s.progress != null ? '（' + Math.round(s.progress * 100) + '%）' : '');
        if (s.retry) line += '｜第 ' + s.retry.afterAttempt + ' 次失敗，' + Math.max(0, Math.ceil((s.retry.untilAt - Date.now()) / 1000)) + ' 秒後自動重試';
        else if (s.stage) line += '｜階段：' + (s.stageLabel || s.stage) + '（已 ' + Math.max(0, Math.round((Date.now() - s.stageSince) / 1000)) + ' 秒）' + (s.attempt > 1 ? '｜第 ' + s.attempt + ' 次嘗試' : '') + (s.stageDetail ? '｜' + s.stageDetail : '');
        parts.push(line);
      }
      if (s.paused) parts.push('已暫停');
      if (s.saveError) parts.push('⚠️ 存檔失敗：' + s.saveError);
      lyrStat.textContent = '歌詞：' + parts.join('、');
      bPause.textContent = s.paused ? '續跑' : '暫停';
      bCancel.disabled = !(s.running || s.queued > 0);
    }
    function selText() { var n = Object.keys(sel).length; return '已選 ' + n + ' 首' + (n ? '（轉錄歌詞會只跑勾選的未完成曲目）' : '（沒勾選時，轉錄歌詞會跑全部未完成曲目）'); }

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
      var fn = kind === 'folder' ? host.pickFolder : null;
      if (fn) { var src = await fn(); if (src) addFrom('folder', src); return; } // 取消（null）就什麼都不做
      (kind === 'folder' ? dIn : fIn).click();
    }

    bFile.onclick = function () { pick('file'); };
    bFolder.onclick = function () { pick('folder'); };
    fIn.onchange = function () { var src = fromFileList(fIn.files, false); fIn.value = ''; addFrom('file', src); };
    dIn.onchange = function () { var src = fromFileList(dIn.files, true); dIn.value = ''; addFrom('folder', src); };
    search.oninput = function () { q = search.value; render(); };
    sSel.onchange = function () { scope = sSel.value; render(); };

    // 轉錄：勾選的未完成曲目；沒勾選就全部未完成（佇列自己跳過已完成的）
    bLyr.onclick = function () {
      if (!queue) return;
      var keys = Object.keys(sel).filter(function (k) { var r = lib.records.filter(function (x) { return x.key === k; })[0]; return r && r.status === 'ok' && !r.pending && r.lyricStatus !== 'done'; });
      var n = queue.enqueue(keys);
      msg = keys.length ? '已排入 ' + keys.length + ' 首' : '已排入全部未完成曲目（佇列共 ' + n + ' 首）';
      if (queue.state().paused) msg += '；目前是暫停中，按「續跑」開始';
      render();
    };
    // 取消：清空排隊、中止正在跑的那一首（不算失敗），面板卡住時先按這個
    bCancel.onclick = function () { if (!queue) return; queue.cancelAll(); msg = '已取消轉錄（排隊清空，進行中的那首回到未轉錄）'; render(); };
    bPause.onclick = function () { if (!queue) return; if (queue.state().paused) queue.resume(); else queue.pause(); render(); };

    if (queue) unsub = queue.onChange(function () { render(); });
    // 轉錄中每秒更新「已耗時」與重試倒數（只更新歌詞列，不重畫清單）
    var ticker = setInterval(function () {
      if (!root.isConnected) { clearInterval(ticker); if (unsub) unsub(); return; } // 面板已從對話移除：停掉計時與監聽
      if (queue && queue.state().running) renderLyr();
    }, 1000);
    render();
    return {
      refresh: render,
      destroy: function () { clearInterval(ticker); if (unsub) unsub(); if (root.parentNode) root.parentNode.removeChild(root); }
    };
  }

  return { mount: mount, fromFileList: fromFileList, CSS: CSS };
});
