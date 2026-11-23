/* 音樂庫的畫面（UMD）：像 library 的清單。
 *   上方工具列：＋加檔案、＋加資料夾、搜尋框、範圍（全部／不含歌詞／只查歌詞）、移除勾選、來源管理、筆數統計。
 *   歌詞列：轉錄歌詞（勾選的曲目；沒勾選就全部未轉錄）、暫停／續跑、進度（完成、排隊、轉錄中＋百分比、失敗數）。
 *   清單：樹狀。來源列下面可展開擷取產物（derivedFrom 指向來源），子列縮排並標「擷取產物（不是檔案系統上的檔案）」與擷取方式。
 *     搜尋命中子曲目時，它的來源會自動展開。每列都有「▶ 播放」（走通用播放模組 FaMediaPlay）與「移除」。
 *   移除：原始檔只從曲庫移除，絕不刪磁碟上的原始檔；擷取產物的衍生檔會刪（只刪衍生資料夾裡的，並確認真的消失）；
 *     移除來源時會問是否連同擷取產物一併移除（預設連同）；每次移除都先確認並說明會發生什麼。
 *   搜尋時，歌詞命中的段落列在該曲目下面。已消失的檔案用刪除線顯示，搜尋時不出現。
 * 依賴：core（musiclib_core.js）、library（M.createLibrary 的結果，需已 load()）、queue（M.createLyricQueue 的結果，可不給）、
 *   FaMediaPlay（musiclib_play.js，可不給＝播放鈕停用）。
 * host 可以不給（瀏覽器用 <input type=file>，只拿得到檔名）；桌面版給 host.pickFolder：回傳 null（取消）或
 * { label, entries:[{path,size,mtimeMs}], readHead(path, n) → Promise<Uint8Array|null> }。host.play 是通用播放的 host，host.library 是移除用的（isDerivedPath、removeFiles）。
 * 掛載：FaMusicLibUI.mount(container, { library, host, queue }) → { refresh(), destroy() }。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./musiclib_core.js')); else root.FaMusicLibUI = factory(root.FaMusicLib || (typeof FaMusicLib !== 'undefined' ? FaMusicLib : undefined));
})(typeof self !== 'undefined' ? self : this, function (M) {
  'use strict';
  var CSS = '.fml{font:13px system-ui,"Microsoft JhengHei",sans-serif;color:#1f2328;background:#fff;border:1px solid #d0d7de;border-radius:8px;overflow:hidden;max-width:100%}'
    + '.fml-bar,.fml-lyr{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:6px 8px;background:#f6f8fa;border-bottom:1px solid #d0d7de}'
    + '.fml button,.fml select{background:#f6f8fa;border:1px solid #d0d7de;border-radius:5px;padding:3px 9px;cursor:pointer;font:inherit}'
    + '.fml button:disabled{opacity:.45;cursor:default}'
    + '.fml-lyr input[type=text]{flex:1;min-width:180px;padding:4px 6px;border:1px solid #d0d7de;border-radius:5px;font:inherit}'
    + '.fml-bar input[type=search]{flex:1;min-width:160px;padding:4px 6px;border:1px solid #d0d7de;border-radius:5px;font:inherit}'
    + '.fml-st{color:#59636e;font-size:12px}.fml-wrap{overflow:auto;max-height:520px}.fml-lyr .fml-st{flex:1}'
    + '.fml-tbl{width:100%;border-collapse:collapse}.fml-tbl th,.fml-tbl td{padding:4px 6px;border-bottom:1px solid #eaeef2;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:260px}'
    + '.fml-tbl th{background:#f6f8fa;position:sticky;top:0}.fml-tbl tr.gone td{color:#8c959f;text-decoration:line-through}'
    + '.fml-tbl td.bad{color:#cf222e}.fml-hit td{white-space:normal;color:#59636e;font-size:12px;padding-left:28px}'
    + '.fml-tbl tr.kid td{background:#fbfcfd}.fml-tbl button.tg{border:none;background:none;padding:0 4px;font-size:12px}'
    + '.fml-foot{padding:6px 8px;color:#59636e;font-size:12px;border-top:1px solid #d0d7de}';
  var COLS = ['路徑', '檔名', '專輯', '種類', '長度', '歌詞', '操作'];
  var LYRIC_TEXT = { none: '未轉錄', queued: '排隊中', running: '轉錄中', done: '完成', failed: '失敗' };

  function h(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function errText(e) { return String((e && e.message) || e); }
  function bySort(a, b) { return (a.album || '').localeCompare(b.album || '') || a.name.localeCompare(b.name); }

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
    var q = '', scope = 'all', msg = '', sel = {}, unsub = null, expanded = {}, showSources = false, playTr = null;
    var root = h('div', 'fml');
    var style = h('style'); style.textContent = CSS; root.appendChild(style);

    var bar = h('div', 'fml-bar');
    var bFile = h('button', null, '＋加檔案');
    var bFolder = h('button', null, '＋加資料夾');
    var search = h('input'); search.type = 'search'; search.placeholder = '搜尋：檔名、專輯、標題、演出者、歌詞（空白分隔多個關鍵字）';
    var sSel = h('select');
    [['all', '全部（含歌詞）'], ['meta', '不含歌詞'], ['lyrics', '只查歌詞']].forEach(function (o) { var op = h('option', null, o[1]); op.value = o[0]; sSel.appendChild(op); });
    var bDel = h('button', null, '移除勾選');
    var bSrc = h('button', null, '來源管理');
    var stat = h('span', 'fml-st');
    bar.appendChild(bFile); bar.appendChild(bFolder); bar.appendChild(search); bar.appendChild(sSel); bar.appendChild(bDel); bar.appendChild(bSrc); bar.appendChild(stat);

    var lyr = h('div', 'fml-lyr');
    var bLyr = h('button', null, '轉錄歌詞');
    var bPause = h('button', null, '暫停');
    var bCancel = h('button', null, '取消轉錄');
    var lyrStat = h('span', 'fml-st');
    lyr.appendChild(bLyr); lyr.appendChild(bPause); lyr.appendChild(bCancel); lyr.appendChild(lyrStat);
    if (!queue) { bLyr.disabled = true; bPause.disabled = true; bCancel.disabled = true; lyrStat.textContent = '歌詞轉錄不可用（需要桌面版）'; }

    // 批次輸出列：格式（mp3／mid）、分鐘數（預設 1）或勾「整首」、開始／取消
    var exp = h('div', 'fml-lyr');
    var eFmt = h('select'); [['mp3', 'mp3'], ['mid', 'mid']].forEach(function (o) { var op = h('option', null, o[1]); op.value = o[0]; eFmt.appendChild(op); });
    var eMin = h('input'); eMin.type = 'number'; eMin.min = '0.1'; eMin.step = '0.5'; eMin.value = '1'; eMin.style.width = '70px';
    var eWhole = h('input'); eWhole.type = 'checkbox';
    var eWholeLbl = h('label', null, '整首'); eWholeLbl.appendChild(eWhole);
    var eModel = h('input'); eModel.type = 'checkbox';
    var eModelLbl = h('label', null, '音訊轉 mid 用 Basic Pitch'); eModelLbl.appendChild(eModel);
    exp.appendChild(eModelLbl);
    var bExp = h('button', null, '批次輸出');
    var bExpCancel = h('button', null, '取消輸出');
    var expStat = h('span', 'fml-st');
    exp.appendChild(eFmt); exp.appendChild(h('span', 'fml-st', '分鐘')); exp.appendChild(eMin); exp.appendChild(eWholeLbl); exp.appendChild(bExp); exp.appendChild(bExpCancel); exp.appendChild(expStat);
    var expList = h('div', 'fml-foot');
    if (!host.exportBatch) { bExp.disabled = true; bExpCancel.disabled = true; expStat.textContent = '批次輸出不可用（需要桌面版）'; }
    bExpCancel.disabled = true;

    // YouTube 清單列：貼清單網址（或單支影片連結）→ 展開 → 逐支驗證、下載、登記；暫停／續跑／取消；逐支結果列在下面
    var yt = h('div', 'fml-lyr');
    var ytIn = h('input'); ytIn.type = 'text'; ytIn.placeholder = '貼 YouTube 清單網址（或單支影片連結）';
    var bYt = h('button', null, '＋加入 YouTube 清單');
    var bYtPause = h('button', null, '暫停');
    var bYtCancel = h('button', null, '取消');
    var ytStat = h('span', 'fml-st');
    yt.appendChild(ytIn); yt.appendChild(bYt); yt.appendChild(bYtPause); yt.appendChild(bYtCancel); yt.appendChild(ytStat);
    var ytList = h('div', 'fml-foot');
    ytList.style.display = 'none';
    bYtPause.disabled = true; bYtCancel.disabled = true;
    if (!host.startYoutubeList) { bYt.disabled = true; ytIn.disabled = true; ytStat.textContent = 'YouTube 清單不可用（需要桌面版）'; }

    var wrap = h('div', 'fml-wrap');
    var tbl = h('table', 'fml-tbl');
    var thead = h('thead'), tbody = h('tbody');
    tbl.appendChild(thead); tbl.appendChild(tbody); wrap.appendChild(tbl);
    var foot = h('div', 'fml-foot');
    var srcBox = h('div', 'fml-foot'); srcBox.style.display = 'none';

    var fIn = h('input'); fIn.type = 'file'; fIn.multiple = true; fIn.style.display = 'none';
    var dIn = h('input'); dIn.type = 'file'; dIn.setAttribute('webkitdirectory', ''); dIn.style.display = 'none';
    root.appendChild(bar); root.appendChild(yt); root.appendChild(ytList); root.appendChild(lyr); root.appendChild(exp); root.appendChild(expList); root.appendChild(wrap); root.appendChild(foot); root.appendChild(srcBox); root.appendChild(fIn); root.appendChild(dIn);
    container.appendChild(root);

    // 要顯示的紀錄：搜尋時＝命中的（子曲目命中就把來源也放進來）；平常＝全部
    function visibleSet() {
      if (!q.trim()) return { recs: lib.records.slice().sort(bySort), hits: {}, searching: false, count: 0 };
      var hits = lib.search(q, { scope: scope }), hitMap = {}, keep = {}, byKey = {};
      lib.records.forEach(function (r) { byKey[r.key] = r; });
      hits.forEach(function (x) { keep[x.record.key] = true; hitMap[x.record.key] = x.lyricHits || []; });
      hits.forEach(function (x) { var p = x.record.derivedFrom; if (p && byKey[p] && !keep[p]) { keep[p] = true; hitMap[p] = []; } });
      return { recs: lib.records.filter(function (r) { return keep[r.key]; }).sort(bySort), hits: hitMap, searching: true, count: hits.length };
    }
    function lyricCell(r) {
      if (r.pending) return '—（遊戲來源，待擷取）';
      var st = r.lyricStatus || 'none';
      if (st === 'running' && queue) { var s = queue.state(); return '轉錄中 ' + (s.progress != null ? Math.round(s.progress * 100) + '%' : ''); }
      if (st === 'done') return '完成（' + ((r.lyrics && r.lyrics.segments) || []).length + ' 段）';
      if (st === 'failed') return '失敗：' + (r.lyricError || '未知原因');
      return LYRIC_TEXT[st] || st;
    }
    function isDp() { return host.library && host.library.isDerivedPath ? host.library.isDerivedPath : null; }

    // 播放：卡片接在列的下面（一次只開一張）；重新整理清單時卡片會消失，再按一次按鈕即可
    function playRow(rec, anchor) {
      if (!host.play || typeof FaMediaPlay === 'undefined') { msg = '播放不可用（需要桌面版）'; render(); return; }
      if (playTr && playTr.parentNode) playTr.parentNode.removeChild(playTr);
      playTr = h('tr', 'fml-hit'); var td = h('td'); td.colSpan = COLS.length + 1;
      td.appendChild(FaMediaPlay.mount(rec, host.play));
      playTr.appendChild(td);
      anchor.parentNode.insertBefore(playTr, anchor.nextSibling);
    }

    // 移除：先算計畫（planFn(includeDerived) → plan），說明會發生什麼，再確認；原始檔不刪，衍生檔才刪並確認消失
    async function removeFlow(planFn, label) {
      var planAll = planFn(true), planNo = planFn(false);
      if (!planAll.removeKeys.length) { msg = '沒有要移除的項目'; render(); return; }
      var kidExtra = planAll.derived - planNo.derived;
      if (!confirm('確定要移除「' + label + '」嗎？\n\n將從曲庫移除 ' + planAll.removeKeys.length + ' 筆紀錄（原始檔 ' + planAll.originals + ' 個，擷取產物 ' + planAll.derived + ' 個）。\n原始檔不會被刪除，只從曲庫移除；擷取產物的衍生檔會從磁碟刪除。')) return;
      var plan = planAll;
      if (kidExtra > 0) {
        var keepKids = !confirm('這些來源有 ' + kidExtra + ' 個擷取產物。\n\n【確定】＝連同擷取產物一併移除（衍生檔會刪除）\n【取消】＝保留擷取產物（它們會變成沒有來源的獨立列，檔案不動）');
        if (keepKids) plan = planNo;
      }
      var failed = {}, okDel = 0, reasons = [];
      try {
        if (plan.deleteFiles.length) {
          var remover = host.library && host.library.removeFiles;
          if (!remover) { msg = '刪除衍生檔的通道不存在（需要桌面版），已取消'; render(); return; }
          msg = '刪除衍生檔中…'; render();
          var res = await remover(plan.deleteFiles.map(function (f) { return f.path; }));
          res.forEach(function (x, i) { if (x.ok) okDel++; else { failed[plan.deleteFiles[i].key] = true; reasons.push(x.reason); } });
        }
        var keysApply = plan.removeKeys.filter(function (k) { return !failed[k]; });
        var anyFail = Object.keys(failed).length > 0;
        lib.applyRemove(plan, { keys: keysApply, dropSource: !anyFail });
        await lib.save();
        keysApply.forEach(function (k) { delete sel[k]; });
        msg = '已移除 ' + keysApply.length + ' 筆紀錄，刪除衍生檔 ' + okDel + ' 個'
          + (anyFail ? '；' + Object.keys(failed).length + ' 個衍生檔刪不掉，那幾筆保留（' + reasons[0] + '）' : '')
          + (plan.skipped.length ? '；' + plan.skipped.length + ' 筆的路徑不在衍生資料夾，只移除記錄' : '');
      } catch (e) {
        msg = '移除失敗：' + errText(e);
      }
      playTr = null;
      render();
    }
    function removeOne(r) { removeFlow(function (inc) { return lib.planRemove([r.key], { includeDerived: inc, isDerivedPath: isDp() }); }, r.name); }

    function render() {
      var V = visibleSet();
      var rows = M.buildTreeRows(V.recs, { expanded: expanded, forceExpand: V.searching });
      thead.innerHTML = '';
      var htr = h('tr'); var all = h('input'); all.type = 'checkbox';
      all.checked = rows.length > 0 && rows.every(function (x) { return !!sel[x.rec.key]; });
      all.onchange = function () { rows.forEach(function (x) { if (all.checked) sel[x.rec.key] = true; else delete sel[x.rec.key]; }); render(); };
      var th0 = h('th'); th0.appendChild(all); htr.appendChild(th0);
      COLS.forEach(function (c) { htr.appendChild(h('th', null, c)); });
      thead.appendChild(htr);

      tbody.innerHTML = '';
      rows.forEach(function (x) {
        var r = x.rec;
        var tr = h('tr', x.depth ? 'kid' : null); if (r.status === 'missing') tr.className = (tr.className ? tr.className + ' ' : '') + 'gone';
        var cb = h('input'); cb.type = 'checkbox'; cb.checked = !!sel[r.key];
        cb.onchange = function () { if (cb.checked) sel[r.key] = true; else delete sel[r.key]; foot.textContent = selText(); };
        var td0 = h('td'); td0.appendChild(cb); tr.appendChild(td0);
        tr.appendChild(h('td', null, r.path));
        var nameTd = h('td');
        nameTd.style.paddingLeft = (6 + x.depth * 22) + 'px';
        if (x.kidCount) {
          var tg = h('button', 'tg', x.expanded ? '▾' : '▸'); tg.title = '展開／收合擷取產物';
          tg.onclick = function () { expanded[r.key] = !x.expanded; render(); };
          nameTd.appendChild(tg); nameTd.appendChild(document.createTextNode(' '));
        }
        nameTd.appendChild(document.createTextNode(r.name + (r.status === 'missing' ? '（已消失）' : '') + (x.orphan ? '（來源已移除）' : '')));
        if (r.derivedFrom) nameTd.appendChild(h('div', 'fml-st', '擷取產物（不是檔案系統上的檔案）' + (r.derivedMethod ? '｜擷取方式：' + r.derivedMethod : '')));
        tr.appendChild(nameTd);
        tr.appendChild(h('td', null, r.album || ''));
        tr.appendChild(h('td', null, r.label || r.kind));
        tr.appendChild(h('td', null, M.formatDuration(r.durationSec) + (r.durationApprox ? '≈' : '')));
        var lc = h('td', (r.lyricStatus === 'failed' ? 'bad' : null), lyricCell(r)); lc.title = r.lyricStatus === 'failed' ? (r.lyricError || '') : '';
        tr.appendChild(lc);
        var ops = h('td');
        var pb = h('button', null, '▶ 播放');
        pb.disabled = !host.play || typeof FaMediaPlay === 'undefined';
        pb.onclick = function () { playRow(r, tr); };
        var rb = h('button', null, '移除'); rb.onclick = function () { removeOne(r); };
        ops.appendChild(pb); ops.appendChild(rb); tr.appendChild(ops);
        tbody.appendChild(tr);
        (V.hits[r.key] || []).forEach(function (hit) {
          var ht = h('tr', 'fml-hit'); var td = h('td'); td.colSpan = COLS.length + 1;
          td.textContent = '〔' + M.formatDuration(hit.start) + '–' + M.formatDuration(hit.end) + '〕' + hit.text;
          ht.appendChild(td); tbody.appendChild(ht);
        });
      });
      var total = lib.records.filter(function (r) { return r.status !== 'missing'; }).length;
      stat.textContent = (V.searching ? '找到 ' + V.count + ' 首' : '共 ' + total + ' 個檔案') + (msg ? '　' + msg : '');
      renderSources();
      renderLyr();
      foot.textContent = selText();
    }
    // 來源管理：每個來源（加入的檔案或資料夾）一列，可整個移除（addSource 的相反）
    function renderSources() {
      srcBox.textContent = '';
      srcBox.style.display = showSources ? '' : 'none';
      if (!showSources) return;
      if (!lib.sources.length) { srcBox.textContent = '還沒有來源（加過的檔案或資料夾會列在這裡）'; return; }
      srcBox.appendChild(h('div', null, '來源（移除來源會從曲庫移除它的紀錄與擷取產物；原始檔不會被刪除）：'));
      lib.sources.forEach(function (s) {
        var n = lib.records.filter(function (r) { return r.sourceId === s.id && !r.derivedFrom; }).length;
        var line = h('div', null, '・' + s.label + '（' + (s.type === 'folder' ? '資料夾' : '檔案') + '，' + n + ' 個原始檔）　');
        var b = h('button', null, '移除來源');
        b.onclick = function () { removeFlow(function (inc) { return lib.planSourceRemove(s.id, { includeDerived: inc, isDerivedPath: isDp() }); }, '來源：' + s.label); };
        line.appendChild(b);
        srcBox.appendChild(line);
      });
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
      var fn = kind === 'folder' ? host.pickFolder : host.pickFiles;
      if (fn) {
        var src = await fn();
        if (src === undefined && kind !== 'folder') { fIn.click(); return; } // 非桌面版：用瀏覽器選檔
        if (src) addFrom(kind === 'folder' ? 'folder' : 'file', src);
        return; // 取消（null）就什麼都不做
      }
      (kind === 'folder' ? dIn : fIn).click();
    }

    bFile.onclick = function () { pick('file'); };
    bFolder.onclick = function () { pick('folder'); };
    fIn.onchange = function () { var src = fromFileList(fIn.files, false); fIn.value = ''; addFrom('file', src); };
    dIn.onchange = function () { var src = fromFileList(dIn.files, true); dIn.value = ''; addFrom('folder', src); };
    search.oninput = function () { q = search.value; render(); };
    sSel.onchange = function () { scope = sSel.value; render(); };
    bDel.onclick = function () {
      var keys = Object.keys(sel).filter(function (k) { return lib.records.some(function (r) { return r.key === k; }); });
      if (!keys.length) { msg = '先勾選要移除的曲目'; render(); return; }
      removeFlow(function (inc) { return lib.planRemove(keys, { includeDerived: inc, isDerivedPath: isDp() }); }, '勾選的 ' + keys.length + ' 筆');
    };
    bSrc.onclick = function () { showSources = !showSources; render(); };

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

    // 批次輸出：勾選的曲目（沒勾選就全部可用的曲目）；單檔失敗不影響其他檔，結果逐筆列出
    var expRunning = false;
    var STAGE_ZH = { decode: '解碼', slice: '截取', 'encode-mp3': '編碼 mp3', 'parse-mid': '解析 MIDI', 'trim-mid': '截短', 'render-synth': '合成渲染', 'write-mid': '寫出 MIDI', write: '寫檔', verify: '讀回校驗', 'extract-audio': '抽音軌' };
    var STATUS_ZH = { done: '完成', failed: '失敗', unsupported: '不支援', cancelled: '取消' };
    bExp.onclick = function () {
      if (!host.exportBatch || expRunning) return;
      var minutes;
      if (eWhole.checked) minutes = 'whole';
      else { minutes = Number(eMin.value); if (!(minutes > 0)) { expStat.textContent = '分鐘數要大於 0，或勾「整首」'; return; } }
      var recs = lib.records.filter(function (r) { return r.status === 'ok' && !r.pending && (Object.keys(sel).length === 0 || sel[r.key]); });
      if (!recs.length) { expStat.textContent = '沒有可輸出的曲目（先加入檔案，或勾選要輸出的曲目）'; return; }
      expRunning = true; bExp.disabled = true; bExpCancel.disabled = false; expList.textContent = '';
      expStat.textContent = '選擇輸出資料夾…';
      var fmt = eFmt.value;
      host.exportBatch(recs, {
        format: fmt, minutes: minutes, useModel: eModel.checked,
        onEvent: function (ev) {
          if (ev.retry) expStat.textContent = '暫時性失敗，自動重試第 ' + ev.retry + ' 次…';
          else if (ev.stage) expStat.textContent = '輸出中（' + (STAGE_ZH[ev.stage] || ev.stage) + '）';
        }
      }).then(function (res) {
        expRunning = false; bExp.disabled = !host.exportBatch; bExpCancel.disabled = true;
        if (res.cancelled) { expStat.textContent = '已取消（沒有選資料夾）'; return; }
        var s = res.summary || {};
        expStat.textContent = '完成 ' + (s.done || 0) + '、失敗 ' + (s.failed || 0) + '、不支援 ' + (s.unsupported || 0) + '、取消 ' + (s.cancelled || 0) + '　→ ' + res.outDir;
        (res.results || []).forEach(function (x) {
          var line = h('div', x.status === 'done' ? null : 'bad', '[' + (STATUS_ZH[x.status] || x.status) + '] ' + x.name + (x.format ? '（' + x.format + '）' : ''));
          var detail = x.status === 'done' ? '→ ' + (x.output && x.output.path) + '　' + (x.verify && x.verify.detail || '') + (x.output && x.output.method ? '　［' + x.output.method + '］' : '') : (x.reason ? (x.stage ? '［' + (STAGE_ZH[x.stage] || x.stage) + '］' : '') + x.reason : '');
          if (x.elapsedMs) detail += '　（' + (x.elapsedMs / 1000).toFixed(1) + ' 秒，嘗試 ' + x.attempts + ' 次）';
          line.appendChild(document.createTextNode(' ' + detail));
          expList.appendChild(line);
        });
      }, function (e) {
        expRunning = false; bExp.disabled = !host.exportBatch; bExpCancel.disabled = true;
        expStat.textContent = '批次輸出出錯：' + String((e && e.message) || e);
      });
    };
    bExpCancel.onclick = function () { if (host.cancelExport) host.cancelExport(); expStat.textContent = '取消中（正在跑的那個檔案會在下一步停止）…'; };

    // 擷取來源（RIX、Flash、NES、PCE、SFC）：輸出 MIDI／mp3／wav 子曲目，登記回曲庫；衍生檔資料夾可指定（留空＝來源旁的「音樂庫衍生檔」）
    var xBtn = h('button', null, '擷取選取的來源'), xCancel = h('button', null, '取消擷取');
    var xRoot = h('input'); xRoot.type = 'text'; xRoot.placeholder = '衍生檔資料夾（留空＝來源旁的「音樂庫衍生檔」）'; xRoot.style.width = '260px';
    try { xRoot.value = localStorage.getItem('fa.musiclib.derivedDir') || ''; } catch (_) { /* 讀不到就空白 */ }
    xCancel.disabled = true;
    exp.appendChild(xRoot); exp.appendChild(xBtn); exp.appendChild(xCancel);
    if (!host.extract) { xBtn.disabled = true; xCancel.disabled = true; }
    var STATUS_X = { done: '完成', skipped: '沿用', failed: '失敗', cancelled: '取消' };
    xBtn.onclick = function () {
      if (!host.extract) return;
      var recs = lib.records.filter(function (r) { return (r.kind === 'rix' || r.kind === 'swf' || r.kind === 'nes' || r.kind === 'pce' || r.kind === 'sfc') && r.status === 'ok' && (Object.keys(sel).length === 0 || sel[r.key]); });
      if (!recs.length) { expStat.textContent = '沒有可擷取的來源（先加檔案，或勾選要擷取的來源）'; return; }
      var root = xRoot.value.trim();
      try { localStorage.setItem('fa.musiclib.derivedDir', root); } catch (_) { /* 存不了就只對這次有效 */ }
      xBtn.disabled = true; xCancel.disabled = false; expList.textContent = ''; expStat.textContent = '擷取中…';
      host.extract.run(recs, {
        userRoot: root || null,
        onEvent: function (ev) { expStat.textContent = '擷取中（' + ev.stage + '）'; }
      }).then(function (res) {
        xBtn.disabled = false; xCancel.disabled = true;
        var s = res.summary || {};
        expStat.textContent = '擷取完成：完成 ' + (s.done || 0) + '、沿用 ' + (s.skipped || 0) + '、失敗 ' + (s.failed || 0) + '、取消 ' + (s.cancelled || 0);
        (res.results || []).forEach(function (x) {
          var d;
          if (x.status === 'done') d = '→ 子曲目 ' + x.children + ' 個：' + x.method + (x.skippedParts && x.skippedParts.length ? '；略過：' + x.skippedParts.join('；') : '') + '　（' + x.dir + '）';
          else if (x.status === 'skipped') d = '來源沒變，沿用上次的子曲目';
          else d = (x.stage ? '［' + x.stage + '］' : '') + x.reason;
          var line = h('div', x.status === 'failed' ? 'bad' : null, '[' + (STATUS_X[x.status] || x.status) + '] ' + x.name + ' ' + d);
          expList.appendChild(line);
        });
        render();
      }, function (e) { xBtn.disabled = false; xCancel.disabled = true; expStat.textContent = '擷取出錯：' + String((e && e.message) || e); });
    };
    xCancel.onclick = function () { if (host.extract) host.extract.cancel(); expStat.textContent = '取消擷取中（目前這個來源的下一步停止）…'; };

    // 哼歌找歌：旋律索引（逐首，可暫停續跑、取消）＋錄哼歌或選音檔找相似（找不到時可用 MIDI 演奏查到的旋律）
    var MEL = host.melody || null, melHum = null, melFound = null;
    var melBox = h('div', 'fml-lyr');
    var mIdx = h('button', null, '建立旋律索引'), mPause = h('button', null, '暫停索引'), mIdxCancel = h('button', null, '取消索引');
    var mRec = h('button', null, '錄哼歌（8 秒）'), mPick = h('button', null, '選音檔找');
    var mText = h('input'); mText.type = 'text'; mText.placeholder = '歌詞文字（選填，用來加分）'; mText.style.width = '160px';
    var mUseText = h('input'); mUseText.type = 'checkbox'; mUseText.checked = true;
    var mUseLbl = h('label', null, '用文字加分'); mUseLbl.appendChild(mUseText);
    var mModel = h('input'); mModel.type = 'checkbox';
    var mModelLbl = h('label', null, '用 Basic Pitch（沒有模型會下載，走既有流程；不勾就用單音追蹤）'); mModelLbl.appendChild(mModel);
    var mFind = h('button', null, '找相似'), mStat = h('span', 'fml-st');
    var mFile = h('input'); mFile.type = 'file'; mFile.accept = 'audio/*,video/*'; mFile.style.display = 'none';
    var mRes = h('div', 'fml-foot'), mMidi = h('button', null, '找不到？用 MIDI 演奏這段旋律'); mMidi.style.display = 'none';
    melBox.appendChild(mIdx); melBox.appendChild(mPause); melBox.appendChild(mIdxCancel);
    melBox.appendChild(mModelLbl); melBox.appendChild(mRec); melBox.appendChild(mPick); melBox.appendChild(mText); melBox.appendChild(mUseLbl); melBox.appendChild(mFind);
    melBox.appendChild(mStat); melBox.appendChild(mFile);
    if (!MEL) { [mIdx, mPause, mIdxCancel, mRec, mPick, mFind].forEach(function (b) { b.disabled = true; }); mStat.textContent = '哼歌找歌不可用（需要桌面版）'; }
    mPause.disabled = true; mIdxCancel.disabled = true;
    root.appendChild(melBox); root.appendChild(mRes); root.appendChild(mMidi);
    function melStatus(s) { mStat.textContent = s; }
    function idxLine(ev) {
      if (ev.status === 'running') melStatus('旋律索引：建立中…');
      else if (ev.status === 'failed') melStatus('旋律索引：有一首失敗（' + ev.reason + '）');
    }
    mIdx.onclick = function () {
      if (!MEL || MEL.indexState().running) return;
      mIdx.disabled = true; mPause.disabled = false; mIdxCancel.disabled = false; melStatus('旋律索引：開始…');
      MEL.buildIndex(idxLine, mModel.checked).then(function (sum) {
        mIdx.disabled = false; mPause.disabled = true; mIdxCancel.disabled = true;
        var why = Object.keys(sum.excludedByReason || {}).map(function (k) { return k + ' ' + sum.excludedByReason[k] + ' 筆'; }).join('；');
        melStatus('旋律索引：完成 ' + sum.done + '、跳過 ' + sum.skipped + '、失敗 ' + sum.failed + '、取消 ' + sum.cancelled
          + (sum.excluded ? '、不建索引 ' + sum.excluded + ' 筆（' + why + '）' : '') + '（失敗的會寫明原因）');
      }, function (e) { mIdx.disabled = false; mPause.disabled = true; mIdxCancel.disabled = true; melStatus('旋律索引出錯：' + String((e && e.message) || e)); });
    };
    mPause.onclick = function () { if (!MEL) return; if (mPause.textContent === '暫停索引') { MEL.pauseIndex(); mPause.textContent = '續跑索引'; melStatus('旋律索引：已暫停（目前這首做完後停）'); } else { MEL.resumeIndex(); mPause.textContent = '暫停索引'; melStatus('旋律索引：續跑'); } };
    mIdxCancel.onclick = function () { if (MEL) MEL.cancelIndex(); melStatus('旋律索引：取消中…'); };
    var melBlob = null, melMethod = '';
    function showHum(r, blob) { melHum = r.notes; melBlob = blob || null; melMethod = r.method || ''; mStat.textContent = '哼歌已取得 ' + r.notes.length + ' 個音（' + melMethod + '）'; }
    mRec.onclick = function () {
      if (!MEL) return; mRec.disabled = true; melStatus('錄音中（8 秒）…');
      var blobNow = null;
      MEL.recordHum(8).then(function (blob) { blobNow = blob; melStatus('轉譜中…'); return MEL.notesFromHum(blob, mModel.checked); })
        .then(function (r) { showHum(r, blobNow); }, function (e) { melStatus('錄音或轉譜失敗：' + String((e && e.message) || e)); })
        .then(function () { mRec.disabled = false; });
    };
    mPick.onclick = function () { mFile.value = ''; mFile.click(); };
    mFile.onchange = function () {
      var f = mFile.files && mFile.files[0]; if (!f || !MEL) return; melStatus('解碼並轉譜 ' + f.name + '…');
      MEL.notesFromHum(f, mModel.checked).then(function (r) { showHum(r, f); }, function (e) { melStatus('轉譜失敗：' + String((e && e.message) || e)); });
    };
    mFind.onclick = function () {
      if (!MEL) return;
      if (!melHum) { melStatus('先錄哼歌或選音檔'); return; }
      mFind.disabled = true; mRes.textContent = ''; mMidi.style.display = 'none'; melFound = null;
      MEL.search(melHum, { textQuery: mText.value, useText: mUseText.checked, blob: melBlob }).then(function (r) {
        mFind.disabled = false;
        if (!r.ok) { melStatus(r.reason); return; }
        var textNote = mUseText.checked ? (r.textUsed ? '；文字加分用「' + r.textUsed.slice(0, 30) + '」' : '；沒有文字可加分') : '';
        if (!r.results.length) {
          var n = MEL.entries().length;
          melStatus(n ? '找不到相似的歌（' + n + ' 首已建索引' + textNote + '）' : '還沒有旋律索引，請先按「建立旋律索引」');
          mMidi.style.display = ''; melFound = melHum; return;
        }
        melStatus('找到 ' + r.results.length + ' 首（分數越高越像；命中時間是曲中的秒數' + textNote + '）');
        var paths = {}; MEL.entries().forEach(function (e) { paths[e.key] = e.path; });
        r.results.forEach(function (x) {
          var line = h('div', null, '[' + x.score.toFixed(2) + '] ' + x.name + '　音高 ' + x.pitchScore.toFixed(2) + '、節奏 ' + x.rhythmScore.toFixed(2) + (x.textBonus ? '、文字加分' : '') + '　命中 ' + x.startSec.toFixed(1) + '–' + x.endSec.toFixed(1) + ' 秒');
          var play = h('button', null, '試聽命中段');
          play.onclick = function () { MEL.playClip(paths[x.key], x.startSec, x.endSec).catch(function (e) { melStatus('試聽失敗：' + String((e && e.message) || e)); }); };
          line.appendChild(document.createTextNode(' ')); line.appendChild(play);
          mRes.appendChild(line);
        });
      }, function (e) { mFind.disabled = false; melStatus('找歌失敗：' + String((e && e.message) || e)); });
    };
    mMidi.onclick = function () { if (!MEL || !melFound) return; try { MEL.humAsMidi(melFound, '哼歌旋律'); melStatus('已開啟 MIDI 編輯器演奏哼歌旋律'); } catch (e) { melStatus('演奏失敗：' + String((e && e.message) || e)); } };

    // YouTube 清單的按鈕與進度（進行中只更新這一列與結果清單；完成時才重畫曲目清單，因為新登記的曲目在那裡）
    var ytRunning = false, YT_LIST_MAX = 200;
    function ytShowItems(job) {
      ytList.textContent = '';
      var shown = 0, rest = 0;
      job.items.forEach(function (it) {
        if (it.status === 'pending') return;
        if (shown >= YT_LIST_MAX) { rest++; return; }
        var line = (it.status === 'done' ? '✅ ' : it.status === 'skipped' ? '⏭ ' : it.status === 'failed' ? '❌ ' : '⏳ ')
          + (it.title || it.videoId) + (it.reason ? '：' + it.reason : '') + (it.status === 'working' && it.progressText ? '（' + it.progressText + '）' : '');
        var d = h('div', it.status === 'failed' ? 'bad' : null, line);
        d.style.color = it.status === 'failed' ? '#cf222e' : '';
        ytList.appendChild(d);
        shown++;
      });
      if (rest) ytList.appendChild(h('div', null, '…還有 ' + rest + ' 筆，完整結果看完成後的摘要'));
      ytList.style.display = shown || rest ? '' : 'none';
    }
    function ytControlsFor(job) {
      var live = job.state === 'running' || job.state === 'idle';
      bYtPause.disabled = !live; bYtCancel.disabled = !live;
      bYtPause.textContent = job.paused ? '續跑' : '暫停';
    }
    bYt.onclick = function () {
      if (!host.startYoutubeList || ytRunning) return;
      ytRunning = true; bYt.disabled = true; ytStat.textContent = '展開清單中…（第一次會載入 yt-dlp，可能要 1～2 分鐘）';
      ytList.style.display = 'none'; ytList.textContent = '';
      host.startYoutubeList(ytIn.value, function (job, sum) {
        ytStat.textContent = sum.text;
        ytControlsFor(job);
        ytShowItems(job);
      }).then(function (res) {
        ytRunning = false; bYt.disabled = false; bYtPause.disabled = true; bYtCancel.disabled = true;
        ytStat.textContent = res.ok ? res.summary.text : (res.cancelled ? res.error : '⚠️ ' + res.error);
        if (res.ok && res.job) ytShowItems(res.job);
        render();
      }, function (e) {
        ytRunning = false; bYt.disabled = false; bYtPause.disabled = true; bYtCancel.disabled = true;
        ytStat.textContent = '⚠️ ' + String((e && e.message) || e);
      });
    };
    bYtPause.onclick = function () {
      if (!host.youtubeJob || !host.youtubeControl) return;
      var j = host.youtubeJob(); if (!j) return;
      host.youtubeControl(j.job.paused ? 'resume' : 'pause');
    };
    bYtCancel.onclick = function () { if (host.youtubeControl) host.youtubeControl('cancel'); };

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
