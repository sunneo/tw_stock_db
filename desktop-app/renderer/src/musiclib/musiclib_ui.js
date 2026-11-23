/* 音樂庫的畫面（UMD）：像 library 的清單。
 *   主畫面只留常用的：＋加檔案、＋加資料夾、搜尋框、範圍、移除勾選、最大化、「⚙ 設定」、一行進行中工作狀態（點一下開對應分頁）。
 *   清單：樹狀。來源列下面可展開擷取產物（derivedFrom 指向來源），子列縮排並標「擷取產物（不是檔案系統上的檔案）」與擷取方式。
 *     搜尋命中子曲目時，它的來源會自動展開。每列都有「▶ 播放」（走通用播放模組 FaMediaPlay）與「移除」。
 *   移除：原始檔只從曲庫移除，絕不刪磁碟上的原始檔；擷取產物的衍生檔會刪（只刪衍生資料夾裡的，並確認真的消失）；
 *     移除來源時會問是否連同擷取產物一併移除（預設連同）；每次移除都先確認並說明會發生什麼。
 *   設定（「⚙ 設定」彈出的分頁視窗，置中、Esc 或 ✕ 關閉、可調整大小）：
 *     來源與擷取：來源管理（移除來源）、衍生資料夾、擷取選取的來源、擷取結果（失敗列出、成功收合）、取消擷取。
 *     歌詞：轉錄歌詞、暫停／續跑、取消轉錄、狀態。
 *     輸出：格式（mp3／mid）、分鐘數、整首、音訊轉 mid 用 Basic Pitch、批次輸出、取消輸出、結果。
 *     旋律搜尋：建立旋律索引、暫停／取消、錄哼歌／選音檔找相似、結果。
 *     YouTube：貼網址、加入清單、暫停／取消、進度。
 *   設定值（衍生資料夾、輸出格式與分鐘數、整首、Basic Pitch 勾選、旋律用文字加分）存在 localStorage（fa.musiclib.*），重開面板會還原。
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
    + '.fml-lyr input[type=text],.fml-bar input[type=text]{flex:1;min-width:180px;padding:4px 6px;border:1px solid #d0d7de;border-radius:5px;font:inherit}'
    + '.fml-bar input[type=search]{flex:1;min-width:160px;padding:4px 6px;border:1px solid #d0d7de;border-radius:5px;font:inherit}'
    + '.fml.max{position:fixed;inset:0;z-index:2147482000;border-radius:0;border:none;display:flex;flex-direction:column;overflow:auto}.fml.max .fml-wrap{max-height:none;flex:1;min-height:200px}'
    + '.fml-st{color:#59636e;font-size:12px}.fml-wrap{overflow:auto;max-height:520px;min-height:120px;resize:vertical}.fml-exp{max-height:40vh;overflow:auto;resize:vertical;min-height:40px}.fml-lyr .fml-st,.fml-bar .fml-st{flex:1}'
    + '.fml-tbl{width:100%;border-collapse:collapse}.fml-tbl th,.fml-tbl td{padding:4px 6px;border-bottom:1px solid #eaeef2;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:260px}'
    + '.fml-tbl th{background:#f6f8fa;position:sticky;top:0}.fml-tbl tr.gone td{color:#8c959f;text-decoration:line-through}'
    + '.fml-tbl td.bad{color:#cf222e}.fml-hit td{white-space:normal;color:#59636e;font-size:12px;padding-left:28px}'
    + '.fml-tbl tr.kid td{background:#fbfcfd}.fml-tbl button.tg{border:none;background:none;padding:0 4px;font-size:12px}'
    + '.fml-foot{padding:6px 8px;color:#59636e;font-size:12px;border-top:1px solid #d0d7de}'
    + '.fml-dlgbg{position:fixed;inset:0;background:rgba(31,35,40,.35);z-index:2147482500;display:flex;align-items:center;justify-content:center}'
    + '.fml-dlg{background:#fff;color:#1f2328;border:1px solid #d0d7de;border-radius:8px;width:min(900px,92vw);height:min(640px,85vh);min-width:420px;min-height:300px;resize:both;overflow:auto;display:flex;flex-direction:column}'
    + '.fml-dlg-h{display:flex;justify-content:space-between;align-items:center;padding:8px 10px;border-bottom:1px solid #d0d7de;font-weight:600}'
    + '.fml-dlg-tabs{display:flex;gap:4px;padding:6px 8px;border-bottom:1px solid #d0d7de;flex-wrap:wrap}'
    + '.fml-dlg-tabs button.on{background:#0969da;color:#fff;border-color:#0969da}'
    + '.fml-dlg-body{flex:1;overflow:auto;padding:6px 8px;min-height:0}'
    + '.fml-dup{color:#9a6700;font-size:11px;border:1px solid #d4a72c;border-radius:4px;padding:0 4px;margin-left:4px}'
    + '.fml-work{border:none;background:none;color:#0969da;text-align:left;max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}';
  var COLS = ['路徑', '檔名', '專輯', '種類', '長度', '歌詞', '操作'];
  var LYRIC_TEXT = { none: '未轉錄', queued: '排隊中', running: '轉錄中', done: '完成', failed: '失敗' };
  var SET_TABS = [['src', '來源與擷取'], ['lyr', '歌詞'], ['exp', '輸出'], ['mel', '旋律搜尋'], ['yt', 'YouTube'], ['db', '資料']];

  function h(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function errText(e) { return String((e && e.message) || e); }
  function bySort(a, b) { return (a.album || '').localeCompare(b.album || '') || a.name.localeCompare(b.name); }
  // localStorage 讀寫一律包 try：讀不到就用預設值，存不了就只對這次有效
  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v == null || v === '' ? d : v; } catch (_) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, String(v)); } catch (_) { /* 存不了就只對這次有效 */ } }
  function toggleCls(el, cls, on) {
    var c = String(el.className || '').split(' ').filter(function (x) { return x && x !== cls; });
    if (on) c.push(cls);
    el.className = c.join(' ');
  }

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
    var q = '', scope = 'all', msg = '', sel = {}, unsub = null, expanded = {}, playTr = null, maxOn = false;
    var xRunning = false, xProg = '', expRunning = false, expProg = '', melRunning = false, ytRunning = false;
    var root = h('div', 'fml');
    var style = h('style'); style.textContent = CSS; root.appendChild(style);

    // ───── 主畫面（常用）─────
    var bar = h('div', 'fml-bar');
    var bMax = h('button', null, '⛶ 最大化'); bMax.title = '把音樂庫放大到整個視窗（Esc 還原）';
    var bFile = h('button', null, '＋加檔案');
    var bFolder = h('button', null, '＋加資料夾');
    var search = h('input'); search.type = 'search'; search.placeholder = '搜尋：檔名、專輯、標題、演出者、歌詞（空白分隔多個關鍵字）';
    var sSel = h('select');
    [['all', '全部（含歌詞）'], ['meta', '不含歌詞'], ['lyrics', '只查歌詞']].forEach(function (o) { var op = h('option', null, o[1]); op.value = o[0]; sSel.appendChild(op); });
    var bDel = h('button', null, '移除勾選');
    var work = h('button', 'fml-work'); work.style.display = 'none';
    var stat = h('span', 'fml-st');
    var bSet = h('button', null, '⚙ 設定'); bSet.title = '開啟設定：來源與擷取、歌詞、輸出、旋律搜尋、YouTube';
    function setMax(on) { maxOn = !!on; toggleCls(root, 'max', maxOn); bMax.textContent = maxOn ? '🗗 還原' : '⛶ 最大化'; }
    bMax.onclick = function () { setMax(!maxOn); };
    bar.appendChild(bMax); bar.appendChild(bFile); bar.appendChild(bFolder); bar.appendChild(search); bar.appendChild(sSel);
    bar.appendChild(bDel); bar.appendChild(work); bar.appendChild(stat); bar.appendChild(bSet);

    // ───── 設定分頁視窗（置中對話框；內容一直在 DOM 裡，只切換顯示）─────
    var dlg = h('div', 'fml-dlgbg'), box = h('div', 'fml-dlg'), dHead = h('div', 'fml-dlg-h'), dTabs = h('div', 'fml-dlg-tabs'), dBody = h('div', 'fml-dlg-body');
    var dX = h('button', null, '✕'); dX.title = '關閉（Esc）';
    dHead.appendChild(h('span', null, '音樂庫設定')); dHead.appendChild(dX);
    var tabBtn = {}, tabPane = {}, curTab = 'src';
    SET_TABS.forEach(function (t) {
      var b = h('button', null, t[1]); b.onclick = function () { showTab(t[0]); }; tabBtn[t[0]] = b; dTabs.appendChild(b);
      var p = h('div'); p.style.display = 'none'; tabPane[t[0]] = p; dBody.appendChild(p);
    });
    box.appendChild(dHead); box.appendChild(dTabs); box.appendChild(dBody); dlg.appendChild(box); dlg.style.display = 'none';
    function dlgOpen() { return dlg.style.display !== 'none'; }
    function showTab(k) { curTab = k; SET_TABS.forEach(function (t) { tabPane[t[0]].style.display = t[0] === k ? '' : 'none'; toggleCls(tabBtn[t[0]], 'on', t[0] === k); }); }
    function openSettings(tab) { showTab(tab || curTab); dlg.style.display = ''; }
    function closeSettings() { dlg.style.display = 'none'; }
    bSet.onclick = function () { openSettings(curTab); };
    dX.onclick = closeSettings;
    dlg.onclick = function (ev) { if (ev && ev.target === dlg) closeSettings(); };

    // Esc：先關設定視窗，其次還原最大化
    var onKey = function (ev) {
      if (!ev || ev.key !== 'Escape') return;
      if (dlgOpen()) closeSettings(); else if (maxOn) setMax(false);
    };
    if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('keydown', onKey);

    // ───── 來源與擷取分頁 ─────
    var srcBox = h('div', 'fml-foot');
    var xRow = h('div', 'fml-bar');
    var xRoot = h('input'); xRoot.type = 'text'; xRoot.placeholder = '衍生檔資料夾（留空＝來源旁的「音樂庫衍生檔」）'; xRoot.style.width = '260px';
    xRoot.value = lsGet('fa.musiclib.derivedDir', '');
    xRoot.oninput = function () { lsSet('fa.musiclib.derivedDir', xRoot.value.trim()); };
    var xBtn = h('button', null, '擷取選取的來源'), xCancel = h('button', null, '取消擷取');
    var xStat = h('span', 'fml-st');
    xCancel.disabled = true;
    xRow.appendChild(xRoot); xRow.appendChild(xBtn); xRow.appendChild(xCancel); xRow.appendChild(xStat);
    var xList = h('div', 'fml-foot fml-exp');
    if (!host.extract) { xBtn.disabled = true; xCancel.disabled = true; xStat.textContent = '擷取不可用（需要桌面版）'; }
    // md5 指紋與重新對應：重整資料夾後用「重新對應」，選新的資料夾；重複檔列在下面（不自動刪除）
    var mdRow = h('div', 'fml-bar');
    var bRelocate = h('button', null, '重新對應（選新資料夾）');
    bRelocate.title = '重整資料夾後用這個：先檢查哪些檔案消失了，再選新的資料夾；用 md5 把消失的紀錄對到新位置（保留索引、歌詞、衍生關係）';
    var bMd5Cancel = h('button', null, '取消 md5'); bMd5Cancel.disabled = true;
    var mdStat = h('span', 'fml-st');
    mdRow.appendChild(bRelocate); mdRow.appendChild(bMd5Cancel); mdRow.appendChild(mdStat);
    if (!host.md5) { bRelocate.disabled = true; mdStat.textContent = 'md5 對應不可用（需要桌面版）'; }
    var dupBox = h('div', 'fml-foot');
    tabPane.src.appendChild(srcBox); tabPane.src.appendChild(mdRow); tabPane.src.appendChild(dupBox); tabPane.src.appendChild(xRow); tabPane.src.appendChild(xList);

    // ───── 歌詞分頁 ─────
    var lyr = h('div', 'fml-lyr');
    var bLyr = h('button', null, '轉錄歌詞');
    var bPause = h('button', null, '暫停');
    var bCancel = h('button', null, '取消轉錄');
    var lyrStat = h('span', 'fml-st');
    lyr.appendChild(bLyr); lyr.appendChild(bPause); lyr.appendChild(bCancel); lyr.appendChild(lyrStat);
    if (!queue) { bLyr.disabled = true; bPause.disabled = true; bCancel.disabled = true; lyrStat.textContent = '歌詞轉錄不可用（需要桌面版）'; }
    tabPane.lyr.appendChild(lyr);

    // ───── 輸出分頁：格式（mp3／mid）、分鐘數或整首、Basic Pitch、批次輸出、取消、結果 ─────
    var exp = h('div', 'fml-bar');
    var eFmt = h('select'); [['mp3', 'mp3'], ['mid', 'mid']].forEach(function (o) { var op = h('option', null, o[1]); op.value = o[0]; eFmt.appendChild(op); });
    eFmt.value = lsGet('fa.musiclib.exportFormat', 'mp3');
    var eMin = h('input'); eMin.type = 'number'; eMin.min = '0.1'; eMin.step = '0.5'; eMin.value = lsGet('fa.musiclib.exportMinutes', '1'); eMin.style.width = '70px';
    var eWhole = h('input'); eWhole.type = 'checkbox'; eWhole.checked = lsGet('fa.musiclib.exportWhole', '0') === '1';
    var eWholeLbl = h('label', null, '整首'); eWholeLbl.appendChild(eWhole);
    var eModel = h('input'); eModel.type = 'checkbox'; eModel.checked = lsGet('fa.musiclib.exportBasicPitch', '0') === '1';
    var eModelLbl = h('label', null, '音訊轉 mid 用 Basic Pitch'); eModelLbl.appendChild(eModel);
    eFmt.onchange = function () { lsSet('fa.musiclib.exportFormat', eFmt.value); };
    eMin.oninput = function () { lsSet('fa.musiclib.exportMinutes', eMin.value); };
    eWhole.onchange = function () { lsSet('fa.musiclib.exportWhole', eWhole.checked ? '1' : '0'); };
    eModel.onchange = function () { lsSet('fa.musiclib.exportBasicPitch', eModel.checked ? '1' : '0'); };
    var bExp = h('button', null, '批次輸出');
    var bExpCancel = h('button', null, '取消輸出');
    var expStat = h('span', 'fml-st');
    exp.appendChild(eFmt); exp.appendChild(h('span', 'fml-st', '分鐘')); exp.appendChild(eMin); exp.appendChild(eWholeLbl); exp.appendChild(eModelLbl);
    exp.appendChild(bExp); exp.appendChild(bExpCancel); exp.appendChild(expStat);
    var expList = h('div', 'fml-foot fml-exp');
    if (!host.exportBatch) { bExp.disabled = true; bExpCancel.disabled = true; expStat.textContent = '批次輸出不可用（需要桌面版）'; }
    bExpCancel.disabled = true;
    tabPane.exp.appendChild(exp); tabPane.exp.appendChild(expList);

    // ───── YouTube 分頁：貼清單網址 → 展開 → 逐支驗證、下載、登記；暫停／續跑／取消；逐支結果 ─────
    var yt = h('div', 'fml-bar');
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
    tabPane.yt.appendChild(yt); tabPane.yt.appendChild(ytList);

    // ───── 旋律搜尋分頁：建立索引（可暫停、取消）、錄哼歌／選音檔找相似、結果 ─────
    var MEL = host.melody || null, melHum = null, melFound = null;
    var melBox = h('div', 'fml-bar');
    var mIdx = h('button', null, '建立旋律索引'), mPause = h('button', null, '暫停索引'), mIdxCancel = h('button', null, '取消索引');
    var mRec = h('button', null, '錄哼歌（8 秒）'), mPick = h('button', null, '選音檔找');
    var mText = h('input'); mText.type = 'text'; mText.placeholder = '歌詞文字（選填，用來加分）'; mText.style.width = '160px';
    var mUseText = h('input'); mUseText.type = 'checkbox'; mUseText.checked = lsGet('fa.musiclib.melodyUseText', '0') === '1';
    var mUseLbl = h('label', null, '用文字加分'); mUseLbl.appendChild(mUseText);
    var mModel = h('input'); mModel.type = 'checkbox'; mModel.checked = lsGet('fa.musiclib.melodyBasicPitch', '0') === '1';
    var mModelLbl = h('label', null, '用 Basic Pitch（沒有模型會下載，走既有流程；不勾就用單音追蹤）'); mModelLbl.appendChild(mModel);
    mModel.onchange = function () { lsSet('fa.musiclib.melodyBasicPitch', mModel.checked ? '1' : '0'); };
    mUseText.onchange = function () { lsSet('fa.musiclib.melodyUseText', mUseText.checked ? '1' : '0'); };
    var mFind = h('button', null, '找相似'), mStat = h('span', 'fml-st');
    var mFile = h('input'); mFile.type = 'file'; mFile.accept = 'audio/*,video/*'; mFile.style.display = 'none';
    var mRes = h('div', 'fml-foot'), mMidi = h('button', null, '找不到？用 MIDI 演奏這段旋律'); mMidi.style.display = 'none';
    melBox.appendChild(mIdx); melBox.appendChild(mPause); melBox.appendChild(mIdxCancel);
    melBox.appendChild(mModelLbl); melBox.appendChild(mRec); melBox.appendChild(mPick); melBox.appendChild(mText); melBox.appendChild(mUseLbl); melBox.appendChild(mFind);
    melBox.appendChild(mStat); melBox.appendChild(mFile);
    if (!MEL) { [mIdx, mPause, mIdxCancel, mRec, mPick, mFind].forEach(function (b) { b.disabled = true; }); mStat.textContent = '哼歌找歌不可用（需要桌面版）'; }
    mPause.disabled = true; mIdxCancel.disabled = true;
    tabPane.mel.appendChild(melBox); tabPane.mel.appendChild(mRes); tabPane.mel.appendChild(mMidi);

    var wrap = h('div', 'fml-wrap');
    var tbl = h('table', 'fml-tbl');
    var thead = h('thead'), tbody = h('tbody');
    tbl.appendChild(thead); tbl.appendChild(tbody); wrap.appendChild(tbl);
    var foot = h('div', 'fml-foot');

    var fIn = h('input'); fIn.type = 'file'; fIn.multiple = true; fIn.style.display = 'none';
    var dIn = h('input'); dIn.type = 'file'; dIn.setAttribute('webkitdirectory', ''); dIn.style.display = 'none';
    root.appendChild(bar); root.appendChild(wrap); root.appendChild(foot); root.appendChild(fIn); root.appendChild(dIn); root.appendChild(dlg);
    container.appendChild(root);

    // 要顯示的紀錄：搜尋時＝命中的（子曲目命中就把來源也放進來）；平常＝全部
    function visibleSet() {
      if (!q.trim()) return { recs: lib.records.slice().sort(bySort), hits: {}, searching: false, count: 0 };
      var hits = lib.search(q, { scope: scope }), hitMap = {}, keep = {}, byKey = {};
      lib.records.forEach(function (r) { byKey[r.key] = r; });
      hits.forEach(function (x) { keep[x.record.key] = true; hitMap[x.record.key] = x.lyricHits || []; });
      // 命中的子曲目（例如 MIDI）：它的來源，和同一來源擷取出的兄弟（mp3／wav）一起顯示、可播放；命中來源時它的子曲目也一起顯示
      var kids = {};
      lib.records.forEach(function (r) { if (r.derivedFrom) (kids[r.derivedFrom] = kids[r.derivedFrom] || []).push(r); });
      var parents = {};
      Object.keys(keep).forEach(function (k) { var r = byKey[k]; if (r) parents[r.derivedFrom || k] = true; });
      Object.keys(parents).forEach(function (pk) {
        if (byKey[pk]) { keep[pk] = true; if (!hitMap[pk]) hitMap[pk] = []; }
        (kids[pk] || []).forEach(function (c) { keep[c.key] = true; if (!hitMap[c.key]) hitMap[c.key] = []; });
      });
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
      var dupK = M.duplicateKeys(lib.records);
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
        if (dupK[r.key]) nameTd.appendChild(h('span', 'fml-dup', ' 重複'));
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
      renderSources(); renderDups();
      renderLyr();
      renderWork();
      foot.textContent = selText();
    }
    // 來源管理（設定的「來源與擷取」分頁）：每個來源（加入的檔案或資料夾）一列，可整個移除（addSource 的相反）
    function renderSources() {
      srcBox.textContent = '';
      if (!lib.sources.length) { srcBox.textContent = '還沒有來源（加過的檔案或資料夾會列在這裡）'; return; }
      srcBox.appendChild(h('div', null, '來源管理（移除來源會從曲庫移除它的紀錄與擷取產物；原始檔不會被刪除）：'));
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
    // 進行中的工作：主畫面一行，點一下開對應的設定分頁
    function workItems() {
      var items = [];
      if (xRunning) items.push({ text: '擷取中 ' + xProg, tab: 'src' });
      if (queue) { var s = queue.state(); if (s.running) items.push({ text: '轉錄中' + (s.progress != null ? ' ' + Math.round(s.progress * 100) + '%' : ''), tab: 'lyr' }); }
      if (expRunning) items.push({ text: '輸出中 ' + expProg, tab: 'exp' });
      if (melRunning) items.push({ text: '旋律索引建立中', tab: 'mel' });
      if (ytRunning) items.push({ text: 'YouTube 清單處理中', tab: 'yt' });
      if (host.md5 && host.md5.state) {
        var ms = host.md5.state();
        if (ms.running) items.push({ text: ms.big ? '正在算 ' + ms.current + ' 的 md5（大檔，需要一點時間，已 ' + Math.round((Date.now() - ms.startedAt) / 1000) + ' 秒）' : '對應中（算 md5）' + ms.done + '／' + ms.total, tab: 'src' });
        else if (ms.pending) items.push({ text: 'md5 尚未算完 ' + ms.pending + ' 個（算完前先不要重整資料夾）', tab: 'src' });
      }
      return items;
    }
    function renderWork() {
      var items = workItems();
      if (!items.length) { work.style.display = 'none'; work.textContent = ''; return; }
      work.style.display = '';
      work.textContent = items.map(function (x) { return x.text; }).join('｜');
      work.title = '點一下開啟對應的設定分頁';
      work.onclick = function () { openSettings(items[0].tab); };
    }
    function selText() { var n = Object.keys(sel).length; return '已選 ' + n + ' 首' + (n ? '（轉錄歌詞會只跑勾選的未完成曲目）' : '（沒勾選時，轉錄歌詞會跑全部未完成曲目）'); }

    // md5 背景計算：一次一個；算完才對應（搬家）。計算中又加了資料夾：新紀錄先累積，算完再跑一次
    var mdPending = null;
    function startMd5(newKeys) {
      if (!host.md5 || !host.md5.run) return;
      if (host.md5.state().running) { mdPending = Object.assign(mdPending || {}, newKeys || {}); return; }
      bMd5Cancel.disabled = false;
      host.md5.run({ newKeys: Object.assign({}, newKeys || {}), onEvent: function () { renderWork(); } }).then(function (s) {
        var again = mdPending; mdPending = null; bMd5Cancel.disabled = true;
        if (s.text) msg = s.text;
        var st = host.md5.state();
        mdStat.textContent = st.fallback ? '注意：這個 app 還不認得 hashFile，大檔是近似特徵（開頭 4 MB＋大小）；app 更新重啟後會自動重算成整檔。' : '';
        render();
        if (again && Object.keys(again).length) startMd5(again);
      }, function (e) { mdPending = null; bMd5Cancel.disabled = true; msg = 'md5 計算出錯：' + errText(e); render(); });
    }
    bMd5Cancel.onclick = function () { if (host.md5) host.md5.cancel(); mdStat.textContent = '取消中（目前這個檔案算完就停）…'; };
    function renderDups() {
      dupBox.textContent = '';
      var groups = M.duplicateGroups(lib.records);
      if (!groups.length) { dupBox.textContent = '重複檔：目前沒有（只比對已算好 md5、內容完全相同的檔案）'; return; }
      dupBox.appendChild(h('div', null, '重複檔（內容完全相同、路徑不同）：' + groups.length + ' 組。不會自動刪除任何檔案，請自己決定要留哪一份。'));
      groups.slice(0, 30).forEach(function (g) {
        dupBox.appendChild(h('div', null, '・' + g.recs.length + ' 份：' + g.recs.map(function (r) { return r.path; }).join('　｜　')));
      });
      if (groups.length > 30) dupBox.appendChild(h('div', null, '…還有 ' + (groups.length - 30) + ' 組'));
    }
    bRelocate.onclick = async function () {
      if (!host.md5) return;
      msg = '檢查檔案現況…'; render();
      try { var rs = await host.md5.refreshStatus(); msg = '現況：' + rs.missing + ' 個紀錄的檔案消失了，' + rs.back + ' 個回來了。請選新的資料夾。'; }
      catch (e) { msg = '檢查失敗：' + errText(e); render(); return; }
      render();
      await pick('folder');
    };

    async function addFrom(type, src) {
      if (!src || !src.entries || !src.entries.length) { msg = '沒有可加入的檔案'; render(); return; }
      var before = {}; lib.records.forEach(function (r) { before[r.key] = true; });
      var sid = lib.addSource(type, src.label);
      msg = '掃描中…'; render();
      try {
        var rep = await lib.scan(sid, src.entries, src.readHead);
        await lib.save();
        msg = '新增 ' + rep.added + '、變更 ' + rep.changed + '、未變 ' + rep.unchanged + '、消失 ' + rep.missing + '、略過 ' + rep.skipped;
        var newKeys = {}; lib.records.forEach(function (r) { if (!before[r.key]) newKeys[r.key] = true; });
        startMd5(newKeys);   // 掃描本身不算 md5；這裡交給背景計算，算完才對應
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
    var STAGE_ZH = { decode: '解碼', slice: '截取', 'encode-mp3': '編碼 mp3', 'parse-mid': '解析 MIDI', 'trim-mid': '截短', 'render-synth': '合成渲染', 'write-mid': '寫出 MIDI', write: '寫檔', verify: '讀回校驗', 'extract-audio': '抽音軌' };
    var STATUS_ZH = { done: '完成', failed: '失敗', unsupported: '不支援', cancelled: '取消' };
    bExp.onclick = function () {
      if (!host.exportBatch || expRunning) return;
      var minutes;
      if (eWhole.checked) minutes = 'whole';
      else { minutes = Number(eMin.value); if (!(minutes > 0)) { expStat.textContent = '分鐘數要大於 0，或勾「整首」'; return; } }
      var recs = lib.records.filter(function (r) { return r.status === 'ok' && !r.pending && (Object.keys(sel).length === 0 || sel[r.key]); });
      if (!recs.length) { expStat.textContent = '沒有可輸出的曲目（先加入檔案，或勾選要輸出的曲目）'; return; }
      expRunning = true; expProg = ''; bExp.disabled = true; bExpCancel.disabled = false; expList.textContent = '';
      expStat.textContent = '選擇輸出資料夾…'; renderWork();
      var fmt = eFmt.value;
      host.exportBatch(recs, {
        format: fmt, minutes: minutes, useModel: eModel.checked,
        onEvent: function (ev) {
          if (ev.retry) expProg = '暫時性失敗，自動重試第 ' + ev.retry + ' 次';
          else if (ev.stage) expProg = STAGE_ZH[ev.stage] || ev.stage;
          else return;
          expStat.textContent = expProg + '…'; renderWork();
        }
      }).then(function (res) {
        expRunning = false; expProg = ''; bExp.disabled = !host.exportBatch; bExpCancel.disabled = true; renderWork();
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
        expRunning = false; expProg = ''; bExp.disabled = !host.exportBatch; bExpCancel.disabled = true; renderWork();
        expStat.textContent = '批次輸出出錯：' + String((e && e.message) || e);
      });
    };
    bExpCancel.onclick = function () { if (host.cancelExport) host.cancelExport(); expStat.textContent = '取消中（正在跑的那個檔案會在下一步停止）…'; };

    // 擷取來源（RIX、Flash、NES、PCE、SFC）：輸出 MIDI／mp3／wav 子曲目，登記回曲庫；衍生檔資料夾可指定（留空＝來源旁的「音樂庫衍生檔」）
    var STATUS_X = { done: '完成', skipped: '沿用', failed: '失敗', cancelled: '取消' };
    xBtn.onclick = function () {
      if (!host.extract) return;
      var recs = lib.records.filter(function (r) { return (r.kind === 'rix' || r.kind === 'swf' || r.kind === 'nes' || r.kind === 'pce' || r.kind === 'sfc') && r.status === 'ok' && (Object.keys(sel).length === 0 || sel[r.key]); });
      if (!recs.length) { xStat.textContent = '沒有可擷取的來源（先加檔案，或勾選要擷取的來源）'; return; }
      var rootDir = xRoot.value.trim();
      lsSet('fa.musiclib.derivedDir', rootDir);
      xRunning = true; xProg = ''; xBtn.disabled = true; xCancel.disabled = false; xList.textContent = ''; xStat.textContent = '擷取中…'; renderWork();
      // 結果顯示：失敗與取消的逐筆列出（紅字、要處理的）；成功與沿用的收進可展開的清單，不洗版。每做完一個就即時更新。
      var cnt = { done: 0, skipped: 0, failed: 0, cancelled: 0 }, total = recs.length, live = 0;
      var badBox = h('div'), okBtn = h('button', null, ''), okBox = h('div');
      okBtn.style.display = 'none'; okBtn.style.margin = '4px 0';
      okBox.style.cssText = 'display:none;height:200px;min-height:60px;max-height:80vh;resize:vertical;overflow:auto;border:1px solid #d0d7de;padding:4px;color:#59636e'; // 右下角可拖曳調整高度
      okBtn.onclick = function () { var open = okBox.style.display === 'none'; okBox.style.display = open ? '' : 'none'; okBtn.textContent = (open ? '收起' : '展開') + '成功／沿用清單（' + (cnt.done + cnt.skipped) + ' 個）'; };
      xList.appendChild(badBox); xList.appendChild(okBtn); xList.appendChild(okBox);
      function countText() { return '完成 ' + cnt.done + '、沿用 ' + cnt.skipped + '、失敗 ' + cnt.failed + (cnt.cancelled ? '、取消 ' + cnt.cancelled : ''); }
      function addResult(x) {
        cnt[x.status] = (cnt[x.status] || 0) + 1;
        var d;
        if (x.status === 'done') d = '→ 子曲目 ' + x.children + ' 個：' + x.method + (x.skippedParts && x.skippedParts.length ? '；略過：' + x.skippedParts.join('；') : '') + '　（' + x.dir + '）';
        else if (x.status === 'skipped') d = '來源沒變，沿用上次的子曲目';
        else d = (x.stage ? '［' + x.stage + '］' : '') + x.reason;
        var line = h('div', x.status === 'failed' ? 'bad' : null, '[' + (STATUS_X[x.status] || x.status) + '] ' + x.name + ' ' + d);
        if (x.status === 'done' || x.status === 'skipped') {
          okBox.appendChild(line);
          okBtn.style.display = '';
          okBtn.textContent = (okBox.style.display === 'none' ? '展開' : '收起') + '成功／沿用清單（' + (cnt.done + cnt.skipped) + ' 個）';
        } else badBox.appendChild(line);
      }
      host.extract.run(recs, {
        userRoot: rootDir || null,
        onEvent: function (ev) {
          if (ev.type === 'result') { live++; addResult(ev.result); xProg = (ev.index + 1) + '／' + ev.total; xStat.textContent = '擷取中 ' + xProg + '：' + countText(); }
          else { xProg = ((ev.index != null ? ev.index + 1 : live + 1)) + '／' + total; xStat.textContent = '擷取中 ' + xProg + (ev.name ? '：' + ev.name : '') + '（' + ev.stage + '）｜' + countText(); }
          renderWork();
        }
      }).then(function (res) {
        xRunning = false; xProg = ''; xBtn.disabled = false; xCancel.disabled = true;
        // 舊版宿主不會即時通知：沒有收到任何即時結果時，結束後一次補上
        if (!live) (res.results || []).forEach(addResult);
        xStat.textContent = '擷取完成：' + countText() + (cnt.failed ? '（失敗的列在下面）' : '');
        render();
      }, function (e) { xRunning = false; xProg = ''; xBtn.disabled = false; xCancel.disabled = true; xStat.textContent = '擷取出錯：' + String((e && e.message) || e); renderWork(); });
    };
    xCancel.onclick = function () { if (host.extract) host.extract.cancel(); xStat.textContent = '取消擷取中（目前這個來源的下一步停止）…'; };

    // 哼歌找歌：旋律索引（逐首，可暫停續跑、取消）＋錄哼歌或選音檔找相似（找不到時可用 MIDI 演奏查到的旋律）
    function melStatus(s) { mStat.textContent = s; }
    function idxLine(ev) {
      if (ev.status === 'running') melStatus('旋律索引：建立中…');
      else if (ev.status === 'failed') melStatus('旋律索引：有一首失敗（' + ev.reason + '）');
    }
    mIdx.onclick = function () {
      if (!MEL || MEL.indexState().running) return;
      mIdx.disabled = true; mPause.disabled = false; mIdxCancel.disabled = false; melStatus('旋律索引：開始…'); melRunning = true; renderWork();
      MEL.buildIndex(idxLine, mModel.checked).then(function (sum) {
        mIdx.disabled = false; mPause.disabled = true; mIdxCancel.disabled = true; melRunning = false; renderWork();
        melStatus(M.describeMelodySummary(sum, sum.groups || {}));
      }, function (e) { mIdx.disabled = false; mPause.disabled = true; mIdxCancel.disabled = true; melRunning = false; renderWork(); melStatus('旋律索引出錯：' + String((e && e.message) || e)); });
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
      // 結果顯示（先出旋律比對的結果；有文字加分時，文字轉錄完成後再更新一次）
      function showFound(r) {
        mRes.textContent = ''; mMidi.style.display = 'none';
        if (!r.ok) { melStatus(r.reason); return; }
        var timing = '，旋律比對 ' + (r.entryCount != null ? r.entryCount : MEL.entries().length) + ' 首用了 ' + (r.matchMs || 0) + ' 毫秒' + (r.transcribeMs != null ? '，文字轉錄 ' + (r.transcribeMs / 1000).toFixed(1) + ' 秒' : '');
        var textNote = r.partial ? '；文字轉錄中（語音模型第一次要載入，可能要幾分鐘，目前是只看旋律的結果）'
          : (mUseText.checked ? (r.textUsed ? '；文字加分用「' + r.textUsed.slice(0, 30) + '」' : (r.textError ? '；文字轉錄失敗：' + r.textError : '；沒有文字可加分')) : '');
        if (!r.results.length) {
          var n = MEL.entries().length;
          melStatus((n ? '找不到相似的歌（' + n + ' 首已建索引' + textNote + timing + '）' : '還沒有旋律索引，請先按「建立旋律索引」'));
          mMidi.style.display = ''; melFound = melHum; return;
        }
        melStatus('找到 ' + r.results.length + ' 首（分數越高越像；命中時間是曲中的秒數' + textNote + timing + '）');
        var paths = {}; MEL.entries().forEach(function (e) { paths[e.key] = e.path; });
        r.results.forEach(function (x) {
          var line = h('div', null, '[' + x.score.toFixed(2) + '] ' + x.name + '　音高 ' + x.pitchScore.toFixed(2) + '、節奏 ' + x.rhythmScore.toFixed(2) + (x.textBonus ? '、文字加分' : '') + '　命中 ' + x.startSec.toFixed(1) + '–' + x.endSec.toFixed(1) + ' 秒');
          var play = h('button', null, '試聽命中段');
          play.onclick = function () { MEL.playClip(paths[x.key], x.startSec, x.endSec).catch(function (e) { melStatus('試聽失敗：' + String((e && e.message) || e)); }); };
          line.appendChild(document.createTextNode(' ')); line.appendChild(play);
          mRes.appendChild(line);
        });
      }
      melStatus('比對中…');
      MEL.search(melHum, { textQuery: mText.value, useText: mUseText.checked, blob: melBlob, onPartial: showFound }).then(function (r) {
        mFind.disabled = false; showFound(r);
      }, function (e) { mFind.disabled = false; melStatus('找歌失敗：' + String((e && e.message) || e)); });
    };
    mMidi.onclick = function () { if (!MEL || !melFound) return; try { MEL.humAsMidi(melFound, '哼歌旋律'); melStatus('已開啟 MIDI 編輯器演奏哼歌旋律'); } catch (e) { melStatus('演奏失敗：' + String((e && e.message) || e)); } };

    // YouTube 清單的按鈕與進度（進行中只更新這一列與結果清單；完成時才重畫曲目清單，因為新登記的曲目在那裡）
    var YT_LIST_MAX = 200;
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
      ytRunning = true; bYt.disabled = true; ytStat.textContent = '展開清單中…（第一次會載入 yt-dlp，可能要 1～2 分鐘）'; renderWork();
      ytList.style.display = 'none'; ytList.textContent = '';
      host.startYoutubeList(ytIn.value, function (job, sum) {
        ytStat.textContent = sum.text;
        ytControlsFor(job);
        ytShowItems(job);
      }).then(function (res) {
        ytRunning = false; bYt.disabled = false; bYtPause.disabled = true; bYtCancel.disabled = true; renderWork();
        ytStat.textContent = res.ok ? res.summary.text : (res.cancelled ? res.error : '⚠️ ' + res.error);
        if (res.ok && res.job) ytShowItems(res.job);
        render();
      }, function (e) {
        ytRunning = false; bYt.disabled = false; bYtPause.disabled = true; bYtCancel.disabled = true; renderWork();
        ytStat.textContent = '⚠️ ' + String((e && e.message) || e);
      });
    };
    bYtPause.onclick = function () {
      if (!host.youtubeJob || !host.youtubeControl) return;
      var j = host.youtubeJob(); if (!j) return;
      host.youtubeControl(j.job.paused ? 'resume' : 'pause');
    };
    bYtCancel.onclick = function () { if (host.youtubeControl) host.youtubeControl('cancel'); };

    // ───── 資料分頁：匯出／匯入資料庫。純邏輯在 core（exportDb、planImport、applyImport）；檔案讀寫在 host。
    // 匯入取代或合併前一律先在面板內列出結果，按「確定」才寫入（不用 window.confirm）。
    var dbBox = h('div', 'fml-bar');
    var bDbExp = h('button', null, '匯出資料庫');
    var dbMode = h('select');
    [['merge', '合併（保留現有，補上新的）'], ['replace', '取代全部（現有資料會被換掉）']].forEach(function (o) { var op = h('option', null, o[1]); op.value = o[0]; dbMode.appendChild(op); });
    var bDbImp = h('button', null, '匯入資料庫…');
    var dbOk = h('button', null, '確定匯入'), dbNo = h('button', null, '取消');
    dbOk.style.display = 'none'; dbNo.style.display = 'none';
    var dbStat = h('span', 'fml-st');
    var dbIn = h('input'); dbIn.type = 'file'; dbIn.accept = '.json,application/json'; dbIn.style.display = 'none';
    dbBox.appendChild(bDbExp); dbBox.appendChild(dbMode); dbBox.appendChild(bDbImp); dbBox.appendChild(dbOk); dbBox.appendChild(dbNo); dbBox.appendChild(dbStat); dbBox.appendChild(dbIn);
    var dbNote = h('div', 'fml-foot', '匯出會把來源、紀錄、旋律索引、歌詞轉錄結果與衍生關係存成一個資料檔（檔名含日期，帶版本號）。匯入時以路徑比對：路徑與檔案大小、修改時間都相同才沿用索引與歌詞；檔案變了就標為索引過期；路徑找不到就標為消失，資料保留。讀不懂的檔案或較新版本的檔案會明確報錯，現有資料不會被改動。');
    tabPane.db.appendChild(dbBox); tabPane.db.appendChild(dbNote);
    function todayStr() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
    function downloadText(text, name) {
      var url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      var a = document.createElement('a'); a.href = url; a.download = name; a.click();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }
    bDbExp.onclick = async function () {
      var text = JSON.stringify(M.exportDb(lib), null, 1);
      var name = 'fa-musiclib-db_' + todayStr() + '.json';
      dbStat.textContent = '匯出中…';
      try {
        if (host.library && host.library.exportToFolder) {
          var r = await host.library.exportToFolder(text, name);
          dbStat.textContent = r ? '已匯出到 ' + r.path + '（' + lib.records.length + ' 筆紀錄，資料版本 ' + M.VERSION + '）' : '已取消匯出';
        } else {
          downloadText(text, name);
          dbStat.textContent = '已開始下載 ' + name;
        }
      } catch (e) { dbStat.textContent = '匯出失敗：' + errText(e); }
    };
    var pendingPlan = null;
    function clearImportAsk() { pendingPlan = null; dbOk.style.display = 'none'; dbNo.style.display = 'none'; }
    bDbImp.onclick = function () { clearImportAsk(); dbIn.value = ''; dbIn.click(); };
    dbIn.onchange = async function () {
      var f = dbIn.files && dbIn.files[0]; if (!f) return;
      clearImportAsk(); dbStat.textContent = '讀取檔案中…';
      var data;
      try { data = JSON.parse(await f.text()); } catch (e) { dbStat.textContent = '匯入失敗：這個檔案讀不懂（' + errText(e) + '），現有資料沒有被改動'; return; }
      var mode = dbMode.value;
      var paths = (data && Array.isArray(data.records)) ? data.records.map(function (x) { return x && x.path; }).filter(function (p) { return typeof p === 'string'; }) : [];
      var statMap = {};
      try { statMap = host.library && host.library.statMany ? await host.library.statMany(paths) : {}; } catch (_) { statMap = {}; }
      var plan = M.planImport(lib, data, { mode: mode, statOf: function (p) { return statMap[p] || null; } });
      if (!plan.ok) { dbStat.textContent = '匯入失敗：' + plan.error + '；現有資料沒有被改動'; return; }
      pendingPlan = plan;
      var s = plan.stats;
      dbStat.textContent = (mode === 'replace' ? '取代全部：現有 ' + lib.records.length + ' 筆紀錄會被換掉。' : '合併：') + '檔案共 ' + s.imported + ' 筆，新增 ' + s.added
        + '、路徑已在曲庫（沿用現有）' + s.matched + '、補上索引或歌詞 ' + s.filledIndex + '、索引過期 ' + s.indexStale + '、檔案已消失（資料保留）' + s.missing
        + (s.orphanDerived ? '、擷取產物找不到來源 ' + s.orphanDerived : '') + '。';
      dbOk.textContent = mode === 'replace' ? '確定取代' : '確定匯入';
      dbOk.style.display = ''; dbNo.style.display = '';
    };
    dbNo.onclick = function () { clearImportAsk(); dbStat.textContent = '已取消匯入，資料沒有改動'; };
    dbOk.onclick = async function () {
      if (!pendingPlan) return;
      var plan = pendingPlan; clearImportAsk();
      try {
        M.applyImport(lib, plan);
        await lib.save();
        msg = '匯入完成：' + lib.records.length + ' 筆紀錄';
        dbStat.textContent = msg;
      } catch (e) { msg = '匯入寫入失敗：' + errText(e); dbStat.textContent = msg; }
      render();
    };

    if (queue) unsub = queue.onChange(function () { render(); });
    // 轉錄中每秒更新「已耗時」與重試倒數（只更新歌詞列與進行中工作，不重畫清單）
    var ticker = setInterval(function () {
      if (!root.isConnected) { clearInterval(ticker); if (unsub) unsub(); return; } // 面板已從對話移除：停掉計時與監聽
      if (queue && queue.state().running) renderLyr();
      renderWork();
    }, 1000);
    showTab(curTab);
    if (host.md5) startMd5({});   // 開面板時把還沒算的 md5 在背景算完（沒有就什麼都不做）
    render();
    return {
      refresh: render,
      destroy: function () { try { document.removeEventListener('keydown', onKey); } catch (_) { /* */ } clearInterval(ticker); if (unsub) unsub(); if (root.parentNode) root.parentNode.removeChild(root); }
    };
  }

  return { mount: mount, fromFileList: fromFileList, CSS: CSS };
});
